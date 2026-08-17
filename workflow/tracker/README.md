# Agentic Project Tracker

The tracker is the durable control plane for the lightweight AI Self-Coordinator. It stores every ticket as authoritative Markdown, exposes claims and small agent callbacks over REST, and gives an operator a React dashboard for ticket authoring, workflow visibility, agent monitoring, approvals, feedback, guidance, and recovery.

It coordinates work boundaries. It does not prescribe how an assigned agent plans, edits code, runs tests, uses Git, or creates pull requests.

The decision-complete V1 contract is [`docs/specs/init.md`](docs/specs/init.md).

## Run locally

Node 22.12 or newer is required.

For normal VM operation, configure `.env` and run the production launcher:

```bash
cp .env.example .env
./run.sh
```

`run.sh` changes to the repository directory, runs `npm ci` when dependencies are absent or older than `package-lock.json`, builds the server and React production bundle, and replaces itself with the compiled server process. The UI and REST API are both served from `HOST:PORT`; there is no Vite port in this mode.

For source-watching development instead:

```bash
npm ci
npm run dev
```

Set `TICKETS_ROOT` to the directory containing the authoritative ticket Markdown files. The API defaults to `http://127.0.0.1:4310`; Vite serves the development UI separately and proxies `/api` requests to it.

The tracker also creates `tracker-config.yaml` and a reserved `prompts/` directory directly beneath `TICKETS_ROOT`. Its Configuration page manages the repository catalog, the `AGENT-nnnn` ticket sequence, optional Jira Cloud settings, and optional GitHub PR observation. Updates are revision-fenced and atomically replace the YAML file while preserving future top-level settings that the current UI does not know about.

The Prompt Editor manages the six Markdown templates in `TICKETS_ROOT/prompts`. Each template shows exactly which phase or transition sends it, its available and required `{{meta_tags}}`, and a server-rendered dummy-ticket preview. Startup creates missing defaults and may upgrade an exact, unchanged older default; operator-edited prompts are never overwritten. Supervisors fetch this central library before work so one edit applies across hosts without rebuilding either service.

The assignment prompt documents complete JSON schemas for comment, ask, complete, and fail callbacks. `ask` accepts one question or a batch, and every question can carry any number of suggested `options`. Batched questions are stored and answered independently while the same lease and agent conversation wait for every answer. Options are UI shortcuts only; operators always have a freeform answer field.

Jira is disabled by default and needs no credentials for personal use. To enable it, set the Atlassian site/project in Configuration and provide `JIRA_EMAIL` plus `JIRA_API_TOKEN` in the tracker environment. GitHub PR observation uses `GITHUB_TOKEN`; its periodic switch and interval live in Configuration.

For a production build:

```bash
npm run build
npm start
```

The production Express process serves both the API and `dist/client`. Only one process may own a ticket root; the process lock is released during graceful shutdown and stale process locks are recovered.

## Dashboard

Pending tickets use a structured Jira-style editor while preserving Markdown as the storage format. After work begins, the dashboard renders the ticket as a read-only issue with a fixed workflow map, state controls, PRs, agent conversations, and durable activity. Invalid files expose a raw recovery editor.

Local ticket creation suggests the next atomic `AGENT-nnnn` ID. The operator may replace that suggestion with any unique nonempty ID before creation; custom and Jira-provided IDs do not consume the local sequence.

The top bar offers Light, Dark, and Retro Hacker themes. Dark preserves the original dashboard palette, Light adapts the same visual system for bright environments, and Retro Hacker uses a green phosphor terminal treatment. The selection is stored in the browser and restored on later visits.

Each ticket explicitly selects Claude Code or Codex as its work agent. Specification and implementation share that agent's ticket conversation. Independent review is paired across agent families: Claude work is reviewed by Codex and Codex work by Claude. Provider selection never silently falls back.

The active-agent strip and ticket runtime panel show the supervisor heartbeat, lease countdown, attempt, Herdr lifecycle state and state age, pane/workspace/tab identity, foreground cwd, terminal title, session metadata, and reported display tokens. The Supervisor Health page shows every reporting daemon's VM/host IP, isolated project root, Herdr session, available agents, online state, and reserved ticket. Terminal output remains in Herdr and is not copied into ticket files.

The Configuration page lists the repositories every supervisor must have. Each supervisor clones a missing entry into `PROJECT_ROOT/<repository-id>` before it can claim work. Existing paths are never pulled, reset, or replaced by this reconciliation. The Prompt Editor separately shows the agent messages, their workflow triggers, supported meta tags, and a full rendered example.

Ready tickets also show derived repository blockers. A supervisor cannot claim a ticket while another nonterminal ticket assigned on the same hostname names any of the same repositories. Approval waits and attention states retain the reservation; completion, cancellation, or explicit release frees it. The ticket remains ready for supervisors on other hosts.

## Agent skill

[`skills/agentic-project-tracker`](skills/agentic-project-tracker) is a portable, non-MCP operator skill for assistants and orchestrators. Its standard-library Python client covers the dashboard's ticket, workflow, supervisor/runtime, configuration, prompt, Jira, and GitHub-observation operations while intentionally excluding supervisor registration and `/api/work/*` lease callbacks.

Install or symlink that directory into the orchestrator's normal skill directory, then configure the tracker origin:

```bash
export AGENTIC_PROJECT_TRACKER_URL=http://127.0.0.1:4310
python3 skills/agentic-project-tracker/scripts/tracker.py health
```

Run its isolated client tests with:

```bash
python3 -m unittest discover -s skills/agentic-project-tracker/tests -v
```

## Verify

```bash
npm run verify
```

The suite covers Markdown admission and preservation, prompt seeding/validation/preview, duplicate rejection, external edits, atomic claims, lease loss fencing, routing, workflow transitions, and callback idempotency.
