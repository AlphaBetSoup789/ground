import { describe, expect, it } from 'vitest'
import type { PersistedStateData } from '../state-schema'
import {
  decodeLedgerEvent,
  encodeLedgerEvent,
  encodeProjection,
  EventCodecError,
  EventStoreCorruptionError,
  EventStoreVersionError,
  reduceLedgerEvent,
  replayLedger,
  replayLedgerDeterministically,
  sha256,
  SEMANTIC_PAYLOAD_CODECS,
  type DecodedLedgerRecord,
  type EventKind,
  type GroundLedgerEvent,
  type LedgerEventRecord,
  type LegacyStateBootstrappedEvent
} from './index'

const TIMESTAMP = '2026-07-31T12:00:00.000Z'
const LATER = '2026-07-31T12:05:00.000Z'
const ACTION_SHA = sha256('action')
const APPROVAL_SHA = sha256('approval')

function initialState(): PersistedStateData {
  return {
    version: 2,
    providers: [
      {
        id: 'provider_local',
        name: 'Local',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'test-model',
        hasApiKey: false,
        supportsTools: true,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP
      }
    ],
    mcpServers: [],
    tasks: [],
    settings: {
      defaultProviderId: 'provider_local',
      sidebarCollapsed: false
    },
    pendingSecretDeletes: []
  }
}

function bootstrap(state = initialState()): LegacyStateBootstrappedEvent {
  const normalized = encodeProjection(state)
  return {
    kind: 'legacy-state.bootstrapped',
    sourceFormat: 'ground-json',
    sourceStateVersion: 2,
    sourceSha256: sha256('legacy-json-source'),
    sourceByteLength: Buffer.byteLength('legacy-json-source'),
    normalizedStateSha256: normalized.stateSha256,
    state: normalized.state
  }
}

function taskBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task_1',
    title: 'New task',
    providerId: 'provider_local',
    mode: 'agent',
    runStatus: 'idle',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    items: [],
    ...overrides
  }
}

function providerBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...initialState().providers[0], ...overrides }
}

function mcpServerBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'server_1',
    name: 'Docs',
    namespace: 'docs',
    enabled: true,
    trustedFingerprints: {},
    transport: 'stdio',
    command: 'docs-server',
    args: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides
  }
}

function messageBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'message_1',
    kind: 'message',
    role: 'user',
    content: 'hello',
    createdAt: TIMESTAMP,
    ...overrides
  }
}

function runtimeSessionBody(): Record<string, unknown> {
  return {
    adapterId: 'cli.codex',
    sessionCompatibilityId: 'codex',
    sessionId: 'session_1',
    providerRevision: TIMESTAMP,
    workspacePath: '/tmp/workspace',
    mode: 'agent',
    updatedAt: TIMESTAMP
  }
}

function modelSessionBody(): Record<string, unknown> {
  return {
    adapterId: 'model.openai-compatible',
    providerRevision: TIMESTAMP,
    model: 'test-model',
    mode: 'agent',
    conversation: [],
    updatedAt: TIMESTAMP
  }
}

function approvalActivity(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'activity_1',
    kind: 'activity',
    runId: 'run_1',
    activityType: 'approval',
    title: 'Run command',
    status: 'pending',
    createdAt: TIMESTAMP,
    approvalId: 'approval_1',
    callId: 'call_1',
    toolName: 'run_command',
    ...overrides
  }
}

/** Folds events onto the bootstrap projection and returns the final state. */
function fold(...events: readonly GroundLedgerEvent[]): PersistedStateData {
  let state = reduceLedgerEvent(undefined, bootstrap(), 1)
  for (const [index, event] of events.entries()) {
    state = reduceLedgerEvent(state, event, index + 2)
  }
  return state
}

/** A task awaiting approval with one unconsumed pending approval activity. */
function awaitingApproval(): readonly GroundLedgerEvent[] {
  return [
    {
      kind: 'task.created',
      taskId: 'task_1',
      task: taskBody()
    },
    {
      kind: 'task.item-appended',
      taskId: 'task_1',
      itemId: 'activity_1',
      item: approvalActivity(),
      updatedAt: TIMESTAMP
    },
    {
      kind: 'task.run-status-set',
      taskId: 'task_1',
      runStatus: 'awaiting-approval',
      updatedAt: TIMESTAMP
    }
  ]
}

const startedExecution: GroundLedgerEvent = {
  kind: 'managed-execution.started',
  taskId: 'task_1',
  itemId: 'activity_1',
  runId: 'run_1',
  callId: 'call_1',
  toolName: 'run_command',
  executionKind: 'command',
  actionSha256: ACTION_SHA,
  approvalSha256: APPROVAL_SHA,
  startedAt: TIMESTAMP,
  updatedAt: TIMESTAMP
}

