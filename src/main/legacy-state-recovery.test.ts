import { describe, expect, it, vi } from 'vitest'
import {
  classifySharedStateFailure,
  createExclusiveLegacySourceMigrationGate,
  legacyGenerationPaths,
  LegacyStateUnrecoverableError,
  recoverInterruptedRuns,
  selectLegacyStateGeneration,
  type LegacyCandidateFailure
} from './legacy-state-recovery'
import {
  migrateStateDocument,
  PersistedStateVersionError,
  StateMigrationContractError
} from './state-migrations'
import type { PersistedStateData } from './state-schema'

const INTERRUPTED_AT = '2026-08-12T00:00:00.000Z'
const PRIMARY = '/ground/state.json'

function baseState(): PersistedStateData {
  const timestamp = '2026-08-01T00:00:00.000Z'
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
        createdAt: timestamp,
        updatedAt: timestamp
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

function stateWithRunningTask(): PersistedStateData {
  const timestamp = '2026-08-01T00:00:00.000Z'
  const state = baseState()
  state.tasks = [
    {
      id: 'task_active',
      title: 'Active task',
      providerId: 'provider_local',
      mode: 'agent',
      runStatus: 'running',
      items: [
        {
          id: 'activity_running',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Reading files',
          status: 'running',
          createdAt: timestamp
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ]
  return state
}

function reader(files: Record<string, PersistedStateData | Error>) {
  return async (filePath: string) => {
    const entry = files[filePath]
    if (entry === undefined) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    if (entry instanceof Error) throw entry
    return { state: structuredClone(entry) }
  }
}

function classify(error: unknown): LegacyCandidateFailure {
  const shared = classifySharedStateFailure(error)
  if (shared) return shared
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
  if ((error as NodeJS.ErrnoException).code === 'EACCES') return 'operational'
  return 'corrupt'
}

describe('legacy generation selection policy', () => {
  it('searches the primary and retained generations in a bounded newest-first order', () => {
    expect(legacyGenerationPaths(PRIMARY)).toEqual([
      PRIMARY,
      `${PRIMARY}.bak`,
      `${PRIMARY}.bak.2`,
      `${PRIMARY}.bak.3`
    ])
  })

  it('selects a valid primary without reading any retained generation', async () => {
    const read = vi.fn(reader({ [PRIMARY]: baseState() }))
    const selection = await selectLegacyStateGeneration(PRIMARY, {
      read,
      classify,
      interruptedAt: INTERRUPTED_AT
    })

    expect(selection.source).toBe('primary')
    expect(selection.encountered).toEqual([])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(PRIMARY)
  })

  it('falls through a corrupt primary to the newest valid retained generation', async () => {
    const selection = await selectLegacyStateGeneration(PRIMARY, {
      read: reader({
        [PRIMARY]: new Error('damaged'),
        [`${PRIMARY}.bak`]: baseState()
      }),
      classify,
      interruptedAt: INTERRUPTED_AT
    })

    expect(selection.source).toBe('retained')
    if (selection.source !== 'retained') throw new Error('unreachable')
    expect(selection.retainedIndex).toBe(0)
    expect(selection.path).toBe(`${PRIMARY}.bak`)
    expect(selection.encountered).toEqual([
      { path: PRIMARY, failure: 'corrupt' }
    ])
  })

  it('falls through a corrupt primary and corrupt newest backup to an older valid backup', async () => {
    const selection = await selectLegacyStateGeneration(PRIMARY, {
      read: reader({
        [PRIMARY]: new Error('damaged'),
        [`${PRIMARY}.bak`]: new Error('also damaged'),
        [`${PRIMARY}.bak.2`]: baseState()
      }),
      classify,
      interruptedAt: INTERRUPTED_AT
    })

    expect(selection.source).toBe('retained')
    if (selection.source !== 'retained') throw new Error('unreachable')
    expect(selection.retainedIndex).toBe(1)
    expect(selection.encountered).toEqual([
      { path: PRIMARY, failure: 'corrupt' },
      { path: `${PRIMARY}.bak`, failure: 'corrupt' }
    ])
  })

  it('reports absence when every generation is genuinely missing', async () => {
    const selection = await selectLegacyStateGeneration(PRIMARY, {
      read: reader({}),
      classify,
      interruptedAt: INTERRUPTED_AT
    })

    expect(selection.source).toBe('none')
    expect(
      selection.encountered.every((outcome) => outcome.failure === 'missing')
    ).toBe(true)
  })

  it('separates absence from unrecoverable state so corrupt-all is never a fresh install', async () => {
    await expect(
      selectLegacyStateGeneration(PRIMARY, {
        read: reader({
          [PRIMARY]: new Error('damaged'),
          [`${PRIMARY}.bak`]: new Error('damaged'),
          [`${PRIMARY}.bak.2`]: new Error('damaged'),
          [`${PRIMARY}.bak.3`]: new Error('damaged')
        }),
        classify,
        interruptedAt: INTERRUPTED_AT
      })
    ).rejects.toBeInstanceOf(LegacyStateUnrecoverableError)
  })

  it('treats a single corrupt generation among missing ones as unrecoverable, not absent', async () => {
    await expect(
      selectLegacyStateGeneration(PRIMARY, {
        read: reader({ [`${PRIMARY}.bak.2`]: new Error('damaged') }),
        classify,
        interruptedAt: INTERRUPTED_AT
      })
    ).rejects.toBeInstanceOf(LegacyStateUnrecoverableError)
  })

  it('fails closed on a future version instead of serving an older generation', async () => {
    const read = vi.fn(
      reader({
        [PRIMARY]: new PersistedStateVersionError(9, 2),
        [`${PRIMARY}.bak`]: baseState()
      })
    )
    await expect(
      selectLegacyStateGeneration(PRIMARY, {
        read,
        classify,
        interruptedAt: INTERRUPTED_AT
      })
    ).rejects.toBeInstanceOf(PersistedStateVersionError)

    expect(read).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalledWith(`${PRIMARY}.bak`)
  })

  it('fails closed on a migration-plan defect instead of inspecting a backup', async () => {
    const read = vi.fn(
      reader({
        [PRIMARY]: new StateMigrationContractError('missing step'),
        [`${PRIMARY}.bak`]: baseState()
      })
    )
    await expect(
      selectLegacyStateGeneration(PRIMARY, {
        read,
        classify,
        interruptedAt: INTERRUPTED_AT
      })
    ).rejects.toBeInstanceOf(StateMigrationContractError)

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('propagates an operational filesystem error rather than treating it as corruption', async () => {
    const read = vi.fn(
      reader({
        [PRIMARY]: Object.assign(new Error('denied'), { code: 'EACCES' }),
        [`${PRIMARY}.bak`]: baseState()
      })
    )
    await expect(
      selectLegacyStateGeneration(PRIMARY, {
        read,
        classify,
        interruptedAt: INTERRUPTED_AT
      })
    ).rejects.toMatchObject({ code: 'EACCES' })

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('normalizes an active task into interrupted manual-review state', async () => {
    const selection = await selectLegacyStateGeneration(PRIMARY, {
      read: reader({ [PRIMARY]: stateWithRunningTask() }),
      classify,
      interruptedAt: INTERRUPTED_AT
    })

    if (selection.source !== 'primary') throw new Error('unreachable')
    expect(selection.recovered).toBe(true)
    const task = selection.state.tasks[0]!
    expect(task.runStatus).toBe('failed')
    expect(task.updatedAt).toBe(INTERRUPTED_AT)
    expect(
      task.items.filter(
        (item) => item.kind === 'activity' && item.status === 'running'
      )
    ).toHaveLength(0)
    expect(
      task.items.some(
        (item) => item.kind === 'activity' && item.title === 'Run interrupted'
      )
    ).toBe(true)
  })

  it('never mutates the candidate the reader returned', async () => {
    const selection = await selectLegacyStateGeneration(PRIMARY, {
      read: reader({ [PRIMARY]: stateWithRunningTask() }),
      classify,
      interruptedAt: INTERRUPTED_AT
    })

    if (selection.source !== 'primary') throw new Error('unreachable')
    expect(selection.candidate.state.tasks[0]?.runStatus).toBe('running')
    expect(selection.state.tasks[0]?.runStatus).toBe('failed')
  })

  it('produces an identical projection for identical bytes and the same injected instant', async () => {
    const options = {
      read: reader({ [PRIMARY]: stateWithRunningTask() }),
      classify,
      interruptedAt: INTERRUPTED_AT
    }
    const first = await selectLegacyStateGeneration(PRIMARY, options)
    const second = await selectLegacyStateGeneration(PRIMARY, options)

    if (first.source === 'none' || second.source === 'none') {
      throw new Error('unreachable')
    }
    // Generated identifiers differ by design; every recovery-stamped field must
    // not, or revalidation could never compare two selections.
    expect(second.state.tasks[0]?.updatedAt).toBe(
      first.state.tasks[0]?.updatedAt
    )
    expect(
      second.state.tasks[0]?.items.map((item) => [
        item.kind,
        item.kind === 'activity' ? item.status : undefined,
        item.createdAt
      ])
    ).toEqual(
      first.state.tasks[0]?.items.map((item) => [
        item.kind,
        item.kind === 'activity' ? item.status : undefined,
        item.createdAt
      ])
    )
  })

  it('avoids a pre-seeded derived identifier while staying deterministic', async () => {
    // Derive the identifier recovery would choose on a clean document, then seed
    // that exact value so the first candidate is occupied.
    const clean = await selectLegacyStateGeneration(PRIMARY, {
      read: reader({ [PRIMARY]: stateWithRunningTask() }),
      classify,
      interruptedAt: INTERRUPTED_AT
    })
    if (clean.source !== 'primary') throw new Error('unreachable')
    const firstDerivedId = clean.state.tasks[0]!.items.find(
      (item) => item.kind === 'activity' && item.title === 'Run interrupted'
    )!.id
    expect(firstDerivedId).toMatch(/^activity_recovered_[0-9a-f]{32}$/u)

    const seeded = stateWithRunningTask()
    seeded.tasks[0]!.items.push({
      id: firstDerivedId,
      kind: 'message',
      runId: 'run_other',
      role: 'assistant',
      content: 'pre-seeded collision',
      createdAt: '2026-08-01T00:00:00.000Z'
    })

    const options = {
      read: reader({ [PRIMARY]: seeded }),
      classify,
      interruptedAt: INTERRUPTED_AT
    }
    const first = await selectLegacyStateGeneration(PRIMARY, options)
    const second = await selectLegacyStateGeneration(PRIMARY, options)
    if (first.source !== 'primary' || second.source !== 'primary') {
      throw new Error('unreachable')
    }

    const summaries = first.state.tasks[0]!.items.filter(
      (item) => item.kind === 'activity' && item.title === 'Run interrupted'
    )
    expect(summaries).toHaveLength(1)
    // The occupied candidate is stepped past deterministically.
    expect(summaries[0]!.id).not.toBe(firstDerivedId)
    expect(summaries[0]!.id).toMatch(/^activity_recovered_[0-9a-f]{32}$/u)
    // Every identifier in the document remains unique.
    const ids = first.state.tasks[0]!.items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Two recoveries of identical input remain byte-identical.
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state))
  })

  it('derives an invented fallback run id that avoids an occupied run id', async () => {
    // An active task whose only item is terminal and carries no message runId is
    // the one shape that reaches the invented-fallback branch.
    const activeTaskWithoutRunBearingItems = (runId: string) => {
      const state = baseState()
      state.tasks = [
        {
          id: 'task_fallback',
          title: 'Active task',
          providerId: 'provider_local',
          mode: 'agent',
          runStatus: 'running',
          items: [
            {
              id: 'activity_terminal',
              kind: 'activity',
              runId,
              activityType: 'tool',
              title: 'Already finished',
              status: 'success',
              createdAt: '2026-08-01T00:00:00.000Z'
            }
          ],
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z'
        }
      ]
      return state
    }

    const summaryOf = (state: PersistedStateData): { runId: string } => {
      const summary = state.tasks[0]!.items.find(
        (item) => item.kind === 'activity' && item.title === 'Run interrupted'
      )
      if (!summary || typeof summary.runId !== 'string') {
        throw new Error('expected an interruption summary bound to a run')
      }
      return { runId: summary.runId }
    }

    // Derive the fallback the clean document produces.
    const clean = await selectLegacyStateGeneration(PRIMARY, {
      read: reader({
        [PRIMARY]: activeTaskWithoutRunBearingItems('run_other')
      }),
      classify,
      interruptedAt: INTERRUPTED_AT
    })
    if (clean.source !== 'primary') throw new Error('unreachable')
    const firstDerivedRunId = summaryOf(clean.state).runId
    expect(firstDerivedRunId).toMatch(/^run_recovered_[0-9a-f]{32}$/u)

    // Seed that exact run id on a terminal item that does not become the
    // selected interrupted run, so the first derived candidate is occupied.
    const options = {
      read: reader({
        [PRIMARY]: activeTaskWithoutRunBearingItems(firstDerivedRunId)
      }),
      classify,
      interruptedAt: INTERRUPTED_AT
    }
    const first = await selectLegacyStateGeneration(PRIMARY, options)
    const second = await selectLegacyStateGeneration(PRIMARY, options)
    if (first.source !== 'primary' || second.source !== 'primary') {
      throw new Error('unreachable')
    }

    const summaryRunId = summaryOf(first.state).runId
    expect(summaryRunId).toMatch(/^run_recovered_[0-9a-f]{32}$/u)
    expect(summaryRunId).not.toBe(firstDerivedRunId)

    const runIds = first.state.tasks[0]!.items.map((item) => item.runId)
    expect(new Set(runIds).size).toBe(runIds.length)
    expect(runIds).toContain(firstDerivedRunId)

    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state))
  })


  it('encodes hash inputs unambiguously across identifier boundaries', async () => {
    // These two tuples collapse to one digest input under the previous
    // `parts.join(NUL)` encoding:
    //   ("a", "b<NUL>c")  -> a<NUL>b<NUL>c<NUL>run-interrupted<NUL>ts
    //   ("a<NUL>b", "c")  -> a<NUL>b<NUL>c<NUL>run-interrupted<NUL>ts
    // Persisted identifiers are arbitrary bounded strings, so a NUL is
    // representable and the ambiguity is reachable from untrusted state.
    const NUL = String.fromCharCode(0)
    const timestamp = '2026-08-01T00:00:00.000Z'
    const state = baseState()
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
          createdAt: timestamp
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    })
    state.tasks = [makeTask('a', `b${NUL}c`), makeTask(`a${NUL}b`, 'c')]

    const selection = await selectLegacyStateGeneration(PRIMARY, {
      read: reader({ [PRIMARY]: state }),
      classify,
      interruptedAt: INTERRUPTED_AT
    })
    if (selection.source !== 'primary') throw new Error('unreachable')

    const summaryIds = selection.state.tasks.flatMap((task) =>
      task.items
        .filter(
          (item) => item.kind === 'activity' && item.title === 'Run interrupted'
        )
        .map((item) => item.id)
    )
    // The occupied set is per task, so it cannot mask a cross-task collision:
    // only the encoding keeps these two derived identifiers apart.
    expect(summaryIds).toHaveLength(2)
    expect(new Set(summaryIds).size).toBe(2)
  })


  it.each([
    ['a locale string', 'Aug 13 2026'],
    ['a timezone-less timestamp', '2026-08-13T00:00:00'],
    ['a date-only value', '2026-08-13'],
    ['an impossible calendar date', '2026-02-30T00:00:00.000Z'],
    ['an out-of-range month', '2026-13-01T00:00:00.000Z'],
    ['trailing content', '2026-08-13T00:00:00.000Zx'],
    ['leading whitespace', ' 2026-08-13T00:00:00.000Z'],
    ['an unbounded value', `2026-08-13T00:00:00.000Z${'0'.repeat(64)}`],
    ['an empty string', '']
  ])('rejects %s as a recovery timestamp', async (_label, value) => {
    await expect(
      selectLegacyStateGeneration(PRIMARY, {
        read: reader({ [PRIMARY]: baseState() }),
        classify,
        interruptedAt: value
      })
    ).rejects.toBeInstanceOf(TypeError)
    expect(() => recoverInterruptedRuns(baseState(), value)).toThrow(TypeError)
  })

  it.each([
    ['UTC with milliseconds', '2026-08-13T00:00:00.000Z'],
    ['UTC without milliseconds', '2026-08-13T00:00:00Z'],
    ['an explicit positive offset', '2026-08-13T00:00:00+02:00'],
    ['an explicit negative offset', '2026-08-13T00:00:00-05:30']
  ])('accepts %s', async (_label, value) => {
    await expect(
      selectLegacyStateGeneration(PRIMARY, {
        read: reader({ [PRIMARY]: baseState() }),
        classify,
        interruptedAt: value
      })
    ).resolves.toMatchObject({ source: 'primary' })
  })

  it('rejects an unbounded or invalid recovery timestamp', async () => {
    await expect(
      selectLegacyStateGeneration(PRIMARY, {
        read: reader({ [PRIMARY]: baseState() }),
        classify,
        interruptedAt: 'not-a-timestamp'
      })
    ).rejects.toBeInstanceOf(TypeError)
    expect(() =>
      recoverInterruptedRuns(baseState(), 'x'.repeat(64))
    ).toThrow(TypeError)
  })
})

describe('persisted state migration evidence', () => {
  it('reports a future document version as version evidence, not corruption', () => {
    expect(() =>
      migrateStateDocument(
        { version: 99 },
        { currentVersion: 2, migrations: new Map() }
      )
    ).toThrow(PersistedStateVersionError)
  })

  it('reports a missing registered migration as a plan defect', () => {
    expect(() =>
      migrateStateDocument(
        { version: 1 },
        { currentVersion: 2, migrations: new Map() }
      )
    ).toThrow(StateMigrationContractError)
  })

  it('reports a migration producing the wrong next version as a plan defect', () => {
    expect(() =>
      migrateStateDocument(
        { version: 1 },
        {
          currentVersion: 2,
          migrations: new Map([[1, () => ({ version: 5 })]])
        }
      )
    ).toThrow(StateMigrationContractError)
  })

  it('keeps invalid version syntax and non-object documents as corruption', () => {
    for (const value of [{ version: 'two' }, { version: 0 }, []]) {
      const error = (() => {
        try {
          migrateStateDocument(value, {
            currentVersion: 2,
            migrations: new Map()
          })
        } catch (thrown) {
          return thrown
        }
        return undefined
      })()
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(PersistedStateVersionError)
      expect(error).not.toBeInstanceOf(StateMigrationContractError)
    }
  })
})

describe('legacy source migration gate', () => {
  it('prevents a concurrent source mutation from entering the exclusive scope', async () => {
    const gate = createExclusiveLegacySourceMigrationGate()
    const observed: string[] = []
    let releaseMigration: (() => void) | undefined
    const migrationEntered = new Promise<void>((resolve) => {
      releaseMigration = resolve
    })

    const migration = gate.withExclusiveMigration(async () => {
      observed.push('migration:start')
      await migrationEntered
      observed.push('migration:end')
    })
    const competingWriter = gate.withExclusiveMigration(async () => {
      observed.push('writer')
    })

    releaseMigration?.()
    await Promise.all([migration, competingWriter])

    expect(observed).toEqual([
      'migration:start',
      'migration:end',
      'writer'
    ])
  })

  it('reopens after a pre-publication failure so the migration stays retryable', async () => {
    const gate = createExclusiveLegacySourceMigrationGate()
    await expect(
      gate.withExclusiveMigration(async () => {
        throw new Error('failed before publication')
      })
    ).rejects.toThrow(/before publication/)

    expect(gate.isHeldForProcessExit()).toBe(false)
    await expect(
      gate.withExclusiveMigration(async () => 'retried')
    ).resolves.toBe('retried')
  })

  it('stays held after publication so no later JSON write can reopen it', async () => {
    const gate = createExclusiveLegacySourceMigrationGate()
    await gate.withExclusiveMigration(async (holdForProcessExit) => {
      holdForProcessExit()
    })

    expect(gate.isHeldForProcessExit()).toBe(true)
    await expect(
      gate.withExclusiveMigration(async () => 'must not run')
    ).rejects.toThrow(/held until this process exits/)
  })
})
