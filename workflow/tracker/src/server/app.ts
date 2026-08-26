import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ACTIVITY_CAPABILITIES, HttpError, PRODUCTION_RESULTS, PROVIDERS, isProgressed, type ActivityCapability, type ArtifactKind, type ExecutionTraceEvent, type HarnessTelemetrySnapshot, type JsonValue, type Phase, type ProductionResult, type PullRequestRef, type ResolvedAgentProfile, type TicketFrontmatter } from "./domain.js";
import { MAX_ARTIFACT_BYTES, MAX_ATTACHMENT_BYTES, TicketStore, mergePullRequests } from "./ticket-store.js";
import { SupervisorRegistry, type SupervisorPresenceInput } from "./supervisor-registry.js";
import { TrackerConfigStore, type RepositoryConfig } from "./config-store.js";
import { parseDocument, serializeDocument } from "./markdown.js";
import { JiraCloudClient } from "./jira.js";
import { GithubObserver } from "./github-observer.js";
import { PromptLibrary } from "./prompt-library.js";
import { normalizeTicket, telemetrySnapshot } from "./validation.js";
import { WorkflowLibrary, accountNodeRunTiming, activeWorkflowIdentity, activityRoute, advanceWorkflow, beginNodeRun, enterCurrentNode, finishNodeRun, initializeWorkflow, nodeAttemptCounter, resolveNodeProvider, resolvedAgentProfile, runtimeNodeKey, transitionTo, workflowNode, workflowRoute, workflowRoutes, type WorkflowDocument } from "./workflow-library.js";
import { buildMetrics, buildWorkflowComparison, type MetricsFilters } from "./metrics.js";
import { estimateTelemetryCost } from "./pricing.js";
import { parseQualityReport } from "./quality.js";
import { log } from "./logger.js";
import { OperationalMonitor } from "./operations.js";
import { IntakeStore } from "./intake-store.js";
import { buildQuotaReport } from "./quota-estimator.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function activityCapabilities(value: unknown): ActivityCapability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => ACTIVITY_CAPABILITIES.includes(item))) {
    throw new HttpError(422, "activity_capabilities must contain only supported activity capabilities");
  }
  return [...new Set(value)] as ActivityCapability[];
}

function heartbeatHerdr(value: unknown) {
  if (!isRecord(value)) return undefined;
  const tokens = isRecord(value.tokens)
    ? Object.fromEntries(Object.entries(value.tokens).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  return {
    pane_id: optionalString(value.pane_id), workspace_id: optionalString(value.workspace_id),
    tab_id: optionalString(value.tab_id), terminal_id: optionalString(value.terminal_id),
    focused: typeof value.focused === "boolean" ? value.focused : null,
    cwd: optionalString(value.cwd), foreground_cwd: optionalString(value.foreground_cwd),
    terminal_title: optionalString(value.terminal_title), terminal_title_stripped: optionalString(value.terminal_title_stripped),
    display_name: optionalString(value.display_name),
    revision: Number.isInteger(value.revision) && Number(value.revision) >= 0 ? Number(value.revision) : null,
    session_source: optionalString(value.session_source), session_kind: optionalString(value.session_kind), tokens,
  };
}

function heartbeatTelemetry(value: unknown, field: string): HarnessTelemetrySnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  const errors: string[] = [];
  const parsed = telemetrySnapshot(value, field, errors);
  if (!parsed || errors.length) throw new HttpError(422, `Invalid ${field}`, errors);
  return parsed;
}

function bodyDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function yamlArtifactId(content: string, kind: string): string {
  try {
    const value = parseYaml(content);
    if (!isRecord(value)) throw new Error(`${kind} must be a YAML object`);
    return message(value.id, `${kind} id`);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, `${kind} YAML is invalid`, [(error as Error).message]);
  }
}

function ticketJson(loaded: Awaited<ReturnType<TicketStore["get"]>>) {
  return {
    id: loaded.frontmatter?.id || loaded.relativePath,
    path: loaded.path,
    relative_path: loaded.relativePath,
    markdown: loaded.markdown,
    body: loaded.body,
    frontmatter: loaded.frontmatter,
    valid: loaded.valid,
    errors: loaded.errors,
  };
}

function expectedRevision(request: Request): number | undefined {
  const value = request.body?.expected_revision;
  return Number.isInteger(value) ? Number(value) : undefined;
}

function message(value: unknown, field = "message"): string {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(422, `${field} must be a non-empty string`);
  return value.trim();
}

function artifactPresentation(query: Request["query"]): Record<string, JsonValue> | undefined {
  const hint = (value: unknown, maximum: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= maximum ? trimmed : undefined;
  };
  const title = hint(query.title, 160);
  const description = hint(query.description, 500);
  const category = hint(query.category, 64);
  const featured = query.featured === "true" || query.featured === "1";
  if (!title && !description && !category && !featured) return undefined;
  return { presentation: { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(category ? { category } : {}), ...(featured ? { featured: true } : {}) } };
}

function metadataKey(value: unknown): string {
  const key = message(value, "metadata key");
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) throw new HttpError(422, "metadata key must start with a letter and contain only letters, numbers, dot, underscore, or hyphen");
  return key;
}

