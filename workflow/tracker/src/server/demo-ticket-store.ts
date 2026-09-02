import type { DemoConfig } from "./config-store.js";
import { HttpError, type LoadedTicket, type PullRequestRef, type TicketFrontmatter, type TicketSummary, type WorkflowTransitionContext } from "./domain.js";
import { appendEvent, serializeDocument } from "./markdown.js";
import {
  WorkflowLibrary,
  activeWorkflowIdentity,
  advanceWorkflow,
  beginNodeRun,
  enterCurrentNode,
  finishNodeRun,
  nodeAttemptCounter,
  resolveNodeProvider,
  runtimeNodeKey,
  transitionTo,
  workflowNode,
  workflowRoutes,
  type WorkflowDocument,
  type WorkflowNode,
  type WorkflowOutcome,
} from "./workflow-library.js";

export const DEMO_TICKET_ID = /^DEMO-\d{4}$/;

interface DemoRecord {
  ticket: TicketFrontmatter;
  body: string;
}

type Timer = ReturnType<typeof setTimeout>;

function successfulRoute(routes: WorkflowOutcome[]): WorkflowOutcome | undefined {
  const successful = routes.filter((route) => route.metric_class === "success");
  return successful.length === 1 ? successful[0] : undefined;
}

/** Selects a deterministic showcase route without guessing from human-readable labels. */
export function demoRoute(node: WorkflowNode): WorkflowOutcome | undefined {
  const routes = workflowRoutes(node);
  const explicit = successfulRoute(routes);
  if (explicit) return explicit;
  if (["script", "checkpoint", "restore_checkpoint"].includes(node.type)) {
    const zero = routes.find((route) => Array.isArray((route as WorkflowOutcome & { codes?: number[] }).codes)
      && (route as WorkflowOutcome & { codes?: number[] }).codes!.includes(0));
    if (zero) return zero;
  }
  if (node.type === "workflow") {
    const zero = routes.find((route) => Array.isArray((route as WorkflowOutcome & { codes?: number[] }).codes)
      && (route as WorkflowOutcome & { codes?: number[] }).codes!.includes(0));
    if (zero) return zero;
  }
  return routes[0];
}

function cloneLoaded(record: DemoRecord): LoadedTicket {
  const ticket = structuredClone(record.ticket);
  return {
    path: `memory://demo/${ticket.id}`,
    relativePath: `${ticket.id}.md`,
    markdown: serializeDocument(ticket, record.body),
    body: record.body,
    frontmatter: ticket,
    valid: true,
    errors: [],
  };
}

function addSimulatedPullRequests(ticket: TicketFrontmatter, node: WorkflowNode): void {
  if (node.phase !== "specification" && node.phase !== "implementation" && node.phase !== "review") return;
  for (const repository of ticket.repositories) {
    const url = `demo://pull-request/${encodeURIComponent(ticket.id)}/${encodeURIComponent(repository.id)}/${node.phase}`;
    if (ticket.pull_requests.some((pullRequest) => pullRequest.url === url)) continue;
    ticket.pull_requests.push({ repository: repository.id, url, phase: node.phase } satisfies PullRequestRef);
  }
}

export class DemoTicketStore {
  private readonly records = new Map<string, DemoRecord>();
  private readonly timers = new Map<string, Timer>();
  private queue: Promise<unknown> = Promise.resolve();
  private config: DemoConfig = { enabled: false, step_duration_seconds: 10 };

  constructor(
    private readonly workflows: WorkflowLibrary,
    private readonly changed: (id?: string) => void,
    private readonly clock = () => new Date(),
  ) {}

  configure(config: DemoConfig): void {
    this.config = structuredClone(config);
    if (!config.enabled) this.clear();
  }

  enabled(): boolean { return this.config.enabled; }
  has(id: string): boolean { return this.records.has(id); }

  clear(): number {
    const count = this.records.size;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.records.clear();
    if (count) this.changed();
    return count;
  }

  nextId(existingIds: Iterable<string> = []): string {
    const existing = new Set([...existingIds, ...this.records.keys()]);
    let number = 1;
    while (existing.has(`DEMO-${String(number).padStart(4, "0")}`)) number += 1;
    return `DEMO-${String(number).padStart(4, "0")}`;
  }

