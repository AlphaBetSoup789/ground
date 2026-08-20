import { describe, expect, it } from 'vitest'
import type { ModelRuntimeSession, RuntimeSession } from '../../shared/types'
import { recoverInterruptedRuns } from '../legacy-state-recovery'
import {
  MAX_PERSISTED_TASK_ITEMS,
  type PersistedStateData
} from '../state-schema'
import { decodeLedgerEvent, encodeLedgerEvent, encodeProjection } from './codec'
import { planInterruptedRunRecovery } from './interrupted-run-recovery-plan'
import { reduceLedgerEvent } from './reducer'
import type { GroundLedgerEvent } from './types'

/**
 * The A1 parity property.
 *
 * `recoverInterruptedRuns` mutates a document; `planInterruptedRunRecovery`
 * emits the events that reproduce it. Both must land on the same canonical
 * state, and the comparison is SHA-256 over canonical JSON rather than a
 * structural match, because the cutover's whole safety argument is that the two
 * representations are interchangeable byte for byte.
 *
 * Every plan is round-tripped through `encodeLedgerEvent` / `decodeLedgerEvent`
 * before it is replayed. Folding the in-memory event objects alone would pass
 * even if a payload schema rejected the event or dropped a field on the way to
 * disk, which is the failure that matters for a durable log.
 */

const INTERRUPTED_AT = '2026-08-12T00:00:00.000Z'
const CREATED_AT = '2026-08-01T00:00:00.000Z'

