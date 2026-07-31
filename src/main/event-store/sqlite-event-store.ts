import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { link, lstat } from 'node:fs/promises'
import path from 'node:path'
import {
  backup as sqliteBackup,
  DatabaseSync
} from 'node:sqlite'
import { z } from 'zod'
import type { PersistedStateData } from '../state-schema'
import { encodeCanonicalJson } from './canonical-json'
import {
  decodeProjection,
  encodeLedgerEvent,
  encodeProjection,
  hashLedgerEventRecord,
  parseLedgerEventRecord,
  sha256
} from './codec'
import {
  EventCodecError,
  EventStoreConflictError,
  EventStoreCorruptionError,
  EventStorePersistenceUncertainError,
  EventStoreRollbackError,
  EventStoreSealedError,
  EventStoreVersionError
} from './errors'
import {
  assertPrivateRegularFile,
  createPrivateEmptyFile,
  createPrivateTemporaryDirectory,
  createPrivateTemporaryPath,
  isMissingFileError,
  removeIfPresent,
  removePrivateTemporaryDirectory,
  removeSqliteFileSet,
  syncDirectory
} from './private-files'
import {
  reduceLedgerEvent,
  replayLedgerDeterministically,
  type DecodedLedgerRecord
} from './reducer'
import {
  DATABASE_FORMAT_VERSION,
  EVENT_SCHEMA_VERSION,
  GENESIS_EVENT_HASH,
  GENESIS_TRANSACTION_ID,
  HEAD_WITNESS_VERSION,
  MAX_DATABASE_BYTES,
  MAX_EVENT_BATCH_SIZE,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_ROWS,
  MAX_PROJECTION_BYTES,
  PROJECTION_SCHEMA_VERSION,
  REDUCER_VERSION,
  type AppendEventBatchInput,
  type AppendEventBatchResult,
  type CreateEventStoreInput,
  type EventStoreDependencies,
  type GroundLedgerEvent,
  type HeadWitness,
  type LedgerEventRecord,
  type LedgerHead,
  type LedgerMetadata,
  type MigrationProvenance,
  type OpenEventStoreInput
} from './types'
import {
  defaultWitnessPath,
  fileHeadWitnessStore
} from './witness'
import {
  assertCoordinationPathNamespace,
  withLedgerWriterLock,
  withLedgerWriterLocks,
  witnessPublicationLockPath,
  writerLockPath
} from './writer-lock'

const GROUND_SQLITE_APPLICATION_ID = 1_196_576_324
const SQLITE_BUSY_TIMEOUT_MS = 5_000
const SQLITE_WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024
const LEDGER_SCHEMA_SHA256 =
  'e26a16144ba99e4a6190f4a719de9542b20fdd897c931c0817eba10251bf380c'

const identifierSchema = z.string().min(1).max(200)
const timestampSchema = z.iso.datetime({ offset: true })
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

interface LoadedDatabase {
  readonly metadata: LedgerMetadata
  readonly head: LedgerHead
  readonly projection: PersistedStateData
  readonly records: readonly DecodedLedgerRecord[]
  readonly provenance: MigrationProvenance
}

interface ProjectionRow {
  readonly projection_schema_version: number
  readonly reducer_version: number
  readonly through_sequence: number
  readonly through_event_hash: string
  readonly state_json: string
  readonly state_sha256: string
}

interface SchemaManifestRow {
  readonly type: string
  readonly name: string
  readonly tableName: string
  readonly sql: string | null
}

let expectedSchemaManifestJson: string | undefined

export class SqliteEventStore {
  private sealed = false
  private closed = false
  private operationQueue: Promise<void> = Promise.resolve()

  private constructor(
    readonly databasePath: string,
    readonly witnessPath: string,
    private readonly database: DatabaseSync,
    private readonly dependencies: Required<
      Pick<EventStoreDependencies, 'now' | 'createId'>
    > &
      Omit<EventStoreDependencies, 'now' | 'createId'>,
    private metadata: LedgerMetadata,
    private head: LedgerHead,
    private projection: PersistedStateData,
    private records: DecodedLedgerRecord[],
    private provenance: MigrationProvenance
  ) {}

  static async create(input: CreateEventStoreInput): Promise<SqliteEventStore> {
    const witnessPath =
      input.witnessPath ?? defaultWitnessPath(input.databasePath)
    assertSeparatePaths(input.databasePath, witnessPath)
    await assertCoordinationPathNamespace(
      [input.databasePath],
      [witnessPath]
    )
    const dependencies = normalizeDependencies(input.dependencies)
    const encodedBootstrap = encodeLedgerEvent(input.bootstrap)
    if (encodedBootstrap.kind !== 'legacy-state.bootstrapped') {
      throw new EventCodecError(
        'A new SQLite ledger requires a semantic legacy-state bootstrap'
      )
    }

    return withLedgerWriterLock(input.databasePath, async () => {
      await assertPathAbsent(input.databasePath)
      const temporaryDatabasePath =
        await createPrivateTemporaryPath(
          input.databasePath,
          'create.sqlite'
        )
      const temporaryWitnessPath = defaultWitnessPath(
        temporaryDatabasePath
      )
      let databasePublished = false
      let built:
        | {
            readonly head: LedgerHead
            readonly witness: HeadWitness
          }
        | undefined
      let failure: CapturedFailure | undefined
      try {
        built = await SqliteEventStore.buildVerifiedTemporary(
          temporaryDatabasePath,
          temporaryWitnessPath,
          input.bootstrap,
          dependencies
        )
        const witnessStore =
          dependencies.witnessStore ?? fileHeadWitnessStore
        const existingFinalWitness = await witnessStore.read(witnessPath)
        await witnessStore.publish(witnessPath, built.witness, {
          expected: existingFinalWitness ?? null
        })
        dependencies.fault?.('after-create-witness-published')

        await link(temporaryDatabasePath, input.databasePath)
        databasePublished = true
        await syncDirectory(path.dirname(input.databasePath))
        await assertPrivateRegularFile(
          input.databasePath,
          MAX_DATABASE_BYTES
        )
        dependencies.fault?.('after-create-database-published')
      } catch (error) {
        failure = captureFailure(
          failure,
          error,
          'Atomic create and publication both failed'
        )
      }

      try {
        await runCleanupTasks(
          'Atomic-create temporary cleanup failed',
          [
            async () => {
              dependencies.fault?.(
                'before-create-temporary-cleanup'
              )
            },
            () => removeSqliteFileSet(temporaryDatabasePath),
            () => removeIfPresent(temporaryWitnessPath),
            () =>
              removeSqliteFileSet(
                witnessPublicationLockPath(temporaryWitnessPath)
              )
          ]
        )
      } catch (error) {
        failure = captureFailure(
          failure,
          error,
          'Atomic create failed and its temporary cleanup also failed'
        )
      }

      if (failure) {
        if (databasePublished) {
          throw new EventStorePersistenceUncertainError(
            'SQLite ledger was selected but atomic-create verification did not complete',
            { cause: failure.error }
          )
        }
        throw failure.error
      }
      if (!built) {
        throw new EventStoreCorruptionError(
          'Atomic create completed without a verified temporary head'
        )
      }

      let selected: SqliteEventStore | undefined
      try {
        selected = await SqliteEventStore.openUnderHeldWriterLock(
          input.databasePath,
          witnessPath,
          dependencies,
          'full'
        )
        assertMatchingHead(
          built.head,
          selected.getHead(),
          'atomically created database'
        )
        return selected
      } catch (error) {
        let verificationFailure = captureFailure(
          undefined,
          error,
          'Atomic-create verification failed'
        )
        if (selected) {
          try {
            await selected.close()
          } catch (closeError) {
            verificationFailure = captureFailure(
              verificationFailure,
              closeError,
              'Atomic-create verification and selected-store close both failed'
            )
          }
        }
        throw new EventStorePersistenceUncertainError(
          'SQLite ledger was selected but atomic-create verification did not complete',
          { cause: verificationFailure.error }
        )
      }
    })
  }

