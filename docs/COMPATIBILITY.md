# Compatibility

Ground is a developer preview. This matrix describes the current source tree, not a
promise that every provider model or CLI version works. Automated, version-pinned
compatibility reports are required before the public alpha.

The first credential-free
[CLI invocation-surface observation](compatibility/cli-help-2026-07-28.md)
records locally installed versions and help-visible flags. It is deliberately
narrower than the required authenticated compatibility report.

## Connection matrix

| Connection | Transport | Permission owner | Resume model | Status |
| --- | --- | --- | --- | --- |
| OpenAI-compatible endpoint | Chat Completions SSE | Ground | Ground history | Integrated |
| Ollama | OpenAI-compatible loopback HTTP | Ground | Ground history | Integrated; model-dependent tools |
| LM Studio | OpenAI-compatible loopback HTTP | Ground | Ground history | Integrated; model-dependent tools |
| OpenAI | Responses API | Ground | Ground history (stateless replay) | Integrated; not live-certified |
| Anthropic | Messages API | Ground | Ground history + owning-adapter part state | Integrated; not live-certified |
| Google Gemini | Gemini API | Ground | Ground history + owning-adapter part state | Integrated; not live-certified |
| Codex CLI | JSON Lines process stream | Runtime | Native session ID | Integrated, unpinned CLI version |
| Claude Code | Streamed JSON process output | Runtime | Native session ID | Integrated, unpinned CLI version |
| Gemini CLI | Streamed JSON process output | Runtime | Native session ID | Integrated, unpinned CLI version |
| Generic CLI | Plain text or JSON Lines | Runtime/unknown | New process per turn | Integrated, limited semantics |

Status terms:

- **Integrated** means the desktop UI can save the connection and the live
  `RunManager` can execute it.
- **Not live-certified** means mocked protocol and application tests pass, but CI
  has not made credentialed requests to a pinned live cloud-provider version.
- **Unpinned CLI version** means event fixtures exist but a published minimum/maximum
  version range has not been certified.

Reviewed downstream builds can statically register another `ModelAdapter` and map
an existing model profile envelope to it without changing the canonical run loop.
This is source integration, not an end-user plugin format or stable package ABI.
New first-class profile fields and structured CLI dialects still require source
changes; the experimental `AgentRuntimeAdapter` registry is not yet the desktop CLI
composition path.

An OpenAI-shaped endpoint is not assumed to support tools, strict schemas,
reasoning, images, usage, or every streaming event. Configure tools only when the
selected server and model implement them.

API profiles can optionally set the context-window estimate, maximum response
tokens, and low/medium/high reasoning effort. Ground uses the first two to reserve
request headroom, bounds the remainder as UTF-8 bytes, and sends the latter two only
when configured. Defaults are conservative protocol estimates, not discovered
model limits or tokenizer results; a server can still reject an oversized request
or unsupported output/reasoning parameters. Ground currently requests sequential
tool calls even though the normalized event contract can represent parallel calls.

When switching providers, Ground preserves readable messages, labels assistant and
activity items with the provider captured for that run, and reconstructs normalized
tool-call/tool-result pairs. Provider-owned options attached to message parts—such
as reasoning signatures—are replayed only to their owning compatible adapter.
Built-in OpenAI support uses stateless normalized-history replay with remote
response storage disabled; it does not advertise or use `previous_response_id`.
The extension contract can carry a bounded checkpoint for a future adapter, but no
built-in adapter currently emits one.

## Workspace integration matrix

