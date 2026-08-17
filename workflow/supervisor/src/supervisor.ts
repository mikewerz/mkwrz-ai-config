import type { HerdrController } from "./herdr.js";
import { PromptStore, type PromptName, type PromptTemplates } from "./prompts.js";
import { TrackerClient, TrackerError } from "./tracker-client.js";
import { RepositoryReconciler, type RepositoryReconcilerLike } from "./repositories.js";
import type { ClaimedTicket, Provider, SupervisorPresence } from "./types.js";

export interface SupervisorOptions {
  trackerUrl: string;
  supervisorId: string;
  providers: Provider[];
  heartbeatIntervalMs: number;
  idlePollMs: number;
  callbackBaseUrl?: string;
  presence?: SupervisorPresence;
  repositoryReconciler?: RepositoryReconcilerLike;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const ASSIGNMENT_PROMPT_ATTEMPTS = 2;

function callbackValues(ticket: ClaimedTicket, callbackBaseUrl: string): Record<string, string> {
  const lease = ticket.frontmatter.execution.lease_id;
  return {
    ticket_id: ticket.frontmatter.id,
    phase: ticket.frontmatter.phase,
    callback_base: new URL(`/api/work/${lease}/`, callbackBaseUrl).toString(),
  };
}

export function buildAssignmentPrompt(ticket: ClaimedTicket, callbackBaseUrl: string, projectRoot: string, prompts: PromptStore): string {
  const phase = ticket.frontmatter.phase;
  const values = {
    ...callbackValues(ticket, callbackBaseUrl),
    ticket_path: ticket.path,
    ticket_markdown: ticket.markdown,
    project_root: projectRoot,
  };
  return prompts.render("assignment", { ...values, phase_instructions: prompts.render(phase, values) });
}

export function buildCallbackReminder(ticket: ClaimedTicket, callbackBaseUrl: string, prompts: PromptStore): string {
  return prompts.render("callback-reminder", callbackValues(ticket, callbackBaseUrl));
}

export class Supervisor {
  private stopped = false;
  private readonly tracker: TrackerClient;
  private readonly callbackBaseUrl: string;
  private readonly prompts: PromptStore;
  private readonly repositoryReconciler: RepositoryReconcilerLike | null;
  private repositorySync: Promise<void> | null = null;
  private lastRepositorySyncAt = 0;

  constructor(private readonly herdr: HerdrController, private readonly options: SupervisorOptions) {
    this.tracker = new TrackerClient(options.trackerUrl, options.supervisorId, options.presence?.instanceId);
    this.callbackBaseUrl = options.callbackBaseUrl ?? options.trackerUrl;
    this.prompts = new PromptStore();
    this.repositoryReconciler = options.repositoryReconciler ?? (options.presence ? new RepositoryReconciler(options.presence.projectRoot) : null);
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
      await Promise.all([this.presenceLoop(), ...this.options.providers.map((provider) => this.slotLoop(provider))]);
      return;
    }
    await Promise.all(this.options.providers.map((provider) => this.slotLoop(provider)));
  }

  private async publishPresence(): Promise<void> {
    if (this.options.presence) await this.tracker.heartbeatSupervisor(this.options.presence, this.options.providers);
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
    const invalid = documents.filter((prompt) => !prompt.valid);
    if (invalid.length) throw new Error(`Tracker prompt library is invalid: ${invalid.map((prompt) => `${prompt.name}: ${prompt.errors.join(", ")}`).join("; ")}`);
    const expected: PromptName[] = ["assignment", "specification", "implementation", "review", "guidance", "callback-reminder"];
    const byName = Object.fromEntries(documents.map((prompt) => [prompt.name, prompt.content])) as Partial<PromptTemplates>;
    const missing = expected.filter((name) => typeof byName[name] !== "string");
    if (missing.length) throw new Error(`Tracker prompt library is missing: ${missing.join(", ")}`);
    this.prompts.replace(byName as PromptTemplates);
  }

  private async promptAssignment(provider: Provider, ticket: ClaimedTicket, paneId: string): Promise<void> {
    const assignment = buildAssignmentPrompt(ticket, this.callbackBaseUrl, this.herdr.projectRoot, this.prompts);
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
        const ticket = await this.tracker.claim(provider, this.options.providers);
        if (!ticket) { await sleep(this.options.idlePollMs); continue; }
        await this.runAssignment(provider, ticket);
      } catch (error) {
        console.error(`[${provider}] supervisor loop failed`, error);
        await sleep(this.options.idlePollMs);
      }
    }
  }

  private async runAssignment(provider: Provider, ticket: ClaimedTicket): Promise<void> {
    const lease = ticket.frontmatter.execution.lease_id;
    const phase = ticket.frontmatter.phase;
    const existing = ticket.frontmatter.agents[phase];
    const conversation = phase === "review" ? "review" : "work";
    const observation = await this.herdr.ensureAgent(ticket.frontmatter.id, provider, conversation, existing.herdr_pane_id, existing.session_ref);
    let cursor = 0;
    await this.tracker.heartbeat(lease, { ...observation, guidanceCursor: cursor });
    if (ticket.frontmatter.execution.interrupt_request) {
      await this.herdr.interrupt(observation.paneId);
      await this.tracker.acknowledgeInterrupt(lease);
      return;
    }
    // Do not enter the reminder loop until Herdr has observed assignment activity.
    // A stalled submission is retried with the complete durable assignment.
    await this.promptAssignment(provider, ticket, observation.paneId);
    let callbackReminderSent = false;
    let knownSessionRef = observation.sessionRef;
    let lastHeartbeatAt = Date.now();

    while (!this.stopped) {
      await sleep(Math.min(this.options.idlePollMs, this.options.heartbeatIntervalMs));
      const control = await this.tracker.control(lease).catch((error) => {
        if (error instanceof TrackerError && error.status === 409) return null;
        throw error;
      });
      if (control?.interrupt) {
        await this.herdr.interrupt(observation.paneId);
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
        await this.herdr.prompt(current.paneId, this.prompts.render("guidance", { ticket_id: ticket.frontmatter.id, message: item.message }));
        cursor = Math.max(cursor, item.sequence);
      }

      const sessionAppeared = current.sessionRef !== null && current.sessionRef !== knownSessionRef;
      const heartbeatDue = Date.now() - lastHeartbeatAt >= this.options.heartbeatIntervalMs;
      if (guidance.length > 0 || sessionAppeared || heartbeatDue) {
        try { await this.tracker.heartbeat(lease, { ...current, guidanceCursor: cursor }); }
        catch (error) { if (error instanceof TrackerError && error.status === 409) return; throw error; }
        knownSessionRef = current.sessionRef;
        lastHeartbeatAt = Date.now();
      }

      if (!control?.waitingForAnswer && !callbackReminderSent && (current.state === "idle" || current.state === "done")) {
        callbackReminderSent = true;
        await this.refreshPrompts();
        await this.herdr.prompt(current.paneId, buildCallbackReminder(ticket, this.callbackBaseUrl, this.prompts));
      }
    }
  }
}
