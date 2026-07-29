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
stored secret, prepared action envelope, or tool implementation. It requests
actions and presents main-process state. It currently returns approval decisions
and terminal input through trusted IPC, so compromise of the expected renderer is
not equivalent to compromise of an arbitrary web origin but remains a
high-authority threat. New terminal creation is a separate native exact-launch
confirmation; later terminal input remains renderer-driven through a short-lived
opaque attachment capability.

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

## Provider-neutral core

The experimental core under `src/main/agent/` defines:

- distinct model and agent-runtime contracts;
- explicit capability descriptors;
- JSON-safe canonical conversation items;
- versioned provider-owned opaque state;
- typed provider error categories;
- an adapter registry; and
- a strict model-event reducer that accepts interleaved output parts and exactly one
  terminal response.

The core has no Electron or React dependency. Protocol implementations may use
provider libraries internally, but their public boundary is Ground’s canonical
contract.

Production model composition constructs a deterministic source-trusted registry,
maps each provider profile to one adapter ID and secret-reference-only
configuration, validates that configuration, and injects the resulting factory
into `RunManager`. No provider code is discovered or loaded dynamically. A
downstream build can register another reviewed model adapter without changing the
event reducer or managed context/tool/MCP loop. A new first-class profile kind or
provider-specific UI still requires changes at the shared schema and desktop
composition boundaries.

The `AgentRuntimeAdapter` registry remains a forward contract. The current desktop
CLI path uses the bounded launcher and recognized/generic parsers directly, so a
new structured CLI dialect still requires a source change.

## Data ownership

| Data | Owner | Current storage |
| --- | --- | --- |
| Workspace grant | Ground main process | Canonical path grant restored from task state |
| Task timeline and per-item provider attribution | Ground | Bounded schema-normalized atomic state + one validated previous snapshot |
| Provider profile | Ground | Bounded atomic state + backup, without key material |
| MCP server profile and trusted definition fingerprints | Ground | Bounded atomic state + backup |
| API credential | User / configured provider | Strict private vault containing Electron `safeStorage` ciphertext |
| CLI profile environment values | User / configured runtime | One fingerprinted `safeStorage` vault record; names and opaque revision only in provider state |
| Normalized model output | Ground | Task timeline |
| Native CLI session ID | External runtime, referenced by Ground | Provider/task-scoped runtime metadata |
| Provider-owned message-part state | Owning model adapter | Bounded JSON-safe opaque state, replayed only by that adapter |
| Adapter continuation checkpoint | Owning model adapter | Extension contract only; no built-in adapter currently emits one |
| MCP connection and discovered live tool state | Ground main process | Memory; rebuilt on connection |
| Terminal session and scrollback | Ground main process | Memory; disposed on app shutdown |
| Git status, diff, and history views | Repository, derived by Ground | Read live; not copied into task state |
| Managed worktree contents | User / Git | Dedicated local Ground worktree root |
| Portable task bundle / Markdown transcript | User | User-selected file outside Ground’s state store |
| Unreadable state quarantine | User / Ground recovery | Application-data directory until manually removed |

A CLI session is resumed only when its adapter, provider revision, workspace, and
task mode still match. Otherwise Ground starts a new runtime session and supplies
bounded readable history.

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

Persisted assistant messages and activities are attributable to a task, run,
provider, and model. Model history and native runtime-session records additionally
bind provider revision, workspace, mode, and—when available—runtime session.
Built-in model adapters resume from normalized history; provider-owned message-part
state is replayed only through its owning adapter.

## Local workspace services

### Terminal

`TerminalService` owns real `node-pty` sessions in the main process. A terminal can
start only after the workspace grant registry authorizes and canonicalizes its
working directory and a native dialog confirms the exact fixed system shell,
arguments, and cwd. The preload exposes bounded
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

