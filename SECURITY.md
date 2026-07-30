# Security Policy

Ground is a privileged local desktop application: it can read a selected workspace,
write files after approval, and start approved processes. Treat the current source
project and any unsigned preview as experimental, and do not use either on sensitive
repositories or machines without reviewing the limitations below.

## Supported versions

Ground is an open-source project but has not published a supported binary release.

| Version | Security updates |
| --- | --- |
| `main` source project | Best effort |
| Unsigned/unnotarized preview artifacts | Unsupported |

This table will change only after a reviewed signed release establishes an explicit
support window.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Do not include API keys,
private source, task transcripts, local paths, state files, or diagnostic archives
in any report.

Use Ground’s
[private vulnerability reporting form](https://github.com/AlphaBetSoup789/ground/security/advisories/new)
or choose **Security → Report a vulnerability** in the repository. GitHub keeps
the report private between the reporter and repository administrators. The
bootstrap recipient is
[@AlphaBetSoup789](https://github.com/AlphaBetSoup789), Ground’s repository owner
and initial security maintainer.

Include only the minimum information needed to reproduce the issue:

- affected Ground version or commit;
- operating system and architecture;
- affected provider/runtime type;
- impact and preconditions;
- redacted reproduction steps; and
- a suggested mitigation, if known.

There is no response-time guarantee for the source project or unsigned previews.
Ground cannot offer independent escalation while it has one maintainer. Maintainers
will publish acknowledgement and disclosure targets, and add an independent
security recipient, before the first supported release.

## Implemented controls

### Desktop and renderer

- Packaged builds load bundled renderer content; development URLs are restricted to
  HTTP(S) loopback origins.
- Context isolation is enabled, Node integration is disabled, and the preload
  exposes a narrow typed API.
- Browser demo data is compiled only into the explicitly flagged static preview.
  An Electron renderer without its preload bridge fails closed with a fatal screen
  instead of silently selecting mock tasks or actions.
- The Playwright-over-Electron renderer suite deliberately loads that flagged
  preview build and deterministic desktop mock. It exercises the real React DOM,
  keyboard/focus, native HTML validation, cancellation presentation, task
  lifecycle, responsive layout, and reduced-motion CSS, but does not exercise
  production main/preload authority or native confirmations.
- Dependency install scripts are recorded in a pinned allowlist after review.
  Ground also verifies the compatibility bridge that lets Electron's older build
  tooling consume the security-fixed bounded `brace-expansion` implementation.
- Electron 43 downloads its runtime lazily rather than through a dependency
  lifecycle script. Ground’s own postinstall deliberately executes the exact
  locked Electron installer without a shell, relies on Electron’s checksum
  verification, and then requires the matching runtime plus Electron and Chromium
  license inventories.
- Privileged IPC validates the expected web contents, main frame, renderer URL,
  arguments, and main-process state.
- New windows, navigation, webviews, and renderer permission requests are denied.
- Workspace paths must come from a main-process picker or a restored grant.
  Renderer snapshots receive only a process-scoped opaque grant ID and bounded
  path-free display label derived from the folder basename. Duplicate basenames
  receive an ordinal suffix; canonical paths and runtime/model session bindings
  remain in main-owned state.
- Durable operation markers and prepared-action/native-approval hashes remain
  main-owned evidence. The task snapshot and both live and replayed run-event
  projections strip them before IPC delivery.
- Task attachment/detachment, run start, workspace reveal, terminal launch, and
  Git mutations share a serialized main-process workspace lifecycle. Revocation
  therefore cannot interleave with a pending native dialog and leave a task bound
  to expired authority.

### API connections and secrets

- Non-loopback endpoints require HTTPS.
- Embedded endpoint credentials, query strings, fragments, and redirects are
  rejected.
- Stored credentials are available only in the main process and are encrypted with
  Electron `safeStorage`. The vault is schema/size-bounded, refuses symlink and
  non-regular files where no-follow opens are available, uses private exclusive
  atomic replacement, and quarantines structurally unreadable data. Each UTF-8
  plaintext is capped at 768 KiB and each encrypted binary value at 1 MiB; persisted
  values must also be canonical base64 whose decoded bytes remain within that
  binary cap. Steady state is capped at 1,000 records / 8 MiB of serialized JSON. A
  distinct 2,000-record / 16 MiB hard bound permits a staged generation. Removing
  its explicitly obsolete references must normally project back within the steady
  bound; recovery from an already-transitional vault permits only a strict
  non-growing improvement toward that bound.
- Saving fails if secure storage is unavailable. On Linux, Electron’s unencrypted
  `basic_text` fallback is treated as unavailable.
- A saved credential is bound to its provider kind and canonical endpoint. Changing
  either boundary requires the key to be entered again. Replacement uses a
  state-coupled, main-only `pendingSecretDeletes` journal: Ground durably queues the
  new unique reference as provisional, stages the encrypted value, atomically
  publishes the provider pointer while removing that provisional intent and adding
  only the exact obsolete references, deletes those exact vault records, and
  acknowledges the journal only after deletion succeeds. Clear and provider-delete
  operations atomically publish their provider-state change and exact delete intents
  before vault cleanup. Ground never enumerates the vault and sweeps everything
  outside current provider state.
- Cleanup re-derives the exact live references from the loaded provider state. An
  intent that is live is retired without deleting its record. If startup restored
  an older retained state generation or reset state, the entire journal is deferred
  for that process, no queued ciphertext is deleted, and a notice asks for review
  and another launch. If an atomic state or vault write reports a late error after
  rename may have succeeded, startup aborts before exposing writable services. The
  same ambiguity during an already-running state publication—or a provider-vault
  mutation—seals the store and new renderer mutations, then relaunches; the
  provisional-or-obsolete journal in the disk generation that won is reconciled.
- A pre-versioned API profile with `hasApiKey` may read its unchanged provider-ID
  legacy key only when its exact boundary-scoped record is absent. Test and runtime
  resolution make that fallback read-only: they do not migrate, overwrite, or
  delete it. An explicit same-boundary save can stage a versioned replacement.
  Profiles with a credential revision never fall back, profiles with no key do not
  consult the vault, and a blank same-boundary edit is refused if the applicable
  saved key cannot be decrypted.
- Connection-test bodies and error diagnostics are streamed within fixed limits;
  known submitted keys are redacted if an endpoint reflects them.
- Every save resets provider readiness to unverified. Only a Test result for the
  exact still-saved provider-configuration fingerprint can persist a pass/fail
  record, and run startup requires `passed`. OpenAI-compatible tests prefer bounded `/models`
  discovery and, only when that cannot prove success, issue a separate
  non-streaming four-token generation probe to the canonical
  `/chat/completions` route. Both paths reject redirects and validate bounded JSON
  shapes.
- Provider guidance is selected only from a strict bounded category derived in
  main from structured status/header, cause-code, Ground-owned timer, parser, or
  executable/process-launch evidence. Failed readiness and run activities may
  persist that category. Readiness persists no diagnostic text; run history keeps
  only its existing bounded, credential-redacted detail and adds no cause graph,
  response-body field, or raw structured provider-code field. Display prose
  cannot unlock specialized recovery UI.
- Run startup reserves the exact task revision, provider revision and configuration
  fingerprint, and credential boundary before native CLI authorization or
  workspace access. Provider saves, deletes, and verification writes are excluded
  while that reservation or an active run exists, and startup revalidates the
  binding again before its first durable task mutation.
- Run failures are bounded before persistence or renderer delivery. Exact API
  credential values resolved for the active run are held only in main-process
  memory, scrubbed from failure text, and cleared when the run ends.
- Ground does not include a hosted provider relay.
- A malformed credential-vault document is quarantined and produces a visible
  recovery notice. Provider metadata is reconciled against decryptable
  endpoint-scoped references, legacy API references only for pre-versioned
  profiles, and exact CLI environment envelopes, so missing values continue to
  warn on later starts. A temporary secure-storage outage makes valid ciphertext
  unavailable but does not quarantine it as structurally corrupt.

### Ground-managed tools

- Tool inputs use bounded schemas.
- Model-visible paths are workspace-relative.
- Filesystem targets are canonicalized and checked against the granted workspace;
  traversal and symlink escapes are rejected.
- Common credential, key, environment, cloud-config, and account paths are denied
  to built-in reads and searches.
- File listings, file reads, searches, command output, diagnostics, and previews
  have size limits.
- Full writes, exact localized edits, and commands require a one-time native
  allow-once approval.
- A localized edit requires the old text to match exactly, rejects ambiguity by
  default, and replaces every match only when the model requests that explicitly.
- The managed run loop prepares one immutable write envelope before approval and
  executes that same envelope afterward. It binds the canonical target, previous
  content hash, replacement content hash, mode, and complete diff; any target or
  base-content change blocks execution.
- Commands likewise preserve one immutable envelope from preview through
  execution. It binds the canonical workspace and working directory, resolved
  entry point, content-hashed launch files, exact spawned argv, and timeout, then
  revalidates them before spawning. A recognized Windows Node package shim binds
  the `.cmd`/`.bat` file, canonical package script, and Node interpreter.
- Incomplete or truncated write and command previews cannot be approved.
- Before a managed write or command can execute, Ground atomically consumes the
  pending approval and persists a versioned started claim containing a unique
  operation ID plus separate SHA-256 identities for the prepared action and exact
  native approval. The tool result is not returned to the model until the terminal
  outcome is durably recorded.
- Full replacement and localized edits use the same immutable prepared-write
  envelope, exclusive temporary file, fsync where supported, and atomic rename.
- Ground does not concatenate tool arguments into a shell command. Direct
  executables use argv spawning; recognized Windows Node package shims are parsed
  as data and converted to a direct Node invocation. Other batch and PowerShell
  launchers are rejected. The launched program can still invoke a shell itself
  (notably, npm does so for package scripts). Commands have a bounded timeout and
  escalate termination from `SIGTERM` to `SIGKILL` where supported.
- In Ask mode, API models can receive only the bounded list/read/search tools.
  Writes, commands, and MCP tools are not advertised, and an unadvertised tool call
  is rejected at dispatch.

### External CLI runtimes

- Recognized CLI discovery considers a bounded, non-recursive set of conventional
  system, app-PATH, and user tool-manager locations. It validates candidates
  passively and rejects lexical or canonical paths controlled by a configured
  workspace. The main-owned native picker applies the same passive launch-envelope
  and workspace checks; choosing a file is not a trust grant.
- Saving a CLI profile natively confirms its resolved, content-hashed launch
  identity and argument template. That configuration grant cannot authorize a run.
- Immediately before every spawn, a separate native authorization binds the
  content-hashed launch identity, fully expanded raw argv, canonical working
  directory, parser dialect, actual source-registered runtime adapter ID, prompt
  transport, profile environment-key set, and opaque environment fingerprint. The
  immutable launch envelope is revalidated again before process creation. A
  custom reviewed adapter delegating to the same dialect receives a distinct
  grant; built-in IDs cannot be paired with another dialect. Changing an encrypted
  environment name or value changes the fingerprint and invalidates both
  configuration and invocation grants. An exact fingerprint can be reused only
  within the current app session. Launch files larger than 512 MB are rejected
  instead of receiving a metadata-only grant.
- Argument-delivered prompt text is included in the raw argv digest but replaced
  by a byte-count/hash marker in the native dialog. Stdin prompt content is neither
  displayed nor included in the launch fingerprint; stdin is treated as data, so
  an otherwise identical stdin invocation can reuse its exact app-session grant.
- Ground does not interpret pipes, substitutions, or shell syntax in CLI
  arguments. On Windows, `.exe`/`.com` files are direct launches. Standard
  npm-installed Node `.cmd`/`.bat` shims are parsed and bound to their canonical
  script and Node interpreter, then Node is spawned directly; generic batch and
  PowerShell launchers are refused. The child runtime may still start a shell.
- Recognized Codex, Claude, Gemini, and Antigravity profiles strip known
  permission-bypass flags and select the runtime’s supported Ask/Agent permission
  mode. Antigravity structured output requires 1.1.8 or newer; its bounded,
  shell-free `--version` probe runs only after native save confirmation and
  executable revalidation. Antigravity headless command actions remain
  runtime-owned and are soft-denied unless its own scoped configuration pre-allows
  them.
- The child receives a reduced environment and runs with the selected workspace as
  its working directory. Windows retains the system, temporary-directory, profile,
  app-data, `ComSpec`, and `PATHEXT` variables required by Node/npm
  subprocess behavior; unrelated environment variables remain filtered. Optional
  profile variables are encrypted as one fingerprinted vault record. Persisted
  provider metadata contains the names, a random 32-byte-hex environment fingerprint
  copied into the encrypted envelope as a profile/record match check, and a separate
  random 32-byte-hex record revision used to derive the versioned vault reference.
  Neither identifier is derived from the secret values. The complete provider and
  continuation fingerprint includes both; native configuration and invocation
  authorization bind only the names plus environment fingerprint. The record
  revision selects the exact vault record and does not enter the native dialog.
  Values never enter renderer snapshots or native dialogs. The launcher redacts
  them from parsed text, diagnostics, activities, and errors if the child echoes
  them. The
  main-process runtime projection independently stream-redacts raw and JSON-escaped
  configured values across assistant deltas, redacts activity/notice text,
  replaces provider activity IDs with opaque IDs, and fails closed on a
  protected-value-bearing runtime or session identity.
- Custom profile variables cannot override executable-search, loader/interpreter,
  user/config-root, or temporary-root controls. Examples include `PATH`,
  `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `HOME`, `USERPROFILE`, `XDG_*`, and
  `TMP`/`TEMP`/`TMPDIR`. Native CLI credential/config stores remain the default.
- A profile environment replacement stages a unique versioned record before
  atomically publishing its exact opaque record revision and exact cleanup intents,
  then uses the shared journal to delete and acknowledge the obsolete exact and
  legacy references. Versioned profiles never fall back to the legacy slot. A full
  re-entry or explicit clear does not require decrypting the old record; a partial
  edit with blank retained values does. A missing or mismatched encrypted record
  fails closed before launch.
- Runtime text, total stdout/stderr, event count, event fields, notices, and session
  identifiers are bounded before and after credential redaction. Built-in and
  canonical CLI session IDs use the same restricted 1–200 character form and
  persist only behind an explicit compatibility identity. A compatible session is
  consumed before launch and re-created only after validated completion, so a
  failed, stopped, or crashed turn cannot be skipped by a later resume.
- Successful model output is also a secret boundary. Ground stream-redacts
  credentials resolved for the active request from assistant text and notices.
  Credential-bearing tool arguments, provider state, checkpoints, or response
  identity fail closed instead of entering tools, renderer events, or durable
  continuation state.
- App shutdown aborts every active run and waits up to a bounded shutdown window
  for its provider/process cleanup before Electron exits.

### MCP servers

- Remote MCP uses Streamable HTTP. Non-loopback endpoints require HTTPS and HTTP
  redirects are rejected.
- Local stdio servers are resolved to absolute executables and launched with exact
  argv, no shell, bounded JSON-RPC lines, a minimal environment, and termination
  cleanup.
- Before the first exact stdio invocation in an app session, a native confirmation
  displays the canonical executable, content/metadata identity, complete argv,
  canonical working directory, environment-key set, and invocation fingerprint.
- Regular executables up to 256 MiB are streamed through SHA-256. The executable
  identity also binds canonical path, device, inode, mode, size, modification time,
  and change time. Ground revalidates it after confirmation, around discovery and
  refresh, before each tool dispatch, and immediately before process spawn.
- Stdio tool fingerprints bind both their schema fingerprint and the approved
  invocation fingerprint. An executable or invocation change invalidates the
  effective definition trust and requires reconnect/review.
- Tools are namespaced by server. A server cannot shadow a built-in tool or an
  already connected namespaced tool.
- Ground fingerprints each discovered tool’s title, description, and input schema.
  Models see only definitions whose exact fingerprints were approved. New or
  changed definitions are refreshed and blocked until reapproved.
- Saved definition trust is cleared when the namespace, transport, endpoint,
  executable, or arguments change.
- Definition trust does not authorize execution. Every MCP call separately
  presents the server, tool, fingerprint, and complete JSON arguments in a native
  allow-once approval.
- The approved MCP call is detached and frozen before approval. Dispatch requires
  the same server ID, connection/config fingerprint, original tool name,
  definition fingerprint, and canonical argument hash after refresh and again
  immediately before `callTool`. Approved execution is serialized with same-server
  save/reconnect operations, so reconfiguration cannot redirect a pending call.
- MCP results are converted to bounded JSON-safe values. MCP Apps/UI metadata and
  payloads are not exposed.
- Client elicitation capabilities are not advertised or handled.
- Enabled remote startup connections are bounded and concurrent; local stdio
  startup is serialized so native launch dialogs cannot overlap. `RunManager`
  awaits that initialization before building the first managed API tool set, and
  rechecks cancellation on either side of the wait. Each queued startup turn
  re-reads the saved profile, and listing or dispatching a tool requires the exact
  connected profile identity—including enabled and definition-trust state—to
  remain current. Final dispatch checks that identity immediately before
  `client.callTool`.
- Closing MCP is terminal and bounded. Ground stops admitting work, aborts pending
  connections and connected-client lifecycles, and attempts all client closes in
  parallel. Each client close and pending-connection settlement is capped at 2
  seconds; the manager caps its aggregate wait for service cleanup and queued
  operations at 2.5 seconds before marking runtime state disconnected. Stdio
  transport termination also has bounded TERM/KILL waits. Timeout means Ground
  stops waiting, not that a non-cooperative transport or escaped descendant is
  proven dead.

### Terminal and Git

- A PTY can be created only for a main-process-authorized canonical workspace and
  through trusted IPC. Every new shell requires a native dialog showing its exact
  executable, arguments, and working directory. Terminal input, dimensions,
  session count, and in-memory scrollback are bounded.
- Interactive input/resize/close operations require an opaque attachment capability
  bound to the renderer sender. Switching or hiding the panel detaches it without
  killing the PTY, and a later attachment invalidates the stale one.
- The terminal inherits only a filtered environment, but the shell retains the
  current user’s operating-system permissions.
- Git discovery passively checks fixed conventional locations and absolute
  app-PATH entries without recursively enumerating directories or executing a
  candidate. Lexical and canonical paths controlled by any current workspace are
  excluded. Native selection validates only a direct executable (Windows requires
  `.exe`) and shows canonical path, SHA-256, size, and identity fingerprint in a
  default-cancel dialog. Only after approval does Ground run a bounded
  `git --version` probe and require 2.23 or newer.
- The selected path/fingerprint preference is schema/size-bounded, private,
  no-follow where available, quarantined when malformed, and written with
  exclusive temporary file + fsync + atomic rename. It is not a persisted trust
  grant. A process-local binding covers canonical path, hash, device/inode, size,
  mode, and timestamps; Ground recreates it at startup and revalidates it before
  every Git process launch. Changed/stale paths are revoked and excluded for that
  process.
- The validated Git executable is invoked directly with fixed argv and no shell.
  Global/system configuration, hooks, pagers, prompts, external diff/text
  conversion, and LFS smudge are disabled for Ground’s Git inspection path.
- Before status, working-tree diff, or worktree checkout, Ground enumerates every
  effective repository `filter.*.{clean,smudge,process,required}` driver (including
  local includes) with a non-executing config query and adds exact command-line
  overrides that make its clean/smudge/process slots no-ops and `required=false`.
- Git output and operation time are bounded. Repository and worktree roots are
  canonicalized and revalidated, and managed worktrees must remain inside a
  dedicated Ground-owned root outside the source workspace.
- Staging and unstaging accept selected literal paths only, reject repository-wide
  and VCS-metadata mutations, recheck eligibility after a native default-cancel
  confirmation, and never overwrite working-tree files.
- Adding a reviewed Git hunk to a prompt is not a Git operation. The renderer
  accepts only a complete non-truncated active hunk, builds one visibly escaped
  untrusted-workspace context block of at most 32,000 characters, and appends it
  to the exact source task's unsent process-local draft. It does not invoke a
  provider, tool, approval, or Git mutation; explicit Send remains required.
- Commits bind the exact prepared index tree, repository/worktree identities,
  expected parent, and exact checked-out symbolic local ref. Detached-HEAD commits
  are refused. They use a non-dereferencing compare-and-swap update, and disable
  hooks and signing. Concurrent index and working-tree edits are preserved outside
  the approved commit.
- Worktree removal is limited to a clean registered non-main descendant of
  Ground’s managed root and is revalidated after native confirmation.
- Selected-file restore rejects conflicts, submodules, directories, links, unsafe
  path states, stale previews, and oversized files/sets. Its default-cancel native
  review includes the complete preview plus content-bound action fingerprints.
  Before mutation Ground fsyncs a private manifest and exact payloads under its
  managed root: tracked contents are copied, untracked files are renamed there
  rather than deleted, and `git restore --worktree` preserves the index. Undo
  revalidates every manifest, payload, parent, and post-restore path and refuses to
  overwrite later edits. Destructive restore/undo is refused while a Ground run or
  Ground-managed terminal is active in that workspace. Partial failure remains
  visible as recovery-required.

### Persistence and portable tasks

- Persisted state is schema version 2. A pure one-version-at-a-time dispatcher
  migrates version 1 before current-schema validation; newer versions, missing
  migration steps, and migrations that skip a version fail closed.
- The persisted state is bounded to 128 MiB and normalized through its strict
  runtime schema before it replaces the current file. Reads require a regular file,
  use no-follow opens where available, reject malformed UTF-8, and tighten legacy
  permissions through the opened handle.
- Candidate mutations are serialized with their durable write and become visible
  only after success. Writes use private unpredictable exclusive temporary files,
  file fsync, atomic rename, and directory sync where supported.
- Provider pointer transitions and their exact vault-delete intents are one state
  mutation. The bounded `pendingSecretDeletes` field is never projected through the
  ordinary renderer snapshot, but it is part of persisted state and therefore can
  appear as opaque reference strings in a raw local-state generation export. Such
  an export never contains the separate encrypted vault or plaintext credentials.
- Each successful replacement rotates schema-valid prior generations through
  three local retained snapshots. At startup, Ground can restore a valid generation,
  quarantine structurally unreadable files, and display a dismissible recovery
  banner. Operational I/O failures are propagated rather than mislabeled as
  corruption.
- Recovery IPC exposes short-lived opaque IDs and bounded status/count metadata,
  never application-data paths or raw parser errors. IDs bind an exact slot and
  source digest; a changed generation fails closed. Main owns the native export
  path and default-cancel restore confirmation, which shows the main-derived
  generation, capture time, counts, size, and digest prefix. Restore requests are
  single-flight, accept only a validated retained generation, and reject active
  runs. After confirmation Ground seals the process-wide renderer operation
  boundary, drains already-entered operations, revalidates the exact generation,
  initiates MCP manager shutdown with its 2.5-second aggregate bound, rotates the
  current primary, recovers interrupted markers, and keeps the boundary sealed
  through relaunch, including after a late persistence failure. The MCP bound is
  best effort and does not prove external-process termination. The credential vault
  is separate and is never written to a state export.
- Managed writes, commands, and MCP calls persist an exact started claim before
  the side effect and a completed claim afterward. If startup finds a started
  claim, it preserves both hashes, marks the operation uncertain with an explicit
  outcome-unknown message, clears native CLI continuation and model checkpoints,
  and never automatically retries the action. Legacy running mutators are labeled
  untracked/uncertain without fabricated approval evidence. Interruption summaries
  are capped at 256 per task and further bounded by remaining capacity under the
  persisted 100,000-item task limit.
- Forked tasks receive new task/item/run/tool-call IDs and drop native sessions,
  checkpoints, provider-owned state, pending approval IDs, and incomplete tool
  exchanges. Archived tasks cannot initiate new Ground run/workspace actions until
  restored.
- Portable task imports are strict, versioned, size/shape-bounded JSON. Imports get
  new local IDs and do not receive workspace grants, runtime sessions, pending
  approvals, provider-owned state, or side-effect authority.
- Task bundle exports omit credentials, runtime sessions, provider-owned state,
  absolute workspace authority, and original internal IDs. They redact the
  selected workspace path and secret-shaped JSON fields.
- A portable API provider descriptor contains exactly its `model-api` type,
  protocol kind, sanitized name, model, and `supportsTools`; a CLI descriptor
  contains exactly its `agent-cli` type, `cli` kind, sanitized name, model, and
  normalized adapter. Endpoint, provider ID, credential/key state, CLI launch
  configuration/environment, verification, and continuation state are absent.
  Import matching compares only that exact portable field set. Consequently an API
  descriptor match is not endpoint or credential identity; imported history remains
  excluded by default and the user must review the locally selected provider before
  opting in and starting a request.

## Important limitations

- A trusted external CLI is still native code running with the current user’s
  authority. Its working directory is not an operating-system sandbox.
- Ground cannot mediate a CLI runtime’s internal file, command, plugin, network, or
  account decisions unless that runtime exposes an enforceable protocol.
- Executable trust is not yet persisted as a code-signature identity, and external
  runtimes do not yet run in a dedicated sandboxed helper.
- Interactive PTY shells and local MCP stdio servers also run with the current
  user’s authority. Tool fingerprints constrain model-visible MCP calls, not what a
  server process can do on its own.
- Archiving detaches but does not terminate an existing task PTY. A process already
  running in that shell can continue with the current user’s authority.
- MCP remote authentication headers and OAuth are not implemented. MCP resources,
  prompts, Apps/UI, and elicitation are deliberately unavailable in this preview.
- Local MCP launch grants are in-memory, not code-signature trust. Hashing is
  omitted for executables larger than 256 MiB, which are bound only by canonical
  path and metadata. When an approved executable is an interpreter or package
  launcher, Ground binds the argv text but does not hash scripts, packages, or
  helper executables named by those arguments.
- MCP executable revalidation still ends with a pathname-based `spawn`; a hostile
  same-user process may be able to replace the path between the last check and
  process creation. Ground does not provide handle-based execution confinement.
- POSIX process shutdown targets the detached process group and escalates from
  `SIGTERM` to `SIGKILL`. On Windows, Ground invokes the system
  `taskkill.exe /T /F` executable for the exact numeric child PID without a shell,
  falling back to direct child termination if it cannot launch. This is
  best-effort tree cleanup, not a job-object confinement guarantee: a process can
  escape or race the observed tree.
- Stable executable and schema fingerprints do not prove that a local server,
  remote service, dependency, configuration file, or helper behaves the same.
- The write and command envelopes substantially narrow preview/execution races but
  do not provide an OS sandbox or handle-based executable confinement against a
  hostile same-user process.
- Git staging approval binds selected paths, not working-tree content hashes; the
  latest content at execution is staged. The later commit confirmation does bind an
  exact tree. A same-user process can also race a newly introduced Git filter
  driver between configuration discovery and process spawn.
- Ground can detect its own open task terminals before Git restore/undo, but not
  arbitrary editors or external processes. Moving an untracked file into private
  recovery also requires the workspace and Ground recovery root to support an
  atomic rename (normally the same filesystem); a cross-volume `EXDEV` failure is
  preserved as recovery-required rather than falling back to copy-and-delete.
- Approval requests and terminal input arrive through the trusted renderer bridge.
  Frame/origin checks reject an unexpected renderer. A positive write, command, or
  MCP-call decision cannot resolve until a main-process-owned native dialog shows
  the exact immutable envelope and receives user confirmation; a compromised
  expected renderer can summon that dialog but cannot synthesize its response.
  Native confirmation also protects terminal creation, but the renderer remains
  the interactive terminal after launch and can drive an already attached task
  terminal.
- Workspace grant IDs are process-scoped bearer capabilities, not an OS sandbox.
  A compromised expected renderer can reuse a currently visible grant until it is
  revoked or Ground exits, but cannot submit a new absolute workspace path.
- The structural workspace boundary is not a text redactor. User prompts, model
  input, terminal output, tool results, and imported history can still contain a
  path as ordinary task content. Ground-generated command activity replaces the
  canonical workspace prefix with `<workspace>` while retaining the full exact
  path only in the native approval envelope.
- Task history uses a JSON snapshot rather than a transactional, append-only event
  store and has a 128 MiB ceiling per generation. Three rotating retained
  snapshots and their user-selectable recovery UI are bounded crash recovery, not
  durable version history, sync, or an arbitrary snapshot-import system.
- No-follow file opens are used where the host exposes `O_NOFOLLOW`. Windows
  reparse-point handling does not yet provide an equivalent race-free guarantee
  against a hostile same-user process.
- Deletion is not secure erasure. A just-deleted task can remain in rotating
  retained snapshots until later successful state writes replace it, and quarantine
  files, filesystem snapshots, Git recovery payloads, and user-created exports can
  retain content.
- Export filtering is structural, not a general secret scanner. Plain-text prompts,
  pasted credentials, file contents, command output, and tool results can remain in
  a task bundle or Markdown export; users must review exports before sharing.
- Imported canonical conversation is untrusted content and is excluded from model
  context by default. For an exact API-provider match, it can seed a later model
  request only after the user enables the per-task control through a native warning
  and starts a run. It can still carry prompt-injection text even though it carries
  no workspace or execution authority.
- Provider adapters are covered by mocked protocol/application tests, pinned
  synthetic or documented fixtures, and a credential-free loopback SSE wire test
  through the production OpenAI-compatible HTTP adapter. CI does not contain paid
  provider credentials, contact a real cloud/Ollama/LM Studio deployment, launch
  an authenticated coding CLI, or certify upstream service/runtime versions.
- Dependency installation fails closed on unreviewed lifecycle scripts; release
  jobs use the pinned Node/npm toolchain, commit-pinned Actions, non-persistent
  checkout credentials, least-privilege job permissions, and the protected
  `release` environment.
- The repository contains four native package targets—macOS arm64/x64, Windows
  x64, and Linux x64—plus a tag-driven checksum/SBOM/attestation workflow, but no
  official artifacts have been certified or published. Unsigned-preview workflow
  artifacts are unsupported (and macOS previews unnotarized), builds are not
  reproducible, there is no signed updater, and Windows/Linux signing policy is not
  defined.
- Package workflows launch the unpacked app through an internal smoke handshake.
  It accepts only a randomized token plus `launch`/`native` scope, constrains its
  result and fresh user-data directory to the matching OS-temporary child, rejects
  extra smoke-control environment, and never accepts a caller-selected executable.
  The driver strips process-loader/Node injection variables before launch. Native
  scope performs only fixed operations there: packaged identity, an encrypted
  `SecretVault` set/reload/get/delete round trip, a real production native approval
  dialog aborted to its Cancel result, PTY, Git, the deterministic provider/runtime
  matrix, an exact local MCP launch/call, and process-tree cleanup. The matrix covers
  compatible and first-class OpenAI success, refused-loopback and malformed
  compatible failures, and one smoke-owned recognized Codex-dialect child. Positive
  CLI authorization is confined to a smoke-only authority that accepts exactly the
  hashed runner/script and configuration/invocation envelopes; normal composition
  continues to use the native dialogs. The MCP fixture is an exact in-memory `-e`
  program bound to Ground's own packaged executable; its one-shot auto-approval
  cannot authorize a caller-supplied server.
- A second driver runs native scope against an extracted macOS ZIP, a temporarily
  installed Windows NSIS package (then invokes its uninstaller), or an extracted
  Linux AppImage. Runtime-evidence records bind the package version,
  platform/architecture, fixed checks, security evidence, installation source, and
  exact distributable SHA-256; release aggregation requires all four target
  records. The driver does not install DMG/DEB packages, operate arbitrary
  installers, drive renderer controls, or certify accessibility or live models.
- Linux native evidence requires an encrypted Secret Service backend. Hosted jobs
  supply D-Bus, GNOME keyring, and libsecret; Ground refuses Electron’s
  `basic_text` fallback. That controlled round trip is evidence for the specific
  runner session, not a guarantee about every user keyring configuration.
- Ground has no support-bundle export yet. Redaction must be complete before one is
  added.

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for attacker assumptions,
protected assets, and remaining controls.

## Release security checklist

A public artifact is not an official Ground release until maintainers have:

- enabled private vulnerability reporting and named security contacts;
- run type checking, tests, a locked-tree audit that includes Electron and build
  dependencies, and CodeQL;
- reviewed third-party licenses and generated notices;
- built from a tagged commit in a protected release environment;
- signed and notarized the macOS app;
- inspected native-platform packages, including distributable-bound evidence for
  macOS arm64/x64, Windows x64, and Linux x64, packaged credential-vault and
  native-dialog checks, PTY, Git, MCP, and process cleanup;
- reviewed each target build’s unpacked `app.asar` inventory together with exact
  distributable hashes, then published checksums, the runtime-inclusive CycloneDX
  release SBOM, and build/SBOM attestations; and
- documented update-signing and rollback behavior.
