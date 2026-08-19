# Lightweight Agent Workflow

This directory packages the lightweight project workflow as one locally deployable unit:

- [`tracker/`](tracker/) stores authoritative Markdown tickets, serves the operator dashboard and REST API, and owns workflow transitions, leases, guidance, and history.
- [`supervisor/`](supervisor/) claims eligible work and uses Herdr to start or resume full-capability Claude Code and Codex conversations.
- [`herdr/`](herdr/) installs a pinned Herdr release, verifies its checksum, and installs Herdr's official Claude Code and Codex integrations.

The tracker and supervisor default to localhost communication. Agents retain their normal tools, credentials, and reasoning behavior; only explicit callbacks advance ticket phases.

The current source snapshot includes the V3 workflow library, nested and parallel graph execution, versioned prompts, agent profiles, factory metrics, durable assignment bundles, Claude/Codex session telemetry, and deterministic supervisor-side Script activities. See [`SOURCE_REVISIONS.md`](SOURCE_REVISIONS.md) for the exact standalone commits incorporated into this copy.

## Local setup

Requirements:

- Node.js 22.12 or newer and npm
- Python 3.10 or newer
- Git
- initialized Claude Code and Codex installations

Install and verify Herdr:

```bash
cd workflow/herdr
python3 install.py --yes
python3 install.py --check
```

Configure and start the tracker:

```bash
cd workflow/tracker
cp .env.example .env
# Set TICKETS_ROOT to an absolute local directory.
./run.sh
```

In another terminal, configure and start the supervisor:

```bash
cd workflow/supervisor
cp .env.example .env
# Set PROJECT_ROOT to the parent directory for managed repositories.
./run.sh
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310). The production tracker process serves both the dashboard and API on this one origin.

Use documentation-only addresses from `192.0.2.0/24` when illustrating remote hosts. For an actual multi-host deployment, replace localhost callback settings with private reachable addresses and add appropriate network access controls; the tracker has no built-in authentication.

## Verify

```bash
(cd workflow/herdr && python3 -m unittest discover -s tests -v)
(cd workflow/tracker && npm ci && npm run verify && python3 -m unittest discover -s skills/agentic-project-tracker/tests -v)
(cd workflow/supervisor && npm ci && npm run verify)
```
