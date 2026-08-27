import { PHASES, PRODUCTION_RESULTS, PROVIDERS, STATUSES, type AgentRef, type ArtifactKind, type AttemptCounter, type Execution, type HarnessTelemetryRecord, type HarnessTelemetrySnapshot, type HerdrObservation, type JsonValue, type NodeRunTiming, type Phase, type PullRequestRef, type ResolvedAgentProfile, type TicketFrontmatter, type TicketQuestion, type TokenUsage, type WorkflowNodeInputContext, type WorkflowRuntime, type WorkflowTransitionContext } from "./domain.js";
import { qualityReportMetadata } from "./quality.js";

const phaseStatuses: Record<Phase, Set<string>> = {
  specification: new Set(["pending", "ready", "running", "blocked", "waiting_approval", "waiting_external", "failed", "cancelled"]),
  implementation: new Set(["pending", "ready", "running", "blocked", "waiting_approval", "waiting_external", "failed", "cancelled"]),
  review: new Set(["pending", "ready", "running", "blocked", "waiting_approval", "waiting_external", "failed", "cancelled"]),
  done: new Set(["completed", "failed", "cancelled"]),
};

const emptyAgent = (): AgentRef => ({ provider: null, herdr_pane_id: null, session_ref: null, generation: 1, visits_in_generation: 0, last_visit_key: null, reset_reason: null });
const emptyAttempt = (): AttemptCounter => ({ total: 0, consecutive_lease_losses: 0 });
const NODE_RUN_TYPES = ["agent", "script", "checkpoint", "restore_checkpoint", "human_gate", "wait", "read", "write", "workflow", "fan_out", "fan_in", "terminal"] as const;
type NodeRunType = (typeof NODE_RUN_TYPES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: unknown, field: string, errors: string[], depth = 0): JsonValue | undefined {
  if (depth > 12) { errors.push(`${field} exceeds maximum nesting depth`); return undefined; }
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) {
    const result = value.map((item, index) => jsonValue(item, `${field}[${index}]`, errors, depth + 1));
    return result.some((item) => item === undefined) ? undefined : result as JsonValue[];
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = jsonValue(item, `${field}.${key}`, errors, depth + 1);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  errors.push(`${field} must be JSON-compatible`);
  return undefined;
}

function asString(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim() === "") { errors.push(`${field} must be a non-empty string`); return ""; }
  return value.trim();
}

function nodeRunType(value: unknown, field: string, errors: string[]): NodeRunType {
  if (NODE_RUN_TYPES.includes(value as NodeRunType)) return value as NodeRunType;
  errors.push(`${field} must be a supported workflow node type`);
  return "agent";
}

function agent(value: unknown): AgentRef {
  if (!isRecord(value)) return emptyAgent();
  const provider = PROVIDERS.includes(value.provider as never) ? value.provider as AgentRef["provider"] : null;
  return {
    provider,
    herdr_pane_id: typeof value.herdr_pane_id === "string" ? value.herdr_pane_id : null,
    session_ref: typeof value.session_ref === "string" ? value.session_ref : null,
    generation: Number.isInteger(value.generation) && Number(value.generation) > 0 ? Number(value.generation) : 1,
    visits_in_generation: Number.isInteger(value.visits_in_generation) && Number(value.visits_in_generation) >= 0 ? Number(value.visits_in_generation) : 0,
    last_visit_key: typeof value.last_visit_key === "string" ? value.last_visit_key : null,
    reset_reason: typeof value.reset_reason === "string" ? value.reset_reason : null,
  };
}

function attempt(value: unknown): AttemptCounter {
  if (!isRecord(value)) return emptyAttempt();
  return {
    total: Number.isInteger(value.total) && Number(value.total) >= 0 ? Number(value.total) : 0,
    consecutive_lease_losses: Number.isInteger(value.consecutive_lease_losses) && Number(value.consecutive_lease_losses) >= 0
      ? Number(value.consecutive_lease_losses) : 0,
  };
}

function timestamp(value: unknown, field: string, errors: string[]): string {
  const result = asString(value, field, errors);
  if (result && Number.isNaN(Date.parse(result))) errors.push(`${field} must be an ISO timestamp`);
  return result;
}

function optionalString(value: unknown, field: string, errors: string[]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") { errors.push(`${field} must be a string or null`); return null; }
  return value;
}

function optionalNumber(value: unknown, field: string, errors: string[]): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) { errors.push(`${field} must be a non-negative number or null`); return null; }
  return value;
}

function nodeTiming(value: unknown, run: Record<string, unknown>, index: number, errors: string[]): NodeRunTiming {
  const stateDefault = run.node_type === "human_gate" ? "human_wait" : run.node_type === "wait" ? "external_wait" : "active";
  if (!isRecord(value)) {
    const started = Date.parse(String(run.started_at ?? ""));
    const completed = run.completed_at ? Date.parse(String(run.completed_at)) : Number.NaN;
    const elapsed = Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0;
    return {
      active_ms: stateDefault === "active" ? elapsed : 0,
      quota_paused_ms: 0,
      human_wait_ms: stateDefault === "human_wait" ? elapsed : 0,
      external_wait_ms: stateDefault === "external_wait" ? elapsed : 0,
      state: stateDefault,
      last_accounted_at: run.completed_at ? null : typeof run.started_at === "string" ? run.started_at : null,
      pause_limit_id: null,
      pause_until: null,
    };
  }
  const field = `workflow.node_runs[${index}].timing`;
  const state = ["active", "quota_paused", "human_wait", "external_wait"].includes(String(value.state))
    ? value.state as NodeRunTiming["state"] : (errors.push(`${field}.state is invalid`), stateDefault);
  return {
    active_ms: optionalNumber(value.active_ms, `${field}.active_ms`, errors) ?? 0,
    quota_paused_ms: optionalNumber(value.quota_paused_ms, `${field}.quota_paused_ms`, errors) ?? 0,
    human_wait_ms: optionalNumber(value.human_wait_ms, `${field}.human_wait_ms`, errors) ?? 0,
    external_wait_ms: optionalNumber(value.external_wait_ms, `${field}.external_wait_ms`, errors) ?? 0,
    state,
    last_accounted_at: value.last_accounted_at === null || value.last_accounted_at === undefined ? null : timestamp(value.last_accounted_at, `${field}.last_accounted_at`, errors),
    pause_limit_id: optionalString(value.pause_limit_id, `${field}.pause_limit_id`, errors),
    pause_until: value.pause_until === null || value.pause_until === undefined ? null : timestamp(value.pause_until, `${field}.pause_until`, errors),
  };
}

function tokenUsage(value: unknown, field: string, errors: string[]): TokenUsage | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) { errors.push(`${field} must be an object or null`); return null; }
  const read = (key: keyof TokenUsage) => optionalNumber(value[key], `${field}.${key}`, errors) ?? 0;
  return {
    input_tokens: read("input_tokens"), cached_input_tokens: read("cached_input_tokens"),
    cache_write_input_tokens: read("cache_write_input_tokens"), output_tokens: read("output_tokens"),
    reasoning_output_tokens: read("reasoning_output_tokens"), total_tokens: read("total_tokens"),
  };
}

