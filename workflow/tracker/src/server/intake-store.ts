import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { HttpError, type ActivityCapability, type JsonValue, type TicketFrontmatter } from "./domain.js";
import type { TicketStore } from "./ticket-store.js";

export interface IntakeLimits {
  max_new_per_run: number;
  max_new_per_day: number;
  max_open: number;
  max_working: number;
  max_observed_unarchived: number;
}

export interface CampaignDefinition {
  version: 1;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  limits: IntakeLimits;
  success_policy: Record<string, JsonValue>;
}

export interface SourceTicketTemplate {
  workflow_id: string;
  workflow_revision?: string;
  repositories: Array<{ id: string; primary: boolean }>;
  labels: string[];
  priority: number;
  mark_ready: boolean;
  workflow_inputs: Record<string, boolean | string>;
  stage_enabled: Record<string, boolean>;
}

export interface IntakeSourceDefinition {
  version: 1;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  campaign_id: string;
  schedule: { interval_minutes: number };
  runner:
    | { type: "supervisor_script"; language: "shell" | "python" | "javascript"; script_path: string; working_directory: string; timeout_seconds: number }
    | { type: "external" };
  ticket: SourceTicketTemplate;
  limits: IntakeLimits;
}

export interface IntakeDocument<T> {
  definition: T;
  content: string;
  revision: string;
  valid: boolean;
  errors: string[];
}

export interface IntakeCandidateInput {
  external_key: string;
  title: string;
  description: string;
  repositories?: Array<{ id: string; primary: boolean }>;
  labels?: string[];
  priority?: number;
  workflow_id?: string;
  workflow_revision?: string;
  workflow_inputs?: Record<string, boolean | string>;
  stage_enabled?: Record<string, boolean>;
  mark_ready?: boolean;
  metadata?: Record<string, JsonValue>;
}

export type CandidateDecision = "admitted" | "duplicate" | "deferred" | "rejected";

export interface IntakeCandidateRecord {
  version: 1;
  id: string;
  source_id: string;
  source_revision: string;
  campaign_id: string;
  source_run_id: string;
  external_key: string;
  candidate: IntakeCandidateInput;
  decision: CandidateDecision;
  reason: string | null;
  ticket_id: string | null;
  parent_ticket_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
  admitted_at: string | null;
}

export interface IntakeRun {
  version: 1;
  id: string;
  mode: "admit" | "preview";
  source_id: string;
  source_revision: string;
  campaign_id: string;
  campaign_revision: string;
  status: "ready" | "running" | "completed" | "failed";
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  attempt: number;
  supervisor_id: string | null;
  lease_id: string | null;
  last_heartbeat_at: string | null;
  lease_expires_at: string | null;
  runner: IntakeSourceDefinition["runner"];
  cursor_before: JsonValue | null;
  cursor_after: JsonValue | null;
  candidates_received: number;
  decisions: Record<CandidateDecision, number>;
  error: string | null;
  output_path: string | null;
  output_bytes: number;
  output_sha256: string | null;
  preview_candidates: Array<{ external_key: string; title: string; valid: boolean; errors: string[] }>;
}

export interface ClaimedIntakeRun extends IntakeRun {
  lease_id: string;
  supervisor_id: string;
  last_heartbeat_at: string;
  lease_expires_at: string;
  source: IntakeSourceDefinition;
}

export interface IntakeSubmissionResult {
  run: IntakeRun;
  candidates: IntakeCandidateRecord[];
}

export type IntakeTicketAdmitter = (context: {
  source: IntakeDocument<IntakeSourceDefinition>;
  campaign: IntakeDocument<CampaignDefinition>;
  run: IntakeRun;
  candidate: IntakeCandidateInput;
  parent_ticket_id: string | null;
}) => Promise<string>;

const SOURCE_DEFAULT_LIMITS: IntakeLimits = {
  max_new_per_run: 3,
  max_new_per_day: 20,
  max_open: 20,
  max_working: 5,
  max_observed_unarchived: 30,
};

const CAMPAIGN_DEFAULT_LIMITS: IntakeLimits = {
  max_new_per_run: 100,
  max_new_per_day: 100,
  max_open: 50,
  max_working: 10,
  max_observed_unarchived: 100,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactId(value: unknown, field: string, errors: string[]): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) errors.push(`${field} must be a lowercase artifact id`);
  return id;
}

function text(value: unknown, field: string, errors: string[], maximum = 1_000): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) errors.push(`${field} is required`);
  if (result.length > maximum) errors.push(`${field} must be at most ${maximum} characters`);
  return result;
}

function positiveInteger(value: unknown, field: string, fallback: number, errors: string[], maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    errors.push(`${field} must be an integer between 1 and ${maximum}`);
    return fallback;
  }
  return Number(value);
}

function jsonValue(value: unknown, field: string, errors: string[], depth = 0): JsonValue | undefined {
  if (depth > 12) { errors.push(`${field} exceeds maximum nesting depth`); return undefined; }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const items = value.map((item, index) => jsonValue(item, `${field}[${index}]`, errors, depth + 1));
    return items.some((item) => item === undefined) ? undefined : items as JsonValue[];
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, item]) => [key, jsonValue(item, `${field}.${key}`, errors, depth + 1)] as const);
    return entries.some((entry) => entry[1] === undefined) ? undefined : Object.fromEntries(entries) as Record<string, JsonValue>;
  }
  errors.push(`${field} must be JSON-compatible`);
  return undefined;
}

function limits(value: unknown, defaults: IntakeLimits, field: string, errors: string[]): IntakeLimits {
  const raw = isRecord(value) ? value : {};
  if (value !== undefined && !isRecord(value)) errors.push(`${field} must be an object`);
  return {
    max_new_per_run: positiveInteger(raw.max_new_per_run, `${field}.max_new_per_run`, defaults.max_new_per_run, errors, 10_000),
    max_new_per_day: positiveInteger(raw.max_new_per_day, `${field}.max_new_per_day`, defaults.max_new_per_day, errors, 1_000_000),
    max_open: positiveInteger(raw.max_open, `${field}.max_open`, defaults.max_open, errors, 1_000_000),
    max_working: positiveInteger(raw.max_working, `${field}.max_working`, defaults.max_working, errors, 1_000_000),
    max_observed_unarchived: positiveInteger(raw.max_observed_unarchived, `${field}.max_observed_unarchived`, defaults.max_observed_unarchived, errors, 1_000_000),
  };
}

