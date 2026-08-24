import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createApp } from "./app.js";
import { TicketStore } from "./ticket-store.js";
import { SupervisorRegistry } from "./supervisor-registry.js";
import { TrackerConfigStore } from "./config-store.js";
import { GithubObserver } from "./github-observer.js";
import { PromptLibrary } from "./prompt-library.js";
import { WorkflowLibrary } from "./workflow-library.js";
import { log } from "./logger.js";
import { OperationalMonitor } from "./operations.js";
import { IntakeStore } from "./intake-store.js";

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4310);
const ticketRoot = process.env.TICKETS_ROOT ? resolve(process.env.TICKETS_ROOT) : resolve("tickets");
const leaseTtlMs = Number(process.env.LEASE_TTL_MS ?? 120_000);

const workflowLibrary = new WorkflowLibrary(ticketRoot);
await workflowLibrary.start();
const configStore = new TrackerConfigStore(ticketRoot);
await configStore.start();
const store = new TicketStore(ticketRoot, { leaseTtlMs, workflowLibrary, artifactPolicy: async () => (await configStore.read()).artifacts });
await store.start();
const registry = new SupervisorRegistry(Number(process.env.SUPERVISOR_TTL_MS ?? 90_000));
const githubObserver = new GithubObserver(store, configStore, fetch, workflowLibrary);
const promptLibrary = new PromptLibrary(ticketRoot);
await promptLibrary.start();
const operations = new OperationalMonitor();
const intakeStore = new IntakeStore(ticketRoot, store, undefined, leaseTtlMs);
await intakeStore.start();
const app = createApp(store, resolve("dist/client"), registry, configStore, undefined, githubObserver, promptLibrary, workflowLibrary, operations, intakeStore);
const server = app.listen(port, host, () => log("info", "service.listening", { host, port, ticket_root: ticketRoot }));
const sweeper = setInterval(() => void store.expireLeases(), Math.min(30_000, Math.max(1_000, leaseTtlMs / 2)));
let githubTimer: NodeJS.Timeout | null = null;
let artifactTimer: NodeJS.Timeout | null = null;
let intakeTimer: NodeJS.Timeout | null = null;
let artifactMaintenance: Promise<void> | null = null;
let stopping = false;
async function scheduleGithubObservation(): Promise<void> {
  const config = await configStore.read();
  if (config.github.observation_enabled) await operations.run("github_observation", () => githubObserver.checkAll());
  const delay = config.github.observation_enabled ? config.github.observation_interval_minutes * 60_000 : 60_000;
  if (stopping) return;
  githubTimer = setTimeout(() => void scheduleGithubObservation().catch((error) => log("error", "github.scheduler_failed", {}, error)), delay);
  githubTimer.unref();
}
void scheduleGithubObservation().catch((error) => log("error", "github.scheduler_failed", {}, error));
async function scheduleArtifactMaintenance(): Promise<void> {
  const config = await configStore.read();
  if (config.artifacts.auto_gc_enabled) {
    const run = operations.run("artifact_maintenance", () => store.maintainArtifacts(config.artifacts), (result) => ({
      recovered_records: result.recovered_records.length,
      removed_records: result.collection.removed_records.length,
      removed_blobs: result.collection.removed_blobs.length,
      healthy: result.diagnostics.healthy,
    })).then((result) => {
      log("info", "artifact.maintenance_completed", {
        recovered_records: result.recovered_records.length,
        removed_records: result.collection.removed_records.length,
        removed_blobs: result.collection.removed_blobs.length,
        healthy: result.diagnostics.healthy,
      });
    });
    artifactMaintenance = run;
    try { await run; } finally { if (artifactMaintenance === run) artifactMaintenance = null; }
  }
  if (stopping) return;
  artifactTimer = setTimeout(() => void scheduleArtifactMaintenance().catch((error) => log("error", "artifact.maintenance_failed", {}, error)), config.artifacts.gc_interval_minutes * 60_000);
  artifactTimer.unref();
}
void scheduleArtifactMaintenance().catch((error) => log("error", "artifact.maintenance_failed", {}, error));
async function scheduleIntake(): Promise<void> {
  await operations.run("intake_scheduling", () => intakeStore.scheduleDue(), (result) => ({
    scheduled: result.scheduled,
    admitted_deferred: result.admitted_deferred,
  }));
  if (stopping) return;
  intakeTimer = setTimeout(() => void scheduleIntake().catch((error) => log("error", "intake.scheduler_failed", {}, error)), 30_000);
  intakeTimer.unref();
}
void scheduleIntake().catch((error) => log("error", "intake.scheduler_failed", {}, error));

async function shutdown(): Promise<void> {
  stopping = true;
  clearInterval(sweeper);
  if (githubTimer) clearTimeout(githubTimer);
  if (artifactTimer) clearTimeout(artifactTimer);
  if (intakeTimer) clearTimeout(intakeTimer);
  await artifactMaintenance?.catch(() => undefined);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await store.close();
  log("info", "service.stopped");
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
