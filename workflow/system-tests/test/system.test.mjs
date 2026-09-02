import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  cleanup,
  jsonRequest,
  readHerdrInvocations,
  sanitizedEnvironment,
  startSupervisor,
  startSupervisorWithoutExplicitHerdr,
  startTracker,
  stopProcess,
  trackerRoot,
  waitFor,
} from "./support/harness.mjs";
import { agentWorkflow, createFixtureRepository, scriptWorkflow, ticketMarkdown } from "./support/fixtures.mjs";

const execute = promisify(execFile);

async function configureTracker(tracker, repositoryUrl, options = {}) {
  const current = (await jsonRequest(tracker.baseUrl, "/api/config")).body.config;
  const body = {
    expected_revision: current.revision,
    repositories: repositoryUrl ? [{ id: "fixture-repo", url: repositoryUrl }] : [],
    providers: { enabled: ["claude"] },
    agent_profiles: {
      default: "fake-claude",
      profiles: [{ id: "fake-claude", label: "Fake Claude system-test profile", provider: "claude", model: "fake-model", reasoning: "test" }],
    },
    quality: {
      attributes: [{
        key: "tests.pass_rate",
        label: "Test pass rate",
        type: "number",
        unit: "ratio",
        direction: "higher_is_better",
        minimum: 0,
        maximum: 1,
      }],
    },
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.demo ? { demo: options.demo } : {}),
  };
  return (await jsonRequest(tracker.baseUrl, "/api/config", { method: "PUT", body })).body.config;
}

async function writeOrphanArtifact(ticketRoot, { ticketId, nodeRunId = null, kind = "script_artifact", content, ageHours = 48 }) {
  const id = randomUUID();
  const bytes = Buffer.from(content, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const blob = join(ticketRoot, ".artifacts", "blobs", "sha256", digest.slice(0, 2), digest);
  const record = join(ticketRoot, ".artifacts", "records", `${id}.json`);
  await mkdir(join(ticketRoot, ".artifacts", "records"), { recursive: true });
  await mkdir(join(ticketRoot, ".artifacts", "blobs", "sha256", digest.slice(0, 2)), { recursive: true });
  const createdAt = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  await writeFile(blob, bytes);
  await writeFile(record, `${JSON.stringify({
    id, kind, ticket_id: ticketId, node_run_id: nodeRunId, filename: `${id}.txt`, content_type: "text/plain",
    size_bytes: bytes.byteLength, sha256: digest, created_at: createdAt.toISOString(), metadata: {},
  }, null, 2)}\n`);
  await utimes(blob, createdAt, createdAt);
  await utimes(record, createdAt, createdAt);
  return { id, blob, record };
}

test("system subprocess environments remove provider credentials", () => {
  const names = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = `must-not-leak-${name}`;
    const environment = sanitizedEnvironment();
    for (const name of names) assert.equal(environment[name], undefined, `${name} must be removed`);
  } finally {
    for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
  }
});

