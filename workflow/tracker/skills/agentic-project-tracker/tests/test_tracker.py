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
        body = json.loads(raw) if raw and self.headers.get_content_type() == "application/json" else raw or None
        self.__class__.received.append({
            "method": self.command, "path": self.path, "body": body,
            "headers": {name.lower(): value for name, value in self.headers.items()},
        })
        configured = self.__class__.responses.get((self.command, self.path), (404, {"error": "Not found"}))
        status, payload = configured[:2]
        content_type = configured[2] if len(configured) == 3 else "application/json"
        encoded = payload if isinstance(payload, bytes) else (
            str(payload).encode("utf-8") if content_type.startswith("text/")
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
                "id": "A", "status": "ready", "phase": "implementation",
                "workflow_id": "end-to-end", "workflow_node_name": "Deploy", "workflow_stage_name": "Non-production",
                "provider": "codex",
            },
            {"id": "B", "status": "completed", "phase": "done"},
        ]})
        result = self.run_cli(
            "ticket", "list", "--include-archived", "--status", "ready",
            "--workflow-id", "end-to-end", "--workflow-node", "Deploy", "--workflow-stage", "Non-production",
            "--provider", "codex",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["data"]["tickets"], [
            {
                "id": "A", "status": "ready", "phase": "implementation",
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

    def test_reads_readiness_and_operational_status(self) -> None:
        StubHandler.responses[("GET", "/api/readyz")] = (200, {"ready": True, "status": "ready"})
        StubHandler.responses[("GET", "/api/operations")] = (200, {"ready": True, "background_operations": {}})

        readiness = self.run_cli("readiness")
        operations = self.run_cli("operations")

        self.assertEqual(readiness.returncode, 0, readiness.stderr)
        self.assertEqual(operations.returncode, 0, operations.stderr)
        self.assertEqual([request["path"] for request in StubHandler.received], ["/api/readyz", "/api/operations"])

    def test_inspects_intake_and_emits_parent_linked_candidates(self) -> None:
        StubHandler.responses[("GET", "/api/intake")] = (200, {"sources": [{"id": "dependency-follow-up"}]})
        StubHandler.responses[("POST", "/api/tickets/APT-1/candidates")] = (201, {"candidates": [{"decision": "admitted", "ticket_id": "AGENT-0002"}]})
        candidates = [{"external_key": "dto:2.4.0:consumer-b", "title": "Update consumer B", "description": "Consume DTO 2.4.0."}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidates.json"
            path.write_text(json.dumps(candidates), encoding="utf-8")
            shown = self.run_cli("intake", "show")
            emitted = self.run_cli("ticket", "emit-candidates", "APT-1", "dependency-follow-up", "--candidates-json", str(path))

        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertEqual(emitted.returncode, 0, emitted.stderr)
        self.assertEqual(StubHandler.received[1]["body"], {"source_id": "dependency-follow-up", "candidates": candidates})

    def test_uploads_and_removes_a_ticket_attachment_with_revision_fencing(self) -> None:
        StubHandler.responses[("POST", "/api/tickets/APT-1/attachments?filename=evidence.txt&expected_revision=4")] = (
            201, {"id": "APT-1", "revision": 5},
        )
        StubHandler.responses[("DELETE", "/api/tickets/APT-1/attachments/attachment%2F1")] = (
            200, {"id": "APT-1", "revision": 6},
        )
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "evidence.txt"
            source.write_bytes(b"proof\n")

            uploaded = self.run_cli("ticket", "attachment-upload", "APT-1", "--revision", "4", "--file", str(source))
            removed = self.run_cli(
                "ticket", "attachment-remove", "APT-1", "attachment/1", "--revision", "5",
            )

        self.assertEqual(uploaded.returncode, 0, uploaded.stderr)
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(StubHandler.received[0]["body"], b"proof\n")
        self.assertEqual(StubHandler.received[0]["headers"]["content-type"], "application/octet-stream")
        self.assertEqual(StubHandler.received[0]["headers"]["x-attachment-content-type"], "text/plain")
        self.assertEqual(StubHandler.received[1]["body"], {"expected_revision": 5})

    def test_downloads_ticket_content_atomically_and_requires_force_to_overwrite(self) -> None:
        StubHandler.responses[("GET", "/api/tickets/APT-1/artifacts/artifact%2F1/content?download=true")] = (
            200, b"artifact bytes", "application/octet-stream",
        )
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "nested" / "artifact.bin"

            downloaded = self.run_cli(
                "ticket", "artifact-download", "APT-1", "artifact/1", "--output", str(destination),
            )
            refused = self.run_cli(
                "ticket", "artifact-download", "APT-1", "artifact/1", "--output", str(destination),
            )

            self.assertEqual(downloaded.returncode, 0, downloaded.stderr)
            self.assertEqual(destination.read_bytes(), b"artifact bytes")
            self.assertEqual(refused.returncode, 4)
            self.assertIn("Refusing to overwrite", refused.stderr)

    def test_routes_current_operator_controls_with_exact_revisions(self) -> None:
        StubHandler.responses[("POST", "/api/tickets/APT-1/priority")] = (200, {"id": "APT-1"})
        StubHandler.responses[("POST", "/api/tickets/APT-1/human-estimate")] = (200, {"id": "APT-1"})
        StubHandler.responses[("POST", "/api/tickets/APT-1/conversations/work/reset")] = (200, {"id": "APT-1"})
        StubHandler.responses[("POST", "/api/tickets/APT-1/draft")] = (200, {"id": "APT-1"})
        StubHandler.responses[("POST", "/api/tickets/APT-1/wake")] = (200, {"id": "APT-1"})

        results = [
            self.run_cli("ticket", "priority", "APT-1", "3", "--revision", "10"),
            self.run_cli("ticket", "human-estimate", "APT-1", "--days", "2.5", "--revision", "11"),
            self.run_cli("ticket", "reset-conversation", "APT-1", "work", "--revision", "12"),
            self.run_cli("ticket", "draft", "APT-1", "--revision", "13"),
            self.run_cli("ticket", "wake", "APT-1", "--revision", "14"),
        ]

        self.assertTrue(all(result.returncode == 0 for result in results), [result.stderr for result in results])
        self.assertEqual([request["body"] for request in StubHandler.received], [
            {"expected_revision": 10, "priority": 3},
            {"expected_revision": 11, "estimated_human_days": 2.5},
            {"expected_revision": 12},
            {"expected_revision": 13},
            {"expected_revision": 14},
        ])

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

    def test_creates_ticket_with_workflow_inputs_and_stage_choices(self) -> None:
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
                "--workflow-id", "end-to-end", "--workflow-revision", "a" * 64, "--workflow-inputs-json", str(inputs),
                "--stage-enabled-json", str(stages),
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "markdown": "---\nid: draft\n---\nGoal\n", "auto_id": True, "workflow_id": "end-to-end",
            "workflow_revision": "a" * 64,
            "workflow_inputs": {"deploy-required": True, "target": "staging"},
            "stage_enabled": {"specification": False, "review": True},
        })

    def test_edits_ticket_without_phase_or_provider_routing(self) -> None:
        StubHandler.responses[("PUT", "/api/tickets/APT-1")] = (200, {"id": "APT-1"})
        with tempfile.TemporaryDirectory() as directory:
            markdown = Path(directory) / "ticket.md"
            markdown.write_text("---\nid: APT-1\nrevision: 7\n---\nRevised goal\n", encoding="utf-8")
            result = self.run_cli(
                "ticket", "edit", "APT-1", "--revision", "7", "--markdown-file", str(markdown),
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "markdown": "---\nid: APT-1\nrevision: 7\n---\nRevised goal\n",
            "expected_revision": 7,
        })

    def test_routes_checkpoint_and_restore_requests_through_workflow_nodes(self) -> None:
        StubHandler.responses[("POST", "/api/tickets/APT-1/checkpoints/action")] = (200, {"id": "APT-1"})
        created = self.run_cli("ticket", "checkpoint", "APT-1", "save-state", "--revision", "7")
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "expected_revision": 7, "action": "create", "node_id": "save-state",
        })
        StubHandler.received.clear()
        restored = self.run_cli("ticket", "restore-checkpoint", "APT-1", "restore-state", "checkpoint-1", "--revision", "8")
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "expected_revision": 8, "action": "restore", "node_id": "restore-state", "checkpoint_id": "checkpoint-1",
        })

    def test_migrates_to_the_default_or_an_explicit_trial_release(self) -> None:
        StubHandler.responses[("POST", "/api/tickets/APT-1/workflow/migrate")] = (200, {"id": "APT-1"})
        default = self.run_cli(
            "ticket", "migrate-workflow", "APT-1", "standard-delivery", "implementation", "--revision", "7",
        )
        trial = self.run_cli(
            "ticket", "migrate-workflow", "APT-1", "standard-delivery", "implementation", "--revision", "8",
            "--workflow-revision", "a" * 64,
        )
        self.assertEqual(default.returncode, 0, default.stderr)
        self.assertEqual(trial.returncode, 0, trial.stderr)
        self.assertEqual(StubHandler.received[0]["body"], {
            "expected_revision": 7, "workflow_id": "standard-delivery", "node_id": "implementation",
        })
        self.assertEqual(StubHandler.received[1]["body"], {
            "expected_revision": 8, "workflow_id": "standard-delivery", "node_id": "implementation",
            "workflow_revision": "a" * 64,
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

    def test_lists_workflow_releases_and_reads_an_immutable_revision(self) -> None:
        revision = "a" * 64
        StubHandler.responses[("GET", "/api/workflow-releases")] = (200, {
            "catalog": {
                "default_workflow_id": "standard-delivery",
                "workflows": {
                    "standard-delivery": {
                        "default_revision": revision,
                        "releases": [{"revision": revision, "version": 1, "status": "active"}],
                    },
                },
            },
        })
        StubHandler.responses[("GET", f"/api/workflows/standard-delivery/revisions/{revision}")] = (200, {
            "workflow": {"id": "standard-delivery", "revision": revision},
        })

        releases = self.run_cli("workflow", "releases")
        exact = self.run_cli("workflow", "show", "standard-delivery", "--revision", revision)

        self.assertEqual(releases.returncode, 0, releases.stderr)
        self.assertEqual(exact.returncode, 0, exact.stderr)
        self.assertEqual(
            [(request["method"], request["path"]) for request in StubHandler.received],
            [
                ("GET", "/api/workflow-releases"),
                ("GET", f"/api/workflows/standard-delivery/revisions/{revision}"),
            ],
        )

    def test_reads_filtered_metrics_and_compares_exact_workflow_releases(self) -> None:
        revision_a = "a" * 64
        revision_b = "b" * 64
        show_path = "/api/metrics?from=2026-01-01&production_result=succeeded&labels=backend%2Curgent&label_mode=all&repositories=api&workflow_id=standard-delivery&workflow_revision=" + revision_a
        compare_path = "/api/metrics/compare?labels=backend&label_mode=any&left_id=standard-delivery&left_revision=" + revision_a + "&right_id=standard-delivery&right_revision=" + revision_b
        StubHandler.responses[("GET", show_path)] = (200, {"totals": {"tickets": 2}})
        StubHandler.responses[("GET", compare_path)] = (200, {"left": {}, "right": {}})

        shown = self.run_cli(
            "metrics", "show", "--from", "2026-01-01", "--production-result", "succeeded",
            "--label", "backend", "--label", "urgent", "--label-mode", "all", "--repository", "api",
            "--workflow-id", "standard-delivery", "--workflow-revision", revision_a,
        )
        compared = self.run_cli(
            "metrics", "compare", "standard-delivery", revision_a, "standard-delivery", revision_b,
            "--label", "backend",
        )

        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertEqual(compared.returncode, 0, compared.stderr)
        self.assertEqual([request["path"] for request in StubHandler.received], [show_path, compare_path])


if __name__ == "__main__":
    unittest.main()
