import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { HttpError, PROVIDERS, type ActivityCapability, type JsonValue, type NodeTimingState, type Phase, type Provider, type ResolvedAgentProfile, type TicketFrontmatter, type WorkflowNodeRun, type WorkflowTransitionContext } from "./domain.js";

export type WorkflowNodeType = "agent" | "script" | "human_gate" | "read" | "write" | "workflow" | "fan_out" | "fan_in" | "terminal";
export type ProviderSelector = Provider | "work" | "review";

export interface WorkflowInputOption { value: string; label: string }
export interface WorkflowInput {
  id: string;
  label: string;
  type: "boolean" | "select" | "text";
  default: boolean | string;
  options?: WorkflowInputOption[];
}
export interface WorkflowStage {
  id: string;
  name: string;
  phase: Phase;
  skippable: boolean;
  default_enabled: boolean;
  bypass_to?: string;
}
export interface WorkflowCondition { input: string; equals: boolean | string }
export interface WorkflowOutcome {
  id: string;
  label: string;
  description: string;
  target: string;
  metric_class?: "success" | "failure" | "neutral";
}
export interface WorkflowChoice extends WorkflowOutcome { comment_required?: boolean }
export interface WorkflowExitRoute extends WorkflowOutcome {
  codes?: number[];
  default?: boolean;
}
export interface WorkflowMetadataRoute extends WorkflowOutcome {
  equals?: JsonValue;
  default?: boolean;
}
export interface WorkflowScriptOutput {
  persist_stdout: boolean;
  prompt_tail_lines: number;
}
export type WorkflowInlineLanguage = "shell" | "python" | "javascript";
export interface WorkflowInlineActivity {
  language: WorkflowInlineLanguage;
  code: string;
}
export type WorkflowPathBase = "selected_repository" | "primary_repository" | "project_root";
export interface WorkflowPathReference {
  relative_to: WorkflowPathBase;
  path?: string;
  path_input?: string;
}
export interface WorkflowGithubWatch {
  pull_request_phase: Exclude<Phase, "done"> | "all";
  feedback_outcome?: string;
  feedback_target?: string;
}
export interface WorkflowPullRequestRequirement {
  scope: "any" | "primary";
  phase: Exclude<Phase, "done">;
}

export interface WorkflowNode {
  id: string;
  name: string;
  type: WorkflowNodeType;
  phase: Phase;
  stage: string;
  prompt?: string;
  provider?: ProviderSelector;
  agent_profile?: string;
  conversation_key?: string;
  repository?: string;
  script_file?: WorkflowPathReference;
  working_directory?: WorkflowPathReference;
  /** Legacy shorthand normalized to script_file + working_directory. */
  action?: string;
  inline?: WorkflowInlineActivity;
  script_output?: WorkflowScriptOutput;
  metadata_key?: string;
  metadata_value?: JsonValue;
  next?: string;
  metadata_cases?: WorkflowMetadataRoute[];
  workflow_id?: string;
  status_codes?: WorkflowExitRoute[];
  branches?: WorkflowOutcome[];
  fan_in?: string;
  inputs_from?: string[];
  github_watch?: WorkflowGithubWatch;
  pull_request_requirement?: WorkflowPullRequestRequirement;
  when?: WorkflowCondition;
  otherwise?: string;
  max_visits?: number;
  terminal_status?: "completed" | "failed" | "cancelled";
  status_code?: number;
  outcomes: WorkflowOutcome[];
  choices: WorkflowChoice[];
  exit_codes: WorkflowExitRoute[];
}

export interface WorkflowDefinition {
  version: 2;
  id: string;
  name: string;
  description: string;
  start: string;
  max_transitions: number;
  inputs: WorkflowInput[];
  stages: WorkflowStage[];
  nodes: WorkflowNode[];
}

export interface WorkflowDocument {
  definition: WorkflowDefinition;
  content: string;
  revision: string;
  valid: boolean;
  errors: string[];
  referenced_prompts: string[];
}

export function workflowRoutes(node: WorkflowNode): WorkflowOutcome[] {
  if (node.type === "agent") return node.outcomes;
  if (node.type === "human_gate") return node.choices;
  if (node.type === "script") return node.exit_codes;
  if (node.type === "read") return node.metadata_cases ?? [];
  if (node.type === "workflow") return node.status_codes ?? [];
  if (node.type === "fan_out") return node.branches ?? [];
  if (node.type === "write" || node.type === "fan_in") return node.next ? [{ id: "completed", label: "Continue", description: "Continue to the next node.", target: node.next }] : [];
  return [];
}

export function workflowTargets(node: WorkflowNode, definition?: WorkflowDefinition): string[] {
  const stage = definition?.stages.find((candidate) => candidate.id === node.stage);
  return [...new Set([
    ...workflowRoutes(node).map((route) => route.target),
    ...(node.otherwise ? [node.otherwise] : []),
    ...(stage?.skippable && stage.bypass_to ? [stage.bypass_to] : []),
    ...(node.github_watch?.feedback_target ? [node.github_watch.feedback_target] : []),
  ])];
}

export function workflowRoute(node: WorkflowNode, outcome: string): WorkflowOutcome | undefined {
  return workflowRoutes(node).find((route) => route.id === outcome);
}

export function activityRoute(node: WorkflowNode, exitCode: number | null): WorkflowExitRoute | undefined {
  if (node.type !== "script") return undefined;
  if (exitCode !== null) {
    const exact = node.exit_codes.find((route) => route.codes?.includes(exitCode));
    if (exact) return exact;
  }
  return node.exit_codes.find((route) => route.default);
}

export function activeWorkflowIdentity(ticket: TicketFrontmatter): { id: string; revision: string } {
  if (!ticket.workflow) throw new HttpError(409, "Ticket does not have a V3 workflow");
  return {
    id: ticket.workflow.active_workflow_id || ticket.workflow.id,
    revision: ticket.workflow.active_workflow_revision || ticket.workflow.revision,
  };
}

export function runtimeNodeKey(ticket: TicketFrontmatter, nodeId: string): string {
  const active = activeWorkflowIdentity(ticket);
  return active.id === ticket.workflow!.id ? nodeId : `${active.id}/${nodeId}`;
}

export function resolvedAgentProfile(ticket: TicketFrontmatter, node: WorkflowNode, workflowId?: string): ResolvedAgentProfile | null {
  if (!ticket.workflow) return null;
  const id = workflowId ?? activeWorkflowIdentity(ticket).id;
  return ticket.workflow.resolved_agent_profiles?.[`${id}/${node.id}`] ?? null;
}

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_ROUTE_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function portableRelativePath(value: string, allowCurrentDirectory: boolean): boolean {
  const path = value.trim();
  if (!path || path.includes("\0") || /[\r\n]/.test(path) || /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const segments = path.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) return false;
  return allowCurrentDirectory || segments.some((segment) => segment !== "." && segment !== "");
}
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

