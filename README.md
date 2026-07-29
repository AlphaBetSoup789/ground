# Ground

**The open workspace for coding agents. Your ground. Any model.**

Ground is a local-first desktop workspace for coding with models and external agent
runtimes without making a hosted relay the center of your work. Ground keeps the
workspace, task history, provider profiles, and permission surface on your machine.
It connects directly to the endpoint or executable you choose.

> **Developer preview:** Ground is not yet a supported public release. The current
> build is intended for development and evaluation on non-sensitive repositories.
> Expect data-format changes, incomplete platform support, and security hardening
> before the public alpha.

![Ground workspace with a coding-agent task, provider switcher, and Git panel](docs/images/ground-workspace.jpg)

## What works today

| Connection | How it runs | Status |
| --- | --- | --- |
| OpenAI-compatible API | Direct HTTP(S), including Ollama and LM Studio | Integrated |
| Codex CLI | Local process with normalized JSON Lines events | Integrated |
| Claude Code | Local process with normalized streamed JSON events | Integrated |
| Gemini CLI | Local process with normalized streamed JSON events | Integrated |
| Generic CLI | Local process that accepts a prompt and emits text or JSON Lines | Integrated, limited |
| OpenAI Responses | Direct HTTPS through the provider-neutral model loop | Integrated |
| Anthropic Messages | Direct HTTPS through the provider-neutral model loop | Integrated |
| Google Gemini API | Direct HTTPS through the provider-neutral model loop | Integrated |

The first-class hosted adapters have mocked protocol and end-to-end application
tests. CI does not hold provider credentials or make paid live-provider requests, so
they are integrated but not yet version-certified against live cloud services.

“Any model” means a model can connect through a supported direct API protocol, an
OpenAI-compatible endpoint, or a compatible CLI adapter. It does not mean every
provider-specific feature is automatically portable. Ground exposes capabilities
explicitly and keeps a normalized history so switching providers does not make the
task unreadable.

Built-in model protocols and agent CLIs are selected through one static,
source-trusted adapter registry. Downstream builds can register another reviewed
adapter without replacing Ground’s canonical reducers or managed tool loop, but
Ground does not load arbitrary provider plugins at runtime. A new first-class
provider form or profile kind still requires a reviewed source change and rebuild. See
[docs/PROVIDER-SDK.md](docs/PROVIDER-SDK.md). The same canonical contracts compile
into a versioned, provider-neutral adapter SDK package with a deterministic
conformance runner; npm publication remains a separate maintainer release step.

## Current experience

- Persistent local workspaces, tasks, provider profiles, and run timelines
- Streaming assistant output and normalized runtime activity
- Ask mode with bounded read-only workspace tools, and Agent mode with the full
  Ground-managed tool set
- Provider switching with per-item provider attribution and normalized tool-call
  and tool-result context
- Approval-gated full writes, exact localized edits, commands, and MCP calls for
  Ground-managed API agents, with an exact native allow-once confirmation
- Durable start/completion claims for Ground-managed writes, commands, and MCP
  calls; an interrupted claim is reported as outcome unknown and is never
  automatically retried
- Sensitive-path filtering and workspace-relative model-visible paths
- Portable JSON task bundles, Markdown transcript export, and confirmed task
  deletion
- Safe task forks, reversible archive/restore, and bounded search across active or
  archived task history
- Interactive, multi-session task terminals backed by a real local PTY
- Git branch/status, staged and unstaged diffs, path staging/unstaging, exact-tree
  commits, bounded history, and managed-worktree create/remove
- Remote Streamable HTTP and local stdio MCP servers with namespaced tools,
  launch and definition trust, and per-call approval
- Native session-resume support for recognized Codex, Claude, and Gemini CLIs
- Provider-neutral runtime event validation with split-delta credential
  redaction, opaque activity identities, abort-safe projection, and
  compatibility-bound session persistence
- Run cancellation, command timeouts, and process-group termination
- A bounded, atomic local state snapshot plus rotating last-known-good backup,
  corruption quarantine, and an in-app recovery notice
- A strict private credential vault backed by OS secure storage when it is
  genuinely available

## Run Ground

Ground supports Node.js 22.12 or newer. The reproducible CI and release toolchain
uses Node.js 24.18.0 (from `.nvmrc`) and npm 11.16.0. Install that npm version
with your toolchain manager before running project commands; use
`npm run toolchain:check` when reproducing CI or a release.

From a source checkout:

