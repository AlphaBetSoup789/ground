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
