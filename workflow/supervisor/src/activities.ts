import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { accessSync } from "node:fs";
import { access, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ActivityCapability, ClaimedTicket } from "./types.js";

const execute = promisify(execFile);

export function detectActivityCapabilities(): ActivityCapability[] {
  const capabilities: ActivityCapability[] = ["repository_action", "inline_javascript"];
  try { accessSync("/bin/sh", constants.X_OK); capabilities.push("inline_shell"); } catch { /* unavailable */ }
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); capabilities.push("inline_python"); } catch { /* unavailable */ }
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); capabilities.push("git_checkpoint", "git_restore"); } catch { /* unavailable */ }
  return capabilities;
}

export interface ActivityResult {
  success: boolean;
  summary: string;
  output: string;
  stdout?: string;
  stderr?: string;
  exit_code: number | null;
  script_path: string | null;
  working_directory: string | null;
  pending_artifacts?: PendingActivityArtifact[];
  checkpoints?: PendingCheckpoint[];
  structured_result?: {
    metadata?: Record<string, unknown>;
    external_references?: Array<{ type: string; id: string; url?: string }>;
  };
}

export interface PendingActivityArtifact {
  key: string;
  kind: "script_artifact" | "quality_report" | "checkpoint_bundle";
  filename: string;
  content_type: string;
  path: string;
  presentation?: { title?: string; description?: string; category?: string; featured?: boolean };
}
export interface PendingCheckpoint {
  id: string; label: string; kind: "workflow" | "manual" | "pre_restore"; created_at: string;
  repositories: Array<{ repository: string; head_sha: string; snapshot_sha: string; branch: string | null; remote_url: string | null; dirty: boolean; bundle_key: string }>;
}
export interface ActivityRuntime { directory: string; artifact_paths?: Record<string, string> }

interface RepositoryActivityContext {
  id: string;
  path: string;
  primary: boolean;
  current_branch: string | null;
  default_branch: string | null;
  head_sha: string | null;
  remote_url: string | null;
  pull_requests: Array<{ url: string; phase: string | null }>;
}

interface ActivityContext {
  ticket: { id: string; title: string; path: string; phase: string };
  project_root: string;
  selected_repository: string;
  primary_repository: string;
  activity: { script_path: string | null; working_directory: string };
  repositories: RepositoryActivityContext[];
  workflow: {
    id: string | null; revision: string | null; node_id: string; node_name: string;
    node_run_id: string | null; attempt: number | null;
    incoming: { source_node: string; outcome: string; summary: string | null; handoff: string | null; output: string | null; output_log_path: string | null; actor: string | null } | null;
  };
}

type PathReference = NonNullable<NonNullable<ClaimedTicket["workflow_node"]>["script_file"]>;

