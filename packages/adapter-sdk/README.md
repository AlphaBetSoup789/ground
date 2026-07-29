# Ground Adapter SDK

`@ground-app/adapter-sdk` is the versioned, provider-neutral contract package for
building model adapters and external coding-agent runtime adapters for Ground.
The package name is provisional until Ground’s maintainers perform the first npm
release; this repository does not imply that any npm scope is currently owned or
available.

The package contains only pure TypeScript/JavaScript contracts, normalized event
validators, typed errors, registry primitives, and a deterministic conformance
runner. It does not contain Electron APIs, workspace authority, the production AI
SDK adapter, secrets, or dynamic plugin loading.

## Contract version

```ts
import {
  GROUND_ADAPTER_API_VERSION,
  GROUND_ADAPTER_CONFORMANCE_VERSION
} from '@ground-app/adapter-sdk'

// Both are currently 1.
```

The npm package version and contract version serve different purposes. Semver
describes releases of the package. `GROUND_ADAPTER_API_VERSION` identifies the
normalized contract implemented by an adapter. Pre-1.0 package releases can still
change while the public-alpha SDK is evaluated.

## Model adapter

Ground owns the conversation, tool loop, approvals, and workspace side effects for
a `ModelAdapter`. An adapter validates untrusted configuration, reports explicit
capabilities, and emits canonical model events:

```ts
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelAdapter
} from '@ground-app/adapter-sdk'

interface Config {
  endpoint: string
}

export const adapter: ModelAdapter<Config> = {
  id: 'example.messages',
  validateConfig(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { endpoint?: unknown }).endpoint !== 'string'
    ) {
      throw new TypeError('endpoint is required')
    }
    return { endpoint: (value as { endpoint: string }).endpoint }
  },
  async inspect() {
    return {
      capabilities: {
        ...DEFAULT_MODEL_CAPABILITIES,
        streaming: 'native',
        cancellation: 'abort-signal'
      }
    }
  },
  async *stream(request, context) {
    if (context.signal.aborted) throw context.signal.reason
    yield { type: 'response.started', responseId: request.requestId }
    if (context.signal.aborted) throw context.signal.reason
    yield {
      type: 'part.started',
      part: { kind: 'text', partId: 'text-1' }
    }
    yield {
      type: 'part.completed',
      partId: 'text-1',
      part: { kind: 'text', text: 'fixture response' }
    }
    yield {
      type: 'response.completed',
      messageId: 'message-1',
      stopReason: 'complete'
    }
  }
}
```

Real adapters should use a mocked transport in conformance tests and must never
place credential values in configuration. Resolve opaque references through the
provided `SecretResolver` before yielding the first event. Treat all successful
output as a possible reflection boundary: Ground independently redacts resolved
credentials from text/notices and rejects them in structured tool or continuation
state, but adapters must never intentionally emit them.

## Agent runtime adapter

An `AgentRuntimeAdapter` integrates a complete coding-agent process. The external
runtime may own tools and permissions; its normalized activity is observability,
not proof that Ground authorized the action.

Use `AgentRuntimeEventReducer` before persisting or presenting any third-party
event. Its `push(raw)` method returns a detached validated event for incremental
handling, while `finish()` requires exactly one terminal event and no open
activities:

```ts
import { AgentRuntimeEventReducer } from '@ground-app/adapter-sdk'

const reducer = new AgentRuntimeEventReducer()
for await (const raw of externalRuntimeEvents) {
  const event = reducer.push(raw)
  await persistValidatedEvent(event)
}
const summary = reducer.finish()
```

The reducer bounds event counts, identifiers, assistant and activity text,
notices, usage, and reported USD cost. It enforces `runtime.started` first,
activity lifecycle integrity, stable session identity, and one final
`runtime.completed`. Host consumers race iterator reads against cancellation and
call `return()` best effort; adapters must still terminate their own transport and
descendant processes promptly.

## Conformance

The conformance helpers do not depend on Vitest, Jest, or another test framework.
Construct the adapter with a deterministic mocked transport, supply one valid and
at least one invalid configuration fixture, and assert the returned report in the
test runner of your choice:

```ts
import {
  assertModelAdapterConformance
} from '@ground-app/adapter-sdk'
import { adapter } from './adapter'

await assertModelAdapterConformance({
  adapter,
  validConfig: { endpoint: 'https://fixture.invalid' },
  invalidConfigs: [null, {}],
  timeoutMs: 2_000
})
```

There is an equivalent `assertAgentRuntimeAdapterConformance`. The suite validates
adapter IDs, accepted and rejected configuration fixtures, inspection descriptors
and capability completeness, a successful normalized stream lifecycle, and
pre-aborted plus mid-stream cancellation when cancellation is declared.

`runModelAdapterConformance` and `runAgentRuntimeAdapterConformance` return reports
instead of throwing. A skipped cancellation check means the adapter explicitly
declared cancellation as `none`; it is not presented as verified support.

## Integration boundary

Passing conformance does not install an adapter into Ground. The open-source
desktop currently uses source-reviewed, statically registered adapters. Publishing
this package is a separate maintainer release step, and runtime package discovery
is intentionally outside this SDK.

See Ground’s `docs/PROVIDER-SDK.md`, security policy, and threat model before
integrating a new endpoint or executable.
