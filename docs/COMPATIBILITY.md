# Compatibility

Ground is a public alpha. This matrix describes the current source tree and
unsigned preview evidence, not a promise that every provider model, CLI version, or
packaged environment works. Ground publishes version-pinned, credential-free
contract fixtures; authenticated compatibility reports are still required before a
connection can be called live-certified.

The first credential-free
[CLI invocation-surface observation](compatibility/cli-help-2026-07-28.md)
records locally installed versions and help-visible flags. It is deliberately
narrower than the required authenticated compatibility report.

## Published pinned contract fixtures

The executable [compatibility fixture set](../fixtures/compatibility/README.md)
uses a strict version 1 manifest schema and explicit provenance. Current
manifests are `synthetic-contract` or `documented-example`, all with
`liveCapture: false`:

| Boundary | Exact fixture pin | What the test proves |
| --- | --- | --- |
| OpenAI Responses | `ai` 7.0.41 + `@ai-sdk/openai` 4.0.23 | Synthetic AI SDK `LanguageModelV4` events normalize through Ground's production adapter boundary |
| Anthropic Messages | `ai` 7.0.41 + `@ai-sdk/anthropic` 4.0.23 | Same adapter-boundary normalization contract |
| Google Gemini | `ai` 7.0.41 + `@ai-sdk/google` 4.0.27 | Same adapter-boundary normalization contract |
| OpenAI-compatible | `ai` 7.0.41 + `@ai-sdk/openai-compatible` 3.0.16 | Same adapter-boundary normalization contract |
| Codex CLI | 0.144.1 | Synthetic JSON events normalize through the real Codex CLI parser |
| Claude Code | 2.1.218 | Synthetic JSON events normalize through the real Claude CLI parser |
| Gemini CLI | 0.47.0 | Synthetic JSON events normalize through the real Gemini CLI parser |
| Antigravity CLI | 1.1.8 | Documented headless NDJSON envelopes normalize through the real Antigravity parser |

`scripts/check-compatibility-fixtures.mjs` rejects unknown manifest fields,
misstated provenance, missing suites, and pin drift from the package declaration,
package lock, or recorded CLI observation. The focused fixture test executes every
case through `parseCliRuntimeEvent` or `AiSdkModelAdapter.stream`; it does not make
network requests or launch an agent CLI.

A **pinned contract fixture** proves that Ground's normalization behavior remains
stable for reviewed synthetic or documented inputs at a named
dependency/runtime version. It does not prove that an upstream service or
executable still emits those inputs. A
**live certification** additionally requires the compatibility report below,
including authenticated wire/runtime behavior, permissions, resume, cancellation,
errors, and the stated OS/architecture. The API fixtures are AI SDK boundary
events—not OpenAI, Anthropic, Google, Ollama, or LM Studio wire captures. The CLI
versions were observed from local binaries or reviewed release artifacts for
their help surface, but their JSON fixtures were not captured from those
executables.

Separate from those manifest fixtures, a credential-free loopback wire integration
test starts a local HTTP server and drives an actual streaming
`POST /v1/chat/completions` through Ground’s production OpenAI-compatible AI SDK
adapter. It asserts the system/user message body, tool schema, SSE text deltas, and
normalized terminal response. This proves the local transport and production
adapter path for that deterministic fixture; it does not contact or certify
OpenAI, Ollama, LM Studio, or another real deployment.

## Connection matrix

