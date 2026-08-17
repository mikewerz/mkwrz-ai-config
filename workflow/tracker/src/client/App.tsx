import React, { useCallback, useEffect, useMemo, useState } from "react";
import { stringify } from "yaml";
import { api, type Execution, type PromptDocument, type RepositoryClaimBlocker, type RepositoryConfig, type RuntimeAgent, type SupervisorHealth, type TicketDetail, type TicketFrontmatter, type TicketSummary, type TrackerConfig } from "./api.js";

const LOG_START = "<!-- tracker:interaction-log:start -->";
const LOG_END = "<!-- tracker:interaction-log:end -->";
const PHASES = ["specification", "implementation", "review", "done"] as const;
const THEMES = ["light", "dark", "retro"] as const;
type Theme = (typeof THEMES)[number];
type WorkProvider = "claude" | "codex";
type ReviewProvider = "claude" | "codex";
const ALL_WORK_PROVIDERS: WorkProvider[] = ["claude", "codex"];

function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem("agentic-project-tracker.theme");
    return THEMES.includes(value as Theme) ? value as Theme : "dark";
  } catch { return "dark"; }
}

function defaultReviewProvider(workProvider: WorkProvider): ReviewProvider {
  return workProvider === "codex" ? "claude" : "codex";
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
}

const emptyDraft = (id = "AGENT-0001", autoId = true, enabledProviders: WorkProvider[] = ALL_WORK_PROVIDERS): TicketDraft => {
  const workProvider = enabledProviders.includes("claude") ? "claude" : enabledProviders[0] ?? "claude";
  return {
    id, autoId, title: "Describe the work", description: "# Goal\n\nDescribe the desired outcome.\n\n# Acceptance Criteria\n\n- Add an observable acceptance criterion.",
    specRequired: true, reviewRequired: true, workProvider, reviewProvider: defaultReviewProvider(workProvider), priority: 0, labels: "",
    repositories: [{ id: "", primary: true }], jira: null,
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
  const frontmatter = current?.frontmatter ? { ...current.frontmatter, ...editable } : editable;
  const body = current ? `${draft.description.trim()}\n\n${interactionLogSection(current.body)}` : `${draft.description.trim()}\n`;
  return `---\n${stringify(frontmatter, { lineWidth: 0, nullStr: "null" }).trimEnd()}\n---\n${body}`;
}

function humanize(value: string): string {
  return value.replaceAll(/[_./-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function WorkflowMap({ ticket }: { ticket: TicketFrontmatter }) {
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

function AgentSessions({ ticket }: { ticket: TicketFrontmatter }) {
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
      const state = agent.herdr?.state ?? "unobserved";
      const warning = runtimeWarning({ observed_herdr_state: state, last_heartbeat_at: agent.last_heartbeat_at, lease_expires_at: agent.lease_expires_at }, now);
      return <button key={agent.ticket_id} className={`fleet-agent ${warning ? "needs-attention" : ""}`} onClick={() => onOpen(agent.ticket_id)}>
        <span className={`agent-dot state-${state}`} />
        <span><strong>{agent.provider}</strong><small>{agent.ticket_id} · {humanize(agent.phase)}</small></span>
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
      <div className="supervisor-assignment"><span>Reserved ticket</span>{supervisor.assigned_ticket ? <button onClick={() => onOpenTicket(supervisor.assigned_ticket!.id)}><strong>{supervisor.assigned_ticket.id} · {supervisor.assigned_ticket.title}</strong><small>{humanize(supervisor.assigned_ticket.phase)} · {humanize(supervisor.assigned_ticket.status)}</small></button> : <p>Available for a new ticket</p>}</div>
    </article>)}</div> : <div className="empty-health"><span>◎</span><h2>No supervisors have checked in</h2><p>Start a configured supervisor and it will appear here after its first heartbeat.</p></div>}
  </main>;
}

function ConfigurationPage({ config, busy, onSave }: { config: TrackerConfig | null; busy: boolean; onSave: (update: Pick<TrackerConfig, "providers" | "repositories" | "jira" | "github">) => void }) {
  const [enabledProviders, setEnabledProviders] = useState<WorkProvider[]>(config?.providers?.enabled ?? ALL_WORK_PROVIDERS);
  const [repositories, setRepositories] = useState<RepositoryConfig[]>(config?.repositories ?? []);
  const [jira, setJira] = useState(config?.jira ?? { enabled: false, site_url: "", project_key: "", issue_type: "Task" });
  const [github, setGithub] = useState(config?.github ?? { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] });
  useEffect(() => { setEnabledProviders(config?.providers?.enabled ?? ALL_WORK_PROVIDERS); setRepositories(config?.repositories ?? []); if (config?.jira) setJira(config.jira); if (config?.github) setGithub(config.github); }, [config?.revision]);
  const errors: string[] = [];
  if (enabledProviders.length === 0) errors.push("Enable at least one work agent.");
  if (repositories.some((repository) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository.id) || repository.id === "." || repository.id === "..")) errors.push("Repository IDs must be safe directory names.");
  if (repositories.some((repository) => !repository.url.trim())) errors.push("Every repository needs a clone URL.");
  if (new Set(repositories.map((repository) => repository.id.trim())).size !== repositories.length) errors.push("Repository IDs must be unique.");
  if (new Set(repositories.map((repository) => repository.url.trim())).size !== repositories.length) errors.push("Repository URLs must be unique.");
  if (jira.enabled && !/^https:\/\/[A-Za-z0-9.-]+\.atlassian\.net\/?$/.test(jira.site_url)) errors.push("Jira site must be an atlassian.net URL.");
  if (jira.enabled && !jira.project_key.trim()) errors.push("Jira project key is required when Jira is enabled.");
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
      <div className="section-heading"><div><span>Optional integration</span><h2>Jira Cloud</h2></div></div>
      <label className="toggle"><input type="checkbox" checked={jira.enabled} onChange={(event) => setJira({ ...jira, enabled: event.target.checked })} /><span><strong>Enable Jira</strong><small>Disabled personal installs make no Jira requests.</small></span></label>
      {jira.enabled && <div className="field-row"><label>Atlassian site<input aria-label="Jira site" placeholder="https://company.atlassian.net" value={jira.site_url} onChange={(event) => setJira({ ...jira, site_url: event.target.value })} /></label><label>Project key<input aria-label="Jira project key" value={jira.project_key} onChange={(event) => setJira({ ...jira, project_key: event.target.value })} /></label><label>Issue type<input aria-label="Jira issue type" value={jira.issue_type} onChange={(event) => setJira({ ...jira, issue_type: event.target.value })} /></label></div>}
      <div className="section-heading"><div><span>Review follow-up</span><h2>GitHub PR observation</h2></div></div>
      <label className="toggle"><input type="checkbox" checked={github.observation_enabled} onChange={(event) => setGithub({ ...github, observation_enabled: event.target.checked })} /><span><strong>Check reviewable tickets periodically</strong><small>Specification feedback resumes specification; completed-work feedback returns to implementation.</small></span></label>
      <div className="field-row"><label>Interval (minutes)<input aria-label="GitHub observation interval" type="number" min="1" value={github.observation_interval_minutes} onChange={(event) => setGithub({ ...github, observation_interval_minutes: Number(event.target.value) })} /></label><label>Ignored GitHub logins<input aria-label="Ignored GitHub logins" value={github.ignored_logins.join(", ")} onChange={(event) => setGithub({ ...github, ignored_logins: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label></div>
      {errors.length > 0 && <div className="draft-validation" role="alert"><strong>Configuration needs attention</strong><ul>{errors.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      <div className="config-footer"><p>Credentials stay in environment variables: JIRA_EMAIL, JIRA_API_TOKEN, and GITHUB_TOKEN.</p><button className="button-primary" disabled={!config || busy || errors.length > 0} onClick={() => onSave({ providers: { enabled: enabledProviders }, repositories: repositories.map((repository) => ({ id: repository.id.trim(), url: repository.url.trim() })), jira: { ...jira, site_url: jira.site_url.replace(/\/$/, ""), project_key: jira.project_key.trim(), issue_type: jira.issue_type.trim() }, github })}>Save configuration</button></div>
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

function TicketEditor({ draft, setDraft, existing, busy, onSave, onCancel, onReady, readyDisabled = false, repositories, enabledWorkProviders = ALL_WORK_PROVIDERS }: {
  draft: TicketDraft; setDraft: React.Dispatch<React.SetStateAction<TicketDraft>>; existing: boolean; busy: boolean;
  onSave: () => void; onCancel: () => void; onReady?: () => void; readyDisabled?: boolean; repositories?: RepositoryConfig[]; enabledWorkProviders?: WorkProvider[];
}) {
  const validationErrors = draftErrors(draft);
  const selectableWorkProviders = existing && !enabledWorkProviders.includes(draft.workProvider)
    ? [draft.workProvider, ...enabledWorkProviders] : enabledWorkProviders;
  const update = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateWorkProvider = (workProvider: WorkProvider) => setDraft((current) => ({
    ...current, workProvider, reviewProvider: defaultReviewProvider(workProvider),
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
        <label className="toggle"><input type="checkbox" checked={draft.specRequired} onChange={(event) => update("specRequired", event.target.checked)} /><span><strong>Specification required</strong><small>Add an approval gate before implementation</small></span></label>
        <label className="toggle"><input type="checkbox" checked={draft.reviewRequired} onChange={(event) => update("reviewRequired", event.target.checked)} /><span><strong>Independent review</strong><small>Route review to the other agent</small></span></label>
      </aside>
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
    <div className="sticky-actions"><button className="button-secondary" onClick={onCancel}>Cancel</button><button className="button-secondary" disabled={busy || validationErrors.length > 0} onClick={onSave}>{existing ? "Save ticket" : "Create ticket"}</button>{existing && onReady && <button className="button-primary" title={readyDisabled ? "Save changes before marking ready" : undefined} disabled={busy || readyDisabled || validationErrors.length > 0} onClick={onReady}>Mark ready</button>}</div>
  </div>;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function RuntimePanel({ execution, now }: { execution: Execution; now: number }) {
  const herdr = execution.herdr_observation;
  const state = herdr?.state ?? execution.observed_herdr_state ?? "unobserved";
  const warning = runtimeWarning(execution, now);
  const title = herdr?.terminal_title_stripped ?? herdr?.terminal_title;
  return <section className="side-card runtime-panel">
    <div className="section-heading"><div><span>Herdr runtime</span><h2>{herdr?.display_name ?? execution.provider}</h2></div><StatusPill value={state} /></div>
    {title && <p className="activity-title">{title}</p>}
    {execution.interrupt_request && <div className="attention-banner"><strong>Interrupt requested</strong><span>Waiting for Herdr to stop this turn before restarting at {humanize(execution.interrupt_request.target_phase)}.</span></div>}
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
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewPhase, setPreviewPhase] = useState<"specification" | "implementation" | "review">("implementation");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (selected) { setDraft(selected.content); setPreview(null); } }, [selected?.name, selected?.revision]);
  if (!selected) return <main className="configuration-page"><div className="empty-health"><h2>Prompt library unavailable</h2></div></main>;
  const dirty = draft !== selected.content;
  const insertTag = (tag: string) => setDraft((current) => `${current}${current.endsWith("\n") || !current ? "" : " "}{{${tag}}}`);
  const save = async () => {
    setBusy(true); onError(null);
    try { const result = await api.updatePrompt(selected, draft); onUpdated(result.prompt); }
    catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  const renderPreview = async () => {
    setBusy(true); onError(null);
    try { setPreview((await api.previewPrompt(selected, draft, previewPhase)).rendered); }
    catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <main className="prompt-page">
    <div className="health-heading"><div><span>Agent messages</span><h1>Prompt editor</h1><p>Edit the central Markdown templates used by every supervisor.</p></div><div className="health-summary"><strong>{prompts.length}</strong><span>prompt files</span></div></div>
    <div className="prompt-layout">
      <aside className="prompt-list" aria-label="Prompt templates">{prompts.map((prompt) => <button className={prompt.name === selected.name ? "active" : ""} key={prompt.name} onClick={() => setSelectedName(prompt.name)}><strong>{prompt.title}</strong><small>{prompt.name}.md</small>{!prompt.valid && <em>Invalid</em>}</button>)}</aside>
      <section className="prompt-editor-card">
        <div className="prompt-heading"><div><span>{selected.name}.md</span><h2>{selected.title}</h2><p>{selected.purpose}</p></div><span className={`prompt-validity ${selected.valid ? "valid" : "invalid"}`}>{selected.valid ? "Valid" : "Needs repair"}</span></div>
        <section className="prompt-trigger"><span>When this runs</span><strong>{selected.trigger}</strong><div>{selected.stages.map((stage) => <small key={stage}>{stage}</small>)}</div></section>
        {!selected.valid && <div className="draft-validation" role="alert"><strong>Saved prompt is invalid</strong><ul>{selected.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
        <label className="prompt-content-label">Prompt Markdown<textarea aria-label="Prompt Markdown" value={draft} onChange={(event) => { setDraft(event.target.value); setPreview(null); }} /></label>
        <section className="prompt-tags"><div><span>Available meta tags</span><p>Click a tag to append it. Required tags cannot be removed from this template.</p></div>{selected.tags.length ? <div className="prompt-tag-grid">{selected.tags.map((tag) => <button key={tag.name} onClick={() => insertTag(tag.name)}><code>{`{{${tag.name}}}`}</code>{selected.required_tags.includes(tag.name) && <em>Required</em>}<span>{tag.description}</span><small>Example: {tag.example}</small></button>)}</div> : <p className="muted">This prompt has no meta tags.</p>}</section>
        <div className="prompt-actions">{selected.name === "assignment" && <label>Preview phase<select value={previewPhase} onChange={(event) => setPreviewPhase(event.target.value as typeof previewPhase)}><option value="specification">Specification</option><option value="implementation">Implementation</option><option value="review">Review</option></select></label>}<button className="button-secondary" disabled={busy || !draft.trim()} onClick={() => void renderPreview()}>Preview with dummy ticket</button><button className="button-primary" disabled={busy || !dirty || !draft.trim()} onClick={() => void save()}>Save prompt</button></div>
        {preview !== null && <section className="prompt-preview"><div><span>Rendered example</span><strong>{selected.name === "guidance" || selected.name === "callback-reminder" ? "Follow-up message" : "Complete assignment message"}</strong></div><pre>{preview}</pre></section>}
      </section>
    </div>
  </main>;
}

export function App() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [runtime, setRuntime] = useState<RuntimeAgent[]>([]);
  const [supervisors, setSupervisors] = useState<SupervisorHealth[]>([]);
  const [config, setConfig] = useState<TrackerConfig | null>(null);
  const [prompts, setPrompts] = useState<PromptDocument[]>([]);
  const [view, setView] = useState<"tickets" | "supervisors" | "configuration" | "prompts">("tickets");
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("agentic-project-tracker.theme", theme); } catch { /* storage may be disabled */ }
  }, [theme]);

  const refresh = useCallback(async () => {
    const [list, live, health, configured, promptLibrary] = await Promise.all([api.list(includeArchived), api.runtime(), api.supervisors(), api.config(), api.prompts()]);
    setTickets(list.tickets); setRuntime(live.agents); setSupervisors(health.supervisors); setConfig(configured.config); setPrompts(promptLibrary.prompts);
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
      const created = await run(() => api.create(ticketMarkdown(draft), draft.autoId));
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
    const saved = await run(() => api.edit(
      selected,
      ticketMarkdown(nextDraft, selected),
      restart ? "rewind" : "keep_phase",
      restart ? descriptionEdit.targetPhase : undefined,
    ));
    if (saved) setDescriptionEdit(null);
  };

  const moveToPhase = async (action: "rewind" | "reopen") => {
    if (!selected) return;
    const phase = window.prompt(`${action === "reopen" ? "Reopen" : "Rewind"} phase: specification, implementation, or review`, "implementation");
    if (phase) await run(() => api.action(selected, action, { phase }));
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

  const saveConfig = async (update: Pick<TrackerConfig, "providers" | "repositories" | "jira" | "github">) => {
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
    const groups = new Map<string, TicketSummary[]>();
    for (const ticket of tickets) {
      const key = `${ticket.phase} / ${ticket.status}`;
      groups.set(key, [...(groups.get(key) ?? []), ticket]);
    }
    return groups;
  }, [tickets]);

  const frontmatter = selected?.frontmatter;
  const selectedSummary = selected ? tickets.find((ticket) => ticket.id === selected.id) : null;
  const activeAttempt = frontmatter && frontmatter.phase !== "done" ? frontmatter.attempts[frontmatter.phase] : null;
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">{theme === "retro" ? ">_" : "A"}</div><div><span>Agentic operations</span><strong>Project Tracker</strong></div></div><nav className="topnav"><button className={view === "tickets" ? "active" : ""} onClick={() => setView("tickets")}>Tickets</button><button className={view === "supervisors" ? "active" : ""} onClick={() => setView("supervisors")}>Supervisor health <span>{supervisors.filter((item) => item.status === "online").length}</span></button><button className={view === "prompts" ? "active" : ""} onClick={() => setView("prompts")}>Prompts</button><button className={view === "configuration" ? "active" : ""} onClick={() => setView("configuration")}>Configuration</button></nav><ThemeSelector theme={theme} onChange={setTheme} />{config?.jira?.enabled && <button className="button-secondary" disabled={busy} onClick={() => void beginJiraTicket()}>Import Jira</button>}<button className="button-primary" onClick={() => void beginLocalTicket()}>＋ New ticket</button></header>
    {view === "tickets" && <AgentFleet agents={runtime} now={now} onOpen={(id) => void open(id)} />}
    {error && <div className="error" role="alert"><strong>Something needs attention</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    {view === "prompts" ? <PromptEditorPage prompts={prompts} onUpdated={(prompt) => setPrompts((current) => current.map((item) => item.name === prompt.name ? prompt : item))} onError={setError} /> : view === "configuration" ? <ConfigurationPage config={config} busy={busy} onSave={(update) => void saveConfig(update)} /> : view === "supervisors" ? <SupervisorHealthPage supervisors={supervisors} now={now} onOpenTicket={(id) => void open(id)} /> : <main className="dashboard-layout">
      <aside className="ticket-queue"><div className="queue-title"><span>Work queue</span><strong>{tickets.length} tickets</strong><label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Archived</label></div>
        {[...grouped.entries()].map(([group, items]) => <section key={group} className="queue-group">
          <h2>{humanize(group)}<span>{items.length}</span></h2>
          {items.map((ticket) => <button key={ticket.id} className={`ticket-card ${selected?.id === ticket.id ? "active" : ""}`} onClick={() => void open(ticket.id)}>
            <div className="ticket-card-top"><span>{ticket.id}</span><StatusPill value={ticket.status} subtle /></div>
            <strong>{ticket.title}</strong><small>{humanize(ticket.work_provider)} work · {ticket.review_required ? `${humanize(ticket.review_provider)} review` : "Review skipped"} · P{ticket.priority}</small>
            {(ticket.claim_blockers ?? []).map((blocker) => <em className="claim-blocker" key={`${blocker.hostname}:${blocker.ticket_id}`}>{blocker.repositories.join(", ")} busy on {blocker.hostname} · {blocker.ticket_id}</em>)}
            {!ticket.valid && <em>{ticket.errors[0]}</em>}
          </button>)}
        </section>)}
        {tickets.length === 0 && <p className="queue-empty">No tickets yet. Create the first piece of work.</p>}
      </aside>
      <section className="ticket-workspace">
        {creating ? <TicketEditor draft={draft} setDraft={(value) => { setDirty(true); setDraft(value); }} existing={false} busy={busy} repositories={config?.repositories ?? []} enabledWorkProviders={config?.providers?.enabled ?? ALL_WORK_PROVIDERS} onSave={() => void save()} onCancel={() => setCreating(false)} /> : selected ? !selected.valid ? <div className="invalid-editor">
          <div className="issue-heading"><div><span className="issue-key">Recovery editor</span><h1>{selected.relative_path}</h1><p>Repair the invalid Markdown before this ticket can be scheduled.</p></div></div>
          <ul className="validation">{selected.errors.map((item) => <li key={item}>{item}</li>)}</ul>
          <textarea aria-label="Raw ticket Markdown" value={rawDraft} onChange={(event) => { setRawDraft(event.target.value); setDirty(true); }} />
          <div className="sticky-actions"><button className="button-primary" disabled={busy} onClick={() => void save()}>Save repaired ticket</button></div>
        </div> : frontmatter?.status === "pending" ? <TicketEditor draft={draft} setDraft={(value) => { setDirty(true); setDraft(value); }} existing busy={busy} repositories={config?.repositories ?? []} enabledWorkProviders={config?.providers?.enabled ?? ALL_WORK_PROVIDERS} onSave={() => void save()} onCancel={() => { setDraft(draftFromTicket(selected)); setDirty(false); }} onReady={() => void run(() => api.action(selected, "ready"))} readyDisabled={dirty} /> : frontmatter ? <div className="issue-page">
          <div className="issue-heading"><div><span className="issue-key">{frontmatter.id} · {selected.relative_path}</span><h1>{frontmatter.title}</h1><div className="issue-chips"><StatusPill value={frontmatter.status} />{frontmatter.labels.map((label) => <span className="label-chip" key={label}>{label}</span>)}</div></div>
            <div className="issue-actions">
              <ActionButton onClick={() => setComposer({ kind: "comment", text: "" })}>Add comment</ActionButton>
              <ActionButton primary onClick={() => setComposer({ kind: "guidance", text: "" })}>Guide agent</ActionButton>
            </div>
          </div>
          <WorkflowMap ticket={frontmatter} />
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
              <section className="side-card"><div className="section-heading"><div><span>Ticket</span><h2>Details</h2></div></div><dl className="details-list">
                <DetailRow label="Phase">{humanize(frontmatter.phase)}</DetailRow><DetailRow label="Work agent">{humanize(frontmatter.work_provider)}</DetailRow><DetailRow label="Review agent">{frontmatter.review_required ? humanize(frontmatter.review_provider) : "Skipped"}</DetailRow>
                <DetailRow label="Priority">P{frontmatter.priority}</DetailRow><DetailRow label="Updated">{timeAgo(frontmatter.updated_at, now)}</DetailRow>
                <DetailRow label="Supervisor">{frontmatter.assigned_supervisor ?? "Unassigned"}</DetailRow>
                <DetailRow label="Supervisor host">{frontmatter.assigned_supervisor_host ?? "Unassigned"}</DetailRow>
                <DetailRow label="Specification">{frontmatter.spec_required ? "Required" : "Skipped"}</DetailRow><DetailRow label="Review">{frontmatter.review_required ? "Codex required" : "Skipped"}</DetailRow>
                {frontmatter.jira && <DetailRow label="Jira"><a href={frontmatter.jira.url} target="_blank" rel="noreferrer">{frontmatter.jira.key} ↗</a></DetailRow>}
                {frontmatter.archived_at && <DetailRow label="Archived">{timeAgo(frontmatter.archived_at, now)}</DetailRow>}
                {activeAttempt && <DetailRow label="Attempts">{activeAttempt.total} total · {activeAttempt.consecutive_lease_losses} lease losses</DetailRow>}
              </dl></section>
              <section className="side-card"><div className="section-heading"><div><span>Scope</span><h2>Repositories & PRs</h2></div></div>{frontmatter.repositories.map((repository) => {
                const prs = frontmatter.pull_requests.filter((candidate) => candidate.repository === repository.id);
                return <div className="repo-item" key={repository.id}><div><strong>{repository.id}</strong>{repository.primary && <span>Primary</span>}</div>{prs.length ? <div>{prs.map((pr) => <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer">Open {pr.phase ? humanize(pr.phase) : "draft"} PR ↗</a>)}</div> : <small>No PR reported</small>}</div>;
              })}</section>
              {(frontmatter.questions ?? []).length > 0 && <section className="side-card"><div className="section-heading"><div><span>Conversation</span><h2>Questions & answers</h2></div></div>{(frontmatter.questions ?? []).map((question) => <div className="question-item" key={question.id}><strong>{question.question}</strong>{question.answer ? <p>{question.answer}</p> : <div className="question-answer"><div className="question-options">{(question.options ?? []).map((option, index) => <button className="button-secondary" key={`${index}:${option}`} onClick={() => setQuestionAnswers((current) => ({ ...current, [question.id]: option }))}>{option}</button>)}</div><textarea aria-label={`Answer: ${question.question}`} placeholder="Type any answer…" value={questionAnswers[question.id] ?? ""} onChange={(event) => setQuestionAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /><button className="button-primary" disabled={busy || !questionAnswers[question.id]?.trim()} onClick={() => void answerQuestion(question.id)}>Send answer</button></div>}</div>)}</section>}
              <AgentSessions ticket={frontmatter} />
              <section className="side-card action-card"><div className="section-heading"><div><span>Controls</span><h2>State actions</h2></div></div><div className="control-buttons">
                {frontmatter.phase === "specification" && frontmatter.status === "waiting_approval" && <><ActionButton primary onClick={() => void run(() => api.action(selected, "approve-specification"))}>Approve specification</ActionButton><ActionButton onClick={() => void specFeedback()}>Request changes</ActionButton></>}
                {(frontmatter.status === "failed" || frontmatter.status === "blocked") && <ActionButton primary onClick={() => void run(() => api.action(selected, "retry"))}>Retry phase</ActionButton>}
                {frontmatter.status === "completed" && <ActionButton onClick={() => void moveToPhase("reopen")}>Reopen ticket</ActionButton>}
                {frontmatter.phase === "specification" && frontmatter.status === "waiting_approval" && frontmatter.pull_requests.some((pr) => !pr.phase || pr.phase === "specification") && <ActionButton onClick={() => void checkPullRequests()}>Check specification PRs</ActionButton>}
                {frontmatter.status === "completed" && !frontmatter.archived_at && frontmatter.pull_requests.length > 0 && <ActionButton onClick={() => void checkPullRequests()}>Check GitHub PRs</ActionButton>}
                {frontmatter.status === "completed" && !frontmatter.archived_at && <ActionButton onClick={() => void run(() => api.action(selected, "archive"))}>Archive ticket</ActionButton>}
                {frontmatter.archived_at && <ActionButton onClick={() => void run(() => api.action(selected, "unarchive"))}>Unarchive ticket</ActionButton>}
                {config?.jira?.enabled && !frontmatter.jira && <ActionButton onClick={() => void run(() => api.action(selected, "jira/export"))}>Send to Jira</ActionButton>}
                {config?.jira?.enabled && frontmatter.jira && frontmatter.status === "pending" && <ActionButton onClick={() => void run(() => api.action(selected, "jira/resync"))}>Refresh from Jira</ActionButton>}
                {frontmatter.status !== "completed" && <ActionButton onClick={() => void moveToPhase("rewind")}>Rewind phase</ActionButton>}
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
