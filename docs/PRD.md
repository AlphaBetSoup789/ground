# Ground Product Requirements

- Status: public-alpha product contract
- Last updated: 2026-07-29
- Delivery status: [ROADMAP.md](../ROADMAP.md)
- Implementation order: [BUILD-PLAN.md](BUILD-PLAN.md)

## Product thesis

Ground is the open workspace for coding agents: **your ground, any model**.

A developer should be able to keep a workspace, readable task history, tools, and
permission decisions under their control while choosing the model API or coding
agent runtime that fits the job. Changing providers must not require abandoning
the workspace or making a hosted Ground relay the owner of the conversation.

Ground succeeds when it is credible as a daily coding workspace, not merely a chat
client with a provider dropdown. It must combine provider freedom with the
workspace awareness, streaming feedback, tool use, safety, durability, and polish
users expect from first-party coding-agent applications.

## Problem

Most capable coding-agent experiences couple three separate concerns:

1. the user's local repository and development environment;
2. the task interface, history, tools, and approval workflow; and
3. one provider's model, account, protocol, and private session state.

That coupling creates lock-in and weakens user control. Switching models can mean
switching applications, losing readable history, rebuilding context, accepting a
new permission model, or routing private work through another hosted service.
Local and open models are often technically reachable but operationally awkward.
External coding CLIs are capable, but each has different event, session, and
permission semantics.

Ground separates the durable workspace from interchangeable model and runtime
connections without pretending those connections are identical.

## Target users

### Primary

- Individual developers who want a polished coding-agent workspace without being
  locked to one model provider.
- Developers who move between hosted APIs, local OpenAI-compatible servers, and
  installed coding-agent CLIs.
- Privacy- and control-conscious users who want workspace state and readable
  history kept locally.
- Open-source maintainers who need auditable permission and data-egress boundaries.

### Secondary

- Teams evaluating models against the same repository and workflow.
- Provider, runtime, and tool authors who want a documented integration contract.
- Enterprises that need direct endpoints or approved local runtimes without a
  mandatory third-party relay.

## Core jobs to be done

1. Open a repository and begin a useful coding task quickly.
2. Ask questions, request plans, or delegate code changes with an understandable
   permission boundary.
3. See streaming answers, tool activity, diffs, commands, errors, and usage in one
   coherent timeline.
4. Switch the task to another compatible provider without losing readable history.
5. Use local models and installed coding CLIs without sacrificing the desktop
   workspace experience.
6. Review and approve side effects before Ground-managed agents change the
   workspace or invoke external tools.
7. Recover, export, fork, archive, and continue work without depending on a
   provider-owned conversation object.
8. Diagnose connection or runtime failures with an actionable explanation.

## Product principles

### The workspace belongs to the user

Workspace state, normalized history, and portable task content remain usable
without a Ground account or the original provider.

### Provider freedom is honest

Ground normalizes common task and activity concepts but exposes capability
differences. It does not claim that every OpenAI-shaped endpoint, model, or CLI has
the same tools, context, reasoning controls, privacy, or permission enforcement.

### Local first, direct by default

Ground stores its durable application state locally and connects directly to the
user-selected endpoint or executable. Optional future sync or team services must
not become mandatory for local use.

### Useful enough for daily work

Provider neutrality is not the whole product. Ground must make repository context,
tool use, diffs, terminals, Git, parallel work, recovery, and long-running tasks
feel cohesive and dependable.

### Authority is explicit

The interface must distinguish Ground-managed tools from tools and permissions
owned by an external runtime. A status event is not represented as an enforceable
approval when Ground cannot enforce it.

### Safe defaults, inspectable exceptions

Read-only work should be easy. Side effects should be narrowly described,
attributable, cancellable where possible, and gated at the privileged boundary.

### Evidence before claims

Fixture, mock, live-provider, packaged-app, accessibility, signing, and platform
tests prove different things. Product and release claims must identify the exact
evidence they rely on.

## Product requirements

Requirement IDs are stable references for issues, pull requests, and acceptance
tests. Never renumber or reuse an ID; deprecate it in place and name its
replacement. Delivery status belongs in the roadmap and GitHub, not in this
document.

### GR-1: Local workspace ownership

- GR-1.1 Ground must let the user select and work within a local repository or
  directory without copying that workspace to a Ground service.
- GR-1.2 Durable tasks, normalized transcript items, provider attribution, and
  application settings must remain local by default.
- GR-1.3 The renderer must receive only the workspace identity and display data it
  needs; canonical path authority remains in the main process.
- GR-1.4 Ground must not require an account or hosted relay for its core local
  workflow.

Acceptance:

- A user can create, close, reopen, and continue a workspace task locally.
- Blocking the public internet does not prevent local state access or use of an
  already installed local runtime, subject to that runtime's own needs.
