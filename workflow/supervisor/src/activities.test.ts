import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runRepositoryActivity } from "./activities.js";
import type { ClaimedTicket } from "./types.js";

const roots: string[] = [];
const execute = promisify(execFile);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function claim(root: string, activity: {
  action?: string;
  script_file?: { relative_to: "selected_repository" | "primary_repository" | "project_root"; path?: string; path_input?: string };
  working_directory?: { relative_to: "selected_repository" | "primary_repository" | "project_root"; path?: string; path_input?: string };
  inline?: { language: "shell" | "python" | "javascript"; code: string };
} = { action: "verify" }): ClaimedTicket {
  return {
    id: "AGENT-0001", path: join(root, "ticket.md"), markdown: "# Work",
    frontmatter: {
      id: "AGENT-0001", title: "Activity", phase: "implementation", status: "running", work_provider: "claude", review_provider: "codex",
      repositories: [{ id: "demo", primary: true }], pull_requests: [],
      agents: { specification: { provider: null, herdr_pane_id: null, session_ref: null }, implementation: { provider: null, herdr_pane_id: null, session_ref: null }, review: { provider: null, herdr_pane_id: null, session_ref: null } },
      execution: { lease_id: "lease", provider: "codex", interrupt_request: null, node_run_id: "run", node_id: "verify", node_type: "script" },
    },
    workflow_node: { id: "verify", name: "Repository verification", type: "script", phase: "implementation", repository: "primary", ...activity, outcomes: [], choices: [], exit_codes: [{ id: "success", label: "Success", description: "", target: "done", codes: [0] }, { id: "failure", label: "Failure", description: "", target: "repair", default: true }] },
  };
}

