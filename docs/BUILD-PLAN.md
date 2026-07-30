# Ground Build Plan

- Status: active sequencing plan
- Last updated: 2026-07-29
- Product contract: [PRD.md](PRD.md)
- Milestone status: [ROADMAP.md](../ROADMAP.md)

## Purpose

This document translates the product requirements and roadmap into a dependency
order that multiple contributors or coding agents can execute safely. It defines
workstreams and acceptance gates; GitHub issues and milestones own live task
status, assignment, and implementation discussion.

Do not mark an item complete here merely because code exists. A milestone gate is
complete only when its stated evidence is present. When a work item becomes
actionable, create or link a GitHub issue using its build-plan ID.

## Status and priority

Use these priority terms for actionable issues and pull requests. Record the term in the
[build-plan issue form](../.github/ISSUE_TEMPLATE/build_plan.yml); repository
labels may mirror them but are not required for the plan to remain usable:

- **P0**: blocks the next declared release gate or protects user data/authority.
- **P1**: required for a dependable daily-driver beta.
- **P2**: important expansion after the core workflow is dependable.

The plan also uses **Foundation** for implemented baseline behavior and
**Gate for _release_** for evidence required before making that release claim.
These are plan annotations, not issue priorities.

## Implemented foundation

The current source tree already contains the baseline described in
[README.md](../README.md), including:

- a local Electron workspace with durable tasks and normalized timelines;
- direct OpenAI Responses, Anthropic Messages, Google Gemini, and
  OpenAI-compatible model paths;
- recognized Codex, Claude, Gemini, and Antigravity CLI adapters plus a Generic CLI
  bridge;
- Ask and Agent modes with explicit permission ownership;
- bounded Ground-managed file, search, edit, write, command, and MCP tools;
- task-scoped providers, switching, forks, archive/search, import/export, and
  recovery controls;
- terminals, Git/diff operations, selected-file restore, and managed worktrees;
- provider-neutral adapter contracts, conformance tests, compatibility fixtures,
  and a provisional SDK package;
- strict renderer/main boundaries, native authorization, credential-vault,
  persistence, and portability controls; and
- cross-platform CI, renderer interaction tests, unsigned packaging, package
  evidence, SBOM, license, and CodeQL workflows.

This is a strong source-project baseline, not a signed supported release. Current
behavior and limitations belong in the README; detailed checklist state belongs in
the roadmap.

## Delivery sequence

```text
Foundation
    │
    ▼
M1 Truthful onboarding and installable alpha
    │
    ├──────────────┐
    ▼              ▼
M2 Durable runs    M3 Daily-driver context
    │              │
    └──────┬───────┘
           ▼
M4 Ground-owned parallel work
           │
           ▼
M5 Extensible tools and provider certification
           │
           ▼
M6 Signed beta and stable operations
```

Security, accessibility, compatibility, and documentation are continuous
workstreams. They are gates on each milestone, not cleanup phases at the end.

## M1 — Truthful onboarding and installable alpha

Goal: a new user can install or build Ground, connect one supported provider path,
understand the permission boundary, and complete a first task without private
setup knowledge.

### M1.1 Provider onboarding and health — P0

Requirements: GR-2, GR-8.5

- Define a first-run empty state that distinguishes hosted API, local server, and
  installed CLI paths.
- Show passive local detection without claiming a runtime is authenticated or
  live.
- Keep API configuration validation separate from a real connection/generation
  check.
- Diagnose DNS, TLS, authentication, rate-limit, timeout, protocol-shape, closed
  local-port, missing executable, and external-runtime startup failures with
  credential-safe corrective guidance.
- Provide an explicit local-server readiness explanation: Ground connects to
  Ollama, LM Studio, or another compatible server but does not install, start, or
  pull models for it.
- Add a provider health/retest surface scoped to the task's actual provider.

Acceptance gate:

- Production-app smoke tests cover one direct API mock, one loopback compatible
  server, one unavailable loopback server, one recognized CLI deterministic child,
  and one malformed provider/runtime response.
- Every check states what it did and did not prove.
- A successful turn containing non-fatal runtime warnings remains successful.

### M1.2 Compatibility truth — P0

Requirements: GR-2.4–2.6, GR-7.4, GR-8.4

This is the minimum evidence baseline for built-in connections before an
installable public preview. M5.3 turns that baseline into an ongoing compatibility
program after the first release.

