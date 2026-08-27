# Agentic Project Supervisor

The supervisor is a small outbound-only daemon between `agentic-project-tracker` and a named Herdr session. One process represents one isolated project root and owns at most one nonterminal ticket end-to-end. It maintains one claim loop for each configured provider, starts or resumes the appropriate ticket conversation, forwards live guidance, records observed liveness, maintains the lease, and publishes host health to the tracker.

It contains no workflow graph, worktree management, testing policy, terminal-output parser, or agent permission profile. The tracker sends it an already-resolved node to execute. Its repository automation is limited to cloning missing catalog entries and executing declared `script` nodes. Herdr lifecycle state is observational; only an explicit agent callback can complete an agent node.

The supervisor also collects compact, provider-neutral usage telemetry from each harness's native session artifacts. At Agent-node boundaries it best-effort uploads a bounded readable Herdr transcript plus the native Codex or Claude JSONL session files to the tracker's provenance artifact store. This is accounting and audit evidence, not agent-output interpretation. The tracker may use a known cost observation to request interruption when a workflow Agent node exceeds its configured cumulative budget, but telemetry never selects a semantic workflow edge.

It also runs one independent continuous-intake loop. This loop claims tracker-scheduled source runs and executes their declared shell, Python, or JavaScript discovery script without Herdr. Source execution does not consume an agent-provider slot and cannot advance an existing ticket workflow; it only returns candidate observations to the tracker admission controller.

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
- `HERDR_EXECUTABLE` optionally pins the absolute Herdr binary path. The workflow installer sets it to the verified per-user installation so non-login service shells do not depend on `PATH` initialization.
- `CODEX_HOME` and `CLAUDE_CONFIG_DIR` optionally override the native telemetry roots. Defaults are `~/.codex` and `~/.claude`. `AGENTIC_TELEMETRY_ROOT` defaults to `~/.agentic-project-supervisor/telemetry` and stores optional live harness snapshots.
- `SESSION_EVIDENCE_ENABLED` defaults to `true` and captures readable Herdr scrollback for each Agent run. `HERDR_TRANSCRIPT_LINES` defaults to `5000` (valid range 120-100000). `NATIVE_SESSION_EVIDENCE_ENABLED` defaults to `true` and copies the harness's own session JSONL when discoverable. `SESSION_EVIDENCE_MAX_BYTES` defaults to 64 MiB per source file; larger files are tail-captured and explicitly marked partial.
- `PROVIDERS` controls which outbound claim slots run and is advertised with agent and Script claims. The tracker resolves each V3 agent-profile alias to a pinned provider/model/reasoning tuple; the supervisor passes that tuple through the provider's native launch/resume arguments. There is no implicit provider fallback; unavailable nodes remain ready and wait. The daemon also detects repository-action, shell, JavaScript, and Python activity capabilities. Before first ownership, claims require this supervisor to advertise every provider and Script runtime needed by enabled workflow nodes.
- `HEARTBEAT_INTERVAL_MS` defaults to 30 seconds.
- `HERDR_COMMAND_TIMEOUT_MS` defaults every Herdr CLI invocation to 45 seconds so a wedged pane command cannot silently consume the ticket lease. After starting or restoring an agent process, `AGENT_START_READY_TIMEOUT_MS` defaults to a 30-second wait for Herdr's `interactive_ready=true` and `launch_pending=false`; `AGENT_START_READY_SETTLE_MS` requires that state to remain stable for 10 seconds because some provider TUIs report readiness before their composer is actually usable. Herdr versions without those fields receive the full timeout as a conservative compatibility delay. `ASSIGNMENT_PROMPT_RECOVERY_MS` defaults to 30 seconds for content-anchored recovery after Herdr reports a stalled or timed-out initial prompt. `CALLBACK_REMINDER_GRACE_MS` defaults to 60 seconds after the last observed activity before the one-time missing-callback reminder is sent.
- `TRACKER_REQUEST_TIMEOUT_MS` defaults ordinary tracker calls to 15 seconds, `TRACKER_CLAIM_TIMEOUT_MS` gives long-poll claims 45 seconds, and `TRACKER_ARTIFACT_TIMEOUT_MS` gives uploads/downloads five minutes. A deadline failure is reported with stable code `TRACKER_TIMEOUT` and retried by the existing supervisor loop rather than hanging a claim slot indefinitely.
- `LOG_LEVEL` filters newline-delimited JSON logs at `debug`, `info`, `warn`, or `error`. Set `LOG_FILE` to enable built-in size rotation controlled by `LOG_MAX_BYTES` (10 MiB) and `LOG_MAX_FILES` (five archives). `deploy.sh` sets `LOG_FILE` from `DEPLOY_LOG_FILE` automatically.
- `SUPERVISOR_HOST` overrides automatic hostname detection. Every supervisor process on one VM must use the same value, and separate VMs must use distinct values; the tracker uses it for host-local repository locking. `SUPERVISOR_IPS` overrides the detected IPv4 addresses shown on the health page.

