import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "chokidar";
import {
  HttpError, type ActivityCapability, type ArtifactKind, type ArtifactRecord, type ExecutionTraceEvent, type HarnessTelemetryRecord, type HarnessTelemetrySnapshot, type HerdrObservation, type JsonValue, type LoadedTicket, type Phase, type Provider, type PullRequestRef, type RepositoryClaimBlocker, type TicketAttachment, type TicketCheckpoint, type TicketFrontmatter, type TokenUsage,
  type TicketSummary, supervisorReservationActive,
} from "./domain.js";
import { appendEvent, ensureInteractionLog, parseDocument, serializeDocument } from "./markdown.js";
import { normalizeTicket, validateSessionInvariant } from "./validation.js";
import { accountNodeRunTiming, activeWorkflowIdentity, beginNodeRun, enterCurrentNode, finishNodeRun, nodeAttemptCounter, requiredActivityCapability, resolveNodeProvider, runtimeNodeKey, transitionTo, workflowNode, workflowNodeEnabled, type WorkflowLibrary, type WorkflowNode } from "./workflow-library.js";
import { ArtifactStore } from "./artifact-store.js";
import { RunLedger } from "./run-ledger.js";
import { DEFAULT_ARTIFACT_POLICY, type ArtifactPolicyConfig } from "./config-store.js";
import type { ArtifactCollectionResult, ArtifactDiagnostics } from "./artifact-store.js";

interface StoreOptions {
  leaseTtlMs?: number;
  now?: () => Date;
  watch?: boolean;
  workflowLibrary?: WorkflowLibrary;
  artifactPolicy?: () => Promise<ArtifactPolicyConfig>;
}

interface MutateOptions {
  event: string;
  message: string;
  expectedRevision?: number | undefined;
  silent?: boolean;
}

type Mutator = (ticket: TicketFrontmatter, body: string) => { ticket: TicketFrontmatter; body?: string };

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TICKET = 100;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_TICKET = 1_000;

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function phaseKey(phase: Phase): "specification" | "implementation" | "review" {
  if (phase === "done") throw new HttpError(409, "Done tickets cannot be assigned");
  return phase;
}

const usageKeys: Array<keyof TokenUsage> = [
  "input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens",
];

function sameTelemetrySession(left: HarnessTelemetrySnapshot, right: HarnessTelemetrySnapshot): boolean {
  return left.harness === right.harness && left.session_ref === right.session_ref;
}

function telemetryRecord(
  latest: HarnessTelemetrySnapshot,
  requestedBaseline?: HarnessTelemetrySnapshot,
  previous?: HarnessTelemetryRecord | null,
): HarnessTelemetryRecord {
  if (previous && sameTelemetrySession(previous.latest, latest)
    && Date.parse(latest.observed_at) < Date.parse(previous.latest.observed_at)) return structuredClone(previous);
  const baseline = requestedBaseline && sameTelemetrySession(requestedBaseline, latest)
    ? structuredClone(requestedBaseline)
    : previous && sameTelemetrySession(previous.baseline, latest)
      ? structuredClone(previous.baseline)
      : structuredClone(latest);
  const usage = baseline.usage && latest.usage
    ? Object.fromEntries(usageKeys.map((key) => [key, Math.max(0, latest.usage![key] - baseline.usage![key])])) as unknown as TokenUsage
    : null;
  const freshZeroBaseline = baseline.attributes.agentic_baseline === "fresh_zero";
  const costUsd = baseline.cost.total_usd !== null && latest.cost.total_usd !== null
    ? Number(Math.max(0, latest.cost.total_usd - baseline.cost.total_usd).toFixed(12))
    : freshZeroBaseline && latest.cost.total_usd !== null
      ? Number(Math.max(0, latest.cost.total_usd).toFixed(12))
    : null;
  return { baseline, latest: structuredClone(latest), delta: { usage, cost_usd: costUsd } };
}

function timingState(snapshot: HarnessTelemetrySnapshot, now: Date): { state: "active" | "quota_paused"; pause_limit_id?: string; pause_until?: string | null } {
  const exhausted = snapshot.rate_limits.find((limit) => limit.used_percent >= 100
    && (!limit.resets_at || Date.parse(limit.resets_at) > now.getTime()));
  return exhausted
    ? { state: "quota_paused", pause_limit_id: exhausted.id, pause_until: exhausted.resets_at }
    : { state: "active" };
}

function waitDelaySeconds(ticketId: string, nodeId: string, attempt: number, schedule: NonNullable<WorkflowNode["wait_schedule"]>): number {
  const base = Math.min(schedule.maximum_seconds, schedule.initial_seconds * schedule.multiplier ** Math.max(0, attempt - 1));
  if (schedule.jitter_percent === 0) return Math.max(1, Math.round(base));
  const value = createHash("sha256").update(`${ticketId}:${nodeId}:${attempt}`).digest().readUInt32BE(0) / 0xffffffff;
  const factor = 1 + ((value * 2) - 1) * (schedule.jitter_percent / 100);
  return Math.max(1, Math.round(base * factor));
}

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && relative(root, path).split(sep)[0] === "prompts") continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(path);
    }
  }
  await visit(root);
  return output.sort();
}

export class TicketStore extends EventEmitter {
  readonly root: string;
  readonly leaseTtlMs: number;
  private readonly clock: () => Date;
  private readonly enableWatch: boolean;
  private lockPath: string;
  private watcher: FSWatcher | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private knownDigests = new Map<string, string>();
  private knownTickets = new Map<string, TicketFrontmatter>();
  private ticketIndex = new Map<string, LoadedTicket>();
  private indexGeneration = 0;
  private indexRebuiltAt: string | null = null;
  private workflowLibrary: WorkflowLibrary | null;
  private readonly artifactStore: ArtifactStore;
  private readonly runLedger: RunLedger;
  private readonly artifactPolicy: () => Promise<ArtifactPolicyConfig>;

  constructor(root: string, options: StoreOptions = {}) {
    super();
    this.root = resolve(root);
    this.leaseTtlMs = options.leaseTtlMs ?? 120_000;
    this.clock = options.now ?? (() => new Date());
    this.enableWatch = options.watch ?? true;
    this.lockPath = join(this.root, ".agentic-project-tracker.lock");
    this.workflowLibrary = options.workflowLibrary ?? null;
    this.artifactStore = new ArtifactStore(this.root, this.clock);
    this.runLedger = new RunLedger(this.root, this.clock);
    this.artifactPolicy = options.artifactPolicy ?? (() => Promise.resolve(structuredClone(DEFAULT_ARTIFACT_POLICY)));
  }

  setWorkflowLibrary(library: WorkflowLibrary): void { this.workflowLibrary = library; }

  private indexedTickets(): LoadedTicket[] { return [...this.ticketIndex.values()].map((ticket) => structuredClone(ticket)); }

  private replaceIndex(tickets: LoadedTicket[]): void {
    this.ticketIndex = new Map(tickets.map((ticket) => [ticket.path, structuredClone(ticket)]));
    this.indexGeneration += 1;
    this.indexRebuiltAt = this.clock().toISOString();
  }

  private cacheLoaded(ticket: LoadedTicket): LoadedTicket {
    this.ticketIndex.set(ticket.path, structuredClone(ticket));
    return structuredClone(ticket);
  }

  private async rebuildIndexInternal(initial: boolean): Promise<LoadedTicket[]> {
    const tickets = await this.scanInternal(initial);
    this.replaceIndex(tickets);
    return this.indexedTickets();
  }

  async rebuildIndex(): Promise<LoadedTicket[]> { return this.serial(() => this.rebuildIndexInternal(false)); }

  async operationalStatus(): Promise<{
    root: string; writable: boolean; ticket_count: number; valid_tickets: number; invalid_tickets: number;
    index_generation: number; index_rebuilt_at: string | null; watcher_enabled: boolean;
    disk: { total_bytes: number; free_bytes: number; available_bytes: number } | null;
  }> {
    return this.serial(async () => {
      let writable = true;
      try { await access(this.root, constants.W_OK); } catch { writable = false; }
      let disk: { total_bytes: number; free_bytes: number; available_bytes: number } | null = null;
      try {
        const details = await statfs(this.root, { bigint: true });
        disk = {
          total_bytes: Number(details.blocks * details.bsize),
          free_bytes: Number(details.bfree * details.bsize),
          available_bytes: Number(details.bavail * details.bsize),
        };
      } catch { /* statfs is not available on every supported filesystem. */ }
      const tickets = this.indexedTickets();
      return {
        root: this.root, writable, ticket_count: tickets.length,
        valid_tickets: tickets.filter((ticket) => ticket.valid).length,
        invalid_tickets: tickets.filter((ticket) => !ticket.valid).length,
        index_generation: this.indexGeneration, index_rebuilt_at: this.indexRebuiltAt,
        watcher_enabled: this.enableWatch, disk,
      };
    });
  }

