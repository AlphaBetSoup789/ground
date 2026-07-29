# Provider and Runtime SDK

Ground’s provider-neutral adapter contracts have an explicitly versioned public
entry point and a publishable package source under `packages/adapter-sdk/`. The
canonical TypeScript source remains in `src/main/agent/`; the package build compiles
that source into a self-contained CommonJS distribution with declarations rather
than maintaining a second copy. The provisional npm manifest is not evidence that
the package name has been published or that its scope is available.

There are two extension surfaces because “a model” and “a coding agent runtime” do
not have the same authority.

## Package and conformance suite

The pure `src/main/agent/sdk.ts` entry exports API version 1 contracts,
capabilities, normalized event validators, typed errors, registry primitives, and
framework-independent conformance helpers. It intentionally excludes Electron,
the production AI SDK adapter, CLI implementations, and workspace authority.

Build and verify the exact publishable surface with:

```bash
npm run adapter-sdk:build
npm run adapter-sdk:pack-check
```

The pack check permits only compiled JavaScript, declarations, package metadata,
the SDK README, and the MIT license. It installs the generated tarball into a clean
temporary consumer and imports it through its declared package export. Normal
`npm run verify` includes this check so a repo-relative import or accidental
production-only dependency fails CI.

`runModelAdapterConformance` and `runAgentRuntimeAdapterConformance` return
versioned reports without depending on a test framework. Their `assert...`
counterparts throw `AdapterConformanceError`. A fixture supplies a mocked adapter,
one valid configuration, at least one invalid configuration, and optionally a
deterministic request and secret resolver. The suite checks inspection descriptors,
complete capabilities, normalized lifecycle/order, a unique terminal event, and
declared pre-start plus mid-stream cancellation.

`AgentRuntimeEventReducer.push(raw)` is also the incremental production validator
for third-party runtime output. It returns a detached validated event and bounds
event count, identifiers, assistant/activity text, notices, token usage, and
reported USD cost. `finish()` requires one `runtime.completed`, a stable session,
and no open activity.

## What is wired today

The desktop resolves every built-in model and agent runtime through one
source-trusted `AdapterRegistry` and injected model/runtime factories.
Registration is static: the adapter is reviewed, compiled, and shipped with
Ground. Ground does not scan the filesystem, install provider packages, or load
remote adapter code at runtime. Duplicate IDs across either adapter kind, unknown
IDs, kind mismatches, and invalid configuration fail before a stream starts.

Two no-code connection paths cover most models:

- use an OpenAI-compatible profile for a hosted or loopback endpoint that actually
  implements the expected Chat Completions streaming/tool shape; or
- use a Generic CLI profile for a process that accepts stdin/argument prompts and
  emits plain text or one of Ground’s small recognized JSON Lines text shapes.

The generic CLI path does not gain structured activity, usage, native session
resume, or Ground-managed tools automatically. It runs as an external runtime and
owns its own permissions. See the public
[Generic CLI bridge](GENERIC-CLI.md) and its
[dependency-free example](../examples/generic-cli/README.md).

Ground’s built-in workspace tools and approved MCP tools belong to the managed
model path. Any registered `ModelAdapter` receives the same canonical definitions;
when it emits canonical tool calls, `RunManager` performs the same mode checks,
approval flow, execution, bounded result handling, and multi-round feedback. An
OpenAI-compatible endpoint must genuinely support the advertised tool-call shape,
and support remains model-dependent. External CLIs do not receive Ground-hosted
MCP tools—their own runtime configuration owns any MCP integrations.

Codex, Claude, Gemini, Antigravity, and Generic CLI profiles resolve to the
built-in runtime IDs `openai.codex-cli`, `anthropic.claude-code`,
`google.gemini-cli`, `google.antigravity-cli`, and `ground.cli.generic`. Their
adapters delegate to the bounded launcher and parsers
in `src/main/providers/cli.ts`, but all emitted objects cross the canonical runtime
reducer before persistence or presentation. Native session resume binds both the
adapter ID and a separate compatibility ID; Generic CLI has no compatibility ID
and never persists an opaque session. Incompatible records are removed before
prompt construction. Compatible records are deleted before launch as one-attempt
leases and replaced only by a validated terminal session.

