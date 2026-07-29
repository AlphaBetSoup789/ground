import { describe, expect, it } from 'vitest'
import type {
  CliProvider,
  OpenAIProvider,
  ProviderProfile,
  Task
} from '../shared/types'
import {
  GROUND_TASK_BUNDLE_JSON_SCHEMA,
  GROUND_TASK_BUNDLE_KIND,
  GROUND_TASK_BUNDLE_LIMITS,
  GROUND_TASK_BUNDLE_SCHEMA_DIALECT,
  GROUND_TASK_BUNDLE_SCHEMA_ID,
  GROUND_TASK_BUNDLE_VERSION,
  GroundTaskBundleError,
  createGroundTaskBundle,
  exportGroundTaskMarkdown,
  groundTaskBundleToMarkdown,
  groundTaskBundleV1Schema,
  importGroundTaskBundle,
  serializeGroundTaskBundle,
  type GroundTaskBundleV1
} from './task-portability'

const timestamp = '2026-07-28T18:30:00.000Z'
const workspacePath = '/Users/alice/Projects/private-ground-project'

function providerFixture(): OpenAIProvider {
  return {
    id: 'provider-source-secret-id',
    name: 'Hosted model',
    kind: 'openai',
    model: 'model-portable',
    baseUrl: 'https://private-endpoint.example.test/v1',
    hasApiKey: true,
    supportsTools: true,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function taskFixture(): Task {
  return {
    id: 'task-source-secret-id',
    title: 'Portable architecture review',
    workspacePath,
    providerId: 'provider-source-secret-id',
    mode: 'agent',
    runStatus: 'running',
    createdAt: '2026-07-27T10:00:00.000Z',
    updatedAt: timestamp,
    runtimeSessions: {
      'provider-source-secret-id': {
        adapterId: 'openai.codex-cli',
        sessionCompatibilityId: 'codex',
        sessionId: 'native-cli-session-secret',
        providerRevision: 'native-provider-revision-secret',
        workspacePath,
        mode: 'agent',
        updatedAt: timestamp
      }
    },
    modelSessions: {
      'provider-source-secret-id': {
        adapterId: 'openai.responses',
        providerRevision: 'model-provider-revision-secret',
        model: 'model-portable',
        workspacePath,
        mode: 'agent',
        conversation: [
          {
            kind: 'message',
            id: 'conversation-message-source-id',
            role: 'user',
            parts: [
              {
                kind: 'text',
                text: `Inspect ${workspacePath}/src/index.ts`,
                providerState: {
                  adapterId: 'openai.responses',
                  schemaVersion: 1,
                  data: { opaque: 'message-provider-state-secret' }
                }
              }
            ],
            providerState: {
              adapterId: 'openai.responses',
              schemaVersion: 1,
              data: { opaque: 'item-provider-state-secret' }
            }
          },
          {
            kind: 'message',
            id: 'conversation-assistant-source-id',
            role: 'assistant',
            parts: [
              {
                kind: 'reasoning-summary',
                text: 'I will inspect the entry point.',
                providerState: {
                  adapterId: 'openai.responses',
                  schemaVersion: 1,
                  data: { opaque: 'reasoning-provider-state-secret' }
                }
              },
              {
                kind: 'tool-call',
                callId: 'provider-native-call-secret',
                name: 'read_file',
                rawArguments: JSON.stringify({
                  path: `${workspacePath}/src/index.ts`,
                  apiKey: 'sk-tool-input-secret',
                  nested: {
                    providerState: {
                      opaque: 'nested-provider-state-secret'
                    },
                    retain: true
                  }
                }),
                arguments: {
                  path: `${workspacePath}/src/index.ts`,
                  apiKey: 'sk-tool-input-secret',
                  nested: {
                    providerState: {
                      opaque: 'nested-provider-state-secret'
                    },
                    retain: true
                  }
                },
                providerState: {
                  adapterId: 'openai.responses',
                  schemaVersion: 1,
                  data: { opaque: 'call-provider-state-secret' }
                }
              }
            ]
          },
          {
            kind: 'tool-result',
            id: 'conversation-result-source-id',
            callId: 'provider-native-call-secret',
            name: 'read_file',
            content: [
              {
                kind: 'text',
                text: `Read ${workspacePath}/src/index.ts`
              },
              {
                kind: 'json',
                value: {
                  path: `${workspacePath}/src/index.ts`,
                  providerState: {
                    opaque: 'result-provider-state-secret'
                  },
                  safe: true
                }
              }
            ],
            providerState: {
              adapterId: 'openai.responses',
              schemaVersion: 1,
              data: { opaque: 'result-item-provider-state-secret' }
            }
          }
        ],
        checkpoint: {
          responseId: 'opaque-checkpoint-secret'
        },
        updatedAt: timestamp
      }
    },
    items: [
      {
        id: 'timeline-user-source-id',
        kind: 'message',
        runId: 'timeline-run-source-id',
        role: 'user',
        content: `Review ${workspacePath}/src/index.ts`,
        createdAt: '2026-07-28T18:00:00.000Z'
      },
      {
        id: 'timeline-activity-source-id',
        kind: 'activity',
        runId: 'timeline-run-source-id',
        activityType: 'approval',
        title: 'Read the workspace entry point',
        detail: `Target: ${workspacePath}/src/index.ts`,
        status: 'pending',
        createdAt: '2026-07-28T18:01:00.000Z',
        approvalId: 'timeline-approval-source-id',
        toolName: 'read_file',
        input: {
          path: `${workspacePath}/src/index.ts`,
          api_key: 'sk-timeline-input-secret',
          nested: {
            provider_state: {
              opaque: 'timeline-provider-state-secret'
            },
            keep: 'portable'
          },
          pathMap: {
            [`${workspacePath}/src/index.ts`]: true
          }
        },
        result: `Read ${workspacePath}/src/index.ts`,
        durationMs: 42
      },
      {
        id: 'timeline-assistant-source-id',
        kind: 'message',
        runId: 'timeline-run-source-id',
        role: 'assistant',
        content: 'The entry point is intentionally small.',
        createdAt: '2026-07-28T18:02:00.000Z',
        provider: {
          id: 'history-provider-source-secret-id',
          name: 'Earlier model',
          kind: 'anthropic',
          model: 'claude-history'
        }
      },
      {
        id: 'managed-operation-source-id',
        kind: 'activity',
        runId: 'managed-operation-run-source-id',
        activityType: 'tool',
        title: 'Earlier uncertain write',
        status: 'error',
        toolName: 'write_file',
        result: 'Outcome unknown; Ground did not retry it.',
        createdAt: '2026-07-28T18:03:00.000Z',
        managedExecution: {
          version: 1,
          operationId: 'managed-operation-source-id',
          claim: 'approved',
          kind: 'workspace-write',
          actionSha256:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          approvalSha256:
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          phase: 'uncertain',
          startedAt: '2026-07-28T18:02:30.000Z',
          interruptedAt: '2026-07-28T18:03:00.000Z'
        }
      }
    ]
  }
}

function exportedBundle(): GroundTaskBundleV1 {
  const provider = Object.assign(providerFixture(), {
    apiKey: 'sk-provider-profile-secret',
    providerState: {
      opaque: 'profile-provider-state-secret'
    }
  }) as ProviderProfile
  return createGroundTaskBundle(taskFixture(), provider, {
    now: () => timestamp
  })
}

function cloneBundle(): GroundTaskBundleV1 {
  return JSON.parse(JSON.stringify(exportedBundle())) as GroundTaskBundleV1
}

function expectBundleError(
  operation: () => unknown,
  code: GroundTaskBundleError['code']
): void {
  try {
    operation()
    throw new Error('Expected operation to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(GroundTaskBundleError)
    expect(error).toMatchObject({ code })
  }
}

describe('Ground task portability', () => {
  it('exports a strict, versioned provider-neutral bundle', () => {
    const bundle = exportedBundle()
    expect(bundle).toMatchObject({
      $schema: GROUND_TASK_BUNDLE_SCHEMA_DIALECT,
      kind: GROUND_TASK_BUNDLE_KIND,
      version: GROUND_TASK_BUNDLE_VERSION,
      exportedAt: timestamp,
      provider: {
        type: 'model-api',
        kind: 'openai',
        name: 'Hosted model',
        model: 'model-portable',
        supportsTools: true
      },
      task: {
        title: 'Portable architecture review',
        mode: 'agent'
      }
    })
    expect(groundTaskBundleV1Schema.safeParse(bundle).success).toBe(true)
    expect(GROUND_TASK_BUNDLE_JSON_SCHEMA).toMatchObject({
      $schema: GROUND_TASK_BUNDLE_SCHEMA_DIALECT,
      $id: GROUND_TASK_BUNDLE_SCHEMA_ID,
      title: 'Ground task bundle version 1'
    })
  })

  it('omits credentials, paths, runtime continuity, opaque state, and source IDs', () => {
    const bundle = exportedBundle()
    const serialized = JSON.stringify(bundle)
    for (const forbidden of [
      workspacePath,
      'sk-provider-profile-secret',
      'sk-tool-input-secret',
      'sk-timeline-input-secret',
      'native-cli-session-secret',
      'native-provider-revision-secret',
      'model-provider-revision-secret',
      'opaque-checkpoint-secret',
      'message-provider-state-secret',
      'item-provider-state-secret',
      'nested-provider-state-secret',
      'result-provider-state-secret',
      'profile-provider-state-secret',
      'task-source-secret-id',
      'provider-source-secret-id',
      'timeline-user-source-id',
      'timeline-run-source-id',
      'timeline-approval-source-id',
      'history-provider-source-secret-id',
      'conversation-message-source-id',
      'provider-native-call-secret',
      'managed-operation-source-id',
      'managed-operation-run-source-id',
      'private-endpoint.example.test'
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    for (const forbiddenKey of [
      'apiKey',
      'api_key',
      'hasApiKey',
      'baseUrl',
      'workspacePath',
      'runtimeSessions',
      'modelSessions',
      'checkpoint',
      'providerState',
      'provider_state',
      'runStatus',
      'approvalId',
      'managedExecution',
      'operationId',
      'actionSha256',
      'approvalSha256',
      'runId'
    ]) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`)
    }
    expect(serialized).toContain('<workspace>/src/index.ts')
    expect(serialized).toContain('"retain":true')
    expect(serialized).toContain('"keep":"portable"')

    const call = bundle.task.conversation[1]
    const result = bundle.task.conversation[2]
    expect(call?.kind).toBe('message')
    expect(result?.kind).toBe('tool-result')
    if (call?.kind !== 'message' || result?.kind !== 'tool-result') return
    const toolCall = call.parts.find((part) => part.kind === 'tool-call')
    expect(toolCall).toMatchObject({ callId: 'call-1', name: 'read_file' })
    expect(result.callId).toBe('call-1')
    expect(bundle.task.timeline[1]).toMatchObject({
      kind: 'activity',
      status: 'interrupted'
    })
    expect(bundle.task.timeline[2]).toMatchObject({
      kind: 'message',
      provider: {
        name: 'Earlier model',
        kind: 'anthropic',
        model: 'claude-history'
      }
    })
    expect(bundle.task.timeline[2]?.provider).not.toHaveProperty('id')
  })

  it('exports only portable CLI hints and omits command/session trust details', () => {
    const task = taskFixture()
    task.providerId = 'cli-provider-id'
    const provider = Object.assign(
      {
        id: 'cli-provider-id',
        name: 'Codex local',
        kind: 'cli',
        model: '',
        command: '/Users/alice/.local/bin/codex',
        args: ['exec', '--json', '--secret', 'native-argument-secret'],
        promptMode: 'stdin',
        outputMode: 'ndjson',
        cliAdapter: 'codex',
        trustConfirmed: true,
        createdAt: timestamp,
        updatedAt: timestamp
      } satisfies CliProvider,
      { apiKey: 'cli-api-key-secret' }
    )

    const bundle = createGroundTaskBundle(task, provider, {
      now: () => timestamp
    })
    expect(bundle.provider).toEqual({
      type: 'agent-cli',
      kind: 'cli',
      name: 'Codex local',
      model: '',
      adapter: 'codex'
    })
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain('/Users/alice/.local/bin/codex')
    expect(serialized).not.toContain('native-argument-secret')
    expect(serialized).not.toContain('cli-api-key-secret')
    expect(serialized).not.toContain('trustConfirmed')
  })

  it('imports a content template without trusted identities, paths, state, or timestamps', () => {
    const bundle = cloneBundle()
    const assistant = bundle.task.conversation[1]
    const result = bundle.task.conversation[2]
    if (assistant?.kind !== 'message' || result?.kind !== 'tool-result') {
      throw new Error('Fixture conversation is malformed')
    }
    const call = assistant.parts.find((part) => part.kind === 'tool-call')
    if (!call || call.kind !== 'tool-call') throw new Error('Fixture tool call is missing')
    call.callId = 'untrusted-import-call-id'
    result.callId = 'untrusted-import-call-id'

    const template = importGroundTaskBundle(JSON.stringify(bundle))
    expect(template).toMatchObject({
      title: 'Portable architecture review',
      mode: 'agent',
      source: {
        formatVersion: 1,
        exportedAt: timestamp
      }
    })
    const serialized = JSON.stringify(template)
    for (const key of [
      'providerId',
      'workspacePath',
      'runStatus',
      'sourceCreatedAt',
      'sourceUpdatedAt',
      'recordedAt',
      'createdAt',
      'updatedAt'
    ]) {
      expect(serialized).not.toContain(`"${key}"`)
    }
    expect(template).not.toHaveProperty('id')
    expect(template.provider).not.toHaveProperty('id')
    expect(template.timeline[0]).not.toHaveProperty('id')
    expect(template.timeline[2]).toMatchObject({
      provider: {
        name: 'Earlier model',
        kind: 'anthropic',
        model: 'claude-history'
      }
    })
    expect(template.timeline[2]?.provider).not.toHaveProperty('id')
    expect(serialized).not.toContain('untrusted-import-call-id')

    const importedAssistant = template.conversation[1]
    const importedResult = template.conversation[2]
    if (
      importedAssistant?.kind !== 'message' ||
      importedResult?.kind !== 'tool-result'
    ) {
      throw new Error('Imported conversation is malformed')
    }
    expect(
      importedAssistant.parts.find((part) => part.kind === 'tool-call')
    ).toMatchObject({ callId: 'call-1' })
    expect(importedResult.callId).toBe('call-1')
  })

  it('creates a human-readable Markdown transcript from safe projected data', () => {
    const markdown = exportGroundTaskMarkdown(taskFixture(), providerFixture(), {
      now: () => timestamp
    })
    expect(markdown).toContain('# Portable architecture review')
    expect(markdown).toContain('## User')
    expect(markdown).toContain('## Ground')
    expect(markdown).toContain('## Activity · Approval')
    expect(markdown).toContain('Provider hint: Hosted model · model-portable')
    expect(markdown).toContain('<workspace>/src/index.ts')
    expect(markdown).not.toContain(workspacePath)
    expect(markdown).not.toContain('sk-timeline-input-secret')

    expect(groundTaskBundleToMarkdown(JSON.stringify(exportedBundle()))).toBe(markdown)
  })

  it('strictly rejects malformed discriminators, versions, fields, and timestamps', () => {
    const cases: Array<{
      mutate: (bundle: Record<string, unknown>) => void
      code: GroundTaskBundleError['code']
    }> = [
      {
        mutate: (bundle) => {
          bundle.kind = 'another.bundle'
        },
        code: 'INVALID_BUNDLE'
      },
      {
        mutate: (bundle) => {
          bundle.version = 99
        },
        code: 'UNSUPPORTED_VERSION'
      },
      {
        mutate: (bundle) => {
          bundle.extra = true
        },
        code: 'INVALID_BUNDLE'
      },
      {
        mutate: (bundle) => {
          bundle.exportedAt = 'not-a-timestamp'
        },
        code: 'INVALID_BUNDLE'
      },
      {
        mutate: (bundle) => {
          const task = bundle.task as Record<string, unknown>
          task.sourceCreatedAt = '2026-02-31T00:00:00Z'
        },
        code: 'INVALID_BUNDLE'
      },
      {
        mutate: (bundle) => {
          const provider = bundle.provider as Record<string, unknown>
          provider.apiKey = 'must-not-be-accepted'
        },
        code: 'INVALID_BUNDLE'
      },
      {
        mutate: (bundle) => {
          const task = bundle.task as { timeline: Array<Record<string, unknown>> }
          const first = task.timeline[0]
          if (first) first.id = 'must-not-be-accepted'
        },
        code: 'INVALID_BUNDLE'
      },
      {
        mutate: (bundle) => {
          const task = bundle.task as { timeline: Array<Record<string, unknown>> }
          const first = task.timeline[0]
          if (first) first.recordedAt = 'yesterday'
        },
        code: 'INVALID_BUNDLE'
      }
    ]

    for (const testCase of cases) {
      const bundle = cloneBundle() as unknown as Record<string, unknown>
      testCase.mutate(bundle)
      expectBundleError(() => importGroundTaskBundle(bundle), testCase.code)
    }
    expectBundleError(() => importGroundTaskBundle('{broken'), 'INVALID_BUNDLE')
  })

  it('rejects prototype-pollution payloads without mutating global prototypes', () => {
    const serialized = serializeGroundTaskBundle(taskFixture(), providerFixture(), {
      now: () => timestamp
    })
    const malicious = serialized.replace(
      '"task": {',
      '"task": {"__proto__": {"polluted": true},'
    )
    expectBundleError(() => importGroundTaskBundle(malicious), 'INVALID_BUNDLE')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    const bundle = cloneBundle() as unknown as Record<string, unknown>
    Object.defineProperty(bundle, 'constructor', {
      value: { prototype: { polluted: true } },
      enumerable: true
    })
    expectBundleError(() => importGroundTaskBundle(bundle), 'INVALID_BUNDLE')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects cycles, accessors, class instances, and non-JSON values', () => {
    const cyclicTask = taskFixture() as Task & { cycle?: unknown }
    cyclicTask.cycle = cyclicTask
    expectBundleError(
      () =>
        createGroundTaskBundle(cyclicTask, providerFixture(), {
          now: () => timestamp
        }),
      'INVALID_SOURCE'
    )

    const accessorTask = taskFixture()
    Object.defineProperty(accessorTask, 'runtimeSessions', {
      enumerable: true,
      get: () => ({})
    })
    expectBundleError(
      () =>
        createGroundTaskBundle(accessorTask, providerFixture(), {
          now: () => timestamp
        }),
      'INVALID_SOURCE'
    )

    const nonJsonTask = taskFixture()
    const activity = nonJsonTask.items[1]
    if (activity?.kind !== 'activity') throw new Error('Fixture activity is missing')
    activity.input = { invalid: new Date() }
    expectBundleError(
      () =>
        createGroundTaskBundle(nonJsonTask, providerFixture(), {
          now: () => timestamp
        }),
      'INVALID_SOURCE'
    )

    const cyclicBundle = cloneBundle() as GroundTaskBundleV1 & { cycle?: unknown }
    cyclicBundle.cycle = cyclicBundle
    expectBundleError(() => importGroundTaskBundle(cyclicBundle), 'INVALID_BUNDLE')
  })

  it('safely omits explicitly undefined optional source properties', () => {
    const task = taskFixture()
    const session = task.modelSessions?.['provider-source-secret-id']
    if (!session) throw new Error('Fixture model session is missing')
    session.checkpoint = undefined
    session.workspacePath = undefined
    const activity = task.items[1]
    if (activity?.kind !== 'activity') throw new Error('Fixture activity is missing')
    activity.approvalId = undefined

    const bundle = createGroundTaskBundle(task, providerFixture(), {
      now: () => timestamp
    })
    expect(groundTaskBundleV1Schema.safeParse(bundle).success).toBe(true)
    expect(JSON.stringify(bundle)).not.toContain('undefined')
  })

  it('rejects invalid source timestamps and mismatched provider identities', () => {
    const invalidTimestamp = taskFixture()
    invalidTimestamp.createdAt = '2026-02-31T00:00:00Z'
    expectBundleError(
      () =>
        createGroundTaskBundle(invalidTimestamp, providerFixture(), {
          now: () => timestamp
        }),
      'INVALID_SOURCE'
    )

    const invalidItemTimestamp = taskFixture()
    const first = invalidItemTimestamp.items[0]
    if (first) first.createdAt = 'not-a-date'
    expectBundleError(
      () =>
        createGroundTaskBundle(invalidItemTimestamp, providerFixture(), {
          now: () => timestamp
        }),
      'INVALID_SOURCE'
    )

    const wrongProvider = providerFixture()
    wrongProvider.id = 'another-provider'
    expectBundleError(
      () =>
        createGroundTaskBundle(taskFixture(), wrongProvider, {
          now: () => timestamp
        }),
      'INVALID_SOURCE'
    )
  })

  it('enforces serialized, string, timeline, and nested-array limits', () => {
    expectBundleError(
      () =>
        importGroundTaskBundle(
          ' '.repeat(GROUND_TASK_BUNDLE_LIMITS.serializedBytes + 1)
        ),
      'TOO_LARGE'
    )

    const oversizedString = taskFixture()
    const first = oversizedString.items[0]
    if (first?.kind !== 'message') throw new Error('Fixture message is missing')
    first.content = 'x'.repeat(
      GROUND_TASK_BUNDLE_LIMITS.maximumSingleStringCharacters + 1
    )
    expectBundleError(
      () =>
        createGroundTaskBundle(oversizedString, providerFixture(), {
          now: () => timestamp
        }),
      'TOO_LARGE'
    )

    const oversizedTimeline = cloneBundle() as unknown as {
      task: { timeline: Array<Record<string, unknown>> }
    }
    oversizedTimeline.task.timeline = Array.from(
      { length: GROUND_TASK_BUNDLE_LIMITS.maximumTimelineItems + 1 },
      (_, index) => ({
        kind: 'message',
        role: 'user',
        content: `message ${index}`,
        recordedAt: timestamp
      })
    )
    expectBundleError(
      () => importGroundTaskBundle(oversizedTimeline),
      'INVALID_BUNDLE'
    )

    const oversizedNestedArray = cloneBundle() as unknown as {
      task: {
        timeline: Array<{
          kind: string
          input?: Record<string, unknown>
        }>
      }
    }
    const activity = oversizedNestedArray.task.timeline.find(
      (entry) => entry.kind === 'activity'
    )
    if (!activity) throw new Error('Fixture activity is missing')
    activity.input = {
      values: Array.from(
        { length: GROUND_TASK_BUNDLE_LIMITS.maximumSingleArrayItems + 1 },
        (_, index) => index
      )
    }
    expectBundleError(
      () => importGroundTaskBundle(oversizedNestedArray),
      'TOO_LARGE'
    )
  })
})
