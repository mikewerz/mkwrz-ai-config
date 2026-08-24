import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPT_NAMES, PromptLibrary } from "./prompt-library.js";
import { TicketStore } from "./ticket-store.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentic-prompt-library-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("PromptLibrary", () => {
  it("seeds missing Markdown defaults without replacing operator edits", async () => {
    const first = new PromptLibrary(root);
    await first.start();
    expect((await first.list()).map((prompt) => prompt.name)).toEqual(PROMPT_NAMES);

    const assignment = await first.get("assignment");
    expect(assignment.content).toContain("{{start_here_path}}");
    expect(assignment.content).toContain("{{callback_helper_path}}");
    expect(assignment.content).toContain("The generated files contain the ticket");
    expect(assignment.content).not.toContain("{{ticket_markdown}}");
    expect(assignment.tags.map((tag) => tag.name)).toContain("project_root");

    const merge = await first.get("merge");
    expect(merge.content).toContain("explicitly authorizes you to merge");
    expect(merge.content).toContain("Never bypass branch protection");

    const specification = await first.get("specification");
    expect(specification.content).toContain("identify the remote default branch (normally main or master)");
    expect(specification.content).toContain("If this is a feedback, repair, or other resumed iteration");
    const implementation = await first.get("implementation");
    expect(implementation.content).toContain("pull or fast-forward it to the latest remote state");
    const reminder = await first.get("callback-reminder");
    expect(reminder.content).toContain("lost during context compaction");
    expect(reminder.content).toContain("{{start_here_path}}");
    expect(reminder.content).toContain("{{callback_helper_path}} schema complete");
    expect(reminder.tags.map((tag) => tag.name)).toContain("assignment_directory");

    const requiredSupervisorPrompts = await Promise.all(["assignment", "guidance", "callback-reminder"].map((name) => first.get(name)));
    expect(requiredSupervisorPrompts.map((prompt) => ({ name: prompt.name, valid: prompt.valid, errors: prompt.errors }))).toEqual([
      { name: "assignment", valid: true, errors: [] },
      { name: "guidance", valid: true, errors: [] },
      { name: "callback-reminder", valid: true, errors: [] },
    ]);
    const guidance = requiredSupervisorPrompts[1]!;
    expect(guidance.content).toContain("{{update_path}}");
    expect(guidance.tags.map((tag) => tag.name)).toContain("message");

    const guidancePath = join(root, "prompts", "guidance.md");
    await writeFile(guidancePath, "Custom guidance for {{ticket_id}}: {{message}}\n");
    await new PromptLibrary(root).start();
    expect(await readFile(guidancePath, "utf8")).toBe("Custom guidance for {{ticket_id}}: {{message}}\n");
  });

  it("never rewrites an existing assignment artifact during startup", async () => {
    const promptDirectory = join(root, "prompts");
    await mkdir(promptDirectory, { recursive: true });
    const assignmentPath = join(promptDirectory, "assignment.md");
    await writeFile(assignmentPath, "Operator-owned assignment prompt\n");
    await new PromptLibrary(root).start();
    expect(await readFile(assignmentPath, "utf8")).toBe("Operator-owned assignment prompt\n");
  });

  it("never rewrites existing node or reminder prompt artifacts during startup", async () => {
    const promptDirectory = join(root, "prompts");
    await mkdir(promptDirectory, { recursive: true });
    const custom = "Use the repository's documented preparation process for {{ticket_id}}.\n";
    await writeFile(join(promptDirectory, "specification.md"), custom);
    await new PromptLibrary(root).start();
    expect(await readFile(join(promptDirectory, "specification.md"), "utf8")).toBe(custom);
  });

  it("publishes trigger, stage, tag, and validation metadata", async () => {
    const implementation = await new PromptLibrary(root).get("implementation");
    expect(implementation).toMatchObject({
      title: "Implementation instructions",
      stages: ["Implementation", "Review repair", "Reopen", "GitHub follow-up"],
      valid: true,
    });
    expect(implementation.trigger).toContain("GitHub PR follow-up repairs");
    expect(implementation.tags.map((tag) => tag.name)).toContain("ticket_id");
  });

  it("previews the bootstrap and the durable node instructions separately", async () => {
    const rendered = await new PromptLibrary(root).preview(
      "implementation",
      "Implement {{ticket_id}} in {{phase}} and report to {{callback_base}}complete.",
    );
    expect(rendered).toContain("/srv/agentic-assignments/worker-a/tickets/AGENT-0042/runs/0001-implementation-dummy-run/START_HERE.md");
    expect(rendered).toContain("/srv/agent-workspaces/supervisor-a");
    expect(rendered).toContain("# Durable node.md preview");
    expect(rendered).toContain("Implement AGENT-0042 in implementation");
    expect(rendered).toContain("http://tracker:4310/api/work/dummy-lease/complete");
    expect(rendered).not.toContain("{{");
  });

  it("previews a callback reminder with exact durable recovery paths", async () => {
    const library = new PromptLibrary(root);
    const reminder = await library.get("callback-reminder");
    const rendered = await library.preview("callback-reminder", reminder.content, "specification");
    expect(rendered).toContain("Ticket AGENT-0042 is still leased at workflow node");
    expect(rendered).toContain("/srv/agentic-assignments/worker-a/tickets/AGENT-0042/runs/0001-implementation-dummy-run/START_HERE.md");
    expect(rendered).toContain("/srv/agentic-assignments/worker-a/tickets/AGENT-0042/runs/0001-implementation-dummy-run/callback schema complete");
    expect(rendered).not.toContain("{{");
  });

  it("revision-fences edits and rejects missing, unknown, or malformed tags", async () => {
    const library = new PromptLibrary(root);
    const assignment = await library.get("assignment");
    expect(assignment.version).toBe(1);
    const updated = await library.update("assignment", `${assignment.content}\nKeep the response concise.`, assignment.revision);
    expect(updated.version).toBe(2);
    expect(updated.content).toContain("Keep the response concise.");
    await expect(library.update("assignment", assignment.content, assignment.revision)).rejects.toMatchObject({ status: 409 });
    await expect(library.update("assignment", "Only {{ticket_id}}", updated.revision)).rejects.toMatchObject({ status: 422 });
    await expect(library.preview("implementation", "Use {{TicketId}}", "implementation")).rejects.toMatchObject({ status: 422 });
    await expect(library.preview("implementation", "Use {{ticket_id", "implementation")).rejects.toMatchObject({ status: 422 });
    const restored = await library.restore("assignment", updated.revision);
    expect(restored.version).toBe(1);
    expect(restored.content).toBe(assignment.content);
  });

  it("keeps the reserved prompts directory out of the ticket queue", async () => {
    const store = new TicketStore(root, { watch: false });
    await store.start();
    try {
      await new PromptLibrary(root).start();
      expect(await store.summaries()).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