The desktop projection also treats registered adapter output as untrusted.
Configured CLI environment values are redacted across assistant-delta boundaries
and from activity/notice text, provider activity IDs are replaced with opaque
Ground IDs, and protected values in model/session identity fail closed. Built-in
CLI adapters redact inherited sensitive environment values at their parser
boundary as well. This defense in depth does not permit an adapter to emit secrets:
resolve them as late as possible, never log or place them in events, and add
negative reflection tests. For model adapters, Ground stream-redacts credentials
resolved before output from successful text and notices; reflected values in tool
arguments, provider state, checkpoints, or response identity fail the run. A
credential request after adapter output begins is rejected.

## Static model registration

An in-tree or downstream build can add a protocol adapter without changing the
canonical event reducer, managed tool loop, MCP broker, persistence, or
`RunManager`. Register the reviewed adapter, resolve a profile to its ID and
configuration, then inject the resulting factory at desktop composition:

```ts
import { AdapterRegistry } from '../src/main/agent'
import { providerCredentialReferenceFor } from '../src/main/provider-credentials'
import { createRegisteredModelRuntimeFactory } from '../src/main/run-manager'
import { ExampleMessagesAdapter } from './example-messages-adapter'

const adapters = new AdapterRegistry().registerModel(
  new ExampleMessagesAdapter()
)

export const modelRuntimeFactory = createRegisteredModelRuntimeFactory(
  adapters,
  (profile) => ({
    adapterId: 'example.messages',
    config: {
      endpoint: profile.baseUrl,
      model: profile.model,
      apiKeyRef: profile.hasApiKey
        ? providerCredentialReferenceFor(profile)
        : undefined
    }
  })
)
```

The factory clones the renderer-safe provider profile, resolves exactly one
registered model adapter, and calls that adapter’s `validateConfig` before
returning a runtime. Credential values are still resolved indirectly inside the
main-process run; the registration must pass only the endpoint-scoped reference.

Agent runtimes use the parallel `createRegisteredAgentRuntimeFactory`. Its binding
selects a registered runtime ID, data-only configuration, and an optional
`sessionCompatibilityId`. `RunManager` validates every event with
`AgentRuntimeEventReducer`, persists only a fully compatible session, and never
accepts a renderer-selected module path:

```ts
const runtimeAdapters = new AdapterRegistry().registerAgentRuntime(
  new ExampleCodingCliAdapter()
)
const agentRuntimeFactory = createRegisteredAgentRuntimeFactory(
  runtimeAdapters,
  (profile) => ({
    adapterId: 'example.coding-cli',
    config: profile,
    sessionCompatibilityId: 'example-session-v1'
  })
)
```

This is an integration seam, not a stable binary plugin ABI. A new protocol can
reuse the existing endpoint/model/credential profile envelope in a downstream
build. A new first-class provider kind, provider-specific fields, capability UI,
or discovery behavior still requires reviewed changes to the shared profile
schema, validation, renderer form, `ProviderService` connection test, portability
rules, secret-reference/journal migration rules, and desktop composition. Reusing
an existing kind also inherits that kind’s model-discovery and request-policy
defaults.

It also inherits the saved-provider readiness lifecycle. Every save resets
verification to unverified; Test can persist a result only for the exact still-saved
revision, and run startup requires a pass. First-class provider kinds perform their
bounded discovery probe. The OpenAI-compatible kind first tries `/models` and can
fall back to one non-streaming four-token `/chat/completions` generation when
listing cannot prove compatibility. A new first-class kind must define a truthful
preflight in `ProviderService` without describing that preflight as live
certification.

