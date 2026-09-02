export interface TicketSummary {
  id: string;
  demo?: boolean;
  title: string;
  phase: string;
  status: string;
  priority: number;
  provider: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  valid: boolean;
  errors: string[];
  path: string;
  claim_blockers: RepositoryClaimBlocker[];
  archived_at: string | null;
  production_result: "unassessed" | "succeeded" | "failed" | "rolled_back" | "not_deployed";
  workflow_id: string | null;
  workflow_node_id: string | null;
  workflow_node_name: string | null;
  workflow_stage_name: string | null;
  labels: string[];
  repositories: string[];
  assigned_supervisor: string | null;
  estimated_human_days: number | null;
  attention: {
    kinds: Array<"question" | "human_gate" | "blocked" | "failed" | "delivery_failure" | "github_feedback" | "expiring_wait" | "repository_blocked">;
    pending_questions: number;
    wait_wake_at: string | null;
    wait_deadline_at: string | null;
    delivery_failure_summary: string | null;
    github_feedback_summary: string | null;
  };
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

export interface NodeRunTiming {
  active_ms: number;
  quota_paused_ms: number;
  human_wait_ms: number;
  external_wait_ms: number;
  state: "active" | "quota_paused" | "human_wait" | "external_wait";
  last_accounted_at: string | null;
  pause_limit_id: string | null;
  pause_until: string | null;
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
  delivery_status: "starting" | "delivered";
  delivery_confirmed_at: string | null;
  observed_herdr_state: string | null;
  herdr_observation: HerdrObservation | null;
  telemetry: HarnessTelemetryRecord | null;
  guidance: GuidanceItem[];
  interrupt_request: null | {
    target_phase: "specification" | "implementation" | "review"; requested_at: string;
    terminal_status?: "failed" | "cancelled"; terminal_reason?: string;
    reason_code?: "cost_limit_exceeded"; cost_limit_usd?: number; cost_observed_usd?: number;
  };
  node_id?: string;
  node_type?: "agent" | "script" | "checkpoint" | "restore_checkpoint";
  node_run_id?: string;
  conversation_key?: string;
}

export interface AgentRef {
  provider: string | null;
  herdr_pane_id: string | null;
  session_ref: string | null;
  generation: number;
  visits_in_generation: number;
  last_visit_key: string | null;
  reset_reason: string | null;
}

export interface TicketAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}
export interface TicketArtifact { id: string; kind: string; ticket_id: string; node_run_id: string | null; filename: string; content_type: string; size_bytes: number; sha256: string; created_at: string; metadata: Record<string, unknown> }
export interface TicketCheckpoint { id: string; label: string; kind: "workflow" | "manual" | "pre_restore"; node_id: string; node_run_id: string | null; created_at: string; manifest_artifact_id: string; repositories: Array<{ repository: string; head_sha: string; snapshot_sha: string; branch: string | null; remote_url: string | null; dirty: boolean; bundle_artifact_id: string }> }

