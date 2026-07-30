# Changelog

All notable changes to Ground will be documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Ground will follow semantic versioning after its public contracts and persisted
formats stabilize. The package currently reports version `0.1.0`, but no supported
`0.1.0` release has been published.

## [Unreleased]

### Added

- Initial local-first Electron workspace with persistent tasks and provider
  profiles.
- Direct OpenAI-compatible streaming with Ollama and LM Studio presets.
- Ground-managed file/search/full-write/localized-edit/command tools with inline
  approvals for side effects. Localized edits require an exact source match and are
  unique unless replacement of every match is requested explicitly.
- Generic CLI execution plus Codex CLI, Claude Code, Gemini CLI, and Antigravity
  CLI 1.1.8+ event parsers, with a documented dependency-free Generic CLI bridge
  example.
- Passive bounded CLI discovery across conventional system and user tool-manager
  paths plus a main-owned native executable picker. Discovery and selection
  validate candidates without launching them; save and run keep distinct native
  confirmations.
- Optional provider-neutral CLI profile environments whose values stay in one
  OS-encrypted, fingerprint-matched versioned vault record while provider state
  exposes only reviewed variable names plus opaque fingerprint and record
  revisions.
- Provider-neutral `ModelAdapter` and `AgentRuntimeAdapter` contracts, capability
  descriptors, typed errors, registry, and strict canonical event reducer.
- Source-trusted static model-adapter registration and an injectable runtime
  factory, with configuration validation before streaming and a documented
  downstream adapter example.
- Direct OpenAI Responses, Anthropic Messages, Google Gemini, and
  OpenAI-compatible model adapters integrated with the desktop provider screen and
  managed run loop, with mocked contract tests.
- Persisted provider readiness: every saved revision becomes unverified, exact
  saved API/CLI tests record pass or failure, and run startup requires a passing
  check. OpenAI-compatible tests fall back from an unavailable `/models` listing
  to one bounded minimal generation probe.
- Structured provider diagnostics for refused connections, DNS, TLS,
  authentication, rate limits, timeouts, protocol shape, missing executables, and
  CLI startup failures. Readiness and failed-run history add only the bounded
  category alongside existing bounded, redacted diagnostics, show shared
  corrective guidance, and never infer a category from display text.
- First-run provider onboarding with explicit Hosted API, Local server, and
  Installed CLI paths. The local path is labeled as a connection template rather
  than a bundled runtime; confirmed refused loopback connections receive targeted
  startup/model/port recovery and passively detected CLI alternatives without
  claiming authentication, model access, or runtime health.
- Ask-mode list/read/search tools and advanced per-provider context-window,
  response-token, and optional reasoning-effort controls.
- Per-message/activity provider attribution and normalized cross-provider
  tool-call/tool-result context.
- Strict version 1 portable task bundles, Markdown transcript export, task import,
  and native-confirmed task deletion. Provider hints expose and match only public
  descriptors: API type/kind, name, model, and tool-support flag, or CLI type/kind,
  name, model, and adapter—not endpoint, provider ID, credentials, or revisions.
- Safe task forks that rekey portable history and strip runtime/approval authority,
  reversible archive/restore, and bounded search across active or archived tasks.
- Keyboard-complete active/archive task search and switching: `Ctrl/⌘ + K`
  reveals and focuses search, Enter opens the first current result, Arrow keys
  enter the exact filtered result list, Escape clears or exits predictably, and
  stale selection work cannot redirect focus across tasks or responsive layouts.
- Reviewable Ask-to-Agent handoff that changes only the exact eligible task,
  prepares an editable task-local implementation draft, and requires a separate
  explicit Send before provider egress or workspace action.
- Structured staged and working-tree diff review with per-file summaries,
  keyboard hunk navigation, hostile-presentation escaping, bounded raw-patch
  fallback, and a reviewed-hunk-to-prompt action that preserves existing draft
  text without applying or sending the patch.
- Draft-only prompt preparation while a task is running or awaiting approval.
  Stop remains the only active-run action, the Send shortcut is inert, task
  switching preserves exact drafts, and nothing queues or steers the current run.
- Three rotating validated state snapshots, automatic fallback from a corrupt or
  missing primary, unreadable-file quarantine, an in-app recovery browser,
  credential-free native export, and native-confirmed retained-snapshot restore.
