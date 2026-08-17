import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "chokidar";
import {
  HttpError, type HerdrObservation, type LoadedTicket, type Phase, type Provider, type PullRequestRef, type RepositoryClaimBlocker, type TicketFrontmatter,
  type TicketSummary, canProviderClaim, canSupervisorOwn, requiredProvider, supervisorReservationActive,
} from "./domain.js";
import { appendEvent, ensureInteractionLog, parseDocument, serializeDocument } from "./markdown.js";
import { normalizeTicket, validateSessionInvariant } from "./validation.js";

interface StoreOptions {
  leaseTtlMs?: number;
  now?: () => Date;
  watch?: boolean;
}

interface MutateOptions {
  event: string;
  message: string;
  expectedRevision?: number | undefined;
  silent?: boolean;
}

type Mutator = (ticket: TicketFrontmatter, body: string) => { ticket: TicketFrontmatter; body?: string };

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function phaseKey(phase: Phase): "specification" | "implementation" | "review" {
  if (phase === "done") throw new HttpError(409, "Done tickets cannot be assigned");
  return phase;
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

  constructor(root: string, options: StoreOptions = {}) {
    super();
    this.root = resolve(root);
    this.leaseTtlMs = options.leaseTtlMs ?? 120_000;
    this.clock = options.now ?? (() => new Date());
    this.enableWatch = options.watch ?? true;
    this.lockPath = join(this.root, ".agentic-project-tracker.lock");
  }

  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.acquireLock();
    await this.serial(() => this.scanInternal(true));
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
      await this.scanInternal(false);
      this.emit("changed", { type: "tickets.changed" });
    });
  }

  async list(): Promise<LoadedTicket[]> {
    return this.serial(() => this.scanInternal(false));
  }

  async summaries(includeArchived = false): Promise<TicketSummary[]> {
    const loadedTickets = await this.list();
    const reserved = loadedTickets.flatMap((loaded) => loaded.valid && loaded.frontmatter
      && loaded.frontmatter.assigned_supervisor_host && supervisorReservationActive(loaded.frontmatter) ? [loaded.frontmatter] : []);
    return loadedTickets.filter((loaded) => includeArchived || !loaded.frontmatter?.archived_at).map((loaded) => {
      const ticket = loaded.frontmatter;
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
      return {
        id: ticket?.id || loaded.relativePath, title: ticket?.title || basename(loaded.path),
        phase: ticket?.phase ?? "implementation", status: ticket?.status ?? "pending",
        work_provider: ticket?.work_provider ?? "claude", review_provider: ticket?.review_provider ?? "codex",
        review_required: ticket?.review_required ?? false,
        priority: ticket?.priority ?? 0, provider: ticket ? requiredProvider(ticket) : null, revision: ticket?.revision ?? 0,
        valid: loaded.valid, errors: loaded.errors, path: loaded.relativePath, claim_blockers: claimBlockers,
        archived_at: ticket?.archived_at ?? null,
      };
    }).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
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
        let body = ensureInteractionLog(document.body);
        let content = markdown;
        if (normalized.errors.length === 0 && normalized.admitted) {
          const ticket = normalized.ticket;
          ticket.event_sequence += 1;
          ticket.updated_at = this.clock().toISOString();
          body = appendEvent(body, ticket.event_sequence, ticket.updated_at, "ticket.admitted", "Ticket admitted by the tracker.");
          content = serializeDocument(ticket, body);
          await this.atomicReplace(path, markdown, content);
        }
        const currentDigest = digest(content);
        const prior = this.knownDigests.get(path);
        const priorTicket = this.knownTickets.get(path);
        const externalChange = !initial && Boolean(prior && prior !== currentDigest && content === markdown);
        let fenced = false;
        if (externalChange && priorTicket?.execution) {
          const execution = normalized.ticket.execution;
          const incompatible = normalized.ticket.phase !== priorTicket.phase
            || !execution
            || execution.lease_id !== priorTicket.execution.lease_id
            || execution.phase !== normalized.ticket.phase
            || execution.provider !== requiredProvider(normalized.ticket)
            || (normalized.ticket.status !== "running" && normalized.ticket.status !== "blocked");
          if (incompatible) {
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
    let message = "External file edit accepted; current phase retained.";
    if (fenced) message = "External state edit accepted; incompatible active lease fenced.";
    if (ticket.execution && (ticket.status === "running" || ticket.status === "blocked")) {
      const sequence = ticket.event_sequence;
      ticket.execution.guidance.push({ id: `guidance-${randomUUID()}`, sequence, message: "The authoritative ticket changed. Reread it before continuing.", created_at: now, delivered_at: null });
      message += " Active agent queued to reread the ticket.";
    }
    const nextBody = appendEvent(body, ticket.event_sequence, now, "ticket.external_edited", message);
    const next = serializeDocument(ticket, nextBody);
    await this.atomicReplace(path, await readFile(path, "utf8"), next);
    this.knownDigests.set(path, digest(next));
    this.knownTickets.set(path, structuredClone(ticket));
  }

  private async loadPath(path: string): Promise<LoadedTicket> {
    const markdown = await readFile(path, "utf8");
    const doc = parseDocument(markdown);
    const normalized = normalizeTicket(doc.frontmatter);
    const errors = [...normalized.errors, ...validateSessionInvariant(normalized.ticket)];
    return { path, relativePath: relative(this.root, path), markdown, body: doc.body, frontmatter: normalized.ticket, valid: errors.length === 0, errors };
  }

  async create(markdown: string, filename?: string): Promise<LoadedTicket> {
    return this.serial(async () => {
      const doc = parseDocument(markdown);
      const normalized = normalizeTicket(doc.frontmatter, this.clock().toISOString());
      if (normalized.errors.length) throw new HttpError(422, "Ticket is invalid", normalized.errors);
      const tickets = await this.scanInternal(false);
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
      const content = serializeDocument(ticket, body);
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      this.knownDigests.set(path, digest(content));
      this.knownTickets.set(path, structuredClone(ticket));
      this.emit("changed", { type: "ticket.changed", id: ticket.id, revision: ticket.revision });
      return this.loadPath(path);
    });
  }

  async edit(id: string, markdown: string, expectedRevision: number, mode: "keep_phase" | "rewind", rewindPhase?: Phase): Promise<LoadedTicket> {
    return this.serial(async () => {
      const tickets = await this.scanInternal(false);
      const current = tickets.find((item) => item.frontmatter?.id === id || item.relativePath === id);
      if (!current) throw new HttpError(404, `Ticket ${id} not found`);
      const currentRevision = current.frontmatter?.revision ?? 0;
      if (currentRevision !== expectedRevision) throw new HttpError(409, "Ticket revision changed", current);
      const supplied = parseDocument(markdown);
      const normalized = normalizeTicket(supplied.frontmatter, this.clock().toISOString());
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
        const next = serializeDocument(ticket, body);
        await this.atomicReplace(current.path, current.markdown, next);
        this.knownDigests.set(current.path, digest(next));
        this.knownTickets.set(current.path, structuredClone(ticket));
        this.emit("changed", { type: "ticket.changed", id: ticket.id, revision: ticket.revision });
        return this.loadPath(current.path);
      }
      const validCurrent = current as LoadedTicket & { frontmatter: TicketFrontmatter };
      let next = normalized.ticket;
      next.created_at = validCurrent.frontmatter.created_at;
      next.agents = validCurrent.frontmatter.agents;
      next.attempts = validCurrent.frontmatter.attempts;
      next.pull_requests = validCurrent.frontmatter.pull_requests;
      next.questions = validCurrent.frontmatter.questions;
      next.jira = validCurrent.frontmatter.jira;
      next.archived_at = validCurrent.frontmatter.archived_at;
      next.execution = structuredClone(validCurrent.frontmatter.execution);
      let event = "ticket.edited";
      let eventMessage = "Ticket edited; current phase retained.";
      if (mode === "keep_phase") {
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
          eventMessage = "Ticket edited; current phase retained and active agent asked to reread it.";
        }
      }
      else {
        if (!rewindPhase || rewindPhase === "done") throw new HttpError(422, "An applicable rewind phase is required");
        if (rewindPhase === "specification" && !next.spec_required) throw new HttpError(422, "Specification is not enabled");
        if (rewindPhase === "review" && !next.review_required) throw new HttpError(422, "Review is not enabled");
        event = next.execution ? "ticket.rewind_requested" : "ticket.rewound";
        if (next.execution) {
          if (next.execution.interrupt_request) throw new HttpError(409, "Ticket is already waiting for agent interruption");
          next.execution.interrupt_request = { target_phase: rewindPhase, requested_at: this.clock().toISOString() };
          next.phase = validCurrent.frontmatter.phase;
          next.status = validCurrent.frontmatter.status;
          eventMessage = `Ticket edited; interrupt requested before restarting at ${rewindPhase}.`;
        } else {
          next.phase = rewindPhase;
          next.status = "ready";
          eventMessage = `Ticket edited and rewound to ${rewindPhase}.`;
        }
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
    const next = serializeDocument(ticket, nextBody);
    await this.atomicReplace(current.path, current.markdown, next);
    this.knownDigests.set(current.path, digest(next));
    this.knownTickets.set(current.path, structuredClone(ticket));
    this.emit("changed", { type: "ticket.changed", id: ticket.id, revision: ticket.revision });
    return this.loadPath(current.path);
  }

  private async findValid(id: string): Promise<LoadedTicket & { frontmatter: TicketFrontmatter }> {
    const tickets = await this.scanInternal(false);
    const current = tickets.find((item) => item.frontmatter?.id === id || item.relativePath === id);
    if (!current) throw new HttpError(404, `Ticket ${id} not found`);
    if (!current.valid || !current.frontmatter) throw new HttpError(422, "Ticket is invalid", current.errors);
    return current as LoadedTicket & { frontmatter: TicketFrontmatter };
  }

  async claim(
    supervisorId: string,
    provider: Provider,
    availableProviders: Provider[] = ["claude", "codex"],
    supervisorHost = supervisorId,
  ): Promise<LoadedTicket | null> {
    return this.serial(async () => {
      await this.expireLeasesInternal();
      const tickets = (await this.scanInternal(false)).filter((item): item is LoadedTicket & { frontmatter: TicketFrontmatter } => Boolean(item.valid && item.frontmatter));
      const reservation = tickets.find((item) => item.frontmatter.assigned_supervisor === supervisorId && supervisorReservationActive(item.frontmatter));
      const match = tickets.filter((item) => item.frontmatter.status === "ready"
        && (!reservation || item.frontmatter.id === reservation.frontmatter.id)
        && (item.frontmatter.assigned_supervisor === null || item.frontmatter.assigned_supervisor === supervisorId)
        && (item.frontmatter.assigned_supervisor_host === null || item.frontmatter.assigned_supervisor_host === supervisorHost)
        && (item.frontmatter.assigned_supervisor !== null || canSupervisorOwn(item.frontmatter, availableProviders))
        && !tickets.some((active) => active.frontmatter.id !== item.frontmatter.id
          && supervisorReservationActive(active.frontmatter)
          && active.frontmatter.assigned_supervisor_host === supervisorHost
          && active.frontmatter.repositories.some((repository) => item.frontmatter.repositories.some((candidate) => candidate.id === repository.id)))
        && canProviderClaim(item.frontmatter, provider))
        .sort((a, b) => b.frontmatter.priority - a.frontmatter.priority || a.frontmatter.created_at.localeCompare(b.frontmatter.created_at) || a.frontmatter.id.localeCompare(b.frontmatter.id))[0];
      if (!match) return null;
      const now = this.clock();
      const key = phaseKey(match.frontmatter.phase);
      const lease = randomUUID();
      const ticket = structuredClone(match.frontmatter);
      ticket.assigned_supervisor = supervisorId;
      ticket.assigned_supervisor_host = supervisorHost;
      ticket.status = "running";
      ticket.attempts[key].total += 1;
      ticket.execution = {
        lease_id: lease, supervisor_id: supervisorId, provider, phase: ticket.phase, attempt: ticket.attempts[key].total,
        claimed_at: now.toISOString(), last_heartbeat_at: now.toISOString(), lease_expires_at: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
        observed_herdr_state: null, herdr_observation: null, guidance: [],
        interrupt_request: null,
      };
      ticket.agents[key].provider = provider;
      if (key === "specification" || key === "implementation") {
        ticket.agents.specification.provider = provider;
        ticket.agents.implementation.provider = provider;
      }
      return this.mutateLoaded(match, ticket, match.body, { event: "work.claimed", message: `${provider} claimed ${key} as lease ${lease}.` });
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
  }): Promise<LoadedTicket> {
    const leased = await this.byLease(leaseId);
    return this.command(leased.frontmatter.id, { event: "work.heartbeat", message: "Lease heartbeat accepted.", silent: true }, (ticket) => {
      if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced");
      const now = this.clock();
      if (!ticket.assigned_supervisor_host && observation.supervisorHost) ticket.assigned_supervisor_host = observation.supervisorHost;
      ticket.execution.last_heartbeat_at = now.toISOString();
      ticket.execution.lease_expires_at = new Date(now.getTime() + this.leaseTtlMs).toISOString();
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
      const key = phaseKey(ticket.phase);
      if (observation.paneId !== undefined) ticket.agents[key].herdr_pane_id = observation.paneId;
      if (observation.sessionRef !== undefined) ticket.agents[key].session_ref = observation.sessionRef;
      if (key === "specification" || key === "implementation") {
        ticket.agents.specification = { ...ticket.agents[key] };
        ticket.agents.implementation = { ...ticket.agents[key] };
      }
      if (observation.guidanceCursor !== undefined) {
        for (const item of ticket.execution.guidance) if (item.sequence <= observation.guidanceCursor && !item.delivered_at) item.delivered_at = now.toISOString();
      }
      return { ticket };
    });
  }

  async expireLeases(): Promise<number> { return this.serial(() => this.expireLeasesInternal()); }

  private async expireLeasesInternal(): Promise<number> {
    const tickets = (await this.scanInternal(false)).filter((item): item is LoadedTicket & { frontmatter: TicketFrontmatter } => Boolean(item.valid && item.frontmatter?.execution));
    let count = 0;
    for (const current of tickets) {
      const execution = current.frontmatter.execution;
      if (!execution || Date.parse(execution.lease_expires_at) > this.clock().getTime()) continue;
      const ticket = structuredClone(current.frontmatter);
      if (execution.interrupt_request) {
        ticket.phase = execution.interrupt_request.target_phase;
        ticket.status = "blocked";
        ticket.execution = null;
        await this.mutateLoaded(current, ticket, current.body, {
          event: "work.interrupt_timed_out", message: `Agent interruption was not acknowledged; ${ticket.phase} requires operator attention.`,
        });
        count += 1;
        continue;
      }
      const key = phaseKey(ticket.phase);
      ticket.attempts[key].consecutive_lease_losses += 1;
      ticket.execution = null;
      ticket.status = ticket.attempts[key].consecutive_lease_losses >= 3 ? "blocked" : "ready";
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
