import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { parse, stringify } from "yaml";
import { api, type Execution, type HarnessTelemetryRecord, type IntakeCampaign, type IntakeLimits, type IntakeOverview, type IntakeSource, type MetricsReport, type NumberSummary, type OperationalStatus, type PromptDocument, type QuotaReport, type RepositoryClaimBlocker, type RepositoryConfig, type RuntimeAgent, type SupervisorHealth, type TicketDetail, type TicketFrontmatter, type TicketSummary, type TokenUsage, type TrackerConfig, type WorkflowComparisonReport, type WorkflowDocument, type WorkflowNode, type WorkflowReleaseCatalog } from "./api.js";

const LOG_START = "<!-- tracker:interaction-log:start -->";
const LOG_END = "<!-- tracker:interaction-log:end -->";
const THEMES = ["light", "dark", "retro"] as const;
type Theme = (typeof THEMES)[number];
const APP_VIEWS = ["attention", "tickets", "intake", "metrics", "supervisors", "configuration", "prompts", "workflows"] as const;
type AppView = (typeof APP_VIEWS)[number];
type WorkProvider = "claude" | "codex";
const ALL_WORK_PROVIDERS: WorkProvider[] = ["claude", "codex"];
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
type WorkflowInlineLanguage = NonNullable<WorkflowNode["inline"]>["language"];

const SCRIPT_ENVIRONMENT_VARIABLES = [
  ["AGENTIC_TICKET_ID", "Stable ticket identifier."],
  ["AGENTIC_TICKET_PATH", "Absolute path to the authoritative Markdown ticket."],
  ["AGENTIC_PROJECT_ROOT", "Absolute project root assigned to this supervisor."],
  ["AGENTIC_SCRIPT_PATH", "Absolute resolved script path; empty for inline code."],
  ["AGENTIC_WORKING_DIRECTORY", "Absolute configured process working directory."],
  ["AGENTIC_NODE_ID", "Workflow node identifier."],
  ["AGENTIC_NODE_NAME", "Human-readable workflow node name."],
  ["AGENTIC_NODE_RUN_ID", "Identifier for this node execution."],
  ["AGENTIC_WORKFLOW_NODE_TYPE", "Current node type; script for inline activities."],
  ["AGENTIC_ATTEMPT", "Current lease attempt number."],
  ["AGENTIC_WORKFLOW_ID", "Pinned workflow identifier."],
  ["AGENTIC_WORKFLOW_REVISION", "Pinned workflow revision."],
  ["AGENTIC_WORKFLOW_PHASE", "Operational ticket phase projected by the current node."],
  ["AGENTIC_REPOSITORY_ID", "Selected repository identifier."],
  ["AGENTIC_REPOSITORY_PATH", "Absolute path to the selected repository."],
  ["AGENTIC_PRIMARY_REPOSITORY_ID", "Primary repository identifier."],
  ["AGENTIC_PRIMARY_REPOSITORY_PATH", "Absolute path to the primary repository."],
  ["AGENTIC_CURRENT_BRANCH", "Selected repository's current branch, when detected."],
  ["AGENTIC_DEFAULT_BRANCH", "Selected repository's default branch, when detected."],
  ["AGENTIC_HEAD_SHA", "Selected repository's current HEAD SHA, when detected."],
  ["AGENTIC_REMOTE_URL", "Selected repository's origin URL, when configured."],
  ["AGENTIC_REPOSITORIES_JSON", "JSON array containing every ticket repository and its Git metadata."],
  ["AGENTIC_PULL_REQUESTS_JSON", "JSON array containing every ticket pull-request association."],
  ["AGENTIC_CONTEXT_JSON", "JSON object containing the complete script execution context."],
  ["AGENTIC_INCOMING_NODE", "Source node from the preceding transition."],
  ["AGENTIC_INCOMING_OUTCOME", "Outcome selected by the preceding transition."],
  ["AGENTIC_INCOMING_SUMMARY", "Summary supplied by the preceding node."],
  ["AGENTIC_INCOMING_HANDOFF", "Next-step handoff supplied by the preceding node."],
  ["AGENTIC_INCOMING_OUTPUT", "Configured stdout tail supplied by the preceding script node."],
  ["AGENTIC_INCOMING_OUTPUT_LOG", "Tracker API path for the preceding script node's persisted stdout."],
  ["AGENTIC_RESULT_PATH", "Write optional structured JSON metadata and external references here before exit."],
] as const;

function inlineEnvironmentHeader(language: WorkflowInlineLanguage): string {
  const comment = language === "javascript" ? "//" : "#";
  return [
    `${comment} Available workflow environment variables (a value may be empty):`,
    ...SCRIPT_ENVIRONMENT_VARIABLES.map(([name, description]) => `${comment} ${name} - ${description}`),
    `${comment}`,
    `${comment} Only AGENTIC_* variables are part of the workflow contract. The inherited`,
    `${comment} process environment may contain supervisor credentials and should not be dumped.`,
  ].join("\n");
}

const INLINE_CODE_SAMPLES: Record<WorkflowInlineLanguage, string> = {
  shell: `${inlineEnvironmentHeader("shell")}
set -eu

env | awk -F= '$1 ~ /^AGENTIC_/ { print }' | sort

# Optional structured result example:
# printf '%s\n' '{"metadata":{"deployment.id":"example"},"external_references":[]}' > "$AGENTIC_RESULT_PATH"
`,
  python: `${inlineEnvironmentHeader("python")}
import json
import os

agentic_env = {
    name: value
    for name, value in os.environ.items()
    if name.startswith("AGENTIC_")
}
print(json.dumps(agentic_env, indent=2, sort_keys=True))

# Optional structured result example:
# with open(os.environ["AGENTIC_RESULT_PATH"], "w", encoding="utf-8") as result_file:
#     json.dump({"metadata": {"deployment.id": "example"}, "external_references": []}, result_file)
`,
  javascript: `${inlineEnvironmentHeader("javascript")}
const agenticEnv = Object.fromEntries(
  Object.entries(process.env)
    .filter(([name]) => name.startsWith("AGENTIC_"))
    .sort(([left], [right]) => left.localeCompare(right)),
);

console.log(JSON.stringify(agenticEnv, null, 2));

// Optional structured result example:
// const { writeFileSync } = await import("node:fs");
// writeFileSync(process.env.AGENTIC_RESULT_PATH,
//   JSON.stringify({ metadata: { "deployment.id": "example" }, external_references: [] }));
`,
};

function defaultInlineCode(language: WorkflowInlineLanguage): string {
  return INLINE_CODE_SAMPLES[language];
}

function isDefaultInlineCode(code: string): boolean {
  return Object.values(INLINE_CODE_SAMPLES).includes(code);
}

function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem("agentic-project-tracker.theme");
    return THEMES.includes(value as Theme) ? value as Theme : "dark";
  } catch { return "dark"; }
}

function storedValue<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value) as T;
  } catch { return fallback; }
}

function useStoredState<T>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => storedValue(key, fallback));
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be disabled */ }
  }, [key, value]);
  return [value, setValue];
}

function storedAppView(): AppView {
  const value = storedValue<string>("agentic-project-tracker.view", "tickets");
  return APP_VIEWS.includes(value as AppView) ? value as AppView : "tickets";
}

function isInitialDraft(ticket: TicketFrontmatter): boolean {
  return ticket.status === "pending";
}

interface TicketDraft {
  id: string;
  autoId: boolean;
  title: string;
  description: string;
  priority: number;
  estimatedHumanDays: number | null;
  labels: string;
  repositories: Array<{ id: string; primary: boolean }>;
  jira: TicketFrontmatter["jira"];
  workflowId: string;
  workflowRevision: string;
  workflowInputs: Record<string, boolean | string>;
  stageEnabled: Record<string, boolean>;
  attachmentFiles: File[];
}

const emptyDraft = (id = "AGENT-0001", autoId = true): TicketDraft => ({
    id, autoId, title: "Describe the work", description: "# Goal\n\nDescribe the desired outcome.\n\n# Acceptance Criteria\n\n- Add an observable acceptance criterion.",
    priority: 0, estimatedHumanDays: null, labels: "",
    repositories: [{ id: "", primary: true }], jira: null, workflowId: "standard-delivery", workflowRevision: "", workflowInputs: {}, stageEnabled: {}, attachmentFiles: [],
});

function fallbackWorkflowReleases(workflows: WorkflowDocument[]): WorkflowReleaseCatalog {
  return {
    catalog: { version: 1, revision: 1, updated_at: new Date(0).toISOString(), default_workflow_id: workflows.some((item) => item.definition.id === "standard-delivery") ? "standard-delivery" : workflows[0]?.definition.id ?? "standard-delivery", workflows: Object.fromEntries(workflows.map((item) => [item.definition.id, { default_revision: item.revision }])) },
    releases: workflows.map((workflow) => ({
      workflow_id: workflow.definition.id, revision: workflow.revision, version: workflow.version, label: `v${workflow.version}`,
      status: "active" as const, published_at: new Date(0).toISOString(), parent_revision: null, is_default: true, definition: workflow.definition,
    })),
  };
}

function draftErrors(draft: TicketDraft): string[] {
  const errors: string[] = [];
  if (!draft.id.trim()) errors.push("Ticket ID is required.");
  if (!draft.title.trim()) errors.push("Title is required.");
  if (!draft.description.trim()) errors.push("Description is required.");
  if (draft.estimatedHumanDays !== null && (!Number.isFinite(draft.estimatedHumanDays) || draft.estimatedHumanDays < 0)) errors.push("Estimated human days must be a non-negative number.");
  if (draft.repositories.length === 0) errors.push("Add at least one repository.");
  if (draft.repositories.some((repository) => !repository.id.trim())) errors.push("Every repository needs a name.");
  if (draft.repositories.filter((repository) => repository.primary).length !== 1) errors.push("Choose exactly one primary repository.");
  const repositories = draft.repositories.map((repository) => repository.id.trim()).filter(Boolean);
  if (new Set(repositories).size !== repositories.length) errors.push("Repository names must be unique.");
  if (draft.attachmentFiles.some((file) => file.size > MAX_ATTACHMENT_BYTES)) errors.push("Each attachment must be 25 MB or smaller.");
  return errors;
}

function descriptionFromBody(body: string): string {
  const marker = body.indexOf("## Interaction Log");
  return (marker === -1 ? body : body.slice(0, marker)).trim();
}

function interactionLogSection(body: string): string {
  const marker = body.indexOf("## Interaction Log");
  return marker === -1 ? `## Interaction Log\n\n${LOG_START}\n${LOG_END}\n` : body.slice(marker).trimEnd() + "\n";
}

function draftFromTicket(ticket: TicketDetail): TicketDraft {
  const frontmatter = ticket.frontmatter;
  if (!frontmatter) return { ...emptyDraft(), description: ticket.markdown };
  return {
    id: frontmatter.id, autoId: false, title: frontmatter.title,
    description: descriptionFromBody(ticket.body),
    priority: frontmatter.priority, estimatedHumanDays: frontmatter.estimated_human_days ?? null, labels: frontmatter.labels.join(", "),
    repositories: frontmatter.repositories.map((repository) => ({ ...repository })), jira: frontmatter.jira,
    workflowId: frontmatter.workflow?.id ?? "standard-delivery",
    workflowRevision: frontmatter.workflow_assignment?.revision ?? frontmatter.workflow?.revision ?? "",
    workflowInputs: { ...(frontmatter.workflow?.inputs ?? {}) }, stageEnabled: { ...(frontmatter.workflow?.stage_enabled ?? {}) }, attachmentFiles: [],
  };
}

function ticketMarkdown(draft: TicketDraft, current?: TicketDetail): string {
  const editable = {
    id: draft.id.trim(), title: draft.title.trim(),
    priority: Number(draft.priority) || 0,
    estimated_human_days: draft.estimatedHumanDays,
    labels: draft.labels.split(",").map((label) => label.trim()).filter(Boolean),
    repositories: draft.repositories.map((repository) => ({ id: repository.id.trim(), primary: repository.primary })),
    jira: draft.jira,
  };
  const frontmatter = current?.frontmatter ? {
    ...current.frontmatter, ...editable,
    ...(current.frontmatter.workflow ? { workflow: { ...current.frontmatter.workflow, inputs: draft.workflowInputs, stage_enabled: draft.stageEnabled } } : {}),
  } : editable;
  const body = current ? `${draft.description.trim()}\n\n${interactionLogSection(current.body)}` : `${draft.description.trim()}\n`;
  return `---\n${stringify(frontmatter, { lineWidth: 0, nullStr: "null" }).trimEnd()}\n---\n${body}`;
}

function humanize(value: string): string {
  return value.replaceAll(/[_./-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function releaseDisplayLabel(release: Pick<WorkflowReleaseCatalog["releases"][number], "version" | "label" | "is_default" | "status">): string {
  const version = `v${release.version}`;
  const label = release.label.trim();
  const distinctLabel = label && label.toLowerCase() !== version.toLowerCase() ? ` · ${label}` : "";
  const role = release.is_default ? "Default revision" : release.status === "trial" ? "Trial revision" : "Revision";
  return `${role} ${version}${distinctLabel}`;
}

function useCompactNavigation(): boolean {
  const query = "(max-width: 980px)";
  const [compact, setCompact] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return compact;
}

function resolvedWorkflowProvider(ticket: TicketFrontmatter, node: WorkflowNode | undefined): string | null {
  if (!node || node.type !== "agent") return null;
  const profiles = ticket.workflow?.resolved_agent_profiles ?? {};
  const workflowId = ticket.workflow?.active_workflow_id ?? ticket.workflow?.id;
  return workflowId ? profiles[`${workflowId}/${node.id}`]?.provider ?? null : null;
}

function duration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function timeAgo(timestamp: string | null | undefined, now: number): string {
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return "never";
  return `${duration(now - Date.parse(timestamp))} ago`;
}

function relativeTime(timestamp: string | null | undefined, now: number): string {
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return "unknown";
  const delta = Date.parse(timestamp) - now;
  return delta >= 0 ? `in ${duration(delta)}` : `${duration(-delta)} ago`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusPill({ value, subtle = false, label }: { value: string; subtle?: boolean; label?: string }) {
  return <span className={`status-pill status-${value} ${subtle ? "subtle" : ""}`}><i />{label ?? humanize(value)}</span>;
}

function NextActionSummary({ ticket, workflow }: { ticket: TicketFrontmatter; workflow: WorkflowDocument["definition"] }) {
  if (!ticket.workflow) return null;
  const current = workflow.nodes.find((node) => node.id === ticket.workflow?.current_node);
  if (!current) return null;
  const pendingQuestions = ticket.questions.filter((question) => question.answer === null).length;
  const productionResult = ticket.production_result ?? "unassessed";
  const targetFor = (targetId: string | undefined): string | null => {
    const target = workflow.nodes.find((node) => node.id === targetId);
    if (!target) return null;
    const provider = resolvedWorkflowProvider(ticket, target);
    return provider ? `${target.name} starts with ${humanize(provider)}` : target.name;
  };
  let parts: string[];
  if (pendingQuestions > 0) parts = ["Waiting for you", `Answer ${pendingQuestions} agent question${pendingQuestions === 1 ? "" : "s"}`, `${current.name} resumes`];
  else if (ticket.status === "waiting_approval" && current.type === "human_gate") {
    const approval = current.choices.find((choice) => choice.id === "approved" || /approve/i.test(choice.label)) ?? current.choices[0];
    parts = ["Waiting for you", current.name, targetFor(approval?.target) ?? "Choose a workflow path"];
  } else if (ticket.status === "running") parts = [`${ticket.execution?.provider ? humanize(ticket.execution.provider) : "Supervisor"} working`, current.name, "Agent callback selects the next path"];
  else if (ticket.status === "ready") parts = ["Waiting for a supervisor", current.name, resolvedWorkflowProvider(ticket, current) ? `Starts with ${humanize(resolvedWorkflowProvider(ticket, current)!)} when capacity is available` : "Runs when capacity is available"];
  else if (ticket.status === "waiting_external") {
    const wait = Object.values(ticket.workflow.wait_states ?? {}).filter((candidate) => candidate.node_id === current.id).sort((left, right) => right.attempt - left.attempt || right.started_at.localeCompare(left.started_at))[0];
    parts = ["Waiting on an external condition", wait ? `Check resumes ${new Date(wait.wake_at).toLocaleString()}` : current.name, targetFor(current.next) ?? "Workflow continues after the check"];
  } else if (ticket.status === "blocked" || ticket.status === "failed") parts = ["Waiting for you", `Review ${humanize(ticket.status)} node`, `Retry ${current.name}`];
  else if (ticket.status === "completed") parts = ["Workflow complete", "Review the execution recap", productionResult === "unassessed" ? "Record the production outcome or archive" : `Production marked ${humanize(productionResult)}`];
  else if (ticket.status === "pending") parts = ["Draft ticket", "Review and mark ready", `${current.name} becomes eligible`];
  else parts = [humanize(ticket.status), current.name];
  return <div className="next-action-summary" aria-label="What happens next">{parts.map((part, index) => <React.Fragment key={`${index}:${part}`}>{index > 0 && <span aria-hidden="true">→</span>}<strong>{part}</strong></React.Fragment>)}</div>;
}

function WorkflowMap({ ticket, workflow }: { ticket: TicketFrontmatter; workflow: WorkflowDocument["definition"] | undefined }) {
  const [storedZoom, setStoredZoom] = useStoredState("agentic-project-tracker.graph.zoom", 1);
  const zoom = Number.isFinite(storedZoom) ? clampGraphZoom(storedZoom) : 1;
  if (ticket.workflow && workflow) return <section className="workflow-panel" aria-label="Ticket workflow">
    <div className="section-heading"><div><h2>Workflow · {workflow.name} · v{ticket.workflow_assignment?.version ?? 1}</h2></div><div className="workflow-heading-actions"><div className="graph-zoom" role="group" aria-label="Workflow zoom"><button aria-label="Zoom out" disabled={zoom <= GRAPH_ZOOM_MIN} onClick={() => setStoredZoom(clampGraphZoom(zoom - GRAPH_ZOOM_STEP))}>−</button><button aria-label="Reset zoom" onClick={() => setStoredZoom(1)}>{Math.round(zoom * 100)}%</button><button aria-label="Zoom in" disabled={zoom >= GRAPH_ZOOM_MAX} onClick={() => setStoredZoom(clampGraphZoom(zoom + GRAPH_ZOOM_STEP))}>＋</button></div></div></div>
    <NextActionSummary ticket={ticket} workflow={workflow} />
    <WorkflowGraph workflow={workflow} currentNode={ticket.workflow.current_node} ticket={ticket} zoom={zoom} />
    <div className="workflow-loops"><span>{ticket.workflow.transition_count} / {workflow.max_transitions} transitions</span><span>{ticket.workflow.node_runs.length} durable node runs</span></div>
  </section>;
  return <section className="workflow-panel" aria-label="Ticket workflow"><p className="muted">This ticket has no loadable pinned workflow.</p></section>;
}

function PendingQuestions({ questions, answers, busy, now, onChange, onAnswer }: {
  questions: TicketFrontmatter["questions"];
  answers: Record<string, string>;
  busy: boolean;
  now: number;
  onChange: (questionId: string, answer: string) => void;
  onAnswer: (questionId: string) => void;
}) {
  const pending = questions.filter((question) => !question.answer);
  if (!pending.length) return null;
  return <section className="pending-questions-card" aria-label="Agent questions">
    <header className="pending-questions-heading">
      <div className="question-symbol" aria-hidden="true">?</div>
      <div><span>Action required</span><h2>Agent needs your input</h2><p>Your response is saved to the ticket and delivered back to the active workflow conversation.</p></div>
      <strong>{pending.length} pending</strong>
    </header>
    <div className="pending-question-list">{pending.map((question, questionIndex) => {
      const answer = answers[question.id] ?? "";
      return <article className="pending-question" key={question.id}>
        <div className="pending-question-meta"><span>{pending.length > 1 ? `Question ${questionIndex + 1}` : "Question"} · {humanize(question.phase)}</span><time dateTime={question.asked_at}>Asked {timeAgo(question.asked_at, now)}</time></div>
        <div className="pending-question-copy"><MarkdownContent markdown={question.question} /></div>
        {(question.options ?? []).length > 0 && <div className="suggested-answer-group"><span>Suggested answers</span><div className="question-options">{question.options.map((option, index) => <button
          type="button" className={answer === option ? "selected" : ""} aria-pressed={answer === option}
          key={`${index}:${option}`} onClick={() => onChange(question.id, option)}
        ><i aria-hidden="true" />{option}</button>)}</div></div>}
        <label className="question-response"><span>Your response</span><textarea aria-label={`Answer: ${question.question}`} placeholder="Write a response or choose an option above…" value={answer} onChange={(event) => onChange(question.id, event.target.value)} /></label>
        <footer><small>Freeform answers are always accepted.</small><button className="button-primary" disabled={busy || !answer.trim()} onClick={() => onAnswer(question.id)}>Send response</button></footer>
      </article>;
    })}</div>
  </section>;
}

function AnsweredQuestions({ questions }: { questions: TicketFrontmatter["questions"] }) {
  const answered = questions.filter((question) => question.answer);
  if (!answered.length) return null;
  return <section className="side-card" aria-label="Question history"><div className="section-heading"><div><span>Conversation</span><h2>Question history</h2></div></div>{answered.map((question) => <div className="question-item" key={question.id}><strong>{question.question}</strong><p>{question.answer}</p></div>)}</section>;
}

function AgentSessions({ ticket, workflow, onReset }: { ticket: TicketFrontmatter; workflow?: WorkflowDocument["definition"]; onReset?: (key: string) => void }) {
  if (ticket.workflow && workflow) {
    const conversations = Object.entries(ticket.conversations ?? {});
    return <section className="side-card" aria-label="Agent sessions">
      <div className="section-heading"><div><span>Conversations</span><h2>Agent sessions</h2></div></div>
      {conversations.length ? conversations.map(([key, conversation]) => {
        const nodes = workflow.nodes.filter((node) => node.type === "agent" && node.conversation_key === key).map((node) => node.name);
        const policies = [...new Set(workflow.nodes.filter((node) => node.type === "agent" && node.conversation_key === key).map((node) => node.conversation_policy ?? "resume"))];
        return <div className="session-item" key={key}><span>{humanize(key)}</span><strong>{conversation.provider ? humanize(conversation.provider) : "Unassigned"}</strong><small className="session-context">{nodes.join(" · ") || "Workflow conversation"}</small><small>Generation {conversation.generation ?? 1} · {policies.map(humanize).join(" / ")}{conversation.visits_in_generation !== undefined ? ` · ${conversation.visits_in_generation} visits` : ""}</small>{conversation.reset_reason && <small className="session-context">Last reset: {humanize(conversation.reset_reason)}</small>}{conversation.herdr_pane_id && <small>{conversation.herdr_pane_id}</small>}{conversation.session_ref && <code>{conversation.session_ref}</code>}{onReset && !ticket.execution && <button className="button-secondary button-compact" onClick={() => onReset(key)}>Start fresh next visit</button>}</div>;
      }) : <p className="muted">No agent conversation has started.</p>}
    </section>;
  }
  return <section className="side-card" aria-label="Agent sessions">
    <div className="section-heading"><div><span>Conversations</span><h2>Agent sessions</h2></div></div>
    <p className="muted">No workflow conversation is available.</p>
  </section>;
}

function inlineMarkdown(text: string): React.ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return token;
  });
}

function MarkdownContent({ markdown }: { markdown: string }) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const output: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim(); const code: string[] = []; index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) { code.push(lines[index]!); index += 1; }
      index += 1; output.push(<pre key={`pre-${index}`} data-language={language}><code>{code.join("\n")}</code></pre>); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length + 1, 6); const Heading = `h${level}` as keyof React.JSX.IntrinsicElements;
      output.push(<Heading key={`h-${index}`}>{inlineMarkdown(heading[2]!)}</Heading>); index += 1; continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!)) { items.push(lines[index]!.replace(/^[-*]\s+/, "")); index += 1; }
      output.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>); continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index]!)) { items.push(lines[index]!.replace(/^\d+\.\s+/, "")); index += 1; }
      output.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ol>); continue;
    }
    const paragraph: string[] = [line]; index += 1;
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,6})\s|^[-*]\s+|^\d+\.\s+|^```/.test(lines[index]!)) {
      paragraph.push(lines[index]!); index += 1;
    }
    output.push(<p key={`p-${index}`}>{inlineMarkdown(paragraph.join(" "))}</p>);
  }
  return <div className="markdown-content">{output.length ? output : <p className="muted">No description.</p>}</div>;
}

type TicketArtifact = TicketFrontmatter["artifacts"][number];
type ArtifactPresentation = { title?: string; description?: string; category?: string; featured?: boolean };
const MAX_INLINE_ARTIFACT_BYTES = 2 * 1024 * 1024;

function artifactPresentation(artifact: TicketArtifact): ArtifactPresentation {
  const raw = artifact.metadata?.presentation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.category === "string" ? { category: record.category } : {}),
    ...(record.featured === true ? { featured: true } : {}),
  };
}

function artifactTitle(artifact: TicketArtifact): string {
  return artifactPresentation(artifact).title ?? artifact.filename;
}

function ArtifactPreview({ ticketId, artifact }: { ticketId: string; artifact: TicketArtifact }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = api.artifactUrl(ticketId, artifact.id);
  const textual = artifact.content_type === "text/markdown" || artifact.content_type.startsWith("text/plain")
    || ["application/json", "application/x-ndjson", "application/yaml", "application/x-yaml", "text/yaml"].includes(artifact.content_type);
  useEffect(() => {
    setContent(null); setError(null);
    if (!textual || artifact.size_bytes > MAX_INLINE_ARTIFACT_BYTES) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Preview returned HTTP ${response.status}`);
      return response.text();
    }).then(setContent).catch((caught) => { if (!controller.signal.aborted) setError((caught as Error).message); });
    return () => controller.abort();
  }, [artifact.id, artifact.size_bytes, textual, url]);
  if (artifact.size_bytes > MAX_INLINE_ARTIFACT_BYTES && textual) return <div className="artifact-preview-fallback"><p>This text artifact is too large for an inline preview.</p><a href={url} target="_blank" rel="noreferrer">Open artifact ↗</a></div>;
  if (artifact.content_type === "text/html") return <iframe className="artifact-html-preview" src={url} sandbox="allow-scripts" title={artifactTitle(artifact)} />;
  if (artifact.content_type.startsWith("image/")) return <div className="artifact-image-preview"><img src={url} alt={artifactTitle(artifact)} /></div>;
  if (artifact.content_type === "application/pdf") return <iframe className="artifact-pdf-preview" src={url} title={artifactTitle(artifact)} />;
  if (error) return <div className="artifact-preview-fallback"><p>{error}</p><a href={url} target="_blank" rel="noreferrer">Open artifact ↗</a></div>;
  if (textual && content === null) return <div className="artifact-preview-loading">Loading preview…</div>;
  if (artifact.content_type === "text/markdown" && content !== null) return <div className="artifact-markdown-preview"><MarkdownContent markdown={content} /></div>;
  if (content !== null) {
    let displayed = content;
    if (artifact.content_type === "application/json") try { displayed = JSON.stringify(JSON.parse(content), null, 2); } catch { /* display invalid JSON as authored */ }
    else if (["application/yaml", "application/x-yaml", "text/yaml"].includes(artifact.content_type)) try { displayed = stringify(parse(content)); } catch { /* display invalid YAML as authored */ }
    return <pre className="artifact-text-preview"><code>{displayed}</code></pre>;
  }
  return <div className="artifact-preview-fallback"><p>No inline preview is available for {artifact.content_type}.</p><a href={url} target="_blank" rel="noreferrer">Open artifact ↗</a></div>;
}

function ReviewMaterials({ ticket, workflow, busy, now, onDecide }: {
  ticket: TicketFrontmatter;
  workflow?: WorkflowDocument["definition"];
  busy: boolean;
  now: number;
  onDecide: (choice: NonNullable<WorkflowNode["choices"]>[number]) => void;
}) {
  const current = ticket.workflow ? workflow?.nodes.find((node) => node.id === ticket.workflow?.current_node) : undefined;
  const active = current?.type === "human_gate" && ticket.status === "waiting_approval";
  const sourceNode = ticket.workflow?.incoming?.source_node;
  const sourceRun = [...(ticket.workflow?.node_runs ?? [])].reverse().find((run) => run.node_id === sourceNode && run.status === "completed");
  const materials = sourceRun ? (ticket.artifacts ?? []).filter((artifact) => artifact.node_run_id === sourceRun.id
    && ["evidence", "script_artifact", "quality_report", "script_output"].includes(artifact.kind)) : [];
  const ordered = [...materials].sort((left, right) => {
    const featured = Number(Boolean(artifactPresentation(right).featured)) - Number(Boolean(artifactPresentation(left).featured));
    if (featured) return featured;
    const rank = (artifact: TicketArtifact) => artifact.content_type === "text/markdown" ? 0 : artifact.content_type === "text/html" ? 1 : artifact.content_type.startsWith("image/") ? 2 : 3;
    return rank(left) - rank(right) || right.created_at.localeCompare(left.created_at);
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ordered.find((artifact) => artifact.id === selectedId) ?? ordered[0];
  useEffect(() => { if (ordered.length && !ordered.some((artifact) => artifact.id === selectedId)) setSelectedId(ordered[0]!.id); }, [ordered.map((artifact) => artifact.id).join("|"), selectedId]);
  if (!active) return null;
  return <section className="review-materials-card" aria-label="Review materials">
    <header className="review-materials-heading"><div><span>Approval requested</span><h2>{current.name}</h2><p>{sourceRun?.summary ?? ticket.workflow?.incoming?.summary ?? "Review the preceding work and choose how the workflow should continue."}</p></div><strong>{materials.length} artifact{materials.length === 1 ? "" : "s"}</strong></header>
    {selected ? <div className="review-materials-body">
      {ordered.length > 1 && <nav className="artifact-tabs" aria-label="Review artifacts">{ordered.map((artifact) => <button className={artifact.id === selected.id ? "active" : ""} key={artifact.id} onClick={() => setSelectedId(artifact.id)}>{artifactTitle(artifact)}</button>)}</nav>}
      <div className="review-artifact-title"><div><span>{artifactPresentation(selected).category ?? humanize(selected.kind)}</span><h3>{artifactTitle(selected)}</h3>{artifactPresentation(selected).description && <p>{artifactPresentation(selected).description}</p>}</div><small>{fileSize(selected.size_bytes)} · {timeAgo(selected.created_at, now)}</small></div>
      <ArtifactPreview ticketId={ticket.id} artifact={selected} />
    </div> : <div className="review-materials-empty"><strong>No review artifact was published.</strong><p>The completion summary above is still available for this decision.</p></div>}
    <footer className="review-actions"><div><span>Decision</span><p>Choose an outcome to continue this workflow.</p></div>{current.choices.map((choice, index) => <button className={index === 0 ? "button-primary" : "button-secondary"} disabled={busy} key={choice.id} onClick={() => onDecide(choice)}><strong>{choice.label}</strong><small>{choice.description}</small></button>)}</footer>
  </section>;
}

function promptForGateComment(choice: NonNullable<WorkflowNode["choices"]>[number]): { message?: string } | null {
  const requirement = choice.comment_required
    ? "A comment is required."
    : "You may add an optional comment for the next node.";
  const comment = window.prompt(`${choice.label}\n\n${choice.description}\n\n${requirement}\nThe selected answer controls workflow routing; this comment does not.`);
  if (comment === null) return null;
  const message = comment.trim();
  if (choice.comment_required && !message) {
    window.alert(`${choice.label} requires a comment.`);
    return null;
  }
  return message ? { message } : {};
}

function runtimeWarning(execution: Pick<Execution, "observed_herdr_state" | "last_heartbeat_at" | "lease_expires_at">, now: number): string | null {
  const state = execution.observed_herdr_state;
  if (state === "blocked") return "Agent needs attention in Herdr";
  if (now - Date.parse(execution.last_heartbeat_at) > 60_000) return "Supervisor heartbeat is stale";
  if (Date.parse(execution.lease_expires_at) - now < 30_000) return "Lease is close to expiring";
  return null;
}

function isDeterministicActivity(nodeType: string | null | undefined): boolean {
  return nodeType === "script" || nodeType === "checkpoint" || nodeType === "restore_checkpoint";
}

function AgentFleet({ agents, now, onOpen }: { agents: RuntimeAgent[]; now: number; onOpen: (id: string) => void }) {
  return <section className="fleet-bar" aria-label="Active agents">
    <div className="fleet-label"><span>Live operations</span><strong>{agents.length} active agent{agents.length === 1 ? "" : "s"}</strong></div>
    <div className="fleet-list">{agents.length ? agents.map((agent) => {
      const activity = isDeterministicActivity(agent.node_type);
      const herdrState = activity ? "unobserved" : agent.herdr?.state ?? "unobserved";
      const state = activity || (agent.delivery_status ?? "delivered") === "delivered" ? "running" : "starting";
      const warning = runtimeWarning({ observed_herdr_state: herdrState, last_heartbeat_at: agent.last_heartbeat_at, lease_expires_at: agent.lease_expires_at }, now);
      return <button key={agent.ticket_id} className={`fleet-agent ${warning ? "needs-attention" : ""}`} onClick={() => onOpen(agent.ticket_id)}>
        <span className={`agent-dot state-${state}`} />
        <span><strong>{activity ? humanize(agent.node_type ?? "activity") : agent.telemetry?.latest.model.id ?? agent.provider}</strong><small>{agent.ticket_id} · {humanize(agent.node_id ?? agent.phase)}{agent.telemetry?.delta.usage ? ` · ${tokenCount(agent.telemetry.delta.usage.total_tokens)} tokens` : ""}</small></span>
        <span className="fleet-state">{warning ?? `${humanize(state)}${activity ? "" : ` · Herdr ${humanize(herdrState)}`} · ${timeAgo(agent.last_heartbeat_at, now)}`}</span>
      </button>;
    }) : <p className="fleet-empty">No agents currently hold a ticket lease.</p>}</div>
  </section>;
}

function SupervisorHealthPage({ supervisors, operations, githubObservationEnabled, now, onOpenTicket }: { supervisors: SupervisorHealth[]; operations: OperationalStatus | null; githubObservationEnabled: boolean; now: number; onOpenTicket: (id: string) => void }) {
  const online = supervisors.filter((supervisor) => supervisor.status === "online").length;
  return <main className="supervisors-page">
    <div className="health-heading"><div><span>Infrastructure</span><h1>System operations</h1><p>Tracker readiness, background maintenance, and supervisor capacity.</p></div><div className="health-summary"><strong>{supervisors.length ? `${online}/${supervisors.length}` : "None"}</strong><span>{supervisors.length ? "supervisors online" : "supervisors registered"}</span></div></div>
    <section className="operations-grid">
      <article className={`supervisor-card operations-card operations-${operations?.status ?? "unknown"}`}>
        <div className="supervisor-card-heading"><div><span className={`agent-dot state-${operations?.ready ? "working" : "blocked"}`} /><div><h2>Tracker readiness</h2><small>{operations ? humanize(operations.status) : "Unavailable"}</small></div></div><StatusPill value={operations?.status ?? "unknown"} /></div>
        <dl className="supervisor-details">
          <DetailRow label="Ticket index">{operations?.ticket_store ? `${operations.ticket_store.valid_tickets}/${operations.ticket_store.ticket_count} valid · generation ${operations.ticket_store.index_generation}` : "Unavailable"}</DetailRow>
          <DetailRow label="Markdown root"><code>{operations?.ticket_store?.root ?? "Unavailable"}</code></DetailRow>
          <DetailRow label="Last rebuild">{timeAgo(operations?.ticket_store?.index_rebuilt_at, now)}</DetailRow>
          <DetailRow label="Disk available">{operations?.ticket_store?.disk ? fileSize(operations.ticket_store.disk.available_bytes) : "Unavailable"}</DetailRow>
          <DetailRow label="Libraries">{operations ? `${operations.libraries.prompts ?? 0} prompts · ${operations.libraries.workflows ?? 0} workflows` : "Unavailable"}</DetailRow>
        </dl>
        {!!operations?.failures.length && <div className="operations-messages failure">{operations.failures.map((message) => <p key={message}>{message}</p>)}</div>}
        {!!operations?.warnings.length && <div className="operations-messages warning">{operations.warnings.map((message) => <p key={message}>{message}</p>)}</div>}
      </article>
      <article className="supervisor-card operations-card">
        <div className="supervisor-card-heading"><div><span className="agent-dot state-working" /><div><h2>Background operations</h2><small>Last observed scheduler results</small></div></div></div>
        <div className="operation-list">{operations ? Object.entries(operations.background_operations).map(([name, operation]) => {
          const disabled = name === "github_observation" && !githubObservationEnabled;
          const state = disabled ? "disabled" : operation.in_progress ? "running" : operation.last_error ? "failed" : operation.last_succeeded_at ? "healthy" : "never_run";
          const detail = disabled ? "Disabled in Configuration → Integrations" : operation.in_progress ? "In progress" : operation.last_error ? operation.last_error : operation.last_succeeded_at ? `Last succeeded ${timeAgo(operation.last_succeeded_at, now)} in ${duration(operation.last_duration_ms ?? 0)}` : "Enabled, but no run has completed yet";
          return <div key={name}><div><strong>{humanize(name)}</strong><StatusPill value={state} subtle /></div><small>{detail}</small></div>;
        }) : <p>Operational status is unavailable.</p>}</div>
      </article>
    </section>
    <div className="health-subheading"><span>Execution capacity</span><h2>Supervisors</h2><p>Each supervisor owns an isolated project root and one ticket end-to-end.</p></div>
    {supervisors.length ? <div className="supervisor-grid">{supervisors.map((supervisor) => <article className={`supervisor-card supervisor-${supervisor.status}`} key={supervisor.supervisor_id}>
      <div className="supervisor-card-heading"><div><span className={`agent-dot state-${supervisor.status === "online" ? "working" : "blocked"}`} /><div><h2>{supervisor.supervisor_id}</h2><small>{supervisor.hostname}</small></div></div><StatusPill value={supervisor.status} /></div>
      <dl className="supervisor-details">
        <DetailRow label="Host IP">{supervisor.ip_addresses.length ? supervisor.ip_addresses.join(", ") : "Not detected"}</DetailRow>
        <DetailRow label="Project root"><code>{supervisor.project_root}</code></DetailRow>
        <DetailRow label="Herdr session"><code>{supervisor.herdr_session}</code></DetailRow>
        <DetailRow label="Last seen">{timeAgo(supervisor.last_seen_at, now)}</DetailRow>
      </dl>
      <div className="provider-list"><span>Available agents</span><div>{supervisor.providers.map((provider) => <strong key={provider}>{humanize(provider)}</strong>)}</div></div>
      <div className="provider-list"><span>Script runtimes</span><div>{supervisor.activity_capabilities.map((capability) => <strong key={capability}>{capability === "repository_action" ? "Script file" : humanize(capability)}</strong>)}</div></div>
      <div className="supervisor-assignment"><span>Reserved ticket</span>{supervisor.assigned_ticket ? <button onClick={() => onOpenTicket(supervisor.assigned_ticket!.id)}><strong>{supervisor.assigned_ticket.id} · {supervisor.assigned_ticket.title}</strong><small>{humanize(supervisor.assigned_ticket.phase)} · {humanize(supervisor.assigned_ticket.status)}</small></button> : <p>Available for a new ticket</p>}</div>
    </article>)}</div> : <div className="empty-health"><span>◎</span><h2>No supervisors have checked in</h2><p>Start a configured supervisor and it will appear here after its first heartbeat.</p></div>}
  </main>;
}

type ConfigurationTab = "general" | "agents" | "cost" | "quality" | "integrations" | "maintenance";

function ConfigurationPage({ config, quota, busy, onSave, onRestoreDefaults }: { config: TrackerConfig | null; quota: QuotaReport | null; busy: boolean; onSave: (update: Pick<TrackerConfig, "providers" | "agent_profiles" | "pricing" | "metrics" | "quality" | "artifacts" | "repositories" | "jira" | "github">) => void; onRestoreDefaults: () => void }) {
  const [tab, setTab] = useStoredState<ConfigurationTab>("agentic-project-tracker.configuration.tab", "general");
  const [enabledProviders, setEnabledProviders] = useState<WorkProvider[]>(config?.providers?.enabled ?? ALL_WORK_PROVIDERS);
  const [repositories, setRepositories] = useState<RepositoryConfig[]>(config?.repositories ?? []);
  const [jira, setJira] = useState(config?.jira ?? { enabled: false, site_url: "", project_key: "", issue_type: "Task" });
  const [github, setGithub] = useState(config?.github ?? { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] });
  const [pricing, setPricing] = useState(config?.pricing ?? { estimate_missing_costs: true, models: [] });
  const [metrics, setMetrics] = useState(config?.metrics ?? { human_day_rate_usd: 1_000, quota_account_aliases: {} });
  const [quality, setQuality] = useState(config?.quality ?? { attributes: [] });
  const [artifacts, setArtifacts] = useState(config?.artifacts ?? { max_total_bytes: 50 * 1024 ** 3, max_ticket_bytes: 5 * 1024 ** 3, orphan_grace_hours: 24, retention_days: 365, auto_gc_enabled: true, gc_interval_minutes: 60 });
  const [agentProfiles, setAgentProfiles] = useState(config?.agent_profiles ?? {
    default: "claude",
    profiles: [
      { id: "claude", label: "Claude Opus", provider: "claude" as const, model: "claude-opus-4-8", reasoning: "high" },
      { id: "codex", label: "Codex Sol", provider: "codex" as const, model: "gpt-5.6-sol", reasoning: "high" },
    ],
  });
  const applyConfig = (source: TrackerConfig | null) => {
    setEnabledProviders(source?.providers?.enabled ?? ALL_WORK_PROVIDERS);
    setRepositories(source?.repositories ?? []);
    setJira(source?.jira ?? { enabled: false, site_url: "", project_key: "", issue_type: "Task" });
    setGithub(source?.github ?? { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] });
    setPricing(source?.pricing ?? { estimate_missing_costs: true, models: [] });
    setMetrics(source?.metrics ?? { human_day_rate_usd: 1_000, quota_account_aliases: {} });
    setQuality(source?.quality ?? { attributes: [] });
    setArtifacts(source?.artifacts ?? { max_total_bytes: 50 * 1024 ** 3, max_ticket_bytes: 5 * 1024 ** 3, orphan_grace_hours: 24, retention_days: 365, auto_gc_enabled: true, gc_interval_minutes: 60 });
    setAgentProfiles(source?.agent_profiles ?? { default: "claude", profiles: [{ id: "claude", label: "Claude Opus", provider: "claude", model: "claude-opus-4-8", reasoning: "high" }, { id: "codex", label: "Codex Sol", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" }] });
  };
  useEffect(() => { applyConfig(config); }, [config?.revision]);
  const errors: string[] = [];
  if (enabledProviders.length === 0) errors.push("Enable at least one work agent.");
  if (repositories.some((repository) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository.id) || repository.id === "." || repository.id === "..")) errors.push("Repository IDs must be safe directory names.");
  if (repositories.some((repository) => !repository.url.trim())) errors.push("Every repository needs a clone URL.");
  if (new Set(repositories.map((repository) => repository.id.trim())).size !== repositories.length) errors.push("Repository IDs must be unique.");
  if (new Set(repositories.map((repository) => repository.url.trim())).size !== repositories.length) errors.push("Repository URLs must be unique.");
  if (jira.enabled && !/^https:\/\/[A-Za-z0-9.-]+\.atlassian\.net\/?$/.test(jira.site_url)) errors.push("Jira site must be an atlassian.net URL.");
  if (jira.enabled && !jira.project_key.trim()) errors.push("Jira project key is required when Jira is enabled.");
  if (!agentProfiles.profiles.length) errors.push("Configure at least one agent profile.");
  if (agentProfiles.profiles.some((profile) => !enabledProviders.includes(profile.provider))) errors.push("Every agent profile must use an enabled provider.");
  if (!agentProfiles.profiles.some((profile) => profile.id === agentProfiles.default)) errors.push("The default agent profile must reference an alias.");
  if (agentProfiles.profiles.some((profile) => !/^[a-z][a-z0-9-]{0,63}$/.test(profile.id) || !profile.label.trim() || !profile.model.trim() || !profile.reasoning.trim())) errors.push("Every agent profile needs a valid alias, label, model, and reasoning value.");
  if (new Set(agentProfiles.profiles.map((profile) => profile.id)).size !== agentProfiles.profiles.length) errors.push("Agent profile aliases must be unique.");
  if (!Number.isFinite(metrics.human_day_rate_usd) || metrics.human_day_rate_usd < 0) errors.push("Human day rate must be a non-negative number.");
  if (pricing.models.some((entry) => !entry.id.trim() || !entry.model.trim() || !entry.source_url.startsWith("https://") || !Number.isFinite(Date.parse(entry.effective_at)))) errors.push("Every pricing entry needs an ID, model, HTTPS source, and effective date.");
  if (pricing.models.some((entry) => [entry.input_per_million_usd, entry.cached_input_per_million_usd, entry.cache_write_input_per_million_usd, entry.output_per_million_usd].some((value) => !Number.isFinite(value) || value < 0))) errors.push("Token prices must be non-negative numbers.");
  if (quality.attributes.some((attribute) => !/^[a-z][a-z0-9._-]{0,127}$/.test(attribute.key) || !attribute.label.trim())) errors.push("Every quality attribute needs a valid namespaced key and label.");
  if (new Set(quality.attributes.map((attribute) => attribute.key)).size !== quality.attributes.length) errors.push("Quality attribute keys must be unique.");
  if (quality.attributes.some((attribute) => attribute.minimum !== null && attribute.maximum !== null && attribute.minimum > attribute.maximum)) errors.push("Quality attribute minimums cannot exceed maximums.");
  if (!Number.isSafeInteger(artifacts.max_total_bytes) || !Number.isSafeInteger(artifacts.max_ticket_bytes) || artifacts.max_ticket_bytes < 1024 ** 2 || artifacts.max_total_bytes < artifacts.max_ticket_bytes) errors.push("Artifact quotas must be whole bytes, at least 1 MiB, with the total quota no smaller than the per-ticket quota.");
  if (![artifacts.orphan_grace_hours, artifacts.retention_days, artifacts.gc_interval_minutes].every((value) => Number.isSafeInteger(value) && value > 0)) errors.push("Artifact grace, retention, and maintenance intervals must be positive whole numbers.");
  const update = (index: number, patch: Partial<RepositoryConfig>) => setRepositories((current) => current.map((repository, candidate) => candidate === index ? { ...repository, ...patch } : repository));
  const toggleProvider = (provider: WorkProvider, enabled: boolean) => setEnabledProviders((current) => enabled
    ? ALL_WORK_PROVIDERS.filter((candidate) => candidate === provider || current.includes(candidate))
    : current.filter((candidate) => candidate !== provider));
  const quotaAliasKey = (provider: "claude" | "codex", supervisorId: string) => `${provider}:${supervisorId}`;
  const quotaAliasValue = (provider: "claude" | "codex", supervisorId: string) => metrics.quota_account_aliases?.[quotaAliasKey(provider, supervisorId)]
    ?? (provider === "codex" ? metrics.quota_account_aliases?.[supervisorId] : undefined)
    ?? "";
  const updateQuotaAccount = (provider: "claude" | "codex", supervisorId: string, value: string) => setMetrics((current) => {
    const quota_account_aliases = { ...(current.quota_account_aliases ?? {}) };
    const key = quotaAliasKey(provider, supervisorId);
    if (value.trim()) quota_account_aliases[key] = value.trim();
    else delete quota_account_aliases[key];
    if (provider === "codex") delete quota_account_aliases[supervisorId];
    return { ...current, quota_account_aliases };
  });
  const savePayload = {
    providers: { enabled: enabledProviders }, agent_profiles: agentProfiles, pricing, metrics, quality, artifacts,
    repositories: repositories.map((repository) => ({ id: repository.id.trim(), url: repository.url.trim() })),
    jira: { ...jira, site_url: jira.site_url.replace(/\/$/, ""), project_key: jira.project_key.trim(), issue_type: jira.issue_type.trim() }, github,
  };
  const baselinePayload = config ? {
    providers: { enabled: config.providers?.enabled ?? ALL_WORK_PROVIDERS },
    agent_profiles: config.agent_profiles ?? { default: "claude", profiles: [{ id: "claude", label: "Claude Opus", provider: "claude" as const, model: "claude-opus-4-8", reasoning: "high" }, { id: "codex", label: "Codex Sol", provider: "codex" as const, model: "gpt-5.6-sol", reasoning: "high" }] },
    pricing: config.pricing ?? { estimate_missing_costs: true, models: [] }, metrics: config.metrics ?? { human_day_rate_usd: 1_000, quota_account_aliases: {} }, quality: config.quality ?? { attributes: [] },
    artifacts: config.artifacts ?? { max_total_bytes: 50 * 1024 ** 3, max_ticket_bytes: 5 * 1024 ** 3, orphan_grace_hours: 24, retention_days: 365, auto_gc_enabled: true, gc_interval_minutes: 60 },
    repositories: (config.repositories ?? []).map((repository) => ({ id: repository.id.trim(), url: repository.url.trim() })),
    jira: { ...(config.jira ?? { enabled: false, site_url: "", project_key: "", issue_type: "Task" }), site_url: (config.jira?.site_url ?? "").replace(/\/$/, ""), project_key: (config.jira?.project_key ?? "").trim(), issue_type: (config.jira?.issue_type ?? "Task").trim() },
    github: config.github ?? { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] },
  } : null;
  const dirty = Boolean(baselinePayload && JSON.stringify(savePayload) !== JSON.stringify(baselinePayload));
  const tabs: Array<{ id: ConfigurationTab; label: string; description: string }> = [
    { id: "general", label: "General & repositories", description: "Clone sources and project scope" },
    { id: "agents", label: "Agents & models", description: "Harnesses and reusable profiles" },
    { id: "cost", label: "Cost & metrics", description: "Pricing, quotas, and assumptions" },
    { id: "quality", label: "Quality & artifacts", description: "Evaluation fields and retention" },
    { id: "integrations", label: "Integrations", description: "Jira Cloud and GitHub" },
    { id: "maintenance", label: "Maintenance", description: "Restore built-in artifacts" },
  ];
  return <main className="configuration-page">
    <div className="health-heading"><div><span>Local configuration</span><h1>Tracker configuration</h1><p>Configure repository sources, agent profiles, accounting, evidence, and optional integrations.</p></div>{config && <div className="health-summary"><strong>r{config.revision}</strong><span>tracker-config.yaml</span></div>}</div>
    <nav className="configuration-tabs" role="tablist" aria-label="Configuration sections">{tabs.map((item) => <button role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}><strong>{item.label}</strong><small>{item.description}</small></button>)}</nav>
    <section className="configuration-card">
      {tab === "general" && <>
      <div className="section-heading"><div><span>Repositories</span><h2>Configured clone sources</h2></div><button className="button-secondary" onClick={() => setRepositories((current) => [...current, { id: "", url: "" }])}>Add repository</button></div>
      <div className="config-column-labels"><span>Directory ID</span><span>Git clone URL</span><span /></div>
      {repositories.map((repository, index) => <div className="config-repository-row" key={index}>
        <input aria-label={`Repository ID ${index + 1}`} placeholder="application-api" value={repository.id} onChange={(event) => update(index, { id: event.target.value })} />
        <input aria-label={`Repository URL ${index + 1}`} placeholder="git@github.com:organization/repository.git" value={repository.url} onChange={(event) => update(index, { url: event.target.value })} />
        <button className="icon-button" aria-label={`Remove configured repository ${index + 1}`} onClick={() => setRepositories((current) => current.filter((_, candidate) => candidate !== index))}>×</button>
      </div>)}
      {!repositories.length && <div className="config-empty"><strong>No repositories configured</strong><span>Add the repositories that should exist beneath every supervisor project root.</span></div>}
      </>}
      {tab === "agents" && <>
      <div className="section-heading"><div><span>Agent runtime</span><h2>Enabled harnesses</h2></div></div>
      <p className="config-help">Choose which harnesses may be used by workflow agent profiles. Supervisor availability is reported separately.</p>
      <div className="provider-config-grid">{ALL_WORK_PROVIDERS.map((provider) => <label className="toggle" key={provider}><input aria-label={`Enable ${humanize(provider)}`} type="checkbox" checked={enabledProviders.includes(provider)} onChange={(event) => toggleProvider(provider, event.target.checked)} /><span><strong>{humanize(provider)}</strong><small>{enabledProviders.includes(provider) ? "Available to workflow profiles" : "Hidden from workflow profiles"}</small></span></label>)}</div>
      <div className="section-heading"><div><span>Workflow routing</span><h2>Agent profiles</h2></div><button className="button-secondary" onClick={() => setAgentProfiles((current) => ({ ...current, profiles: [...current.profiles, { id: `profile-${current.profiles.length + 1}`, label: "New profile", provider: enabledProviders[0] ?? "codex", model: "gpt-5.6-sol", reasoning: "high" }] }))}>Add profile</button></div>
      <p className="config-help">Workflow nodes reference an alias. Each ticket pins the alias's resolved provider, model, and reasoning when it is created.</p>
      <div className="config-column-labels"><span>Alias / label</span><span>Provider / model / reasoning</span><span /></div>
      {agentProfiles.profiles.map((profile, index) => <div className="config-repository-row" key={`${profile.id}:${index}`}>
        <div><input aria-label={`Agent profile alias ${index + 1}`} value={profile.id} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") } : item) }))} /><input aria-label={`Agent profile label ${index + 1}`} value={profile.label} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, label: event.target.value } : item) }))} /></div>
        <div className="field-row"><select aria-label={`Agent profile provider ${index + 1}`} value={profile.provider} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, provider: event.target.value as WorkProvider } : item) }))}>{enabledProviders.map((provider) => <option key={provider} value={provider}>{humanize(provider)}</option>)}</select><input aria-label={`Agent profile model ${index + 1}`} value={profile.model} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, model: event.target.value } : item) }))} /><input aria-label={`Agent profile reasoning ${index + 1}`} value={profile.reasoning} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, reasoning: event.target.value } : item) }))} /></div>
        <button className="icon-button" disabled={agentProfiles.profiles.length === 1} onClick={() => setAgentProfiles((current) => { const profiles = current.profiles.filter((_, candidate) => candidate !== index); return { default: current.default === profile.id ? profiles[0]!.id : current.default, profiles }; })}>×</button>
      </div>)}
      <label>Default profile<select aria-label="Default agent profile" value={agentProfiles.default} onChange={(event) => setAgentProfiles({ ...agentProfiles, default: event.target.value })}>{agentProfiles.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} ({profile.id})</option>)}</select></label>
      </>}
      {tab === "cost" && <>
      <div className="section-heading"><div><span>Cost accounting</span><h2>Model pricing</h2></div><button className="button-secondary" onClick={() => setPricing((current) => ({ ...current, models: [...current.models, { id: `custom-price-${current.models.length + 1}`, provider: enabledProviders[0] ?? "codex", model: "", input_per_million_usd: 0, cached_input_per_million_usd: 0, cache_write_input_per_million_usd: 0, output_per_million_usd: 0, source_url: "https://", effective_at: new Date().toISOString() }] }))}>Add price</button></div>
      <label className="toggle"><input type="checkbox" checked={pricing.estimate_missing_costs} onChange={(event) => setPricing({ ...pricing, estimate_missing_costs: event.target.checked })} /><span><strong>Estimate missing harness costs</strong><small>Reported cost wins. These rates are used only when the harness supplies tokens but no USD total.</small></span></label>
      <div className="pricing-table"><div className="pricing-header"><span>Provider / model</span><span>Per million tokens</span><span>Source / effective date</span><span /></div>{pricing.models.map((entry, index) => {
        const updatePrice = (patch: Partial<typeof entry>) => setPricing((current) => ({ ...current, models: current.models.map((item, candidate) => candidate === index ? { ...item, ...patch } : item) }));
        return <div className="pricing-row" key={`${entry.id}:${index}`}><div><input aria-label={`Pricing ID ${index + 1}`} value={entry.id} onChange={(event) => updatePrice({ id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /><select aria-label={`Pricing provider ${index + 1}`} value={entry.provider} onChange={(event) => updatePrice({ provider: event.target.value as WorkProvider })}>{enabledProviders.map((provider) => <option key={provider} value={provider}>{humanize(provider)}</option>)}</select><input aria-label={`Pricing model ${index + 1}`} value={entry.model} onChange={(event) => updatePrice({ model: event.target.value })} /></div><div className="price-inputs"><label>Uncached<input type="number" min="0" step="0.01" value={entry.input_per_million_usd} onChange={(event) => updatePrice({ input_per_million_usd: Number(event.target.value) })} /></label><label>Cached<input type="number" min="0" step="0.01" value={entry.cached_input_per_million_usd} onChange={(event) => updatePrice({ cached_input_per_million_usd: Number(event.target.value) })} /></label><label>Write<input type="number" min="0" step="0.01" value={entry.cache_write_input_per_million_usd} onChange={(event) => updatePrice({ cache_write_input_per_million_usd: Number(event.target.value) })} /></label><label>Output<input type="number" min="0" step="0.01" value={entry.output_per_million_usd} onChange={(event) => updatePrice({ output_per_million_usd: Number(event.target.value) })} /></label></div><div><input aria-label={`Pricing source ${index + 1}`} value={entry.source_url} onChange={(event) => updatePrice({ source_url: event.target.value })} /><input aria-label={`Pricing effective date ${index + 1}`} type="date" value={entry.effective_at.slice(0, 10)} onChange={(event) => updatePrice({ effective_at: new Date(`${event.target.value}T00:00:00.000Z`).toISOString() })} /></div><button className="icon-button" aria-label={`Remove pricing entry ${index + 1}`} onClick={() => setPricing((current) => ({ ...current, models: current.models.filter((_, candidate) => candidate !== index) }))}>×</button></div>;
      })}</div>
      <div className="section-heading"><div><span>Subscription observation</span><h2>Weekly allowances</h2></div></div>
      <p className="config-help">When Claude or Codex reports a seven-day percentage window, the tracker compares that change with completed node usage. The result is an observed-workload estimate, not a contractual token quota. API-key billing and some plans may not report a weekly allowance at all.</p>
      {quota?.accounts.length ? <div className="quota-estimate-grid">{quota.accounts.map((account) => <article className="quota-estimate-card" key={`${account.provider}:${account.account_id}:${account.limit_id ?? "none"}`}>
        <header><div><span>{humanize(account.provider)} quota account</span><h3>{account.account_id}</h3><small>{account.supervisor_ids.join(", ")}</small></div><StatusPill value={account.status} /></header>
        {account.status === "not_reported" ? <div className="quota-unavailable"><strong>No weekly allowance reported</strong><p>{account.provider === "claude" ? "Claude requires its optional supervisor status-line feed to expose a fixed seven-day window." : "This is expected for API-key billing and any Codex plan that does not expose a fixed weekly window."}</p></div> : <>
          <div className="quota-meter-heading"><span>Latest observed weekly use</span><strong>{account.used_percent === null ? "—" : `${account.used_percent.toLocaleString()}%`}</strong></div>
          <div className="quota-meter" aria-label={`${account.account_id} weekly usage`}><span style={{ width: `${Math.min(100, Math.max(0, account.used_percent ?? 0))}%` }} /></div>
          <div className="quota-estimate-values"><div><span>Token equivalent</span><strong>{tokenCount(account.estimated_weekly_tokens)}</strong></div><div><span>API-cost equivalent</span><strong>{usd(account.estimated_weekly_api_usd)}</strong></div></div>
          <p>{account.status === "estimated" ? `${humanize(account.confidence ?? "low")} confidence from ${account.token_samples} sample${account.token_samples === 1 ? "" : "s"} spanning ${account.percentage_points_observed.toLocaleString()} percentage point${account.percentage_points_observed === 1 ? "" : "s"}.` : "More observed percentage movement is needed before an allowance estimate can be calculated."}</p>
          <small>{account.resets_at ? `Observed window reset ${new Date(account.resets_at).toLocaleString()}.` : "Reset time was not reported."}{account.observed_at ? ` Last observed ${new Date(account.observed_at).toLocaleString()}.` : ""}{account.plan_types.length ? ` Plan: ${account.plan_types.join(", ")}.` : ""}</small>
        </>}
        <div className="quota-account-aliases"><span>Combine supervisors sharing one {humanize(account.provider)} account</span>{account.supervisor_ids.map((supervisorId) => <label key={supervisorId}>{supervisorId}<input aria-label={`${humanize(account.provider)} quota account alias ${supervisorId}`} placeholder={supervisorId} value={quotaAliasValue(account.provider, supervisorId)} onChange={(event) => updateQuotaAccount(account.provider, supervisorId, event.target.value)} /></label>)}</div>
      </article>)}</div> : <div className="config-empty quota-empty"><strong>No subscription quota observations</strong><span>A Claude- or Codex-enabled supervisor will appear after it checks in. An estimate requires completed nodes plus a reported seven-day rate-limit window.</span></div>}
      <div className="section-heading"><div><span>Human comparison</span><h2>Metrics assumptions</h2></div></div>
      <div className="field-row"><label>Human day rate (USD)<input aria-label="Human day rate" type="number" min="0" step="1" value={metrics.human_day_rate_usd} onChange={(event) => setMetrics({ ...metrics, human_day_rate_usd: Number(event.target.value) })} /></label></div>
      <p className="config-help">Tickets may record estimated human days. Metrics compare that estimate at this rate with factory cost for tickets that have complete cost coverage.</p>
      </>}
      {tab === "quality" && <>
      <div className="section-heading"><div><span>Evaluation vocabulary</span><h2>Quality registry</h2></div><button className="button-secondary" onClick={() => setQuality((current) => ({ attributes: [...current.attributes, { key: `quality.attribute-${current.attributes.length + 1}`, label: "New quality attribute", type: "number", unit: "", direction: "higher_is_better", minimum: null, maximum: null }] }))}>Add attribute</button></div>
      <p className="config-help">Registered keys provide stable types, units, and direction for workflow comparisons. Unregistered report attributes remain visible on their ticket but are excluded from aggregate evaluations.</p>
      <div className="quality-registry"><div className="quality-registry-header"><span>Key / label</span><span>Type / unit / direction</span><span>Bounds</span><span /></div>{quality.attributes.map((attribute, index) => {
        const updateQuality = (patch: Partial<typeof attribute>) => setQuality((current) => ({ attributes: current.attributes.map((item, candidate) => candidate === index ? { ...item, ...patch } : item) }));
        return <div className="quality-registry-row" key={`${attribute.key}:${index}`}><div><input aria-label={`Quality key ${index + 1}`} value={attribute.key} onChange={(event) => updateQuality({ key: event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "-") })} /><input aria-label={`Quality label ${index + 1}`} value={attribute.label} onChange={(event) => updateQuality({ label: event.target.value })} /></div><div><select aria-label={`Quality type ${index + 1}`} value={attribute.type} onChange={(event) => updateQuality({ type: event.target.value as typeof attribute.type, direction: event.target.value === "number" ? attribute.direction : "neutral", minimum: event.target.value === "number" ? attribute.minimum : null, maximum: event.target.value === "number" ? attribute.maximum : null })}><option value="number">Number</option><option value="boolean">Boolean</option><option value="string">String</option></select><input aria-label={`Quality unit ${index + 1}`} placeholder="percent, ratio, findings…" value={attribute.unit} onChange={(event) => updateQuality({ unit: event.target.value })} /><select aria-label={`Quality direction ${index + 1}`} disabled={attribute.type !== "number"} value={attribute.direction} onChange={(event) => updateQuality({ direction: event.target.value as typeof attribute.direction })}><option value="higher_is_better">Higher is better</option><option value="lower_is_better">Lower is better</option><option value="neutral">Neutral</option></select></div><div><input aria-label={`Quality minimum ${index + 1}`} type="number" disabled={attribute.type !== "number"} placeholder="Minimum" value={attribute.minimum ?? ""} onChange={(event) => updateQuality({ minimum: event.target.value === "" ? null : Number(event.target.value) })} /><input aria-label={`Quality maximum ${index + 1}`} type="number" disabled={attribute.type !== "number"} placeholder="Maximum" value={attribute.maximum ?? ""} onChange={(event) => updateQuality({ maximum: event.target.value === "" ? null : Number(event.target.value) })} /></div><button className="icon-button" aria-label={`Remove quality attribute ${index + 1}`} onClick={() => setQuality((current) => ({ attributes: current.attributes.filter((_, candidate) => candidate !== index) }))}>×</button></div>;
      })}{!quality.attributes.length && <div className="config-empty"><strong>No quality attributes registered</strong><span>Quality YAML may still be stored, but cross-workflow metrics require registered keys.</span></div>}</div>
      <div className="section-heading"><div><span>Tracker storage</span><h2>Artifact retention & quotas</h2></div></div>
      <label className="toggle"><input type="checkbox" checked={artifacts.auto_gc_enabled} onChange={(event) => setArtifacts({ ...artifacts, auto_gc_enabled: event.target.checked })} /><span><strong>Run automatic maintenance</strong><small>Recover crash-orphaned records after the grace window; remove only unreferenced data after both grace and retention have elapsed.</small></span></label>
      <div className="field-row">
        <label>Total quota (MiB)<input aria-label="Artifact total quota" type="number" min="1" step="1" value={Math.round(artifacts.max_total_bytes / 1024 ** 2)} onChange={(event) => setArtifacts({ ...artifacts, max_total_bytes: Number(event.target.value) * 1024 ** 2 })} /></label>
        <label>Per-ticket quota (MiB)<input aria-label="Artifact ticket quota" type="number" min="1" step="1" value={Math.round(artifacts.max_ticket_bytes / 1024 ** 2)} onChange={(event) => setArtifacts({ ...artifacts, max_ticket_bytes: Number(event.target.value) * 1024 ** 2 })} /></label>
        <label>Orphan grace (hours)<input aria-label="Artifact orphan grace" type="number" min="1" step="1" value={artifacts.orphan_grace_hours} onChange={(event) => setArtifacts({ ...artifacts, orphan_grace_hours: Number(event.target.value) })} /></label>
        <label>Retention (days)<input aria-label="Artifact retention" type="number" min="1" step="1" value={artifacts.retention_days} onChange={(event) => setArtifacts({ ...artifacts, retention_days: Number(event.target.value) })} /></label>
        <label>Maintenance interval (minutes)<input aria-label="Artifact maintenance interval" type="number" min="1" step="1" value={artifacts.gc_interval_minutes} onChange={(event) => setArtifacts({ ...artifacts, gc_interval_minutes: Number(event.target.value) })} /></label>
      </div>
      <p className="config-help">Run <code>npm run artifacts:diagnose -- /path/to/tickets</code> for a read-only orphan and integrity report.</p>
      </>}
      {tab === "integrations" && <>
      <div className="section-heading"><div><span>Optional integration</span><h2>Jira Cloud</h2></div></div>
      <label className="toggle"><input type="checkbox" checked={jira.enabled} onChange={(event) => setJira({ ...jira, enabled: event.target.checked })} /><span><strong>Enable Jira</strong><small>Disabled personal installs make no Jira requests.</small></span></label>
      {jira.enabled && <div className="field-row"><label>Atlassian site<input aria-label="Jira site" placeholder="https://company.atlassian.net" value={jira.site_url} onChange={(event) => setJira({ ...jira, site_url: event.target.value })} /></label><label>Project key<input aria-label="Jira project key" value={jira.project_key} onChange={(event) => setJira({ ...jira, project_key: event.target.value })} /></label><label>Issue type<input aria-label="Jira issue type" value={jira.issue_type} onChange={(event) => setJira({ ...jira, issue_type: event.target.value })} /></label></div>}
      <div className="section-heading"><div><span>Review follow-up</span><h2>GitHub PR observation</h2></div></div>
      <label className="toggle"><input type="checkbox" checked={github.observation_enabled} onChange={(event) => setGithub({ ...github, observation_enabled: event.target.checked })} /><span><strong>Check reviewable tickets periodically</strong><small>GitHub feedback follows the explicit outcome or target configured on the current workflow node.</small></span></label>
      <div className="field-row"><label>Interval (minutes)<input aria-label="GitHub observation interval" type="number" min="1" value={github.observation_interval_minutes} onChange={(event) => setGithub({ ...github, observation_interval_minutes: Number(event.target.value) })} /></label><label>Ignored GitHub logins<input aria-label="Ignored GitHub logins" value={github.ignored_logins.join(", ")} onChange={(event) => setGithub({ ...github, ignored_logins: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label></div>
      </>}
      {tab === "maintenance" && <>
      <div className="section-heading"><div><span>Built-in artifacts</span><h2>Restore defaults</h2></div><button className="button-danger" disabled={busy} onClick={onRestoreDefaults}>Restore prompts & workflows</button></div><p className="config-help">Custom artifacts are preserved. Built-in prompts and workflows return to their shipped content revision; tickets pinned to other revisions do not change.</p>
      <div className="maintenance-note"><strong>Credentials are not stored here</strong><p>JIRA_EMAIL, JIRA_API_TOKEN, and GITHUB_TOKEN remain environment variables.</p></div>
      </>}
    </section>
    {errors.length > 0 && <div className="draft-validation configuration-validation" role="alert"><strong>Configuration needs attention</strong><ul>{errors.map((item) => <li key={item}>{item}</li>)}</ul></div>}
    <div className="config-save-bar"><div><span className={`agent-dot state-${dirty ? "starting" : "working"}`} /><span><strong>{dirty ? "Unsaved changes" : "Configuration saved"}</strong><small>{dirty ? "Review validation, then save or revert your edits." : `tracker-config.yaml revision ${config?.revision ?? "—"}`}</small></span></div><div><button className="button-secondary" disabled={!dirty || busy} onClick={() => applyConfig(config)}>Revert changes</button><button className="button-primary" disabled={!config || !dirty || busy || errors.length > 0} onClick={() => onSave(savePayload)}>Save configuration</button></div></div>
  </main>;
}

function RepositoryBlockers({ blockers }: { blockers: RepositoryClaimBlocker[] }) {
  if (!blockers.length) return null;
  return <section className="repository-blockers" aria-label="Repository claim blockers">
    <div><strong>Repository work is reserved on {blockers.length === 1 ? "this host" : "these hosts"}</strong><span>This ticket stays ready and may still be claimed by a supervisor on another host.</span></div>
    {blockers.map((blocker) => <div className="repository-blocker" key={`${blocker.hostname}:${blocker.ticket_id}`}>
      <span>{blocker.hostname}</span><strong>{blocker.repositories.join(", ")}</strong><small>{blocker.ticket_id} · {blocker.ticket_title}</small>
    </div>)}
  </section>;
}

type QualityDisplayAttribute = { key: string; label: string; value: string | number | boolean; unit: string; status: "pass" | "warn" | "fail" | "unknown"; registered: boolean };
function TicketQuality({ ticket }: { ticket: TicketFrontmatter }) {
  const latest = new Map<string, { attribute: QualityDisplayAttribute; artifact: TicketFrontmatter["artifacts"][number]; reportName: string; nodeId: string; subject: string }>();
  for (const artifact of [...(ticket.artifacts ?? [])].sort((left, right) => left.created_at.localeCompare(right.created_at))) {
    if (artifact.kind !== "quality_report") continue;
    const report = artifact.metadata?.quality_report;
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    const record = report as Record<string, unknown>;
    if (!Array.isArray(record.attributes)) continue;
    const nodeId = ticket.workflow?.node_runs.find((run) => run.id === artifact.node_run_id)?.node_id ?? "unknown-node";
    const subjectRecord = record.subject && typeof record.subject === "object" && !Array.isArray(record.subject) ? record.subject as Record<string, unknown> : {};
    const subject = [subjectRecord.type, subjectRecord.repository, subjectRecord.ref, subjectRecord.commit].filter((value) => typeof value === "string").join(" · ");
    for (const candidate of record.attributes) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const attribute = candidate as Record<string, unknown>;
      if (typeof attribute.key !== "string" || !["string", "number", "boolean"].includes(typeof attribute.value)) continue;
      latest.set(`${nodeId}/${JSON.stringify(subjectRecord)}/${attribute.key}`, {
        artifact, reportName: typeof record.name === "string" ? record.name : artifact.filename, nodeId, subject,
        attribute: {
          key: attribute.key, label: typeof attribute.label === "string" ? attribute.label : attribute.key,
          value: attribute.value as string | number | boolean, unit: typeof attribute.unit === "string" ? attribute.unit : "",
          status: ["pass", "warn", "fail", "unknown"].includes(String(attribute.status)) ? attribute.status as QualityDisplayAttribute["status"] : "unknown",
          registered: attribute.registered === true,
        },
      });
    }
  }
  if (!latest.size) return null;
  return <section className="side-card quality-card"><div className="section-heading"><div><span>Evaluation evidence</span><h2>Quality</h2></div><small>{latest.size} attribute{latest.size === 1 ? "" : "s"}</small></div><div className="quality-list">{[...latest.entries()].sort((left, right) => left[1].attribute.label.localeCompare(right[1].attribute.label)).map(([identity, { attribute, artifact, reportName, nodeId, subject }]) => <div className={`quality-item quality-${attribute.status}`} key={identity}><span><i />{attribute.label}<small>{attribute.key} · {humanize(nodeId)}{subject ? ` · ${subject}` : ""}{attribute.registered ? "" : " · unregistered"}</small></span><strong>{String(attribute.value)}{attribute.unit ? ` ${attribute.unit}` : ""}</strong><a href={api.artifactUrl(ticket.id, artifact.id)} target="_blank" rel="noreferrer" title={reportName}>YAML ↗</a></div>)}</div></section>;
}

type EvidenceTab = "review" | "provenance" | "runs" | "traces" | "technical" | "checkpoints" | "attachments";

interface TraceDisplayEvent {
  sequence: number; timestamp: string; elapsed_ms: number; event: string; data: Record<string, unknown>;
}

function traceEventSummary(item: TraceDisplayEvent): string {
  const command = typeof item.data.command === "string" ? item.data.command : null;
  if (command) return `${command}${typeof item.data.duration_ms === "number" ? ` · ${duration(item.data.duration_ms)}` : ""}${item.data.error_code ? ` · ${String(item.data.error_code)}` : ""}`;
  if (item.event === "delivery.evaluated") return item.data.accepted === true
    ? `Accepted${item.data.confirmation ? ` · ${String(item.data.confirmation)}` : ""}`
    : `Not confirmed${item.data.composer_evidence ? ` · ${String(item.data.composer_evidence)}` : ""}`;
  if (item.event === "herdr.observation") return [item.data.state, item.data.interactive_ready === true ? "input ready" : null, item.data.launch_pending === true ? "launch pending" : null, typeof item.data.revision === "number" ? `revision ${item.data.revision}` : null].filter(Boolean).join(" · ");
  return Object.entries(item.data).slice(0, 3).map(([key, value]) => `${humanize(key)}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ");
}

function OperationalTrace({ ticketId, artifacts, run, now, nodeName }: {
  ticketId: string; artifacts: TicketArtifact[]; run?: TicketNodeRun; now: number; nodeName: (id: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TraceDisplayEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "commands" | "decisions" | "errors">("all");
  const ordered = [...artifacts].sort((left, right) => Number(left.metadata.first_sequence) - Number(right.metadata.first_sequence));
  useEffect(() => {
    if (!open || events || error) return;
    void Promise.all(ordered.map(async (artifact) => {
      const response = await fetch(api.artifactUrl(ticketId, artifact.id));
      if (!response.ok) throw new Error(`Trace chunk ${artifact.filename} returned ${response.status}`);
      return (await response.text()).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TraceDisplayEvent);
    })).then((chunks) => setEvents(chunks.flat().sort((left, right) => left.sequence - right.sequence))).catch((reason) => setError((reason as Error).message));
  }, [open, events, error, ticketId, ordered.map((artifact) => artifact.id).join("|")]);
  const visible = (events ?? []).filter((item) => filter === "all"
    || filter === "commands" && item.event.startsWith("herdr.command")
    || filter === "decisions" && (item.event.startsWith("delivery.") || item.event.startsWith("execution."))
    || filter === "errors" && (item.event.endsWith("failed") || item.data.error_code !== null && item.data.error_code !== undefined));
  const eventCount = ordered.reduce((sum, artifact) => sum + Number(artifact.metadata.event_count ?? 0), 0);
  const completed = ordered.some((artifact) => artifact.metadata.completed === true);
  return <details className="run-evidence operational-trace" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span><strong>{run ? nodeName(run.node_id) : "Unknown node"}</strong><small>Herdr operational trace · attempt {run?.attempt ?? "?"} · {eventCount} events · {ordered.length} chunk{ordered.length === 1 ? "" : "s"}</small></span><span><StatusPill value={completed ? "completed" : run?.status ?? "running"} subtle /><small>{timeAgo(ordered.at(-1)?.created_at ?? new Date().toISOString(), now)}</small></span></summary>{open && <div className="run-evidence-body"><div className="trace-toolbar"><div>{(["all", "commands", "decisions", "errors"] as const).map((value) => <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{humanize(value)}</button>)}</div><div>{ordered.map((artifact, index) => <a href={api.artifactUrl(ticketId, artifact.id, true)} key={artifact.id}>JSONL {index + 1}</a>)}</div></div>{error ? <div className="evidence-empty">{error}</div> : !events ? <div className="evidence-empty">Loading operational trace…</div> : <div className="trace-events">{visible.map((item) => <details key={item.sequence} className={`trace-event ${item.event.endsWith("failed") || item.data.error_code ? "trace-error" : ""}`}><summary><code>#{item.sequence}</code><span><strong>{humanize(item.event)}</strong><small>{traceEventSummary(item)}</small></span><time>{new Date(item.timestamp).toLocaleString()} · +{duration(item.elapsed_ms)}</time></summary><pre>{JSON.stringify(item.data, null, 2)}</pre></details>)}</div>}</div>}</details>;
}

function TicketEvidence({ ticket, workflow, busy, now, onUpload, onRemoveAttachment, onCreateCheckpoint, onRestoreCheckpoint }: {
  ticket: TicketDetail; workflow?: WorkflowDocument["definition"]; busy: boolean; now: number;
  onUpload: (files: File[]) => void; onRemoveAttachment: (id: string) => void;
  onCreateCheckpoint: (nodeId: string) => void; onRestoreCheckpoint: (nodeId: string, checkpointId: string) => void;
}) {
  const [storedTab, setStoredTab] = useStoredState<string>("agentic-project-tracker.evidence.tab", "review");
  const tab: EvidenceTab = ["review", "provenance", "runs", "traces", "technical", "checkpoints", "attachments"].includes(storedTab) ? storedTab as EvidenceTab : "review";
  const setTab = (value: EvidenceTab) => setStoredTab(value);
  const [previewArtifactId, setPreviewArtifactId] = useStoredState<string | null>(`agentic-project-tracker.evidence.preview.${ticket.id}`, null);
  const [fullscreen, setFullscreen] = useState(false);
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [latestPerNode, setLatestPerNode] = useState(true);
  const [nodeFilter, setNodeFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const frontmatter = ticket.frontmatter!;
  const artifacts = [...(frontmatter.artifacts ?? [])].sort((left, right) => right.created_at.localeCompare(left.created_at));
  const runs = [...(frontmatter.workflow?.node_runs ?? [])].reverse();
  const outputRuns = runs.filter((run) => Boolean(run.output_path));
  const checkpoints = [...(frontmatter.checkpoints ?? [])].reverse();
  const attachments = frontmatter.attachments ?? [];
  const runById = new Map(runs.map((run) => [run.id, run]));
  const nodeName = (nodeId: string) => workflow?.nodes.find((node) => node.id === nodeId)?.name ?? humanize(nodeId);
  const reviewKinds = new Set(["evidence", "script_output", "script_artifact", "quality_report"]);
  const provenanceKinds = new Set(["agent_transcript", "harness_session_log"]);
  const reviewArtifacts = artifacts.filter((artifact) => reviewKinds.has(artifact.kind));
  const provenanceArtifacts = artifacts.filter((artifact) => provenanceKinds.has(artifact.kind));
  const traceArtifacts = artifacts.filter((artifact) => artifact.kind === "execution_trace");
  const technicalArtifacts = artifacts.filter((artifact) => !reviewKinds.has(artifact.kind) && !provenanceKinds.has(artifact.kind) && artifact.kind !== "execution_trace");
  const agentRuns = agentExecutionRuns(runs);
  const herdrRunIds = new Set(provenanceArtifacts.filter((artifact) => artifact.kind === "agent_transcript" && artifact.node_run_id).map((artifact) => artifact.node_run_id!));
  const nativeRunIds = new Set(provenanceArtifacts.filter((artifact) => artifact.kind === "harness_session_log" && artifact.node_run_id).map((artifact) => artifact.node_run_id!));
  const provenanceRunIds = new Set([...herdrRunIds, ...nativeRunIds]);
  const traceRunIds = new Set(traceArtifacts.filter((artifact) => artifact.node_run_id).map((artifact) => artifact.node_run_id!));
  const manifestRunIds = new Set([
    ...artifacts.filter((artifact) => artifact.kind === "execution_manifest" && artifact.node_run_id).map((artifact) => artifact.node_run_id!),
    ...agentRuns.filter((run) => run.manifest_artifact_id).map((run) => run.id),
  ]);
  const traceGroups = [...traceArtifacts.reduce((groups, artifact) => {
    const key = String(artifact.metadata.trace_id ?? artifact.id);
    groups.set(key, [...(groups.get(key) ?? []), artifact]);
    return groups;
  }, new Map<string, TicketArtifact[]>()).values()];
  const nodeOptions = [...new Set(reviewArtifacts.flatMap((artifact) => { const run = artifact.node_run_id ? runById.get(artifact.node_run_id) : null; return run ? [run.node_id] : []; }))].sort();
  const categoryOptions = [...new Set(reviewArtifacts.map((artifact) => artifactPresentation(artifact).category).filter((value): value is string => Boolean(value)))].sort();
  const typeOptions = [...new Set(reviewArtifacts.map((artifact) => artifact.content_type))].sort();
  let filteredReview = reviewArtifacts.filter((artifact) => {
    const run = artifact.node_run_id ? runById.get(artifact.node_run_id) : null;
    return (!featuredOnly || artifactPresentation(artifact).featured === true)
      && (!nodeFilter || run?.node_id === nodeFilter)
      && (!categoryFilter || artifactPresentation(artifact).category === categoryFilter)
      && (!typeFilter || artifact.content_type === typeFilter);
  });
  if (latestPerNode) {
    const seen = new Set<string>();
    filteredReview = filteredReview.filter((artifact) => {
      const run = artifact.node_run_id ? runById.get(artifact.node_run_id) : null;
      const key = run?.node_id ?? artifact.node_run_id ?? artifact.id;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  filteredReview.sort((left, right) => Number(Boolean(artifactPresentation(right).featured)) - Number(Boolean(artifactPresentation(left).featured)) || right.created_at.localeCompare(left.created_at));
  const tabs: Array<{ id: EvidenceTab; label: string; count: number }> = [
    { id: "review", label: "Review packet", count: reviewArtifacts.length + outputRuns.length },
    { id: "provenance", label: "Provenance", count: provenanceArtifacts.length },
    { id: "runs", label: "Run history", count: runs.length },
    { id: "traces", label: "Operational traces", count: traceGroups.length },
    { id: "technical", label: "Technical artifacts", count: technicalArtifacts.length },
    { id: "checkpoints", label: "Checkpoints", count: checkpoints.length },
    { id: "attachments", label: "Attachments", count: attachments.length },
  ];
  const previewItems = tab === "review" ? filteredReview : tab === "provenance" ? provenanceArtifacts : tab === "technical" ? technicalArtifacts : [];
  const movePreview = (items: typeof artifacts, delta: number) => {
    if (!items.length) return;
    const currentIndex = Math.max(0, items.findIndex((artifact) => artifact.id === previewArtifactId));
    setPreviewArtifactId(items[(currentIndex + delta + items.length) % items.length]!.id);
  };
  useEffect(() => {
    if (!fullscreen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [fullscreen]);
  const artifactList = (items: typeof artifacts) => items.length ? <div className="evidence-list">{items.map((artifact) => {
    const run = artifact.node_run_id ? runById.get(artifact.node_run_id) : undefined;
    const presentation = artifactPresentation(artifact);
    const previewing = previewArtifactId === artifact.id;
    const itemIndex = items.findIndex((candidate) => candidate.id === artifact.id);
    return <article className="evidence-item" key={artifact.id}><div className="evidence-kind"><span>{presentation.category ?? humanize(artifact.kind)}</span><small>{artifact.content_type}</small></div><div><strong>{artifactTitle(artifact)}{presentation.featured ? " · Featured" : ""}</strong>{presentation.description && <p>{presentation.description}</p>}<small>{artifact.filename} · {fileSize(artifact.size_bytes)} · {timeAgo(artifact.created_at, now)}{run ? ` · ${nodeName(run.node_id)} attempt ${run.attempt}` : ""}</small><code>sha256:{artifact.sha256}</code></div><div className="evidence-actions"><button type="button" aria-expanded={previewing} onClick={() => setPreviewArtifactId(previewing ? null : artifact.id)}>{previewing ? "Close preview" : "Preview"}</button><a href={api.artifactUrl(frontmatter.id, artifact.id)} target="_blank" rel="noreferrer">Open ↗</a><a href={api.artifactUrl(frontmatter.id, artifact.id, true)}>Download</a></div>{previewing && <div className="evidence-inline-preview"><div className="artifact-preview-toolbar"><span>{itemIndex + 1} of {items.length}</span><button disabled={items.length < 2} onClick={() => movePreview(items, -1)}>← Previous</button><button disabled={items.length < 2} onClick={() => movePreview(items, 1)}>Next →</button><button onClick={() => setFullscreen(true)}>Fullscreen</button></div><ArtifactPreview ticketId={frontmatter.id} artifact={artifact} /></div>}</article>;
  })}</div> : <div className="evidence-empty">No evidence is available in this category.</div>;
  const runList = runs.length ? <div className="run-evidence-list">{runs.map((run) => <details className="run-evidence" key={run.id}><summary><span><strong>{nodeName(run.node_id)}</strong><small>{humanize(run.node_type)} · visit {run.visit} · attempt {run.attempt}{run.conversation_generation ? ` · conversation g${run.conversation_generation}` : ""}</small></span><span><StatusPill value={run.status} subtle /><small>{run.outcome ? humanize(run.outcome) : "No outcome"}</small></span></summary><div className="run-evidence-body"><NodeTimingDetails run={run} now={now} />{run.telemetry && <TelemetryDetails telemetry={run.telemetry} compact />}{(run.supervisor_id || run.provider) && <p><strong>Executor</strong>{[run.supervisor_id, run.provider && humanize(run.provider)].filter(Boolean).join(" · ")}</p>}{run.lease_id && <p><strong>Lease / run</strong><code>{run.lease_id} · {run.id}</code></p>}<p><strong>Workflow revision</strong><code>{run.workflow_revision}{run.input_revision === undefined ? "" : ` · ticket r${run.input_revision}`}</code></p>{run.wait && <p><strong>Durable wait</strong>Wake {timeAgo(run.wait.wake_at, now)} · deadline {timeAgo(run.wait.deadline_at, now)} · {run.wait.delay_seconds}s delay</p>}{run.summary && <p><strong>Summary</strong>{run.summary}</p>}{run.handoff && <p><strong>Handoff</strong>{run.handoff}</p>}{run.script_path && <p><strong>Script</strong><code>{run.script_path}</code></p>}{run.working_directory && <p><strong>Working directory</strong><code>{run.working_directory}</code></p>}{Object.keys(run.metadata_writes ?? {}).length > 0 && <p><strong>Metadata writes</strong><code>{JSON.stringify(run.metadata_writes)}</code></p>}{(run.external_references ?? []).map((reference) => <p key={`${reference.type}:${reference.id}`}><strong>{humanize(reference.type)}</strong>{reference.url ? <a href={reference.url} target="_blank" rel="noreferrer">{reference.id} ↗</a> : reference.id}</p>)}<div className="evidence-actions">{run.output_path && <a href={`/api/tickets/${encodeURIComponent(frontmatter.id)}/runs/${encodeURIComponent(run.id)}/output`} target="_blank" rel="noreferrer">Full output ({fileSize(run.output_bytes ?? 0)}) ↗</a>}{run.manifest_artifact_id && <a href={api.artifactUrl(frontmatter.id, run.manifest_artifact_id)} target="_blank" rel="noreferrer">Execution manifest ↗</a>}</div></div></details>)}</div> : <div className="evidence-empty">No node runs have been recorded.</div>;
  const captureStatus = (captured: boolean) => <span className={`provenance-status ${captured ? "captured" : "missing"}`}>{captured ? "Captured" : "Missing"}</span>;
  const provenanceMatrix = agentRuns.length ? <div className="provenance-matrix"><div className="provenance-summary"><strong>{provenanceRunIds.size}/{agentRuns.length} runs have session provenance</strong><span>Native {nativeRunIds.size}/{agentRuns.length} · Herdr {herdrRunIds.size}/{agentRuns.length}</span></div><div className="provenance-table" role="table" aria-label="Agent run provenance coverage"><div className="provenance-row provenance-header" role="row"><span role="columnheader">Agent run</span><span role="columnheader">Native session</span><span role="columnheader">Herdr transcript</span><span role="columnheader">Operational trace</span><span role="columnheader">Manifest</span></div>{agentRuns.map((run) => <div className="provenance-row" role="row" key={run.id}><span role="cell"><strong>{nodeName(run.node_id)}</strong><small>Visit {run.visit} · attempt {run.attempt}</small></span><span role="cell">{captureStatus(nativeRunIds.has(run.id))}</span><span role="cell">{captureStatus(herdrRunIds.has(run.id))}</span><span role="cell">{captureStatus(traceRunIds.has(run.id))}</span><span role="cell">{captureStatus(manifestRunIds.has(run.id))}</span></div>)}</div></div> : <div className="evidence-empty">No executed agent runs are available for provenance coverage.</div>;
  return <section className="content-card evidence-card" aria-label="Evidence and artifacts">
    <div className="section-heading"><div><span>Durable execution record</span><h2>Evidence &amp; artifacts</h2><p>Review readable evidence first; transcripts and native session records are grouped as execution provenance.</p></div><strong>{provenanceRunIds.size}/{agentRuns.length} runs with session provenance · Native {nativeRunIds.size}/{agentRuns.length} · Herdr {herdrRunIds.size}/{agentRuns.length} · {artifacts.length} stored</strong></div>
    <div className="evidence-tabs" role="tablist" aria-label="Evidence categories">{tabs.map((item) => <button type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}>{item.label}<span>{item.count}</span></button>)}</div>
    <div className="evidence-panel" role="tabpanel">
      {tab === "review" && <><div className="artifact-review-filters"><label><input type="checkbox" checked={featuredOnly} onChange={(event) => setFeaturedOnly(event.target.checked)} /> Featured only</label><label><input type="checkbox" checked={latestPerNode} onChange={(event) => setLatestPerNode(event.target.checked)} /> Latest from each node</label><select aria-label="Artifact node" value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)}><option value="">All nodes</option>{nodeOptions.map((node) => <option value={node} key={node}>{nodeName(node)}</option>)}</select><select aria-label="Artifact category" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">All categories</option>{categoryOptions.map((category) => <option value={category} key={category}>{humanize(category)}</option>)}</select><select aria-label="Artifact type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">All types</option>{typeOptions.map((type) => <option value={type} key={type}>{type}</option>)}</select></div>{outputRuns.length > 0 && <div className="persisted-output-list">{outputRuns.map((run) => <a key={run.id} href={`/api/tickets/${encodeURIComponent(frontmatter.id)}/runs/${encodeURIComponent(run.id)}/output`} target="_blank" rel="noreferrer"><span><strong>{nodeName(run.node_id)} output</strong><small>Visit {run.visit} · attempt {run.attempt} · {fileSize(run.output_bytes ?? 0)}</small></span><span>Open ↗</span></a>)}</div>}{artifactList(filteredReview)}</>}
      {tab === "provenance" && <>{provenanceMatrix}{artifactList(provenanceArtifacts)}</>}
      {tab === "runs" && runList}
      {tab === "traces" && (traceGroups.length ? <div className="run-evidence-list">{traceGroups.map((group) => { const run = group[0]?.node_run_id ? runById.get(group[0].node_run_id) : undefined; return <OperationalTrace key={String(group[0]?.metadata.trace_id ?? group[0]?.id)} ticketId={frontmatter.id} artifacts={group} {...(run ? { run } : {})} now={now} nodeName={nodeName} />; })}</div> : <div className="evidence-empty">No Herdr operational traces have been recorded.</div>)}
      {tab === "technical" && artifactList(technicalArtifacts)}
      {tab === "checkpoints" && <><div className="checkpoint-toolbar">{workflow?.nodes.filter((node) => node.type === "checkpoint").map((node) => <button key={node.id} className="button-secondary button-compact" disabled={busy || Boolean(frontmatter.execution?.interrupt_request)} onClick={() => onCreateCheckpoint(node.id)}>＋ {node.name}</button>)}</div>{checkpoints.length ? <div className="evidence-list">{checkpoints.map((checkpoint) => <article className="checkpoint-evidence" key={checkpoint.id}><header><span><strong>{checkpoint.label}</strong><small>{humanize(checkpoint.kind)} · {timeAgo(checkpoint.created_at, now)} · {checkpoint.id}</small></span><a href={api.artifactUrl(frontmatter.id, checkpoint.manifest_artifact_id)} target="_blank" rel="noreferrer">Manifest ↗</a></header>{checkpoint.repositories.map((repository) => <div key={repository.repository}><span><strong>{repository.repository}</strong><small>{repository.branch ?? "detached"} · {repository.dirty ? "working changes included" : "clean"}</small></span><code>{repository.snapshot_sha}</code><a href={api.artifactUrl(frontmatter.id, repository.bundle_artifact_id, true)}>Bundle</a></div>)}<footer>{workflow?.nodes.filter((node) => node.type === "restore_checkpoint").map((node) => <button key={node.id} className="button-secondary button-compact" disabled={busy || Boolean(frontmatter.execution?.interrupt_request)} onClick={() => { if (window.confirm(`Restore ${checkpoint.label}? Current repository state will first be checkpointed.`)) onRestoreCheckpoint(node.id, checkpoint.id); }}>Restore via {node.name}</button>)}</footer></article>)}</div> : <div className="evidence-empty">No checkpoints have been recorded.</div>}</>}
      {tab === "attachments" && <><div className="attachment-evidence-toolbar"><p>Supporting files are materialized into every new assignment bundle.</p><label className="attachment-picker compact"><input aria-label="Add ticket attachments" type="file" multiple disabled={busy} onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) onUpload(files); event.target.value = ""; }} /><span>＋ Add files</span></label></div>{attachments.length ? <div className="attachment-grid">{attachments.map((attachment) => { const source = api.attachmentUrl(ticket.id, attachment.id); return <article className="attachment-item" key={attachment.id}>{attachment.content_type.startsWith("image/") && <a className="attachment-preview" href={source} target="_blank" rel="noreferrer"><img src={source} alt={attachment.filename} /></a>}<div><a href={api.attachmentUrl(ticket.id, attachment.id, true)}><strong>{attachment.filename}</strong></a><small>{fileSize(attachment.size_bytes)} · {attachment.content_type}</small></div><button className="icon-button" aria-label={`Remove ${attachment.filename}`} disabled={busy} onClick={() => onRemoveAttachment(attachment.id)}>×</button></article>; })}</div> : <div className="evidence-empty">No files are attached to this ticket.</div>}</>}
    </div>
    {fullscreen && previewArtifactId && artifacts.find((artifact) => artifact.id === previewArtifactId) && <div className="artifact-fullscreen" role="dialog" aria-modal="true" aria-label={`Artifact preview: ${artifactTitle(artifacts.find((artifact) => artifact.id === previewArtifactId)!)}`}><header><div><span>{tab === "technical" ? "Technical artifact" : tab === "provenance" ? "Execution provenance" : "Review material"}</span><h2>{artifactTitle(artifacts.find((artifact) => artifact.id === previewArtifactId)!)}</h2></div><div><button disabled={previewItems.length < 2} onClick={() => movePreview(previewItems, -1)}>← Previous</button><button disabled={previewItems.length < 2} onClick={() => movePreview(previewItems, 1)}>Next →</button><button className="button-primary" onClick={() => setFullscreen(false)}>Close</button></div></header><ArtifactPreview ticketId={frontmatter.id} artifact={artifacts.find((artifact) => artifact.id === previewArtifactId)!} /></div>}
  </section>;
}

function TicketEditor({ draft, setDraft, existing, busy, onSave, onCancel, onReady, onCustomizeWorkflow, onMigrateWorkflow, readyDisabled = false, repositories, workflows = [], workflowReleases, existingAttachments = [], onRemoveAttachment }: {
  draft: TicketDraft; setDraft: React.Dispatch<React.SetStateAction<TicketDraft>>; existing: boolean; busy: boolean;
  onSave: () => void; onCancel: () => void; onReady?: () => void; onCustomizeWorkflow?: () => void; onMigrateWorkflow?: () => void; readyDisabled?: boolean; repositories?: RepositoryConfig[]; workflows?: WorkflowDocument[]; workflowReleases?: WorkflowReleaseCatalog;
  existingAttachments?: TicketFrontmatter["attachments"]; onRemoveAttachment?: (id: string) => void;
}) {
  const [showValidation, setShowValidation] = useState(false);
  const validationErrors = draftErrors(draft);
  const availableReleases = workflowReleases?.releases.filter((release) => release.workflow_id === draft.workflowId && release.status !== "retired") ?? [];
  const selectedRelease = availableReleases.find((release) => release.revision === draft.workflowRevision)
    ?? availableReleases.find((release) => release.is_default);
  const selectedWorkflow = selectedRelease?.definition ?? workflows.find((workflow) => workflow.definition.id === draft.workflowId)?.definition;
  const update = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const selectWorkflow = (workflowId: string) => {
    const release = workflowReleases?.releases.find((item) => item.workflow_id === workflowId && item.is_default);
    const workflow = release?.definition ?? workflows.find((item) => item.definition.id === workflowId)?.definition;
    setDraft((current) => ({
      ...current, workflowId, workflowRevision: release?.revision ?? "",
      workflowInputs: Object.fromEntries(workflow?.inputs.map((input) => [input.id, input.default]) ?? []),
      stageEnabled: Object.fromEntries(workflow?.stages.map((stage) => [stage.id, stage.skippable ? stage.default_enabled : true]) ?? []),
    }));
  };
  const selectRevision = (revision: string) => {
    const release = availableReleases.find((item) => item.revision === revision);
    if (!release) return;
    setDraft((current) => ({ ...current, workflowRevision: revision,
      workflowInputs: Object.fromEntries(release.definition.inputs.map((input) => [input.id, input.default])),
      stageEnabled: Object.fromEntries(release.definition.stages.map((stage) => [stage.id, stage.skippable ? stage.default_enabled : true])),
    }));
  };
  const setStageEnabled = (stage: WorkflowDocument["definition"]["stages"][number], enabled: boolean) => setDraft((current) => ({
    ...current, stageEnabled: { ...current.stageEnabled, [stage.id]: stage.skippable ? enabled : true },
  }));
  const updateRepository = (index: number, patch: Partial<{ id: string; primary: boolean }>) => setDraft((current) => ({
    ...current,
    repositories: current.repositories.map((repository, candidate) => candidate === index ? { ...repository, ...patch } : patch.primary ? { ...repository, primary: false } : repository),
  }));
  const attempt = (action: () => void) => {
    if (validationErrors.length) {
      setShowValidation(true);
      return;
    }
    action();
  };
  return <div className="editor-page">
    <div className="issue-heading"><div><span className="issue-key">{existing ? draft.id : "New ticket"}</span><h1>{existing ? "Edit work ticket" : "Create work ticket"}</h1><p>Core fields are editable while pending. A live ticket's description can still be updated with guidance or a workflow restart.</p></div></div>
    {showValidation && validationErrors.length > 0 && <div className="draft-validation" role="alert"><strong>Finish these fields before saving</strong><ul>{validationErrors.map((validationError) => <li key={validationError}>{validationError}</li>)}</ul></div>}
    <div className="form-grid">
      <section className="form-card form-main">
        <label>Title<input aria-label="Title" value={draft.title} onChange={(event) => update("title", event.target.value)} /></label>
        <label>Ticket ID <span>{existing ? "Ticket IDs cannot be changed after creation" : draft.jira ? "Imported from Jira" : draft.autoId ? "Suggested automatically; edit to use a custom ID" : "Custom ticket ID"}</span><input aria-label="Ticket ID" disabled={existing || draft.jira !== null} value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value, autoId: false }))} /></label>
        <label>Description <span>Markdown supported</span><textarea className="description-editor" aria-label="Description" value={draft.description} onChange={(event) => update("description", event.target.value)} /></label>
        <div className="ticket-attachments-editor">
          <div><strong>Attachments</strong><span>Images, documents, logs, and other supporting files · 25 MB each</span></div>
          <label className="attachment-picker"><input aria-label="Ticket attachments" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); update("attachmentFiles", [...draft.attachmentFiles, ...files]); event.target.value = ""; }} /><span>＋ Choose files</span></label>
          {(existingAttachments.length > 0 || draft.attachmentFiles.length > 0) && <div className="attachment-edit-list">
            {existingAttachments.map((attachment) => <div key={attachment.id}><span><strong>{attachment.filename}</strong><small>{fileSize(attachment.size_bytes)}</small></span>{onRemoveAttachment && <button type="button" className="icon-button" aria-label={`Remove ${attachment.filename}`} disabled={busy} onClick={() => onRemoveAttachment(attachment.id)}>×</button>}</div>)}
            {draft.attachmentFiles.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`}><span><strong>{file.name}</strong><small>{fileSize(file.size)} · uploads when saved</small></span><button type="button" className="icon-button" aria-label={`Remove queued ${file.name}`} onClick={() => update("attachmentFiles", draft.attachmentFiles.filter((_, candidate) => candidate !== index))}>×</button></div>)}
          </div>}
        </div>
      </section>
      <aside className="form-card form-properties">
        <h2>Work settings</h2>
        <label>Ticket priority <span>Higher numbers are scheduled first</span><input aria-label="Ticket priority" title="Higher numbers are scheduled before lower numbers" type="number" value={draft.priority} onChange={(event) => update("priority", Number(event.target.value))} /></label>
        <label>Estimated human days <span>Optional comparison baseline</span><input aria-label="Estimated human days" type="number" min="0" step="0.25" value={draft.estimatedHumanDays ?? ""} onChange={(event) => update("estimatedHumanDays", event.target.value === "" ? null : Number(event.target.value))} /></label>
        <label>Labels <span>Comma separated</span><input aria-label="Labels" value={draft.labels} onChange={(event) => update("labels", event.target.value)} /></label>
        <label>Workflow<select aria-label="Workflow" disabled={existing} value={draft.workflowId} onChange={(event) => selectWorkflow(event.target.value)}>{workflows.filter((workflow) => workflow.valid).map((workflow) => <option key={workflow.definition.id} value={workflow.definition.id}>{workflow.definition.name}</option>)}</select><span>{existing ? "Pinned when the ticket was created" : "A versioned workflow revision will be pinned"}</span></label>
        {!existing && availableReleases.length > 0 && <label>Workflow revision<select aria-label="Workflow revision" value={selectedRelease?.revision ?? ""} onChange={(event) => selectRevision(event.target.value)}>{availableReleases.map((release) => <option key={release.revision} value={release.revision}>{releaseDisplayLabel(release)}</option>)}</select><span>Default revisions are used automatically; trial revisions are pinned only to this ticket.</span></label>}
      </aside>
      {selectedWorkflow && (selectedWorkflow.inputs.length > 0 || selectedWorkflow.stages.length > 0) && <section className="form-card workflow-ticket-options"><div className="section-heading"><div><span>Workflow</span><h2>Ticket path</h2></div></div>
        {selectedWorkflow.stages.length > 0 && <div className="ticket-stage-options"><h3>Stages</h3>{selectedWorkflow.stages.map((stage) => <label className="toggle" key={stage.id}><input type="checkbox" disabled={!stage.skippable} checked={stage.skippable ? draft.stageEnabled[stage.id] ?? stage.default_enabled : true} onChange={(event) => setStageEnabled(stage, event.target.checked)} /><span><strong>{stage.name}</strong><small>{stage.skippable ? `Configurable · bypasses to ${selectedWorkflow.nodes.find((node) => node.id === stage.bypass_to)?.name ?? stage.bypass_to}` : "Required stage"}</small></span></label>)}</div>}
        {selectedWorkflow.inputs.length > 0 && <div className="ticket-input-options"><h3>Conditions & parameters</h3>{selectedWorkflow.inputs.map((input) => <label key={input.id}>{input.label}{input.type === "boolean" ? <select aria-label={input.label} value={String(draft.workflowInputs[input.id] ?? input.default)} onChange={(event) => update("workflowInputs", { ...draft.workflowInputs, [input.id]: event.target.value === "true" })}><option value="true">Enabled</option><option value="false">Disabled</option></select> : input.type === "text" ? <input aria-label={input.label} value={String(draft.workflowInputs[input.id] ?? input.default)} onChange={(event) => update("workflowInputs", { ...draft.workflowInputs, [input.id]: event.target.value })} /> : <select aria-label={input.label} value={String(draft.workflowInputs[input.id] ?? input.default)} onChange={(event) => update("workflowInputs", { ...draft.workflowInputs, [input.id]: event.target.value })}>{input.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</label>)}</div>}
      </section>}
      <section className="form-card repositories-editor">
        <div className="section-heading"><div><span>Scope</span><h2>Repositories</h2></div><button className="button-secondary" onClick={() => update("repositories", [...draft.repositories, { id: "", primary: false }])}>Add repository</button></div>
        <p className="repository-help">Choose a configured repository or type any repository ID. Only configured repositories are cloned automatically.</p>
        {draft.repositories.map((repository, index) => <div className="repository-row" key={index}>
          <input list="configured-repositories" aria-label={`Repository ${index + 1}`} placeholder="Choose or type a repository ID" value={repository.id} onChange={(event) => updateRepository(index, { id: event.target.value })} />
          <label className="primary-radio"><input type="radio" name="primary" checked={repository.primary} onChange={() => updateRepository(index, { primary: true })} />Primary</label>
          {draft.repositories.length > 1 && <button className="icon-button" aria-label={`Remove repository ${index + 1}`} onClick={() => update("repositories", draft.repositories.filter((_, candidate) => candidate !== index))}>×</button>}
        </div>)}
        <datalist id="configured-repositories">{repositories?.map((repository) => <option key={repository.id} value={repository.id}>{repository.url}</option>)}</datalist>
      </section>
    </div>
    <div className="sticky-actions"><button className="button-secondary" onClick={onCancel}>Cancel</button>{existing && onCustomizeWorkflow && <button className="button-secondary" disabled={busy || readyDisabled} onClick={onCustomizeWorkflow}>Customize workflow</button>}{existing && onMigrateWorkflow && <button className="button-secondary" disabled={busy || readyDisabled} onClick={onMigrateWorkflow}>Pin workflow revision</button>}<button className="button-secondary" disabled={busy} onClick={() => attempt(onSave)}>{existing ? "Save ticket" : "Create ticket"}</button>{existing && onReady && <button className="button-primary" title={readyDisabled ? "Save changes before marking ready" : undefined} disabled={busy || readyDisabled} onClick={() => attempt(onReady)}>Mark ready</button>}</div>
  </div>;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function PriorityEditor({ value, busy, onSave }: { value: number; busy: boolean; onSave: (priority: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const priority = Number(draft);
  const valid = draft.trim() !== "" && Number.isInteger(priority);
  return <form className="priority-editor" onSubmit={(event) => { event.preventDefault(); if (valid && priority !== value) onSave(priority); }}>
    <input aria-label="Ticket priority" type="number" step="1" value={draft} onChange={(event) => setDraft(event.target.value)} />
    <button className="button-secondary button-compact" type="submit" disabled={busy || !valid || priority === value}>Update</button>
  </form>;
}

function HumanEstimateEditor({ value, busy, onSave }: { value: number | null; busy: boolean; onSave: (days: number | null) => void }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);
  const days = draft.trim() === "" ? null : Number(draft);
  const valid = days === null || Number.isFinite(days) && days >= 0;
  const unchanged = days === value;
  return <form className="priority-editor" onSubmit={(event) => { event.preventDefault(); if (valid && !unchanged) onSave(days); }}>
    <input aria-label="Estimated human days" type="number" min="0" step="0.25" placeholder="Not set" value={draft} onChange={(event) => setDraft(event.target.value)} />
    <button className="button-secondary button-compact" type="submit" disabled={busy || !valid || unchanged}>Update</button>
  </form>;
}

function tokenCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unavailable";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function aggregateTokenUsage(runs: TicketNodeRun[]): TokenUsage | null {
  const usage = runs.flatMap((run) => run.telemetry?.delta.usage ? [run.telemetry.delta.usage] : []);
  if (!usage.length) return null;
  return usage.reduce<TokenUsage>((total, item) => ({
    input_tokens: total.input_tokens + item.input_tokens,
    cached_input_tokens: total.cached_input_tokens + item.cached_input_tokens,
    cache_write_input_tokens: total.cache_write_input_tokens + item.cache_write_input_tokens,
    output_tokens: total.output_tokens + item.output_tokens,
    reasoning_output_tokens: total.reasoning_output_tokens + item.reasoning_output_tokens,
    total_tokens: total.total_tokens + item.total_tokens,
  }), { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });
}

function compactTokenBreakdown(usage: TokenUsage | null | undefined): string {
  if (!usage) return "Tokens unavailable";
  return `Uncached ${tokenCount(usage.input_tokens)} · Cached ${tokenCount(usage.cached_input_tokens)} · Write ${tokenCount(usage.cache_write_input_tokens)} · Output ${tokenCount(usage.output_tokens)}${usage.reasoning_output_tokens > 0 ? ` · Reasoning ${tokenCount(usage.reasoning_output_tokens)}` : ""}`;
}

function costLabel(kinds: Array<HarnessTelemetryRecord["latest"]["cost"]["kind"]>): string {
  const available = kinds.filter((kind) => kind !== "unavailable");
  if (!available.length) return "Cost";
  if (available.length && available.every((kind) => kind === "estimated")) return "Estimated cost";
  if (available.length && available.every((kind) => kind === "reported")) return "Reported cost";
  return "Known cost";
}

type TicketNodeRun = NonNullable<TicketFrontmatter["workflow"]>["node_runs"][number];

function agentExecutionRuns(runs: TicketNodeRun[]): TicketNodeRun[] {
  return runs.filter((run) => run.node_type === "agent"
    && run.attempt > 0 && run.outcome !== "bypassed" && run.outcome !== "delivery_failed");
}

function nodeTiming(run: TicketNodeRun, now: number) {
  let activeMs = run.timing.active_ms;
  let quotaPausedMs = run.timing.quota_paused_ms;
  let humanWaitMs = run.timing.human_wait_ms;
  let externalWaitMs = run.timing.external_wait_ms ?? 0;
  if (run.status === "running" && run.timing.last_accounted_at) {
    const prior = Date.parse(run.timing.last_accounted_at);
    if (Number.isFinite(prior) && now > prior) {
      let elapsed = now - prior;
      if (run.timing.state === "quota_paused") {
        const reset = run.timing.pause_until ? Date.parse(run.timing.pause_until) : Number.NaN;
        const paused = Number.isFinite(reset) ? Math.max(0, Math.min(now, reset) - prior) : elapsed;
        quotaPausedMs += paused;
        elapsed -= paused;
        activeMs += elapsed;
      } else if (run.timing.state === "human_wait") humanWaitMs += elapsed;
      else if (run.timing.state === "external_wait") externalWaitMs += elapsed;
      else activeMs += elapsed;
    }
  }
  const end = run.completed_at ? Date.parse(run.completed_at) : now;
  const wallMs = Math.max(0, end - Date.parse(run.started_at));
  return { activeMs, quotaPausedMs, humanWaitMs, externalWaitMs, wallMs };
}

function NodeTimingDetails({ run, now }: { run: TicketNodeRun; now: number }) {
  const timing = nodeTiming(run, now);
  const parts = [`${duration(timing.wallMs)} wall`];
  if (timing.activeMs > 0 || run.node_type === "agent" || isDeterministicActivity(run.node_type)) parts.push(`${duration(timing.activeMs)} active`);
  if (timing.quotaPausedMs > 0 || run.timing.state === "quota_paused") parts.push(`${duration(timing.quotaPausedMs)} quota paused`);
  if (timing.humanWaitMs > 0 || run.node_type === "human_gate") parts.push(`${duration(timing.humanWaitMs)} human wait`);
  if (timing.externalWaitMs > 0 || run.node_type === "wait") parts.push(`${duration(timing.externalWaitMs)} external wait`);
  return <small className="run-telemetry">{parts.join(" · ")}{run.timing.state === "quota_paused" && run.timing.pause_until ? ` · resets in ${duration(Date.parse(run.timing.pause_until) - now)}` : ""}</small>;
}

function TelemetryDetails({ telemetry, compact = false }: { telemetry: HarnessTelemetryRecord; compact?: boolean }) {
  const { latest, delta } = telemetry;
  const reasoning = latest.reasoning.effort
    ? `${latest.reasoning.effort}${latest.reasoning.source === "current_configuration" ? " (current config)" : ""}`
    : latest.reasoning.enabled === true ? "Enabled" : latest.reasoning.enabled === false ? "Disabled" : "Unavailable";
  if (compact) return <small className="run-telemetry">
    {[latest.model.id ?? latest.harness, reasoning, compactTokenBreakdown(delta.usage), delta.cost_usd !== null ? `${costLabel([latest.cost.kind])} ${usd(delta.cost_usd)}` : "Cost unavailable"].join(" · ")}
  </small>;
  const attributes = Object.entries(latest.attributes).filter(([, value]) => value !== null).slice(0, 6);
  return <div className="telemetry-details">
    <div className="telemetry-heading"><span>Harness telemetry</span><small>{latest.cost.kind === "unavailable" ? "Cost not reported by harness" : `${humanize(latest.cost.kind)} cost`}</small></div>
    <div className="metric-grid telemetry-metrics">
      <div><span>Uncached input</span><strong>{tokenCount(delta.usage?.input_tokens)}</strong></div>
      <div><span>Cached input</span><strong>{tokenCount(delta.usage?.cached_input_tokens)}</strong></div>
      <div><span>Cache write</span><strong>{tokenCount(delta.usage?.cache_write_input_tokens)}</strong></div>
      <div><span>Output tokens</span><strong>{tokenCount(delta.usage?.output_tokens)}</strong></div>
      <div><span>Reasoning output</span><strong>{tokenCount(delta.usage?.reasoning_output_tokens)}</strong></div>
      <div><span>{costLabel([latest.cost.kind])}</span><strong>{usd(delta.cost_usd)}</strong></div>
    </div>
    <dl className="details-list">
      <DetailRow label="Harness">{humanize(latest.harness)}</DetailRow>
      <DetailRow label="Exact model"><code>{latest.model.id ?? "Unavailable"}</code></DetailRow>
      {latest.model.observed_ids.length > 1 && <DetailRow label="Models used">{latest.model.observed_ids.map((model) => <code key={model}>{model} </code>)}</DetailRow>}
      <DetailRow label="Reasoning">{reasoning}</DetailRow>
      {delta.usage && <DetailRow label="Total observed tokens">{tokenCount(delta.usage.total_tokens)}</DetailRow>}
      {latest.cost.pricing_id && <DetailRow label="Pricing"><a href={latest.cost.source ?? undefined} target="_blank" rel="noreferrer"><code>{latest.cost.pricing_id}</code>{latest.cost.effective_at ? ` · ${latest.cost.effective_at.slice(0, 10)}` : ""}</a></DetailRow>}
      {latest.context.window_tokens !== null && <DetailRow label="Context">{tokenCount(latest.context.used_tokens)} / {tokenCount(latest.context.window_tokens)}{latest.context.used_percent !== null ? ` (${latest.context.used_percent.toFixed(1)}%)` : ""}</DetailRow>}
      <DetailRow label="Observed">{timeAgo(latest.observed_at, Date.now())}</DetailRow>
    </dl>
    {latest.rate_limits.length > 0 && <div className="rate-limit-list">{latest.rate_limits.map((limit) => <div key={limit.id}><span>{limit.name ?? humanize(limit.id)}</span><strong>{limit.used_percent.toFixed(0)}%</strong><progress max="100" value={Math.min(100, limit.used_percent)} />{limit.resets_at && <small>{Date.parse(limit.resets_at) > Date.now() ? `Resets in ${duration(Date.parse(limit.resets_at) - Date.now())}` : `Reset ${timeAgo(limit.resets_at, Date.now())}`}</small>}</div>)}</div>}
    {attributes.length > 0 && <div className="telemetry-attributes">{attributes.map(([key, value]) => <span key={key}><small>{humanize(key)}</small>{String(value)}</span>)}</div>}
  </div>;
}

function TicketUsage({ ticket, now, humanDayRate }: { ticket: TicketFrontmatter; now: number; humanDayRate: number }) {
  const agentRuns = agentExecutionRuns(ticket.workflow?.node_runs ?? []);
  const measured = agentRuns.filter((run) => run.telemetry);
  const usage = aggregateTokenUsage(measured);
  const tokenCoverage = measured.filter((run) => run.telemetry?.delta.usage).length;
  const costRuns = measured.filter((run) => run.telemetry?.delta.cost_usd !== null);
  const totalCost = costRuns.reduce((sum, run) => sum + (run.telemetry?.delta.cost_usd ?? 0), 0);
  const estimatedCostRuns = costRuns.filter((run) => run.telemetry?.latest.cost.kind === "estimated").length;
  const models = [...new Set(measured.flatMap((run) => run.telemetry?.latest.model.observed_ids ?? []))];
  const runTimings = (ticket.workflow?.node_runs ?? []).map((run) => nodeTiming(run, now));
  const activeMs = runTimings.reduce((sum, timing) => sum + timing.activeMs, 0);
  const quotaPausedMs = runTimings.reduce((sum, timing) => sum + timing.quotaPausedMs, 0);
  const humanWaitMs = runTimings.reduce((sum, timing) => sum + timing.humanWaitMs, 0);
  const workflowElapsed = ticket.workflow ? Math.max(0, Date.parse(ticket.workflow.completed_at ?? new Date(now).toISOString()) - Date.parse(ticket.workflow.started_at)) : 0;
  const humanCost = ticket.estimated_human_days === null ? null : ticket.estimated_human_days * humanDayRate;
  const completeCost = agentRuns.length > 0 && costRuns.length === agentRuns.length;
  if (!ticket.workflow?.node_runs.length && !measured.length) return null;
  return <section className="side-card" aria-label="Ticket usage">
    <div className="section-heading"><div><span>Accounting</span><h2>Ticket totals</h2></div></div>
    <div className="metric-grid telemetry-metrics">
      <div><span>Uncached input</span><strong>{tokenCount(usage?.input_tokens)}</strong></div>
      <div><span>Cached input</span><strong>{tokenCount(usage?.cached_input_tokens)}</strong></div>
      <div><span>Cache write</span><strong>{tokenCount(usage?.cache_write_input_tokens)}</strong></div>
      <div><span>Output tokens</span><strong>{tokenCount(usage?.output_tokens)}</strong></div>
      <div><span>Reasoning output</span><strong>{tokenCount(usage?.reasoning_output_tokens)}</strong></div>
      <div><span>{costLabel(costRuns.map((run) => run.telemetry!.latest.cost.kind))}</span><strong>{costRuns.length ? usd(totalCost) : "Unavailable"}</strong></div>
      <div><span>Workflow elapsed</span><strong>{duration(workflowElapsed)}</strong></div>
      <div><span>Active runtime</span><strong>{duration(activeMs)}</strong></div>
      <div><span>Quota paused</span><strong>{duration(quotaPausedMs)}</strong></div>
      <div><span>Human wait</span><strong>{duration(humanWaitMs)}</strong></div>
      <div><span>Human estimate</span><strong>{ticket.estimated_human_days === null ? "Not set" : `${ticket.estimated_human_days}d · ${usd(humanCost)}`}</strong></div>
      <div><span>Estimated savings</span><strong>{humanCost !== null && completeCost ? usd(humanCost - totalCost) : "Unavailable"}</strong></div>
    </div>
    <p className="telemetry-coverage">Token coverage: {tokenCoverage}/{agentRuns.length} executed agent runs · Cost coverage: {costRuns.length}/{agentRuns.length}{estimatedCostRuns ? ` (${estimatedCostRuns} estimated)` : ""}. Bypassed nodes and assignment delivery failures are excluded. Subscription-backed harnesses may not expose per-ticket USD cost. Quota-pause accounting requires harness rate-limit telemetry; wall time does not.</p>
    {models.length > 0 && <div className="model-list">{models.map((model) => <code key={model}>{model}</code>)}</div>}
  </section>;
}

function ExecutionRecap({ ticket, workflow, now }: { ticket: TicketFrontmatter; workflow?: WorkflowDocument["definition"]; now: number }) {
  if (ticket.status !== "completed" || !ticket.workflow) return null;
  const runs = ticket.workflow.node_runs;
  const agentRuns = agentExecutionRuns(runs);
  const tokenRuns = agentRuns.filter((run) => run.telemetry?.delta.usage);
  const costRuns = agentRuns.filter((run) => run.telemetry?.delta.cost_usd !== null && run.telemetry?.delta.cost_usd !== undefined);
  const usage = aggregateTokenUsage(tokenRuns);
  const cost = costRuns.reduce((sum, run) => sum + (run.telemetry?.delta.cost_usd ?? 0), 0);
  const elapsed = Math.max(0, Date.parse(ticket.workflow.completed_at ?? new Date(now).toISOString()) - Date.parse(ticket.workflow.started_at));
  const operationalInterventions = runs.filter((run) => ["delivery_failed", "lease_lost", "operator_interrupt"].includes(run.outcome ?? "")).length;
  const humanGates = runs.filter((run) => run.node_type === "human_gate" && run.status === "completed").length;
  const interventions = ticket.questions.length + humanGates + operationalInterventions;
  const herdrAgentRuns = new Set((ticket.artifacts ?? []).filter((artifact) => artifact.kind === "agent_transcript" && artifact.node_run_id).map((artifact) => artifact.node_run_id));
  const nativeAgentRuns = new Set((ticket.artifacts ?? []).filter((artifact) => artifact.kind === "harness_session_log" && artifact.node_run_id).map((artifact) => artifact.node_run_id));
  const provenanceAgentRuns = new Set([...herdrAgentRuns, ...nativeAgentRuns]).size;
  const importantArtifacts = [...(ticket.artifacts ?? [])].filter((artifact) => ["evidence", "script_artifact", "quality_report", "script_output"].includes(artifact.kind)).sort((left, right) => Number(Boolean(artifactPresentation(right).featured)) - Number(Boolean(artifactPresentation(left).featured)) || right.created_at.localeCompare(left.created_at)).slice(0, 5);
  const productionResult = ticket.production_result ?? "unassessed";
  const nodeName = (id: string) => workflow?.nodes.find((node) => node.id === id)?.name ?? humanize(id);
  return <section className="execution-recap" aria-label="Execution recap">
    <div className="section-heading"><div><span>Completed workflow</span><h2>Execution recap</h2><p>A compact summary derived from the immutable node-run ledger and ticket artifacts.</p></div><StatusPill value={productionResult === "unassessed" ? "pending" : productionResult} /></div>
    <div className="recap-metrics"><div><span>Elapsed</span><strong>{duration(elapsed)}</strong></div><div><span>Uncached input</span><strong>{tokenCount(usage?.input_tokens)}</strong><small>{tokenRuns.length}/{agentRuns.length} executed agent runs</small></div><div><span>Cached input</span><strong>{tokenCount(usage?.cached_input_tokens)}</strong></div><div><span>Cache write</span><strong>{tokenCount(usage?.cache_write_input_tokens)}</strong></div><div><span>Output tokens</span><strong>{tokenCount(usage?.output_tokens)}</strong></div><div><span>Reasoning output</span><strong>{tokenCount(usage?.reasoning_output_tokens)}</strong></div><div><span>{costLabel(costRuns.map((run) => run.telemetry!.latest.cost.kind))}</span><strong>{costRuns.length ? usd(cost) : "Unavailable"}</strong><small>{costRuns.length}/{agentRuns.length} executed agent runs</small></div><div><span>Provenance coverage</span><strong>{provenanceAgentRuns}/{agentRuns.length}</strong><small>Native {nativeAgentRuns.size}/{agentRuns.length} · Herdr {herdrAgentRuns.size}/{agentRuns.length}</small></div><div><span>Interventions</span><strong>{interventions}</strong><small>{ticket.questions.length} questions · {humanGates} gates · {operationalInterventions} operational</small></div></div>
    <div className="recap-path"><span>Path taken</span><div>{runs.map((run, index) => <React.Fragment key={run.id}><span className={`recap-node recap-${run.status}`}>{nodeName(run.node_id)}<small>{run.outcome ? humanize(run.outcome) : humanize(run.status)}</small></span>{index < runs.length - 1 && <i aria-hidden="true">→</i>}</React.Fragment>)}</div></div>
    <div className="recap-columns"><div><span>Pull requests</span>{ticket.pull_requests.length ? ticket.pull_requests.map((pr) => <a href={pr.url} target="_blank" rel="noreferrer" key={pr.url}>{pr.repository} · {pr.phase ? humanize(pr.phase) : "PR"} ↗</a>) : <small>No PRs were reported.</small>}</div><div><span>Important evidence</span>{importantArtifacts.length ? importantArtifacts.map((artifact) => <a href={api.artifactUrl(ticket.id, artifact.id)} target="_blank" rel="noreferrer" key={artifact.id}>{artifactTitle(artifact)} ↗</a>) : <small>No review artifacts were published.</small>}</div><div><span>Production</span><strong>{humanize(productionResult)}</strong>{ticket.production_assessment_note && <small>{ticket.production_assessment_note}</small>}</div></div>
  </section>;
}

function RuntimePanel({ execution, now }: { execution: Execution; now: number }) {
  const activity = isDeterministicActivity(execution.node_type);
  const herdr = execution.herdr_observation;
  const herdrState = herdr?.state ?? execution.observed_herdr_state ?? "unobserved";
  const deliveryStatus = execution.delivery_status ?? "delivered";
  const state = activity || deliveryStatus === "delivered" ? "running" : "starting";
  const warning = runtimeWarning(execution, now);
  const title = herdr?.terminal_title_stripped ?? herdr?.terminal_title;
  const runtimeName = activity ? humanize(execution.node_id ?? execution.node_type ?? "activity") : herdr?.display_name ?? execution.provider ?? "Agent";
  const runtimeLabel = state === "running" ? (activity ? "Executing" : "Active") : "Starting";
  return <section className="side-card runtime-panel">
    <div className="section-heading runtime-heading"><div><span>{activity ? "Deterministic activity" : "Agent runtime"}</span><h2 title={runtimeName}>{runtimeName}</h2></div><StatusPill value={state} label={runtimeLabel} /></div>
    {title && <p className="activity-title">{title}</p>}
    {!activity && deliveryStatus === "starting" && <p className="activity-title">Preparing the agent and confirming assignment delivery.</p>}
    {execution.interrupt_request && <div className="attention-banner"><strong>{execution.interrupt_request.reason_code === "cost_limit_exceeded" ? "Cost limit reached" : "Interrupt requested"}</strong><span>{execution.interrupt_request.reason_code === "cost_limit_exceeded"
      ? `This node has accumulated ${usd(execution.interrupt_request.cost_observed_usd)} against a ${usd(execution.interrupt_request.cost_limit_usd)} limit. Waiting for ${activity ? "the running script" : "Herdr"} to stop before pausing the ticket.`
      : `Waiting for ${activity ? "the running script" : "Herdr"} to stop before ${execution.interrupt_request.terminal_status ? `marking the ticket ${execution.interrupt_request.terminal_status}` : `restarting at ${humanize(execution.interrupt_request.target_phase)}`}.`}</span></div>}
    {warning && <div className="attention-banner"><strong>Attention</strong><span>{warning}</span></div>}
    <div className="metric-grid">
      <div><span>Elapsed</span><strong>{duration(now - Date.parse(execution.claimed_at))}</strong></div>
      <div><span>Herdr state for</span><strong>{herdr ? duration(now - Date.parse(herdr.state_changed_at)) : "—"}</strong></div>
      <div><span>Heartbeat</span><strong>{timeAgo(execution.last_heartbeat_at, now)}</strong></div>
      <div><span>Lease left</span><strong>{duration(Date.parse(execution.lease_expires_at) - now)}</strong></div>
    </div>
    <dl className="details-list">
      <DetailRow label="Supervisor">{execution.supervisor_id}</DetailRow>
      {!activity && <DetailRow label="Herdr observation">{humanize(herdrState)}</DetailRow>}
      {!activity && <DetailRow label="Assignment delivered">{execution.delivery_confirmed_at ? new Date(execution.delivery_confirmed_at).toLocaleString() : "Pending"}</DetailRow>}
      <DetailRow label="Attempt">#{execution.attempt}</DetailRow>
      {herdr?.pane_id && <DetailRow label="Herdr location">{[herdr.workspace_id, herdr.tab_id, herdr.pane_id].filter(Boolean).join(" / ")}</DetailRow>}
      {herdr?.foreground_cwd && <DetailRow label="Working directory"><code>{herdr.foreground_cwd}</code></DetailRow>}
      {herdr?.terminal_id && <DetailRow label="Terminal">{herdr.terminal_id}{herdr.focused === true ? " · focused" : ""}</DetailRow>}
      {herdr?.session_source && <DetailRow label="Session source">{herdr.session_source}{herdr.session_kind ? ` · ${herdr.session_kind}` : ""}</DetailRow>}
    </dl>
    {herdr && Object.keys(herdr.tokens).length > 0 && <div className="token-list">{Object.entries(herdr.tokens).map(([key, value]) => <span key={key}><small>{key}</small>{value}</span>)}</div>}
    {execution.telemetry && <TelemetryDetails telemetry={execution.telemetry} />}
    {herdr?.pane_id && <div className="attach-hint"><span>Attach from the coordinator VM</span><code>herdr --session agentic-projects agent attach {herdr.pane_id}</code></div>}
    {execution.guidance.length > 0 && <div className="guidance-status"><h3>Guidance</h3>{execution.guidance.map((item) => <p key={item.id}><span className={item.delivered_at ? "delivered" : "queued"}>{item.delivered_at ? "Delivered" : "Queued"}</span>{item.message}</p>)}</div>}
  </section>;
}

function Timeline({ body }: { body: string }) {
  const entries = [...body.matchAll(/^- `(\d+)` `([^`]+)` \*\*([^*]+)\*\* — (.*)$/gm)].reverse();
  return <section className="content-card timeline-panel"><div className="section-heading"><div><span>History</span><h2>Activity</h2></div><small>{entries.length} events</small></div>
    {entries.length ? <ol>{entries.map((entry) => <li key={entry[1]}><div className="timeline-marker" /><div><strong>{humanize(entry[3]!)}</strong><time>{new Date(entry[2]!).toLocaleString()}</time><p>{entry[4]}</p></div></li>)}</ol> : <p className="muted">No events recorded.</p>}
  </section>;
}

function ActionButton({ children, onClick, danger = false, primary = false }: { children: React.ReactNode; onClick: () => void; danger?: boolean; primary?: boolean }) {
  return <button className={danger ? "button-danger" : primary ? "button-primary" : "button-secondary"} onClick={onClick}>{children}</button>;
}

function ThemeSelector({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const options: Array<{ value: Theme; label: string; mark: string }> = [
    { value: "light", label: "Light", mark: "☀" },
    { value: "dark", label: "Dark", mark: "◐" },
    { value: "retro", label: "Retro Hacker", mark: ">_" },
  ];
  return <div className="theme-selector" role="group" aria-label="Theme">{options.map((option) => <button
    key={option.value}
    className={theme === option.value ? "active" : ""}
    aria-label={`Use ${option.label} theme`}
    aria-pressed={theme === option.value}
    title={`${option.label} theme`}
    onClick={() => onChange(option.value)}
  ><span aria-hidden="true">{option.mark}</span></button>)}</div>;
}

function TopNavigation({ view, attentionCount, onlineSupervisors, jiraEnabled, busy, theme, onView, onQueue, onNewTicket, onImportJira, onTheme }: {
  view: AppView;
  attentionCount: number;
  onlineSupervisors: number;
  jiraEnabled: boolean;
  busy: boolean;
  theme: Theme;
  onView: (view: AppView) => void;
  onQueue: () => void;
  onNewTicket: () => void;
  onImportJira: () => void;
  onTheme: (theme: Theme) => void;
}) {
  const compact = useCompactNavigation();
  const navigateFromMenu = (target: AppView, event: React.MouseEvent<HTMLButtonElement>) => {
    onView(target);
    event.currentTarget.closest("details")?.removeAttribute("open");
  };
  const overflowActive = ["intake", "metrics", "supervisors", "workflows", "prompts", "configuration"].includes(view);
  return <header className="topbar">
    <button className="brand" aria-label="Open ticket queue" onClick={onQueue}><div className="brand-mark">{theme === "retro" ? ">_" : "A"}</div><div><span>Agentic operations</span><strong>Project Tracker</strong></div></button>
    <nav className="topnav" aria-label="Primary navigation">
      <button className={view === "attention" ? "active" : ""} onClick={() => onView("attention")}>Inbox <span>{attentionCount}</span></button>
      <button className={view === "tickets" ? "active" : ""} onClick={onQueue}>Queue</button>
      {!compact && <>
        <button className={view === "intake" ? "active" : ""} onClick={() => onView("intake")}>Intake</button>
        <button className={view === "metrics" ? "active" : ""} onClick={() => onView("metrics")}>Metrics</button>
        <button className={view === "supervisors" ? "active" : ""} onClick={() => onView("supervisors")}>Operations <span>{onlineSupervisors}</span></button>
        <button className={view === "workflows" ? "active" : ""} onClick={() => onView("workflows")}>Workflows</button>
        <button className={view === "prompts" ? "active" : ""} onClick={() => onView("prompts")}>Prompts</button>
        <button className={view === "configuration" ? "active" : ""} onClick={() => onView("configuration")}>Configuration</button>
      </>}
      {compact && <details className={`nav-dropdown nav-overflow ${overflowActive ? "active" : ""}`}><summary aria-label="More navigation">•••</summary><div>
        <button onClick={(event) => navigateFromMenu("intake", event)}><strong>Intake</strong><small>Automated ticket sources</small></button>
        <button onClick={(event) => navigateFromMenu("metrics", event)}><strong>Metrics</strong><small>Factory performance</small></button>
        <button onClick={(event) => navigateFromMenu("supervisors", event)}><strong>Operations</strong><small>{onlineSupervisors} supervisors online</small></button>
        <button onClick={(event) => navigateFromMenu("workflows", event)}><strong>Workflows</strong><small>Design execution paths</small></button>
        <button onClick={(event) => navigateFromMenu("prompts", event)}><strong>Prompts</strong><small>Edit agent instructions</small></button>
        <button onClick={(event) => navigateFromMenu("configuration", event)}><strong>Configuration</strong><small>Tracker settings</small></button>
        {jiraEnabled && <button disabled={busy} onClick={(event) => { onImportJira(); event.currentTarget.closest("details")?.removeAttribute("open"); }}><strong>Import Jira</strong><small>Create a ticket from Jira Cloud</small></button>}
      </div></details>}
    </nav>
    <div className="topbar-actions">
      <ThemeSelector theme={theme} onChange={onTheme} />
      {!compact && jiraEnabled && <button className="button-secondary topbar-jira" disabled={busy} onClick={onImportJira}>Import Jira</button>}
      <button className="button-primary topbar-new-ticket" aria-label="New ticket" onClick={onNewTicket}><span aria-hidden="true">＋</span><strong>New ticket</strong></button>
    </div>
  </header>;
}

function PromptEditorPage({ prompts, onUpdated, onError }: {
  prompts: PromptDocument[]; onUpdated: (prompt: PromptDocument) => void; onError: (message: string | null) => void;
}) {
  const [selectedName, setSelectedName] = useState<PromptDocument["name"]>("assignment");
  const selected = prompts.find((prompt) => prompt.name === selectedName) ?? prompts[0];
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewPhase, setPreviewPhase] = useState<"specification" | "implementation" | "review">("implementation");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (selected && !creatingName) { setDraft(selected.content); setPreview(null); } }, [selected?.name, selected?.revision, creatingName]);
  if (!selected) return <main className="configuration-page"><div className="empty-health"><h2>Prompt library unavailable</h2></div></main>;
  const activeName = creatingName ?? selected.name;
  const activeTitle = creatingName ? humanize(creatingName || "New prompt") : selected.title;
  const activeTags = creatingName
    ? [...new Map(prompts.flatMap((prompt) => prompt.tags).filter((tag) => tag.name !== "phase_instructions" && tag.name !== "message").map((tag) => [tag.name, tag])).values()]
    : selected.tags;
  const cloneable = !["assignment", "guidance", "callback-reminder"].includes(selected.name);
  const dirty = creatingName !== null || draft !== selected.content;
  const insertTag = (tag: string) => setDraft((current) => `${current}${current.endsWith("\n") || !current ? "" : " "}{{${tag}}}`);
  const save = async () => {
    setBusy(true); onError(null);
    try {
      const result = creatingName ? await api.createPrompt(creatingName, draft) : await api.updatePrompt(selected, draft);
      onUpdated(result.prompt); setSelectedName(result.prompt.name); setCreatingName(null); setDraft(result.prompt.content);
    }
    catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  const renderPreview = async () => {
    setBusy(true); onError(null);
    try { setPreview((await api.previewPrompt({ ...selected, name: activeName }, draft, previewPhase)).rendered); }
    catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  const beginNew = () => {
    setCreatingName("new-prompt");
    setDraft("Complete the active workflow node autonomously. Before becoming idle, report one of the allowed outcomes.\n");
    setPreview(null); onError(null);
  };
  const beginClone = () => { setCreatingName(`copy-of-${selected.name}`); setDraft(selected.content); setPreview(null); onError(null); };
  const cancelCreate = () => { setCreatingName(null); setDraft(selected.content); setPreview(null); };
  return <main className="prompt-page">
    <div className="health-heading"><div><span>Agent messages</span><h1>Prompt editor</h1><p>Create, reuse, and publish versioned Markdown instructions for workflow nodes.</p></div><div className="artifact-actions"><button className="button-secondary" disabled={busy || !cloneable} title={cloneable ? "Copy the selected prompt into a new artifact" : "System envelope and live-guidance prompts cannot be used as workflow-node prompts"} onClick={beginClone}>Clone prompt</button><button className="button-primary" disabled={busy} onClick={beginNew}>New prompt</button></div></div>
    <div className="prompt-layout">
      <aside className="prompt-list" aria-label="Prompt templates">{creatingName && <button className="active artifact-draft"><strong>{activeTitle}</strong><small>{creatingName}.md · unsaved</small></button>}{prompts.map((prompt) => <button className={!creatingName && prompt.name === selected.name ? "active" : ""} key={prompt.name} onClick={() => { setCreatingName(null); setSelectedName(prompt.name); }}><strong>{prompt.title}</strong><small>{prompt.name}.md · v{prompt.version}</small>{!prompt.valid && <em>Invalid</em>}</button>)}</aside>
      <section className="prompt-editor-card">
        <div className="prompt-heading"><div><span>{activeName}.md{!creatingName ? ` · v${selected.version}` : ""}</span><h2>{activeTitle}</h2><p>{creatingName ? "New reusable workflow-node instructions." : selected.purpose}</p></div>{creatingName ? <span className="prompt-validity draft">Draft</span> : <span className={`prompt-validity ${selected.valid ? "valid" : "invalid"}`}>{selected.valid ? "Valid" : "Needs repair"}</span>}</div>
        {creatingName && <label className="artifact-id-field"><span>Prompt ID</span><input aria-label="Prompt ID" value={creatingName} onChange={(event) => setCreatingName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} /><small>Lowercase letters, numbers, and hyphens. This becomes the Markdown filename.</small></label>}
        {!creatingName && <section className="prompt-trigger"><span>When this runs</span><strong>{selected.trigger}</strong><div>{selected.stages.map((stage) => <small key={stage}>{stage}</small>)}</div>{(selected.workflow_references ?? []).map((reference) => <p key={`${reference.workflow_id}:${reference.node_id}`}><b>{reference.workflow_name}</b> · {reference.node_name} · outcomes {reference.outcomes.join(", ")}</p>)}</section>}
        {!creatingName && !selected.valid && <div className="draft-validation" role="alert"><strong>Saved prompt is invalid</strong><ul>{selected.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
        <label className="prompt-content-label">Prompt Markdown<textarea aria-label="Prompt Markdown" value={draft} onChange={(event) => { setDraft(event.target.value); setPreview(null); }} /></label>
        <section className="prompt-tags"><div><span>Available meta tags</span><p>Click a tag to append it. The rendered preview uses safe dummy values.</p></div>{activeTags.length ? <div className="prompt-tag-grid">{activeTags.map((tag) => <button key={tag.name} onClick={() => insertTag(tag.name)}><code>{`{{${tag.name}}}`}</code>{!creatingName && selected.required_tags.includes(tag.name) && <em>Required</em>}<span>{tag.description}</span><small>Example: {tag.example}</small></button>)}</div> : <p className="muted">This prompt has no meta tags.</p>}</section>
        <div className="prompt-actions">{selected.name === "assignment" && !creatingName && <label>Preview phase<select value={previewPhase} onChange={(event) => setPreviewPhase(event.target.value as typeof previewPhase)}><option value="specification">Specification</option><option value="implementation">Implementation</option><option value="review">Review</option></select></label>}{creatingName && <button className="button-secondary" onClick={cancelCreate}>Cancel</button>}<button className="button-secondary" disabled={busy || !draft.trim() || !activeName.trim()} onClick={() => void renderPreview()}>Preview with dummy ticket</button><button className="button-primary" disabled={busy || !dirty || !draft.trim() || !/^[a-z][a-z0-9-]{0,63}$/.test(activeName)} onClick={() => void save()}>{creatingName ? "Create prompt" : "Save prompt"}</button></div>
        {preview !== null && <section className="prompt-preview"><div><span>Rendered example</span><strong>{selected.name === "guidance" || selected.name === "callback-reminder" ? "Follow-up message" : "Complete assignment message"}</strong></div><pre>{preview}</pre></section>}
      </section>
    </div>
  </main>;
}

const GRAPH_NODE_WIDTH = 208;
const GRAPH_NODE_HEIGHT = 166;
const GRAPH_TICKET_NODE_HEIGHT = 224;
const GRAPH_COLUMN_GAP = 126;
const GRAPH_BASE_ROW_GAP = 104;
const GRAPH_LANE_GAP = 18;
const GRAPH_PRIMARY_PORT_RATIO = 0.25;
const GRAPH_ALTERNATE_PORT_RATIO = 0.75;
const GRAPH_ZOOM_MIN = 0.5;
const GRAPH_ZOOM_MAX = 2;
const GRAPH_ZOOM_STEP = 0.1;
const clampGraphZoom = (zoom: number) => Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, Math.round(zoom * 100) / 100));

type WorkflowRoute = WorkflowNode["outcomes"][number];

function nodeRoutes(node: WorkflowNode): WorkflowRoute[] {
  if (node.type === "agent") return node.outcomes;
  if (node.type === "human_gate") return node.choices;
  if (["script", "checkpoint", "restore_checkpoint"].includes(node.type)) return node.exit_codes;
  if (node.type === "read") return node.metadata_cases ?? [];
  if (node.type === "workflow") return node.status_codes ?? [];
  if (node.type === "fan_out") return node.branches ?? [];
  if (node.type === "wait" && node.next && node.timeout_to) return [
    { id: "elapsed", label: "Interval elapsed", description: "Continue with the next readiness check.", target: node.next, metric_class: "neutral" },
    { id: "timed_out", label: "Deadline expired", description: "The external wait deadline expired.", target: node.timeout_to, metric_class: "failure" },
  ];
  if ((node.type === "write" || node.type === "fan_in") && node.next) return [{ id: "completed", label: "Continue", description: "Continue", target: node.next }];
  return [];
}

function replaceNodeTargets(node: WorkflowNode, from: string, to: string): WorkflowNode {
  const replace = <T extends WorkflowRoute>(routes: T[]) => routes.map((route) => ({ ...route, target: route.target === from ? to : route.target }));
  return {
    ...node,
    outcomes: replace(node.outcomes), choices: replace(node.choices), exit_codes: replace(node.exit_codes),
    ...(node.metadata_cases ? { metadata_cases: replace(node.metadata_cases) } : {}),
    ...(node.status_codes ? { status_codes: replace(node.status_codes) } : {}),
    ...(node.branches ? { branches: replace(node.branches) } : {}),
    ...(node.next === from ? { next: to } : {}),
    ...(node.timeout_to === from ? { timeout_to: to } : {}),
    ...(node.fan_in === from ? { fan_in: to } : {}),
    ...(node.otherwise === from ? { otherwise: to } : {}),
    ...(node.github_watch?.feedback_target === from ? { github_watch: { ...node.github_watch, feedback_target: to } } : {}),
  };
}

function WorkflowGraph({ workflow, currentNode, selectedNode, onSelect, ticket, zoom = 1 }: {
  workflow: WorkflowDocument["definition"]; currentNode?: string; selectedNode?: string; onSelect?: (nodeId: string) => void; ticket?: TicketFrontmatter; zoom?: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; clientX: number; scrollLeft: number } | null>(null);
  const interactiveZoom = clampGraphZoom(zoom);
  const [panning, setPanning] = useState(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    panRef.current = { pointerId: event.pointerId, clientX: event.clientX, scrollLeft: event.currentTarget.scrollLeft };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanning(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
  };
  const stopPanning = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current || panRef.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    panRef.current = null;
    setPanning(false);
  };
  const markerId = useId().replaceAll(":", "");
  const loopMarkerId = `${markerId}-loop`;
  const nodeHeight = ticket ? GRAPH_TICKET_NODE_HEIGHT : GRAPH_NODE_HEIGHT;
  const columns = Math.min(workflow.nodes.length > 9 ? 4 : 3, Math.max(1, workflow.nodes.length));
  const rows = Math.ceil(workflow.nodes.length / columns);
  const grid = new Map(workflow.nodes.map((node, index) => [node.id, {
    index, row: Math.floor(index / columns), column: index % columns,
  }]));
  const stageEntries = new Map<string, string>();
  for (const node of workflow.nodes) if (!stageEntries.has(node.stage)) stageEntries.set(node.stage, node.id);
  const stages = new Map(workflow.stages.map((stage) => [stage.id, stage]));
  const rawEdges = workflow.nodes.flatMap((node) => {
    const stage = stages.get(node.stage);
    return [
      ...nodeRoutes(node).map((route) => ({ source: node.id, outcome: route.label, target: route.target })),
      ...(node.otherwise ? [{ source: node.id, outcome: "Otherwise", target: node.otherwise }] : []),
      ...(stageEntries.get(node.stage) === node.id && stage?.skippable && stage.bypass_to
        ? [{ source: node.id, outcome: "Stage disabled", target: stage.bypass_to }] : []),
      ...(node.github_watch?.feedback_target ? [{ source: node.id, outcome: "GitHub feedback", target: node.github_watch.feedback_target }] : []),
    ];
  });
  const groupedEdges = new Map<string, { source: string; target: string; outcomes: string[] }>();
  for (const edge of rawEdges) {
    const key = `${edge.source}\u0000${edge.target}`;
    const grouped = groupedEdges.get(key) ?? { source: edge.source, target: edge.target, outcomes: [] };
    if (!grouped.outcomes.includes(edge.outcome)) grouped.outcomes.push(edge.outcome);
    groupedEdges.set(key, grouped);
  }
  const edges = [...groupedEdges.values()].map((edge, index) => {
    const primary = edge.outcomes.find((outcome) => outcome !== "Stage disabled") ?? edge.outcomes[0]!;
    const outcome = edge.outcomes.length === 1 ? primary : edge.outcomes.includes("Stage disabled") ? `${primary} / bypass` : `${primary} / +${edge.outcomes.length - 1}`;
    return { ...edge, outcome, fullOutcome: edge.outcomes.join(" / "), id: `${index}:${edge.source}:${edge.target}` };
  });

  type LaneInterval = { start: number; end: number };
  const rowArcLanes = new Map<number, LaneInterval[][]>();
  const adjacentLanes = new Map<number, LaneInterval[][]>();
  const previousLanes = new Map<number, LaneInterval[][]>();
  const sideLanes: Record<"left" | "right", LaneInterval[][]> = { left: [], right: [] };
  const allocateLane = (lanes: LaneInterval[][], start: number, end: number): number => {
    const lane = lanes.findIndex((intervals) => intervals.every((interval) => end < interval.start || start > interval.end));
    const index = lane >= 0 ? lane : lanes.length;
    (lanes[index] ??= []).push({ start, end });
    return index;
  };
  const routedEdges = edges.map((edge) => {
    const source = grid.get(edge.source); const target = grid.get(edge.target);
    if (!source || !target) return { ...edge, route: "missing" as const, backward: false, lane: 0 };
    const backward = target.index <= source.index;
    if (source.row === target.row && !backward && target.column === source.column + 1) {
      return { ...edge, route: "direct" as const, backward, lane: 0 };
    }
    if (source.row === target.row) {
      const lanes = rowArcLanes.get(source.row) ?? [];
      rowArcLanes.set(source.row, lanes);
      return { ...edge, route: "row-return" as const, backward, lane: allocateLane(lanes, Math.min(source.column, target.column), Math.max(source.column, target.column)) };
    }
    if (backward && target.row === source.row - 1) {
      const lanes = previousLanes.get(target.row) ?? [];
      previousLanes.set(target.row, lanes);
      return { ...edge, route: "previous-row" as const, backward, lane: allocateLane(lanes, Math.min(source.column, target.column), Math.max(source.column, target.column)) };
    }
    if (!backward && target.row === source.row + 1) {
      const lanes = adjacentLanes.get(source.row) ?? [];
      adjacentLanes.set(source.row, lanes);
      return { ...edge, route: "next-row" as const, backward, lane: allocateLane(lanes, Math.min(source.column, target.column), Math.max(source.column, target.column)) };
    }
    const leftDistance = source.column + target.column;
    const rightDistance = (columns - 1 - source.column) + (columns - 1 - target.column);
    const side: "left" | "right" = leftDistance === rightDistance
      ? (sideLanes.left.length <= sideLanes.right.length ? "left" : "right")
      : leftDistance < rightDistance ? "left" : "right";
    return {
      ...edge, route: "side-return" as const, backward, side,
      lane: allocateLane(sideLanes[side], Math.min(source.row, target.row), Math.max(source.row, target.row)),
    };
  });
  const upperCorridors = new Map<number, LaneInterval[][]>();
  const lowerCorridors = new Map<number, LaneInterval[][]>();
  for (let gap = 0; gap < rows - 1; gap += 1) {
    upperCorridors.set(gap, (adjacentLanes.get(gap) ?? []).map((lane) => [...lane]));
    lowerCorridors.set(gap, [
      ...(rowArcLanes.get(gap + 1) ?? []).map((lane) => [...lane]),
      ...(previousLanes.get(gap) ?? []).map((lane) => [...lane]),
    ]);
  }
  const corridor = (collection: Map<number, LaneInterval[][]>, gap: number, side: "left" | "right", column: number) => {
    const lanes = collection.get(gap) ?? [];
    collection.set(gap, lanes);
    return allocateLane(lanes, side === "left" ? -1 : column, side === "left" ? column : columns);
  };
  const positionedEdges = routedEdges.map((edge) => {
    if (edge.route !== "side-return") return edge;
    const source = grid.get(edge.source)!; const target = grid.get(edge.target)!;
    const travelsBackward = target.row < source.row;
    return {
      ...edge,
      sourceTrackLane: corridor(travelsBackward ? lowerCorridors : upperCorridors, travelsBackward ? source.row - 1 : source.row, edge.side, source.column),
      targetTrackLane: corridor(lowerCorridors, travelsBackward ? target.row : target.row - 1, edge.side, target.column),
    };
  });
  const gapLaneCount = Array.from({ length: Math.max(0, rows - 1) }, (_, row) =>
    (upperCorridors.get(row)?.length ?? 0) + (lowerCorridors.get(row)?.length ?? 0));
  const rowGap = Math.max(GRAPH_BASE_ROW_GAP, 34 + Math.max(0, ...gapLaneCount) * GRAPH_LANE_GAP);
  const topPadding = Math.max(70, 38 + (rowArcLanes.get(0)?.length ?? 0) * GRAPH_LANE_GAP);
  const leftPadding = sideLanes.left.length ? 190 + Math.max(0, sideLanes.left.length - 1) * 22 : 34;
  const rightPadding = sideLanes.right.length ? 190 + Math.max(0, sideLanes.right.length - 1) * 22 : 34;
  const gridWidth = columns * GRAPH_NODE_WIDTH + Math.max(0, columns - 1) * GRAPH_COLUMN_GAP;
  const positions = new Map(workflow.nodes.map((node) => {
    const position = grid.get(node.id)!;
    return [node.id, {
      ...position,
      x: leftPadding + position.column * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
      y: topPadding + position.row * (nodeHeight + rowGap),
    }];
  }));
  const width = Math.max(760, leftPadding + gridWidth + rightPadding);
  const height = topPadding + rows * nodeHeight + Math.max(0, rows - 1) * rowGap + 52;
  return <div ref={viewportRef} className={`factory-graph-scroll ${panning ? "is-panning" : ""}`} aria-label="Workflow graph" title="Middle-click and drag left or right to pan." onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopPanning} onPointerCancel={stopPanning} onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}>
    <div className="factory-graph-scale" style={{ width: width * interactiveZoom, height: height * interactiveZoom }}>
    <div className="factory-graph" style={{ width, height, transform: `scale(${interactiveZoom})`, transformOrigin: "top left" }}>
      <svg className="factory-connectors" width={width} height={height} aria-hidden="true">
        <defs>
          <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker>
          <marker className="loop-marker" id={loopMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker>
        </defs>
        {positionedEdges.map((edge) => {
          const source = positions.get(edge.source); const target = positions.get(edge.target);
          if (!source || !target || edge.route === "missing") return null;
          const portRatio = edge.backward ? GRAPH_ALTERNATE_PORT_RATIO : GRAPH_PRIMARY_PORT_RATIO;
          const sourcePortX = source.x + GRAPH_NODE_WIDTH * portRatio;
          const targetPortX = target.x + GRAPH_NODE_WIDTH * portRatio;
          let path: string; let labelX: number; let labelY: number; let textAnchor: "start" | "middle" | "end" = "middle";
          if (edge.route === "direct") {
            const y = source.y + nodeHeight / 2;
            path = `M ${source.x + GRAPH_NODE_WIDTH} ${y} C ${source.x + GRAPH_NODE_WIDTH + 42} ${y}, ${target.x - 42} ${y}, ${target.x} ${y}`;
            labelX = (source.x + GRAPH_NODE_WIDTH + target.x) / 2; labelY = y - 10;
          } else if (edge.route === "row-return") {
            const arcY = source.y - 24 - edge.lane * GRAPH_LANE_GAP;
            path = `M ${sourcePortX} ${source.y} V ${arcY} H ${targetPortX} V ${target.y}`;
            labelX = (source.x + target.x + GRAPH_NODE_WIDTH) / 2; labelY = arcY - 4;
          } else if (edge.route === "next-row") {
            const trackY = source.y + nodeHeight + 26 + edge.lane * GRAPH_LANE_GAP;
            path = `M ${sourcePortX} ${source.y + nodeHeight} V ${trackY} H ${targetPortX} V ${target.y}`;
            labelX = (source.x + target.x + GRAPH_NODE_WIDTH) / 2; labelY = trackY - 4;
          } else if (edge.route === "previous-row") {
            const trackLane = (rowArcLanes.get(source.row)?.length ?? 0) + edge.lane;
            const trackY = source.y - 24 - trackLane * GRAPH_LANE_GAP;
            path = `M ${sourcePortX} ${source.y} V ${trackY} H ${targetPortX} V ${target.y + nodeHeight}`;
            labelX = (source.x + target.x + GRAPH_NODE_WIDTH) / 2; labelY = trackY - 4;
          } else {
            const side = edge.side!;
            const railX = side === "left"
              ? leftPadding - 34 - edge.lane * 22
              : leftPadding + gridWidth + 34 + edge.lane * 22;
            const travelsBackward = target.row < source.row;
            const sourceY = travelsBackward ? source.y : source.y + nodeHeight;
            const targetY = travelsBackward ? target.y + nodeHeight : target.y;
            const sourceTrackY = travelsBackward
              ? source.y - 24 - edge.sourceTrackLane * GRAPH_LANE_GAP
              : source.y + nodeHeight + 26 + edge.sourceTrackLane * GRAPH_LANE_GAP;
            const targetTrackY = travelsBackward
              ? target.y + nodeHeight + rowGap - 24 - edge.targetTrackLane * GRAPH_LANE_GAP
              : target.y - 24 - edge.targetTrackLane * GRAPH_LANE_GAP;
            path = `M ${sourcePortX} ${sourceY} V ${sourceTrackY} H ${railX} V ${targetTrackY} H ${targetPortX} V ${targetY}`;
            labelX = railX + (side === "left" ? -7 : 7);
            labelY = (sourceTrackY + targetTrackY) / 2 + (edge.lane % 2 === 0 ? -7 : 11);
            textAnchor = side === "left" ? "end" : "start";
          }
          return <g key={edge.id} data-route={edge.route} data-source={edge.source} data-target={edge.target} data-port={edge.backward ? "alternate-right" : "primary-left"} className={`factory-connector ${edge.backward ? "loop" : ""}`}>
            <path d={path} markerEnd={`url(#${edge.backward ? loopMarkerId : markerId})`} />
            <text x={labelX} y={labelY} textAnchor={textAnchor}><title>{humanize(edge.fullOutcome)}</title>{humanize(edge.outcome)}</text>
          </g>;
        })}
      </svg>
      {workflow.nodes.map((node) => {
        const position = positions.get(node.id)!;
        const runs = ticket?.workflow?.node_runs.filter((run) => run.node_id === node.id && run.workflow_revision === ticket.workflow?.revision && (run.workflow_id ?? ticket.workflow?.id) === workflow.id) ?? [];
        const totalWall = runs.reduce((sum, run) => sum + nodeTiming(run, Date.now()).wallMs, 0);
        const totalActive = runs.reduce((sum, run) => sum + nodeTiming(run, Date.now()).activeMs, 0);
        const usage = aggregateTokenUsage(runs);
        const costRuns = runs.filter((run) => run.telemetry?.delta.cost_usd !== null && run.telemetry?.delta.cost_usd !== undefined);
        const totalCost = costRuns.reduce((sum, run) => sum + (run.telemetry?.delta.cost_usd ?? 0), 0);
        return <button type="button" key={node.id} data-node={node.id} style={{ left: position.x, top: position.y, width: GRAPH_NODE_WIDTH, height: nodeHeight }} onClick={() => onSelect?.(node.id)} aria-pressed={selectedNode === node.id} className={`factory-node node-kind-${node.type} ${currentNode === node.id ? "current" : ""} ${selectedNode === node.id ? "selected" : ""}`}>
          <header><span>{humanize(node.type)}</span>{currentNode === node.id && <em>Current</em>}</header>
          <strong>{node.name}</strong><code>{node.id}</code>
          <small>{humanize(node.stage)}{node.when ? ` · when ${humanize(node.when.input)}` : ""}</small>
          {node.prompt && <p>Prompt: <b>{node.prompt}.md</b></p>}
          {node.script_file && <p>Script: <b>{node.script_file.path ?? `ticket:${node.script_file.path_input}`}</b></p>}
          {node.inline && <p>Inline: <b>{humanize(node.inline.language)}</b></p>}
          {node.github_watch && <p>GitHub feedback: <b>{humanize(node.github_watch.feedback_outcome ?? node.github_watch.feedback_target ?? "configured")}</b></p>}
          {ticket && <footer className="factory-node-metrics"><span>{runs.length} visit{runs.length === 1 ? "" : "s"}</span><span>{runs.length ? `${duration(totalWall)} wall · ${duration(totalActive)} active` : "Not run"}</span>{usage && <><span>Uncached {tokenCount(usage.input_tokens)} · Cached {tokenCount(usage.cached_input_tokens)} · Write {tokenCount(usage.cache_write_input_tokens)}</span><span>Out {tokenCount(usage.output_tokens)}{usage.reasoning_output_tokens > 0 ? ` · Reasoning ${tokenCount(usage.reasoning_output_tokens)}` : ""}</span></>}<span>{costRuns.length ? `${costLabel(costRuns.map((run) => run.telemetry!.latest.cost.kind))} ${usd(totalCost)}` : "Cost —"}</span>{node.type === "agent" && <span>Limit {usd(node.max_cost_usd ?? 50)}</span>}</footer>}
        </button>;
      })}
    </div></div>
  </div>;
}

function workflowErrors(workflow: WorkflowDocument["definition"] | null): string[] {
  if (!workflow) return [];
  const errors: string[] = [];
  const safeId = /^[a-z][a-z0-9-]{0,63}$/;
  const ids = workflow.nodes.map((node) => node.id);
  const stageIds = workflow.stages.map((stage) => stage.id);
  const inputIds = workflow.inputs.map((input) => input.id);
  const validPathReference = (reference: WorkflowNode["script_file"] | undefined, allowCurrentDirectory: boolean) => {
    if (!reference || !["selected_repository", "primary_repository", "project_root"].includes(reference.relative_to)) return false;
    if (Boolean(reference.path) === Boolean(reference.path_input)) return false;
    if (reference.path_input) return workflow.inputs.some((input) => input.id === reference.path_input && input.type !== "boolean");
    const path = reference.path?.trim() ?? "";
    if (!path || /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]+/).includes("..")) return false;
    return allowCurrentDirectory || path.split(/[\\/]+/).some((segment) => segment && segment !== ".");
  };
  const conversationProviders = new Map<string, string>();
  if (!safeId.test(workflow.id)) errors.push("Workflow ID must use lowercase letters, numbers, and hyphens.");
  if (!workflow.name.trim()) errors.push("Workflow name is required.");
  if (!Number.isInteger(workflow.max_transitions) || workflow.max_transitions < 1 || workflow.max_transitions > 1000) errors.push("Transition limit must be between 1 and 1000.");
  if (!ids.includes(workflow.start)) errors.push("The start node does not exist.");
  if (new Set(ids).size !== ids.length) errors.push("Node IDs must be unique.");
  if (new Set(stageIds).size !== stageIds.length) errors.push("Stage IDs must be unique.");
  if (new Set(inputIds).size !== inputIds.length) errors.push("Input IDs must be unique.");
  for (const input of workflow.inputs) {
    if (!safeId.test(input.id) || !input.label.trim()) errors.push("Every workflow input needs a valid ID and label.");
    if (input.type === "select" && (!input.options?.length || !input.options.some((option) => option.value === input.default))) errors.push(`${input.label || input.id} needs options and a matching default.`);
    if (input.type === "text" && typeof input.default !== "string") errors.push(`${input.label || input.id} needs a text default.`);
  }
  for (const stage of workflow.stages) {
    if (!safeId.test(stage.id) || !stage.name.trim()) errors.push("Every stage needs a valid ID and name.");
    if (stage.skippable && (!stage.bypass_to || !ids.includes(stage.bypass_to))) errors.push(`${stage.name || stage.id} needs a bypass target.`);
    if (stage.skippable && workflow.nodes.find((node) => node.id === stage.bypass_to)?.stage === stage.id) errors.push(`${stage.name || stage.id} must bypass to another stage.`);
    if (!stage.skippable && stage.bypass_to) errors.push(`${stage.name || stage.id} cannot define a bypass target because it is required.`);
  }
  for (const node of workflow.nodes) {
    if (!safeId.test(node.id)) errors.push(`${node.name || "A node"} needs a valid lowercase node ID.`);
    if (!node.name.trim()) errors.push(`${node.id || "A node"} needs a name.`);
    if (node.type === "terminal" && node.phase !== "done") errors.push(`${node.name} must use the Done operational role.`);
    if (node.type !== "terminal" && node.phase === "done") errors.push(`${node.name} cannot use the Done operational role unless it is terminal.`);
    if (!stageIds.includes(node.stage)) errors.push(`${node.name} references a missing stage.`);
    if (workflow.stages.find((stage) => stage.id === node.stage)?.phase !== node.phase) errors.push(`${node.name} must use its stage's operational role.`);
    if (node.when && !inputIds.includes(node.when.input)) errors.push(`${node.name} references a missing input.`);
    if (node.when && !node.otherwise) errors.push(`${node.name} needs an otherwise target.`);
    if (node.when && node.otherwise === node.id) errors.push(`${node.name} must bypass to another node.`);
    if (node.max_visits !== undefined && (!Number.isInteger(node.max_visits) || node.max_visits < 1 || node.max_visits > 100)) errors.push(`${node.name} maximum visits must be between 1 and 100.`);
    for (const target of [...nodeRoutes(node).map((route) => route.target), ...(node.otherwise ? [node.otherwise] : [])]) if (!ids.includes(target)) errors.push(`${node.name} points to missing node ${target}.`);
    if (node.type === "agent" && (!node.prompt || !node.agent_profile || !node.conversation_key)) errors.push(`${node.name} needs a prompt, agent profile, and conversation key.`);
    if (node.type === "agent" && (!Number.isFinite(node.max_cost_usd ?? 50) || (node.max_cost_usd ?? 50) <= 0)) errors.push(`${node.name} cumulative cost limit must be a positive finite amount.`);
    if (node.type !== "agent" && node.max_cost_usd !== undefined) errors.push(`${node.name} cannot define an agent cost limit.`);
    if (node.type === "agent" && node.outcomes.length === 0) errors.push(`${node.name} needs at least one declared outcome.`);
    if (node.type === "agent" && node.agent_profile && node.conversation_key) {
      const selector = `profile:${node.agent_profile}`;
      const priorProvider = conversationProviders.get(node.conversation_key);
      if (priorProvider && priorProvider !== selector) errors.push(`${node.name} reuses conversation ${node.conversation_key} with a different agent profile.`);
      else conversationProviders.set(node.conversation_key, selector);
    }
    if (node.type === "agent" && node.pull_request_requirement && (!["any", "primary"].includes(node.pull_request_requirement.scope) || !["specification", "implementation", "review"].includes(node.pull_request_requirement.phase))) errors.push(`${node.name} has an invalid pull-request requirement.`);
    if (node.type !== "agent" && node.pull_request_requirement) errors.push(`${node.name} cannot require pull requests because it is not an agent node.`);
    if (nodeRoutes(node).some((route) => !route.label.trim() || !route.description.trim())) errors.push(`${node.name} routes need labels and descriptions.`);
    if (node.type === "script") {
      const fileValid = validPathReference(node.script_file, false);
      const workingDirectoryValid = validPathReference(node.working_directory, true);
      const inlineValid = Boolean(node.inline?.code.trim()) && ["shell", "python", "javascript"].includes(node.inline?.language ?? "");
      if (!node.repository?.trim() || fileValid === inlineValid || !workingDirectoryValid || !node.exit_codes.some((route) => route.codes?.includes(0)) || node.exit_codes.filter((route) => route.default).length !== 1) errors.push(`${node.name} needs exactly one script file or inline program, an explicit working directory, an exit-code 0 route, and one default route.`);
      for (const artifact of node.artifacts ?? []) {
        if (artifact.interpretation && !["application/yaml", "application/x-yaml", "text/yaml"].includes(artifact.content_type)) errors.push(`${node.name} quality artifact ${artifact.name} must use a YAML content type.`);
        if (artifact.interpretation?.required_attributes.some((key) => !/^[a-z][a-z0-9._-]{0,127}$/.test(key))) errors.push(`${node.name} quality artifact ${artifact.name} has an invalid required key.`);
      }
    }
    if (node.type === "read" && (!node.metadata_key || !node.metadata_cases?.length || node.metadata_cases.filter((route) => route.default).length !== 1)) errors.push(`${node.name} needs a metadata key, cases, and one default case.`);
    if (node.type === "write" && (!node.metadata_key || !("metadata_value" in node) || !node.next)) errors.push(`${node.name} needs a metadata key, JSON value, and next node.`);
    if (node.type === "workflow" && (!node.workflow_id || !node.status_codes?.length || node.status_codes.filter((route) => route.default).length !== 1)) errors.push(`${node.name} needs a child workflow and status-code routes.`);
    if (node.type === "fan_out" && ((node.branches?.length ?? 0) < 2 || !node.fan_in)) errors.push(`${node.name} needs at least two branches and a fan-in node.`);
    if (node.type === "fan_in" && !node.next) errors.push(`${node.name} needs a next node.`);
    if (node.type === "human_gate") {
      if (node.choices.length === 0) errors.push(`${node.name} needs at least one human choice.`);
      if (node.github_watch && (!node.github_watch.feedback_outcome || !node.choices.some((choice) => choice.id === node.github_watch?.feedback_outcome))) errors.push(`${node.name} GitHub feedback must follow one of its choices.`);
    } else if (node.type === "terminal" && node.github_watch) {
      if (node.terminal_status !== "completed" || !node.github_watch.feedback_target || !ids.includes(node.github_watch.feedback_target) || workflow.nodes.find((item) => item.id === node.github_watch?.feedback_target)?.type === "terminal") errors.push(`${node.name} needs a valid nonterminal completed-ticket GitHub feedback target.`);
    } else if (node.github_watch) errors.push(`${node.name} cannot watch GitHub because it is not a human gate or completed terminal.`);
    if (node.type === "terminal" && (!node.terminal_status || nodeRoutes(node).length > 0)) errors.push(`${node.name} needs a terminal status and cannot have outcomes.`);
  }
  if (ids.includes(workflow.start)) {
    const reachable = new Set<string>();
    const visit = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      const current = workflow.nodes.find((node) => node.id === id);
      if (current) {
        const stage = workflow.stages.find((candidate) => candidate.id === current.stage);
        [...nodeRoutes(current).map((route) => route.target), ...(current.otherwise ? [current.otherwise] : []), ...(stage?.skippable && stage.bypass_to ? [stage.bypass_to] : []), ...(current.github_watch?.feedback_target ? [current.github_watch.feedback_target] : [])].forEach(visit);
      }
    };
    visit(workflow.start);
    for (const node of workflow.nodes) if (!reachable.has(node.id)) errors.push(`${node.name} is unreachable from the start node.`);
  }
  return [...new Set(errors)];
}

function newWorkflowDefinition(id = "new-workflow", agentProfile = "claude"): WorkflowDocument["definition"] {
  return {
    version: 2, id, name: "New workflow", description: "A reusable software-delivery workflow.", start: "work", max_transitions: 40,
    inputs: [], stages: [
      { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
      { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
    ],
    nodes: [
      { id: "work", name: "Work", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", agent_profile: agentProfile, conversation_key: "work", max_cost_usd: 50, max_visits: 10, outcomes: [{ id: "completed", label: "Work completed", description: "The work is finished and verified.", target: "done", metric_class: "success" }], choices: [], exit_codes: [] },
      { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
    ],
  };
}

function editableWorkflowContent(workflow: WorkflowDocument): string {
  try {
    const raw = parse(workflow.content) as { version?: unknown; inputs?: unknown; stages?: unknown };
    if (raw?.version === 2 && Array.isArray(raw.inputs) && Array.isArray(raw.stages)) return workflow.content;
  } catch { /* invalid source remains visible through the advanced editor */ }
  return workflow.valid ? stringify(workflow.definition, { lineWidth: 0 }) : workflow.content;
}

function WorkflowNodeInspector({ workflow, node, prompts, agentProfiles, workflows, onChange, onDelete }: {
  workflow: WorkflowDocument["definition"]; node: WorkflowNode; prompts: PromptDocument[];
  agentProfiles: TrackerConfig["agent_profiles"] | undefined; workflows: WorkflowDocument[] | undefined;
  onChange: (workflow: WorkflowDocument["definition"], selectedId?: string) => void; onDelete: () => void;
}) {
  const patchNode = (patch: Partial<WorkflowNode>) => onChange({ ...workflow, nodes: workflow.nodes.map((item) => item.id === node.id ? { ...item, ...patch } : item) });
  const clearNodeKey = (key: keyof WorkflowNode) => onChange({ ...workflow, nodes: workflow.nodes.map((item) => {
    if (item.id !== node.id) return item;
    const copy = { ...item } as WorkflowNode & Record<string, unknown>; delete copy[key]; return copy;
  }) });
  const patchPathReference = (field: "script_file" | "working_directory", patch: Partial<NonNullable<WorkflowNode["script_file"]>>) => {
    const fallback = field === "script_file" ? ".agents/actions/run.sh" : ".";
    patchNode({ [field]: { relative_to: "selected_repository", path: fallback, ...(node[field] ?? {}), ...patch } });
  };
  const setPathSource = (field: "script_file" | "working_directory", source: "path" | "input") => {
    const current = node[field] ?? { relative_to: "selected_repository" as const, path: field === "script_file" ? ".agents/actions/run.sh" : "." };
    if (source === "input") {
      const { path: _path, ...rest } = current;
      patchNode({ [field]: { ...rest, path_input: current.path_input ?? workflow.inputs.find((input) => input.type !== "boolean")?.id ?? "" } });
    } else {
      const { path_input: _pathInput, ...rest } = current;
      patchNode({ [field]: { ...rest, path: current.path ?? (field === "script_file" ? ".agents/actions/run.sh" : ".") } });
    }
  };
  const renameNode = (nextId: string) => {
    const cleaned = nextId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const nodes = workflow.nodes.map((item) => replaceNodeTargets({ ...item, id: item.id === node.id ? cleaned : item.id }, node.id, cleaned));
    const stages = workflow.stages.map((stage) => stage.bypass_to === node.id ? { ...stage, bypass_to: cleaned } : stage);
    onChange({ ...workflow, start: workflow.start === node.id ? cleaned : workflow.start, nodes, stages }, cleaned);
  };
  const changeType = (type: WorkflowNode["type"]) => {
    const target = workflow.nodes.find((item) => item.id !== node.id)?.id ?? node.id;
    const stage = type === "terminal" ? workflow.stages.find((item) => item.phase === "done")?.id ?? node.stage : node.stage;
    const replacement: WorkflowNode = { id: node.id, name: node.name, type, phase: type === "terminal" ? "done" : node.phase, stage, max_visits: node.max_visits ?? 10, outcomes: [], choices: [], exit_codes: [] };
    if (type === "agent") Object.assign(replacement, { prompt: "implementation", agent_profile: agentProfiles?.default ?? "claude", conversation_key: "work", max_cost_usd: 50, outcomes: [{ id: "completed", label: "Work completed", description: "The assigned work is finished.", target, metric_class: "success" }] });
    if (type === "script") Object.assign(replacement, { repository: "primary", script_file: { path: ".agents/actions/run.sh", relative_to: "selected_repository" }, working_directory: { path: ".", relative_to: "selected_repository" }, script_output: { persist_stdout: true, prompt_tail_lines: 20 }, exit_codes: [{ id: "success", label: "Success", description: "Exited with code 0.", target, metric_class: "success", codes: [0] }, { id: "failure", label: "Failure", description: "Any other exit code or execution error.", target: node.id, metric_class: "failure", default: true }] });
    if (type === "checkpoint") Object.assign(replacement, { checkpoint_label: "Workflow checkpoint", exit_codes: [{ id: "created", label: "Created", description: "All declared repositories were captured.", target, metric_class: "success", codes: [0] }, { id: "failed", label: "Failed", description: "Checkpoint capture failed.", target: node.id, metric_class: "failure", default: true }] });
    if (type === "restore_checkpoint") Object.assign(replacement, { checkpoint_source: { mode: "latest" }, exit_codes: [{ id: "restored", label: "Restored", description: "All declared repositories were restored.", target, metric_class: "success", codes: [0] }, { id: "failed", label: "Failed", description: "Restore failed and compensation was attempted.", target: node.id, metric_class: "failure", default: true }] });
    if (type === "human_gate") Object.assign(replacement, { choices: [{ id: "approved", label: "Approve", description: "Continue the workflow.", target, metric_class: "success" }, { id: "changes_requested", label: "Request changes", description: "Return for another iteration.", target: node.id, metric_class: "failure", comment_required: true }] });
    if (type === "wait") Object.assign(replacement, { wait_schedule: { initial_seconds: 30, multiplier: 1.5, maximum_seconds: 300, jitter_percent: 10, deadline_seconds: 3600 }, next: target, timeout_to: target });
    if (type === "read") Object.assign(replacement, { metadata_key: "result", metadata_cases: [{ id: "matched", label: "Matched", description: "Value matched.", target, metric_class: "success", equals: true }, { id: "default", label: "Default", description: "No value matched.", target: node.id, metric_class: "neutral", default: true }] });
    if (type === "write") Object.assign(replacement, { metadata_key: "result", metadata_value: true, next: target });
    if (type === "workflow") Object.assign(replacement, { workflow_id: "standard-delivery", status_codes: [{ id: "success", label: "Success", description: "Child returned zero.", target, metric_class: "success", codes: [0] }, { id: "failure", label: "Failure", description: "All other child statuses.", target: node.id, metric_class: "failure", default: true }] });
    if (type === "fan_out") Object.assign(replacement, { branches: [{ id: "branch-a", label: "Branch A", description: "First branch.", target, metric_class: "neutral" }, { id: "branch-b", label: "Branch B", description: "Second branch.", target, metric_class: "neutral" }], fan_in: workflow.nodes.find((item) => item.type === "fan_in")?.id ?? target });
    if (type === "fan_in") Object.assign(replacement, { next: target });
    if (type === "terminal") Object.assign(replacement, { terminal_status: "completed", status_code: 0 });
    onChange({ ...workflow, nodes: workflow.nodes.map((item) => item.id === node.id ? replacement : item) });
  };
  const setActivitySource = (source: "file" | "inline") => onChange({ ...workflow, nodes: workflow.nodes.map((item) => {
    if (item.id !== node.id) return item;
    if (source === "inline") {
      const { script_file: _scriptFile, ...rest } = item;
      return { ...rest, inline: item.inline ?? { language: "shell", code: defaultInlineCode("shell") } };
    }
    const { inline: _inline, ...rest } = item;
    return { ...rest, script_file: item.script_file ?? { path: ".agents/actions/run.sh", relative_to: "selected_repository" } };
  }) });
  const routes = nodeRoutes(node);
  const replaceRoutes = (next: WorkflowRoute[]) => {
    if (node.type === "agent") patchNode({ outcomes: next });
    if (node.type === "human_gate") patchNode({ choices: next.map((route, index) => ({ ...route, ...(node.choices[index]?.comment_required ? { comment_required: true } : {}) })) });
    if (["script", "checkpoint", "restore_checkpoint"].includes(node.type)) patchNode({ exit_codes: next.map((route, index) => ({ ...node.exit_codes[index], ...route })) });
    if (node.type === "read") patchNode({ metadata_cases: next.map((route, index) => ({ ...node.metadata_cases?.[index], ...route })) });
    if (node.type === "workflow") patchNode({ status_codes: next.map((route, index) => ({ ...node.status_codes?.[index], ...route })) });
    if (node.type === "fan_out") patchNode({ branches: next });
  };
  const patchRoute = (index: number, patch: Partial<WorkflowRoute>) => replaceRoutes(routes.map((route, candidate) => candidate === index ? { ...route, ...patch } : route));
  const setRouteMetricClass = (index: number, value: string) => replaceRoutes(routes.map((route, candidate) => {
    if (candidate !== index) return route;
    if (value === "unclassified") { const { metric_class: _metricClass, ...rest } = route; return rest; }
    return { ...route, metric_class: value as "success" | "failure" | "neutral" };
  }));
  const addRoute = () => {
    const target = workflow.nodes.find((item) => item.id !== node.id)?.id ?? node.id;
    if (["script", "checkpoint", "restore_checkpoint"].includes(node.type)) patchNode({ exit_codes: [...node.exit_codes, { id: `exit_${node.exit_codes.length + 1}`, label: "Additional exit", description: "", target, metric_class: "neutral", codes: [1] }] });
    else if (node.type === "read") patchNode({ metadata_cases: [...(node.metadata_cases ?? []), { id: `case-${(node.metadata_cases?.length ?? 0) + 1}`, label: "New case", description: "", target, metric_class: "neutral", equals: "value" }] });
    else if (node.type === "workflow") patchNode({ status_codes: [...(node.status_codes ?? []), { id: `status-${(node.status_codes?.length ?? 0) + 1}`, label: "New status", description: "", target, metric_class: "neutral", codes: [1] }] });
    else replaceRoutes([...routes, { id: `outcome-${routes.length + 1}`, label: "New outcome", description: "", target, metric_class: "neutral" }]);
  };
  const conditionInput = workflow.inputs.find((input) => input.id === node.when?.input);
  return <aside className="workflow-inspector" aria-label="Selected node editor">
    <div className="inspector-heading"><div><span>Selected node</span><h3>{node.name}</h3></div><span className={`node-type-badge node-kind-${node.type}`}>{humanize(node.type)}</span></div>
    <div className="inspector-fields">
      <label><span>Name</span><input aria-label="Node name" value={node.name} onChange={(event) => patchNode({ name: event.target.value })} /></label>
      <label><span>Node ID</span><input aria-label="Node ID" value={node.id} onChange={(event) => renameNode(event.target.value)} /></label>
      <label><span>Type</span><select aria-label="Node type" value={node.type} onChange={(event) => changeType(event.target.value as WorkflowNode["type"])}><option value="agent">Agent</option><option value="script">Script</option><option value="checkpoint">Checkpoint</option><option value="restore_checkpoint">Restore checkpoint</option><option value="human_gate">Human gate</option><option value="wait">External wait</option><option value="read">Read metadata</option><option value="write">Write metadata</option><option value="workflow">Workflow</option><option value="fan_out">Fan out</option><option value="fan_in">Fan in</option><option value="terminal">Terminal</option></select></label>
      <label><span>Stage</span><select aria-label="Node stage" value={node.stage} onChange={(event) => { const stage = workflow.stages.find((item) => item.id === event.target.value); patchNode({ stage: event.target.value, ...(stage ? { phase: stage.phase } : {}) }); }}>{workflow.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
      {node.type !== "terminal" && <><label><span>Run condition</span><select aria-label="Node condition" value={node.when?.input ?? ""} onChange={(event) => {
        if (event.target.value) patchNode({ when: { input: event.target.value, equals: workflow.inputs.find((input) => input.id === event.target.value)?.default ?? true }, otherwise: node.otherwise ?? workflow.nodes.find((item) => item.id !== node.id)?.id ?? node.id });
        else onChange({ ...workflow, nodes: workflow.nodes.map((item) => { if (item.id !== node.id) return item; const copy = { ...item }; delete copy.when; delete copy.otherwise; return copy; }) });
      }}><option value="">Always run</option>{workflow.inputs.map((input) => <option key={input.id} value={input.id}>{input.label}</option>)}</select></label>{node.when && <><label><span>Required value</span>{conditionInput?.type === "select" ? <select aria-label="Condition value" value={String(node.when.equals)} onChange={(event) => patchNode({ when: { ...node.when!, equals: event.target.value } })}>{conditionInput.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : conditionInput?.type === "text" ? <input aria-label="Condition value" value={String(node.when.equals)} onChange={(event) => patchNode({ when: { ...node.when!, equals: event.target.value } })} /> : <select aria-label="Condition value" value={String(node.when.equals)} onChange={(event) => patchNode({ when: { ...node.when!, equals: event.target.value === "true" } })}><option value="true">Enabled</option><option value="false">Disabled</option></select>}</label><label><span>Otherwise go to</span><select aria-label="Condition bypass target" value={node.otherwise} onChange={(event) => patchNode({ otherwise: event.target.value })}>{workflow.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}</>}
      {node.type !== "terminal" && <label><span>Maximum visits</span><input aria-label="Maximum visits" type="number" min="1" value={node.max_visits ?? 10} onChange={(event) => patchNode({ max_visits: Number(event.target.value) })} /></label>}
      {node.type === "agent" && <><label><span>Prompt</span><select aria-label="Node prompt" value={node.prompt ?? ""} onChange={(event) => patchNode({ prompt: event.target.value })}>{prompts.filter((prompt) => prompt.valid && !["assignment", "guidance", "callback-reminder"].includes(prompt.name)).map((prompt) => <option key={prompt.name} value={prompt.name}>{prompt.title}</option>)}</select></label><label><span>Agent profile</span><select aria-label="Node agent profile" value={node.agent_profile ?? "default"} onChange={(event) => patchNode({ agent_profile: event.target.value })}><option value="default">Default alias</option>{agentProfiles?.profiles.filter((profile) => profile.id !== "default").map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.provider}/{profile.model}/{profile.reasoning}</option>)}</select></label><label><span>Maximum cumulative cost (USD)</span><input aria-label="Node maximum cost" type="number" min="0.01" step="0.01" value={node.max_cost_usd ?? 50} onChange={(event) => patchNode({ max_cost_usd: Number(event.target.value) })} /><small>Known costs from every visit to this node are added together. The tracker pauses the ticket after this limit is exceeded.</small></label><label><span>Conversation key</span><input aria-label="Conversation key" value={node.conversation_key ?? "work"} onChange={(event) => patchNode({ conversation_key: event.target.value })} /></label><label><span>Conversation policy</span><select aria-label="Conversation policy" value={node.conversation_policy ?? "resume"} onChange={(event) => {
        const policy = event.target.value as NonNullable<WorkflowNode["conversation_policy"]>;
        if (policy === "reset_after_visits") patchNode({ conversation_policy: policy, maximum_visits_per_session: node.maximum_visits_per_session ?? 3 });
        else onChange({ ...workflow, nodes: workflow.nodes.map((item) => { if (item.id !== node.id) return item; const copy = { ...item, conversation_policy: policy }; delete copy.maximum_visits_per_session; return copy; }) });
      }}><option value="resume">Resume for every visit</option><option value="fresh_each_visit">Fresh session each visit</option><option value="reset_after_visits">Reset after N visits</option></select></label>{node.conversation_policy === "reset_after_visits" && <label><span>Visits per session</span><input aria-label="Conversation maximum visits" type="number" min="1" max="100" value={node.maximum_visits_per_session ?? 3} onChange={(event) => patchNode({ maximum_visits_per_session: Number(event.target.value) })} /></label>}</>}
      {node.type === "agent" && <><label><span>Required PR</span><select aria-label="Pull request requirement" value={node.pull_request_requirement?.scope ?? "none"} onChange={(event) => event.target.value === "none" ? clearNodeKey("pull_request_requirement") : patchNode({ pull_request_requirement: { scope: event.target.value as "any" | "primary", phase: node.phase as "specification" | "implementation" | "review" } })}><option value="none">No PR required</option><option value="any">Any repository</option><option value="primary">Primary repository</option></select></label>{node.pull_request_requirement && <label><span>PR phase</span><select aria-label="Required pull request phase" value={node.pull_request_requirement.phase} onChange={(event) => patchNode({ pull_request_requirement: { ...node.pull_request_requirement!, phase: event.target.value as "specification" | "implementation" | "review" } })}><option value="specification">Specification</option><option value="implementation">Implementation</option><option value="review">Review</option></select></label>}</>}
      {node.type === "human_gate" && <><label className="toggle"><input aria-label="Watch GitHub feedback" type="checkbox" checked={Boolean(node.github_watch)} onChange={(event) => event.target.checked ? patchNode({ github_watch: { pull_request_phase: node.phase === "done" ? "all" : node.phase, feedback_outcome: node.choices.find((choice) => choice.id === "changes_requested")?.id ?? node.choices[0]?.id ?? "" } }) : clearNodeKey("github_watch")} /><span><strong>Watch GitHub feedback</strong><small>New human PR feedback follows a declared gate choice.</small></span></label>{node.github_watch && <><label><span>PR phase</span><select aria-label="GitHub PR phase" value={node.github_watch.pull_request_phase} onChange={(event) => patchNode({ github_watch: { ...node.github_watch!, pull_request_phase: event.target.value as NonNullable<WorkflowNode["github_watch"]>["pull_request_phase"] } })}><option value="specification">Specification PRs</option><option value="implementation">Implementation PRs</option><option value="review">Review PRs</option><option value="all">All ticket PRs</option></select></label><label><span>Feedback follows</span><select aria-label="GitHub feedback outcome" value={node.github_watch.feedback_outcome ?? ""} onChange={(event) => patchNode({ github_watch: { ...node.github_watch!, feedback_outcome: event.target.value } })}>{node.choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label></>}</>}
      {node.type === "script" && <><label><span>Repository context</span><input aria-label="Script repository" value={node.repository ?? "primary"} onChange={(event) => patchNode({ repository: event.target.value })} /></label><label><span>Activity source</span><select aria-label="Activity source" value={node.inline ? "inline" : "file"} onChange={(event) => setActivitySource(event.target.value as "file" | "inline")}><option value="file">Script file</option><option value="inline">Inline code</option></select></label>{node.inline ? <><label><span>Language</span><select aria-label="Inline language" value={node.inline.language} onChange={(event) => {
        const language = event.target.value as WorkflowInlineLanguage;
        patchNode({ inline: { language, code: !node.inline!.code.trim() || isDefaultInlineCode(node.inline!.code) ? defaultInlineCode(language) : node.inline!.code } });
      }}><option value="shell">Shell</option><option value="python">Python</option><option value="javascript">JavaScript</option></select></label><label className="inline-code-field"><span>Inline code</span><textarea aria-label="Inline code" spellCheck={false} value={node.inline.code} onChange={(event) => patchNode({ inline: { ...node.inline!, code: event.target.value } })} /></label><p className="field-warning">Trusted configuration: this code runs with the supervisor process credentials from the configured working directory.</p></> : <><label><span>Script path source</span><select aria-label="Script path source" value={node.script_file?.path_input ? "input" : "path"} onChange={(event) => setPathSource("script_file", event.target.value as "path" | "input")}><option value="path">Workflow path</option><option value="input">Ticket input</option></select></label><label><span>Script path base</span><select aria-label="Script path base" value={node.script_file?.relative_to ?? "selected_repository"} onChange={(event) => patchPathReference("script_file", { relative_to: event.target.value as NonNullable<WorkflowNode["script_file"]>["relative_to"] })}><option value="selected_repository">Selected repository</option><option value="primary_repository">Primary repository</option><option value="project_root">Supervisor project root</option></select></label>{node.script_file?.path_input !== undefined ? <label><span>Ticket input</span><select aria-label="Script path input" value={node.script_file.path_input} onChange={(event) => patchPathReference("script_file", { path_input: event.target.value })}><option value="">Choose an input</option>{workflow.inputs.filter((input) => input.type !== "boolean").map((input) => <option key={input.id} value={input.id}>{input.label}</option>)}</select></label> : <label><span>Relative script path</span><input aria-label="Script path" value={node.script_file?.path ?? ""} onChange={(event) => patchPathReference("script_file", { path: event.target.value })} /></label>}</>}<label><span>Working-directory source</span><select aria-label="Working directory source" value={node.working_directory?.path_input ? "input" : "path"} onChange={(event) => setPathSource("working_directory", event.target.value as "path" | "input")}><option value="path">Workflow path</option><option value="input">Ticket input</option></select></label><label><span>Working-directory base</span><select aria-label="Working directory base" value={node.working_directory?.relative_to ?? "selected_repository"} onChange={(event) => patchPathReference("working_directory", { relative_to: event.target.value as NonNullable<WorkflowNode["working_directory"]>["relative_to"] })}><option value="selected_repository">Selected repository</option><option value="primary_repository">Primary repository</option><option value="project_root">Supervisor project root</option></select></label>{node.working_directory?.path_input !== undefined ? <label><span>Ticket input</span><select aria-label="Working directory input" value={node.working_directory.path_input} onChange={(event) => patchPathReference("working_directory", { path_input: event.target.value })}><option value="">Choose an input</option>{workflow.inputs.filter((input) => input.type !== "boolean").map((input) => <option key={input.id} value={input.id}>{input.label}</option>)}</select></label> : <label><span>Relative working directory</span><input aria-label="Working directory path" value={node.working_directory?.path ?? "."} onChange={(event) => patchPathReference("working_directory", { path: event.target.value })} /></label>}<p className="field-warning">Resolution preview: {node.inline ? "inline program" : `${humanize(node.script_file?.relative_to ?? "selected_repository")} / ${node.script_file?.path ?? `ticket input ${node.script_file?.path_input ?? "not selected"}`}`} runs from {humanize(node.working_directory?.relative_to ?? "selected_repository")} / {node.working_directory?.path ?? `ticket input ${node.working_directory?.path_input ?? "not selected"}`}. Paths are contained beneath their selected base.</p><p className="field-warning">Scripts receive the resolved script path and working directory, selected and primary repository paths, branches, SHAs, PRs, ticket repositories, and workflow context through AGENTIC_* variables. Script files also receive matching CLI flags.</p></>}
      {node.type === "script" && <><label className="toggle"><input aria-label="Persist script stdout" type="checkbox" checked={node.script_output?.persist_stdout !== false} onChange={(event) => patchNode({ script_output: { persist_stdout: event.target.checked, prompt_tail_lines: node.script_output?.prompt_tail_lines ?? 0 } })} /><span><strong>Persist stdout log</strong><small>The next agent receives a tracker URL.</small></span></label><label><span>Pass last lines to next prompt</span><input aria-label="Script prompt tail lines" type="number" min="0" max="500" value={node.script_output?.prompt_tail_lines ?? 0} onChange={(event) => patchNode({ script_output: { persist_stdout: node.script_output?.persist_stdout !== false, prompt_tail_lines: Number(event.target.value) } })} /></label></>}
      {node.type === "script" && <label><span>Artifacts (name:path:MIME:required|optional:file|quality:required keys:title:category:featured|normal)</span><textarea aria-label="Script artifacts" value={(node.artifacts ?? []).map((artifact) => `${artifact.name}:${artifact.path}:${artifact.content_type}:${artifact.required ? "required" : "optional"}:${artifact.interpretation ? "quality" : "file"}:${artifact.interpretation?.required_attributes.join(",") ?? ""}:${artifact.presentation?.title ?? ""}:${artifact.presentation?.category ?? ""}:${artifact.presentation?.featured ? "featured" : "normal"}`).join("\n")} onChange={(event) => patchNode({ artifacts: event.target.value.split(/\r?\n/).filter(Boolean).map((line) => { const [name = "", path = "", content_type = "application/octet-stream", requirement = "optional", interpretation = "file", required = "", title = "", category = "", featured = "normal"] = line.split(":"); return { name, path, content_type, required: requirement === "required", ...(interpretation === "quality" ? { interpretation: { kind: "quality_report" as const, schema: "agentic-quality/v1" as const, required_attributes: required.split(",").map((item) => item.trim()).filter(Boolean) } } : {}), ...((title || category || featured === "featured") ? { presentation: { ...(title ? { title } : {}), ...(category ? { category } : {}), ...(featured === "featured" ? { featured: true } : {}) } } : {}) }; }) })} /><small>Presentation hints are optional. Quality artifacts are YAML validated against agentic-quality/v1; all other contents remain unrestricted.</small></label>}
      {node.type === "checkpoint" && <label><span>Checkpoint label</span><input aria-label="Checkpoint label" value={node.checkpoint_label ?? ""} onChange={(event) => patchNode({ checkpoint_label: event.target.value })} /></label>}
      {node.type === "restore_checkpoint" && <><label><span>Checkpoint source</span><select aria-label="Checkpoint source" value={node.checkpoint_source?.mode ?? "latest"} onChange={(event) => patchNode({ checkpoint_source: { mode: event.target.value as "latest" | "id" | "metadata", ...(event.target.value === "id" ? { checkpoint_id: "checkpoint-id" } : event.target.value === "metadata" ? { metadata_key: "checkpoint.restore_id" } : {}) } })}><option value="latest">Latest checkpoint</option><option value="id">Fixed checkpoint ID</option><option value="metadata">Ticket metadata key</option></select></label>{node.checkpoint_source?.mode === "id" && <label><span>Checkpoint ID</span><input aria-label="Checkpoint ID" value={node.checkpoint_source.checkpoint_id ?? ""} onChange={(event) => patchNode({ checkpoint_source: { mode: "id", checkpoint_id: event.target.value } })} /></label>}{node.checkpoint_source?.mode === "metadata" && <label><span>Metadata key</span><input aria-label="Checkpoint metadata key" value={node.checkpoint_source.metadata_key ?? ""} onChange={(event) => patchNode({ checkpoint_source: { mode: "metadata", metadata_key: event.target.value } })} /></label>}</>}
      {node.type === "wait" && <><label><span>Initial wait (seconds)</span><input aria-label="Wait initial seconds" type="number" min="1" value={node.wait_schedule?.initial_seconds ?? 30} onChange={(event) => patchNode({ wait_schedule: { ...(node.wait_schedule ?? { initial_seconds: 30, multiplier: 1.5, maximum_seconds: 300, jitter_percent: 10, deadline_seconds: 3600 }), initial_seconds: Number(event.target.value) } })} /></label><label><span>Backoff multiplier</span><input aria-label="Wait multiplier" type="number" min="1" max="10" step="0.1" value={node.wait_schedule?.multiplier ?? 1.5} onChange={(event) => patchNode({ wait_schedule: { ...(node.wait_schedule ?? { initial_seconds: 30, multiplier: 1.5, maximum_seconds: 300, jitter_percent: 10, deadline_seconds: 3600 }), multiplier: Number(event.target.value) } })} /></label><label><span>Maximum interval (seconds)</span><input aria-label="Wait maximum seconds" type="number" min="1" value={node.wait_schedule?.maximum_seconds ?? 300} onChange={(event) => patchNode({ wait_schedule: { ...(node.wait_schedule ?? { initial_seconds: 30, multiplier: 1.5, maximum_seconds: 300, jitter_percent: 10, deadline_seconds: 3600 }), maximum_seconds: Number(event.target.value) } })} /></label><label><span>Jitter percent</span><input aria-label="Wait jitter percent" type="number" min="0" max="50" value={node.wait_schedule?.jitter_percent ?? 10} onChange={(event) => patchNode({ wait_schedule: { ...(node.wait_schedule ?? { initial_seconds: 30, multiplier: 1.5, maximum_seconds: 300, jitter_percent: 10, deadline_seconds: 3600 }), jitter_percent: Number(event.target.value) } })} /></label><label><span>Deadline (seconds)</span><input aria-label="Wait deadline seconds" type="number" min="1" value={node.wait_schedule?.deadline_seconds ?? 3600} onChange={(event) => patchNode({ wait_schedule: { ...(node.wait_schedule ?? { initial_seconds: 30, multiplier: 1.5, maximum_seconds: 300, jitter_percent: 10, deadline_seconds: 3600 }), deadline_seconds: Number(event.target.value) } })} /></label><label><span>After interval</span><select aria-label="Wait next node" value={node.next ?? ""} onChange={(event) => patchNode({ next: event.target.value })}>{workflow.nodes.filter((item) => item.id !== node.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>On deadline</span><select aria-label="Wait timeout node" value={node.timeout_to ?? ""} onChange={(event) => patchNode({ timeout_to: event.target.value })}>{workflow.nodes.filter((item) => item.id !== node.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p className="field-warning">Pair this with a Script node whose “not ready” exit loops back here. The tracker owns the timer, so no supervisor slot or process remains active while waiting.</p></>}
      {node.type === "read" && <label><span>Metadata key</span><input aria-label="Read metadata key" value={node.metadata_key ?? ""} onChange={(event) => patchNode({ metadata_key: event.target.value })} /></label>}
      {node.type === "write" && <><label><span>Metadata key</span><input aria-label="Write metadata key" value={node.metadata_key ?? ""} onChange={(event) => patchNode({ metadata_key: event.target.value })} /></label><label><span>JSON value</span><input aria-label="Write metadata value" value={JSON.stringify(node.metadata_value ?? null)} onChange={(event) => { try { patchNode({ metadata_value: JSON.parse(event.target.value) }); } catch { /* retain the last valid JSON value */ } }} /></label><label><span>Next node</span><select aria-label="Write next node" value={node.next ?? ""} onChange={(event) => patchNode({ next: event.target.value })}>{workflow.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}
      {node.type === "workflow" && <label><span>Child workflow</span><select aria-label="Child workflow" value={node.workflow_id ?? ""} onChange={(event) => patchNode({ workflow_id: event.target.value })}>{workflows?.filter((item) => item.definition.id !== workflow.id).map((item) => <option key={item.definition.id} value={item.definition.id}>{item.definition.name}</option>)}</select></label>}
      {node.type === "fan_out" && <label><span>Join at</span><select aria-label="Fan in node" value={node.fan_in ?? ""} onChange={(event) => patchNode({ fan_in: event.target.value })}>{workflow.nodes.filter((item) => item.type === "fan_in").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {node.type === "fan_in" && <label><span>Next node</span><select aria-label="Fan in next node" value={node.next ?? ""} onChange={(event) => patchNode({ next: event.target.value })}>{workflow.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {node.type === "terminal" && <label><span>Terminal status</span><select aria-label="Terminal status" value={node.terminal_status ?? "completed"} onChange={(event) => patchNode({ terminal_status: event.target.value as NonNullable<WorkflowNode["terminal_status"]> })}><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label>}
      {node.type === "terminal" && <label><span>Return status code</span><input aria-label="Terminal status code" type="number" min="0" max="255" value={node.status_code ?? (node.terminal_status === "completed" ? 0 : 1)} onChange={(event) => patchNode({ status_code: Number(event.target.value) })} /></label>}
      {node.type === "terminal" && node.terminal_status === "completed" && <><label className="toggle"><input aria-label="Watch completed PR feedback" type="checkbox" checked={Boolean(node.github_watch)} onChange={(event) => event.target.checked ? patchNode({ github_watch: { pull_request_phase: "all", feedback_target: workflow.nodes.find((item) => item.type === "agent")?.id ?? workflow.start } }) : clearNodeKey("github_watch")} /><span><strong>Watch completed PR feedback</strong><small>New feedback follows an explicit workflow target.</small></span></label>{node.github_watch && <><label><span>PR phase</span><select aria-label="Completed GitHub PR phase" value={node.github_watch.pull_request_phase} onChange={(event) => patchNode({ github_watch: { ...node.github_watch!, pull_request_phase: event.target.value as NonNullable<WorkflowNode["github_watch"]>["pull_request_phase"] } })}><option value="specification">Specification PRs</option><option value="implementation">Implementation PRs</option><option value="review">Review PRs</option><option value="all">All ticket PRs</option></select></label><label><span>Feedback target</span><select aria-label="Completed GitHub feedback target" value={node.github_watch.feedback_target ?? ""} onChange={(event) => patchNode({ github_watch: { ...node.github_watch!, feedback_target: event.target.value } })}>{workflow.nodes.filter((item) => item.type !== "terminal").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}</>}
    </div>
    {(["agent", "script", "checkpoint", "restore_checkpoint", "human_gate", "read", "workflow", "fan_out"] as const).includes(node.type as never) && <section className="outcome-editor"><div><span>{node.type === "human_gate" ? "Choices shown to the human" : ["script", "checkpoint", "restore_checkpoint"].includes(node.type) ? "Exit-code routes" : node.type === "read" ? "Metadata cases" : node.type === "workflow" ? "Child status-code routes" : node.type === "fan_out" ? "Branches" : "Agent outcomes"}</span><button type="button" onClick={addRoute}>＋ Add</button></div>{routes.map((route, index) => <div className="typed-outcome-row" key={`${route.id}:${index}`}>
      <label><span>Label</span><input aria-label={`Outcome ${index + 1} label`} value={route.label} onChange={(event) => patchRoute(index, { label: event.target.value, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></label>
      <label><span>ID</span><input aria-label={`Outcome ${index + 1} id`} value={route.id} onChange={(event) => patchRoute(index, { id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></label>
      {["script", "checkpoint", "restore_checkpoint"].includes(node.type) && <label><span>Exit codes</span><input aria-label={`Outcome ${index + 1} exit codes`} disabled={node.exit_codes[index]?.default === true} value={node.exit_codes[index]?.default ? "All other / error" : (node.exit_codes[index]?.codes ?? []).join(", ")} onChange={(event) => patchNode({ exit_codes: node.exit_codes.map((item, candidate) => candidate === index ? { ...item, codes: event.target.value.split(",").map((value) => Number(value.trim())).filter(Number.isInteger) } : item) })} /></label>}
      {node.type === "workflow" && <label><span>Status codes</span><input aria-label={`Outcome ${index + 1} status codes`} disabled={node.status_codes?.[index]?.default === true} value={node.status_codes?.[index]?.default ? "All other" : (node.status_codes?.[index]?.codes ?? []).join(", ")} onChange={(event) => patchNode({ status_codes: (node.status_codes ?? []).map((item, candidate) => candidate === index ? { ...item, codes: event.target.value.split(",").map((value) => Number(value.trim())).filter(Number.isInteger) } : item) })} /></label>}
      {node.type === "read" && <label><span>Equals JSON</span><input aria-label={`Outcome ${index + 1} metadata value`} disabled={node.metadata_cases?.[index]?.default === true} value={node.metadata_cases?.[index]?.default ? "Any other / missing" : JSON.stringify(node.metadata_cases?.[index]?.equals ?? null)} onChange={(event) => { try { patchNode({ metadata_cases: (node.metadata_cases ?? []).map((item, candidate) => candidate === index ? { ...item, equals: JSON.parse(event.target.value) } : item) }); } catch { /* retain last valid JSON */ } }} /></label>}
      <label><span>Next node</span><select aria-label={`Outcome ${index + 1} target`} value={route.target} onChange={(event) => patchRoute(index, { target: event.target.value })}>{workflow.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>Metrics</span><select aria-label={`Outcome ${index + 1} metric class`} value={route.metric_class ?? "unclassified"} onChange={(event) => setRouteMetricClass(index, event.target.value)}><option value="success">Success</option><option value="failure">Failure</option><option value="neutral">Neutral</option><option value="unclassified">Unclassified</option></select></label>
      <label className="route-description"><span>Description</span><input aria-label={`Outcome ${index + 1} description`} value={route.description} onChange={(event) => patchRoute(index, { description: event.target.value })} /></label>
      {node.type === "human_gate" && <label className="toggle"><input type="checkbox" checked={node.choices[index]?.comment_required === true} onChange={(event) => patchNode({ choices: node.choices.map((item, candidate) => candidate === index ? { ...item, comment_required: event.target.checked } : item) })} /><span><strong>Require comment</strong></span></label>}
      {["script", "checkpoint", "restore_checkpoint"].includes(node.type) && <label className="toggle"><input type="checkbox" checked={node.exit_codes[index]?.default === true} onChange={(event) => patchNode({ exit_codes: node.exit_codes.map((item, candidate) => {
        if (candidate === index) {
          if (event.target.checked) { const { codes: _codes, ...rest } = item; return { ...rest, default: true }; }
          return { ...item, default: false, codes: item.codes ?? [1] };
        }
        return event.target.checked ? { ...item, default: false } : item;
      }) })} /><span><strong>Default route</strong></span></label>}
      {node.type === "workflow" && <label className="toggle"><input type="checkbox" checked={node.status_codes?.[index]?.default === true} onChange={(event) => patchNode({ status_codes: (node.status_codes ?? []).map((item, candidate) => candidate === index ? event.target.checked ? { ...item, default: true, codes: undefined } : { ...item, default: false, codes: item.codes ?? [1] } : event.target.checked ? { ...item, default: false } : item) })} /><span><strong>Default route</strong></span></label>}
      {node.type === "read" && <label className="toggle"><input type="checkbox" checked={node.metadata_cases?.[index]?.default === true} onChange={(event) => patchNode({ metadata_cases: (node.metadata_cases ?? []).map((item, candidate) => candidate === index ? event.target.checked ? { ...item, default: true, equals: undefined } : { ...item, default: false, equals: null } : event.target.checked ? { ...item, default: false } : item) })} /><span><strong>Default case</strong></span></label>}
      <button type="button" aria-label={`Delete outcome ${route.id}`} onClick={() => replaceRoutes(routes.filter((_, candidate) => candidate !== index))}>×</button>
    </div>)}</section>}
    <button className="button-danger delete-node" disabled={workflow.nodes.length <= 1} onClick={onDelete}>Delete node</button>
  </aside>;
}

function WorkflowContractEditor({ workflow, onChange }: { workflow: WorkflowDocument["definition"]; onChange: (workflow: WorkflowDocument["definition"]) => void }) {
  const cleanId = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const addInput = () => {
    let id = "condition"; let index = 1;
    while (workflow.inputs.some((input) => input.id === id)) id = `condition-${++index}`;
    onChange({ ...workflow, inputs: [...workflow.inputs, { id, label: "New condition", type: "boolean", default: true }] });
  };
  const updateInput = (index: number, patch: Partial<WorkflowDocument["definition"]["inputs"][number]>) => {
    const previous = workflow.inputs[index]!; const next = { ...previous, ...patch };
    const nodes = next.id === previous.id ? workflow.nodes : workflow.nodes.map((node) => ({
      ...node,
      ...(node.when?.input === previous.id ? { when: { ...node.when, input: next.id } } : {}),
      ...(node.script_file?.path_input === previous.id ? { script_file: { ...node.script_file, path_input: next.id } } : {}),
      ...(node.working_directory?.path_input === previous.id ? { working_directory: { ...node.working_directory, path_input: next.id } } : {}),
    }));
    onChange({ ...workflow, inputs: workflow.inputs.map((input, candidate) => candidate === index ? next : input), nodes });
  };
  const inputInUse = (id: string) => workflow.nodes.some((node) => node.when?.input === id || node.script_file?.path_input === id || node.working_directory?.path_input === id);
  const addStage = () => {
    let id = "stage"; let index = 1;
    while (workflow.stages.some((stage) => stage.id === id)) id = `stage-${++index}`;
    onChange({ ...workflow, stages: [...workflow.stages, { id, name: "New stage", phase: "implementation", skippable: false, default_enabled: true }] });
  };
  const updateStage = (index: number, patch: Partial<WorkflowDocument["definition"]["stages"][number]>) => {
    const previous = workflow.stages[index]!; const next = { ...previous, ...patch };
    const nodes = workflow.nodes.map((node) => node.stage === previous.id ? { ...node, ...(next.id !== previous.id ? { stage: next.id } : {}), ...(next.phase !== previous.phase ? { phase: next.phase } : {}) } : node);
    onChange({ ...workflow, stages: workflow.stages.map((stage, candidate) => candidate === index ? next : stage), nodes });
  };
  const requireStage = (index: number) => onChange({ ...workflow, stages: workflow.stages.map((stage, candidate) => {
    if (candidate !== index) return stage;
    const { bypass_to: _bypass, ...rest } = stage;
    return { ...rest, skippable: false, default_enabled: true };
  }) });
  return <section className="workflow-contracts" aria-label="Workflow inputs and stages">
    <div className="contract-panel"><div className="section-heading"><div><span>Ticket configuration</span><h3>Conditions & parameters</h3></div><button type="button" className="button-secondary" onClick={addInput}>＋ Add field</button></div>
      <p>These typed fields are shown when a ticket selects this workflow. Nodes may test them, and Script nodes may use text/select values as contained relative paths.</p>
      {workflow.inputs.length ? workflow.inputs.map((input, index) => <div className="contract-row" key={`${input.id}:${index}`}>
        <label><span>Label</span><input aria-label={`Input ${index + 1} label`} value={input.label} onChange={(event) => updateInput(index, { label: event.target.value })} /></label>
        <label><span>ID</span><input aria-label={`Input ${index + 1} id`} value={input.id} onChange={(event) => updateInput(index, { id: cleanId(event.target.value) })} /></label>
        <label><span>Type</span><select aria-label={`Input ${index + 1} type`} value={input.type} onChange={(event) => event.target.value === "select" ? updateInput(index, { type: "select", default: "option-1", options: [{ value: "option-1", label: "Option 1" }] }) : event.target.value === "text" ? updateInput(index, { type: "text", default: "", options: [] }) : updateInput(index, { type: "boolean", default: true, options: [] })}><option value="boolean">Yes / no</option><option value="select">Select</option><option value="text">Text parameter</option></select></label>
        {input.type === "boolean" ? <label><span>Default</span><select aria-label={`Input ${index + 1} default`} value={String(input.default)} onChange={(event) => updateInput(index, { default: event.target.value === "true" })}><option value="true">Enabled</option><option value="false">Disabled</option></select></label> : input.type === "text" ? <label className="wide"><span>Default</span><input aria-label={`Input ${index + 1} default`} value={String(input.default)} onChange={(event) => updateInput(index, { default: event.target.value })} /></label> : <><label className="wide"><span>Options</span><input aria-label={`Input ${index + 1} options`} value={(input.options ?? []).map((option) => `${option.value}:${option.label}`).join(", ")} onChange={(event) => { const options = event.target.value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => { const [value, ...label] = part.split(":"); return { value: cleanId(value ?? ""), label: label.join(":").trim() || humanize(value ?? "") }; }); updateInput(index, { options, default: options.some((option) => option.value === input.default) ? input.default : options[0]?.value ?? "" }); }} /></label><label><span>Default</span><select aria-label={`Input ${index + 1} default`} value={String(input.default)} onChange={(event) => updateInput(index, { default: event.target.value })}>{input.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></>}
        <button type="button" className="icon-button" disabled={inputInUse(input.id)} title={inputInUse(input.id) ? "Remove node conditions and Script path references first" : "Delete field"} onClick={() => onChange({ ...workflow, inputs: workflow.inputs.filter((_, candidate) => candidate !== index) })}>×</button>
      </div>) : <p className="muted">No ticket-configurable conditions.</p>}
    </div>
    <div className="contract-panel"><div className="section-heading"><div><span>Workflow projection</span><h3>Stages</h3></div><button type="button" className="button-secondary" onClick={addStage}>＋ Add stage</button></div>
      <p>Configurable stages may be disabled per ticket. Required stages cannot be bypassed.</p>
      {workflow.stages.map((stage, index) => <div className="contract-row" key={`${stage.id}:${index}`}>
        <label><span>Name</span><input aria-label={`Stage ${index + 1} name`} value={stage.name} onChange={(event) => updateStage(index, { name: event.target.value })} /></label>
        <label><span>ID</span><input aria-label={`Stage ${index + 1} id`} value={stage.id} onChange={(event) => updateStage(index, { id: cleanId(event.target.value) })} /></label>
        <label><span>Operational role</span><select aria-label={`Stage ${index + 1} role`} value={stage.phase} onChange={(event) => updateStage(index, { phase: event.target.value as typeof stage.phase })}><option value="specification">Specification work</option><option value="implementation">Delivery work</option><option value="review">Independent review</option><option value="done">Terminal</option></select></label>
        <label><span>Requirement</span><select aria-label={`Stage ${index + 1} requirement`} value={stage.skippable ? "configurable" : "required"} onChange={(event) => event.target.value === "configurable" ? updateStage(index, { skippable: true, default_enabled: true, bypass_to: workflow.nodes.find((node) => node.stage !== stage.id)?.id ?? workflow.start }) : requireStage(index)}><option value="required">Required</option><option value="configurable">Ticket configurable</option></select></label>
        {stage.skippable && <><label><span>Default</span><select aria-label={`Stage ${index + 1} default`} value={String(stage.default_enabled)} onChange={(event) => updateStage(index, { default_enabled: event.target.value === "true" })}><option value="true">Enabled</option><option value="false">Disabled</option></select></label><label><span>Bypass to</span><select aria-label={`Stage ${index + 1} bypass target`} value={stage.bypass_to} onChange={(event) => updateStage(index, { bypass_to: event.target.value })}>{workflow.nodes.filter((node) => node.stage !== stage.id).map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label></>}
        <button type="button" className="icon-button" disabled={workflow.nodes.some((node) => node.stage === stage.id)} title={workflow.nodes.some((node) => node.stage === stage.id) ? "Move nodes to another stage first" : "Delete stage"} onClick={() => onChange({ ...workflow, stages: workflow.stages.filter((_, candidate) => candidate !== index) })}>×</button>
      </div>)}
    </div>
  </section>;
}

function WorkflowEditorPage({ workflows, releases, prompts, agentProfiles, onChanged, onReleasesChanged, onError }: {
  workflows: WorkflowDocument[]; releases: WorkflowReleaseCatalog | null; prompts: PromptDocument[]; agentProfiles: TrackerConfig["agent_profiles"] | undefined; onChanged: (workflows: WorkflowDocument[]) => void; onReleasesChanged: (catalog: WorkflowReleaseCatalog) => void; onError: (message: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState("standard-delivery");
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState<"new" | "clone" | null>(null);
  const [returnId, setReturnId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [releaseLabel, setReleaseLabel] = useState("");
  const [showRetiredReleases, setShowRetiredReleases] = useState(false);
  const selected = workflows.find((workflow) => workflow.definition.id === selectedId) ?? workflows[0];
  useEffect(() => { if (selected && !creating) { setDraft(editableWorkflowContent(selected)); setSelectedNodeId(selected.definition.start); } }, [selected?.revision, creating]);
  useEffect(() => { setShowRetiredReleases(false); }, [selected?.definition.id]);
  let preview: WorkflowDocument["definition"] | null = null;
  let parseError: string | null = null;
  try {
    const parsed = parse(draft) as WorkflowDocument["definition"];
    if (parsed && Array.isArray(parsed.nodes)) preview = parsed;
    else parseError = "Workflow YAML must contain a nodes list.";
  } catch (error) { parseError = (error as Error).message; }
  const errors = [...(parseError ? [parseError] : []), ...workflowErrors(preview)];
  const setDefinition = (definition: WorkflowDocument["definition"], nextSelectedNode = selectedNodeId ?? definition.start) => { setDraft(stringify(definition, { lineWidth: 0 })); setSelectedNodeId(nextSelectedNode); };
  const beginNew = () => { const definition = newWorkflowDefinition("new-workflow", agentProfiles?.default ?? "claude"); setReturnId(selected?.definition.id ?? null); setCreating("new"); setSelectedId(definition.id); setDefinition(definition, definition.start); onError(null); };
  const clone = () => {
    if (!selected) return;
    const definition = structuredClone(selected.definition);
    definition.id = `copy-of-${selected.definition.id}`; definition.name = `${selected.definition.name} copy`;
    setReturnId(selected.definition.id); setSelectedId(definition.id); setCreating("clone"); setDefinition(definition, definition.start); onError(null);
  };
  const cancelCreate = () => { const target = workflows.find((workflow) => workflow.definition.id === returnId) ?? workflows[0]; setCreating(null); setReturnId(null); if (target) { setSelectedId(target.definition.id); setDraft(editableWorkflowContent(target)); setSelectedNodeId(target.definition.start); } };
  const addNode = (type: WorkflowNode["type"]) => {
    if (!preview) return;
    const base = type.replace("human_gate", "approval"); let suffix = 1; let id = base;
    while (preview.nodes.some((node) => node.id === id)) id = `${base}-${++suffix}`;
    const source = preview.nodes.find((node) => node.id === selectedNodeId);
    const sourceRoute = source ? nodeRoutes(source)[0] : undefined;
    const target = sourceRoute?.target ?? (source?.type === "terminal" ? source.id : preview.nodes.find((node) => node.type === "terminal")?.id ?? preview.nodes[0]?.id ?? id);
    const stage = type === "terminal" ? preview.stages.find((item) => item.phase === "done")?.id ?? preview.stages[0]?.id ?? "done" : source?.stage ?? preview.stages.find((item) => item.phase === "implementation")?.id ?? preview.stages[0]?.id ?? "work";
    const phase = preview.stages.find((item) => item.id === stage)?.phase ?? (type === "terminal" ? "done" : "implementation");
    const node: WorkflowNode = { id, name: humanize(type), type, phase, stage, max_visits: 10, outcomes: [], choices: [], exit_codes: [] };
    if (type === "agent") Object.assign(node, { prompt: "implementation", agent_profile: agentProfiles?.default ?? "claude", conversation_key: "work", max_cost_usd: 50, outcomes: [{ id: "completed", label: "Work completed", description: "The assigned work is finished.", target, metric_class: "success" }] });
    if (type === "script") Object.assign(node, { repository: "primary", script_file: { path: ".agents/actions/run.sh", relative_to: "selected_repository" }, working_directory: { path: ".", relative_to: "selected_repository" }, script_output: { persist_stdout: true, prompt_tail_lines: 20 }, exit_codes: [{ id: "success", label: "Success", description: "Exited with code 0.", target, metric_class: "success", codes: [0] }, { id: "failure", label: "Failure", description: "All other exit codes and execution errors.", target: id, metric_class: "failure", default: true }] });
    if (type === "checkpoint") Object.assign(node, { checkpoint_label: "Workflow checkpoint", exit_codes: [{ id: "created", label: "Created", description: "All declared repositories were captured.", target, metric_class: "success", codes: [0] }, { id: "failed", label: "Failed", description: "Checkpoint capture failed.", target: id, metric_class: "failure", default: true }] });
    if (type === "restore_checkpoint") Object.assign(node, { checkpoint_source: { mode: "latest" }, exit_codes: [{ id: "restored", label: "Restored", description: "All declared repositories were restored.", target, metric_class: "success", codes: [0] }, { id: "failed", label: "Failed", description: "Restore failed and compensation was attempted.", target: id, metric_class: "failure", default: true }] });
    if (type === "human_gate") Object.assign(node, { choices: [{ id: "approved", label: "Approve", description: "Continue the workflow.", target, metric_class: "success" }, { id: "changes-requested", label: "Request changes", description: "Return for another iteration.", target: id, metric_class: "failure", comment_required: true }] });
    if (type === "wait") Object.assign(node, { wait_schedule: { initial_seconds: 30, multiplier: 1.5, maximum_seconds: 300, jitter_percent: 10, deadline_seconds: 3600 }, next: target, timeout_to: target });
    if (type === "read") Object.assign(node, { metadata_key: "result", metadata_cases: [{ id: "matched", label: "Matched", description: "Value matched.", target, metric_class: "success", equals: true }, { id: "default", label: "Default", description: "No case matched.", target: id, metric_class: "neutral", default: true }] });
    if (type === "write") Object.assign(node, { metadata_key: "result", metadata_value: true, next: target });
    if (type === "workflow") Object.assign(node, { workflow_id: workflows.find((item) => item.definition.id !== preview.id)?.definition.id ?? "standard-delivery", status_codes: [{ id: "success", label: "Success", description: "Child returned zero.", target, metric_class: "success", codes: [0] }, { id: "failure", label: "Failure", description: "All other statuses.", target: id, metric_class: "failure", default: true }] });
    if (type === "fan_out") Object.assign(node, { branches: [{ id: "branch-a", label: "Branch A", description: "First branch.", target, metric_class: "neutral" }, { id: "branch-b", label: "Branch B", description: "Second branch.", target, metric_class: "neutral" }], fan_in: preview.nodes.find((item) => item.type === "fan_in")?.id ?? target });
    if (type === "fan_in") Object.assign(node, { next: target });
    if (type === "terminal") Object.assign(node, { terminal_status: "completed", status_code: 0 });
    let nodes = preview.nodes.map((item) => sourceRoute && item.id === source?.id ? replaceNodeTargets(item, sourceRoute.target, id) : item);
    if (source?.type === "terminal") nodes = nodes.map((item) => replaceNodeTargets(item, source.id, id));
    const stages = preview.stages.map((item) => source?.type === "terminal" && item.bypass_to === source.id ? { ...item, bypass_to: id } : item);
    const insertion = Math.max(0, source ? nodes.findIndex((item) => item.id === source.id) + (source.type === "terminal" ? 0 : 1) : nodes.length);
    nodes.splice(insertion, 0, node);
    setDefinition({ ...preview, nodes, stages }, id);
  };
  const deleteNode = () => {
    if (!preview || !selectedNodeId) return;
    const removed = preview.nodes.find((node) => node.id === selectedNodeId);
    const replacement = removed ? nodeRoutes(removed).map((route) => route.target).find((target) => target !== selectedNodeId) : undefined;
    if (!replacement && preview.nodes.some((node) => node.id !== selectedNodeId && [...nodeRoutes(node).map((route) => route.target), node.otherwise].includes(selectedNodeId))) return onError("Choose another target for incoming paths before deleting this node.");
    const nodes = preview.nodes.filter((node) => node.id !== selectedNodeId).map((node) => replacement ? replaceNodeTargets(node, selectedNodeId, replacement) : node);
    if (!nodes.length) return;
    const stages = preview.stages.map((stage) => stage.bypass_to === selectedNodeId && replacement ? { ...stage, bypass_to: replacement } : stage);
    setDefinition({ ...preview, start: preview.start === selectedNodeId ? nodes[0]!.id : preview.start, nodes, stages }, nodes[0]!.id);
  };
  const save = async (makeDefault = false) => {
    setBusy(true); onError(null);
    try {
      const result = creating ? await api.createWorkflow(draft, releaseLabel.trim() || undefined) : await api.updateWorkflow(selected!, draft, makeDefault, releaseLabel.trim() || undefined);
      const next = [...workflows.filter((workflow) => workflow.definition.id !== result.workflow.definition.id), result.workflow]
        .sort((a, b) => a.definition.name.localeCompare(b.definition.name));
      onChanged(next); onReleasesChanged(await api.workflowReleases()); setSelectedId(result.workflow.definition.id); setCreating(null); setReturnId(null); setDraft(result.workflow.content); setSelectedNodeId(result.workflow.definition.start); setReleaseLabel("");
    } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  const promote = async (revision: string) => {
    if (!selected) return;
    setBusy(true); onError(null);
    try { await api.promoteWorkflow(selected.definition.id, revision); onReleasesChanged(await api.workflowReleases()); }
    catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  if (!selected && !creating) return <main className="configuration-page"><div className="empty-health"><h2>Workflow library unavailable</h2></div></main>;
  const selectedNode = preview?.nodes.find((node) => node.id === selectedNodeId) ?? preview?.nodes[0];
  const familyReleases = releases?.releases.filter((release) => release.workflow_id === selected?.definition.id) ?? [];
  const retiredReleaseCount = familyReleases.filter((release) => release.status === "retired").length;
  const visibleReleases = familyReleases
    .filter((release) => showRetiredReleases || release.status !== "retired")
    .sort((left, right) => Number(right.is_default) - Number(left.is_default) || right.version - left.version);
  return <main className="workflow-page">
    <div className="health-heading"><div><span>Software factory</span><h1>Workflow editor</h1><p>Build a directed graph of durable boundaries while agents remain autonomous inside agent nodes.</p></div><div className="artifact-actions"><button className="button-secondary" disabled={busy || !selected} onClick={clone}>Clone workflow</button><button className="button-primary" disabled={busy} onClick={beginNew}>New workflow</button></div></div>
    <div className="workflow-editor-layout">
      <aside className="prompt-list">{creating && preview && <button className="active artifact-draft"><strong>{preview.name}</strong><small>{preview.id}.yaml · unsaved</small></button>}{workflows.map((workflow) => <button className={!creating && workflow.definition.id === selected?.definition.id ? "active" : ""} key={workflow.definition.id} onClick={() => { setCreating(null); setSelectedId(workflow.definition.id); }}><strong>{workflow.definition.name}</strong><small>{workflow.definition.id}.yaml · v{workflow.version}</small>{!workflow.valid && <em>Invalid</em>}</button>)}</aside>
      <section className="workflow-editor-main">
        <div className="prompt-heading"><div><span>{creating ? `${creating === "clone" ? "Cloned" : "New"} artifact` : `${selected?.definition.id}.yaml · v${selected?.version}`}</span><h2>{preview?.name ?? "Workflow draft"}</h2><p>{preview?.description}</p></div>{selected && !creating && <code>{selected.revision.slice(0, 12)}</code>}</div>
        {selected && !creating && <section className="workflow-releases"><div className="section-heading"><div><span>Revision history</span><h3>Default and trial revisions</h3><p>Each publication creates an immutable numbered revision. One revision is the default for new tickets; trials must be selected explicitly.</p></div>{retiredReleaseCount > 0 && <button className="button-secondary button-compact" type="button" onClick={() => setShowRetiredReleases((value) => !value)}>{showRetiredReleases ? "Hide retired revisions" : `Show retired revisions (${retiredReleaseCount})`}</button>}</div><div>{visibleReleases.map((release) => <article key={release.revision} className={release.is_default ? "default-release" : ""}><span><strong>{releaseDisplayLabel(release)}</strong><small>{release.revision.slice(0, 12)} · {humanize(release.status)} · published {timeAgo(release.published_at, Date.now())}</small></span>{!release.is_default && <button className="button-secondary button-compact" disabled={busy} onClick={() => void promote(release.revision)}>{release.status === "retired" ? "Restore as default" : "Make default"}</button>}</article>)}</div></section>}
        {preview && <section className="workflow-settings" aria-label="Workflow settings"><label><span>Workflow ID</span><input aria-label="Workflow ID" disabled={!creating} value={preview.id} onChange={(event) => { const id = event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); setSelectedId(id); setDefinition({ ...preview, id }); }} /></label><label><span>Name</span><input aria-label="Workflow name" value={preview.name} onChange={(event) => setDefinition({ ...preview, name: event.target.value })} /></label><label className="wide"><span>Description</span><input aria-label="Workflow description" value={preview.description} onChange={(event) => setDefinition({ ...preview, description: event.target.value })} /></label><label><span>Start node</span><select aria-label="Workflow start node" value={preview.start} onChange={(event) => setDefinition({ ...preview, start: event.target.value })}>{preview.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><label><span>Transition limit</span><input aria-label="Workflow transition limit" type="number" min="1" value={preview.max_transitions} onChange={(event) => setDefinition({ ...preview, max_transitions: Number(event.target.value) })} /></label></section>}
        {preview && <WorkflowContractEditor workflow={preview} onChange={setDefinition} />}
        <div className="workflow-toolbar"><div><strong>Add node</strong>{(["agent", "script", "checkpoint", "restore_checkpoint", "human_gate", "wait", "read", "write", "workflow", "fan_out", "fan_in", "terminal"] as const).map((type) => <button type="button" key={type} onClick={() => addNode(type)}>＋ {humanize(type)}</button>)}</div><span>Select a node to edit its behavior and outcomes.</span></div>
        {preview && <div className="workflow-builder"><WorkflowGraph workflow={preview} {...(selectedNode ? { selectedNode: selectedNode.id } : {})} onSelect={setSelectedNodeId} />{selectedNode && <WorkflowNodeInspector workflow={preview} node={selectedNode} prompts={prompts} agentProfiles={agentProfiles} workflows={workflows} onChange={setDefinition} onDelete={deleteNode} />}</div>}
        {errors.length > 0 && <div className="draft-validation" role="alert"><strong>Workflow draft needs attention</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
        <details className="workflow-source" open={!preview}><summary>Advanced YAML source</summary><p>The structured editor and this source stay synchronized. Published revisions remain immutable for pinned tickets.</p><textarea aria-label="Workflow YAML" value={draft} onChange={(event) => setDraft(event.target.value)} /></details>
        <div className="prompt-actions"><label className="release-label">Release label<input aria-label="Workflow release label" placeholder={creating ? "Initial release" : `Trial v${(selected?.version ?? 0) + 1}`} value={releaseLabel} onChange={(event) => setReleaseLabel(event.target.value)} /></label><span>{preview?.nodes.length ?? 0} nodes · {preview?.nodes.filter((node) => node.prompt).length ?? 0} prompt reference(s)</span>{creating && <button className="button-secondary" onClick={cancelCreate}>Cancel</button>}{!creating && <button className="button-secondary" disabled={busy || !draft.trim() || errors.length > 0 || draft === selected?.content} onClick={() => void save(false)}>Publish as trial</button>}<button className="button-primary" disabled={busy || !draft.trim() || errors.length > 0 || (!creating && draft === selected?.content)} onClick={() => void save(true)}>{creating ? "Create workflow" : "Publish and make default"}</button></div>
      </section>
    </div>
  </main>;
}

function formatMetric(value: number | null, kind: "duration" | "tokens" | "cost" | "number"): string {
  if (value === null) return "—";
  if (kind === "duration") return duration(value);
  if (kind === "tokens") return tokenCount(value);
  if (kind === "cost") return usd(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function FiveNumberCard({ title, summary, kind }: { title: string; summary: NumberSummary; kind: "duration" | "tokens" | "cost" | "number" }) {
  return <section className="metrics-summary-card"><div><span>{title}</span><strong>{formatMetric(summary.median, kind)}</strong><small>Median · n={summary.count}</small></div><dl>
    <div><dt>Min</dt><dd>{formatMetric(summary.min, kind)}</dd></div><div><dt>Q1</dt><dd>{formatMetric(summary.q1, kind)}</dd></div>
    <div><dt>Median</dt><dd>{formatMetric(summary.median, kind)}</dd></div><div><dt>Q3</dt><dd>{formatMetric(summary.q3, kind)}</dd></div>
    <div><dt>Max</dt><dd>{formatMetric(summary.max, kind)}</dd></div><div><dt>P90</dt><dd>{formatMetric(summary.p90, kind)}</dd></div>
  </dl></section>;
}

type MetricsTab = "overview" | "runtime" | "reliability" | "cost" | "compare";

function ExecutiveMetric({ label, value, detail, coverage }: { label: string; value: string; detail: string; coverage: string }) {
  return <article className="executive-metric"><span>{label}</span><strong>{value}</strong><p>{detail}</p><small>{coverage}</small></article>;
}

function MetricsPage({ releases, onError }: { releases: WorkflowReleaseCatalog | null; onError: (message: string | null) => void }) {
  const [report, setReport] = useState<MetricsReport | null>(null);
  const [comparison, setComparison] = useState<WorkflowComparisonReport | null>(null);
  const [compareLeft, setCompareLeft] = useState("");
  const [compareRight, setCompareRight] = useState("");
  const [tab, setTab] = useState<MetricsTab>("overview");
  const [filters, setFilters] = useState({ from: "", to: "", labels: [] as string[], labelMode: "any" as "any" | "all", workflowId: "", workflowRevision: "", productionResult: "" });
  const [loading, setLoading] = useState(false);
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    let active = true; setLoading(true);
    void api.metrics({
      ...(filters.from ? { from: new Date(`${filters.from}T00:00:00`).toISOString() } : {}),
      ...(filters.to ? { to: new Date(`${filters.to}T23:59:59.999`).toISOString() } : {}),
      labels: filters.labels, labelMode: filters.labelMode,
      ...(filters.workflowId ? { workflowId: filters.workflowId } : {}),
      ...(filters.workflowRevision ? { workflowRevision: filters.workflowRevision } : {}),
      ...(filters.productionResult ? { productionResult: filters.productionResult } : {}),
    }).then((value) => { if (active) { setReport(value); onError(null); } }).catch((error: Error) => { if (active) onError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filterKey]);
  const releaseOptions = releases?.releases ?? [];
  const releaseKey = releaseOptions.map((release) => `${release.workflow_id}@${release.revision}`).join("|");
  useEffect(() => {
    if (!releaseOptions.length) return;
    const defaultRelease = releaseOptions.find((release) => release.is_default) ?? releaseOptions[0]!;
    const alternative = releaseOptions.find((release) => release.workflow_id === defaultRelease.workflow_id && release.revision !== defaultRelease.revision)
      ?? releaseOptions.find((release) => release.revision !== defaultRelease.revision);
    setCompareLeft((current) => current || `${defaultRelease.workflow_id}@${defaultRelease.revision}`);
    setCompareRight((current) => current || (alternative ? `${alternative.workflow_id}@${alternative.revision}` : ""));
  }, [releaseKey]);
  useEffect(() => {
    if (tab !== "compare" || !compareLeft || !compareRight || compareLeft === compareRight) { setComparison(null); return; }
    const release = (value: string) => releaseOptions.find((item) => `${item.workflow_id}@${item.revision}` === value);
    const left = release(compareLeft); const right = release(compareRight);
    if (!left || !right) { setComparison(null); return; }
    let active = true;
    void api.compareWorkflows({ id: left.workflow_id, revision: left.revision }, { id: right.workflow_id, revision: right.revision }, {
      ...(filters.from ? { from: new Date(`${filters.from}T00:00:00`).toISOString() } : {}),
      ...(filters.to ? { to: new Date(`${filters.to}T23:59:59.999`).toISOString() } : {}),
      labels: filters.labels, labelMode: filters.labelMode,
      ...(filters.productionResult ? { productionResult: filters.productionResult } : {}),
    }).then((value) => { if (active) setComparison(value); }).catch((error: Error) => { if (active) onError(error.message); });
    return () => { active = false; };
  }, [tab, compareLeft, compareRight, filterKey, releaseKey]);
  const toggleLabel = (label: string) => setFilters((current) => ({ ...current, labels: current.labels.includes(label) ? current.labels.filter((item) => item !== label) : [...current.labels, label] }));
  const revisionName = (workflowId: string, revision: string) => {
    const release = releaseOptions.find((item) => item.workflow_id === workflowId && item.revision === revision);
    return release ? `v${release.version}` : revision.slice(0, 12);
  };
  const releaseName = (value: string) => { const release = releaseOptions.find((item) => `${item.workflow_id}@${item.revision}` === value); return release ? `${release.definition.name} · v${release.version} · ${release.is_default ? "Default" : release.label}` : value; };
  const delta = (metric: keyof WorkflowComparisonReport["deltas"], kind: "rate" | "duration" | "cost" | "tokens") => {
    const value = comparison?.deltas[metric]; if (!value || value.absolute === null) return "—";
    const absolute = kind === "rate" ? `${value.absolute >= 0 ? "+" : ""}${(value.absolute * 100).toFixed(1)} pp` : kind === "duration" ? `${value.absolute >= 0 ? "+" : "−"}${duration(Math.abs(value.absolute))}` : kind === "cost" ? `${value.absolute >= 0 ? "+" : "−"}${usd(Math.abs(value.absolute))}` : `${value.absolute >= 0 ? "+" : "−"}${tokenCount(Math.abs(value.absolute))}`;
    return `${absolute}${value.percent === null ? "" : ` · ${value.percent >= 0 ? "+" : ""}${(value.percent * 100).toFixed(1)}%`}`;
  };
  const clearFilters = () => setFilters({ from: "", to: "", labels: [], labelMode: "any", workflowId: "", workflowRevision: "", productionResult: "" });
  const activeFilterCount = Number(Boolean(filters.from)) + Number(Boolean(filters.to)) + filters.labels.length + Number(Boolean(filters.workflowId)) + Number(Boolean(filters.workflowRevision)) + Number(Boolean(filters.productionResult));
  const allNodes = report?.workflows.flatMap((workflow) => workflow.nodes) ?? [];
  const slowestNode = [...allNodes].filter((node) => node.wall_ms.median !== null).sort((left, right) => (right.wall_ms.median ?? 0) - (left.wall_ms.median ?? 0))[0];
  const leastReliableNode = [...allNodes].filter((node) => node.success_rate !== null && node.runs > 0).sort((left, right) => (left.success_rate ?? 1) - (right.success_rate ?? 1))[0];
  const mostExpensiveNode = [...allNodes].filter((node) => node.telemetry_coverage.cost_runs > 0 && node.runs > 0).sort((left, right) => (right.known_cost_usd / right.runs) - (left.known_cost_usd / left.runs))[0];
  const completionRate = report?.totals.tickets ? report.totals.completed / report.totals.tickets : null;
  const observedRuntime = report ? report.totals.active_ms + report.totals.human_wait_ms + report.totals.external_wait_ms + report.totals.quota_paused_ms : 0;
  const runtimeSegments = report ? [
    { label: "Active", value: report.totals.active_ms, className: "active" },
    { label: "Human wait", value: report.totals.human_wait_ms, className: "human" },
    { label: "External wait", value: report.totals.external_wait_ms, className: "external" },
    { label: "Quota paused", value: report.totals.quota_paused_ms, className: "quota" },
  ] : [];
  const workflowReliability = report && <section className="workflow-metrics"><div className="section-heading"><div><span>Workflow reliability</span><h2>Nodes and branches</h2></div><small>Grouped by immutable workflow revision</small></div>
    {report.workflows.map((workflow) => <details key={`${workflow.workflow_id}@${workflow.workflow_revision}`} open={report.workflows.length === 1}><summary><strong>{humanize(workflow.workflow_id)}</strong><code>{workflow.workflow_revision.slice(0, 12)}</code><span>{workflow.ticket_count} tickets · {workflow.nodes.reduce((sum, node) => sum + node.runs, 0)} runs</span></summary><div className="node-metrics-grid">{workflow.nodes.map((node) => <article key={node.node_id} className="node-metric-card">
      <header><div><span>{humanize(node.node_type)}</span><h3>{node.node_name}</h3></div><strong>{node.success_rate === null ? "—" : `${(node.success_rate * 100).toFixed(0)}%`}</strong></header>
      <p>{node.classifications.success} success · {node.classifications.failure} failure · {node.classifications.neutral} neutral · {node.classifications.unclassified} unclassified</p>
      <div className="reliability-bar"><i style={{ width: `${node.success_rate === null ? 0 : node.success_rate * 100}%` }} /></div>
      <dl><div><dt>Runs</dt><dd>{node.runs}</dd></div><div><dt>Median</dt><dd>{formatMetric(node.wall_ms.median, "duration")}</dd></div><div><dt>Tokens</dt><dd>{node.telemetry_coverage.token_runs ? tokenCount(node.total_tokens) : "—"}</dd></div><div><dt>Cost</dt><dd>{node.telemetry_coverage.cost_runs ? usd(node.known_cost_usd) : "—"}</dd></div></dl>
      {(node.interrupted > 0 || node.lease_lost > 0 || node.delivery_failed > 0 || node.bypassed > 0) && <small>{node.interrupted} interrupted · {node.lease_lost} lease lost · {node.delivery_failed} delivery failed · {node.bypassed} bypassed</small>}
      {node.branches.length > 0 && <div className="branch-metrics"><strong>Branches taken</strong>{node.branches.map((branch) => <div key={branch.outcome}><span><i className={`metric-${branch.metric_class}`} />{branch.label}{branch.target ? ` → ${humanize(branch.target)}` : ""}</span><b>{branch.count} · {(branch.rate * 100).toFixed(0)}%</b></div>)}</div>}
      {(node.quality ?? []).length > 0 && <div className="quality-metrics"><strong>Quality attributes</strong>{node.quality.map((quality) => <div key={`${quality.key}/${quality.type}/${quality.unit}/${quality.direction}`}><span><i className={quality.statuses.fail ? "metric-failure" : quality.statuses.warn ? "metric-neutral" : "metric-success"} />{quality.label}<small>{quality.numeric?.median !== null && quality.numeric ? `Median ${quality.numeric.median}${quality.unit ? ` ${quality.unit}` : ""}` : quality.values.slice(0, 2).map((item) => `${item.value} (${item.count})`).join(", ")}</small></span><b>{quality.pass_rate === null ? "—" : `${(quality.pass_rate * 100).toFixed(0)}% pass`} · n={quality.ticket_count}</b></div>)}</div>}
    </article>)}</div></details>)}
    {!report.workflows.length && <div className="empty-health"><h2>No workflow runs match these filters</h2></div>}
  </section>;
  return <main className="metrics-page">
    <div className="health-heading"><div><span>Operational intelligence</span><h1>Factory metrics</h1><p>Execution reliability, branch behavior, production outcomes, cost, tokens, and elapsed time from durable ticket history.</p></div><div className="health-summary"><strong>{loading ? "…" : report?.totals.tickets ?? 0}</strong><span>filtered tickets</span></div></div>
    <section className="metrics-filter-shell" aria-label="Metrics filters">
      <div className="metrics-filter-primary">
      <label>From<input aria-label="Metrics from date" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
      <label>To<input aria-label="Metrics to date" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
      <label>Workflow<select aria-label="Metrics workflow" value={filters.workflowId} onChange={(event) => setFilters({ ...filters, workflowId: event.target.value, workflowRevision: "" })}><option value="">All workflows</option>{[...new Set(report?.available.workflows.map((item) => item.id) ?? [])].map((id) => <option key={id} value={id}>{humanize(id)}</option>)}</select></label>
      <label>Revision<select aria-label="Metrics workflow revision" disabled={!filters.workflowId} value={filters.workflowRevision} onChange={(event) => setFilters({ ...filters, workflowRevision: event.target.value })}><option value="">All revisions</option>{report?.available.workflows.filter((item) => item.id === filters.workflowId).map((item) => <option key={item.revision} value={item.revision}>{revisionName(item.id, item.revision)}</option>)}</select></label>
      <details className="metrics-more-filters"><summary>More filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</summary><div>
      <label>Production<select aria-label="Metrics production result" value={filters.productionResult} onChange={(event) => setFilters({ ...filters, productionResult: event.target.value })}><option value="">All outcomes</option><option value="unassessed">Unassessed</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="rolled_back">Rolled back</option><option value="not_deployed">Not deployed</option></select></label>
      <label>Label matching<select aria-label="Metrics label matching" value={filters.labelMode} onChange={(event) => setFilters({ ...filters, labelMode: event.target.value as "any" | "all" })}><option value="any">Any selected label</option><option value="all">All selected labels</option></select></label>
      <div className="metrics-label-filter"><span>Labels</span><div>{report?.available.labels.map((label) => <button className={filters.labels.includes(label) ? "active" : ""} key={label} onClick={() => toggleLabel(label)}>{label}</button>)}{!report?.available.labels.length && <small>No labels recorded</small>}</div></div>
      </div></details>
      <button className="button-secondary" disabled={activeFilterCount === 0} onClick={clearFilters}>Clear</button>
      </div>
      {activeFilterCount > 0 && <div className="metrics-filter-chips"><span>Active:</span>{filters.from && <button onClick={() => setFilters({ ...filters, from: "" })}>From {filters.from} ×</button>}{filters.to && <button onClick={() => setFilters({ ...filters, to: "" })}>To {filters.to} ×</button>}{filters.workflowId && <button onClick={() => setFilters({ ...filters, workflowId: "", workflowRevision: "" })}>{humanize(filters.workflowId)} ×</button>}{filters.workflowRevision && <button onClick={() => setFilters({ ...filters, workflowRevision: "" })}>{revisionName(filters.workflowId, filters.workflowRevision)} ×</button>}{filters.productionResult && <button onClick={() => setFilters({ ...filters, productionResult: "" })}>{humanize(filters.productionResult)} ×</button>}{filters.labels.map((label) => <button key={label} onClick={() => toggleLabel(label)}>{label} ×</button>)}</div>}
    </section>
    <nav className="metrics-tabs" role="tablist" aria-label="Metrics views">{([
      ["overview", "Overview"], ["runtime", "Runtime"], ["reliability", "Reliability"], ["cost", "Cost & usage"], ["compare", "Compare"],
    ] as Array<[MetricsTab, string]>).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {tab === "compare" && releaseOptions.length > 0 && <section className="workflow-comparison content-card"><div className="section-heading"><div><span>Experiment analysis</span><h2>Compare workflow revisions</h2></div><small>Efficiency uses completed, non-crossover tickets</small></div><div className="comparison-selectors"><label>Baseline<select aria-label="Comparison baseline" value={compareLeft} onChange={(event) => setCompareLeft(event.target.value)}>{releaseOptions.map((release) => { const value = `${release.workflow_id}@${release.revision}`; return <option key={value} value={value}>{releaseName(value)}</option>; })}</select></label><span>versus</span><label>Candidate<select aria-label="Comparison candidate" value={compareRight} onChange={(event) => setCompareRight(event.target.value)}><option value="">Choose a revision</option>{releaseOptions.map((release) => { const value = `${release.workflow_id}@${release.revision}`; return <option key={value} value={value}>{releaseName(value)}</option>; })}</select></label></div>{comparison && <>
      <div className="comparison-deltas"><ExecutiveMetric label="Completion difference" value={delta("completion_rate", "rate")} detail="Candidate compared with baseline" coverage={`${comparison.left.cohort.assigned} vs ${comparison.right.cohort.assigned} assigned`} /><ExecutiveMetric label="Delivery-time difference" value={delta("median_duration_ms", "duration")} detail="Median elapsed time" coverage={`${comparison.left.summaries.ticket_duration_ms.count} vs ${comparison.right.summaries.ticket_duration_ms.count} measured`} /><ExecutiveMetric label="Cost difference" value={delta("median_cost_usd", "cost")} detail="Median cost per eligible ticket" coverage={`${comparison.left.coverage.cost_tickets} vs ${comparison.right.coverage.cost_tickets} covered`} /></div>
      <div className="comparison-cohorts"><article><strong>{releaseName(compareLeft)}</strong><span>{comparison.left.cohort.completed}/{comparison.left.cohort.assigned} completed</span><small>{comparison.left.cohort.failed} failed · {comparison.left.cohort.cancelled} cancelled · {comparison.left.cohort.in_progress} in progress ({comparison.left.cohort.blocked} blocked) · {comparison.left.cohort.crossover} crossover</small></article><article><strong>{releaseName(compareRight)}</strong><span>{comparison.right.cohort.completed}/{comparison.right.cohort.assigned} completed</span><small>{comparison.right.cohort.failed} failed · {comparison.right.cohort.cancelled} cancelled · {comparison.right.cohort.in_progress} in progress ({comparison.right.cohort.blocked} blocked) · {comparison.right.cohort.crossover} crossover</small></article></div>
      <table className="comparison-table"><thead><tr><th>Metric</th><th>Baseline</th><th>Candidate</th><th>Difference</th></tr></thead><tbody>
        <tr><td>Completion rate</td><td>{comparison.left.completion_rate === null ? "—" : `${(comparison.left.completion_rate * 100).toFixed(1)}%`}</td><td>{comparison.right.completion_rate === null ? "—" : `${(comparison.right.completion_rate * 100).toFixed(1)}%`}</td><td>{delta("completion_rate", "rate")}</td></tr>
        <tr><td>Production success</td><td>{comparison.left.production_success_rate === null ? "—" : `${(comparison.left.production_success_rate * 100).toFixed(1)}%`}</td><td>{comparison.right.production_success_rate === null ? "—" : `${(comparison.right.production_success_rate * 100).toFixed(1)}%`}</td><td>{delta("production_success_rate", "rate")}</td></tr>
        <tr><td>Median cost</td><td>{formatMetric(comparison.left.summaries.cost_per_ticket_usd.median, "cost")}</td><td>{formatMetric(comparison.right.summaries.cost_per_ticket_usd.median, "cost")}</td><td>{delta("median_cost_usd", "cost")}</td></tr>
        <tr><td>Median tokens</td><td>{formatMetric(comparison.left.summaries.tokens_per_ticket.median, "tokens")}</td><td>{formatMetric(comparison.right.summaries.tokens_per_ticket.median, "tokens")}</td><td>{delta("median_tokens", "tokens")}</td></tr>
        <tr><td>Median duration</td><td>{formatMetric(comparison.left.summaries.ticket_duration_ms.median, "duration")}</td><td>{formatMetric(comparison.right.summaries.ticket_duration_ms.median, "duration")}</td><td>{delta("median_duration_ms", "duration")}</td></tr>
        <tr><td>Median active time</td><td>{formatMetric(comparison.left.summaries.active_time_ms.median, "duration")}</td><td>{formatMetric(comparison.right.summaries.active_time_ms.median, "duration")}</td><td>{delta("median_active_ms", "duration")}</td></tr>
      </tbody></table><p className="metrics-coverage">Cost coverage: {comparison.left.coverage.cost_tickets}/{comparison.left.coverage.eligible_tickets} baseline and {comparison.right.coverage.cost_tickets}/{comparison.right.coverage.eligible_tickets} candidate tickets. Token coverage: {comparison.left.coverage.token_tickets}/{comparison.left.coverage.eligible_tickets} and {comparison.right.coverage.token_tickets}/{comparison.right.coverage.eligible_tickets}. Manual trial assignment may introduce selection bias.</p>
      <div className="comparison-nodes"><article><h3>Baseline nodes</h3>{comparison.left.nodes.map((node) => <div key={node.node_id}><span>{node.node_name}{(node.quality ?? []).map((quality) => <small key={`${quality.key}/${quality.type}/${quality.unit}/${quality.direction}`}>{quality.label}: {quality.numeric?.median ?? quality.values[0]?.value ?? "—"}{quality.unit ? ` ${quality.unit}` : ""} · {quality.pass_rate === null ? "unclassified" : `${(quality.pass_rate * 100).toFixed(0)}% pass`}</small>)}</span><strong>{node.success_rate === null ? "—" : `${(node.success_rate * 100).toFixed(0)}%`} · n={node.runs}</strong></div>)}</article><article><h3>Candidate nodes</h3>{comparison.right.nodes.map((node) => <div key={node.node_id}><span>{node.node_name}{(node.quality ?? []).map((quality) => <small key={`${quality.key}/${quality.type}/${quality.unit}/${quality.direction}`}>{quality.label}: {quality.numeric?.median ?? quality.values[0]?.value ?? "—"}{quality.unit ? ` ${quality.unit}` : ""} · {quality.pass_rate === null ? "unclassified" : `${(quality.pass_rate * 100).toFixed(0)}% pass`}</small>)}</span><strong>{node.success_rate === null ? "—" : `${(node.success_rate * 100).toFixed(0)}%`} · n={node.runs}</strong></div>)}</article></div>
    </>}</section>}
    {tab === "compare" && releaseOptions.length === 0 && <div className="empty-health"><h2>No workflow revisions are available to compare</h2></div>}
    {report && <>
      {tab === "overview" && <>
        <section className="executive-metrics" aria-label="Executive summary">
          <ExecutiveMetric label="Median delivery time" value={formatMetric(report.summaries.ticket_duration_ms.median, "duration")} detail={`P90 ${formatMetric(report.summaries.ticket_duration_ms.p90, "duration")} · ${duration(report.totals.active_ms)} total active`} coverage={`${report.summaries.ticket_duration_ms.count} completed tickets measured`} />
          <ExecutiveMetric label="Completion rate" value={completionRate === null ? "—" : `${(completionRate * 100).toFixed(1)}%`} detail={`Production success ${report.totals.production_success_rate === null ? "—" : `${(report.totals.production_success_rate * 100).toFixed(1)}%`}`} coverage={`${report.totals.completed}/${report.totals.tickets} completed · ${report.totals.production_assessed} production assessed`} />
          <ExecutiveMetric label="Median factory cost" value={formatMetric(report.summaries.cost_per_ticket_usd.median, "cost")} detail={`${report.coverage.cost_runs ? usd(report.totals.known_cost_usd) : "No observed cost"} total known cost`} coverage={`${report.coverage.complete_cost_tickets}/${report.totals.completed} completed tickets fully covered`} />
        </section>
        {(report.coverage.complete_cost_tickets < report.totals.completed || report.coverage.complete_token_tickets < report.totals.completed) && <p className="metrics-coverage metrics-coverage-warning">Some completed tickets have incomplete telemetry. Unknown subscription cost is not treated as zero.</p>}
        <section className="metrics-overview-grid">
          <article className="content-card runtime-composition"><div className="section-heading"><div><span>Runtime composition</span><h2>Where elapsed time is recorded</h2></div><small>{duration(observedRuntime)} observed</small></div><div className="runtime-stack" aria-label="Runtime composition">{runtimeSegments.map((segment) => <i key={segment.label} className={segment.className} style={{ width: `${observedRuntime ? Math.max(1, segment.value / observedRuntime * 100) : 0}%` }} title={`${segment.label}: ${duration(segment.value)}`} />)}</div><div className="runtime-legend">{runtimeSegments.map((segment) => <span key={segment.label}><i className={segment.className} />{segment.label}<strong>{duration(segment.value)}</strong></span>)}</div></article>
          <article className="content-card metric-insights"><div className="section-heading"><div><span>Where to look</span><h2>Operational signals</h2></div><small>Descriptive, not threshold-based</small></div><div><span><small>Slowest median node</small><strong>{slowestNode?.node_name ?? "Not enough data"}</strong><b>{slowestNode ? formatMetric(slowestNode.wall_ms.median, "duration") : "—"}</b></span><span><small>Lowest observed success</small><strong>{leastReliableNode?.node_name ?? "Not enough data"}</strong><b>{leastReliableNode?.success_rate === null || !leastReliableNode ? "—" : `${(leastReliableNode.success_rate * 100).toFixed(0)}% · n=${leastReliableNode.runs}`}</b></span><span><small>Highest cost per run</small><strong>{mostExpensiveNode?.node_name ?? "Not enough data"}</strong><b>{mostExpensiveNode ? usd(mostExpensiveNode.known_cost_usd / mostExpensiveNode.runs) : "—"}</b></span></div></article>
        </section>
        <section className="production-metrics content-card"><div className="section-heading"><div><span>Delivery funnel</span><h2>Production outcomes</h2></div><small>{report.totals.production_assessed}/{report.totals.tickets} assessed</small></div><div>{Object.entries(report.totals.production).map(([result, count]) => <div key={result}><span>{humanize(result)}</span><strong>{count}</strong><progress max={Math.max(1, report.totals.tickets)} value={count} /></div>)}</div></section>
      </>}
      {tab === "runtime" && <>
        <div className="metrics-tab-heading"><span>Delivery speed</span><h2>Runtime and waiting</h2><p>End-to-end elapsed time is separated from active execution and deliberate waiting.</p></div>
        <section className="five-number-grid runtime-summary-grid">
        <FiveNumberCard title="Ticket duration" summary={report.summaries.ticket_duration_ms} kind="duration" />
        <FiveNumberCard title="Active time / ticket" summary={report.summaries.active_time_ms} kind="duration" />
        <FiveNumberCard title="Human wait / ticket" summary={report.summaries.human_wait_ms} kind="duration" />
        {report.summaries.external_wait_ms && <FiveNumberCard title="External wait / ticket" summary={report.summaries.external_wait_ms} kind="duration" />}
        <FiveNumberCard title="Quota pause / ticket" summary={report.summaries.quota_pause_ms} kind="duration" />
        </section>
        <section className="content-card runtime-node-ranking"><div className="section-heading"><div><span>Bottlenecks</span><h2>Node runtime</h2></div><small>Ranked by median wall time</small></div><table><thead><tr><th>Node</th><th>Runs</th><th>Median</th><th>P90</th><th>Total active</th><th>Wait / pause</th></tr></thead><tbody>{[...allNodes].sort((left, right) => (right.wall_ms.median ?? 0) - (left.wall_ms.median ?? 0)).map((node) => <tr key={`${node.workflow_revision}/${node.node_id}`}><td><strong>{node.node_name}</strong><small>{humanize(node.node_type)}</small></td><td>{node.runs}</td><td>{formatMetric(node.wall_ms.median, "duration")}</td><td>{formatMetric(node.wall_ms.p90, "duration")}</td><td>{duration(node.active_ms)}</td><td>{duration(node.human_wait_ms + node.external_wait_ms + node.quota_paused_ms)}</td></tr>)}</tbody></table>{allNodes.length === 0 && <p>No node runtimes match these filters.</p>}</section>
      </>}
      {tab === "reliability" && <>
        <div className="metrics-tab-heading"><span>Delivery confidence</span><h2>Reliability and outcomes</h2><p>Ticket completion, production assessment, node outcomes, loops, and quality evidence.</p></div>
        <section className="reliability-kpis"><ExecutiveMetric label="Ticket completion" value={completionRate === null ? "—" : `${(completionRate * 100).toFixed(1)}%`} detail={`${report.totals.completed} completed of ${report.totals.tickets} filtered`} coverage="Includes unsettled tickets in the denominator" /><ExecutiveMetric label="Production success" value={report.totals.production_success_rate === null ? "—" : `${(report.totals.production_success_rate * 100).toFixed(1)}%`} detail={`${report.totals.production.succeeded} succeeded · ${report.totals.production.failed + report.totals.production.rolled_back} failed or rolled back`} coverage={`${report.totals.production_assessed} tickets assessed`} /></section>
        <section className="production-metrics content-card"><div className="section-heading"><div><span>Deployment evidence</span><h2>Production outcomes</h2></div><small>{report.totals.production_assessed}/{report.totals.tickets} assessed</small></div><div>{Object.entries(report.totals.production).map(([result, count]) => <div key={result}><span>{humanize(result)}</span><strong>{count}</strong><progress max={Math.max(1, report.totals.tickets)} value={count} /></div>)}</div></section>
        {workflowReliability}
      </>}
      {tab === "cost" && <>
        <div className="metrics-tab-heading"><span>Factory economics</span><h2>Cost and usage</h2><p>Observed and estimated spend, token use, and planning comparisons with human effort.</p></div>
        <section className="metrics-kpis cost-kpis">
          <div><span>Total tokens</span><strong>{report.coverage.token_runs ? tokenCount(report.totals.total_tokens) : "Unavailable"}</strong><small>{report.coverage.token_runs}/{report.coverage.agent_runs} agent runs covered</small></div>
          <div><span>Known cost</span><strong>{report.coverage.cost_runs ? usd(report.totals.known_cost_usd) : "Unavailable"}</strong><small>{report.coverage.cost_runs}/{report.coverage.agent_runs} runs · {report.coverage.estimated_cost_runs} estimated</small></div>
          <div><span>Estimated human work</span><strong>{(report.totals.estimated_human_days ?? 0).toLocaleString()} days</strong><small>{usd(report.totals.estimated_human_cost_usd ?? 0)} at {usd(report.totals.human_day_rate_usd ?? 1_000)}/day</small></div>
        </section>
        <p className="metrics-coverage">Cost and token totals include only observed values. Per-ticket summaries require complete coverage for every completed agent run: {report.coverage.complete_cost_tickets} tickets have complete cost and {report.coverage.complete_token_tickets} have complete token coverage.</p>
        <section className="five-number-grid cost-summary-grid">
        <FiveNumberCard title="Tokens / ticket" summary={report.summaries.tokens_per_ticket} kind="tokens" />
        <FiveNumberCard title="Cost / ticket" summary={report.summaries.cost_per_ticket_usd} kind="cost" />
        <FiveNumberCard title="Estimated human days" summary={report.summaries.estimated_human_days} kind="number" />
        <FiveNumberCard title="Estimated human cost" summary={report.summaries.estimated_human_cost_usd} kind="cost" />
        </section>
        <section className="human-comparison content-card"><div className="section-heading"><div><span>Cost comparison</span><h2>Human estimate vs factory</h2></div><small>{report.totals.comparison_tickets} completed ticket{report.totals.comparison_tickets === 1 ? "" : "s"} with human estimates and complete factory cost</small></div><div className="metric-grid"><div><span>Human estimate</span><strong>{usd(report.totals.comparison_human_cost_usd)}</strong></div><div><span>Factory cost</span><strong>{usd(report.totals.comparison_factory_cost_usd)}</strong></div><div><span>Estimated savings</span><strong>{usd(report.totals.comparison_savings_usd)}</strong></div><div><span>Cost reduction</span><strong>{report.totals.comparison_savings_rate === null ? "—" : `${(report.totals.comparison_savings_rate * 100).toFixed(1)}%`}</strong></div></div><p>Human values are planning estimates, not measured labor. Factory comparison includes only completed tickets with complete agent-run cost coverage.</p></section>
        {report.profiles.length > 0 && <section className="profile-metrics content-card"><div className="section-heading"><div><span>Agent runtime</span><h2>Resolved profiles</h2></div></div><div>{report.profiles.map((profile) => <article key={`${profile.alias}/${profile.provider}/${profile.model}/${profile.reasoning}`}><div><strong>{profile.alias}</strong><small>{[profile.provider, profile.model, profile.reasoning].filter(Boolean).join(" · ")}</small></div><span>{profile.runs} runs</span><span>{profile.success_rate === null ? "—" : `${(profile.success_rate * 100).toFixed(0)}% success`}</span><span>{profile.token_runs ? tokenCount(profile.total_tokens) : "Tokens unavailable"}</span><span>{profile.cost_runs ? usd(profile.known_cost_usd) : "Cost unavailable"}</span></article>)}</div></section>}
      </>}
    </>}
  </main>;
}

function ProductionAssessment({ ticket, busy, onSave, onArchive }: { ticket: TicketFrontmatter; busy: boolean; onSave: (result: TicketFrontmatter["production_result"], note: string) => void; onArchive: (result: TicketFrontmatter["production_result"], note: string) => void }) {
  const [result, setResult] = useState(ticket.production_result ?? "unassessed");
  const [note, setNote] = useState(ticket.production_assessment_note ?? "");
  useEffect(() => { setResult(ticket.production_result ?? "unassessed"); setNote(ticket.production_assessment_note ?? ""); }, [ticket.revision]);
  const dirty = result !== ticket.production_result || note !== (ticket.production_assessment_note ?? "");
  return <section className="side-card production-assessment"><div className="section-heading"><div><span>Production</span><h2>Outcome assessment</h2></div>{ticket.production_assessed_at && <small>{timeAgo(ticket.production_assessed_at, Date.now())}</small>}</div>
    <label>Result<select aria-label="Production result" value={result} onChange={(event) => setResult(event.target.value as TicketFrontmatter["production_result"])}><option value="unassessed">Unassessed</option><option value="succeeded">Succeeded in production</option><option value="failed">Failed in production</option><option value="rolled_back">Rolled back</option><option value="not_deployed">Not deployed</option></select></label>
    <label>Assessment note<textarea aria-label="Production assessment note" placeholder="Optional production evidence or incident reference" value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <div><button className="button-secondary" disabled={busy || !dirty} onClick={() => onSave(result, note)}>Save assessment</button>{!ticket.archived_at && <button className="button-primary" disabled={busy} onClick={() => onArchive(result, note)}>Save & archive</button>}</div>
    <p>Production outcome is independent of workflow completion and can be changed after archival.</p>
  </section>;
}

const INTAKE_LIMITS = { max_new_per_run: 3, max_new_per_day: 20, max_open: 20, max_working: 5, max_observed_unarchived: 30 };
type IntakeEditorState = { kind: "campaign" | "source"; content: string; revision?: string; advanced: boolean };
type SourcePreset = "script" | "new-relic" | "jira" | "dependabot" | "external";

function newCampaignYaml(preset: "general" | "performance" | "maintenance" = "general"): string {
  const values = preset === "performance" ? { id: "performance-improvement", name: "Performance improvement", description: "Continuously discover, deliver, and measure application performance improvements." }
    : preset === "maintenance" ? { id: "dependency-maintenance", name: "Dependency maintenance", description: "Continuously discover and safely deliver dependency and platform maintenance." }
      : { id: "new-campaign", name: "New campaign", description: "A repeatable improvement objective." };
  return stringify({ version: 1, ...values, enabled: false, limits: { ...INTAKE_LIMITS, max_new_per_run: 100, max_new_per_day: 100, max_open: 50, max_working: 10, max_observed_unarchived: 100 }, success_policy: {} }, { lineWidth: 0 });
}

function newSourceYaml(campaignId: string, preset: SourcePreset = "script"): string {
  const templates: Record<SourcePreset, { id: string; name: string; description: string; runner: IntakeSource["runner"]; labels: string[] }> = {
    script: { id: "new-source", name: "Scheduled discovery source", description: "Deterministically discovers bounded candidate work.", runner: { type: "supervisor_script", language: "shell", script_path: ".agents/intake/discover.sh", working_directory: ".", timeout_seconds: 300 }, labels: ["automated-intake"] },
    "new-relic": { id: "new-relic-issues", name: "New Relic issues", description: "Discovers actionable performance and reliability findings from New Relic.", runner: { type: "supervisor_script", language: "python", script_path: ".agents/intake/new_relic.py", working_directory: ".", timeout_seconds: 300 }, labels: ["new-relic", "performance", "automated-intake"] },
    jira: { id: "jira-ready", name: "Jira ready queue", description: "Imports eligible Jira Cloud issues as bounded workflow tickets.", runner: { type: "supervisor_script", language: "python", script_path: ".agents/intake/jira.py", working_directory: ".", timeout_seconds: 300 }, labels: ["jira", "automated-intake"] },
    dependabot: { id: "dependabot-pull-requests", name: "Dependabot pull requests", description: "Discovers open Dependabot changes that need delivery workflows.", runner: { type: "supervisor_script", language: "javascript", script_path: ".agents/intake/dependabot.mjs", working_directory: ".", timeout_seconds: 300 }, labels: ["dependabot", "dependencies", "automated-intake"] },
    external: { id: "follow-on-work", name: "Follow-on work", description: "Accepts candidate work emitted by ticket agents or another external system.", runner: { type: "external" }, labels: ["follow-on"] },
  };
  const template = templates[preset];
  return stringify({
    version: 1, id: template.id, name: template.name, description: template.description, enabled: false,
    campaign_id: campaignId || "new-campaign", schedule: { interval_minutes: 60 },
    runner: template.runner,
    ticket: { workflow_id: "standard-delivery", repositories: [{ id: "repository-name", primary: true }], labels: template.labels, priority: 0, mark_ready: false, workflow_inputs: {}, stage_enabled: {} },
    limits: INTAKE_LIMITS,
  }, { lineWidth: 0 });
}

function intakeEditorValue<T>(editor: IntakeEditorState): T | null {
  try { const value = parse(editor.content); return value && typeof value === "object" ? value as T : null; } catch { return null; }
}

function intakeEditorErrors(editor: IntakeEditorState): string[] {
  const value = intakeEditorValue<Record<string, any>>(editor);
  if (!value) return ["Advanced YAML is not valid and cannot be shown in the form."];
  const errors: string[] = [];
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(String(value.id ?? ""))) errors.push("ID must begin with a lowercase letter and contain only lowercase letters, numbers, and hyphens.");
  if (!String(value.name ?? "").trim()) errors.push("Name is required.");
  if (editor.kind === "source") {
    if (!String(value.campaign_id ?? "").trim()) errors.push("Choose a campaign.");
    if (!String(value.ticket?.workflow_id ?? "").trim()) errors.push("Choose a ticket workflow.");
    const repositories = Array.isArray(value.ticket?.repositories) ? value.ticket.repositories : [];
    if (!repositories.length) errors.push("Add at least one repository.");
    if (repositories.filter((item: any) => item?.primary === true).length !== 1) errors.push("Choose exactly one primary repository.");
    if (value.runner?.type === "supervisor_script" && !String(value.runner.script_path ?? "").trim()) errors.push("A Script source needs a script path.");
  }
  return errors;
}

function IntakeLimitFields({ value, onChange }: { value: IntakeLimits; onChange: (value: IntakeLimits) => void }) {
  const fields: Array<[keyof IntakeLimits, string, string]> = [
    ["max_new_per_run", "New per run", "Maximum tickets admitted from one observation run."],
    ["max_new_per_day", "New per day", "Daily admission rate limit."],
    ["max_open", "Open tickets", "Maximum unresolved tickets from this scope."],
    ["max_working", "In flight", "Maximum tickets that have advanced beyond draft."],
    ["max_observed_unarchived", "Visible unarchived", "Maximum active observation surface, including completed tickets."],
  ];
  return <div className="intake-limit-grid">{fields.map(([key, label, help]) => <label key={key}><span>{label}</span><input aria-label={label} type="number" min="1" value={value[key]} onChange={(event) => onChange({ ...value, [key]: Number(event.target.value) })} /><small>{help}</small></label>)}</div>;
}

function IntakeDefinitionEditor({ editor, campaigns, repositories, workflows, busy, onChange, onClose, onSave }: {
  editor: IntakeEditorState; campaigns: IntakeOverview["campaigns"]; repositories: RepositoryConfig[]; workflows: WorkflowDocument[]; busy: boolean;
  onChange: (editor: IntakeEditorState) => void; onClose: () => void; onSave: (preview: boolean) => void;
}) {
  const value = intakeEditorValue<Record<string, any>>(editor);
  const errors = intakeEditorErrors(editor);
  const update = (mutate: (draft: Record<string, any>) => void) => {
    const draft = intakeEditorValue<Record<string, any>>(editor);
    if (!draft) return;
    mutate(draft); onChange({ ...editor, content: stringify(draft, { lineWidth: 0 }) });
  };
  const campaign = editor.kind === "campaign" && value ? value as IntakeCampaign : null;
  const source = editor.kind === "source" && value ? value as IntakeSource : null;
  const updateLimits = (limits: IntakeLimits) => update((draft) => { draft.limits = limits; });
  const updateRepositories = (items: Array<{ id: string; primary: boolean }>) => update((draft) => { draft.ticket.repositories = items; });
  return <section className="content-card intake-editor">
    <div className="section-heading"><div><span>{editor.revision ? "Edit versioned definition" : "Create definition"}</span><h2>{editor.kind === "campaign" ? "Campaign" : "Intake source"}</h2></div><button className="button-secondary" onClick={onClose}>Close</button></div>
    {!value && <div className="intake-validation-errors"><strong>Fix the YAML to return to the form</strong>{errors.map((error) => <p key={error}>{error}</p>)}</div>}
    {campaign && <div className="intake-form">
      {!editor.revision && <div className="intake-presets"><span>Start from</span><button onClick={() => onChange({ ...editor, content: newCampaignYaml("general") })}>General</button><button onClick={() => onChange({ ...editor, content: newCampaignYaml("performance") })}>Performance</button><button onClick={() => onChange({ ...editor, content: newCampaignYaml("maintenance") })}>Maintenance</button></div>}
      <section><header><span>Objective</span><h3>What should this campaign improve?</h3></header><div className="intake-field-grid"><label><span>ID</span><input aria-label="Campaign ID" disabled={Boolean(editor.revision)} value={campaign.id} onChange={(event) => update((draft) => { draft.id = event.target.value; })} /><small>Stable identity used in provenance and metrics.</small></label><label><span>Name</span><input aria-label="Campaign name" value={campaign.name} onChange={(event) => update((draft) => { draft.name = event.target.value; })} /></label><label className="wide"><span>Description</span><textarea aria-label="Campaign description" value={campaign.description} onChange={(event) => update((draft) => { draft.description = event.target.value; })} /></label><label className="toggle wide"><input aria-label="Campaign enabled" type="checkbox" checked={campaign.enabled} onChange={(event) => update((draft) => { draft.enabled = event.target.checked; })} /><span><strong>Enable campaign</strong><small>Enabled campaigns permit scheduled execution and candidate admission.</small></span></label></div></section>
      <section><header><span>Capacity</span><h3>Bound the portfolio, not agent behavior</h3></header><IntakeLimitFields value={campaign.limits} onChange={updateLimits} /></section>
    </div>}
    {source && <div className="intake-form">
      {!editor.revision && <><div className="intake-presets"><span>Source template</span>{(["script", "new-relic", "jira", "dependabot", "external"] as SourcePreset[]).map((preset) => <button key={preset} onClick={() => onChange({ ...editor, content: newSourceYaml(campaigns[0]?.id ?? "", preset) })}>{humanize(preset)}</button>)}</div><p className="intake-template-note">Integration templates configure a sensible source contract and script location. Add the referenced discovery script to the supervisor project root and provide its credentials on that VM.</p></>}
      <section><header><span>Identity</span><h3>What facts does this source discover?</h3></header><div className="intake-field-grid"><label><span>ID</span><input aria-label="Source ID" disabled={Boolean(editor.revision)} value={source.id} onChange={(event) => update((draft) => { draft.id = event.target.value; })} /></label><label><span>Name</span><input aria-label="Source name" value={source.name} onChange={(event) => update((draft) => { draft.name = event.target.value; })} /></label><label><span>Campaign</span><select aria-label="Source campaign" value={source.campaign_id} onChange={(event) => update((draft) => { draft.campaign_id = event.target.value; })}><option value="">Choose campaign</option>{campaigns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="toggle"><input aria-label="Source enabled" type="checkbox" checked={source.enabled} onChange={(event) => update((draft) => { draft.enabled = event.target.checked; })} /><span><strong>Enable source</strong><small>Scheduling begins only after this is enabled.</small></span></label><label className="wide"><span>Description</span><textarea aria-label="Source description" value={source.description} onChange={(event) => update((draft) => { draft.description = event.target.value; })} /></label></div></section>
      <section><header><span>Discovery</span><h3>How are candidates collected?</h3></header><div className="intake-field-grid"><label><span>Runner</span><select aria-label="Source runner" value={source.runner.type} onChange={(event) => update((draft) => { draft.runner = event.target.value === "external" ? { type: "external" } : { type: "supervisor_script", language: "shell", script_path: ".agents/intake/discover.sh", working_directory: ".", timeout_seconds: 300 }; })}><option value="supervisor_script">Scheduled supervisor Script</option><option value="external">External push / child tickets</option></select></label>{source.runner.type === "supervisor_script" && <><label><span>Language</span><select aria-label="Source language" value={source.runner.language} onChange={(event) => update((draft) => { draft.runner.language = event.target.value; })}><option value="shell">Shell</option><option value="python">Python</option><option value="javascript">JavaScript</option></select></label><label><span>Interval (minutes)</span><input aria-label="Source interval" type="number" min="1" value={source.schedule.interval_minutes} onChange={(event) => update((draft) => { draft.schedule.interval_minutes = Number(event.target.value); })} /></label><label><span>Timeout (seconds)</span><input aria-label="Source timeout" type="number" min="1" value={source.runner.timeout_seconds} onChange={(event) => update((draft) => { draft.runner.timeout_seconds = Number(event.target.value); })} /></label><label className="wide"><span>Script path</span><input aria-label="Source script path" value={source.runner.script_path} onChange={(event) => update((draft) => { draft.runner.script_path = event.target.value; })} /><small>Relative to the supervisor project root.</small></label><label className="wide"><span>Working directory</span><input aria-label="Source working directory" value={source.runner.working_directory} onChange={(event) => update((draft) => { draft.runner.working_directory = event.target.value; })} /><small>Also relative to the supervisor project root.</small></label></>}</div>{source.runner.type === "external" && <p className="intake-callout">External sources do not run on a schedule. Ticket agents and external integrations submit candidate batches through the tracker API.</p>}</section>
      <section><header><span>Ticket template</span><h3>Where should admitted work go?</h3></header><div className="intake-field-grid"><label><span>Workflow</span><select aria-label="Source workflow" value={source.ticket.workflow_id} onChange={(event) => update((draft) => { draft.ticket.workflow_id = event.target.value; delete draft.ticket.workflow_revision; })}><option value="">Choose workflow</option>{workflows.filter((item) => item.valid).map((item) => <option key={item.definition.id} value={item.definition.id}>{item.definition.name}</option>)}</select></label><label><span>Priority</span><input aria-label="Source ticket priority" type="number" value={source.ticket.priority} onChange={(event) => update((draft) => { draft.ticket.priority = Number(event.target.value); })} /></label><label className="wide"><span>Labels</span><input aria-label="Source ticket labels" value={source.ticket.labels.join(", ")} onChange={(event) => update((draft) => { draft.ticket.labels = event.target.value.split(",").map((item) => item.trim()).filter(Boolean); })} /><small>Comma-separated labels applied to each admitted ticket.</small></label><label className="toggle wide"><input aria-label="Mark admitted tickets ready" type="checkbox" checked={source.ticket.mark_ready} onChange={(event) => update((draft) => { draft.ticket.mark_ready = event.target.checked; })} /><span><strong>Mark admitted tickets ready</strong><small>Leave off when a human should inspect imported work first.</small></span></label></div><div className="intake-repositories"><div><strong>Repositories</strong><button onClick={() => updateRepositories([...source.ticket.repositories, { id: "", primary: false }])}>＋ Add repository</button></div><datalist id="intake-repository-catalog">{repositories.map((repository) => <option key={repository.id} value={repository.id} />)}</datalist>{source.ticket.repositories.map((repository, index) => <div key={index}><input aria-label={`Source repository ${index + 1}`} list="intake-repository-catalog" placeholder="Repository ID" value={repository.id} onChange={(event) => updateRepositories(source.ticket.repositories.map((item, candidate) => candidate === index ? { ...item, id: event.target.value } : item))} /><label><input type="radio" name="intake-primary-repository" checked={repository.primary} onChange={() => updateRepositories(source.ticket.repositories.map((item, candidate) => ({ ...item, primary: candidate === index })))} /> Primary</label><button aria-label={`Remove source repository ${index + 1}`} disabled={source.ticket.repositories.length === 1} onClick={() => updateRepositories(source.ticket.repositories.filter((_, candidate) => candidate !== index).map((item, candidate) => ({ ...item, primary: candidate === 0 ? true : item.primary })))}>×</button></div>)}</div></section>
      <section><header><span>Admission limits</span><h3>Control source pressure</h3></header><IntakeLimitFields value={source.limits} onChange={updateLimits} /></section>
    </div>}
    {errors.length > 0 && value && <div className="intake-validation-errors"><strong>Definition needs attention</strong>{errors.map((error) => <p key={error}>{error}</p>)}</div>}
    <details className="intake-advanced" open={editor.advanced} onToggle={(event) => onChange({ ...editor, advanced: (event.currentTarget as HTMLDetailsElement).open })}><summary>Advanced YAML</summary><p>Use this for workflow inputs, stage overrides, success policy, or fields not exposed above. The form and YAML edit the same versioned definition.</p><textarea aria-label="Intake definition YAML" value={editor.content} onChange={(event) => onChange({ ...editor, content: event.target.value })} /></details>
    <div className="editor-actions"><small>Definitions are versioned YAML under the configured ticket root. New definitions start disabled.</small><div>{source?.runner.type === "supervisor_script" && <button className="button-secondary" disabled={busy || errors.length > 0} onClick={() => onSave(true)}>Save & test discovery</button>}<button className="button-primary" disabled={busy || errors.length > 0} onClick={() => onSave(false)}>Save definition</button></div></div>
  </section>;
}

function IntakePage({ repositories, workflows, onOpenTicket, onError }: { repositories: RepositoryConfig[]; workflows: WorkflowDocument[]; onOpenTicket: (id: string) => void; onError: (message: string | null) => void }) {
  const [overview, setOverview] = useState<IntakeOverview | null>(null);
  const [editor, setEditor] = useState<IntakeEditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setOverview(await api.intake()); } catch (error) { onError((error as Error).message); }
  }, [onError]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const save = async (preview = false) => {
    if (!editor) return;
    setBusy(true); onError(null);
    try {
      const parsed = parse(editor.content) as { id?: unknown };
      if (!parsed || typeof parsed.id !== "string" || !parsed.id.trim()) throw new Error("The YAML must contain an id.");
      if (editor.kind === "campaign") await api.saveIntakeCampaign(parsed.id, editor.content, editor.revision);
      else {
        await api.saveIntakeSource(parsed.id, editor.content, editor.revision);
        if (preview) await api.triggerIntakeSource(parsed.id, true);
      }
      setEditor(null); await load();
    } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  const trigger = async (id: string, preview = false) => {
    setBusy(true); onError(null);
    try { await api.triggerIntakeSource(id, preview); await load(); } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  if (!overview) return <main className="intake-page"><div className="empty-health"><h2>Loading intake operations…</h2></div></main>;
  return <main className="intake-page">
    <div className="health-heading"><div><span>Continuous improvement</span><h1>Campaigns & intake</h1><p>Campaigns bound long-lived objectives. Sources discover candidates; every admitted candidate becomes an independently measured workflow ticket.</p></div><div className="intake-actions"><button className="button-secondary" onClick={() => setEditor({ kind: "campaign", content: newCampaignYaml(), advanced: false })}>＋ Campaign</button><button className="button-primary" disabled={!overview.campaigns.length} onClick={() => setEditor({ kind: "source", content: newSourceYaml(overview.campaigns[0]?.id ?? ""), advanced: false })}>＋ Source</button></div></div>
    {!overview.campaigns.length && <div className="intake-callout">Create a campaign first. It supplies the objective and aggregate capacity boundary for every source.</div>}
    <section className="metric-kpis intake-kpis"><div><span>Campaigns</span><strong>{overview.totals.enabled_campaigns}/{overview.totals.campaigns}</strong><small>enabled</small></div><div><span>Sources</span><strong>{overview.totals.enabled_sources}/{overview.totals.sources}</strong><small>enabled</small></div><div><span>Candidates</span><strong>{overview.totals.candidates}</strong><small>{overview.totals.admitted} admitted</small></div><div><span>Deferred</span><strong>{overview.totals.deferred}</strong><small>waiting for capacity</small></div><div><span>Runs</span><strong>{overview.totals.runs}</strong><small>{overview.totals.preview_runs} previews · {overview.totals.running_runs} running</small></div></section>
    {editor && <IntakeDefinitionEditor editor={editor} campaigns={overview.campaigns} repositories={repositories} workflows={workflows} busy={busy} onChange={setEditor} onClose={() => setEditor(null)} onSave={(preview) => void save(preview)} />}
    <div className="intake-grid"><section className="content-card"><div className="section-heading"><div><span>Objectives</span><h2>Campaigns</h2></div></div><div className="intake-definition-list">{overview.campaigns.map((campaign) => { const document = overview.campaign_documents.find((item) => item.definition.id === campaign.id); return <article key={campaign.id}><div><StatusPill value={campaign.enabled ? "ready" : "pending"} subtle /><strong>{campaign.name}</strong><small>{campaign.id} · {campaign.sources} sources</small></div><p>{campaign.admitted} admitted · {campaign.working_tickets} working · {campaign.completed_tickets} completed · {campaign.production_successes} prod successes</p><button className="button-secondary" onClick={() => document && setEditor({ kind: "campaign", content: document.content, revision: document.revision, advanced: false })}>Edit</button></article>; })}{!overview.campaigns.length && <p>Create a campaign to group sources, capacity, and outcome metrics.</p>}</div></section>
    <section className="content-card"><div className="section-heading"><div><span>Discovery</span><h2>Sources</h2></div></div><div className="intake-definition-list">{overview.sources.map((source) => { const document = overview.source_documents.find((item) => item.definition.id === source.id); const runnable = document?.definition.runner.type === "supervisor_script"; return <article key={source.id}><div><StatusPill value={source.enabled ? source.failed_runs ? "blocked" : "ready" : "pending"} subtle /><strong>{source.name}</strong><small>{source.id} · {source.campaign_id}</small></div><p>{source.runs} admission runs · {source.preview_runs} previews · {source.admitted} admitted · {source.deferred} deferred</p><div><button className="button-secondary" onClick={() => document && setEditor({ kind: "source", content: document.content, revision: document.revision, advanced: false })}>Edit</button>{runnable && <button className="button-secondary" disabled={busy || source.running_runs > 0} onClick={() => void trigger(source.id, true)}>Test</button>}{runnable && <button className="button-secondary" disabled={busy || !source.enabled || source.running_runs > 0} onClick={() => void trigger(source.id)}>Run now</button>}</div></article>; })}{!overview.sources.length && <p>Create a source to watch New Relic, Jira, GitHub, or another deterministic feed.</p>}</div></section></div>
    <section className="queue-table-card"><div className="section-heading intake-table-heading"><div><span>Admission ledger</span><h2>Recent candidates</h2></div></div><table className="queue-table"><thead><tr><th>Candidate</th><th>Source</th><th>Decision</th><th>Observed</th><th>Ticket</th></tr></thead><tbody>{overview.recent_candidates.map((candidate) => <tr key={candidate.id}><td><strong>{candidate.candidate.title}</strong><small>{candidate.external_key}</small>{candidate.reason && <small>{candidate.reason}</small>}</td><td>{candidate.source_id}</td><td><StatusPill value={candidate.decision} subtle /></td><td>{candidate.observation_count}× · {timeAgo(candidate.last_seen_at, Date.now())}</td><td>{candidate.ticket_id ? <button className="link-button" onClick={() => onOpenTicket(candidate.ticket_id!)}>{candidate.ticket_id}</button> : "—"}</td></tr>)}</tbody></table>{!overview.recent_candidates.length && <div className="queue-empty-state"><p>No candidates have been observed.</p></div>}</section>
    <section className="queue-table-card"><div className="section-heading intake-table-heading"><div><span>Execution ledger</span><h2>Source runs</h2></div></div><table className="queue-table"><thead><tr><th>Source</th><th>Status</th><th>Supervisor</th><th>Candidates</th><th>Scheduled</th><th>Output</th></tr></thead><tbody>{overview.recent_runs.map((run) => <tr key={run.id}><td><strong>{run.source_id}</strong><small>{run.mode === "preview" ? "Safe preview" : "Admission"} · attempt {run.attempt}</small></td><td><StatusPill value={run.status} subtle />{run.error && <small>{run.error}</small>}</td><td>{run.supervisor_id ?? "—"}</td><td>{run.candidates_received}{run.mode === "preview" ? <details className="intake-preview-results"><summary>Preview results</summary>{(run.preview_candidates ?? []).map((candidate, index) => <div key={`${candidate.external_key}:${index}`} className={candidate.valid ? "valid" : "invalid"}><strong>{candidate.title || "Invalid candidate"}</strong><small>{candidate.external_key || "Missing key"}</small>{candidate.errors.map((error) => <small key={error}>{error}</small>)}</div>)}{run.candidates_received > 100 && <small>Only the first 100 candidates are shown.</small>}</details> : <small>{Object.entries(run.decisions).map(([key, value]) => `${key} ${value}`).join(" · ")}</small>}</td><td>{timeAgo(run.scheduled_at, Date.now())}</td><td>{run.output_bytes > 0 ? <a href={api.intakeOutputUrl(run.source_id, run.id)} target="_blank" rel="noreferrer">Open log</a> : "—"}</td></tr>)}</tbody></table>{!overview.recent_runs.length && <div className="queue-empty-state"><p>No source runs have executed.</p></div>}</section>
  </main>;
}

type AttentionKind = TicketSummary["attention"]["kinds"][number];
function visibleAttentionKinds(ticket: TicketSummary, now: number): AttentionKind[] {
  return ticket.attention.kinds.filter((kind) => {
    if (kind !== "expiring_wait") return true;
    const wake = ticket.attention.wait_wake_at ? Date.parse(ticket.attention.wait_wake_at) : Number.POSITIVE_INFINITY;
    const deadline = ticket.attention.wait_deadline_at ? Date.parse(ticket.attention.wait_deadline_at) : Number.POSITIVE_INFINITY;
    return wake <= now + 15 * 60_000 || deadline <= now + 24 * 60 * 60_000;
  });
}

function AttentionPage({ tickets, now, onOpen, onChanged, onError }: { tickets: TicketSummary[]; now: number; onOpen: (id: string) => void; onChanged: () => Promise<void>; onError: (message: string | null) => void }) {
  const candidates = tickets.filter((ticket) => ticket.valid && !ticket.archived_at && visibleAttentionKinds(ticket, now).length > 0)
    .sort((left, right) => right.priority - left.priority || left.updated_at.localeCompare(right.updated_at));
  const candidateKey = candidates.map((ticket) => `${ticket.id}:${ticket.revision}`).join("|");
  const [details, setDetails] = useState<Record<string, TicketDetail>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busyTicket, setBusyTicket] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all(candidates.map((ticket) => api.get(ticket.id))).then((loaded) => {
      if (active) setDetails(Object.fromEntries(loaded.map((ticket) => [ticket.id, ticket])));
    }).catch((error: Error) => { if (active) onError(error.message); });
    return () => { active = false; };
  }, [candidateKey]);
  const mutate = async (ticket: TicketDetail, work: () => Promise<TicketDetail>) => {
    setBusyTicket(ticket.id); onError(null);
    try {
      const next = await work(); setDetails((current) => ({ ...current, [next.id]: next })); await onChanged();
    } catch (error) { onError((error as Error).message); }
    finally { setBusyTicket(null); }
  };
  const decide = (ticket: TicketDetail, choice: NonNullable<WorkflowNode["choices"]>[number]) => {
    const comment = promptForGateComment(choice);
    if (comment === null) return;
    void mutate(ticket, () => api.action(ticket, "decide", { decision: choice.id, ...comment }));
  };
  return <main className="attention-page">
    <div className="health-heading"><div><span>Operator inbox</span><h1>Attention</h1><p>Questions, gates, failures, feedback, repository conflicts, and time-sensitive waits that need a human decision or awareness.</p></div><div className="health-summary"><strong>{candidates.length}</strong><span>tickets need attention</span></div></div>
    {!candidates.length && <section className="attention-empty"><strong>Inbox zero</strong><p>No ticket currently needs operator attention.</p></section>}
    <div className="attention-list">{candidates.map((summary) => {
      const ticket = details[summary.id];
      const kinds = visibleAttentionKinds(summary, now);
      const currentNode = ticket?.workflow_node ?? (ticket?.frontmatter?.workflow ? ticket.workflow_definition?.nodes.find((node) => node.id === ticket.frontmatter?.workflow?.current_node) : undefined);
      const pending = ticket?.frontmatter?.questions.filter((question) => question.answer === null) ?? [];
      const busy = busyTicket === summary.id;
      return <article className="attention-ticket" key={summary.id}>
        <header><div><span>{summary.id} · P{summary.priority}</span><h2>{summary.title}</h2><small>{summary.workflow_stage_name ?? humanize(summary.phase)} · {summary.workflow_node_name ?? "Workflow unavailable"}</small></div><div className="attention-kind-list">{kinds.map((kind) => <span key={kind}>{humanize(kind)}</span>)}</div></header>
        <div className="attention-reasons">
          {summary.attention.delivery_failure_summary && kinds.includes("delivery_failure") && <p><strong>Assignment delivery failed</strong>{summary.attention.delivery_failure_summary}<small>The node remains eligible for its bounded automatic retry.</small></p>}
          {summary.attention.github_feedback_summary && kinds.includes("github_feedback") && <p><strong>GitHub feedback arrived</strong>{summary.attention.github_feedback_summary}</p>}
          {kinds.includes("blocked") && <p><strong>Workflow is blocked</strong>Review the latest node result, then retry when the underlying issue is resolved.</p>}
          {kinds.includes("failed") && <p><strong>Workflow failed</strong>The current node requires an operator retry or another state action.</p>}
          {kinds.includes("expiring_wait") && <p><strong>External wait is ready soon</strong>Next check {relativeTime(summary.attention.wait_wake_at, now)} · deadline {relativeTime(summary.attention.wait_deadline_at, now)}.</p>}
          {summary.claim_blockers.map((blocker) => <p key={`${blocker.hostname}:${blocker.ticket_id}`}><strong>Repository reserved on {blocker.hostname}</strong>{blocker.repositories.join(", ")} is in use by <button className="link-button" onClick={() => onOpen(blocker.ticket_id)}>{blocker.ticket_id}</button>.</p>)}
        </div>
        {ticket && pending.length > 0 && <div className="attention-questions">{pending.map((question) => <div key={question.id}><MarkdownContent markdown={question.question} />{(question.options ?? []).length > 0 && <div className="question-options">{(question.options ?? []).map((option) => <button key={option} className={answers[question.id] === option ? "selected" : ""} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}>{option}</button>)}</div>}<textarea aria-label={`Inbox answer: ${question.question}`} placeholder="Freeform answer…" value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /><button className="button-primary" disabled={busy || !(answers[question.id] ?? "").trim()} onClick={() => void mutate(ticket, () => api.action(ticket, `questions/${encodeURIComponent(question.id)}/answer`, { answer: answers[question.id]!.trim() }))}>Send response</button></div>)}</div>}
        {ticket && ticket.frontmatter?.status === "waiting_approval" && currentNode?.type === "human_gate" && <div className="attention-gate-actions">{currentNode.choices.map((choice) => <button className={choice.metric_class === "failure" ? "button-danger" : "button-primary"} disabled={busy} key={choice.id} onClick={() => decide(ticket, choice)}><strong>{choice.label}</strong><small>{choice.description}</small></button>)}</div>}
        <footer><button className="button-secondary" onClick={() => onOpen(summary.id)}>Open ticket</button>{ticket && (summary.status === "blocked" || summary.status === "failed") && pending.length === 0 && <button className="button-primary" disabled={busy} onClick={() => void mutate(ticket, () => api.action(ticket, "retry"))}>Retry node</button>}{ticket && summary.status === "waiting_external" && <button className="button-primary" disabled={busy} onClick={() => void mutate(ticket, () => api.action(ticket, "wake"))}>Check now</button>}</footer>
      </article>;
    })}</div>
  </main>;
}

function QueuePage({ tickets, includeArchived, setIncludeArchived, now, onOpen, onCreate }: { tickets: TicketSummary[]; includeArchived: boolean; setIncludeArchived: (value: boolean) => void; now: number; onOpen: (id: string) => void; onCreate: () => void }) {
  const [query, setQuery] = useStoredState("agentic-project-tracker.queue.query", "");
  const [status, setStatus] = useStoredState("agentic-project-tracker.queue.status", "");
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = [...tickets].filter((ticket) => (!status || ticket.status === status) && (!normalizedQuery || [ticket.id, ticket.title, ticket.workflow_node_name ?? "", ...(ticket.labels ?? []), ...(ticket.repositories ?? [])].some((value) => value.toLowerCase().includes(normalizedQuery))))
    .sort((left, right) => (right.updated_at ?? right.created_at).localeCompare(left.updated_at ?? left.created_at) || left.id.localeCompare(right.id));
  return <main className="queue-page">
    <div className="health-heading"><div><span>Work management</span><h1>Ticket queue</h1><p>Most recently updated tickets appear first.</p></div><div className="health-summary"><strong>{filtered.length}</strong><span>visible tickets</span></div></div>
    <section className="queue-toolbar"><label>Search<input aria-label="Search tickets" placeholder="ID, title, label, repository…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label>Status<select aria-label="Queue status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All states</option>{["blocked", "failed", "waiting_approval", "running", "waiting_external", "ready", "pending", "completed", "cancelled"].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}</select></label><label className="toggle queue-archive-toggle"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /><span><strong>Archived</strong><small>Include archived tickets</small></span></label></section>
    <section className="queue-table-card"><table className="queue-table"><thead><tr><th>Ticket</th><th>Ticket state</th><th>Workflow state</th><th>Executor</th><th>Repositories</th><th title="Higher numbers are scheduled first">Priority</th><th>Updated</th></tr></thead><tbody>{filtered.map((ticket) => <tr key={ticket.id} className={!ticket.valid ? "invalid" : ""} onClick={() => onOpen(ticket.id)}><td><button onClick={() => onOpen(ticket.id)}><strong>{ticket.id}</strong><span>{ticket.title}</span></button>{(ticket.claim_blockers ?? []).map((blocker) => <small key={`${blocker.hostname}:${blocker.ticket_id}`}>{blocker.repositories.join(", ")} blocked by {blocker.ticket_id} on {blocker.hostname}</small>)}</td><td><StatusPill value={ticket.valid ? ticket.status : "invalid"} subtle />{ticket.archived_at && <small>Archived</small>}</td><td><strong>{ticket.workflow_stage_name ?? humanize(ticket.phase)}</strong><small>{ticket.workflow_node_name ?? "Workflow unavailable"}</small></td><td><span>{ticket.provider ? humanize(ticket.provider) : "—"}</span><small>{ticket.assigned_supervisor ?? "Unassigned"}</small></td><td>{(ticket.repositories ?? []).join(", ") || "—"}</td><td title="Higher numbers are scheduled first">Priority {ticket.priority}</td><td>{timeAgo(ticket.updated_at || ticket.created_at, now)}</td></tr>)}</tbody></table>{!filtered.length && (tickets.length === 0 && !normalizedQuery && !status ? <div className="queue-empty-state"><h2>No tickets yet</h2><p>Create the first work ticket to begin.</p><button className="button-primary" onClick={onCreate}>＋ Create ticket</button></div> : <div className="queue-empty-state"><h2>No tickets match this view</h2><p>Clear the search or status filter, or include archived tickets.</p></div>)}</section>
  </main>;
}

export function App() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [runtime, setRuntime] = useState<RuntimeAgent[]>([]);
  const [supervisors, setSupervisors] = useState<SupervisorHealth[]>([]);
  const [operations, setOperations] = useState<OperationalStatus | null>(null);
  const [config, setConfig] = useState<TrackerConfig | null>(null);
  const [quotaReport, setQuotaReport] = useState<QuotaReport | null>(null);
  const [prompts, setPrompts] = useState<PromptDocument[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDocument[]>([]);
  const [workflowReleases, setWorkflowReleases] = useState<WorkflowReleaseCatalog | null>(null);
  const [view, setView] = useState<AppView>(storedAppView);
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TicketDraft>(emptyDraft);
  const [rawDraft, setRawDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<null | { kind: "comment" | "guidance"; text: string }>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [descriptionEdit, setDescriptionEdit] = useState<null | { text: string; targetNode: string }>(null);
  const [now, setNow] = useState(Date.now());
  const [includeArchived, setIncludeArchived] = useStoredState("agentic-project-tracker.queue.archived", false);
  const [restoredTicketId] = useState(() => storedValue<string | null>("agentic-project-tracker.selected-ticket", null));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("agentic-project-tracker.theme", theme); } catch { /* storage may be disabled */ }
  }, [theme]);
  useEffect(() => {
    try { window.localStorage.setItem("agentic-project-tracker.view", JSON.stringify(view)); } catch { /* storage may be disabled */ }
  }, [view]);

  const refresh = useCallback(async () => {
    const [list, live, health, operational, configured, promptLibrary, workflowLibrary, releases] = await Promise.all([api.list(includeArchived), api.runtime(), api.supervisors(), api.operations().catch(() => null), api.config(), api.prompts(), api.workflows().catch(() => ({ workflows: [] })), api.workflowReleases().catch(() => null)]);
    setTickets(list.tickets); setRuntime(live.agents); setSupervisors(health.supervisors); setConfig(configured.config); setQuotaReport(configured.quota ?? null); setPrompts(promptLibrary.prompts); setWorkflows(workflowLibrary.workflows);
    setOperations(operational);
    setWorkflowReleases(releases ?? fallbackWorkflowReleases(workflowLibrary.workflows));
    if (selected) {
      const next = await api.get(selected.id).catch(() => null);
      if (next) {
        setSelected(next); setRawDraft(next.markdown);
        if (!dirty) setDraft(draftFromTicket(next));
      }
    }
  }, [selected?.id, dirty, includeArchived]);

  useEffect(() => { void refresh().catch((caught: Error) => setError(caught.message)); }, [includeArchived]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => void Promise.all([api.supervisors(), api.operations().catch(() => null), api.config()]).then(([health, operational, configured]) => {
      setSupervisors(health.supervisors);
      setOperations(operational);
      setConfig(configured.config);
      setQuotaReport(configured.quota ?? null);
    }).catch(() => undefined), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const stream = new EventSource("/api/events");
    stream.addEventListener("invalidate", () => void refresh());
    return () => stream.close();
  }, [refresh]);

  const open = async (id: string) => {
    setView("tickets");
    setError(null); const ticket = await api.get(id); setSelected(ticket); setDraft(draftFromTicket(ticket));
    if (ticket.integration_warnings?.length) setError(ticket.integration_warnings.join(" · "));
    setRawDraft(ticket.markdown); setDirty(false); setCreating(false); setComposer(null); setDescriptionEdit(null); setQuestionAnswers({});
    try { window.localStorage.setItem("agentic-project-tracker.selected-ticket", JSON.stringify(id)); } catch { /* storage may be disabled */ }
  };

  useEffect(() => {
    if (view !== "tickets" || !restoredTicketId) return;
    void open(restoredTicketId).catch((caught: Error) => {
      try { window.localStorage.removeItem("agentic-project-tracker.selected-ticket"); } catch { /* storage may be disabled */ }
      setError(caught.message);
    });
  }, []);

  const run = async (work: () => Promise<TicketDetail>): Promise<boolean> => {
    setBusy(true); setError(null);
    try {
      const next = await work(); setSelected(next); setDraft(draftFromTicket(next)); setRawDraft(next.markdown);
      setDirty(false); setComposer(null); await refresh(); return true;
    } catch (caught) { setError((caught as Error).message); return false; }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!creating && !selected) return;
    setBusy(true); setError(null);
    let next: TicketDetail | null = null;
    let uploadedFiles = 0;
    try {
      next = creating
        ? await api.create(ticketMarkdown(draft), draft.autoId, draft.workflowId, draft.workflowRevision || undefined, draft.workflowInputs, draft.stageEnabled)
        : await api.edit(selected!, selected!.valid ? ticketMarkdown(draft, selected!) : rawDraft);
      for (const file of draft.attachmentFiles) { next = await api.uploadAttachment(next, file); uploadedFiles += 1; }
      setSelected(next); setDraft(draftFromTicket(next)); setRawDraft(next.markdown); setDirty(false); setComposer(null); setCreating(false);
      try { window.localStorage.setItem("agentic-project-tracker.selected-ticket", JSON.stringify(next.id)); } catch { /* storage may be disabled */ }
      await refresh();
    } catch (caught) {
      if (next) { setSelected(next); setDraft({ ...draftFromTicket(next), attachmentFiles: draft.attachmentFiles.slice(uploadedFiles) }); setRawDraft(next.markdown); setCreating(false); await refresh(); }
      setError((caught as Error).message);
    } finally { setBusy(false); }
  };

  const uploadAttachments = async (files: File[]) => {
    if (!selected || files.length === 0) return;
    if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) { setError("Each attachment must be 25 MB or smaller."); return; }
    setBusy(true); setError(null);
    let next = selected;
    try {
      for (const file of files) next = await api.uploadAttachment(next, file);
    } catch (caught) { setError((caught as Error).message); }
    finally {
      setBusy(false);
      if (next !== selected) { setSelected(next); setDraft(draftFromTicket(next)); setRawDraft(next.markdown); await refresh().catch((caught: Error) => setError(caught.message)); }
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    if (!selected || !window.confirm("Remove this attachment from the ticket?")) return;
    await run(() => api.removeAttachment(selected, attachmentId));
  };

  const submitComposer = async () => {
    if (!selected || !composer?.text.trim()) return;
    await run(() => api.action(selected, composer.kind, { message: composer.text.trim() }));
  };

  const saveLiveDescription = async (restart = false) => {
    if (!selected?.frontmatter || !descriptionEdit?.text.trim()) return;
    const nextDraft = { ...draftFromTicket(selected), description: descriptionEdit.text.trim() };
    const saved = await run(async () => {
      if (restart && selected.frontmatter?.workflow && selected.workflow_definition) {
        const edited = await api.edit(selected, ticketMarkdown(nextDraft, selected));
        const target = selected.workflow_definition.nodes.find((node) => node.id === descriptionEdit.targetNode && node.type !== "terminal");
        if (!target) throw new Error(`The pinned workflow has no restartable node ${descriptionEdit.targetNode}.`);
        return api.action(edited, "workflow/migrate", { workflow_id: selected.frontmatter.workflow.id, node_id: target.id });
      }
      return api.edit(selected, ticketMarkdown(nextDraft, selected));
    });
    if (saved) setDescriptionEdit(null);
  };

  const moveToNode = async (action: "restart" | "reopen") => {
    if (!selected) return;
    if (selected.frontmatter?.workflow && selected.workflow_definition) {
      const choices = selected.workflow_definition.nodes.map((node) => node.id).join(", ");
      const nodeId = window.prompt(`${action === "reopen" ? "Reopen" : "Restart"} at workflow node (${choices}):`, selected.workflow_definition.start);
      if (nodeId) await run(() => api.action(selected, "workflow/migrate", { workflow_id: selected.frontmatter!.workflow!.id, node_id: nodeId }));
      return;
    }
    throw new Error("Ticket does not have a pinned workflow");
  };

  const migrateWorkflow = async () => {
    if (!selected?.frontmatter) return;
    const workflowId = window.prompt(`Workflow ID (${workflows.map((workflow) => workflow.definition.id).join(", ")}):`, selected.frontmatter.workflow?.id ?? "standard-delivery")?.trim();
    if (!workflowId) return;
    const target = workflows.find((workflow) => workflow.definition.id === workflowId);
    if (!target) { setError(`Workflow ${workflowId} is not loaded.`); return; }
    const nodeId = window.prompt(`Start node (${target.definition.nodes.map((node) => node.id).join(", ")}):`, target.definition.start)?.trim();
    if (nodeId) await run(() => api.action(selected, "workflow/migrate", { workflow_id: workflowId, node_id: nodeId }));
  };

  const fail = async () => {
    if (!selected) return; const text = window.prompt("Why should this ticket be failed?");
    if (text) await run(() => api.action(selected, "fail", { message: text }));
  };

  const answerQuestion = async (questionId: string) => {
    if (!selected) return;
    const answer = questionAnswers[questionId]?.trim();
    if (!answer) return;
    if (await run(() => api.action(selected, `questions/${encodeURIComponent(questionId)}/answer`, { answer }))) {
      setQuestionAnswers((current) => { const next = { ...current }; delete next[questionId]; return next; });
    }
  };

  const checkPullRequests = async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const result = await api.checkPullRequests(selected.id);
      await open(selected.id);
      if (!result.reopened) window.alert(`Checked ${result.checked} pull request(s); no new follow-up was found.`);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  const decideGate = (choice: NonNullable<WorkflowNode["choices"]>[number]) => {
    if (!selected) return;
    const comment = promptForGateComment(choice);
    if (comment === null) return;
    void run(() => api.action(selected, "decide", { decision: choice.id, ...comment }));
  };

  const saveConfig = async (update: Pick<TrackerConfig, "providers" | "agent_profiles" | "pricing" | "metrics" | "quality" | "artifacts" | "repositories" | "jira" | "github">) => {
    if (!config) return;
    setBusy(true); setError(null);
    try { const updated = await api.updateConfig(config, update); setConfig(updated.config); setQuotaReport(updated.quota ?? null); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  const restoreDefaults = async () => {
    if (!window.confirm("Restore every built-in prompt and workflow to its shipped default? Custom artifacts and ticket-pinned revisions will be preserved.")) return;
    setBusy(true); setError(null);
    try {
      const restored = await api.restoreDefaults({ prompts: true, workflows: true });
      setPrompts(restored.prompts); setWorkflows(restored.workflows); await refresh();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  const beginLocalTicket = async () => {
    setError(null);
    try {
      const next = await api.nextId();
      const initial = emptyDraft(next.id, true);
      const workflowId = workflowReleases?.catalog.default_workflow_id ?? initial.workflowId;
      const release = workflowReleases?.releases.find((item) => item.workflow_id === workflowId && item.is_default);
      setView("tickets"); setCreating(true); setSelected(null); setDraft({ ...initial, workflowId, workflowRevision: release?.revision ?? "",
        workflowInputs: Object.fromEntries(release?.definition.inputs.map((input) => [input.id, input.default]) ?? []),
        stageEnabled: Object.fromEntries(release?.definition.stages.map((stage) => [stage.id, stage.skippable ? stage.default_enabled : true]) ?? []),
      }); setDirty(false);
      try { window.localStorage.removeItem("agentic-project-tracker.selected-ticket"); } catch { /* storage may be disabled */ }
    } catch (caught) { setError((caught as Error).message); }
  };

  const beginJiraTicket = async () => {
    const key = window.prompt("Jira issue key:");
    if (!key) return;
    setBusy(true); setError(null);
    try {
      const imported = (await api.jiraImport(key.trim())).draft;
      setView("tickets"); setCreating(true); setSelected(null);
      try { window.localStorage.removeItem("agentic-project-tracker.selected-ticket"); } catch { /* storage may be disabled */ }
      const initial = emptyDraft(imported.id, false);
      const workflowId = workflowReleases?.catalog.default_workflow_id ?? initial.workflowId;
      const release = workflowReleases?.releases.find((item) => item.workflow_id === workflowId && item.is_default);
      setDraft({ ...initial, workflowId, workflowRevision: release?.revision ?? "", id: imported.id, title: imported.title, description: `# Goal\n\n${imported.description}`, labels: imported.labels.join(", "), jira: imported.jira,
        workflowInputs: Object.fromEntries(release?.definition.inputs.map((input) => [input.id, input.default]) ?? []),
        stageEnabled: Object.fromEntries(release?.definition.stages.map((stage) => [stage.id, stage.skippable ? stage.default_enabled : true]) ?? []),
      });
      setDirty(false);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  const frontmatter = selected?.frontmatter;
  const selectedWorkflow = selected?.workflow_definition ?? (frontmatter?.workflow ? workflows.find((workflow) => workflow.definition.id === frontmatter.workflow?.id)?.definition : undefined);
  const currentWorkflowNode = frontmatter?.workflow ? selectedWorkflow?.nodes.find((node) => node.id === frontmatter.workflow?.current_node) : undefined;
  const currentWorkflowStage = currentWorkflowNode ? selectedWorkflow?.stages.find((stage) => stage.id === currentWorkflowNode.stage) : undefined;
  const currentProvider = frontmatter
    ? frontmatter.execution?.provider ?? selected?.resolved_agent_profile?.provider ?? resolvedWorkflowProvider(frontmatter, currentWorkflowNode)
    : null;
  const assignedRelease = frontmatter?.workflow_assignment ? workflowReleases?.releases.find((release) => release.workflow_id === frontmatter.workflow_assignment?.workflow_id && release.revision === frontmatter.workflow_assignment.revision) : undefined;
  const selectedSummary = selected ? tickets.find((ticket) => ticket.id === selected.id) : null;
  const activeAttempt = frontmatter && currentWorkflowNode && frontmatter.workflow
    ? frontmatter.workflow.node_attempts?.[frontmatter.workflow.active_workflow_id && frontmatter.workflow.active_workflow_id !== frontmatter.workflow.id ? `${frontmatter.workflow.active_workflow_id}/${currentWorkflowNode.id}` : currentWorkflowNode.id] ?? null
    : null;
  const costLimitPause = frontmatter?.status === "blocked" && currentWorkflowNode && frontmatter.workflow?.cost_limit_pause?.node_id === currentWorkflowNode.id
    ? frontmatter.workflow.cost_limit_pause : null;
  const currentNodeKnownCost = frontmatter && currentWorkflowNode && frontmatter.workflow
    ? frontmatter.workflow.node_runs.filter((run) => run.node_id === currentWorkflowNode.id && (run.workflow_id ?? frontmatter.workflow!.id) === frontmatter.workflow!.id)
      .reduce((sum, run) => sum + (run.telemetry?.delta.cost_usd ?? 0), 0)
    : 0;
  const attentionCount = tickets.filter((ticket) => visibleAttentionKinds(ticket, now).length > 0).length;
  const showQueue = () => {
    setView("tickets"); setSelected(null); setCreating(false);
    try { window.localStorage.removeItem("agentic-project-tracker.selected-ticket"); } catch { /* storage may be disabled */ }
  };
  return <div className="app-shell">
    <TopNavigation view={view} attentionCount={attentionCount} onlineSupervisors={supervisors.filter((item) => item.status === "online").length} jiraEnabled={Boolean(config?.jira?.enabled)} busy={busy} theme={theme} onView={setView} onQueue={showQueue} onNewTicket={() => void beginLocalTicket()} onImportJira={() => void beginJiraTicket()} onTheme={setTheme} />
    {view === "tickets" && <AgentFleet agents={runtime} now={now} onOpen={(id) => void open(id)} />}
    {error && <div className="error" role="alert"><strong>Something needs attention</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    {view === "attention" ? <AttentionPage tickets={tickets} now={now} onOpen={(id) => void open(id)} onChanged={refresh} onError={setError} /> : view === "intake" ? <IntakePage repositories={config?.repositories ?? []} workflows={workflows} onOpenTicket={(id) => void open(id)} onError={setError} /> : view === "metrics" ? <MetricsPage releases={workflowReleases} onError={setError} /> : view === "workflows" ? <WorkflowEditorPage workflows={workflows} releases={workflowReleases} prompts={prompts} agentProfiles={config?.agent_profiles} onChanged={setWorkflows} onReleasesChanged={setWorkflowReleases} onError={setError} /> : view === "prompts" ? <PromptEditorPage prompts={prompts} onUpdated={(prompt) => setPrompts((current) => [...current.filter((item) => item.name !== prompt.name), prompt])} onError={setError} /> : view === "configuration" ? <ConfigurationPage config={config} quota={quotaReport} busy={busy} onSave={(update) => void saveConfig(update)} onRestoreDefaults={() => void restoreDefaults()} /> : view === "supervisors" ? <SupervisorHealthPage supervisors={supervisors} operations={operations} githubObservationEnabled={Boolean(config?.github?.observation_enabled)} now={now} onOpenTicket={(id) => void open(id)} /> : !selected && !creating ? <QueuePage tickets={tickets} includeArchived={includeArchived} setIncludeArchived={setIncludeArchived} now={now} onOpen={(id) => void open(id)} onCreate={() => void beginLocalTicket()} /> : <main className="dashboard-layout detail-only">
      <section className="ticket-workspace">
        {creating ? <TicketEditor draft={draft} setDraft={(value) => { setDirty(true); setDraft(value); }} existing={false} busy={busy} repositories={config?.repositories ?? []} workflows={workflows} {...(workflowReleases ? { workflowReleases } : {})} onSave={() => void save()} onCancel={() => setCreating(false)} /> : selected ? !selected.valid ? <div className="invalid-editor">
          <div className="issue-heading"><div><span className="issue-key">Recovery editor</span><h1>{selected.relative_path}</h1><p>Repair the invalid Markdown before this ticket can be scheduled.</p></div></div>
          <ul className="validation">{selected.errors.map((item) => <li key={item}>{item}</li>)}</ul>
          <textarea aria-label="Raw ticket Markdown" value={rawDraft} onChange={(event) => { setRawDraft(event.target.value); setDirty(true); }} />
          <div className="sticky-actions"><button className="button-primary" disabled={busy} onClick={() => void save()}>Save repaired ticket</button></div>
        </div> : frontmatter?.status === "pending" ? <TicketEditor draft={draft} setDraft={(value) => { setDirty(true); setDraft(value); }} existing busy={busy} repositories={config?.repositories ?? []} workflows={workflows} {...(workflowReleases ? { workflowReleases } : {})} existingAttachments={frontmatter.attachments} onRemoveAttachment={(id) => void removeAttachment(id)} onSave={() => void save()} onCancel={() => { setDraft(draftFromTicket(selected)); setDirty(false); }} onCustomizeWorkflow={() => void run(() => api.action(selected, "workflow/clone"))} onMigrateWorkflow={() => void migrateWorkflow()} onReady={() => void run(() => api.action(selected, "ready"))} readyDisabled={dirty} /> : frontmatter ? <div className="issue-page">
          <div className="issue-heading"><div><span className="issue-key">{frontmatter.id} · {selected.relative_path}</span><h1>{frontmatter.title}</h1><div className="issue-chips"><span className="state-layer"><small>Ticket state</small><StatusPill value={frontmatter.status} label={`Ticket ${humanize(frontmatter.status)}`} /></span>{frontmatter.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}</div></div>
            <div className="issue-actions">
              <ActionButton onClick={() => setComposer({ kind: "comment", text: "" })}>Add comment</ActionButton>
              <ActionButton primary onClick={() => setComposer({ kind: "guidance", text: "" })}>Guide agent</ActionButton>
            </div>
          </div>
          <WorkflowMap ticket={frontmatter} workflow={selectedWorkflow} />
          {costLimitPause && <section className="attention-banner cost-limit-pause"><strong>Node cost limit reached</strong><span>{currentWorkflowNode?.name} accumulated {usd(costLimitPause.observed_usd ?? currentNodeKnownCost)} against its {usd(costLimitPause.limit_usd ?? currentWorkflowNode?.max_cost_usd ?? 50)} limit. Publish a workflow revision with a higher limit, then migrate this ticket to that revision before continuing.</span></section>}
          <ExecutionRecap ticket={frontmatter} {...(selectedWorkflow ? { workflow: selectedWorkflow } : {})} now={now} />
          <ReviewMaterials ticket={frontmatter} {...(selectedWorkflow ? { workflow: selectedWorkflow } : {})} busy={busy} now={now} onDecide={decideGate} />
          <PendingQuestions questions={frontmatter.questions ?? []} answers={questionAnswers} busy={busy} now={now} onChange={(questionId, answer) => setQuestionAnswers((current) => ({ ...current, [questionId]: answer }))} onAnswer={(questionId) => void answerQuestion(questionId)} />
          <RepositoryBlockers blockers={selectedSummary?.claim_blockers ?? []} />
          {composer && <section className="composer"><div><strong>{composer.kind === "guidance" ? "Guide the active or next agent" : "Add an operator comment"}</strong><small>{composer.kind === "guidance" ? "Guidance is persisted before delivery." : "Comments are added to the durable timeline."}</small></div><textarea autoFocus aria-label={composer.kind === "guidance" ? "Agent guidance" : "Ticket comment"} value={composer.text} onChange={(event) => setComposer({ ...composer, text: event.target.value })} /><div><button className="button-secondary" onClick={() => setComposer(null)}>Cancel</button><button className="button-primary" disabled={busy || !composer.text.trim()} onClick={() => void submitComposer()}>Send</button></div></section>}
          <div className="issue-grid">
            <div className="issue-main">
              <section className="content-card description-card">
                <div className="section-heading"><div><span>Work ticket</span><h2>Description</h2></div>{!descriptionEdit && <button className="button-secondary button-compact" onClick={() => setDescriptionEdit({ text: descriptionFromBody(selected.body), targetNode: currentWorkflowNode?.id ?? selectedWorkflow?.start ?? "" })}>Edit description</button>}</div>
                {descriptionEdit ? <div className="live-description-editor">
                  <textarea aria-label="Live ticket description" value={descriptionEdit.text} onChange={(event) => setDescriptionEdit({ ...descriptionEdit, text: event.target.value })} />
                  <div className="restart-choice">
                    <label>Restart node<select aria-label="Restart node" value={descriptionEdit.targetNode} onChange={(event) => setDescriptionEdit({ ...descriptionEdit, targetNode: event.target.value })}>
                      {selectedWorkflow?.nodes.filter((node) => node.type !== "terminal").map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
                    </select></label>
                    <p>{frontmatter.execution ? "Restarting first interrupts and fences the active node." : "Restarting moves the ticket to the selected workflow node."}</p>
                  </div>
                  <div className="live-edit-actions"><button className="button-secondary" onClick={() => setDescriptionEdit(null)}>Cancel</button><button className="button-secondary" disabled={busy || !descriptionEdit.text.trim() || Boolean(frontmatter.execution?.interrupt_request)} onClick={() => void saveLiveDescription(false)}>Save and continue</button><button className="button-primary" disabled={busy || !descriptionEdit.text.trim() || Boolean(frontmatter.execution?.interrupt_request)} onClick={() => void saveLiveDescription(true)}>Save and restart</button></div>
                </div> : <MarkdownContent markdown={descriptionFromBody(selected.body)} />}
              </section>
              <TicketEvidence key={selected.id} ticket={selected} {...(selectedWorkflow ? { workflow: selectedWorkflow } : {})} busy={busy} now={now} onUpload={(files) => void uploadAttachments(files)} onRemoveAttachment={(id) => void removeAttachment(id)} onCreateCheckpoint={(nodeId) => void run(() => api.checkpointAction(selected, "create", nodeId))} onRestoreCheckpoint={(nodeId, checkpointId) => void run(() => api.checkpointAction(selected, "restore", nodeId, checkpointId))} />
              <Timeline body={selected.body} />
            </div>
            <aside className="issue-sidebar">
              {frontmatter.execution && <RuntimePanel execution={frontmatter.execution} now={now} />}
              <TicketUsage ticket={frontmatter} now={now} humanDayRate={config?.metrics?.human_day_rate_usd ?? 1_000} />
              <TicketQuality ticket={frontmatter} />
              {frontmatter.phase === "done" && frontmatter.status === "completed" && <ProductionAssessment ticket={frontmatter} busy={busy} onSave={(production_result, production_assessment_note) => void run(() => api.action(selected, "production-assessment", { production_result, production_assessment_note }))} onArchive={(production_result, production_assessment_note) => void run(() => api.action(selected, "archive", { production_result, production_assessment_note }))} />}
              <section className="side-card"><div className="section-heading"><div><span>Ticket</span><h2>Details</h2></div></div><dl className="details-list">
                <DetailRow label="Ticket state">{humanize(frontmatter.status)}</DetailRow>
                {currentWorkflowNode ? <><DetailRow label="Current workflow node">{currentWorkflowNode.name}</DetailRow><DetailRow label="Workflow stage">{currentWorkflowStage?.name ?? humanize(currentWorkflowNode.stage)}</DetailRow><DetailRow label="Node type">{humanize(currentWorkflowNode.type)}</DetailRow><DetailRow label="Resolved agent provider">{currentProvider ? humanize(currentProvider) : "Not an agent node"}</DetailRow></> : <DetailRow label="Workflow state">Unavailable</DetailRow>}
                {frontmatter.workflow_assignment && <DetailRow label="Workflow revision">{assignedRelease ? releaseDisplayLabel(assignedRelease) : `Revision v${frontmatter.workflow_assignment.version}`} · {humanize(frontmatter.workflow_assignment.selection)}</DetailRow>}
                <DetailRow label="Ticket priority"><PriorityEditor value={frontmatter.priority} busy={busy} onSave={(priority) => void run(() => api.action(selected, "priority", { priority }))} /></DetailRow><DetailRow label="Updated">{timeAgo(frontmatter.updated_at, now)}</DetailRow>
                <DetailRow label="Estimated human days"><HumanEstimateEditor value={frontmatter.estimated_human_days ?? null} busy={busy} onSave={(estimated_human_days) => void run(() => api.action(selected, "human-estimate", { estimated_human_days }))} /></DetailRow>
                <DetailRow label="Supervisor">{frontmatter.assigned_supervisor ?? "Unassigned"}</DetailRow>
                <DetailRow label="Supervisor host">{frontmatter.assigned_supervisor_host ?? "Unassigned"}</DetailRow>
                {typeof frontmatter.metadata?.["intake.source_id"] === "string" && <DetailRow label="Intake origin">{String(frontmatter.metadata["intake.campaign_id"] ?? "campaign")} · {frontmatter.metadata["intake.source_id"] as string}</DetailRow>}
                {typeof frontmatter.metadata?.["intake.parent_ticket_id"] === "string" && <DetailRow label="Parent ticket"><button className="link-button" onClick={() => void open(frontmatter.metadata!["intake.parent_ticket_id"] as string)}>{frontmatter.metadata["intake.parent_ticket_id"] as string}</button></DetailRow>}
                {frontmatter.jira && <DetailRow label="Jira"><a href={frontmatter.jira.url} target="_blank" rel="noreferrer">{frontmatter.jira.key} ↗</a></DetailRow>}
                {frontmatter.archived_at && <DetailRow label="Archived">{timeAgo(frontmatter.archived_at, now)}</DetailRow>}
                {activeAttempt && <DetailRow label="Attempts">{activeAttempt.total} total · {activeAttempt.consecutive_lease_losses} lease losses</DetailRow>}
              </dl></section>
              <section className="side-card"><div className="section-heading"><div><span>Scope</span><h2>Repositories & PRs</h2></div></div>{frontmatter.repositories.map((repository) => {
                const prs = frontmatter.pull_requests.filter((candidate) => candidate.repository === repository.id);
                return <div className="repo-item" key={repository.id}><div><strong>{repository.id}</strong>{repository.primary && <span>Primary</span>}</div>{prs.length ? <div>{prs.map((pr) => <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer">Open {pr.phase ? humanize(pr.phase) : "draft"} PR ↗</a>)}</div> : <small>No PR reported</small>}</div>;
              })}</section>
              <AnsweredQuestions questions={frontmatter.questions ?? []} />
              <AgentSessions ticket={frontmatter} {...(selectedWorkflow ? { workflow: selectedWorkflow } : {})} onReset={(key) => { if (window.confirm(`Reset ${humanize(key)}? The next visit will start a new Herdr conversation.`)) void run(() => api.resetConversation(selected, key)); }} />
              <section className="side-card action-card"><div className="section-heading"><div><span>Controls</span><h2>State actions</h2></div></div><div className="control-buttons">
                {frontmatter.status === "ready" && <ActionButton onClick={() => void run(() => api.action(selected, "draft"))}>Return to draft</ActionButton>}
                {(frontmatter.status === "failed" || frontmatter.status === "blocked") && !costLimitPause && <ActionButton primary onClick={() => void run(() => api.action(selected, "retry"))}>Retry node</ActionButton>}
                {frontmatter.status === "waiting_external" && <ActionButton primary onClick={() => void run(() => api.action(selected, "wake"))}>Check now</ActionButton>}
                {frontmatter.status === "completed" && <ActionButton onClick={() => void moveToNode("reopen")}>Reopen ticket</ActionButton>}
                {currentWorkflowNode?.type === "human_gate" && currentWorkflowNode.github_watch && frontmatter.status === "waiting_approval" && frontmatter.pull_requests.some((pr) => currentWorkflowNode.github_watch?.pull_request_phase === "all" || pr.phase === currentWorkflowNode.github_watch?.pull_request_phase || (currentWorkflowNode.github_watch?.pull_request_phase === "specification" && !pr.phase)) && <ActionButton onClick={() => void checkPullRequests()}>Check GitHub feedback</ActionButton>}
                {frontmatter.status === "completed" && !frontmatter.archived_at && frontmatter.pull_requests.length > 0 && (!frontmatter.workflow || currentWorkflowNode?.github_watch?.feedback_target) && <ActionButton onClick={() => void checkPullRequests()}>Check GitHub PRs</ActionButton>}
                {frontmatter.archived_at && <ActionButton onClick={() => void run(() => api.action(selected, "unarchive"))}>Unarchive ticket</ActionButton>}
                {config?.jira?.enabled && !frontmatter.jira && <ActionButton onClick={() => void run(() => api.action(selected, "jira/export"))}>Send to Jira</ActionButton>}
                {config?.jira?.enabled && frontmatter.jira && isInitialDraft(frontmatter) && <ActionButton onClick={() => void run(() => api.action(selected, "jira/resync"))}>Refresh from Jira</ActionButton>}
                {frontmatter.status !== "completed" && <ActionButton onClick={() => void moveToNode("restart")}>Restart at node</ActionButton>}
                {!frontmatter.execution && frontmatter.workflow && <ActionButton onClick={() => void migrateWorkflow()}>Migrate workflow</ActionButton>}
                {frontmatter.status !== "completed" && frontmatter.status !== "failed" && <ActionButton danger onClick={() => void fail()}>Fail ticket</ActionButton>}
                {frontmatter.assigned_supervisor && !frontmatter.execution && frontmatter.status !== "completed" && frontmatter.status !== "cancelled" && <ActionButton onClick={() => { if (window.confirm("Release this supervisor? The next eligible supervisor will start new agent conversations for this ticket.")) void run(() => api.action(selected, "release-supervisor")); }}>Release supervisor</ActionButton>}
                {!frontmatter.archived_at && <ActionButton danger onClick={() => void run(() => api.action(selected, "cancel", { message: "Cancelled from the operator UI." }))}>Cancel ticket</ActionButton>}
              </div></section>
            </aside>
          </div>
        </div> : null : <div className="welcome"><div className="welcome-orbit"><span>◎</span></div><span>Agentic Project Tracker</span><h1>Durable work.<br />Autonomous execution.</h1><p>Select a ticket to inspect its workflow, agent runtime, and history.</p><button className="button-primary" onClick={() => void beginLocalTicket()}>Create a ticket</button></div>}
      </section>
    </main>}
  </div>;
}