```bash
npm ci
npm run dev
```

`npm ci` enforces the reviewed, version-pinned dependency install-script policy in
`package.json`; an unreviewed install script fails the install. Ground’s own
postinstall invokes the exact locked Electron runtime installer because Electron 43
downloads lazily, then verifies the embedded runtime version and Electron/Chromium
license inventory before development or packaging can continue.

## Connect a model

Open **Providers & settings** in the desktop app.

### First-class hosted API

Choose OpenAI, Anthropic, or Google AI, then enter the model identifier and API key
for your account. Ground uses the provider’s direct protocol—OpenAI Responses,
Anthropic Messages, or Google Gemini—rather than translating all three through a
Ground-hosted gateway.

The default provider endpoint is shown and can be reviewed before saving. Changing
the provider kind or canonical endpoint invalidates the saved credential and
requires the key again. Connection tests use each provider’s model-discovery
authentication and response shape.

### OpenAI-compatible endpoint

Enter:

- a base URL such as `http://127.0.0.1:11434/v1` for Ollama or
  `http://127.0.0.1:1234/v1` for LM Studio;
- the model identifier expected by that endpoint; and
- an API key if the endpoint requires one.

Non-loopback endpoints must use HTTPS. Ground sends requests directly to the
configured origin and rejects redirects. It does not route model traffic through a
Ground service. **Test connection** requests the compatible endpoint’s `/models`
route.

In Agent mode, the integrated API path can expose `list_files`, `read_file`,
`search_files`, `write_file`, `edit_file`, and `run_command`. Reads are bounded and
sensitive paths are filtered. `edit_file` requires an exact source match and is
unique by default; every full write, localized edit, and command pauses for an
inline approval. Tool authority remains in Ground’s main process, not in the
renderer or provider.

`run_command` approval binds the canonical workspace and working directory,
content-hashed launch files, exact spawned argv, and timeout. On Windows it uses the
same reviewed Node-shim path described below, which supports common commands such
as `npm test` without interpolating model-provided arguments into `cmd.exe`.
The invoked program can still apply its own command or shell semantics.

Ask mode can expose only `list_files`, `read_file`, and `search_files`. MCP tools,
writes, and commands are not advertised in Ask mode. The provider’s advanced
settings can override the context-window estimate and maximum response tokens, and
can opt into low, medium, or high reasoning effort. These values are best-effort
provider inputs: an incompatible endpoint or model may reject them.

### CLI agent

Ground detects Codex CLI, Claude Code, and Gemini CLI in common executable
locations. A generic CLI profile supports:

- an executable name or absolute path;
- one argument per line;
- `{prompt}`, `{model}`, `{cwd}`, and `{sessionId}` tokens;
- prompt delivery through stdin or an argument; and
- plain streamed output or JSON Lines; and
- optional encrypted profile-specific environment variables for enterprise and
  custom runtimes.

