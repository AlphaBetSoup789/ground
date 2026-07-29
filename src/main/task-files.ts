import { randomUUID } from 'node:crypto'
import { open, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu
const TRAILING_FILENAME_CHARACTERS = /[.\s]+$/gu
const WINDOWS_RESERVED_FILENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

export function safeTaskFilename(
  title: string,
  format: 'bundle' | 'markdown'
): string {
  const cleaned =
    title
      .normalize('NFKC')
      .replace(INVALID_FILENAME_CHARACTERS, '-')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(TRAILING_FILENAME_CHARACTERS, '')
  const shortened = Array.from(cleaned).slice(0, 96).join('').trim()
  const stem =
    !shortened || shortened.startsWith('.') || WINDOWS_RESERVED_FILENAME.test(shortened)
      ? shortened
        ? `Ground ${shortened}`
        : 'Ground task'
      : shortened
  return format === 'bundle' ? `${stem}.ground-task.json` : `${stem}.md`
}

export function ensureTaskExportExtension(
  targetPath: string,
  format: 'bundle' | 'markdown'
): string {
  const required = format === 'bundle' ? '.ground-task.json' : '.md'
  return targetPath.toLowerCase().endsWith(required)
    ? targetPath
    : `${targetPath}${required}`
}

export async function readBoundedTextFile(
  filePath: string,
  maximumBytes: number
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('File size limit must be a positive integer')
  }
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Choose a regular task bundle file')
    if (stat.size > maximumBytes) {
      throw new Error(`Task bundle exceeds the ${maximumBytes} byte limit`)
    }
    const buffer = Buffer.alloc(maximumBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      )
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > maximumBytes) {
      throw new Error(`Task bundle exceeds the ${maximumBytes} byte limit`)
    }
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function writeTextFileAtomically(
  filePath: string,
  content: string,
  maximumBytes: number
): Promise<void> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('File size limit must be a positive integer')
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maximumBytes) {
    throw new Error(`Task export exceeds the ${maximumBytes} byte limit`)
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.ground-task-${randomUUID()}.tmp`
  )
  try {
    await writeFile(temporary, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
