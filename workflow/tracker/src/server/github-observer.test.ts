import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackerConfigStore } from "./config-store.js";
import { GithubObserver } from "./github-observer.js";
import { TicketStore } from "./ticket-store.js";
import { ticketMarkdown } from "./test-helpers.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("GithubObserver", () => {
  it("baselines existing discussion and reopens completed work for a new human comment", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    const root = await mkdtemp(join(tmpdir(), "github-observer-")); roots.push(root);
    const store = new TicketStore(root, { watch: false }); await store.start();
    const configs = new TrackerConfigStore(root); await configs.start();
    await store.create(ticketMarkdown({ spec_required: false, review_required: false }));
    await store.command("APT-0001", { event: "test.completed", message: "Completed." }, (ticket) => {
      ticket.phase = "done"; ticket.status = "completed";
      ticket.pull_requests = [{ repository: "demo", url: "https://github.com/example/demo/pull/42" }];
      return { ticket };
    });
    let comments: Array<Record<string, unknown>> = [{ id: 1, body: "Already handled", user: { login: "reviewer", type: "User" } }];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/42")) return Response.json({ state: "open", draft: true, merged: false, mergeable: true });
      if (url.includes("/issues/42/comments")) return Response.json(comments);
      return Response.json([]);
    });
    const observer = new GithubObserver(store, configs, request as typeof fetch);
    expect(await observer.checkTicket("APT-0001")).toEqual({ checked: 1, reopened: false });
    comments = [comments[0]!, { id: 2, body: "Please cover the upgrade path.", user: { login: "reviewer", type: "User" } }];
    expect(await observer.checkTicket("APT-0001")).toEqual({ checked: 1, reopened: true });
    const reopened = await store.get("APT-0001");
    expect(reopened.frontmatter).toMatchObject({ phase: "implementation", status: "ready" });
    expect(reopened.body).toContain("Please cover the upgrade path");
    await store.close();
  });

  it("periodically resumes specification when first-poll PR feedback is already present", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    const root = await mkdtemp(join(tmpdir(), "github-spec-observer-")); roots.push(root);
    const store = new TicketStore(root, { watch: false }); await store.start();
    const configs = new TrackerConfigStore(root); const config = await configs.start();
    await configs.update({
      providers: config.providers, repositories: config.repositories, jira: config.jira,
      github: { ...config.github, observation_enabled: true },
    }, config.revision);
    await store.create(ticketMarkdown({ spec_required: true, review_required: true }));
    await store.command("APT-0001", { event: "test.specification_completed", message: "Specification ready." }, (ticket) => {
      ticket.phase = "specification"; ticket.status = "waiting_approval";
      ticket.assigned_supervisor = "worker-a"; ticket.assigned_supervisor_host = "shared-vm";
      const conversation = { provider: ticket.work_provider, herdr_pane_id: "w1:p1", session_ref: "spec-session" };
      ticket.agents.specification = { ...conversation }; ticket.agents.implementation = { ...conversation };
      ticket.pull_requests = [{ repository: "demo", url: "https://github.com/example/demo/pull/42", phase: "specification" }];
      return { ticket };
    });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/42")) return Response.json({ state: "open", draft: true, merged: false, mergeable: true });
      if (url.includes("/issues/42/comments")) return Response.json([
        { id: 7, body: "Please document the rollback behavior.", user: { login: "architect", type: "User" } },
      ]);
      return Response.json([]);
    });
    const observer = new GithubObserver(store, configs, request as typeof fetch);
    await observer.checkAll();
    const resumed = await store.get("APT-0001");
    expect(resumed.frontmatter).toMatchObject({
      phase: "specification", status: "ready", assigned_supervisor: "worker-a", assigned_supervisor_host: "shared-vm",
      agents: { specification: { session_ref: "spec-session" }, implementation: { session_ref: "spec-session" } },
    });
    expect(resumed.frontmatter?.pull_requests[0]?.observation).toMatchObject({ last_issue_comment_id: 7 });
    expect(resumed.body).toContain("Please document the rollback behavior");
    expect(resumed.body).toContain("github.specification_follow_up_found");
    await store.close();
  });
});
