export interface TicketSummary {
  id: string;
  title: string;
  phase: string;
  status: string;
  work_provider: "claude" | "codex";
  review_provider: "claude" | "codex";
  review_required: boolean;
  priority: number;
  provider: string | null;
  revision: number;
  valid: boolean;
  errors: string[];
  path: string;
  claim_blockers: RepositoryClaimBlocker[];
  archived_at: string | null;
  workflow_id: string | null;
  workflow_node_id: string | null;
  workflow_node_name: string | null;
  workflow_stage_name: string | null;
}

export interface RepositoryClaimBlocker {
  hostname: string;
  supervisor_id: string;
  ticket_id: string;
  ticket_title: string;
  repositories: string[];
}

export interface HerdrObservation {
  state: string;
  observed_at: string;
  state_changed_at: string;
  pane_id: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  terminal_id: string | null;
  focused: boolean | null;
  cwd: string | null;
  foreground_cwd: string | null;
  terminal_title: string | null;
  terminal_title_stripped: string | null;
  display_name: string | null;
  revision: number | null;
  session_source: string | null;
  session_kind: string | null;
  tokens: Record<string, string>;
}

export interface GuidanceItem {
  id: string;
  sequence: number;
  message: string;
  created_at: string;
  delivered_at: string | null;
}

export interface Execution {
  provider: string | null;
  phase: string;
  attempt: number;
  supervisor_id: string;
  claimed_at: string;
  last_heartbeat_at: string;
  lease_expires_at: string;
  lease_id: string;
  observed_herdr_state: string | null;
  herdr_observation: HerdrObservation | null;
  guidance: GuidanceItem[];
  interrupt_request: null | {
    target_phase: "specification" | "implementation" | "review"; requested_at: string;
    terminal_status?: "failed" | "cancelled"; terminal_reason?: string;
  };
  node_id?: string;
  node_type?: "agent" | "script";
  node_run_id?: string;
  conversation_key?: string;
}

export interface AgentRef {
  provider: string | null;
  herdr_pane_id: string | null;
  session_ref: string | null;
}

export interface TicketFrontmatter extends Record<string, unknown> {
  id: string;
  title: string;
  phase: string;
  status: string;
  spec_required: boolean;
  review_required: boolean;
  work_provider: "claude" | "codex";
  review_provider: "claude" | "codex";
  priority: number;
  labels: string[];
  repositories: Array<{ id: string; primary: boolean }>;
  assigned_supervisor: string | null;
  assigned_supervisor_host: string | null;
  pull_requests: Array<{ repository: string; url: string; phase?: string; observation?: { checked_at: string; state: string; draft: boolean; merged: boolean; mergeable: boolean | null } | null }>;
  questions: Array<{ id: string; phase: string; question: string; options: string[]; asked_at: string; answer: string | null; answered_at: string | null }>;
  jira: null | { key: string; issue_id: string; url: string; last_synced_at: string; source_updated_at: string | null };
  archived_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  execution: Execution | null;
  agents: Record<string, AgentRef>;
  attempts: Record<string, { total: number; consecutive_lease_losses: number }>;
  last_callback?: null | { lease_id: string; response: Record<string, unknown> };
  workflow?: null | {
    id: string; revision: string; current_node: string; transition_count: number;
    node_visits: Record<string, number>; node_attempts: Record<string, { total: number; consecutive_lease_losses: number }>; prompt_revisions: Record<string, string>;
    inputs: Record<string, boolean | string>; stage_enabled: Record<string, boolean>;
    incoming: null | { source_node: string; target_node: string; outcome: string; summary: string | null; handoff: string | null; actor: string; created_at: string };
    node_runs: Array<{ id: string; node_id: string; node_type: string; visit: number; attempt: number; status: string; outcome: string | null; summary: string | null; handoff?: string | null; output?: string | null; output_path?: string | null; output_sha256?: string | null; output_bytes?: number | null; started_at: string; completed_at: string | null }>;
  };
  conversations?: Record<string, AgentRef>;
}

