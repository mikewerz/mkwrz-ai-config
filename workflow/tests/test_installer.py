from __future__ import annotations

import tempfile
import unittest
from os import utime
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import installer


class EnvironmentFileTests(unittest.TestCase):
    def test_merge_updates_managed_values_and_preserves_unknown_content(self) -> None:
        source = "# comment\nHOST=old\nFUTURE_SETTING=keep\nHOST=duplicate\n"
        merged = installer.merge_env_text(source, {"HOST": "127.0.0.1", "NEW_VALUE": "value with spaces"})
        self.assertEqual(merged.count("HOST="), 1)
        self.assertIn("HOST=127.0.0.1", merged)
        self.assertIn("FUTURE_SETTING=keep", merged)
        self.assertIn('NEW_VALUE="value with spaces"', merged)
        self.assertEqual(installer.merge_env_text(merged, {"HOST": "127.0.0.1", "NEW_VALUE": "value with spaces"}), merged)

    def test_atomic_environment_update_is_idempotent_and_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            example = root / ".env.example"
            target = root / ".env"
            example.write_text("HOST=127.0.0.1\nTOKEN=\n", encoding="utf-8")
            self.assertTrue(installer.update_env(target, example, {"HOST": "0.0.0.0", "TOKEN": "secret"}))
            self.assertFalse(installer.update_env(target, example, {"HOST": "0.0.0.0", "TOKEN": "secret"}))
            self.assertEqual(target.read_text(encoding="utf-8"), "HOST=0.0.0.0\nTOKEN=secret\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_read_env_decodes_quoted_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / ".env"
            path.write_text('PLAIN=value\nDOUBLE="value with spaces"\nSINGLE=\'literal\'\n', encoding="utf-8")
            self.assertEqual(installer.read_env(path), {"PLAIN": "value", "DOUBLE": "value with spaces", "SINGLE": "literal"})


class ValidationTests(unittest.TestCase):
    def test_accepts_portable_paths_and_http_origins(self) -> None:
        self.assertEqual(installer.validated_port("4310"), "4310")
        self.assertEqual(installer.validated_url("http://127.0.0.1:4310/"), "http://127.0.0.1:4310")
        self.assertEqual(installer.validated_id("worker-01.example"), "worker-01.example")

    def test_rejects_credentials_in_urls_and_unsafe_ids(self) -> None:
        with self.assertRaises(installer.InstallerError):
            installer.validated_url("http://user:secret@example.test")
        with self.assertRaises(installer.InstallerError):
            installer.validated_url("https://example.test/tracker")
        with self.assertRaises(installer.InstallerError):
            installer.validated_id("worker one")
        with self.assertRaises(installer.InstallerError):
            installer.encode_env_value("two\nlines")

    def test_treats_template_placeholder_paths_as_unconfigured(self) -> None:
        self.assertEqual(
            installer.existing_or_default({"PROJECT_ROOT": "/absolute/path/to/agent/projects"}, "PROJECT_ROOT", "/srv/projects"),
            "/srv/projects",
        )


class IdempotenceTests(unittest.TestCase):
    def test_current_herdr_installation_is_not_reinstalled(self) -> None:
        current = CompletedProcess(["installer"], 0, stdout="Herdr is current.\n", stderr="")
        with patch("installer.subprocess.run", return_value=current) as check, patch("installer.run") as install:
            installer.ensure_herdr(Path("/opt/herdr/bin/herdr"))
        check.assert_called_once()
        install.assert_not_called()

    def test_current_node_dependencies_and_build_are_not_repeated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            inputs = [project / "package-lock.json", project / "package.json", project / "src" / "index.ts"]
            marker = project / "node_modules" / ".package-lock.json"
            output = project / "dist" / "index.js"
            for path in [*inputs, marker, output]:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("current\n", encoding="utf-8")
            for path in inputs:
                utime(path, (100, 100))
            for path in (marker, output):
                utime(path, (200, 200))
            with patch("installer.run") as command:
                installer.prepare_node_project(project, [output])
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
