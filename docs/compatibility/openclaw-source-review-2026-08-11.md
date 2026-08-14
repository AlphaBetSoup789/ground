# OpenClaw interface source review — 2026-08-11

This is a credential-free upstream **source review** for Ground 0.1.0. No OpenClaw
package was installed, no OpenClaw executable was run, no `--version` probe was
performed, and no model request was made. It records which OpenClaw command
surface Ground would have to target, why neither currently qualifies as a
first-class Ground runtime, and the exact conditions under which the decision
should be revisited.

It is not a compatibility observation of a locally installed binary (compare
[cli-help-2026-07-28.md](cli-help-2026-07-28.md), which recorded installed
versions and help surfaces for other runtimes). Nothing here adds OpenClaw to
Ground's supported-runtime matrix, to
[COMPATIBILITY.md](../COMPATIBILITY.md)'s connection matrix, or to the pinned
[compatibility fixture set](../../fixtures/compatibility/README.md).

Build-plan item: [M5.1a](../BUILD-PLAN.md) — First-class external agent runtimes.

## Refs examined

Package identity was resolved from the npm registry, then each distribution tag
was resolved to its git tag and read at that exact commit.

| Channel | Version | Git tag | Commit |
| --- | --- | --- | --- |
| npm `latest` (stable) | `2026.7.1-2` | `v2026.7.1-2` | `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c` |
| npm `extended-stable` | `2026.6.34` | `v2026.6.34` | `5c38f996d4059ebd9080cf74dc611ec3a17f4d50` |
| npm `beta` (prerelease) | `2026.8.1-beta.1` | `v2026.8.1-beta.1` | `ff8a3fe9d03eff4a70f5464714c3a389b06bfec8` |

Package metadata at `2026.7.1-2`: `bin` is `{ "openclaw": "openclaw.mjs" }`;
`engines.node` is `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.

Files read at the stable tag `0790d9f5`:

- `src/cli/program/register.agent-turn.ts`
- `src/commands/agent-via-gateway.ts`
- `src/commands/agent.ts`
- `src/agents/agent-command.ts`
- `src/agents/agent-scope-config.ts`
- `docs/cli/agent.md`

Files read at the prerelease tag `ff8a3fe9`:

- `src/commands/agent-exec.ts`
- `src/cli/program/register.agent-turn.ts`
- `src/runtime.ts`
- `packages/terminal-core/src/progress-line.ts`
- `src/agents/model-ref-shared.ts`
- `docs/cli/agent.md`

Presence of the `agent exec` subcommand was additionally checked at
`v2026.6.34`, `v2026.7.1-2`, `v2026.7.2-beta.1`, `v2026.7.2-beta.4`,
`v2026.7.2-beta.5`, `v2026.7.2-beta.6`, and `v2026.7.2-beta.7`.

## Finding 1 — the stable surface is rejected as Ground's first-class interface

The only agent-turn entry point in stable OpenClaw is `openclaw agent`, with
`--local` selecting embedded execution and `--json` selecting structured output.
Ground rejects `openclaw agent --local --json` as the basis for a first-class
`AgentRuntimeAdapter`. The missing invocation-bound workspace and the inherited
configuration authority are independently disqualifying. The required selector
adds a session-ownership risk that the stable surface does not isolate.

### 1.1 No explicit working directory

`register.agent-turn.ts` at `0790d9f5` registers exactly these options for
`openclaw agent`: `-m, --message`, `--message-file`, `-t, --to`, `--session-key`,
`--session-id`, `--agent`, `--model`, `--thinking`, `--verbose`, `--channel`,
`--reply-to`, `--reply-channel`, `--reply-account`, `--local`, `--deliver`,
`--json`, and `--timeout`. There is **no `--cwd`** and no other invocation-level
workspace flag.

The workspace is resolved from configuration instead. In
`src/agents/agent-command.ts:797-798`:

```ts
const workspaceDirRaw =
  normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