  static async open(input: OpenEventStoreInput): Promise<SqliteEventStore> {
    const witnessPath =
      input.witnessPath ?? defaultWitnessPath(input.databasePath)
    assertSeparatePaths(input.databasePath, witnessPath)
    await assertCoordinationPathNamespace(
      [input.databasePath],
      [witnessPath]
    )
    const dependencies = normalizeDependencies(input.dependencies)
    return withLedgerWriterLock(input.databasePath, () =>
      SqliteEventStore.openUnderHeldWriterLock(
        input.databasePath,
        witnessPath,
        dependencies,
        input.integrityCheck ?? 'quick'
      )
    )
  }

  private static async buildVerifiedTemporary(
    databasePath: string,
    witnessPath: string,
    bootstrap: Extract<
      GroundLedgerEvent,
      { kind: 'legacy-state.bootstrapped' }
    >,
    dependencies: ReturnType<typeof normalizeDependencies>
  ): Promise<{ readonly head: LedgerHead; readonly witness: HeadWitness }> {
    const createdAt = parseTimestamp(dependencies.now(), 'createdAt')
    const databaseId = parseIdentifier(
      dependencies.createId(),
      'databaseId'
    )
    const recoveryEpoch = parseIdentifier(
      dependencies.createId(),
      'recoveryEpoch'
    )
    if (databaseId === recoveryEpoch) {
      throw new EventCodecError(
        'Database ID and recovery epoch must be independently generated'
      )
    }
    const metadata: LedgerMetadata = {
      databaseFormatVersion: DATABASE_FORMAT_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      reducerVersion: REDUCER_VERSION,
      projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
      databaseId,
      recoveryEpoch,
      createdAt
    }
    const genesisHead: LedgerHead = {
      sequence: 0,
      eventHash: GENESIS_EVENT_HASH,
      transactionId: GENESIS_TRANSACTION_ID,
      updatedAt: createdAt
    }
    const provenance: MigrationProvenance = {
      sourceFormat: bootstrap.sourceFormat,
      sourceStateVersion: bootstrap.sourceStateVersion,
      sourceSha256: bootstrap.sourceSha256,
      sourceByteLength: bootstrap.sourceByteLength,
      normalizedStateSha256: bootstrap.normalizedStateSha256,
      migratedAt: createdAt
    }

    await createPrivateEmptyFile(databasePath)
    let database: DatabaseSync | undefined
    try {
      database = openDatabaseConnection(databasePath)
      initializeDatabase(database, metadata)
      await tightenDatabaseFiles(databasePath)
      const temporary = new SqliteEventStore(
        databasePath,
        witnessPath,
        database,
        dependencies,
        metadata,
        genesisHead,
        bootstrap.state,
        [],
        provenance
      )
      await temporary.appendInternal(
        {
          expectedHead: {
            sequence: genesisHead.sequence,
            eventHash: genesisHead.eventHash
          },
          events: [bootstrap]
        },
        null
      )
      await temporary.close()
      database = undefined

      const verified = await SqliteEventStore.openUnderHeldWriterLock(
        databasePath,
        witnessPath,
        dependencies,
        'full'
      )
      try {
        const witnessStore =
          dependencies.witnessStore ?? fileHeadWitnessStore
        const witness = await witnessStore.read(witnessPath)
        if (!witness) {
          throw new EventStoreCorruptionError(
            'Verified temporary SQLite database has no witness'
          )
        }
        return { head: verified.getHead(), witness }
      } finally {
        await verified.close()
      }
    } catch (error) {
      if (database) {
        try {
          database.close()
        } catch {
          // Preserve the construction failure.
        }
      }
      throw error
    }
  }

  private static async openUnderHeldWriterLock(
    databasePath: string,
    witnessPath: string,
    dependencies: ReturnType<typeof normalizeDependencies>,
    integrityCheck: 'quick' | 'full'
  ): Promise<SqliteEventStore> {
    await tightenDatabaseFiles(databasePath)
    const database = openDatabaseConnection(databasePath)
    try {
      configureExistingConnection(database)
      const loaded = loadAndVerifyDatabase(database, integrityCheck)
      await reconcileHeadWitness(
        witnessPath,
        dependencies,
        loaded.metadata,
        loaded.head,
        loaded.records
      )
      await tightenDatabaseFiles(databasePath)
      return new SqliteEventStore(
        databasePath,
        witnessPath,
        database,
        dependencies,
        loaded.metadata,
        loaded.head,
        loaded.projection,
        [...loaded.records],
        loaded.provenance
      )
    } catch (error) {
      try {
        database.close()
      } catch {
        // Preserve the verification or reconciliation failure.
      }
      throw error
    }
  }

  getHead(): LedgerHead {
    return { ...this.head }
  }

  getProjection(): PersistedStateData {
    return structuredClone(this.projection)
  }

  getMetadata(): LedgerMetadata {
    return { ...this.metadata }
  }

  getMigrationProvenance(): MigrationProvenance {
    return { ...this.provenance }
  }

  getRecords(): readonly LedgerEventRecord[] {
    return this.records.map(({ record }) => ({ ...record }))
  }

  isSealed(): boolean {
    return this.sealed
  }

  appendEventBatch(
    input: AppendEventBatchInput
  ): Promise<AppendEventBatchResult> {
    return this.enqueue(() =>
      withLedgerWriterLock(this.databasePath, async () => {
        this.assertWritable()
        const durableHead = readHead(this.database)
        assertMatchingHead(this.head, durableHead, 'database')
        const currentWitness = await reconcileHeadWitness(
          this.witnessPath,
          this.dependencies,
          this.metadata,
          this.head,
          this.records
        )
        return this.appendInternal(input, currentWitness)
      })
    )
  }

