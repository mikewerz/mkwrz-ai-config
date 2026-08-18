import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createApp } from "./app.js";
import { TicketStore } from "./ticket-store.js";
import { SupervisorRegistry } from "./supervisor-registry.js";
import { TrackerConfigStore } from "./config-store.js";
import { GithubObserver } from "./github-observer.js";
import { PromptLibrary } from "./prompt-library.js";
import { WorkflowLibrary } from "./workflow-library.js";

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4310);
const ticketRoot = process.env.TICKETS_ROOT ? resolve(process.env.TICKETS_ROOT) : resolve("tickets");
const leaseTtlMs = Number(process.env.LEASE_TTL_MS ?? 120_000);

const workflowLibrary = new WorkflowLibrary(ticketRoot);
await workflowLibrary.start();
const store = new TicketStore(ticketRoot, { leaseTtlMs, workflowLibrary });
await store.start();
const configStore = new TrackerConfigStore(ticketRoot);
await configStore.start();
const registry = new SupervisorRegistry(Number(process.env.SUPERVISOR_TTL_MS ?? 90_000));
const githubObserver = new GithubObserver(store, configStore, fetch, workflowLibrary);
const promptLibrary = new PromptLibrary(ticketRoot);
await promptLibrary.start();
const app = createApp(store, resolve("dist/client"), registry, configStore, undefined, githubObserver, promptLibrary, workflowLibrary);
const server = app.listen(port, host, () => console.log(`agentic-project-tracker listening on http://${host}:${port}`));
const sweeper = setInterval(() => void store.expireLeases(), Math.min(30_000, Math.max(1_000, leaseTtlMs / 2)));
let githubTimer: NodeJS.Timeout | null = null;
async function scheduleGithubObservation(): Promise<void> {
  const config = await configStore.read();
  if (config.github.observation_enabled) await githubObserver.checkAll();
  const delay = config.github.observation_enabled ? config.github.observation_interval_minutes * 60_000 : 60_000;
  githubTimer = setTimeout(() => void scheduleGithubObservation().catch((error) => console.error("[github] scheduler failed", error)), delay);
  githubTimer.unref();
}
void scheduleGithubObservation().catch((error) => console.error("[github] scheduler failed", error));

async function shutdown(): Promise<void> {
  clearInterval(sweeper);
  if (githubTimer) clearTimeout(githubTimer);
  server.close();
  await store.close();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
