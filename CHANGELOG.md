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
- Generic CLI execution plus Codex CLI, Claude Code, and Gemini CLI event parsers.
- Optional provider-neutral CLI profile environments whose values stay in one
  OS-encrypted, fingerprint-matched vault record while provider state exposes only
  reviewed variable names and an opaque revision.
- Provider-neutral `ModelAdapter` and `AgentRuntimeAdapter` contracts, capability
  descriptors, typed errors, registry, and strict canonical event reducer.
- Source-trusted static model-adapter registration and an injectable runtime
  factory, with configuration validation before streaming and a documented
  downstream adapter example.
- Direct OpenAI Responses, Anthropic Messages, Google Gemini, and
  OpenAI-compatible model adapters integrated with the desktop provider screen and
  managed run loop, with mocked contract tests.
- Ask-mode list/read/search tools and advanced per-provider context-window,
  response-token, and optional reasoning-effort controls.
- Per-message/activity provider attribution and normalized cross-provider
  tool-call/tool-result context.
- Strict version 1 portable task bundles, Markdown transcript export, task import,
  and native-confirmed task deletion.
- Safe task forks that rekey portable history and strip runtime/approval authority,
  reversible archive/restore, and bounded search across active or archived tasks.
- One rotating state backup, automatic fallback from a corrupt or missing primary,
  unreadable-file quarantine, and an in-app recovery notice.
- Multi-session `node-pty` terminals with a session selector, native exact-launch
  confirmation, opaque sender-bound attachments, detach/reattach, restart, and
  termination.
- Git status/diffs/history, selected-path staging/unstaging, exact-prepared-tree
  commits, and clean managed-worktree create/remove, with native confirmations and
  exact-invocation neutralization of repository clean/smudge/process filters.
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
  main/preload/document readiness handshake without browser automation, plus fixed
  PTY, Git, local stdio MCP, and descendant-cleanup probes on macOS, Windows, and
  Linux/Xvfb.

### Changed

- Recognized CLI runtimes now use mode-specific permission arguments, normalize
  activity and usage, capture native session IDs, and resume compatible sessions.
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
- A dated credential-free CLI help-surface observation records the locally
  inspected Codex, Claude Code, and Gemini CLI versions without claiming live
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
- Store API keys under opaque provider/protocol/endpoint-bound references so a
  failed profile transition cannot redirect a replacement key to the old endpoint.
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
- Bind optional CLI environment names and their non-secret revision into native
  configuration/invocation grants; deny process-loader and root/config/temp
  controls, redact every custom value, bound post-redaction output, roll back
  failed profile mutations, and fail closed on vault/profile mismatch.
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
- Bound persisted state to 128 MiB, reject symlink/non-regular state files, rotate
  only schema-valid backups, and use private unpredictable fsynced temporary files
  for atomic replacement.
- Serialize state mutations with their normalized durable snapshot, publish only
  successful candidates, and distinguish structural corruption from transient I/O.
- Bind Git commits to the confirmed index tree and expected parent, disable hooks
  and signing, and limit worktree removal to clean registered descendants of
  Ground’s managed root.
