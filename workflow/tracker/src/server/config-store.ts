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

export interface TrackerConfig extends Record<string, unknown> {
  version: number;
  revision: number;
  updated_at: string;
  tickets: TicketIdConfig;
  providers: ProviderConfig;
  agent_profiles: AgentProfilesConfig;
  repositories: RepositoryConfig[];
  jira: JiraConfig;
  github: GithubConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const profileValues = Array.isArray(rawAgentProfiles.profiles) ? rawAgentProfiles.profiles : [
    { id: "default", label: "Default", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" },
  ];
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
  const defaultProfile = typeof rawAgentProfiles.default === "string" ? rawAgentProfiles.default : "default";
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
  if (errors.length) throw new HttpError(422, "Tracker configuration is invalid", errors);
  return { ...raw, version, revision, updated_at: updatedAt, tickets, providers, agent_profiles, repositories, jira, github };
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
      agent_profiles: { default: "default", profiles: [{ id: "default", label: "Default", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" }] },
      jira: { enabled: false, site_url: "", project_key: "", issue_type: "Task" },
      github: { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] },
    };
    const handle = await open(this.path, "wx", 0o600);
    try { await handle.writeFile(serialize(config)); await handle.sync(); } finally { await handle.close(); }
    try { const directory = await open(dirname(this.path), "r"); await directory.sync(); await directory.close(); } catch { /* not supported everywhere */ }
    return config;
  }

  async update(settings: Pick<TrackerConfig, "providers" | "repositories" | "jira" | "github"> & { agent_profiles?: AgentProfilesConfig }, expectedRevision: number): Promise<TrackerConfig> {
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
    return this.update({ providers: current.providers, agent_profiles: current.agent_profiles, repositories, jira: current.jira, github: current.github }, expectedRevision);
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