## Repository bootstrap

The tracker Configuration page stores repository IDs and Git clone URLs in `TICKETS_ROOT/tracker-config.yaml`. On startup and once per heartbeat interval, the supervisor fetches that catalog. It clones each missing repository through a temporary directory and atomically publishes the completed checkout at `PROJECT_ROOT/<id>`.

The machine account running this daemon must already have credentials for every configured URL. A malformed catalog or failed clone is logged and retried, and prevents this supervisor from recovering or claiming tickets until the catalog reconciles successfully. It does not alter ticket state or interrupt work that is already running.

## Continuous intake sources

An enabled `supervisor_script` intake source is pinned and leased separately from tickets. Its `script_path` and `working_directory` are both relative to `PROJECT_ROOT`. The process receives `AGENTIC_INTAKE_PROTOCOL_VERSION`, `AGENTIC_INTAKE_MODE` (`admit` or `preview`), source/campaign/run identity and pinned revisions, the project root, the last successful cursor as JSON, the pinned source definition as JSON, and `AGENTIC_INTAKE_RESULT_PATH`. It must write a JSON object with a `candidates` array and optional `cursor` to that result path. Stdout and stderr become a bounded tracker-hosted source-run log. Preview runs execute the same source contract, but the tracker does not admit their candidates or advance their cursor.

The supervisor heartbeats the source lease while the process runs, aborts it during daemon shutdown or lease failure, and reports either the exact result or a concrete failure. The tracker validates candidates, applies capacity and deduplication policy, and creates tickets. The source script must never write ticket Markdown or allocate IDs itself. Repository reconciliation runs before intake claims, so a source may inspect any catalog repository beneath this supervisor's isolated project root.

Source result example:

```json
{
  "candidates": [
    {
      "external_key": "dependabot:owner/repo:123",
      "title": "Apply dependency update",
      "description": "Review, verify, and deliver Dependabot PR 123."
    }
  ],
  "cursor": { "last_pull_request": 123 }
}
```

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
    publish-artifact
    updates/
    outbox/
