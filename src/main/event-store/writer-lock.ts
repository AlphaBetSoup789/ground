import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  EventStoreConflictError,
  EventStoreCorruptionError,
  EventStorePersistenceUncertainError
} from './errors'
import {
  assertPrivateRegularFile,
  ensureParentDirectory,
  isMissingFileError
} from './private-files'

const WRITER_LOCK_APPLICATION_ID = 1_196_576_325
const MAX_WRITER_LOCK_BYTES = 1024 * 1024
const WRITER_LOCK_WAIT_MS = 10
const WRITER_LOCK_TIMEOUT_MS = 10_000
const SQLITE_FILE_SUFFIXES = ['', '-journal', '-wal', '-shm'] as const
const COORDINATION_TABLE_SQL = `CREATE TABLE coordination_lock (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          generation INTEGER NOT NULL CHECK (generation = 0)
        ) STRICT`

export function writerLockPath(databasePath: string): string {
  return path.join(
    path.dirname(databasePath),
    `${path.basename(databasePath)}.writer-lock.sqlite`
  )
}

export function witnessPublicationLockPath(
  witnessPath: string
): string {
  return path.join(
    path.dirname(witnessPath),
    `${path.basename(witnessPath)}.publication-lock.sqlite`
  )
}

export async function assertCoordinationPathNamespace(
  databasePaths: readonly string[],
  witnessPaths: readonly string[],
  otherProtectedPaths: readonly string[] = []
): Promise<void> {
  const [databaseEntries, witnessEntries, otherEntries] =
    await Promise.all([
      Promise.all(databasePaths.map(canonicalNamespaceEntry)),
      Promise.all(witnessPaths.map(canonicalNamespaceEntry)),
      Promise.all(otherProtectedPaths.map(canonicalNamespaceEntry))
    ])
  const databases = databaseEntries.map(({ key }) => key)
  const witnesses = witnessEntries.map(({ key }) => key)
  const otherPaths = otherEntries.map(({ key }) => key)
  const primaryPaths = [...databases, ...witnesses, ...otherPaths]
  const ledgerEntries = databaseEntries.flatMap((entry) =>
    sqliteFileEntries(entry.filePath)
  )
  const plainProtectedEntries = [
    ...witnessEntries,
    ...otherEntries
  ]
  const coordinationDatabaseEntries = [
    ...databaseEntries.map(({ filePath }) =>
      namespaceEntry(writerLockPath(filePath))
    ),
    ...witnessEntries.map(({ filePath }) =>
      namespaceEntry(witnessPublicationLockPath(filePath))
    )
  ]
  const coordinationEntries = coordinationDatabaseEntries.flatMap(
    ({ filePath }) => sqliteFileEntries(filePath)
  )
  const ledgerPaths = ledgerEntries.map(({ key }) => key)
  const plainProtectedPaths = plainProtectedEntries.map(
    ({ key }) => key
  )
  const coordinationPaths = coordinationEntries.map(
    ({ key }) => key
  )
  const ledgerPathSet = new Set(ledgerPaths)
  const plainProtectedPathSet = new Set(plainProtectedPaths)
  if (
    new Set(primaryPaths).size !== primaryPaths.length ||
    ledgerPathSet.size !== ledgerPaths.length ||
    plainProtectedPathSet.size !== plainProtectedPaths.length ||
    plainProtectedPaths.some((value) => ledgerPathSet.has(value)) ||
    coordinationPaths.some(
      (value) =>
        ledgerPathSet.has(value) ||
        plainProtectedPathSet.has(value)
    ) ||
    new Set(coordinationPaths).size !== coordinationPaths.length
  ) {
    throw new EventStoreConflictError(
      'Ledger paths collide with a reserved event-store file namespace'
    )
  }
  const existingPaths = await assertNoExistingPathAliases([
    ...ledgerEntries,
    ...plainProtectedEntries,
    ...coordinationEntries
  ])
  for (const database of [
    ...databaseEntries,
    ...coordinationDatabaseEntries
  ]) {
    const [mainEntry, ...sidecarEntries] = sqliteFileEntries(
      database.filePath
    )
    if (
      mainEntry &&
      !existingPaths.has(mainEntry.key) &&
      sidecarEntries.some(({ key }) => existingPaths.has(key))
    ) {
      throw new EventStoreConflictError(
        'A reserved SQLite sidecar exists without its database'
      )
    }
  }
}

/**
 * Serialize the commit -> external-witness publication interval across
 * processes. A separate SQLite file is used because its OS-backed write lock
 * is released automatically if a process crashes. Acquisition uses timeout=0
 * plus an asynchronous retry so a contending writer cannot block the Electron
 * main loop while the lock holder awaits filesystem durability.
 */