  async create(ticket: TicketFrontmatter, body: string, workflow: WorkflowDocument): Promise<LoadedTicket> {
    return this.serial(async () => {
      if (!this.config.enabled) throw new HttpError(409, "Demo mode is disabled", undefined, "DEMO_MODE_DISABLED");
      if (!DEMO_TICKET_ID.test(ticket.id)) throw new HttpError(422, "Demo ticket IDs must match DEMO-xxxx", undefined, "DEMO_ID_INVALID");
      if (this.records.has(ticket.id)) throw new HttpError(409, `Demo ticket ${ticket.id} already exists`, undefined, "DEMO_TICKET_EXISTS");
      ticket.demo = true;
      ticket.status = "ready";
      ticket.assigned_supervisor = null;
      ticket.assigned_supervisor_host = null;
      ticket.execution = null;
      enterCurrentNode(ticket, workflow.definition, true);
      const record = { ticket, body };
      this.records.set(ticket.id, record);
      this.commit(record, "demo.created", "Tracker-only demo ticket started. No provider, repository, integration, or durable ticket storage will be used.");
      await this.pump(record);
      return cloneLoaded(record);
    });
  }

  async get(id: string): Promise<LoadedTicket> {
    return this.serial(async () => {
      const record = this.records.get(id);
      if (!record) throw new HttpError(404, `Demo ticket ${id} not found`);
      return cloneLoaded(record);
    });
  }

  async list(): Promise<LoadedTicket[]> {
    return this.serial(async () => [...this.records.values()].map(cloneLoaded));
  }

  async summaries(): Promise<TicketSummary[]> {
    return this.serial(async () => Promise.all([...this.records.values()].map(async ({ ticket }) => {
        const identity = activeWorkflowIdentity(ticket);
        const definition = (await this.workflows.get(identity.id, identity.revision)).definition;
        const node = workflowNode(definition, ticket.workflow!.current_node);
        const gate = ticket.status === "waiting_approval" && node.type === "human_gate";
        return {
          id: ticket.id, demo: true, title: ticket.title, phase: ticket.phase, status: ticket.status,
          priority: ticket.priority, provider: resolveNodeProvider(ticket, node), revision: ticket.revision,
          created_at: ticket.created_at, updated_at: ticket.updated_at, valid: true, errors: [],
          path: `memory://demo/${ticket.id}`, claim_blockers: [], archived_at: null,
          production_result: ticket.production_result, workflow_id: ticket.workflow?.id ?? null,
          workflow_node_id: node.id, workflow_node_name: node.name,
          workflow_stage_name: definition.stages.find((stage) => stage.id === node.stage)?.name ?? node.stage,
          labels: ticket.labels, repositories: ticket.repositories.map((repository) => repository.id),
          assigned_supervisor: null, estimated_human_days: ticket.estimated_human_days,
          attention: {
            kinds: gate ? ["human_gate"] : [], pending_questions: 0,
            wait_wake_at: null, wait_deadline_at: null, delivery_failure_summary: null, github_feedback_summary: null,
          },
        };
      })));
  }

  async decide(id: string, decision: string, note: string, expectedRevision?: number): Promise<LoadedTicket> {
    return this.serial(async () => {
      const record = this.required(id, expectedRevision);
      const ticket = record.ticket;
      const identity = activeWorkflowIdentity(ticket);
      const definition = (await this.workflows.get(identity.id, identity.revision)).definition;
      const node = workflowNode(definition, ticket.workflow!.current_node);
      if (node.type !== "human_gate" || ticket.status !== "waiting_approval") throw new HttpError(409, "Demo ticket is not waiting at a human gate");
      const choice = node.choices.find((candidate) => candidate.id === decision);
      if (!choice) throw new HttpError(422, `Decision ${decision} is not allowed`, { allowed: node.choices.map((candidate) => candidate.id) });
      if (choice.comment_required && !note) throw new HttpError(422, `${choice.label} requires a comment`);
      const now = this.clock().toISOString();
      const run = beginNodeRun(ticket, node, identity.revision, 1, ticket.workflow!.current_node_entered_at, "demo-simulator", null);
      finishNodeRun(ticket, run.id, decision, note || choice.label, null, now, note || null);
      advanceWorkflow(ticket, definition, decision, note || choice.label, note || null, "human");
      this.commit(record, "demo.gate_decided", `${node.name}: ${note || choice.label}`);
      await this.pump(record);
      return cloneLoaded(record);
    });
  }

  async terminate(id: string, status: "cancelled" | "failed", reason: string, expectedRevision?: number): Promise<LoadedTicket> {
    return this.serial(async () => {
      const record = this.required(id, expectedRevision);
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
      const running = record.ticket.workflow?.node_runs.findLast((run) => run.status === "running");
      if (running) {
        running.status = "interrupted";
        running.completed_at = this.clock().toISOString();
        running.outcome = "cancelled";
        running.summary = reason;
      }
      record.ticket.status = status;
      record.ticket.phase = "done";
      this.commit(record, `demo.${status}`, reason);
      return cloneLoaded(record);
    });
  }