function selectedPath(reference: PathReference, inputs: Record<string, boolean | string>, label: string): string {
  if (Boolean(reference.path) === Boolean(reference.path_input)) throw new Error(`${label} must define exactly one path or path_input`);
  const value = reference.path ?? (reference.path_input ? inputs[reference.path_input] : undefined);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} did not resolve to a non-empty ticket path`);
  return value.trim();
}

async function resolvedContainedPath(
  reference: PathReference,
  inputs: Record<string, boolean | string>,
  bases: Record<PathReference["relative_to"], string>,
  label: string,
): Promise<string> {
  const base = bases[reference.relative_to];
  if (!base) throw new Error(`${label} uses unsupported base ${String(reference.relative_to)}`);
  const requested = resolve(base, selectedPath(reference, inputs, label));
  if (!inside(base, requested)) throw new Error(`${label} escapes ${reference.relative_to}`);
  const resolved = await realpath(requested);
  if (!inside(base, resolved)) throw new Error(`${label} resolves outside ${reference.relative_to}`);
  return resolved;
}

function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function gitValue(repository: string, args: string[]): Promise<string | null> {
  try {
    const result = await execute("git", args, { cwd: repository, timeout: 5_000, maxBuffer: 16_000 });
    return String(result.stdout ?? "").trim() || null;
  } catch { return null; }
}

async function git(repository: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal | undefined } = {}): Promise<string> {
  const result = await execute("git", args, { cwd: repository, ...(options.env ? { env: options.env } : {}), ...(options.signal ? { signal: options.signal } : {}), timeout: options.timeout ?? 120_000, maxBuffer: 1_000_000 });
  return String(result.stdout ?? "").trim();
}

function checkpointForRestore(ticket: ClaimedTicket) {
  const node = ticket.workflow_node;
  if (node.type !== "restore_checkpoint") return null;
  const manual = ticket.frontmatter.metadata?.["checkpoint.restore_id"];
  const source = node.checkpoint_source ?? { mode: "latest" as const };
  const requested = typeof manual === "string" ? manual
    : source.mode === "id" ? source.checkpoint_id
      : source.mode === "metadata" ? ticket.frontmatter.metadata?.[source.metadata_key ?? ""]
        : null;
  if (typeof requested === "string") return ticket.frontmatter.checkpoints?.find((item) => item.id === requested) ?? null;
  return ticket.frontmatter.checkpoints?.at(-1) ?? null;
}

export function requiredRestoreArtifactIds(ticket: ClaimedTicket): string[] {
  return checkpointForRestore(ticket)?.repositories.map((repository) => repository.bundle_artifact_id) ?? [];
}

async function captureCheckpoint(projectRoot: string, ticket: ClaimedTicket, directory: string, kind: PendingCheckpoint["kind"], label: string, signal?: AbortSignal): Promise<{ checkpoint: PendingCheckpoint; artifacts: PendingActivityArtifact[] }> {
  const checkpointId = randomUUID();
  await mkdir(directory, { recursive: true });
  const repositories: PendingCheckpoint["repositories"] = [];
  const artifacts: PendingActivityArtifact[] = [];
  const realProjectRoot = await realpath(projectRoot);
  for (const [index, declared] of ticket.frontmatter.repositories.entries()) {
    if (signal?.aborted) throw new Error("Checkpoint was interrupted");
    const repository = await realpath(resolve(realProjectRoot, declared.id));
    if (!inside(realProjectRoot, repository)) throw new Error(`Repository ${declared.id} resolves outside the project root`);
    await git(repository, ["rev-parse", "--is-inside-work-tree"], { signal });
    const head = await git(repository, ["rev-parse", "HEAD"], { signal });
    const branch = await gitValue(repository, ["branch", "--show-current"]);
    const remote = await gitValue(repository, ["remote", "get-url", "origin"]);
    const dirty = Boolean(await git(repository, ["status", "--porcelain"], { signal }));
    const indexPath = join(directory, `index-${index}`);
    const environment = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_AUTHOR_NAME: "Agentic Project Tracker", GIT_AUTHOR_EMAIL: "checkpoint@localhost", GIT_COMMITTER_NAME: "Agentic Project Tracker", GIT_COMMITTER_EMAIL: "checkpoint@localhost" };
    await git(repository, ["read-tree", "HEAD"], { env: environment, signal });
    await git(repository, ["add", "-A"], { env: environment, signal });
    const tree = await git(repository, ["write-tree"], { env: environment, signal });
    const snapshot = await git(repository, ["commit-tree", tree, "-p", head, "-m", `Agentic checkpoint ${ticket.frontmatter.id} ${checkpointId}`], { env: environment, signal });
    const ticketKey = createHash("sha256").update(ticket.frontmatter.id).digest("hex").slice(0, 16);
    const ref = `refs/agentic-checkpoints/${ticketKey}/${checkpointId}/${index}`;
    await git(repository, ["update-ref", ref, snapshot], { signal });
    const bundlePath = join(directory, `${index}-${createHash("sha256").update(declared.id).digest("hex").slice(0, 12)}.bundle`);
    try { await git(repository, ["bundle", "create", bundlePath, ref], { timeout: 10 * 60_000, signal }); }
    finally { await git(repository, ["update-ref", "-d", ref]).catch(() => ""); }
    const key = `${checkpointId}:${index}`;
    repositories.push({ repository: declared.id, head_sha: head, snapshot_sha: snapshot, branch, remote_url: remote, dirty, bundle_key: key });
    artifacts.push({ key, kind: "checkpoint_bundle", filename: basename(bundlePath), content_type: "application/x-git-bundle", path: bundlePath });
  }
  return { checkpoint: { id: checkpointId, label, kind, created_at: new Date().toISOString(), repositories }, artifacts };
}

async function restoreCheckpoint(projectRoot: string, ticket: ClaimedTicket, runtime: ActivityRuntime, signal?: AbortSignal): Promise<ActivityResult> {
  const selected = checkpointForRestore(ticket);
  if (!selected) throw new Error(`Workflow node ${ticket.workflow_node.id} could not resolve a checkpoint`);
  const pre = await captureCheckpoint(projectRoot, ticket, join(runtime.directory, "pre-restore"), "pre_restore", `Before restoring ${selected.label}`, signal);
  const realProjectRoot = await realpath(projectRoot);
  try {
    for (const repository of selected.repositories) {
      if (signal?.aborted) throw new Error("Restore was interrupted");
      const declared = ticket.frontmatter.repositories.find((item) => item.id === repository.repository);
      if (!declared) throw new Error(`Checkpoint references undeclared repository ${repository.repository}`);
      const path = await realpath(resolve(realProjectRoot, repository.repository));
      if (!inside(realProjectRoot, path)) throw new Error(`Repository ${repository.repository} escapes the project root`);
      const bundle = runtime.artifact_paths?.[repository.bundle_artifact_id];
      if (!bundle) throw new Error(`Checkpoint bundle ${repository.bundle_artifact_id} was not materialized`);
      await git(path, ["fetch", bundle, repository.snapshot_sha], { timeout: 10 * 60_000, signal });
      await git(path, ["clean", "-fd"], { signal });
      await git(path, ["read-tree", "--reset", "-u", repository.snapshot_sha], { signal });
    }
  } catch (error) {
    for (const repository of pre.checkpoint.repositories) {
      const path = await realpath(resolve(realProjectRoot, repository.repository));
      const bundle = pre.artifacts.find((artifact) => artifact.key === repository.bundle_key)!.path;
      await git(path, ["fetch", bundle, repository.snapshot_sha]).catch(() => "");
      await git(path, ["clean", "-fd"]).catch(() => "");
      await git(path, ["read-tree", "--reset", "-u", repository.snapshot_sha]).catch(() => "");
    }
    throw error;
  }
  return { success: true, summary: `Restored checkpoint ${selected.label}.`, output: selected.id, exit_code: 0, script_path: null, working_directory: realProjectRoot, pending_artifacts: pre.artifacts, checkpoints: [pre.checkpoint] };
}

async function repositoryContext(projectRoot: string, ticket: ClaimedTicket, repository: { id: string; primary: boolean }): Promise<RepositoryActivityContext> {
  const candidate = resolve(projectRoot, repository.id);
  if (!inside(projectRoot, candidate)) throw new Error(`Repository ${repository.id} resolves outside the project root`);
  const path = await realpath(candidate).catch(() => candidate);
  if (!inside(projectRoot, path)) throw new Error(`Repository ${repository.id} resolves outside the project root`);
  const [currentBranch, remoteHead, headSha, remoteUrl] = await Promise.all([
    gitValue(path, ["branch", "--show-current"]),
    gitValue(path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    gitValue(path, ["rev-parse", "HEAD"]),
    gitValue(path, ["remote", "get-url", "origin"]),
  ]);
  return {
    id: repository.id,
    path,
    primary: repository.primary,
    current_branch: currentBranch,
    default_branch: remoteHead?.replace(/^origin\//, "") ?? null,
    head_sha: headSha,
    remote_url: remoteUrl,
    pull_requests: ticket.frontmatter.pull_requests
      .filter((pullRequest) => pullRequest.repository === repository.id)
      .map((pullRequest) => ({ url: pullRequest.url, phase: pullRequest.phase ?? null })),
  };
}

export async function runRepositoryActivity(projectRoot: string, ticket: ClaimedTicket, signal?: AbortSignal, runtime?: ActivityRuntime): Promise<ActivityResult> {
  const node = ticket.workflow_node;
  if (node.type === "checkpoint") {
    if (!runtime) throw new Error("Checkpoint activity requires an artifact staging directory");
    const checkpointKind = ticket.frontmatter.metadata?.["checkpoint.request_kind"] === "manual" ? "manual" : "workflow";
    const captured = await captureCheckpoint(projectRoot, ticket, runtime.directory, checkpointKind, node.checkpoint_label?.trim() || node.name, signal);
    return { success: true, summary: `Checkpoint ${captured.checkpoint.label} created.`, output: captured.checkpoint.id, exit_code: 0, script_path: null, working_directory: await realpath(projectRoot), pending_artifacts: captured.artifacts, checkpoints: [captured.checkpoint] };
  }
  if (node.type === "restore_checkpoint") {
    if (!runtime) throw new Error("Restore activity requires an artifact staging directory");
    return restoreCheckpoint(projectRoot, ticket, runtime, signal);
  }
  if (node.type !== "script" || !node.repository || Boolean(node.script_file) === Boolean(node.inline)) {
    throw new Error("Claim does not contain a deterministic activity node");
  }
  const repositoryId = node.repository === "primary"
    ? ticket.frontmatter.repositories.find((repository) => repository.primary)?.id
    : node.repository;
  if (!repositoryId || !ticket.frontmatter.repositories.some((repository) => repository.id === repositoryId)) {
    throw new Error(`Workflow node ${node.id} references unknown repository ${node.repository}`);
  }
  const repository = resolve(projectRoot, repositoryId);
  const realProjectRoot = await realpath(projectRoot);
  const realRepository = await realpath(repository);
  if (!inside(realProjectRoot, realRepository)) throw new Error(`Repository ${repositoryId} resolves outside the project root`);
  const primaryRepositoryId = ticket.frontmatter.repositories.find((item) => item.primary)!.id;
  const repositories = await Promise.all(ticket.frontmatter.repositories.map((item) => repositoryContext(realProjectRoot, ticket, item)));
  const selectedRepository = repositories.find((item) => item.id === repositoryId)!;
  const primaryRepository = repositories.find((item) => item.id === primaryRepositoryId)!;
  const inputs = ticket.frontmatter.workflow.inputs ?? {};
  const bases = {
    selected_repository: realRepository,
    primary_repository: primaryRepository.path,
    project_root: realProjectRoot,
  };
  const workingDirectoryReference = node.working_directory ?? { relative_to: "selected_repository" as const, path: "." };
  const workingDirectory = await resolvedContainedPath(workingDirectoryReference, inputs, bases, `Workflow node ${node.id} working directory`);
  const scriptFileReference = node.script_file ?? null;
  const scriptPath = scriptFileReference
    ? await resolvedContainedPath(scriptFileReference, inputs, bases, `Workflow node ${node.id} script path`)
    : null;
  const incoming = ticket.frontmatter.workflow.incoming;
  const context: ActivityContext = {
    ticket: { id: ticket.frontmatter.id, title: ticket.frontmatter.title, path: ticket.path, phase: ticket.frontmatter.phase },
    project_root: realProjectRoot,
    selected_repository: repositoryId,
    primary_repository: primaryRepositoryId,
    activity: { script_path: scriptPath, working_directory: workingDirectory },
    repositories,
    workflow: {
      id: ticket.frontmatter.workflow?.id ?? null,
      revision: ticket.frontmatter.workflow?.revision ?? null,
      node_id: node.id,
      node_name: node.name,
      node_run_id: ticket.frontmatter.execution.node_run_id ?? null,
      attempt: ticket.frontmatter.execution.attempt ?? null,
      incoming: incoming ? {
        source_node: incoming.source_node, outcome: incoming.outcome, summary: incoming.summary,
        handoff: incoming.handoff, actor: incoming.actor ?? null,
        output: incoming.output ?? null, output_log_path: incoming.output_log_path ?? null,
      } : null,
    },
  };
  const contextJson = JSON.stringify(context);
  const resultPath = join(runtime?.directory ?? workingDirectory, `activity-result-${ticket.frontmatter.execution.node_run_id ?? randomUUID()}.json`);
  await rm(resultPath, { force: true });
  const environment = {
    ...process.env,
    AGENTIC_TICKET_ID: ticket.frontmatter.id,
    AGENTIC_NODE_ID: node.id,
    AGENTIC_NODE_RUN_ID: ticket.frontmatter.execution.node_run_id ?? "",
    AGENTIC_REPOSITORY_ID: repositoryId,
    AGENTIC_REPOSITORY_PATH: realRepository,
    AGENTIC_PRIMARY_REPOSITORY_ID: primaryRepositoryId,
    AGENTIC_PRIMARY_REPOSITORY_PATH: primaryRepository.path,
    AGENTIC_PROJECT_ROOT: realProjectRoot,
    AGENTIC_SCRIPT_PATH: scriptPath ?? "",
    AGENTIC_WORKING_DIRECTORY: workingDirectory,
    AGENTIC_CURRENT_BRANCH: selectedRepository.current_branch ?? "",
    AGENTIC_DEFAULT_BRANCH: selectedRepository.default_branch ?? "",
    AGENTIC_HEAD_SHA: selectedRepository.head_sha ?? "",
    AGENTIC_REMOTE_URL: selectedRepository.remote_url ?? "",
    AGENTIC_REPOSITORIES_JSON: JSON.stringify(repositories),
    AGENTIC_PULL_REQUESTS_JSON: JSON.stringify(ticket.frontmatter.pull_requests),
    AGENTIC_CONTEXT_JSON: contextJson,
    AGENTIC_WORKFLOW_ID: ticket.frontmatter.workflow?.id ?? "",
    AGENTIC_WORKFLOW_REVISION: ticket.frontmatter.workflow?.revision ?? "",
    AGENTIC_WORKFLOW_PHASE: ticket.frontmatter.phase,
    AGENTIC_NODE_NAME: node.name,
    AGENTIC_ATTEMPT: ticket.frontmatter.execution.attempt?.toString() ?? "",
    AGENTIC_INCOMING_NODE: incoming?.source_node ?? "",
    AGENTIC_INCOMING_OUTCOME: incoming?.outcome ?? "",
    AGENTIC_INCOMING_SUMMARY: incoming?.summary ?? "",
    AGENTIC_INCOMING_HANDOFF: incoming?.handoff ?? "",
    AGENTIC_INCOMING_OUTPUT: incoming?.output ?? "",
    AGENTIC_INCOMING_OUTPUT_LOG: incoming?.output_log_path ?? "",
    AGENTIC_TICKET_PATH: ticket.path,
    AGENTIC_WORKFLOW_NODE_TYPE: node.type,
    AGENTIC_RESULT_PATH: resultPath,
  };
  let executable: string;
  let arguments_: string[];
  if (node.inline) {
    if (!node.inline.code.trim()) throw new Error(`Workflow node ${node.id} has empty inline code`);
    if (node.inline.language === "shell") [executable, arguments_] = ["/bin/sh", ["-eu", "-c", node.inline.code]];
    else if (node.inline.language === "python") [executable, arguments_] = ["python3", ["-c", node.inline.code]];
    else if (node.inline.language === "javascript") [executable, arguments_] = [process.execPath, ["--input-type=module", "--eval", node.inline.code]];
    else throw new Error(`Workflow node ${node.id} uses unsupported inline language ${String((node.inline as { language?: unknown }).language)}`);
  } else {
    if (!scriptPath) throw new Error(`Workflow node ${node.id} has no resolved script path`);
    const details = await stat(scriptPath);
    if (!details.isFile()) throw new Error(`Script ${scriptPath} is not a regular file`);
    await access(scriptPath, constants.X_OK);
    [executable, arguments_] = [scriptPath, [
      "--context-json", contextJson,
      "--ticket-id", ticket.frontmatter.id,
      "--project-root", realProjectRoot,
      "--repository-id", repositoryId,
      "--repository-path", realRepository,
      "--primary-repository-id", primaryRepositoryId,
      "--primary-repository-path", primaryRepository.path,
      "--current-branch", selectedRepository.current_branch ?? "",
      "--default-branch", selectedRepository.default_branch ?? "",
      "--head-sha", selectedRepository.head_sha ?? "",
      "--script-path", scriptPath,
      "--working-directory", workingDirectory,
    ]];
  }
  let result: ActivityResult;
  try {
    const executionResult = await execute(executable, arguments_, { cwd: workingDirectory, env: environment, timeout: 30 * 60_000, maxBuffer: 1_000_000, signal });
    const stdout = String(executionResult.stdout ?? "").slice(-1_000_000);
    const stderr = String(executionResult.stderr ?? "").slice(-1_000_000);
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim().slice(-1_000_000);
    result = { success: true, summary: `${node.name} succeeded.`, output, stdout, stderr, exit_code: 0, script_path: scriptPath, working_directory: workingDirectory };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    const stdout = String(failure.stdout ?? "").slice(-1_000_000);
    const stderr = String(failure.stderr ?? "").slice(-1_000_000);
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim().slice(-1_000_000);
    result = {
      success: false,
      summary: `${node.name} failed${typeof failure.code === "number" ? ` with exit code ${failure.code}` : ""}: ${failure.message}`,
      output,
      stdout,
      stderr,
      exit_code: typeof failure.code === "number" ? failure.code : null,
      script_path: scriptPath,
      working_directory: workingDirectory,
    };
  }
  const pending: PendingActivityArtifact[] = [];
  for (const declaration of node.artifacts ?? []) {
    const candidate = resolve(workingDirectory, declaration.path);
    if (!inside(workingDirectory, candidate)) throw new Error(`Declared artifact ${declaration.name} escapes the activity working directory`);
    try {
      const path = await realpath(candidate);
      const details = await stat(path);
      if (!inside(workingDirectory, path) || !details.isFile()) throw new Error(`Declared artifact ${declaration.name} is not a contained regular file`);
      pending.push({ key: declaration.name, kind: declaration.interpretation?.kind === "quality_report" ? "quality_report" : "script_artifact", filename: basename(path), content_type: declaration.content_type, path, ...(declaration.presentation ? { presentation: declaration.presentation } : {}) });
    } catch (error) {
      if (declaration.required) throw new Error(`Required artifact ${declaration.name} was not produced: ${(error as Error).message}`);
    }
  }
  if (pending.length) result.pending_artifacts = pending;
  try {
    const content = await readFile(resultPath, "utf8");
    if (Buffer.byteLength(content) > 65_536) throw new Error("structured activity result exceeds 64 KiB");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("structured activity result must be a JSON object");
    const value = parsed as { metadata?: unknown; external_references?: unknown };
    if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata))) throw new Error("structured activity metadata must be an object");
    if (value.external_references !== undefined && !Array.isArray(value.external_references)) throw new Error("structured activity external_references must be an array");
    result.structured_result = parsed as NonNullable<ActivityResult["structured_result"]>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      result.success = false;
      result.exit_code = null;
      result.summary = `${node.name} produced an invalid structured result: ${(error as Error).message}`;
    }
  } finally {
    await rm(resultPath, { force: true });
  }
  return result;
}
