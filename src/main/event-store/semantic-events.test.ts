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
    provider: { id: 'provider_local', name: 'Local' }
  },
  {
    kind: 'provider.secret-transition-published',
    providerId: 'provider_local',
    provider: { id: 'provider_local', name: 'Local' },
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
  {
    kind: 'mcp-server.saved',
    serverId: 'server_1',
    server: { id: 'server_1', name: 'Docs' }
  },
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
    session: null,
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
    item: { id: 'message_1', kind: 'message' },
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

  it('refuses credential-bearing keys anywhere in an entity body', () => {
    for (const body of [
      { id: 'provider_local', apiKey: 'sk-live-secret' },
      { id: 'provider_local', nested: { authorization: 'Bearer token' } },
      { id: 'provider_local', list: [{ password: 'hunter2' }] }
    ]) {
      expect(() =>
        encodeLedgerEvent({
          kind: 'provider.upserted',
          providerId: 'provider_local',
          provider: body
        })
      ).toThrow(EventCodecError)
    }
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
          item: {
            id: 'message_1',
            kind: 'message',
            role: 'user',
            content: 'one',
            createdAt: TIMESTAMP
          },
          updatedAt: TIMESTAMP
        },
        {
          kind: 'task.item-appended',
          taskId: 'task_1',
          itemId: 'message_1',
          item: {
            id: 'message_1',
            kind: 'message',
            role: 'user',
            content: 'two',
            createdAt: TIMESTAMP
          },
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
    const second = {
      id: 'provider_second',
      name: 'Second',
      kind: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'other-model',
      hasApiKey: false,
      supportsTools: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP
    }
    const state = fold(
      {
        kind: 'provider.upserted',
        providerId: 'provider_second',
        provider: { ...second }
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
        provider: {
          ...initialState().providers[0],
          hasApiKey: true,
          credentialRevision: 'revision_2',
          updatedAt: LATER
        } as unknown as Record<string, unknown>,
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

  it('strips unmodelled provider fields from the projection', () => {
    const state = fold({
      kind: 'provider.upserted',
      providerId: 'provider_local',
      provider: {
        ...initialState().providers[0],
        rendererGrant: 'escalated'
      } as unknown as Record<string, unknown>
    })
    expect(state.providers[0]).not.toHaveProperty('rendererGrant')
  })

  it('saves and deletes MCP profiles', () => {
    const server = {
      id: 'server_1',
      name: 'Docs',
      namespace: 'docs',
      enabled: true,
      trustedFingerprints: {},
      transport: 'stdio',
      command: 'docs-server',
      args: [],
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP
    }
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
        task: taskBody({ runStatus: 'exploded' })
      })
    ).toThrow(EventStoreCorruptionError)
  })
})

describe('managed execution facts', () => {
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
