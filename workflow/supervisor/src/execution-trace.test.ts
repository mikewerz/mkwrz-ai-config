import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionTraceRecorder } from "./execution-trace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("ExecutionTraceRecorder", () => {
  it("spools every event locally and uploads sequence-fenced batches", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "execution-trace-")); roots.push(root);
    const batches: Array<{ firstSequence: number; completed?: boolean; events: Array<{ sequence: number; event: string }> }> = [];
    const transport = { appendExecutionTrace: vi.fn(async (_lease: string, input: typeof batches[number] & { traceId: string }) => {
      batches.push(input); return { next_sequence: input.events.at(-1)!.sequence + 1 };
    }) };
    const recorder = new ExecutionTraceRecorder(transport, "lease-1", root, { ticket_id: "AGENT-1" }, 2, 60_000);

    // Execute
    await recorder.start();
    recorder.record("herdr.command_started", { command: "agent.get" });
    recorder.record("herdr.command_completed", { command: "agent.get" });
    recorder.record("herdr.observation", { state: "idle" });
    recorder.record("herdr.observation", { state: "idle" });
    await recorder.close("callback");

    // Verify
    expect(batches.flatMap((batch) => batch.events).map((event) => event.event)).toEqual([
      "execution.trace_started", "herdr.command_started", "herdr.command_completed", "herdr.observation", "execution.trace_finished",
    ]);
    expect(batches.at(-1)?.completed).toBe(true);
    const persisted = (await readFile(recorder.spoolPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(persisted.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("retains an unacknowledged batch and retries it without changing sequence numbers", async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), "execution-trace-retry-")); roots.push(root);
    const attempts: number[][] = [];
    let unavailable = true;
    const transport = { appendExecutionTrace: vi.fn(async (_lease: string, input: { events: Array<{ sequence: number }> }) => {
      attempts.push(input.events.map((event) => event.sequence));
      if (unavailable) throw new Error("tracker unavailable");
      return { next_sequence: input.events.at(-1)!.sequence + 1 };
    }) };
    const recorder = new ExecutionTraceRecorder(transport, "lease-1", root, {}, 64, 60_000);

    // Execute
    await recorder.start();
    recorder.record("delivery.assignment_prepared");
    unavailable = false;
    await recorder.close("callback");

    // Verify
    expect(attempts).toEqual([[1], [1, 2, 3]]);
  });
});