  createVerifiedBackup(
    destinationDatabasePath: string,
    destinationWitnessPath = defaultWitnessPath(destinationDatabasePath)
  ): Promise<void> {
    return this.enqueue(async () => {
      this.assertWritable()
      assertSeparatePaths(
        destinationDatabasePath,
        destinationWitnessPath
      )
      assertBackupPathsDoNotOverlapSource(
        this.databasePath,
        this.witnessPath,
        destinationDatabasePath,
        destinationWitnessPath
      )
      await assertCoordinationPathNamespace(
        [this.databasePath, destinationDatabasePath],
        [this.witnessPath, destinationWitnessPath]
      )
      return withLedgerWriterLocks(
        [this.databasePath, destinationDatabasePath],
        async () => {
          const durableHead = readHead(this.database)
          assertMatchingHead(
            this.head,
            durableHead,
            'backup source database'
          )
          await reconcileHeadWitness(
            this.witnessPath,
            this.dependencies,
            this.metadata,
            this.head,
            this.records
          )
          await assertPathAbsent(destinationDatabasePath)

          const stagingDirectory =
            await createPrivateTemporaryDirectory(
              destinationDatabasePath,
              'backup-stage'
            )
          const temporaryDatabasePath = path.join(
            stagingDirectory,
            'backup.sqlite'
          )
          const temporaryWitnessPath = defaultWitnessPath(
            temporaryDatabasePath
          )
          let databasePublished = false
          let stagingIdentity: PathIdentity | undefined
          let failure: CapturedFailure | undefined
          try {
            stagingIdentity =
              await readPrivateDirectoryIdentity(stagingDirectory)
            await createPrivateEmptyFile(temporaryDatabasePath)
            await assertPrivateRegularFile(
              temporaryDatabasePath,
              MAX_DATABASE_BYTES
            )
            await sqliteBackup(this.database, temporaryDatabasePath, {
              rate: 256,
              progress: () => {
                assertPrivateBackupFilesDuringProgress(
                  temporaryDatabasePath
                )
                this.dependencies.onBackupProgress?.(
                  temporaryDatabasePath
                )
              }
            })
            await assertPrivateRegularFile(
              temporaryDatabasePath,
              MAX_DATABASE_BYTES
            )
            const witness = toWitness(
              this.metadata,
              this.head,
              parseTimestamp(
                this.dependencies.now(),
                'backup witness timestamp'
              )
            )
            await (
              this.dependencies.witnessStore ?? fileHeadWitnessStore
            ).publish(temporaryWitnessPath, witness, {
              expected: null
            })
            const verified =
              await SqliteEventStore.openUnderHeldWriterLock(
                temporaryDatabasePath,
                temporaryWitnessPath,
                this.dependencies,
                'full'
              )
            try {
              assertMatchingHead(
                this.head,
                verified.getHead(),
                'backup'
              )
            } finally {
              await verified.close()
            }
            const verifiedDatabaseIdentity =
              await readPrivateFileIdentity(
                temporaryDatabasePath,
                MAX_DATABASE_BYTES
              )

            const destinationWitnessStore =
              this.dependencies.witnessStore ?? fileHeadWitnessStore
            const existingDestinationWitness =
              await destinationWitnessStore.read(
                destinationWitnessPath
              )
            await destinationWitnessStore.publish(
              destinationWitnessPath,
              witness,
              { expected: existingDestinationWitness ?? null }
            )
            this.dependencies.fault?.(
              'before-backup-database-link'
            )
            if (!stagingIdentity) {
              throw new EventStoreCorruptionError(
                'SQLite backup staging identity is unavailable'
              )
            }
            assertSamePathIdentity(
              stagingIdentity,
              await readPrivateDirectoryIdentity(stagingDirectory),
              'SQLite backup staging directory'
            )
            assertSamePathIdentity(
              verifiedDatabaseIdentity,
              await readPrivateFileIdentity(
                temporaryDatabasePath,
                MAX_DATABASE_BYTES
              ),
              'verified SQLite backup'
            )
            await link(
              temporaryDatabasePath,
              destinationDatabasePath
            )
            databasePublished = true
            this.dependencies.fault?.(
              'after-backup-database-published'
            )
            await syncDirectory(path.dirname(destinationDatabasePath))
            await assertPrivateRegularFile(
              destinationDatabasePath,
              MAX_DATABASE_BYTES
            )
            assertSamePathIdentity(
              verifiedDatabaseIdentity,
              await readPrivateFileIdentity(
                destinationDatabasePath,
                MAX_DATABASE_BYTES
              ),
              'published SQLite backup'
            )
            const selected =
              await SqliteEventStore.openUnderHeldWriterLock(
                destinationDatabasePath,
                destinationWitnessPath,
                this.dependencies,
                'full'
              )
            try {
              assertMatchingHead(
                this.head,
                selected.getHead(),
                'published backup'
              )
            } finally {
              await selected.close()
            }
          } catch (error) {
            failure = captureFailure(
              failure,
              error,
              'SQLite backup creation failed'
            )
          }

          try {
            await runCleanupTasks(
              'SQLite backup temporary cleanup failed',
              [
                async () => {
                  this.dependencies.fault?.(
                    'before-backup-temporary-cleanup'
                  )
                },
                () => removeSqliteFileSet(temporaryDatabasePath),
                () => removeIfPresent(temporaryWitnessPath),
                () =>
                  removeSqliteFileSet(
                    witnessPublicationLockPath(
                      temporaryWitnessPath
                    )
                  ),
                () =>
                  removePrivateTemporaryDirectory(stagingDirectory)
              ]
            )
          } catch (error) {
            failure = captureFailure(
              failure,
              error,
              'SQLite backup failed and its temporary cleanup also failed'
            )
          }

          if (failure) {
            if (databasePublished) {
              throw new EventStorePersistenceUncertainError(
                'SQLite backup was selected but final publication durability is uncertain',
                { cause: failure.error }
              )
            }
            throw failure.error
          }
        }
      )
    })
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return
      this.closed = true
      let checkpointError: unknown
      try {
        this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch (error) {
        checkpointError = error
      }
      try {
        this.database.close()
      } catch (error) {
        checkpointError ??= error
      }
      await tightenDatabaseFiles(this.databasePath).catch((error) => {
        checkpointError ??= error
      })
      if (checkpointError) throw checkpointError
    }, true)
  }

  private async appendInternal(
    input: AppendEventBatchInput,
    expectedWitness: HeadWitness | null
  ): Promise<AppendEventBatchResult> {
    this.assertWritable()
    if (
      !Number.isSafeInteger(input.expectedHead.sequence) ||
      input.expectedHead.sequence < 0 ||
      !sha256Schema.safeParse(input.expectedHead.eventHash).success
    ) {
      throw new EventStoreConflictError('Expected ledger head is invalid')
    }
    if (
      input.expectedHead.sequence !== this.head.sequence ||
      input.expectedHead.eventHash !== this.head.eventHash
    ) {
      throw new EventStoreConflictError(
        'Expected ledger head is stale'
      )
    }
    if (
      input.events.length === 0 ||
      input.events.length > MAX_EVENT_BATCH_SIZE
    ) {
      throw new EventCodecError(
        `Ledger event batch must contain 1-${MAX_EVENT_BATCH_SIZE} events`
      )
    }
    if (this.head.sequence + input.events.length > MAX_EVENT_ROWS) {
      throw new EventCodecError('Ledger event-count limit would be exceeded')
    }

    const transactionId = parseIdentifier(
      input.transactionId ?? this.dependencies.createId(),
      'transactionId'
    )
    if (
      transactionId === GENESIS_TRANSACTION_ID ||
      this.records.some(
        ({ record }) => record.transactionId === transactionId
      )
    ) {
      throw new EventStoreConflictError(
        'Ledger transaction ID must be globally unique'
      )
    }
    const recordedAt = parseTimestamp(
      this.dependencies.now(),
      'recordedAt'
    )
    const records: LedgerEventRecord[] = []
    const decoded: DecodedLedgerRecord[] = []
    let previousEventHash = this.head.eventHash
    let candidateProjection: PersistedStateData | undefined =
      this.records.length === 0 ? undefined : this.projection

    for (const [index, event] of input.events.entries()) {
      const encoded = encodeLedgerEvent(event)
      const withoutHash: Omit<LedgerEventRecord, 'eventHash'> = {
        eventSchemaVersion: EVENT_SCHEMA_VERSION,
        sequence: this.head.sequence + index + 1,
        transactionId,
        transactionOrdinal: index + 1,
        transactionSize: input.events.length,
        kind: encoded.kind,
        entityId: encoded.entityId,
        recordedAt,
        previousEventHash,
        payloadJson: encoded.payloadJson
      }
      const record: LedgerEventRecord = {
        ...withoutHash,
        eventHash: hashLedgerEventRecord(withoutHash)
      }
      candidateProjection = reduceLedgerEvent(
        candidateProjection,
        encoded.event,
        record.sequence
      )
      records.push(record)
      decoded.push({ record, event: encoded.event })
      previousEventHash = record.eventHash
    }
    if (!candidateProjection) {
      throw new EventStoreCorruptionError(
        'Ledger batch did not produce a materialized projection'
      )
    }
    const encodedProjection = encodeProjection(candidateProjection)
    const nextHead: LedgerHead = {
      sequence: records.at(-1)!.sequence,
      eventHash: records.at(-1)!.eventHash,
      transactionId,
      updatedAt: recordedAt
    }

    let commitAttempted = false
    let committed = false
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.dependencies.fault?.('after-begin')
      const durableHead = readHead(this.database)
      assertMatchingHead(this.head, durableHead, 'database')
      if (
        durableHead.sequence !== input.expectedHead.sequence ||
        durableHead.eventHash !== input.expectedHead.eventHash
      ) {
        throw new EventStoreConflictError(
          'Durable ledger head changed before publication'
        )
      }

      const insertEvent = this.database.prepare(`
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
      for (const record of records) {
        insertEvent.run(
          record.sequence,
          record.eventSchemaVersion,
          record.transactionId,
          record.transactionOrdinal,
          record.transactionSize,
          record.kind,
          record.entityId ?? null,
          record.recordedAt,
          record.previousEventHash,
          record.payloadJson,
          record.eventHash
        )
      }

      upsertProjection(
        this.database,
        nextHead,
        encodedProjection.stateJson,
        encodedProjection.stateSha256
      )
      if (
        records[0]?.sequence === 1 &&
        decoded[0]?.event.kind === 'legacy-state.bootstrapped'
      ) {
        insertBootstrapCheckpointAndProvenance(
          this.database,
          nextHead,
          encodedProjection.stateJson,
          encodedProjection.stateSha256,
          decoded[0].event,
          recordedAt
        )
      }
      updateHead(this.database, nextHead)
      this.dependencies.fault?.('before-commit')
      commitAttempted = true
      this.database.exec('COMMIT')
      committed = true
    } catch (error) {
      if (!committed) {
        try {
          this.database.exec('ROLLBACK')
        } catch {
          // A failed COMMIT/ROLLBACK pair is ambiguous and seals below.
        }
      }
      if (commitAttempted) {
        this.sealed = true
        throw new EventStorePersistenceUncertainError(
          'SQLite ledger COMMIT result is uncertain; the store was sealed',
          { cause: error }
        )
      }
      throw error
    }

    try {
      this.dependencies.fault?.('after-commit')
      await tightenDatabaseFiles(this.databasePath)
      this.dependencies.fault?.('before-witness-publish')
      const witness = toWitness(
        this.metadata,
        nextHead,
        parseTimestamp(this.dependencies.now(), 'witness publishedAt')
      )
      await (this.dependencies.witnessStore ?? fileHeadWitnessStore).publish(
        this.witnessPath,
        witness,
        {
          expected: expectedWitness,
          afterRename: () =>
            this.dependencies.fault?.('after-witness-rename')
        }
      )
    } catch (error) {
      this.sealed = true
      throw new EventStorePersistenceUncertainError(
        'SQLite ledger committed but head-witness publication is uncertain; the store was sealed',
        { cause: error }
      )
    }

    this.head = nextHead
    this.projection = encodedProjection.state
    this.records.push(...decoded)
    if (decoded[0]?.event.kind === 'legacy-state.bootstrapped') {
      this.provenance = {
        sourceFormat: decoded[0].event.sourceFormat,
        sourceStateVersion: decoded[0].event.sourceStateVersion,
        sourceSha256: decoded[0].event.sourceSha256,
        sourceByteLength: decoded[0].event.sourceByteLength,
        normalizedStateSha256: decoded[0].event.normalizedStateSha256,
        migratedAt: recordedAt
      }
    }
    return {
      records: records.map((record) => ({ ...record })),
      head: { ...nextHead },
      projection: structuredClone(encodedProjection.state)
    }
  }

  private assertWritable(): void {
    if (this.closed) {
      throw new EventStoreSealedError()
    }
    if (this.sealed) {
      throw new EventStoreSealedError()
    }
  }

  private enqueue<T>(
    operation: () => Promise<T>,
    allowClosed = false
  ): Promise<T> {
    const result = this.operationQueue.then(async () => {
      if (!allowClosed && this.closed) throw new EventStoreSealedError()
      return operation()
    })
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function normalizeDependencies(
  dependencies: EventStoreDependencies = {}
): Required<Pick<EventStoreDependencies, 'now' | 'createId'>> &
  Omit<EventStoreDependencies, 'now' | 'createId'> {
  return {
    ...dependencies,
    now: dependencies.now ?? (() => new Date().toISOString()),
    createId: dependencies.createId ?? randomUUID
  }
}

function openDatabaseConnection(filePath: string): DatabaseSync {
  return new DatabaseSync(filePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    readBigInts: false,
    returnArrays: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    defensive: true
  })
}

function configureNewConnection(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA journal_size_limit = ${SQLITE_WAL_SIZE_LIMIT_BYTES};
    PRAGMA cell_size_check = ON;
    PRAGMA mmap_size = 0;
  `)
}

