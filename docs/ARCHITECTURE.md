# Architecture

Ground separates a durable coding workspace from interchangeable models and
external agent runtimes. The desktop app connects directly to the model endpoint or
executable the user configures; a Ground-hosted relay is not part of the required
architecture.

## Product invariants

- The workspace and readable task history belong to the user, not a provider.
- Ground can switch models without requiring a provider-owned conversation object.
- Secrets never enter renderer snapshots, prompts, logs, or persisted adapter state.
- Workspace and executable authority originates in the main process.
- A permission claim must identify who can actually enforce it.
- Provider-specific acceleration state is optional; losing it cannot make the
  normalized transcript unreadable.
- Portability moves content, never workspace, executable, credential, session, or
  approval authority.

## Trust and process layout

```text
Untrusted presentation
┌─────────────────────────────────────────────────────────┐
│ React renderer                                          │
│ task UI · provider forms · approval presentation        │
└───────────────────────┬─────────────────────────────────┘
                        │ narrow typed preload API
Privileged desktop      ▼
┌─────────────────────────────────────────────────────────┐
│ Electron main process                                   │
│ IPC validation · grants · secrets · storage · policy    │
│                                                         │
│  Ground-managed path          External-runtime path     │
│  model adapter                runtime adapter            │
│       │                            │                     │
│  context + tool loop          event normalization       │
│       │                            │                     │
│  approval/tool/MCP broker      resolved argv spawn       │
│                                                         │
│  PTY service · Git/worktrees · bounded atomic state     │
└───────┼────────────────────────────┼─────────────────────┘
        │ direct API/MCP request     │ local process/stdio
        ▼                            ▼
 configured model/MCP endpoint  configured coding CLI/MCP server
```

The renderer is never the authority for a workspace path, CLI executable identity,
stored secret, prepared action envelope, or tool implementation. Main projects an
explicit task allowlist that replaces canonical paths and provider/runtime sessions
with a fresh process-scoped workspace grant ID plus a path-free display label
derived from the basename. Colliding labels receive an ordinal suffix.
That projection also removes durable managed-execution markers and their action
and approval hashes from task items and live/replayed run events.
Renderer requests resolve that ID back through the live main-process registry.
Workspace-bearing task mutations and privileged operations pass through one
serialized lifecycle gate, including the full duration of native terminal and Git
confirmations, so a workspace cannot be detached or revoked underneath a pending
operation.

Approval requests and terminal input cross trusted IPC, but every positive write,
command, and MCP-call decision must also cross a main-process-owned native dialog
bound to the exact immutable approval envelope. New terminal creation has a
separate native exact-launch confirmation; later terminal input remains
renderer-driven through a short-lived opaque attachment capability.

## Two adapter classes

### Model adapters

`ModelAdapter` represents a model-generation protocol. Ground owns:

- canonical conversation and context selection;
- tool definitions and the multi-step agent loop;
- approval policy and tool execution;
- retries, cancellation, and failure presentation; and
- persistence of normalized output and tool results.

OpenAI Responses, Anthropic Messages, Google Gemini, and OpenAI-compatible/local
endpoints belong in this class.

Provider creation presents three connection paths without changing these ownership
boundaries: Hosted API selects a direct cloud protocol, Local server starts from a
loopback OpenAI-compatible template, and Installed CLI selects an existing external
runtime. The local template is data only; Ground does not install or supervise the
server and does not download models. Passive CLI discovery likewise proves only
that a reviewed executable shape exists in a bounded local install location, not
that it is authenticated, can access a model, or can complete a turn.

For an attached workspace, Ask mode advertises only bounded list/read/search tools.
Agent mode can also advertise approval-gated full writes, exact localized edits,
commands, and definition-trusted MCP tools. The model profile can supply an
explicit context window, maximum output tokens, and optional reasoning effort.
Context selection reserves output and safety headroom, converts the remaining
tokens to a conservative UTF-8 byte budget, keeps recent complete tool exchanges,
and records a timeline notice when guidance, tools, or older items are reduced.
Core read/write/command definitions and a minimum repository-guidance allowance
receive priority in small windows. This byte estimate is safer for multibyte text
than a characters-per-token ratio but is not the model’s exact tokenizer. These
numeric/reasoning settings are user-supplied protocol hints, not model capability
certification.

