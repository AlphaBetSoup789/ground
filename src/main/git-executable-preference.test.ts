import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GIT_EXECUTABLE_PREFERENCE_FILENAME,
  GitExecutablePreferenceStore
} from './git-executable-preference'

const temporaryDirectories: string[] = []
const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)
const FINGERPRINT_C = 'c'.repeat(64)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ground-git-preference-')
  )
  temporaryDirectories.push(directory)
  return directory
}

async function executableAt(
  directory: string,
  name = process.platform === 'win32' ? 'git.exe' : 'git'
): Promise<string> {
  const portableName =
    process.platform === 'win32' &&
    path.win32.extname(name).toLowerCase() !== '.exe'
      ? `${name}.exe`
      : name
  const executable = path.join(directory, portableName)
  await writeFile(executable, 'test executable')
  return realpath(executable)
}

async function preferenceFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) =>
    entry.startsWith(GIT_EXECUTABLE_PREFERENCE_FILENAME)
  )
}

describe('GitExecutablePreferenceStore', () => {
  it('round-trips only a canonical path and exact fingerprint in a private file', async () => {
    const directory = await temporaryRoot()
    const executable = await executableAt(directory)
    const store = new GitExecutablePreferenceStore(directory)

    const saved = await store.save({
      path: executable,
      fingerprint: FINGERPRINT_A
    })
    const loaded = await store.load()

    expect(saved).toEqual({
      version: 1,
      path: executable,
      fingerprint: FINGERPRINT_A
    })
    expect(Object.isFrozen(saved)).toBe(true)
    expect(loaded).toEqual({
      status: 'loaded',
      preference: saved
    })
    expect(
      JSON.parse(await readFile(store.filePath, 'utf8'))
    ).toEqual(saved)
    if (process.platform !== 'win32') {
      expect((await lstat(store.filePath)).mode & 0o777).toBe(0o600)
    }
  })

  it('handles a missing preference and repeated clear operations safely', async () => {
    const directory = await temporaryRoot()
    const store = new GitExecutablePreferenceStore(directory)

    await expect(store.load()).resolves.toEqual({ status: 'missing' })
    await expect(store.clear()).resolves.toBeUndefined()
    await expect(store.clear()).resolves.toBeUndefined()
  })

  it('rejects non-canonical, relative, malformed, and non-file save inputs', async () => {
    const directory = await temporaryRoot()
    const executable = await executableAt(directory)
    const linked = path.join(
      directory,
      process.platform === 'win32' ? 'linked-git.exe' : 'linked-git'
    )
    try {
      await symlink(executable, linked, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    const subdirectory = path.join(
      directory,
      process.platform === 'win32' ? 'not-a-file.exe' : 'not-a-file'
    )
    await mkdir(subdirectory)
    const canonicalSubdirectory = await realpath(subdirectory)
    const store = new GitExecutablePreferenceStore(directory)

    await expect(
      store.save({ path: 'relative/git', fingerprint: FINGERPRINT_A })
    ).rejects.toThrow(/absolute/i)
    await expect(
      store.save({ path: executable, fingerprint: 'A'.repeat(64) })
    ).rejects.toThrow()
    await expect(
      store.save({ path: canonicalSubdirectory, fingerprint: FINGERPRINT_A })
    ).rejects.toThrow(/regular file/i)
    if (await lstat(linked).catch(() => undefined)) {
      await expect(
        store.save({ path: linked, fingerprint: FINGERPRINT_A })
      ).rejects.toThrow(/canonical/i)
    }
    await expect(store.load()).resolves.toEqual({ status: 'missing' })
  })

  it('quarantines malformed data and never overwrites the preserved bytes', async () => {
    const directory = await temporaryRoot()
    const executable = await executableAt(directory)
    const store = new GitExecutablePreferenceStore(directory)
    const malformed = '{"version":1,"path":'
    await writeFile(store.filePath, malformed)

    const result = await store.load()

    expect(result).toMatchObject({
      status: 'quarantined',
      reason: expect.stringMatching(/not valid JSON/i)
    })
    if (result.status !== 'quarantined') throw new Error('Expected quarantine')
    await expect(readFile(result.quarantinedPath, 'utf8')).resolves.toBe(
      malformed
    )
    await store.save({ path: executable, fingerprint: FINGERPRINT_A })
    await expect(readFile(result.quarantinedPath, 'utf8')).resolves.toBe(
      malformed
    )
    await expect(store.load()).resolves.toMatchObject({
      status: 'loaded',
      preference: { path: executable, fingerprint: FINGERPRINT_A }
    })
  })

  it.each([
    {
      version: 2,
      path: path.resolve('/invalid/future/git'),
      fingerprint: FINGERPRINT_A
    },
    {
      version: 1,
      path: 'relative/git',
      fingerprint: FINGERPRINT_A
    },
    {
      version: 1,
      path: path.resolve('/invalid/git'),
      fingerprint: 'not-a-sha256'
    },
    {
      version: 1,
      path: path.resolve('/invalid/git'),
      fingerprint: FINGERPRINT_A,
      extra: true
    }
  ])('fails closed for a schema-invalid document %#', async (document) => {
    const directory = await temporaryRoot()
    const store = new GitExecutablePreferenceStore(directory)
    await writeFile(store.filePath, JSON.stringify(document))

    await expect(store.load()).resolves.toMatchObject({
      status: 'quarantined'
    })
    expect(await preferenceFiles(directory)).toHaveLength(1)
    expect((await preferenceFiles(directory))[0]).toMatch(/\.quarantined-/)
  })

  it('quarantines a symbolic link without following or changing its target', async () => {
    const directory = await temporaryRoot()
    const target = path.join(directory, 'target.json')
    const original = 'target must remain untouched'
    await writeFile(target, original)
    const store = new GitExecutablePreferenceStore(directory)
    try {
      await symlink(target, store.filePath, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }

    const result = await store.load()

    expect(result).toMatchObject({ status: 'quarantined' })
    if (result.status !== 'quarantined') throw new Error('Expected quarantine')
    expect((await lstat(result.quarantinedPath)).isSymbolicLink()).toBe(true)
    await expect(readFile(target, 'utf8')).resolves.toBe(original)
  })

  it('bounds reads and quarantines oversized files before parsing them', async () => {
    const directory = await temporaryRoot()
    const store = new GitExecutablePreferenceStore(directory)
    await writeFile(store.filePath, Buffer.alloc(20 * 1024, 0x61))

    const result = await store.load()

    expect(result).toMatchObject({
      status: 'quarantined',
      reason: expect.stringMatching(/size limit/i)
    })
    if (result.status !== 'quarantined') throw new Error('Expected quarantine')
    expect((await lstat(result.quarantinedPath)).size).toBe(20 * 1024)
  })

  it('repairs overly broad permissions through the opened file handle', async () => {
    if (process.platform === 'win32') return
    const directory = await temporaryRoot()
    const executable = await executableAt(directory)
    const store = new GitExecutablePreferenceStore(directory)
    await store.save({ path: executable, fingerprint: FINGERPRINT_A })
    await chmod(store.filePath, 0o644)

    await expect(store.load()).resolves.toMatchObject({ status: 'loaded' })

    expect((await lstat(store.filePath)).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent saves without producing a partial document', async () => {
    const directory = await temporaryRoot()
    const executableA = await executableAt(directory, 'git-a')
    const executableB = await executableAt(directory, 'git-b')
    const executableC = await executableAt(directory, 'git-c')
    const store = new GitExecutablePreferenceStore(directory)

    await Promise.all([
      store.save({ path: executableA, fingerprint: FINGERPRINT_A }),
      store.save({ path: executableB, fingerprint: FINGERPRINT_B }),
      store.save({ path: executableC, fingerprint: FINGERPRINT_C })
    ])

    await expect(store.load()).resolves.toEqual({
      status: 'loaded',
      preference: {
        version: 1,
        path: executableC,
        fingerprint: FINGERPRINT_C
      }
    })
    expect(
      (await readdir(directory)).filter((entry) => entry.endsWith('.tmp'))
    ).toEqual([])
  })

  it('preserves the last valid preference when a later save is rejected', async () => {
    const directory = await temporaryRoot()
    const executable = await executableAt(directory)
    const store = new GitExecutablePreferenceStore(directory)
    await store.save({ path: executable, fingerprint: FINGERPRINT_A })
    const before = await readFile(store.filePath)

    await expect(
      store.save({ path: executable, fingerprint: 'invalid' })
    ).rejects.toThrow()

    await expect(readFile(store.filePath)).resolves.toEqual(before)
    await expect(store.load()).resolves.toMatchObject({
      status: 'loaded',
      preference: { fingerprint: FINGERPRINT_A }
    })
  })

  it('does not erase malformed data when quarantine cannot be completed', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const directory = await temporaryRoot()
    const store = new GitExecutablePreferenceStore(directory)
    const malformed = '{malformed'
    await writeFile(store.filePath, malformed)
    await chmod(directory, 0o500)

    try {
      await expect(store.load()).rejects.toThrow()
      await expect(readFile(store.filePath, 'utf8')).resolves.toBe(malformed)
    } finally {
      await chmod(directory, 0o700)
    }
  })
})
