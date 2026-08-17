#!/usr/bin/env python3
"""Install pinned Herdr and its official agent integrations for one user."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parent
VERSIONS_PATH = ROOT / "config" / "versions.json"


class InstallError(RuntimeError):
    pass


def load_versions(path: Path = VERSIONS_PATH) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data.get("herdr", {}).get("version"), str):
        raise InstallError("versions.json does not contain a Herdr version")
    if data.get("integrations") != ["claude", "codex"]:
        raise InstallError("versions.json must select exactly the Claude Code and Codex integrations")
    return data


def platform_key(system: str | None = None, machine: str | None = None) -> str:
    operating_system = (system or platform.system()).lower()
    architecture = (machine or platform.machine()).lower()
    os_name = {"linux": "linux", "darwin": "macos"}.get(operating_system)
    arch_name = {
        "x86_64": "x86_64",
        "amd64": "x86_64",
        "aarch64": "aarch64",
        "arm64": "aarch64",
    }.get(architecture)
    if not os_name or not arch_name:
        raise InstallError(f"unsupported platform: {operating_system}/{architecture}")
    return f"{os_name}-{arch_name}"


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, text=True, capture_output=True)


def binary_version(binary: Path, runner: Callable[[list[str]], subprocess.CompletedProcess[str]] = run) -> str:
    completed = runner([str(binary), "--version"])
    return (completed.stdout or completed.stderr).strip()


def validate_binary(
    binary: Path,
    version: str,
    runner: Callable[[list[str]], subprocess.CompletedProcess[str]] = run,
) -> None:
    output = binary_version(binary, runner)
    if version not in output:
        raise InstallError(f"expected Herdr {version}, got {output or 'no version output'}")


def download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "agent-herdr-config"})
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def install_binary(
    destination: Path,
    asset: dict[str, str],
    version: str,
    downloader: Callable[[str, Path], None] = download,
    runner: Callable[[list[str]], subprocess.CompletedProcess[str]] = run,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".herdr-", dir=destination.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        downloader(asset["url"], temporary)
        actual = digest(temporary)
        if actual != asset["sha256"]:
            raise InstallError(f"Herdr checksum mismatch: expected {asset['sha256']}, got {actual}")
        temporary.chmod(0o755)
        validate_binary(temporary, version, runner)
        os.replace(temporary, destination)
        directory_fd = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def install_integrations(
    binary: Path,
    integrations: list[str],
    runner: Callable[[list[str]], subprocess.CompletedProcess[str]] = run,
) -> str:
    for integration in integrations:
        runner([str(binary), "integration", "install", integration])
    return runner([str(binary), "integration", "status"]).stdout.strip()


def check_prerequisites(home: Path, integrations: list[str]) -> None:
    required = {
        "claude": Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude")),
        "codex": Path(os.environ.get("CODEX_HOME", home / ".codex")),
    }
    missing = [f"{name}: {required[name]}" for name in integrations if not required[name].is_dir()]
    if missing:
        raise InstallError(
            "agent configuration directories must exist before Herdr installs its official hooks:\n  "
            + "\n  ".join(missing)
        )


def write_receipt(state_path: Path, version: str, integrations: list[str], binary: Path) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {"schema_version": 1, "herdr_version": version, "binary": str(binary), "integrations": integrations},
        indent=2,
    ) + "\n"
    fd, temporary_name = tempfile.mkstemp(prefix=".install-", dir=state_path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, state_path)
    finally:
        temporary.unlink(missing_ok=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="apply the displayed plan without prompting")
    parser.add_argument("--check", action="store_true", help="verify the installed binary and integrations without changing them")
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local" / "bin")
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".local" / "state" / "agent-herdr-config")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    versions = load_versions()
    version = versions["herdr"]["version"]
    integrations = list(versions["integrations"])
    key = platform_key()
    try:
        asset = versions["herdr"]["assets"][key]
    except KeyError as error:
        raise InstallError(f"no pinned Herdr asset for {key}") from error
    binary = args.bin_dir.expanduser().resolve() / "herdr"

    if args.check:
        validate_binary(binary, version)
        output = run([str(binary), "integration", "status"]).stdout.strip()
        if any(name not in output for name in integrations):
            raise InstallError("Herdr integration status does not list Claude Code and Codex")
        print(f"Herdr {version} and official Claude Code and Codex integrations are present.")
        return 0

    check_prerequisites(Path.home(), integrations)
    print(f"Install Herdr {version} ({key}) to {binary}")
    print("Install official integrations: claude, codex")
    print("No agent executables, tool permissions, credentials, or reasoning settings will be changed.")
    if not args.yes and input("Continue? [y/N] ").strip().lower() not in {"y", "yes"}:
        print("Cancelled; no changes made.")
        return 0

    install_binary(binary, asset, version)
    status = install_integrations(binary, integrations)
    write_receipt(args.state_dir.expanduser().resolve() / "install.json", version, integrations, binary)
    print(status)
    print(f"Installed Herdr {version}. Add {binary.parent} to PATH if needed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InstallError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
