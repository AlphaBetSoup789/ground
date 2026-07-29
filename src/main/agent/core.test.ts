import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_RUNTIME_CAPABILITIES,
  DEFAULT_MODEL_CAPABILITIES,
  mergeAgentRuntimeCapabilities,
  mergeModelCapabilities
} from './capabilities'
import type {
  AgentRuntimeAdapter,
  ModelAdapter
} from './contracts'
import {
  ProviderError,
  parseRetryAfter,
  providerErrorFromHttp,
  toProviderError
} from './errors'
import {
  assertJsonValue,
  isJsonObject,
  isJsonValue
} from './json'
import {
  AdapterKindMismatchError,
  AdapterRegistry,
  DuplicateAdapterError,
  UnknownAdapterError
} from './registry'

describe('JSON-safe provider data', () => {
  it('accepts JSON values and shared, non-cyclic references', () => {
    const shared = { token: 'opaque' }
    const value = {
      enabled: true,
      count: 2,
      state: shared,
      repeated: shared,
      list: [null, 'text', 4]
    }

    expect(isJsonValue(value)).toBe(true)
    expect(isJsonObject(value)).toBe(true)
    expect(() => assertJsonValue(value)).not.toThrow()
  })

  it.each([
    ['non-finite numbers', Number.NaN],
    ['undefined values', { missing: undefined }],
    ['class instances', new Date()],
    ['bigints', 1n],
    ['sparse arrays', new Array(2)]
  ])('rejects %s', (_label, value) => {
    expect(isJsonValue(value)).toBe(false)
    expect(() => assertJsonValue(value)).toThrow(TypeError)
  })

  it('rejects cycles', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(isJsonValue(value)).toBe(false)
  })
})

describe('capability defaults', () => {
  it('makes unsupported knowledge explicit and immutable by default', () => {
    expect(DEFAULT_MODEL_CAPABILITIES.customTools).toBe('unknown')
    expect(DEFAULT_AGENT_RUNTIME_CAPABILITIES.sessionResume).toBe('unknown')
    expect(Object.isFrozen(DEFAULT_MODEL_CAPABILITIES)).toBe(true)
    expect(Object.isFrozen(DEFAULT_AGENT_RUNTIME_CAPABILITIES)).toBe(true)
  })

  it('merges provider declarations without mutating the defaults', () => {
    const model = mergeModelCapabilities({
      streaming: 'native',
      customTools: 'emulated',
      cancellation: 'abort-signal'
    })
    const runtime = mergeAgentRuntimeCapabilities({
      structuredEvents: 'native',
      permissionOwner: 'ground'
    })

    expect(model).toMatchObject({
      streaming: 'native',
      customTools: 'emulated',
      imageInput: 'unknown',
      cancellation: 'abort-signal'
    })
    expect(runtime).toMatchObject({
      structuredEvents: 'native',
      sessionResume: 'unknown',
      permissionOwner: 'ground'
    })
    expect(DEFAULT_MODEL_CAPABILITIES.streaming).toBe('unknown')
    expect(DEFAULT_AGENT_RUNTIME_CAPABILITIES.permissionOwner).toBe('runtime')
    expect(Object.isFrozen(model)).toBe(true)
    expect(Object.isFrozen(runtime)).toBe(true)
  })
})

describe('provider errors', () => {
  it('classifies HTTP failures and retry guidance', () => {
    const limited = providerErrorFromHttp({
      status: 429,
      message: 'slow down',
      providerCode: 'rate_limit_exceeded',
      requestId: 'req_123',
      retryAfter: '2.5'
    })
    const auth = providerErrorFromHttp({
      status: 401,
      message: 'bad key'
    })
    const overloaded = providerErrorFromHttp({
      status: 503,
      message: 'busy'
    })

    expect(limited).toMatchObject({
      category: 'rate-limit',
      retryable: true,
      requestId: 'req_123',
      retryAfterMs: 2_500,
      partialOutput: false
    })
    expect(auth).toMatchObject({
      category: 'authentication',
      retryable: false
    })
    expect(overloaded).toMatchObject({
      category: 'overloaded',
      retryable: true
    })
  })

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.UTC(2026, 0, 1)
    expect(parseRetryAfter(3, now)).toBe(3_000)
    expect(parseRetryAfter('1.25', now)).toBe(1_250)
    expect(
      parseRetryAfter(new Date(now + 7_000).toUTCString(), now)
    ).toBe(7_000)
    expect(parseRetryAfter('not-a-date', now)).toBeUndefined()
  })

  it('normalizes aborts and transport failures without losing partial-output state', () => {
    const controller = new AbortController()
    controller.abort()
    const cancelled = toProviderError(controller.signal.reason, {
      signal: controller.signal
    })
    const network = toProviderError(
      Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
      { partialOutput: true }
    )

    expect(cancelled).toMatchObject({
      category: 'cancelled',
      retryable: false,
      partialOutput: false
    })
    expect(network).toMatchObject({
      category: 'network',
      retryable: true,
      partialOutput: true
    })
    expect(network).toBeInstanceOf(ProviderError)
  })
})

function modelAdapter(id: string): ModelAdapter<Record<string, never>> {
  return {
    id,
    validateConfig: () => ({}),
    inspect: async () => ({
      capabilities: DEFAULT_MODEL_CAPABILITIES
    }),
    async *stream() {}
  }
}

function runtimeAdapter(id: string): AgentRuntimeAdapter<Record<string, never>> {
  return {
    id,
    validateConfig: () => ({}),
    inspect: async () => ({
      capabilities: DEFAULT_AGENT_RUNTIME_CAPABILITIES
    }),
    async *run() {}
  }
}

describe('adapter registry', () => {
  it('resolves both adapter kinds and reports registrations', () => {
    const model = modelAdapter('openai.responses')
    const runtime = runtimeAdapter('anthropic.claude-code')
    const registry = new AdapterRegistry()
      .registerModel(model)
      .registerAgentRuntime(runtime)

    expect(registry.has(model.id)).toBe(true)
    expect(registry.requireModel(model.id).id).toBe(model.id)
    expect(registry.requireAgentRuntime(runtime.id).id).toBe(runtime.id)
    expect(registry.list()).toEqual([
      { id: model.id, kind: 'model' },
      { id: runtime.id, kind: 'agent-runtime' }
    ])
  })

  it('rejects duplicate ids globally, including across adapter kinds', () => {
    const registry = new AdapterRegistry().registerModel(modelAdapter('provider'))
    expect(() =>
      registry.registerAgentRuntime(runtimeAdapter('provider'))
    ).toThrow(DuplicateAdapterError)
  })

  it('distinguishes unknown adapters from kind mismatches', () => {
    const registry = new AdapterRegistry().registerModel(modelAdapter('provider'))
    expect(() => registry.requireModel('missing')).toThrow(UnknownAdapterError)
    expect(() => registry.requireAgentRuntime('provider')).toThrow(
      AdapterKindMismatchError
    )
  })

  it.each(['Uppercase', 'has spaces', '', '.prefix'])(
    'rejects malformed adapter id %j',
    (id) => {
      expect(() =>
        new AdapterRegistry().registerModel(modelAdapter(id))
      ).toThrow(TypeError)
    }
  )
})
