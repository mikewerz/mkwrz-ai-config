import type { ProductionResult, Provider, TicketFrontmatter, WorkflowNodeRun } from "./domain.js";
import type { TicketStore } from "./ticket-store.js";
import { workflowRoutes, type WorkflowLibrary, type WorkflowNode } from "./workflow-library.js";
import type { MetricsConfig } from "./config-store.js";
import { qualityReportMetadata, type NormalizedQualityAttribute, type QualityDirection, type QualityStatus } from "./quality.js";

export interface MetricsFilters {
  from?: string;
  to?: string;
  labels: string[];
  label_mode: "any" | "all";
  workflow_id?: string;
  workflow_revision?: string;
  repositories: string[];
  production_result?: ProductionResult;
}

export interface NumberSummary {
  count: number;
  min: number | null;
  q1: number | null;
  median: number | null;
  q3: number | null;
  max: number | null;
  mean: number | null;
  p90: number | null;
  p95: number | null;
}

type MetricClass = "success" | "failure" | "neutral" | "unclassified";

function quantile(sorted: number[], position: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

export function numberSummary(values: number[]): NumberSummary {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    q1: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    q3: quantile(sorted, 0.75),
    max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
  };
}

function matches(ticket: TicketFrontmatter, filters: MetricsFilters): boolean {
  const created = Date.parse(ticket.created_at);
  if (filters.from && created < Date.parse(filters.from)) return false;
  if (filters.to && created > Date.parse(filters.to)) return false;
  const assignment = ticket.workflow_assignment ?? (ticket.workflow ? { workflow_id: ticket.workflow.id, revision: ticket.workflow.revision } : null);
  if (filters.workflow_id && assignment?.workflow_id !== filters.workflow_id) return false;
  if (filters.workflow_revision && assignment?.revision !== filters.workflow_revision) return false;
  if (filters.production_result && ticket.production_result !== filters.production_result) return false;
  if (filters.repositories.length && !filters.repositories.some((id) => ticket.repositories.some((repo) => repo.id === id))) return false;
  if (filters.labels.length) {
    const has = (label: string) => ticket.labels.includes(label);
    if (filters.label_mode === "all" ? !filters.labels.every(has) : !filters.labels.some(has)) return false;
  }
  return true;
}

function completedTicket(ticket: TicketFrontmatter): boolean {
  return ticket.status === "completed" && ticket.phase === "done" && Boolean(ticket.workflow?.completed_at);
}

function crossedOver(ticket: TicketFrontmatter): boolean {
  const assignment = ticket.workflow_assignment;
  if (!assignment || !ticket.workflow) return false;
  if (ticket.workflow.id !== assignment.workflow_id || ticket.workflow.revision !== assignment.revision) return true;
  return ticket.workflow.node_runs.some((run) => (run.workflow_id ?? ticket.workflow!.id) === assignment.workflow_id && run.workflow_revision !== assignment.revision);
}

