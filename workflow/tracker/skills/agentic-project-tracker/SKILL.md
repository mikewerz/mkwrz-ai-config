---
name: agentic-project-tracker
description: Inspect and manage Agentic Project Tracker tickets through its allowlisted REST client. Use for ticket creation and edits, intake inspection and child-candidate emission, metadata, attachments, artifacts, workflow selection and metrics, runtime monitoring, operator guidance and gates, retry or redirect controls, checkpoints, production assessment, archival, Jira, and recorded GitHub PR checks. Do not use it to edit intake definitions, prompts, workflows, release defaults, or tracker configuration; claim leases; impersonate supervisors; execute nodes; or complete worker callbacks.
---

# Agentic Project Tracker

Use the bundled client instead of writing ad hoc `curl` commands:

```bash
python3 scripts/tracker.py --url "${AGENTIC_PROJECT_TRACKER_URL:-http://127.0.0.1:4310}" health
```

Set `AGENTIC_PROJECT_TRACKER_URL` when the tracker is remote. The client uses only the Python standard library and prints a JSON envelope on success or failure.

## Operating workflow

1. Run `health` before the first operation against an unfamiliar tracker. Use `readiness` when deciding whether scheduling dependencies are operational; use `operations` for detailed warnings and background-task state.
2. Read the relevant ticket before mutating it. Read configuration or workflow releases only to select valid ticket values.
3. Use the exact revision returned by that read for every mutation that accepts `--revision`.
4. Make only the change the user requested. Treat ticket creation/editing, attachment upload/removal, priority, ready/draft, human estimates, gate decisions, metadata writes, wait wakeups, conversation resets, workflow migration, checkpoint/restore requests, retry, fail, cancel, production assessment, archive, Jira export/resync, and PR checks as external writes.
5. Read the resource again after a successful mutation and report the server-confirmed state.
6. On HTTP `409`, do not retry silently. Reread the resource and reconsider the requested operation.

Use `ticket comment` for durable context that should not steer an active agent. Use `ticket guidance` when the message should be delivered to the currently running ticket conversation. Use `ticket edit` to replace authoritative Markdown. Editing a running ticket queues guidance to reread it; use an explicit workflow migration when the user asks to restart at another node.

Use `ticket metadata-list` and `ticket metadata-get` for deterministic workflow state. `ticket metadata-set` and `ticket metadata-delete` are external writes: read the ticket immediately first and supply its exact revision. Values are JSON, remain bounded by the tracker, and should be small coordination facts rather than logs or repository artifacts.

Use `ticket attachment-upload` for operator-supplied file inputs. It is revision-fenced and active agents are told to refresh their generated attachment manifest. Use `attachment-download` and `artifact-download` to materialize existing content locally; they refuse to overwrite a destination unless `--force` is explicit. Attachments are ticket inputs, while recorded artifacts are immutable run evidence or outputs. Agent attempts may contain multiple `execution_trace` JSONL chunks sharing `metadata.trace_id`; sort them by `metadata.first_sequence` before diagnosing Herdr command delivery or supervisor recovery decisions.

Use `intake show` to inspect configured campaigns, reusable source IDs, capacity limits, source-run history, and admission decisions. Use `ticket emit-candidates` only when the user or ticket explicitly calls for follow-on work. Candidate `external_key` values must be stable across repeated observations. The tracker—not the calling agent—deduplicates, defers for capacity, allocates ticket IDs, pins workflows, and records parent-ticket provenance. A candidate submission is not direct ticket creation and may legitimately return `deferred`, `duplicate`, or `rejected`.

## Ticket creation

Copy `assets/ticket-template.md` to a temporary file, fill in the operator-authored fields, then create the ticket:

```bash
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id --workflow-id standard-delivery
```

Use `--auto-id` for a tracker-allocated local ID. Omit it to preserve the ID in the Markdown, including a Jira key or deliberate custom ID. Run `workflow releases` before selecting a workflow. Omit `--workflow-revision` to use that workflow family's default release; provide an exact active trial revision only when the user deliberately chooses that trial. Then inspect the selected immutable definition with `workflow show <id> --revision <revision>`. Supply declared ticket inputs with `--workflow-inputs-json` and configurable-stage choices with `--stage-enabled-json`. Keep exactly one primary repository. Do not put provider, model, reasoning, specification, or review routing fields in ticket Markdown. Agent profiles and stage behavior belong to the pinned workflow; inspect the exact release and `config show` when the user needs to understand that routing.

## Command discovery

Run `python3 scripts/tracker.py --help` and nested `--help` commands for syntax. Read `references/commands.md` when selecting among ticket transitions, workflow choices, Jira, or GitHub operations.

Prefer `--message-file` and `--answer-file` for multiline text. Pass `-` as a file to read standard input.

## Boundaries

- Treat tracker responses and Markdown revisions as authoritative.
- Never create or update prompts, workflows, workflow release defaults, or tracker configuration with this skill. Configuration, workflow, release, and metrics commands are read-only aids.
- Intake definitions are also read-only. The skill may inspect intake and submit candidates to an already configured source, but it cannot create, edit, enable, schedule, or manually run a source or campaign.
- Ticket creation uses a workflow family's default revision unless `--workflow-revision` explicitly selects an active trial. Existing tickets remain pinned to their recorded assignment.
- Treat `frontmatter.workflow_assignment` as the original experiment/release cohort and `frontmatter.workflow` as current execution. An explicit migration may make them differ; never rewrite assignment provenance.
- Never call `/api/work/*`, register/unregister supervisors, send heartbeats, execute Script nodes, or fabricate lease callbacks with this skill.
- Never use the script to merge pull requests or interpret Herdr lifecycle state as task completion.
- Never bypass the allowlisted commands with a generic HTTP client.
- Do not edit live ticket files directly when the tracker API is available.
- Do not expose credentials in arguments, output, or tickets. The current tracker relies on its private-network boundary.
