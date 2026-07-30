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
- Task state is migrated one version at a time, schema-validated before
  replacement, and can fall back through three last-known-good local snapshots
  after corruption or an interrupted replace.
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

Selected Git restore is recoverable rather than destructive-by-default: main
prepares a content-bound review, writes private payloads and a manifest outside the
repository before mutation, and exposes undo only while affected paths still match.
That protects against accidental loss in the reviewed file set; it is not a general
repository backup or rollback mechanism.

The structured diff's reviewed-hunk-to-prompt action remains entirely in the
renderer and cannot mutate Git. It accepts only one complete, non-truncated,
bounded active hunk, marks the captured workspace text as untrusted and
potentially stale, visibly escapes presentation controls, and appends it to the
exact source task's unsent local draft. A task-selection epoch and composer task
identity prevent delayed focus from targeting a different task. Workspace text
can still contain secrets or semantic prompt injection; the user must review the
editable draft and explicitly Send before the existing provider-egress boundary
is crossed.

## Implemented controls

- Packaged renderer content is local; development origins are loopback-only.
- Context isolation, restricted navigation, a narrow preload bridge, and strict IPC
  caller validation reduce renderer authority.
- A six-scenario Playwright-over-Electron suite drives the real built renderer’s
  keyboard/focus, form validation, task-local drafts, cancellation, archive/search,
  responsive layout, and reduced-motion behavior. It deliberately uses the
  browser-preview desktop mock, so it is not evidence for production main/preload
  authority or native approvals.
- Workspace grants and CLI authorization are created in the main process.
  Renderer task DTOs contain only fresh process-scoped grant IDs and sanitized
  path-free labels; canonical paths, runtime sessions, and model continuation
  state are projected out through an explicit allowlist. Durable execution
  markers and action/approval hashes are likewise removed from snapshots and
  live/replayed events.
- Endpoint credentials are bound to a provider kind and canonical endpoint, kept
  out of renderer state, and saved only when Electron secure storage is genuinely
  available. Replacement keys are staged under unique versioned boundary-specific
  references before the profile pointer changes; interrupted writes cannot
  overwrite or redirect the key used by the previously persisted profile.
- Non-loopback plaintext endpoints, embedded endpoint credentials, and redirects
  are rejected.
- Saving resets provider readiness. A Test result is persisted only for the exact
  still-saved configuration fingerprint, and main rejects run startup until it has
  passed.
  OpenAI-compatible testing prefers bounded `/models` discovery and falls back to
  a separate non-streaming four-token generation probe only when listing cannot
  prove success.
- Specialized provider recovery is authorized only by a bounded main-process
  category derived from structured evidence. Persisted readiness and error
  activities can retain that category. Readiness retains no diagnostic text; error
  history keeps its existing bounded, credential-redacted detail but adds no cause
  graph, response-body field, or raw structured provider-code field.
  Renderer-visible prose is not classification input.
- Run startup reserves the exact task revision, provider revision/fingerprint, and
  credential boundary before CLI authorization or workspace resolution. Provider
  saves, deletes, and verification writes cannot cross a starting or active run,
  and startup revalidates again at durable task publication.
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
  grants. Passive CLI detection checks only bounded conventional system, app-PATH,
  and user tool-manager candidates; it never executes or recursively scans them
  and excludes workspace-controlled launch identities. The native picker applies
  the same passive validation and is not itself a trust grant.
  Antigravity's bounded, shell-free version check runs only after the profile
  grant confirms and revalidates that executable. The final grant binds the
  content-hashed launch envelope, raw argv
  digest, canonical workspace, parser dialect, actual source-registered runtime
  adapter ID, prompt transport, profile environment-key set, and opaque
  environment fingerprint before another pre-spawn revalidation. Optional values
  remain in a fingerprint-matched encrypted vault record and never enter
  renderer/provider snapshots. A separate record revision selects that exact
  encrypted record but is not substituted for the fingerprint in either native
  authorization.
