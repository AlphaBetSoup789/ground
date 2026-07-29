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

import {
  SecretVault,
  SecretVaultPersistenceError
} from './secrets'

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

  it('reserves a complete versioned staging generation at the maximum provider count', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const encrypted = Buffer.from('encrypted:secret', 'utf8').toString(
      'base64'
    )
    const providerEntries = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [
        `provider-${index}`,
        encrypted
      ])
    )
    await writeFile(filePath, JSON.stringify(providerEntries), {
      encoding: 'utf8',
      mode: 0o600
    })
    const vault = new SecretVault(filePath)
    await vault.load()

    await expect(
      vault.setStaged('provider-credential:v2:staged-a', 'replacement')
    ).resolves.toBeUndefined()
    await expect(
      vault.setStaged('provider-credential:v2:staged-b', 'replacement')
    ).resolves.toBeUndefined()
    expect(vault.get('provider-credential:v2:staged-a')).toBe('replacement')
    expect(vault.get('provider-credential:v2:staged-b')).toBe('replacement')

    const fullEntries = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [
        `full-${index}`,
        encrypted
      ])
    )
    await writeFile(filePath, JSON.stringify(fullEntries), {
      encoding: 'utf8',
      mode: 0o600
    })
    const fullVault = new SecretVault(filePath)
    await fullVault.load()
    await expect(
      fullVault.setStaged('provider-credential:v2:overflow', 'replacement')
    ).rejects.toThrow(/entry limit/i)
  })

  it('bounds plaintext before encryption while accepting the maximum CLI envelope budget', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const vault = new SecretVault(path.join(directory, 'secrets.json'))
    await vault.load()

    await expect(
      vault.set('maximum-plaintext', 'x'.repeat(768 * 1024))
    ).resolves.toBeUndefined()
    const encryptionCalls = safeStorageMock.encryptString.mock.calls.length
    await expect(
      vault.set('oversized-plaintext', 'x'.repeat(768 * 1024 + 1))
    ).rejects.toThrow(/plaintext exceeds/i)
    expect(safeStorageMock.encryptString).toHaveBeenCalledTimes(
      encryptionCalls
    )
  })

  it('checks decoded ciphertext bytes even when base64 lengths are identical', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    await vault.load()
    const maximum = Buffer.alloc(1024 * 1024, 0x5a)
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x5a)
    expect(maximum.toString('base64')).toHaveLength(1_398_104)
    expect(oversized.toString('base64')).toHaveLength(1_398_104)

    safeStorageMock.encryptString.mockReturnValueOnce(maximum)
    await expect(
      vault.set('maximum-ciphertext', 'small-secret')
    ).resolves.toBeUndefined()
    safeStorageMock.encryptString.mockReturnValueOnce(oversized)
    await expect(
      vault.set('oversized-ciphertext', 'small-secret')
    ).rejects.toThrow(/encrypted credential exceeds/i)

    await writeFile(
      filePath,
      JSON.stringify({
        crafted: oversized.toString('base64')
      }),
      { encoding: 'utf8', mode: 0o600 }
    )
    const crafted = new SecretVault(filePath)
    await expect(crafted.load()).resolves.toMatchObject({
      kind: 'credential-warning'
    })
    expect(crafted.has('crafted')).toBe(false)
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

  it('deletes an exact reference set as one atomic vault mutation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    await vault.load()
    await vault.set('provider-a', 'alpha')
    await vault.set('provider-b', 'beta')
    await vault.set('provider-c', 'gamma')

    await vault.deleteMany(['provider-a', 'provider-b', 'provider-a'])

    expect(vault.has('provider-a')).toBe(false)
    expect(vault.has('provider-b')).toBe(false)
    expect(vault.get('provider-c')).toBe('gamma')
    const reloaded = new SecretVault(filePath)
    await reloaded.load()
    expect(reloaded.has('provider-a')).toBe(false)
    expect(reloaded.has('provider-b')).toBe(false)
    expect(reloaded.get('provider-c')).toBe('gamma')
  })

  it('keeps every reference in memory when an atomic delete cannot publish', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    await vault.load()
    await vault.set('provider-a', 'alpha')
    await vault.set('provider-b', 'beta')
    await unlink(filePath)
    await mkdir(filePath)

    await expect(
      vault.deleteMany(['provider-a', 'provider-b'])
    ).rejects.toThrow()

    expect(vault.get('provider-a')).toBe('alpha')
    expect(vault.get('provider-b')).toBe('beta')
  })

  it('reports a late directory-sync failure as an ambiguous vault publication', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const syncFailure = Object.assign(new Error('directory sync failed'), {
      code: 'EIO'
    })
    const vault = new SecretVault(filePath, async () => {
      throw syncFailure
    })
    await vault.load()

    await expect(vault.set('provider-a', 'alpha')).rejects.toBeInstanceOf(
      SecretVaultPersistenceError
    )

    // The rename happened before the late error, but this process did not
    // advance its in-memory generation.
    expect(vault.has('provider-a')).toBe(false)
    const selectedDiskGeneration = new SecretVault(filePath)
    await selectedDiskGeneration.load()
    expect(selectedDiskGeneration.get('provider-a')).toBe('alpha')
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
    const notice = await vault.load()

    expect(vault.has('provider-1')).toBe(false)
    expect(notice).toMatchObject({
      kind: 'credential-warning',
      title: 'Saved credentials need attention'
    })
    expect(notice?.detail).not.toContain(filePath)
    const entries = await readdir(directory)
    expect(entries.some((name) => name.startsWith('secrets.json.unreadable-'))).toBe(
      true
    )
  })

  it('does not warn for a missing or valid encrypted vault', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    const vault = new SecretVault(filePath)
    expect(await vault.load()).toBeUndefined()
    await vault.set('provider-1', 'secret')

    const reloaded = new SecretVault(filePath)
    expect(await reloaded.load()).toBeUndefined()
    expect(reloaded.get('provider-1')).toBe('secret')
  })

  it.runIf(
    process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() !== 0
  )('does not open empty when an unreadable vault cannot be quarantined', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-vault-'))
    const filePath = path.join(directory, 'secrets.json')
    await writeFile(filePath, '{"provider-1":"plain text"}', 'utf8')
    await chmod(directory, 0o500)

    try {
      await expect(new SecretVault(filePath).load()).rejects.toThrow()
    } finally {
      await chmod(directory, 0o700)
    }
    expect(await readFile(filePath, 'utf8')).toBe(
      '{"provider-1":"plain text"}'
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
    const reloaded = new SecretVault(filePath)
    expect(await reloaded.load()).toBeUndefined()
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('secrets.json.unreadable-')
      )
    ).toBe(false)
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
