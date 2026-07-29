import { describe, expect, it } from 'vitest'
import { parsePersistedState } from './state-schema'

function stateWithTask(overrides: Record<string, unknown> = {}): unknown {
  const timestamp = '2026-07-28T12:00:00.000Z'
  return {
    version: 1,
    providers: [
      {
        id: 'provider',
        name: 'Local provider',
        kind: 'openai-compatible',
        model: 'local-model',
        baseUrl: 'http://127.0.0.1:11434/v1',
        hasApiKey: false,
        supportsTools: true,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    mcpServers: [],
    tasks: [
      {
        id: 'task',
        title: 'Archived task',
        providerId: 'provider',
        mode: 'agent',
        runStatus: 'idle',
        archivedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        items: [],
        ...overrides
      }
    ],
    settings: {
      selectedTaskId: 'task',
      defaultProviderId: 'provider',
      sidebarCollapsed: false
    }
  }
}

function stateWithCliProvider(
  overrides: Record<string, unknown> = {}
): unknown {
  const state = stateWithTask() as {
    providers: Record<string, unknown>[]
    tasks: Array<{ providerId: string }>
    settings: { defaultProviderId: string }
  }
  state.providers = [
    {
      id: 'cli-provider',
      name: 'Enterprise CLI',
      kind: 'cli',
      model: '',
      command: '/usr/local/bin/enterprise-agent',
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      trustConfirmed: true,
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z',
      ...overrides
    }
  ]
  state.tasks[0]!.providerId = 'cli-provider'
  state.settings.defaultProviderId = 'cli-provider'
  return state
}

describe('persisted task lifecycle validation', () => {
  it('accepts an inert archived task', () => {
    expect(parsePersistedState(stateWithTask()).tasks[0]?.archivedAt).toBe(
      '2026-07-28T12:00:00.000Z'
    )
  })

  it('requires consistent, safe CLI environment metadata', () => {
    const valid = parsePersistedState(
      stateWithCliProvider({
        environmentVariables: ['ACME_AGENT_TOKEN'],
        environmentFingerprint: 'a'.repeat(64)
      })
    )
    expect(valid.providers[0]).toMatchObject({
      environmentVariables: ['ACME_AGENT_TOKEN'],
      environmentFingerprint: 'a'.repeat(64)
    })

    expect(() =>
      parsePersistedState(
        stateWithCliProvider({
          environmentVariables: ['ACME_AGENT_TOKEN']
        })
      )
    ).toThrow(/fingerprint/i)
    expect(() =>
      parsePersistedState(
        stateWithCliProvider({
          environmentFingerprint: 'a'.repeat(64)
        })
      )
    ).toThrow(/fingerprint/i)
    expect(() =>
      parsePersistedState(
        stateWithCliProvider({
          environmentVariables: ['HOME'],
          environmentFingerprint: 'a'.repeat(64)
        })
      )
    ).toThrow()
    expect(() =>
      parsePersistedState(
        stateWithCliProvider({
          environmentVariables: ['ACME_TOKEN', 'acme_token'],
          environmentFingerprint: 'a'.repeat(64)
        })
      )
    ).toThrow(/duplicated/i)
  })

  it('returns a normalized graph without unknown authority fields', () => {
    const parsed = parsePersistedState(
      stateWithTask({
        unexpectedAuthority: {
          approvalId: 'forged-approval',
          valueThatJsonCannotSerialize: 1n
        }
      })
    )

    expect(parsed.tasks[0]).not.toHaveProperty('unexpectedAuthority')
    expect(() => JSON.stringify(parsed)).not.toThrow()
  })

  it('rejects malformed archive timestamps and archived active runs', () => {
    expect(() =>
      parsePersistedState(stateWithTask({ archivedAt: 'yesterday' }))
    ).toThrow()
    expect(() =>
      parsePersistedState(stateWithTask({ runStatus: 'running' }))
    ).toThrow('Archived tasks cannot contain an active run')
    expect(() =>
      parsePersistedState(
        stateWithTask({ runStatus: 'awaiting-approval' })
      )
    ).toThrow('Archived tasks cannot contain an active run')
  })

  it('migrates a missing or invalid default provider to the selected task provider', () => {
    const missing = stateWithTask() as {
      settings: { defaultProviderId?: string }
    }
    delete missing.settings.defaultProviderId
    expect(parsePersistedState(missing).settings.defaultProviderId).toBe(
      'provider'
    )

    const invalid = stateWithTask() as {
      settings: { defaultProviderId?: string }
    }
    invalid.settings.defaultProviderId = 'missing-provider'
    expect(parsePersistedState(invalid).settings.defaultProviderId).toBe(
      'provider'
    )
  })
})