export function telemetrySnapshot(value: unknown, field: string, errors: string[]): HarnessTelemetrySnapshot | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) { errors.push(`${field} must be an object`); return null; }
  const source = isRecord(value.source) ? value.source : (errors.push(`${field}.source must be an object`), {});
  const model = isRecord(value.model) ? value.model : (errors.push(`${field}.model must be an object`), {});
  const reasoning = isRecord(value.reasoning) ? value.reasoning : (errors.push(`${field}.reasoning must be an object`), {});
  const cost = isRecord(value.cost) ? value.cost : (errors.push(`${field}.cost must be an object`), {});
  const context = isRecord(value.context) ? value.context : (errors.push(`${field}.context must be an object`), {});
  if (value.schema_version !== 1) errors.push(`${field}.schema_version must be 1`);
  const observedIds = Array.isArray(model.observed_ids) && model.observed_ids.every((item) => typeof item === "string")
    ? [...new Set(model.observed_ids as string[])] : (errors.push(`${field}.model.observed_ids must be a string array`), []);
  const costKind = ["reported", "estimated", "unavailable"].includes(String(cost.kind))
    ? cost.kind as HarnessTelemetrySnapshot["cost"]["kind"] : (errors.push(`${field}.cost.kind is invalid`), "unavailable");
  const limits = Array.isArray(value.rate_limits) ? value.rate_limits.map((item, index) => {
    if (!isRecord(item)) { errors.push(`${field}.rate_limits[${index}] must be an object`); return null; }
    return {
      id: asString(item.id, `${field}.rate_limits[${index}].id`, errors),
      name: optionalString(item.name, `${field}.rate_limits[${index}].name`, errors),
      used_percent: optionalNumber(item.used_percent, `${field}.rate_limits[${index}].used_percent`, errors) ?? 0,
      window_minutes: optionalNumber(item.window_minutes, `${field}.rate_limits[${index}].window_minutes`, errors),
      resets_at: item.resets_at === null || item.resets_at === undefined ? null : timestamp(item.resets_at, `${field}.rate_limits[${index}].resets_at`, errors),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null) : (errors.push(`${field}.rate_limits must be an array`), []);
  const attributes: HarnessTelemetrySnapshot["attributes"] = {};
  if (!isRecord(value.attributes)) errors.push(`${field}.attributes must be an object`);
  else for (const [key, attribute] of Object.entries(value.attributes)) {
    if (attribute === null || typeof attribute === "string" || typeof attribute === "boolean" || typeof attribute === "number" && Number.isFinite(attribute)) attributes[key] = attribute;
    else errors.push(`${field}.attributes.${key} must be a scalar JSON value`);
  }
  const enabled = reasoning.enabled === null || reasoning.enabled === undefined ? null
    : typeof reasoning.enabled === "boolean" ? reasoning.enabled : (errors.push(`${field}.reasoning.enabled must be a boolean or null`), null);
  const totalUsd = optionalNumber(cost.total_usd, `${field}.cost.total_usd`, errors);
  if (costKind === "unavailable" && totalUsd !== null) errors.push(`${field}.cost.total_usd must be null when cost is unavailable`);
  if (costKind !== "unavailable" && totalUsd === null) errors.push(`${field}.cost.total_usd is required for ${costKind} cost`);
  return {
    schema_version: 1,
    harness: asString(value.harness, `${field}.harness`, errors),
    session_ref: optionalString(value.session_ref, `${field}.session_ref`, errors),
    observed_at: timestamp(value.observed_at, `${field}.observed_at`, errors),
    source: { kind: asString(source.kind, `${field}.source.kind`, errors), detail: optionalString(source.detail, `${field}.source.detail`, errors) },
    model: { id: optionalString(model.id, `${field}.model.id`, errors), provider: optionalString(model.provider, `${field}.model.provider`, errors), observed_ids: observedIds },
    reasoning: { effort: optionalString(reasoning.effort, `${field}.reasoning.effort`, errors), enabled, source: optionalString(reasoning.source, `${field}.reasoning.source`, errors) },
    usage: tokenUsage(value.usage, `${field}.usage`, errors),
    cost: {
      total_usd: totalUsd, kind: costKind,
      source: optionalString(cost.source, `${field}.cost.source`, errors),
      pricing_id: optionalString(cost.pricing_id, `${field}.cost.pricing_id`, errors),
      effective_at: cost.effective_at === null || cost.effective_at === undefined ? null : timestamp(cost.effective_at, `${field}.cost.effective_at`, errors),
    },
    context: {
      used_tokens: optionalNumber(context.used_tokens, `${field}.context.used_tokens`, errors),
      window_tokens: optionalNumber(context.window_tokens, `${field}.context.window_tokens`, errors),
      used_percent: optionalNumber(context.used_percent, `${field}.context.used_percent`, errors),
    },
    rate_limits: limits, attributes,
  };
}

function telemetryRecord(value: unknown, field: string, errors: string[]): HarnessTelemetryRecord | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) { errors.push(`${field} must be an object or null`); return null; }
  const baseline = telemetrySnapshot(value.baseline, `${field}.baseline`, errors);
  const latest = telemetrySnapshot(value.latest, `${field}.latest`, errors);
  const delta = isRecord(value.delta) ? value.delta : (errors.push(`${field}.delta must be an object`), {});
  if (!baseline || !latest) return null;
  if (baseline.harness !== latest.harness || baseline.session_ref !== latest.session_ref) errors.push(`${field} baseline and latest must identify the same harness session`);
  return { baseline, latest, delta: { usage: tokenUsage(delta.usage, `${field}.delta.usage`, errors), cost_usd: optionalNumber(delta.cost_usd, `${field}.delta.cost_usd`, errors) } };
}

function herdrObservation(value: unknown, errors: string[]): HerdrObservation | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) { errors.push("execution.herdr_observation must be an object or null"); return null; }
  const tokens: Record<string, string> = {};
  if (value.tokens !== undefined && !isRecord(value.tokens)) errors.push("execution.herdr_observation.tokens must be an object");
  if (isRecord(value.tokens)) {
    for (const [key, token] of Object.entries(value.tokens)) {
      if (typeof token === "string") tokens[key] = token;
      else errors.push(`execution.herdr_observation.tokens.${key} must be a string`);
    }
  }
  const revision = value.revision === null || value.revision === undefined ? null
    : Number.isInteger(value.revision) && Number(value.revision) >= 0 ? Number(value.revision)
      : (errors.push("execution.herdr_observation.revision must be a non-negative integer or null"), null);
  return {
    state: asString(value.state, "execution.herdr_observation.state", errors),
    observed_at: timestamp(value.observed_at, "execution.herdr_observation.observed_at", errors),
    state_changed_at: timestamp(value.state_changed_at, "execution.herdr_observation.state_changed_at", errors),
    pane_id: optionalString(value.pane_id, "execution.herdr_observation.pane_id", errors),
    workspace_id: optionalString(value.workspace_id, "execution.herdr_observation.workspace_id", errors),
    tab_id: optionalString(value.tab_id, "execution.herdr_observation.tab_id", errors),
    terminal_id: optionalString(value.terminal_id, "execution.herdr_observation.terminal_id", errors),
    focused: value.focused === null || value.focused === undefined ? null
      : typeof value.focused === "boolean" ? value.focused : (errors.push("execution.herdr_observation.focused must be a boolean or null"), null),
    cwd: optionalString(value.cwd, "execution.herdr_observation.cwd", errors),
    foreground_cwd: optionalString(value.foreground_cwd, "execution.herdr_observation.foreground_cwd", errors),
    terminal_title: optionalString(value.terminal_title, "execution.herdr_observation.terminal_title", errors),
    terminal_title_stripped: optionalString(value.terminal_title_stripped, "execution.herdr_observation.terminal_title_stripped", errors),
    display_name: optionalString(value.display_name, "execution.herdr_observation.display_name", errors),
    revision,
    session_source: optionalString(value.session_source, "execution.herdr_observation.session_source", errors),
    session_kind: optionalString(value.session_kind, "execution.herdr_observation.session_kind", errors),
    tokens,
  };
}

