import type { HerdrController } from "./herdr.js";
import { PromptStore, type PromptName, type PromptTemplates } from "./prompts.js";
import { TrackerClient, TrackerError } from "./tracker-client.js";
import { RepositoryReconciler, type RepositoryReconcilerLike } from "./repositories.js";
import type { ActivityCapability, ClaimedTicket, Provider, SupervisorPresence } from "./types.js";
import { detectActivityCapabilities, runRepositoryActivity } from "./activities.js";
import { TelemetryCollector, zeroTelemetryBaseline, type TelemetryContext } from "./telemetry.js";
import type { HarnessTelemetrySnapshot } from "./types.js";
import { AssignmentBundleWriter, assignmentValues, type AssignmentBundle } from "./assignments.js";

export interface SupervisorOptions {
  trackerUrl: string;
  supervisorId: string;
  providers: Provider[];
  heartbeatIntervalMs: number;
  idlePollMs: number;
  callbackBaseUrl?: string;
  assignmentRoot?: string;
  presence?: SupervisorPresence;
  repositoryReconciler?: RepositoryReconcilerLike;
  telemetryCollector?: Pick<TelemetryCollector, "collect">;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const ASSIGNMENT_PROMPT_ATTEMPTS = 2;

function bundleValues(ticket: ClaimedTicket, callbackBaseUrl: string, projectRoot: string, bundle: AssignmentBundle): Record<string, string> {
  return {
    ...assignmentValues(ticket, callbackBaseUrl, projectRoot),
    assignment_directory: bundle.runDirectory,
    start_here_path: bundle.startHerePath,
    callback_helper_path: bundle.callbackHelperPath,
  };
}

export function buildAssignmentPrompt(ticket: ClaimedTicket, callbackBaseUrl: string, projectRoot: string, prompts: PromptStore, bundle: AssignmentBundle): string {
  const values = bundleValues(ticket, callbackBaseUrl, projectRoot, bundle);
  const instructions = ticket.node_prompt
    ? prompts.renderContent(ticket.node_prompt.id, ticket.node_prompt.content, values)
    : prompts.render(ticket.frontmatter.phase, values);
  return prompts.render("assignment", { ...values, phase_instructions: instructions });
}

export function buildCallbackReminder(ticket: ClaimedTicket, callbackBaseUrl: string, projectRoot: string, prompts: PromptStore, bundle: AssignmentBundle): string {
  return prompts.render("callback-reminder", bundleValues(ticket, callbackBaseUrl, projectRoot, bundle));
}

export class Supervisor {
  private stopped = false;
  private readonly tracker: TrackerClient;
  private readonly callbackBaseUrl: string;
  private readonly prompts: PromptStore;
  private readonly repositoryReconciler: RepositoryReconcilerLike | null;
  private readonly activityCapabilities: ActivityCapability[];
  private repositorySync: Promise<void> | null = null;
  private lastRepositorySyncAt = 0;
  private readonly telemetry: Pick<TelemetryCollector, "collect">;
  private readonly assignments: AssignmentBundleWriter;

  constructor(private readonly herdr: HerdrController, private readonly options: SupervisorOptions) {
    this.tracker = new TrackerClient(options.trackerUrl, options.supervisorId, options.presence?.instanceId);
    this.callbackBaseUrl = options.callbackBaseUrl ?? options.trackerUrl;
    this.prompts = new PromptStore();
    this.activityCapabilities = detectActivityCapabilities();
    this.repositoryReconciler = options.repositoryReconciler ?? (options.presence ? new RepositoryReconciler(options.presence.projectRoot) : null);
    this.telemetry = options.telemetryCollector ?? new TelemetryCollector();
    this.assignments = new AssignmentBundleWriter(options.assignmentRoot ?? `${herdr.projectRoot}/.agentic-assignments`, options.supervisorId);
  }

  private async collectTelemetry(context: TelemetryContext): Promise<HarnessTelemetrySnapshot | null> {
    try { return await this.telemetry.collect(context); }
    catch (error) { console.warn(`[${context.harness}] telemetry collection failed for ${context.sessionRef}`, error); return null; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.options.presence) await this.tracker.unregisterSupervisor().catch((error) => console.error("[presence] supervisor unregister failed", error));
  }

