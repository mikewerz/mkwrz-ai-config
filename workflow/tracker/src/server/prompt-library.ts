import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HttpError } from "./domain.js";

export const PROMPT_NAMES = ["assignment", "specification", "implementation", "review", "guidance", "callback-reminder"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];
export type PreviewPhase = "specification" | "implementation" | "review";

interface TagDefinition { name: string; description: string; example: string }
interface PromptDefinition {
  name: PromptName;
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

const ASSIGNMENT_DEFAULT = `You are assigned ticket {{ticket_id}} for the {{phase}} phase.

${PROJECT_ROOT_INSTRUCTION}

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

export const PRE_PROJECT_ROOT_ASSIGNMENT_DEFAULT = ASSIGNMENT_DEFAULT.replace(`\n\n${PROJECT_ROOT_INSTRUCTION}`, "");

export const PRE_BRANCH_SPECIFICATION_DEFAULT = "Create or update the task specification in the primary repository. Commit and push it on the task branch you choose, then open or update an evolving draft PR. Complete with a summary and the primary repository PR URL.";
export const PRE_BRANCH_IMPLEMENTATION_DEFAULT = "Implement the ticket autonomously. You own repository inspection, Git branches, changes, verification, commits, pushes, and draft PRs. Complete with a summary and all known repository PR URLs.";
export const PRE_CALLBACK_SCHEMA_REMINDER_DEFAULT = "The ticket is still leased because no callback was recorded. Submit complete, ask, or fail before ending this assignment.";

const REPOSITORY_START_GUIDANCE = `Before beginning new work in a repository, inspect its worktree, identify the remote default branch (normally main or master), switch to that branch, and pull or fast-forward it to the latest remote state before creating the task branch. If this is a feedback, repair, or other resumed iteration with an existing task branch or PR, continue that branch instead and integrate the latest default branch safely when appropriate. Preserve unrelated local changes; never reset or overwrite them.`;

const CALLBACK_REMINDER_DEFAULT = `Ticket {{ticket_id}} is still leased for {{phase}} because no terminal callback was recorded. The earlier callback instructions may have been lost during context compaction. Send an HTTP POST with Content-Type: application/json to one of the lease-fenced endpoints below, replacing example values with the real result.

Non-terminal note; continue working afterward:
- POST {{callback_base}}comment
- Body: {"message":"A concise progress note, decision, or useful context."}

Block for human input, then stop and wait. Questions may include any number of suggested options; the UI always permits a freeform answer:
- POST {{callback_base}}ask
- One question: {"question":"Which environment should receive the deployment?","options":["Development","Staging","Both"]}
- Multiple questions: {"questions":[{"question":"Which compatibility target is required?","options":["Current major only","Current and previous major"]},{"question":"May I add a dependency?","options":["Yes","No"]}]}
- Options may be omitted or empty, and a batch may contain plain question strings.

Complete specification or implementation:
- POST {{callback_base}}complete
- Body: {"summary":"What was completed and how it was verified.","pull_requests":[{"repository":"repository-id","url":"https://github.com/owner/repository/pull/123"}]}

Complete review:
- POST {{callback_base}}complete
- Approved: {"summary":"Review result and any non-blocking findings.","decision":"approved"}
- Changes requested: {"summary":"Blocking findings; PR comments were added.","decision":"changes_requested"}

Fail only when the phase cannot be completed or continued:
- POST {{callback_base}}fail
- Body: {"reason":"Why the work cannot continue."}

Before becoming idle, call ask if human input is required, complete if the phase is done, or fail if it cannot continue. A comment alone is not a terminal callback.`;

const DEFAULTS: Record<PromptName, string> = {
  assignment: ASSIGNMENT_DEFAULT,
  specification: `${REPOSITORY_START_GUIDANCE}\n\nCreate or update the task specification in the primary repository. Commit and push it on the task branch you choose, then open or update an evolving draft PR. Complete with a summary and the primary repository PR URL.`,
  implementation: `${REPOSITORY_START_GUIDANCE}\n\nImplement the ticket autonomously. You own repository inspection, Git branches, changes, verification, commits, pushes, and draft PRs. Complete with a summary and all known repository PR URLs.`,
  review: "Perform an independent review and add useful PR comments. Report approved or changes_requested. Do not repair the implementation; repairs return to the implementation conversation.",
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
};

const COMMON_PHASE_TAGS = ["ticket_id", "phase", "ticket_path", "ticket_markdown", "project_root", "callback_base"];
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
  guidance: {
    name: "guidance", title: "Live guidance", purpose: "A follow-up message injected into an already-running ticket conversation.",
    trigger: "Operator guidance, answered agent questions, and live ticket edits that request a reread.", stages: ["Running", "Question answered", "Live edit"],
    allowed_tags: ["ticket_id", "message"], required_tags: ["message"],
  },
  "callback-reminder": {
    name: "callback-reminder", title: "Callback reminder", purpose: "A one-time reminder that semantic completion requires a callback.",
    trigger: "Herdr reports idle or done before complete, ask, or fail; suppressed while a question awaits an answer.", stages: ["Idle without callback", "Done without callback"],
    allowed_tags: ["ticket_id", "phase", "callback_base"], required_tags: [],
  },
};

const DUMMY_VALUES: Record<string, string> = Object.fromEntries(Object.values(TAGS).map((tag) => [tag.name, tag.example]));

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function placeholders(content: string): string[] { return [...content.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!.trim()); }

export function renderPrompt(name: PromptName, content: string, values: Record<string, string>): string {
  const definition = DEFINITIONS[name];
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
      const olderDefaults: Partial<Record<PromptName, string[]>> = {
        assignment: [LEGACY_ASSIGNMENT_DEFAULT, BATCH_QUESTION_ASSIGNMENT_DEFAULT, PRE_PROJECT_ROOT_ASSIGNMENT_DEFAULT],
        specification: [PRE_BRANCH_SPECIFICATION_DEFAULT],
        implementation: [PRE_BRANCH_IMPLEMENTATION_DEFAULT],
        "callback-reminder": [PRE_CALLBACK_SCHEMA_REMINDER_DEFAULT],
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
    });
    return this.started;
  }

  private definition(name: string): PromptDefinition {
    if (!PROMPT_NAMES.includes(name as PromptName)) throw new HttpError(404, `Prompt ${name} not found`);
    return DEFINITIONS[name as PromptName];
  }

  async get(name: string): Promise<PromptDocument> {
    await this.start();
    const definition = this.definition(name);
    const content = await readFile(join(this.directory, `${definition.name}.md`), "utf8");
    let errors: string[] = [];
    try { renderPrompt(definition.name, content, DUMMY_VALUES); }
    catch (error) { errors = error instanceof HttpError && Array.isArray(error.details) ? error.details as string[] : [(error as Error).message]; }
    return { ...definition, content, revision: digest(content), tags: definition.allowed_tags.map((tag) => TAGS[tag]!), valid: errors.length === 0, errors };
  }

  async list(): Promise<PromptDocument[]> { return Promise.all(PROMPT_NAMES.map((name) => this.get(name))); }

  async update(name: string, content: string, expectedRevision: string): Promise<PromptDocument> {
    await this.start();
    return this.serial(async () => {
      const definition = this.definition(name);
      renderPrompt(definition.name, content, DUMMY_VALUES);
      const path = join(this.directory, `${definition.name}.md`);
      const current = await readFile(path, "utf8");
      if (digest(current) !== expectedRevision) throw new HttpError(409, "Prompt revision changed", await this.get(name));
      const normalized = `${content.trim()}\n`;
      const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(normalized); await handle.sync(); } finally { await handle.close(); }
      try {
        if (digest(await readFile(path, "utf8")) !== expectedRevision) throw new HttpError(409, "Prompt changed during update");
        await rename(temporary, path);
        try { const directory = await open(dirname(path), "r"); await directory.sync(); await directory.close(); } catch { /* not supported everywhere */ }
      } catch (error) { await rm(temporary, { force: true }); throw error; }
      return this.get(name);
    });
  }

  async preview(name: string, content: string, phase: PreviewPhase = "implementation"): Promise<string> {
    await this.start();
    const definition = this.definition(name);
    const values = { ...DUMMY_VALUES, phase };
    if (definition.name === "specification" || definition.name === "implementation" || definition.name === "review") {
      values.phase = definition.name;
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
