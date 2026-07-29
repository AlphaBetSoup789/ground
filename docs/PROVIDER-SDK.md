# Provider and Runtime SDK

Ground’s adapter contracts are experimental internal TypeScript interfaces, not a
published package or stable third-party SDK. They live under `src/main/agent/` and
may change before the first public alpha.

There are two extension surfaces because “a model” and “a coding agent runtime” do
not have the same authority.

## What is wired today

The desktop resolves every built-in model adapter through a source-trusted
`AdapterRegistry` and an injected `ModelRuntimeFactory`. Registration is static:
the adapter is reviewed, compiled, and shipped with Ground. Ground does not scan
the filesystem, install provider packages, or load remote adapter code at runtime.
Duplicate IDs, unknown IDs, kind mismatches, and invalid adapter configuration fail
before a model stream starts.

Two no-code connection paths cover most models:

- use an OpenAI-compatible profile for a hosted or loopback endpoint that actually
  implements the expected Chat Completions streaming/tool shape; or
- use a Generic CLI profile for a process that accepts stdin/argument prompts and
  emits plain text or one of Ground’s small recognized JSON Lines text shapes.

The generic CLI path does not gain structured activity, usage, native session
resume, or Ground-managed tools automatically. It runs as an external runtime and
owns its own permissions.

Ground’s built-in workspace tools and approved MCP tools belong to the managed
model path. Any registered `ModelAdapter` receives the same canonical definitions;
when it emits canonical tool calls, `RunManager` performs the same mode checks,
approval flow, execution, bounded result handling, and multi-round feedback. An
OpenAI-compatible endpoint must genuinely support the advertised tool-call shape,
and support remains model-dependent. External CLIs do not receive Ground-hosted
MCP tools—their own runtime configuration owns any MCP integrations.

`AgentRuntimeAdapter` and agent-runtime registration are contract scaffolding, not
the current CLI composition path. Codex, Claude, Gemini, and Generic CLI profiles
currently use the bounded launcher and parsers in `src/main/providers/cli.ts`.
Wiring source-registered runtime adapters through the desktop composition remains
future work.

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

This is an integration seam, not a stable binary plugin ABI. A new protocol can
reuse the existing endpoint/model/credential profile envelope in a downstream
build. A new first-class provider kind, provider-specific fields, capability UI,
or discovery behavior still requires reviewed changes to the shared profile
schema, validation, renderer form, `ProviderService` connection test, portability
rules, and desktop composition. Reusing an existing kind also inherits that kind’s
model-discovery and request-policy defaults.

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
stream.

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

Capability descriptors are still an internal contract; the current provider form
does not perform live model-capability negotiation. Its tools toggle,
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

An adapter may replay opaque state only when its adapter, provider revision, model,
workspace, and task mode still match. When a user switches providers, Ground sends
the normalized conversation—including reconstructed tool-call/tool-result pairs—
and omits foreign opaque state. Assistant messages and activities retain the
provider/model attribution captured when their run began. Provider state is an
acceleration layer, never the sole readable history.

The version 1 task-bundle format is a content-portability boundary, not adapter
state serialization. It omits provider-owned state, credentials, runtime sessions,
workspace grants, pending approvals, and original IDs. An exact configured API
provider may use the imported portable canonical conversation only after the user
explicitly enables imported-history context and starts a later run. Adapter
continuation compatibility is bound to that choice; imported content remains
untrusted.

## Configuration and secrets

- Adapter configuration must be validated before use.
- Persist only a secret reference, never the credential value.
- Resolve the credential in the main process immediately before the request.
- Bind saved credentials to the provider ID, protocol, and canonical endpoint
  through an opaque reference. Write a new-boundary secret before profile
  persistence and garbage-collect the old reference only afterward.
- Reject non-loopback plaintext endpoints, redirects, embedded credentials, query
  strings, and fragments.
- Redact authorization headers, prompt content, tool results, and provider state
  from logs by default.

## Contract tests

Every model adapter should share fixtures for:

- text and reasoning streaming;
- split and parallel tool calls;
- usage semantics;
- cancellation before and during output;
- malformed or unknown future events;
- authentication, permission, rate-limit, overload, timeout, and protocol errors;
- mid-stream failure with partial-output metadata; and
- exactly one terminal response.

Every runtime adapter should cover:

- executable resolution and argv construction;
- prompt transport;
- Ask and Agent permission modes;
- session creation and compatible resume;
- text, activity, diagnostics, and usage normalization;
- malformed/unknown lines and bounded buffering;
- cancellation with termination escalation; and
- explicit runtime-owned permission disclosure.

Tests must use local fixtures or mocked transports. CI must never require a real
provider key or paid model request.

## Adapter review checklist

- [ ] Stable lowercase adapter ID
- [ ] Runtime validation for all configuration
- [ ] Conservative capability report
- [ ] Indirect secret resolution
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