  private async settleAutomaticLoaded(current: LoadedTicket & { frontmatter: TicketFrontmatter }): Promise<LoadedTicket & { frontmatter: TicketFrontmatter }> {
    if (!this.workflowLibrary || !current.frontmatter.workflow || current.frontmatter.execution) return current;
    const ticket = structuredClone(current.frontmatter);
    let changed = false;
    for (let step = 0; step < 100; step += 1) {
      const identity = activeWorkflowIdentity(ticket);
      const definition = (await this.workflowLibrary.get(identity.id, identity.revision)).definition;
      const node = workflowNode(definition, ticket.workflow!.current_node);
      if (node.type === "wait") {
        const now = this.clock();
        const nowIso = now.toISOString();
        const key = runtimeNodeKey(ticket, node.id);
        ticket.workflow!.wait_states ??= {};
        let state = ticket.workflow!.wait_states[key];
        const running = state ? ticket.workflow!.node_runs.find((run) => run.id === state!.node_run_id && run.status === "running") : undefined;
        if (running) {
          const timedOut = now.getTime() >= Date.parse(state!.deadline_at);
          if (!timedOut && now.getTime() < Date.parse(state!.wake_at)) break;
          const outcome = timedOut ? "timed_out" : "elapsed";
          finishNodeRun(ticket, running.id, outcome, timedOut ? "External wait deadline expired." : "External wait interval elapsed.", null, nowIso);
          if (timedOut) delete ticket.workflow!.wait_states[key];
          transitionTo(ticket, definition, timedOut ? node.timeout_to! : node.next!, {
            outcome, summary: timedOut ? "External wait deadline expired." : "External wait interval elapsed.", actor: "workflow", source_node: node.id,
          });
          changed = true; continue;
        }
        const schedule = node.wait_schedule!;
        const attempt = (state?.attempt ?? 0) + 1;
        const startedAt = state?.started_at ?? nowIso;
        const deadlineAt = state?.deadline_at ?? new Date(Date.parse(startedAt) + schedule.deadline_seconds * 1000).toISOString();
        const delaySeconds = waitDelaySeconds(ticket.id, node.id, attempt, schedule);
        const wakeAt = new Date(Math.min(Date.parse(deadlineAt), now.getTime() + delaySeconds * 1000)).toISOString();
        const run = beginNodeRun(ticket, node, identity.revision, attempt, nowIso, "tracker", null, null);
        run.supervisor_id = null;
        run.wait = { wake_at: wakeAt, deadline_at: deadlineAt, delay_seconds: delaySeconds };
        state = { workflow_id: identity.id, workflow_revision: identity.revision, node_id: node.id, started_at: startedAt, wake_at: wakeAt, deadline_at: deadlineAt, attempt, node_run_id: run.id };
        ticket.workflow!.wait_states[key] = state;
        ticket.status = "waiting_external";
        changed = true; break;
      }
      if (node.type === "read") {
        const value = ticket.metadata?.[node.metadata_key ?? ""];
        const route = node.metadata_cases?.find((candidate) => !candidate.default && JSON.stringify(candidate.equals) === JSON.stringify(value))
          ?? node.metadata_cases?.find((candidate) => candidate.default);
        if (!route) { ticket.status = "blocked"; changed = true; break; }
        transitionTo(ticket, definition, route.target, {
          outcome: route.id, summary: `Metadata ${node.metadata_key} matched ${route.label}.`,
          handoff: JSON.stringify(value ?? null), actor: "workflow", source_node: node.id,
        });
        changed = true; continue;
      }
      if (node.type === "write") {
        ticket.metadata ??= {};
        ticket.metadata[node.metadata_key!] = structuredClone(node.metadata_value ?? null);
        transitionTo(ticket, definition, node.next!, {
          outcome: "completed", summary: `Metadata ${node.metadata_key} was updated.`,
          handoff: JSON.stringify(node.metadata_value ?? null), actor: "workflow", source_node: node.id,
        });
        changed = true; continue;
      }
      if (node.type === "fan_out") {
        const branches = node.branches ?? [];
        ticket.workflow!.fan_out_stack ??= [];
        ticket.workflow!.fan_out_stack.push({
          workflow_id: identity.id, workflow_revision: identity.revision,
          fan_out_node_id: node.id, fan_in_node_id: node.fan_in!,
          pending_targets: branches.slice(1).map((branch) => branch.target), inputs: [],
          source: ticket.workflow!.incoming ? structuredClone(ticket.workflow!.incoming) : null,
        });
        const first = branches[0]!;
        transitionTo(ticket, definition, first.target, {
          outcome: first.id, summary: `Fan-out started ${branches.length} branches.`,
          handoff: ticket.workflow!.incoming?.handoff ?? null, output: ticket.workflow!.incoming?.output ?? null,
          output_log_path: ticket.workflow!.incoming?.output_log_path ?? null, actor: "workflow", source_node: node.id,
        });
        changed = true; continue;
      }
      if (node.type === "fan_in") {
        const stack = ticket.workflow!.fan_out_stack ?? [];
        const frameIndex = stack.findLastIndex((frame) => frame.workflow_id === identity.id && frame.fan_in_node_id === node.id);
        if (frameIndex < 0) { ticket.status = "blocked"; changed = true; break; }
        const frame = stack[frameIndex]!;
        if (ticket.workflow!.incoming) frame.inputs.push(structuredClone(ticket.workflow!.incoming));
        const nextBranch = frame.pending_targets.shift();
        if (nextBranch) {
          const joinKey = runtimeNodeKey(ticket, node.id);
          ticket.workflow!.node_visits[joinKey] = Math.max(0, (ticket.workflow!.node_visits[joinKey] ?? 1) - 1);
          const now = this.clock().toISOString();
          ticket.workflow!.current_node = nextBranch;
          ticket.workflow!.current_node_entered_at = now;
          ticket.workflow!.transition_count += 1;
          ticket.workflow!.incoming = {
            source_node: frame.fan_out_node_id, target_node: nextBranch, outcome: "fanout_branch",
            summary: frame.source?.summary ?? "Continuing fan-out branch.", handoff: frame.source?.handoff ?? null,
            output: frame.source?.output ?? null, output_log_path: frame.source?.output_log_path ?? null,
            actor: "workflow", created_at: now,
          };
          enterCurrentNode(ticket, definition, true);
        } else {
          stack.splice(frameIndex, 1);
          const summaries = frame.inputs.map((input) => `${input.source_node}: ${input.summary ?? input.outcome}`).join("\n");
          const outputs = frame.inputs.map((input) => input.output).filter((value): value is string => Boolean(value)).join("\n\n");
          const logs = frame.inputs.map((input) => input.output_log_path).filter((value): value is string => Boolean(value));
          transitionTo(ticket, definition, node.next!, {
            outcome: "completed", summary: `Fan-in merged ${frame.inputs.length} branches.`, handoff: summaries || null,
            output: outputs || null, output_log_path: logs.length ? logs.join("\n") : null,
            actor: "workflow", source_node: node.id,
          });
        }
        changed = true; continue;
      }
      if (node.type === "workflow") {
        ticket.workflow!.workflow_stack ??= [];
        ticket.workflow!.workflow_revisions ??= { [ticket.workflow!.id]: ticket.workflow!.revision };
        if (ticket.workflow!.workflow_stack.length >= 16 || ticket.workflow!.transition_count >= definition.max_transitions) {
          ticket.status = "blocked"; changed = true; break;
        }
        const childDocument = ticket.workflow!.workflow_revisions[node.workflow_id!]
          ? await this.workflowLibrary.get(node.workflow_id!, ticket.workflow!.workflow_revisions[node.workflow_id!])
          : await this.workflowLibrary.get(node.workflow_id!);
        ticket.workflow!.workflow_revisions[node.workflow_id!] = childDocument.revision;
        ticket.workflow!.workflow_stack.push({ workflow_id: identity.id, workflow_revision: identity.revision, call_node_id: node.id });
        ticket.workflow!.active_workflow_id = childDocument.definition.id;
        ticket.workflow!.active_workflow_revision = childDocument.revision;
        ticket.workflow!.current_node = childDocument.definition.start;
        ticket.workflow!.current_node_entered_at = this.clock().toISOString();
        ticket.workflow!.transition_count += 1;
        enterCurrentNode(ticket, childDocument.definition, true);
        changed = true; continue;
      }
      if (node.type === "terminal" && (ticket.workflow!.workflow_stack?.length ?? 0) > 0) {
        const frame = ticket.workflow!.workflow_stack!.pop()!;
        const parent = (await this.workflowLibrary.get(frame.workflow_id, frame.workflow_revision)).definition;
        const callNode = workflowNode(parent, frame.call_node_id);
        const statusCode = node.status_code ?? (node.terminal_status === "completed" ? 0 : 1);
        const routes = callNode.status_codes ?? [];
        const route = routes.find((candidate) => candidate.codes?.includes(statusCode)) ?? routes.find((candidate) => candidate.default);
        ticket.workflow!.active_workflow_id = frame.workflow_id;
        ticket.workflow!.active_workflow_revision = frame.workflow_revision;
        ticket.workflow!.current_node = frame.call_node_id;
        if (!route) { ticket.status = "blocked"; changed = true; break; }
        transitionTo(ticket, parent, route.target, {
          outcome: route.id, summary: `Workflow ${identity.id} returned status code ${statusCode}.`,
          handoff: ticket.workflow!.incoming?.handoff ?? null, output: ticket.workflow!.incoming?.output ?? null,
          output_log_path: ticket.workflow!.incoming?.output_log_path ?? null, actor: "workflow", source_node: frame.call_node_id,
        });
        changed = true; continue;
      }
      break;
    }
    if (!changed) return current;
    return this.mutateLoaded(current, ticket, current.body, { event: "workflow.advanced", message: "Automatic workflow nodes advanced." }) as Promise<LoadedTicket & { frontmatter: TicketFrontmatter }>;
  }

  async settleAutomatic(id: string): Promise<LoadedTicket> {
    return this.serial(async () => this.settleAutomaticLoaded(await this.findValid(id)));
  }

  async persistNodeRunOutput(ticketId: string, runId: string, output: string): Promise<{ path: string; sha256: string; bytes: number }> {
    if (!/^[a-f0-9-]{16,64}$/i.test(runId)) throw new HttpError(422, "Node run id is invalid");
    const relativePath = join(".runs", digest(ticketId), `${runId}.log`);
    const path = join(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(output); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, path); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    return { path: relativePath, sha256: digest(output), bytes: Buffer.byteLength(output) };
  }