  private required(id: string, expectedRevision?: number): DemoRecord {
    const record = this.records.get(id);
    if (!record) throw new HttpError(404, `Demo ticket ${id} not found`);
    if (expectedRevision !== undefined && record.ticket.revision !== expectedRevision) {
      throw new HttpError(409, "Demo ticket revision changed", cloneLoaded(record));
    }
    return record;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private commit(record: DemoRecord, event: string, message: string): void {
    const now = this.clock().toISOString();
    record.ticket.revision += 1;
    record.ticket.event_sequence += 1;
    record.ticket.updated_at = now;
    record.body = appendEvent(record.body, record.ticket.event_sequence, now, event, message);
    this.changed(record.ticket.id);
  }

  private delayed(node: WorkflowNode): boolean {
    return ["agent", "script", "checkpoint", "restore_checkpoint"].includes(node.type);
  }

  private schedule(record: DemoRecord, runId: string): void {
    const id = record.ticket.id;
    const timer = setTimeout(async () => {
      this.timers.delete(id);
      await this.serial(async () => this.completeDelayed(id, runId));
    }, this.config.step_duration_seconds * 1_000);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private async completeDelayed(id: string, runId: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || !this.config.enabled) return;
    const ticket = record.ticket;
    const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === runId && candidate.status === "running");
    if (!run || !ticket.workflow || ticket.workflow.current_node !== run.node_id) return;
    const identity = activeWorkflowIdentity(ticket);
    const definition = (await this.workflows.get(identity.id, identity.revision)).definition;
    const node = workflowNode(definition, run.node_id);
    const route = demoRoute(node);
    if (!route) {
      ticket.status = "blocked";
      this.commit(record, "demo.blocked", `${node.name} has no route to simulate.`);
      return;
    }
    const now = this.clock().toISOString();
    const summary = `Simulated ${node.name} completed through ${route.label}.`;
    addSimulatedPullRequests(ticket, node);
    finishNodeRun(ticket, run.id, route.id, summary, null, now, summary);
    advanceWorkflow(ticket, definition, route.id, summary, summary, "demo-simulator");
    this.commit(record, "demo.node_completed", summary);
    await this.pump(record);
  }

