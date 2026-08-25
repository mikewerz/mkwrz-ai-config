export const PHASES = ["specification", "implementation", "review", "done"] as const;
export const STATUSES = [
  "pending", "ready", "running", "blocked", "waiting_approval", "waiting_external", "completed", "failed", "cancelled",
] as const;
export const PROVIDERS = ["claude", "codex"] as const;
export const ACTIVITY_CAPABILITIES = ["repository_action", "inline_shell", "inline_javascript", "inline_python", "git_checkpoint", "git_restore"] as const;
export const PRODUCTION_RESULTS = ["unassessed", "succeeded", "failed", "rolled_back", "not_deployed"] as const;

export type Phase = (typeof PHASES)[number];
export type TicketStatus = (typeof STATUSES)[number];
export type Provider = (typeof PROVIDERS)[number];
export type ActivityCapability = (typeof ACTIVITY_CAPABILITIES)[number];
export type ProductionResult = (typeof PRODUCTION_RESULTS)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ResolvedAgentProfile {
  alias: string;
  provider: Provider;
  model: string | null;
  reasoning: string | null;
}

export interface RepositoryRef {
  id: string;
  primary: boolean;
}

export interface TicketAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export type ArtifactKind = "attachment" | "evidence" | "script_output" | "script_artifact" | "quality_report" | "checkpoint_bundle" | "checkpoint_manifest" | "execution_manifest" | "execution_trace";
export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  ticket_id: string;
  node_run_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  metadata: Record<string, JsonValue>;
}

export interface ExecutionTraceEvent {
  sequence: number;
  timestamp: string;
  elapsed_ms: number;
  event: string;
  data: Record<string, JsonValue>;
}

export interface TicketArtifactRef extends ArtifactRecord {}
export interface CheckpointRepositoryRef {
  repository: string;
  head_sha: string;
  snapshot_sha: string;
  branch: string | null;
  remote_url: string | null;
  dirty: boolean;
  bundle_artifact_id: string;
}
export interface TicketCheckpoint {
  id: string;
  label: string;
  kind: "workflow" | "manual" | "pre_restore";
  node_id: string;
  node_run_id: string | null;
  created_at: string;
  repositories: CheckpointRepositoryRef[];
  manifest_artifact_id: string;
}

export interface AgentRef {
  provider: Provider | null;
  herdr_pane_id: string | null;
  session_ref: string | null;
  generation: number;
  visits_in_generation: number;
  last_visit_key: string | null;
  reset_reason: string | null;
}

export interface AttemptCounter {
  total: number;
  consecutive_lease_losses: number;
}

export interface PullRequestRef {
  repository: string;
  url: string;
  phase?: "specification" | "implementation" | "review";
  observation?: PullRequestObservation | null;
}

export interface PullRequestObservation {
  checked_at: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  last_issue_comment_id: number;
  last_review_comment_id: number;
  last_review_id: number;
  merge_conflict_reported: boolean;
}

export interface TicketQuestion {
  id: string;
  phase: Exclude<Phase, "done">;
  question: string;
  options: string[];
  asked_at: string;
  answer: string | null;
  answered_at: string | null;
}

export interface JiraRef {
  key: string;
  issue_id: string;
  url: string;
  last_synced_at: string;
  source_updated_at: string | null;
}

export interface GuidanceItem {
  id: string;
  sequence: number;
  message: string;
  created_at: string;
  delivered_at: string | null;
}

