import { constants } from 'node:fs'
import { link, lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import {
  assertRecoveryTimestamp,
  classifySharedStateFailure,
  LegacyStateUnrecoverableError,
  selectLegacyStateGeneration,
  type LegacyCandidateFailure,
  type LegacyCandidateOutcome,
  type LegacyGenerationSelection
} from '../legacy-state-recovery'
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
  type JsonV2MigrationOutcome,
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
  readonly state: PersistedStateData
}

/**
 * The exact generation this migration is committed to, plus the digests that
 * pre-publication revalidation compares. Every field must still match under the
 * held gate or the snapshot would be published from stale legacy state.
 */
interface SelectedLegacySource {
  readonly source: 'primary' | 'retained'
  readonly retainedIndex?: number
  readonly path: string
  readonly sourceSha256: string
  readonly sourceByteLength: number
  readonly normalizedState: PersistedStateData
  readonly normalizedStateSha256: string
  readonly encountered: readonly LegacyCandidateOutcome[]
}

/**
 * Construct and publish the selected SQLite engine without modifying, rotating,
 * or deleting the legacy JSON source. The witness is published before the
 * database hard-link, so database presence remains the single engine-selection
 * signal at every crash prefix.
 */
export async function migrateJsonV2ToSqlite(
  input: JsonV2MigrationInput
): Promise<JsonV2MigrationOutcome> {
  if (!input.gate) {
    throw new JsonV2MigrationError(
      'A legacy source migration gate is required; copy-on-migrate cannot run unguarded'
    )
  }
  assertBoundedTimestamp(input.interruptedAt)
  return input.gate.withExclusiveMigration((holdForProcessExit) =>
    runGuardedMigration(input, holdForProcessExit)
  )
}

/**
 * The complete migration. Every step from initial selection through selected
 * database verification runs inside the caller's exclusive scope, so no JSON
 * writer can interleave with selection, revalidation, or publication.
 */
async function runGuardedMigration(
  input: JsonV2MigrationInput,
  holdForProcessExit: () => void
): Promise<JsonV2MigrationOutcome> {
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

  const source = await selectMigrationSource(
    input.sourceJsonPath,
    input.interruptedAt
  )
  if (!source) {
    // Nothing to migrate. There is no truthful legacy source, and the only
    // bootstrap kind is legacy-state.bootstrapped, so no database or witness is
    // created and the filesystem is left untouched.
    return { outcome: 'no-legacy-source' }
  }
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
      // Repeat the complete bounded selection with the same strict reader and
      // the same injected instant. A changed primary, a different retained
      // generation, a different error classification, or changed bytes all mean
      // the snapshot would be published from stale legacy state.
      const sourceBeforePublish = await selectMigrationSource(
        input.sourceJsonPath,
        input.interruptedAt
      )
      if (
        !sourceBeforePublish ||
        sourceBeforePublish.source !== source.source ||
        sourceBeforePublish.retainedIndex !== source.retainedIndex ||
        sourceBeforePublish.path !== source.path ||
        sourceBeforePublish.sourceByteLength !== source.sourceByteLength ||
        sourceBeforePublish.sourceSha256 !== source.sourceSha256 ||
        sourceBeforePublish.normalizedStateSha256 !==
          source.normalizedStateSha256 ||
        !sameEncounteredOutcomes(
          sourceBeforePublish.encountered,
          source.encountered
        )
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
      // A database now exists, so database presence already selects SQLite while
      // this process still owns a JSON StateStore. Hold before any later step can
      // fail, so no failure path can reopen the source gate.
      holdForProcessExit()
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
        head: selectedHead,
        sourceGeneration: source.source,
        ...(source.retainedIndex === undefined
          ? {}
          : { retainedIndex: source.retainedIndex }),
        unreadableGenerationCount: source.encountered.length
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
  return { outcome: 'migrated', ...result }
}

function sameEncounteredOutcomes(
  left: readonly LegacyCandidateOutcome[],
  right: readonly LegacyCandidateOutcome[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (outcome, index) =>
        outcome.path === right[index]?.path &&
        outcome.failure === right[index]?.failure
    )
  )
}

