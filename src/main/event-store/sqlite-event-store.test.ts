import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import {
  copyFile,
  readFile,
  readdir,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedStateData } from '../state-schema'
import {
  encodeCanonicalJson,
  encodeProjection,
  EventStoreConflictError,
  EventStoreCorruptionError,
  EventStorePersistenceUncertainError,
  EventStoreRollbackError,
  EventStoreSealedError,
  EventStoreVersionError,
  fileHeadWitnessStore,
  hashLedgerEventRecord,
  sha256,
  SqliteEventStore,
  type EventStoreFaultPoint,
  type HeadWitness,
  type LegacyStateBootstrappedEvent
} from './index'
import { witnessPublicationLockPath } from './writer-lock'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ground-sqlite-ledger-')
  )
  temporaryDirectories.push(directory)
  return directory
}

function initialState(
  sidebarCollapsed = false
): PersistedStateData {
  const timestamp = '2026-07-30T20:00:00.000Z'
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
      sidebarCollapsed
    },
    pendingSecretDeletes: ['provider:opaque-cleanup-reference']
  }
}

function bootstrap(
  state = initialState()
): LegacyStateBootstrappedEvent {
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

function backupSizedState(): PersistedStateData {
  const state = initialState(true)
  const timestamp = '2026-07-30T20:00:00.000Z'
  state.tasks = [
    {
      id: 'task_backup',
      title: 'Backup permission probe',
      providerId: 'provider_local',
      mode: 'ask',
      runStatus: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      items: [
        {
          id: 'message_backup',
          kind: 'message',
          role: 'user',
          content: 'private-backup-probe'.repeat(75_000),
          createdAt: timestamp
        }
      ]
    }
  ]
  state.settings.selectedTaskId = 'task_backup'
  return state
}

function deterministicDependencies(
  fault?: (point: EventStoreFaultPoint) => void
) {
  let id = 0
  let instant = 0
  return {
    createId: () => `test-id-${++id}`,
    now: () =>
      new Date(
        Date.UTC(2026, 6, 30, 20, 0, instant++)
      ).toISOString(),
    fault
  }
}

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('SQLite event store', () => {
  it('keeps public create unselected until a verified bootstrap can be published and retries a pre-link fault', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    let finalPathWasAbsent = false
    await expect(
      SqliteEventStore.create({
        databasePath,
        bootstrap: bootstrap(),
        dependencies: {
          ...deterministicDependencies(),
          fault: (point) => {
            if (point !== 'after-create-witness-published') return
            try {
              lstatSync(databasePath)
            } catch (error) {
              finalPathWasAbsent =
                (error as NodeJS.ErrnoException).code === 'ENOENT'
            }
            throw new Error('injected before final database link')
          }
        }
      })
    ).rejects.toThrow(/injected before final database link/)
    expect(finalPathWasAbsent).toBe(true)
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })

    const retried = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: deterministicDependencies()
    })
    expect(retried.getHead().sequence).toBe(1)
    expect(retried.getRecords()).toHaveLength(1)
    await retried.close()
  })

  it('reports uncertainty only after a fully verified database is selected by public create', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    let selectedEventCount = 0
    await expect(
      SqliteEventStore.create({
        databasePath,
        bootstrap: bootstrap(),
        dependencies: {
          ...deterministicDependencies(),
          fault: (point) => {
            if (point !== 'after-create-database-published') return
            const selected = new DatabaseSync(databasePath)
            try {
              selectedEventCount = Number(
                (
                  selected
                    .prepare('SELECT count(*) AS count FROM events')
                    .get() as { count: number }
                ).count
              )
            } finally {
              selected.close()
            }
            throw new Error('injected after final database link')
          }
        }
      })
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    expect(selectedEventCount).toBe(1)

    const selected = await SqliteEventStore.open({
      databasePath,
      integrityCheck: 'full'
    })
    expect(selected.getHead().sequence).toBe(1)
    await selected.close()
    await expect(
      SqliteEventStore.create({
        databasePath,
        bootstrap: bootstrap()
      })
    ).rejects.toBeInstanceOf(EventStoreConflictError)
  })

  it('reports a post-selection create-cleanup failure as persistence uncertainty without leaking the selected handle', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    await expect(
      SqliteEventStore.create({
        databasePath,
        bootstrap: bootstrap(),
        dependencies: {
          ...deterministicDependencies(),
          fault: (point) => {
            if (point === 'before-create-temporary-cleanup') {
              throw new Error('injected create cleanup failure')
            }
          }
        }
      })
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)

    const selected = await SqliteEventStore.open({
      databasePath,
      integrityCheck: 'full'
    })
    expect(selected.getHead().sequence).toBe(1)
    await selected.close()
  })

  it('atomically appends semantic batches and reopens deterministic state', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: deterministicDependencies()
    })
    const firstHead = store.getHead()
    expect(firstHead.sequence).toBe(1)
    expect(store.getRecords()).toHaveLength(1)
    expect(store.getMigrationProvenance()).toMatchObject({
      sourceFormat: 'ground-json',
      sourceStateVersion: 2
    })

    const result = await store.appendEventBatch({
      expectedHead: firstHead,
      transactionId: 'settings-transaction',
      events: [
        {
          kind: 'settings.sidebar-collapsed-set',
          collapsed: true
        },
        {
          kind: 'settings.sidebar-collapsed-set',
          collapsed: false
        }
      ]
    })
    expect(result.head.sequence).toBe(3)
    expect(result.records.map((record) => record.transactionOrdinal)).toEqual([
      1, 2
    ])
    expect(result.records.every((record) => record.transactionSize === 2)).toBe(
      true
    )
    expect(result.projection.settings.sidebarCollapsed).toBe(false)
    expect(result.records[1]?.previousEventHash).toBe(
      result.records[0]?.eventHash
    )
    await store.close()

    const reopened = await SqliteEventStore.open({ databasePath })
    expect(reopened.getHead()).toEqual(result.head)
    expect(reopened.getProjection()).toEqual(result.projection)
    expect(
      encodeProjection(reopened.getProjection()).stateJson
    ).toBe(encodeProjection(result.projection).stateJson)
    await reopened.close()
  })

  it('serializes independent writers through database commit and witness CAS', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const publishEntered = deferred()
    const releasePublish = deferred()
    let pausePublication = false
    const delayedWitnessStore = {
      read: (filePath: string) =>
        fileHeadWitnessStore.read(filePath),
      publish: async (
        filePath: string,
        witness: HeadWitness,
        options?: Parameters<
          typeof fileHeadWitnessStore.publish
        >[2]
      ) => {
        if (pausePublication && witness.sequence === 2) {
          publishEntered.resolve()
          await releasePublish.promise
        }
        return fileHeadWitnessStore.publish(
          filePath,
          witness,
          options
        )
      }
    }
    const first = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: {
        ...deterministicDependencies(),
        witnessStore: delayedWitnessStore
      }
    })
    const second = await SqliteEventStore.open({ databasePath })
    const sharedHead = first.getHead()
    pausePublication = true

    const firstAppend = first.appendEventBatch({
      expectedHead: sharedHead,
      transactionId: 'first-independent-writer',
      events: [
        {
          kind: 'settings.sidebar-collapsed-set',
          collapsed: true
        }
      ]
    })
    await publishEntered.promise

    let secondSettled = false
    const secondAppend = second
      .appendEventBatch({
        expectedHead: sharedHead,
        transactionId: 'second-independent-writer',
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: false
          }
        ]
      })
      .then(
        (value) => {
          secondSettled = true
          return { value }
        },
        (error: unknown) => {
          secondSettled = true
          return { error }
        }
      )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(secondSettled).toBe(false)

    releasePublish.resolve()
    const published = await firstAppend
    expect(published.head.sequence).toBe(2)
    const secondResult = await secondAppend
    expect(secondResult).toMatchObject({
      error: expect.any(EventStoreConflictError)
    })
    const witness = await fileHeadWitnessStore.read(
      `${databasePath}.head.json`
    )
    expect(witness?.sequence).toBe(2)
    await first.close()
    await second.close()
  })

  it('waits for another process and recovers its writer lock after process death', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    const coordinatorPath = `${databasePath}.writer-lock.sqlite`
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { DatabaseSync } from 'node:sqlite'
          const database = new DatabaseSync(process.argv[1], { timeout: 0 })
          database.exec('BEGIN IMMEDIATE')
          process.stdout.write('locked\\n')
          process.stdin.once('data', () => {
            database.exec('COMMIT')
            database.close()
            process.exit(0)
          })
        `,
        coordinatorPath
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    try {
      const [locked] = (await once(child.stdout!, 'data')) as [Buffer]
      expect(locked.toString('utf8')).toContain('locked')

      let settled = false
      const append = store
        .appendEventBatch({
          expectedHead: store.getHead(),
          events: [
            {
              kind: 'settings.sidebar-collapsed-set',
              collapsed: true
            }
          ]
        })
        .then((result) => {
          settled = true
          return result
        })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(settled).toBe(false)

      const childExited = once(child, 'exit')
      child.kill('SIGKILL')
      await childExited
      await expect(append).resolves.toMatchObject({
        head: { sequence: 2 }
      })
    } finally {
      child.kill()
      await store.close()
    }
  })

  it('rejects database-to-coordinator namespace collisions before touching the active ledger', async () => {
    const directory = await temporaryDirectory()
    const destinationDatabasePath = path.join(directory, 'x.sqlite')
    const sourceDatabasePath =
      `${destinationDatabasePath}.writer-lock.sqlite`
    const store = await SqliteEventStore.create({
      databasePath: sourceDatabasePath,
      bootstrap: bootstrap()
    })
    const before = new DatabaseSync(sourceDatabasePath)
    let applicationId: number
    try {
      applicationId = Number(
        Object.values(
          before.prepare('PRAGMA application_id').get() ?? {}
        )[0]
      )
    } finally {
      before.close()
    }

    await expect(
      store.createVerifiedBackup(destinationDatabasePath)
    ).rejects.toThrow(/reserved event-store file namespace/)
    const after = new DatabaseSync(sourceDatabasePath)
    try {
      expect(
        Number(
          Object.values(
            after.prepare('PRAGMA application_id').get() ?? {}
          )[0]
        )
      ).toBe(applicationId)
      expect(
        Object.values(
          after.prepare('PRAGMA journal_mode').get() ?? {}
        )[0]
      ).toBe('wal')
      expect(
        (
          after
            .prepare('SELECT count(*) AS count FROM events')
            .get() as { count: number }
        ).count
      ).toBe(1)
    } finally {
      after.close()
    }
    await store.close()
  })

  it('rejects a witness that collides with the writer coordinator journal before lock acquisition', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const coordinatorPath = `${databasePath}.writer-lock.sqlite`
    const witnessPath = `${coordinatorPath}-journal`

    await expect(
      SqliteEventStore.create({
        databasePath,
        witnessPath,
        bootstrap: bootstrap()
      })
    ).rejects.toThrow(/reserved event-store file namespace/)
    for (const untouchedPath of [
      databasePath,
      coordinatorPath,
      witnessPath
    ]) {
      await expect(lstat(untouchedPath)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  })

  it('reserves every SQLite data sidecar from use as the create witness', async () => {
    const directory = await temporaryDirectory()
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const databasePath = path.join(
        directory,
        `ground-${suffix.slice(1)}.sqlite`
      )
      await expect(
        SqliteEventStore.create({
          databasePath,
          witnessPath: `${databasePath}${suffix}`,
          bootstrap: bootstrap()
        })
      ).rejects.toThrow(/reserved event-store file namespace/)
      await expect(lstat(databasePath)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  })

  it('rejects a pre-existing SQLite sidecar before selecting a new database', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const staleWalPath = `${databasePath}-wal`
    writeFileSync(staleWalPath, 'occupied sidecar', { mode: 0o600 })

    await expect(
      SqliteEventStore.create({
        databasePath,
        bootstrap: bootstrap()
      })
    ).rejects.toThrow(/sidecar exists without its database/)
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(staleWalPath, 'utf8')).toBe(
      'occupied sidecar'
    )
  })

  it.each(['writer', 'witness'] as const)(
    'rejects an orphaned %s coordination journal before creating its coordinator database',
    async (coordinator) => {
      const directory = await temporaryDirectory()
      const databasePath = path.join(
        directory,
        `${coordinator}.sqlite`
      )
      const witnessPath = `${databasePath}.head.json`
      const coordinationPath =
        coordinator === 'writer'
          ? `${databasePath}.writer-lock.sqlite`
          : `${witnessPath}.publication-lock.sqlite`
      const orphanedJournalPath = `${coordinationPath}-journal`
      writeFileSync(orphanedJournalPath, 'occupied journal', {
        mode: 0o600
      })

      await expect(
        SqliteEventStore.create({
          databasePath,
          witnessPath,
          bootstrap: bootstrap()
        })
      ).rejects.toThrow(/sidecar exists without its database/)
      await expect(lstat(databasePath)).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(lstat(coordinationPath)).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(await readFile(orphanedJournalPath, 'utf8')).toBe(
        'occupied journal'
      )
    }
  )

  it.runIf(process.platform !== 'win32')(
    'canonicalizes symlinked parent aliases before validating SQLite sidecars',
    async () => {
      const directory = await temporaryDirectory()
      const canonicalDirectory = path.join(directory, 'canonical')
      const aliasDirectory = path.join(directory, 'alias')
      await mkdir(canonicalDirectory, { mode: 0o700 })
      await symlink(canonicalDirectory, aliasDirectory, 'dir')
      const databasePath = path.join(
        canonicalDirectory,
        'ground.sqlite'
      )

      await expect(
        SqliteEventStore.create({
          databasePath,
          witnessPath: path.join(
            aliasDirectory,
            'ground.sqlite-wal'
          ),
          bootstrap: bootstrap()
        })
      ).rejects.toThrow(/reserved event-store file namespace/)
      await expect(lstat(databasePath)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  )

  it.runIf(
    process.platform === 'darwin' || process.platform === 'win32'
  )(
    'normalizes case aliases before validating SQLite sidecars',
    async () => {
      const directory = await temporaryDirectory()
      const databasePath = path.join(directory, 'Ground.sqlite')
      await expect(
        SqliteEventStore.create({
          databasePath,
          witnessPath: path.join(
            directory,
            'ground.sqlite-wal'
          ),
          bootstrap: bootstrap()
        })
      ).rejects.toThrow(/reserved event-store file namespace/)
    }
  )

  it('refuses an existing foreign coordination database without rewriting its identity', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const coordinatorPath = `${databasePath}.writer-lock.sqlite`
    const foreign = new DatabaseSync(coordinatorPath)
    try {
      foreign.exec(`
        PRAGMA application_id = 424242;
        CREATE TABLE foreign_lock (value TEXT);
      `)
    } finally {
      foreign.close()
    }

    await expect(
      SqliteEventStore.create({
        databasePath,
        bootstrap: bootstrap()
      })
    ).rejects.toThrow(/writer-lock acquisition failed/)
    const unchanged = new DatabaseSync(coordinatorPath)
    try {
      expect(
        Number(
          Object.values(
            unchanged.prepare('PRAGMA application_id').get() ?? {}
          )[0]
        )
      ).toBe(424242)
      expect(
        unchanged
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table'"
          )
          .all()
      ).toEqual([{ name: 'foreign_lock' }])
    } finally {
      unchanged.close()
    }
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('serializes interleaved witness repairs so one repair cannot regress another', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    let injectAfterCommit = false
    const writer = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: deterministicDependencies((point) => {
        if (injectAfterCommit && point === 'after-commit') {
          throw new Error('leave witness behind')
        }
      })
    })
    injectAfterCommit = true
    await expect(
      writer.appendEventBatch({
        expectedHead: writer.getHead(),
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: true
          }
        ]
      })
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    await writer.close()

    const repairEntered = deferred()
    const releaseRepair = deferred()
    let repairPublications = 0
    const delayedRepairStore = {
      read: (filePath: string) =>
        fileHeadWitnessStore.read(filePath),
      publish: async (
        filePath: string,
        witness: HeadWitness,
        options?: Parameters<
          typeof fileHeadWitnessStore.publish
        >[2]
      ) => {
        repairPublications += 1
        repairEntered.resolve()
        await releaseRepair.promise
        return fileHeadWitnessStore.publish(
          filePath,
          witness,
          options
        )
      }
    }
    const firstOpen = SqliteEventStore.open({
      databasePath,
      dependencies: { witnessStore: delayedRepairStore }
    })
    await repairEntered.promise

    let secondSettled = false
    const secondOpen = SqliteEventStore.open({ databasePath }).then(
      (store) => {
        secondSettled = true
        return store
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(secondSettled).toBe(false)
    releaseRepair.resolve()

    const [firstRepaired, secondRepaired] = await Promise.all([
      firstOpen,
      secondOpen
    ])
    expect(repairPublications).toBe(1)
    expect(firstRepaired.getHead().sequence).toBe(2)
    expect(secondRepaired.getHead().sequence).toBe(2)
    expect(
      (
        await fileHeadWitnessStore.read(
          `${databasePath}.head.json`
        )
      )?.sequence
    ).toBe(2)
    await firstRepaired.close()
    await secondRepaired.close()
  })

  it('rejects stale heads without publishing another event', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    await expect(
      store.appendEventBatch({
        expectedHead: {
          sequence: 0,
          eventHash: '0'.repeat(64)
        },
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: true
          }
        ]
      })
    ).rejects.toBeInstanceOf(EventStoreConflictError)
    expect(store.getHead().sequence).toBe(1)
    expect(store.getRecords()).toHaveLength(1)
    await store.close()
  })

  it('rejects reused transaction IDs before they can create an unreplayable ledger', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    const first = await store.appendEventBatch({
      expectedHead: store.getHead(),
      transactionId: 'unique-transaction',
      events: [
        {
          kind: 'settings.sidebar-collapsed-set',
          collapsed: true
        }
      ]
    })
    await expect(
      store.appendEventBatch({
        expectedHead: first.head,
        transactionId: 'unique-transaction',
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: false
          }
        ]
      })
    ).rejects.toBeInstanceOf(EventStoreConflictError)
    expect(store.getHead()).toEqual(first.head)
    await store.close()
  })

  it('rolls back definite pre-commit faults and remains writable', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    let armed = false
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: deterministicDependencies((point) => {
        if (armed && point === 'before-commit') {
          throw new Error('injected before COMMIT')
        }
      })
    })
    const firstHead = store.getHead()
    armed = true
    await expect(
      store.appendEventBatch({
        expectedHead: firstHead,
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: true
          }
        ]
      })
    ).rejects.toThrow(/injected before COMMIT/)
    expect(store.isSealed()).toBe(false)
    expect(store.getHead()).toEqual(firstHead)

    armed = false
    await expect(
      store.appendEventBatch({
        expectedHead: firstHead,
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: true
          }
        ]
      })
    ).resolves.toMatchObject({
      head: { sequence: 2 }
    })
    await store.close()
  })

  it('seals after a committed pre-witness fault and repairs a valid behind witness on reopen', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    let armed = false
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: deterministicDependencies((point) => {
        if (armed && point === 'after-commit') {
          throw new Error('injected after COMMIT')
        }
      })
    })
    const firstHead = store.getHead()
    armed = true
    await expect(
      store.appendEventBatch({
        expectedHead: firstHead,
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: true
          }
        ]
      })
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    expect(store.isSealed()).toBe(true)
    await expect(
      store.appendEventBatch({
        expectedHead: firstHead,
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: false
          }
        ]
      })
    ).rejects.toBeInstanceOf(EventStoreSealedError)
    await store.close()

    const reopened = await SqliteEventStore.open({ databasePath })
    expect(reopened.getHead().sequence).toBe(2)
    expect(reopened.getProjection().settings.sidebarCollapsed).toBe(true)
    const repairedWitness = await fileHeadWitnessStore.read(
      `${databasePath}.head.json`
    )
    expect(repairedWitness?.sequence).toBe(2)
    await reopened.close()
  })

  it('seals when completion after witness rename is ambiguous and reopens at that witnessed head', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    let armed = false
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: deterministicDependencies((point) => {
        if (armed && point === 'after-witness-rename') {
          throw new Error('injected after witness rename')
        }
      })
    })
    const firstHead = store.getHead()
    armed = true
    await expect(
      store.appendEventBatch({
        expectedHead: firstHead,
        events: [
          {
            kind: 'settings.sidebar-collapsed-set',
            collapsed: true
          }
        ]
      })
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    expect(store.isSealed()).toBe(true)
    await store.close()

    const reopened = await SqliteEventStore.open({ databasePath })
    expect(reopened.getHead().sequence).toBe(2)
    expect(reopened.getProjection().settings.sidebarCollapsed).toBe(true)
    await reopened.close()
  })

  it('blocks a witness that is ahead of the selected database', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const witnessPath = `${databasePath}.head.json`
    const store = await SqliteEventStore.create({
      databasePath,
      witnessPath,
      bootstrap: bootstrap()
    })
    const metadata = store.getMetadata()
    const head = store.getHead()
    await store.close()

    await fileHeadWitnessStore.publish(witnessPath, {
      witnessVersion: 1,
      databaseId: metadata.databaseId,
      recoveryEpoch: metadata.recoveryEpoch,
      sequence: head.sequence + 1,
      eventHash: sha256('rolled-forward-head'),
      transactionId: 'future-transaction',
      publishedAt: '2026-07-30T21:00:00.000Z'
    })
    await expect(
      SqliteEventStore.open({ databasePath, witnessPath })
    ).rejects.toBeInstanceOf(EventStoreRollbackError)
  })

  it('detects an actual database-file rollback behind a later witnessed head', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const oldDatabasePath = path.join(directory, 'old.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    await store.createVerifiedBackup(oldDatabasePath)
    await store.appendEventBatch({
      expectedHead: store.getHead(),
      events: [
        {
          kind: 'settings.sidebar-collapsed-set',
          collapsed: true
        }
      ]
    })
    expect(store.getHead().sequence).toBe(2)
    await store.close()

    await copyFile(oldDatabasePath, databasePath)
    await expect(
      SqliteEventStore.open({ databasePath })
    ).rejects.toBeInstanceOf(EventStoreRollbackError)
  })

  it('enforces append-only events and immutable checkpoints in SQLite', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    await store.close()

    const database = new DatabaseSync(databasePath)
    try {
      expect(() =>
        database.exec(
          "UPDATE events SET kind = 'settings.sidebar-collapsed-set' WHERE sequence = 1"
        )
      ).toThrow(/append-only/)
      expect(() =>
        database.exec('DELETE FROM events WHERE sequence = 1')
      ).toThrow(/append-only/)
      expect(() =>
        database.exec('DELETE FROM checkpoints WHERE through_sequence = 1')
      ).toThrow(/immutable/)
    } finally {
      database.close()
    }
  })

  it.each([
    {
      label: 'same-name malicious no-op trigger',
      mutate: (database: DatabaseSync) =>
        database.exec(`
          DROP TRIGGER events_are_append_only_update;
          CREATE TRIGGER events_are_append_only_update
          BEFORE UPDATE ON events BEGIN
            SELECT 1;
          END;
        `)
    },
    {
      label: 'table constraint shape',
      mutate: (database: DatabaseSync) =>
        database.exec(
          'ALTER TABLE ledger_head ADD COLUMN unverified TEXT'
        )
    },
    {
      label: 'unexpected index',
      mutate: (database: DatabaseSync) =>
        database.exec(
          'CREATE INDEX unverified_event_kind ON events(kind)'
        )
    },
    {
      label: 'unexpected view',
      mutate: (database: DatabaseSync) =>
        database.exec(
          'CREATE VIEW unverified_projection AS SELECT state_json FROM materialized_state'
        )
    }
  ])('rejects substituted sqlite_schema: $label', async ({ mutate }) => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    await store.close()

    const database = new DatabaseSync(databasePath)
    try {
      mutate(database)
    } finally {
      database.close()
    }
    await expect(
      SqliteEventStore.open({ databasePath })
    ).rejects.toMatchObject({
      name: EventStoreCorruptionError.name,
      message: expect.stringContaining('schema fingerprint mismatch')
    })
  })

  it('fails closed on a durable sequence gap', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    const head = store.getHead()
    await store.close()

    const payloadJson = '{"collapsed":true}'
    const withoutHash = {
      eventSchemaVersion: 1 as const,
      sequence: 3,
      transactionId: 'gap-transaction',
      transactionOrdinal: 1,
      transactionSize: 1,
      kind: 'settings.sidebar-collapsed-set' as const,
      entityId: 'settings',
      recordedAt: '2026-07-30T22:00:00.000Z',
      previousEventHash: head.eventHash,
      payloadJson
    }
    const database = new DatabaseSync(databasePath)
    try {
      database
        .prepare(`
          INSERT INTO events (
            sequence,
            event_schema_version,
            transaction_id,
            transaction_ordinal,
            transaction_size,
            kind,
            entity_id,
            recorded_at,
            previous_event_hash,
            payload_json,
            event_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          withoutHash.sequence,
          withoutHash.eventSchemaVersion,
          withoutHash.transactionId,
          withoutHash.transactionOrdinal,
          withoutHash.transactionSize,
          withoutHash.kind,
          withoutHash.entityId,
          withoutHash.recordedAt,
          withoutHash.previousEventHash,
          withoutHash.payloadJson,
          hashLedgerEventRecord(withoutHash)
        )
    } finally {
      database.close()
    }
    await expect(
      SqliteEventStore.open({ databasePath })
    ).rejects.toThrow(/sequence gap/)
  })

  it.each([
    {
      boundary: 'database' as const,
      mutate: (database: DatabaseSync) =>
        database.exec('PRAGMA user_version = 2')
    },
    {
      boundary: 'event' as const,
      mutate: (database: DatabaseSync) =>
        database.exec(
          'UPDATE ledger_metadata SET event_schema_version = 2 WHERE singleton = 1'
        )
    },
    {
      boundary: 'reducer' as const,
      mutate: (database: DatabaseSync) =>
        database.exec(
          'UPDATE ledger_metadata SET reducer_version = 2 WHERE singleton = 1'
        )
    },
    {
      boundary: 'projection' as const,
      mutate: (database: DatabaseSync) =>
        database.exec(
          'UPDATE ledger_metadata SET projection_schema_version = 2 WHERE singleton = 1'
        )
    }
  ])('fails closed on an unsupported $boundary version', async ({
    boundary,
    mutate
  }) => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, `${boundary}.sqlite`)
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    await store.close()
    const database = new DatabaseSync(databasePath)
    try {
      mutate(database)
    } finally {
      database.close()
    }

    let error: unknown
    try {
      await SqliteEventStore.open({ databasePath })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EventStoreVersionError)
    expect((error as EventStoreVersionError).boundary).toBe(boundary)
  })

  it('creates a private verified node:sqlite backup that reopens independently', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const backupPath = path.join(directory, 'retained-1.sqlite')
    let privateProgressObservations = 0
    let privateStagingObservations = 0
    const privateSidecarObservations = new Set<string>()
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(backupSizedState()),
      dependencies: {
        onBackupProgress: (temporaryDatabasePath) => {
          const staging = lstatSync(
            path.dirname(temporaryDatabasePath)
          )
          expect(staging.isDirectory()).toBe(true)
          const details = lstatSync(temporaryDatabasePath)
          expect(details.isFile()).toBe(true)
          if (process.platform !== 'win32') {
            expect(staging.mode & 0o777).toBe(0o700)
            expect(details.mode & 0o777).toBe(0o600)
          }
          privateStagingObservations += 1
          for (const suffix of ['-journal', '-wal', '-shm']) {
            try {
              const sidecar = lstatSync(
                `${temporaryDatabasePath}${suffix}`
              )
              expect(sidecar.isFile()).toBe(true)
              if (process.platform !== 'win32') {
                expect(sidecar.mode & 0o777).toBe(0o600)
              }
              privateSidecarObservations.add(suffix)
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code !== 'ENOENT'
              ) {
                throw error
              }
            }
          }
          privateProgressObservations += 1
        }
      }
    })
    await store.createVerifiedBackup(backupPath)
    expect(privateProgressObservations).toBeGreaterThan(0)
    expect(privateStagingObservations).toBe(
      privateProgressObservations
    )
    expect(privateSidecarObservations).toContain('-journal')
    expect(
      (await readdir(directory)).some((entry) =>
        entry.endsWith('.backup-stage')
      )
    ).toBe(false)

    const [databaseMode, witnessMode] = await Promise.all([
      lstat(backupPath),
      lstat(`${backupPath}.head.json`)
    ])
    if (process.platform !== 'win32') {
      expect(databaseMode.mode & 0o777).toBe(0o600)
      expect(witnessMode.mode & 0o777).toBe(0o600)
    }
    const backup = await SqliteEventStore.open({
      databasePath: backupPath,
      integrityCheck: 'full'
    })
    expect(backup.getHead()).toEqual(store.getHead())
    expect(backup.getProjection()).toEqual(store.getProjection())
    await backup.close()
    await store.close()
  })

  it('reports a post-selection backup-cleanup failure as persistence uncertainty and removes its staging directory', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const backupPath = path.join(directory, 'cleanup-backup.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: {
        ...deterministicDependencies(),
        fault: (point) => {
          if (point === 'before-backup-temporary-cleanup') {
            throw new Error('injected backup cleanup failure')
          }
        }
      }
    })

    await expect(
      store.createVerifiedBackup(backupPath)
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    expect(
      (await readdir(directory)).some((entry) =>
        entry.endsWith('.backup-stage')
      )
    ).toBe(false)
    const selected = await SqliteEventStore.open({
      databasePath: backupPath,
      integrityCheck: 'full'
    })
    expect(selected.getHead()).toEqual(store.getHead())
    await selected.close()
    await store.close()
  })

  it('reports uncertainty when backup selection succeeds but final durability does not complete', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const backupPath = path.join(directory, 'selected-backup.sqlite')
    let armed = false
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: deterministicDependencies((point) => {
        if (armed && point === 'after-backup-database-published') {
          throw new Error('injected after backup selection')
        }
      })
    })
    armed = true
    await expect(
      store.createVerifiedBackup(backupPath)
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    expect((await lstat(backupPath)).isFile()).toBe(true)

    const selected = await SqliteEventStore.open({
      databasePath: backupPath,
      integrityCheck: 'full'
    })
    expect(selected.getHead()).toEqual(store.getHead())
    await selected.close()
    await store.close()
  })

  it('keeps backup selection absent and retryable when destination-witness publication fails', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const backupPath = path.join(directory, 'retryable-backup.sqlite')
    const backupWitnessPath = `${backupPath}.head.json`
    let failDestinationWitness = false
    const witnessStore = {
      read: (filePath: string) =>
        fileHeadWitnessStore.read(filePath),
      publish: async (
        filePath: string,
        witness: HeadWitness,
        options?: Parameters<
          typeof fileHeadWitnessStore.publish
        >[2]
      ) => {
        if (failDestinationWitness && filePath === backupWitnessPath) {
          throw new Error('injected destination witness failure')
        }
        return fileHeadWitnessStore.publish(
          filePath,
          witness,
          options
        )
      }
    }
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: { witnessStore }
    })
    failDestinationWitness = true
    await expect(
      store.createVerifiedBackup(backupPath)
    ).rejects.toThrow(/injected destination witness failure/)
    await expect(lstat(backupPath)).rejects.toMatchObject({
      code: 'ENOENT'
    })

    failDestinationWitness = false
    await expect(
      store.createVerifiedBackup(backupPath)
    ).resolves.toBeUndefined()
    const backup = await SqliteEventStore.open({
      databasePath: backupPath,
      integrityCheck: 'full'
    })
    expect(backup.getHead()).toEqual(store.getHead())
    await backup.close()
    await store.close()
  })

  it('reserves destination SQLite sidecars from use as the backup witness', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const backupPath = path.join(directory, 'retained.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })

    await expect(
      store.createVerifiedBackup(backupPath, `${backupPath}-wal`)
    ).rejects.toThrow(/reserved event-store file namespace/)
    await expect(lstat(backupPath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(store.getHead().sequence).toBe(1)
    await store.close()
  })

  it('rejects an occupied destination sidecar before publishing a backup', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const backupPath = path.join(directory, 'retained.sqlite')
    const staleShmPath = `${backupPath}-shm`
    writeFileSync(staleShmPath, 'occupied sidecar', { mode: 0o600 })
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })

    await expect(
      store.createVerifiedBackup(backupPath)
    ).rejects.toThrow(/sidecar exists without its database/)
    await expect(lstat(backupPath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(staleShmPath, 'utf8')).toBe(
      'occupied sidecar'
    )
    await store.close()
  })

  it('rejects replacement of the verified backup staging pathname before publication and remains retryable', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const backupPath = path.join(directory, 'retained.sqlite')
    let stagingDirectory: string | undefined
    let replaceStaging = true
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(backupSizedState()),
      dependencies: {
        ...deterministicDependencies(),
        onBackupProgress: (temporaryDatabasePath) => {
          stagingDirectory = path.dirname(temporaryDatabasePath)
        },
        fault: (point) => {
          if (
            !replaceStaging ||
            point !== 'before-backup-database-link'
          ) {
            return
          }
          if (!stagingDirectory) {
            throw new Error('backup progress did not expose staging')
          }
          const displaced = `${stagingDirectory}.displaced`
          renameSync(stagingDirectory, displaced)
          mkdirSync(stagingDirectory, { mode: 0o700 })
          copyFileSync(
            path.join(displaced, 'backup.sqlite'),
            path.join(stagingDirectory, 'backup.sqlite')
          )
        }
      }
    })

    await expect(
      store.createVerifiedBackup(backupPath)
    ).rejects.toThrow(/staging directory changed/)
    await expect(lstat(backupPath)).rejects.toMatchObject({
      code: 'ENOENT'
    })

    replaceStaging = false
    await expect(
      store.createVerifiedBackup(backupPath)
    ).resolves.toBeUndefined()
    const selected = await SqliteEventStore.open({
      databasePath: backupPath,
      integrityCheck: 'full'
    })
    expect(selected.getHead()).toEqual(store.getHead())
    await selected.close()
    await store.close()
  })

  it('full-reopens the selected backup and reports same-inode corruption as persistence uncertainty', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const backupPath = path.join(directory, 'retained.sqlite')
    let corruptSelectedBackup = false
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: {
        ...deterministicDependencies(),
        fault: (point) => {
          if (
            corruptSelectedBackup &&
            point === 'after-backup-database-published'
          ) {
            writeFileSync(backupPath, 'not a SQLite database', {
              mode: 0o600
            })
          }
        }
      }
    })

    corruptSelectedBackup = true
    await expect(
      store.createVerifiedBackup(backupPath)
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    await store.close()
  })

  it('refuses backup destinations that overlap the active database or witness', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    await expect(
      store.createVerifiedBackup(
        path.join(directory, 'backup.sqlite'),
        databasePath
      )
    ).rejects.toBeInstanceOf(EventStoreConflictError)
    expect(store.getHead().sequence).toBe(1)
    await store.close()
  })

  it('publishes canonical private witness bytes', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap()
    })
    const payload = await readFile(`${databasePath}.head.json`, 'utf8')
    expect(payload.endsWith('\n')).toBe(false)
    expect(payload).toBe(
      JSON.stringify(
        JSON.parse(payload),
        Object.keys(JSON.parse(payload)).sort()
      )
    )
    if (process.platform !== 'win32') {
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o600)
      expect(
        (await lstat(`${databasePath}.head.json`)).mode & 0o777
      ).toBe(0o600)
    }
    await store.close()
  })

  it('conditionally publishes witnesses without replacing an interleaved advanced head', async () => {
    const directory = await temporaryDirectory()
    const witnessPath = path.join(directory, 'ground.head.json')
    const initial: HeadWitness = {
      witnessVersion: 1,
      databaseId: 'conditional-database',
      recoveryEpoch: 'conditional-epoch',
      sequence: 1,
      eventHash: sha256('conditional-1'),
      transactionId: 'conditional-transaction-1',
      publishedAt: '2026-07-30T20:00:00.000Z'
    }
    const candidate: HeadWitness = {
      ...initial,
      sequence: 2,
      eventHash: sha256('conditional-2'),
      transactionId: 'conditional-transaction-2',
      publishedAt: '2026-07-30T20:01:00.000Z'
    }
    const concurrentlyAdvanced: HeadWitness = {
      ...initial,
      sequence: 3,
      eventHash: sha256('conditional-3'),
      transactionId: 'conditional-transaction-3',
      publishedAt: '2026-07-30T20:02:00.000Z'
    }
    await fileHeadWitnessStore.publish(witnessPath, initial, {
      expected: null
    })

    await expect(
      fileHeadWitnessStore.publish(witnessPath, candidate, {
        expected: initial,
        beforeRename: () => {
          writeFileSync(
            witnessPath,
            encodeCanonicalJson(concurrentlyAdvanced),
            { mode: 0o600 }
          )
        }
      })
    ).rejects.toBeInstanceOf(EventStoreConflictError)
    expect(await fileHeadWitnessStore.read(witnessPath)).toEqual(
      concurrentlyAdvanced
    )
    await expect(
      fileHeadWitnessStore.publish(witnessPath, candidate, {
        expected: concurrentlyAdvanced
      })
    ).rejects.toThrow(/regress/)
  })

  it('prevents a stale witness CAS from overwriting a head advanced by another process', async () => {
    const directory = await temporaryDirectory()
    const witnessPath = path.join(directory, 'ground.head.json')
    const initial: HeadWitness = {
      witnessVersion: 1,
      databaseId: 'process-cas-database',
      recoveryEpoch: 'process-cas-epoch',
      sequence: 1,
      eventHash: sha256('process-cas-1'),
      transactionId: 'process-cas-transaction-1',
      publishedAt: '2026-07-30T20:00:00.000Z'
    }
    const staleCandidate: HeadWitness = {
      ...initial,
      sequence: 2,
      eventHash: sha256('process-cas-2'),
      transactionId: 'process-cas-transaction-2',
      publishedAt: '2026-07-30T20:01:00.000Z'
    }
    const advanced: HeadWitness = {
      ...initial,
      sequence: 3,
      eventHash: sha256('process-cas-3'),
      transactionId: 'process-cas-transaction-3',
      publishedAt: '2026-07-30T20:02:00.000Z'
    }
    await fileHeadWitnessStore.publish(witnessPath, initial, {
      expected: null
    })

    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { DatabaseSync } from 'node:sqlite'
          import { writeFileSync, renameSync } from 'node:fs'
          const lock = new DatabaseSync(process.argv[1], { timeout: 0 })
          lock.exec('BEGIN IMMEDIATE')
          process.stdout.write('locked\\n')
          process.stdin.once('data', () => {
            const temporary = process.argv[2] + '.child'
            writeFileSync(temporary, process.argv[3], { mode: 0o600 })
            renameSync(temporary, process.argv[2])
            lock.exec('COMMIT')
            lock.close()
            process.exit(0)
          })
        `,
        witnessPublicationLockPath(witnessPath),
        witnessPath,
        encodeCanonicalJson(advanced)
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    try {
      const [locked] = (await once(child.stdout!, 'data')) as [Buffer]
      expect(locked.toString('utf8')).toContain('locked')

      let staleSettled = false
      const stalePublication = fileHeadWitnessStore
        .publish(witnessPath, staleCandidate, { expected: initial })
        .then(
          () => {
            staleSettled = true
            return undefined
          },
          (error: unknown) => {
            staleSettled = true
            return error
          }
        )
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(staleSettled).toBe(false)

      const childExited = once(child, 'exit')
      child.stdin!.end('advance\n')
      await childExited
      expect(await stalePublication).toBeInstanceOf(
        EventStoreConflictError
      )
      expect(await fileHeadWitnessStore.read(witnessPath)).toEqual(
        advanced
      )
    } finally {
      child.kill()
    }
  })

  it('routes witness reads and publications through the injected seam', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    let reads = 0
    let publications = 0
    const witnessStore = {
      read: async (filePath: string) => {
        reads += 1
        return fileHeadWitnessStore.read(filePath)
      },
      publish: async (
        filePath: string,
        witness: Parameters<
          typeof fileHeadWitnessStore.publish
        >[1],
        options?: Parameters<
          typeof fileHeadWitnessStore.publish
        >[2]
      ) => {
        publications += 1
        return fileHeadWitnessStore.publish(filePath, witness, options)
      }
    }
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(),
      dependencies: {
        ...deterministicDependencies(),
        witnessStore
      }
    })
    expect(publications).toBe(2)
    await store.close()

    const reopened = await SqliteEventStore.open({
      databasePath,
      dependencies: {
        ...deterministicDependencies(),
        witnessStore
      }
    })
    expect(reads).toBeGreaterThanOrEqual(5)
    expect(reopened.getHead().sequence).toBe(1)
    await reopened.close()
  })
})
