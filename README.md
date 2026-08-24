# mkwrz-ai-config

Portable configuration and local tooling for AI-assisted development.

## Workflow coordinator

[`workflow/`](workflow/) contains a lightweight Markdown-backed project tracker, a Herdr-driven supervisor, a pinned Herdr installer for Claude Code and Codex, and their cross-process production test suite. It is a clean source import: the component repositories' Git history, generated files, deployment-specific Jenkinsfiles, and private-machine configuration are not included.

Start with [`workflow/README.md`](workflow/README.md).