export interface TicketFrontmatter extends Record<string, unknown> {
  id: string;
  demo?: boolean;
  title: string;
  phase: string;
  status: string;
  priority: number;
  labels: string[];
  repositories: Array<{ id: string; primary: boolean }>;
  attachments: TicketAttachment[];
  artifacts: TicketArtifact[];
  checkpoints: TicketCheckpoint[];
  assigned_supervisor: string | null;
  assigned_supervisor_host: string | null;
  pull_requests: Array<{ repository: string; url: string; phase?: string; observation?: { checked_at: string; state: string; draft: boolean; merged: boolean; mergeable: boolean | null } | null }>;
  questions: Array<{ id: string; phase: string; question: string; options: string[]; asked_at: string; answer: string | null; answered_at: string | null }>;
  metadata?: Record<string, unknown>;
  jira: null | { key: string; issue_id: string; url: string; last_synced_at: string; source_updated_at: string | null };
  production_result: "unassessed" | "succeeded" | "failed" | "rolled_back" | "not_deployed";
  production_assessed_at: string | null;
  production_assessment_note: string | null;
  estimated_human_days: number | null;
  archived_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  execution: Execution | null;
  last_callback?: null | { lease_id: string; response: Record<string, unknown> };
  workflow?: null | {
    id: string; revision: string; current_node: string; transition_count: number;
    started_at: string; completed_at: string | null; current_node_entered_at: string;
    node_visits: Record<string, number>; node_attempts: Record<string, { total: number; consecutive_lease_losses: number }>; prompt_revisions: Record<string, string>;
    inputs: Record<string, boolean | string>; stage_enabled: Record<string, boolean>;
    incoming: null | { source_node: string; target_node: string; outcome: string; summary: string | null; handoff: string | null; output?: string | null; output_log_path?: string | null; actor: string; created_at: string };
    active_workflow_id?: string; active_workflow_revision?: string;
    resolved_agent_profiles?: Record<string, { alias: string; provider: "claude" | "codex"; model: string | null; reasoning: string | null }>;
    cost_limit_pause?: null | { workflow_id: string; node_id: string; limit_usd: number; observed_usd: number; paused_at: string };
    wait_states?: Record<string, { workflow_id: string; workflow_revision: string; node_id: string; started_at: string; wake_at: string; deadline_at: string; attempt: number; node_run_id: string }>;
    node_runs: Array<{ id: string; workflow_id?: string; workflow_revision: string; node_id: string; node_type: string; supervisor_id?: string | null; provider?: "claude" | "codex" | null; visit: number; attempt: number; status: string; outcome: string | null; summary: string | null; handoff?: string | null; output?: string | null; output_path?: string | null; output_sha256?: string | null; output_bytes?: number | null; script_path?: string | null; working_directory?: string | null; conversation_generation?: number | null; manifest_artifact_id?: string | null; wait?: { wake_at: string; deadline_at: string; delay_seconds: number } | null; metadata_writes?: Record<string, unknown>; external_references?: Array<{ type: string; id: string; url: string | null }>; input_revision?: number; started_at: string; completed_at: string | null; lease_id: string | null; telemetry: HarnessTelemetryRecord | null; timing: NodeRunTiming }>;
  };
  workflow_assignment?: null | { workflow_id: string; revision: string; version: number; selection: "default" | "manual_trial" | "experiment"; assigned_at: string; experiment_id: string | null };
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

export interface OperationSnapshot {
  in_progress: boolean;
  last_started_at: string | null;
  last_succeeded_at: string | null;
  last_failed_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  details: Record<string, unknown>;
}

export interface OperationalStatus {
  status: "ready" | "degraded" | "not_ready";
  ready: boolean;
  checked_at: string;
  failures: string[];
  warnings: string[];
  ticket_store: null | {
    root: string;
    writable: boolean;
    ticket_count: number;
    valid_tickets: number;
    invalid_tickets: number;
    index_generation: number;
    index_rebuilt_at: string | null;
    watcher_enabled: boolean;
    disk: null | { total_bytes: number; free_bytes: number; available_bytes: number };
  };
  libraries: {
    configuration_revision: number | null;
    prompts: number | null;
    invalid_prompts: string[];
    workflows: number | null;
    invalid_workflows: string[];
  };
  intake?: null | { campaigns: number; sources: number; runs: number; candidates: number; deferred: number; running_runs: number };
  background_operations: Record<"github_observation" | "artifact_maintenance" | "intake_scheduling", OperationSnapshot>;
}

export interface IntakeDocument<T> { definition: T; content: string; revision: string; valid: boolean; errors: string[] }
export interface IntakeLimits { max_new_per_run: number; max_new_per_day: number; max_open: number; max_working: number; max_observed_unarchived: number }
export interface IntakeCampaign { version: 1; id: string; name: string; description: string; enabled: boolean; limits: IntakeLimits; success_policy: Record<string, unknown> }
export interface IntakeSource {
  version: 1; id: string; name: string; description: string; enabled: boolean; campaign_id: string;
  schedule: { interval_minutes: number };
  runner: { type: "external" } | { type: "supervisor_script"; language: "shell" | "python" | "javascript"; script_path: string; working_directory: string; timeout_seconds: number };
  ticket: { workflow_id: string; workflow_revision?: string; repositories: Array<{ id: string; primary: boolean }>; labels: string[]; priority: number; mark_ready: boolean; workflow_inputs: Record<string, boolean | string>; stage_enabled: Record<string, boolean> };
  limits: IntakeLimits;
}
export interface IntakeRun {
  id: string; mode: "admit" | "preview"; source_id: string; campaign_id: string; campaign_revision: string; status: "ready" | "running" | "completed" | "failed"; scheduled_at: string; completed_at: string | null;
  attempt: number; supervisor_id: string | null; candidates_received: number; decisions: Record<"admitted" | "duplicate" | "deferred" | "rejected", number>; error: string | null; output_bytes: number;
  preview_candidates: Array<{ external_key: string; title: string; valid: boolean; errors: string[] }>;
}
export interface IntakeCandidateRecord {
  id: string; source_id: string; campaign_id: string; source_run_id: string; external_key: string; decision: "admitted" | "duplicate" | "deferred" | "rejected";
  reason: string | null; ticket_id: string | null; parent_ticket_id: string | null; first_seen_at: string; last_seen_at: string; observation_count: number;
  candidate: { title: string; description: string };
}
export interface IntakeOverview {
  generated_at: string;
  totals: { campaigns: number; enabled_campaigns: number; invalid_campaigns: number; sources: number; enabled_sources: number; invalid_sources: number; runs: number; preview_runs: number; running_runs: number; failed_runs: number; candidates: number; admitted: number; deferred: number; rejected: number };
  campaigns: Array<{ id: string; name: string; revision: string; enabled: boolean; sources: number; runs: number; successful_runs: number; failed_runs: number; candidates: number; admitted: number; deferred: number; open_tickets: number; working_tickets: number; completed_tickets: number; production_successes: number }>;
  sources: Array<{ id: string; name: string; revision: string; enabled: boolean; campaign_id: string; runs: number; preview_runs: number; successful_runs: number; failed_runs: number; success_rate: number | null; average_duration_ms: number | null; running_runs: number; candidates: number; admitted: number; deferred: number; duplicates: number; rejected: number; open_tickets: number; working_tickets: number; completed_tickets: number; production_successes: number }>;
  recent_runs: IntakeRun[]; recent_candidates: IntakeCandidateRecord[];
  source_documents: Array<IntakeDocument<IntakeSource>>; campaign_documents: Array<IntakeDocument<IntakeCampaign>>;
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
  agent_profiles: { default: string; profiles: Array<{ id: string; label: string; provider: "claude" | "codex"; model: string; reasoning: string }> };
  pricing: { estimate_missing_costs: boolean; models: Array<{ id: string; provider: "claude" | "codex"; model: string; input_per_million_usd: number; cached_input_per_million_usd: number; cache_write_input_per_million_usd: number; output_per_million_usd: number; source_url: string; effective_at: string }> };
  metrics: { human_day_rate_usd: number; quota_account_aliases?: Record<string, string> };
  quality: { attributes: Array<{ key: string; label: string; type: "number" | "boolean" | "string"; unit: string; direction: "higher_is_better" | "lower_is_better" | "neutral"; minimum: number | null; maximum: number | null }> };
  artifacts: { max_total_bytes: number; max_ticket_bytes: number; orphan_grace_hours: number; retention_days: number; auto_gc_enabled: boolean; gc_interval_minutes: number };
  repositories: RepositoryConfig[];
  jira: { enabled: boolean; site_url: string; project_key: string; issue_type: string };
  github: { observation_enabled: boolean; observation_interval_minutes: number; ignored_logins: string[] };
  demo: { enabled: boolean; step_duration_seconds: number };
}

export interface QuotaEstimate {
  account_id: string;
  supervisor_ids: string[];
  provider: "claude" | "codex";
  limit_id: string | null;
  status: "estimated" | "insufficient_data" | "not_reported";
  used_percent: number | null;
  window_minutes: number | null;
  resets_at: string | null;
  observed_at: string | null;
  plan_types: string[];
  estimated_weekly_tokens: number | null;
  estimated_weekly_api_usd: number | null;
  token_samples: number;
  cost_samples: number;
  direct_samples: number;
  percentage_points_observed: number;
  confidence: "low" | "medium" | "high" | null;
}

export interface QuotaReport { generated_at: string; accounts: QuotaEstimate[] }

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
  version: number;
  valid: boolean;
  errors: string[];
  workflow_references?: Array<{ workflow_id: string; workflow_name: string; node_id: string; node_name: string; outcomes: string[] }>;
}

