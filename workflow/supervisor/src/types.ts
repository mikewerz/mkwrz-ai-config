export type Provider = "claude" | "codex";
export type ActivityCapability = "repository_action" | "inline_shell" | "inline_javascript" | "inline_python" | "git_checkpoint" | "git_restore";
export type WorkPhase = "specification" | "implementation" | "review";

export interface RepositoryConfig {
  id: string;
  url: string;
}

export interface TrackerConfig {
  version: number;
  revision: number;
  updated_at: string;
  repositories: RepositoryConfig[];
  agent_profiles?: { default: string; profiles: Array<{ id: string; label: string; provider: Provider; model: string; reasoning: string }> };
}

export interface TrackerPrompt {
  name: string;
  content: string;
  revision: string;
  valid: boolean;
  errors: string[];
}

export interface SupervisorPresence {
  instanceId: string;
  hostname: string;
  ipAddresses: string[];
  projectRoot: string;
  herdrSession: string;
  startedAt: string;
}

export interface AgentRef {
  provider: Provider | null;
  herdr_pane_id: string | null;
  session_ref: string | null;
  generation?: number;
  visits_in_generation?: number;
  last_visit_key?: string | null;
  reset_reason?: string | null;
}

export interface Guidance {
  id: string;
  sequence: number;
  message: string;
}

export interface InterruptRequest {
  target_phase: WorkPhase;
  requested_at: string;
  terminal_status?: "failed" | "cancelled";
  terminal_reason?: string;
}

export interface ClaimedTicket {
  id: string;
  path: string;
  markdown: string;
  frontmatter: {
    id: string;
    title: string;
    phase: WorkPhase;
    status: string;
    repositories: Array<{ id: string; primary: boolean }>;
    attachments?: Array<{ id: string; filename: string; content_type: string; size_bytes: number; sha256: string; created_at: string }>;
    artifacts?: ArtifactRecord[];
    checkpoints?: TicketCheckpoint[];
    metadata?: Record<string, unknown>;
    pull_requests: Array<{ repository: string; url: string; phase?: WorkPhase }>;
    conversations?: Record<string, AgentRef>;
    workflow: {
      id: string; revision: string; current_node: string;
      inputs?: Record<string, boolean | string>;
      incoming?: null | { outcome: string; summary: string | null; handoff: string | null; output?: string | null; output_log_path?: string | null; source_node: string; target_node: string; actor?: string };
    };
    execution: {
      lease_id: string; provider: Provider | null; interrupt_request: InterruptRequest | null; attempt?: number;
      delivery_status?: "starting" | "delivered"; delivery_confirmed_at?: string | null;
      node_run_id?: string; node_id?: string; node_type?: "agent" | "script" | "checkpoint" | "restore_checkpoint"; conversation_key?: string;
      telemetry?: HarnessTelemetryRecord | null;
    };
  };
  workflow_node: {
    id: string;
    name: string;
    type: "agent" | "script" | "checkpoint" | "restore_checkpoint" | "human_gate" | "read" | "write" | "workflow" | "fan_out" | "fan_in" | "terminal";
    phase: WorkPhase | "done";
    prompt?: string;
    agent_profile?: string;
    conversation_key?: string;
    conversation_policy?: "resume" | "fresh_each_visit" | "reset_after_visits";
    maximum_visits_per_session?: number;
    repository?: string;
    script_file?: { relative_to: "selected_repository" | "primary_repository" | "project_root"; path?: string; path_input?: string };
    working_directory?: { relative_to: "selected_repository" | "primary_repository" | "project_root"; path?: string; path_input?: string };
    inline?: { language: "shell" | "python" | "javascript"; code: string };
    script_output?: { persist_stdout: boolean; prompt_tail_lines: number };
    artifacts?: Array<{ name: string; path: string; content_type: string; required: boolean; interpretation?: { kind: "quality_report"; schema: "agentic-quality/v1"; required_attributes: string[] } }>;
    checkpoint_label?: string;
    checkpoint_source?: { mode: "latest" | "id" | "metadata"; checkpoint_id?: string; metadata_key?: string };
    outcomes: Array<{ id: string; label: string; description: string; target: string }>;
    choices: Array<{ id: string; label: string; description: string; target: string; comment_required?: boolean }>;
    exit_codes: Array<{ id: string; label: string; description: string; target: string; codes?: number[]; default?: boolean }>;
  };
  node_prompt?: { id: string; revision: string; content: string } | null;
  resolved_agent_profile?: { alias: string; provider: Provider; model: string | null; reasoning: string | null } | null;
}

