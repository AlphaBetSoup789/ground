import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'

export const GIT_EXECUTABLE_PREFERENCE_FILENAME =
  'git-executable-preference.json'

const MAX_PREFERENCE_FILE_BYTES = 16 * 1024
const MAX_EXECUTABLE_PATH_CHARACTERS = 32_767
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

const canonicalExecutablePathSchema = z
  .string()
  .min(1)
  .max(MAX_EXECUTABLE_PATH_CHARACTERS)
  .refine((value) => !/[\0-\x1f\x7f]/u.test(value), {
    message: 'Git executable path contains unsafe control characters'
  })
  .refine((value) => path.isAbsolute(value), {
    message: 'Git executable path must be absolute'
  })
  .refine(
    (value) => path.normalize(value) === value && path.resolve(value) === value,
    {
      message: 'Git executable path must be normalized'
    }
  )
  .refine(
    (value) =>
      process.platform !== 'win32' ||
      (!value.startsWith('\\\\.\\') &&
        !value.startsWith('\\\\?\\') &&
        path.win32.extname(value).toLowerCase() === '.exe'),
    {
      message: 'Git executable path is not a direct Windows executable'
    }
  )

const preferenceSchema = z
  .object({
    version: z.literal(1),
    path: canonicalExecutablePathSchema,
    fingerprint: z.string().regex(SHA256_PATTERN)
  })
  .strict()

export interface GitExecutablePreference {
  readonly version: 1
  readonly path: string
  readonly fingerprint: string
}

export interface GitExecutablePreferenceInput {
  readonly path: string
  readonly fingerprint: string
}

export type GitExecutablePreferenceLoadResult =
  | Readonly<{ status: 'missing' }>
  | Readonly<{
      status: 'loaded'
      preference: GitExecutablePreference
    }>
  | Readonly<{
      status: 'quarantined'
      quarantinedPath: string
      reason: string
    }>

class InvalidGitExecutablePreferenceFileError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'InvalidGitExecutablePreferenceFileError'
  }
}

interface FileSnapshot {
  readonly device: number
  readonly inode: number
  readonly size: number
  readonly modifiedMs: number
  readonly changedMs: number
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function freezePreference(value: unknown): GitExecutablePreference {
  const parsed = preferenceSchema.parse(value)
  return Object.freeze({
    version: 1,
    path: parsed.path,
    fingerprint: parsed.fingerprint
  })
}

function snapshotOf(details: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}): FileSnapshot {
  return {
    device: details.dev,
    inode: details.ino,
    size: details.size,
    modifiedMs: details.mtimeMs,
    changedMs: details.ctimeMs
  }
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs &&
    left.changedMs === right.changedMs
  )
}

function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode
}

function preferenceFileError(
  message: string,
  cause?: unknown
): InvalidGitExecutablePreferenceFileError {
  return new InvalidGitExecutablePreferenceFileError(message, cause)
}

function parsePreferencePayload(payload: string): GitExecutablePreference {
  try {
    return freezePreference(JSON.parse(payload))
  } catch (error) {
    throw preferenceFileError(
      'Stored Git executable preference is not valid JSON',
      error
    )
  }
}

async function readPreferenceFile(
  filePath: string
): Promise<GitExecutablePreference> {
  const before = await lstat(filePath)
  if (before.isSymbolicLink()) {
    throw preferenceFileError(
      'Stored Git executable preference is a symbolic link'
    )
  }
  if (!before.isFile()) {
    throw preferenceFileError(
      'Stored Git executable preference is not a regular file'
    )
  }
  if (before.size > MAX_PREFERENCE_FILE_BYTES) {
    throw preferenceFileError(
      'Stored Git executable preference exceeds its size limit'
    )
  }

  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlocking =
    typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  let handle
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | noFollow | nonBlocking
    )
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      throw preferenceFileError(
        'Stored Git executable preference became a symbolic link',
        error
      )
    }
    throw error
  }

  try {
    const openedBeforePermissionRepair = await handle.stat()
    if (!openedBeforePermissionRepair.isFile()) {
      throw preferenceFileError(
        'Stored Git executable preference is not a regular file'
      )
    }

    const initialSnapshot = snapshotOf(before)
    const openedSnapshot = snapshotOf(openedBeforePermissionRepair)
    if (!sameSnapshot(initialSnapshot, openedSnapshot)) {
      throw preferenceFileError(
        'Stored Git executable preference changed while it was opened'
      )
    }
    if (openedSnapshot.size > MAX_PREFERENCE_FILE_BYTES) {
      throw preferenceFileError(
        'Stored Git executable preference exceeds its size limit'
      )
    }

    if (
      process.platform !== 'win32' &&
      (openedBeforePermissionRepair.mode & 0o777) !== 0o600
    ) {
      await handle.chmod(0o600)
    }
    const stableSnapshot = snapshotOf(await handle.stat())
    if (!sameFile(openedSnapshot, stableSnapshot)) {
      throw preferenceFileError(
        'Stored Git executable preference changed during permission repair'
      )
    }

    const buffer = Buffer.allocUnsafe(MAX_PREFERENCE_FILE_BYTES + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_PREFERENCE_FILE_BYTES) {
      throw preferenceFileError(
        'Stored Git executable preference exceeds its size limit'
      )
    }

    const afterReadSnapshot = snapshotOf(await handle.stat())
    if (
      !sameSnapshot(stableSnapshot, afterReadSnapshot) ||
      offset !== afterReadSnapshot.size
    ) {
      throw preferenceFileError(
        'Stored Git executable preference changed while it was read'
      )
    }

    let payload: string
    try {
      payload = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, offset)
      )
    } catch (error) {
      throw preferenceFileError(
        'Stored Git executable preference is not valid UTF-8',
        error
      )
    }

    const preference = parsePreferencePayload(payload)
    const linkedAfterRead = await lstat(filePath)
    if (
      linkedAfterRead.isSymbolicLink() ||
      !sameSnapshot(afterReadSnapshot, snapshotOf(linkedAfterRead))
    ) {
      throw preferenceFileError(
        'Stored Git executable preference changed before validation completed'
      )
    }
    return preference
  } finally {
    await handle.close()
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unavailable on some supported filesystems.
  }
}

