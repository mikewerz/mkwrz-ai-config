import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { HerdrCli, HerdrController } from "./herdr.js";
import { Supervisor } from "./supervisor.js";
import type { Provider } from "./types.js";

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const supported = new Set<Provider>(["claude", "codex"]);
const providers = (process.env.PROVIDERS ?? "claude,codex").split(",").map((item) => item.trim()).filter((item): item is Provider => supported.has(item as Provider));
if (providers.length === 0) throw new Error("PROVIDERS must include claude or codex");

const trackerUrl = process.env.TRACKER_URL ?? "http://127.0.0.1:4310";
const projectRoot = resolve(process.env.PROJECT_ROOT ?? process.cwd());
const assignmentRoot = resolve(process.env.ASSIGNMENT_ROOT ?? resolve(projectRoot, ".agentic-assignments"));
const herdrSession = process.env.HERDR_SESSION ?? "agentic-projects";
const agentExecutionEnabled = process.env.AGENT_EXECUTION_ENABLED !== "false";
const configuredHerdrExecutable = process.env.HERDR_EXECUTABLE?.trim();
const herdrTestDouble = process.env.HERDR_TEST_DOUBLE === "true";
const herdrCommandTimeoutMs = Number(process.env.HERDR_COMMAND_TIMEOUT_MS ?? 45_000);
if (!Number.isFinite(herdrCommandTimeoutMs) || herdrCommandTimeoutMs < 1_000) throw new Error("HERDR_COMMAND_TIMEOUT_MS must be at least 1000");
const herdrTranscriptLines = Number(process.env.HERDR_TRANSCRIPT_LINES ?? 5_000);
if (!Number.isSafeInteger(herdrTranscriptLines) || herdrTranscriptLines < 120 || herdrTranscriptLines > 100_000) throw new Error("HERDR_TRANSCRIPT_LINES must be an integer between 120 and 100000");
const sessionEvidenceMaxBytes = Number(process.env.SESSION_EVIDENCE_MAX_BYTES ?? 64 * 1024 * 1024);
if (!Number.isSafeInteger(sessionEvidenceMaxBytes) || sessionEvidenceMaxBytes < 1_048_576) throw new Error("SESSION_EVIDENCE_MAX_BYTES must be an integer of at least 1048576");
if (configuredHerdrExecutable && !configuredHerdrExecutable.startsWith("/")) throw new Error("HERDR_EXECUTABLE must be an absolute path");
if (configuredHerdrExecutable) accessSync(configuredHerdrExecutable, constants.X_OK);
if (herdrTestDouble && process.env.NODE_ENV !== "test") throw new Error("HERDR_TEST_DOUBLE is permitted only when NODE_ENV=test");
if (process.env.NODE_ENV === "test" && agentExecutionEnabled && (!configuredHerdrExecutable || !herdrTestDouble)) {
  throw new Error("Test supervisors with agent execution enabled require an explicit HERDR_EXECUTABLE and HERDR_TEST_DOUBLE=true");
}
const herdr = new HerdrController(new HerdrCli(herdrSession, configuredHerdrExecutable || "herdr", herdrCommandTimeoutMs), projectRoot, {
  agentReadyTimeoutMs: Number(process.env.AGENT_START_READY_TIMEOUT_MS ?? 30_000),
  agentReadySettleMs: Number(process.env.AGENT_START_READY_SETTLE_MS ?? 10_000),
});
const detectedIps = Object.values(networkInterfaces()).flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === "IPv4" && !address.internal).map((address) => address.address);
const supervisor = new Supervisor(herdr, {
  trackerUrl,
  supervisorId: process.env.SUPERVISOR_ID ?? "coordinator-vm",
  providers,
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 30_000),
  idlePollMs: Number(process.env.IDLE_POLL_MS ?? 5_000),
  assignmentRoot,
  agentExecutionEnabled,
  trackerRequestTimeoutMs: Number(process.env.TRACKER_REQUEST_TIMEOUT_MS ?? 15_000),
  trackerClaimTimeoutMs: Number(process.env.TRACKER_CLAIM_TIMEOUT_MS ?? 45_000),
  trackerArtifactTimeoutMs: Number(process.env.TRACKER_ARTIFACT_TIMEOUT_MS ?? 300_000),
  callbackReminderGraceMs: Number(process.env.CALLBACK_REMINDER_GRACE_MS ?? 60_000),
  assignmentPromptRecoveryMs: Number(process.env.ASSIGNMENT_PROMPT_RECOVERY_MS ?? 30_000),
  sessionEvidenceEnabled: process.env.SESSION_EVIDENCE_ENABLED !== "false",
  nativeSessionEvidenceEnabled: process.env.NATIVE_SESSION_EVIDENCE_ENABLED !== "false",
  herdrTranscriptLines,
  sessionEvidenceMaxBytes,
  ...(process.env.CALLBACK_BASE_URL ? { callbackBaseUrl: process.env.CALLBACK_BASE_URL } : {}),
  presence: {
    instanceId: randomUUID(),
    hostname: process.env.SUPERVISOR_HOST ?? hostname(),
    ipAddresses: process.env.SUPERVISOR_IPS?.split(",").map((item) => item.trim()).filter(Boolean) ?? detectedIps,
    projectRoot,
    herdrSession,
    startedAt: new Date().toISOString(),
  },
});

process.on("SIGINT", () => void supervisor.stop());
process.on("SIGTERM", () => void supervisor.stop());
await supervisor.run();