| Connection | Transport | Permission owner | Resume model | Status |
| --- | --- | --- | --- | --- |
| OpenAI-compatible endpoint | Chat Completions SSE | Ground | Ground history | Integrated; pinned synthetic adapter fixture; not server-certified |
| Ollama | OpenAI-compatible loopback HTTP | Ground | Ground history | Integrated; model-dependent tools; not server-certified |
| LM Studio | OpenAI-compatible loopback HTTP | Ground | Ground history | Integrated; model-dependent tools; not server-certified |
| OpenAI | Responses API | Ground | Ground history (stateless replay) | Integrated; pinned synthetic adapter fixture; not live-certified |
| Anthropic | Messages API | Ground | Ground history + owning-adapter part state | Integrated; pinned synthetic adapter fixture; not live-certified |
| Google Gemini | Gemini API | Ground | Ground history + owning-adapter part state | Integrated; pinned synthetic adapter fixture; not live-certified |
| Codex CLI | JSON Lines process stream | Runtime | Native session ID | Integrated; 0.144.1 help observed + synthetic parser fixture; not live-certified |
| Claude Code | Streamed JSON process output | Runtime | Native session ID | Integrated; 2.1.218 help observed + synthetic parser fixture; not live-certified |
| Gemini CLI | Streamed JSON process output | Runtime | Native session ID | Integrated; 0.47.0 help observed + synthetic parser fixture; not live-certified |
| Antigravity CLI | Streamed JSON process output | Runtime; headless approvals unsupported | Explicit conversation ID | Integrated for 1.1.8+; version is probed after native save confirmation; official documented fixture; not live-certified |
| Generic CLI | Plain text or JSON Lines | Runtime/unknown | New process per turn | Integrated, limited semantics |

Status terms:

- **Integrated** means the desktop UI can save the connection and the live
  `RunManager` can execute it.
- **Pinned adapter/parser fixture** means an exact synthetic or documented
  manifest is exercised against Ground's real normalization boundary, without
  contacting the upstream.
- **Not live-certified** means contract and application tests pass, but CI has not
  made credentialed requests to a pinned provider or launched the pinned CLI for
  an end-to-end run.

Every saved connection begins unverified and must pass **Test** for the exact saved
revision before main will start a run. First-class API tests validate model
discovery. OpenAI-compatible testing prefers `/models` and falls back, only when
listing cannot prove success, to one bounded non-streaming four-token generation
against the exact configured model. CLI Test validates executable resolution and
argv construction but does not authenticate or launch an agent turn. A readiness
pass is therefore an installation-specific preflight, not a published compatibility
certification.

New-provider onboarding separates Hosted API, Local server, and Installed CLI
paths. The Local server path supplies only editable loopback values; it does not
install or start a server or download a model. Only a main-process-confirmed
refused literal-loopback connection unlocks the local startup/model/port recovery
checklist. Passive CLI candidates are described as detected locally because a path
match does not establish authentication, model access, or successful execution.
Readiness and run failures can carry a bounded main-derived category for refused
connections, DNS, TLS, authentication, rate limits, timeouts, protocol shape,
missing executables, or an explicit CLI startup failure. Ground presents shared
corrective guidance from that category and leaves unknown failures generic; it
does not classify display prose. Readiness retains no diagnostic text. Error
activities keep their existing bounded, credential-redacted detail but add no
cause graph, response-body field, or raw structured provider-code field.

Reviewed downstream builds can statically register another `ModelAdapter` or
`AgentRuntimeAdapter` and map an existing profile envelope to it without replacing
the canonical reducers. This is source integration, not dynamic end-user plugin
loading or a stable binary ABI. New first-class profile fields and built-in
structured CLI dialects still require reviewed source changes and a rebuild.

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
| Git commit | Exact prepared tree/ref/repository binding + conditional non-dereferencing update | Integrated | Hooks/signing disabled; no amend/merge workflow |
| Git restore/undo | Selected unstaged tracked or untracked regular files + private recovery | Integrated | Git 2.23+; no conflicts/submodules/directories/links; no active Ground run/terminal; untracked atomic move requires same-volume rename |
| Git history | Bounded local log parsing | Integrated | No signature verification or remote operations |
| Managed worktrees | Dedicated Ground root, branch creation/new task, clean registered removal | Integrated | No dirty force-removal or arbitrary worktree deletion |
| Agent `run_command` | Immutable content-hashed launch envelope + exact argv | Integrated | Native exact-envelope confirmation; current-user permissions; Windows supports direct executables and recognized Node package shims |
| Remote MCP | Streamable HTTP | Integrated, unauthenticated | HTTPS except loopback; no headers or OAuth |
| Local MCP | Resolved stdio executable and argv | Integrated | Native exact-invocation confirmation; current-user OS permissions; not sandboxed |
| MCP tools | Namespaced canonical definitions | Integrated | Tools only; no resources, prompts, Apps/UI, or elicitation |
| Task portability | Strict JSON bundle + Markdown transcript | Integrated | User must review exports; imported content is untrusted |
| Task lifecycle | Safe fork, archive/restore, bounded active/archive search, and current-result keyboard switching | Integrated | Search uses the exact displayed order and opaque task IDs; imported history is excluded by default and requires an explicit per-task opt-in |
| State recovery | Bounded atomic primary + three rotating validated snapshots | Integrated | Opaque in-app browser, credential-free export, and native-confirmed retained restore with a process-wide drain/seal; no arbitrary snapshot import or transactional event log |
| Managed-action crash recovery | Durable started/completed claims for writes, commands, and MCP calls | Integrated | Reports an interrupted outcome as unknown; no automatic action/run resume |

