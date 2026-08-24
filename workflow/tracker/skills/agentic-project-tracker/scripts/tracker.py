#!/usr/bin/env python3
"""Allowlisted REST client for the Agentic Project Tracker operator API."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


PROVIDERS = ("claude", "codex")
PHASES = ("specification", "implementation", "review")
PRODUCTION_RESULTS = ("unassessed", "succeeded", "failed", "rolled_back", "not_deployed")
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
        status, body, content_type = self.request_raw(
            method, path, data, {"Accept": "application/json", "Content-Type": "application/json"},
        )
        if content_type.startswith("text/"):
            return status, body.decode("utf-8", errors="replace")
        return status, decode_body(body)

    def request_raw(
        self, method: str, path: str, data: bytes | None = None, headers: dict[str, str] | None = None,
    ) -> tuple[int, bytes, str]:
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers=headers or {},
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
        return status, body, content_type


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


def read_bytes(path: str) -> bytes:
    try:
        return Path(path).read_bytes()
    except OSError as error:
        raise ClientFailure(f"Unable to read {path}: {error}") from error


def write_download(path: str, content: bytes, force: bool) -> str:
    destination = Path(path).expanduser().resolve()
    if destination.exists() and not force:
        raise ClientFailure(f"Refusing to overwrite {destination}; pass --force to replace it")
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=f".{destination.name}.", dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    except OSError as error:
        if "temporary" in locals():
            temporary.unlink(missing_ok=True)
        raise ClientFailure(f"Unable to write {destination}: {error}") from error
    return str(destination)


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


def optional_text(args: argparse.Namespace, name: str) -> str | None:
    direct = getattr(args, name, None)
    file_path = getattr(args, f"{name}_file", None)
    if direct is None and file_path is None:
        return None
    value = read_text(file_path) if file_path is not None else direct
    if not isinstance(value, str) or not value.strip():
        raise ClientFailure(f"{name.replace('_', ' ')} must not be empty")
    return value.strip()


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


def delete(client: TrackerClient, path: str, payload: dict[str, Any]) -> tuple[int, Any]:
    return client.request("DELETE", path, payload)


def cmd_health(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/health")


def cmd_readiness(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/readyz")


def cmd_operations(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/operations")


def cmd_runtime(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/runtime")


def cmd_intake_show(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/intake")


def cmd_supervisor_list(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/supervisors")


def cmd_config_show(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/config")


def cmd_workflow_list(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/workflows")


def cmd_workflow_show(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    path = f"/api/workflows/{encoded(args.id)}"
    if args.revision:
        path += f"/revisions/{encoded(args.revision)}"
    return get(client, path)


def cmd_workflow_releases(client: TrackerClient, _args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, "/api/workflow-releases")


def metrics_query(args: argparse.Namespace, include_workflow: bool) -> str:
    values: dict[str, str] = {}
    for name in ("from_date", "to_date", "production_result"):
        value = getattr(args, name, None)
        if value:
            values[{"from_date": "from", "to_date": "to"}.get(name, name)] = value
    if args.labels:
        values["labels"] = ",".join(args.labels)
        values["label_mode"] = args.label_mode
    if args.repositories:
        values["repositories"] = ",".join(args.repositories)
    if include_workflow:
        if args.workflow_id:
            values["workflow_id"] = args.workflow_id
        if args.workflow_revision:
            values["workflow_revision"] = args.workflow_revision
    return f"?{urlencode(values)}" if values else ""


def cmd_metrics_show(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, f"/api/metrics{metrics_query(args, True)}")


def cmd_metrics_compare(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    query = metrics_query(args, False)
    values = {
        "left_id": args.baseline_id, "left_revision": args.baseline_revision,
        "right_id": args.candidate_id, "right_revision": args.candidate_revision,
    }
    separator = "&" if query else "?"
    return get(client, f"/api/metrics/compare{query}{separator}{urlencode(values)}")


def cmd_ticket_list(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    query = "?" + urlencode({"include_archived": "true"}) if args.include_archived else ""
    status, payload = get(client, f"/api/tickets{query}")
    tickets = payload.get("tickets") if isinstance(payload, dict) else None
    if not isinstance(tickets, list):
        raise ClientFailure("Tracker returned an invalid ticket list")
    filters = {
        "phase": args.phase,
        "status": args.status,
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


def cmd_ticket_checkpoints(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, f"/api/tickets/{encoded(args.id)}/checkpoints")


def download_ticket_content(client: TrackerClient, args: argparse.Namespace, kind: str) -> tuple[int, Any]:
    resource_id = args.attachment_id if kind == "attachment" else args.artifact_id
    plural = "attachments" if kind == "attachment" else "artifacts"
    status, content, content_type = client.request_raw(
        "GET",
        f"/api/tickets/{encoded(args.id)}/{plural}/{encoded(resource_id)}/content?download=true",
        headers={"Accept": "*/*"},
    )
    output = write_download(args.output, content, args.force)
    return status, {
        "ticket_id": args.id, f"{kind}_id": resource_id, "output": output,
        "size_bytes": len(content), "content_type": content_type,
    }


def cmd_ticket_attachment_upload(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    content = read_bytes(args.file)
    filename = args.filename or Path(args.file).name
    if not filename:
        raise ClientFailure("Attachment filename must not be empty")
    content_type = args.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    query = urlencode({"filename": filename, "expected_revision": args.revision})
    status, body, response_type = client.request_raw(
        "POST", f"/api/tickets/{encoded(args.id)}/attachments?{query}", content,
        {
            "Accept": "application/json", "Content-Type": "application/octet-stream",
            "X-Attachment-Content-Type": content_type,
        },
    )
    if response_type.startswith("text/"):
        return status, body.decode("utf-8", errors="replace")
    return status, decode_body(body)


def cmd_ticket_attachment_download(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return download_ticket_content(client, args, "attachment")


def cmd_ticket_artifact_download(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return download_ticket_content(client, args, "artifact")


def cmd_ticket_attachment_remove(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return delete(client, f"/api/tickets/{encoded(args.id)}/attachments/{encoded(args.attachment_id)}", {
        "expected_revision": args.revision,
    })


def cmd_ticket_metadata_list(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, f"/api/tickets/{encoded(args.id)}/metadata")


def cmd_ticket_metadata_get(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return get(client, f"/api/tickets/{encoded(args.id)}/metadata/{encoded(args.key)}")


def metadata_value(args: argparse.Namespace) -> Any:
    source = read_text(args.value_json_file) if args.value_json_file is not None else args.value_json
    try:
        return json.loads(source)
    except json.JSONDecodeError as error:
        raise ClientFailure(f"Invalid metadata JSON: {error}") from error


def cmd_ticket_metadata_set(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return put(client, f"/api/tickets/{encoded(args.id)}/metadata/{encoded(args.key)}", {
        "expected_revision": args.revision,
        "value": metadata_value(args),
    })


def cmd_ticket_metadata_delete(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return delete(client, f"/api/tickets/{encoded(args.id)}/metadata/{encoded(args.key)}", {
        "expected_revision": args.revision,
    })


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
    if args.workflow_revision:
        payload["workflow_revision"] = args.workflow_revision
    if args.workflow_inputs_json:
        payload["workflow_inputs"] = read_mapping(args.workflow_inputs_json, "Workflow inputs", (bool, str))
    if args.stage_enabled_json:
        payload["stage_enabled"] = read_mapping(args.stage_enabled_json, "Stage selection", (bool,))
    return post(client, "/api/tickets", payload)


def cmd_ticket_emit_candidates(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    candidates = read_json(args.candidates_json)
    if not isinstance(candidates, list) or not candidates:
        raise ClientFailure("Candidate JSON must be a non-empty array")
    if any(not isinstance(candidate, dict) for candidate in candidates):
        raise ClientFailure("Every candidate must be a JSON object")
    return post(client, f"/api/tickets/{encoded(args.id)}/candidates", {
        "source_id": args.source_id,
        "candidates": candidates,
    })


def cmd_ticket_edit(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    payload = {
        "markdown": read_text(args.markdown_file),
        "expected_revision": args.revision,
    }
    return put(client, f"/api/tickets/{encoded(args.id)}", payload)


def cmd_ticket_simple_action(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/{args.api_action}", {
        "expected_revision": args.revision,
    })


def cmd_ticket_priority(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/priority", {
        "expected_revision": args.revision, "priority": args.priority,
    })


def cmd_ticket_human_estimate(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/human-estimate", {
        "expected_revision": args.revision,
        "estimated_human_days": None if args.clear else args.days,
    })


def cmd_ticket_reset_conversation(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/conversations/{encoded(args.key)}/reset", {
        "expected_revision": args.revision,
    })


def production_payload(args: argparse.Namespace) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "expected_revision": args.revision,
        "production_result": args.production_result,
    }
    note = optional_text(args, "production_note")
    if note is not None:
        payload["production_assessment_note"] = note
    return payload


def cmd_ticket_archive(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    payload: dict[str, Any] = {"expected_revision": args.revision}
    if args.production_result is not None:
        payload.update(production_payload(args))
    elif optional_text(args, "production_note") is not None:
        raise ClientFailure("--production-note requires --production-result")
    return post(client, f"/api/tickets/{encoded(args.id)}/archive", payload)


def cmd_ticket_production_assessment(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/production-assessment", production_payload(args))


def cmd_ticket_message_action(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    return post(client, f"/api/tickets/{encoded(args.id)}/{args.api_action}", {
        "expected_revision": args.revision,
        "message": selected_text(args, "message"),
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
    payload = {
        "expected_revision": args.revision, "workflow_id": args.workflow_id, "node_id": args.node_id,
    }
    if args.workflow_revision:
        payload["workflow_revision"] = args.workflow_revision
    return post(client, f"/api/tickets/{encoded(args.id)}/workflow/migrate", payload)


def cmd_ticket_checkpoint(client: TrackerClient, args: argparse.Namespace) -> tuple[int, Any]:
    payload: dict[str, Any] = {
        "expected_revision": args.revision, "action": args.checkpoint_action, "node_id": args.node_id,
    }
    if args.checkpoint_action == "restore":
        payload["checkpoint_id"] = args.checkpoint_id
    return post(client, f"/api/tickets/{encoded(args.id)}/checkpoints/action", payload)


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
    set_handler(resources.add_parser("readiness", help="Check ticket-store, library, and background-operation readiness."), cmd_readiness)
    set_handler(resources.add_parser("operations", help="Show detailed operational readiness and background-task status."), cmd_operations)
    set_handler(resources.add_parser("runtime", help="Show active ticket/Herdr observations."), cmd_runtime)

    intake = resources.add_parser("intake", help="Inspect configured campaigns, sources, source runs, candidates, and capacity metrics.")
    intake_commands = intake.add_subparsers(dest="intake_command", required=True)
    set_handler(intake_commands.add_parser("show", help="Show the intake operations overview."), cmd_intake_show)

    supervisor = resources.add_parser("supervisor", help="Inspect reporting supervisors.")
    supervisor_commands = supervisor.add_subparsers(dest="supervisor_command", required=True)
    set_handler(supervisor_commands.add_parser("list", help="List supervisor health and reservations."), cmd_supervisor_list)

    config = resources.add_parser("config", help="Inspect tracker configuration for ticket authoring.")
    config_commands = config.add_subparsers(dest="config_command", required=True)
    set_handler(config_commands.add_parser("show", help="Show tracker configuration."), cmd_config_show)

    workflow = resources.add_parser("workflow", help="Inspect workflow artifacts for ticket selection and controls.")
    workflow_commands = workflow.add_subparsers(dest="workflow_command", required=True)
    set_handler(workflow_commands.add_parser("list", help="List workflow artifacts."), cmd_workflow_list)
    set_handler(workflow_commands.add_parser("releases", help="List default and trial workflow revisions."), cmd_workflow_releases)
    workflow_show = workflow_commands.add_parser("show", help="Show a workflow artifact.")
    workflow_show.add_argument("id")
    workflow_show.add_argument("--revision", help="Show an exact immutable revision instead of the editor head.")
    set_handler(workflow_show, cmd_workflow_show)

    metrics = resources.add_parser("metrics", help="Inspect factory and workflow-release metrics.")
    metrics_commands = metrics.add_subparsers(dest="metrics_command", required=True)

    def add_metrics_filters(command: argparse.ArgumentParser, include_workflow: bool) -> None:
        command.add_argument("--from", dest="from_date", help="Include tickets created at or after this ISO date or timestamp.")
        command.add_argument("--to", dest="to_date", help="Include tickets created at or before this ISO date or timestamp.")
        command.add_argument("--label", dest="labels", action="append", default=[], help="Filter by a label; repeat for multiple labels.")
        command.add_argument("--label-mode", choices=("any", "all"), default="any")
        command.add_argument("--repository", dest="repositories", action="append", default=[], help="Filter by repository ID; repeat as needed.")
        command.add_argument("--production-result", choices=PRODUCTION_RESULTS)
        if include_workflow:
            command.add_argument("--workflow-id")
            command.add_argument("--workflow-revision")

    metrics_show = metrics_commands.add_parser("show", help="Show platform, ticket, node, branch, cost, and duration metrics.")
    add_metrics_filters(metrics_show, True)
    set_handler(metrics_show, cmd_metrics_show)
    metrics_compare = metrics_commands.add_parser("compare", help="Compare two exact immutable workflow releases.")
    metrics_compare.add_argument("baseline_id")
    metrics_compare.add_argument("baseline_revision")
    metrics_compare.add_argument("candidate_id")
    metrics_compare.add_argument("candidate_revision")
    add_metrics_filters(metrics_compare, False)
    set_handler(metrics_compare, cmd_metrics_compare)

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
    ticket_list.add_argument("--status", choices=("pending", "ready", "running", "blocked", "waiting_approval", "waiting_external", "completed", "failed", "cancelled"))
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
    ticket_checkpoints = ticket_commands.add_parser("checkpoint-list", help="List tracker-hosted repository checkpoints for a ticket.")
    add_ticket_id(ticket_checkpoints)
    set_handler(ticket_checkpoints, cmd_ticket_checkpoints)
    attachment_upload = ticket_commands.add_parser("attachment-upload", help="Attach a local file to a ticket.")
    add_ticket_id(attachment_upload); add_revision(attachment_upload)
    attachment_upload.add_argument("--file", required=True, help="Local file to upload.")
    attachment_upload.add_argument("--filename", help="Stored filename; defaults to the local basename.")
    attachment_upload.add_argument("--content-type", help="Media type; defaults to a filename-derived type.")
    set_handler(attachment_upload, cmd_ticket_attachment_upload)
    attachment_download = ticket_commands.add_parser("attachment-download", help="Download a ticket attachment to a local file.")
    add_ticket_id(attachment_download)
    attachment_download.add_argument("attachment_id", help="Attachment ID returned by ticket show.")
    attachment_download.add_argument("--output", required=True, help="Local destination path.")
    attachment_download.add_argument("--force", action="store_true", help="Replace an existing destination atomically.")
    set_handler(attachment_download, cmd_ticket_attachment_download)
    attachment_remove = ticket_commands.add_parser("attachment-remove", help="Remove a ticket attachment reference.")
    add_ticket_id(attachment_remove); add_revision(attachment_remove)
    attachment_remove.add_argument("attachment_id", help="Attachment ID returned by ticket show.")
    set_handler(attachment_remove, cmd_ticket_attachment_remove)
    artifact_download = ticket_commands.add_parser("artifact-download", help="Download a recorded tracker artifact to a local file.")
    add_ticket_id(artifact_download)
    artifact_download.add_argument("artifact_id", help="Artifact ID returned by ticket or node-run state.")
    artifact_download.add_argument("--output", required=True, help="Local destination path.")
    artifact_download.add_argument("--force", action="store_true", help="Replace an existing destination atomically.")
    set_handler(artifact_download, cmd_ticket_artifact_download)
    ticket_metadata_list = ticket_commands.add_parser("metadata-list", help="Read all durable workflow metadata for a ticket.")
    add_ticket_id(ticket_metadata_list)
    set_handler(ticket_metadata_list, cmd_ticket_metadata_list)
    ticket_metadata_get = ticket_commands.add_parser("metadata-get", help="Read one durable workflow metadata value.")
    add_ticket_id(ticket_metadata_get)
    ticket_metadata_get.add_argument("key", help="Metadata key.")
    set_handler(ticket_metadata_get, cmd_ticket_metadata_get)
    ticket_metadata_set = ticket_commands.add_parser("metadata-set", help="Set one JSON workflow metadata value.")
    add_ticket_id(ticket_metadata_set)
    ticket_metadata_set.add_argument("key", help="Metadata key.")
    add_revision(ticket_metadata_set)
    value_input = ticket_metadata_set.add_mutually_exclusive_group(required=True)
    value_input.add_argument("--value-json", help="JSON value, such as true, 7, a quoted string, an array, or an object.")
    value_input.add_argument("--value-json-file", metavar="PATH", help="Read a JSON value from PATH, or - for stdin.")
    set_handler(ticket_metadata_set, cmd_ticket_metadata_set)
    ticket_metadata_delete = ticket_commands.add_parser("metadata-delete", help="Delete one workflow metadata value.")
    add_ticket_id(ticket_metadata_delete)
    ticket_metadata_delete.add_argument("key", help="Metadata key.")
    add_revision(ticket_metadata_delete)
    set_handler(ticket_metadata_delete, cmd_ticket_metadata_delete)
    set_handler(ticket_commands.add_parser("next-id", help="Preview the next tracker-local ID."), cmd_ticket_next_id)

    ticket_create = ticket_commands.add_parser("create", help="Create a ticket from Markdown.")
    ticket_create.add_argument("--markdown-file", required=True, help="Ticket Markdown path, or - for stdin.")
    ticket_create.add_argument("--auto-id", action="store_true", help="Replace the Markdown ID with an atomically allocated tracker ID.")
    ticket_create.add_argument("--filename", help="Optional storage filename hint.")
    ticket_create.add_argument("--workflow-id", help="Optional workflow artifact to pin; otherwise the tracker uses standard-delivery.")
    ticket_create.add_argument("--workflow-revision", help="Optional active trial revision to pin instead of the workflow's default revision.")
    ticket_create.add_argument("--workflow-inputs-json", metavar="PATH", help="JSON object of declared workflow input values; use - for stdin.")
    ticket_create.add_argument("--stage-enabled-json", metavar="PATH", help="JSON object mapping configurable stage IDs to booleans; use - for stdin.")
    set_handler(ticket_create, cmd_ticket_create)

    emit_candidates = ticket_commands.add_parser("emit-candidates", help="Submit child-work candidates through a configured intake source.")
    add_ticket_id(emit_candidates)
    emit_candidates.add_argument("source_id", help="Configured external or reusable intake source ID.")
    emit_candidates.add_argument("--candidates-json", required=True, metavar="PATH", help="JSON array of candidate objects; use - for stdin.")
    set_handler(emit_candidates, cmd_ticket_emit_candidates)

    ticket_edit = ticket_commands.add_parser("edit", help="Replace authoritative ticket Markdown.")
    add_ticket_id(ticket_edit)
    ticket_edit.add_argument("--markdown-file", required=True, help="Complete ticket Markdown path, or - for stdin.")
    add_revision(ticket_edit)
    set_handler(ticket_edit, cmd_ticket_edit)

    ticket_priority = ticket_commands.add_parser("priority", help="Change queue priority without interrupting active work.")
    add_ticket_id(ticket_priority); add_revision(ticket_priority)
    ticket_priority.add_argument("priority", type=int, help="Integer priority displayed as P<n>.")
    set_handler(ticket_priority, cmd_ticket_priority)

    human_estimate = ticket_commands.add_parser("human-estimate", help="Set or clear estimated human implementation days.")
    add_ticket_id(human_estimate); add_revision(human_estimate)
    estimate_value = human_estimate.add_mutually_exclusive_group(required=True)
    estimate_value.add_argument("--days", type=float, help="Non-negative estimated human days.")
    estimate_value.add_argument("--clear", action="store_true", help="Clear the estimate.")
    set_handler(human_estimate, cmd_ticket_human_estimate)

    reset_conversation = ticket_commands.add_parser("reset-conversation", help="Start a fresh generation for an inactive ticket conversation.")
    add_ticket_id(reset_conversation); add_revision(reset_conversation)
    reset_conversation.add_argument("key", help="Conversation key exposed by ticket show.")
    set_handler(reset_conversation, cmd_ticket_reset_conversation)

    ticket_decide = ticket_commands.add_parser("decide", help="Choose an outcome at the current human gate.")
    add_ticket_id(ticket_decide); add_revision(ticket_decide)
    ticket_decide.add_argument("decision")
    ticket_decide.add_argument("--message")
    set_handler(ticket_decide, cmd_ticket_decide)

    ticket_migrate = ticket_commands.add_parser("migrate-workflow", help="Explicitly move a paused or interrupted ticket to a workflow revision/node.")
    add_ticket_id(ticket_migrate); add_revision(ticket_migrate)
    ticket_migrate.add_argument("workflow_id"); ticket_migrate.add_argument("node_id")
    ticket_migrate.add_argument("--workflow-revision", help="Exact active trial revision; omit to use the workflow family's default release.")
    set_handler(ticket_migrate, cmd_ticket_migrate_workflow)

    ticket_checkpoint = ticket_commands.add_parser("checkpoint", help="Route a ticket through a configured Checkpoint node.")
    add_ticket_id(ticket_checkpoint); add_revision(ticket_checkpoint)
    ticket_checkpoint.add_argument("node_id", help="Checkpoint workflow node ID.")
    set_handler(ticket_checkpoint, cmd_ticket_checkpoint, checkpoint_action="create", checkpoint_id=None)

    ticket_restore = ticket_commands.add_parser("restore-checkpoint", help="Route a ticket through a configured Restore Checkpoint node.")
    add_ticket_id(ticket_restore); add_revision(ticket_restore)
    ticket_restore.add_argument("node_id", help="Restore Checkpoint workflow node ID.")
    ticket_restore.add_argument("checkpoint_id", help="Checkpoint ID from ticket show.")
    set_handler(ticket_restore, cmd_ticket_checkpoint, checkpoint_action="restore")

    for command, api_action, help_text in (
        ("ready", "ready", "Mark a pending valid ticket ready."),
        ("draft", "draft", "Return unclaimed ready work to pending draft."),
        ("wake", "wake", "Release the current durable external wait early."),
        ("retry", "retry", "Return failed or needs-attention work to ready."),
        ("release-supervisor", "release-supervisor", "Release inactive supervisor affinity."),
        ("unarchive", "unarchive", "Return an archived ticket to the completed queue."),
        ("jira-export", "jira/export", "Create a Jira issue for a local ticket."),
        ("jira-resync", "jira/resync", "Refresh a pending Jira-backed ticket."),
    ):
        action = ticket_commands.add_parser(command, help=help_text)
        add_ticket_id(action)
        add_revision(action)
        set_handler(action, cmd_ticket_simple_action, api_action=api_action)

    archive = ticket_commands.add_parser("archive", help="Archive a completed ticket, optionally recording its production result.")
    add_ticket_id(archive); add_revision(archive)
    archive.add_argument("--production-result", choices=PRODUCTION_RESULTS)
    archive_note = archive.add_mutually_exclusive_group()
    archive_note.add_argument("--production-note")
    archive_note.add_argument("--production-note-file", metavar="PATH")
    set_handler(archive, cmd_ticket_archive)

    assessment = ticket_commands.add_parser("production-assessment", help="Set or revise a completed ticket's production result.")
    add_ticket_id(assessment); add_revision(assessment)
    assessment.add_argument("--production-result", choices=PRODUCTION_RESULTS, required=True)
    assessment_note = assessment.add_mutually_exclusive_group()
    assessment_note.add_argument("--production-note")
    assessment_note.add_argument("--production-note-file", metavar="PATH")
    set_handler(assessment, cmd_ticket_production_assessment)

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