  private async pump(record: DemoRecord): Promise<void> {
    const ticket = record.ticket;
    if (!ticket.workflow || ["completed", "failed", "cancelled"].includes(ticket.status)) return;
    for (let step = 0; step < 100; step += 1) {
      const identity = activeWorkflowIdentity(ticket);
      const definition = (await this.workflows.get(identity.id, identity.revision)).definition;
      const node = workflowNode(definition, ticket.workflow.current_node);

      if (node.type === "terminal" && (ticket.workflow.workflow_stack?.length ?? 0) > 0) {
        const frame = ticket.workflow.workflow_stack!.pop()!;
        const parent = (await this.workflows.get(frame.workflow_id, frame.workflow_revision)).definition;
        const callNode = workflowNode(parent, frame.call_node_id);
        const statusCode = node.status_code ?? (node.terminal_status === "completed" ? 0 : 1);
        const route = demoRoute(callNode);
        ticket.workflow.active_workflow_id = frame.workflow_id;
        ticket.workflow.active_workflow_revision = frame.workflow_revision;
        ticket.workflow.current_node = frame.call_node_id;
        if (!route) {
          ticket.status = "blocked";
          this.commit(record, "demo.blocked", `${callNode.name} has no status route to simulate.`);
          return;
        }
        transitionTo(ticket, parent, route.target, {
          outcome: route.id, summary: `Simulated child workflow returned status code ${statusCode}.`,
          actor: "demo-simulator", source_node: callNode.id,
        });
        continue;
      }
      if (node.type === "terminal") {
        this.commit(record, "demo.completed", `Demo workflow reached ${node.name} with status ${ticket.status}.`);
        return;
      }
      if (node.type === "human_gate") {
        ticket.status = "waiting_approval";
        this.commit(record, "demo.gate_waiting", `Demo paused for operator decision at ${node.name}.`);
        return;
      }
      if (this.delayed(node)) {
        const existing = ticket.workflow.node_runs.findLast((run) => run.node_id === node.id && run.status === "running");
        if (existing) return;
        const attempts = nodeAttemptCounter(ticket, node.id);
        attempts.total += 1;
        const now = this.clock().toISOString();
        const run = beginNodeRun(ticket, node, identity.revision, attempts.total, now, "demo-simulator", resolveNodeProvider(ticket, node));
        ticket.status = "running";
        this.commit(record, "demo.node_started", `Simulating ${node.name}; configured duration is approximately ${this.config.step_duration_seconds} seconds.`);
        this.schedule(record, run.id);
        return;
      }
      if (node.type === "read") {
        const route = demoRoute(node);
        if (!route) { ticket.status = "blocked"; this.commit(record, "demo.blocked", `${node.name} has no metadata route to simulate.`); return; }
        const matched = node.metadata_cases?.find((candidate) => candidate.id === route.id);
        if (matched && "equals" in matched && node.metadata_key) {
          ticket.metadata ??= {};
          ticket.metadata[node.metadata_key] = structuredClone(matched.equals ?? null);
        }
        transitionTo(ticket, definition, route.target, { outcome: route.id, summary: `Demo metadata selected ${route.label}.`, actor: "demo-simulator", source_node: node.id });
        continue;
      }
      if (node.type === "write") {
        ticket.metadata ??= {};
        ticket.metadata[node.metadata_key!] = structuredClone(node.metadata_value ?? null);
        transitionTo(ticket, definition, node.next!, { outcome: "completed", summary: `Demo metadata ${node.metadata_key} was updated.`, actor: "demo-simulator", source_node: node.id });
        continue;
      }
      if (node.type === "fan_out") {
        const branches = node.branches ?? [];
        if (!branches.length) { ticket.status = "blocked"; this.commit(record, "demo.blocked", `${node.name} has no fan-out branches.`); return; }
        ticket.workflow.fan_out_stack ??= [];
        ticket.workflow.fan_out_stack.push({
          workflow_id: identity.id, workflow_revision: identity.revision, fan_out_node_id: node.id,
          fan_in_node_id: node.fan_in!, pending_targets: branches.slice(1).map((branch) => branch.target), inputs: [],
          source: ticket.workflow.incoming ? structuredClone(ticket.workflow.incoming) : null,
        });
        const first = branches[0]!;
        transitionTo(ticket, definition, first.target, { outcome: first.id, summary: `Demo fan-out started ${branches.length} branches.`, actor: "demo-simulator", source_node: node.id });
        continue;
      }
      if (node.type === "fan_in") {
        const stack = ticket.workflow.fan_out_stack ?? [];
        const frameIndex = stack.findLastIndex((frame) => frame.workflow_id === identity.id && frame.fan_in_node_id === node.id);
        if (frameIndex < 0) { ticket.status = "blocked"; this.commit(record, "demo.blocked", `${node.name} has no active fan-out.`); return; }
        const frame = stack[frameIndex]!;
        if (ticket.workflow.incoming) frame.inputs.push(structuredClone(ticket.workflow.incoming));
        const nextBranch = frame.pending_targets.shift();
        if (nextBranch) {
          const key = runtimeNodeKey(ticket, node.id);
          ticket.workflow.node_visits[key] = Math.max(0, (ticket.workflow.node_visits[key] ?? 1) - 1);
          const now = this.clock().toISOString();
          ticket.workflow.current_node = nextBranch;
          ticket.workflow.current_node_entered_at = now;
          ticket.workflow.transition_count += 1;
          ticket.workflow.incoming = {
            source_node: frame.fan_out_node_id, target_node: nextBranch, outcome: "fanout_branch",
            summary: frame.source?.summary ?? "Continuing demo fan-out branch.", handoff: frame.source?.handoff ?? null,
            output: frame.source?.output ?? null, output_log_path: frame.source?.output_log_path ?? null,
            actor: "demo-simulator", created_at: now,
          } satisfies WorkflowTransitionContext;
          enterCurrentNode(ticket, definition, true);
        } else {
          stack.splice(frameIndex, 1);
          transitionTo(ticket, definition, node.next!, { outcome: "completed", summary: `Demo fan-in merged ${frame.inputs.length} branches.`, actor: "demo-simulator", source_node: node.id });
        }
        continue;
      }
      if (node.type === "workflow") {
        const childRevision = ticket.workflow.workflow_revisions?.[node.workflow_id!];
        const child = await this.workflows.get(node.workflow_id!, childRevision);
        ticket.workflow.workflow_stack ??= [];
        ticket.workflow.workflow_stack.push({ workflow_id: identity.id, workflow_revision: identity.revision, call_node_id: node.id });
        ticket.workflow.active_workflow_id = child.definition.id;
        ticket.workflow.active_workflow_revision = child.revision;
        ticket.workflow.current_node = child.definition.start;
        ticket.workflow.current_node_entered_at = this.clock().toISOString();
        ticket.workflow.transition_count += 1;
        enterCurrentNode(ticket, child.definition, true);
        continue;
      }
      const route = demoRoute(node);
      if (!route) { ticket.status = "blocked"; this.commit(record, "demo.blocked", `${node.name} has no route to simulate.`); return; }
      transitionTo(ticket, definition, route.target, { outcome: route.id, summary: `Demo selected ${route.label}.`, actor: "demo-simulator", source_node: node.id });
    }
    ticket.status = "blocked";
    this.commit(record, "demo.blocked", "Demo automatic transition limit was reached.");
  }
}
