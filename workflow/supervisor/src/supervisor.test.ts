import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssignmentBundle } from "./assignments.js";
import type { HerdrController } from "./herdr.js";
import { PromptStore, type PromptTemplates } from "./prompts.js";
import { Supervisor, buildAssignmentPrompt, buildCallbackReminder } from "./supervisor.js";
import { TrackerClient } from "./tracker-client.js";
import type { AgentObservation, ClaimedTicket, Provider } from "./types.js";
import * as activities from "./activities.js";

function ticket(phase: "specification" | "implementation" | "review"): ClaimedTicket {
  return {
    id: "APT-1", path: "tickets/APT-1.md", markdown: "# Goal\n\nShip it.",
    frontmatter: {
      id: "APT-1", title: "Ship it", phase, status: "running",
      repositories: [{ id: "demo", primary: true }], pull_requests: [],
      workflow: { id: "delivery", revision: "r1", current_node: phase, inputs: {} },
      execution: {
        lease_id: "lease-1", provider: phase === "review" ? "codex" : "claude", interrupt_request: null,
        node_id: phase, node_type: "agent", node_run_id: "run-1", attempt: 1,
        delivery_status: "starting", delivery_confirmed_at: null,
      },
    },
    workflow_node: {
      id: phase, name: phase, type: "agent", phase, prompt: phase,
      agent_profile: phase === "review" ? "review" : "default", conversation_key: phase === "review" ? "review" : "work",
      outcomes: [{ id: "completed", label: "Completed", description: "Finish the node.", target: "done" }], choices: [], exit_codes: [],
    },
    node_prompt: { id: phase, revision: "prompt-r1", content: `Complete ${phase} for {{ticket_id}}.` },
    resolved_agent_profile: { alias: phase === "review" ? "review" : "default", provider: phase === "review" ? "codex" : "claude", model: "test-model", reasoning: "high" },
  };
}

function trackerPromptTemplates(overrides: Partial<PromptTemplates> = {}): PromptTemplates {
  return {
    assignment: "Read {{start_here_path}} before working in {{project_root}}. Use {{callback_helper_path}} before becoming idle.",
    specification: "Create the specification for {{ticket_id}}.",
    implementation: "Implement {{ticket_id}}.",
    review: "Perform an independent review. Do not repair the implementation.",
    guidance: "Read update {{update_path}}, then reread {{start_here_path}}. Use {{callback_helper_path}} before becoming idle.",
    "callback-reminder": "Reread {{start_here_path}} and use {{callback_helper_path}} before becoming idle.",
    ...overrides,
  };
}

function trackerPrompts(overrides: Partial<PromptTemplates> = {}): PromptStore {
  const prompts = new PromptStore();
  prompts.replace(trackerPromptTemplates(overrides));
  return prompts;
}

function bundle(): AssignmentBundle {
  const runDirectory = "/srv/assignments/vm/tickets/APT-1/runs/0001-implementation-run-1";
  return {
    root: "/srv/assignments", ticketDirectory: "/srv/assignments/vm/tickets/APT-1", runDirectory,
    startHerePath: `${runDirectory}/START_HERE.md`, callbackHelperPath: `${runDirectory}/callback`, artifactHelperPath: `${runDirectory}/publish-artifact`, attachmentsDirectory: `${runDirectory}/attachments`,
  };
}

const temporaryRoots: string[] = [];
function temporaryAssignmentRoot(): string {
  const path = join(tmpdir(), `agentic-supervisor-${process.pid}-${randomUUID()}`);
  temporaryRoots.push(path);
  return path;
}

