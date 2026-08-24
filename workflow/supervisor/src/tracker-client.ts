import type { ActivityCapability, AgentObservation, ArtifactRecord, ClaimedIntakeRun, ClaimedTicket, Guidance, HarnessTelemetrySnapshot, IntakeCandidate, InterruptRequest, Provider, SupervisorPresence, TrackerConfig, TrackerPrompt } from "./types.js";

export class TrackerError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string | null = null) { super(message); }
}

export interface TrackerClientTimeouts {
  requestMs?: number;
  claimMs?: number;
  artifactMs?: number;
}

function timeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 1_000 ? Number(value) : fallback;
}

export class TrackerClient {
  private readonly requestTimeoutMs: number;
  private readonly claimTimeoutMs: number;
  private readonly artifactTimeoutMs: number;

  constructor(private readonly baseUrl: string, private readonly supervisorId: string, private readonly instanceId?: string, timeouts: TrackerClientTimeouts = {}) {
    this.requestTimeoutMs = timeout(timeouts.requestMs, 15_000);
    this.claimTimeoutMs = timeout(timeouts.claimMs, 45_000);
    this.artifactTimeoutMs = timeout(timeouts.artifactMs, 5 * 60_000);
  }

  private async fetch(path: string, init?: RequestInit, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    try { return await fetch(new URL(path, this.baseUrl), { ...init, signal }); }
    catch (error) {
      if (signal.aborted) throw new TrackerError(504, `Tracker request timed out after ${timeoutMs}ms`, "TRACKER_TIMEOUT");
      throw error;
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, {
      ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; code?: string };
      throw new TrackerError(response.status, body.error ?? response.statusText, body.code ?? null);
    }
    return response.json() as Promise<T>;
  }

