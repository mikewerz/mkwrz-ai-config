# Agentic Project Supervisor

The supervisor is a small outbound-only daemon between the workflow tracker and a named Herdr session. One process represents one isolated project root and owns at most one nonterminal ticket end-to-end. It maintains one claim loop for each configured provider, starts or resumes the appropriate ticket conversation, forwards live guidance, records observed liveness, maintains the lease, and publishes host health to the tracker.

It contains no workflow graph, worktree management, testing policy, terminal-output parser, or agent permission profile. The tracker sends it an already-resolved node to execute. Its repository automation is limited to cloning missing catalog entries and executing declared `script` nodes. Herdr lifecycle state is observational; only an explicit agent callback can complete an agent node.

The supervisor also collects compact, provider-neutral usage telemetry from each harness's native session artifacts. This is accounting metadata, not agent-output interpretation, and it never affects workflow transitions.

## Run locally

Node 22.12 or newer, a running tracker, Herdr, and the configured provider executables are required.

For normal VM operation:

```bash
cp .env.example .env
./run.sh
```

`run.sh` changes to the repository directory, installs dependencies when needed, builds the TypeScript production output, and replaces itself with the compiled supervisor process. For source-watching development instead:

```bash
npm ci
npm run dev
```

Important settings:

- `PROJECT_ROOT` is the normal directory from which full-capability agents begin work. Repository catalog entries are cloned into `PROJECT_ROOT/<repository-id>` when missing. Existing paths are never pulled, reset, or replaced, and the supervisor does not create worktrees.
- `ASSIGNMENT_ROOT` is the supervisor-local root for durable agent assignment bundles. It defaults to `PROJECT_ROOT/.agentic-assignments`. Give each supervisor an isolated root if processes share a filesystem.
- `SUPERVISOR_ID` must be stable and unique for this project root. Running another root or VM requires another ID.
- `HERDR_SESSION` is the named persistent Herdr session.
- `CODEX_HOME` and `CLAUDE_CONFIG_DIR` optionally override the native telemetry roots. Defaults are `~/.codex` and `~/.claude`. `AGENTIC_TELEMETRY_ROOT` defaults to `~/.agentic-project-supervisor/telemetry` and stores optional live harness snapshots.
- `PROVIDERS` controls which outbound claim slots run and is advertised with agent and Script claims. The tracker resolves each V3 agent-profile alias to a pinned provider/model/reasoning tuple; the supervisor passes that tuple through the provider's native launch/resume arguments. There is no implicit provider fallback; unavailable nodes remain ready and wait. The daemon also detects repository-action, shell, JavaScript, and Python activity capabilities. Before first ownership, claims require this supervisor to advertise every provider and Script runtime needed by enabled workflow nodes.
- `HEARTBEAT_INTERVAL_MS` defaults to 30 seconds.
- `SUPERVISOR_HOST` overrides automatic hostname detection. Every supervisor process on one VM must use the same value, and separate VMs must use distinct values; the tracker uses it for host-local repository locking. `SUPERVISOR_IPS` overrides the detected IPv4 addresses shown on the health page.

## Repository bootstrap

The tracker Configuration page stores repository IDs and Git clone URLs in `TICKETS_ROOT/tracker-config.yaml`. On startup and once per heartbeat interval, the supervisor fetches that catalog. It clones each missing repository through a temporary directory and atomically publishes the completed checkout at `PROJECT_ROOT/<id>`.

The machine account running this daemon must already have credentials for every configured URL. A malformed catalog or failed clone is logged and retried, and prevents this supervisor from recovering or claiming tickets until the catalog reconciles successfully. It does not alter ticket state or interrupt work that is already running.

## Tracker-managed prompts and activities

The tracker's Prompt Editor owns the core coordinator text and any reusable workflow-node prompts as versioned Markdown files under `TICKETS_ROOT/prompts`:

- `assignment.md` is the small bootstrap containing exact assignment and callback-helper paths;
- `specification.md`, `implementation.md`, and `review.md` are written into the node's durable instructions;
- `guidance.md` points an active agent to a persisted update; and
- `callback-reminder.md` repeats the exact `START_HERE.md` and callback-helper paths once if an agent becomes idle without a terminal callback.

