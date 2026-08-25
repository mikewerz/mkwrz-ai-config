import type { HerdrController } from "./herdr.js";
import { PromptStore, type PromptName, type PromptTemplates } from "./prompts.js";
import { TrackerClient, TrackerError } from "./tracker-client.js";
import { RepositoryReconciler, type RepositoryReconcilerLike } from "./repositories.js";
import type { ActivityCapability, AgentObservation, ClaimedTicket, Provider, SupervisorPresence } from "./types.js";
import { detectActivityCapabilities, requiredRestoreArtifactIds, runRepositoryActivity, type ActivityResult } from "./activities.js";
import { TelemetryCollector, zeroTelemetryBaseline, type TelemetryContext } from "./telemetry.js";
import type { HarnessTelemetrySnapshot } from "./types.js";
import { AssignmentBundleWriter, assignmentValues, type AssignmentBundle } from "./assignments.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureRepositoryState, fileIdentity, supervisorRuntime } from "./provenance.js";
import { log } from "./logger.js";
import { executeIntakeSource, IntakeExecutionError } from "./intake.js";
import { ExecutionTraceRecorder, type ExecutionTraceSink } from "./execution-trace.js";

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
  agentExecutionEnabled?: boolean;
  trackerRequestTimeoutMs?: number;
  trackerClaimTimeoutMs?: number;
  trackerArtifactTimeoutMs?: number;
  callbackReminderGraceMs?: number;
  assignmentPromptRecoveryMs?: number;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const ASSIGNMENT_PROMPT_RECOVERY_POLL_MS = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deliveryActivityObserved(before: AgentObservation, after: AgentObservation): boolean {
  // Pane revisions advance for ordinary terminal rendering, and a native
  // session reference can appear late during provider startup. Neither proves
  // that the assignment reached the agent. Only Herdr's semantic transition
  // from a settled input-ready state into working is acceptable lifecycle
  // evidence after an ambiguous prompt. Unknown/blocked startup transitions
  // remain unconfirmed and fall through to assignment-specific pane evidence.
  return (before.state === "idle" || before.state === "done") && after.state === "working";
}

function agentCanAcceptInput(observation: AgentObservation): boolean {
  return observation.launchPending !== true && observation.interactiveReady !== false;
}

