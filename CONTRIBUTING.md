# Contributing to Ground

Ground is a public-alpha open-source coding-agent workspace. Contributions are
welcome, especially around provider adapters, security boundaries, durable
storage, accessibility, Git/worktree workflows, and cross-platform behavior. The
alpha is experimental and is not a supported production binary.

## Before you start

- Search existing issues before opening a new one.
- Open an issue before substantial work on a new provider, runtime, storage engine,
  permission model, or security-sensitive feature.
- Keep provider portability and local data ownership intact.
- Never include API keys, transcripts, proprietary source, absolute local paths,
  state files, or support bundles in an issue, fixture, screenshot, or commit.

The contracts and persisted formats are experimental. Discuss compatibility-impacting
changes before implementation.

## Development setup

Ground supports Node.js 22.12 or newer. CI, packaging, and release verification use
the exact toolchain in `.nvmrc` and `packageManager`: Node.js 24.18.0 and npm
11.16.0. npm 11.16.0 is required for the install policy; supported newer Node.js
versions may be used for ordinary development. Use Node.js 24.18.0 and
`npm run toolchain:check` when reproducing CI or release results. Then use the
committed npm lockfile:

```bash
npm ci
npm run dev
```

The exact npm version matters because Ground enables npm's strict install-script
allowlist. `npm ci` fails when a dependency introduces an unreviewed install
script. Review such changes with `npm approve-scripts --allow-scripts-pending`;
approve only the exact package version after inspecting it, and commit the
`allowScripts` change. Do not use `--dangerously-allow-all-scripts`.
Electron 43 no longer declares an automatic package lifecycle download. Ground’s
root `postinstall` therefore invokes the exact locked Electron `install.js`
directly, which verifies the distribution checksum, then requires matching runtime
and license files. Treat changes to that bootstrap as install-policy changes.

Useful commands:

```bash
npm run typecheck
npm test
npm run test:e2e:renderer
npm run test:watch
npm run build
npm run build-deps:check
npm run install-scripts:check
npm run compatibility:check
npm run adapter-sdk:pack-check
npm run licenses:check
npm run dist:mac:unsigned
npm run dist:win:unsigned
npm run dist:linux
npm run smoke:package:launch
npm run smoke:package:native
npm run smoke:package:distributable
```

Run only the matching host’s explicit preview command. These create unsigned local
artifacts beneath `release/`; they are not official release artifacts. Native
distributables must be built on their target operating system; the manual packaging
workflow does the same on native hosted runners after source and renderer-E2E
verification. The launch smoke verifies the
unpacked app's main process, renderer document, and sandboxed preload without
browser automation. The native smoke additionally checks packaged identity,
performs an OS-encrypted credential-vault round trip, opens and automatically
cancels a real native approval dialog, and exercises the packaged PTY binding, Git
status, a fixed exact-envelope local stdio MCP exchange, and bounded process-tree
cleanup. The distributable smoke reruns that native scope after extracting the
macOS ZIP, temporarily installing and verifying removal of the Windows NSIS
package, or extracting the Linux AppImage. It does not test DMG or DEB installation.

Linux native/distributable smokes and real credential saves require a working
Secret Service/libsecret backend and an unlocked keyring; Electron’s `basic_text`
fallback is intentionally rejected. The hosted workflows create an ephemeral D-Bus
and GNOME-keyring session for their fixed probes.