export interface WorkflowNode {
  id: string;
  name: string;
  type: "agent" | "script" | "checkpoint" | "restore_checkpoint" | "human_gate" | "wait" | "read" | "write" | "workflow" | "fan_out" | "fan_in" | "terminal";
  phase: "specification" | "implementation" | "review" | "done";
  stage: string;
  prompt?: string;
  agent_profile?: string;
  conversation_key?: string;
  conversation_policy?: "resume" | "fresh_each_visit" | "reset_after_visits";
  maximum_visits_per_session?: number;
  max_cost_usd?: number;
  repository?: string;
  script_file?: { relative_to: "selected_repository" | "primary_repository" | "project_root"; path?: string; path_input?: string };
  working_directory?: { relative_to: "selected_repository" | "primary_repository" | "project_root"; path?: string; path_input?: string };
  inline?: { language: "shell" | "python" | "javascript"; code: string };
  script_output?: { persist_stdout: boolean; prompt_tail_lines: number };
  artifacts?: Array<{ name: string; path: string; content_type: string; required: boolean; presentation?: { title?: string; description?: string; category?: string; featured?: boolean }; interpretation?: { kind: "quality_report"; schema: "agentic-quality/v1"; required_attributes: string[] } }>;
  checkpoint_label?: string;
  checkpoint_source?: { mode: "latest" | "id" | "metadata"; checkpoint_id?: string; metadata_key?: string };
  wait_schedule?: { initial_seconds: number; multiplier: number; maximum_seconds: number; jitter_percent: number; deadline_seconds: number };
  timeout_to?: string;
  metadata_key?: string;
  metadata_value?: unknown;
  next?: string;
  metadata_cases?: Array<{ id: string; label: string; description: string; target: string; metric_class?: "success" | "failure" | "neutral"; equals?: unknown; default?: boolean }>;
  workflow_id?: string;
  status_codes?: Array<{ id: string; label: string; description: string; target: string; metric_class?: "success" | "failure" | "neutral"; codes?: number[] | undefined; default?: boolean }>;
  branches?: Array<{ id: string; label: string; description: string; target: string; metric_class?: "success" | "failure" | "neutral" }>;
  fan_in?: string;
  inputs_from?: string[];
  github_watch?: { pull_request_phase: "specification" | "implementation" | "review" | "all"; feedback_outcome?: string; feedback_target?: string };
  pull_request_requirement?: { scope: "any" | "primary"; phase: "specification" | "implementation" | "review" };
  when?: { input: string; equals: boolean | string };
  otherwise?: string;
  max_visits?: number;
  terminal_status?: "completed" | "failed" | "cancelled";
  status_code?: number;
  outcomes: Array<{ id: string; label: string; description: string; target: string; metric_class?: "success" | "failure" | "neutral" }>;
  choices: Array<{ id: string; label: string; description: string; target: string; metric_class?: "success" | "failure" | "neutral"; comment_required?: boolean }>;
  exit_codes: Array<{ id: string; label: string; description: string; target: string; metric_class?: "success" | "failure" | "neutral"; codes?: number[]; default?: boolean }>;
}