function configureExistingConnection(database: DatabaseSync): void {
  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA temp_store = MEMORY;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA journal_size_limit = ${SQLITE_WAL_SIZE_LIMIT_BYTES};
    PRAGMA cell_size_check = ON;
    PRAGMA mmap_size = 0;
  `)
}

function initializeDatabase(
  database: DatabaseSync,
  metadata: LedgerMetadata
): void {
  configureNewConnection(database)
  database.exec(`
    PRAGMA application_id = ${GROUND_SQLITE_APPLICATION_ID};
    PRAGMA user_version = ${DATABASE_FORMAT_VERSION};

    BEGIN IMMEDIATE;

    CREATE TABLE ledger_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      database_format_version INTEGER NOT NULL,
      event_schema_version INTEGER NOT NULL,
      reducer_version INTEGER NOT NULL,
      projection_schema_version INTEGER NOT NULL,
      database_id TEXT NOT NULL CHECK (
        length(database_id) BETWEEN 1 AND 200
      ),
      recovery_epoch TEXT NOT NULL CHECK (
        length(recovery_epoch) BETWEEN 1 AND 200
      ),
      created_at TEXT NOT NULL CHECK (
        length(created_at) BETWEEN 1 AND 100
      )
    ) STRICT;

    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      event_schema_version INTEGER NOT NULL,
      transaction_id TEXT NOT NULL CHECK (
        length(transaction_id) BETWEEN 1 AND 200
      ),
      transaction_ordinal INTEGER NOT NULL CHECK (transaction_ordinal > 0),
      transaction_size INTEGER NOT NULL CHECK (
        transaction_size > 0 AND transaction_size <= ${MAX_EVENT_BATCH_SIZE}
      ),
      kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 200),
      entity_id TEXT CHECK (
        entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 200
      ),
      recorded_at TEXT NOT NULL CHECK (
        length(recorded_at) BETWEEN 1 AND 100
      ),
      previous_event_hash TEXT NOT NULL CHECK (
        length(previous_event_hash) = 64 AND
        previous_event_hash NOT GLOB '*[^0-9a-f]*'
      ),
      payload_json TEXT NOT NULL CHECK (
        length(CAST(payload_json AS BLOB)) <= ${MAX_EVENT_PAYLOAD_BYTES}
      ),
      event_hash TEXT NOT NULL UNIQUE CHECK (
        length(event_hash) = 64 AND
        event_hash NOT GLOB '*[^0-9a-f]*'
      )
    ) STRICT;

    CREATE TABLE materialized_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      projection_schema_version INTEGER NOT NULL,
      reducer_version INTEGER NOT NULL,
      through_sequence INTEGER NOT NULL CHECK (through_sequence > 0),
      through_event_hash TEXT NOT NULL CHECK (
        length(through_event_hash) = 64
      ),
      state_json TEXT NOT NULL CHECK (
        length(CAST(state_json AS BLOB)) <= ${MAX_PROJECTION_BYTES}
      ),
      state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64)
    ) STRICT;

    CREATE TABLE ledger_head (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
      transaction_id TEXT NOT NULL CHECK (
        length(transaction_id) BETWEEN 1 AND 200
      ),
      updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 100)
    ) STRICT;

    CREATE TABLE checkpoints (
      through_sequence INTEGER PRIMARY KEY CHECK (through_sequence > 0),
      projection_schema_version INTEGER NOT NULL,
      reducer_version INTEGER NOT NULL,
      through_event_hash TEXT NOT NULL CHECK (
        length(through_event_hash) = 64
      ),
      state_json TEXT NOT NULL CHECK (
        length(CAST(state_json AS BLOB)) <= ${MAX_PROJECTION_BYTES}
      ),
      state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64),
      created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 100)
    ) STRICT;

    CREATE TABLE migration_provenance (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      source_format TEXT NOT NULL CHECK (source_format = 'ground-json'),
      source_state_version INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
      source_byte_length INTEGER NOT NULL CHECK (source_byte_length > 0),
      normalized_state_sha256 TEXT NOT NULL CHECK (
        length(normalized_state_sha256) = 64
      ),
      migrated_at TEXT NOT NULL CHECK (length(migrated_at) BETWEEN 1 AND 100)
    ) STRICT;

    CREATE TRIGGER events_are_append_only_update
    BEFORE UPDATE ON events BEGIN
      SELECT RAISE(ABORT, 'events are append-only');
    END;
    CREATE TRIGGER events_are_append_only_delete
    BEFORE DELETE ON events BEGIN
      SELECT RAISE(ABORT, 'events are append-only');
    END;
    CREATE TRIGGER checkpoints_are_immutable_update
    BEFORE UPDATE ON checkpoints BEGIN
      SELECT RAISE(ABORT, 'checkpoints are immutable');
    END;
    CREATE TRIGGER checkpoints_are_immutable_delete
    BEFORE DELETE ON checkpoints BEGIN
      SELECT RAISE(ABORT, 'checkpoints are immutable');
    END;
    CREATE TRIGGER migration_provenance_is_immutable_update
    BEFORE UPDATE ON migration_provenance BEGIN
      SELECT RAISE(ABORT, 'migration provenance is immutable');
    END;
    CREATE TRIGGER migration_provenance_is_immutable_delete
    BEFORE DELETE ON migration_provenance BEGIN
      SELECT RAISE(ABORT, 'migration provenance is immutable');
    END;

  `)

  try {
    database
      .prepare(`
        INSERT INTO ledger_metadata (
          singleton,
          database_format_version,
          event_schema_version,
          reducer_version,
          projection_schema_version,
          database_id,
          recovery_epoch,
          created_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        metadata.databaseFormatVersion,
        metadata.eventSchemaVersion,
        metadata.reducerVersion,
        metadata.projectionSchemaVersion,
        metadata.databaseId,
        metadata.recoveryEpoch,
        metadata.createdAt
      )
    database
      .prepare(`
        INSERT INTO ledger_head (
          singleton, sequence, event_hash, transaction_id, updated_at
        ) VALUES (1, 0, ?, ?, ?)
      `)
      .run(
        GENESIS_EVENT_HASH,
        GENESIS_TRANSACTION_ID,
        metadata.createdAt
      )
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the initialization failure.
    }
    throw error
  }
}