## Model adapters

A `ModelAdapter<C>`:

1. validates untrusted configuration into `C`;
2. inspects models and capabilities without leaking secrets; and
3. streams canonical `ModelEvent` values for a `ModelRequest`.

It receives an `AdapterContext<C>` containing validated configuration, an
`AbortSignal`, an indirect `SecretResolver`, and an optional structured logger. It
does not receive Electron renderer objects or direct filesystem/process authority.

Canonical model events cover:

- response start;
- text, reasoning-summary, and tool-call part lifecycle;
- streamed tool arguments and parallel tool calls;
- cumulative or delta usage;
- provider notices and retry metadata; and
- exactly one terminal response with a normalized stop reason.

The `ModelEventReducer` rejects invalid ordering, duplicate terminal responses,
unfinished parts, mismatched deltas, non-JSON-safe provider state, excessive part
counts, oversized aggregate text/reasoning/tool arguments, and oversized
identifiers or notices.

## Agent runtime adapters

An `AgentRuntimeAdapter<C>` validates and inspects a runtime, then streams
`AgentRuntimeEvent` values for a workspace-scoped run.

Canonical runtime events cover:

- runtime/session identity;
- assistant text deltas;
- command, file, tool, plan, reasoning, and diagnostic activity;
- usage and provider notices; and
- one terminal runtime result.

Each runtime declares a `permissionOwner`. A parsed event that says a tool ran is
observability, not evidence that Ground approved or denied it.

Runtime adapters must enforce independent limits for normalized text, total process
stdout/stderr, event count, line/event fields, notices, and session identifiers.
Cancellation must work before executable resolution, before spawn, and during the
stream. Ground races each iterator read against the run signal, calls `return()`
best effort, rechecks cancellation around every canonical event, and compensates
terminal continuation writes if Stop lands during persistence. An adapter must
still stop its transport and descendants promptly.

## Capabilities

Feature support is explicit:

- `native`
- `emulated`
- `unsupported`
- `unknown`

Use `unknown` until a protocol and model combination is verified. Do not infer a
complete capability set from an OpenAI-shaped base URL or provider brand.

Capabilities cover streaming, instructions, tools, parallel calls, argument
streaming, strict schemas, structured output, reasoning summaries, opaque-state
replay, media input, usage, discovery, continuation, cancellation, runtime
activities, and permission ownership.

Capability descriptors are part of the versioned adapter contract, but the current
provider form does not perform live model-capability negotiation. Its tools toggle,
context-window estimate, maximum output tokens, and optional reasoning effort are
explicit user configuration. Leave provider-specific generation controls unset
unless the selected model/protocol is known to support them. The current managed
loop advertises sequential rather than parallel tool execution.

## Canonical history and portability

Ground persists normalized user/assistant messages and tool results. Provider-owned
response IDs, reasoning signatures, cache tokens, and continuation checkpoints may
also be retained as:

```ts
interface ProviderState {
  adapterId: string
  schemaVersion: 1
  data: JsonValue
}
```

An adapter may replay opaque state only when its adapter, complete
provider-configuration fingerprint, model, workspace, and task mode still match.
When a user switches providers, Ground sends
the normalized conversation—including reconstructed tool-call/tool-result pairs—
and omits foreign opaque state. Assistant messages and activities retain the
provider/model attribution captured when their run began. Provider state is an
acceleration layer, never the sole readable history.

The version 1 task-bundle format is a content-portability boundary, not adapter
state serialization. It omits provider-owned state, credentials, runtime sessions,
workspace grants, pending approvals, and original IDs. An API hint matches a
configured profile only on its exported public descriptor: type/kind, name, model,
and tool-support flag. A CLI hint matches type/kind, name, model, and adapter.
Provider IDs, endpoints, credentials, and secret revisions are neither exported nor
matched. Only a matching API profile may use the imported portable canonical
conversation, and only after the user explicitly enables imported-history context
and starts a later run. Adapter continuation compatibility is bound to that choice;
imported content remains untrusted.