/** Every semantic event kind, used for exhaustive round-trip coverage. */
const SAMPLE_EVENTS: readonly GroundLedgerEvent[] = [
  { kind: 'settings.sidebar-collapsed-set', collapsed: true },
  { kind: 'settings.selected-task-set', taskId: 'task_1' },
  { kind: 'settings.selected-task-set', taskId: null },
  { kind: 'settings.default-provider-set', providerId: 'provider_local' },
  {
    kind: 'provider.upserted',
    providerId: 'provider_local',
    provider: providerBody()
  },
  {
    kind: 'provider.secret-transition-published',
    providerId: 'provider_local',
    provider: providerBody(),
    stagedReference: 'vault:staged',
    obsoleteReferences: ['vault:old']
  },
  {
    kind: 'provider.deleted',
    providerId: 'provider_local',
    obsoleteReferences: ['vault:old']
  },
  { kind: 'secret-cleanup.queued', reference: 'vault:old' },
  { kind: 'secret-cleanup.acknowledged', references: ['vault:old'] },
  { kind: 'mcp-server.saved', serverId: 'server_1', server: mcpServerBody() },
  { kind: 'mcp-server.deleted', serverId: 'server_1' },
  { kind: 'task.created', taskId: 'task_1', task: taskBody() },
  {
    kind: 'task.forked',
    taskId: 'task_2',
    sourceTaskId: 'task_1',
    task: taskBody({ id: 'task_2' })
  },
  { kind: 'task.imported', taskId: 'task_3', task: taskBody({ id: 'task_3' }) },
  { kind: 'task.deleted', taskId: 'task_1' },
  {
    kind: 'task.archived-set',
    taskId: 'task_1',
    archivedAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.title-set',
    taskId: 'task_1',
    title: 'Renamed',
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.provider-set',
    taskId: 'task_1',
    providerId: 'provider_local',
    updatedAt: TIMESTAMP
  },
  { kind: 'task.mode-set', taskId: 'task_1', mode: 'ask', updatedAt: TIMESTAMP },
  {
    kind: 'task.workspace-set',
    taskId: 'task_1',
    workspacePath: '/tmp/workspace',
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.imported-history-set',
    taskId: 'task_1',
    includeImportedHistory: true,
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.run-status-set',
    taskId: 'task_1',
    runStatus: 'running',
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.runtime-session-set',
    taskId: 'task_1',
    providerId: 'provider_local',
    session: runtimeSessionBody(),
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.runtime-session-set',
    taskId: 'task_1',
    providerId: 'provider_local',
    session: null,
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.model-session-set',
    taskId: 'task_1',
    providerId: 'provider_local',
    session: modelSessionBody(),
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.model-session-set',
    taskId: 'task_1',
    providerId: 'provider_local',
    session: null,
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.item-appended',
    taskId: 'task_1',
    itemId: 'message_1',
    item: messageBody(),
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.message-content-set',
    taskId: 'task_1',
    itemId: 'message_1',
    content: 'hello',
    updatedAt: TIMESTAMP
  },
  {
    kind: 'task.activity-updated',
    taskId: 'task_1',
    itemId: 'activity_1',
    status: 'success',
    result: 'done',
    updatedAt: TIMESTAMP
  },
  startedExecution,
  {
    kind: 'managed-execution.completed',
    taskId: 'task_1',
    itemId: 'activity_1',
    operationId: 'activity_1',
    actionSha256: ACTION_SHA,
    status: 'success',
    result: 'ok',
    durationMs: 12,
    completedAt: LATER,
    updatedAt: LATER
  },
  {
    kind: 'managed-execution.interrupted',
    taskId: 'task_1',
    itemId: 'activity_1',
    operationId: 'activity_1',
    interruptedAt: LATER,
    updatedAt: LATER
  },
  {
    kind: 'managed-execution.legacy-interrupted',
    taskId: 'task_1',
    itemId: 'activity_1',
    executionKind: 'command',
    startedAt: LATER,
    interruptedAt: LATER,
    updatedAt: LATER
  }
]

