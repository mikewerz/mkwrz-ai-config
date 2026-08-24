import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { HarnessTelemetrySnapshot } from "./domain.js";
import { buildMetrics, buildWorkflowComparison } from "./metrics.js";
import { TicketStore } from "./ticket-store.js";
import { ticketMarkdown } from "./test-helpers.js";
import { advanceWorkflow, beginNodeRun, finishNodeRun, initializeWorkflow, WorkflowLibrary } from "./workflow-library.js";

let root: string;
let store: TicketStore;
let workflows: WorkflowLibrary;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentic-metrics-"));
  workflows = new WorkflowLibrary(root);
  store = new TicketStore(root, { watch: false, workflowLibrary: workflows });
  await store.start();
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

function snapshot(totalTokens: number, totalUsd: number): HarnessTelemetrySnapshot {
  return {
    schema_version: 1, harness: "claude", session_ref: "session-1", observed_at: "2026-08-18T12:01:00.000Z",
    source: { kind: "session_log", detail: "session.jsonl" },
    model: { id: "claude-sonnet-4-5", provider: "anthropic", observed_ids: ["claude-sonnet-4-5"] },
    reasoning: { effort: "high", enabled: true, source: "session" },
    usage: { input_tokens: totalTokens - 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: totalTokens },
    cost: { total_usd: totalUsd, kind: "reported" }, context: { used_tokens: totalTokens, window_tokens: 100_000, used_percent: 1 },
    rate_limits: [], attributes: {},
  };
}

describe("factory metrics", () => {
  it("groups node reliability by immutable workflow revision and reports honest telemetry and production totals", async () => {
    await store.create(ticketMarkdown({ labels: ["backend", "release"] }));
    const workflow = await workflows.get("standard-delivery");
    await store.command("APT-0001", { event: "test.completed", message: "Fixture completed." }, (ticket) => {
      initializeWorkflow(ticket, workflow, {}, { stage_enabled: { specification: false, review: false } });
      ticket.status = "ready";
      const node = workflow.definition.nodes.find((candidate) => candidate.id === "implementation")!;
      ticket.workflow!.node_visits.implementation = 1;
      const run = beginNodeRun(ticket, node, workflow.revision, 1, "2026-08-18T12:00:00.000Z", "worker-1", "claude", "lease-1");
      finishNodeRun(ticket, run.id, "completed", "Implemented and verified.", null, "2026-08-18T12:01:00.000Z");
      const baseline = snapshot(100, 0.25);
      const latest = snapshot(1_100, 1.5);
      run.telemetry = { baseline, latest, delta: { usage: {
        input_tokens: 900, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1_000,
      }, cost_usd: 1.25 } };
      advanceWorkflow(ticket, workflow.definition, "completed", "Implemented and verified.");
      ticket.estimated_human_days = 2.5;
      ticket.production_result = "succeeded";
      ticket.production_assessed_at = "2026-08-18T13:00:00.000Z";
      return { ticket };
    });

    const report = await buildMetrics(store, workflows, {
      labels: ["backend"], label_mode: "all", repositories: [], production_result: "succeeded",
    }, { human_day_rate_usd: 1_200 });
    expect(report.totals).toMatchObject({
      tickets: 1, completed: 1, total_tokens: 1_000, known_cost_usd: 1.25, production_assessed: 1, production_success_rate: 1,
      estimated_human_days: 2.5, estimated_human_cost_usd: 3_000, human_day_rate_usd: 1_200,
      comparison_tickets: 1, comparison_human_cost_usd: 3_000, comparison_factory_cost_usd: 1.25,
      comparison_savings_usd: 2_998.75,
    });
    expect(report.totals.comparison_savings_rate).toBeCloseTo(0.999583);
    expect(report.coverage).toMatchObject({ agent_runs: 1, token_runs: 1, cost_runs: 1, complete_token_tickets: 1, complete_cost_tickets: 1 });
    expect(report.summaries.tokens_per_ticket).toMatchObject({ count: 1, min: 1_000, median: 1_000, max: 1_000 });
    expect(report.summaries.estimated_human_days).toMatchObject({ count: 1, median: 2.5 });
    expect(report.workflows).toHaveLength(1);
    expect(report.workflows[0]).toMatchObject({ workflow_id: "standard-delivery", workflow_revision: workflow.revision, ticket_count: 1 });
    const implementation = report.workflows[0]!.nodes.find((node) => node.node_id === "implementation");
    expect(implementation).toMatchObject({ runs: 1, success_rate: 1, classifications: { success: 1, failure: 0, neutral: 0, unclassified: 0 } });
    expect(implementation?.branches).toEqual([expect.objectContaining({ outcome: "completed", metric_class: "success", count: 1, rate: 1 })]);
    expect(report.profiles[0]).toMatchObject({ provider: "claude", model: "claude-sonnet-4-5", reasoning: "high", runs: 1, token_runs: 1, cost_runs: 1 });

    const excluded = await buildMetrics(store, workflows, { labels: ["frontend"], label_mode: "any", repositories: [] });
    expect(excluded.totals.tickets).toBe(0);

    const changed = structuredClone(workflow.definition); changed.description = "Comparison candidate.";
    const trial = await workflows.save(stringify(changed), workflow.revision, undefined, undefined, undefined, { label: "Candidate" });
    await store.create(ticketMarkdown({ id: "APT-0002", labels: ["backend"] }));
    await store.command("APT-0002", { event: "test.completed", message: "Candidate completed." }, (ticket) => {
      initializeWorkflow(ticket, trial, {}, { stage_enabled: { specification: false, review: false }, assignment_selection: "manual_trial" });
      ticket.status = "ready";
      const node = trial.definition.nodes.find((candidate) => candidate.id === "implementation")!;
      ticket.workflow!.node_visits.implementation = 1;
      const run = beginNodeRun(ticket, node, trial.revision, 1, "2026-08-18T12:00:00.000Z", "worker-2", "claude", "lease-2");
      finishNodeRun(ticket, run.id, "completed", "Candidate completed.", null, "2026-08-18T12:00:30.000Z");
      advanceWorkflow(ticket, trial.definition, "completed", "Candidate completed.");
      return { ticket };
    });
    const comparison = await buildWorkflowComparison(store, workflows,
      { workflow_id: workflow.definition.id, workflow_revision: workflow.revision },
      { workflow_id: trial.definition.id, workflow_revision: trial.revision },
      { labels: ["backend"], label_mode: "all", repositories: [] });
    expect(comparison.left.cohort).toMatchObject({ assigned: 1, completed: 1, efficiency_eligible: 1 });
    expect(comparison.right.cohort).toMatchObject({ assigned: 1, completed: 1, efficiency_eligible: 1 });
    expect(comparison.left.nodes[0]).toMatchObject({ node_id: "implementation", runs: 1 });
    expect(comparison.right.nodes[0]).toMatchObject({ node_id: "implementation", runs: 1 });
    expect(comparison.deltas.completion_rate.absolute).toBe(0);
  });
});
