import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'

type SecretMap = Record<string, string>

const MAX_SECRET_FILE_BYTES = 8_000_000
const MAX_SECRET_ENTRIES = 1_000

class InvalidVaultFileError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'InvalidVaultFileError'
  }
}

const secretIdSchema = z.string().min(1).max(200)
const encryptedValueSchema = z
  .string()
  .min(4)
  .max(131_072)
  .refine(
    (value) =>
      value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/u.test(value) &&
      Buffer.from(value, 'base64').toString('base64') === value,
    'Invalid encrypted secret encoding'
  )
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

export class SecretVault {
  private secrets: SecretMap = emptySecretMap()
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      this.secrets = parseVaultPayload(await readBoundedFile(this.filePath))
    } catch (error) {
      if (!isRecoverableVaultFileError(error)) throw error
      if (errorCode(error) !== 'ENOENT') {
        const quarantine = `${this.filePath}.unreadable-${Date.now()}-${randomUUID()}`
        await rename(this.filePath, quarantine).catch(() => undefined)
      }
      this.secrets = emptySecretMap()
    }
  }

  async set(providerId: string, value: string): Promise<void> {
    const id = validateProviderId(providerId)
    if (!secureStorageAvailable()) {
      throw new Error('The operating-system credential vault is unavailable')
    }
    const encrypted = safeStorage.encryptString(value).toString('base64')
    encryptedValueSchema.parse(encrypted)
    await this.commitMutation((next) => {
      if (
        !Object.hasOwn(next, id) &&
        Object.keys(next).length >= MAX_SECRET_ENTRIES
      ) {
        throw new Error('The credential vault has reached its entry limit')
      }
      next[id] = encrypted
    })
  }

  async delete(providerId: string): Promise<void> {
    const id = validateProviderId(providerId)
    await this.commitMutation((next) => {
      delete next[id]
    })
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
    mutation: (next: SecretMap) => void
  ): Promise<void> {
    const operation = this.mutationQueue
      .catch(() => undefined)
      .then(async () => {
        const next = emptySecretMap()
        for (const [id, encrypted] of Object.entries(this.secrets)) {
          next[id] = encrypted
        }
        mutation(next)
        await this.persist(next)
        this.secrets = next
      })
    this.mutationQueue = operation
    await operation
  }

  private async persist(secrets: SecretMap): Promise<void> {
    const payload = JSON.stringify(secrets, null, 2)
    if (Buffer.byteLength(payload, 'utf8') > MAX_SECRET_FILE_BYTES) {
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
      await syncDirectory(directory)
    } finally {
      if (temporaryCreated) await unlink(temporary).catch(() => undefined)
    }
  }
}
