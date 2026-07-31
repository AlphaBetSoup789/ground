import { constants } from 'node:fs'
import { link, lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import {
  CURRENT_PERSISTED_STATE_VERSION,
  parsePersistedState,
  type PersistedStateData
} from '../state-schema'
import { encodeProjection, sha256 } from './codec'
import {
  EventStoreConflictError,
  EventStoreCorruptionError,
  EventStorePersistenceUncertainError,
  EventStoreVersionError,
  JsonV2MigrationError
} from './errors'
import {
  assertPrivateRegularFile,
  createPrivateTemporaryPath,
  isMissingFileError,
  removeIfPresent,
  removeSqliteFileSet,
  syncDirectory
} from './private-files'
import { SqliteEventStore } from './sqlite-event-store'
import {
  MAX_PROJECTION_BYTES,
  MAX_DATABASE_BYTES,
  type HeadWitness,
  type JsonV2MigrationInput,
  type JsonV2MigrationResult
} from './types'
import {
  defaultWitnessPath,
  fileHeadWitnessStore
} from './witness'
import {
  assertCoordinationPathNamespace,
  withLedgerWriterLock,
  witnessPublicationLockPath,
  writerLockPath
} from './writer-lock'

const READ_CHUNK_BYTES = 64 * 1024

interface ReadJsonV2Source {
  readonly rawBytes: Buffer
  readonly sourceSha256: string
  readonly sourceByteLength: number
  readonly normalizedState: PersistedStateData
  readonly normalizedStateSha256: string
}

/**
 * Construct and publish the selected SQLite engine without modifying, rotating,
 * or deleting the legacy JSON source. The witness is published before the
 * database hard-link, so database presence remains the single engine-selection
 * signal at every crash prefix.
 */
export async function migrateJsonV2ToSqlite(
  input: JsonV2MigrationInput
): Promise<JsonV2MigrationResult> {
  const witnessPath =
    input.witnessPath ?? defaultWitnessPath(input.databasePath)
  assertDistinctMigrationPaths(
    input.sourceJsonPath,
    input.databasePath,
    witnessPath
  )
  await assertCoordinationPathNamespace(
    [input.databasePath],
    [witnessPath],
    [input.sourceJsonPath]
  )
  await assertDatabaseAbsent(input.databasePath)

  const source = await readJsonV2Source(input.sourceJsonPath)
  input.fault?.('after-source-read')

  const temporaryDatabasePath = await createPrivateTemporaryPath(
    input.databasePath,
    'migration.sqlite'
  )
  const temporaryWitnessPath = defaultWitnessPath(temporaryDatabasePath)
  let databasePublished = false
  let finalWitnessPublished = false
  let publishedHead: JsonV2MigrationResult['head'] | undefined
  let result: JsonV2MigrationResult | undefined
  const failures: unknown[] = []

  try {
    const store = await SqliteEventStore.create({
      databasePath: temporaryDatabasePath,
      witnessPath: temporaryWitnessPath,
      dependencies: input.dependencies,
      bootstrap: {
        kind: 'legacy-state.bootstrapped',
        sourceFormat: 'ground-json',
        sourceStateVersion: CURRENT_PERSISTED_STATE_VERSION,
        sourceSha256: source.sourceSha256,
        sourceByteLength: source.sourceByteLength,
        normalizedStateSha256: source.normalizedStateSha256,
        state: source.normalizedState
      }
    })
    await store.close()
    input.fault?.('after-temporary-created')

    const verifiedTemporary = await SqliteEventStore.open({
      databasePath: temporaryDatabasePath,
      witnessPath: temporaryWitnessPath,
      dependencies: input.dependencies,
      integrityCheck: 'full'
    })
    const verifiedHead = verifiedTemporary.getHead()
    publishedHead = verifiedHead
    const verifiedProjection = encodeProjection(
      verifiedTemporary.getProjection()
    )
    await verifiedTemporary.close()
    if (
      verifiedProjection.stateSha256 !== source.normalizedStateSha256
    ) {
      throw new JsonV2MigrationError(
        'Temporary SQLite projection does not match normalized JSON v2'
      )
    }
    input.fault?.('after-temporary-verified')

    const witnessStore =
      input.dependencies?.witnessStore ?? fileHeadWitnessStore
    const temporaryWitness = await witnessStore.read(
      temporaryWitnessPath
    )
    if (!temporaryWitness) {
      throw new JsonV2MigrationError(
        'Verified temporary SQLite database has no head witness'
      )
    }
    assertWitnessMatchesHead(temporaryWitness, verifiedHead)
    await withLedgerWriterLock(input.databasePath, async () => {
      await assertDatabaseAbsent(input.databasePath)
      const sourceBeforePublish = await readJsonV2Source(
        input.sourceJsonPath
      )
      if (
        sourceBeforePublish.sourceByteLength !== source.sourceByteLength ||
        sourceBeforePublish.sourceSha256 !== source.sourceSha256 ||
        sourceBeforePublish.normalizedStateSha256 !==
          source.normalizedStateSha256
      ) {
        throw new JsonV2MigrationError(
          'Legacy JSON state changed during migration; publication was refused'
        )
      }

      const existingFinalWitness = await witnessStore.read(witnessPath)
      await witnessStore.publish(witnessPath, temporaryWitness, {
        expected: existingFinalWitness ?? null
      })
      finalWitnessPublished = true
      input.fault?.('after-witness-published')

      await link(temporaryDatabasePath, input.databasePath)
      databasePublished = true
      await syncDirectory(path.dirname(input.databasePath))
      await assertPrivateRegularFile(
        input.databasePath,
        MAX_DATABASE_BYTES,
        { expectedLinkCount: 2 }
      )
      input.fault?.('after-database-published')
    })
  } catch (error) {
    failures.push(error)
  }

  try {
    input.fault?.('before-migration-temporary-cleanup')
  } catch (error) {
    failures.push(error)
  }
  try {
    const cleanupResults = await Promise.allSettled([
      removeSqliteFileSet(temporaryDatabasePath),
      removeIfPresent(temporaryWitnessPath),
      removeSqliteFileSet(writerLockPath(temporaryDatabasePath)),
      removeSqliteFileSet(
        witnessPublicationLockPath(temporaryWitnessPath)
      )
    ])
    for (const cleanupResult of cleanupResults) {
      if (cleanupResult.status === 'rejected') {
        failures.push(cleanupResult.reason)
      }
    }
    await syncDirectory(path.dirname(temporaryDatabasePath))
  } catch (error) {
    failures.push(error)
  }

  if (failures.length > 0) {
    const error =
      failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            'SQLite migration and its temporary cleanup both failed'
          )
    if (databasePublished) {
      throw new EventStorePersistenceUncertainError(
        'SQLite migration database was published; selected-engine verification must succeed before retry',
        { cause: error }
      )
    }
    if (error instanceof JsonV2MigrationError) throw error
    throw new JsonV2MigrationError(
      finalWitnessPublished
        ? 'SQLite migration stopped after witness publication but before database selection'
        : 'SQLite JSON v2 migration failed before database selection',
      { cause: error }
    )
  }
  if (databasePublished && publishedHead) {
    let selected: SqliteEventStore | undefined
    const verificationFailures: unknown[] = []
    try {
      await assertPrivateRegularFile(
        input.databasePath,
        MAX_DATABASE_BYTES
      )
      selected = await SqliteEventStore.open({
        databasePath: input.databasePath,
        witnessPath,
        dependencies: input.dependencies,
        integrityCheck: 'full'
      })
      const selectedHead = selected.getHead()
      if (
        selectedHead.sequence !== publishedHead.sequence ||
        selectedHead.eventHash !== publishedHead.eventHash
      ) {
        throw new JsonV2MigrationError(
          'Published SQLite head changed after verified migration'
        )
      }
      result = {
        sourceSha256: source.sourceSha256,
        normalizedStateSha256: source.normalizedStateSha256,
        sourceByteLength: source.sourceByteLength,
        head: selectedHead
      }
    } catch (error) {
      verificationFailures.push(error)
    }
    if (selected) {
      try {
        await selected.close()
      } catch (error) {
        verificationFailures.push(error)
      }
    }
    if (verificationFailures.length > 0) {
      throw new EventStorePersistenceUncertainError(
        'SQLite migration database was published but selected-engine verification failed',
        {
          cause:
            verificationFailures.length === 1
              ? verificationFailures[0]
              : new AggregateError(
                  verificationFailures,
                  'SQLite migration verification and selected-store close both failed'
                )
        }
      )
    }
  }
  if (!result) {
    throw new JsonV2MigrationError(
      'SQLite JSON v2 migration completed without a result'
    )
  }
  return result
}

