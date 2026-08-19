import { createReadStream } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { HarnessTelemetrySnapshot, TokenUsage } from "./types.js";

type JsonRecord = Record<string, unknown>;

export interface TelemetryContext {
  harness: string;
  sessionRef: string;
  cwd?: string | null;
}

export interface HarnessTelemetryAdapter {
  readonly harness: string;
  collect(context: TelemetryContext): Promise<HarnessTelemetrySnapshot | null>;
}

export interface TelemetryRoots {
  codex: string;
  claude: string;
  cache: string;
}

const zeroUsage = (): TokenUsage => ({
  input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
});

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isoFromEpoch(value: unknown): string | null {
  const seconds = finite(value);
  return seconds === null ? null : new Date(seconds * 1_000).toISOString();
}

function addUsage(total: TokenUsage, value: Partial<TokenUsage>): void {
  for (const key of Object.keys(total) as Array<keyof TokenUsage>) total[key] += value[key] ?? 0;
}

function snapshotBase(harness: string, sessionRef: string, source: string, detail: string | null): HarnessTelemetrySnapshot {
  return {
    schema_version: 1, harness, session_ref: sessionRef, observed_at: new Date().toISOString(),
    source: { kind: source, detail },
    model: { id: null, provider: null, observed_ids: [] },
    reasoning: { effort: null, enabled: null, source: null },
    usage: null,
    cost: { total_usd: null, kind: "unavailable" },
    context: { used_tokens: null, window_tokens: null, used_percent: null },
    rate_limits: [], attributes: {},
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

const resolvedSessionPaths = new Map<string, string>();

async function findNamed(root: string, sessionRef: string): Promise<string | null> {
  if (isAbsolute(sessionRef) && await exists(sessionRef)) return resolve(sessionRef);
  const cacheKey = `${root}\u0000${sessionRef}`;
  const cached = resolvedSessionPaths.get(cacheKey);
  if (cached && await exists(cached)) return cached;
  if (cached) resolvedSessionPaths.delete(cacheKey);
  const wanted = new Set([sessionRef, `${sessionRef}.jsonl`]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && (wanted.has(entry.name) || entry.name.endsWith(`-${sessionRef}.jsonl`))) {
        resolvedSessionPaths.set(cacheKey, path);
        return path;
      }
    }
  }
  return null;
}

async function eachJsonLine(path: string, visit: (entry: JsonRecord) => void): Promise<void> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { const parsed = JSON.parse(line); const value = record(parsed); if (value) visit(value); } catch { /* tolerate a partial trailing record */ }
  }
}

function usageFromCodex(value: unknown): TokenUsage | null {
  const item = record(value);
  if (!item) return null;
  const input = finite(item.input_tokens) ?? 0;
  const cached = finite(item.cached_input_tokens) ?? 0;
  const cacheWrite = finite(item.cache_write_input_tokens) ?? 0;
  const output = finite(item.output_tokens) ?? 0;
  const reasoning = finite(item.reasoning_output_tokens) ?? 0;
  return {
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite,
    output_tokens: output, reasoning_output_tokens: reasoning,
    total_tokens: finite(item.total_tokens) ?? input + cached + cacheWrite + output + reasoning,
  };
}

class CodexTelemetryAdapter implements HarnessTelemetryAdapter {
  readonly harness = "codex";
  constructor(private readonly root: string) {}

  async collect(context: TelemetryContext): Promise<HarnessTelemetrySnapshot | null> {
    const path = await findNamed(join(this.root, "sessions"), context.sessionRef);
    if (!path) return null;
    const result = snapshotBase(this.harness, context.sessionRef, "session_log", path);
    const latestTokens: { value: JsonRecord | null } = { value: null };
    const models = new Set<string>();
    let latestModel: string | null = null;
    await eachJsonLine(path, (entry) => {
      const payload = record(entry.payload) ?? {};
      if (entry.type === "session_meta") {
        result.model.provider = text(payload.model_provider);
        result.attributes.cli_version = text(payload.cli_version);
        result.attributes.originator = text(payload.originator);
        result.context.window_tokens = finite(payload.context_window);
      } else if (entry.type === "turn_context") {
        const model = text(payload.model);
        if (model) { models.add(model); latestModel = model; }
        const effort = text(payload.effort);
        if (effort) result.reasoning = { effort, enabled: true, source: "session" };
      } else if (entry.type === "event_msg" && payload.type === "token_count") latestTokens.value = payload;
      else if (entry.type === "event_msg" && payload.type === "task_complete") {
        result.attributes.last_turn_duration_ms = finite(payload.duration_ms);
        result.attributes.last_turn_time_to_first_token_ms = finite(payload.time_to_first_token_ms);
      }
    });
    result.model.observed_ids = [...models];
    result.model.id = latestModel;
    if (latestTokens.value) {
      const info = record(latestTokens.value.info);
      result.usage = usageFromCodex(info?.total_token_usage);
      result.context.used_tokens = usageFromCodex(info?.last_token_usage)?.total_tokens ?? null;
      result.context.window_tokens = finite(info?.model_context_window) ?? result.context.window_tokens;
      if (result.context.used_tokens !== null && result.context.window_tokens) {
        result.context.used_percent = result.context.used_tokens / result.context.window_tokens * 100;
      }
      const limits = record(latestTokens.value.rate_limits);
      for (const key of ["primary", "secondary"] as const) {
        const limit = record(limits?.[key]);
        const used = finite(limit?.used_percent);
        if (used === null) continue;
        result.rate_limits.push({
          id: text(limits?.limit_id) ? `${String(limits!.limit_id)}:${key}` : key,
          name: text(limits?.limit_name), used_percent: used,
          window_minutes: finite(limit?.window_minutes), resets_at: isoFromEpoch(limit?.resets_at),
        });
      }
      result.attributes.plan_type = text(limits?.plan_type);
      result.attributes.rate_limit_reached_type = text(limits?.rate_limit_reached_type);
    }
    return result;
  }
}