describe("repository activities", () => {
  it("runs only an executable repository-owned action with durable metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-actions-")); roots.push(root);
    const actions = join(root, "demo", ".agents", "actions"); await mkdir(actions, { recursive: true });
    const script = join(actions, "verify.sh");
    await writeFile(script, "#!/bin/sh\nprintf '%s:%s' \"$AGENTIC_TICKET_ID\" \"$AGENTIC_NODE_RUN_ID\"\n"); await chmod(script, 0o700);
    await expect(runRepositoryActivity(root, claim(root))).resolves.toMatchObject({ success: true, output: "AGENT-0001:run", exit_code: 0 });
  });

  it("rejects an action symlink that resolves outside the allowlisted directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-actions-")); roots.push(root);
    const actions = join(root, "demo", ".agents", "actions"); await mkdir(actions, { recursive: true });
    const outside = join(root, "outside.sh"); await writeFile(outside, "#!/bin/sh\nexit 0\n"); await chmod(outside, 0o700);
    await symlink(outside, join(actions, "verify.sh"));
    await expect(runRepositoryActivity(root, claim(root))).rejects.toThrow("resolves outside");
  });

  it("executes trusted inline shell, JavaScript, and Python in the selected repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-inline-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    const activities = [
      { language: "shell" as const, code: "printf 'shell:%s' \"$AGENTIC_TICKET_ID\"", expected: "shell:AGENT-0001" },
      { language: "javascript" as const, code: "process.stdout.write(`javascript:${process.env.AGENTIC_NODE_RUN_ID}`)", expected: "javascript:run" },
      { language: "python" as const, code: "import os; print('python:' + os.environ['AGENTIC_REPOSITORY_ID'], end='')", expected: "python:demo" },
    ];
    for (const activity of activities) {
      await expect(runRepositoryActivity(root, claim(root, { inline: activity }))).resolves.toMatchObject({ success: true, output: activity.expected, exit_code: 0 });
    }
  });

  it("returns inline program exit codes for workflow routing", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-inline-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    await expect(runRepositoryActivity(root, claim(root, { inline: { language: "shell", code: "printf failure >&2; exit 7" } }))).resolves.toMatchObject({
      success: false, output: "failure", exit_code: 7,
    });
  });

  it("resolves ticket-provided script and working-directory paths against independent bases", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-paths-")); roots.push(root);
    const primary = join(root, "demo");
    const selected = join(root, "shared");
    await mkdir(join(primary, "tools"), { recursive: true });
    await mkdir(join(selected, "services", "api"), { recursive: true });
    const script = join(primary, "tools", "deploy.sh");
    await writeFile(script, "#!/bin/sh\nprintf '%s\\n%s\\n%s' \"$PWD\" \"$AGENTIC_SCRIPT_PATH\" \"$AGENTIC_WORKING_DIRECTORY\"\n");
    await chmod(script, 0o700);
    const ticket = claim(root, {
      script_file: { relative_to: "primary_repository", path_input: "deploy_script" },
      working_directory: { relative_to: "selected_repository", path_input: "deploy_directory" },
    });
    ticket.frontmatter.repositories = [{ id: "demo", primary: true }, { id: "shared", primary: false }];
    ticket.frontmatter.workflow = {
      id: "paths", revision: "workflow-revision", current_node: "deploy",
      inputs: { deploy_script: "tools/deploy.sh", deploy_directory: "services/api" }, incoming: null,
    };
    ticket.workflow_node = {
      ...ticket.workflow_node!, id: "deploy", name: "Deploy", type: "script", phase: "implementation", repository: "shared",
      script_file: { relative_to: "primary_repository", path_input: "deploy_script" },
      working_directory: { relative_to: "selected_repository", path_input: "deploy_directory" },
      outcomes: [], choices: [], exit_codes: [{ id: "success", label: "Success", description: "Done.", target: "done", codes: [0] }],
    };

    const result = await runRepositoryActivity(root, ticket);
    const expectedScript = await realpath(script);
    const expectedWorkingDirectory = await realpath(join(selected, "services", "api"));
    expect(result).toMatchObject({ success: true, script_path: expectedScript, working_directory: expectedWorkingDirectory });
    expect(result.output).toBe(`${expectedWorkingDirectory}\n${expectedScript}\n${expectedWorkingDirectory}`);
  });

  it("rejects ticket-provided paths that escape their configured base", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-path-escape-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    const ticket = claim(root, {
      script_file: { relative_to: "selected_repository", path_input: "script" },
      working_directory: { relative_to: "selected_repository", path: "." },
    });
    ticket.frontmatter.workflow = { id: "paths", revision: "revision", current_node: "verify", inputs: { script: "../outside.sh" }, incoming: null };
    await expect(runRepositoryActivity(root, ticket)).rejects.toThrow("script path escapes selected_repository");
  });

  it("cancels a running inline activity when its workflow lease is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-inline-abort-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    const controller = new AbortController();
    const started = Date.now();
    const activity = runRepositoryActivity(root, claim(root, { inline: { language: "shell", code: "sleep 10" } }), controller.signal);
    setTimeout(() => controller.abort(), 25);
    await expect(activity).resolves.toMatchObject({ success: false, exit_code: null });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("passes selected and multi-repository branch context through flags and environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-context-")); roots.push(root);
    for (const repository of ["demo", "shared"]) {
      const path = join(root, repository); await mkdir(path, { recursive: true });
      await execute("git", ["init", "--initial-branch", "main"], { cwd: path });
      await writeFile(join(path, "README.md"), repository);
      await execute("git", ["-c", "user.name=Agent", "-c", "user.email=agent@example.test", "add", "README.md"], { cwd: path });
      await execute("git", ["-c", "user.name=Agent", "-c", "user.email=agent@example.test", "commit", "-m", "initial"], { cwd: path });
      await execute("git", ["remote", "add", "origin", `https://github.com/example/${repository}.git`], { cwd: path });
      await execute("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: path });
      await execute("git", ["switch", "-c", `feature/${repository}`], { cwd: path });
    }
    const actions = join(root, "demo", ".agents", "actions"); await mkdir(actions, { recursive: true });
    const script = join(actions, "verify.sh");
    await writeFile(script, "#!/bin/sh\nprintf 'env:%s:%s:%s\\n' \"$AGENTIC_PROJECT_ROOT\" \"$AGENTIC_CURRENT_BRANCH\" \"$AGENTIC_DEFAULT_BRANCH\"\nprintf 'json:%s\\n' \"$AGENTIC_CONTEXT_JSON\"\nprintf 'args:'\nprintf '%s|' \"$@\"\n");
    await chmod(script, 0o700);
    const ticket = claim(root);
    ticket.frontmatter.repositories = [{ id: "demo", primary: true }, { id: "shared", primary: false }];
    ticket.frontmatter.pull_requests = [
      { repository: "demo", url: "https://github.com/example/demo/pull/7", phase: "implementation" },
      { repository: "shared", url: "https://github.com/example/shared/pull/8", phase: "implementation" },
    ];
    ticket.frontmatter.workflow = {
      id: "dev-only", revision: "workflow-revision", current_node: "verify",
      incoming: { source_node: "implementation", target_node: "verify", outcome: "completed", summary: "Built both repos.", handoff: "Run the callback.", actor: "claude" },
    };
    ticket.frontmatter.execution.attempt = 2;

    const result = await runRepositoryActivity(root, ticket);
    const projectRoot = await realpath(root);
    expect(result.success).toBe(true);
    expect(result.output).toContain(`env:${projectRoot}:feature/demo:main`);
    expect(result.output).toContain('"selected_repository":"demo"');
    expect(result.output).toContain('"id":"shared"');
    expect(result.output).toContain('"current_branch":"feature/shared"');
    expect(result.output).toContain('"url":"https://github.com/example/shared/pull/8"');
    expect(result.output).toContain(`args:--context-json|`);
    expect(result.output).toContain(`|--project-root|${projectRoot}|--repository-id|demo|--repository-path|${join(projectRoot, "demo")}|`);
    expect(result.output).toContain("|--current-branch|feature/demo|--default-branch|main|--head-sha|");
  });
});
