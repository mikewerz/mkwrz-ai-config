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
    responses: dict[tuple[str, str], tuple[int, Any]] = {}
    received: list[dict[str, Any]] = []

    def handle_request(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        body = json.loads(raw) if raw else None
        self.__class__.received.append({"method": self.command, "path": self.path, "body": body})
        status, payload = self.__class__.responses.get((self.command, self.path), (404, {"error": "Not found"}))
        encoded = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request

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
            {"id": "A", "status": "ready", "phase": "implementation", "work_provider": "claude"},
            {"id": "B", "status": "completed", "phase": "done", "work_provider": "claude"},
        ]})
        result = self.run_cli("ticket", "list", "--include-archived", "--status", "ready", "--work-provider", "claude")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"]["tickets"], [
            {"id": "A", "status": "ready", "phase": "implementation", "work_provider": "claude"},
        ])

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

    def test_config_update_allowlists_operator_settings(self) -> None:
        StubHandler.responses[("PUT", "/api/config")] = (200, {"config": {"revision": 4}})
        document = {
            "ok": True,
            "status": 200,
            "data": {"config": {
                "revision": 3,
                "tickets": {"next_number": 99},
                "providers": {"enabled": ["claude"]},
                "repositories": [{"id": "repo", "url": "git@example/repo.git"}],
                "jira": {"enabled": False},
                "github": {"observation_enabled": False},
                "unknown": "preserved by server, not client controlled",
            }},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            result = self.run_cli("config", "update", "--revision", "3", "--json-file", str(path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "expected_revision": 3,
            "providers": {"enabled": ["claude"]},
            "repositories": [{"id": "repo", "url": "git@example/repo.git"}],
            "jira": {"enabled": False},
            "github": {"observation_enabled": False},
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


if __name__ == "__main__":
    unittest.main()