| Feature | Implementation | Current status | Important limit |
| --- | --- | --- | --- |
| Interactive terminal | `node-pty` system shell + xterm.js | Integrated | Native launch confirmation; in-memory sessions; current-user OS permissions |
| Git status | Porcelain v2 branch/ahead/behind and file states | Integrated | Canonical repository root required |
| Git diff | Bounded staged and unstaged unified diff | Integrated | No semantic/binary diff |
| Git stage/unstage | Selected literal paths + native confirmation | Integrated | No repository-wide selection or metadata paths |
| Git commit | Exact prepared tree + conditional `HEAD` update | Integrated | Hooks/signing disabled; no amend/merge workflow |
| Git history | Bounded local log parsing | Integrated | No signature verification or remote operations |
| Managed worktrees | Dedicated Ground root, branch creation/new task, clean registered removal | Integrated | No dirty force-removal or arbitrary worktree deletion |
| Agent `run_command` | Immutable content-hashed launch envelope + exact argv | Integrated | Inline approval; current-user permissions; Windows supports direct executables and recognized Node package shims |
| Remote MCP | Streamable HTTP | Integrated, unauthenticated | HTTPS except loopback; no headers or OAuth |
| Local MCP | Resolved stdio executable and argv | Integrated | Native exact-invocation confirmation; current-user OS permissions; not sandboxed |
| MCP tools | Namespaced canonical definitions | Integrated | Tools only; no resources, prompts, Apps/UI, or elicitation |
| Task portability | Strict JSON bundle + Markdown transcript | Integrated | User must review exports; imported content is untrusted |
| Task lifecycle | Safe fork, archive/restore, bounded active/archive search | Integrated | Imported-history context has no separate toggle |
| State recovery | Bounded atomic primary + one rotating validated backup | Integrated | Automatic fallback only; no backup browser/manual restore |

State and credential-vault readers use `O_NOFOLLOW` where the host exposes it.
Windows does not yet have equivalent race-free reparse-point handling in Ground;
the same-user path-swap limitation is documented in the threat model.

MCP definition approval fingerprints each tool’s title, description, and input
schema. A refresh blocks added or changed definitions until exact reapproval, and
connection identity changes clear stored trust. This is separate from per-call
approval: every model-requested MCP invocation still shows the complete arguments
and must be approved individually.

For local stdio, Ground also fingerprints the exact executable/argv/cwd/environment
invocation, content-hashes regular executables through 256 MiB, confirms the first
exact invocation natively, and binds that identity into tool trust. Large
executables use metadata without a hash; interpreter arguments do not content-hash
the referenced script/package/helpers; spawn remains pathname-based; and process
tree shutdown remains best effort. Windows uses the system `taskkill.exe /T /F`
path for the exact spawned PID and falls back to direct child termination.

The terminal starts only in an authorized canonical workspace after a native dialog
shows the exact fixed system shell, arguments, and cwd. It uses a filtered
environment, bounded input/scrollback, multiple selectable sessions, and explicit
detach/restart/close operations. Renderer operations require an opaque sender-bound
attachment; detaching preserves the PTY. It is a genuine PTY, not a shell emulator
or a sandbox.

Ground’s Git path resolves a system Git executable, disables hooks, global/system
configuration, pagers, prompts, external diff/text conversion, and LFS smudge, and
bounds process time and output. For status, working-tree diff, staging, and
worktree checkout/removal, it queries effective repository filter drivers and
overrides clean/smudge/process to no-op on the exact invocation. This prevents
filter-command execution but can expose LFS pointers, encrypted content,
unexpected dirty state, or unusable checkouts in filter-dependent repositories.

Worktree destinations are confined to a dedicated Ground root. Selected-path
staging/unstaging receives a native confirmation. Commits bind the exact prepared
index tree and expected parent, disable hooks/signing, and leave concurrent
index/working-tree edits alone. Removal is available only for a clean registered
worktree under Ground’s managed root. The desktop does not expose revert/reset,
remote operations, signed commits, dirty force-removal, or arbitrary worktree
deletion.

## Ground-managed tool modes

| Mode | Built-in API tools | MCP tools | Side effects |
| --- | --- | --- | --- |
| Ask | `list_files`, `read_file`, `search_files` | Not advertised | No write or command dispatcher |
| Agent | Ask tools + `write_file`, `edit_file`, `run_command` | Definition-trusted tools | Every write/edit, command, and MCP call requires approval |

