import { afterEach, describe, expect, it, vi } from "vitest";
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
      id: "APT-1", title: "Ship it", phase, status: "running", work_provider: "claude", review_provider: "codex",
      repositories: [{ id: "demo", primary: true }], pull_requests: [],
      agents: {
        specification: { provider: "claude", herdr_pane_id: null, session_ref: null },
        implementation: { provider: "claude", herdr_pane_id: null, session_ref: null },
        review: { provider: "codex", herdr_pane_id: null, session_ref: null },
      },
      execution: { lease_id: "lease-1", provider: phase === "review" ? "codex" : "claude", interrupt_request: null },
    },
  };
}

function trackerPromptTemplates(overrides: Partial<PromptTemplates> = {}): PromptTemplates {
  return {
    assignment: "You are assigned full-capability work in {{project_root}}. The ticket follows:\n\n{{ticket_markdown}}\n\n{{phase_instructions}} Use your normal tools and judgment. The coordinator does not prescribe your process. {{callback_base}}complete",
    specification: "Create the specification for {{ticket_id}}.",
    implementation: "Implement {{ticket_id}}.",
    review: "Perform an independent review. Do not repair the implementation.",
    guidance: "Guidance for {{ticket_id}}: {{message}}",
    "callback-reminder": "Submit a callback.",
    ...overrides,
  };
}

function trackerPrompts(overrides: Partial<PromptTemplates> = {}): PromptStore {
  const prompts = new PromptStore();
  prompts.replace(trackerPromptTemplates(overrides));
  return prompts;
}

describe("assignment prompt", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("points a full-capability implementation agent at the ticket and callbacks", () => {
    const prompt = buildAssignmentPrompt(ticket("implementation"), "http://127.0.0.1:4310", "/srv/agent-workspaces/a", trackerPrompts());
    expect(prompt).toContain("Use your normal tools and judgment");
    expect(prompt).toContain("/srv/agent-workspaces/a");
    expect(prompt).toContain("/api/work/lease-1/complete");
    expect(prompt).toContain("The coordinator does not prescribe your process");
    expect(prompt).not.toContain("read-only");
  });

  it("keeps review independent without changing agent permissions", () => {
    const prompt = buildAssignmentPrompt(ticket("review"), "http://127.0.0.1:4310", "/srv/agent-workspaces/a", trackerPrompts());
    expect(prompt).toContain("Perform an independent review");
    expect(prompt).toContain("Do not repair the implementation");
    expect(prompt).not.toContain("disable");
  });

  it("injects declared outcomes and the preceding handoff into agent prompts", () => {
    const work = ticket("implementation");
    work.workflow_node = {
      id: "repair", name: "Repair implementation", type: "agent", phase: "implementation", prompt: "implementation", provider: "work", conversation_key: "work",
      outcomes: [{ id: "completed", label: "Repair completed", description: "Return the changes for review.", target: "review" }], choices: [], exit_codes: [],
    };
    work.frontmatter.workflow = { incoming: { source_node: "review", target_node: "repair", outcome: "changes_requested", summary: "Rollback coverage is missing.", handoff: "Add rollback coverage before re-review." } };
    const prompt = buildAssignmentPrompt(work, "http://127.0.0.1:4310", "/srv/projects", trackerPrompts({
      assignment: "{{incoming_node}} {{incoming_outcome}}\n{{incoming_summary}}\n{{incoming_handoff}}\n{{allowed_outcomes}}\n{{phase_instructions}}",
    }));
    expect(prompt).toContain("review changes_requested");
    expect(prompt).toContain("Rollback coverage is missing");
    expect(prompt).toContain("Add rollback coverage before re-review");
    expect(prompt).toContain("completed: Repair completed — Return the changes for review.");
  });

  it("renders callback reminders with enough lease context to act after compaction", () => {
    const prompt = buildCallbackReminder(ticket("specification"), "http://127.0.0.1:4310", trackerPrompts({
      "callback-reminder": "Reminder for {{ticket_id}} in {{phase}}: POST {{callback_base}}complete",
    }));
    expect(prompt).toBe("Reminder for APT-1 in specification: POST http://127.0.0.1:4310/api/work/lease-1/complete");
  });

  it("retries the identical full assignment when Herdr reports a stalled submission", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const promptAndConfirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const supervisor = new Supervisor({ projectRoot: "/srv/projects", promptAndConfirm } as unknown as HerdrController, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["codex"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000,
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      promptAssignment(provider: Provider, value: ClaimedTicket, paneId: string): Promise<void>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await internals.promptAssignment("codex", ticket("review"), "w1:p1");

    expect(promptAndConfirm).toHaveBeenCalledTimes(2);
    expect(promptAndConfirm.mock.calls[0]).toEqual(promptAndConfirm.mock.calls[1]);
    expect(promptAndConfirm.mock.calls[0]?.[1]).toContain("# Goal\n\nShip it.");
    expect(promptAndConfirm.mock.calls[0]?.[1]).toContain("Perform an independent review");
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
      prompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as HerdrController;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ active: true })));
    const supervisor = new Supervisor(herdr, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["codex"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000,
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      runAssignment(provider: Provider, value: ClaimedTicket): Promise<void>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await expect(internals.runAssignment("codex", ticket("review"))).rejects.toThrow("did not start the assignment prompt");

    expect(herdr.promptAndConfirm).toHaveBeenCalledTimes(2);
    expect(herdr.prompt).not.toHaveBeenCalled();
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
      heartbeatIntervalMs: 30_000, idlePollMs: 1,
    });
    const internals = supervisor as unknown as {
      prompts: PromptStore;
      runAssignment(provider: Provider, value: ClaimedTicket): Promise<void>;
    };
    internals.prompts.replace(trackerPromptTemplates());

    await internals.runAssignment("claude", ticket("implementation"));

    expect(observe).toHaveBeenCalledTimes(3);
    expect(herdr.prompt).toHaveBeenCalledTimes(1);
    expect(herdr.prompt).toHaveBeenCalledWith("w1:p1", "Submit a callback.");
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
      if (url.includes("/control")) return Response.json({ error: "Lease is stale or fenced" }, { status: 409 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const supervisor = new Supervisor(herdr, {
      trackerUrl: "http://tracker.test", supervisorId: "vm", providers: ["codex"],
      heartbeatIntervalMs: 30_000, idlePollMs: 1,
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
        resolve({ success: false, summary: "aborted", output: "", exit_code: null });
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

  it("refreshes phase and envelope prompts from the tracker library", async () => {
    const templates = {
      assignment: "CENTRAL ENVELOPE {{project_root}}\n{{phase_instructions}}\n{{callback_base}}complete",
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
    const prompt = buildAssignmentPrompt(ticket("implementation"), "http://tracker.test", "/srv/projects/central", internals.prompts);
    expect(prompt).toContain("CENTRAL ENVELOPE");
    expect(prompt).toContain("/srv/projects/central");
    expect(prompt).toContain("CENTRAL IMPLEMENTATION APT-1 in implementation");
    expect(prompt).toContain("/api/work/lease-1/complete");
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
      heartbeatIntervalMs: 30_000, idlePollMs: 1_000,
    });
    await (supervisor as unknown as { runAssignment(provider: Provider, value: ClaimedTicket): Promise<void> }).runAssignment("claude", pending);
    expect(herdr.interrupt).toHaveBeenCalledWith("w1:p1");
    expect(herdr.prompt).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(new URL("/api/work/lease-1/interrupt-ack", "http://tracker.test"), expect.objectContaining({ method: "POST" }));
  });
});
