import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HttpError } from "./domain.js";

export const PROMPT_NAMES = [
  "assignment", "specification", "implementation", "review", "postman-baseline",
  "nonprod-validation", "nonprod-rollback", "merge", "release-ticket", "guidance", "callback-reminder",
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];
export type PreviewPhase = "specification" | "implementation" | "review";

interface TagDefinition { name: string; description: string; example: string }
interface PromptDefinition {
  name: string;
  title: string;
  purpose: string;
  trigger: string;
  stages: string[];
  allowed_tags: string[];
  required_tags: string[];
}

export interface PromptDocument extends PromptDefinition {
  content: string;
  revision: string;
  tags: TagDefinition[];
  valid: boolean;
  errors: string[];
}

export const LEGACY_ASSIGNMENT_DEFAULT = `You are assigned ticket {{ticket_id}} for the {{phase}} phase.

The authoritative ticket is at {{ticket_path}}. Its current contents follow:

{{ticket_markdown}}

{{phase_instructions}} Use your normal tools and judgment. The coordinator does not prescribe your process. Never merge a pull request automatically.

The Herdr lifecycle display is not a completion signal. Before finishing, use one of these HTTP callbacks with a JSON body:
- comment: POST {{callback_base}}comment {"message":"..."}
- ask: POST {{callback_base}}ask {"question":"..."}
- complete: POST {{callback_base}}complete with the phase summary, PR references when applicable, and review decision when reviewing
- fail: POST {{callback_base}}fail {"reason":"..."}

Continue working until you have submitted complete, ask, or fail.`;

export const BATCH_QUESTION_ASSIGNMENT_DEFAULT = `You are assigned ticket {{ticket_id}} for the {{phase}} phase.

The authoritative ticket is at {{ticket_path}}. Its current contents follow:

{{ticket_markdown}}

{{phase_instructions}} Use your normal tools and judgment. The coordinator does not prescribe your process. Never merge a pull request automatically.

The Herdr lifecycle display is observational and never completes a phase. Send callbacks as HTTP POST requests with Content-Type: application/json. Replace every example value below with the real result.

Non-terminal progress note; continue working afterward:
- POST {{callback_base}}comment
- Body: {"message":"A concise progress note, decision, or useful context."}

Block for human input while retaining this lease and conversation. Submit either one question or a batch, then stop and wait for answers:
- POST {{callback_base}}ask
- One question: {"question":"May the public endpoint response change?"}
- Multiple questions: {"questions":["Which compatibility target is required?","May I add a dependency?"]}

Complete specification or implementation:
- POST {{callback_base}}complete
- Body: {"summary":"What was completed and how it was verified.","pull_requests":[{"repository":"repository-id","url":"https://github.com/owner/repository/pull/123"}]}

Complete review:
- POST {{callback_base}}complete
- Approved body: {"summary":"Review result and any non-blocking findings.","decision":"approved"}
- Changes body: {"summary":"Blocking findings; PR comments were added.","decision":"changes_requested"}

Fail only when the phase cannot be completed or continued:
- POST {{callback_base}}fail
- Body: {"reason":"Why the work cannot continue."}

Before becoming idle, call ask if human input is required, complete if the phase is done, or fail if it cannot continue. A comment alone is not a terminal callback.`;

const PROJECT_ROOT_INSTRUCTION = `The supervisor started this conversation in {{project_root}}. Treat that directory as the project root for this ticket. Start repository work under {{project_root}}/<repository-id>; do not search for or switch to another project root unless the ticket or human guidance explicitly requires it.`;

