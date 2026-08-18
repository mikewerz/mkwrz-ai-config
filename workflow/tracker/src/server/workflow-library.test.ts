import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { DEV_ONLY_WORKFLOW, END_TO_END_WORKFLOW, WorkflowLibrary, STANDARD_WORKFLOW, activityRoute, advanceWorkflow, initializeWorkflow, transitionTo, validateWorkflow } from "./workflow-library.js";
import { normalizeTicket } from "./validation.js";
import { PROMPT_NAMES } from "./prompt-library.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function ticket() {
  return normalizeTicket({
    id: "AGENT-0001", title: "Factory test", spec_required: false, review_required: true,
    work_provider: "claude", review_provider: "codex", repositories: [{ id: "demo", primary: true }],
  }).ticket;
}

describe("WorkflowLibrary", () => {
  it("seeds, versions, and reloads immutable workflow revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-workflows-")); roots.push(root);
    const library = new WorkflowLibrary(root);
    const initial = await library.get("standard-delivery");
    expect((await library.list()).map((workflow) => workflow.definition.id)).toEqual(["dev-only", "end-to-end", "standard-delivery"]);
    expect(validateWorkflow(DEV_ONLY_WORKFLOW, new Set(PROMPT_NAMES))).toEqual([]);
    expect(validateWorkflow(END_TO_END_WORKFLOW, new Set(PROMPT_NAMES))).toEqual([]);
    const changed = structuredClone(initial.definition); changed.description = "A published update.";
    const updated = await library.save(stringify(changed), initial.revision);
    expect(updated.revision).not.toBe(initial.revision);
    expect((await library.get("standard-delivery", initial.revision)).definition.description).toBe(initial.definition.description);
    expect(await readFile(join(root, "workflows", ".versions", "standard-delivery", `${initial.revision}.yaml`), "utf8")).toBe(initial.content);
  });

  it("skips optional nodes, follows loops, and projects the current phase", () => {
    const work = ticket();
    const document = { definition: STANDARD_WORKFLOW, content: stringify(STANDARD_WORKFLOW), revision: "a".repeat(64), valid: true, errors: [], referenced_prompts: ["specification", "implementation", "review"] };
    initializeWorkflow(work, document, { implementation: "b".repeat(64), review: "c".repeat(64) });
    work.status = "ready";
    expect(work.workflow?.current_node).toBe("implementation");
    expect(work.phase).toBe("implementation");
    advanceWorkflow(work, STANDARD_WORKFLOW, "completed");
    expect(work.workflow?.current_node).toBe("review");
    advanceWorkflow(work, STANDARD_WORKFLOW, "changes_requested");
    expect(work.workflow?.current_node).toBe("implementation");
  });

  it("rejects missing edges, missing prompt artifacts, and unsafe actions", () => {
    const invalid = structuredClone(STANDARD_WORKFLOW);
    invalid.nodes[0]!.prompt = "missing";
    invalid.nodes.splice(2, 0, {
      id: "verify", name: "Verify", type: "script", phase: "implementation", stage: "implementation", repository: "primary", action: "../escape",
      outcomes: [], choices: [], exit_codes: [{ id: "success", label: "Success", description: "", target: "done", codes: [0] }],
    });
    expect(validateWorkflow(invalid, new Set(["specification", "implementation", "review"]))).toEqual(expect.arrayContaining([
      expect.stringContaining("prompt missing does not exist"),
      expect.stringContaining("action must be a safe action name"),
      expect.stringContaining("exactly one default route"),
    ]));
  });

  it("rejects impossible terminal phase projections and accepts stage bypass reachability", () => {
    const terminalInWork = structuredClone(STANDARD_WORKFLOW);
    const done = terminalInWork.nodes.find((node) => node.id === "done")!;
    done.phase = "implementation"; done.stage = "implementation";
    expect(validateWorkflow(terminalInWork)).toContain("node done: terminal nodes must project to done");

    const agentInDone = structuredClone(STANDARD_WORKFLOW);
    const implementation = agentInDone.nodes.find((node) => node.id === "implementation")!;
    implementation.phase = "done"; implementation.stage = "done";
    expect(validateWorkflow(agentInDone)).toContain("node implementation: only terminal nodes may project to done");

    const terminalFeedbackLoop = structuredClone(STANDARD_WORKFLOW);
    terminalFeedbackLoop.nodes.find((node) => node.id === "done")!.github_watch = { pull_request_phase: "all", feedback_target: "done" };
    expect(validateWorkflow(terminalFeedbackLoop)).toContain("node done: completed-ticket GitHub feedback target must be nonterminal");

    const bypassReachable = structuredClone(STANDARD_WORKFLOW);
    bypassReachable.stages.find((stage) => stage.id === "specification")!.bypass_to = "bypass-repair";
    bypassReachable.nodes.splice(-1, 0, {
      id: "bypass-repair", name: "Bypass repair", type: "agent", phase: "implementation", stage: "implementation",
      prompt: "implementation", provider: "work", conversation_key: "work", outcomes: [{ id: "completed", label: "Complete", description: "Repair complete.", target: "done" }], choices: [], exit_codes: [],
    });
    expect(validateWorkflow(bypassReachable, new Set(PROMPT_NAMES))).not.toContain("node bypass-repair is unreachable");
  });

  it("rejects one conversation key shared across different provider selectors", () => {
    const invalid = structuredClone(STANDARD_WORKFLOW);
    invalid.nodes.find((node) => node.id === "review")!.conversation_key = "work";
    expect(validateWorkflow(invalid, new Set(PROMPT_NAMES))).toContain("node review: conversation work is already assigned to provider selector work");
  });

  it("declares PR requirements, completed feedback targets, and rollback outcomes in bundled workflows", () => {
    expect(STANDARD_WORKFLOW.nodes.find((node) => node.id === "specification")?.pull_request_requirement).toEqual({ scope: "primary", phase: "specification" });
    expect(STANDARD_WORKFLOW.nodes.find((node) => node.id === "done")?.github_watch?.feedback_target).toBe("implementation");
    const validation = END_TO_END_WORKFLOW.nodes.find((node) => node.id === "nonprod-validation")!;
    expect(validation.outcomes.map((outcome) => [outcome.id, outcome.target])).toEqual([
      ["validated", "nonprod-rollback"], ["validation_failed", "nonprod-rollback"],
      ["deployment_failed", "nonprod-rollback"], ["failed", "nonprod-rollback"],
    ]);
    const work = ticket();
    initializeWorkflow(work, { definition: END_TO_END_WORKFLOW, content: stringify(END_TO_END_WORKFLOW), revision: "e".repeat(64), valid: true, errors: [], referenced_prompts: [] }, {});
    transitionTo(work, END_TO_END_WORKFLOW, "nonprod-validation", { outcome: "test_setup", actor: "test" });
    advanceWorkflow(work, END_TO_END_WORKFLOW, "failed", "Deployment state is uncertain.");
    expect(work.workflow).toMatchObject({ current_node: "nonprod-rollback", incoming: { source_node: "nonprod-validation", outcome: "failed" } });
  });

  it("evaluates typed ticket inputs, configurable stages, and exit-code routes", () => {
    const definition = structuredClone(STANDARD_WORKFLOW);
    definition.inputs = [{ id: "deploy-required", label: "Deploy", type: "boolean", default: true }];
    const implementation = definition.nodes.find((node) => node.id === "implementation")!;
    implementation.when = { input: "deploy-required", equals: true };
    implementation.otherwise = "review";
    const work = ticket();
    const document = { definition, content: stringify(definition), revision: "d".repeat(64), valid: true, errors: [], referenced_prompts: ["specification", "implementation", "review"] };
    initializeWorkflow(work, document, {}, { inputs: { "deploy-required": false }, stage_enabled: { specification: false, review: false } });
    expect(work.workflow).toMatchObject({ current_node: "done", inputs: { "deploy-required": false }, stage_enabled: { specification: false, review: false } });
    expect(work.workflow?.node_runs.map((run) => [run.node_id, run.outcome])).toEqual([
      ["specification", "bypassed"], ["implementation", "bypassed"], ["review", "bypassed"],
    ]);

    const activity = { ...implementation, type: "script" as const, outcomes: [], choices: [], exit_codes: [
      { id: "ok", label: "OK", description: "", target: "done", codes: [0] },
      { id: "retry", label: "Retry", description: "", target: "implementation", codes: [2] },
      { id: "failed", label: "Failed", description: "", target: "done", default: true },
    ] };
    expect(activityRoute(activity, 2)?.id).toBe("retry");
    expect(activityRoute(activity, 9)?.id).toBe("failed");
    expect(activityRoute(activity, null)?.id).toBe("failed");
  });

  it("accepts one trusted inline activity source and rejects ambiguous activity definitions", () => {
    const definition = structuredClone(STANDARD_WORKFLOW);
    definition.nodes.splice(3, 0, {
      id: "deploy", name: "Deploy", type: "script", phase: "implementation", stage: "implementation", repository: "primary",
      inline: { language: "python", code: "print('deploy')" }, outcomes: [], choices: [],
      exit_codes: [
        { id: "success", label: "Deployed", description: "Deployment succeeded.", target: "review", codes: [0] },
        { id: "failure", label: "Failed", description: "Deployment failed.", target: "implementation", default: true },
      ],
    });
    definition.nodes.find((node) => node.id === "implementation")!.outcomes[0]!.target = "deploy";
    expect(validateWorkflow(definition, new Set(["specification", "implementation", "review"]))).toEqual([]);

    definition.nodes.find((node) => node.id === "deploy")!.action = "deploy";
    expect(validateWorkflow(definition, new Set(["specification", "implementation", "review"]))).toContain("node deploy: define exactly one repository action or inline activity");
  });
});
