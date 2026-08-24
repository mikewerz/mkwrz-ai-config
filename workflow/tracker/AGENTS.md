# Agent instructions

## Cross-surface workflow contract

Workflow behavior is implemented across the tracker, supervisor, documentation, external-agent skill, and system tests. Keep those surfaces consistent whenever a change affects the workflow schema, node execution, assignment bundles, callbacks, ticket lifecycle, operator controls, artifacts, or workflow metrics.

Before finishing such a change, explicitly audit and update as applicable:

- `docs/workflow-and-prompt-authoring.md` and any affected README/specification.
- `skills/agentic-project-tracker/SKILL.md`, `references/commands.md`, `scripts/tracker.py`, and its tests. Keep this client allowlisted; do not add a generic HTTP command.
- The workflow editor, previews, and default workflows when the feature is authorable by operators.
- `../supervisor` when execution or assignment delivery changes.
- `../system-tests` when behavior crosses process boundaries or changes an operator-visible lifecycle. System tests must remain fail-closed and must never start a real agent provider.

Do not make unrelated mechanical edits merely to touch every surface. In the final handoff, state which surfaces were audited, which changed, and why any listed surface did not require a change.

Run the relevant tracker tests plus the bundled skill validator/client tests. Run supervisor and system tests when their contracts are affected.