- An explicit fail-closed persisted-state v1-to-v2 migration dispatcher.
- Multi-session `node-pty` terminals with a session selector, native exact-launch
  confirmation, opaque sender-bound attachments, detach/reattach, restart, and
  termination.
- Git status/diffs/history, selected-path staging/unstaging, exact-prepared-tree
  commits, and clean managed-worktree create/remove, with native confirmations and
  exact-invocation neutralization of repository clean/smudge/process filters.
- Recoverable Git working-tree restore for selected unstaged tracked and untracked
  regular files, including pre-mutation private recovery payloads, staged-content
  preservation, conservative undo, and visible recovery-required state.
- Passive workspace-excluding Git executable discovery plus a native picker and
  default-cancel identity review. The private persisted path/fingerprint is only a
  hint; Ground requires Git 2.23+ after approval and revalidates the exact
  process-local binding before every Git launch.
- Remote Streamable HTTP and local stdio MCP tools with namespaces, schema drift
  review, per-call approval, native local-launch confirmation, executable identity,
  and invocation-bound tool trust.
- Public-project documentation, issue forms, CI, CodeQL, production-license
  inventory, native-runner preview packaging, and a draft release workflow with
  checksums, SBOM, and attestations.
- Reproducible Node.js/npm toolchain checks, strict version-pinned dependency
  install-script approvals, packaged `app.asar` component inventories, verified
  shipped-content SBOM coverage, and deterministic release checksums.
- Native-runner packaged startup and runtime smokes: a private
  main/preload/document readiness handshake plus packaged identity, encrypted-vault
  round trip, fail-closed native approval dialog, PTY, Git, deterministic
  OpenAI-compatible and first-class OpenAI Responses readiness/first-turn paths,
  expected typed `connection-refused` and `protocol-shape` readiness failures, a
  recognized Codex-dialect child with successful non-fatal warning persistence,
  local stdio MCP, and descendant-cleanup probes. Distributable smoke extracts
  the macOS ZIP, temporarily installs/uninstalls Windows NSIS, or extracts the
  Linux AppImage, then binds runtime-evidence records to the exact artifact and
  architecture.
- A four-target packaging-evidence contract for macOS arm64, macOS x64, Windows
  x64, and Linux x64, with release-time evidence inventory, SHA-256 verification,
  independently mandatory provider success/failure and recognized-CLI evidence,
  and an exact binding between the CLI fixture interpreter and its outer smoke
  harness.

### Changed

- Recognized CLI runtimes now use mode-specific permission arguments, normalize
  activity and usage, capture native session IDs, and resume compatible sessions.
- Enabled MCP startup now runs remote connections concurrently, serializes local
  native launch dialogs, and completes before the first managed API model request
  constructs its MCP tool set. Queued startup, tool listing, and final dispatch
  now revalidate the exact current enabled persisted profile.
- Interrupted runs and pending approvals recover into explicit interrupted/error
  timeline state.
- Model-visible tool paths are workspace-relative and sensitive paths are filtered.
- Active runs bind their provider, workspace, and mode for their lifetime; the UI
  blocks changing those execution inputs until the run stops.
- Context selection keeps recent complete tool exchanges within a conservative,
  model-profile-derived UTF-8-byte whole-request budget, preserves core coding
  tools and a repository-guidance allowance, compacts definitions when necessary,
  and reports every managed reduction.
- New tasks remember the most recently selected provider, while legacy state
  migrates deterministically to a valid default.
- Recognized CLI runtime activities now upsert stable native lifecycle identities
  and unfinished rows are terminalized when a run completes, fails, or stops.
- Renderer streaming uses task-addressed cancellation, monotonic event revisions,
  idempotent text offsets, and targeted timeline updates so renderer recreation
  cannot duplicate active output.
- The renderer now has a top-level recovery boundary, stronger keyboard/focus
  behavior, responsive provider/MCP/task controls, accessible approval state, and
  reduced-motion/terminal accommodations.
- Add a keyboard command palette, task-local process-memory composer drafts,
  near-bottom-only timeline following, and bounded batched screen-reader
  announcements for streamed assistant text.