- Turn the compatibility matrix into an issue-backed certification queue.
- Pin supported protocol and CLI fixture versions.
- Add opt-in maintainer procedures for credentialed live checks without placing
  credentials or paid requests in CI.
- Record live observation separately from deterministic contract coverage.
- Define the minimum supported operating-system and architecture matrix.

Acceptance gate:

- Each first-class adapter has deterministic fixtures, negative protocol tests, and
  a dated support statement.
- Release notes cannot imply live-provider certification from mocks or source
  inspection.

### M1.3 Installable public preview — P0

Requirements: GR-8

- Validate the existing unsigned packages and runtime evidence on native runners.
- Protect the GitHub `release` environment with reviewed deployment branches,
  required human approval, and a documented administrator-bypass policy before it
  can authorize publication.
- Provision protected macOS signing/notarization credentials and define
  Windows/Linux signing policy.
- Publish checksums, SBOM, provenance, package evidence, release notes, and rollback
  instructions from a protected release.
- Ensure application identity and user-data paths remain stable across upgrades.
- Provide a clear unsupported-preview warning until signed artifacts pass.

Acceptance gate:

- The release checklist in [RELEASING.md](RELEASING.md) passes for every claimed
  artifact.
- A clean machine can install, launch, connect a deterministic test runtime, retain
  state across restart, and uninstall without deleting user data unexpectedly.
- macOS artifacts are signed and notarized before Ground describes them as an
  official macOS release.

### M1.4 Contributor and agent onboarding — P0

Requirements: N/A — project operations

- Keep [AGENTS.md](../AGENTS.md), [PRD.md](PRD.md), this build plan, and the roadmap
  linked from the repository entry points.
- Seed public milestones and a small issue queue for the next accepted P0/P1 work
  so contributors can claim scoped tasks without private coordination.
- Convert actionable roadmap work into scoped GitHub issues with requirement and
  build-plan IDs.
- Follow the public design-issue and maintainer-approval process for material
  decisions; keep accepted reasoning linked from implementation pull requests.
- Maintain a PR template that asks for outcome, verification, boundary changes,
  and residual risk.

Acceptance gate:

- A fresh contributor can identify the product contract, next issue, affected
  boundary, and required verification without private conversation history.

## M2 — Durable runs and state

Goal: Ground can recover from interruption and long-running work without ambiguous
history or duplicate side effects.

### M2.1 Transactional event store — P0

Requirements: GR-6

- Specify a sequenced append-only event model for tasks, runs, activities,
  approvals, managed executions, provider revisions, and recovery checkpoints.
- Define snapshot/materialized-view rebuilding, compaction, schema versioning, and
  bounded retention.
- Preserve encrypted-secret references without coupling their lifecycle to an
  inferred state complement.
- Design migration from current bounded JSON state with fail-closed rollback.
- Keep export formats deliberately separate from the internal recovery log.

Acceptance gate:

- Crash injection at every publish boundary recovers to a valid prefix.
- Rebuilding the materialized state is deterministic and bounded.
- Migration can be retried or rolled back without losing the last valid source
  state or deleting a live credential.
- Future or skipped schema versions fail closed.

### M2.2 Safe interrupted-run continuation — P0

Requirements: GR-3.5, GR-6.2, GR-6.5

- Define which read-only model/runtime operations may resume automatically.
- Require durable evidence before treating a side effect as complete.
- Never automatically replay writes, commands, commits, MCP calls, or external
  runtime actions whose outcome is unknown.
- Persist cancellation and process-cleanup outcomes.
- Present a recovery UI that separates retryable, resumable, and manual-review
  states.

Acceptance gate:

- Deterministic crash tests cover pre-approval, post-approval, pre-spawn,
  post-spawn, partial output, side-effect completion, persistence failure, and
  process-tree escape cases.
- No test path can execute the same side-effect envelope twice without a new user
  decision.

### M2.3 Durable background execution — P1

Requirements: GR-3, GR-4

- Supervise background commands and external runtimes independently of renderer
  lifetime.
- Define app-quit behavior, task archive behavior, timeouts, logs, and explicit
  termination.
- Persist bounded terminal/background activity without turning arbitrary terminal
  streams into trusted structured events.

Acceptance gate:

- Renderer recreation does not lose ownership or duplicate output.
- App shutdown reports and handles active native processes according to a reviewed
  policy.
- Process cleanup has platform-specific evidence and explicit residual limits.

