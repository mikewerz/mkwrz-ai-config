import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeIntakeSource, IntakeExecutionError } from "./intake.js";
import type { ClaimedIntakeRun } from "./types.js";

const cleanup: string[] = [];

function run(): ClaimedIntakeRun {
  return {
    id: "run-1", mode: "preview", source_id: "new-relic", source_revision: "a".repeat(64), campaign_id: "performance", campaign_revision: "b".repeat(64), attempt: 1, lease_id: "lease-1",
    cursor_before: { last_issue: 41 },
    source: {
      version: 1, id: "new-relic", name: "New Relic", description: "", campaign_id: "performance",
      runner: { type: "supervisor_script", language: "shell", script_path: "tools/discover.sh", working_directory: ".", timeout_seconds: 5 },
      ticket: {}, limits: {},
    },
  };
}

afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("executeIntakeSource", () => {
  it("passes durable source context and reads the standardized candidate result", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "agentic-intake-runner-")); cleanup.push(root);
    await mkdir(join(root, "tools"));
    await writeFile(join(root, "tools", "discover.sh"), `set -eu
printf '%s' "$AGENTIC_INTAKE_CURSOR_JSON" >&2
printf '%s\n' '{"candidates":[{"external_key":"NR-42","title":"Slow endpoint","description":"Reduce p95."}],"cursor":{"last_issue":42}}' > "$AGENTIC_INTAKE_RESULT_PATH"
printf '%s\n' "source=$AGENTIC_INTAKE_SOURCE_ID mode=$AGENTIC_INTAKE_MODE campaign_revision=$AGENTIC_INTAKE_CAMPAIGN_REVISION"
`);

    // Execute
    const result = await executeIntakeSource(root, join(root, ".assignments"), run(), new AbortController().signal);

    // Verify
    expect(result.candidates).toEqual([{ external_key: "NR-42", title: "Slow endpoint", description: "Reduce p95." }]);
    expect(result.cursor).toEqual({ last_issue: 42 });
    expect(result.output).toContain("source=new-relic");
    expect(result.output).toContain("mode=preview");
    expect(result.output).toContain(`campaign_revision=${"b".repeat(64)}`);
    expect(result.output).toContain('{"last_issue":41}');
  });

  it("fails clearly when the source does not write its result contract", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "agentic-intake-runner-")); cleanup.push(root);
    await mkdir(join(root, "tools"));
    await writeFile(join(root, "tools", "discover.sh"), "printf '%s\\n' 'useful diagnostic'\n");

    // Execute and verify
    const error = await executeIntakeSource(root, join(root, ".assignments"), run(), new AbortController().signal).catch((failure) => failure);
    expect(error).toBeInstanceOf(IntakeExecutionError);
    expect(error.message).toContain("AGENTIC_INTAKE_RESULT_PATH");
    expect(error.output).toContain("useful diagnostic");
  });
});
