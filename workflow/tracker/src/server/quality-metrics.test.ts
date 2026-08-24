import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { QualityConfig } from "./config-store.js";
import type { ArtifactRecord } from "./domain.js";
import { buildMetrics, buildWorkflowComparison } from "./metrics.js";
import { parseQualityReport } from "./quality.js";
import { TicketStore } from "./ticket-store.js";
import { ticketMarkdown } from "./test-helpers.js";
import { advanceWorkflow, beginNodeRun, finishNodeRun, initializeWorkflow, type WorkflowDocument, WorkflowLibrary } from "./workflow-library.js";

let root: string;
let store: TicketStore;
let workflows: WorkflowLibrary;

const registry: QualityConfig = {
  attributes: [
    { key: "coverage.line_percent", label: "Line coverage", type: "number", unit: "percent", direction: "higher_is_better", minimum: 0, maximum: 100 },
    { key: "security.clean", label: "Security clean", type: "boolean", unit: "", direction: "neutral", minimum: null, maximum: null },
    { key: "release.risk", label: "Release risk", type: "string", unit: "classification", direction: "neutral", minimum: null, maximum: null },
  ],
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentic-quality-metrics-"));
  workflows = new WorkflowLibrary(root);
  store = new TicketStore(root, { watch: false, workflowLibrary: workflows });
  await store.start();
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

function qualityMetadata(attributes: unknown[], config = registry, revision = 3) {
  return parseQualityReport(Buffer.from(stringify({ schema: "agentic-quality/v1", attributes })), "quality-report", [], config, revision);
}

interface ReportFixture {
  createdAt: string;
  attributes: unknown[];
  config?: QualityConfig;
}

async function createCompletedTicket(id: string, workflow: WorkflowDocument, reports: ReportFixture[], completed = true) {
  await store.create(ticketMarkdown({ id, labels: ["quality-suite"] }));
  await store.command(id, { event: "test.fixture", message: "Quality fixture recorded." }, (ticket) => {
    initializeWorkflow(ticket, workflow, {}, { stage_enabled: { specification: false, review: false } });
    ticket.status = "ready";
    const node = workflow.definition.nodes.find((candidate) => candidate.id === "implementation")!;
    ticket.workflow!.node_visits.implementation = 1;
    const run = beginNodeRun(ticket, node, workflow.revision, 1, "2026-08-18T12:00:00.000Z", "worker-1", "claude", `lease-${id}`);
    finishNodeRun(ticket, run.id, "completed", "Implementation completed.", null, "2026-08-18T12:01:00.000Z");
    ticket.artifacts.push(...reports.map((report, index): ArtifactRecord => ({
      id: `${id.toLowerCase()}-quality-${index}`,
      kind: "quality_report",
      ticket_id: id,
      node_run_id: run.id,
      filename: `quality-${index}.yaml`,
      content_type: "application/yaml",
      size_bytes: 100,
      sha256: String(index).padStart(64, "a").slice(-64),
      created_at: report.createdAt,
      metadata: qualityMetadata(report.attributes, report.config),
    })));
    if (completed) advanceWorkflow(ticket, workflow.definition, "completed", "Implementation completed.");
    else ticket.status = "failed";
    return { ticket };
  });
}

function implementationQuality(report: Awaited<ReturnType<typeof buildMetrics>>) {
  return report.workflows.flatMap((workflow) => workflow.nodes)
    .find((node) => node.node_id === "implementation")!.quality;
}

describe("quality metrics", () => {
  it("aggregates the latest report per ticket and node across numeric and categorical attributes", async () => {
    // Arrange
    const workflow = await workflows.get("standard-delivery");
    await createCompletedTicket("APT-0001", workflow, [
      { createdAt: "2026-08-18T12:00:30.000Z", attributes: [
        { key: "coverage.line_percent", value: 50, status: "fail" },
        { key: "security.clean", value: false, status: "fail" },
      ] },
      { createdAt: "2026-08-18T12:00:45.000Z", attributes: [
        { key: "coverage.line_percent", value: 90, status: "pass" },
        { key: "security.clean", value: true, status: "pass" },
        { key: "release.risk", value: "low", status: "pass" },
        { key: "ad-hoc.note", value: "not aggregated", status: "warn" },
      ] },
    ]);
    await createCompletedTicket("APT-0002", workflow, [{ createdAt: "2026-08-18T12:00:50.000Z", attributes: [
      { key: "coverage.line_percent", value: 70, status: "warn" },
      { key: "security.clean", value: false, status: "fail" },
      { key: "release.risk", value: "high", status: "warn" },
    ] }]);
    await createCompletedTicket("APT-0003", workflow, [{ createdAt: "2026-08-18T12:00:55.000Z", attributes: [
      { key: "coverage.line_percent", value: 0, status: "fail" },
    ] }], false);
    await createCompletedTicket("APT-0004", workflow, [{ createdAt: "2026-08-18T12:00:55.000Z", attributes: [
      { key: "coverage.line_percent", value: 80 },
    ] }]);

    // Act
    const report = await buildMetrics(store, workflows, { labels: ["quality-suite"], label_mode: "all", repositories: [] });
    const quality = implementationQuality(report);

    // Assert
    expect(report.totals).toMatchObject({ tickets: 4, completed: 3 });
    expect(quality.map((attribute) => attribute.key)).not.toContain("ad-hoc.note");
    expect(quality.find((attribute) => attribute.key === "coverage.line_percent")).toMatchObject({
      ticket_count: 3,
      reports: 3,
      statuses: { pass: 1, warn: 1, fail: 0, unknown: 1 },
      pass_rate: 0.5,
      numeric: { count: 3, min: 70, median: 80, max: 90 },
      values: expect.arrayContaining([{ value: "90", count: 1 }, { value: "80", count: 1 }, { value: "70", count: 1 }]),
    });
    expect(quality.find((attribute) => attribute.key === "security.clean")).toMatchObject({
      ticket_count: 2,
      reports: 2,
      numeric: null,
      statuses: { pass: 1, warn: 0, fail: 1, unknown: 0 },
      values: expect.arrayContaining([{ value: "true", count: 1 }, { value: "false", count: 1 }]),
    });
    expect(quality.find((attribute) => attribute.key === "release.risk")).toMatchObject({
      reports: 2,
      values: expect.arrayContaining([{ value: "low", count: 1 }, { value: "high", count: 1 }]),
    });
  });

  it("keeps incompatible registry semantics in separate metric series", async () => {
    // Arrange
    const workflow = await workflows.get("standard-delivery");
    const ratioRegistry: QualityConfig = { attributes: [{
      key: "coverage.line_percent", label: "Line coverage ratio", type: "number", unit: "ratio",
      direction: "higher_is_better", minimum: 0, maximum: 1,
    }] };
    await createCompletedTicket("APT-0001", workflow, [{ createdAt: "2026-08-18T12:00:30.000Z", attributes: [{ key: "coverage.line_percent", value: 80, status: "pass" }] }]);
    await createCompletedTicket("APT-0002", workflow, [{ createdAt: "2026-08-18T12:00:30.000Z", attributes: [{ key: "coverage.line_percent", value: 0.8, status: "pass" }], config: ratioRegistry }]);

    // Act
    const report = await buildMetrics(store, workflows, { labels: [], label_mode: "any", repositories: [] });
    const series = implementationQuality(report).filter((attribute) => attribute.key === "coverage.line_percent");

    // Assert
    expect(series).toHaveLength(2);
    expect(series).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: "percent", numeric: expect.objectContaining({ median: 80 }) }),
      expect.objectContaining({ unit: "ratio", numeric: expect.objectContaining({ median: 0.8 }) }),
    ]));
  });

  it("uses the final completed visit and ignores failed or unowned run artifacts", async () => {
    // Arrange
    const workflow = await workflows.get("standard-delivery");
    await createCompletedTicket("APT-0001", workflow, [{ createdAt: "2026-08-18T12:00:30.000Z", attributes: [
      { key: "coverage.line_percent", value: 40, status: "fail" },
    ] }]);
    await store.command("APT-0001", { event: "test.repair", message: "Repair visits recorded." }, (ticket) => {
      const node = workflow.definition.nodes.find((candidate) => candidate.id === "implementation")!;
      ticket.workflow!.node_visits.implementation = 2;
      const repaired = beginNodeRun(ticket, node, workflow.revision, 2, "2026-08-18T12:02:00.000Z", "worker-1", "claude", "lease-repair");
      finishNodeRun(ticket, repaired.id, "completed", "Repair passed.", null, "2026-08-18T12:03:00.000Z");
      ticket.workflow!.node_visits.implementation = 3;
      const failed = beginNodeRun(ticket, node, workflow.revision, 3, "2026-08-18T12:04:00.000Z", "worker-1", "claude", "lease-failed");
      finishNodeRun(ticket, failed.id, "failed", "Later experiment failed.", null, "2026-08-18T12:05:00.000Z");
      const artifact = (id: string, runId: string, createdAt: string, value: number): ArtifactRecord => ({
        id, kind: "quality_report", ticket_id: ticket.id, node_run_id: runId, filename: `${id}.yaml`, content_type: "application/yaml",
        size_bytes: 100, sha256: "b".repeat(64), created_at: createdAt,
        metadata: qualityMetadata([{ key: "coverage.line_percent", value, status: value >= 80 ? "pass" : "fail" }]),
      });
      ticket.artifacts.push(
        artifact("quality-repair", repaired.id, "2026-08-18T12:02:30.000Z", 95),
        artifact("quality-failed", failed.id, "2026-08-18T12:04:30.000Z", 0),
        artifact("quality-unowned", "missing-run", "2026-08-18T12:06:00.000Z", 1),
      );
      ticket.archived_at = "2026-08-19T12:00:00.000Z";
      return { ticket };
    });

    // Act
    const report = await buildMetrics(store, workflows, { labels: [], label_mode: "any", repositories: [] });
    const coverage = implementationQuality(report).find((attribute) => attribute.key === "coverage.line_percent");

    // Assert
    expect(report.totals).toMatchObject({ tickets: 1, completed: 1, archived: 1 });
    expect(coverage).toMatchObject({
      ticket_count: 1, reports: 1, statuses: { pass: 1, warn: 0, fail: 0, unknown: 0 },
      numeric: { count: 1, min: 95, median: 95, max: 95 },
    });
  });

  it("carries quality summaries into immutable workflow-revision comparisons", async () => {
    // Arrange
    const baseline = await workflows.get("standard-delivery");
    const candidateDefinition = structuredClone(baseline.definition);
    candidateDefinition.description = "Quality comparison candidate.";
    const candidate = await workflows.save(stringify(candidateDefinition), baseline.revision, undefined, undefined, undefined, { label: "Quality trial" });
    await createCompletedTicket("APT-0001", baseline, [{ createdAt: "2026-08-18T12:00:30.000Z", attributes: [{ key: "coverage.line_percent", value: 65, status: "warn" }] }]);
    await createCompletedTicket("APT-0002", candidate, [{ createdAt: "2026-08-18T12:00:30.000Z", attributes: [{ key: "coverage.line_percent", value: 92, status: "pass" }] }]);

    // Act
    const comparison = await buildWorkflowComparison(
      store,
      workflows,
      { workflow_id: baseline.definition.id, workflow_revision: baseline.revision },
      { workflow_id: candidate.definition.id, workflow_revision: candidate.revision },
      { labels: [], label_mode: "any", repositories: [] },
    );
    const baselineQuality = comparison.left.nodes.find((node) => node.node_id === "implementation")!.quality;
    const candidateQuality = comparison.right.nodes.find((node) => node.node_id === "implementation")!.quality;

    // Assert
    expect(baselineQuality).toEqual([expect.objectContaining({ key: "coverage.line_percent", pass_rate: 0, numeric: expect.objectContaining({ median: 65 }) })]);
    expect(candidateQuality).toEqual([expect.objectContaining({ key: "coverage.line_percent", pass_rate: 1, numeric: expect.objectContaining({ median: 92 }) })]);
  });
});
