# Roadmap

Ground’s promise is **your workspace, any model**. Milestones are gated by behavior,
safety, and portability—not target dates.

This roadmap is directional. Checked items exist in the current source tree; they
are not necessarily release-certified.

## Public alpha baseline

- [x] Local Electron workspace with durable tasks and provider profiles
- [x] Direct OpenAI-compatible/local endpoint
- [x] Generic CLI transport and recognized Codex, Claude, Gemini, and Antigravity
  event parsers, plus a documented dependency-free Generic CLI bridge
- [x] Passive CLI discovery and a native executable picker that validate without
  launching candidates while preserving separate save/run confirmations
- [x] Provider-neutral model/runtime contracts and canonical event reducers
- [x] Source-trusted static model/runtime registry and injectable factories
- [x] Main-process renderer, workspace, endpoint, secret, and executable checks
- [x] Bounded built-in file/search/full-write/localized-edit/command tools with
  side-effect approvals
- [x] Immutable write and command approval envelopes with target/content/executable
  revalidation
- [x] Native CLI session metadata and compatible resume
- [x] Interactive multi-session workspace PTY with native launch confirmation,
  opaque renderer attachments, detach/reattach, and bounded in-memory scrollback
- [x] Git status, staged/unstaged diff, path staging/unstaging, exact-tree commits,
  exact-ref conditional updates, bounded history, recoverable selected-file
  restore/undo, clean managed-worktree create/remove, and one request-bound
  refresh of an open review after a run finishes
- [x] Passive workspace-excluding Git discovery, native executable selection,
  private fingerprint preference, Git 2.23+ verification after confirmation, and
  exact identity revalidation before every launch
- [x] Neutralize effective repository clean/smudge/process filters on Ground’s
  status, working-diff, and worktree-checkout invocations
- [x] MCP Streamable HTTP and stdio tools with namespacing, exact definition trust,
  drift blocking, and per-call approval
- [x] Bind local MCP launch and tool trust to an exact invocation and bounded
  executable content/metadata identity, with native first-launch confirmation
- [x] Ask-mode read-only workspace tools plus configurable context-window,
  response-token, and reasoning controls
- [x] Versioned task bundle import/export, Markdown export, and confirmed task
  deletion
- [x] Safe task fork, reversible archive/restore, and bounded active/archive search
- [x] Keyboard-complete task switching over the exact current filtered order,
  including direct Enter activation, Arrow-key result focus, query clearing,
  IME/modifier/no-result refusal, and request-bound narrow-sidebar focus
- [x] Strict persisted-state validation, three rotating validated snapshots,
  automatic fallback, bounded no-follow reads, private atomic replacement,
  unreadable-file quarantine, and in-app recovery controls
- [x] Explicit persisted-state v1-to-v2 migration with fail-closed future/skip
  handling
- [x] Saved-provider readiness checks that gate every exact provider revision before
  run startup, with versioned credential publication and task/provider-bound start
  reservations
- [x] First-run Hosted API, Local server, and Installed CLI paths that identify the
  local values as a template, keep passive CLI detection non-authoritative, and
  limit stopped-server recovery to confirmed refused loopback connections
- [x] Keyboard command palette, task-local unsent drafts including draft-only
  preparation during active runs and approval waits, bounded streaming
  announcements, near-bottom timeline following with task-bound jump recovery,
  responsive layout, forced-color support, and reduced-motion behavior
- [x] Exact failed-run request recovery into an empty task-local editable draft,
  with occupied drafts and outcome-unknown interruptions preserved
- [x] Reviewable Ask-to-Agent handoff that awaits the mode change, preserves
  task-local drafts, and requires explicit Send before any run or provider egress
- [x] Bounded reviewed-hunk-to-prompt handoff that preserves the source task's
  editable draft and requires explicit Send before provider egress
- [x] Cross-platform CI renderer interaction suite in Electron for command and
  task-search keyboard/focus, provider-form validation, local-provider refusal
  recovery, drafts, cancellation, archive/search, responsive settings, forced
  colors, and reduced-motion behavior
- [x] Baseline CI, CodeQL, issue forms, and contributor/security documentation

## Public alpha hardening

### Provider freedom

- [x] Connect OpenAI Responses, Anthropic Messages, and Google Gemini adapters to
  the desktop provider screen and managed run loop
- [x] Persist canonical model/tool history, per-item provider attribution, and
  normalized cross-provider tool exchanges
- [x] Preserve the active user objective across bounded managed-API context,
  retain complete recent tool exchanges, and update a visible notice when
  projection or planner reductions change
- [x] Publish version-pinned synthetic API-adapter and CLI-parser compatibility
  fixtures with explicit provenance and package/declaration drift checks