function execution(value: unknown, errors: string[]): Execution | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) { errors.push("execution must be an object or null"); return null; }
  const provider = value.provider === null ? null : PROVIDERS.includes(value.provider as never) ? value.provider as Execution["provider"] : null;
  if (value.provider !== null && !PROVIDERS.includes(value.provider as never)) errors.push("execution.provider must be claude, codex, or null");
  const phase = PHASES.includes(value.phase as never) ? value.phase as Phase : "implementation";
  if (!PHASES.includes(value.phase as never) || phase === "done") errors.push("execution.phase must be an assignable phase");
  const guidance = Array.isArray(value.guidance) ? value.guidance.map((item, index) => {
    if (!isRecord(item)) { errors.push(`execution.guidance[${index}] must be an object`); return null; }
    const delivered = item.delivered_at === null ? null : timestamp(item.delivered_at, `execution.guidance[${index}].delivered_at`, errors);
    return {
      id: asString(item.id, `execution.guidance[${index}].id`, errors),
      sequence: Number.isInteger(item.sequence) && Number(item.sequence) >= 0 ? Number(item.sequence) : (errors.push(`execution.guidance[${index}].sequence must be a non-negative integer`), 0),
      message: asString(item.message, `execution.guidance[${index}].message`, errors),
      created_at: timestamp(item.created_at, `execution.guidance[${index}].created_at`, errors),
      delivered_at: delivered,
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null) : (errors.push("execution.guidance must be an array"), []);
  let interruptRequest: Execution["interrupt_request"] = null;
  if (value.interrupt_request !== null && value.interrupt_request !== undefined) {
    if (!isRecord(value.interrupt_request)) errors.push("execution.interrupt_request must be an object or null");
    else {
      const target = value.interrupt_request.target_phase;
      if (!PHASES.includes(target as never) || target === "done") errors.push("execution.interrupt_request.target_phase must be an assignable phase");
      else interruptRequest = {
        target_phase: target as Exclude<Phase, "done">,
        requested_at: timestamp(value.interrupt_request.requested_at, "execution.interrupt_request.requested_at", errors),
        ...(typeof value.interrupt_request.target_node === "string" ? { target_node: value.interrupt_request.target_node } : {}),
        ...(typeof value.interrupt_request.target_workflow_id === "string" ? { target_workflow_id: value.interrupt_request.target_workflow_id } : {}),
        ...(typeof value.interrupt_request.target_workflow_revision === "string" ? { target_workflow_revision: value.interrupt_request.target_workflow_revision } : {}),
        ...(value.interrupt_request.terminal_status === "failed" || value.interrupt_request.terminal_status === "cancelled"
          ? { terminal_status: value.interrupt_request.terminal_status } : {}),
        ...(typeof value.interrupt_request.terminal_reason === "string" ? { terminal_reason: value.interrupt_request.terminal_reason } : {}),
        ...(value.interrupt_request.reason_code === "cost_limit_exceeded" ? { reason_code: value.interrupt_request.reason_code } : {}),
        ...(typeof value.interrupt_request.cost_limit_usd === "number" && Number.isFinite(value.interrupt_request.cost_limit_usd)
          ? { cost_limit_usd: value.interrupt_request.cost_limit_usd } : {}),
        ...(typeof value.interrupt_request.cost_observed_usd === "number" && Number.isFinite(value.interrupt_request.cost_observed_usd)
          ? { cost_observed_usd: value.interrupt_request.cost_observed_usd } : {}),
      };
      if (value.interrupt_request.terminal_status !== undefined
        && value.interrupt_request.terminal_status !== "failed" && value.interrupt_request.terminal_status !== "cancelled") {
        errors.push("execution.interrupt_request.terminal_status must be failed or cancelled");
      }
      if (value.interrupt_request.reason_code !== undefined && value.interrupt_request.reason_code !== "cost_limit_exceeded") errors.push("execution.interrupt_request.reason_code is invalid");
      for (const field of ["cost_limit_usd", "cost_observed_usd"] as const) {
        const amount = value.interrupt_request[field];
        if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) errors.push(`execution.interrupt_request.${field} must be a non-negative finite number`);
      }
    }
  }
  return {
    lease_id: asString(value.lease_id, "execution.lease_id", errors),
    supervisor_id: asString(value.supervisor_id, "execution.supervisor_id", errors),
    provider,
    phase,
    attempt: Number.isInteger(value.attempt) && Number(value.attempt) > 0 ? Number(value.attempt) : (errors.push("execution.attempt must be a positive integer"), 1),
    claimed_at: timestamp(value.claimed_at, "execution.claimed_at", errors),
    last_heartbeat_at: timestamp(value.last_heartbeat_at, "execution.last_heartbeat_at", errors),
    lease_expires_at: timestamp(value.lease_expires_at, "execution.lease_expires_at", errors),
    delivery_status: value.delivery_status === "starting" || value.delivery_status === "delivered"
      ? value.delivery_status : "delivered",
    delivery_confirmed_at: value.delivery_confirmed_at === null || value.delivery_confirmed_at === undefined
      ? null : timestamp(value.delivery_confirmed_at, "execution.delivery_confirmed_at", errors),
    observed_herdr_state: value.observed_herdr_state === null || value.observed_herdr_state === undefined
      ? null : asString(value.observed_herdr_state, "execution.observed_herdr_state", errors),
    herdr_observation: herdrObservation(value.herdr_observation, errors),
    telemetry: telemetryRecord(value.telemetry, "execution.telemetry", errors),
    guidance,
    interrupt_request: interruptRequest,
    ...(typeof value.node_run_id === "string" ? { node_run_id: value.node_run_id } : {}),
    ...(typeof value.node_id === "string" ? { node_id: value.node_id } : {}),
    ...(["agent", "script", "checkpoint", "restore_checkpoint"].includes(String(value.node_type)) ? { node_type: value.node_type as NonNullable<Execution["node_type"]> } : {}),
    ...(typeof value.conversation_key === "string" ? { conversation_key: value.conversation_key } : {}),
  };
}