function claudeUsage(value: unknown): TokenUsage | null {
  const usage = record(value);
  if (!usage) return null;
  const input = finite(usage.input_tokens) ?? 0;
  const cached = finite(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = finite(usage.cache_creation_input_tokens) ?? 0;
  const output = finite(usage.output_tokens) ?? 0;
  return {
    input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite,
    output_tokens: output, reasoning_output_tokens: 0,
    total_tokens: input + cached + cacheWrite + output,
  };
}

class ClaudeTelemetryAdapter implements HarnessTelemetryAdapter {
  readonly harness = "claude";
  constructor(private readonly root: string, private readonly cacheRoot: string) {}

  async collect(context: TelemetryContext): Promise<HarnessTelemetrySnapshot | null> {
    const main = await findNamed(join(this.root, "projects"), context.sessionRef);
    if (!main) return null;
    const result = snapshotBase(this.harness, context.sessionRef, "session_log", main);
    const paths = [main];
    const subagents = join(dirname(main), basename(main, ".jsonl"), "subagents");
    try {
      for (const entry of await readdir(subagents, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(join(subagents, entry.name));
    } catch { /* no subagents */ }
    const messages = new Map<string, { usage: TokenUsage; model: string | null; rawUsage: JsonRecord; thinking: boolean }>();
    let version: string | null = null;
    let mainModel: string | null = null;
    for (const path of paths) await eachJsonLine(path, (entry) => {
      if (entry.type !== "assistant") return;
      const message = record(entry.message);
      const usage = claudeUsage(message?.usage);
      if (!usage) return;
      const id = text(message?.id) ?? text(entry.uuid) ?? `${path}:${messages.size}`;
      const content = Array.isArray(message?.content) ? message.content : [];
      messages.set(id, {
        usage, model: text(message?.model), rawUsage: record(message?.usage) ?? {},
        thinking: content.some((item) => record(item)?.type === "thinking"),
      });
      if (path === main) mainModel = text(message?.model) ?? mainModel;
      version = text(entry.version) ?? version;
    });
    const total = zeroUsage();
    const models = new Set<string>();
    let hasThinking = false;
    let raw: JsonRecord = {};
    for (const message of messages.values()) {
      addUsage(total, message.usage);
      if (message.model) models.add(message.model);
      hasThinking ||= message.thinking;
      raw = message.rawUsage;
    }
    result.usage = messages.size ? total : null;
    result.model = { id: mainModel ?? [...models].at(-1) ?? null, provider: "anthropic", observed_ids: [...models] };
    result.reasoning.enabled = hasThinking;
    result.attributes.cli_version = version;
    result.attributes.assistant_responses = messages.size;
    result.attributes.subagent_transcripts = Math.max(0, paths.length - 1);
    for (const key of ["service_tier", "speed", "inference_geo"] as const) result.attributes[key] = text(raw[key]);
    let configuredEffort: string | null = null;
    const settingsPaths = [join(this.root, "settings.json"),
      ...(context.cwd ? [join(context.cwd, ".claude", "settings.json"), join(context.cwd, ".claude", "settings.local.json")] : [])];
    for (const settingsPath of settingsPaths) try {
      const settings = record(JSON.parse(await readFile(settingsPath, "utf8")));
      configuredEffort = text(settings?.effortLevel) ?? configuredEffort;
    } catch { /* this configuration layer is absent */ }
    if (configuredEffort) result.reasoning = { effort: configuredEffort, enabled: hasThinking, source: "current_configuration" };
    const statusIds = [...new Set([context.sessionRef, basename(main, ".jsonl")].filter((value) => /^[A-Za-z0-9._-]+$/.test(value)))];
    for (const statusId of statusIds) try {
      const status = record(JSON.parse(await readFile(join(this.cacheRoot, "claude", `${statusId}.json`), "utf8")));
      if (!status) continue;
      const statusModel = record(status.model);
      const statusCost = record(status.cost);
      const statusContext = record(status.context_window);
      const currentContext = record(statusContext?.current_usage);
      const statusEffort = record(status.effort);
      const statusThinking = record(status.thinking);
      const exactModel = text(statusModel?.id);
      if (exactModel) { result.model.id = exactModel; if (!result.model.observed_ids.includes(exactModel)) result.model.observed_ids.push(exactModel); }
      const effort = text(statusEffort?.level);
      const thinking = typeof statusThinking?.enabled === "boolean" ? statusThinking.enabled : result.reasoning.enabled;
      if (effort || thinking !== null) result.reasoning = { effort, enabled: thinking, source: "live_session" };
      const totalCost = finite(statusCost?.total_cost_usd);
      if (totalCost !== null) result.cost = { total_usd: totalCost, kind: "estimated" };
      const currentContextTokens = (finite(currentContext?.input_tokens) ?? 0) + (finite(currentContext?.cache_creation_input_tokens) ?? 0)
        + (finite(currentContext?.cache_read_input_tokens) ?? 0) + (finite(currentContext?.output_tokens) ?? 0);
      result.context.used_tokens = currentContextTokens || (finite(statusContext?.total_input_tokens) ?? 0) + (finite(statusContext?.total_output_tokens) ?? 0) || null;
      result.context.window_tokens = finite(statusContext?.context_window_size) ?? result.context.window_tokens;
      result.context.used_percent = finite(statusContext?.used_percentage);
      const limits = record(status.rate_limits);
      for (const [id, raw] of Object.entries(limits ?? {})) {
        const limit = record(raw); const used = finite(limit?.used_percentage);
        if (used === null) continue;
        result.rate_limits.push({ id, name: id === "five_hour" ? "Five hour" : id === "seven_day" ? "Seven day" : null,
          used_percent: used, window_minutes: id === "five_hour" ? 300 : id === "seven_day" ? 10_080 : null, resets_at: isoFromEpoch(limit?.resets_at) });
      }
      result.source.kind = "session_log+statusline";
      result.attributes.model_display_name = text(statusModel?.display_name);
      result.attributes.session_name = text(status.session_name);
      result.attributes.total_duration_ms = finite(statusCost?.total_duration_ms);
      result.attributes.total_api_duration_ms = finite(statusCost?.total_api_duration_ms);
      result.attributes.total_lines_added = finite(statusCost?.total_lines_added);
      result.attributes.total_lines_removed = finite(statusCost?.total_lines_removed);
      result.attributes.exceeds_200k_tokens = typeof status.exceeds_200k_tokens === "boolean" ? status.exceeds_200k_tokens : null;
      result.attributes.cli_version = text(status.version) ?? result.attributes.cli_version;
      break;
    } catch { /* optional status-line telemetry has not been configured or emitted */ }
    return result;
  }
}

export class TelemetryCollector {
  private readonly adapters = new Map<string, HarnessTelemetryAdapter>();

  constructor(roots: Partial<TelemetryRoots> = {}) {
    const userHome = homedir();
    const cacheRoot = roots.cache ?? process.env.AGENTIC_TELEMETRY_ROOT ?? join(userHome, ".agentic-project-supervisor", "telemetry");
    this.register(new CodexTelemetryAdapter(roots.codex ?? process.env.CODEX_HOME ?? join(userHome, ".codex")));
    this.register(new ClaudeTelemetryAdapter(roots.claude ?? process.env.CLAUDE_CONFIG_DIR ?? join(userHome, ".claude"), cacheRoot));
  }

  register(adapter: HarnessTelemetryAdapter): void { this.adapters.set(adapter.harness, adapter); }

  async collect(context: TelemetryContext): Promise<HarnessTelemetrySnapshot | null> {
    return this.adapters.get(context.harness)?.collect(context) ?? null;
  }
}

export function zeroTelemetryBaseline(snapshot: HarnessTelemetrySnapshot): HarnessTelemetrySnapshot {
  return {
    ...snapshot, observed_at: snapshot.observed_at,
    usage: snapshot.usage ? zeroUsage() : null,
    cost: snapshot.cost.total_usd === null ? snapshot.cost : { total_usd: 0, kind: snapshot.cost.kind },
    context: { ...snapshot.context, used_tokens: 0, used_percent: snapshot.context.window_tokens ? 0 : null },
    rate_limits: [],
  };
}
