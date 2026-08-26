import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { TelemetryCollector, type HarnessTelemetryAdapter, zeroTelemetryBaseline } from "./telemetry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-telemetry-"));
  roots.push(value);
  return value;
}

async function jsonl(path: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("TelemetryCollector", () => {
  it("locates native provenance logs for Codex and Claude subagents without interpreting their contents", async () => {
    // Arrange
    const home = await root();
    const codex = join(home, "codex", "sessions", "2026", "session-codex.jsonl");
    const claude = join(home, "claude", "projects", "demo", "session-claude.jsonl");
    const subagent = join(home, "claude", "projects", "demo", "session-claude", "subagents", "agent-1.jsonl");
    await jsonl(codex, [{ type: "session_meta" }]);
    await jsonl(claude, [{ type: "assistant" }]);
    await jsonl(subagent, [{ type: "assistant" }]);
    const collector = new TelemetryCollector({ codex: join(home, "codex"), claude: join(home, "claude") });

    // Execute / Verify
    await expect(collector.evidence({ harness: "codex", sessionRef: "session-codex" })).resolves.toEqual([
      expect.objectContaining({ path: codex, role: "primary", contentType: "application/x-ndjson" }),
    ]);
    await expect(collector.evidence({ harness: "claude", sessionRef: "session-claude" })).resolves.toEqual([
      expect.objectContaining({ path: claude, role: "primary" }),
      expect.objectContaining({ path: subagent, role: "subagent" }),
    ]);
  });

  it("uses zero usage for a new session baseline captured before the first token event", () => {
    const baseline = zeroTelemetryBaseline({
      schema_version: 1,
      harness: "codex",
      session_ref: "new-session",
      observed_at: "2026-08-20T23:03:26.473Z",
      source: { kind: "session_log", detail: "/tmp/new-session.jsonl" },
      model: { id: "gpt-5.6-sol", provider: "openai", observed_ids: ["gpt-5.6-sol"] },
      reasoning: { effort: "high", enabled: true, source: "session" },
      usage: null,
      cost: { total_usd: null, kind: "unavailable" },
      context: { used_tokens: null, window_tokens: 258_400, used_percent: null },
      rate_limits: [{ id: "codex:primary", name: null, used_percent: 31, window_minutes: 10_080, resets_at: "2026-08-27T04:25:50.000Z" }],
      attributes: {},
    });

    expect(baseline).toMatchObject({
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
      cost: { total_usd: null, kind: "unavailable" },
      context: { used_tokens: 0, window_tokens: 258_400, used_percent: 0 },
      rate_limits: [{ id: "codex:primary", used_percent: 31, window_minutes: 10_080 }],
      attributes: { agentic_baseline: "fresh_zero" },
    });
  });

  it("reads cumulative Codex token usage, exact model, effort, context, and rate limits", async () => {
    const home = await root();
    await jsonl(join(home, "codex", "sessions", "2026", "session-codex.jsonl"), [
      { type: "session_meta", payload: { model_provider: "openai", cli_version: "0.148.0", context_window: 200_000 } },
      { type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } },
      { type: "event_msg", payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 150 },
        last_token_usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 8, reasoning_output_tokens: 2, total_tokens: 50 },
        model_context_window: 200_000,
      }, rate_limits: { limit_id: "codex", limit_name: "Codex", plan_type: "plus", primary: { used_percent: 42, window_minutes: 300, resets_at: 1_800_000_000 } } } },
    ]);
    const collector = new TelemetryCollector({ codex: join(home, "codex"), claude: join(home, "unused") });
    const result = await collector.collect({ harness: "codex", sessionRef: "session-codex" });
    expect(result).toMatchObject({
      model: { id: "gpt-5.6-sol", provider: "openai" },
      reasoning: { effort: "high", source: "session" },
      usage: { total_tokens: 150, cached_input_tokens: 25, reasoning_output_tokens: 5 },
      context: { used_tokens: 50, window_tokens: 200_000, used_percent: 0.025 },
      cost: { total_usd: null, kind: "unavailable" },
    });
    expect(result?.rate_limits[0]).toMatchObject({ used_percent: 42, window_minutes: 300 });
  });

  it("deduplicates Claude transcript records and includes subagent usage", async () => {
    const home = await root();
    const main = join(home, "claude", "projects", "demo", "session-claude.jsonl");
    const response = { type: "assistant", version: "2.1.89", message: { id: "msg-1", model: "claude-opus-4-1", usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 5, service_tier: "standard" }, content: [{ type: "thinking", thinking: "hidden" }] } };
    await jsonl(main, [response, response]);
    await jsonl(join(home, "claude", "projects", "demo", "session-claude", "subagents", "agent-1.jsonl"), [
      { type: "assistant", version: "2.1.89", message: { id: "msg-2", model: "claude-opus-4-1", usage: { input_tokens: 3, output_tokens: 2 }, content: [] } },
    ]);
    await writeFile(join(home, "claude", "settings.json"), JSON.stringify({ effortLevel: "medium" }));
    const collector = new TelemetryCollector({ codex: join(home, "unused"), claude: join(home, "claude"), cache: join(home, "cache") });
    const result = await collector.collect({ harness: "claude", sessionRef: "session-claude" });
    expect(result).toMatchObject({
      model: { id: "claude-opus-4-1", provider: "anthropic" },
      reasoning: { effort: "medium", enabled: true, source: "current_configuration" },
      usage: { input_tokens: 13, cached_input_tokens: 4, cache_write_input_tokens: 2, output_tokens: 7, total_tokens: 26 },
      attributes: { cli_version: "2.1.89", assistant_responses: 2, subagent_transcripts: 1 },
    });
    await mkdir(join(home, "cache", "claude"), { recursive: true });
    await writeFile(join(home, "cache", "claude", "session-claude.json"), JSON.stringify({
      session_id: "session-claude", version: "2.1.90", model: { id: "claude-opus-4-1", display_name: "Opus" },
      cost: { total_cost_usd: 0.1234, total_duration_ms: 5000, total_lines_added: 12 },
      context_window: { total_input_tokens: 20000, total_output_tokens: 500, context_window_size: 200000, used_percentage: 10.25 },
      effort: { level: "high" }, thinking: { enabled: true }, rate_limits: { five_hour: { used_percentage: 37, resets_at: 1_800_000_000 } },
    }));
    const live = await collector.collect({ harness: "claude", sessionRef: "session-claude" });
    expect(live).toMatchObject({
      source: { kind: "session_log+statusline" }, reasoning: { effort: "high", enabled: true, source: "live_session" },
      cost: { total_usd: 0.1234, kind: "estimated" }, context: { used_tokens: 20500, window_tokens: 200000, used_percent: 10.25 },
      attributes: { model_display_name: "Opus", total_duration_ms: 5000, total_lines_added: 12 },
    });
    expect(live?.rate_limits[0]).toMatchObject({ id: "five_hour", used_percent: 37 });
  });

  it("supports future harnesses through adapter registration", async () => {
    const collector = new TelemetryCollector({ codex: "/missing", claude: "/missing" });
    const adapter: HarnessTelemetryAdapter = { harness: "future", collect: async ({ sessionRef }) => ({
      schema_version: 1, harness: "future", session_ref: sessionRef, observed_at: "2026-08-18T00:00:00.000Z",
      source: { kind: "api", detail: null }, model: { id: "future-1", provider: "vendor", observed_ids: ["future-1"] },
      reasoning: { effort: "adaptive", enabled: true, source: "api" }, usage: null,
      cost: { total_usd: null, kind: "unavailable" }, context: { used_tokens: null, window_tokens: null, used_percent: null },
      rate_limits: [], attributes: {},
    }) };
    collector.register(adapter);
    expect(await collector.collect({ harness: "future", sessionRef: "abc" })).toMatchObject({ harness: "future", session_ref: "abc" });
  });
});
