# Threat Model

Ground is a privileged local desktop application. Its central risk is confused
authority: untrusted content influencing secrets, filesystem access, network
credentials, or process execution.

This document separates Ground-managed model tools from external agent runtimes.
They do not share the same enforceable security boundary.

## Security goals

- A renderer outside the expected main frame and bundled/loopback origin cannot
  invoke privileged IPC.
- Secrets and prepared side-effect envelopes remain main-process-only even if
  renderer content is malicious.
- A model cannot access files outside the granted workspace through Ground’s tools.
- Common credentials and account configuration inside a workspace are not silently
  disclosed by built-in read/search tools.
- A side effect shown for approval cannot silently change meaning before execution.
- Credentials are sent only to the canonical endpoint the user authorized.
- External runtime authority is disclosed accurately and never presented as
  Ground-mediated approval.
- Task state is schema-validated before replacement and can fall back to one
  last-known-good local snapshot after corruption or an interrupted replace.
- Imported task content cannot carry workspace, executable, session, approval, or
  credential authority into the receiving installation.

## Protected assets

- provider API keys and local account credentials;
- files outside a granted workspace;
- sensitive files inside a workspace;
- executable and command authority;
- task history, prompts, tool results, and local identity data;
- approval integrity;
- provider/runtime session identifiers and opaque continuation state;
- MCP server profiles, definition-trust baselines, and tool results;
- terminal input/output and Git/worktree metadata; and
- update and release-signing trust.

## Untrusted inputs

- renderer IPC messages, navigation, and DOM content;
- model output and tool arguments;
- provider errors, metadata, redirects, and streamed events;
- CLI stdout/stderr, event streams, installed plugins, and inherited configuration;
- workspace files, filenames, repositories, symlinks, hooks, and binaries;
- MCP servers and tool descriptions;
- imported task bundles, attachments, and future support bundles; and
- network and update responses.

Workspace content is untrusted even when the user selected the directory. A cloned
repository can contain malicious instructions, symlinks, executable names, package
scripts, hooks, and secrets.

## Authority paths

### Ground-managed model

```text
provider output
  → canonical event validation
  → tool schema validation
  → workspace/policy checks
  → user approval for side effects
  → main-process tool execution
```

Ground can enforce this path because the model has no direct filesystem or process
capability.

### External agent runtime

```text
user authorization
  → resolved executable + exact argv
  → external process
  → runtime-owned tools, policy, plugins, and network
  → normalized events for display
```

Ground controls process launch and termination but cannot generally interpose on
the runtime’s internal operations. A working directory is not a sandbox.

### MCP tool

```text
user-configured server
  → main-process transport validation and connection
  → namespaced tool discovery + definition fingerprint
  → exact definition-set approval
  → model tool selection
  → exact connection/tool/argument approval
  → main-process MCP execution + bounded JSON-safe result
```

Definition trust controls which advertised tools a model may request. Per-call
approval controls a particular invocation and is bound to the canonical remote
endpoint or exact local invocation so same-ID reconfiguration cannot redirect it.
Neither mechanism confines a local stdio server process or guarantees that a
remote server’s implementation matches its advertised schema.

### Direct user terminal and Git

The PTY and Git panel are user-driven workspace features, not model tools. The main
process authorizes their workspace and owns IPC/process creation. Every new terminal
launch crosses a native exact-shell confirmation; subsequent interaction uses an
opaque sender-bound attachment. Git uses a fixed, bounded command surface and
neutralizes repository executable content-filter drivers on operations that can
invoke them. The terminal intentionally gives the user an interactive shell and
therefore retains the current account’s OS authority.

## Implemented controls

- Packaged renderer content is local; development origins are loopback-only.
- Context isolation, restricted navigation, a narrow preload bridge, and strict IPC
  caller validation reduce renderer authority.
- Workspace grants and CLI authorization are created in the main process.
  Renderer task DTOs contain only fresh process-scoped grant IDs and sanitized
  path-free labels; canonical paths, runtime sessions, and model continuation
  state are projected out through an explicit allowlist. Durable execution
  markers and action/approval hashes are likewise removed from snapshots and
  live/replayed events.
- Endpoint credentials are bound to a provider kind and canonical endpoint, kept
  out of renderer state, stored under boundary-specific opaque references, and
  saved only when Electron secure storage is genuinely available. Interrupted
  endpoint changes cannot make the old profile resolve the new boundary’s key.
- Non-loopback plaintext endpoints, embedded endpoint credentials, and redirects
  are rejected.
- Built-in filesystem tools use canonical containment checks, reject symlink
  escapes, show workspace-relative paths, and block common sensitive paths.
- Reads, searches, files, diffs, diagnostics, provider streams, model-event
  aggregates, CLI text/events/stdout/stderr, and command output are bounded.
- The managed run loop preserves one immutable write envelope from complete diff
  preview through execution. Canonical target, prior contents, replacement
  contents, and mode are hashed/revalidated before atomic replacement.
