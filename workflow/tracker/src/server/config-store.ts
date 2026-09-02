import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { HttpError, PROVIDERS, type Provider } from "./domain.js";

export const TRACKER_CONFIG_FILENAME = "tracker-config.yaml";

export interface RepositoryConfig {
  id: string;
  url: string;
}

export interface TicketIdConfig { id_prefix: string; next_number: number }
export interface ProviderConfig { enabled: Provider[] }
export interface AgentProfileConfig { id: string; label: string; provider: Provider; model: string; reasoning: string }
export interface AgentProfilesConfig { default: string; profiles: AgentProfileConfig[] }
export interface JiraConfig { enabled: boolean; site_url: string; project_key: string; issue_type: string }
export interface GithubConfig { observation_enabled: boolean; observation_interval_minutes: number; ignored_logins: string[] }
export interface DemoConfig { enabled: boolean; step_duration_seconds: number }
export interface ModelPricingConfig {
  id: string;
  provider: Provider;
  model: string;
  input_per_million_usd: number;
  cached_input_per_million_usd: number;
  cache_write_input_per_million_usd: number;
  output_per_million_usd: number;
  source_url: string;
  effective_at: string;
}
export interface PricingConfig { estimate_missing_costs: boolean; models: ModelPricingConfig[] }
export interface MetricsConfig { human_day_rate_usd: number; quota_account_aliases?: Record<string, string> }
export interface QualityAttributeConfig {
  key: string;
  label: string;
  type: "number" | "boolean" | "string";
  unit: string;
  direction: "higher_is_better" | "lower_is_better" | "neutral";
  minimum: number | null;
  maximum: number | null;
}
export interface QualityConfig { attributes: QualityAttributeConfig[] }
export interface ArtifactPolicyConfig {
  max_total_bytes: number;
  max_ticket_bytes: number;
  orphan_grace_hours: number;
  retention_days: number;
  auto_gc_enabled: boolean;
  gc_interval_minutes: number;
}

export const DEFAULT_ARTIFACT_POLICY: ArtifactPolicyConfig = {
  max_total_bytes: 50 * 1024 * 1024 * 1024,
  max_ticket_bytes: 5 * 1024 * 1024 * 1024,
  orphan_grace_hours: 24,
  retention_days: 365,
  auto_gc_enabled: true,
  gc_interval_minutes: 60,
};

