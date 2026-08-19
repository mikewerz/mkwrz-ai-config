# Workflow and Prompt Authoring Guide

This guide is for a person or an assisting LLM configuring Agentic Project Tracker around a real software-delivery process. It describes the implemented V3 workflow language, the data that crosses node boundaries, and how to write reusable agent prompts that remain reliable through long sessions and context compaction.

The governing principle is:

> The tracker coordinates durable work boundaries; full-capability agents decide how to perform the work inside an agent node.

A good workflow makes decisions, gates, deterministic automation, and recovery paths explicit. It does not turn an agent's internal development process into dozens of scheduler nodes.

## Start with the process, not the graph

Before writing YAML, ask the operator to identify:

- Which durable artifacts must exist, such as a specification, pull request, deployment, test report, or release ticket.
- Which decisions require a human and what choices that human should see.
- Which operations are deterministic enough to be scripts and which require repository-aware judgment.
- Which roles must be independent. A reviewer should normally use a different conversation and agent from the implementer.
- Which failures require cleanup, rollback, retry, or human recovery.
- Which parts are optional per ticket.
- Which data must survive between nodes, and whether it belongs in a repository artifact, workflow metadata, a transition handoff, or a Script output log.
- Which loops are legitimate and how many visits or transitions are safe.
- Which outcomes should count as success, failure, or neither in metrics.

Draw the desired flow in plain language first. Every arrow should answer two questions: **what observable result selects this arrow, and what context does the destination need?**

## The execution model

A published workflow is an immutable, revisioned graph. A ticket pins the workflow revision, prompt revisions, and resolved agent profiles when it starts. Later library edits affect new tickets, not work already in flight.

At runtime:

1. The ticket's current node is authoritative.
2. A node produces a declared outcome or automatic route.
3. The tracker records a durable node run and transition context.
4. The destination receives the relevant summary, handoff, output, and output-log reference.
5. The graph continues until a terminal node is reached or the ticket needs human attention.

The old coarse `phase` values—`specification`, `implementation`, `review`, and `done`—are UI and storage projections. They do not define the actual process. Node IDs, stages, edges, conversation keys, and resolved agent profiles are authoritative.

Herdr lifecycle state is observational. A pane becoming idle or done never advances a workflow. An agent node advances only through its lease-fenced callback.

## Choose the right data channel

Do not force all state through prompt text. Use the narrowest durable channel that matches the data.

| Need | Use | Notes |
| --- | --- | --- |
| Per-ticket choice made before work starts | Workflow input | Boolean, select, or text. Inputs drive node conditions and dynamic Script paths. |
| Small mutable machine-readable state | Workflow metadata | JSON values, up to the 64 KiB ticket metadata limit. Read and write through callbacks or Read/Write nodes. |
| Durable work product | Repository file, PR, deployment, or external system | Specifications, code, reports, collections, and release records should not live only in a callback. |
| Durable audit of what a node accomplished | Completion `summary` | Concise result and evidence. Retained on the node run. |
| Actionable context for the immediate next node | Completion `handoff` | Repairs, risks, decisions, and next actions. Do not repeat the whole ticket. |
| A small amount of Script stdout needed immediately | `prompt_tail_lines` | Adds the final configured number of stdout lines to the next transition. |
| Full Script stdout | `persist_stdout` | Stores a bounded external run artifact and passes its tracker URL onward. |
| Human decision or missing requirement | Question or Human Gate | Questions pause an active agent conversation; gates expose declared operator choices. |

Workflow metadata keys may contain dots, but they are literal keys, not nested-path expressions. Read routing uses exact JSON equality. Large payloads and authoritative artifacts belong outside ticket frontmatter.

## Workflow document anatomy

A workflow is stored as YAML beneath the configured `workflows/` library. The editor can create a new workflow, clone an existing workflow, validate it, display the graph, and publish a content-addressed revision.