Installed CLIs continue to use their native sign-in, keychain, and configuration
stores by default. A profile override stores only each variable name and an opaque
revision fingerprint in Ground’s normal state; its value is held in the
OS-protected secret vault and never enters a task or provider snapshot. Leave an
existing value blank to retain it. Custom values must contain at least four
characters so echoed values can be redacted safely. Ground rejects duplicate
names, executable-search and loader controls, and root/config/temp redirects such
as `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `HOME`, `XDG_CONFIG_HOME`, and `TMPDIR`.

Ground first asks for native confirmation of the saved executable and argument
template. Immediately before a run, it separately authorizes the fully expanded
argv, canonical workspace, source-registered runtime adapter ID, CLI dialect,
parser, prompt transport, environment-key set, opaque environment revision, and
content-hashed launch identity. Names and the non-secret revision appear in the
native dialog; values do not. Changing a name or value invalidates the prior
configuration and invocation grants. Argument prompts
are redacted in the dialog but remain bound into that authorization. Stdin prompt
content is treated as process data: it is neither shown nor hashed into the launch
grant, so an otherwise identical stdin-based runtime does not prompt again for
every turn. Exact grants are memory-only and expire when Ground exits. Launch files
larger than 512 MB are rejected rather than approved without a complete hash.

On macOS and Linux, Ground spawns the resolved executable with an argv array rather
than constructing a shell command. On Windows it directly launches `.exe`/`.com`
programs. Standard npm-installed Node `.cmd`/`.bat` shims for commands such as
`codex`, `claude`, `gemini`, and `npm` are parsed as data; Ground binds the shim,
canonical package script, Node interpreter, and exact argv, then launches Node
without asking `cmd.exe` to interpret the arguments. Other batch files and
PowerShell launchers are rejected. A launched program can still start its own shell
(for example, npm does this for package scripts). Recognized runtimes are launched
with their supported read-only/planning policy in Ask mode and workspace-editing
policy in Agent mode.

An external CLI still runs as the current operating-system user. Ground can observe
its reported activity, but it cannot approve or deny the runtime’s internal actions.
The CLI’s own sandbox, permission policy, authentication, plugins, and telemetry
remain in effect.

### MCP tools

Open **Providers & settings → MCP servers** to add either:

- an unauthenticated remote Streamable HTTP endpoint; or
- a local stdio executable with one argument per line.

Remote endpoints require HTTPS except for literal loopback HTTP, and redirects are
rejected. Local servers are resolved to an absolute executable and launched with an
argv array, no shell, and a reduced environment. Before the first exact local
launch in an app session, a native dialog shows the executable identity, complete
argv, working directory, environment-key set, and invocation fingerprint. Ground
hashes regular executables up to 256 MiB, revalidates their identity around launch,
and binds the invocation identity into stdio tool fingerprints. Ground prefixes
discovered tools as `mcp__<server>__<tool>` so they cannot silently shadow built-in
tools.

Connecting does not make a tool available to models. Ground fingerprints each
tool’s title, description, and input schema. The user must approve the exact
discovered fingerprint set, and changed or newly added definitions are blocked
until reviewed again. Changing a server namespace, transport, URL, executable, or
arguments clears saved definition trust. Every individual MCP invocation then
pauses again to show the server, tool, definition fingerprint, and complete
arguments before execution. The prepared call also binds a connection fingerprint
covering the canonical remote URL and namespace, or the exact stdio invocation and
namespace. Ground verifies it after refresh and immediately before dispatch, so
reconfiguring the same server ID while approval is open cannot redirect the call.

MCP is intentionally tool-only in this preview. Remote authentication headers and
OAuth, resources, prompts, MCP Apps/UI, and elicitation are not supported. A local
stdio server is native code running with the current operating-system user’s
permissions; launch trust, schema trust, and call approval are not an OS sandbox.
See [SECURITY.md](SECURITY.md) for the remaining executable-path, helper-script,
large-file, and best-effort descendant-cleanup limitations.

## Task portability

The task menu can export either:

- a versioned, strictly validated JSON bundle containing a provider hint, timeline,
  and portable canonical conversation; or
- a readable Markdown transcript.

The exporter omits provider credentials, native runtime sessions, workspace
authority, provider-owned continuation state, and original internal IDs. It
rekeys tool calls, removes secret-shaped JSON fields, and replaces the selected
workspace’s absolute path with `<workspace>`. It cannot recognize arbitrary secrets
that a user pasted into prose or tool output, so inspect every exported file before
sharing it.

Imported bundles are size- and structure-bounded, receive new local identities, and
do not receive a workspace grant, runtime session, pending approval, or execution
authority. Imported timeline entries remain visibly marked and excluded from model
context by default. The task banner can explicitly include or re-exclude them;
enabling the control requires a native warning. When the bundle’s model hint
exactly matches a configured API provider, its portable canonical conversation may
seed a later request only after that opt-in and a user-started run. Imported
content must therefore be treated as untrusted.

Task forks are explicit local working copies. Ground assigns new task, item, run,
and tool-call identities; drops pending approvals, CLI sessions, checkpoints,
provider-owned state, and incomplete tool exchanges; and preserves the source
task’s readable canonical history and workspace selection. Archiving is reversible
and disables new Ground run/workspace actions until restored. An already running
PTY is detached rather than killed and may continue at the OS level. Sidebar search
is local, bounded, and can be scoped to active or archived tasks.

## Workspace terminal and Git

Each task with an authorized workspace can open a real interactive PTY in the
Terminal panel. Before each new shell starts, a native dialog shows its exact
executable, arguments, and canonical working directory. Ground streams the shell
through xterm.js, bounds in-memory scrollback and input, and supports multiple
sessions, switching, resize, reattach, restart, and termination. Hiding or
switching the panel detaches its opaque renderer attachment without killing the
process; stale attachments cannot type or resize. Terminal sessions and scrollback
are process-local and end when Ground quits.

The Git panel reads branch/ahead/behind state, staged, unstaged, untracked, and
conflicted paths, staged and unstaged unified diffs, bounded commit history, and
registered worktrees. It can stage or unstage selected paths, commit the exact
prepared index tree, create a branch in a dedicated managed worktree and open it as
a new task, and remove a clean worktree registered inside that managed root.

Every Git mutation receives a native confirmation. Commits bind the staged-tree
object and expected `HEAD`, then move `HEAD` only if the confirmed parent still
matches; concurrent index and working-tree edits are preserved. Hooks and signing
are disabled for Ground-created commits. Removing a worktree rechecks cleanliness,
registration, and containment, closes linked terminals, and keeps linked task
history while detaching its removed workspace.

Git is invoked as a resolved executable with fixed argv, no shell, disabled hooks,
bounded output, and a reduced environment. For status, working-tree diffs, staging,
and worktree checkout/removal, Ground discovers effective repository
content-filter drivers and overrides every clean/smudge/process slot to a no-op on
the exact Git invocation.

Filter neutralization prevents a repository-defined filter command from executing,
but repositories that depend on Git LFS, encryption, or another required content
filter can show pointer/encrypted content, unexpected dirty state, or an unusable
managed checkout in Ground’s Git view. Use the repository’s normal trusted Git
workflow for those repositories.

The terminal and Git panel are direct user workspace features, not extra model
authority. A PTY shell still has the operating-system permissions of the Ground
process. Ground does not provide revert/reset, remote fetch/push, arbitrary
worktree deletion, or signed commits through the Git panel.

## Trust boundaries

Ground distinguishes two execution models:

1. A **model adapter** gives Ground model output. Ground owns context, tools,
   approvals, and the agent loop.
2. An **agent runtime adapter** launches an existing coding agent. That runtime owns
   its tools and permissions; Ground owns the workspace/task presentation and
   normalizes events.

The renderer receives a narrow typed API. Canonical workspace paths, secrets,
filesystem operations, network credentials, process creation, runtime/model
sessions, pending approval state, and prepared side-effect envelopes stay in
Electron’s main process. The renderer receives only a revocable process-scoped
workspace grant ID and a path-free label derived from the basename; duplicates
receive an ordinal suffix. It presents the exact approval card. A denial resolves
immediately, while an allow-once request opens a main-process-owned native dialog
bound to the same immutable action envelope before execution can continue. Before
the side effect, the main process durably records a unique operation ID plus
separate hashes of the prepared action and native approval. Those durable evidence
fields are stripped from renderer snapshots and live/replayed events. Ground
returns the result to the model only after durably recording the outcome.

Registered runtime output crosses a second main-process projection boundary after
canonical validation. Ground stream-redacts configured CLI environment values
even when they span assistant deltas, redacts activity and notice text, replaces
provider activity IDs with opaque local IDs, rejects protected runtime/session
identity, consumes resumable sessions as one-attempt leases, and checks
cancellation before terminal state can persist. Successful hosted/local API output
crosses the same kind of boundary: resolved credentials are stream-redacted from
text and notices, while credential-bearing tool arguments or provider continuation
state fail closed. Ground races iterator reads against Stop, so an adapter that
ignores its signal cannot strand the task. Adapter-side redaction remains required
because external runtime code owns its process and may have access beyond Ground’s
configured secret resolver.

Read [SECURITY.md](SECURITY.md) and
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) before using Ground with important
source code.

## Architecture

```text
React renderer
  │ typed, validated IPC
