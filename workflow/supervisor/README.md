# Agentic Project Supervisor

The supervisor is a small outbound-only daemon between the workflow tracker and a named Herdr session. One process represents one isolated project root and owns at most one nonterminal ticket end-to-end. It maintains one claim loop for each configured provider, starts or resumes the appropriate ticket conversation, forwards live guidance, records observed liveness, maintains the lease, and publishes host health to the tracker.

It contains no workflow graph, worktree management, testing policy, terminal-output parser, or agent permission profile. Its only repository automation is a narrow bootstrap step: clone catalog entries that are absent from this supervisor's project root. Herdr lifecycle state is observational; only an explicit agent callback can complete a phase.

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
- `PROVIDERS` controls which outbound claim slots run and is advertised with claims. Tickets explicitly select Claude Code or Codex for specification/implementation. Claude work is reviewed by Codex and Codex work by Claude. There is no implicit provider fallback; unavailable selections remain ready and wait.
- `HEARTBEAT_INTERVAL_MS` defaults to 30 seconds.
- `SUPERVISOR_HOST` overrides automatic hostname detection. Every supervisor process on one VM must use the same value, and separate VMs must use distinct values; the tracker uses it for host-local repository locking. `SUPERVISOR_IPS` overrides the detected IPv4 addresses shown on the health page.

## Repository bootstrap

The tracker Configuration page stores repository IDs and Git clone URLs in `TICKETS_ROOT/tracker-config.yaml`. On startup and once per heartbeat interval, the supervisor fetches that catalog. It clones each missing repository through a temporary directory and atomically publishes the completed checkout at `PROJECT_ROOT/<id>`.

The machine account running this daemon must already have credentials for every configured URL. A malformed catalog or failed clone is logged and retried, and prevents this supervisor from recovering or claiming tickets until the catalog reconciles successfully. It does not alter ticket state or interrupt work that is already running.

## Tracker-managed prompts

The tracker's Prompt Editor owns the active coordinator text as six Markdown files under `TICKETS_ROOT/prompts`:

- `assignment.md` is the common ticket and callback envelope;
- `specification.md`, `implementation.md`, and `review.md` are the phase instructions;
- `guidance.md` wraps durable operator guidance; and
- `callback-reminder.md` gives an idle agent the rendered lease callback endpoints and payload examples again, so it can still report after context compaction.

Before recovery, claims, and follow-up messages, the supervisor fetches the central prompt library. Editing a prompt in the tracker therefore affects subsequent sends on every supervisor without rebuilding or restarting a daemon. The editor documents and validates the supported `{{meta_tags}}`, required callback fields, applicable stages, and transition triggers.

Initial assignment delivery uses `herdr agent prompt --wait` with a six-second timeout. Herdr reports an ineffective submission as `agent_prompt_stalled` after five seconds; the supervisor then retries the identical full assignment once. A normal timeout means activity began and the agent is still working. Callback reminders are not armed until this delivery handshake confirms activity, so a missing assignment is retried instead of being replaced by a context-free reminder.

The assignment and phase prompts may use `{{project_root}}`. At runtime it resolves to the same absolute `PROJECT_ROOT` passed to `herdr workspace create --cwd`, so the default assignment explicitly tells the agent which checkout root to use and not to search for alternate project roots unless directed.

The tracker library is the only prompt source. The supervisor has no packaged or local fallback and does not support `PROMPTS_DIR`. If `/api/prompts` is unavailable, incomplete, or invalid, the supervisor logs the error and retries without recovering or claiming work. Existing tracker prompt files remain untouched.

For a built process:

```bash
npm run build
npm start
```

## Verify

```bash
npm run verify
```