The renderer’s Ask-to-Agent handoff is a two-step convenience, not a new authority
path. It binds the action to an idle task’s exact non-imported assistant response
and Agent-capable provider, awaits the existing persisted mode update, and fills
only that task’s unsent composer draft. A task switch during the update cannot
redirect the draft or focus. The existing run-start boundary still requires an
explicit Send, exact provider readiness, and the normal managed approvals or
disclosed native CLI permission policy. Model and native runtime continuation
records remain mode-bound and are not reused across the handoff.

Structured Git review can also append the active complete hunk to an unsent
task-local composer draft. The renderer formats the current parsed hunk
synchronously, labels its staged/working provenance, visibly escapes hostile
presentation text, and refuses incomplete, truncated, or over-32,000-character
blocks rather than slicing them. Each loaded Git overview is retained with its
source task ID, hidden on any task mismatch, and remounted across task changes.
The callback carries that exact source task ID; delayed focus additionally binds
the current task-selection epoch and the composer's task identity. This is review
context only: it adds no Git, IPC, provider, approval, or persistence authority,
and provider egress still requires an explicit Send through the normal run-start
boundary.

Provider configuration has a separate persisted readiness state. Saving creates an
unverified provider revision. **Test** can persist `passed` or `failed` only when
the submitted form still exactly matches the complete configuration fingerprint,
and the main-process run boundary requires `passed`. First-class APIs test bounded
model discovery.
OpenAI-compatible profiles prefer `/models` but can fall back to one bounded,
non-streaming four-token generation request when listing does not prove
compatibility. A CLI Test validates resolution and argv construction; it does not
launch an authenticated agent turn. A run reserves the exact task revision,
provider revision/configuration fingerprint, and credential boundary before CLI
authorization or workspace lookup. Provider mutation and verification publication
cannot interleave with that reservation or an active run.

Corrective UI is unlocked by typed main-process evidence rather than renderer
message matching. The bounded taxonomy covers refused connections, DNS, TLS,
authentication, rate limits, Ground-owned probe timeouts, incompatible protocol
shapes, missing executables, and explicit external-runtime startup failures.
Classification uses HTTP status and rate-limit headers, bounded cause-chain codes,
Ground-owned timers, parser sentinels, and executable/process launch errors. Only
the category is added to failed readiness or an error activity. Readiness retains
no diagnostic text; run history keeps its existing bounded, credential-redacted
detail but adds no cause graph, response-body field, or raw structured
provider-code field. Unknown failures retain their bounded diagnostic without
specialized guidance. Enhanced local startup/model/port recovery remains narrower:
it requires an actual refused connection to a literal-loopback endpoint.

### Agent runtime adapters

`AgentRuntimeAdapter` represents an external coding agent. The runtime may own:

- its private context and provider-side session;
- filesystem and command tools;
- sandbox and approval policy;
- plugins, MCP connections, authentication, and telemetry; and
- retry and compaction behavior.

Ground resolves and launches the executable, supplies the selected workspace and
mode, resumes a compatible native session when possible, and normalizes events. A
runtime event saying that a command ran is useful observability; it is not proof
that Ground could approve or prevent the command.

Recognized CLI detection is passive and bounded to conventional system, app-PATH,
and user tool-manager locations. The native executable picker validates a chosen
direct executable or reviewed Windows Node package shim without launching it.
Workspace-controlled candidates are excluded. Saving the template and starting the
fully expanded invocation retain distinct native confirmations; Antigravity’s
1.1.8+ version probe is permitted only after the save confirmation and
revalidation.

## Provider-neutral core

The versioned, framework-independent core under `src/main/agent/` defines:

- distinct model and agent-runtime contracts;
- explicit capability descriptors;
- JSON-safe canonical conversation items;
- versioned provider-owned opaque state;
- typed provider error categories;
- one adapter registry spanning model and agent-runtime IDs;
- strict model- and runtime-event reducers; and
- deterministic adapter conformance helpers.

The core has no Electron or React dependency. Protocol implementations may use
provider libraries internally, but their public boundary is Ground’s canonical
contract. The same canonical source builds the provisional publishable package in
`packages/adapter-sdk/`; Ground does not maintain a second SDK implementation.

Production composition constructs one deterministic source-trusted registry,
registers all built-in model and runtime adapters in a global ID namespace, maps
each provider profile to a registered ID and data-only configuration, validates
that configuration, and injects separate model/runtime factories into
`RunManager`. No provider code is discovered or loaded dynamically. A downstream
build can register another reviewed adapter without changing the canonical event
reducers or managed context/tool/MCP loop. The built-in runtime adapters delegate
to the same bounded, shell-free launcher and recognized/generic parsers used by the
desktop security boundary. A new first-class profile kind, provider-specific UI,
or built-in CLI dialect still requires a reviewed source change and rebuild.