export const STANDARD_WORKFLOW: WorkflowDefinition = {
  version: 2,
  id: "standard-delivery",
  name: "Standard delivery",
  description: "Optional specification, implementation, independent review, and repair loops.",
  start: "specification",
  max_transitions: 50,
  inputs: [],
  stages: [
    { id: "specification", name: "Specification", phase: "specification", skippable: true, default_enabled: true, bypass_to: "implementation" },
    { id: "implementation", name: "Implementation", phase: "implementation", skippable: false, default_enabled: true },
    { id: "review", name: "Review", phase: "review", skippable: true, default_enabled: true, bypass_to: "done" },
    { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
  ],
  nodes: [
    {
      id: "specification", name: "Specification", type: "agent", phase: "specification", stage: "specification",
      prompt: "specification", provider: "work", conversation_key: "work", max_visits: 10,
      pull_request_requirement: { scope: "primary", phase: "specification" },
      outcomes: [{ id: "completed", label: "Specification completed", description: "The specification is ready for human review.", target: "specification-approval" }], choices: [], exit_codes: [],
    },
    {
      id: "specification-approval", name: "Approve specification", type: "human_gate", phase: "specification", stage: "specification", max_visits: 10,
      github_watch: { pull_request_phase: "specification", feedback_outcome: "changes_requested" },
      choices: [
        { id: "approved", label: "Approve specification", description: "Continue to implementation.", target: "implementation" },
        { id: "changes_requested", label: "Request changes", description: "Return the specification to the work agent.", target: "specification", comment_required: true },
      ], outcomes: [], exit_codes: [],
    },
    {
      id: "implementation", name: "Implementation", type: "agent", phase: "implementation", stage: "implementation",
      prompt: "implementation", provider: "work", conversation_key: "work", max_visits: 20,
      pull_request_requirement: { scope: "any", phase: "implementation" },
      outcomes: [{ id: "completed", label: "Implementation completed", description: "Implementation and verification are complete.", target: "review" }], choices: [], exit_codes: [],
    },
    {
      id: "review", name: "Independent review", type: "agent", phase: "review", stage: "review",
      prompt: "review", provider: "review", conversation_key: "review", max_visits: 20,
      outcomes: [
        { id: "approved", label: "Approve implementation", description: "The implementation passes independent review.", target: "done" },
        { id: "changes_requested", label: "Request changes", description: "Return findings to the implementation agent.", target: "implementation" },
      ], choices: [], exit_codes: [],
    },
    { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", github_watch: { pull_request_phase: "all", feedback_target: "implementation" }, outcomes: [], choices: [], exit_codes: [] },
  ],
};

export const DEV_ONLY_WORKFLOW: WorkflowDefinition = {
  version: 2,
  id: "dev-only",
  name: "Dev Only",
  description: "Specification review, implementation, independent review, human PR approval, merge, and repository callback.",
  start: "specification",
  max_transitions: 80,
  inputs: [],
  stages: [
    { id: "specification", name: "Specification", phase: "specification", skippable: false, default_enabled: true },
    { id: "development", name: "Development", phase: "implementation", skippable: false, default_enabled: true },
    { id: "review", name: "Review", phase: "review", skippable: false, default_enabled: true },
    { id: "merge", name: "Merge", phase: "implementation", skippable: false, default_enabled: true },
    { id: "callback", name: "Completion callback", phase: "implementation", skippable: false, default_enabled: true },
    { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
  ],
  nodes: [
    {
      id: "specification", name: "Specify ticket", type: "agent", phase: "specification", stage: "specification",
      prompt: "specification", provider: "work", conversation_key: "work", max_visits: 20,
      pull_request_requirement: { scope: "primary", phase: "specification" },
      outcomes: [{ id: "completed", label: "Specification ready", description: "The specification PR is ready for human approval.", target: "specification-approval" }], choices: [], exit_codes: [],
    },
    {
      id: "specification-approval", name: "Approve specification", type: "human_gate", phase: "specification", stage: "specification", max_visits: 20,
      github_watch: { pull_request_phase: "specification", feedback_outcome: "changes_requested" },
      choices: [
        { id: "approved", label: "Approve specification", description: "Continue to implementation.", target: "implementation" },
        { id: "changes_requested", label: "Request specification changes", description: "Return feedback to the specifying agent.", target: "specification", comment_required: true },
      ], outcomes: [], exit_codes: [],
    },
    {
      id: "implementation", name: "Implement change", type: "agent", phase: "implementation", stage: "development",
      prompt: "implementation", provider: "work", conversation_key: "work", max_visits: 30,
      pull_request_requirement: { scope: "any", phase: "implementation" },
      outcomes: [{ id: "completed", label: "Implementation ready", description: "Implementation and repository verification are complete.", target: "initial-review" }], choices: [], exit_codes: [],
    },
    {
      id: "initial-review", name: "Independent code review", type: "agent", phase: "review", stage: "review",
      prompt: "review", provider: "review", conversation_key: "review", max_visits: 30,
      outcomes: [
        { id: "approved", label: "Approve implementation", description: "No blocking review findings remain.", target: "pr-approval" },
        { id: "changes_requested", label: "Request implementation changes", description: "Return blocking findings to the implementation agent.", target: "implementation" },
      ], choices: [], exit_codes: [],
    },
    {
      id: "pr-approval", name: "Approve pull request", type: "human_gate", phase: "review", stage: "review", max_visits: 30,
      github_watch: { pull_request_phase: "implementation", feedback_outcome: "changes_requested" },
      choices: [
        { id: "approved", label: "Approve PR for merge", description: "Authorize the merge agent to merge the approved pull requests.", target: "merge" },
        { id: "changes_requested", label: "Request implementation changes", description: "Return PR feedback to implementation.", target: "implementation", comment_required: true },
      ], outcomes: [], exit_codes: [],
    },
    {
      id: "merge", name: "Merge approved pull requests", type: "agent", phase: "implementation", stage: "merge",
      prompt: "merge", provider: "work", conversation_key: "work", max_visits: 10,
      outcomes: [{ id: "completed", label: "Pull requests merged", description: "All approved ticket pull requests are merged and verified.", target: "completion-callback" }], choices: [], exit_codes: [],
    },
    {
      id: "completion-callback", name: "Run completion callback", type: "script", phase: "implementation", stage: "callback",
      repository: "primary",
      script_file: { path: ".agents/actions/callback.sh", relative_to: "selected_repository" },
      working_directory: { path: ".", relative_to: "selected_repository" }, max_visits: 3,
      outcomes: [], choices: [], exit_codes: [
        { id: "success", label: "Callback succeeded", description: "The repository callback exited successfully.", target: "done", codes: [0] },
        { id: "failure", label: "Callback failed", description: "The repository callback failed or could not run.", target: "failed", default: true },
      ],
    },
    { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", github_watch: { pull_request_phase: "all", feedback_target: "implementation" }, outcomes: [], choices: [], exit_codes: [] },
    { id: "failed", name: "Callback failed", type: "terminal", phase: "done", stage: "done", terminal_status: "failed", outcomes: [], choices: [], exit_codes: [] },
  ],
};

export const END_TO_END_WORKFLOW: WorkflowDefinition = {
  version: 2,
  id: "end-to-end",
  name: "End to End",
  description: "Specification through baseline API design, implementation, review, non-production validation and rollback, human approval, and release preparation.",
  start: "specification",
  max_transitions: 120,
  inputs: [],
  stages: [
    { id: "specification", name: "Specification", phase: "specification", skippable: false, default_enabled: true },
    { id: "baseline", name: "API baseline", phase: "implementation", skippable: false, default_enabled: true },
    { id: "development", name: "Development", phase: "implementation", skippable: false, default_enabled: true },
    { id: "review", name: "Review", phase: "review", skippable: false, default_enabled: true },
    { id: "nonprod", name: "Non-production validation", phase: "implementation", skippable: false, default_enabled: true },
    { id: "human-validation", name: "Human validation", phase: "review", skippable: false, default_enabled: true },
    { id: "release", name: "Release preparation", phase: "implementation", skippable: false, default_enabled: true },
    { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
  ],
  nodes: [
    {
      id: "specification", name: "Specify ticket", type: "agent", phase: "specification", stage: "specification",
      prompt: "specification", provider: "work", conversation_key: "work", max_visits: 20,
      pull_request_requirement: { scope: "primary", phase: "specification" },
      outcomes: [{ id: "completed", label: "Specification ready", description: "The specification PR is ready for human approval.", target: "specification-approval" }], choices: [], exit_codes: [],
    },
    {
      id: "specification-approval", name: "Approve specification", type: "human_gate", phase: "specification", stage: "specification", max_visits: 20,
      github_watch: { pull_request_phase: "specification", feedback_outcome: "changes_requested" },
      choices: [
        { id: "approved", label: "Approve specification", description: "Continue to API baseline design.", target: "postman-baseline" },
        { id: "changes_requested", label: "Request specification changes", description: "Return feedback to the specifying agent.", target: "specification", comment_required: true },
      ], outcomes: [], exit_codes: [],
    },
    {
      id: "postman-baseline", name: "Design and baseline Postman collection", type: "agent", phase: "implementation", stage: "baseline",
      prompt: "postman-baseline", provider: "work", conversation_key: "work", max_visits: 10,
      outcomes: [{ id: "completed", label: "Baseline captured", description: "The collection is committed and its current non-production baseline is recorded.", target: "implementation" }], choices: [], exit_codes: [],
    },
    {
      id: "implementation", name: "Implement change", type: "agent", phase: "implementation", stage: "development",
      prompt: "implementation", provider: "work", conversation_key: "work", max_visits: 40,
      pull_request_requirement: { scope: "any", phase: "implementation" },
      outcomes: [{ id: "completed", label: "Implementation ready", description: "Implementation and repository verification are complete.", target: "initial-review" }], choices: [], exit_codes: [],
    },
    {
      id: "initial-review", name: "Independent code review", type: "agent", phase: "review", stage: "review",
      prompt: "review", provider: "review", conversation_key: "review", max_visits: 40,
      outcomes: [
        { id: "approved", label: "Approve implementation", description: "No blocking review findings remain.", target: "nonprod-validation" },
        { id: "changes_requested", label: "Request implementation changes", description: "Return blocking findings to implementation.", target: "implementation" },
      ], choices: [], exit_codes: [],
    },
    {
      id: "nonprod-validation", name: "Deploy and validate non-production", type: "agent", phase: "implementation", stage: "nonprod",
      prompt: "nonprod-validation", provider: "work", conversation_key: "work", max_visits: 20,
      outcomes: [
        { id: "validated", label: "Non-production validated", description: "The deployment is healthy and regression validation passes.", target: "nonprod-rollback" },
        { id: "validation_failed", label: "Validation failed", description: "The deployment ran but validation failed; roll back before repair.", target: "nonprod-rollback" },
        { id: "deployment_failed", label: "Deployment failed", description: "Deployment failed or is uncertain; attempt rollback before human recovery.", target: "nonprod-rollback" },
        { id: "failed", label: "Unclassified non-production failure", description: "An unclassified failure still requires rollback before repair or recovery.", target: "nonprod-rollback" },
      ], choices: [], exit_codes: [],
    },
    {
      id: "nonprod-rollback", name: "Roll back non-production", type: "agent", phase: "implementation", stage: "nonprod",
      prompt: "nonprod-rollback", provider: "work", conversation_key: "work", max_visits: 20,
      outcomes: [{ id: "completed", label: "Rollback verified", description: "Non-production has returned to its intended baseline.", target: "human-validation" }], choices: [], exit_codes: [],
    },
    {
      id: "human-validation", name: "Approve code and testing", type: "human_gate", phase: "review", stage: "human-validation", max_visits: 40,
      github_watch: { pull_request_phase: "implementation", feedback_outcome: "changes_requested" },
      choices: [
        { id: "approved", label: "Approve code and testing", description: "Continue to release ticket creation.", target: "release-ticket" },
        { id: "changes_requested", label: "Request implementation changes", description: "Return GitHub or testing feedback to implementation.", target: "implementation", comment_required: true },
      ], outcomes: [], exit_codes: [],
    },
    {
      id: "release-ticket", name: "Create release ticket", type: "agent", phase: "implementation", stage: "release",
      prompt: "release-ticket", provider: "work", conversation_key: "work", max_visits: 10,
      outcomes: [{ id: "completed", label: "Release ticket created", description: "The release record exists with the required delivery context.", target: "done" }], choices: [], exit_codes: [],
    },
    { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", github_watch: { pull_request_phase: "all", feedback_target: "implementation" }, outcomes: [], choices: [], exit_codes: [] },
  ],
};

const PRE_METRICS_DEFAULTS = new Map<string, WorkflowDefinition>([
  [STANDARD_WORKFLOW.id, structuredClone(STANDARD_WORKFLOW)],
  [DEV_ONLY_WORKFLOW.id, structuredClone(DEV_ONLY_WORKFLOW)],
  [END_TO_END_WORKFLOW.id, structuredClone(END_TO_END_WORKFLOW)],
]);

const FAILURE_METRIC_OUTCOMES = new Set(["changes_requested", "failure", "failed", "validation_failed", "deployment_failed"]);
for (const definition of [STANDARD_WORKFLOW, DEV_ONLY_WORKFLOW, END_TO_END_WORKFLOW]) {
  for (const node of definition.nodes) for (const route of workflowRoutes(node)) {
    route.metric_class = FAILURE_METRIC_OUTCOMES.has(route.id) ? "failure" : "success";
  }
}

export const DEFAULT_WORKFLOWS = [STANDARD_WORKFLOW, DEV_ONLY_WORKFLOW, END_TO_END_WORKFLOW] as const;

const PRE_CORRECTNESS_STANDARD_WORKFLOW = structuredClone(STANDARD_WORKFLOW);
delete PRE_CORRECTNESS_STANDARD_WORKFLOW.nodes.find((node) => node.id === "specification")?.pull_request_requirement;
delete PRE_CORRECTNESS_STANDARD_WORKFLOW.nodes.find((node) => node.id === "implementation")?.pull_request_requirement;
delete PRE_CORRECTNESS_STANDARD_WORKFLOW.nodes.find((node) => node.id === "done")?.github_watch;

const PRE_CORRECTNESS_DEV_ONLY_WORKFLOW = structuredClone(DEV_ONLY_WORKFLOW);
delete PRE_CORRECTNESS_DEV_ONLY_WORKFLOW.nodes.find((node) => node.id === "specification")?.pull_request_requirement;
delete PRE_CORRECTNESS_DEV_ONLY_WORKFLOW.nodes.find((node) => node.id === "implementation")?.pull_request_requirement;
delete PRE_CORRECTNESS_DEV_ONLY_WORKFLOW.nodes.find((node) => node.id === "done")?.github_watch;

const PRE_CORRECTNESS_END_TO_END_WORKFLOW = structuredClone(END_TO_END_WORKFLOW);
delete PRE_CORRECTNESS_END_TO_END_WORKFLOW.nodes.find((node) => node.id === "specification")?.pull_request_requirement;
delete PRE_CORRECTNESS_END_TO_END_WORKFLOW.nodes.find((node) => node.id === "implementation")?.pull_request_requirement;
delete PRE_CORRECTNESS_END_TO_END_WORKFLOW.nodes.find((node) => node.id === "done")?.github_watch;
PRE_CORRECTNESS_END_TO_END_WORKFLOW.nodes.find((node) => node.id === "nonprod-validation")!.outcomes = [
  { id: "completed", label: "Non-production validated", description: "The deployment is healthy and regression validation passes.", target: "nonprod-rollback" },
];

const PREVIOUS_DEFAULTS = new Map<string, WorkflowDefinition>([
  [STANDARD_WORKFLOW.id, PRE_CORRECTNESS_STANDARD_WORKFLOW],
  [DEV_ONLY_WORKFLOW.id, PRE_CORRECTNESS_DEV_ONLY_WORKFLOW],
  [END_TO_END_WORKFLOW.id, PRE_CORRECTNESS_END_TO_END_WORKFLOW],
]);

const PRE_GATE_OBSERVATION_STANDARD_WORKFLOW = structuredClone(PRE_CORRECTNESS_STANDARD_WORKFLOW);
delete PRE_GATE_OBSERVATION_STANDARD_WORKFLOW.nodes.find((node) => node.id === "specification-approval")?.github_watch;

const LEGACY_STANDARD_WORKFLOW = {
  version: 1, id: "standard-delivery", name: "Standard delivery",
  description: "Optional specification, implementation, independent review, and repair loops.",
  start: "specification", max_transitions: 50,
  nodes: [
    { id: "specification", name: "Specification", type: "agent", phase: "specification", prompt: "specification", provider: "work", conversation_key: "work", condition: "spec_required", max_visits: 10, on: { completed: "specification-approval", skipped: "implementation" } },
    { id: "specification-approval", name: "Approve specification", type: "human_gate", phase: "specification", condition: "spec_required", max_visits: 10, on: { approved: "implementation", changes_requested: "specification", skipped: "implementation" } },
    { id: "implementation", name: "Implementation", type: "agent", phase: "implementation", prompt: "implementation", provider: "work", conversation_key: "work", max_visits: 20, on: { completed: "review" } },
    { id: "review", name: "Independent review", type: "agent", phase: "review", prompt: "review", provider: "review", conversation_key: "review", condition: "review_required", max_visits: 20, on: { approved: "done", changes_requested: "implementation", skipped: "done" } },
    { id: "done", name: "Done", type: "terminal", phase: "done", terminal_status: "completed", on: {} },
  ],
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function labelFor(id: string): string {
  const value = id.replaceAll(/[_-]+/g, " ").trim();
  return value ? value[0]!.toUpperCase() + value.slice(1) : "Outcome";
}

function normalizeOutcome(item: unknown, fallbackId = ""): WorkflowOutcome {
  const value = record(item) ? item : {};
  const id = typeof value.id === "string" ? value.id : fallbackId;
  return {
    id,
    label: typeof value.label === "string" && value.label.trim() ? value.label : labelFor(id),
    description: typeof value.description === "string" && value.description.trim() ? value.description : `${labelFor(id)} outcome.`,
    target: typeof value.target === "string" ? value.target : "",
    ...(typeof value.metric_class === "string"
      ? { metric_class: value.metric_class as NonNullable<WorkflowOutcome["metric_class"]> }
      : {}),
  };
}

function normalizeDefinition(value: unknown): WorkflowDefinition {
  if (!record(value)) throw new HttpError(422, "Workflow must be a YAML object");
  const legacyNodes = Array.isArray(value.nodes) ? value.nodes.filter(record) : [];
  const phases = [...new Set(legacyNodes.map((node) => typeof node.phase === "string" ? node.phase : "implementation"))] as Phase[];
  const stages: WorkflowStage[] = Array.isArray(value.stages) ? value.stages.map((item) => {
    const stage = record(item) ? item : {};
    return {
      id: typeof stage.id === "string" ? stage.id : "",
      name: typeof stage.name === "string" ? stage.name : "",
      phase: typeof stage.phase === "string" ? stage.phase as Phase : "implementation",
      skippable: stage.skippable === true,
      default_enabled: stage.default_enabled !== false,
      ...(typeof stage.bypass_to === "string" ? { bypass_to: stage.bypass_to } : {}),
    };
  }) : phases.map((phase) => ({ id: phase, name: labelFor(phase), phase, skippable: false, default_enabled: true }));
  const inputs: WorkflowInput[] = Array.isArray(value.inputs) ? value.inputs.map((item) => {
    const input = record(item) ? item : {};
    const type = input.type === "select" || input.type === "text" ? input.type : "boolean";
    return {
      id: typeof input.id === "string" ? input.id : "",
      label: typeof input.label === "string" ? input.label : "",
      type,
      default: type === "boolean" ? input.default !== false : typeof input.default === "string" ? input.default : "",
      ...(type === "select" ? { options: Array.isArray(input.options) ? input.options.map((option) => {
        const normalized = record(option) ? option : { value: String(option), label: labelFor(String(option)) };
        return { value: typeof normalized.value === "string" ? normalized.value : "", label: typeof normalized.label === "string" ? normalized.label : "" };
      }) : [] } : {}),
    };
  }) : [];
  const nodes = Array.isArray(value.nodes) ? value.nodes.map((item) => {
    const node = record(item) ? item : {};
    const type = node.type === "verification" ? "script" : typeof node.type === "string" ? node.type as WorkflowNodeType : "agent";
    const phase = typeof node.phase === "string" ? node.phase as Phase : "implementation";
    const legacyOn = record(node.on) ? Object.fromEntries(Object.entries(node.on).map(([key, target]) => [key, String(target)])) : {};
    const whenValue = record(node.when) ? node.when : null;
    const legacyCondition = typeof node.condition === "string" ? node.condition : null;
    const legacyRoutes = Object.entries(legacyOn).filter(([id]) => id !== "skipped").map(([id, target]) => ({ id, label: labelFor(id), description: `${labelFor(id)} outcome.`, target }));
    const outcomes = Array.isArray(node.outcomes) ? node.outcomes.map((outcome) => normalizeOutcome(outcome)) : type === "agent" ? legacyRoutes : [];
    const choices = Array.isArray(node.choices) ? node.choices.map((choice) => {
      const normalized = normalizeOutcome(choice);
      return { ...normalized, ...(record(choice) && choice.comment_required === true ? { comment_required: true } : {}) };
    }) : type === "human_gate" ? legacyRoutes : [];
    const exitCodes = Array.isArray(node.exit_codes) ? node.exit_codes.map((route) => {
      const normalized = normalizeOutcome(route);
      return {
        ...normalized,
        ...(record(route) && Array.isArray(route.codes) ? { codes: route.codes.map(Number) } : {}),
        ...(record(route) && route.default === true ? { default: true } : {}),
      };
    }) : type === "script" ? [
      { id: "success", label: "Success", description: "The action exited with code 0.", target: legacyOn.success ?? "", codes: [0] },
      { id: "failure", label: "Failure", description: "The action exited non-zero or could not run.", target: legacyOn.failure ?? "", default: true },
    ] : [];
    const metadataCases = Array.isArray(node.metadata_cases) ? node.metadata_cases.map((route) => {
      const normalized = normalizeOutcome(route);
      return {
        ...normalized,
        ...(record(route) && "equals" in route ? { equals: route.equals as JsonValue } : {}),
        ...(record(route) && route.default === true ? { default: true } : {}),
      };
    }) : [];
    const statusCodes = Array.isArray(node.status_codes) ? node.status_codes.map((route) => {
      const normalized = normalizeOutcome(route);
      return {
        ...normalized,
        ...(record(route) && Array.isArray(route.codes) ? { codes: route.codes.map(Number) } : {}),
        ...(record(route) && route.default === true ? { default: true } : {}),
      };
    }) : [];
    const branches = Array.isArray(node.branches) ? node.branches.map((route) => normalizeOutcome(route)) : [];
    return {
      id: typeof node.id === "string" ? node.id : "",
      name: typeof node.name === "string" ? node.name : "",
      type,
      phase,
      stage: typeof node.stage === "string" ? node.stage : phase,
      ...(typeof node.prompt === "string" ? { prompt: node.prompt } : {}),
      ...(typeof node.provider === "string" ? { provider: node.provider as ProviderSelector } : {}),
      ...(typeof node.agent_profile === "string" ? { agent_profile: node.agent_profile } : {}),
      ...(typeof node.conversation_key === "string" ? { conversation_key: node.conversation_key } : {}),
      ...(typeof node.repository === "string" ? { repository: node.repository } : {}),
      ...(record(node.script_file) ? { script_file: {
        relative_to: (typeof node.script_file.relative_to === "string" ? node.script_file.relative_to : "selected_repository") as WorkflowPathBase,
        ...(typeof node.script_file.path === "string" ? { path: node.script_file.path } : {}),
        ...(typeof node.script_file.path_input === "string" ? { path_input: node.script_file.path_input } : {}),
      } } : typeof node.action === "string" ? { script_file: {
        relative_to: "selected_repository" as const, path: `.agents/actions/${node.action}.sh`,
      } } : {}),
      ...(record(node.working_directory) ? { working_directory: {
        relative_to: (typeof node.working_directory.relative_to === "string" ? node.working_directory.relative_to : "selected_repository") as WorkflowPathBase,
        ...(typeof node.working_directory.path === "string" ? { path: node.working_directory.path } : {}),
        ...(typeof node.working_directory.path_input === "string" ? { path_input: node.working_directory.path_input } : {}),
      } } : type === "script" ? { working_directory: { relative_to: "selected_repository" as const, path: "." } } : {}),
      ...(record(node.inline) && typeof node.inline.code === "string" && typeof node.inline.language === "string"
        ? { inline: { language: node.inline.language as WorkflowInlineLanguage, code: node.inline.code } }
        : {}),
      ...(record(node.script_output) ? { script_output: {
        persist_stdout: node.script_output.persist_stdout === true,
        prompt_tail_lines: Number.isInteger(node.script_output.prompt_tail_lines) ? Number(node.script_output.prompt_tail_lines) : 0,
      } } : {}),
      ...(typeof node.metadata_key === "string" ? { metadata_key: node.metadata_key } : {}),
      ...("metadata_value" in node ? { metadata_value: node.metadata_value as JsonValue } : {}),
      ...(typeof node.next === "string" ? { next: node.next } : {}),
      ...(typeof node.workflow_id === "string" ? { workflow_id: node.workflow_id } : {}),
      ...(typeof node.fan_in === "string" ? { fan_in: node.fan_in } : {}),
      ...(Array.isArray(node.inputs_from) ? { inputs_from: node.inputs_from.map(String) } : {}),
      ...(record(node.github_watch) && typeof node.github_watch.pull_request_phase === "string"
        ? { github_watch: {
          pull_request_phase: node.github_watch.pull_request_phase as Exclude<Phase, "done"> | "all",
          ...(typeof node.github_watch.feedback_outcome === "string" ? { feedback_outcome: node.github_watch.feedback_outcome } : {}),
          ...(typeof node.github_watch.feedback_target === "string" ? { feedback_target: node.github_watch.feedback_target } : {}),
        } }
        : {}),
      ...(record(node.pull_request_requirement) && typeof node.pull_request_requirement.scope === "string" && typeof node.pull_request_requirement.phase === "string"
        ? { pull_request_requirement: { scope: node.pull_request_requirement.scope as "any" | "primary", phase: node.pull_request_requirement.phase as Exclude<Phase, "done"> } }
        : {}),
      ...(whenValue && typeof whenValue.input === "string" && (typeof whenValue.equals === "string" || typeof whenValue.equals === "boolean")
        ? { when: { input: whenValue.input, equals: whenValue.equals } }
        : legacyCondition ? { when: { input: legacyCondition, equals: true } } : {}),
      ...(typeof node.otherwise === "string" ? { otherwise: node.otherwise } : typeof legacyOn.skipped === "string" ? { otherwise: legacyOn.skipped } : {}),
      ...(Number.isInteger(node.max_visits) ? { max_visits: Number(node.max_visits) } : {}),
      ...(typeof node.terminal_status === "string" ? { terminal_status: node.terminal_status as NonNullable<WorkflowNode["terminal_status"]> } : {}),
      ...(Number.isInteger(node.status_code) ? { status_code: Number(node.status_code) } : {}),
      outcomes,
      choices,
      exit_codes: exitCodes,
      metadata_cases: metadataCases,
      status_codes: statusCodes,
      branches,
    };
  }) : [];
  return {
    version: 2,
    id: typeof value.id === "string" ? value.id : "",
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : "",
    start: typeof value.start === "string" ? value.start : "",
    max_transitions: Number.isInteger(value.max_transitions) ? Number(value.max_transitions) : 50,
    inputs,
    stages,
    nodes,
  };
}

export function validateWorkflow(definition: WorkflowDefinition, promptIds?: Set<string>, workflowIds?: Set<string>, agentProfileIds?: Set<string>): string[] {
  const errors: string[] = [];
  if (!SAFE_ID.test(definition.id)) errors.push("id must be a lowercase artifact id");
  if (!definition.name.trim()) errors.push("name must be non-empty");
  if (!Number.isInteger(definition.max_transitions) || definition.max_transitions < 1 || definition.max_transitions > 1000) errors.push("max_transitions must be between 1 and 1000");
  if (!definition.nodes.length) errors.push("nodes must contain at least one node");
  const ids = definition.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) errors.push("node ids must be unique");
  if (!ids.includes(definition.start)) errors.push("start must reference a node");
  const validTypes: WorkflowNodeType[] = ["agent", "script", "human_gate", "read", "write", "workflow", "fan_out", "fan_in", "terminal"];
  const validPhases: Phase[] = ["specification", "implementation", "review", "done"];
  const stageIds = definition.stages.map((stage) => stage.id);
  const inputIds = definition.inputs.map((input) => input.id);
  const conversationProviders = new Map<string, string>();
  if (new Set(stageIds).size !== stageIds.length) errors.push("stage ids must be unique");
  if (new Set(inputIds).size !== inputIds.length) errors.push("input ids must be unique");
  for (const input of definition.inputs) {
    if (!SAFE_ID.test(input.id)) errors.push(`input ${input.id || "<missing>"}: id must be a lowercase artifact id`);
    if (!input.label.trim()) errors.push(`input ${input.id}: label must be non-empty`);
    if (input.type === "boolean" && typeof input.default !== "boolean") errors.push(`input ${input.id}: boolean default is required`);
    if (input.type === "text" && typeof input.default !== "string") errors.push(`input ${input.id}: text default is required`);
    if (input.type === "select") {
      if (!input.options?.length) errors.push(`input ${input.id}: select options are required`);
      if (!input.options?.some((option) => option.value === input.default)) errors.push(`input ${input.id}: default must match an option`);
      if (new Set(input.options?.map((option) => option.value)).size !== input.options?.length) errors.push(`input ${input.id}: option values must be unique`);
      if (input.options?.some((option) => !SAFE_ID.test(option.value) || !option.label.trim())) errors.push(`input ${input.id}: every option needs a valid value and label`);
    }
  }
  for (const stage of definition.stages) {
    if (!SAFE_ID.test(stage.id)) errors.push(`stage ${stage.id || "<missing>"}: id must be a lowercase artifact id`);
    if (!stage.name.trim()) errors.push(`stage ${stage.id}: name must be non-empty`);
    if (!validPhases.includes(stage.phase)) errors.push(`stage ${stage.id}: invalid phase projection`);
    if (stage.skippable && (!stage.bypass_to || !ids.includes(stage.bypass_to))) errors.push(`stage ${stage.id}: skippable stages require a valid bypass target`);
    if (stage.skippable && definition.nodes.find((node) => node.id === stage.bypass_to)?.stage === stage.id) errors.push(`stage ${stage.id}: bypass target must leave the stage`);
    if (!stage.skippable && stage.bypass_to) errors.push(`stage ${stage.id}: required stages cannot define a bypass target`);
  }
  for (const node of definition.nodes) {
    if (!SAFE_ID.test(node.id)) errors.push(`node ${node.id || "<missing>"}: id must be a lowercase artifact id`);
    if (!node.name.trim()) errors.push(`node ${node.id}: name must be non-empty`);
    if (!validTypes.includes(node.type)) errors.push(`node ${node.id}: unsupported type ${node.type}`);
    if (!validPhases.includes(node.phase)) errors.push(`node ${node.id}: invalid phase projection`);
    if (node.type === "terminal" && node.phase !== "done") errors.push(`node ${node.id}: terminal nodes must project to done`);
    if (node.type !== "terminal" && node.phase === "done") errors.push(`node ${node.id}: only terminal nodes may project to done`);
    if (!stageIds.includes(node.stage)) errors.push(`node ${node.id}: stage ${node.stage} does not exist`);
    if (definition.stages.find((stage) => stage.id === node.stage)?.phase !== node.phase) errors.push(`node ${node.id}: phase projection must match stage ${node.stage}`);
    if (node.when && !inputIds.includes(node.when.input) && node.when.input !== "spec_required" && node.when.input !== "review_required") errors.push(`node ${node.id}: condition input ${node.when.input} does not exist`);
    if (node.when && !node.otherwise) errors.push(`node ${node.id}: conditioned nodes require an otherwise target`);
    if (node.when && node.otherwise === node.id) errors.push(`node ${node.id}: otherwise target must leave the conditioned node`);
    if (node.when) {
      const input = definition.inputs.find((candidate) => candidate.id === node.when?.input);
      if (input?.type === "boolean" && typeof node.when.equals !== "boolean") errors.push(`node ${node.id}: condition value must be boolean`);
      if (input?.type === "select" && !input.options?.some((option) => option.value === node.when?.equals)) errors.push(`node ${node.id}: condition value must match a select option`);
    }
    if (node.otherwise && !ids.includes(node.otherwise)) errors.push(`node ${node.id}: otherwise targets missing node ${node.otherwise}`);
    if (node.max_visits !== undefined && (!Number.isInteger(node.max_visits) || node.max_visits < 1 || node.max_visits > 100)) errors.push(`node ${node.id}: max_visits must be between 1 and 100`);
    const routes = workflowRoutes(node);
    if (new Set(routes.map((route) => route.id)).size !== routes.length) errors.push(`node ${node.id}: route ids must be unique`);
    for (const route of routes) {
      if (!SAFE_ROUTE_ID.test(route.id)) errors.push(`node ${node.id}: route ${route.id || "<missing>"} must use lowercase letters, numbers, hyphens, or underscores`);
      if (!route.label.trim()) errors.push(`node ${node.id}: route ${route.id} needs a label`);
      if (!route.description.trim()) errors.push(`node ${node.id}: route ${route.id} needs a description`);
      if (!ids.includes(route.target)) errors.push(`node ${node.id}: route ${route.id} targets missing node ${route.target}`);
      if (route.metric_class !== undefined && !["success", "failure", "neutral"].includes(route.metric_class)) errors.push(`node ${node.id}: route ${route.id} has an invalid metric_class`);
    }
    if (node.type === "agent") {
      if (!node.prompt || !SAFE_ID.test(node.prompt)) errors.push(`node ${node.id}: agent prompt is required`);
      if (node.prompt && promptIds && !promptIds.has(node.prompt)) errors.push(`node ${node.id}: prompt ${node.prompt} does not exist or is invalid`);
      if (!node.agent_profile && (!node.provider || ![...PROVIDERS, "work", "review"].includes(node.provider))) errors.push(`node ${node.id}: agent_profile or a legacy provider selector is required`);
      if (node.agent_profile && !SAFE_ID.test(node.agent_profile)) errors.push(`node ${node.id}: agent_profile must be a lowercase artifact id`);
      if (node.agent_profile && agentProfileIds && !agentProfileIds.has(node.agent_profile)) errors.push(`node ${node.id}: agent profile ${node.agent_profile} does not exist`);
      if (!node.conversation_key || !SAFE_ID.test(node.conversation_key)) errors.push(`node ${node.id}: conversation_key is required`);
      if (node.conversation_key) {
        const selector = node.agent_profile ? `profile:${node.agent_profile}` : node.provider;
        const priorProvider = conversationProviders.get(node.conversation_key);
        if (selector && priorProvider && priorProvider !== selector) errors.push(`node ${node.id}: conversation ${node.conversation_key} is already assigned to provider selector ${priorProvider}`);
        else if (selector) conversationProviders.set(node.conversation_key, selector);
      }
      if (!node.outcomes.length) errors.push(`node ${node.id}: agent needs an outcome`);
      if (node.pull_request_requirement) {
        if (!["any", "primary"].includes(node.pull_request_requirement.scope)) errors.push(`node ${node.id}: pull request requirement scope must be any or primary`);
        if (!["specification", "implementation", "review"].includes(node.pull_request_requirement.phase)) errors.push(`node ${node.id}: pull request requirement phase is invalid`);
      }
    } else if (node.pull_request_requirement) errors.push(`node ${node.id}: only agent nodes may require pull requests`);
    if (node.type === "script") {
      if (!node.repository?.trim()) errors.push(`node ${node.id}: repository is required`);
      if (Boolean(node.script_file) === Boolean(node.inline)) errors.push(`node ${node.id}: define exactly one script file or inline activity`);
      if (!node.working_directory) errors.push(`node ${node.id}: working_directory is required`);
      for (const [field, reference] of [["script_file", node.script_file], ["working_directory", node.working_directory]] as const) {
        if (!reference) continue;
        if (!["selected_repository", "primary_repository", "project_root"].includes(reference.relative_to)) errors.push(`node ${node.id}: ${field}.relative_to is invalid`);
        if (Boolean(reference.path) === Boolean(reference.path_input)) errors.push(`node ${node.id}: ${field} must define exactly one path or path_input`);
        if (reference.path !== undefined && !portableRelativePath(reference.path, field === "working_directory")) errors.push(`node ${node.id}: ${field}.path must be a contained relative path`);
        if (reference.path_input) {
          const input = definition.inputs.find((candidate) => candidate.id === reference.path_input);
          if (!input || input.type === "boolean") errors.push(`node ${node.id}: ${field}.path_input must reference a text or select input`);
        }
      }
      if (node.inline && !["shell", "python", "javascript"].includes(node.inline.language)) errors.push(`node ${node.id}: inline language must be shell, python, or javascript`);
      if (node.inline && !node.inline.code.trim()) errors.push(`node ${node.id}: inline code must be non-empty`);
      if (!node.exit_codes.some((route) => route.codes?.includes(0))) errors.push(`node ${node.id}: activities require an exit-code 0 route`);
      if (node.exit_codes.filter((route) => route.default).length !== 1) errors.push(`node ${node.id}: activities require exactly one default route`);
      if (node.exit_codes.some((route) => route.default && route.codes?.length)) errors.push(`node ${node.id}: default route cannot list exit codes`);
      const explicitCodes = node.exit_codes.flatMap((route) => route.codes ?? []);
      if (explicitCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)) errors.push(`node ${node.id}: exit codes must be integers from 0 to 255`);
      if (new Set(explicitCodes).size !== explicitCodes.length) errors.push(`node ${node.id}: exit codes cannot be routed more than once`);
      if (node.script_output && (!Number.isInteger(node.script_output.prompt_tail_lines) || node.script_output.prompt_tail_lines < 0 || node.script_output.prompt_tail_lines > 500)) errors.push(`node ${node.id}: prompt_tail_lines must be between 0 and 500`);
    }
    if (node.type === "read") {
      if (!node.metadata_key || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(node.metadata_key)) errors.push(`node ${node.id}: metadata_key is required`);
      if (!node.metadata_cases?.length) errors.push(`node ${node.id}: read nodes require metadata cases`);
      if (node.metadata_cases?.filter((route) => route.default).length !== 1) errors.push(`node ${node.id}: read nodes require exactly one default case`);
      if (node.metadata_cases?.some((route) => route.default && "equals" in route)) errors.push(`node ${node.id}: default metadata case cannot define equals`);
      const values = node.metadata_cases?.filter((route) => !route.default).map((route) => JSON.stringify(route.equals)) ?? [];
      if (new Set(values).size !== values.length) errors.push(`node ${node.id}: metadata case values must be unique`);
    }
    if (node.type === "write") {
      if (!node.metadata_key || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(node.metadata_key)) errors.push(`node ${node.id}: metadata_key is required`);
      if (!("metadata_value" in node)) errors.push(`node ${node.id}: metadata_value is required`);
      if (!node.next || !ids.includes(node.next)) errors.push(`node ${node.id}: write nodes require a valid next target`);
    }
    if (node.type === "workflow") {
      if (!node.workflow_id || !SAFE_ID.test(node.workflow_id)) errors.push(`node ${node.id}: workflow_id is required`);
      if (node.workflow_id === definition.id) errors.push(`node ${node.id}: a workflow cannot call itself`);
      if (node.workflow_id && workflowIds && !workflowIds.has(node.workflow_id)) errors.push(`node ${node.id}: workflow ${node.workflow_id} does not exist`);
      if (!node.status_codes?.length) errors.push(`node ${node.id}: workflow nodes require status-code routes`);
      if (node.status_codes?.filter((route) => route.default).length !== 1) errors.push(`node ${node.id}: workflow nodes require exactly one default route`);
      const explicitCodes = node.status_codes?.flatMap((route) => route.codes ?? []) ?? [];
      if (explicitCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)) errors.push(`node ${node.id}: workflow status codes must be integers from 0 to 255`);
      if (new Set(explicitCodes).size !== explicitCodes.length) errors.push(`node ${node.id}: workflow status codes cannot be routed more than once`);
    }
    if (node.type === "fan_out") {
      if (!node.branches || node.branches.length < 2) errors.push(`node ${node.id}: fan-out nodes require at least two branches`);
      if (!node.fan_in || definition.nodes.find((candidate) => candidate.id === node.fan_in)?.type !== "fan_in") errors.push(`node ${node.id}: fan_in must reference a fan-in node`);
      if (node.fan_in) for (const branch of node.branches ?? []) {
        const seen = new Set<string>();
        const reachesJoin = (target: string): boolean => {
          if (target === node.fan_in) return true;
          if (seen.has(target)) return false;
          seen.add(target);
          const candidate = definition.nodes.find((item) => item.id === target);
          return Boolean(candidate && workflowTargets(candidate, definition).some(reachesJoin));
        };
        if (!reachesJoin(branch.target)) errors.push(`node ${node.id}: branch ${branch.id} cannot reach fan-in node ${node.fan_in}`);
      }
    }
    if (node.type === "fan_in") {
      if (!node.next || !ids.includes(node.next)) errors.push(`node ${node.id}: fan-in nodes require a valid next target`);
      const sources = definition.nodes.filter((candidate) => candidate.type === "fan_out" && candidate.fan_in === node.id);
      if (!sources.length) errors.push(`node ${node.id}: fan-in node is not referenced by a fan-out node`);
    }
    if (node.type === "human_gate") {
      if (node.choices.length < 1) errors.push(`node ${node.id}: human gate needs a choice`);
      if (node.github_watch) {
        if (!["specification", "implementation", "review", "all"].includes(node.github_watch.pull_request_phase)) errors.push(`node ${node.id}: GitHub watch has an invalid pull request phase`);
        if (!node.github_watch.feedback_outcome || !node.choices.some((choice) => choice.id === node.github_watch?.feedback_outcome)) errors.push(`node ${node.id}: GitHub feedback outcome must match a human-gate choice`);
        if (node.github_watch.feedback_target) errors.push(`node ${node.id}: human-gate GitHub watch cannot define a direct target`);
      }
    } else if (node.type === "terminal" && node.github_watch) {
      if (node.terminal_status !== "completed") errors.push(`node ${node.id}: only completed terminal nodes may watch GitHub`);
      if (!["specification", "implementation", "review", "all"].includes(node.github_watch.pull_request_phase)) errors.push(`node ${node.id}: GitHub watch has an invalid pull request phase`);
      if (!node.github_watch.feedback_target || !ids.includes(node.github_watch.feedback_target)) errors.push(`node ${node.id}: completed-ticket GitHub watch requires a valid feedback target`);
      if (definition.nodes.find((candidate) => candidate.id === node.github_watch?.feedback_target)?.type === "terminal") errors.push(`node ${node.id}: completed-ticket GitHub feedback target must be nonterminal`);
      if (node.github_watch.feedback_outcome) errors.push(`node ${node.id}: terminal GitHub watch routes directly and cannot define an outcome`);
    } else if (node.github_watch) errors.push(`node ${node.id}: GitHub watch is supported only on human gates and completed terminal nodes`);
    if (node.type === "terminal") {
      if (!node.terminal_status || !["completed", "failed", "cancelled"].includes(node.terminal_status)) errors.push(`node ${node.id}: terminal_status is required`);
      if (node.outcomes.length || node.choices.length || node.exit_codes.length || node.otherwise) errors.push(`node ${node.id}: terminal nodes cannot have edges`);
      if (!Number.isInteger(node.status_code ?? 0) || (node.status_code ?? 0) < 0 || (node.status_code ?? 0) > 255) errors.push(`node ${node.id}: status_code must be an integer from 0 to 255`);
    }
  }
  if (ids.includes(definition.start)) {
    const reachable = new Set<string>();
    const visit = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      const node = definition.nodes.find((candidate) => candidate.id === id);
      if (node) workflowTargets(node, definition).forEach(visit);
    };
    visit(definition.start);
    for (const id of ids) if (!reachable.has(id)) errors.push(`node ${id} is unreachable`);
  }
  return [...new Set(errors)];
}

function normalizedContent(definition: WorkflowDefinition): string {
  return stringify(definition, { lineWidth: 0 }).trimEnd() + "\n";
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  try { const directory = await open(dirname(path), "r"); await directory.sync(); await directory.close(); } catch { /* unsupported */ }
}

export class WorkflowLibrary {
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private started: Promise<void> | null = null;

  constructor(root: string) { this.directory = join(resolve(root), "workflows"); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next;
  }

  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.serial(async () => {
      await mkdir(join(this.directory, ".versions"), { recursive: true });
      for (const definition of DEFAULT_WORKFLOWS) {
        const path = join(this.directory, `${definition.id}.yaml`);
        try { await stat(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await atomicWrite(path, normalizedContent(definition));
        }
        let current = await readFile(path, "utf8");
        await this.archive(definition.id, digest(current), current);
        if (current === normalizedContent(PREVIOUS_DEFAULTS.get(definition.id)!) || current === normalizedContent(PRE_METRICS_DEFAULTS.get(definition.id)!)) {
          current = normalizedContent(definition);
          await atomicWrite(path, current);
          await this.archive(definition.id, digest(current), current);
        }
      }
      const path = join(this.directory, `${STANDARD_WORKFLOW.id}.yaml`);
      let current = await readFile(path, "utf8");
      await this.archive(STANDARD_WORKFLOW.id, digest(current), current);
      const legacy = stringify(LEGACY_STANDARD_WORKFLOW, { lineWidth: 0 }).trimEnd() + "\n";
      if (current === legacy || current === normalizedContent(PRE_GATE_OBSERVATION_STANDARD_WORKFLOW)) {
        current = normalizedContent(STANDARD_WORKFLOW);
        await atomicWrite(path, current);
      }
      await this.archive(STANDARD_WORKFLOW.id, digest(current), current);
    });
    return this.started;
  }

  private async archive(id: string, revision: string, content: string): Promise<void> {
    const path = join(this.directory, ".versions", id, `${revision}.yaml`);
    try { await stat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(path, content);
    }
  }

  private document(content: string, promptIds?: Set<string>, workflowIds?: Set<string>, agentProfileIds?: Set<string>): WorkflowDocument {
    let definition: WorkflowDefinition;
    let errors: string[] = [];
    try { definition = normalizeDefinition(parse(content)); errors = validateWorkflow(definition, promptIds, workflowIds, agentProfileIds); }
    catch (error) {
      definition = { version: 2, id: "invalid", name: "Invalid workflow", description: "", start: "", max_transitions: 50, inputs: [], stages: [], nodes: [] };
      errors = [(error as Error).message];
    }
    return {
      definition, content, revision: digest(content), valid: errors.length === 0, errors,
      referenced_prompts: [...new Set(definition.nodes.flatMap((node) => node.prompt ? [node.prompt] : []))],
    };
  }

  async list(): Promise<WorkflowDocument[]> {
    await this.start();
    const files = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => entry.name).sort();
    return Promise.all(files.map(async (file) => this.document(await readFile(join(this.directory, file), "utf8"))));
  }

  async get(id: string, revision?: string): Promise<WorkflowDocument> {
    await this.start();
    if (!SAFE_ID.test(id)) throw new HttpError(404, `Workflow ${id} not found`);
    if (revision && !/^[a-f0-9]{64}$/.test(revision)) throw new HttpError(422, "Workflow revision must be a SHA-256 digest");
    const path = revision
      ? join(this.directory, ".versions", id, `${revision}.yaml`)
      : join(this.directory, `${id}.yaml`);
    try {
      const document = this.document(await readFile(path, "utf8"));
      if (document.definition.id !== id) throw new HttpError(422, `Workflow file id does not match ${id}`);
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Workflow ${id}${revision ? `@${revision}` : ""} not found`);
      throw error;
    }
  }

  async save(content: string, expectedRevision?: string, promptIds?: Set<string>, workflowIds?: Set<string>, agentProfileIds?: Set<string>): Promise<WorkflowDocument> {
    await this.start();
    return this.serial(async () => {
      const document = this.document(content, promptIds, workflowIds, agentProfileIds);
      if (!document.valid) throw new HttpError(422, "Workflow is invalid", document.errors);
      const normalized = normalizedContent(document.definition);
      const next = this.document(normalized);
      const path = join(this.directory, `${document.definition.id}.yaml`);
      let current: string | null = null;
      try { current = await readFile(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current !== null && expectedRevision === undefined) throw new HttpError(409, `Workflow ${document.definition.id} already exists`);
      if (current !== null && digest(current) !== expectedRevision) throw new HttpError(409, "Workflow revision changed", this.document(current));
      if (current === null && expectedRevision !== undefined) throw new HttpError(404, `Workflow ${document.definition.id} not found`);
      if (current !== null) await this.archive(document.definition.id, digest(current), current);
      await atomicWrite(path, normalized);
      await this.archive(document.definition.id, next.revision, normalized);
      return next;
    });
  }
}

export function workflowNode(definition: WorkflowDefinition, id: string): WorkflowNode {
  const node = definition.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new HttpError(409, `Pinned workflow node ${id} no longer exists`);
  return node;
}

export function resolveNodeProvider(ticket: TicketFrontmatter, node: WorkflowNode, workflowId?: string): Provider | null {
  if (node.type !== "agent") return null;
  const profile = resolvedAgentProfile(ticket, node, workflowId);
  if (profile) return profile.provider;
  if (node.provider === "work") return ticket.work_provider;
  if (node.provider === "review") return ticket.review_provider;
  return PROVIDERS.includes(node.provider as Provider) ? node.provider as Provider : null;
}

export function requiredActivityCapability(node: WorkflowNode): ActivityCapability | null {
  if (node.type !== "script") return null;
  if (node.script_file || node.action) return "repository_action";
  if (node.inline?.language === "shell") return "inline_shell";
  if (node.inline?.language === "javascript") return "inline_javascript";
  if (node.inline?.language === "python") return "inline_python";
  return null;
}

export function nodeAttemptCounter(ticket: TicketFrontmatter, nodeId?: string): { total: number; consecutive_lease_losses: number } {
  if (ticket.workflow && nodeId) {
    ticket.workflow.node_attempts ??= {};
    const key = runtimeNodeKey(ticket, nodeId);
    ticket.workflow.node_attempts[key] ??= { total: 0, consecutive_lease_losses: 0 };
    return ticket.workflow.node_attempts[key]!;
  }
  if (ticket.phase === "done") throw new HttpError(409, "Terminal tickets cannot start work attempts");
  return ticket.attempts[ticket.phase];
}

function conditionMet(ticket: TicketFrontmatter, condition: WorkflowCondition | undefined): boolean {
  if (!condition) return true;
  const value = condition.input === "spec_required" ? ticket.spec_required
    : condition.input === "review_required" ? ticket.review_required
      : ticket.workflow?.inputs[condition.input];
  return value === condition.equals;
}

export function workflowNodeEnabled(ticket: TicketFrontmatter, definition: WorkflowDefinition, node: WorkflowNode): boolean {
  const stage = definition.stages.find((candidate) => candidate.id === node.stage);
  if (stage?.skippable && ticket.workflow?.stage_enabled[stage.id] === false) return false;
  return conditionMet(ticket, node.when);
}

function projectionStatus(node: WorkflowNode): TicketFrontmatter["status"] {
  if (node.type === "human_gate") return "waiting_approval";
  if (node.type === "terminal") return node.terminal_status ?? "failed";
  return "ready";
}

export function initializeWorkflow(
  ticket: TicketFrontmatter,
  document: WorkflowDocument,
  promptRevisions: Record<string, string> = {},
  selections: {
    inputs?: Record<string, boolean | string>; stage_enabled?: Record<string, boolean>;
    workflow_revisions?: Record<string, string>; resolved_agent_profiles?: Record<string, ResolvedAgentProfile>;
  } = {},
): void {
  if (!document.valid) throw new HttpError(422, "Cannot assign an invalid workflow", document.errors);
  const now = new Date().toISOString();
  const initialStatus = ticket.status;
  const suppliedInputs = selections.inputs ?? {};
  const unknownInputs = Object.keys(suppliedInputs).filter((id) => !document.definition.inputs.some((input) => input.id === id));
  if (unknownInputs.length) throw new HttpError(422, `Unknown workflow input${unknownInputs.length === 1 ? "" : "s"}: ${unknownInputs.join(", ")}`);
  const inputs = Object.fromEntries(document.definition.inputs.map((input) => {
    const selected = suppliedInputs[input.id] ?? input.default;
    if (input.type === "boolean" && typeof selected !== "boolean") throw new HttpError(422, `Workflow input ${input.id} must be boolean`);
    if ((input.type === "text" || input.type === "select") && typeof selected !== "string") throw new HttpError(422, `Workflow input ${input.id} must be text`);
    if (input.type === "select" && !input.options?.some((option) => option.value === selected)) throw new HttpError(422, `Workflow input ${input.id} must match a declared option`);
    return [input.id, selected];
  }));
  for (const node of document.definition.nodes.filter((candidate) => candidate.type === "script")) {
    for (const [field, reference, allowCurrentDirectory] of [["script_file", node.script_file, false], ["working_directory", node.working_directory, true]] as const) {
      if (!reference) continue;
      const selectedPath = reference.path ?? (reference.path_input ? inputs[reference.path_input] : undefined);
      if (typeof selectedPath !== "string" || !portableRelativePath(selectedPath, allowCurrentDirectory)) {
        throw new HttpError(422, `Workflow node ${node.id} resolved ${field} to an invalid relative path`);
      }
    }
  }
  const stageEnabled = Object.fromEntries(document.definition.stages.map((stage) => {
    const legacy = stage.id === "specification" ? ticket.spec_required : stage.id === "review" ? ticket.review_required : undefined;
    const requested = selections.stage_enabled?.[stage.id];
    return [stage.id, stage.skippable ? requested ?? legacy ?? stage.default_enabled : true];
  }));
  ticket.workflow = {
    id: document.definition.id, revision: document.revision, current_node: document.definition.start, transition_count: 0,
    started_at: now, completed_at: null, current_node_entered_at: now,
    node_visits: {}, node_attempts: {}, node_runs: [], prompt_revisions: promptRevisions, inputs, stage_enabled: stageEnabled, incoming: null,
    active_workflow_id: document.definition.id, active_workflow_revision: document.revision,
    workflow_revisions: { [document.definition.id]: document.revision, ...(selections.workflow_revisions ?? {}) },
    workflow_stack: [], fan_out_stack: [], resolved_agent_profiles: selections.resolved_agent_profiles ?? {},
  };
  if ("specification" in stageEnabled) ticket.spec_required = stageEnabled.specification ?? ticket.spec_required;
  if ("review" in stageEnabled) ticket.review_required = stageEnabled.review ?? ticket.review_required;
  ticket.conversations ??= {};
  enterCurrentNode(ticket, document.definition, false);
  if (initialStatus === "pending") ticket.status = "pending";
}

export function enterCurrentNode(ticket: TicketFrontmatter, definition: WorkflowDefinition, countVisit = true): WorkflowNode {
  if (!ticket.workflow) throw new HttpError(409, "Ticket does not have a V3 workflow");
  while (true) {
    if (ticket.workflow.transition_count > definition.max_transitions) {
      ticket.status = "blocked";
      return workflowNode(definition, ticket.workflow.current_node);
    }
    const node = workflowNode(definition, ticket.workflow.current_node);
    const stage = definition.stages.find((candidate) => candidate.id === node.stage);
    const stageDisabled = Boolean(stage?.skippable && ticket.workflow.stage_enabled[stage.id] === false);
    const conditionFailed = !conditionMet(ticket, node.when);
    if (stageDisabled || conditionFailed) {
      const target = stageDisabled ? stage?.bypass_to : node.otherwise;
      if (!target) throw new HttpError(409, `Node ${node.id} has no configured bypass target`);
      const now = new Date().toISOString();
      const summary = stageDisabled ? `Stage ${stage?.name ?? node.stage} was disabled for this ticket.` : `Condition ${node.when?.input} did not match.`;
      ticket.workflow.node_runs.push({
        id: randomUUID(), workflow_id: activeWorkflowIdentity(ticket).id, workflow_revision: activeWorkflowIdentity(ticket).revision, node_id: node.id, node_type: node.type,
        visit: ticket.workflow.node_visits[node.id] ?? 0, attempt: 0, status: "completed", supervisor_id: null, provider: null,
        lease_id: null,
        started_at: now, completed_at: now, outcome: "bypassed", summary,
        handoff: null, output: null, input_revision: ticket.revision, telemetry: null,
        timing: emptyNodeTiming(node.type === "human_gate" ? "human_wait" : "active", null),
      });
      return transitionTo(ticket, definition, target, { outcome: "bypassed", summary, actor: "workflow", source_node: node.id, count_visit: countVisit });
    }
    if (countVisit) {
      const key = runtimeNodeKey(ticket, node.id);
      const visits = (ticket.workflow.node_visits[key] ?? 0) + 1;
      ticket.workflow.node_visits[key] = visits;
      if (node.max_visits && visits > node.max_visits) {
        ticket.status = "blocked";
        ticket.phase = node.phase;
        return node;
      }
    }
    ticket.phase = node.phase;
    ticket.status = projectionStatus(node);
    if (node.type === "terminal") ticket.workflow.completed_at = new Date().toISOString();
    return node;
  }
}

export function transitionTo(ticket: TicketFrontmatter, definition: WorkflowDefinition, target: string, details: {
  outcome: string; summary?: string | null; handoff?: string | null; output?: string | null; output_log_path?: string | null;
  actor?: string; source_node?: string; count_visit?: boolean;
}): WorkflowNode {
  if (!ticket.workflow) throw new HttpError(409, "Ticket does not have a V3 workflow");
  workflowNode(definition, target);
  const source = details.source_node ?? ticket.workflow.current_node;
  const sourceNode = definition.nodes.find((candidate) => candidate.id === source);
  const now = new Date().toISOString();
  const identity = activeWorkflowIdentity(ticket);
  const sourceVisit = ticket.workflow.node_visits[runtimeNodeKey(ticket, source)] ?? 0;
  const matchingRun = [...ticket.workflow.node_runs].reverse().find((run) => run.node_id === source
    && run.workflow_revision === identity.revision
    && (run.workflow_id ?? ticket.workflow!.id) === identity.id
    && run.visit === sourceVisit && run.outcome === details.outcome && run.completed_at !== null);
  if (sourceNode && !matchingRun) {
    ticket.workflow.node_runs.push({
      id: randomUUID(), workflow_id: activeWorkflowIdentity(ticket).id, workflow_revision: activeWorkflowIdentity(ticket).revision, node_id: source, node_type: sourceNode.type,
      visit: sourceVisit, attempt: 0, status: details.outcome.startsWith("operator_") ? "interrupted" : "completed",
      supervisor_id: null, provider: null, started_at: now, completed_at: now, outcome: details.outcome,
      summary: details.summary ?? `Transitioned through ${details.outcome}.`, handoff: details.handoff ?? null,
      output: null, input_revision: ticket.revision, lease_id: null, telemetry: null,
      timing: emptyNodeTiming(sourceNode.type === "human_gate" ? "human_wait" : "active", null),
    });
  }
  ticket.workflow.incoming = {
    source_node: source, target_node: target, outcome: details.outcome,
    summary: details.summary ?? null, handoff: details.handoff ?? null,
    output: details.output ?? null, output_log_path: details.output_log_path ?? null,
    actor: details.actor ?? "workflow", created_at: now,
  };
  ticket.workflow.current_node = target;
  ticket.workflow.current_node_entered_at = now;
  ticket.workflow.completed_at = null;
  ticket.workflow.transition_count += 1;
  return enterCurrentNode(ticket, definition, details.count_visit ?? true);
}

export function advanceWorkflow(ticket: TicketFrontmatter, definition: WorkflowDefinition, outcome: string, summary: string | null = null, handoff: string | null = null, actor = "workflow", output: string | null = null, outputLogPath: string | null = null): WorkflowNode {
  if (!ticket.workflow) throw new HttpError(409, "Ticket does not have a V3 workflow");
  const current = workflowNode(definition, ticket.workflow.current_node);
  const route = workflowRoute(current, outcome);
  if (!route) throw new HttpError(422, `Outcome ${outcome} is not allowed for node ${current.id}`, { allowed: workflowRoutes(current).map((candidate) => candidate.id) });
  return transitionTo(ticket, definition, route.target, { outcome, summary, handoff, output, output_log_path: outputLogPath, actor, source_node: current.id });
}

export function beginNodeRun(ticket: TicketFrontmatter, node: WorkflowNode, workflowRevision: string, attempt: number, now: string, supervisorId: string, provider: Provider | null, leaseId: string | null = null): WorkflowNodeRun {
  const timingState: NodeTimingState = node.type === "human_gate" ? "human_wait" : "active";
  const run: WorkflowNodeRun = {
    id: randomUUID(), ...(ticket.workflow ? { workflow_id: activeWorkflowIdentity(ticket).id } : {}), workflow_revision: workflowRevision, node_id: node.id, node_type: node.type,
    visit: ticket.workflow?.node_visits[ticket.workflow ? runtimeNodeKey(ticket, node.id) : node.id] ?? 1, attempt, status: "running", supervisor_id: supervisorId, provider,
    lease_id: leaseId, started_at: now, completed_at: null, outcome: null, summary: null, handoff: null, output: null,
    input_revision: ticket.revision, telemetry: null, timing: emptyNodeTiming(timingState, now),
  };
  ticket.workflow?.node_runs.push(run);
  return run;
}

export function finishNodeRun(ticket: TicketFrontmatter, runId: string, outcome: string, summary: string, output: string | null, now: string, handoff: string | null = null, outputArtifact?: {
  path: string; sha256: string; bytes: number;
}): void {
  const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === runId);
  if (!run || run.status !== "running") throw new HttpError(409, "Node run is stale or already finished");
  accountNodeRunTiming(run, now);
  run.status = outcome === "failed" || outcome === "failure" ? "failed" : "completed";
  run.completed_at = now; run.outcome = outcome; run.summary = summary; run.handoff = handoff; run.output = output;
  if (outputArtifact) {
    run.output_path = outputArtifact.path;
    run.output_sha256 = outputArtifact.sha256;
    run.output_bytes = outputArtifact.bytes;
  }
}

export function emptyNodeTiming(state: NodeTimingState, startedAt: string | null): WorkflowNodeRun["timing"] {
  return {
    active_ms: 0, quota_paused_ms: 0, human_wait_ms: 0,
    state, last_accounted_at: startedAt, pause_limit_id: null, pause_until: null,
  };
}

export function accountNodeRunTiming(
  run: WorkflowNodeRun,
  now: string,
  next?: { state: NodeTimingState; pause_limit_id?: string | null; pause_until?: string | null },
): void {
  if (run.status !== "running") return;
  const currentAt = Date.parse(now);
  const priorAt = Date.parse(run.timing.last_accounted_at ?? run.started_at);
  if (Number.isFinite(currentAt) && Number.isFinite(priorAt) && currentAt > priorAt) {
    let elapsed = currentAt - priorAt;
    if (run.timing.state === "quota_paused") {
      const resetAt = run.timing.pause_until ? Date.parse(run.timing.pause_until) : Number.NaN;
      const paused = Number.isFinite(resetAt) ? Math.max(0, Math.min(currentAt, resetAt) - priorAt) : elapsed;
      run.timing.quota_paused_ms += paused;
      elapsed -= paused;
      if (elapsed > 0) run.timing.active_ms += elapsed;
    } else if (run.timing.state === "human_wait") run.timing.human_wait_ms += elapsed;
    else run.timing.active_ms += elapsed;
  }
  if (next) {
    run.timing.state = next.state;
    run.timing.pause_limit_id = next.state === "quota_paused" ? next.pause_limit_id ?? null : null;
    run.timing.pause_until = next.state === "quota_paused" ? next.pause_until ?? null : null;
  } else if (run.timing.state === "quota_paused" && run.timing.pause_until && Date.parse(run.timing.pause_until) <= currentAt) {
    run.timing.state = "active";
    run.timing.pause_limit_id = null;
    run.timing.pause_until = null;
  }
  run.timing.last_accounted_at = now;
}