export const PRE_PROMPT_ENGINEERING_ASSIGNMENT_DEFAULT = `You are assigned ticket {{ticket_id}} for the {{phase}} phase.

${PROJECT_ROOT_INSTRUCTION}

The active durable workflow node is {{node_name}} ({{node_id}}).

The transition into this node came from {{incoming_node}} with outcome {{incoming_outcome}}.
Prior summary: {{incoming_summary}}
Handoff: {{incoming_handoff}}

Its allowed terminal outcomes are:
{{allowed_outcomes}}
Legacy V2 review callbacks using {"decision":"approved"} or {"decision":"changes_requested"} remain accepted, but V3 workflows should send outcome.

The authoritative ticket is at {{ticket_path}}. Its current contents follow:

{{ticket_markdown}}

{{phase_instructions}} Use your normal tools and judgment. The coordinator does not prescribe your process. Never merge a pull request automatically.

The Herdr lifecycle display is observational and never completes a phase. Send callbacks as HTTP POST requests with Content-Type: application/json. Replace every example value below with the real result.

Non-terminal progress note; continue working afterward:
- POST {{callback_base}}comment
- Body: {"message":"A concise progress note, decision, or useful context."}

Block for human input while retaining this lease and conversation. Every question may provide any number of suggested answer options, including none. Options are suggestions only; the human can always give a freeform answer. Submit one question or a batch, then stop and wait for answers:
- POST {{callback_base}}ask
- One question: {"question":"Which environment should receive the deployment?","options":["Development","Staging","Both"]}
- Multiple questions: {"questions":[{"question":"Which compatibility target is required?","options":["Current major only","Current and previous major"]},{"question":"May I add a dependency?","options":["Yes","No"]}]}
- Questions without suggestions may omit options or use "options":[]; a batch may also contain plain question strings.

Complete the active workflow node:
- POST {{callback_base}}complete
- Body: {"summary":"What was completed and how it was verified.","handoff":"Useful context for the next workflow node.","outcome":"one allowed outcome","pull_requests":[{"repository":"repository-id","url":"https://github.com/owner/repository/pull/123"}]}

Complete review:
- POST {{callback_base}}complete
- Approved body: {"summary":"Review result and any non-blocking findings.","outcome":"approved"}
- Changes body: {"summary":"Blocking findings; PR comments were added.","outcome":"changes_requested"}

Fail only when the phase cannot be completed or continued:
- POST {{callback_base}}fail
- Body: {"reason":"Why the work cannot continue."}

Before becoming idle, call ask if human input is required, complete if the phase is done, or fail if it cannot continue. A comment alone is not a terminal callback.`;

export const PRE_TYPED_OUTCOME_ASSIGNMENT_DEFAULT = PRE_PROMPT_ENGINEERING_ASSIGNMENT_DEFAULT
  .replace(`The active durable workflow node is {{node_name}} ({{node_id}}).

The transition into this node came from {{incoming_node}} with outcome {{incoming_outcome}}.
Prior summary: {{incoming_summary}}
Handoff: {{incoming_handoff}}

Its allowed terminal outcomes are:
{{allowed_outcomes}}`, "The active durable workflow node is {{node_name}} ({{node_id}}). Its allowed terminal outcomes are: {{allowed_outcomes}}.")
  .replace(',"handoff":"Useful context for the next workflow node."', "");

export const PRE_V3_ASSIGNMENT_DEFAULT = PRE_TYPED_OUTCOME_ASSIGNMENT_DEFAULT
  .replace("\n\nThe active durable workflow node is {{node_name}} ({{node_id}}). Its allowed terminal outcomes are: {{allowed_outcomes}}.", "")
  .replace('\nLegacy V2 review callbacks using {"decision":"approved"} or {"decision":"changes_requested"} remain accepted, but V3 workflows should send outcome.', "")
  .replace("Complete the active workflow node:", "Complete specification or implementation:")
  .replace(',"outcome":"one allowed outcome"', "")
  .replace(',"outcome":"approved"', ',"decision":"approved"')
  .replace(',"outcome":"changes_requested"', ',"decision":"changes_requested"');

export const PRE_PROJECT_ROOT_ASSIGNMENT_DEFAULT = PRE_PROMPT_ENGINEERING_ASSIGNMENT_DEFAULT.replace(`\n\n${PROJECT_ROOT_INSTRUCTION}`, "");

export const PRE_MERGE_PROMPT_ASSIGNMENT_DEFAULT = `# Work assignment

You own ticket {{ticket_id}} for the {{phase}} phase at workflow node **{{node_name}}** (\`{{node_id}}\`).

${PROJECT_ROOT_INSTRUCTION}

## Incoming transition

- Previous node: {{incoming_node}}
- Selected outcome: {{incoming_outcome}}
- Previous result: {{incoming_summary}}
- Actionable handoff: {{incoming_handoff}}

Treat this as context from the preceding durable boundary. Reconcile it with the authoritative ticket and existing repository or PR state; do not blindly repeat already-completed work.

## Current node contract

The authoritative ticket is at {{ticket_path}}:

{{ticket_markdown}}

Node instructions:

{{phase_instructions}}

You retain your normal tools, credentials, judgment, planning, and subagent capabilities. Work autonomously inside this node. The coordinator tracks boundaries; it does not prescribe your implementation process. Never merge a pull request automatically.

This node permits exactly these terminal outcomes:

{{allowed_outcomes}}

Choose an outcome by its exact ID only after its described condition is true. Do not invent an outcome or use a destination node name as the outcome.

## Durable callbacks

Herdr state is observational and never advances the workflow. Send JSON with \`Content-Type: application/json\` to the lease-fenced callback URLs below.

Progress note; continue working:
- \`POST {{callback_base}}comment\`
- \`{"message":"A concise durable progress note or decision."}\`

Human input required; submit one or more focused questions, then stop and wait:
- \`POST {{callback_base}}ask\`
- One: \`{"question":"Which environment should receive the deployment?","options":["Development","Staging","Both"]}\`
- Many: \`{"questions":[{"question":"Which compatibility target is required?","options":["Current major only","Current and previous major"]},{"question":"May I add a dependency?","options":["Yes","No"]}]}\`
- Options are optional suggestions; the human can always answer freely.

Current node complete:
- \`POST {{callback_base}}complete\`
- \`{"outcome":"<exact allowed outcome ID>","summary":"What changed, important decisions, and how the result was verified.","handoff":"Only the actionable context the next node needs.","pull_requests":[{"repository":"repository-id","url":"https://github.com/owner/repository/pull/123"}]}\`
- \`summary\` is the durable record of this node. \`handoff\` is injected into the next agent assignment; use it for requested repairs, risks, unresolved non-blockers, or precise next actions. Omit \`handoff\` when there is nothing useful to carry forward.

Unable to continue this node:
- \`POST {{callback_base}}fail\`
- \`{"reason":"The concrete blocker or unrecoverable failure."}\`

Before becoming idle, you must have sent \`ask\`, \`complete\`, or \`fail\`. A comment is not a terminal callback.`;

