import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { TicketStore } from "./ticket-store.js";
import { ticketMarkdown } from "./test-helpers.js";

let root: string;
let store: TicketStore;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentic-api-")); store = new TicketStore(root, { watch: false }); await store.start(); });
afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

describe("health endpoint", () => {
  it("returns service status", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.status).toBe("ok");
  });

  it("reports uptime and memory usage", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body).toMatchObject({
      status: "ok",
      uptime_seconds: expect.any(Number),
      memory_usage: {
        heap_used: expect.any(Number),
        heap_total: expect.any(Number),
        external: expect.any(Number),
      },
      node: expect.stringContaining("v"),
      platform: expect.any(String),
      arch: expect.any(String),
      server_time: expect.any(String),
    });
  });

  it("reports correct server time", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const health = await request(app).get("/api/health").expect(200);
    expect(new Date(health.body.server_time).toISOString()).toBe(health.body.server_time);
  });
});

describe("tracker API", () => {
  it("admits the bundled agent-skill ticket template", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const markdown = await readFile("skills/agentic-project-tracker/assets/ticket-template.md", "utf8");
    const created = await request(app).post("/api/tickets").send({ markdown, auto_id: true }).expect(201);
    expect(created.body.frontmatter).toMatchObject({
      id: "AGENT-0001", phase: "specification", status: "pending",
      work_provider: "claude", review_provider: "codex",
      repositories: [{ id: "replace-with-repository-id", primary: true }],
    });
  });

  it("serves, previews, and revision-fences the central prompt library", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const initial = await request(app).get("/api/prompts").expect(200);
    expect(initial.body.prompts).toHaveLength(6);
    const implementation = initial.body.prompts.find((prompt: { name: string }) => prompt.name === "implementation");
    expect(implementation).toMatchObject({
      valid: true,
      stages: ["Implementation", "Review repair", "Reopen", "GitHub follow-up"],
    });

    const preview = await request(app).post("/api/prompts/implementation/preview").send({
      content: "Implement {{ticket_id}} and call {{callback_base}}complete.", phase: "implementation",
    }).expect(200);
    expect(preview.body.rendered).toContain("You are assigned ticket AGENT-0042");
    expect(preview.body.rendered).toContain("Implement AGENT-0042");

    const updated = await request(app).put("/api/prompts/implementation").send({
      content: `${implementation.content}\nAsk focused questions when requirements are ambiguous.`,
      expected_revision: implementation.revision,
    }).expect(200);
    expect(updated.body.prompt.content).toContain("Ask focused questions");
    await request(app).put("/api/prompts/implementation").send({
      content: implementation.content, expected_revision: implementation.revision,
    }).expect(409);
  });

  it("allocates local ticket IDs from tracker configuration", async () => {
    const app = createApp(store, join(root, "missing-client"));
    expect((await request(app).get("/api/tickets/next-id").expect(200)).body.id).toBe("AGENT-0001");
    const first = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "preview" }), auto_id: true }).expect(201);
    const second = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "preview" }), auto_id: true }).expect(201);
    expect(first.body.frontmatter.id).toBe("AGENT-0001");
    expect(second.body.frontmatter.id).toBe("AGENT-0002");
    expect(first.body.frontmatter).not.toHaveProperty("slug");
    expect((await request(app).get("/api/config").expect(200)).body.config.tickets.next_number).toBe(3);
    const custom = await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "TEAM-42" }), auto_id: false }).expect(201);
    expect(custom.body.frontmatter.id).toBe("TEAM-42");
    expect((await request(app).get("/api/config").expect(200)).body.config.tickets.next_number).toBe(3);
  });

  it("serves and revision-fences the repository catalog", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const initial = await request(app).get("/api/config").expect(200);
    expect(initial.body.config).toMatchObject({ version: 1, revision: 1, providers: { enabled: ["claude", "codex"] }, repositories: [] });

    const updated = await request(app).put("/api/config").send({
      expected_revision: 1,
      providers: { enabled: ["claude", "codex"] },
      repositories: [{ id: "demo-api", url: "git@github.com:example/demo-api.git" }],
    }).expect(200);
    expect(updated.body.config).toMatchObject({
      version: 1,
      revision: 2,
      providers: { enabled: ["claude", "codex"] },
      repositories: [{ id: "demo-api", url: "git@github.com:example/demo-api.git" }],
    });

    await request(app).put("/api/config").send({ expected_revision: 1, repositories: [] }).expect(409);
    const invalid = await request(app).put("/api/config").send({
      expected_revision: 2,
      repositories: [{ id: "../escape", url: "https://github.com/example/escape.git" }],
    }).expect(422);
    expect(invalid.body.error).toBe("Tracker configuration is invalid");
    await request(app).put("/api/config").send({ expected_revision: 2, providers: { enabled: [] }, repositories: [] }).expect(422);
  });

  it("registers supervisor health and rejects a duplicate live process ID", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const presence = {
      supervisor_id: "vm-one", instance_id: "process-one", hostname: "worker-one",
      ip_addresses: ["192.0.2.70"], project_root: "/srv/projects/one", herdr_session: "agents-one",
      providers: ["claude", "codex"], started_at: "2026-08-14T12:00:00Z",
    };
    await request(app).post("/api/supervisors/heartbeat").send(presence).expect(200);
    const health = await request(app).get("/api/supervisors").expect(200);
    expect(health.body.supervisors[0]).toMatchObject({
      supervisor_id: "vm-one", hostname: "worker-one", ip_addresses: ["192.0.2.70"],
      project_root: "/srv/projects/one", providers: ["claude", "codex"], status: "online", assigned_ticket: null,
    });
    await request(app).post("/api/supervisors/heartbeat").send({ ...presence, instance_id: "process-two" }).expect(409);
  });

  it("pins a ticket end-to-end and reserves the supervisor until terminal state", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false, review_required: false }) }).expect(201);
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id: "APT-0002", spec_required: false, review_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    await request(app).post("/api/tickets/APT-0002/ready").send({ expected_revision: 1 }).expect(200);
    const first = await request(app).post("/api/work/claim").send({ supervisor_id: "vm-one", provider: "claude", available_providers: ["claude"] }).expect(200);
    expect(first.body.frontmatter.assigned_supervisor).toBe("vm-one");
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm-one", provider: "claude", available_providers: ["claude"] }).expect(204);
    const second = await request(app).post("/api/work/claim").send({ supervisor_id: "vm-two", provider: "claude", available_providers: ["claude"] }).expect(200);
    expect(second.body.frontmatter).toMatchObject({ id: "APT-0002", assigned_supervisor: "vm-two" });
    const health = await request(app).get("/api/supervisors").expect(200);
    expect(health.body.supervisors).toEqual([]);
  });

  it("blocks overlapping repositories on one host while allowing another host", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const register = (supervisorId: string, instanceId: string, hostname: string) => request(app).post("/api/supervisors/heartbeat").send({
      supervisor_id: supervisorId, instance_id: instanceId, hostname, ip_addresses: [],
      project_root: `/srv/${supervisorId}`, herdr_session: supervisorId, providers: ["claude"],
      started_at: "2026-08-14T12:00:00Z",
    }).expect(200);
    await register("shared-a", "process-a", "shared-vm");
    await register("shared-b", "process-b", "shared-vm");
    await register("remote", "process-c", "remote-vm");
    for (const id of ["APT-0001", "APT-0002", "APT-0003"]) {
      await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id, spec_required: false, review_required: false }) }).expect(201);
      await request(app).post(`/api/tickets/${id}/ready`).send({ expected_revision: 1 }).expect(200);
    }

    const first = await request(app).post("/api/work/claim").send({
      supervisor_id: "shared-a", instance_id: "process-a", provider: "claude", available_providers: ["claude"],
    }).expect(200);
    expect(first.body.frontmatter).toMatchObject({ assigned_supervisor: "shared-a", assigned_supervisor_host: "shared-vm" });
    await request(app).post("/api/work/claim").send({
      supervisor_id: "shared-b", instance_id: "process-b", provider: "claude", available_providers: ["claude"],
    }).expect(204);

    const queue = await request(app).get("/api/tickets").expect(200);
    const blocked = queue.body.tickets.find((ticket: { id: string }) => ticket.id === "APT-0002");
    expect(blocked).toMatchObject({ status: "ready", claim_blockers: [{ hostname: "shared-vm", ticket_id: "APT-0001", repositories: ["demo"] }] });

    const remote = await request(app).post("/api/work/claim").send({
      supervisor_id: "remote", instance_id: "process-c", provider: "claude", available_providers: ["claude"],
    }).expect(200);
    expect(remote.body.frontmatter).toMatchObject({ id: "APT-0002", assigned_supervisor_host: "remote-vm" });
  });

  it("retains a host-local repository blocker until the conflicting ticket completes", async () => {
    const app = createApp(store, join(root, "missing-client"));
    for (const [supervisorId, instanceId] of [["worker-a", "process-a"], ["worker-b", "process-b"]]) {
      await request(app).post("/api/supervisors/heartbeat").send({
        supervisor_id: supervisorId, instance_id: instanceId, hostname: "shared-vm", ip_addresses: [],
        project_root: `/srv/${supervisorId}`, herdr_session: supervisorId, providers: ["claude"], started_at: "2026-08-14T12:00:00Z",
      }).expect(200);
    }
    for (const id of ["APT-0001", "APT-0002"]) {
      await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ id, spec_required: false, review_required: false }) }).expect(201);
      await request(app).post(`/api/tickets/${id}/ready`).send({ expected_revision: 1 }).expect(200);
    }
    const first = await request(app).post("/api/work/claim").send({ supervisor_id: "worker-a", instance_id: "process-a", provider: "claude", available_providers: ["claude"] }).expect(200);
    await request(app).post(`/api/work/${first.body.frontmatter.execution.lease_id}/fail`).send({ reason: "Needs operator attention" }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "worker-b", instance_id: "process-b", provider: "claude", available_providers: ["claude"] }).expect(204);
    const failed = await request(app).get("/api/tickets/APT-0001").expect(200);
    await request(app).post("/api/tickets/APT-0001/retry").send({ expected_revision: failed.body.frontmatter.revision }).expect(200);
    const retried = await request(app).post("/api/work/claim").send({ supervisor_id: "worker-a", instance_id: "process-a", provider: "claude", available_providers: ["claude"] }).expect(200);
    await request(app).post(`/api/work/${retried.body.frontmatter.execution.lease_id}/complete`).send({
      summary: "Completed", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/100" }],
    }).expect(200);
    const second = await request(app).post("/api/work/claim").send({ supervisor_id: "worker-b", instance_id: "process-b", provider: "claude", available_providers: ["claude"] }).expect(200);
    expect(second.body.frontmatter.id).toBe("APT-0002");
  });

  it("requires lifecycle capabilities and explicitly clears machine-local sessions on release", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false, review_required: true }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "claude-only", provider: "claude", available_providers: ["claude"] }).expect(204);
    const claimed = await request(app).post("/api/work/claim").send({ supervisor_id: "full", provider: "claude", available_providers: ["claude", "codex"] }).expect(200);
    const lease = claimed.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${lease}/heartbeat`).send({ pane_id: "w1:p1", session_ref: "claude-work" }).expect(200);
    await request(app).post(`/api/work/${lease}/fail`).send({ reason: "VM maintenance" }).expect(200);
    const failed = await request(app).get("/api/tickets/APT-0001").expect(200);
    const released = await request(app).post("/api/tickets/APT-0001/release-supervisor").send({ expected_revision: failed.body.frontmatter.revision }).expect(200);
    expect(released.body.frontmatter).toMatchObject({ assigned_supervisor: null, status: "ready" });
    expect(released.body.frontmatter.agents.implementation).toEqual({ provider: null, herdr_pane_id: null, session_ref: null });
  });

  it("rejects duplicate ticket identities before writing another file", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown() }).expect(201);
    const duplicate = await request(app).post("/api/tickets").send({
      markdown: ticketMarkdown({ title: "Different title" }),
    }).expect(409);
    expect(duplicate.body).toMatchObject({ error: "Ticket id already exists" });
    expect(duplicate.body.details[0]).toContain("APT-0001");
    const tickets = await request(app).get("/api/tickets").expect(200);
    expect(tickets.body.tickets).toHaveLength(1);
  });

  it("runs specification approval, implementation, and independent review", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown() }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const specification = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const specLease = specification.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${specLease}/complete`).send({
      summary: "Specification ready", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/1" }],
    }).expect(200);
    const waiting = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(waiting.body.frontmatter.status).toBe("waiting_approval");
    await request(app).post("/api/tickets/APT-0001/approve-specification").send({ expected_revision: waiting.body.frontmatter.revision }).expect(200);
    const implementation = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const implementationLease = implementation.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${implementationLease}/complete`).send({ summary: "Implemented", pull_requests: [] }).expect(200);
    const review = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex" }).expect(200);
    const reviewLease = review.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${reviewLease}/complete`).send({ summary: "Approved", decision: "approved" }).expect(200);
    const completed = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(completed.body.frontmatter).toMatchObject({ phase: "done", status: "completed" });
  });

  it("routes explicit Codex work to an independent Claude reviewer", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ work_provider: "codex", review_provider: "claude", spec_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude", "codex"] }).expect(204);
    const work = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex", available_providers: ["claude", "codex"] }).expect(200);
    expect(work.body.frontmatter.agents.specification.provider).toBe("codex");
    expect(work.body.frontmatter.agents.implementation.provider).toBe("codex");
    const workLease = work.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${workLease}/heartbeat`).send({ pane_id: "w1:p1", session_ref: "codex-work" }).expect(200);
    await request(app).post(`/api/work/${workLease}/complete`).send({
      summary: "Implemented by Codex", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/9" }],
    }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex", available_providers: ["claude", "codex"] }).expect(204);
    const review = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude", available_providers: ["claude", "codex"] }).expect(200);
    expect(review.body.frontmatter.agents.implementation.session_ref).toBe("codex-work");
    expect(review.body.frontmatter.agents.review.session_ref).toBeNull();
    await request(app).post(`/api/work/${review.body.frontmatter.execution.lease_id}/heartbeat`).send({ pane_id: "w2:p1", session_ref: "claude-review" }).expect(200);
    const reviewing = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(reviewing.body.frontmatter.agents.implementation.session_ref).toBe("codex-work");
    expect(reviewing.body.frontmatter.agents.review.session_ref).toBe("claude-review");
  });

  it("rejects self-review pairings for Claude and Codex work", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const invalid = await request(app).post("/api/tickets").send({
      markdown: ticketMarkdown({ work_provider: "codex", review_provider: "codex" }),
    }).expect(422);
    expect(invalid.body.details).toContain("Codex work must be reviewed by Claude");
  });

  it("returns active leases to a restarting supervisor with an absolute ticket path", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(claim.body.path).toMatch(/^\//);
    const active = await request(app).get("/api/work/active?supervisor_id=vm&provider=claude").expect(200);
    expect(active.body.tickets).toHaveLength(1);
    expect(active.body.tickets[0].frontmatter.execution.lease_id).toBe(claim.body.frontmatter.execution.lease_id);
    await request(app).get("/api/work/active?supervisor_id=other&provider=claude").expect(200).expect({ tickets: [] });
  });

  it("persists rich Herdr observations and exposes active runtime monitoring", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;
    await request(app).post(`/api/work/${lease}/heartbeat`).send({
      observed_state: "working", pane_id: "w1:p1", session_ref: "claude-session",
      herdr_observation: {
        pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term-1", focused: false,
        cwd: "/srv/projects", foreground_cwd: "/srv/projects/demo", terminal_title_stripped: "Running tests",
        revision: 18, session_source: "herdr:claude", session_kind: "path", tokens: { model: "qwen" },
      },
    }).expect(200);
    const runtime = await request(app).get("/api/runtime").expect(200);
    expect(runtime.body.agents).toHaveLength(1);
    expect(runtime.body.agents[0]).toMatchObject({
      ticket_id: "APT-0001", provider: "claude", pane_id: "w1:p1",
      herdr: { state: "working", workspace_id: "w1", foreground_cwd: "/srv/projects/demo", tokens: { model: "qwen" } },
    });
    expect(runtime.body.agents[0].herdr.observed_at).toEqual(expect.any(String));
    expect(runtime.body.agents[0].herdr.state_changed_at).toEqual(expect.any(String));
  });

  it("rejects stale callbacks and replays an exact terminal callback", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false, review_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;
    const payload = { summary: "Done", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/1" }] };
    const first = await request(app).post(`/api/work/${lease}/complete`).send(payload).expect(200);
    const replay = await request(app).post(`/api/work/${lease}/complete`).send(payload).expect(200);
    expect(replay.body).toEqual(first.body);
    await request(app).post(`/api/work/${lease}/complete`).send({ ...payload, summary: "Different" }).expect(409);
  });

  it("persists guidance and human comments before delivery", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;
    const guided = await request(app).post("/api/tickets/APT-0001/guidance").send({
      expected_revision: claim.body.frontmatter.revision, message: "Preserve the public API.",
    }).expect(200);
    await request(app).post("/api/tickets/APT-0001/comment").send({
      expected_revision: guided.body.frontmatter.revision, message: "Operator note.",
    }).expect(200);
    const pending = await request(app).get(`/api/work/${lease}/guidance?after=0`).expect(200);
    expect(pending.body.guidance).toHaveLength(1);
    const sequence = pending.body.guidance[0].sequence as number;
    await request(app).post(`/api/work/${lease}/heartbeat`).send({ guidance_cursor: sequence, observed_state: "working" }).expect(200);
    const ticket = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(ticket.body.markdown).toContain("human.guidance");
    expect(ticket.body.markdown).toContain("human.commented");
    expect(ticket.body.frontmatter.execution.guidance[0].delivered_at).not.toBeNull();
  });

  it("guides active description edits and interrupts before restarting an earlier phase", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false, review_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id as string;

    const continued = await request(app).put("/api/tickets/APT-0001").send({
      expected_revision: claim.body.frontmatter.revision,
      mode: "keep_phase",
      markdown: String(claim.body.markdown).replace("Complete the requested work.", "Continue with the revised requirement."),
    }).expect(200);
    expect(continued.body.frontmatter).toMatchObject({ phase: "implementation", status: "running" });
    expect(continued.body.frontmatter.execution.guidance[0].message).toContain("Reread the authoritative ticket");
    const guidance = await request(app).get(`/api/work/${lease}/guidance?after=0`).expect(200);
    expect(guidance.body.guidance[0].message).toContain("revision");

    const restart = await request(app).put("/api/tickets/APT-0001").send({
      expected_revision: continued.body.frontmatter.revision,
      mode: "rewind",
      rewind_phase: "specification",
      markdown: String(continued.body.markdown)
        .replace("Continue with the revised requirement.", "Specify the revised requirement first.")
        .replace("spec_required: false", "spec_required: true"),
    }).expect(200);
    expect(restart.body.frontmatter).toMatchObject({
      phase: "implementation", status: "running", spec_required: true,
      execution: { lease_id: lease, interrupt_request: { target_phase: "specification" } },
    });
    await request(app).post("/api/work/claim").send({ supervisor_id: "other", provider: "claude" }).expect(204);
    await request(app).post(`/api/work/${lease}/complete`).send({
      summary: "Stale completion", pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/1" }],
    }).expect(409);
    const control = await request(app).get(`/api/work/${lease}/control`).expect(200);
    expect(control.body.interrupt).toMatchObject({ target_phase: "specification" });
    const acknowledged = await request(app).post(`/api/work/${lease}/interrupt-ack`).send({}).expect(200);
    expect(acknowledged.body.frontmatter).toMatchObject({ phase: "specification", status: "ready", execution: null });
    await request(app).post(`/api/work/${lease}/heartbeat`).send({ observed_state: "working" }).expect(409);
  });

  it("preserves Claude and Codex ticket conversations through feedback and repair loops", async () => {
    const app = createApp(store, join(root, "missing-client"));
    const pr = [{ repository: "demo", url: "https://github.com/example/demo/pull/42" }];
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ work_provider: "claude", review_provider: "codex" }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex" }).expect(204);

    const spec1 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    await request(app).post(`/api/work/${spec1.body.frontmatter.execution.lease_id}/heartbeat`).send({ pane_id: "w1:p1", session_ref: "claude-ticket-1" }).expect(200);
    await request(app).post(`/api/work/${spec1.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Specified", pull_requests: pr }).expect(200);
    let current = await request(app).get("/api/tickets/APT-0001").expect(200);
    await request(app).post("/api/tickets/APT-0001/request-specification-changes").send({ expected_revision: current.body.frontmatter.revision, message: "Cover rollback." }).expect(200);
    const spec2 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(spec2.body.frontmatter.agents.implementation.session_ref).toBe("claude-ticket-1");
    await request(app).post(`/api/work/${spec2.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Updated specification", pull_requests: pr }).expect(200);
    current = await request(app).get("/api/tickets/APT-0001").expect(200);
    await request(app).post("/api/tickets/APT-0001/approve-specification").send({ expected_revision: current.body.frontmatter.revision }).expect(200);

    const implementation1 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(implementation1.body.frontmatter.agents.implementation.session_ref).toBe("claude-ticket-1");
    await request(app).post(`/api/work/${implementation1.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Implemented", pull_requests: pr }).expect(200);
    const review1 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex" }).expect(200);
    await request(app).post(`/api/work/${review1.body.frontmatter.execution.lease_id}/heartbeat`).send({ pane_id: "w2:p1", session_ref: "codex-review-1" }).expect(200);
    await request(app).post(`/api/work/${review1.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Repair edge case.", decision: "changes_requested" }).expect(200);

    const implementation2 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    expect(implementation2.body.frontmatter.agents.implementation.session_ref).toBe("claude-ticket-1");
    await request(app).post(`/api/work/${implementation2.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Repaired", pull_requests: pr }).expect(200);
    const review2 = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "codex" }).expect(200);
    expect(review2.body.frontmatter.agents.review.session_ref).toBe("codex-review-1");
    await request(app).post(`/api/work/${review2.body.frontmatter.execution.lease_id}/complete`).send({ summary: "Approved", decision: "approved" }).expect(200);
    current = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(current.body.frontmatter).toMatchObject({ phase: "done", status: "completed" });
  });

  it("accepts a batch of agent questions and resumes only after every answer", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false, review_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id;
    let asked = await request(app).post(`/api/work/${lease}/ask`).send({
      questions: [
        { question: "Which compatibility target?", options: ["Current only", "Current and previous"] },
        { question: "May I add a dependency?", options: ["Yes", "No", "Only if maintained"] },
      ],
    }).expect(200);
    expect(asked.body.frontmatter).toMatchObject({
      status: "blocked",
      questions: [
        { question: "Which compatibility target?", options: ["Current only", "Current and previous"], answer: null },
        { question: "May I add a dependency?", options: ["Yes", "No", "Only if maintained"], answer: null },
      ],
    });

    asked = await request(app).post(`/api/tickets/APT-0001/questions/${asked.body.frontmatter.questions[0].id}/answer`).send({
      expected_revision: asked.body.frontmatter.revision, answer: "Current and previous major versions.",
    }).expect(200);
    expect(asked.body.frontmatter.status).toBe("blocked");
    asked = await request(app).post(`/api/tickets/APT-0001/questions/${asked.body.frontmatter.questions[1].id}/answer`).send({
      expected_revision: asked.body.frontmatter.revision, answer: "Yes, if it is maintained.",
    }).expect(200);
    expect(asked.body.frontmatter.status).toBe("running");
    expect(asked.body.frontmatter.execution.guidance).toHaveLength(2);
  });

  it("retains questions, supports multiple PRs per repository, and archives completed work", async () => {
    const app = createApp(store, join(root, "missing-client"));
    await request(app).post("/api/tickets").send({ markdown: ticketMarkdown({ spec_required: false, review_required: false }) }).expect(201);
    await request(app).post("/api/tickets/APT-0001/ready").send({ expected_revision: 1 }).expect(200);
    const claim = await request(app).post("/api/work/claim").send({ supervisor_id: "vm", provider: "claude" }).expect(200);
    const lease = claim.body.frontmatter.execution.lease_id;
    const asked = await request(app).post(`/api/work/${lease}/ask`).send({ question: "Which compatibility target?" }).expect(200);
    expect(asked.body.frontmatter).toMatchObject({ status: "blocked", questions: [{ question: "Which compatibility target?", options: [], answer: null }] });
    expect((await request(app).get(`/api/work/${lease}/control`).expect(200)).body.waiting_for_answer).toBe(true);
    await request(app).post(`/api/work/${lease}/complete`).send({ summary: "Too early", pull_requests: [] }).expect(409);
    const question = asked.body.frontmatter.questions[0];
    const answered = await request(app).post(`/api/tickets/APT-0001/questions/${question.id}/answer`).send({
      expected_revision: asked.body.frontmatter.revision, answer: "Support the current and previous major versions.",
    }).expect(200);
    expect(answered.body.frontmatter.status).toBe("running");
    expect(answered.body.frontmatter.execution.guidance[0].message).toContain("current and previous major versions");
    const prs = [
      { repository: "demo", url: "https://github.com/example/demo/pull/10" },
      { repository: "demo", url: "https://github.com/example/demo/pull/11" },
    ];
    await request(app).post(`/api/work/${lease}/complete`).send({ summary: "Implemented", pull_requests: prs }).expect(200);
    let completed = await request(app).get("/api/tickets/APT-0001").expect(200);
    expect(completed.body.frontmatter.pull_requests).toHaveLength(2);
    const archived = await request(app).post("/api/tickets/APT-0001/archive").send({ expected_revision: completed.body.frontmatter.revision }).expect(200);
    expect(archived.body.frontmatter.archived_at).toEqual(expect.any(String));
    expect((await request(app).get("/api/tickets").expect(200)).body.tickets).toHaveLength(0);
    expect((await request(app).get("/api/tickets?include_archived=true").expect(200)).body.tickets).toHaveLength(1);
    completed = await request(app).post("/api/tickets/APT-0001/unarchive").send({ expected_revision: archived.body.frontmatter.revision }).expect(200);
    expect(completed.body.frontmatter.archived_at).toBeNull();
  });
});