export interface InterruptRequest {
  target_phase: Exclude<Phase, "done">;
  requested_at: string;
  target_node?: string | undefined;
  target_workflow_id?: string | undefined;
  target_workflow_revision?: string | undefined;
  terminal_status?: "failed" | "cancelled" | undefined;
  terminal_reason?: string | undefined;
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

export type NodeTimingState = "active" | "quota_paused" | "human_wait" | "external_wait";

export interface NodeRunTiming {
  active_ms: number;
  quota_paused_ms: number;
  human_wait_ms: number;
  external_wait_ms: number;
  state: NodeTimingState;
  last_accounted_at: string | null;
  pause_limit_id: string | null;
  pause_until: string | null;
}

export interface Execution {
  lease_id: string;
  supervisor_id: string;
  provider: Provider | null;
  phase: Phase;
  attempt: number;
  claimed_at: string;
  last_heartbeat_at: string;
  lease_expires_at: string;
  delivery_status: "starting" | "delivered";
  delivery_confirmed_at: string | null;
  observed_herdr_state: string | null;
  herdr_observation: HerdrObservation | null;
  telemetry: HarnessTelemetryRecord | null;
  guidance: GuidanceItem[];
  interrupt_request: InterruptRequest | null;
  node_run_id?: string | undefined;
  node_id?: string | undefined;
  node_type?: "agent" | "script" | "checkpoint" | "restore_checkpoint" | undefined;
  conversation_key?: string | undefined;
}

export interface WorkflowNodeRun {
  id: string;
  workflow_id?: string;
  workflow_revision: string;
  node_id: string;
  node_type: "agent" | "script" | "checkpoint" | "restore_checkpoint" | "human_gate" | "wait" | "read" | "write" | "workflow" | "fan_out" | "fan_in" | "terminal";
  visit: number;
  attempt: number;
  status: "running" | "completed" | "failed" | "interrupted";
  supervisor_id: string | null;
  provider: Provider | null;
  lease_id: string | null;
  started_at: string;
  completed_at: string | null;
  outcome: string | null;
  summary: string | null;
  handoff: string | null;
  output: string | null;
  output_path?: string | null;
  output_sha256?: string | null;
  output_bytes?: number | null;
  script_path?: string | null;
  working_directory?: string | null;
  conversation_generation?: number | null;
  manifest_artifact_id?: string | null;
  wait?: { wake_at: string; deadline_at: string; delay_seconds: number } | null;
  metadata_writes?: Record<string, JsonValue>;
  external_references?: Array<{ type: string; id: string; url: string | null }>;
  input_revision: number;
  telemetry: HarnessTelemetryRecord | null;
  timing: NodeRunTiming;
}

export interface WorkflowTransitionContext {
  source_node: string;
  target_node: string;
  outcome: string;
  summary: string | null;
  handoff: string | null;
  output?: string | null;
  output_log_path?: string | null;
  actor: string;
  created_at: string;
}

export interface WorkflowCallFrame {
  workflow_id: string;
  workflow_revision: string;
  call_node_id: string;
}

export interface WorkflowFanOutFrame {
  workflow_id: string;
  workflow_revision: string;
  fan_out_node_id: string;
  fan_in_node_id: string;
  pending_targets: string[];
  inputs: WorkflowTransitionContext[];
  source: WorkflowTransitionContext | null;
}

export interface WorkflowWaitState {
  workflow_id: string;
  workflow_revision: string;
  node_id: string;
  started_at: string;
  wake_at: string;
  deadline_at: string;
  attempt: number;
  node_run_id: string;
}

export interface WorkflowRunLedgerRef {
  version: 1;
  ticket_revision: number;
  run_count: number;
  sha256: string;
}

export interface WorkflowRuntime {
  id: string;
  revision: string;
  current_node: string;
  started_at: string;
  completed_at: string | null;
  current_node_entered_at: string;
  transition_count: number;
  node_visits: Record<string, number>;
  node_attempts: Record<string, AttemptCounter>;
  node_runs: WorkflowNodeRun[];
  run_ledger?: WorkflowRunLedgerRef;
  prompt_revisions: Record<string, string>;
  inputs: Record<string, boolean | string>;
  stage_enabled: Record<string, boolean>;
  incoming: WorkflowTransitionContext | null;
  active_workflow_id?: string;
  active_workflow_revision?: string;
  workflow_revisions?: Record<string, string>;
  workflow_stack?: WorkflowCallFrame[];
  fan_out_stack?: WorkflowFanOutFrame[];
  wait_states?: Record<string, WorkflowWaitState>;
  resolved_agent_profiles?: Record<string, ResolvedAgentProfile>;
}

export interface WorkflowAssignment {
  workflow_id: string;
  revision: string;
  version: number;
  selection: "default" | "manual_trial" | "experiment";
  assigned_at: string;
  experiment_id: string | null;
}

export interface CallbackReceipt {
  lease_id: string;
  digest: string;
  response: Record<string, unknown>;
}

export interface TicketFrontmatter {
  id: string;
  title: string;
  phase: Phase;
  status: TicketStatus;
  priority: number;
  labels: string[];
  repositories: RepositoryRef[];
  attachments: TicketAttachment[];
  artifacts: TicketArtifactRef[];
  checkpoints: TicketCheckpoint[];
  assigned_supervisor: string | null;
  assigned_supervisor_host: string | null;
  execution: Execution | null;
  pull_requests: PullRequestRef[];
  questions: TicketQuestion[];
  metadata?: Record<string, JsonValue>;
  jira: JiraRef | null;
  production_result: ProductionResult;
  production_assessed_at: string | null;
  production_assessment_note: string | null;
  estimated_human_days: number | null;
  archived_at: string | null;
  revision: number;
  event_sequence: number;
  created_at: string;
  updated_at: string;
  last_callback?: CallbackReceipt | null | undefined;
  workflow?: WorkflowRuntime | null | undefined;
  workflow_assignment?: WorkflowAssignment | null | undefined;
  conversations?: Record<string, AgentRef> | undefined;
}

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface LoadedTicket {
  path: string;
  relativePath: string;
  markdown: string;
  body: string;
  frontmatter: TicketFrontmatter | null;
  valid: boolean;
  errors: string[];
}

export interface TicketSummary {
  id: string;
  title: string;
  phase: Phase;
  status: TicketStatus;
  priority: number;
  provider: Provider | null;
  revision: number;
  created_at: string;
  updated_at: string;
  valid: boolean;
  errors: string[];
  path: string;
  claim_blockers: RepositoryClaimBlocker[];
  archived_at: string | null;
  production_result: ProductionResult;
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

export class HttpError extends Error {
  readonly code: string;
  constructor(public readonly status: number, message: string, public readonly details?: unknown, code?: string) {
    super(message);
    this.code = code ?? errorCode(status, message);
  }
}

function errorCode(status: number, message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("lease") && (normalized.includes("stale") || normalized.includes("unknown") || normalized.includes("no longer retained"))) return "LEASE_STALE";
  if (normalized.includes("lease") && normalized.includes("interrupt")) return "LEASE_INTERRUPTING";
  if (normalized.includes("lease")) return "LEASE_CONFLICT";
  if (normalized.includes("quality report") || normalized.includes("quality") && normalized.includes("schema")) return "QUALITY_REPORT_INVALID";
  if (normalized.includes("artifact") && normalized.includes("integrity")) return "ARTIFACT_INTEGRITY_FAILED";
  if (normalized.includes("artifact") && normalized.includes("ownership")) return "ARTIFACT_OWNERSHIP_MISMATCH";
  if (normalized.includes("artifact") && normalized.includes("not found")) return "ARTIFACT_NOT_FOUND";
  if (normalized.includes("artifact") && normalized.includes("byte limit")) return "ARTIFACT_TOO_LARGE";
  if (normalized.includes("artifact") && (normalized.includes("quota") || normalized.includes("references"))) return "ARTIFACT_QUOTA_EXCEEDED";
  if (normalized.includes("artifact") || normalized.includes("attachment")) return "ARTIFACT_INVALID";
  return status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 422 ? "VALIDATION_FAILED" : "INTERNAL_ERROR";
}

export function supervisorReservationActive(ticket: TicketFrontmatter): boolean {
  return ticket.status !== "completed" && ticket.status !== "cancelled";
}

export function isProgressed(ticket: TicketFrontmatter): boolean {
  return ticket.status !== "pending";
}
