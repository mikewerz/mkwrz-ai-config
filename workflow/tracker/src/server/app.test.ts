import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { HarnessTelemetrySnapshot } from "./domain.js";
import { TicketStore } from "./ticket-store.js";
import { ticketMarkdown } from "./test-helpers.js";
import { stringify } from "yaml";
import { TrackerConfigStore } from "./config-store.js";

let root: string;
let store: TicketStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentic-api-"));
  store = new TicketStore(root, { watch: false });
  await store.start();
  const configs = new TrackerConfigStore(root);
  const config = await configs.start();
  await configs.update({
    providers: config.providers,
    agent_profiles: {
      default: "claude",
      profiles: [
        { id: "claude", label: "Claude work", provider: "claude", model: "test-model", reasoning: "high" },
        { id: "codex", label: "Codex review", provider: "codex", model: "test-review-model", reasoning: "high" },
      ],
    },
    repositories: config.repositories,
    jira: config.jira,
    github: config.github,
  }, config.revision);
});
afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

function telemetry(totalTokens: number, totalUsd: number): HarnessTelemetrySnapshot {
  return {
    schema_version: 1, harness: "claude", session_ref: "claude-session", observed_at: "2026-08-18T12:00:00.000Z",
    source: { kind: "session_log", detail: "claude-session.jsonl" },
    model: { id: "claude-sonnet-4-5", provider: "anthropic", observed_ids: ["claude-sonnet-4-5"] },
    reasoning: { effort: "high", enabled: true, source: "session" },
    usage: { input_tokens: totalTokens - 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: totalTokens },
    cost: { total_usd: totalUsd, kind: "reported" },
    context: { used_tokens: 20, window_tokens: 100_000, used_percent: 0.02 }, rate_limits: [],
    attributes: { cli_version: "test" },
  };
}

describe("health endpoint", () => {
  it("returns service status", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.status).toBe("ok");
  });

  it("reports uptime and memory usage", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body).toMatchObject({
      status: "ok",
      uptime_seconds: expect.any(Number),
      memory_usage: {
        heap_used: expect.any(Number),
        heap_total: expect.any(Number),
        external: expect.any(Number),
      },
      node: expect.stringContaining("v"),
      platform: expect.any(String),
      arch: expect.any(String),
      server_time: expect.any(String),
    });
  });

  it("publishes the supervisor protocol and supported deterministic capabilities", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));

    // Act
    const capabilities = await request(app).get("/api/capabilities").expect(200);

    // Assert
    expect(capabilities.body).toEqual({
      supervisor_protocol_versions: [1, 2, 3],
      workflow_schema_versions: [2],
      intake_protocol_versions: [1],
      activity_capabilities: [
        "repository_action", "inline_shell", "inline_javascript", "inline_python", "git_checkpoint", "git_restore",
      ],
    });
  });

  it("reports correct server time", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const health = await request(app).get("/api/health").expect(200);
    expect(new Date(health.body.server_time).toISOString()).toBe(health.body.server_time);
  });

  it("reports operational readiness and the Markdown-derived ticket index", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    await store.create(ticketMarkdown());

    // Act
    const readiness = await request(app).get("/api/readyz").expect(200);
    const operations = await request(app).get("/api/operations").expect(200);

    // Assert
    expect(readiness.body).toMatchObject({
      status: "ready", ready: true, failures: [],
      ticket_store: { writable: true, ticket_count: 1, valid_tickets: 1, invalid_tickets: 0, index_generation: expect.any(Number) },
      background_operations: {
        github_observation: { in_progress: false },
        artifact_maintenance: { in_progress: false },
        intake_scheduling: { in_progress: false },
      },
    });
    expect(operations.body.checked_at).toEqual(expect.any(String));
    expect(operations.body.libraries).toMatchObject({ prompts: expect.any(Number), workflows: expect.any(Number) });
  });
});

