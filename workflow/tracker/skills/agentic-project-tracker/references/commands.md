# Command reference

All examples assume the current directory is the skill directory and `AGENTIC_PROJECT_TRACKER_URL` is set. Global `--url`, `--timeout`, and `--compact` options must appear before the resource command.

Every response is JSON shaped as `{ "ok": true, "status": 200, "data": ... }`. HTTP failures are JSON on stderr and exit `3`; local input/network failures exit `4`; argument errors exit `2`.

## Inspection

```bash
python3 scripts/tracker.py health
python3 scripts/tracker.py runtime
python3 scripts/tracker.py supervisor list
python3 scripts/tracker.py config show
python3 scripts/tracker.py prompt list
python3 scripts/tracker.py prompt show implementation
python3 scripts/tracker.py ticket next-id
python3 scripts/tracker.py ticket list --status ready
python3 scripts/tracker.py ticket list --include-archived --phase done
python3 scripts/tracker.py ticket show AGENT-0001
```

`runtime` reports active leases and Herdr observations. `supervisor list` reports online/offline presence, project roots, providers, and ticket reservations. Neither lifecycle observation proves phase completion.

## Ticket authoring

```bash
cp assets/ticket-template.md /tmp/ticket.md
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md --auto-id
python3 scripts/tracker.py ticket create --markdown-file /tmp/ticket.md
python3 scripts/tracker.py ticket edit AGENT-0001 --revision 4 --markdown-file /tmp/ticket.md
python3 scripts/tracker.py ticket edit AGENT-0001 --revision 4 --markdown-file /tmp/ticket.md --mode rewind --rewind-phase specification
```

`ticket edit` requires the complete current Markdown, including tracker-maintained frontmatter and interaction-log markers. Begin from `ticket show`, change only operator-authored fields/body, and preserve the rest. A live rewind records an interrupt request; it does not immediately make replacement work claimable.

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
python3 scripts/tracker.py ticket approve-specification AGENT-0001 --revision 8
python3 scripts/tracker.py ticket request-specification-changes AGENT-0001 --revision 8 --message "Cover rollback."
python3 scripts/tracker.py ticket retry AGENT-0001 --revision 10
python3 scripts/tracker.py ticket rewind AGENT-0001 --revision 10 --phase implementation
python3 scripts/tracker.py ticket reopen AGENT-0001 --revision 14 --phase implementation
python3 scripts/tracker.py ticket release-supervisor AGENT-0001 --revision 11
python3 scripts/tracker.py ticket fail AGENT-0001 --revision 11 --message "Operator stopped the work."
python3 scripts/tracker.py ticket cancel AGENT-0001 --revision 11 --message "No longer required."
python3 scripts/tracker.py ticket archive AGENT-0001 --revision 15
python3 scripts/tracker.py ticket unarchive AGENT-0001 --revision 16
```

Always inspect the ticket immediately before these commands. Do not guess a revision or silently repeat a conflicted transition.

## Prompt library

```bash
python3 scripts/tracker.py prompt preview implementation --phase implementation --content-file /tmp/implementation.md
python3 scripts/tracker.py prompt update implementation --revision PROMPT_DIGEST --content-file /tmp/implementation.md
```

Use `prompt show` to obtain the current content and digest. Preview before updating. Prompt tags and required tags are validated by the tracker.

## Configuration

```bash
python3 scripts/tracker.py config show > /tmp/config-response.json
python3 scripts/tracker.py config update --revision 3 --json-file /tmp/config-response.json
```

The update file may be the complete client response, a `{ "config": ... }` data object, or a JSON object containing `repositories` plus optional `providers`, `jira`, and `github`. The CLI never updates ticket numbering fields. Credentials remain environment variables on the tracker host.

## Jira and GitHub observation

```bash
python3 scripts/tracker.py jira import ENG-42
python3 scripts/tracker.py ticket jira-export AGENT-0001 --revision 4
python3 scripts/tracker.py ticket jira-resync ENG-42 --revision 2
python3 scripts/tracker.py ticket check-pull-requests AGENT-0001
```

Jira import returns an unsaved draft; create it only after supplying tracker-only repositories and workflow choices. Jira export and resync mutate the ticket. A PR check may return completed or specification-approval work to a ready phase when new actionable feedback or a merge conflict is found.