function baseState(): PersistedStateData {
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
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT
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

type TaskSeed = Partial<PersistedStateData['tasks'][number]>

function withTask(seed: TaskSeed): PersistedStateData {
  const state = baseState()
  state.tasks = [
    {
      id: 'task_1',
      title: 'Task',
      providerId: 'provider_local',
      mode: 'agent',
      runStatus: 'idle',
      items: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      ...seed
    } as PersistedStateData['tasks'][number]
  ]
  return state
}

function runtimeSession(): RuntimeSession {
  return {
    adapterId: 'adapter_codex',
    sessionCompatibilityId: 'compat_codex',
    sessionId: 'session_1',
    providerRevision: CREATED_AT,
    workspacePath: '/workspace',
    mode: 'agent',
    updatedAt: CREATED_AT
  }
}

function modelSession(withCheckpoint: boolean): ModelRuntimeSession {
  return {
    adapterId: 'adapter_openai',
    providerRevision: CREATED_AT,
    model: 'test-model',
    mode: 'agent',
    conversation: [],
    updatedAt: CREATED_AT,
    ...(withCheckpoint ? { checkpoint: { cursor: 7 } } : {})
  }
}

/** Folds a plan onto the base state exactly as a ledger replay would. */
function replayPlan(
  base: PersistedStateData,
  events: readonly GroundLedgerEvent[]
): PersistedStateData {
  let current: PersistedStateData = encodeProjection(base).state
  let sequence = 1
  for (const event of events) {
    sequence += 1
    const encoded = encodeLedgerEvent(event)
    const durable = decodeLedgerEvent(
      encoded.kind,
      encoded.entityId,
      encoded.payloadJson
    )
    current = reduceLedgerEvent(current, durable, sequence)
  }
  return current
}

function recovered(state: PersistedStateData): PersistedStateData {
  const clone = structuredClone(state)
  recoverInterruptedRuns(clone, INTERRUPTED_AT)
  return clone
}

/** The property itself: identical canonical SHA-256 from both paths. */
function expectParity(state: PersistedStateData): {
  readonly plannedEvents: number
  readonly sha256: string
} {
  const expected = encodeProjection(recovered(state))
  const plan = planInterruptedRunRecovery(state, INTERRUPTED_AT)
  const replayed = encodeProjection(replayPlan(state, plan.events))

  expect(replayed.stateJson).toBe(expected.stateJson)
  expect(replayed.stateSha256).toBe(expected.stateSha256)
  return { plannedEvents: plan.events.length, sha256: replayed.stateSha256 }
}

const scenarios: ReadonlyArray<readonly [string, PersistedStateData]> = [
  ['no tasks at all', baseState()],
  [
    'an idle task with nothing to recover',
    withTask({
      items: [
        {
          id: 'activity_done',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Read',
          status: 'success',
          createdAt: CREATED_AT
        }
      ]
    })
  ],
  [
    'a running task with a plain running activity',
    withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_running',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Reading files',
          status: 'running',
          createdAt: CREATED_AT
        }
      ]
    })
  ],
  [
    'a pending approval carrying a stale approval ID',
    withTask({
      runStatus: 'awaiting-approval',
      items: [
        {
          id: 'activity_pending',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'approval',
          title: 'Approve write',
          status: 'pending',
          approvalId: 'approval_1',
          toolName: 'write_file',
          callId: 'call_1',
          createdAt: CREATED_AT
        }
      ]
    })
  ],
  [
    'an approved and started managed execution',
    withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_managed',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'command',
          title: 'Run command',
          status: 'running',
          toolName: 'run_command',
          callId: 'call_1',
          durationMs: 1_200,
          createdAt: CREATED_AT,
          managedExecution: {
            version: 1,
            operationId: 'activity_managed',
            claim: 'approved',
            kind: 'command',
            actionSha256: 'a'.repeat(64),
            approvalSha256: 'b'.repeat(64),
            phase: 'started',
            startedAt: CREATED_AT
          }
        }
      ]
    })
  ],
  [
    'a legacy untracked workspace write with a strict createdAt',
    withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_legacy_write',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Write file',
          status: 'running',
          toolName: 'write_file',
          durationMs: 40,
          createdAt: CREATED_AT
        }
      ]
    })
  ],
  [
    'a legacy untracked command with a loose createdAt',
    withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_legacy_command',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Run command',
          status: 'running',
          toolName: 'run_command',
          // Not an offset timestamp, so `startedAt` must fall back to the
          // injected recovery stamp rather than a host-local Date.parse.
          createdAt: '2026-07-30T20:00:00'
        }
      ]
    })
  ],
  [
    'a legacy untracked MCP tool',
    withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_legacy_mcp',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'MCP call',
          status: 'running',
          toolName: 'mcp__server__do',
          createdAt: CREATED_AT
        }
      ]
    })
  ],
  [
    'all legacy mutator kinds mixed with a non-mutating tool',
    withTask({
      runStatus: 'running',
      items: (
        [
          ['legacy_write', 'write_file'],
          ['legacy_command', 'run_command'],
          ['legacy_mcp', 'mcp__server__do'],
          ['legacy_read', 'read_file']
        ] as const
      ).map(([id, toolName]) => ({
        id,
        kind: 'activity' as const,
        runId: `${id}_run`,
        activityType: 'tool' as const,
        title: 'Running tool',
        status: 'running' as const,
        toolName,
        createdAt: CREATED_AT
      }))
    })
  ],
  [
    'a strict offset legacy start time that canonicalizes to UTC',
    withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_offset',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Write file',
          status: 'running',
          toolName: 'write_file',
          createdAt: '2026-07-30T16:00:00-04:00'
        }
      ]
    })
  ],
  [
    'a running non-mutating tool that earns no legacy marker',
    withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_read',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Read file',
          status: 'running',
          toolName: 'read_file',
          createdAt: CREATED_AT
        }
      ]
    })
  ],
  [
    'an active task with live runtime and model continuations',
    withTask({
      runStatus: 'running',
      runtimeSessions: { provider_local: runtimeSession() },
      modelSessions: { provider_local: modelSession(true) },
      items: [
        {
          id: 'activity_running',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Reading files',
          status: 'running',
          createdAt: CREATED_AT
        }
      ]
    } as TaskSeed)
  ],
  [
    'a model continuation with no checkpoint to clear',
    withTask({
      runStatus: 'running',
      modelSessions: { provider_local: modelSession(false) },
      items: [
        {
          id: 'activity_running',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Reading files',
          status: 'running',
          createdAt: CREATED_AT
        }
      ]
    } as TaskSeed)
  ],
  [
    // The case that forced the reducer to stop requiring a live provider for a
    // key that is already present: `provider.deleted` never cascaded into
    // these maps, so recovery has to be able to clear an orphan.
    'continuations orphaned by a deleted provider',
    withTask({
      runStatus: 'running',
      runtimeSessions: { provider_deleted: runtimeSession() },
      modelSessions: { provider_deleted: modelSession(true) },
      items: [
        {
          id: 'activity_running',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Reading files',
          status: 'running',
          createdAt: CREATED_AT
        }
      ]
    } as TaskSeed)
  ],
  [
    'an existing run-interrupted summary that must not be duplicated',
    withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_running',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Reading files',
          status: 'running',
          createdAt: CREATED_AT
        },
        {
          id: 'activity_summary',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'error',
          title: 'Run interrupted',
          status: 'error',
          createdAt: CREATED_AT
        }
      ]
    })
  ],
  [
    'an active task with no items, which must invent a run ID',
    withTask({ runStatus: 'running', items: [] })
  ],
  [
    'an active task whose only run ID comes from a message',
    withTask({
      runStatus: 'awaiting-approval',
      items: [
        {
          id: 'message_1',
          kind: 'message',
          role: 'assistant',
          runId: 'run_from_message',
          content: 'working',
          createdAt: CREATED_AT
        }
      ]
    })
  ],
  [
    'several tasks recovered in one pass',
    (() => {
      const state = withTask({
        runStatus: 'running',
        items: [
          {
            id: 'activity_a',
            kind: 'activity',
            runId: 'run_a',
            activityType: 'tool',
            title: 'A',
            status: 'running',
            toolName: 'write_file',
            createdAt: CREATED_AT
          }
        ]
      })
      state.tasks.push({
        id: 'task_2',
        title: 'Second',
        providerId: 'provider_local',
        mode: 'agent',
        runStatus: 'idle',
        items: [
          {
            id: 'activity_b',
            kind: 'activity',
            runId: 'run_b',
            activityType: 'tool',
            title: 'B',
            status: 'pending',
            createdAt: CREATED_AT
          }
        ],
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT
      } as PersistedStateData['tasks'][number])
      return state
    })()
  ]
]

