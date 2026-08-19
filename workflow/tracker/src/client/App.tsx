import React, { useCallback, useEffect, useId, useMemo, useState } from "react";
import { parse, stringify } from "yaml";
import { api, type Execution, type HarnessTelemetryRecord, type MetricsReport, type NumberSummary, type PromptDocument, type RepositoryClaimBlocker, type RepositoryConfig, type RuntimeAgent, type SupervisorHealth, type TicketDetail, type TicketFrontmatter, type TicketSummary, type TrackerConfig, type WorkflowDocument, type WorkflowNode } from "./api.js";

const LOG_START = "<!-- tracker:interaction-log:start -->";
const LOG_END = "<!-- tracker:interaction-log:end -->";
const PHASES = ["specification", "implementation", "review", "done"] as const;
const THEMES = ["light", "dark", "retro"] as const;
type Theme = (typeof THEMES)[number];
type WorkProvider = "claude" | "codex";
type ReviewProvider = "claude" | "codex";
const ALL_WORK_PROVIDERS: WorkProvider[] = ["claude", "codex"];
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
  ["AGENTIC_WORKFLOW_PHASE", "Ticket compatibility phase projected by the node."],
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
`,
  javascript: `${inlineEnvironmentHeader("javascript")}
const agenticEnv = Object.fromEntries(
  Object.entries(process.env)
    .filter(([name]) => name.startsWith("AGENTIC_"))
    .sort(([left], [right]) => left.localeCompare(right)),
);

console.log(JSON.stringify(agenticEnv, null, 2));
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

function defaultReviewProvider(workProvider: WorkProvider): ReviewProvider {
  return workProvider === "codex" ? "claude" : "codex";
}

function isInitialDraft(ticket: TicketFrontmatter): boolean {
  return ticket.status === "pending" && ticket.phase === (ticket.spec_required ? "specification" : "implementation");
}

interface TicketDraft {
  id: string;
  autoId: boolean;
  title: string;
  description: string;
  specRequired: boolean;
  reviewRequired: boolean;
  workProvider: WorkProvider;
  reviewProvider: ReviewProvider;
  priority: number;
  labels: string;
  repositories: Array<{ id: string; primary: boolean }>;
  jira: TicketFrontmatter["jira"];
  workflowId: string;
  workflowInputs: Record<string, boolean | string>;
  stageEnabled: Record<string, boolean>;
}

const emptyDraft = (id = "AGENT-0001", autoId = true, enabledProviders: WorkProvider[] = ALL_WORK_PROVIDERS): TicketDraft => {
  const workProvider = enabledProviders.includes("claude") ? "claude" : enabledProviders[0] ?? "claude";
  return {
    id, autoId, title: "Describe the work", description: "# Goal\n\nDescribe the desired outcome.\n\n# Acceptance Criteria\n\n- Add an observable acceptance criterion.",
    specRequired: true, reviewRequired: true, workProvider, reviewProvider: defaultReviewProvider(workProvider), priority: 0, labels: "",
    repositories: [{ id: "", primary: true }], jira: null, workflowId: "standard-delivery", workflowInputs: {}, stageEnabled: {},
  };
};

function draftErrors(draft: TicketDraft): string[] {
  const errors: string[] = [];
  if (!draft.id.trim()) errors.push("Ticket ID is required.");
  if (!draft.title.trim()) errors.push("Title is required.");
  if (!draft.description.trim()) errors.push("Description is required.");
  if (draft.repositories.length === 0) errors.push("Add at least one repository.");
  if (draft.repositories.some((repository) => !repository.id.trim())) errors.push("Every repository needs a name.");
  if (draft.repositories.filter((repository) => repository.primary).length !== 1) errors.push("Choose exactly one primary repository.");
  const repositories = draft.repositories.map((repository) => repository.id.trim()).filter(Boolean);
  if (new Set(repositories).size !== repositories.length) errors.push("Repository names must be unique.");
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
    description: descriptionFromBody(ticket.body), specRequired: frontmatter.spec_required,
    reviewRequired: frontmatter.review_required, workProvider: frontmatter.work_provider, reviewProvider: frontmatter.review_provider,
    priority: frontmatter.priority, labels: frontmatter.labels.join(", "),
    repositories: frontmatter.repositories.map((repository) => ({ ...repository })), jira: frontmatter.jira,
    workflowId: frontmatter.workflow?.id ?? "standard-delivery",
    workflowInputs: { ...(frontmatter.workflow?.inputs ?? {}) }, stageEnabled: { ...(frontmatter.workflow?.stage_enabled ?? {}) },
  };
}