- Renderer snapshots do not expose canonical workspace authority or stored secrets.

### GR-2: Provider and runtime choice

- GR-2.1 Ground must support direct first-class model protocols, a documented
  OpenAI-compatible connection, recognized coding CLIs, and a generic CLI bridge.
- GR-2.2 Provider selection must be task-scoped and visible on every generated
  message or runtime activity.
- GR-2.3 A task must remain readable after switching providers.
- GR-2.4 Capability differences must be represented explicitly and conservatively.
- GR-2.5 Provider and runtime configuration must be testable without overstating
  what was verified.
- GR-2.6 Adding a reviewed adapter must use a versioned provider-neutral contract
  and deterministic conformance evidence.

Acceptance:

- At least one direct API path, one OpenAI-compatible path, and one recognized CLI
  path can complete a task through the production application.
- Switching a compatible task provider preserves normalized readable history and
  provider attribution.
- An unavailable endpoint or misconfigured executable produces actionable,
  credential-safe diagnostics.

### GR-3: Effective agent task loop

- GR-3.1 Users must be able to create, title, search, archive, restore, fork,
  export, import, and delete tasks.
- GR-3.2 The timeline must stream assistant output and normalize meaningful tool,
  command, file, usage, warning, failure, and completion activity.
- GR-3.3 Ask mode must provide a clearly read-only or planning-oriented workflow.
- GR-3.4 Agent mode must enable coding actions according to the selected adapter's
  actual permission owner and capabilities.
- GR-3.5 Users must be able to cancel an active run and understand whether a
  side-effect outcome is known, failed, cancelled, or uncertain.
- GR-3.6 Long tasks must retain usable context through bounded selection,
  compaction, or summarization without corrupting complete tool exchanges.

Acceptance:

- A user can move from prompt to reviewed change without leaving the task.
- Successful turns are never labeled failed solely because a runtime emitted a
  non-fatal notice.
- Cancelling a run does not silently duplicate or retry a side effect.

### GR-4: Workspace tools

- GR-4.1 Ground-managed API agents must have bounded list, read, and search tools.
- GR-4.2 Agent mode may add approval-gated full writes, exact localized edits, and
  commands.
- GR-4.3 Ground must provide integrated diff and Git workflows sufficient to
  inspect and organize agent changes.
- GR-4.4 Ground must provide an integrated terminal whose authority is described
  honestly as a user-authorized native shell, not a Ground sandbox.
- GR-4.5 Ground must support isolated managed worktrees as the basis for safe
  parallel tasks.
- GR-4.6 MCP tools must be namespaced, schema-reviewed, and permissioned according
  to their transport and capability.

Acceptance:

- Every Ground-managed write, edit, command, and MCP call is attributable to a run
  and crosses the required approval boundary.
- A user can inspect working changes and recover a supported selected-file restore.
- Parallel work never silently shares a mutable checkout when an isolated worktree
  is required.

### GR-5: Security and privacy

- GR-5.1 Stored credentials must stay outside renderer-accessible state and use
  genuine OS-protected storage when persistence is offered.
- GR-5.2 Provider requests must go only to the validated, user-reviewed endpoint
  boundary and reject unsafe redirects or transport downgrades.
- GR-5.3 Executable discovery must be passive and bounded; executing or trusting a
  runtime requires a main-process-owned review boundary.
- GR-5.4 Inputs from the renderer, provider, CLI, MCP, filesystem, Git, and terminal
  must be treated as untrusted and bounded.
- GR-5.5 Task portability must move content without moving credentials, workspace
  authority, executable trust, provider sessions, or approvals.
- GR-5.6 Sensitive diagnostics and exports must be redacted where structurally
  possible and must tell users when arbitrary prose still requires review.

Acceptance:

- The security and threat-model test suites cover stale-state, symlink, reflection,
  cancellation, size, and authority-bypass cases relevant to a changed boundary.
- A secret used for a provider or runtime does not appear in renderer projections,
  normalized output, logs, or deterministic fixtures.
- Denying a native authorization fails closed.

### GR-6: Durability and recovery

- GR-6.1 State publication must be validated, bounded, private, and recoverable
  from supported corruption and interruption cases.
- GR-6.2 The product must distinguish complete, failed, interrupted, and
  outcome-unknown operations.
- GR-6.3 Recovery actions must be user-visible and must not infer that missing or
  undecryptable credentials are safe to delete.
- GR-6.4 Persisted formats must be versioned and reject unsupported future or
  skipped migrations.
- GR-6.5 The long-term storage model must support sequenced recovery without
  replaying side effects.

Acceptance:

- Corrupt primary state cannot silently replace the last valid retained state.
- A crash around a managed side effect cannot cause Ground to retry it
  automatically without proof of its outcome.