describe('semantic ledger event codec', () => {
  it('covers every declared semantic event kind', () => {
    const covered = new Set(SAMPLE_EVENTS.map((event) => event.kind))
    for (const kind of Object.keys(SEMANTIC_PAYLOAD_CODECS) as EventKind[]) {
      expect(covered.has(kind)).toBe(true)
    }
  })

  it('round-trips every semantic event without drift', () => {
    for (const event of SAMPLE_EVENTS) {
      const encoded = encodeLedgerEvent(event)
      const decoded = decodeLedgerEvent(
        encoded.kind,
        encoded.entityId,
        encoded.payloadJson
      )
      expect(decoded).toEqual(event)
      expect(encodeLedgerEvent(decoded).payloadJson).toBe(encoded.payloadJson)
    }
  })

  it('binds every event to an exact entity identifier', () => {
    const encoded = encodeLedgerEvent({
      kind: 'task.title-set',
      taskId: 'task_1',
      title: 'Renamed',
      updatedAt: TIMESTAMP
    })
    expect(encoded.entityId).toBe('task_1')
    expect(() =>
      decodeLedgerEvent(encoded.kind, 'task_other', encoded.payloadJson)
    ).toThrow(EventStoreCorruptionError)
  })

  it('fails closed on an unknown event kind', () => {
    expect(() =>
      decodeLedgerEvent('task.teleported', 'task_1', '{"taskId":"task_1"}')
    ).toThrow(EventStoreVersionError)
  })

  it('rejects unknown payload keys rather than preserving them', () => {
    expect(() =>
      decodeLedgerEvent(
        'task.deleted',
        'task_1',
        '{"escalate":true,"taskId":"task_1"}'
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('rejects an activity update that changes nothing', () => {
    expect(() =>
      encodeLedgerEvent({
        kind: 'task.activity-updated',
        taskId: 'task_1',
        itemId: 'activity_1',
        updatedAt: TIMESTAMP
      })
    ).toThrow(EventCodecError)
  })

  it('rejects invented evidence on a legacy interruption payload', () => {
    const codec = SEMANTIC_PAYLOAD_CODECS[
      'managed-execution.legacy-interrupted'
    ]
    const payload = {
      taskId: 'task_1',
      itemId: 'activity_1',
      executionKind: 'command',
      startedAt: TIMESTAMP,
      interruptedAt: LATER,
      updatedAt: LATER
    }
    expect(
      codec.schema.safeParse({ ...payload, operationId: 'invented' }).success
    ).toBe(false)
    expect(
      codec.schema.safeParse({ ...payload, actionSha256: ACTION_SHA }).success
    ).toBe(false)
    expect(
      codec.schema.safeParse({ ...payload, approvalSha256: APPROVAL_SHA }).success
    ).toBe(false)
  })

  it('enforces field bounds', () => {
    expect(() =>
      encodeLedgerEvent({
        kind: 'task.title-set',
        taskId: 'task_1',
        title: 'x'.repeat(121),
        updatedAt: TIMESTAMP
      })
    ).toThrow(EventCodecError)
    expect(() =>
      encodeLedgerEvent({
        ...startedExecution,
        actionSha256: 'not-a-hash'
      })
    ).toThrow(EventCodecError)
    expect(() =>
      encodeLedgerEvent({
        kind: 'task.archived-set',
        taskId: 'task_1',
        archivedAt: 'yesterday',
        updatedAt: TIMESTAMP
      })
    ).toThrow(EventCodecError)
  })

  it('refuses an entity body the domain schema rejects', () => {
    expect(() =>
      encodeLedgerEvent({
        kind: 'provider.upserted',
        providerId: 'provider_local',
        provider: { id: 'provider_local', name: 'Local' }
      })
    ).toThrow(EventCodecError)
    expect(() =>
      encodeLedgerEvent({
        kind: 'task.created',
        taskId: 'task_1',
        task: taskBody({ runStatus: 'exploded' })
      })
    ).toThrow(EventCodecError)
    expect(() =>
      encodeLedgerEvent({
        kind: 'mcp-server.saved',
        serverId: 'server_1',
        server: mcpServerBody({ transport: 'carrier-pigeon' })
      })
    ).toThrow(EventCodecError)
  })
})

describe('semantic ledger reducers', () => {
  it('requires the bootstrap projection before any semantic fact', () => {
    expect(() =>
      reduceLedgerEvent(
        undefined,
        { kind: 'settings.sidebar-collapsed-set', collapsed: true },
        1
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('creates, selects, renames, archives, and deletes a task', () => {
    const created = fold({
      kind: 'task.created',
      taskId: 'task_1',
      task: taskBody()
    })
    expect(created.tasks).toHaveLength(1)
    expect(created.settings.selectedTaskId).toBe('task_1')
    expect(created.settings.defaultProviderId).toBe('provider_local')

    const renamed = fold(
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      {
        kind: 'task.title-set',
        taskId: 'task_1',
        title: 'Renamed',
        updatedAt: LATER
      }
    )
    expect(renamed.tasks[0]?.title).toBe('Renamed')
    expect(renamed.tasks[0]?.updatedAt).toBe(LATER)

    const archived = fold(
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      {
        kind: 'task.archived-set',
        taskId: 'task_1',
        archivedAt: LATER,
        updatedAt: LATER
      }
    )
    expect(archived.tasks[0]?.archivedAt).toBe(LATER)

    const unarchived = fold(
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      {
        kind: 'task.archived-set',
        taskId: 'task_1',
        archivedAt: LATER,
        updatedAt: LATER
      },
      {
        kind: 'task.archived-set',
        taskId: 'task_1',
        archivedAt: null,
        updatedAt: LATER
      }
    )
    expect(unarchived.tasks[0]?.archivedAt).toBeUndefined()

    const deleted = fold(
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      { kind: 'task.deleted', taskId: 'task_1' }
    )
    expect(deleted.tasks).toHaveLength(0)
    expect(deleted.settings.selectedTaskId).toBeUndefined()
  })

  it('refuses to reference an unknown task or provider', () => {
    expect(() =>
      fold({
        kind: 'task.title-set',
        taskId: 'task_missing',
        title: 'Renamed',
        updatedAt: TIMESTAMP
      })
    ).toThrow(EventStoreCorruptionError)
    expect(() =>
      fold({
        kind: 'settings.default-provider-set',
        providerId: 'provider_missing'
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses a duplicate task or timeline item', () => {
    expect(() =>
      fold(
        { kind: 'task.created', taskId: 'task_1', task: taskBody() },
        { kind: 'task.created', taskId: 'task_1', task: taskBody() }
      )
    ).toThrow(EventStoreCorruptionError)
    expect(() =>
      fold(
        { kind: 'task.created', taskId: 'task_1', task: taskBody() },
        {
          kind: 'task.item-appended',
          taskId: 'task_1',
          itemId: 'message_1',
          item: messageBody({ content: 'one' }),
          updatedAt: TIMESTAMP
        },
        {
          kind: 'task.item-appended',
          taskId: 'task_1',
          itemId: 'message_1',
          item: messageBody({ content: 'two' }),
          updatedAt: TIMESTAMP
        }
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('requires an entity body to match its exact identifier', () => {
    expect(() =>
      fold({
        kind: 'task.created',
        taskId: 'task_1',
        task: taskBody({ id: 'task_other' })
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('reassigns tasks and the default provider when a provider is deleted', () => {
    const state = fold(
      {
        kind: 'provider.upserted',
        providerId: 'provider_second',
        provider: providerBody({
          id: 'provider_second',
          name: 'Second',
          model: 'other-model'
        })
      },
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      {
        kind: 'provider.deleted',
        providerId: 'provider_local',
        obsoleteReferences: ['vault:old']
      }
    )
    expect(state.providers.map((provider) => provider.id)).toEqual([
      'provider_second'
    ])
    expect(state.tasks[0]?.providerId).toBe('provider_second')
    expect(state.settings.defaultProviderId).toBe('provider_second')
    expect(state.pendingSecretDeletes).toContain('vault:old')
  })

  it('refuses to delete the last remaining provider', () => {
    expect(() =>
      fold({
        kind: 'provider.deleted',
        providerId: 'provider_local',
        obsoleteReferences: []
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('keeps pending secret-cleanup references exact and idempotent', () => {
    const queued = fold(
      { kind: 'secret-cleanup.queued', reference: 'vault:one' },
      { kind: 'secret-cleanup.queued', reference: 'vault:one' },
      { kind: 'secret-cleanup.queued', reference: 'vault:two' }
    )
    expect(queued.pendingSecretDeletes).toEqual(['vault:one', 'vault:two'])

    const acknowledged = fold(
      { kind: 'secret-cleanup.queued', reference: 'vault:one' },
      { kind: 'secret-cleanup.queued', reference: 'vault:two' },
      { kind: 'secret-cleanup.acknowledged', references: ['vault:one'] }
    )
    expect(acknowledged.pendingSecretDeletes).toEqual(['vault:two'])
  })

  it('stages and retires references through a provider secret transition', () => {
    const state = fold(
      { kind: 'secret-cleanup.queued', reference: 'vault:staged' },
      {
        kind: 'provider.secret-transition-published',
        providerId: 'provider_local',
        provider: providerBody({
          hasApiKey: true,
          credentialRevision: 'revision_2',
          updatedAt: LATER
        }),
        stagedReference: 'vault:staged',
        obsoleteReferences: ['vault:previous']
      }
    )
    expect(state.pendingSecretDeletes).toEqual(['vault:previous'])
    const provider = state.providers[0]
    expect(provider?.kind === 'cli' ? undefined : provider?.credentialRevision).toBe(
      'revision_2'
    )
  })

  it('never lets an unmodelled field reach the ledger', () => {
    // The projection strips unknown keys, but that is too late for an
    // append-only ledger: normalization has to happen before encoding.
    const encoded = encodeLedgerEvent({
      kind: 'provider.upserted',
      providerId: 'provider_local',
      provider: providerBody({
        apiKey: 'sk-live-secret',
        rendererGrant: 'escalated'
      })
    })
    expect(encoded.payloadJson).not.toContain('sk-live-secret')
    expect(encoded.payloadJson).not.toContain('rendererGrant')

    const state = fold(
      decodeLedgerEvent(encoded.kind, encoded.entityId, encoded.payloadJson)
    )
    expect(state.providers[0]).not.toHaveProperty('apiKey')
    expect(state.providers[0]).not.toHaveProperty('rendererGrant')
  })

  it('preserves permitted arbitrary content inside recorded tool input', () => {
    // A user or tool payload may legitimately contain a field called "token".
    // Only unmodelled *structural* fields are removed.
    const encoded = encodeLedgerEvent({
      kind: 'task.item-appended',
      taskId: 'task_1',
      itemId: 'activity_2',
      item: {
        id: 'activity_2',
        kind: 'activity',
        runId: 'run_1',
        activityType: 'tool',
        title: 'Call tool',
        status: 'success',
        createdAt: TIMESTAMP,
        toolName: 'mcp__docs__search',
        input: { token: 'user-supplied-value', nested: { password: 'literal' } }
      },
      updatedAt: TIMESTAMP
    })
    expect(encoded.payloadJson).toContain('user-supplied-value')

    const state = fold(
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      decodeLedgerEvent(encoded.kind, encoded.entityId, encoded.payloadJson)
    )
    const item = state.tasks[0]?.items[0]
    expect(item?.kind === 'activity' ? item.input : undefined).toEqual({
      token: 'user-supplied-value',
      nested: { password: 'literal' }
    })
  })

  it('saves and deletes MCP profiles', () => {
    const server = mcpServerBody()
    const saved = fold({
      kind: 'mcp-server.saved',
      serverId: 'server_1',
      server
    })
    expect(saved.mcpServers).toHaveLength(1)

    const deleted = fold(
      { kind: 'mcp-server.saved', serverId: 'server_1', server },
      { kind: 'mcp-server.deleted', serverId: 'server_1' }
    )
    expect(deleted.mcpServers).toHaveLength(0)

    expect(() =>
      fold({ kind: 'mcp-server.deleted', serverId: 'server_missing' })
    ).toThrow(EventStoreCorruptionError)
  })

  it('rejects a projection the state schema refuses', () => {
    expect(() =>
      fold({
        kind: 'task.created',
        taskId: 'task_1',
        task: taskBody({ providerId: 'provider_missing' })
      })
    ).toThrow(EventStoreCorruptionError)
  })
})

describe('task lifecycle invariants', () => {
  const activeStatuses = ['running', 'awaiting-approval'] as const

  function activeTask(): readonly GroundLedgerEvent[] {
    return [
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      {
        kind: 'task.run-status-set',
        taskId: 'task_1',
        runStatus: 'running',
        updatedAt: TIMESTAMP
      }
    ]
  }

  it('requires a created task to reference an existing provider', () => {
    expect(() =>
      fold({
        kind: 'task.created',
        taskId: 'task_1',
        task: taskBody({ providerId: 'provider_missing' })
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('requires an imported task to reference an existing provider', () => {
    expect(() =>
      fold({
        kind: 'task.imported',
        taskId: 'task_1',
        task: taskBody({ providerId: 'provider_missing' })
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('requires a forked task to reference an existing provider', () => {
    expect(() =>
      fold(
        { kind: 'task.created', taskId: 'task_1', task: taskBody() },
        {
          kind: 'task.forked',
          taskId: 'task_2',
          sourceTaskId: 'task_1',
          task: taskBody({ id: 'task_2', providerId: 'provider_missing' })
        }
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses to fork an active task', () => {
    for (const runStatus of activeStatuses) {
      expect(() =>
        fold(
          { kind: 'task.created', taskId: 'task_1', task: taskBody() },
          {
            kind: 'task.run-status-set',
            taskId: 'task_1',
            runStatus,
            updatedAt: TIMESTAMP
          },
          {
            kind: 'task.forked',
            taskId: 'task_2',
            sourceTaskId: 'task_1',
            task: taskBody({ id: 'task_2' })
          }
        )
      ).toThrow(EventStoreCorruptionError)
    }
  })

  it('refuses to archive an active task', () => {
    expect(() =>
      fold(...activeTask(), {
        kind: 'task.archived-set',
        taskId: 'task_1',
        archivedAt: LATER,
        updatedAt: LATER
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses to delete an active task', () => {
    expect(() =>
      fold(...activeTask(), { kind: 'task.deleted', taskId: 'task_1' })
    ).toThrow(EventStoreCorruptionError)
  })

  it('requires session events to reference an existing provider', () => {
    expect(() =>
      fold(
        { kind: 'task.created', taskId: 'task_1', task: taskBody() },
        {
          kind: 'task.runtime-session-set',
          taskId: 'task_1',
          providerId: 'provider_missing',
          session: runtimeSessionBody(),
          updatedAt: TIMESTAMP
        }
      )
    ).toThrow(EventStoreCorruptionError)
    expect(() =>
      fold(
        { kind: 'task.created', taskId: 'task_1', task: taskBody() },
        {
          kind: 'task.model-session-set',
          taskId: 'task_1',
          providerId: 'provider_missing',
          session: modelSessionBody(),
          updatedAt: TIMESTAMP
        }
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('allows only recovery-safe narrowing of a session orphaned by provider deletion', () => {
    const orphanedRuntime = fold(
      {
        kind: 'task.created',
        taskId: 'task_1',
        task: taskBody({
          runtimeSessions: { provider_missing: runtimeSessionBody() }
        })
      },
      {
        kind: 'task.runtime-session-set',
        taskId: 'task_1',
        providerId: 'provider_missing',
        session: null,
        updatedAt: LATER
      }
    )
    expect(orphanedRuntime.tasks[0]?.runtimeSessions).toBeUndefined()

    const orphanedModel = fold(
      {
        kind: 'task.created',
        taskId: 'task_1',
        task: taskBody({
          modelSessions: {
            provider_missing: {
              ...modelSessionBody(),
              checkpoint: { cursor: 7 }
            }
          }
        })
      },
      {
        kind: 'task.model-session-set',
        taskId: 'task_1',
        providerId: 'provider_missing',
        session: modelSessionBody(),
        updatedAt: LATER
      }
    )
    expect(
      orphanedModel.tasks[0]?.modelSessions?.provider_missing
    ).not.toHaveProperty('checkpoint')
  })

  it('refuses arbitrary session rewrites under a deleted provider', () => {
    const task = {
      kind: 'task.created',
      taskId: 'task_1',
      task: taskBody({
        runtimeSessions: { provider_missing: runtimeSessionBody() },
        modelSessions: {
          provider_missing: {
            ...modelSessionBody(),
            checkpoint: { cursor: 7 }
          }
        }
      })
    } as const

    expect(() =>
      fold(task, {
        kind: 'task.runtime-session-set',
        taskId: 'task_1',
        providerId: 'provider_missing',
        session: { ...runtimeSessionBody(), sessionId: 'rewritten' },
        updatedAt: LATER
      })
    ).toThrow(EventStoreCorruptionError)
    expect(() =>
      fold(task, {
        kind: 'task.model-session-set',
        taskId: 'task_1',
        providerId: 'provider_missing',
        session: { ...modelSessionBody(), model: 'rewritten' },
        updatedAt: LATER
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('binds and forgets exactly one session at a time', () => {
    const bound = fold(
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      {
        kind: 'task.model-session-set',
        taskId: 'task_1',
        providerId: 'provider_local',
        session: modelSessionBody(),
        updatedAt: TIMESTAMP
      }
    )
    expect(bound.tasks[0]?.modelSessions).toHaveProperty('provider_local')

    const forgotten = fold(
      { kind: 'task.created', taskId: 'task_1', task: taskBody() },
      {
        kind: 'task.model-session-set',
        taskId: 'task_1',
        providerId: 'provider_local',
        session: modelSessionBody(),
        updatedAt: TIMESTAMP
      },
      {
        kind: 'task.model-session-set',
        taskId: 'task_1',
        providerId: 'provider_local',
        session: null,
        updatedAt: LATER
      }
    )
    expect(forgotten.tasks[0]?.modelSessions).toBeUndefined()
  })
})

describe('managed execution facts', () => {
  const legacyActivity = {
    id: 'activity_legacy',
    kind: 'activity' as const,
    runId: 'run_1',
    activityType: 'tool' as const,
    title: 'Write file',
    status: 'running' as const,
    toolName: 'write_file',
    createdAt: TIMESTAMP
  }
  const legacyInterrupted = {
    kind: 'managed-execution.legacy-interrupted' as const,
    taskId: 'task_1',
    itemId: 'activity_legacy',
    executionKind: 'workspace-write' as const,
    startedAt: TIMESTAMP,
    interruptedAt: LATER,
    updatedAt: LATER
  }

  it('records legacy interruption without inventing approval evidence', () => {
    const state = fold(
      {
        kind: 'task.created',
        taskId: 'task_1',
        task: taskBody({ runStatus: 'running', items: [legacyActivity] })
      },
      legacyInterrupted
    )
    expect(state.tasks[0]?.items[0]).toMatchObject({
      status: 'error',
      result: expect.stringMatching(/before durable execution claims/is),
      managedExecution: {
        operationId: 'activity_legacy',
        claim: 'legacy-untracked',
        kind: 'workspace-write',
        phase: 'uncertain',
        startedAt: TIMESTAMP,
        interruptedAt: LATER
      }
    })
    expect(state.tasks[0]?.items[0]).not.toHaveProperty(
      'managedExecution.actionSha256'
    )
    expect(state.tasks[0]?.items[0]).not.toHaveProperty(
      'managedExecution.approvalSha256'
    )
  })

  it.each([
    [
      'the execution kind',
      { ...legacyInterrupted, executionKind: 'command' as const }
    ],
    [
      'the derived start time',
      { ...legacyInterrupted, startedAt: LATER }
    ],
    [
      'the single recovery instant',
      { ...legacyInterrupted, updatedAt: TIMESTAMP }
    ]
  ])('refuses legacy interruption that fabricates %s', (_label, event) => {
    expect(() =>
      fold(
        {
          kind: 'task.created',
          taskId: 'task_1',
          task: taskBody({ runStatus: 'running', items: [legacyActivity] })
        },
        event
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('consumes a pending approval into a started claim', () => {
    const state = fold(...awaitingApproval(), startedExecution)
    const activity = state.tasks[0]?.items[0]
    expect(activity).toMatchObject({
      status: 'running',
      activityType: 'command',
      managedExecution: {
        claim: 'approved',
        phase: 'started',
        actionSha256: ACTION_SHA,
        operationId: 'activity_1'
      }
    })
    expect(activity).not.toHaveProperty('approvalId')
    expect(state.tasks[0]?.runStatus).toBe('running')
  })

  it('refuses a second durable claim on one operation', () => {
    expect(() =>
      fold(...awaitingApproval(), startedExecution, startedExecution)
    ).toThrow(EventStoreCorruptionError)
  })

  it('requires the task to be awaiting approval', () => {
    expect(() =>
      fold(
        { kind: 'task.created', taskId: 'task_1', task: taskBody() },
        {
          kind: 'task.item-appended',
          taskId: 'task_1',
          itemId: 'activity_1',
          item: approvalActivity(),
          updatedAt: TIMESTAMP
        },
        startedExecution
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('requires an unconsumed pending approval activity', () => {
    for (const overrides of [
      { status: 'running' },
      { activityType: 'status' },
      { approvalId: undefined }
    ] as const) {
      expect(() =>
        fold(
          { kind: 'task.created', taskId: 'task_1', task: taskBody() },
          {
            kind: 'task.item-appended',
            taskId: 'task_1',
            itemId: 'activity_1',
            item: approvalActivity(overrides),
            updatedAt: TIMESTAMP
          },
          {
            kind: 'task.run-status-set',
            taskId: 'task_1',
            runStatus: 'awaiting-approval',
            updatedAt: TIMESTAMP
          },
          startedExecution
        )
      ).toThrow(EventStoreCorruptionError)
    }
  })

  it('refuses imported history as an approval source', () => {
    expect(() =>
      fold(
        { kind: 'task.created', taskId: 'task_1', task: taskBody() },
        {
          kind: 'task.item-appended',
          taskId: 'task_1',
          itemId: 'activity_1',
          item: approvalActivity({ historyOnly: true }),
          updatedAt: TIMESTAMP
        },
        {
          kind: 'task.run-status-set',
          taskId: 'task_1',
          runStatus: 'awaiting-approval',
          updatedAt: TIMESTAMP
        },
        startedExecution
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses an execution kind that does not match its tool', () => {
    expect(() =>
      fold(...awaitingApproval(), {
        ...startedExecution,
        executionKind: 'workspace-write'
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses a second claim on the same run and call in another task', () => {
    expect(() =>
      fold(
        ...awaitingApproval(),
        startedExecution,
        {
          kind: 'task.created',
          taskId: 'task_2',
          task: taskBody({ id: 'task_2' })
        },
        {
          kind: 'task.item-appended',
          taskId: 'task_2',
          itemId: 'activity_2',
          item: approvalActivity({ id: 'activity_2' }),
          updatedAt: TIMESTAMP
        },
        {
          kind: 'task.run-status-set',
          taskId: 'task_2',
          runStatus: 'awaiting-approval',
          updatedAt: TIMESTAMP
        },
        {
          ...startedExecution,
          taskId: 'task_2',
          itemId: 'activity_2'
        }
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses a claim whose identity does not match its approval', () => {
    expect(() =>
      fold(...awaitingApproval(), {
        ...startedExecution,
        callId: 'call_other'
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('completes exactly one started claim with a matching action hash', () => {
    const state = fold(...awaitingApproval(), startedExecution, {
      kind: 'managed-execution.completed',
      taskId: 'task_1',
      itemId: 'activity_1',
      operationId: 'activity_1',
      actionSha256: ACTION_SHA,
      status: 'success',
      result: 'ok',
      durationMs: 25,
      completedAt: LATER,
      updatedAt: LATER
    })
    expect(state.tasks[0]?.items[0]).toMatchObject({
      status: 'success',
      result: 'ok',
      managedExecution: { phase: 'completed', completedAt: LATER }
    })
  })

  it('refuses completion with a different action hash', () => {
    expect(() =>
      fold(...awaitingApproval(), startedExecution, {
        kind: 'managed-execution.completed',
        taskId: 'task_1',
        itemId: 'activity_1',
        operationId: 'activity_1',
        actionSha256: sha256('other-action'),
        status: 'success',
        completedAt: LATER,
        updatedAt: LATER
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses completion once the activity is no longer running', () => {
    expect(() =>
      fold(
        ...awaitingApproval(),
        startedExecution,
        {
          kind: 'task.activity-updated',
          taskId: 'task_1',
          itemId: 'activity_1',
          status: 'denied',
          updatedAt: LATER
        },
        {
          kind: 'managed-execution.completed',
          taskId: 'task_1',
          itemId: 'activity_1',
          operationId: 'activity_1',
          actionSha256: ACTION_SHA,
          status: 'success',
          completedAt: LATER,
          updatedAt: LATER
        }
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses completion without a started claim', () => {
    expect(() =>
      fold(...awaitingApproval(), {
        kind: 'managed-execution.completed',
        taskId: 'task_1',
        itemId: 'activity_1',
        operationId: 'activity_1',
        actionSha256: ACTION_SHA,
        status: 'success',
        completedAt: LATER,
        updatedAt: LATER
      })
    ).toThrow(EventStoreCorruptionError)
  })

  it('never rewrites outcome-unknown evidence into an outcome', () => {
    const interrupted = fold(...awaitingApproval(), startedExecution, {
      kind: 'managed-execution.interrupted',
      taskId: 'task_1',
      itemId: 'activity_1',
      operationId: 'activity_1',
      interruptedAt: LATER,
      updatedAt: LATER
    })
    expect(interrupted.tasks[0]?.items[0]).toMatchObject({
      status: 'error',
      managedExecution: { phase: 'uncertain', interruptedAt: LATER }
    })

    expect(() =>
      fold(
        ...awaitingApproval(),
        startedExecution,
        {
          kind: 'managed-execution.interrupted',
          taskId: 'task_1',
          itemId: 'activity_1',
          operationId: 'activity_1',
          interruptedAt: LATER,
          updatedAt: LATER
        },
        {
          kind: 'managed-execution.completed',
          taskId: 'task_1',
          itemId: 'activity_1',
          operationId: 'activity_1',
          actionSha256: ACTION_SHA,
          status: 'success',
          completedAt: LATER,
          updatedAt: LATER
        }
      )
    ).toThrow(EventStoreCorruptionError)
  })

  it('refuses managed execution on an archived task', () => {
    expect(() =>
      fold(
        { kind: 'task.created', taskId: 'task_1', task: taskBody() },
        {
          kind: 'task.item-appended',
          taskId: 'task_1',
          itemId: 'activity_1',
          item: approvalActivity(),
          updatedAt: TIMESTAMP
        },
        {
          kind: 'task.archived-set',
          taskId: 'task_1',
          archivedAt: LATER,
          updatedAt: LATER
        },
        startedExecution
      )
    ).toThrow(EventStoreCorruptionError)
  })
})

describe('deterministic replay', () => {
  function records(
    events: readonly GroundLedgerEvent[]
  ): readonly DecodedLedgerRecord[] {
    return events.map((event, index) => ({
      record: { sequence: index + 1 } as LedgerEventRecord,
      event
    }))
  }

  const timeline: readonly GroundLedgerEvent[] = [
    bootstrap(),
    ...awaitingApproval(),
    startedExecution,
    {
      kind: 'managed-execution.completed',
      taskId: 'task_1',
      itemId: 'activity_1',
      operationId: 'activity_1',
      actionSha256: ACTION_SHA,
      status: 'success',
      result: 'ok',
      completedAt: LATER,
      updatedAt: LATER
    },
    { kind: 'settings.sidebar-collapsed-set', collapsed: true },
    { kind: 'secret-cleanup.queued', reference: 'vault:one' }
  ]

  it('rebuilds identical canonical bytes across replays', () => {
    const first = replayLedgerDeterministically(records(timeline))
    const second = replayLedgerDeterministically(records(timeline))
    expect(first.stateSha256).toBe(second.stateSha256)
    expect(first.stateJson).toBe(second.stateJson)
  })

  it('is unaffected by encode/decode transport', () => {
    const transported = timeline.map((event) => {
      const encoded = encodeLedgerEvent(event)
      return decodeLedgerEvent(
        encoded.kind,
        encoded.entityId,
        encoded.payloadJson
      )
    })
    expect(encodeProjection(replayLedger(records(transported))).stateSha256).toBe(
      encodeProjection(replayLedger(records(timeline))).stateSha256
    )
  })

  it('requires a bootstrap projection to replay at all', () => {
    expect(() =>
      replayLedger(
        records([{ kind: 'settings.sidebar-collapsed-set', collapsed: true }])
      )
    ).toThrow(EventStoreCorruptionError)
  })
})
