# Command reference

All examples assume the current directory is the skill directory and `AGENTIC_PROJECT_TRACKER_URL` is set. Global `--url`, `--timeout`, and `--compact` options must appear before the resource command.

Every response is JSON shaped as `{ "ok": true, "status": 200, "data": ... }`. HTTP failures are JSON on stderr and exit `3`; local input/network failures exit `4`; argument errors exit `2`.

## Inspection

```bash
python3 scripts/tracker.py health
python3 scripts/tracker.py readiness
python3 scripts/tracker.py operations
python3 scripts/tracker.py runtime
python3 scripts/tracker.py intake show
python3 scripts/tracker.py supervisor list
python3 scripts/tracker.py config show
python3 scripts/tracker.py workflow list
python3 scripts/tracker.py workflow releases
python3 scripts/tracker.py workflow show standard-delivery
python3 scripts/tracker.py workflow show standard-delivery --revision <64-character-revision>
python3 scripts/tracker.py metrics show --workflow-id standard-delivery --workflow-revision <64-character-revision>
python3 scripts/tracker.py metrics compare standard-delivery <baseline-revision> standard-delivery <candidate-revision> --label backend
python3 scripts/tracker.py ticket next-id
python3 scripts/tracker.py ticket list --status ready
python3 scripts/tracker.py ticket list --include-archived --phase done
python3 scripts/tracker.py ticket list --workflow-id end-to-end --workflow-stage "Non-production validation"
python3 scripts/tracker.py ticket list --workflow-node "Deploy and validate non-production" --provider claude
python3 scripts/tracker.py ticket show AGENT-0001
python3 scripts/tracker.py ticket run-output AGENT-0001 node-run-uuid
python3 scripts/tracker.py ticket checkpoint-list AGENT-0001
python3 scripts/tracker.py ticket metadata-list AGENT-0001
python3 scripts/tracker.py ticket metadata-get AGENT-0001 deploy.status
```

`health` proves only that the HTTP process responds. `readiness` fails with HTTP 503 when required ticket-store or library dependencies are unavailable. `operations` returns the same dependency assessment plus warnings and background-operation details even when the process is not ready. `runtime` reports active leases and Herdr observations. `supervisor list` reports online/offline presence, project roots, providers, detected Script activity capabilities, and ticket reservations. Neither lifecycle observation proves phase completion.

The workflow list filters match the pinned workflow ID, displayed current-node name, displayed stage name, and resolved provider. Phase and provider filters match operational projections of the active workflow node. `ticket run-output` reads the full externally stored output for a recorded node run; it never executes or retries a Script node.

`workflow list` and unrevisioned `workflow show` expose editor heads, which may be a published trial rather than the default. Use `workflow releases` to identify each family's default and active trials, then use revisioned `workflow show` whenever exact runtime behavior matters.

`metrics show` reports platform totals and completed-ticket node/branch reliability. `metrics compare` compares two immutable release cohorts. Cost and token summaries include only tickets with complete telemetry coverage; efficiency excludes tickets that crossed into another workflow revision. Treat manually assigned trial comparisons as observational because selection bias may remain.

## Ticket authoring

```bash
cp assets/ticket-template.md /tmp/ticket.md
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id --workflow-id standard-delivery
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id --workflow-id end-to-end --workflow-inputs-json /tmp/inputs.json --stage-enabled-json /tmp/stages.json
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id --workflow-id standard-delivery --workflow-revision <64-character-trial-revision>
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md
python3 scripts/tracker.py workflow releases
python3 scripts/tracker.py workflow show standard-delivery --revision <64-character-revision>
python3 scripts/tracker.py ticket edit AGENT-0001 --revision 4 --markdown-file /tmp/ticket.md
```

Workflow input JSON maps declared input IDs to Boolean or string values. Stage-selection JSON maps configurable stage IDs to Booleans. Inspect the selected workflow first and omit both files when its defaults are correct.

`ticket edit` requires the complete current Markdown, including tracker-maintained workflow state and interaction-log markers. Begin from `ticket show`, change only operator-authored fields/body, and preserve the rest. Editing retains the active workflow node. When an agent is running, the tracker queues guidance telling it to reread the changed ticket.

## Intake and follow-on work

```bash
python3 scripts/tracker.py intake show
python3 scripts/tracker.py ticket emit-candidates AGENT-0001 dependency-follow-up --candidates-json /tmp/candidates.json
```

`intake show` also returns safe preview runs and their bounded validation results. Preview results are observations only: they do not represent admitted candidates or a committed source cursor.

