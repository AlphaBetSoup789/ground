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

function managedActivity(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const timestamp = '2026-07-28T12:00:00.000Z'
  return {
    id: 'managed-operation',
    kind: 'activity',
    runId: 'run-1',
    callId: 'call-1',
    activityType: 'tool',
    title: 'Write src/app.ts',
    toolName: 'write_file',
    status: 'running',
    createdAt: timestamp,
    managedExecution: {
      version: 1,
      operationId: 'managed-operation',
      claim: 'approved',
      kind: 'workspace-write',
      actionSha256: 'a'.repeat(64),
      approvalSha256: 'b'.repeat(64),
      phase: 'started',
      startedAt: timestamp
    },
    ...overrides
  }
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

  it('accepts strict started, completed, and explicitly legacy uncertain execution markers', () => {
    const started = parsePersistedState(
      stateWithTask({
        archivedAt: undefined,
        runStatus: 'running',
        items: [managedActivity()]
      })
    )
    expect(
      started.tasks[0]?.items[0]
    ).toMatchObject({
      status: 'running',
      managedExecution: {
        version: 1,
        operationId: 'managed-operation',
        claim: 'approved',
        phase: 'started'
      }
    })

    const completed = parsePersistedState(
      stateWithTask({
        archivedAt: undefined,
        items: [
          managedActivity({
            status: 'success',
            managedExecution: {
              version: 1,
              operationId: 'managed-operation',
              claim: 'approved',
              kind: 'workspace-write',
              actionSha256: 'a'.repeat(64),
              approvalSha256: 'b'.repeat(64),
              phase: 'completed',
              startedAt: '2026-07-28T12:00:00.000Z',
              completedAt: '2026-07-28T12:00:01.000Z'
            }
          })
        ]
      })
    )
    expect(completed.tasks[0]?.items[0]).toMatchObject({
      status: 'success',
      managedExecution: { phase: 'completed' }
    })

    const legacy = parsePersistedState(
      stateWithTask({
        archivedAt: undefined,
        items: [
          managedActivity({
            callId: undefined,
            status: 'error',
            managedExecution: {
              version: 1,
              operationId: 'managed-operation',
              claim: 'legacy-untracked',
              kind: 'workspace-write',
              phase: 'uncertain',
              startedAt: '2026-07-28T12:00:00.000Z',
              interruptedAt: '2026-07-28T12:00:01.000Z'
            }
          })
        ]
      })
    )
    expect(legacy.tasks[0]?.items[0]).toMatchObject({
      managedExecution: {
        claim: 'legacy-untracked',
        phase: 'uncertain'
      }
    })
  })

  it('rejects malformed or internally inconsistent managed execution claims', () => {
    const invalidClaims = [
      managedActivity({
        managedExecution: {
          version: 2,
          operationId: 'managed-operation',
          claim: 'approved',
          kind: 'workspace-write',
          actionSha256: 'a'.repeat(64),
          approvalSha256: 'b'.repeat(64),
          phase: 'started',
          startedAt: '2026-07-28T12:00:00.000Z'
        }
      }),
      managedActivity({
        managedExecution: {
          version: 1,
          operationId: 'different-operation',
          claim: 'approved',
          kind: 'workspace-write',
          actionSha256: 'not-a-hash',
          approvalSha256: 'b'.repeat(64),
          phase: 'started',
          startedAt: '2026-07-28T12:00:00.000Z'
        }
      }),
      managedActivity({
        callId: undefined
      }),
      managedActivity({
        toolName: 'run_command'
      }),
      managedActivity({
        status: 'success'
      }),
      managedActivity({
        status: 'success',
        managedExecution: {
          version: 1,
          operationId: 'managed-operation',
          claim: 'approved',
          kind: 'workspace-write',
          actionSha256: 'a'.repeat(64),
          approvalSha256: 'b'.repeat(64),
          phase: 'completed',
          startedAt: '2026-07-28T12:00:02.000Z',
          completedAt: '2026-07-28T12:00:01.000Z'
        }
      }),
      managedActivity({
        status: 'error',
        managedExecution: {
          version: 1,
          operationId: 'managed-operation',
          claim: 'legacy-untracked',
          kind: 'workspace-write',
          actionSha256: 'a'.repeat(64),
          phase: 'uncertain',
          startedAt: '2026-07-28T12:00:00.000Z',
          interruptedAt: '2026-07-28T12:00:01.000Z'
        }
      })
    ]

    for (const activity of invalidClaims) {
      expect(() =>
        parsePersistedState(
          stateWithTask({
            archivedAt: undefined,
            runStatus:
              activity.status === 'running' ? 'running' : 'idle',
            items: [activity]
          })
        )
      ).toThrow()
    }
  })

  it('rejects duplicate or conflicting approved claims for one run call', () => {
    const duplicate = {
      ...managedActivity(),
      id: 'second-operation',
      managedExecution: {
        version: 1,
        operationId: 'second-operation',
        claim: 'approved',
        kind: 'workspace-write',
        actionSha256: 'c'.repeat(64),
        approvalSha256: 'd'.repeat(64),
        phase: 'started',
        startedAt: '2026-07-28T12:00:00.000Z'
      }
    }
    expect(() =>
      parsePersistedState(
        stateWithTask({
          archivedAt: undefined,
          runStatus: 'running',
          items: [managedActivity(), duplicate]
        })
      )
    ).toThrow(/conflicting action hashes/i)
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