  async run(): Promise<void> {
    if (this.options.presence) {
      while (!this.stopped) {
        try { await this.publishPresence(); break; }
        catch (error) { console.error("[presence] initial supervisor registration failed", error); await sleep(this.options.idlePollMs); }
      }
      if (this.stopped) return;
      while (!this.stopped) {
        try { await this.ensureRepositories(true); break; }
        catch (error) { console.error("[repositories] initial reconciliation failed", error); await sleep(this.options.idlePollMs); }
      }
      if (this.stopped) return;
      await Promise.all([this.presenceLoop(), this.activityLoop(), ...this.options.providers.map((provider) => this.slotLoop(provider))]);
      return;
    }
    await Promise.all([this.activityLoop(), ...this.options.providers.map((provider) => this.slotLoop(provider))]);
  }

  private async publishPresence(): Promise<void> {
    if (this.options.presence) await this.tracker.heartbeatSupervisor(this.options.presence, this.options.providers, this.activityCapabilities);
  }

  private async ensureRepositories(force = false): Promise<void> {
    if (!this.repositoryReconciler) return;
    if (!force && Date.now() - this.lastRepositorySyncAt < this.options.heartbeatIntervalMs) return;
    if (this.repositorySync) return this.repositorySync;
    this.repositorySync = (async () => {
      const config = await this.tracker.config();
      await this.repositoryReconciler!.reconcile(config.repositories);
      this.lastRepositorySyncAt = Date.now();
    })();
    try { await this.repositorySync; }
    finally { this.repositorySync = null; }
  }

  private async refreshPrompts(): Promise<void> {
    const documents = await this.tracker.prompts();
    const expected: PromptName[] = ["assignment", "guidance", "callback-reminder"];
    const required = documents.filter((prompt) => expected.includes(prompt.name));
    const invalid = required.filter((prompt) => !prompt.valid);
    if (invalid.length) throw new Error(`Required tracker prompts are invalid: ${invalid.map((prompt) => `${prompt.name}: ${prompt.errors.join(", ")}`).join("; ")}`);
    const byName = Object.fromEntries(documents.filter((prompt) => prompt.valid).map((prompt) => [prompt.name, prompt.content])) as Partial<PromptTemplates>;
    const missing = expected.filter((name) => typeof byName[name] !== "string");
    if (missing.length) throw new Error(`Tracker prompt library is missing: ${missing.join(", ")}`);
    this.prompts.replace(byName as PromptTemplates);
  }

  private async promptAssignment(provider: Provider, ticket: ClaimedTicket, paneId: string, bundle: AssignmentBundle): Promise<void> {
    const assignment = buildAssignmentPrompt(ticket, this.callbackBaseUrl, this.herdr.projectRoot, this.prompts, bundle);
    for (let attempt = 1; attempt <= ASSIGNMENT_PROMPT_ATTEMPTS; attempt += 1) {
      if (await this.herdr.promptAndConfirm(paneId, assignment)) return;
      if (attempt < ASSIGNMENT_PROMPT_ATTEMPTS) {
        console.warn(`[${provider}] assignment prompt did not start for ${ticket.frontmatter.id}; retrying the full assignment`);
      }
    }
    throw new Error(`Herdr did not start the assignment prompt for ${ticket.frontmatter.id} after ${ASSIGNMENT_PROMPT_ATTEMPTS} attempts`);
  }

  private async presenceLoop(): Promise<void> {
    while (!this.stopped) {
      await sleep(this.options.heartbeatIntervalMs);
      if (this.stopped) break;
      try { await this.ensureRepositories(true); }
      catch (error) { console.error("[repositories] reconciliation failed", error); }
      try { await this.publishPresence(); }
      catch (error) { console.error("[presence] supervisor heartbeat failed", error); }
    }
  }

  private async slotLoop(provider: Provider): Promise<void> {
    let recoveryChecked = false;
    while (!this.stopped) {
      try {
        await this.ensureRepositories();
        await this.refreshPrompts();
        if (!recoveryChecked) {
          recoveryChecked = true;
          const [active] = await this.tracker.active(provider);
          if (active) { await this.runAssignment(provider, active); continue; }
        }
        const ticket = await this.tracker.claim(provider, this.options.providers, this.activityCapabilities);
        if (!ticket) { await sleep(this.options.idlePollMs); continue; }
        await this.runAssignment(provider, ticket);
      } catch (error) {
        console.error(`[${provider}] supervisor loop failed`, error);
        await sleep(this.options.idlePollMs);
      }
    }
  }