State and credential-vault readers use `O_NOFOLLOW` where the host exposes it.
Windows does not yet have equivalent race-free reparse-point handling in Ground;
the same-user path-swap limitation is documented in the threat model.

MCP definition approval fingerprints each tool’s title, description, and input
schema. A refresh blocks added or changed definitions until exact reapproval, and
connection identity changes clear stored trust. This is separate from per-call
approval: every model-requested MCP invocation still shows the complete arguments
and must be approved individually.

Enabled remote profiles connect concurrently at startup; local stdio profiles are
serialized so native launch dialogs do not overlap. A managed API run waits for
that startup attempt before constructing its first MCP tool set. Queued connections,
tool listing, and final dispatch revalidate the exact current enabled persisted
profile and definition-trust identity.

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

Ground passively fingerprints fixed conventional and absolute app-PATH Git
candidates while excluding workspace-controlled paths. The user can choose another
direct executable in a native picker; a default-cancel dialog shows its
path/hash/size/fingerprint before Ground runs `git --version`. Git 2.23 or newer is
required. The private saved path/fingerprint is a preference rather than authority:
Ground recreates a process-local binding and revalidates exact file identity before
every Git launch.

The Git path disables hooks, global/system configuration, pagers, prompts, external
diff/text conversion, and LFS smudge, and bounds process time and output. For
status, working-tree diff, staging, restore, and worktree checkout/removal, it
queries effective repository filter drivers and overrides clean/smudge/process to
no-op on the exact invocation. This prevents filter-command execution but can
expose LFS pointers, encrypted content, unexpected dirty state, or unusable
checkouts in filter-dependent repositories.

Worktree destinations are confined to a dedicated Ground root. Selected-path
staging/unstaging receives a native confirmation. Commits bind the exact prepared
index tree, parent, repository/worktree identities, and checked-out symbolic local
ref; detached-HEAD commits are refused. They use a non-dereferencing conditional
update, disable hooks/signing, and leave concurrent index/working-tree edits alone. Recoverable
restore privately captures selected tracked contents and atomically moves selected
untracked files before restoring tracked files to the current index; staged changes
remain staged. Ground refuses restore/undo while one of its runs or terminals is
active in the workspace. Conservative undo succeeds only while every path and
recovery payload matches, and an incomplete or cross-volume rename operation is
reported as recovery-required. Removal is available only for a clean registered
worktree under Ground’s managed root. The desktop does not expose arbitrary reset,
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

| Mode | Codex CLI | Claude Code | Gemini CLI | Antigravity CLI 1.1.8+ |
| --- | --- | --- | --- | --- |
| Ask | Read-only sandbox | Plan permission mode | Plan approval mode | Plan mode |
| Agent | Workspace-write sandbox | Accept-edits permission mode | Auto-edit approval mode | Accept-edits mode |

