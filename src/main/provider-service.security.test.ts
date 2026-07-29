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
import { ProviderService } from './provider-service'
import { SecretVault } from './secrets'
import { StateStore } from './store'
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

function createHarness(
  provider: ProviderProfile,
  secret = 'top-secret',
  credentialLocation: 'scoped' | 'legacy' = 'scoped',
  isProviderActive: (providerId: string) => boolean = () => false
): {
  service: ProviderService
  vault: {
    get: ReturnType<typeof vi.fn>
    has: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
  upsert: ReturnType<typeof vi.fn>
  deleteProvider: ReturnType<typeof vi.fn>
  secrets: Map<string, string>
  current: () => ProviderProfile
} {
  let current = provider
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
  })
  const deleteProvider = vi.fn(async () => undefined)
  const store = {
    getProvider: (id: string) => {
      if (id !== current.id) throw new Error('Provider not found')
      return current
    },
    upsertProvider: upsert,
    deleteProvider
  }
  const vault = {
    get: vi.fn((reference: string) => secrets.get(reference)),
    has: vi.fn((reference: string) => secrets.has(reference)),
    set: vi.fn(async (reference: string, value: string) => {
      secrets.set(reference, value)
    }),
    delete: vi.fn(async (reference: string) => {
      secrets.delete(reference)
    })
  }
  const cliTrust = new CliTrustRegistry(async () => true)
  return {
    service: new ProviderService(
      store as unknown as StateStore,
      vault as unknown as SecretVault,
      cliTrust,
      isProviderActive
    ),
    vault,
    upsert,
    deleteProvider,
    secrets,
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

  it('preserves a stored key when saving the same canonical boundary', async () => {
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

    expect(harness.vault.set).not.toHaveBeenCalled()
    expect(harness.vault.delete).toHaveBeenCalledWith('provider-one')
    expect(harness.vault.delete).not.toHaveBeenCalledWith(reference)
    expect(harness.secrets.get(reference)).toBe('top-secret')
    expect(saved).toMatchObject({
      kind: 'openai',
      baseUrl: endpoint,
      hasApiKey: true
    })
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
    const newReference = providerCredentialReference(
      existing.id,
      'anthropic',
      existing.baseUrl
    )
    const harness = createHarness(existing)

    const saved = await harness.service.save({
      id: 'provider-one',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.example.com/v1',
      model: 'model-two',
      apiKey: 'replacement-secret'
    })

    expect(harness.vault.set).toHaveBeenCalledWith(
      newReference,
      'replacement-secret'
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

  it('leaves the old boundary usable when persistence fails after staging a new key', async () => {
    const existing = apiProvider('https://api.example.com/v1', 'openai')
    const oldReference = providerCredentialReferenceFor(existing)
    const newReference = providerCredentialReference(
      existing.id,
      'anthropic',
      'https://api.anthropic.com/v1'
    )
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

    expect(harness.secrets.get(oldReference)).toBe('old-endpoint-secret')
    expect(harness.secrets.get(newReference)).toBe('new-endpoint-secret')
    expect(harness.vault.delete).not.toHaveBeenCalled()
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
        newReference
      )
    ).resolves.toBeUndefined()
    expect(harness.secrets.get(oldReference)).not.toBe(
      'new-endpoint-secret'
    )
  })

  it('migrates a legacy provider-id key only on the unchanged persisted boundary', async () => {
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
    expect(harness.vault.set).toHaveBeenCalledWith(
      scopedReference,
      'legacy-secret'
    )
    expect(harness.vault.set.mock.invocationCallOrder[0]).toBeLessThan(
      harness.vault.delete.mock.invocationCallOrder[0] as number
    )
    expect(harness.secrets.get(scopedReference)).toBe('legacy-secret')
    expect(harness.secrets.has(existing.id)).toBe(false)
  })

  it('keeps the legacy key when a same-boundary migration is followed by a store failure', async () => {
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

    expect(harness.secrets.get(scopedReference)).toBe('legacy-secret')
    expect(harness.secrets.get(existing.id)).toBe('legacy-secret')
    expect(harness.vault.delete).not.toHaveBeenCalled()
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
    const environmentReference = cliEnvironmentSecretReference(existing.id)
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
    expect(JSON.stringify(saved)).not.toContain(secret)
    expect(harness.secrets.get(environmentReference)).toContain(secret)
    expect(harness.current()).toEqual(saved)
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
