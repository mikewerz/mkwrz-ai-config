import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { AgentObservation, Provider } from "./types.js";

const exec = promisify(execFile);
const PANE_BUSY_RETRY_INTERVAL_MS = 500;
const PANE_BUSY_RETRY_TIMEOUT_MS = 10_000;
const AGENT_READY_POLL_INTERVAL_MS = 500;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface CommandRunner {
  run(args: string[]): Promise<unknown>;
  runText?(args: string[]): Promise<string>;
}

export interface HerdrControllerOptions {
  agentReadyTimeoutMs?: number;
  agentReadySettleMs?: number;
}

export class HerdrCli implements CommandRunner {
  constructor(private readonly session: string, private readonly binary = "herdr", private readonly commandTimeoutMs = 45_000) {
    if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs < 1_000) throw new Error("Herdr command timeout must be at least 1000ms");
  }
  private async execute(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(this.binary, ["--session", this.session, ...args], {
        maxBuffer: 2_000_000, timeout: this.commandTimeoutMs, killSignal: "SIGKILL",
      });
      return stdout;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string | Buffer };
      if (failure.killed || failure.code === "ETIMEDOUT") {
        const timedOut = new Error(`Herdr command timed out after ${this.commandTimeoutMs}ms: ${args.slice(0, 2).join(" ")}`);
        Object.assign(timedOut, { code: "HERDR_COMMAND_TIMEOUT", cause: error, stderr: failure.stderr });
        throw timedOut;
      }
      throw error;
    }
  }

  async run(args: string[]): Promise<unknown> {
    const trimmed = (await this.execute(args)).trim();
    return trimmed ? JSON.parse(trimmed) : {};
  }

  async runText(args: string[]): Promise<string> {
    return (await this.execute(args)).trimEnd();
  }
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Herdr returned a non-object response");
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") throw new Error("Herdr response has no result object");
  return result as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === "string") return record[key];
  return null;
}

function tokenValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function jsonErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["code", "error_code"]) if (typeof record[key] === "string") return record[key];
  for (const key of ["error", "details"]) {
    if (typeof record[key] === "string") return record[key];
    const nested = jsonErrorCode(record[key]);
    if (nested) return nested;
  }
  if (typeof record.kind === "string") return record.kind;
  return null;
}

function commandErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const stderrValue = (error as { stderr?: unknown }).stderr;
  const stderr = typeof stderrValue === "string" ? stderrValue : Buffer.isBuffer(stderrValue) ? stderrValue.toString("utf8") : "";
  const candidates = [stderr.trim(), ...stderr.split(/\r?\n/).map((line) => line.trim()).reverse()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const code = jsonErrorCode(JSON.parse(candidate));
      if (code) return code;
    } catch { /* Herdr may emit a non-JSON diagnostic before its JSON error line. */ }
  }
  return null;
}

export function resumeArguments(provider: Provider, sessionRef: string | null): string[] {
  if (!sessionRef) return [];
  if (provider === "claude") return ["--resume", sessionRef];
  return ["resume", sessionRef];
}