Before recovery, claims, and follow-up messages, the supervisor fetches the central prompt library. Agent claims also include the prompt revision pinned by the ticket, node ID/name, conversation key, and allowed outcomes. The supervisor still performs the same Herdr assignment/callback handshake; it does not interpret the workflow graph.

## Durable assignment bundles

Before prompting Herdr, the supervisor materializes the active node run at:

```text
ASSIGNMENT_ROOT/<supervisor-id>/tickets/<ticket-id>/
  ACTIVE.json
  runs/<attempt>-<node-id>-<node-run-id>/
    START_HERE.md
    ticket.md
    node.md
    incoming.md
    context.json
    callbacks.md
    callbacks.json
    callback
    updates/
    outbox/
```

Names use the tracker IDs directly; the supervisor does not rewrite them. `START_HERE.md` gives the reading order, repository paths, and the exact callback helper. `ticket.md`, `node.md`, and `incoming.md` separate authoritative ticket content, the current reusable prompt, and predecessor context so the agent can recover after compaction without retaining a large Herdr message. `context.json` is the machine-readable snapshot. `ACTIVE.json` points to the current run while older visits remain available for diagnosis.

The generated `callback` executable reads its adjacent lease-fenced configuration. It supports `schema`, `complete`, `ask`, `fail`, `comment`, and metadata `get`/`put`, and records each request and response under `outbox/`. Run `<absolute-helper-path> schema complete` to recover the payload shape and exact allowed outcome. The helper is generated code, not an agent skill.

Assignment files are ordinary supervisor-local files on the dedicated VM. Their header tells agents they may use them for scratch notes, but edits are not observed, sent to the tracker, or durable workflow changes. Tracker callbacks and ticket APIs remain the source of truth; this feature adds no permission profile or filesystem security boundary.

Live ticket edits and answered questions already create durable guidance. Before forwarding each item, the supervisor reloads the current lease assignment from the tracker, refreshes the bundle, writes `updates/<sequence>-<guidance-id>.md`, and sends only its exact path plus the recovery paths. A provider quota pause retains the same lease and node-run directory. A genuine retry or loop visit receives a new node-run directory.

For a `script` claim, the supervisor resolves `script_file` and `working_directory` independently from one of three explicit bases: the node's selected repository, the ticket's primary repository, or `PROJECT_ROOT`. Each reference can use a static workflow path or a non-boolean ticket workflow input. Paths must remain beneath their base before and after symbolic-link resolution; absolute paths, traversal, missing targets, symlink escapes, non-files, and non-executable scripts fail before launch. The supervisor process cwd is never a fallback. Legacy `action` nodes normalize to `.agents/actions/<action>.sh` in the selected repository.

A Script may instead contain trusted inline shell, Python, or JavaScript; inline code is operator-owned configuration and runs with the supervisor's credentials, not in a sandbox. Both forms run from the explicitly resolved working directory, heartbeat their lease, capture stdout and stderr separately, and report bounded streams, numeric exit code, resolved script path, and resolved working directory to the tracker. The tracker persists those paths in the node-run audit and decides whether stdout is stored as an external artifact and how many trailing lines become next-node prompt context. Lease interruption, cancellation, fencing, or loss of tracker control aborts the child process and prevents a stale result callback. The tracker will not assign a Script whose runtime is absent from this supervisor's advertised capabilities.

Before execution, the supervisor inspects every ticket repository under `PROJECT_ROOT` and builds a context containing its absolute path, primary flag, current local branch, `origin/HEAD` default branch, HEAD SHA, origin URL, and recorded PRs. All Script forms receive that structure in `AGENTIC_CONTEXT_JSON`, with convenient variables including `AGENTIC_PROJECT_ROOT`, `AGENTIC_SCRIPT_PATH`, `AGENTIC_WORKING_DIRECTORY`, `AGENTIC_REPOSITORY_ID`, `AGENTIC_REPOSITORY_PATH`, `AGENTIC_PRIMARY_REPOSITORY_ID`, `AGENTIC_PRIMARY_REPOSITORY_PATH`, `AGENTIC_CURRENT_BRANCH`, `AGENTIC_DEFAULT_BRANCH`, `AGENTIC_HEAD_SHA`, `AGENTIC_REMOTE_URL`, `AGENTIC_REPOSITORIES_JSON`, `AGENTIC_PULL_REQUESTS_JSON`, workflow/node identifiers, attempt number, and incoming transition context. Missing or detached Git values are empty strings rather than guessed values.

