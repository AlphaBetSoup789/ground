import { describe, expect, it, vi } from 'vitest'
import type { CliProvider } from '../shared/types'
import {
  AdapterIdentityDriftError,
  AdapterRegistry,
  DEFAULT_AGENT_RUNTIME_CAPABILITIES,
  DuplicateAdapterError,
  type AgentRuntimeAdapter
} from './agent'
import {
  createBuiltinAdapterRegistry,
  createRegisteredAgentRuntimeFactory,
  type AgentRuntimeBinding
} from './run-manager'

const TIMESTAMP = '2026-07-29T12:00:00.000Z'

function cliProvider(): CliProvider {
  return {
    id: 'custom-runtime-profile',
    name: 'Custom runtime',
    kind: 'cli',
    model: '',
    command: process.execPath,
    args: [],
    promptMode: 'stdin',
    outputMode: 'plain',
    cliAdapter: 'generic',
    trustConfirmed: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  }
}

function inertRuntime(
  id: string,
  validateConfig: AgentRuntimeAdapter<unknown>['validateConfig'] = (value) =>
    value
): AgentRuntimeAdapter<unknown> {
  return {
    id,
    validateConfig,
    async inspect() {
      return { capabilities: DEFAULT_AGENT_RUNTIME_CAPABILITIES }
    },
    async *run() {}
  }
}

describe('production adapter registry composition', () => {
  it('registers four model and five CLI adapters deterministically', () => {
    const registry = createBuiltinAdapterRegistry(async () => {
      throw new Error('The registry test must not authorize a process')
    })

    expect(registry.list()).toEqual([
      { id: 'openai.responses', kind: 'model' },
      { id: 'anthropic.messages', kind: 'model' },
      { id: 'google.generative-ai', kind: 'model' },
      { id: 'openai.compatible', kind: 'model' },
      { id: 'ground.cli.generic', kind: 'agent-runtime' },
      { id: 'openai.codex-cli', kind: 'agent-runtime' },
      { id: 'anthropic.claude-code', kind: 'agent-runtime' },
      { id: 'google.gemini-cli', kind: 'agent-runtime' },
      { id: 'google.antigravity-cli', kind: 'agent-runtime' }
    ])
  })

  it('keeps one global adapter-id namespace across model and runtime kinds', () => {
    const registry = createBuiltinAdapterRegistry(async () => {
      throw new Error('The collision test must not authorize a process')
    })

    expect(() =>
      registry.registerAgentRuntime(inertRuntime('openai.responses'))
    ).toThrow(DuplicateAdapterError)
  })

  it('validates custom runtime configuration before a run can be constructed', () => {
    let runCalls = 0
    const validateConfig = vi.fn((value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        (value as Record<string, unknown>).schemaVersion !== 1
      ) {
        throw new TypeError('Custom runtime configuration is invalid')
      }
      return Object.freeze({ schemaVersion: 1 as const })
    })
    const adapter: AgentRuntimeAdapter<{ schemaVersion: 1 }> = {
      id: 'community.custom-runtime',
      validateConfig,
      async inspect() {
        return { capabilities: DEFAULT_AGENT_RUNTIME_CAPABILITIES }
      },
      async *run() {
        runCalls += 1
      }
    }
    const registry = new AdapterRegistry().registerAgentRuntime(adapter)
    const invalidFactory = createRegisteredAgentRuntimeFactory(
      registry,
      () => ({
        adapterId: adapter.id,
        config: { schemaVersion: 2 }
      })
    )

    expect(() => invalidFactory(cliProvider())).toThrow(
      'Custom runtime configuration is invalid'
    )
    expect(validateConfig).toHaveBeenCalledTimes(1)
    expect(runCalls).toBe(0)

    const validFactory = createRegisteredAgentRuntimeFactory(
      registry,
      () => ({
        adapterId: adapter.id,
        config: { schemaVersion: 1 },
        sessionCompatibilityId: 'community-session-v1'
      })
    )
    const runtime = validFactory(cliProvider())

    expect(runtime.adapter).toBe(adapter)
    expect(runtime.config).toEqual({ schemaVersion: 1 })
    expect(runtime.sessionCompatibilityId).toBe('community-session-v1')
    expect(runCalls).toBe(0)
  })

  it('rejects a non-string session compatibility identity at runtime', () => {
    const adapter = inertRuntime('community.invalid-session-identity')
    const factory = createRegisteredAgentRuntimeFactory(
      new AdapterRegistry().registerAgentRuntime(adapter),
      () =>
        ({
          adapterId: adapter.id,
          config: {},
          sessionCompatibilityId: 1
        }) as unknown as AgentRuntimeBinding
    )

    expect(() => factory(cliProvider())).toThrow(
      'Agent runtime session compatibility ids must contain 1-200 characters'
    )
  })

  it('rejects runtime identity drift during configuration validation', () => {
    const adapter = inertRuntime(
      'community.validation-drift',
      (value) => {
        Object.defineProperty(adapter, 'id', {
          configurable: true,
          value: 'community.changed-during-validation',
          writable: true
        })
        return value
      }
    )
    const factory = createRegisteredAgentRuntimeFactory(
      new AdapterRegistry().registerAgentRuntime(adapter),
      () => ({
        adapterId: 'community.validation-drift',
        config: { schemaVersion: 1 }
      })
    )

    expect(() => factory(cliProvider())).toThrow(
      AdapterIdentityDriftError
    )
  })

  it('captures binding identities before runtime validation mutates aliased config', () => {
    const adapter = inertRuntime('community.aliased-runtime', (value) => {
      const aliased = value as AgentRuntimeBinding
      aliased.adapterId = 'community.other-runtime'
      aliased.sessionCompatibilityId = 'mutated-session-v2'
      return value
    })
    const binding: AgentRuntimeBinding = {
      adapterId: adapter.id,
      config: undefined,
      sessionCompatibilityId: 'stable-session-v1'
    }
    binding.config = binding
    const registry = new AdapterRegistry()
      .registerAgentRuntime(adapter)
      .registerAgentRuntime(inertRuntime('community.other-runtime'))
    const runtime = createRegisteredAgentRuntimeFactory(
      registry,
      () => binding
    )(cliProvider())

    expect(binding).toMatchObject({
      adapterId: 'community.other-runtime',
      sessionCompatibilityId: 'mutated-session-v2'
    })
    expect(runtime.adapter).toBe(adapter)
    expect(runtime.adapterId).toBe('community.aliased-runtime')
    expect(runtime.sessionCompatibilityId).toBe('stable-session-v1')
  })
})
