// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { App } from "./App.js";

const summary = {
  id: "APT-42", title: "UI ticket", phase: "implementation", status: "running",
  priority: 50, provider: "claude", revision: 7, created_at: "2026-08-14T11:00:00Z", updated_at: "2026-08-14T12:01:30Z", valid: true, errors: [], path: "APT-42.md", claim_blockers: [], archived_at: null,
  labels: ["dashboard"], repositories: ["demo"], assigned_supervisor: "coordinator-vm", estimated_human_days: null,
  workflow_id: "standard-delivery", workflow_node_id: "implementation", workflow_node_name: "Implementation", workflow_stage_name: "Implementation",
  attention: { kinds: [] as Array<"question" | "human_gate" | "blocked" | "failed" | "delivery_failure" | "github_feedback" | "expiring_wait" | "repository_blocked">, pending_questions: 0, wait_wake_at: null as string | null, wait_deadline_at: null as string | null, delivery_failure_summary: null as string | null, github_feedback_summary: null as string | null },
};

const execution = {
  provider: "claude", phase: "implementation", attempt: 2, supervisor_id: "coordinator-vm",
  claimed_at: "2026-08-14T12:00:00Z", last_heartbeat_at: "2026-08-14T12:01:30Z",
  lease_expires_at: "2026-08-14T12:03:30Z", lease_id: "lease-1", observed_herdr_state: "working", guidance: [],
  delivery_status: "delivered", delivery_confirmed_at: "2026-08-14T12:00:05Z",
  interrupt_request: null,
  herdr_observation: {
    state: "working", observed_at: "2026-08-14T12:01:30Z", state_changed_at: "2026-08-14T12:00:05Z",
    pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term-1", focused: false,
    cwd: "/srv/projects", foreground_cwd: "/srv/projects/demo", terminal_title: "⠋ Running tests",
    terminal_title_stripped: "Running tests", display_name: "Claude", revision: 12,
    session_source: "herdr:claude", session_kind: "id", tokens: { model: "opus" },
  },
};

const detail = {
  id: "APT-42", path: "/srv/tickets/APT-42.md", relative_path: "APT-42.md", markdown: "---\nid: APT-42\n---\n\n# Goal\n",
  body: "# Goal\n\nShip a clear dashboard.\n\n## Acceptance Criteria\n\n- Show the agent state.\n\n## Interaction Log\n\n<!-- tracker:interaction-log:start -->\n- `000007` `2026-08-14T12:00:00Z` **work.claimed** — Claimed.\n<!-- tracker:interaction-log:end -->\n",
  valid: true, errors: [],
  frontmatter: {
    id: "APT-42", title: "UI ticket", phase: "implementation", status: "running", revision: 7,
    priority: 50, labels: ["dashboard"],
    repositories: [{ id: "demo", primary: true }], attachments: [], pull_requests: [{ repository: "demo", url: "https://github.com/example/demo/pull/42" }],
    questions: [], jira: null, archived_at: null,
    created_at: "2026-08-14T11:00:00Z", updated_at: "2026-08-14T12:01:30Z", execution,
    assigned_supervisor: "coordinator-vm",
    assigned_supervisor_host: "worker-vm",
    conversations: { work: { provider: "claude", herdr_pane_id: "w1:p1", session_ref: "session-1" } },
  },
};

const promptFixtures = [
  {
    name: "assignment", title: "Assignment envelope", purpose: "Starts or resumes ticket work.",
    trigger: "After a phase is claimed or recovered and Herdr is attached.", stages: ["Specification", "Implementation", "Review"],
    allowed_tags: ["ticket_id", "phase", "ticket_path", "ticket_markdown", "project_root", "phase_instructions", "callback_base"],
    required_tags: ["ticket_id", "phase", "ticket_path", "ticket_markdown", "phase_instructions", "callback_base"],
    content: "Work {{ticket_id}} in {{phase}} from {{project_root}}.\n\n{{ticket_markdown}}\n\n{{phase_instructions}}\n\nCallback: {{callback_base}} at {{ticket_path}}",
    revision: "assignment-r1", version: 1, valid: true, errors: [],
    tags: [
      { name: "ticket_id", description: "Stable ticket identifier.", example: "AGENT-0042" },
      { name: "phase", description: "Durable work phase.", example: "implementation" },
      { name: "ticket_path", description: "Authoritative ticket path.", example: "/srv/tickets/AGENT-0042.md" },
      { name: "ticket_markdown", description: "Complete ticket Markdown.", example: "# Goal\n\nAdd a health endpoint." },
      { name: "project_root", description: "Supervisor project root.", example: "/srv/agent-workspaces/supervisor-a" },
      { name: "phase_instructions", description: "Rendered phase instructions.", example: "Implement autonomously." },
      { name: "callback_base", description: "Lease-fenced callback URL.", example: "http://tracker/api/work/dummy/" },
    ],
  },
  ...["specification", "implementation", "review", "guidance", "callback-reminder"].map((name) => ({
    name, title: `${name[0]!.toUpperCase()}${name.slice(1)} instructions`, purpose: `${name} message`,
    trigger: `${name} transition trigger`, stages: [name === "guidance" ? "Live edit" : name],
    allowed_tags: [], required_tags: [], content: `${name} instructions`, revision: `${name}-r1`, version: 1, tags: [], valid: true, errors: [],
  })),
];

const workflowDefinition = {
  version: 2, id: "standard-delivery", name: "Standard delivery", description: "Specification, implementation, review, and repair loops.",
  start: "specification", max_transitions: 80,
  inputs: [],
  stages: [
    { id: "specification", name: "Specification", phase: "specification", skippable: true, default_enabled: true, bypass_to: "implementation" },
    { id: "implementation", name: "Implementation", phase: "implementation", skippable: false, default_enabled: true },
    { id: "review", name: "Review", phase: "review", skippable: true, default_enabled: true, bypass_to: "done" },
    { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
  ],
  nodes: [
    { id: "specification", name: "Specification", type: "agent", phase: "specification", stage: "specification", prompt: "specification", agent_profile: "default", conversation_key: "work", max_visits: 20, outcomes: [{ id: "completed", label: "Specification completed", description: "Ready for approval.", target: "specification-approval" }], choices: [], exit_codes: [] },
    { id: "specification-approval", name: "Approve specification", type: "human_gate", phase: "specification", stage: "specification", max_visits: 20, github_watch: { pull_request_phase: "specification", feedback_outcome: "changes_requested" }, outcomes: [], choices: [{ id: "approved", label: "Approve", description: "Continue.", target: "implementation" }, { id: "changes_requested", label: "Request changes", description: "Revise.", target: "specification", comment_required: true }], exit_codes: [] },
    { id: "implementation", name: "Implementation", type: "agent", phase: "implementation", stage: "implementation", prompt: "implementation", agent_profile: "default", conversation_key: "work", max_visits: 20, outcomes: [{ id: "completed", label: "Implementation completed", description: "Ready for review.", target: "review" }], choices: [], exit_codes: [] },
    { id: "review", name: "Independent review", type: "agent", phase: "review", stage: "review", prompt: "review", agent_profile: "review", conversation_key: "review", max_visits: 20, outcomes: [{ id: "approved", label: "Approve", description: "Finish.", target: "done" }, { id: "changes_requested", label: "Request changes", description: "Repair.", target: "implementation" }], choices: [], exit_codes: [] },
    { id: "done", name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] },
  ],
};

const workflowFixture = {
  definition: workflowDefinition,
  content: JSON.stringify(workflowDefinition, null, 2),
  revision: "workflow-r1", version: 1, valid: true, errors: [], referenced_prompts: ["specification", "implementation", "review"],
};

const metricsFixture = {
  generated_at: "2026-08-18T13:00:00.000Z", filters: { labels: [], label_mode: "any", repositories: [] },
  available: { labels: ["dashboard"], workflows: [{ id: "standard-delivery", revision: "workflow-r1" }], repositories: ["demo"] },
  totals: {
    tickets: 3, completed: 1, failed: 0, cancelled: 0, in_progress: 2, settled: 1, completion_rate: 1,
    archived: 0, total_tokens: 1_100, known_cost_usd: 0.02,
    active_ms: 90_000, quota_paused_ms: 30_000, human_wait_ms: 60_000, external_wait_ms: 0,
    estimated_human_days: 2, estimated_human_cost_usd: 2_000, human_day_rate_usd: 1_000,
    comparison_tickets: 1, comparison_human_cost_usd: 2_000, comparison_factory_cost_usd: 0.02,
    comparison_savings_usd: 1_999.98, comparison_savings_rate: 0.99999,
    production: { unassessed: 0, succeeded: 1, failed: 0, rolled_back: 0, not_deployed: 0 },
    production_assessed: 1, production_success_rate: 1,
  },
  coverage: { agent_runs: 1, token_runs: 1, cost_runs: 1, estimated_cost_runs: 0, complete_token_tickets: 1, complete_cost_tickets: 1 },
  summaries: Object.fromEntries(["ticket_duration_ms", "active_time_ms", "human_wait_ms", "external_wait_ms", "quota_pause_ms", "tokens_per_ticket", "cost_per_ticket_usd", "estimated_human_days", "estimated_human_cost_usd"].map((key) => [key, { count: 1, min: 1, q1: 1, median: 1, q3: 1, max: 1, mean: 1, p90: 1, p95: 1 }])),
  workflows: [{
    workflow_id: "standard-delivery", workflow_revision: "workflow-r1", ticket_count: 1,
    nodes: [{
      workflow_id: "standard-delivery", workflow_revision: "workflow-r1", node_id: "implementation", node_name: "Implementation", node_type: "agent",
      ticket_count: 1, runs: 1, completed: 1, running: 0, interrupted: 0, bypassed: 0, lease_lost: 0, delivery_failed: 0,
      classifications: { success: 1, failure: 0, neutral: 0, unclassified: 0 }, success_rate: 1,
      wall_ms: { count: 1, min: 90_000, q1: 90_000, median: 90_000, q3: 90_000, max: 90_000, mean: 90_000, p90: 90_000, p95: 90_000 },
      active_ms: 90_000, quota_paused_ms: 30_000, human_wait_ms: 0, external_wait_ms: 0, total_tokens: 1_100, known_cost_usd: 0.02,
      telemetry_coverage: { token_runs: 1, cost_runs: 1, total_runs: 1 },
      branches: [{ outcome: "completed", label: "Completed", target: "done", metric_class: "success", count: 1, rate: 1 }],
      quality: [{ key: "coverage.line_percent", label: "Line coverage", type: "number", unit: "percent", direction: "higher_is_better", ticket_count: 1, reports: 1, statuses: { pass: 1, warn: 0, fail: 0, unknown: 0 }, pass_rate: 1, numeric: { count: 1, min: 84, q1: 84, median: 84, q3: 84, max: 84, mean: 84, p90: 84, p95: 84 }, values: [{ value: "84", count: 1 }] }],
    }],
  }],
  profiles: [{ alias: "default", provider: "claude", model: "opus", reasoning: "high", runs: 1, success: 1, failure: 0, success_rate: 1, total_tokens: 1_100, known_cost_usd: 0.02, token_runs: 1, cost_runs: 1, wall_ms: { count: 1, min: 90_000, q1: 90_000, median: 90_000, q3: 90_000, max: 90_000, mean: 90_000, p90: 90_000, p95: 90_000 } }],
};

class FakeEventSource { addEventListener() {} close() {} }

function installLocalStorage(): Storage {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, String(value)); },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return storage;
}

