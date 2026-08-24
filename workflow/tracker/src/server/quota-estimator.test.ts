import { describe, expect, it } from "vitest";
import type { TicketFrontmatter, WorkflowNodeRun } from "./domain.js";
import { buildQuotaReport } from "./quota-estimator.js";

function run(options: { tokens: number; cost?: number | null; start?: number | null; end: number; reset?: string; observed: string; supervisor?: string; provider?: "claude" | "codex" }): WorkflowNodeRun {
  const provider = options.provider ?? "codex";
  const reset = options.reset ?? "2026-08-27T04:25:50.000Z";
  const usage = { input_tokens: options.tokens, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: options.tokens };
  const snapshot = (used: number, observed_at: string) => ({
    schema_version: 1 as const, harness: provider, session_ref: "session", observed_at,
    source: { kind: "session_log", detail: null }, model: { id: provider === "claude" ? "claude-opus-4-8" : "gpt-5.6-sol", provider: provider === "claude" ? "anthropic" : "openai", observed_ids: [provider === "claude" ? "claude-opus-4-8" : "gpt-5.6-sol"] },
    reasoning: { effort: "high", enabled: true, source: "session" }, usage,
    cost: { total_usd: options.cost ?? null, kind: options.cost === undefined || options.cost === null ? "unavailable" as const : "estimated" as const },
    context: { used_tokens: 0, window_tokens: 258_400, used_percent: 0 },
    rate_limits: [{ id: provider === "claude" ? "seven_day" : "codex:primary", name: "Seven day", used_percent: used, window_minutes: 10_080, resets_at: reset }],
    attributes: { plan_type: "prolite" },
  });
  return {
    id: options.observed, workflow_revision: "workflow-r1", node_id: "review", node_type: "agent", visit: 1, attempt: 1,
    status: "completed", supervisor_id: options.supervisor ?? "worker-a", provider, lease_id: "lease", started_at: options.observed,
    completed_at: options.observed, outcome: "completed", summary: null, handoff: null, output: null, input_revision: 1,
    telemetry: {
      baseline: options.start === undefined || options.start === null ? { ...snapshot(0, options.observed), rate_limits: [] } : snapshot(options.start, options.observed),
      latest: snapshot(options.end, options.observed), delta: { usage, cost_usd: options.cost ?? null },
    },
    timing: { active_ms: 1, quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, state: "active", last_accounted_at: options.observed, pause_limit_id: null, pause_until: null },
  };
}

function ticket(runs: WorkflowNodeRun[]): TicketFrontmatter {
  return { workflow: { node_runs: runs } } as unknown as TicketFrontmatter;
}