function upsertProjection(
  database: DatabaseSync,
  head: LedgerHead,
  stateJson: string,
  stateSha256: string
): void {
  database
    .prepare(`
      INSERT INTO materialized_state (
        singleton,
        projection_schema_version,
        reducer_version,
        through_sequence,
        through_event_hash,
        state_json,
        state_sha256
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        projection_schema_version = excluded.projection_schema_version,
        reducer_version = excluded.reducer_version,
        through_sequence = excluded.through_sequence,
        through_event_hash = excluded.through_event_hash,
        state_json = excluded.state_json,
        state_sha256 = excluded.state_sha256
    `)
    .run(
      PROJECTION_SCHEMA_VERSION,
      REDUCER_VERSION,
      head.sequence,
      head.eventHash,
      stateJson,
      stateSha256
    )
}

function insertBootstrapCheckpointAndProvenance(
  database: DatabaseSync,
  head: LedgerHead,
  stateJson: string,
  stateSha256: string,
  event: Extract<
    GroundLedgerEvent,
    { kind: 'legacy-state.bootstrapped' }
  >,
  recordedAt: string
): void {
  database
    .prepare(`
      INSERT INTO checkpoints (
        through_sequence,
        projection_schema_version,
        reducer_version,
        through_event_hash,
        state_json,
        state_sha256,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      head.sequence,
      PROJECTION_SCHEMA_VERSION,
      REDUCER_VERSION,
      head.eventHash,
      stateJson,
      stateSha256,
      recordedAt
    )
  database
    .prepare(`
      INSERT INTO migration_provenance (
        singleton,
        source_format,
        source_state_version,
        source_sha256,
        source_byte_length,
        normalized_state_sha256,
        migrated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      event.sourceFormat,
      event.sourceStateVersion,
      event.sourceSha256,
      event.sourceByteLength,
      event.normalizedStateSha256,
      recordedAt
    )
}

function updateHead(database: DatabaseSync, head: LedgerHead): void {
  const result = database
    .prepare(`
      UPDATE ledger_head
      SET sequence = ?, event_hash = ?, transaction_id = ?, updated_at = ?
      WHERE singleton = 1
    `)
    .run(
      head.sequence,
      head.eventHash,
      head.transactionId,
      head.updatedAt
    )
  if (Number(result.changes) !== 1) {
    throw new EventStoreCorruptionError(
      'Ledger head row was not updated exactly once'
    )
  }
}

function loadAndVerifyDatabase(
  database: DatabaseSync,
  integrityCheck: 'quick' | 'full'
): LoadedDatabase {
  verifyPragmasAndIntegrity(database, integrityCheck)
  verifyRequiredSchema(database)
  const metadata = readMetadata(database)
  const head = readHead(database)
  const eventCount = requireNumber(
    (
      database
        .prepare('SELECT count(*) AS event_count FROM events')
        .get() as { event_count?: unknown } | undefined
    )?.event_count,
    'ledger event count'
  )
  if (eventCount === 0) {
    throw new EventStoreCorruptionError(
      'Selected SQLite ledger has no semantic bootstrap'
    )
  }
  if (eventCount > MAX_EVENT_ROWS) {
    throw new EventStoreCorruptionError(
      'SQLite ledger exceeds its event-count limit'
    )
  }

  const rows = database
    .prepare(`
      SELECT
        event_schema_version,
        sequence,
        transaction_id,
        transaction_ordinal,
        transaction_size,
        kind,
        entity_id,
        recorded_at,
        previous_event_hash,
        payload_json,
        event_hash
      FROM events
      ORDER BY sequence
    `)
    .all()
  if (rows.length !== eventCount) {
    throw new EventStoreCorruptionError(
      'SQLite ledger event count changed during verification'
    )
  }

  const decoded: DecodedLedgerRecord[] = []
  const transactionIds = new Set<string>()
  let expectedSequence = 1
  let previousHash = GENESIS_EVENT_HASH
  let activeTransaction:
    | {
        readonly id: string
        readonly size: number
        readonly recordedAt: string
        nextOrdinal: number
      }
    | undefined

  for (const row of rows) {
    const parsed = parseLedgerEventRecord(row)
    const { record } = parsed
    if (record.sequence !== expectedSequence) {
      throw new EventStoreCorruptionError(
        `Ledger sequence gap: expected ${expectedSequence}, found ${record.sequence}`
      )
    }
    if (record.previousEventHash !== previousHash) {
      throw new EventStoreCorruptionError(
        `Ledger hash-chain gap at sequence ${record.sequence}`
      )
    }

    if (!activeTransaction) {
      if (record.transactionOrdinal !== 1) {
        throw new EventStoreCorruptionError(
          `Transaction ${record.transactionId} does not begin at ordinal 1`
        )
      }
      if (transactionIds.has(record.transactionId)) {
        throw new EventStoreCorruptionError(
          `Transaction ${record.transactionId} is not contiguous`
        )
      }
      transactionIds.add(record.transactionId)
      activeTransaction = {
        id: record.transactionId,
        size: record.transactionSize,
        recordedAt: record.recordedAt,
        nextOrdinal: 1
      }
    }
    if (
      record.transactionId !== activeTransaction.id ||
      record.transactionSize !== activeTransaction.size ||
      record.recordedAt !== activeTransaction.recordedAt ||
      record.transactionOrdinal !== activeTransaction.nextOrdinal
    ) {
      throw new EventStoreCorruptionError(
        `Transaction batch is malformed at sequence ${record.sequence}`
      )
    }
    activeTransaction.nextOrdinal += 1
    if (record.transactionOrdinal === record.transactionSize) {
      activeTransaction = undefined
    }

    decoded.push(parsed)
    expectedSequence += 1
    previousHash = record.eventHash
  }
  if (activeTransaction) {
    throw new EventStoreCorruptionError(
      `Transaction ${activeTransaction.id} is incomplete`
    )
  }
  const lastRecord = decoded.at(-1)!.record
  if (
    head.sequence !== lastRecord.sequence ||
    head.eventHash !== lastRecord.eventHash ||
    head.transactionId !== lastRecord.transactionId
  ) {
    throw new EventStoreCorruptionError(
      'Ledger head does not match the final event'
    )
  }
  if (head.updatedAt !== lastRecord.recordedAt) {
    throw new EventStoreCorruptionError(
      'Ledger head timestamp does not match its transaction'
    )
  }

  const projectionRow = readProjectionRow(database)
  if (
    projectionRow.through_sequence !== head.sequence ||
    projectionRow.through_event_hash !== head.eventHash
  ) {
    throw new EventStoreCorruptionError(
      'Materialized projection does not match the ledger head'
    )
  }
  const projection = decodeProjection(
    projectionRow.state_json,
    projectionRow.state_sha256,
    {
      reducerVersion: projectionRow.reducer_version,
      projectionSchemaVersion:
        projectionRow.projection_schema_version
    }
  )
  const rebuilt = replayLedgerDeterministically(decoded)
  if (
    rebuilt.stateJson !== projectionRow.state_json ||
    rebuilt.stateSha256 !== projectionRow.state_sha256
  ) {
    throw new EventStoreCorruptionError(
      'Materialized projection does not equal deterministic replay'
    )
  }

  verifyCheckpoints(database, decoded)
  const provenance = readAndVerifyProvenance(database, decoded[0]!.event)
  return {
    metadata,
    head,
    projection,
    records: decoded,
    provenance
  }
}

function verifyPragmasAndIntegrity(
  database: DatabaseSync,
  mode: 'quick' | 'full'
): void {
  const applicationId = readPragmaNumber(database, 'application_id')
  if (applicationId !== GROUND_SQLITE_APPLICATION_ID) {
    throw new EventStoreCorruptionError(
      'SQLite application identity is not Ground'
    )
  }
  const userVersion = readPragmaNumber(database, 'user_version')
  if (userVersion !== DATABASE_FORMAT_VERSION) {
    throw new EventStoreVersionError(
      'database',
      `Unsupported database format version ${userVersion}`
    )
  }
  const journalMode = readPragmaString(database, 'journal_mode')
  if (journalMode.toLowerCase() !== 'wal') {
    throw new EventStoreCorruptionError(
      `SQLite journal mode must be WAL, found ${journalMode}`
    )
  }
  if (readPragmaNumber(database, 'foreign_keys') !== 1) {
    throw new EventStoreCorruptionError(
      'SQLite foreign-key enforcement is disabled'
    )
  }
  if (readPragmaNumber(database, 'synchronous') !== 2) {
    throw new EventStoreCorruptionError(
      'SQLite synchronous mode is not FULL'
    )
  }
  if (readPragmaNumber(database, 'trusted_schema') !== 0) {
    throw new EventStoreCorruptionError(
      'SQLite trusted-schema execution is enabled'
    )
  }
  if (readPragmaNumber(database, 'cell_size_check') !== 1) {
    throw new EventStoreCorruptionError(
      'SQLite cell-size checks are disabled'
    )
  }

  const pragma = mode === 'full' ? 'integrity_check' : 'quick_check'
  const results = database.prepare(`PRAGMA ${pragma}`).all()
  if (
    results.length !== 1 ||
    Object.values(results[0] ?? {}).length !== 1 ||
    Object.values(results[0] ?? {})[0] !== 'ok'
  ) {
    throw new EventStoreCorruptionError(
      `SQLite ${pragma} did not return ok`
    )
  }
  const foreignKeyErrors = database
    .prepare('PRAGMA foreign_key_check')
    .all()
  if (foreignKeyErrors.length !== 0) {
    throw new EventStoreCorruptionError(
      'SQLite foreign-key check found violations'
    )
  }
}

function verifyRequiredSchema(database: DatabaseSync): void {
  const actual = encodeSchemaManifest(readSchemaManifest(database))
  const expected = getExpectedSchemaManifestJson()
  if (actual !== expected) {
    throw new EventStoreCorruptionError(
      `SQLite ledger schema fingerprint mismatch (expected ${sha256(
        expected
      )}, found ${sha256(actual)})`
    )
  }
}

function getExpectedSchemaManifestJson(): string {
  if (expectedSchemaManifestJson) return expectedSchemaManifestJson
  const reference = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
    readBigInts: false,
    returnArrays: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    defensive: true
  })
  try {
    initializeDatabase(reference, {
      databaseFormatVersion: DATABASE_FORMAT_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      reducerVersion: REDUCER_VERSION,
      projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
      databaseId: 'schema-reference-database',
      recoveryEpoch: 'schema-reference-epoch',
      createdAt: '2000-01-01T00:00:00.000Z'
    })
    const referenceManifestJson = encodeSchemaManifest(
      readSchemaManifest(reference)
    )
    if (sha256(referenceManifestJson) !== LEDGER_SCHEMA_SHA256) {
      throw new EventStoreCorruptionError(
        'Compiled SQLite schema does not match the database-format fingerprint'
      )
    }
    expectedSchemaManifestJson = referenceManifestJson
    return expectedSchemaManifestJson
  } finally {
    reference.close()
  }
}