## Data ownership

| Data | Owner | Current storage |
| --- | --- | --- |
| Workspace grant | Ground main process | Canonical path grant restored from task state |
| Task timeline and per-item provider attribution | Ground | Bounded schema-normalized atomic state + three validated retained snapshots |
| Provider profile | Ground | Bounded atomic state + retained snapshots, without key material |
| MCP server profile and trusted definition fingerprints | Ground | Bounded atomic state + retained snapshots |
| API credential | User / configured provider | Strict private vault containing versioned, boundary-scoped Electron `safeStorage` ciphertext |
| CLI profile environment values | User / configured runtime | One fingerprinted `safeStorage` vault record; sorted names plus separate non-secret fingerprint and record revision in provider state |
| Pending secret cleanup journal | Ground main process | Bounded exact vault references in persisted state; excluded from renderer snapshots |
| Normalized model output | Ground | Task timeline |
| Native CLI session ID | External runtime, referenced by Ground | Provider/task-scoped runtime metadata |
| Provider-owned message-part state | Owning model adapter | Bounded JSON-safe opaque state, replayed only by that adapter |
| Adapter continuation checkpoint | Owning model adapter | Extension contract only; no built-in adapter currently emits one |
| MCP connection and discovered live tool state | Ground main process | Memory; rebuilt on connection |
| Terminal session and scrollback | Ground main process | Memory; disposed on app shutdown |
| Git status, diff, and history views | Repository, derived by Ground | Read live; not copied into task state |
| Preferred Git executable path/fingerprint | Ground main process | Private bounded preference; revalidated into process-local authority |
| Git restore recovery payloads | User / Ground recovery | Private local files under Ground’s managed worktree root |
| Managed worktree contents | User / Git | Dedicated local Ground worktree root |
| Portable task bundle / Markdown transcript | User | User-selected file outside Ground’s state store |
| Unreadable state quarantine | User / Ground recovery | Application-data directory until manually removed |

A CLI session is resumed only when its source-registered adapter ID, explicit
session-compatibility ID, complete provider-configuration fingerprint, workspace,
and task mode still match. Legacy Codex, Claude, and Gemini session records migrate
to the adapter identities, but any record without the fingerprint is invalidated.
Generic runtimes never persist opaque sessions. An incompatible record is deleted
before Ground constructs the next prompt. A compatible record is a one-attempt
lease: Ground durably deletes it before launch and persists a replacement only
after canonical completion. Switching back, stopping, failing, or crashing
therefore cannot revive context that skipped intervening normalized history.
Otherwise Ground starts a new runtime session and supplies bounded readable
history. Model checkpoints use the same fingerprint rule.

Each assistant message and runtime/tool activity is stored with the provider name,
kind, model, and provider ID captured when the run begins. A run also captures its
workspace and mode so changing task state cannot relabel or redirect an in-flight
session. When provider-native state cannot be resumed—especially after switching
providers—Ground rebuilds context from normalized messages and matching
tool-call/tool-result activities instead of replaying foreign opaque state.

## Event model

Model streams normalize into response lifecycle, output-part lifecycle, usage,
provider notices, and one terminal response. Text, reasoning summaries, and parallel
tool calls can interleave without relying on provider-specific chunk ordering.

Runtime streams normalize into session identity, assistant deltas, activity
lifecycle, provider notices, usage, and one terminal runtime result.

Canonical validation is necessary but not sufficient for persistence. `RunManager`
treats even a source-reviewed runtime as fallible: configured CLI environment
values and their JSON-escaped forms are stream-redacted across delta boundaries,
activity and notice text is redacted again, and runtime activity IDs become fresh
opaque Ground call IDs. A protected value in runtime/session identity fails the
run instead of becoming resumable state. The built-in CLI launcher independently
redacts its adapter-specific inherited credentials, making the main projection a
second boundary rather than the only one. Model responses receive equivalent
successful-output handling: resolved credentials are stream-redacted from text and
notices, while reflected credentials in tool calls, provider state, checkpoints,
or identity metadata fail closed. Iterator reads race the run signal and transient
runtime progress updates are projected live but coalesced into a terminal durable
snapshot. Cancellation is checked before and after validation, projection,
reducer completion, and every terminal persistence step.