Ground strips known permission-bypass flags from recognized profiles. These modes
are still implemented by the external runtime, not enforced by Ground. Runtime
upgrades can change flag and event behavior. Antigravity headless mode cannot
present interactive approvals: command actions are soft-denied unless a scoped
permission rule pre-allows them. Ground strips
`--dangerously-skip-permissions` and resumes it only by explicit conversation ID.
The published fixtures pin the current parser contract, but captured end-to-end
reports remain required before declaring any runtime version supported.

Detection checks a bounded, non-recursive set of conventional system, app-PATH,
Volta, pnpm, Bun, asdf, NVM, and related platform locations without launching a
candidate. The main-owned native picker can validate another absolute direct
executable or reviewed Windows Node package shim. Candidates controlled by a
configured workspace are excluded. Selection itself is not authorization: profile
save and the fully expanded invocation retain separate native confirmations.

Every CLI run has a native final-invocation grant distinct from the saved profile
template. The grant binds the expanded argv, canonical workspace, actual
source-registered runtime adapter ID, parser dialect, and content-hashed launch
identity. Distinct reviewed adapters delegating to one dialect receive distinct
grants. Exact grants are memory-only; launch files over 512 MB are rejected. Stdin
prompt content is intentionally data rather than process identity, while argument
prompts remain bound through the raw argv digest and are redacted in the dialog.

On Windows, Ground resolves only reviewed `PATHEXT` types (`.exe`, `.com`, `.cmd`,
and `.bat`). Executables are launched directly. Standard npm-generated Node
`.cmd`/`.bat` shims used by Codex, Claude, Gemini, npm, and similar packages are
parsed into a bound Node interpreter + canonical package script + exact argv;
`cmd.exe` does not interpret those arguments. Unrecognized batch shapes and
PowerShell launchers are unsupported. `npm test` is supported at this launch
boundary, but npm itself intentionally invokes the platform shell for package
scripts, whose contents and descendants remain npm’s responsibility.

Native resume is used only when the stored session belongs to the same registered
adapter ID and session-compatibility ID, complete provider-configuration
fingerprint, canonical workspace, and task mode. Generic CLIs do not have a
portable resume contract and do not persist opaque sessions.

## Platform matrix

| Platform | Development | Packaged artifact | Release status |
| --- | --- | --- | --- |
| macOS arm64 | Local + hosted CI/source target | Current source: local unpacked native evidence passed; current-source ZIP/distributable evidence not run; ZIP/DMG workflow target | No supported release |
| macOS x64 | Hosted Intel CI/source target | ZIP/DMG target; native evidence reruns against extracted ZIP | No supported release |
| Windows x64 | Hosted CI/source target | NSIS target; native evidence reruns after temporary silent install and invokes uninstall | No supported release |
| Linux x64 | Hosted CI/source target | AppImage/DEB target; native evidence reruns against extracted AppImage under Xvfb + Secret Service | No supported release |

The repository CI exercises type checking, tests, and renderer/main builds on
hosted macOS, Windows, and Linux runners. Manual preview and tag workflows define
the exact four native targets above and assert each runner’s architecture. A
successful target emits
`ground-package-runtime-evidence-<platform>-<architecture>.json`; release
aggregation accepts exactly all four expected records, checks fixed runtime and
security evidence, and verifies the named distributable’s SHA-256. Workflow
configuration alone is not a passing result.

The native scope verifies packaged identity, a real OS-encrypted `SecretVault`
set/reload/get/delete round trip, a production approval dialog automatically
aborted to Cancel, PTY, Git, the complete M1.1 deterministic provider/runtime
matrix, exact local stdio MCP launch/call, and process-tree cleanup.

The matrix separately requires:

| Scenario | Packaged evidence | Explicit limit |
| --- | --- | --- |
| OpenAI-compatible success | Credential-free token-bound loopback discovery, two streamed chunks, durable output/attribution/session/idle state | Not Ollama, LM Studio, or external-server certification |
| OpenAI Responses success | Synthetic versioned credential reused for exact Bearer discovery and `store: false` Responses streaming through `openai.responses` | Not live OpenAI auth, internet, DNS/TLS, rate-limit, reasoning, or tool evidence |
| Unavailable loopback | Typed `connection-refused`, corrective local guidance, persisted failed readiness, and pre-dispatch block | Not DNS, TLS, auth, rate-limit, timeout, renderer-presentation, or exclusive released-port ownership coverage |
| Malformed compatible response | Invalid discovery and assistant-message shapes classified as `protocol-shape`, with the bounded kind persisted before dispatch is blocked | Not every malformed or hostile-server shape |
| Recognized Codex CLI | Smoke-owned seven-record child through `openai.codex-cli`, exact two-phase trust, native session, command, usage, durable assistant output, and one successful non-fatal warning | Not installed/authenticated Codex, vendor service/sandbox/tools, passive detection, other CLIs, human dialog acceptance, race-free script-argument binding against concurrent same-user replacement, or abnormal-exit cleanup of a hung/hostile external CLI |

The outer harness prepends its own Node directory to a credential-scrubbed `PATH`.
The packaged process hashes and revalidates that interpreter and the token-bound
script at both trust phases; the outer verifier independently requires the
interpreter hash to match its own Node executable. These controls make the fixture
deterministic without turning its positive smoke-only authorization into a general
CLI bypass.

Distributable scope extracts a macOS ZIP or Linux AppImage, or temporarily installs
NSIS and verifies its executable/install directory are removed, then runs native
scope against the result. It does not
install DMG or DEB artifacts, drive arbitrary installer options, exercise a real
model/CLI/MCP server, or certify renderer accessibility. Linux requires D-Bus,
libsecret, and an unlocked Secret Service implementation; hosted workflows create
an ephemeral GNOME-keyring session because Ground rejects `basic_text`.

For the Linux AppImage smoke, the extracted sandbox must be a regular file whose
hash matches the same build’s separately root-owned/mode-4755 unpacked sandbox.
Ground launches the extracted app with `CHROME_DEVEL_SANDBOX` pointing to that
trusted external copy; the extracted payload is not chmodded into authority.

The tag workflow is scaffolded to require macOS signing/notarization credentials
and emit checksums, an SBOM, and attestations. The repository does not claim that
those secrets exist or that an official artifact has completed the workflow.
Public-alpha preview artifacts are unsigned, macOS previews are unnotarized, and
Windows/Linux signing policy remains undefined.

For the current source, local macOS arm64 `npm run package:mac` and the unpacked
`npm run smoke:package:native` passed, including the complete deterministic M1.1
provider/runtime matrix. A current-source distributable smoke and four-target
aggregate have not been run. The older
[four-target Package previews run](https://github.com/AlphaBetSoup789/ground/actions/runs/30473714099)
completed the required macOS arm64, macOS x64, Windows x64, and Linux x64 jobs for
source commit `a3073a8`, but predates the expanded provider/runtime matrix. Its
artifact-bound records cover only the earlier smoke contract and cannot satisfy
the current aggregate. They are not evidence for later source and do not certify
signing, notarization, DMG/DEB installation, renderer accessibility, live
providers/CLIs, or supported distribution.

The 13-scenario renderer interaction suite runs the built browser-preview React
renderer in Electron through Playwright Core. Its current local result is 13/13:
command-palette filtering/keyboard/focus restore, task-search shortcut focus and
current-result keyboard activation, request-bound narrow-sidebar focus, provider
labels and Chromium constraint validation, local-template/refused-connection
recovery into a detected CLI, task-local and active-run draft preparation,
Ask-to-Agent and reviewed-hunk handoffs, structured Git diff navigation,
deterministic send/cancel, archive and archived search, and 680px responsive
settings with reduced motion plus forced-color connection-path selection. CI is
configured to run it directly on macOS/Windows and under Xvfb on Linux. Because it
uses the explicit preview desktop mock, it is renderer evidence—not
production-main/preload, native permission, provider, screen-reader, or
packaged-app certification.

The pinned compatibility suite performs no authenticated request and launches no
coding CLI. Its separate loopback SSE integration drives only Ground’s production
OpenAI-compatible HTTP adapter against a deterministic local server.
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
