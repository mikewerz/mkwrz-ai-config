// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const summary = {
  id: "APT-42", title: "UI ticket", phase: "implementation", status: "running",
  work_provider: "claude", review_provider: "codex", review_required: true,
  priority: 50, provider: "claude", revision: 7, valid: true, errors: [], path: "APT-42.md", claim_blockers: [], archived_at: null,
};

const execution = {
  provider: "claude", phase: "implementation", attempt: 2, supervisor_id: "coordinator-vm",
  claimed_at: "2026-08-14T12:00:00Z", last_heartbeat_at: "2026-08-14T12:01:30Z",
  lease_expires_at: "2026-08-14T12:03:30Z", lease_id: "lease-1", observed_herdr_state: "working", guidance: [],
  interrupt_request: null,
  herdr_observation: {
    state: "working", observed_at: "2026-08-14T12:01:30Z", state_changed_at: "2026-08-14T12:00:05Z",
    pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term-1", focused: false,
    cwd: "/srv/projects", foreground_cwd: "/srv/projects/demo", terminal_title: "⠋ Running tests",
    terminal_title_stripped: "Running tests", display_name: "Claude", revision: 12,
    session_source: "herdr:claude", session_kind: "id", tokens: { model: "opus" },
  },
};

const detail = {
  id: "APT-42", path: "/srv/tickets/APT-42.md", relative_path: "APT-42.md", markdown: "---\nid: APT-42\n---\n\n# Goal\n",
  body: "# Goal\n\nShip a clear dashboard.\n\n## Acceptance Criteria\n\n- Show the agent state.\n\n## Interaction Log\n\n<!-- tracker:interaction-log:start -->\n- `000007` `2026-08-14T12:00:00Z` **work.claimed** — Claimed.\n<!-- tracker:interaction-log:end -->\n",
  valid: true, errors: [],
  frontmatter: {
    id: "APT-42", title: "UI ticket", phase: "implementation", status: "running", revision: 7,
    spec_required: true, review_required: true, work_provider: "claude", review_provider: "codex", priority: 50, labels: ["dashboard"],
    repositories: [{ id: "demo", primary: true }], pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/42" }],
    questions: [], jira: null, archived_at: null,
    created_at: "2026-08-14T11:00:00Z", updated_at: "2026-08-14T12:01:30Z", execution,
    assigned_supervisor: "coordinator-vm",
    assigned_supervisor_host: "worker-vm",
    attempts: { specification: { total: 1, consecutive_lease_losses: 0 }, implementation: { total: 2, consecutive_lease_losses: 0 }, review: { total: 0, consecutive_lease_losses: 0 } },
    agents: {
      specification: { provider: "claude", herdr_pane_id: "w1:p1", session_ref: "session-1" },
      implementation: { provider: "claude", herdr_pane_id: "w1:p1", session_ref: "session-1" },
      review: { provider: "codex", herdr_pane_id: null, session_ref: null },
    },
  },
};

const promptFixtures = [
  {
    name: "assignment", title: "Assignment envelope", purpose: "Starts or resumes ticket work.",
    trigger: "After a phase is claimed or recovered and Herdr is attached.", stages: ["Specification", "Implementation", "Review"],
    allowed_tags: ["ticket_id", "phase", "ticket_path", "ticket_markdown", "project_root", "phase_instructions", "callback_base"],
    required_tags: ["ticket_id", "phase", "ticket_path", "ticket_markdown", "phase_instructions", "callback_base"],
    content: "Work {{ticket_id}} in {{phase}} from {{project_root}}.\n\n{{ticket_markdown}}\n\n{{phase_instructions}}\n\nCallback: {{callback_base}} at {{ticket_path}}",
    revision: "assignment-r1", valid: true, errors: [],
    tags: [
      { name: "ticket_id", description: "Stable ticket identifier.", example: "AGENT-0042" },
      { name: "phase", description: "Durable work phase.", example: "implementation" },
      { name: "ticket_path", description: "Authoritative ticket path.", example: "/srv/tickets/AGENT-0042.md" },
      { name: "ticket_markdown", description: "Complete ticket Markdown.", example: "# Goal\n\nAdd a health endpoint." },
      { name: "project_root", description: "Supervisor project root.", example: "/srv/agent-workspaces/supervisor-a" },
      { name: "phase_instructions", description: "Rendered phase instructions.", example: "Implement autonomously." },
      { name: "callback_base", description: "Lease-fenced callback URL.", example: "http://tracker/api/work/dummy/" },
    ],
  },
  ...["specification", "implementation", "review", "guidance", "callback-reminder"].map((name) => ({
    name, title: `${name[0]!.toUpperCase()}${name.slice(1)} instructions`, purpose: `${name} message`,
    trigger: `${name} transition trigger`, stages: [name === "guidance" ? "Live edit" : name],
    allowed_tags: [], required_tags: [], content: `${name} instructions`, revision: `${name}-r1`, tags: [], valid: true, errors: [],
  })),
];

