export type Provider = "claude" | "codex";
export type ActivityCapability = "repository_action" | "inline_shell" | "inline_javascript" | "inline_python";
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
    work_provider: Provider;
    review_provider: Provider;
    repositories: Array<{ id: string; primary: boolean }>;
    pull_requests: Array<{ repository: string; url: string; phase?: WorkPhase }>;
    agents: Record<WorkPhase, AgentRef>;
    conversations?: Record<string, AgentRef>;
    workflow?: {
      id?: string; revision?: string; current_node?: string;
      incoming?: null | { outcome: string; summary: string | null; handoff: string | null; source_node: string; target_node: string; actor?: string };
    };
    execution: {
      lease_id: string; provider: Provider | null; interrupt_request: InterruptRequest | null; attempt?: number;
      node_run_id?: string; node_id?: string; node_type?: "agent" | "script"; conversation_key?: string;
    };
  };
  workflow_node?: {
    id: string;
    name: string;
    type: "agent" | "script" | "human_gate" | "terminal";
    phase: WorkPhase | "done";
    prompt?: string;
    provider?: Provider | "work" | "review";
    conversation_key?: string;
    repository?: string;
    action?: string;
    inline?: { language: "shell" | "python" | "javascript"; code: string };
    outcomes: Array<{ id: string; label: string; description: string; target: string }>;
    choices: Array<{ id: string; label: string; description: string; target: string; comment_required?: boolean }>;
    exit_codes: Array<{ id: string; label: string; description: string; target: string; codes?: number[]; default?: boolean }>;
  };
  node_prompt?: { id: string; revision: string; content: string } | null;
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
