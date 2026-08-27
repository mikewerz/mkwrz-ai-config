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

## Put repeated discovery above workflows

Do not model “keep finding and fixing issues forever” as one looping ticket. That destroys the useful boundary for duration, cost, production outcome, workflow-revision comparison, retry, and archival. Model it with three durable layers:

1. A **campaign** names the long-lived objective and owns aggregate admission capacity, such as “improve checkout performance.”
2. One or more **sources** periodically or externally discover stable candidate facts, such as New Relic issues, Dependabot PRs, Jira queries, or a released DTO version.
3. Every admitted candidate becomes a normal ticket pinned to a normal workflow. Its workflow metrics remain one work-item sample; campaign/source metrics remain discovery and portfolio samples.

Source logic should answer only “what candidate facts exist now?” It should not allocate ticket IDs, inspect current capacity, create Markdown directly, or decide whether a duplicate observation deserves a second ticket. The tracker owns those decisions atomically.

### Campaign definition

```yaml
version: 1
id: checkout-performance
name: Checkout performance
description: Continuously find and remove measured checkout bottlenecks.
enabled: true
limits:
  max_new_per_run: 100
  max_new_per_day: 20
  max_open: 30
  max_working: 6
  max_observed_unarchived: 50
success_policy: {}
```

The open/working/unarchived limits are separate on purpose. `max_open` bounds unresolved tickets, `max_working` bounds work that has advanced past draft, and `max_observed_unarchived` bounds the operator's active observation surface even when work has completed but is still being watched for production or PR feedback.

### Scheduled Script source

```yaml
version: 1
id: new-relic-checkout
name: New Relic checkout findings
description: Discovers checkout latency and error-rate candidates.
enabled: true
campaign_id: checkout-performance
schedule:
  interval_minutes: 60
runner:
  type: supervisor_script
  language: python
  script_path: checkout-api/.agents/intake/new_relic.py
  working_directory: checkout-api
  timeout_seconds: 300
ticket:
  workflow_id: end-to-end
  repositories:
    - id: checkout-api
      primary: true
  labels: [performance, automated-intake]
  priority: 1
  mark_ready: false
  workflow_inputs: {}
  stage_enabled: {}
limits:
  max_new_per_run: 3
  max_new_per_day: 10
  max_open: 15
  max_working: 3
  max_observed_unarchived: 25
```

Both `script_path` and `working_directory` are relative to each supervisor's configured project root. This is deliberately independent from workflow Script-node path rules: a source is not a ticket node and has no selected ticket repository yet.

At runtime the supervisor exports:

- `AGENTIC_INTAKE_PROTOCOL_VERSION`
- `AGENTIC_INTAKE_MODE`, either `admit` or `preview`
- `AGENTIC_INTAKE_SOURCE_ID`, `AGENTIC_INTAKE_SOURCE_REVISION`, `AGENTIC_INTAKE_CAMPAIGN_ID`, and `AGENTIC_INTAKE_CAMPAIGN_REVISION`
- `AGENTIC_INTAKE_RUN_ID` and `AGENTIC_INTAKE_ATTEMPT`
- `AGENTIC_INTAKE_PROJECT_ROOT`
- `AGENTIC_INTAKE_CURSOR_JSON`, containing the last successfully committed source cursor or `null`
- `AGENTIC_INTAKE_SOURCE_JSON`, containing the pinned source definition
- `AGENTIC_INTAKE_RESULT_PATH`, the file the source must write

The result contract is:

```json
{
  "candidates": [
    {
      "external_key": "new-relic:issue-42",
      "title": "Reduce checkout p95 latency",
      "description": "Measured evidence, desired outcome, and acceptance criteria.",
      "repositories": [{ "id": "checkout-api", "primary": true }],
      "labels": ["performance"],
      "priority": 1,
      "metadata": { "new_relic.issue_url": "https://example.invalid/issues/42" }
    }
  ],
  "cursor": { "last_updated_at": "2026-08-20T12:00:00Z" }
}
```

Candidate overrides are optional except for `external_key`, `title`, and `description`; omitted routing fields come from the source's ticket template. Choose a key from immutable upstream identity. A candidate rediscovered with the same source/key updates observation history and links to the existing ticket. Do not include timestamps in the key unless the upstream fact is genuinely a new unit of work.

Use **Save & test discovery** or **Test** after changing a Script source. Preview mode runs the real source in a supervisor workspace and shows a bounded validation summary plus its output log. It intentionally does not admit tickets or commit the returned cursor, so the next admission run observes from the previous successful admission cursor. Source code may inspect `AGENTIC_INTAKE_MODE` when it needs cheaper preview behavior, but it must return the same candidate contract in both modes.

Preview is safe for tracker state, not a process sandbox: it does not reverse calls made by the discovery script. Keep source integrations observational and read-only, especially when `AGENTIC_INTAKE_MODE=preview`.

Use `runner.type: external` when another scheduler or agent pushes candidate batches. Ticket agents that discover necessary follow-on work should use their generated `callback emit-candidates` command with a configured source ID. This records the parent ticket and passes through the same limits. For example, a DTO release workflow can emit one candidate per downstream consumer using `dto:<domain>:<version>:<consumer>` keys; the reusable mapping logic belongs in a source or repository Script, not copied into every prompt.