function readSchemaManifest(
  database: DatabaseSync
): readonly SchemaManifestRow[] {
  return database
    .prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      ORDER BY type, name, tbl_name
    `)
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>
      const sql =
        record.sql === null
          ? null
          : requireString(record.sql, 'sqlite_schema SQL')
      return {
        type: requireString(record.type, 'sqlite_schema type'),
        name: requireString(record.name, 'sqlite_schema name'),
        tableName: requireString(
          record.tbl_name,
          'sqlite_schema table name'
        ),
        sql
      }
    })
}

function encodeSchemaManifest(
  rows: readonly SchemaManifestRow[]
): string {
  return encodeCanonicalJson(rows, {
    maxBytes: 256 * 1024,
    maxDepth: 8,
    maxNodes: 1_000
  })
}

function readMetadata(database: DatabaseSync): LedgerMetadata {
  const row = database
    .prepare('SELECT * FROM ledger_metadata WHERE singleton = 1')
    .get() as Record<string, unknown> | undefined
  if (!row) {
    throw new EventStoreCorruptionError('Ledger metadata row is missing')
  }

  const databaseFormatVersion = requireNumber(
    row.database_format_version,
    'database format version'
  )
  if (databaseFormatVersion !== DATABASE_FORMAT_VERSION) {
    throw new EventStoreVersionError(
      'database',
      `Unsupported database metadata version ${databaseFormatVersion}`
    )
  }
  const eventSchemaVersion = requireNumber(
    row.event_schema_version,
    'event schema version'
  )
  if (eventSchemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new EventStoreVersionError(
      'event',
      `Unsupported event schema version ${eventSchemaVersion}`
    )
  }
  const reducerVersion = requireNumber(
    row.reducer_version,
    'reducer version'
  )
  if (reducerVersion !== REDUCER_VERSION) {
    throw new EventStoreVersionError(
      'reducer',
      `Unsupported reducer version ${reducerVersion}`
    )
  }
  const projectionSchemaVersion = requireNumber(
    row.projection_schema_version,
    'projection schema version'
  )
  if (projectionSchemaVersion !== PROJECTION_SCHEMA_VERSION) {
    throw new EventStoreVersionError(
      'projection',
      `Unsupported projection schema version ${projectionSchemaVersion}`
    )
  }

  return {
    databaseFormatVersion: DATABASE_FORMAT_VERSION,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    reducerVersion: REDUCER_VERSION,
    projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
    databaseId: parseIdentifier(row.database_id, 'databaseId'),
    recoveryEpoch: parseIdentifier(row.recovery_epoch, 'recoveryEpoch'),
    createdAt: parseTimestamp(row.created_at, 'createdAt')
  }
}

function readHead(database: DatabaseSync): LedgerHead {
  const row = database
    .prepare('SELECT * FROM ledger_head WHERE singleton = 1')
    .get() as Record<string, unknown> | undefined
  if (!row) {
    throw new EventStoreCorruptionError('Ledger head row is missing')
  }
  const sequence = requireNumber(row.sequence, 'head sequence')
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new EventStoreCorruptionError('Ledger head sequence is invalid')
  }
  const eventHash = requireSha256(row.event_hash, 'head event hash')
  const transactionId = parseIdentifier(
    row.transaction_id,
    'head transaction ID'
  )
  const updatedAt = parseTimestamp(row.updated_at, 'head updatedAt')
  if (
    sequence === 0 &&
    (eventHash !== GENESIS_EVENT_HASH ||
      transactionId !== GENESIS_TRANSACTION_ID)
  ) {
    throw new EventStoreCorruptionError('Genesis ledger head is invalid')
  }
  return { sequence, eventHash, transactionId, updatedAt }
}

function readProjectionRow(database: DatabaseSync): ProjectionRow {
  const row = database
    .prepare('SELECT * FROM materialized_state WHERE singleton = 1')
    .get() as Record<string, unknown> | undefined
  if (!row) {
    throw new EventStoreCorruptionError(
      'Materialized projection row is missing'
    )
  }
  return {
    projection_schema_version: requireNumber(
      row.projection_schema_version,
      'projection schema version'
    ),
    reducer_version: requireNumber(
      row.reducer_version,
      'projection reducer version'
    ),
    through_sequence: requireNumber(
      row.through_sequence,
      'projection sequence'
    ),
    through_event_hash: requireSha256(
      row.through_event_hash,
      'projection event hash'
    ),
    state_json: requireString(row.state_json, 'projection state JSON'),
    state_sha256: requireSha256(
      row.state_sha256,
      'projection state hash'
    )
  }
}

function verifyCheckpoints(
  database: DatabaseSync,
  records: readonly DecodedLedgerRecord[]
): void {
  const rows = database
    .prepare('SELECT * FROM checkpoints ORDER BY through_sequence')
    .all() as Record<string, unknown>[]
  if (rows.length === 0) {
    throw new EventStoreCorruptionError(
      'Ledger has no verified bootstrap checkpoint'
    )
  }
  const checkpoints = new Map<number, ProjectionRow & { created_at: string }>()
  for (const row of rows) {
    const checkpoint: ProjectionRow & { created_at: string } = {
      projection_schema_version: requireNumber(
        row.projection_schema_version,
        'checkpoint projection version'
      ),
      reducer_version: requireNumber(
        row.reducer_version,
        'checkpoint reducer version'
      ),
      through_sequence: requireNumber(
        row.through_sequence,
        'checkpoint sequence'
      ),
      through_event_hash: requireSha256(
        row.through_event_hash,
        'checkpoint event hash'
      ),
      state_json: requireString(row.state_json, 'checkpoint state JSON'),
      state_sha256: requireSha256(
        row.state_sha256,
        'checkpoint state hash'
      ),
      created_at: parseTimestamp(row.created_at, 'checkpoint createdAt')
    }
    if (checkpoints.has(checkpoint.through_sequence)) {
      throw new EventStoreCorruptionError(
        'Ledger contains duplicate checkpoint sequences'
      )
    }
    checkpoints.set(checkpoint.through_sequence, checkpoint)
  }

  let state: PersistedStateData | undefined
  for (const decoded of records) {
    state = reduceLedgerEvent(
      state,
      decoded.event,
      decoded.record.sequence
    )
    const checkpoint = checkpoints.get(decoded.record.sequence)
    if (!checkpoint) continue
    if (checkpoint.through_event_hash !== decoded.record.eventHash) {
      throw new EventStoreCorruptionError(
        `Checkpoint ${checkpoint.through_sequence} event hash mismatch`
      )
    }
    const decodedCheckpoint = decodeProjection(
      checkpoint.state_json,
      checkpoint.state_sha256,
      {
        reducerVersion: checkpoint.reducer_version,
        projectionSchemaVersion:
          checkpoint.projection_schema_version
      }
    )
    const expected = encodeProjection(state)
    const actual = encodeProjection(decodedCheckpoint)
    if (
      expected.stateJson !== actual.stateJson ||
      expected.stateSha256 !== actual.stateSha256
    ) {
      throw new EventStoreCorruptionError(
        `Checkpoint ${checkpoint.through_sequence} does not match replay`
      )
    }
    checkpoints.delete(decoded.record.sequence)
  }
  if (checkpoints.size !== 0) {
    throw new EventStoreCorruptionError(
      'Checkpoint points beyond the available ledger'
    )
  }
  if (rows[0]?.through_sequence !== 1) {
    throw new EventStoreCorruptionError(
      'First checkpoint must capture the semantic bootstrap'
    )
  }
}

function readAndVerifyProvenance(
  database: DatabaseSync,
  bootstrap: GroundLedgerEvent
): MigrationProvenance {
  if (bootstrap.kind !== 'legacy-state.bootstrapped') {
    throw new EventStoreCorruptionError(
      'First ledger event is not a legacy-state bootstrap'
    )
  }
  const row = database
    .prepare('SELECT * FROM migration_provenance WHERE singleton = 1')
    .get() as Record<string, unknown> | undefined
  if (!row) {
    throw new EventStoreCorruptionError(
      'Migration provenance row is missing'
    )
  }
  const provenance: MigrationProvenance = {
    sourceFormat:
      row.source_format === 'ground-json'
        ? 'ground-json'
        : (() => {
            throw new EventStoreCorruptionError(
              'Migration source format is unsupported'
            )
          })(),
    sourceStateVersion: requireNumber(
      row.source_state_version,
      'migration source state version'
    ) as 2,
    sourceSha256: requireSha256(
      row.source_sha256,
      'migration source hash'
    ),
    sourceByteLength: requireNumber(
      row.source_byte_length,
      'migration source byte length'
    ),
    normalizedStateSha256: requireSha256(
      row.normalized_state_sha256,
      'migration normalized-state hash'
    ),
    migratedAt: parseTimestamp(row.migrated_at, 'migration timestamp')
  }
  if (
    provenance.sourceStateVersion !== 2 ||
    provenance.sourceSha256 !== bootstrap.sourceSha256 ||
    provenance.sourceByteLength !== bootstrap.sourceByteLength ||
    provenance.normalizedStateSha256 !== bootstrap.normalizedStateSha256
  ) {
    throw new EventStoreCorruptionError(
      'Migration provenance does not match the bootstrap event'
    )
  }
  return provenance
}

async function reconcileHeadWitness(
  witnessPath: string,
  dependencies: ReturnType<typeof normalizeDependencies>,
  metadata: LedgerMetadata,
  head: LedgerHead,
  records: readonly DecodedLedgerRecord[]
): Promise<HeadWitness> {
  const witnessStore = dependencies.witnessStore ?? fileHeadWitnessStore
  const witness = await witnessStore.read(witnessPath)
  if (!witness) {
    throw new EventStoreRollbackError(
      'Selected SQLite ledger has no external head witness'
    )
  }
  if (
    witness.databaseId !== metadata.databaseId ||
    witness.recoveryEpoch !== metadata.recoveryEpoch
  ) {
    throw new EventStoreRollbackError(
      'Head witness belongs to another database or recovery epoch'
    )
  }
  if (witness.sequence > head.sequence) {
    throw new EventStoreRollbackError(
      'Head witness is ahead of the database; filesystem rollback is blocked'
    )
  }
  if (witness.sequence === head.sequence) {
    if (
      witness.eventHash !== head.eventHash ||
      witness.transactionId !== head.transactionId
    ) {
      throw new EventStoreRollbackError(
        'Head witness and database disagree at the same sequence'
      )
    }
    return witness
  }

  if (witness.sequence === 0) {
    if (
      witness.eventHash !== GENESIS_EVENT_HASH ||
      witness.transactionId !== GENESIS_TRANSACTION_ID
    ) {
      throw new EventStoreRollbackError(
        'Behind genesis witness is invalid'
      )
    }
  } else {
    const witnessedRecord = records[witness.sequence - 1]?.record
    if (
      !witnessedRecord ||
      witnessedRecord.sequence !== witness.sequence ||
      witnessedRecord.eventHash !== witness.eventHash ||
      witnessedRecord.transactionId !== witness.transactionId
    ) {
      throw new EventStoreRollbackError(
        'Behind head witness does not identify a valid database prefix'
      )
    }
  }

  try {
    const repaired = toWitness(
      metadata,
      head,
      parseTimestamp(dependencies.now(), 'repaired witness timestamp')
    )
    await witnessStore.publish(
      witnessPath,
      repaired,
      { expected: witness }
    )
    return repaired
  } catch (error) {
    throw new EventStorePersistenceUncertainError(
      'Database is ahead of its witness and witness repair failed',
      { cause: error }
    )
  }
}

function toWitness(
  metadata: LedgerMetadata,
  head: LedgerHead,
  publishedAt: string
): HeadWitness {
  return {
    witnessVersion: HEAD_WITNESS_VERSION,
    databaseId: metadata.databaseId,
    recoveryEpoch: metadata.recoveryEpoch,
    sequence: head.sequence,
    eventHash: head.eventHash,
    transactionId: head.transactionId,
    publishedAt
  }
}

function assertMatchingHead(
  expected: Pick<LedgerHead, 'sequence' | 'eventHash'>,
  actual: Pick<LedgerHead, 'sequence' | 'eventHash'>,
  source: string
): void {
  if (
    expected.sequence !== actual.sequence ||
    expected.eventHash !== actual.eventHash
  ) {
    throw new EventStoreConflictError(
      `Expected ledger head does not match ${source}`
    )
  }
}

function readPragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get()
  const value = Object.values(row ?? {})[0]
  return requireNumber(value, `PRAGMA ${pragma}`)
}

function readPragmaString(database: DatabaseSync, pragma: string): string {
  const row = database.prepare(`PRAGMA ${pragma}`).get()
  const value = Object.values(row ?? {})[0]
  return requireString(value, `PRAGMA ${pragma}`)
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new EventStoreCorruptionError(`${label} is not a safe integer`)
  }
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new EventStoreCorruptionError(`${label} is not a string`)
  }
  return value
}

function requireSha256(value: unknown, label: string): string {
  const parsed = sha256Schema.safeParse(value)
  if (!parsed.success) {
    throw new EventStoreCorruptionError(`${label} is not a SHA-256 value`)
  }
  return parsed.data
}

function parseIdentifier(value: unknown, label: string): string {
  const parsed = identifierSchema.safeParse(value)
  if (!parsed.success) {
    throw new EventCodecError(`${label} is not a bounded identifier`, {
      cause: parsed.error
    })
  }
  return parsed.data
}

function parseTimestamp(value: unknown, label: string): string {
  const parsed = timestampSchema.safeParse(value)
  if (!parsed.success) {
    throw new EventCodecError(`${label} is not an ISO timestamp`, {
      cause: parsed.error
    })
  }
  return parsed.data
}

function assertSeparatePaths(databasePath: string, witnessPath: string): void {
  const resolvedDatabasePath = path.resolve(databasePath)
  const resolvedWitnessPath = path.resolve(witnessPath)
  if (
    resolvedDatabasePath === resolvedWitnessPath ||
    path.resolve(writerLockPath(databasePath)) === resolvedWitnessPath
  ) {
    throw new EventCodecError(
      'SQLite database, head witness, and writer lock require separate paths'
    )
  }
}

function assertBackupPathsDoNotOverlapSource(
  sourceDatabasePath: string,
  sourceWitnessPath: string,
  destinationDatabasePath: string,
  destinationWitnessPath: string
): void {
  const sources = new Set(
    [sourceDatabasePath, sourceWitnessPath].map((value) =>
      path.resolve(value)
    )
  )
  if (
    sources.has(path.resolve(destinationDatabasePath)) ||
    sources.has(path.resolve(destinationWitnessPath))
  ) {
    throw new EventStoreConflictError(
      'Backup database and witness must not overwrite the active ledger'
    )
  }
}

async function assertPathAbsent(filePath: string): Promise<void> {
  try {
    await lstat(filePath)
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }
  throw new EventStoreConflictError(
    'Refusing to overwrite an existing SQLite database'
  )
}

async function tightenDatabaseFiles(databasePath: string): Promise<void> {
  await assertPrivateRegularFile(databasePath, MAX_DATABASE_BYTES)
  for (const suffix of ['-wal', '-shm']) {
    const sidecarPath = `${databasePath}${suffix}`
    try {
      await assertPrivateRegularFile(sidecarPath, MAX_DATABASE_BYTES)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
}

interface PathIdentity {
  readonly device: bigint
  readonly inode: bigint
}

async function readPrivateDirectoryIdentity(
  directory: string
): Promise<PathIdentity> {
  const details = await lstat(directory, { bigint: true })
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      (details.mode & 0o777n) !== 0o700n)
  ) {
    throw new EventStoreCorruptionError(
      'SQLite backup staging directory is not private'
    )
  }
  return { device: details.dev, inode: details.ino }
}

async function readPrivateFileIdentity(
  filePath: string,
  maxBytes: number
): Promise<PathIdentity> {
  const details = await lstat(filePath, { bigint: true })
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > BigInt(maxBytes) ||
    (process.platform !== 'win32' &&
      (details.mode & 0o777n) !== 0o600n)
  ) {
    throw new EventStoreCorruptionError(
      'SQLite backup path is not a private bounded regular file'
    )
  }
  return { device: details.dev, inode: details.ino }
}

function assertSamePathIdentity(
  expected: PathIdentity,
  actual: PathIdentity,
  label: string
): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode
  ) {
    throw new EventStoreCorruptionError(
      `${label} changed before publication completed`
    )
  }
}

function assertPrivateBackupFilesDuringProgress(
  databasePath: string
): void {
  const stagingDirectory = lstatSync(path.dirname(databasePath))
  if (
    !stagingDirectory.isDirectory() ||
    stagingDirectory.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      (stagingDirectory.mode & 0o777) !== 0o700)
  ) {
    throw new EventStoreCorruptionError(
      'SQLite backup staging directory was not private during backup'
    )
  }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const details = lstatSync(`${databasePath}${suffix}`)
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size > MAX_DATABASE_BYTES ||
        (process.platform !== 'win32' &&
          (details.mode & 0o777) !== 0o600)
      ) {
        throw new EventStoreCorruptionError(
          'SQLite backup file was not private during backup'
        )
      }
    } catch (error) {
      if (
        suffix !== '' &&
        (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      ) {
        continue
      }
      throw error
    }
  }
}

interface CapturedFailure {
  readonly error: unknown
}

function captureFailure(
  current: CapturedFailure | undefined,
  error: unknown,
  aggregateMessage: string
): CapturedFailure {
  return {
    error: current
      ? new AggregateError(
          [current.error, error],
          aggregateMessage
        )
      : error
  }
}

async function runCleanupTasks(
  aggregateMessage: string,
  tasks: readonly (() => Promise<void>)[]
): Promise<void> {
  let failure: CapturedFailure | undefined
  for (const task of tasks) {
    try {
      await task()
    } catch (error) {
      failure = captureFailure(failure, error, aggregateMessage)
    }
  }
  if (failure) throw failure.error
}
