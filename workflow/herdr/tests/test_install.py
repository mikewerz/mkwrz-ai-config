from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import install


def completed(command: list[str], stdout: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")


class InstallTests(unittest.TestCase):
    def test_supported_platforms(self) -> None:
        self.assertEqual(install.platform_key("Linux", "amd64"), "linux-x86_64")
        self.assertEqual(install.platform_key("Darwin", "arm64"), "macos-aarch64")
        with self.assertRaises(install.InstallError):
            install.platform_key("Windows", "amd64")

    def test_rejects_unexpected_integrations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "versions.json"
            path.write_text(json.dumps({"herdr": {"version": "1"}, "integrations": ["codex"]}))
            with self.assertRaises(install.InstallError):
                install.load_versions(path)

    def test_binary_is_verified_before_atomic_install(self) -> None:
        payload = b"pinned-herdr-binary"
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "bin" / "herdr"

            def downloader(_url: str, path: Path) -> None:
                path.write_bytes(payload)

            commands: list[list[str]] = []

            def runner(command: list[str]) -> subprocess.CompletedProcess[str]:
                commands.append(command)
                self.assertNotEqual(Path(command[0]), destination)
                return completed(command, "herdr 0.8.0\n")

            install.install_binary(
                destination,
                {"url": "https://example.invalid/herdr", "sha256": hashlib.sha256(payload).hexdigest()},
                "0.8.0",
                downloader,
                runner,
            )
            self.assertEqual(destination.read_bytes(), payload)
            self.assertTrue(destination.stat().st_mode & 0o100)
            self.assertEqual(commands[0][1:], ["--version"])

    def test_checksum_failure_preserves_existing_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "herdr"
            destination.write_bytes(b"old")

            def downloader(_url: str, path: Path) -> None:
                path.write_bytes(b"new")

            with self.assertRaises(install.InstallError):
                install.install_binary(destination, {"url": "unused", "sha256": "0" * 64}, "0.8.0", downloader)
            self.assertEqual(destination.read_bytes(), b"old")

    def test_installs_only_official_selected_integrations(self) -> None:
        commands: list[list[str]] = []

        def runner(command: list[str]) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            return completed(command, "claude 6\ncodex 5\n")

        status = install.install_integrations(Path("/opt/herdr"), ["claude", "codex"], runner)
        self.assertIn("codex 5", status)
        self.assertEqual(
            commands,
            [
                ["/opt/herdr", "integration", "install", "claude"],
                ["/opt/herdr", "integration", "install", "codex"],
                ["/opt/herdr", "integration", "status"],
            ],
        )


if __name__ == "__main__":
    unittest.main()
