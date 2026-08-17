---
name: agentic-project-tracker
description: Inspect and operate an Agentic Project Tracker through its REST API using a deterministic Python CLI. Use when an assistant or orchestrator needs to create or edit tracker tickets, monitor tickets and supervisors, comment or guide active work, answer questions, perform explicit workflow transitions, manage tracker configuration or prompts, import or export Jira work, or check recorded GitHub pull requests. Do not use this skill to claim leases, impersonate supervisors, or complete worker phases.
---

# Agentic Project Tracker

Use the bundled client instead of writing ad hoc `curl` commands:

```bash
python3 scripts/tracker.py --url "${AGENTIC_PROJECT_TRACKER_URL:-http://127.0.0.1:4310}" health
```

Set `AGENTIC_PROJECT_TRACKER_URL` when the tracker is remote. The client uses only the Python standard library and prints a JSON envelope on success or failure.

## Operating workflow

1. Run `health` before the first operation against an unfamiliar tracker.
2. Read the relevant ticket, configuration, or prompt before mutating it.
3. Use the exact revision returned by that read for every mutation that accepts `--revision`.
4. Make only the change the user requested. Treat ready, approval, rewind, reopen, fail, cancel, archive, configuration, prompt, Jira export, and PR-check commands as external writes.
5. Read the resource again after a successful mutation and report the server-confirmed state.
6. On HTTP `409`, do not retry silently. Reread the resource and reconsider the requested operation.

Use `ticket comment` for durable context that should not steer an active agent. Use `ticket guidance` when the message should be delivered to the currently running ticket conversation. Use `ticket edit` to replace authoritative Markdown; `--mode rewind` can request an active interruption and requires `--rewind-phase`.

## Ticket creation

Copy `assets/ticket-template.md` to a temporary file, fill in the operator-authored fields, then create the ticket:

```bash
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id
```

Use `--auto-id` for a tracker-allocated local ID. Omit it to preserve the ID in the Markdown, including a Jira key or deliberate custom ID. Keep exactly one primary repository. Respect the configured provider pairing: Claude work uses Codex review, and Codex work uses Claude review.

## Command discovery

Run `python3 scripts/tracker.py --help` and nested `--help` commands for syntax. Read `references/commands.md` when selecting among workflow, prompt, configuration, Jira, or GitHub operations.

Prefer `--message-file`, `--answer-file`, and `--content-file` for multiline text. Pass `-` as a file to read standard input.

## Boundaries

- Treat tracker responses and Markdown revisions as authoritative.
- Never call `/api/work/*`, register/unregister supervisors, send heartbeats, or fabricate lease callbacks with this skill.
- Never use the script to merge pull requests or interpret Herdr lifecycle state as task completion.
- Never bypass the allowlisted commands with a generic HTTP client.
- Do not edit live ticket files directly when the tracker API is available.
- Do not expose credentials in arguments, output, tickets, or prompt files. The current tracker relies on its private-network boundary.