The candidate file is a non-empty JSON array. Every candidate requires `external_key`, `title`, and `description`; it may override repositories, labels, priority, workflow selection, workflow inputs, stage selection, readiness, and non-reserved metadata. Use a source ID exposed by `intake show` and a stable external key such as `dto-release:orders:2.4.0:consumer-b`. Repeating the same source/key updates its observation record instead of creating a second ticket.

Candidate emission is an external write but does not mutate the parent ticket, so it has no ticket revision argument. The tracker records the parent, applies source/campaign daily and in-flight limits atomically, and returns one decision per candidate. Report deferred and rejected decisions rather than assuming every submission became a ticket. This skill cannot edit or run intake definitions.

## Attachments, artifacts, and checkpoints

```bash
python3 scripts/tracker.py ticket attachment-upload AGENT-0001 --revision 4 --file /tmp/screenshot.png
python3 scripts/tracker.py ticket attachment-upload AGENT-0001 --revision 5 --file /tmp/evidence.bin --filename evidence.bin --content-type application/octet-stream
python3 scripts/tracker.py ticket attachment-download AGENT-0001 attachment-uuid --output /tmp/screenshot.png
python3 scripts/tracker.py ticket attachment-remove AGENT-0001 attachment-uuid --revision 6
python3 scripts/tracker.py ticket artifact-download AGENT-0001 artifact-uuid --output /tmp/execution-manifest.json
python3 scripts/tracker.py ticket checkpoint-list AGENT-0001
```

Upload and removal mutate the ticket and therefore require the current revision. An attachment added during active work causes the supervisor to refresh the assignment bundle and guide the agent to reread `attachments.md`. Downloads are read-only but refuse to overwrite an existing local path unless `--force` is supplied. Attachment and artifact IDs come from `ticket show`; checkpoint metadata may be read directly with `checkpoint-list`.

## Comments, guidance, and questions

```bash
python3 scripts/tracker.py ticket comment AGENT-0001 --revision 4 --message "Durable context"
python3 scripts/tracker.py ticket guidance AGENT-0001 --revision 5 --message-file /tmp/guidance.md
python3 scripts/tracker.py ticket answer-question AGENT-0001 question-uuid --revision 6 --answer "Use PostgreSQL 18."
```

Comments do not steer active work. Guidance is queued for the running conversation. Answering an agent question also queues the answer as guidance and may return question-blocked execution to running.

## Workflow metadata

```bash
python3 scripts/tracker.py ticket metadata-list AGENT-0001
python3 scripts/tracker.py ticket metadata-get AGENT-0001 deploy.status
python3 scripts/tracker.py ticket metadata-set AGENT-0001 deploy.status --revision 7 --value-json '"ready"'
python3 scripts/tracker.py ticket metadata-set AGENT-0001 deploy.result --revision 8 --value-json-file /tmp/result.json
python3 scripts/tracker.py ticket metadata-delete AGENT-0001 deploy.result --revision 9
```

Metadata keys are literal names and values may be any JSON value accepted by the tracker. Read the ticket immediately before setting or deleting a value, then use the returned revision. Metadata is appropriate for small workflow decisions and counters; use Script output artifacts or repositories for logs and large domain artifacts.

## Workflow controls

```bash
python3 scripts/tracker.py ticket ready AGENT-0001 --revision 2
python3 scripts/tracker.py ticket draft AGENT-0001 --revision 3
python3 scripts/tracker.py ticket priority AGENT-0001 2 --revision 4
python3 scripts/tracker.py ticket human-estimate AGENT-0001 --days 3.5 --revision 5
python3 scripts/tracker.py ticket human-estimate AGENT-0001 --clear --revision 6
python3 scripts/tracker.py ticket decide AGENT-0001 approved --revision 8
python3 scripts/tracker.py ticket migrate-workflow AGENT-0001 standard-delivery implementation --revision 10
python3 scripts/tracker.py ticket migrate-workflow AGENT-0001 standard-delivery implementation --revision 11 --workflow-revision <64-character-trial-revision>
python3 scripts/tracker.py ticket checkpoint AGENT-0001 save-before-deploy --revision 10
python3 scripts/tracker.py ticket restore-checkpoint AGENT-0001 restore-work checkpoint-uuid --revision 11
python3 scripts/tracker.py ticket wake AGENT-0001 --revision 12
python3 scripts/tracker.py ticket reset-conversation AGENT-0001 work --revision 13
python3 scripts/tracker.py ticket retry AGENT-0001 --revision 10
python3 scripts/tracker.py ticket release-supervisor AGENT-0001 --revision 11
python3 scripts/tracker.py ticket fail AGENT-0001 --revision 11 --message "Operator stopped the work."
python3 scripts/tracker.py ticket cancel AGENT-0001 --revision 11 --message "No longer required."
python3 scripts/tracker.py ticket archive AGENT-0001 --revision 15 --production-result succeeded --production-note "Healthy after rollout."
python3 scripts/tracker.py ticket production-assessment AGENT-0001 --revision 16 --production-result rolled_back --production-note "A delayed alert required rollback."
python3 scripts/tracker.py ticket unarchive AGENT-0001 --revision 17
```

