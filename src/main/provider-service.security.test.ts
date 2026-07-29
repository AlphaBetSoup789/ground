import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CliProvider,
  ModelApiProvider,
  ModelProviderKind,
  ProviderProfile
} from '../shared/types'
import { cliEnvironmentSecretReference } from './cli-environment'
import {
  providerCredentialReference,
  providerCredentialReferenceFor,
  resolveProviderCredential
} from './provider-credentials'
import {
  assertProviderCanStartRun,
  ProviderService
} from './provider-service'
import {
  ProviderOperationGate,
  type ProviderStartBinding
} from './provider-operation-gate'
import {
  SecretVault,
  SecretVaultPersistenceError
} from './secrets'
import {
  StatePersistenceError,
  StateStore
} from './store'
import { CliTrustRegistry } from './trust-boundary'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

function apiProvider(
  baseUrl: string,
  kind: ModelProviderKind = 'openai-compatible'
): ModelApiProvider {
  return {
    id: 'provider-one',
    name: 'Provider one',
    kind,
    baseUrl,
    model: 'model-one',
    hasApiKey: true,
    supportsTools: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  } as ModelApiProvider
}

function cliProvider(
  fingerprint = 'a'.repeat(64)
): CliProvider {
  return {
    id: 'provider-one',
    name: 'Enterprise CLI',
    kind: 'cli',
    model: '',
    command: process.execPath,
    args: [],
    promptMode: 'stdin',
    outputMode: 'plain',
    cliAdapter: 'generic',
    environmentVariables: ['ACME_AGENT_TOKEN'],
    environmentFingerprint: fingerprint,
    trustConfirmed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function providerStartBinding(
  provider: ProviderProfile
): ProviderStartBinding {
  return {
    taskId: 'task-one',
    taskRevision: 'task-revision-one',
    providerId: provider.id,
    providerRevision: provider.updatedAt,
    providerFingerprint: 'a'.repeat(64),
    credentialBoundary: 'credential-boundary-one'
  }
}

function createHarness(
  provider: ProviderProfile,
  secret = 'top-secret',
  credentialLocation: 'scoped' | 'legacy' = 'scoped',
  isProviderActive: (providerId: string) => boolean = () => false,
  providerOperations?: ProviderOperationGate,
  onPersistenceUncertain?: (error: Error) => void
): {
  service: ProviderService
  vault: {
    get: ReturnType<typeof vi.fn>
    has: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    deleteMany: ReturnType<typeof vi.fn>
  }
  upsert: ReturnType<typeof vi.fn>
  deleteProvider: ReturnType<typeof vi.fn>
  queueProvisional: ReturnType<typeof vi.fn>
  publishTransition: ReturnType<typeof vi.fn>
  secrets: Map<string, string>
  pending: () => string[]
  current: () => ProviderProfile
} {
  let current = provider
  let deleted = false
  const pendingSecretDeletes = new Set<string>()
  const secrets = new Map<string, string>()
  if (secret) {
    secrets.set(
      credentialLocation === 'legacy' || provider.kind === 'cli'
        ? provider.id
        : providerCredentialReferenceFor(provider),
      secret
    )
  }
  const upsert = vi.fn(async (next: ProviderProfile) => {
    current = next
    deleted = false
  })
  const deleteProvider = vi.fn(async (_providerId?: string) => {
    deleted = true
  })
  const store = {
    getProvider: (id: string) => {
      if (deleted || id !== current.id) throw new Error('Provider not found')
      return current
    },
    upsertProvider: upsert,
    deleteProvider,
    queueProvisionalSecretDelete: vi.fn(async (reference: string) => {
      pendingSecretDeletes.add(reference)
    }),
    publishProviderSecretTransition: vi.fn(
      async (
        next: ProviderProfile,
        stagedReference: string | undefined,
        obsoleteReferences: readonly string[]
      ) => {
        await upsert(next)
        if (stagedReference) pendingSecretDeletes.delete(stagedReference)
        for (const reference of obsoleteReferences) {
          if (reference !== stagedReference) {
            pendingSecretDeletes.add(reference)
          }
        }
      }
    ),
    deleteProviderWithSecretTransition: vi.fn(
      async (
        providerId: string,
        obsoleteReferences: readonly string[]
      ) => {
        await deleteProvider(providerId)
        for (const reference of obsoleteReferences) {
          pendingSecretDeletes.add(reference)
        }
      }
    ),
    pendingSecretDeletes: () => [...pendingSecretDeletes],
    shouldDeferPendingSecretDeletes: () => false,
    snapshot: () => ({
      providers: deleted ? [] : [current],
      mcpServers: [],
      tasks: [],
      settings: { sidebarCollapsed: false }
    }),
    acknowledgeSecretDeletes: vi.fn(async (references: readonly string[]) => {
      for (const reference of references) {
        pendingSecretDeletes.delete(reference)
      }
    })
  }
  const vault = {
    get: vi.fn((reference: string) => secrets.get(reference)),
    has: vi.fn((reference: string) => secrets.has(reference)),
    set: vi.fn(async (reference: string, value: string) => {
      secrets.set(reference, value)
    }),
    delete: vi.fn(async (reference: string) => {
      secrets.delete(reference)
    }),
    deleteMany: vi.fn(async (references: Iterable<string>) => {
      const failures: unknown[] = []
      for (const reference of references) {
        try {
          await vault.delete(reference)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length) throw new AggregateError(failures)
    }),
    assertSteadyState: vi.fn()
  }
  const cliTrust = new CliTrustRegistry(async () => true)
  return {
    service: new ProviderService(
      store as unknown as StateStore,
      vault as unknown as SecretVault,
      cliTrust,
      isProviderActive,
      providerOperations,
      () => [],
      onPersistenceUncertain
    ),
    vault,
    upsert,
    deleteProvider,
    queueProvisional: store.queueProvisionalSecretDelete,
    publishTransition: store.publishProviderSecretTransition,
    secrets,
    pending: () => [...pendingSecretDeletes],
    current: () => current
  }
}

interface RequestSnapshot {
  url: string
  authorization?: string
  anthropicApiKey?: string
  anthropicVersion?: string
  googleApiKey?: string
}

async function listeningServer(
  onRequest: (request: RequestSnapshot) => void,
  payload: string = '{"data":[{"id":"model-one"}]}'
): Promise<string> {
  const server = createServer((request, response) => {
    onRequest({
      url: request.url ?? '',
      authorization: request.headers.authorization,
      anthropicApiKey: request.headers['x-api-key'] as string | undefined,
      anthropicVersion: request.headers['anthropic-version'] as string | undefined,
      googleApiKey: request.headers['x-goog-api-key'] as string | undefined
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(payload)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

async function providerEndpointFor(
  server: ReturnType<typeof createServer>
): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

describe('provider credential origin binding', () => {
  it('refuses to mutate or delete a provider captured by an active run', async () => {
    const provider = apiProvider('https://api.example.com/v1')
    const harness = createHarness(
      provider,
      'top-secret',
      'scoped',
      (providerId) => providerId === provider.id
    )

    await expect(
      harness.service.save({
        id: provider.id,
        name: 'Changed provider',
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        supportsTools: true
      })
    ).rejects.toThrow('Stop active runs')
    await expect(harness.service.delete(provider.id)).rejects.toThrow(
      'Stop active runs'
    )
    expect(harness.upsert).not.toHaveBeenCalled()
    expect(harness.deleteProvider).not.toHaveBeenCalled()
    expect(harness.vault.delete).not.toHaveBeenCalled()
  })

  it('refuses to mutate or delete a provider reserved by a starting run', async () => {
    const provider = apiProvider('https://api.example.com/v1')
    const providerOperations = new ProviderOperationGate()
    const start = providerOperations.reserveStart(
      providerStartBinding(provider)
    )
    const harness = createHarness(
      provider,
      'top-secret',
      'scoped',
      () => false,
      providerOperations
    )

    await expect(
      harness.service.save({
        id: provider.id,
        name: 'Changed provider',
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        supportsTools: true
      })
    ).rejects.toThrow(/starting runs/i)
    await expect(harness.service.delete(provider.id)).rejects.toThrow(
      /starting runs/i
    )
    expect(harness.upsert).not.toHaveBeenCalled()
    expect(harness.deleteProvider).not.toHaveBeenCalled()
    expect(harness.vault.set).not.toHaveBeenCalled()
    expect(harness.vault.delete).not.toHaveBeenCalled()

    providerOperations.releaseStart(start)
  })

  it('derives opaque references from the canonical provider boundary', () => {
    const canonical = providerCredentialReference(
      'provider-one',
      'openai',
      'https://API.example.com:443/v1'
    )

    expect(
      providerCredentialReference(
        'provider-one',
        'openai',
        'https://api.example.com/v1/'
      )
    ).toBe(canonical)
    expect(
      providerCredentialReference(
        'provider-one',
        'anthropic',
        'https://api.example.com/v1'
      )
    ).not.toBe(canonical)
    expect(
      providerCredentialReference(
        'provider-two',
        'openai',
        'https://api.example.com/v1'
      )
    ).not.toBe(canonical)
    expect(canonical).not.toContain('provider-one')
    expect(canonical).not.toContain('api.example.com')
    const firstVersion = providerCredentialReference(
      'provider-one',
      'openai',
      'https://api.example.com/v1',
      'credential_first'
    )
    const secondVersion = providerCredentialReference(
      'provider-one',
      'openai',
      'https://api.example.com/v1',
      'credential_second'
    )
    expect(firstVersion).toMatch(/^provider-credential:v2:/u)
    expect(firstVersion).not.toBe(secondVersion)
    expect(firstVersion).not.toBe(canonical)
  })

  it('never reuses a stored key for a changed draft endpoint', async () => {
    let attackerRequests = 0
    const attackerEndpoint = await listeningServer(() => {
      attackerRequests += 1
    })
    const harness = createHarness(
      apiProvider('http://127.0.0.1:41001/v1'),
      'top-secret',
      'legacy'
    )

    const result = await harness.service.test({
      id: 'provider-one',
      name: 'Provider one',
      kind: 'openai-compatible',
      baseUrl: attackerEndpoint,
      model: 'model-one'
    })

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/re-enter/i)
    expect(attackerRequests).toBe(0)
    expect(harness.vault.get).not.toHaveBeenCalled()
    expect(harness.vault.has).not.toHaveBeenCalled()
  })

  it('reuses a stored key only when the canonical full endpoint matches', async () => {
    let authorization: string | undefined
    const endpoint = await listeningServer((request) => {
      authorization = request.authorization
    })
    const harness = createHarness(apiProvider(endpoint))

    const result = await harness.service.test({
      id: 'provider-one',
      name: 'Provider one',
      kind: 'openai-compatible',
      baseUrl: `${endpoint}/`,
      model: 'model-one'
    })

    expect(result.ok).toBe(true)
    expect(authorization).toBe('Bearer top-secret')
    expect(harness.vault.get).toHaveBeenCalledWith(
      providerCredentialReferenceFor(apiProvider(endpoint))
    )
  })

  it('persists a keyless changed endpoint before clearing the old credential', async () => {
    const existing = apiProvider('https://api.example.com/v1')
    const oldReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing)

    const saved = await harness.service.save({
      id: 'provider-one',
      name: 'Moved provider',
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v2',
      model: 'model-two'
    })

    expect(harness.vault.delete).toHaveBeenCalledWith(oldReference)
    expect(harness.vault.delete).toHaveBeenCalledWith('provider-one')
    expect(harness.vault.set).not.toHaveBeenCalled()
    expect(harness.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      harness.vault.delete.mock.invocationCallOrder[0] as number
    )
    expect(harness.secrets.has(oldReference)).toBe(false)
    expect(saved).toMatchObject({
      baseUrl: 'https://api.example.com/v2',
      hasApiKey: false
    })
  })

  it('migrates a stored legacy scoped key when saving the same canonical boundary', async () => {
    const endpoint = 'https://api.example.com/v1'
    const existing = apiProvider(endpoint, 'openai')
    const reference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing)

    const saved = await harness.service.save({
      id: 'provider-one',
      name: 'Renamed provider',
      kind: 'openai',
      baseUrl: `${endpoint}/`,
      model: 'model-two'
    })

    expect(saved).toHaveProperty('credentialRevision')
    if (saved.kind === 'cli') throw new Error('Expected an API provider')
    const versionedReference = providerCredentialReferenceFor(saved)
    expect(harness.vault.set).toHaveBeenCalledWith(
      versionedReference,
      'top-secret'
    )
    expect(harness.vault.delete).toHaveBeenCalledWith('provider-one')
    expect(harness.vault.delete).toHaveBeenCalledWith(reference)
    expect(harness.secrets.get(versionedReference)).toBe('top-secret')
    expect(saved).toMatchObject({
      kind: 'openai',
      baseUrl: endpoint,
      hasApiKey: true
    })
  })

  it('fails closed on a blank same-boundary save when the exact versioned key is unreadable', async () => {
    const existing: ModelApiProvider = {
      ...apiProvider(
        'https://api.example.com/v1',
        'openai-compatible'
      ),
      credentialRevision: 'credential_current'
    }
    const exactReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing, 'stale-legacy-secret', 'legacy')

    await expect(
      harness.service.save({
        id: existing.id,
        name: 'Renamed compatible provider',
        kind: existing.kind,
        baseUrl: existing.baseUrl,
        model: existing.model
      })
    ).rejects.toThrow(/saved API key is unavailable/i)

    expect(harness.vault.get).toHaveBeenCalledWith(exactReference)
    expect(harness.vault.get).not.toHaveBeenCalledWith(existing.id)
    expect(harness.upsert).not.toHaveBeenCalled()
    expect(harness.vault.delete).not.toHaveBeenCalled()
    expect(harness.secrets.get(existing.id)).toBe('stale-legacy-secret')
  })

  it('does not reuse a stored key when the provider protocol changes', async () => {
    let requests = 0
    const endpoint = await listeningServer(() => {
      requests += 1
    })
    const harness = createHarness(apiProvider(endpoint, 'openai'))

    const result = await harness.service.test({
      id: 'provider-one',
      name: 'Provider one',
      kind: 'anthropic',
      baseUrl: endpoint,
      model: 'model-one'
    })

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/re-enter/i)
    expect(requests).toBe(0)
    expect(harness.vault.get).not.toHaveBeenCalled()
  })

  it('stages a replacement credential before persisting and only then clears the old boundary', async () => {
    const existing = apiProvider('https://api.example.com/v1', 'openai')
    const oldReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing)

    const saved = await harness.service.save({
      id: 'provider-one',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.example.com/v1',
      model: 'model-two',
      apiKey: 'replacement-secret'
    })
    if (saved.kind === 'cli') throw new Error('Expected an API provider')
    const newReference = providerCredentialReferenceFor(saved)

    expect(harness.vault.set).toHaveBeenCalledWith(
      newReference,
      'replacement-secret'
    )
    expect(
      harness.queueProvisional.mock.invocationCallOrder[0]
    ).toBeLessThan(
      harness.vault.set.mock.invocationCallOrder[0] as number
    )
    expect(harness.vault.set.mock.invocationCallOrder[0]).toBeLessThan(
      harness.upsert.mock.invocationCallOrder[0] as number
    )
    expect(harness.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      harness.vault.delete.mock.invocationCallOrder[0] as number
    )
    expect(harness.vault.delete).toHaveBeenCalledWith(oldReference)
    expect(harness.vault.delete).toHaveBeenCalledWith('provider-one')
    expect(harness.secrets.get(newReference)).toBe('replacement-secret')
    expect(harness.secrets.has(oldReference)).toBe(false)
    expect(saved).toMatchObject({
      kind: 'anthropic',
      baseUrl: 'https://api.example.com/v1',
      hasApiKey: true
    })
  })

  it('requires a key for hosted native providers without mutating an existing boundary', async () => {
    const harness = createHarness(
      apiProvider('https://api.example.com/v1', 'openai'),
      ''
    )

    await expect(
      harness.service.save({
        id: 'provider-one',
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'model-two'
      })
    ).rejects.toThrow(/requires an API key/i)
    expect(harness.vault.delete).not.toHaveBeenCalled()
    expect(harness.upsert).not.toHaveBeenCalled()
  })

  it('rejects credentials too short for exact successful-output redaction', async () => {
    const harness = createHarness(
      apiProvider('https://api.example.com/v1', 'openai'),
      ''
    )

    await expect(
      harness.service.save({
        id: 'provider-one',
        name: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'model-two',
        apiKey: 'abc'
      })
    ).rejects.toThrow(/at least 4 characters/i)
    expect(harness.vault.set).not.toHaveBeenCalled()
    expect(harness.upsert).not.toHaveBeenCalled()
  })

  it('restores the exact prior credential state when profile persistence fails', async () => {
    const existing = apiProvider('https://api.example.com/v1', 'openai')
    const oldReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing, 'old-endpoint-secret')
    harness.upsert.mockRejectedValueOnce(new Error('state write failed'))

    await expect(
      harness.service.save({
        id: existing.id,
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-test',
        apiKey: 'new-endpoint-secret'
      })
    ).rejects.toThrow('state write failed')

    const stagedReference = harness.vault.set.mock.calls[0]?.[0] as
      | string
      | undefined
    expect(stagedReference).toMatch(/^provider-credential:v2:/u)
    expect(harness.secrets.get(oldReference)).toBe('old-endpoint-secret')
    expect(harness.secrets.has(stagedReference as string)).toBe(false)
    expect(harness.vault.delete).toHaveBeenCalledWith(stagedReference)
    expect(providerCredentialReferenceFor(harness.current() as ModelApiProvider)).toBe(
      oldReference
    )
    await expect(
      resolveProviderCredential(
        harness.vault as unknown as SecretVault,
        existing,
        oldReference
      )
    ).resolves.toBe('old-endpoint-secret')
    await expect(
      resolveProviderCredential(
        harness.vault as unknown as SecretVault,
        existing,
        stagedReference as string
      )
    ).resolves.toBeUndefined()
    expect(harness.secrets.get(oldReference)).not.toBe(
      'new-endpoint-secret'
    )
  })

  it('does not overwrite a passed same-boundary credential before publication', async () => {
    const existing: ModelApiProvider = {
      ...apiProvider('https://api.example.com/v1', 'openai'),
      credentialRevision: 'credential_previous',
      verification: {
        status: 'passed',
        scope: 'connection',
        checkedAt: '2026-07-29T12:00:00.000Z'
      }
    }
    const oldReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing, 'previous-secret')
    harness.upsert.mockRejectedValueOnce(new Error('state write failed'))

    await expect(
      harness.service.save({
        id: existing.id,
        name: existing.name,
        kind: existing.kind,
        baseUrl: existing.baseUrl,
        model: existing.model,
        apiKey: 'replacement-secret'
      })
    ).rejects.toThrow('state write failed')

    const stagedReference = harness.vault.set.mock.calls[0]?.[0] as string
    expect(stagedReference).not.toBe(oldReference)
    expect(stagedReference).toMatch(/^provider-credential:v2:/u)
    expect(harness.secrets.get(oldReference)).toBe('previous-secret')
    expect(harness.secrets.has(stagedReference)).toBe(false)
    expect(harness.current()).toEqual(existing)
    await expect(
      resolveProviderCredential(
        harness.vault as unknown as SecretVault,
        harness.current() as ModelApiProvider,
        oldReference
      )
    ).resolves.toBe('previous-secret')
    await expect(
      resolveProviderCredential(
        harness.vault as unknown as SecretVault,
        harness.current() as ModelApiProvider,
        stagedReference
      )
    ).resolves.toBeUndefined()
  })

  it('fails loudly when journaled staged-credential cleanup fails without repointing the passed profile', async () => {
    const existing: ModelApiProvider = {
      ...apiProvider('https://api.example.com/v1', 'openai'),
      credentialRevision: 'credential_previous',
      verification: {
        status: 'passed',
        scope: 'connection',
        checkedAt: '2026-07-29T12:00:00.000Z'
      }
    }
    const oldReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing, 'previous-secret')
    harness.upsert.mockRejectedValueOnce(new Error('state write failed'))
    harness.vault.delete.mockRejectedValueOnce(
      new Error('credential rollback failed')
    )

    await expect(
      harness.service.save({
        id: existing.id,
        name: existing.name,
        kind: existing.kind,
        baseUrl: existing.baseUrl,
        model: existing.model,
        apiKey: 'replacement-secret'
      })
    ).rejects.toThrow(/staged credential cleanup remains pending/i)

    const stagedReference = harness.vault.set.mock.calls[0]?.[0] as string
    expect(stagedReference).not.toBe(oldReference)
    expect(harness.secrets.get(oldReference)).toBe('previous-secret')
    expect(harness.secrets.get(stagedReference)).toBe(
      'replacement-secret'
    )
    expect(harness.current()).toEqual(existing)
    await expect(
      resolveProviderCredential(
        harness.vault as unknown as SecretVault,
        harness.current() as ModelApiProvider,
        oldReference
      )
    ).resolves.toBe('previous-secret')
    await expect(
      resolveProviderCredential(
        harness.vault as unknown as SecretVault,
        harness.current() as ModelApiProvider,
        stagedReference
      )
    ).resolves.toBeUndefined()
  })

  it('does not delete either generation after an uncertain state publication', async () => {
    const existing: ModelApiProvider = {
      ...apiProvider('https://api.example.com/v1', 'openai'),
      credentialRevision: 'credential_previous'
    }
    const oldReference = providerCredentialReferenceFor(existing)
    const onPersistenceUncertain = vi.fn()
    const harness = createHarness(
      existing,
      'previous-secret',
      'scoped',
      () => false,
      undefined,
      onPersistenceUncertain
    )
    harness.upsert.mockRejectedValueOnce(
      new StatePersistenceError(new Error('directory fsync failed'))
    )

    await expect(
      harness.service.save({
        id: existing.id,
        name: existing.name,
        kind: existing.kind,
        baseUrl: existing.baseUrl,
        model: existing.model,
        apiKey: 'replacement-secret'
      })
    ).rejects.toThrow(/must relaunch/i)

    const stagedReference = harness.vault.set.mock.calls[0]?.[0] as string
    expect(onPersistenceUncertain).toHaveBeenCalledWith(
      expect.any(StatePersistenceError)
    )
    expect(harness.secrets.get(oldReference)).toBe('previous-secret')
    expect(harness.secrets.get(stagedReference)).toBe(
      'replacement-secret'
    )
    expect(harness.pending()).toEqual([stagedReference])
    expect(harness.vault.delete).not.toHaveBeenCalled()
    expect(harness.current()).toEqual(existing)
  })

  it('keeps the provisional journal and exits on an uncertain vault stage', async () => {
    const existing: ModelApiProvider = {
      ...apiProvider('https://api.example.com/v1', 'openai'),
      credentialRevision: 'credential_previous'
    }
    const onPersistenceUncertain = vi.fn()
    const harness = createHarness(
      existing,
      'previous-secret',
      'scoped',
      () => false,
      undefined,
      onPersistenceUncertain
    )
    harness.vault.set.mockRejectedValueOnce(
      new SecretVaultPersistenceError(new Error('directory fsync failed'))
    )

    await expect(
      harness.service.save({
        id: existing.id,
        name: existing.name,
        kind: existing.kind,
        baseUrl: existing.baseUrl,
        model: existing.model,
        apiKey: 'replacement-secret'
      })
    ).rejects.toThrow(/must relaunch/i)

    expect(onPersistenceUncertain).toHaveBeenCalledWith(
      expect.any(SecretVaultPersistenceError)
    )
    expect(harness.pending()).toHaveLength(1)
    expect(harness.pending()[0]).toMatch(/^provider-credential:v2:/u)
    expect(harness.vault.delete).not.toHaveBeenCalled()
    expect(harness.current()).toEqual(existing)
  })

  it('uses a legacy provider-id key read-only on the unchanged persisted boundary', async () => {
    let authorization: string | undefined
    const endpoint = await listeningServer((request) => {
      authorization = request.authorization
    })
    const existing = apiProvider(endpoint)
    const scopedReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing, 'legacy-secret', 'legacy')

    const result = await harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: `${endpoint}/`,
      model: existing.model
    })

    expect(result.ok).toBe(true)
    expect(authorization).toBe('Bearer legacy-secret')
    expect(harness.vault.get).toHaveBeenCalledWith(scopedReference)
    expect(harness.vault.get).toHaveBeenCalledWith(existing.id)
    expect(harness.vault.set).not.toHaveBeenCalled()
    expect(harness.vault.delete).not.toHaveBeenCalled()
    expect(harness.secrets.has(scopedReference)).toBe(false)
    expect(harness.secrets.get(existing.id)).toBe('legacy-secret')
  })

  it('never resolves a provider-id legacy key for a versioned profile', async () => {
    const existing: ModelApiProvider = {
      ...apiProvider('https://api.example.com/v1', 'openai'),
      credentialRevision: 'credential_current'
    }
    const expectedReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(
      existing,
      'wrong-legacy-secret',
      'legacy'
    )

    await expect(
      resolveProviderCredential(
        harness.vault as unknown as SecretVault,
        existing,
        expectedReference
      )
    ).resolves.toBeUndefined()

    expect(harness.vault.get).toHaveBeenCalledWith(expectedReference)
    expect(harness.vault.get).not.toHaveBeenCalledWith(existing.id)
    expect(harness.vault.set).not.toHaveBeenCalled()
    expect(harness.vault.delete).not.toHaveBeenCalled()
  })

  it('restores a legacy-only key exactly when versioned migration cannot publish', async () => {
    const existing = apiProvider('https://api.example.com/v1', 'openai')
    const scopedReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing, 'legacy-secret', 'legacy')
    harness.upsert.mockRejectedValueOnce(new Error('state write failed'))

    await expect(
      harness.service.save({
        id: existing.id,
        name: 'Renamed provider',
        kind: existing.kind,
        baseUrl: existing.baseUrl,
        model: existing.model
      })
    ).rejects.toThrow('state write failed')

    const stagedReference = harness.vault.set.mock.calls[0]?.[0] as string
    expect(stagedReference).not.toBe(scopedReference)
    expect(harness.secrets.has(scopedReference)).toBe(false)
    expect(harness.secrets.has(stagedReference)).toBe(false)
    expect(harness.secrets.get(existing.id)).toBe('legacy-secret')
    expect(harness.vault.delete).toHaveBeenCalledWith(stagedReference)
  })

  it('does not probe a stored entry when the persisted profile says it has no key', async () => {
    let authorization: string | undefined
    const endpoint = await listeningServer((request) => {
      authorization = request.authorization
    })
    const existing = {
      ...apiProvider(endpoint),
      hasApiKey: false
    } as ModelApiProvider
    const harness = createHarness(existing, 'orphaned-secret', 'legacy')

    const result = await harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model
    })

    expect(result.ok).toBe(true)
    expect(authorization).toBeUndefined()
    expect(harness.vault.get).not.toHaveBeenCalled()
    expect(harness.vault.has).not.toHaveBeenCalled()
  })

  it('persists provider deletion before cleaning scoped and legacy credentials', async () => {
    const existing = apiProvider('https://api.example.com/v1')
    const scopedReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing)

    await harness.service.delete(existing.id)

    expect(harness.deleteProvider.mock.invocationCallOrder[0]).toBeLessThan(
      harness.vault.delete.mock.invocationCallOrder[0] as number
    )
    expect(harness.vault.delete).toHaveBeenCalledWith(scopedReference)
    expect(harness.vault.delete).toHaveBeenCalledWith(existing.id)
  })

  it('does not clean credentials when provider deletion fails to persist', async () => {
    const existing = apiProvider('https://api.example.com/v1')
    const scopedReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing)
    harness.deleteProvider.mockRejectedValueOnce(new Error('state write failed'))

    await expect(harness.service.delete(existing.id)).rejects.toThrow(
      'state write failed'
    )

    expect(harness.vault.delete).not.toHaveBeenCalled()
    expect(harness.secrets.get(scopedReference)).toBe('top-secret')
  })

  it('reports every credential cleanup failure after durable provider deletion', async () => {
    const existing = apiProvider('https://api.example.com/v1')
    const scopedReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing)
    harness.vault.delete.mockRejectedValue(
      new Error('vault write failed')
    )

    await expect(harness.service.delete(existing.id)).rejects.toThrow(
      /saved credentials could not be removed/i
    )

    expect(harness.deleteProvider).toHaveBeenCalledOnce()
    expect(harness.vault.delete).toHaveBeenCalledWith(scopedReference)
    expect(harness.vault.delete).toHaveBeenCalledWith(existing.id)
    expect(harness.vault.delete).toHaveBeenCalledTimes(2)
  })

  it('does not clean an API credential when conversion to CLI fails to persist', async () => {
    const existing = apiProvider('https://api.example.com/v1')
    const scopedReference = providerCredentialReferenceFor(existing)
    const harness = createHarness(existing)
    harness.upsert.mockRejectedValueOnce(new Error('state write failed'))

    await expect(
      harness.service.save({
        id: existing.id,
        name: 'Local CLI',
        kind: 'cli',
        model: '',
        command: process.execPath,
        args: [],
        promptMode: 'stdin',
        outputMode: 'plain',
        cliAdapter: 'generic',
        trustConfirmed: true
      })
    ).rejects.toThrow('state write failed')

    expect(harness.vault.delete).not.toHaveBeenCalled()
    expect(harness.secrets.get(scopedReference)).toBe('top-secret')
  })

  it('stores CLI environment values only in the encrypted vault record', async () => {
    const existing = apiProvider('https://api.example.com/v1')
    const harness = createHarness(existing)
    const secret = 'enterprise-environment-secret'

    const saved = await harness.service.save({
      id: existing.id,
      name: 'Enterprise CLI',
      kind: 'cli',
      model: '',
      command: process.execPath,
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      cliEnvironment: [{ name: 'ACME_AGENT_TOKEN', value: secret }],
      trustConfirmed: true
    })

    expect(saved).toMatchObject({
      environmentVariables: ['ACME_AGENT_TOKEN']
    })
    expect(saved).toHaveProperty('environmentFingerprint')
    expect(saved).toHaveProperty('environmentRevision')
    expect(JSON.stringify(saved)).not.toContain(secret)
    if (saved.kind !== 'cli') throw new Error('Expected a CLI provider')
    const environmentReference = cliEnvironmentSecretReference(
      saved.id,
      saved.environmentRevision
    )
    expect(harness.secrets.get(environmentReference)).toContain(secret)
    expect(harness.current()).toEqual(saved)
  })

  it('re-enters a complete CLI environment through a new version when the old record is unreadable', async () => {
    const existing = {
      ...cliProvider(),
      environmentRevision: 'b'.repeat(64)
    }
    const harness = createHarness(existing, '')
    const oldExact = cliEnvironmentSecretReference(
      existing.id,
      existing.environmentRevision
    )
    harness.secrets.set(oldExact, 'unreadable-ciphertext')
    harness.vault.get.mockImplementation((reference: string) =>
      reference === oldExact ? undefined : harness.secrets.get(reference)
    )

    const saved = await harness.service.save({
      id: existing.id,
      name: existing.name,
      kind: 'cli',
      model: '',
      command: process.execPath,
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      cliEnvironment: [
        { name: 'ACME_AGENT_TOKEN', value: 'replacement-secret' }
      ],
      trustConfirmed: true
    })

    if (saved.kind !== 'cli') throw new Error('Expected a CLI provider')
    expect(saved.environmentRevision).toMatch(/^[a-f0-9]{64}$/u)
    expect(saved.environmentRevision).not.toBe(existing.environmentRevision)
    const replacement = cliEnvironmentSecretReference(
      saved.id,
      saved.environmentRevision
    )
    expect(harness.secrets.get(replacement)).toContain('replacement-secret')
    expect(harness.secrets.has(oldExact)).toBe(false)
  })

  it('clears unreadable CLI environment ciphertext after publishing the environment-free profile', async () => {
    const existing = {
      ...cliProvider(),
      environmentRevision: 'b'.repeat(64)
    }
    const harness = createHarness(existing, '')
    const exact = cliEnvironmentSecretReference(
      existing.id,
      existing.environmentRevision
    )
    harness.secrets.set(exact, 'unreadable-ciphertext')
    harness.vault.get.mockImplementation((reference: string) =>
      reference === exact ? undefined : harness.secrets.get(reference)
    )

    const saved = await harness.service.save({
      id: existing.id,
      name: existing.name,
      kind: 'cli',
      model: '',
      command: process.execPath,
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      cliEnvironment: [],
      trustConfirmed: true
    })

    expect(saved).not.toHaveProperty('environmentVariables')
    expect(saved).not.toHaveProperty('environmentFingerprint')
    expect(saved).not.toHaveProperty('environmentRevision')
    expect(harness.upsert).toHaveBeenCalled()
    expect(harness.vault.delete).toHaveBeenCalledWith(exact)
    expect(harness.secrets.has(exact)).toBe(false)
  })

  it('deletes exact and legacy API and CLI credential references without decrypting them', async () => {
    const api = {
      ...apiProvider('https://api.example.com/v1'),
      credentialRevision: 'credential-revision'
    }
    const apiHarness = createHarness(api, '')
    const apiExact = providerCredentialReferenceFor(api)
    const apiBoundary = providerCredentialReference(
      api.id,
      api.kind,
      api.baseUrl
    )
    apiHarness.secrets.set(apiExact, 'unreadable-current')
    apiHarness.secrets.set(apiBoundary, 'unreadable-boundary')
    apiHarness.secrets.set(api.id, 'unreadable-legacy')
    apiHarness.vault.get.mockReturnValue(undefined)

    await apiHarness.service.delete(api.id)
    expect(apiHarness.deleteProvider).toHaveBeenCalledBefore(
      apiHarness.vault.delete
    )
    for (const reference of [apiExact, apiBoundary, api.id]) {
      expect(apiHarness.vault.delete).toHaveBeenCalledWith(reference)
      expect(apiHarness.secrets.has(reference)).toBe(false)
    }

    const cli = {
      ...cliProvider(),
      environmentRevision: 'c'.repeat(64)
    }
    const cliHarness = createHarness(cli, '')
    const cliExact = cliEnvironmentSecretReference(
      cli.id,
      cli.environmentRevision
    )
    const cliLegacy = cliEnvironmentSecretReference(cli.id)
    cliHarness.secrets.set(cliExact, 'unreadable-current')
    cliHarness.secrets.set(cliLegacy, 'unreadable-legacy')
    cliHarness.vault.get.mockReturnValue(undefined)

    await cliHarness.service.delete(cli.id)
    expect(cliHarness.deleteProvider).toHaveBeenCalledBefore(
      cliHarness.vault.delete
    )
    for (const reference of [cliExact, cliLegacy, cli.id]) {
      expect(cliHarness.vault.delete).toHaveBeenCalledWith(reference)
      expect(cliHarness.secrets.has(reference)).toBe(false)
    }
  })

  it('rolls back a CLI environment change when profile persistence fails', async () => {
    const existing = cliProvider()
    const harness = createHarness(existing, '')
    const environmentReference = cliEnvironmentSecretReference(existing.id)
    const previous = JSON.stringify({
      version: 1,
      fingerprint: existing.environmentFingerprint,
      values: { ACME_AGENT_TOKEN: 'previous-secret' }
    })
    harness.secrets.set(environmentReference, previous)
    harness.upsert.mockRejectedValueOnce(new Error('state write failed'))

    await expect(
      harness.service.save({
        id: existing.id,
        name: existing.name,
        kind: 'cli',
        model: '',
        command: process.execPath,
        args: [],
        promptMode: 'stdin',
        outputMode: 'plain',
        cliAdapter: 'generic',
        cliEnvironment: [
          { name: 'ACME_AGENT_TOKEN', value: 'replacement-secret' }
        ],
        trustConfirmed: true
      })
    ).rejects.toThrow('state write failed')

    expect(harness.secrets.get(environmentReference)).toBe(previous)
    expect(harness.current()).toEqual(existing)
  })

  it('restores a CLI environment when provider deletion fails', async () => {
    const existing = cliProvider()
    const harness = createHarness(existing, '')
    const environmentReference = cliEnvironmentSecretReference(existing.id)
    const previous = JSON.stringify({
      version: 1,
      fingerprint: existing.environmentFingerprint,
      values: { ACME_AGENT_TOKEN: 'previous-secret' }
    })
    harness.secrets.set(environmentReference, previous)
    harness.deleteProvider.mockRejectedValueOnce(new Error('state write failed'))

    await expect(harness.service.delete(existing.id)).rejects.toThrow(
      'state write failed'
    )

    expect(harness.secrets.get(environmentReference)).toBe(previous)
    expect(harness.current()).toEqual(existing)
  })

  it('rejects loader and root overrides before storing a CLI profile', async () => {
    const existing = apiProvider('https://api.example.com/v1')
    const harness = createHarness(existing)

    await expect(
      harness.service.save({
        id: existing.id,
        name: 'Unsafe CLI',
        kind: 'cli',
        model: '',
        command: process.execPath,
        args: [],
        promptMode: 'stdin',
        outputMode: 'plain',
        cliAdapter: 'generic',
        cliEnvironment: [
          { name: 'XDG_CONFIG_HOME', value: '/tmp/agent-config' }
        ],
        trustConfirmed: true
      })
    ).rejects.toThrow(/alter process loading or execution/i)

    expect(harness.upsert).not.toHaveBeenCalled()
    expect(harness.vault.set).not.toHaveBeenCalled()
  })

  it('requires main-owned CLI authorization even when the draft asserts trust', async () => {
    const provider = apiProvider('https://api.example.com/v1')
    const store = {
      getProvider: () => provider,
      upsertProvider: vi.fn(async () => undefined),
      deleteProvider: vi.fn(async () => undefined)
    }
    const vault = {
      get: vi.fn(),
      has: vi.fn(() => false),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    }
    const cliTrust = new CliTrustRegistry(async () => false)
    const service = new ProviderService(
      store as unknown as StateStore,
      vault as unknown as SecretVault,
      cliTrust
    )

    await expect(
      service.save({
        id: 'provider-one',
        name: 'Untrusted CLI',
        kind: 'cli',
        model: '',
        command: process.execPath,
        args: [],
        promptMode: 'stdin',
        outputMode: 'plain',
        trustConfirmed: true
      })
    ).rejects.toThrow(/not authorized/i)
    expect(store.upsertProvider).not.toHaveBeenCalled()
    expect(vault.delete).not.toHaveBeenCalled()
  })
})

