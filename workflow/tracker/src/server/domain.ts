export const PHASES = ["specification", "implementation", "review", "done"] as const;
export const STATUSES = [
  "pending", "ready", "running", "blocked", "waiting_approval", "completed", "failed", "cancelled",
] as const;
export const PROVIDERS = ["claude", "codex"] as const;

export type Phase = (typeof PHASES)[number];
export type TicketStatus = (typeof STATUSES)[number];
export type Provider = (typeof PROVIDERS)[number];
export type ReviewProvider = Provider;

export interface RepositoryRef {
  id: string;
  primary: boolean;
}

export interface AgentRef {
  provider: Provider | null;
  herdr_pane_id: string | null;
  session_ref: string | null;
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

export interface Execution {
  lease_id: string;
  supervisor_id: string;
  provider: Provider;
  phase: Phase;
  attempt: number;
  claimed_at: string;
  last_heartbeat_at: string;
  lease_expires_at: string;
  observed_herdr_state: string | null;
  herdr_observation: HerdrObservation | null;
  guidance: GuidanceItem[];
  interrupt_request: InterruptRequest | null;
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
  spec_required: boolean;
  review_required: boolean;
  work_provider: Provider;
  review_provider: ReviewProvider;
  priority: number;
  labels: string[];
  repositories: RepositoryRef[];
  assigned_supervisor: string | null;
  assigned_supervisor_host: string | null;
  agents: Record<"specification" | "implementation" | "review", AgentRef>;
  execution: Execution | null;
  attempts: Record<"specification" | "implementation" | "review", AttemptCounter>;
  pull_requests: PullRequestRef[];
  questions: TicketQuestion[];
  jira: JiraRef | null;
  archived_at: string | null;
  revision: number;
  event_sequence: number;
  created_at: string;
  updated_at: string;
  last_callback?: CallbackReceipt | null | undefined;
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
  work_provider: Provider;
  review_provider: ReviewProvider;
  review_required: boolean;
  priority: number;
  provider: Provider | null;
  revision: number;
  valid: boolean;
  errors: string[];
  path: string;
  claim_blockers: RepositoryClaimBlocker[];
  archived_at: string | null;
}

export interface RepositoryClaimBlocker {
  hostname: string;
  supervisor_id: string;
  ticket_id: string;
  ticket_title: string;
  repositories: string[];
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export function requiredProvider(ticket: TicketFrontmatter): Provider | null {
  if (ticket.phase === "review") return ticket.review_provider;
  if (ticket.phase === "specification" || ticket.phase === "implementation") return ticket.work_provider;
  return null;
}

export function defaultReviewProvider(workProvider: Provider): ReviewProvider {
  return workProvider === "codex" ? "claude" : "codex";
}

export function canProviderClaim(ticket: TicketFrontmatter, provider: Provider): boolean {
  return requiredProvider(ticket) === provider;
}

export function canSupervisorOwn(ticket: TicketFrontmatter, availableProviders: Provider[]): boolean {
  if (!availableProviders.includes(ticket.work_provider)) return false;
  return !ticket.review_required || availableProviders.includes(ticket.review_provider);
}

export function supervisorReservationActive(ticket: TicketFrontmatter): boolean {
  return ticket.status !== "completed" && ticket.status !== "cancelled";
}

export function isProgressed(ticket: TicketFrontmatter): boolean {
  return !(ticket.status === "pending" && ticket.phase === (ticket.spec_required ? "specification" : "implementation"));
}