export interface SupervisorHealth {
  supervisor_id: string;
  instance_id: string;
  hostname: string;
  ip_addresses: string[];
  project_root: string;
  herdr_session: string;
  providers: Array<"claude" | "codex">;
  activity_capabilities: Array<"repository_action" | "inline_shell" | "inline_javascript" | "inline_python">;
  started_at: string;
  last_seen_at: string;
  status: "online" | "offline";
  assigned_ticket: null | { id: string; title: string; phase: string; status: string };
}

export interface RepositoryConfig {
  id: string;
  url: string;
}

export interface TrackerConfig extends Record<string, unknown> {
  version: number;
  revision: number;
  tickets: { id_prefix: string; next_number: number };
  providers: { enabled: Array<"claude" | "codex"> };
  repositories: RepositoryConfig[];
  jira: { enabled: boolean; site_url: string; project_key: string; issue_type: string };
  github: { observation_enabled: boolean; observation_interval_minutes: number; ignored_logins: string[] };
}

export interface PromptDocument {
  name: string;
  title: string;
  purpose: string;
  trigger: string;
  stages: string[];
  allowed_tags: string[];
  required_tags: string[];
  tags: Array<{ name: string; description: string; example: string }>;
  content: string;
  revision: string;
  valid: boolean;
  errors: string[];
  workflow_references?: Array<{ workflow_id: string; workflow_name: string; node_id: string; node_name: string; outcomes: string[] }>;
}

export interface WorkflowNode {
  id: string;
  name: string;
  type: "agent" | "script" | "human_gate" | "terminal";
  phase: "specification" | "implementation" | "review" | "done";
  stage: string;
  prompt?: string;
  provider?: "work" | "review" | "claude" | "codex";
  conversation_key?: string;
  repository?: string;
  action?: string;
  inline?: { language: "shell" | "python" | "javascript"; code: string };
  github_watch?: { pull_request_phase: "specification" | "implementation" | "review" | "all"; feedback_outcome?: string; feedback_target?: string };
  pull_request_requirement?: { scope: "any" | "primary"; phase: "specification" | "implementation" | "review" };
  when?: { input: string; equals: boolean | string };
  otherwise?: string;
  max_visits?: number;
  terminal_status?: "completed" | "failed" | "cancelled";
  outcomes: Array<{ id: string; label: string; description: string; target: string }>;
  choices: Array<{ id: string; label: string; description: string; target: string; comment_required?: boolean }>;
  exit_codes: Array<{ id: string; label: string; description: string; target: string; codes?: number[]; default?: boolean }>;
}

export interface WorkflowDocument {
  definition: {
    version: 2; id: string; name: string; description: string; start: string; max_transitions: number;
    inputs: Array<{ id: string; label: string; type: "boolean" | "select"; default: boolean | string; options?: Array<{ value: string; label: string }> }>;
    stages: Array<{ id: string; name: string; phase: "specification" | "implementation" | "review" | "done"; skippable: boolean; default_enabled: boolean; bypass_to?: string }>;
    nodes: WorkflowNode[];
  };
  content: string;
  revision: string;
  valid: boolean;
  errors: string[];
  referenced_prompts: string[];
}

export interface TicketDetail {
  id: string;
  path: string;
  relative_path: string;
  markdown: string;
  body: string;
  valid: boolean;
  errors: string[];
  integration_warnings?: string[];
  frontmatter: TicketFrontmatter | null;
  workflow_definition?: WorkflowDocument["definition"];
}

export interface RuntimeAgent {
  ticket_id: string;
  title: string;
  phase: string;
  status: string;
  provider: string | null;
  attempt: number;
  claimed_at: string;
  last_heartbeat_at: string;
  lease_expires_at: string;
  consecutive_lease_losses: number;
  pane_id: string | null;
  session_ref: string | null;
  herdr: HerdrObservation | null;
  node_id?: string;
  node_type?: "agent" | "script";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; details?: unknown };
    const details = Array.isArray(body.details) && body.details.every((item) => typeof item === "string")
      ? body.details.join(" · ")
      : body.details && typeof body.details === "object" && Array.isArray((body.details as { errors?: unknown }).errors)
        ? ((body.details as { errors: unknown[] }).errors.filter((item): item is string => typeof item === "string")).join(" · ")
        : null;
    const summary = body.error ?? `Request failed: ${response.status}`;
    throw new Error(details ? `${summary}: ${details}` : summary);
  }
  return response.json() as Promise<T>;
}

