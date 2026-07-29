import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureTaskExportExtension,
  readBoundedTextFile,
  safeTaskFilename,
  writeTextFileAtomically
} from './task-files'

describe('task file boundaries', () => {
  it('creates portable filenames and preserves required compound extensions', () => {
    expect(safeTaskFilename('  Auth: flow / review?  ', 'bundle')).toBe(
      'Auth- flow - review-.ground-task.json'
    )
    expect(safeTaskFilename('   ', 'markdown')).toBe('Ground task.md')
    expect(safeTaskFilename('CON', 'markdown')).toBe('Ground CON.md')
    expect(safeTaskFilename('.private', 'bundle')).toBe(
      'Ground .private.ground-task.json'
    )
    expect(
      ensureTaskExportExtension('/tmp/auth.ground-task.json', 'bundle')
    ).toBe('/tmp/auth.ground-task.json')
    expect(ensureTaskExportExtension('/tmp/auth', 'markdown')).toBe('/tmp/auth.md')
  })

  it('reads regular files within a strict byte bound', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-task-files-'))
    const filePath = path.join(directory, 'task.ground-task.json')
    await writeFile(filePath, '{"ok":true}', 'utf8')

    await expect(readBoundedTextFile(filePath, 11)).resolves.toBe('{"ok":true}')
    await expect(readBoundedTextFile(filePath, 10)).rejects.toThrow(
      'exceeds the 10 byte limit'
    )
    await expect(readBoundedTextFile(directory, 100)).rejects.toThrow(
      'regular task bundle file'
    )
  })

  it('atomically replaces the destination and removes its private temporary file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-task-files-'))
    const filePath = path.join(directory, 'task.md')
    await writeFile(filePath, 'old', 'utf8')

    await writeTextFileAtomically(filePath, 'new transcript', 100)

    await expect(readFile(filePath, 'utf8')).resolves.toBe('new transcript')
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    await expect(writeTextFileAtomically(filePath, 'too large', 2)).rejects.toThrow(
      'exceeds the 2 byte limit'
    )
  })
})