function assertBoundedTimestamp(value: string): void {
  try {
    assertRecoveryTimestamp(value, 'interruptedAt')
  } catch (error) {
    throw new JsonV2MigrationError(
      'A bounded ISO-8601 interruptedAt timestamp is required',
      { cause: error }
    )
  }
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
  // A document that is not a state object at all, or whose version field is not
  // a usable version number, is damaged rather than versioned. Those may fall
  // through to an older generation. Only a well-formed version that this reader
  // cannot accept is version evidence, which fails closed.
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventStoreCorruptionError(
      'Legacy JSON state is not a state object'
    )
  }
  const declaredVersion = (value as { version?: unknown }).version
  if (
    typeof declaredVersion !== 'number' ||
    !Number.isSafeInteger(declaredVersion) ||
    declaredVersion < 1
  ) {
    throw new EventStoreCorruptionError(
      'Legacy JSON state does not declare a usable persisted-state version'
    )
  }
  if (declaredVersion !== CURRENT_PERSISTED_STATE_VERSION) {
    throw new EventStoreVersionError(
      'projection',
      `Copy-on-migrate requires exact JSON state version ${CURRENT_PERSISTED_STATE_VERSION}`
    )
  }

  let state: PersistedStateData
  try {
    state = parsePersistedState(value)
  } catch (error) {
    // Version and migration-contract evidence must survive as itself so the
    // shared policy can fail closed instead of inspecting an older generation.
    const shared = classifySharedStateFailure(error)
    if (shared === 'version') {
      throw new EventStoreVersionError(
        'projection',
        `Copy-on-migrate requires exact JSON state version ${CURRENT_PERSISTED_STATE_VERSION}`,
        { cause: error }
      )
    }
    if (shared === 'contract') throw error
    throw new EventStoreCorruptionError(
      'Legacy JSON v2 failed persisted-state validation',
      { cause: error }
    )
  }
  return {
    rawBytes,
    sourceSha256: sha256(rawBytes),
    sourceByteLength: rawBytes.byteLength,
    state
  }
}

/**
 * Classify the strict migration reader's failures for the shared policy.
 *
 * A missing generation may fall through. Structural damage may fall through.
 * Any non-v2 version — older, newer, or malformed — fails closed: the bootstrap
 * event records `sourceStateVersion` as exactly 2 while `sourceSha256` hashes
 * the selected file, so migrating a v1 document would make those two fields
 * describe different things.
 */
function classifyMigrationSourceFailure(
  error: unknown
): LegacyCandidateFailure {
  const shared = classifySharedStateFailure(error)
  if (shared) return shared
  if (error instanceof EventStoreVersionError) return 'version'
  if (error instanceof EventStoreCorruptionError) return 'corrupt'
  if (isMissingFileError(error)) return 'missing'
  return 'operational'
}

/**
 * Select the newest valid generation and apply deterministic recovery, using
 * only the strict read-only reader. Never mutates, quarantines, or rewrites.
 */
async function selectMigrationSource(
  primaryPath: string,
  interruptedAt: string
): Promise<SelectedLegacySource | undefined> {
  let selection: LegacyGenerationSelection<ReadJsonV2Source>
  try {
    selection = await selectLegacyStateGeneration<ReadJsonV2Source>(
      primaryPath,
      {
        read: readJsonV2Source,
        classify: classifyMigrationSourceFailure,
        interruptedAt
      }
    )
  } catch (error) {
    if (error instanceof LegacyStateUnrecoverableError) {
      // At least one generation exists and none validated. This must never look
      // like a fresh install, so it fails visibly and publishes nothing.
      throw new EventStoreCorruptionError(
        'No valid legacy JSON generation remains; SQLite migration was refused',
        { cause: error }
      )
    }
    throw error
  }
  if (selection.source === 'none') return undefined
  const normalized = encodeProjection(selection.state)
  return {
    source: selection.source,
    ...(selection.source === 'retained'
      ? { retainedIndex: selection.retainedIndex }
      : {}),
    path: selection.path,
    sourceSha256: selection.candidate.sourceSha256,
    sourceByteLength: selection.candidate.sourceByteLength,
    normalizedState: normalized.state,
    normalizedStateSha256: normalized.stateSha256,
    encountered: selection.encountered
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