function ticketMarkdown(draft: TicketDraft, current?: TicketDetail): string {
  const editable = {
    id: draft.id.trim(), title: draft.title.trim(),
    spec_required: draft.specRequired, review_required: draft.reviewRequired,
    work_provider: draft.workProvider, review_provider: draft.reviewProvider, priority: Number(draft.priority) || 0,
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

function resolvedWorkflowProvider(ticket: TicketFrontmatter, node: WorkflowNode | undefined): string | null {
  if (!node || node.type !== "agent") return null;
  if (node.provider === "work") return ticket.work_provider;
  if (node.provider === "review") return ticket.review_provider;
  return node.provider ?? null;
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

function StatusPill({ value, subtle = false }: { value: string; subtle?: boolean }) {
  return <span className={`status-pill status-${value} ${subtle ? "subtle" : ""}`}><i />{humanize(value)}</span>;
}

function WorkflowMap({ ticket, workflow }: { ticket: TicketFrontmatter; workflow: WorkflowDocument["definition"] | undefined }) {
  if (ticket.workflow && workflow) return <section className="workflow-panel" aria-label="Ticket workflow">
    <div className="section-heading"><div><span>Workflow · {workflow.id}@{ticket.workflow.revision.slice(0, 8)}</span><h2>{workflow.name}</h2></div><StatusPill value={ticket.status} /></div>
    <WorkflowGraph workflow={workflow} currentNode={ticket.workflow.current_node} />
    <div className="workflow-loops"><span>{ticket.workflow.transition_count} / {workflow.max_transitions} transitions</span><span>{ticket.workflow.node_runs.length} durable node runs</span></div>
  </section>;
  const currentIndex = PHASES.indexOf(ticket.phase as (typeof PHASES)[number]);
  const stateFor = (phase: (typeof PHASES)[number], index: number) => {
    if (phase === "specification" && !ticket.spec_required) return "skipped";
    if (phase === "review" && !ticket.review_required) return "skipped";
    if (ticket.phase === "done" || index < currentIndex) return "complete";
    if (index === currentIndex) return "current";
    return "upcoming";
  };
  const descriptions: Record<(typeof PHASES)[number], string> = {
    specification: "Shape the approach", implementation: "Build and verify", review: "Independent review", done: "Ready for merge",
  };
  return <section className="workflow-panel" aria-label="Ticket workflow">
    <div className="section-heading"><div><span>Workflow</span><h2>Path to completion</h2></div><StatusPill value={ticket.status} /></div>
    <div className="workflow-map">
      {PHASES.map((phase, index) => {
        const state = stateFor(phase, index);
        return <React.Fragment key={phase}>
          {index > 0 && <div className={`workflow-edge edge-${stateFor(PHASES[index - 1]!, index - 1)}`}><span>→</span></div>}
          <div className={`workflow-node node-${state}`} aria-current={state === "current" ? "step" : undefined}>
            <div className="node-orbit"><span>{state === "complete" ? "✓" : state === "skipped" ? "—" : index + 1}</span></div>
            <strong>{humanize(phase)}</strong>
            <small>{state === "current" ? humanize(ticket.status) : state === "skipped" ? "Not required" : descriptions[phase]}</small>
          </div>
        </React.Fragment>;
      })}
    </div>
    <div className="workflow-loops"><span>↶ Specification feedback</span><span>↶ Review changes return to implementation</span></div>
  </section>;
}

function phaseAttemptSummary(label: string, total: number, required = true): string {
  if (!required) return `${label} skipped`;
  if (total === 0) return `${label} not started`;
  return `${label} ${total} attempt${total === 1 ? "" : "s"}`;
}

function AgentSessions({ ticket, workflow }: { ticket: TicketFrontmatter; workflow?: WorkflowDocument["definition"] }) {
  if (ticket.workflow && workflow) {
    const conversations = Object.entries(ticket.conversations ?? {});
    return <section className="side-card" aria-label="Agent sessions">
      <div className="section-heading"><div><span>Conversations</span><h2>Agent sessions</h2></div></div>
      {conversations.length ? conversations.map(([key, conversation]) => {
        const nodes = workflow.nodes.filter((node) => node.type === "agent" && node.conversation_key === key).map((node) => node.name);
        return <div className="session-item" key={key}><span>{humanize(key)}</span><strong>{conversation.provider ? humanize(conversation.provider) : "Unassigned"}</strong><small className="session-context">{nodes.join(" · ") || "Workflow conversation"}</small>{conversation.herdr_pane_id && <small>{conversation.herdr_pane_id}</small>}{conversation.session_ref && <code>{conversation.session_ref}</code>}</div>;
      }) : <p className="muted">No agent conversation has started.</p>}
    </section>;
  }
  const work = ticket.agents.implementation ?? ticket.agents.specification;
  const review = ticket.agents.review;
  const workSummary = [
    phaseAttemptSummary("Specification", ticket.attempts.specification?.total ?? 0, ticket.spec_required),
    phaseAttemptSummary("Implementation", ticket.attempts.implementation?.total ?? 0),
  ].join(" · ");
  const reviewSummary = phaseAttemptSummary("Review", ticket.attempts.review?.total ?? 0, ticket.review_required);
  return <section className="side-card" aria-label="Agent sessions">
    <div className="section-heading"><div><span>Conversations</span><h2>Agent sessions</h2></div></div>
    <div className="session-item">
      <span>Work</span><strong>{work?.provider ?? "Unassigned"}</strong>
      <small className="session-context">{workSummary}</small>
      {work?.herdr_pane_id && <small>{work.herdr_pane_id}</small>}
      {work?.session_ref && <code>{work.session_ref}</code>}
    </div>
    <div className="session-item">
      <span>Review</span><strong>{ticket.review_required ? review?.provider ?? "Unassigned" : "Skipped"}</strong>
      <small className="session-context">{reviewSummary}</small>
      {ticket.review_required && review?.herdr_pane_id && <small>{review.herdr_pane_id}</small>}
      {ticket.review_required && review?.session_ref && <code>{review.session_ref}</code>}
    </div>
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

function runtimeWarning(execution: Pick<Execution, "observed_herdr_state" | "last_heartbeat_at" | "lease_expires_at">, now: number): string | null {
  const state = execution.observed_herdr_state;
  if (state === "blocked") return "Agent needs attention in Herdr";
  if (state === "idle" || state === "done") return "Agent settled without a ticket callback";
  if (state === "unknown") return "Herdr cannot classify the agent state";
  if (now - Date.parse(execution.last_heartbeat_at) > 60_000) return "Supervisor heartbeat is stale";
  if (Date.parse(execution.lease_expires_at) - now < 30_000) return "Lease is close to expiring";
  return null;
}

function AgentFleet({ agents, now, onOpen }: { agents: RuntimeAgent[]; now: number; onOpen: (id: string) => void }) {
  return <section className="fleet-bar" aria-label="Active agents">
    <div className="fleet-label"><span>Live operations</span><strong>{agents.length} active agent{agents.length === 1 ? "" : "s"}</strong></div>
    <div className="fleet-list">{agents.length ? agents.map((agent) => {
      const state = agent.node_type === "script" ? "running" : agent.herdr?.state ?? "unobserved";
      const warning = runtimeWarning({ observed_herdr_state: state, last_heartbeat_at: agent.last_heartbeat_at, lease_expires_at: agent.lease_expires_at }, now);
      return <button key={agent.ticket_id} className={`fleet-agent ${warning ? "needs-attention" : ""}`} onClick={() => onOpen(agent.ticket_id)}>
        <span className={`agent-dot state-${state}`} />
        <span><strong>{agent.node_type === "script" ? "Script" : agent.telemetry?.latest.model.id ?? agent.provider}</strong><small>{agent.ticket_id} · {humanize(agent.node_id ?? agent.phase)}{agent.telemetry?.delta.usage ? ` · ${tokenCount(agent.telemetry.delta.usage.total_tokens)} tokens` : ""}</small></span>
        <span className="fleet-state">{warning ?? `${humanize(state)} · ${timeAgo(agent.last_heartbeat_at, now)}`}</span>
      </button>;
    }) : <p className="fleet-empty">No agents currently hold a ticket lease.</p>}</div>
  </section>;
}

function SupervisorHealthPage({ supervisors, now, onOpenTicket }: { supervisors: SupervisorHealth[]; now: number; onOpenTicket: (id: string) => void }) {
  const online = supervisors.filter((supervisor) => supervisor.status === "online").length;
  return <main className="supervisors-page">
    <div className="health-heading"><div><span>Infrastructure</span><h1>Supervisor health</h1><p>Each supervisor owns one isolated project root and one ticket end-to-end.</p></div><div className="health-summary"><strong>{online}/{supervisors.length}</strong><span>online</span></div></div>
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

function ConfigurationPage({ config, busy, onSave }: { config: TrackerConfig | null; busy: boolean; onSave: (update: Pick<TrackerConfig, "providers" | "agent_profiles" | "repositories" | "jira" | "github">) => void }) {
  const [enabledProviders, setEnabledProviders] = useState<WorkProvider[]>(config?.providers?.enabled ?? ALL_WORK_PROVIDERS);
  const [repositories, setRepositories] = useState<RepositoryConfig[]>(config?.repositories ?? []);
  const [jira, setJira] = useState(config?.jira ?? { enabled: false, site_url: "", project_key: "", issue_type: "Task" });
  const [github, setGithub] = useState(config?.github ?? { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] });
  const [agentProfiles, setAgentProfiles] = useState(config?.agent_profiles ?? { default: "default", profiles: [{ id: "default", label: "Default", provider: "codex" as const, model: "gpt-5.6-sol", reasoning: "high" }] });
  useEffect(() => { setEnabledProviders(config?.providers?.enabled ?? ALL_WORK_PROVIDERS); setRepositories(config?.repositories ?? []); if (config?.jira) setJira(config.jira); if (config?.github) setGithub(config.github); if (config?.agent_profiles) setAgentProfiles(config.agent_profiles); }, [config?.revision]);
  const errors: string[] = [];
  if (enabledProviders.length === 0) errors.push("Enable at least one work agent.");
  if (repositories.some((repository) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository.id) || repository.id === "." || repository.id === "..")) errors.push("Repository IDs must be safe directory names.");
  if (repositories.some((repository) => !repository.url.trim())) errors.push("Every repository needs a clone URL.");
  if (new Set(repositories.map((repository) => repository.id.trim())).size !== repositories.length) errors.push("Repository IDs must be unique.");
  if (new Set(repositories.map((repository) => repository.url.trim())).size !== repositories.length) errors.push("Repository URLs must be unique.");
  if (jira.enabled && !/^https:\/\/[A-Za-z0-9.-]+\.atlassian\.net\/?$/.test(jira.site_url)) errors.push("Jira site must be an atlassian.net URL.");
  if (jira.enabled && !jira.project_key.trim()) errors.push("Jira project key is required when Jira is enabled.");
  if (!agentProfiles.profiles.length) errors.push("Configure at least one agent profile.");
  if (!agentProfiles.profiles.some((profile) => profile.id === agentProfiles.default)) errors.push("The default agent profile must reference an alias.");
  if (agentProfiles.profiles.some((profile) => !/^[a-z][a-z0-9-]{0,63}$/.test(profile.id) || !profile.label.trim() || !profile.model.trim() || !profile.reasoning.trim())) errors.push("Every agent profile needs a valid alias, label, model, and reasoning value.");
  if (new Set(agentProfiles.profiles.map((profile) => profile.id)).size !== agentProfiles.profiles.length) errors.push("Agent profile aliases must be unique.");
  const update = (index: number, patch: Partial<RepositoryConfig>) => setRepositories((current) => current.map((repository, candidate) => candidate === index ? { ...repository, ...patch } : repository));
  const toggleProvider = (provider: WorkProvider, enabled: boolean) => setEnabledProviders((current) => enabled
    ? ALL_WORK_PROVIDERS.filter((candidate) => candidate === provider || current.includes(candidate))
    : current.filter((candidate) => candidate !== provider));
  return <main className="configuration-page">
    <div className="health-heading"><div><span>Local configuration</span><h1>Repository catalog</h1><p>Every supervisor clones missing repositories into its own project root.</p></div>{config && <div className="health-summary"><strong>r{config.revision}</strong><span>tracker-config.yaml</span></div>}</div>
    <section className="configuration-card">
      <div className="section-heading"><div><span>Repositories</span><h2>Configured clone sources</h2></div><button className="button-secondary" onClick={() => setRepositories((current) => [...current, { id: "", url: "" }])}>Add repository</button></div>
      <div className="config-column-labels"><span>Directory ID</span><span>Git clone URL</span><span /></div>
      {repositories.map((repository, index) => <div className="config-repository-row" key={index}>
        <input aria-label={`Repository ID ${index + 1}`} placeholder="application-api" value={repository.id} onChange={(event) => update(index, { id: event.target.value })} />
        <input aria-label={`Repository URL ${index + 1}`} placeholder="git@github.com:organization/repository.git" value={repository.url} onChange={(event) => update(index, { url: event.target.value })} />
        <button className="icon-button" aria-label={`Remove configured repository ${index + 1}`} onClick={() => setRepositories((current) => current.filter((_, candidate) => candidate !== index))}>×</button>
      </div>)}
      {!repositories.length && <div className="config-empty"><strong>No repositories configured</strong><span>Add the repositories that should exist beneath every supervisor project root.</span></div>}
      <div className="section-heading"><div><span>Ticket creation</span><h2>Enabled work agents</h2></div></div>
      <p className="config-help">Choose which providers appear in the Work agent selector for new tickets. Supervisor availability is reported separately and does not change this list automatically.</p>
      <div className="provider-config-grid">{ALL_WORK_PROVIDERS.map((provider) => <label className="toggle" key={provider}><input aria-label={`Enable ${humanize(provider)}`} type="checkbox" checked={enabledProviders.includes(provider)} onChange={(event) => toggleProvider(provider, event.target.checked)} /><span><strong>{humanize(provider)}</strong><small>{enabledProviders.includes(provider) ? "Available for new tickets" : "Hidden from new tickets"}</small></span></label>)}</div>
      <div className="section-heading"><div><span>Agent runtime</span><h2>Provider profiles</h2></div><button className="button-secondary" onClick={() => setAgentProfiles((current) => ({ ...current, profiles: [...current.profiles, { id: `profile-${current.profiles.length + 1}`, label: "New profile", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" }] }))}>Add profile</button></div>
      <p className="config-help">Workflow nodes reference an alias. Each ticket pins the alias's resolved provider, model, and reasoning when it is created.</p>
      <div className="config-column-labels"><span>Alias / label</span><span>Provider / model / reasoning</span><span /></div>
      {agentProfiles.profiles.map((profile, index) => <div className="config-repository-row" key={`${profile.id}:${index}`}>
        <div><input aria-label={`Agent profile alias ${index + 1}`} value={profile.id} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") } : item) }))} /><input aria-label={`Agent profile label ${index + 1}`} value={profile.label} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, label: event.target.value } : item) }))} /></div>
        <div className="field-row"><select aria-label={`Agent profile provider ${index + 1}`} value={profile.provider} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, provider: event.target.value as WorkProvider } : item) }))}>{ALL_WORK_PROVIDERS.map((provider) => <option key={provider} value={provider}>{humanize(provider)}</option>)}</select><input aria-label={`Agent profile model ${index + 1}`} value={profile.model} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, model: event.target.value } : item) }))} /><input aria-label={`Agent profile reasoning ${index + 1}`} value={profile.reasoning} onChange={(event) => setAgentProfiles((current) => ({ ...current, profiles: current.profiles.map((item, candidate) => candidate === index ? { ...item, reasoning: event.target.value } : item) }))} /></div>
        <button className="icon-button" disabled={agentProfiles.profiles.length === 1} onClick={() => setAgentProfiles((current) => { const profiles = current.profiles.filter((_, candidate) => candidate !== index); return { default: current.default === profile.id ? profiles[0]!.id : current.default, profiles }; })}>×</button>
      </div>)}
      <label>Default profile<select aria-label="Default agent profile" value={agentProfiles.default} onChange={(event) => setAgentProfiles({ ...agentProfiles, default: event.target.value })}>{agentProfiles.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} ({profile.id})</option>)}</select></label>
      <div className="section-heading"><div><span>Optional integration</span><h2>Jira Cloud</h2></div></div>
      <label className="toggle"><input type="checkbox" checked={jira.enabled} onChange={(event) => setJira({ ...jira, enabled: event.target.checked })} /><span><strong>Enable Jira</strong><small>Disabled personal installs make no Jira requests.</small></span></label>
      {jira.enabled && <div className="field-row"><label>Atlassian site<input aria-label="Jira site" placeholder="https://company.atlassian.net" value={jira.site_url} onChange={(event) => setJira({ ...jira, site_url: event.target.value })} /></label><label>Project key<input aria-label="Jira project key" value={jira.project_key} onChange={(event) => setJira({ ...jira, project_key: event.target.value })} /></label><label>Issue type<input aria-label="Jira issue type" value={jira.issue_type} onChange={(event) => setJira({ ...jira, issue_type: event.target.value })} /></label></div>}
      <div className="section-heading"><div><span>Review follow-up</span><h2>GitHub PR observation</h2></div></div>
      <label className="toggle"><input type="checkbox" checked={github.observation_enabled} onChange={(event) => setGithub({ ...github, observation_enabled: event.target.checked })} /><span><strong>Check reviewable tickets periodically</strong><small>GitHub feedback follows the explicit outcome or target configured on the current workflow node.</small></span></label>
      <div className="field-row"><label>Interval (minutes)<input aria-label="GitHub observation interval" type="number" min="1" value={github.observation_interval_minutes} onChange={(event) => setGithub({ ...github, observation_interval_minutes: Number(event.target.value) })} /></label><label>Ignored GitHub logins<input aria-label="Ignored GitHub logins" value={github.ignored_logins.join(", ")} onChange={(event) => setGithub({ ...github, ignored_logins: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label></div>
      {errors.length > 0 && <div className="draft-validation" role="alert"><strong>Configuration needs attention</strong><ul>{errors.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      <div className="config-footer"><p>Credentials stay in environment variables: JIRA_EMAIL, JIRA_API_TOKEN, and GITHUB_TOKEN.</p><button className="button-primary" disabled={!config || busy || errors.length > 0} onClick={() => onSave({ providers: { enabled: enabledProviders }, agent_profiles: agentProfiles, repositories: repositories.map((repository) => ({ id: repository.id.trim(), url: repository.url.trim() })), jira: { ...jira, site_url: jira.site_url.replace(/\/$/, ""), project_key: jira.project_key.trim(), issue_type: jira.issue_type.trim() }, github })}>Save configuration</button></div>
    </section>
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

function TicketEditor({ draft, setDraft, existing, busy, onSave, onCancel, onReady, onCustomizeWorkflow, onMigrateWorkflow, readyDisabled = false, repositories, enabledWorkProviders = ALL_WORK_PROVIDERS, workflows = [] }: {
  draft: TicketDraft; setDraft: React.Dispatch<React.SetStateAction<TicketDraft>>; existing: boolean; busy: boolean;
  onSave: () => void; onCancel: () => void; onReady?: () => void; onCustomizeWorkflow?: () => void; onMigrateWorkflow?: () => void; readyDisabled?: boolean; repositories?: RepositoryConfig[]; enabledWorkProviders?: WorkProvider[]; workflows?: WorkflowDocument[];
}) {
  const validationErrors = draftErrors(draft);
  const selectableWorkProviders = existing && !enabledWorkProviders.includes(draft.workProvider)
    ? [draft.workProvider, ...enabledWorkProviders] : enabledWorkProviders;
  const selectedWorkflow = workflows.find((workflow) => workflow.definition.id === draft.workflowId)?.definition;
  const update = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateWorkProvider = (workProvider: WorkProvider) => setDraft((current) => ({
    ...current, workProvider, reviewProvider: defaultReviewProvider(workProvider),
  }));
  const selectWorkflow = (workflowId: string) => {
    const workflow = workflows.find((item) => item.definition.id === workflowId)?.definition;
    setDraft((current) => ({
      ...current, workflowId,
      workflowInputs: Object.fromEntries(workflow?.inputs.map((input) => [input.id, input.default]) ?? []),
      stageEnabled: Object.fromEntries(workflow?.stages.map((stage) => [stage.id, stage.skippable ? stage.default_enabled : true]) ?? []),
      specRequired: workflow ? workflow.stages.some((stage) => stage.phase === "specification" && stage.default_enabled) : current.specRequired,
      reviewRequired: workflow ? workflow.stages.some((stage) => stage.phase === "review" && stage.default_enabled) : current.reviewRequired,
    }));
  };
  const setStageEnabled = (stage: WorkflowDocument["definition"]["stages"][number], enabled: boolean) => setDraft((current) => ({
    ...current, stageEnabled: { ...current.stageEnabled, [stage.id]: stage.skippable ? enabled : true },
    ...(stage.phase === "specification" ? { specRequired: enabled } : {}),
    ...(stage.phase === "review" ? { reviewRequired: enabled } : {}),
  }));
  const updateRepository = (index: number, patch: Partial<{ id: string; primary: boolean }>) => setDraft((current) => ({
    ...current,
    repositories: current.repositories.map((repository, candidate) => candidate === index ? { ...repository, ...patch } : patch.primary ? { ...repository, primary: false } : repository),
  }));
  return <div className="editor-page">
    <div className="issue-heading"><div><span className="issue-key">{existing ? draft.id : "New ticket"}</span><h1>{existing ? "Edit work ticket" : "Create work ticket"}</h1><p>Ticket fields become read-only in the dashboard once work begins.</p></div></div>
    {validationErrors.length > 0 && <div className="draft-validation" role="alert"><strong>Finish these fields before saving</strong><ul>{validationErrors.map((validationError) => <li key={validationError}>{validationError}</li>)}</ul></div>}
    <div className="form-grid">
      <section className="form-card form-main">
        <label>Title<input aria-label="Title" value={draft.title} onChange={(event) => update("title", event.target.value)} /></label>
        <label>Ticket ID <span>{existing ? "Ticket IDs cannot be changed after creation" : draft.jira ? "Imported from Jira" : draft.autoId ? "Suggested automatically; edit to use a custom ID" : "Custom ticket ID"}</span><input aria-label="Ticket ID" disabled={existing || draft.jira !== null} value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value, autoId: false }))} /></label>
        <label>Description <span>Markdown supported</span><textarea className="description-editor" aria-label="Description" value={draft.description} onChange={(event) => update("description", event.target.value)} /></label>
      </section>
      <aside className="form-card form-properties">
        <h2>Work settings</h2>
        <label>Work agent<select aria-label="Work agent" value={draft.workProvider} onChange={(event) => updateWorkProvider(event.target.value as WorkProvider)}>{selectableWorkProviders.map((provider) => <option key={provider} value={provider}>{humanize(provider)}</option>)}</select></label>
        <label>Review agent<select aria-label="Review agent" disabled value={draft.reviewProvider} onChange={(event) => update("reviewProvider", event.target.value as ReviewProvider)}><option value="codex">Codex</option><option value="claude">Claude</option></select><span>{`${humanize(draft.workProvider)} work is reviewed by ${humanize(draft.reviewProvider)}`}</span></label>
        <label>Priority<input aria-label="Priority" type="number" value={draft.priority} onChange={(event) => update("priority", Number(event.target.value))} /></label>
        <label>Labels <span>Comma separated</span><input aria-label="Labels" value={draft.labels} onChange={(event) => update("labels", event.target.value)} /></label>
        <label>Workflow<select aria-label="Workflow" disabled={existing} value={draft.workflowId} onChange={(event) => selectWorkflow(event.target.value)}>{workflows.filter((workflow) => workflow.valid).map((workflow) => <option key={workflow.definition.id} value={workflow.definition.id}>{workflow.definition.name}</option>)}</select><span>{existing ? "Pinned when the ticket was created" : "A versioned workflow revision will be pinned"}</span></label>
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
    <div className="sticky-actions"><button className="button-secondary" onClick={onCancel}>Cancel</button>{existing && onCustomizeWorkflow && <button className="button-secondary" disabled={busy || readyDisabled} onClick={onCustomizeWorkflow}>Customize workflow</button>}{existing && onMigrateWorkflow && <button className="button-secondary" disabled={busy || readyDisabled} onClick={onMigrateWorkflow}>Pin workflow revision</button>}<button className="button-secondary" disabled={busy || validationErrors.length > 0} onClick={onSave}>{existing ? "Save ticket" : "Create ticket"}</button>{existing && onReady && <button className="button-primary" title={readyDisabled ? "Save changes before marking ready" : undefined} disabled={busy || readyDisabled || validationErrors.length > 0} onClick={onReady}>Mark ready</button>}</div>
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

function tokenCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unavailable";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value < 0.01 ? 6 : 4 })}`;
}

type TicketNodeRun = NonNullable<TicketFrontmatter["workflow"]>["node_runs"][number];

function nodeTiming(run: TicketNodeRun, now: number) {
  let activeMs = run.timing.active_ms;
  let quotaPausedMs = run.timing.quota_paused_ms;
  let humanWaitMs = run.timing.human_wait_ms;
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
      else activeMs += elapsed;
    }
  }
  const end = run.completed_at ? Date.parse(run.completed_at) : now;
  const wallMs = Math.max(0, end - Date.parse(run.started_at));
  return { activeMs, quotaPausedMs, humanWaitMs, wallMs };
}