`GitWorkspaceService` pins a canonical repository root, a resolved system Git
executable, and a dedicated Ground worktree root outside the repository. It exposes
bounded status, staged/unstaged diff, log, selected-path stage/unstage, exact-tree
commit, and managed-worktree create/list/remove operations. Git runs with fixed
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
`commit-tree`, then conditionally advances `HEAD` only if the confirmed parent still
matches; hooks and signing are disabled, and concurrent index/working-tree edits
remain outside that commit. Removal is limited to a clean, registered worktree
inside Ground’s managed root and detaches linked tasks without deleting their
history. Revert/reset, remote operations, signed commits, dirty force-removal, and
arbitrary worktree deletion are not exposed.

## MCP host

`McpManager` persists server profiles and coordinates enabled-server startup
without failing the app when one connection fails. `McpService` supports
unauthenticated remote Streamable HTTP and local stdio. Remote cleartext is
loopback-only and redirects fail; stdio uses an absolute executable, argv without a
shell, a reduced environment, bounded JSON-RPC, and lifecycle cleanup.

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
with its server, tool, definition fingerprint, and complete JSON arguments, and the
main-process service rejects execution without explicit approval. Results are
JSON-normalized, bounded, and stripped of MCP Apps/UI material.

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
active or archived tasks.

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
context reconstruction. If the provider hint exactly matches a configured API
profile, the portable canonical conversation can seed a subsequent explicit run.

`StateStore` applies a 128 MiB ceiling and validates the full persisted schema
before each replacement. Reads require a regular file, refuse symlinks where the
platform supports no-follow opens, stream within the ceiling, and reject malformed
UTF-8. Writes use unpredictable exclusive `0600` temporary files, fsync their
contents, rotate only a schema-valid prior primary to `.bak`, atomically rename the
new primary, and sync the directory where supported. Startup falls back to the
single backup when possible, quarantines unreadable files, and reports backup
restore or clean-state fallback through an ephemeral renderer banner. This is
crash recovery, not a transactional event log, multi-version backup system, or
user-driven restore browser.

`SecretVault` separately bounds and validates the encrypted credential map, rejects
symlink/non-regular vault files, uses private exclusive atomic replacement, and
quarantines unreadable data. It refuses credential writes when Electron encryption
is unavailable and treats Linux’s `basic_text` fallback as unavailable. API keys
are addressed by an opaque hash of provider ID, protocol, and canonical endpoint.
A boundary change writes the new reference, persists the new provider profile, and
only then garbage-collects the old reference, so an interrupted transition cannot
redirect the replacement key to the old endpoint.

Each optional CLI profile environment is a single versioned, fingerprinted vault
record addressed by an opaque hash of provider ID. Provider state holds sorted
variable names and a random 256-bit revision, never values. Save/delete operations
roll the vault record back when the corresponding state write reports failure.
Runtime resolution requires the encrypted record’s variable set and revision to
match the provider exactly, then binds that non-secret metadata into both native
configuration and final-invocation authorization. A cross-file operating-system
crash can leave a mismatch, which fails closed and requires re-entry rather than
launching with unreviewed values.

## Current composition and migration

The runnable desktop still has a compatibility `RunManager` and atomic JSON
`StateStore`. OpenAI Responses, Anthropic Messages, Google Gemini, and
OpenAI-compatible model adapters are integrated end to end through the
provider-neutral model loop and are resolved through its static adapter registry.
Their tests use mocked transports; CI does not make credentialed live-provider
requests. Recognized CLI adapters normalize events and persist resume metadata,
but do not yet use the experimental agent-runtime registry.

The next storage boundary is a transactional, append-only event store with schema
migrations and materialized task views. Stronger OS-specific confinement,
handle-based executable authority, durable terminal/background-process state,
native write/command/MCP-call approval, and authenticated MCP are still future
execution boundaries.

See [PROVIDER-SDK.md](PROVIDER-SDK.md) for adapter requirements and
[THREAT-MODEL.md](THREAT-MODEL.md) for the security consequences of these ownership
rules.