  private async activityLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.ensureRepositories();
        const ticket = await this.tracker.claimActivity(this.options.providers, this.activityCapabilities);
        if (!ticket) { await sleep(this.options.idlePollMs); continue; }
        const lease = ticket.frontmatter.execution.lease_id;
        const controller = new AbortController();
        let settled = false;
        const activity = runRepositoryActivity(this.herdr.projectRoot, ticket, controller.signal)
          .catch((error) => ({ success: false, summary: (error as Error).message, output: "", exit_code: null, script_path: null, working_directory: null }))
          .finally(() => { settled = true; });
        try {
          let interrupted = false;
          let lastHeartbeatAt = Date.now();
          while (!settled && !this.stopped) {
            await sleep(Math.min(this.options.idlePollMs, this.options.heartbeatIntervalMs));
            const control = await this.tracker.control(lease).catch((error) => {
              if (error instanceof TrackerError && error.status === 409) return null;
              throw error;
            });
            if (control === null) { controller.abort(); await activity; interrupted = true; break; }
            if (control.interrupt) {
              controller.abort();
              await activity;
              await this.tracker.acknowledgeInterrupt(lease);
              interrupted = true;
              break;
            }
            if (Date.now() - lastHeartbeatAt >= this.options.heartbeatIntervalMs) {
              await this.tracker.heartbeatActivity(lease);
              lastHeartbeatAt = Date.now();
            }
          }
          if (this.stopped) {
            if (!settled) controller.abort();
            await activity;
            break;
          }
          if (interrupted) continue;
          const finalControl = await this.tracker.control(lease).catch((error) => {
            if (error instanceof TrackerError && error.status === 409) return null;
            throw error;
          });
          if (finalControl === null) { controller.abort(); continue; }
          if (finalControl.interrupt) {
            controller.abort(); await activity; await this.tracker.acknowledgeInterrupt(lease); continue;
          }
          const result = await activity;
          await this.tracker.activityResult(lease, result);
        } finally {
          if (!settled) {
            controller.abort();
            await activity;
          }
        }
      } catch (error) {
        console.error("[activity] supervisor loop failed", error);
        await sleep(this.options.idlePollMs);
      }
    }
  }

  private async runAssignment(provider: Provider, ticket: ClaimedTicket): Promise<void> {
    const lease = ticket.frontmatter.execution.lease_id;
    let currentTicket = ticket;
    const bundle = await this.assignments.prepare(currentTicket, this.callbackBaseUrl, this.herdr.projectRoot, this.prompts);
    const phase = ticket.frontmatter.phase;
    const conversation = ticket.workflow_node?.conversation_key ?? (phase === "review" ? "review" : "work");
    const existing = ticket.frontmatter.conversations?.[conversation] ?? ticket.frontmatter.agents[phase];
    const observation = await this.herdr.ensureAgent(ticket.frontmatter.id, provider, conversation, existing.herdr_pane_id, existing.session_ref, ticket.resolved_agent_profile);
    const telemetryContext = (sessionRef: string): TelemetryContext => ({ harness: provider, sessionRef, cwd: observation.foregroundCwd ?? observation.cwd });
    let telemetryBaseline = ticket.frontmatter.execution.telemetry?.baseline ?? null;
    const captureBaseline = (snapshot: HarnessTelemetrySnapshot): HarnessTelemetrySnapshot => {
      if (telemetryBaseline && (telemetryBaseline.harness !== snapshot.harness || telemetryBaseline.session_ref !== snapshot.session_ref)) {
        telemetryBaseline = zeroTelemetryBaseline(snapshot);
      }
      if (!telemetryBaseline) telemetryBaseline = existing.session_ref && snapshot.session_ref === existing.session_ref
        ? snapshot : zeroTelemetryBaseline(snapshot);
      return telemetryBaseline;
    };
    const initialTelemetry = observation.sessionRef ? await this.collectTelemetry(telemetryContext(observation.sessionRef)) : null;
    if (initialTelemetry) captureBaseline(initialTelemetry);
    let cursor = 0;
    await this.tracker.heartbeat(lease, {
      ...observation, guidanceCursor: cursor,
      ...(initialTelemetry ? { telemetry: initialTelemetry } : {}),
      ...(telemetryBaseline ? { telemetryBaseline } : {}),
    });
    if (ticket.frontmatter.execution.interrupt_request) {
      await this.herdr.interrupt(observation.paneId);
      await this.tracker.acknowledgeInterrupt(lease);
      return;
    }
    // Do not enter the reminder loop until Herdr has observed assignment activity.
    // A stalled submission is retried with the complete durable assignment.
    await this.promptAssignment(provider, currentTicket, observation.paneId, bundle);
    let callbackReminderSent = false;
    let knownSessionRef = observation.sessionRef;
    let lastHeartbeatAt = Date.now();

    while (!this.stopped) {
      await sleep(Math.min(this.options.idlePollMs, this.options.heartbeatIntervalMs));
      const control = await this.tracker.control(lease).catch((error) => {
        if (error instanceof TrackerError && error.status === 409) return null;
        throw error;
      });
      if (control === null) {
        try {
          const finalObservation = await this.herdr.observe(observation.paneId);
          if (finalObservation.sessionRef) {
            const finalTelemetry = await this.collectTelemetry(telemetryContext(finalObservation.sessionRef));
            if (finalTelemetry) await this.tracker.telemetry(lease, finalTelemetry, captureBaseline(finalTelemetry)).catch(() => undefined);
          }
        } catch { /* the completed node may already have closed its pane */ }
        await this.herdr.interrupt(observation.paneId).catch(() => undefined);
        return;
      }
      if (control?.interrupt) {
        await this.herdr.interrupt(observation.paneId);
        try {
          const finalObservation = await this.herdr.observe(observation.paneId);
          if (finalObservation.sessionRef) {
            const finalTelemetry = await this.collectTelemetry(telemetryContext(finalObservation.sessionRef));
            if (finalTelemetry) await this.tracker.telemetry(lease, finalTelemetry, captureBaseline(finalTelemetry)).catch(() => undefined);
          }
        } catch { /* interruption telemetry is best effort */ }
        await this.tracker.acknowledgeInterrupt(lease);
        return;
      }
      let current;
      try { current = await this.herdr.observe(observation.paneId); }
      catch (error) { console.error(`[${provider}] Herdr agent disappeared for ${ticket.frontmatter.id}`, error); return; }

      const guidance = await this.tracker.guidance(lease, cursor).catch((error) => {
        if (error instanceof TrackerError && error.status === 409) return null;
        throw error;
      });
      if (guidance === null) return;
      for (const item of guidance) {
        await this.refreshPrompts();
        currentTicket = await this.tracker.assignment(lease);
        await this.assignments.refresh(bundle, currentTicket, this.callbackBaseUrl, this.herdr.projectRoot, this.prompts);
        const updatePath = await this.assignments.appendUpdate(bundle, item);
        await this.herdr.prompt(current.paneId, this.prompts.render("guidance", {
          ...bundleValues(currentTicket, this.callbackBaseUrl, this.herdr.projectRoot, bundle),
          message: item.message, update_path: updatePath,
        }));
        cursor = Math.max(cursor, item.sequence);
      }

      const sessionAppeared = current.sessionRef !== null && current.sessionRef !== knownSessionRef;
      const heartbeatDue = Date.now() - lastHeartbeatAt >= this.options.heartbeatIntervalMs;
      if (guidance.length > 0 || sessionAppeared || heartbeatDue) {
        const currentTelemetry = current.sessionRef ? await this.collectTelemetry(telemetryContext(current.sessionRef)) : null;
        if (currentTelemetry) captureBaseline(currentTelemetry);
        try {
          await this.tracker.heartbeat(lease, {
            ...current, guidanceCursor: cursor,
            ...(currentTelemetry ? { telemetry: currentTelemetry } : {}),
            ...(telemetryBaseline ? { telemetryBaseline } : {}),
          });
        }
        catch (error) {
          if (error instanceof TrackerError && error.status === 409) {
            if (currentTelemetry) await this.tracker.telemetry(lease, currentTelemetry, captureBaseline(currentTelemetry)).catch(() => undefined);
            return;
          }
          throw error;
        }
        knownSessionRef = current.sessionRef;
        lastHeartbeatAt = Date.now();
      }

      if (!control?.waitingForAnswer && !callbackReminderSent && (current.state === "idle" || current.state === "done")) {
        callbackReminderSent = true;
        await this.refreshPrompts();
        await this.herdr.prompt(current.paneId, buildCallbackReminder(currentTicket, this.callbackBaseUrl, this.herdr.projectRoot, this.prompts, bundle));
      }
    }
  }
}
