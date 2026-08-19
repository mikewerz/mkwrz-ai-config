import { execFile, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { accessSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ActivityCapability, ClaimedTicket } from "./types.js";

const execute = promisify(execFile);

export function detectActivityCapabilities(): ActivityCapability[] {
  const capabilities: ActivityCapability[] = ["repository_action", "inline_javascript"];
  try { accessSync("/bin/sh", constants.X_OK); capabilities.push("inline_shell"); } catch { /* unavailable */ }
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); capabilities.push("inline_python"); } catch { /* unavailable */ }
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
}

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

export async function runRepositoryActivity(projectRoot: string, ticket: ClaimedTicket, signal?: AbortSignal): Promise<ActivityResult> {
  const node = ticket.workflow_node;
  if (!node || node.type !== "script" || !node.repository || Boolean(node.script_file ?? node.action) === Boolean(node.inline)) {
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
  const inputs = ticket.frontmatter.workflow?.inputs ?? {};
  const bases = {
    selected_repository: realRepository,
    primary_repository: primaryRepository.path,
    project_root: realProjectRoot,
  };
  const workingDirectoryReference = node.working_directory ?? { relative_to: "selected_repository" as const, path: "." };
  const workingDirectory = await resolvedContainedPath(workingDirectoryReference, inputs, bases, `Workflow node ${node.id} working directory`);
  const scriptFileReference = node.script_file ?? (node.action
    ? { relative_to: "selected_repository" as const, path: `.agents/actions/${node.action}.sh` }
    : null);
  const scriptPath = scriptFileReference
    ? await resolvedContainedPath(scriptFileReference, inputs, bases, `Workflow node ${node.id} script path`)
    : null;
  const incoming = ticket.frontmatter.workflow?.incoming;
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
  try {
    const result = await execute(executable, arguments_, { cwd: workingDirectory, env: environment, timeout: 30 * 60_000, maxBuffer: 1_000_000, signal });
    const stdout = String(result.stdout ?? "").slice(-1_000_000);
    const stderr = String(result.stderr ?? "").slice(-1_000_000);
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim().slice(-1_000_000);
    return { success: true, summary: `${node.name} succeeded.`, output, stdout, stderr, exit_code: 0, script_path: scriptPath, working_directory: workingDirectory };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    const stdout = String(failure.stdout ?? "").slice(-1_000_000);
    const stderr = String(failure.stderr ?? "").slice(-1_000_000);
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim().slice(-1_000_000);
    return {
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
}