export interface WorkflowDocument {
  definition: {
    version: 2; id: string; name: string; description: string; start: string; max_transitions: number;
    inputs: Array<{ id: string; label: string; type: "boolean" | "select" | "text"; default: boolean | string; options?: Array<{ value: string; label: string }> }>;
    stages: Array<{ id: string; name: string; phase: "specification" | "implementation" | "review" | "done"; skippable: boolean; default_enabled: boolean; bypass_to?: string }>;
    nodes: WorkflowNode[];
  };
  content: string;
  revision: string;
  version: number;
  valid: boolean;
  errors: string[];
  referenced_prompts: string[];
}

export interface WorkflowRelease {
  workflow_id: string; revision: string; version: number; label: string; status: "active" | "trial" | "retired";
  published_at: string; parent_revision: string | null; is_default: boolean; definition: WorkflowDocument["definition"];
}
export interface WorkflowReleaseCatalog {
  catalog: { version: 1; revision: number; updated_at: string; default_workflow_id: string; workflows: Record<string, { default_revision: string }> };
  releases: WorkflowRelease[];
}

export interface WorkflowBundle {
  schema: "agentic-project-tracker/workflow-bundle/v1";
  exported_at: string;
  workflow: { id: string; revision: string; version: number; label: string; content: string };
  prompts: Array<{ name: string; revision: string; version: number; content: string }>;
  requirements: { agent_profiles: string[]; workflows: string[] };
}