Persisted assistant messages and activities are attributable to a task, run,
provider, and model. Model history and native runtime-session records additionally
bind the complete provider-configuration fingerprint, workspace, mode, and—when
available—runtime session. Built-in model adapters resume from normalized history;
provider-owned message-part state is replayed only through its owning adapter.

Ground-managed writes, commands, and MCP calls use a two-record execution
protocol. Before dispatch, `StateStore.beginManagedExecution` atomically consumes
the pending approval and persists a started marker with the activity/operation ID,
prepared-action SHA-256, and exact native-approval SHA-256. After dispatch,
`completeManagedExecution` accepts only that exact started claim. The run loop does
not create a model tool result or another model request until completion persists.
If completion persistence fails, the started marker remains and the run stops.

## Local workspace services

### Terminal

`TerminalService` owns real `node-pty` sessions in the main process. A terminal can
start only after the workspace grant registry revalidates the main-owned canonical
directory behind the task's opaque grant and a native dialog confirms the exact
fixed system shell, arguments, and cwd. The preload exposes bounded
create/list/attach/detach/input/resize/close operations; output is sequenced and a
bounded UTF-8 scrollback tail can be replayed when the renderer reattaches.

`TerminalAccessRegistry` maps each PTY to a task and issues an opaque attachment
capability bound to one renderer sender. Attaching elsewhere invalidates the prior
capability. Hiding or switching the panel detaches the subscriber without killing
the shell, while task deletion kills that task’s registered sessions. The UI can
create, select, restart, and close multiple sessions within the global bounded
session limit.

PTY sessions are intentionally runtime-only state. They are not written into the
task document and are disposed at app shutdown. Workspace authorization constrains
the starting directory, not the shell’s OS permissions.

### Git and worktrees

`GitExecutableTrustService` builds a bounded candidate list from fixed conventional
locations and absolute entries in the app’s PATH without recursively enumerating
directories. It excludes lexical and canonical paths inside the dynamic set of
configured workspaces. Passive validation creates an immutable process-local
binding over canonical path, content hash, filesystem identity, size, mode, and
timestamps without running the candidate. Windows accepts only direct `.exe`
targets.

`GitExecutableCoordinator` treats a private persisted path/fingerprint as a hint,
not authority. It recreates and exactly revalidates that binding at startup and
before every Git process. The native picker follows the same passive validation,
then a default-cancel main-owned dialog shows path/hash/size/fingerprint. Only
after approval does a bounded `git --version` run establish the required 2.23+
feature level, with revalidation around the probe and preference write. Identity
drift revokes the active binding and evicts cached workspace services.

`GitWorkspaceService` pins a canonical repository root, a resolved system Git
executable, and a dedicated Ground worktree root outside the repository. It exposes
bounded status, staged/unstaged diff, log, selected-path stage/unstage, exact-tree
commit, recoverable selected-path restore/undo, and managed-worktree
create/list/remove operations. Git 2.23 or newer is required. Git runs with fixed
argv, no shell, disabled hooks/global configuration, no pager or prompt, disabled
external diff/text conversion, and bounded time/output.

Status, working-tree diff, and worktree checkout can otherwise execute
repository-defined Git clean/smudge/process filters. Ground first queries the exact
effective `filter.*` driver names, including repository-local includes, without
running them. It then overrides every executable filter slot to a no-op and marks
the driver non-required on that exact Git invocation. Repositories that require
LFS, encryption, or custom content conversion can consequently show raw
pointers/ciphertext, false dirty state, or unusable managed checkout content.

The desktop can create a validated branch in a managed worktree and create a new
Ground task for it. Selected path mutations are prepared in the main process and
confirmed natively. A commit records the exact prepared index tree through
`commit-tree`, binds repository/worktree directory identities plus the exact
checked-out symbolic local ref, and refuses detached HEAD. It then advances only
that approved ref with a non-dereferencing compare-and-swap update if the confirmed
parent still matches. Hooks and signing are disabled, and concurrent
index/working-tree edits remain outside that commit. Removal is limited to a clean,
registered worktree inside Ground’s managed root and detaches linked tasks without
deleting their history.

