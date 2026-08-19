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
    } } };
    return { result: {} };
  }
}

describe("HerdrController", () => {
  afterEach(() => vi.useRealTimers());

  it("creates a workspace without creating filesystem worktrees and starts an agent", async () => {
    const runner = new FakeRunner();
    const controller = new HerdrController(runner, "/srv/projects");
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
      if (args[0] === "agent" && args[1] === "get") return { result: { agent: { agent_status: "working" } } };
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
        return { result: { agent: { agent_status: "working", agent_session: { value: "session-1" } } } };
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

  it("confirms assignment activity and treats only Herdr's stalled result as ineffective", async () => {
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
    await expect(controller.promptAndConfirm("w1:p1", "Second assignment")).resolves.toBe(true);
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