function jsonPayload(value: unknown, field: string, depth = 0): JsonValue {
  if (depth > 12) throw new HttpError(422, `${field} exceeds maximum nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonPayload(item, `${field}[${index}]`, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonPayload(item, `${field}.${key}`, depth + 1)]));
  throw new HttpError(422, `${field} must be JSON-compatible`);
}

function executionTraceEvents(value: unknown, firstSequence: number): ExecutionTraceEvent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new HttpError(422, "events must contain between 1 and 100 trace events", undefined, "EXECUTION_TRACE_INVALID");
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new HttpError(422, `events[${index}] must be an object`, undefined, "EXECUTION_TRACE_INVALID");
    const sequence = candidate.sequence;
    const timestamp = candidate.timestamp;
    const elapsedMs = candidate.elapsed_ms;
    const event = candidate.event;
    if (sequence !== firstSequence + index || !Number.isSafeInteger(sequence) || Number(sequence) < 1) throw new HttpError(422, `events[${index}].sequence is not contiguous`, undefined, "EXECUTION_TRACE_INVALID");
    if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) throw new HttpError(422, `events[${index}].timestamp is invalid`, undefined, "EXECUTION_TRACE_INVALID");
    if (!Number.isSafeInteger(elapsedMs) || Number(elapsedMs) < 0) throw new HttpError(422, `events[${index}].elapsed_ms is invalid`, undefined, "EXECUTION_TRACE_INVALID");
    if (typeof event !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(event)) throw new HttpError(422, `events[${index}].event is invalid`, undefined, "EXECUTION_TRACE_INVALID");
    const data = jsonPayload(candidate.data ?? {}, `events[${index}].data`);
    if (!isRecord(data)) throw new HttpError(422, `events[${index}].data must be an object`, undefined, "EXECUTION_TRACE_INVALID");
    return { sequence: Number(sequence), timestamp, elapsed_ms: Number(elapsedMs), event, data };
  });
}

function productionResult(value: unknown): ProductionResult {
  if (!PRODUCTION_RESULTS.includes(value as never)) throw new HttpError(422, "production_result is invalid");
  return value as ProductionResult;
}

function csvQuery(value: unknown): string[] {
  const source = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
  return [...new Set(source.split(",").map((item) => item.trim()).filter(Boolean))];
}

interface AgentQuestionInput { question: string; options: string[] }

function questionOptions(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(422, `${field} must be an array of non-empty strings`);
  return value.map((option, index) => message(option, `${field}[${index}]`));
}

function agentQuestions(body: unknown): AgentQuestionInput[] {
  if (!isRecord(body)) throw new HttpError(422, "Request body must contain question or questions");
  const hasQuestion = body.question !== undefined;
  const hasQuestions = body.questions !== undefined;
  if (hasQuestion && hasQuestions) throw new HttpError(422, "Supply question or questions, not both");
  if (hasQuestion) return [{ question: message(body.question, "question"), options: questionOptions(body.options, "options") }];
  if (body.options !== undefined) throw new HttpError(422, "Top-level options may only accompany question");
  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    throw new HttpError(422, "questions must be a non-empty array of strings or question objects");
  }
  return body.questions.map((item, index) => typeof item === "string"
    ? { question: message(item, `questions[${index}]`), options: [] }
    : isRecord(item)
      ? { question: message(item.question, `questions[${index}].question`), options: questionOptions(item.options, `questions[${index}].options`) }
      : (() => { throw new HttpError(422, `questions[${index}] must be a string or question object`); })());
}

function replaceDescription(body: string, description: string): string {
  const interaction = body.match(/\n?## Interaction Log[\s\S]*$/)?.[0]?.trimStart() ?? "";
  return `# Goal\n\n${description.trim() || "No Jira description was supplied."}\n\n${interaction}`.trimEnd() + "\n";
}

function descriptionOnly(body: string): string {
  return body.replace(/\n?## Interaction Log[\s\S]*$/, "").trim();
}

export function createApp(
  store: TicketStore,
  clientDirectory = resolve("dist/client"),
  registry = new SupervisorRegistry(),
  configStore = new TrackerConfigStore(store.root),
  jiraClient = new JiraCloudClient(),
  githubObserver = new GithubObserver(store, configStore),
  promptLibrary = new PromptLibrary(store.root),
  workflowLibrary = new WorkflowLibrary(store.root),
  operations = new OperationalMonitor(),
  intakeStore = new IntakeStore(store.root, store),
) {
  store.setWorkflowLibrary(workflowLibrary);
  githubObserver.setWorkflowLibrary(workflowLibrary);
  const app = express();
  app.use((request, response, next) => {
    const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
    const startedAt = Date.now();
    response.setHeader("X-Request-Id", requestId);
    response.on("finish", () => {
      const ticketId = request.path.match(/^\/api\/tickets\/([^/]+)/)?.[1];
      const leaseId = request.path.match(/^\/api\/work\/([^/]+)/)?.[1];
      const routine = request.path === "/api/supervisors/heartbeat" || /^\/api\/work\/[^/]+\/(heartbeat|control|guidance)$/.test(request.path);
      log(response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : routine ? "debug" : "info", "http.request", {
        request_id: requestId, method: request.method, path: request.path, status: response.statusCode,
        duration_ms: Date.now() - startedAt,
        ...(ticketId ? { ticket_id: decodeURIComponent(ticketId) } : {}),
        ...(leaseId && !["claim", "claim-activity", "active"].includes(leaseId) ? { lease_id: decodeURIComponent(leaseId) } : {}),
      });
    });
    next();
  });
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  const workJson = async (loaded: Awaited<ReturnType<TicketStore["get"]>>) => {
    const ticket = loaded.frontmatter;
    if (!ticket?.workflow) return ticketJson(loaded);
    const identity = activeWorkflowIdentity(ticket);
    const definition = (await workflowLibrary.get(identity.id, identity.revision)).definition;
    const node = workflowNode(definition, ticket.workflow.current_node);
    const promptRevision = node.prompt ? ticket.workflow.prompt_revisions[node.prompt] : undefined;
    const prompt = node.prompt ? await promptLibrary.get(node.prompt, promptRevision) : null;
    return {
      ...ticketJson(loaded),
      workflow_definition: definition,
      workflow_node: node,
      resolved_agent_profile: resolvedAgentProfile(ticket, node),
      node_prompt: prompt ? { id: prompt.name, revision: prompt.revision, content: prompt.content } : null,
    };
  };

  const configurationJson = async (providedConfig?: Awaited<ReturnType<TrackerConfigStore["read"]>>) => {
    const config = providedConfig ?? await configStore.read();
    const tickets = (await store.list()).flatMap((loaded) => loaded.valid && loaded.frontmatter ? [loaded.frontmatter] : []);
    return { config, quota: buildQuotaReport(tickets, registry.list(tickets), config.metrics) };
  };

  const workflowArtifacts = async (root: WorkflowDocument) => {
    const config = await configStore.read();
    const revisions: Record<string, string> = {};
    const promptRevisions: Record<string, string> = {};
    const profiles: Record<string, ResolvedAgentProfile> = {};
    const visited = new Set<string>();
    const visit = async (document: WorkflowDocument): Promise<void> => {
      if (visited.has(document.definition.id)) return;
      visited.add(document.definition.id); revisions[document.definition.id] = document.revision;
      for (const node of document.definition.nodes) {
        if (node.prompt && !promptRevisions[node.prompt]) promptRevisions[node.prompt] = (await promptLibrary.get(node.prompt)).revision;
        if (node.type === "agent" && node.agent_profile) {
          const alias = node.agent_profile === "default" ? config.agent_profiles.default : node.agent_profile;
          const profile = config.agent_profiles.profiles.find((candidate) => candidate.id === alias);
          if (node.agent_profile && !profile) throw new HttpError(422, `Agent profile ${alias} does not exist`);
          if (profile) profiles[`${document.definition.id}/${node.id}`] = { alias, provider: profile.provider, model: profile.model, reasoning: profile.reasoning };
        }
        if (node.type === "workflow" && node.workflow_id) await visit((await workflowLibrary.assignment(node.workflow_id)).document);
      }
    };
    await visit(root);
    return { revisions, promptRevisions, profiles };
  };

  intakeStore.setAdmitter(async ({ source, campaign, run, candidate, parent_ticket_id: parentTicketId }) => {
    const existingIds = (await store.list()).flatMap((item) => item.frontmatter ? [item.frontmatter.id] : []);
    const id = await configStore.allocateTicketId(existingIds);
    const template = source.definition.ticket;
    const assigned = await workflowLibrary.assignment(candidate.workflow_id ?? template.workflow_id, candidate.workflow_revision ?? template.workflow_revision);
    const artifacts = await workflowArtifacts(assigned.document);
    const normalized = normalizeTicket({
      id,
      title: candidate.title,
      priority: candidate.priority ?? template.priority,
      labels: [...new Set([...template.labels, ...(candidate.labels ?? [])])],
      repositories: candidate.repositories ?? template.repositories,
      metadata: {
        ...(candidate.metadata ?? {}),
        "intake.source_id": source.definition.id,
        "intake.source_revision": source.revision,
        "intake.campaign_id": campaign.definition.id,
        "intake.campaign_revision": campaign.revision,
        "intake.external_key": candidate.external_key,
        "intake.source_run_id": run.id,
        ...(parentTicketId ? { "intake.parent_ticket_id": parentTicketId } : {}),
      },
    });
    if (normalized.errors.length) throw new HttpError(422, "Candidate could not become a valid ticket", normalized.errors);
    initializeWorkflow(normalized.ticket, assigned.document, artifacts.promptRevisions, {
      inputs: { ...template.workflow_inputs, ...(candidate.workflow_inputs ?? {}) },
      stage_enabled: { ...template.stage_enabled, ...(candidate.stage_enabled ?? {}) },
      workflow_revisions: artifacts.revisions,
      resolved_agent_profiles: artifacts.profiles,
      assignment_selection: assigned.selection,
    });
    const created = await store.create(serializeDocument(normalized.ticket, `# Goal\n\n${candidate.description.trim()}\n`));
    let admitted = await store.command(id, {
      event: "intake.ticket_admitted",
      message: `Admitted from source ${source.definition.id} in campaign ${campaign.definition.id}.`,
      expectedRevision: created.frontmatter!.revision,
    }, (ticket) => ({ ticket }));
    if (candidate.mark_ready ?? template.mark_ready) {
      admitted = await store.command(id, {
        event: "ticket.ready",
        message: `Ticket admitted ready by intake source ${source.definition.id}.`,
        expectedRevision: admitted.frontmatter!.revision,
      }, (ticket) => {
        const firstVisit = (ticket.workflow?.node_visits[ticket.workflow.current_node] ?? 0) === 0;
        enterCurrentNode(ticket, assigned.document.definition, firstVisit);
        return { ticket };
      });
      await store.settleAutomatic(admitted.frontmatter!.id);
    }
    return id;
  });

  app.get("/api/health", async (_request, response) => {
    const uptime = process.uptime();
    const health = {
      status: "ok",
      uptime_seconds: Math.floor(uptime),
      memory_usage: {
        heap_used: process.memoryUsage().heapUsed / 1024 / 1024,
        heap_total: process.memoryUsage().heapTotal / 1024 / 1024,
        external: process.memoryUsage().external / 1024 / 1024,
      },
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      server_time: new Date().toISOString(),
    };
    response.json(health);
  });
  app.get("/api/healthz", (_request, response) => response.json({ status: "ok" }));
  const operationalStatus = async () => {
    const failures: string[] = [];
    const check = async <T>(name: string, work: () => Promise<T>): Promise<T | null> => {
      try { return await work(); } catch (error) { failures.push(`${name}: ${(error as Error).message}`); return null; }
    };
    const [ticketStore, config, prompts, workflows, intake] = await Promise.all([
      check("ticket_store", () => store.operationalStatus()),
      check("configuration", () => configStore.read()),
      check("prompts", () => promptLibrary.list()),
      check("workflows", () => workflowLibrary.list()),
      check("intake", () => intakeStore.metrics()),
    ]);
    if (ticketStore && !ticketStore.writable) failures.push("ticket_store: ticket root is not writable");
    const invalidPrompts = prompts?.filter((prompt) => !prompt.valid).map((prompt) => prompt.name) ?? [];
    const invalidWorkflows = workflows?.filter((workflow) => !workflow.valid).map((workflow) => workflow.definition.id) ?? [];
    const warnings = [
      ...(ticketStore?.invalid_tickets ? [`${ticketStore.invalid_tickets} invalid ticket(s) are excluded from scheduling`] : []),
      ...(invalidPrompts.length ? [`Invalid prompts: ${invalidPrompts.join(", ")}`] : []),
      ...(invalidWorkflows.length ? [`Invalid workflows: ${invalidWorkflows.join(", ")}`] : []),
      ...(intake?.totals.invalid_campaigns ? [`${intake.totals.invalid_campaigns} invalid intake campaign(s)`] : []),
      ...(intake?.totals.invalid_sources ? [`${intake.totals.invalid_sources} invalid intake source(s)`] : []),
    ];
    return {
      status: failures.length ? "not_ready" : warnings.length ? "degraded" : "ready",
      ready: failures.length === 0,
      checked_at: new Date().toISOString(), failures, warnings,
      ticket_store: ticketStore,
      libraries: {
        configuration_revision: config?.revision ?? null,
        prompts: prompts?.length ?? null, invalid_prompts: invalidPrompts,
        workflows: workflows?.length ?? null, invalid_workflows: invalidWorkflows,
      },
      intake: intake?.totals ?? null,
      background_operations: operations.snapshot(),
    };
  };
  app.get("/api/operations", async (_request, response) => response.json(await operationalStatus()));
  app.get("/api/capabilities", (_request, response) => response.json({
    supervisor_protocol_versions: [1, 2, 3],
    workflow_schema_versions: [2],
    intake_protocol_versions: [1],
    activity_capabilities: [...ACTIVITY_CAPABILITIES],
  }));

  app.get("/api/intake", async (_request, response) => {
    const [sources, campaigns, metrics] = await Promise.all([intakeStore.listSources(), intakeStore.listCampaigns(), intakeStore.metrics()]);
    response.json({ ...metrics, source_documents: sources, campaign_documents: campaigns });
  });
  app.get("/api/intake/sources/:id", async (request, response) => response.json({ source: await intakeStore.source(String(request.params.id)) }));
  app.put("/api/intake/sources/:id", async (request, response) => {
    const content = message(request.body?.content, "content");
    if (yamlArtifactId(content, "Source") !== String(request.params.id)) throw new HttpError(422, "Source id must match the URL");
    const source = await intakeStore.saveSource(content, typeof request.body?.expected_revision === "string" ? request.body.expected_revision : undefined);
    store.emit("changed", { type: "intake.changed", source_id: source.definition.id });
    response.json({ source });
  });
  app.get("/api/intake/campaigns/:id", async (request, response) => response.json({ campaign: await intakeStore.campaign(String(request.params.id)) }));
  app.put("/api/intake/campaigns/:id", async (request, response) => {
    const content = message(request.body?.content, "content");
    if (yamlArtifactId(content, "Campaign") !== String(request.params.id)) throw new HttpError(422, "Campaign id must match the URL");
    const campaign = await intakeStore.saveCampaign(content, typeof request.body?.expected_revision === "string" ? request.body.expected_revision : undefined);
    store.emit("changed", { type: "intake.changed", campaign_id: campaign.definition.id });
    response.json({ campaign });
  });
  app.post("/api/intake/sources/:id/run", async (request, response) => {
    const run = await intakeStore.trigger(String(request.params.id), request.body?.preview === true);
    store.emit("changed", { type: "intake.changed", source_id: run.source_id, run_id: run.id });
    response.status(201).json({ run });
  });
  app.post("/api/intake/sources/:id/candidates", async (request, response) => {
    if (!Array.isArray(request.body?.candidates)) throw new HttpError(422, "candidates must be an array");
    const result = await intakeStore.submitExternal(String(request.params.id), request.body.candidates);
    store.emit("changed", { type: "intake.changed", source_id: String(request.params.id), run_id: result.run.id });
    response.status(201).json(result);
  });
  app.post("/api/tickets/:id/candidates", async (request, response) => {
    const parent = await store.get(String(request.params.id));
    if (!parent.valid || !parent.frontmatter) throw new HttpError(422, "Parent ticket is invalid", parent.errors);
    if (!Array.isArray(request.body?.candidates)) throw new HttpError(422, "candidates must be an array");
    const result = await intakeStore.submitExternal(message(request.body?.source_id, "source_id"), request.body.candidates, parent.frontmatter.id);
    store.emit("changed", { type: "intake.changed", source_id: result.run.source_id, run_id: result.run.id, parent_ticket_id: parent.frontmatter.id });
    response.status(201).json(result);
  });
  app.get("/api/intake/sources/:source/runs/:run/output", async (request, response) => {
    response.type("text/plain").send(await intakeStore.output(String(request.params.source), String(request.params.run)));
  });

  app.post("/api/intake/work/claim", async (request, response) => {
    const supervisor = message(request.body?.supervisor_id, "supervisor_id");
    if (typeof request.body?.instance_id === "string") registry.assertInstance(supervisor, request.body.instance_id);
    const claimed = await intakeStore.claim(supervisor, activityCapabilities(request.body?.activity_capabilities));
    if (!claimed) { response.status(204).end(); return; }
    log("info", "intake.claimed", { source_id: claimed.source_id, run_id: claimed.id, lease_id: claimed.lease_id, supervisor_id: supervisor });
    response.json({ run: claimed });
  });
  app.post("/api/intake/work/:lease/heartbeat", async (request, response) => response.json({ run: await intakeStore.heartbeat(String(request.params.lease)) }));
  app.post("/api/intake/work/:lease/complete", async (request, response) => {
    if (!Array.isArray(request.body?.candidates)) throw new HttpError(422, "candidates must be an array");
    const result = await intakeStore.complete(String(request.params.lease), { candidates: request.body.candidates, cursor: request.body.cursor, output: request.body.output });
    store.emit("changed", { type: "intake.changed", source_id: result.run.source_id, run_id: result.run.id });
    response.json(result);
  });
  app.post("/api/intake/work/:lease/fail", async (request, response) => {
    const run = await intakeStore.fail(String(request.params.lease), message(request.body?.reason, "reason"), typeof request.body?.output === "string" ? request.body.output : undefined);
    store.emit("changed", { type: "intake.changed", source_id: run.source_id, run_id: run.id });
    response.json({ run });
  });
  app.post("/api/work/:lease/candidates", async (request, response) => {
    const parent = await store.byLease(String(request.params.lease));
    if (Date.parse(parent.execution.lease_expires_at) <= Date.now()) throw new HttpError(409, "Lease expired before candidate submission", undefined, "LEASE_EXPIRED");
    if (!Array.isArray(request.body?.candidates)) throw new HttpError(422, "candidates must be an array");
    const result = await intakeStore.submitExternal(message(request.body?.source_id, "source_id"), request.body.candidates, parent.frontmatter.id);
    store.emit("changed", { type: "intake.changed", source_id: result.run.source_id, run_id: result.run.id, parent_ticket_id: parent.frontmatter.id });
    response.status(201).json(result);
  });
  app.get("/api/readyz", async (_request, response) => {
    const status = await operationalStatus();
    response.status(status.ready ? 200 : 503).json(status);
  });
  app.get("/api/config", async (_request, response) => response.json(await configurationJson()));
  app.get("/api/artifacts/diagnostics", async (_request, response) => response.json(await store.artifactDiagnostics()));
  app.post("/api/artifacts/maintenance", async (_request, response) => response.json(await operations.run(
    "artifact_maintenance",
    async () => store.maintainArtifacts((await configStore.read()).artifacts),
    (result) => ({ recovered_records: result.recovered_records.length, removed_records: result.collection.removed_records.length, removed_blobs: result.collection.removed_blobs.length, healthy: result.diagnostics.healthy }),
  )));
  app.put("/api/config", async (request, response) => {
    if (!Array.isArray(request.body?.repositories)) throw new HttpError(422, "repositories must be an array");
    if (!Number.isInteger(request.body?.expected_revision)) throw new HttpError(422, "expected_revision must be an integer");
    const current = await configStore.read();
    const config = await configStore.update({
      providers: isRecord(request.body.providers) ? request.body.providers as never : current.providers,
      agent_profiles: isRecord(request.body.agent_profiles) ? request.body.agent_profiles as never : current.agent_profiles,
      repositories: request.body.repositories as RepositoryConfig[],
      jira: isRecord(request.body.jira) ? request.body.jira as never : current.jira,
      github: isRecord(request.body.github) ? request.body.github as never : current.github,
      pricing: isRecord(request.body.pricing) ? request.body.pricing as never : current.pricing,
      metrics: isRecord(request.body.metrics) ? request.body.metrics as never : current.metrics,
      quality: isRecord(request.body.quality) ? request.body.quality as never : current.quality,
      artifacts: isRecord(request.body.artifacts) ? request.body.artifacts as never : current.artifacts,
    }, Number(request.body.expected_revision));
    store.emit("changed", { type: "config.changed", revision: config.revision });
    response.json(await configurationJson(config));
  });
  app.get("/api/prompts", async (_request, response) => {
    const [prompts, workflows] = await Promise.all([promptLibrary.list(), workflowLibrary.list()]);
    response.json({ prompts: prompts.map((prompt) => ({
      ...prompt,
      workflow_references: workflows.flatMap((workflow) => workflow.definition.nodes
        .filter((node) => node.prompt === prompt.name)
        .map((node) => ({ workflow_id: workflow.definition.id, workflow_name: workflow.definition.name, node_id: node.id, node_name: node.name, outcomes: workflowRoutes(node).map((route) => route.id) }))),
    })) });
  });
  app.post("/api/prompts", async (request, response) => {
    const prompt = await promptLibrary.create(message(request.body?.name, "name"), message(request.body?.content, "content"));
    store.emit("changed", { type: "prompts.changed", name: prompt.name, revision: prompt.revision });
    response.status(201).json({ prompt });
  });
  app.put("/api/prompts/:name", async (request, response) => {
    const content = message(request.body?.content, "content");
    const revision = message(request.body?.expected_revision, "expected_revision");
    const prompt = await promptLibrary.update(String(request.params.name), content, revision);
    store.emit("changed", { type: "prompts.changed", name: prompt.name, revision: prompt.revision });
    response.json({ prompt });
  });
  app.post("/api/prompts/:name/restore-default", async (request, response) => {
    const prompt = await promptLibrary.restore(String(request.params.name), message(request.body?.expected_revision, "expected_revision"));
    store.emit("changed", { type: "prompts.changed", name: prompt.name, revision: prompt.revision });
    response.json({ prompt });
  });
  app.post("/api/prompts/:name/preview", async (request, response) => {
    const phase = request.body?.phase === "specification" || request.body?.phase === "review" ? request.body.phase : "implementation";
    response.json({ rendered: await promptLibrary.preview(String(request.params.name), message(request.body?.content, "content"), phase) });
  });
  app.get("/api/workflows", async (_request, response) => response.json({ workflows: await workflowLibrary.list() }));
  app.get("/api/workflow-releases", async (_request, response) => response.json(await workflowLibrary.catalog()));
  app.get("/api/workflows/:id/revisions/:revision", async (request, response) => response.json({ workflow: await workflowLibrary.get(String(request.params.id), String(request.params.revision)) }));
  app.get("/api/workflows/:id", async (request, response) => response.json({ workflow: await workflowLibrary.get(String(request.params.id)) }));
  app.post("/api/workflows", async (request, response) => {
    const promptIds = new Set((await promptLibrary.list()).filter((prompt) => prompt.valid).map((prompt) => prompt.name));
    const content = message(request.body?.content, "content");
    const parsed = parseYaml(content) as { id?: unknown };
    const workflowIds = new Set((await workflowLibrary.list()).map((item) => item.definition.id));
    if (typeof parsed?.id === "string") workflowIds.add(parsed.id);
    const profileIds = new Set((await configStore.read()).agent_profiles.profiles.map((profile) => profile.id).concat("default"));
    const workflow = await workflowLibrary.save(content, undefined, promptIds, workflowIds, profileIds, {
      makeDefault: true, ...(typeof request.body?.label === "string" ? { label: request.body.label } : {}),
    });
    store.emit("changed", { type: "workflows.changed", id: workflow.definition.id, revision: workflow.revision });
    response.status(201).json({ workflow });
  });
  app.put("/api/workflows/:id", async (request, response) => {
    const content = message(request.body?.content, "content");
    const expected = message(request.body?.expected_revision, "expected_revision");
    const promptIds = new Set((await promptLibrary.list()).filter((prompt) => prompt.valid).map((prompt) => prompt.name));
    const workflowIds = new Set((await workflowLibrary.list()).map((item) => item.definition.id));
    const profileIds = new Set((await configStore.read()).agent_profiles.profiles.map((profile) => profile.id).concat("default"));
    const workflow = await workflowLibrary.save(content, expected, promptIds, workflowIds, profileIds, {
      makeDefault: request.body?.make_default === true,
      ...(typeof request.body?.label === "string" ? { label: request.body.label } : {}),
    });
    if (workflow.definition.id !== String(request.params.id)) throw new HttpError(422, "Workflow id cannot be changed during update");
    store.emit("changed", { type: "workflows.changed", id: workflow.definition.id, revision: workflow.revision });
    response.json({ workflow });
  });
  app.post("/api/workflows/:id/revisions/:revision/promote", async (request, response) => {
    const result = await workflowLibrary.promote(String(request.params.id), String(request.params.revision));
    store.emit("changed", { type: "workflows.default.changed", id: String(request.params.id), revision: String(request.params.revision) });
    response.json(result);
  });
  app.post("/api/workflows/:id/restore-default", async (request, response) => {
    const workflow = await workflowLibrary.restore(String(request.params.id), message(request.body?.expected_revision, "expected_revision"));
    store.emit("changed", { type: "workflows.changed", id: workflow.definition.id, revision: workflow.revision });
    response.json({ workflow });
  });
  app.post("/api/defaults/restore", async (request, response) => {
    const restorePrompts = request.body?.prompts !== false;
    const restoreWorkflows = request.body?.workflows !== false;
    if (!restorePrompts && !restoreWorkflows) throw new HttpError(422, "Select prompts, workflows, or both");
    const prompts = restorePrompts ? await promptLibrary.restoreAll() : [];
    const workflows = restoreWorkflows ? await workflowLibrary.restoreAll() : [];
    store.emit("changed", { type: "defaults.restored", prompts: prompts.length, workflows: workflows.length });
    response.json({ prompts, workflows });
  });
  app.get("/api/tickets", async (request, response) => {
    const tickets = await store.summaries(request.query.include_archived === "true");
    // Keep malformed files repairable, but omit valid pre-workflow tickets from
    // the V3 operator queue. Direct ticket APIs remain available for recovery.
    response.json({ tickets: tickets.filter((ticket) => !ticket.valid || ticket.workflow_id !== null) });
  });
  app.get("/api/metrics", async (request, response) => {
    const from = typeof request.query.from === "string" && request.query.from ? request.query.from : undefined;
    const to = typeof request.query.to === "string" && request.query.to ? request.query.to : undefined;
    if (from && Number.isNaN(Date.parse(from))) throw new HttpError(422, "from must be an ISO date or timestamp");
    if (to && Number.isNaN(Date.parse(to))) throw new HttpError(422, "to must be an ISO date or timestamp");
    const requestedProduction = typeof request.query.production_result === "string" && request.query.production_result
      ? productionResult(request.query.production_result) : undefined;
    const filters: MetricsFilters = {
      ...(from ? { from } : {}), ...(to ? { to } : {}), labels: csvQuery(request.query.labels),
      label_mode: request.query.label_mode === "all" ? "all" : "any",
      ...(typeof request.query.workflow_id === "string" && request.query.workflow_id ? { workflow_id: request.query.workflow_id } : {}),
      ...(typeof request.query.workflow_revision === "string" && request.query.workflow_revision ? { workflow_revision: request.query.workflow_revision } : {}),
      repositories: csvQuery(request.query.repositories),
      ...(requestedProduction ? { production_result: requestedProduction } : {}),
    };
    response.json(await buildMetrics(store, workflowLibrary, filters, (await configStore.read()).metrics));
  });
  app.get("/api/metrics/compare", async (request, response) => {
    const from = typeof request.query.from === "string" && request.query.from ? request.query.from : undefined;
    const to = typeof request.query.to === "string" && request.query.to ? request.query.to : undefined;
    if (from && Number.isNaN(Date.parse(from))) throw new HttpError(422, "from must be an ISO date or timestamp");
    if (to && Number.isNaN(Date.parse(to))) throw new HttpError(422, "to must be an ISO date or timestamp");
    const requestedProduction = typeof request.query.production_result === "string" && request.query.production_result
      ? productionResult(request.query.production_result) : undefined;
    const filters: MetricsFilters = {
      ...(from ? { from } : {}), ...(to ? { to } : {}), labels: csvQuery(request.query.labels),
      label_mode: request.query.label_mode === "all" ? "all" : "any", repositories: csvQuery(request.query.repositories),
      ...(requestedProduction ? { production_result: requestedProduction } : {}),
    };
    const left = { workflow_id: message(request.query.left_id, "left_id"), workflow_revision: message(request.query.left_revision, "left_revision") };
    const right = { workflow_id: message(request.query.right_id, "right_id"), workflow_revision: message(request.query.right_revision, "right_revision") };
    await workflowLibrary.get(left.workflow_id, left.workflow_revision); await workflowLibrary.get(right.workflow_id, right.workflow_revision);
    response.json(await buildWorkflowComparison(store, workflowLibrary, left, right, filters, (await configStore.read()).metrics));
  });
  app.get("/api/tickets/:id/runs/:run/output", async (request, response) => {
    response.type("text/plain").send(await store.nodeRunOutput(String(request.params.id), String(request.params.run)));
  });
  app.get("/api/runtime", async (_request, response) => {
    const agents = (await store.list()).flatMap((loaded) => {
      const ticket = loaded.valid ? loaded.frontmatter : null;
      const execution = ticket?.execution;
      if (!ticket || !execution) return [];
      if (!ticket.workflow || !execution.node_id) return [];
      const attemptCounter = nodeAttemptCounter(ticket, execution.node_id);
      const conversation = execution.conversation_key ? ticket.conversations?.[execution.conversation_key] : undefined;
      return [{
        ticket_id: ticket.id, title: ticket.title, phase: ticket.phase, status: ticket.status,
        provider: execution.provider, attempt: execution.attempt, claimed_at: execution.claimed_at,
        node_id: execution.node_id ?? ticket.phase, node_type: execution.node_type ?? "agent",
        last_heartbeat_at: execution.last_heartbeat_at, lease_expires_at: execution.lease_expires_at,
        delivery_status: execution.delivery_status, delivery_confirmed_at: execution.delivery_confirmed_at,
        consecutive_lease_losses: attemptCounter.consecutive_lease_losses,
        pane_id: conversation?.herdr_pane_id ?? null, session_ref: conversation?.session_ref ?? null,
        herdr: execution.herdr_observation, telemetry: execution.telemetry,
      }];
    });
    response.json({ agents });
  });
  app.get("/api/supervisors", async (_request, response) => {
    const tickets = (await store.list()).flatMap((loaded) => loaded.valid && loaded.frontmatter ? [loaded.frontmatter] : []);
    response.json({ supervisors: registry.list(tickets) });
  });
  app.post("/api/supervisors/heartbeat", async (request, response) => {
    const providers = request.body?.providers;
    const ips = request.body?.ip_addresses;
    if (!Array.isArray(providers) || !providers.length || !providers.every((provider) => PROVIDERS.includes(provider))) {
      throw new HttpError(422, "providers must be a non-empty provider array");
    }
    if (!Array.isArray(ips) || !ips.every((ip) => typeof ip === "string" && ip.trim())) {
      throw new HttpError(422, "ip_addresses must be an array of strings");
    }
    const input: SupervisorPresenceInput = {
      supervisor_id: message(request.body?.supervisor_id, "supervisor_id"),
      instance_id: message(request.body?.instance_id, "instance_id"),
      hostname: message(request.body?.hostname, "hostname"),
      ip_addresses: [...new Set(ips.map((ip: string) => ip.trim()))],
      project_root: message(request.body?.project_root, "project_root"),
      herdr_session: message(request.body?.herdr_session, "herdr_session"),
      providers: [...new Set(providers)],
      activity_capabilities: activityCapabilities(request.body?.activity_capabilities),
      started_at: message(request.body?.started_at, "started_at"),
    };
    const supervisor = registry.heartbeat(input);
    store.emit("changed", { type: "supervisors.changed", supervisor_id: input.supervisor_id });
    response.json({ supervisor });
  });
  app.post("/api/supervisors/unregister", async (request, response) => {
    const supervisorId = message(request.body?.supervisor_id, "supervisor_id");
    const instanceId = message(request.body?.instance_id, "instance_id");
    const removed = registry.unregister(supervisorId, instanceId);
    if (removed) store.emit("changed", { type: "supervisors.changed", supervisor_id: supervisorId });
    response.json({ removed });
  });
  app.get("/api/tickets/next-id", async (_request, response) => {
    const ids = (await store.list()).flatMap((item) => item.frontmatter ? [item.frontmatter.id] : []);
    response.json({ id: await configStore.previewTicketId(ids) });
  });
  app.post("/api/tickets", async (request, response) => {
    let markdown = message(request.body?.markdown, "markdown");
    if (request.body?.auto_id === true) {
      const ids = (await store.list()).flatMap((item) => item.frontmatter ? [item.frontmatter.id] : []);
      const id = await configStore.allocateTicketId(ids);
      const document = parseDocument(markdown);
      markdown = serializeDocument({ ...document.frontmatter, id } as unknown as TicketFrontmatter, document.body);
    }
    const document = parseDocument(markdown);
    if (document.frontmatter.workflow === undefined) {
      const normalized = normalizeTicket(document.frontmatter);
      if (normalized.errors.length) throw new HttpError(422, "Ticket is invalid", normalized.errors);
      const assigned = await workflowLibrary.assignment(
        typeof request.body?.workflow_id === "string" ? request.body.workflow_id : undefined,
        typeof request.body?.workflow_revision === "string" ? request.body.workflow_revision : undefined,
      );
      const workflow = assigned.document;
      const artifacts = await workflowArtifacts(workflow);
      const inputs = isRecord(request.body?.workflow_inputs) ? request.body.workflow_inputs as Record<string, boolean | string> : undefined;
      const stageEnabled = isRecord(request.body?.stage_enabled) ? request.body.stage_enabled as Record<string, boolean> : undefined;
      initializeWorkflow(normalized.ticket, workflow, artifacts.promptRevisions, {
        ...(inputs ? { inputs } : {}), ...(stageEnabled ? { stage_enabled: stageEnabled } : {}),
        workflow_revisions: artifacts.revisions, resolved_agent_profiles: artifacts.profiles,
        assignment_selection: assigned.selection,
      });
      markdown = serializeDocument(normalized.ticket, document.body);
    }
    const created = await store.create(markdown, typeof request.body?.filename === "string" ? request.body.filename : undefined);
    response.status(201).json(ticketJson(created));
  });
  app.post("/api/jira/import", async (request, response) => {
    const config = await configStore.read();
    response.json({ draft: await jiraClient.issue(config.jira, message(request.body?.key, "key")) });
  });
  app.get("/api/tickets/:id", async (request, response) => {
    const id = String(request.params.id);
    let loaded = await store.get(id);
    if (loaded.valid && loaded.frontmatter?.jira && loaded.frontmatter.status === "pending" && !isProgressed(loaded.frontmatter)) {
      try {
        const config = await configStore.read();
        const remote = await jiraClient.issue(config.jira, loaded.frontmatter.jira.key);
        if (remote.source_updated_at !== loaded.frontmatter.jira.source_updated_at) {
          loaded = await store.command(id, { event: "jira.resynced", message: `Pending ticket refreshed from ${remote.jira.key}.`, expectedRevision: loaded.frontmatter.revision }, (ticket, body) => {
            ticket.title = remote.title; ticket.labels = remote.labels; ticket.jira = remote.jira;
            return { ticket, body: replaceDescription(body, remote.description) };
          });
        }
      } catch (error) {
        response.json({ ...ticketJson(loaded), integration_warnings: [(error as Error).message] }); return;
      }
    }
    response.json(await workJson(loaded));
  });
  app.post("/api/tickets/:id/attachments", express.raw({ type: "application/octet-stream", limit: MAX_ATTACHMENT_BYTES }), async (request, response) => {
    if (!Buffer.isBuffer(request.body)) throw new HttpError(422, "Attachment body must be application/octet-stream");
    const revision = Number(request.query.expected_revision);
    if (!Number.isInteger(revision) || revision < 1) throw new HttpError(422, "expected_revision must be a positive integer");
    const contentType = typeof request.headers["x-attachment-content-type"] === "string"
      ? request.headers["x-attachment-content-type"] : "application/octet-stream";
    const updated = await store.addAttachment(
      String(request.params.id), message(request.query.filename, "filename"), contentType, request.body, revision,
    );
    response.status(201).json(await workJson(updated));
  });
  app.get("/api/tickets/:id/attachments/:attachmentId/content", async (request, response) => {
    const { attachment, content } = await store.attachment(String(request.params.id), String(request.params.attachmentId));
    const fallback = attachment.filename.replaceAll(/[^\x20-\x7e]/g, "_").replaceAll(/["\\]/g, "_");
    const disposition = request.query.download === "true" ? "attachment" : "inline";
    response.setHeader("Content-Type", attachment.content_type);
    response.setHeader("Content-Length", String(attachment.size_bytes));
    response.setHeader("Content-Disposition", `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    response.setHeader("ETag", `"${attachment.sha256}"`);
    response.send(content);
  });
  app.delete("/api/tickets/:id/attachments/:attachmentId", async (request, response) => {
    const updated = await store.removeAttachment(
      String(request.params.id), String(request.params.attachmentId), expectedRevision(request),
    );
    response.json(await workJson(updated));
  });

  app.post("/api/work/:lease/artifacts", express.raw({ type: "application/octet-stream", limit: MAX_ARTIFACT_BYTES }), async (request, response) => {
    const kind = String(request.query.kind ?? "") as ArtifactKind;
    if (!["evidence", "script_output", "script_artifact", "quality_report", "checkpoint_bundle"].includes(kind)) throw new HttpError(422, "Unsupported lease artifact kind");
    const filename = String(request.query.filename ?? "");
    const contentType = String(request.query.content_type ?? "application/octet-stream");
    if (!Buffer.isBuffer(request.body)) throw new HttpError(422, "Artifact body must be application/octet-stream");
    let metadata = artifactPresentation(request.query);
    if (kind === "quality_report") {
      const leased = await store.byLease(String(request.params.lease));
      if (!leased.frontmatter.workflow || leased.execution.node_type !== "script") throw new HttpError(409, "Quality reports may only be uploaded by Script nodes");
      const identity = activeWorkflowIdentity(leased.frontmatter);
      const node = workflowNode((await workflowLibrary.get(identity.id, identity.revision)).definition, leased.frontmatter.workflow.current_node);
      const artifactName = message(request.query.artifact_name, "artifact_name");
      const declaration = node.artifacts?.find((artifact) => artifact.name === artifactName);
      if (!declaration?.interpretation || declaration.interpretation.kind !== "quality_report") throw new HttpError(422, `Artifact ${artifactName} is not declared as a quality report`);
      if (contentType !== declaration.content_type) throw new HttpError(422, `Artifact ${artifactName} must use declared content type ${declaration.content_type}`);
      const config = await configStore.read();
      metadata = { ...parseQualityReport(request.body, artifactName, declaration.interpretation.required_attributes, config.quality, config.revision), ...(metadata ?? {}) };
    }
    response.status(201).json({ artifact: await store.addArtifactForLease(String(request.params.lease), {
      kind, filename, contentType, content: request.body, ...(metadata ? { metadata } : {}),
    }) });
  });

  app.get("/api/tickets/:id/artifacts/:artifactId/content", async (request, response) => {
    const stored = await store.artifact(String(request.params.id), String(request.params.artifactId));
    response.setHeader("Content-Type", stored.record.content_type);
    response.setHeader("Content-Length", String(stored.record.size_bytes));
    response.setHeader("ETag", `\"sha256:${stored.record.sha256}\"`);
    response.setHeader("Content-Disposition", `${request.query.download === "true" ? "attachment" : "inline"}; filename=\"${stored.record.filename.replace(/[\"\\]/g, "_")}\"`);
    response.send(stored.content);
  });

  app.get("/api/tickets/:id/checkpoints", async (request, response) => {
    const ticket = await store.get(String(request.params.id));
    if (!ticket.frontmatter) throw new HttpError(422, "Ticket is invalid", ticket.errors);
    response.json({ checkpoints: ticket.frontmatter.checkpoints });
  });

  app.post("/api/tickets/:id/checkpoints/action", async (request, response) => {
    const id = String(request.params.id);
    const loaded = await store.get(id);
    if (!loaded.valid || !loaded.frontmatter?.workflow) throw new HttpError(409, "Ticket does not have a valid workflow");
    const identity = activeWorkflowIdentity(loaded.frontmatter);
    const document = await workflowLibrary.get(identity.id, identity.revision);
    const nodeId = message(request.body?.node_id, "node_id");
    const node = workflowNode(document.definition, nodeId);
    const action = request.body?.action;
    if (action !== "create" && action !== "restore") throw new HttpError(422, "action must be create or restore");
    if (action === "create" && node.type !== "checkpoint") throw new HttpError(422, "Create action requires a checkpoint node");
    if (action === "restore" && node.type !== "restore_checkpoint") throw new HttpError(422, "Restore action requires a restore checkpoint node");
    const checkpointId = action === "restore" ? message(request.body?.checkpoint_id, "checkpoint_id") : null;
    if (checkpointId && !loaded.frontmatter.checkpoints.some((checkpoint) => checkpoint.id === checkpointId)) throw new HttpError(404, `Checkpoint ${checkpointId} was not found`);
    const updated = await store.command(id, { event: `checkpoint.${action}_requested`, message: `Operator requested ${action} through node ${node.name}.`, expectedRevision: expectedRevision(request) }, (ticket) => {
      ticket.metadata ??= {};
      if (action === "restore") ticket.metadata["checkpoint.restore_id"] = checkpointId!;
      else ticket.metadata["checkpoint.request_kind"] = "manual";
      if (ticket.execution) {
        if (ticket.execution.interrupt_request) throw new HttpError(409, "Ticket is already waiting for execution interruption");
        ticket.execution.interrupt_request = {
          target_phase: node.phase as Exclude<Phase, "done">, target_node: node.id,
          target_workflow_id: document.definition.id, target_workflow_revision: document.revision,
          requested_at: new Date().toISOString(),
        };
      } else {
        ticket.workflow!.stage_enabled[node.stage] = true;
        transitionTo(ticket, document.definition, node.id, { outcome: `operator_${action}`, summary: `Operator requested ${action}.`, actor: "operator" });
        ticket.archived_at = null;
      }
      return { ticket };
    });
    response.json(await workJson(updated));
  });
  app.get("/api/tickets/:id/metadata", async (request, response) => {
    const loaded = await store.get(String(request.params.id));
    if (!loaded.valid || !loaded.frontmatter) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    response.json({ metadata: loaded.frontmatter.metadata ?? {}, revision: loaded.frontmatter.revision });
  });
  app.get("/api/tickets/:id/metadata/:key", async (request, response) => {
    const loaded = await store.get(String(request.params.id));
    if (!loaded.valid || !loaded.frontmatter) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    const key = metadataKey(request.params.key);
    response.json({ key, value: loaded.frontmatter.metadata?.[key] ?? null, exists: Object.hasOwn(loaded.frontmatter.metadata ?? {}, key), revision: loaded.frontmatter.revision });
  });
  app.put("/api/tickets/:id/metadata/:key", async (request, response) => {
    const key = metadataKey(request.params.key);
    if (!("value" in (request.body ?? {})) || request.body.value === undefined) throw new HttpError(422, "value is required and must be JSON-compatible");
    const updated = await store.command(String(request.params.id), {
      event: "ticket.metadata_written", message: `Metadata ${key} was updated.`, expectedRevision: expectedRevision(request),
    }, (ticket) => { ticket.metadata ??= {}; ticket.metadata[key] = request.body.value as JsonValue; return { ticket }; });
    response.json(ticketJson(await store.settleAutomatic(updated.frontmatter!.id)));
  });
  app.delete("/api/tickets/:id/metadata/:key", async (request, response) => {
    const key = metadataKey(request.params.key);
    const updated = await store.command(String(request.params.id), {
      event: "ticket.metadata_deleted", message: `Metadata ${key} was deleted.`, expectedRevision: expectedRevision(request),
    }, (ticket) => { if (ticket.metadata) delete ticket.metadata[key]; return { ticket }; });
    response.json(ticketJson(await store.settleAutomatic(updated.frontmatter!.id)));
  });
  app.put("/api/tickets/:id", async (request, response) => {
    const updated = await store.edit(
      String(request.params.id), message(request.body?.markdown, "markdown"), Number(request.body?.expected_revision),
    );
    response.json(ticketJson(updated));
  });

  app.post("/api/tickets/:id/ready", async (request, response) => {
    const id = String(request.params.id);
    let loaded = await store.get(id);
    if (!loaded.valid || !loaded.frontmatter) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    if (loaded.frontmatter.revision !== expectedRevision(request)) throw new HttpError(409, "Ticket revision changed", loaded);
    if (loaded.frontmatter.jira && !isProgressed(loaded.frontmatter)) {
      const config = await configStore.read();
      const remote = await jiraClient.issue(config.jira, loaded.frontmatter.jira.key);
      loaded = await store.command(id, { event: "jira.resynced", message: `Pending ticket refreshed from ${remote.jira.key}.`, expectedRevision: loaded.frontmatter.revision }, (ticket, body) => {
        ticket.title = remote.title; ticket.labels = remote.labels; ticket.jira = remote.jira;
        return { ticket, body: replaceDescription(body, remote.description) };
      });
    }
    const readyTicket = loaded.frontmatter;
    if (!readyTicket) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    const pinned = readyTicket.workflow
      ? (await workflowLibrary.get(activeWorkflowIdentity(readyTicket).id, activeWorkflowIdentity(readyTicket).revision)).definition : null;
    const marked = await store.command(id, { event: "ticket.ready", message: "Ticket marked ready.", expectedRevision: loaded.frontmatter!.revision }, (ticket) => {
      if (ticket.status !== "pending") throw new HttpError(409, "Only pending tickets can be marked ready");
      if (pinned && ticket.workflow) {
        const firstVisit = (ticket.workflow.node_visits[ticket.workflow.current_node] ?? 0) === 0;
        enterCurrentNode(ticket, pinned, firstVisit);
      }
      else ticket.status = "ready";
      return { ticket };
    });
    response.json(ticketJson(await store.settleAutomatic(marked.frontmatter!.id)));
  });

  app.post("/api/tickets/:id/priority", async (request, response) => {
    const priority = request.body?.priority;
    if (!Number.isInteger(priority)) throw new HttpError(422, "priority must be an integer");
    response.json(ticketJson(await store.command(
      String(request.params.id),
      { event: "ticket.priority_changed", message: `Ticket priority changed to P${priority}.`, expectedRevision: expectedRevision(request) },
      (ticket) => { ticket.priority = Number(priority); return { ticket }; },
    )));
  });

  app.post("/api/tickets/:id/draft", async (request, response) => {
    response.json(ticketJson(await store.command(
      String(request.params.id),
      { event: "ticket.returned_to_draft", message: "Ready ticket returned to draft.", expectedRevision: expectedRevision(request) },
      (ticket) => {
        if (ticket.status !== "ready" || ticket.execution) throw new HttpError(409, "Only an unclaimed ready ticket can be returned to draft");
        ticket.status = "pending";
        return { ticket };
      },
    )));
  });

  app.post("/api/tickets/:id/decide", async (request, response) => {
    const id = String(request.params.id);
    const loaded = await store.get(id);
    if (!loaded.valid || !loaded.frontmatter?.workflow) throw new HttpError(409, "Ticket does not have a V3 workflow");
    const definition = (await workflowLibrary.get(activeWorkflowIdentity(loaded.frontmatter).id, activeWorkflowIdentity(loaded.frontmatter).revision)).definition;
    const current = workflowNode(definition, loaded.frontmatter.workflow.current_node);
    if (current.type !== "human_gate" || loaded.frontmatter.status !== "waiting_approval") throw new HttpError(409, "Ticket is not waiting at a human gate");
    const decision = message(request.body?.decision, "decision");
    const choice = current.choices.find((candidate) => candidate.id === decision);
    if (!choice) throw new HttpError(422, `Decision ${decision} is not allowed`, { allowed: current.choices.map((candidate) => candidate.id) });
    const note = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    if (choice.comment_required && !note) throw new HttpError(422, `${choice.label} requires a comment`);
    const summary = note || choice.label;
    response.json(ticketJson(await store.command(id, { event: "gate.decided", message: `${current.name}: ${summary}`, expectedRevision: expectedRevision(request) }, (ticket) => {
      const now = new Date().toISOString();
      const run = beginNodeRun(ticket, current, activeWorkflowIdentity(ticket).revision, ticket.workflow!.node_visits[runtimeNodeKey(ticket, current.id)] ?? 1, ticket.workflow!.current_node_entered_at ?? now, "human", null);
      finishNodeRun(ticket, run.id, decision, summary, null, now, note || null);
      advanceWorkflow(ticket, definition, decision, summary, note || null, "human");
      return { ticket };
    })));
  });

  app.post("/api/tickets/:id/workflow/clone", async (request, response) => {
    const id = String(request.params.id);
    const loaded = await store.get(id);
    if (!loaded.valid || !loaded.frontmatter?.workflow) throw new HttpError(409, "Ticket does not have a V3 workflow");
    if (loaded.frontmatter.status !== "pending" || loaded.frontmatter.execution) throw new HttpError(409, "Customize a ticket workflow before marking the ticket ready");
    const source = await workflowLibrary.get(activeWorkflowIdentity(loaded.frontmatter).id, activeWorkflowIdentity(loaded.frontmatter).revision);
    const artifactId = `ticket-${loaded.frontmatter.id.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}`.slice(0, 64);
    const definition = structuredClone(source.definition);
    definition.id = artifactId; definition.name = `${loaded.frontmatter.title} workflow`;
    const custom = await workflowLibrary.save(stringifyYaml(definition, { lineWidth: 0 }), undefined, new Set((await promptLibrary.list()).filter((prompt) => prompt.valid).map((prompt) => prompt.name)));
    const artifacts = await workflowArtifacts(custom);
    const updated = await store.command(id, { event: "workflow.customized", message: `Ticket pinned to ${custom.definition.id}@${custom.revision.slice(0, 12)}.`, expectedRevision: expectedRevision(request) }, (ticket) => {
      initializeWorkflow(ticket, custom, artifacts.promptRevisions, {
        workflow_revisions: artifacts.revisions,
        resolved_agent_profiles: artifacts.profiles,
      });
      ticket.status = "pending";
      return { ticket };
    });
    store.emit("changed", { type: "workflows.changed", id: custom.definition.id, revision: custom.revision });
    response.json(await workJson(updated));
  });

  app.post("/api/tickets/:id/workflow/migrate", async (request, response) => {
    const id = String(request.params.id);
    const loaded = await store.get(id);
    if (!loaded.valid || !loaded.frontmatter) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    if (!loaded.frontmatter.execution && !["pending", "blocked", "waiting_approval", "waiting_external", "failed", "completed"].includes(loaded.frontmatter.status)) throw new HttpError(409, "Pause the ticket before migrating its workflow");
    const assigned = await workflowLibrary.assignment(
      message(request.body?.workflow_id, "workflow_id"),
      typeof request.body?.workflow_revision === "string" ? request.body.workflow_revision : undefined,
    );
    const target = assigned.document;
    const artifacts = await workflowArtifacts(target);
    const targetNode = typeof request.body?.node_id === "string" ? request.body.node_id : target.definition.start;
    const targetNodeDefinition = workflowNode(target.definition, targetNode);
    if (targetNodeDefinition.phase === "done") throw new HttpError(422, "Migrate work to a non-terminal node");
    const updated = await store.command(id, { event: "workflow.migrated", message: `Ticket explicitly migrated to ${target.definition.id}@${target.revision.slice(0, 12)} node ${targetNode}.`, expectedRevision: expectedRevision(request) }, (ticket) => {
      if (ticket.execution) {
        if (ticket.execution.interrupt_request) throw new HttpError(409, "Ticket is already waiting for agent interruption");
        ticket.execution.interrupt_request = {
          target_phase: targetNodeDefinition.phase as Exclude<Phase, "done">,
          target_node: targetNode,
          target_workflow_id: target.definition.id,
          target_workflow_revision: target.revision,
          requested_at: new Date().toISOString(),
        };
        return { ticket };
      }
      const samePinnedWorkflow = ticket.workflow?.id === target.definition.id && ticket.workflow.revision === target.revision;
      const sourceNode = ticket.workflow?.current_node ?? "operator";
      if (samePinnedWorkflow) {
        ticket.workflow!.stage_enabled[targetNodeDefinition.stage] = true;
        transitionTo(ticket, target.definition, targetNode, { outcome: "operator_migration", summary: `Operator migrated work to ${targetNode}.`, actor: "operator" });
      } else {
        const priorRuns = ticket.workflow?.node_runs ?? [];
        initializeWorkflow(ticket, target, artifacts.promptRevisions, {
          workflow_revisions: artifacts.revisions,
          resolved_agent_profiles: artifacts.profiles,
        });
        ticket.workflow!.node_runs = priorRuns;
        transitionTo(ticket, target.definition, targetNode, { outcome: "operator_migration", summary: `Operator migrated work to ${targetNode}.`, actor: "operator", source_node: sourceNode });
      }
      ticket.archived_at = null;
      return { ticket };
    });
    response.json(await workJson(updated));
  });

  app.post("/api/tickets/:id/guidance", async (request, response) => {
    const guidance = message(request.body?.message);
    response.json(ticketJson(await store.command(
      String(request.params.id), { event: "human.guidance", message: guidance, expectedRevision: expectedRevision(request) },
      (ticket) => {
        if (ticket.execution) {
          ticket.execution.guidance.push({
            id: `guidance-${randomUUID()}`, sequence: ticket.event_sequence + 1, message: guidance,
            created_at: new Date().toISOString(), delivered_at: null,
          });
          if (ticket.status === "blocked" && !ticket.questions.some((item) => item.answer === null)) ticket.status = "running";
        }
        return { ticket };
      },
    )));
  });

  app.post("/api/tickets/:id/comment", async (request, response) => {
    const comment = message(request.body?.message);
    response.json(ticketJson(await store.command(
      String(request.params.id), { event: "human.commented", message: comment, expectedRevision: expectedRevision(request) },
      (ticket) => ({ ticket }),
    )));
  });

  app.post("/api/tickets/:id/questions/:questionId/answer", async (request, response) => {
    const answer = message(request.body?.answer, "answer");
    const questionId = String(request.params.questionId);
    response.json(ticketJson(await store.command(String(request.params.id), {
      event: "human.answered", message: answer, expectedRevision: expectedRevision(request),
    }, (ticket) => {
      const question = ticket.questions.find((item) => item.id === questionId);
      if (!question) throw new HttpError(404, `Question ${questionId} not found`);
      if (question.answer) throw new HttpError(409, "Question is already answered");
      question.answer = answer; question.answered_at = new Date().toISOString();
      if (ticket.execution) {
        ticket.execution.guidance.push({
          id: `guidance-${randomUUID()}`, sequence: ticket.event_sequence + 1,
          message: `Answer to your question \"${question.question}\": ${answer}`,
          created_at: new Date().toISOString(), delivered_at: null,
        });
        ticket.status = ticket.questions.some((item) => item.answer === null) ? "blocked" : "running";
      }
      return { ticket };
    })));
  });

  app.post("/api/tickets/:id/jira/export", async (request, response) => {
    const id = String(request.params.id);
    const loaded = await store.get(id);
    if (!loaded.valid || !loaded.frontmatter) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    if (loaded.frontmatter.jira) throw new HttpError(409, "Ticket is already associated with Jira");
    const config = await configStore.read();
    const jira = await jiraClient.create(config.jira, loaded.frontmatter, descriptionOnly(loaded.body));
    response.json(ticketJson(await store.command(id, { event: "jira.exported", message: `Created Jira issue ${jira.key}.`, expectedRevision: loaded.frontmatter.revision }, (ticket) => {
      ticket.jira = jira; return { ticket };
    })));
  });

  app.post("/api/tickets/:id/jira/resync", async (request, response) => {
    const id = String(request.params.id);
    const loaded = await store.get(id);
    if (!loaded.valid || !loaded.frontmatter) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    if (loaded.frontmatter.status !== "pending" || isProgressed(loaded.frontmatter) || !loaded.frontmatter.jira) {
      throw new HttpError(409, "Only an initial pending Jira-backed ticket can be resynced");
    }
    const config = await configStore.read();
    const remote = await jiraClient.issue(config.jira, loaded.frontmatter.jira.key);
    response.json(ticketJson(await store.command(id, { event: "jira.resynced", message: `Pending ticket refreshed from ${remote.jira.key}.`, expectedRevision: expectedRevision(request) }, (ticket, body) => {
      ticket.title = remote.title; ticket.labels = remote.labels; ticket.jira = remote.jira;
      return { ticket, body: replaceDescription(body, remote.description) };
    })));
  });

  app.post("/api/tickets/:id/check-pull-requests", async (request, response) => response.json(await githubObserver.checkTicket(String(request.params.id))));

  app.post("/api/tickets/:id/archive", async (request, response) => response.json(ticketJson(await store.command(
    String(request.params.id), { event: "ticket.archived", message: "Completed ticket archived.", expectedRevision: expectedRevision(request) },
    (ticket) => {
      if (ticket.phase !== "done" || ticket.status !== "completed") throw new HttpError(409, "Only completed tickets can be archived");
      if (request.body?.production_result !== undefined) {
        ticket.production_result = productionResult(request.body.production_result);
        ticket.production_assessed_at = ticket.production_result === "unassessed" ? null : new Date().toISOString();
        ticket.production_assessment_note = typeof request.body.production_assessment_note === "string" && request.body.production_assessment_note.trim()
          ? request.body.production_assessment_note.trim() : null;
      }
      ticket.archived_at = new Date().toISOString(); return { ticket };
    },
  ))));
  app.post("/api/tickets/:id/unarchive", async (request, response) => response.json(ticketJson(await store.command(
    String(request.params.id), { event: "ticket.unarchived", message: "Ticket returned to the completed queue.", expectedRevision: expectedRevision(request) },
    (ticket) => { if (!ticket.archived_at) throw new HttpError(409, "Ticket is not archived"); ticket.archived_at = null; return { ticket }; },
  ))));
  app.post("/api/tickets/:id/production-assessment", async (request, response) => {
    const result = productionResult(request.body?.production_result);
    const note = typeof request.body?.production_assessment_note === "string" && request.body.production_assessment_note.trim()
      ? request.body.production_assessment_note.trim() : null;
    response.json(ticketJson(await store.command(
      String(request.params.id), {
        event: "ticket.production_assessed", message: `Production result set to ${result}.`, expectedRevision: expectedRevision(request),
      },
      (ticket) => {
        if (ticket.phase !== "done" || ticket.status !== "completed") throw new HttpError(409, "Only completed tickets can be assessed for production");
        ticket.production_result = result;
        ticket.production_assessed_at = result === "unassessed" ? null : new Date().toISOString();
        ticket.production_assessment_note = note;
        return { ticket };
      },
    )));
  });

  app.post("/api/tickets/:id/human-estimate", async (request, response) => {
    const value = request.body?.estimated_human_days;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new HttpError(422, "estimated_human_days must be a non-negative number or null");
    }
    response.json(ticketJson(await store.command(
      String(request.params.id), {
        event: "ticket.human_estimate_updated", message: value === null ? "Estimated human effort cleared." : `Estimated human effort set to ${value} day(s).`, expectedRevision: expectedRevision(request),
      },
      (ticket) => { ticket.estimated_human_days = value === null ? null : Number(value); return { ticket }; },
    )));
  });

  app.post("/api/tickets/:id/retry", async (request, response) => {
    const id = String(request.params.id);
    const loaded = await store.get(id);
    const definition = loaded.frontmatter?.workflow
      ? (await workflowLibrary.get(activeWorkflowIdentity(loaded.frontmatter).id, activeWorkflowIdentity(loaded.frontmatter).revision)).definition : null;
    response.json(ticketJson(await store.command(
      id, { event: "ticket.retried", message: "Current workflow node returned to ready.", expectedRevision: expectedRevision(request) },
      (ticket) => {
      if (ticket.status !== "failed" && ticket.status !== "blocked") throw new HttpError(409, "Only failed or needs-attention tickets can be retried");
      if (ticket.execution) throw new HttpError(409, "Cannot retry while an execution is active");
      if (ticket.phase === "done") throw new HttpError(409, "Completed tickets must be reopened");
      if (ticket.questions.some((item) => item.answer === null)) throw new HttpError(409, "Answer outstanding agent questions before retrying work");
      if (definition && ticket.workflow) {
        const node = workflowNode(definition, ticket.workflow.current_node);
        if (ticket.workflow.transition_count > definition.max_transitions) throw new HttpError(409, "Workflow transition limit requires migration to another node or workflow");
        if (node.max_visits && (ticket.workflow.node_visits[runtimeNodeKey(ticket, node.id)] ?? 0) > node.max_visits) throw new HttpError(409, `Node ${node.name} exceeded its visit limit; migrate the ticket before retrying`);
        nodeAttemptCounter(ticket, node.id).consecutive_lease_losses = 0;
        enterCurrentNode(ticket, definition, false);
      } else throw new HttpError(409, "Ticket does not have a pinned workflow");
      return { ticket };
      },
    )));
  });

  app.post("/api/tickets/:id/release-supervisor", async (request, response) => {
    const id = String(request.params.id);
    const loaded = await store.get(id);
    const definition = loaded.frontmatter?.workflow
      ? (await workflowLibrary.get(activeWorkflowIdentity(loaded.frontmatter).id, activeWorkflowIdentity(loaded.frontmatter).revision)).definition : null;
    response.json(ticketJson(await store.command(
      id, { event: "supervisor.released", message: "Pinned supervisor released by operator; eligible work may be reassigned.", expectedRevision: expectedRevision(request) },
      (ticket) => {
      if (!ticket.assigned_supervisor) throw new HttpError(409, "Ticket is not assigned to a supervisor");
      if (ticket.execution) throw new HttpError(409, "Interrupt active work before releasing its supervisor");
      if (ticket.status === "completed" || ticket.status === "cancelled") throw new HttpError(409, "Terminal tickets do not need reassignment");
      ticket.assigned_supervisor = null;
      ticket.assigned_supervisor_host = null;
      ticket.conversations = {};
      if ((ticket.status === "failed" || ticket.status === "blocked") && ticket.phase !== "done") {
        const node = definition && ticket.workflow ? workflowNode(definition, ticket.workflow.current_node) : null;
        const bounded = Boolean(definition && ticket.workflow && (ticket.workflow.transition_count > definition.max_transitions
          || node?.max_visits && (ticket.workflow.node_visits[runtimeNodeKey(ticket, node.id)] ?? 0) > node.max_visits));
        if (!bounded && !ticket.questions.some((item) => item.answer === null)) {
          ticket.status = "ready";
          if (node) nodeAttemptCounter(ticket, node.id).consecutive_lease_losses = 0;
        }
      }
      return { ticket };
      },
    )));
  });

  app.post("/api/tickets/:id/conversations/:key/reset", async (request, response) => {
    const key = String(request.params.key);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new HttpError(422, "Conversation key is invalid");
    response.json(ticketJson(await store.command(
      String(request.params.id), { event: "conversation.reset", message: `Conversation ${key} will start a fresh generation.`, expectedRevision: expectedRevision(request) },
      (ticket) => {
        if (ticket.execution) throw new HttpError(409, "Interrupt active work before resetting its conversation");
        const current = ticket.conversations?.[key];
        if (!current) throw new HttpError(404, `Conversation ${key} has not started`);
        current.generation += 1;
        current.herdr_pane_id = null;
        current.session_ref = null;
        current.visits_in_generation = 0;
        current.last_visit_key = null;
        current.reset_reason = "operator";
        return { ticket };
      },
    )));
  });

  app.post("/api/tickets/:id/wake", async (request, response) => {
    const id = String(request.params.id);
    const updated = await store.command(
      id, { event: "wait.woken", message: "External wait was released early by the operator.", expectedRevision: expectedRevision(request) },
      (ticket) => {
        if (ticket.execution) throw new HttpError(409, "Cannot wake an active execution");
        if (ticket.status !== "waiting_external" || !ticket.workflow) throw new HttpError(409, "Ticket is not waiting for an external retry");
        const key = runtimeNodeKey(ticket, ticket.workflow.current_node);
        const wait = ticket.workflow.wait_states?.[key];
        if (!wait) throw new HttpError(409, "Current external wait has no durable timer");
        const now = new Date().toISOString();
        wait.wake_at = now;
        const run = ticket.workflow.node_runs.find((candidate) => candidate.id === wait.node_run_id);
        if (run?.wait) run.wait.wake_at = now;
        return { ticket };
      },
    );
    await store.settleAutomatic(id);
    response.json(ticketJson(await store.get(updated.frontmatter!.id)));
  });

  for (const action of ["cancel", "fail"] as const) {
    app.post(`/api/tickets/:id/${action}`, async (request, response) => {
      const pastTense = action === "cancel" ? "cancelled" : "failed";
      const reason = typeof request.body?.message === "string" ? request.body.message.trim() : `Ticket ${pastTense} by operator.`;
      const current = await store.get(String(request.params.id));
      const interruptionRequired = Boolean(current.frontmatter?.execution);
      response.json(ticketJson(await store.command(
        String(request.params.id), {
          event: interruptionRequired ? `ticket.${action}_requested` : `ticket.${pastTense}`,
          message: interruptionRequired ? `${reason || `Ticket ${pastTense} by operator.`} Waiting for active execution to stop.` : reason || `Ticket ${pastTense} by operator.`,
          expectedRevision: expectedRevision(request),
        },
        (ticket) => {
          if (ticket.execution) {
            if (ticket.execution.interrupt_request) throw new HttpError(409, "Ticket is already waiting for execution interruption");
            ticket.execution.interrupt_request = {
              target_phase: ticket.phase as Exclude<Phase, "done">, requested_at: new Date().toISOString(),
              terminal_status: pastTense, terminal_reason: reason || `Ticket ${pastTense} by operator.`,
            };
          } else ticket.status = pastTense;
          return { ticket };
        },
      )));
    });
  }

  app.post("/api/work/claim", async (request, response) => {
    const provider = request.body?.provider;
    if (!PROVIDERS.includes(provider)) throw new HttpError(422, "provider must be claude or codex");
    const advertised = request.body?.available_providers;
    const availableProviders = advertised === undefined ? [...PROVIDERS] : Array.isArray(advertised)
      && advertised.every((item) => PROVIDERS.includes(item)) ? [...new Set(advertised)] : null;
    if (!availableProviders || !availableProviders.includes(provider)) {
      throw new HttpError(422, "available_providers must be a provider array containing the claiming provider");
    }
    const supervisor = message(request.body?.supervisor_id, "supervisor_id");
    if (typeof request.body?.instance_id === "string") registry.assertInstance(supervisor, request.body.instance_id);
    const supervisorHost = registry.hostnameFor(supervisor) ?? supervisor;
    const claimed = await store.claim(supervisor, provider, availableProviders, supervisorHost, activityCapabilities(request.body?.activity_capabilities));
    if (!claimed) { response.status(204).end(); return; }
    log("info", "work.claimed", { ticket_id: claimed.frontmatter?.id, node_id: claimed.frontmatter?.workflow?.current_node, lease_id: claimed.frontmatter?.execution?.lease_id, supervisor_id: supervisor, provider });
    response.json(await workJson(claimed));
  });

  app.post("/api/work/claim-activity", async (request, response) => {
    const supervisor = message(request.body?.supervisor_id, "supervisor_id");
    const advertised = request.body?.available_providers;
    const availableProviders = advertised === undefined ? [...PROVIDERS] : Array.isArray(advertised)
      && advertised.every((item) => PROVIDERS.includes(item)) ? [...new Set(advertised)] : null;
    if (!availableProviders) throw new HttpError(422, "available_providers must be a provider array");
    if (typeof request.body?.instance_id === "string") registry.assertInstance(supervisor, request.body.instance_id);
    const supervisorHost = registry.hostnameFor(supervisor) ?? supervisor;
    const claimed = await store.claimActivity(supervisor, availableProviders, supervisorHost, activityCapabilities(request.body?.activity_capabilities));
    if (!claimed) { response.status(204).end(); return; }
    log("info", "work.claimed", { ticket_id: claimed.frontmatter?.id, node_id: claimed.frontmatter?.workflow?.current_node, lease_id: claimed.frontmatter?.execution?.lease_id, supervisor_id: supervisor, node_type: claimed.frontmatter?.execution?.node_type });
    response.json(await workJson(claimed));
  });

  app.get("/api/work/active", async (request, response) => {
    const supervisor = message(request.query.supervisor_id, "supervisor_id");
    const provider = typeof request.query.provider === "string" ? request.query.provider : undefined;
    if (provider !== undefined && !PROVIDERS.some((candidate) => candidate === provider)) throw new HttpError(422, "provider must be claude or codex");
    const active = (await store.list()).filter((ticket) => ticket.valid && ticket.frontmatter?.execution?.supervisor_id === supervisor
      && (provider === undefined || (ticket.frontmatter.execution.provider === provider
        && !["script", "checkpoint", "restore_checkpoint"].includes(ticket.frontmatter.execution.node_type ?? ""))));
    response.json({ tickets: await Promise.all(active.map(workJson)) });
  });

  app.get("/api/work/:lease/assignment", async (request, response) => {
    response.json(await workJson(await store.byLease(String(request.params.lease))));
  });

  app.post("/api/work/:lease/heartbeat", async (request, response) => {
    const leaseId = String(request.params.lease);
    const leased = await store.byLease(leaseId);
    const supervisorHost = registry.hostnameFor(leased.execution.supervisor_id);
    const herdr = heartbeatHerdr(request.body?.herdr_observation);
    const pricing = (await configStore.read()).pricing;
    let telemetry: HarnessTelemetrySnapshot | undefined;
    let telemetryBaseline: HarnessTelemetrySnapshot | undefined;
    try {
      telemetry = estimateTelemetryCost(heartbeatTelemetry(request.body?.telemetry, "telemetry"), pricing);
      telemetryBaseline = estimateTelemetryCost(heartbeatTelemetry(request.body?.telemetry_baseline, "telemetry_baseline"), pricing);
    } catch (error) {
      log("warn", "work.heartbeat_telemetry_ignored", {
        ticket_id: leased.frontmatter.id, node_id: leased.execution.node_id, lease_id: leaseId,
        error: error instanceof Error ? error.message : String(error),
        details: error instanceof HttpError ? error.details : undefined,
      });
    }
    const updated = await store.heartbeat(leaseId, {
      ...(supervisorHost ? { supervisorHost } : {}),
      ...(typeof request.body?.observed_state === "string" ? { state: request.body.observed_state } : {}),
      ...(typeof request.body?.pane_id === "string" ? { paneId: request.body.pane_id } : {}),
      ...(typeof request.body?.session_ref === "string" ? { sessionRef: request.body.session_ref } : {}),
      ...(Number.isInteger(request.body?.guidance_cursor) ? { guidanceCursor: Number(request.body.guidance_cursor) } : {}),
      ...(herdr ? { herdr } : {}),
      ...(telemetry ? { telemetry } : {}),
      ...(telemetryBaseline ? { telemetryBaseline } : {}),
    });
    response.json({ active: true, ticket: ticketJson(updated) });
  });

  app.post("/api/work/:lease/trace/events", async (request, response) => {
    const traceId = typeof request.body?.trace_id === "string" ? request.body.trace_id : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId)) {
      throw new HttpError(422, "trace_id must be a UUID", undefined, "EXECUTION_TRACE_INVALID");
    }
    const firstSequence = request.body?.first_sequence;
    if (!Number.isSafeInteger(firstSequence) || Number(firstSequence) < 1) throw new HttpError(422, "first_sequence must be a positive integer", undefined, "EXECUTION_TRACE_INVALID");
    if (Buffer.byteLength(JSON.stringify(request.body ?? {})) > 262_144) throw new HttpError(413, "Trace batch must not exceed 256 KiB", undefined, "EXECUTION_TRACE_TOO_LARGE");
    const events = executionTraceEvents(request.body?.events, Number(firstSequence));
    const result = await store.appendExecutionTrace(String(request.params.lease), traceId, Number(firstSequence), events, request.body?.completed === true);
    response.status(201).json(result);
  });

  app.post("/api/work/:lease/session-evidence", express.raw({ type: "application/octet-stream", limit: MAX_ARTIFACT_BYTES }), async (request, response) => {
    const kind = String(request.query.kind ?? "");
    if (kind !== "agent_transcript" && kind !== "harness_session_log") throw new HttpError(422, "Unsupported session evidence kind", undefined, "SESSION_EVIDENCE_INVALID");
    if (!Buffer.isBuffer(request.body)) throw new HttpError(422, "Session evidence body must be application/octet-stream", undefined, "SESSION_EVIDENCE_INVALID");
    const source = String(request.query.source ?? "");
    if (source !== "herdr" && source !== "harness") throw new HttpError(422, "Session evidence source must be herdr or harness", undefined, "SESSION_EVIDENCE_INVALID");
    const completeness = String(request.query.completeness ?? "");
    if (!["full", "bounded", "partial"].includes(completeness)) throw new HttpError(422, "Session evidence completeness must be full, bounded, or partial", undefined, "SESSION_EVIDENCE_INVALID");
    const disposition = message(request.query.disposition, "disposition");
    const provider = optionalString(request.query.provider);
    if (provider !== null && !PROVIDERS.includes(provider as typeof PROVIDERS[number])) throw new HttpError(422, "Session evidence provider is invalid", undefined, "SESSION_EVIDENCE_INVALID");
    const lineCount = request.query.line_count === undefined ? null : Number(request.query.line_count);
    if (lineCount !== null && (!Number.isSafeInteger(lineCount) || lineCount < 0)) throw new HttpError(422, "line_count must be a non-negative integer", undefined, "SESSION_EVIDENCE_INVALID");
    const presentation = {
      title: kind === "agent_transcript" ? "Agent session transcript" : `${provider ? provider[0]!.toUpperCase() + provider.slice(1) : "Harness"} native session log`,
      description: `${completeness === "full" ? "Complete" : completeness === "bounded" ? "Bounded" : "Partial"} ${source} capture at ${disposition}.`,
      category: "provenance",
    };
    const metadata: Record<string, JsonValue> = {
      schema_version: 1, source, completeness, disposition,
      captured_at: new Date().toISOString(), presentation,
      evidence_key: String(request.query.evidence_key ?? `${source}:${disposition}`),
      ...(provider ? { provider } : {}),
      ...(optionalString(request.query.pane_id) ? { pane_id: optionalString(request.query.pane_id)! } : {}),
      ...(optionalString(request.query.session_ref) ? { session_ref: optionalString(request.query.session_ref)! } : {}),
      ...(optionalString(request.query.role) ? { role: optionalString(request.query.role)! } : {}),
      ...(optionalString(request.query.original_filename) ? { original_filename: optionalString(request.query.original_filename)! } : {}),
      ...(lineCount !== null ? { line_count: lineCount } : {}),
    };
    const artifact = await store.addAgentSessionEvidence(String(request.params.lease), {
      kind, filename: String(request.query.filename ?? ""), contentType: String(request.query.content_type ?? "application/octet-stream"),
      content: request.body, metadata,
    });
    response.status(201).json({ artifact });
  });

  app.post("/api/work/:lease/delivered", async (request, response) => {
    const leaseId = String(request.params.lease);
    const confirmation = request.body?.confirmation === "observed_activity" || request.body?.confirmation === "submitted_staged_prompt"
      ? request.body.confirmation : "direct";
    const updated = await store.confirmAssignmentDelivery(leaseId, confirmation);
    log("info", "work.assignment_delivered", {
      ticket_id: updated.frontmatter?.id, node_id: updated.frontmatter?.execution?.node_id, lease_id: leaseId, confirmation,
    });
    response.json({ delivered: true, ticket: ticketJson(updated) });
  });

  app.post("/api/work/:lease/delivery-failed", async (request, response) => {
    const leaseId = String(request.params.lease);
    const updated = await store.rejectAssignmentDelivery(leaseId, message(request.body?.reason, "reason"));
    log("warn", "work.assignment_delivery_failed", {
      ticket_id: updated.frontmatter?.id, node_id: updated.frontmatter?.workflow?.current_node, lease_id: leaseId,
      disposition: updated.frontmatter?.status === "blocked" ? "blocked" : "requeued",
    });
    response.json({ requeued: updated.frontmatter?.status === "ready", blocked: updated.frontmatter?.status === "blocked", ticket: ticketJson(updated) });
  });

  app.post("/api/work/:lease/telemetry", async (request, response) => {
    const pricing = (await configStore.read()).pricing;
    const telemetry = estimateTelemetryCost(heartbeatTelemetry(request.body?.telemetry, "telemetry"), pricing);
    if (!telemetry) throw new HttpError(422, "telemetry is required");
    const baseline = estimateTelemetryCost(heartbeatTelemetry(request.body?.telemetry_baseline, "telemetry_baseline"), pricing);
    const updated = await store.recordTelemetry(String(request.params.lease), telemetry, baseline);
    response.json({ recorded: true, ticket: ticketJson(updated) });
  });

  app.post("/api/work/:lease/finalize", async (request, response) => {
    const runtime = jsonPayload(request.body?.runtime ?? {}, "runtime");
    if (Buffer.byteLength(JSON.stringify(runtime)) > 262_144) throw new HttpError(422, "runtime provenance must not exceed 256 KiB");
    const artifact = await store.finalizeExecutionManifest(String(request.params.lease), runtime);
    response.json({ finalized: true, artifact });
  });

  app.get("/api/work/:lease/guidance", async (request, response) => {
    const leased = await store.byLease(String(request.params.lease));
    const after = Number(request.query.after ?? 0);
    response.json({ guidance: leased.execution.guidance.filter((item) => item.sequence > after) });
  });
  app.get("/api/work/:lease/metadata", async (request, response) => {
    const leased = await store.byLease(String(request.params.lease));
    response.json({ metadata: leased.frontmatter.metadata ?? {} });
  });
  app.get("/api/work/:lease/metadata/:key", async (request, response) => {
    const leased = await store.byLease(String(request.params.lease));
    const key = metadataKey(request.params.key);
    response.json({ key, value: leased.frontmatter.metadata?.[key] ?? null, exists: Object.hasOwn(leased.frontmatter.metadata ?? {}, key) });
  });
  app.put("/api/work/:lease/metadata/:key", async (request, response) => {
    const lease = String(request.params.lease);
    const leased = await store.byLease(lease);
    const key = metadataKey(request.params.key);
    if (!("value" in (request.body ?? {})) || request.body.value === undefined) throw new HttpError(422, "value is required and must be JSON-compatible");
    const updated = await store.command(leased.frontmatter.id, { event: "agent.metadata_written", message: `Agent updated metadata ${key}.` }, (ticket) => {
      if (ticket.execution?.lease_id !== lease) throw new HttpError(409, "Lease is stale or fenced");
      ticket.metadata ??= {}; ticket.metadata[key] = request.body.value as JsonValue; return { ticket };
    });
    response.json({ key, value: updated.frontmatter?.metadata?.[key] ?? null });
  });

  app.get("/api/work/:lease/control", async (request, response) => {
    const leased = await store.byLease(String(request.params.lease));
    response.json({
      interrupt: leased.execution.interrupt_request,
      waiting_for_answer: leased.frontmatter.questions.some((item) => item.answer === null),
    });
  });

  app.post("/api/work/:lease/interrupt-ack", async (request, response) => {
    const leaseId = String(request.params.lease);
    const leased = await store.byLease(leaseId);
    const pendingInterrupt = leased.execution.interrupt_request;
    const migrationTarget = pendingInterrupt?.target_workflow_id && pendingInterrupt.target_workflow_revision
      ? await workflowLibrary.get(pendingInterrupt.target_workflow_id, pendingInterrupt.target_workflow_revision) : null;
    const migrationArtifacts = migrationTarget ? await workflowArtifacts(migrationTarget) : null;
    response.json(ticketJson(await store.command(
      leased.frontmatter.id,
      {
        event: "work.interrupted",
        message: pendingInterrupt?.terminal_status
          ? `Active execution interrupted; ticket ${pendingInterrupt.terminal_status}.`
          : "Active execution interrupted; requested workflow node is ready.",
      },
      (ticket) => {
        if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced");
        const interrupt = ticket.execution.interrupt_request;
        if (!interrupt) throw new HttpError(409, "No agent interruption is pending");
        const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === ticket.execution?.node_run_id);
        const interruptionOutcome = interrupt.terminal_status ? `operator_${interrupt.terminal_status}` : "operator_interrupt";
        const interruptionSummary = interrupt.terminal_reason ?? "Active node interrupted by operator.";
        if (run?.status === "running") { const now = new Date().toISOString(); accountNodeRunTiming(run, now); run.status = "interrupted"; run.completed_at = now; run.outcome = interruptionOutcome; run.summary = interruptionSummary; }
        if (interrupt.terminal_status) {
          ticket.status = interrupt.terminal_status;
        } else if (migrationTarget && interrupt.target_node) {
          const samePinnedWorkflow = ticket.workflow?.id === migrationTarget.definition.id && ticket.workflow.revision === migrationTarget.revision;
          if (samePinnedWorkflow) {
            const target = workflowNode(migrationTarget.definition, interrupt.target_node);
            ticket.workflow!.stage_enabled[target.stage] = true;
            transitionTo(ticket, migrationTarget.definition, interrupt.target_node, { outcome: "operator_interrupt", summary: "Active node interrupted by operator.", actor: "operator" });
          } else {
            const sourceNode = ticket.workflow?.current_node ?? "operator";
            const priorRuns = ticket.workflow?.node_runs ?? [];
            initializeWorkflow(ticket, migrationTarget, migrationArtifacts!.promptRevisions, {
              workflow_revisions: migrationArtifacts!.revisions,
              resolved_agent_profiles: migrationArtifacts!.profiles,
            });
            ticket.workflow!.node_runs = priorRuns;
            transitionTo(ticket, migrationTarget.definition, interrupt.target_node, { outcome: "operator_interrupt", summary: "Active node interrupted during workflow migration.", actor: "operator", source_node: sourceNode });
          }
        } else {
          ticket.phase = interrupt.target_phase;
          ticket.status = "ready";
        }
        ticket.execution = null;
        return { ticket };
      },
    )));
  });

  app.post("/api/work/:lease/activity-result", async (request, response) => {
    const leaseId = String(request.params.lease);
    const leased = await store.byLease(leaseId);
    if (!leased.frontmatter.workflow || !["script", "checkpoint", "restore_checkpoint"].includes(String(leased.execution.node_type))) {
      throw new HttpError(409, "Lease is not a deterministic activity");
    }
    if (leased.execution.interrupt_request) throw new HttpError(409, "Lease is awaiting activity interruption");
    const identity = activeWorkflowIdentity(leased.frontmatter);
    const definition = (await workflowLibrary.get(identity.id, identity.revision)).definition;
    const node = workflowNode(definition, leased.frontmatter.workflow.current_node);
    const exitCode = Number.isInteger(request.body?.exit_code) ? Number(request.body.exit_code) : null;
    const route = activityRoute(node, exitCode);
    if (!route) throw new HttpError(422, `No exit-code route matched ${exitCode ?? "an execution error"} for ${node.id}`);
    const outcome = route.id;
    const summary = typeof request.body?.summary === "string" && request.body.summary.trim()
      ? request.body.summary.trim() : `${node.name}: ${route.label}.`;
    const stdout = typeof request.body?.stdout === "string" ? request.body.stdout.slice(-1_000_000)
      : typeof request.body?.output === "string" ? request.body.output.slice(-1_000_000) : null;
    const persistStdout = node.script_output?.persist_stdout !== false;
    const outputArtifact = !persistStdout || stdout === null || !leased.execution.node_run_id ? undefined
      : await store.persistNodeRunOutput(leased.frontmatter.id, leased.execution.node_run_id, stdout);
    const tailLines = node.script_output?.prompt_tail_lines ?? 0;
    const promptOutput = stdout && tailLines > 0 ? stdout.split(/\r?\n/).slice(-tailLines).join("\n") : null;
    const output = stdout?.slice(-512) ?? null;
    const outputLogPath = outputArtifact && leased.execution.node_run_id
      ? `/api/tickets/${encodeURIComponent(leased.frontmatter.id)}/runs/${encodeURIComponent(leased.execution.node_run_id)}/output`
      : null;
    const scriptPath = typeof request.body?.script_path === "string" && request.body.script_path.trim()
      ? request.body.script_path.trim() : null;
    const workingDirectory = typeof request.body?.working_directory === "string" && request.body.working_directory.trim()
      ? request.body.working_directory.trim() : null;
    const structuredResult = request.body?.structured_result === undefined ? null
      : isRecord(request.body.structured_result) ? request.body.structured_result
        : (() => { throw new HttpError(422, "structured_result must be an object"); })();
    const metadataWrites: Record<string, JsonValue> = {};
    if (structuredResult?.metadata !== undefined) {
      if (!isRecord(structuredResult.metadata)) throw new HttpError(422, "structured_result.metadata must be an object");
      for (const [key, value] of Object.entries(structuredResult.metadata)) metadataWrites[metadataKey(key)] = jsonPayload(value, `structured_result.metadata.${key}`);
    }
    const externalReferences = structuredResult?.external_references === undefined ? [] : Array.isArray(structuredResult.external_references)
      ? (structuredResult.external_references as unknown[]).map((item: unknown, index: number) => {
        if (!isRecord(item)) throw new HttpError(422, `structured_result.external_references[${index}] must be an object`);
        const type = message(item.type, `structured_result.external_references[${index}].type`);
        const id = message(item.id, `structured_result.external_references[${index}].id`);
        const url = item.url === undefined || item.url === null ? null : message(item.url, `structured_result.external_references[${index}].url`);
        return { type, id, url };
      }) : (() => { throw new HttpError(422, "structured_result.external_references must be an array"); })();
    if (externalReferences.length > 100) throw new HttpError(422, "structured_result may contain at most 100 external references");
    const reportedCheckpoints = Array.isArray(request.body?.checkpoints) ? request.body.checkpoints : [];
    for (const reported of reportedCheckpoints) {
      if (!isRecord(reported) || !Array.isArray(reported.repositories)) throw new HttpError(422, "Checkpoint result is malformed");
      await store.recordCheckpoint(leaseId, {
        id: String(reported.id ?? ""), label: String(reported.label ?? node.name),
        kind: ["workflow", "manual", "pre_restore"].includes(String(reported.kind)) ? reported.kind as "workflow" | "manual" | "pre_restore" : "workflow",
        node_id: node.id, node_run_id: leased.execution.node_run_id ?? null,
        created_at: typeof reported.created_at === "string" ? reported.created_at : new Date().toISOString(),
        repositories: reported.repositories.map((repository) => {
          if (!isRecord(repository)) throw new HttpError(422, "Checkpoint repository is malformed");
          return {
            repository: String(repository.repository ?? ""), head_sha: String(repository.head_sha ?? ""),
            snapshot_sha: String(repository.snapshot_sha ?? ""), branch: typeof repository.branch === "string" ? repository.branch : null,
            remote_url: typeof repository.remote_url === "string" ? repository.remote_url : null,
            dirty: repository.dirty === true, bundle_artifact_id: String(repository.bundle_artifact_id ?? ""),
          };
        }),
      });
    }
    const result = { accepted: true, ticket_id: leased.frontmatter.id, outcome };
    await store.command(leased.frontmatter.id, { event: `activity.${outcome}`, message: summary }, (ticket) => {
      if (ticket.execution?.lease_id !== leaseId || !ticket.execution.node_run_id) throw new HttpError(409, "Lease is stale or fenced");
      if (ticket.execution.interrupt_request) throw new HttpError(409, "Lease is awaiting activity interruption");
      nodeAttemptCounter(ticket, node.id).consecutive_lease_losses = 0;
      finishNodeRun(ticket, ticket.execution.node_run_id, outcome, summary, output, new Date().toISOString(), null, outputArtifact);
      const run = ticket.workflow?.node_runs.find((candidate) => candidate.id === ticket.execution?.node_run_id);
      if (run) {
        run.script_path = scriptPath;
        run.working_directory = workingDirectory;
        run.metadata_writes = structuredClone(metadataWrites);
        run.external_references = structuredClone(externalReferences);
      }
      ticket.metadata ??= {};
      Object.assign(ticket.metadata, structuredClone(metadataWrites));
      if (Buffer.byteLength(JSON.stringify(ticket.metadata)) > 65_536) throw new HttpError(422, "structured result would exceed the 64 KiB ticket metadata limit");
      if (exitCode === 0 && node.type === "checkpoint") delete ticket.metadata?.["checkpoint.request_kind"];
      if (exitCode === 0 && node.type === "restore_checkpoint") delete ticket.metadata?.["checkpoint.restore_id"];
      advanceWorkflow(ticket, definition, outcome, summary, null, node.type, promptOutput, outputLogPath);
      ticket.execution = null;
      ticket.last_callback = { lease_id: leaseId, digest: bodyDigest(request.body), response: result };
      return { ticket };
    });
    await store.settleAutomatic(leased.frontmatter.id);
    log("info", "work.activity_completed", { ticket_id: leased.frontmatter.id, node_id: node.id, lease_id: leaseId, outcome, exit_code: exitCode });
    response.json(result);
  });

  app.post("/api/work/:lease/comment", async (request, response) => {
    const leased = await store.byLease(String(request.params.lease));
    const text = message(request.body?.message);
    response.json(ticketJson(await store.command(leased.frontmatter.id, { event: "agent.commented", message: text }, (ticket) => {
      if (ticket.execution?.lease_id !== String(request.params.lease)) throw new HttpError(409, "Lease is stale or fenced");
      return { ticket };
    })));
  });

  app.post("/api/work/:lease/ask", async (request, response) => {
    const leased = await store.byLease(String(request.params.lease));
    const questions = agentQuestions(request.body);
    const eventMessage = questions.length === 1 ? questions[0]!.question : `${questions.length} questions: ${questions.map((item) => item.question).join(" | ")}`;
    response.json(ticketJson(await store.command(leased.frontmatter.id, { event: "agent.asked", message: eventMessage }, (ticket) => {
      if (ticket.execution?.lease_id !== String(request.params.lease)) throw new HttpError(409, "Lease is stale or fenced");
      if (ticket.execution.interrupt_request) throw new HttpError(409, "Lease is awaiting agent interruption");
      const askedAt = new Date().toISOString();
      ticket.questions.push(...questions.map((question) => ({
        id: `question-${randomUUID()}`, phase: ticket.phase as Exclude<Phase, "done">, question: question.question, options: question.options,
        asked_at: askedAt, answer: null, answered_at: null,
      })));
      ticket.status = "blocked";
      return { ticket };
    })));
  });

  const terminalCallback = async (request: Request, response: Response, kind: "complete" | "fail") => {
    const payloadDigest = bodyDigest(request.body);
    const all = await store.list();
    const leaseId = String(request.params.lease);
    const replay = all.find((item) => item.frontmatter?.last_callback?.lease_id === leaseId)?.frontmatter?.last_callback;
    if (replay) {
      if (replay.digest !== payloadDigest) throw new HttpError(409, "Lease callback payload conflicts with recorded result");
      response.json(replay.response); return;
    }
    const leased = await store.byLease(leaseId);
    const summary = kind === "complete" ? message(request.body?.summary, "summary") : message(request.body?.reason, "reason");
    if (!leased.frontmatter.workflow) throw new HttpError(409, "Ticket does not have a pinned workflow");
    const workflowDefinition = (await workflowLibrary.get(activeWorkflowIdentity(leased.frontmatter).id, activeWorkflowIdentity(leased.frontmatter).revision)).definition;
    const workflowCurrent = workflowNode(workflowDefinition, leased.frontmatter.workflow.current_node);
    if (workflowCurrent.type !== "agent") throw new HttpError(409, "The leased workflow node is not an agent node");
    const requestedOutcome = typeof request.body?.outcome === "string" && request.body.outcome.trim()
      ? request.body.outcome.trim()
      : kind === "fail" ? "failed"
        : "completed";
    const handoff = typeof request.body?.handoff === "string" && request.body.handoff.trim() ? request.body.handoff.trim() : null;
    const result = { accepted: true, ticket_id: leased.frontmatter.id, callback: kind, outcome: requestedOutcome };
    await store.command(leased.frontmatter.id, {
      event: kind === "complete" ? `agent.${leased.frontmatter.phase}_completed` : "agent.failed", message: summary,
    }, (ticket) => {
      if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced");
      if (ticket.execution.interrupt_request) throw new HttpError(409, "Lease is awaiting agent interruption");
      if (ticket.questions.some((item) => item.answer === null)) throw new HttpError(409, "Answer outstanding agent questions before completing the phase");
      if (ticket.workflow) {
        const prs = Array.isArray(request.body?.pull_requests) ? request.body.pull_requests as PullRequestRef[] : [];
        if (prs.length) {
          const phase = ticket.phase === "done" ? undefined : ticket.phase;
          ticket.pull_requests = mergePullRequests(ticket.pull_requests, prs.map((item) => ({
            ...item,
            ...(item.phase ?? phase ? { phase: (item.phase ?? phase)! } : {}),
          })), ticket.repositories.map((item) => item.id));
        }
        const requirement = workflowCurrent.pull_request_requirement;
        if (kind === "complete" && requirement) {
          const relevant = ticket.pull_requests.filter((item) => item.phase === requirement.phase || (requirement.phase === "specification" && item.phase === undefined));
          const primary = ticket.repositories.find((item) => item.primary)?.id;
          if (requirement.scope === "primary" && (!primary || !relevant.some((item) => item.repository === primary))) {
            throw new HttpError(422, `${workflowCurrent.name} completion requires a ${requirement.phase} PR for the primary repository`);
          }
          if (requirement.scope === "any" && relevant.length === 0) {
            throw new HttpError(422, `${workflowCurrent.name} completion requires at least one ${requirement.phase} PR`);
          }
        }
        const runId = ticket.execution.node_run_id;
        if (!runId) throw new HttpError(409, "V3 execution is missing its node-run fence");
        nodeAttemptCounter(ticket, workflowCurrent.id).consecutive_lease_losses = 0;
        finishNodeRun(ticket, runId, String(requestedOutcome), summary, null, new Date().toISOString(), handoff);
        if (workflowRoute(workflowCurrent, String(requestedOutcome))) advanceWorkflow(ticket, workflowDefinition, String(requestedOutcome), summary, handoff, `agent:${ticket.execution.provider}`);
        else if (kind === "fail") ticket.status = "failed";
        else throw new HttpError(422, `Outcome ${String(requestedOutcome)} is not allowed for node ${workflowCurrent.id}`, { allowed: workflowRoutes(workflowCurrent).map((route) => route.id) });
      } else throw new HttpError(409, "Ticket lost its pinned workflow");
      ticket.execution = null;
      ticket.last_callback = { lease_id: leaseId, digest: payloadDigest, response: result };
      return { ticket };
    });
    await store.settleAutomatic(leased.frontmatter.id);
    log("info", "work.agent_callback", { ticket_id: leased.frontmatter.id, node_id: workflowCurrent.id, lease_id: leaseId, callback: kind, outcome: requestedOutcome });
    response.json(result);
  };
  app.post("/api/work/:lease/complete", (request, response, next) => void terminalCallback(request, response, "complete").catch(next));
  app.post("/api/work/:lease/fail", (request, response, next) => void terminalCallback(request, response, "fail").catch(next));

  app.get("/api/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const listener = (event: unknown) => response.write(`event: invalidate\ndata: ${JSON.stringify(event)}\n\n`);
    store.on("changed", listener);
    const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    request.on("close", () => { clearInterval(keepAlive); store.off("changed", listener); });
  });

  if (existsSync(clientDirectory)) {
    app.use(express.static(clientDirectory));
    app.get("/{*path}", (_request, response) => response.sendFile(resolve(clientDirectory, "index.html")));
  }

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof HttpError) { response.status(error.status).json({ code: error.code, error: error.message, details: error.details }); return; }
    log("error", "http.unhandled_error", { method: request.method, path: request.path }, error);
    response.status(500).json({ code: "INTERNAL_ERROR", error: "Internal server error" });
  });
  return app;
}