function workflowRuntime(value: unknown, errors: string[], now: string): WorkflowRuntime | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) { errors.push("workflow must be an object or null"); return null; }
  const visits: Record<string, number> = {};
  if (isRecord(value.node_visits)) {
    for (const [key, count] of Object.entries(value.node_visits)) {
      if (Number.isInteger(count) && Number(count) >= 0) visits[key] = Number(count);
      else errors.push(`workflow.node_visits.${key} must be a non-negative integer`);
    }
  } else errors.push("workflow.node_visits must be an object");
  const nodeAttempts: Record<string, AttemptCounter> = {};
  if (isRecord(value.node_attempts)) {
    for (const [key, counter] of Object.entries(value.node_attempts)) nodeAttempts[key] = attempt(counter);
  }
  const promptRevisions: Record<string, string> = {};
  if (isRecord(value.prompt_revisions)) {
    for (const [key, revision] of Object.entries(value.prompt_revisions)) {
      if (typeof revision === "string" && revision) promptRevisions[key] = revision;
      else errors.push(`workflow.prompt_revisions.${key} must be a string`);
    }
  }
  const nodeRuns = Array.isArray(value.node_runs) ? value.node_runs.filter(isRecord).map((run, index) => {
    const metadataWrites: Record<string, JsonValue> = {};
    if (isRecord(run.metadata_writes)) {
      for (const [key, item] of Object.entries(run.metadata_writes)) {
        const parsed = jsonValue(item, `workflow.node_runs[${index}].metadata_writes.${key}`, errors);
        if (parsed !== undefined) metadataWrites[key] = parsed;
      }
    } else if (run.metadata_writes !== undefined) errors.push(`workflow.node_runs[${index}].metadata_writes must be an object`);
    const externalReferences = Array.isArray(run.external_references) ? run.external_references.flatMap((item, referenceIndex) => {
      if (!isRecord(item)) { errors.push(`workflow.node_runs[${index}].external_references[${referenceIndex}] must be an object`); return []; }
      return [{
        type: asString(item.type, `workflow.node_runs[${index}].external_references[${referenceIndex}].type`, errors),
        id: asString(item.id, `workflow.node_runs[${index}].external_references[${referenceIndex}].id`, errors),
        url: optionalString(item.url, `workflow.node_runs[${index}].external_references[${referenceIndex}].url`, errors),
      }];
    }) : [];
    let inputContext: WorkflowNodeInputContext | undefined;
    if (isRecord(run.input_context)) {
      const context = run.input_context;
      const incoming = context.incoming === null || context.incoming === undefined ? null : isRecord(context.incoming) ? {
        source_node: asString(context.incoming.source_node, `workflow.node_runs[${index}].input_context.incoming.source_node`, errors),
        target_node: asString(context.incoming.target_node, `workflow.node_runs[${index}].input_context.incoming.target_node`, errors),
        outcome: asString(context.incoming.outcome, `workflow.node_runs[${index}].input_context.incoming.outcome`, errors),
        summary: optionalString(context.incoming.summary, `workflow.node_runs[${index}].input_context.incoming.summary`, errors),
        handoff: optionalString(context.incoming.handoff, `workflow.node_runs[${index}].input_context.incoming.handoff`, errors),
        output: optionalString(context.incoming.output, `workflow.node_runs[${index}].input_context.incoming.output`, errors),
        output_log_path: optionalString(context.incoming.output_log_path, `workflow.node_runs[${index}].input_context.incoming.output_log_path`, errors),
        actor: asString(context.incoming.actor, `workflow.node_runs[${index}].input_context.incoming.actor`, errors),
        created_at: timestamp(context.incoming.created_at, `workflow.node_runs[${index}].input_context.incoming.created_at`, errors),
      } : (errors.push(`workflow.node_runs[${index}].input_context.incoming must be an object or null`), null);
      const workflowInputs: Record<string, boolean | string> = {};
      if (isRecord(context.workflow_inputs)) for (const [key, item] of Object.entries(context.workflow_inputs)) {
        if (typeof item === "boolean" || typeof item === "string") workflowInputs[key] = item;
        else errors.push(`workflow.node_runs[${index}].input_context.workflow_inputs.${key} must be a boolean or string`);
      } else errors.push(`workflow.node_runs[${index}].input_context.workflow_inputs must be an object`);
      const stageEnabled: Record<string, boolean> = {};
      if (isRecord(context.stage_enabled)) for (const [key, item] of Object.entries(context.stage_enabled)) {
        if (typeof item === "boolean") stageEnabled[key] = item;
        else errors.push(`workflow.node_runs[${index}].input_context.stage_enabled.${key} must be a boolean`);
      } else errors.push(`workflow.node_runs[${index}].input_context.stage_enabled must be an object`);
      const attachments = Array.isArray(context.attachments) ? context.attachments.filter(isRecord).map((item, itemIndex) => ({
        id: asString(item.id, `workflow.node_runs[${index}].input_context.attachments[${itemIndex}].id`, errors),
        filename: asString(item.filename, `workflow.node_runs[${index}].input_context.attachments[${itemIndex}].filename`, errors),
        sha256: asString(item.sha256, `workflow.node_runs[${index}].input_context.attachments[${itemIndex}].sha256`, errors),
      })) : (errors.push(`workflow.node_runs[${index}].input_context.attachments must be an array`), []);
      const priorArtifacts = Array.isArray(context.prior_artifacts) ? context.prior_artifacts.filter(isRecord).map((item, itemIndex) => ({
        id: asString(item.id, `workflow.node_runs[${index}].input_context.prior_artifacts[${itemIndex}].id`, errors),
        kind: asString(item.kind, `workflow.node_runs[${index}].input_context.prior_artifacts[${itemIndex}].kind`, errors) as ArtifactKind,
        filename: asString(item.filename, `workflow.node_runs[${index}].input_context.prior_artifacts[${itemIndex}].filename`, errors),
        sha256: asString(item.sha256, `workflow.node_runs[${index}].input_context.prior_artifacts[${itemIndex}].sha256`, errors),
        node_run_id: optionalString(item.node_run_id, `workflow.node_runs[${index}].input_context.prior_artifacts[${itemIndex}].node_run_id`, errors),
      })) : (errors.push(`workflow.node_runs[${index}].input_context.prior_artifacts must be an array`), []);
      let resolvedProfile: ResolvedAgentProfile | null = null;
      if (context.resolved_agent_profile !== null && context.resolved_agent_profile !== undefined) {
        if (isRecord(context.resolved_agent_profile) && PROVIDERS.includes(context.resolved_agent_profile.provider as never)) resolvedProfile = {
          alias: asString(context.resolved_agent_profile.alias, `workflow.node_runs[${index}].input_context.resolved_agent_profile.alias`, errors),
          provider: context.resolved_agent_profile.provider as ResolvedAgentProfile["provider"],
          model: optionalString(context.resolved_agent_profile.model, `workflow.node_runs[${index}].input_context.resolved_agent_profile.model`, errors),
          reasoning: optionalString(context.resolved_agent_profile.reasoning, `workflow.node_runs[${index}].input_context.resolved_agent_profile.reasoning`, errors),
        };
        else errors.push(`workflow.node_runs[${index}].input_context.resolved_agent_profile is invalid`);
      }
      inputContext = {
        ticket_revision: Number.isInteger(context.ticket_revision) ? Number(context.ticket_revision) : (errors.push(`workflow.node_runs[${index}].input_context.ticket_revision must be an integer`), 0),
        incoming, workflow_inputs: workflowInputs, stage_enabled: stageEnabled, attachments, prior_artifacts: priorArtifacts,
        prompt_revision: optionalString(context.prompt_revision, `workflow.node_runs[${index}].input_context.prompt_revision`, errors),
        resolved_agent_profile: resolvedProfile,
      };
    } else if (run.input_context !== undefined) errors.push(`workflow.node_runs[${index}].input_context must be an object`);
    return ({
    id: asString(run.id, `workflow.node_runs[${index}].id`, errors),
    ...(typeof run.workflow_id === "string" ? { workflow_id: run.workflow_id } : {}),
    workflow_revision: asString(run.workflow_revision, `workflow.node_runs[${index}].workflow_revision`, errors),
    node_id: asString(run.node_id, `workflow.node_runs[${index}].node_id`, errors),
    node_type: nodeRunType(run.node_type, `workflow.node_runs[${index}].node_type`, errors),
    visit: Number.isInteger(run.visit) ? Number(run.visit) : 1,
    attempt: Number.isInteger(run.attempt) ? Number(run.attempt) : 1,
    status: (["running", "completed", "failed", "interrupted"].includes(String(run.status)) ? run.status : "failed") as "running" | "completed" | "failed" | "interrupted",
    supervisor_id: optionalString(run.supervisor_id, `workflow.node_runs[${index}].supervisor_id`, errors),
    provider: PROVIDERS.includes(run.provider as never) ? run.provider as AgentRef["provider"] : null,
    lease_id: optionalString(run.lease_id, `workflow.node_runs[${index}].lease_id`, errors),
    started_at: timestamp(run.started_at, `workflow.node_runs[${index}].started_at`, errors),
    completed_at: run.completed_at === null ? null : timestamp(run.completed_at, `workflow.node_runs[${index}].completed_at`, errors),
    outcome: optionalString(run.outcome, `workflow.node_runs[${index}].outcome`, errors),
    summary: optionalString(run.summary, `workflow.node_runs[${index}].summary`, errors),
    handoff: optionalString(run.handoff, `workflow.node_runs[${index}].handoff`, errors),
    output: optionalString(run.output, `workflow.node_runs[${index}].output`, errors),
    output_path: optionalString(run.output_path, `workflow.node_runs[${index}].output_path`, errors),
    output_sha256: optionalString(run.output_sha256, `workflow.node_runs[${index}].output_sha256`, errors),
    output_bytes: run.output_bytes === null || run.output_bytes === undefined ? null
      : Number.isInteger(run.output_bytes) && Number(run.output_bytes) >= 0 ? Number(run.output_bytes)
        : (errors.push(`workflow.node_runs[${index}].output_bytes must be a non-negative integer or null`), null),
    script_path: optionalString(run.script_path, `workflow.node_runs[${index}].script_path`, errors),
    working_directory: optionalString(run.working_directory, `workflow.node_runs[${index}].working_directory`, errors),
    conversation_generation: run.conversation_generation === null || run.conversation_generation === undefined ? null
      : Number.isInteger(run.conversation_generation) && Number(run.conversation_generation) > 0 ? Number(run.conversation_generation)
        : (errors.push(`workflow.node_runs[${index}].conversation_generation must be a positive integer or null`), null),
    manifest_artifact_id: optionalString(run.manifest_artifact_id, `workflow.node_runs[${index}].manifest_artifact_id`, errors),
    wait: isRecord(run.wait) ? {
      wake_at: timestamp(run.wait.wake_at, `workflow.node_runs[${index}].wait.wake_at`, errors),
      deadline_at: timestamp(run.wait.deadline_at, `workflow.node_runs[${index}].wait.deadline_at`, errors),
      delay_seconds: typeof run.wait.delay_seconds === "number" && Number.isFinite(run.wait.delay_seconds) && run.wait.delay_seconds >= 0
        ? run.wait.delay_seconds : (errors.push(`workflow.node_runs[${index}].wait.delay_seconds is invalid`), 0),
    } : null,
    metadata_writes: metadataWrites,
    external_references: externalReferences,
    input_revision: Number.isInteger(run.input_revision) ? Number(run.input_revision) : 0,
    ...(inputContext ? { input_context: inputContext } : {}),
    telemetry: telemetryRecord(run.telemetry, `workflow.node_runs[${index}].telemetry`, errors),
    timing: nodeTiming(run.timing, run, index, errors),
  }); }) : [];
  const inputs: Record<string, boolean | string> = {};
  if (isRecord(value.inputs)) {
    for (const [key, input] of Object.entries(value.inputs)) {
      if (typeof input === "boolean" || typeof input === "string") inputs[key] = input;
      else errors.push(`workflow.inputs.${key} must be a boolean or string`);
    }
  }
  const stageEnabled: Record<string, boolean> = {};
  if (isRecord(value.stage_enabled)) {
    for (const [key, enabled] of Object.entries(value.stage_enabled)) {
      if (typeof enabled === "boolean") stageEnabled[key] = enabled;
      else errors.push(`workflow.stage_enabled.${key} must be a boolean`);
    }
  }
  let incoming: WorkflowRuntime["incoming"] = null;
  if (isRecord(value.incoming)) incoming = {
    source_node: asString(value.incoming.source_node, "workflow.incoming.source_node", errors),
    target_node: asString(value.incoming.target_node, "workflow.incoming.target_node", errors),
    outcome: asString(value.incoming.outcome, "workflow.incoming.outcome", errors),
    summary: optionalString(value.incoming.summary, "workflow.incoming.summary", errors),
    handoff: optionalString(value.incoming.handoff, "workflow.incoming.handoff", errors),
    output: optionalString(value.incoming.output, "workflow.incoming.output", errors),
    output_log_path: optionalString(value.incoming.output_log_path, "workflow.incoming.output_log_path", errors),
    actor: asString(value.incoming.actor, "workflow.incoming.actor", errors),
    created_at: timestamp(value.incoming.created_at, "workflow.incoming.created_at", errors),
  };
  const workflowRevisions: Record<string, string> = {};
  if (isRecord(value.workflow_revisions)) for (const [id, revision] of Object.entries(value.workflow_revisions)) {
    if (typeof revision === "string" && /^[a-f0-9]{64}$/.test(revision)) workflowRevisions[id] = revision;
    else errors.push(`workflow.workflow_revisions.${id} must be a SHA-256 digest`);
  }
  const resolvedProfiles: Record<string, ResolvedAgentProfile> = {};
  if (isRecord(value.resolved_agent_profiles)) for (const [key, item] of Object.entries(value.resolved_agent_profiles)) {
    if (!isRecord(item) || !PROVIDERS.includes(item.provider as never)) { errors.push(`workflow.resolved_agent_profiles.${key} is invalid`); continue; }
    resolvedProfiles[key] = {
      alias: asString(item.alias, `workflow.resolved_agent_profiles.${key}.alias`, errors),
      provider: item.provider as ResolvedAgentProfile["provider"],
      model: typeof item.model === "string" ? item.model : null,
      reasoning: typeof item.reasoning === "string" ? item.reasoning : null,
    };
  }
  const workflowStack = Array.isArray(value.workflow_stack) ? value.workflow_stack.filter(isRecord).map((frame, index) => ({
    workflow_id: asString(frame.workflow_id, `workflow.workflow_stack[${index}].workflow_id`, errors),
    workflow_revision: asString(frame.workflow_revision, `workflow.workflow_stack[${index}].workflow_revision`, errors),
    call_node_id: asString(frame.call_node_id, `workflow.workflow_stack[${index}].call_node_id`, errors),
  })) : [];
  const fanOutStack = Array.isArray(value.fan_out_stack) ? value.fan_out_stack.filter(isRecord).map((frame, index) => ({
    workflow_id: asString(frame.workflow_id, `workflow.fan_out_stack[${index}].workflow_id`, errors),
    workflow_revision: asString(frame.workflow_revision, `workflow.fan_out_stack[${index}].workflow_revision`, errors),
    fan_out_node_id: asString(frame.fan_out_node_id, `workflow.fan_out_stack[${index}].fan_out_node_id`, errors),
    fan_in_node_id: asString(frame.fan_in_node_id, `workflow.fan_out_stack[${index}].fan_in_node_id`, errors),
    pending_targets: Array.isArray(frame.pending_targets) ? frame.pending_targets.map(String) : [],
    inputs: Array.isArray(frame.inputs) ? frame.inputs.filter(isRecord).map((item) => ({
      source_node: String(item.source_node ?? ""), target_node: String(item.target_node ?? ""), outcome: String(item.outcome ?? ""),
      summary: typeof item.summary === "string" ? item.summary : null, handoff: typeof item.handoff === "string" ? item.handoff : null,
      output: typeof item.output === "string" ? item.output : null, output_log_path: typeof item.output_log_path === "string" ? item.output_log_path : null,
      actor: typeof item.actor === "string" ? item.actor : "workflow", created_at: typeof item.created_at === "string" ? item.created_at : now,
    } satisfies WorkflowTransitionContext)) : [],
    source: isRecord(frame.source) ? {
      source_node: String(frame.source.source_node ?? ""), target_node: String(frame.source.target_node ?? ""), outcome: String(frame.source.outcome ?? ""),
      summary: typeof frame.source.summary === "string" ? frame.source.summary : null, handoff: typeof frame.source.handoff === "string" ? frame.source.handoff : null,
      output: typeof frame.source.output === "string" ? frame.source.output : null, output_log_path: typeof frame.source.output_log_path === "string" ? frame.source.output_log_path : null,
      actor: typeof frame.source.actor === "string" ? frame.source.actor : "workflow", created_at: typeof frame.source.created_at === "string" ? frame.source.created_at : now,
    } : null,
  })) : [];
  const waitStates: NonNullable<WorkflowRuntime["wait_states"]> = {};
  if (isRecord(value.wait_states)) for (const [key, item] of Object.entries(value.wait_states)) {
    if (!isRecord(item)) { errors.push(`workflow.wait_states.${key} must be an object`); continue; }
    waitStates[key] = {
      workflow_id: asString(item.workflow_id, `workflow.wait_states.${key}.workflow_id`, errors),
      workflow_revision: asString(item.workflow_revision, `workflow.wait_states.${key}.workflow_revision`, errors),
      node_id: asString(item.node_id, `workflow.wait_states.${key}.node_id`, errors),
      started_at: timestamp(item.started_at, `workflow.wait_states.${key}.started_at`, errors),
      wake_at: timestamp(item.wake_at, `workflow.wait_states.${key}.wake_at`, errors),
      deadline_at: timestamp(item.deadline_at, `workflow.wait_states.${key}.deadline_at`, errors),
      attempt: Number.isInteger(item.attempt) && Number(item.attempt) > 0 ? Number(item.attempt) : (errors.push(`workflow.wait_states.${key}.attempt must be positive`), 1),
      node_run_id: asString(item.node_run_id, `workflow.wait_states.${key}.node_run_id`, errors),
    };
  }
  const runLedger = isRecord(value.run_ledger) ? {
    version: value.run_ledger.version === 1 ? 1 as const : (errors.push("workflow.run_ledger.version must be 1"), 1 as const),
    ticket_revision: Number.isInteger(value.run_ledger.ticket_revision) && Number(value.run_ledger.ticket_revision) >= 1
      ? Number(value.run_ledger.ticket_revision) : (errors.push("workflow.run_ledger.ticket_revision must be positive"), 1),
    run_count: Number.isInteger(value.run_ledger.run_count) && Number(value.run_ledger.run_count) >= 0
      ? Number(value.run_ledger.run_count) : (errors.push("workflow.run_ledger.run_count must be non-negative"), 0),
    sha256: typeof value.run_ledger.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.run_ledger.sha256)
      ? value.run_ledger.sha256 : (errors.push("workflow.run_ledger.sha256 must be a SHA-256 digest"), ""),
  } : undefined;
  const costLimitPause = isRecord(value.cost_limit_pause) ? {
    workflow_id: asString(value.cost_limit_pause.workflow_id, "workflow.cost_limit_pause.workflow_id", errors),
    node_id: asString(value.cost_limit_pause.node_id, "workflow.cost_limit_pause.node_id", errors),
    limit_usd: typeof value.cost_limit_pause.limit_usd === "number" && Number.isFinite(value.cost_limit_pause.limit_usd) && value.cost_limit_pause.limit_usd > 0
      ? value.cost_limit_pause.limit_usd : (errors.push("workflow.cost_limit_pause.limit_usd must be positive"), 0),
    observed_usd: typeof value.cost_limit_pause.observed_usd === "number" && Number.isFinite(value.cost_limit_pause.observed_usd) && value.cost_limit_pause.observed_usd >= 0
      ? value.cost_limit_pause.observed_usd : (errors.push("workflow.cost_limit_pause.observed_usd must be non-negative"), 0),
    paused_at: timestamp(value.cost_limit_pause.paused_at, "workflow.cost_limit_pause.paused_at", errors),
  } : null;
  return {
    id: asString(value.id, "workflow.id", errors), revision: asString(value.revision, "workflow.revision", errors),
    current_node: asString(value.current_node, "workflow.current_node", errors),
    started_at: typeof value.started_at === "string" ? timestamp(value.started_at, "workflow.started_at", errors) : nodeRuns[0]?.started_at ?? now,
    completed_at: value.completed_at === null || value.completed_at === undefined ? null : timestamp(value.completed_at, "workflow.completed_at", errors),
    current_node_entered_at: typeof value.current_node_entered_at === "string" ? timestamp(value.current_node_entered_at, "workflow.current_node_entered_at", errors) : incoming?.created_at ?? nodeRuns.at(-1)?.completed_at ?? nodeRuns.at(-1)?.started_at ?? now,
    transition_count: Number.isInteger(value.transition_count) && Number(value.transition_count) >= 0 ? Number(value.transition_count) : (errors.push("workflow.transition_count must be a non-negative integer"), 0),
    node_visits: visits, node_attempts: nodeAttempts, node_runs: nodeRuns, ...(runLedger ? { run_ledger: runLedger } : {}), prompt_revisions: promptRevisions, inputs, stage_enabled: stageEnabled, incoming,
    active_workflow_id: typeof value.active_workflow_id === "string" ? value.active_workflow_id : asString(value.id, "workflow.id", errors),
    active_workflow_revision: typeof value.active_workflow_revision === "string" ? value.active_workflow_revision : asString(value.revision, "workflow.revision", errors),
    workflow_revisions: Object.keys(workflowRevisions).length ? workflowRevisions : { [String(value.id ?? "")]: String(value.revision ?? "") },
    cost_limit_pause: costLimitPause,
    workflow_stack: workflowStack, fan_out_stack: fanOutStack, wait_states: waitStates, resolved_agent_profiles: resolvedProfiles,
  };
}