async function quarantineInvalidFile(
  filePath: string
): Promise<string | undefined> {
  const quarantinePath = `${filePath}.quarantined-${Date.now()}-${randomUUID()}`
  try {
    await rename(filePath, quarantinePath)
    await syncDirectory(path.dirname(filePath))
    return quarantinePath
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

function isInvalidPreferenceFileError(error: unknown): boolean {
  return (
    error instanceof InvalidGitExecutablePreferenceFileError ||
    errorCode(error) === 'ELOOP'
  )
}

async function canonicalPreferenceForSave(
  input: GitExecutablePreferenceInput
): Promise<GitExecutablePreference> {
  const candidate = freezePreference({
    version: 1,
    path: input.path,
    fingerprint: input.fingerprint
  })
  const canonical = await realpath(candidate.path)
  const canonicalPreference = freezePreference({
    ...candidate,
    path: canonical
  })
  const pathMatches =
    process.platform === 'win32'
      ? canonicalPreference.path.toLowerCase() === candidate.path.toLowerCase()
      : canonicalPreference.path === candidate.path
  if (!pathMatches) {
    throw new Error('Git executable preference path must already be canonical')
  }
  const details = await lstat(canonicalPreference.path)
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error('Git executable preference path must be a regular file')
  }
  return canonicalPreference
}

/**
 * Persists only a canonical path and the exact discovery fingerprint. The
 * preference is never an authorization grant: callers must ask the Git
 * executable trust service to fingerprint and compare the file again before
 * every launch.
 */
export class GitExecutablePreferenceStore {
  readonly filePath: string
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(appDataDirectory: string) {
    if (
      !path.isAbsolute(appDataDirectory) ||
      path.normalize(appDataDirectory) !== appDataDirectory ||
      /[\0-\x1f\x7f]/u.test(appDataDirectory)
    ) {
      throw new Error('App data directory must be a normalized absolute path')
    }
    this.filePath = path.join(
      appDataDirectory,
      GIT_EXECUTABLE_PREFERENCE_FILENAME
    )
  }

  async load(): Promise<GitExecutablePreferenceLoadResult> {
    return this.enqueue(async () => {
      try {
        return Object.freeze({
          status: 'loaded' as const,
          preference: await readPreferenceFile(this.filePath)
        })
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          return Object.freeze({ status: 'missing' as const })
        }
        if (!isInvalidPreferenceFileError(error)) throw error
        const quarantinedPath = await quarantineInvalidFile(this.filePath)
        if (!quarantinedPath) {
          return Object.freeze({ status: 'missing' as const })
        }
        return Object.freeze({
          status: 'quarantined' as const,
          quarantinedPath,
          reason:
            error instanceof Error
              ? error.message
              : 'Stored Git executable preference was invalid'
        })
      }
    })
  }

  async save(
    input: GitExecutablePreferenceInput
  ): Promise<GitExecutablePreference> {
    return this.enqueue(async () => {
      const preference = await canonicalPreferenceForSave(input)
      await this.preserveInvalidTarget()
      await this.persist(preference)
      return preference
    })
  }

  async clear(): Promise<void> {
    await this.enqueue(async () => {
      try {
        await readPreferenceFile(this.filePath)
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return
        if (!isInvalidPreferenceFileError(error)) throw error
        await quarantineInvalidFile(this.filePath)
        return
      }
      try {
        await unlink(this.filePath)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
      await syncDirectory(path.dirname(this.filePath))
    })
  }

  private async preserveInvalidTarget(): Promise<void> {
    try {
      await readPreferenceFile(this.filePath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      if (!isInvalidPreferenceFileError(error)) throw error
      await quarantineInvalidFile(this.filePath)
    }
  }

  private async persist(preference: GitExecutablePreference): Promise<void> {
    const payload = `${JSON.stringify(preference, null, 2)}\n`
    if (Buffer.byteLength(payload, 'utf8') > MAX_PREFERENCE_FILE_BYTES) {
      throw new Error('Git executable preference exceeds its size limit')
    }

    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`
    )
    let temporaryCreated = false
    try {
      const noFollow =
        typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          noFollow,
        0o600
      )
      temporaryCreated = true
      let complete = false
      try {
        if (process.platform !== 'win32') await handle.chmod(0o600)
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
        complete = true
      } finally {
        await handle.close()
        if (!complete) {
          await unlink(temporary).catch(() => undefined)
          temporaryCreated = false
        }
      }

      await rename(temporary, this.filePath)
      temporaryCreated = false
      await syncDirectory(directory)
    } finally {
      if (temporaryCreated) await unlink(temporary).catch(() => undefined)
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue
      .catch(() => undefined)
      .then(operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
