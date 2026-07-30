import { describe, expect, it } from 'vitest'
import type { ProviderFailureKind } from '../shared/types'
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

function failedProviderActivity(
  failureKind: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'provider-failure',
    kind: 'activity',
    runId: 'run-1',
    activityType: 'error',
    title: 'Run failed',
    detail: 'Credential-safe failure detail.',
    failureKind,
    status: 'error',
    createdAt: '2026-07-28T12:00:00.000Z',
    ...overrides
  }
}

describe('persisted task lifecycle validation', () => {
  it('migrates version 1 documents through the current schema', () => {
    expect(parsePersistedState(stateWithTask()).version).toBe(2)
    expect(() =>
      parsePersistedState({
        ...(stateWithTask() as Record<string, unknown>),
        version: 3
      })
    ).toThrow(/newer/i)
  })

  it('accepts an inert archived task', () => {
    expect(parsePersistedState(stateWithTask()).tasks[0]?.archivedAt).toBe(
      '2026-07-28T12:00:00.000Z'
    )
  })

  it('accepts bounded provider verification while keeping legacy profiles unverified', () => {
    const legacy = parsePersistedState(stateWithTask())
    expect(legacy.providers[0]?.verification).toBeUndefined()

    const state = stateWithTask() as {
      providers: Array<Record<string, unknown>>
    }
    state.providers[0]!.verification = {
      status: 'passed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:30:00.000Z'
    }
    expect(parsePersistedState(state).providers[0]?.verification).toEqual({
      status: 'passed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:30:00.000Z'
    })

    state.providers[0]!.verification = {
      status: 'passed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:30:00.000Z',
      detail: 'Unbounded provider response text must not be persisted'
    }
    expect(() => parsePersistedState(state)).toThrow()
  })

  it.each<ProviderFailureKind>([
    'connection-refused',
    'dns',
    'tls',
    'authentication',
    'rate-limit',
    'timeout',
    'protocol-shape',
    'executable-not-found',
    'external-runtime-startup'
  ])('persists only the bounded %s provider failure kind', (failureKind) => {
    const state = stateWithTask() as {
      providers: Array<Record<string, unknown>>
    }
    state.providers[0]!.verification = {
      status: 'failed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:30:00.000Z',
      failureKind
    }

    expect(
      parsePersistedState(state).providers[0]?.verification
    ).toEqual({
      status: 'failed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:30:00.000Z',
      failureKind
    })
  })

  it('rejects failure kinds on passed checks and all raw failure diagnostics', () => {
    const state = stateWithTask() as {
      providers: Array<Record<string, unknown>>
    }
    state.providers[0]!.verification = {
      status: 'passed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:30:00.000Z',
      failureKind: 'authentication'
    }
    expect(() => parsePersistedState(state)).toThrow()

    state.providers[0]!.verification = {
      status: 'failed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:30:00.000Z',
      failureKind: 'authentication',
      detail: 'Rejected secret: credential-never-persist'
    }
    expect(() => parsePersistedState(state)).toThrow()

    state.providers[0]!.verification = {
      status: 'failed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:30:00.000Z',
      failureKind: 'credential-never-persist'
    }
    expect(() => parsePersistedState(state)).toThrow()
  })

  it.each<ProviderFailureKind>([
    'connection-refused',
    'dns',
    'tls',
    'authentication',
    'rate-limit',
    'timeout',
    'protocol-shape',
    'executable-not-found',
    'external-runtime-startup'
  ])('persists only the bounded %s run failure kind', (failureKind) => {
    const state = stateWithTask({
      items: [
        failedProviderActivity(failureKind, {
          providerCategory: 'must-not-persist',
          providerCode: 'must-not-persist',
          cause: { code: 'must-not-persist' }
        })
      ]
    })
    const item = parsePersistedState(state).tasks[0]?.items[0]

    expect(item).toMatchObject({
      kind: 'activity',
      activityType: 'error',
      status: 'error',
      failureKind
    })
    expect(item).not.toHaveProperty('providerCategory')
    expect(item).not.toHaveProperty('providerCode')
    expect(item).not.toHaveProperty('cause')
  })

  it('rejects unknown run failure kinds and classifications on non-error activity', () => {
    expect(() =>
      parsePersistedState(
        stateWithTask({
          items: [failedProviderActivity('future-provider-failure')]
        })
      )
    ).toThrow()

    expect(() =>
      parsePersistedState(
        stateWithTask({
          items: [
            failedProviderActivity('timeout', {
              activityType: 'status',
              status: 'success'
            })
          ]
        })
      )
    ).toThrow(/failed error activity/i)
  })

  it('retains a bounded opaque API credential revision while accepting legacy profiles', () => {
    const legacy = parsePersistedState(stateWithTask())
    expect(
      legacy.providers[0]?.kind === 'cli'
        ? undefined
        : legacy.providers[0]?.credentialRevision
    ).toBeUndefined()

    const state = stateWithTask() as {
      providers: Array<Record<string, unknown>>
    }
    state.providers[0]!.hasApiKey = true
    state.providers[0]!.credentialRevision = 'credential_revision-one'
    const provider = parsePersistedState(state).providers[0]
    if (!provider || provider.kind === 'cli') {
      throw new Error('Expected an API provider')
    }
    expect(provider.credentialRevision).toBe('credential_revision-one')

    state.providers[0]!.credentialRevision = 'x'.repeat(201)
    expect(() => parsePersistedState(state)).toThrow()

    state.providers[0]!.credentialRevision = 'credential_revision-one'
    state.providers[0]!.hasApiKey = false
    expect(() => parsePersistedState(state)).toThrow(/saved API key/i)
  })

  it('requires consistent, safe CLI environment metadata', () => {
    const valid = parsePersistedState(
      stateWithCliProvider({
        environmentVariables: ['ACME_AGENT_TOKEN'],
        environmentFingerprint: 'a'.repeat(64),
        environmentRevision: 'b'.repeat(64)
      })
    )
    expect(valid.providers[0]).toMatchObject({
      environmentVariables: ['ACME_AGENT_TOKEN'],
      environmentFingerprint: 'a'.repeat(64),
      environmentRevision: 'b'.repeat(64)
    })

    const legacy = parsePersistedState(
      stateWithCliProvider({
        environmentVariables: ['ACME_AGENT_TOKEN'],
        environmentFingerprint: 'a'.repeat(64)
      })
    )
    expect(legacy.providers[0]).not.toHaveProperty('environmentRevision')

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
    expect(() =>
      parsePersistedState(
        stateWithCliProvider({
          environmentRevision: 'b'.repeat(64)
        })
      )
    ).toThrow(/revision/i)
    expect(() =>
      parsePersistedState(
        stateWithCliProvider({
          environmentVariables: ['ACME_AGENT_TOKEN'],
          environmentFingerprint: 'a'.repeat(64),
          environmentRevision: 'too-short'
        })
      )
    ).toThrow()
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

  it('normalizes legacy CLI sessions into adapter and compatibility identities', () => {
    const legacy = parsePersistedState(
      stateWithTask({
        runtimeSessions: {
          'cli-provider': {
            adapter: 'codex',
            sessionId: 'session-1',
            providerRevision: '2026-07-28T12:00:00.000Z',
            workspacePath: '/workspace',
            mode: 'agent',
            updatedAt: '2026-07-28T12:00:00.000Z'
          }
        }
      })
    )
    expect(legacy.tasks[0]?.runtimeSessions?.['cli-provider']).toEqual({
      adapterId: 'openai.codex-cli',
      sessionCompatibilityId: 'codex',
      sessionId: 'session-1',
      providerRevision: '2026-07-28T12:00:00.000Z',
      workspacePath: '/workspace',
      mode: 'agent',
      updatedAt: '2026-07-28T12:00:00.000Z'
    })

    const canonical = parsePersistedState(
      stateWithTask({
        runtimeSessions: {
          'cli-provider': {
            adapterId: 'community.runtime',
            sessionCompatibilityId: 'format-v2',
            sessionId: 'session-2',
            providerRevision: '2026-07-28T12:00:00.000Z',
            workspacePath: '/workspace',
            mode: 'ask',
            updatedAt: '2026-07-28T12:00:00.000Z'
          }
        }
      })
    )
    expect(canonical.tasks[0]?.runtimeSessions?.['cli-provider']).toMatchObject({
      adapterId: 'community.runtime',
      sessionCompatibilityId: 'format-v2',
      sessionId: 'session-2',
      mode: 'ask'
    })
  })

  it('drops native sessions outside the canonical 200-character boundary', () => {
    const parsed = parsePersistedState(
      stateWithTask({
        runtimeSessions: {
          'cli-provider': {
            adapterId: 'community.runtime',
            sessionCompatibilityId: 'format-v2',
            sessionId: 's'.repeat(201),
            providerRevision: '2026-07-28T12:00:00.000Z',
            workspacePath: '/workspace',
            mode: 'agent',
            updatedAt: '2026-07-28T12:00:00.000Z'
          }
        }
      })
    )

    expect(parsed.tasks[0]?.runtimeSessions).toEqual({})
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
