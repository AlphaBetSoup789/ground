import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => {
    const decoded = value.toString('utf8')
    if (!decoded.startsWith('encrypted:')) throw new Error('Invalid ciphertext')
    return decoded.slice('encrypted:'.length)
  })
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

import { SecretVault } from './secrets'

describe('SecretVault', () => {
  beforeEach(() => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
    safeStorageMock.encryptString.mockImplementation((value: string) =>
      Buffer.from(`encrypted:${value}`, 'utf8')
    )
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => {
      const decoded = value.toString('utf8')
      if (!decoded.startsWith('encrypted:')) throw new Error('Invalid ciphertext')
      return decoded.slice('encrypted:'.length)
    })
  })

  it('atomically persists encrypted values with restrictive file permissions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    await vault.load()

    await vault.set('provider-1', 'not-plain-text')

    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain('not-plain-text')
    expect(JSON.parse(persisted)).toEqual({
      'provider-1': Buffer.from('encrypted:not-plain-text').toString('base64')
    })
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    }
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const reloaded = new SecretVault(filePath)
    await reloaded.load()
    expect(reloaded.has('provider-1')).toBe(true)
    expect(reloaded.get('provider-1')).toBe('not-plain-text')
  })

  it('serializes concurrent updates without losing the final credential map', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    await vault.load()

    await Promise.all([
      vault.set('provider-a', 'alpha'),
      vault.set('provider-b', 'beta')
    ])

    const reloaded = new SecretVault(filePath)
    await reloaded.load()
    expect(reloaded.get('provider-a')).toBe('alpha')
    expect(reloaded.get('provider-b')).toBe('beta')
  })

  it('publishes a credential mutation only after its durable write succeeds', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    await vault.load()
    await vault.set('provider-a', 'alpha')
    await unlink(filePath)
    await mkdir(filePath)

    await expect(vault.set('provider-b', 'beta')).rejects.toThrow()

    expect(vault.get('provider-a')).toBe('alpha')
    expect(vault.has('provider-b')).toBe(false)
  })

  it.runIf(process.platform !== 'win32')(
    'tightens legacy vault permissions through the opened file handle',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
      const filePath = path.join(directory, 'secrets.json')
      const vault = new SecretVault(filePath)
      await vault.load()
      await vault.set('provider-a', 'alpha')
      await chmod(filePath, 0o644)

      const reloaded = new SecretVault(filePath)
      await reloaded.load()

      expect(reloaded.get('provider-a')).toBe('alpha')
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    }
  )

  it.runIf(
    process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() !== 0
  )('propagates a transient access failure without quarantining valid data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    await vault.load()
    await vault.set('provider-a', 'alpha')
    await chmod(directory, 0o000)

    try {
      await expect(new SecretVault(filePath).load()).rejects.toThrow()
    } finally {
      await chmod(directory, 0o700)
    }

    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('secrets.json.unreadable-')
      )
    ).toBe(false)
    const reloaded = new SecretVault(filePath)
    await reloaded.load()
    expect(reloaded.get('provider-a')).toBe('alpha')
  })

  it('quarantines invalid vault data instead of trusting arbitrary JSON', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    await writeFile(filePath, '{"provider-1":"plain text"}', 'utf8')

    const vault = new SecretVault(filePath)
    await vault.load()

    expect(vault.has('provider-1')).toBe(false)
    const entries = await readdir(directory)
    expect(entries.some((name) => name.startsWith('secrets.json.unreadable-'))).toBe(
      true
    )
  })

  it.runIf(process.platform !== 'win32')(
    'does not follow a credential-vault symlink',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
      const outside = path.join(directory, 'outside.json')
      const filePath = path.join(directory, 'secrets.json')
      const outsideContents = JSON.stringify({
        outside: Buffer.from('encrypted:outside').toString('base64')
      })
      await writeFile(outside, outsideContents, 'utf8')
      await symlink(outside, filePath)

      const vault = new SecretVault(filePath)
      await vault.load()

      expect(vault.has('outside')).toBe(false)
      expect(await readFile(outside, 'utf8')).toBe(outsideContents)
      const quarantined = (await readdir(directory)).find((name) =>
        name.startsWith('secrets.json.unreadable-')
      )
      expect(quarantined).toBeDefined()
      expect((await lstat(path.join(directory, quarantined as string))).isSymbolicLink()).toBe(
        true
      )
    }
  )

  it('fails closed when decryption is unavailable or ciphertext cannot decrypt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    await vault.load()
    await vault.set('provider-1', 'secret')

    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    expect(vault.get('provider-1')).toBeUndefined()
    await expect(vault.set('provider-2', 'secret')).rejects.toThrow(
      /credential vault is unavailable/i
    )

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('OS key changed')
    })
    expect(vault.get('provider-1')).toBeUndefined()
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('OS key changed')
    })
    expect(vault.has('provider-1')).toBe(false)
  })

  it('rejects unsafe provider identifiers instead of mutating object prototypes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const vault = new SecretVault(path.join(directory, 'secrets.json'))
    await vault.load()

    await expect(vault.set('', 'secret')).rejects.toThrow()
    await expect(vault.set('x'.repeat(201), 'secret')).rejects.toThrow()
    expect(vault.has('__proto__')).toBe(false)
  })
})