```

`normalizedSpawned.workspaceDir` is an internal programmatic field used by
subagent spawns, not a CLI option. `resolveAgentWorkspaceDir`
(`src/agents/agent-scope-config.ts:181-199`) reads the per-agent
`workspace`, then `cfg.agents.defaults.workspace`, then a default derived from
the process environment.

Ground's architecture requires that the canonical workspace be supplied
explicitly by the privileged main process and bound into the invocation
authorization envelope, alongside the content-hashed launch identity and the
exact argv. A runtime whose working directory is chosen by an external
configuration file cannot satisfy that binding: Ground would be authorizing a
launch whose actual workspace it neither supplied nor can verify.

### 1.2 A session or agent selector is required

`src/commands/agent-via-gateway.ts:690-696`:

```ts
if (!opts.to && !opts.sessionId && !opts.agent && !explicitSessionKey) {
  throw new Error(
    `No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>. ...`,
  );
}
```

Every turn must name a target session, agent id, session key, or E.164
recipient. An `--agent` value is further validated against the configured agent
set (`listAgentIds(cfg)` at `:703`); an unknown id is rejected.

Ground currently has no reviewed mapping from its provider-neutral task identity
to an OpenClaw agent id, session key, or messaging recipient, and it must not
silently invent or reuse one. A future pinned interface could permit a fresh,
isolated per-run selector if the associated state is transient and carries no
authority beyond that run. The stable surface does not establish that isolation;
its selector resolves through configured agent and session state. Using it can
therefore join durable external conversation state that Ground does not own, did
not create, and cannot reason about — the opposite of Ground's rule that readable
history belongs to the user's Ground task, not to a provider-owned conversation
object.

### 1.3 Workspace, session, plugin, and fallback behavior come from external configuration

At the stable tag, one embedded turn resolves the following from the ambient
OpenClaw configuration rather than from the invocation:

| Concern | Resolution at `0790d9f5` |
| --- | --- |
| Workspace | `resolveAgentWorkspaceDir(cfg, sessionAgentId)` (`agent-command.ts:798`) |
| Agent/session state directory | `resolveAgentDir(cfg, sessionAgentId)` (`agent-command.ts:802`) |
| Plugins | `normalizePluginsConfig(cfg.plugins).enabled` (`agent-command.ts:803`) |
| Model fallback chain | `resolveEffectiveModelFallbacks(...)` feeding `runWithModelFallback` (`agent-command.ts:2064`, `:2110`, `:2194`) |

Consequently, the same Ground-authorized invocation can run in a different
directory, against a different retained session, with different plugins loaded,
and can silently complete on a different provider and model than the one Ground
requested. Ground would then persist assistant content, activity, and provider
attribution that it cannot justify.

Ground's threat model treats external runtime output as untrusted observability
and accepts that a runtime owns its own tools and permissions. It does not
accept a runtime whose *workspace and provider identity* are chosen outside the
authorized invocation, because those are the two facts Ground's own authorization
boundary is built on.

## Finding 2 — `agent exec` exists only in prereleases

`openclaw agent exec` is the interface that would satisfy most of Ground's
requirements: it accepts `--cwd`, reads the prompt through `--message-file -`,
and emits a documented terminal JSON envelope under `--json`. It is not
available in any stable release.

| Ref | `agent exec` present |
| --- | --- |
| `v2026.6.34` (`extended-stable`) | No |
| `v2026.7.1-2` (`latest`) | No |
| `v2026.7.2-beta.1` … `v2026.7.2-beta.4` | No |
| `v2026.7.2-beta.5` | First appearance (partial) |
| `v2026.7.2-beta.6`, `v2026.7.2-beta.7` | Present |
| `v2026.8.1-beta.1` (`beta`) | Present |

At `v2026.7.1-2` the subcommand is absent from both
`src/cli/program/register.agent-turn.ts` and `docs/cli/agent.md`. At
`ff8a3fe9` it is registered in `register.agent-turn.ts` and implemented in
`src/commands/agent-exec.ts`.

**Ground therefore cannot list OpenClaw in its supported-runtime matrix.** A
prerelease interface has no stability commitment, cannot be pinned as a
non-prerelease compatibility fixture version, and cannot back a daily-driver
acceptance gate.

Building a prerelease-only integration — even one labelled experimental —
requires a **separate, explicit experimental-support decision** recorded through
the public design-issue and maintainer-approval process in
[GOVERNANCE.md](../../GOVERNANCE.md). Until such a decision exists, no OpenClaw
adapter may be registered, no OpenClaw profile may be selectable, and no
OpenClaw fixture may be added to the pinned set.

### Prerelease observations retained for the future decision

These were read at `ff8a3fe9` and are recorded so the readiness review below
does not have to start from nothing. They describe a prerelease and are **not**
a contract Ground relies on.

- `--cwd <dir>` sets both the agent workspace and the tool working directory.
  `setAgentExecEnvironment` (`agent-exec.ts:451-460`) additionally overwrites
  `OPENCLAW_WORKSPACE_DIR` and `OPENCLAW_STATE_DIR` for the run and deletes
  `OPENCLAW_CONFIG_PATH`. It does **not** neutralize `OPENCLAW_HOME`,
  `OPENCLAW_PROFILE`, `OPENCLAW_GIT_DIR`, `OPENCLAW_INCLUDE_ROOTS`, or
  `OPENCLAW_LOAD_SHELL_ENV`.
- Under `--json`, stdout carries exactly one JSON document. It is
  **pretty-printed** across multiple lines: `writeRuntimeJson` defaults to
  `space = 2` (`src/runtime.ts:145-153`, `:94`). Line-oriented JSON parsing is
  therefore wrong, not merely fragile. Progress output registers only on a TTY
  (`packages/terminal-core/src/progress-line.ts`), so a piped stdout receives no
  progress bytes.
- Exit status is derived from the envelope: `exitCodeForEnvelope`
  (`agent-exec.ts:258`) maps `status: "ok"` to `0`, `"timeout"` to `2`, and
  everything else to `1`. Exit code and envelope status are therefore
  cross-checkable.
- `error.kind` is an open set. The command itself produces `"timeout"`,
  `"fallback_exhausted"`, `"aborted"`, `"error_payload"`, `"agent_error"`, and
  `"exception"`, and additionally passes through an arbitrary `meta.error.kind`
  from the embedded run.
- `envelope.final` already excludes error, reasoning, and commentary payloads.
  Re-deriving that filter from `payloads[]` would duplicate upstream policy.
- `envelope.model` and `envelope.provider` are the **resolved** identity. Model
  ids are normalized through per-plugin manifest rules — aliases,
  `stripPrefixes`, `prefixWhenBare` (`src/agents/model-ref-shared.ts`) — so
  exact request-versus-report model-id equality is not a stable check. Provider
  ids normalize deterministically and are comparable.
- `sessionId` is a `randomUUID()` generated by the command, and without an
  explicit `--state-dir` the temporary state directory is removed during
  cleanup. It names state that no longer exists.
- `--timeout` (default `600`) is forwarded into the agent run as its own
  deadline. It bounds the OpenClaw turn. It is **not** a process kill enforced by
  the CLI or by Ground, and it says nothing about descendants.

## Readiness conditions for reconsidering OpenClaw

OpenClaw may be reconsidered for a first-class Ground `AgentRuntimeAdapter` only
at a **pinned, non-prerelease** version, and only when a fresh source review plus
deterministic fixtures establish every condition below. Each is a gate, not a
preference.

1. **Exact canonical workspace binding.** The invocation accepts the canonical
   workspace path supplied by Ground's main process, that path governs both the
   agent workspace and tool working directory, and no ambient configuration or
   environment value can redirect it. Verified by source review at the pinned
   tag, not by documentation.
2. **Bounded structured terminal output.** Exactly one structured document on
   stdout under an explicit machine-output flag, with diagnostics on stderr, a
   documented field set, and a size bound Ground can enforce before parsing.
3. **Deterministic exit/status semantics.** A documented, stable mapping between
   process exit code and the reported status, such that a disagreement between
   them is provably a contract violation rather than an accepted state.
4. **Inherited fallback behavior disabled or explicitly authorized.** Either the
   invocation can disable configured model fallbacks, or the resulting provider
   and model change is surfaced in a way Ground can authorize and attribute. A
   silent provider switch is disqualifying.
5. **Trustworthy resolved provider/model attribution.** The resolved provider and
   model are reported in a form Ground can validate before it persists any
   assistant content, and Ground has a reviewed mechanism for attributing that
   content to the resolved identity rather than to the configured one.
6. **Cancellation and process-tree behavior.** Documented and fixture-verified
   response to `SIGTERM`/`SIGKILL`, with Ground's existing process-group and
   `taskkill.exe /T /F` cleanup exercised against a deterministic child,
   including a descendant that ignores the first signal.
7. **No imported external session, approval, plugin, or workspace authority.** A
   Ground run must not join or inherit a durable OpenClaw session; must not treat
   an OpenClaw permission decision as a Ground approval; must not gain authority
   from operator plugin roots; and must not acquire workspace authority beyond
   the path Ground supplied. An isolated per-run session identifier or temporary
   state is acceptable only when it is created for that invocation, removed after
   it, carries no prior authority, and is never persisted as portable Ground
   continuation state.

Meeting all seven still yields only "integrated"; see
[COMPATIBILITY.md](../COMPATIBILITY.md) for the separate evidence required before
any connection is described as supported or live-certified.

## Not established by this review

- No OpenClaw package was installed and no OpenClaw executable was run.
- No `--version` probe, authenticated request, paid model request, filesystem
  action, or command action was performed.
- No runtime behavior was observed: stream ordering, cancellation, session
  continuity, permission enforcement, plugin behavior, and credential handling
  are all unverified.
- Windows and Linux invocation behavior was not exercised. The npm-generated
  `openclaw.cmd` shim was not examined against Ground's reviewed Windows Node
  package-shim path.
- Prerelease observations describe `ff8a3fe9` only and may change without notice.
- Nothing here is a fixture, a pinned contract, or evidence for any Ground
  release claim.

---

## Appendix A — Deferred design notes

> **NOT APPROVED FOR IMPLEMENTATION.** Everything in this appendix is retained
> design analysis for a future, separately approved slice. No part of it is
> authorized by this document. It does not describe current Ground behavior, and
> it must not be cited as a decision, a contract, or a plan of record.
>
> This change deliberately does **not** widen any persisted schema, bump the
> persisted state version, add a launcher output protocol, alter the adapter
> registry, or modify production runtime code.

### A.1 Single-construction invocation (deferred)

Ground's CLI launcher currently constructs argv twice for one launch: once with
the real prompt and once with a placeholder for display, and it derives the
prompt transport from the saved profile's `promptMode` rather than from the argv
it will actually spawn. Two constructions can diverge, and the authorization
digest covers one while the dialog shows the other.

A future slice could build one frozen invocation object per launch — the exact
argv, the exact stdin bytes if any, and the argv indexes that carry prompt text —
and then hash, display, authorize, and execute **that same object**:

- the prompt transport is derived from the object (stdin present versus prompt
  text in argv), never from the persisted `promptMode`;
- a construction that claims stdin transport while also placing prompt text in
  argv is rejected before authorization;
- the displayed argv is produced by masking the prompt-bearing indexes of the
  hashed argv, so every non-prompt argument shown is byte-identical to what will
  be spawned.

This would harden all existing recognized CLI dialects, independently of
OpenClaw. It is a change to a shared security boundary and would need its own
threat statement, negative tests, and review.

### A.2 Terminal-document parsing (deferred)

A runtime that emits one structured document at process exit — rather than an
event stream — cannot be normalized by line-oriented parsing. A future slice
would need a strictly ordered, atomic path: buffer bounded stdout, keep stderr in
the bounded diagnostic accumulator only, wait for process close, check
cancellation, parse exactly one document while rejecting trailing content,
validate the document against the observed exit code, validate the resolved
provider identity, bound and redact every field, and only then emit canonical
events.

**Corrected atomic-output invariant.** Malformed, oversized, contradictory, or
identity-mismatched output emits **zero** `AgentRuntimeEvent`s — including no
`runtime.started`. An earlier draft of this analysis proposed emitting
`runtime.started` before failing; that is wrong. A run whose output Ground could
not validate must produce no canonical runtime events at all, so no partial
lifecycle, no attribution, and no semantic success can be persisted from an
unvalidated document. The failure surfaces as a typed adapter error only.

The same invariant applies to cancellation: if a run is cancelled before the
process closes, the buffered output is discarded unparsed and no canonical event
is emitted. There is no open activity to terminalize, because under atomic
handling no activity exists until a document has been validated.

### A.3 Environment rejection posture (deferred)

An enumerated deny-list of OpenClaw environment variables is the wrong shape: it
must be re-audited on every upstream release, and a newly added root-redirection
variable is admitted by default until someone notices.

The correct default is the inverse. Any future OpenClaw integration should
**reject every custom `OPENCLAW_*` variable by default** — both variables
inherited from Ground's own process environment and variables supplied through
Ground's encrypted CLI-profile environment — and permit an individual variable
only when a future reviewed contract explicitly names it, with a recorded reason.
The default must be closed, so that a variable introduced upstream after the
review has no effect on a Ground-authorized launch until it is deliberately
admitted.

This replaces the finite rejection list proposed in earlier analysis. That list
enumerated `OPENCLAW_WORKSPACE_DIR`, `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`,
`OPENCLAW_CONFIG_PATH`, `OPENCLAW_PROFILE`, `OPENCLAW_GIT_DIR`,
`OPENCLAW_INCLUDE_ROOTS`, `OPENCLAW_LOAD_SHELL_ENV`, and the Gateway
redirection variables; those remain useful as examples of *why* the default must
be closed, not as the boundary itself.

Ground's existing global rules — no `PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`,
`HOME`, `USERPROFILE`, `XDG_*`, or `TMP`/`TEMP`/`TMPDIR` override from a profile
environment — continue to apply underneath any such contract.
