import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
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

export async function removeIfPresent(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
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