A selected-file restore can include unstaged tracked files and untracked regular
files. Preparation rejects conflicts, submodules, directories, links, unsafe path
states, stale input, and bounded-size violations. The native review contains the
complete diff/untracked preview and hashes its immutable action. Before changing
the workspace, Ground writes and fsyncs a private recovery manifest, copies tracked
contents, and renames untracked files into a recovery operation beneath the
managed worktree root. `git restore --worktree` returns tracked files to the
current index without altering staged changes. Undo is prepared independently and
proceeds only when the manifest, payloads, parents, and every affected path still
match the expected post-restore state. Partial failure is retained and projected
as recovery-required. Ground also refuses restore/undo while one of its runs or
task terminals is active in the same workspace. Untracked recovery uses an atomic
rename and therefore fails recovery-required rather than copy-and-delete across
filesystems. Arbitrary reset, remote operations, signed commits, dirty
force-removal, and arbitrary worktree deletion are not exposed.

## MCP host

`McpManager` persists server profiles and coordinates enabled-server startup
without failing the app when one connection fails. `McpService` supports
unauthenticated remote Streamable HTTP and local stdio. Remote cleartext is
loopback-only and redirects fail; stdio uses an absolute executable, argv without a
shell, a reduced environment, bounded JSON-RPC, and lifecycle cleanup.

Startup connects remote profiles concurrently but serializes local profiles so
main-owned executable dialogs cannot overlap. `RunManager` awaits that one startup
attempt, with cancellation checks before and after, before assembling the first
managed API tool set. A still-initializing MCP profile therefore cannot disappear
silently from the first model request. Every queued turn re-reads the current
profile; connection, tool listing, and final tool dispatch require its exact
persisted enabled/configuration/trust identity to remain current.

Before the first exact stdio invocation in an app session, a native dialog displays
the executable, content/metadata identity, complete argv, cwd, environment-key set,
and invocation fingerprint. Ground hashes regular executables up to 256 MiB,
revalidates identity around connection/discovery/dispatch and immediately before
spawn, and binds executable + argv + cwd + environment to the stdio tool
fingerprints. POSIX shutdown addresses the detached process group with TERM→KILL;
Windows invokes the system `taskkill.exe /T /F` executable for the exact spawned
PID without a shell and falls back to direct child termination. Both paths are
best-effort cleanup rather than OS sandbox or Windows job-object confinement.

Discovered tools are converted to Ground’s canonical `ToolDefinition` and
namespaced as `mcp__<server>__<tool>`. Ground fingerprints title, description, and
input schema at trust time. Only exact approved definitions enter the model tool
set; refresh detects new or changed tools and blocks them pending reapproval.
Changing the namespace or connection/launch identity clears persisted trust.

Definition trust and execution authority are separate. Every MCP call is presented
with its server, tool, connection/config fingerprint, definition fingerprint, and
complete JSON arguments. The prepared envelope binds the canonical remote URL and
namespace or exact stdio invocation and namespace; the main-process service checks
it after refresh and synchronously at dispatch. Same-server execution and
reconfiguration share one serialized manager queue. Results are JSON-normalized,
bounded, and stripped of MCP Apps/UI material.

This slice is tool-only. It does not implement remote headers/OAuth, resources,
prompts, Apps/UI, or elicitation.

The identity boundary is intentionally described narrowly: executables larger than
256 MiB receive path/metadata identity without a content hash; scripts, packages,
and helpers referenced by an interpreter’s argv are not content-hashed; and the
final process creation is still pathname-based rather than handle-based.

## Task lifecycle, portability, and recovery

Task archive/restore is a persisted reversible state. Archived tasks remain
readable but cannot start runs, change provider/mode/workspace settings, or invoke
new workspace-service actions until restored. Existing PTYs are detached rather
than terminated, so a process already running in that shell can continue at the OS
level. Sidebar search examines bounded recent timeline content and can be scoped to
active or archived tasks. Its keyboard policy operates on the exact filtered task
order used by the current committed render: Enter selects the first result by its
opaque task ID, while Arrow Down and Arrow Up focus the live first and last result
rows. Result identities are not reconstructed from display labels or cached across
renders. Input-method composition, modified combinations, and an empty result set
are inert, and activation clears the query.

Task selection rechecks that opaque ID against the latest renderer snapshot and
applies a functional settings-only update, preserving concurrent task and run-event
changes before delegating to the existing typed main-process selection boundary.
A rejection of the current IPC request causes an authoritative snapshot refresh;
every refresh preserves a task selection that began after that refresh's captured
selection boundary. Post-selection close/return-focus work is bound to the
originating request, task, and user-interaction context so a delayed completion
cannot redirect focus after the user has moved elsewhere.

