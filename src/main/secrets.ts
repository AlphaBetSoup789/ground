import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import type { RecoveryNotice } from '../shared/types'

type SecretMap = Record<string, string>

const MAX_STEADY_SECRET_FILE_BYTES = 8 * 1024 * 1024
const MAX_SECRET_FILE_BYTES = 16 * 1024 * 1024
const MAX_STEADY_SECRET_ENTRIES = 1_000
// A 128,000-byte CLI environment can expand to 768,132 UTF-8 bytes after JSON
// escaping. Bound plaintext before calling the OS backend, allow 256 KiB of
// encryption overhead, then validate the exact canonical-base64 ceiling.
const MAX_SECRET_PLAINTEXT_BYTES = 768 * 1024
const MAX_ENCRYPTED_SECRET_BYTES = 1024 * 1024
const MAX_ENCRYPTED_SECRET_CHARACTERS =
  4 * Math.ceil(MAX_ENCRYPTED_SECRET_BYTES / 3)
// Persisted state permits 1,000 providers. A distinct hard bound reserves one
// complete extra generation for journaled replacement staging and recovery
// headroom before provider pointers are published.
const MAX_SECRET_ENTRIES = 2_000

export interface StagedSecretWriteOptions {
  /**
   * References that become obsolete if the staged pointer is published. They
   * remain encrypted until publication succeeds, but are excluded from the
   * projected steady-state capacity check.
   */
  obsoleteReferences?: readonly string[]
}

class InvalidVaultFileError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'InvalidVaultFileError'
  }
}

/**
 * The vault rename may already have succeeded when a later fsync reports an
 * error. The cleanup journal makes either disk generation recoverable, but the
 * current process must not issue another vault mutation until it relaunches.
 */
export class SecretVaultPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Ground could not conclusively publish the credential vault', {
      cause
    })
    this.name = 'SecretVaultPersistenceError'
  }
}

const secretIdSchema = z.string().min(1).max(200)
const encryptedValueSchema = z
  .string()
  .min(4)
  .max(MAX_ENCRYPTED_SECRET_CHARACTERS)
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64')
    return (
      value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/u.test(value) &&
      decoded.byteLength <= MAX_ENCRYPTED_SECRET_BYTES &&
      decoded.toString('base64') === value
    )
  }, 'Invalid encrypted secret encoding')
const secretMapSchema = z
  .record(secretIdSchema, encryptedValueSchema)
  .refine((value) => Object.keys(value).length <= MAX_SECRET_ENTRIES, {
    message: 'Too many saved provider credentials'
  })

function emptySecretMap(): SecretMap {
  return Object.create(null) as SecretMap
}

function boundedSecretMap(value: unknown): SecretMap {
  const parsed = secretMapSchema.parse(value)
  const result = emptySecretMap()
  for (const [key, encrypted] of Object.entries(parsed)) result[key] = encrypted
  return result
}

function validateProviderId(providerId: string): string {
  return secretIdSchema.parse(providerId)
}

function serializedSecretMapBytes(secrets: SecretMap): number {
  return Buffer.byteLength(JSON.stringify(secrets, null, 2), 'utf8')
}

function withinSteadyBounds(secrets: SecretMap): boolean {
  return (
    Object.keys(secrets).length <= MAX_STEADY_SECRET_ENTRIES &&
    serializedSecretMapBytes(secrets) <= MAX_STEADY_SECRET_FILE_BYTES
  )
}

function assertWithinSteadyBounds(secrets: SecretMap): void {
  if (!withinSteadyBounds(secrets)) {
    throw new Error(
      'The credential vault would exceed its steady-state capacity'
    )
  }
}

function cloneSecretMap(secrets: SecretMap): SecretMap {
  const result = emptySecretMap()
  for (const [id, encrypted] of Object.entries(secrets)) {
    result[id] = encrypted
  }
  return result
}

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (
    process.platform === 'linux' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    return false
  }
  return true
}

