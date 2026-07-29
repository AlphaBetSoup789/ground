# Ground Agent Guide

This file is the provider-neutral entry point for coding agents working in this
repository. It applies to the entire repository.

Ground is a local-first desktop workspace for coding with interchangeable model
APIs and external agent runtimes. Preserve that product boundary: the user's
workspace and readable task history belong to the user, not to a model provider
or a Ground-hosted relay.

## Start here

Before changing code:

1. Run `git status -sb` and preserve changes you did not create.
2. Read [docs/PRD.md](docs/PRD.md) for the product contract.
3. Read [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md) for delivery order and acceptance
   gates.
4. Read the relevant sections of [ROADMAP.md](ROADMAP.md) and
   [README.md](README.md) for current scope and behavior.
5. For execution, storage, IPC, provider, CLI, MCP, terminal, Git, or permission
   changes, also read:
   - [CONTRIBUTING.md](CONTRIBUTING.md)
   - [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
   - [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)
   - [SECURITY.md](SECURITY.md)
6. Use `rg` or `rg --files` to locate the implementation and its existing tests
   before proposing a new abstraction.

## Sources of truth

Each project document has one job:

| Source | Owns |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | Durable user problems, product principles, requirements, and non-goals |
| [ROADMAP.md](ROADMAP.md) | Milestone outcomes and broad delivery status |
| [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md) | Dependency order, workstreams, and milestone acceptance gates |
| GitHub issues and milestones | Live task ownership, status, and implementation discussion |
| [README.md](README.md) | Current user-visible behavior, setup, and limitations |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Engineering workflow, repository map, and contribution rules |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process boundaries, authority, data flow, and canonical contracts |
| [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) and [SECURITY.md](SECURITY.md) | Threats, controls, residual risk, and release security requirements |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Versioned provider, runtime, and platform compatibility evidence |
| [docs/RELEASING.md](docs/RELEASING.md) | Packaging, signing, release verification, and rollback |

Do not turn the PRD into a delivery checklist or the build plan into a private
issue tracker. Once work is actionable, create or link a GitHub issue and keep its
state there. If implementation and documentation disagree, verify the behavior
with code and tests, then update the stale document in the same change.

## Non-negotiable engineering boundaries

These are summaries, not substitutes for the architecture and threat model:

- The Electron renderer is untrusted presentation. Workspace, secret, executable,
  approval, and tool authority stays in the main process.
- Model adapters translate provider protocols. They do not receive direct
  filesystem or renderer authority.
- External runtime adapters may own their tools and permissions. Ground must state
  that boundary honestly and treat runtime activity as observability, not proof of
  enforcement.
- Ground connects directly to user-selected APIs and executables. Do not introduce
  a mandatory hosted Ground relay or account.
- Ground-managed credentials and vault values must not enter renderer snapshots,
  model prompts, logs, fixtures, task exports, or adapter state. Arbitrary user
  text, source, tool output, and pasted secrets can still contain private data and
  require review before egress or export.
- Portable task content must never carry workspace, executable, credential,
  session, or approval authority.
- Side effects require the narrowest enforceable approval boundary and must remain
  attributable to a run.
- Provider and runtime registration is source-reviewed and static. Do not load
  arbitrary provider code from user configuration.
- Inputs and outputs across IPC, providers, CLIs, MCP, files, Git, and terminals
  are untrusted and must be validated and bounded.

## Development workflow

Ground's reproducible toolchain is declared in `.nvmrc` and `package.json`:
Node.js 24.18.0 and npm 11.16.0. Node.js 22.12 or newer is supported for ordinary
development, but use the pinned versions when reproducing CI or release results.

```bash
npm ci
npm run toolchain:check
npm run dev
```

Work on a focused branch. `main` is protected; normal changes land through a pull
request. Do not commit generated packages, local state, credentials, transcripts,
support bundles, or machine-specific absolute paths.

Prefer the smallest change that satisfies an existing contract. Reuse canonical
reducers, registries, trust-boundary helpers, schemas, and test harnesses instead
of creating parallel paths. Keep provider-specific behavior inside its adapter
unless the normalized contract genuinely needs to change.

When a material decision changes authority, persistence, portability, privacy,
licensing, telemetry, release signing, governance, or a public contract, follow the
public design-issue and maintainer-approval process in
[GOVERNANCE.md](GOVERNANCE.md). Keep the accepted reasoning linked from the
implementation pull request. Do not invent a private decision record for routine
implementation choices.

## Verification

Choose checks proportional to the change:

| Change | Minimum evidence |
| --- | --- |
| Documentation only | `git diff --check`; verify changed relative links and commands |
| Isolated TypeScript behavior | Focused tests plus `npm run typecheck` |
| Provider/runtime contract | Focused tests, `npm run compatibility:check`, and `npm run typecheck` |
| Renderer interaction | Focused tests plus `npm run test:e2e:renderer` |
| Cross-boundary or general code change | `npm run verify` |
| Packaging, native process, vault, PTY, Git, MCP, or release change | `npm run verify` plus the matching native/distributable checks in [docs/RELEASING.md](docs/RELEASING.md) |

Tests must be deterministic and credential-free in CI. Use mocked protocols,
synthetic fixtures, bounded loopback servers, or deterministic child processes.
Do not describe fixture coverage as live-provider certification.

## Definition of done

A change is done when:

- the user outcome and acceptance criteria are explicit;
- code follows the product, architecture, and security contracts;
- failure, cancellation, stale-state, and privacy behavior are covered where
  relevant;
- the smallest sufficient verification suite passes;
- user-facing behavior and project documents are updated in the same pull request;
- the build-plan milestone or GitHub issue is linked when the work changes delivery
  status;
- the worktree contains no unrelated edits or generated artifacts; and
- the handoff states what changed, what was verified, and what remains.

## Handoff format

Leave the next agent a compact, evidence-based handoff:

```text
Outcome:
Files changed:
Verification:
Known limitations or risks:
Linked issue / build-plan item:
Recommended next action:
```

Never claim a provider, platform, installer, accessibility path, or security
property was verified unless that exact boundary was exercised.