export function normalizeTicket(raw: Record<string, unknown>, now = new Date().toISOString()): { ticket: TicketFrontmatter; errors: string[]; admitted: boolean } {
  const errors: string[] = [];
  const id = asString(raw.id, "id", errors);
  const title = asString(raw.title, "title", errors);
  const repositories = Array.isArray(raw.repositories) ? raw.repositories.map((item, index) => {
    if (!isRecord(item)) { errors.push(`repositories[${index}] must be an object`); return { id: "", primary: false }; }
    return { id: asString(item.id, `repositories[${index}].id`, errors), primary: item.primary === true };
  }) : (errors.push("repositories must be an array"), []);
  if (repositories.length === 0) errors.push("repositories must contain at least one entry");
  if (repositories.filter((item) => item.primary).length !== 1) errors.push("repositories must contain exactly one primary entry");
  if (new Set(repositories.map((item) => item.id)).size !== repositories.length) errors.push("repository ids must be unique");

  const attachments: TicketFrontmatter["attachments"] = [];
  if (raw.attachments !== undefined && !Array.isArray(raw.attachments)) errors.push("attachments must be an array");
  else if (Array.isArray(raw.attachments)) raw.attachments.forEach((item, index) => {
    if (!isRecord(item)) { errors.push(`attachments[${index}] must be an object`); return; }
    const id = asString(item.id, `attachments[${index}].id`, errors);
    const filename = asString(item.filename, `attachments[${index}].filename`, errors);
    const contentType = asString(item.content_type, `attachments[${index}].content_type`, errors);
    const size = Number.isInteger(item.size_bytes) && Number(item.size_bytes) >= 0
      ? Number(item.size_bytes) : (errors.push(`attachments[${index}].size_bytes must be a non-negative integer`), 0);
    const sha256 = asString(item.sha256, `attachments[${index}].sha256`, errors);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) errors.push(`attachments[${index}].id is invalid`);
    if (filename.length > 255 || filename.includes("/") || filename.includes("\\") || /[\x00-\x1f\x7f]/.test(filename)) errors.push(`attachments[${index}].filename must be a basename of at most 255 printable characters`);
    if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(contentType)) errors.push(`attachments[${index}].content_type must be a MIME type without parameters`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) errors.push(`attachments[${index}].sha256 must be a SHA-256 digest`);
    attachments.push({ id, filename, content_type: contentType, size_bytes: size, sha256, created_at: timestamp(item.created_at, `attachments[${index}].created_at`, errors) });
  });
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) errors.push("attachment ids must be unique");
  if (attachments.length > 100) errors.push("attachments must not contain more than 100 entries");

  const artifacts: TicketFrontmatter["artifacts"] = [];
  if (raw.artifacts !== undefined && !Array.isArray(raw.artifacts)) errors.push("artifacts must be an array");
  else if (Array.isArray(raw.artifacts)) raw.artifacts.forEach((item, index) => {
    if (!isRecord(item)) { errors.push(`artifacts[${index}] must be an object`); return; }
    const kind = ["attachment", "evidence", "script_output", "script_artifact", "quality_report", "checkpoint_bundle", "checkpoint_manifest", "execution_manifest", "execution_trace", "agent_transcript", "harness_session_log"].includes(String(item.kind))
      ? item.kind as TicketFrontmatter["artifacts"][number]["kind"]
      : (errors.push(`artifacts[${index}].kind is invalid`), "script_artifact" as const);
    const metadata = isRecord(item.metadata) ? jsonValue(item.metadata, `artifacts[${index}].metadata`, errors) : {};
    artifacts.push({
      id: asString(item.id, `artifacts[${index}].id`, errors), kind,
      ticket_id: asString(item.ticket_id, `artifacts[${index}].ticket_id`, errors),
      node_run_id: optionalString(item.node_run_id, `artifacts[${index}].node_run_id`, errors),
      filename: asString(item.filename, `artifacts[${index}].filename`, errors),
      content_type: asString(item.content_type, `artifacts[${index}].content_type`, errors),
      size_bytes: Number.isInteger(item.size_bytes) && Number(item.size_bytes) >= 0 ? Number(item.size_bytes) : (errors.push(`artifacts[${index}].size_bytes is invalid`), 0),
      sha256: asString(item.sha256, `artifacts[${index}].sha256`, errors),
      created_at: timestamp(item.created_at, `artifacts[${index}].created_at`, errors),
      metadata: isRecord(metadata) ? metadata : {},
    });
  });
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) errors.push("artifact ids must be unique");
  if (artifacts.length > 1_000) errors.push("artifacts must not contain more than 1000 entries");
  for (const artifact of artifacts) {
    if (artifact.ticket_id !== id) errors.push(`artifact ${artifact.id} belongs to another ticket`);
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) errors.push(`artifact ${artifact.id} has an invalid SHA-256 digest`);
    if (artifact.kind === "quality_report" && !qualityReportMetadata(artifact)) errors.push(`quality report artifact ${artifact.id} has invalid normalized metadata`);
  }

  const checkpoints: TicketFrontmatter["checkpoints"] = [];
  if (raw.checkpoints !== undefined && !Array.isArray(raw.checkpoints)) errors.push("checkpoints must be an array");
  else if (Array.isArray(raw.checkpoints)) raw.checkpoints.forEach((item, index) => {
    if (!isRecord(item)) { errors.push(`checkpoints[${index}] must be an object`); return; }
    const checkpointRepositories: TicketFrontmatter["checkpoints"][number]["repositories"] = [];
    if (!Array.isArray(item.repositories)) errors.push(`checkpoints[${index}].repositories must be an array`);
    else item.repositories.forEach((repository, repositoryIndex) => {
      if (!isRecord(repository)) { errors.push(`checkpoints[${index}].repositories[${repositoryIndex}] must be an object`); return; }
      checkpointRepositories.push({
        repository: asString(repository.repository, `checkpoints[${index}].repositories[${repositoryIndex}].repository`, errors),
        head_sha: asString(repository.head_sha, `checkpoints[${index}].repositories[${repositoryIndex}].head_sha`, errors),
        snapshot_sha: asString(repository.snapshot_sha, `checkpoints[${index}].repositories[${repositoryIndex}].snapshot_sha`, errors),
        branch: optionalString(repository.branch, `checkpoints[${index}].repositories[${repositoryIndex}].branch`, errors),
        remote_url: optionalString(repository.remote_url, `checkpoints[${index}].repositories[${repositoryIndex}].remote_url`, errors),
        dirty: repository.dirty === true,
        bundle_artifact_id: asString(repository.bundle_artifact_id, `checkpoints[${index}].repositories[${repositoryIndex}].bundle_artifact_id`, errors),
      });
    });
    checkpoints.push({
      id: asString(item.id, `checkpoints[${index}].id`, errors),
      label: asString(item.label, `checkpoints[${index}].label`, errors),
      kind: ["workflow", "manual", "pre_restore"].includes(String(item.kind)) ? item.kind as "workflow" | "manual" | "pre_restore" : (errors.push(`checkpoints[${index}].kind is invalid`), "workflow"),
      node_id: asString(item.node_id, `checkpoints[${index}].node_id`, errors),
      node_run_id: optionalString(item.node_run_id, `checkpoints[${index}].node_run_id`, errors),
      created_at: timestamp(item.created_at, `checkpoints[${index}].created_at`, errors),
      repositories: checkpointRepositories,
      manifest_artifact_id: asString(item.manifest_artifact_id, `checkpoints[${index}].manifest_artifact_id`, errors),
    });
  });
  if (new Set(checkpoints.map((checkpoint) => checkpoint.id)).size !== checkpoints.length) errors.push("checkpoint ids must be unique");
  if (checkpoints.length > 200) errors.push("checkpoints must not contain more than 200 entries");

  const defaultPhase: Phase = "implementation";
  const phase = raw.phase === undefined ? defaultPhase : PHASES.includes(raw.phase as never)
    ? raw.phase as Phase : (errors.push("phase must be specification, implementation, review, or done"), defaultPhase);
  const status = raw.status === undefined ? "pending" : STATUSES.includes(raw.status as never)
    ? raw.status as TicketFrontmatter["status"] : (errors.push("status is not recognized"), "pending");
  if (!phaseStatuses[phase].has(status)) errors.push(`${phase}/${status} is not a valid phase/status combination`);

  const currentExecution = execution(raw.execution, errors);
  const workflow = workflowRuntime(raw.workflow, errors, now);
  if (workflow && !/^[a-f0-9]{64}$/.test(workflow.revision)) errors.push("workflow.revision must be a SHA-256 digest");
  let workflowAssignment: TicketFrontmatter["workflow_assignment"] = null;
  if (raw.workflow_assignment !== null && raw.workflow_assignment !== undefined) {
    if (!isRecord(raw.workflow_assignment)) errors.push("workflow_assignment must be an object or null");
    else {
      const selection = ["default", "manual_trial", "experiment"].includes(String(raw.workflow_assignment.selection))
        ? raw.workflow_assignment.selection as NonNullable<TicketFrontmatter["workflow_assignment"]>["selection"]
        : (errors.push("workflow_assignment.selection is invalid"), "default" as const);
      workflowAssignment = {
        workflow_id: asString(raw.workflow_assignment.workflow_id, "workflow_assignment.workflow_id", errors),
        revision: asString(raw.workflow_assignment.revision, "workflow_assignment.revision", errors),
        version: Number.isInteger(raw.workflow_assignment.version) && Number(raw.workflow_assignment.version) > 0
          ? Number(raw.workflow_assignment.version) : (errors.push("workflow_assignment.version must be a positive integer"), 1),
        selection,
        assigned_at: timestamp(raw.workflow_assignment.assigned_at, "workflow_assignment.assigned_at", errors),
        experiment_id: optionalString(raw.workflow_assignment.experiment_id, "workflow_assignment.experiment_id", errors),
      };
      if (!/^[a-f0-9]{64}$/.test(workflowAssignment.revision)) errors.push("workflow_assignment.revision must be a SHA-256 digest");
      if (selection === "experiment" && !workflowAssignment.experiment_id) errors.push("experiment workflow assignments require experiment_id");
    }
  } else if (workflow) {
    workflowAssignment = {
      workflow_id: workflow.id, revision: workflow.revision, version: 1, selection: "default",
      assigned_at: workflow.started_at, experiment_id: null,
    };
  }
  if (status === "running" && !currentExecution) errors.push("running tickets require execution");
  if (currentExecution && currentExecution.phase !== phase) errors.push("execution does not match ticket phase/provider");

  const labels = raw.labels === undefined ? [] : Array.isArray(raw.labels) && raw.labels.every((item) => typeof item === "string")
    ? raw.labels as string[] : (errors.push("labels must be an array of strings"), []);
  const pullRequests = Array.isArray(raw.pull_requests) ? raw.pull_requests.filter(isRecord).map((item) => {
    const observation = isRecord(item.observation) ? {
      checked_at: typeof item.observation.checked_at === "string" ? item.observation.checked_at : now,
      state: typeof item.observation.state === "string" ? item.observation.state : "unknown",
      draft: item.observation.draft === true,
      merged: item.observation.merged === true,
      mergeable: typeof item.observation.mergeable === "boolean" ? item.observation.mergeable : null,
      last_issue_comment_id: Number.isInteger(item.observation.last_issue_comment_id) ? Number(item.observation.last_issue_comment_id) : 0,
      last_review_comment_id: Number.isInteger(item.observation.last_review_comment_id) ? Number(item.observation.last_review_comment_id) : 0,
      last_review_id: Number.isInteger(item.observation.last_review_id) ? Number(item.observation.last_review_id) : 0,
      merge_conflict_reported: item.observation.merge_conflict_reported === true,
    } : null;
    const phase: PullRequestRef["phase"] = item.phase === "specification" || item.phase === "implementation" || item.phase === "review" ? item.phase : undefined;
    return {
      repository: typeof item.repository === "string" ? item.repository : "",
      url: typeof item.url === "string" ? item.url : "",
      ...(phase ? { phase } : {}),
      ...(observation ? { observation } : {}),
    };
  }).filter((item) => item.repository && item.url) : [];
  const questions = Array.isArray(raw.questions) ? raw.questions.filter(isRecord).map((item, index) => {
    const phase: TicketQuestion["phase"] = item.phase === "specification" || item.phase === "implementation" || item.phase === "review"
      ? item.phase : (errors.push(`questions[${index}].phase must be an assignable phase`), "implementation");
    return {
      id: asString(item.id, `questions[${index}].id`, errors), phase,
      question: asString(item.question, `questions[${index}].question`, errors),
      options: item.options === undefined ? [] : Array.isArray(item.options)
        ? item.options.map((option, optionIndex) => asString(option, `questions[${index}].options[${optionIndex}]`, errors))
        : (errors.push(`questions[${index}].options must be an array`), []),
      asked_at: timestamp(item.asked_at, `questions[${index}].asked_at`, errors),
      answer: optionalString(item.answer, `questions[${index}].answer`, errors),
      answered_at: item.answered_at === null || item.answered_at === undefined ? null : timestamp(item.answered_at, `questions[${index}].answered_at`, errors),
    };
  }) : [];
  let jira: TicketFrontmatter["jira"] = null;
  if (raw.jira !== null && raw.jira !== undefined) {
    if (!isRecord(raw.jira)) errors.push("jira must be an object or null");
    else jira = {
      key: asString(raw.jira.key, "jira.key", errors), issue_id: asString(raw.jira.issue_id, "jira.issue_id", errors),
      url: asString(raw.jira.url, "jira.url", errors), last_synced_at: timestamp(raw.jira.last_synced_at, "jira.last_synced_at", errors),
      source_updated_at: optionalString(raw.jira.source_updated_at, "jira.source_updated_at", errors),
    };
  }
  const archivedAt = raw.archived_at === null || raw.archived_at === undefined ? null : timestamp(raw.archived_at, "archived_at", errors);
  if (archivedAt && (phase !== "done" || status !== "completed")) errors.push("only completed tickets may be archived");
  const productionResult = PRODUCTION_RESULTS.includes(raw.production_result as never) ? raw.production_result as TicketFrontmatter["production_result"] : "unassessed";
  if (raw.production_result !== undefined && !PRODUCTION_RESULTS.includes(raw.production_result as never)) errors.push("production_result is invalid");
  const productionAssessedAt = raw.production_assessed_at === null || raw.production_assessed_at === undefined
    ? null : timestamp(raw.production_assessed_at, "production_assessed_at", errors);
  const productionAssessmentNote = optionalString(raw.production_assessment_note, "production_assessment_note", errors);
  if (productionResult === "unassessed" && productionAssessedAt) errors.push("unassessed production_result cannot have production_assessed_at");
  if (productionResult !== "unassessed" && !productionAssessedAt) errors.push("assessed production_result requires production_assessed_at");
  const estimatedHumanDays = raw.estimated_human_days === null || raw.estimated_human_days === undefined ? null
    : typeof raw.estimated_human_days === "number" && Number.isFinite(raw.estimated_human_days) && raw.estimated_human_days >= 0
      ? raw.estimated_human_days : (errors.push("estimated_human_days must be a non-negative number or null"), null);

  const metadata: Record<string, JsonValue> = {};
  if (raw.metadata !== undefined && !isRecord(raw.metadata)) errors.push("metadata must be an object");
  else if (isRecord(raw.metadata)) for (const [key, value] of Object.entries(raw.metadata)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) { errors.push(`metadata key ${key} is invalid`); continue; }
    const normalized = jsonValue(value, `metadata.${key}`, errors);
    if (normalized !== undefined) metadata[key] = normalized;
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > 65_536) errors.push("metadata must not exceed 64 KiB");

  const admitted = raw.phase === undefined || raw.status === undefined || raw.revision === undefined;
  const ticket: TicketFrontmatter = {
    id, title, phase, status,
    priority: raw.priority === undefined ? 0 : Number.isInteger(raw.priority) ? Number(raw.priority) : (errors.push("priority must be an integer"), 0),
    labels,
    repositories,
    attachments,
    artifacts,
    checkpoints,
    assigned_supervisor: raw.assigned_supervisor === undefined
      ? currentExecution?.supervisor_id ?? null
      : raw.assigned_supervisor === null ? null : asString(raw.assigned_supervisor, "assigned_supervisor", errors),
    assigned_supervisor_host: raw.assigned_supervisor_host === null || raw.assigned_supervisor_host === undefined
      ? null : asString(raw.assigned_supervisor_host, "assigned_supervisor_host", errors),
    execution: currentExecution,
    pull_requests: pullRequests,
    questions,
    metadata,
    jira,
    production_result: productionResult,
    production_assessed_at: productionAssessedAt,
    production_assessment_note: productionAssessmentNote,
    estimated_human_days: estimatedHumanDays,
    archived_at: archivedAt,
    revision: Number.isInteger(raw.revision) && Number(raw.revision) > 0 ? Number(raw.revision) : 1,
    event_sequence: Number.isInteger(raw.event_sequence) && Number(raw.event_sequence) >= 0 ? Number(raw.event_sequence) : 0,
    created_at: typeof raw.created_at === "string" ? raw.created_at : now,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : now,
    last_callback: isRecord(raw.last_callback) ? raw.last_callback as unknown as TicketFrontmatter["last_callback"] : null,
    workflow,
    workflow_assignment: workflowAssignment,
    conversations: isRecord(raw.conversations)
      ? Object.fromEntries(Object.entries(raw.conversations).map(([key, value]) => [key, agent(value)]))
      : {},
  };
  return { ticket, errors, admitted };
}

export function validateSessionInvariant(ticket: TicketFrontmatter): string[] {
  const errors: string[] = [];
  if (ticket.execution && ticket.assigned_supervisor !== ticket.execution.supervisor_id) {
    errors.push("execution supervisor must match assigned_supervisor");
  }
  return errors;
}