Named repository actions additionally receive stable CLI flags:

```text
--context-json <json>
--ticket-id <id>
--project-root <path>
--repository-id <id>
--repository-path <path>
--primary-repository-id <id>
--primary-repository-path <path>
--current-branch <branch-or-empty>
--default-branch <branch-or-empty>
--head-sha <sha-or-empty>
--script-path <absolute-path>
--working-directory <absolute-path>
```

`--context-json` is the complete multi-repository contract and should be preferred when an action needs more than the selected repository. Inline programs use the equivalent environment variables so shell, Python, and JavaScript receive the same information without language-specific argument behavior.

Initial assignment delivery uses `herdr agent prompt --wait` with a six-second timeout. Herdr reports an ineffective submission as `agent_prompt_stalled` after five seconds; the supervisor then retries the identical bootstrap once. A normal timeout means activity began and the agent is still working. Callback reminders are not armed until this delivery handshake confirms activity, so a missing assignment is retried instead of being replaced by a context-free reminder. The reminder names the exact absolute `START_HERE.md` and `callback` paths, so it remains actionable even if compaction removed the original bootstrap.

On macOS, a newly opened login shell can leave its pane temporarily unavailable. Both new-pane startup and restoration into a saved pane retry only Herdr's `agent_pane_busy` error every 500 milliseconds for up to 10 seconds. All other `agent start` errors remain fail-fast, and an exhausted busy window preserves the original Herdr error.

## Usage telemetry

Every active heartbeat can include a versioned `HarnessTelemetrySnapshot`. A node stores the session snapshot captured at its start and the latest snapshot, while the tracker derives the node delta. This baseline/delta model prevents reused specification, implementation, and repair conversations from double-counting earlier work. The node run retains the final record after its lease closes, and a dedicated late-telemetry callback allows the supervisor to capture tokens written just before an agent's terminal callback.

Built-in adapters currently read:

- Codex session JSONL for exact model ID, reasoning effort, cumulative input/cached/output/reasoning tokens, context use, CLI version, turn timing, plan metadata, and rate-limit windows.
- Claude session and subagent JSONL for exact model IDs, deduplicated usage, cache read/write tokens, thinking presence, CLI version, service tier, speed, and inference region. Claude's effort is labeled `current_configuration` when only the current setting is available. The optional live status-line feed adds the session's exact current effort/thinking state, context, five-hour/seven-day limits, and Claude's client-estimated USD cost.

Cost provenance is explicit: `reported`, `estimated`, or `unavailable`. The adapters never apply their own price table. Codex subscription sessions expose tokens but not an attributable USD amount. Claude's live status line exposes a client-side estimate, which is stored as `estimated`; without that optional feed Claude cost remains unavailable. New harnesses implement the small telemetry adapter interface without changing ticket or UI schemas. Telemetry collection is best effort: missing, rotated, or malformed session files never interrupt agent work.

To enable the higher-fidelity Claude feed, set Claude's `statusLine.command` to the shipped collector using the absolute checkout path:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/mkwrz-ai-config/workflow/supervisor/scripts/claude-telemetry-statusline.mjs"
  }
}
```

The collector writes one mode-`0600` snapshot per session through atomic rename and renders a small model/effort/context/cost status line. Set `CLAUDE_TELEMETRY_STATUSLINE_QUIET=1` in Claude's environment to capture without rendering text. If an existing custom status line is important, leave it in place until it is deliberately composed with this collector; transcript-based token capture continues without this setting.

The assignment and phase prompts may use `{{project_root}}`. At runtime it resolves to the same absolute `PROJECT_ROOT` passed to `herdr workspace create --cwd`, so the default assignment explicitly tells the agent which checkout root to use and not to search for alternate project roots unless directed.

The tracker library is the only prompt source. The supervisor has no packaged or local fallback and does not support `PROMPTS_DIR`. If `/api/prompts` is unavailable, or one of the required `assignment`, `guidance`, or `callback-reminder` envelopes is missing or invalid, the supervisor logs the error and retries without recovering or claiming agent work. Invalid unused reusable prompts are ignored; the tracker supplies and validates the current node's pinned prompt independently. Existing tracker prompt files remain untouched.

For a built process:

```bash
npm run build
npm start
```

## Verify

```bash
npm run verify
```