async function readBoundedFile(filePath: string): Promise<string> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlocking =
    typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  const handle = await open(
    filePath,
    constants.O_RDONLY | noFollow | nonBlocking
  )
  try {
    const details = await handle.stat()
    if (!details.isFile()) {
      throw new InvalidVaultFileError(
        'Credential vault path is not a regular file'
      )
    }
    if (details.size > MAX_SECRET_FILE_BYTES) {
      throw new InvalidVaultFileError(
        'Credential vault file exceeds its size limit'
      )
    }
    if (process.platform !== 'win32' && (details.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600)
    }
    const buffer = Buffer.allocUnsafe(MAX_SECRET_FILE_BYTES + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_SECRET_FILE_BYTES) {
      throw new InvalidVaultFileError(
        'Credential vault file exceeds its size limit'
      )
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, offset)
      )
    } catch (error) {
      throw new InvalidVaultFileError(
        'Credential vault is not valid UTF-8',
        error
      )
    }
  } finally {
    await handle.close()
  }
}

function parseVaultPayload(payload: string): SecretMap {
  try {
    return boundedSecretMap(JSON.parse(payload))
  } catch (error) {
    throw new InvalidVaultFileError(
      'Credential vault is not valid encrypted JSON',
      error
    )
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function isRecoverableVaultFileError(error: unknown): boolean {
  return (
    error instanceof InvalidVaultFileError ||
    errorCode(error) === 'ENOENT' ||
    errorCode(error) === 'ELOOP'
  )
}

async function quarantineUnreadableVault(filePath: string): Promise<void> {
  try {
    await rename(
      filePath,
      `${filePath}.unreadable-${Date.now()}-${randomUUID()}`
    )
  } catch (error) {
    // A concurrent delete is equivalent to a successful quarantine. Other
    // failures must remain visible so a later write cannot replace data that
    // Ground failed to preserve.
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function credentialWarning(detail: string): RecoveryNotice {
  return {
    id: `credential-warning:${Date.now()}:${randomUUID()}`,
    kind: 'credential-warning',
    title: 'Saved credentials need attention',
    detail
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
  } catch (error) {
    const code = errorCode(error)
    if (
      code === 'EINVAL' ||
      code === 'ENOTSUP' ||
      code === 'ENOSYS' ||
      code === 'EISDIR' ||
      (process.platform === 'win32' && code === 'EPERM')
    ) {
      // Directory fsync is unavailable on some supported filesystems.
      return
    }
    throw error
  }
}

export class SecretVault {
  private secrets: SecretMap = emptySecretMap()
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly syncParentDirectory: (
      directory: string
    ) => Promise<void> = syncDirectory
  ) {}

  async load(): Promise<RecoveryNotice | undefined> {
    try {
      this.secrets = parseVaultPayload(await readBoundedFile(this.filePath))
      return undefined
    } catch (error) {
      if (!isRecoverableVaultFileError(error)) throw error
      if (errorCode(error) === 'ENOENT') {
        this.secrets = emptySecretMap()
        return undefined
      }
      await quarantineUnreadableVault(this.filePath)
      this.secrets = emptySecretMap()
      return credentialWarning(
        'Ground could not validate the encrypted credential vault. The unreadable file was preserved; re-enter affected provider keys or CLI environment values.'
      )
    }
  }

  async set(providerId: string, value: string): Promise<void> {
    await this.setEncrypted(providerId, value, false)
  }

  async setStaged(
    providerId: string,
    value: string,
    options: StagedSecretWriteOptions = {}
  ): Promise<void> {
    await this.setEncrypted(providerId, value, true, options)
  }

  private async setEncrypted(
    providerId: string,
    value: string,
    staging: boolean,
    options: StagedSecretWriteOptions = {}
  ): Promise<void> {
    const id = validateProviderId(providerId)
    const obsoleteReferences = new Set(
      (options.obsoleteReferences ?? []).map(validateProviderId)
    )
    if (!secureStorageAvailable()) {
      throw new Error('The operating-system credential vault is unavailable')
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_PLAINTEXT_BYTES) {
      throw new Error('Credential plaintext exceeds its size limit')
    }
    const encryptedBuffer = safeStorage.encryptString(value)
    if (encryptedBuffer.byteLength > MAX_ENCRYPTED_SECRET_BYTES) {
      throw new Error('Encrypted credential exceeds its size limit')
    }
    const encrypted = encryptedBuffer.toString('base64')
    encryptedValueSchema.parse(encrypted)
    await this.commitMutation((next) => {
      const current = cloneSecretMap(next)
      if (
        !Object.hasOwn(next, id) &&
        Object.keys(next).length >=
          (staging ? MAX_SECRET_ENTRIES : MAX_STEADY_SECRET_ENTRIES)
      ) {
        throw new Error('The credential vault has reached its entry limit')
      }
      next[id] = encrypted
      const maximumBytes = staging
        ? MAX_SECRET_FILE_BYTES
        : MAX_STEADY_SECRET_FILE_BYTES
      if (serializedSecretMapBytes(next) > maximumBytes) {
        throw new Error('Credential vault file exceeds its size limit')
      }
      if (!staging) {
        assertWithinSteadyBounds(next)
        return
      }
      if (options.obsoleteReferences) {
        const projected = cloneSecretMap(next)
        for (const reference of obsoleteReferences) {
          if (reference !== id) delete projected[reference]
        }
        if (!withinSteadyBounds(projected)) {
          const currentBytes = serializedSecretMapBytes(current)
          const projectedBytes = serializedSecretMapBytes(projected)
          const improvesOverTransitionalState =
            !withinSteadyBounds(current) &&
            Object.keys(projected).length <= Object.keys(current).length &&
            projectedBytes <= currentBytes &&
            (Object.keys(projected).length < Object.keys(current).length ||
              projectedBytes < currentBytes)
          if (!improvesOverTransitionalState) {
            throw new Error(
              'The credential vault would exceed its steady-state capacity'
            )
          }
        }
      }
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.deleteMany([providerId])
  }

  async deleteMany(providerIds: Iterable<string>): Promise<void> {
    const ids = new Set([...providerIds].map(validateProviderId))
    await this.commitMutation((next) => {
      let changed = false
      for (const id of ids) {
        if (!Object.hasOwn(next, id)) continue
        delete next[id]
        changed = true
      }
      return changed
    })
  }

  assertSteadyState(): void {
    assertWithinSteadyBounds(this.secrets)
  }

  get(providerId: string): string | undefined {
    const id = validateProviderId(providerId)
    const encrypted = Object.hasOwn(this.secrets, id)
      ? this.secrets[id]
      : undefined
    if (!encrypted || !secureStorageAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return undefined
    }
  }

  has(providerId: string): boolean {
    return this.get(providerId) !== undefined
  }

  private async commitMutation(
    mutation: (next: SecretMap) => boolean | void
  ): Promise<void> {
    const operation = this.mutationQueue
      .catch(() => undefined)
      .then(async () => {
        const next = cloneSecretMap(this.secrets)
        const shouldPersist = mutation(next)
        if (shouldPersist === false) return
        try {
          await this.persist(next)
        } catch (error) {
          throw new SecretVaultPersistenceError(error)
        }
        this.secrets = next
      })
    this.mutationQueue = operation
    await operation
  }

  private async persist(secrets: SecretMap): Promise<void> {
    const payload = JSON.stringify(secrets, null, 2)
    if (serializedSecretMapBytes(secrets) > MAX_SECRET_FILE_BYTES) {
      throw new Error('Credential vault file exceeds its size limit')
    }
    boundedSecretMap(JSON.parse(payload))
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`
    )
    let temporaryCreated = false
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      )
      temporaryCreated = true
      let complete = false
      try {
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
      await this.syncParentDirectory(directory)
    } finally {
      if (temporaryCreated) await unlink(temporary).catch(() => undefined)
    }
  }
}