  async nodeRunOutput(ticketId: string, runId: string): Promise<string> {
    const loaded = await this.get(ticketId);
    const run = loaded.frontmatter?.workflow?.node_runs.find((candidate) => candidate.id === runId);
    if (!run?.output_path) throw new HttpError(404, `Node run ${runId} has no external output`);
    const path = resolve(this.root, run.output_path);
    const artifactRoot = resolve(this.root, ".runs", digest(loaded.frontmatter?.id ?? ticketId));
    const relativePath = relative(artifactRoot, path);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || basename(path) !== `${runId}.log`) {
      throw new HttpError(409, "Node output path escapes its ticket artifact directory");
    }
    try { return await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Node run output ${runId} was not found`);
      throw error;
    }
  }

  async addAttachment(ticketId: string, filename: string, contentType: string, content: Buffer, expectedRevision?: number): Promise<LoadedTicket> {
    return this.serial(async () => {
      const current = await this.findValid(ticketId);
      if (expectedRevision !== undefined && current.frontmatter.revision !== expectedRevision) throw new HttpError(409, "Ticket revision changed", current);
      const safeName = basename(filename.trim());
      if (!safeName || safeName !== filename.trim() || safeName.length > 255 || /[\x00-\x1f\x7f]/.test(safeName)) throw new HttpError(422, "Attachment filename must be a basename of at most 255 printable characters");
      if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(contentType.trim())) throw new HttpError(422, "Attachment content type must be a MIME type without parameters");
      if (content.byteLength > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit`);
      if (current.frontmatter.attachments.length >= MAX_ATTACHMENTS_PER_TICKET) throw new HttpError(422, `Ticket cannot contain more than ${MAX_ATTACHMENTS_PER_TICKET} attachments`);
      const artifact = await this.artifactStore.put({ ticket_id: current.frontmatter.id, kind: "attachment", filename: safeName, content_type: contentType.trim(), content, policy: await this.artifactPolicy() });
      const attachment: TicketAttachment = {
        id: artifact.id, filename: artifact.filename, content_type: artifact.content_type,
        size_bytes: artifact.size_bytes, sha256: artifact.sha256, created_at: artifact.created_at,
      };
      try {
        const ticket = structuredClone(current.frontmatter);
        ticket.attachments.push(attachment);
        ticket.artifacts.push(artifact);
        if (ticket.execution) ticket.execution.guidance.push({
          id: `guidance-${randomUUID()}`, sequence: ticket.event_sequence + 1,
          message: `Attachment ${safeName} was added. Reread the assignment attachment manifest before continuing.`,
          created_at: this.clock().toISOString(), delivered_at: null,
        });
        return await this.mutateLoaded(current, ticket, current.body, {
          event: "ticket.attachment_added",
          message: `Attachment ${safeName} added${ticket.execution ? "; active agent asked to refresh its assignment" : ""}.`,
        });
      } catch (error) {
        await this.artifactStore.deleteRecord(artifact.id);
        throw error;
      }
    });
  }

  private legacyAttachmentPath(ticketId: string, attachmentId: string): string {
    return join(this.root, ".attachments", digest(ticketId), attachmentId);
  }

  async removeAttachment(ticketId: string, attachmentId: string, expectedRevision?: number): Promise<LoadedTicket> {
    return this.serial(async () => {
      const current = await this.findValid(ticketId);
      if (expectedRevision !== undefined && current.frontmatter.revision !== expectedRevision) throw new HttpError(409, "Ticket revision changed", current);
      const attachment = current.frontmatter.attachments.find((candidate) => candidate.id === attachmentId);
      if (!attachment) throw new HttpError(404, `Attachment ${attachmentId} was not found`);
      const ticket = structuredClone(current.frontmatter);
      ticket.attachments = ticket.attachments.filter((candidate) => candidate.id !== attachmentId);
      ticket.artifacts = ticket.artifacts.filter((candidate) => candidate.id !== attachmentId);
      if (ticket.execution) ticket.execution.guidance.push({
        id: `guidance-${randomUUID()}`, sequence: ticket.event_sequence + 1,
        message: `Attachment ${attachment.filename} was removed. Reread the assignment attachment manifest before continuing.`,
        created_at: this.clock().toISOString(), delivered_at: null,
      });
      const updated = await this.mutateLoaded(current, ticket, current.body, {
        event: "ticket.attachment_removed",
        message: `Attachment ${attachment.filename} removed${ticket.execution ? "; active agent asked to refresh its assignment" : ""}.`,
      });
      await this.artifactStore.deleteRecord(attachment.id);
      await rm(this.legacyAttachmentPath(current.frontmatter.id, attachment.id), { force: true });
      return updated;
    });
  }

  async attachment(ticketId: string, attachmentId: string): Promise<{ attachment: TicketAttachment; content: Buffer }> {
    const loaded = await this.get(ticketId);
    if (!loaded.valid || !loaded.frontmatter) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    const attachment = loaded.frontmatter.attachments.find((candidate) => candidate.id === attachmentId);
    if (!attachment) throw new HttpError(404, `Attachment ${attachmentId} was not found`);
    try {
      let content: Buffer;
      try {
        const stored = await this.artifactStore.get(attachment.id);
        if (stored.record.ticket_id !== loaded.frontmatter.id || stored.record.kind !== "attachment") throw new HttpError(409, `Attachment ${attachment.filename} has an invalid artifact record`);
        content = stored.content;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        content = await readFile(this.legacyAttachmentPath(loaded.frontmatter.id, attachment.id));
      }
      if (content.byteLength !== attachment.size_bytes || digest(content) !== attachment.sha256) throw new HttpError(409, `Attachment ${attachment.filename} failed its integrity check`);
      return { attachment, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Attachment content for ${attachment.filename} was not found`);
      throw error;
    }
  }

  async addArtifactForLease(leaseId: string, input: { kind: ArtifactKind; filename: string; contentType: string; content: Buffer; metadata?: Record<string, import("./domain.js").JsonValue> }): Promise<ArtifactRecord> {
    if (input.content.byteLength > MAX_ARTIFACT_BYTES) throw new HttpError(413, `Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte limit`);
    const leased = await this.byLease(leaseId);
    if (leased.frontmatter.artifacts.length >= MAX_ARTIFACTS_PER_TICKET) throw new HttpError(422, `Ticket cannot contain more than ${MAX_ARTIFACTS_PER_TICKET} artifact references`);
    const safeName = basename(input.filename.trim());
    if (!safeName || safeName !== input.filename.trim() || safeName.length > 255) throw new HttpError(422, "Artifact filename must be a basename of at most 255 characters");
    if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(input.contentType)) throw new HttpError(422, "Artifact content type must be a MIME type without parameters");
    if (input.kind === "attachment") throw new HttpError(422, "Lease uploads cannot create ticket attachments");
    const artifact = await this.artifactStore.put({
      ticket_id: leased.frontmatter.id, node_run_id: leased.execution.node_run_id ?? null,
      kind: input.kind, filename: safeName, content_type: input.contentType, content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      policy: await this.artifactPolicy(),
    });
    try {
      await this.command(leased.frontmatter.id, { event: "artifact.created", message: `${input.kind} artifact ${safeName} stored.` }, (ticket) => {
        if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced");
        ticket.artifacts.push(artifact);
        return { ticket };
      });
      return artifact;
    } catch (error) { await this.artifactStore.deleteRecord(artifact.id); throw error; }
  }

  async artifact(ticketId: string, artifactId: string): Promise<{ record: ArtifactRecord; content: Buffer }> {
    const loaded = await this.get(ticketId);
    if (!loaded.frontmatter?.artifacts.some((artifact) => artifact.id === artifactId)) throw new HttpError(404, `Artifact ${artifactId} was not found on ticket ${ticketId}`);
    try {
      const stored = await this.artifactStore.get(artifactId);
      if (stored.record.ticket_id !== loaded.frontmatter.id) throw new HttpError(409, "Artifact ownership mismatch");
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Artifact ${artifactId} was not found`);
      throw error;
    }
  }

  async appendExecutionTrace(
    leaseId: string,
    traceId: string,
    firstSequence: number,
    events: ExecutionTraceEvent[],
    completed: boolean,
  ): Promise<{ artifact: ArtifactRecord; next_sequence: number }> {
    return this.serial(async () => {
      const current = this.indexedTickets().find((item): item is LoadedTicket & { frontmatter: TicketFrontmatter } => Boolean(
        item.valid && item.frontmatter?.workflow?.node_runs.some((run) => run.lease_id === leaseId),
      ));
      if (!current) throw new HttpError(409, "Execution lease is unknown or no longer retained", undefined, "LEASE_STALE");
      const run = current.frontmatter.workflow!.node_runs.find((candidate) => candidate.lease_id === leaseId)!;
      const chunks = current.frontmatter.artifacts.filter((artifact) => artifact.kind === "execution_trace"
        && artifact.node_run_id === run.id && artifact.metadata.trace_id === traceId)
        .sort((left, right) => Number(left.metadata.first_sequence) - Number(right.metadata.first_sequence));
      const last = chunks.at(-1);
      const expected = last ? Number(last.metadata.last_sequence) + 1 : 1;
      const lastSequence = events.at(-1)!.sequence;
      const content = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const duplicate = chunks.find((artifact) => Number(artifact.metadata.first_sequence) === firstSequence
        && Number(artifact.metadata.last_sequence) === lastSequence && artifact.sha256 === digest(content));
      if (duplicate) return { artifact: duplicate, next_sequence: lastSequence + 1 };
      if (firstSequence !== expected) throw new HttpError(409, `Trace ${traceId} expected sequence ${expected}, received ${firstSequence}`, {
        trace_id: traceId, expected_sequence: expected, received_sequence: firstSequence,
      }, "EXECUTION_TRACE_SEQUENCE_MISMATCH");
      if (current.frontmatter.artifacts.length >= MAX_ARTIFACTS_PER_TICKET) throw new HttpError(422, `Ticket cannot contain more than ${MAX_ARTIFACTS_PER_TICKET} artifact references`);
      const artifact = await this.artifactStore.put({
        ticket_id: current.frontmatter.id,
        node_run_id: run.id,
        kind: "execution_trace",
        filename: `${run.id}.${String(firstSequence).padStart(6, "0")}-${String(lastSequence).padStart(6, "0")}.herdr-trace.jsonl`,
        content_type: "application/x-ndjson",
        content,
        metadata: {
          schema_version: 1,
          trace_id: traceId,
          first_sequence: firstSequence,
          last_sequence: lastSequence,
          event_count: events.length,
          completed,
          presentation: {
            title: `Herdr operational trace ${run.node_id} attempt ${run.attempt}`,
            description: `Events ${firstSequence}-${lastSequence} for node run ${run.id}.`,
            category: "operational trace",
          },
        },
        policy: await this.artifactPolicy(),
      });
      try {
        const ticket = structuredClone(current.frontmatter);
        ticket.artifacts.push(artifact);
        await this.mutateLoaded(current, ticket, current.body, {
          event: "execution.trace_chunk_stored",
          message: `Operational trace events ${firstSequence}-${lastSequence} stored for ${run.node_id}.`,
          silent: true,
        });
        return { artifact, next_sequence: lastSequence + 1 };
      } catch (error) {
        await this.artifactStore.deleteRecord(artifact.id);
        throw error;
      }
    });
  }

  async addAgentSessionEvidence(
    leaseId: string,
    input: { kind: "agent_transcript" | "harness_session_log"; filename: string; contentType: string; content: Buffer; metadata: Record<string, JsonValue> },
  ): Promise<ArtifactRecord> {
    if (input.content.byteLength > MAX_ARTIFACT_BYTES) throw new HttpError(413, `Session evidence exceeds the ${MAX_ARTIFACT_BYTES} byte limit`, undefined, "SESSION_EVIDENCE_TOO_LARGE");
    const safeName = basename(input.filename.trim());
    if (!safeName || safeName !== input.filename.trim() || safeName.length > 255) throw new HttpError(422, "Session evidence filename must be a basename of at most 255 characters", undefined, "SESSION_EVIDENCE_INVALID");
    if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(input.contentType)) throw new HttpError(422, "Session evidence content type must be a MIME type without parameters", undefined, "SESSION_EVIDENCE_INVALID");
    return this.serial(async () => {
      const current = this.indexedTickets().find((item): item is LoadedTicket & { frontmatter: TicketFrontmatter } => Boolean(
        item.valid && item.frontmatter?.workflow?.node_runs.some((run) => run.lease_id === leaseId),
      ));
      if (!current) throw new HttpError(409, "Execution lease is unknown or no longer retained", undefined, "LEASE_STALE");
      const run = current.frontmatter.workflow!.node_runs.find((candidate) => candidate.lease_id === leaseId)!;
      if (run.node_type !== "agent") throw new HttpError(409, "Session evidence can only be attached to an Agent node run", undefined, "SESSION_EVIDENCE_INVALID");
      const sha256 = digest(input.content);
      const evidenceKey = typeof input.metadata.evidence_key === "string" ? input.metadata.evidence_key : null;
      const duplicate = current.frontmatter.artifacts.find((artifact) => artifact.node_run_id === run.id
        && artifact.kind === input.kind && artifact.sha256 === sha256
        && (evidenceKey === null || artifact.metadata.evidence_key === evidenceKey));
      if (duplicate) return duplicate;
      if (current.frontmatter.artifacts.length >= MAX_ARTIFACTS_PER_TICKET) throw new HttpError(422, `Ticket cannot contain more than ${MAX_ARTIFACTS_PER_TICKET} artifact references`);
      const artifact = await this.artifactStore.put({
        ticket_id: current.frontmatter.id, node_run_id: run.id, kind: input.kind,
        filename: safeName, content_type: input.contentType, content: input.content, metadata: input.metadata,
        policy: await this.artifactPolicy(),
      });
      try {
        const ticket = structuredClone(current.frontmatter);
        ticket.artifacts.push(artifact);
        await this.mutateLoaded(current, ticket, current.body, {
          event: "provenance.session_evidence_stored",
          message: `${input.kind === "agent_transcript" ? "Herdr transcript" : "Native harness session log"} stored for ${run.node_id} attempt ${run.attempt}.`,
          silent: true,
        });
        return artifact;
      } catch (error) { await this.artifactStore.deleteRecord(artifact.id); throw error; }
    });
  }

  private async referencedArtifactIds(): Promise<Set<string>> {
    const tickets = await this.list();
    return new Set(tickets.flatMap((loaded) => loaded.frontmatter?.artifacts.map((artifact) => artifact.id) ?? []));
  }

  async artifactDiagnostics(): Promise<ArtifactDiagnostics> {
    return this.artifactStore.diagnose(await this.referencedArtifactIds());
  }

  async maintainArtifacts(requestedPolicy?: ArtifactPolicyConfig): Promise<{
    recovered_records: string[]; collection: ArtifactCollectionResult; diagnostics: ArtifactDiagnostics;
  }> {
    const policy = requestedPolicy ?? await this.artifactPolicy();
    const initial = await this.artifactDiagnostics();
    const recovered_records: string[] = [];
    const recoveryCutoff = this.clock().getTime() - policy.orphan_grace_hours * 60 * 60 * 1000;
    for (const record of initial.orphan_records.filter((candidate) => Date.parse(candidate.created_at) <= recoveryCutoff)) {
      try {
        await this.artifactStore.get(record.id);
        const loaded = await this.get(record.ticket_id);
        if (!loaded.valid || !loaded.frontmatter || (record.node_run_id && !loaded.frontmatter.workflow?.node_runs.some((run) => run.id === record.node_run_id))) continue;
        await this.command(record.ticket_id, { event: "artifact.recovered", message: `Recovered orphaned ${record.kind} artifact ${record.filename}.` }, (ticket) => {
          if (!ticket.artifacts.some((artifact) => artifact.id === record.id)) ticket.artifacts.push(record);
          if (record.kind === "attachment" && !ticket.attachments.some((attachment) => attachment.id === record.id)) ticket.attachments.push({
            id: record.id, filename: record.filename, content_type: record.content_type,
            size_bytes: record.size_bytes, sha256: record.sha256, created_at: record.created_at,
          });
          const run = record.kind === "execution_manifest" && record.node_run_id
            ? ticket.workflow?.node_runs.find((candidate) => candidate.id === record.node_run_id) : undefined;
          if (run && !run.manifest_artifact_id) run.manifest_artifact_id = record.id;
          return { ticket };
        });
        recovered_records.push(record.id);
      } catch { /* Leave unsafe or irrecoverable records for grace-period collection. */ }
    }
    const referenced = await this.referencedArtifactIds();
    const collection = await this.artifactStore.collect(referenced, policy);
    return { recovered_records, collection, diagnostics: await this.artifactStore.diagnose(await this.referencedArtifactIds()) };
  }

  async finalizeExecutionManifest(leaseId: string, runtime: JsonValue = {}): Promise<ArtifactRecord> {
    return this.serial(async () => {
      if (!this.workflowLibrary) throw new HttpError(409, "Workflow library is unavailable");
      const current = this.indexedTickets().find((item): item is LoadedTicket & { frontmatter: TicketFrontmatter } => Boolean(
        item.valid && item.frontmatter?.workflow?.node_runs.some((run) => run.lease_id === leaseId),
      ));
      if (!current) throw new HttpError(409, "Execution lease is unknown or no longer retained");
      const run = current.frontmatter.workflow!.node_runs.find((candidate) => candidate.lease_id === leaseId)!;
      if (run.status === "running") throw new HttpError(409, "Execution manifest cannot finalize before the node run completes");
      if (run.manifest_artifact_id) {
        const existing = current.frontmatter.artifacts.find((artifact) => artifact.id === run.manifest_artifact_id);
        if (!existing) throw new HttpError(409, "Execution manifest reference is missing");
        return existing;
      }
      if (current.frontmatter.artifacts.length >= MAX_ARTIFACTS_PER_TICKET) throw new HttpError(422, `Ticket cannot contain more than ${MAX_ARTIFACTS_PER_TICKET} artifact references`);
      const workflowId = run.workflow_id ?? current.frontmatter.workflow!.id;
      const definition = (await this.workflowLibrary.get(workflowId, run.workflow_revision)).definition;
      const node = workflowNode(definition, run.node_id);
      const conversation = node.conversation_key ? current.frontmatter.conversations?.[node.conversation_key] ?? null : null;
      const capturedInputs = run.input_context;
      const profile = capturedInputs
        ? capturedInputs.resolved_agent_profile
        : current.frontmatter.workflow!.resolved_agent_profiles?.[`${workflowId}/${node.id}`] ?? null;
      const manifest = {
        schema_version: 1,
        generated_at: this.clock().toISOString(),
        ticket: { id: current.frontmatter.id, title: current.frontmatter.title, revision: current.frontmatter.revision },
        workflow: {
          id: workflowId, revision: run.workflow_revision, root_id: current.frontmatter.workflow!.id,
          root_revision: current.frontmatter.workflow!.revision, node_id: run.node_id, node_name: node.name,
          node_type: run.node_type, node_run_id: run.id, visit: run.visit, attempt: run.attempt,
          prompt: node.prompt ? {
            id: node.prompt,
            revision: capturedInputs ? capturedInputs.prompt_revision : current.frontmatter.workflow!.prompt_revisions[node.prompt] ?? null,
          } : null,
        },
        execution: {
          status: run.status, outcome: run.outcome, summary: run.summary, started_at: run.started_at, completed_at: run.completed_at,
          supervisor_id: run.supervisor_id, lease_id: run.lease_id, timing: run.timing,
        },
        agent: run.node_type === "agent" ? {
          profile, provider: run.provider, conversation_key: node.conversation_key ?? null,
          conversation_generation: run.conversation_generation ?? conversation?.generation ?? null,
          session_ref: conversation?.session_ref ?? null, telemetry: run.telemetry,
        } : null,
        activity: run.node_type === "script" || run.node_type === "checkpoint" || run.node_type === "restore_checkpoint" ? {
          script_path: run.script_path ?? null, working_directory: run.working_directory ?? null,
          output_sha256: run.output_sha256 ?? null, output_bytes: run.output_bytes ?? null,
          metadata_writes: run.metadata_writes ?? {}, external_references: run.external_references ?? [],
        } : null,
        inputs: {
          ticket_revision: capturedInputs?.ticket_revision ?? run.input_revision,
          workflow_inputs: capturedInputs?.workflow_inputs ?? current.frontmatter.workflow!.inputs,
          stage_enabled: capturedInputs?.stage_enabled ?? current.frontmatter.workflow!.stage_enabled,
          ticket_attachments: capturedInputs?.attachments
            ?? current.frontmatter.attachments.map((attachment) => ({ id: attachment.id, filename: attachment.filename, sha256: attachment.sha256 })),
          prior_artifacts: capturedInputs?.prior_artifacts
            ?? current.frontmatter.artifacts.filter((artifact) => artifact.node_run_id !== run.id && artifact.kind !== "execution_manifest" && artifact.kind !== "execution_trace")
              .map((artifact) => ({ id: artifact.id, kind: artifact.kind, filename: artifact.filename, sha256: artifact.sha256, node_run_id: artifact.node_run_id })),
          incoming: capturedInputs ? capturedInputs.incoming : current.frontmatter.workflow!.incoming,
        },
        outputs: current.frontmatter.artifacts.filter((artifact) => artifact.node_run_id === run.id && artifact.kind !== "execution_manifest" && artifact.kind !== "execution_trace")
          .map((artifact) => ({ id: artifact.id, kind: artifact.kind, filename: artifact.filename, sha256: artifact.sha256, size_bytes: artifact.size_bytes })),
        pull_requests: current.frontmatter.pull_requests,
        runtime,
      };
      const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      const artifact = await this.artifactStore.put({
        ticket_id: current.frontmatter.id, node_run_id: run.id, kind: "execution_manifest",
        filename: `${run.id}.execution-manifest.json`, content_type: "application/json", content,
        metadata: { schema_version: 1, workflow_id: workflowId, node_id: run.node_id },
        policy: await this.artifactPolicy(),
      });
      try {
        const ticket = structuredClone(current.frontmatter);
        const mutableRun = ticket.workflow!.node_runs.find((candidate) => candidate.id === run.id)!;
        mutableRun.manifest_artifact_id = artifact.id;
        ticket.artifacts.push(artifact);
        await this.mutateLoaded(current, ticket, current.body, { event: "execution.manifest_created", message: `Execution manifest stored for ${node.name}.` });
        return artifact;
      } catch (error) { await this.artifactStore.deleteRecord(artifact.id); throw error; }
    });
  }

  async recordCheckpoint(leaseId: string, checkpoint: Omit<TicketCheckpoint, "manifest_artifact_id">): Promise<TicketCheckpoint> {
    const leased = await this.byLease(leaseId);
    const existing = leased.frontmatter.checkpoints.find((candidate) => candidate.id === checkpoint.id);
    if (existing) return existing;
    if (leased.frontmatter.checkpoints.length >= 200) throw new HttpError(422, "Ticket cannot contain more than 200 checkpoints");
    if (checkpoint.node_run_id !== (leased.execution.node_run_id ?? null)) throw new HttpError(409, "Checkpoint node run does not match the active lease");
    if (!/^[A-Za-z0-9-]{1,128}$/.test(checkpoint.id)) throw new HttpError(422, "Checkpoint id is invalid");
    const declaredRepositories = leased.frontmatter.repositories.map((repository) => repository.id).sort();
    const checkpointRepositories = checkpoint.repositories.map((repository) => repository.repository).sort();
    if (new Set(checkpointRepositories).size !== checkpointRepositories.length || JSON.stringify(checkpointRepositories) !== JSON.stringify(declaredRepositories)) {
      throw new HttpError(422, "Checkpoint must contain every ticket repository exactly once");
    }
    for (const repository of checkpoint.repositories) {
      const artifact = leased.frontmatter.artifacts.find((candidate) => candidate.id === repository.bundle_artifact_id);
      if (!artifact || artifact.kind !== "checkpoint_bundle" || artifact.node_run_id !== leased.execution.node_run_id) throw new HttpError(422, `Checkpoint bundle ${repository.bundle_artifact_id} is not available for this node run`);
      if (!/^[a-f0-9]{40,64}$/.test(repository.head_sha) || !/^[a-f0-9]{40,64}$/.test(repository.snapshot_sha)) throw new HttpError(422, `Checkpoint repository ${repository.repository} has an invalid Git object id`);
    }
    const manifestContent = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
    const manifest = await this.addArtifactForLease(leaseId, {
      kind: "checkpoint_manifest", filename: `${checkpoint.id}.json`, contentType: "application/json", content: manifestContent,
      metadata: { checkpoint_id: checkpoint.id, checkpoint_kind: checkpoint.kind },
    });
    const complete: TicketCheckpoint = { ...checkpoint, manifest_artifact_id: manifest.id };
    await this.command(leased.frontmatter.id, { event: "checkpoint.created", message: `Checkpoint ${checkpoint.label} recorded.` }, (ticket) => {
      if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced");
      ticket.checkpoints.push(complete);
      return { ticket };
    });
    return complete;
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.acquireLock();
    await this.serial(() => this.rebuildIndexInternal(true));
    if (this.enableWatch) {
      this.watcher = watch(join(this.root, "**/*.md"), {
        ignored: join(this.root, "prompts/**"),
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      });
      this.watcher.on("add", () => void this.reconcileExternal());
      this.watcher.on("change", () => void this.reconcileExternal());
      this.watcher.on("unlink", () => void this.reconcileExternal());
    }
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    try {
      const raw = JSON.parse(await readFile(this.lockPath, "utf8")) as { pid?: number };
      if (raw.pid === process.pid) await rm(this.lockPath, { force: true });
    } catch { /* already gone */ }
  }

  private async acquireLock(): Promise<void> {
    const record = JSON.stringify({ pid: process.pid, started_at: this.clock().toISOString() });
    try {
      const handle = await open(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(record);
      await handle.sync();
      await handle.close();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    try {
      const existing = JSON.parse(await readFile(this.lockPath, "utf8")) as { pid?: number };
      if (existing.pid && existing.pid !== process.pid) {
        try { process.kill(existing.pid, 0); throw new Error(`Ticket root is already owned by live process ${existing.pid}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Ticket root")) throw error;
    }
    await rm(this.lockPath, { force: true });
    await this.acquireLock();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async reconcileExternal(): Promise<void> {
    await this.serial(async () => {
      await this.rebuildIndexInternal(false);
      this.emit("changed", { type: "tickets.changed" });
    });
  }

  async list(): Promise<LoadedTicket[]> {
    return this.serial(async () => this.indexedTickets());
  }

  async summaries(includeArchived = false): Promise<TicketSummary[]> {
    const loadedTickets = await this.list();
    const reserved = loadedTickets.flatMap((loaded) => loaded.valid && loaded.frontmatter
      && loaded.frontmatter.assigned_supervisor_host && supervisorReservationActive(loaded.frontmatter) ? [loaded.frontmatter] : []);
    const summaries = await Promise.all(loadedTickets.filter((loaded) => (!loaded.valid || loaded.frontmatter?.workflow) && (includeArchived || !loaded.frontmatter?.archived_at)).map(async (loaded) => {
      const ticket = loaded.frontmatter;
      let provider: Provider | null = null;
      let workflowNodeId: string | null = null;
      let workflowNodeName: string | null = null;
      let workflowStageName: string | null = null;
      let workflowNodeType: string | null = null;
      if (ticket?.workflow && this.workflowLibrary) {
        try {
          const identity = activeWorkflowIdentity(ticket);
          const definition = (await this.workflowLibrary.get(identity.id, identity.revision)).definition;
          const node = workflowNode(definition, ticket.workflow.current_node);
          provider = resolveNodeProvider(ticket, node);
          workflowNodeId = node.id;
          workflowNodeName = node.name;
          workflowStageName = definition.stages.find((stage) => stage.id === node.stage)?.name ?? node.stage;
          workflowNodeType = node.type;
        } catch { provider = null; }
      }
      const claimBlockers: RepositoryClaimBlocker[] = ticket?.status === "ready" ? reserved.flatMap((active) => {
        if (active.id === ticket.id || !active.assigned_supervisor_host || !active.assigned_supervisor) return [];
        const activeRepositories = new Set(active.repositories.map((repository) => repository.id));
        const repositories = ticket.repositories.map((repository) => repository.id).filter((repository) => activeRepositories.has(repository));
        return repositories.length ? [{
          hostname: active.assigned_supervisor_host,
          supervisor_id: active.assigned_supervisor,
          ticket_id: active.id,
          ticket_title: active.title,
          repositories,
        }] : [];
      }) : [];
      const pendingQuestions = ticket?.questions.filter((question) => question.answer === null).length ?? 0;
      const currentWait = ticket?.workflow && workflowNodeId
        ? Object.values(ticket.workflow.wait_states ?? {})
          .filter((wait) => wait.node_id === workflowNodeId)
          .sort((left, right) => right.attempt - left.attempt || right.started_at.localeCompare(left.started_at))[0]
        : undefined;
      const latestSettledRun = ticket?.workflow?.node_runs.filter((run) => run.status !== "running").at(-1);
      const deliveryFailure = latestSettledRun?.outcome === "delivery_failed" ? latestSettledRun : null;
      const githubFeedback = ticket?.workflow?.incoming?.actor === "github" ? ticket.workflow.incoming : null;
      const attentionKinds: TicketSummary["attention"]["kinds"] = [];
      if (pendingQuestions > 0) attentionKinds.push("question");
      if (ticket?.status === "waiting_approval" && workflowNodeType === "human_gate") attentionKinds.push("human_gate");
      if (ticket?.status === "blocked") attentionKinds.push("blocked");
      if (ticket?.status === "failed") attentionKinds.push("failed");
      if (deliveryFailure && (ticket?.status === "ready" || ticket?.status === "blocked")) attentionKinds.push("delivery_failure");
      if (githubFeedback && (ticket?.status === "ready" || ticket?.status === "blocked") && !ticket.archived_at) attentionKinds.push("github_feedback");
      if (ticket?.status === "waiting_external" && currentWait) attentionKinds.push("expiring_wait");
      if (claimBlockers.length > 0) attentionKinds.push("repository_blocked");
      return {
        id: ticket?.id || loaded.relativePath, title: ticket?.title || basename(loaded.path),
        phase: ticket?.phase ?? "implementation", status: ticket?.status ?? "pending",
        priority: ticket?.priority ?? 0, provider, revision: ticket?.revision ?? 0,
        created_at: ticket?.created_at ?? "",
        updated_at: ticket?.updated_at ?? "",
        valid: loaded.valid, errors: loaded.errors, path: loaded.relativePath, claim_blockers: claimBlockers,
        archived_at: ticket?.archived_at ?? null,
        production_result: ticket?.production_result ?? "unassessed",
        workflow_id: ticket?.workflow?.id ?? null,
        workflow_node_id: workflowNodeId,
        workflow_node_name: workflowNodeName,
        workflow_stage_name: workflowStageName,
        labels: ticket?.labels ?? [],
        repositories: ticket?.repositories.map((repository) => repository.id) ?? [],
        assigned_supervisor: ticket?.assigned_supervisor ?? null,
        estimated_human_days: ticket?.estimated_human_days ?? null,
        attention: {
          kinds: attentionKinds,
          pending_questions: pendingQuestions,
          wait_wake_at: currentWait?.wake_at ?? null,
          wait_deadline_at: currentWait?.deadline_at ?? null,
          delivery_failure_summary: deliveryFailure?.summary ?? null,
          github_feedback_summary: githubFeedback?.summary ?? null,
        },
      };
    }));
    return summaries.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<LoadedTicket> {
    const tickets = await this.list();
    const found = tickets.find((item) => item.frontmatter?.id === id || item.relativePath === id);
    if (!found) throw new HttpError(404, `Ticket ${id} not found`);
    return found;
  }

  private async scanInternal(initial: boolean): Promise<LoadedTicket[]> {
    const paths = await markdownFiles(this.root);
    const loaded: LoadedTicket[] = [];
    for (const path of paths) {
      const markdown = await readFile(path, "utf8");
      try {
        const document = parseDocument(markdown);
        let normalized = normalizeTicket(document.frontmatter, this.clock().toISOString());
        if (normalized.errors.length === 0) await this.runLedger.hydrate(normalized.ticket);
        const priorTicket = this.knownTickets.get(path);
        const prior = this.knownDigests.get(path);
        const admittedOnScan = normalized.admitted;
        const externalChange = !initial && !admittedOnScan && Boolean(prior && prior !== digest(markdown));
        if (normalized.errors.length === 0 && normalized.ticket.workflow && !normalized.ticket.workflow.run_ledger && priorTicket?.workflow
          && priorTicket.workflow.id === normalized.ticket.workflow.id && priorTicket.workflow.revision === normalized.ticket.workflow.revision) {
          normalized.ticket.workflow.node_runs = structuredClone(priorTicket.workflow.node_runs);
        }
        let body = ensureInteractionLog(document.body);
        let content = markdown;
        if (normalized.errors.length === 0 && normalized.admitted) {
          const ticket = normalized.ticket;
          ticket.event_sequence += 1;
          ticket.updated_at = this.clock().toISOString();
          body = appendEvent(body, ticket.event_sequence, ticket.updated_at, "ticket.admitted", "Ticket admitted by the tracker.");
          const persisted = await this.runLedger.externalize(ticket);
          content = serializeDocument(persisted, body);
          await this.atomicReplace(path, markdown, content);
          await this.runLedger.prune(persisted);
          if (ticket.workflow && persisted.workflow?.run_ledger) ticket.workflow.run_ledger = persisted.workflow.run_ledger;
        }
        if (normalized.errors.length === 0 && normalized.ticket.workflow && !normalized.ticket.workflow.run_ledger) {
          const persisted = await this.runLedger.externalize(normalized.ticket);
          content = serializeDocument(persisted, body);
          await this.atomicReplace(path, await readFile(path, "utf8"), content);
          await this.runLedger.prune(persisted);
        }
        const currentDigest = digest(content);
        let fenced = false;
        if (externalChange && priorTicket?.execution) {
          const execution = normalized.ticket.execution;
          const incompatible = normalized.ticket.phase !== priorTicket.phase
            || normalized.ticket.workflow?.revision !== priorTicket.workflow?.revision
            || normalized.ticket.workflow?.current_node !== priorTicket.workflow?.current_node
            || !execution
            || execution.lease_id !== priorTicket.execution.lease_id
            || execution.phase !== normalized.ticket.phase
            || (normalized.ticket.status !== "running" && normalized.ticket.status !== "blocked");
          if (incompatible) {
            const run = normalized.ticket.workflow?.node_runs.find((candidate) => candidate.id === priorTicket.execution?.node_run_id);
            if (run?.status === "running") { const now = this.clock().toISOString(); accountNodeRunTiming(run, now); run.status = "interrupted"; run.completed_at = now; run.outcome = "external_edit_fenced"; run.summary = "External state edit fenced the active lease."; }
            normalized.ticket.execution = null;
            if (normalized.ticket.status === "running" || normalized.ticket.status === "blocked") {
              normalized.ticket.status = normalized.ticket.phase === "done" ? "completed" : "ready";
            }
            const revalidated = normalizeTicket(normalized.ticket as unknown as Record<string, unknown>, this.clock().toISOString());
            normalized = { ...revalidated, admitted: false };
            fenced = true;
          }
        }
        this.knownDigests.set(path, currentDigest);
        const errors = [...normalized.errors, ...validateSessionInvariant(normalized.ticket)];
        loaded.push({ path, relativePath: relative(this.root, path), markdown: content, body, frontmatter: normalized.ticket, valid: errors.length === 0, errors });
        if (externalChange && errors.length === 0) {
          await this.recordExternalEdit(path, normalized.ticket, body, fenced);
          const refreshed = await this.loadPath(path);
          loaded[loaded.length - 1] = refreshed;
        }
        const finalTicket = loaded[loaded.length - 1]?.frontmatter;
        if (finalTicket) this.knownTickets.set(path, structuredClone(finalTicket));
      } catch (error) {
        loaded.push({ path, relativePath: relative(this.root, path), markdown, body: "", frontmatter: null, valid: false, errors: [(error as Error).message] });
        this.knownDigests.set(path, digest(markdown));
        this.knownTickets.delete(path);
      }
    }
    const byId = new Map<string, LoadedTicket[]>();
    for (const item of loaded) {
      if (!item.frontmatter) continue;
      byId.set(item.frontmatter.id, [...(byId.get(item.frontmatter.id) ?? []), item]);
    }
    for (const [id, items] of byId) if (items.length > 1) for (const item of items) { item.errors.push(`Duplicate id: ${id}`); item.valid = false; }
    return loaded;
  }

  private async recordExternalEdit(path: string, ticket: TicketFrontmatter, body: string, fenced: boolean): Promise<void> {
    const now = this.clock().toISOString();
    ticket.revision += 1;
    ticket.event_sequence += 1;
    ticket.updated_at = now;
    let message = "External file edit accepted; current workflow node retained.";
    if (fenced) message = "External state edit accepted; incompatible active lease fenced.";
    if (ticket.execution && (ticket.status === "running" || ticket.status === "blocked")) {
      const sequence = ticket.event_sequence;
      ticket.execution.guidance.push({ id: `guidance-${randomUUID()}`, sequence, message: "The authoritative ticket changed. Reread it before continuing.", created_at: now, delivered_at: null });
      message += " Active agent queued to reread the ticket.";
    }
    const nextBody = appendEvent(body, ticket.event_sequence, now, "ticket.external_edited", message);
    const persisted = await this.runLedger.externalize(ticket);
    const next = serializeDocument(persisted, nextBody);
    await this.atomicReplace(path, await readFile(path, "utf8"), next);
    await this.runLedger.prune(persisted);
    this.knownDigests.set(path, digest(next));
    this.knownTickets.set(path, structuredClone(ticket));
  }

  private async loadPath(path: string): Promise<LoadedTicket> {
    const markdown = await readFile(path, "utf8");
    const doc = parseDocument(markdown);
    const normalized = normalizeTicket(doc.frontmatter);
    if (normalized.errors.length === 0) await this.runLedger.hydrate(normalized.ticket);
    const errors = [...normalized.errors, ...validateSessionInvariant(normalized.ticket)];
    return { path, relativePath: relative(this.root, path), markdown, body: doc.body, frontmatter: normalized.ticket, valid: errors.length === 0, errors };
  }

  async create(markdown: string, filename?: string): Promise<LoadedTicket> {
    return this.serial(async () => {
      const doc = parseDocument(markdown);
      const normalized = normalizeTicket(doc.frontmatter, this.clock().toISOString());
      if (normalized.errors.length) throw new HttpError(422, "Ticket is invalid", normalized.errors);
      const tickets = this.indexedTickets();
      const duplicate = tickets.find((item) => item.frontmatter && item.frontmatter.id === normalized.ticket.id);
      if (duplicate) {
        throw new HttpError(409, "Ticket id already exists", [`id '${normalized.ticket.id}' conflicts with ${duplicate.relativePath}`]);
      }
      const safe = (filename ?? `${normalized.ticket.id}.md`).replaceAll(/[^A-Za-z0-9._-]/g, "-");
      if (!safe.endsWith(".md")) throw new HttpError(422, "Ticket filename must end in .md");
      const path = resolve(this.root, safe);
      if (!path.startsWith(this.root + sep)) throw new HttpError(422, "Ticket path escapes ticket root");
      try { await access(path); throw new HttpError(409, `Ticket file ${safe} already exists`); } catch (error) { if (error instanceof HttpError) throw error; }
      const now = this.clock().toISOString();
      const ticket = normalized.ticket;
      ticket.event_sequence = 1; ticket.revision = 1; ticket.created_at = now; ticket.updated_at = now;
      const body = appendEvent(doc.body, 1, now, "ticket.created", "Ticket created by the operator.");
      const persisted = await this.runLedger.externalize(ticket);
      const content = serializeDocument(persisted, body);
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await this.runLedger.prune(persisted);
      this.knownDigests.set(path, digest(content));
      this.knownTickets.set(path, structuredClone(ticket));
      this.emit("changed", { type: "ticket.changed", id: ticket.id, revision: ticket.revision });
      return this.cacheLoaded(await this.loadPath(path));
    });
  }

  async edit(id: string, markdown: string, expectedRevision: number): Promise<LoadedTicket> {
    return this.serial(async () => {
      const tickets = this.indexedTickets();
      const current = tickets.find((item) => item.frontmatter?.id === id || item.relativePath === id);
      if (!current) throw new HttpError(404, `Ticket ${id} not found`);
      const currentRevision = current.frontmatter?.revision ?? 0;
      if (currentRevision !== expectedRevision) throw new HttpError(409, "Ticket revision changed", current);
      const supplied = parseDocument(markdown);
      const normalized = normalizeTicket(supplied.frontmatter, this.clock().toISOString());
      if (normalized.errors.length === 0) await this.runLedger.hydrate(normalized.ticket);
      const suppliedErrors = [...normalized.errors, ...validateSessionInvariant(normalized.ticket)];
      if (suppliedErrors.length) throw new HttpError(422, "Edited ticket is invalid", suppliedErrors);
      const duplicate = tickets.find((item) => item.path !== current.path && item.frontmatter?.id === normalized.ticket.id);
      if (duplicate) throw new HttpError(422, "Edited ticket duplicates another ticket", { path: duplicate.relativePath });
      if (!current.valid || !current.frontmatter) {
        const now = this.clock().toISOString();
        const ticket = normalized.ticket;
        ticket.revision = currentRevision + 1;
        ticket.event_sequence = (current.frontmatter?.event_sequence ?? 0) + 1;
        ticket.created_at = current.frontmatter?.created_at ?? now;
        ticket.updated_at = now;
        const body = appendEvent(supplied.body, ticket.event_sequence, now, "ticket.corrected", "Invalid ticket corrected through the operator editor.");
        const persisted = await this.runLedger.externalize(ticket);
        const next = serializeDocument(persisted, body);
        await this.atomicReplace(current.path, current.markdown, next);
        await this.runLedger.prune(persisted);
        this.knownDigests.set(current.path, digest(next));
        this.knownTickets.set(current.path, structuredClone(ticket));
        this.emit("changed", { type: "ticket.changed", id: ticket.id, revision: ticket.revision });
        return this.cacheLoaded(await this.loadPath(current.path));
      }
      const validCurrent = current as LoadedTicket & { frontmatter: TicketFrontmatter };
      let next = normalized.ticket;
      if (next.workflow && validCurrent.frontmatter.workflow
        && next.workflow.id === validCurrent.frontmatter.workflow.id && next.workflow.revision === validCurrent.frontmatter.workflow.revision
        && !next.workflow.run_ledger && next.workflow.node_runs.length === 0) {
        next.workflow.node_runs = structuredClone(validCurrent.frontmatter.workflow.node_runs);
      }
      next.created_at = validCurrent.frontmatter.created_at;
      next.pull_requests = validCurrent.frontmatter.pull_requests;
      next.questions = validCurrent.frontmatter.questions;
      next.attachments = validCurrent.frontmatter.attachments;
      next.artifacts = validCurrent.frontmatter.artifacts;
      next.checkpoints = validCurrent.frontmatter.checkpoints;
      next.jira = validCurrent.frontmatter.jira;
      next.archived_at = validCurrent.frontmatter.archived_at;
      next.execution = structuredClone(validCurrent.frontmatter.execution);
      const event = "ticket.edited";
      let eventMessage = "Ticket edited; current workflow node retained.";
      next.phase = validCurrent.frontmatter.phase;
      next.status = validCurrent.frontmatter.status;
      if (next.execution) {
        if (next.execution.interrupt_request) throw new HttpError(409, "Ticket is already waiting for agent interruption");
        const sequence = validCurrent.frontmatter.event_sequence + 1;
        next.execution.guidance.push({
          id: `guidance-${randomUUID()}`,
          sequence,
          message: `Ticket description changed at revision ${validCurrent.frontmatter.revision + 1}. Reread the authoritative ticket before continuing ${next.phase}.`,
          created_at: this.clock().toISOString(),
          delivered_at: null,
        });
        if (next.status === "blocked" && !next.questions.some((item) => item.answer === null)) next.status = "running";
        eventMessage = "Ticket edited; current workflow node retained and active agent asked to reread it.";
      }
      return this.mutateLoaded(validCurrent, next, supplied.body, {
        event,
        message: eventMessage,
      });
    });
  }

  async command(id: string, options: MutateOptions, mutator: Mutator): Promise<LoadedTicket> {
    return this.serial(async () => {
      const current = await this.findValid(id);
      if (options.expectedRevision !== undefined && current.frontmatter.revision !== options.expectedRevision) {
        throw new HttpError(409, "Ticket revision changed", current);
      }
      const changed = mutator(structuredClone(current.frontmatter), current.body);
      return this.mutateLoaded(current, changed.ticket, changed.body ?? current.body, options);
    });
  }

  private async mutateLoaded(current: LoadedTicket & { frontmatter: TicketFrontmatter }, ticket: TicketFrontmatter, body: string, options: MutateOptions): Promise<LoadedTicket> {
    const now = this.clock().toISOString();
    ticket.revision = current.frontmatter.revision + 1;
    ticket.event_sequence = current.frontmatter.event_sequence + (options.silent ? 0 : 1);
    ticket.updated_at = now;
    const errors = [...normalizeTicket(ticket as unknown as Record<string, unknown>, now).errors, ...validateSessionInvariant(ticket)];
    if (errors.length) throw new HttpError(422, "Ticket mutation is invalid", errors);
    const nextBody = options.silent ? body : appendEvent(body, ticket.event_sequence, now, options.event, options.message);
    const persisted = await this.runLedger.externalize(ticket);
    const next = serializeDocument(persisted, nextBody);
    await this.atomicReplace(current.path, current.markdown, next);
    await this.runLedger.prune(persisted);
    this.knownDigests.set(current.path, digest(next));
    this.knownTickets.set(current.path, structuredClone(ticket));
    this.emit("changed", { type: "ticket.changed", id: ticket.id, revision: ticket.revision });
    return this.cacheLoaded(await this.loadPath(current.path));
  }

  private async findValid(id: string): Promise<LoadedTicket & { frontmatter: TicketFrontmatter }> {
    const tickets = this.indexedTickets();
    const current = tickets.find((item) => item.frontmatter?.id === id || item.relativePath === id);
    if (!current) throw new HttpError(404, `Ticket ${id} not found`);
    if (!current.valid || !current.frontmatter) throw new HttpError(422, "Ticket is invalid", current.errors);
    return current as LoadedTicket & { frontmatter: TicketFrontmatter };
  }

  private async workflowRequirements(ticket: TicketFrontmatter): Promise<{
    providers: Provider[]; activities: ActivityCapability[];
  }> {
    if (!ticket.workflow || !this.workflowLibrary) return { providers: [], activities: [] };
    const revisions = ticket.workflow.workflow_revisions ?? { [ticket.workflow.id]: ticket.workflow.revision };
    const providers = new Set<Provider>();
    const activities = new Set<ActivityCapability>();
    for (const [workflowId, revision] of Object.entries(revisions)) {
      const definition = (await this.workflowLibrary.get(workflowId, revision)).definition;
      for (const node of definition.nodes) {
        if (!workflowNodeEnabled(ticket, definition, node)) continue;
        const provider = resolveNodeProvider(ticket, node, workflowId);
        if (provider) providers.add(provider);
        const capability = requiredActivityCapability(node);
        if (capability) activities.add(capability);
      }
    }
    return { providers: [...providers], activities: [...activities] };
  }

  async claim(
    supervisorId: string,
    provider: Provider,
    availableProviders: Provider[] = ["claude", "codex"],
    supervisorHost = supervisorId,
    activityCapabilities: ActivityCapability[] = ["repository_action", "inline_shell", "inline_javascript", "inline_python", "git_checkpoint", "git_restore"],
  ): Promise<LoadedTicket | null> {
    return this.serial(async () => {
      await this.expireLeasesInternal();
      let tickets = this.indexedTickets().filter((item): item is LoadedTicket & { frontmatter: TicketFrontmatter } => Boolean(item.valid && item.frontmatter));
      tickets = await Promise.all(tickets.map((ticket) => this.settleAutomaticLoaded(ticket)));
      const reservation = tickets.find((item) => item.frontmatter.assigned_supervisor === supervisorId && supervisorReservationActive(item.frontmatter));
      const candidates = tickets.filter((item) => item.frontmatter.status === "ready"
        && (!reservation || item.frontmatter.id === reservation.frontmatter.id)
        && (item.frontmatter.assigned_supervisor === null || item.frontmatter.assigned_supervisor === supervisorId)
        && (item.frontmatter.assigned_supervisor_host === null || item.frontmatter.assigned_supervisor_host === supervisorHost)
        && Boolean(item.frontmatter.workflow)
        && !tickets.some((active) => active.frontmatter.id !== item.frontmatter.id
          && supervisorReservationActive(active.frontmatter)
          && active.frontmatter.assigned_supervisor_host === supervisorHost
          && active.frontmatter.repositories.some((repository) => item.frontmatter.repositories.some((candidate) => candidate.id === repository.id)))
        )
        .sort((a, b) => b.frontmatter.priority - a.frontmatter.priority || a.frontmatter.created_at.localeCompare(b.frontmatter.created_at) || a.frontmatter.id.localeCompare(b.frontmatter.id));
      let match: (LoadedTicket & { frontmatter: TicketFrontmatter }) | undefined;
      let workflowNodeForClaim: WorkflowNode | null = null;
      for (const candidate of candidates) {
        if (!this.workflowLibrary) continue;
        const identity = activeWorkflowIdentity(candidate.frontmatter);
        const definition = (await this.workflowLibrary.get(identity.id, identity.revision)).definition;
        const requirements = await this.workflowRequirements(candidate.frontmatter);
        if (candidate.frontmatter.assigned_supervisor === null && requirements.providers.some((requiredProvider) => !availableProviders.includes(requiredProvider))) continue;
        if (candidate.frontmatter.assigned_supervisor === null && requirements.activities.some((capability) => !activityCapabilities.includes(capability))) continue;
        const node = workflowNode(definition, candidate.frontmatter.workflow!.current_node);
        if (node.type === "agent" && resolveNodeProvider(candidate.frontmatter, node) === provider) {
          match = candidate; workflowNodeForClaim = node; break;
        }
      }
      if (!match) return null;
      const now = this.clock();
      const key = phaseKey(match.frontmatter.phase);
      const lease = randomUUID();
      const ticket = structuredClone(match.frontmatter);
      ticket.assigned_supervisor = supervisorId;
      ticket.assigned_supervisor_host = supervisorHost;
      ticket.status = "running";
      const attemptCounter = nodeAttemptCounter(ticket, workflowNodeForClaim?.id);
      attemptCounter.total += 1;
      const attemptNumber = attemptCounter.total;
      ticket.execution = {
        lease_id: lease, supervisor_id: supervisorId, provider, phase: ticket.phase, attempt: attemptNumber,
        claimed_at: now.toISOString(), last_heartbeat_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
        delivery_status: "starting", delivery_confirmed_at: null,
        observed_herdr_state: null, herdr_observation: null, telemetry: null, guidance: [],
        interrupt_request: null,
      };
      let conversationGeneration: number | null = null;
      if (workflowNodeForClaim?.conversation_key && ticket.workflow) {
        ticket.conversations ??= {};
        const conversationKey = workflowNodeForClaim.conversation_key;
        const existing = ticket.conversations[conversationKey];
        const nodeVisit = ticket.workflow.node_visits[runtimeNodeKey(ticket, workflowNodeForClaim.id)] ?? 1;
        const visitKey = `${activeWorkflowIdentity(ticket).id}/${workflowNodeForClaim.id}:${nodeVisit}`;
        const providerChanged = Boolean(existing && existing.provider !== provider);
        const isNewVisit = existing?.last_visit_key !== visitKey;
        const policy = workflowNodeForClaim.conversation_policy ?? "resume";
        const thresholdReached = policy === "reset_after_visits" && isNewVisit
          && (existing?.visits_in_generation ?? 0) >= (workflowNodeForClaim.maximum_visits_per_session ?? 1);
        const freshVisit = policy === "fresh_each_visit" && isNewVisit && Boolean(existing?.last_visit_key);
        const resetReason = providerChanged ? "provider_changed" : freshVisit ? "fresh_each_visit" : thresholdReached ? "visit_threshold" : null;
        const reset = Boolean(resetReason);
        const next = existing ? { ...existing } : {
          provider, herdr_pane_id: null, session_ref: null, generation: 1,
          visits_in_generation: 0, last_visit_key: null, reset_reason: null,
        };
        if (reset) {
          next.herdr_pane_id = null;
          next.session_ref = null;
          next.generation = Math.max(1, next.generation) + 1;
          next.visits_in_generation = 0;
        }
        next.provider = provider;
        if (isNewVisit) next.visits_in_generation += 1;
        next.last_visit_key = visitKey;
        next.reset_reason = resetReason;
        ticket.conversations[conversationKey] = next;
        conversationGeneration = next.generation;
      }
      if (workflowNodeForClaim && ticket.workflow) {
        const run = beginNodeRun(ticket, workflowNodeForClaim, activeWorkflowIdentity(ticket).revision, attemptNumber, now.toISOString(), supervisorId, provider, lease);
        run.conversation_generation = conversationGeneration;
        ticket.execution.node_run_id = run.id;
        ticket.execution.node_id = workflowNodeForClaim.id;
        ticket.execution.node_type = "agent";
        ticket.execution.conversation_key = workflowNodeForClaim.conversation_key;
      }
      return this.mutateLoaded(match, ticket, match.body, { event: "work.claimed", message: `${provider} claimed ${key} as lease ${lease}.` });
    });
  }

  async claimActivity(
    supervisorId: string,
    availableProviders: Provider[] = ["claude", "codex"],
    supervisorHost = supervisorId,
    activityCapabilities: ActivityCapability[] = ["repository_action", "inline_shell", "inline_javascript", "inline_python", "git_checkpoint", "git_restore"],
  ): Promise<LoadedTicket | null> {
    return this.serial(async () => {
      if (!this.workflowLibrary) return null;
      await this.expireLeasesInternal();
      let tickets = this.indexedTickets().filter((item): item is LoadedTicket & { frontmatter: TicketFrontmatter } => Boolean(item.valid && item.frontmatter));
      tickets = await Promise.all(tickets.map((ticket) => this.settleAutomaticLoaded(ticket)));
      const reservation = tickets.find((item) => item.frontmatter.assigned_supervisor === supervisorId && supervisorReservationActive(item.frontmatter));
      for (const current of tickets.filter((item) => item.frontmatter.status === "ready" && item.frontmatter.workflow)
        .sort((a, b) => b.frontmatter.priority - a.frontmatter.priority || a.frontmatter.created_at.localeCompare(b.frontmatter.created_at))) {
        const ticket = current.frontmatter;
        if (reservation && reservation.frontmatter.id !== ticket.id) continue;
        if (ticket.assigned_supervisor && ticket.assigned_supervisor !== supervisorId) continue;
        if (ticket.assigned_supervisor_host && ticket.assigned_supervisor_host !== supervisorHost) continue;
        const identity = activeWorkflowIdentity(ticket);
        const definition = (await this.workflowLibrary.get(identity.id, identity.revision)).definition;
        const requirements = await this.workflowRequirements(ticket);
        if (ticket.assigned_supervisor === null && requirements.providers.some((provider) => !availableProviders.includes(provider))) continue;
        if (ticket.assigned_supervisor === null && requirements.activities.some((capability) => !activityCapabilities.includes(capability))) continue;
        const node = workflowNode(definition, ticket.workflow!.current_node);
        if (!["script", "checkpoint", "restore_checkpoint"].includes(node.type)) continue;
        const capability = requiredActivityCapability(node);
        if (!capability || !activityCapabilities.includes(capability)) continue;
        const conflict = tickets.some((active) => active.frontmatter.id !== ticket.id && supervisorReservationActive(active.frontmatter)
          && active.frontmatter.assigned_supervisor_host === supervisorHost
          && active.frontmatter.repositories.some((repo) => ticket.repositories.some((candidate) => candidate.id === repo.id)));
        if (conflict) continue;
        const now = this.clock();
        const next = structuredClone(ticket);
        next.assigned_supervisor = supervisorId; next.assigned_supervisor_host = supervisorHost; next.status = "running";
        const attemptCounter = nodeAttemptCounter(next, node.id);
        attemptCounter.total += 1;
        const lease = randomUUID();
        const run = beginNodeRun(next, node, activeWorkflowIdentity(next).revision, attemptCounter.total, now.toISOString(), supervisorId, null, lease);
        next.execution = {
          lease_id: lease, supervisor_id: supervisorId, provider: null, phase: next.phase, attempt: attemptCounter.total,
          claimed_at: now.toISOString(), last_heartbeat_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
          delivery_status: "delivered", delivery_confirmed_at: now.toISOString(),
          observed_herdr_state: null, herdr_observation: null, telemetry: null, guidance: [], interrupt_request: null,
          node_run_id: run.id, node_id: node.id, node_type: node.type as "script" | "checkpoint" | "restore_checkpoint",
        };
        return this.mutateLoaded(current, next, current.body, { event: "activity.claimed", message: `${supervisorId} claimed ${node.type} node ${node.id}.` });
      }
      return null;
    });
  }

  async byLease(leaseId: string): Promise<LoadedTicket & { frontmatter: TicketFrontmatter; execution: NonNullable<TicketFrontmatter["execution"]> }> {
    const tickets = await this.list();
    const found = tickets.find((item) => item.frontmatter?.execution?.lease_id === leaseId);
    if (!found?.frontmatter?.execution) throw new HttpError(409, "Lease is stale or fenced");
    return Object.assign(found, { frontmatter: found.frontmatter, execution: found.frontmatter.execution });
  }

  async heartbeat(leaseId: string, observation: {
    state?: string; paneId?: string; sessionRef?: string; guidanceCursor?: number;
    supervisorHost?: string;
    herdr?: Partial<Omit<HerdrObservation, "state" | "observed_at" | "state_changed_at">>;
    telemetry?: HarnessTelemetrySnapshot;
    telemetryBaseline?: HarnessTelemetrySnapshot;
  }): Promise<LoadedTicket> {
    const leased = await this.byLease(leaseId);
    return this.command(leased.frontmatter.id, { event: "work.heartbeat", message: "Lease heartbeat accepted.", silent: true }, (ticket) => {
      if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced");
      const now = this.clock();
      if (!ticket.assigned_supervisor_host && observation.supervisorHost) ticket.assigned_supervisor_host = observation.supervisorHost;
      ticket.execution.last_heartbeat_at = now.toISOString();
      ticket.execution.lease_expires_at = new Date(now.getTime() + this.leaseTtlMs).toISOString();
      const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === ticket.execution?.node_run_id);
      if (run) accountNodeRunTiming(run, now.toISOString(), observation.telemetry ? timingState(observation.telemetry, now) : undefined);
      if (observation.telemetry) {
        const measured = telemetryRecord(observation.telemetry, observation.telemetryBaseline, ticket.execution.telemetry);
        ticket.execution.telemetry = measured;
        if (run) run.telemetry = measured;
      }
      if (observation.state !== undefined) ticket.execution.observed_herdr_state = observation.state;
      if (observation.state !== undefined || observation.paneId !== undefined || observation.herdr !== undefined) {
        const previous = ticket.execution.herdr_observation;
        const state = observation.state ?? previous?.state ?? "unknown";
        const changed = previous?.state !== state;
        ticket.execution.herdr_observation = {
          state,
          observed_at: now.toISOString(),
          state_changed_at: changed ? now.toISOString() : previous?.state_changed_at ?? now.toISOString(),
          pane_id: observation.paneId ?? observation.herdr?.pane_id ?? previous?.pane_id ?? null,
          workspace_id: observation.herdr?.workspace_id ?? previous?.workspace_id ?? null,
          tab_id: observation.herdr?.tab_id ?? previous?.tab_id ?? null,
          terminal_id: observation.herdr?.terminal_id ?? previous?.terminal_id ?? null,
          focused: observation.herdr?.focused ?? previous?.focused ?? null,
          cwd: observation.herdr?.cwd ?? previous?.cwd ?? null,
          foreground_cwd: observation.herdr?.foreground_cwd ?? previous?.foreground_cwd ?? null,
          terminal_title: observation.herdr?.terminal_title ?? previous?.terminal_title ?? null,
          terminal_title_stripped: observation.herdr?.terminal_title_stripped ?? previous?.terminal_title_stripped ?? null,
          display_name: observation.herdr?.display_name ?? previous?.display_name ?? null,
          revision: observation.herdr?.revision ?? previous?.revision ?? null,
          session_source: observation.herdr?.session_source ?? previous?.session_source ?? null,
          session_kind: observation.herdr?.session_kind ?? previous?.session_kind ?? null,
          tokens: observation.herdr?.tokens ?? previous?.tokens ?? {},
        };
      }
      if (ticket.execution.provider && ticket.execution.conversation_key) {
        ticket.conversations ??= {};
        const conversation = ticket.conversations[ticket.execution.conversation_key] ?? {
          provider: ticket.execution.provider, herdr_pane_id: null, session_ref: null,
          generation: 1, visits_in_generation: 1, last_visit_key: null, reset_reason: null,
        };
        conversation.provider = ticket.execution.provider;
        if (observation.paneId !== undefined) conversation.herdr_pane_id = observation.paneId;
        if (observation.sessionRef !== undefined) conversation.session_ref = observation.sessionRef;
        ticket.conversations[ticket.execution.conversation_key] = conversation;
      }
      if (observation.guidanceCursor !== undefined) {
        for (const item of ticket.execution.guidance) if (item.sequence <= observation.guidanceCursor && !item.delivered_at) item.delivered_at = now.toISOString();
      }
      return { ticket };
    });
  }

  async confirmAssignmentDelivery(
    leaseId: string,
    confirmation: "direct" | "observed_activity" | "submitted_staged_prompt" = "direct",
  ): Promise<LoadedTicket> {
    const leased = await this.byLease(leaseId);
    const message = confirmation === "submitted_staged_prompt"
      ? "Assignment delivery recovered by submitting the staged prompt; agent monitoring started."
      : confirmation === "observed_activity"
        ? "Assignment delivery confirmed from observed agent activity; agent monitoring started."
        : "Assignment prompt delivery confirmed; agent monitoring started.";
    return this.command(leased.frontmatter.id, {
      event: "work.assignment_delivered", message,
    }, (ticket) => {
      if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced", undefined, "LEASE_STALE");
      if (ticket.execution.node_type !== "agent") throw new HttpError(409, "Lease is not an agent assignment", undefined, "ASSIGNMENT_DELIVERY_INVALID");
      if (ticket.execution.delivery_status === "delivered") return { ticket };
      ticket.execution.delivery_status = "delivered";
      ticket.execution.delivery_confirmed_at = this.clock().toISOString();
      return { ticket };
    });
  }

  async rejectAssignmentDelivery(leaseId: string, reason: string): Promise<LoadedTicket> {
    const leased = await this.byLease(leaseId);
    const summary = reason.trim().slice(0, 2_000) || "Herdr did not confirm assignment delivery.";
    const priorFailures = leased.execution.node_id
      ? leased.frontmatter.workflow?.node_attempts[runtimeNodeKey(leased.frontmatter, leased.execution.node_id)]?.consecutive_lease_losses ?? 0
      : 0;
    const disposition = priorFailures + 1 >= 3
      ? "Third consecutive operational loss; operator attention required."
      : "The same workflow node was returned to ready for an automatic retry.";
    return this.command(leased.frontmatter.id, {
      event: "work.assignment_delivery_failed", message: `${summary} ${disposition}`,
    }, (ticket) => {
      if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced", undefined, "LEASE_STALE");
      if (ticket.execution.node_type !== "agent") throw new HttpError(409, "Lease is not an agent assignment", undefined, "ASSIGNMENT_DELIVERY_INVALID");
      if (ticket.execution.delivery_status !== "starting") throw new HttpError(409, "Assignment delivery was already confirmed", undefined, "ASSIGNMENT_ALREADY_DELIVERED");
      const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === ticket.execution?.node_run_id);
      if (run?.status === "running") {
        const now = this.clock().toISOString();
        accountNodeRunTiming(run, now);
        run.status = "failed";
        run.completed_at = now;
        run.outcome = "delivery_failed";
        run.summary = summary;
      }
      const attemptCounter = nodeAttemptCounter(ticket, ticket.execution.node_id);
      attemptCounter.consecutive_lease_losses += 1;
      ticket.execution = null;
      ticket.status = attemptCounter.consecutive_lease_losses >= 3 ? "blocked" : "ready";
      return { ticket };
    });
  }

  async recordTelemetry(
    leaseId: string,
    latest: HarnessTelemetrySnapshot,
    baseline?: HarnessTelemetrySnapshot,
  ): Promise<LoadedTicket> {
    const tickets = await this.list();
    const found = tickets.find((item) => item.valid && item.frontmatter
      && (item.frontmatter.execution?.lease_id === leaseId
        || item.frontmatter.workflow?.node_runs.some((run) => run.lease_id === leaseId)));
    if (!found?.frontmatter) throw new HttpError(409, "Telemetry lease is unknown or no longer retained");
    return this.command(found.frontmatter.id, { event: "work.telemetry", message: "Harness telemetry recorded.", silent: true }, (ticket) => {
      const run = ticket.workflow?.node_runs.find((candidate) => candidate.lease_id === leaseId);
      const execution = ticket.execution?.lease_id === leaseId ? ticket.execution : null;
      if (!run && !execution) throw new HttpError(409, "Telemetry lease is unknown or no longer retained");
      const measured = telemetryRecord(latest, baseline, execution?.telemetry ?? run?.telemetry);
      if (execution) execution.telemetry = measured;
      if (run) run.telemetry = measured;
      return { ticket };
    });
  }

  async expireLeases(): Promise<number> { return this.serial(() => this.expireLeasesInternal()); }

  private async expireLeasesInternal(): Promise<number> {
    const tickets = this.indexedTickets().filter((item): item is LoadedTicket & { frontmatter: TicketFrontmatter } => Boolean(item.valid && item.frontmatter?.execution));
    let count = 0;
    for (const current of tickets) {
      const execution = current.frontmatter.execution;
      if (!execution || Date.parse(execution.lease_expires_at) > this.clock().getTime()) continue;
      const ticket = structuredClone(current.frontmatter);
      if (execution.interrupt_request) {
        const interrupt = execution.interrupt_request;
        const transitionsWithinWorkflow = Boolean(!interrupt.terminal_status && ticket.workflow && interrupt.target_node && this.workflowLibrary
          && interrupt.target_workflow_id === activeWorkflowIdentity(ticket).id && interrupt.target_workflow_revision === activeWorkflowIdentity(ticket).revision);
        const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === execution.node_run_id);
        if (run?.status === "running") { const now = this.clock().toISOString(); accountNodeRunTiming(run, now); run.status = "interrupted"; run.completed_at = now; run.outcome = transitionsWithinWorkflow ? "operator_interrupt_timeout" : "interrupt_timeout"; run.summary = "Execution interruption was not acknowledged before lease expiry."; }
        if (transitionsWithinWorkflow && ticket.workflow && interrupt.target_node && this.workflowLibrary) {
          const identity = activeWorkflowIdentity(ticket);
          const definition = (await this.workflowLibrary.get(identity.id, identity.revision)).definition;
          transitionTo(ticket, definition, interrupt.target_node, {
            outcome: "operator_interrupt_timeout", summary: "The prior execution was fenced after its interrupt acknowledgement timed out.", actor: "workflow",
          });
        } else if (!ticket.workflow && !interrupt.terminal_status) ticket.phase = interrupt.target_phase;
        ticket.status = "blocked";
        ticket.execution = null;
        await this.mutateLoaded(current, ticket, current.body, {
          event: "work.interrupt_timed_out", message: `${interrupt.terminal_status ? `Requested ${interrupt.terminal_status} state` : `Restart at ${interrupt.target_phase}`} requires operator attention because interruption was not acknowledged.`,
        });
        count += 1;
        continue;
      }
      const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === execution.node_run_id);
      if (run?.status === "running") { const now = this.clock().toISOString(); accountNodeRunTiming(run, now); run.status = "failed"; run.completed_at = now; run.outcome = "lease_lost"; run.summary = "Lease expired without a callback."; }
      const attemptCounter = nodeAttemptCounter(ticket, execution.node_id);
      attemptCounter.consecutive_lease_losses += 1;
      ticket.execution = null;
      ticket.status = attemptCounter.consecutive_lease_losses >= 3 ? "blocked" : "ready";
      await this.mutateLoaded(current, ticket, current.body, {
        event: "work.lease_lost", message: ticket.status === "blocked" ? "Third consecutive lease loss; operator attention required." : "Lease lost; phase returned to ready.",
      });
      count += 1;
    }
    return count;
  }

  private async atomicReplace(path: string, expected: string, next: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await readFile(path, "utf8");
      if (current !== expected) throw new HttpError(409, "Ticket changed during mutation");
      const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
      const check = await readFile(path, "utf8");
      if (check !== expected) { await rm(temporary, { force: true }); throw new HttpError(409, "Ticket changed during mutation"); }
      await rename(temporary, path);
      try { const directory = await open(dirname(path), "r"); await directory.sync(); await directory.close(); } catch { /* not supported everywhere */ }
      return;
    }
    throw new HttpError(409, "Ticket changed repeatedly during mutation");
  }
}

export function mergePullRequests(existing: PullRequestRef[], incoming: PullRequestRef[], repositories: string[]): PullRequestRef[] {
  const byUrl = new Map(existing.map((item) => [item.url, item]));
  for (const item of incoming) {
    if (!repositories.includes(item.repository)) throw new HttpError(422, `Unknown repository ${item.repository}`);
    if (!/^https:\/\/github\.com\//.test(item.url)) throw new HttpError(422, `Pull request URL for ${item.repository} must be a GitHub URL`);
    const previous = byUrl.get(item.url);
    if (previous && previous.repository !== item.repository) throw new HttpError(422, `Pull request ${item.url} is already associated with ${previous.repository}`);
    const phase = item.phase === "specification" || item.phase === "implementation" || item.phase === "review" ? item.phase : previous?.phase;
    byUrl.set(item.url, {
      repository: item.repository, url: item.url,
      ...(phase ? { phase } : {}), observation: previous?.observation ?? null,
    });
  }
  return [...byUrl.values()];
}
