import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { HttpError, PHASES, PROVIDERS, type Phase, type PullRequestRef, type TicketFrontmatter } from "./domain.js";
import { TicketStore, mergePullRequests } from "./ticket-store.js";
import { SupervisorRegistry, type SupervisorPresenceInput } from "./supervisor-registry.js";
import { TrackerConfigStore, type RepositoryConfig } from "./config-store.js";
import { parseDocument, serializeDocument } from "./markdown.js";
import { JiraCloudClient } from "./jira.js";
import { GithubObserver } from "./github-observer.js";
import { PromptLibrary } from "./prompt-library.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

function bodyDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

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
  app.get("/api/config", async (_request, response) => response.json({ config: await configStore.read() }));
  app.put("/api/config", async (request, response) => {
    if (!Array.isArray(request.body?.repositories)) throw new HttpError(422, "repositories must be an array");
    if (!Number.isInteger(request.body?.expected_revision)) throw new HttpError(422, "expected_revision must be an integer");
    const current = await configStore.read();
    const config = await configStore.update({
      providers: isRecord(request.body.providers) ? request.body.providers as never : current.providers,
      repositories: request.body.repositories as RepositoryConfig[],
      jira: isRecord(request.body.jira) ? request.body.jira as never : current.jira,
      github: isRecord(request.body.github) ? request.body.github as never : current.github,
    }, Number(request.body.expected_revision));
    store.emit("changed", { type: "config.changed", revision: config.revision });
    response.json({ config });
  });
  app.get("/api/prompts", async (_request, response) => response.json({ prompts: await promptLibrary.list() }));
  app.put("/api/prompts/:name", async (request, response) => {
    const content = message(request.body?.content, "content");
    const revision = message(request.body?.expected_revision, "expected_revision");
    const prompt = await promptLibrary.update(String(request.params.name), content, revision);
    store.emit("changed", { type: "prompts.changed", name: prompt.name, revision: prompt.revision });
    response.json({ prompt });
  });
  app.post("/api/prompts/:name/preview", async (request, response) => {
    const phase = request.body?.phase === "specification" || request.body?.phase === "review" ? request.body.phase : "implementation";
    response.json({ rendered: await promptLibrary.preview(String(request.params.name), message(request.body?.content, "content"), phase) });
  });
  app.get("/api/tickets", async (request, response) => response.json({ tickets: await store.summaries(request.query.include_archived === "true") }));
  app.get("/api/runtime", async (_request, response) => {
    const agents = (await store.list()).flatMap((loaded) => {
      const ticket = loaded.valid ? loaded.frontmatter : null;
      const execution = ticket?.execution;
      if (!ticket || !execution) return [];
      const key = execution.phase as "specification" | "implementation" | "review";
      return [{
        ticket_id: ticket.id, title: ticket.title, phase: ticket.phase, status: ticket.status,
        provider: execution.provider, attempt: execution.attempt, claimed_at: execution.claimed_at,
        last_heartbeat_at: execution.last_heartbeat_at, lease_expires_at: execution.lease_expires_at,
        consecutive_lease_losses: ticket.attempts[key].consecutive_lease_losses,
        pane_id: ticket.agents[key].herdr_pane_id, session_ref: ticket.agents[key].session_ref,
        herdr: execution.herdr_observation,
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
    if (loaded.valid && loaded.frontmatter?.jira && loaded.frontmatter.status === "pending") {
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
    response.json(ticketJson(loaded));
  });
  app.put("/api/tickets/:id", async (request, response) => {
    const mode = request.body?.mode === "rewind" ? "rewind" : "keep_phase";
    const phase = PHASES.includes(request.body?.rewind_phase) ? request.body.rewind_phase as Phase : undefined;
    const updated = await store.edit(
      String(request.params.id), message(request.body?.markdown, "markdown"), Number(request.body?.expected_revision), mode, phase,
    );
    response.json(ticketJson(updated));
  });

  app.post("/api/tickets/:id/ready", async (request, response) => {
    const id = String(request.params.id);
    let loaded = await store.get(id);
    if (!loaded.valid || !loaded.frontmatter) throw new HttpError(422, "Ticket is invalid", loaded.errors);
    if (loaded.frontmatter.revision !== expectedRevision(request)) throw new HttpError(409, "Ticket revision changed", loaded);
    if (loaded.frontmatter.jira) {
      const config = await configStore.read();
      const remote = await jiraClient.issue(config.jira, loaded.frontmatter.jira.key);
      loaded = await store.command(id, { event: "jira.resynced", message: `Pending ticket refreshed from ${remote.jira.key}.`, expectedRevision: loaded.frontmatter.revision }, (ticket, body) => {
        ticket.title = remote.title; ticket.labels = remote.labels; ticket.jira = remote.jira;
        return { ticket, body: replaceDescription(body, remote.description) };
      });
    }
    response.json(ticketJson(await store.command(id, { event: "ticket.ready", message: "Ticket marked ready.", expectedRevision: loaded.frontmatter!.revision }, (ticket) => {
      if (ticket.status !== "pending") throw new HttpError(409, "Only pending tickets can be marked ready");
      ticket.status = "ready";
      return { ticket };
    })));
  });

  app.post("/api/tickets/:id/approve-specification", async (request, response) => response.json(ticketJson(await store.command(
    String(request.params.id), { event: "specification.approved", message: "Specification approved.", expectedRevision: expectedRevision(request) },
    (ticket) => {
      if (ticket.phase !== "specification" || ticket.status !== "waiting_approval") throw new HttpError(409, "Ticket is not waiting for specification approval");
      ticket.phase = "implementation"; ticket.status = "ready";
      return { ticket };
    },
  ))));

  app.post("/api/tickets/:id/request-specification-changes", async (request, response) => {
    const feedback = message(request.body?.message);
    response.json(ticketJson(await store.command(
      String(request.params.id), { event: "specification.changes_requested", message: feedback, expectedRevision: expectedRevision(request) },
      (ticket) => {
        if (ticket.phase !== "specification" || ticket.status !== "waiting_approval") throw new HttpError(409, "Ticket is not waiting for specification approval");
        ticket.status = "ready";
        return { ticket };
      },
    )));
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
    if (loaded.frontmatter.status !== "pending" || !loaded.frontmatter.jira) throw new HttpError(409, "Only pending Jira-backed tickets can be resynced");
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
    (ticket) => { if (ticket.phase !== "done" || ticket.status !== "completed") throw new HttpError(409, "Only completed tickets can be archived"); ticket.archived_at = new Date().toISOString(); return { ticket }; },
  ))));
  app.post("/api/tickets/:id/unarchive", async (request, response) => response.json(ticketJson(await store.command(
    String(request.params.id), { event: "ticket.unarchived", message: "Ticket returned to the completed queue.", expectedRevision: expectedRevision(request) },
    (ticket) => { if (!ticket.archived_at) throw new HttpError(409, "Ticket is not archived"); ticket.archived_at = null; return { ticket }; },
  ))));

  app.post("/api/tickets/:id/retry", async (request, response) => response.json(ticketJson(await store.command(
    String(request.params.id), { event: "ticket.retried", message: "Current phase returned to ready.", expectedRevision: expectedRevision(request) },
    (ticket) => {
      if (ticket.status !== "failed" && ticket.status !== "blocked") throw new HttpError(409, "Only failed or needs-attention tickets can be retried");
      if (ticket.execution) throw new HttpError(409, "Cannot retry while an execution is active");
      if (ticket.phase === "done") throw new HttpError(409, "Completed tickets must be reopened");
      ticket.status = "ready";
      ticket.attempts[ticket.phase].consecutive_lease_losses = 0;
      return { ticket };
    },
  ))));

  app.post("/api/tickets/:id/release-supervisor", async (request, response) => response.json(ticketJson(await store.command(
    String(request.params.id), { event: "supervisor.released", message: "Pinned supervisor released by operator; the next eligible claim may reassign this ticket.", expectedRevision: expectedRevision(request) },
    (ticket) => {
      if (!ticket.assigned_supervisor) throw new HttpError(409, "Ticket is not assigned to a supervisor");
      if (ticket.execution) throw new HttpError(409, "Interrupt active work before releasing its supervisor");
      if (ticket.status === "completed" || ticket.status === "cancelled") throw new HttpError(409, "Terminal tickets do not need reassignment");
      ticket.assigned_supervisor = null;
      ticket.assigned_supervisor_host = null;
      ticket.agents = {
        specification: { provider: null, herdr_pane_id: null, session_ref: null },
        implementation: { provider: null, herdr_pane_id: null, session_ref: null },
        review: { provider: null, herdr_pane_id: null, session_ref: null },
      };
      if (ticket.status === "failed" || ticket.status === "blocked") ticket.status = "ready";
      return { ticket };
    },
  ))));

  const rewind = async (request: Request, response: Response, event: string) => {
    const phase = request.body?.phase as Phase;
    if (!PHASES.includes(phase) || phase === "done") throw new HttpError(422, "An applicable phase is required");
    response.json(ticketJson(await store.command(
      String(request.params.id), { event, message: `${event === "ticket.reopen_requested" ? "Reopen" : "Rewind"} requested for ${phase}.`, expectedRevision: expectedRevision(request) },
      (ticket) => {
        if (phase === "specification" && !ticket.spec_required) throw new HttpError(422, "Specification is not enabled");
        if (phase === "review" && !ticket.review_required) throw new HttpError(422, "Review is not enabled");
        if (ticket.execution) {
          if (ticket.execution.interrupt_request) throw new HttpError(409, "Ticket is already waiting for agent interruption");
          ticket.execution.interrupt_request = { target_phase: phase, requested_at: new Date().toISOString() };
        } else {
          ticket.phase = phase;
          ticket.status = "ready";
          ticket.archived_at = null;
        }
        return { ticket };
      },
    )));
  };
  app.post("/api/tickets/:id/rewind", (request, response, next) => void rewind(request, response, "ticket.rewind_requested").catch(next));
  app.post("/api/tickets/:id/reopen", (request, response, next) => void rewind(request, response, "ticket.reopen_requested").catch(next));

  for (const action of ["cancel", "fail"] as const) {
    app.post(`/api/tickets/:id/${action}`, async (request, response) => {
      const pastTense = action === "cancel" ? "cancelled" : "failed";
      const reason = typeof request.body?.message === "string" ? request.body.message.trim() : `Ticket ${pastTense} by operator.`;
      response.json(ticketJson(await store.command(
        String(request.params.id), { event: `ticket.${pastTense}`, message: reason || `Ticket ${pastTense} by operator.`, expectedRevision: expectedRevision(request) },
        (ticket) => { ticket.status = action === "cancel" ? "cancelled" : "failed"; ticket.execution = null; return { ticket }; },
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
    const claimed = await store.claim(supervisor, provider, availableProviders, supervisorHost);
    if (!claimed) { response.status(204).end(); return; }
    response.json(ticketJson(claimed));
  });

  app.get("/api/work/active", async (request, response) => {
    const supervisor = message(request.query.supervisor_id, "supervisor_id");
    const provider = typeof request.query.provider === "string" ? request.query.provider : undefined;
    if (provider !== undefined && !PROVIDERS.some((candidate) => candidate === provider)) throw new HttpError(422, "provider must be claude or codex");
    const active = (await store.list()).filter((ticket) => ticket.valid && ticket.frontmatter?.execution?.supervisor_id === supervisor
      && (provider === undefined || ticket.frontmatter.execution.provider === provider));
    response.json({ tickets: active.map(ticketJson) });
  });

  app.post("/api/work/:lease/heartbeat", async (request, response) => {
    const leaseId = String(request.params.lease);
    const leased = await store.byLease(leaseId);
    const supervisorHost = registry.hostnameFor(leased.execution.supervisor_id);
    const herdr = heartbeatHerdr(request.body?.herdr_observation);
    const updated = await store.heartbeat(leaseId, {
      ...(supervisorHost ? { supervisorHost } : {}),
      ...(typeof request.body?.observed_state === "string" ? { state: request.body.observed_state } : {}),
      ...(typeof request.body?.pane_id === "string" ? { paneId: request.body.pane_id } : {}),
      ...(typeof request.body?.session_ref === "string" ? { sessionRef: request.body.session_ref } : {}),
      ...(Number.isInteger(request.body?.guidance_cursor) ? { guidanceCursor: Number(request.body.guidance_cursor) } : {}),
      ...(herdr ? { herdr } : {}),
    });
    response.json({ active: true, ticket: ticketJson(updated) });
  });

  app.get("/api/work/:lease/guidance", async (request, response) => {
    const leased = await store.byLease(String(request.params.lease));
    const after = Number(request.query.after ?? 0);
    response.json({ guidance: leased.execution.guidance.filter((item) => item.sequence > after) });
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
    response.json(ticketJson(await store.command(
      leased.frontmatter.id,
      { event: "work.interrupted", message: "Active agent interrupted; requested phase is ready." },
      (ticket) => {
        if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced");
        const interrupt = ticket.execution.interrupt_request;
        if (!interrupt) throw new HttpError(409, "No agent interruption is pending");
        ticket.phase = interrupt.target_phase;
        ticket.status = "ready";
        ticket.execution = null;
        return { ticket };
      },
    )));
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
    const result = { accepted: true, ticket_id: leased.frontmatter.id, callback: kind };
    await store.command(leased.frontmatter.id, {
      event: kind === "complete" ? `agent.${leased.frontmatter.phase}_completed` : "agent.failed", message: summary,
    }, (ticket) => {
      if (ticket.execution?.lease_id !== leaseId) throw new HttpError(409, "Lease is stale or fenced");
      if (ticket.execution.interrupt_request) throw new HttpError(409, "Lease is awaiting agent interruption");
      if (ticket.questions.some((item) => item.answer === null)) throw new HttpError(409, "Answer outstanding agent questions before completing the phase");
      if (kind === "fail") ticket.status = "failed";
      else if (ticket.phase === "specification") {
        const prs = Array.isArray(request.body?.pull_requests) ? request.body.pull_requests as PullRequestRef[] : [];
        const primary = ticket.repositories.find((item) => item.primary)?.id;
        if (!primary || !prs.some((item) => item.repository === primary)) throw new HttpError(422, "Specification completion must report the primary repository PR");
        ticket.pull_requests = mergePullRequests(ticket.pull_requests, prs.map((item) => ({ ...item, phase: item.phase ?? "specification" })), ticket.repositories.map((item) => item.id));
        ticket.status = "waiting_approval";
      } else if (ticket.phase === "implementation") {
        const prs = Array.isArray(request.body?.pull_requests) ? request.body.pull_requests as PullRequestRef[] : [];
        ticket.pull_requests = mergePullRequests(ticket.pull_requests, prs.map((item) => ({ ...item, phase: item.phase ?? "implementation" })), ticket.repositories.map((item) => item.id));
        if (ticket.pull_requests.length === 0) throw new HttpError(422, "Implementation completion must report at least one draft PR");
        if (ticket.review_required) { ticket.phase = "review"; ticket.status = "ready"; }
        else { ticket.phase = "done"; ticket.status = "completed"; }
      } else if (ticket.phase === "review") {
        const decision = request.body?.decision;
        if (decision !== "approved" && decision !== "changes_requested") throw new HttpError(422, "Review decision must be approved or changes_requested");
        if (decision === "approved") { ticket.phase = "done"; ticket.status = "completed"; }
        else { ticket.phase = "implementation"; ticket.status = "ready"; }
      } else throw new HttpError(409, "Done tickets cannot complete work");
      const key = leased.frontmatter.phase as "specification" | "implementation" | "review";
      ticket.attempts[key].consecutive_lease_losses = 0;
      ticket.execution = null;
      ticket.last_callback = { lease_id: leaseId, digest: payloadDigest, response: result };
      return { ticket };
    });
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

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof HttpError) { response.status(error.status).json({ error: error.message, details: error.details }); return; }
    console.error(error);
    response.status(500).json({ error: "Internal server error" });
  });
  return app;
}