function stagedComposerEvidence(paneText: string, marker: string): "assignment_marker" | "collapsed_paste" | null {
  if (paneText.includes(marker)) return "assignment_marker";
  return /\[Pasted text(?: #\d+)? \+\d+ lines\]/i.test(paneText) ? "collapsed_paste" : null;
}

type AssignmentDeliveryConfirmation = "direct" | "observed_activity" | "submitted_staged_prompt";

interface ConfirmedAssignmentDelivery {
  observation: AgentObservation;
  confirmation: AssignmentDeliveryConfirmation;
}

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
  private readonly locallyDeliveredLeases = new Set<string>();
  private readonly callbackReminderGraceMs: number;
  private readonly assignmentPromptRecoveryMs: number;

  constructor(private readonly herdr: HerdrController, private readonly options: SupervisorOptions) {
    this.tracker = new TrackerClient(options.trackerUrl, options.supervisorId, options.presence?.instanceId, {
      ...(options.trackerRequestTimeoutMs === undefined ? {} : { requestMs: options.trackerRequestTimeoutMs }),
      ...(options.trackerClaimTimeoutMs === undefined ? {} : { claimMs: options.trackerClaimTimeoutMs }),
      ...(options.trackerArtifactTimeoutMs === undefined ? {} : { artifactMs: options.trackerArtifactTimeoutMs }),
    });
    this.callbackBaseUrl = options.callbackBaseUrl ?? options.trackerUrl;
    this.prompts = new PromptStore();
    this.activityCapabilities = detectActivityCapabilities();
    this.repositoryReconciler = options.repositoryReconciler ?? (options.presence ? new RepositoryReconciler(options.presence.projectRoot) : null);
    this.telemetry = options.telemetryCollector ?? new TelemetryCollector();
    this.assignments = new AssignmentBundleWriter(options.assignmentRoot ?? `${herdr.projectRoot}/.agentic-assignments`, options.supervisorId);
    this.callbackReminderGraceMs = Number.isFinite(options.callbackReminderGraceMs) && Number(options.callbackReminderGraceMs) >= 0
      ? Number(options.callbackReminderGraceMs) : 60_000;
    this.assignmentPromptRecoveryMs = Number.isFinite(options.assignmentPromptRecoveryMs) && Number(options.assignmentPromptRecoveryMs) >= 0
      ? Number(options.assignmentPromptRecoveryMs) : 30_000;
  }

  private async collectTelemetry(context: TelemetryContext): Promise<HarnessTelemetrySnapshot | null> {
    try { return await this.telemetry.collect(context); }
    catch (error) { log("warn", "telemetry.collection_failed", { provider: context.harness, session_ref: context.sessionRef }, error); return null; }
  }

  private async finalizeExecution(
    ticket: ClaimedTicket,
    lease: string,
    repositoryStart: Awaited<ReturnType<typeof captureRepositoryState>>,
    runtime: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.tracker.finalize(lease, {
        supervisor: { id: this.options.supervisorId, ...supervisorRuntime(this.herdr.projectRoot) },
        assignment: {
          ticket_id: ticket.frontmatter.id,
          workflow_id: ticket.frontmatter.workflow.id,
          workflow_revision: ticket.frontmatter.workflow.revision,
          node_id: ticket.workflow_node.id,
          incoming: ticket.frontmatter.workflow.incoming ?? null,
        },
        repositories: {
          before: repositoryStart,
          after: await captureRepositoryState(this.herdr.projectRoot, ticket),
        },
        ...runtime,
      });
    } catch (error) {
      log("warn", "provenance.finalize_failed", { ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: lease }, error);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.options.presence) await this.tracker.unregisterSupervisor().catch((error) => log("error", "presence.unregister_failed", { supervisor_id: this.options.supervisorId }, error));
  }

  async run(): Promise<void> {
    const agentSlots = this.options.agentExecutionEnabled === false ? [] : this.options.providers.map((provider) => this.slotLoop(provider));
    if (this.options.presence) {
      while (!this.stopped) {
        try { await this.publishPresence(); break; }
        catch (error) { log("error", "presence.initial_registration_failed", { supervisor_id: this.options.supervisorId }, error); await sleep(this.options.idlePollMs); }
      }
      if (this.stopped) return;
      while (!this.stopped) {
        try { await this.ensureRepositories(true); break; }
        catch (error) { log("error", "repository.initial_reconciliation_failed", { supervisor_id: this.options.supervisorId }, error); await sleep(this.options.idlePollMs); }
      }
      if (this.stopped) return;
      await Promise.all([this.presenceLoop(), this.intakeLoop(), this.activityLoop(), ...agentSlots]);
      return;
    }
    await Promise.all([this.intakeLoop(), this.activityLoop(), ...agentSlots]);
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

  private async promptAssignment(provider: Provider, ticket: ClaimedTicket, paneId: string, bundle: AssignmentBundle, initial: AgentObservation, trace?: ExecutionTraceSink): Promise<ConfirmedAssignmentDelivery> {
    const assignment = buildAssignmentPrompt(ticket, this.callbackBaseUrl, this.herdr.projectRoot, this.prompts, bundle);
    trace?.record("delivery.assignment_prepared", {
      assignment_path: bundle.startHerePath, callback_helper_path: bundle.callbackHelperPath,
      prompt_bytes: Buffer.byteLength(assignment), prompt_sha256: createHash("sha256").update(assignment).digest("hex"),
    });
    if (await this.herdr.promptAndConfirm(paneId, assignment)) {
      trace?.record("delivery.confirmed", { confirmation: "direct" });
      return { observation: initial, confirmation: "direct" };
    }

    // Herdr's stalled and timeout results are ambiguous for full-screen agents.
    // Claude may already have the text in its composer, or may process it after
    // Herdr's wait window. Never paste the assignment a second time.
    const deadline = Date.now() + this.assignmentPromptRecoveryMs;
    let observation = initial;
    let readFailureLogged = false;
    const marker = bundle.startHerePath;
    log("warn", "assignment.prompt_delivery_uncertain_recovery_started", {
      provider, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id,
      lease_id: ticket.frontmatter.execution.lease_id, recovery_ms: this.assignmentPromptRecoveryMs,
    });
    trace?.record("delivery.recovery_started", { recovery_ms: this.assignmentPromptRecoveryMs, initial_state: initial.state });
    while (true) {
      const after = await this.herdr.observe(paneId);
      if (deliveryActivityObserved(initial, after)) {
        trace?.record("delivery.evaluated", {
          accepted: true, confirmation: "observed_activity", evidence: "settled_to_working_transition",
          before_state: initial.state, after_state: after.state,
        });
        log("warn", "assignment.prompt_recovered", {
          provider, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id,
          lease_id: ticket.frontmatter.execution.lease_id, recovery: "observed_activity", activity_evidence: "state_transition_to_working",
        });
        return { observation: after, confirmation: "observed_activity" };
      }
      observation = after;

      let paneText = "";
      try { paneText = await this.herdr.readText(paneId); }
      catch (error) {
        if (!readFailureLogged) {
          readFailureLogged = true;
          log("warn", "assignment.prompt_read_failed", {
            provider, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id,
            lease_id: ticket.frontmatter.execution.lease_id,
          }, error);
        }
      }
      const composerEvidence = stagedComposerEvidence(paneText, marker);
      trace?.record("delivery.evaluated", {
        accepted: Boolean(agentCanAcceptInput(after) && composerEvidence),
        before_state: initial.state, after_state: after.state,
        revision_changed: initial.revision !== after.revision,
        session_ref_appeared: initial.sessionRef === null && after.sessionRef !== null,
        interactive_ready: after.interactiveReady ?? null, launch_pending: after.launchPending ?? null,
        composer_evidence: composerEvidence,
        ignored_signals: [
          ...(initial.revision !== after.revision ? ["revision_changed"] : []),
          ...(initial.sessionRef === null && after.sessionRef !== null ? ["session_ref_appeared"] : []),
        ],
      });
      if (agentCanAcceptInput(after) && composerEvidence) {
        await this.herdr.sendKeys(paneId, "enter");
        const submitted = await this.herdr.observe(paneId).catch(() => observation);
        trace?.record("delivery.confirmed", { confirmation: "submitted_staged_prompt", composer_evidence: composerEvidence });
        log("warn", "assignment.prompt_recovered", {
          provider, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id,
          lease_id: ticket.frontmatter.execution.lease_id, recovery: "submitted_staged_prompt", composer_evidence: composerEvidence,
        });
        return { observation: submitted, confirmation: "submitted_staged_prompt" };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(ASSIGNMENT_PROMPT_RECOVERY_POLL_MS, remaining));
    }
    try {
      trace?.record("delivery.recovery_expired", { recovery_ms: this.assignmentPromptRecoveryMs, action: "clear_composer" });
      await this.herdr.sendKeys(paneId, "ctrl+c");
      log("warn", "assignment.prompt_recovery_cleared_composer", {
        provider, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id,
        lease_id: ticket.frontmatter.execution.lease_id, pane_id: paneId,
      });
    } catch (error) {
      log("warn", "assignment.prompt_recovery_clear_failed", {
        provider, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id,
        lease_id: ticket.frontmatter.execution.lease_id, pane_id: paneId,
      }, error);
    }
    throw new Error(`Herdr did not expose or start the assignment prompt for ${ticket.frontmatter.id} within ${this.assignmentPromptRecoveryMs}ms`);
  }

  private startLeaseRenewal(ticket: ClaimedTicket, lease: string): () => void {
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || this.stopped) return;
      inFlight = true;
      void this.tracker.renew(lease).catch((error) => {
        if (!(error instanceof TrackerError && error.status === 409)) {
          log("warn", "work.lease_renewal_failed", {
            provider: ticket.frontmatter.execution.provider, supervisor_id: this.options.supervisorId,
            ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: lease,
          }, error);
        }
      }).finally(() => { inFlight = false; });
    }, this.options.heartbeatIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async presenceLoop(): Promise<void> {
    while (!this.stopped) {
      await sleep(this.options.heartbeatIntervalMs);
      if (this.stopped) break;
      try { await this.ensureRepositories(true); }
      catch (error) { log("error", "repository.reconciliation_failed", { supervisor_id: this.options.supervisorId }, error); }
      try { await this.publishPresence(); }
      catch (error) { log("error", "presence.heartbeat_failed", { supervisor_id: this.options.supervisorId }, error); }
    }
  }

  private async slotLoop(provider: Provider): Promise<void> {
    while (!this.stopped) {
      try {
        await this.ensureRepositories();
        await this.refreshPrompts();
        const [active] = await this.tracker.active(provider);
        if (active) { await this.runAssignment(provider, active); continue; }
        const ticket = await this.tracker.claim(provider, this.options.providers, this.activityCapabilities);
        if (!ticket) { await sleep(this.options.idlePollMs); continue; }
        log("info", "work.claimed", { provider, supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: ticket.frontmatter.execution.lease_id });
        await this.runAssignment(provider, ticket);
      } catch (error) {
        log("error", "agent.loop_failed", { provider, supervisor_id: this.options.supervisorId }, error);
        await sleep(this.options.idlePollMs);
      }
    }
  }

  private async activityLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.ensureRepositories();
        const ticket = await this.tracker.claimActivity(this.options.agentExecutionEnabled === false ? [] : this.options.providers, this.activityCapabilities);
        if (!ticket) { await sleep(this.options.idlePollMs); continue; }
        const lease = ticket.frontmatter.execution.lease_id;
        log("info", "work.claimed", { supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: lease, node_type: ticket.workflow_node.type });
        const repositoryStart = await captureRepositoryState(this.herdr.projectRoot, ticket);
        const activityDirectory = join(this.assignments.root, this.options.supervisorId, "tickets", ticket.frontmatter.id, "activity-runs", ticket.frontmatter.execution.node_run_id ?? lease);
        const artifactPaths: Record<string, string> = {};
        const restoreArtifactIds = requiredRestoreArtifactIds(ticket);
        if (restoreArtifactIds.length) await mkdir(activityDirectory, { recursive: true });
        for (const artifactId of restoreArtifactIds) {
          const path = join(activityDirectory, `${artifactId}.bundle`);
          await writeFile(path, await this.tracker.downloadArtifact(ticket.frontmatter.id, artifactId), { mode: 0o600 });
          artifactPaths[artifactId] = path;
        }
        const controller = new AbortController();
        let settled = false;
        const activity: Promise<ActivityResult> = runRepositoryActivity(this.herdr.projectRoot, ticket, controller.signal, { directory: activityDirectory, artifact_paths: artifactPaths })
          .catch((error): ActivityResult => ({ success: false, summary: (error as Error).message, output: "", exit_code: null, script_path: null, working_directory: null }))
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
          const uploaded = new Map<string, string>();
          for (const artifact of result.pending_artifacts ?? []) {
            const record = await this.tracker.uploadArtifact(lease, {
              kind: artifact.kind, artifactName: artifact.key, filename: artifact.filename, contentType: artifact.content_type, content: await readFile(artifact.path),
              ...(artifact.presentation ? { presentation: artifact.presentation } : {}),
            });
            uploaded.set(artifact.key, record.id);
          }
          const checkpoints = result.checkpoints?.map((checkpoint) => ({
            ...checkpoint,
            repositories: checkpoint.repositories.map(({ bundle_key, ...repository }) => ({
              ...repository, bundle_artifact_id: uploaded.get(bundle_key) ?? (() => { throw new Error(`Artifact ${bundle_key} was not uploaded`); })(),
            })),
          }));
          const { pending_artifacts: _pending, checkpoints: _localCheckpoints, ...reported } = result;
          const reportedResult: Parameters<TrackerClient["activityResult"]>[1] = { ...reported, ...(checkpoints?.length ? { checkpoints } : {}) };
          await this.tracker.activityResult(lease, reportedResult);
          log("info", "work.activity_reported", { supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: lease, success: reportedResult.success, exit_code: reportedResult.exit_code });
          await this.finalizeExecution(ticket, lease, repositoryStart, {
            activity: {
              success: reportedResult.success,
              exit_code: reportedResult.exit_code,
              script: await fileIdentity(reportedResult.script_path),
              working_directory: reportedResult.working_directory,
              structured_result: reportedResult.structured_result ?? null,
            },
          });
        } finally {
          if (!settled) {
            controller.abort();
            await activity;
          }
          await rm(activityDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        log("error", "activity.loop_failed", { supervisor_id: this.options.supervisorId }, error);
        await sleep(this.options.idlePollMs);
      }
    }
  }

  private async intakeLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.ensureRepositories();
        const run = await this.tracker.claimIntake(this.activityCapabilities);
        if (!run) { await sleep(this.options.idlePollMs); continue; }
        const lease = run.lease_id;
        log("info", "intake.claimed", { supervisor_id: this.options.supervisorId, source_id: run.source_id, run_id: run.id, lease_id: lease });
        const controller = new AbortController();
        let settled = false;
        const execution = executeIntakeSource(this.herdr.projectRoot, join(this.assignments.root, this.options.supervisorId), run, controller.signal)
          .finally(() => { settled = true; });
        try {
          let lastHeartbeatAt = Date.now();
          while (!settled && !this.stopped) {
            await sleep(Math.min(this.options.idlePollMs, this.options.heartbeatIntervalMs));
            if (Date.now() - lastHeartbeatAt >= this.options.heartbeatIntervalMs) {
              await this.tracker.heartbeatIntake(lease);
              lastHeartbeatAt = Date.now();
            }
          }
          if (this.stopped) {
            if (!settled) controller.abort();
            await execution.catch(() => undefined);
            break;
          }
          try {
            const result = await execution;
            await this.tracker.completeIntake(lease, result);
            log("info", "intake.completed", { supervisor_id: this.options.supervisorId, source_id: run.source_id, run_id: run.id, lease_id: lease, candidates: result.candidates.length });
          } catch (error) {
            await this.tracker.failIntake(lease, (error as Error).message, error instanceof IntakeExecutionError ? error.output : undefined).catch((reportError) => {
              log("error", "intake.failure_report_failed", { supervisor_id: this.options.supervisorId, source_id: run.source_id, run_id: run.id, lease_id: lease }, reportError);
            });
            log("error", "intake.failed", { supervisor_id: this.options.supervisorId, source_id: run.source_id, run_id: run.id, lease_id: lease }, error);
          }
        } finally {
          if (!settled) {
            controller.abort();
            await execution.catch(() => undefined);
          }
        }
      } catch (error) {
        log("error", "intake.loop_failed", { supervisor_id: this.options.supervisorId }, error);
        await sleep(this.options.idlePollMs);
      }
    }
  }

  private async runAssignment(provider: Provider, ticket: ClaimedTicket): Promise<void> {
    const lease = ticket.frontmatter.execution.lease_id;
    const trackerDeliveryPending = ticket.frontmatter.execution.delivery_status === "starting";
    let assignmentDelivered = !trackerDeliveryPending || this.locallyDeliveredLeases.has(lease);
    const trace = new ExecutionTraceRecorder(
      this.tracker,
      lease,
      join(this.assignments.root, this.options.supervisorId, "tickets", ticket.frontmatter.id, "trace-spool", ticket.frontmatter.execution.node_run_id ?? lease),
      {
        ticket_id: ticket.frontmatter.id, workflow_id: ticket.frontmatter.workflow.id,
        workflow_revision: ticket.frontmatter.workflow.revision, node_id: ticket.workflow_node.id,
        node_run_id: ticket.frontmatter.execution.node_run_id ?? null, lease_id: lease,
        supervisor_id: this.options.supervisorId, provider,
        model: ticket.resolved_agent_profile?.model ?? null, reasoning: ticket.resolved_agent_profile?.reasoning ?? null,
        project_root: this.herdr.projectRoot,
      },
    );
    await trace.start();
    let traceDisposition = "supervisor_loop_ended";
    const executeWithTrace = typeof this.herdr.withTrace === "function"
      ? (work: () => Promise<void>) => this.herdr.withTrace(trace, work)
      : (work: () => Promise<void>) => work();
    return executeWithTrace(async () => {
    log("info", assignmentDelivered ? "work.agent_resuming" : "work.assignment_starting", {
      provider, supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: lease,
    });
    const stopLeaseRenewal = this.startLeaseRenewal(ticket, lease);
    try {
    const repositoryStart = await captureRepositoryState(this.herdr.projectRoot, ticket);
    let currentTicket = ticket;
    const bundle = await this.assignments.prepare(currentTicket, this.callbackBaseUrl, this.herdr.projectRoot, this.prompts);
    const conversation = ticket.workflow_node.conversation_key;
    if (!conversation) throw new Error(`Agent node ${ticket.workflow_node.id} has no conversation key`);
    const existing = ticket.frontmatter.conversations?.[conversation] ?? { provider, herdr_pane_id: null, session_ref: null };
    const generation = existing.generation ?? 1;
    const runtimeConversation = `${conversation}-g${generation}`;
    const agentStartupStartedAt = Date.now();
    let observation = await this.herdr.ensureAgent(ticket.frontmatter.id, provider, runtimeConversation, existing.herdr_pane_id, existing.session_ref, ticket.resolved_agent_profile);
    log("info", "herdr.agent_ready", {
      provider, supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id,
      node_id: ticket.workflow_node.id, lease_id: lease, pane_id: observation.paneId,
      interactive_ready: observation.interactiveReady ?? null, launch_pending: observation.launchPending ?? null,
      startup_wait_ms: Date.now() - agentStartupStartedAt,
    });
    trace.record("agent.ready", {
      pane_id: observation.paneId, state: observation.state,
      interactive_ready: observation.interactiveReady ?? null, launch_pending: observation.launchPending ?? null,
      session_ref: observation.sessionRef, startup_wait_ms: Date.now() - agentStartupStartedAt,
    });
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
    if (assignmentDelivered && trackerDeliveryPending) {
      await this.tracker.confirmAssignmentDelivery(lease).then(
        () => { this.locallyDeliveredLeases.delete(lease); },
        (error) => {
          if (error instanceof TrackerError && error.status === 409) { this.locallyDeliveredLeases.delete(lease); return; }
          throw error;
        },
      );
    }
    if (ticket.frontmatter.execution.interrupt_request) {
      await this.herdr.interrupt(observation.paneId);
      await this.tracker.acknowledgeInterrupt(lease);
      await this.finalizeExecution(ticket, lease, repositoryStart, {
        agent: { provider, conversation, generation, pane_id: observation.paneId, session_ref: observation.sessionRef, disposition: "interrupted_before_prompt" },
      });
      traceDisposition = "interrupted_before_prompt";
      return;
    }
    if (!assignmentDelivered) {
      // Do not enter the reminder loop until Herdr has observed assignment activity.
      // An ambiguous stalled submission is recovered without pasting a duplicate.
      const delivered = await this.promptAssignment(provider, currentTicket, observation.paneId, bundle, observation, trace);
      observation = delivered.observation;
      assignmentDelivered = true;
      this.locallyDeliveredLeases.add(lease);
      await this.tracker.confirmAssignmentDelivery(lease, delivered.confirmation).catch((error) => {
        // A fast terminal callback may fence the lease before prompt delivery returns.
        if (!(error instanceof TrackerError && error.status === 409)) throw error;
      });
      this.locallyDeliveredLeases.delete(lease);
      log("info", "work.agent_started", {
        provider, supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: lease,
      });
    }
    let callbackReminderSent = false;
    let knownSessionRef = observation.sessionRef;
    let lastHeartbeatAt = Date.now();
    let lastObservedActivityAt = Date.now();
    let lastObservedRevision = observation.revision;

    while (!this.stopped) {
      await sleep(Math.min(this.options.idlePollMs, this.options.heartbeatIntervalMs));
      const control = await this.tracker.control(lease).catch((error) => {
        if (error instanceof TrackerError && error.status === 409) return null;
        throw error;
      });
      if (control === null) {
        trace.record("tracker.callback_observed", { lease_active: false });
        this.locallyDeliveredLeases.delete(lease);
        let finalObservation = null;
        try {
          finalObservation = await this.herdr.observe(observation.paneId);
          if (finalObservation.sessionRef) {
            const finalTelemetry = await this.collectTelemetry(telemetryContext(finalObservation.sessionRef));
            if (finalTelemetry) await this.tracker.telemetry(lease, finalTelemetry, captureBaseline(finalTelemetry)).catch(() => undefined);
          }
        } catch { /* the completed node may already have closed its pane */ }
        await this.finalizeExecution(ticket, lease, repositoryStart, {
          agent: {
            provider, conversation, generation, pane_id: observation.paneId,
            session_ref: finalObservation?.sessionRef ?? knownSessionRef,
            model: ticket.resolved_agent_profile?.model ?? null,
            reasoning: ticket.resolved_agent_profile?.reasoning ?? null,
            disposition: "callback",
          },
        });
        await this.herdr.interrupt(observation.paneId).catch(() => undefined);
        log("info", "work.agent_settled", { provider, supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: lease, disposition: "callback" });
        traceDisposition = "callback";
        return;
      }
      if (control?.interrupt) {
        trace.record("tracker.interrupt_observed", { request: control.interrupt });
        await this.herdr.interrupt(observation.paneId);
        try {
          const finalObservation = await this.herdr.observe(observation.paneId);
          if (finalObservation.sessionRef) {
            const finalTelemetry = await this.collectTelemetry(telemetryContext(finalObservation.sessionRef));
            if (finalTelemetry) await this.tracker.telemetry(lease, finalTelemetry, captureBaseline(finalTelemetry)).catch(() => undefined);
          }
        } catch { /* interruption telemetry is best effort */ }
        await this.tracker.acknowledgeInterrupt(lease);
        await this.finalizeExecution(ticket, lease, repositoryStart, {
          agent: {
            provider, conversation, generation, pane_id: observation.paneId,
            session_ref: knownSessionRef,
            model: ticket.resolved_agent_profile?.model ?? null,
            reasoning: ticket.resolved_agent_profile?.reasoning ?? null,
            disposition: "interrupted",
          },
        });
        traceDisposition = "interrupted";
        return;
      }
      let current;
      try { current = await this.herdr.observe(observation.paneId); }
      catch (error) {
        trace.record("agent.observation_failed", { error: errorMessage(error) });
        log("error", "herdr.agent_disappeared", { provider, ticket_id: ticket.frontmatter.id, node_id: ticket.workflow_node.id, lease_id: lease }, error);
        traceDisposition = "agent_disappeared";
        return;
      }
      const revisionAdvanced = current.revision !== null && lastObservedRevision !== null && current.revision !== lastObservedRevision;
      if (current.state === "working" || revisionAdvanced) lastObservedActivityAt = Date.now();
      lastObservedRevision = current.revision;

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
        trace.record("guidance.delivered", { guidance_id: item.id, sequence: item.sequence, update_path: updatePath });
        lastObservedActivityAt = Date.now();
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

      if (!control?.waitingForAnswer && !callbackReminderSent && (current.state === "idle" || current.state === "done")
        && Date.now() - lastObservedActivityAt >= this.callbackReminderGraceMs) {
        callbackReminderSent = true;
        await this.refreshPrompts();
        await this.herdr.prompt(current.paneId, buildCallbackReminder(currentTicket, this.callbackBaseUrl, this.herdr.projectRoot, this.prompts, bundle));
        trace.record("callback_reminder.delivered", { pane_id: current.paneId, assignment_path: bundle.startHerePath });
        log("warn", "assignment.callback_reminder_sent", {
          provider, supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id,
          node_id: ticket.workflow_node.id, lease_id: lease, pane_id: current.paneId,
        });
      }
    }
    } catch (error) {
      if (!assignmentDelivered) {
        const reason = `Assignment delivery failed before agent execution started: ${errorMessage(error)}`;
        try {
          const result = await this.tracker.rejectAssignmentDelivery(lease, reason);
          this.locallyDeliveredLeases.delete(lease);
          log("warn", "work.assignment_delivery_failed", {
            provider, supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id,
            node_id: ticket.workflow_node.id, lease_id: lease, disposition: result.blocked ? "blocked" : "requeued",
          }, error);
          trace.record("delivery.failed", { reason, disposition: result.blocked ? "blocked" : "requeued" });
          traceDisposition = result.blocked ? "delivery_failed_blocked" : "delivery_failed_requeued";
          await sleep(this.options.idlePollMs);
          return;
        } catch (reportError) {
          if (reportError instanceof TrackerError && reportError.status === 409) {
            trace.record("delivery.report_fenced", { reason });
            traceDisposition = "delivery_report_fenced";
            return;
          }
          log("error", "work.assignment_delivery_report_failed", {
            provider, supervisor_id: this.options.supervisorId, ticket_id: ticket.frontmatter.id,
            node_id: ticket.workflow_node.id, lease_id: lease,
          }, reportError);
        }
      }
      trace.record("execution.supervisor_failed", { error: errorMessage(error), assignment_delivered: assignmentDelivered });
      traceDisposition = assignmentDelivered ? "supervisor_failed" : "delivery_report_failed";
      throw error;
    } finally {
      stopLeaseRenewal();
      await trace.close(traceDisposition);
    }
    });
  }
}
