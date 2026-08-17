import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { AgentObservation, Provider } from "./types.js";

const exec = promisify(execFile);

export interface CommandRunner {
  run(args: string[]): Promise<unknown>;
}

export class HerdrCli implements CommandRunner {
  constructor(private readonly session: string, private readonly binary = "herdr") {}
  async run(args: string[]): Promise<unknown> {
    const { stdout } = await exec(this.binary, ["--session", this.session, ...args], { maxBuffer: 2_000_000 });
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : {};
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

export function agentName(ticketId: string, provider: Provider, conversation: "work" | "review"): string {
  const compact = ticketId.toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 7) || "ticket";
  const identity = createHash("sha256").update(ticketId).digest("hex").slice(0, 10);
  const role = conversation === "review" ? "r" : "w";
  return `apt_${compact}_${identity}_${provider}_${role}`.slice(0, 32);
}

export class HerdrController {
  constructor(private readonly runner: CommandRunner, readonly projectRoot: string) {}

  async ensureAgent(ticketId: string, provider: Provider, conversation: "work" | "review", existingPane: string | null, sessionRef: string | null): Promise<AgentObservation> {
    if (existingPane) {
      try { return await this.observe(existingPane); } catch { /* restore into saved pane */ }
      await this.runner.run(["agent", "start", agentName(ticketId, provider, conversation), "--kind", provider, "--pane", existingPane, "--", ...resumeArguments(provider, sessionRef)]);
      return this.observe(existingPane);
    }
    const created = resultRecord(await this.runner.run(["workspace", "create", "--cwd", this.projectRoot, "--label", ticketId, "--no-focus"]));
    const rootPane = created.root_pane as { pane_id?: unknown } | undefined;
    const paneId = typeof rootPane?.pane_id === "string" ? rootPane.pane_id : null;
    if (!paneId) throw new Error("Herdr workspace creation did not return a root pane ID");
    await this.runner.run(["agent", "start", agentName(ticketId, provider, conversation), "--kind", provider, "--pane", paneId, "--", ...resumeArguments(provider, sessionRef)]);
    return this.observe(paneId);
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

  async interrupt(paneId: string): Promise<void> {
    await this.runner.run(["agent", "send-keys", paneId, "ctrl+c"]);
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
    };
  }
}
