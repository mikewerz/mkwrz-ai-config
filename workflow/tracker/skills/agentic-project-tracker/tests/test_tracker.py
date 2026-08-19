from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "tracker.py"


class StubHandler(BaseHTTPRequestHandler):
    responses: dict[tuple[str, str], tuple[int, Any] | tuple[int, Any, str]] = {}
    received: list[dict[str, Any]] = []

    def handle_request(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        body = json.loads(raw) if raw else None
        self.__class__.received.append({"method": self.command, "path": self.path, "body": body})
        configured = self.__class__.responses.get((self.command, self.path), (404, {"error": "Not found"}))
        status, payload = configured[:2]
        content_type = configured[2] if len(configured) == 3 else "application/json"
        encoded = (
            str(payload).encode("utf-8")
            if content_type.startswith("text/")
            else b"" if payload is None else json.dumps(payload).encode()
        )
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_DELETE = handle_request

    def log_message(self, _format: str, *_args: object) -> None:
        return


class TrackerClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.thread.join(timeout=2)
        cls.server.server_close()

    def setUp(self) -> None:
        StubHandler.responses = {}
        StubHandler.received = []

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--url", self.url, *args],
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )

    def test_lists_and_filters_current_ticket_fields(self) -> None:
        StubHandler.responses[("GET", "/api/tickets?include_archived=true")] = (200, {"tickets": [
            {
                "id": "A", "status": "ready", "phase": "implementation", "work_provider": "claude",
                "workflow_id": "end-to-end", "workflow_node_name": "Deploy", "workflow_stage_name": "Non-production",
                "provider": "codex",
            },
            {"id": "B", "status": "completed", "phase": "done", "work_provider": "claude"},
        ]})
        result = self.run_cli(
            "ticket", "list", "--include-archived", "--status", "ready", "--work-provider", "claude",
            "--workflow-id", "end-to-end", "--workflow-node", "Deploy", "--workflow-stage", "Non-production",
            "--provider", "codex",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"]["tickets"], [
            {
                "id": "A", "status": "ready", "phase": "implementation", "work_provider": "claude",
                "workflow_id": "end-to-end", "workflow_node_name": "Deploy", "workflow_stage_name": "Non-production",
                "provider": "codex",
            },
        ])

    def test_reads_plain_text_node_run_output(self) -> None:
        StubHandler.responses[("GET", "/api/tickets/APT-1/runs/run%2F1/output")] = (
            200, "full\nscript output\n", "text/plain",
        )
        result = self.run_cli("ticket", "run-output", "APT-1", "run/1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"], {
            "ticket_id": "APT-1", "run_id": "run/1", "output": "full\nscript output\n",
        })

    def test_reads_sets_and_deletes_ticket_metadata(self) -> None:
        StubHandler.responses[("GET", "/api/tickets/APT-1/metadata")] = (200, {"metadata": {"deploy": {"environment": "qa"}}})
        StubHandler.responses[("GET", "/api/tickets/APT-1/metadata/deploy.status")] = (200, {"key": "deploy.status", "value": "ready"})
        StubHandler.responses[("PUT", "/api/tickets/APT-1/metadata/deploy.status")] = (200, {"id": "APT-1"})
        StubHandler.responses[("DELETE", "/api/tickets/APT-1/metadata/deploy.status")] = (200, {"id": "APT-1"})

        self.assertEqual(self.run_cli("ticket", "metadata-list", "APT-1").returncode, 0)
        self.assertEqual(self.run_cli("ticket", "metadata-get", "APT-1", "deploy.status").returncode, 0)
        set_result = self.run_cli(
            "ticket", "metadata-set", "APT-1", "deploy.status", "--revision", "4",
            "--value-json", '{"state":"ready","attempt":2}',
        )
        self.assertEqual(set_result.returncode, 0, set_result.stderr)
        delete_result = self.run_cli("ticket", "metadata-delete", "APT-1", "deploy.status", "--revision", "5")
        self.assertEqual(delete_result.returncode, 0, delete_result.stderr)
        self.assertEqual(StubHandler.received[2]["body"], {
            "expected_revision": 4, "value": {"state": "ready", "attempt": 2},
        })
        self.assertEqual(StubHandler.received[3]["body"], {"expected_revision": 5})

    def test_sends_revisioned_guidance_payload(self) -> None:
        StubHandler.responses[("POST", "/api/tickets/APT-1/guidance")] = (200, {"id": "APT-1"})
        result = self.run_cli("ticket", "guidance", "APT-1", "--revision", "7", "--message", "Preserve the API.")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {"expected_revision": 7, "message": "Preserve the API."})

    def test_creates_ticket_from_file_with_auto_id(self) -> None:
        StubHandler.responses[("POST", "/api/tickets")] = (201, {"id": "AGENT-0001"})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ticket.md"
            path.write_text("---\nid: draft\n---\nGoal\n", encoding="utf-8")
            result = self.run_cli("ticket", "create", "--markdown-file", str(path), "--auto-id")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {"markdown": "---\nid: draft\n---\nGoal\n", "auto_id": True})

    def test_creates_ticket_with_v3_workflow_inputs_and_stage_choices(self) -> None:
        StubHandler.responses[("POST", "/api/tickets")] = (201, {"id": "AGENT-0002"})
        with tempfile.TemporaryDirectory() as directory:
            markdown = Path(directory) / "ticket.md"
            inputs = Path(directory) / "inputs.json"
            stages = Path(directory) / "stages.json"
            markdown.write_text("---\nid: draft\n---\nGoal\n", encoding="utf-8")
            inputs.write_text(json.dumps({"deploy-required": True, "target": "staging"}), encoding="utf-8")
            stages.write_text(json.dumps({"specification": False, "review": True}), encoding="utf-8")
            result = self.run_cli(
                "ticket", "create", "--markdown-file", str(markdown), "--auto-id",
                "--workflow-id", "end-to-end", "--workflow-inputs-json", str(inputs),
                "--stage-enabled-json", str(stages),
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "markdown": "---\nid: draft\n---\nGoal\n", "auto_id": True, "workflow_id": "end-to-end",
            "workflow_inputs": {"deploy-required": True, "target": "staging"},
            "stage_enabled": {"specification": False, "review": True},
        })

    def test_rejects_invalid_workflow_option_json_before_request(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            markdown = Path(directory) / "ticket.md"
            inputs = Path(directory) / "inputs.json"
            markdown.write_text("---\nid: draft\n---\nGoal\n", encoding="utf-8")
            inputs.write_text(json.dumps({"deploy-required": 1}), encoding="utf-8")
            result = self.run_cli("ticket", "create", "--markdown-file", str(markdown), "--workflow-inputs-json", str(inputs))
        self.assertEqual(result.returncode, 4)
        self.assertIn("Workflow inputs JSON values must be bool or str", result.stderr)
        self.assertEqual(StubHandler.received, [])

    def test_sends_generic_human_gate_decision(self) -> None:
        StubHandler.responses[("POST", "/api/tickets/APT-1/decide")] = (200, {"id": "APT-1"})
        result = self.run_cli("ticket", "decide", "APT-1", "changes_requested", "--revision", "9", "--message", "Cover rollback.")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "expected_revision": 9, "decision": "changes_requested", "message": "Cover rollback.",
        })

    def test_archives_with_a_production_assessment_and_can_revise_it_later(self) -> None:
        StubHandler.responses[("POST", "/api/tickets/APT-1/archive")] = (200, {"id": "APT-1"})
        archived = self.run_cli(
            "ticket", "archive", "APT-1", "--revision", "15", "--production-result", "succeeded",
            "--production-note", "Healthy after rollout.",
        )
        self.assertEqual(archived.returncode, 0, archived.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "expected_revision": 15, "production_result": "succeeded", "production_assessment_note": "Healthy after rollout.",
        })

        StubHandler.responses[("POST", "/api/tickets/APT-1/production-assessment")] = (200, {"id": "APT-1"})
        revised = self.run_cli(
            "ticket", "production-assessment", "APT-1", "--revision", "16", "--production-result", "rolled_back",
            "--production-note", "Delayed alert.",
        )
        self.assertEqual(revised.returncode, 0, revised.stderr)
        self.assertEqual(StubHandler.received[1]["body"], {
            "expected_revision": 16, "production_result": "rolled_back", "production_assessment_note": "Delayed alert.",
        })

    def test_surfaces_revision_conflict_without_retry(self) -> None:
        StubHandler.responses[("POST", "/api/tickets/APT-1/ready")] = (409, {
            "error": "Ticket revision changed", "details": {"frontmatter": {"revision": 8}},
        })
        result = self.run_cli("ticket", "ready", "APT-1", "--revision", "7")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(len(StubHandler.received), 1)
        self.assertEqual(json.loads(result.stderr), {
            "ok": False, "status": 409, "error": "Ticket revision changed", "details": {"frontmatter": {"revision": 8}},
        })

    def test_exposes_no_worker_or_supervisor_mutation_paths(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("/api/work/", source)
        self.assertNotIn("/api/supervisors/heartbeat", source)
        self.assertNotIn("/api/supervisors/unregister", source)

    def test_exposes_configuration_and_workflows_as_read_only_and_no_prompt_surface(self) -> None:
        StubHandler.responses[("GET", "/api/config")] = (200, {"config": {"repositories": []}})
        StubHandler.responses[("GET", "/api/workflows")] = (200, {"workflows": []})
        self.assertEqual(self.run_cli("config", "show").returncode, 0)
        self.assertEqual(self.run_cli("workflow", "list").returncode, 0)
        for args in (("config", "update"), ("workflow", "create"), ("prompt", "list")):
            result = self.run_cli(*args)
            self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual([(request["method"], request["path"]) for request in StubHandler.received], [
            ("GET", "/api/config"), ("GET", "/api/workflows"),
        ])


if __name__ == "__main__":
    unittest.main()
