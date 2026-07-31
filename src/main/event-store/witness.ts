import { constants } from 'node:fs'
import { lstat, open, rename } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import {
  encodeCanonicalJson,
  parseCanonicalJson
} from './canonical-json'
import {
  EventStoreConflictError,
  EventStoreCorruptionError,
  EventStoreVersionError
} from './errors'
import {
  assertPrivateRegularFile,
  createPrivateTemporaryPath,
  ensureParentDirectory,
  isMissingFileError,
  removeIfPresent,
  syncDirectory
} from './private-files'
import {
  HEAD_WITNESS_VERSION,
  type HeadWitness,
  type HeadWitnessStore
} from './types'
import { withWitnessPublicationLock } from './writer-lock'

const MAX_WITNESS_BYTES = 16 * 1024
const READ_CHUNK_BYTES = 4 * 1024

const witnessSchema = z
  .object({
    witnessVersion: z.literal(HEAD_WITNESS_VERSION),
    databaseId: z.string().min(1).max(200),
    recoveryEpoch: z.string().min(1).max(200),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    eventHash: z.string().regex(/^[a-f0-9]{64}$/u),
    transactionId: z.string().min(1).max(200),
    publishedAt: z.iso.datetime({ offset: true })
  })
  .strict()

export class FileHeadWitnessStore implements HeadWitnessStore {
  async read(filePath: string): Promise<HeadWitness | undefined> {
    let payload: string
    try {
      payload = await readBoundedPrivateFile(filePath)
    } catch (error) {
      if (isMissingFileError(error)) return undefined
      throw error
    }

    let parsedJson: unknown
    try {
      parsedJson = parseCanonicalJson(payload, {
        maxBytes: MAX_WITNESS_BYTES,
        maxDepth: 16,
        maxNodes: 64
      })
    } catch (error) {
      throw new EventStoreCorruptionError(
        'Head witness is not canonical bounded JSON',
        { cause: error }
      )
    }

    if (
      parsedJson &&
      typeof parsedJson === 'object' &&
      !Array.isArray(parsedJson) &&
      'witnessVersion' in parsedJson &&
      (parsedJson as { witnessVersion?: unknown }).witnessVersion !==
        HEAD_WITNESS_VERSION
    ) {
      throw new EventStoreVersionError(
        'witness',
        `Unsupported head-witness version ${String(
          (parsedJson as { witnessVersion?: unknown }).witnessVersion
        )}`
      )
    }

    const parsed = witnessSchema.safeParse(parsedJson)
    if (!parsed.success) {
      throw new EventStoreCorruptionError(
        'Head witness failed schema validation',
        { cause: parsed.error }
      )
    }
    return parsed.data
  }

  async publish(
    filePath: string,
    witness: HeadWitness,
    options: {
      readonly beforeRename?: () => void | Promise<void>
      readonly afterRename?: () => void | Promise<void>
      readonly expected?: HeadWitness | null
    } = {}
  ): Promise<void> {
    const parsed = witnessSchema.safeParse(witness)
    if (!parsed.success) {
      throw new EventStoreCorruptionError(
        'Refused to publish an invalid head witness',
        { cause: parsed.error }
      )
    }
    if (options.expected) {
      assertMonotonicWitnessUpdate(options.expected, parsed.data)
    }
    const payload = encodeCanonicalJson(parsed.data, {
      maxBytes: MAX_WITNESS_BYTES,
      maxDepth: 16,
      maxNodes: 64
    })
    const directory = await ensureParentDirectory(filePath)
    const temporaryPath = await createPrivateTemporaryPath(
      filePath,
      'witness.tmp'
    )
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    )
    let temporaryExists = true
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
      await handle.close()
      await withWitnessPublicationLock(filePath, async () => {
        await assertSafeExistingWitnessPath(filePath)
        if (Object.hasOwn(options, 'expected')) {
          await assertExpectedWitness(filePath, options.expected)
        }
        await options.beforeRename?.()
        await assertSafeExistingWitnessPath(filePath)
        if (Object.hasOwn(options, 'expected')) {
          await assertExpectedWitness(filePath, options.expected)
        }
        await assertPrivateRegularFile(
          temporaryPath,
          MAX_WITNESS_BYTES
        )
        await rename(temporaryPath, filePath)
        temporaryExists = false
        await options.afterRename?.()
        await syncDirectory(directory)
      })
    } finally {
      await handle.close().catch(() => undefined)
      if (temporaryExists) await removeIfPresent(temporaryPath)
    }
  }
}