  async claim(provider: Provider, availableProviders: Provider[], activityCapabilities: ActivityCapability[]): Promise<ClaimedTicket | null> {
    const response = await this.fetch("/api/work/claim", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supervisor_id: this.supervisorId, instance_id: this.instanceId, provider, available_providers: availableProviders, activity_capabilities: activityCapabilities, wait_seconds: 30 }),
    }, this.claimTimeoutMs);
    if (response.status === 204) return null;
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string; code?: string }; throw new TrackerError(response.status, body.error ?? response.statusText, body.code ?? null); }
    return response.json() as Promise<ClaimedTicket>;
  }

  async claimActivity(availableProviders: Provider[], activityCapabilities: ActivityCapability[]): Promise<ClaimedTicket | null> {
    const response = await this.fetch("/api/work/claim-activity", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supervisor_id: this.supervisorId, instance_id: this.instanceId, available_providers: availableProviders, activity_capabilities: activityCapabilities }),
    }, this.requestTimeoutMs);
    if (response.status === 204) return null;
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string; code?: string }; throw new TrackerError(response.status, body.error ?? response.statusText, body.code ?? null); }
    return response.json() as Promise<ClaimedTicket>;
  }

  async claimIntake(activityCapabilities: ActivityCapability[]): Promise<ClaimedIntakeRun | null> {
    const response = await this.fetch("/api/intake/work/claim", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supervisor_id: this.supervisorId, instance_id: this.instanceId, activity_capabilities: activityCapabilities }),
    }, this.requestTimeoutMs);
    if (response.status === 204) return null;
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string; code?: string }; throw new TrackerError(response.status, body.error ?? response.statusText, body.code ?? null); }
    return (await response.json() as { run: ClaimedIntakeRun }).run;
  }

  heartbeatIntake(lease: string): Promise<unknown> {
    return this.request<unknown>(`/api/intake/work/${lease}/heartbeat`, { method: "POST", body: "{}" });
  }

  completeIntake(lease: string, result: { candidates: IntakeCandidate[]; cursor?: unknown; output: string }): Promise<unknown> {
    return this.request<unknown>(`/api/intake/work/${lease}/complete`, { method: "POST", body: JSON.stringify(result) });
  }

  failIntake(lease: string, reason: string, output?: string): Promise<unknown> {
    return this.request<unknown>(`/api/intake/work/${lease}/fail`, { method: "POST", body: JSON.stringify({ reason, ...(output ? { output } : {}) }) });
  }

  activityResult(lease: string, result: { success: boolean; summary: string; output: string; stdout?: string; stderr?: string; exit_code: number | null; script_path: string | null; working_directory: string | null; checkpoints?: unknown[]; structured_result?: { metadata?: Record<string, unknown>; external_references?: Array<{ type: string; id: string; url?: string }> } }): Promise<unknown> {
    return this.request<unknown>(`/api/work/${lease}/activity-result`, { method: "POST", body: JSON.stringify(result) });
  }

  async uploadArtifact(lease: string, input: { kind: "script_artifact" | "quality_report" | "checkpoint_bundle"; artifactName: string; filename: string; contentType: string; content: Buffer }): Promise<ArtifactRecord> {
    const query = new URLSearchParams({ kind: input.kind, artifact_name: input.artifactName, filename: input.filename, content_type: input.contentType });
    const response = await this.fetch(`/api/work/${lease}/artifacts?${query}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(input.content),
    }, this.artifactTimeoutMs);
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string; code?: string }; throw new TrackerError(response.status, body.error ?? response.statusText, body.code ?? null); }
    return (await response.json() as { artifact: ArtifactRecord }).artifact;
  }

  async downloadArtifact(ticketId: string, artifactId: string): Promise<Buffer> {
    const response = await this.fetch(`/api/tickets/${encodeURIComponent(ticketId)}/artifacts/${encodeURIComponent(artifactId)}/content`, undefined, this.artifactTimeoutMs);
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string; code?: string }; throw new TrackerError(response.status, body.error ?? response.statusText, body.code ?? null); }
    return Buffer.from(await response.arrayBuffer());
  }

  heartbeatActivity(lease: string): Promise<unknown> {
    return this.request<unknown>(`/api/work/${lease}/heartbeat`, { method: "POST", body: "{}" });
  }

  async config(): Promise<TrackerConfig> {
    return (await this.request<{ config: TrackerConfig }>("/api/config")).config;
  }

  async prompts(): Promise<TrackerPrompt[]> {
    return (await this.request<{ prompts: TrackerPrompt[] }>("/api/prompts")).prompts;
  }

  heartbeatSupervisor(presence: SupervisorPresence, providers: Provider[], activityCapabilities: ActivityCapability[]): Promise<unknown> {
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
        activity_capabilities: activityCapabilities,
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

  heartbeat(lease: string, observation: AgentObservation & { guidanceCursor: number; telemetry?: HarnessTelemetrySnapshot | null; telemetryBaseline?: HarnessTelemetrySnapshot | null }) {
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
        ...(observation.telemetry ? { telemetry: observation.telemetry } : {}),
        ...(observation.telemetryBaseline ? { telemetry_baseline: observation.telemetryBaseline } : {}),
      }),
    });
  }

  renew(lease: string): Promise<{ active: boolean }> {
    return this.request<{ active: boolean }>(`/api/work/${lease}/heartbeat`, { method: "POST", body: "{}" });
  }

  confirmAssignmentDelivery(lease: string): Promise<unknown> {
    return this.request<unknown>(`/api/work/${lease}/delivered`, { method: "POST", body: "{}" });
  }

  rejectAssignmentDelivery(lease: string, reason: string): Promise<{ requeued: boolean; blocked: boolean }> {
    return this.request<{ requeued: boolean; blocked: boolean }>(`/api/work/${lease}/delivery-failed`, {
      method: "POST", body: JSON.stringify({ reason }),
    });
  }

  telemetry(lease: string, snapshot: HarnessTelemetrySnapshot, baseline?: HarnessTelemetrySnapshot | null): Promise<unknown> {
    return this.request<unknown>(`/api/work/${lease}/telemetry`, {
      method: "POST", body: JSON.stringify({ telemetry: snapshot, ...(baseline ? { telemetry_baseline: baseline } : {}) }),
    });
  }

  finalize(lease: string, runtime: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(`/api/work/${lease}/finalize`, { method: "POST", body: JSON.stringify({ runtime }) });
  }

  async guidance(lease: string, after: number): Promise<Guidance[]> {
    const result = await this.request<{ guidance: Guidance[] }>(`/api/work/${lease}/guidance?after=${after}`);
    return result.guidance;
  }

  assignment(lease: string): Promise<ClaimedTicket> {
    return this.request<ClaimedTicket>(`/api/work/${lease}/assignment`);
  }

  async control(lease: string): Promise<{ interrupt: InterruptRequest | null; waitingForAnswer: boolean }> {
    const result = await this.request<{ interrupt: InterruptRequest | null; waiting_for_answer?: boolean }>(`/api/work/${lease}/control`);
    return { interrupt: result.interrupt, waitingForAnswer: result.waiting_for_answer === true };
  }

  acknowledgeInterrupt(lease: string): Promise<unknown> {
    return this.request<unknown>(`/api/work/${lease}/interrupt-ack`, { method: "POST", body: "{}" });
  }
}
