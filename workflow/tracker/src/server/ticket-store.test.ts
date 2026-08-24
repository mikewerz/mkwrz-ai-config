import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { TicketStore } from "./ticket-store.js";
import { ticketMarkdown } from "./test-helpers.js";
import { WorkflowLibrary, initializeWorkflow, transitionTo } from "./workflow-library.js";
import type { HarnessTelemetrySnapshot } from "./domain.js";
import type { Provider, ResolvedAgentProfile, TicketFrontmatter } from "./domain.js";
import type { WorkflowDocument } from "./workflow-library.js";

const cleanup: string[] = [];
async function store(clock?: () => Date, leaseTtlMs = 120_000) {
  const root = await mkdtemp(join(tmpdir(), "agentic-tracker-")); cleanup.push(root);
  const value = new TicketStore(root, { watch: false, leaseTtlMs, ...(clock ? { now: clock } : {}) });
  await value.start();
  return { root, store: value };
}
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

function exhaustedTelemetry(observedAt: string, resetsAt: string): HarnessTelemetrySnapshot {
  return {
    schema_version: 1, harness: "claude", session_ref: "claude-session", observed_at: observedAt,
    source: { kind: "status_line", detail: null }, model: { id: "claude-opus", provider: "anthropic", observed_ids: ["claude-opus"] },
    reasoning: { effort: null, enabled: true, source: "session" }, usage: null,
    cost: { total_usd: null, kind: "unavailable" }, context: { used_tokens: null, window_tokens: null, used_percent: null },
    rate_limits: [{ id: "five_hour", name: "Five hour", used_percent: 100, window_minutes: 300, resets_at: resetsAt }], attributes: {},
  };
}

function resolvedProfiles(document: WorkflowDocument, providers: Record<string, Provider> = { claude: "claude", codex: "codex" }): Record<string, ResolvedAgentProfile> {
  return Object.fromEntries(document.definition.nodes.flatMap((node) => node.type === "agent" && node.agent_profile
    ? [[`${document.definition.id}/${node.id}`, {
      alias: node.agent_profile,
      provider: providers[node.agent_profile] ?? providers.default ?? "claude",
      model: "test-model",
      reasoning: "high",
    } satisfies ResolvedAgentProfile]]
    : []));
}

async function standardWorkflow(context: Awaited<ReturnType<typeof store>>) {
  const workflows = new WorkflowLibrary(context.root);
  context.store.setWorkflowLibrary(workflows);
  return workflows.get("standard-delivery");
}

function assignStandard(
  ticket: TicketFrontmatter,
  document: WorkflowDocument,
  providers: Record<string, Provider> = { claude: "claude", codex: "codex" },
  stageEnabled: Record<string, boolean> = { specification: false, review: false },
) {
  initializeWorkflow(ticket, document, {}, {
    stage_enabled: stageEnabled,
    workflow_revisions: { [document.definition.id]: document.revision },
    resolved_agent_profiles: resolvedProfiles(document, providers),
  });
  ticket.status = "ready";
}