## M3 — Daily-driver context and review

Goal: Ground can handle real repositories and long tasks with the context,
attachments, and review ergonomics expected from a first-party coding agent.

### M3.1 Repository context layer — P1

Requirements: GR-3.6, GR-4

- Design a local, bounded repository inventory with ignore awareness, language and
  symbol metadata, freshness tracking, and no mandatory embedding service.
- Keep model-visible paths workspace-relative and sensitive-path filtered.
- Let the user inspect what repository context will be sent.
- Define optional local or user-selected embedding/index providers without making
  them a prerequisite.

Acceptance gate:

- Index updates are incremental, cancellable, bounded, and resilient to symlink and
  repository-size abuse cases.
- A user can clear derived context without deleting tasks or source files.
- No index content leaves the machine unless an explicit selected provider request
  includes it.

### M3.2 Context compaction and checkpoints — P1

Requirements: GR-3.6, GR-6

- Add provider-neutral summaries/checkpoints that preserve decisions, unresolved
  work, file references, and complete tool exchanges.
- Make compaction visible and distinguish Ground-authored summaries from model
  output.
- Keep provider-native session acceleration optional.
- Define invalidation when provider, workspace, mode, or imported-history policy
  changes.
- As a non-summarizing precursor, reserve the active user objective inside every
  bounded managed-API request, keep complete tool exchanges atomic, and report
  timeline-projection and request-planner reductions without recounting compatible
  session history.

Acceptance gate:

- Long synthetic tasks stay within model budgets without orphaning tool results or
  silently dropping the current objective.
- Switching providers can continue from normalized history plus Ground-owned
  checkpoints.
- Users can inspect or discard compacted state.

### M3.3 Attachments and rich review — P1

Requirements: GR-3, GR-4

- Support bounded text, image, and document attachments with explicit provider
  capability checks and egress previews.
- Add focused changed-file review, per-hunk discussion, approval summaries, and
  test-result presentation.
- Refresh an already-open Git review once when its task leaves an active run,
  retaining the prior overview and any still-valid file/hunk position.
- Preserve accessibility and portable export behavior for supported attachment
  metadata.

Acceptance gate:

- Unsupported providers fail before egress with a clear capability explanation.
- Attachment bytes, parsed text, previews, and exports have explicit size,
  persistence, and deletion rules.
- Diff review remains bound to current file and hunk review identities.
- Late or overlapping repository reads cannot cross task boundaries or blank a
  usable review while a finished-run refresh is pending.

### M3.4 Task interaction and navigation — P1

Requirements: GR-3, GR-8.1

- Keep command discovery, task search, task switching, and task-local drafts
  keyboard-complete across desktop and narrow layouts.
- Let a user deliberately move reviewed context—such as an Ask response or one
  complete Git hunk—into an editable draft without starting a run.
- Let a user prepare the next task-local prompt while a run or approval is active
  without queueing, steering, or sending it implicitly.
- Let a user recover an exact retained failed request into an empty editable
  task-local draft without implying automatic or side-effect-safe replay.
- Preserve timeline reading position while follow mode is paused, then offer one
  keyboard-accessible, task-bound action that returns to exact current output.
- Bind delayed selection, handoff, and focus work to the exact current task and
  source revision so stale renderer work cannot redirect a draft or selection.
- Keep every prompt handoff visibly editable and require a separate explicit Send
  before provider or runtime egress.

Acceptance gate:

- Task search, result activation, command discovery, task switching, and sidebar
  exit can be completed by keyboard with deterministic focus on supported window
  sizes.
- Task-local drafts survive task switching and remain attributable to exactly one
  task, including drafts prepared while another run is still active.
- Context-to-draft actions preserve existing text, refuse incomplete or oversized
  input, and cannot create a user message, run, approval, tool call, or provider
  request by themselves.
- Failed-run recovery excludes imported history and outcome-unknown interrupted
  work, never replaces an occupied draft, and revalidates the exact run/message
  source before preparing text.
- Streaming output cannot force a paused reader to the bottom; explicit
  jump-to-latest activation resumes follow mode, announces the change, and cannot
  carry stale control or scroll state into another task.
- Input-method composition, stale async completion, responsive layout changes,
  and modal focus changes have renderer interaction evidence.

## M4 — Ground-owned parallel work

Goal: users can delegate independent subtasks across models or runtimes while
Ground owns isolation, status, review, and integration.