- The built-in launcher redacts configured and adapter-specific inherited
  credentials if echoed. After canonical runtime validation, the main-process
  projection independently stream-redacts raw and JSON-escaped configured values,
  replaces provider activity IDs with opaque IDs, rejects protected runtime or
  session identity, and checks cancellation around projection and terminal
  persistence. This limits accidental reflection by a buggy reviewed adapter; it
  does not sandbox adapter code or detect arbitrary secrets the adapter obtains
  outside Ground’s configured resolver.
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
- Ask-to-Agent handoff is bound to the exact task, provider, and non-imported
  assistant response. It changes the persisted mode and prepares an unsent
  task-local draft only; it does not start a run, reuse an Ask-mode provider
  session with Agent authority, or carry an approval forward.
- Provider, workspace, and mode are captured for an active run. Assistant/activity
  items retain per-run provider attribution, and provider switching rebuilds
  normalized tool-call/tool-result context without replaying foreign opaque state.
- Terminal PTYs require an authorized canonical workspace and a native confirmation
  of exact executable/argv/cwd, use bounded input/scrollback and a filtered
  environment, and remain main-process-owned. Opaque sender-bound attachments are
  invalidated on detach or replacement.
- Git passively fingerprints fixed conventional/app-PATH candidates, excludes
  workspace-controlled paths, and validates a native-picked direct executable
  before showing its exact path/hash/size/fingerprint in a default-cancel dialog.
  Only after confirmation does Ground run a bounded 2.23+ version probe. A private
  persisted path/fingerprint is a hint rather than authority; exact process-local
  file identity is recreated and revalidated before every Git launch.
- Git then uses fixed argv, no shell, disabled hooks and user/system configuration,
  bounded time/output, canonical repository roots, and a dedicated contained
  worktree root.
- Git mutations use native default-cancel confirmations. Selected-path
  stage/unstage rejects repository-wide and metadata paths; commits bind the exact
  prepared tree, expected parent, repository/worktree identities, and exact
  checked-out symbolic local ref, refuse detached HEAD, then use a
  non-dereferencing conditional update; removal is clean-only and restricted to a
  registered non-main worktree in Ground’s managed root.
- Git 2.23+ selected-file restore rejects conflicts, submodules, links,
  directories, unsafe/stale path states, and size-limit violations. It fsyncs a
  private manifest and exact pre-mutation payloads, renames untracked files rather
  than deleting them, preserves the index, and offers undo only after revalidating
  every recovery and workspace identity. Restore/undo is blocked while a Ground
  run or terminal is active in that workspace. Cross-volume untracked renames and
  other partial failures are reported as recovery-required.
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
- Remote MCP startup is concurrent while local stdio startup is serialized to avoid
  overlapping native dialogs. Managed API runs await startup before constructing
  their first tool set and recheck cancellation around the wait. Queued startup,
  tool listing, and final dispatch revalidate the exact current enabled persisted
  profile and trust identity.
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
  only after private atomic replacement, and preceded by three validated rotating
  generations. Startup can fall back through them, quarantine structurally
  unreadable files, or open clean state with an in-app recovery notice; operational
  I/O failures propagate.
- State schema version 2 is reached through an explicit v1-to-v2 step. Newer
  versions, missing steps, and migrations that skip a version fail closed before
  the current schema is trusted.
- The recovery browser exposes opaque content-bound IDs and bounded metadata, not
  application-data paths or parse errors. Export destinations and default-cancel
  restore confirmation remain main-owned; the dialog displays the selected
  generation’s main-derived metadata and digest prefix. Restore requests are
  single-flight, accept only a validated retained generation, and reject active
  runs. After confirmation, a process-wide operation gate drains admitted renderer
  work, rejects new work, aborts MCP startup, waits through the manager's bounded
  2.5-second shutdown drain, revalidates the generation, rotates the current primary
  into history, recovers interrupted markers, and remains sealed through relaunch
  even if publication reports a late failure.
- The credential vault is size/schema-bounded, publishes serialized mutations only
  after a durable private replacement, and corrects legacy permissions through the
  no-follow opened handle. Each plaintext is capped at 768 KiB and each decoded
  ciphertext at 1 MiB (1,398,104 canonical-base64 characters). A
  1,000-record / 8 MiB steady-state bound and separate 2,000-record / 16 MiB
  transitional hard bound leave room for one complete staged generation; staged
  writes normally project back inside steady capacity after declared obsolete
  records are removed. An already-transitional vault accepts only a strict
  non-growing improvement toward that bound.
