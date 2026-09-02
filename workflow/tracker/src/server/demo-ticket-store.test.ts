import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DemoTicketStore, demoRoute } from "./demo-ticket-store.js";
import { normalizeTicket } from "./validation.js";
import { initializeWorkflow, WorkflowLibrary, type WorkflowNode } from "./workflow-library.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("demo route selection", () => {
  it("prefers a unique declared success, then zero, then the first declared route", () => {
    const agent = {
      type: "agent", outcomes: [
        { id: "retry", target: "again", metric_class: "failure" },
        { id: "passed", target: "done", metric_class: "success" },
      ], choices: [], exit_codes: [],
    } as unknown as WorkflowNode;
    const script = {
      type: "script", outcomes: [], choices: [], exit_codes: [
        { id: "fallback", target: "failed", default: true },
        { id: "zero", target: "done", codes: [0] },
      ],
    } as unknown as WorkflowNode;
    const ambiguous = {
      type: "agent", outcomes: [
        { id: "first", target: "one" },
        { id: "second", target: "two" },
      ], choices: [], exit_codes: [],
    } as unknown as WorkflowNode;

    expect(demoRoute(agent)?.id).toBe("passed");
    expect(demoRoute(script)?.id).toBe("zero");
    expect(demoRoute(ambiguous)?.id).toBe("first");
  });
});

describe("DemoTicketStore", () => {
  it("simulates work in memory, pauses at human gates, and clears when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracker-demo-")); roots.push(root);
    const workflows = new WorkflowLibrary(root);
    const workflow = await workflows.get("standard-delivery");
    const changed: Array<string | undefined> = [];
    const demos = new DemoTicketStore(workflows, (id) => changed.push(id), () => new Date());
    demos.configure({ enabled: true, step_duration_seconds: 1 });
    const normalized = normalizeTicket({ id: "DEMO-0001", title: "Show the workflow", repositories: [{ id: "demo", primary: true }] });
    initializeWorkflow(normalized.ticket, workflow);

    const created = await demos.create(normalized.ticket, "# Goal\n\nDemonstrate the factory.\n", workflow);
    expect(created.frontmatter).toMatchObject({ demo: true, status: "running", execution: null });
    expect(created.frontmatter?.workflow?.node_runs).toHaveLength(1);
    expect((await demos.summaries())[0]).toMatchObject({ id: "DEMO-0001", demo: true, status: "running" });

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const gated = await demos.get("DEMO-0001");
    expect(gated.frontmatter).toMatchObject({ status: "waiting_approval", workflow: { current_node: "specification-approval" } });
    expect(gated.frontmatter?.pull_requests).toEqual([{
      repository: "demo", phase: "specification", url: "demo://pull-request/DEMO-0001/demo/specification",
    }]);
    expect(gated.markdown).toContain("demo.gate_waiting");
    expect((await demos.summaries())[0]?.attention.kinds).toEqual(["human_gate"]);

    const implementation = await demos.decide("DEMO-0001", "approved", "Looks good", gated.frontmatter!.revision);
    expect(implementation.frontmatter).toMatchObject({ status: "running", workflow: { current_node: "implementation" } });
    expect(implementation.frontmatter?.workflow?.node_runs.map((run) => run.node_id)).toEqual(["specification", "specification-approval", "implementation"]);
    expect(changed.length).toBeGreaterThan(0);

    demos.configure({ enabled: false, step_duration_seconds: 1 });
    expect(await demos.list()).toEqual([]);
  });

  it("reserves the DEMO-xxxx namespace and revision-fences gate decisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracker-demo-")); roots.push(root);
    const workflows = new WorkflowLibrary(root);
    const workflow = await workflows.get("standard-delivery");
    const demos = new DemoTicketStore(workflows, () => undefined);
    demos.configure({ enabled: true, step_duration_seconds: 10 });
    const malformed = normalizeTicket({ id: "DEMO-one", title: "Bad demo", repositories: [{ id: "demo", primary: true }] }).ticket;
    initializeWorkflow(malformed, workflow);

    await expect(demos.create(malformed, "# Goal\n\nBad ID.\n", workflow)).rejects.toMatchObject({ code: "DEMO_ID_INVALID" });
    expect(demos.nextId(["DEMO-0001", "DEMO-0002"])).toBe("DEMO-0003");
  });
});
