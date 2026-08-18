#!/usr/bin/env python3
"""Allowlisted REST client for the Agentic Project Tracker operator API."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


PROVIDERS = ("claude", "codex")
REVIEW_PROVIDERS = ("claude", "codex")
PHASES = ("specification", "implementation", "review")
DEFAULT_URL = os.environ.get("AGENTIC_PROJECT_TRACKER_URL", "http://127.0.0.1:4310")


class ClientFailure(Exception):
    """A local validation, network, or response failure."""


class TrackerHTTPError(Exception):
    def __init__(self, status: int, payload: Any):
        self.status = status
        self.payload = payload
        super().__init__(f"Tracker returned HTTP {status}")


class TrackerClient:
    def __init__(self, base_url: str, timeout: float):
        if not base_url.startswith(("http://", "https://")):
            raise ClientFailure("Tracker URL must start with http:// or https://")
        if timeout <= 0:
            raise ClientFailure("Timeout must be positive")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(self, method: str, path: str, payload: Any | None = None) -> tuple[int, Any]:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                status = response.status
                body = response.read()
                content_type = response.headers.get_content_type()
        except HTTPError as error:
            body = error.read()
            raise TrackerHTTPError(error.code, decode_body(body)) from error
        except URLError as error:
            raise ClientFailure(f"Unable to reach tracker: {error.reason}") from error
        except TimeoutError as error:
            raise ClientFailure("Tracker request timed out") from error
        if content_type.startswith("text/"):
            return status, body.decode("utf-8", errors="replace")
        return status, decode_body(body)


def decode_body(body: bytes) -> Any:
    if not body:
        return None
    text = body.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


def encoded(value: str) -> str:
    return quote(value, safe="")


def read_text(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as error:
        raise ClientFailure(f"Unable to read {path}: {error}") from error


def read_json(path: str) -> Any:
    try:
        return json.loads(read_text(path))
    except json.JSONDecodeError as error:
        raise ClientFailure(f"Invalid JSON in {path}: {error}") from error


def read_mapping(path: str, label: str, value_types: tuple[type, ...]) -> dict[str, Any]:
    loaded = read_json(path)
    if not isinstance(loaded, dict):
        raise ClientFailure(f"{label} JSON must be an object")
    if any(not isinstance(key, str) or not isinstance(value, value_types) for key, value in loaded.items()):
        expected = " or ".join(value_type.__name__ for value_type in value_types)
        raise ClientFailure(f"{label} JSON values must be {expected}")
    return loaded


def selected_text(args: argparse.Namespace, name: str) -> str:
    direct = getattr(args, name, None)
    file_path = getattr(args, f"{name}_file", None)
    value = read_text(file_path) if file_path is not None else direct
    if not isinstance(value, str) or not value.strip():
        raise ClientFailure(f"{name.replace('_', ' ')} must not be empty")
    return value if name == "content" else value.strip()


def add_text_input(parser: argparse.ArgumentParser, name: str, help_text: str) -> None:
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(f"--{name.replace('_', '-')}", dest=name, help=help_text)
    group.add_argument(
        f"--{name.replace('_', '-')}-file",
        dest=f"{name}_file",
        metavar="PATH",
        help=f"Read {name.replace('_', ' ')} from PATH, or - for stdin.",
    )


def get(client: TrackerClient, path: str) -> tuple[int, Any]:
    return client.request("GET", path)


def post(client: TrackerClient, path: str, payload: dict[str, Any]) -> tuple[int, Any]:
    return client.request("POST", path, payload)


def put(client: TrackerClient, path: str, payload: dict[str, Any]) -> tuple[int, Any]:
    return client.request("PUT", path, payload)


def cmd_health(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/health")


def cmd_runtime(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/runtime")


def cmd_supervisor_list(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/supervisors")


def cmd_config_show(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/config")


def cmd_workflow_list(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/workflows")


def cmd_workflow_show(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, f"/api/workflows/{encoded(args.id)}")


def cmd_ticket_list(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    query = "?" + urlencode({"include_archived": "true"}) if args.include_archived else ""
    status, payload = get(client, f"/api/tickets{query}")
    tickets = payload.get("tickets") if isinstance(payload, dict) else None
    if not isinstance(tickets, list):
        raise ClientFailure("Tracker returned an invalid ticket list")
    filters = {
        "phase": args.phase,
        "status": args.status,
        "work_provider": args.work_provider,
        "review_provider": args.review_provider,
        "workflow_id": args.workflow_id,
        "workflow_node_name": args.workflow_node,
        "workflow_stage_name": args.workflow_stage,
        "provider": args.provider,
    }
    for field, value in filters.items():
        if value is not None:
            tickets = [ticket for ticket in tickets if isinstance(ticket, dict) and ticket.get(field) == value]
    if args.invalid_only:
        tickets = [ticket for ticket in tickets if isinstance(ticket, dict) and ticket.get("valid") is False]
    return status, {"tickets": tickets}


def cmd_ticket_show(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, f"/api/tickets/{encoded(args.id)}")


def cmd_ticket_run_output(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    status, output = get(client, f"/api/tickets/{encoded(args.id)}/runs/{encoded(args.run_id)}/output")
    if not isinstance(output, str):
        raise ClientFailure("Tracker returned invalid node-run output")
    return status, {"ticket_id": args.id, "run_id": args.run_id, "output": output}


def cmd_ticket_next_id(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/tickets/next-id")


def cmd_ticket_create(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    payload: dict[str, Any] = {
        "markdown": read_text(args.markdown_file),
        "auto_id": args.auto_id,
    }
    if args.filename:
        payload["filename"] = args.filename
    if args.workflow_id:
        payload["workflow_id"] = args.workflow_id
    if args.workflow_inputs_json:
        payload["workflow_inputs"] = read_mapping(args.workflow_inputs_json, "Workflow inputs", (bool, str))
    if args.stage_enabled_json:
        payload["stage_enabled"] = read_mapping(args.stage_enabled_json, "Stage selection", (bool,))
    return post(client, "/api/tickets", payload)


def cmd_ticket_edit(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    if args.mode == "rewind" and args.rewind_phase is None:
        raise ClientFailure("--rewind-phase is required with --mode rewind")
    if args.mode == "keep_phase" and args.rewind_phase is not None:
        raise ClientFailure("--rewind-phase may only be used with --mode rewind")
    payload: dict[str, Any] = {
        "markdown": read_text(args.markdown_file),
        "expected_revision": args.revision,
        "mode": args.mode,
    }
    if args.rewind_phase:
        payload["rewind_phase"] = args.rewind_phase
    return put(client, f"/api/tickets/{encoded(args.id)}", payload)


def cmd_ticket_simple_action(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/{args.api_action}", {
        "expected_revision": args.revision,
    })


def cmd_ticket_message_action(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/{args.api_action}", {
        "expected_revision": args.revision,
        "message": selected_text(args, "message"),
    })


def cmd_ticket_phase_action(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/{args.api_action}", {
        "expected_revision": args.revision,
        "phase": args.phase,
    })


def cmd_ticket_answer(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/questions/{encoded(args.question_id)}/answer", {
        "expected_revision": args.revision,
        "answer": selected_text(args, "answer"),
    })


def cmd_ticket_check_prs(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/check-pull-requests", {})


def cmd_ticket_decide(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/decide", {
        "expected_revision": args.revision, "decision": args.decision,
        **({"message": args.message} if args.message else {}),
    })


def cmd_ticket_migrate_workflow(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/workflow/migrate", {
        "expected_revision": args.revision, "workflow_id": args.workflow_id, "node_id": args.node_id,
    })


def cmd_jira_import(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, "/api/jira/import", {"key": args.key})


Handler = Callable[[TrackerClient, argparse.Namespace], tuple[int, Any]]


def set_handler(parser: argparse.ArgumentParser, handler: Handler, **values: Any) -> None:
    parser.set_defaults(handler=handler, **values)


def add_revision(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--revision", type=int, required=True, help="Revision observed in the preceding read.")


def add_ticket_id(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("id", help="Ticket ID.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL, help="Tracker origin (default: AGENTIC_PROJECT_TRACKER_URL or localhost).")
    parser.add_argument("--timeout", type=float, default=10.0, help="HTTP timeout in seconds (default: 10).")
    parser.add_argument("--compact", action="store_true", help="Emit compact JSON instead of indented JSON.")
    resources = parser.add_subparsers(dest="resource", required=True)

    set_handler(resources.add_parser("health", help="Show tracker process health."), cmd_health)
    set_handler(resources.add_parser("runtime", help="Show active ticket/Herdr observations."), cmd_runtime)

    supervisor = resources.add_parser("supervisor", help="Inspect reporting supervisors.")
    supervisor_commands = supervisor.add_subparsers(dest="supervisor_command", required=True)
    set_handler(supervisor_commands.add_parser("list", help="List supervisor health and reservations."), cmd_supervisor_list)

    config = resources.add_parser("config", help="Inspect tracker configuration for ticket authoring.")
    config_commands = config.add_subparsers(dest="config_command", required=True)
    set_handler(config_commands.add_parser("show", help="Show tracker configuration."), cmd_config_show)

    workflow = resources.add_parser("workflow", help="Inspect workflow artifacts for ticket selection and controls.")
    workflow_commands = workflow.add_subparsers(dest="workflow_command", required=True)
    set_handler(workflow_commands.add_parser("list", help="List workflow artifacts."), cmd_workflow_list)
    workflow_show = workflow_commands.add_parser("show", help="Show a workflow artifact.")
    workflow_show.add_argument("id")
    set_handler(workflow_show, cmd_workflow_show)

    jira = resources.add_parser("jira", help="Import a Jira issue as a tracker ticket draft.")
    jira_commands = jira.add_subparsers(dest="jira_command", required=True)
    jira_import = jira_commands.add_parser("import", help="Fetch a Jira issue and return an unsaved draft.")
    jira_import.add_argument("key", help="Jira issue key.")
    set_handler(jira_import, cmd_jira_import)

    ticket = resources.add_parser("ticket", help="Inspect and operate tickets.")
    ticket_commands = ticket.add_subparsers(dest="ticket_command", required=True)

    ticket_list = ticket_commands.add_parser("list", help="List and locally filter ticket summaries.")
    ticket_list.add_argument("--include-archived", action="store_true")
    ticket_list.add_argument("--phase", choices=("specification", "implementation", "review", "done"))
    ticket_list.add_argument("--status", choices=("pending", "ready", "running", "blocked", "waiting_approval", "completed", "failed", "cancelled"))
    ticket_list.add_argument("--work-provider", choices=PROVIDERS)
    ticket_list.add_argument("--review-provider", choices=REVIEW_PROVIDERS)
    ticket_list.add_argument("--workflow-id", help="Filter by pinned workflow artifact ID.")
    ticket_list.add_argument("--workflow-node", help="Filter by displayed current-node name.")
    ticket_list.add_argument("--workflow-stage", help="Filter by displayed current-stage name.")
    ticket_list.add_argument("--provider", choices=PROVIDERS, help="Filter by the current node's resolved provider.")
    ticket_list.add_argument("--invalid-only", action="store_true")
    set_handler(ticket_list, cmd_ticket_list)

    ticket_show = ticket_commands.add_parser("show", help="Show authoritative Markdown and structured ticket state.")
    add_ticket_id(ticket_show)
    set_handler(ticket_show, cmd_ticket_show)
    ticket_run_output = ticket_commands.add_parser("run-output", help="Read externally stored output for a recorded node run.")
    add_ticket_id(ticket_run_output)
    ticket_run_output.add_argument("run_id", help="Node run ID returned by ticket show.")
    set_handler(ticket_run_output, cmd_ticket_run_output)
    set_handler(ticket_commands.add_parser("next-id", help="Preview the next tracker-local ID."), cmd_ticket_next_id)

    ticket_create = ticket_commands.add_parser("create", help="Create a ticket from Markdown.")
    ticket_create.add_argument("--markdown-file", required=True, help="Ticket Markdown path, or - for stdin.")
    ticket_create.add_argument("--auto-id", action="store_true", help="Replace the Markdown ID with an atomically allocated tracker ID.")
    ticket_create.add_argument("--filename", help="Optional storage filename hint.")
    ticket_create.add_argument("--workflow-id", help="Optional workflow artifact to pin; otherwise the tracker uses standard-delivery.")
    ticket_create.add_argument("--workflow-inputs-json", metavar="PATH", help="JSON object of declared workflow input values; use - for stdin.")
    ticket_create.add_argument("--stage-enabled-json", metavar="PATH", help="JSON object mapping configurable stage IDs to booleans; use - for stdin.")
    set_handler(ticket_create, cmd_ticket_create)

    ticket_edit = ticket_commands.add_parser("edit", help="Replace authoritative ticket Markdown.")
    add_ticket_id(ticket_edit)
    ticket_edit.add_argument("--markdown-file", required=True, help="Complete ticket Markdown path, or - for stdin.")
    add_revision(ticket_edit)
    ticket_edit.add_argument("--mode", choices=("keep_phase", "rewind"), default="keep_phase")
    ticket_edit.add_argument("--rewind-phase", choices=PHASES)
    set_handler(ticket_edit, cmd_ticket_edit)

    ticket_decide = ticket_commands.add_parser("decide", help="Choose an outcome at the current human gate.")
    add_ticket_id(ticket_decide); add_revision(ticket_decide)
    ticket_decide.add_argument("decision")
    ticket_decide.add_argument("--message")
    set_handler(ticket_decide, cmd_ticket_decide)

    ticket_migrate = ticket_commands.add_parser("migrate-workflow", help="Explicitly move a paused or interrupted ticket to a workflow revision/node.")
    add_ticket_id(ticket_migrate); add_revision(ticket_migrate)
    ticket_migrate.add_argument("workflow_id"); ticket_migrate.add_argument("node_id")
    set_handler(ticket_migrate, cmd_ticket_migrate_workflow)

    for command, api_action, help_text in (
        ("ready", "ready", "Mark a pending valid ticket ready."),
        ("retry", "retry", "Return failed or needs-attention work to ready."),
        ("release-supervisor", "release-supervisor", "Release inactive supervisor affinity."),
        ("archive", "archive", "Archive a completed ticket."),
        ("unarchive", "unarchive", "Return an archived ticket to the completed queue."),
        ("jira-export", "jira/export", "Create a Jira issue for a local ticket."),
        ("jira-resync", "jira/resync", "Refresh a pending Jira-backed ticket."),
    ):
        action = ticket_commands.add_parser(command, help=help_text)
        add_ticket_id(action)
        add_revision(action)
        set_handler(action, cmd_ticket_simple_action, api_action=api_action)

    for command, api_action, help_text in (
        ("comment", "comment", "Append durable operator context."),
        ("guidance", "guidance", "Persist and deliver guidance to active work."),
        ("cancel", "cancel", "Cancel a ticket with a reason."),
        ("fail", "fail", "Fail a ticket with a reason."),
    ):
        action = ticket_commands.add_parser(command, help=help_text)
        add_ticket_id(action)
        add_revision(action)
        add_text_input(action, "message", "Operator message or reason.")
        set_handler(action, cmd_ticket_message_action, api_action=api_action)

    for command in ("rewind", "reopen"):
        action = ticket_commands.add_parser(command, help=f"{command.title()} a ticket to an applicable phase.")
        add_ticket_id(action)
        add_revision(action)
        action.add_argument("--phase", choices=PHASES, required=True)
        set_handler(action, cmd_ticket_phase_action, api_action=command)

    answer = ticket_commands.add_parser("answer-question", help="Answer a durable agent question.")
    add_ticket_id(answer)
    answer.add_argument("question_id", help="Question ID returned by ticket show.")
    add_revision(answer)
    add_text_input(answer, "answer", "Answer text.")
    set_handler(answer, cmd_ticket_answer)

    check_prs = ticket_commands.add_parser("check-pull-requests", help="Observe recorded PRs and reopen actionable follow-up when found.")
    add_ticket_id(check_prs)
    set_handler(check_prs, cmd_ticket_check_prs)
    return parser


def emit(payload: Any, compact: bool, stream: Any = sys.stdout) -> None:
    json.dump(payload, stream, indent=None if compact else 2, sort_keys=True)
    stream.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        client = TrackerClient(args.url, args.timeout)
        status, data = args.handler(client, args)
        emit({"ok": True, "status": status, "data": data}, args.compact)
        return 0
    except TrackerHTTPError as error:
        payload = error.payload if isinstance(error.payload, dict) else {"details": error.payload}
        emit({"ok": False, "status": error.status, **payload}, args.compact, sys.stderr)
        return 3
    except (ClientFailure, OSError, ValueError) as error:
        emit({"ok": False, "error": str(error)}, args.compact, sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
