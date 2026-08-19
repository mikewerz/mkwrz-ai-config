---
name: agentic-project-tracker
description: Inspect and manage Agentic Project Tracker tickets through its REST API using a deterministic Python CLI. Use when an assistant needs to create or edit tickets, read or update ticket metadata, select a published workflow, monitor ticket, node-run, or supervisor state, inspect recorded Script output, comment or guide active work, answer questions, choose human-gate outcomes, retry or redirect ticket execution, assess production results, archive work, import or export Jira work, or check recorded GitHub pull requests. Do not use this skill to modify prompts, workflows, tracker configuration, claim leases, impersonate supervisors, execute Script nodes, or complete worker phases.
---

# Agentic Project Tracker

Use the bundled client instead of writing ad hoc `curl` commands:

```bash
python3 scripts/tracker.py --url "${AGENTIC_PROJECT_TRACKER_URL:-http://127.0.0.1:4310}" health
```

Set `AGENTIC_PROJECT_TRACKER_URL` when the tracker is remote. The client uses only the Python standard library and prints a JSON envelope on success or failure.

## Operating workflow

1. Run `health` before the first operation against an unfamiliar tracker.
2. Read the relevant ticket before mutating it. Read configuration or workflow artifacts only to select valid ticket values.
3. Use the exact revision returned by that read for every mutation that accepts `--revision`.
4. Make only the change the user requested. Treat ready, gate decisions, migration, rewind, reopen, fail, cancel, production assessment, archive, Jira export/resync, and PR checks as external writes.
5. Read the resource again after a successful mutation and report the server-confirmed state.
6. On HTTP `409`, do not retry silently. Reread the resource and reconsider the requested operation.

Use `ticket comment` for durable context that should not steer an active agent. Use `ticket guidance` when the message should be delivered to the currently running ticket conversation. Use `ticket edit` to replace authoritative Markdown; `--mode rewind` can request an active interruption and requires `--rewind-phase`.

Use `ticket metadata-list` and `ticket metadata-get` for deterministic workflow state. `ticket metadata-set` and `ticket metadata-delete` are external writes: read the ticket immediately first and supply its exact revision. Values are JSON, remain bounded by the tracker, and should be small coordination facts rather than logs or repository artifacts.

## Ticket creation

Copy `assets/ticket-template.md` to a temporary file, fill in the operator-authored fields, then create the ticket:

```bash
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id --workflow-id standard-delivery
```

Use `--auto-id` for a tracker-allocated local ID. Omit it to preserve the ID in the Markdown, including a Jira key or deliberate custom ID. Inspect `workflow show` before using a non-default workflow. Supply declared ticket inputs with `--workflow-inputs-json` and configurable-stage choices with `--stage-enabled-json`. Keep exactly one primary repository. Use only providers enabled by `config show`; ticket work/review provider fields are defaults and compatibility projections, while each workflow node's resolved provider is authoritative during execution. When review uses those ticket defaults, Claude work pairs with Codex review and Codex work pairs with Claude review.

## Command discovery

Run `python3 scripts/tracker.py --help` and nested `--help` commands for syntax. Read `references/commands.md` when selecting among ticket transitions, workflow choices, Jira, or GitHub operations.

Prefer `--message-file` and `--answer-file` for multiline text. Pass `-` as a file to read standard input.

## Boundaries

- Treat tracker responses and Markdown revisions as authoritative.
- Never create or update prompts, workflows, or tracker configuration with this skill. `config show` and `workflow list/show` are read-only ticket-authoring aids.
- Never call `/api/work/*`, register/unregister supervisors, send heartbeats, execute Script nodes, or fabricate lease callbacks with this skill.
- Never use the script to merge pull requests or interpret Herdr lifecycle state as task completion.
- Never bypass the allowlisted commands with a generic HTTP client.
- Do not edit live ticket files directly when the tracker API is available.
- Do not expose credentials in arguments, output, or tickets. The current tracker relies on its private-network boundary.