### M4.1 Task decomposition and dependency graph — P1

Requirements: GR-3, GR-4.5

- Represent a parent objective, bounded child tasks, dependencies, ownership,
  status, budgets, and cancellation.
- Let a user choose provider, mode, and workspace isolation per child.
- Keep task history provider-neutral and link child evidence back to the parent.
- Avoid representing model-authored plans as execution authority.

Acceptance gate:

- A parent can spawn, observe, cancel, retry, and summarize deterministic child
  tasks without merging their work automatically.
- Cycles, duplicate ownership, stale parent state, and late child events are
  rejected or reconciled predictably.

### M4.2 Worktree isolation and scheduling — P1

Requirements: GR-4.5, GR-5

- Build parallel execution on Ground-managed clean worktrees.
- Add concurrency limits, queueing, resource budgets, branch naming, cleanup, and
  orphan recovery.
- Bind each child run to the exact worktree, provider revision, mode, and
  executable/endpoint authority.
- Keep direct user terminal and Git actions visibly distinct from agent-managed
  orchestration.

Acceptance gate:

- Concurrent children cannot mutate another child's checkout through Ground-owned
  tools.
- Dirty, moved, unregistered, or externally modified worktrees fail safely.
- Cancelling one child does not terminate or authorize another.

### M4.3 Review and integration — P1

Requirements: GR-4, GR-6

- Present child summaries, tests, diffs, conflicts, and residual risks together.
- Support user-selected cherry-pick, merge, or manual integration with exact Git
  identity and tree review.
- Never let a child self-approve integration into the primary branch.
- Record integration results in the parent task.

Acceptance gate:

- The reviewed commit/tree is the one integrated.
- Base-branch drift, conflicts, hooks/filters, and failed partial integration have
  recoverable, attributable outcomes.
- The user can reject all child changes without losing their readable reports.

## M5 — Extensible tools and provider certification

Goal: broaden Ground without weakening its static trust model or making every
provider appear equivalent.

### M5.1 Adapter SDK stabilization — P1

Requirements: GR-7

- Stabilize versioning, capability negotiation, typed errors, canonical events,
  migration policy, and conformance fixtures.
- Publish the adapter package with provenance and compatibility documentation.
- Add example adapters that do not require privileged runtime code loading.
- Define deprecation and backward-compatibility policy.

Acceptance gate:

- A clean-room downstream package builds, rejects invalid configuration, and passes
  deterministic conformance without importing private Ground internals.
- Contract changes follow semantic versioning and include migration notes.

### M5.2 MCP completeness — P2

Requirements: GR-4.6, GR-5

- Add remote authentication/OAuth with genuine protected storage.
- Evaluate resources, prompts, Apps/UI, elicitation, and finer capability grants
  independently.
- Keep remote identity, definition drift, data egress, and user-presence boundaries
  explicit.

Acceptance gate:

- Each new MCP capability has a separate threat statement, schema bounds,
  cancellation behavior, and permission surface.
- Untrusted Apps/UI metadata cannot become privileged renderer content.

### M5.3 Compatibility program — P1

Requirements: GR-2, GR-7.4, GR-8.4

This workstream builds on the M1.2 release baseline. It owns recurring
certification, regression tracking, and support-lifecycle operations rather than
duplicating the initial built-in fixture work.

- Maintain deterministic fixtures for every claimed built-in adapter.
- Add optional, protected live certification jobs or a documented maintainer
  protocol for selected versions.
- Track regressions by provider/runtime version and capability.
- Expose compatibility status in user-facing documentation without marketing
  overreach.

Acceptance gate:

- Every supported combination has an evidence type, date, version, known limits,
  and owner.
- Dropped or degraded compatibility produces a visible release note and migration
  guidance.

## M6 — Signed beta and stable operations

Goal: Ground is safe and dependable enough to recommend as a daily workspace on
its declared supported platforms.

### M6.1 Accessibility certification — Gate for stable

Requirements: GR-8.1, GR-8.4

- Complete keyboard, screen-reader, focus, contrast, zoom, reduced-motion, and
  forced-color audits on supported platforms.
- Include native dialogs, terminal, diff views, provider forms, task navigation,
  errors, approvals, and streaming announcements.
- Track findings with severity and regression coverage.

Acceptance gate:

- Critical workflows meet the documented accessibility target on the declared
  platform/screen-reader matrix.