describe('planInterruptedRunRecovery', () => {
  it.each(scenarios)(
    'reproduces in-place recovery for %s',
    (_label, state) => {
      expectParity(state)
    }
  )

  it('plans no events when nothing was interrupted', () => {
    const { plannedEvents } = expectParity(
      withTask({
        items: [
          {
            id: 'activity_done',
            kind: 'activity',
            runId: 'run_1',
            activityType: 'tool',
            title: 'Read',
            status: 'success',
            createdAt: CREATED_AT
          }
        ]
      })
    )
    expect(plannedEvents).toBe(0)
  })

  it('never carries an invented action or approval hash', () => {
    const state = withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_legacy_write',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Write file',
          status: 'running',
          toolName: 'write_file',
          createdAt: CREATED_AT
        }
      ]
    })
    const plan = planInterruptedRunRecovery(state, INTERRUPTED_AT)
    const legacy = plan.events.filter(
      (event) => event.kind === 'managed-execution.legacy-interrupted'
    )
    expect(legacy).toHaveLength(1)
    for (const event of legacy) {
      expect(event).not.toHaveProperty('actionSha256')
      expect(event).not.toHaveProperty('approvalSha256')
      expect(event).not.toHaveProperty('operationId')
    }
    const item = replayPlan(state, plan.events).tasks[0]?.items[0]
    expect(item?.kind).toBe('activity')
    const marker =
      item?.kind === 'activity' ? item.managedExecution : undefined
    expect(item).toMatchObject({
      managedExecution: {
        claim: 'legacy-untracked',
        phase: 'uncertain',
        operationId: 'activity_legacy_write'
      }
    })
    expect(marker).not.toHaveProperty('actionSha256')
    expect(marker).not.toHaveProperty('approvalSha256')
  })

  it.each(scenarios)('is idempotent for %s', (_label, state) => {
    const first = replayPlan(
      state,
      planInterruptedRunRecovery(state, INTERRUPTED_AT).events
    )
    const second = planInterruptedRunRecovery(first, INTERRUPTED_AT)
    expect(second.events).toEqual([])
    expect(second.taskIds).toEqual([])
    expect(encodeProjection(replayPlan(first, second.events)).stateSha256).toBe(
      encodeProjection(first).stateSha256
    )
  })

  it('rejects a recovery timestamp the in-place path would also reject', () => {
    expect(() => planInterruptedRunRecovery(baseState(), 'nope')).toThrow(
      TypeError
    )
    expect(() => recoverInterruptedRuns(baseState(), 'nope')).toThrow(TypeError)
  })

  it('matches established collision-sensitive recovery fixtures', () => {
    const cleanSummary = withTask({
      runStatus: 'running',
      items: [
        {
          id: 'activity_running',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Running',
          status: 'running',
          createdAt: CREATED_AT
        }
      ]
    })
    const derivedSummary = recovered(cleanSummary).tasks[0]?.items.find(
      (item) => item.kind === 'activity' && item.title === 'Run interrupted'
    )
    if (!derivedSummary) throw new Error('expected a derived summary fixture')
    const occupiedSummary = structuredClone(cleanSummary)
    occupiedSummary.tasks[0]?.items.push({
      id: derivedSummary.id,
      kind: 'message',
      runId: 'run_other',
      role: 'assistant',
      content: 'occupy the first derived item ID',
      createdAt: CREATED_AT
    })
    expectParity(occupiedSummary)

    const fallbackFixture = (runId: string): PersistedStateData =>
      withTask({
        runStatus: 'running',
        items: [
          {
            id: 'activity_terminal',
            kind: 'activity',
            runId,
            activityType: 'tool',
            title: 'Already finished',
            status: 'success',
            createdAt: CREATED_AT
          }
        ]
      })
    const cleanFallback = recovered(fallbackFixture('run_other'))
    const derivedRunId = cleanFallback.tasks[0]?.items.find(
      (item) => item.kind === 'activity' && item.title === 'Run interrupted'
    )?.runId
    if (!derivedRunId) throw new Error('expected a derived run ID fixture')
    expectParity(fallbackFixture(derivedRunId))

    const nul = String.fromCharCode(0)
    const tupleBoundary = baseState()
    const makeTask = (id: string, runId: string) => ({
      id,
      title: 'Active',
      providerId: 'provider_local',
      mode: 'agent' as const,
      runStatus: 'running' as const,
      items: [
        {
          id: `${id}_activity`,
          kind: 'activity' as const,
          runId,
          activityType: 'tool' as const,
          title: 'Running',
          status: 'running' as const,
          createdAt: CREATED_AT
        }
      ],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    })
    tupleBoundary.tasks = [
      makeTask('a', `b${nul}c`),
      makeTask(`a${nul}b`, 'c')
    ]
    expectParity(tupleBoundary)
  })

  it('matches the established remaining-capacity boundary fixture', () => {
    const state = withTask({ runStatus: 'running' })
    const task = state.tasks[0]
    if (!task) throw new Error('expected capacity task')
    task.items = Array.from(
      { length: MAX_PERSISTED_TASK_ITEMS - 3 },
      (_, index) => ({
        id: `filler_${index}`,
        kind: 'message' as const,
        role: 'user' as const,
        content: '',
        createdAt: CREATED_AT
      })
    )
    task.items.push(
      {
        id: 'capacity_running_one',
        kind: 'activity',
        runId: 'capacity_run_one',
        activityType: 'tool',
        title: 'First interrupted read',
        toolName: 'read_file',
        status: 'running',
        createdAt: CREATED_AT
      },
      {
        id: 'capacity_running_two',
        kind: 'activity',
        runId: 'capacity_run_two',
        activityType: 'tool',
        title: 'Second interrupted read',
        toolName: 'read_file',
        status: 'running',
        createdAt: CREATED_AT
      }
    )

    expectParity(state)
    const first = replayPlan(
      state,
      planInterruptedRunRecovery(state, INTERRUPTED_AT).events
    )
    expect(planInterruptedRunRecovery(first, INTERRUPTED_AT).events).toEqual([])
  })
})

