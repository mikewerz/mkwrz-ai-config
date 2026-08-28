import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HttpError } from "./domain.js";
import { artifactVersion } from "./artifact-versions.js";

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
  version: number;
  tags: TagDefinition[];
  valid: boolean;
  errors: string[];
}

const ASSIGNMENT_DEFAULT = `# Work assignment

You are assigned ticket {{ticket_id}} at workflow node **{{node_name}}** (\`{{node_id}}\`).

Your first action is to read the complete durable assignment at this exact path:

\`{{start_here_path}}\`

The assignment directory is \`{{assignment_directory}}\`. Repository work starts from \`{{project_root}}\`.

Use your normal tools, credentials, judgment, planning, and subagents. Work autonomously inside the current node. Before becoming idle, use the callback helper at this exact path to ask, complete, or fail:

\`{{callback_helper_path}}\`

Do not rely on this bootstrap message as the complete contract. The generated files contain the ticket, incoming handoff, node instructions, allowed outcomes, and callback schemas.`;

const REPOSITORY_START_GUIDANCE = `Before beginning new work in a repository, inspect its worktree, identify the remote default branch (normally main or master), switch to that branch, and pull or fast-forward it to the latest remote state before creating the task branch. If this is a feedback, repair, or other resumed iteration with an existing task branch or PR, continue that branch instead and integrate the latest default branch safely when appropriate. Preserve unrelated local changes; never reset or overwrite them.`;

const CALLBACK_REMINDER_DEFAULT = `# Callback required

Ticket {{ticket_id}} is still leased at workflow node **{{node_name}}** (\`{{node_id}}\`), but no terminal callback was received. The earlier paths may have been lost during context compaction.

Reread the durable assignment at this exact path:

\`{{start_here_path}}\`

Then use the callback helper at this exact path before becoming idle:

\`{{callback_helper_path}}\`

Run \`{{callback_helper_path}} schema complete\` to recover the completion payload contract and allowed outcome example. The full callback documentation is in \`{{assignment_directory}}/callbacks.md\`.`;

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
  guidance: `# Assignment update

New durable guidance for {{ticket_id}} was written to:

\`{{update_path}}\`

Read that file, then reread \`{{start_here_path}}\` and the refreshed \`{{assignment_directory}}/ticket.md\` before continuing. The callback helper remains \`{{callback_helper_path}}\`.`,
  "callback-reminder": CALLBACK_REMINDER_DEFAULT,
};

const TAGS: Record<string, TagDefinition> = {
  ticket_id: { name: "ticket_id", description: "Stable tracker or Jira ticket identifier.", example: "AGENT-0042" },
  phase: { name: "phase", description: "The durable work phase being assigned.", example: "implementation" },
  ticket_path: { name: "ticket_path", description: "Absolute path to the authoritative Markdown ticket on the supervisor host.", example: "/srv/tickets/AGENT-0042.md" },
  ticket_markdown: { name: "ticket_markdown", description: "Complete current Markdown ticket, including its pinned workflow runtime and interaction history.", example: "---\nid: AGENT-0042\nworkflow:\n  id: standard-delivery\n  current_node: implementation\n...\n---\n\n# Goal\n\nAdd a health endpoint." },
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
  incoming_output: { name: "incoming_output", description: "Configured tail of the preceding script or merged branch outputs.", example: "Deployment completed successfully." },
  incoming_output_log: { name: "incoming_output_log", description: "Absolute tracker URL for the complete preceding script output artifact, when persisted.", example: "http://tracker:4310/api/tickets/AGENT-0042/runs/dummy-run/output" },
  assignment_directory: { name: "assignment_directory", description: "Absolute supervisor-local directory containing the active durable node-run bundle.", example: "/srv/agentic-assignments/worker-a/tickets/AGENT-0042/runs/0001-implementation-dummy-run" },
  start_here_path: { name: "start_here_path", description: "Absolute path to START_HERE.md for the active node run.", example: "/srv/agentic-assignments/worker-a/tickets/AGENT-0042/runs/0001-implementation-dummy-run/START_HERE.md" },
  callback_helper_path: { name: "callback_helper_path", description: "Absolute path to the generated lease-aware callback helper.", example: "/srv/agentic-assignments/worker-a/tickets/AGENT-0042/runs/0001-implementation-dummy-run/callback" },
  update_path: { name: "update_path", description: "Absolute path to a newly persisted guidance or question-answer update.", example: "/srv/agentic-assignments/worker-a/tickets/AGENT-0042/runs/0001-implementation-dummy-run/updates/00000042-guidance.md" },
};