export async function withLedgerWriterLock<T>(
  databasePath: string,
  operation: () => Promise<T>
): Promise<T> {
  return withLedgerWriterLocks([databasePath], operation)
}

export async function withLedgerWriterLocks<T>(
  databasePaths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const requestedPaths = [
    ...new Set(databasePaths.map((value) => path.resolve(value)))
  ]
  const orderedPaths = (
    await Promise.all(
      requestedPaths.map(canonicalNamespaceEntry)
    )
  ).sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  )
  if (
    new Set(orderedPaths.map(({ key }) => key)).size !==
    orderedPaths.length
  ) {
    throw new EventStoreConflictError(
      'Ledger paths collide with a reserved event-store file namespace'
    )
  }
  await assertCoordinationPathNamespace(
    orderedPaths.map(({ filePath }) => filePath),
    []
  )

  const acquireAt = async (index: number): Promise<T> => {
    const database = orderedPaths[index]
    if (!database) return operation()
    const release = await acquireCoordinationLock(
      writerLockPath(database.filePath)
    )
    try {
      return await acquireAt(index + 1)
    } finally {
      await release()
    }
  }

  return acquireAt(0)
}

export async function withWitnessPublicationLock<T>(
  witnessPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const canonicalWitness =
    await canonicalNamespaceEntry(witnessPath)
  await assertCoordinationPathNamespace(
    [],
    [canonicalWitness.filePath]
  )
  const release = await acquireCoordinationLock(
    witnessPublicationLockPath(canonicalWitness.filePath)
  )
  try {
    return await operation()
  } finally {
    await release()
  }
}

async function acquireCoordinationLock(
  lockPath: string
): Promise<() => Promise<void>> {
  await ensurePrivateLockFile(lockPath)
  const deadline = Date.now() + WRITER_LOCK_TIMEOUT_MS

  while (true) {
    let database: DatabaseSync | undefined
    try {
      database = openLockDatabase(lockPath)
      database.exec('BEGIN IMMEDIATE')
      initializeOrVerifyCoordinationDatabase(database)
      const acquiredDatabase = database
      let released = false
      return async () => {
        if (released) return
        released = true
        let releaseError: unknown
        try {
          acquiredDatabase.exec('COMMIT')
        } catch (error) {
          releaseError = error
          try {
            acquiredDatabase.exec('ROLLBACK')
          } catch {
            // Preserve the uncertain release.
          }
        }
        try {
          acquiredDatabase.close()
        } catch (error) {
          releaseError ??= error
        }
        await assertPrivateRegularFile(
          lockPath,
          MAX_WRITER_LOCK_BYTES
        ).catch((error) => {
          releaseError ??= error
        })
        if (releaseError) {
          throw new EventStorePersistenceUncertainError(
            'Ledger writer-lock release is uncertain',
            { cause: releaseError }
          )
        }
      }
    } catch (error) {
      if (database) {
        try {
          database.close()
        } catch {
          // Preserve the acquisition error.
        }
      }
      if (!isSqliteBusy(error) || Date.now() >= deadline) {
        throw new EventStorePersistenceUncertainError(
          isSqliteBusy(error)
            ? 'Timed out waiting for the ledger writer lock'
            : 'Ledger writer-lock acquisition failed',
          { cause: error }
        )
      }
      await delay(WRITER_LOCK_WAIT_MS)
    }
  }
}

async function ensurePrivateLockFile(filePath: string): Promise<void> {
  await ensureParentDirectory(filePath)
  try {
    const handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    )
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST'
    ) {
      throw error
    }
  }
  try {
    await assertPrivateRegularFile(filePath, MAX_WRITER_LOCK_BYTES)
  } catch (error) {
    if (isMissingFileError(error)) {
      return ensurePrivateLockFile(filePath)
    }
    throw error
  }
}