describe("tracker API", () => {
  it("admits external intake candidates as ordinary workflow tickets with durable origin metadata", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    const campaign = stringify({
      version: 1, id: "improve-demo", name: "Improve demo", description: "Continuous improvement.", enabled: true,
      limits: { max_new_per_run: 100, max_new_per_day: 100, max_open: 50, max_working: 10, max_observed_unarchived: 100 }, success_policy: {},
    });
    await request(app).put("/api/intake/campaigns/improve-demo").send({ content: campaign }).expect(200);
    const source = stringify({
      version: 1, id: "new-relic", name: "New Relic", description: "Performance findings.", enabled: true, campaign_id: "improve-demo",
      schedule: { interval_minutes: 60 }, runner: { type: "external" },
      ticket: { workflow_id: "standard-delivery", repositories: [{ id: "demo", primary: true }], labels: ["performance"], priority: 2, mark_ready: false, workflow_inputs: {}, stage_enabled: { specification: false, review: false } },
      limits: { max_new_per_run: 3, max_new_per_day: 20, max_open: 20, max_working: 5, max_observed_unarchived: 30 },
    });
    await request(app).put("/api/intake/sources/new-relic").send({ content: source }).expect(200);

    // Execute
    const first = await request(app).post("/api/intake/sources/new-relic/candidates").send({ candidates: [{ external_key: "NR-42", title: "Reduce p95", description: "Reduce the checkout p95 latency.", metadata: { "new_relic.issue_url": "https://example.invalid/issues/42" } }] }).expect(201);
    const second = await request(app).post("/api/intake/sources/new-relic/candidates").send({ candidates: [{ external_key: "NR-42", title: "Reduce p95", description: "Observed again." }] }).expect(201);
    const ticket = await request(app).get(`/api/tickets/${first.body.candidates[0].ticket_id}`).expect(200);

    // Verify
    expect(first.body.candidates[0]).toMatchObject({ decision: "admitted", ticket_id: expect.stringMatching(/^AGENT-\d{4}$/) });
    expect(second.body.candidates[0]).toMatchObject({ decision: "duplicate", ticket_id: first.body.candidates[0].ticket_id, observation_count: 2 });
    expect(ticket.body.frontmatter).toMatchObject({
      title: "Reduce p95", priority: 2, labels: ["performance"], status: "pending",
      metadata: { "intake.source_id": "new-relic", "intake.campaign_id": "improve-demo", "intake.external_key": "NR-42", "new_relic.issue_url": "https://example.invalid/issues/42" },
      workflow_assignment: { workflow_id: "standard-delivery" },
    });
    expect(ticket.body.body).toContain("Reduce the checkout p95 latency.");
  }, 15_000);

  it("keeps published trials separate from the default and pins assignment provenance", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const current = await request(app).get("/api/workflows/standard-delivery").expect(200);
    const definition = structuredClone(current.body.workflow.definition);
    definition.description = "Trial workflow revision.";
    const trial = await request(app).put("/api/workflows/standard-delivery").send({
      expected_revision: current.body.workflow.revision, content: stringify(definition), make_default: false, label: "Faster trial",
    }).expect(200);
    const releases = await request(app).get("/api/workflow-releases").expect(200);
    expect(releases.body.releases.find((release: { revision: string }) => release.revision === trial.body.workflow.revision)).toMatchObject({ label: "Faster trial", status: "trial", is_default: false });

    const defaultTicket = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "APT-DEFAULT" }), workflow_id: "standard-delivery" }).expect(201);
    expect(defaultTicket.body.frontmatter.workflow_assignment).toMatchObject({ revision: current.body.workflow.revision, selection: "default" });
    const trialTicket = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "APT-TRIAL" }), workflow_id: "standard-delivery", workflow_revision: trial.body.workflow.revision }).expect(201);
    expect(trialTicket.body.frontmatter.workflow_assignment).toMatchObject({ revision: trial.body.workflow.revision, selection: "manual_trial", version: 2 });

    const migratedToDefault = await request(app).post("/api/tickets/APT-TRIAL/workflow/migrate").send({
      expected_revision: trialTicket.body.frontmatter.revision, workflow_id: "standard-delivery", node_id: "implementation",
    }).expect(200);
    expect(migratedToDefault.body.frontmatter.workflow.revision).toBe(current.body.workflow.revision);
    const migratedToTrial = await request(app).post("/api/tickets/APT-DEFAULT/workflow/migrate").send({
      expected_revision: defaultTicket.body.frontmatter.revision, workflow_id: "standard-delivery",
      workflow_revision: trial.body.workflow.revision, node_id: "implementation",
    }).expect(200);
    expect(migratedToTrial.body.frontmatter.workflow.revision).toBe(trial.body.workflow.revision);

    await request(app).post(`/api/workflows/standard-delivery/revisions/${trial.body.workflow.revision}/promote`).send({}).expect(200);
    const promotedTicket = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "APT-PROMOTED" }), workflow_id: "standard-delivery" }).expect(201);
    expect(promotedTicket.body.frontmatter.workflow_assignment).toMatchObject({ revision: trial.body.workflow.revision, selection: "default" });
  }, 15_000);

  it("exports and imports an exact workflow revision with every referenced prompt revision", async () => {
    // Arrange a shareable workflow whose implementation prompt differs from a
    // fresh install, then export the immutable workflow release.
    const sourceApp = createApp(store, join(root, "missing-client"));
    const implementation = (await request(sourceApp).get("/api/prompts").expect(200)).body.prompts.find((prompt: { name: string }) => prompt.name === "implementation");
    const portablePrompt = "Portable implementation instructions.\n\nAllowed outcomes:\n\n{{allowed_outcomes}}\n";
    const updatedPrompt = await request(sourceApp).put("/api/prompts/implementation").send({
      expected_revision: implementation.revision, content: portablePrompt,
    }).expect(200);
    const standard = (await request(sourceApp).get("/api/workflows/standard-delivery").expect(200)).body.workflow;
    const portableDefinition = structuredClone(standard.definition);
    portableDefinition.id = "portable-delivery";
    portableDefinition.name = "Portable delivery";
    const portable = await request(sourceApp).post("/api/workflows").send({ content: stringify(portableDefinition), label: "Team baseline" }).expect(201);

    // Execute the export.
    const exported = await request(sourceApp)
      .get(`/api/workflows/portable-delivery/revisions/${portable.body.workflow.revision}/export`)
      .expect("Content-Type", /json/).expect(200);

    // Verify the bundle is self-describing and carries exact prompt bytes.
    expect(exported.headers["content-disposition"]).toBe("attachment; filename=\"portable-delivery-v1.workflow.json\"");
    expect(exported.body).toMatchObject({
      schema: "agentic-project-tracker/workflow-bundle/v1",
      workflow: { id: "portable-delivery", revision: portable.body.workflow.revision, version: 1, label: "Team baseline" },
      requirements: { agent_profiles: expect.arrayContaining(["claude", "codex"]), workflows: [] },
    });
    expect(exported.body.prompts.find((prompt: { name: string }) => prompt.name === "implementation")).toMatchObject({
      revision: updatedPrompt.body.prompt.revision, content: portablePrompt,
    });

    // Arrange a coworker's independent tracker with an existing workflow of
    // the same ID so the imported revision must remain an explicit trial.
    const targetRoot = await mkdtemp(join(tmpdir(), "agentic-bundle-target-"));
    const targetStore = new TicketStore(targetRoot, { watch: false });
    await targetStore.start();
    try {
      const targetConfigStore = new TrackerConfigStore(targetRoot);
      const targetConfig = await targetConfigStore.start();
      await targetConfigStore.update({
        providers: targetConfig.providers,
        agent_profiles: {
          default: "claude",
          profiles: [
            { id: "claude", label: "Claude work", provider: "claude", model: "claude-opus", reasoning: "high" },
            { id: "codex", label: "Codex review", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" },
          ],
        },
        repositories: targetConfig.repositories, jira: targetConfig.jira, github: targetConfig.github,
      }, targetConfig.revision);
      const targetApp = createApp(targetStore, join(targetRoot, "missing-client"));
      const localDefinition = structuredClone(portableDefinition);
      localDefinition.description = "Coworker-local default.";
      const local = await request(targetApp).post("/api/workflows").send({ content: stringify(localDefinition), label: "Coworker default" }).expect(201);

      // Execute the import and verify prompt activation plus release safety.
      const imported = await request(targetApp).post("/api/workflow-bundles/import").send(exported.body).expect(201);
      expect(imported.body).toMatchObject({
        workflow: { definition: { id: "portable-delivery" }, revision: portable.body.workflow.revision },
        release: { status: "trial", is_default: false },
        installed_prompt_revisions: expect.arrayContaining([`implementation@${updatedPrompt.body.prompt.revision}`]),
      });
      const targetPrompts = (await request(targetApp).get("/api/prompts").expect(200)).body.prompts;
      expect(targetPrompts.find((prompt: { name: string }) => prompt.name === "implementation")).toMatchObject({ content: portablePrompt, revision: updatedPrompt.body.prompt.revision });
      const targetReleases = await request(targetApp).get("/api/workflow-releases").expect(200);
      expect(targetReleases.body.releases.find((release: { revision: string }) => release.revision === local.body.workflow.revision)).toMatchObject({ is_default: true });
      expect(targetReleases.body.releases.find((release: { revision: string }) => release.revision === portable.body.workflow.revision)).toMatchObject({ status: "trial", is_default: false });

      const tampered = structuredClone(exported.body);
      tampered.prompts[0].content += "tampered";
      await request(targetApp).post("/api/workflow-bundles/import").send(tampered).expect(422);

      // A manually corrupted current prompt must not produce a bundle that
      // looks portable but will inevitably fail on the destination tracker.
      await writeFile(join(root, "prompts", "implementation.md"), "{{unknown_bundle_tag}}\n");
      const invalidExport = await request(sourceApp)
        .get(`/api/workflows/portable-delivery/revisions/${portable.body.workflow.revision}/export`)
        .expect(422);
      expect(invalidExport.body.code).toBe("WORKFLOW_BUNDLE_PROMPT_INVALID");
    } finally {
      await targetStore.close();
      await rm(targetRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    { action: "cancel", status: "cancelled", id: "APT-CANCELLED" },
    { action: "fail", status: "failed", id: "APT-FAILED" },
  ] as const)("migrates an inactive $status ticket to a non-terminal workflow node", async ({ action, status, id }) => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    const created = await request(app).post("/api/tickets").send({
      markdown: ticketMarkdown({ id }), workflow_id: "standard-delivery",
    }).expect(201);
    const inactive = await request(app).post(`/api/tickets/${id}/${action}`).send({
      expected_revision: created.body.frontmatter.revision, message: `${action} for migration coverage`,
    }).expect(200);
    expect(inactive.body.frontmatter).toMatchObject({ status, execution: null });

    // Execute
    const migrated = await request(app).post(`/api/tickets/${id}/workflow/migrate`).send({
      expected_revision: inactive.body.frontmatter.revision,
      workflow_id: "standard-delivery",
      node_id: "implementation",
    }).expect(200);

    // Verify
    expect(migrated.body.frontmatter).toMatchObject({
      status: "ready", phase: "implementation", archived_at: null,
      workflow: { id: "standard-delivery", current_node: "implementation" },
    });
  });

  it("stores, serves, and removes revision-fenced ticket attachments", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    const content = Buffer.from("screenshot bytes");
    const uploaded = await request(app)
      .post(`/api/tickets/APT-0001/attachments?filename=example.png&expected_revision=${created.body.frontmatter.revision}`)
      .set("Content-Type", "application/octet-stream")
      .set("X-Attachment-Content-Type", "image/png")
      .send(content)
      .expect(201);
    expect(uploaded.body.frontmatter.attachments).toEqual([expect.objectContaining({
      filename: "example.png", content_type: "image/png", size_bytes: content.byteLength,
    })]);
    const attachment = uploaded.body.frontmatter.attachments[0];
    const downloaded = await request(app).get(`/api/tickets/APT-0001/attachments/${attachment.id}/content`).expect(200);
    expect(downloaded.body).toEqual(content);
    expect(downloaded.headers.etag).toBe(`"${attachment.sha256}"`);
    const removed = await request(app).delete(`/api/tickets/APT-0001/attachments/${attachment.id}`).send({ expected_revision: uploaded.body.frontmatter.revision }).expect(200);
    expect(removed.body.frontmatter.attachments).toEqual([]);
    await request(app).get(`/api/tickets/APT-0001/attachments/${attachment.id}/content`).expect(404);
  });

  it("queues assignment refresh guidance when an attachment changes during agent work", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    const claimed = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const uploaded = await request(app)
      .post(`/api/tickets/APT-0001/attachments?filename=runtime.log&expected_revision=${claimed.body.frontmatter.revision}`)
      .set("Content-Type", "application/octet-stream")
      .set("X-Attachment-Content-Type", "text/plain")
      .send(Buffer.from("new runtime evidence"))
      .expect(201);

    expect(uploaded.body.frontmatter.status).toBe("running");
    expect(uploaded.body.frontmatter.execution.guidance.at(-1).message).toContain("Attachment runtime.log was added");
  });

  it("persists provider-neutral telemetry deltas and accepts a final snapshot after callback", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id;
    const baseline = telemetry(100, 1);
    const heartbeat = await request(app).post(`/api/work/${lease}/heartbeat`).send({
      pane_id: "w1:p1", session_ref: "claude-session", telemetry: telemetry(160, 1.2), telemetry_baseline: baseline,
    }).expect(200);
    expect(heartbeat.body.ticket.frontmatter.execution.telemetry).toMatchObject({
      latest: { model: { id: "claude-sonnet-4-5" }, reasoning: { effort: "high" } },
      delta: { usage: { total_tokens: 60 }, cost_usd: 0.2 },
    });
    expect((await request(app).get("/api/runtime").expect(200)).body.agents[0]).toMatchObject({
      ticket_id: "APT-0001", telemetry: { latest: { model: { id: "claude-sonnet-4-5" } }, delta: { usage: { total_tokens: 60 } } },
    });
    await request(app).post(`/api/work/${lease}/complete`).send({
      summary: "Implemented", outcome: "completed", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/42" }],
    }).expect(200);
    const late = await request(app).post(`/api/work/${lease}/telemetry`).send({ telemetry: telemetry(200, 1.5), telemetry_baseline: baseline }).expect(200);
    const run = late.body.ticket.frontmatter.workflow.node_runs.find((item: { lease_id: string }) => item.lease_id === lease);
    expect(run.telemetry).toMatchObject({ delta: { usage: { total_tokens: 100 }, cost_usd: 0.5 } });
    expect(late.body.ticket.frontmatter.execution).toBeNull();
    const stale = telemetry(170, 1.25);
    stale.observed_at = "2026-08-17T12:00:00.000Z";
    const unchanged = await request(app).post(`/api/work/${lease}/telemetry`).send({ telemetry: stale, telemetry_baseline: baseline }).expect(200);
    expect(unchanged.body.ticket.frontmatter.workflow.node_runs.find((item: { lease_id: string }) => item.lease_id === lease).telemetry.delta).toMatchObject({ usage: { total_tokens: 100 }, cost_usd: 0.5 });
    await request(app).post(`/api/work/${lease}/telemetry`).send({ telemetry: { nope: true } }).expect(422);
  }, 15_000);

  it("pauses an agent node when known cost across loop visits exceeds its cumulative limit", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    const workflow = {
      version: 2, id: "cost-loop", name: "Cost loop", description: "Cumulative agent-node budget", start: "work", max_transitions: 10,
      inputs: [], stages: [
        { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
        { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
      ],
      nodes: [
        { id: "work", name: "Budgeted work", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", agent_profile: "claude", conversation_key: "work", max_cost_usd: 0.5, outcomes: [
          { id: "again", label: "Run again", description: "Loop through the same node.", target: "work" },
          { id: "completed", label: "Complete", description: "Finish the workflow.", target: "done" },
        ], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    await request(app).post("/api/workflows").send({ content: stringify(workflow) }).expect(201);
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), workflow_id: "cost-loop" }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    const first = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const firstLease = first.body.frontmatter.execution.lease_id;

    // Execute the first visit below budget, loop, then cross the same node's limit on visit two.
    await request(app).post(`/api/work/${firstLease}/heartbeat`).send({
      telemetry: telemetry(130, 1.3), telemetry_baseline: telemetry(100, 1),
    }).expect(200);
    await request(app).post(`/api/work/${firstLease}/complete`).send({ summary: "More work required", outcome: "again" }).expect(200);
    const second = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const secondLease = second.body.frontmatter.execution.lease_id;
    const exceeded = await request(app).post(`/api/work/${secondLease}/heartbeat`).send({
      telemetry: telemetry(151, 1.51), telemetry_baseline: telemetry(130, 1.3),
    }).expect(200);

    // Verify the existing interruption protocol fences the agent and leaves an operator-visible pause.
    expect(exceeded.body.ticket.frontmatter.execution.interrupt_request).toMatchObject({
      reason_code: "cost_limit_exceeded", target_node: "work", cost_limit_usd: 0.5, cost_observed_usd: 0.51,
    });
    const paused = await request(app).post(`/api/work/${secondLease}/interrupt-ack`).send({}).expect(200);
    expect(paused.body.frontmatter).toMatchObject({ status: "blocked", workflow: { current_node: "work", cost_limit_pause: { workflow_id: "cost-loop", node_id: "work", limit_usd: 0.5, observed_usd: 0.51 } }, execution: null });
    expect(paused.body.frontmatter.workflow.node_runs.filter((run: { node_id: string }) => run.node_id === "work")).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed", outcome: "again", telemetry: expect.objectContaining({ delta: expect.objectContaining({ cost_usd: 0.3 }) }) }),
      expect.objectContaining({ status: "interrupted", outcome: "cost_limit_exceeded", telemetry: expect.objectContaining({ delta: expect.objectContaining({ cost_usd: 0.21 }) }) }),
    ]));
    const retry = await request(app).post("/api/tickets/APT-0001/retry").send({ expected_revision: paused.body.frontmatter.revision }).expect(409);
    expect(retry.body.error).toContain("higher max_cost_usd");
  }, 15_000);

  it("keeps heartbeats alive when optional telemetry is invalid and accounts a fresh zero-cost baseline", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id;
    const baseline = telemetry(0, 0);
    baseline.usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    baseline.cost = { total_usd: null, kind: "unavailable" };
    baseline.attributes = { agentic_baseline: "fresh_zero" };

    // Execute
    const heartbeat = await request(app).post(`/api/work/${lease}/heartbeat`).send({
      observed_state: "working", pane_id: "w1:p1", session_ref: "claude-session", telemetry: { invalid: true },
    }).expect(200);
    const recorded = await request(app).post(`/api/work/${lease}/telemetry`).send({
      telemetry: telemetry(200, 1.5), telemetry_baseline: baseline,
    }).expect(200);

    // Verify
    expect(heartbeat.body.ticket.frontmatter.execution).toMatchObject({ lease_id: lease, observed_herdr_state: "working" });
    expect(recorded.body.ticket.frontmatter.execution.telemetry).toMatchObject({
      baseline: { cost: { total_usd: null, kind: "unavailable" }, attributes: { agentic_baseline: "fresh_zero" } },
      delta: { usage: { total_tokens: 200 }, cost_usd: 1.5 },
    });
  });

  it("stores idempotent, sequence-fenced execution trace chunks before and after a terminal callback", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;
    const traceId = "2dd15b49-32ef-4d47-8a46-595e58b9719d";
    const first = [{ sequence: 1, timestamp: "2026-08-25T12:00:00.000Z", elapsed_ms: 0, event: "execution.trace_started", data: { provider: "claude" } }];

    // Execute
    const stored = await request(app).post(`/api/work/${lease}/trace/events`).send({ trace_id: traceId, first_sequence: 1, events: first }).expect(201);
    const duplicate = await request(app).post(`/api/work/${lease}/trace/events`).send({ trace_id: traceId, first_sequence: 1, events: first }).expect(201);
    await request(app).post(`/api/work/${lease}/complete`).send({
      summary: "Implemented", outcome: "completed", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/99" }],
    }).expect(200);
    await request(app).post(`/api/work/${lease}/trace/events`).send({
      trace_id: traceId, first_sequence: 2, completed: true,
      events: [{ sequence: 2, timestamp: "2026-08-25T12:00:01.000Z", elapsed_ms: 1000, event: "execution.trace_finished", data: { disposition: "callback" } }],
    }).expect(201);

    // Verify
    expect(duplicate.body.artifact.id).toBe(stored.body.artifact.id);
    await request(app).post(`/api/work/${lease}/trace/events`).send({ trace_id: traceId, first_sequence: 4, events: first.map((item) => ({ ...item, sequence: 4 })) }).expect(409);
    const ticket = await request(app).get("/api/tickets/APT-0001").expect(200);
    const chunks = ticket.body.frontmatter.artifacts.filter((artifact: { kind: string }) => artifact.kind === "execution_trace");
    expect(chunks).toHaveLength(2);
    expect(chunks.map((artifact: { metadata: Record<string, unknown> }) => artifact.metadata)).toEqual([
      expect.objectContaining({ trace_id: traceId, first_sequence: 1, last_sequence: 1, completed: false }),
      expect.objectContaining({ trace_id: traceId, first_sequence: 2, last_sequence: 2, completed: true }),
    ]);
    const content = await request(app).get(`/api/tickets/APT-0001/artifacts/${chunks[1].id}/content`).expect(200);
    expect(content.text).toContain('"event":"execution.trace_finished"');
  }, 15_000);

  it("stores provenance session evidence against a completed Agent run and deduplicates retries", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${lease}/complete`).send({
      summary: "Implemented", outcome: "completed", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/100" }],
    }).expect(200);
    const transcript = Buffer.from("assignment delivered\nagent worked\ncallback complete\n");
    const path = `/api/work/${lease}/session-evidence?kind=agent_transcript&filename=implementation.herdr.txt&content_type=text%2Fplain&source=herdr&completeness=bounded&disposition=callback&evidence_key=herdr%3Acallback&provider=claude&pane_id=w1%3Ap1&session_ref=session-1&line_count=3`;

    // Execute
    const first = await request(app).post(path).set("Content-Type", "application/octet-stream").send(transcript).expect(201);
    const duplicate = await request(app).post(path).set("Content-Type", "application/octet-stream").send(transcript).expect(201);

    // Verify
    expect(duplicate.body.artifact.id).toBe(first.body.artifact.id);
    expect(first.body.artifact).toMatchObject({
      kind: "agent_transcript", filename: "implementation.herdr.txt",
      metadata: {
        source: "herdr", completeness: "bounded", disposition: "callback", evidence_key: "herdr:callback",
        provider: "claude", pane_id: "w1:p1", session_ref: "session-1", line_count: 3,
        presentation: { title: "Agent session transcript", category: "provenance" },
      },
    });
    const ticket = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(ticket.body.frontmatter.artifacts.filter((artifact: { kind: string }) => artifact.kind === "agent_transcript")).toHaveLength(1);
    const downloaded = await request(app).get(`/api/tickets/APT-0001/artifacts/${first.body.artifact.id}/content`).expect(200);
    expect(downloaded.text).toContain("callback complete");
  }, 15_000);

  it("reprioritizes tickets in any state and returns unclaimed ready work to draft without adding a workflow visit", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const first = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "APT-0001", priority: 10 }), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "APT-0002", priority: 20 }), stage_enabled: { specification: false, review: false } }).expect(201);

    const reprioritized = await request(app).post("/api/tickets/APT-0001/priority").send({
      expected_revision: first.body.frontmatter.revision, priority: 30,
    }).expect(200);
    expect(reprioritized.body.frontmatter.priority).toBe(30);
    expect((await request(app).get("/api/tickets").expect(200)).body.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["APT-0001", "APT-0002"]);
    await request(app).post("/api/tickets/APT-0001/priority").send({
      expected_revision: reprioritized.body.frontmatter.revision, priority: 1.5,
    }).expect(422);

    const ready = await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: reprioritized.body.frontmatter.revision }).expect(200);
    const visits = ready.body.frontmatter.workflow.node_visits.implementation;
    const draft = await request(app).post("/api/tickets/APT-0001/draft").send({ expected_revision: ready.body.frontmatter.revision }).expect(200);
    expect(draft.body.frontmatter).toMatchObject({ phase: "implementation", status: "pending", execution: null });
    expect(draft.body.frontmatter.workflow.node_visits.implementation).toBe(visits);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(204);

    const readyAgain = await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: draft.body.frontmatter.revision }).expect(200);
    expect(readyAgain.body.frontmatter.workflow.node_visits.implementation).toBe(visits);
    const claimed = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const runningPriority = await request(app).post("/api/tickets/APT-0001/priority").send({
      expected_revision: claimed.body.frontmatter.revision, priority: -5,
    }).expect(200);
    expect(runningPriority.body.frontmatter).toMatchObject({ status: "running", priority: -5, execution: { lease_id: claimed.body.frontmatter.execution.lease_id } });
    await request(app).post("/api/tickets/APT-0001/draft").send({ expected_revision: runningPriority.body.frontmatter.revision }).expect(409);
  }, 15_000);

  it("executes a custom activity, human gate, and agent node through declared outcomes", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const workflow = {
      version: 2, id: "factory-test", name: "Factory test", description: "Typed-node acceptance path", start: "verify", max_transitions: 10,
      inputs: [], stages: [{ id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true }, { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true }],
      nodes: [
        { id: "verify", name: "Verify repository", type: "script", phase: "implementation", stage: "work", repository: "primary", inline: { language: "javascript", code: "process.stdout.write('verified')" }, script_output: { persist_stdout: true, prompt_tail_lines: 2 }, artifacts: [{ name: "verification-quality", path: "quality.yaml", content_type: "application/yaml", required: true, interpretation: { kind: "quality_report", schema: "agentic-quality/v1", required_attributes: ["tests.pass_rate"] } }], outcomes: [], choices: [], exit_codes: [{ id: "success", label: "Verified", description: "Verification passed.", target: "approval", codes: [0] }, { id: "failure", label: "Failed", description: "Verification failed.", target: "failed", default: true }] },
        { id: "approval", name: "Human approval", type: "human_gate", phase: "implementation", stage: "work", outcomes: [], choices: [{ id: "approved", label: "Approve", description: "Continue delivery.", target: "deliver" }, { id: "rejected", label: "Reject", description: "Stop delivery.", target: "failed", comment_required: true }], exit_codes: [] },
        { id: "deliver", name: "Deliver", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", agent_profile: "codex", conversation_key: "work", outcomes: [{ id: "completed", label: "Delivered", description: "Delivery is complete.", target: "done" }], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
        { id: "failed", name: "Failed", type: "terminal", phase: "done", stage: "done", terminal_status: "failed", outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    await request(app).post("/api/workflows").send({ content: stringify(workflow) }).expect(201);
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), workflow_id: "factory-test" }).expect(201);
    await request(app).put("/api/tickets/APT-0001/metadata/environment").send({ expected_revision: created.body.frontmatter.revision, value: { name: "nonprod", retries: 2 } }).expect(200);
    expect((await request(app).get("/api/tickets/APT-0001/metadata/environment").expect(200)).body).toMatchObject({ exists: true, value: { name: "nonprod", retries: 2 } });
    const seeded = await store.command("APT-0001", { event: "test.seed_losses", message: "Seed prior activity lease losses." }, (ticket) => {
      ticket.workflow!.node_attempts.verify = { total: 2, consecutive_lease_losses: 2 }; return { ticket };
    });
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: seeded.frontmatter!.revision }).expect(200);
    await request(app).post("/api/work/claim-activity").send({ supervisor_id: "factory-vm", available_providers: ["claude"], activity_capabilities: ["inline_javascript"] }).expect(204);
    const activity = await request(app).post("/api/work/claim-activity").send({ supervisor_id: "factory-vm", available_providers: ["codex"], activity_capabilities: ["inline_javascript"] }).expect(200);
    expect(activity.body.workflow_node).toMatchObject({ id: "verify", type: "script", inline: { language: "javascript", code: "process.stdout.write('verified')" } });
    const trackerConfig = (await request(app).get("/api/config").expect(200)).body.config;
    await request(app).put("/api/config").send({
      expected_revision: trackerConfig.revision, repositories: trackerConfig.repositories,
      quality: { attributes: [{ key: "tests.pass_rate", label: "Test pass rate", type: "number", unit: "ratio", direction: "higher_is_better", minimum: 0, maximum: 1 }] },
    }).expect(200);
    await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/artifacts?kind=quality_report&filename=quality.yaml&content_type=application%2Fyaml`)
      .set("Content-Type", "application/octet-stream").send(Buffer.from("schema: agentic-quality/v1\nattributes: []\n")).expect(422);
    await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/artifacts?kind=quality_report&artifact_name=undeclared&filename=quality.yaml&content_type=application%2Fyaml`)
      .set("Content-Type", "application/octet-stream").send(Buffer.from("schema: agentic-quality/v1\nattributes: []\n")).expect(422);
    await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/artifacts?kind=quality_report&artifact_name=verification-quality&filename=quality.yaml&content_type=text%2Fyaml`)
      .set("Content-Type", "application/octet-stream").send(Buffer.from("schema: agentic-quality/v1\nattributes: []\n")).expect(422);
    await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/artifacts?kind=quality_report&artifact_name=verification-quality&filename=invalid.yaml&content_type=application%2Fyaml`)
      .set("Content-Type", "application/octet-stream").send(Buffer.from("schema: wrong\nattributes: []\n")).expect(422);
    await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/artifacts?kind=quality_report&artifact_name=verification-quality&filename=missing.yaml&content_type=application%2Fyaml`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from(stringify({ schema: "agentic-quality/v1", attributes: [{ key: "notes.complete", value: true }] }))).expect(422);
    expect((await request(app).get("/api/tickets/APT-0001").expect(200)).body.frontmatter.artifacts).toEqual([]);
    const qualityYaml = Buffer.from(stringify({ schema: "agentic-quality/v1", name: "Verification", subject: { type: "repository", repository: "demo" }, producer: { tool: "tests", version: "1" }, attributes: [{ key: "tests.pass_rate", value: 0.98, unit: "ratio", direction: "higher_is_better", target: 0.95, status: "pass" }, { key: "notes.complete", label: "Notes complete", value: true, status: "pass" }] }));
    const quality = await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/artifacts?kind=quality_report&artifact_name=verification-quality&filename=quality.yaml&content_type=application%2Fyaml`)
      .set("Content-Type", "application/octet-stream")
      .send(qualityYaml).expect(201);
    expect(quality.body.artifact).toMatchObject({ kind: "quality_report", metadata: { quality_report: { schema: "agentic-quality/v1", overall_status: "pass", attributes: [{ key: "tests.pass_rate", registered: true }, { key: "notes.complete", registered: false }] } } });
    const downloadedQuality = await request(app).get(`/api/tickets/APT-0001/artifacts/${quality.body.artifact.id}/content`).expect(200);
    expect(Buffer.isBuffer(downloadedQuality.body) ? downloadedQuality.body : Buffer.from(downloadedQuality.text)).toEqual(qualityYaml);
    expect(downloadedQuality.headers.etag).toBe(`"sha256:${quality.body.artifact.sha256}"`);
    const reviewMarkdown = Buffer.from("# Verification summary\n\nAll declared checks passed.\n");
    const evidence = await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/artifacts?kind=evidence&filename=review.md&content_type=text%2Fmarkdown&title=Verification%20summary&description=Evidence%20for%20the%20approval%20gate&category=review&featured=true`)
      .set("Content-Type", "application/octet-stream").send(reviewMarkdown).expect(201);
    expect(evidence.body.artifact).toMatchObject({ kind: "evidence", filename: "review.md", metadata: { presentation: { title: "Verification summary", description: "Evidence for the approval gate", category: "review", featured: true } } });
    const downloadedEvidence = await request(app).get(`/api/tickets/APT-0001/artifacts/${evidence.body.artifact.id}/content`).expect(200);
    expect(Buffer.isBuffer(downloadedEvidence.body) ? downloadedEvidence.body : Buffer.from(downloadedEvidence.text)).toEqual(reviewMarkdown);
    const activityResult = await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/activity-result`).send({
      success: true, summary: "Verified", output: "combined", stdout: "one\ntwo\nthree", stderr: "warning", exit_code: 0,
      script_path: null, working_directory: "/srv/projects/demo",
      structured_result: { metadata: { "verification.report": "report-123" }, external_references: [{ type: "test-report", id: "report-123", url: "https://ci.example/report-123" }] },
    }).expect(200);
    expect(activityResult.body.outcome).toBe("success");
    await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/artifacts?kind=quality_report&artifact_name=verification-quality&filename=stale.yaml&content_type=application%2Fyaml`)
      .set("Content-Type", "application/octet-stream").send(qualityYaml).expect(409);
    const activityManifest = await request(app).post(`/api/work/${activity.body.frontmatter.execution.lease_id}/finalize`).send({ runtime: { supervisor: { hostname: "factory-vm" }, repositories: { before: [], after: [] } } }).expect(200);
    expect(activityManifest.body.artifact).toMatchObject({ kind: "execution_manifest", node_run_id: expect.any(String) });
    const manifestResponse = await request(app).get(`/api/tickets/APT-0001/artifacts/${activityManifest.body.artifact.id}/content`).expect(200);
    const manifest = JSON.parse(Buffer.isBuffer(manifestResponse.body) ? manifestResponse.body.toString("utf8") : manifestResponse.text);
    expect(manifest.inputs).toMatchObject({ incoming: null, prior_artifacts: [], workflow_inputs: {}, ticket_revision: expect.any(Number) });
    expect(manifest.outputs.map((artifact: { id: string }) => artifact.id)).toEqual(expect.arrayContaining([quality.body.artifact.id, evidence.body.artifact.id]));
    const waiting = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(waiting.body.frontmatter.workflow.node_attempts.verify.consecutive_lease_losses).toBe(0);
    const activityRun = waiting.body.frontmatter.workflow.node_runs[0];
    expect(activityRun).toMatchObject({ output: "one\ntwo\nthree", output_bytes: 13, output_sha256: expect.any(String), output_path: expect.any(String), script_path: null, working_directory: "/srv/projects/demo" });
    expect((await request(app).get(`/api/tickets/APT-0001/runs/${activityRun.id}/output`).expect(200)).text).toBe("one\ntwo\nthree");
    expect(waiting.body.frontmatter).toMatchObject({ status: "waiting_approval", metadata: { "verification.report": "report-123" }, workflow: { current_node: "approval", incoming: { output: "two\nthree", output_log_path: expect.stringContaining(`/runs/${activityRun.id}/output`) } } });
    expect(activityRun).toMatchObject({ metadata_writes: { "verification.report": "report-123" }, external_references: [{ type: "test-report", id: "report-123" }], manifest_artifact_id: activityManifest.body.artifact.id });
    await request(app).post("/api/tickets/APT-0001/decide").send({ expected_revision: waiting.body.frontmatter.revision, decision: "rejected" }).expect(422);
    const approved = await request(app).post("/api/tickets/APT-0001/decide").send({
      expected_revision: waiting.body.frontmatter.revision,
      decision: "approved",
      message: "Review pull request example/demo#42.",
    }).expect(200);
    expect(approved.body.frontmatter.workflow).toMatchObject({
      current_node: "deliver",
      incoming: { outcome: "approved", summary: "Review pull request example/demo#42.", handoff: "Review pull request example/demo#42." },
    });
    const assignment = await request(app).post("/api/work/claim").send({ supervisor_id: "factory-vm", provider: "codex", available_providers: ["codex"], activity_capabilities: ["inline_javascript"] }).expect(200);
    expect(assignment.body).toMatchObject({ workflow_node: { id: "deliver", conversation_key: "work" }, node_prompt: { id: "implementation" } });
    await request(app).put(`/api/work/${assignment.body.frontmatter.execution.lease_id}/metadata/release`).send({ value: "candidate" }).expect(200);
    await request(app).post(`/api/work/${assignment.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Delivered", handoff: "Ready for release notes.", outcome: "completed" }).expect(200);
    const deliveryManifest = await request(app).post(`/api/work/${assignment.body.frontmatter.execution.lease_id}/finalize`).send({ runtime: { agent: { provider: "codex", generation: 1 } } }).expect(200);
    const deliveryManifestResponse = await request(app).get(`/api/tickets/APT-0001/artifacts/${deliveryManifest.body.artifact.id}/content`).expect(200);
    const deliveryManifestContent = JSON.parse(Buffer.isBuffer(deliveryManifestResponse.body) ? deliveryManifestResponse.body.toString("utf8") : deliveryManifestResponse.text);
    expect(deliveryManifestContent.inputs.incoming).toMatchObject({ source_node: "approval", target_node: "deliver", outcome: "approved" });
    const complete = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(complete.body.frontmatter).toMatchObject({ phase: "done", status: "completed", metadata: { environment: { name: "nonprod", retries: 2 }, release: "candidate" }, workflow: { current_node: "done" } });
    expect(complete.body.frontmatter.workflow.node_runs.map((run: { outcome: string }) => run.outcome)).toEqual(["success", "approved", "completed"]);
    expect(complete.body.frontmatter.workflow).toMatchObject({ incoming: { source_node: "deliver", target_node: "done", outcome: "completed", handoff: "Ready for release notes." } });
    expect(complete.body.frontmatter.artifacts.filter((artifact: { kind: string }) => artifact.kind === "execution_manifest")).toHaveLength(2);
    const metrics = await request(app).get("/api/metrics?workflow_id=factory-test").expect(200);
    const verificationMetrics = metrics.body.workflows[0].nodes.find((node: { node_id: string }) => node.node_id === "verify");
    expect(verificationMetrics.quality).toEqual([expect.objectContaining({ key: "tests.pass_rate", ticket_count: 1, reports: 1, pass_rate: 1, numeric: expect.objectContaining({ median: 0.98 }) })]);
  }, 15_000);

  it("persists an external wait without a lease and lets the operator release it early", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const workflow = {
      version: 2, id: "durable-wait", name: "Durable wait", description: "Tracker-owned external delay", start: "wait", max_transitions: 5,
      inputs: [], stages: [{ id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true }, { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true }],
      nodes: [
        { id: "wait", name: "Wait for external system", type: "wait", phase: "implementation", stage: "work", wait_schedule: { initial_seconds: 30, multiplier: 2, maximum_seconds: 300, jitter_percent: 10, deadline_seconds: 3_600 }, next: "done", timeout_to: "failed", outcomes: [], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
        { id: "failed", name: "Failed", type: "terminal", phase: "done", stage: "done", terminal_status: "failed", outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    await request(app).post("/api/workflows").send({ content: stringify(workflow) }).expect(201);
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), workflow_id: "durable-wait" }).expect(201);
    const waiting = await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    expect(waiting.body.frontmatter).toMatchObject({ status: "waiting_external", execution: null, workflow: { current_node: "wait", wait_states: expect.any(Object) } });
    expect(waiting.body.frontmatter.workflow.node_runs[0]).toMatchObject({ node_type: "wait", status: "running", wait: { wake_at: expect.any(String), deadline_at: expect.any(String) }, timing: { state: "external_wait" } });
    const completed = await request(app).post("/api/tickets/APT-0001/wake").send({ expected_revision: waiting.body.frontmatter.revision }).expect(200);
    expect(completed.body.frontmatter).toMatchObject({ phase: "done", status: "completed", execution: null, workflow: { current_node: "done" } });
    expect(completed.body.frontmatter.workflow.node_runs[0]).toMatchObject({ status: "completed", outcome: "elapsed" });
  }, 15_000);

  it("stores lease-fenced checkpoint bundles and advances a checkpoint node", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const workflow = {
      version: 2, id: "checkpoint-test", name: "Checkpoint test", description: "Portable snapshot", start: "save", max_transitions: 5,
      inputs: [], stages: [{ id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true }, { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true }],
      nodes: [
        { id: "save", name: "Save state", type: "checkpoint", phase: "implementation", stage: "work", checkpoint_label: "Before experiment", outcomes: [], choices: [], exit_codes: [{ id: "created", label: "Created", description: "Stored.", target: "done", codes: [0] }, { id: "failed", label: "Failed", description: "Capture failed.", target: "save", default: true }] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    await request(app).post("/api/workflows").send({ content: stringify(workflow) }).expect(201);
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), workflow_id: "checkpoint-test" }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    const claim = await request(app).post("/api/work/claim-activity").send({ supervisor_id: "vm", available_providers: [], activity_capabilities: ["git_checkpoint"] }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id;
    const bundleBytes = Buffer.from("portable git bundle bytes");
    const upload = await request(app).post(`/api/work/${lease}/artifacts?kind=checkpoint_bundle&filename=demo.bundle&content_type=application%2Fx-git-bundle`)
      .set("Content-Type", "application/octet-stream").send(bundleBytes).expect(201);
    const artifact = upload.body.artifact;
    const downloaded = await request(app).get(`/api/tickets/APT-0001/artifacts/${artifact.id}/content`).expect(200);
    expect(downloaded.headers["content-length"]).toBe(String(bundleBytes.byteLength));
    expect(downloaded.headers.etag).toBe(`"sha256:${artifact.sha256}"`);
    await request(app).post(`/api/work/${lease}/activity-result`).send({
      success: true, summary: "Captured", output: "checkpoint-1", exit_code: 0, script_path: null, working_directory: "/srv/projects",
      checkpoints: [{ id: "checkpoint-1", label: "Before experiment", kind: "workflow", created_at: new Date().toISOString(), repositories: [{ repository: "demo", head_sha: "a".repeat(40), snapshot_sha: "b".repeat(40), branch: "main", remote_url: "https://github.com/example/demo.git", dirty: true, bundle_artifact_id: artifact.id }] }],
    }).expect(200);
    const ticket = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(ticket.body.frontmatter).toMatchObject({ phase: "done", status: "completed", checkpoints: [{ id: "checkpoint-1", repositories: [{ bundle_artifact_id: artifact.id }] }] });
    expect(ticket.body.frontmatter.artifacts.map((item: { kind: string }) => item.kind)).toEqual(["checkpoint_bundle", "checkpoint_manifest"]);
  }, 15_000);

  it("uses a pinned node profile and conversation without ticket-level provider invariants", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const workflow = {
      version: 2, id: "explicit-provider", name: "Explicit provider", description: "Codex node on a Claude-default ticket", start: "work", max_transitions: 5,
      inputs: [], stages: [{ id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true }, { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true }],
      nodes: [
        { id: "work", name: "Codex work", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", agent_profile: "codex", conversation_key: "codex-work", pull_request_requirement: { scope: "any", phase: "implementation" }, outcomes: [{ id: "completed", label: "Complete", description: "Work is complete.", target: "done" }], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    await request(app).post("/api/workflows").send({ content: stringify(workflow) }).expect(201);
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), workflow_id: "explicit-provider" }).expect(201);
    const seeded = await store.command("APT-0001", { event: "test.seed_wrong_provider", message: "Seed an incompatible prior conversation." }, (ticket) => {
      ticket.conversations!["codex-work"] = { provider: "claude", herdr_pane_id: "old:pane", session_ref: "claude-session", generation: 1, visits_in_generation: 1, last_visit_key: "seed", reset_reason: null };
      return { ticket };
    });
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: seeded.frontmatter!.revision }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude", "codex"] }).expect(204);
    const claimed = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex", available_providers: ["claude", "codex"] }).expect(200);
    expect(claimed.body.frontmatter).toMatchObject({
      execution: { provider: "codex" },
      conversations: { "codex-work": { provider: "codex", herdr_pane_id: null, session_ref: null } },
    });
    await request(app).post(`/api/work/${claimed.body.frontmatter.execution.lease_id}/heartbeat`).send({ pane_id: "w1:p1", session_ref: "codex-explicit" }).expect(200);
    await request(app).post(`/api/work/${claimed.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Completed", outcome: "completed" }).expect(422);
    await request(app).post(`/api/work/${claimed.body.frontmatter.execution.lease_id}/complete`).send({
      summary: "Completed", outcome: "completed", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/17" }],
    }).expect(200);
    const completed = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(completed.body.frontmatter).toMatchObject({ status: "completed", workflow: { current_node: "done" }, conversations: { "codex-work": { generation: 2, visits_in_generation: 1 } } });
    const reset = await request(app).post("/api/tickets/APT-0001/conversations/codex-work/reset").send({ expected_revision: completed.body.frontmatter.revision }).expect(200);
    expect(reset.body.frontmatter.conversations["codex-work"]).toMatchObject({ generation: 3, visits_in_generation: 0, herdr_pane_id: null, session_ref: null, reset_reason: "operator" });
  });

  it("pins an agent profile alias to provider, model, and reasoning for the ticket", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const initial = (await request(app).get("/api/config").expect(200)).body.config;
    const configured = (await request(app).put("/api/config").send({
      expected_revision: initial.revision, providers: { enabled: ["claude", "codex"] }, repositories: [],
      agent_profiles: { default: "complex", profiles: [{ id: "complex", label: "Complex", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" }] },
      jira: initial.jira, github: initial.github,
    }).expect(200)).body.config;
    const workflow = {
      version: 2, id: "profile-test", name: "Profile test", description: "Pinned runtime profile", start: "work", max_transitions: 5,
      inputs: [], stages: [{ id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true }, { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true }],
      nodes: [
        { id: "work", name: "Work", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", agent_profile: "default", conversation_key: "work", outcomes: [{ id: "completed", label: "Completed", description: "Work completed.", target: "done" }], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", status_code: 0, outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    await request(app).post("/api/workflows").send({ content: stringify(workflow) }).expect(201);
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), workflow_id: "profile-test" }).expect(201);
    await request(app).put("/api/config").send({
      expected_revision: configured.revision, providers: { enabled: ["claude", "codex"] }, repositories: [],
      agent_profiles: { default: "complex", profiles: [{ id: "complex", label: "Complex", provider: "claude", model: "claude-opus-4-6", reasoning: "max" }] },
      jira: configured.jira, github: configured.github,
    }).expect(200);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: created.body.frontmatter.revision }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude", "codex"] }).expect(204);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex", available_providers: ["claude", "codex"] }).expect(200);
    expect(claim.body.resolved_agent_profile).toEqual({ alias: "complex", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" });
  }, 15_000);

  it("admits the bundled agent-skill ticket template", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const markdown = await readFile("skills/agentic-project-tracker/assets/ticket-template.md", "utf8");
    const created = await request(app).post("/api/tickets").send({ markdown, auto_id: true }).expect(201);
    expect(created.body.frontmatter).toMatchObject({
      id: "AGENT-0001", phase: "specification", status: "pending",
      repositories: [{ id: "replace-with-repository-id", primary: true }],
    });
  });

  it("serves, previews, and revision-fences the central prompt library", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const initial = await request(app).get("/api/prompts").expect(200);
    expect(initial.body.prompts).toHaveLength(11);
    const implementation = initial.body.prompts.find((prompt: { name: string }) => prompt.name === "implementation");
    expect(implementation).toMatchObject({
      valid: true,
      stages: ["Implementation", "Review repair", "Reopen", "GitHub follow-up"],
    });

    const preview = await request(app).post("/api/prompts/implementation/preview").send({
      content: "Implement {{ticket_id}} and call {{callback_base}}complete.", phase: "implementation",
    }).expect(200);
    expect(preview.body.rendered).toContain("You are assigned ticket AGENT-0042");
    expect(preview.body.rendered).toContain("/START_HERE.md");
    expect(preview.body.rendered).toContain("# Durable node.md preview");
    expect(preview.body.rendered).toContain("Implement AGENT-0042");

    const updated = await request(app).put("/api/prompts/implementation").send({
      content: `${implementation.content}\nAsk focused questions when requirements are ambiguous.`,
      expected_revision: implementation.revision,
    }).expect(200);
    expect(updated.body.prompt.content).toContain("Ask focused questions");
    await request(app).put("/api/prompts/implementation").send({
      content: implementation.content, expected_revision: implementation.revision,
    }).expect(409);
  });

  it("refuses to publish a workflow that references an invalid prompt", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).get("/api/prompts").expect(200);
    await writeFile(join(root, "prompts", "broken-node.md"), "{{unknown_placeholder}}\n");
    const workflow = {
      version: 2, id: "broken-prompt-workflow", name: "Broken prompt workflow", description: "Must not publish", start: "work", max_transitions: 5,
      inputs: [], stages: [{ id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true }, { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true }],
      nodes: [
        { id: "work", name: "Work", type: "agent", phase: "implementation", stage: "work", prompt: "broken-node", agent_profile: "default", conversation_key: "work", outcomes: [{ id: "completed", label: "Complete", description: "Finish.", target: "done" }], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
      ],
    };
    const result = await request(app).post("/api/workflows").send({ content: stringify(workflow) }).expect(422);
    expect(result.body.details).toContain("node work: prompt broken-node does not exist or is invalid");
  });

  it("allocates local ticket IDs from tracker configuration", async () => {
    const app = createApp(store, join(root, "missing-client"));
    expect((await request(app).get("/api/tickets/next-id").expect(200)).body.id).toBe("AGENT-0001");
    const first = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "preview" }), auto_id: true }).expect(201);
    const second = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "preview" }), auto_id: true }).expect(201);
    expect(first.body.frontmatter.id).toBe("AGENT-0001");
    expect(second.body.frontmatter.id).toBe("AGENT-0002");
    expect(first.body.frontmatter).not.toHaveProperty("slug");
    expect((await request(app).get("/api/config").expect(200)).body.config.tickets.next_number).toBe(3);
    const custom = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "TEAM-42" }), auto_id: false }).expect(201);
    expect(custom.body.frontmatter.id).toBe("TEAM-42");
    expect((await request(app).get("/api/config").expect(200)).body.config.tickets.next_number).toBe(3);
  });

  it("omits unpinned ticket files from the queue while retaining direct recovery access", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await store.create(ticketMarkdown({ id: "UNPINNED-1" }));
    expect((await request(app).get("/api/tickets").expect(200)).body.tickets).toEqual([]);
    expect((await request(app).get("/api/tickets/UNPINNED-1").expect(200)).body.frontmatter.id).toBe("UNPINNED-1");

    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "PINNED-1" }) }).expect(201);
    expect((await request(app).get("/api/tickets").expect(200)).body.tickets).toMatchObject([{ id: "PINNED-1", workflow_id: "standard-delivery" }]);
  });

  it("serves and revision-fences the repository catalog", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const initial = await request(app).get("/api/config").expect(200);
    expect(initial.body.config).toMatchObject({ version: 1, revision: 2, providers: { enabled: ["claude", "codex"] }, repositories: [] });

    const updated = await request(app).put("/api/config").send({
      expected_revision: initial.body.config.revision,
      providers: { enabled: ["claude", "codex"] },
      agent_profiles: { default: "claude", profiles: [
        { id: "claude", label: "Claude work", provider: "claude", model: "test-claude", reasoning: "high" },
        { id: "codex", label: "Codex review", provider: "codex", model: "test-codex", reasoning: "high" },
      ] },
      repositories: [{ id: "demo-api", url: "git@github.com:example/demo-api.git" }],
    }).expect(200);
    expect(updated.body.config).toMatchObject({
      version: 1,
      revision: 3,
      providers: { enabled: ["claude", "codex"] },
      repositories: [{ id: "demo-api", url: "git@github.com:example/demo-api.git" }],
    });

    await request(app).put("/api/config").send({ expected_revision: initial.body.config.revision, repositories: [] }).expect(409);
    const invalid = await request(app).put("/api/config").send({
      expected_revision: updated.body.config.revision,
      repositories: [{ id: "../escape", url: "https://github.com/example/escape.git" }],
    }).expect(422);
    expect(invalid.body.error).toBe("Tracker configuration is invalid");
    await request(app).put("/api/config").send({ expected_revision: updated.body.config.revision, providers: { enabled: [] }, repositories: [] }).expect(422);
  });

  it("reports Claude and Codex supervisors without inventing weekly subscription allowances", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/supervisors/heartbeat").send({
      supervisor_id: "api-worker", instance_id: "process-one", hostname: "worker-one", ip_addresses: ["192.0.2.70"],
      project_root: "/srv/projects", herdr_session: "agents", providers: ["claude", "codex"], activity_capabilities: [], started_at: "2026-08-20T12:00:00Z",
    }).expect(200);

    // Act
    const configuration = await request(app).get("/api/config").expect(200);

    // Assert
    expect(configuration.body.quota.accounts).toEqual([
      expect.objectContaining({ account_id: "api-worker", provider: "claude", status: "not_reported", estimated_weekly_tokens: null, estimated_weekly_api_usd: null }),
      expect.objectContaining({ account_id: "api-worker", provider: "codex", status: "not_reported", estimated_weekly_tokens: null, estimated_weekly_api_usd: null }),
    ]);
  });

  it("registers supervisor health and rejects a duplicate live process ID", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const presence = {
      supervisor_id: "vm-one", instance_id: "process-one", hostname: "worker-one",
      ip_addresses: ["192.0.2.70"], project_root: "/srv/projects/one", herdr_session: "agents-one",
      providers: ["claude", "codex"], activity_capabilities: ["repository_action", "inline_shell", "inline_javascript", "inline_python"],
      started_at: "2026-08-14T12:00:00Z",
    };
    await request(app).post("/api/supervisors/heartbeat").send(presence).expect(200);
    const health = await request(app).get("/api/supervisors").expect(200);
    expect(health.body.supervisors[0]).toMatchObject({
      supervisor_id: "vm-one", hostname: "worker-one", ip_addresses: ["192.0.2.70"],
      project_root: "/srv/projects/one", providers: ["claude", "codex"],
      activity_capabilities: ["repository_action", "inline_shell", "inline_javascript", "inline_python"],
      status: "online", assigned_ticket: null,
    });
    await request(app).post("/api/supervisors/heartbeat").send({ ...presence, instance_id: "process-two" }).expect(409);
  });

  it("pins a ticket end-to-end and reserves the supervisor until terminal state", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "APT-0002" }), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    await request(app).post("/api/tickets/APT-0002/ready").send({ expected_revision: 1 }).expect(200);
    const first = await request(app).post("/api/work/claim").send({ supervisor_id: "vm-one", provider: "claude", available_providers: ["claude"] }).expect(200);
    expect(first.body.frontmatter.assigned_supervisor).toBe("vm-one");
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm-one", provider: "claude", available_providers: ["claude"] }).expect(204);
    const second = await request(app).post("/api/work/claim").send({ supervisor_id: "vm-two", provider: "claude", available_providers: ["claude"] }).expect(200);
    expect(second.body.frontmatter).toMatchObject({ id: "APT-0002", assigned_supervisor: "vm-two" });
    const health = await request(app).get("/api/supervisors").expect(200);
    expect(health.body.supervisors).toEqual([]);
  });

  it("blocks overlapping repositories on one host while allowing another host", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const register = (supervisorId: string, instanceId: string, hostname: string) => request(app).post("/api/supervisors/heartbeat").send({
      supervisor_id: supervisorId, instance_id: instanceId, hostname, ip_addresses: [],
      project_root: `/srv/${supervisorId}`, herdr_session: supervisorId, providers: ["claude"],
      started_at: "2026-08-14T12:00:00Z",
    }).expect(200);
    await register("shared-a", "process-a", "shared-vm");
    await register("shared-b", "process-b", "shared-vm");
    await register("remote", "process-c", "remote-vm");
    for (const id of ["APT-0001", "APT-0002", "APT-0003"]) {
      await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id }), stage_enabled: { specification: false, review: false } }).expect(201);
      await request(app).post(`/api/tickets/${id}/ready`).send({ expected_revision: 1 }).expect(200);
    }

    const first = await request(app).post("/api/work/claim").send({
      supervisor_id: "shared-a", instance_id: "process-a", provider: "claude", available_providers: ["claude"],
    }).expect(200);
    expect(first.body.frontmatter).toMatchObject({ assigned_supervisor: "shared-a", assigned_supervisor_host: "shared-vm" });
    await request(app).post("/api/work/claim").send({
      supervisor_id: "shared-b", instance_id: "process-b", provider: "claude", available_providers: ["claude"],
    }).expect(204);

    const queue = await request(app).get("/api/tickets").expect(200);
    const blocked = queue.body.tickets.find((ticket: { id: string }) => ticket.id === "APT-0002");
    expect(blocked).toMatchObject({ status: "ready", claim_blockers: [{ hostname: "shared-vm", ticket_id: "APT-0001", repositories: ["demo"] }] });

    const remote = await request(app).post("/api/work/claim").send({
      supervisor_id: "remote", instance_id: "process-c", provider: "claude", available_providers: ["claude"],
    }).expect(200);
    expect(remote.body.frontmatter).toMatchObject({ id: "APT-0002", assigned_supervisor_host: "remote-vm" });
  }, 15_000);

  it("retains a host-local repository blocker until the conflicting ticket completes", async () => {
    const app = createApp(store, join(root, "missing-client"));
    for (const [supervisorId, instanceId] of [["worker-a", "process-a"], ["worker-b", "process-b"]]) {
      await request(app).post("/api/supervisors/heartbeat").send({
        supervisor_id: supervisorId, instance_id: instanceId, hostname: "shared-vm", ip_addresses: [],
        project_root: `/srv/${supervisorId}`, herdr_session: supervisorId, providers: ["claude"], started_at: "2026-08-14T12:00:00Z",
      }).expect(200);
    }
    for (const id of ["APT-0001", "APT-0002"]) {
      await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id }), stage_enabled: { specification: false, review: false } }).expect(201);
      await request(app).post(`/api/tickets/${id}/ready`).send({ expected_revision: 1 }).expect(200);
    }
    const first = await request(app).post("/api/work/claim").send({ supervisor_id: "worker-a", instance_id: "process-a", provider: "claude", available_providers: ["claude"] }).expect(200);
    await request(app).post(`/api/work/${first.body.frontmatter.execution.lease_id}/fail`).send({ reason: "Needs operator attention" }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "worker-b", instance_id: "process-b", provider: "claude", available_providers: ["claude"] }).expect(204);
    const failed = await request(app).get("/api/tickets/APT-0001").expect(200);
    await request(app).post("/api/tickets/APT-0001/retry").send({ expected_revision: failed.body.frontmatter.revision }).expect(200);
    const retried = await request(app).post("/api/work/claim").send({ supervisor_id: "worker-a", instance_id: "process-a", provider: "claude", available_providers: ["claude"] }).expect(200);
    await request(app).post(`/api/work/${retried.body.frontmatter.execution.lease_id}/complete`).send({
      summary: "Completed", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/100" }],
    }).expect(200);
    const second = await request(app).post("/api/work/claim").send({ supervisor_id: "worker-b", instance_id: "process-b", provider: "claude", available_providers: ["claude"] }).expect(200);
    expect(second.body.frontmatter.id).toBe("APT-0002");
  }, 15_000);

  it("waits for active execution interruption before cancelling and releasing repository ownership", async () => {
    const app = createApp(store, join(root, "missing-client"));
    for (const id of ["APT-0001", "APT-0002"]) {
      await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id }), stage_enabled: { specification: false, review: false } }).expect(201);
      await request(app).post(`/api/tickets/${id}/ready`).send({ expected_revision: 1 }).expect(200);
    }
    const first = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    const lease = first.body.frontmatter.execution.lease_id as string;
    const requested = await request(app).post("/api/tickets/APT-0001/cancel").send({
      expected_revision: first.body.frontmatter.revision, message: "Stop this work.",
    }).expect(200);
    expect(requested.body.frontmatter).toMatchObject({
      status: "running", assigned_supervisor: "vm",
      execution: { lease_id: lease, interrupt_request: { terminal_status: "cancelled", terminal_reason: "Stop this work." } },
    });
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(204);
    const cancelled = await request(app).post(`/api/work/${lease}/interrupt-ack`).send({}).expect(200);
    expect(cancelled.body.frontmatter).toMatchObject({ status: "cancelled", execution: null, assigned_supervisor: "vm" });
    expect(cancelled.body.frontmatter.workflow.node_runs.find((run: { node_id: string }) => run.node_id === "implementation")).toMatchObject({ status: "interrupted", outcome: "operator_cancelled" });
    const second = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude"] }).expect(200);
    expect(second.body.frontmatter.id).toBe("APT-0002");
  });

  it("resets only the current node's lease losses and preserves workflow bounds on retry", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    let seeded = await store.command("APT-0001", { event: "test.block", message: "Seed retry state." }, (ticket) => {
      ticket.status = "blocked";
      ticket.workflow!.node_attempts.implementation = { total: 3, consecutive_lease_losses: 3 };
      return { ticket };
    });
    const retried = await request(app).post("/api/tickets/APT-0001/retry").send({ expected_revision: seeded.frontmatter!.revision }).expect(200);
    expect(retried.body.frontmatter).toMatchObject({ status: "ready", workflow: { node_attempts: { implementation: { consecutive_lease_losses: 0 } } } });

    seeded = await store.command("APT-0001", { event: "test.bound", message: "Seed exceeded visit bound." }, (ticket) => {
      ticket.status = "blocked";
      ticket.workflow!.node_visits.implementation = 21;
      return { ticket };
    });
    const bounded = await request(app).post("/api/tickets/APT-0001/retry").send({ expected_revision: seeded.frontmatter!.revision }).expect(409);
    expect(bounded.body.error).toContain("exceeded its visit limit");
  });

  it("requires lifecycle capabilities and explicitly clears machine-local sessions on release", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: true } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "claude-only", provider: "claude", available_providers: ["claude"] }).expect(204);
    const claimed = await request(app).post("/api/work/claim").send({ supervisor_id: "full", provider: "claude", available_providers: ["claude", "codex"] }).expect(200);
    const lease = claimed.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${lease}/heartbeat`).send({ pane_id: "w1:p1", session_ref: "claude-work" }).expect(200);
    await request(app).post(`/api/work/${lease}/fail`).send({ reason: "VM maintenance" }).expect(200);
    const failed = await request(app).get("/api/tickets/APT-0001").expect(200);
    const released = await request(app).post("/api/tickets/APT-0001/release-supervisor").send({ expected_revision: failed.body.frontmatter.revision }).expect(200);
    expect(released.body.frontmatter).toMatchObject({ assigned_supervisor: null, status: "ready" });
    expect(released.body.frontmatter.conversations).toEqual({});
  });

  it("rejects duplicate ticket identities before writing another file", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown() }).expect(201);
    const duplicate = await request(app).post("/api/tickets").send({
      markdown: ticketMarkdown({ title: "Different title" }),
    }).expect(409);
    expect(duplicate.body).toMatchObject({ error: "Ticket id already exists" });
    expect(duplicate.body.details[0]).toContain("APT-0001");
    const tickets = await request(app).get("/api/tickets").expect(200);
    expect(tickets.body.tickets).toHaveLength(1);
  });

  it("runs specification approval, implementation, and independent review", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown() }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const specification = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const specLease = specification.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${specLease}/complete`).send({
      summary: "Specification ready", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/1" }],
    }).expect(200);
    const waiting = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(waiting.body.frontmatter.status).toBe("waiting_approval");
    await request(app).post("/api/tickets/APT-0001/decide").send({ expected_revision: waiting.body.frontmatter.revision, decision: "approved" }).expect(200);
    const implementation = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const implementationLease = implementation.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${implementationLease}/complete`).send({ summary: "Implemented", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/2" }] }).expect(200);
    const review = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex" }).expect(200);
    const reviewLease = review.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${reviewLease}/complete`).send({ summary: "Approved", outcome: "approved" }).expect(200);
    const completed = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(completed.body.frontmatter).toMatchObject({ phase: "done", status: "completed" });
  });

  it("routes explicit Codex work to an independent Claude reviewer", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const initial = (await request(app).get("/api/config").expect(200)).body.config;
    await request(app).put("/api/config").send({
      expected_revision: initial.revision,
      providers: initial.providers,
      agent_profiles: { default: "claude", profiles: [
        { id: "claude", label: "Claude work alias", provider: "codex", model: "test-codex", reasoning: "high" },
        { id: "codex", label: "Codex review alias", provider: "claude", model: "test-claude", reasoning: "high" },
      ] },
      repositories: initial.repositories, jira: initial.jira, github: initial.github,
    }).expect(200);
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: true } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude", "codex"] }).expect(204);
    const work = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex", available_providers: ["claude", "codex"] }).expect(200);
    expect(work.body.frontmatter.conversations.work.provider).toBe("codex");
    const workLease = work.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${workLease}/heartbeat`).send({ pane_id: "w1:p1", session_ref: "codex-work" }).expect(200);
    await request(app).post(`/api/work/${workLease}/complete`).send({
      summary: "Implemented by Codex", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/9" }],
    }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex", available_providers: ["claude", "codex"] }).expect(204);
    const review = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude", "codex"] }).expect(200);
    expect(review.body.frontmatter.conversations.work.session_ref).toBe("codex-work");
    expect(review.body.frontmatter.conversations.review.session_ref).toBeNull();
    await request(app).post(`/api/work/${review.body.frontmatter.execution.lease_id}/heartbeat`).send({ pane_id: "w2:p1", session_ref: "claude-review" }).expect(200);
    const reviewing = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(reviewing.body.frontmatter.conversations.work.session_ref).toBe("codex-work");
    expect(reviewing.body.frontmatter.conversations.review.session_ref).toBe("claude-review");
  });

  it("keeps provider choice in workflow profiles even when work and review use the same harness", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const initial = (await request(app).get("/api/config").expect(200)).body.config;
    const configured = await request(app).put("/api/config").send({
      expected_revision: initial.revision,
      providers: initial.providers,
      agent_profiles: { default: "claude", profiles: [
        { id: "claude", label: "Work alias", provider: "codex", model: "work-model", reasoning: "high" },
        { id: "codex", label: "Review alias", provider: "codex", model: "review-model", reasoning: "high" },
      ] },
      repositories: initial.repositories, jira: initial.jira, github: initial.github,
    }).expect(200);
    expect(configured.body.config.agent_profiles.profiles).toHaveLength(2);
    const created = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown() }).expect(201);
    expect(created.body.frontmatter.workflow.resolved_agent_profiles).toMatchObject({
      "standard-delivery/implementation": { provider: "codex", model: "work-model" },
      "standard-delivery/review": { provider: "codex", model: "review-model" },
    });
  });

  it("returns active leases to a restarting supervisor with an absolute ticket path", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(claim.body.path).toMatch(/^\//);
    const active = await request(app).get("/api/work/active?supervisor_id=vm&provider=claude").expect(200);
    expect(active.body.tickets).toHaveLength(1);
    expect(active.body.tickets[0].frontmatter.execution.lease_id).toBe(claim.body.frontmatter.execution.lease_id);
    await request(app).get("/api/work/active?supervisor_id=other&provider=claude").expect(200).expect({ tickets: [] });
  });

  it("persists rich Herdr observations and exposes active runtime monitoring", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${lease}/heartbeat`).send({
      observed_state: "working", pane_id: "w1:p1", session_ref: "claude-session",
      herdr_observation: {
        pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term-1", focused: false,
        cwd: "/srv/projects", foreground_cwd: "/srv/projects/demo", terminal_title_stripped: "Running tests",
        revision: 18, session_source: "herdr:claude", session_kind: "path", tokens: { model: "qwen" },
      },
    }).expect(200);
    const runtime = await request(app).get("/api/runtime").expect(200);
    expect(runtime.body.agents).toHaveLength(1);
    expect(runtime.body.agents[0]).toMatchObject({
      ticket_id: "APT-0001", provider: "claude", pane_id: "w1:p1",
      herdr: { state: "working", workspace_id: "w1", foreground_cwd: "/srv/projects/demo", tokens: { model: "qwen" } },
    });
    expect(runtime.body.agents[0].herdr.observed_at).toEqual(expect.any(String));
    expect(runtime.body.agents[0].herdr.state_changed_at).toEqual(expect.any(String));
  });

  it("requeues assignment-delivery failures without taking a workflow edge and confirms the retry", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);

    // Act: the first lease prepares a reusable pane but cannot deliver its prompt.
    const first = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const firstLease = first.body.frontmatter.execution.lease_id as string;
    expect(first.body.frontmatter.execution).toMatchObject({ delivery_status: "starting", delivery_confirmed_at: null });
    await request(app).post(`/api/work/${firstLease}/heartbeat`).send({ pane_id: "w1:p1", session_ref: "claude-session" }).expect(200);
    const failed = await request(app).post(`/api/work/${firstLease}/delivery-failed`).send({ reason: "Herdr prompt stalled twice." }).expect(200);

    // Assert: the same node is immediately retryable and its conversation identity is retained.
    expect(failed.body).toMatchObject({ requeued: true, blocked: false, ticket: { frontmatter: { status: "ready", workflow: { current_node: "implementation" } } } });
    expect(failed.body.ticket.frontmatter.workflow.node_runs.find((run: { outcome: string }) => run.outcome === "delivery_failed"))
      .toMatchObject({ status: "failed", outcome: "delivery_failed", summary: "Herdr prompt stalled twice." });
    expect(failed.body.ticket.frontmatter.conversations.work).toMatchObject({ herdr_pane_id: "w1:p1", session_ref: "claude-session" });

    const second = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(second.body.frontmatter.workflow.current_node).toBe("implementation");
    expect(second.body.frontmatter.workflow.node_runs.filter((run: { node_id: string }) => run.node_id === "implementation")).toHaveLength(2);
    const secondLease = second.body.frontmatter.execution.lease_id as string;
    const delivered = await request(app).post(`/api/work/${secondLease}/delivered`).send({ confirmation: "submitted_staged_prompt" }).expect(200);
    expect(delivered.body.ticket.frontmatter.execution).toMatchObject({ delivery_status: "delivered", delivery_confirmed_at: expect.any(String) });
    expect(delivered.body.ticket.body).toContain("Assignment delivery recovered by submitting the staged prompt; agent monitoring started.");
    const runtime = await request(app).get("/api/runtime").expect(200);
    expect(runtime.body.agents[0]).toMatchObject({ delivery_status: "delivered", delivery_confirmed_at: expect.any(String), attempt: 2 });
  });

  it("blocks the same node after three consecutive assignment-delivery failures", async () => {
    // Arrange
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);

    // Act and assert
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
      const result = await request(app).post(`/api/work/${claim.body.frontmatter.execution.lease_id}/delivery-failed`)
        .send({ reason: `Delivery attempt ${attempt} failed.` }).expect(200);
      expect(result.body).toMatchObject(attempt === 3 ? { requeued: false, blocked: true } : { requeued: true, blocked: false });
    }
    const ticket = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(ticket.body.frontmatter).toMatchObject({ status: "blocked", workflow: { node_attempts: { implementation: { consecutive_lease_losses: 3 } } } });
    expect(ticket.body.frontmatter.workflow.node_runs.map((run: { outcome: string }) => run.outcome).filter((outcome: string) => outcome === "delivery_failed")).toEqual([
      "delivery_failed", "delivery_failed", "delivery_failed",
    ]);
  });

  it("rejects stale callbacks and replays an exact terminal callback", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;
    const payload = { summary: "Done", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/1" }] };
    const first = await request(app).post(`/api/work/${lease}/complete`).send(payload).expect(200);
    const replay = await request(app).post(`/api/work/${lease}/complete`).send(payload).expect(200);
    expect(replay.body).toEqual(first.body);
    await request(app).post(`/api/work/${lease}/complete`).send({ ...payload, summary: "Different" }).expect(409);
  });

  it("persists guidance and human comments before delivery", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;
    const guided = await request(app).post("/api/tickets/APT-0001/guidance").send({
      expected_revision: claim.body.frontmatter.revision, message: "Preserve the public API.",
    }).expect(200);
    await request(app).post("/api/tickets/APT-0001/comment").send({
      expected_revision: guided.body.frontmatter.revision, message: "Operator note.",
    }).expect(200);
    const pending = await request(app).get(`/api/work/${lease}/guidance?after=0`).expect(200);
    expect(pending.body.guidance).toHaveLength(1);
    const sequence = pending.body.guidance[0].sequence as number;
    await request(app).post(`/api/work/${lease}/heartbeat`).send({ guidance_cursor: sequence, observed_state: "working" }).expect(200);
    const ticket = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(ticket.body.markdown).toContain("human.guidance");
    expect(ticket.body.markdown).toContain("human.commented");
    expect(ticket.body.frontmatter.execution.guidance[0].delivered_at).not.toBeNull();
  });

  it("guides active description edits and interrupts before restarting an explicit workflow node", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;

    const continued = await request(app).put("/api/tickets/APT-0001").send({
      expected_revision: claim.body.frontmatter.revision,
      markdown: String(claim.body.markdown).replace("Complete the requested work.", "Continue with the revised requirement."),
    }).expect(200);
    expect(continued.body.frontmatter).toMatchObject({ phase: "implementation", status: "running" });
    expect(continued.body.frontmatter.execution.guidance[0].message).toContain("Reread the authoritative ticket");
    const refreshedAssignment = await request(app).get(`/api/work/${lease}/assignment`).expect(200);
    expect(refreshedAssignment.body.markdown).toContain("Continue with the revised requirement.");
    expect(refreshedAssignment.body).toMatchObject({
      workflow_node: { type: "agent" },
      node_prompt: { id: "implementation" },
    });
    await request(app).get("/api/work/stale-lease/assignment").expect(409);
    const guidance = await request(app).get(`/api/work/${lease}/guidance?after=0`).expect(200);
    expect(guidance.body.guidance[0].message).toContain("revision");

    const revised = await request(app).put("/api/tickets/APT-0001").send({
      expected_revision: continued.body.frontmatter.revision,
      markdown: String(continued.body.markdown).replace("Continue with the revised requirement.", "Specify the revised requirement first."),
    }).expect(200);
    const restart = await request(app).post("/api/tickets/APT-0001/workflow/migrate").send({
      expected_revision: revised.body.frontmatter.revision, workflow_id: "standard-delivery", node_id: "specification",
    }).expect(200);
    expect(restart.body.frontmatter).toMatchObject({
      phase: "implementation", status: "running",
      execution: { lease_id: lease, interrupt_request: { target_phase: "specification", target_node: "specification" } },
    });
    await request(app).post("/api/work/claim").send({ supervisor_id: "other", provider: "claude" }).expect(204);
    await request(app).post(`/api/work/${lease}/complete`).send({
      summary: "Stale completion", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/1" }],
    }).expect(409);
    const control = await request(app).get(`/api/work/${lease}/control`).expect(200);
    expect(control.body.interrupt).toMatchObject({ target_phase: "specification" });
    const acknowledged = await request(app).post(`/api/work/${lease}/interrupt-ack`).send({}).expect(200);
    expect(acknowledged.body.frontmatter).toMatchObject({ phase: "specification", status: "ready", execution: null, workflow: { incoming: { source_node: "implementation", target_node: "specification", outcome: "operator_interrupt", actor: "operator" } } });
    await request(app).post(`/api/work/${lease}/heartbeat`).send({ observed_state: "working" }).expect(409);
  });

  it("preserves Claude and Codex ticket conversations through feedback and repair loops", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const pr = [{ repository: "demo", url: "https://github.com/example/demo/pull/42" }];
    const initial = (await request(app).get("/api/config").expect(200)).body.config;
    await request(app).put("/api/config").send({
      expected_revision: initial.revision,
      providers: initial.providers,
      agent_profiles: { default: "claude", profiles: [
        { id: "claude", label: "Claude work", provider: "claude", model: "test-claude", reasoning: "high" },
        { id: "codex", label: "Codex review", provider: "codex", model: "test-codex", reasoning: "high" },
      ] },
      repositories: initial.repositories, jira: initial.jira, github: initial.github,
    }).expect(200);
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown() }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex" }).expect(204);

    const spec1 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    await request(app).post(`/api/work/${spec1.body.frontmatter.execution.lease_id}/heartbeat`).send({ pane_id: "w1:p1", session_ref: "claude-ticket-1" }).expect(200);
    await request(app).post(`/api/work/${spec1.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Specified", pull_requests: pr }).expect(200);
    let current = await request(app).get("/api/tickets/APT-0001").expect(200);
    await request(app).post("/api/tickets/APT-0001/decide").send({ expected_revision: current.body.frontmatter.revision, decision: "changes_requested", message: "Cover rollback." }).expect(200);
    const spec2 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(spec2.body.frontmatter.conversations.work.session_ref).toBe("claude-ticket-1");
    await request(app).post(`/api/work/${spec2.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Updated specification", pull_requests: pr }).expect(200);
    current = await request(app).get("/api/tickets/APT-0001").expect(200);
    await request(app).post("/api/tickets/APT-0001/decide").send({ expected_revision: current.body.frontmatter.revision, decision: "approved" }).expect(200);

    const implementation1 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(implementation1.body.frontmatter.conversations.work.session_ref).toBe("claude-ticket-1");
    await request(app).post(`/api/work/${implementation1.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Implemented", pull_requests: pr }).expect(200);
    const review1 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex" }).expect(200);
    await request(app).post(`/api/work/${review1.body.frontmatter.execution.lease_id}/heartbeat`).send({ pane_id: "w2:p1", session_ref: "codex-review-1" }).expect(200);
    await request(app).post(`/api/work/${review1.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Repair edge case.", outcome: "changes_requested" }).expect(200);

    const implementation2 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(implementation2.body.frontmatter.conversations.work.session_ref).toBe("claude-ticket-1");
    await request(app).post(`/api/work/${implementation2.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Repaired", pull_requests: pr }).expect(200);
    const review2 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex" }).expect(200);
    expect(review2.body.frontmatter.conversations.review.session_ref).toBe("codex-review-1");
    await request(app).post(`/api/work/${review2.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Approved", outcome: "approved" }).expect(200);
    current = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(current.body.frontmatter).toMatchObject({ phase: "done", status: "completed" });
  }, 15_000);

  it("accepts a batch of agent questions and resumes only after every answer", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown(), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id;
    let asked = await request(app).post(`/api/work/${lease}/ask`).send({
      questions: [
        { question: "Which compatibility target?", options: ["Current only", "Current and previous"] },
        { question: "May I add a dependency?", options: ["Yes", "No", "Only if maintained"] },
      ],
    }).expect(200);
    expect(asked.body.frontmatter).toMatchObject({
      status: "blocked",
      questions: [
        { question: "Which compatibility target?", options: ["Current only", "Current and previous"], answer: null },
        { question: "May I add a dependency?", options: ["Yes", "No", "Only if maintained"], answer: null },
      ],
    });
    let inbox = await request(app).get("/api/tickets").expect(200);
    expect(inbox.body.tickets[0].attention).toMatchObject({ kinds: expect.arrayContaining(["question", "blocked"]), pending_questions: 2 });

    asked = await request(app).post(`/api/tickets/APT-0001/questions/${asked.body.frontmatter.questions[0].id}/answer`).send({
      expected_revision: asked.body.frontmatter.revision, answer: "Current and previous major versions.",
    }).expect(200);
    expect(asked.body.frontmatter.status).toBe("blocked");
    asked = await request(app).post(`/api/tickets/APT-0001/questions/${asked.body.frontmatter.questions[1].id}/answer`).send({
      expected_revision: asked.body.frontmatter.revision, answer: "Yes, if it is maintained.",
    }).expect(200);
    expect(asked.body.frontmatter.status).toBe("running");
    expect(asked.body.frontmatter.execution.guidance).toHaveLength(2);
    inbox = await request(app).get("/api/tickets").expect(200);
    expect(inbox.body.tickets[0].attention.pending_questions).toBe(0);
    expect(inbox.body.tickets[0].attention.kinds).not.toContain("question");
  });

  it("retains questions, supports multiple PRs per repository, and archives completed work", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ labels: ["release"] }), stage_enabled: { specification: false, review: false } }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id;
    const asked = await request(app).post(`/api/work/${lease}/ask`).send({ question: "Which compatibility target?" }).expect(200);
    expect(asked.body.frontmatter).toMatchObject({ status: "blocked", questions: [{ question: "Which compatibility target?", options: [], answer: null }] });
    expect((await request(app).get(`/api/work/${lease}/control`).expect(200)).body.waiting_for_answer).toBe(true);
    await request(app).post(`/api/work/${lease}/complete`).send({ summary: "Too early", pull_requests: [] }).expect(409);
    const question = asked.body.frontmatter.questions[0];
    const answered = await request(app).post(`/api/tickets/APT-0001/questions/${question.id}/answer`).send({
      expected_revision: asked.body.frontmatter.revision, answer: "Support the current and previous major versions.",
    }).expect(200);
    expect(answered.body.frontmatter.status).toBe("running");
    expect(answered.body.frontmatter.execution.guidance[0].message).toContain("current and previous major versions");
    const prs = [
      { repository: "demo", url: "https://github.com/example/demo/pull/10" },
      { repository: "demo", url: "https://github.com/example/demo/pull/11" },
    ];
    await request(app).post(`/api/work/${lease}/complete`).send({ summary: "Implemented", pull_requests: prs }).expect(200);
    let completed = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(completed.body.frontmatter.pull_requests).toHaveLength(2);
    let archived = await request(app).post("/api/tickets/APT-0001/archive").send({
      expected_revision: completed.body.frontmatter.revision, production_result: "succeeded", production_assessment_note: "Healthy after rollout.",
    }).expect(200);
    expect(archived.body.frontmatter.archived_at).toEqual(expect.any(String));
    expect(archived.body.frontmatter).toMatchObject({ production_result: "succeeded", production_assessment_note: "Healthy after rollout.", production_assessed_at: expect.any(String) });
    expect((await request(app).get("/api/tickets").expect(200)).body.tickets).toHaveLength(0);
    expect((await request(app).get("/api/tickets?include_archived=true").expect(200)).body.tickets).toHaveLength(1);
    archived = await request(app).post("/api/tickets/APT-0001/production-assessment").send({
      expected_revision: archived.body.frontmatter.revision, production_result: "rolled_back", production_assessment_note: "Rollback followed a delayed alert.",
    }).expect(200);
    expect(archived.body.frontmatter).toMatchObject({ production_result: "rolled_back", production_assessment_note: "Rollback followed a delayed alert." });
    const metrics = await request(app).get("/api/metrics?labels=release&label_mode=all&production_result=rolled_back").expect(200);
    expect(metrics.body.totals).toMatchObject({ tickets: 1, archived: 1, production: { rolled_back: 1 } });
    completed = await request(app).post("/api/tickets/APT-0001/unarchive").send({ expected_revision: archived.body.frontmatter.revision }).expect(200);
    expect(completed.body.frontmatter.archived_at).toBeNull();
  });
});
