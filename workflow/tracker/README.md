# Agentic Project Tracker

The tracker is the durable control plane for the lightweight AI Self-Coordinator. It stores every ticket as authoritative Markdown, exposes claims and small agent callbacks over REST, and gives an operator a React dashboard for ticket authoring, workflow visibility, agent monitoring, approvals, feedback, guidance, and recovery.

It coordinates work boundaries. It does not prescribe how an assigned agent plans, edits code, runs tests, uses Git, or creates pull requests.

The preserved lightweight baseline is [`docs/specs/init.md`](docs/specs/init.md). The implemented V3 software-factory contract is [`docs/specs/v3.md`](docs/specs/v3.md).

The exact standalone revision incorporated into this consolidated copy is recorded in [`../SOURCE_REVISIONS.md`](../SOURCE_REVISIONS.md).

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

The tracker also creates `tracker-config.yaml`, `prompts/`, and `workflows/` directly beneath `TICKETS_ROOT`. Its Configuration page manages the repository catalog, the `AGENT-nnnn` ticket sequence, optional Jira Cloud settings, and optional GitHub PR observation. Updates are revision-fenced and atomically replace the YAML file while preserving future top-level settings that the current UI does not know about.

The Prompt Editor manages reusable Markdown artifacts in `TICKETS_ROOT/prompts`. It can clone new prompts, shows the workflow nodes that reference each prompt, documents `{{meta_tags}}`, and renders a dummy-ticket preview. The Workflow Editor manages validated YAML graphs in `TICKETS_ROOT/workflows`, shows their nodes and edges, and publishes content-addressed revisions. Historical prompt and workflow revisions are retained under each library's `.versions/` directory, and tickets pin the exact revisions they start with.

The assignment prompt documents complete JSON schemas for comment, ask, complete, and fail callbacks. `ask` accepts one question or a batch, and every question can carry any number of suggested `options`. Batched questions are stored and answered independently while the same lease and agent conversation wait for every answer. Options are UI shortcuts only; operators always have a freeform answer field.

Jira is disabled by default and needs no credentials for personal use. To enable it, set the Atlassian site/project in Configuration and provide `JIRA_EMAIL` plus `JIRA_API_TOKEN` in the tracker environment. GitHub PR observation uses `GITHUB_TOKEN`; its periodic switch and interval live in Configuration.

For a production build:

```bash
npm run build
npm start
```

The production Express process serves both the API and `dist/client`. Only one process may own a ticket root; the process lock is released during graceful shutdown and stale process locks are recovered.

## Dashboard

Pending tickets use a structured Jira-style editor while preserving Markdown as the storage format. The operator selects a shared workflow or clones a ticket-specific workflow before marking work ready. After work begins, the dashboard renders the pinned graph and current node, state controls, PRs, agent conversations, immutable node runs, and durable activity. Invalid files expose a raw recovery editor.

Local ticket creation suggests the next atomic `AGENT-nnnn` ID. The operator may replace that suggestion with any unique nonempty ID before creation; custom and Jira-provided IDs do not consume the local sequence.

The top bar offers Light, Dark, and Retro Hacker themes. Dark preserves the original dashboard palette, Light adapts the same visual system for bright environments, and Retro Hacker uses a green phosphor terminal treatment. The selection is stored in the browser and restored on later visits.

Each ticket selects default work and review agents, while every V3 agent node may use those roles or explicitly select Claude or Codex. The current node's provider and conversation key are authoritative; phase-agent fields are projections only. Conversation keys preserve the intended Herdr session through loops, and provider selection never silently falls back.

The active-agent strip and ticket runtime panel show the actual workflow stage, node, resolved provider, node-scoped attempt/loss count, supervisor heartbeat, lease countdown, Herdr lifecycle state and state age, pane/workspace/tab identity, foreground cwd, terminal title, session metadata, and reported display tokens. The Supervisor Health page shows every reporting daemon's VM/host IP, isolated project root, Herdr session, available agents, detected Script runtimes, online state, and reserved ticket. Terminal output remains in Herdr. Full Script output is stored separately beneath `TICKETS_ROOT/.runs`; tickets retain a small tail and artifact digest/link.

The Configuration page lists the repositories every supervisor must have. Each supervisor clones a missing entry into `PROJECT_ROOT/<repository-id>` before it can claim work. Existing paths are never pulled, reset, or replaced by this reconciliation. The Prompt Editor separately shows the agent messages, their workflow triggers, supported meta tags, and a full rendered example.

Ready tickets also show derived repository blockers. A supervisor cannot claim a ticket while another nonterminal ticket assigned on the same hostname names any of the same repositories. Approval waits and attention states retain the reservation; completion, cancellation, or explicit release frees it. The ticket remains ready for supervisors on other hosts.

## Agent skill

[`skills/agentic-project-tracker`](skills/agentic-project-tracker) is a portable, non-MCP ticket-management skill for assistants and orchestrators. Its standard-library Python client creates and edits tickets, selects published workflows and ticket-specific inputs, handles human gates and questions, monitors ticket/supervisor state, and supports Jira and GitHub follow-up. Configuration and workflow catalogs are read-only; prompt access, artifact publication, supervisor mutation, Script execution, and `/api/work/*` lease callbacks are intentionally excluded.

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

The suite covers Markdown admission and preservation, versioned prompt/workflow artifacts, graph validation, typed nodes, deterministic activity allowlisting, gates and loops, duplicate rejection, external edits, atomic claims, lease/node-run fencing, routing, workflow transitions, and callback idempotency.