The V3 product currently uses workflow schema `version: 2`; these are different version axes. Use `version: 2` until the implemented workflow schema changes.

```yaml
version: 2
id: api-delivery
name: API delivery
description: Specify, implement, review, optionally deploy, and obtain approval.
start: specification
max_transitions: 80

inputs:
  - id: deploy-nonprod
    label: Deploy to non-production
    type: boolean
    default: true

stages:
  - id: design
    name: Design
    phase: specification
    skippable: true
    default_enabled: true
    bypass_to: implementation
  - id: development
    name: Development
    phase: implementation
    skippable: false
    default_enabled: true
  - id: review
    name: Independent review
    phase: review
    skippable: false
    default_enabled: true
  - id: validation
    name: Non-production validation
    phase: implementation
    skippable: false
    default_enabled: true
  - id: approval
    name: Human approval
    phase: review
    skippable: false
    default_enabled: true
  - id: terminal
    name: Finished
    phase: done
    skippable: false
    default_enabled: true

nodes:
  - id: specification
    name: Write specification
    type: agent
    phase: specification
    stage: design
    prompt: specification
    agent_profile: work-default
    conversation_key: work
    max_visits: 10
    pull_request_requirement:
      scope: primary
      phase: specification
    outcomes:
      - id: completed
        label: Specification ready
        description: The specification is pushed and ready for human review.
        target: specification-approval
        metric_class: success

  - id: specification-approval
    name: Approve specification
    type: human_gate
    phase: specification
    stage: design
    max_visits: 10
    github_watch:
      pull_request_phase: specification
      feedback_outcome: changes_requested
    choices:
      - id: approved
        label: Approve
        description: Continue to implementation.
        target: implementation
        metric_class: success
      - id: changes_requested
        label: Request changes
        description: Return feedback to the specification agent.
        target: specification
        comment_required: true
        metric_class: neutral

  - id: implementation
    name: Implement and verify
    type: agent
    phase: implementation
    stage: development
    prompt: implementation
    agent_profile: work-default
    conversation_key: work
    max_visits: 20
    pull_request_requirement:
      scope: any
      phase: implementation
    outcomes:
      - id: completed
        label: Implementation ready
        description: The change is implemented, verified, and pushed to a PR.
        target: independent-review
        metric_class: success
      - id: failed
        label: Implementation failed
        description: Work cannot continue without recovery outside this node.
        target: failed
        metric_class: failure

  - id: independent-review
    name: Independent review
    type: agent
    phase: review
    stage: review
    prompt: review
    agent_profile: review-default
    conversation_key: review
    max_visits: 20
    outcomes:
      - id: approved
        label: Approve implementation
        description: No blocking review findings remain.
        target: deploy-nonprod
        metric_class: success
      - id: changes_requested
        label: Request changes
        description: Blocking findings were recorded on the PR.
        target: implementation
        metric_class: failure

  - id: deploy-nonprod
    name: Deploy to non-production
    type: script
    phase: implementation
    stage: validation
    when:
      input: deploy-nonprod
      equals: true
    otherwise: final-approval
    repository: primary
    script_file:
      relative_to: selected_repository
      path: .agents/actions/deploy-nonprod.sh
    working_directory:
      relative_to: selected_repository
      path: .
    script_output:
      persist_stdout: true
      prompt_tail_lines: 30
    exit_codes:
      - id: deployed
        label: Deployment succeeded
        description: The deployment command exited successfully.
        target: final-approval
        codes: [0]
        metric_class: success
      - id: deployment_failed
        label: Deployment failed
        description: The command failed, timed out, or could not execute.
        target: failed
        default: true
        metric_class: failure

  - id: final-approval
    name: Approve pull request
    type: human_gate
    phase: review
    stage: approval
    choices:
      - id: approved
        label: Approve
        description: The change is approved for completion.
        target: done
        metric_class: success
      - id: changes_requested
        label: Request changes
        description: Return comments to the implementation conversation.
        target: implementation
        comment_required: true
        metric_class: neutral

  - id: done
    name: Done
    type: terminal
    phase: done
    stage: terminal
    terminal_status: completed
    status_code: 0
    github_watch:
      pull_request_phase: implementation
      feedback_target: implementation

  - id: failed
    name: Failed
    type: terminal
    phase: done
    stage: terminal
    terminal_status: failed
    status_code: 1
```