describe("operator UI", () => {
  let current: any = structuredClone(detail);
  let claimBlockers: any[] = [];
  let trackerConfig: any;
  let quotaReport: any;
  let prompts: any[];
  let workflows: any[];
  let workflowReleases: any;
  let intakeOverview: any;
  let extraTicketSummaries: any[];
  beforeEach(() => {
    installLocalStorage();
    document.documentElement.removeAttribute("data-theme");
    summary.attention = { kinds: [], pending_questions: 0, wait_wake_at: null, wait_deadline_at: null, delivery_failure_summary: null, github_feedback_summary: null };
    current = structuredClone(detail);
    current.workflow_definition = structuredClone(workflowDefinition);
    current.workflow_node = structuredClone(workflowDefinition.nodes.find((node) => node.id === "implementation"));
    current.resolved_agent_profile = { alias: "default", provider: "claude", model: "claude-opus", reasoning: "high" };
    current.frontmatter.workflow = {
      id: "standard-delivery", revision: "workflow-r1", active_workflow_id: "standard-delivery", current_node: "implementation",
      transition_count: 1, started_at: "2026-08-14T11:00:00Z", completed_at: null, current_node_entered_at: "2026-08-14T12:00:00Z",
      node_visits: { implementation: 1 }, node_attempts: { implementation: { total: 2, consecutive_lease_losses: 0 } },
      prompt_revisions: {}, workflow_revisions: { "standard-delivery": "workflow-r1" }, inputs: {},
      stage_enabled: { specification: true, implementation: true, review: true, done: true }, incoming: null,
      node_runs: [], workflow_stack: [], fan_out_stack: [],
      resolved_agent_profiles: {
        "standard-delivery/specification": { alias: "default", provider: "claude", model: "claude-opus", reasoning: "high" },
        "standard-delivery/implementation": { alias: "default", provider: "claude", model: "claude-opus", reasoning: "high" },
        "standard-delivery/review": { alias: "review", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" },
      },
    };
    current.frontmatter.workflow_assignment = {
      workflow_id: "standard-delivery", revision: "workflow-r1", version: 1,
      selection: "default", assigned_at: "2026-08-14T11:00:00Z", experiment_id: null,
    };
    claimBlockers = [];
    extraTicketSummaries = [];
    prompts = structuredClone(promptFixtures);
    workflows = [structuredClone(workflowFixture)];
    workflowReleases = { catalog: { version: 1, revision: 1, updated_at: "2026-08-14T12:00:00Z", default_workflow_id: "standard-delivery", workflows: { "standard-delivery": { default_revision: "workflow-r1" } } }, releases: [{ workflow_id: "standard-delivery", revision: "workflow-r1", version: 1, label: "Initial release", status: "active", published_at: "2026-08-14T12:00:00Z", parent_revision: null, is_default: true, definition: structuredClone(workflowDefinition) }] };
    trackerConfig = { version: 1, revision: 2, updated_at: "2026-08-14T12:00:00Z", tickets: { id_prefix: "AGENT", next_number: 1 }, providers: { enabled: ["claude", "codex"] }, agent_profiles: { default: "default", profiles: [{ id: "default", label: "Default", provider: "claude", model: "claude-opus", reasoning: "high" }, { id: "review", label: "Independent review", provider: "codex", model: "gpt-5.6-sol", reasoning: "high" }] }, repositories: [{ id: "demo", url: "git@github.com:example/demo.git" }], jira: { enabled: false, site_url: "", project_key: "", issue_type: "Task" }, github: { observation_enabled: false, observation_interval_minutes: 30, ignored_logins: [] }, pricing: { estimate_missing_costs: true, models: [{ id: "codex-gpt-5.6-sol", provider: "codex", model: "gpt-5.6-sol", input_per_million_usd: 5, cached_input_per_million_usd: 0.5, cache_write_input_per_million_usd: 6.25, output_per_million_usd: 30, source_url: "https://developers.openai.com/api/docs/models/gpt-5.6-sol", effective_at: "2026-08-19" }] }, metrics: { human_day_rate_usd: 1_000, quota_account_aliases: {} } };
    quotaReport = { generated_at: "2026-08-20T12:00:00Z", accounts: [{
      account_id: "coordinator-vm", supervisor_ids: ["coordinator-vm"], provider: "codex", limit_id: "codex:primary", status: "estimated",
      used_percent: 31, window_minutes: 10_080, resets_at: "2026-08-27T04:25:50Z", observed_at: "2026-08-20T12:00:00Z", plan_types: ["prolite"],
      estimated_weekly_tokens: 100_000_000, estimated_weekly_api_usd: 200, token_samples: 3, cost_samples: 3, direct_samples: 2, percentage_points_observed: 4, confidence: "medium",
    }, {
      account_id: "coordinator-vm", supervisor_ids: ["coordinator-vm"], provider: "claude", limit_id: "seven_day", status: "estimated",
      used_percent: 45, window_minutes: 10_080, resets_at: "2026-08-27T04:25:50Z", observed_at: "2026-08-20T12:00:00Z", plan_types: [],
      estimated_weekly_tokens: 80_000_000, estimated_weekly_api_usd: 150, token_samples: 2, cost_samples: 2, direct_samples: 2, percentage_points_observed: 3, confidence: "medium",
    }] };
    const campaignDefinition = { version: 1, id: "continuous-improvement", name: "Continuous improvement", description: "Improve the demo.", enabled: true, limits: { max_new_per_run: 100, max_new_per_day: 100, max_open: 50, max_working: 10, max_observed_unarchived: 100 }, success_policy: {} };
    intakeOverview = {
      generated_at: "2026-08-20T12:00:00Z", totals: { campaigns: 1, enabled_campaigns: 1, invalid_campaigns: 0, sources: 0, enabled_sources: 0, invalid_sources: 0, runs: 0, preview_runs: 0, running_runs: 0, failed_runs: 0, candidates: 0, admitted: 0, deferred: 0, rejected: 0 },
      campaigns: [{ id: campaignDefinition.id, name: campaignDefinition.name, revision: "campaign-r1", enabled: true, sources: 0, runs: 0, successful_runs: 0, failed_runs: 0, candidates: 0, admitted: 0, deferred: 0, open_tickets: 0, working_tickets: 0, completed_tickets: 0, production_successes: 0 }],
      sources: [], recent_runs: [], recent_candidates: [], source_documents: [], campaign_documents: [{ definition: campaignDefinition, content: stringify(campaignDefinition, { lineWidth: 0 }), revision: "campaign-r1", valid: true, errors: [] }],
    };
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if ((path === "/api/tickets" || path === "/api/tickets?include_archived=true") && !init?.method) {
        const ticket = { ...summary, phase: current.frontmatter.phase, status: current.frontmatter.status, priority: current.frontmatter.priority, revision: current.frontmatter.revision, claim_blockers: claimBlockers, archived_at: current.frontmatter.archived_at };
        return Response.json({ tickets: [...(current.frontmatter.archived_at && path === "/api/tickets" ? [] : [ticket]), ...extraTicketSummaries] });
      }
      if (path === "/api/runtime" && !init?.method) return Response.json({ agents: current.frontmatter.execution ? [{
        ticket_id: current.id, title: current.frontmatter.title, phase: current.frontmatter.phase, status: current.frontmatter.status,
        provider: "claude", attempt: 2, claimed_at: execution.claimed_at, last_heartbeat_at: execution.last_heartbeat_at,
        lease_expires_at: execution.lease_expires_at, consecutive_lease_losses: 0, pane_id: "w1:p1", session_ref: "session-1", herdr: execution.herdr_observation,
        delivery_status: current.frontmatter.execution.delivery_status, delivery_confirmed_at: current.frontmatter.execution.delivery_confirmed_at,
        telemetry: current.frontmatter.execution.telemetry ?? null,
      }] : [] });
      if (path === "/api/supervisors" && !init?.method) return Response.json({ supervisors: [{
        supervisor_id: "coordinator-vm", instance_id: "instance-1", hostname: "worker-vm",
        ip_addresses: ["192.0.2.70"], project_root: "/srv/projects", herdr_session: "agentic-projects",
        providers: ["claude", "codex"], activity_capabilities: ["repository_action", "inline_shell", "inline_javascript", "inline_python"], started_at: "2026-08-14T11:00:00Z",
        last_seen_at: "2026-08-14T12:01:30Z", status: "online",
        assigned_ticket: { id: "APT-42", title: "UI ticket", phase: current.frontmatter.phase, status: current.frontmatter.status },
      }] });
      if (path === "/api/operations" && !init?.method) return Response.json({
        status: "ready", ready: true, checked_at: "2026-08-14T12:01:30Z", failures: [], warnings: [],
        ticket_store: { root: "/srv/tickets", writable: true, ticket_count: 1, valid_tickets: 1, invalid_tickets: 0, index_generation: 3, index_rebuilt_at: "2026-08-14T12:01:00Z", watcher_enabled: true, disk: { total_bytes: 100_000, free_bytes: 50_000, available_bytes: 40_000 } },
        libraries: { configuration_revision: 2, prompts: 6, invalid_prompts: [], workflows: 1, invalid_workflows: [] },
        background_operations: {
          github_observation: { in_progress: false, last_started_at: "2026-08-14T12:00:00Z", last_succeeded_at: "2026-08-14T12:00:01Z", last_failed_at: null, last_duration_ms: 1_000, last_error: null, details: { checked: 1 } },
          artifact_maintenance: { in_progress: false, last_started_at: null, last_succeeded_at: null, last_failed_at: null, last_duration_ms: null, last_error: null, details: {} },
        },
      });
      if (path.startsWith("/api/metrics/compare") && !init?.method) {
        const summary = { count: 1, min: 1, q1: 1, median: 1, q3: 1, max: 1, mean: 1, p90: 1, p95: 1 };
        const arm = (revision: string) => ({ workflow_id: "standard-delivery", workflow_revision: revision, cohort: { assigned: 1, completed: 1, failed: 0, cancelled: 0, blocked: 0, in_progress: 0, crossover: 0, efficiency_eligible: 1 }, completion_rate: 1, production_success_rate: 1, coverage: { cost_tickets: 1, token_tickets: 1, eligible_tickets: 1 }, totals: { known_cost_usd: 1, known_tokens: 100, active_ms: 1, human_wait_ms: 0, quota_paused_ms: 0 }, summaries: { ticket_duration_ms: summary, active_time_ms: summary, human_wait_ms: summary, quota_pause_ms: summary, cost_per_ticket_usd: summary, tokens_per_ticket: summary, node_visits: summary }, nodes: metricsFixture.workflows[0]!.nodes });
        return Response.json({ generated_at: "2026-08-18T13:00:00Z", left: arm("workflow-r1"), right: arm("workflow-r2"), deltas: {
          completion_rate: { absolute: 0.1, percent: 0.1 }, production_success_rate: { absolute: 0, percent: 0 },
          median_cost_usd: { absolute: 1, percent: 1 }, median_tokens: { absolute: 0, percent: 0 },
          median_duration_ms: { absolute: 0, percent: 0 }, median_active_ms: { absolute: -1_000, percent: -0.5 },
        } });
      }
      if (path.startsWith("/api/metrics") && !init?.method) return Response.json(metricsFixture);
      if (path === "/api/intake" && !init?.method) return Response.json(intakeOverview);
      if (path === "/api/config" && !init?.method) return Response.json({ config: trackerConfig, quota: quotaReport });
      if (path === "/api/prompts" && !init?.method) return Response.json({ prompts });
      if (path === "/api/prompts" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        const prompt = { name: payload.name, title: payload.name.replaceAll("-", " "), purpose: "Reusable workflow-node instructions.", trigger: "Workflow agent node", stages: ["Workflow agent node"], allowed_tags: [], required_tags: [], tags: [], content: `${payload.content.trim()}\n`, revision: `${payload.name}-r1`, version: 1, valid: true, errors: [], workflow_references: [] };
        prompts.push(prompt); return Response.json({ prompt }, { status: 201 });
      }
      if (path === "/api/workflows" && !init?.method) return Response.json({ workflows });
      if (path === "/api/workflow-releases" && !init?.method) return Response.json(workflowReleases);
      if (path === "/api/workflow-bundles/import" && init?.method === "POST") {
        const bundle = JSON.parse(String(init.body));
        const definition = (await import("yaml")).parse(bundle.workflow.content);
        const workflow = { definition, content: bundle.workflow.content, revision: bundle.workflow.revision, version: bundle.workflow.version, valid: true, errors: [], referenced_prompts: bundle.prompts.map((prompt: any) => prompt.name) };
        workflows = [...workflows.filter((item) => item.definition.id !== definition.id), workflow];
        prompts = [...prompts.filter((item) => !bundle.prompts.some((prompt: any) => prompt.name === item.name)), ...bundle.prompts.map((prompt: any) => ({ ...prompt, title: prompt.name, purpose: "Imported", trigger: "Workflow", stages: [], allowed_tags: [], required_tags: [], tags: [], valid: true, errors: [] }))];
        const release = { workflow_id: definition.id, revision: workflow.revision, version: workflow.version, label: bundle.workflow.label, status: "active", published_at: new Date().toISOString(), parent_revision: null, is_default: true, definition };
        workflowReleases.releases.push(release);
        return Response.json({ workflow, prompts, release, installed_prompt_revisions: bundle.prompts.map((prompt: any) => `${prompt.name}@${prompt.revision}`), unchanged_prompt_revisions: [], warnings: [] }, { status: 201 });
      }
      if (path === "/api/workflows" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        const definition = (await import("yaml")).parse(payload.content);
        const workflow = { definition, content: payload.content, revision: `${definition.id}-r1`, valid: true, errors: [], referenced_prompts: definition.nodes.filter((node: any) => node.prompt).map((node: any) => node.prompt) };
        workflows.push(workflow); workflowReleases.releases.push({ workflow_id: definition.id, revision: workflow.revision, version: 1, label: payload.label || "v1", status: "active", published_at: new Date().toISOString(), parent_revision: null, is_default: true, definition }); return Response.json({ workflow }, { status: 201 });
      }
      if (path.startsWith("/api/workflows/") && init?.method === "PUT") {
        const payload = JSON.parse(String(init.body));
        const definition = (await import("yaml")).parse(payload.content);
        const workflow = { definition, content: payload.content, revision: `${definition.id}-r2`, valid: true, errors: [], referenced_prompts: definition.nodes.filter((node: any) => node.prompt).map((node: any) => node.prompt) };
        workflows = workflows.map((item) => item.definition.id === definition.id ? workflow : item);
        if (payload.make_default) workflowReleases.releases.forEach((release: any) => {
          if (release.workflow_id === definition.id) {
            release.is_default = false;
            if (release.status === "active") release.status = "retired";
          }
        });
        workflowReleases.releases.push({ workflow_id: definition.id, revision: workflow.revision, version: 2, label: payload.label || "v2", status: payload.make_default ? "active" : "trial", published_at: new Date().toISOString(), parent_revision: "workflow-r1", is_default: payload.make_default, definition });
        return Response.json({ workflow });
      }
      if (path.startsWith("/api/prompts/") && path.endsWith("/preview") && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        return Response.json({ rendered: `Rendered dummy assignment for AGENT-0042\n${payload.content}` });
      }
      if (path.startsWith("/api/prompts/") && init?.method === "PUT") {
        const name = decodeURIComponent(path.split("/").at(-1)!);
        const payload = JSON.parse(String(init.body));
        const prompt = { ...prompts.find((item) => item.name === name), content: payload.content, revision: `${name}-r2` };
        prompts = prompts.map((item) => item.name === name ? prompt : item);
        return Response.json({ prompt });
      }
      if (path === "/api/tickets/next-id" && !init?.method) return Response.json({ id: "AGENT-0001" });
      if (path === "/api/config" && init?.method === "PUT") {
        const payload = JSON.parse(String(init.body));
        trackerConfig = { ...trackerConfig, ...payload, revision: trackerConfig.revision + 1 };
        return Response.json({ config: trackerConfig, quota: quotaReport });
      }
      if (path.startsWith("/api/tickets/APT-42/attachments?") && init?.method === "POST") {
        const file = init.body as File;
        current.frontmatter.attachments.push({ id: "attachment-1", filename: new URL(path, "http://test").searchParams.get("filename"), content_type: init.headers && (init.headers as Record<string, string>)["X-Attachment-Content-Type"], size_bytes: file.size, sha256: "a".repeat(64), created_at: "2026-08-20T00:00:00Z" });
        current.frontmatter.revision += 1;
        return Response.json(current, { status: 201 });
      }
      if (path === "/api/tickets/APT-42/attachments/attachment-1" && init?.method === "DELETE") {
        current.frontmatter.attachments = [];
        current.frontmatter.revision += 1;
        return Response.json(current);
      }
      if (path === "/api/tickets/APT-42/artifacts/evidence-1/content" && !init?.method) {
        return new Response("# Review summary\n\n- Verification passed.\n- Ready for approval.", { headers: { "Content-Type": "text/markdown" } });
      }
      if (path === "/api/tickets/APT-42/artifacts/trace-1/content" && !init?.method) {
        return new Response([
          JSON.stringify({ sequence: 1, timestamp: "2026-08-14T11:00:00Z", elapsed_ms: 0, event: "herdr.command_started", data: { command: "agent.prompt", payload_bytes: 400, payload_sha256: "1".repeat(64) } }),
          JSON.stringify({ sequence: 2, timestamp: "2026-08-14T11:00:01Z", elapsed_ms: 1000, event: "delivery.confirmed", data: { confirmation: "direct" } }),
        ].join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
      }
      if (path === "/api/tickets/APT-42" && !init?.method) return Response.json(current);
      if (path === "/api/tickets/APT-42" && init?.method === "PUT") {
        current = { ...current, markdown: String(JSON.parse(String(init.body)).markdown) };
        return Response.json(current);
      }
      if (path === "/api/tickets/APT-42/workflow/migrate" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        current.frontmatter.workflow.current_node = payload.node_id;
        current.workflow_node = structuredClone(workflowDefinition.nodes.find((node) => node.id === payload.node_id));
        return Response.json(current);
      }
      if (path === "/api/tickets/APT-42/priority" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        current.frontmatter.priority = payload.priority;
        current.frontmatter.revision += 1;
        return Response.json(current);
      }
      if (path === "/api/tickets/APT-42/draft" && init?.method === "POST") {
        current.frontmatter.status = "pending";
        current.frontmatter.execution = null;
        current.frontmatter.revision += 1;
        return Response.json(current);
      }
      if (path === "/api/tickets/APT-42/decide" && init?.method === "POST") {
        current.frontmatter.status = "ready";
        current.frontmatter.workflow.current_node = "implementation";
        return Response.json(current);
      }
      if (path.startsWith("/api/tickets/APT-42/questions/") && path.endsWith("/answer") && init?.method === "POST") {
        const questionId = decodeURIComponent(path.split("/").at(-2)!);
        const payload = JSON.parse(String(init.body));
        current.frontmatter.questions = current.frontmatter.questions.map((question: any) => question.id === questionId
          ? { ...question, answer: payload.answer, answered_at: "2026-08-14T12:02:00Z" } : question);
        return Response.json(current);
      }
      if (path === "/api/tickets" && init?.method === "POST") return Response.json({
        error: "Ticket is invalid", details: ["repositories[0].id must be a non-empty string"],
      }, { status: 422 });
      throw new Error(`Unexpected request: ${path}`);
    }));
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    vi.restoreAllMocks();
  });

  it("switches among all themes and restores the saved preference", async () => {
    const firstRender = render(<App />);
    const dark = await screen.findByRole("button", { name: "Use Dark theme" });
    expect(dark).toHaveAttribute("aria-pressed", "true");
    const selector = screen.getByRole("group", { name: "Theme" });
    expect(within(selector).getAllByRole("button")).toHaveLength(3);
    expect(within(selector).queryByText("Light")).not.toBeInTheDocument();
    expect(within(selector).queryByText("Dark")).not.toBeInTheDocument();
    expect(within(selector).queryByText("Retro Hacker")).not.toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));

    fireEvent.click(screen.getByRole("button", { name: "Use Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("agentic-project-tracker.theme")).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "Use Retro Hacker theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "retro");
    expect(window.localStorage.getItem("agentic-project-tracker.theme")).toBe("retro");

    firstRender.unmount();
    render(<App />);
    expect(await screen.findByRole("button", { name: "Use Retro Hacker theme" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps workflows, prompts, and configuration visible in desktop navigation", async () => {
    render(<App />);

    const navigation = await screen.findByRole("navigation", { name: "Primary navigation" });
    expect(within(navigation).getByRole("button", { name: "Workflows" })).toBeInTheDocument();
    expect(within(navigation).getByRole("button", { name: "Prompts" })).toBeInTheDocument();
    expect(within(navigation).getByRole("button", { name: "Configuration" })).toBeInTheDocument();
    expect(within(navigation).queryByText("Build")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Open configuration")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open ticket queue" })).toBeInTheDocument();
  });

  it("puts a unified attention inbox first and exposes gate and question actions inline", async () => {
    current.frontmatter.status = "waiting_approval";
    current.frontmatter.execution = null;
    current.frontmatter.workflow.current_node = "specification-approval";
    current.workflow_node = structuredClone(workflowDefinition.nodes.find((node) => node.id === "specification-approval"));
    current.frontmatter.questions = [{ id: "question-1", question: "**Which rollout window?**", options: ["Morning", "Evening"], asked_at: "2026-08-14T12:00:00Z", answer: null, answered_at: null }];
    summary.attention = { kinds: ["question", "human_gate"], pending_questions: 1, wait_wake_at: null, wait_deadline_at: null, delivery_failure_summary: null, github_feedback_summary: null };

    render(<App />);
    const navigation = await screen.findByRole("navigation");
    expect(within(navigation).getAllByRole("button")[0]).toHaveTextContent("Inbox");
    fireEvent.click(within(navigation).getByRole("button", { name: /Inbox/ }));

    const answer = await screen.findByRole("textbox", { name: /Inbox answer/ });
    const item = answer.closest("article")!;
    expect(within(item).getByText("Which rollout window?")).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: "Morning" })).toBeInTheDocument();
    expect(answer).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: /^Approve/ })).toBeInTheDocument();
    expect(within(item).getByRole("button", { name: /^Request changes/ })).toBeInTheDocument();
  });

  it("restores the selected ticket, evidence position, graph zoom, and queue filters", async () => {
    current.frontmatter.artifacts = [{ id: "evidence-1", kind: "evidence", ticket_id: "APT-42", node_run_id: null, filename: "review.md", content_type: "text/markdown", size_bytes: 72, sha256: "f".repeat(64), created_at: "2026-08-14T11:05:00Z", metadata: { presentation: { title: "Release review", category: "review", featured: true } } }];
    window.localStorage.setItem("agentic-project-tracker.view", JSON.stringify("tickets"));
    window.localStorage.setItem("agentic-project-tracker.selected-ticket", JSON.stringify("APT-42"));
    window.localStorage.setItem("agentic-project-tracker.evidence.tab", JSON.stringify("review"));
    window.localStorage.setItem("agentic-project-tracker.evidence.preview.APT-42", JSON.stringify("evidence-1"));
    window.localStorage.setItem("agentic-project-tracker.graph.zoom", JSON.stringify(1.15));

    const first = render(<App />);
    expect(await screen.findByRole("heading", { name: "UI ticket" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("115%");
    expect(await screen.findByRole("heading", { name: "Review summary" })).toBeInTheDocument();
    first.unmount();

    window.localStorage.removeItem("agentic-project-tracker.selected-ticket");
    window.localStorage.setItem("agentic-project-tracker.queue.query", JSON.stringify("dashboard"));
    window.localStorage.setItem("agentic-project-tracker.queue.status", JSON.stringify("running"));
    render(<App />);
    expect(await screen.findByLabelText("Search tickets")).toHaveValue("dashboard");
    expect(screen.getByLabelText("Queue status")).toHaveValue("running");
  });

  it("authors campaigns and sources through structured intake forms while retaining advanced YAML", async () => {
    // Arrange and execute
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Intake" }));
    expect(await screen.findByRole("heading", { name: "Campaigns & intake" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Campaign/ }));

    // Verify campaign form
    expect(screen.getByLabelText("Campaign ID")).toHaveValue("new-campaign");
    expect(screen.getByLabelText("Campaign name")).toHaveValue("New campaign");
    expect(screen.getByLabelText("New per run")).toHaveValue(100);
    fireEvent.click(screen.getByRole("button", { name: "Performance" }));
    expect(screen.getByLabelText("Campaign ID")).toHaveValue("performance-improvement");
    expect((screen.getByLabelText("Intake definition YAML") as HTMLTextAreaElement).value).toContain("performance-improvement");

    // Execute and verify source form
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    expect(screen.getByLabelText("Source campaign")).toHaveValue("continuous-improvement");
    expect(screen.getByLabelText("Source workflow")).toHaveValue("standard-delivery");
    expect(screen.getByLabelText("Source repository 1")).toHaveAttribute("list", "intake-repository-catalog");
    fireEvent.click(screen.getByRole("button", { name: /New relic/i }));
    expect(screen.getByLabelText("Source language")).toHaveValue("python");
    expect(screen.getByRole("button", { name: "Save & test discovery" })).toBeEnabled();
  });

  it("presents a live ticket as a workflow-focused issue instead of a raw editor", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const workflow = await screen.findByRole("region", { name: "Ticket workflow" });
    expect(workflow.querySelector<HTMLElement>(".factory-node")?.style.height).toBe("224px");
    expect(within(workflow).getByRole("heading", { name: "Workflow · Standard delivery · v1" })).toBeInTheDocument();
    expect(within(workflow).queryByText(/standard-delivery@/i)).not.toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("/srv/projects/demo")).toBeInTheDocument();
    expect(screen.getByText("herdr:claude · id")).toBeInTheDocument();
    expect(screen.getByText("Ship a clear dashboard.")).toBeInTheDocument();
    expect(screen.getByText("Work Claimed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open draft PR/i })).toHaveAttribute("href", "https://github.com/example/demo/pull/42");
    expect(screen.queryByLabelText("Raw ticket Markdown")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save ticket" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("What happens next")).toHaveTextContent("Claude working");
    expect(screen.getByLabelText("What happens next")).toHaveTextContent("Agent callback selects the next path");
    expect(screen.getAllByText("Running")).toHaveLength(1);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Elapsed")).toBeInTheDocument();
  });

  it("explains a cumulative node-cost pause and requires workflow migration instead of retry", async () => {
    current.frontmatter.status = "blocked";
    current.frontmatter.execution = null;
    current.frontmatter.workflow.cost_limit_pause = {
      workflow_id: "standard-delivery", node_id: "implementation", limit_usd: 50, observed_usd: 52.75, paused_at: "2026-08-14T12:02:00Z",
    };

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /APT-42 UI ticket/ }));

    expect(await screen.findByText("Node cost limit reached")).toBeInTheDocument();
    expect(screen.getByText(/accumulated \$52\.75 against its \$50\.00 limit/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry node" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Migrate workflow" })).toBeInTheDocument();
  });

  it("offers workflow migration for an inactive cancelled ticket", async () => {
    current.frontmatter.status = "cancelled";
    current.frontmatter.execution = null;
    const prompt = vi.spyOn(window, "prompt")
      .mockReturnValueOnce("standard-delivery")
      .mockReturnValueOnce("implementation");

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /APT-42 UI ticket/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Migrate workflow" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42/workflow/migrate", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"node_id":"implementation"'),
    })));
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("keeps a long Herdr pane name inside the responsive runtime heading", async () => {
    const paneName = "apt_agent00_b30459488a_claude_wg";
    current.frontmatter.execution.herdr_observation.display_name = paneName;

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));

    const heading = await screen.findByRole("heading", { name: paneName });
    expect(heading).toHaveAttribute("title", paneName);
    expect(heading.closest(".runtime-heading")).toBeInTheDocument();
  });

  it("separates assignment delivery from neutral Herdr idle observations", async () => {
    current.frontmatter.execution.delivery_status = "delivered";
    current.frontmatter.execution.delivery_confirmed_at = "2026-08-14T12:00:05Z";
    current.frontmatter.execution.observed_herdr_state = "idle";
    current.frontmatter.execution.herdr_observation = {
      ...current.frontmatter.execution.herdr_observation,
      state: "idle",
    };

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));

    expect(await screen.findByText("Herdr observation")).toBeInTheDocument();
    expect(screen.getAllByText("Idle").length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent settled without a ticket callback")).not.toBeInTheDocument();
    expect(screen.queryByText("Preparing the agent and confirming assignment delivery.")).not.toBeInTheDocument();
  });

  it("shows an agent claim as starting until prompt delivery is confirmed", async () => {
    current.frontmatter.execution.delivery_status = "starting";
    current.frontmatter.execution.delivery_confirmed_at = null;

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));

    expect(await screen.findByText("Preparing the agent and confirming assignment delivery.")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("opens node-scoped run details and provenance from the ticket workflow graph", async () => {
    const usage = { input_tokens: 2_000, cached_input_tokens: 20_000, cache_write_input_tokens: 1_000, output_tokens: 4_000, reasoning_output_tokens: 400, total_tokens: 27_400 };
    const telemetry = {
      baseline: { schema_version: 1, harness: "claude", session_ref: "session-1", observed_at: "2026-08-14T11:00:00Z", source: { kind: "session_log", detail: "session.jsonl" }, model: { id: "claude-opus-4-8", provider: "anthropic", observed_ids: ["claude-opus-4-8"] }, reasoning: { effort: "high", enabled: true, source: "session" }, usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }, cost: { total_usd: 0, kind: "reported" }, context: { used_tokens: null, window_tokens: null, used_percent: null }, rate_limits: [], attributes: {} },
      latest: { schema_version: 1, harness: "claude", session_ref: "session-1", observed_at: "2026-08-14T11:05:00Z", source: { kind: "session_log", detail: "session.jsonl" }, model: { id: "claude-opus-4-8", provider: "anthropic", observed_ids: ["claude-opus-4-8"] }, reasoning: { effort: "high", enabled: true, source: "session" }, usage, cost: { total_usd: 1.25, kind: "reported" }, context: { used_tokens: 27_400, window_tokens: 200_000, used_percent: 13.7 }, rate_limits: [], attributes: {} },
      delta: { usage, cost_usd: 1.25 },
    };
    current.frontmatter.workflow.node_runs = [{
      id: "implementation-run", workflow_revision: "workflow-r1", node_id: "implementation", node_type: "agent",
      visit: 1, attempt: 1, status: "completed", outcome: "completed", summary: "Implemented the requested change.", handoff: "Review the pull request.",
      started_at: "2026-08-14T11:00:00Z", completed_at: "2026-08-14T11:05:00Z", lease_id: "lease-implementation", provider: "claude", supervisor_id: "worker-a", telemetry,
      timing: { active_ms: 300_000, quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, state: "active", last_accounted_at: null, pause_limit_id: null, pause_until: null },
    }];
    current.frontmatter.artifacts = [
      {
        id: "evidence-1", kind: "agent_transcript", ticket_id: "APT-42", node_run_id: "implementation-run", filename: "implementation.herdr.txt", content_type: "text/plain",
        size_bytes: 72, sha256: "f".repeat(64), created_at: "2026-08-14T11:05:00Z", metadata: { presentation: { title: "Implementation transcript", category: "provenance" } },
      },
      { id: "trace-1", kind: "execution_trace", ticket_id: "APT-42", node_run_id: "implementation-run", filename: "implementation-run.000001-000003.herdr-trace.jsonl", content_type: "application/x-ndjson", size_bytes: 400, sha256: "1".repeat(64), created_at: "2026-08-14T11:01:30Z", metadata: { trace_id: "trace-id", first_sequence: 1, last_sequence: 3, event_count: 3, completed: false } },
      { id: "trace-2", kind: "execution_trace", ticket_id: "APT-42", node_run_id: "implementation-run", filename: "implementation-run.000004-000007.herdr-trace.jsonl", content_type: "application/x-ndjson", size_bytes: 500, sha256: "2".repeat(64), created_at: "2026-08-14T11:05:00Z", metadata: { trace_id: "trace-id", first_sequence: 4, last_sequence: 7, event_count: 4, completed: true } },
    ];

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const graph = await screen.findByLabelText("Workflow graph");
    fireEvent.click(within(graph).getByRole("button", { name: /Implementation/i }));

    const dialog = await screen.findByRole("dialog", { name: "Workflow node details: Implementation" });
    expect(within(dialog).getByText("Implemented the requested change.")).toBeInTheDocument();
    expect(within(dialog).getByText("Review the pull request.")).toBeInTheDocument();
    expect(within(dialog).getByText("Implementation transcript")).toBeInTheDocument();
    expect(within(dialog).getByText(/Provenance ·/)).toBeInTheDocument();
    expect(within(dialog).getByText("27.4K")).toBeInTheDocument();
    expect(within(dialog).getByText("$1.25")).toBeInTheDocument();
    expect(within(dialog).getByText("claude-opus-4-8")).toBeInTheDocument();
    expect(within(dialog).getByText(/Anthropic · High Reasoning/)).toBeInTheDocument();
    expect(within(dialog).getByText(/7 events · 2 chunks/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Herdr operational trace/)).toHaveLength(1);
    expect(within(dialog).getByText("2 items")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Workflow node details: Implementation" })).not.toBeInTheDocument();
  });

  it("browses complete ticket evidence, provenance, and run history from one view", async () => {
    const timing = { active_ms: 1_000, quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, state: "active", last_accounted_at: null, pause_limit_id: null, pause_until: null };
    current.frontmatter.workflow.node_runs = Array.from({ length: 13 }, (_, index) => ({
      id: `run-${index}`, workflow_revision: "workflow-r1", node_id: index === 0 ? "historic-run" : "implementation", node_type: index === 12 ? "script" : "agent",
      visit: index + 1, attempt: 1, status: "completed", outcome: "completed", summary: `Run ${index} finished.`,
      started_at: "2026-08-14T11:00:00Z", completed_at: "2026-08-14T11:01:00Z", lease_id: `lease-${index}`, provider: index === 12 ? null : "claude", telemetry: null, timing,
      ...(index === 12 ? { supervisor_id: "worker-a", provider: "claude", input_revision: 7, conversation_generation: 2, output_path: ".runs/output.log", output_bytes: 2_048, manifest_artifact_id: "execution-manifest" } : {}),
    }));
    current.frontmatter.artifacts = [
      { id: "evidence-1", kind: "evidence", ticket_id: "APT-42", node_run_id: "run-12", filename: "review.md", content_type: "text/markdown", size_bytes: 72, sha256: "f".repeat(64), created_at: "2026-08-14T11:05:00Z", metadata: { presentation: { title: "Release review", description: "Readable outside a human gate.", category: "review", featured: true } } },
      { id: "execution-manifest", kind: "execution_manifest", ticket_id: "APT-42", node_run_id: "run-12", filename: "run-12.execution-manifest.json", content_type: "application/json", size_bytes: 900, sha256: "a".repeat(64), created_at: "2026-08-14T11:04:00Z", metadata: {} },
      { id: "script-report", kind: "script_artifact", ticket_id: "APT-42", node_run_id: "run-11", filename: "verification.html", content_type: "text/html", size_bytes: 1_024, sha256: "b".repeat(64), created_at: "2026-08-14T11:03:00Z", metadata: {} },
      { id: "checkpoint-manifest", kind: "checkpoint_manifest", ticket_id: "APT-42", node_run_id: "run-12", filename: "checkpoint-1.json", content_type: "application/json", size_bytes: 500, sha256: "c".repeat(64), created_at: "2026-08-14T11:02:00Z", metadata: {} },
      { id: "checkpoint-bundle", kind: "checkpoint_bundle", ticket_id: "APT-42", node_run_id: "run-12", filename: "demo.bundle", content_type: "application/x-git-bundle", size_bytes: 4_096, sha256: "d".repeat(64), created_at: "2026-08-14T11:01:00Z", metadata: {} },
      { id: "trace-1", kind: "execution_trace", ticket_id: "APT-42", node_run_id: "run-12", filename: "run-12.000001-000002.herdr-trace.jsonl", content_type: "application/x-ndjson", size_bytes: 400, sha256: "1".repeat(64), created_at: "2026-08-14T11:01:30Z", metadata: { trace_id: "trace-id", first_sequence: 1, last_sequence: 2, event_count: 2, completed: true } },
      { id: "transcript-1", kind: "agent_transcript", ticket_id: "APT-42", node_run_id: "run-10", filename: "implementation.herdr.txt", content_type: "text/plain", size_bytes: 2_400, sha256: "2".repeat(64), created_at: "2026-08-14T11:01:40Z", metadata: { source: "herdr", completeness: "bounded", disposition: "callback", presentation: { title: "Agent session transcript", description: "Bounded Herdr capture at callback.", category: "provenance" } } },
      { id: "native-1", kind: "harness_session_log", ticket_id: "APT-42", node_run_id: "run-10", filename: "session-claude.jsonl", content_type: "application/x-ndjson", size_bytes: 6_400, sha256: "3".repeat(64), created_at: "2026-08-14T11:01:41Z", metadata: { source: "harness", completeness: "full", disposition: "callback", provider: "claude", role: "primary", presentation: { title: "Claude native session log", description: "Complete harness capture at callback.", category: "provenance" } } },
      { id: "native-2", kind: "harness_session_log", ticket_id: "APT-42", node_run_id: "run-11", filename: "session-codex.jsonl", content_type: "application/x-ndjson", size_bytes: 7_200, sha256: "4".repeat(64), created_at: "2026-08-14T11:01:42Z", metadata: { source: "harness", completeness: "full", disposition: "callback", provider: "codex", role: "primary", presentation: { title: "Codex native session log", description: "Native capture without a Herdr transcript.", category: "provenance" } } },
    ];
    current.frontmatter.checkpoints = [{ id: "checkpoint-1", label: "Before release", kind: "workflow", node_id: "implementation", node_run_id: "run-12", created_at: "2026-08-14T11:02:00Z", manifest_artifact_id: "checkpoint-manifest", repositories: [{ repository: "demo", head_sha: "1".repeat(40), snapshot_sha: "2".repeat(40), branch: "main", remote_url: "https://github.com/example/demo.git", dirty: true, bundle_artifact_id: "checkpoint-bundle" }] }];
    current.frontmatter.attachments = [{ id: "attachment-1", filename: "requirements.txt", content_type: "text/plain", size_bytes: 42, sha256: "e".repeat(64), created_at: "2026-08-14T10:00:00Z" }];

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const evidence = (await screen.findByRole("heading", { name: "Evidence & artifacts" })).closest("section")!;

    expect(within(evidence).queryByText("verification.html")).not.toBeInTheDocument();
    fireEvent.click(within(evidence).getByRole("checkbox", { name: /Latest from each node/ }));
    expect(within(evidence).getByText("verification.html")).toBeInTheDocument();
    const evidenceRow = within(evidence).getByText(/Release review/).closest("article")!;
    expect(within(evidenceRow).getByText("Readable outside a human gate.")).toBeInTheDocument();
    fireEvent.click(within(evidenceRow).getByRole("button", { name: "Preview" }));
    expect(await within(evidenceRow).findByRole("heading", { name: "Review summary" })).toBeInTheDocument();
    fireEvent.click(within(evidenceRow).getByRole("button", { name: "Fullscreen" }));
    const dialog = await screen.findByRole("dialog", { name: /Artifact preview: Release review/ });
    expect(within(dialog).getByRole("heading", { name: "Release review" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(within(evidenceRow).getByRole("button", { name: "Close preview" }));
    expect(within(evidenceRow).queryByRole("heading", { name: "Review summary" })).not.toBeInTheDocument();
    fireEvent.click(within(evidence).getByRole("tab", { name: /Run history/ }));
    expect(evidence.querySelectorAll(".run-evidence")).toHaveLength(13);
    expect(within(evidence).getByText("Historic Run")).toBeInTheDocument();
    expect(within(evidence).getByText("worker-a · Claude")).toBeInTheDocument();
    expect(within(evidence).getByText("workflow-r1 · ticket r7")).toBeInTheDocument();
    fireEvent.click(within(evidence).getByRole("tab", { name: /Operational traces/ }));
    fireEvent.click(within(evidence).getByText(/Herdr operational trace/).closest("summary")!);
    expect((await within(evidence).findAllByText(/agent\.prompt/)).length).toBeGreaterThan(0);
    expect(within(evidence).getByText("Delivery Confirmed")).toBeInTheDocument();
    expect(within(evidence).getByRole("link", { name: "JSONL 1" })).toHaveAttribute("href", "/api/tickets/APT-42/artifacts/trace-1/content?download=true");
    fireEvent.click(within(evidence).getByRole("tab", { name: /Provenance/ }));
    expect(within(evidence).getByText("Agent session transcript")).toBeInTheDocument();
    expect(within(evidence).getByText("Claude native session log")).toBeInTheDocument();
    expect(within(evidence).getAllByText(/2\/12 runs with session provenance/).length).toBeGreaterThan(0);
    expect(within(evidence).getAllByText(/Native 2\/12 · Herdr 1\/12/).length).toBeGreaterThan(0);
    const provenanceTable = within(evidence).getByRole("table", { name: "Agent run provenance coverage" });
    const nativeOnlyRow = within(provenanceTable).getByText("Visit 12 · attempt 1").closest<HTMLElement>("[role='row']")!;
    expect(within(nativeOnlyRow).getAllByText("Captured")).toHaveLength(1);
    expect(within(nativeOnlyRow).getAllByText("Missing")).toHaveLength(3);
    expect(within(provenanceTable).getAllByText("Captured")).toHaveLength(3);
    fireEvent.click(within(evidence).getByRole("tab", { name: /Technical artifacts/ }));
    const manifestRow = within(evidence).getByText("run-12.execution-manifest.json").closest("article")!;
    expect(within(manifestRow).getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/tickets/APT-42/artifacts/execution-manifest/content?download=true");
    expect(within(evidence).getByText("run-12.execution-manifest.json")).toBeInTheDocument();
    expect(within(evidence).getByText("checkpoint-1.json")).toBeInTheDocument();
    fireEvent.click(within(evidence).getByRole("tab", { name: /Review packet/ }));
    expect(within(evidence).getByRole("link", { name: /Implementation output/ })).toHaveAttribute("href", "/api/tickets/APT-42/runs/run-12/output");
    fireEvent.click(within(evidence).getByRole("tab", { name: /Checkpoints/ }));
    expect(within(evidence).getByText("Before release")).toBeInTheDocument();
    expect(within(evidence).getByRole("link", { name: "Bundle" })).toHaveAttribute("href", "/api/tickets/APT-42/artifacts/checkpoint-bundle/content?download=true");
    fireEvent.click(within(evidence).getByRole("tab", { name: /Attachments/ }));
    expect(within(evidence).getByText("requirements.txt")).toBeInTheDocument();
    expect(within(evidence).getByLabelText("Add ticket attachments")).toBeInTheDocument();
  });

  it("summarizes a completed execution path, accounting, evidence, PRs, and production result", async () => {
    const timing = { active_ms: 60_000, quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, state: "active", last_accounted_at: null, pause_limit_id: null, pause_until: null };
    current.frontmatter.status = "completed";
    current.frontmatter.phase = "done";
    current.frontmatter.execution = null;
    current.frontmatter.production_result = "succeeded";
    current.frontmatter.production_assessment_note = "Healthy in production.";
    current.frontmatter.questions = [{ id: "q1", question: "Ship it?", options: [], answer: "Yes", asked_at: "2026-08-14T11:00:00Z", answered_at: "2026-08-14T11:01:00Z" }];
    current.frontmatter.artifacts = [
      { id: "evidence-1", kind: "evidence", ticket_id: "APT-42", node_run_id: "run-1", filename: "review.md", content_type: "text/markdown", size_bytes: 72, sha256: "f".repeat(64), created_at: "2026-08-14T11:05:00Z", metadata: { presentation: { title: "Release review", category: "review", featured: true } } },
      { id: "native-1", kind: "harness_session_log", ticket_id: "APT-42", node_run_id: "run-1", filename: "session.jsonl", content_type: "application/x-ndjson", size_bytes: 2_400, sha256: "e".repeat(64), created_at: "2026-08-14T11:05:01Z", metadata: { source: "harness", completeness: "full", role: "primary" } },
    ];
    current.frontmatter.workflow.current_node = "done";
    current.frontmatter.workflow.completed_at = "2026-08-14T12:05:00Z";
    const usage = { input_tokens: 10_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2_000, reasoning_output_tokens: 0, total_tokens: 12_000 };
    const snapshot = { schema_version: 1, harness: "claude", session_ref: "session-1", observed_at: "2026-08-14T11:01:00Z", source: { kind: "session_log", detail: "session.jsonl" }, model: { id: "claude-opus", provider: "anthropic", observed_ids: ["claude-opus"] }, reasoning: { effort: "high", enabled: true, source: "session" }, usage, cost: { total_usd: 1.25, kind: "reported" }, context: { used_tokens: 12_000, window_tokens: 200_000, used_percent: 6 }, rate_limits: [], attributes: {} };
    current.frontmatter.workflow.node_runs = [
      { id: "run-spec", workflow_revision: "workflow-r1", node_id: "specification", node_type: "agent", visit: 1, attempt: 0, status: "completed", outcome: "bypassed", summary: "Specification was disabled.", started_at: "2026-08-14T10:59:59Z", completed_at: "2026-08-14T10:59:59Z", lease_id: null, provider: null, timing, telemetry: null },
      { id: "run-1", workflow_revision: "workflow-r1", node_id: "implementation", node_type: "agent", visit: 1, attempt: 1, status: "completed", outcome: "completed", summary: "Implemented", started_at: "2026-08-14T11:00:00Z", completed_at: "2026-08-14T11:01:00Z", lease_id: "lease-1", provider: "claude", timing, telemetry: { baseline: { ...snapshot, usage: { ...usage, input_tokens: 0, output_tokens: 0, total_tokens: 0 }, cost: { total_usd: 0, kind: "reported" } }, latest: snapshot, delta: { usage, cost_usd: 1.25 } } },
      { id: "run-review", workflow_revision: "workflow-r1", node_id: "review", node_type: "agent", visit: 1, attempt: 0, status: "completed", outcome: "bypassed", summary: "Review was disabled.", started_at: "2026-08-14T11:01:01Z", completed_at: "2026-08-14T11:01:01Z", lease_id: null, provider: null, timing, telemetry: null },
    ];
    current.workflow_node = structuredClone(workflowDefinition.nodes.find((node) => node.id === "done"));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const recap = await screen.findByLabelText("Execution recap");
    expect(within(recap).getByText("Implementation")).toBeInTheDocument();
    expect(within(recap).getByText("Uncached input").parentElement).toHaveTextContent("10K");
    expect(within(recap).getByText("Cached input").parentElement).toHaveTextContent("0");
    expect(within(recap).getByText("Cache write").parentElement).toHaveTextContent("0");
    expect(within(recap).getByText("Output tokens").parentElement).toHaveTextContent("2K");
    expect(within(recap).getByText("Reasoning output").parentElement).toHaveTextContent("0");
    expect(within(recap).getByText("Reported cost").parentElement).toHaveTextContent("$1.25");
    expect(within(recap).getAllByText("1/1 executed agent runs")).toHaveLength(2);
    expect(within(recap).getByText("Provenance coverage").parentElement).toHaveTextContent("1/1");
    expect(within(recap).getByText("Provenance coverage").parentElement).toHaveTextContent("Native 1/1 · Herdr 0/1");
    expect(within(recap).getByText("$1.25")).toBeInTheDocument();
    expect(within(recap).getByRole("link", { name: /demo · PR/ })).toHaveAttribute("href", "https://github.com/example/demo/pull/42");
    expect(within(recap).getByRole("link", { name: /Release review/ })).toBeInTheDocument();
    expect(within(recap).getByText("Healthy in production.")).toBeInTheDocument();
  });

  it("shows normalized quality evidence from immutable YAML artifacts", async () => {
    current.frontmatter.workflow.node_runs = [{ id: "quality-run", workflow_revision: "workflow-r1", node_id: "implementation", node_type: "script", visit: 1, attempt: 1, status: "completed", outcome: "success", summary: "Verified", started_at: "2026-08-14T11:30:00Z", completed_at: "2026-08-14T11:31:00Z", lease_id: "quality-lease", telemetry: null, timing: { active_ms: 60_000, quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, state: "active", last_accounted_at: null, pause_limit_id: null, pause_until: null } }];
    current.frontmatter.artifacts = [{ id: "quality-artifact", kind: "quality_report", ticket_id: "APT-42", node_run_id: "quality-run", filename: "quality.yaml", content_type: "application/yaml", size_bytes: 100, sha256: "a".repeat(64), created_at: "2026-08-14T11:31:00Z", metadata: { quality_report: { schema: "agentic-quality/v1", name: "Verification", subject: { type: "repository", repository: "demo" }, attributes: [{ key: "coverage.line_percent", label: "Line coverage", value: 84.2, type: "number", unit: "percent", direction: "higher_is_better", target: 80, status: "pass", registered: true }] } } }];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    expect(await screen.findByRole("heading", { name: "Quality" })).toBeInTheDocument();
    expect(screen.getByText("Line coverage")).toBeInTheDocument();
    expect(screen.getByText("84.2 percent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "YAML ↗" })).toHaveAttribute("href", "/api/tickets/APT-42/artifacts/quality-artifact/content");
  });

  it("shows only the newest quality observation for the same node, subject, and attribute", async () => {
    // Arrange
    current.frontmatter.workflow.node_runs = [{ id: "quality-run", workflow_revision: "workflow-r1", node_id: "implementation", node_type: "script", visit: 1, attempt: 1, status: "completed", outcome: "success", summary: "Verified", started_at: "2026-08-14T11:30:00Z", completed_at: "2026-08-14T11:32:00Z", lease_id: "quality-lease", telemetry: null, timing: { active_ms: 120_000, quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, state: "active", last_accounted_at: null, pause_limit_id: null, pause_until: null } }];
    const report = (value: number, registered: boolean, repository = "demo") => ({ schema: "agentic-quality/v1", name: "Verification", subject: { type: "repository", repository }, attributes: [{ key: "coverage.line_percent", label: "Line coverage", value, type: "number", unit: "percent", direction: "higher_is_better", target: 80, status: value >= 80 ? "pass" : "fail", registered }] });
    current.frontmatter.artifacts = [
      { id: "quality-old", kind: "quality_report", ticket_id: "APT-42", node_run_id: "quality-run", filename: "old.yaml", content_type: "application/yaml", size_bytes: 100, sha256: "a".repeat(64), created_at: "2026-08-14T11:31:00Z", metadata: { quality_report: report(55, true) } },
      { id: "quality-new", kind: "quality_report", ticket_id: "APT-42", node_run_id: "quality-run", filename: "new.yaml", content_type: "application/yaml", size_bytes: 100, sha256: "b".repeat(64), created_at: "2026-08-14T11:32:00Z", metadata: { quality_report: report(88, false) } },
      { id: "quality-other", kind: "quality_report", ticket_id: "APT-42", node_run_id: "quality-run", filename: "other.yaml", content_type: "application/yaml", size_bytes: 100, sha256: "c".repeat(64), created_at: "2026-08-14T11:33:00Z", metadata: { quality_report: report(77, true, "shared") } },
    ];

    // Act
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));

    // Assert
    expect(await screen.findByText("88 percent")).toBeInTheDocument();
    expect(screen.getByText("77 percent")).toBeInTheDocument();
    expect(screen.queryByText("55 percent")).not.toBeInTheDocument();
    expect(screen.getByText(/unregistered/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "YAML ↗" }).map((link) => link.getAttribute("href"))).toEqual(expect.arrayContaining([
      "/api/tickets/APT-42/artifacts/quality-new/content",
      "/api/tickets/APT-42/artifacts/quality-other/content",
    ]));
  });

  it("shows exact harness model, reasoning, node usage, and ticket cost coverage", async () => {
    const snapshot = {
      schema_version: 1, harness: "claude", session_ref: "claude-session", observed_at: new Date().toISOString(),
      source: { kind: "session_log", detail: "session.jsonl" }, model: { id: "claude-sonnet-4-5", provider: "anthropic", observed_ids: ["claude-sonnet-4-5"] },
      reasoning: { effort: "high", enabled: true, source: "session" },
      usage: { input_tokens: 900, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 },
      cost: { total_usd: 0.023456, kind: "estimated" }, context: { used_tokens: 1100, window_tokens: 100000, used_percent: 1.1 },
      rate_limits: [], attributes: { cli_version: "1.2.3" },
    };
    const telemetry = { baseline: { ...snapshot, usage: { ...snapshot.usage, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 }, cost: { total_usd: 0, kind: "reported" } }, latest: snapshot, delta: { usage: snapshot.usage, cost_usd: 0.023456 } };
    current.frontmatter.execution.telemetry = telemetry;
    current.frontmatter.workflow = {
      id: "standard-delivery", revision: "workflow-r1", current_node: "implementation", transition_count: 1,
      started_at: new Date(Date.now() - 120_000).toISOString(), completed_at: null, current_node_entered_at: new Date(Date.now() - 120_000).toISOString(),
      node_visits: { implementation: 1 }, node_attempts: {}, prompt_revisions: {}, inputs: {}, stage_enabled: {}, incoming: null,
      node_runs: [{ id: "run-1", workflow_revision: "workflow-r1", node_id: "implementation", node_type: "agent", visit: 1, attempt: 1, status: "running", outcome: null, summary: null, started_at: new Date(Date.now() - 60_000).toISOString(), completed_at: null, lease_id: "lease-1", provider: "claude", telemetry, timing: { active_ms: 30_000, quota_paused_ms: 30_000, human_wait_ms: 0, state: "quota_paused", last_accounted_at: new Date().toISOString(), pause_limit_id: "five_hour", pause_until: new Date(Date.now() + 60_000).toISOString() } }],
    };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    expect((await screen.findAllByText("claude-sonnet-4-5")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("high").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.1K").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0.02").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$0\.023/)).not.toBeInTheDocument();
    const usageCard = screen.getByLabelText("Ticket usage");
    expect(within(usageCard).getByText("Uncached input").parentElement).toHaveTextContent("900");
    expect(within(usageCard).getByText("Cached input").parentElement).toHaveTextContent("100");
    expect(within(usageCard).getByText("Cache write").parentElement).toHaveTextContent("0");
    expect(within(usageCard).getByText("Output tokens").parentElement).toHaveTextContent("100");
    expect(within(usageCard).getByText("Reasoning output").parentElement).toHaveTextContent("0");
    expect(within(usageCard).getByText("Estimated cost").parentElement).toHaveTextContent("$0.02");
    const workflowCard = screen.getByLabelText("Ticket workflow");
    expect(within(workflowCard).getByText("Uncached 900 · Cached 100 · Write 0")).toBeInTheDocument();
    expect(within(workflowCard).getByText("Out 100")).toBeInTheDocument();
    expect(within(workflowCard).getByText("Estimated cost $0.02")).toBeInTheDocument();
    expect(screen.getByText(/Cost coverage: 1\/1/)).toBeInTheDocument();
    expect(screen.getByText("Quota paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Run history/ }));
    expect(screen.getAllByText(/30s quota paused/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Uncached 900 · Cached 100 · Write 0 · Output 100/)).toBeInTheDocument();
  });

  it("sorts the ticket queue by most recently updated by default", async () => {
    extraTicketSummaries = [
      { ...summary, id: "APT-NEW", title: "Newest ticket", status: "completed", updated_at: "2026-08-14T13:00:00Z" },
      { ...summary, id: "APT-OLD", title: "Oldest ticket", status: "blocked", updated_at: "2026-08-14T10:00:00Z" },
    ];

    render(<App />);
    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("button").textContent)).toEqual([
      expect.stringContaining("APT-NEW"),
      expect.stringContaining("APT-42"),
      expect.stringContaining("APT-OLD"),
    ]);
    expect(screen.getByText("Most recently updated tickets appear first.")).toBeInTheDocument();
  });

  it("allows priority changes while a ticket is live", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: /Ticket queue/i })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const priority = await screen.findByLabelText("Ticket priority");
    expect(priority).toHaveValue(50);
    fireEvent.change(priority, { target: { value: "75" } });
    const update = within(priority.parentElement!).getByRole("button", { name: "Update" });
    await waitFor(() => expect(update).toBeEnabled());
    fireEvent.click(update);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42/priority", expect.objectContaining({
      method: "POST", body: expect.stringContaining('"priority":75'),
    })));
    expect(await screen.findByLabelText("Ticket priority")).toHaveValue(75);
  });

  it("uploads ticket attachments from a live ticket and displays their metadata", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    fireEvent.click(await screen.findByRole("tab", { name: /Attachments/ }));
    const input = await screen.findByLabelText("Add ticket attachments");
    const file = new File(["image bytes"], "example.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("example.png")).toBeInTheDocument();
    expect(screen.getByText(/image\/png/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/tickets/APT-42/attachments?"), expect.objectContaining({
      method: "POST", body: file, headers: expect.objectContaining({ "X-Attachment-Content-Type": "image/png" }),
    }));
  });

  it("returns an unclaimed ready ticket to the editable draft state", async () => {
    current.frontmatter.status = "ready";
    current.frontmatter.execution = null;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Return to draft" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42/draft", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByRole("heading", { name: "Edit work ticket" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark ready" })).toBeInTheDocument();
  });

  it("shows supervisor host, root, agents, and ticket reservation on the health page", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Operations/i }));
    expect(await screen.findByRole("heading", { name: "Tracker readiness" })).toBeInTheDocument();
    expect(screen.getByText("1/1 valid · generation 3")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "coordinator-vm" })).toBeInTheDocument();
    expect(screen.getByText("192.0.2.70")).toBeInTheDocument();
    expect(screen.getByText("/srv/projects")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("Disabled in Configuration → Integrations")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /APT-42 · UI ticket/i })).toBeInTheDocument();
  });

  it("shows revision-aware workflow reliability, distributions, and production outcomes on the metrics page", async () => {
    workflowReleases.releases[0].version = 15;
    workflowReleases.releases.push({ ...workflowReleases.releases[0], revision: "workflow-r2", version: 2, label: "Review trial", status: "trial", is_default: false });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Metrics" }));
    expect(await screen.findByRole("heading", { name: "Factory metrics" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Median active time")).toBeInTheDocument();
    expect(screen.getByText("Completion rate")).toBeInTheDocument();
    expect(screen.getByText("1/1 settled completed · 2 still in progress")).toBeInTheDocument();
    expect(screen.getByText("Median factory cost")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Operational signals" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Metrics workflow"), { target: { value: "standard-delivery" } });
    expect(within(screen.getByLabelText("Metrics workflow revision")).getByRole("option", { name: "v15" })).toHaveValue("workflow-r1");
    expect(within(screen.getByLabelText("Metrics workflow revision")).queryByRole("option", { name: "workflow-r1" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Reliability" }));
    expect(await screen.findByText("Nodes and branches")).toBeInTheDocument();
    expect(screen.getByText("Production outcomes")).toBeInTheDocument();
    expect(screen.getAllByText("100%", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("Completed → Done")).toBeInTheDocument();
    expect(screen.getByText("Quality attributes")).toBeInTheDocument();
    expect(screen.getAllByText("Line coverage").length).toBeGreaterThan(0);
    expect(screen.getByText("Median 84 percent")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Cost & usage" }));
    expect(screen.getByText(/complete cost/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(screen.getByRole("heading", { name: "Compare workflow revisions" })).toBeInTheDocument();
    expect(await screen.findByText("Manual trial assignment may introduce selection bias.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Active-time difference").closest("article")).toHaveClass("metric-tone-positive");
    expect(screen.getByText("Cost difference").closest("article")).toHaveClass("metric-tone-negative");
    expect(screen.getByText("Baseline nodes").closest("article")?.querySelector(".comparison-node-row > span > strong")).toHaveTextContent("Implementation");
  });

  it("edits and saves the YAML-backed repository catalog through structured fields", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    expect(await screen.findByRole("heading", { name: "Tracker configuration" })).toBeInTheDocument();
    expect(screen.getByLabelText("Repository ID 1")).toHaveValue("demo");
    fireEvent.click(screen.getByRole("tab", { name: /Agents & models/ }));
    expect(screen.getByLabelText("Enable Claude")).toBeChecked();
    fireEvent.click(screen.getByRole("tab", { name: /General & repositories/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    fireEvent.change(screen.getByLabelText("Repository ID 2"), { target: { value: "other-api" } });
    fireEvent.change(screen.getByLabelText("Repository URL 2"), { target: { value: "https://github.com/example/other-api.git" } });
    fireEvent.click(screen.getByRole("tab", { name: /Quality & artifacts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add attribute" }));
    fireEvent.change(screen.getByLabelText("Quality key 1"), { target: { value: "coverage.line_percent" } });
    fireEvent.change(screen.getByLabelText("Quality label 1"), { target: { value: "Line coverage" } });
    fireEvent.change(screen.getByLabelText("Quality unit 1"), { target: { value: "percent" } });
    fireEvent.change(screen.getByLabelText("Quality maximum 1"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/config", expect.objectContaining({
      method: "PUT", body: expect.stringMatching(/"providers":\{"enabled":\["claude","codex"\]\}/),
    })));
    expect(fetch).toHaveBeenCalledWith("/api/config", expect.objectContaining({ body: expect.stringMatching(/"quality":\{"attributes":\[\{"key":"coverage.line_percent"/) }));
    expect(await screen.findByText("r3")).toBeInTheDocument();
  });

  it("keeps focus while editing model configuration identifiers", async () => {
    // Arrange
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.click(screen.getByRole("tab", { name: /Agents & models/ }));
    const alias = screen.getByLabelText("Agent profile alias 1");

    // Execute and verify the controlled row is not remounted per keystroke.
    alias.focus();
    fireEvent.change(alias, { target: { value: "c" } });
    expect(alias).toHaveFocus();
    fireEvent.change(alias, { target: { value: "cod" } });
    expect(alias).toHaveFocus();
    expect(alias).toHaveValue("cod");

    fireEvent.click(screen.getByRole("tab", { name: /Cost & metrics/ }));
    const pricingId = screen.getByLabelText("Pricing ID 1");
    pricingId.focus();
    fireEvent.change(pricingId, { target: { value: "g" } });
    expect(pricingId).toHaveFocus();
    fireEvent.change(pricingId, { target: { value: "gpt-model" } });
    expect(pricingId).toHaveFocus();
    expect(pricingId).toHaveValue("gpt-model");
  });

  it("tracks unsaved configuration changes across tabs and can revert them", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));

    expect(await screen.findByText("Configuration saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Repository ID 1"), { target: { value: "renamed-demo" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeEnabled();
    fireEvent.click(screen.getByRole("tab", { name: /Integrations/ }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revert changes" }));
    fireEvent.click(screen.getByRole("tab", { name: /General & repositories/ }));
    expect(screen.getByLabelText("Repository ID 1")).toHaveValue("demo");
    expect(screen.getByText("Configuration saved")).toBeInTheDocument();
  });

  it("shows Claude and Codex weekly estimates and persists provider-scoped account aliases", async () => {
    // Arrange
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.click(screen.getByRole("tab", { name: /Cost & metrics/ }));

    // Act
    fireEvent.change(await screen.findByLabelText("Claude quota account alias coordinator-vm"), { target: { value: "team-claude" } });
    fireEvent.change(screen.getByLabelText("Codex quota account alias coordinator-vm"), { target: { value: "personal-codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    // Assert
    expect(screen.getByRole("heading", { name: "Weekly allowances" })).toBeInTheDocument();
    expect(screen.getByText("Claude quota account")).toBeInTheDocument();
    expect(screen.getByText("Codex quota account")).toBeInTheDocument();
    expect(screen.getByText("31%")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(screen.getByText("100M")).toBeInTheDocument();
    expect(screen.getByText("80M")).toBeInTheDocument();
    expect(screen.getByText("$200.00")).toBeInTheDocument();
    expect(screen.getByText("$150.00")).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/config", expect.objectContaining({
      method: "PUT", body: expect.stringMatching(/"claude:coordinator-vm":"team-claude"/),
    })));
    expect(fetch).toHaveBeenCalledWith("/api/config", expect.objectContaining({ body: expect.stringMatching(/"codex:coordinator-vm":"personal-codex"/) }));
  });

  it("does not invent a weekly allowance when the Codex plan reports no weekly window", async () => {
    // Arrange
    const codex = quotaReport.accounts.findIndex((account: any) => account.provider === "codex");
    quotaReport.accounts[codex] = { ...quotaReport.accounts[codex], status: "not_reported", limit_id: null, used_percent: null, window_minutes: null, resets_at: null, observed_at: null, estimated_weekly_tokens: null, estimated_weekly_api_usd: null, token_samples: 0, cost_samples: 0, direct_samples: 0, percentage_points_observed: 0, confidence: null };

    // Act
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.click(screen.getByRole("tab", { name: /Cost & metrics/ }));

    // Assert
    expect(await screen.findByText("No weekly allowance reported")).toBeInTheDocument();
    expect(screen.getByText(/expected for API-key billing/)).toBeInTheDocument();
    expect(screen.queryByText("100M")).not.toBeInTheDocument();
  });

  it("prevents duplicate quality keys and clears numeric-only settings for categorical attributes", async () => {
    // Arrange
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
    fireEvent.click(screen.getByRole("tab", { name: /Quality & artifacts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add attribute" }));
    fireEvent.change(screen.getByLabelText("Quality minimum 1"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Quality maximum 1"), { target: { value: "100" } });

    // Act
    fireEvent.change(screen.getByLabelText("Quality type 1"), { target: { value: "boolean" } });
    fireEvent.click(screen.getByRole("button", { name: "Add attribute" }));
    fireEvent.change(screen.getByLabelText("Quality key 2"), { target: { value: "quality.attribute-1" } });

    // Assert
    expect(screen.getByLabelText("Quality direction 1")).toBeDisabled();
    expect(screen.getByLabelText("Quality direction 1")).toHaveValue("neutral");
    expect(screen.getByLabelText("Quality minimum 1")).toBeDisabled();
    expect(screen.getByLabelText("Quality minimum 1")).toHaveValue(null);
    expect(screen.getByRole("alert")).toHaveTextContent("Quality attribute keys must be unique.");
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  });

  it("keeps model selection out of ticket creation", async () => {
    trackerConfig.providers.enabled = ["claude", "codex"];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));
    expect(await screen.findByLabelText("Workflow")).toHaveValue("standard-delivery");
    expect(screen.queryByLabelText("Work agent")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Review agent")).not.toBeInTheDocument();
  });

  it("explains prompt triggers and renders a dummy assignment before saving", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Prompts" }));
    expect(await screen.findByRole("heading", { name: "Prompt editor" })).toBeInTheDocument();
    expect(screen.getByText("When this runs")).toBeInTheDocument();
    expect(screen.getByText("After a phase is claimed or recovered and Herdr is attached.")).toBeInTheDocument();
    expect(screen.getByText("Available meta tags")).toBeInTheDocument();
    expect(screen.getByText("{{ticket_id}}")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview with dummy ticket" }));
    expect(await screen.findByText(/Rendered dummy assignment for AGENT-0042/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Prompt Markdown"), { target: { value: `${promptFixtures[0]!.content}\nBe concise.` } });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/prompts/assignment", expect.objectContaining({
      method: "PUT", body: expect.stringContaining('"expected_revision":"assignment-r1"'),
    })));
  });

  it("creates a new prompt independently from cloning an existing prompt", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Prompts" }));
    expect(await screen.findByRole("button", { name: "New prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone prompt" })).toBeDisabled();
    fireEvent.click(within(screen.getByLabelText("Prompt templates")).getByRole("button", { name: /Specification instructions/ }));
    expect(screen.getByRole("button", { name: "Clone prompt" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Clone prompt" }));
    expect(screen.getByLabelText("Prompt ID")).toHaveValue("copy-of-specification");
    expect(screen.getByLabelText("Prompt Markdown")).toHaveValue("specification instructions");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
    fireEvent.change(screen.getByLabelText("Prompt ID"), { target: { value: "release-check" } });
    fireEvent.change(screen.getByLabelText("Prompt Markdown"), { target: { value: "Check the release and report {{allowed_outcomes}}." } });
    fireEvent.click(screen.getByRole("button", { name: "Create prompt" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/prompts", expect.objectContaining({
      method: "POST", body: expect.stringContaining('"name":"release-check"'),
    })));
    expect((await screen.findAllByText(/release-check\.md/)).length).toBeGreaterThan(0);
  });

  it("renders and edits the workflow as a directed graph while preserving YAML revisions", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    expect(await screen.findByRole("heading", { name: "Workflow editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone workflow" })).toBeInTheDocument();
    const graph = screen.getByLabelText("Workflow graph");
    expect(within(graph).getAllByRole("button")[0]).toHaveTextContent("Specification");
    expect(graph.querySelectorAll(".factory-connector").length).toBeGreaterThan(0);
    expect(graph.querySelectorAll(".factory-connector.loop").length).toBeGreaterThan(0);
    expect(graph.querySelector('[data-route="row-return"]')).toBeInTheDocument();
    expect(graph.querySelector('.factory-connector.loop[data-route="previous-row"]')).toBeInTheDocument();
    expect(graph.querySelectorAll('.factory-connector:not(.loop)[data-port="primary-left"]').length).toBeGreaterThan(0);
    expect(graph.querySelectorAll('.factory-connector.loop[data-port="alternate-right"]').length).toBeGreaterThan(0);
    const assertConnectorPorts = (selector: string, sourceBand: [number, number], targetBand: [number, number]) => {
      const connector = graph.querySelector<SVGGElement>(selector)!;
      const source = graph.querySelector<HTMLElement>(`[data-node="${connector.dataset.source}"]`)!;
      const target = graph.querySelector<HTMLElement>(`[data-node="${connector.dataset.target}"]`)!;
      const sourceRatio = Number.parseFloat(connector.dataset.sourcePortRatio!);
      const targetRatio = Number.parseFloat(connector.dataset.targetPortRatio!);
      expect(sourceRatio).toBeGreaterThanOrEqual(sourceBand[0]);
      expect(sourceRatio).toBeLessThanOrEqual(sourceBand[1]);
      expect(targetRatio).toBeGreaterThanOrEqual(targetBand[0]);
      expect(targetRatio).toBeLessThanOrEqual(targetBand[1]);
      expect(sourceRatio).not.toBe(targetRatio);
      const expectedSourceX = Number.parseFloat(source.style.left) + Number.parseFloat(source.style.width) * sourceRatio;
      const expectedTargetX = Number.parseFloat(target.style.left) + Number.parseFloat(target.style.width) * targetRatio;
      const path = connector.querySelector("path")!.getAttribute("d")!;
      expect(path).toMatch(new RegExp(`^M ${expectedSourceX} `));
      expect(path).toContain(`H ${expectedTargetX} `);
    };
    assertConnectorPorts('.factory-connector:not(.loop)[data-route="next-row"]', [0.30, 0.38], [0.14, 0.22]);
    assertConnectorPorts('.factory-connector.loop[data-route="previous-row"]', [0.62, 0.70], [0.78, 0.86]);
    const primaryEntry = graph.querySelector<SVGGElement>('.factory-connector:not(.loop):not([data-route="direct"])[data-target="implementation"]')!;
    const primaryExit = graph.querySelector<SVGGElement>('.factory-connector:not(.loop):not([data-route="direct"])[data-source="implementation"]')!;
    expect(primaryEntry.dataset.targetPortRatio).not.toBe(primaryExit.dataset.sourcePortRatio);
    const canvas = graph.querySelector<HTMLElement>(".factory-graph")!;
    expect(canvas.style.transform).toBe("scale(1)");
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 180, clientY: 120 });
    graph.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(canvas.style.transform).toBe("scale(1)");
    Object.defineProperties(graph, {
      scrollLeft: { configurable: true, writable: true, value: 40 },
      scrollTop: { configurable: true, writable: true, value: 50 },
    });
    const pointer = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { button: { value: 1 }, pointerId: { value: 7 }, clientX: { value: clientX }, clientY: { value: clientY } });
      fireEvent(graph, event);
    };
    pointer("pointerdown", 200, 150);
    expect(graph).toHaveClass("is-panning");
    pointer("pointermove", 150, 120);
    expect(graph.scrollLeft).toBe(90);
    expect(graph.scrollTop).toBe(50);
    pointer("pointerup", 150, 120);
    expect(graph).not.toHaveClass("is-panning");
    expect(screen.getByRole("heading", { name: "Conditions & parameters" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Stages" })).toBeInTheDocument();
    expect(screen.getByLabelText("Outcome 1 label")).toHaveValue("Specification completed");
    expect(screen.getByLabelText("Outcome 1 target").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Node maximum cost")).toHaveValue(50);

    fireEvent.change(screen.getByLabelText("Node name"), { target: { value: "Write specification" } });
    fireEvent.change(screen.getByLabelText("Node maximum cost"), { target: { value: "75" } });
    expect((screen.getByLabelText("Workflow YAML") as HTMLTextAreaElement).value).toContain("name: Write specification");
    expect((screen.getByLabelText("Workflow YAML") as HTMLTextAreaElement).value).toContain("max_cost_usd: 75");
    fireEvent.click(screen.getByRole("button", { name: "Publish as trial" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/workflows/standard-delivery", expect.objectContaining({
      method: "PUT", body: expect.stringContaining("Write specification"),
    })));
  });

  it("highlights taken workflow routes and can hide untaken alternate routes", async () => {
    current.frontmatter.workflow.node_runs = [{
      id: "review-repair", workflow_id: "standard-delivery", workflow_revision: "workflow-r1", node_id: "review", node_type: "agent",
      visit: 1, attempt: 1, status: "completed", outcome: "changes_requested", summary: "Implementation needs repair.", handoff: null,
      started_at: "2026-08-14T11:55:00Z", completed_at: "2026-08-14T12:00:00Z", lease_id: "review-lease", provider: "codex",
      telemetry: null, timing: { active_ms: 300_000, quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, state: "active", last_accounted_at: null, pause_limit_id: null, pause_until: null },
    }];

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));

    const workflow = await screen.findByRole("region", { name: "Ticket workflow" });
    const graph = within(workflow).getByLabelText("Workflow graph");
    const takenRepair = () => graph.querySelector('.factory-connector[data-source="review"][data-target="implementation"]');
    expect(takenRepair()).toHaveClass("taken", "loop");
    expect(takenRepair()?.querySelector(".route-glow")).toBeInTheDocument();
    expect(takenRepair()?.querySelector(".route-line")).toBeInTheDocument();
    expect(graph.querySelector('[data-node="implementation"]')).toHaveClass("current");
    expect(within(workflow).getByRole("button", { name: "Taken + next" })).toHaveAttribute("aria-pressed", "true");
    expect(takenRepair()).toHaveClass("taken");
    expect(graph.querySelector('.factory-connector[data-source="implementation"][data-target="review"]')).toHaveClass("expected");
    expect(graph.querySelector('.factory-connector[data-source="specification"][data-target="specification-approval"]')).not.toBeInTheDocument();
    expect(graph.querySelector('.factory-connector[data-source="specification-approval"][data-target="specification"]')).not.toBeInTheDocument();

    fireEvent.click(within(workflow).getByRole("button", { name: "All routes" }));
    expect(graph.querySelector('.factory-connector[data-source="specification-approval"][data-target="specification"]')).toBeInTheDocument();
  });

  it("allocates distinct node ports when several routes share one direction", async () => {
    const sharedPortWorkflow = structuredClone(workflowDefinition);
    const implementation: any = sharedPortWorkflow.nodes.find((node) => node.id === "implementation")!;
    implementation.outcomes.push({ id: "skip_review", label: "Skip review", description: "Finish directly.", target: "done" });
    workflows = [{ definition: sharedPortWorkflow, content: stringify(sharedPortWorkflow), revision: "shared-ports-r1", version: 1, valid: true, errors: [], referenced_prompts: ["implementation"] }];

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    const graph = await screen.findByLabelText("Workflow graph");
    const sharedPrimarySources = [...graph.querySelectorAll<SVGGElement>('.factory-connector:not(.loop):not([data-route="direct"])[data-source="implementation"]')];

    expect(sharedPrimarySources).toHaveLength(2);
    expect(new Set(sharedPrimarySources.map((connector) => connector.dataset.sourcePortRatio)).size).toBe(2);
  });

  it("routes dense workflow feedback through local and reusable side lanes without extending the canvas per loop", async () => {
    const nodes = Array.from({ length: 20 }, (_, index) => index === 19
      ? { id: `node-${index}`, name: "Done", type: "terminal", phase: "done", stage: "done", terminal_status: "completed", outcomes: [], choices: [], exit_codes: [] }
      : {
          id: `node-${index}`, name: `Step ${index + 1}`, type: "agent", phase: "implementation", stage: "implementation",
          prompt: "implementation", agent_profile: "default", conversation_key: "work", max_visits: 20, max_cost_usd: 50,
          outcomes: [
            { id: "completed", label: "Continue", description: "Continue forward.", target: `node-${index + 1}` },
            ...(index >= 4 ? [{ id: "changes_requested", label: `Repair step ${index - 3}`, description: "Return for repair.", target: `node-${index - (index >= 8 ? 8 : 4)}` }] : []),
          ], choices: [], exit_codes: [],
        });
    const dense = {
      version: 2, id: "dense-delivery", name: "Dense delivery", description: "Twenty-node rendering fixture.",
      start: "node-0", max_transitions: 100, inputs: [],
      stages: [
        { id: "implementation", name: "Implementation", phase: "implementation", skippable: false, default_enabled: true },
        { id: "done", name: "Done", phase: "done", skippable: false, default_enabled: true },
      ], nodes,
    };
    workflows = [{ definition: dense, content: stringify(dense), revision: "dense-r1", version: 1, valid: true, errors: [], referenced_prompts: ["implementation"] }];

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    const graph = await screen.findByLabelText("Workflow graph");
    const canvas = graph.querySelector<HTMLElement>(".factory-graph")!;

    expect(within(graph).getAllByRole("button")).toHaveLength(20);
    expect(graph.querySelectorAll('.factory-connector.loop[data-route="previous-row"]')).toHaveLength(4);
    expect(graph.querySelectorAll('.factory-connector.loop[data-route="side-return"]')).toHaveLength(11);
    expect(graph.querySelectorAll('.factory-connector.loop[data-route="row-return"]')).toHaveLength(0);
    expect(Number.parseFloat(canvas.style.height)).toBeLessThan(1_450);
  });

  it("shows only the current default and trials until workflow history is requested", async () => {
    workflowReleases.releases.push(
      { ...structuredClone(workflowReleases.releases[0]!), revision: "workflow-r2", version: 2, label: "Review experiment", status: "trial", is_default: false },
      { ...structuredClone(workflowReleases.releases[0]!), revision: "workflow-r3", version: 3, label: "Retired experiment", status: "retired", is_default: false },
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    const releasesSection = (await screen.findByRole("heading", { name: "Default and trial revisions" })).closest("section")!;

    expect(within(releasesSection).getByText("Default revision v1 · Initial release")).toBeInTheDocument();
    expect(within(releasesSection).getByText("Trial revision v2 · Review experiment")).toBeInTheDocument();
    expect(within(releasesSection).queryByText("Revision v3 · Retired experiment")).not.toBeInTheDocument();
    fireEvent.click(within(releasesSection).getByRole("button", { name: "Show retired revisions (1)" }));
    const retiredRelease = within(releasesSection).getByText("Revision v3 · Retired experiment").closest("article")!;
    expect(within(retiredRelease).getByRole("button", { name: "Restore as default" })).toBeInTheDocument();
    expect(within(releasesSection).getByRole("button", { name: "Hide retired revisions" })).toBeInTheDocument();
  });

  it("exports a numbered workflow revision and imports its prompt bundle", async () => {
    // Arrange
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    const exportLink = await screen.findByRole("link", { name: "Export bundle" });
    expect(exportLink).toHaveAttribute("href", "/api/workflows/standard-delivery/revisions/workflow-r1/export");
    expect(exportLink).toHaveAttribute("download", "standard-delivery-v1.workflow.json");
    const importedDefinition = { ...structuredClone(workflowDefinition), id: "shared-delivery", name: "Shared delivery" };
    const bundle = {
      schema: "agentic-project-tracker/workflow-bundle/v1", exported_at: new Date().toISOString(),
      workflow: { id: "shared-delivery", revision: "shared-r1", version: 1, label: "Shared v1", content: stringify(importedDefinition) },
      prompts: [{ name: "shared-prompt", revision: "prompt-r1", version: 1, content: "Shared instructions\n" }],
      requirements: { agent_profiles: ["default"], workflows: [] },
    };

    // Execute
    fireEvent.change(screen.getByLabelText("Import workflow bundle file"), { target: { files: [new File([JSON.stringify(bundle)], "shared.workflow.json", { type: "application/json" })] } });

    // Verify
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/workflow-bundles/import", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByRole("status")).toHaveTextContent("Imported Shared delivery v1");
    expect(screen.getByRole("button", { name: /Shared delivery/ })).toBeInTheDocument();
  });

  it("starts a genuinely new minimal workflow and adds typed nodes", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow ID"), { target: { value: "release-factory" } });
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Release factory" } });
    fireEvent.click(screen.getByRole("button", { name: "＋ Script" }));
    expect(within(screen.getByLabelText("Workflow graph")).getByRole("button", { name: /Script/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Script path")).toHaveValue(".agents/actions/run.sh");
    fireEvent.change(screen.getByLabelText("Script path"), { target: { value: "tools/verify-release.sh" } });
    expect(screen.getByText(/tools\/verify-release\.sh runs from selected repository \/ \./i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Activity source"), { target: { value: "inline" } });
    const expectedEnvironment = [
      "AGENTIC_TICKET_ID", "AGENTIC_TICKET_PATH", "AGENTIC_PROJECT_ROOT", "AGENTIC_SCRIPT_PATH", "AGENTIC_WORKING_DIRECTORY", "AGENTIC_NODE_ID", "AGENTIC_NODE_NAME",
      "AGENTIC_NODE_RUN_ID", "AGENTIC_WORKFLOW_NODE_TYPE", "AGENTIC_ATTEMPT", "AGENTIC_WORKFLOW_ID",
      "AGENTIC_WORKFLOW_REVISION", "AGENTIC_WORKFLOW_PHASE", "AGENTIC_REPOSITORY_ID", "AGENTIC_REPOSITORY_PATH",
      "AGENTIC_PRIMARY_REPOSITORY_ID", "AGENTIC_PRIMARY_REPOSITORY_PATH", "AGENTIC_CURRENT_BRANCH", "AGENTIC_DEFAULT_BRANCH",
      "AGENTIC_HEAD_SHA", "AGENTIC_REMOTE_URL", "AGENTIC_REPOSITORIES_JSON", "AGENTIC_PULL_REQUESTS_JSON",
      "AGENTIC_CONTEXT_JSON", "AGENTIC_INCOMING_NODE", "AGENTIC_INCOMING_OUTCOME", "AGENTIC_INCOMING_SUMMARY",
      "AGENTIC_INCOMING_HANDOFF", "AGENTIC_INCOMING_OUTPUT", "AGENTIC_INCOMING_OUTPUT_LOG",
    ];
    const expectCompleteEnvironmentHeader = () => {
      const code = (screen.getByLabelText("Inline code") as HTMLTextAreaElement).value;
      for (const variable of expectedEnvironment) expect(code).toContain(`${variable} -`);
    };
    expectCompleteEnvironmentHeader();
    expect((screen.getByLabelText("Inline code") as HTMLTextAreaElement).value).toContain("/^AGENTIC_/");
    fireEvent.change(screen.getByLabelText("Inline language"), { target: { value: "python" } });
    expectCompleteEnvironmentHeader();
    expect((screen.getByLabelText("Inline code") as HTMLTextAreaElement).value).toContain('name.startswith("AGENTIC_")');
    fireEvent.change(screen.getByLabelText("Inline language"), { target: { value: "javascript" } });
    expectCompleteEnvironmentHeader();
    expect((screen.getByLabelText("Inline code") as HTMLTextAreaElement).value).toContain('name.startsWith("AGENTIC_")');
    fireEvent.change(screen.getByLabelText("Inline language"), { target: { value: "python" } });
    fireEvent.change(screen.getByLabelText("Inline code"), { target: { value: "import sys\nsys.exit(0)" } });
    fireEvent.change(screen.getByLabelText("Inline language"), { target: { value: "shell" } });
    expect(screen.getByLabelText("Inline code")).toHaveValue("import sys\nsys.exit(0)");
    fireEvent.change(screen.getByLabelText("Inline language"), { target: { value: "python" } });
    expect(screen.getByText(/runs with the supervisor process credentials from the configured working directory/)).toBeInTheDocument();
    expect(screen.getByLabelText("Outcome 1 exit codes")).toHaveValue("0");
    expect(screen.getByLabelText("Outcome 2 exit codes")).toHaveValue("All other / error");
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/workflows", expect.objectContaining({
      method: "POST", body: expect.stringMatching(/release-factory[\s\S]*language: python[\s\S]*sys\.exit\(0\)/),
    })));
  }, 15_000);

  it("shows a same-host repository blocker without changing the ready status", async () => {
    current.frontmatter.status = "ready";
    current.frontmatter.execution = null;
    claimBlockers = [{ hostname: "worker-vm", supervisor_id: "other-root", ticket_id: "APT-41", ticket_title: "Other work", repositories: ["demo"] }];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const blockers = within(await screen.findByRole("region", { name: "Repository claim blockers" }));
    expect(blockers.getByText("Repository work is reserved on this host")).toBeInTheDocument();
    expect(blockers.getByText("APT-41 · Other work")).toBeInTheDocument();
    expect(screen.getByText("Ticket Ready", { selector: ".status-pill" })).toBeInTheDocument();
  });

  it("offers a manual GitHub check while specification approval is pending", async () => {
    current.frontmatter.phase = "specification";
    current.frontmatter.status = "waiting_approval";
    current.frontmatter.execution = null;
    current.frontmatter.pull_requests = [{ repository: "demo", url: "https://github.com/example/demo/pull/42", phase: "specification" }];
    current.frontmatter.workflow.current_node = "specification-approval";
    current.workflow_node = structuredClone(workflowDefinition.nodes.find((node) => node.id === "specification-approval"));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const review = await screen.findByRole("region", { name: "Review materials" });
    expect(within(review).getByRole("button", { name: /Approve/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check GitHub feedback" })).toBeInTheDocument();
  });

  it("previews permissive review evidence beside the human-gate decision", async () => {
    current.frontmatter.phase = "specification";
    current.frontmatter.status = "waiting_approval";
    current.frontmatter.execution = null;
    current.frontmatter.workflow.current_node = "specification-approval";
    current.frontmatter.workflow.incoming = { source_node: "specification", target_node: "specification-approval", outcome: "completed", summary: "The proposed specification is ready for review.", handoff: "Review the evidence." };
    current.frontmatter.workflow.node_runs = [{ id: "spec-run-1", workflow_revision: "workflow-r1", node_id: "specification", node_type: "agent", visit: 1, attempt: 1, status: "completed", outcome: "completed", summary: "The proposed specification is ready for review.", started_at: "2026-08-14T12:00:00Z", completed_at: "2026-08-14T12:01:00Z", lease_id: "spec-lease", telemetry: null, timing: { active_ms: 60_000, quota_paused_ms: 0, human_wait_ms: 0, external_wait_ms: 0, state: "active", last_accounted_at: null, pause_limit_id: null, pause_until: null } }];
    current.frontmatter.artifacts = [{
      id: "evidence-1", kind: "evidence", ticket_id: "APT-42", node_run_id: "spec-run-1", filename: "review.md", content_type: "text/markdown",
      size_bytes: 66, sha256: "b".repeat(64), created_at: "2026-08-14T12:01:00Z",
      metadata: { presentation: { title: "Specification review", description: "The important decisions and verification evidence.", category: "approval", featured: true } },
    }];
    current.workflow_node = structuredClone(workflowDefinition.nodes.find((node) => node.id === "specification-approval"));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));

    const workflow = await screen.findByRole("region", { name: "Ticket workflow" });
    const review = await screen.findByRole("region", { name: "Review materials" });
    expect(workflow.nextElementSibling).toBe(review);
    expect(within(review).getByRole("heading", { name: "Approve specification" })).toBeInTheDocument();
    expect(within(review).getByRole("heading", { name: "Specification review" })).toBeInTheDocument();
    expect(within(review).getByText("The important decisions and verification evidence.")).toBeInTheDocument();
    expect(await within(review).findByText("Verification passed.")).toBeInTheDocument();
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Review pull request example/demo#42.");
    fireEvent.click(within(review).getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42/decide", expect.objectContaining({
      method: "POST",
      body: expect.stringMatching(/"decision":"approved".*"message":"Review pull request example\/demo#42\."/),
    })));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("The selected answer controls workflow routing; this comment does not."));
  });

  it("uses a structured editor while a ticket is pending", async () => {
    current.frontmatter.status = "pending";
    current.frontmatter.phase = "specification";
    current.frontmatter.execution = null;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const title = await screen.findByLabelText("Title");
    fireEvent.change(title, { target: { value: "A clearer ticket title" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "# Goal\n\nUpdated through fields." } });
    fireEvent.click(screen.getByRole("button", { name: "Save ticket" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42", expect.objectContaining({
      method: "PUT", body: expect.stringContaining("A clearer ticket title"),
    })));
  });

  it("edits workflow and stage choices without ticket-level model selectors", async () => {
    current.frontmatter.status = "pending";
    current.frontmatter.phase = "specification";
    current.frontmatter.execution = null;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    expect(await screen.findByLabelText("Workflow")).toHaveValue("standard-delivery");
    expect(screen.queryByLabelText("Work agent")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Review agent")).not.toBeInTheDocument();
  });

  it("keeps a failed creation draft visible and explains the validation failure", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));
    expect(await screen.findByLabelText("Ticket ID")).toHaveValue("AGENT-0001");
    expect(screen.getByLabelText("Ticket ID")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Repository 1"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    expect(fetch).toHaveBeenCalledWith("/api/tickets", expect.objectContaining({ body: expect.stringContaining('"auto_id":true') }));
    expect(await screen.findByRole("alert")).toHaveTextContent("repositories[0].id must be a non-empty string");
    expect(screen.getByRole("heading", { name: "Create work ticket" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Describe the work");
  });

  it("waits until submit to show new-ticket validation and uses clear priority and revision labels", async () => {
    workflowReleases.releases[0].label = "v1";
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));

    expect(await screen.findByRole("heading", { name: "Create work ticket" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Ticket priority")).toHaveAttribute("title", "Higher numbers are scheduled before lower numbers");
    expect(screen.getByRole("option", { name: "Default revision v1" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /v1 · v1/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Every repository needs a name.");
    expect(fetch).not.toHaveBeenCalledWith("/api/tickets", expect.objectContaining({ method: "POST" }));
  });

  it("keeps a custom ticket ID instead of requesting automatic allocation", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));
    fireEvent.change(await screen.findByLabelText("Ticket ID"), { target: { value: "TEAM-42" } });
    fireEvent.change(screen.getByLabelText("Repository 1"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets", expect.objectContaining({
      body: expect.stringMatching(/"auto_id":false[\s\S]*id: TEAM-42|id: TEAM-42[\s\S]*"auto_id":false/),
    })));
    expect(screen.getByLabelText("Ticket ID")).toHaveValue("TEAM-42");
  });

  it("offers configured repositories without restricting freeform repository IDs", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New ticket/i }));
    const repository = await screen.findByLabelText("Repository 1");
    expect(repository).toHaveAttribute("list", "configured-repositories");
    expect(document.querySelector('#configured-repositories option[value="demo"]')).not.toBeNull();
    expect(screen.getByText("Choose a configured repository or type any repository ID. Only configured repositories are cloned automatically.")).toBeInTheDocument();

    fireEvent.change(repository, { target: { value: "unconfigured-private-repo" } });
    expect(repository).toHaveValue("unconfigured-private-repo");
    expect(screen.getByRole("button", { name: "Create ticket" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets", expect.objectContaining({
      body: expect.stringContaining("id: unconfigured-private-repo"),
    })));
  });

  it("shows workflow conversations and the nodes that reuse them", async () => {
    current.frontmatter.phase = "done";
    current.frontmatter.status = "completed";
    current.frontmatter.execution = null;
    current.frontmatter.workflow.current_node = "done";
    current.frontmatter.workflow.stage_enabled = { specification: false, implementation: true, review: false, done: true };
    current.frontmatter.conversations = { work: { provider: "claude", herdr_pane_id: "w4:p1", session_ref: "claude-work-session" } };
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const sessions = within(await screen.findByRole("region", { name: "Agent sessions" }));
    expect(sessions.getByText("Work")).toBeInTheDocument();
    expect(sessions.getByText("Claude")).toBeInTheDocument();
    expect(sessions.getByText("Specification · Implementation")).toBeInTheDocument();
    expect(sessions.getByText("claude-work-session")).toBeInTheDocument();
  });

  it("reloads the queue with archived tickets when the archive filter is checked", async () => {
    current.frontmatter.phase = "done";
    current.frontmatter.status = "completed";
    current.frontmatter.archived_at = "2026-08-14T13:00:00Z";
    current.frontmatter.execution = null;
    render(<App />);
    expect(await screen.findByRole("heading", { name: "No tickets yet" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Archived/ }));
    expect(await screen.findByRole("button", { name: /UI ticket/i })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/tickets?include_archived=true", expect.anything());
  });

  it("places a formatted pending question below the workflow and supports suggested or freeform answers", async () => {
    current.frontmatter.status = "blocked";
    current.frontmatter.questions = [{
      id: "question-1", phase: "implementation", question: "Which **environment** should receive this change?\n\n- Consider deployment risk.\n- Preserve current data.",
      options: ["Development", "Staging", "Both"], asked_at: "2026-08-14T12:01:00Z", answer: null, answered_at: null,
    }];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    const workflow = await screen.findByRole("region", { name: "Ticket workflow" });
    const questions = await screen.findByRole("region", { name: "Agent questions" });
    expect(workflow.nextElementSibling).toBe(questions);
    expect(within(questions).getByRole("heading", { name: "Agent needs your input" })).toBeInTheDocument();
    expect(within(questions).getByText("environment").tagName).toBe("STRONG");
    expect(within(questions).getByText("Consider deployment risk.")).toBeInTheDocument();
    const answer = within(questions).getByRole("textbox");
    expect(answer).toHaveAttribute("placeholder", "Write a response or choose an option above…");
    const staging = within(questions).getByRole("button", { name: "Staging" });
    fireEvent.click(staging);
    expect(staging).toHaveAttribute("aria-pressed", "true");
    expect(answer).toHaveValue("Staging");
    fireEvent.change(answer, { target: { value: "Production after the change window" } });
    fireEvent.click(within(questions).getByRole("button", { name: "Send response" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42/questions/question-1/answer", expect.objectContaining({
      method: "POST", body: expect.stringContaining('"answer":"Production after the change window"'),
    })));
  });

  it("edits a live description while retaining and guiding the current phase", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Live ticket description"), { target: { value: "# Goal\n\nUse the revised live requirement." } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([path, init]) => path === "/api/tickets/APT-42" && init?.method === "PUT");
      expect(call).toBeDefined();
      const payload = JSON.parse(String(call?.[1]?.body));
      expect(payload.mode).toBeUndefined();
      expect(payload.markdown).toContain("Use the revised live requirement.");
    });
  });

  it("restarts edited live work at an explicit workflow node", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /UI ticket/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByLabelText("Live ticket description"), { target: { value: "# Goal\n\nSpecify this revised scope first." } });
    fireEvent.change(screen.getByLabelText("Restart node"), { target: { value: "specification" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and restart" }));
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([path, init]) => path === "/api/tickets/APT-42" && init?.method === "PUT");
      expect(call).toBeDefined();
      const payload = JSON.parse(String(call?.[1]?.body));
      expect(payload.mode).toBeUndefined();
      expect(payload.markdown).toContain("Specify this revised scope first.");
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tickets/APT-42/workflow/migrate", expect.objectContaining({
      method: "POST", body: expect.stringContaining('"node_id":"specification"'),
    })));
  });
});