An explicit fork creates new task/item/run/tool-call identities. It keeps readable
timeline content, the selected provider/mode/workspace, and complete normalized
model tool exchanges, while dropping native CLI sessions, pending approval IDs,
adapter checkpoints, and incomplete call/result pairs. Bounded provider-owned
message-part state remains only where it belongs to a complete canonical exchange.

Version 1 task bundles have a strict JSON Schema and hard serialized/tree/timeline
budgets. Export projects the current task into a provider hint, attributed
timeline, and portable canonical conversation while omitting credentials,
workspace authority, native sessions, provider-owned continuation state, pending
approvals, and original IDs. It rekeys tool calls, removes secret-shaped structured
fields, and replaces the selected absolute workspace path. Arbitrary secrets inside
prose or tool output remain possible and require user review.

Import creates a new task without a workspace, runtime session, or approval
authority. Timeline items are visibly history-only and ignored by normal timeline
context reconstruction. A native-warning-backed per-task control can include them
again. An API hint matches only on its exported public descriptor: type/kind, name,
model, and tool-support flag. A CLI hint matches type/kind, name, model, and adapter.
Provider IDs, endpoints, credentials, and secret revisions are neither exported nor
matched. Only a matching API profile can receive the portable canonical
conversation, and only on a subsequent explicit run while imported-history context
is enabled. Model-session compatibility is bound to that choice, so excluding
history invalidates any continuation that may contain it.

Persisted state is currently schema version 2. A pure migration dispatcher clones
the input and advances exactly one version at a time; the registered v1-to-v2 step
runs before current-schema validation. A newer document, a missing step, or a
migration that skips versions fails closed. `StateStore` applies a 128 MiB ceiling
and validates the full current schema before each replacement. Reads require a
regular file, refuse symlinks where the platform supports no-follow opens, stream
within the ceiling, and reject malformed UTF-8. Writes use unpredictable exclusive
`0600` temporary files, fsync their contents, rotate only schema-valid prior
generations through three retained slots, atomically rename the new primary, and
sync the directory where supported. Startup falls back through the retained
generations, quarantines unreadable files, and reports backup restore or clean-state
fallback through an ephemeral renderer banner.

Retained restore uses a main-derived review descriptor with generation, capture
time, counts, size, and content digest. Requests are single-flight before the native
default-cancel prompt. After confirmation, a process-wide mutation gate drains
admitted renderer work, aborts MCP startup, waits through the manager's bounded
2.5-second shutdown drain, and revalidates the exact selection before publication.
The gate is held through relaunch even if a post-rename fsync or another late
restore step reports failure, preventing stale in-memory services from writing over
a possibly replaced on-disk state.

The Recovery settings pane asks main for renderer-safe metadata through short-lived
opaque IDs. Each selection is bound to the source content digest, schema, size, and
generation; if rotation changes that slot, export or restore fails closed until the
list is refreshed. Main owns the native export path and default-cancel restore
confirmation. Restore accepts only a retained validated generation and a run-start
reservation. After confirmation it seals the application-wide renderer operation
boundary, drains work that entered before the seal, revalidates the content-bound
selection, rotates the current primary into history, repairs interrupted markers,
and keeps the boundary sealed through relaunch. State exports contain no
credential-vault document. This is bounded recovery history, not a transactional
event log or arbitrary snapshot-import system.

Startup converts any unresolved approved started marker to uncertain while
preserving its operation and hashes. It reports the outcome as unknown and adds at
most one bounded interruption summary per affected run. Summary insertion is
capped at 256 entries per task and further limited by the task's remaining capacity
under the persisted 100,000-item ceiling. Recovery clears native runtime sessions
and provider checkpoints while retaining normalized conversation, and does not
replay the action. Older running mutators receive an explicit legacy-untracked
marker without invented action or approval hashes. Recovery is idempotent.

`SecretVault` separately bounds and validates the encrypted credential map, rejects
symlink/non-regular vault files, uses private exclusive atomic replacement, and
quarantines unreadable data. It refuses credential writes when Electron encryption
is unavailable and treats Linux’s `basic_text` fallback as unavailable. Plaintext
passed to `safeStorage` is capped at 768 KiB. Decoded ciphertext is capped at
1 MiB, with a canonical-base64 ceiling of 1,398,104 characters. The whole vault has
a 1,000-entry / 8 MiB steady-state bound and a 2,000-entry / 16 MiB transitional
hard bound, reserving one complete extra generation while replacements stage. The
128,000-byte CLI name/value budget can expand under JSON escaping but remains
inside the plaintext ceiling. A staged write normally requires its declared
obsolete references to project the vault back within steady capacity. If an
interrupted transition already left the vault above steady state, only a strict
non-growing improvement toward that bound is accepted.