- Exported task content remains readable without the source provider.

### GR-7: Extensibility

- GR-7.1 Model and runtime adapters must implement versioned contracts with
  explicit capabilities, configuration validation, canonical events, and
  conformance tests.
- GR-7.2 User configuration must never choose arbitrary code to load into Ground's
  privileged process.
- GR-7.3 Generic bridges must remain documented so an unsupported provider can be
  connected without forking the entire workspace.
- GR-7.4 Compatibility evidence must identify the adapter, protocol or runtime
  version, fixture provenance, and tested boundary.

Acceptance:

- A downstream adapter can be built and tested against the packaged SDK contract
  without replacing Ground's canonical reducer.
- Malformed, oversized, reordered, or duplicate runtime/provider events fail
  predictably.

### GR-8: Desktop quality and distribution

- GR-8.1 Core workflows must be keyboard accessible and usable across supported
  window sizes, forced-color settings, and reduced-motion preferences.
- GR-8.2 Ground must provide reproducible native packages for supported platforms.
- GR-8.3 Official binaries must be signed according to the target platform policy,
  accompanied by checksums and provenance, and have a documented rollback path.
- GR-8.4 A release must declare the exact operating systems, architectures,
  provider/runtime versions, and accessibility boundaries it certifies.
- GR-8.5 Failure states must explain the next corrective action whenever Ground can
  determine it safely.

Acceptance:

- macOS, Windows, and Linux verification run against native packaged artifacts for
  the supported release matrix.
- The official release checklist in [RELEASING.md](RELEASING.md) passes without
  substituting unsigned preview evidence for signing or installer certification.
- Critical workflows complete with the keyboard and receive a documented
  accessibility audit before stable release.

## Experience requirements

The intended task flow is:

1. Open or choose a workspace.
2. Create a task and select Ask or Agent mode.
3. Select a saved provider or connect a new API, local server, or CLI.
4. Validate the provider boundary with an accurately labeled check.
5. Send a prompt and see immediate, cancellable progress.
6. Review normalized reasoning-independent activity, proposed changes, commands,
   warnings, and failures.
7. Approve or deny side effects at the boundary that can enforce them.
8. Inspect files, diffs, Git state, terminal output, and task history in the same
   workspace.
9. Continue, fork, switch provider, export, archive, or recover the task without
   losing readable history.

Common setup should be discoverable in the UI. A local-server preset must make it
clear that Ground does not install or start the server. A CLI configuration check
must not claim that authentication or a live model turn succeeded.

## Success measures

Public alpha is moving in the right direction when:

- a new contributor can set up the repository and identify the next work item from
  committed documentation and linked issues without private context;
- users can complete production-app tasks through multiple provider classes with
  failures that identify whether Ground, the endpoint, or the external runtime owns
  the remedy;
- provider switching preserves readable task continuity;
- the rate of outcome-unknown or unrecoverable task operations trends toward zero;
- cross-platform, compatibility, security, and packaged-app evidence stays green
  as capability expands; and
- releases make narrower, evidence-backed claims instead of broad unverified
  compatibility promises.

Quantitative adoption, latency, reliability, and crash targets should be set after
an opt-in, privacy-preserving measurement design exists. Ground must not add
mandatory telemetry solely to manufacture these metrics.

## Non-goals

- Requiring a Ground account, subscription, or hosted model relay.
- Making every model or provider-specific feature appear interchangeable.
- Loading arbitrary provider plugins into the privileged desktop process.
- Claiming Ground can enforce actions performed internally by a trusted external
  CLI.
- Replacing the user's editor, shell, Git host, or model-provider account.
- Moving readable task history exclusively into provider-owned session state.
- Shipping collaboration or sync that becomes mandatory for local use.
- Treating unsigned source previews as supported production releases.

## Open product questions

These require explicit product or architecture decisions before implementation:

- What is the smallest provider-neutral context/indexing layer that materially
  improves repository understanding without duplicating an IDE?
- Which parts of multi-agent orchestration should Ground own versus delegate to a
  capable external runtime?
- How should the audited SQLite foundation be cut over incrementally while
  preserving the JSON rollback source, import/export clarity, secret-reference
  lifecycle, and side-effect recovery?
- Which optional team or encrypted-sync capabilities can exist without weakening
  the no-account local workflow?
- What compatibility and accessibility matrix is realistic for the first signed
  public release?
- Which privacy-preserving diagnostics are useful enough to justify their design
  and review cost?

Resolve material decisions through the public design-issue and maintainer-approval
process in [GOVERNANCE.md](../GOVERNANCE.md), keep the accepted reasoning linked
from the implementation pull request, and reflect delivery outcomes in the roadmap
and build plan.
