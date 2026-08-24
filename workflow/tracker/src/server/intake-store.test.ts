import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { IntakeStore } from "./intake-store.js";
import { TicketStore } from "./ticket-store.js";

const roots: string[] = [];
const stores: TicketStore[] = [];

async function context(clock = () => new Date("2026-08-20T12:00:00.000Z"), leaseTtlMs = 120_000) {
  const root = await mkdtemp(join(tmpdir(), "agentic-intake-"));
  roots.push(root);
  const tickets = new TicketStore(root, { watch: false, now: clock });
  await tickets.start();
  stores.push(tickets);
  const intake = new IntakeStore(root, tickets, clock, leaseTtlMs);
  await intake.start();
  await intake.saveCampaign(stringify({
    version: 1, id: "continuous-improvement", name: "Continuous improvement", description: "Improve the app.", enabled: true,
    limits: { max_new_per_run: 100, max_new_per_day: 100, max_open: 50, max_working: 10, max_observed_unarchived: 100 }, success_policy: {},
  }));
  await intake.saveSource(stringify({
    version: 1, id: "new-relic", name: "New Relic", description: "Discover performance work.", enabled: true, campaign_id: "continuous-improvement",
    schedule: { interval_minutes: 60 }, runner: { type: "supervisor_script", language: "shell", script_path: ".agents/intake/new-relic.sh", working_directory: ".", timeout_seconds: 300 },
    ticket: { workflow_id: "standard-delivery", repositories: [{ id: "demo", primary: true }], labels: ["performance"], priority: 1, mark_ready: false, workflow_inputs: {}, stage_enabled: {} },
    limits: { max_new_per_run: 1, max_new_per_day: 20, max_open: 20, max_working: 5, max_observed_unarchived: 30 },
  }));
  return { root, tickets, intake };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("IntakeStore", () => {
  it("records each discovery run while admitting bounded, deduplicated tickets", async () => {
    // Arrange
    const { intake } = await context();
    let admitted = 0;
    intake.setAdmitter(async () => `AGENT-${String(++admitted).padStart(4, "0")}`);

    // Execute
    const scheduled = await intake.scheduleDue();
    const claimed = await intake.claim("worker-a");
    const result = await intake.complete(claimed!.lease_id, {
      candidates: [
        { external_key: "NR-1", title: "Slow endpoint", description: "Reduce p95 latency." },
        { external_key: "NR-2", title: "Slow query", description: "Remove the repeated query." },
      ],
      cursor: { last_issue: 2 },
      output: "found two candidates\n",
    });
    const repeated = await intake.submitExternal("new-relic", [{ external_key: "NR-1", title: "Slow endpoint", description: "Still slow." }]);

    // Verify
    expect(scheduled).toEqual({ scheduled: 1, admitted_deferred: 0 });
    expect(result.candidates.map((candidate) => candidate.decision)).toEqual(["admitted", "deferred"]);
    expect(result.run.decisions).toMatchObject({ admitted: 1, deferred: 1 });
    expect(repeated.candidates[0]).toMatchObject({ decision: "duplicate", ticket_id: "AGENT-0001", observation_count: 2 });
    expect(await intake.output("new-relic", result.run.id)).toBe("found two candidates\n");
    expect((await intake.metrics()).totals).toMatchObject({ runs: 2, candidates: 2, admitted: 1, deferred: 1 });
  });

  it("requeues an expired source lease without losing its pinned source revision or cursor", async () => {
    // Arrange
    let now = new Date("2026-08-20T12:00:00.000Z");
    const { intake } = await context(() => now, 1_000);
    await intake.trigger("new-relic");
    const first = await intake.claim("worker-a");

    // Execute
    now = new Date("2026-08-20T12:00:02.000Z");
    const second = await intake.claim("worker-b");

    // Verify
    expect(second).toMatchObject({ id: first!.id, source_revision: first!.source_revision, supervisor_id: "worker-b", attempt: 2 });
    expect(second!.lease_id).not.toBe(first!.lease_id);
  });

  it("previews discovery results without admitting candidates or advancing the source cursor", async () => {
    // Arrange
    const { intake } = await context();
    let admissions = 0;
    intake.setAdmitter(async () => { admissions += 1; return "AGENT-0001"; });
    const enabledSource = await intake.source("new-relic");
    await intake.saveSource(enabledSource.content.replace("enabled: true", "enabled: false"), enabledSource.revision);
    await intake.trigger("new-relic", true);
    const claimed = await intake.claim("worker-a");

    // Execute
    const preview = await intake.complete(claimed!.lease_id, {
      candidates: [
        { external_key: "NR-1", title: "Slow endpoint", description: "Reduce p95 latency." },
        { external_key: "", title: "Incomplete candidate" },
      ],
      cursor: { last_issue: 99 },
      output: "previewed two candidates\n",
    });

    // Verify
    expect(preview.candidates).toEqual([]);
    expect(preview.run).toMatchObject({ mode: "preview", status: "completed", candidates_received: 2, cursor_before: null, cursor_after: null });
    expect(preview.run.preview_candidates).toEqual([
      { external_key: "NR-1", title: "Slow endpoint", valid: true, errors: [] },
      expect.objectContaining({ title: "Incomplete candidate", valid: false }),
    ]);
    expect(admissions).toBe(0);
    expect(await intake.listCandidates()).toEqual([]);
    expect((await intake.metrics()).totals).toMatchObject({ runs: 0, preview_runs: 1, candidates: 0 });
    const disabledSource = await intake.source("new-relic");
    await intake.saveSource(disabledSource.content.replace("enabled: false", "enabled: true"), disabledSource.revision);
    expect(await intake.scheduleDue()).toEqual({ scheduled: 1, admitted_deferred: 0 });
    expect(await intake.claim("worker-b")).toMatchObject({ mode: "admit", cursor_before: null });
  });

  it("rejects source definitions that reference an unknown campaign", async () => {
    // Arrange
    const { intake } = await context();
    const content = stringify({
      version: 1, id: "orphan", name: "Orphan", enabled: true, campaign_id: "missing", schedule: { interval_minutes: 60 },
      runner: { type: "external" }, ticket: { workflow_id: "standard-delivery", repositories: [{ id: "demo", primary: true }] }, limits: {},
    });

    // Execute and verify
    await expect(intake.saveSource(content)).rejects.toMatchObject({ status: 422 });
  });
});