const PREVIOUS_DEFAULT_AGENT_PROFILES: AgentProfilesConfig = {
  default: "codex-default",
  profiles: [
    { id: "codex-default", label: "Codex default", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" },
    { id: "claude-default", label: "Claude default", provider: "claude", model: "claude-opus-4-6", reasoning: "high" },
    { id: "review", label: "Independent review", provider: "claude", model: "claude-opus-4-6", reasoning: "high" },
  ],
};

export const DEFAULT_AGENT_PROFILES: AgentProfilesConfig = {
  default: "claude",
  profiles: [
    { id: "claude", label: "Claude Opus", provider: "claude", model: "claude-opus-4-8", reasoning: "high" },
    { id: "codex", label: "Codex Sol", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" },
  ],
};

export const DEFAULT_PRICING: PricingConfig = {
  estimate_missing_costs: true,
  models: [
    {
      id: "openai-gpt-5-6-sol-standard-2026-08",
      provider: "codex", model: "gpt-5.6-sol",
      input_per_million_usd: 5, cached_input_per_million_usd: 0.5,
      cache_write_input_per_million_usd: 6.25, output_per_million_usd: 30,
      source_url: "https://platform.openai.com/pricing", effective_at: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "anthropic-claude-opus-4-8-global-2026-08",
      provider: "claude", model: "claude-opus-4-8",
      input_per_million_usd: 5, cached_input_per_million_usd: 0.5,
      cache_write_input_per_million_usd: 6.25, output_per_million_usd: 25,
      source_url: "https://platform.claude.com/docs/en/about-claude/pricing", effective_at: "2026-08-01T00:00:00.000Z",
    },
  ],
};

const PREVIOUS_DEFAULT_PRICING: PricingConfig = {
  ...DEFAULT_PRICING,
  models: DEFAULT_PRICING.models.map((entry) => entry.provider === "claude" ? {
    ...entry, id: "anthropic-claude-opus-4-6-global-2026-08", model: "claude-opus-4-6",
  } : entry),
};

export interface TrackerConfig extends Record<string, unknown> {
  version: number;
  revision: number;
  updated_at: string;
  tickets: TicketIdConfig;
  providers: ProviderConfig;
  agent_profiles: AgentProfilesConfig;
  pricing: PricingConfig;
  metrics: MetricsConfig;
  quality: QualityConfig;
  artifacts: ArtifactPolicyConfig;
  repositories: RepositoryConfig[];
  jira: JiraConfig;
  github: GithubConfig;
  demo: DemoConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesShippedValue(value: unknown, shipped: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(shipped);
}

function normalize(raw: unknown): TrackerConfig {
  if (!isRecord(raw)) throw new HttpError(422, "Tracker configuration must be a YAML object");
  const errors: string[] = [];
  const version = Number.isInteger(raw.version) && Number(raw.version) > 0 ? Number(raw.version) : (errors.push("version must be a positive integer"), 1);
  const revision = Number.isInteger(raw.revision) && Number(raw.revision) > 0 ? Number(raw.revision) : (errors.push("revision must be a positive integer"), 1);
  const updatedAt = typeof raw.updated_at === "string" && !Number.isNaN(Date.parse(raw.updated_at))
    ? raw.updated_at : (errors.push("updated_at must be an ISO timestamp"), new Date(0).toISOString());
  const repositories = Array.isArray(raw.repositories) ? raw.repositories.map((item, index) => {
    if (!isRecord(item)) { errors.push(`repositories[${index}] must be an object`); return { id: "", url: "" }; }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === "." || id === "..") errors.push(`repositories[${index}].id must be a safe directory name`);
    if (!url || /[\r\n\0]/.test(url)) errors.push(`repositories[${index}].url must be a non-empty single-line Git URL`);
    return { id, url };
  }) : (errors.push("repositories must be an array"), []);
  if (new Set(repositories.map((item) => item.id)).size !== repositories.length) errors.push("repository ids must be unique");
  if (new Set(repositories.map((item) => item.url)).size !== repositories.length) errors.push("repository urls must be unique");
  const rawTickets = isRecord(raw.tickets) ? raw.tickets : {};
  const tickets = {
    id_prefix: typeof rawTickets.id_prefix === "string" && /^[A-Z][A-Z0-9_-]*$/.test(rawTickets.id_prefix) ? rawTickets.id_prefix : "AGENT",
    next_number: Number.isInteger(rawTickets.next_number) && Number(rawTickets.next_number) > 0 ? Number(rawTickets.next_number) : 1,
  };
  const rawProviders = isRecord(raw.providers) ? raw.providers : {};
  const configuredProviders = rawProviders.enabled === undefined ? [...PROVIDERS] : rawProviders.enabled;
  const enabledProviders = Array.isArray(configuredProviders)
    ? configuredProviders.filter((item): item is Provider => typeof item === "string" && PROVIDERS.includes(item as Provider))
    : [];
  if (!Array.isArray(configuredProviders) || configuredProviders.length === 0) errors.push("providers.enabled must contain at least one provider");
  else if (enabledProviders.length !== configuredProviders.length) errors.push("providers.enabled may contain only claude or codex");
  else if (new Set(enabledProviders).size !== enabledProviders.length) errors.push("providers.enabled must not contain duplicates");
  const providers = { enabled: enabledProviders };
  const rawAgentProfiles = isRecord(raw.agent_profiles) ? raw.agent_profiles : {};
  const previousProfilesUnchanged = matchesShippedValue(rawAgentProfiles, PREVIOUS_DEFAULT_AGENT_PROFILES);
  const profileValues = previousProfilesUnchanged ? DEFAULT_AGENT_PROFILES.profiles : Array.isArray(rawAgentProfiles.profiles) ? rawAgentProfiles.profiles : DEFAULT_AGENT_PROFILES.profiles;
  const profiles: AgentProfileConfig[] = profileValues.map((item, index) => {
    const profile = isRecord(item) ? item : {};
    const id = typeof profile.id === "string" ? profile.id.trim() : "";
    const label = typeof profile.label === "string" ? profile.label.trim() : "";
    const provider = PROVIDERS.includes(profile.provider as Provider) ? profile.provider as Provider : "codex";
    const model = typeof profile.model === "string" ? profile.model.trim() : "";
    const reasoning = typeof profile.reasoning === "string" ? profile.reasoning.trim() : "";
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) errors.push(`agent_profiles.profiles[${index}].id must be a lowercase artifact id`);
    if (!label) errors.push(`agent_profiles.profiles[${index}].label is required`);
    if (!PROVIDERS.includes(profile.provider as Provider)) errors.push(`agent_profiles.profiles[${index}].provider must be claude or codex`);
    if (!model) errors.push(`agent_profiles.profiles[${index}].model is required`);
    if (!reasoning) errors.push(`agent_profiles.profiles[${index}].reasoning is required`);
    return { id, label, provider, model, reasoning };
  });
  if (!profiles.length) errors.push("agent_profiles.profiles must contain at least one profile");
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) errors.push("agent profile ids must be unique");
  if (profiles.some((profile) => !enabledProviders.includes(profile.provider))) errors.push("agent profiles may use only enabled providers");
  const defaultProfile = previousProfilesUnchanged ? DEFAULT_AGENT_PROFILES.default : typeof rawAgentProfiles.default === "string" ? rawAgentProfiles.default : DEFAULT_AGENT_PROFILES.default;
  if (!profiles.some((profile) => profile.id === defaultProfile)) errors.push("agent_profiles.default must reference a configured profile");
  const agent_profiles = { default: defaultProfile, profiles };
  const rawJira = isRecord(raw.jira) ? raw.jira : {};
  const jira = {
    enabled: rawJira.enabled === true,
    site_url: typeof rawJira.site_url === "string" ? rawJira.site_url.replace(/\/$/, "") : "",
    project_key: typeof rawJira.project_key === "string" ? rawJira.project_key.trim() : "",
    issue_type: typeof rawJira.issue_type === "string" && rawJira.issue_type.trim() ? rawJira.issue_type.trim() : "Task",
  };
  if (jira.enabled && !/^https:\/\/[A-Za-z0-9.-]+\.atlassian\.net$/.test(jira.site_url)) errors.push("jira.site_url must be an Atlassian Cloud site URL");
  if (jira.enabled && !jira.project_key) errors.push("jira.project_key is required when Jira is enabled");
  const rawGithub = isRecord(raw.github) ? raw.github : {};
  const github = {
    observation_enabled: rawGithub.observation_enabled === true,
    observation_interval_minutes: Number.isInteger(rawGithub.observation_interval_minutes) && Number(rawGithub.observation_interval_minutes) >= 1
      ? Number(rawGithub.observation_interval_minutes) : 30,
    ignored_logins: Array.isArray(rawGithub.ignored_logins) && rawGithub.ignored_logins.every((item) => typeof item === "string")
      ? [...new Set(rawGithub.ignored_logins.map((item) => item.trim()).filter(Boolean))] : [],
  };
  const rawDemo = isRecord(raw.demo) ? raw.demo : {};
  const demoDuration = rawDemo.step_duration_seconds === undefined ? 10 : rawDemo.step_duration_seconds;
  if (!Number.isInteger(demoDuration) || Number(demoDuration) < 1 || Number(demoDuration) > 300) {
    errors.push("demo.step_duration_seconds must be an integer between 1 and 300");
  }
  const demo: DemoConfig = {
    enabled: rawDemo.enabled === true,
    step_duration_seconds: Number.isInteger(demoDuration) && Number(demoDuration) >= 1 && Number(demoDuration) <= 300 ? Number(demoDuration) : 10,
  };
  const rawPricing = isRecord(raw.pricing) ? raw.pricing : {};
  const previousPricingUnchanged = matchesShippedValue(rawPricing, PREVIOUS_DEFAULT_PRICING);
  const pricingValues = previousPricingUnchanged ? DEFAULT_PRICING.models : Array.isArray(rawPricing.models) ? rawPricing.models : DEFAULT_PRICING.models;
  const pricingModels: ModelPricingConfig[] = pricingValues.map((item, index) => {
    const entry = isRecord(item) ? item : {};
    const numeric = (field: keyof Pick<ModelPricingConfig, "input_per_million_usd" | "cached_input_per_million_usd" | "cache_write_input_per_million_usd" | "output_per_million_usd">) => {
      const value = entry[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) { errors.push(`pricing.models[${index}].${field} must be a non-negative number`); return 0; }
      return value;
    };
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const provider = PROVIDERS.includes(entry.provider as Provider) ? entry.provider as Provider : "codex";
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    const source_url = typeof entry.source_url === "string" ? entry.source_url.trim() : "";
    const effective_at = typeof entry.effective_at === "string" && !Number.isNaN(Date.parse(entry.effective_at)) ? entry.effective_at : "";
    if (!/^[a-z][a-z0-9-]{0,127}$/.test(id)) errors.push(`pricing.models[${index}].id must be a lowercase artifact id`);
    if (!PROVIDERS.includes(entry.provider as Provider)) errors.push(`pricing.models[${index}].provider must be claude or codex`);
    if (!model) errors.push(`pricing.models[${index}].model is required`);
    if (!/^https:\/\//.test(source_url)) errors.push(`pricing.models[${index}].source_url must be an HTTPS URL`);
    if (!effective_at) errors.push(`pricing.models[${index}].effective_at must be an ISO timestamp`);
    return { id, provider, model, input_per_million_usd: numeric("input_per_million_usd"), cached_input_per_million_usd: numeric("cached_input_per_million_usd"), cache_write_input_per_million_usd: numeric("cache_write_input_per_million_usd"), output_per_million_usd: numeric("output_per_million_usd"), source_url, effective_at };
  });
  if (new Set(pricingModels.map((entry) => entry.id)).size !== pricingModels.length) errors.push("pricing model ids must be unique");
  const pricing: PricingConfig = { estimate_missing_costs: rawPricing.estimate_missing_costs !== false, models: pricingModels };
  const rawMetrics = isRecord(raw.metrics) ? raw.metrics : {};
  const humanDayRate = rawMetrics.human_day_rate_usd === undefined ? 1_000 : rawMetrics.human_day_rate_usd;
  if (typeof humanDayRate !== "number" || !Number.isFinite(humanDayRate) || humanDayRate < 0) errors.push("metrics.human_day_rate_usd must be a non-negative number");
  const rawQuotaAliases = rawMetrics.quota_account_aliases === undefined ? {} : rawMetrics.quota_account_aliases;
  if (!isRecord(rawQuotaAliases)) errors.push("metrics.quota_account_aliases must be an object");
  const quota_account_aliases = Object.fromEntries(Object.entries(isRecord(rawQuotaAliases) ? rawQuotaAliases : {}).flatMap(([supervisor, value]) => {
    const alias = typeof value === "string" ? value.trim() : "";
    if (!supervisor.trim() || supervisor.length > 200 || /[\r\n\0]/.test(supervisor)) errors.push("metrics.quota_account_aliases keys must be non-empty provider-scoped supervisor IDs of at most 200 characters");
    if (!alias || alias.length > 128 || /[\r\n\0]/.test(alias)) errors.push(`metrics.quota_account_aliases.${supervisor} must be a non-empty alias of at most 128 characters`);
    return supervisor.trim() && alias ? [[supervisor.trim(), alias]] : [];
  }));
  const metrics: MetricsConfig = {
    human_day_rate_usd: typeof humanDayRate === "number" && Number.isFinite(humanDayRate) && humanDayRate >= 0 ? humanDayRate : 1_000,
    quota_account_aliases,
  };
  const rawQuality = isRecord(raw.quality) ? raw.quality : {};
  if (raw.quality !== undefined && !isRecord(raw.quality)) errors.push("quality must be an object");
  if (rawQuality.attributes !== undefined && !Array.isArray(rawQuality.attributes)) errors.push("quality.attributes must be an array");
  const qualityAttributes: QualityAttributeConfig[] = (Array.isArray(rawQuality.attributes) ? rawQuality.attributes : []).map((item, index) => {
    const attribute = isRecord(item) ? item : {};
    const key = typeof attribute.key === "string" ? attribute.key.trim() : "";
    const label = typeof attribute.label === "string" ? attribute.label.trim() : "";
    const type = ["number", "boolean", "string"].includes(String(attribute.type)) ? attribute.type as QualityAttributeConfig["type"] : "number";
    const unit = typeof attribute.unit === "string" ? attribute.unit.trim() : "";
    const direction = ["higher_is_better", "lower_is_better", "neutral"].includes(String(attribute.direction))
      ? attribute.direction as QualityAttributeConfig["direction"] : "neutral";
    const bound = (field: "minimum" | "maximum") => attribute[field] === undefined || attribute[field] === null ? null
      : typeof attribute[field] === "number" && Number.isFinite(attribute[field]) ? Number(attribute[field])
        : (errors.push(`quality.attributes[${index}].${field} must be a finite number or null`), null);
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(key)) errors.push(`quality.attributes[${index}].key is invalid`);
    if (!label || label.length > 200) errors.push(`quality.attributes[${index}].label is required and must be at most 200 characters`);
    if (unit.length > 50) errors.push(`quality.attributes[${index}].unit must be at most 50 characters`);
    if (!["number", "boolean", "string"].includes(String(attribute.type))) errors.push(`quality.attributes[${index}].type is invalid`);
    if (!["higher_is_better", "lower_is_better", "neutral"].includes(String(attribute.direction))) errors.push(`quality.attributes[${index}].direction is invalid`);
    if (type !== "number" && direction !== "neutral") errors.push(`quality.attributes[${index}].direction must be neutral for non-numeric values`);
    const minimum = bound("minimum");
    const maximum = bound("maximum");
    if (type !== "number" && (minimum !== null || maximum !== null)) errors.push(`quality.attributes[${index}] may define bounds only for numeric values`);
    return { key, label, type, unit, direction, minimum, maximum };
  });
  if (qualityAttributes.length > 200) errors.push("quality.attributes may contain at most 200 definitions");
  if (new Set(qualityAttributes.map((attribute) => attribute.key)).size !== qualityAttributes.length) errors.push("quality attribute keys must be unique");
  for (const attribute of qualityAttributes) if (attribute.minimum !== null && attribute.maximum !== null && attribute.minimum > attribute.maximum) errors.push(`quality attribute ${attribute.key} minimum cannot exceed maximum`);
  const quality: QualityConfig = { attributes: qualityAttributes };
  const rawArtifacts = isRecord(raw.artifacts) ? raw.artifacts : {};
  const positiveInteger = (key: keyof ArtifactPolicyConfig, fallback: number, minimum = 1) => {
    const value = rawArtifacts[key];
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || Number(value) < minimum) { errors.push(`artifacts.${key} must be an integer of at least ${minimum}`); return fallback; }
    return Number(value);
  };
  const artifacts: ArtifactPolicyConfig = {
    max_total_bytes: positiveInteger("max_total_bytes", DEFAULT_ARTIFACT_POLICY.max_total_bytes, 1_048_576),
    max_ticket_bytes: positiveInteger("max_ticket_bytes", DEFAULT_ARTIFACT_POLICY.max_ticket_bytes, 1_048_576),
    orphan_grace_hours: positiveInteger("orphan_grace_hours", DEFAULT_ARTIFACT_POLICY.orphan_grace_hours),
    retention_days: positiveInteger("retention_days", DEFAULT_ARTIFACT_POLICY.retention_days),
    auto_gc_enabled: rawArtifacts.auto_gc_enabled === undefined ? DEFAULT_ARTIFACT_POLICY.auto_gc_enabled
      : typeof rawArtifacts.auto_gc_enabled === "boolean" ? rawArtifacts.auto_gc_enabled
        : (errors.push("artifacts.auto_gc_enabled must be a boolean"), DEFAULT_ARTIFACT_POLICY.auto_gc_enabled),
    gc_interval_minutes: positiveInteger("gc_interval_minutes", DEFAULT_ARTIFACT_POLICY.gc_interval_minutes),
  };
  if (artifacts.max_ticket_bytes > artifacts.max_total_bytes) errors.push("artifacts.max_ticket_bytes cannot exceed max_total_bytes");
  if (errors.length) throw new HttpError(422, "Tracker configuration is invalid", errors);
  return { ...raw, version, revision, updated_at: updatedAt, tickets, providers, agent_profiles, pricing, metrics, quality, artifacts, repositories, jira, github, demo };
}

