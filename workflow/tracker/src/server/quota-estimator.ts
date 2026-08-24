import type { MetricsConfig } from "./config-store.js";
import type { Provider, TicketFrontmatter, WorkflowNodeRun } from "./domain.js";

const WEEK_MINUTES = 7 * 24 * 60;
const WEEK_TOLERANCE_MINUTES = 60;
const OBSERVATION_RETENTION_MS = 12 * 7 * 24 * 60 * 60 * 1_000;
const SUBSCRIPTION_PROVIDERS = ["claude", "codex"] as const;
type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[number];

export interface QuotaSupervisor {
  supervisor_id: string;
  providers: Provider[];
}

export interface QuotaEstimate {
  account_id: string;
  supervisor_ids: string[];
  provider: SubscriptionProvider;
  limit_id: string | null;
  status: "estimated" | "insufficient_data" | "not_reported";
  used_percent: number | null;
  window_minutes: number | null;
  resets_at: string | null;
  observed_at: string | null;
  plan_types: string[];
  estimated_weekly_tokens: number | null;
  estimated_weekly_api_usd: number | null;
  token_samples: number;
  cost_samples: number;
  direct_samples: number;
  percentage_points_observed: number;
  confidence: "low" | "medium" | "high" | null;
}

export interface QuotaReport {
  generated_at: string;
  accounts: QuotaEstimate[];
}

interface Observation {
  provider: SubscriptionProvider;
  account_id: string;
  supervisor_id: string;
  run: WorkflowNodeRun;
  limit: NonNullable<WorkflowNodeRun["telemetry"]>["latest"]["rate_limits"][number];
  observed_at: string;
  plan_type: string | null;
}

