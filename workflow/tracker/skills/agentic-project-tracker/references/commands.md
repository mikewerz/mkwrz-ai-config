# Command reference

All examples assume the current directory is the skill directory and `AGENTIC_PROJECT_TRACKER_URL` is set. Global `--url`, `--timeout`, and `--compact` options must appear before the resource command.

Every response is JSON shaped as `{ "ok": true, "status": 200, "data": ... }`. HTTP failures are JSON on stderr and exit `3`; local input/network failures exit `4`; argument errors exit `2`.

## Inspection

```bash
python3 scripts/tracker.py health
python3 scripts/tracker.py runtime
python3 scripts/tracker.py supervisor list
python3 scripts/tracker.py config show
python3 scripts/tracker.py workflow list
python3 scripts/tracker.py workflow show standard-delivery
python3 scripts/tracker.py ticket next-id
python3 scripts/tracker.py ticket list --status ready
python3 scripts/tracker.py ticket list --include-archived --phase done
python3 scripts/tracker.py ticket list --workflow-id end-to-end --workflow-stage "Non-production validation"
python3 scripts/tracker.py ticket list --workflow-node "Deploy and validate non-production" --provider claude
python3 scripts/tracker.py ticket show AGENT-0001
python3 scripts/tracker.py ticket run-output AGENT-0001 node-run-uuid
```

`runtime` reports active leases and Herdr observations. `supervisor list` reports online/offline presence, project roots, providers, detected Script activity capabilities, and ticket reservations. Neither lifecycle observation proves phase completion.

The V3 list filters match the pinned workflow ID, displayed current-node name, displayed stage name, and resolved provider. Legacy phase/provider filters remain available as projections. `ticket run-output` reads the full externally stored output for a recorded node run; it never executes or retries a Script node.

## Ticket authoring

```bash
cp assets/ticket-template.md /tmp/ticket.md
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id --workflow-id standard-delivery
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id --workflow-id end-to-end --workflow-inputs-json /tmp/inputs.json --stage-enabled-json /tmp/stages.json
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md
python3 scripts/tracker.py ticket edit AGENT-0001 --revision 4 --markdown-file /tmp/ticket.md
python3 scripts/tracker.py ticket edit AGENT-0001 --revision 4 --markdown-file /tmp/ticket.md --mode rewind --rewind-phase specification
```

Workflow input JSON maps declared input IDs to Boolean or string values. Stage-selection JSON maps configurable stage IDs to Booleans. Inspect the selected workflow first and omit both files when its defaults are correct.

`ticket edit` requires the complete current Markdown, including tracker-maintained workflow state and interaction-log markers. Begin from `ticket show`, change only operator-authored fields/body, and preserve the rest. `--mode keep_phase` guides a running agent to reread a changed ticket. A live rewind records an interrupt request; it does not immediately make replacement work claimable.

## Comments, guidance, and questions

```bash
python3 scripts/tracker.py ticket comment AGENT-0001 --revision 4 --message "Durable context"
python3 scripts/tracker.py ticket guidance AGENT-0001 --revision 5 --message-file /tmp/guidance.md
python3 scripts/tracker.py ticket answer-question AGENT-0001 question-uuid --revision 6 --answer "Use PostgreSQL 18."
```

Comments do not steer active work. Guidance is queued for the running conversation. Answering an agent question also queues the answer as guidance and may return question-blocked execution to running.

## Workflow controls

```bash
python3 scripts/tracker.py ticket ready AGENT-0001 --revision 2
python3 scripts/tracker.py ticket decide AGENT-0001 approved --revision 8
python3 scripts/tracker.py ticket migrate-workflow AGENT-0001 standard-delivery implementation --revision 10
python3 scripts/tracker.py ticket retry AGENT-0001 --revision 10
python3 scripts/tracker.py ticket rewind AGENT-0001 --revision 10 --phase implementation
python3 scripts/tracker.py ticket reopen AGENT-0001 --revision 14 --phase implementation
python3 scripts/tracker.py ticket release-supervisor AGENT-0001 --revision 11
python3 scripts/tracker.py ticket fail AGENT-0001 --revision 11 --message "Operator stopped the work."
python3 scripts/tracker.py ticket cancel AGENT-0001 --revision 11 --message "No longer required."
python3 scripts/tracker.py ticket archive AGENT-0001 --revision 15
python3 scripts/tracker.py ticket unarchive AGENT-0001 --revision 16
```

Always inspect the ticket immediately before these commands. For `ticket decide`, use only a choice ID exposed by the current `workflow_node.choices`; include `--message` when that choice requires a comment. Do not guess a revision or silently repeat a conflicted transition.

For a running assignment, successful `fail` or `cancel` means the tracker requested terminal interruption; it does not mean the agent has already stopped. Reread the ticket until the supervisor acknowledges the request and the terminal state is recorded. An unacknowledged interruption may time out into blocked work requiring operator attention.

`rewind` and `reopen` use the operational phase projection and select the first applicable agent node. When a custom workflow has multiple agent nodes in one phase, use `migrate-workflow` with an explicit workflow and node only when the user requests that exact redirect. Migration changes the ticket's pinned execution and may move it to the latest published revision; it does not edit the workflow artifact.

## Workflow selection

```bash
python3 scripts/tracker.py workflow list
python3 scripts/tracker.py workflow show dev-only
```

Workflow access is read-only. Inspect a definition to discover its inputs, configurable stages, nodes, and human-gate choice IDs before creating or redirecting a ticket. The skill cannot publish workflow or prompt artifacts.

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
