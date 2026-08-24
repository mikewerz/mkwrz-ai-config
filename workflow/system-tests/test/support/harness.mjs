import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supportDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(supportDirectory, "../..");
export const workspaceRoot = resolve(repositoryRoot, "..");
export const trackerRoot = join(workspaceRoot, "tracker");
export const supervisorRoot = join(workspaceRoot, "supervisor");
export const fakeBin = join(repositoryRoot, "test", "fake-bin");

const delay = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

const credentialNames = new Set([
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
  "GITHUB_TOKEN", "GH_TOKEN", "JIRA_EMAIL", "JIRA_API_TOKEN", "HF_TOKEN",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID", "GOOGLE_APPLICATION_CREDENTIALS",
]);

export function sanitizedEnvironment(overrides = {}) {
  const environment = { ...globalThis.process.env };
  for (const name of credentialNames) delete environment[name];
  for (const name of Object.keys(environment)) {
    if (/^(ANTHROPIC|CLAUDE|OPENAI|CODEX|JIRA|GITHUB|GH|AWS|AZURE|GOOGLE)_.+(TOKEN|KEY|SECRET|CREDENTIALS)$/i.test(name)) delete environment[name];
  }
  return { ...environment, ...overrides };
}

export async function unusedPort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate an ephemeral TCP port");
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return address.port;
}