function NodeTimingDetails({ run, now }: { run: TicketNodeRun; now: number }) {
  const timing = nodeTiming(run, now);
  const parts = [`${duration(timing.wallMs)} wall`];
  if (timing.activeMs > 0 || run.node_type === "agent" || run.node_type === "script") parts.push(`${duration(timing.activeMs)} active`);
  if (timing.quotaPausedMs > 0 || run.timing.state === "quota_paused") parts.push(`${duration(timing.quotaPausedMs)} quota paused`);
  if (timing.humanWaitMs > 0 || run.node_type === "human_gate") parts.push(`${duration(timing.humanWaitMs)} human wait`);
  return <small className="run-telemetry">{parts.join(" · ")}{run.timing.state === "quota_paused" && run.timing.pause_until ? ` · resets in ${duration(Date.parse(run.timing.pause_until) - now)}` : ""}</small>;
}

function TelemetryDetails({ telemetry, compact = false }: { telemetry: HarnessTelemetryRecord; compact?: boolean }) {
  const { latest, delta } = telemetry;
  const reasoning = latest.reasoning.effort
    ? `${latest.reasoning.effort}${latest.reasoning.source === "current_configuration" ? " (current config)" : ""}`
    : latest.reasoning.enabled === true ? "Enabled" : latest.reasoning.enabled === false ? "Disabled" : "Unavailable";
  if (compact) return <small className="run-telemetry">
    {[latest.model.id ?? latest.harness, reasoning, delta.usage ? `${tokenCount(delta.usage.total_tokens)} tokens` : "tokens unavailable", delta.cost_usd !== null ? usd(delta.cost_usd) : "cost unavailable"].join(" · ")}
  </small>;
  const attributes = Object.entries(latest.attributes).filter(([, value]) => value !== null).slice(0, 6);
  return <div className="telemetry-details">
    <div className="telemetry-heading"><span>Harness telemetry</span><small>{latest.cost.kind === "unavailable" ? "Cost not reported by harness" : `${humanize(latest.cost.kind)} cost`}</small></div>
    <div className="metric-grid telemetry-metrics">
      <div><span>Node tokens</span><strong>{tokenCount(delta.usage?.total_tokens)}</strong></div>
      <div><span>Node cost</span><strong>{usd(delta.cost_usd)}</strong></div>
      <div><span>Input</span><strong>{tokenCount(delta.usage?.input_tokens)}</strong></div>
      <div><span>Output</span><strong>{tokenCount(delta.usage?.output_tokens)}</strong></div>
    </div>
    <dl className="details-list">
      <DetailRow label="Harness">{humanize(latest.harness)}</DetailRow>
      <DetailRow label="Exact model"><code>{latest.model.id ?? "Unavailable"}</code></DetailRow>
      {latest.model.observed_ids.length > 1 && <DetailRow label="Models used">{latest.model.observed_ids.map((model) => <code key={model}>{model} </code>)}</DetailRow>}
      <DetailRow label="Reasoning">{reasoning}</DetailRow>
      {delta.usage && <DetailRow label="Cached input">{tokenCount(delta.usage.cached_input_tokens)} read · {tokenCount(delta.usage.cache_write_input_tokens)} written</DetailRow>}
      {delta.usage && delta.usage.reasoning_output_tokens > 0 && <DetailRow label="Reasoning tokens">{tokenCount(delta.usage.reasoning_output_tokens)}</DetailRow>}
      {latest.context.window_tokens !== null && <DetailRow label="Context">{tokenCount(latest.context.used_tokens)} / {tokenCount(latest.context.window_tokens)}{latest.context.used_percent !== null ? ` (${latest.context.used_percent.toFixed(1)}%)` : ""}</DetailRow>}
      <DetailRow label="Observed">{timeAgo(latest.observed_at, Date.now())}</DetailRow>
    </dl>
    {latest.rate_limits.length > 0 && <div className="rate-limit-list">{latest.rate_limits.map((limit) => <div key={limit.id}><span>{limit.name ?? humanize(limit.id)}</span><strong>{limit.used_percent.toFixed(0)}%</strong><progress max="100" value={Math.min(100, limit.used_percent)} />{limit.resets_at && <small>{Date.parse(limit.resets_at) > Date.now() ? `Resets in ${duration(Date.parse(limit.resets_at) - Date.now())}` : `Reset ${timeAgo(limit.resets_at, Date.now())}`}</small>}</div>)}</div>}
    {attributes.length > 0 && <div className="telemetry-attributes">{attributes.map(([key, value]) => <span key={key}><small>{humanize(key)}</small>{String(value)}</span>)}</div>}
  </div>;
}

function TicketUsage({ ticket, now }: { ticket: TicketFrontmatter; now: number }) {
  const agentRuns = ticket.workflow?.node_runs.filter((run) => run.node_type === "agent") ?? [];
  const measured = agentRuns.filter((run) => run.telemetry);
  const totalTokens = measured.reduce((sum, run) => sum + (run.telemetry?.delta.usage?.total_tokens ?? 0), 0);
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
  if (!ticket.workflow?.node_runs.length && !measured.length) return null;
  return <section className="side-card" aria-label="Ticket usage">
    <div className="section-heading"><div><span>Accounting</span><h2>Ticket totals</h2></div></div>
    <div className="metric-grid telemetry-metrics">
      <div><span>Tokens</span><strong>{tokenCoverage ? tokenCount(totalTokens) : "Unavailable"}</strong></div>
      <div><span>Known cost</span><strong>{costRuns.length ? usd(totalCost) : "Unavailable"}</strong></div>
      <div><span>Workflow elapsed</span><strong>{duration(workflowElapsed)}</strong></div>
      <div><span>Active runtime</span><strong>{duration(activeMs)}</strong></div>
      <div><span>Quota paused</span><strong>{duration(quotaPausedMs)}</strong></div>
      <div><span>Human wait</span><strong>{duration(humanWaitMs)}</strong></div>
    </div>
    <p className="telemetry-coverage">Token coverage: {tokenCoverage}/{agentRuns.length} agent runs · Cost coverage: {costRuns.length}/{agentRuns.length}{estimatedCostRuns ? ` (${estimatedCostRuns} estimated)` : ""}. Subscription-backed harnesses may not expose per-ticket USD cost. Quota-pause accounting requires harness rate-limit telemetry; wall time does not.</p>
    {models.length > 0 && <div className="model-list">{models.map((model) => <code key={model}>{model}</code>)}</div>}
  </section>;
}

function RuntimePanel({ execution, now }: { execution: Execution; now: number }) {
  const activity = execution.node_type === "script";
  const herdr = execution.herdr_observation;
  const state = herdr?.state ?? execution.observed_herdr_state ?? "unobserved";
  const warning = runtimeWarning(execution, now);
  const title = herdr?.terminal_title_stripped ?? herdr?.terminal_title;
  return <section className="side-card runtime-panel">
    <div className="section-heading"><div><span>{activity ? "Deterministic activity" : "Herdr runtime"}</span><h2>{activity ? humanize(execution.node_id ?? execution.node_type ?? "activity") : herdr?.display_name ?? execution.provider}</h2></div><StatusPill value={activity ? "running" : state} /></div>
    {title && <p className="activity-title">{title}</p>}
    {execution.interrupt_request && <div className="attention-banner"><strong>Interrupt requested</strong><span>Waiting for {activity ? "the running script" : "Herdr"} to stop before {execution.interrupt_request.terminal_status ? `marking the ticket ${execution.interrupt_request.terminal_status}` : `restarting at ${humanize(execution.interrupt_request.target_phase)}`}.</span></div>}
    {warning && <div className="attention-banner"><strong>Attention</strong><span>{warning}</span></div>}
    <div className="metric-grid">
      <div><span>Running</span><strong>{duration(now - Date.parse(execution.claimed_at))}</strong></div>
      <div><span>State for</span><strong>{herdr ? duration(now - Date.parse(herdr.state_changed_at)) : "—"}</strong></div>
      <div><span>Heartbeat</span><strong>{timeAgo(execution.last_heartbeat_at, now)}</strong></div>
      <div><span>Lease left</span><strong>{duration(Date.parse(execution.lease_expires_at) - now)}</strong></div>
    </div>
    <dl className="details-list">
      <DetailRow label="Supervisor">{execution.supervisor_id}</DetailRow>
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
      <aside className="prompt-list" aria-label="Prompt templates">{creatingName && <button className="active artifact-draft"><strong>{activeTitle}</strong><small>{creatingName}.md · unsaved</small></button>}{prompts.map((prompt) => <button className={!creatingName && prompt.name === selected.name ? "active" : ""} key={prompt.name} onClick={() => { setCreatingName(null); setSelectedName(prompt.name); }}><strong>{prompt.title}</strong><small>{prompt.name}.md</small>{!prompt.valid && <em>Invalid</em>}</button>)}</aside>
      <section className="prompt-editor-card">
        <div className="prompt-heading"><div><span>{activeName}.md</span><h2>{activeTitle}</h2><p>{creatingName ? "New reusable workflow-node instructions." : selected.purpose}</p></div>{creatingName ? <span className="prompt-validity draft">Draft</span> : <span className={`prompt-validity ${selected.valid ? "valid" : "invalid"}`}>{selected.valid ? "Valid" : "Needs repair"}</span>}</div>
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
const GRAPH_NODE_HEIGHT = 112;
const GRAPH_COLUMN_GAP = 92;

type WorkflowRoute = WorkflowNode["outcomes"][number];

function nodeRoutes(node: WorkflowNode): WorkflowRoute[] {
  if (node.type === "agent") return node.outcomes;
  if (node.type === "human_gate") return node.choices;
  if (node.type === "script") return node.exit_codes;
  if (node.type === "read") return node.metadata_cases ?? [];
  if (node.type === "workflow") return node.status_codes ?? [];
  if (node.type === "fan_out") return node.branches ?? [];
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
    ...(node.fan_in === from ? { fan_in: to } : {}),
    ...(node.otherwise === from ? { otherwise: to } : {}),
    ...(node.github_watch?.feedback_target === from ? { github_watch: { ...node.github_watch, feedback_target: to } } : {}),
  };
}

