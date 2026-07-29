import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  CliProvider,
  ModelApiProvider,
  ProviderProfile
} from '../shared/types'
import { cliEnvironmentSecretReference } from './cli-environment'
import {
  drainPendingSecretDeletes,
  findCredentialRecoveryNotice,
  liveCredentialReferences,
  reconcileCredentialVault
} from './credential-recovery'
import { providerCredentialReferenceFor } from './provider-credentials'
import {
  SecretVaultPersistenceError,
  type SecretVault
} from './secrets'
import {
  StatePersistenceError,
  StateStore
} from './store'

class FakeVault implements Pick<SecretVault, 'get' | 'has'> {
  constructor(protected readonly values = new Map<string, string>()) {}

  get(reference: string): string | undefined {
    return this.values.get(reference)
  }

  has(reference: string): boolean {
    return this.get(reference) !== undefined
  }
}

class FakeCleanupVault extends FakeVault {
  readonly deleted: string[] = []
  failDelete = false

  async deleteMany(references: Iterable<string>): Promise<void> {
    if (this.failDelete) throw new Error('vault cleanup failed')
    for (const reference of references) {
      this.deleted.push(reference)
      this.values.delete(reference)
    }
  }

  assertSteadyState(): void {}

  contains(reference: string): boolean {
    return this.values.has(reference)
  }
}