Always inspect the ticket immediately before these commands. For `ticket decide`, use only a choice ID exposed by the current `workflow_node.choices`; include `--message` when that choice requires a comment. Do not guess a revision or silently repeat a conflicted transition.

Priority changes do not interrupt active work. `draft` is valid only for ready work that has not been claimed and does not add a workflow visit. Human estimates are optional metric inputs and may be changed independently of workflow execution. `wake` releases only the current durable external wait; it does not skip the Wait node's declared route. `reset-conversation` requires an existing inactive conversation key and starts a new generation without changing the current node.

Production assessment is independent of workflow completion. A completed ticket may be marked `succeeded`, `failed`, `rolled_back`, `not_deployed`, or returned to `unassessed`; the designation and note remain editable after archival. Archive may record the assessment atomically, or it may omit `--production-result` when the outcome is not known yet.

For a running assignment, successful `fail` or `cancel` means the tracker requested terminal interruption; it does not mean the agent has already stopped. Reread the ticket until the supervisor acknowledges the request and the terminal state is recorded. An unacknowledged interruption may time out into blocked work requiring operator attention.

Use `migrate-workflow` when the user explicitly asks to redirect, restart, or reopen execution at a specific node. Omitting `--workflow-revision` uses the workflow family's current default release. Supplying a revision deliberately selects that active trial. Migration changes current execution but retains the ticket's original `workflow_assignment` as cohort provenance; it does not edit the workflow artifact. This explicit operation avoids guessing which node a phase label represents in a custom workflow.

Use `checkpoint` and `restore-checkpoint` only with node IDs exposed by the ticket's pinned workflow and checkpoint IDs exposed by `ticket show`. These commands route the ticket through deterministic workflow nodes; they do not snapshot or mutate repositories directly. Active work is first interrupted and fenced, so reread the ticket until the supervisor acknowledges the request and claims the selected node.

## Workflow selection

```bash
python3 scripts/tracker.py workflow list
python3 scripts/tracker.py workflow releases
python3 scripts/tracker.py workflow show dev-only --revision <revision-from-releases>
```

Workflow access is read-only. The release catalog is authoritative for default/trial status; the top-level workflow document is only the current editor head. Inspect the exact immutable definition to discover its inputs, configurable stages, nodes, and human-gate choice IDs before creating or redirecting a ticket. The skill cannot publish workflows, promote defaults, or modify prompt artifacts.

## Metrics

```bash
python3 scripts/tracker.py metrics show --from 2026-01-01 --label backend --repository application-api
python3 scripts/tracker.py metrics compare standard-delivery <baseline-revision> standard-delivery <candidate-revision> --label backend --label-mode all
```

Use repeated `--label` and `--repository` options for shared cohort filters. Comparison always requires exact workflow IDs and revisions. Use metrics for evidence and reporting only; do not promote a trial or mutate a ticket based on a metric without the user's explicit request.

## Configuration inspection

```bash
python3 scripts/tracker.py config show > /tmp/config-response.json
```

Configuration access is read-only. Use it to discover saved repositories, enabled providers, and whether Jira or GitHub observation is available. The skill cannot change configuration or ticket numbering.

## Jira and GitHub observation

```bash
python3 scripts/tracker.py jira import ENG-42
python3 scripts/tracker.py ticket jira-export AGENT-0001 --revision 4
python3 scripts/tracker.py ticket jira-resync ENG-42 --revision 2
python3 scripts/tracker.py ticket check-pull-requests AGENT-0001
```

Jira import returns an unsaved draft; create it only after supplying tracker-only repositories and workflow choices. Viewing or marking a pending Jira-backed ticket ready may resync it. Jira export and resync mutate the ticket. A PR check may follow the current human gate's configured feedback choice or a completed terminal node's explicit feedback target when new actionable feedback or a merge conflict is found. Always read the ticket again after a PR check.