export const api = {
  list: (includeArchived = false) => request<{ tickets: TicketSummary[] }>(`/api/tickets${includeArchived ? "?include_archived=true" : ""}`),
  runtime: () => request<{ agents: RuntimeAgent[] }>("/api/runtime"),
  supervisors: () => request<{ supervisors: SupervisorHealth[] }>("/api/supervisors"),
  config: () => request<{ config: TrackerConfig }>("/api/config"),
  prompts: () => request<{ prompts: PromptDocument[] }>("/api/prompts"),
  createPrompt: (name: string, content: string) => request<{ prompt: PromptDocument }>("/api/prompts", { method: "POST", body: JSON.stringify({ name, content }) }),
  workflows: () => request<{ workflows: WorkflowDocument[] }>("/api/workflows"),
  createWorkflow: (content: string) => request<{ workflow: WorkflowDocument }>("/api/workflows", { method: "POST", body: JSON.stringify({ content }) }),
  updateWorkflow: (workflow: WorkflowDocument, content: string) => request<{ workflow: WorkflowDocument }>(`/api/workflows/${encodeURIComponent(workflow.definition.id)}`, {
    method: "PUT", body: JSON.stringify({ expected_revision: workflow.revision, content }),
  }),
  updatePrompt: (prompt: PromptDocument, content: string) => request<{ prompt: PromptDocument }>(`/api/prompts/${encodeURIComponent(prompt.name)}`, {
    method: "PUT", body: JSON.stringify({ expected_revision: prompt.revision, content }),
  }),
  previewPrompt: (prompt: PromptDocument, content: string, phase: "specification" | "implementation" | "review") => request<{ rendered: string }>(`/api/prompts/${encodeURIComponent(prompt.name)}/preview`, {
    method: "POST", body: JSON.stringify({ content, phase }),
  }),
  updateConfig: (config: TrackerConfig, update: Pick<TrackerConfig, "providers" | "repositories" | "jira" | "github">) => request<{ config: TrackerConfig }>("/api/config", {
    method: "PUT", body: JSON.stringify({ expected_revision: config.revision, ...update }),
  }),
  nextId: () => request<{ id: string }>("/api/tickets/next-id"),
  get: (id: string) => request<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`),
  create: (markdown: string, autoId = true, workflowId = "standard-delivery", workflowInputs: Record<string, boolean | string> = {}, stageEnabled: Record<string, boolean> = {}) => request<TicketDetail>("/api/tickets", { method: "POST", body: JSON.stringify({ markdown, auto_id: autoId, workflow_id: workflowId, workflow_inputs: workflowInputs, stage_enabled: stageEnabled }) }),
  jiraImport: (key: string) => request<{ draft: { id: string; title: string; description: string; labels: string[]; jira: TicketFrontmatter["jira"] } }>("/api/jira/import", { method: "POST", body: JSON.stringify({ key }) }),
  checkPullRequests: (id: string) => request<{ checked: number; reopened: boolean }>(`/api/tickets/${encodeURIComponent(id)}/check-pull-requests`, { method: "POST", body: "{}" }),
  edit: (ticket: TicketDetail, markdown: string, mode: "keep_phase" | "rewind", rewindPhase?: string) => request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticket.id)}`,
    { method: "PUT", body: JSON.stringify({ markdown, expected_revision: ticket.frontmatter?.revision ?? 0, mode, rewind_phase: rewindPhase }) },
  ),
  action: (ticket: TicketDetail, action: string, body: Record<string, unknown> = {}) => request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticket.id)}/${action}`,
    { method: "POST", body: JSON.stringify({ expected_revision: ticket.frontmatter?.revision ?? 0, ...body }) },
  ),
};