const ASSIGNMENT_DEFAULT = PRE_MERGE_PROMPT_ASSIGNMENT_DEFAULT.replace(
  "Never merge a pull request automatically.",
  "Never merge a pull request unless the current node instructions explicitly authorize it and their preconditions are satisfied.",
);

export const PRE_BRANCH_SPECIFICATION_DEFAULT = "Create or update the task specification in the primary repository. Commit and push it on the task branch you choose, then open or update an evolving draft PR. Complete with a summary and the primary repository PR URL.";
export const PRE_BRANCH_IMPLEMENTATION_DEFAULT = "Implement the ticket autonomously. You own repository inspection, Git branches, changes, verification, commits, pushes, and draft PRs. Complete with a summary and all known repository PR URLs.";
export const PRE_CALLBACK_SCHEMA_REMINDER_DEFAULT = "The ticket is still leased because no callback was recorded. Submit complete, ask, or fail before ending this assignment.";

const REPOSITORY_START_GUIDANCE = `Before beginning new work in a repository, inspect its worktree, identify the remote default branch (normally main or master), switch to that branch, and pull or fast-forward it to the latest remote state before creating the task branch. If this is a feedback, repair, or other resumed iteration with an existing task branch or PR, continue that branch instead and integrate the latest default branch safely when appropriate. Preserve unrelated local changes; never reset or overwrite them.`;

export const PRE_PROMPT_ENGINEERING_CALLBACK_REMINDER_DEFAULT = `Ticket {{ticket_id}} is still leased for {{phase}} at workflow node {{node_name}} ({{node_id}}) because no terminal callback was recorded. The earlier callback instructions may have been lost during context compaction. Allowed outcomes:\n{{allowed_outcomes}}\n\nSend an HTTP POST with Content-Type: application/json to one of the lease-fenced endpoints below, replacing example values with the real result.

Non-terminal note; continue working afterward:
- POST {{callback_base}}comment
- Body: {"message":"A concise progress note, decision, or useful context."}

Block for human input, then stop and wait. Questions may include any number of suggested options; the UI always permits a freeform answer:
- POST {{callback_base}}ask
- One question: {"question":"Which environment should receive the deployment?","options":["Development","Staging","Both"]}
- Multiple questions: {"questions":[{"question":"Which compatibility target is required?","options":["Current major only","Current and previous major"]},{"question":"May I add a dependency?","options":["Yes","No"]}]}
- Options may be omitted or empty, and a batch may contain plain question strings.

Complete the active workflow node:
- POST {{callback_base}}complete
- Body: {"summary":"What was completed and how it was verified.","handoff":"Useful context for the next workflow node.","outcome":"one allowed outcome","pull_requests":[{"repository":"repository-id","url":"https://github.com/owner/repository/pull/123"}]}

Complete review:
- POST {{callback_base}}complete
- Approved: {"summary":"Review result and any non-blocking findings.","outcome":"approved"}
- Changes requested: {"summary":"Blocking findings; PR comments were added.","outcome":"changes_requested"}
- Legacy V2 review callbacks accepted: {"summary":"Review result.","decision":"approved"} or {"summary":"Blocking findings.","decision":"changes_requested"}

Fail only when the phase cannot be completed or continued:
- POST {{callback_base}}fail
- Body: {"reason":"Why the work cannot continue."}

Before becoming idle, call ask if human input is required, complete if the phase is done, or fail if it cannot continue. A comment alone is not a terminal callback.`;