export const fileHeadWitnessStore = new FileHeadWitnessStore()

async function assertSafeExistingWitnessPath(
  filePath: string
): Promise<void> {
  try {
    await assertPrivateRegularFile(filePath, MAX_WITNESS_BYTES)
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }
}

async function assertExpectedWitness(
  filePath: string,
  expected: HeadWitness | null | undefined
): Promise<void> {
  const actual = await fileHeadWitnessStore.read(filePath)
  if (expected === null) {
    if (actual === undefined) return
  } else if (expected && actual && witnessesEqual(expected, actual)) {
    return
  }
  throw new EventStoreConflictError(
    'Head witness changed before conditional publication'
  )
}

function witnessesEqual(
  left: HeadWitness,
  right: HeadWitness
): boolean {
  return (
    left.witnessVersion === right.witnessVersion &&
    left.databaseId === right.databaseId &&
    left.recoveryEpoch === right.recoveryEpoch &&
    left.sequence === right.sequence &&
    left.eventHash === right.eventHash &&
    left.transactionId === right.transactionId &&
    left.publishedAt === right.publishedAt
  )
}

function assertMonotonicWitnessUpdate(
  expected: HeadWitness,
  candidate: HeadWitness
): void {
  if (
    expected.databaseId !== candidate.databaseId ||
    expected.recoveryEpoch !== candidate.recoveryEpoch
  ) {
    return
  }
  if (
    candidate.sequence < expected.sequence ||
    (candidate.sequence === expected.sequence &&
      (candidate.eventHash !== expected.eventHash ||
        candidate.transactionId !== expected.transactionId))
  ) {
    throw new EventStoreConflictError(
      'Refusing to regress or replace an established witness head'
    )
  }
}

async function readBoundedPrivateFile(filePath: string): Promise<string> {
  const pathDetails = await lstat(filePath)
  if (!pathDetails.isFile() || pathDetails.isSymbolicLink()) {
    throw new EventStoreCorruptionError(
      'Head witness path is not a regular file'
    )
  }
  if (pathDetails.nlink !== 1) {
    throw new EventStoreCorruptionError(
      'Head witness path has multiple hard links'
    )
  }
  if (pathDetails.size > MAX_WITNESS_BYTES) {
    throw new EventStoreCorruptionError(
      'Head witness exceeds its byte limit'
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
    if (!details.isFile()) {
      throw new EventStoreCorruptionError(
        'Head witness path is not a regular file'
      )
    }
    if (details.nlink !== 1) {
      throw new EventStoreCorruptionError(
        'Head witness path has multiple hard links'
      )
    }
    if (details.dev !== pathDetails.dev || details.ino !== pathDetails.ino) {
      throw new EventStoreCorruptionError(
        'Head witness changed while it was being opened'
      )
    }
    if (details.size > MAX_WITNESS_BYTES) {
      throw new EventStoreCorruptionError(
        'Head witness exceeds its byte limit'
      )
    }
    if (process.platform !== 'win32' && (details.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600)
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes <= MAX_WITNESS_BYTES) {
      const remaining = MAX_WITNESS_BYTES + 1 - totalBytes
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
    if (totalBytes > MAX_WITNESS_BYTES) {
      throw new EventStoreCorruptionError(
        'Head witness exceeds its byte limit'
      )
    }
    const completedDetails = await handle.stat()
    if (completedDetails.nlink !== 1) {
      throw new EventStoreCorruptionError(
        'Head witness path gained another hard link while it was read'
      )
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, totalBytes)
    )
  } catch (error) {
    if (error instanceof EventStoreCorruptionError) throw error
    throw new EventStoreCorruptionError('Head witness could not be read', {
      cause: error
    })
  } finally {
    await handle.close()
  }
}

export function defaultWitnessPath(databasePath: string): string {
  return path.join(
    path.dirname(databasePath),
    `${path.basename(databasePath)}.head.json`
  )
}