This example deliberately uses broad nodes. The implementation agent owns its internal planning, editing, testing, and PR mechanics. Those activities do not need separate workflow nodes unless the organization requires an externally visible boundary.

### IDs and graph limits

- Artifact, input, stage, node, prompt, and profile IDs start with a lowercase letter and contain lowercase letters, numbers, or hyphens. They are at most 64 characters.
- Outcome IDs additionally allow underscores because they are callback-facing contract values.
- Every non-terminal route target must exist, and every node must be reachable from `start` through normal, conditional, stage-bypass, or GitHub-follow-up edges.
- `max_transitions` bounds the entire ticket graph. `max_visits` bounds repeat visits to an individual node. Use both for loops.
- A node's `phase` must match its stage's phase. A terminal node must use `done`; a non-terminal node cannot use `done`.
- A terminal node has no outgoing workflow routes, other than an optional completed-ticket GitHub feedback target.

## Inputs, stages, conditions, and loops

### Workflow inputs

Inputs configure a ticket before it starts:

- `boolean` has a Boolean default.
- `select` has a string default and an `options` list of `{value, label}`.
- `text` has a string default.

A node may use one exact condition:

```yaml
when:
  input: deploy-nonprod
  equals: true
otherwise: final-approval
```

The node runs when the value matches; otherwise the engine bypasses it to `otherwise`. This is intentionally not a general expression language. Use a Read node for branches based on mutable metadata, or an agent node when the decision requires judgment.

### Stages

Stages group nodes for the operator and let a ticket disable a whole optional section. A skippable stage requires `bypass_to`; a required stage must not define it. When a disabled stage is reached, the engine records a bypass and moves to the configured target.

Use a stage when the operator should enable or disable a meaningful block, such as specification or review. Use `when` for a ticket input that controls one node. Do not use an agent outcome named `skipped`; skip and bypass are workflow actions owned by the engine.

### Loops

A loop is simply an explicit edge to an earlier node:

```yaml
- id: changes_requested
  label: Request changes
  description: Blocking findings must be repaired.
  target: implementation
```

Use the same `conversation_key` when returning to an agent that should remember its earlier work. Set realistic `max_visits` and `max_transitions`, and ensure there is a human or terminal escape path. Avoid automatic loops that can repeat without new evidence.

## Node reference

Every node has `id`, `name`, `type`, `phase`, and `stage`. Most looping nodes should also set `max_visits`. Only fields relevant to the node's type should be configured.

### Agent

An Agent node delegates an ambiguous, repository-aware objective to a full-capability agent.

Required contract:

- `prompt`: reusable prompt artifact ID.
- `agent_profile`: preferred profile alias that resolves provider, model, and reasoning. Legacy `provider` selectors remain readable but are less expressive.
- `conversation_key`: stable conversation identity within the ticket.
- `outcomes`: one or more exact completion outcomes.

Optional behavior:

- `pull_request_requirement` requires a reported PR before completion. Its `scope` is `primary` or `any`, and its `phase` selects the PR association.
- `max_visits` bounds feedback and repair loops.

Input to the agent includes the durable ticket, current node instructions, incoming transition, repository and PR context, callback schemas, and live updates. The supervisor writes this material to a durable assignment directory and sends Herdr a small bootstrap pointing to `START_HERE.md` and the generated `callback` helper.

The agent produces progress comments, questions, metadata updates, or one terminal callback:

- `complete` selects an exact declared outcome and records a summary, optional handoff, and PR references.
- `ask` pauses for human answers and later resumes the same conversation.
- `fail` records an inability to continue. If the node declares an outcome with ID `failed`, failure follows that edge; otherwise the ticket becomes failed in place.

Use `ask` for consequential unknowns a human can resolve. Use `fail` for an unrecoverable node failure. If cleanup or rollback is required after failure, declare a `failed` route explicitly.

### Script

A Script node performs deterministic mechanics on the supervisor. It supports either a repository-owned script file or trusted inline `shell`, `python`, or `javascript` code, never both.

```yaml
type: script
repository: primary
script_file:
  relative_to: selected_repository
  path: .agents/actions/verify.sh
working_directory:
  relative_to: selected_repository
  path: .
script_output:
  persist_stdout: true
  prompt_tail_lines: 20
exit_codes:
  - id: passed
    label: Passed
    description: Verification exited with code zero.
    target: approval
    codes: [0]
    metric_class: success
  - id: failed
    label: Failed
    description: Any other result requires attention.
    target: recovery
    default: true
    metric_class: failure
```

Path references use one base:

- `selected_repository`: the repository selected by `repository`.
- `primary_repository`: the ticket's primary repository.
- `project_root`: the supervisor's configured project root.

Use either a static relative `path` or a text/select workflow `path_input`. Absolute paths and parent traversal are rejected. `working_directory` is independent from `script_file`, so state both even when they share a base.

Scripts receive a JSON context, repositories, PRs, ticket/workflow/node identifiers, repository paths, branches, SHAs, Script path, and working directory through documented `AGENTIC_*` environment variables. Script files also receive stable CLI flags. The Script editor's language samples enumerate the supported environment variables; the supervisor README is the authoritative exhaustive execution contract.

Routing is based only on the process exit code:

- Code `0` must have an explicit route.
- Other codes may be grouped into declared routes.
- Exactly one `default: true` route handles all remaining codes, timeout, signal, missing runtime or file, and execution errors.
- Stdout and stderr are never parsed to select a branch.

`persist_stdout` stores bounded stdout outside the Markdown ticket and passes a tracker URL into the next transition. `prompt_tail_lines` passes the final zero to 500 stdout lines directly. Use stdout for downstream context, not secret material. Make retryable scripts idempotent.

Use Script for a stable command with objective exit semantics. Use Agent when the work requires discovering a repository's conventions, interpreting a test report, navigating an unclear deployment, or deciding what action is appropriate.

### Human Gate

A Human Gate pauses the workflow and presents declared `choices` in the UI. Each choice has an ID, label, description, target, optional `comment_required`, and optional metric classification.

The operator's selection becomes the transition outcome. A required comment becomes actionable feedback to the destination. Labels should read as decisions—“Approve”, “Request changes”, “Abort deployment”—and descriptions should explain the consequence.

A gate may observe associated GitHub PRs:

```yaml
github_watch:
  pull_request_phase: specification
  feedback_outcome: changes_requested
```

Only newly observed feedback triggers the configured choice; durable cursors prevent the same comment from causing an endless loop.

### Read

A Read node branches on one workflow metadata value using exact JSON equality:

```yaml
- id: inspect-deployment
  name: Inspect deployment result
  type: read
  phase: implementation
  stage: validation
  metadata_key: deployment.result
  metadata_cases:
    - id: healthy
      label: Healthy
      description: The stored value is exactly "healthy".
      equals: healthy
      target: approval
      metric_class: success
    - id: unhealthy
      label: Needs rollback
      description: Any other or missing value requires rollback.
      default: true
      target: rollback
      metric_class: failure
```

Exactly one case is the default and has no `equals`. Equality compares the complete JSON value; it does not support ranges, predicates, or nested paths. Read nodes settle automatically without a supervisor lease.

### Write

A Write node stores one static JSON value and continues through `next`:

```yaml
- id: mark-deployed
  name: Record deployment
  type: write
  phase: implementation
  stage: validation
  metadata_key: deployment.state
  metadata_value: awaiting-approval
  next: approval
```

Write nodes are useful for flags, counters represented by externally computed values, or state labels. They do not evaluate templates or increment values. Agents and callback-aware tools can read and write dynamic metadata through the lease callback endpoints.

### Nested Workflow

A Workflow node invokes a published workflow as a child and routes on the child's terminal status code:

```yaml
- id: release-subflow
  name: Run release process
  type: workflow
  phase: implementation
  stage: release
  workflow_id: standard-release
  status_codes:
    - id: released
      label: Released
      description: Child workflow returned zero.
      codes: [0]
      target: done
      metric_class: success
    - id: release_failed
      label: Release failed
      description: Any other child status requires recovery.
      default: true
      target: recovery
      metric_class: failure
```

The child revision is pinned when invoked. A completed terminal defaults to status code `0`; failed or cancelled terminals default to `1`, unless `status_code` is explicitly set. Calls cannot recurse into the same workflow, and nesting is bounded. The child's final transition context is carried back to the parent.

Use a nested workflow for a reusable process boundary with meaningful completion codes. Do not use it merely to avoid placing several related nodes in one readable graph.

### Fan Out and Fan In

A Fan Out sends the same incoming context into multiple branches. Every branch must eventually reach the named Fan In.

```yaml
- id: validation-fan-out
  name: Run validation branches
  type: fan_out
  phase: implementation
  stage: validation
  fan_in: merge-validation
  branches:
    - id: api
      label: API checks
      description: Validate the API contract.
      target: api-validation
    - id: ui
      label: UI checks
      description: Validate the operator UI.
      target: ui-validation

- id: merge-validation
  name: Merge validation results
  type: fan_in
  phase: implementation
  stage: validation
  next: approval
```

In V3 the branches execute **sequentially**, not concurrently, under the ticket's supervisor affinity. Fan In waits for every declared branch, then combines branch summaries, handoffs, configured outputs, and output-log references for the next node. Use this construct for graph semantics and merged evidence, not to obtain parallel compute.

### Terminal

A Terminal node ends the current workflow with `terminal_status: completed | failed | cancelled` and an optional `status_code` from 0 through 255. The status code is most important when another workflow invokes this one.

A completed top-level terminal can observe PR feedback and explicitly reopen work:

```yaml
github_watch:
  pull_request_phase: all
  feedback_target: implementation
```

The target must be a non-terminal node. This makes completed-ticket repair explicit instead of relying on a magic node ID.

## Outcomes are contracts, not destination names

Outcome IDs are the exact values an agent, script result, human choice, metadata match, or child status selects. Choose stable semantic IDs such as `approved`, `changes_requested`, `validated`, `rollback_required`, or `release_created`.

For every route:

- `label` is concise UI text.
- `description` states the observable condition under which the route is correct.
- `target` says where the workflow goes next.
- `metric_class` says how the result should be counted: `success`, `failure`, or `neutral`.

Metric classification does not alter control flow. Classify a route by what it says about the node's result, not whether its destination is terminal. Human requests for normal iteration are often neutral; a failed verification is failure; successful completion is success. Unclassified routes do not contribute to node success-rate calculations.

Do not ask agents to return destination node IDs. The tracker already maps an outcome to its target.

## Agent profiles and conversations

Agent profiles are reusable aliases configured in the tracker. A profile resolves to a provider, exact model when supported, and reasoning setting. Examples might be `work-default`, `fast-review`, or `release-agent`.

Use profiles instead of embedding provider/model choices in prompts. Profiles make an organizational policy swappable while each running ticket remains reproducible because its resolution is pinned.

Conversation keys control continuity:

- Give specification and implementation the same key when the same agent should retain the ticket conversation.
- Give independent review a different key.
- Reuse the implementation key for repair loops.
- Nodes sharing one key must use a compatible profile/provider selector.