describe('persisted provider readiness', () => {
  it('invalidates a prior connection check on every save', async () => {
    const existing: ModelApiProvider = {
      ...apiProvider('https://api.example.com/v1'),
      verification: {
        status: 'passed',
        scope: 'connection',
        checkedAt: '2026-07-29T12:00:00.000Z'
      }
    }
    const harness = createHarness(existing)

    const saved = await harness.service.save({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      supportsTools: existing.supportsTools
    })

    expect(saved.verification).toEqual({ status: 'unverified' })
  })

  it('retains a successful API connection check only for the exact saved revision', async () => {
    const endpoint = await listeningServer(() => undefined)
    const existing: ModelApiProvider = {
      ...apiProvider(endpoint),
      verification: { status: 'unverified' }
    }
    const harness = createHarness(existing)

    const result = await harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: `${existing.baseUrl}/`,
      model: existing.model,
      supportsTools: existing.supportsTools
    })

    expect(result).toMatchObject({
      ok: true,
      persisted: true
    })
    expect(harness.current().verification).toMatchObject({
      status: 'passed',
      scope: 'connection',
      checkedAt: expect.stringMatching(/^2026-|^2027-/u)
    })
    expect(harness.current().updatedAt).toBe(existing.updatedAt)
  })

  it('does not attach verification across a same-timestamp credential revision change', async () => {
    let releaseResponse: (() => void) | undefined
    let markRequested: (() => void) | undefined
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve
    })
    const server = createServer((_request, response) => {
      markRequested?.()
      releaseResponse = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"data":[{"id":"model-one"}]}')
      }
    })
    const endpoint = await providerEndpointFor(server)
    const existing: ModelApiProvider = {
      ...apiProvider(endpoint),
      credentialRevision: 'credential_original',
      verification: { status: 'unverified' }
    }
    const harness = createHarness(existing, 'exact-secret')
    const testing = harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      supportsTools: existing.supportsTools
    })

    await requested
    await (
      harness.upsert as unknown as (
        provider: ProviderProfile
      ) => Promise<void>
    )({
      ...existing,
      credentialRevision: 'credential_replacement',
      updatedAt: existing.updatedAt
    })
    releaseResponse?.()

    await expect(testing).resolves.toMatchObject({
      ok: true,
      persisted: false
    })
    expect(harness.current()).toMatchObject({
      credentialRevision: 'credential_replacement',
      verification: { status: 'unverified' },
      updatedAt: existing.updatedAt
    })
  })

  it('does not publish verification while the provider is starting or active', async () => {
    const endpoint = await listeningServer(() => undefined)
    const existing: ModelApiProvider = {
      ...apiProvider(endpoint),
      verification: { status: 'unverified' }
    }
    const providerOperations = new ProviderOperationGate()
    let active = true
    const harness = createHarness(
      existing,
      'top-secret',
      'scoped',
      () => active,
      providerOperations
    )
    const draft = {
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      supportsTools: existing.supportsTools
    } as const

    const activeResult = await harness.service.test(draft)
    active = false
    const start = providerOperations.reserveStart(
      providerStartBinding(existing)
    )
    const startingResult = await harness.service.test(draft)
    providerOperations.releaseStart(start)

    expect(activeResult).toMatchObject({ ok: true, persisted: false })
    expect(startingResult).toMatchObject({
      ok: true,
      persisted: false
    })
    expect(harness.upsert).not.toHaveBeenCalled()
    expect(harness.current()).toEqual(existing)
  })

  it('retains a failed connection check for an exact saved revision', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { 'Content-Type': 'text/plain' })
      response.end('temporarily unavailable')
    })
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    )
    const address = server.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${address.port}/v1`
    const existing: ModelApiProvider = {
      ...apiProvider(endpoint),
      verification: { status: 'unverified' }
    }
    const harness = createHarness(existing)

    const result = await harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      supportsTools: existing.supportsTools
    })

    expect(result).toMatchObject({
      ok: false,
      persisted: true
    })
    expect(harness.current().verification).toMatchObject({
      status: 'failed',
      scope: 'connection'
    })
  })

  it('does not retain checks for unsaved, modified, or credential-bearing drafts', async () => {
    const endpoint = await listeningServer(() => undefined)
    const existing: ModelApiProvider = {
      ...apiProvider(endpoint),
      verification: { status: 'unverified' }
    }
    const harness = createHarness(existing)

    const unsaved = await harness.service.test({
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model
    })
    const modified = await harness.service.test({
      id: existing.id,
      name: 'Modified draft name',
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      supportsTools: existing.supportsTools
    })
    const credentialBearing = await harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      apiKey: 'draft-secret',
      supportsTools: existing.supportsTools
    })

    expect([unsaved, modified, credentialBearing]).toEqual([
      expect.objectContaining({ ok: true, persisted: false }),
      expect.objectContaining({ ok: true, persisted: false }),
      expect.objectContaining({ ok: true, persisted: false })
    ])
    expect(harness.upsert).not.toHaveBeenCalled()
    expect(harness.current()).toEqual(existing)
  })

  it('records CLI tests as configuration checks without claiming a live connection', async () => {
    const existing: CliProvider = {
      ...cliProvider(),
      verification: { status: 'unverified' }
    }
    const harness = createHarness(existing, '')

    const result = await harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: 'cli',
      model: existing.model,
      command: existing.command,
      args: existing.args,
      promptMode: existing.promptMode,
      outputMode: existing.outputMode,
      cliAdapter: existing.cliAdapter,
      cliEnvironment: [{ name: 'ACME_AGENT_TOKEN' }],
      trustConfirmed: existing.trustConfirmed
    })

    expect(result).toMatchObject({
      ok: true,
      title: 'Configuration check passed',
      persisted: true
    })
    expect(`${result.title}\n${result.detail}`).not.toMatch(
      /connection successful|ready for runs/iu
    )
    expect(harness.current().verification).toMatchObject({
      status: 'passed',
      scope: 'configuration'
    })
  })

  it('retains a failed executable check for an exact saved CLI revision', async () => {
    const existing: CliProvider = {
      id: 'provider-one',
      name: 'Missing CLI',
      kind: 'cli',
      model: '',
      command: '/ground-test/missing-agent',
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      trustConfirmed: true,
      verification: { status: 'unverified' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    const harness = createHarness(existing, '')

    const result = await harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: 'cli',
      model: '',
      command: existing.command,
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      trustConfirmed: true
    })

    expect(result).toMatchObject({
      ok: false,
      title: 'Configuration check failed',
      persisted: true
    })
    expect(harness.current().verification).toMatchObject({
      status: 'failed',
      scope: 'configuration'
    })
  })

  it('requires an exact passed check before a provider can start a run', () => {
    const checked: ModelApiProvider = {
      ...apiProvider('https://api.example.com/v1'),
      verification: {
        status: 'passed',
        scope: 'connection',
        checkedAt: '2026-07-29T12:00:00.000Z'
      }
    }

    expect(() => assertProviderCanStartRun(checked)).not.toThrow()
    expect(() =>
      assertProviderCanStartRun({
        ...checked,
        verification: { status: 'unverified' }
      })
    ).toThrow(/Test Provider one in Settings before its first run/i)
    expect(() =>
      assertProviderCanStartRun({
        ...checked,
        verification: {
          status: 'failed',
          scope: 'connection',
          checkedAt: '2026-07-29T12:30:00.000Z'
        }
      })
    ).toThrow(/Test Provider one in Settings/i)
  })
})

describe('provider model discovery', () => {
  it.each<{
    kind: ModelProviderKind
    response: string
    expectedModels: string[]
    expectedHeader: keyof Omit<RequestSnapshot, 'url'>
    expectedHeaderValue: string
  }>([
    {
      kind: 'openai',
      response: '{"data":[{"id":"gpt-test"}]}',
      expectedModels: ['gpt-test'],
      expectedHeader: 'authorization',
      expectedHeaderValue: 'Bearer draft-secret'
    },
    {
      kind: 'openai-compatible',
      response: '{"data":[{"id":"local-test"}]}',
      expectedModels: ['local-test'],
      expectedHeader: 'authorization',
      expectedHeaderValue: 'Bearer draft-secret'
    },
    {
      kind: 'anthropic',
      response: '{"data":[{"id":"claude-test"}]}',
      expectedModels: ['claude-test'],
      expectedHeader: 'anthropicApiKey',
      expectedHeaderValue: 'draft-secret'
    },
    {
      kind: 'google',
      response: '{"models":[{"name":"models/gemini-test"}]}',
      expectedModels: ['gemini-test'],
      expectedHeader: 'googleApiKey',
      expectedHeaderValue: 'draft-secret'
    }
  ])(
    'uses the $kind discovery endpoint and authentication headers',
    async ({ kind, response, expectedModels, expectedHeader, expectedHeaderValue }) => {
      let observed: RequestSnapshot | undefined
      const endpoint = await listeningServer((request) => {
        observed = request
      }, response)
      const harness = createHarness(apiProvider(endpoint))

      const result = await harness.service.test({
        name: `${kind} provider`,
        kind,
        baseUrl: endpoint,
        model: expectedModels[0],
        apiKey: 'draft-secret'
      })

      expect(result).toMatchObject({ ok: true, models: expectedModels })
      expect(observed?.url).toBe('/v1/models')
      expect(observed?.[expectedHeader]).toBe(expectedHeaderValue)
      if (kind === 'anthropic') {
        expect(observed?.anthropicVersion).toBe('2023-06-01')
        expect(observed?.authorization).toBeUndefined()
      }
      if (kind === 'google') expect(observed?.authorization).toBeUndefined()
    }
  )

  it('allows an OpenAI-compatible endpoint without an API key', async () => {
    let authorization: string | undefined
    const endpoint = await listeningServer((request) => {
      authorization = request.authorization
    })
    const harness = createHarness(apiProvider(endpoint), '')

    const result = await harness.service.test({
      name: 'Local endpoint',
      kind: 'openai-compatible',
      baseUrl: endpoint,
      model: 'model-one'
    })

    expect(result.ok).toBe(true)
    expect(authorization).toBeUndefined()
  })

  it('falls back to an exact minimal generation probe and persists readiness when model listing is absent', async () => {
    const requests: Array<{
      method: string
      url: string
      authorization?: string
      contentType?: string
      body?: Record<string, unknown>
    }> = []
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization
        })
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end('{"error":{"message":"listing unavailable"}}')
        return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: JSON.parse(body) as Record<string, unknown>
        })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          '{"id":"chatcmpl-test","choices":[{"message":{"role":"assistant","content":"OK"}}]}'
        )
      })
    })
    const endpoint = await providerEndpointFor(server)
    const existing: ModelApiProvider = {
      ...apiProvider(endpoint),
      verification: { status: 'unverified' }
    }
    const harness = createHarness(existing, 'exact-secret')

    const result = await harness.service.test({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      supportsTools: existing.supportsTools
    })

    expect(result).toMatchObject({
      ok: true,
      persisted: true,
      models: [],
      detail: expect.stringMatching(
        /model listing was unavailable.*generation request succeeded/iu
      )
    })
    expect(harness.current().verification).toMatchObject({
      status: 'passed',
      scope: 'connection'
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: '/v1/models',
      authorization: 'Bearer exact-secret'
    })
    expect(requests[1]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: 'Bearer exact-secret',
      contentType: 'application/json'
    })
    expect(requests[1]?.body).toEqual({
      model: 'model-one',
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 4,
      stream: false
    })
    expect(requests[1]?.body).not.toHaveProperty('tools')
    expect(requests[1]?.body).not.toHaveProperty('tool_choice')
  })

  it('uses generation when a compatible model listing has an invalid shape', async () => {
    const observedPaths: string[] = []
    const server = createServer((request, response) => {
      observedPaths.push(request.url ?? '')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        request.method === 'GET'
          ? '{"models":[]}'
          : '{"choices":[{"message":{"content":"OK"}}]}'
      )
    })
    const endpoint = await providerEndpointFor(server)
    const harness = createHarness(apiProvider(endpoint), '')

    const result = await harness.service.test({
      name: 'Shape-checking endpoint',
      kind: 'openai-compatible',
      baseUrl: endpoint,
      model: 'model-one'
    })

    expect(result.ok).toBe(true)
    expect(observedPaths).toEqual(['/v1/models', '/v1/chat/completions'])
  })

  it('reports both compatible probes failing without exposing the credential', async () => {
    const secret = 'credential-never-show'
    const server = createServer((request, response) => {
      response.writeHead(request.method === 'GET' ? 404 : 503, {
        'Content-Type': 'text/plain'
      })
      response.end(
        `${request.method === 'GET' ? 'listing' : 'generation'} rejected ${secret}`
      )
    })
    const endpoint = await providerEndpointFor(server)
    const harness = createHarness(apiProvider(endpoint))

    const result = await harness.service.test({
      name: 'Redacting fallback',
      kind: 'openai-compatible',
      baseUrl: endpoint,
      model: 'model-one',
      apiKey: secret
    })

    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringMatching(
        /model listing failed:.*generation probe failed:/iu
      )
    })
    expect(result.detail).toContain('[redacted]')
    expect(result.detail).not.toContain(secret)
  })

  it('refuses redirects for model listing and generation probes', async () => {
    let redirectedRequests = 0
    const redirectTarget = createServer((_request, response) => {
      redirectedRequests += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"choices":[{"message":{"content":"OK"}}]}')
    })
    const targetEndpoint = await providerEndpointFor(redirectTarget)
    const redirectServer = createServer((_request, response) => {
      response.writeHead(307, {
        Location: `${targetEndpoint}/chat/completions`
      })
      response.end()
    })
    const endpoint = await providerEndpointFor(redirectServer)
    const harness = createHarness(apiProvider(endpoint), '')

    const result = await harness.service.test({
      name: 'Redirecting endpoint',
      kind: 'openai-compatible',
      baseUrl: endpoint,
      model: 'model-one'
    })

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(
      /model listing failed:.*generation probe failed:/iu
    )
    expect(redirectedRequests).toBe(0)
  })

  it('rejects an oversized compatible generation response', async () => {
    const server = createServer((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': '300000'
      })
      response.end('{}')
    })
    const endpoint = await providerEndpointFor(server)
    const harness = createHarness(apiProvider(endpoint), '')

    const result = await harness.service.test({
      name: 'Oversized generation',
      kind: 'openai-compatible',
      baseUrl: endpoint,
      model: 'model-one'
    })

    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/generation probe failed:.*size limit/iu)
    })
  })

  it('requires a valid non-streaming chat-completion response shape', async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.method === 'GET' ? 404 : 200, {
        'Content-Type': 'application/json'
      })
      response.end(request.method === 'GET' ? '{}' : '{"choices":[{}]}')
    })
    const endpoint = await providerEndpointFor(server)
    const harness = createHarness(apiProvider(endpoint), '')

    const result = await harness.service.test({
      name: 'Malformed generation',
      kind: 'openai-compatible',
      baseUrl: endpoint,
      model: 'model-one'
    })

    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringMatching(
        /generation probe failed:.*invalid assistant message/iu
      )
    })
  })

  it('keeps fallback verification unpersisted for unsaved and modified drafts', async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.method === 'GET' ? 404 : 200, {
        'Content-Type': 'application/json'
      })
      response.end(
        request.method === 'GET'
          ? '{}'
          : '{"choices":[{"message":{"content":"OK"}}]}'
      )
    })
    const endpoint = await providerEndpointFor(server)
    const existing: ModelApiProvider = {
      ...apiProvider(endpoint),
      hasApiKey: false,
      verification: { status: 'unverified' }
    }
    const harness = createHarness(existing, '')

    const unsaved = await harness.service.test({
      name: existing.name,
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      supportsTools: existing.supportsTools
    })
    const modified = await harness.service.test({
      id: existing.id,
      name: 'Modified fallback draft',
      kind: existing.kind,
      baseUrl: existing.baseUrl,
      model: existing.model,
      supportsTools: existing.supportsTools
    })

    expect([unsaved, modified]).toEqual([
      expect.objectContaining({ ok: true, persisted: false }),
      expect.objectContaining({ ok: true, persisted: false })
    ])
    expect(harness.upsert).not.toHaveBeenCalled()
    expect(harness.current()).toEqual(existing)
  })

  it('does not generation-probe first-class providers after discovery fails', async () => {
    const methods: string[] = []
    const server = createServer((request, response) => {
      methods.push(request.method ?? '')
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{}')
    })
    const endpoint = await providerEndpointFor(server)
    const harness = createHarness(apiProvider(endpoint, 'openai'))

    const result = await harness.service.test({
      name: 'First-class OpenAI',
      kind: 'openai',
      baseUrl: endpoint,
      model: 'model-one',
      apiKey: 'draft-secret'
    })

    expect(result.ok).toBe(false)
    expect(methods).toEqual(['GET'])
  })

  it('redacts the submitted API key from an endpoint error response', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'text/plain' })
      response.end('The rejected credential was draft-secret')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${address.port}/v1`
    const harness = createHarness(apiProvider(endpoint))

    const result = await harness.service.test({
      name: 'Redacting provider',
      kind: 'openai-compatible',
      baseUrl: endpoint,
      model: 'model-one',
      apiKey: 'draft-secret'
    })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('[redacted]')
    expect(result.detail).not.toContain('draft-secret')
  })

  it('rejects a model-discovery response whose declared body is too large', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': '3000000'
      })
      response.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${address.port}/v1`
    const harness = createHarness(apiProvider(endpoint))

    const result = await harness.service.test({
      name: 'Oversized provider',
      kind: 'openai-compatible',
      baseUrl: endpoint,
      model: 'model-one'
    })

    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/size limit/i)
    })
  })
})
