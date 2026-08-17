import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TicketStore } from "./ticket-store.js";
import { ticketMarkdown } from "./test-helpers.js";

const cleanup: string[] = [];
async function store(clock?: () => Date, leaseTtlMs = 120_000) {
  const root = await mkdtemp(join(tmpdir(), "agentic-tracker-")); cleanup.push(root);
  const value = new TicketStore(root, { watch: false, leaseTtlMs, ...(clock ? { now: clock } : {}) });
  await value.start();
  return { root, store: value };
}
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("TicketStore", () => {
  it("admits a minimal Markdown ticket and preserves its body", async () => {
    const context = await store();
    await writeFile(join(context.root, "first.md"), ticketMarkdown());
    const [ticket] = await context.store.list();
    expect(ticket?.valid).toBe(true);
    expect(ticket?.frontmatter?.phase).toBe("specification");
    expect(ticket?.frontmatter?.status).toBe("pending");
    expect(ticket?.markdown).toContain("Complete the requested work.");
    expect(ticket?.markdown).toContain("ticket.admitted");
    await context.store.close();
  });

  it("rejects duplicate ids as a complete set", async () => {
    const context = await store();
    await writeFile(join(context.root, "a.md"), ticketMarkdown());
    await writeFile(join(context.root, "b.md"), ticketMarkdown({ title: "Duplicate" }));
    const tickets = await context.store.list();
    expect(tickets).toHaveLength(2);
    expect(tickets.every((item) => !item.valid)).toBe(true);
    expect(tickets[0]?.errors.join(" ")).toContain("Duplicate id");
    await context.store.close();
  });

  it("atomically routes explicitly selected Claude work and fences concurrent claims", async () => {
    const context = await store();
    await context.store.create(ticketMarkdown());
    const admitted = await context.store.get("APT-0001");
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => ({ ticket: { ...ticket, status: "ready" } }));
    const [first, second, wrong] = await Promise.all([
      context.store.claim("worker", "claude"), context.store.claim("worker", "claude"), context.store.claim("worker", "codex"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(wrong).toBeNull();
    expect((first ?? second)?.frontmatter?.execution?.provider).toBe("claude");
    expect(admitted.frontmatter?.revision).toBe(1);
    await context.store.close();
  });

  it("requires the selected Codex worker and complementary Claude reviewer on one supervisor", async () => {
    const context = await store();
    await context.store.create(ticketMarkdown({ work_provider: "codex", review_provider: "claude" }));
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => ({ ticket: { ...ticket, status: "ready" } }));
    expect(await context.store.claim("worker", "codex", ["codex"])).toBeNull();
    const claimed = await context.store.claim("worker", "codex", ["claude", "codex"]);
    expect(claimed?.frontmatter?.agents).toMatchObject({
      specification: { provider: "codex" }, implementation: { provider: "codex" }, review: { provider: null },
    });
    await context.store.close();
  });

  it("uses Claude work and Codex review defaults for legacy tickets without routing fields", async () => {
    const context = await store();
    const legacy = ticketMarkdown().replace(/^work_provider:.*\n/m, "").replace(/^review_provider:.*\n/m, "");
    const created = await context.store.create(legacy);
    expect(created.frontmatter).toMatchObject({ work_provider: "claude", review_provider: "codex" });
    await context.store.close();
  });

  it("requeues two lease losses and blocks the third", async () => {
    let time = Date.parse("2026-08-14T12:00:00Z");
    const context = await store(() => new Date(time), 1_000);
    await context.store.create(ticketMarkdown({ spec_required: false }));
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => ({ ticket: { ...ticket, status: "ready" } }));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await context.store.claim("worker", "claude");
      expect(claimed).not.toBeNull();
      time += 1_001;
      await context.store.expireLeases();
      const ticket = await context.store.get("APT-0001");
      expect(ticket.frontmatter?.status).toBe(attempt === 3 ? "blocked" : "ready");
    }
    await context.store.close();
  });

  it("blocks the requested target when an agent interruption is not acknowledged", async () => {
    let time = Date.parse("2026-08-14T12:00:00Z");
    const context = await store(() => new Date(time), 1_000);
    await context.store.create(ticketMarkdown({ spec_required: false }));
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => ({ ticket: { ...ticket, status: "ready" } }));
    const claimed = await context.store.claim("worker", "claude");
    const rewind = await context.store.edit(
      "APT-0001",
      claimed!.markdown.replace("spec_required: false", "spec_required: true"),
      claimed!.frontmatter!.revision,
      "rewind",
      "specification",
    );
    expect(rewind.frontmatter?.execution?.interrupt_request?.target_phase).toBe("specification");
    time += 1_001;
    await context.store.expireLeases();
    const blocked = await context.store.get("APT-0001");
    expect(blocked.frontmatter).toMatchObject({ phase: "specification", status: "blocked", execution: null });
    expect(blocked.markdown).toContain("work.interrupt_timed_out");
    await context.store.close();
  });

  it("records an external content edit and queues an active reread", async () => {
    const context = await store();
    await context.store.create(ticketMarkdown({ spec_required: false }));
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => ({ ticket: { ...ticket, status: "ready" } }));
    const claimed = await context.store.claim("worker", "claude");
    const path = claimed!.path;
    await writeFile(path, (await readFile(path, "utf8")).replace("Complete the requested work.", "Changed while running."));
    const ticket = await context.store.get("APT-0001");
    expect(ticket.markdown).toContain("ticket.external_edited");
    expect(ticket.frontmatter?.execution?.guidance[0]?.message).toContain("Reread");
    await context.store.close();
  });

  it("fences an active lease when an external state edit changes phase", async () => {
    const context = await store();
    await context.store.create(ticketMarkdown({ spec_required: false }));
    await context.store.command("APT-0001", { event: "ticket.ready", message: "Ready" }, (ticket) => ({ ticket: { ...ticket, status: "ready" } }));
    const claimed = await context.store.claim("worker", "claude");
    const lease = claimed!.frontmatter!.execution!.lease_id;
    await writeFile(claimed!.path, (await readFile(claimed!.path, "utf8")).replace("phase: implementation", "phase: review"));

    const ticket = await context.store.get("APT-0001");
    expect(ticket.frontmatter).toMatchObject({ phase: "review", status: "ready", execution: null });
    expect(ticket.markdown).toContain("incompatible active lease fenced");
    await expect(context.store.heartbeat(lease, { state: "working" })).rejects.toMatchObject({ status: 409 });
    await context.store.close();
  });

  it("keeps an invalid external edit visible but unschedulable", async () => {
    const context = await store();
    const created = await context.store.create(ticketMarkdown({ spec_required: false }));
    await writeFile(created.path, (await readFile(created.path, "utf8")).replace("status: pending", "status: imaginary"));
    const ticket = await context.store.get("APT-0001");
    expect(ticket.valid).toBe(false);
    expect(ticket.errors.join(" ")).toContain("status is not recognized");
    expect(await context.store.claim("worker", "claude")).toBeNull();
    await context.store.close();
  });

  it("repairs a syntax-invalid ticket through its relative path locator", async () => {
    const context = await store();
    await writeFile(join(context.root, "broken.md"), "not a ticket\n");
    const [invalid] = await context.store.summaries();
    expect(invalid).toMatchObject({ id: "broken.md", valid: false, revision: 0 });
    const repaired = await context.store.edit("broken.md", ticketMarkdown(), 0, "keep_phase");
    expect(repaired.valid).toBe(true);
    expect(repaired.frontmatter).toMatchObject({ id: "APT-0001", revision: 1 });
    expect(repaired.markdown).toContain("ticket.corrected");
    await context.store.close();
  });
});