function WorkflowGraph({ workflow, currentNode, selectedNode, onSelect }: {
  workflow: WorkflowDocument["definition"]; currentNode?: string; selectedNode?: string; onSelect?: (nodeId: string) => void;
}) {
  const markerId = useId().replaceAll(":", "");
  const columns = Math.min(3, Math.max(1, workflow.nodes.length));
  const rows = Math.ceil(workflow.nodes.length / columns);
  const positions = new Map(workflow.nodes.map((node, index) => [node.id, {
    x: 34 + (index % columns) * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP), y: 55 + Math.floor(index / columns) * 190, index,
    row: Math.floor(index / columns), column: index % columns,
  }]));
  const edges = workflow.nodes.flatMap((node) => [
    ...nodeRoutes(node).map((route) => ({ source: node.id, outcome: route.label, target: route.target })),
    ...(node.otherwise ? [{ source: node.id, outcome: "Otherwise", target: node.otherwise }] : []),
    ...(workflow.stages.find((stage) => stage.id === node.stage)?.skippable && workflow.stages.find((stage) => stage.id === node.stage)?.bypass_to
      ? [{ source: node.id, outcome: "Stage disabled", target: workflow.stages.find((stage) => stage.id === node.stage)!.bypass_to! }] : []),
    ...(node.github_watch?.feedback_target ? [{ source: node.id, outcome: "GitHub feedback", target: node.github_watch.feedback_target }] : []),
  ]);
  const backward = edges.filter((edge) => (positions.get(edge.target)?.index ?? Number.MAX_SAFE_INTEGER) <= (positions.get(edge.source)?.index ?? -1));
  const width = Math.max(760, 68 + columns * GRAPH_NODE_WIDTH + Math.max(0, columns - 1) * GRAPH_COLUMN_GAP);
  const loopBase = 55 + rows * 190 - 35;
  const height = loopBase + Math.max(1, backward.length) * 34 + 26;
  return <div className="factory-graph-scroll" aria-label="Workflow graph">
    <div className="factory-graph" style={{ width, height }}>
      <svg className="factory-connectors" width={width} height={height} aria-hidden="true">
        <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
        {edges.map((edge) => {
          const source = positions.get(edge.source); const target = positions.get(edge.target);
          if (!source || !target) return null;
          const isBackward = target.index <= source.index;
          const loopIndex = isBackward ? backward.findIndex((item) => item === edge) : -1;
          const isJump = !isBackward && source.row === target.row && target.index > source.index + 1;
          const changesRow = !isBackward && source.row !== target.row;
          const loopY = loopBase + loopIndex * 34;
          const jumpY = Math.max(18, source.y - 24 - (target.index - source.index - 2) * 13);
          const path = isBackward
            ? `M ${source.x + GRAPH_NODE_WIDTH / 2} ${source.y + GRAPH_NODE_HEIGHT} C ${source.x + GRAPH_NODE_WIDTH / 2} ${loopY}, ${target.x + GRAPH_NODE_WIDTH / 2} ${loopY}, ${target.x + GRAPH_NODE_WIDTH / 2} ${target.y + GRAPH_NODE_HEIGHT}`
            : isJump
              ? `M ${source.x + GRAPH_NODE_WIDTH / 2} ${source.y} C ${source.x + GRAPH_NODE_WIDTH / 2} ${jumpY}, ${target.x + GRAPH_NODE_WIDTH / 2} ${jumpY}, ${target.x + GRAPH_NODE_WIDTH / 2} ${target.y}`
              : changesRow
                ? `M ${source.x + GRAPH_NODE_WIDTH / 2} ${source.y + GRAPH_NODE_HEIGHT} C ${source.x + GRAPH_NODE_WIDTH / 2} ${source.y + GRAPH_NODE_HEIGHT + 46}, ${target.x + GRAPH_NODE_WIDTH / 2} ${target.y - 46}, ${target.x + GRAPH_NODE_WIDTH / 2} ${target.y}`
                : `M ${source.x + GRAPH_NODE_WIDTH} ${source.y + GRAPH_NODE_HEIGHT / 2} C ${source.x + GRAPH_NODE_WIDTH + 36} ${source.y + GRAPH_NODE_HEIGHT / 2}, ${target.x - 36} ${target.y + GRAPH_NODE_HEIGHT / 2}, ${target.x} ${target.y + GRAPH_NODE_HEIGHT / 2}`;
          const labelX = isBackward || isJump || changesRow ? (source.x + target.x + GRAPH_NODE_WIDTH) / 2 : (source.x + GRAPH_NODE_WIDTH + target.x) / 2;
          const labelY = isBackward ? loopY - 3 : isJump ? jumpY - 3 : changesRow ? (source.y + GRAPH_NODE_HEIGHT + target.y) / 2 : source.y + GRAPH_NODE_HEIGHT / 2 - 10;
          return <g key={`${edge.source}:${edge.outcome}`} className={isBackward ? "factory-connector loop" : "factory-connector"}>
            <path d={path} markerEnd={`url(#${markerId})`} />
            <text x={labelX} y={labelY} textAnchor="middle">{humanize(edge.outcome)}</text>
          </g>;
        })}
      </svg>
      {workflow.nodes.map((node) => {
        const position = positions.get(node.id)!;
        return <button type="button" key={node.id} style={{ left: position.x, top: position.y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }} onClick={() => onSelect?.(node.id)} aria-pressed={selectedNode === node.id} className={`factory-node node-kind-${node.type} ${currentNode === node.id ? "current" : ""} ${selectedNode === node.id ? "selected" : ""}`}>
          <header><span>{humanize(node.type)}</span>{currentNode === node.id && <em>Current</em>}</header>
          <strong>{node.name}</strong><code>{node.id}</code>
          <small>{humanize(node.stage)}{node.when ? ` · when ${humanize(node.when.input)}` : ""}</small>
          {node.prompt && <p>Prompt: <b>{node.prompt}.md</b></p>}
          {node.script_file && <p>Script: <b>{node.script_file.path ?? `ticket:${node.script_file.path_input}`}</b></p>}
          {node.inline && <p>Inline: <b>{humanize(node.inline.language)}</b></p>}
          {node.github_watch && <p>GitHub feedback: <b>{humanize(node.github_watch.feedback_outcome ?? node.github_watch.feedback_target ?? "configured")}</b></p>}
        </button>;
      })}
    </div>
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
    if (node.when && !inputIds.includes(node.when.input) && !["spec_required", "review_required"].includes(node.when.input)) errors.push(`${node.name} references a missing input.`);
    if (node.when && !node.otherwise) errors.push(`${node.name} needs an otherwise target.`);
    if (node.when && node.otherwise === node.id) errors.push(`${node.name} must bypass to another node.`);
    if (node.max_visits !== undefined && (!Number.isInteger(node.max_visits) || node.max_visits < 1 || node.max_visits > 100)) errors.push(`${node.name} maximum visits must be between 1 and 100.`);
    for (const target of [...nodeRoutes(node).map((route) => route.target), ...(node.otherwise ? [node.otherwise] : [])]) if (!ids.includes(target)) errors.push(`${node.name} points to missing node ${target}.`);
    if (node.type === "agent" && (!node.prompt || (!node.provider && !node.agent_profile) || !node.conversation_key)) errors.push(`${node.name} needs a prompt, agent profile, and conversation key.`);
    if (node.type === "agent" && node.outcomes.length === 0) errors.push(`${node.name} needs at least one declared outcome.`);
    if (node.type === "agent" && (node.provider || node.agent_profile) && node.conversation_key) {
      const selector = node.agent_profile ? `profile:${node.agent_profile}` : node.provider!;
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

function newWorkflowDefinition(id = "new-workflow"): WorkflowDocument["definition"] {
  return {
    version: 2, id, name: "New workflow", description: "A reusable software-delivery workflow.", start: "work", max_transitions: 40,
    inputs: [], stages: [
      { id: "work", name: "Work", phase: "implementation", skippable: false, default_enabled: true },
      { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
    ],
    nodes: [
      { id: "work", name: "Work", type: "agent", phase: "implementation", stage: "work", prompt: "implementation", provider: "work", conversation_key: "work", max_visits: 10, outcomes: [{ id: "completed", label: "Work completed", description: "The work is finished and verified.", target: "done", metric_class: "success" }], choices: [], exit_codes: [] },
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
    if (type === "agent") Object.assign(replacement, { prompt: "implementation", agent_profile: "default", conversation_key: "work", outcomes: [{ id: "completed", label: "Work completed", description: "The assigned work is finished.", target, metric_class: "success" }] });
    if (type === "script") Object.assign(replacement, { repository: "primary", script_file: { path: ".agents/actions/run.sh", relative_to: "selected_repository" }, working_directory: { path: ".", relative_to: "selected_repository" }, script_output: { persist_stdout: true, prompt_tail_lines: 20 }, exit_codes: [{ id: "success", label: "Success", description: "Exited with code 0.", target, metric_class: "success", codes: [0] }, { id: "failure", label: "Failure", description: "Any other exit code or execution error.", target: node.id, metric_class: "failure", default: true }] });
    if (type === "human_gate") Object.assign(replacement, { choices: [{ id: "approved", label: "Approve", description: "Continue the workflow.", target, metric_class: "success" }, { id: "changes_requested", label: "Request changes", description: "Return for another iteration.", target: node.id, metric_class: "failure", comment_required: true }] });
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
      const { action: _action, script_file: _scriptFile, ...rest } = item;
      return { ...rest, inline: item.inline ?? { language: "shell", code: defaultInlineCode("shell") } };
    }
    const { inline: _inline, action: _action, ...rest } = item;
    return { ...rest, script_file: item.script_file ?? { path: ".agents/actions/run.sh", relative_to: "selected_repository" } };
  }) });
  const routes = nodeRoutes(node);
  const replaceRoutes = (next: WorkflowRoute[]) => {
    if (node.type === "agent") patchNode({ outcomes: next });
    if (node.type === "human_gate") patchNode({ choices: next.map((route, index) => ({ ...route, ...(node.choices[index]?.comment_required ? { comment_required: true } : {}) })) });
    if (node.type === "script") patchNode({ exit_codes: next.map((route, index) => ({ ...node.exit_codes[index], ...route })) });
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
    if (node.type === "script") patchNode({ exit_codes: [...node.exit_codes, { id: `exit_${node.exit_codes.length + 1}`, label: "Additional exit", description: "", target, metric_class: "neutral", codes: [1] }] });
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
      <label><span>Type</span><select aria-label="Node type" value={node.type} onChange={(event) => changeType(event.target.value as WorkflowNode["type"])}><option value="agent">Agent</option><option value="script">Script</option><option value="human_gate">Human gate</option><option value="read">Read metadata</option><option value="write">Write metadata</option><option value="workflow">Workflow</option><option value="fan_out">Fan out</option><option value="fan_in">Fan in</option><option value="terminal">Terminal</option></select></label>
      <label><span>Stage</span><select aria-label="Node stage" value={node.stage} onChange={(event) => { const stage = workflow.stages.find((item) => item.id === event.target.value); patchNode({ stage: event.target.value, ...(stage ? { phase: stage.phase } : {}) }); }}>{workflow.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
      {node.type !== "terminal" && <><label><span>Run condition</span><select aria-label="Node condition" value={node.when?.input ?? ""} onChange={(event) => {
        if (event.target.value) patchNode({ when: { input: event.target.value, equals: workflow.inputs.find((input) => input.id === event.target.value)?.default ?? true }, otherwise: node.otherwise ?? workflow.nodes.find((item) => item.id !== node.id)?.id ?? node.id });
        else onChange({ ...workflow, nodes: workflow.nodes.map((item) => { if (item.id !== node.id) return item; const copy = { ...item }; delete copy.when; delete copy.otherwise; return copy; }) });
      }}><option value="">Always run</option>{workflow.inputs.map((input) => <option key={input.id} value={input.id}>{input.label}</option>)}</select></label>{node.when && <><label><span>Required value</span>{conditionInput?.type === "select" ? <select aria-label="Condition value" value={String(node.when.equals)} onChange={(event) => patchNode({ when: { ...node.when!, equals: event.target.value } })}>{conditionInput.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : conditionInput?.type === "text" ? <input aria-label="Condition value" value={String(node.when.equals)} onChange={(event) => patchNode({ when: { ...node.when!, equals: event.target.value } })} /> : <select aria-label="Condition value" value={String(node.when.equals)} onChange={(event) => patchNode({ when: { ...node.when!, equals: event.target.value === "true" } })}><option value="true">Enabled</option><option value="false">Disabled</option></select>}</label><label><span>Otherwise go to</span><select aria-label="Condition bypass target" value={node.otherwise} onChange={(event) => patchNode({ otherwise: event.target.value })}>{workflow.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}</>}
      {node.type !== "terminal" && <label><span>Maximum visits</span><input aria-label="Maximum visits" type="number" min="1" value={node.max_visits ?? 10} onChange={(event) => patchNode({ max_visits: Number(event.target.value) })} /></label>}
      {node.type === "agent" && <><label><span>Prompt</span><select aria-label="Node prompt" value={node.prompt ?? ""} onChange={(event) => patchNode({ prompt: event.target.value })}>{prompts.filter((prompt) => prompt.valid && !["assignment", "guidance", "callback-reminder"].includes(prompt.name)).map((prompt) => <option key={prompt.name} value={prompt.name}>{prompt.title}</option>)}</select></label><label><span>Agent profile</span><select aria-label="Node agent profile" value={node.agent_profile ?? `legacy:${node.provider ?? "work"}`} onChange={(event) => onChange({ ...workflow, nodes: workflow.nodes.map((item) => { if (item.id !== node.id) return item; const copy = { ...item }; if (event.target.value.startsWith("legacy:")) { delete copy.agent_profile; copy.provider = event.target.value.slice(7) as NonNullable<WorkflowNode["provider"]>; } else { delete copy.provider; copy.agent_profile = event.target.value; } return copy; }) })}><option value="default">Default alias</option>{agentProfiles?.profiles.filter((profile) => profile.id !== "default").map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.provider}/{profile.model}/{profile.reasoning}</option>)}<option value="legacy:work">Legacy ticket work agent</option><option value="legacy:review">Legacy opposite reviewer</option></select></label><label><span>Conversation key</span><input aria-label="Conversation key" value={node.conversation_key ?? "work"} onChange={(event) => patchNode({ conversation_key: event.target.value })} /></label></>}
      {node.type === "agent" && <><label><span>Required PR</span><select aria-label="Pull request requirement" value={node.pull_request_requirement?.scope ?? "none"} onChange={(event) => event.target.value === "none" ? clearNodeKey("pull_request_requirement") : patchNode({ pull_request_requirement: { scope: event.target.value as "any" | "primary", phase: node.phase as "specification" | "implementation" | "review" } })}><option value="none">No PR required</option><option value="any">Any repository</option><option value="primary">Primary repository</option></select></label>{node.pull_request_requirement && <label><span>PR phase</span><select aria-label="Required pull request phase" value={node.pull_request_requirement.phase} onChange={(event) => patchNode({ pull_request_requirement: { ...node.pull_request_requirement!, phase: event.target.value as "specification" | "implementation" | "review" } })}><option value="specification">Specification</option><option value="implementation">Implementation</option><option value="review">Review</option></select></label>}</>}
      {node.type === "human_gate" && <><label className="toggle"><input aria-label="Watch GitHub feedback" type="checkbox" checked={Boolean(node.github_watch)} onChange={(event) => event.target.checked ? patchNode({ github_watch: { pull_request_phase: node.phase === "done" ? "all" : node.phase, feedback_outcome: node.choices.find((choice) => choice.id === "changes_requested")?.id ?? node.choices[0]?.id ?? "" } }) : clearNodeKey("github_watch")} /><span><strong>Watch GitHub feedback</strong><small>New human PR feedback follows a declared gate choice.</small></span></label>{node.github_watch && <><label><span>PR phase</span><select aria-label="GitHub PR phase" value={node.github_watch.pull_request_phase} onChange={(event) => patchNode({ github_watch: { ...node.github_watch!, pull_request_phase: event.target.value as NonNullable<WorkflowNode["github_watch"]>["pull_request_phase"] } })}><option value="specification">Specification PRs</option><option value="implementation">Implementation PRs</option><option value="review">Review PRs</option><option value="all">All ticket PRs</option></select></label><label><span>Feedback follows</span><select aria-label="GitHub feedback outcome" value={node.github_watch.feedback_outcome ?? ""} onChange={(event) => patchNode({ github_watch: { ...node.github_watch!, feedback_outcome: event.target.value } })}>{node.choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label></>}</>}
      {node.type === "script" && <><label><span>Repository context</span><input aria-label="Script repository" value={node.repository ?? "primary"} onChange={(event) => patchNode({ repository: event.target.value })} /></label><label><span>Activity source</span><select aria-label="Activity source" value={node.inline ? "inline" : "file"} onChange={(event) => setActivitySource(event.target.value as "file" | "inline")}><option value="file">Script file</option><option value="inline">Inline code</option></select></label>{node.inline ? <><label><span>Language</span><select aria-label="Inline language" value={node.inline.language} onChange={(event) => {
        const language = event.target.value as WorkflowInlineLanguage;
        patchNode({ inline: { language, code: !node.inline!.code.trim() || isDefaultInlineCode(node.inline!.code) ? defaultInlineCode(language) : node.inline!.code } });
      }}><option value="shell">Shell</option><option value="python">Python</option><option value="javascript">JavaScript</option></select></label><label className="inline-code-field"><span>Inline code</span><textarea aria-label="Inline code" spellCheck={false} value={node.inline.code} onChange={(event) => patchNode({ inline: { ...node.inline!, code: event.target.value } })} /></label><p className="field-warning">Trusted configuration: this code runs with the supervisor process credentials from the configured working directory.</p></> : <><label><span>Script path source</span><select aria-label="Script path source" value={node.script_file?.path_input ? "input" : "path"} onChange={(event) => setPathSource("script_file", event.target.value as "path" | "input")}><option value="path">Workflow path</option><option value="input">Ticket input</option></select></label><label><span>Script path base</span><select aria-label="Script path base" value={node.script_file?.relative_to ?? "selected_repository"} onChange={(event) => patchPathReference("script_file", { relative_to: event.target.value as NonNullable<WorkflowNode["script_file"]>["relative_to"] })}><option value="selected_repository">Selected repository</option><option value="primary_repository">Primary repository</option><option value="project_root">Supervisor project root</option></select></label>{node.script_file?.path_input !== undefined ? <label><span>Ticket input</span><select aria-label="Script path input" value={node.script_file.path_input} onChange={(event) => patchPathReference("script_file", { path_input: event.target.value })}><option value="">Choose an input</option>{workflow.inputs.filter((input) => input.type !== "boolean").map((input) => <option key={input.id} value={input.id}>{input.label}</option>)}</select></label> : <label><span>Relative script path</span><input aria-label="Script path" value={node.script_file?.path ?? ""} onChange={(event) => patchPathReference("script_file", { path: event.target.value })} /></label>}</>}<label><span>Working-directory source</span><select aria-label="Working directory source" value={node.working_directory?.path_input ? "input" : "path"} onChange={(event) => setPathSource("working_directory", event.target.value as "path" | "input")}><option value="path">Workflow path</option><option value="input">Ticket input</option></select></label><label><span>Working-directory base</span><select aria-label="Working directory base" value={node.working_directory?.relative_to ?? "selected_repository"} onChange={(event) => patchPathReference("working_directory", { relative_to: event.target.value as NonNullable<WorkflowNode["working_directory"]>["relative_to"] })}><option value="selected_repository">Selected repository</option><option value="primary_repository">Primary repository</option><option value="project_root">Supervisor project root</option></select></label>{node.working_directory?.path_input !== undefined ? <label><span>Ticket input</span><select aria-label="Working directory input" value={node.working_directory.path_input} onChange={(event) => patchPathReference("working_directory", { path_input: event.target.value })}><option value="">Choose an input</option>{workflow.inputs.filter((input) => input.type !== "boolean").map((input) => <option key={input.id} value={input.id}>{input.label}</option>)}</select></label> : <label><span>Relative working directory</span><input aria-label="Working directory path" value={node.working_directory?.path ?? "."} onChange={(event) => patchPathReference("working_directory", { path: event.target.value })} /></label>}<p className="field-warning">Resolution preview: {node.inline ? "inline program" : `${humanize(node.script_file?.relative_to ?? "selected_repository")} / ${node.script_file?.path ?? `ticket input ${node.script_file?.path_input ?? "not selected"}`}`} runs from {humanize(node.working_directory?.relative_to ?? "selected_repository")} / {node.working_directory?.path ?? `ticket input ${node.working_directory?.path_input ?? "not selected"}`}. Paths are contained beneath their selected base.</p><p className="field-warning">Scripts receive the resolved script path and working directory, selected and primary repository paths, branches, SHAs, PRs, ticket repositories, and workflow context through AGENTIC_* variables. Script files also receive matching CLI flags.</p></>}
      {node.type === "script" && <><label className="toggle"><input aria-label="Persist script stdout" type="checkbox" checked={node.script_output?.persist_stdout !== false} onChange={(event) => patchNode({ script_output: { persist_stdout: event.target.checked, prompt_tail_lines: node.script_output?.prompt_tail_lines ?? 0 } })} /><span><strong>Persist stdout log</strong><small>The next agent receives a tracker URL.</small></span></label><label><span>Pass last lines to next prompt</span><input aria-label="Script prompt tail lines" type="number" min="0" max="500" value={node.script_output?.prompt_tail_lines ?? 0} onChange={(event) => patchNode({ script_output: { persist_stdout: node.script_output?.persist_stdout !== false, prompt_tail_lines: Number(event.target.value) } })} /></label></>}
      {node.type === "read" && <label><span>Metadata key</span><input aria-label="Read metadata key" value={node.metadata_key ?? ""} onChange={(event) => patchNode({ metadata_key: event.target.value })} /></label>}
      {node.type === "write" && <><label><span>Metadata key</span><input aria-label="Write metadata key" value={node.metadata_key ?? ""} onChange={(event) => patchNode({ metadata_key: event.target.value })} /></label><label><span>JSON value</span><input aria-label="Write metadata value" value={JSON.stringify(node.metadata_value ?? null)} onChange={(event) => { try { patchNode({ metadata_value: JSON.parse(event.target.value) }); } catch { /* retain the last valid JSON value */ } }} /></label><label><span>Next node</span><select aria-label="Write next node" value={node.next ?? ""} onChange={(event) => patchNode({ next: event.target.value })}>{workflow.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}
      {node.type === "workflow" && <label><span>Child workflow</span><select aria-label="Child workflow" value={node.workflow_id ?? ""} onChange={(event) => patchNode({ workflow_id: event.target.value })}>{workflows?.filter((item) => item.definition.id !== workflow.id).map((item) => <option key={item.definition.id} value={item.definition.id}>{item.definition.name}</option>)}</select></label>}
      {node.type === "fan_out" && <label><span>Join at</span><select aria-label="Fan in node" value={node.fan_in ?? ""} onChange={(event) => patchNode({ fan_in: event.target.value })}>{workflow.nodes.filter((item) => item.type === "fan_in").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {node.type === "fan_in" && <label><span>Next node</span><select aria-label="Fan in next node" value={node.next ?? ""} onChange={(event) => patchNode({ next: event.target.value })}>{workflow.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {node.type === "terminal" && <label><span>Terminal status</span><select aria-label="Terminal status" value={node.terminal_status ?? "completed"} onChange={(event) => patchNode({ terminal_status: event.target.value as NonNullable<WorkflowNode["terminal_status"]> })}><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label>}
      {node.type === "terminal" && <label><span>Return status code</span><input aria-label="Terminal status code" type="number" min="0" max="255" value={node.status_code ?? (node.terminal_status === "completed" ? 0 : 1)} onChange={(event) => patchNode({ status_code: Number(event.target.value) })} /></label>}
      {node.type === "terminal" && node.terminal_status === "completed" && <><label className="toggle"><input aria-label="Watch completed PR feedback" type="checkbox" checked={Boolean(node.github_watch)} onChange={(event) => event.target.checked ? patchNode({ github_watch: { pull_request_phase: "all", feedback_target: workflow.nodes.find((item) => item.type === "agent")?.id ?? workflow.start } }) : clearNodeKey("github_watch")} /><span><strong>Watch completed PR feedback</strong><small>New feedback follows an explicit workflow target.</small></span></label>{node.github_watch && <><label><span>PR phase</span><select aria-label="Completed GitHub PR phase" value={node.github_watch.pull_request_phase} onChange={(event) => patchNode({ github_watch: { ...node.github_watch!, pull_request_phase: event.target.value as NonNullable<WorkflowNode["github_watch"]>["pull_request_phase"] } })}><option value="specification">Specification PRs</option><option value="implementation">Implementation PRs</option><option value="review">Review PRs</option><option value="all">All ticket PRs</option></select></label><label><span>Feedback target</span><select aria-label="Completed GitHub feedback target" value={node.github_watch.feedback_target ?? ""} onChange={(event) => patchNode({ github_watch: { ...node.github_watch!, feedback_target: event.target.value } })}>{workflow.nodes.filter((item) => item.type !== "terminal").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}</>}
    </div>
    {(["agent", "script", "human_gate", "read", "workflow", "fan_out"] as const).includes(node.type as never) && <section className="outcome-editor"><div><span>{node.type === "human_gate" ? "Choices shown to the human" : node.type === "script" ? "Exit-code routes" : node.type === "read" ? "Metadata cases" : node.type === "workflow" ? "Child status-code routes" : node.type === "fan_out" ? "Branches" : "Agent outcomes"}</span><button type="button" onClick={addRoute}>＋ Add</button></div>{routes.map((route, index) => <div className="typed-outcome-row" key={`${route.id}:${index}`}>
      <label><span>Label</span><input aria-label={`Outcome ${index + 1} label`} value={route.label} onChange={(event) => patchRoute(index, { label: event.target.value, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></label>
      <label><span>ID</span><input aria-label={`Outcome ${index + 1} id`} value={route.id} onChange={(event) => patchRoute(index, { id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></label>
      {node.type === "script" && <label><span>Exit codes</span><input aria-label={`Outcome ${index + 1} exit codes`} disabled={node.exit_codes[index]?.default === true} value={node.exit_codes[index]?.default ? "All other / error" : (node.exit_codes[index]?.codes ?? []).join(", ")} onChange={(event) => patchNode({ exit_codes: node.exit_codes.map((item, candidate) => candidate === index ? { ...item, codes: event.target.value.split(",").map((value) => Number(value.trim())).filter(Number.isInteger) } : item) })} /></label>}
      {node.type === "workflow" && <label><span>Status codes</span><input aria-label={`Outcome ${index + 1} status codes`} disabled={node.status_codes?.[index]?.default === true} value={node.status_codes?.[index]?.default ? "All other" : (node.status_codes?.[index]?.codes ?? []).join(", ")} onChange={(event) => patchNode({ status_codes: (node.status_codes ?? []).map((item, candidate) => candidate === index ? { ...item, codes: event.target.value.split(",").map((value) => Number(value.trim())).filter(Number.isInteger) } : item) })} /></label>}
      {node.type === "read" && <label><span>Equals JSON</span><input aria-label={`Outcome ${index + 1} metadata value`} disabled={node.metadata_cases?.[index]?.default === true} value={node.metadata_cases?.[index]?.default ? "Any other / missing" : JSON.stringify(node.metadata_cases?.[index]?.equals ?? null)} onChange={(event) => { try { patchNode({ metadata_cases: (node.metadata_cases ?? []).map((item, candidate) => candidate === index ? { ...item, equals: JSON.parse(event.target.value) } : item) }); } catch { /* retain last valid JSON */ } }} /></label>}
      <label><span>Next node</span><select aria-label={`Outcome ${index + 1} target`} value={route.target} onChange={(event) => patchRoute(index, { target: event.target.value })}>{workflow.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>Metrics</span><select aria-label={`Outcome ${index + 1} metric class`} value={route.metric_class ?? "unclassified"} onChange={(event) => setRouteMetricClass(index, event.target.value)}><option value="success">Success</option><option value="failure">Failure</option><option value="neutral">Neutral</option><option value="unclassified">Unclassified</option></select></label>
      <label className="route-description"><span>Description</span><input aria-label={`Outcome ${index + 1} description`} value={route.description} onChange={(event) => patchRoute(index, { description: event.target.value })} /></label>
      {node.type === "human_gate" && <label className="toggle"><input type="checkbox" checked={node.choices[index]?.comment_required === true} onChange={(event) => patchNode({ choices: node.choices.map((item, candidate) => candidate === index ? { ...item, comment_required: event.target.checked } : item) })} /><span><strong>Require comment</strong></span></label>}
      {node.type === "script" && <label className="toggle"><input type="checkbox" checked={node.exit_codes[index]?.default === true} onChange={(event) => patchNode({ exit_codes: node.exit_codes.map((item, candidate) => {
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

function WorkflowEditorPage({ workflows, prompts, agentProfiles, onChanged, onError }: {
  workflows: WorkflowDocument[]; prompts: PromptDocument[]; agentProfiles: TrackerConfig["agent_profiles"] | undefined; onChanged: (workflows: WorkflowDocument[]) => void; onError: (message: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState("standard-delivery");
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState<"new" | "clone" | null>(null);
  const [returnId, setReturnId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = workflows.find((workflow) => workflow.definition.id === selectedId) ?? workflows[0];
  useEffect(() => { if (selected && !creating) { setDraft(editableWorkflowContent(selected)); setSelectedNodeId(selected.definition.start); } }, [selected?.revision, creating]);
  let preview: WorkflowDocument["definition"] | null = null;
  let parseError: string | null = null;
  try {
    const parsed = parse(draft) as WorkflowDocument["definition"];
    if (parsed && Array.isArray(parsed.nodes)) preview = parsed;
    else parseError = "Workflow YAML must contain a nodes list.";
  } catch (error) { parseError = (error as Error).message; }
  const errors = [...(parseError ? [parseError] : []), ...workflowErrors(preview)];
  const setDefinition = (definition: WorkflowDocument["definition"], nextSelectedNode = selectedNodeId ?? definition.start) => { setDraft(stringify(definition, { lineWidth: 0 })); setSelectedNodeId(nextSelectedNode); };
  const beginNew = () => { const definition = newWorkflowDefinition(); setReturnId(selected?.definition.id ?? null); setCreating("new"); setSelectedId(definition.id); setDefinition(definition, definition.start); onError(null); };
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
    if (type === "agent") Object.assign(node, { prompt: "implementation", agent_profile: "default", conversation_key: "work", outcomes: [{ id: "completed", label: "Work completed", description: "The assigned work is finished.", target, metric_class: "success" }] });
    if (type === "script") Object.assign(node, { repository: "primary", script_file: { path: ".agents/actions/run.sh", relative_to: "selected_repository" }, working_directory: { path: ".", relative_to: "selected_repository" }, script_output: { persist_stdout: true, prompt_tail_lines: 20 }, exit_codes: [{ id: "success", label: "Success", description: "Exited with code 0.", target, metric_class: "success", codes: [0] }, { id: "failure", label: "Failure", description: "All other exit codes and execution errors.", target: id, metric_class: "failure", default: true }] });
    if (type === "human_gate") Object.assign(node, { choices: [{ id: "approved", label: "Approve", description: "Continue the workflow.", target, metric_class: "success" }, { id: "changes-requested", label: "Request changes", description: "Return for another iteration.", target: id, metric_class: "failure", comment_required: true }] });
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
  const save = async () => {
    setBusy(true); onError(null);
    try {
      const result = creating ? await api.createWorkflow(draft) : await api.updateWorkflow(selected!, draft);
      const next = [...workflows.filter((workflow) => workflow.definition.id !== result.workflow.definition.id), result.workflow]
        .sort((a, b) => a.definition.name.localeCompare(b.definition.name));
      onChanged(next); setSelectedId(result.workflow.definition.id); setCreating(null); setReturnId(null); setDraft(result.workflow.content); setSelectedNodeId(result.workflow.definition.start);
    } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  if (!selected && !creating) return <main className="configuration-page"><div className="empty-health"><h2>Workflow library unavailable</h2></div></main>;
  const selectedNode = preview?.nodes.find((node) => node.id === selectedNodeId) ?? preview?.nodes[0];
  return <main className="workflow-page">
    <div className="health-heading"><div><span>Software factory</span><h1>Workflow editor</h1><p>Build a directed graph of durable boundaries while agents remain autonomous inside agent nodes.</p></div><div className="artifact-actions"><button className="button-secondary" disabled={busy || !selected} onClick={clone}>Clone workflow</button><button className="button-primary" disabled={busy} onClick={beginNew}>New workflow</button></div></div>
    <div className="workflow-editor-layout">
      <aside className="prompt-list">{creating && preview && <button className="active artifact-draft"><strong>{preview.name}</strong><small>{preview.id}.yaml · unsaved</small></button>}{workflows.map((workflow) => <button className={!creating && workflow.definition.id === selected?.definition.id ? "active" : ""} key={workflow.definition.id} onClick={() => { setCreating(null); setSelectedId(workflow.definition.id); }}><strong>{workflow.definition.name}</strong><small>{workflow.definition.id}.yaml</small>{!workflow.valid && <em>Invalid</em>}</button>)}</aside>
      <section className="workflow-editor-main">
        <div className="prompt-heading"><div><span>{creating ? `${creating === "clone" ? "Cloned" : "New"} artifact` : `${selected?.definition.id}.yaml`}</span><h2>{preview?.name ?? "Workflow draft"}</h2><p>{preview?.description}</p></div>{selected && !creating && <code>{selected.revision.slice(0, 12)}</code>}</div>
        {preview && <section className="workflow-settings" aria-label="Workflow settings"><label><span>Workflow ID</span><input aria-label="Workflow ID" disabled={!creating} value={preview.id} onChange={(event) => { const id = event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); setSelectedId(id); setDefinition({ ...preview, id }); }} /></label><label><span>Name</span><input aria-label="Workflow name" value={preview.name} onChange={(event) => setDefinition({ ...preview, name: event.target.value })} /></label><label className="wide"><span>Description</span><input aria-label="Workflow description" value={preview.description} onChange={(event) => setDefinition({ ...preview, description: event.target.value })} /></label><label><span>Start node</span><select aria-label="Workflow start node" value={preview.start} onChange={(event) => setDefinition({ ...preview, start: event.target.value })}>{preview.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><label><span>Transition limit</span><input aria-label="Workflow transition limit" type="number" min="1" value={preview.max_transitions} onChange={(event) => setDefinition({ ...preview, max_transitions: Number(event.target.value) })} /></label></section>}
        {preview && <WorkflowContractEditor workflow={preview} onChange={setDefinition} />}
        <div className="workflow-toolbar"><div><strong>Add node</strong>{(["agent", "script", "human_gate", "read", "write", "workflow", "fan_out", "fan_in", "terminal"] as const).map((type) => <button type="button" key={type} onClick={() => addNode(type)}>＋ {humanize(type)}</button>)}</div><span>Select a node to edit its behavior and outcomes.</span></div>
        {preview && <div className="workflow-builder"><WorkflowGraph workflow={preview} {...(selectedNode ? { selectedNode: selectedNode.id } : {})} onSelect={setSelectedNodeId} />{selectedNode && <WorkflowNodeInspector workflow={preview} node={selectedNode} prompts={prompts} agentProfiles={agentProfiles} workflows={workflows} onChange={setDefinition} onDelete={deleteNode} />}</div>}
        {errors.length > 0 && <div className="draft-validation" role="alert"><strong>Workflow draft needs attention</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
        <details className="workflow-source" open={!preview}><summary>Advanced YAML source</summary><p>The structured editor and this source stay synchronized. Published revisions remain immutable for pinned tickets.</p><textarea aria-label="Workflow YAML" value={draft} onChange={(event) => setDraft(event.target.value)} /></details>
        <div className="prompt-actions"><span>{preview?.nodes.length ?? 0} nodes · {preview?.nodes.filter((node) => node.prompt).length ?? 0} prompt reference(s)</span>{creating && <button className="button-secondary" onClick={cancelCreate}>Cancel</button>}<button className="button-primary" disabled={busy || !draft.trim() || errors.length > 0 || (!creating && draft === selected?.content)} onClick={() => void save()}>{creating ? "Create workflow" : "Publish revision"}</button></div>
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

function MetricsPage({ onError }: { onError: (message: string | null) => void }) {
  const [report, setReport] = useState<MetricsReport | null>(null);
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
  const toggleLabel = (label: string) => setFilters((current) => ({ ...current, labels: current.labels.includes(label) ? current.labels.filter((item) => item !== label) : [...current.labels, label] }));
  return <main className="metrics-page">
    <div className="health-heading"><div><span>Operational intelligence</span><h1>Factory metrics</h1><p>Execution reliability, branch behavior, production outcomes, cost, tokens, and elapsed time from durable ticket history.</p></div><div className="health-summary"><strong>{loading ? "…" : report?.totals.tickets ?? 0}</strong><span>filtered tickets</span></div></div>
    <section className="metrics-filters">
      <label>From<input aria-label="Metrics from date" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
      <label>To<input aria-label="Metrics to date" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
      <label>Workflow<select aria-label="Metrics workflow" value={filters.workflowId} onChange={(event) => setFilters({ ...filters, workflowId: event.target.value, workflowRevision: "" })}><option value="">All workflows</option>{[...new Set(report?.available.workflows.map((item) => item.id) ?? [])].map((id) => <option key={id} value={id}>{humanize(id)}</option>)}</select></label>
      <label>Revision<select aria-label="Metrics workflow revision" disabled={!filters.workflowId} value={filters.workflowRevision} onChange={(event) => setFilters({ ...filters, workflowRevision: event.target.value })}><option value="">All revisions</option>{report?.available.workflows.filter((item) => item.id === filters.workflowId).map((item) => <option key={item.revision} value={item.revision}>{item.revision.slice(0, 12)}</option>)}</select></label>
      <label>Production<select aria-label="Metrics production result" value={filters.productionResult} onChange={(event) => setFilters({ ...filters, productionResult: event.target.value })}><option value="">All outcomes</option><option value="unassessed">Unassessed</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="rolled_back">Rolled back</option><option value="not_deployed">Not deployed</option></select></label>
      <label>Label matching<select aria-label="Metrics label matching" value={filters.labelMode} onChange={(event) => setFilters({ ...filters, labelMode: event.target.value as "any" | "all" })}><option value="any">Any selected label</option><option value="all">All selected labels</option></select></label>
      <div className="metrics-label-filter"><span>Labels</span><div>{report?.available.labels.map((label) => <button className={filters.labels.includes(label) ? "active" : ""} key={label} onClick={() => toggleLabel(label)}>{label}</button>)}{!report?.available.labels.length && <small>No labels recorded</small>}</div></div>
      <button className="button-secondary" disabled={!filters.from && !filters.to && !filters.labels.length && !filters.workflowId && !filters.productionResult} onClick={() => setFilters({ from: "", to: "", labels: [], labelMode: "any", workflowId: "", workflowRevision: "", productionResult: "" })}>Clear filters</button>
    </section>
    {report && <>
      <section className="metrics-kpis">
        <div><span>Total tickets</span><strong>{report.totals.tickets}</strong><small>{report.totals.completed} completed · {report.totals.archived} archived</small></div>
        <div><span>Total tokens</span><strong>{report.coverage.token_runs ? tokenCount(report.totals.total_tokens) : "Unavailable"}</strong><small>{report.coverage.token_runs}/{report.coverage.agent_runs} agent runs covered</small></div>
        <div><span>Known cost</span><strong>{report.coverage.cost_runs ? usd(report.totals.known_cost_usd) : "Unavailable"}</strong><small>{report.coverage.cost_runs}/{report.coverage.agent_runs} runs · {report.coverage.estimated_cost_runs} estimated</small></div>
        <div><span>Active runtime</span><strong>{duration(report.totals.active_ms)}</strong><small>{duration(report.totals.quota_paused_ms)} quota paused</small></div>
        <div><span>Production success</span><strong>{report.totals.production_success_rate === null ? "—" : `${(report.totals.production_success_rate * 100).toFixed(1)}%`}</strong><small>{report.totals.production.succeeded} succeeded · {report.totals.production.failed + report.totals.production.rolled_back} failed/rolled back</small></div>
      </section>
      <p className="metrics-coverage">Cost and token totals include only observed values. Per-ticket summaries require complete coverage for every completed agent run: {report.coverage.complete_cost_tickets} tickets have complete cost and {report.coverage.complete_token_tickets} have complete token coverage. Unknown subscription cost is never treated as zero.</p>
      <section className="five-number-grid">
        <FiveNumberCard title="Ticket duration" summary={report.summaries.ticket_duration_ms} kind="duration" />
        <FiveNumberCard title="Active time / ticket" summary={report.summaries.active_time_ms} kind="duration" />
        <FiveNumberCard title="Human wait / ticket" summary={report.summaries.human_wait_ms} kind="duration" />
        <FiveNumberCard title="Quota pause / ticket" summary={report.summaries.quota_pause_ms} kind="duration" />
        <FiveNumberCard title="Tokens / ticket" summary={report.summaries.tokens_per_ticket} kind="tokens" />
        <FiveNumberCard title="Cost / ticket" summary={report.summaries.cost_per_ticket_usd} kind="cost" />
      </section>
      <section className="production-metrics content-card"><div className="section-heading"><div><span>Deployment evidence</span><h2>Production outcomes</h2></div><small>{report.totals.production_assessed}/{report.totals.tickets} assessed</small></div><div>{Object.entries(report.totals.production).map(([result, count]) => <div key={result}><span>{humanize(result)}</span><strong>{count}</strong><progress max={Math.max(1, report.totals.tickets)} value={count} /></div>)}</div></section>
      <section className="workflow-metrics"><div className="section-heading"><div><span>Workflow reliability</span><h2>Nodes and branches</h2></div><small>Grouped by immutable workflow revision</small></div>
        {report.workflows.map((workflow) => <details key={`${workflow.workflow_id}@${workflow.workflow_revision}`} open={report.workflows.length === 1}><summary><strong>{humanize(workflow.workflow_id)}</strong><code>{workflow.workflow_revision.slice(0, 12)}</code><span>{workflow.ticket_count} tickets · {workflow.nodes.reduce((sum, node) => sum + node.runs, 0)} runs</span></summary><div className="node-metrics-grid">{workflow.nodes.map((node) => <article key={node.node_id} className="node-metric-card">
          <header><div><span>{humanize(node.node_type)}</span><h3>{node.node_name}</h3></div><strong>{node.success_rate === null ? "—" : `${(node.success_rate * 100).toFixed(0)}%`}</strong></header>
          <p>{node.classifications.success} success · {node.classifications.failure} failure · {node.classifications.neutral} neutral · {node.classifications.unclassified} unclassified</p>
          <div className="reliability-bar"><i style={{ width: `${node.success_rate === null ? 0 : node.success_rate * 100}%` }} /></div>
          <dl><div><dt>Runs</dt><dd>{node.runs}</dd></div><div><dt>Median</dt><dd>{formatMetric(node.wall_ms.median, "duration")}</dd></div><div><dt>Tokens</dt><dd>{node.telemetry_coverage.token_runs ? tokenCount(node.total_tokens) : "—"}</dd></div><div><dt>Cost</dt><dd>{node.telemetry_coverage.cost_runs ? usd(node.known_cost_usd) : "—"}</dd></div></dl>
          {(node.interrupted > 0 || node.lease_lost > 0 || node.bypassed > 0) && <small>{node.interrupted} interrupted · {node.lease_lost} lease lost · {node.bypassed} bypassed</small>}
          {node.branches.length > 0 && <div className="branch-metrics"><strong>Branches taken</strong>{node.branches.map((branch) => <div key={branch.outcome}><span><i className={`metric-${branch.metric_class}`} />{branch.label}{branch.target ? ` → ${humanize(branch.target)}` : ""}</span><b>{branch.count} · {(branch.rate * 100).toFixed(0)}%</b></div>)}</div>}
        </article>)}</div></details>)}
        {!report.workflows.length && <div className="empty-health"><h2>No workflow runs match these filters</h2></div>}
      </section>
      {report.profiles.length > 0 && <section className="profile-metrics content-card"><div className="section-heading"><div><span>Agent runtime</span><h2>Resolved profiles</h2></div></div><div>{report.profiles.map((profile) => <article key={`${profile.alias}/${profile.provider}/${profile.model}/${profile.reasoning}`}><div><strong>{profile.alias}</strong><small>{[profile.provider, profile.model, profile.reasoning].filter(Boolean).join(" · ")}</small></div><span>{profile.runs} runs</span><span>{profile.success_rate === null ? "—" : `${(profile.success_rate * 100).toFixed(0)}% success`}</span><span>{profile.token_runs ? tokenCount(profile.total_tokens) : "Tokens unavailable"}</span><span>{profile.cost_runs ? usd(profile.known_cost_usd) : "Cost unavailable"}</span></article>)}</div></section>}
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

export function App() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [runtime, setRuntime] = useState<RuntimeAgent[]>([]);
  const [supervisors, setSupervisors] = useState<SupervisorHealth[]>([]);
  const [config, setConfig] = useState<TrackerConfig | null>(null);
  const [prompts, setPrompts] = useState<PromptDocument[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDocument[]>([]);
  const [view, setView] = useState<"tickets" | "metrics" | "supervisors" | "configuration" | "prompts" | "workflows">("tickets");
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TicketDraft>(emptyDraft);
  const [rawDraft, setRawDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<null | { kind: "comment" | "guidance"; text: string }>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [descriptionEdit, setDescriptionEdit] = useState<null | { text: string; targetPhase: "specification" | "implementation" | "review" }>(null);
  const [now, setNow] = useState(Date.now());
  const [includeArchived, setIncludeArchived] = useState(false);
  const [queueOrder, setQueueOrder] = useState<"priority" | "workflow">("priority");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("agentic-project-tracker.theme", theme); } catch { /* storage may be disabled */ }
  }, [theme]);

  const refresh = useCallback(async () => {
    const [list, live, health, configured, promptLibrary, workflowLibrary] = await Promise.all([api.list(includeArchived), api.runtime(), api.supervisors(), api.config(), api.prompts(), api.workflows().catch(() => ({ workflows: [] }))]);
    setTickets(list.tickets); setRuntime(live.agents); setSupervisors(health.supervisors); setConfig(configured.config); setPrompts(promptLibrary.prompts); setWorkflows(workflowLibrary.workflows);
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
    const timer = window.setInterval(() => void Promise.all([api.supervisors(), api.config()]).then(([health, configured]) => {
      setSupervisors(health.supervisors);
      setConfig(configured.config);
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
  };

  const run = async (work: () => Promise<TicketDetail>): Promise<boolean> => {
    setBusy(true); setError(null);
    try {
      const next = await work(); setSelected(next); setDraft(draftFromTicket(next)); setRawDraft(next.markdown);
      setDirty(false); setComposer(null); await refresh(); return true;
    } catch (caught) { setError((caught as Error).message); return false; }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (creating) {
      const created = await run(() => api.create(ticketMarkdown(draft), draft.autoId, draft.workflowId, draft.workflowInputs, draft.stageEnabled));
      if (created) setCreating(false);
      return;
    }
    if (!selected) return;
    await run(() => api.edit(selected, selected.valid ? ticketMarkdown(draft, selected) : rawDraft, "keep_phase"));
  };

  const submitComposer = async () => {
    if (!selected || !composer?.text.trim()) return;
    await run(() => api.action(selected, composer.kind, { message: composer.text.trim() }));
  };

  const saveLiveDescription = async (restart = false) => {
    if (!selected?.frontmatter || !descriptionEdit?.text.trim()) return;
    const nextDraft = { ...draftFromTicket(selected), description: descriptionEdit.text.trim() };
    if (restart && descriptionEdit.targetPhase === "specification") nextDraft.specRequired = true;
    if (restart && descriptionEdit.targetPhase === "review") nextDraft.reviewRequired = true;
    const saved = await run(async () => {
      if (restart && selected.frontmatter?.workflow && selected.workflow_definition) {
        const edited = await api.edit(selected, ticketMarkdown(nextDraft, selected), "keep_phase");
        const target = selected.workflow_definition.nodes.find((node) => node.type === "agent" && node.phase === descriptionEdit.targetPhase);
        if (!target) throw new Error(`The pinned workflow has no ${descriptionEdit.targetPhase} agent node.`);
        return api.action(edited, "workflow/migrate", { workflow_id: selected.frontmatter.workflow.id, node_id: target.id });
      }
      return api.edit(selected, ticketMarkdown(nextDraft, selected), restart ? "rewind" : "keep_phase", restart ? descriptionEdit.targetPhase : undefined);
    });
    if (saved) setDescriptionEdit(null);
  };

  const moveToPhase = async (action: "rewind" | "reopen") => {
    if (!selected) return;
    if (selected.frontmatter?.workflow && selected.workflow_definition) {
      const choices = selected.workflow_definition.nodes.map((node) => node.id).join(", ");
      const nodeId = window.prompt(`${action === "reopen" ? "Reopen" : "Restart"} at workflow node (${choices}):`, selected.workflow_definition.start);
      if (nodeId) await run(() => api.action(selected, "workflow/migrate", { workflow_id: selected.frontmatter!.workflow!.id, node_id: nodeId }));
      return;
    }
    const phase = window.prompt(`${action === "reopen" ? "Reopen" : "Rewind"} phase: specification, implementation, or review`, "implementation");
    if (phase) await run(() => api.action(selected, action, { phase }));
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

  const specFeedback = async () => {
    if (!selected) return; const text = window.prompt("Requested specification changes:");
    if (text) await run(() => api.action(selected, "request-specification-changes", { message: text }));
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

  const saveConfig = async (update: Pick<TrackerConfig, "providers" | "agent_profiles" | "repositories" | "jira" | "github">) => {
    if (!config) return;
    setBusy(true); setError(null);
    try { const updated = await api.updateConfig(config, update); setConfig(updated.config); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  const beginLocalTicket = async () => {
    setError(null);
    try {
      const next = await api.nextId();
      setView("tickets"); setCreating(true); setSelected(null); setDraft(emptyDraft(next.id, true, config?.providers?.enabled ?? ALL_WORK_PROVIDERS)); setDirty(false);
    } catch (caught) { setError((caught as Error).message); }
  };

  const beginJiraTicket = async () => {
    const key = window.prompt("Jira issue key:");
    if (!key) return;
    setBusy(true); setError(null);
    try {
      const imported = (await api.jiraImport(key.trim())).draft;
      setView("tickets"); setCreating(true); setSelected(null);
      setDraft({ ...emptyDraft(imported.id, false, config?.providers?.enabled ?? ALL_WORK_PROVIDERS), id: imported.id, title: imported.title, description: `# Goal\n\n${imported.description}`, labels: imported.labels.join(", "), jira: imported.jira });
      setDirty(false);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  const grouped = useMemo(() => {
    const ranked = [...tickets].sort((left, right) => right.priority - left.priority || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    if (queueOrder === "priority") return new Map([["Priority order", ranked]]);
    const groups = new Map<string, TicketSummary[]>();
    for (const ticket of ranked) {
      const key = `${ticket.workflow_stage_name ?? ticket.phase} / ${ticket.status}`;
      groups.set(key, [...(groups.get(key) ?? []), ticket]);
    }
    return groups;
  }, [tickets, queueOrder]);

  const frontmatter = selected?.frontmatter;
  const selectedWorkflow = selected?.workflow_definition ?? (frontmatter?.workflow ? workflows.find((workflow) => workflow.definition.id === frontmatter.workflow?.id)?.definition : undefined);
  const currentWorkflowNode = frontmatter?.workflow ? selectedWorkflow?.nodes.find((node) => node.id === frontmatter.workflow?.current_node) : undefined;
  const currentWorkflowStage = currentWorkflowNode ? selectedWorkflow?.stages.find((stage) => stage.id === currentWorkflowNode.stage) : undefined;
  const currentProvider = frontmatter ? frontmatter.execution?.provider ?? resolvedWorkflowProvider(frontmatter, currentWorkflowNode) : null;
  const selectedSummary = selected ? tickets.find((ticket) => ticket.id === selected.id) : null;
  const activeAttempt = frontmatter && currentWorkflowNode && frontmatter.workflow
    ? frontmatter.workflow.node_attempts?.[frontmatter.workflow.active_workflow_id && frontmatter.workflow.active_workflow_id !== frontmatter.workflow.id ? `${frontmatter.workflow.active_workflow_id}/${currentWorkflowNode.id}` : currentWorkflowNode.id] ?? null
    : frontmatter && frontmatter.phase !== "done" ? frontmatter.attempts[frontmatter.phase] : null;
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">{theme === "retro" ? ">_" : "A"}</div><div><span>Agentic operations</span><strong>Project Tracker</strong></div></div><nav className="topnav"><button className={view === "tickets" ? "active" : ""} onClick={() => setView("tickets")}>Tickets</button><button className={view === "metrics" ? "active" : ""} onClick={() => setView("metrics")}>Metrics</button><button className={view === "supervisors" ? "active" : ""} onClick={() => setView("supervisors")}>Supervisor health <span>{supervisors.filter((item) => item.status === "online").length}</span></button><button className={view === "workflows" ? "active" : ""} onClick={() => setView("workflows")}>Workflows</button><button className={view === "prompts" ? "active" : ""} onClick={() => setView("prompts")}>Prompts</button><button className={view === "configuration" ? "active" : ""} onClick={() => setView("configuration")}>Configuration</button></nav><ThemeSelector theme={theme} onChange={setTheme} />{config?.jira?.enabled && <button className="button-secondary" disabled={busy} onClick={() => void beginJiraTicket()}>Import Jira</button>}<button className="button-primary" onClick={() => void beginLocalTicket()}>＋ New ticket</button></header>
    {view === "tickets" && <AgentFleet agents={runtime} now={now} onOpen={(id) => void open(id)} />}
    {error && <div className="error" role="alert"><strong>Something needs attention</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    {view === "metrics" ? <MetricsPage onError={setError} /> : view === "workflows" ? <WorkflowEditorPage workflows={workflows} prompts={prompts} agentProfiles={config?.agent_profiles} onChanged={setWorkflows} onError={setError} /> : view === "prompts" ? <PromptEditorPage prompts={prompts} onUpdated={(prompt) => setPrompts((current) => [...current.filter((item) => item.name !== prompt.name), prompt])} onError={setError} /> : view === "configuration" ? <ConfigurationPage config={config} busy={busy} onSave={(update) => void saveConfig(update)} /> : view === "supervisors" ? <SupervisorHealthPage supervisors={supervisors} now={now} onOpenTicket={(id) => void open(id)} /> : <main className="dashboard-layout">
      <aside className="ticket-queue"><div className="queue-title"><div><span>Work queue</span><strong>{tickets.length} tickets</strong></div><div className="queue-controls"><select aria-label="Queue order" value={queueOrder} onChange={(event) => setQueueOrder(event.target.value as "priority" | "workflow")}><option value="priority">Priority</option><option value="workflow">Workflow</option></select><label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Archived</label></div></div>
        {[...grouped.entries()].map(([group, items]) => <section key={group} className="queue-group">
          <h2>{humanize(group)}<span>{items.length}</span></h2>
          {items.map((ticket) => <button key={ticket.id} className={`ticket-card ${selected?.id === ticket.id ? "active" : ""}`} onClick={() => void open(ticket.id)}>
            <div className="ticket-card-top"><span>{ticket.id}</span><StatusPill value={ticket.status} subtle /></div>
            <strong>{ticket.title}</strong><small>{ticket.workflow_node_name ? `${ticket.workflow_stage_name ?? "Workflow"} · ${ticket.workflow_node_name} · ${ticket.provider ? `${humanize(ticket.provider)} agent` : "No agent claim"}` : `${humanize(ticket.work_provider)} work · ${ticket.review_required ? `${humanize(ticket.review_provider)} review` : "Review skipped"}`} · P{ticket.priority}</small>
            {(ticket.claim_blockers ?? []).map((blocker) => <em className="claim-blocker" key={`${blocker.hostname}:${blocker.ticket_id}`}>{blocker.repositories.join(", ")} busy on {blocker.hostname} · {blocker.ticket_id}</em>)}
            {!ticket.valid && <em>{ticket.errors[0]}</em>}
          </button>)}
        </section>)}
        {tickets.length === 0 && <p className="queue-empty">No tickets yet. Create the first piece of work.</p>}
      </aside>
      <section className="ticket-workspace">
        {creating ? <TicketEditor draft={draft} setDraft={(value) => { setDirty(true); setDraft(value); }} existing={false} busy={busy} repositories={config?.repositories ?? []} workflows={workflows} enabledWorkProviders={config?.providers?.enabled ?? ALL_WORK_PROVIDERS} onSave={() => void save()} onCancel={() => setCreating(false)} /> : selected ? !selected.valid ? <div className="invalid-editor">
          <div className="issue-heading"><div><span className="issue-key">Recovery editor</span><h1>{selected.relative_path}</h1><p>Repair the invalid Markdown before this ticket can be scheduled.</p></div></div>
          <ul className="validation">{selected.errors.map((item) => <li key={item}>{item}</li>)}</ul>
          <textarea aria-label="Raw ticket Markdown" value={rawDraft} onChange={(event) => { setRawDraft(event.target.value); setDirty(true); }} />
          <div className="sticky-actions"><button className="button-primary" disabled={busy} onClick={() => void save()}>Save repaired ticket</button></div>
        </div> : frontmatter?.status === "pending" ? <TicketEditor draft={draft} setDraft={(value) => { setDirty(true); setDraft(value); }} existing busy={busy} repositories={config?.repositories ?? []} workflows={workflows} enabledWorkProviders={config?.providers?.enabled ?? ALL_WORK_PROVIDERS} onSave={() => void save()} onCancel={() => { setDraft(draftFromTicket(selected)); setDirty(false); }} onCustomizeWorkflow={() => void run(() => api.action(selected, "workflow/clone"))} onMigrateWorkflow={() => void migrateWorkflow()} onReady={() => void run(() => api.action(selected, "ready"))} readyDisabled={dirty} /> : frontmatter ? <div className="issue-page">
          <div className="issue-heading"><div><span className="issue-key">{frontmatter.id} · {selected.relative_path}</span><h1>{frontmatter.title}</h1><div className="issue-chips"><StatusPill value={frontmatter.status} />{frontmatter.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}</div></div>
            <div className="issue-actions">
              <ActionButton onClick={() => setComposer({ kind: "comment", text: "" })}>Add comment</ActionButton>
              <ActionButton primary onClick={() => setComposer({ kind: "guidance", text: "" })}>Guide agent</ActionButton>
            </div>
          </div>
          <WorkflowMap ticket={frontmatter} workflow={selectedWorkflow} />
          <RepositoryBlockers blockers={selectedSummary?.claim_blockers ?? []} />
          {composer && <section className="composer"><div><strong>{composer.kind === "guidance" ? "Guide the active or next agent" : "Add an operator comment"}</strong><small>{composer.kind === "guidance" ? "Guidance is persisted before delivery." : "Comments are added to the durable timeline."}</small></div><textarea autoFocus aria-label={composer.kind === "guidance" ? "Agent guidance" : "Ticket comment"} value={composer.text} onChange={(event) => setComposer({ ...composer, text: event.target.value })} /><div><button className="button-secondary" onClick={() => setComposer(null)}>Cancel</button><button className="button-primary" disabled={busy || !composer.text.trim()} onClick={() => void submitComposer()}>Send</button></div></section>}
          <div className="issue-grid">
            <div className="issue-main">
              <section className="content-card description-card">
                <div className="section-heading"><div><span>Work ticket</span><h2>Description</h2></div>{!descriptionEdit && <button className="button-secondary button-compact" onClick={() => setDescriptionEdit({ text: descriptionFromBody(selected.body), targetPhase: frontmatter.phase === "done" ? "implementation" : frontmatter.phase as "specification" | "implementation" | "review" })}>Edit description</button>}</div>
                {descriptionEdit ? <div className="live-description-editor">
                  <textarea aria-label="Live ticket description" value={descriptionEdit.text} onChange={(event) => setDescriptionEdit({ ...descriptionEdit, text: event.target.value })} />
                  <div className="restart-choice">
                    <label>Restart phase<select aria-label="Restart phase" value={descriptionEdit.targetPhase} onChange={(event) => setDescriptionEdit({ ...descriptionEdit, targetPhase: event.target.value as "specification" | "implementation" | "review" })}>
                      <option value="specification">{frontmatter.spec_required ? "Specification" : "Enable specification"}</option>
                      <option value="implementation">Implementation</option>
                      <option value="review">{frontmatter.review_required ? "Review" : "Enable review"}</option>
                    </select></label>
                    <p>{frontmatter.execution ? "Restarting first interrupts and fences the active agent." : "Restarting makes the selected phase ready for its next agent."}</p>
                  </div>
                  <div className="live-edit-actions"><button className="button-secondary" onClick={() => setDescriptionEdit(null)}>Cancel</button><button className="button-secondary" disabled={busy || !descriptionEdit.text.trim() || Boolean(frontmatter.execution?.interrupt_request)} onClick={() => void saveLiveDescription(false)}>Save and continue</button><button className="button-primary" disabled={busy || !descriptionEdit.text.trim() || Boolean(frontmatter.execution?.interrupt_request)} onClick={() => void saveLiveDescription(true)}>Save and restart</button></div>
                </div> : <MarkdownContent markdown={descriptionFromBody(selected.body)} />}
              </section>
              <Timeline body={selected.body} />
            </div>
            <aside className="issue-sidebar">
              {frontmatter.execution && <RuntimePanel execution={frontmatter.execution} now={now} />}
              <TicketUsage ticket={frontmatter} now={now} />
              {frontmatter.phase === "done" && frontmatter.status === "completed" && <ProductionAssessment ticket={frontmatter} busy={busy} onSave={(production_result, production_assessment_note) => void run(() => api.action(selected, "production-assessment", { production_result, production_assessment_note }))} onArchive={(production_result, production_assessment_note) => void run(() => api.action(selected, "archive", { production_result, production_assessment_note }))} />}
              <section className="side-card"><div className="section-heading"><div><span>Ticket</span><h2>Details</h2></div></div><dl className="details-list">
                {currentWorkflowNode ? <><DetailRow label="Workflow node">{currentWorkflowNode.name}</DetailRow><DetailRow label="Stage">{currentWorkflowStage?.name ?? humanize(currentWorkflowNode.stage)}</DetailRow><DetailRow label="Node type">{humanize(currentWorkflowNode.type)}</DetailRow><DetailRow label="Assigned agent">{currentProvider ? humanize(currentProvider) : "Not an agent node"}</DetailRow></> : <><DetailRow label="Phase">{humanize(frontmatter.phase)}</DetailRow><DetailRow label="Work agent">{humanize(frontmatter.work_provider)}</DetailRow><DetailRow label="Review agent">{frontmatter.review_required ? humanize(frontmatter.review_provider) : "Skipped"}</DetailRow></>}
                <DetailRow label="Priority"><PriorityEditor value={frontmatter.priority} busy={busy} onSave={(priority) => void run(() => api.action(selected, "priority", { priority }))} /></DetailRow><DetailRow label="Updated">{timeAgo(frontmatter.updated_at, now)}</DetailRow>
                <DetailRow label="Supervisor">{frontmatter.assigned_supervisor ?? "Unassigned"}</DetailRow>
                <DetailRow label="Supervisor host">{frontmatter.assigned_supervisor_host ?? "Unassigned"}</DetailRow>
                {!currentWorkflowNode && <><DetailRow label="Specification">{frontmatter.spec_required ? "Required" : "Skipped"}</DetailRow><DetailRow label="Review">{frontmatter.review_required ? humanize(frontmatter.review_provider) : "Skipped"}</DetailRow></>}
                {frontmatter.jira && <DetailRow label="Jira"><a href={frontmatter.jira.url} target="_blank" rel="noreferrer">{frontmatter.jira.key} ↗</a></DetailRow>}
                {frontmatter.archived_at && <DetailRow label="Archived">{timeAgo(frontmatter.archived_at, now)}</DetailRow>}
                {activeAttempt && <DetailRow label="Attempts">{activeAttempt.total} total · {activeAttempt.consecutive_lease_losses} lease losses</DetailRow>}
              </dl></section>
              <section className="side-card"><div className="section-heading"><div><span>Scope</span><h2>Repositories & PRs</h2></div></div>{frontmatter.repositories.map((repository) => {
                const prs = frontmatter.pull_requests.filter((candidate) => candidate.repository === repository.id);
                return <div className="repo-item" key={repository.id}><div><strong>{repository.id}</strong>{repository.primary && <span>Primary</span>}</div>{prs.length ? <div>{prs.map((pr) => <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer">Open {pr.phase ? humanize(pr.phase) : "draft"} PR ↗</a>)}</div> : <small>No PR reported</small>}</div>;
              })}</section>
              {(frontmatter.questions ?? []).length > 0 && <section className="side-card"><div className="section-heading"><div><span>Conversation</span><h2>Questions & answers</h2></div></div>{(frontmatter.questions ?? []).map((question) => <div className="question-item" key={question.id}><strong>{question.question}</strong>{question.answer ? <p>{question.answer}</p> : <div className="question-answer"><div className="question-options">{(question.options ?? []).map((option, index) => <button className="button-secondary" key={`${index}:${option}`} onClick={() => setQuestionAnswers((current) => ({ ...current, [question.id]: option }))}>{option}</button>)}</div><textarea aria-label={`Answer: ${question.question}`} placeholder="Type any answer…" value={questionAnswers[question.id] ?? ""} onChange={(event) => setQuestionAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /><button className="button-primary" disabled={busy || !questionAnswers[question.id]?.trim()} onClick={() => void answerQuestion(question.id)}>Send answer</button></div>}</div>)}</section>}
              <AgentSessions ticket={frontmatter} {...(selectedWorkflow ? { workflow: selectedWorkflow } : {})} />
              {frontmatter.workflow && frontmatter.workflow.node_runs.length > 0 && <section className="side-card"><div className="section-heading"><div><span>Workflow audit</span><h2>Node runs</h2></div></div>{[...frontmatter.workflow.node_runs].reverse().slice(0, 12).map((nodeRun) => <div className="session-item" key={nodeRun.id}><span>{humanize(nodeRun.node_type)} · visit {nodeRun.visit}</span><strong>{selectedWorkflow?.nodes.find((node) => node.id === nodeRun.node_id)?.name ?? humanize(nodeRun.node_id)}</strong><small>{humanize(nodeRun.status)}{nodeRun.outcome ? ` · ${humanize(nodeRun.outcome)}` : ""} · attempt {nodeRun.attempt}</small><NodeTimingDetails run={nodeRun} now={now} />{nodeRun.telemetry && <TelemetryDetails telemetry={nodeRun.telemetry} compact />}{nodeRun.summary && <small className="session-context">{nodeRun.summary}</small>}{nodeRun.handoff && <small className="session-context">Handoff: {nodeRun.handoff}</small>}{nodeRun.script_path && <small className="session-context">Script: {nodeRun.script_path}</small>}{nodeRun.working_directory && <small className="session-context">Working directory: {nodeRun.working_directory}</small>}{nodeRun.output_path && <a href={`/api/tickets/${encodeURIComponent(frontmatter.id)}/runs/${encodeURIComponent(nodeRun.id)}/output`} target="_blank" rel="noreferrer">Full output ({nodeRun.output_bytes ?? 0} bytes) ↗</a>}</div>)}</section>}
              <section className="side-card action-card"><div className="section-heading"><div><span>Controls</span><h2>State actions</h2></div></div><div className="control-buttons">
                {currentWorkflowNode?.type === "human_gate" && frontmatter.status === "waiting_approval" && currentWorkflowNode.choices.map((choice, index) => <div className="gate-choice" key={choice.id}><ActionButton primary={index === 0} onClick={() => {
                  const note = choice.comment_required ? window.prompt(`${choice.label}\n\n${choice.description}\n\nA comment is required:`) : "";
                  if (choice.comment_required && note === null) return;
                  void run(() => api.action(selected, "decide", { decision: choice.id, ...(note?.trim() ? { message: note.trim() } : {}) }));
                }}>{choice.label}</ActionButton><small>{choice.description} → {selectedWorkflow?.nodes.find((node) => node.id === choice.target)?.name ?? choice.target}{choice.comment_required ? " · comment required" : ""}</small></div>)}
                {!frontmatter.workflow && frontmatter.phase === "specification" && frontmatter.status === "waiting_approval" && <><ActionButton primary onClick={() => void run(() => api.action(selected, "approve-specification"))}>Approve specification</ActionButton><ActionButton onClick={() => void specFeedback()}>Request changes</ActionButton></>}
                {frontmatter.status === "ready" && <ActionButton onClick={() => void run(() => api.action(selected, "draft"))}>Return to draft</ActionButton>}
                {(frontmatter.status === "failed" || frontmatter.status === "blocked") && <ActionButton primary onClick={() => void run(() => api.action(selected, "retry"))}>Retry phase</ActionButton>}
                {frontmatter.status === "completed" && <ActionButton onClick={() => void moveToPhase("reopen")}>Reopen ticket</ActionButton>}
                {currentWorkflowNode?.type === "human_gate" && currentWorkflowNode.github_watch && frontmatter.status === "waiting_approval" && frontmatter.pull_requests.some((pr) => currentWorkflowNode.github_watch?.pull_request_phase === "all" || pr.phase === currentWorkflowNode.github_watch?.pull_request_phase || (currentWorkflowNode.github_watch?.pull_request_phase === "specification" && !pr.phase)) && <ActionButton onClick={() => void checkPullRequests()}>Check GitHub feedback</ActionButton>}
                {!frontmatter.workflow && frontmatter.phase === "specification" && frontmatter.status === "waiting_approval" && frontmatter.pull_requests.some((pr) => !pr.phase || pr.phase === "specification") && <ActionButton onClick={() => void checkPullRequests()}>Check specification PRs</ActionButton>}
                {frontmatter.status === "completed" && !frontmatter.archived_at && frontmatter.pull_requests.length > 0 && (!frontmatter.workflow || currentWorkflowNode?.github_watch?.feedback_target) && <ActionButton onClick={() => void checkPullRequests()}>Check GitHub PRs</ActionButton>}
                {frontmatter.archived_at && <ActionButton onClick={() => void run(() => api.action(selected, "unarchive"))}>Unarchive ticket</ActionButton>}
                {config?.jira?.enabled && !frontmatter.jira && <ActionButton onClick={() => void run(() => api.action(selected, "jira/export"))}>Send to Jira</ActionButton>}
                {config?.jira?.enabled && frontmatter.jira && isInitialDraft(frontmatter) && <ActionButton onClick={() => void run(() => api.action(selected, "jira/resync"))}>Refresh from Jira</ActionButton>}
                {frontmatter.status !== "completed" && <ActionButton onClick={() => void moveToPhase("rewind")}>Rewind phase</ActionButton>}
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
