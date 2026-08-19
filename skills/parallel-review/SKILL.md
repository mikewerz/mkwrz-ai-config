---

name: parallel-pr-review
description: Perform an evidence-based review of a pull request, branch, commit range, patch, or code change using risk-directed parallel analysis. Use for requirements, correctness, compatibility, data integrity, security, reliability, performance, testing, and operational readiness.
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# Parallel PR Review

Review the change as a staff-level engineer. Prioritize confirmed defects and material risks over stylistic preferences.

## Core rules

* Review only; do not modify files unless explicitly asked.
* Treat repository instructions and stated requirements as authoritative.
* Inspect the complete diff and enough surrounding code to understand its behavior.
* Do not infer requirements solely from the implementation.
* Report only actionable, evidence-backed findings.
* A PR finding must be introduced, exposed, or materially worsened by the change.
* Do not report unrelated pre-existing defects as PR findings.
* Check whether existing code, tests, configuration, infrastructure, or framework behavior already prevents the concern.
* Distinguish confirmed defects from credible risks requiring validation.
* Missing verification is not itself proof of a defect.
* Do not report style preferences. Report maintainability only when it creates a realistic correctness, operational, or future-change risk.
* Never expose secrets, credentials, tokens, personal data, or other sensitive values encountered during review.

## Phase 1: Establish ground truth

Before reviewing or delegating:

1. Identify the base and head revisions.
2. Read repository-level and relevant directory-level agent instructions.
3. Inspect the complete diff, including renamed, generated, configuration, schema, infrastructure, and test files.
4. Read the issue, PR description, acceptance criteria, linked design documents, and relevant review comments when available.
5. Inspect surrounding code and history where needed to understand contracts, invariants, and existing behavior.
6. Identify affected:

   * Components and ownership boundaries
   * Public APIs, events, schemas, and stored data
   * Transactions, caches, and asynchronous processes
   * External dependencies and security boundaries
   * Deployment, configuration, and infrastructure artifacts
7. Discover the repository’s documented build, formatting, linting, static-analysis, and test commands.
8. Identify generated or vendored files that should not receive ordinary source review.
9. Produce a concise change summary and risk map.

Use a risk map such as:

```text
Surface:
Intended behavior or contract:
Important invariants:
Credible failure modes:
Affected users or systems:
Relevant verification:
Risk: high | medium | low
```

Record material ambiguities rather than silently inventing requirements.

## Phase 2: Plan the review

For a very small or narrowly scoped change, review directly.

For a non-trivial change, choose one to four independent review lanes based on the risk map. Prefer domain-specific lanes over fixed generic personas.

Possible lanes include:

* Requirements, domain behavior, and compatibility
* Functional correctness, state transitions, and failure handling
* Persistence, migrations, transactions, and data integrity
* Concurrency, asynchronous processing, and distributed behavior
* Authentication, authorization, security, and privacy
* Reliability, performance, observability, and deployment
* Tests, build verification, and contract coverage

Combine related lanes when separation would add noise. Do not assign several agents to perform the same broad review.

Examples of useful specialization:

* PostgreSQL migration and mixed-version deployment safety
* OAuth authorization and tenant isolation
* Event ordering, duplicate delivery, and idempotency
* Kubernetes startup, health checks, and resource behavior
* Public API compatibility and client migration
* Hot-path query and resource-capacity analysis

Keep reviewers independent until their passes finish. Do not show one reviewer another reviewer’s findings in advance.

If subagents are unavailable, perform the selected lanes as separate sequential passes.

## Phase 3: Review and verify concurrently

Once context is established, run independent review lanes and baseline verification concurrently when the environment permits.

### Reviewer instructions

Give each reviewer:

* Base and head revisions
* Change summary and risk map
* Requirements and acceptance criteria
* Relevant repository instructions
* Its assigned review lane
* Permission to inspect surrounding code and history
* A prohibition against editing files
* The structured finding format below