class FakeEventSource { addEventListener() {} close() {} }

function installLocalStorage(): Storage {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, String(value)); },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return storage;
}

describe("operator UI", () => {
  let current: any = structuredClone(detail);
  let claimBlockers: any[] = [];
  let trackerConfig: any;
  let prompts: any[];
  beforeEach(() => {
    installLocalStorage();
    document.documentElement.removeAttribute("data-theme");
    current = structuredClone(detail);
    claimBlockers = [];
    prompts = structuredClone(promptFixtures);
    trackerConfig = { version: 1, revision: 2, updated_at: "2026-08-14T12:00:00Z", tickets: { id_prefix: "AGENT", next_number: 1 }, providers: { enabled: ["claude", "codex"] }, repositories: [{ id: "demo", url: "git@github.com:example/demo.git" }], jira: { enabled: false, site_url: "", project_key: "", issue_type: "Task" }, github: { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] } };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if ((path === "/api/tickets" || path === "/api/tickets?include_archived=true") && !init?.method) {
        const ticket = { ...summary, phase: current.frontmatter.phase, status: current.frontmatter.status, claim_blockers: claimBlockers, archived_at: current.frontmatter.archived_at };
        return Response.json({ tickets: current.frontmatter.archived_at && path === "/api/tickets" ? [] : [ticket] });
      }
      if (path === "/api/runtime" && !init?.method) return Response.json({ agents: current.frontmatter.execution ? [{
        ticket_id: current.id, title: current.frontmatter.title, phase: current.frontmatter.phase, status: current.frontmatter.status,
        provider: "claude", attempt: 2, claimed_at: execution.claimed_at, last_heartbeat_at: execution.last_heartbeat_at,
        lease_expires_at: execution.lease_expires_at, consecutive_lease_losses: 0, pane_id: "w1:p1", session_ref: "session-1", herdr: execution.herdr_observation,
      }] : [] });
      if (path === "/api/supervisors" && !init?.method) return Response.json({ supervisors: [{
        supervisor_id: "coordinator-vm", instance_id: "instance-1", hostname: "worker-vm",
        ip_addresses: ["192.0.2.70"], project_root: "/srv/projects", herdr_session: "agentic-projects",
        providers: ["claude", "codex"], started_at: "2026-08-14T11:00:00Z",
        last_seen_at: "2026-08-14T12:01:30Z", status: "online",
        assigned_ticket: { id: "APT-42", title: "UI ticket", phase: current.frontmatter.phase, status: current.frontmatter.status },
      }] });
      if (path === "/api/config" && !init?.method) return Response.json({ config: trackerConfig });
      if (path === "/api/prompts" && !init?.method) return Response.json({ prompts });
      if (path.startsWith("/api/prompts/") && path.endsWith("/preview") && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        return Response.json({ rendered: `Rendered dummy assignment for AGENT-0042\n${payload.content}` });
      }
      if (path.startsWith("/api/prompts/") && init?.method === "PUT") {
        const name = decodeURIComponent(path.split("/").at(-1)!);
        const payload = JSON.parse(String(init.body));
        const prompt = { ...prompts.find((item) => item.name === name), content: payload.content, revision: `${name}-r2` };
        prompts = prompts.map((item) => item.name === name ? prompt : item);
        return Response.json({ prompt });
      }
      if (path === "/api/tickets/next-id" && !init?.method) return Response.json({ id: "AGENT-0001" });
      if (path === "/api/config" && init?.method === "PUT") {
        const payload = JSON.parse(String(init.body));
        trackerConfig = { ...trackerConfig, ...payload, revision: trackerConfig.revision + 1 };
        return Response.json({ config: trackerConfig });
      }
      if (path === "/api/tickets/APT-42" && !init?.method) return Response.json(current);
      if (path === "/api/tickets/APT-42" && init?.method === "PUT") {
        current = { ...current, markdown: String(JSON.parse(String(init.body)).markdown) };
        return Response.json(current);
      }
      if (path.startsWith("/api/tickets/APT-42/questions/") && path.endsWith("/answer") && init?.method === "POST") {
        const questionId = decodeURIComponent(path.split("/").at(-2)!);
        const payload = JSON.parse(String(init.body));
        current.frontmatter.questions = current.frontmatter.questions.map((question: any) => question.id === questionId
          ? { ...question, answer: payload.answer, answered_at: "2026-08-14T12:02:00Z" } : question);
        return Response.json(current);
      }
      if (path === "/api/tickets" && init?.method === "POST") return Response.json({
        error: "Ticket is invalid", details: ["repositories[0].id must be a non-empty string"],
      }, { status: 422 });
      throw new Error(`Unexpected request: ${path}`);
    }));
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    vi.restoreAllMocks();
  });

  it("switches among all themes and restores the saved preference", async () => {
    const firstRender = render(<App />);
    const dark = await screen.findByRole("button", { name: "Use Dark theme" });
    expect(dark).toHaveAttribute("aria-pressed", "true");
    const selector = screen.getByRole("group", { name: "Theme" });
    expect(within(selector).getAllByRole("button")).toHaveLength(3);
    expect(within(selector).queryByText("Light")).not.toBeInTheDocument();
    expect(within(selector).queryByText("Dark")).not.toBeInTheDocument();
    expect(within(selector).queryByText("Retro Hacker")).not.toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));

    fireEvent.click(screen.getByRole("button", { name: "Use Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("agentic-project-tracker.theme")).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "Use Retro Hacker theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "retro");
    expect(window.localStorage.getItem("agentic-project-tracker.theme")).toBe("retro");

    firstRender.unmount();
    render(<App />);
    expect(await screen.findByRole("button", { name: "Use Retro Hacker theme" })).toHaveAttribute("aria-pressed", "true");
  });

  it("presents a live ticket as a workflow-focused issue instead of a raw editor", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    expect(await screen.findByRole("heading", { name: "Path to completion" })).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("/srv/projects/demo")).toBeInTheDocument();
    expect(screen.getByText("herdr:claude · id")).toBeInTheDocument();
    expect(screen.getByText("Ship a clear dashboard.")).toBeInTheDocument();
    expect(screen.getByText("Work Claimed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open draft PR/i })).toHaveAttribute("href", "https://github.com/example/demo/pull/42");
    expect(screen.queryByLabelText("Raw ticket Markdown")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save ticket" })).not.toBeInTheDocument();
  });

  it("shows supervisor host, root, agents, and ticket reservation on the health page", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Supervisor health/i }));
    expect(await screen.findByRole("heading", { name: "coordinator-vm" })).toBeInTheDocument();
    expect(screen.getByText("192.0.2.70")).toBeInTheDocument();
    expect(screen.getByText("/srv/projects")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /APT-42 · UI ticket/i })).toBeInTheDocument();
  });

  it("edits and saves the YAML-backed repository catalog through structured fields", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    expect(await screen.findByRole("heading", { name: "Repository catalog" })).toBeInTheDocument();
    expect(screen.getByLabelText("Repository ID 1")).toHaveValue("demo");
    expect(screen.getByLabelText("Enable Claude")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Enable Claude"));
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    fireEvent.change(screen.getByLabelText("Repository ID 2"), { target: { value: "other-api" } });
    fireEvent.change(screen.getByLabelText("Repository URL 2"), { target: { value: "https://github.com/example/other-api.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/config", expect.objectContaining({
      method: "PUT", body: expect.stringMatching(/"providers":\{"enabled":\["codex"\]\}/),
    })));
    expect(await screen.findByText("r3")).toBeInTheDocument();
  });

  it("hides disabled providers from new tickets without depending on supervisor presence", async () => {
    trackerConfig.providers.enabled = ["codex"];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));
    const workAgent = await screen.findByLabelText("Work agent");
    expect(workAgent).toHaveValue("codex");
    expect(within(workAgent).queryByRole("option", { name: "Claude" })).not.toBeInTheDocument();
    expect(within(workAgent).getByRole("option", { name: "Codex" })).toBeInTheDocument();
  });

  it("explains prompt triggers and renders a dummy assignment before saving", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Prompts" }));
    expect(await screen.findByRole("heading", { name: "Prompt editor" })).toBeInTheDocument();
    expect(screen.getByText("When this runs")).toBeInTheDocument();
    expect(screen.getByText("After a phase is claimed or recovered and Herdr is attached.")).toBeInTheDocument();
    expect(screen.getByText("Available meta tags")).toBeInTheDocument();
    expect(screen.getByText("{{ticket_id}}")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview with dummy ticket" }));
    expect(await screen.findByText(/Rendered dummy assignment for AGENT-0042/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Prompt Markdown"), { target: { value: `${promptFixtures[0]!.content}\nBe concise.` } });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/prompts/assignment", expect.objectContaining({
      method: "PUT", body: expect.stringContaining('"expected_revision":"assignment-r1"'),
    })));
  });

  it("shows a same-host repository blocker without changing the ready status", async () => {
    current.frontmatter.status = "ready";
    current.frontmatter.execution = null;
    claimBlockers = [{ hostname: "worker-vm", supervisor_id: "other-root", ticket_id: "APT-41", ticket_title: "Other work", repositories: ["demo"] }];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const blockers = within(await screen.findByRole("region", { name: "Repository claim blockers" }));
    expect(blockers.getByText("Repository work is reserved on this host")).toBeInTheDocument();
    expect(blockers.getByText("APT-41 · Other work")).toBeInTheDocument();
    expect(screen.getAllByText("Ready", { selector: ".status-pill" }).length).toBeGreaterThan(0);
  });

  it("offers a manual GitHub check while specification approval is pending", async () => {
    current.frontmatter.phase = "specification";
    current.frontmatter.status = "waiting_approval";
    current.frontmatter.execution = null;
    current.frontmatter.pull_requests = [{ repository: "demo", url: "https://github.com/example/demo/pull/42", phase: "specification" }];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    expect(await screen.findByRole("button", { name: "Approve specification" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check specification PRs" })).toBeInTheDocument();
  });

  it("uses a structured editor while a ticket is pending", async () => {
    current.frontmatter.status = "pending";
    current.frontmatter.phase = "specification";
    current.frontmatter.execution = null;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const title = await screen.findByLabelText("Title");
    fireEvent.change(title, { target: { value: "A clearer ticket title" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "# Goal\n\nUpdated through fields." } });
    fireEvent.click(screen.getByRole("button", { name: "Save ticket" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42", expect.objectContaining({
      method: "PUT", body: expect.stringContaining("A clearer ticket title"),
    })));
  });

  it("selects explicit work agents and pairs Claude and Codex for independent review", async () => {
    current.frontmatter.status = "pending";
    current.frontmatter.phase = "specification";
    current.frontmatter.execution = null;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    expect(await screen.findByLabelText("Work agent")).toHaveValue("claude");
    expect(screen.getByLabelText("Review agent")).toHaveValue("codex");
    fireEvent.change(screen.getByLabelText("Work agent"), { target: { value: "codex" } });
    expect(screen.getByLabelText("Review agent")).toHaveValue("claude");
    fireEvent.change(screen.getByLabelText("Work agent"), { target: { value: "claude" } });
    expect(screen.getByLabelText("Review agent")).toHaveValue("codex");
    expect(screen.getByLabelText("Review agent")).toBeDisabled();
  });

  it("keeps a failed creation draft visible and explains the validation failure", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));
    expect(await screen.findByLabelText("Ticket ID")).toHaveValue("AGENT-0001");
    expect(screen.getByLabelText("Ticket ID")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Repository 1"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    expect(fetch).toHaveBeenCalledWith("/api/tickets", expect.objectContaining({ body: expect.stringContaining('"auto_id":true') }));
    expect(await screen.findByRole("alert")).toHaveTextContent("repositories[0].id must be a non-empty string");
    expect(screen.getByRole("heading", { name: "Create work ticket" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Describe the work");
  });

  it("keeps a custom ticket ID instead of requesting automatic allocation", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));
    fireEvent.change(await screen.findByLabelText("Ticket ID"), { target: { value: "TEAM-42" } });
    fireEvent.change(screen.getByLabelText("Repository 1"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets", expect.objectContaining({
      body: expect.stringMatching(/"auto_id":false[\s\S]*id: TEAM-42|id: TEAM-42[\s\S]*"auto_id":false/),
    })));
    expect(screen.getByLabelText("Ticket ID")).toHaveValue("TEAM-42");
  });

  it("offers configured repositories without restricting freeform repository IDs", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));
    const repository = await screen.findByLabelText("Repository 1");
    expect(repository).toHaveAttribute("list", "configured-repositories");
    expect(document.querySelector('#configured-repositories option[value="demo"]')).not.toBeNull();
    expect(screen.getByText("Choose a configured repository or type any repository ID. Only configured repositories are cloned automatically.")).toBeInTheDocument();

    fireEvent.change(repository, { target: { value: "unconfigured-private-repo" } });
    expect(repository).toHaveValue("unconfigured-private-repo");
    expect(screen.getByRole("button", { name: "Create ticket" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets", expect.objectContaining({
      body: expect.stringContaining("id: unconfigured-private-repo"),
    })));
  });

  it("shows the shared work conversation without claiming a skipped specification ran", async () => {
    current.frontmatter.spec_required = false;
    current.frontmatter.review_required = false;
    current.frontmatter.phase = "done";
    current.frontmatter.status = "completed";
    current.frontmatter.execution = null;
    current.frontmatter.attempts.specification.total = 0;
    current.frontmatter.attempts.implementation.total = 1;
    current.frontmatter.agents.specification = { provider: "claude", herdr_pane_id: "w4:p1", session_ref: "claude-work-session" };
    current.frontmatter.agents.implementation = { ...current.frontmatter.agents.specification };
    current.frontmatter.agents.review = { provider: null, herdr_pane_id: null, session_ref: null };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const sessions = within(await screen.findByRole("region", { name: "Agent sessions" }));
    expect(sessions.getByText("Work")).toBeInTheDocument();
    expect(sessions.getByText("claude")).toBeInTheDocument();
    expect(sessions.getByText("Specification skipped · Implementation 1 attempt")).toBeInTheDocument();
    expect(sessions.queryByText("Specification", { exact: true })).not.toBeInTheDocument();
    expect(sessions.getByText("Review")).toBeInTheDocument();
    expect(sessions.getByText("Skipped")).toBeInTheDocument();
  });

  it("reloads the queue with archived tickets when the archive filter is checked", async () => {
    current.frontmatter.phase = "done";
    current.frontmatter.status = "completed";
    current.frontmatter.archived_at = "2026-08-14T13:00:00Z";
    current.frontmatter.execution = null;
    render(<App />);
    expect(await screen.findByText("No tickets yet. Create the first piece of work.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Archived" }));
    expect(await screen.findByRole("button", { name: /UI ticket/i })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/tickets?include_archived=true", expect.anything());
  });

  it("offers agent-suggested answers while preserving a freeform response", async () => {
    current.frontmatter.status = "blocked";
    current.frontmatter.questions = [{
      id: "question-1", phase: "implementation", question: "Which environment?",
      options: ["Development", "Staging", "Both"], asked_at: "2026-08-14T12:01:00Z", answer: null, answered_at: null,
    }];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const answer = await screen.findByLabelText("Answer: Which environment?");
    expect(answer).toHaveAttribute("placeholder", "Type any answer…");
    fireEvent.click(screen.getByRole("button", { name: "Staging" }));
    expect(answer).toHaveValue("Staging");
    fireEvent.change(answer, { target: { value: "Production after the change window" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42/questions/question-1/answer", expect.objectContaining({
      method: "POST", body: expect.stringContaining('"answer":"Production after the change window"'),
    })));
  });

  it("edits a live description while retaining and guiding the current phase", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Live ticket description"), { target: { value: "# Goal\n\nUse the revised live requirement." } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([path, init]) => path === "/api/tickets/APT-42" && init?.method === "PUT");
      expect(call).toBeDefined();
      const payload = JSON.parse(String(call?.[1]?.body));
      expect(payload.mode).toBe("keep_phase");
      expect(payload.markdown).toContain("Use the revised live requirement.");
    });
  });

  it("explicitly enables specification when a live restart selects the skipped phase", async () => {
    current.frontmatter.spec_required = false;
    current.frontmatter.attempts.specification.total = 0;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Live ticket description"), { target: { value: "# Goal\n\nSpecify this revised scope first." } });
    fireEvent.change(screen.getByLabelText("Restart phase"), { target: { value: "specification" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([path, init]) => path === "/api/tickets/APT-42" && init?.method === "PUT");
      expect(call).toBeDefined();
      const payload = JSON.parse(String(call?.[1]?.body));
      expect(payload).toMatchObject({ mode: "rewind", rewind_phase: "specification" });
      expect(payload.markdown).toContain("spec_required: true");
    });
  });
});