- Expand the Playwright-over-Electron renderer interaction suite to thirteen
  scenarios covering command-palette and task-search keyboard/focus behavior,
  accessible provider-form validation, truthful local-provider refusal recovery
  into a detected CLI, task-local and active-run draft preparation, Ask-to-Agent
  and reviewed-hunk prompt handoffs, deterministic send cancellation,
  archive/search, responsive settings and sidebar selection, reduced-motion CSS,
  and forced-color connection-path selection. It uses the explicit browser-preview
  desktop mock and is not production-main/native/provider certification.
- Recover interrupted managed writes, commands, and MCP calls as explicit
  outcome-unknown activity, without automatically replaying the side effect or
  retaining continuation authority.
- A dated credential-free CLI help/source-surface observation records the reviewed
  Codex, Claude Code, Gemini, and Antigravity versions without claiming live
  provider certification.

### Security

- Audit the complete locked dependency tree, including Electron and packaging
  tooling, and generate a release SBOM that identifies the embedded
  Electron/Chromium/Node runtimes, native PTY dependency, and artifact hashes.
- Preserve the Electron license and Chromium's bundled third-party license
  inventory alongside Ground's license and production dependency notices.
- Pin reviewed dependency install scripts and bridge Electron's legacy build
  consumers to the bounded security-fixed `brace-expansion` implementation.
- Pin GitHub Actions to verified commit SHAs, disable persisted checkout
  credentials, minimize job permissions, and gate packaging/publishing through the
  protected `release` environment.
- Fail closed when an Electron preload bridge is unavailable; mock tasks and
  actions now exist only in the explicitly flagged browser preview build.
- Restrict packaged/development renderer origins, navigation, new windows, webviews,
  permission requests, and privileged IPC callers.
- Require main-process workspace grants.
- Bind stored API credentials to a canonical endpoint.
- Strictly validate and bound the encrypted credential map, refuse insecure Linux
  `basic_text` storage, reject vault symlinks, quarantine unreadable vaults, and
  serialize candidate mutations through private exclusive durable replacement.
  Bound each plaintext to 768 KiB, decoded ciphertext to 1 MiB
  (1,398,104 canonical-base64 characters), the steady vault to
  1,000 entries / 8 MiB, and the transitional vault to 2,000 entries / 16 MiB.
- Reconcile provider credential expectations after vault loading, preserve valid
  ciphertext during a temporary keychain outage, and surface recurring recovery
  guidance for missing or unreadable API/CLI secrets.
- Store API keys under opaque provider/protocol/endpoint-bound references so a
  failed profile transition cannot redirect a replacement key to the old endpoint.
- Add a bounded, main-only, state-coupled secret cleanup journal. Queue each unique
  replacement reference before staging it, then atomically publish the provider
  pointer while replacing that provisional intent with exact obsolete references;
  batched deletion happens before journal acknowledgement.
- Drain only journaled non-live references at startup—never an enumerated complement
  of provider state or an inference from decryption failure. Retire queued live
  references without deletion, preserve unknown unjournaled ciphertext, defer
  cleanup after backup/reset recovery, and retain failed vault deletion for a later
  start.
- Treat state or vault persistence publication as ambiguous when its atomic rename
  may have preceded a reported failure. Abort startup reconciliation before
  exposing writable services. At runtime, seal the state store and application
  mutation boundary before run, MCP, provider, or renderer error handling can issue
  a compensating write, then relaunch rather than attempting an inverse cross-file
  mutation; the selected state generation and cleanup journal resolve the
  transition on restart.
- Restrict provider-ID credential fallback to pre-versioned profiles, refuse blank
  same-boundary saves when the exact saved key is unreadable, journal explicit
  deletion cleanup failures, and reserve a complete second bounded vault generation
  for concurrent staged replacements at the maximum provider count.
- Reserve run startup against the exact task revision, provider revision and
  fingerprint, and credential boundary before CLI authorization or workspace
  access; provider save/delete/verification mutations cannot cross that boundary.
- Bind Test publication plus API/CLI continuation to a complete provider
  configuration fingerprint so timestamp reuse cannot validate or resume a changed
  credential/environment.
- Replace renderer-supplied CLI trust with native authorization tied to resolved
  executable metadata and exact configuration.
- Require a second native authorization for each fully expanded CLI invocation,
  binding the raw argv digest, canonical workspace, adapter/parser, prompt
  transport, and content-hashed launch identity. Argument prompts are redacted in
  the dialog but remain bound; stdin prompt content remains process data.