export function launchArguments(provider: Provider, sessionRef: string | null, model?: string | null, reasoning?: string | null): string[] {
  const modelArgs = model ? ["--model", model] : [];
  if (provider === "codex") {
    const reasoningArgs = reasoning ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`] : [];
    return sessionRef ? ["resume", sessionRef, ...modelArgs, ...reasoningArgs] : [...modelArgs, ...reasoningArgs];
  }
  const reasoningArgs = reasoning ? ["--effort", reasoning] : [];
  return [...modelArgs, ...reasoningArgs, ...resumeArguments(provider, sessionRef)];
}

export function agentName(ticketId: string, provider: Provider, conversation: string): string {
  const compact = ticketId.toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 7) || "ticket";
  const identity = createHash("sha256").update(ticketId).digest("hex").slice(0, 10);
  const baseConversation = conversation.replace(/-g\d+$/, "");
  const generation = conversation.match(/-g(\d+)$/)?.[1] ?? "1";
  const role = baseConversation === "review" ? "r" : baseConversation === "work" ? "w" : createHash("sha256").update(baseConversation).digest("hex").slice(0, 3);
  return `apt_${compact}_${identity}_${provider}_${role}g${generation}`.slice(0, 32);
}

export class HerdrController {
  private readonly agentReadyTimeoutMs: number;
  private readonly agentReadySettleMs: number;

  constructor(private readonly runner: CommandRunner, readonly projectRoot: string, options: HerdrControllerOptions = {}) {
    this.agentReadyTimeoutMs = Number.isFinite(options.agentReadyTimeoutMs) && Number(options.agentReadyTimeoutMs) >= 0
      ? Number(options.agentReadyTimeoutMs) : 30_000;
    this.agentReadySettleMs = Number.isFinite(options.agentReadySettleMs) && Number(options.agentReadySettleMs) >= 0
      ? Number(options.agentReadySettleMs) : 10_000;
  }

  private async startAgent(args: string[]): Promise<void> {
    const deadline = Date.now() + PANE_BUSY_RETRY_TIMEOUT_MS;
    while (true) {
      try {
        await this.runner.run(args);
        return;
      } catch (error) {
        if (commandErrorCode(error) !== "agent_pane_busy" || Date.now() >= deadline) throw error;
        await sleep(Math.min(PANE_BUSY_RETRY_INTERVAL_MS, deadline - Date.now()));
      }
    }
  }

  private readinessIsKnown(observation: AgentObservation): boolean {
    return typeof observation.interactiveReady === "boolean" || typeof observation.launchPending === "boolean";
  }

  private inputIsReady(observation: AgentObservation): boolean {
    return observation.interactiveReady === true && observation.launchPending !== true;
  }

  private async waitForInteractiveReady(paneId: string): Promise<AgentObservation> {
    const startedAt = Date.now();
    const deadline = startedAt + this.agentReadyTimeoutMs;
    let readySince: number | null = null;
    let readinessWasExposed = false;
    let observation = await this.observe(paneId);

    while (true) {
      readinessWasExposed ||= this.readinessIsKnown(observation);
      if (this.inputIsReady(observation)) {
        readySince ??= Date.now();
        if (Date.now() - readySince >= this.agentReadySettleMs) return observation;
      } else {
        readySince = null;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Older Herdr versions did not expose readiness fields. Preserve
        // compatibility, but only after the full conservative startup delay.
        if (!readinessWasExposed) return observation;
        throw new Error(`Herdr agent in ${paneId} did not become interactively ready within ${this.agentReadyTimeoutMs}ms`);
      }
      await sleep(Math.min(AGENT_READY_POLL_INTERVAL_MS, remaining));
      observation = await this.observe(paneId);
    }
  }

  async ensureAgent(ticketId: string, provider: Provider, conversation: string, existingPane: string | null, sessionRef: string | null, profile?: { model: string | null; reasoning: string | null } | null): Promise<AgentObservation> {
    if (existingPane) {
      try {
        const existing = await this.observe(existingPane);
        return this.readinessIsKnown(existing) && !this.inputIsReady(existing)
          ? await this.waitForInteractiveReady(existingPane) : existing;
      } catch { /* restore into saved pane */ }
      await this.startAgent(["agent", "start", agentName(ticketId, provider, conversation), "--kind", provider, "--pane", existingPane, "--", ...launchArguments(provider, sessionRef, profile?.model, profile?.reasoning)]);
      return this.waitForInteractiveReady(existingPane);
    }
    const created = resultRecord(await this.runner.run(["workspace", "create", "--cwd", this.projectRoot, "--label", ticketId, "--no-focus"]));
    const rootPane = created.root_pane as { pane_id?: unknown } | undefined;
    const paneId = typeof rootPane?.pane_id === "string" ? rootPane.pane_id : null;
    if (!paneId) throw new Error("Herdr workspace creation did not return a root pane ID");
    await this.startAgent(["agent", "start", agentName(ticketId, provider, conversation), "--kind", provider, "--pane", paneId, "--", ...launchArguments(provider, sessionRef, profile?.model, profile?.reasoning)]);
    return this.waitForInteractiveReady(paneId);
  }

  async prompt(paneId: string, prompt: string): Promise<void> {
    await this.runner.run(["agent", "prompt", paneId, prompt]);
  }

  async promptAndConfirm(paneId: string, prompt: string): Promise<boolean> {
    try {
      await this.runner.run(["agent", "prompt", paneId, prompt, "--wait", "--timeout", "6000"]);
      return true;
    } catch (error) {
      const code = commandErrorCode(error);
      if (code === "agent_prompt_stalled") return false;
      // With a timeout greater than Herdr's five-second stalled-prompt window,
      // timeout means activity began but the turn had not settled yet.
      if (code === "timeout") return true;
      throw error;
    }
  }

  async readText(paneId: string): Promise<string> {
    const args = ["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", "120"];
    if (this.runner.runText) return this.runner.runText(args);
    const result = await this.runner.run(args);
    if (typeof result === "string") return result;
    return JSON.stringify(result);
  }

  async sendKeys(paneId: string, ...keys: string[]): Promise<void> {
    await this.runner.run(["agent", "send-keys", paneId, ...keys]);
  }

  async interrupt(paneId: string): Promise<void> {
    await this.sendKeys(paneId, "ctrl+c");
    await this.runner.run(["agent", "wait", paneId, "--until", "idle", "--until", "done", "--timeout", "15000"]);
  }

  async observe(paneId: string): Promise<AgentObservation> {
    const result = resultRecord(await this.runner.run(["agent", "get", paneId]));
    const agent = (result.agent ?? result) as Record<string, unknown>;
    const session = agent.agent_session && typeof agent.agent_session === "object"
      ? agent.agent_session as Record<string, unknown> : {};
    return {
      paneId,
      state: typeof agent.agent_status === "string" ? agent.agent_status : typeof agent.status === "string" ? agent.status : "unknown",
      sessionRef: typeof session.value === "string" ? session.value : null,
      workspaceId: stringValue(agent, "workspace_id"),
      tabId: stringValue(agent, "tab_id"),
      terminalId: stringValue(agent, "terminal_id"),
      focused: typeof agent.focused === "boolean" ? agent.focused : null,
      cwd: stringValue(agent, "cwd"),
      foregroundCwd: stringValue(agent, "foreground_cwd"),
      terminalTitle: stringValue(agent, "terminal_title"),
      terminalTitleStripped: stringValue(agent, "terminal_title_stripped"),
      displayName: stringValue(agent, "display_agent", "agent_name", "name"),
      revision: Number.isInteger(agent.revision) && Number(agent.revision) >= 0 ? Number(agent.revision) : null,
      sessionSource: stringValue(session, "source"),
      sessionKind: stringValue(session, "kind"),
      tokens: tokenValues(agent.tokens),
      interactiveReady: typeof agent.interactive_ready === "boolean" ? agent.interactive_ready : null,
      launchPending: typeof agent.launch_pending === "boolean" ? agent.launch_pending : null,
    };
  }
}
