import type { HarnessTelemetrySnapshot } from "./domain.js";
import type { PricingConfig } from "./config-store.js";

function sameModel(observed: string, configured: string): boolean {
  return observed.toLowerCase() === configured.toLowerCase();
}

export function estimateTelemetryCost(snapshot: HarnessTelemetrySnapshot | undefined, pricing: PricingConfig): HarnessTelemetrySnapshot | undefined {
  if (!snapshot || snapshot.cost.total_usd !== null || !pricing.estimate_missing_costs || !snapshot.usage || !snapshot.model.id) return snapshot;
  const entry = pricing.models.find((candidate) => candidate.provider === snapshot.harness && sameModel(snapshot.model.id!, candidate.model));
  if (!entry) return snapshot;
  const usage = snapshot.usage;
  const total = (
    usage.input_tokens * entry.input_per_million_usd
    + usage.cached_input_tokens * entry.cached_input_per_million_usd
    + usage.cache_write_input_tokens * entry.cache_write_input_per_million_usd
    + usage.output_tokens * entry.output_per_million_usd
  ) / 1_000_000;
  return {
    ...snapshot,
    cost: {
      total_usd: Number(total.toFixed(12)), kind: "estimated", source: entry.source_url,
      pricing_id: entry.id, effective_at: entry.effective_at,
    },
  };
}