function repositories(value: unknown, field: string, errors: string[]): Array<{ id: string; primary: boolean }> {
  if (!Array.isArray(value) || !value.length) { errors.push(`${field} must contain at least one repository`); return []; }
  const result = value.map((item, index) => {
    if (!isRecord(item)) { errors.push(`${field}[${index}] must be an object`); return { id: "", primary: false }; }
    return { id: text(item.id, `${field}[${index}].id`, errors, 200), primary: item.primary === true };
  });
  if (result.filter((item) => item.primary).length !== 1) errors.push(`${field} must contain exactly one primary repository`);
  if (new Set(result.map((item) => item.id)).size !== result.length) errors.push(`${field} repository ids must be unique`);
  return result;
}

function normalizeCampaign(raw: unknown): { definition: CampaignDefinition; errors: string[] } {
  const errors: string[] = [];
  const value = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) errors.push("Campaign must be a YAML object");
  const policy = value.success_policy === undefined ? {} : jsonValue(value.success_policy, "success_policy", errors);
  return {
    definition: {
      version: 1,
      id: artifactId(value.id, "id", errors),
      name: text(value.name, "name", errors, 200),
      description: typeof value.description === "string" ? value.description.trim() : "",
      enabled: value.enabled !== false,
      limits: limits(value.limits, CAMPAIGN_DEFAULT_LIMITS, "limits", errors),
      success_policy: isRecord(policy) ? policy : {},
    },
    errors,
  };
}

function boolStringRecord(value: unknown, field: string, errors: string[]): Record<string, boolean | string> {
  if (value === undefined) return {};
  if (!isRecord(value)) { errors.push(`${field} must be an object`); return {}; }
  const result: Record<string, boolean | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" && typeof item !== "boolean") errors.push(`${field}.${key} must be a string or boolean`);
    else result[key] = item;
  }
  return result;
}

function boolRecord(value: unknown, field: string, errors: string[]): Record<string, boolean> {
  const result = boolStringRecord(value, field, errors);
  for (const [key, item] of Object.entries(result)) if (typeof item !== "boolean") errors.push(`${field}.${key} must be a boolean`);
  return Object.fromEntries(Object.entries(result).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}

function normalizeSource(raw: unknown): { definition: IntakeSourceDefinition; errors: string[] } {
  const errors: string[] = [];
  const value = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) errors.push("Source must be a YAML object");
  const rawRunner = isRecord(value.runner) ? value.runner : {};
  if (!isRecord(value.runner)) errors.push("runner must be an object");
  const type = rawRunner.type === "external" ? "external" : "supervisor_script";
  if (rawRunner.type !== "external" && rawRunner.type !== "supervisor_script") errors.push("runner.type must be supervisor_script or external");
  let runner: IntakeSourceDefinition["runner"];
  if (type === "external") runner = { type };
  else {
    const language = ["shell", "python", "javascript"].includes(String(rawRunner.language))
      ? rawRunner.language as "shell" | "python" | "javascript" : "shell";
    if (!["shell", "python", "javascript"].includes(String(rawRunner.language))) errors.push("runner.language must be shell, python, or javascript");
    const scriptPath = text(rawRunner.script_path, "runner.script_path", errors, 1_000);
    const workingDirectory = typeof rawRunner.working_directory === "string" && rawRunner.working_directory.trim() ? rawRunner.working_directory.trim() : ".";
    if (scriptPath.startsWith("/") || scriptPath.split("/").includes("..")) errors.push("runner.script_path must be relative to the supervisor project root");
    if (workingDirectory.startsWith("/") || workingDirectory.split("/").includes("..")) errors.push("runner.working_directory must be relative to the supervisor project root");
    runner = { type, language, script_path: scriptPath, working_directory: workingDirectory, timeout_seconds: positiveInteger(rawRunner.timeout_seconds, "runner.timeout_seconds", 300, errors, 86_400) };
  }
  const rawTicket = isRecord(value.ticket) ? value.ticket : {};
  if (!isRecord(value.ticket)) errors.push("ticket must be an object");
  const labelValues = rawTicket.labels === undefined ? [] : Array.isArray(rawTicket.labels) && rawTicket.labels.every((item) => typeof item === "string")
    ? [...new Set(rawTicket.labels.map((item) => String(item).trim()).filter(Boolean))] : (errors.push("ticket.labels must be an array of strings"), []);
  const priority = rawTicket.priority === undefined ? 0 : Number.isInteger(rawTicket.priority) ? Number(rawTicket.priority) : (errors.push("ticket.priority must be an integer"), 0);
  return {
    definition: {
      version: 1,
      id: artifactId(value.id, "id", errors),
      name: text(value.name, "name", errors, 200),
      description: typeof value.description === "string" ? value.description.trim() : "",
      enabled: value.enabled !== false,
      campaign_id: artifactId(value.campaign_id, "campaign_id", errors),
      schedule: { interval_minutes: positiveInteger(isRecord(value.schedule) ? value.schedule.interval_minutes : undefined, "schedule.interval_minutes", 30, errors, 525_600) },
      runner,
      ticket: {
        workflow_id: artifactId(rawTicket.workflow_id, "ticket.workflow_id", errors),
        ...(typeof rawTicket.workflow_revision === "string" && rawTicket.workflow_revision.trim() ? { workflow_revision: rawTicket.workflow_revision.trim() } : {}),
        repositories: repositories(rawTicket.repositories, "ticket.repositories", errors),
        labels: labelValues,
        priority,
        mark_ready: rawTicket.mark_ready === true,
        workflow_inputs: boolStringRecord(rawTicket.workflow_inputs, "ticket.workflow_inputs", errors),
        stage_enabled: boolRecord(rawTicket.stage_enabled, "ticket.stage_enabled", errors),
      },
      limits: limits(value.limits, SOURCE_DEFAULT_LIMITS, "limits", errors),
    },
    errors,
  };
}