function openLockDatabase(filePath: string): DatabaseSync {
  const database = new DatabaseSync(filePath, {
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
    database.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA busy_timeout = 0;
    `)
    return database
  } catch (error) {
    try {
      database.close()
    } catch {
      // Preserve the configuration error.
    }
    throw error
  }
}

function initializeOrVerifyCoordinationDatabase(
  database: DatabaseSync
): void {
  const applicationId = readPragmaNumber(database, 'application_id')
  const schema = readCoordinationSchema(database)
  if (applicationId === 0 && schema.length === 0) {
    database.exec(`
      PRAGMA application_id = ${WRITER_LOCK_APPLICATION_ID};
      ${COORDINATION_TABLE_SQL};
      INSERT INTO coordination_lock (singleton, generation)
      VALUES (1, 0);
    `)
  } else {
    if (applicationId !== WRITER_LOCK_APPLICATION_ID) {
      throw new EventStoreCorruptionError(
        'Coordination path belongs to another SQLite database'
      )
    }
    if (
      schema.length !== 1 ||
      schema[0]?.type !== 'table' ||
      schema[0]?.name !== 'coordination_lock' ||
      schema[0]?.tableName !== 'coordination_lock' ||
      schema[0]?.sql !== COORDINATION_TABLE_SQL
    ) {
      throw new EventStoreCorruptionError(
        'Coordination database schema is invalid'
      )
    }
    const row = database
      .prepare(
        'SELECT singleton, generation FROM coordination_lock'
      )
      .all()
    if (
      row.length !== 1 ||
      row[0]?.singleton !== 1 ||
      row[0]?.generation !== 0
    ) {
      throw new EventStoreCorruptionError(
        'Coordination database sentinel is invalid'
      )
    }
  }
  if (
    readPragmaString(database, 'journal_mode').toLowerCase() !== 'delete'
  ) {
    throw new EventStoreCorruptionError(
      'Coordination database journal mode is not DELETE'
    )
  }
}

function readCoordinationSchema(
  database: DatabaseSync
): Array<{
  readonly type: string
  readonly name: string
  readonly tableName: string
  readonly sql: string | null
}> {
  return database
    .prepare(
      'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name'
    )
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      tableName: String(row.tbl_name),
      sql: row.sql === null ? null : String(row.sql)
    }))
}

function readPragmaNumber(
  database: DatabaseSync,
  pragma: string
): number {
  const value = Object.values(
    database.prepare(`PRAGMA ${pragma}`).get() ?? {}
  )[0]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new EventStoreCorruptionError(
      `Coordination PRAGMA ${pragma} is invalid`
    )
  }
  return value
}

function readPragmaString(
  database: DatabaseSync,
  pragma: string
): string {
  const value = Object.values(
    database.prepare(`PRAGMA ${pragma}`).get() ?? {}
  )[0]
  if (typeof value !== 'string') {
    throw new EventStoreCorruptionError(
      `Coordination PRAGMA ${pragma} is invalid`
    )
  }
  return value
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 'ERR_SQLITE_ERROR' &&
    /\b(?:busy|locked)\b/iu.test(String((error as Error).message))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function namespaceEntry(filePath: string): CanonicalNamespaceEntry {
  return {
    filePath,
    key: normalizeNamespaceKey(filePath)
  }
}

function sqliteFileEntries(
  databasePath: string
): CanonicalNamespaceEntry[] {
  return SQLITE_FILE_SUFFIXES.map((suffix) =>
    namespaceEntry(`${databasePath}${suffix}`)
  )
}

interface CanonicalNamespaceEntry {
  readonly filePath: string
  readonly key: string
}

async function canonicalNamespaceEntry(
  filePath: string
): Promise<CanonicalNamespaceEntry> {
  const absolutePath = path.resolve(filePath)
  const unresolvedSegments = [path.basename(absolutePath)]
  let candidate = path.dirname(absolutePath)

  while (true) {
    try {
      const canonicalParent = await realpath(candidate)
      const canonicalPath = path.join(
        canonicalParent,
        ...unresolvedSegments
      )
      return {
        filePath: canonicalPath,
        key: normalizeNamespaceKey(canonicalPath)
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT'
      ) {
        throw error
      }
      const parent = path.dirname(candidate)
      if (parent === candidate) throw error
      unresolvedSegments.unshift(path.basename(candidate))
      candidate = parent
    }
  }
}

function normalizeNamespaceKey(filePath: string): string {
  const normalized = path.normalize(filePath).normalize('NFC')
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized
}

async function assertNoExistingPathAliases(
  entries: readonly CanonicalNamespaceEntry[]
): Promise<Set<string>> {
  const identities = await Promise.all(
    entries.map(async (entry) => {
      try {
        const details = await lstat(entry.filePath, { bigint: true })
        if (!details.isFile() || details.isSymbolicLink()) {
          throw new EventStoreConflictError(
            'A reserved event-store path is symbolic or non-regular'
          )
        }
        if (details.nlink !== 1n) {
          throw new EventStoreCorruptionError(
            'A reserved event-store path has multiple hard links through an external hard-link alias'
          )
        }
        return {
          entry,
          identity: `${details.dev}:${details.ino}`
        }
      } catch (error) {
        if (isMissingFileError(error)) return undefined
        throw error
      }
    })
  )
  const pathsByIdentity = new Map<string, string>()
  const existingPaths = new Set<string>()
  for (const existing of identities) {
    if (!existing) continue
    existingPaths.add(existing.entry.key)
    const priorPath = pathsByIdentity.get(existing.identity)
    if (priorPath && priorPath !== existing.entry.key) {
      throw new EventStoreConflictError(
        'Ledger paths collide through an existing hard-link alias'
      )
    }
    pathsByIdentity.set(existing.identity, existing.entry.key)
  }
  return existingPaths
}
