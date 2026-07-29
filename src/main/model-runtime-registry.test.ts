import { describe, expect, it } from 'vitest'
import type { ModelApiProvider } from '../shared/types'
import {
  AdapterRegistry,
  DEFAULT_MODEL_CAPABILITIES,
  type ModelAdapter
} from './agent'
import {
  createBuiltinModelAdapterRegistry,
  createRegisteredModelRuntimeFactory
} from './run-manager'

const provider: ModelApiProvider = {
  id: 'custom-provider',
  name: 'Custom provider',
  kind: 'openai-compatible',
  baseUrl: 'https://models.example.test/v1',
  model: 'custom-model',
  hasApiKey: false,
  supportsTools: true,
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z'
}

interface CustomConfig {
  endpoint: string
}

function customAdapter(): ModelAdapter<CustomConfig> {
  return {
    id: 'community.custom-protocol',
    validateConfig(value: unknown): CustomConfig {
      if (!value || typeof value !== 'object') {
        throw new TypeError('Custom adapter requires an endpoint')
      }
      const endpoint = (value as Record<string, unknown>).endpoint
      if (typeof endpoint !== 'string') {
        throw new TypeError('Custom adapter requires an endpoint')
      }
      return { endpoint }
    },
    async inspect() {
      return { capabilities: DEFAULT_MODEL_CAPABILITIES }
    },
    async *stream() {}
  }
}

describe('registered model runtime factory', () => {
  it('constructs the production built-in registry deterministically', () => {
    expect(createBuiltinModelAdapterRegistry().list()).toEqual([
      { id: 'openai.responses', kind: 'model' },
      { id: 'anthropic.messages', kind: 'model' },
      { id: 'google.generative-ai', kind: 'model' },
      { id: 'openai.compatible', kind: 'model' }
    ])
  })

  it('binds a statically registered third-party adapter without changing the run loop', () => {
    const registry = new AdapterRegistry().registerModel(customAdapter())
    const factory = createRegisteredModelRuntimeFactory(
      registry,
      (profile) => ({
        adapterId: 'community.custom-protocol',
        config: { endpoint: profile.baseUrl }
      })
    )

    const runtime = factory(provider)

    expect(runtime.adapter.id).toBe('community.custom-protocol')
    expect(runtime.config).toEqual({
      endpoint: 'https://models.example.test/v1'
    })
  })

  it('validates resolved configuration before the runtime can stream', () => {
    const registry = new AdapterRegistry().registerModel(customAdapter())
    const factory = createRegisteredModelRuntimeFactory(registry, () => ({
      adapterId: 'community.custom-protocol',
      config: { endpoint: 42 }
    }))

    expect(() => factory(provider)).toThrow(
      'Custom adapter requires an endpoint'
    )
  })
})