export const PRE_TYPED_OUTCOME_CALLBACK_REMINDER_DEFAULT = PRE_PROMPT_ENGINEERING_CALLBACK_REMINDER_DEFAULT
  .replace(" The earlier callback instructions may have been lost during context compaction. Allowed outcomes:\n{{allowed_outcomes}}\n\nSend", " Allowed outcomes: {{allowed_outcomes}}. The earlier callback instructions may have been lost during context compaction. Send")
  .replace(',"handoff":"Useful context for the next workflow node."', "");

export const PRE_V3_CALLBACK_REMINDER_DEFAULT = PRE_TYPED_OUTCOME_CALLBACK_REMINDER_DEFAULT
  .replace(" at workflow node {{node_name}} ({{node_id}})", "")
  .replace(" Allowed outcomes: {{allowed_outcomes}}.", "")
  .replace("Complete the active workflow node:", "Complete specification or implementation:")
  .replace(',"outcome":"one allowed outcome"', "")
  .replace(',"outcome":"approved"', ',"decision":"approved"')
  .replace(',"outcome":"changes_requested"', ',"decision":"changes_requested"')
  .replace('\n- Legacy V2 review callbacks accepted: {"summary":"Review result.","decision":"approved"} or {"summary":"Blocking findings.","decision":"changes_requested"}', "");

const CALLBACK_REMINDER_DEFAULT = `# Callback required

Ticket {{ticket_id}} is still leased for {{phase}} at workflow node **{{node_name}}** (\`{{node_id}}\`). Herdr became idle or done, but the tracker received no terminal callback. The earlier contract may have been lost during context compaction.

Allowed outcome IDs:

{{allowed_outcomes}}

Send one JSON request with \`Content-Type: application/json\`:

- Need human input, then stop: \`POST {{callback_base}}ask\`
  - \`{"question":"Focused question","options":["Optional suggestion"]}\`
  - or \`{"questions":[{"question":"First question","options":[]},{"question":"Second question","options":["A","B"]}]}\`
- Node complete: \`POST {{callback_base}}complete\`
  - \`{"outcome":"<exact allowed outcome ID>","summary":"Work performed, decisions, and verification.","handoff":"Actionable context for the next node.","pull_requests":[{"repository":"repository-id","url":"https://github.com/owner/repository/pull/123"}]}\`
- Cannot continue: \`POST {{callback_base}}fail\`
  - \`{"reason":"Concrete blocker or unrecoverable failure."}\`

Use \`summary\` as the durable record. Use \`handoff\` for information the next node must act on; omit it if none. A comment does not release this lease.`;

export const PRE_PROMPT_ENGINEERING_SPECIFICATION_DEFAULT = `${REPOSITORY_START_GUIDANCE}\n\nCreate or update the task specification in the primary repository. Commit and push it on the task branch you choose, then open or update an evolving draft PR. Complete with a summary and the primary repository PR URL.`;
export const PRE_PROMPT_ENGINEERING_IMPLEMENTATION_DEFAULT = `${REPOSITORY_START_GUIDANCE}\n\nImplement the ticket autonomously. You own repository inspection, Git branches, changes, verification, commits, pushes, and draft PRs. Complete with a summary and all known repository PR URLs.`;
export const PRE_PROMPT_ENGINEERING_REVIEW_DEFAULT = "Perform an independent review and add useful PR comments. Report approved or changes_requested. Do not repair the implementation; repairs return to the implementation conversation.";