describe("TicketStore", () => {
  it("admits a minimal Markdown ticket and preserves its body", async () => {
    const context = await store();
    await writeFile(join(context.root, "first.md"), ticketMarkdown());
    await context.store.rebuildIndex();
    const [ticket] = await context.store.list();
    expect(ticket?.valid).toBe(true);
    expect(ticket?.frontmatter?.phase).toBe("implementation");
    expect(ticket?.frontmatter?.status).toBe("pending");
    expect(ticket?.frontmatter?.workflow).toBeNull();
    expect(ticket?.markdown).toContain("Complete the requested work.");
    expect(ticket?.markdown).toContain("ticket.admitted");
    await context.store.close();
  });

  it("rejects duplicate ids as a complete set", async () => {
    const context = await store();
    await writeFile(join(context.root, "a.md"), ticketMarkdown());
    await writeFile(join(context.root, "b.md"), ticketMarkdown({ title: "Duplicate" }));
    await context.store.rebuildIndex();
    const tickets = await context.store.list();
    expect(tickets).toHaveLength(2);
    expect(tickets.every((item) => !item.valid)).toBe(true);
    expect(tickets[0]?.errors.join(" ")).toContain("Duplicate id");
    await context.store.close();
  });

  it("atomically routes the workflow-pinned Claude profile and fences concurrent claims", async () => {
    const context = await store();
    const workflow = await standardWorkflow(context);
    await context.store.create(ticketMarkdown());
    const admitted = await context.store.get("APT-0001");
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      assignStandard(ticket, workflow);
      return { ticket };
    });
    const [first, second, wrong] = await Promise.all([
      context.store.claim("worker", "claude"), context.store.claim("worker", "claude"), context.store.claim("worker", "codex"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(wrong).toBeNull();
    expect((first ?? second)?.frontmatter?.execution?.provider).toBe("claude");
    expect(admitted.frontmatter?.revision).toBe(1);
    await context.store.close();
  });

  it("reserves a supervisor that supports every enabled workflow profile", async () => {
    const context = await store();
    const workflow = await standardWorkflow(context);
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      assignStandard(ticket, workflow, { claude: "codex", codex: "claude" }, { specification: false, review: true });
      return { ticket };
    });
    expect(await context.store.claim("worker", "codex", ["codex"])).toBeNull();
    const claimed = await context.store.claim("worker", "codex", ["claude", "codex"]);
    expect(claimed?.frontmatter?.execution?.provider).toBe("codex");
    await context.store.close();
  });

  it("does not reserve a workflow for a supervisor missing an enabled Script runtime", async () => {
    const context = await store();
    const workflows = new WorkflowLibrary(context.root); context.store.setWorkflowLibrary(workflows);
    const definition = {
      version: 2 as const, id: "python-work", name: "Python work", description: "Requires inline Python", start: "work", max_transitions: 5,
      inputs: [], stages: [
        { id: "work", name: "Work", phase: "implementation" as const, skippable: false, default_enabled: true },
        { id: "done", name: "Done", phase: "done" as const, skippable: false, default_enabled: true },
      ],
      nodes: [
        { id: "work", name: "Work", type: "agent" as const, phase: "implementation" as const, stage: "work", prompt: "implementation", agent_profile: "default", conversation_key: "work", outcomes: [{ id: "completed", label: "Complete", description: "Continue.", target: "python" }], choices: [], exit_codes: [] },
        { id: "python", name: "Python", type: "script" as const, phase: "implementation" as const, stage: "work", repository: "primary", inline: { language: "python" as const, code: "print('ok')" }, outcomes: [], choices: [], exit_codes: [{ id: "success", label: "Success", description: "Continue.", target: "done", codes: [0] }, { id: "failure", label: "Failure", description: "Retry.", target: "python", default: true }] },
        { id: "done", name: "Done", type: "terminal" as const, phase: "done" as const, stage: "done", terminal_status: "completed" as const, outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    const document = await workflows.save(stringify(definition));
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      initializeWorkflow(ticket, document, {}, { resolved_agent_profiles: resolvedProfiles(document) }); ticket.status = "ready"; return { ticket };
    });
    expect(await context.store.claim("worker", "claude", ["claude"], "worker", ["repository_action", "inline_shell", "inline_javascript"])).toBeNull();
    expect(await context.store.claim("worker", "claude", ["claude"], "worker", ["repository_action", "inline_shell", "inline_javascript", "inline_python"])).not.toBeNull();
    await context.store.close();
  });

  it("checks pinned child-workflow providers before reserving a supervisor", async () => {
    const context = await store();
    const workflows = new WorkflowLibrary(context.root); context.store.setWorkflowLibrary(workflows);
    const child = await workflows.save(stringify({
      version: 2, id: "codex-child", name: "Codex child", description: "Requires Codex", start: "child-work", max_transitions: 5,
      inputs: [], stages: [
        { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
        { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
      ],
      nodes: [
        { id: "child-work", name: "Child work", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", agent_profile: "child-codex", conversation_key: "child", outcomes: [{ id: "completed", label: "Complete", description: "Finish.", target: "child-done" }] },
        { id: "child-done", name: "Child done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", status_code: 0 },
      ],
    }));
    const parent = await workflows.save(stringify({
      version: 2, id: "claude-parent", name: "Claude parent", description: "Calls Codex", start: "parent-work", max_transitions: 10,
      inputs: [], stages: [
        { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
        { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
      ],
      nodes: [
        { id: "parent-work", name: "Parent work", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", agent_profile: "parent-claude", conversation_key: "parent", outcomes: [{ id: "completed", label: "Complete", description: "Call child.", target: "call-child" }] },
        { id: "call-child", name: "Call child", type: "workflow", phase: "implementation", stage: "work", workflow_id: "codex-child", status_codes: [{ id: "success", label: "Success", description: "Finish.", target: "done", codes: [0] }, { id: "failure", label: "Failure", description: "Retry.", target: "call-child", default: true }] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", status_code: 0 },
      ],
    }));
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      initializeWorkflow(ticket, parent, {}, {
        workflow_revisions: { [child.definition.id]: child.revision },
        resolved_agent_profiles: {
          [`${parent.definition.id}/parent-work`]: { alias: "parent-claude", provider: "claude", model: "test-model", reasoning: "high" },
          [`${child.definition.id}/child-work`]: { alias: "child-codex", provider: "codex", model: "test-model", reasoning: "high" },
        },
      });
      ticket.status = "ready"; return { ticket };
    });
    expect(await context.store.claim("worker", "claude", ["claude"])).toBeNull();
    expect(await context.store.claim("worker", "claude", ["claude", "codex"])).not.toBeNull();
    await context.store.close();
  });

  it("ignores removed ticket-level routing fields instead of migrating them", async () => {
    const context = await store();
    const created = await context.store.create(ticketMarkdown({ work_provider: "claude", review_provider: "codex", spec_required: true }));
    expect(created.frontmatter).not.toHaveProperty("work_provider");
    expect(created.frontmatter).not.toHaveProperty("review_provider");
    expect(created.frontmatter).not.toHaveProperty("spec_required");
    expect(created.frontmatter?.workflow).toBeNull();
    await context.store.close();
  });

  it("requeues two lease losses and blocks the third", async () => {
    let time = Date.parse("2026-08-14T12:00:00Z");
    const context = await store(() => new Date(time), 1_000);
    const workflow = await standardWorkflow(context);
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      assignStandard(ticket, workflow);
      return { ticket };
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await context.store.claim("worker", "claude");
      expect(claimed).not.toBeNull();
      time += 1_001;
      await context.store.expireLeases();
      const ticket = await context.store.get("APT-0001");
      expect(ticket.frontmatter?.status).toBe(attempt === 3 ? "blocked" : "ready");
    }
    await context.store.close();
  });

  it("separates active runtime from a five-hour quota pause and resumes accounting after reset", async () => {
    const started = Date.parse("2026-08-14T12:00:00Z");
    let time = started;
    const context = await store(() => new Date(time));
    const workflow = await standardWorkflow(context);
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      assignStandard(ticket, workflow, { default: "claude", review: "codex" });
      return { ticket };
    });
    const claimed = await context.store.claim("worker", "claude", ["claude", "codex"]);
    const lease = claimed!.frontmatter!.execution!.lease_id;
    const reset = new Date(started + 5 * 60 * 60 * 1_000).toISOString();

    time += 60_000;
    await context.store.heartbeat(lease, { state: "working", telemetry: exhaustedTelemetry(new Date(time).toISOString(), reset) });
    time += 2 * 60 * 60 * 1_000;
    await context.store.heartbeat(lease, { state: "working" });
    time += 3 * 60 * 60 * 1_000;
    const resumed = await context.store.heartbeat(lease, { state: "working" });
    const run = resumed.frontmatter!.workflow!.node_runs.find((candidate) => candidate.lease_id === lease)!;

    expect(run.timing).toMatchObject({ state: "active", active_ms: 2 * 60_000, quota_paused_ms: 299 * 60_000, human_wait_ms: 0, pause_limit_id: null, pause_until: null });
    await context.store.close();
  });

  it("accounts for consecutive lease losses per workflow node", async () => {
    let time = Date.parse("2026-08-14T12:00:00Z");
    const context = await store(() => new Date(time), 1_000);
    const workflows = new WorkflowLibrary(context.root); context.store.setWorkflowLibrary(workflows);
    const definition = {
      version: 2 as const, id: "node-losses", name: "Node losses", description: "Node-scoped retries", start: "first", max_transitions: 10,
      inputs: [], stages: [{ id: "work", name: "Work", phase: "implementation" as const, skippable: false, default_enabled: true }, { id: "done", name: "Done", phase: "done" as const, skippable: false, default_enabled: true }],
      nodes: [
        { id: "first", name: "First", type: "agent" as const, phase: "implementation" as const, stage: "work", prompt: "implementation", agent_profile: "default", conversation_key: "work", outcomes: [{ id: "completed", label: "Complete", description: "Continue.", target: "second" }], choices: [], exit_codes: [] },
        { id: "second", name: "Second", type: "agent" as const, phase: "implementation" as const, stage: "work", prompt: "implementation", agent_profile: "default", conversation_key: "work", outcomes: [{ id: "completed", label: "Complete", description: "Finish.", target: "done" }], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal" as const, phase: "done" as const, stage: "done", terminal_status: "completed" as const, outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    const document = await workflows.save(stringify(definition));
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      initializeWorkflow(ticket, document, {}, { resolved_agent_profiles: resolvedProfiles(document) }); ticket.status = "ready"; return { ticket };
    });
    for (let loss = 0; loss < 2; loss += 1) {
      expect(await context.store.claim("worker", "claude")).not.toBeNull();
      time += 1_001; await context.store.expireLeases();
    }
    await context.store.command("APT-0001", { event: "test.transition", message: "Move to second node" }, (ticket) => {
      transitionTo(ticket, document.definition, "second", { outcome: "test", actor: "test" }); return { ticket };
    });
    expect(await context.store.claim("worker", "claude")).not.toBeNull();
    time += 1_001; await context.store.expireLeases();
    const ticket = await context.store.get("APT-0001");
    expect(ticket.frontmatter).toMatchObject({ status: "ready", workflow: { node_attempts: {
      first: { consecutive_lease_losses: 2 }, second: { consecutive_lease_losses: 1 },
    } } });
    await context.store.close();
  });

  it("keeps V3 current-node and phase projections aligned after an interrupt timeout", async () => {
    let time = Date.parse("2026-08-14T12:00:00Z");
    const context = await store(() => new Date(time), 1_000);
    const workflow = await standardWorkflow(context);
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      assignStandard(ticket, workflow, { default: "claude", review: "codex" }, { specification: false, review: true }); return { ticket };
    });
    const claimed = await context.store.claim("worker", "claude");
    await context.store.command("APT-0001", { event: "test.interrupt", message: "Interrupt" }, (ticket) => {
      ticket.execution!.interrupt_request = {
        target_phase: "review", target_node: "review", target_workflow_id: workflow.definition.id,
        target_workflow_revision: workflow.revision, requested_at: new Date(time).toISOString(),
      };
      return { ticket };
    });
    time += 1_001;
    await context.store.expireLeases();
    const blocked = await context.store.get("APT-0001");
    expect(claimed).not.toBeNull();
    expect(blocked.frontmatter).toMatchObject({
      phase: "review", status: "blocked", execution: null,
      workflow: { current_node: "review", incoming: { source_node: "implementation", target_node: "review", outcome: "operator_interrupt_timeout" } },
    });
    await context.store.close();
  });

  it("records an external content edit and queues an active reread", async () => {
    const context = await store();
    const workflow = await standardWorkflow(context);
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      assignStandard(ticket, workflow); return { ticket };
    });
    const claimed = await context.store.claim("worker", "claude");
    const path = claimed!.path;
    await writeFile(path, (await readFile(path, "utf8")).replace("Complete the requested work.", "Changed while running."));
    await context.store.rebuildIndex();
    const ticket = await context.store.get("APT-0001");
    expect(ticket.markdown).toContain("ticket.external_edited");
    expect(ticket.frontmatter?.execution?.guidance[0]?.message).toContain("Reread");
    await context.store.close();
  });

  it("fences an active lease when an external state edit changes phase", async () => {
    const context = await store();
    const workflow = await standardWorkflow(context);
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      assignStandard(ticket, workflow); return { ticket };
    });
    const claimed = await context.store.claim("worker", "claude");
    const lease = claimed!.frontmatter!.execution!.lease_id;
    await writeFile(claimed!.path, (await readFile(claimed!.path, "utf8")).replace("phase: implementation", "phase: review"));
    await context.store.rebuildIndex();

    const ticket = await context.store.get("APT-0001");
    expect(ticket.frontmatter).toMatchObject({ phase: "review", status: "ready", execution: null });
    expect(ticket.markdown).toContain("incompatible active lease fenced");
    await expect(context.store.heartbeat(lease, { state: "working" })).rejects.toMatchObject({ status: 409 });
    await context.store.close();
  });

  it("keeps an invalid external edit visible but unschedulable", async () => {
    const context = await store();
    const created = await context.store.create(ticketMarkdown());
    await writeFile(created.path, (await readFile(created.path, "utf8")).replace("status: pending", "status: imaginary"));
    await context.store.rebuildIndex();
    const ticket = await context.store.get("APT-0001");
    expect(ticket.valid).toBe(false);
    expect(ticket.errors.join(" ")).toContain("status is not recognized");
    expect(await context.store.claim("worker", "claude")).toBeNull();
    await context.store.close();
  });

  it("pauses scheduling for externally corrupted quality metadata and resumes after correction", async () => {
    // Arrange
    const context = await store();
    const workflow = await standardWorkflow(context);
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => {
      assignStandard(ticket, workflow); return { ticket };
    });
    const path = (await context.store.get("APT-0001")).path;
    const validMarkdown = await readFile(path, "utf8");
    const corruptedArtifact = {
      id: "quality-1", kind: "quality_report", ticket_id: "APT-0001", node_run_id: null,
      filename: "quality.yaml", content_type: "application/yaml", size_bytes: 10, sha256: "a".repeat(64),
      created_at: "2026-08-20T12:00:00.000Z",
      metadata: { quality_report: { schema: "agentic-quality/v1", name: "Quality", artifact_name: "quality", registry_revision: 1, overall_status: "pass", subject: {}, producer: {}, attributes: [{ key: "tests.count", label: "Tests", value: "12", type: "number", unit: "count", direction: "higher_is_better", target: null, status: "pass", registered: true }] } },
    };

    // Act
    await writeFile(path, validMarkdown.replace("artifacts: []", `artifacts: ${JSON.stringify([corruptedArtifact])}`));
    await context.store.rebuildIndex();
    const invalid = await context.store.get("APT-0001");
    const claimWhileInvalid = await context.store.claim("worker", "claude");
    await writeFile(path, validMarkdown);
    await context.store.rebuildIndex();
    const repaired = await context.store.get("APT-0001");
    const claimAfterRepair = await context.store.claim("worker", "claude");

    // Assert
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toContain("quality report artifact quality-1 has invalid normalized metadata");
    expect(claimWhileInvalid).toBeNull();
    expect(repaired.valid).toBe(true);
    expect(claimAfterRepair?.frontmatter?.id).toBe("APT-0001");
    await context.store.close();
  });

  it("repairs a syntax-invalid ticket through its relative path locator", async () => {
    const context = await store();
    await writeFile(join(context.root, "broken.md"), "not a ticket\n");
    await context.store.rebuildIndex();
    const [invalid] = await context.store.summaries();
    expect(invalid).toMatchObject({ id: "broken.md", valid: false, revision: 0 });
    const repaired = await context.store.edit("broken.md", ticketMarkdown(), 0);
    expect(repaired.valid).toBe(true);
    expect(repaired.frontmatter).toMatchObject({ id: "APT-0001", revision: 1 });
    expect(repaired.markdown).toContain("ticket.corrected");
    await context.store.close();
  });

  it("serves the Markdown-derived index until an explicit rebuild reconciles external edits", async () => {
    // Arrange
    const context = await store();
    const created = await context.store.create(ticketMarkdown({ title: "Before external edit" }));
    const originalGeneration = (await context.store.operationalStatus()).index_generation;

    // Act
    await writeFile(created.path, created.markdown.replace("Before external edit", "After external edit"));
    const cached = await context.store.get("APT-0001");
    await context.store.rebuildIndex();
    const reconciled = await context.store.get("APT-0001");
    const status = await context.store.operationalStatus();

    // Assert
    expect(cached.frontmatter?.title).toBe("Before external edit");
    expect(reconciled.frontmatter?.title).toBe("After external edit");
    expect(status).toMatchObject({ writable: true, ticket_count: 1, valid_tickets: 1, invalid_tickets: 0 });
    expect(status.index_generation).toBe(originalGeneration + 1);
    expect(status.index_rebuilt_at).toEqual(expect.any(String));
    await context.store.close();
  });

  it("settles metadata branches, durable fan-out joins, and a nested workflow status", async () => {
    const context = await store();
    const workflows = new WorkflowLibrary(context.root); context.store.setWorkflowLibrary(workflows);
    const child = await workflows.save(stringify({
      version: 2, id: "child-check", name: "Child check", description: "Returns a typed status.", start: "returned",
      max_transitions: 10, inputs: [], stages: [{ id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true }],
      nodes: [{ id: "returned", name: "Returned", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", status_code: 7, outcomes: [], choices: [], exit_codes: [] }],
    }));
    const rootWorkflow = await workflows.save(stringify({
      version: 2, id: "data-flow", name: "Data flow", description: "Exercises automatic data-flow nodes.", start: "seed",
      max_transitions: 30, inputs: [], stages: [
        { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
        { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
      ],
      nodes: [
        { id: "seed", name: "Seed", type: "write", phase: "implementation", stage: "work", metadata_key: "deploy", metadata_value: "yes", next: "route", outcomes: [], choices: [], exit_codes: [] },
        { id: "route", name: "Route", type: "read", phase: "implementation", stage: "work", metadata_key: "deploy", metadata_cases: [
          { id: "yes", label: "Yes", description: "Deploy is enabled.", target: "split", equals: "yes" },
          { id: "default", label: "Default", description: "Deploy is disabled.", target: "done", default: true },
        ], outcomes: [], choices: [], exit_codes: [] },
        { id: "split", name: "Split", type: "fan_out", phase: "implementation", stage: "work", fan_in: "join", branches: [
          { id: "a", label: "A", description: "First branch.", target: "branch-a" },
          { id: "b", label: "B", description: "Second branch.", target: "branch-b" },
        ], outcomes: [], choices: [], exit_codes: [] },
        { id: "branch-a", name: "Branch A", type: "write", phase: "implementation", stage: "work", metadata_key: "branch_a", metadata_value: true, next: "join", outcomes: [], choices: [], exit_codes: [] },
        { id: "branch-b", name: "Branch B", type: "write", phase: "implementation", stage: "work", metadata_key: "branch_b", metadata_value: true, next: "join", outcomes: [], choices: [], exit_codes: [] },
        { id: "join", name: "Join", type: "fan_in", phase: "implementation", stage: "work", next: "child", outcomes: [], choices: [], exit_codes: [] },
        { id: "child", name: "Child", type: "workflow", phase: "implementation", stage: "work", workflow_id: "child-check", status_codes: [
          { id: "seven", label: "Seven", description: "Expected child result.", target: "done", codes: [7] },
          { id: "default", label: "Default", description: "Unexpected child result.", target: "done", default: true },
        ], outcomes: [], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", status_code: 0, outcomes: [], choices: [], exit_codes: [] },
      ],
    }));
    await context.store.create(ticketMarkdown());
    await context.store.command("APT-0001", { event: "test.workflow", message: "Workflow" }, (ticket) => {
      initializeWorkflow(ticket, rootWorkflow, {}, { workflow_revisions: { [child.definition.id]: child.revision } });
      ticket.status = "ready"; return { ticket };
    });
    const settled = await context.store.settleAutomatic("APT-0001");
    expect(settled.frontmatter).toMatchObject({
      phase: "done", status: "completed", metadata: { deploy: "yes", branch_a: true, branch_b: true },
      workflow: { id: "data-flow", active_workflow_id: "data-flow", current_node: "done", workflow_stack: [], fan_out_stack: [] },
    });
    expect(settled.frontmatter?.workflow?.incoming).toMatchObject({ source_node: "child", outcome: "seven" });
    await context.store.close();
  });
});
