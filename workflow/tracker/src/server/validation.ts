import { PHASES, PROVIDERS, STATUSES, defaultReviewProvider, type AgentRef, type AttemptCounter, type Execution, type HerdrObservation, type Phase, type PullRequestRef, type TicketFrontmatter, type TicketQuestion } from "./domain.js";

const phaseStatuses: Record<Phase, Set<string>> = {
  specification: new Set(["pending", "ready", "running", "blocked", "waiting_approval", "failed", "cancelled"]),
  implementation: new Set(["pending", "ready", "running", "blocked", "failed", "cancelled"]),
  review: new Set(["ready", "running", "blocked", "failed", "cancelled"]),
  done: new Set(["completed", "cancelled"]),
};

const emptyAgent = (): AgentRef => ({ provider: null, herdr_pane_id: null, session_ref: null });
const emptyAttempt = (): AttemptCounter => ({ total: 0, consecutive_lease_losses: 0 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim() === "") { errors.push(`${field} must be a non-empty string`); return ""; }
  return value.trim();
}

function agent(value: unknown): AgentRef {
  if (!isRecord(value)) return emptyAgent();
  const provider = PROVIDERS.includes(value.provider as never) ? value.provider as AgentRef["provider"] : null;
  return {
    provider,
    herdr_pane_id: typeof value.herdr_pane_id === "string" ? value.herdr_pane_id : null,
    session_ref: typeof value.session_ref === "string" ? value.session_ref : null,
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
  const provider = PROVIDERS.includes(value.provider as never) ? value.provider as Execution["provider"] : "claude";
  if (!PROVIDERS.includes(value.provider as never)) errors.push("execution.provider must be claude or codex");
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
      };
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
    observed_herdr_state: value.observed_herdr_state === null || value.observed_herdr_state === undefined
      ? null : asString(value.observed_herdr_state, "execution.observed_herdr_state", errors),
    herdr_observation: herdrObservation(value.herdr_observation, errors),
    guidance,
    interrupt_request: interruptRequest,
  };
}