Keep sources deterministic when possible. If discovery itself needs ambiguous investigation, schedule an external agent process that emits candidates, or make the admitted ticket's first workflow nodes gather and refine context. The admission boundary should still be a stable candidate fact rather than an open-ended agent conversation.

## Software-factory patterns are compositions, not new node types

Terms such as “Verifier,” “Context Engineer,” “Security Policy,” or “Release Policy” usually describe a responsibility, not a new execution primitive. Resist adding a node type merely because a factory pattern has acquired a useful name. First express it as a composition of the existing nodes.

This is consistent with several emerging agentic-engineering lessons:

- OpenAI's [harness engineering account](https://openai.com/index/harness-engineering/) emphasizes repository legibility, mechanical architectural invariants, direct access to tests and observability, and feedback loops rather than detailed orchestration of every agent action.
- Anthropic's [long-running application harness](https://www.anthropic.com/engineering/harness-design-long-running-apps) uses planner, generator, and evaluator roles with structured handoff artifacts, while warning that harness components encode assumptions that should be removed when they stop adding value.
- NIST's [Secure Software Development Framework](https://csrc.nist.gov/projects/ssdf) is outcome-based and includes verification, risk tracking, protected release artifacts, and provenance without prescribing one universal pipeline implementation.
- SLSA treats [provenance](https://slsa.dev/spec/v1.2/provenance) as verifiable information about where, when, and how an artifact was produced, then separately defines [artifact verification](https://slsa.dev/spec/v1.2/verifying-artifacts) against policy expectations.
- GitHub deployment environments support automated protection rules and [human approval gates](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), while progressive-delivery systems such as [Argo Rollouts](https://argo-rollouts.readthedocs.io/en/stable/) combine deployment actions, metric analysis, manual judgment, promotion, and rollback.

These ideas map cleanly onto a small workflow vocabulary because a factory step normally does one or more of four things:

1. **Produce evidence** through a deterministic command or an agent's repository-aware work.
2. **Judge evidence** mechanically, with model judgment, or through human authority.
3. **Route** based on a declared outcome, exit code, stored metadata value, or human choice.
4. **Preserve state** as a repository artifact, tracker artifact, metadata value, handoff, checkpoint, or external-system record.

The engine already has primitives for each responsibility. Compose them before proposing another type.

### Translating an arbitrary factory idea

Use this decision sequence when someone proposes a new named node:

1. **Can success be decided from stable commands and machine-readable evidence?** Use a Script node. Encode routing in exit codes; store detailed evidence in declared artifacts or persisted stdout.
2. **Does the work require discovering conventions, interpreting ambiguity, or producing a reasoned artifact?** Use an Agent node. Define observable outcomes and require a concise summary/handoff.
3. **Is the decision an exercise of organizational authority rather than computation?** Use a Human Gate. Do not hide approval inside an Agent outcome.
4. **Does the step only inspect a previously stored fact?** Use a Read node. If it only records a static fact, use Write.
5. **Is it a reusable multi-step process with its own terminal contract?** Use a nested Workflow node rather than inventing a compound node.
6. **Do several independent checks need to contribute evidence?** Use Fan Out and Fan In. Remember that current branches are sequential; this gives aggregation semantics, not parallel compute.
7. **Is the requirement to preserve or restore repository state?** Use Checkpoint or Restore Checkpoint. Do not confuse repository rollback with deployment rollback.
8. **Does the idea merely mark completion?** Use a Terminal node with a meaningful status and status code.

If one named concept performs several of these jobs, represent it as several nodes. A good boundary is where evidence becomes durable, authority changes, a branch is selected, or recovery becomes independently meaningful. Do not split a broad Agent node merely to expose its internal checklist.

Use the following generic shape:

```text
evidence producer -> evaluator/router -> action or human decision -> recovery or continuation
```

Examples:

```text
Script gathers facts -> Agent interprets them -> Agent implements
Script verifies -> Human Gate approves an exception -> Release Script
Deploy Script -> Health Script -> Read/Gate on stored result -> Promote or Rollback Script
Fan Out checks -> Fan In evidence -> Agent evaluator -> Repair loop or approval
```

### Common software-factory ideas using current nodes

| Factory idea | Recommended composition | Durable evidence and routing |
| --- | --- | --- |
| Context engineering | Script collection → Agent synthesis → specification or implementation Agent | Script uploads inventory/search results; synthesis Agent writes a repository context document and hands off its path. |
| Verifier or quality gate | Script for objective checks; optionally independent Agent for semantic review | Tests, linters, build output, and reports are artifacts. Script exit codes route pass/fail; Agent outcomes route judgment. |
| Planner/specification | Agent → optional Human Gate | Specification is a repository artifact/PR. Human choices approve or return feedback. |
| Generator/implementer | Agent → Script verification → independent Agent reviewer | Code and PR are authoritative; verification reports and review findings feed repair loops. |
| Change-impact or risk classifier | Script for declared diff rules → Agent for ambiguous impact → Read or Gate | Store a small risk class in metadata; keep full analysis in an artifact or repository document. |
| Architecture conformance | Script structural tests → Agent architecture review only when needed | Mechanical dependency/layer rules use exit codes; novel design judgment uses a separate conversation. |
| Security policy | Script scans → Agent triage → Human Gate for exceptions | SAST, dependency, secret, license, and SBOM reports are artifacts; policy codes distinguish pass, remediation, exception review, and hard block. |
| Release policy | Script inspects diff and release evidence → Human Gate when policy requires → release action | Exit codes represent auto-release, approval-required, or prohibited; stdout explains evidence but never selects the route. |
| Build, package, SBOM, signing, or provenance | Script nodes, often packaged as a nested Workflow | Upload immutable build outputs, checksums, SBOMs, signatures, and attestations; verify them in a later Script before release. |
| Documentation or release notes | Agent drafts → Script validates required files/format | Repository documents are durable; objective format/link checks route with exit codes. |
| Deployment readiness | Script checks branch, CI, migrations, config, approvals, and environment availability → Gate or deploy Script | Emit an evidence artifact and distinct policy exit codes. Never infer readiness from prose alone. |
| Progressive delivery | deploy Script → metric/health Script → Human Gate or automatic route → promote/rollback Script | Query user-facing signals, logs, metrics, and traces; route success, failure, and inconclusive separately. |
| Post-deploy verification | Script smoke/regression checks → Agent diagnosis when ambiguous | Persist reports and observability links. A failed check routes to rollback or repair, not directly to success. |
| Incident recovery | Agent diagnosis → Human Gate when authority is required → rollback Script | Handoff carries diagnosis and target version; Script performs the deterministic rollback and records evidence. |
| Compliance/change-management evidence | Script gathers controls → Agent prepares external record → Human Gate | Store audit packages as artifacts and record Jira/change-ticket identifiers in metadata or the handoff. |
| Dependency maintenance | Script inventories/scans → Agent updates → Script verifies → review loop | Inventory and scan reports are artifacts; implementation and verification remain separate responsibilities. |
| Multi-perspective evaluation | Fan Out to specialized Script/Agent branches → Fan In → evaluator Agent or Gate | Fan In merges summaries, handoffs, output tails, and artifact references for one decision point. |
| Reusable organizational policy | Nested Workflow | Child terminal status codes form the stable parent contract; child internals can evolve through new published revisions. |

This table is a starting point, not a requirement to use every step. Prefer the shortest composition that leaves the needed evidence and authority boundary visible.

### Context engineering as an evidence pipeline

A context-engineering step is most useful when it produces a durable, scoped artifact instead of inflating the next prompt.

A practical chain is:

```text
collect-context (Script) -> synthesize-context (Agent) -> specification/implementation (Agent)
```

The Script can deterministically collect repository maps, relevant instruction files, dependency manifests, API schemas, recent commits, ownership data, known test commands, or search results. Configure `persist_stdout` for the full bounded log, `prompt_tail_lines` for a small immediate index, and `artifacts` for structured inventories.

The synthesis Agent then:

- Reads the collected artifacts and performs additional repository-aware searching where necessary.
- Separates facts from inferences and unresolved questions.
- Writes a concise context document into an agreed repository path, such as `docs/agent-context/<ticket-id>.md`, when later nodes need a durable shared artifact.
- Completes with a summary of what was gathered and a handoff containing the document path, important constraints, and known gaps.

The downstream specification or implementation Agent receives the transition context and artifact references in its assignment bundle. Its prompt should tell it to use the context document as a starting map, then verify anything that may have changed. The context artifact improves legibility; it is not a frozen substitute for the live repository.

Do not add a Context node type unless context acquisition eventually requires engine behavior that cannot be represented by Script output, artifacts, an Agent handoff, metadata, or a nested workflow.

### Verifiers: objective checks first, judgment second

“Verifier” can mean two different things:

- A deterministic check that runs tests, builds, linters, schema validation, static analysis, architecture rules, or contract tests. This is a Script node.
- A skeptical evaluation of whether the change actually satisfies the ticket, handles edge cases, or creates unacceptable design risk. This is an independent Agent node, possibly informed by Script artifacts.

For thorough verification, compose both:

```text
verification-suite (Script) -> semantic-verifier (Agent) -> repair or approval
```

The Script should run the repository's authoritative commands and upload reports. Its zero exit code selects a mechanically verified route; nonzero or infrastructure failures select declared recovery routes. The Agent should inspect the diff, ticket, relevant code, test evidence, and reports. It must use a separate conversation from the implementer when independence matters.

Do not ask an Agent to simulate a test runner when a command exists. Do not treat a green Script as proof of semantic correctness when the encoded checks do not cover the ticket's intent.

### Release, migration, and security policy

A policy node is normally a Script that converts explicit organizational rules into stable exit codes. For example, a release-policy Script may inspect:

- Changed paths and diff size.
- Flyway or other database migrations.
- Authentication, authorization, infrastructure, dependency, or public-API changes.
- Required CI checks and review state.
- Security scan, SBOM, signature, or provenance evidence.
- The target environment and permitted release window.

One useful contract is:

```text
0  = policy permits automatic release
10 = human approval is required
20 = release is prohibited until remediation
other/default = policy could not be evaluated safely
```

The matching workflow routes might be:

```text
release-policy (Script)
  auto_release -> release (Script or Agent)
  approval_required -> release-approval (Human Gate)
  remediation_required -> implementation (Agent)
  policy_error -> operator-recovery (Human Gate or failed Terminal)
```

A non-production deployment policy can deliberately route Flyway migrations to a Human Gate or remediation path because database changes may be destructive or difficult to reverse. A security-policy Script can similarly route a vulnerable dependency to remediation, an approved exception class to a Gate, and a secret finding to a hard stop.

Write the rule in version-controlled script code. Use stdout and artifacts to explain which rule fired, but let only the exit code select the edge. This makes the decision testable, reviewable, and visible in node/branch metrics.

If risk classification itself is ambiguous, place an Agent before the policy Script. The Agent can produce a small normalized classification in workflow metadata or a repository artifact; the Script then validates that value against explicit policy. Keep final organizational authority in a Human Gate where policy requires it.

### Progressive delivery and operational evidence

Progressive delivery is another composition, not a special node:

```text
deploy-canary (Script)
  -> collect-health (Script)
  -> diagnose-inconclusive (Agent or Human Gate)
  -> promote (Script) or rollback (Script)
```

Health collection should use signals that represent user-visible behavior, not merely process liveness. OpenTelemetry's [observability model](https://opentelemetry.io/docs/concepts/observability-primer/) distinguishes logs, metrics, and traces and relates reliability to whether the service does what users expect. The health Script can query those systems, execute smoke/regression checks, and return separate codes for healthy, unhealthy, and inconclusive. Inconclusive evidence should pause for judgment rather than silently promote.

Rollback must be reachable from every failure state that can leave an environment changed. Repository Checkpoint/Restore nodes do not roll back Kubernetes, databases, feature flags, or external systems; use explicit environment rollback scripts or an external deployment controller for those effects.

Use an external system as the source of truth for long-running canary sampling, scheduled production monitoring, and event-driven work. Pair a bounded Script that checks that system with a Wait node: the Script routes `ready` onward and `not_ready` to Wait; Wait durably releases all supervisor capacity, then routes back to the checker after its interval. Its deadline must route to recovery or a human gate. Do not sleep inside a Script or consume an agent lease while waiting.

## The execution model

A published workflow is an immutable, revisioned graph. A workflow family has one active default revision and may retain multiple named trial revisions. Use **Publish as trial** while evaluating a change, then **Make default** only after its metrics justify promotion. Promotion retires the previous active default; retired history remains available behind **Show history** but is not offered for new tickets. New tickets use the default unless an operator explicitly chooses a trial; the ticket records that selection and pins the workflow revision, prompt revisions, and resolved agent profiles. Later library edits and promotions affect only future tickets, not work already in flight. The displayed `v1`, `v2`, and later numbers identify unique content rather than activation chronology, so restoring unchanged shipped content can make an earlier version the default without creating another duplicate revision.

At runtime:

1. The ticket's current node is authoritative.
2. A node produces a declared outcome or automatic route.
3. The tracker records a durable node run and transition context.
4. The destination receives the relevant summary, handoff, output, and output-log reference.
5. The graph continues until a terminal node is reached or the ticket needs human attention.

The old coarse `phase` values—`specification`, `implementation`, `review`, and `done`—are UI and storage projections. They do not define the actual process. Node IDs, stages, edges, conversation keys, and resolved agent profiles are authoritative.

Herdr lifecycle state is observational. A pane becoming idle or done never advances a workflow. An agent node advances only through its lease-fenced callback.

Agent startup and prompt submission are also outside the workflow graph. A claim remains `starting` while the supervisor waits for Herdr to report that the provider is interactively ready and launch is no longer pending, through a short stable-settle interval, and until prompt delivery is confirmed. Herdr's stalled-prompt signal and wait timeout are both ambiguous, so neither is delivery proof. The supervisor does not paste the bootstrap twice: it accepts only a semantic transition from settled `idle`/`done` to `working`, or reads the pane and sends only `Enter` when it sees either the assignment's unique durable path or Claude's collapsed `[Pasted text #N +M lines]` composer token. Pane repaint revisions, late native-session discovery, and unknown/blocked startup transitions are not delivery proof. Ticket history distinguishes direct confirmation from working-transition or staged-composer recovery. If Herdr cannot become ready, start, or expose staged input within the bounded recovery windows, the supervisor clears any potentially hidden composer with `Ctrl+C` before the tracker records an operational `delivery_failed` attempt and retries the same node without emitting any declared outcome or transition context. Workflow authors should not add failure edges for provider startup races; reserve declared failure outcomes for work the agent actually began and evaluated.

## Choose the right data channel

Do not force all state through prompt text. Use the narrowest durable channel that matches the data.

| Need | Use | Notes |
| --- | --- | --- |
| Per-ticket choice made before work starts | Workflow input | Boolean, select, or text. Inputs drive node conditions and dynamic Script paths. |
| Small mutable machine-readable state | Workflow metadata | JSON values, up to the 64 KiB ticket metadata limit. Read and write through callbacks or Read/Write nodes. |
| Operator-supplied file input | Ticket attachment | The tracker stores the file and its digest. The supervisor verifies and materializes it under the run bundle's `attachments/` directory; agents discover exact paths in `attachments.md` and `context.json`. |
| Durable work product | Repository file, PR, deployment, or external system | Specifications, code, reports, collections, and release records should not live only in a callback. |
| Durable audit of what a node accomplished | Completion `summary` | Concise result and evidence. Retained on the node run. |
| Actionable context for the immediate next node | Completion `handoff` | Repairs, risks, decisions, and next actions. Do not repeat the whole ticket. |
| A small amount of Script stdout needed immediately | `prompt_tail_lines` | Adds the final configured number of stdout lines to the next transition. |
| Full Script stdout | `persist_stdout` | Stores a bounded external run artifact and passes its tracker URL onward. |
| Structured Script facts | `AGENTIC_RESULT_PATH` | Script writes bounded JSON `metadata` and `external_references`; the tracker validates and records it atomically with the result. |
| Reproducible node evidence | Execution manifest | Every completed supervisor execution records workflow/prompt identity, timing, telemetry, repository before/after state, artifacts, and runtime facts as an immutable tracker artifact. |
| Agent execution provenance | Herdr transcript and native harness log | The supervisor automatically captures these at Agent-run boundaries. Workflow authors do not route on them or ask agents to format them. |
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
- `max_transitions` bounds the entire ticket graph. `max_visits` bounds repeat visits to an individual node. Agent nodes also use `max_cost_usd` to bound cumulative known cost. Use all three for potentially expensive loops.
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
- `agent_profile`: required profile alias that resolves provider, model, and reasoning. Provider selection belongs exclusively to this workflow field; tickets do not choose providers or models.
- `conversation_key`: stable conversation identity within the ticket.
- `outcomes`: one or more exact completion outcomes.

Optional behavior:

- `pull_request_requirement` requires a reported PR before completion. Its `scope` is `primary` or `any`, and its `phase` selects the PR association.
- `max_visits` bounds feedback and repair loops.
- `max_cost_usd` is the cumulative known-cost ceiling for this node across all of its visits in the ticket. It defaults to `50`. The tracker requests a clean supervisor interruption when observed cost becomes greater than the ceiling, then leaves the current node blocked for operator attention. Unknown cost is not treated as zero and cannot trigger the guard. To continue, publish a workflow revision with a higher ceiling and migrate the ticket; ordinary retry cannot bypass the same limit.
- `conversation_policy` explicitly chooses `resume`, `fresh_each_visit`, or `reset_after_visits`. The last form also requires `maximum_visits_per_session`.

Cost is sampled through harness telemetry, so this is a bounded operational guard rather than an exact provider-side spend authorization. A run can exceed the configured amount between telemetry samples before the supervisor observes and stops it.

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
artifacts:
  - name: test-report
    path: reports/test-results.json
    content_type: application/json
    required: true
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

Declared `artifacts` are exact regular-file paths relative to the resolved working directory. After the process exits, the supervisor uploads every produced file to the tracker's content-addressed artifact store. A missing required file makes the activity fail; a missing optional file is ignored. Artifact bytes do not enter Markdown frontmatter. Later assignments receive tracker URLs and digests in `artifacts.md` and `context.json`.

### Human-readable review evidence

Use an ordinary artifact when an operator should inspect a result during execution or before choosing a Human Gate outcome. Contents are intentionally permissive: Markdown, standalone HTML, images, PDF, JSON, YAML, text, and arbitrary downloadable files are all valid. There is no required report schema and artifact content never selects a workflow edge. Every artifact remains expandable from the ticket's **Evidence & artifacts** card regardless of ticket state; its review packet can show only featured evidence, keep the newest artifact from each node, filter by node/category/media type, and move through fullscreen previews. Low-level manifests and checkpoint bundles are grouped under **Technical artifacts**. An active Human Gate additionally presents the preceding node's evidence in the focused **Review materials** card.

An Agent can publish any file before its terminal callback with the generated helper:

```sh
/absolute/path/to/publish-artifact review.md \
  --title "Implementation review" \
  --description "What changed, how it was verified, and remaining risk." \
  --category approval \
  --featured
```

`title`, `description`, `category`, and `featured` are optional presentation hints, not a content contract. MIME type is inferred from common extensions or can be supplied with `--content-type`. A Script declaration may attach the same optional hints:

```yaml
artifacts:
  - name: smoke-report
    path: reports/smoke.html
    content_type: text/html
    required: false
    presentation:
      title: Non-production smoke test
      description: Interactive report for release approval.
      category: verification
      featured: true
```

When a Human Gate is current, the ticket places artifacts from the immediately preceding completed node run in a **Review materials** card directly beneath the graph. Featured evidence is selected first. Markdown, sandboxed standalone HTML, images, PDF, JSON, YAML, and text receive inline previews; other or oversized files retain Open and Download links. The completion summary remains visible when no artifact was published. Keep important evidence self-contained: an HTML artifact should embed its styles and data rather than assume a repository-relative asset server.

Use strict `agentic-quality/v1` only when scalar values must participate in workflow metrics. Do not force prose approval reports into that schema.

### Quality-report artifacts

A Script can publish a YAML quality report as immutable evidence and make its registered attributes available to ticket and workflow metrics. Mark the artifact explicitly; YAML content type alone does not cause interpretation:

```yaml
artifacts:
  - name: implementation-quality
    path: reports/quality.yaml
    content_type: application/yaml
    required: true
    interpretation:
      kind: quality_report
      schema: agentic-quality/v1
      required_attributes:
        - tests.pass_rate
        - coverage.line_percent
```

The produced file uses this contract:

```yaml
schema: agentic-quality/v1
name: Implementation quality
subject:
  type: repository
  repository: application-api
  commit: abc123
producer:
  tool: project-verifier
  version: 2.1.0
attributes:
  - key: tests.pass_rate
    value: 0.98
    unit: ratio
    direction: higher_is_better
    target: 0.95
    status: pass
  - key: coverage.line_percent
    value: 84.2
    unit: percent
    direction: higher_is_better
    target: 80
    status: pass
```

Configure stable attribute keys, labels, scalar types, units, direction, and optional numeric bounds in **Configuration → Quality registry**. Registered values participate in workflow-revision evaluation. Unregistered values remain visible on the ticket and in the raw report but are excluded from aggregates so spelling drift cannot silently fragment a metric.

The tracker parses and validates quality YAML during upload, snapshots the registry semantics into the artifact metadata, and retains the raw YAML as the authoritative evidence. Every retry or loop visit produces its own report. Ticket display uses the latest value per attribute; workflow metrics use the final completed report per ticket, node, and attribute so repair loops do not overweight difficult tickets.

Quality evidence does not implicitly select a workflow edge. The Script must use its exit code or structured metadata plus a Read node when a quality result should control routing.

For small machine-readable results, write one JSON object to `AGENTIC_RESULT_PATH` before exiting:

```json
{
  "metadata": { "deployment.id": "deploy-123", "deployment.ready": false },
  "external_references": [
    { "type": "deployment", "id": "deploy-123", "url": "https://deployments.example/deploy-123" }
  ]
}
```

Metadata values must be JSON-compatible and the whole result is bounded. These values are persisted on both the ticket and node run. External references are audit evidence; they do not automatically select an edge. Continue to use exit codes for Script routing and a later Read node for branching on persisted metadata.

Use Script for a stable command with objective exit semantics. Use Agent when the work requires discovering a repository's conventions, interpreting a test report, navigating an unclear deployment, or deciding what action is appropriate.

### Wait

A Wait node is a durable external delay, normally paired with a Script polling node. It does not run a process, hold a lease, or occupy a supervisor/provider slot.

```yaml
type: wait
wait_schedule:
  initial_seconds: 30
  multiplier: 1.5
  maximum_seconds: 300
  jitter_percent: 10
  deadline_seconds: 3600
next: check-deployment
timeout_to: deployment-recovery
```

Each visit records a durable wait run with a wake time and absolute deadline. Repeated visits use bounded exponential backoff plus deterministic ticket/node jitter. `elapsed` routes to `next`; `timed_out` routes to `timeout_to`. The operator may choose **Check now** without erasing the original deadline. A successful checker transition out of the loop clears its prior wait state, so a later independent visit starts a new deadline.

Recommended shape:

```text
start-deployment (Script) -> check-deployment (Script)
check-deployment:not_ready -> wait-for-deployment (Wait)
wait-for-deployment:elapsed -> check-deployment
check-deployment:ready -> validate
wait-for-deployment:timed_out -> recovery gate
```

Make the polling Script fast, read-only, and idempotent. Use different exit codes for ready, not ready, terminal external failure, and inability to query. Never route all failures back into Wait.

### Checkpoint and Restore Checkpoint

A Checkpoint node captures every repository declared by the ticket—never unrelated project-root repositories. It creates a synthetic Git commit from a temporary index, so tracked and untracked working-tree changes are included without changing the repository's normal index, branch, or HEAD. The supervisor writes portable Git bundles, uploads them to the tracker, and records a manifest containing each repository's original HEAD, branch, remote, snapshot commit, dirty flag, bundle artifact, node run, and timestamp.

```yaml
type: checkpoint
checkpoint_label: Before deployment experiment
exit_codes:
  - { id: created, label: Created, description: Snapshot stored, target: experiment, codes: [0] }
  - { id: failed, label: Failed, description: Snapshot failed, target: recovery, default: true }
```

A Restore Checkpoint node resolves either the latest checkpoint, a fixed ID, or an ID stored in ticket metadata. Before changing any repository it creates and uploads a `pre_restore` checkpoint. It then fetches each portable bundle and materializes the captured tree into the declared repository without moving its current branch or `HEAD`. A partial failure triggers best-effort compensation from the pre-restore snapshots and follows the node's failure route. Restore is deterministic supervisor work; it does not prompt an agent.

```yaml
type: restore_checkpoint
checkpoint_source:
  mode: metadata
  metadata_key: checkpoint.restore_id
exit_codes:
  - { id: restored, label: Restored, description: Snapshot restored, target: resume, codes: [0] }
  - { id: failed, label: Failed, description: Restore or compensation failed, target: recovery, default: true }
```

The ticket's Checkpoints card may route work to any configured Checkpoint or Restore Checkpoint node. If an execution is active, the tracker first requests interruption and keeps the existing lease/repository reservation until the supervisor acknowledges it; the requested deterministic node becomes ready only afterward.

### Human Gate

A Human Gate pauses the workflow and presents declared `choices` in the UI. Each choice has an ID, label, description, target, optional `comment_required`, and optional metric classification. Every choice lets the operator include an optional comment; `comment_required: true` makes that field mandatory.

The operator's selection alone becomes the transition outcome and selects the target edge. Any accompanying comment is recorded as the transition summary and immediate handoff to the destination; it never changes routing. This makes a comment suitable for a selected PR URL, release identifier, or other small operator-supplied parameter. Use ticket metadata when the value must remain authoritative across multiple later nodes or loops. Labels should read as decisions—“Approve”, “Request changes”, “Abort deployment”—and descriptions should explain the consequence.

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
- Nodes sharing one key must use the same agent-profile alias.

Conversation reset is an explicit node policy:

- `resume` keeps one conversation generation across every workflow visit and repair loop.
- `fresh_each_visit` starts a new generation when the graph re-enters the node, while retries of the same logical visit keep their generation.
- `reset_after_visits` resumes until `maximum_visits_per_session`, then starts a new generation on the next workflow visit.

The ticket records the generation, visits within it, last logical visit, and reset reason. Pane names include the generation so a reset cannot accidentally restore an older Herdr pane. Operators can also reset an inactive conversation from the ticket. Use `resume` for implementation/repair continuity, a separate key for independent review, and bounded reset policies for critic or investigation loops that benefit from a fresh context. A lease loss or provider quota pause is not a new workflow visit and must not reset the conversation by itself.

The profile selects the harness; the prompt selects the role. Do not rely on the model name to imply review independence or merge authority.

## Execution manifests and provenance

After every supervisor-run Agent, Script, Checkpoint, or Restore Checkpoint node finishes or is interrupted, the supervisor submits best-effort runtime evidence and the tracker writes one immutable `execution_manifest` artifact. The ticket retains only its artifact reference on the node run.

The manifest records the exact workflow/node/prompt revision, visit and attempt, outcome, timing ledger, resolved agent profile and conversation generation, telemetry, input/output artifact digests, PR associations, repository state before and after execution, script identity, supervisor runtime, and the original incoming transition supplied to the run. Inputs—including the incoming transition, workflow inputs, stage selections, attachments, prior artifact references, prompt revision, and resolved profile—are snapshotted when the node run begins; finalization never substitutes the mutable context of the next node. Repository evidence includes HEAD, branch, remote, dirty status, and status/diff digests; it deliberately does not copy repository contents into the manifest.

Treat the manifest as provenance and debugging evidence, not as a cryptographic supply-chain attestation. It is generated after a run, is best effort if the tracker is unavailable at finalization, and does not replace signed build provenance, SBOMs, deployment records, or checkpoint bundles where policy requires them. The ticket's **Evidence & artifacts** view links every available manifest both from its corresponding node run and from the manifest inventory. The same view exposes the complete hydrated run ledger, generic artifacts, persisted output, checkpoint manifests and bundles, and operator attachments without requiring knowledge of the tracker-owned storage paths.

Agent attempts also stream a Herdr operational trace. Workflow authors do not configure or route on this trace. It records supervisor-to-Herdr commands, meaningful pane observations, prompt-delivery evaluations, recovery actions, and timestamps as tracker-owned immutable JSONL chunks. The ticket's **Operational traces** tab groups those chunks by attempt, offers command/decision/error filters, and retains raw downloads. Prompt contents remain in the durable assignment bundle; the trace records only assignment paths, byte counts, and digests so it remains compact and does not become a second prompt source.

Agent attempts also produce best-effort provenance evidence without adding prompt requirements. The supervisor captures bounded human-readable Herdr scrollback and copies the harness's native session JSONL (including bounded Claude subagent transcripts when present) after questions, callbacks, interruptions, disappearances, and delivery failures. A transient Herdr `agent_not_idle` response during callback finalization is retried for a bounded period; native capture remains independent. The tracker's **Provenance** tab shows a per-Agent-run matrix for native session logs, Herdr transcripts, operational traces, and manifests. Its headline session-provenance total is the union of native and Herdr captures, with separate source counts so missing Herdr scrollback does not hide successful native capture. Artifact rows expose source, provider, session/pane, role, disposition, and full/bounded/partial labels. This material is useful for demonstrations, audit review, and diagnosis, but it may contain everything the agent terminal/session recorded and should be handled according to the deployment's trust boundary. Missing capture is evidence coverage, never node failure.

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
- `publish-artifact`: executable helper for unrestricted human-readable evidence with optional display hints.
- `updates/`: ordered live guidance, answers, and refreshed-ticket notifications.
- `outbox/`: local callback request/response records.

The files are an assignment snapshot. Agents are told to treat them as read-only; editing them is not a durable tracker update. The exact current paths are repeated in live guidance and the single idle callback reminder, so an agent can recover after context compaction.

The helper is the authoritative callback interface. An agent can run commands such as:

```sh
/absolute/path/to/callback schema complete
printf '%s\n' '{"outcome":"completed","summary":"Implemented and verified the change."}' \
  | /absolute/path/to/callback complete -
```

Publish review evidence before the terminal callback closes the lease. Running `/absolute/path/to/publish-artifact --help` recovers its compact command contract without putting an artifact schema in the reusable prompt.

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

### Context synthesis

- Treat deterministic inventories and search results as evidence, not as an exhaustive view of the repository.
- Perform additional focused discovery only where the evidence exposes a gap or ambiguity.
- Produce a short, durable repository context document with relevant paths, interfaces, constraints, verification commands, dependencies, risks, and open questions.
- Clearly distinguish observed facts, inferred relationships, and unresolved assumptions.
- Hand off the document path and the few constraints the next node must not miss; do not paste the full document into the callback.
- Do not implement the requested product change from a context-preparation node unless that authority is explicitly part of its prompt.

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

### Semantic verification or evaluation

- Begin with the ticket's acceptance criteria and the durable evidence produced by deterministic checks.
- Inspect the actual repository and diff rather than grading only the implementer's summary.
- Test claims that remain uncertain when normal tools can do so safely.
- Separate missing mechanical coverage from semantic defects, design risk, and unverifiable claims.
- Use a skeptical, independent conversation and state the evidence required for each declared outcome.
- Return blocking findings to the implementation conversation; do not silently repair them from the evaluator role.

### Deployment, validation, merge, and release

- State the authorized environment and the evidence required before success.
- State whether a human may need to approve an external operation.
- Make rollback expectations and failure outcomes explicit.
- For merge, enumerate required approvals, checks, branch state, and allowed merge method.
- For release creation, identify the external artifact and metadata that must be recorded for downstream nodes.

## Common design mistakes

- **Creating a node type for every named factory role.** Translate the role into evidence production, judgment, routing, and state preservation first.
- **Combining evidence, policy, and authority in one opaque step.** Prefer a Script that produces facts, an Agent that interprets ambiguity, and a Human Gate that exercises organizational authority.
- **Making every agent action a node.** Nodes are durable organizational boundaries, not the agent's internal checklist.
- **Using magic outcome strings.** Declare every outcome in the node and describe its evidence.
- **Routing a Script from prose.** Script routing uses exit codes only.
- **Omitting failure cleanup.** If an agent failure must roll back or recover, declare a `failed` outcome and route.
- **Treating stages as the execution engine.** Nodes and edges are authoritative; stages group and optionally bypass them.
- **Expecting Fan Out to run concurrently.** Current branches are sequential.
- **Using metadata as a document store.** Keep it small and machine-readable.
- **Treating repository restore as deployment rollback.** Checkpoint nodes restore Git worktrees, not databases, clusters, flags, or external systems.
- **Implementing general monitoring as a tight loop.** Leave ongoing sampling and event detection in the observability or deployment platform; bring bounded evidence back into the workflow.
- **Using one conversation for implementer and reviewer.** Independent roles need different conversation keys and normally different profiles.
- **Renaming a node and assuming PR rules follow it.** PR requirements and GitHub feedback targets are explicit node configuration.
- **Forgetting loop bounds.** Every repair or polling loop needs visit and transition limits.
- **Assuming `fail` selects any failure-like route.** Automatic failure routing uses the exact outcome ID `failed`; otherwise the ticket fails in place.
- **Letting prompt and graph disagree.** The allowed outcomes and their descriptions are the durable contract.
- **Putting critical instructions only in the initial Herdr message.** The durable bundle and callback helper are the recovery source.

## Keeping the authoring contract compatible

This guide describes a contract implemented across several surfaces. An assisting agent should not update one surface in isolation when the contract changes.

Use these sources together:

- `src/server/workflow-library.ts` defines the accepted workflow schema and publication validation.
- The workflow editor in `src/client/App.tsx` defines what operators can author without editing YAML directly.
- The supervisor's activity and assignment-bundle code defines what nodes actually receive and execute.
- `skills/agentic-project-tracker/` defines the allowlisted outside-agent ticket interface. It intentionally manages tickets, not workflow or prompt artifacts.
- `../agentic-project-system-tests/` verifies tracker/supervisor behavior across process boundaries without starting a real provider.

When adding or changing a node field, outcome rule, data channel, operator transition, assignment file, or callback behavior:

1. Update this guide and any authoritative tracker/supervisor README or specification that states the contract.
2. Update the visual editor, preview, and default workflows when operators must be able to use the feature.
3. Audit the outside-agent skill, command reference, client, and client tests. Add only allowlisted ticket operations; do not turn the client into a generic REST escape hatch.
4. Add or update a cross-process system test when the behavior spans the tracker and supervisor, affects assignment recovery, or changes an operator-visible lifecycle.
5. Validate a representative workflow and prompt preview, then run the relevant tracker, supervisor, skill, and system-test suites.

Do not mechanically expose workflow publication through the outside-agent skill. Workflow and prompt authoring remain operator/configuration responsibilities unless that boundary is deliberately changed.

## Review checklist for an assisting LLM

Before recommending publication, verify:

### Process fidelity

- Every required artifact, decision, role boundary, and external side effect has an owner.
- Every named software-factory role has been reduced to the smallest useful composition of existing nodes before a new primitive is proposed.
- Ambiguous engineering work stays in broad Agent nodes.
- Deterministic commands use Script nodes with objective exit codes.
- Policy Scripts distinguish permission, approval-required, prohibition/remediation, and evaluation error where those states have different consequences.
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
- Context-preparation nodes produce bounded durable artifacts and paths, not an oversized handoff or prompt transcript.
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
- A changed workflow is first published as a trial and compared against an appropriate completed-ticket cohort before it replaces the default when operational risk warrants experimentation.

When helping a user, explain assumptions and tradeoffs before producing YAML. Prefer a small first workflow that captures real organizational boundaries, then add nodes only when operational evidence shows that a new durable boundary is valuable.