const DEFAULTS: Record<PromptName, string> = {
  assignment: ASSIGNMENT_DEFAULT,
  specification: `${REPOSITORY_START_GUIDANCE}

Produce a decision-complete specification for the ticket. First inspect the ticket, repository conventions, existing task branch or PR, and incoming transition context. Ask focused questions early when an unresolved product or technical decision would materially change the design; do not guess around a consequential ambiguity.

Keep the specification proportional to the work. Define observable behavior, important constraints and decisions, repository impact, acceptance criteria, and a realistic verification approach. Do not turn the specification into a line-by-line implementation script, and do not implement the feature unless the ticket explicitly asks for that in this node.

Commit and push the specification on the ticket branch and open or update its evolving PR. Before completing, reread the ticket and confirm the specification resolves its acceptance criteria. Report the PR and use the callback summary for the durable result; use handoff for the implementation agent's most important constraints or open risks.`,
  implementation: `${REPOSITORY_START_GUIDANCE}

Deliver the ticket's requested behavior, not merely a plan or status report. Begin by reconciling the authoritative ticket, incoming transition context, existing task branch, PR discussion, and current repository state. On a repair loop, continue the existing branch and address the actual findings without discarding valid prior work.

Use your own planning and tools. Follow repository instructions and conventions, keep the change scoped, and make reasonable autonomous decisions. Ask focused questions only when human input is genuinely required to proceed safely.

Run the strongest practical verification available for the changed behavior, including the repository's documented verification entrypoint when one exists. Inspect the final diff, commit and push the work, and open or update the appropriate PRs. Complete only when the selected outcome description is true. In the callback summary, state what changed and the evidence used to verify it; use handoff for anything the reviewer or next node must specifically inspect or do.`,
  review: `Perform an independent, evidence-based review of the ticket and its reported PRs. Read the authoritative ticket, incoming handoff, applicable specification, repository instructions, full diff, and relevant tests. Verify important claims when practical instead of relying only on the implementation summary.

Prioritize correctness, regressions, security, data loss, operational risk, and missing acceptance criteria. Add actionable findings to the appropriate PR with enough detail for the implementation agent to repair them. Do not take over implementation or modify the branch in this review node.

Choose the exact approved outcome only when no blocking findings remain. If changes are required, choose the declared changes outcome, summarize the blocking findings, and put precise repair instructions in handoff so they are injected into the returning implementation assignment. Mention non-blocking observations clearly without presenting them as blockers.`,
  "postman-baseline": `${REPOSITORY_START_GUIDANCE}

Design a maintainable Postman collection that exercises the ticket's affected behavior and save it in the repository using the repository's conventions. Inspect the current non-production baseline and existing API assets before choosing coverage or structure. Execute the collection against the current non-production baseline before implementation, record the command, environment, and observed result, and distinguish existing failures from test-design problems.

Do not implement the product change in this node. Commit and push the collection and supporting files on the existing ticket branch. Ask focused questions if credentials, a safe target, or consequential API behavior is unknown. Complete with a durable summary of the baseline evidence and a handoff describing exactly how later validation should rerun the collection.`,
  "nonprod-validation": `Deploy the ticket branch to the appropriate non-production environment using the repository's documented process. Verify that the workload becomes healthy, then execute the repository's saved Postman collection against the deployment and investigate any regression from the recorded baseline.

Use your normal tools and judgment; this node intentionally leaves repository-specific deployment mechanics to you. If a deployment requires a human approval or other interactive decision, use the ask callback with clear options and wait rather than bypassing the control. Do not proceed past a failed deployment, unhealthy workload, or unexplained regression. Complete only when the declared success outcome is true, with concrete deployment and test evidence plus an actionable rollback handoff.`,
  "nonprod-rollback": `Roll back or remove the non-production deployment created for this ticket using the repository's documented process. Verify that the environment has returned to its intended baseline and that no ticket-specific resources or rollout are unintentionally left active.

Use the incoming handoff and current environment state rather than assuming a deployment command. Ask for human input when rollback requires approval or the safe target is ambiguous. Complete with concrete rollback evidence and any remaining operational risk.`,
  merge: `This node explicitly authorizes you to merge the ticket's approved GitHub pull request or pull requests. That authorization applies only inside this node and only while the preceding human approval remains applicable.

Before merging, reread the ticket and incoming approval context, inspect every relevant PR, confirm it is open and mergeable, confirm required checks and review protections pass, and ensure no newer human feedback or material change invalidates the approval. Use the repository's normal merge strategy. If any precondition is no longer true, do not merge: ask for human direction or fail with the concrete blocker. Never bypass branch protection or force a merge.

After merging, verify the resulting PR state and report the merged repository and PR URLs in the durable summary and handoff.`,
  "release-ticket": `Create the release ticket required by the team's delivery process using the authoritative work ticket, implementation PRs, validation evidence, and incoming handoff. Inspect repository or organizational conventions before deciding the destination, fields, links, rollout notes, and rollback information.

Do not invent missing release-critical details. Ask focused questions when a required value cannot be derived safely. Complete only after the release ticket exists, then include its identifier and URL, the material release details captured, and any remaining human action in the durable summary and handoff.`,
  guidance: "Human guidance for {{ticket_id}}: {{message}}\nReread the authoritative ticket before continuing.",
  "callback-reminder": CALLBACK_REMINDER_DEFAULT,
};