Secret replacement and removal use the main-only `pendingSecretDeletes`
write-ahead journal in the same persisted document as provider pointers. It is
bounded to 5,000 unique exact references. Before writing a unique replacement
record, Ground durably journals that new exact reference as provisional cleanup.
One later state transaction publishes the provider pointer, removes the new
reference from cleanup, and journals the exact obsolete references. Batched vault
deletion happens afterward; only a successful deletion is acknowledged out of
state. Clear and provider deletion publish their state change and cleanup intents
in that same transaction. Ground never enumerates the vault and deletes the
complement of current provider state.

A state or vault publication can report an error after its atomic rename may
already have selected the new disk generation. Startup cleanup rethrows either
`StatePersistenceError` or `SecretVaultPersistenceError` and aborts initialization
before any writable service is exposed. At runtime, `StateStore` seals itself before
reporting an ambiguous publication to any caller, and the process-wide application
mutation boundary relaunches; run and MCP error paths may not issue compensating
state writes. A provider-vault ambiguity uses the same process exit instead of an
inverse cross-file mutation. Definite failures before primary publication remain
ordinary operational errors and may be retried. On startup, the selected state
therefore identifies whether the journaled new or old exact reference is
disposable. Cleanup derives live
references from provider metadata without using decryption availability, refuses
to delete a queued live reference, retires that stale intent, and leaves
unjournaled ciphertext untouched. If recovery selected a retained generation or
reset clean state after rejecting saved generations, cleanup is deferred for that
process so an older view cannot delete a value possibly published by the
quarantined primary. Vault-deletion failures leave their intents journaled; other
definite drain failures surface bounded generic recovery guidance, while ambiguous
publication failures abort startup.

Every API key replacement has a unique opaque record revision under the provider
ID, protocol, and canonical endpoint boundary. A versioned API profile resolves
only that exact record. The boundary-scoped legacy record and raw provider-ID
fallback remain live only for a pre-versioned profile; a same-boundary blank save
must read a usable saved value before Ground can publish a versioned replacement.
Separate startup validation reports a missing or undecryptable live credential
without treating temporary keychain failure as proof that any ciphertext is
orphaned.

Each optional CLI profile environment is one fingerprinted envelope addressed by
an opaque hash of provider ID plus a unique random record revision. Provider state
holds sorted variable names, a separate random 256-bit environment fingerprint,
and the record revision—never values. The revision selects the exact vault record;
the fingerprint must match the encrypted envelope and is what native configuration
and final-invocation authorization display and bind. The complete provider
configuration fingerprint includes both fields for continuation compatibility.
Versioned profiles never consult the legacy hashed slot. A full re-entry or
explicit clear therefore succeeds even when old ciphertext cannot decrypt; only a
partial edit that leaves values blank must resolve the exact old envelope.

## Renderer interaction model

The renderer keeps unsent composer drafts in process memory keyed by task, so
switching tasks does not mix text and no draft gains durable authority. A global
command palette provides filterable keyboard actions, traps/restores focus, and
does not interpret command keys while an input method is composing. Modal state
makes the underlying app surface inert. Task search exposes its current bounded
result count and navigation instructions to assistive technology, but this
keyboard baseline is not a complete screen-reader certification.

Assistant streaming remains visually live but uses a separate polite announcer
that batches and normalizes bounded chunks. Timeline following is conditional on
the viewport remaining near the latest output, preserving a reader’s scroll
position. Responsive styles, forced-color treatment, focus-visible states, and
reduced-motion rules are part of the public-preview baseline; they are not a claim of
complete cross-platform accessibility certification.

A Playwright-over-Electron suite drives that real built renderer with the
explicit browser-preview desktop mock. Its 12 scenarios cover palette and
task-search keyboard/focus, including narrow-sidebar focus, provider-form labels
and Chromium constraint validation, local-template/refused-connection recovery
into a detected CLI, task-local drafts, Ask-to-Agent and reviewed-hunk handoffs,
structured Git diff navigation, deterministic send/cancel, archive/search,
responsive settings, reduced-motion CSS, and forced-color connection-path
selection. It does not load production main/preload authority or replace manual
screen-reader/native review.

