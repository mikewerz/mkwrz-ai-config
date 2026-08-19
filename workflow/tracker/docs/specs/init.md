# Lightweight AI Self-Coordinator

## Status

Approved V1 product and architecture specification. Preserved as the lightweight baseline; the additive software-factory architecture is specified in [V3](./v3.md).

## Goal

Build a lightweight system that coordinates durable development work without trying to coordinate an agent's reasoning.

> The system coordinates durable work boundaries; full-capability agents decide how to perform the work.

The system owns tickets, phase transitions, human approvals, work claims, leases, agent-session references, guidance, and durable history. Codex and Claude receive a ticket and use their normal tools, credentials, computer access, planning, and subagent capabilities to complete it.

The system does not decompose implementation into graph nodes, prescribe how an agent explores repositories, run tests on the agent's behalf, parse the agent's terminal prose, or replace the agent's own Git and GitHub workflows.

## Principles

- Coordinate only durable boundaries: specification, implementation, independent review, human approval, and terminal outcomes.
- Keep each ticket understandable and editable as one ordinary Markdown file.
- Let agents work as agents. Do not remove tools, introduce coordinator-specific sandboxes, or dictate their internal process.
- Treat an explicit agent callback as the only authoritative completion signal. Herdr lifecycle state is observational.
- Preserve task continuity by resuming the same provider conversation for later feedback and repair.
- Make claims transactional without introducing a database or distributed scheduler.
- Keep one trusted tracker instance while allowing several outbound-only supervisors, each with an isolated project root.
- Open draft pull requests, but never merge them automatically.

## System Context

```text
                         Operator
                    Markdown files + UI
                              |
                              v
                 +-------------------------+
                 |    workflow/tracker     |
                 | tickets, state, leases, |
                 | approval, guidance      |
                 +------------+------------+
                              |
                         claim/callback
                              |
                 +------------v---------------+
                 |   workflow/supervisor      |
                 | small deterministic loop   |
                 +------------+---------------+
                              |
                    prompt/observe/resume
                              |
                         +----v----+
                         |  Herdr  |
                         +----+----+
                         +----+----+
                         |         |
                       Claude    Codex
```

