import type { AgentObservation, ClaimedTicket, Guidance, InterruptRequest, Provider, SupervisorPresence, TrackerConfig, TrackerPrompt } from "./types.js";

export class TrackerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class TrackerClient {
  constructor(private readonly baseUrl: string, private readonly supervisorId: string, private readonly instanceId?: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new TrackerError(response.status, body.error ?? response.statusText);
    }
    return response.json() as Promise<T>;
  }

  async claim(provider: Provider, availableProviders: Provider[]): Promise<ClaimedTicket | null> {
    const response = await fetch(new URL("/api/work/claim", this.baseUrl), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supervisor_id: this.supervisorId, instance_id: this.instanceId, provider, available_providers: availableProviders, wait_seconds: 30 }),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new TrackerError(response.status, (await response.json().catch(() => ({})) as { error?: string }).error ?? response.statusText);
    return response.json() as Promise<ClaimedTicket>;
  }

  async config(): Promise<TrackerConfig> {
    return (await this.request<{ config: TrackerConfig }>("/api/config")).config;
  }

  async prompts(): Promise<TrackerPrompt[]> {
    return (await this.request<{ prompts: TrackerPrompt[] }>("/api/prompts")).prompts;
  }

  heartbeatSupervisor(presence: SupervisorPresence, providers: Provider[]): Promise<unknown> {
    return this.request<unknown>("/api/supervisors/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        supervisor_id: this.supervisorId,
        instance_id: presence.instanceId,
        hostname: presence.hostname,
        ip_addresses: presence.ipAddresses,
        project_root: presence.projectRoot,
        herdr_session: presence.herdrSession,
        providers,
        started_at: presence.startedAt,
      }),
    });
  }

  unregisterSupervisor(): Promise<unknown> {
    if (!this.instanceId) return Promise.resolve({ removed: false });
    return this.request<unknown>("/api/supervisors/unregister", {
      method: "POST", body: JSON.stringify({ supervisor_id: this.supervisorId, instance_id: this.instanceId }),
    });
  }

  async active(provider: Provider): Promise<ClaimedTicket[]> {
    const result = await this.request<{ tickets: ClaimedTicket[] }>(
      `/api/work/active?supervisor_id=${encodeURIComponent(this.supervisorId)}&provider=${encodeURIComponent(provider)}`,
    );
    return result.tickets;
  }

  heartbeat(lease: string, observation: AgentObservation & { guidanceCursor: number }) {
    return this.request<{ active: boolean }>(`/api/work/${lease}/heartbeat`, {
      method: "POST", body: JSON.stringify({
        observed_state: observation.state, pane_id: observation.paneId,
        ...(observation.sessionRef ? { session_ref: observation.sessionRef } : {}), guidance_cursor: observation.guidanceCursor,
        herdr_observation: {
          pane_id: observation.paneId, workspace_id: observation.workspaceId, tab_id: observation.tabId,
          terminal_id: observation.terminalId, focused: observation.focused, cwd: observation.cwd,
          foreground_cwd: observation.foregroundCwd, terminal_title: observation.terminalTitle,
          terminal_title_stripped: observation.terminalTitleStripped, display_name: observation.displayName,
          revision: observation.revision, session_source: observation.sessionSource,
          session_kind: observation.sessionKind, tokens: observation.tokens,
        },
      }),
    });
  }

  async guidance(lease: string, after: number): Promise<Guidance[]> {
    const result = await this.request<{ guidance: Guidance[] }>(`/api/work/${lease}/guidance?after=${after}`);
    return result.guidance;
  }

  async control(lease: string): Promise<{ interrupt: InterruptRequest | null; waitingForAnswer: boolean }> {
    const result = await this.request<{ interrupt: InterruptRequest | null; waiting_for_answer?: boolean }>(`/api/work/${lease}/control`);
    return { interrupt: result.interrupt, waitingForAnswer: result.waiting_for_answer === true };
  }

  acknowledgeInterrupt(lease: string): Promise<unknown> {
    return this.request<unknown>(`/api/work/${lease}/interrupt-ack`, { method: "POST", body: "{}" });
  }
}
