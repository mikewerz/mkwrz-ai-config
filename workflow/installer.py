#!/usr/bin/env python3
"""Interactively install and configure the lightweight agent workflow."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
TRACKER_ROOT = ROOT / "tracker"
SUPERVISOR_ROOT = ROOT / "supervisor"
HERDR_ROOT = ROOT / "herdr"
MINIMUM_NODE = (22, 12, 0)
ENV_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
SAFE_ENV_VALUE = re.compile(r"^[A-Za-z0-9_./:@,+-]*$")


class InstallerError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    tracker_host: str
    tracker_port: int
    tickets_root: Path
    tracker_url: str
    callback_url: str
    supervisor_id: str
    supervisor_host: str
    project_root: Path
    assignment_root: Path
    herdr_session: str
    herdr_executable: Path
    github_token: str | None = None
    jira_email: str | None = None
    jira_token: str | None = None


def run(
    command: list[str], cwd: Path | None = None, capture: bool = False, environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, check=True, text=True, capture_output=capture, env=environment)


def command_path(name: str) -> Path:
    path = shutil.which(name)
    if not path:
        raise InstallerError(f"{name} is required but is not available on PATH")
    return Path(path).resolve()


def node_version(node: Path) -> tuple[int, int, int]:
    output = run([str(node), "--version"], capture=True).stdout.strip()
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", output)
    if not match:
        raise InstallerError(f"could not parse Node.js version: {output or 'no output'}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def check_prerequisites(require_agents: bool = True) -> None:
    if sys.version_info < (3, 10):
        raise InstallerError("Python 3.10 or newer is required")
    node = command_path("node")
    version = node_version(node)
    if version < MINIMUM_NODE:
        rendered = ".".join(str(part) for part in version)
        raise InstallerError(f"Node.js 22.12 or newer is required; found {rendered}")
    command_path("npm")
    command_path("git")
    if not require_agents:
        return
    missing: list[str] = []
    for executable in ("claude", "codex"):
        if not shutil.which(executable):
            missing.append(f"{executable} executable")
    environment = agent_environment()
    agent_directories = {
        "Claude configuration": Path(environment.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))),
        "Codex configuration": Path(environment.get("CODEX_HOME", str(Path.home() / ".codex"))),
    }
    missing.extend(f"{label} ({path})" for label, path in agent_directories.items() if not path.expanduser().is_dir())
    if missing:
        raise InstallerError(
            "Claude Code and Codex must be installed and initialized before installing Herdr integrations:\n  "
            + "\n  ".join(missing)
        )


def decode_env_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            decoded = json.loads(value)
            return decoded if isinstance(decoded, str) else value
        except json.JSONDecodeError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1]
    return value


def read_env(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = ENV_ASSIGNMENT.match(line)
        if match:
            values[match.group(1)] = decode_env_value(line[match.end():])
    return values


def agent_environment() -> dict[str, str]:
    environment = dict(os.environ)
    configured = read_env(SUPERVISOR_ROOT / ".env")
    for key in ("CLAUDE_CONFIG_DIR", "CODEX_HOME"):
        if key not in environment and configured.get(key):
            environment[key] = configured[key]
    return environment


def encode_env_value(value: str) -> str:
    if "\n" in value or "\r" in value or "\0" in value:
        raise InstallerError("environment values must be single-line text")
    return value if SAFE_ENV_VALUE.fullmatch(value) else json.dumps(value)


def merge_env_text(source: str, values: dict[str, str]) -> str:
    lines = source.splitlines()
    emitted: set[str] = set()
    output: list[str] = []
    for line in lines:
        match = ENV_ASSIGNMENT.match(line)
        key = match.group(1) if match else None
        if key not in values:
            output.append(line)
            continue
        if key in emitted:
            continue
        output.append(f"{key}={encode_env_value(values[key])}")
        emitted.add(key)
    missing = [key for key in values if key not in emitted]
    if missing and output and output[-1] != "":
        output.append("")
    output.extend(f"{key}={encode_env_value(values[key])}" for key in missing)
    return "\n".join(output).rstrip() + "\n"


def atomic_write(path: Path, content: str, mode: int = 0o600) -> bool:
    previous = path.read_text(encoding="utf-8") if path.exists() else None
    if previous == content:
        path.chmod(mode)
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def update_env(path: Path, example: Path, values: dict[str, str]) -> bool:
    source = path.read_text(encoding="utf-8") if path.exists() else example.read_text(encoding="utf-8")
    return atomic_write(path, merge_env_text(source, values))


def prompt(
    label: str,
    default: str,
    validator: Callable[[str], str] = lambda value: value,
    input_fn: Callable[[str], str] = input,
) -> str:
    while True:
        answer = input_fn(f"{label} [{default}]: ").strip()
        try:
            return validator(answer or default)
        except InstallerError as error:
            print(f"  {error}")


def prompt_yes_no(label: str, default: bool = False, input_fn: Callable[[str], str] = input) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        answer = input_fn(f"{label} [{suffix}] ").strip().lower()
        if not answer:
            return default
        if answer in {"y", "yes"}:
            return True
        if answer in {"n", "no"}:
            return False
        print("  Enter yes or no.")


def validated_host(value: str) -> str:
    if not value or any(character.isspace() for character in value) or any(character in value for character in "\r\n\0"):
        raise InstallerError("host must be a nonempty hostname or address without whitespace")
    return value


def validated_port(value: str) -> str:
    try:
        port = int(value)
    except ValueError as error:
        raise InstallerError("port must be an integer") from error
    if not 1 <= port <= 65535:
        raise InstallerError("port must be between 1 and 65535")
    return str(port)


def validated_url(value: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password
        or parsed.path not in {"", "/"} or parsed.params or parsed.query or parsed.fragment
    ):
        raise InstallerError("URL must be an HTTP(S) origin without credentials, a path, a query, or a fragment")
    return value.rstrip("/")


def validated_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise InstallerError("value must use only letters, numbers, dots, underscores, or hyphens")
    return value


def absolute_path(value: str) -> str:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise InstallerError("path must be absolute (a leading ~ is accepted)")
    return str(path.resolve())


def existing_or_default(values: dict[str, str], key: str, default: str) -> str:
    current = values.get(key, "")
    return default if not current or current.startswith("/absolute/path/to/") else current


def default_supervisor_id() -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", socket.gethostname()).strip("-.")
    return normalized or "coordinator-vm"


def collect_settings(non_interactive: bool = False) -> Settings:
    tracker = read_env(TRACKER_ROOT / ".env")
    supervisor = read_env(SUPERVISOR_ROOT / ".env")
    data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    defaults = {
        "host": existing_or_default(tracker, "HOST", "127.0.0.1"),
        "port": existing_or_default(tracker, "PORT", "4310"),
        "tickets": existing_or_default(tracker, "TICKETS_ROOT", str(data_home / "mkwrz-ai-config" / "tickets")),
        "supervisor_id": existing_or_default(supervisor, "SUPERVISOR_ID", default_supervisor_id()),
        "supervisor_host": existing_or_default(supervisor, "SUPERVISOR_HOST", default_supervisor_id()),
        "projects": existing_or_default(supervisor, "PROJECT_ROOT", str(Path.home() / "agentic-projects")),
        "session": existing_or_default(supervisor, "HERDR_SESSION", "agentic-projects"),
        "herdr": existing_or_default(supervisor, "HERDR_EXECUTABLE", str(Path.home() / ".local" / "bin" / "herdr")),
    }

    def ask(label: str, default: str, validator: Callable[[str], str] = lambda value: value) -> str:
        return validator(default) if non_interactive else prompt(label, default, validator)

    host = ask("Tracker bind host", defaults["host"], validated_host)
    port = int(ask("Tracker port", defaults["port"], validated_port))
    tickets = Path(ask("Ticket data directory", defaults["tickets"], absolute_path))
    local_url = f"http://127.0.0.1:{port}"
    tracker_url = ask("Tracker URL reachable from this supervisor", existing_or_default(supervisor, "TRACKER_URL", local_url), validated_url)
    callback_url = ask("Tracker callback URL reachable from agents", existing_or_default(supervisor, "CALLBACK_BASE_URL", tracker_url), validated_url)
    supervisor_id = ask("Stable supervisor ID", defaults["supervisor_id"], validated_id)
    supervisor_host = ask("Supervisor host identity", defaults["supervisor_host"], validated_id)
    projects = Path(ask("Managed repositories directory", defaults["projects"], absolute_path))
    assignment_default = existing_or_default(supervisor, "ASSIGNMENT_ROOT", str(projects / ".agentic-assignments"))
    assignments = Path(ask("Durable assignment directory", assignment_default, absolute_path))
    session = ask("Herdr session name", defaults["session"], validated_id)
    herdr = Path(ask("Herdr executable", defaults["herdr"], absolute_path))
    if herdr.name != "herdr":
        raise InstallerError("Herdr executable path must end in /herdr")

    github_token: str | None = None
    jira_email: str | None = None
    jira_token: str | None = None
    if not non_interactive and prompt_yes_no("Configure optional GitHub/Jira credentials now?", False):
        existing_github = tracker.get("GITHUB_TOKEN", "")
        existing_jira_token = tracker.get("JIRA_API_TOKEN", "")
        jira_email = prompt("Jira email (use '-' to clear)", tracker.get("JIRA_EMAIL", ""), lambda value: "" if value == "-" else value)
        github_answer = getpass.getpass("GitHub token (blank keeps current; '-' clears): ").strip()
        jira_answer = getpass.getpass("Jira API token (blank keeps current; '-' clears): ").strip()
        github_token = "" if github_answer == "-" else github_answer or existing_github
        jira_token = "" if jira_answer == "-" else jira_answer or existing_jira_token

    return Settings(
        tracker_host=host, tracker_port=port, tickets_root=tickets,
        tracker_url=tracker_url, callback_url=callback_url,
        supervisor_id=supervisor_id, supervisor_host=supervisor_host,
        project_root=projects, assignment_root=assignments,
        herdr_session=session, herdr_executable=herdr,
        github_token=github_token, jira_email=jira_email, jira_token=jira_token,
    )


def tracker_env_values(settings: Settings) -> dict[str, str]:
    values = {
        "HOST": settings.tracker_host,
        "PORT": str(settings.tracker_port),
        "TICKETS_ROOT": str(settings.tickets_root),
    }
    optional = {
        "GITHUB_TOKEN": settings.github_token,
        "JIRA_EMAIL": settings.jira_email,
        "JIRA_API_TOKEN": settings.jira_token,
    }
    values.update({key: value for key, value in optional.items() if value is not None})
    return values


def supervisor_env_values(settings: Settings) -> dict[str, str]:
    return {
        "TRACKER_URL": settings.tracker_url,
        "CALLBACK_BASE_URL": settings.callback_url,
        "SUPERVISOR_ID": settings.supervisor_id,
        "SUPERVISOR_HOST": settings.supervisor_host,
        "PROJECT_ROOT": str(settings.project_root),
        "ASSIGNMENT_ROOT": str(settings.assignment_root),
        "HERDR_SESSION": settings.herdr_session,
        "HERDR_EXECUTABLE": str(settings.herdr_executable),
        "PROVIDERS": "claude,codex",
    }


def latest_mtime(paths: Iterable[Path]) -> float:
    latest = 0.0
    for path in paths:
        if path.is_file():
            latest = max(latest, path.stat().st_mtime)
        elif path.is_dir():
            for child in path.rglob("*"):
                if child.is_file() and "node_modules" not in child.parts and "dist" not in child.parts:
                    latest = max(latest, child.stat().st_mtime)
    return latest


def prepare_node_project(project: Path, outputs: list[Path], force: bool = False) -> None:
    lock = project / "package-lock.json"
    dependency_marker = project / "node_modules" / ".package-lock.json"
    install_needed = force or not dependency_marker.exists() or lock.stat().st_mtime > dependency_marker.stat().st_mtime
    if install_needed:
        print(f"Installing locked dependencies in {project.name}...")
        run(["npm", "ci"], cwd=project)
    build_inputs = [project / "src", project / "public", project / "scripts", project / "package.json", lock]
    build_needed = force or install_needed or any(not output.exists() for output in outputs)
    if not build_needed:
        build_needed = latest_mtime(build_inputs) > min(output.stat().st_mtime for output in outputs)
    if build_needed:
        print(f"Building {project.name}...")
        run(["npm", "run", "build"], cwd=project)
    else:
        print(f"{project.name}: dependencies and build are current.")


def ensure_herdr(executable: Path, force: bool = False) -> None:
    check = [sys.executable, str(HERDR_ROOT / "install.py"), "--check", "--bin-dir", str(executable.parent)]
    if not force:
        result = subprocess.run(check, text=True, capture_output=True, env=agent_environment())
        if result.returncode == 0:
            print(result.stdout.strip() or "Herdr installation is current.")
            return
    print("Installing the pinned Herdr release and official Claude/Codex integrations...")
    run(
        [sys.executable, str(HERDR_ROOT / "install.py"), "--yes", "--bin-dir", str(executable.parent)],
        environment=agent_environment(),
    )


def print_plan(settings: Settings, skip_build: bool, skip_herdr: bool) -> None:
    print("\nInstallation plan")
    print(f"  Tracker:       {settings.tracker_host}:{settings.tracker_port}")
    print(f"  Ticket data:   {settings.tickets_root}")
    print(f"  Supervisor:    {settings.supervisor_id} ({settings.supervisor_host})")
    print(f"  Tracker URL:   {settings.tracker_url}")
    print(f"  Callback URL:  {settings.callback_url}")
    print(f"  Project root:  {settings.project_root}")
    print(f"  Assignments:   {settings.assignment_root}")
    print(f"  Herdr session: {settings.herdr_session}")
    print(f"  Herdr binary:  {settings.herdr_executable}")
    print(f"  Node setup:    {'skip' if skip_build else 'install/build when needed'}")
    print(f"  Herdr setup:   {'skip' if skip_herdr else 'install/update when needed'}")
    if any(value is not None for value in (settings.github_token, settings.jira_email, settings.jira_token)):
        print("  Credentials:   update requested (secret values hidden)")


def required_env(path: Path, keys: set[str]) -> dict[str, str]:
    if not path.is_file():
        raise InstallerError(f"missing configuration: {path}")
    values = read_env(path)
    missing = sorted(key for key in keys if not values.get(key))
    if missing:
        raise InstallerError(f"{path} is missing required values: {', '.join(missing)}")
    return values


def check_installation(skip_herdr: bool = False) -> None:
    check_prerequisites(require_agents=not skip_herdr)
    tracker = required_env(TRACKER_ROOT / ".env", {"HOST", "PORT", "TICKETS_ROOT"})
    supervisor = required_env(SUPERVISOR_ROOT / ".env", {
        "TRACKER_URL", "CALLBACK_BASE_URL", "SUPERVISOR_ID", "SUPERVISOR_HOST", "PROJECT_ROOT",
        "ASSIGNMENT_ROOT", "HERDR_SESSION", "HERDR_EXECUTABLE", "PROVIDERS",
    })
    for value in (tracker["TICKETS_ROOT"], supervisor["PROJECT_ROOT"], supervisor["ASSIGNMENT_ROOT"]):
        if not Path(value).is_dir():
            raise InstallerError(f"configured directory does not exist: {value}")
    expected = [
        TRACKER_ROOT / "node_modules" / ".package-lock.json",
        TRACKER_ROOT / "dist" / "server" / "index.js",
        TRACKER_ROOT / "dist" / "client" / "index.html",
        SUPERVISOR_ROOT / "node_modules" / ".package-lock.json",
        SUPERVISOR_ROOT / "dist" / "index.js",
    ]
    missing = [str(path) for path in expected if not path.exists()]
    if missing:
        raise InstallerError("installation is incomplete; missing:\n  " + "\n  ".join(missing))
    if not skip_herdr:
        executable = Path(supervisor["HERDR_EXECUTABLE"])
        run(
            [sys.executable, str(HERDR_ROOT / "install.py"), "--check", "--bin-dir", str(executable.parent)],
            environment=agent_environment(),
        )
    print("Tracker, supervisor, environment files, data directories, and Herdr are ready.")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="use existing values or portable defaults without prompting")
    parser.add_argument("--check", action="store_true", help="verify the installation without changing it")
    parser.add_argument("--dry-run", action="store_true", help="show the resolved plan without changing anything")
    parser.add_argument("--skip-herdr", action="store_true", help="do not validate or install Herdr and its integrations")
    parser.add_argument("--skip-build", action="store_true", help="do not install Node dependencies or build the services")
    parser.add_argument("--force", action="store_true", help="reinstall dependencies, rebuild, and reinstall Herdr")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.check:
        check_installation(args.skip_herdr)
        return 0
    if not args.yes and not sys.stdin.isatty():
        raise InstallerError("interactive input is unavailable; rerun with --yes or --check")
    check_prerequisites(require_agents=not args.skip_herdr)
    settings = collect_settings(args.yes)
    print_plan(settings, args.skip_build, args.skip_herdr)
    if args.dry_run:
        print("Dry run complete; no changes made.")
        return 0
    if not args.yes and not prompt_yes_no("Apply this plan?", True):
        print("Cancelled; no changes made.")
        return 0

    if not args.skip_build:
        prepare_node_project(TRACKER_ROOT, [TRACKER_ROOT / "dist" / "server" / "index.js", TRACKER_ROOT / "dist" / "client" / "index.html"], args.force)
        prepare_node_project(SUPERVISOR_ROOT, [SUPERVISOR_ROOT / "dist" / "index.js"], args.force)
    if not args.skip_herdr:
        ensure_herdr(settings.herdr_executable, args.force)

    for directory in (settings.tickets_root, settings.project_root, settings.assignment_root):
        directory.mkdir(parents=True, exist_ok=True)
    tracker_changed = update_env(TRACKER_ROOT / ".env", TRACKER_ROOT / ".env.example", tracker_env_values(settings))
    supervisor_changed = update_env(SUPERVISOR_ROOT / ".env", SUPERVISOR_ROOT / ".env.example", supervisor_env_values(settings))
    print(f"tracker/.env: {'updated' if tracker_changed else 'unchanged'}")
    print(f"supervisor/.env: {'updated' if supervisor_changed else 'unchanged'}")
    print("\nInstallation complete. Start the services in separate terminals:")
    print(f"  {TRACKER_ROOT / 'run.sh'}")
    print(f"  {SUPERVISOR_ROOT / 'run.sh'}")
    print(f"Then open {settings.tracker_url} and start or attach to Herdr session {settings.herdr_session!r}.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InstallerError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