test("an agent-enabled test supervisor fails closed without an explicit fake Herdr executable", { timeout: 15_000 }, async () => {
  let tracker;
  let supervisor;
  try {
    tracker = await startTracker();
    supervisor = await startSupervisorWithoutExplicitHerdr(tracker);
    assert.notEqual(supervisor.process.child.exitCode, 0);
    assert.match(supervisor.process.logs().stderr, /require an explicit HERDR_EXECUTABLE/);
    const supervisors = (await jsonRequest(tracker.baseUrl, "/api/supervisors")).body.supervisors;
    assert.ok(!supervisors.some((item) => item.supervisor_id === "fail-closed-supervisor"));
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});

test("tracker exposes readiness, its Markdown index, and background operation state", async () => {
  let tracker;
  try {
    tracker = await startTracker();
    const readiness = await jsonRequest(tracker.baseUrl, "/api/readyz");
    assert.equal(readiness.response.status, 200);
    assert.equal(readiness.body.ready, true);
    assert.equal(readiness.body.ticket_store.writable, true);
    assert.equal(readiness.body.ticket_store.ticket_count, 0);
    assert.equal(typeof readiness.body.ticket_store.index_generation, "number");
    assert.equal(readiness.body.background_operations.github_observation.in_progress, false);
    assert.equal(readiness.body.background_operations.artifact_maintenance.in_progress, false);
    assert.equal(readiness.body.background_operations.intake_scheduling.in_progress, false);
    const capabilities = await jsonRequest(tracker.baseUrl, "/api/capabilities");
    assert.deepEqual(capabilities.body.supervisor_protocol_versions, [1, 2, 3]);
    assert.deepEqual(capabilities.body.intake_protocol_versions, [1]);
    assert.ok(capabilities.body.activity_capabilities.includes("git_checkpoint"));
    assert.ok(capabilities.body.activity_capabilities.includes("git_restore"));
  } finally {
    await stopProcess(tracker?.process);
    await cleanup([tracker?.ticketRoot]);
  }
});

test("demo mode traverses a real workflow in tracker memory without scheduling Herdr or affecting metrics", { timeout: 20_000 }, async () => {
  let tracker;
  let supervisor;
  try {
    // Arrange: keep an online, agent-enabled supervisor present so accidental scheduling is observable.
    tracker = await startTracker();
    await configureTracker(tracker, null, { demo: { enabled: true, step_duration_seconds: 1 } });
    supervisor = await startSupervisor(tracker);
    const definition = agentWorkflow("system-demo");
    definition.nodes[0].outcomes[0].target = "approval";
    definition.nodes.splice(1, 0, {
      id: "approval", name: "Approve demo", type: "human_gate", phase: "implementation", stage: "work",
      choices: [
        { id: "approved", label: "Approve", description: "Complete the demo.", target: "done", metric_class: "success" },
        { id: "changes_requested", label: "Request changes", description: "Repeat simulated work.", target: "fake-work", metric_class: "neutral", comment_required: true },
      ],
    });
    const workflow = await publishWorkflow(tracker, definition);

    // Execute: create a DEMO ticket directly in the selected shipped workflow.
    const created = (await jsonRequest(tracker.baseUrl, "/api/tickets", {
      method: "POST", expected: 201,
      body: { markdown: ticketMarkdown("DEMO-0001"), workflow_id: workflow.definition.id },
    })).body;
    assert.equal(created.frontmatter.demo, true);
    assert.equal(created.frontmatter.status, "running");

    const gated = await waitFor("demo ticket to reach its human gate", async () => {
      const ticket = (await jsonRequest(tracker.baseUrl, "/api/tickets/DEMO-0001")).body;
      return ticket.frontmatter.status === "waiting_approval" ? ticket : null;
    }, { timeoutMs: 5_000 });

    // Verify: the real gate is interactive, but every external/durable accounting surface remains untouched.
    assert.equal(gated.workflow_node.type, "human_gate");
    assert.ok(gated.workflow_node.choices.length > 0);
    assert.deepEqual(gated.frontmatter.pull_requests, [{
      repository: "fixture-repo", phase: "implementation", url: "demo://pull-request/DEMO-0001/fixture-repo/implementation",
    }]);
    assert.deepEqual((await jsonRequest(tracker.baseUrl, "/api/runtime")).body.agents, []);
    assert.equal((await jsonRequest(tracker.baseUrl, "/api/metrics")).body.totals.tickets, 0);
    assert.equal((await readHerdrInvocations(supervisor)).length, 0);
    assert.ok(!(await readdir(tracker.ticketRoot)).some((name) => name === "DEMO-0001.md"));

    const decision = gated.workflow_node.choices[0].id;
    const advanced = (await jsonRequest(tracker.baseUrl, "/api/tickets/DEMO-0001/decide", {
      method: "POST", body: { expected_revision: gated.frontmatter.revision, decision },
    })).body;
    assert.notEqual(advanced.frontmatter.workflow.current_node, gated.frontmatter.workflow.current_node);

    const cleared = (await jsonRequest(tracker.baseUrl, "/api/demo-tickets", { method: "DELETE" })).body;
    assert.equal(cleared.cleared, 1);
    await jsonRequest(tracker.baseUrl, "/api/tickets/DEMO-0001", { expected: 404 });
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});

test("a workflow bundle round-trips through two tracker processes with its exact prompt revisions", { timeout: 30_000 }, async () => {
  let source;
  let target;
  try {
    source = await startTracker();
    target = await startTracker();
    await configureTracker(source, null);
    await configureTracker(target, null);
    const sourcePrompts = (await jsonRequest(source.baseUrl, "/api/prompts")).body.prompts;
    const implementation = sourcePrompts.find((prompt) => prompt.name === "implementation");
    const promptContent = "Use the portable team implementation policy.\n\nAllowed outcomes:\n\n{{allowed_outcomes}}\n";
    const updatedPrompt = (await jsonRequest(source.baseUrl, "/api/prompts/implementation", {
      method: "PUT", body: { expected_revision: implementation.revision, content: promptContent },
    })).body.prompt;
    const published = await publishWorkflow(source, agentWorkflow("portable-system-workflow"));

    const exportedResponse = await fetch(new URL(`/api/workflows/${published.definition.id}/revisions/${published.revision}/export`, source.baseUrl));
    assert.equal(exportedResponse.status, 200);
    assert.match(exportedResponse.headers.get("content-disposition"), /portable-system-workflow-v1\.workflow\.json/);
    const bundle = await exportedResponse.json();
    assert.equal(bundle.schema, "agentic-project-tracker/workflow-bundle/v1");
    assert.deepEqual(bundle.requirements.agent_profiles, ["fake-claude"]);
    assert.equal(bundle.prompts.find((prompt) => prompt.name === "implementation").revision, updatedPrompt.revision);

    const imported = (await jsonRequest(target.baseUrl, "/api/workflow-bundles/import", {
      method: "POST", expected: 201, body: bundle,
    })).body;
    assert.equal(imported.workflow.revision, published.revision);
    assert.equal(imported.release.is_default, true);
    assert.equal(imported.release.status, "active");
    assert.ok(imported.installed_prompt_revisions.includes(`implementation@${updatedPrompt.revision}`));
    const targetPrompt = (await jsonRequest(target.baseUrl, "/api/prompts")).body.prompts.find((prompt) => prompt.name === "implementation");
    assert.equal(targetPrompt.revision, updatedPrompt.revision);
    assert.equal(targetPrompt.content, promptContent);
  } finally {
    await stopProcess(source?.process);
    await stopProcess(target?.process);
    await cleanup([source?.ticketRoot, target?.ticketRoot]);
  }
});

test("a supervisor Script source previews safely, admits one ordinary ticket, and deduplicates the next observation without Herdr", { timeout: 30_000 }, async () => {
  let tracker;
  let supervisor;
  try {
    tracker = await startTracker();
    const campaign = `version: 1
id: system-improvement
name: System improvement
description: Repeated discovery system test.
enabled: true
limits:
  max_new_per_run: 100
  max_new_per_day: 100
  max_open: 50
  max_working: 10
  max_observed_unarchived: 100
success_policy: {}
`;
    await jsonRequest(tracker.baseUrl, "/api/intake/campaigns/system-improvement", { method: "PUT", body: { content: campaign } });
    const source = `version: 1
id: system-discovery
name: System discovery
description: Emits one stable candidate.
enabled: true
campaign_id: system-improvement
schedule:
  interval_minutes: 60
runner:
  type: supervisor_script
  language: shell
  script_path: discover.sh
  working_directory: .
  timeout_seconds: 10
ticket:
  workflow_id: standard-delivery
  repositories:
    - id: fixture-repo
      primary: true
  labels: [system-intake]
  priority: 2
  mark_ready: false
  workflow_inputs: {}
  stage_enabled:
    specification: false
    review: false
limits:
  max_new_per_run: 2
  max_new_per_day: 10
  max_open: 10
  max_working: 2
  max_observed_unarchived: 10
`;
    await jsonRequest(tracker.baseUrl, "/api/intake/sources/system-discovery", { method: "PUT", body: { content: source } });
    const projectRoot = await mkdtemp(join(tmpdir(), "agentic-system-intake-projects-"));
    await writeFile(join(projectRoot, "discover.sh"), `set -eu
printf '%s\\n' '{"candidates":[{"external_key":"finding-42","title":"Fix finding 42","description":"Resolve the stable discovered finding."}],"cursor":{"last":42}}' > "$AGENTIC_INTAKE_RESULT_PATH"
printf '%s\\n' "discovered finding-42"
`);
    await jsonRequest(tracker.baseUrl, "/api/intake/sources/system-discovery/run", { method: "POST", expected: 201, body: { preview: true } });
    supervisor = await startSupervisor(tracker, { projectRoot, agentExecutionEnabled: false });

    const preview = await waitFor("safe intake preview", async () => {
      const overview = (await jsonRequest(tracker.baseUrl, "/api/intake")).body;
      return overview.recent_runs.find((run) => run.source_id === "system-discovery" && run.mode === "preview" && run.status === "completed") ?? null;
    }, { timeoutMs: 15_000 });
    assert.equal(preview.candidates_received, 1);
    assert.deepEqual(preview.preview_candidates, [{ external_key: "finding-42", title: "Fix finding 42", valid: true, errors: [] }]);
    assert.equal((await jsonRequest(tracker.baseUrl, "/api/tickets?include_archived=true")).body.tickets.length, 0);
    assert.equal((await jsonRequest(tracker.baseUrl, "/api/intake")).body.recent_candidates.length, 0);

    await jsonRequest(tracker.baseUrl, "/api/intake/sources/system-discovery/run", { method: "POST", expected: 201, body: {} });

    const first = await waitFor("first intake admission", async () => {
      const overview = (await jsonRequest(tracker.baseUrl, "/api/intake")).body;
      return overview.recent_candidates.find((candidate) => candidate.external_key === "finding-42" && candidate.ticket_id) ? overview : null;
    }, { timeoutMs: 15_000 });
    const candidate = first.recent_candidates.find((item) => item.external_key === "finding-42");
    assert.equal(candidate.decision, "admitted");
    const ticket = (await jsonRequest(tracker.baseUrl, `/api/tickets/${candidate.ticket_id}`)).body;
    assert.equal(ticket.frontmatter.metadata["intake.source_id"], "system-discovery");
    assert.equal(ticket.frontmatter.metadata["intake.external_key"], "finding-42");
    assert.equal(ticket.frontmatter.status, "pending");
    const completedRun = first.recent_runs.find((run) => run.source_id === "system-discovery" && run.status === "completed");
    const output = await fetch(new URL(`/api/intake/sources/system-discovery/runs/${completedRun.id}/output`, tracker.baseUrl));
    assert.equal(output.status, 200);
    assert.match(await output.text(), /discovered finding-42/);

    await jsonRequest(tracker.baseUrl, "/api/intake/sources/system-discovery/run", { method: "POST", expected: 201, body: {} });
    const repeated = await waitFor("deduplicated second intake observation", async () => {
      const overview = (await jsonRequest(tracker.baseUrl, "/api/intake")).body;
      const current = overview.recent_candidates.find((item) => item.external_key === "finding-42");
      return current?.observation_count === 2 ? overview : null;
    }, { timeoutMs: 15_000 });
    const repeatedCandidate = repeated.recent_candidates.find((item) => item.external_key === "finding-42");
    assert.equal(repeatedCandidate.decision, "duplicate");
    assert.equal(repeatedCandidate.ticket_id, candidate.ticket_id);
    assert.equal((await jsonRequest(tracker.baseUrl, "/api/tickets?include_archived=true")).body.tickets.length, 1);
    assert.deepEqual(await readHerdrInvocations(supervisor), []);
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});

test("the bundled outside-agent client remains compatible with tracker operator APIs", { timeout: 30_000 }, async () => {
  let tracker;
  let clientDirectory;
  try {
    tracker = await startTracker();
    clientDirectory = await mkdtemp(join(tmpdir(), "agentic-system-client-"));
    const client = join(trackerRoot, "skills", "agentic-project-tracker", "scripts", "tracker.py");
    const invoke = async (...args) => JSON.parse((await execute(
      "python3", [client, "--url", tracker.baseUrl, ...args], { env: sanitizedEnvironment() },
    )).stdout);

    const readiness = await invoke("readiness");
    assert.equal(readiness.data.ready, true);

    const markdownPath = join(clientDirectory, "ticket.md");
    await writeFile(markdownPath, ticketMarkdown("SYSTEM-CLIENT"));
    const created = await invoke(
      "ticket", "create", "--markdown-file", markdownPath, "--workflow-id", "standard-delivery",
    );
    assert.equal(created.status, 201);

    const attachmentPath = join(clientDirectory, "evidence.txt");
    await writeFile(attachmentPath, "client compatibility evidence\n");
    const attached = await invoke(
      "ticket", "attachment-upload", "SYSTEM-CLIENT", "--revision",
      String(created.data.frontmatter.revision), "--file", attachmentPath,
    );
    const attachment = attached.data.frontmatter.attachments[0];
    assert.equal(attachment.filename, "evidence.txt");

    const downloadPath = join(clientDirectory, "downloaded.txt");
    const downloaded = await invoke(
      "ticket", "attachment-download", "SYSTEM-CLIENT", attachment.id, "--output", downloadPath,
    );
    assert.equal(downloaded.data.size_bytes, Buffer.byteLength("client compatibility evidence\n"));
    assert.equal(await readFile(downloadPath, "utf8"), "client compatibility evidence\n");

    const prioritized = await invoke(
      "ticket", "priority", "SYSTEM-CLIENT", "2", "--revision", String(attached.data.frontmatter.revision),
    );
    assert.equal(prioritized.data.frontmatter.priority, 2);
  } finally {
    await stopProcess(tracker?.process);
    await cleanup([tracker?.ticketRoot, clientDirectory]);
  }
});

async function publishWorkflow(tracker, workflow) {
  return (await jsonRequest(tracker.baseUrl, "/api/workflows", {
    method: "POST",
    expected: 201,
    body: { content: `${JSON.stringify(workflow, null, 2)}\n` },
  })).body.workflow;
}

async function createReadyTicket(tracker, id, workflowId) {
  const created = (await jsonRequest(tracker.baseUrl, "/api/tickets", {
    method: "POST",
    expected: 201,
    body: { markdown: ticketMarkdown(id), workflow_id: workflowId },
  })).body;
  return (await jsonRequest(tracker.baseUrl, `/api/tickets/${id}/ready`, {
    method: "POST",
    body: { expected_revision: created.frontmatter.revision },
  })).body;
}

async function completedTicket(tracker, id, timeoutMs = 20_000) {
  return waitFor(`${id} to complete`, async () => {
    const ticket = (await jsonRequest(tracker.baseUrl, `/api/tickets/${id}`)).body;
    return ticket.frontmatter.status === "completed" ? ticket : null;
  }, { timeoutMs });
}

function costTelemetry(totalUsd, totalTokens) {
  return {
    schema_version: 1, harness: "claude", session_ref: "fake-cost-session", observed_at: new Date().toISOString(),
    source: { kind: "system_test", detail: null },
    model: { id: "fake-model", provider: "fake", observed_ids: ["fake-model"] },
    reasoning: { effort: "test", enabled: true, source: "system_test" },
    usage: { input_tokens: totalTokens, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: totalTokens },
    cost: { total_usd: totalUsd, kind: "reported" }, context: { used_tokens: null, window_tokens: null, used_percent: null },
    rate_limits: [], attributes: {},
  };
}

test("tracker enforces cumulative Agent-node cost across loop visits without a real harness", { timeout: 30_000 }, async () => {
  let tracker;
  try {
    tracker = await startTracker();
    await configureTracker(tracker, null);
    const workflow = await publishWorkflow(tracker, {
      version: 2, id: "system-cost-loop", name: "System cost loop", description: "Cost pause contract", start: "work", max_transitions: 10,
      inputs: [], stages: [
        { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
        { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
      ],
      nodes: [
        { id: "work", name: "Budgeted work", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", agent_profile: "fake-claude", conversation_key: "work", max_cost_usd: 0.5, outcomes: [
          { id: "again", label: "Again", description: "Repeat this node.", target: "work" },
          { id: "completed", label: "Complete", description: "Complete the workflow.", target: "done" },
        ], choices: [], exit_codes: [] },
        { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
      ],
    });
    await createReadyTicket(tracker, "SYSTEM-COST", workflow.definition.id);
    const claim = async () => (await jsonRequest(tracker.baseUrl, "/api/work/claim", {
      method: "POST", body: { supervisor_id: "direct-system-test", provider: "claude", available_providers: ["claude"] },
    })).body;
    const first = await claim();
    await jsonRequest(tracker.baseUrl, `/api/work/${first.frontmatter.execution.lease_id}/heartbeat`, { method: "POST", body: {
      telemetry: costTelemetry(1.3, 130), telemetry_baseline: costTelemetry(1, 100),
    } });
    await jsonRequest(tracker.baseUrl, `/api/work/${first.frontmatter.execution.lease_id}/complete`, { method: "POST", body: { outcome: "again", summary: "Loop" } });
    const second = await claim();
    const exceeded = (await jsonRequest(tracker.baseUrl, `/api/work/${second.frontmatter.execution.lease_id}/heartbeat`, { method: "POST", body: {
      telemetry: costTelemetry(1.51, 151), telemetry_baseline: costTelemetry(1.3, 130),
    } })).body.ticket;
    assert.deepEqual(exceeded.frontmatter.execution.interrupt_request.reason_code, "cost_limit_exceeded");
    assert.equal(exceeded.frontmatter.execution.interrupt_request.cost_observed_usd, 0.51);
    const paused = (await jsonRequest(tracker.baseUrl, `/api/work/${second.frontmatter.execution.lease_id}/interrupt-ack`, { method: "POST", body: {} })).body;
    assert.equal(paused.frontmatter.status, "blocked");
    assert.equal(paused.frontmatter.workflow.current_node, "work");
    assert.equal(paused.frontmatter.workflow.node_runs.at(-1).outcome, "cost_limit_exceeded");
  } finally {
    await stopProcess(tracker?.process);
    await cleanup([tracker?.ticketRoot]);
  }
});

test("tracker serves its production UI and preserves attachment bytes across a restart", { timeout: 30_000 }, async () => {
  const ticketRoot = await mkdtemp(join(tmpdir(), "agentic-system-persistence-"));
  let tracker;
  try {
    tracker = await startTracker({ ticketRoot });
    const page = await fetch(`${tracker.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root"><\/div>/);

    const created = (await jsonRequest(tracker.baseUrl, "/api/tickets", {
      method: "POST",
      expected: 201,
      body: { markdown: ticketMarkdown("SYSTEM-PERSIST"), workflow_id: "standard-delivery" },
    })).body;
    const content = Buffer.from("durable system-test attachment\n", "utf8");
    const upload = await fetch(new URL(`/api/tickets/SYSTEM-PERSIST/attachments?expected_revision=${created.frontmatter.revision}&filename=evidence.txt`, tracker.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Attachment-Content-Type": "text/plain" },
      body: content,
    });
    const uploadText = await upload.text();
    assert.equal(upload.status, 201, uploadText);
    const attached = JSON.parse(uploadText);
    const attachment = attached.frontmatter.attachments[0];
    assert.equal(attachment.filename, "evidence.txt");

    await stopProcess(tracker.process);
    tracker = await startTracker({ ticketRoot, port: undefined });
    const restored = (await jsonRequest(tracker.baseUrl, "/api/tickets/SYSTEM-PERSIST")).body;
    assert.equal(restored.frontmatter.attachments[0].id, attachment.id);
    const download = await fetch(new URL(`/api/tickets/SYSTEM-PERSIST/attachments/${attachment.id}/content`, tracker.baseUrl));
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  } finally {
    await stopProcess(tracker?.process);
    await cleanup([ticketRoot]);
  }
});

test("artifact diagnostics are non-destructive, maintenance recovers orphans, enforces quota, and returns stable error codes", { timeout: 30_000 }, async () => {
  let tracker;
  try {
    tracker = await startTracker();
    await configureTracker(tracker, null, { artifacts: {
      max_total_bytes: 2 * 1024 ** 2,
      max_ticket_bytes: 1024 ** 2,
      orphan_grace_hours: 1,
      retention_days: 1,
      auto_gc_enabled: true,
      gc_interval_minutes: 60,
    } });
    const workflow = await publishWorkflow(tracker, agentWorkflow("system-artifact-holder"));
    const created = (await jsonRequest(tracker.baseUrl, "/api/tickets", {
      method: "POST", expected: 201, body: { markdown: ticketMarkdown("SYSTEM-ARTIFACTS"), workflow_id: workflow.definition.id },
    })).body;

    const quotaResponse = await fetch(new URL(`/api/tickets/SYSTEM-ARTIFACTS/attachments?expected_revision=${created.frontmatter.revision}&filename=too-large.bin`, tracker.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Attachment-Content-Type": "application/octet-stream" },
      body: Buffer.alloc(1024 ** 2 + 1),
    });
    assert.equal(quotaResponse.status, 413);
    assert.equal((await quotaResponse.json()).code, "ARTIFACT_TICKET_QUOTA_EXCEEDED");

    const staleLease = await fetch(new URL("/api/work/not-a-real-lease/heartbeat", tracker.baseUrl), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(staleLease.status, 409);
    assert.equal((await staleLease.json()).code, "LEASE_STALE");
    const missingArtifact = await fetch(new URL("/api/tickets/SYSTEM-ARTIFACTS/artifacts/not-real/content", tracker.baseUrl));
    assert.equal(missingArtifact.status, 404);
    assert.equal((await missingArtifact.json()).code, "ARTIFACT_NOT_FOUND");

    const recoverable = await writeOrphanArtifact(tracker.ticketRoot, { ticketId: "SYSTEM-ARTIFACTS", content: "recover me" });
    const disposable = await writeOrphanArtifact(tracker.ticketRoot, { ticketId: "MISSING-TICKET", content: "collect me" });
    const diagnostics = (await jsonRequest(tracker.baseUrl, "/api/artifacts/diagnostics")).body;
    assert.equal(diagnostics.healthy, false);
    assert.deepEqual(new Set(diagnostics.orphan_records.map((record) => record.id)), new Set([recoverable.id, disposable.id]));
    await stat(recoverable.record);
    await stat(disposable.record);

    let commandOutput;
    try {
      commandOutput = (await execute(process.execPath, [join(trackerRoot, "dist", "server", "artifact-diagnostics.js"), tracker.ticketRoot], { env: sanitizedEnvironment() })).stdout;
      assert.fail("orphan diagnostic command should exit non-zero when findings exist");
    } catch (error) {
      assert.equal(error.code, 2);
      commandOutput = error.stdout;
    }
    const commandDiagnostics = JSON.parse(commandOutput);
    assert.ok(commandDiagnostics.orphan_records.some((record) => record.id === recoverable.id));
    await stat(recoverable.record);
    await stat(disposable.record);

    const maintenance = (await jsonRequest(tracker.baseUrl, "/api/artifacts/maintenance", { method: "POST", body: {} })).body;
    assert.ok(maintenance.recovered_records.includes(recoverable.id));
    assert.ok(maintenance.collection.removed_records.includes(disposable.id));
    const ticket = (await jsonRequest(tracker.baseUrl, "/api/tickets/SYSTEM-ARTIFACTS")).body;
    assert.ok(ticket.frontmatter.artifacts.some((artifact) => artifact.id === recoverable.id));
    await assert.rejects(stat(disposable.record), (error) => error.code === "ENOENT");
    await assert.rejects(stat(disposable.blob), (error) => error.code === "ENOENT");
    assert.equal(((await jsonRequest(tracker.baseUrl, "/api/artifacts/diagnostics")).body).healthy, true);
  } finally {
    await stopProcess(tracker?.process);
    await cleanup([tracker?.ticketRoot]);
  }
});

test("supervisor clones a configured repository and completes a Script workflow with quality evidence", { timeout: 45_000 }, async () => {
  const sourceRepository = await mkdtemp(join(tmpdir(), "agentic-system-source-"));
  let tracker;
  let supervisor;
  try {
    await createFixtureRepository(sourceRepository, "valid");
    tracker = await startTracker();
    await configureTracker(tracker, sourceRepository);
    const workflow = await publishWorkflow(tracker, scriptWorkflow({ id: "system-quality" }));
    await createReadyTicket(tracker, "SYSTEM-QUALITY", workflow.definition.id);
    supervisor = await startSupervisor(tracker, { agentExecutionEnabled: false });

    const ticket = await completedTicket(tracker, "SYSTEM-QUALITY");
    assert.equal(ticket.frontmatter.workflow.current_node, "done");
    assert.equal(ticket.frontmatter.workflow.node_runs.length, 1);
    assert.equal(ticket.frontmatter.workflow.node_runs[0].node_id, "verify");
    assert.equal(ticket.frontmatter.workflow.node_runs[0].outcome, "passed");
    assert.match(ticket.frontmatter.workflow.node_runs[0].output, /fixture verification complete/);

    await waitFor("execution manifest upload", async () => {
      const current = (await jsonRequest(tracker.baseUrl, "/api/tickets/SYSTEM-QUALITY")).body;
      return current.frontmatter.artifacts.some((artifact) => artifact.kind === "execution_manifest") ? current : null;
    });
    const refreshed = (await jsonRequest(tracker.baseUrl, "/api/tickets/SYSTEM-QUALITY")).body;
    const quality = refreshed.frontmatter.artifacts.find((artifact) => artifact.kind === "quality_report");
    assert.ok(quality, "expected a normalized quality-report artifact");
    assert.equal(quality.metadata.quality_report.overall_status, "pass");
    assert.deepEqual(quality.metadata.quality_report.attributes.map((attribute) => attribute.key), ["tests.pass_rate"]);

    const downloaded = await fetch(new URL(`/api/tickets/SYSTEM-QUALITY/artifacts/${quality.id}/content`, tracker.baseUrl));
    assert.equal(downloaded.status, 200);
    assert.match(await downloaded.text(), /schema: agentic-quality\/v1/);

    const metrics = (await jsonRequest(tracker.baseUrl, "/api/metrics?workflow_id=system-quality")).body;
    const workflowMetrics = metrics.workflows.find((entry) => entry.workflow_id === "system-quality");
    assert.equal(workflowMetrics.ticket_count, 1);
    const node = workflowMetrics.nodes.find((entry) => entry.node_id === "verify");
    assert.equal(node.runs, 1);
    assert.equal(node.success_rate, 1);
    assert.equal(node.quality[0].key, "tests.pass_rate");
    assert.equal(node.quality[0].numeric.median, 1);

    const clonedScript = await readFile(join(supervisor.projectRoot, "fixture-repo", ".agents", "actions", "quality.sh"), "utf8");
    assert.match(clonedScript, /agentic-quality\/v1/);
    assert.deepEqual(await readHerdrInvocations(supervisor), [], "Script-only work must not invoke Herdr, even the fake executable");

    const persistedMarkdown = await readFile(join(tracker.ticketRoot, "SYSTEM-QUALITY.md"), "utf8");
    assert.match(persistedMarkdown, /run_ledger:/, "ticket YAML must reference the dedicated run ledger");
    assert.match(persistedMarkdown, /node_runs: \[\]/, "complete node-run history must not remain embedded in ticket YAML");
    const ledgerKey = createHash("sha256").update("SYSTEM-QUALITY").digest("hex");
    const ledger = JSON.parse(await readFile(join(tracker.ticketRoot, ".runs", ledgerKey, "ledger", `${refreshed.frontmatter.revision}.json`), "utf8"));
    assert.equal(ledger.ticket_id, "SYSTEM-QUALITY");
    assert.equal(ledger.runs.length, 1);

    const correlatedLog = supervisor.process.logs().stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .find((line) => line.event === "work.activity_reported");
    assert.deepEqual({ ticket_id: correlatedLog.ticket_id, node_id: correlatedLog.node_id, lease_id: typeof correlatedLog.lease_id }, {
      ticket_id: "SYSTEM-QUALITY", node_id: "verify", lease_id: "string",
    });

    const ticketRoot = tracker.ticketRoot;
    await stopProcess(supervisor.process);
    await stopProcess(tracker.process);
    tracker = await startTracker({ ticketRoot });
    const restored = (await jsonRequest(tracker.baseUrl, "/api/tickets/SYSTEM-QUALITY")).body;
    assert.equal(restored.frontmatter.workflow.node_runs.length, 1, "run history must hydrate after tracker restart");
    assert.equal(restored.frontmatter.workflow.node_runs[0].node_id, "verify");
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([sourceRepository, supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});

test("a rejected required artifact leaves the lease unresolved and the same Script node succeeds on retry", { timeout: 45_000 }, async () => {
  const sourceRepository = await mkdtemp(join(tmpdir(), "agentic-system-retry-source-"));
  let tracker;
  let supervisor;
  try {
    await createFixtureRepository(sourceRepository, "invalid-first");
    tracker = await startTracker({ leaseTtlMs: 600 });
    await configureTracker(tracker, sourceRepository);
    const workflow = await publishWorkflow(tracker, scriptWorkflow({ id: "system-quality-retry" }));
    await createReadyTicket(tracker, "SYSTEM-RETRY", workflow.definition.id);
    supervisor = await startSupervisor(tracker, { heartbeatIntervalMs: 100, idlePollMs: 50, agentExecutionEnabled: false });

    const ticket = await completedTicket(tracker, "SYSTEM-RETRY", 30_000);
    const attempts = ticket.frontmatter.workflow.node_attempts.verify;
    assert.equal(attempts.total, 2);
    assert.equal(attempts.consecutive_lease_losses, 0);
    assert.equal(ticket.frontmatter.workflow.node_runs.length, 2);
    assert.equal(ticket.frontmatter.workflow.node_runs[0].outcome, "lease_lost");
    assert.equal(ticket.frontmatter.workflow.node_runs[1].outcome, "passed");
    assert.equal(ticket.frontmatter.artifacts.filter((artifact) => artifact.kind === "quality_report").length, 1);
    assert.deepEqual(await readHerdrInvocations(supervisor), [], "artifact recovery must remain an agent-free activity retry");
    assert.match(supervisor.process.logs().stderr, /schema must be agentic-quality\/v1/);
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([sourceRepository, supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});

test("an Agent node uses only fake Herdr and advances through its declared callback", { timeout: 45_000 }, async () => {
  let tracker;
  let supervisor;
  try {
    tracker = await startTracker();
    await configureTracker(tracker, null);
    const workflow = await publishWorkflow(tracker, agentWorkflow("system-fake-agent"));
    await createReadyTicket(tracker, "SYSTEM-FAKE-AGENT", workflow.definition.id);
    supervisor = await startSupervisor(tracker, { fakeHerdrPublishEvidence: true, fakeHerdrTranscriptNotIdleReads: 1 });

    const ticket = await completedTicket(tracker, "SYSTEM-FAKE-AGENT");
    assert.equal(ticket.frontmatter.workflow.current_node, "done");
    assert.equal(ticket.frontmatter.workflow.node_runs.length, 1);
    assert.equal(ticket.frontmatter.workflow.node_runs[0].outcome, "completed");
    assert.match(ticket.frontmatter.workflow.node_runs[0].summary, /Deterministic fake agent/);
    assert.equal(ticket.frontmatter.conversations.work.provider, "claude");
    assert.equal(ticket.frontmatter.conversations.work.session_ref, "fake-session-1");
    const tracedTicket = await waitFor("completed operational trace", async () => {
      const current = (await jsonRequest(tracker.baseUrl, "/api/tickets/SYSTEM-FAKE-AGENT")).body;
      return current.frontmatter.artifacts.some((artifact) => artifact.kind === "execution_trace" && artifact.metadata.completed === true) ? current : null;
    });
    const traceChunks = tracedTicket.frontmatter.artifacts.filter((artifact) => artifact.kind === "execution_trace");
    assert.ok(traceChunks.length >= 1, "the supervisor must stream a tracker-owned operational trace");
    const traceEvents = [];
    for (const chunk of traceChunks.sort((left, right) => left.metadata.first_sequence - right.metadata.first_sequence)) {
      const response = await fetch(`${tracker.baseUrl}/api/tickets/SYSTEM-FAKE-AGENT/artifacts/${chunk.id}/content`);
      assert.equal(response.status, 200);
      traceEvents.push(...(await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    }
    assert.deepEqual(traceEvents.map((event) => event.sequence), traceEvents.map((_event, index) => index + 1));
    assert.ok(traceEvents.some((event) => event.event === "herdr.command_started" && event.data.command === "agent.prompt"));
    assert.ok(traceEvents.some((event) => event.event === "delivery.confirmed"));
    assert.ok(traceEvents.some((event) => event.event === "provenance.herdr_transcript_retry" && event.data.error_code === "agent_not_idle"));
    assert.ok(traceEvents.some((event) => event.event === "execution.trace_finished"));
    assert.ok(traceEvents.every((event) => !JSON.stringify(event).includes("You are assigned ticket SYSTEM-FAKE-AGENT")), "trace records hashes and paths instead of duplicating prompt bodies");
    const evidence = ticket.frontmatter.artifacts.find((artifact) => artifact.kind === "evidence");
    assert.deepEqual(evidence?.metadata?.presentation, {
      title: "System-test review", description: "Evidence published through the generated assignment helper.", category: "approval", featured: true,
    });
    const evidenceResponse = await fetch(`${tracker.baseUrl}/api/tickets/SYSTEM-FAKE-AGENT/artifacts/${evidence.id}/content`);
    assert.equal(evidenceResponse.status, 200);
    assert.match(await evidenceResponse.text(), /deterministic system-test agent published this evidence/);

    const governedTicket = await waitFor("tracker-owned agent provenance evidence", async () => {
      const current = (await jsonRequest(tracker.baseUrl, "/api/tickets/SYSTEM-FAKE-AGENT")).body;
      const kinds = new Set(current.frontmatter.artifacts.map((artifact) => artifact.kind));
      return kinds.has("agent_transcript") && kinds.has("harness_session_log") ? current : null;
    });
    const transcript = governedTicket.frontmatter.artifacts.find((artifact) => artifact.kind === "agent_transcript");
    const nativeLog = governedTicket.frontmatter.artifacts.find((artifact) => artifact.kind === "harness_session_log");
    assert.equal(transcript.metadata.source, "herdr");
    assert.equal(transcript.metadata.disposition, "callback");
    assert.equal(nativeLog.metadata.source, "harness");
    assert.equal(nativeLog.metadata.provider, "claude");
    const transcriptResponse = await fetch(`${tracker.baseUrl}/api/tickets/SYSTEM-FAKE-AGENT/artifacts/${transcript.id}/content`);
    assert.equal(transcriptResponse.status, 200);
    assert.match(await transcriptResponse.text(), /Completion callback accepted/);
    const nativeResponse = await fetch(`${tracker.baseUrl}/api/tickets/SYSTEM-FAKE-AGENT/artifacts/${nativeLog.id}/content`);
    assert.equal(nativeResponse.status, 200);
    assert.match(await nativeResponse.text(), /no-model-started/);

    const manifestedTicket = await waitFor("agent execution manifest", async () => {
      const current = (await jsonRequest(tracker.baseUrl, "/api/tickets/SYSTEM-FAKE-AGENT")).body;
      return current.frontmatter.artifacts.some((artifact) => artifact.kind === "execution_manifest") ? current : null;
    });
    const manifestArtifact = manifestedTicket.frontmatter.artifacts.find((artifact) => artifact.kind === "execution_manifest");
    const manifestResponse = await fetch(`${tracker.baseUrl}/api/tickets/SYSTEM-FAKE-AGENT/artifacts/${manifestArtifact.id}/content`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.inputs.incoming, null, "the manifest must retain the node's original input instead of the terminal transition");
    assert.equal(typeof manifest.inputs.ticket_revision, "number");
    assert.deepEqual(manifest.inputs.workflow_inputs, {});
    assert.deepEqual(manifest.inputs.prior_artifacts, []);

    const invocations = await waitFor("fake Herdr callback cleanup", async () => {
      const observed = await readHerdrInvocations(supervisor);
      return observed.some(({ args }) => args[0] === "agent" && args[1] === "send-keys") ? observed : null;
    });
    const commands = invocations.map(({ args }) => args.slice(0, 2).join(" "));
    assert.ok(commands.includes("workspace create"));
    assert.ok(commands.includes("agent start"));
    assert.ok(commands.includes("agent prompt"));
    assert.ok(commands.includes("agent get"));
    assert.ok(commands.includes("agent send-keys"));

    const active = JSON.parse(await readFile(join(supervisor.assignmentRoot, "system-test-supervisor", "tickets", "SYSTEM-FAKE-AGENT", "ACTIVE.json"), "utf8"));
    const startHere = await readFile(active.start_here, "utf8");
    assert.match(startHere, /Before becoming idle/);
    assert.match(startHere, /callback/);
    assert.match(startHere, /publish-artifact/);
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});

test("a prompt staged in the agent composer is submitted without duplicating the assignment", { timeout: 45_000 }, async () => {
  let tracker;
  let supervisor;
  try {
    tracker = await startTracker({ leaseTtlMs: 1_500 });
    await configureTracker(tracker, null);
    const workflow = await publishWorkflow(tracker, agentWorkflow("system-agent-staged-prompt"));
    await createReadyTicket(tracker, "SYSTEM-STAGED-PROMPT", workflow.definition.id);
    supervisor = await startSupervisor(tracker, {
      fakeHerdrStageStalledPrompt: true, fakeHerdrReadyAfterGets: 3,
      heartbeatIntervalMs: 100, idlePollMs: 50,
    });

    const ticket = await completedTicket(tracker, "SYSTEM-STAGED-PROMPT", 30_000);
    assert.equal(ticket.frontmatter.workflow.current_node, "done");
    assert.equal(ticket.frontmatter.workflow.node_runs.length, 1);
    assert.equal(ticket.frontmatter.workflow.node_runs[0].outcome, "completed");

    const invocations = await readHerdrInvocations(supervisor);
    const firstPrompt = invocations.findIndex(({ args }) => args[0] === "agent" && args[1] === "prompt");
    assert.ok(firstPrompt > 0);
    assert.ok(invocations.slice(0, firstPrompt).filter(({ args }) => args[0] === "agent" && args[1] === "get").length >= 4, "the supervisor must wait for interactive readiness before prompting");
    assert.equal(invocations.filter(({ args }) => args[0] === "agent" && args[1] === "prompt").length, 1, "the full assignment must be pasted only once");
    assert.ok(invocations.some(({ args }) => args[0] === "agent" && args[1] === "read"), "the stalled pane must be inspected");
    assert.ok(invocations.some(({ args }) => args[0] === "agent" && args[1] === "send-keys" && args.includes("enter")), "the staged composer must be submitted with Enter");
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});

test("a timed-out prompt staged in the agent composer is recovered before delivery is confirmed", { timeout: 45_000 }, async () => {
  let tracker;
  let supervisor;
  try {
    tracker = await startTracker({ leaseTtlMs: 1_500 });
    await configureTracker(tracker, null);
    const workflow = await publishWorkflow(tracker, agentWorkflow("system-agent-timeout-staged-prompt"));
    await createReadyTicket(tracker, "SYSTEM-TIMEOUT-STAGED-PROMPT", workflow.definition.id);
    supervisor = await startSupervisor(tracker, {
      fakeHerdrStageTimeoutPrompt: true, fakeHerdrCollapseStagedPrompt: true, fakeHerdrReadyAfterGets: 3,
      heartbeatIntervalMs: 100, idlePollMs: 50,
    });

    const ticket = await completedTicket(tracker, "SYSTEM-TIMEOUT-STAGED-PROMPT", 30_000);
    assert.equal(ticket.frontmatter.workflow.current_node, "done");

    const invocations = await readHerdrInvocations(supervisor);
    assert.equal(invocations.filter(({ args }) => args[0] === "agent" && args[1] === "prompt").length, 1, "the timed-out assignment must not be pasted twice");
    assert.ok(invocations.some(({ args }) => args[0] === "agent" && args[1] === "read"), "the timed-out pane must be inspected");
    assert.ok(invocations.some(({ args }) => args[0] === "agent" && args[1] === "send-keys" && args.includes("enter")), "the staged timeout prompt must be submitted with Enter");
    const supervisorLogs = await waitFor("staged timeout recovery log", () => {
      const logs = Object.values(supervisor.process.logs()).join("\n");
      return logs.includes('"recovery":"submitted_staged_prompt"') ? logs : null;
    });
    assert.match(supervisorLogs, /"event":"assignment\.prompt_delivery_uncertain_recovery_started"/);
    assert.match(supervisorLogs, /"recovery":"submitted_staged_prompt"/);
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});

test("an unseen assignment prompt fails closed and retries on a new lease without taking a workflow edge", { timeout: 45_000 }, async () => {
  let tracker;
  let supervisor;
  try {
    tracker = await startTracker({ leaseTtlMs: 1_500 });
    await configureTracker(tracker, null);
    const workflow = await publishWorkflow(tracker, agentWorkflow("system-agent-delivery-retry"));
    await createReadyTicket(tracker, "SYSTEM-DELIVERY-RETRY", workflow.definition.id);
    supervisor = await startSupervisor(tracker, {
      fakeHerdrPromptStalls: 2, fakeHerdrStartupObservationNoise: true,
      assignmentPromptRecoveryMs: 100, heartbeatIntervalMs: 100, idlePollMs: 50,
    });

    const ticket = await completedTicket(tracker, "SYSTEM-DELIVERY-RETRY", 30_000);
    assert.equal(ticket.frontmatter.workflow.current_node, "done");
    assert.equal(ticket.frontmatter.workflow.transition_count, 1, "only the successful callback may take a workflow edge");
    assert.equal(ticket.frontmatter.workflow.node_runs.length, 3);
    assert.equal(ticket.frontmatter.workflow.node_runs[0].outcome, "delivery_failed");
    assert.equal(ticket.frontmatter.workflow.node_runs[1].outcome, "delivery_failed");
    assert.equal(ticket.frontmatter.workflow.node_runs[2].outcome, "completed");
    assert.equal(ticket.frontmatter.workflow.node_attempts["fake-work"].total, 3);
    assert.equal(ticket.frontmatter.workflow.node_attempts["fake-work"].consecutive_lease_losses, 0);
    assert.equal(ticket.frontmatter.conversations.work.session_ref, "fake-session-1");
    assert.ok(ticket.body.includes("Assignment delivery failed before agent execution started"));

    const invocations = await readHerdrInvocations(supervisor);
    assert.equal(invocations.filter(({ args }) => args[0] === "agent" && args[1] === "start").length, 1, "the retry must reuse the existing pane");
    assert.equal(invocations.filter(({ args }) => args[0] === "agent" && args[1] === "prompt").length, 3, "each lease submits the full assignment at most once");
    const supervisorLogs = `${supervisor.process.logs().stdout}\n${supervisor.process.logs().stderr}`;
    assert.match(supervisorLogs, /work\.assignment_delivery_failed/);
    assert.doesNotMatch(supervisorLogs, /assignment\.callback_reminder_sent/, "an undelivered assignment must never arm the callback reminder");
  } finally {
    await stopProcess(supervisor?.process);
    await stopProcess(tracker?.process);
    await cleanup([supervisor?.projectRoot, supervisor?.assignmentRoot, tracker?.ticketRoot]);
  }
});