The profile selects the harness; the prompt selects the role. Do not rely on the model name to imply review independence or merge authority.

## GitHub and PR design

PR behavior is explicit in the workflow:

- Use `pull_request_requirement` on an Agent node when that node cannot complete without reporting a PR.
- Use `github_watch.feedback_outcome` on a Human Gate when new PR feedback should select one of the gate's choices.
- Use `github_watch.feedback_target` on a completed Terminal when post-completion PR feedback should reopen a particular repair node.
- Choose `pull_request_phase` to select specification, implementation, review, or all associated PRs.

The watcher observes new actionable feedback and merge conflicts using persisted cursors. It does not merge PRs. Merge authority should belong to a dedicated agent prompt/node whose instructions explicitly state the required approvals and conditions.

## How agent assignments are delivered

The reusable prompt is only one part of an assignment. For every agent-node run, the supervisor creates a directory resembling:

```text
<assignment-root>/<supervisor-id>/tickets/<ticket-id>/runs/<attempt>-<node-id>-<run-id>/
```

It contains:

- `START_HERE.md`: recovery entry point and map of the assignment.
- `ticket.md`: authoritative ticket snapshot.
- `node.md`: rendered reusable node prompt.
- `incoming.md`: prior outcome, summary, handoff, Script output tail, and log references.
- `context.json`: structured ticket, workflow, repository, PR, metadata, and callback context.
- `callbacks.md` and `callbacks.json`: callback contract.
- `callback`: executable lease-aware helper.
- `updates/`: ordered live guidance, answers, and refreshed-ticket notifications.
- `outbox/`: local callback request/response records.

The files are an assignment snapshot. Agents are told to treat them as read-only; editing them is not a durable tracker update. The exact current paths are repeated in live guidance and the single idle callback reminder, so an agent can recover after context compaction.

The helper is the authoritative callback interface. An agent can run commands such as:

```sh
/absolute/path/to/callback schema complete
printf '%s\n' '{"outcome":"completed","summary":"Implemented and verified the change."}' \
  | /absolute/path/to/callback complete -
```

An authoring prompt should not duplicate the full HTTP schema. `START_HERE.md`, `callbacks.md`, and `callback schema ...` remain current even if a long conversation compacts away the initial bootstrap.

## Writing good reusable prompts

A reusable prompt should define the **role and completion judgment for one agent node**. The assignment bundle already supplies the ticket, repositories, incoming context, allowed outcomes, callback instructions, and live updates.

### Recommended structure

```markdown
# Objective

Produce an implementation that satisfies the ticket and leaves its pull request ready for independent review.

# Responsibilities

- Reconcile the ticket with the current repository and PR state.
- Work from the repository's default branch and pull current remote changes before creating or updating the task branch.
- Implement the smallest coherent change and follow repository-local instructions.
- Run the repository's documented verification, including `.agents/scripts/verify.sh` when present.
- Push the task branch and report every relevant PR through the completion callback.

# Boundaries

- Do not merge the PR from this node.
- Ask focused questions when a consequential requirement cannot be inferred safely.
- Do not treat Herdr idle state, a progress comment, or locally edited assignment files as completion.

# Outcomes

Choose `completed` only when the implementation is pushed, required verification has passed, and required PRs are reported.
Choose `failed` only when the node cannot proceed and the declared recovery route should run.

# Handoff

In the summary, record what changed and the evidence used to verify it. Use the handoff only for information the next reviewer needs, such as intentional tradeoffs, residual risks, or areas requiring special attention.
```

This structure is guidance, not a required template. Keep it short enough that the agent can identify its actual obligation immediately.

### State the outcome evidence

The prompt and workflow outcome description should agree. Replace vague instructions such as “finish the work” with observable completion evidence:

- The specification exists in the primary repository and its draft PR is reported.
- Required tests pass, or any allowed exception is documented.
- Review comments are placed on the PR and the review outcome reflects blocking findings.
- Deployment health and regression checks were observed before selecting `validated`.
- A merge occurred only after the prompt's explicit approval preconditions were satisfied.

Do not prescribe a rigid sequence for ordinary engineering judgment. If a sequence must be deterministic and auditable, it probably belongs in a Script node or a human gate.

### Design questions deliberately

Agents can submit one question or a batch, with any number of suggested options. The UI always permits a freeform answer.

Good questions:

- Resolve a decision that materially changes behavior, compatibility, cost, or risk.
- Group related decisions so the operator does not endure a long question-answer loop.
- Offer useful options without implying the list is exhaustive.
- Explain the default the agent would otherwise choose.

Do not ask for facts already available in the ticket, repository, PR, assignment bundle, or normal development tools. An agent should continue after non-blocking uncertainty and record its assumption.

### Use summary and handoff differently

`summary` is the durable audit record for the completed node. It should say:

- What was produced or changed.
- What important decision was made.
- What verification or evidence supports completion.
- Which durable artifacts or PRs matter.

`handoff` is short, next-node-oriented context. Use it for requested repairs, a reviewer focus area, a deployment identifier, a rollback concern, or an unresolved non-blocker. Omit it when the next node needs nothing beyond the ticket and artifacts.

The destination should reconcile incoming context with current repository, PR, and external state. A handoff is evidence, not unquestionable truth.

### Preserve autonomy and role separation

Prompts should assume agents retain normal tools, credentials, computer access, planning, and subagents. Describe the boundary and evidence, not a simulated reduced toolset.

Keep roles clean:

- A specification agent clarifies and writes the plan; it does not pre-implement to manufacture certainty.
- An implementation agent repairs its own code after review feedback.
- An independent reviewer reports findings and comments on PRs; it should not silently become the implementer.
- A merge agent may merge only when its prompt explicitly authorizes it and all stated gates are satisfied.
- A deployment or release agent should record enough evidence for downstream validation and rollback.

### Keep prompts reusable

Split prompts when nodes have different authority, artifacts, evidence, or role. Reuse a prompt when those contracts are genuinely the same across workflows.

Avoid embedding:

- A specific provider, model, or reasoning level. Use an agent profile.
- Ticket-specific prose. Put that in the ticket.
- Destination node IDs. Use semantic outcomes.
- Full callback JSON schemas. Use the generated helper.
- Large previous outputs. Use incoming output tails and log URLs.
- Secrets or environment-specific credentials.
- Workflow-wide instructions irrelevant to the current node.

Supported `{{meta_tags}}` are shown by the Prompt Editor and validated per prompt type. Common node tags include ticket and project-root context, node identity, allowed outcomes, and incoming outcome/summary/handoff/output/log references. Arbitrary workflow metadata is not interpolated as a tag; read it from `context.json` or through the callback helper.

Always use Preview after editing a prompt. The preview renders a dummy assignment bootstrap and `node.md`, showing what is supplied by the platform versus the reusable artifact.

## Prompt patterns by role

### Specification

- Inspect the ticket, relevant repositories, existing conventions, and prior PR feedback.
- Ask consequential questions, preferably in a batch.
- Produce the spec as a durable repository artifact and report its PR when required.
- Define behavior, interfaces, migration, verification, risks, and unresolved choices without over-constraining implementation details.
- On a feedback loop, update the existing artifact and conversation rather than restarting.

### Implementation

- Start from the repository's current default branch, pull, and then create or restore the ticket branch.
- Reconcile prior work and feedback before editing.
- Follow repository-local instructions and verification commands.
- Push work and report PRs; do not merely summarize local changes.
- On review loops, repair the implementation in the existing work conversation.

### Independent review

- Inspect the actual diff, surrounding code, tests, and claimed verification.
- Focus on correctness, regressions, security, operability, and missing tests according to repository standards.
- Put actionable findings on the PR.
- Select `changes_requested` for blocking findings and `approved` only when none remain.
- Do not implement repairs from the review node unless that workflow intentionally combines roles.