describe("assignment prompt", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  it("points an agent at the exact durable assignment and callback helper", () => {
    const prompt = buildAssignmentPrompt(ticket("implementation"), "http://127.0.0.1:4310", "/srv/agent-workspaces/a", trackerPrompts(), bundle());
    expect(prompt).toContain("/srv/agent-workspaces/a");
    expect(prompt).toContain("/srv/assignments/vm/tickets/APT-1/runs/0001-implementation-run-1/START_HERE.md");
    expect(prompt).toContain("/srv/assignments/vm/tickets/APT-1/runs/0001-implementation-run-1/callback");
    expect(prompt).not.toContain("# Goal");
  });

  it("renders callback reminders with exact recovery paths after compaction", () => {
    const prompt = buildCallbackReminder(ticket("specification"), "http://127.0.0.1:4310", "/srv/projects", trackerPrompts(), bundle());
    expect(prompt).toContain("Reread /srv/assignments/vm/tickets/APT-1/runs/0001-implementation-run-1/START_HERE.md");
    expect(prompt).toContain("use /srv/assignments/vm/tickets/APT-1/runs/0001-implementation-run-1/callback");
  });

  it("submits a staged assignment with Enter instead of pasting it twice", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const promptAndConfirm = vi.fn().mockResolvedValue(false);
    const observation: AgentObservation = {
      paneId: "w1:p1", state: "idle", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Codex", revision: 1,
      sessionSource: "herdr:codex", sessionKind: "id", tokens: {},
    };
    const observe = vi.fn().mockResolvedValue(observation);
    const readText = vi.fn().mockResolvedValue(`Claude composer\n${bundle().startHerePath}`);
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const supervisor = new Supervisor({ projectRoot: "/srv/projects", promptAndConfirm, observe, readText, sendKeys } as unknown as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["codex"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000, assignmentRoot: temporaryAssignmentRoot(),
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      promptAssignment(provider: Provider, value: ClaimedTicket, paneId: string, bundle: AssignmentBundle, initial: AgentObservation): Promise<{
        observation: AgentObservation; confirmation: string;
      }>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await internals.promptAssignment("codex", ticket("review"), "w1:p1", bundle(), observation);

    expect(promptAndConfirm).toHaveBeenCalledTimes(1);
    expect(promptAndConfirm.mock.calls[0]?.[1]).toContain(bundle().startHerePath);
    expect(promptAndConfirm.mock.calls[0]?.[1]).toContain(bundle().callbackHelperPath);
    expect(promptAndConfirm.mock.calls[0]?.[1]).not.toContain("# Goal\n\nShip it.");
    expect(readText).toHaveBeenCalledWith("w1:p1");
    expect(sendKeys).toHaveBeenCalledWith("w1:p1", "enter");
  });

  it("submits Claude's collapsed multiline paste when the assignment marker is hidden", async () => {
    const idle: AgentObservation = {
      paneId: "w1:p1", state: "idle", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Claude", revision: 1,
      sessionSource: "herdr:claude", sessionKind: "id", tokens: {}, interactiveReady: true, launchPending: false,
    };
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const supervisor = new Supervisor({
      projectRoot: "/srv/projects", promptAndConfirm: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(idle), readText: vi.fn().mockResolvedValue("Claude Code\n[Pasted text #1 +14 lines]"), sendKeys,
    } as unknown as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000, assignmentRoot: temporaryAssignmentRoot(),
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      promptAssignment(provider: Provider, value: ClaimedTicket, paneId: string, bundle: AssignmentBundle, initial: AgentObservation): Promise<{
        observation: AgentObservation; confirmation: string;
      }>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await expect(internals.promptAssignment("claude", ticket("implementation"), "w1:p1", bundle(), idle)).resolves.toMatchObject({
      confirmation: "submitted_staged_prompt",
    });

    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("w1:p1", "enter");
  });

  it("accepts observed pane activity as delivery confirmation without duplicating the prompt", async () => {
    const before: AgentObservation = {
      paneId: "w1:p1", state: "idle", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Claude", revision: 1,
      sessionSource: "herdr:claude", sessionKind: "id", tokens: {},
    };
    const after = { ...before, state: "working", revision: 2 } satisfies AgentObservation;
    const promptAndConfirm = vi.fn().mockResolvedValue(false);
    const supervisor = new Supervisor({ projectRoot: "/srv/projects", promptAndConfirm, observe: vi.fn().mockResolvedValue(after) } as unknown as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000, assignmentRoot: temporaryAssignmentRoot(),
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      promptAssignment(provider: Provider, value: ClaimedTicket, paneId: string, bundle: AssignmentBundle, initial: AgentObservation): Promise<{
        observation: AgentObservation; confirmation: string;
      }>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await expect(internals.promptAssignment("claude", ticket("implementation"), "w1:p1", bundle(), before)).resolves.toEqual({
      observation: after, confirmation: "observed_activity",
    });

    expect(promptAndConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not mistake pane rendering or late session discovery for assignment delivery", async () => {
    const before: AgentObservation = {
      paneId: "w1:p1", state: "idle", sessionRef: null, workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Claude", revision: 10,
      sessionSource: null, sessionKind: null, tokens: {}, interactiveReady: true, launchPending: false,
    };
    const after: AgentObservation = {
      ...before, sessionRef: "session-1", sessionSource: "herdr:claude", sessionKind: "id", revision: 11,
    };
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const supervisor = new Supervisor({
      projectRoot: "/srv/projects", promptAndConfirm: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(after), readText: vi.fn().mockResolvedValue("Claude Code\nReady for input"), sendKeys,
    } as unknown as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000, assignmentPromptRecoveryMs: 0, assignmentRoot: temporaryAssignmentRoot(),
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      promptAssignment(provider: Provider, value: ClaimedTicket, paneId: string, bundle: AssignmentBundle, initial: AgentObservation): Promise<unknown>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await expect(internals.promptAssignment("claude", ticket("implementation"), "w1:p1", bundle(), before))
      .rejects.toThrow("did not expose or start the assignment prompt");

    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("w1:p1", "ctrl+c");
  });

  it("renews a starting lease independently of Herdr startup work", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ active: true })));
    const supervisor = new Supervisor({ projectRoot: "/srv/projects" } as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 10, idlePollMs: 1_000, assignmentRoot: temporaryAssignmentRoot(),
    });
    const stopRenewal = (supervisor as unknown as {
      startLeaseRenewal(value: ClaimedTicket, lease: string): () => void;
    }).startLeaseRenewal(ticket("implementation"), "lease-1");

    await new Promise((resolve) => setTimeout(resolve, 35));
    stopRenewal();

    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ href: "http://tracker.test/api/work/lease-1/heartbeat" }), expect.objectContaining({ method: "POST" }));
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("never substitutes a callback reminder when the assignment does not start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const observation: AgentObservation = {
      paneId: "w1:p1", state: "idle", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Codex", revision: 1,
      sessionSource: "herdr:codex", sessionKind: "id", tokens: {},
    };
    const herdr = {
      projectRoot: "/srv/projects",
      ensureAgent: vi.fn().mockResolvedValue(observation),
      promptAndConfirm: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(observation),
      readText: vi.fn().mockResolvedValue("Claude welcome screen"),
      sendKeys: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as HerdrController;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ active: true })));
    const supervisor = new Supervisor(herdr, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["codex"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000, assignmentPromptRecoveryMs: 0, assignmentRoot: temporaryAssignmentRoot(),
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      runAssignment(provider: Provider, value: ClaimedTicket): Promise<void>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await expect(internals.runAssignment("codex", ticket("review"))).resolves.toBeUndefined();

    expect(herdr.promptAndConfirm).toHaveBeenCalledTimes(1);
    expect(herdr.sendKeys).toHaveBeenCalledTimes(1);
    expect(herdr.sendKeys).toHaveBeenCalledWith("w1:p1", "ctrl+c");
    expect(herdr.prompt).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ href: "http://tracker.test/api/work/lease-1/delivery-failed" }), expect.objectContaining({ method: "POST" }));
  });

  it("sends at most one callback reminder per lease across repeated idle periods", async () => {
    const baseObservation: AgentObservation = {
      paneId: "w1:p1", state: "idle", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Claude", revision: 1,
      sessionSource: "herdr:claude", sessionKind: "id", tokens: {},
    };
    let supervisor!: Supervisor;
    const observe = vi.fn()
      .mockResolvedValueOnce({ ...baseObservation, state: "idle" })
      .mockResolvedValueOnce({ ...baseObservation, state: "working" })
      .mockImplementationOnce(async () => {
        await supervisor.stop();
        return { ...baseObservation, state: "idle" };
      });
    const herdr = {
      projectRoot: "/srv/projects",
      ensureAgent: vi.fn().mockResolvedValue({ ...baseObservation, state: "working" }),
      promptAndConfirm: vi.fn().mockResolvedValue(true),
      observe,
      prompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as HerdrController;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/api/work/lease-1/control")) return Response.json({ interrupt: null, waiting_for_answer: false });
      if (url.includes("/api/work/lease-1/guidance")) return Response.json({ guidance: [] });
      if (url.endsWith("/api/prompts")) return Response.json({
        prompts: Object.entries(trackerPromptTemplates()).map(([name, content]) => ({ name, content, revision: `${name}-r1`, valid: true, errors: [] })),
      });
      return Response.json({ active: true });
    }));
    supervisor = new Supervisor(herdr, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1, callbackReminderGraceMs: 0, assignmentRoot: temporaryAssignmentRoot(),
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      runAssignment(provider: Provider, value: ClaimedTicket): Promise<void>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await internals.runAssignment("claude", ticket("implementation"));

    expect(observe).toHaveBeenCalledTimes(3);
    expect(herdr.prompt).toHaveBeenCalledTimes(1);
    expect(herdr.prompt).toHaveBeenCalledWith("w1:p1", expect.stringMatching(/Reread .*START_HERE\.md and use .*callback before becoming idle\./));
  });

  it("refreshes the durable bundle before forwarding a persisted guidance path", async () => {
    const observation: AgentObservation = {
      paneId: "w1:p1", state: "working", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects/demo",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Claude", revision: 1,
      sessionSource: "herdr:claude", sessionKind: "id", tokens: {},
    };
    const refreshed = ticket("implementation");
    refreshed.markdown = "# Goal\n\nShip the revised behavior.";
    let supervisor!: Supervisor;
    const herdr = {
      projectRoot: "/srv/projects",
      ensureAgent: vi.fn().mockResolvedValue(observation),
      promptAndConfirm: vi.fn().mockResolvedValue(true),
      observe: vi.fn().mockResolvedValue(observation),
      prompt: vi.fn().mockImplementation(async () => { await supervisor.stop(); }),
    } as unknown as HerdrController;
    let guidanceRead = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/api/work/lease-1/control")) return Response.json({ interrupt: null, waiting_for_answer: false });
      if (url.includes("/api/work/lease-1/guidance")) {
        if (guidanceRead) return Response.json({ guidance: [] });
        guidanceRead = true;
        return Response.json({ guidance: [{ id: "guidance-1", sequence: 4, message: "Use the revised deployment target." }] });
      }
      if (url.endsWith("/api/work/lease-1/assignment")) return Response.json(refreshed);
      if (url.endsWith("/api/prompts")) return Response.json({
        prompts: Object.entries(trackerPromptTemplates()).map(([name, content]) => ({ name, content, revision: `${name}-r1`, valid: true, errors: [] })),
      });
      return Response.json({ active: true });
    }));
    const assignmentRoot = temporaryAssignmentRoot();
    supervisor = new Supervisor(herdr, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1, assignmentRoot,
    });
    (supervisor as unknown as { prompts: PromptStore }).prompts.replace(trackerPromptTemplates());

    await (supervisor as unknown as { runAssignment(provider: Provider, value: ClaimedTicket): Promise<void> }).runAssignment("claude", ticket("implementation"));

    const runDirectory = join(assignmentRoot, "vm", "tickets", "APT-1", "runs", "0001-implementation-run-1");
    expect(herdr.prompt).toHaveBeenCalledWith("w1:p1", expect.stringContaining(join(runDirectory, "updates", "00000004-guidance-1.md")));
    expect(herdr.prompt).toHaveBeenCalledWith("w1:p1", expect.stringContaining(join(runDirectory, "START_HERE.md")));
    expect(await readFile(join(runDirectory, "ticket.md"), "utf8")).toContain("revised behavior");
    expect(await readFile(join(runDirectory, "updates", "00000004-guidance-1.md"), "utf8")).toContain("revised deployment target");
  });

  it("interrupts the Herdr turn when cancellation or fencing removes the lease", async () => {
    const observation: AgentObservation = {
      paneId: "w1:p1", state: "working", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Codex", revision: 1,
      sessionSource: "herdr:codex", sessionKind: "id", tokens: {},
    };
    const herdr = {
      projectRoot: "/srv/projects",
      ensureAgent: vi.fn().mockResolvedValue(observation),
      promptAndConfirm: vi.fn().mockResolvedValue(true),
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as HerdrController;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/heartbeat")) return Response.json({ active: true });
      if (url.includes("/delivered")) return Response.json({ delivered: true });
      if (url.includes("/control")) return Response.json({ error: "Lease is stale or fenced" }, { status: 409 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const supervisor = new Supervisor(herdr, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["codex"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1, assignmentRoot: temporaryAssignmentRoot(),
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      runAssignment(provider: Provider, value: ClaimedTicket): Promise<void>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await internals.runAssignment("codex", ticket("review"));

    expect(herdr.interrupt).toHaveBeenCalledWith("w1:p1");
  });

  it("aborts a running Script when tracker control fails", async () => {
    let aborted = false;
    vi.spyOn(activities, "runRepositoryActivity").mockImplementation(async (_root, _ticket, signal) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        resolve({ success: false, summary: "aborted", output: "", exit_code: null, script_path: null, working_directory: null });
      }, { once: true });
    }));
    const claimed = ticket("implementation");
    claimed.frontmatter.execution.provider = null;
    claimed.frontmatter.execution.node_type = "script";
    claimed.frontmatter.execution.node_id = "verify";
    claimed.workflow_node = {
      id: "verify", name: "Verify", type: "script", phase: "implementation", repository: "primary",
      inline: { language: "shell", code: "sleep 60" }, outcomes: [], choices: [], exit_codes: [],
    };
    let supervisor!: Supervisor;
    let claimedOnce = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/work/claim-activity") && !claimedOnce) { claimedOnce = true; return Response.json(claimed); }
      if (url.includes("/api/work/lease-1/control")) {
        await supervisor.stop();
        return Response.json({ error: "tracker unavailable" }, { status: 503 });
      }
      return new Response(null, { status: 204 });
    }));
    supervisor = new Supervisor({ projectRoot: "/srv/projects" } as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: [],
      heartbeatIntervalMs: 30_000, idlePollMs: 1,
    });

    await supervisor.run();

    expect(aborted).toBe(true);
  });

  it("does not complete a Script node when a required artifact upload is rejected", async () => {
    // Arrange
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const projectRoot = temporaryAssignmentRoot();
    await mkdir(projectRoot, { recursive: true });
    const reportPath = join(projectRoot, "quality.yaml");
    await writeFile(reportPath, "schema: agentic-quality/v1\nattributes: []\n");
    vi.spyOn(activities, "runRepositoryActivity").mockResolvedValue({
      success: true, summary: "Verification passed.", output: "", exit_code: 0, script_path: null, working_directory: projectRoot,
      pending_artifacts: [{ key: "verification-quality", kind: "quality_report", filename: "quality.yaml", content_type: "application/yaml", path: reportPath }],
    });
    const claimed = ticket("implementation");
    claimed.frontmatter.execution.provider = null;
    claimed.frontmatter.execution.node_type = "script";
    claimed.frontmatter.execution.node_id = "verify";
    claimed.workflow_node = {
      id: "verify", name: "Verify", type: "script", phase: "implementation", repository: "primary",
      inline: { language: "shell", code: "true" }, outcomes: [], choices: [], exit_codes: [],
      artifacts: [{ name: "verification-quality", path: "quality.yaml", content_type: "application/yaml", required: true, interpretation: { kind: "quality_report", schema: "agentic-quality/v1", required_attributes: [] } }],
    };
    let supervisor!: Supervisor;
    let claimedOnce = false;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith("/api/work/claim-activity") && !claimedOnce) { claimedOnce = true; return Response.json(claimed); }
      if (url.includes("/api/work/lease-1/control")) return Response.json({ interrupt: null, waiting_for_answer: false });
      if (url.includes("/api/work/lease-1/artifacts")) {
        await supervisor.stop();
        return Response.json({ error: "Quality report is missing required attributes" }, { status: 422 });
      }
      if (url.endsWith("/api/work/claim-activity")) return new Response(null, { status: 204 });
      return Response.json({});
    }));
    supervisor = new Supervisor({ projectRoot } as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: [],
      heartbeatIntervalMs: 30_000, idlePollMs: 1, assignmentRoot: join(projectRoot, "assignments"),
    });

    // Act
    await supervisor.run();

    // Assert
    expect(requests.filter((url) => url.includes("/artifacts"))).toHaveLength(1);
    expect(requests.some((url) => url.endsWith("/activity-result"))).toBe(false);
    expect(requests.some((url) => url.endsWith("/finalize"))).toBe(false);
  });

  it("refreshes phase and envelope prompts from the tracker library", async () => {
    const templates = {
      assignment: "CENTRAL BOOTSTRAP {{project_root}} {{start_here_path}} {{callback_helper_path}}",
      specification: "CENTRAL SPEC {{ticket_id}}",
      implementation: "CENTRAL IMPLEMENTATION {{ticket_id}} in {{phase}}",
      review: "CENTRAL REVIEW {{ticket_id}}",
      guidance: "CENTRAL GUIDANCE {{message}}",
      "callback-reminder": "CENTRAL REMINDER",
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      prompts: [
        ...Object.entries(templates).map(([name, content]) => ({ name, content, revision: `${name}-r1`, valid: true, errors: [] })),
        { name: "unused-broken", content: "{{unknown}}", revision: "broken-r1", valid: false, errors: ["unknown placeholder"] },
      ],
    })));
    const supervisor = new Supervisor({} as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000,
    });
    const internals = supervisor as unknown as { refreshPrompts(): Promise<void>; prompts: import("./prompts.js").PromptStore };
    await internals.refreshPrompts();
    const prompt = buildAssignmentPrompt(ticket("implementation"), "http://tracker.test", "/srv/projects/central", internals.prompts, bundle());
    expect(prompt).toContain("CENTRAL BOOTSTRAP");
    expect(prompt).toContain("/srv/projects/central");
    expect(prompt).toContain(bundle().startHerePath);
    expect(prompt).toContain(bundle().callbackHelperPath);
    expect(prompt).not.toContain("CENTRAL IMPLEMENTATION APT-1 in implementation");
  });

  it("does not recover or claim work while the tracker prompt library is unavailable", async () => {
    const requests: string[] = [];
    let supervisor!: Supervisor;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith("/api/prompts")) {
        await supervisor.stop();
        return Response.json({ error: "Prompt library unavailable" }, { status: 503 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    supervisor = new Supervisor({} as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1,
    });

    await supervisor.run();

    expect(requests.some((url) => url.endsWith("/api/work/active?supervisor_id=vm&provider=claude"))).toBe(false);
    expect(requests.some((url) => url.endsWith("/api/work/claim"))).toBe(false);
  });

  it("publishes the supervisor host, isolated root, Herdr session, and available agents", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ supervisor: {} })));
    const client = new TrackerClient("http://tracker.test", "vm-one", "instance-one");
    await client.heartbeatSupervisor({
      instanceId: "instance-one", hostname: "worker-one", ipAddresses: ["192.0.2.70"],
      projectRoot: "/srv/projects/one", herdrSession: "agents-one", startedAt: "2026-08-14T12:00:00Z",
    }, ["claude", "codex"], ["repository_action", "inline_shell"]);
    expect(fetch).toHaveBeenCalledWith(new URL("/api/supervisors/heartbeat", "http://tracker.test"), expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"project_root":"/srv/projects/one"'),
    }));
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      body: expect.stringContaining('"activity_capabilities":["repository_action","inline_shell"]'),
    }));
  });

  it("does not recover or claim work while repository reconciliation is failing", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith("/api/config")) return Response.json({
        config: {
          version: 1, revision: 1, updated_at: "2026-08-14T12:00:00Z",
          repositories: [{ id: "private-api", url: "git@github.com:example/private-api.git" }],
        },
      });
      throw new Error(`Unexpected request: ${url}`);
    }));
    let supervisor!: Supervisor;
    const reconciler = { reconcile: vi.fn(async () => {
      await supervisor.stop();
      throw new Error("clone credentials unavailable");
    }) };
    supervisor = new Supervisor({} as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1, repositoryReconciler: reconciler,
    });

    await supervisor.run();

    expect(requests.some((url) => url.endsWith("/api/work/active?supervisor_id=vm&provider=claude"))).toBe(false);
    expect(requests.some((url) => url.endsWith("/api/work/claim"))).toBe(false);
  });

  it("interrupts and acknowledges a recovered assignment before prompting it again", async () => {
    const pending = ticket("implementation");
    pending.frontmatter.execution.interrupt_request = { target_phase: "specification", requested_at: "2026-08-14T12:00:00Z" };
    const observation: AgentObservation = {
      paneId: "w1:p1", state: "working", sessionRef: "session-1", workspaceId: "w1", tabId: "w1:t1",
      terminalId: "term-1", focused: false, cwd: "/srv/projects", foregroundCwd: "/srv/projects/demo",
      terminalTitle: null, terminalTitleStripped: null, displayName: "Claude", revision: 1,
      sessionSource: "herdr:claude", sessionKind: "id", tokens: {},
    };
    const herdr = {
      projectRoot: "/srv/projects",
      ensureAgent: vi.fn().mockResolvedValue(observation),
      interrupt: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as HerdrController;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const supervisor = new Supervisor(herdr, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["claude"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000, assignmentRoot: temporaryAssignmentRoot(),
    });
    (supervisor as unknown as { prompts: PromptStore }).prompts.replace(trackerPromptTemplates());
    await (supervisor as unknown as { runAssignment(provider: Provider, value: ClaimedTicket): Promise<void> }).runAssignment("claude", pending);
    expect(herdr.interrupt).toHaveBeenCalledWith("w1:p1");
    expect(herdr.prompt).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(new URL("/api/work/lease-1/interrupt-ack", "http://tracker.test"), expect.objectContaining({ method: "POST" }));
  });
});