## Configuration and secrets

- Adapter configuration must be validated before use.
- Persist only a secret reference, never the credential value.
- Resolve the credential in the main process immediately before the request.
- Resolve every credential before yielding the first event. Ground rejects late
  resolution so one immutable redaction boundary covers the complete stream.
- Bind saved credentials to the provider ID, protocol, and canonical endpoint
  through an opaque versioned reference.
- Reject non-loopback plaintext endpoints, redirects, embedded credentials, query
  strings, and fragments.
- Redact authorization headers, prompt content, tool results, and provider state
  from logs by default.
- Treat successful response content as untrusted reflection. Never place a
  credential in text, notices, tool calls, provider state, checkpoints, or IDs
  even though Ground applies an independent projection boundary.

The public adapter contract exposes indirect secret reads, not vault mutation.
Any downstream desktop change that creates, replaces, clears, deletes, or migrates
a secret reference must use the main-process state-coupled cleanup protocol:

1. journal a unique replacement reference as provisional cleanup before staging
   ciphertext;
2. publish the provider pointer and replace that provisional intent with exact
   obsolete references in one persisted-state transaction;
3. delete only those journaled references after checking the selected provider
   state's metadata-derived live set, then acknowledge successful deletion; and
4. abort startup, or seal and relaunch an already-running app, on ambiguous state
   or vault publication instead of attempting an inverse cross-file mutation.

Clear and provider deletion must publish their state change and cleanup intents
together. A migration must define exact current, legacy, and obsolete reference
rules, preserve pre-versioned fallbacks only where runtime resolution still permits
them, and leave unknown unjournaled ciphertext untouched. Adapter code and migration
hooks must not write/delete `SecretVault` directly, enumerate-delete the complement
of current providers, or infer disposability from credential decryption failure.

## Contract tests

Every model adapter must pass the package conformance suite with a mocked transport
and should add protocol-specific fixtures for:

- text and reasoning streaming;
- split and parallel tool calls;
- usage semantics;
- cancellation before and during output;
- malformed or unknown future events;
- authentication, permission, rate-limit, overload, timeout, and protocol errors;
- mid-stream failure with partial-output metadata; and
- exactly one terminal response.

Every runtime adapter must pass the package conformance suite with a mocked process
and should additionally cover:

- executable resolution and argv construction;
- prompt transport;
- Ask and Agent permission modes;
- session creation and compatible resume;
- text, activity, diagnostics, and usage normalization;
- malformed/unknown lines and bounded buffering;
- cancellation with termination escalation; and
- explicit runtime-owned permission disclosure.

Tests must use local fixtures or mocked transports. CI must never require a real
provider key or paid model request. Ground additionally has a credential-free
loopback SSE integration test that performs an actual
`POST /v1/chat/completions` through the production OpenAI-compatible AI SDK
adapter, including system/user messages, tool definitions, and streamed text. It
exercises only that deterministic local wire path—not an authenticated cloud,
Ollama, LM Studio, or CLI deployment.

## Adapter review checklist

- [ ] Stable lowercase adapter ID
- [ ] Runtime validation for all configuration
- [ ] Conservative capability report
- [ ] Indirect secret resolution
- [ ] No direct or unjournaled vault mutation; explicit current/legacy cleanup rules
- [ ] Direct endpoint/executable disclosure
- [ ] Bounded input, output, and buffering
- [ ] Abort and timeout behavior
- [ ] Typed, redacted failures
- [ ] JSON-safe provider state owned by the adapter
- [ ] Explicit behavior for configured context/output/reasoning controls
- [ ] Provider-independent contract fixtures
- [ ] Protocol- or CLI-version fixtures
- [ ] Compatibility and data-egress documentation

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and
[THREAT-MODEL.md](THREAT-MODEL.md) for required trust boundaries.