export function normalizeTicket(raw: Record<string, unknown>, now = new Date().toISOString()): { ticket: TicketFrontmatter; errors: string[]; admitted: boolean } {
  const errors: string[] = [];
  const id = asString(raw.id, "id", errors);
  const title = asString(raw.title, "title", errors);
  const specRequired = typeof raw.spec_required === "boolean" ? raw.spec_required : (errors.push("spec_required must be a boolean"), false);
  const reviewRequired = typeof raw.review_required === "boolean" ? raw.review_required : (errors.push("review_required must be a boolean"), false);
  const rawAgents = isRecord(raw.agents) ? raw.agents : {};
  const existingSpecification = agent(rawAgents.specification);
  const existingImplementation = agent(rawAgents.implementation);
  const existingReview = agent(rawAgents.review);
  const existingWorkProvider = existingImplementation.provider ?? existingSpecification.provider;
  const workProvider = raw.work_provider === undefined || raw.work_provider === null
    ? existingWorkProvider ?? "claude"
    : PROVIDERS.includes(raw.work_provider as never) ? raw.work_provider as TicketFrontmatter["work_provider"]
      : (errors.push("work_provider must be claude or codex"), existingWorkProvider ?? "claude");
  const defaultReviewer = defaultReviewProvider(workProvider);
  const reviewProvider = raw.review_provider === undefined || raw.review_provider === null
    ? existingReview.provider === "claude" || existingReview.provider === "codex"
      ? existingReview.provider === defaultReviewer ? existingReview.provider : defaultReviewer
      : defaultReviewer
    : raw.review_provider === "claude" || raw.review_provider === "codex" ? raw.review_provider
      : (errors.push("review_provider must be claude or codex"), defaultReviewer);
  if (workProvider === "claude" && reviewProvider !== "codex") errors.push("Claude work must be reviewed by Codex");
  if (workProvider === "codex" && reviewProvider !== "claude") errors.push("Codex work must be reviewed by Claude");
  const repositories = Array.isArray(raw.repositories) ? raw.repositories.map((item, index) => {
    if (!isRecord(item)) { errors.push(`repositories[${index}] must be an object`); return { id: "", primary: false }; }
    return { id: asString(item.id, `repositories[${index}].id`, errors), primary: item.primary === true };
  }) : (errors.push("repositories must be an array"), []);
  if (repositories.length === 0) errors.push("repositories must contain at least one entry");
  if (repositories.filter((item) => item.primary).length !== 1) errors.push("repositories must contain exactly one primary entry");
  if (new Set(repositories.map((item) => item.id)).size !== repositories.length) errors.push("repository ids must be unique");

  const defaultPhase: Phase = specRequired ? "specification" : "implementation";
  const phase = raw.phase === undefined ? defaultPhase : PHASES.includes(raw.phase as never)
    ? raw.phase as Phase : (errors.push("phase must be specification, implementation, review, or done"), defaultPhase);
  const status = raw.status === undefined ? "pending" : STATUSES.includes(raw.status as never)
    ? raw.status as TicketFrontmatter["status"] : (errors.push("status is not recognized"), "pending");
  if (!phaseStatuses[phase].has(status)) errors.push(`${phase}/${status} is not a valid phase/status combination`);

  const rawAttempts = isRecord(raw.attempts) ? raw.attempts : {};
  const currentExecution = execution(raw.execution, errors);
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

  const admitted = raw.phase === undefined || raw.status === undefined || raw.revision === undefined;
  const ticket: TicketFrontmatter = {
    id, title, phase, status, spec_required: specRequired, review_required: reviewRequired,
    work_provider: workProvider, review_provider: reviewProvider,
    priority: raw.priority === undefined ? 0 : Number.isInteger(raw.priority) ? Number(raw.priority) : (errors.push("priority must be an integer"), 0),
    labels,
    repositories,
    assigned_supervisor: raw.assigned_supervisor === undefined
      ? currentExecution?.supervisor_id ?? null
      : raw.assigned_supervisor === null ? null : asString(raw.assigned_supervisor, "assigned_supervisor", errors),
    assigned_supervisor_host: raw.assigned_supervisor_host === null || raw.assigned_supervisor_host === undefined
      ? null : asString(raw.assigned_supervisor_host, "assigned_supervisor_host", errors),
    agents: {
      specification: existingSpecification,
      implementation: existingImplementation,
      review: existingReview,
    },
    execution: currentExecution,
    attempts: {
      specification: attempt(rawAttempts.specification),
      implementation: attempt(rawAttempts.implementation),
      review: attempt(rawAttempts.review),
    },
    pull_requests: pullRequests,
    questions,
    jira,
    archived_at: archivedAt,
    revision: Number.isInteger(raw.revision) && Number(raw.revision) > 0 ? Number(raw.revision) : 1,
    event_sequence: Number.isInteger(raw.event_sequence) && Number(raw.event_sequence) >= 0 ? Number(raw.event_sequence) : 0,
    created_at: typeof raw.created_at === "string" ? raw.created_at : now,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : now,
    last_callback: isRecord(raw.last_callback) ? raw.last_callback as unknown as TicketFrontmatter["last_callback"] : null,
  };
  return { ticket, errors, admitted };
}

export function validateSessionInvariant(ticket: TicketFrontmatter): string[] {
  const errors: string[] = [];
  const specification = ticket.agents.specification;
  const implementation = ticket.agents.implementation;
  if (specification.session_ref && implementation.session_ref && specification.session_ref !== implementation.session_ref) {
    errors.push("specification and implementation must share the same session_ref");
  }
  if (specification.provider && implementation.provider && specification.provider !== implementation.provider) {
    errors.push("specification and implementation must share the same provider");
  }
  if (specification.provider && specification.provider !== ticket.work_provider) errors.push("specification provider must match work_provider");
  if (implementation.provider && implementation.provider !== ticket.work_provider) errors.push("implementation provider must match work_provider");
  if (ticket.agents.review.provider && ticket.agents.review.provider !== ticket.review_provider) errors.push("review agent provider must match review_provider");
  if (ticket.execution && ticket.assigned_supervisor !== ticket.execution.supervisor_id) {
    errors.push("execution supervisor must match assigned_supervisor");
  }
  return errors;
}
