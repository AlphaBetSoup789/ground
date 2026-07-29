# Roadmap

Ground’s promise is **your workspace, any model**. Milestones are gated by behavior,
safety, and portability—not target dates.

This roadmap is directional. Checked items exist in the current source tree; they
are not necessarily release-certified.

## Developer preview

- [x] Local Electron workspace with durable tasks and provider profiles
- [x] Direct OpenAI-compatible/local endpoint
- [x] Generic CLI transport and recognized Codex, Claude, and Gemini event parsers
- [x] Provider-neutral model/runtime contracts and canonical event reducer
- [x] Source-trusted static model-adapter registry and injectable runtime factory
- [x] Main-process renderer, workspace, endpoint, secret, and executable checks
- [x] Bounded built-in file/search/full-write/localized-edit/command tools with
  side-effect approvals
- [x] Immutable write and command approval envelopes with target/content/executable
  revalidation
- [x] Native CLI session metadata and compatible resume
- [x] Interactive multi-session workspace PTY with native launch confirmation,
  opaque renderer attachments, detach/reattach, and bounded in-memory scrollback
- [x] Git status, staged/unstaged diff, path staging/unstaging, exact-tree commits,
  bounded history, and clean managed-worktree create/remove
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
- [x] Strict persisted-state validation, one rotating backup, automatic fallback,
  bounded no-follow reads, private atomic replacement, unreadable-file quarantine,
  and an in-app recovery notice
- [x] Baseline CI, CodeQL, issue forms, and contributor/security documentation

## Public alpha exit criteria

### Provider freedom

- [x] Connect OpenAI Responses, Anthropic Messages, and Google Gemini adapters to
  the desktop provider screen and managed run loop
- [x] Persist canonical model/tool history, per-item provider attribution, and
  normalized cross-provider tool exchanges
- [ ] Publish version-pinned API and CLI compatibility fixtures
- [x] Document source-trusted static model-adapter registration without runtime
  provider-code loading
- [ ] Wire the agent-runtime registry into desktop CLI composition and publish a
  stable adapter package/conformance suite

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
- [ ] Add a recoverable revert workflow
- [ ] Add packaged-app security and cancellation end-to-end tests

### Durable workspace

- [ ] Replace JSON snapshots with a transactional, append-only event store
- [x] Add legacy file migration, strict state-schema validation, one rotating
  backup, automatic corruption fallback, unreadable-file quarantine, and a
  recovery banner
- [ ] Add a user-driven backup browser, restore workflow, and retention policy
- [ ] Resume interrupted runs safely without duplicating side effects
- [x] Add portable JSON import/export, Markdown export, and task deletion
- [x] Add task archive/restore, active/archive search, and safe fork
- [x] Add explicit controls for including imported history in later model context

### Public release engineering

- [ ] Name maintainers and private conduct/security contacts
- [ ] Pin supported Node, Electron, provider API, CLI, and operating-system ranges
- [x] Generate and CI-check `THIRD_PARTY_NOTICES.md` from the locked production
  graph
- [x] Add native-runner unsigned preview packaging for macOS, Windows, and Linux
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

## Non-goals

- Requiring a Ground account or hosted model relay
- Treating every OpenAI-shaped endpoint as feature-equivalent
- Claiming control over actions performed internally by an arbitrary native CLI
- Storing a provider credential in renderer-accessible state
- Making readable task history depend solely on provider-owned continuation data

Once the repository is published, roadmap work should be represented by linked
issues or milestones rather than silently changing this file.