function elapsed(run: WorkflowNodeRun): number | null {
  if (!run.completed_at) return null;
  const value = Date.parse(run.completed_at) - Date.parse(run.started_at);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

interface TicketAccounting {
  tokens: number;
  cost: number;
  tokens_complete: boolean;
  cost_complete: boolean;
  agent_runs: number;
  token_runs: number;
  cost_runs: number;
  estimated_cost_runs: number;
  active_ms: number;
  quota_paused_ms: number;
  human_wait_ms: number;
  external_wait_ms: number;
}

function accounting(ticket: TicketFrontmatter): TicketAccounting {
  const runs = ticket.workflow?.node_runs ?? [];
  const agentRuns = runs.filter((run) => run.node_type === "agent" && run.provider !== null && run.status !== "running");
  const tokenRuns = agentRuns.filter((run) => run.telemetry?.delta.usage);
  const costRuns = agentRuns.filter((run) => run.telemetry?.delta.cost_usd !== null && run.telemetry?.delta.cost_usd !== undefined);
  return {
    tokens: tokenRuns.reduce((sum, run) => sum + (run.telemetry?.delta.usage?.total_tokens ?? 0), 0),
    cost: costRuns.reduce((sum, run) => sum + (run.telemetry?.delta.cost_usd ?? 0), 0),
    tokens_complete: agentRuns.length > 0 && tokenRuns.length === agentRuns.length,
    cost_complete: agentRuns.length > 0 && costRuns.length === agentRuns.length,
    agent_runs: agentRuns.length,
    token_runs: tokenRuns.length,
    cost_runs: costRuns.length,
    estimated_cost_runs: costRuns.filter((run) => run.telemetry?.latest.cost.kind === "estimated").length,
    active_ms: runs.reduce((sum, run) => sum + run.timing.active_ms, 0),
    quota_paused_ms: runs.reduce((sum, run) => sum + run.timing.quota_paused_ms, 0),
    human_wait_ms: runs.reduce((sum, run) => sum + run.timing.human_wait_ms, 0),
    external_wait_ms: runs.reduce((sum, run) => sum + run.timing.external_wait_ms, 0),
  };
}

interface MutableBranch {
  outcome: string;
  label: string;
  target: string | null;
  metric_class: MetricClass;
  count: number;
}

interface MutableNode {
  workflow_id: string;
  workflow_revision: string;
  node_id: string;
  node_name: string;
  node_type: string;
  ticket_ids: Set<string>;
  runs: number;
  completed: number;
  running: number;
  interrupted: number;
  bypassed: number;
  lease_lost: number;
  delivery_failed: number;
  success: number;
  failure: number;
  neutral: number;
  unclassified: number;
  wall: number[];
  active_ms: number;
  quota_paused_ms: number;
  human_wait_ms: number;
  external_wait_ms: number;
  tokens: number;
  token_runs: number;
  cost: number;
  cost_runs: number;
  branches: Map<string, MutableBranch>;
  quality: Map<string, MutableQuality>;
}

interface MutableQuality {
  key: string;
  label: string;
  type: "number" | "boolean" | "string";
  unit: string;
  direction: QualityDirection;
  ticket_ids: Set<string>;
  reports: number;
  statuses: Record<QualityStatus, number>;
  numeric_values: number[];
  values: Map<string, number>;
}

function finalQualityByRun(ticket: TicketFrontmatter): Map<string, NormalizedQualityAttribute[]> {
  const latest = new Map<string, { runId: string; createdAt: string; attribute: NormalizedQualityAttribute }>();
  for (const artifact of ticket.artifacts) {
    if (!artifact.node_run_id) continue;
    const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === artifact.node_run_id);
    const report = qualityReportMetadata(artifact);
    if (!run || run.status !== "completed" || !report) continue;
    for (const attribute of report.attributes.filter((candidate) => candidate.registered)) {
      const identity = `${run.workflow_id ?? ticket.workflow!.id}@${run.workflow_revision}/${run.node_id}/${attribute.key}`;
      const previous = latest.get(identity);
      if (!previous || artifact.created_at >= previous.createdAt) latest.set(identity, { runId: run.id, createdAt: artifact.created_at, attribute });
    }
  }
  const byRun = new Map<string, NormalizedQualityAttribute[]>();
  for (const item of latest.values()) byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item.attribute]);
  return byRun;
}

interface MutableProfile {
  alias: string;
  provider: Provider | null;
  model: string | null;
  reasoning: string | null;
  runs: number;
  success: number;
  failure: number;
  tokens: number;
  token_runs: number;
  cost: number;
  cost_runs: number;
  wall: number[];
}

