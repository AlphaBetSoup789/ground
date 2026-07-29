import { describe, expect, it, vi } from 'vitest'
import type { CliProvider } from '../shared/types'
import {
  assertSafeCliEnvironmentVariableName,
  cliEnvironmentSecretReference,
  normalizeCliEnvironmentVariableNames,
  prepareCliEnvironmentPlan,
  resolveCliEnvironment,
  resolveCliEnvironmentWithSecretResolver
} from './cli-environment'
import type { SecretVault } from './secrets'

function provider(
  fingerprint: string,
  variables: string[] = ['ACME_AGENT_TOKEN']
): CliProvider {
  return {
    id: 'enterprise-cli',
    name: 'Enterprise CLI',
    kind: 'cli',
    model: '',
    command: process.execPath,
    args: [],
    promptMode: 'stdin',
    outputMode: 'plain',
    cliAdapter: 'generic',
    environmentVariables: variables,
    environmentFingerprint: fingerprint,
    trustConfirmed: true,
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z'
  }
}

function serializedEnvironment(
  fingerprint: string,
  values: Record<string, string>
): string {
  return JSON.stringify({ version: 1, fingerprint, values })
}

describe('CLI profile environments', () => {
  it('accepts portable provider variables and rejects process-control roots', () => {
    expect(assertSafeCliEnvironmentVariableName('ACME_AGENT_TOKEN')).toBe(
      'ACME_AGENT_TOKEN'
    )
    for (const name of [
      'PATH',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'HOME',
      'USERPROFILE',
      'XDG_CONFIG_HOME',
      'TMPDIR'
    ]) {
      expect(() => assertSafeCliEnvironmentVariableName(name)).toThrow(
        /alter process loading or execution/i
      )
    }
    expect(() =>
      normalizeCliEnvironmentVariableNames(['ACME_TOKEN', 'acme_token'])
    ).toThrow(/duplicated/i)
  })

  it('bounds raw UTF-8 input while accommodating the reachable worst JSON envelope', () => {
    const names = [
      ...Array.from({ length: 26 }, (_, index) =>
        String.fromCharCode(65 + index)
      ),
      '_'
    ]
    let remaining =
      128_000 -
      names.reduce(
        (total, name) => total + Buffer.byteLength(name, 'utf8'),
        0
      )
    const entries = names.map((name, index) => {
      const valueBytes = Math.floor(
        remaining / (names.length - index)
      )
      remaining -= valueBytes
      return { name, value: '\u0001'.repeat(valueBytes) }
    })

    const plan = prepareCliEnvironmentPlan(
      'maximum-environment',
      entries,
      undefined,
      undefined
    )
    expect(remaining).toBe(0)
    expect(
      Buffer.byteLength(plan.desiredSerializedSecret as string, 'utf8')
    ).toBe(768_132)

    const oversized = structuredClone(entries)
    oversized[0]!.value += '\u0001'
    expect(() =>
      prepareCliEnvironmentPlan(
        'oversized-environment',
        oversized,
        undefined,
        undefined
      )
    ).toThrow(/total size limit/i)
  })

  it('creates an opaque revision, retains blank edits, and never needs values in profile metadata', () => {
    const initial = prepareCliEnvironmentPlan(
      'enterprise-cli',
      [{ name: 'ACME_AGENT_TOKEN', value: 'initial-secret' }],
      undefined,
      undefined
    )
    expect(initial.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(initial.variables).toEqual(['ACME_AGENT_TOKEN'])
    expect(initial.mutation).toBe('set')

    const storedProvider = provider(initial.fingerprint as string)
    const retained = prepareCliEnvironmentPlan(
      storedProvider.id,
      [{ name: 'ACME_AGENT_TOKEN', value: '' }],
      storedProvider,
      initial.desiredSerializedSecret
    )
    expect(retained.mutation).toBe('none')
    expect(retained.fingerprint).toBe(initial.fingerprint)

    const changed = prepareCliEnvironmentPlan(
      storedProvider.id,
      [{ name: 'ACME_AGENT_TOKEN', value: 'replacement-secret' }],
      storedProvider,
      initial.desiredSerializedSecret
    )
    expect(changed.mutation).toBe('set')
    expect(changed.fingerprint).not.toBe(initial.fingerprint)
    expect(JSON.stringify(storedProvider)).not.toContain('initial-secret')
  })

  it('requires usable values and fails closed when vault metadata mismatches', () => {
    expect(() =>
      prepareCliEnvironmentPlan(
        'enterprise-cli',
        [{ name: 'ACME_TOGGLE', value: '1' }],
        undefined,
        undefined
      )
    ).toThrow(/at least 4/i)

    const fingerprint = 'a'.repeat(64)
    const storedProvider = provider(fingerprint)
    const vault = {
      get: vi.fn(() =>
        serializedEnvironment('b'.repeat(64), {
          ACME_AGENT_TOKEN: 'vault-secret'
        })
      )
    } as unknown as SecretVault
    expect(() => resolveCliEnvironment(vault, storedProvider)).toThrow(
      /no longer match/i
    )
  })

  it('can replace or clear an unreadable legacy environment without overwriting its slot', () => {
    const storedProvider = provider('a'.repeat(64))
    const replaced = prepareCliEnvironmentPlan(
      storedProvider.id,
      [{ name: 'ACME_AGENT_TOKEN', value: 'replacement-secret' }],
      storedProvider,
      undefined
    )
    expect(replaced).toMatchObject({
      mutation: 'set',
      variables: ['ACME_AGENT_TOKEN']
    })
    expect(replaced.revision).toMatch(/^[a-f0-9]{64}$/u)
    expect(replaced.secretReference).not.toBe(
      cliEnvironmentSecretReference(storedProvider.id)
    )
    expect(replaced.obsoleteSecretReferences).toContain(
      cliEnvironmentSecretReference(storedProvider.id)
    )

    const cleared = prepareCliEnvironmentPlan(
      storedProvider.id,
      [],
      storedProvider,
      undefined
    )
    expect(cleared).toMatchObject({
      mutation: 'delete',
      variables: []
    })

    expect(() =>
      prepareCliEnvironmentPlan(
        storedProvider.id,
        [{ name: 'ACME_AGENT_TOKEN', value: '' }],
        storedProvider,
        undefined
      )
    ).toThrow(/unavailable/i)
  })

  it('resolves a versioned environment only from its exact revision', () => {
    const storedProvider = {
      ...provider('c'.repeat(64)),
      environmentRevision: 'd'.repeat(64)
    }
    const exact = cliEnvironmentSecretReference(
      storedProvider.id,
      storedProvider.environmentRevision
    )
    const legacy = cliEnvironmentSecretReference(storedProvider.id)
    const vault = {
      get: vi.fn((candidate: string) =>
        candidate === exact
          ? serializedEnvironment(storedProvider.environmentFingerprint as string, {
              ACME_AGENT_TOKEN: 'versioned-secret'
            })
          : candidate === legacy
            ? serializedEnvironment(storedProvider.environmentFingerprint as string, {
                ACME_AGENT_TOKEN: 'stale-legacy-secret'
              })
            : undefined
      )
    } as unknown as SecretVault

    expect(resolveCliEnvironment(vault, storedProvider)).toEqual({
      ACME_AGENT_TOKEN: 'versioned-secret'
    })
    expect((vault.get as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(exact)
    expect((vault.get as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith(
      legacy
    )
  })

  it('resolves the exact encrypted mapping without exposing it through the provider', () => {
    const fingerprint = 'c'.repeat(64)
    const storedProvider = provider(fingerprint)
    const reference = cliEnvironmentSecretReference(storedProvider.id)
    const vault = {
      get: vi.fn((candidate: string) =>
        candidate === reference
          ? serializedEnvironment(fingerprint, {
              ACME_AGENT_TOKEN: 'vault-secret'
            })
          : undefined
      )
    } as unknown as SecretVault

    expect(resolveCliEnvironment(vault, storedProvider)).toEqual({
      ACME_AGENT_TOKEN: 'vault-secret'
    })
    expect(JSON.stringify(storedProvider)).not.toContain('vault-secret')
    expect((vault.get as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      reference
    )
  })

  it('resolves and validates the same envelope through an async secret resolver', async () => {
    const fingerprint = 'd'.repeat(64)
    const storedProvider = provider(fingerprint)
    const reference = cliEnvironmentSecretReference(storedProvider.id)
    const resolver = {
      resolve: vi.fn(async (candidate: string) => {
        expect(candidate).toBe(reference)
        return serializedEnvironment(fingerprint, {
          ACME_AGENT_TOKEN: 'resolver-secret'
        })
      })
    }

    await expect(
      resolveCliEnvironmentWithSecretResolver(resolver, storedProvider)
    ).resolves.toEqual({
      ACME_AGENT_TOKEN: 'resolver-secret'
    })
    expect(resolver.resolve).toHaveBeenCalledTimes(1)

    resolver.resolve.mockResolvedValueOnce(
      serializedEnvironment('e'.repeat(64), {
        ACME_AGENT_TOKEN: 'resolver-secret'
      })
    )
    await expect(
      resolveCliEnvironmentWithSecretResolver(resolver, storedProvider)
    ).rejects.toThrow(/no longer match/i)
  })

  it('does not consult a secret resolver for an environment-free profile', async () => {
    const storedProvider = provider('', [])
    delete storedProvider.environmentFingerprint
    const resolver = {
      resolve: vi.fn(async () => {
        throw new Error('must not resolve')
      })
    }

    await expect(
      resolveCliEnvironmentWithSecretResolver(resolver, storedProvider)
    ).resolves.toEqual({})
    expect(resolver.resolve).not.toHaveBeenCalled()
  })
})