- Remaining exceptions are published and do not block essential safety decisions.

### M6.2 Signed updates and rollback — Gate for stable

Requirements: GR-6.4, GR-8.3

- Define signed update metadata, staged rollout, rollback, and compromised-key
  response.
- Keep updates optional and never route provider prompts through the update
  service.
- Verify state migration and downgrade behavior across supported release edges.

Acceptance gate:

- Tampered update metadata or artifacts fail closed.
- A failed update can return to the last supported version without silently
  discarding or misreading user state.

### M6.3 Privacy-preserving diagnostics — P2

Requirements: GR-5.6, GR-8.5

- Design opt-in structured diagnostics with a local redaction preview.
- Exclude prompts, source, secrets, canonical paths, transcripts, and arbitrary
  provider/runtime payloads by default.
- Make collection, retention, destination, and deletion explicit.

Acceptance gate:

- Diagnostics are disabled by default until approved through the privacy and
  threat-model review.
- Reflection and correlation tests cover identifiers, paths, secrets, and
  user-authored content.

### M6.4 Project continuity — Gate for stable

Requirements: N/A — project operations

- Add a second repository administrator before declaring a stable release.
- Separate conduct and security escalation from the sole release maintainer where
  practical.
- Document release, credential-rotation, vulnerability-response, and continuity
  responsibilities for more than one trusted person.

Acceptance gate:

- Governance and security policy name independent escalation and continuity paths
  that remain usable when the primary maintainer is unavailable or conflicted.

## Continuous verification matrix

Every milestone must preserve the relevant evidence:

| Boundary | Required evidence |
| --- | --- |
| Canonical contracts | Unit tests, malformed-event tests, compatibility fixtures, SDK conformance |
| Renderer experience | Component tests and Playwright-over-Electron interactions |
| IPC and authority | Negative IPC/origin/grant/stale-capability tests |
| Provider APIs | Deterministic mocked/loopback protocol tests; separately labeled live observations |
| External runtimes | Deterministic child processes, pinned parser fixtures, cancellation and reflection tests |
| Persistence and secrets | Crash/fault injection, schema bounds, vault/keychain and migration tests |
| Files, commands, Git, MCP | Exact-envelope, stale-state, symlink, process-tree, and recovery tests |
| Packages | Native build, launch, identity, vault, PTY, Git, MCP, installer/extraction, SBOM, and checksum evidence |
| Releases | Protected CI, signing/notarization policy, provenance, rollback, and published limitations |
| Accessibility | Automated regressions plus documented manual assistive-technology audits |

## Cross-cutting risks

### Provider abstraction can hide meaningful differences

Mitigation: capability descriptors, provider attribution, conservative defaults,
adapter-owned behavior, and compatibility evidence.

### External CLIs can exceed Ground's authority

Mitigation: native executable and invocation review, mode-specific safe arguments
where supported, honest permission ownership, normalized observability, and
explicit non-guarantees.

### More orchestration increases side-effect ambiguity

Mitigation: finish the event store and interruption semantics before automatic
parallel integration; isolate work in managed worktrees; require user-owned merge
authority.

### Indexing and attachments expand privacy exposure

Mitigation: local derivation, explicit egress previews, bounded storage, sensitive
path filtering, and user-controlled deletion.

### Release polish can outrun evidence

Mitigation: keep unsigned preview, deterministic fixture, live-provider,
packaged-app, signed-release, and accessibility claims separate.

## Issue template for build-plan work

Use the committed
[build-plan issue form](../.github/ISSUE_TEMPLATE/build_plan.yml) when turning a
plan item into a GitHub issue. It captures:

```text
Title:
Build-plan ID:
PRD requirements:
User outcome:
In scope:
Out of scope:
Affected authority/data boundaries:
Acceptance criteria:
Verification evidence:
Dependencies:
Known risks or open decisions:
```

Link the issue from the relevant build-plan item only when doing so improves
navigation; GitHub remains the live source for its status and owner.

## Updating this plan

Update this document when dependency order, a milestone gate, or a cross-cutting
strategy changes. Update the roadmap when milestone scope or broad completion
changes. Update GitHub issues for day-to-day progress.

A pull request that changes this plan should explain:

- what new evidence or decision changed the sequence;
- which PRD requirements and roadmap milestones are affected;
- which public design issue or accepted decision is affected; and
- how existing in-flight issues should be relabeled, closed, or reordered.