`test:e2e:renderer` builds the explicitly flagged browser preview and launches its
real React renderer in Electron through Playwright Core. It uses the deterministic
preview desktop mock—not the production preload/main process—to cover keyboard
focus, provider-form validation, task-local drafts, send/cancel, archive/search,
responsive layout, and reduced motion. Treat it as renderer interaction evidence,
not native IPC, screen-reader, provider, or packaged-app certification.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/renderer/` | Untrusted React presentation layer |
| `src/preload/` | Narrow renderer-to-main bridge |
| `src/main/` | Desktop composition, policy, storage, tools, secrets, and runtimes |
| `src/main/agent/` | Canonical provider-neutral contracts, event reducers, registry, and adapters |
| `packages/adapter-sdk/` | Provisional publishable manifest, declarations build, and adapter SDK guide |
| `examples/` | Small dependency-free connection examples for public integration contracts |
| `src/main/providers/` | Current provider/runtime transport implementations |
| `src/shared/` | Typed IPC and renderer-safe data structures |
| `docs/` | Architecture, compatibility, SDK, and threat-model documentation |
| `scripts/` | Verification, license, packaging-smoke, and release-SBOM checks |
| `vendor/` | Narrow reviewed compatibility shims; not general vendored dependencies |

## Design invariants

1. Ground owns durable tasks, normalized history, workspace grants, tools, and
   policy.
2. A model adapter translates a provider protocol; it receives no direct filesystem
   or renderer authority.
3. An external runtime adapter states clearly when the runtime—not Ground—owns tools
   and permissions.
4. Secrets stay in the main process and are referenced indirectly by adapters.
5. Renderer input, provider output, CLI output, MCP data, and workspace content are
   untrusted.
6. Provider-specific state is optional, JSON-safe, versioned, and readable only by
   the adapter that owns it.
7. Every side effect must be attributable to a run and checked at the narrowest
   privileged boundary.
8. Imported history and provider-owned state never carry workspace, executable, or
   approval authority across a portability boundary.
9. New behavior needs tests against a stable contract, not only a UI snapshot.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/PROVIDER-SDK.md](docs/PROVIDER-SDK.md), and
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) before changing an execution boundary.

## Adding a model adapter

- Implement the versioned `ModelAdapter` contract from
  `@ground-app/adapter-sdk` (or its canonical `src/main/agent/sdk.ts` source in
  this repository).
- Register it under a stable ID with `AdapterRegistry`, map the provider profile to
  a secret-reference-only configuration with
  `createRegisteredModelRuntimeFactory`, and inject that factory at trusted
  main-process composition. Do not add runtime package discovery or remote code
  loading.
- Validate configuration without resolving secrets in the renderer.
- Declare capabilities conservatively; use `unknown` instead of inferring features
  from a brand name or OpenAI-shaped URL.
- Treat context-window, maximum-output, and reasoning settings as explicit user
  hints. Do not silently infer or enable provider-specific controls that can make a
  compatible endpoint reject the request.
- Emit canonical events in order and exactly one terminal response.
- Preserve provider-native continuation data only as versioned JSON-safe opaque
  state.
- Map authentication, rate-limit, timeout, cancellation, protocol, and mid-stream
  failures into typed provider errors.
- Add provider-independent contract fixtures and protocol-specific mocked tests.
- Ensure save invalidates readiness, Test persists only for the exact saved
  revision, and run startup remains blocked until that revision passes.
- Pass `assertModelAdapterConformance` with one valid configuration and at least
  one rejected configuration fixture.
- Document data egress, endpoint rules, tool behavior, and tested model/version
  combinations.

Do not add a mandatory Ground-hosted gateway. An optional relay would require a
separate design and explicit user consent.

## Adding an external runtime adapter

- Implement the versioned `AgentRuntimeAdapter` contract, register it under a
  stable source-reviewed ID, and map only data configuration from the provider
  profile with `createRegisteredAgentRuntimeFactory`.
- Keep registration in trusted desktop composition. Provider state must never
  select a module path, package, script, or remote code to load.
- Resolve and spawn an executable directly; never build a shell command string.
- Define its structured event parser, session identity, resume behavior, and
  cancellation semantics.
- Declare who owns permissions and surface that boundary in the UI.
- Treat runtime-reported activity as observability, not proof that Ground approved
  the action.
- Resolve credentials only through opaque main-process references and never emit
  or log their values. Add reflection tests covering raw, JSON-escaped, and
  cross-delta output; Ground’s projection redaction is defense in depth, not an
  adapter API.
- Pin fixtures to a documented CLI version and cover malformed/unknown events.
- If adding discovery or selection, keep it passive and bounded: do not recursively
  scan user directories or execute a candidate before the native trust boundary.
- Validate every emitted object with `AgentRuntimeEventReducer` and pass
  `assertAgentRuntimeAdapterConformance` using a deterministic mocked process.
- Do not enable bypass, unsafe, or “trust everything” flags by default.

Compatibility and application tests must remain reproducible with local fixtures,
mocked transports/processes, deterministic loopback wire servers, and deterministic
child programs. CI must never require a provider key or paid model request. Fixed
native package probes may exercise local OS facilities, but their results must not
be described as live-provider, live-CLI, signing, accessibility, or distribution
certification.

## Security-sensitive changes

Changes involving IPC, navigation, secrets, workspace paths, symlinks, writes,
commands, executable resolution, approvals, imports, updates, or support bundles
need:

- a threat statement in the pull request;
- negative tests for bypass and stale-state cases;
- bounded inputs and outputs;
- explicit cancellation and failure behavior; and
- documentation of residual risk.

Do not weaken an existing boundary solely to support a provider quirk. Propose a
capability-specific design instead.

Changes to task portability must keep the versioned schema strict and bounded,
rekey imported identities, strip provider/runtime authority, and test both
secret-shaped structured data and prompt-injection content. Export redaction is
not permission to describe an export as secret-free: arbitrary prose and tool
output always require user review.

Changes to Git, terminal, or local MCP process handling must include adversarial
tests for configuration drift, stale renderer capabilities, cancellation, helper
process cleanup, and platform-specific limitations. Keep residual pathname races,
interpreter/helper identity, large executable hashing, and best-effort descendant
termination explicit in the security documentation.

Git executable changes must preserve passive bounded discovery, dynamic exclusion
of workspace-controlled candidates, main-owned selection/confirmation,
post-confirmation 2.23+ probing, private preference-as-hint semantics, and exact
process-local identity revalidation before every launch.

## Pull requests

- Keep the change focused and explain the user outcome.
- Add or update tests and user-facing documentation.
- Run the verification commands in the pull-request template.
- Call out migrations, security tradeoffs, data egress, provider-specific behavior,
  and untested platforms.
- Do not commit generated releases, credentials, local state, or copied workspace
  data.
- When the production dependency graph changes, run
  `npm run licenses:generate`, review the new declarations, and commit the updated
  `THIRD_PARTY_NOTICES.md`.
- When an action is updated, review its upstream release and pin `uses:` to the
  verified full commit SHA; keep the major-version comment for Dependabot context.

By contributing, you agree that your contribution is licensed under Ground’s
[MIT License](LICENSE). All contributors must follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
