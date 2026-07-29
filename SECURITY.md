# Security Policy

Ground is a privileged local desktop application: it can read a selected workspace,
write files after approval, and start approved processes. Treat the current
developer preview as experimental and do not use it on sensitive repositories or
machines without reviewing the limitations below.

## Supported versions

Ground has not made a supported public release.

| Version | Security updates |
| --- | --- |
| `main` / developer preview | Best effort |
| Packaged preview artifacts | Unsupported |

This table will change when the first signed public alpha is published.

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

There is no response-time guarantee during the developer preview. Ground cannot
offer independent escalation while it has one maintainer. Maintainers will publish
acknowledgement and disclosure targets, and add an independent security recipient,
before the first supported release.

## Implemented controls

### Desktop and renderer

- Packaged builds load bundled renderer content; development URLs are restricted to
  HTTP(S) loopback origins.
- Context isolation is enabled, Node integration is disabled, and the preload
  exposes a narrow typed API.
- Browser demo data is compiled only into the explicitly flagged static preview.
  An Electron renderer without its preload bridge fails closed with a fatal screen
  instead of silently selecting mock tasks or actions.
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
  atomic replacement, and quarantines structurally unreadable data.
- Saving fails if secure storage is unavailable. On Linux, Electron’s unencrypted
  `basic_text` fallback is treated as unavailable.
- A saved credential is bound to its provider kind and canonical endpoint. Changing
  either boundary requires the key to be entered again. The ciphertext is stored
  under a boundary-specific opaque reference, so an interrupted provider update
  cannot make the previously persisted endpoint resolve the new endpoint’s key.
- Connection-test bodies and error diagnostics are streamed within fixed limits;
  known submitted keys are redacted if an endpoint reflects them.
- Run failures are bounded before persistence or renderer delivery. Exact API
  credential values resolved for the active run are held only in main-process
  memory, scrubbed from failure text, and cleared when the run ends.
- Ground does not include a hosted provider relay.

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

- Saving a CLI profile natively confirms its resolved, content-hashed launch
  identity and argument template. That configuration grant cannot authorize a run.
- Immediately before every spawn, a separate native authorization binds the
  content-hashed launch identity, fully expanded raw argv, canonical working
  directory, parser dialect, actual source-registered runtime adapter ID, prompt
  transport, profile environment-key set, and opaque environment revision. The
  immutable launch envelope is revalidated again before process creation. A
  custom reviewed adapter delegating to the same dialect receives a distinct
  grant; built-in IDs cannot be paired with another dialect. Changing an encrypted
  environment name or value changes the revision and invalidates both
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
- Recognized Codex, Claude, and Gemini profiles strip known permission-bypass flags
  and select the runtime’s supported Ask/Agent permission mode.
- The child receives a reduced environment and runs with the selected workspace as
  its working directory. Windows retains the system, temporary-directory, profile,
  app-data, `ComSpec`, and `PATHEXT` variables required by Node/npm
  subprocess behavior; unrelated environment variables remain filtered. Optional
  profile variables are encrypted as one fingerprinted vault record; only names
  and the opaque revision enter persisted provider metadata. Values never enter
  renderer snapshots or native dialogs. The launcher redacts them from parsed
  text, diagnostics, activities, and errors if the child echoes them. The
  main-process runtime projection independently stream-redacts raw and JSON-escaped
  configured values across assistant deltas, redacts activity/notice text,
  replaces provider activity IDs with opaque IDs, and fails closed on a
  protected-value-bearing runtime or session identity.
- Custom profile variables cannot override executable-search, loader/interpreter,
  user/config-root, or temporary-root controls. Examples include `PATH`,
  `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `HOME`, `USERPROFILE`, `XDG_*`, and
  `TMP`/`TEMP`/`TMPDIR`. Native CLI credential/config stores remain the default.
- A profile environment change updates the vault and provider metadata with
  rollback on an ordinary write failure. A missing or mismatched encrypted record
  fails closed before launch; an operating-system crash between the two separate
  files can require the user to re-enter the values.
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
- Git is resolved from conventional system locations and invoked directly with
  fixed argv and no shell. Global/system configuration, hooks, pagers, prompts,
  external diff/text conversion, and LFS smudge are disabled for Ground’s Git
  inspection path.
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
- Commits bind the exact prepared index tree and expected `HEAD`, use
  compare-and-swap reference movement, and disable hooks and signing. Concurrent
  index and working-tree edits are preserved outside the approved commit.
- Worktree removal is limited to a clean registered non-main descendant of
  Ground’s managed root and is revalidated after native confirmation.

### Persistence and portable tasks

- The persisted state is bounded to 128 MiB and normalized through its strict
  runtime schema before it replaces the current file. Reads require a regular file,
  use no-follow opens where available, reject malformed UTF-8, and tighten legacy
  permissions through the opened handle.
- Candidate mutations are serialized with their durable write and become visible
  only after success. Writes use private unpredictable exclusive temporary files,
  file fsync, atomic rename, and directory sync where supported.
- Each successful replacement rotates only a schema-valid previous primary file to
  one local `.bak` snapshot. At startup, Ground can restore a valid backup,
  quarantine structurally unreadable files, and display a dismissible recovery
  banner. Operational I/O failures are propagated rather than mislabeled as
  corruption.
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
  store and has a 128 MiB ceiling. The single rotating backup is not a versioned
  backup system or a user-selectable restore UI.
- No-follow file opens are used where the host exposes `O_NOFOLLOW`. Windows
  reparse-point handling does not yet provide an equivalent race-free guarantee
  against a hostile same-user process.
- Deletion is not secure erasure. A just-deleted task can remain in the rotating
  backup until a later successful state write replaces it, and quarantine files,
  filesystem snapshots, and user-created exports can retain content.
- Export filtering is structural, not a general secret scanner. Plain-text prompts,
  pasted credentials, file contents, command output, and tool results can remain in
  a task bundle or Markdown export; users must review exports before sharing.
- Imported canonical conversation is untrusted content and is excluded from model
  context by default. For an exact API-provider match, it can seed a later model
  request only after the user enables the per-task control through a native warning
  and starts a run. It can still carry prompt-injection text even though it carries
  no workspace or execution authority.
- Cloud-provider adapters are covered by mocked protocol and application tests;
  CI does not contain paid-provider credentials or certify live service versions.
- Dependency installation fails closed on unreviewed lifecycle scripts; release
  jobs use the pinned Node/npm toolchain, commit-pinned Actions, non-persistent
  checkout credentials, least-privilege job permissions, and the protected
  `release` environment.
- The repository contains macOS, Windows, and Linux preview packaging plus a
  tag-driven checksum/SBOM/attestation workflow, but no official artifacts have
  been certified or published. Builds are not reproducible and there is no signed
  updater; Windows and Linux signing policy is not defined.
- Package workflows launch the unpacked app through an internal smoke handshake.
  It accepts only a randomized token plus `launch`/`native` scope, constrains its
  result and fresh user-data directory to the matching OS-temporary child, rejects
  extra smoke-control environment, and never accepts a caller-selected executable.
  The driver strips process-loader/Node injection variables before launch. Native
  scope performs only fixed operations there. Its MCP fixture is an exact in-memory
  `-e` program bound to Ground's own packaged executable; the one-shot auto-approval
  cannot authorize a caller-supplied server.
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
- inspected native-platform packages, including packaged PTY and process cleanup;
- verified every package identity extracted from each shipped `app.asar`, then
  published checksums, the runtime-inclusive CycloneDX release SBOM, and build/SBOM
  attestations; and
- documented update-signing and rollback behavior.
