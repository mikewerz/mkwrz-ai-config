# Agent instructions

## Cross-surface workflow contract

The supervisor executes the tracker's published workflow contract; it does not own a separate workflow model. When changing Herdr interaction, claims or callbacks, assignment bundles, live updates, Script execution, artifacts, checkpoints, telemetry, conversations, retries, or provider startup behavior, keep every affected contract surface synchronized.

Before finishing, explicitly audit and update as applicable:

- `README.md` and `../tracker/docs/workflow-and-prompt-authoring.md`.
- Tracker workflow schema, editor, default workflows, and API behavior when the supervisor contract changed.
- `../tracker/skills/agentic-project-tracker/`, including its allowlisted client and tests, when outside agents need to inspect or operate the changed ticket behavior.
- `../system-tests` for tracker/supervisor behavior across process boundaries. Tests must use fake Herdr, clear real provider credentials, and never start a real agent.

Do not update a surface when the change is genuinely internal and its public contract is unchanged. In the final handoff, state which surfaces were audited, which changed, and why any listed surface did not require a change.

Run the supervisor verification suite and the relevant tracker, skill, and system tests for every affected cross-repository contract.