Herdr supplies persistent terminal sessions, lifecycle observation, prompts to agents that are already working, and native Codex and Claude session references. Its `working`, `blocked`, `idle`, and `done` states help the operator and supervisor understand liveness, but do not identify whether the assigned semantic task succeeded. See [Herdr agent automation](https://herdr.dev/docs/agent-automation/), [Herdr socket API](https://herdr.dev/docs/socket-api/), and [Herdr session restore](https://herdr.dev/docs/session-state/).

## Repository Responsibilities

### `workflow/tracker`

Owns:

- the TypeScript/Express REST service;
- the Vite/React operator UI;
- the atomically maintained local YAML configuration and repository catalog;
- discovery, parsing, validation, and atomic mutation of Markdown tickets;
- atomic work claims, leases, retries, and phase transitions;
- specification approval, comments, guidance, and the interaction timeline; and
- best-effort UI invalidation events.

It does not invoke coding agents, operate Git repositories, or run repository verification. Its GitHub responsibility is limited to observing recorded PR metadata and returning completed work to the existing implementation loop when follow-up is detected.

### `workflow/supervisor`

Owns a small native TypeScript daemon that:

- advertises an available Claude or Codex slot when claiming work;
- starts a new per-ticket provider conversation or resumes its stored session reference;
- submits the assignment prompt through Herdr and confirms that the agent lifecycle advanced;
- maintains the lease and reports observed Herdr state;
- forwards durable human guidance to the active agent; and
- reconciles the tracker's repository catalog by cloning missing repositories into its configured project root; and
- releases local capacity after the tracker records a terminal phase callback.

It contains no workflow graph, branch/worktree manager, test runner, GitHub adapter, prompt-planning engine, provider-output normalizer, or agent-result parser. Its only repository automation is idempotent initial cloning; agents retain responsibility for branches, commits, pushes, pull requests, pulls, and repository-specific verification.

### `workflow/herdr`

Owns installation and pinned configuration of Herdr on the coordinator VM, including the official Claude and Codex integrations and the named session used by the supervisor.

It does not edit agent tool availability, permissions, credentials, prompts, reasoning settings, or repository access. Agents remain normal interactive installations.

### Original `agent-coordinator`

The original project is design evidence only. This V1 does not reuse its workflow graph, immutable workflow versions, verification nodes, strict provider result contracts, provider-stream normalization, worker registration protocol, integration scheduler architecture, or database-backed scheduler.

## Deployment Model

V1 runs one central tracker on a trusted private network and one or more supervisor installations:

- one Express tracker service and its built React UI;
- one native supervisor process for each isolated project root;
- one persistent named Herdr server/session per supervisor; and
- the locally authenticated Claude and Codex installations advertised by that supervisor.

Supervisors may run on the tracker VM or other private VMs and make outbound HTTP requests to the tracker. Each has a stable `SUPERVISOR_ID`, a unique `PROJECT_ROOT`, and its own `HERDR_SESSION`. The tracker binds to loopback by default. V1 has no application authentication or RBAC and must not be exposed directly to an untrusted network. Ticket files are not automatically committed to Git.

Only one tracker process may own a ticket root. Startup obtains an exclusive operating-system lock beneath that root and fails clearly if another live process holds it.

## Tracker Configuration

The tracker owns `tracker-config.yaml` directly beneath `TICKETS_ROOT`, alongside the Markdown ticket hierarchy. It creates a valid empty configuration when the file does not exist and updates it using the same write, fsync, and atomic-rename durability discipline as tickets. The YAML file is authoritative and may gain additional top-level settings over time; repository-only UI updates preserve unknown top-level fields.

V1 configuration is:

```yaml
version: 1
revision: 1
updated_at: 2026-08-14T15:00:00Z
tickets:
  id_prefix: AGENT
  next_number: 1
providers:
  enabled:
    - claude
    - codex
repositories:
  - id: agentic-project-tracker
    url: git@github.com:example/agentic-project-tracker.git
  - id: application-api
    url: https://github.com/example/application-api.git
jira:
  enabled: false
  site_url: https://example.atlassian.net
  project_key: ENG
  issue_type: Task
github:
  observation_enabled: false
  observation_interval_minutes: 30
  ignored_logins: []
```

Repository `id` values are unique safe directory names matching `[A-Za-z0-9][A-Za-z0-9._-]*`; `.` and `..` are forbidden. URLs are nonempty Git clone sources and must also be unique. The tracker rejects invalid YAML, duplicate entries, unsafe IDs, and stale UI revisions without replacing the last valid file.

`providers.enabled` controls the work-agent choices offered when creating a ticket. It contains one or more unique values from `claude` and `codex`; missing legacy configuration defaults to both. This is an operator preference rather than a live capability projection: supervisor availability does not automatically add or remove choices. Existing tickets retain and display their recorded provider even when it is no longer enabled for new work.

Each supervisor periodically fetches the current catalog and reconciles every entry to `PROJECT_ROOT/<id>`. If that path already exists, it is left untouched. If it is absent, the supervisor runs `git clone -- <url> <absolute-target>`. It does not pull, reset, change branches, inspect remotes, or replace existing directories.

The repository IDs used by tickets and by this catalog share the same namespace. The ticket editor autocompletes from this catalog. V1 does not reject an otherwise valid ticket merely because its repository has not yet been added to the catalog; only catalog entries are automatically bootstrapped by supervisors.

`tickets.next_number` is the next tracker-local sequence. The service suggests the next `AGENT-nnnn` identifier when local creation begins. If the operator leaves that suggestion unchanged, the service allocates it atomically during creation and advances the sequence in the same serialized configuration store. The operator may instead enter a unique nonempty custom ID before creation; custom and Jira-imported identifiers do not consume the local sequence. Gaps are allowed after a failed automatic create, but automatically allocated identifiers are never reused.

Jira Cloud authentication is provided only through `JIRA_EMAIL` and `JIRA_API_TOKEN`; GitHub authentication is provided through `GITHUB_TOKEN`. Secrets are never written to tracker configuration or tickets. Jira is optional and disabled by default: when `jira.enabled` is false, the UI hides Jira actions, credentials are not required, and the tracker makes no Jira requests. Jira and GitHub integration settings may be changed through the configuration UI with optimistic revision checks.

### Tracker-managed prompt library

Editable agent prompts are Markdown files under `TICKETS_ROOT/prompts`, beside `tracker-config.yaml` rather than embedded in it. Tracker startup creates missing files from its shipped defaults and may upgrade exact unchanged older defaults; it never overwrites an operator edit. The central tracker serves this library to every supervisor, so all supervisor hosts use the same prompt revision. Supervisors contain no packaged or local prompt fallback. If the prompt endpoint is unavailable, incomplete, or invalid, a supervisor retries without recovering or claiming work.

The library contains `assignment.md`, `specification.md`, `implementation.md`, `review.md`, `guidance.md`, and `callback-reminder.md`. Each prompt descriptor exposes:

- a human title and purpose;
- the exact workflow stages and transitions that cause it to be rendered;
- allowed `{{meta_tag}}` values with descriptions and dummy examples;
- required tags that preserve the minimal assignment/callback contract; and
- its content digest for optimistic concurrency.

The operator UI provides one structured prompt editor. It shows the selected prompt's trigger, applicable phases, tag reference, and required tags beside the Markdown. Preview renders the unsaved draft server-side with a safe dummy ticket. Previewing a phase prompt renders the complete assignment envelope with that phase draft injected, making the resulting agent message visible rather than showing an isolated fragment. Unknown tags, missing required tags, stale revisions, and empty prompts cannot be saved.

Assignment and phase prompts expose `{{project_root}}`, resolved by each supervisor from the same absolute path it gives Herdr as the workspace `--cwd`. The shipped assignment default identifies that directory as the ticket's project root and directs the agent to work beneath it instead of searching for alternate checkouts. Exact unchanged older defaults may be upgraded to include this context; operator-customized prompt files are never rewritten automatically.

The shipped specification and implementation prompts recommend inspecting the worktree and updating the repository's remote default branch (normally `main` or `master`) before creating a branch for initial work. A feedback, repair, or other resumed iteration continues its existing task branch/PR and integrates the current default branch safely when appropriate. The prompts explicitly preserve unrelated local changes. Exact unchanged older phase defaults may be upgraded with this guidance; customized phase prompts remain untouched.

The shipped callback reminder is self-contained so it remains actionable if the assignment context was compacted. It renders the ticket ID, phase, and lease-specific callback base, then repeats the `comment`, single/batch `ask`, phase-appropriate `complete`, and `fail` endpoints and payload examples. The reminder is sent at most once per lease and does not itself change ticket state. Later `working`, `idle`, or `done` observations never re-arm it; an operator resumes a quota-limited or otherwise paused conversation through guidance or retry.

Prompt triggers are fixed coordination behavior, not a configurable workflow graph:

| Prompt | Render trigger |
| --- | --- |
| `assignment` | Immediately after a supervisor claims or recovers specification, implementation, or review work and attaches the ticket's Herdr conversation. It wraps the matching phase prompt. |
| `specification` | Injected into `assignment` for initial specification and specification-feedback iterations. |
| `implementation` | Injected into `assignment` for initial implementation, review repair, reopened completed work, and GitHub follow-up repair. |
| `review` | Injected into `assignment` for initial independent review and re-review. |
| `guidance` | Prompted into the active conversation for operator guidance, an answered question, or a live ticket edit that asks the agent to reread. |
| `callback-reminder` | Prompted at most once per lease when Herdr becomes idle or done without a terminal callback, except while an agent question awaits an answer. It repeats the rendered lease callback contract in case earlier context was compacted. |

A supervisor must complete a successful reconciliation before recovering or claiming work. Clone or configuration failures are logged and retried; they prevent new claims on that supervisor but do not mutate tickets or infer agent failure. Catalog changes reach supervisors through bounded polling, initially no slower than the supervisor heartbeat interval.

## Ticket Storage Contract

### One file per ticket

Each ticket is one authoritative UTF-8 Markdown file under the configured ticket root. Subdirectories are allowed. The filename is descriptive only; `id` in frontmatter is authoritative.

For a newly authored local ticket, the operator supplies `title`, `spec_required`, `review_required`, `work_provider`, `review_provider`, and `repositories`; the tracker suggests an `AGENT-nnnn` ID that may be replaced before creation. A directly authored Markdown ticket, custom-ID ticket, or Jira import supplies its own unique `id`. `priority` defaults to `0` and `labels` defaults to an empty list. On first admission, the tracker atomically inserts the initial phase/status, empty agent, question, integration, and PR records, attempt counters, revisions, timestamps, and the reserved interaction log. Supplying those fields explicitly is also valid when the complete document is coherent.

The tracker preserves human-authored Markdown outside its reserved interaction-log markers. A representative ticket is:

```markdown
---
id: AGENT-0042
title: Add repository health page
phase: specification
status: pending
spec_required: true
review_required: true
work_provider: claude
review_provider: codex
priority: 50
labels:
  - frontend
  - operations
repositories:
  - id: operations-ui
    primary: true
  - id: repository-api
    primary: false
assigned_supervisor: null
assigned_supervisor_host: null
agents:
  specification:
    provider: null
    herdr_pane_id: null
    session_ref: null
  implementation:
    provider: null
    herdr_pane_id: null
    session_ref: null
  review:
    provider: null
    herdr_pane_id: null
    session_ref: null
execution: null
attempts:
  specification:
    total: 0
    consecutive_lease_losses: 0
  implementation:
    total: 0
    consecutive_lease_losses: 0
  review:
    total: 0
    consecutive_lease_losses: 0
pull_requests: []
questions: []
jira: null
archived_at: null
revision: 1
event_sequence: 1
created_at: 2026-08-14T15:00:00Z
updated_at: 2026-08-14T15:00:00Z
---

# Goal

Show the health of each registered repository.

# Acceptance Criteria

- The operator can see the last successful verification time.
- A failed repository is visually distinct.

# Context

Additional human-authored context belongs here.

## Interaction Log

<!-- tracker:interaction-log:start -->
- `000001` `2026-08-14T15:00:00Z` **ticket.created** — Ticket created by the operator.
<!-- tracker:interaction-log:end -->
```

### Human-authored frontmatter

The operator primarily authors:

- `id` and `title`;
- `spec_required` and `review_required`;
- `work_provider`, `review_provider`, `priority`, and `labels`; and
- `repositories`.

`work_provider` and `review_provider` are exactly `claude` or `codex`. Claude work requires Codex review, and Codex work requires Claude review. Missing routing fields on a legacy ticket default to its existing work assignment when one exists, otherwise Claude work and the corresponding reviewer. `priority` is an integer; higher values claim first. An operator may change it in any valid ticket state without interrupting work or guiding the agent because it is scheduling metadata. `labels` are scheduling-neutral free-form strings in V1.

Every ticket must reference at least one repository and exactly one entry must have `primary: true`. Repository IDs are human-meaningful identifiers supplied to the agent. The tracker does not resolve, clone, validate, or prepare those repositories.

### Tracker-managed frontmatter

The tracker normally manages:

- `phase` and `status`;
- `assigned_supervisor`;
- `assigned_supervisor_host`;
- `agents`, `execution`, and `attempts`;
- `pull_requests`;
- `revision`, `event_sequence`, and timestamps.

Because the Markdown file is authoritative, a human may edit these fields directly. The resulting combination must still pass schema and state validation. An external edit that invalidates or supersedes an active execution fences that lease before any later callback can mutate the ticket.

`execution`, when present, contains only current coordination state:

```yaml
execution:
  lease_id: 9e5082bf-3f76-4b70-8af1-a21e7e572ae3
  supervisor_id: coordinator-vm
  provider: claude
  phase: implementation
  attempt: 2
  claimed_at: 2026-08-14T16:00:00Z
  last_heartbeat_at: 2026-08-14T16:00:30Z
  lease_expires_at: 2026-08-14T16:02:30Z
  observed_herdr_state: working
  herdr_observation:
    state: working
    observed_at: 2026-08-14T16:00:30Z
    state_changed_at: 2026-08-14T16:00:05Z
    pane_id: w1:p1
    workspace_id: w1
    tab_id: w1:t1
    terminal_id: term-12
    focused: false
    cwd: /srv/projects
    foreground_cwd: /srv/projects/operations-ui
    terminal_title: Running integration tests
    terminal_title_stripped: Running integration tests
    display_name: Claude
    revision: 42
    session_source: herdr:claude
    session_kind: id
    tokens:
      model: opus
  guidance:
    - id: guidance-17
      sequence: 17
      message: Do not change the public API.
      created_at: 2026-08-14T16:01:00Z
      delivered_at: null
```

The lease ID is a fencing identifier, not a secret. All V1 services run within the same trusted host boundary.

`pull_requests` supports multiple PRs per repository. PR URL, not repository ID, is the identity of an entry:

```yaml
pull_requests:
  - repository: operations-ui
    url: https://github.com/example/operations-ui/pull/81
  - repository: operations-ui
    url: https://github.com/example/operations-ui/pull/84
  - repository: repository-api
    url: https://github.com/example/repository-api/pull/32
```

The tracker records references reported by agents. For specifications waiting for approval and for completed, unarchived tickets, it may observe their standard GitHub pull requests for new human issue comments, new human review comments, changes-requested reviews, and merge conflicts. Observation updates a compact cursor on each PR record and never copies whole GitHub threads into YAML.

`questions` is a durable structured list of agent questions and operator answers. Asking blocks semantic completion but retains the lease and conversation. Answering records the response, appends it as guidance to the same running conversation, and returns the ticket to `running`. The supervisor suppresses callback reminders while an unanswered question exists.

`jira`, when present, records the Jira issue key, issue ID, browse URL, and last successful synchronization timestamps. Tracker-local workflow fields, repositories, agent sessions, leases, PRs, questions, and interaction history are never overwritten by Jira synchronization.

## Optional Jira Cloud Workflows

Jira is an import/export adapter around the durable ticket, not another workflow phase.

- **Import:** the operator supplies a Jira issue key. The tracker fetches the issue, uses the Jira key as the ticket `id`, imports summary, description, labels, and priority where available, and asks the operator to choose tracker-only repositories and workflow flags before creation.
- **Export:** the operator may create a Jira issue from a local `AGENT-nnnn` ticket. The tracker retains the local ID, records the newly created Jira association, and includes the local ID in the Jira description for traceability.
- **Pending resync:** viewing a pending Jira-backed ticket performs a best-effort refresh. Marking it ready requires a successful refresh so the agent cannot start from a knowingly stale imported description. Once work is ready or progressed, Jira never silently rewrites its working description.
- **Manual resync:** a pending ticket exposes an explicit refresh action and reports synchronization errors without deleting or hiding the local ticket.

## Completed-Ticket GitHub Observation

GitHub observation is optional and applies to specification tickets in `waiting_approval` and completed, unarchived tickets with recorded GitHub PRs. It can be triggered manually for one eligible ticket. When enabled in configuration, the tracker also runs it on the adjustable interval. While awaiting specification approval, only PRs reported for specification are observed; an unphased legacy PR is treated as a specification PR in that state.

For completed implementation work, the first successful observation establishes comment/review cursors without treating historical discussion as new work. A later new human issue comment, human review comment, changes-requested review, or current merge conflict appends a compact event and reopens the ticket at implementation in `ready` state. The existing implementation provider, ticket conversation, supervisor affinity, and review conversation are retained. After repair, the ordinary implementation callback and optional review flow run unchanged.

For a specification waiting for approval, the first observation treats existing human feedback as actionable so a comment posted between phase completion and the first polling interval is not lost. Actionable feedback returns the ticket to `specification/ready`; the same work provider, supervisor affinity, and specification/implementation conversation are retained. The agent updates the evolving specification PR and completes specification again, returning to the ordinary approval gate. A GitHub approval review never approves the tracker gate automatically. Bot accounts, the PR author, and configured `ignored_logins` do not trigger work. Each GitHub event is consumed at most once, and no path automatically merges a PR.

Archiving sets `archived_at` on a completed ticket. Archived tickets remain durable and queryable but leave the default queue and are excluded from periodic GitHub observation. They may be unarchived without changing workflow state.

### Interaction log

The tracker appends compact human-readable events between the reserved markers. Comments, questions, answers, guidance, callbacks, claims, lease loss, approvals, external edits, rewinds, and terminal outcomes are events. Large terminal transcripts and provider event streams are never copied into the ticket.

The service and UI treat this section as append-only. Direct file editing remains authoritative, so V1 cannot prevent an operator from manually changing historical text; it can only record detected changes while it is running.

## File Discovery, Validation, and Mutation

### Discovery and validation

At startup and after file-system changes, the tracker scans Markdown files beneath the ticket root and validates them as a complete set.

A ticket is unschedulable when:

- its YAML or required Markdown structure is invalid;
- a required field is absent or has the wrong type;
- its phase/status combination is invalid;
- it has no repository or does not have exactly one primary repository;
- its `id` duplicates another ticket; or
- a `running` state lacks a coherent active execution, or a `blocked` state is neither a live question-bearing execution nor a lease-loss `needs_attention` state.

Both members of a duplicate ID conflict are invalid until the conflict is resolved. Invalid tickets remain visible in the UI with actionable validation errors and can never be returned by `claim`.

### Atomic service mutations

All tracker mutations are serialized beneath the root lock. For each ticket mutation, the tracker:

1. rereads the latest bytes and computes a digest;
2. parses and validates the current document;
3. applies the command to frontmatter and the reserved interaction log only;
4. rechecks that the source digest has not changed, retrying the merge when it has;
5. writes a temporary file in the ticket's directory;
6. flushes the temporary file;
7. atomically renames it over the ticket; and
8. flushes the containing directory where the operating system supports it.

If the file continues changing during bounded retries, the API returns `409 Conflict` and does not overwrite the operator's version. Every successful mutation increments `revision` and `event_sequence`, updates `updated_at`, and appends its event in the same file replacement.

### Direct file edits

Direct editing is supported in every state.

- A valid content-only edit retains the current phase and status.
- While an agent is running or blocked, the tracker queues guidance telling it that the authoritative ticket changed and must be reread.
- A valid explicit frontmatter state change is honored.
- A state change incompatible with the current lease fences and clears that lease.
- An invalid edit pauses scheduling and is shown in the UI; the tracker does not silently repair it.
- Changes made while the tracker is stopped establish the startup baseline and cannot be distinguished from older content.

The React UI uses optimistic revision checks and presents structured ticket fields rather than raw frontmatter. The description remains editable after a ticket progresses; workflow and execution metadata remain read-only outside explicit state controls. Saving a live description offers two deliberate choices:

- **Save and continue** retains the phase and lease. If an execution exists, the tracker durably queues guidance telling that conversation to reread the new ticket revision. A question-blocked execution returns to running when that guidance is delivered.
- **Save and restart from phase** updates the description and explicitly rewinds or reopens to an applicable phase. Selecting a previously skipped specification or review phase explicitly enables that phase flag.

Invalid tickets retain an explicit raw Markdown recovery editor. Direct file editing remains available in every state under the rules above.

Applicable rewind targets are specification when `spec_required` is true, implementation, and review when `review_required` is true and implementation has completed. The UI never rewinds implicitly.

An active rewind is coordinated rather than merely fenced. The tracker records an interrupt request on the current execution and rejects its terminal callbacks while leaving the ticket unclaimable. The outbound supervisor sends `ctrl+c` to the Herdr agent, waits for an idle or done observation, then acknowledges the request. Only that acknowledgement fences the old lease and makes the selected phase ready. An unacknowledged request remains visible, cannot overlap a replacement agent, and becomes blocked for human attention when its lease expires.

## Workflow State Model

`phase` identifies the durable kind of work. `status` identifies the condition of that work.

Phases:

- `specification`
- `implementation`
- `review`
- `done`

Statuses:

- `pending`
- `ready`
- `running`
- `blocked`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`

Valid normal combinations are:

| Phase | Statuses |
| --- | --- |
| `specification` | `pending`, `ready`, `running`, `blocked`, `waiting_approval`, `failed`, `cancelled` |
| `implementation` | `pending`, `ready`, `running`, `blocked`, `failed`, `cancelled` |
| `review` | `ready`, `running`, `blocked`, `failed`, `cancelled` |
| `done` | `completed`, `cancelled` |

`pending` means the operator has not made the phase claimable. `ready` means it may be claimed by the required provider. `running` means it has an active lease. `blocked` means either an agent requested human input while retaining a live lease or repeated lease loss requires operator attention; these cases are distinguished by `execution` and the latest events.

### Creation and readiness

- A newly discovered ticket with `spec_required: true` starts at `specification/pending`.
- A newly discovered ticket with `spec_required: false` starts at `implementation/pending`.
- The operator explicitly marks a valid pending ticket ready.
- An unclaimed ready ticket may be returned to `pending` as an editable draft without changing its current workflow node, visit count, attempts, conversations, supervisor affinity, or prior history. Marking it ready again resumes eligibility at that same node.

### Specification

The specification agent works autonomously in the primary repository. Successful specification requires it to:

- create or update an intentional specification in the primary repository;
- commit and push that work on the task branch it chooses;
- open or update an evolving draft PR; and
- call `complete` with a short summary and the primary PR reference.

The tracker then enters `specification/waiting_approval`.

- **Approve:** advance to `implementation/ready` and retain the specification/implementation session reference.
- **Request changes:** append the feedback and return to `specification/ready`, resuming the same provider conversation.
- **Cancel:** enter the current phase's `cancelled` state and fence any lease.

When `spec_required` is false, no specification branch or approval gate is introduced by the tracker.

### Implementation

The implementation agent receives the complete current ticket, prior feedback, and known PRs. It decides how to inspect repositories, manage branches, use subagents, change code, verify work, commit, push, and create or update draft PRs.

Successful implementation calls `complete` with a short summary and all known repository/PR pairs.

- With `review_required: true`, advance to `review/ready`.
- With `review_required: false`, advance to `done/completed`.

The tracker does not independently run verification or prove repository state.

### Review

Review is assigned to a separate conversation using the ticket's `review_provider`. Claude work is reviewed by Codex and Codex work is reviewed by Claude. The reviewer receives the ticket, implementation summary, prior review feedback, and PR references. It is instructed to perform an independent review, post useful comments to the PRs, and report one of:

- `approved`; or
- `changes_requested` with a summary.

This is a role boundary, not a tool or permission boundary. The reviewer remains a normal full-capability agent. It is told not to repair the implementation because repairs belong to the implementation conversation, but the coordinator does not try to enforce that instruction through a sandbox.

- `approved` advances to `done/completed`.
- `changes_requested` appends the findings and returns to `implementation/ready`, resuming the ticket's existing implementation conversation.
- A later review resumes the ticket's existing review-provider conversation.

### Reopen, retry, failure, and cancellation

- A completed ticket may be reopened to an applicable prior phase through an explicit UI/API command.
- A live description edit may retain the current phase or request an explicit restart. A restart from active work must complete the supervisor interruption handshake before new work is claimable.
- An explicit agent `fail` callback enters the current phase's `failed` status with its reason.
- An operator retry moves a failed or needs-attention ticket back to the same phase's `ready` status and resets its consecutive lease-loss count.
- An operator may explicitly fail or cancel a nonterminal ticket at any time. Both fence any active lease.
- No agent or service merges a pull request automatically.

## Claims, Leases, and Routing

### Explicit agent routing

| Ticket/phase | Required provider |
| --- | --- |
| Specification | `work_provider` |
| Implementation and repair | `work_provider` |
| Required review and re-review | `review_provider` |

The supervisor includes its configured `available_providers` with every claim. Claims match the ticket's explicit provider exactly; there is no implicit fallback. If the selected provider is unavailable or busy, the ticket remains ready and waits.

Specification, implementation, feedback, and repairs continue in the selected work provider's same ticket conversation. Review and re-review use the selected independent review provider's separate conversation and pane. Labels do not alter routing in V1.

### Claim ordering

The first eligible claim atomically pins `assigned_supervisor`. That supervisor owns the ticket through specification, approvals, implementation, review, feedback, blocked states, and retries. While that ticket is nonterminal, the supervisor is reserved and cannot claim another ticket. Completed and cancelled tickets release its capacity while retaining the historical assignment.

A supervisor is eligible for a new ticket only when its advertised provider set contains `work_provider` and, when review is required, `review_provider`. All phases run from that supervisor's project root. Under the tracker lock, `POST /api/work/claim` first honors an existing supervisor assignment, then selects one valid matching `ready` ticket ordered by:

1. higher `priority`;
2. earlier `created_at`; and
3. lexical `id` as a deterministic tie-breaker.

The same atomic file replacement pins the supervisor when necessary, changes the selected ticket to `running`, creates its lease, increments the phase attempt count, records the assigned provider, and appends the claim event. If an assigned ticket is waiting, blocked, failed, or otherwise not ready, that supervisor receives no other work. If no work matches, the endpoint returns `204 No Content` after the optional bounded long-poll period.

The tracker also enforces a host-local repository lock. Before accepting a claim, it compares the candidate's repository IDs with every nonterminal ticket already assigned on the claiming supervisor's hostname. Any overlap makes that candidate ineligible on that host until the assigned ticket completes, is cancelled, or is explicitly released. The reservation remains during approvals and blocked or failed attention states, so another item cannot slip in between phases. Supervisors on another hostname remain eligible because they use an isolated checkout. This is a claim constraint, not a workflow transition: the ticket remains durably `ready`, and the API/UI project the conflicting host, repositories, and assigned ticket as a claim blocker.

`assigned_supervisor_host` records the stable hostname used for affinity and conflict checks. All supervisor processes on one VM must advertise the same hostname; separate VMs must advertise distinct hostnames. `SUPERVISOR_HOST` overrides automatic hostname detection when cloned VM names are not unique.

For tickets already executing when this field is introduced, the tracker backfills it from registered supervisor presence on the next accepted lease heartbeat.

An operator may release an inactive nonterminal ticket from its supervisor. Release clears machine-local pane/session references, provider assignment, and assigned hostname so the next eligible supervisor starts fresh conversations. Active work must first use the ordinary interruption handshake; silent reassignment is forbidden.

### Lease behavior

Defaults are configurable but initially:

- supervisor heartbeat every 30 seconds;
- lease expiry two minutes after the latest accepted heartbeat; and
- claim long-poll no longer than 30 seconds.

Every mutation from an agent or supervisor includes the current lease ID. A stale or fenced lease receives `409 Conflict` and cannot change workflow state. Duplicate heartbeats and repeated callback requests are idempotent for the same lease and payload.

For a terminal callback, the tracker records the lease ID, request digest, and resulting response in the ticket's interaction event before clearing `execution`. An exact retry replays that result; reuse of the same lease with a different callback payload returns `409 Conflict`.

Herdr lifecycle changes may update `observed_herdr_state` and the UI, but `idle` or `done` never completes a phase. Initial assignment delivery uses Herdr's stalled-prompt detection with a timeout longer than its five-second activity window. An `agent_prompt_stalled` result retries the same complete assignment once; a normal timeout after activity means the agent is still working. The supervisor does not enter its monitoring/reminder loop until assignment activity has been confirmed. If both submissions stall, it reports an infrastructure error and later lease recovery retries the complete assignment rather than substituting a callback reminder.

After confirmed assignment activity, if the agent settles without sending `complete`, `ask`, or `fail`, the supervisor may remind it once per lease of the callback contract; later lifecycle changes do not re-arm that reminder. It must not infer success from terminal output. An operator may manually resume the same leased conversation through guidance after a provider cooldown.

When a lease expires without a callback:

1. clear the active execution and record the loss;
2. preserve the provider's session reference;
3. after the first or second consecutive loss, return the same phase to `ready`; and
4. after the third consecutive loss, enter `blocked` without a lease and require an operator retry or fail decision.

This condition is `needs_attention`, not evidence that the development task itself failed.

## Agent Sessions and Herdr

### Session scope

Each provider gets a fresh conversation for each ticket, not for each phase and not across unrelated tickets.

- The selected Claude or Codex work conversation owns both specification and implementation for its ticket.
- A separate conversation using `review_provider` owns review and re-review for its ticket.
- Specification feedback and implementation repair resume the work conversation.
- Re-review resumes the review conversation.

The tracker persists provider, Herdr pane ID, native session reference, and one compact current Herdr observation in frontmatter. The observation may include workspace/tab/terminal identity, focus, cwd and foreground cwd, terminal title, display name, pane revision, session source/kind, and display metadata tokens. It never contains terminal output. The supervisor obtains native references through the official Herdr integrations. A lost native reference is an infrastructure interruption: the supervisor may start a fresh conversation for the same ticket and supplies the full durable ticket history.

Once established, the `specification` and `implementation` agent records for a ticket must use `work_provider` and the same native session reference. The `review` record must use `review_provider` and the ticket's separate review conversation.

### Persistent slots

Herdr provides persistent panes and the normal interactive agent processes. Logical Claude and Codex slots limit concurrent assignments. A slot may stop one ticket conversation and later start or resume another; the ticket file, not a pane name, is the durable association.

The supervisor starts agents in a configured ordinary project directory. It does not create clones, branches, task directories, containers, or Git worktrees. The assignment tells the agent which repositories the ticket names, and the agent uses the machine normally.

### Assignment prompt boundary

The supervisor supplies a concise prompt containing:

- ticket ID and current phase;
- the authoritative ticket path and current ticket content;
- prior human feedback and known PR links already present in the ticket;
- the lease-specific callback URLs; and
- the instruction never to merge PRs automatically.

Phase-specific text states the durable expected outcome described above and lightweight repository-start hygiene: update the remote default branch before initial work, or safely continue the existing task branch for a resumed PR iteration. It does not otherwise prescribe investigation steps, planning format, tools, subagents, branch naming, verification commands, or implementation technique.

Coordinator-authored assignment, phase, guidance, and callback-reminder text is stored in operator-editable Markdown templates in the tracker's central prompt library. Supervisors refresh that library before assignments and follow-up messages, so text-only changes propagate across hosts without a TypeScript rebuild or daemon restart. Template placeholders are a small fixed interpolation surface; ticket Markdown remains authoritative and is inserted without being interpreted as a template.

## Agent Callback Contract

The callback surface is deliberately small and provider-neutral. Agents use ordinary HTTP tooling such as `curl`; no agent plugin, special tool profile, or output schema is required.

### Comment

`POST /api/work/{lease}/comment`

```json
{
  "message": "The repository uses a generated client; I am updating it as part of the change."
}
```

Appends an event without changing phase or status.

### Ask

`POST /api/work/{lease}/ask`

```json
{
  "question": "Which environment should receive the deployment?",
  "options": ["Development", "Staging", "Both"]
}
```

An agent may instead ask several related questions atomically:

```json
{
  "questions": [
    {
      "question": "Which compatibility target is required?",
      "options": ["Current major only", "Current and previous major"]
    },
    {
      "question": "May I add a dependency?",
      "options": ["Yes", "No"]
    }
  ]
}
```

The payload must contain exactly one of `question` or `questions`. The singular form may include `options`; each batch entry may be a question object with its own `options` or a plain question string for backward compatibility. Every `options` value is an array containing any number of non-empty strings, including an empty array. Options are suggestions, never an answer constraint: the UI displays them as shortcuts and always provides a freeform answer field.

Either form changes the ticket to `blocked` while retaining the live lease and ticket conversation. Each question, its suggestions, and its eventual freeform answer are stored durably and answered independently. Answers become durable guidance, and the tracker returns the ticket to `running` only after every outstanding question has been answered. An agent may also make several singular `ask` calls before it becomes idle, but the batched form is preferred when the questions are already known.

### Complete

`POST /api/work/{lease}/complete`

Specification or implementation payload:

```json
{
  "summary": "Implemented the repository health page and verified the affected projects.",
  "pull_requests": [
    {
      "repository": "operations-ui",
      "url": "https://github.com/example/operations-ui/pull/81"
    }
  ]
}
```

Review payload:

```json
{
  "summary": "The implementation is correct and the PR comments are non-blocking.",
  "decision": "approved"
}
```

For review, `decision` is required and is exactly `approved` or `changes_requested`. The tracker validates only this small coordination envelope and repository IDs. It does not validate Git heads, inspect commits, parse provider prose, or normalize provider event streams.

### Fail

`POST /api/work/{lease}/fail`

```json
{
  "reason": "The requested repository is not available on this machine."
}
```

Records an explicit agent-declared failure and enters the current phase's `failed` status.

## REST API

All responses identify the ticket by stable `id` and include its current `revision`. Mutating ticket commands accept `expected_revision`; a mismatch returns `409 Conflict` with the latest ticket representation.

### Ticket queries and edits

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tickets` | List valid and invalid tickets with queue/filter fields. |
| `GET` | `/api/runtime` | List current leased agents with compact ticket, lease, and Herdr observations. |
| `GET` | `/api/config` | Return the validated local tracker configuration. |
| `PUT` | `/api/config` | Atomically update repositories and non-secret integration settings at an expected revision. |
| `GET` | `/api/prompts` | Return every prompt with content, revision, trigger/stage metadata, and tag definitions. |
| `PUT` | `/api/prompts/{name}` | Validate and atomically update one prompt at its expected digest revision. |
| `POST` | `/api/prompts/{name}/preview` | Render an unsaved prompt draft with a dummy ticket; phase prompts return the complete assignment envelope. |
| `GET` | `/api/supervisors` | List current and recently seen supervisors with host, root, capabilities, health, and reservation. |
| `POST` | `/api/supervisors/heartbeat` | Register or refresh one supervisor's ephemeral presence. |
| `POST` | `/api/supervisors/unregister` | Remove matching process presence during graceful shutdown. |
| `GET` | `/api/tickets/next-id` | Preview the next tracker-local `AGENT-nnnn` identifier. |
| `POST` | `/api/tickets` | Allocate an ID when requested, then create and admit a Markdown ticket. |
| `POST` | `/api/jira/import` | Fetch a Jira Cloud issue and return a ticket draft whose ID is the Jira key. |
| `GET` | `/api/tickets/{id}` | Return parsed frontmatter, Markdown, validation, and current runtime observation. |
| `PUT` | `/api/tickets/{id}` | Save UI edits using `keep_phase` or an explicit `rewind_phase`. |
| `POST` | `/api/tickets/{id}/ready` | Move a pending valid ticket to ready. |
| `POST` | `/api/tickets/{id}/draft` | Return an unclaimed ready ticket to pending draft state at the same workflow node. |
| `POST` | `/api/tickets/{id}/priority` | Change integer scheduling priority at an expected ticket revision in any valid state. |
| `POST` | `/api/tickets/{id}/approve-specification` | Approve a waiting specification. |
| `POST` | `/api/tickets/{id}/request-specification-changes` | Append feedback and resume specification. |
| `POST` | `/api/tickets/{id}/guidance` | Append human guidance for the active or next agent. |
| `POST` | `/api/tickets/{id}/comment` | Append a human comment without changing workflow state. |
| `POST` | `/api/tickets/{id}/questions/{questionId}/answer` | Durably answer an agent question and guide its retained conversation. |
| `POST` | `/api/tickets/{id}/jira/export` | Create and associate a Jira Cloud issue from a local ticket. |
| `POST` | `/api/tickets/{id}/jira/resync` | Refresh an initial pending Jira-backed ticket before workflow progress. |
| `POST` | `/api/tickets/{id}/check-pull-requests` | Immediately observe relevant GitHub PRs for a waiting specification or completed ticket and resume the applicable phase when actionable feedback exists. |
| `POST` | `/api/tickets/{id}/archive` | Archive a completed ticket. |
| `POST` | `/api/tickets/{id}/unarchive` | Return an archived ticket to the completed queue. |
| `POST` | `/api/tickets/{id}/retry` | Retry the current failed or needs-attention phase. |
| `POST` | `/api/tickets/{id}/release-supervisor` | Release inactive supervisor affinity and clear machine-local sessions. |
| `POST` | `/api/tickets/{id}/rewind` | Explicitly rewind to an applicable prior phase. |
| `POST` | `/api/tickets/{id}/reopen` | Reopen a completed ticket to an applicable phase. |
| `POST` | `/api/tickets/{id}/cancel` | Cancel and fence current work. |
| `POST` | `/api/tickets/{id}/fail` | Explicitly fail and fence current work. |

### Supervisor and agent work API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/work/claim` | Atomically claim matching work for one provider slot. |
| `GET` | `/api/work/active` | Recover active leases owned by a restarting supervisor slot. |
| `POST` | `/api/work/{lease}/heartbeat` | Extend the lease and report Herdr/session observations. |
| `POST` | `/api/work/{lease}/telemetry` | Best-effort final harness telemetry for the lease-matched durable node run; never advances workflow. |
| `GET` | `/api/work/{lease}/guidance` | Long-poll guidance after a supplied sequence cursor. |
| `GET` | `/api/work/{lease}/control` | Return a pending supervisor control request, if any. |
| `POST` | `/api/work/{lease}/interrupt-ack` | Confirm Herdr interruption and atomically activate the requested phase. |
| `POST` | `/api/work/{lease}/comment` | Append a non-blocking agent comment. |
| `POST` | `/api/work/{lease}/ask` | Ask one or several questions and block for human answers while retaining the lease. |
| `POST` | `/api/work/{lease}/complete` | Submit the small phase-completion envelope. |
| `POST` | `/api/work/{lease}/fail` | Submit an explicit failure. |

`claim` accepts `supervisor_id`, process `instance_id`, `provider`, `available_providers`, and optional `wait_seconds`. The presence heartbeat supplies hostname, IP addresses, project root, Herdr session, available providers, instance start time, and a process instance ID. Presence is an in-memory operational projection: supervisors repopulate it after tracker restart, while ticket affinity remains durable in Markdown. A second live process may not use the same supervisor ID. Graceful shutdown unregisters its exact process instance; an unclean exit remains reserved until the presence TTL expires.

Work `heartbeat` accepts observed Herdr state, pane/session references, compact Herdr metadata, optional versioned harness telemetry plus its node baseline, and the last delivered guidance sequence. The tracker derives node-scoped token and cost deltas and timestamps observations and state transitions itself. Each durable node run also accrues active, human-wait, and quota-paused time. An exhausted rate-limit window with a future reset keeps the lease alive, counts the interval as quota-paused, and automatically resumes active accounting at the reset boundary; this covers Claude and Codex five-hour limits without treating the pause as productive runtime. Ticket totals are derived across node visits so loops are included without duplicating mutable rollup state. Guidance is therefore at least once: the supervisor deduplicates by guidance ID and advances its cursor only after it has submitted the prompt to Herdr.

### UI invalidation stream

`GET /api/events` is a best-effort SSE stream carrying identifiers and new revisions for ticket and supervisor-state changes. It is not an event store and has no replay cursor. A client connects by loading current REST state, subscribes for invalidations, and reloads affected resources after every event or reconnect.

## Operator UI

The Vite/React application is built and served by the Express service. V1 includes:

- a browser-persisted Light, Dark, and Retro Hacker theme selector, with no behavioral differences between themes;
- a queue ordered strictly by descending priority by default, with an optional workflow grouping view, explicit work/review providers, and validation state;
- structured creation and pending-ticket editing, with raw Markdown shown only for invalid-ticket recovery;
- a rendered read-only work description after the ticket becomes live;
- a workflow visualization showing completed, current, upcoming, and skipped phases;
- a global active-agent strip and per-ticket runtime diagnostics using compact Herdr metadata;
- a supervisor health page showing online/offline presence, hostname, host IPs, project root, Herdr session, provider capabilities, and reserved ticket;
- a configuration page for adding, editing, and removing repository IDs and clone URLs;
- a prompt editor showing each template's exact workflow trigger, applicable stages, available/required meta tags, validation state, and dummy-ticket preview;
- optional Jira Cloud settings and GitHub observation controls, with integration health that never exposes credentials;
- ready-ticket claim blockers naming any running same-host ticket and overlapping repositories, while preserving eligibility on other hosts;
- ticket detail with repositories, multiple PR links per repository, current lease, assigned sessions, Jira association, pending questions, and interaction timeline;
- live priority editing plus ready, return-to-draft, specification approval/change request, retry, rewind, reopen, fail, and cancel actions;
- comments, explicit question answers, and live guidance;
- completed-ticket PR check and archive controls, plus an archived-ticket filter;
- observed Herdr status, state age, heartbeat age, lease countdown, workspace/tab/pane identity, cwd, terminal title, display tokens, and an operator-facing attach hint; and
- clear invalid-ticket and lease-needs-attention diagnostics.

Herdr remains the full terminal-monitoring interface. The tracker UI does not mirror terminal output, provide a terminal emulator, render provider traces, administer repository manifests, or edit agent permissions. Its workflow visualization is a fixed projection of the four durable phases, not a configurable graph engine.

## Failure and Recovery

- **Tracker restart:** rescan all files, reestablish the root lock, preserve unexpired leases, and expire overdue leases using their stored timestamps.
- **Supervisor restart:** reconnect to Herdr, reconcile active leases and stored pane/session references, resume live work when possible, and otherwise allow lease recovery.
- **Supervisor VM unavailable:** retain its ticket affinity and show stale presence; an operator may deliberately interrupt if necessary, then release and reassign the inactive ticket.
- **Herdr server restart:** use official integration-reported native session references when available. A missing reference starts a fresh conversation with the durable ticket history.
- **Agent exits without callback:** do not infer success. Allow the lease policy to requeue or request attention.
- **Stale callback:** reject it through lease fencing without changing the ticket.
- **Malformed ticket:** keep it visible and unschedulable until fixed.
- **Concurrent UI/file edit:** preserve the newest external bytes, retry the structured merge, and return `409` rather than overwrite after bounded contention.
- **Guidance delivery interruption:** redeliver the same guidance ID until a heartbeat advances the delivery cursor.

## V1 Boundaries

V1 explicitly excludes:

- databases;
- multiple tracker instances or automatic load balancing across supervisors;
- configurable workflow graphs/editors, custom nodes, joins, and generic policy engines;
- coordinator-created worktrees, branches, containers, or repository snapshots beyond cloning missing configured repositories;
- coordinator-run test or verification commands;
- agent permission profiles, tool removal, or coordinator-managed agent abilities;
- strict provider-specific result schemas and provider stream parsing;
- Jira Server/Data Center, Jira webhooks, GitHub webhooks, GitHub check-run interpretation, or merge automation;
- automatic PR merge;
- authentication, RBAC, public-internet exposure, and multi-tenant isolation;
- full terminal transcript storage or browser terminal emulation; and
- automatic Git versioning of ticket files.

## Acceptance Criteria

### Ticket storage

- A human can create a ticket by writing one Markdown file and see it appear without an import step.
- Valid external edits are preserved in every workflow state.
- Duplicate IDs and invalid phase/status combinations are visible but never claimable.
- Service mutations preserve human-authored Markdown and atomically update frontmatter plus the interaction log.
- A concurrent edit produces a clean retry or `409`, never a silent overwrite.

### Tracker configuration and repository bootstrap

- Tracker startup creates `TICKETS_ROOT/tracker-config.yaml` when absent.
- Invalid YAML, duplicate IDs/URLs, unsafe directory IDs, and stale revisions cannot replace valid configuration.
- Repository catalog updates are atomic and preserve future unknown top-level settings.
- Every supervisor clones each missing configured repository to `PROJECT_ROOT/<id>` without touching an existing target.
- A failed clone prevents that supervisor from claiming new work and is retried without changing ticket state.
- A catalog entry added while supervisors are running is reconciled within the configured polling interval.

### Prompt library

- Tracker startup creates only missing prompt files beneath the reserved `TICKETS_ROOT/prompts` directory, which is never scanned as tickets.
- Existing prompt edits survive restarts, and service updates use atomic replacement plus digest revision fencing.
- The UI explains the exact stage or transition that sends every prompt and shows every allowed tag with description, example, and required status.
- Unknown, malformed, empty, or required-tag-deficient templates cannot be saved.
- Preview uses an unsaved draft and dummy ticket; previewing phase instructions displays the complete assignment the agent will receive.
- Every supervisor consumes the tracker-managed revision before recovery, new work, and live follow-ups. Prompt unavailability or invalidity prevents recovery and claims; no packaged or local fallback exists.

### Claims and leases

- Concurrent matching claim calls can never receive the same ticket.
- A first claim pins the ticket to one eligible supervisor, and that supervisor cannot claim a second nonterminal ticket.
- Two supervisor processes on the same hostname cannot concurrently run tickets with an overlapping repository ID.
- The same repository may run concurrently on distinct supervisor hostnames.
- A host-local conflict leaves the waiting ticket `ready`, projects an actionable blocker, and disappears when the conflicting ticket completes, is cancelled, or is explicitly released.
- Approval waits, blocked work, lease recovery, review, and repair retain the same supervisor and project root.
- An explicit inactive release clears machine-local conversations before another supervisor can claim the ticket.
- Priority ordering is deterministic, operator-adjustable in every valid state, and immediately affects later claims; equal priorities use the existing deterministic tie-breakers.
- Stale lease callbacks cannot mutate a ticket.
- Two unexplained lease losses requeue work; the third blocks for operator attention.
- Herdr `idle` or `done` cannot advance a phase without `complete`.
- A stalled initial Herdr prompt retries the identical full assignment, never sends the callback reminder in its place, and must show confirmed activity before reminder monitoring begins.

### Workflow

- `spec_required: false` skips specification and approval.
- `review_required: false` completes after implementation.
- Specification feedback resumes the ticket's selected Claude or Codex work conversation.
- Review changes resume the implementation conversation, and re-review resumes the selected review-provider conversation.
- A completed ticket can be reopened without defining a workflow graph.
- No path merges a PR automatically.

### Routing and sessions

- Specification, implementation, and repair wait for the explicit `work_provider` even when another provider is idle.
- Claude work is reviewed by Codex; Codex work is reviewed by Claude.
- No provider fallback occurs implicitly.
- Work and review always use separate ticket conversations.
- Unrelated tickets never share the same native provider conversation.
- Restart recovery uses persisted session references when available and remains functional when a reference is lost.
- A supervisor lacking any provider required by the ticket's full lifecycle cannot become its owner.

### Supervisor health

- Each daemon periodically publishes its stable ID, process instance, host/IP, project root, Herdr session, and provider set.
- Duplicate live supervisor IDs are rejected.
- The UI distinguishes online and stale supervisors and links each durable ticket reservation.
- Tracker restart may temporarily empty presence, but supervisors repopulate it without altering ticket affinity.

### Guidance and editing

- Human guidance entered while an agent works is persisted before delivery and may be sent through Herdr without restarting the phase.
- At-least-once delivery does not duplicate the interaction-log event or phase transition.
- An external content edit keeps the phase by default and tells an active agent to reread the ticket.
- A live description edit keeps the phase by default, queues the same durable reread guidance, and may explicitly request a coordinated restart from an applicable phase.
- The normal UI never exposes progressed frontmatter as a raw editor; guidance and explicit state controls remain available.

### IDs, integrations, questions, and archival

- Local creation suggests monotonically increasing `AGENT-nnnn` IDs from atomic tracker configuration and permits a unique custom override; Jira imports retain their Jira issue key and none of these paths needs a slug.
- Repository fields autocomplete from the saved catalog without preventing recovery of a legacy or temporarily unconfigured repository ID.
- The Configuration page can enable or hide Claude and Codex for new-ticket work-agent selection; at least one remains enabled, and supervisor online status does not alter the configured choices.
- A Jira-disabled personal installation starts, creates tickets, and runs agents without Jira credentials or Jira network traffic.
- Jira import, export, pending-view refresh, explicit refresh, and mandatory pre-ready refresh preserve tracker-only workflow metadata.
- An agent question may carry any number of suggested answer options, but the operator always retains a freeform answer field. It creates a durable unanswered record, blocks completion, suppresses callback reminders, and delivers the human answer as guidance to the same leased conversation.
- Two distinct PR URLs for the same repository remain visible and independently observable.
- Completed tickets may be archived and disappear from the default queue without deleting their Markdown file.
- A first completed-work GitHub observation baselines prior discussion. A later human comment, changes-requested review, or merge conflict reopens completed unarchived work at implementation exactly once, both on the configured schedule and through the manual action.
- A specification waiting for approval is checked on the same schedule and by manual action. Existing first-poll human feedback and later new feedback return it to specification exactly once without bypassing human approval.

### End-to-end scenarios

1. A Claude-selected ticket is specified and implemented by one Claude ticket conversation, independently reviewed by its Codex ticket conversation, and completes with an evolving draft PR recorded in Markdown.
2. A Codex-selected ticket is specified and implemented by one Codex work conversation. It receives human specification feedback without losing context, is independently reviewed in a separate Claude review conversation, returns once for repair, and completes with draft PRs for every changed repository.
3. During implementation, an operator edits the ticket description in the UI and chooses to continue. The active Claude or Codex conversation receives durable reread guidance without the tracker restarting the work or prescribing how to respond.
4. During implementation, an operator edits the description and restarts from specification. The old agent is interrupted and fenced before the same work conversation becomes claimable for specification.

## Implementation Verification Expectations

The eventual implementations must include unit and integration coverage for:

- Markdown parsing, schema validation, body preservation, reserved-section updates, duplicate detection, and atomic writes;
- file watcher reconciliation and external-edit conflict handling;
- every valid and invalid phase transition, including optional stage skips and reopen/rewind paths;
- claim concurrency, routing, ordering, fencing, heartbeat extension, expiry, and needs-attention recovery;
- supervisor affinity, exclusive reservation, explicit release, duplicate-instance rejection, presence expiry, and health projection;
- guidance cursors and idempotent callbacks;
- prompt default seeding, reserved-directory exclusion, tag validation, optimistic edits, full-envelope preview, and supervisor refresh;
- live-description continue edits, active interrupt acknowledgement, callback fencing, and restart failure behavior;
- Herdr command/session adaptation through fakes rather than real paid agent turns, including confirmed, still-working timeout, stalled, retry, and unexpected-error prompt delivery paths;
- proof that observed lifecycle state never triggers semantic completion; and
- the primary React queue, editor decision, approval, guidance, and recovery flows.

The two end-to-end acceptance scenarios should run against fake Claude, Codex, Herdr, and GitHub behavior by default. Explicit real-agent acceptance may be provided separately because it consumes credentials, inference, and repository side effects.
