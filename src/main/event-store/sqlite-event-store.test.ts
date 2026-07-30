import {
  copyFile,
  readFile,
  lstat,
  mkdtemp,
  rm
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedStateData } from '../state-schema'
import {
  encodeProjection,
  EventStoreConflictError,
  EventStorePersistenceUncertainError,
  EventStoreRollbackError,
  EventStoreSealedError,
  EventStoreVersionError,
  fileHeadWitnessStore,
  hashLedgerEventRecord,
  sha256,
  SqliteEventStore,
  type EventStoreFaultPoint,
  type LegacyStateBootstrappedEvent
} from './index'

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

describe('SQLite event store', () => {
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
    const store = await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(initialState(true))
    })
    await store.createVerifiedBackup(backupPath)

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
    expect(reads).toBe(1)
    expect(reopened.getHead().sequence).toBe(1)
    await reopened.close()
  })
})
