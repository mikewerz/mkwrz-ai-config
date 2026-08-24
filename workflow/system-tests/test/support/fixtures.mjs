import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function ticketMarkdown(id, repository = "fixture-repo") {
  return [
    "---",
    `id: ${id}`,
    `title: System test ${id}`,
    "priority: 10",
    "labels: [system-test]",
    `repositories: [{\"id\":\"${repository}\",\"primary\":true}]`,
    "---",
    "",
    "# Goal",
    "",
    "Exercise the production tracker and supervisor boundary without starting a real agent.",
    "",
  ].join("\n");
}

export function scriptWorkflow({ id, scriptPath = ".agents/actions/quality.sh" }) {
  return {
    version: 2,
    id,
    name: `System test ${id}`,
    description: "Repository-owned Script activity with required quality evidence.",
    start: "verify",
    max_transitions: 8,
    inputs: [],
    stages: [
      { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
      { id: "terminal", name: "Terminal", phase: "done", skippable: false, default_enabled: true },
    ],
    nodes: [
      {
        id: "verify",
        name: "Verify fixture",
        type: "script",
        phase: "implementation",
        stage: "work",
        repository: "primary",
        script_file: { relative_to: "selected_repository", path: scriptPath },
        working_directory: { relative_to: "selected_repository", path: "." },
        script_output: { persist_stdout: true, prompt_tail_lines: 10 },
        artifacts: [{
          name: "fixture-quality",
          path: "reports/quality.yaml",
          content_type: "application/yaml",
          required: true,
          interpretation: { kind: "quality_report", schema: "agentic-quality/v1", required_attributes: ["tests.pass_rate"] },
        }],
        exit_codes: [
          { id: "passed", label: "Passed", description: "Fixture verification passed.", target: "done", codes: [0], metric_class: "success" },
          { id: "failed", label: "Failed", description: "Fixture verification failed.", target: "failed", default: true, metric_class: "failure" },
        ],
      },
      { id: "done", name: "Done", type: "terminal", phase: "done", stage: "terminal", terminal_status: "completed", status_code: 0 },
      { id: "failed", name: "Failed", type: "terminal", phase: "done", stage: "terminal", terminal_status: "failed", status_code: 1 },
    ],
  };
}

export function agentWorkflow(id) {
  return {
    version: 2,
    id,
    name: `System test ${id}`,
    description: "Agent callback exercised only through fake Herdr.",
    start: "fake-work",
    max_transitions: 4,
    inputs: [],
    stages: [
      { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
      { id: "terminal", name: "Terminal", phase: "done", skippable: false, default_enabled: true },
    ],
    nodes: [
      {
        id: "fake-work",
        name: "Fake agent work",
        type: "agent",
        phase: "implementation",
        stage: "work",
        prompt: "implementation",
        agent_profile: "fake-claude",
        conversation_key: "work",
        conversation_policy: { mode: "resume" },
        outcomes: [{ id: "completed", label: "Complete", description: "Fake work completed.", target: "done", metric_class: "success" }],
      },
      { id: "done", name: "Done", type: "terminal", phase: "done", stage: "terminal", terminal_status: "completed", status_code: 0 },
    ],
  };
}

export async function createFixtureRepository(root, mode = "valid") {
  await mkdir(`${root}/.agents/actions`, { recursive: true });
  const lines = [
    "#!/bin/sh",
    "set -eu",
    "mkdir -p reports",
  ];
  if (mode === "invalid-first") {
    lines.push(
      "if [ \"${AGENTIC_ATTEMPT:-0}\" -eq 1 ]; then",
      "  printf '%s\\n' 'schema: invalid-system-test-schema' 'attributes: []' > reports/quality.yaml",
      "  printf '%s\\n' 'intentionally produced rejected evidence on attempt one'",
      "  exit 0",
      "fi",
    );
  }
  lines.push(
    "cat > reports/quality.yaml <<'QUALITY'",
    "schema: agentic-quality/v1",
    "name: System test quality",
    "subject:",
    "  type: repository",
    "  repository: fixture-repo",
    "producer:",
    "  tool: agentic-project-system-tests",
    "  version: 1",
    "attributes:",
    "  - key: tests.pass_rate",
    "    value: 1",
    "    unit: ratio",
    "    direction: higher_is_better",
    "    target: 1",
    "    status: pass",
    "QUALITY",
    "printf '%s\\n' 'fixture verification complete'",
  );
  const script = `${lines.join("\n")}\n`;
  const scriptPath = `${root}/.agents/actions/quality.sh`;
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  await writeFile(`${root}/README.md`, "# System-test fixture repository\n");
  await execute("git", ["init", "--initial-branch=main"], { cwd: root });
  await execute("git", ["config", "user.email", "system-tests@example.invalid"], { cwd: root });
  await execute("git", ["config", "user.name", "Agentic Project System Tests"], { cwd: root });
  await execute("git", ["add", "."], { cwd: root });
  await execute("git", ["commit", "-m", "Add deterministic system-test fixture"], { cwd: root });
  return root;
}
