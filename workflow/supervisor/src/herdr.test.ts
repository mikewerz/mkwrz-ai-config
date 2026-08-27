import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrController, agentName, launchArguments, resumeArguments, type CommandRunner } from "./herdr.js";

class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  async run(args: string[]): Promise<unknown> {
    this.calls.push(args);
    if (args[0] === "workspace") return { result: { root_pane: { pane_id: "w1:p1" } } };
    if (args[0] === "agent" && args[1] === "get") return { result: { agent: {
      agent_status: "working", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term-1",
      focused: false, cwd: "/srv/projects", foreground_cwd: "/srv/projects/demo",
      terminal_title: "⠋ Running tests", terminal_title_stripped: "Running tests", revision: 12,
      tokens: { model: "opus" }, agent_session: { source: "herdr:claude", kind: "id", value: "session-1" },
      interactive_ready: true, launch_pending: false,
    } } };
    return { result: {} };
  }
}

describe("HerdrController", () => {
  afterEach(() => vi.useRealTimers());

  it("creates a workspace without creating filesystem worktrees and starts an agent", async () => {
    const runner = new FakeRunner();
    const controller = new HerdrController(runner, "/srv/projects", { agentReadySettleMs: 0 });
    const observation = await controller.ensureAgent("APT-42", "claude", "work", null, null);
    expect(observation).toMatchObject({
      paneId: "w1:p1", state: "working", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      foregroundCwd: "/srv/projects/demo", terminalTitleStripped: "Running tests", sessionSource: "herdr:claude",
      tokens: { model: "opus" },
    });
    expect(runner.calls[0]).toEqual(["workspace", "create", "--cwd", "/srv/projects", "--label", "APT-42", "--no-focus"]);
    expect(runner.calls[1]).toContain("claude");
  });

  it("uses native provider resume syntax", () => {
    expect(resumeArguments("claude", "x")).toEqual(["--resume", "x"]);
    expect(resumeArguments("codex", "x")).toEqual(["resume", "x"]);
    expect(launchArguments("codex", "session", "gpt-5.6-sol", "high")).toEqual(["resume", "session", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"']);
    expect(launchArguments("claude", null, "claude-opus-4-6", "max")).toEqual(["--model", "claude-opus-4-6", "--effort", "max"]);
    expect(agentName("APT-123_really-long-ticket", "codex", "work")).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    expect(agentName("APT-123_really-long-ticket", "codex", "work")).not.toBe(agentName("APT-123_really-long-ticket-2", "codex", "work"));
    expect(agentName("APT-123_really-long-ticket", "codex", "work")).not.toBe(agentName("APT-123_really-long-ticket", "codex", "review"));
  });

  it("traces Herdr commands and observations without copying prompt or terminal contents", async () => {
    // Arrange
    const runner = new FakeRunner();
    const controller = new HerdrController(runner, "/srv/projects");
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];

    // Execute
    await controller.withTrace({ record: (event, data) => events.push({ event, ...(data ? { data } : {}) }) }, async () => {
      await controller.promptAndConfirm("w1:p1", "secret durable assignment contents");
      await controller.observe("w1:p1");
    });

    // Verify
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret durable assignment contents");
    expect(events).toContainEqual(expect.objectContaining({ event: "herdr.command_started", data: expect.objectContaining({ command: "agent.prompt", payload_bytes: 34, payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }));
    expect(events).toContainEqual(expect.objectContaining({ event: "herdr.observation", data: expect.objectContaining({ pane_id: "w1:p1", state: "working", revision: 12 }) }));
  });

  it("reads a bounded provenance transcript from the pane scrollback", async () => {
    const runner = new FakeRunner();
    const controller = new HerdrController(runner, "/srv/projects");

    await controller.readTranscript("w1:p1", 5_000);

    expect(runner.calls.at(-1)).toEqual(["agent", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "5000"]);
    await expect(controller.readTranscript("w1:p1", 100_001)).rejects.toThrow("between 1 and 100000");
  });

  it("retries transcript capture while Herdr is still finalizing the agent pane", async () => {
    // Arrange
    let reads = 0;
    const runText = vi.fn(async () => {
      reads += 1;
      if (reads < 3) throw Object.assign(new Error("agent is still working"), {
        stderr: '{"error":{"code":"agent_not_idle"}}\n',
      });
      return "complete transcript";
    });
    const controller = new HerdrController({ run: vi.fn(), runText }, "/srv/projects", {
      transcriptRetryIntervalMs: 1, transcriptRetryTimeoutMs: 50,
    });

    // Execute
    const transcript = await controller.readTranscript("w1:p1", 5_000);

    // Verify
    expect(transcript).toBe("complete transcript");
    expect(runText).toHaveBeenCalledTimes(3);
  });

  it("does not retry transcript failures that are unrelated to agent finalization", async () => {
    // Arrange
    const runText = vi.fn(async () => {
      throw Object.assign(new Error("pane does not exist"), { stderr: '{"error":{"code":"agent_not_found"}}\n' });
    });
    const controller = new HerdrController({ run: vi.fn(), runText }, "/srv/projects", {
      transcriptRetryIntervalMs: 1, transcriptRetryTimeoutMs: 50,
    });

    // Execute and verify
    await expect(controller.readTranscript("w1:p1", 5_000)).rejects.toThrow("pane does not exist");
    expect(runText).toHaveBeenCalledTimes(1);
  });

  it("waits for a new macOS login-shell pane to accept the agent start", async () => {
    vi.useFakeTimers();
    let starts = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "workspace") return { result: { root_pane: { pane_id: "w1:p1" } } };
      if (args[0] === "agent" && args[1] === "start" && ++starts < 3) {
        throw Object.assign(new Error("pane shell is still starting"), {
          stderr: '{"error":{"code":"agent_pane_busy"}}\n',
        });
      }
      if (args[0] === "agent" && args[1] === "get") return { result: { agent: { agent_status: "working", interactive_ready: true, launch_pending: false } } };
      return { result: {} };
    });
    const pending = new HerdrController({ run }, "/srv/projects").ensureAgent("APT-42", "claude", "work", null, null);

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ paneId: "w1:p1", state: "working" });
    expect(run.mock.calls.filter(([args]) => args[0] === "agent" && args[1] === "start")).toHaveLength(3);
  });

  it("uses the same pane-busy retry when restoring an agent into a saved pane", async () => {
    vi.useFakeTimers();
    let observations = 0;
    let starts = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "agent" && args[1] === "get") {
        if (++observations === 1) throw new Error("saved pane has no attached agent");
        return { result: { agent: { agent_status: "working", interactive_ready: true, launch_pending: false, agent_session: { value: "session-1" } } } };
      }
      if (args[0] === "agent" && args[1] === "start" && ++starts === 1) {
        throw Object.assign(new Error("pane shell is still starting"), {
          stderr: 'diagnostic\n{"error":{"kind":"server","details":{"code":"agent_pane_busy"}}}\n',
        });
      }
      return { result: {} };
    });
    const pending = new HerdrController({ run }, "/srv/projects").ensureAgent("APT-42", "claude", "work", "w9:p2", "session-1");

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ paneId: "w9:p2", sessionRef: "session-1" });
    const startCalls = run.mock.calls.filter(([args]) => args[0] === "agent" && args[1] === "start");
    expect(startCalls).toHaveLength(2);
    expect(startCalls[1]?.[0]).toContain("--resume");
  });

  it("stops retrying pane-busy after ten seconds and does not retry other startup errors", async () => {
    vi.useFakeTimers();
    const busy = Object.assign(new Error("pane stayed busy"), { stderr: '{"error":{"code":"agent_pane_busy"}}\n' });
    const busyRun = vi.fn(async (args: string[]) => {
      if (args[0] === "workspace") return { result: { root_pane: { pane_id: "w1:p1" } } };
      throw busy;
    });
    const busyResult = new HerdrController({ run: busyRun }, "/srv/projects")
      .ensureAgent("APT-42", "claude", "work", null, null).catch((error) => error);

    await vi.runAllTimersAsync();

    expect(await busyResult).toBe(busy);
    expect(busyRun.mock.calls.filter(([args]) => args[0] === "agent" && args[1] === "start")).toHaveLength(21);

    const failure = Object.assign(new Error("agent cannot start"), { stderr: '{"error":{"code":"agent_not_running"}}\n' });
    const failedRun = vi.fn(async (args: string[]) => {
      if (args[0] === "workspace") return { result: { root_pane: { pane_id: "w2:p1" } } };
      throw failure;
    });
    await expect(new HerdrController({ run: failedRun }, "/srv/projects").ensureAgent("APT-43", "codex", "work", null, null)).rejects.toBe(failure);
    expect(failedRun.mock.calls.filter(([args]) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
  });

  it("waits for interactive readiness to settle before returning a newly started agent", async () => {
    vi.useFakeTimers();
    let observations = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "workspace") return { result: { root_pane: { pane_id: "w1:p1" } } };
      if (args[0] === "agent" && args[1] === "get") {
        observations += 1;
        const ready = observations >= 3;
        return { result: { agent: { agent_status: "idle", interactive_ready: ready, launch_pending: !ready } } };
      }
      return { result: {} };
    });
    const pending = new HerdrController({ run }, "/srv/projects", {
      agentReadyTimeoutMs: 5_000, agentReadySettleMs: 1_000,
    }).ensureAgent("APT-42", "claude", "work", null, null);

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ interactiveReady: true, launchPending: false });
    expect(observations).toBeGreaterThanOrEqual(5);
  });

  it("treats Herdr stalled and timeout results as unconfirmed delivery", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ result: { agent: { agent_status: "done" } } })
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), {
        stderr: 'diagnostic\n{"error":{"code":"timeout","message":"still working"}}\n',
      }))
      .mockRejectedValueOnce(Object.assign(new Error("stalled"), {
        stderr: '{"error":{"kind":"server","details":{"code":"agent_prompt_stalled"},"message":"no lifecycle change"}}\n',
      }));
    const controller = new HerdrController({ run } as CommandRunner, "/srv/projects");

    await expect(controller.promptAndConfirm("w1:p1", "First assignment")).resolves.toBe(true);
    await expect(controller.promptAndConfirm("w1:p1", "Second assignment")).resolves.toBe(false);
    await expect(controller.promptAndConfirm("w1:p1", "Third assignment")).resolves.toBe(false);
    expect(run).toHaveBeenNthCalledWith(1, ["agent", "prompt", "w1:p1", "First assignment", "--wait", "--timeout", "6000"]);
  });

  it("does not hide unexpected Herdr prompt errors", async () => {
    const failure = Object.assign(new Error("agent disappeared"), {
      stderr: '{"error":{"code":"agent_not_running"}}\n',
    });
    const controller = new HerdrController({ run: vi.fn().mockRejectedValue(failure) } as CommandRunner, "/srv/projects");
    await expect(controller.promptAndConfirm("w1:p1", "Assignment")).rejects.toBe(failure);
  });

  it("reads unwrapped pane text and can submit a staged composer", async () => {
    const run = vi.fn().mockResolvedValue({ result: { accepted: true } });
    const runText = vi.fn().mockResolvedValue("durable/path/START_HERE.md");
    const controller = new HerdrController({ run, runText }, "/srv/projects");

    await expect(controller.readText("w1:p1")).resolves.toBe("durable/path/START_HERE.md");
    await controller.sendKeys("w1:p1", "enter");

    expect(runText).toHaveBeenCalledWith(["agent", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "120"]);
    expect(run).toHaveBeenCalledWith(["agent", "send-keys", "w1:p1", "enter"]);
  });

  it("interrupts the active agent through Herdr terminal input", async () => {
    const runner = new FakeRunner();
    const controller = new HerdrController(runner, "/srv/projects");
    await controller.interrupt("w4:p1");
    expect(runner.calls).toEqual([
      ["agent", "send-keys", "w4:p1", "ctrl+c"],
      ["agent", "wait", "w4:p1", "--until", "idle", "--until", "done", "--timeout", "15000"],
    ]);
  });
});