/**
 * Generated coverage.
 *
 * The scenario table above names the branches; this walks their combinations,
 * which is where ordering bugs actually live — an item whose legacy marker and
 * summary interact with a continuation clear on the same task, repeated across
 * several tasks in one batch. The generator is deterministic so a failure
 * reproduces from its seed alone, and a separate assertion proves that its
 * branch dimensions do not collapse under JavaScript number arithmetic.
 */
describe('planInterruptedRunRecovery over generated states', () => {
  const statuses = ['idle', 'running', 'awaiting-approval', 'failed'] as const
  const itemStatuses = ['pending', 'running', 'success', 'error'] as const
  const toolNames = [
    undefined,
    'write_file',
    'edit_file',
    'run_command',
    'mcp__server__do',
    'read_file'
  ] as const

  function generate(seed: number): PersistedStateData {
    let value = seed >>> 0
    const next = (bound: number): number => {
      // Xorshift32 stays in exact integer arithmetic and exposes mixed high and
      // low bits. The earlier multiplication-based generator lost low bits
      // above 2^53; a direct low-bit LCG also correlated successive binary
      // choices, so both left advertised branches unvisited.
      value ^= value << 13
      value ^= value >>> 17
      value ^= value << 5
      value >>>= 0
      return value % bound
    }
    const state = baseState()
    const taskCount = 1 + next(3)
    for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
      const itemCount = next(4)
      const items = Array.from({ length: itemCount }, (_, itemIndex) => {
        const toolName = toolNames[next(toolNames.length)]
        return {
          id: `activity_${taskIndex}_${itemIndex}`,
          kind: 'activity' as const,
          runId: `run_${taskIndex}_${next(2)}`,
          activityType: 'tool' as const,
          title: 'Generated',
          status: itemStatuses[next(itemStatuses.length)]!,
          ...(toolName ? { toolName } : {}),
          ...(next(2) ? { durationMs: 10 } : {}),
          createdAt: CREATED_AT
        }
      })
      const hasRuntime = next(2) === 1
      const hasModel = next(2) === 1
      state.tasks.push({
        id: `task_${taskIndex}`,
        title: 'Generated',
        providerId: 'provider_local',
        mode: 'agent',
        runStatus: statuses[next(statuses.length)]!,
        items,
        ...(hasRuntime
          ? {
              runtimeSessions: {
                [next(2) ? 'provider_local' : 'provider_deleted']:
                  runtimeSession()
              }
            }
          : {}),
        ...(hasModel
          ? {
              modelSessions: {
                [next(2) ? 'provider_local' : 'provider_deleted']: modelSession(
                  next(2) === 1
                )
              }
            }
          : {}),
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT
      } as PersistedStateData['tasks'][number])
    }
    return state
  }

  const seeds = Array.from({ length: 200 }, (_, index) => index + 1)

  it('spans every declared generated-state branch dimension', () => {
    const runStatuses = new Set<string>()
    const observedItemStatuses = new Set<string>()
    const observedTools = new Set<string>()
    const taskCounts = new Set<number>()
    const runtimePresence = new Set<boolean>()
    const modelPresence = new Set<boolean>()
    const sessionProviders = new Set<string>()
    const checkpointPresence = new Set<boolean>()

    for (const seed of seeds) {
      const state = generate(seed)
      taskCounts.add(state.tasks.length)
      for (const task of state.tasks) {
        runStatuses.add(task.runStatus)
        runtimePresence.add(task.runtimeSessions !== undefined)
        modelPresence.add(task.modelSessions !== undefined)
        for (const providerId of Object.keys(task.runtimeSessions ?? {})) {
          sessionProviders.add(providerId)
        }
        for (const [providerId, session] of Object.entries(
          task.modelSessions ?? {}
        )) {
          sessionProviders.add(providerId)
          checkpointPresence.add(Object.hasOwn(session, 'checkpoint'))
        }
        for (const item of task.items) {
          if (item.kind !== 'activity') continue
          observedItemStatuses.add(item.status)
          observedTools.add(String(item.toolName))
        }
      }
    }

    expect([...taskCounts].sort()).toEqual([1, 2, 3])
    expect([...runStatuses].sort()).toEqual([...statuses].sort())
    expect([...observedItemStatuses].sort()).toEqual(
      [...itemStatuses].sort()
    )
    expect([...observedTools].sort()).toEqual(
      toolNames.map(String).sort()
    )
    expect([...runtimePresence].sort()).toEqual([false, true])
    expect([...modelPresence].sort()).toEqual([false, true])
    expect([...sessionProviders].sort()).toEqual([
      'provider_deleted',
      'provider_local'
    ])
    expect([...checkpointPresence].sort()).toEqual([false, true])
  })

  it.each(seeds)('matches in-place recovery for seed %i', (seed) => {
    expectParity(generate(seed))
  })

  it.each(seeds)('is idempotent for seed %i', (seed) => {
    const state = generate(seed)
    const first = replayPlan(
      state,
      planInterruptedRunRecovery(state, INTERRUPTED_AT).events
    )
    expect(planInterruptedRunRecovery(first, INTERRUPTED_AT).events).toEqual([])
  })
})
