import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ClaimedIntakeRun, IntakeCandidate } from "./types.js";

export interface IntakeExecutionResult {
  candidates: IntakeCandidate[];
  cursor?: unknown;
  output: string;
}

export class IntakeExecutionError extends Error {
  constructor(message: string, public readonly output: string) {
    super(message);
    this.name = "IntakeExecutionError";
  }
}

function boundedOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n").slice(0, 1024 * 1024);
}

function underRoot(root: string, value: string, field: string): string {
  const path = resolve(root, value);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith("..") || resolve(root, fromRoot) !== path) throw new Error(`${field} escapes the supervisor project root`);
  return path;
}

function command(language: "shell" | "python" | "javascript", script: string): [string, string[]] {
  if (language === "python") return ["python3", [script]];
  if (language === "javascript") return [process.execPath, [script]];
  return ["/bin/sh", [script]];
}

function runProcess(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    execFile(executable, args, { ...options, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const detail = [error.message, stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new IntakeExecutionError(detail, boundedOutput(stdout, stderr)));
      } else resolveResult({ stdout, stderr });
    });
  });
}

export async function executeIntakeSource(projectRoot: string, assignmentRoot: string, run: ClaimedIntakeRun, signal: AbortSignal): Promise<IntakeExecutionResult> {
  const runner = run.source.runner;
  const script = underRoot(projectRoot, runner.script_path, "runner.script_path");
  const cwd = underRoot(projectRoot, runner.working_directory, "runner.working_directory");
  const runDirectory = join(assignmentRoot, "intake", run.source_id, run.id, `attempt-${run.attempt}`);
  const resultPath = join(runDirectory, "result.json");
  await mkdir(dirname(resultPath), { recursive: true });
  const [executable, args] = command(runner.language, script);
  try {
    const result = await runProcess(executable, args, {
      cwd,
      timeout: runner.timeout_seconds * 1_000,
      signal,
      env: {
        ...process.env,
        AGENTIC_INTAKE_PROTOCOL_VERSION: "1",
        AGENTIC_INTAKE_MODE: run.mode,
        AGENTIC_INTAKE_SOURCE_ID: run.source_id,
        AGENTIC_INTAKE_SOURCE_REVISION: run.source_revision,
        AGENTIC_INTAKE_CAMPAIGN_ID: run.campaign_id,
        AGENTIC_INTAKE_CAMPAIGN_REVISION: run.campaign_revision,
        AGENTIC_INTAKE_RUN_ID: run.id,
        AGENTIC_INTAKE_ATTEMPT: String(run.attempt),
        AGENTIC_INTAKE_PROJECT_ROOT: projectRoot,
        AGENTIC_INTAKE_RESULT_PATH: resultPath,
        AGENTIC_INTAKE_CURSOR_JSON: JSON.stringify(run.cursor_before ?? null),
        AGENTIC_INTAKE_SOURCE_JSON: JSON.stringify(run.source),
      },
    });
    const output = boundedOutput(result.stdout, result.stderr);
    let decoded: unknown;
    try {
      if ((await stat(resultPath)).size > 1_500_000) throw new Error("result exceeds 1.5 MB");
      decoded = JSON.parse(await readFile(resultPath, "utf8"));
    }
    catch (error) { throw new IntakeExecutionError(`Source did not write valid JSON to AGENTIC_INTAKE_RESULT_PATH (${resultPath}): ${(error as Error).message}`, output); }
    if (!decoded || typeof decoded !== "object" || !Array.isArray((decoded as { candidates?: unknown }).candidates)) {
      throw new IntakeExecutionError("Source result must be an object with a candidates array", output);
    }
    const value = decoded as { candidates: IntakeCandidate[]; cursor?: unknown };
    return {
      candidates: value.candidates,
      ...(Object.prototype.hasOwnProperty.call(value, "cursor") ? { cursor: value.cursor } : {}),
      output,
    };
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}