function apiProvider(
  overrides: Partial<ModelApiProvider> = {}
): ModelApiProvider {
  return {
    id: 'api-provider',
    name: 'Provider',
    kind: 'openai',
    model: 'model',
    baseUrl: 'https://api.example.com/v1',
    hasApiKey: true,
    supportsTools: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function cliProvider(overrides: Partial<CliProvider> = {}): CliProvider {
  return {
    id: 'cli-provider',
    name: 'CLI',
    kind: 'cli',
    model: '',
    command: '/usr/bin/example',
    args: [],
    promptMode: 'stdin',
    outputMode: 'plain',
    environmentVariables: ['TOKEN'],
    environmentFingerprint: 'a'.repeat(64),
    trustConfirmed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('credential recovery', () => {
  it('does not warn for providers that claim no saved credentials', () => {
    expect(
      findCredentialRecoveryNotice(
        [
          apiProvider({
            kind: 'openai-compatible',
            hasApiKey: false
          }),
          cliProvider({
            environmentVariables: [],
            environmentFingerprint: undefined
          })
        ],
        new FakeVault()
      )
    ).toBeUndefined()
  })

  it('warns when an API credential is unavailable', () => {
    const notice = findCredentialRecoveryNotice(
      [apiProvider()],
      new FakeVault()
    )
    expect(notice).toMatchObject({
      kind: 'credential-warning',
      title: 'Saved credentials need attention'
    })
    expect(notice?.detail).not.toContain('api-provider')
  })

  it('accepts scoped entries and limits provider-id fallback to legacy profiles', () => {
    const provider = apiProvider()
    expect(
      findCredentialRecoveryNotice(
        [provider],
        new FakeVault(
          new Map([[providerCredentialReferenceFor(provider), 'secret']])
        )
      )
    ).toBeUndefined()
    expect(
      findCredentialRecoveryNotice(
        [provider],
        new FakeVault(new Map([[provider.id, 'legacy-secret']]))
      )
    ).toBeUndefined()
    expect(
      findCredentialRecoveryNotice(
        [
          apiProvider({
            credentialRevision: 'credential_current'
          })
        ],
        new FakeVault(new Map([[provider.id, 'wrong-legacy-secret']]))
      )
    ).toMatchObject({ kind: 'credential-warning' })
  })

  it('validates CLI environment envelopes instead of trusting metadata alone', () => {
    const provider = cliProvider()
    const reference = cliEnvironmentSecretReference(provider.id)
    expect(
      findCredentialRecoveryNotice([provider], new FakeVault())
    ).toMatchObject({ kind: 'credential-warning' })
    expect(
      findCredentialRecoveryNotice(
        [provider],
        new FakeVault(new Map([[reference, '{"version":1}']]))
      )
    ).toMatchObject({ kind: 'credential-warning' })
    const envelope = JSON.stringify({
      version: 1,
      fingerprint: provider.environmentFingerprint,
      values: { TOKEN: 'secret-value' }
    })
    expect(
      findCredentialRecoveryNotice(
        [provider],
        new FakeVault(new Map([[reference, envelope]]))
      )
    ).toBeUndefined()
  })

  it('reports one bounded generic warning without exposing credential metadata', () => {
    const providers: ProviderProfile[] = [
      apiProvider(),
      cliProvider()
    ]
    const notice = findCredentialRecoveryNotice(providers, new FakeVault())
    expect(notice?.detail).not.toContain('api-provider')
    expect(notice?.detail).not.toContain('cli-provider')
    expect(notice?.detail).not.toContain('TOKEN')
    expect(notice?.detail.length).toBeLessThan(300)
  })

  it('derives exact live references without using decryption availability', () => {
    const legacyApi = apiProvider()
    const versionedApi = apiProvider({
      id: 'versioned-api',
      credentialRevision: 'credential_current'
    })
    const legacyCli = cliProvider()
    const versionedCli = cliProvider({
      id: 'versioned-cli',
      environmentRevision: 'b'.repeat(64)
    })

    expect(
      [...liveCredentialReferences([
        legacyApi,
        versionedApi,
        apiProvider({ id: 'keyless', hasApiKey: false }),
        legacyCli,
        versionedCli,
        cliProvider({
          id: 'environment-free',
          environmentVariables: [],
          environmentFingerprint: undefined
        })
      ])].sort()
    ).toEqual(
      [
        providerCredentialReferenceFor(legacyApi),
        legacyApi.id,
        providerCredentialReferenceFor(versionedApi),
        cliEnvironmentSecretReference(legacyCli.id),
        cliEnvironmentSecretReference(
          versionedCli.id,
          versionedCli.environmentRevision
        )
      ].sort()
    )
  })

  it('drains only journaled non-live references and retires a stale live intent', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'ground-credential-journal-')
    )
    const store = new StateStore(path.join(directory, 'state.json'))
    await store.load()
    const provider = apiProvider({
      id: 'journal-api',
      credentialRevision: 'credential_current'
    })
    await store.upsertProvider(provider)
    const live = providerCredentialReferenceFor(provider)
    const obsolete = 'provider-credential:v1:obsolete'
    const unrelated = 'unknown-future-secret'
    await store.queueProvisionalSecretDelete(live)
    await store.queueProvisionalSecretDelete(obsolete)
    const vault = new FakeCleanupVault(
      new Map([
        [live, 'live-secret'],
        [obsolete, 'old-secret'],
        [unrelated, 'preserve-without-guessing']
      ])
    )

    const result = await drainPendingSecretDeletes(
      store,
      vault as unknown as SecretVault
    )

    expect(result).toEqual({
      deferred: false,
      retiredLiveIntents: 1,
      deletedReferences: 1
    })
    expect(vault.deleted).toEqual([obsolete])
    expect(vault.contains(live)).toBe(true)
    expect(vault.contains(unrelated)).toBe(true)
    expect(store.pendingSecretDeletes()).toEqual([])
  })

  it('keeps the durable journal when vault cleanup fails', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'ground-credential-journal-')
    )
    const store = new StateStore(path.join(directory, 'state.json'))
    await store.load()
    const obsolete = 'provider-credential:v2:pending'
    await store.queueProvisionalSecretDelete(obsolete)
    const vault = new FakeCleanupVault(
      new Map([[obsolete, 'staged-secret']])
    )
    vault.failDelete = true

    await expect(
      drainPendingSecretDeletes(
        store,
        vault as unknown as SecretVault
      )
    ).rejects.toThrow(/cleanup failed/i)
    expect(store.pendingSecretDeletes()).toEqual([obsolete])
    expect(vault.contains(obsolete)).toBe(true)
  })

  it('defers every queued delete after state fallback recovery', async () => {
    const obsolete = 'provider-credential:v2:pending'
    const acknowledge = vi.fn()
    const store = {
      pendingSecretDeletes: () => [obsolete],
      shouldDeferPendingSecretDeletes: () => true,
      snapshot: () => ({
        providers: [],
        mcpServers: [],
        tasks: [],
        settings: { sidebarCollapsed: false }
      }),
      acknowledgeSecretDeletes: acknowledge
    }
    const vault = new FakeCleanupVault(
      new Map([[obsolete, 'preserved-secret']])
    )

    await expect(
      drainPendingSecretDeletes(
        store as unknown as StateStore,
        vault as unknown as SecretVault
      )
    ).resolves.toEqual({
      deferred: true,
      retiredLiveIntents: 0,
      deletedReferences: 0
    })
    expect(vault.deleted).toEqual([])
    expect(vault.contains(obsolete)).toBe(true)
    expect(acknowledge).not.toHaveBeenCalled()
  })

  it('aborts startup reconciliation after ambiguous vault publication', async () => {
    const obsolete = 'provider-credential:v2:pending'
    const store = {
      pendingSecretDeletes: () => [obsolete],
      shouldDeferPendingSecretDeletes: () => false,
      snapshot: () => ({
        providers: [],
        mcpServers: [],
        tasks: [],
        settings: { sidebarCollapsed: false }
      }),
      acknowledgeSecretDeletes: vi.fn()
    }
    const vault = {
      deleteMany: vi.fn(async () => {
        throw new SecretVaultPersistenceError(
          Object.assign(new Error('directory sync failed'), { code: 'EIO' })
        )
      }),
      assertSteadyState: vi.fn()
    }

    await expect(
      reconcileCredentialVault(
        store as unknown as StateStore,
        vault as unknown as SecretVault
      )
    ).rejects.toBeInstanceOf(SecretVaultPersistenceError)
    expect(store.acknowledgeSecretDeletes).not.toHaveBeenCalled()
  })

  it('aborts startup reconciliation after ambiguous journal acknowledgement', async () => {
    const obsolete = 'provider-credential:v2:pending'
    const store = {
      pendingSecretDeletes: () => [obsolete],
      shouldDeferPendingSecretDeletes: () => false,
      snapshot: () => ({
        providers: [],
        mcpServers: [],
        tasks: [],
        settings: { sidebarCollapsed: false }
      }),
      acknowledgeSecretDeletes: vi.fn(async () => {
        throw new StatePersistenceError(
          Object.assign(new Error('directory sync failed'), { code: 'EIO' })
        )
      })
    }
    const vault = {
      deleteMany: vi.fn(async () => undefined),
      assertSteadyState: vi.fn()
    }

    await expect(
      reconcileCredentialVault(
        store as unknown as StateStore,
        vault as unknown as SecretVault
      )
    ).rejects.toBeInstanceOf(StatePersistenceError)
    expect(vault.deleteMany).toHaveBeenCalledWith([obsolete])
    expect(vault.assertSteadyState).not.toHaveBeenCalled()
  })
})