Electron preload
  │
Electron main process
  ├─ local task/provider/MCP store
  ├─ OS-protected secret vault
  ├─ Ground-managed model loop and tool broker
  ├─ static model + agent-runtime registry and factories
  ├─ MCP connection, definition-trust, and call broker
  ├─ workspace PTY service
  ├─ bounded Git and managed-worktree service
  ├─ direct model-protocol adapters
  └─ argv-based external runtime adapters
```

There is no required Ground account, cloud control plane, or provider relay.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the ownership model and
[docs/PROVIDER-SDK.md](docs/PROVIDER-SDK.md) for the versioned adapter contracts
and conformance suite.

## Verify a change

```bash
npm run verify
npm audit --audit-level=high
```

`verify` checks the reviewed build-dependency bridge, both TypeScript targets, the
test suite, pinned compatibility-fixture drift, the clean-room adapter SDK package,
the generated production-license inventory, and the production build. The separate
audit covers the complete locked tree, including Electron and packaging
dependencies.

The suite covers provider event normalization and output bounds, CLI argv/event
parsing and cancellation, native session metadata, renderer/IPC trust checks,
credential boundaries, task portability and lifecycle, rotating-backup recovery,
workspace containment, sensitive-path filtering, full writes and localized edits,
command envelopes and executable identity, portable Windows PATHEXT/Node-shim
handling and metacharacter-safe argv, MCP launch identity/definition drift
and call approval, PTY authorization/attachments and scrollback, Git filter
neutralization/staging/commits/worktree containment and removal, and cancellation.

## Package a preview

```bash
npm run dist:mac:unsigned
npm run dist:win
npm run dist:linux
# Then certify the matching unpacked package runtime:
npm run smoke:package:launch
npm run smoke:package:native
```

Outputs are written beneath `release/`. The manual **Package previews** workflow
also targets macOS, Windows, and Linux on native hosted runners. These packages are
unsigned, short-lived developer artifacts, not certified distributions.
`dist:mac:unsigned` clears signing/notarization credentials and disables signing
identity auto-discovery so a local macOS preview cannot silently become a release
artifact.

The package workflows are configured to launch the unpacked app with an isolated
temporary profile and verify real main/preload/document startup without browser
automation. A second bounded smoke exercises the packaged PTY binding, Git status,
a fixed local stdio MCP call, and process-tree cleanup. This is runtime evidence,
not installer, UI, keychain, live-provider, or signing certification.

The tag-driven release workflow is scaffolded to require macOS signing/notarization
credentials, build native-platform artifacts, emit checksums and a
runtime-inclusive CycloneDX SBOM verified against every packaged `app.asar`, create
build/SBOM attestations, and open a draft prerelease. No official artifact has been
published or certified. Read
[docs/RELEASING.md](docs/RELEASING.md).

## Known limitations

- Hosted adapters have mocked transport coverage but no credentialed live-provider
  smoke test in CI or published version-certification report.
- Task persistence uses an atomic local JSON document plus one rotating previous
  snapshot with a 128 MiB ceiling. Startup can restore that backup and quarantine
  unreadable files, but there is no transactional event log or user-driven backup
  browser/restore UI.
- State and credential files use no-follow opens where the platform exposes them;
  Windows reparse points do not yet have an equivalent race-free same-user
  guarantee.
- PTY sessions and scrollback are in-memory, run with the current user’s OS
  permissions, and are not restored after Ground exits.
- Git support intentionally omits revert/reset, remote operations, signed commits,
  force-removal of dirty worktrees, and removal of worktrees outside Ground’s
  dedicated managed root.
- Staging is whole-path rather than hunk-level. Its confirmation binds the selected
  paths, so the latest content at execution is staged; the later commit
  confirmation binds an exact tree.
- MCP currently supports tools over unauthenticated Streamable HTTP and local
  stdio. Remote headers/OAuth, resources, prompts, Apps/UI, and elicitation are not
  implemented.
- Ground converts configured token limits into a conservative UTF-8 byte budget
  and keeps recent complete tool exchanges, but it does not yet use each model’s
  exact tokenizer or provide semantic repository indexing and summarizing
  compaction.
- Generic CLIs have limited event semantics and no native session resume.
- Ground does not automatically resume an interrupted managed action. If it
  restarts with a durable action-start claim but no recorded outcome, it marks the
  outcome unknown, clears unsafe continuation state, and requires the user to
  review the workspace or external system before continuing.
- Adapter registration is source-trusted and static; Ground does not install or
  discover runtime provider code. Adding a built-in structured CLI dialect still
  requires a reviewed source change and rebuild.
- Windows cancellation invokes the system `taskkill.exe /T /F` path for the exact
  spawned PID, while macOS and Linux target detached process groups. Descendant
  cleanup remains best effort when a process escapes the tree or races shutdown.
  The native package workflows contain a bounded descendant-cleanup probe, but a
  workflow configuration is not a published certification result.
- macOS, Windows, and Linux preview packaging is configured, but only a macOS arm64
  developer package has been locally exercised; the hosted launch/native smoke
  matrix has not yet produced a published cross-platform certification report.
- There is no automatic updater, signed update channel, compatibility guarantee,
  OAuth/account system, or official supported binary.

## Project documents

- [Roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Privacy](PRIVACY.md)
- [Governance](GOVERNANCE.md)
- [Support](SUPPORT.md)
- [Releasing](docs/RELEASING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

Ground is available under the [MIT License](LICENSE).