```

Names use the tracker IDs directly; the supervisor does not rewrite them. `START_HERE.md` gives the reading order, repository paths, and the exact callback helper. `ticket.md`, `node.md`, and `incoming.md` separate authoritative ticket content, the current reusable prompt, and predecessor context so the agent can recover after compaction without retaining a large Herdr message. `context.json` is the machine-readable snapshot. `ACTIVE.json` points to the current run while older visits remain available for diagnosis.

The generated `callback` executable reads its adjacent lease-fenced configuration. It supports `schema`, `complete`, `ask`, `fail`, `comment`, metadata `get`/`put`, and `emit-candidates` for parent-linked follow-on work through a configured intake source. It records each request and response under `outbox/`. Run `<absolute-helper-path> schema complete` or `schema candidates` to recover the relevant payload shape. The adjacent `publish-artifact` helper uploads any file as human-readable evidence before the terminal callback, infers common MIME types, and accepts optional title, description, category, and featured display hints. Both helpers are generated code, not agent skills.

Assignment files are ordinary supervisor-local files on the dedicated VM. Their header tells agents they may use them for scratch notes, but edits are not observed, sent to the tracker, or durable workflow changes. Tracker callbacks and ticket APIs remain the source of truth; this feature adds no permission profile or filesystem security boundary.

Live ticket edits and answered questions already create durable guidance. Before forwarding each item, the supervisor reloads the current lease assignment from the tracker, refreshes the bundle, writes `updates/<sequence>-<guidance-id>.md`, and sends only its exact path plus the recovery paths. A provider quota pause retains the same lease and node-run directory. A genuine retry or loop visit receives a new node-run directory.

For a `script` claim, the supervisor resolves `script_file` and `working_directory` independently from one of three explicit bases: the node's selected repository, the ticket's primary repository, or `PROJECT_ROOT`. Each reference can use a static workflow path or a non-boolean ticket workflow input. Paths must remain beneath their base before and after symbolic-link resolution; absolute paths, traversal, missing targets, symlink escapes, non-files, and non-executable scripts fail before launch. The supervisor process cwd is never a fallback, and workflows must declare their script source explicitly.

A Script may instead contain trusted inline shell, Python, or JavaScript; inline code is operator-owned configuration and runs with the supervisor's credentials, not in a sandbox. Both forms run from the explicitly resolved working directory, heartbeat their lease, capture stdout and stderr separately, and report bounded streams, numeric exit code, resolved script path, and resolved working directory to the tracker. The tracker persists those paths in the node-run audit and decides whether stdout is stored as an external artifact and how many trailing lines become next-node prompt context. A Script may also write one bounded JSON object to `AGENTIC_RESULT_PATH`, containing optional `metadata` and `external_references`; the supervisor validates it and includes it in the fenced result callback. Lease interruption, cancellation, fencing, or loss of tracker control aborts the child process and prevents a stale result callback. The tracker will not assign a Script whose runtime is absent from this supervisor's advertised capabilities.

Scripts may declare exact output files relative to their resolved working directory. The supervisor uploads produced files through the active lease before reporting the activity result; required missing files fail the activity. The tracker owns the durable content-addressed copy. The supervisor's staging or assignment directory is only a replaceable materialization cache.

Checkpoint and Restore Checkpoint are separate deterministic activity types. Checkpoint uses a temporary Git index for each ticket-declared repository, creates a synthetic commit that includes current tracked and untracked files without moving normal HEAD, writes a portable Git bundle, and uploads it to the tracker. Restore downloads the chosen tracker bundles, first captures a tracker-owned pre-restore checkpoint, then resets and cleans only those declared repositories. It attempts compensation from the pre-restore bundles if any repository fails. Both activities remain lease-fenced, heartbeat and interrupt exactly like Scripts, advertise `git_checkpoint` or `git_restore`, and never start Herdr or ask an agent to interpret output.

Before execution, the supervisor inspects every ticket repository under `PROJECT_ROOT` and builds a context containing its absolute path, primary flag, current local branch, `origin/HEAD` default branch, HEAD SHA, origin URL, and recorded PRs. All Script forms receive that structure in `AGENTIC_CONTEXT_JSON`, with convenient variables including `AGENTIC_PROJECT_ROOT`, `AGENTIC_SCRIPT_PATH`, `AGENTIC_WORKING_DIRECTORY`, `AGENTIC_RESULT_PATH`, `AGENTIC_REPOSITORY_ID`, `AGENTIC_REPOSITORY_PATH`, `AGENTIC_PRIMARY_REPOSITORY_ID`, `AGENTIC_PRIMARY_REPOSITORY_PATH`, `AGENTIC_CURRENT_BRANCH`, `AGENTIC_DEFAULT_BRANCH`, `AGENTIC_HEAD_SHA`, `AGENTIC_REMOTE_URL`, `AGENTIC_REPOSITORIES_JSON`, `AGENTIC_PULL_REQUESTS_JSON`, workflow/node identifiers, attempt number, and incoming transition context. Missing or detached Git values are empty strings rather than guessed values.

At the start and end of every claimed Agent or deterministic activity, the supervisor captures bounded repository identity (HEAD, branch, remote, dirty state, and hashes of status/diff evidence). After the tracker records completion or interruption, the supervisor submits this plus its host/runtime identity, assignment identity, script digest or agent profile/session facts, and the original transition input to the tracker's manifest finalizer. The resulting immutable execution-manifest artifact is tracker-owned. Finalization is deliberately best effort and never changes the workflow outcome.

Every Agent-node attempt also has a tracker-owned Herdr operational trace. The supervisor records each Herdr command with wall-clock and elapsed timestamps, duration, normalized arguments, bounded response metadata, and stable error codes; it separately records meaningful pane observations and the delivery evaluator's accepted and rejected signals. Prompt and terminal bodies are not copied into the trace: prompt commands retain their byte count and SHA-256 identity, while `agent read` retains only response size and digest. Events are written to a mode-`0600` supervisor-local JSONL spool and streamed to the tracker in immutable, sequence-fenced chunks. The spool is transport recovery evidence, not the durable authority. The tracker links each chunk to its node run and displays grouped traces under the ticket's **Operational traces** evidence tab. Trace collection is best effort and never changes workflow routing.

The separate provenance capture is intentionally human-readable. When an Agent asks a question, completes, fails, is interrupted, disappears, or suffers delivery failure, the supervisor reads bounded pane scrollback and discovers the provider's native session files. It uploads them through a post-callback endpoint that resolves the historical lease to the immutable node run, so a successful terminal callback can fence workflow mutation before evidence transfer. Each artifact records source, provider/session/pane identity, capture disposition, role, and whether the bytes are full, bounded, or partial. Retries are content-deduplicated. Capture failure is logged and traced but never changes the agent's outcome.

Conversation continuity is controlled by each workflow Agent node. The tracker supplies a durable generation counter; the supervisor includes it in the Herdr conversation name. `resume` retains the generation across graph visits, `fresh_each_visit` increments it on every new logical visit, and `reset_after_visits` increments it after the configured visit count. A retry of the same visit and a quota pause retain the generation. This prevents an explicit reset from accidentally restoring an old pane while leaving provider lifecycle mechanics unchanged.

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

An Agent claim starts in a distinct `starting` delivery state. Its lease-renewal timer begins before repository inspection, assignment materialization, pane creation/restoration, telemetry collection, or prompt submission, so slow Claude shell/session initialization cannot expire the lease while the supervisor is still preparing the assignment. After an actual `agent start`, the supervisor polls `agent get` until Herdr reports that interactive input is ready and launch is no longer pending, then waits through a short stable-settle interval before sending work. If the installed Herdr does not expose readiness fields, the supervisor uses the full bounded readiness timeout as a conservative startup delay. Every Herdr subprocess also has the hard `HERDR_COMMAND_TIMEOUT_MS` deadline.

Initial assignment delivery uses `herdr agent prompt --wait` with a six-second wait. Both Herdr's `agent_prompt_stalled` result and its wait timeout are ambiguous for full-screen agents: Claude may already be processing the prompt, or the text may be sitting unsent in its composer. Neither result is treated as delivery proof. The supervisor never pastes the complete assignment a second time on the same lease. For up to `ASSIGNMENT_PROMPT_RECOVERY_MS`, it polls Herdr lifecycle and unwrapped pane text for the assignment's unique absolute `START_HERE.md` path. Claude may collapse a multiline composer into a `[Pasted text #N +M lines]` token that hides that path, so either the exact marker or that collapsed-paste token is sufficient evidence to send only `Enter`. Only a semantic transition from settled `idle`/`done` to `working` confirms delivery from activity; pane revision changes, late native-session discovery, and unknown/blocked startup transitions are not delivery proof. The ticket history identifies whether delivery was direct, confirmed from the working transition, or recovered from staged input. If neither signal appears, the supervisor sends `Ctrl+C` once to clear any invisible staged composer before the tracker fences the lease and requeues the same node. This prevents the retry assignment from being concatenated with stale text while retaining the pane, native session, and conversation generation. The first two consecutive operational delivery losses retry automatically; the third blocks for operator attention. These failed deliveries are audited as `delivery_failed` node runs but take no workflow edge and do not count as semantic workflow failures. Callback reminders are not armed until delivery is confirmed, and `idle`/`done` remains neutral observational state during the configurable grace period. Reminder sends are emitted as correlated structured log events. The reminder names the exact absolute `START_HERE.md` and `callback` paths, so it remains actionable even if compaction removed the original bootstrap.

On macOS, a newly opened login shell can leave its pane temporarily unavailable. Both new-pane startup and restoration into a saved pane retry only Herdr's `agent_pane_busy` error every 500 milliseconds for up to 10 seconds. Once the command is accepted, the separate interactive-readiness gate above prevents the assignment from racing the provider UI initialization. All other `agent start` errors remain fail-fast, and an exhausted busy or readiness window preserves an operational delivery failure without taking a workflow edge.

Declared Script artifacts may carry optional presentation hints for the tracker UI. Artifacts marked as `quality_report` additionally retain their workflow declaration name during upload; the tracker, rather than the supervisor, validates and indexes their YAML against its quality registry. The supervisor never interprets generic evidence content.

## Usage telemetry

Every active node may report a versioned `HarnessTelemetrySnapshot` through the tracker's dedicated telemetry callback. Lease heartbeats and assignment delivery do not depend on telemetry acceptance: malformed, unavailable, or temporarily unpersistable accounting data is logged without changing work. A node stores the session snapshot captured at its start and the latest snapshot, while the tracker derives the node delta. A fresh session carries an explicit zero-baseline marker even when cost is initially unavailable; a reused session captures its current cumulative snapshot. This baseline/delta model prevents reused specification, implementation, and repair conversations from double-counting earlier work. The node run retains the final record after its lease closes, and the same callback allows the supervisor to capture tokens written just before an agent's terminal callback. If known cumulative cost across visits becomes greater than the node's `max_cost_usd` (USD 50 by default), tracker lease control asks the supervisor to stop the active Herdr assignment and acknowledge the fence; the tracker then blocks that node for operator attention. The supervisor does not calculate or override the budget.

Built-in adapters currently read:

- Codex session JSONL for exact model ID, reasoning effort, cumulative input/cached/output/reasoning tokens, context use, CLI version, turn timing, plan metadata, and any rate-limit windows the active plan exposes. The initial weekly percentage is retained beside the zero token baseline for a new conversation so the tracker can correlate a node's usage delta with the same window's percentage movement. API-key billing and plans that omit a weekly window simply report no allowance data.
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

The optional deploy script runs `npm ci`, type-checks, and builds, then checks the tracker's `/api/capabilities` contract before stopping the managed PID. This release requires supervisor protocol 3 for tracker-owned operational trace streaming, so deploy the tracker first. An unreachable or older tracker aborts deployment while leaving the current supervisor running. After a compatible preflight it starts the built daemon, records `.pid`, writes rotating structured output to `supervisor.log`, and requires the configured `SUPERVISOR_ID` to appear online in `/api/supervisors`. Network probes have five-second deadlines. It intentionally refuses broad `pkill` matching and will not stop a process whose command does not match this supervisor.