- [x] Document source-trusted static model-adapter registration without runtime
  provider-code loading
- [x] Wire the agent-runtime registry into desktop CLI composition and provide a
  versioned, publishable adapter package plus deterministic conformance suite
- [x] Keep published compatibility evidence explicit about deterministic
  fixture/mock provenance and the absence of paid live-provider/CLI certification
- [x] Add a packaged, credential-free, token-bound loopback OpenAI-compatible
  readiness and first-turn fixture that crosses the production registry,
  `RunManager`, and durable state without claiming external-provider certification
- [x] Complete the remaining M1.1 production-app smoke matrix for a direct
  first-class API, a recognized CLI deterministic child, and malformed
  provider/runtime responses
- [x] Add credential-safe typed readiness and run guidance for transport,
  authentication, protocol, executable, and external-runtime startup failures

### Safe coding loop

- [x] Preserve one immutable approval envelope from preview through execution
- [x] Bind approved commands to resolved executable identity and fingerprint
- [x] Replace path-bearing renderer DTOs with revocable opaque workspace grants
- [x] Put new terminal creation behind a native exact-launch confirmation
- [x] Move write, command, and MCP-call approval behind a native user-presence
  surface
- [x] Persist exact managed-action start/completion claims and recover interrupted
  writes, commands, and MCP calls as outcome unknown without automatic replay
- [x] Add Git status/diff/history, selected-path staging/unstaging, exact-tree
  commits, and clean managed-worktree create/remove
- [x] Refresh a mounted Git review after an active run settles while retaining the
  last overview and exact surviving file/hunk selection
- [x] Add a recoverable selected-file restore/undo workflow
- [x] Add fixed packaged-app identity, encrypted-vault, native-dialog, PTY, Git,
  deterministic compatible/first-class provider turns, expected provider
  failures, recognized-CLI success with a non-fatal warning, MCP launch, and
  process-tree cancellation runtime evidence
- [ ] Add adversarial packaged renderer-interaction and accessibility end-to-end
  certification

### Durable workspace

- [ ] Replace JSON snapshots with a transactional, append-only event store
- [x] Add legacy file migration, strict state-schema validation, three rotating
  retained snapshots, automatic corruption fallback, unreadable-file quarantine,
  and a recovery banner
- [x] Add an opaque user-driven snapshot browser, native export and restore
  workflow, a process-wide restore drain/seal, and a three-generation retention
  policy
- [ ] Resume interrupted runs safely without duplicating side effects
- [x] Add portable JSON import/export, Markdown export, and task deletion
- [x] Add task archive/restore, active/archive search, and safe fork
- [x] Add explicit controls for including imported history in later model context

### Public release engineering

- [x] Name maintainers and private conduct/security contacts
- [ ] Pin supported Node, Electron, provider API, CLI, and operating-system ranges
- [x] Generate and CI-check `THIRD_PARTY_NOTICES.md` from the locked production
  graph
- [x] Add native-runner unsigned preview packaging for macOS, Windows, and Linux
- [x] Require distributable-bound runtime evidence for macOS arm64/x64, Windows
  x64, and Linux x64, including temporary NSIS installation and ZIP/AppImage
  extraction
- [ ] Re-run the current provider/runtime-matrix evidence contract against all four
  native distributables and verify the aggregate
- [x] Scaffold a tag workflow for checksums, CycloneDX SBOM, build/SBOM
  attestations, and a draft prerelease
- [ ] Produce signed, notarized macOS artifacts from protected CI
- [ ] Certify Windows/Linux packages and define their signing/distribution policy
- [ ] Publish and independently verify checksums, provenance, release notes, and
  rollback behavior from a protected release
- [ ] Complete keyboard, screen-reader, reduced-motion, and contrast audits

## Beta

- Certified Windows and Linux packages
- Broader managed-worktree orchestration and coordinated parallel agent tasks
- Durable terminal sessions and supervised background commands
- MCP remote authentication/OAuth, resources/prompts, and finer per-capability
  grants
- Attachments, repository indexing, and summarizing context compaction
- Signed updates with rollback
- Structured, privacy-preserving diagnostics with local redaction preview

## Stable

- Backward-compatible adapter SDK and provider conformance suite
- Durable migration, backup, and restore guarantees
- Published support/version policy and reproducible release provenance
- Complete cross-platform accessibility and packaged-app compatibility matrix
- Optional team/sync features that never become mandatory for local use

## Product non-goals

The durable product non-goals are owned by
[docs/PRD.md](docs/PRD.md#non-goals). Roadmap proposals must remain inside that
contract unless a public design issue and maintainer-approved PR update the PRD
first.

Once the repository is published, roadmap work should be represented by linked
issues or milestones rather than silently changing this file.