- Secret transitions use at most 5,000 unique exact-reference cleanup intents
  stored in the same state document as provider pointers and never projected to the
  renderer. Ground journals a unique new reference before staging it, then
  atomically publishes the provider pointer while replacing that provisional intent
  with the exact obsolete references. Batched deletion precedes journal
  acknowledgement. Clear and provider deletion publish their state change and
  cleanup intents together.
- Startup drains only journaled references. It derives live references from provider
  metadata without consulting `get`/`has`, never enumerate-sweeps the vault
  complement, leaves unjournaled and unknown-format ciphertext untouched, and
  retires rather than deletes a queued reference that the selected provider state
  still uses. Cleanup is deferred for the process after recovery selects a retained
  backup or resets rejected saved generations to clean state. Vault-deletion
  failures remain journaled. Definite drain failures report generic guidance;
  ambiguous state/vault publication aborts startup before writable services exist.
- A state or vault persistence error can be reported after rename, so publication
  may be ambiguous. Startup reconciliation fails closed. At runtime the state store
  seals itself before propagating ambiguity, run/MCP paths do not issue compensating
  writes, and the process-wide operation boundary relaunches. Provider-vault
  ambiguity takes the same exit rather than issuing another cross-file mutation. On
  restart, the selected state generation determines whether the journaled new or
  old reference is disposable.
- Structurally unreadable vaults are quarantined. Separate read-only startup
  validation checks endpoint-scoped references, raw provider-ID fallback only for
  pre-versioned API profiles, and exact CLI environment envelopes, regenerating
  re-entry guidance while values remain missing. A versioned profile never falls
  back to a stale legacy secret; temporary OS secure-storage unavailability does not
  quarantine an otherwise valid ciphertext document or authorize its deletion.
- CLI environment replacement stages a unique revision-selected record before one
  state transaction publishes it and journals obsolete exact/legacy references.
  The separate envelope fingerprint—not the record revision—binds native
  configuration and invocation authorization. Complete re-entry and explicit clear
  do not decrypt old ciphertext; partial blank-value retention requires the exact
  old envelope and matching names/fingerprint.
- Task forks rekey content and strip sessions, approvals, checkpoints,
  provider-owned state, and incomplete tool pairs. Archived tasks cannot initiate
  new Ground run/workspace actions until restored.
- Portable task bundles have strict version/shape/size limits, strip authority and
  provider-owned state, replace the selected absolute workspace path, remove
  secret-shaped structured fields, and rekey imported IDs. API provider hints match
  only type/kind, name, model, and the tool-support flag; CLI hints match type/kind,
  name, model, and adapter. IDs, endpoints, credentials, and secret revisions are
  not exported or matched, and only a matching API profile can receive imported
  canonical conversation after explicit opt-in.
- Native package evidence is fixed and token-bound. It checks packaged identity, an
  OS-encrypted vault round trip, a production approval dialog’s fail-closed Cancel
  result, PTY, Git, deterministic provider successes and expected failures, a
  smoke-owned recognized Codex-dialect child, exact local MCP launch/call, and
  process cleanup, then repeats that scope against an extracted macOS ZIP,
  temporarily installed Windows NSIS package, or extracted Linux AppImage. The
  positive CLI fixture uses a smoke-only authority restricted to its exact hashed
  runner/script and two launch envelopes; normal application composition retains
  native configuration and invocation dialogs. Release aggregation requires
  artifact-hash-bound records for macOS arm64/x64, Windows x64, and Linux x64. The
  harness accepts no caller-selected executable, arbitrary CLI child, or arbitrary
  MCP server.

## Remaining release controls

- Further narrow same-user preview/execution races with handle-based or
  platform-specific file and executable authority.
- Persist executable trust by code signature or equivalent platform identity and
  run external runtimes in a dedicated constrained helper where practical.
- Replace JSON snapshots with a transactional, sequenced event log and define a
  reviewed import format if externally created state backups are ever accepted.
  The current three-generation workflow is bounded local recovery, not durable
  version history or sync.
- Add securely stored MCP remote authentication/OAuth and, only with explicit
  capability design, resources, prompts, Apps/UI, and elicitation.