export async function buildMetrics(store: TicketStore, workflows: WorkflowLibrary, filters: MetricsFilters, metricsConfig: MetricsConfig = { human_day_rate_usd: 1_000 }, options: { excludeCrossovers?: boolean } = {}) {
  const loaded = await store.list();
  const all = loaded.flatMap((item) => item.valid && item.frontmatter ? [item.frontmatter] : []);
  const tickets = all.filter((ticket) => matches(ticket, filters));
  const definitions = new Map<string, { node: (id: string) => WorkflowNode | undefined } | null>();
  const definitionFor = async (id: string, revision: string) => {
    const key = `${id}@${revision}`;
    if (!definitions.has(key)) {
      try {
        const definition = (await workflows.get(id, revision)).definition;
        definitions.set(key, { node: (nodeId) => definition.nodes.find((node) => node.id === nodeId) });
      } catch { definitions.set(key, null); }
    }
    return definitions.get(key) ?? null;
  };

  const nodeMetrics = new Map<string, MutableNode>();
  const profileMetrics = new Map<string, MutableProfile>();
  const accounts = tickets.map((ticket) => ({ ticket, value: accounting(ticket) }));
  const completedTickets = tickets.filter((ticket) => completedTicket(ticket) && (!options.excludeCrossovers || !crossedOver(ticket)));
  for (const ticket of completedTickets) {
    const qualityByRun = finalQualityByRun(ticket);
    for (const run of ticket.workflow?.node_runs ?? []) {
    const workflowId = run.workflow_id ?? ticket.workflow!.id;
    const definition = await definitionFor(workflowId, run.workflow_revision);
    const node = definition?.node(run.node_id);
    const key = `${workflowId}@${run.workflow_revision}/${run.node_id}`;
    const metric = nodeMetrics.get(key) ?? {
      workflow_id: workflowId, workflow_revision: run.workflow_revision, node_id: run.node_id,
      node_name: node?.name ?? run.node_id, node_type: run.node_type, ticket_ids: new Set<string>(),
      runs: 0, completed: 0, running: 0, interrupted: 0, bypassed: 0, lease_lost: 0, delivery_failed: 0,
      success: 0, failure: 0, neutral: 0, unclassified: 0, wall: [], active_ms: 0,
      quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, tokens: 0, token_runs: 0, cost: 0, cost_runs: 0,
      branches: new Map<string, MutableBranch>(), quality: new Map<string, MutableQuality>(),
    };
    nodeMetrics.set(key, metric); metric.ticket_ids.add(ticket.id); metric.runs += 1;
    if (run.status === "running") metric.running += 1;
    else if (run.status === "interrupted") metric.interrupted += 1;
    else metric.completed += 1;
    if (run.outcome === "bypassed") metric.bypassed += 1;
    if (run.outcome === "lease_lost") metric.lease_lost += 1;
    if (run.outcome === "delivery_failed") metric.delivery_failed += 1;
    const wall = elapsed(run); if (wall !== null) metric.wall.push(wall);
    metric.active_ms += run.timing.active_ms; metric.quota_paused_ms += run.timing.quota_paused_ms; metric.human_wait_ms += run.timing.human_wait_ms; metric.external_wait_ms += run.timing.external_wait_ms;
    if (run.telemetry?.delta.usage) { metric.tokens += run.telemetry.delta.usage.total_tokens; metric.token_runs += 1; }
    if (run.telemetry?.delta.cost_usd !== null && run.telemetry?.delta.cost_usd !== undefined) { metric.cost += run.telemetry.delta.cost_usd; metric.cost_runs += 1; }
    const route = node && run.outcome ? workflowRoutes(node).find((candidate) => candidate.id === run.outcome) : undefined;
    const metricClass: MetricClass = route?.metric_class
      ?? (run.status === "failed" ? "failure" : node?.type === "write" || node?.type === "fan_in" ? "success" : "unclassified");
    const operationalFailure = run.outcome === "lease_lost" || run.outcome === "delivery_failed";
    if (run.outcome && run.outcome !== "bypassed" && !operationalFailure && run.status !== "interrupted") metric[metricClass] += 1;
    if (run.outcome) {
      const branch = metric.branches.get(run.outcome) ?? {
        outcome: run.outcome, label: route?.label ?? run.outcome, target: route?.target ?? null, metric_class: metricClass, count: 0,
      };
      branch.count += 1; metric.branches.set(run.outcome, branch);
    }
    if (run.node_type === "agent" && run.provider !== null) {
      const resolved = ticket.workflow?.resolved_agent_profiles?.[`${workflowId}/${run.node_id}`];
      const alias = resolved?.alias ?? `unresolved-${run.provider ?? "unknown"}`;
      const profileKey = `${alias}/${resolved?.provider ?? run.provider ?? "unknown"}/${resolved?.model ?? "unknown"}/${resolved?.reasoning ?? "unknown"}`;
      const profile = profileMetrics.get(profileKey) ?? {
        alias, provider: resolved?.provider ?? run.provider ?? null, model: resolved?.model ?? run.telemetry?.latest.model.id ?? null,
        reasoning: resolved?.reasoning ?? run.telemetry?.latest.reasoning.effort ?? null, runs: 0, success: 0, failure: 0,
        tokens: 0, token_runs: 0, cost: 0, cost_runs: 0, wall: [],
      };
      profileMetrics.set(profileKey, profile); profile.runs += 1;
      if (!operationalFailure && metricClass === "success") profile.success += 1;
      if (!operationalFailure && metricClass === "failure") profile.failure += 1;
      if (run.telemetry?.delta.usage) { profile.tokens += run.telemetry.delta.usage.total_tokens; profile.token_runs += 1; }
      if (run.telemetry?.delta.cost_usd !== null && run.telemetry?.delta.cost_usd !== undefined) { profile.cost += run.telemetry.delta.cost_usd; profile.cost_runs += 1; }
      if (wall !== null) profile.wall.push(wall);
    }
    for (const attribute of qualityByRun.get(run.id) ?? []) {
      const semanticKey = `${attribute.key}/${attribute.type}/${attribute.unit}/${attribute.direction}`;
      const quality = metric.quality.get(semanticKey) ?? {
        key: attribute.key, label: attribute.label, type: attribute.type, unit: attribute.unit, direction: attribute.direction,
        ticket_ids: new Set<string>(), reports: 0, statuses: { pass: 0, warn: 0, fail: 0, unknown: 0 }, numeric_values: [], values: new Map<string, number>(),
      };
      metric.quality.set(semanticKey, quality); quality.ticket_ids.add(ticket.id); quality.reports += 1; quality.statuses[attribute.status] += 1;
      if (typeof attribute.value === "number") quality.numeric_values.push(attribute.value);
      const display = String(attribute.value); quality.values.set(display, (quality.values.get(display) ?? 0) + 1);
    }
  }
  }

  const production: Record<ProductionResult, number> = Object.fromEntries(
    (["unassessed", "succeeded", "failed", "rolled_back", "not_deployed"] satisfies ProductionResult[])
      .map((result) => [result, tickets.filter((ticket) => ticket.production_result === result).length]),
  ) as Record<ProductionResult, number>;
  const assessed = tickets.length - production.unassessed;
  const durationValues = tickets.flatMap((ticket) => ticket.workflow?.completed_at
    ? [Math.max(0, Date.parse(ticket.workflow.completed_at) - Date.parse(ticket.created_at))] : []);
  const classifiedProduction = production.succeeded + production.failed + production.rolled_back;
  const humanEstimated = accounts.filter((item) => item.ticket.estimated_human_days !== null);
  const comparable = humanEstimated.filter((item) => item.ticket.status === "completed" && item.ticket.phase === "done" && Boolean(item.ticket.workflow?.completed_at) && item.value.cost_complete);
  const humanDays = humanEstimated.reduce((sum, item) => sum + (item.ticket.estimated_human_days ?? 0), 0);
  const comparableHumanCost = comparable.reduce((sum, item) => sum + (item.ticket.estimated_human_days ?? 0) * metricsConfig.human_day_rate_usd, 0);
  const comparableFactoryCost = comparable.reduce((sum, item) => sum + item.value.cost, 0);
  const comparableSavings = comparableHumanCost - comparableFactoryCost;
  return {
    generated_at: new Date().toISOString(), filters,
    available: {
      labels: [...new Set(all.flatMap((ticket) => ticket.labels))].sort(),
      workflows: [...new Map(all.flatMap((ticket) => {
        const assignment = ticket.workflow_assignment ?? (ticket.workflow ? { workflow_id: ticket.workflow.id, revision: ticket.workflow.revision } : null);
        return assignment ? [[`${assignment.workflow_id}@${assignment.revision}`, { id: assignment.workflow_id, revision: assignment.revision }]] : [];
      })).values()],
      repositories: [...new Set(all.flatMap((ticket) => ticket.repositories.map((repo) => repo.id)))].sort(),
    },
    totals: {
      tickets: tickets.length,
      completed: tickets.filter((ticket) => ticket.status === "completed").length,
      archived: tickets.filter((ticket) => ticket.archived_at).length,
      total_tokens: accounts.reduce((sum, item) => sum + item.value.tokens, 0),
      known_cost_usd: accounts.reduce((sum, item) => sum + item.value.cost, 0),
      active_ms: accounts.reduce((sum, item) => sum + item.value.active_ms, 0),
      quota_paused_ms: accounts.reduce((sum, item) => sum + item.value.quota_paused_ms, 0),
      human_wait_ms: accounts.reduce((sum, item) => sum + item.value.human_wait_ms, 0),
      external_wait_ms: accounts.reduce((sum, item) => sum + item.value.external_wait_ms, 0),
      production,
      production_assessed: assessed,
      production_success_rate: classifiedProduction ? production.succeeded / classifiedProduction : null,
      estimated_human_days: humanDays,
      estimated_human_cost_usd: humanDays * metricsConfig.human_day_rate_usd,
      human_day_rate_usd: metricsConfig.human_day_rate_usd,
      comparison_tickets: comparable.length,
      comparison_human_cost_usd: comparableHumanCost,
      comparison_factory_cost_usd: comparableFactoryCost,
      comparison_savings_usd: comparableSavings,
      comparison_savings_rate: comparableHumanCost > 0 ? comparableSavings / comparableHumanCost : null,
    },
    coverage: {
      agent_runs: accounts.reduce((sum, item) => sum + item.value.agent_runs, 0),
      token_runs: accounts.reduce((sum, item) => sum + item.value.token_runs, 0),
      cost_runs: accounts.reduce((sum, item) => sum + item.value.cost_runs, 0),
      estimated_cost_runs: accounts.reduce((sum, item) => sum + item.value.estimated_cost_runs, 0),
      complete_token_tickets: accounts.filter((item) => item.value.tokens_complete).length,
      complete_cost_tickets: accounts.filter((item) => item.value.cost_complete).length,
    },
    summaries: {
      ticket_duration_ms: numberSummary(durationValues),
      active_time_ms: numberSummary(accounts.map((item) => item.value.active_ms)),
      human_wait_ms: numberSummary(accounts.map((item) => item.value.human_wait_ms)),
      external_wait_ms: numberSummary(accounts.map((item) => item.value.external_wait_ms)),
      quota_pause_ms: numberSummary(accounts.map((item) => item.value.quota_paused_ms)),
      tokens_per_ticket: numberSummary(accounts.filter((item) => item.value.tokens_complete).map((item) => item.value.tokens)),
      cost_per_ticket_usd: numberSummary(accounts.filter((item) => item.value.cost_complete).map((item) => item.value.cost)),
      estimated_human_days: numberSummary(humanEstimated.map((item) => item.ticket.estimated_human_days!)),
      estimated_human_cost_usd: numberSummary(humanEstimated.map((item) => item.ticket.estimated_human_days! * metricsConfig.human_day_rate_usd)),
    },
    workflows: [...nodeMetrics.values()].reduce<Array<{ workflow_id: string; workflow_revision: string; ticket_ids: Set<string>; nodes: MutableNode[] }>>((groups, node) => {
      let group = groups.find((item) => item.workflow_id === node.workflow_id && item.workflow_revision === node.workflow_revision);
      if (!group) { group = { workflow_id: node.workflow_id, workflow_revision: node.workflow_revision, ticket_ids: new Set(), nodes: [] }; groups.push(group); }
      node.ticket_ids.forEach((id) => group!.ticket_ids.add(id)); group.nodes.push(node); return groups;
    }, completedTickets.reduce<Array<{ workflow_id: string; workflow_revision: string; ticket_ids: Set<string>; nodes: MutableNode[] }>>((groups, ticket) => {
      const assignment = ticket.workflow_assignment ?? (ticket.workflow ? { workflow_id: ticket.workflow.id, revision: ticket.workflow.revision } : null);
      if (!assignment) return groups;
      let group = groups.find((item) => item.workflow_id === assignment.workflow_id && item.workflow_revision === assignment.revision);
      if (!group) { group = { workflow_id: assignment.workflow_id, workflow_revision: assignment.revision, ticket_ids: new Set(), nodes: [] }; groups.push(group); }
      group.ticket_ids.add(ticket.id); return groups;
    }, [])).map((group) => ({
      workflow_id: group.workflow_id, workflow_revision: group.workflow_revision, ticket_count: group.ticket_ids.size,
      nodes: group.nodes.map((node) => {
        const branchTotal = [...node.branches.values()].reduce((sum, branch) => sum + branch.count, 0);
        return {
          workflow_id: node.workflow_id, workflow_revision: node.workflow_revision, node_id: node.node_id, node_name: node.node_name,
          node_type: node.node_type, ticket_count: node.ticket_ids.size, runs: node.runs, completed: node.completed, running: node.running,
          interrupted: node.interrupted, bypassed: node.bypassed, lease_lost: node.lease_lost, delivery_failed: node.delivery_failed,
          classifications: { success: node.success, failure: node.failure, neutral: node.neutral, unclassified: node.unclassified },
          success_rate: node.success + node.failure ? node.success / (node.success + node.failure) : null,
          wall_ms: numberSummary(node.wall), active_ms: node.active_ms, quota_paused_ms: node.quota_paused_ms,
          human_wait_ms: node.human_wait_ms, external_wait_ms: node.external_wait_ms, total_tokens: node.tokens, known_cost_usd: node.cost,
          telemetry_coverage: { token_runs: node.token_runs, cost_runs: node.cost_runs, total_runs: node.runs },
          branches: [...node.branches.values()].map((branch) => ({ ...branch, rate: branchTotal ? branch.count / branchTotal : 0 })).sort((a, b) => b.count - a.count),
          quality: [...node.quality.values()].map((quality) => ({
            key: quality.key, label: quality.label, type: quality.type, unit: quality.unit, direction: quality.direction,
            ticket_count: quality.ticket_ids.size, reports: quality.reports, statuses: quality.statuses,
            pass_rate: quality.statuses.pass + quality.statuses.warn + quality.statuses.fail
              ? quality.statuses.pass / (quality.statuses.pass + quality.statuses.warn + quality.statuses.fail) : null,
            numeric: quality.type === "number" ? numberSummary(quality.numeric_values) : null,
            values: [...quality.values.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
          })).sort((a, b) => a.label.localeCompare(b.label)),
        };
      }).sort((a, b) => a.node_name.localeCompare(b.node_name)),
    })).sort((a, b) => a.workflow_id.localeCompare(b.workflow_id) || a.workflow_revision.localeCompare(b.workflow_revision)),
    profiles: [...profileMetrics.values()].map((profile) => ({
      alias: profile.alias, provider: profile.provider, model: profile.model, reasoning: profile.reasoning,
      runs: profile.runs, success: profile.success, failure: profile.failure,
      success_rate: profile.success + profile.failure ? profile.success / (profile.success + profile.failure) : null,
      total_tokens: profile.tokens, known_cost_usd: profile.cost, token_runs: profile.token_runs, cost_runs: profile.cost_runs,
      wall_ms: numberSummary(profile.wall),
    })).sort((a, b) => b.runs - a.runs),
  };
}

export interface WorkflowComparisonRef { workflow_id: string; workflow_revision: string }

function safeDelta(left: number | null, right: number | null): { absolute: number | null; percent: number | null } {
  if (left === null || right === null) return { absolute: null, percent: null };
  return { absolute: right - left, percent: left === 0 ? null : (right - left) / left };
}

function armSummary(all: TicketFrontmatter[], ref: WorkflowComparisonRef, filters: MetricsFilters) {
  const assigned = all.filter((ticket) => matches(ticket, { ...filters, workflow_id: ref.workflow_id, workflow_revision: ref.workflow_revision }));
  const completed = assigned.filter(completedTicket);
  const crossovers = completed.filter(crossedOver);
  const clean = completed.filter((ticket) => !crossedOver(ticket));
  const accounts = clean.map((ticket) => ({ ticket, value: accounting(ticket) }));
  const settled = assigned.filter((ticket) => ["completed", "failed", "cancelled"].includes(ticket.status));
  const production = clean.filter((ticket) => ["succeeded", "failed", "rolled_back"].includes(ticket.production_result));
  const succeeded = production.filter((ticket) => ticket.production_result === "succeeded").length;
  const completeCost = accounts.filter((item) => item.value.cost_complete);
  const completeTokens = accounts.filter((item) => item.value.tokens_complete);
  return {
    workflow_id: ref.workflow_id, workflow_revision: ref.workflow_revision,
    cohort: {
      assigned: assigned.length, completed: completed.length,
      failed: assigned.filter((ticket) => ticket.status === "failed").length,
      cancelled: assigned.filter((ticket) => ticket.status === "cancelled").length,
      blocked: assigned.filter((ticket) => ticket.status === "blocked").length,
      in_progress: assigned.filter((ticket) => !["completed", "failed", "cancelled"].includes(ticket.status)).length,
      crossover: crossovers.length, efficiency_eligible: clean.length,
    },
    completion_rate: settled.length ? completed.length / settled.length : null,
    production_success_rate: production.length ? succeeded / production.length : null,
    coverage: {
      cost_tickets: completeCost.length, token_tickets: completeTokens.length, eligible_tickets: clean.length,
    },
    totals: {
      known_cost_usd: completeCost.reduce((sum, item) => sum + item.value.cost, 0),
      known_tokens: completeTokens.reduce((sum, item) => sum + item.value.tokens, 0),
      active_ms: accounts.reduce((sum, item) => sum + item.value.active_ms, 0),
      human_wait_ms: accounts.reduce((sum, item) => sum + item.value.human_wait_ms, 0),
      quota_paused_ms: accounts.reduce((sum, item) => sum + item.value.quota_paused_ms, 0),
    },
    summaries: {
      ticket_duration_ms: numberSummary(clean.map((ticket) => Math.max(0, Date.parse(ticket.workflow!.completed_at!) - Date.parse(ticket.created_at)))),
      active_time_ms: numberSummary(accounts.map((item) => item.value.active_ms)),
      human_wait_ms: numberSummary(accounts.map((item) => item.value.human_wait_ms)),
      quota_pause_ms: numberSummary(accounts.map((item) => item.value.quota_paused_ms)),
      cost_per_ticket_usd: numberSummary(completeCost.map((item) => item.value.cost)),
      tokens_per_ticket: numberSummary(completeTokens.map((item) => item.value.tokens)),
      node_visits: numberSummary(clean.map((ticket) => ticket.workflow?.node_runs.length ?? 0)),
    },
  };
}

export async function buildWorkflowComparison(store: TicketStore, workflows: WorkflowLibrary, left: WorkflowComparisonRef, right: WorkflowComparisonRef, filters: MetricsFilters, metricsConfig: MetricsConfig = { human_day_rate_usd: 1_000 }) {
  const loaded = await store.list();
  const all = loaded.flatMap((item) => item.valid && item.frontmatter ? [item.frontmatter] : []);
  const leftArm = armSummary(all, left, filters); const rightArm = armSummary(all, right, filters);
  const [leftReport, rightReport] = await Promise.all([
    buildMetrics(store, workflows, { ...filters, workflow_id: left.workflow_id, workflow_revision: left.workflow_revision }, metricsConfig, { excludeCrossovers: true }),
    buildMetrics(store, workflows, { ...filters, workflow_id: right.workflow_id, workflow_revision: right.workflow_revision }, metricsConfig, { excludeCrossovers: true }),
  ]);
  return {
    generated_at: new Date().toISOString(), filters, left: { ...leftArm, nodes: leftReport.workflows.find((item) => item.workflow_id === left.workflow_id && item.workflow_revision === left.workflow_revision)?.nodes ?? [] },
    right: { ...rightArm, nodes: rightReport.workflows.find((item) => item.workflow_id === right.workflow_id && item.workflow_revision === right.workflow_revision)?.nodes ?? [] },
    deltas: {
      completion_rate: safeDelta(leftArm.completion_rate, rightArm.completion_rate),
      production_success_rate: safeDelta(leftArm.production_success_rate, rightArm.production_success_rate),
      median_cost_usd: safeDelta(leftArm.summaries.cost_per_ticket_usd.median, rightArm.summaries.cost_per_ticket_usd.median),
      median_tokens: safeDelta(leftArm.summaries.tokens_per_ticket.median, rightArm.summaries.tokens_per_ticket.median),
      median_duration_ms: safeDelta(leftArm.summaries.ticket_duration_ms.median, rightArm.summaries.ticket_duration_ms.median),
      median_active_ms: safeDelta(leftArm.summaries.active_time_ms.median, rightArm.summaries.active_time_ms.median),
    },
  };
}