const COMMON_PHASE_TAGS = ["ticket_id", "phase", "ticket_path", "ticket_markdown", "project_root", "callback_base", "node_id", "node_name", "allowed_outcomes", "incoming_outcome", "incoming_summary", "incoming_handoff", "incoming_node", "incoming_output", "incoming_output_log"];
const DEFINITIONS: Record<PromptName, PromptDefinition> = {
  assignment: {
    name: "assignment", title: "Assignment bootstrap", purpose: "The small message that points an agent to its durable node-run bundle.",
    trigger: "After a node is claimed or recovered and the supervisor has written the complete assignment bundle.",
    stages: ["Specification", "Implementation", "Review"],
    allowed_tags: [...COMMON_PHASE_TAGS, "phase_instructions", "assignment_directory", "start_here_path", "callback_helper_path"],
    required_tags: ["ticket_id", "start_here_path", "callback_helper_path"],
  },
  specification: {
    name: "specification", title: "Specification instructions", purpose: "Phase-specific instructions written into the durable node.md assignment file.",
    trigger: "Initial specification and every specification-feedback iteration.", stages: ["Specification", "Specification feedback"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  implementation: {
    name: "implementation", title: "Implementation instructions", purpose: "Phase-specific instructions written into the durable node.md assignment file.",
    trigger: "Initial implementation, review repairs, reopened tickets, and GitHub PR follow-up repairs.", stages: ["Implementation", "Review repair", "Reopen", "GitHub follow-up"],
    allowed_tags: COMMON_PHASE_TAGS, required_tags: [],
  },
  review: {
    name: "review", title: "Review instructions", purpose: "Independent-review instructions written into the durable node.md assignment file.",
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
    allowed_tags: ["ticket_id", "message", "assignment_directory", "start_here_path", "callback_helper_path", "update_path"],
    required_tags: ["update_path", "start_here_path", "callback_helper_path"],
  },
  "callback-reminder": {
    name: "callback-reminder", title: "Callback reminder", purpose: "A one-time reminder that semantic completion requires a callback.",
    trigger: "Herdr reports idle or done before complete, ask, or fail; suppressed while a question awaits an answer.", stages: ["Idle without callback", "Done without callback"],
    allowed_tags: ["ticket_id", "phase", "callback_base", "node_id", "node_name", "allowed_outcomes", "assignment_directory", "start_here_path", "callback_helper_path"],
    required_tags: ["start_here_path", "callback_helper_path"],
  },
};

const DUMMY_VALUES: Record<string, string> = Object.fromEntries(Object.values(TAGS).map((tag) => [tag.name, tag.example]));

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function placeholders(content: string): string[] { return [...content.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!.trim()); }

function genericDefinition(name: string): PromptDefinition {
  const title = name.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    name, title, purpose: "Reusable workflow-node instructions written into the durable node.md assignment file.",
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
    const revisionId = digest(content);
    await this.archive(definition.name, revisionId, content);
    return { ...definition, content, revision: revisionId, version: await artifactVersion(this.directory, definition.name, revisionId), tags: definition.allowed_tags.map((tag) => TAGS[tag]!), valid: errors.length === 0, errors };
  }

  async validate(name: string, content: string): Promise<void> {
    await this.start();
    const definition = this.definition(name);
    renderPrompt(definition.name, content, DUMMY_VALUES);
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

  async restore(name: string, expectedRevision: string): Promise<PromptDocument> {
    if (!PROMPT_NAMES.includes(name as PromptName)) throw new HttpError(409, `Prompt ${name} has no built-in default`);
    return this.update(name, DEFAULTS[name as PromptName], expectedRevision);
  }

  async restoreAll(): Promise<PromptDocument[]> {
    const output: PromptDocument[] = [];
    for (const name of PROMPT_NAMES) {
      const current = await this.get(name);
      const normalizedDefault = `${DEFAULTS[name].trim()}\n`;
      output.push(current.content === normalizedDefault ? current : await this.update(name, normalizedDefault, current.revision));
    }
    return output;
  }

  async preview(name: string, content: string, phase: PreviewPhase = "implementation"): Promise<string> {
    await this.start();
    const definition = this.definition(name);
    const values = { ...DUMMY_VALUES, phase };
    if (definition.name !== "assignment" && definition.name !== "guidance" && definition.name !== "callback-reminder") {
      if (definition.name === "specification" || definition.name === "implementation" || definition.name === "review") values.phase = definition.name;
      const phaseInstructions = renderPrompt(definition.name, content, values);
      const assignment = await this.get("assignment");
      return `${renderPrompt("assignment", assignment.content, { ...values, phase_instructions: phaseInstructions })}\n\n---\n\n# Durable node.md preview\n\n${phaseInstructions}`;
    }
    if (definition.name === "assignment") {
      const phasePrompt = await this.get(phase);
      const phaseInstructions = renderPrompt(phase, phasePrompt.content, values);
      return `${renderPrompt("assignment", content, { ...values, phase_instructions: phaseInstructions })}\n\n---\n\n# Durable node.md preview\n\n${phaseInstructions}`;
    }
    return renderPrompt(definition.name, content, values);
  }
}
