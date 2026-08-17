# Herdr Setup

This directory installs a pinned Herdr binary and Herdr's official Claude Code and Codex integrations for the user who runs the workflow supervisor.

It deliberately does not install or wrap the agents themselves. It does not change their tools, permissions, credentials, prompts, models, or reasoning behavior. The normal Claude Code and Codex installations remain independently managed.

## Install

Requirements:

- Linux or macOS on x86-64 or ARM64
- Python 3.10+
- Claude Code and Codex already initialized for the target user
- outbound HTTPS access to GitHub releases

The pinned release and official checksums are recorded in [`config/versions.json`](config/versions.json). Review the plan interactively:

```bash
python3 install.py
```

For unattended provisioning:

```bash
python3 install.py --yes
python3 install.py --check
```

The installer downloads the exact platform asset, verifies its SHA-256 digest and version before atomically replacing `~/.local/bin/herdr`, installs the official integrations with these commands, and records a receipt under `~/.local/state/agent-herdr-config/`:

```bash
herdr integration install claude
herdr integration install codex
```

Herdr's integrations add lifecycle/session reporting hooks only. Their observed states are operational hints for the supervisor; they never complete a tracker phase.

## Verify locally

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile install.py
```

After provisioning, start or attach to the named session used by the supervisor:

```bash
herdr --session agentic-projects
```

Set the same name in [`../supervisor/.env`](../supervisor/.env.example) as `HERDR_SESSION=agentic-projects`.