- Add stronger isolation options for external CLIs and local stdio servers. PTY
  shells remain explicitly user-authorized native shells rather than sandboxes.
- Redact all diagnostic/support export fields and test prompt-injection cases.
- Expand the fixed unpacked/distributable identity, encrypted-vault, native-dialog,
  PTY, Git, MCP, and process-cleanup evidence into production-renderer interaction,
  accessibility, arbitrary installer/keyring environments, and adversarial
  native-platform certification. DMG and DEB installation remain unexercised.
- Validate the scaffolded native packaging/release jobs, sign and notarize official
  artifacts, define Windows/Linux signing policy, and add a signed updater with
  rollback.

## Abuse cases to test

- renderer from an unexpected origin invokes a privileged IPC method;
- provider base URL changes while a stored API key exists;
- a modified/unsaved provider draft or stale Test result attempts to authorize run
  startup;
- provider redirects an authenticated request;
- workspace file or parent directory becomes a symlink between preview and write;
- target contents change after approval;
- model requests `.env`, SSH keys, cloud credentials, or Terraform state;
- PATH contains a workspace-controlled executable with a trusted command name;
- a native-picked CLI entry, shim, interpreter, or package script resolves inside a
  newly configured workspace;
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
- a discovered or native-picked Git executable changes before/after its version
  probe, preference write, workspace-service creation, or later process launch;
- a selected Git path changes while the native stage confirmation is open;
- a selected Git restore path changes during review, a private recovery payload is
  swapped, a partial mutation occurs, or undo would overwrite a later edit;
- `HEAD` or the Git index changes while a commit confirmation is open;
- a managed worktree becomes dirty, unregistered, or path-swapped before removal;
- an LFS/encryption filter-dependent repository is misread after safe filter
  neutralization;
- Git repository metadata contains control characters or a worktree path escapes
  the managed root;
- provider stream emits malformed, duplicated, reordered, or oversized events;
- registered runtime output reflects a configured secret raw, JSON-escaped, split
  across deltas, or through activity/notice/session identity, then ignores
  cancellation and emits late terminal state;
- a hosted or local API endpoint reflects its resolved credential through split
  successful text, notices, tool arguments, provider state, checkpoints, or
  response identity;
- imported task text prompt-injects a later exact-provider run or includes a secret
  embedded in unstructured prose; the “exact” API descriptor here is only
  type/kind, name, model, and tool-support flag—not endpoint, ID, or credential;
- corrupt primary and every retained state generation fail validation,
  state/vault access fails transiently, a state/vault path is a symlink, or
  deleted content remains in retained generations/quarantine;
- state declares a future/skipped version, a v1 migration produces the wrong
  version, or a valid credential vault is temporarily undecryptable;
- a crash or persistence error lands after provisional secret journaling, vault
  staging, provider-pointer publication, vault deletion, or journal
  acknowledgement—including rename-success/fsync-failure ambiguity;
- startup recovers an older state generation while a newer quarantined generation
  may have published a staged credential, or a stale cleanup intent names a
  currently live exact reference;
- vault cleanup attempts to enumerate and delete unjournaled complement entries, or
  treats a keychain/decryption failure as proof that ciphertext is orphaned;
- a maximum 128,000-byte CLI name/value set expands under JSON escaping to 768,132
  bytes—near but below the 768 KiB plaintext ceiling—or independent encrypted
  inputs exercise the 1 MiB decoded-ciphertext boundary and equal-length base64
  encodings with different decoded lengths;
- task is interrupted while an approval, write, or persistence flush is pending; and
- provider-native continuation data is replayed through a different adapter.

## Explicit non-guarantees

The public preview does not claim:

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
- arbitrary repository rollback, or undo after a recoverable restore’s affected
  path has changed;
- secret-free task exports or prompt-injection-free imported history;
- secure deletion from rotating retained snapshots, quarantine files, Git recovery
  payloads, operating-system snapshots, or user-created exports;
- race-free no-follow semantics for Windows reparse points;
- compatibility with every model behind an OpenAI-compatible endpoint, or live
  certification of any cloud/local provider or authenticated coding CLI; or
- signed release/update integrity.

Security reports follow [SECURITY.md](../SECURITY.md). Data-egress behavior is
documented in [PRIVACY.md](../PRIVACY.md).