function normalizedContent(value: CampaignDefinition | IntakeSourceDefinition): string {
  return stringify(value, { lineWidth: 0, nullStr: "null" });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    try { const directory = await open(dirname(path), "r"); await directory.sync(); await directory.close(); } catch { /* unsupported */ }
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function jsonFiles(directory: string): Promise<string[]> {
  try { return (await readdir(directory, { withFileTypes: true })).filter((item) => item.isFile() && item.name.endsWith(".json")).map((item) => join(directory, item.name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function candidateInput(value: unknown): { candidate: IntakeCandidateInput; errors: string[] } {
  const errors: string[] = [];
  const raw = isRecord(value) ? value : {};
  if (!isRecord(value)) errors.push("candidate must be an object");
  const candidateRepositories = raw.repositories === undefined ? undefined : repositories(raw.repositories, "repositories", errors);
  const labels = raw.labels === undefined ? undefined : Array.isArray(raw.labels) && raw.labels.every((item) => typeof item === "string")
    ? [...new Set(raw.labels.map((item) => String(item).trim()).filter(Boolean))] : (errors.push("labels must be an array of strings"), undefined);
  const metadataValue = raw.metadata === undefined ? undefined : jsonValue(raw.metadata, "metadata", errors);
  const result: IntakeCandidateInput = {
    external_key: text(raw.external_key, "external_key", errors, 512),
    title: text(raw.title, "title", errors, 500),
    description: text(raw.description, "description", errors, 200_000),
    ...(candidateRepositories ? { repositories: candidateRepositories } : {}),
    ...(labels ? { labels } : {}),
    ...(raw.priority === undefined ? {} : Number.isInteger(raw.priority) ? { priority: Number(raw.priority) } : (errors.push("priority must be an integer"), {})),
    ...(typeof raw.workflow_id === "string" && raw.workflow_id.trim() ? { workflow_id: raw.workflow_id.trim() } : {}),
    ...(typeof raw.workflow_revision === "string" && raw.workflow_revision.trim() ? { workflow_revision: raw.workflow_revision.trim() } : {}),
    ...(raw.workflow_inputs === undefined ? {} : { workflow_inputs: boolStringRecord(raw.workflow_inputs, "workflow_inputs", errors) }),
    ...(raw.stage_enabled === undefined ? {} : { stage_enabled: boolRecord(raw.stage_enabled, "stage_enabled", errors) }),
    ...(typeof raw.mark_ready === "boolean" ? { mark_ready: raw.mark_ready } : {}),
    ...(isRecord(metadataValue) ? { metadata: metadataValue } : {}),
  };
  if (result.metadata && Object.keys(result.metadata).some((key) => key.startsWith("intake."))) errors.push("candidate metadata may not use reserved intake.* keys");
  return { candidate: result, errors };
}

function ticketOrigin(ticket: TicketFrontmatter) {
  const metadata = ticket.metadata ?? {};
  return {
    source_id: typeof metadata["intake.source_id"] === "string" ? metadata["intake.source_id"] : null,
    campaign_id: typeof metadata["intake.campaign_id"] === "string" ? metadata["intake.campaign_id"] : null,
    external_key: typeof metadata["intake.external_key"] === "string" ? metadata["intake.external_key"] : null,
  };
}

function working(ticket: TicketFrontmatter): boolean {
  return !["pending", "completed", "cancelled"].includes(ticket.status);
}

function openTicket(ticket: TicketFrontmatter): boolean {
  return !["completed", "cancelled"].includes(ticket.status);
}

function emptyDecisions(): Record<CandidateDecision, number> {
  return { admitted: 0, duplicate: 0, deferred: 0, rejected: 0 };
}

export class IntakeStore {
  readonly root: string;
  readonly sourcesDirectory: string;
  readonly campaignsDirectory: string;
  readonly ledgerDirectory: string;
  private readonly runsDirectory: string;
  private readonly candidatesDirectory: string;
  private readonly stateDirectory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private started: Promise<void> | null = null;
  private admitter: IntakeTicketAdmitter | null = null;

  constructor(root: string, private readonly tickets: TicketStore, private readonly now = () => new Date(), private readonly leaseTtlMs = 120_000) {
    this.root = resolve(root);
    this.sourcesDirectory = join(this.root, "sources");
    this.campaignsDirectory = join(this.root, "campaigns");
    this.ledgerDirectory = join(this.root, ".intake");
    this.runsDirectory = join(this.ledgerDirectory, "runs");
    this.candidatesDirectory = join(this.ledgerDirectory, "candidates");
    this.stateDirectory = join(this.ledgerDirectory, "state");
  }

  setAdmitter(admitter: IntakeTicketAdmitter): void { this.admitter = admitter; }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = (async () => {
      await Promise.all([this.sourcesDirectory, this.campaignsDirectory, this.runsDirectory, this.candidatesDirectory, this.stateDirectory].map((path) => mkdir(path, { recursive: true })));
    })();
    return this.started;
  }

  private async ensureStarted(): Promise<void> { await this.start(); }

  private document<T>(content: string, normalize: (raw: unknown) => { definition: T; errors: string[] }): IntakeDocument<T> {
    try {
      const result = normalize(parse(content));
      const canonical = normalizedContent(result.definition as CampaignDefinition | IntakeSourceDefinition);
      return { definition: result.definition, content: canonical, revision: digest(canonical), valid: result.errors.length === 0, errors: result.errors };
    } catch (error) {
      const result = normalize({});
      return { definition: result.definition, content, revision: digest(content), valid: false, errors: [(error as Error).message] };
    }
  }

  private async documents<T>(directory: string, normalize: (raw: unknown) => { definition: T; errors: string[] }): Promise<IntakeDocument<T>[]> {
    await this.ensureStarted();
    const files = (await readdir(directory, { withFileTypes: true })).filter((item) => item.isFile() && item.name.endsWith(".yaml") && !item.name.startsWith("."));
    return Promise.all(files.map(async (file) => this.document(await readFile(join(directory, file.name), "utf8"), normalize)));
  }

  listSources(): Promise<IntakeDocument<IntakeSourceDefinition>[]> { return this.documents(this.sourcesDirectory, normalizeSource); }
  listCampaigns(): Promise<IntakeDocument<CampaignDefinition>[]> { return this.documents(this.campaignsDirectory, normalizeCampaign); }

  async source(id: string, revision?: string): Promise<IntakeDocument<IntakeSourceDefinition>> {
    await this.ensureStarted();
    const path = revision ? join(this.sourcesDirectory, ".versions", id, `${revision}.yaml`) : join(this.sourcesDirectory, `${id}.yaml`);
    try {
      const document = this.document(await readFile(path, "utf8"), normalizeSource);
      if (document.definition.id !== id) throw new HttpError(409, `Source file ${id} declares ${document.definition.id}`);
      return document;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Source ${id}${revision ? `@${revision}` : ""} not found`); throw error; }
  }

  async campaign(id: string, revision?: string): Promise<IntakeDocument<CampaignDefinition>> {
    await this.ensureStarted();
    const path = revision ? join(this.campaignsDirectory, ".versions", id, `${revision}.yaml`) : join(this.campaignsDirectory, `${id}.yaml`);
    try {
      const document = this.document(await readFile(path, "utf8"), normalizeCampaign);
      if (document.definition.id !== id) throw new HttpError(409, `Campaign file ${id} declares ${document.definition.id}`);
      return document;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Campaign ${id}${revision ? `@${revision}` : ""} not found`); throw error; }
  }

  private async save<T extends CampaignDefinition | IntakeSourceDefinition>(kind: "source" | "campaign", content: string, expectedRevision?: string): Promise<IntakeDocument<T>> {
    return this.serial(async () => {
      await this.ensureStarted();
      const normalize = (kind === "source" ? normalizeSource : normalizeCampaign) as (
        raw: unknown,
      ) => { definition: T; errors: string[] };
      const document = this.document(content, normalize) as IntakeDocument<T>;
      if (!document.valid) throw new HttpError(422, `${kind === "source" ? "Source" : "Campaign"} is invalid`, document.errors);
      const directory = kind === "source" ? this.sourcesDirectory : this.campaignsDirectory;
      const path = join(directory, `${document.definition.id}.yaml`);
      let current: IntakeDocument<T> | null = null;
      try { current = this.document(await readFile(path, "utf8"), normalize) as IntakeDocument<T>; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (expectedRevision !== undefined && current?.revision !== expectedRevision) throw new HttpError(409, `${kind} revision changed`, current);
      if (kind === "source") {
        const campaigns = await this.documents(this.campaignsDirectory, normalizeCampaign);
        if (!campaigns.some((campaign) => campaign.valid && campaign.definition.id === (document.definition as IntakeSourceDefinition).campaign_id)) {
          throw new HttpError(422, `Source campaign ${(document.definition as IntakeSourceDefinition).campaign_id} does not exist`);
        }
      }
      if (current) await atomicWrite(join(directory, ".versions", document.definition.id, `${current.revision}.yaml`), current.content);
      await atomicWrite(path, document.content);
      await atomicWrite(join(directory, ".versions", document.definition.id, `${document.revision}.yaml`), document.content);
      return document;
    });
  }

  saveSource(content: string, expectedRevision?: string): Promise<IntakeDocument<IntakeSourceDefinition>> { return this.save("source", content, expectedRevision); }
  saveCampaign(content: string, expectedRevision?: string): Promise<IntakeDocument<CampaignDefinition>> { return this.save("campaign", content, expectedRevision); }

  private runPath(run: Pick<IntakeRun, "source_id" | "id">): string { return join(this.runsDirectory, run.source_id, `${run.id}.json`); }
  private candidatePath(sourceId: string, externalKey: string): string { return join(this.candidatesDirectory, sourceId, `${digest(externalKey)}.json`); }
  private cursorPath(sourceId: string): string { return join(this.stateDirectory, `${sourceId}.cursor.json`); }
  private async writeRun(run: IntakeRun): Promise<void> { await atomicWrite(this.runPath(run), `${JSON.stringify(run, null, 2)}\n`); }
  private async writeCandidate(candidate: IntakeCandidateRecord): Promise<void> { await atomicWrite(this.candidatePath(candidate.source_id, candidate.external_key), `${JSON.stringify(candidate, null, 2)}\n`); }
  private async readCursor(sourceId: string): Promise<JsonValue | null> {
    try { return JSON.parse(await readFile(this.cursorPath(sourceId), "utf8")) as JsonValue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async listRuns(sourceId?: string): Promise<IntakeRun[]> {
    await this.ensureStarted();
    const directories = sourceId ? [join(this.runsDirectory, sourceId)] : (await readdir(this.runsDirectory, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => join(this.runsDirectory, item.name));
    const paths = (await Promise.all(directories.map(jsonFiles))).flat();
    return (await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as IntakeRun))).sort((left, right) => right.scheduled_at.localeCompare(left.scheduled_at));
  }

  async listCandidates(sourceId?: string): Promise<IntakeCandidateRecord[]> {
    await this.ensureStarted();
    const directories = sourceId ? [join(this.candidatesDirectory, sourceId)] : (await readdir(this.candidatesDirectory, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => join(this.candidatesDirectory, item.name));
    const paths = (await Promise.all(directories.map(jsonFiles))).flat();
    return (await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as IntakeCandidateRecord))).sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at));
  }

  private async expireRuns(now: Date): Promise<void> {
    for (const run of await this.listRuns()) {
      if (run.status !== "running" || !run.lease_expires_at || Date.parse(run.lease_expires_at) > now.getTime()) continue;
      run.status = "ready"; run.supervisor_id = null; run.lease_id = null; run.last_heartbeat_at = null; run.lease_expires_at = null;
      run.error = "Supervisor lease expired; source run requeued.";
      await this.writeRun(run);
    }
  }

  private async createRun(source: IntakeDocument<IntakeSourceDefinition>, campaign: IntakeDocument<CampaignDefinition>, scheduledAt: Date, mode: "admit" | "preview" = "admit"): Promise<IntakeRun> {
    const run: IntakeRun = {
      version: 1, id: randomUUID(), mode, source_id: source.definition.id, source_revision: source.revision, campaign_id: campaign.definition.id, campaign_revision: campaign.revision,
      status: "ready", scheduled_at: scheduledAt.toISOString(), started_at: null, completed_at: null, attempt: 0,
      supervisor_id: null, lease_id: null, last_heartbeat_at: null, lease_expires_at: null,
      runner: structuredClone(source.definition.runner), cursor_before: await this.readCursor(source.definition.id), cursor_after: null,
      candidates_received: 0, decisions: emptyDecisions(), error: null, output_path: null, output_bytes: 0, output_sha256: null, preview_candidates: [],
    };
    await this.writeRun(run);
    return run;
  }

  async trigger(sourceId: string, preview = false): Promise<IntakeRun> {
    return this.serial(async () => {
      await this.ensureStarted();
      const source = await this.source(sourceId);
      if (!source.valid || !preview && !source.definition.enabled) throw new HttpError(409, `Source ${sourceId} is not enabled`);
      if (source.definition.runner.type !== "supervisor_script") throw new HttpError(409, `Source ${sourceId} is externally triggered`);
      const campaign = await this.campaign(source.definition.campaign_id);
      if (!campaign.valid || !preview && !campaign.definition.enabled) throw new HttpError(409, `Campaign ${campaign.definition.id} is not enabled`);
      const active = (await this.listRuns(sourceId)).find((run) => run.status === "ready" || run.status === "running");
      if (active) throw new HttpError(409, `Source ${sourceId} already has an active run`, { run_id: active.id });
      return this.createRun(source, campaign, this.now(), preview ? "preview" : "admit");
    });
  }

  async scheduleDue(): Promise<{ scheduled: number; admitted_deferred: number }> {
    return this.serial(async () => {
      await this.ensureStarted();
      const now = this.now();
      await this.expireRuns(now);
      const [sources, campaigns, runs] = await Promise.all([this.listSources(), this.listCampaigns(), this.listRuns()]);
      const campaignById = new Map(campaigns.filter((item) => item.valid).map((item) => [item.definition.id, item]));
      let scheduled = 0;
      for (const source of sources.filter((item) => item.valid && item.definition.enabled && item.definition.runner.type === "supervisor_script")) {
        const campaign = campaignById.get(source.definition.campaign_id);
        if (!campaign?.definition.enabled) continue;
        const allSourceRuns = runs.filter((run) => run.source_id === source.definition.id);
        if (allSourceRuns.some((run) => run.status === "ready" || run.status === "running")) continue;
        const last = allSourceRuns.filter((run) => (run.mode ?? "admit") === "admit").sort((left, right) => right.scheduled_at.localeCompare(left.scheduled_at))[0];
        if (last && now.getTime() - Date.parse(last.scheduled_at) < source.definition.schedule.interval_minutes * 60_000) continue;
        await this.createRun(source, campaign, now); scheduled += 1;
      }
      const admittedDeferred = await this.reconcileDeferredInternal();
      return { scheduled, admitted_deferred: admittedDeferred };
    });
  }

  async claim(supervisorId: string, capabilities: ActivityCapability[] = ["inline_shell", "inline_python", "inline_javascript"]): Promise<ClaimedIntakeRun | null> {
    return this.serial(async () => {
      await this.ensureStarted();
      await this.expireRuns(this.now());
      const ready = (await this.listRuns()).filter((item) => item.status === "ready").sort((left, right) => left.scheduled_at.localeCompare(right.scheduled_at));
      for (const run of ready) {
        const source = await this.source(run.source_id, run.source_revision).catch(() => null);
        if (!source?.valid || ((run.mode ?? "admit") === "admit" && !source.definition.enabled) || source.definition.runner.type !== "supervisor_script") continue;
        const required: ActivityCapability = source.definition.runner.language === "python" ? "inline_python" : source.definition.runner.language === "javascript" ? "inline_javascript" : "inline_shell";
        if (!capabilities.includes(required)) continue;
        const campaign = await this.campaign(run.campaign_id).catch(() => null);
        if (!campaign?.valid || ((run.mode ?? "admit") === "admit" && !campaign.definition.enabled)) continue;
        const now = this.now();
        run.status = "running"; run.attempt += 1; run.started_at ??= now.toISOString(); run.supervisor_id = supervisorId;
        run.lease_id = randomUUID(); run.last_heartbeat_at = now.toISOString(); run.lease_expires_at = new Date(now.getTime() + this.leaseTtlMs).toISOString(); run.error = null;
        await this.writeRun(run);
        return { ...run, lease_id: run.lease_id, supervisor_id: run.supervisor_id, last_heartbeat_at: run.last_heartbeat_at, lease_expires_at: run.lease_expires_at, source: source.definition };
      }
      return null;
    });
  }

  private async byLease(leaseId: string): Promise<IntakeRun> {
    const run = (await this.listRuns()).find((item) => item.lease_id === leaseId);
    if (!run || run.status !== "running") throw new HttpError(409, "Intake source lease is no longer active", undefined, "INTAKE_LEASE_FENCED");
    if (!run.lease_expires_at || Date.parse(run.lease_expires_at) <= this.now().getTime()) throw new HttpError(409, "Intake source lease expired", undefined, "INTAKE_LEASE_EXPIRED");
    return run;
  }

  async heartbeat(leaseId: string): Promise<IntakeRun> {
    return this.serial(async () => {
      const run = await this.byLease(leaseId);
      const now = this.now(); run.last_heartbeat_at = now.toISOString(); run.lease_expires_at = new Date(now.getTime() + this.leaseTtlMs).toISOString();
      await this.writeRun(run); return run;
    });
  }

  private async scopedTickets(sourceId: string, campaignId: string): Promise<{ source: TicketFrontmatter[]; campaign: TicketFrontmatter[] }> {
    const tickets = (await this.tickets.list()).flatMap((item) => item.valid && item.frontmatter ? [item.frontmatter] : []);
    return {
      source: tickets.filter((ticket) => ticketOrigin(ticket).source_id === sourceId),
      campaign: tickets.filter((ticket) => ticketOrigin(ticket).campaign_id === campaignId),
    };
  }

  private capacityReason(items: TicketFrontmatter[], limit: IntakeLimits, label: string): string | null {
    if (items.filter(openTicket).length >= limit.max_open) return `${label} max_open limit ${limit.max_open} reached`;
    if (items.filter(working).length >= limit.max_working) return `${label} max_working limit ${limit.max_working} reached`;
    if (items.filter((ticket) => !ticket.archived_at && ticket.status !== "cancelled").length >= limit.max_observed_unarchived) return `${label} max_observed_unarchived limit ${limit.max_observed_unarchived} reached`;
    return null;
  }

  private async admitRecord(record: IntakeCandidateRecord, source: IntakeDocument<IntakeSourceDefinition>, campaign: IntakeDocument<CampaignDefinition>, run: IntakeRun): Promise<IntakeCandidateRecord> {
    const duplicateTicket = (await this.tickets.list()).flatMap((item) => item.valid && item.frontmatter ? [item.frontmatter] : [])
      .find((ticket) => ticketOrigin(ticket).source_id === source.definition.id && ticketOrigin(ticket).external_key === record.external_key);
    if (duplicateTicket) {
      record.decision = "duplicate"; record.reason = `Already represented by ${duplicateTicket.id}`; record.ticket_id = duplicateTicket.id;
      await this.writeCandidate(record); return record;
    }
    const scoped = await this.scopedTickets(source.definition.id, campaign.definition.id);
    const dayStart = new Date(this.now()); dayStart.setUTCHours(0, 0, 0, 0);
    const admittedToday = (await this.listCandidates()).filter((item) => item.admitted_at && Date.parse(item.admitted_at) >= dayStart.getTime());
    const sourceToday = admittedToday.filter((item) => item.source_id === source.definition.id).length;
    const campaignToday = admittedToday.filter((item) => item.campaign_id === campaign.definition.id).length;
    const reason = sourceToday >= source.definition.limits.max_new_per_day ? `source max_new_per_day limit ${source.definition.limits.max_new_per_day} reached`
      : campaignToday >= campaign.definition.limits.max_new_per_day ? `campaign max_new_per_day limit ${campaign.definition.limits.max_new_per_day} reached`
        : this.capacityReason(scoped.source, source.definition.limits, "source") ?? this.capacityReason(scoped.campaign, campaign.definition.limits, "campaign");
    if (reason) {
      record.decision = "deferred"; record.reason = reason; await this.writeCandidate(record); return record;
    }
    if (!this.admitter) throw new HttpError(503, "Intake ticket admission is not configured");
    record.decision = "deferred"; record.reason = "Admission interrupted before ticket creation"; await this.writeCandidate(record);
    const ticketId = await this.admitter({ source, campaign, run, candidate: record.candidate, parent_ticket_id: record.parent_ticket_id });
    record.decision = "admitted"; record.reason = null; record.ticket_id = ticketId; record.admitted_at = this.now().toISOString();
    await this.writeCandidate(record); return record;
  }

  private async submitInternal(source: IntakeDocument<IntakeSourceDefinition>, campaign: IntakeDocument<CampaignDefinition>, run: IntakeRun, values: unknown[], parentTicketId: string | null): Promise<IntakeCandidateRecord[]> {
    const output: IntakeCandidateRecord[] = [];
    let admittedThisRun = 0;
    for (const value of values) {
      const parsed = candidateInput(value);
      const now = this.now().toISOString();
      const externalKey = parsed.candidate.external_key || `invalid:${randomUUID()}`;
      const path = this.candidatePath(source.definition.id, externalKey);
      let existing: IntakeCandidateRecord | null = null;
      try { existing = JSON.parse(await readFile(path, "utf8")) as IntakeCandidateRecord; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const record: IntakeCandidateRecord = existing ? {
        ...existing, source_revision: source.revision, source_run_id: run.id, candidate: parsed.candidate,
        parent_ticket_id: parentTicketId ?? existing.parent_ticket_id, last_seen_at: now, observation_count: existing.observation_count + 1,
      } : {
        version: 1, id: digest(`${source.definition.id}\0${externalKey}`).slice(0, 32), source_id: source.definition.id, source_revision: source.revision,
        campaign_id: campaign.definition.id, source_run_id: run.id, external_key: externalKey, candidate: parsed.candidate,
        decision: "deferred", reason: null, ticket_id: null, parent_ticket_id: parentTicketId,
        first_seen_at: now, last_seen_at: now, observation_count: 1, admitted_at: null,
      };
      if (parsed.errors.length) {
        record.decision = "rejected"; record.reason = parsed.errors.join("; "); await this.writeCandidate(record); output.push(record); continue;
      }
      if (existing?.ticket_id) {
        record.decision = "duplicate"; record.reason = `Already represented by ${existing.ticket_id}`; await this.writeCandidate(record); output.push(record); continue;
      }
      const perRunLimit = Math.min(source.definition.limits.max_new_per_run, campaign.definition.limits.max_new_per_run);
      if (admittedThisRun >= perRunLimit) {
        const owner = source.definition.limits.max_new_per_run <= campaign.definition.limits.max_new_per_run ? "source" : "campaign";
        record.decision = "deferred"; record.reason = `${owner} max_new_per_run limit ${perRunLimit} reached`; await this.writeCandidate(record); output.push(record); continue;
      }
      const decided = await this.admitRecord(record, source, campaign, run);
      if (decided.decision === "admitted") admittedThisRun += 1;
      output.push(decided);
    }
    return output;
  }

  async complete(leaseId: string, input: { candidates: unknown[]; cursor?: unknown; output?: string }): Promise<IntakeSubmissionResult> {
    return this.serial(async () => {
      const run = await this.byLease(leaseId);
      if (!Array.isArray(input.candidates)) throw new HttpError(422, "candidates must be an array");
      if (input.candidates.length > 10_000) throw new HttpError(422, "A source run may submit at most 10000 candidates");
      const source = await this.source(run.source_id, run.source_revision);
      const campaign = await this.campaign(run.campaign_id, run.campaign_revision);
      const cursor = input.cursor === undefined ? run.cursor_before : jsonValue(input.cursor, "cursor", [], 0);
      if (cursor === undefined) throw new HttpError(422, "cursor must be JSON-compatible");
      if (input.output !== undefined) {
        if (typeof input.output !== "string") throw new HttpError(422, "output must be a string");
        const bytes = Buffer.from(input.output);
        if (bytes.byteLength > 1_048_576) throw new HttpError(413, "Source output exceeds 1 MiB");
        const outputPath = join(this.ledgerDirectory, "outputs", run.source_id, `${run.id}.log`);
        await atomicWrite(outputPath, input.output);
        run.output_path = outputPath; run.output_bytes = bytes.byteLength; run.output_sha256 = digest(bytes);
      }
      if ((run.mode ?? "admit") === "preview") {
        run.preview_candidates = input.candidates.slice(0, 100).map((value) => {
          const parsed = candidateInput(value);
          return { external_key: parsed.candidate.external_key, title: parsed.candidate.title, valid: parsed.errors.length === 0, errors: parsed.errors };
        });
        run.cursor_after = run.cursor_before; run.status = "completed"; run.completed_at = this.now().toISOString();
        run.lease_id = null; run.lease_expires_at = null; run.last_heartbeat_at = null; run.candidates_received = input.candidates.length;
        await this.writeRun(run);
        return { run, candidates: [] };
      }
      const records = await this.submitInternal(source, campaign, run, input.candidates, null);
      if (cursor !== null) await atomicWrite(this.cursorPath(run.source_id), `${JSON.stringify(cursor, null, 2)}\n`);
      run.cursor_after = cursor ?? null; run.status = "completed"; run.completed_at = this.now().toISOString(); run.lease_id = null; run.lease_expires_at = null; run.last_heartbeat_at = null;
      run.candidates_received = records.length; run.decisions = records.reduce((counts, record) => ({ ...counts, [record.decision]: counts[record.decision] + 1 }), emptyDecisions());
      await this.writeRun(run);
      return { run, candidates: records };
    });
  }

  async fail(leaseId: string, reason: string, output?: string): Promise<IntakeRun> {
    return this.serial(async () => {
      const run = await this.byLease(leaseId);
      run.status = "failed"; run.completed_at = this.now().toISOString(); run.error = reason.trim() || "Source run failed";
      if (output) {
        const bounded = Buffer.from(output).subarray(0, 1_048_576);
        const path = join(this.ledgerDirectory, "outputs", run.source_id, `${run.id}.log`);
        await atomicWrite(path, bounded.toString()); run.output_path = path; run.output_bytes = bounded.byteLength; run.output_sha256 = digest(bounded);
      }
      run.lease_id = null; run.lease_expires_at = null; run.last_heartbeat_at = null;
      await this.writeRun(run); return run;
    });
  }

  async submitExternal(sourceId: string, values: unknown[], parentTicketId: string | null = null): Promise<IntakeSubmissionResult> {
    return this.serial(async () => {
      const source = await this.source(sourceId);
      if (!source.valid || !source.definition.enabled) throw new HttpError(409, `Source ${sourceId} is not enabled`);
      const campaign = await this.campaign(source.definition.campaign_id);
      if (!campaign.valid || !campaign.definition.enabled) throw new HttpError(409, `Campaign ${campaign.definition.id} is not enabled`);
      const now = this.now().toISOString();
      const run: IntakeRun = {
        version: 1, id: randomUUID(), mode: "admit", source_id: source.definition.id, source_revision: source.revision, campaign_id: campaign.definition.id, campaign_revision: campaign.revision,
        status: "running", scheduled_at: now, started_at: now, completed_at: null, attempt: 1, supervisor_id: null,
        lease_id: null, last_heartbeat_at: null, lease_expires_at: null, runner: { type: "external" }, cursor_before: await this.readCursor(sourceId), cursor_after: null,
        candidates_received: 0, decisions: emptyDecisions(), error: null, output_path: null, output_bytes: 0, output_sha256: null, preview_candidates: [],
      };
      const records = await this.submitInternal(source, campaign, run, values, parentTicketId);
      run.status = "completed"; run.completed_at = this.now().toISOString(); run.candidates_received = records.length;
      run.decisions = records.reduce((counts, record) => ({ ...counts, [record.decision]: counts[record.decision] + 1 }), emptyDecisions());
      await this.writeRun(run);
      return { run, candidates: records };
    });
  }

  private async reconcileDeferredInternal(): Promise<number> {
    let admitted = 0;
    const deferred = (await this.listCandidates()).filter((item) => item.decision === "deferred" && !item.ticket_id).sort((left, right) => left.first_seen_at.localeCompare(right.first_seen_at));
    for (const record of deferred) {
      try {
        const source = await this.source(record.source_id, record.source_revision).catch(() => this.source(record.source_id));
        const campaign = await this.campaign(record.campaign_id);
        if (!source.definition.enabled || !campaign.definition.enabled) continue;
        const run = (await this.listRuns(record.source_id)).find((item) => item.id === record.source_run_id) ?? {
          version: 1, id: record.source_run_id, mode: "admit", source_id: record.source_id, source_revision: source.revision, campaign_id: campaign.definition.id, campaign_revision: campaign.revision,
          status: "completed", scheduled_at: record.first_seen_at, started_at: record.first_seen_at, completed_at: record.last_seen_at, attempt: 1,
          supervisor_id: null, lease_id: null, last_heartbeat_at: null, lease_expires_at: null, runner: { type: "external" }, cursor_before: null, cursor_after: null,
          candidates_received: 1, decisions: emptyDecisions(), error: null, output_path: null, output_bytes: 0, output_sha256: null, preview_candidates: [],
        } satisfies IntakeRun;
        const result = await this.admitRecord(record, source, campaign, run);
        if (result.decision === "admitted") admitted += 1;
      } catch { /* retain deferred state until its source is repaired */ }
    }
    return admitted;
  }

  async reconcileDeferred(): Promise<number> { return this.serial(() => this.reconcileDeferredInternal()); }

  async output(sourceId: string, runId: string): Promise<string> {
    const run = (await this.listRuns(sourceId)).find((item) => item.id === runId);
    if (!run?.output_path) throw new HttpError(404, `Source run ${runId} has no persisted output`);
    return readFile(run.output_path, "utf8");
  }

  async metrics() {
    const [sources, campaigns, runs, candidates, loadedTickets] = await Promise.all([this.listSources(), this.listCampaigns(), this.listRuns(), this.listCandidates(), this.tickets.list()]);
    const tickets = loadedTickets.flatMap((item) => item.valid && item.frontmatter ? [item.frontmatter] : []);
    const sourceMetrics = sources.filter((item) => item.valid).map((source) => {
      const allSourceRuns = runs.filter((run) => run.source_id === source.definition.id);
      const sourceRuns = allSourceRuns.filter((run) => (run.mode ?? "admit") === "admit");
      const sourceCandidates = candidates.filter((candidate) => candidate.source_id === source.definition.id);
      const sourceTickets = tickets.filter((ticket) => ticketOrigin(ticket).source_id === source.definition.id);
      const settledRuns = sourceRuns.filter((run) => run.status === "completed" || run.status === "failed");
      const successfulRuns = sourceRuns.filter((run) => run.status === "completed").length;
      return {
        id: source.definition.id, name: source.definition.name, revision: source.revision, enabled: source.definition.enabled, campaign_id: source.definition.campaign_id,
        runs: sourceRuns.length, successful_runs: successfulRuns, failed_runs: sourceRuns.filter((run) => run.status === "failed").length,
        success_rate: settledRuns.length ? successfulRuns / settledRuns.length : null,
        average_duration_ms: settledRuns.length ? settledRuns.reduce((sum, run) => sum + Math.max(0, Date.parse(run.completed_at!) - Date.parse(run.started_at ?? run.scheduled_at)), 0) / settledRuns.length : null,
        running_runs: allSourceRuns.filter((run) => run.status === "running").length, preview_runs: allSourceRuns.filter((run) => run.mode === "preview").length, candidates: sourceCandidates.length,
        admitted: sourceCandidates.filter((candidate) => candidate.decision === "admitted" || candidate.ticket_id).length,
        deferred: sourceCandidates.filter((candidate) => candidate.decision === "deferred" && !candidate.ticket_id).length,
        duplicates: sourceCandidates.filter((candidate) => candidate.decision === "duplicate").length,
        rejected: sourceCandidates.filter((candidate) => candidate.decision === "rejected").length,
        open_tickets: sourceTickets.filter(openTicket).length, working_tickets: sourceTickets.filter(working).length,
        completed_tickets: sourceTickets.filter((ticket) => ticket.status === "completed").length,
        production_successes: sourceTickets.filter((ticket) => ticket.production_result === "succeeded").length,
      };
    });
    const campaignMetrics = campaigns.filter((item) => item.valid).map((campaign) => {
      const campaignSources = sourceMetrics.filter((source) => source.campaign_id === campaign.definition.id);
      const campaignTickets = tickets.filter((ticket) => ticketOrigin(ticket).campaign_id === campaign.definition.id);
      return {
        id: campaign.definition.id, name: campaign.definition.name, revision: campaign.revision, enabled: campaign.definition.enabled,
        sources: campaignSources.length, runs: campaignSources.reduce((sum, item) => sum + item.runs, 0),
        successful_runs: campaignSources.reduce((sum, item) => sum + item.successful_runs, 0), failed_runs: campaignSources.reduce((sum, item) => sum + item.failed_runs, 0),
        candidates: campaignSources.reduce((sum, item) => sum + item.candidates, 0), admitted: campaignSources.reduce((sum, item) => sum + item.admitted, 0),
        deferred: campaignSources.reduce((sum, item) => sum + item.deferred, 0), open_tickets: campaignTickets.filter(openTicket).length,
        working_tickets: campaignTickets.filter(working).length, completed_tickets: campaignTickets.filter((ticket) => ticket.status === "completed").length,
        production_successes: campaignTickets.filter((ticket) => ticket.production_result === "succeeded").length,
      };
    });
    return {
      generated_at: this.now().toISOString(),
      totals: {
        campaigns: campaignMetrics.length, enabled_campaigns: campaignMetrics.filter((item) => item.enabled).length,
        invalid_campaigns: campaigns.filter((item) => !item.valid).length,
        sources: sourceMetrics.length, enabled_sources: sourceMetrics.filter((item) => item.enabled).length,
        invalid_sources: sources.filter((item) => !item.valid).length,
        runs: runs.filter((run) => (run.mode ?? "admit") === "admit").length, preview_runs: runs.filter((run) => run.mode === "preview").length,
        running_runs: runs.filter((run) => run.status === "running").length, failed_runs: runs.filter((run) => run.status === "failed").length,
        candidates: candidates.length, admitted: candidates.filter((item) => item.ticket_id).length,
        deferred: candidates.filter((item) => item.decision === "deferred" && !item.ticket_id).length,
        rejected: candidates.filter((item) => item.decision === "rejected").length,
      },
      campaigns: campaignMetrics,
      sources: sourceMetrics,
      recent_runs: runs.slice(0, 50),
      recent_candidates: candidates.slice(0, 100),
    };
  }
}
