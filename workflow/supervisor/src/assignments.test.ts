import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssignmentBundleWriter } from "./assignments.js";
import { PromptStore } from "./prompts.js";
import type { ClaimedTicket } from "./types.js";

const execute = promisify(execFile);
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentic-assignment-"));
  roots.push(root);
  return root;
}

function claimedTicket(): ClaimedTicket {
  return {
    id: "AGENT-42",
    path: "tickets/AGENT-42.md",
    markdown: "# Goal\n\nRepair the deployment.\n",
    frontmatter: {
      id: "AGENT-42", title: "Repair deployment", phase: "implementation", status: "running",
      repositories: [{ id: "api service", primary: true }],
      pull_requests: [{ repository: "api service", url: "https://github.com/example/api/pull/42", phase: "implementation" }],
      workflow: {
        id: "delivery", revision: "r1", current_node: "repair",
        incoming: {
          source_node: "review", target_node: "repair", outcome: "changes_requested",
          summary: "Rollback coverage is missing.", handoff: "Add rollback coverage before re-review.",
          output: "last deployment line", output_log_path: "/api/tickets/AGENT-42/runs/previous/output",
        },
      },
      execution: {
        lease_id: "lease-42", provider: "claude", interrupt_request: null,
        node_id: "repair", node_type: "agent", node_run_id: "run 42", attempt: 2,
      },
    },
    workflow_node: {
      id: "repair", name: "Repair implementation", type: "agent", phase: "implementation",
      prompt: "implementation", agent_profile: "default", conversation_key: "work",
      outcomes: [{ id: "repaired", label: "Repair completed", description: "Return to review.", target: "review" }],
      choices: [], exit_codes: [],
    },
    node_prompt: { id: "implementation", revision: "prompt-r1", content: "Repair {{ticket_id}} in {{project_root}}. Use outcome `repaired`." },
    resolved_agent_profile: { alias: "CC-Complex", provider: "claude", model: "claude-opus", reasoning: "high" },
  };
}

function prompts(): PromptStore {
  const store = new PromptStore();
  store.replace({
    assignment: "Read {{start_here_path}}.", specification: "Specify {{ticket_id}}.", implementation: "Implement {{ticket_id}}.",
    review: "Review {{ticket_id}}.", guidance: "Read {{update_path}}.", "callback-reminder": "Reread {{start_here_path}} and use {{callback_helper_path}}.",
  });
  return store;
}

describe("durable assignment bundles", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("downloads verified ticket attachments into the durable node-run bundle", async () => {
    const root = await temporaryRoot();
    const content = Buffer.from("attached screenshot");
    const ticket = claimedTicket();
    ticket.frontmatter.attachments = [{
      id: "attachment-1", filename: "example.png", content_type: "image/png", size_bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"), created_at: "2026-08-20T00:00:00.000Z",
    }];
    const fetcher = vi.fn().mockResolvedValue(new Response(content, { status: 200, headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetcher);
    const bundle = await new AssignmentBundleWriter(root, "worker").prepare(ticket, "http://tracker.test", "/srv/projects", prompts());
    const localPath = join(bundle.attachmentsDirectory, "attachment-1", "example.png");

    expect(await readFile(localPath)).toEqual(content);
    expect(await readFile(bundle.startHerePath, "utf8")).toContain(localPath);
    expect(await readFile(join(bundle.runDirectory, "attachments.md"), "utf8")).toContain("example.png");
    expect(fetcher).toHaveBeenCalledWith(new URL("http://tracker.test/api/tickets/AGENT-42/attachments/attachment-1/content"));
  });

  it("writes one unsanitized node-run directory with complete recovery context", async () => {
    const root = await temporaryRoot();
    const writer = new AssignmentBundleWriter(root, "worker vm");
    const bundle = await writer.prepare(claimedTicket(), "http://tracker.test", "/srv/projects", prompts());

    expect(bundle.runDirectory).toBe(join(root, "worker vm", "tickets", "AGENT-42", "runs", "0002-repair-run 42"));
    const startHere = await readFile(bundle.startHerePath, "utf8");
    expect(startHere).toContain(bundle.callbackHelperPath);
    expect(startHere).toContain("/srv/projects/api service");
    expect(startHere).toContain("edits are not sent back to the tracker and are not durable workflow changes");
    expect(await readFile(join(bundle.runDirectory, "ticket.md"), "utf8")).toContain("Repair the deployment.");
    expect(await readFile(join(bundle.runDirectory, "node.md"), "utf8")).toContain("Repair AGENT-42 in /srv/projects");
    const incoming = await readFile(join(bundle.runDirectory, "incoming.md"), "utf8");
    expect(incoming).toContain("Rollback coverage is missing.");
    expect(incoming).toContain("Add rollback coverage before re-review.");
    expect(incoming).toContain("http://tracker.test/api/tickets/AGENT-42/runs/previous/output");
  });

  it("generates an executable helper that exposes the exact callback schema", async () => {
    const root = await temporaryRoot();
    const bundle = await new AssignmentBundleWriter(root, "worker").prepare(claimedTicket(), "http://tracker.test", "/srv/projects", prompts());
    const { stdout } = await execute(process.execPath, [bundle.callbackHelperPath, "schema", "complete"]);
    expect(JSON.parse(stdout)).toMatchObject({ outcome: "repaired", summary: expect.any(String) });
    const callbacks = JSON.parse(await readFile(join(bundle.runDirectory, "callbacks.json"), "utf8"));
    expect(callbacks.endpoints.complete).toBe("http://tracker.test/api/work/lease-42/complete");
  });

  it("refreshes snapshots and persists guidance beside the active run", async () => {
    const root = await temporaryRoot();
    const writer = new AssignmentBundleWriter(root, "worker");
    const ticket = claimedTicket();
    const bundle = await writer.prepare(ticket, "http://tracker.test", "/srv/projects", prompts());
    ticket.markdown = "# Goal\n\nUse the corrected deployment target.\n";
    await writer.refresh(bundle, ticket, "http://tracker.test", "/srv/projects", prompts());
    const updatePath = await writer.appendUpdate(bundle, { id: "answer 1", sequence: 7, message: "Deploy to green." });

    expect(await readFile(join(bundle.runDirectory, "ticket.md"), "utf8")).toContain("corrected deployment target");
    expect(updatePath).toBe(join(bundle.runDirectory, "updates", "00000007-answer 1.md"));
    expect(await readFile(updatePath, "utf8")).toContain("Deploy to green.");
  });
});
