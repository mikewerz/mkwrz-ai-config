export type Provider = "claude" | "codex";
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
}

export interface TrackerPrompt {
  name: "assignment" | "specification" | "implementation" | "review" | "guidance" | "callback-reminder";
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
}

export interface Guidance {
  id: string;
  sequence: number;
  message: string;
}

export interface InterruptRequest {
  target_phase: WorkPhase;
  requested_at: string;
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
    work_provider: Provider;
    review_provider: Provider;
    repositories: Array<{ id: string; primary: boolean }>;
    pull_requests: Array<{ repository: string; url: string }>;
    agents: Record<WorkPhase, AgentRef>;
    execution: { lease_id: string; provider: Provider; interrupt_request: InterruptRequest | null };
  };
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
}