const TAGS: Record<string, TagDefinition> = {
  ticket_id: { name: "ticket_id", description: "Stable tracker or Jira ticket identifier.", example: "AGENT-0042" },
  phase: { name: "phase", description: "The durable work phase being assigned.", example: "implementation" },
  ticket_path: { name: "ticket_path", description: "Absolute path to the authoritative Markdown ticket on the supervisor host.", example: "/srv/tickets/AGENT-0042.md" },
  ticket_markdown: { name: "ticket_markdown", description: "Complete current Markdown ticket, including frontmatter and interaction history.", example: "---\nid: AGENT-0042\nwork_provider: claude\nreview_provider: codex\n...\n---\n\n# Goal\n\nAdd a health endpoint." },
  project_root: { name: "project_root", description: "Resolved supervisor project root used as the Herdr workspace working directory.", example: "/srv/agent-workspaces/supervisor-a" },
  phase_instructions: { name: "phase_instructions", description: "Rendered specification, implementation, or review prompt selected for the current phase.", example: "Implement the ticket autonomously..." },
  callback_base: { name: "callback_base", description: "Lease-fenced REST callback base for this assignment.", example: "http://tracker:4310/api/work/dummy-lease/" },
  message: { name: "message", description: "Durable operator guidance or the answer to an agent question.", example: "Keep compatibility with the previous major version." },
  node_id: { name: "node_id", description: "Stable node ID in the pinned workflow revision.", example: "deploy-nonprod" },
  node_name: { name: "node_name", description: "Human-readable workflow node name.", example: "Deploy to non-production" },
  allowed_outcomes: { name: "allowed_outcomes", description: "Declared callback outcome IDs, labels, and descriptions for the active agent node.", example: "- completed: Work completed — Continue to review.\n- blocked: Cannot continue — Human intervention is required." },
  incoming_outcome: { name: "incoming_outcome", description: "Outcome that transitioned into the active workflow node.", example: "changes_requested" },
  incoming_summary: { name: "incoming_summary", description: "Summary recorded by the preceding node run.", example: "Review found a rollback gap." },
  incoming_handoff: { name: "incoming_handoff", description: "Explicit context the preceding actor handed to this node.", example: "Document rollback and add the missing test." },
  incoming_node: { name: "incoming_node", description: "Workflow node that transitioned into the active node.", example: "independent-review" },
};

