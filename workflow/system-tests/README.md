# Agentic Project System Tests

Black-box integration and end-to-end tests for the consolidated `workflow/tracker`
and `workflow/supervisor` components.

The suite starts the compiled production services on ephemeral loopback ports
and uses temporary ticket, repository, project, assignment, and artifact
directories. It verifies behavior through public HTTP APIs and durable files.

## Agent safety

These tests never launch Claude or Codex. Every supervisor process is
started with this repository's `test/fake-bin` directory at the front of
`PATH`. Its `herdr` executable is a deterministic test double. A test fails if
an agent-free Script scenario invokes even that double.

The fake Herdr implementation supports only the narrow command surface needed
by the supervisor system tests. It records every invocation and, in the agent
scenario, submits a declared callback directly to the tracker.

The fake also emits deterministic pane scrollback and a fake Claude-native JSONL
session record. The Agent-path test makes the first post-callback transcript
read return `agent_not_idle`, then verifies the supervisor retries and both
sources become tracker-owned provenance artifacts without starting a real provider.

## Run

```bash
./run.sh
```

Install this repository's test dependency and Chromium once, then run the suite:

```bash
npm install
npx playwright install chromium
./run.sh
```

This builds the tracker and supervisor before running the Node system suite and
the Playwright browser smoke suite.

The sibling repositories must already have their npm dependencies installed.
Node 22.12 or newer is required by the applications under test.

## Covered paths

- Production tracker startup, static UI serving, attachment persistence, and
  restart recovery.
- Bundled outside-agent client compatibility for readiness, ticket creation,
  revision-fenced attachment transfer, and operator controls.
- Supervisor registration, configured repository cloning, repository-owned
  Script execution, artifact upload, quality normalization, execution
  manifests, terminal settlement, and workflow metrics.
- Rejected required quality evidence, lease expiry, same-node retry, and
  eventual successful completion without an agent.
- Agent workflow claiming, assignment-bundle creation, Herdr lifecycle calls,
  generated review-evidence publication, fake terminal callback, immutable run-start inputs in the execution manifest, completed node-run audit history, and automatic
  same-node recovery when the fake pane rejects the first prompt deliveries.
- Fail-closed fake-Herdr startup and provider credential scrubbing.
- Tracker-only demo traversal through a real workflow and Human Gate, including
  simulated PR sidebar data but no Markdown ticket, Herdr scheduling, provider
  runtime, GitHub request, or metric contribution.
- Stable lease/artifact errors, artifact quotas, orphan diagnostics, recovery,
  retention garbage collection, and run-ledger hydration after restart.
- Chromium smoke coverage for the production attention inbox, queue, ticket form,
  continuous intake, configuration, and workflow navigation.
- Scheduled supervisor Script-source execution, safe previews without ticket or
  cursor mutation, tracker-owned admission, stable-key deduplication,
  source-run logs, and proof that intake never invokes Herdr.