async function readJsonV2Source(
  filePath: string
): Promise<ReadJsonV2Source> {
  const rawBytes = await readBoundedNoFollow(filePath)
  if (rawBytes.byteLength === 0) {
    throw new EventStoreCorruptionError('Legacy JSON state is empty')
  }
  let value: unknown
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)
    )
  } catch (error) {
    throw new EventStoreCorruptionError(
      'Legacy JSON state is not valid UTF-8 JSON',
      { cause: error }
    )
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !==
      CURRENT_PERSISTED_STATE_VERSION
  ) {
    throw new EventStoreVersionError(
      'projection',
      `Copy-on-migrate requires exact JSON state version ${CURRENT_PERSISTED_STATE_VERSION}`
    )
  }

  let normalizedState: PersistedStateData
  try {
    normalizedState = parsePersistedState(value)
  } catch (error) {
    throw new EventStoreCorruptionError(
      'Legacy JSON v2 failed persisted-state validation',
      { cause: error }
    )
  }
  const normalized = encodeProjection(normalizedState)
  return {
    rawBytes,
    sourceSha256: sha256(rawBytes),
    sourceByteLength: rawBytes.byteLength,
    normalizedState: normalized.state,
    normalizedStateSha256: normalized.stateSha256
  }
}

async function readBoundedNoFollow(filePath: string): Promise<Buffer> {
  const pathDetails = await lstat(filePath)
  if (!pathDetails.isFile() || pathDetails.isSymbolicLink()) {
    throw new EventStoreCorruptionError(
      'Legacy JSON source is not a regular file'
    )
  }
  if (pathDetails.nlink !== 1) {
    throw new EventStoreCorruptionError(
      'Legacy JSON source has multiple hard links'
    )
  }
  if (pathDetails.size > MAX_PROJECTION_BYTES) {
    throw new EventStoreCorruptionError(
      'Legacy JSON source exceeds its byte limit'
    )
  }

  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlocking =
    typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  const handle = await open(
    filePath,
    constants.O_RDONLY | noFollow | nonBlocking
  )
  try {
    const details = await handle.stat()
    if (
      !details.isFile() ||
      details.dev !== pathDetails.dev ||
      details.ino !== pathDetails.ino
    ) {
      throw new EventStoreCorruptionError(
        'Legacy JSON source changed while it was being opened'
      )
    }
    if (details.nlink !== 1) {
      throw new EventStoreCorruptionError(
        'Legacy JSON source has multiple hard links'
      )
    }
    if (details.size > MAX_PROJECTION_BYTES) {
      throw new EventStoreCorruptionError(
        'Legacy JSON source exceeds its byte limit'
      )
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes <= MAX_PROJECTION_BYTES) {
      const remaining = MAX_PROJECTION_BYTES + 1 - totalBytes
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, remaining)
      )
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.byteLength,
        null
      )
      if (bytesRead === 0) break
      totalBytes += bytesRead
      chunks.push(chunk.subarray(0, bytesRead))
    }
    if (totalBytes > MAX_PROJECTION_BYTES) {
      throw new EventStoreCorruptionError(
        'Legacy JSON source exceeds its byte limit'
      )
    }
    const completedDetails = await handle.stat()
    if (completedDetails.nlink !== 1) {
      throw new EventStoreCorruptionError(
        'Legacy JSON source gained another hard link while it was read'
      )
    }
    return Buffer.concat(chunks, totalBytes)
  } finally {
    await handle.close()
  }
}

function assertWitnessMatchesHead(
  witness: HeadWitness,
  head: JsonV2MigrationResult['head']
): void {
  if (
    witness.sequence !== head.sequence ||
    witness.eventHash !== head.eventHash ||
    witness.transactionId !== head.transactionId
  ) {
    throw new JsonV2MigrationError(
      'Temporary witness does not match the verified SQLite head'
    )
  }
}

async function assertDatabaseAbsent(filePath: string): Promise<void> {
  try {
    await lstat(filePath)
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }
  throw new EventStoreConflictError(
    'Published SQLite database already selects the event-store engine'
  )
}

function assertDistinctMigrationPaths(
  sourcePath: string,
  databasePath: string,
  witnessPath: string
): void {
  const distinct = new Set(
    [sourcePath, databasePath, witnessPath].map((value) =>
      path.resolve(value)
    )
  )
  if (distinct.size !== 3) {
    throw new JsonV2MigrationError(
      'Legacy JSON, SQLite database, and head witness require distinct paths'
    )
  }
  if (path.resolve(witnessPath) === path.resolve(writerLockPath(databasePath))) {
    throw new JsonV2MigrationError(
      'Migration witness path is reserved for the ledger writer lock'
    )
  }
}