export interface WorkflowBundleImportResult {
  workflow: WorkflowDocument;
  prompts: PromptDocument[];
  release: WorkflowRelease;
  installed_prompt_revisions: string[];
  unchanged_prompt_revisions: string[];
  warnings: string[];
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
  workflow_node?: WorkflowNode;
  resolved_agent_profile?: { alias: string; provider: "claude" | "codex"; model: string | null; reasoning: string | null } | null;
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
  delivery_status: "starting" | "delivered";
  delivery_confirmed_at: string | null;
  consecutive_lease_losses: number;
  pane_id: string | null;
  session_ref: string | null;
  herdr: HerdrObservation | null;
  telemetry: HarnessTelemetryRecord | null;
  node_id?: string;
  node_type?: "agent" | "script";
}

export interface NumberSummary {
  count: number; min: number | null; q1: number | null; median: number | null; q3: number | null; max: number | null;
  mean: number | null; p90: number | null; p95: number | null;
}

export interface MetricsReport {
  generated_at: string;
  filters: { from?: string; to?: string; labels: string[]; label_mode: "any" | "all"; workflow_id?: string; workflow_revision?: string; repositories: string[]; production_result?: string };
  available: { labels: string[]; workflows: Array<{ id: string; revision: string }>; repositories: string[] };
  totals: {
    tickets: number; completed: number; failed: number; cancelled: number; in_progress: number; settled: number; completion_rate: number | null;
    archived: number; total_tokens: number; known_cost_usd: number;
    active_ms: number; quota_paused_ms: number; human_wait_ms: number; external_wait_ms: number;
    production: Record<"unassessed" | "succeeded" | "failed" | "rolled_back" | "not_deployed", number>;
    production_assessed: number; production_success_rate: number | null;
    estimated_human_days: number; estimated_human_cost_usd: number; human_day_rate_usd: number;
    comparison_tickets: number; comparison_human_cost_usd: number; comparison_factory_cost_usd: number;
    comparison_savings_usd: number; comparison_savings_rate: number | null;
  };
  coverage: { agent_runs: number; token_runs: number; cost_runs: number; estimated_cost_runs: number; complete_token_tickets: number; complete_cost_tickets: number };
  summaries: Record<"ticket_duration_ms" | "active_time_ms" | "human_wait_ms" | "external_wait_ms" | "quota_pause_ms" | "tokens_per_ticket" | "cost_per_ticket_usd" | "estimated_human_days" | "estimated_human_cost_usd", NumberSummary>;
  workflows: Array<{
    workflow_id: string; workflow_revision: string; ticket_count: number;
    nodes: Array<{
      workflow_id: string; workflow_revision: string; node_id: string; node_name: string; node_type: string;
      ticket_count: number; runs: number; completed: number; running: number; interrupted: number; bypassed: number; lease_lost: number; delivery_failed: number;
      classifications: { success: number; failure: number; neutral: number; unclassified: number }; success_rate: number | null;
      wall_ms: NumberSummary; active_ms: number; quota_paused_ms: number; human_wait_ms: number; external_wait_ms: number; total_tokens: number; known_cost_usd: number;
      telemetry_coverage: { token_runs: number; cost_runs: number; total_runs: number };
      branches: Array<{ outcome: string; label: string; target: string | null; metric_class: "success" | "failure" | "neutral" | "unclassified"; count: number; rate: number }>;
      quality: Array<{ key: string; label: string; type: "number" | "boolean" | "string"; unit: string; direction: "higher_is_better" | "lower_is_better" | "neutral"; ticket_count: number; reports: number; statuses: Record<"pass" | "warn" | "fail" | "unknown", number>; pass_rate: number | null; numeric: NumberSummary | null; values: Array<{ value: string; count: number }> }>;
    }>;
  }>;
  profiles: Array<{ alias: string; provider: string | null; model: string | null; reasoning: string | null; runs: number; success: number; failure: number; success_rate: number | null; total_tokens: number; known_cost_usd: number; token_runs: number; cost_runs: number; wall_ms: NumberSummary }>;
}

