import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  script_file?: { relative_to: "selected_repository" | "primary_repository" | "project_root"; path?: string; path_input?: string };
  working_directory?: { relative_to: "selected_repository" | "primary_repository" | "project_root"; path?: string; path_input?: string };
  inline?: { language: "shell" | "python" | "javascript"; code: string };
} = { script_file: { relative_to: "selected_repository", path: ".agents/actions/verify.sh" } }): ClaimedTicket {
  return {
    id: "AGENT-0001", path: join(root, "ticket.md"), markdown: "# Work",
    frontmatter: {
      id: "AGENT-0001", title: "Activity", phase: "implementation", status: "running",
      repositories: [{ id: "demo", primary: true }], pull_requests: [],
      workflow: { id: "delivery", revision: "r1", current_node: "verify", inputs: {} },
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

  it("captures bounded provider-neutral structured results from the declared result path", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-structured-result-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    const result = await runRepositoryActivity(root, claim(root, { inline: {
      language: "shell",
      code: `printf '%s' '{"metadata":{"deployment.id":"deploy-123","deployment.ready":false},"external_references":[{"type":"deployment","id":"deploy-123","url":"https://deploy.example/123"}]}' > "$AGENTIC_RESULT_PATH"`,
    } }));
    expect(result).toMatchObject({
      success: true,
      structured_result: {
        metadata: { "deployment.id": "deploy-123", "deployment.ready": false },
        external_references: [{ type: "deployment", id: "deploy-123", url: "https://deploy.example/123" }],
      },
    });
  });

  it("stages declared quality YAML as a specialized tracker artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-quality-artifact-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    const ticket = claim(root, { inline: { language: "shell", code: "printf 'schema: agentic-quality/v1\\nattributes: []\\n' > quality.yaml" } });
    ticket.workflow_node!.artifacts = [{
      name: "verification-quality", path: "quality.yaml", content_type: "application/yaml", required: true,
      interpretation: { kind: "quality_report", schema: "agentic-quality/v1", required_attributes: [] },
    }];
    const result = await runRepositoryActivity(root, ticket);
    expect(result.pending_artifacts).toEqual([expect.objectContaining({ key: "verification-quality", kind: "quality_report", filename: "quality.yaml", content_type: "application/yaml" })]);
  });

  it("leaves quality interpretation to the tracker and stages the exact produced bytes", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "factory-quality-artifact-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    const ticket = claim(root, { inline: { language: "shell", code: "printf 'not: valid: quality: yaml' > quality.yaml" } });
    ticket.workflow_node!.artifacts = [{
      name: "verification-quality", path: "quality.yaml", content_type: "application/yaml", required: true,
      interpretation: { kind: "quality_report", schema: "agentic-quality/v1", required_attributes: ["tests.pass_rate"] },
    }];

    // Act
    const result = await runRepositoryActivity(root, ticket);
    const staged = result.pending_artifacts![0]!;

    // Assert
    expect(staged).toMatchObject({ key: "verification-quality", kind: "quality_report" });
    expect(await readFile(staged.path, "utf8")).toBe("not: valid: quality: yaml");
  });

  it("fails the activity contract when a required quality artifact is absent", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "factory-quality-artifact-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    const ticket = claim(root, { inline: { language: "shell", code: "true" } });
    ticket.workflow_node!.artifacts = [{
      name: "verification-quality", path: "quality.yaml", content_type: "application/yaml", required: true,
      interpretation: { kind: "quality_report", schema: "agentic-quality/v1", required_attributes: [] },
    }];

    // Act
    const action = runRepositoryActivity(root, ticket);

    // Assert
    await expect(action).rejects.toThrow("Required artifact verification-quality was not produced");
  });

  it("does not create phantom records for absent optional quality artifacts", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "factory-quality-artifact-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    const ticket = claim(root, { inline: { language: "shell", code: "true" } });
    ticket.workflow_node!.artifacts = [{
      name: "verification-quality", path: "quality.yaml", content_type: "application/yaml", required: false,
      interpretation: { kind: "quality_report", schema: "agentic-quality/v1", required_attributes: [] },
    }];

    // Act
    const result = await runRepositoryActivity(root, ticket);

    // Assert
    expect(result).not.toHaveProperty("pending_artifacts");
  });

  it("rejects a declared quality artifact that resolves outside the activity directory", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "factory-quality-artifact-")); roots.push(root);
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(join(root, "outside.yaml"), "schema: agentic-quality/v1\nattributes: []\n");
    const ticket = claim(root, { inline: { language: "shell", code: "true" } });
    ticket.workflow_node!.artifacts = [{
      name: "verification-quality", path: "../outside.yaml", content_type: "application/yaml", required: true,
      interpretation: { kind: "quality_report", schema: "agentic-quality/v1", required_attributes: [] },
    }];

    // Act
    const action = runRepositoryActivity(root, ticket);

    // Assert
    await expect(action).rejects.toThrow("escapes the activity working directory");
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
  }, 20_000);

  it("captures uncommitted repository state in a portable bundle and restores it deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-checkpoint-")); roots.push(root);
    const repository = join(root, "demo"); await mkdir(repository, { recursive: true });
    await execute("git", ["init", "--initial-branch", "main"], { cwd: repository });
    await writeFile(join(repository, "tracked.txt"), "base\n");
    await execute("git", ["-c", "user.name=Agent", "-c", "user.email=agent@example.test", "add", "tracked.txt"], { cwd: repository });
    await execute("git", ["-c", "user.name=Agent", "-c", "user.email=agent@example.test", "commit", "-m", "base"], { cwd: repository });
    const originalHead = String((await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout).trim();
    await writeFile(join(repository, "tracked.txt"), "checkpoint\n");
    await writeFile(join(repository, "untracked.txt"), "also checkpointed\n");
    const staging = join(root, "staging");
    const checkpointTicket = claim(root);
    checkpointTicket.frontmatter.execution.node_type = "checkpoint";
    checkpointTicket.workflow_node = { id: "save", name: "Save work", type: "checkpoint", phase: "implementation", checkpoint_label: "Before experiment", outcomes: [], choices: [], exit_codes: [] };
    const captured = await runRepositoryActivity(root, checkpointTicket, undefined, { directory: staging });
    expect(captured.checkpoints?.[0]).toMatchObject({ label: "Before experiment", repositories: [{ repository: "demo", dirty: true }] });
    const bundle = captured.pending_artifacts?.[0];
    expect(bundle?.kind).toBe("checkpoint_bundle");

    await writeFile(join(repository, "tracked.txt"), "later\n");
    await rm(join(repository, "untracked.txt"));
    await writeFile(join(repository, "new.txt"), "remove me\n");
    const manifest = captured.checkpoints![0]!;
    const restoreTicket = claim(root);
    restoreTicket.frontmatter.metadata = { "checkpoint.restore_id": manifest.id };
    restoreTicket.frontmatter.checkpoints = [{
      id: manifest.id, label: manifest.label, kind: manifest.kind, node_id: "save", node_run_id: "run", created_at: manifest.created_at, manifest_artifact_id: "manifest",
      repositories: manifest.repositories.map(({ bundle_key, ...item }) => ({ ...item, bundle_artifact_id: "bundle" })),
    }];
    restoreTicket.frontmatter.execution.node_type = "restore_checkpoint";
    restoreTicket.workflow_node = { id: "restore", name: "Restore work", type: "restore_checkpoint", phase: "implementation", checkpoint_source: { mode: "latest" }, outcomes: [], choices: [], exit_codes: [] };
    await expect(runRepositoryActivity(root, restoreTicket, undefined, { directory: join(root, "restore"), artifact_paths: { bundle: bundle!.path } })).resolves.toMatchObject({ success: true, exit_code: 0 });
    expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("checkpoint\n");
    expect(await readFile(join(repository, "untracked.txt"), "utf8")).toBe("also checkpointed\n");
    await expect(readFile(join(repository, "new.txt"), "utf8")).rejects.toThrow();
    expect(String((await execute("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout).trim()).toBe(originalHead);
  }, 20_000);
});
