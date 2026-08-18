# Agentic Project Supervisor

The supervisor is a small outbound-only daemon between the workflow tracker and a named Herdr session. One process represents one isolated project root and owns at most one nonterminal ticket end-to-end. It maintains one claim loop for each configured provider, starts or resumes the appropriate ticket conversation, forwards live guidance, records observed liveness, maintains the lease, and publishes host health to the tracker.

It contains no workflow graph, worktree management, testing policy, terminal-output parser, or agent permission profile. The tracker sends it an already-resolved node to execute. Its repository automation is limited to cloning missing catalog entries and executing declared `script` nodes. Herdr lifecycle state is observational; only an explicit agent callback can complete an agent node.

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
- `SUPERVISOR_ID` must be stable and unique for this project root. Running another root or VM requires another ID.
- `HERDR_SESSION` is the named persistent Herdr session.
- `PROVIDERS` controls which outbound claim slots run and is advertised with agent and Script claims. V3 nodes may resolve a ticket role or explicitly select Claude or Codex. There is no implicit provider fallback; unavailable nodes remain ready and wait. The daemon also detects repository-action, shell, JavaScript, and Python activity capabilities. Before first ownership, claims require this supervisor to advertise every provider and Script runtime needed by enabled workflow nodes.
- `HEARTBEAT_INTERVAL_MS` defaults to 30 seconds.
- `SUPERVISOR_HOST` overrides automatic hostname detection. Every supervisor process on one VM must use the same value, and separate VMs must use distinct values; the tracker uses it for host-local repository locking. `SUPERVISOR_IPS` overrides the detected IPv4 addresses shown on the health page.

## Repository bootstrap

The tracker Configuration page stores repository IDs and Git clone URLs in `TICKETS_ROOT/tracker-config.yaml`. On startup and once per heartbeat interval, the supervisor fetches that catalog. It clones each missing repository through a temporary directory and atomically publishes the completed checkout at `PROJECT_ROOT/<id>`.

The machine account running this daemon must already have credentials for every configured URL. A malformed catalog or failed clone is logged and retried, and prevents this supervisor from recovering or claiming tickets until the catalog reconciles successfully. It does not alter ticket state or interrupt work that is already running.

## Tracker-managed prompts and activities

The tracker's Prompt Editor owns the core coordinator text and any reusable workflow-node prompts as versioned Markdown files under `TICKETS_ROOT/prompts`:

- `assignment.md` is the common ticket and callback envelope;
- `specification.md`, `implementation.md`, and `review.md` are the phase instructions;
- `guidance.md` wraps durable operator guidance; and
- `callback-reminder.md` gives an idle agent the rendered lease callback endpoints and payload examples again, so it can still report after context compaction.

Before recovery, claims, and follow-up messages, the supervisor fetches the central prompt library. Agent claims also include the prompt revision pinned by the ticket, node ID/name, conversation key, and allowed outcomes. The supervisor still performs the same Herdr assignment/callback handshake; it does not interpret the workflow graph.

For a repository-action `script` claim, the supervisor resolves only `PROJECT_ROOT/<repository-id>/.agents/actions/<action>.sh`. The target must be an executable regular file whose real path remains beneath `.agents/actions`. A script may instead contain trusted inline shell, Python, or JavaScript; inline code is operator-owned configuration and runs with the supervisor's credentials, not in a sandbox. Both forms run from the selected repository directory, heartbeat their lease, and report bounded output plus the numeric exit code to the tracker. Lease interruption, cancellation, fencing, or loss of tracker control aborts the child process and prevents a stale result callback. The tracker will not assign a Script whose runtime is absent from this supervisor's advertised capabilities.

Before execution, the supervisor inspects every ticket repository under `PROJECT_ROOT` and builds a context containing its absolute path, primary flag, current local branch, `origin/HEAD` default branch, HEAD SHA, origin URL, and recorded PRs. All Script forms receive that structure in `AGENTIC_CONTEXT_JSON`, with convenient variables including `AGENTIC_PROJECT_ROOT`, `AGENTIC_REPOSITORY_ID`, `AGENTIC_REPOSITORY_PATH`, `AGENTIC_PRIMARY_REPOSITORY_ID`, `AGENTIC_PRIMARY_REPOSITORY_PATH`, `AGENTIC_CURRENT_BRANCH`, `AGENTIC_DEFAULT_BRANCH`, `AGENTIC_HEAD_SHA`, `AGENTIC_REMOTE_URL`, `AGENTIC_REPOSITORIES_JSON`, `AGENTIC_PULL_REQUESTS_JSON`, workflow/node identifiers, attempt number, and incoming transition context. Missing or detached Git values are empty strings rather than guessed values.

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
```

`--context-json` is the complete multi-repository contract and should be preferred when an action needs more than the selected repository. Inline programs use the equivalent environment variables so shell, Python, and JavaScript receive the same information without language-specific argument behavior.

Initial assignment delivery uses `herdr agent prompt --wait` with a six-second timeout. Herdr reports an ineffective submission as `agent_prompt_stalled` after five seconds; the supervisor then retries the identical full assignment once. A normal timeout means activity began and the agent is still working. Callback reminders are not armed until this delivery handshake confirms activity, so a missing assignment is retried instead of being replaced by a context-free reminder.

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