export interface WorkflowComparisonArm {
  workflow_id: string; workflow_revision: string;
  cohort: { assigned: number; completed: number; failed: number; cancelled: number; blocked: number; in_progress: number; crossover: number; efficiency_eligible: number };
  completion_rate: number | null; production_success_rate: number | null;
  coverage: { cost_tickets: number; token_tickets: number; eligible_tickets: number };
  totals: { known_cost_usd: number; known_tokens: number; active_ms: number; human_wait_ms: number; quota_paused_ms: number };
  summaries: Record<"ticket_duration_ms" | "active_time_ms" | "human_wait_ms" | "quota_pause_ms" | "cost_per_ticket_usd" | "tokens_per_ticket" | "node_visits", NumberSummary>;
  nodes: MetricsReport["workflows"][number]["nodes"];
}
export interface WorkflowComparisonReport {
  generated_at: string; left: WorkflowComparisonArm; right: WorkflowComparisonArm;
  deltas: Record<"completion_rate" | "production_success_rate" | "median_cost_usd" | "median_tokens" | "median_duration_ms" | "median_active_ms", { absolute: number | null; percent: number | null }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const deadline = AbortSignal.timeout(30_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  let response: Response;
  try { response = await fetch(path, { ...init, signal, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } }); }
  catch (error) { if (signal.aborted) throw new Error("Tracker request timed out after 30 seconds"); throw error; }
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
  operations: () => request<OperationalStatus>("/api/operations"),
  intake: () => request<IntakeOverview>("/api/intake"),
  saveIntakeCampaign: (id: string, content: string, expectedRevision?: string) => request<{ campaign: IntakeDocument<IntakeCampaign> }>(`/api/intake/campaigns/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ content, expected_revision: expectedRevision }) }),
  saveIntakeSource: (id: string, content: string, expectedRevision?: string) => request<{ source: IntakeDocument<IntakeSource> }>(`/api/intake/sources/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ content, expected_revision: expectedRevision }) }),
  triggerIntakeSource: (id: string, preview = false) => request<{ run: IntakeRun }>(`/api/intake/sources/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify({ preview }) }),
  intakeOutputUrl: (sourceId: string, runId: string) => `/api/intake/sources/${encodeURIComponent(sourceId)}/runs/${encodeURIComponent(runId)}/output`,
  metrics: (filters: { from?: string; to?: string; labels?: string[]; labelMode?: "any" | "all"; workflowId?: string; workflowRevision?: string; repositories?: string[]; productionResult?: string } = {}) => {
    const query = new URLSearchParams();
    if (filters.from) query.set("from", filters.from); if (filters.to) query.set("to", filters.to);
    if (filters.labels?.length) query.set("labels", filters.labels.join(",")); if (filters.labelMode) query.set("label_mode", filters.labelMode);
    if (filters.workflowId) query.set("workflow_id", filters.workflowId); if (filters.workflowRevision) query.set("workflow_revision", filters.workflowRevision);
    if (filters.repositories?.length) query.set("repositories", filters.repositories.join(",")); if (filters.productionResult) query.set("production_result", filters.productionResult);
    return request<MetricsReport>(`/api/metrics${query.size ? `?${query}` : ""}`);
  },
  compareWorkflows: (left: { id: string; revision: string }, right: { id: string; revision: string }, filters: { from?: string; to?: string; labels?: string[]; labelMode?: "any" | "all"; repositories?: string[]; productionResult?: string } = {}) => {
    const query = new URLSearchParams({ left_id: left.id, left_revision: left.revision, right_id: right.id, right_revision: right.revision });
    if (filters.from) query.set("from", filters.from); if (filters.to) query.set("to", filters.to);
    if (filters.labels?.length) query.set("labels", filters.labels.join(",")); if (filters.labelMode) query.set("label_mode", filters.labelMode);
    if (filters.repositories?.length) query.set("repositories", filters.repositories.join(",")); if (filters.productionResult) query.set("production_result", filters.productionResult);
    return request<WorkflowComparisonReport>(`/api/metrics/compare?${query}`);
  },
  config: () => request<{ config: TrackerConfig; quota: QuotaReport }>("/api/config"),
  prompts: () => request<{ prompts: PromptDocument[] }>("/api/prompts"),
  createPrompt: (name: string, content: string) => request<{ prompt: PromptDocument }>("/api/prompts", { method: "POST", body: JSON.stringify({ name, content }) }),
  workflows: () => request<{ workflows: WorkflowDocument[] }>("/api/workflows"),
  workflowReleases: () => request<WorkflowReleaseCatalog>("/api/workflow-releases"),
  workflowRevision: (id: string, revision: string) => request<{ workflow: WorkflowDocument }>(`/api/workflows/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}`),
  workflowBundleUrl: (id: string, revision: string) => `/api/workflows/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/export`,
  importWorkflowBundle: (bundle: WorkflowBundle) => request<WorkflowBundleImportResult>("/api/workflow-bundles/import", { method: "POST", body: JSON.stringify(bundle) }),
  createWorkflow: (content: string, label?: string) => request<{ workflow: WorkflowDocument }>("/api/workflows", { method: "POST", body: JSON.stringify({ content, label }) }),
  updateWorkflow: (workflow: WorkflowDocument, content: string, makeDefault = false, label?: string) => request<{ workflow: WorkflowDocument }>(`/api/workflows/${encodeURIComponent(workflow.definition.id)}`, {
    method: "PUT", body: JSON.stringify({ expected_revision: workflow.revision, content, make_default: makeDefault, label }),
  }),
  promoteWorkflow: (id: string, revision: string) => request<{ release: WorkflowRelease }>(`/api/workflows/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/promote`, { method: "POST", body: "{}" }),
  restoreWorkflow: (workflow: WorkflowDocument) => request<{ workflow: WorkflowDocument }>(`/api/workflows/${encodeURIComponent(workflow.definition.id)}/restore-default`, { method: "POST", body: JSON.stringify({ expected_revision: workflow.revision }) }),
  updatePrompt: (prompt: PromptDocument, content: string) => request<{ prompt: PromptDocument }>(`/api/prompts/${encodeURIComponent(prompt.name)}`, {
    method: "PUT", body: JSON.stringify({ expected_revision: prompt.revision, content }),
  }),
  restorePrompt: (prompt: PromptDocument) => request<{ prompt: PromptDocument }>(`/api/prompts/${encodeURIComponent(prompt.name)}/restore-default`, { method: "POST", body: JSON.stringify({ expected_revision: prompt.revision }) }),
  restoreDefaults: (options: { prompts: boolean; workflows: boolean }) => request<{ prompts: PromptDocument[]; workflows: WorkflowDocument[] }>("/api/defaults/restore", { method: "POST", body: JSON.stringify(options) }),
  previewPrompt: (prompt: PromptDocument, content: string, phase: "specification" | "implementation" | "review") => request<{ rendered: string }>(`/api/prompts/${encodeURIComponent(prompt.name)}/preview`, {
    method: "POST", body: JSON.stringify({ content, phase }),
  }),
  updateConfig: (config: TrackerConfig, update: Pick<TrackerConfig, "providers" | "agent_profiles" | "pricing" | "metrics" | "quality" | "artifacts" | "repositories" | "jira" | "github" | "demo">) => request<{ config: TrackerConfig; quota: QuotaReport }>("/api/config", {
    method: "PUT", body: JSON.stringify({ expected_revision: config.revision, ...update }),
  }),
  nextId: () => request<{ id: string }>("/api/tickets/next-id"),
  nextDemoId: () => request<{ id: string }>("/api/demo-tickets/next-id"),
  clearDemoTickets: () => request<{ cleared: number }>("/api/demo-tickets", { method: "DELETE" }),
  get: (id: string) => request<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`),
  artifactUrl: (ticketId: string, artifactId: string, download = false) => `/api/tickets/${encodeURIComponent(ticketId)}/artifacts/${encodeURIComponent(artifactId)}/content${download ? "?download=true" : ""}`,
  attachmentUrl: (ticketId: string, attachmentId: string, download = false) => `/api/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/content${download ? "?download=true" : ""}`,
  uploadAttachment: async (ticket: TicketDetail, file: File) => {
    const query = new URLSearchParams({ filename: file.name, expected_revision: String(ticket.frontmatter?.revision ?? 0) });
    const response = await fetch(`/api/tickets/${encodeURIComponent(ticket.id)}/attachments?${query}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Attachment-Content-Type": file.type || "application/octet-stream" }, body: file,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; details?: unknown };
      throw new Error(body.error ?? `Attachment upload failed: ${response.status}`);
    }
    return response.json() as Promise<TicketDetail>;
  },
  removeAttachment: (ticket: TicketDetail, attachmentId: string) => request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticket.id)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: "DELETE", body: JSON.stringify({ expected_revision: ticket.frontmatter?.revision ?? 0 }) },
  ),
  checkpointAction: (ticket: TicketDetail, action: "create" | "restore", nodeId: string, checkpointId?: string) => request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticket.id)}/checkpoints/action`,
    { method: "POST", body: JSON.stringify({ action, node_id: nodeId, expected_revision: ticket.frontmatter?.revision ?? 0, ...(checkpointId ? { checkpoint_id: checkpointId } : {}) }) },
  ),
  resetConversation: (ticket: TicketDetail, key: string) => request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticket.id)}/conversations/${encodeURIComponent(key)}/reset`,
    { method: "POST", body: JSON.stringify({ expected_revision: ticket.frontmatter?.revision ?? 0 }) },
  ),
  create: (markdown: string, autoId = true, workflowId = "standard-delivery", workflowRevision?: string, workflowInputs: Record<string, boolean | string> = {}, stageEnabled: Record<string, boolean> = {}) => request<TicketDetail>("/api/tickets", { method: "POST", body: JSON.stringify({ markdown, auto_id: autoId, workflow_id: workflowId, workflow_revision: workflowRevision, workflow_inputs: workflowInputs, stage_enabled: stageEnabled }) }),
  jiraImport: (key: string) => request<{ draft: { id: string; title: string; description: string; labels: string[]; jira: TicketFrontmatter["jira"] } }>("/api/jira/import", { method: "POST", body: JSON.stringify({ key }) }),
  checkPullRequests: (id: string) => request<{ checked: number; reopened: boolean }>(`/api/tickets/${encodeURIComponent(id)}/check-pull-requests`, { method: "POST", body: "{}" }),
  edit: (ticket: TicketDetail, markdown: string) => request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticket.id)}`,
    { method: "PUT", body: JSON.stringify({ markdown, expected_revision: ticket.frontmatter?.revision ?? 0 }) },
  ),
  action: (ticket: TicketDetail, action: string, body: Record<string, unknown> = {}) => request<TicketDetail>(
    `/api/tickets/${encodeURIComponent(ticket.id)}/${action}`,
    { method: "POST", body: JSON.stringify({ expected_revision: ticket.frontmatter?.revision ?? 0, ...body }) },
  ),
};