export interface ArtifactRecord {
  id: string; kind: "attachment" | "script_output" | "script_artifact" | "quality_report" | "checkpoint_bundle" | "checkpoint_manifest" | "execution_manifest";
  ticket_id: string; node_run_id: string | null; filename: string; content_type: string;
  size_bytes: number; sha256: string; created_at: string; metadata: Record<string, unknown>;
}

export interface TicketCheckpoint {
  id: string; label: string; kind: "workflow" | "manual" | "pre_restore"; node_id: string;
  node_run_id: string | null; created_at: string; manifest_artifact_id: string;
  repositories: Array<{ repository: string; head_sha: string; snapshot_sha: string; branch: string | null; remote_url: string | null; dirty: boolean; bundle_artifact_id: string }>;
}

export interface AgentObservation {
  paneId: string;
  state: string;
  sessionRef: string | null;
  workspaceId: string | null;
  tabId: string | null;
  terminalId: string | null;
  focused: boolean | null;
  cwd: string | null;
  foregroundCwd: string | null;
  terminalTitle: string | null;
  terminalTitleStripped: string | null;
  displayName: string | null;
  revision: number | null;
  sessionSource: string | null;
  sessionKind: string | null;
  tokens: Record<string, string>;
  interactiveReady?: boolean | null;
  launchPending?: boolean | null;
}

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface HarnessTelemetrySnapshot {
  schema_version: 1;
  harness: string;
  session_ref: string | null;
  observed_at: string;
  source: { kind: string; detail: string | null };
  model: { id: string | null; provider: string | null; observed_ids: string[] };
  reasoning: { effort: string | null; enabled: boolean | null; source: string | null };
  usage: TokenUsage | null;
  cost: { total_usd: number | null; kind: "reported" | "estimated" | "unavailable"; source?: string | null; pricing_id?: string | null; effective_at?: string | null };
  context: { used_tokens: number | null; window_tokens: number | null; used_percent: number | null };
  rate_limits: Array<{ id: string; name: string | null; used_percent: number; window_minutes: number | null; resets_at: string | null }>;
  attributes: Record<string, string | number | boolean | null>;
}

export interface HarnessTelemetryRecord {
  baseline: HarnessTelemetrySnapshot;
  latest: HarnessTelemetrySnapshot;
  delta: { usage: TokenUsage | null; cost_usd: number | null };
}

export interface IntakeCandidate {
  external_key: string;
  title: string;
  description: string;
  repositories?: Array<{ id: string; primary: boolean }>;
  labels?: string[];
  priority?: number;
  workflow_id?: string;
  workflow_revision?: string;
  workflow_inputs?: Record<string, boolean | string>;
  stage_enabled?: Record<string, boolean>;
  mark_ready?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ClaimedIntakeRun {
  id: string;
  mode: "admit" | "preview";
  source_id: string;
  source_revision: string;
  campaign_id: string;
  campaign_revision: string;
  attempt: number;
  lease_id: string;
  cursor_before: unknown;
  source: {
    version: 1;
    id: string;
    name: string;
    description: string;
    campaign_id: string;
    runner: {
      type: "supervisor_script";
      language: "shell" | "python" | "javascript";
      script_path: string;
      working_directory: string;
      timeout_seconds: number;
    };
    ticket: Record<string, unknown>;
    limits: Record<string, number>;
  };
}