Recognized external CLIs have their own mode mapping below; Ground cannot interpose
on their internal tools.

## Runtime behavior

Recognized CLI runtimes receive adapter-specific arguments:

| Mode | Codex CLI | Claude Code | Gemini CLI |
| --- | --- | --- | --- |
| Ask | Read-only sandbox | Plan permission mode | Plan approval mode |
| Agent | Workspace-write sandbox | Accept-edits permission mode | Auto-edit approval mode |

Ground strips known permission-bypass flags from recognized profiles. These modes
are still implemented by the external runtime, not enforced by Ground. Runtime
upgrades can change flag and event behavior; compatibility fixtures must be pinned
before release.

Every CLI run has a native final-invocation grant distinct from the saved profile
template. The grant binds the expanded argv, canonical workspace, adapter/parser,
and content-hashed launch identity. Exact grants are memory-only; launch files over
512 MB are rejected. Stdin prompt content is intentionally data rather than process
identity, while argument prompts remain bound through the raw argv digest and are
redacted in the dialog.

On Windows, Ground resolves only reviewed `PATHEXT` types (`.exe`, `.com`, `.cmd`,
and `.bat`). Executables are launched directly. Standard npm-generated Node
`.cmd`/`.bat` shims used by Codex, Claude, Gemini, npm, and similar packages are
parsed into a bound Node interpreter + canonical package script + exact argv;
`cmd.exe` does not interpret those arguments. Unrecognized batch shapes and
PowerShell launchers are unsupported. `npm test` is supported at this launch
boundary, but npm itself intentionally invokes the platform shell for package
scripts, whose contents and descendants remain npm’s responsibility.

Native resume is used only when the stored session belongs to the same adapter,
provider revision, canonical workspace, and task mode. Generic CLIs do not have a
portable resume contract.

## Platform matrix

| Platform | Development | Packaged artifact | Release status |
| --- | --- | --- | --- |
| macOS arm64 | Locally exercised | Unsigned local preview exercised | Not released |
| macOS x64 | CI/source target | Native-runner zip/DMG + unpacked startup/native smoke configured, not certified | Not released |
| Windows x64 | CI/source target | Native-runner NSIS + unpacked startup/native smoke configured, not certified | Not released |
| Linux x64 | CI/source target | Native-runner AppImage/DEB + Xvfb unpacked startup/native smoke configured, not certified | Not released |

The repository CI is configured to exercise type checking, tests, and renderer/main
builds on hosted macOS, Windows, and Linux runners. A separate manual workflow
builds unsigned native preview formats; the tag workflow is scaffolded to require
macOS signing/notarization and emit checksums, an SBOM, and attestations. None of
that is yet a certified packaged-app, keychain, accessibility, installer, signing,
or provider compatibility matrix. The package workflows now include an
unpacked-app main/preload/document handshake plus fixed PTY, Git, stdio MCP, and
descendant-cleanup probes. They do not drive the UI, install distributables,
validate credential stores, or call paid providers/agent CLIs.
Portable unit coverage exercises PATHEXT filtering, current npm shim shapes,
metacharacter-preserving argv, required Windows child environment keys, and the
shell-free `taskkill.exe /T /F` invocation shape. The fixed packaged probe does not
replace a compatibility matrix for installed CLI versions, arbitrary console
behavior, hostile escape from a process tree, or real MCP servers.

## Required compatibility report

Before a connection changes from preview to supported, its report must record:

- Ground commit and adapter version;
- provider API or CLI version and fixture date;
- operating system and architecture;
- authentication and endpoint mode;
- streaming, tool, usage, cancellation, and error cases;
- native resume or canonical-history behavior; and
- known unsupported capabilities.

MCP reports must additionally record transport, protocol version, server
implementation/version, definition fingerprints, drift behavior, call approval,
result limits, and whether authentication or non-tool capabilities are required.