function serialize(config: TrackerConfig): string {
  return stringify(config, { lineWidth: 0, nullStr: "null" });
}

export class TrackerConfigStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, private readonly now = () => new Date()) {
    this.path = join(resolve(root), TRACKER_CONFIG_FILENAME);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async start(): Promise<TrackerConfig> {
    return this.read();
  }

  async read(): Promise<TrackerConfig> {
    return this.serial(() => this.readInternal());
  }

  private async readInternal(): Promise<TrackerConfig> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      return normalize(parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, "Tracker configuration YAML is invalid", [(error as Error).message]);
      }
    }
    const config: TrackerConfig = {
      version: 1, revision: 1, updated_at: this.now().toISOString(), tickets: { id_prefix: "AGENT", next_number: 1 },
      providers: { enabled: [...PROVIDERS] }, repositories: [],
      agent_profiles: structuredClone(DEFAULT_AGENT_PROFILES),
      pricing: structuredClone(DEFAULT_PRICING), metrics: { human_day_rate_usd: 1_000, quota_account_aliases: {} }, quality: { attributes: [] }, artifacts: structuredClone(DEFAULT_ARTIFACT_POLICY),
      jira: { enabled: false, site_url: "", project_key: "", issue_type: "Task" },
      github: { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] },
      demo: { enabled: false, step_duration_seconds: 10 },
    };
    const handle = await open(this.path, "wx", 0o600);
    try { await handle.writeFile(serialize(config)); await handle.sync(); } finally { await handle.close(); }
    try { const directory = await open(dirname(this.path), "r"); await directory.sync(); await directory.close(); } catch { /* not supported everywhere */ }
    return config;
  }

  async update(settings: Pick<TrackerConfig, "providers" | "repositories" | "jira" | "github"> & { agent_profiles?: AgentProfilesConfig; pricing?: PricingConfig; metrics?: MetricsConfig; quality?: QualityConfig; artifacts?: ArtifactPolicyConfig; demo?: DemoConfig }, expectedRevision: number): Promise<TrackerConfig> {
    return this.serial(async () => {
      const currentBytes = await readFile(this.path, "utf8").catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        await this.readInternal();
        return readFile(this.path, "utf8");
      });
      const current = normalize(parse(currentBytes));
      if (current.revision !== expectedRevision) throw new HttpError(409, "Tracker configuration revision changed", current);
      const next = normalize({ ...current, ...settings, tickets: current.tickets, revision: current.revision + 1, updated_at: this.now().toISOString() });
      await this.replace(currentBytes, next);
      return next;
    });
  }

  async updateRepositories(repositories: RepositoryConfig[], expectedRevision: number): Promise<TrackerConfig> {
    const current = await this.read();
    return this.update({ providers: current.providers, agent_profiles: current.agent_profiles, pricing: current.pricing, metrics: current.metrics, quality: current.quality, artifacts: current.artifacts, repositories, jira: current.jira, github: current.github, demo: current.demo }, expectedRevision);
  }

  async previewTicketId(existingIds: Iterable<string> = []): Promise<string> {
    const config = await this.read();
    const existing = new Set(existingIds);
    let number = config.tickets.next_number;
    while (existing.has(`${config.tickets.id_prefix}-${String(number).padStart(4, "0")}`)) number += 1;
    return `${config.tickets.id_prefix}-${String(number).padStart(4, "0")}`;
  }

  async allocateTicketId(existingIds: Iterable<string> = []): Promise<string> {
    return this.serial(async () => {
      const currentBytes = await readFile(this.path, "utf8").catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        await this.readInternal();
        return readFile(this.path, "utf8");
      });
      const current = normalize(parse(currentBytes));
      const existing = new Set(existingIds);
      let number = current.tickets.next_number;
      while (existing.has(`${current.tickets.id_prefix}-${String(number).padStart(4, "0")}`)) number += 1;
      const id = `${current.tickets.id_prefix}-${String(number).padStart(4, "0")}`;
      const next = normalize({
        ...current, tickets: { ...current.tickets, next_number: number + 1 },
        revision: current.revision + 1, updated_at: this.now().toISOString(),
      });
      await this.replace(currentBytes, next);
      return id;
    });
  }

  private async replace(currentBytes: string, next: TrackerConfig): Promise<void> {
    const temporary = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(serialize(next)); await handle.sync(); } finally { await handle.close(); }
    try {
      if (await readFile(this.path, "utf8") !== currentBytes) throw new HttpError(409, "Tracker configuration changed during update");
      await rename(temporary, this.path);
      try { const directory = await open(dirname(this.path), "r"); await directory.sync(); await directory.close(); } catch { /* not supported everywhere */ }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