## Current composition and migration

The runnable desktop uses `RunManager` and an atomic JSON `StateStore`. OpenAI
Responses, Anthropic Messages, Google Gemini, OpenAI-compatible, Codex CLI, Claude
Code, Gemini CLI, Antigravity CLI, and Generic CLI are resolved through one static
adapter registry. All runtime output crosses `AgentRuntimeEventReducer` before
durable task state or renderer events. Recognized CLI adapters normalize
activities, usage, diagnostics, and compatible native sessions while retaining
the existing executable, environment, native-confirmation, cancellation, and
process-tree safeguards. Tests use mocked transports and synthetic or documented
pinned fixtures. A credential-free loopback HTTP/SSE test also drives a real
`POST /v1/chat/completions` through the production OpenAI-compatible AI SDK adapter
with system/user messages, tools, and streamed text. CI does not contact a real
cloud, Ollama, or LM Studio deployment, make a paid request, or launch an
authenticated native coding-agent session.

Native package workflows target macOS arm64/x64, Windows x64, and Linux x64. A
fixed packaged smoke verifies app identity, OS-encrypted vault round-trip, the
fail-closed Cancel result of a real native approval dialog, PTY, Git, exact local
MCP launch/call, process-tree cleanup, and the M1.1 provider/runtime matrix.

The matrix is split into independently required evidence blocks. The positive
provider block saves, persistently verifies, runs, and reloads both a
credential-free token-bound OpenAI-compatible profile and a first-class OpenAI
Responses profile with a synthetic versioned credential, exact Bearer
authorization, and `store: false`. The expected-failure block persists failed
connection readiness with bounded `connection-refused` and `protocol-shape`
kinds for a closed literal-loopback port and malformed compatible
discovery/generation shapes, then proves `RunManager` blocks both before dispatch.
The CLI block resolves the Node interpreter supplied by the outer smoke harness,
creates a token-bound Codex-dialect child, and crosses the production executable,
configuration, invocation, workspace, parser, session, activity, usage, and
durability boundaries. A completed Codex error item must persist as one successful
diagnostic notice while the turn completes.

The unattended CLI fixture cannot click a positive native dialog, so native-smoke
composition substitutes a fail-closed authority that accepts exactly one
configuration and one invocation for the hashed runner, hashed script, argv, cwd,
adapter, and stdin transport. Normal application composition continues to use the
real native dialog. The outer harness separately requires the selected interpreter
hash to equal its own `process.execPath`; the evidence states that human approval,
passive detection, installed/authenticated Codex, vendor sandbox/tool behavior,
live credentials, DNS/TLS, external services, and race-free script-argument
binding against a concurrent same-user replacement were not exercised. It also
does not prove cleanup of a hung or hostile external CLI after abnormal
application exit.

The distributable layer reruns native scope against an extracted macOS ZIP, a
temporarily installed Windows NSIS package, or an extracted Linux AppImage and
emits an artifact-hash-bound evidence record. Release aggregation requires all four
target records, including all provider and CLI subprobes. These are bounded runtime checks,
not signing, notarization, DMG/DEB installation, renderer, accessibility,
live-provider/CLI, or distribution certification.

For the current source, a local macOS arm64 `package:mac` build and unpacked native
smoke passed, including the complete deterministic M1.1 provider/runtime matrix.
Current-source
distributable scope and four-target aggregation have not been run. The older
[four-target Package previews run](https://github.com/AlphaBetSoup789/ground/actions/runs/30473714099)
completed the required macOS arm64, macOS x64, Windows x64, and Linux x64 jobs for
source commit `a3073a8`, but predates the expanded provider/runtime matrix. Its
artifact-bound records prove only the earlier smoke contract and cannot satisfy
the current aggregate. Neither evidence set certifies signing, notarization,
DMG/DEB installation, renderer accessibility, live providers/CLIs, or supported
distribution.

The next storage boundary is a transactional, append-only event store with schema
migrations and materialized task views. Stronger OS-specific confinement,
handle-based executable authority, durable terminal/background-process state, and
authenticated MCP are still future execution boundaries.

See [PROVIDER-SDK.md](PROVIDER-SDK.md) for adapter requirements and
[THREAT-MODEL.md](THREAT-MODEL.md) for the security consequences of these ownership
rules.