- Localized edits require exact old-text matching, reject ambiguous matches by
  default, and use that same immutable prepared-write path.
- It likewise preserves one immutable command envelope containing the canonical
  cwd, resolved executable identity and SHA-256, exact argv, and timeout.
  Executable/workspace identity is revalidated before argv spawning.
- Truncated approval previews are refused. Commands are time-bounded and terminated
  as process groups where supported.
- CLI adapters are argv-spawned with a reduced environment; recognized adapters
  strip known bypass flags and select mode-specific runtime permissions. Saving a
  profile and launching its fully expanded invocation require distinct native
  grants. The final grant binds the content-hashed launch envelope, raw argv
  digest, canonical workspace, adapter/parser, prompt transport, profile
  environment-key set, and opaque environment revision before another pre-spawn
  revalidation. Optional values remain in a fingerprint-matched encrypted vault
  record, are redacted if echoed, and never enter renderer/provider snapshots.
- Custom CLI environment names cannot redirect executable search, dynamic or
  interpreter loading, user/config roots, or temporary roots. Native CLI
  credential stores and the small adapter-specific inherited allowlist remain the
  default. A missing or mismatched profile record fails closed before process
  creation.
- Windows directly launches `.exe`/`.com` targets. Reviewed npm-style Node
  `.cmd`/`.bat` shims are parsed as data and converted to a bound Node/script argv
  launch; other batch and PowerShell launchers are rejected.
- API Ask mode advertises only bounded list/read/search tools. Writes, commands, and
  MCP are Agent-only, and an unadvertised call is rejected.
- Provider, workspace, and mode are captured for an active run. Assistant/activity
  items retain per-run provider attribution, and provider switching rebuilds
  normalized tool-call/tool-result context without replaying foreign opaque state.
- Terminal PTYs require an authorized canonical workspace and a native confirmation
  of exact executable/argv/cwd, use bounded input/scrollback and a filtered
  environment, and remain main-process-owned. Opaque sender-bound attachments are
  invalidated on detach or replacement.
- Git uses a resolved executable, fixed argv, no shell, disabled hooks and
  user/system configuration, bounded time/output, canonical repository roots, and
  a dedicated contained worktree root.
- Git mutations use native default-cancel confirmations. Selected-path
  stage/unstage rejects repository-wide and metadata paths; commits bind the exact
  prepared tree and expected parent; removal is clean-only and restricted to a
  registered non-main worktree in Ground’s managed root.
- Before status, working-tree diff, or worktree checkout, Git filter driver names
  are discovered with non-executing config plumbing and every effective
  clean/smudge/process driver is shadowed by exact command-line no-op overrides.
- MCP remote URLs require HTTPS except on loopback and reject redirects. Local
  stdio uses an absolute executable, exact argv, no shell, a minimal environment,
  bounded protocol lines, and lifecycle cleanup.
- The first exact stdio invocation in an app session requires native confirmation.
  Ground content-hashes regular executables up to 256 MiB, otherwise binds
  canonical path and metadata; argv/cwd/environment complete the invocation
  fingerprint. It revalidates executable identity around connection, discovery,
  refresh, dispatch, and immediately before spawn.
- MCP tools are namespaced and fingerprinted over title, description, and input
  schema. Stdio tool fingerprints also bind the launch invocation. Added/changed
  definitions are blocked pending exact reapproval, connection identity changes
  clear trust, and every invocation requires separate approval.
- Every positive write, command, and MCP-call decision crosses a
  main-process-owned native dialog. The dialog renders control and bidirectional
  characters visibly, displays the exact immutable action envelope, and binds it
  to a SHA-256 identity before one-shot execution can continue.
- Ground durably records a unique operation ID and separate prepared-action and
  native-approval hashes before each managed write, command, or MCP dispatch. A
  terminal tool result reaches the model only after the outcome record persists.
- If Ground restarts after the started record but before the outcome record, it
  marks the outcome unknown, preserves the evidence, clears unsafe continuation
  state, and never retries the action automatically. Legacy running mutators are
  marked untracked/uncertain rather than assigned synthetic approval evidence.
  Recovery summaries are capped at 256 per task and additionally limited by
  remaining capacity under the persisted 100,000-item task ceiling.
- MCP results are JSON-normalized and bounded; Apps/UI material is stripped, and
  elicitation is not advertised.
- Interrupted reads and pending approvals are terminalized explicitly rather than
  presented as successful. Interrupted managed mutations use the stronger
  outcome-unknown recovery above.
- Persisted state is size-bounded, schema-normalized, transactionally published
  only after private atomic replacement, and preceded by one validated rotating
  `.bak` snapshot. Startup can restore that backup, quarantine structurally
  unreadable files, or open clean state with an in-app recovery notice; operational
  I/O failures propagate.
- The credential vault is size/schema-bounded, publishes serialized mutations only
  after a durable private replacement, and corrects legacy permissions through the
  no-follow opened handle.
- Task forks rekey content and strip sessions, approvals, checkpoints,
  provider-owned state, and incomplete tool pairs. Archived tasks cannot initiate
  new Ground run/workspace actions until restored.