### Deployment, validation, merge, and release

- State the authorized environment and the evidence required before success.
- State whether a human may need to approve an external operation.
- Make rollback expectations and failure outcomes explicit.
- For merge, enumerate required approvals, checks, branch state, and allowed merge method.
- For release creation, identify the external artifact and metadata that must be recorded for downstream nodes.

## Common design mistakes

- **Making every agent action a node.** Nodes are durable organizational boundaries, not the agent's internal checklist.
- **Using magic outcome strings.** Declare every outcome in the node and describe its evidence.
- **Routing a Script from prose.** Script routing uses exit codes only.
- **Omitting failure cleanup.** If an agent failure must roll back or recover, declare a `failed` outcome and route.
- **Treating stages as the execution engine.** Nodes and edges are authoritative; stages group and optionally bypass them.
- **Expecting Fan Out to run concurrently.** Current branches are sequential.
- **Using metadata as a document store.** Keep it small and machine-readable.
- **Using one conversation for implementer and reviewer.** Independent roles need different conversation keys and normally different profiles.
- **Renaming a node and assuming PR rules follow it.** PR requirements and GitHub feedback targets are explicit node configuration.
- **Forgetting loop bounds.** Every repair or polling loop needs visit and transition limits.
- **Assuming `fail` selects any failure-like route.** Automatic failure routing uses the exact outcome ID `failed`; otherwise the ticket fails in place.
- **Letting prompt and graph disagree.** The allowed outcomes and their descriptions are the durable contract.
- **Putting critical instructions only in the initial Herdr message.** The durable bundle and callback helper are the recovery source.

## Review checklist for an assisting LLM

Before recommending publication, verify:

### Process fidelity

- Every required artifact, decision, role boundary, and external side effect has an owner.
- Ambiguous engineering work stays in broad Agent nodes.
- Deterministic commands use Script nodes with objective exit codes.
- Human gates expose all meaningful choices and require comments where feedback is needed.
- Failure, rollback, cancellation, and repair paths are explicit.

### Graph correctness

- All IDs are valid and unique.
- Every target exists and every node is reachable.
- Node phase matches stage phase; only terminals use `done`.
- Optional stages have a valid bypass outside the stage.
- Conditional nodes have a valid `otherwise` route.
- Every loop has sensible `max_visits` and the graph has a sensible `max_transitions`.
- Fan Out branches all reach the declared Fan In.
- Nested workflow status codes have one default route.
- Script exit codes include explicit zero and exactly one default route.

### Runtime context

- Ticket inputs, mutable metadata, summaries, handoffs, repository artifacts, and Script logs are used for the right kinds of data.
- Conversation keys preserve desired continuity without compromising independent review.
- Agent profiles express provider/model/reasoning policy without hard-coding it into prompts.
- PR requirements and GitHub feedback routing are explicit.

### Prompt quality

- Each prompt states role, objective, authority, evidence, outcomes, and handoff expectations.
- It does not duplicate the generated callback contract or giant ticket context.
- It tells the agent when to ask, complete, or fail.
- It preserves normal agent tools and judgment.
- Merge, deploy, rollback, and other consequential actions have explicit authorization conditions.
- Previewed output is clear when read as `node.md` beside `START_HERE.md`.

### Publication

- The workflow validates in the editor with the referenced prompts, profiles, and child workflows present.
- The graph display matches the intended paths, including bypass, feedback, and recovery edges.
- A representative ticket can supply every required input, repository, stage selection, and profile.
- The first rollout uses conservative loop limits and observable outcomes so metrics reveal where refinement is needed.

When helping a user, explain assumptions and tradeoffs before producing YAML. Prefer a small first workflow that captures real organizational boundaries, then add nodes only when operational evidence shows that a new durable boundary is valuable.