function managedProcess(name, executable, args, options) {
  const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => `${current}${chunk}`.slice(-100_000);
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk.toString()); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk.toString()); });
  return {
    name,
    child,
    logs: () => ({ stdout, stderr }),
    describe() {
      return `${name} (pid ${child.pid ?? "not-started"}, exit ${child.exitCode ?? "running"})\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    },
  };
}

export async function waitFor(description, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 75;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError ? ` Last error: ${lastError.stack ?? lastError}` : "";
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

export async function stopProcess(process) {
  if (!process || process.child.exitCode !== null) return;
  const exited = new Promise((accept) => process.child.once("exit", accept));
  process.child.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)]);
  if (!stopped && process.child.exitCode === null) {
    process.child.kill("SIGKILL");
    await exited;
  }
}

export async function jsonRequest(baseUrl, path, options = {}) {
  const expected = options.expected ?? 200;
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...(options.headers ?? {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* Retain text for useful failures. */ }
  if (response.status !== expected) {
    throw new Error(`${options.method ?? "GET"} ${path} returned HTTP ${response.status}, expected ${expected}: ${text}`);
  }
  return { response, body };
}

export async function startTracker(options = {}) {
  const port = options.port ?? await unusedPort();
  const ticketRoot = options.ticketRoot ?? await mkdtemp(join(tmpdir(), "agentic-system-tickets-"));
  await mkdir(ticketRoot, { recursive: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  const service = managedProcess("tracker", globalThis.process.execPath, [join(trackerRoot, "dist", "server", "index.js")], {
    cwd: trackerRoot,
    env: sanitizedEnvironment({
      HOST: "127.0.0.1",
      PORT: String(port),
      TICKETS_ROOT: ticketRoot,
      LEASE_TTL_MS: String(options.leaseTtlMs ?? 1_500),
      SUPERVISOR_TTL_MS: "5_000",
    }),
  });
  try {
    await waitFor("tracker readiness", async () => {
      if (service.child.exitCode !== null) throw new Error(service.describe());
      const response = await fetch(`${baseUrl}/api/readyz`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
      return response?.ok;
    }, { timeoutMs: 15_000 });
  } catch (error) {
    await stopProcess(service);
    throw error;
  }
  return { process: service, baseUrl, ticketRoot };
}

export async function startSupervisor(tracker, options = {}) {
  const projectRoot = options.projectRoot ?? await mkdtemp(join(tmpdir(), "agentic-system-projects-"));
  const assignmentRoot = options.assignmentRoot ?? await mkdtemp(join(tmpdir(), "agentic-system-assignments-"));
  const fakeHerdrLog = options.fakeHerdrLog ?? join(assignmentRoot, "fake-herdr.jsonl");
  const fakeHerdrState = options.fakeHerdrState ?? join(assignmentRoot, "fake-herdr-state.json");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(assignmentRoot, { recursive: true });
  const service = managedProcess("supervisor", globalThis.process.execPath, [join(supervisorRoot, "dist", "index.js")], {
    cwd: supervisorRoot,
    env: sanitizedEnvironment({
      PATH: `${fakeBin}${delimiter}${globalThis.process.env.PATH ?? ""}`,
      TRACKER_URL: tracker.baseUrl,
      CALLBACK_BASE_URL: tracker.baseUrl,
      PROJECT_ROOT: projectRoot,
      ASSIGNMENT_ROOT: assignmentRoot,
      SUPERVISOR_ID: options.supervisorId ?? "system-test-supervisor",
      SUPERVISOR_HOST: "system-test-host",
      SUPERVISOR_IPS: "127.0.0.1",
      HERDR_SESSION: "system-test-session",
      PROVIDERS: options.providers ?? "claude",
      HEARTBEAT_INTERVAL_MS: String(options.heartbeatIntervalMs ?? 100),
      IDLE_POLL_MS: String(options.idlePollMs ?? 50),
      FAKE_HERDR_LOG: fakeHerdrLog,
      FAKE_HERDR_STATE: fakeHerdrState,
      FAKE_HERDR_CWD: projectRoot,
      FAKE_HERDR_PROMPT_STALLS: String(options.fakeHerdrPromptStalls ?? 0),
      FAKE_HERDR_STAGE_STALLED_PROMPT: options.fakeHerdrStageStalledPrompt === true ? "true" : "false",
      FAKE_HERDR_READY_AFTER_GETS: String(options.fakeHerdrReadyAfterGets ?? 0),
      ASSIGNMENT_PROMPT_RECOVERY_MS: String(options.assignmentPromptRecoveryMs ?? 30_000),
      AGENT_START_READY_TIMEOUT_MS: String(options.agentStartReadyTimeoutMs ?? 30_000),
      AGENT_START_READY_SETTLE_MS: String(options.agentStartReadySettleMs ?? 0),
      NODE_ENV: "test",
      AGENT_EXECUTION_ENABLED: options.agentExecutionEnabled === false ? "false" : "true",
      HERDR_EXECUTABLE: join(fakeBin, "herdr"),
      HERDR_TEST_DOUBLE: "true",
    }),
  });
  try {
    await waitFor("supervisor registration", async () => {
      if (service.child.exitCode !== null) throw new Error(service.describe());
      const supervisors = (await jsonRequest(tracker.baseUrl, "/api/supervisors")).body.supervisors;
      return supervisors.some((item) => item.supervisor_id === (options.supervisorId ?? "system-test-supervisor"));
    }, { timeoutMs: 15_000 });
  } catch (error) {
    await stopProcess(service);
    throw error;
  }
  return { process: service, projectRoot, assignmentRoot, fakeHerdrLog, fakeHerdrState };
}

export async function startSupervisorWithoutExplicitHerdr(tracker) {
  const projectRoot = await mkdtemp(join(tmpdir(), "agentic-system-fail-closed-projects-"));
  const assignmentRoot = await mkdtemp(join(tmpdir(), "agentic-system-fail-closed-assignments-"));
  const service = managedProcess("fail-closed-supervisor", globalThis.process.execPath, [join(supervisorRoot, "dist", "index.js")], {
    cwd: supervisorRoot,
    env: sanitizedEnvironment({
      TRACKER_URL: tracker.baseUrl,
      PROJECT_ROOT: projectRoot,
      ASSIGNMENT_ROOT: assignmentRoot,
      SUPERVISOR_ID: "fail-closed-supervisor",
      PROVIDERS: "claude",
      NODE_ENV: "test",
      AGENT_EXECUTION_ENABLED: "true",
      HERDR_EXECUTABLE: "",
    }),
  });
  await waitFor("supervisor to reject an implicit Herdr executable", () => service.child.exitCode !== null, { timeoutMs: 5_000 });
  return { process: service, projectRoot, assignmentRoot };
}

export async function readHerdrInvocations(supervisor) {
  try {
    return (await readFile(supervisor.fakeHerdrLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function cleanup(paths) {
  await Promise.all(paths.filter(Boolean).map((path) => rm(path, { recursive: true, force: true })));
}
