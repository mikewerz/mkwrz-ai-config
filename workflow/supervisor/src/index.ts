import { randomUUID } from "node:crypto";
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
const herdrSession = process.env.HERDR_SESSION ?? "agentic-projects";
const herdr = new HerdrController(new HerdrCli(herdrSession), projectRoot);
const detectedIps = Object.values(networkInterfaces()).flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === "IPv4" && !address.internal).map((address) => address.address);
const supervisor = new Supervisor(herdr, {
  trackerUrl,
  supervisorId: process.env.SUPERVISOR_ID ?? "coordinator-vm",
  providers,
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 30_000),
  idlePollMs: Number(process.env.IDLE_POLL_MS ?? 5_000),
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