describe("subscription weekly quota estimation", () => {
  const now = new Date("2026-08-20T18:00:00Z");

  it("estimates token and API-dollar equivalents from a direct node boundary", () => {
    const report = buildQuotaReport([ticket([run({ tokens: 2_000_000, cost: 4, start: 10, end: 12, observed: "2026-08-20T12:00:00Z" })])], [], { human_day_rate_usd: 1_000 }, now);
    expect(report.accounts[0]).toMatchObject({
      status: "estimated", used_percent: 12, estimated_weekly_tokens: 100_000_000,
      estimated_weekly_api_usd: 200, token_samples: 1, cost_samples: 1, direct_samples: 1,
      percentage_points_observed: 2, confidence: "low",
    });
  });

  it("estimates Claude allowance from its normalized seven-day status-line window", () => {
    const report = buildQuotaReport([ticket([run({ provider: "claude", tokens: 1_500_000, cost: 3, start: 20, end: 23, observed: "2026-08-20T12:00:00Z" })])], [], { human_day_rate_usd: 1_000 }, now);
    expect(report.accounts).toEqual([expect.objectContaining({
      provider: "claude", limit_id: "seven_day", status: "estimated",
      estimated_weekly_tokens: 50_000_000, estimated_weekly_api_usd: 100,
    })]);
  });

  it("uses adjacent completed nodes when the harness did not report a starting percentage", () => {
    const report = buildQuotaReport([ticket([
      run({ tokens: 1_000_000, end: 20, observed: "2026-08-20T12:00:00Z" }),
      run({ tokens: 3_000_000, end: 23, observed: "2026-08-20T13:00:00Z" }),
    ])], [], { human_day_rate_usd: 1_000 }, now);
    expect(report.accounts[0]).toMatchObject({ status: "estimated", estimated_weekly_tokens: 100_000_000, token_samples: 1, direct_samples: 0 });
  });

  it("does not compare observations across reset windows", () => {
    const report = buildQuotaReport([ticket([
      run({ tokens: 1_000_000, end: 99, observed: "2026-08-20T12:00:00Z", reset: "2026-08-21T00:00:00Z" }),
      run({ tokens: 1_000_000, end: 1, observed: "2026-08-21T12:00:00Z", reset: "2026-08-28T00:00:00Z" }),
    ])], [], { human_day_rate_usd: 1_000 }, now);
    expect(report.accounts[0]).toMatchObject({ status: "insufficient_data", estimated_weekly_tokens: null, token_samples: 0 });
  });

  it("uses independent direct samples from recent weekly windows", () => {
    const report = buildQuotaReport([ticket([
      run({ tokens: 1_000_000, start: 10, end: 11, observed: "2026-08-13T12:00:00Z", reset: "2026-08-14T00:00:00Z" }),
      run({ tokens: 2_000_000, start: 20, end: 22, observed: "2026-08-20T12:00:00Z", reset: "2026-08-27T00:00:00Z" }),
    ])], [], { human_day_rate_usd: 1_000 }, now);
    expect(report.accounts[0]).toMatchObject({ estimated_weekly_tokens: 100_000_000, token_samples: 2, direct_samples: 2, confidence: "medium" });
  });

  it("shows each subscription provider without inventing a missing weekly window", () => {
    const report = buildQuotaReport([], [{ supervisor_id: "api-worker", providers: ["claude", "codex"] }], { human_day_rate_usd: 1_000 }, now);
    expect(report.accounts).toEqual([
      expect.objectContaining({ provider: "claude", account_id: "api-worker", supervisor_ids: ["api-worker"], status: "not_reported", used_percent: null }),
      expect.objectContaining({ provider: "codex", account_id: "api-worker", supervisor_ids: ["api-worker"], status: "not_reported", used_percent: null }),
    ]);
  });

  it("combines supervisors mapped to the same configured quota account", () => {
    const report = buildQuotaReport([ticket([
      run({ tokens: 1_000_000, end: 20, observed: "2026-08-20T12:00:00Z", supervisor: "worker-a" }),
      run({ tokens: 2_000_000, end: 22, observed: "2026-08-20T13:00:00Z", supervisor: "worker-b" }),
    ])], [], { human_day_rate_usd: 1_000, quota_account_aliases: { "codex:worker-a": "personal", "codex:worker-b": "personal" } }, now);
    expect(report.accounts[0]).toMatchObject({ account_id: "personal", supervisor_ids: ["worker-a", "worker-b"], estimated_weekly_tokens: 100_000_000 });
  });

  it("keeps Claude and Codex account aliases separate on one supervisor", () => {
    const report = buildQuotaReport([ticket([
      run({ provider: "claude", tokens: 1_000_000, start: 10, end: 11, observed: "2026-08-20T12:00:00Z" }),
      run({ provider: "codex", tokens: 2_000_000, start: 20, end: 22, observed: "2026-08-20T13:00:00Z" }),
    ])], [], { human_day_rate_usd: 1_000, quota_account_aliases: { "claude:worker-a": "team-claude", "codex:worker-a": "personal-codex" } }, now);
    expect(report.accounts).toEqual([
      expect.objectContaining({ provider: "claude", account_id: "team-claude", estimated_weekly_tokens: 100_000_000 }),
      expect.objectContaining({ provider: "codex", account_id: "personal-codex", estimated_weekly_tokens: 100_000_000 }),
    ]);
  });

  it("uses an existing unscoped alias only for Codex", () => {
    const report = buildQuotaReport([], [{ supervisor_id: "worker-a", providers: ["claude", "codex"] }], {
      human_day_rate_usd: 1_000, quota_account_aliases: { "worker-a": "legacy-codex" },
    }, now);
    expect(report.accounts).toEqual([
      expect.objectContaining({ provider: "claude", account_id: "worker-a" }),
      expect.objectContaining({ provider: "codex", account_id: "legacy-codex" }),
    ]);
  });
});