Reviewers may report a serious cross-lane defect, but should otherwise stay focused on their assignment.

### Verification instructions

Run safe, relevant checks using repository-documented commands where possible:

* Formatting or formatting verification
* Compilation or build
* Linting and static analysis
* Unit tests
* Relevant integration, API, contract, migration, or end-to-end tests

Prioritize checks that exercise changed behavior and affected contracts.

For every command, record:

* Exact command
* Result
* Relevant failure output
* Whether a failure appears caused by the change, pre-existing state, or the environment

Do not claim a check passed unless it was actually executed successfully.

Do not treat an unavailable or failed-to-start check as a product defect without evidence connecting it to the change.

## Review focus

Use professional judgment rather than exhaustively checking every possible software-engineering concern. Concentrate on realistic, material failure modes.

### Requirements and contracts

Look for:

* Behavior that contradicts requirements or acceptance criteria
* Broken business invariants
* Backward-incompatible API, event, schema, or stored-data changes
* Incorrect protocol semantics, status codes, errors, or side effects
* Unsafe retry, duplicate-request, ordering, or idempotency behavior

### State and data

Look for:

* Lost, duplicated, corrupted, stale, or unintentionally exposed data
* Incorrect transaction or isolation assumptions
* Partial failure that leaves inconsistent state
* Unsafe defaults, backfills, migrations, rollout ordering, or rollback
* Schema, ORM, validation, and database constraints that disagree
* Cache behavior that violates required consistency

### Concurrency and asynchronous behavior

Look for:

* Races, lost updates, deadlocks, unsafe shared state, or non-atomic operations
* Blocking work on constrained executors or event loops
* Unsafe timeout, retry, cancellation, or cleanup interactions
* Missing propagation of security, tenant, tracing, or request context
* Unhandled duplicate, late, missing, out-of-order, poison, or undeliverable messages
* Unbounded workers, pools, queues, or pending work

### Security and privacy

Look for:

* Missing authentication or authorization at an affected boundary
* Cross-user or cross-tenant access
* Injection, traversal, unsafe deserialization, command execution, or unsafe URL handling
* Sensitive data entering logs, errors, events, analytics, or responses
* Weakened security controls or unsafe configuration defaults
* Material dependency, image, cryptography, session, cookie, CORS, CSRF, or rate-limit risks

### Production behavior

Look for:

* Unbounded external calls, missing timeouts, unsafe retries, or cascading failure
* Resource exhaustion involving memory, CPU, connections, threads, disk, or queues
* Expensive work added to common paths
* Unbounded queries, N+1 access, missing pagination, excessive fan-out, or unsuitable cardinality assumptions
* Deployment ordering, mixed-version, configuration, permission, networking, or rollback hazards
* Failures that operators cannot detect, diagnose, mitigate, or recover from
* New behavior that lacks necessary success, failure, latency, or saturation signals

### Verification quality

Look for:

* Tests that execute code without proving the changed behavior
* A bug fix without a meaningful regression test
* Missing boundary, failure, authorization, compatibility, concurrency, or migration coverage
* Contract tests that no longer match public schemas or behavior
* Tests that would still pass if the implementation were materially broken
* Verification that depends on unrealistic fixtures or hidden environmental assumptions

### Maintainability

Report maintainability only when the change:

* Obscures important behavior or side effects
* Duplicates authoritative business logic likely to drift
* Breaks an important component or ownership boundary
* Creates an interface that is realistically easy to misuse
* Introduces complexity that materially raises defect or operational risk

Do not report naming, length, nesting, abstraction, duplication, or coverage metrics as findings by themselves.

## Structured reviewer finding format

Reviewers should return one record per proposed finding:

```yaml
- severity: P1
  category: correctness
  title: Prevent duplicate processing after timeout
  status: confirmed
  locations:
    - path/to/file.ext:123
    - path/to/other-file.ext:45
  trigger: >
    The concrete runtime, input, deployment, or failure conditions
    required to reproduce the issue.
  evidence:
    - >
      What the changed code does, with file and line references.
    - >
      Relevant surrounding behavior or the absence of an expected safeguard.
  impact: >
    The user-visible, operational, security, data, or maintenance consequence.
  recommendation: >
    The smallest practical correction.
  confidence: high
  change_relation: introduced
  validation_needed: null
```

Allowed values:

* `status`: `confirmed` or `risk`
* `confidence`: `high`, `medium`, or `low`
* `change_relation`: `introduced`, `exposed`, or `worsened`

For `status: risk`, provide a concrete `validation_needed` value explaining how to confirm or reject the concern.

Do not submit a finding when:

* The triggering path is not realistic
* The impact is merely hypothetical
* Existing behavior already prevents it
* It is unrelated to the change
* It is only a personal design or style preference
* The recommendation is unrelated cleanup or redesign

Prefer one root-cause finding over several symptom findings.

## Severity

* **P0 — Critical:** Immediate security, data-loss, or widespread availability risk.
* **P1 — High:** Likely production failure, serious incorrect behavior, or broken contract.
* **P2 — Medium:** Material defect or engineering risk under realistic conditions.
* **P3 — Low:** Limited-impact issue worth correcting, but not merge-blocking by itself.

Severity reflects demonstrated impact and probability. Reviewer agreement or vote count is not evidence.

## Phase 4: Adjudicate findings

Treat every proposed finding as potentially wrong.

For each finding:

1. Independently inspect the cited code and surrounding implementation.
2. Reconstruct the triggering execution or deployment path.
3. Confirm that the change introduced, exposed, or worsened the behavior.
4. Check for existing validation, safeguards, tests, configuration, framework guarantees, and operational controls.
5. Verify that the stated impact follows from the evidence.
6. Compare the claim with requirements and observed verification results.
7. Downgrade an unconfirmed but credible concern to a risk requiring validation.
8. Discard incorrect assumptions, unsupported speculation, and style preferences.
9. Merge duplicate or causally related findings.
10. Prefer one root cause over several downstream symptoms.
11. Calibrate severity from demonstrated impact rather than rhetoric.
12. Separate merge-blocking defects from optional improvements.

Do not accept a finding merely because several reviewers repeated it.

Failure to run a check does not automatically require a blocked verdict. Use a blocked verdict only when unavailable requirements or verification prevent a responsible risk judgment.

## Final response

Present the result in this order.

### Verdict

Choose one:

* **Good to merge** — No validated merge-blocking findings, with sufficient evidence for the affected risk surfaces.
* **Good to merge with minor follow-up** — No validated merge-blocking findings, but one or more worthwhile non-blocking improvements remain.
* **Changes requested** — At least one validated defect should be corrected before merging.
* **Blocked pending clarification or verification** — Essential requirements or evidence are unavailable, preventing a responsible verdict.

Give a concise explanation. Severity alone does not determine the verdict; use demonstrated materiality and likelihood.

### Findings

List only adjudicated findings, ordered by severity.

Use:

```markdown
### [P1] Short imperative title

- **Location:** `path/to/file.ext:line`
- **Category:** correctness, requirements, security, performance, reliability, testing, maintainability, architecture, or operations
- **Status:** confirmed defect or risk requiring validation
- **Evidence:** What the changed code does and the concrete triggering conditions.
- **Impact:** The resulting user, system, security, data, or maintenance consequence.
- **Recommendation:** The smallest practical correction.
- **Confidence:** high, medium, or low
```

If there are no validated findings, say so explicitly.

### Verification

Report:

* Commands executed and their results
* Relevant failures and their likely cause
* Checks not executed and why
* Material areas reviewed
* Important assumptions and unavailable context
* Residual risks that could not be verified

### Optional improvements

Include non-blocking suggestions only when they provide meaningful value. Do not use this section for generic cleanup or stylistic preferences.

Keep the final review concise enough for the author to act on without reconstructing the analysis.

