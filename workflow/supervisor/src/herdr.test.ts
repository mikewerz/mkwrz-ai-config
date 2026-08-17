import { describe, expect, it, vi } from "vitest";
import { HerdrController, agentName, resumeArguments, type CommandRunner } from "./herdr.js";

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
    expect(agentName("APT-123_really-long-ticket", "codex", "work")).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    expect(agentName("APT-123_really-long-ticket", "codex", "work")).not.toBe(agentName("APT-123_really-long-ticket-2", "codex", "work"));
    expect(agentName("APT-123_really-long-ticket", "codex", "work")).not.toBe(agentName("APT-123_really-long-ticket", "codex", "review"));
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