function weekly(limit: Observation["limit"]): boolean {
  return limit.window_minutes !== null && Math.abs(limit.window_minutes - WEEK_MINUTES) <= WEEK_TOLERANCE_MINUTES;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sameWindow(left: Observation["limit"], right: Observation["limit"]): boolean {
  return left.id === right.id && left.resets_at !== null && left.resets_at === right.resets_at;
}

function baselinePercent(observation: Observation): number | null {
  const baseline = observation.run.telemetry?.baseline.rate_limits.find((candidate) => sameWindow(candidate, observation.limit));
  return baseline?.used_percent ?? null;
}

function confidence(samples: number, directSamples: number, percentagePoints: number): QuotaEstimate["confidence"] {
  if (samples === 0) return null;
  if (samples >= 5 && directSamples >= 3 && percentagePoints >= 5) return "high";
  if (samples >= 2 && percentagePoints >= 2) return "medium";
  return "low";
}

export function buildQuotaReport(
  tickets: TicketFrontmatter[],
  supervisors: QuotaSupervisor[],
  metrics: MetricsConfig,
  now: Date = new Date(),
): QuotaReport {
  const aliases = metrics.quota_account_aliases ?? {};
  const accountFor = (provider: SubscriptionProvider, supervisorId: string) => aliases[`${provider}:${supervisorId}`]?.trim()
    || (provider === "codex" ? aliases[supervisorId]?.trim() : "")
    || supervisorId;
  const accountSupervisors = new Map<string, Set<string>>();
  const accountKey = (provider: SubscriptionProvider, account: string) => `${provider}\u0000${account}`;
  const ensureAccount = (provider: SubscriptionProvider, supervisorId: string) => {
    const account = accountFor(provider, supervisorId);
    const key = accountKey(provider, account);
    const ids = accountSupervisors.get(key) ?? new Set<string>();
    ids.add(supervisorId);
    accountSupervisors.set(key, ids);
    return account;
  };

  for (const supervisor of supervisors) for (const provider of SUBSCRIPTION_PROVIDERS) {
    if (supervisor.providers.includes(provider)) ensureAccount(provider, supervisor.supervisor_id);
  }

  const observations: Observation[] = [];
  const oldestObservation = now.getTime() - OBSERVATION_RETENTION_MS;
  for (const ticket of tickets) for (const run of ticket.workflow?.node_runs ?? []) {
    if (run.node_type !== "agent" || !SUBSCRIPTION_PROVIDERS.includes(run.provider as SubscriptionProvider)
      || !run.supervisor_id || !run.telemetry) continue;
    const provider = run.provider as SubscriptionProvider;
    const account_id = ensureAccount(provider, run.supervisor_id);
    const plan = run.telemetry.latest.attributes.plan_type;
    const plan_type = typeof plan === "string" && plan.trim() ? plan : null;
    for (const limit of run.telemetry.latest.rate_limits.filter(weekly)) if (Date.parse(run.telemetry.latest.observed_at) >= oldestObservation) observations.push({
      provider, account_id, supervisor_id: run.supervisor_id, run, limit,
      observed_at: run.telemetry.latest.observed_at, plan_type,
    });
  }

  const grouped = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = `${observation.provider}\u0000${observation.account_id}\u0000${observation.limit.id}`;
    const list = grouped.get(key) ?? [];
    list.push(observation);
    grouped.set(key, list);
  }

  const accounts: QuotaEstimate[] = [];
  const accountsWithLimits = new Set<string>();
  for (const list of grouped.values()) {
    list.sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at));
    const current = list.at(-1)!;
    const currentAccountKey = accountKey(current.provider, current.account_id);
    accountsWithLimits.add(currentAccountKey);
    const tokenCapacities: number[] = [];
    const costCapacities: number[] = [];
    let directSamples = 0;
    let percentagePoints = 0;
    const previousByWindow = new Map<string, number>();
    for (const observation of list) {
      const direct = baselinePercent(observation);
      const windowKey = observation.limit.resets_at ?? "";
      const previous = previousByWindow.get(windowKey) ?? null;
      const start = direct ?? previous;
      previousByWindow.set(windowKey, observation.limit.used_percent);
      if (start === null) continue;
      const deltaPercent = observation.limit.used_percent - start;
      const usage = observation.run.telemetry?.delta.usage;
      if (!usage || deltaPercent <= 0 || deltaPercent > 100) continue;
      tokenCapacities.push(usage.total_tokens * 100 / deltaPercent);
      const cost = observation.run.telemetry?.delta.cost_usd;
      if (cost !== null && cost !== undefined) costCapacities.push(cost * 100 / deltaPercent);
      percentagePoints += deltaPercent;
      if (direct !== null) directSamples += 1;
    }
    const tokenEstimate = median(tokenCapacities);
    const costEstimate = median(costCapacities);
    accounts.push({
      account_id: current.account_id,
      supervisor_ids: [...(accountSupervisors.get(currentAccountKey) ?? [])].sort(),
      provider: current.provider,
      limit_id: current.limit.id,
      status: tokenEstimate === null ? "insufficient_data" : "estimated",
      used_percent: current.limit.used_percent,
      window_minutes: current.limit.window_minutes,
      resets_at: current.limit.resets_at,
      observed_at: current.observed_at,
      plan_types: [...new Set(list.flatMap((item) => item.plan_type ? [item.plan_type] : []))].sort(),
      estimated_weekly_tokens: tokenEstimate === null ? null : Math.round(tokenEstimate),
      estimated_weekly_api_usd: costEstimate === null ? null : Number(costEstimate.toFixed(2)),
      token_samples: tokenCapacities.length,
      cost_samples: costCapacities.length,
      direct_samples: directSamples,
      percentage_points_observed: Number(percentagePoints.toFixed(4)),
      confidence: confidence(tokenCapacities.length, directSamples, percentagePoints),
    });
  }

  for (const [key, supervisorIds] of accountSupervisors) if (!accountsWithLimits.has(key)) {
    const separator = key.indexOf("\u0000");
    const provider = key.slice(0, separator) as SubscriptionProvider;
    const account_id = key.slice(separator + 1);
    accounts.push({
      account_id,
      supervisor_ids: [...supervisorIds].sort(),
      provider,
      limit_id: null,
      status: "not_reported",
      used_percent: null,
      window_minutes: null,
      resets_at: null,
      observed_at: null,
      plan_types: [],
      estimated_weekly_tokens: null,
      estimated_weekly_api_usd: null,
      token_samples: 0,
      cost_samples: 0,
      direct_samples: 0,
      percentage_points_observed: 0,
      confidence: null,
    });
  }

  return { generated_at: now.toISOString(), accounts: accounts.sort((left, right) => left.provider.localeCompare(right.provider)
    || left.account_id.localeCompare(right.account_id) || String(left.limit_id).localeCompare(String(right.limit_id))) };
}
