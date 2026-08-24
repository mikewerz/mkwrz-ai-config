import { describe, expect, it } from "vitest";
import type { HarnessTelemetrySnapshot } from "./domain.js";
import { estimateTelemetryCost } from "./pricing.js";

const pricing = {
  estimate_missing_costs: true,
  models: [{
    id: "codex-gpt-5.6-sol", provider: "codex" as const, model: "gpt-5.6-sol",
    input_per_million_usd: 5, cached_input_per_million_usd: 0.5,
    cache_write_input_per_million_usd: 6.25, output_per_million_usd: 30,
    source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-sol", effective_at: "2026-08-19",
  }],
};

function snapshot(cost: HarnessTelemetrySnapshot["cost"] = { total_usd: null, kind: "unavailable" }): HarnessTelemetrySnapshot {
  return {
    schema_version: 1, harness: "codex", session_ref: "session-1", observed_at: "2026-08-19T12:00:00.000Z",
    source: { kind: "session_log", detail: "rollout.jsonl" },
    model: { id: "gpt-5.6-sol", provider: "openai", observed_ids: ["gpt-5.6-sol"] },
    reasoning: { effort: "high", enabled: true, source: "session" },
    usage: { input_tokens: 1_000_000, cached_input_tokens: 500_000, cache_write_input_tokens: 100_000, output_tokens: 200_000, reasoning_output_tokens: 50_000, total_tokens: 1_800_000 },
    cost, context: { used_tokens: null, window_tokens: null, used_percent: null }, rate_limits: [], attributes: {},
  };
}

describe("provider-neutral token pricing", () => {
  it("estimates each observed token category and records the pricing revision", () => {
    expect(estimateTelemetryCost(snapshot(), pricing)!.cost).toEqual({
      total_usd: 11.875, kind: "estimated", source: pricing.models[0]!.source_url,
      pricing_id: "codex-gpt-5.6-sol", effective_at: "2026-08-19",
    });
  });

  it("never replaces harness-reported cost and leaves unmatched models unknown", () => {
    expect(estimateTelemetryCost(snapshot({ total_usd: 2.5, kind: "reported" }), pricing)!.cost).toEqual({ total_usd: 2.5, kind: "reported" });
    expect(estimateTelemetryCost({ ...snapshot(), model: { id: "future-model", provider: "openai", observed_ids: ["future-model"] } }, pricing)!.cost)
      .toEqual({ total_usd: null, kind: "unavailable" });
  });
});