const COMMON_PHASE_TAGS = ["ticket_id", "phase", "ticket_path", "ticket_markdown", "project_root", "callback_base", "node_id", "node_name", "allowed_outcomes", "incoming_outcome", "incoming_summary", "incoming_handoff", "incoming_node"];
const DEFINITIONS: Record<PromptName, PromptDefinition> = {
  assignment: {
    name: "assignment", title: "Assignment envelope", purpose: "The complete message that starts or resumes one phase of ticket work.",
    trigger: "After a phase is claimed or recovered and the supervisor has attached the ticket's Herdr conversation. Wraps the matching phase prompt.",
    stages: ["Specification", "Implementation", "Review"],
    allowed_tags: [...COMMON_PHASE_TAGS, "phase_instructions"], required_tags: ["ticket_id", "phase", "ticket_path", "ticket_markdown", "phase_instructions", "callback_base"],
  },
  specification: {
    name: "specification", title: "Specification instructions", purpose: "Phase-specific instructions injected into the assignment envelope.",
    trigger: "Initial specification and every specification-feedback iteration.", stages: ["Specification", "Specification feedback"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  implementation: {
    name: "implementation", title: "Implementation instructions", purpose: "Phase-specific instructions injected into the assignment envelope.",
    trigger: "Initial implementation, review repairs, reopened tickets, and GitHub PR follow-up repairs.", stages: ["Implementation", "Review repair", "Reopen", "GitHub follow-up"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  review: {
    name: "review", title: "Review instructions", purpose: "Independent-review instructions injected into the assignment envelope.",
    trigger: "Initial Codex review and every re-review after implementation repairs.", stages: ["Review", "Re-review"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  "postman-baseline": {
    name: "postman-baseline", title: "Postman baseline", purpose: "Create API regression coverage and establish the pre-change non-production baseline.",
    trigger: "The End to End workflow after specification approval and before implementation.", stages: ["API test design", "Baseline capture"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  "nonprod-validation": {
    name: "nonprod-validation", title: "Non-production validation", purpose: "Deploy, verify workload health, and run regression coverage in non-production.",
    trigger: "The End to End workflow after independent review approval.", stages: ["Non-production deploy", "Health validation", "Regression test"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  "nonprod-rollback": {
    name: "nonprod-rollback", title: "Non-production rollback", purpose: "Return the non-production environment to its intended baseline.",
    trigger: "The End to End workflow after successful non-production validation.", stages: ["Non-production rollback"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  merge: {
    name: "merge", title: "Merge approved pull requests", purpose: "Authorize an agent to merge only after the workflow reaches an approved merge node.",
    trigger: "The Dev Only workflow after the human PR approval gate.", stages: ["Merge"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  "release-ticket": {
    name: "release-ticket", title: "Create release ticket", purpose: "Create the downstream release record from implementation and validation evidence.",
    trigger: "The End to End workflow after human code and testing approval.", stages: ["Release preparation"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  guidance: {
    name: "guidance", title: "Live guidance", purpose: "A follow-up message injected into an already-running ticket conversation.",
    trigger: "Operator guidance, answered agent questions, and live ticket edits that request a reread.", stages: ["Running", "Question answered", "Live edit"],
    allowed_tags: ["ticket_id", "message"], required_tags: ["message"],
  },
  "callback-reminder": {
    name: "callback-reminder", title: "Callback reminder", purpose: "A one-time reminder that semantic completion requires a callback.",
    trigger: "Herdr reports idle or done before complete, ask, or fail; suppressed while a question awaits an answer.", stages: ["Idle without callback", "Done without callback"],
    allowed_tags: ["ticket_id", "phase", "callback_base", "node_id", "node_name", "allowed_outcomes"], required_tags: [],
  },
};

const DUMMY_VALUES: Record<string, string> = Object.fromEntries(Object.values(TAGS).map((tag) => [tag.name, tag.example]));

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function placeholders(content: string): string[] { return [...content.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!.trim()); }

function genericDefinition(name: string): PromptDefinition {
  const title = name.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    name, title, purpose: "Reusable workflow-node instructions injected into the assignment envelope.",
    trigger: "Any agent node in a published workflow that references this prompt.", stages: ["Workflow agent node"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  };
}

function promptDefinition(name: string): PromptDefinition {
  return DEFINITIONS[name as PromptName] ?? genericDefinition(name);
}

export function renderPrompt(name: string, content: string, values: Record<string, string>): string {
  const definition = promptDefinition(name);
  if (!content.trim()) throw new HttpError(422, "Prompt content cannot be empty");
  const found = [...new Set(placeholders(content))];
  const unknown = found.filter((tag) => !/^[a-z0-9_]+$/.test(tag) || !definition.allowed_tags.includes(tag));
  const missing = definition.required_tags.filter((tag) => !found.includes(tag));
  const malformed = content.replaceAll(/\{\{[^{}]+\}\}/g, "").includes("{{") || content.replaceAll(/\{\{[^{}]+\}\}/g, "").includes("}}");
  if (unknown.length || missing.length || malformed) throw new HttpError(422, "Prompt metadata is invalid", [
    ...(unknown.length ? [`Unknown tags: ${unknown.join(", ")}`] : []),
    ...(missing.length ? [`Required tags missing: ${missing.join(", ")}`] : []),
    ...(malformed ? ["Malformed prompt tag"] : []),
  ]);
  let output = content.trim();
  for (const tag of found) {
    if (values[tag] === undefined) throw new HttpError(422, `No preview value is available for {{${tag}}}`);
    output = output.replaceAll(`{{${tag}}}`, values[tag]!);
  }
  return output;
}

export class PromptLibrary {
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private started: Promise<void> | null = null;

  constructor(root: string) { this.directory = join(resolve(root), "prompts"); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next;
  }

  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.serial(async () => {
      await mkdir(this.directory, { recursive: true });
      for (const name of PROMPT_NAMES) {
        const path = join(this.directory, `${name}.md`);
        try {
          const handle = await open(path, "wx", 0o600);
          try { await handle.writeFile(`${DEFAULTS[name].trim()}\n`); await handle.sync(); } finally { await handle.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      await mkdir(join(this.directory, ".versions"), { recursive: true });
      const olderDefaults: Partial<Record<PromptName, string[]>> = {
        assignment: [LEGACY_ASSIGNMENT_DEFAULT, BATCH_QUESTION_ASSIGNMENT_DEFAULT, PRE_PROJECT_ROOT_ASSIGNMENT_DEFAULT, PRE_V3_ASSIGNMENT_DEFAULT, PRE_TYPED_OUTCOME_ASSIGNMENT_DEFAULT, PRE_PROMPT_ENGINEERING_ASSIGNMENT_DEFAULT, PRE_MERGE_PROMPT_ASSIGNMENT_DEFAULT],
        specification: [PRE_BRANCH_SPECIFICATION_DEFAULT, PRE_PROMPT_ENGINEERING_SPECIFICATION_DEFAULT],
        implementation: [PRE_BRANCH_IMPLEMENTATION_DEFAULT, PRE_PROMPT_ENGINEERING_IMPLEMENTATION_DEFAULT],
        review: [PRE_PROMPT_ENGINEERING_REVIEW_DEFAULT],
        "callback-reminder": [PRE_CALLBACK_SCHEMA_REMINDER_DEFAULT, PRE_V3_CALLBACK_REMINDER_DEFAULT, PRE_TYPED_OUTCOME_CALLBACK_REMINDER_DEFAULT, PRE_PROMPT_ENGINEERING_CALLBACK_REMINDER_DEFAULT],
      };
      for (const [name, older] of Object.entries(olderDefaults) as [PromptName, string[]][]) {
        const path = join(this.directory, `${name}.md`);
        const current = await readFile(path, "utf8");
        if (!older.some((content) => current === `${content.trim()}\n`)) continue;
        const temporary = join(this.directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(`${DEFAULTS[name].trim()}\n`); await handle.sync(); } finally { await handle.close(); }
        try { await rename(temporary, path); }
        catch (error) { await rm(temporary, { force: true }); throw error; }
      }
      try { const directory = await open(this.directory, "r"); await directory.sync(); await directory.close(); } catch { /* not supported everywhere */ }
      for (const name of PROMPT_NAMES) {
        const content = await readFile(join(this.directory, `${name}.md`), "utf8");
        await this.archive(name, digest(content), content);
      }
    });
    return this.started;
  }

  private definition(name: string): PromptDefinition {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new HttpError(404, `Prompt ${name} not found`);
    return promptDefinition(name);
  }

  private async archive(name: string, revision: string, content: string): Promise<void> {
    const path = join(this.directory, ".versions", name, `${revision}.md`);
    try { await stat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    }
  }

  async get(name: string, revision?: string): Promise<PromptDocument> {
    await this.start();
    const definition = this.definition(name);
    if (revision && !/^[a-f0-9]{64}$/.test(revision)) throw new HttpError(422, "Prompt revision must be a SHA-256 digest");
    const path = revision
      ? join(this.directory, ".versions", definition.name, `${revision}.md`)
      : join(this.directory, `${definition.name}.md`);
    let content: string;
    try { content = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Prompt ${name}${revision ? `@${revision}` : ""} not found`);
      throw error;
    }
    let errors: string[] = [];
    try { renderPrompt(definition.name, content, DUMMY_VALUES); }
    catch (error) { errors = error instanceof HttpError && Array.isArray(error.details) ? error.details as string[] : [(error as Error).message]; }
    return { ...definition, content, revision: digest(content), tags: definition.allowed_tags.map((tag) => TAGS[tag]!), valid: errors.length === 0, errors };
  }

  async list(): Promise<PromptDocument[]> {
    await this.start();
    const discovered = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3)).sort();
    const names = [...PROMPT_NAMES, ...discovered.filter((name) => !PROMPT_NAMES.includes(name as PromptName))];
    return Promise.all(names.map((name) => this.get(name)));
  }

  async update(name: string, content: string, expectedRevision: string): Promise<PromptDocument> {
    await this.start();
    return this.serial(async () => {
      const definition = this.definition(name);
      renderPrompt(definition.name, content, DUMMY_VALUES);
      const path = join(this.directory, `${definition.name}.md`);
      let current: string;
      try { current = await readFile(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Prompt ${name} not found`); throw error; }
      if (digest(current) !== expectedRevision) throw new HttpError(409, "Prompt revision changed", await this.get(name));
      const normalized = `${content.trim()}\n`;
      const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(normalized); await handle.sync(); } finally { await handle.close(); }
      try {
        if (digest(await readFile(path, "utf8")) !== expectedRevision) throw new HttpError(409, "Prompt changed during update");
        await this.archive(name, expectedRevision, current);
        await rename(temporary, path);
        await this.archive(name, digest(normalized), normalized);
        try { const directory = await open(dirname(path), "r"); await directory.sync(); await directory.close(); } catch { /* not supported everywhere */ }
      } catch (error) { await rm(temporary, { force: true }); throw error; }
      return this.get(name);
    });
  }

  async create(name: string, content: string): Promise<PromptDocument> {
    await this.start();
    return this.serial(async () => {
      const definition = this.definition(name);
      renderPrompt(name, content, DUMMY_VALUES);
      const path = join(this.directory, `${definition.name}.md`);
      const normalized = `${content.trim()}\n`;
      try {
        const handle = await open(path, "wx", 0o600);
        try { await handle.writeFile(normalized); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, `Prompt ${name} already exists`);
        throw error;
      }
      await this.archive(name, digest(normalized), normalized);
      return this.get(name);
    });
  }

  async preview(name: string, content: string, phase: PreviewPhase = "implementation"): Promise<string> {
    await this.start();
    const definition = this.definition(name);
    const values = { ...DUMMY_VALUES, phase };
    if (definition.name !== "assignment" && definition.name !== "guidance" && definition.name !== "callback-reminder") {
      if (definition.name === "specification" || definition.name === "implementation" || definition.name === "review") values.phase = definition.name;
      const phaseInstructions = renderPrompt(definition.name, content, values);
      const assignment = await this.get("assignment");
      return renderPrompt("assignment", assignment.content, { ...values, phase_instructions: phaseInstructions });
    }
    if (definition.name === "assignment") {
      const phasePrompt = await this.get(phase);
      return renderPrompt("assignment", content, { ...values, phase_instructions: renderPrompt(phase, phasePrompt.content, values) });
    }
    return renderPrompt(definition.name, content, values);
  }
}