- Launch reviewed npm-style Windows `.cmd`/`.bat` Node shims without `cmd.exe`,
  binding the shim, canonical package script, Node interpreter, and exact argv;
  reject unrecognized batch and PowerShell launchers.
- Remove known permission-bypass flags from recognized CLI adapters.
- Add bounded search/read/provider/CLI/model-output behavior,
  integrity-checked atomic write primitives, exact localized-edit envelopes,
  command timeouts, and termination escalation.
- Restrict CLI inheritance to adapter-specific authentication/configuration plus
  reviewed proxy and CA variables, and redact inherited values across split text,
  diagnostics, and activity output.
- Bind optional CLI environment names and their non-secret environment fingerprint
  into native configuration/invocation grants; use a separate record revision only
  to select the exact encrypted record. Deny process-loader and root/config/temp
  controls, redact every custom value, bound post-redaction output, journal profile
  transitions, and fail closed on vault/profile mismatch.
- Store each CLI-environment replacement under a unique exact revision, never
  fall back from a versioned profile to its legacy slot, permit full re-entry or
  clear without decrypting unreadable old ciphertext, and journal exact plus legacy
  deletion only in the same durable state mutation that publishes the profile.
- Reject plaintext non-loopback provider endpoints, authenticated redirects,
  oversized responses, excessive stream events, and oversized or deeply nested
  provider-owned state.
- Use detached POSIX process groups and shell-free Windows
  `taskkill.exe /T /F` tree cleanup for CLI, managed commands, Git, and local MCP
  cancellation, with a direct-child fallback.
- Wait for bounded active-run cleanup during application quit, and keep signing
  and notarization credentials out of dependency-install steps.
- Bootstrap the checksum-verified Electron 43 runtime explicitly on clean installs,
  require its license inventories before packaging, and make release SBOM identity
  independent of the checkout directory name.
- Constrain the packaged smoke harness to a token-bound OS temporary directory,
  reject caller-controlled executable/environment extensions, and bind its fixed
  MCP fixture to Ground's own packaged runtime.
- Bound persisted and renderer-visible run failure text, scrub exact active API
  credential values from it, and clear those values from memory at run completion.
- Block direct and symlink-aliased access to VCS metadata through Ground-managed
  file tools.
- Revalidate local MCP executable content/metadata around launch, discovery,
  refresh, and dispatch; bind the exact executable/argv/cwd/environment invocation
  into tool trust.
- Require a native confirmation before each new terminal process and an opaque
  attachment capability for subsequent terminal input, resize, detach, or close.
- Neutralize repository-configured executable Git content filters for Ground’s
  working-tree inspection, staging, and managed-worktree paths.
- Bound each persisted state generation to 128 MiB, reject symlink/non-regular
  state files, rotate only schema-valid generations, bind renderer selections to
  opaque content identities, and use private unpredictable fsynced temporary files
  for atomic replacement and export.
- Serialize state mutations with their normalized durable snapshot, publish only
  successful candidates, and distinguish structural corruption from transient I/O.
- Bind Git commits to the confirmed index tree and expected parent, disable hooks
  and signing, bind symbolic checkouts to the exact approved local ref, refuse
  detached-HEAD commits, use a non-dereferencing conditional ref update, and limit
  worktree removal to clean registered descendants of Ground’s managed root.
- Block recoverable Git restore/undo while a Ground run or Ground-managed terminal
  is active in the same workspace.
- Seal the application-wide renderer operation boundary during approved state
  restore, make restore prompts single-flight and content-specific, drain
  already-entered operations, abort MCP startup, wait through its bounded shutdown
  drain, revalidate the opaque generation, and keep changes disabled through
  relaunch or a late publication failure.
- Require Git 2.23 or newer for the recoverable `git restore` surface.

### Verification boundary

- Compatibility and application suites use deterministic local fixtures, mocked
  transports/processes, token-bound loopback provider integrations, a smoke-owned
  recognized-CLI child, and fixed runtime/native package probes.
- No CI check makes a paid live-provider request or certifies an authenticated
  Codex, Claude, Gemini, Antigravity, or Generic CLI agent turn.
- Unsigned preview packages and runtime-evidence records are not signing,
  notarization, accessibility, provider, or distribution certification.
