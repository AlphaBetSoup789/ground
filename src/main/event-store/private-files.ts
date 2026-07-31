import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  rmdir,
  unlink
} from 'node:fs/promises'
import path from 'node:path'
import { EventStoreCorruptionError } from './errors'

export async function ensureParentDirectory(filePath: string): Promise<string> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}

export async function createPrivateEmptyFile(filePath: string): Promise<void> {
  await ensureParentDirectory(filePath)
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
}

export async function assertPrivateRegularFile(
  filePath: string,
  maxBytes: number
): Promise<void> {
  const details = await lstat(filePath)
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new EventStoreCorruptionError(
      'Event-store path is not a regular file'
    )
  }
  if (details.size > maxBytes) {
    throw new EventStoreCorruptionError(
      'Event-store file exceeds its byte limit'
    )
  }
  if (process.platform !== 'win32' && (details.mode & 0o777) !== 0o600) {
    await chmod(filePath, 0o600)
  }
}

export async function createPrivateTemporaryPath(
  targetPath: string,
  suffix: string
): Promise<string> {
  const directory = await ensureParentDirectory(targetPath)
  return path.join(
    directory,
    `.${path.basename(targetPath)}.${randomUUID()}.${suffix}`
  )
}

export async function createPrivateTemporaryDirectory(
  targetPath: string,
  suffix: string
): Promise<string> {
  const parentDirectory = await ensureParentDirectory(targetPath)
  const directory = path.join(
    parentDirectory,
    `.${path.basename(targetPath)}.${randomUUID()}.${suffix}`
  )
  await mkdir(directory, { mode: 0o700 })
  try {
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new EventStoreCorruptionError(
        'Temporary event-store staging path is not a directory'
      )
    }
    if (
      process.platform !== 'win32' &&
      (details.mode & 0o777) !== 0o700
    ) {
      await chmod(directory, 0o700)
    }
    return directory
  } catch (error) {
    try {
      await rmdir(directory)
    } catch (cleanupError) {
      throw new EventStoreCorruptionError(
        'Temporary event-store staging validation and cleanup both failed',
        { cause: new AggregateError([error, cleanupError]) }
      )
    }
    throw error
  }
}

export async function removePrivateTemporaryDirectory(
  directory: string
): Promise<void> {
  await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export async function removeIfPresent(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export async function removeSqliteFileSet(
  databasePath: string
): Promise<void> {
  const results = await Promise.allSettled(
    ['', '-wal', '-shm', '-journal'].map((suffix) =>
      removeIfPresent(`${databasePath}${suffix}`)
    )
  )
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'SQLite file-set cleanup failed'
    )
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (
      code === 'EINVAL' ||
      code === 'ENOTSUP' ||
      code === 'ENOSYS' ||
      code === 'EISDIR' ||
      (process.platform === 'win32' && code === 'EPERM')
    ) {
      return
    }
    throw error
  }
}

export function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