- Portable task bundles have strict version/shape/size limits, strip authority and
  provider-owned state, replace the selected absolute workspace path, remove
  secret-shaped structured fields, and rekey imported IDs.

## Remaining release controls

- Further narrow same-user preview/execution races with handle-based or
  platform-specific file and executable authority.
- Persist executable trust by code signature or equivalent platform identity and
  run external runtimes in a dedicated constrained helper where practical.
- Replace JSON snapshots with a transactional, sequenced event log and add a
  user-driven, versioned backup/restore workflow. The current single-snapshot
  fallback is crash recovery, not durable history.
- Add securely stored MCP remote authentication/OAuth and, only with explicit
  capability design, resources, prompts, Apps/UI, and elicitation.
- Add stronger isolation options for external CLIs and local stdio servers. PTY
  shells remain explicitly user-authorized native shells rather than sandboxes.
- Redact all diagnostic/support export fields and test prompt-injection cases.
- Expand the fixed unpacked-app launch/native smokes into installed-artifact,
  renderer-interaction, accessibility, keychain, and adversarial native-platform
  certification.
- Validate the scaffolded native packaging/release jobs, sign and notarize official
  artifacts, define Windows/Linux signing policy, and add a signed updater with
  rollback.

## Abuse cases to test

- renderer from an unexpected origin invokes a privileged IPC method;
- provider base URL changes while a stored API key exists;
- provider redirects an authenticated request;
- workspace file or parent directory becomes a symlink between preview and write;
- target contents change after approval;
- model requests `.env`, SSH keys, cloud credentials, or Terraform state;
- PATH contains a workspace-controlled executable with a trusted command name;
- command or CLI ignores termination and leaves descendants running;
- CLI config changes after trust was granted;
- final CLI argv, prompt placement, workspace, executable, Windows shim, package
  script, or Node interpreter changes after authorization;
- MCP server adds or changes a tool after definition approval;
- MCP definition stays stable while server behavior changes;
- local MCP executable changes in place or spawns an untracked descendant;
- local MCP executable exceeds the hash limit, or an approved interpreter launches
  a changed script/package/helper named only in argv;
- MCP executable pathname is exchanged between final revalidation and spawn;
- Windows MCP server escapes or races `taskkill.exe /T /F` tree cleanup;
- MCP result attempts to inject Apps/UI metadata, oversized data, or elicitation;
- terminal output emits malicious escape sequences or misleading links;
- stale terminal attachment tries to type after detach or another view attaches;
- renderer attempts a terminal launch after the native confirmation is denied;
- repository config races a new content-filter driver between discovery and the
  exact Git inspection invocation;
- a selected Git path changes while the native stage confirmation is open;
- `HEAD` or the Git index changes while a commit confirmation is open;
- a managed worktree becomes dirty, unregistered, or path-swapped before removal;
- an LFS/encryption filter-dependent repository is misread after safe filter
  neutralization;
- Git repository metadata contains control characters or a worktree path escapes
  the managed root;
- provider stream emits malformed, duplicated, reordered, or oversized events;
- imported task text prompt-injects a later exact-provider run or includes a secret
  embedded in unstructured prose;
- corrupt primary and backup state both fail validation, state/vault access fails
  transiently, a state/vault path is a symlink, or deleted content remains in the
  rotating backup/quarantine;
- a provider endpoint change fails between the new credential write and profile
  persistence;
- task is interrupted while an approval, write, or persistence flush is pending; and
- provider-native continuation data is replayed through a different adapter.

## Explicit non-guarantees

The developer preview does not claim:

- confinement of an arbitrary trusted native CLI;
- confinement of an interactive PTY or local MCP stdio server;
- termination of a task PTY merely because its task was archived;
- containment of a compromised expected renderer that can drive the task UI,
  summon a native approval prompt, or drive an already attached terminal;
- protection from a malicious operating-system user or compromised machine;
- safe execution of code the user explicitly approves;
- provider-side privacy, retention, or account security;
- remote MCP privacy, behavior, or identity beyond transport and definition checks;
- handle-based execution of a local MCP executable, content identity for
  interpreter-referenced scripts/helpers or executables over the hash limit, or
  guaranteed descendant-process termination when a process escapes or races the
  POSIX process group or Windows `taskkill.exe /T` tree;
- correct Git working-tree content for repositories that require executable LFS,
  encryption, or custom content filters;
- content-hash binding of a path selected for Git staging (the later commit does
  bind an exact prepared tree);
- secret-free task exports or prompt-injection-free imported history;
- secure deletion from rotating backups, quarantine files, operating-system
  snapshots, or user-created exports;
- race-free no-follow semantics for Windows reparse points;
- compatibility with every model behind an OpenAI-compatible endpoint; or
- signed release/update integrity.

Security reports follow [SECURITY.md](../SECURITY.md). Data-egress behavior is
documented in [PRIVACY.md](../PRIVACY.md).
