import { describe, expect, it } from 'vitest'
import type {
  ProviderFailureKind,
  ProviderProfile
} from '../../../shared/types'
import { providerReadiness } from './provider-readiness'

const baseProvider: ProviderProfile = {
  id: 'provider',
  name: 'Local API',
  kind: 'openai-compatible',
  model: 'model',
  baseUrl: 'http://127.0.0.1:11434/v1',
  hasApiKey: false,
  supportsTools: true,
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z'
}

const FAILURE_PRESENTATIONS = {
  'connection-refused': {
    title: 'Connection refused',
    correctiveSnippet: 'Base URL and port'
  },
  dns: {
    title: 'Provider host was not found',
    correctiveSnippet: 'DNS or network connection'
  },
  tls: {
    title: 'Secure connection failed',
    correctiveSnippet: 'Do not disable certificate verification'
  },
  authentication: {
    title: 'Provider rejected the credential',
    correctiveSnippet: 'saved API key or CLI sign-in'
  },
  'rate-limit': {
    title: 'Provider rate limit reached',
    correctiveSnippet: 'quota and billing status'
  },
  timeout: {
    title: 'Provider did not respond in time',
    correctiveSnippet: 'provider availability'
  },
  'protocol-shape': {
    title: 'Provider returned an incompatible response',
    correctiveSnippet: 'selected provider type'
  },
  'executable-not-found': {
    title: 'CLI executable was not found',
    correctiveSnippet: 'saved path'
  },
  'external-runtime-startup': {
    title: 'CLI runtime could not start',
    correctiveSnippet: 'permissions, arguments, and environment'
  }
} as const satisfies Record<
  ProviderFailureKind,
  { readonly title: string; readonly correctiveSnippet: string }
>

describe('provider readiness presentation', () => {
  it('treats legacy and explicit unverified profiles as configured, not connected', () => {
    expect(providerReadiness(baseProvider)).toMatchObject({
      shortLabel: 'Not tested',
      title: 'Configured, not tested'
    })
    expect(
      providerReadiness({
        ...baseProvider,
        verification: { status: 'unverified' }
      }).detail
    ).toMatch(/run Test/i)
  })

  it('distinguishes API connections from CLI configuration checks', () => {
    expect(
      providerReadiness({
        ...baseProvider,
        verification: {
          status: 'passed',
          scope: 'connection',
          checkedAt: '2026-07-29T12:30:00.000Z'
        }
      }).title
    ).toBe('Connection checked')

    const cli: ProviderProfile = {
      id: 'cli',
      name: 'Agent CLI',
      kind: 'cli',
      model: '',
      command: '/usr/bin/agent',
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      trustConfirmed: true,
      verification: {
        status: 'passed',
        scope: 'configuration',
        checkedAt: '2026-07-29T12:30:00.000Z'
      },
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z'
    }
    const readiness = providerReadiness(cli)
    expect(readiness.title).toBe('Configuration checked')
    expect(readiness.detail).toMatch(/does not claim a live CLI connection/i)
  })

  it.each(Object.entries(FAILURE_PRESENTATIONS))(
    'restores corrective guidance for a saved %s failure',
    (failureKind, expected) => {
      const readiness = providerReadiness({
        ...baseProvider,
        verification: {
          status: 'failed',
          scope:
            failureKind === 'executable-not-found' ||
            failureKind === 'external-runtime-startup'
              ? 'configuration'
              : 'connection',
          checkedAt: '2026-07-29T12:30:00.000Z',
          failureKind: failureKind as ProviderFailureKind
        }
      })

      expect(readiness).toMatchObject({
        tone: 'error',
        shortLabel: 'Check failed',
        title: expected.title
      })
      expect(readiness.detail).toContain('Last checked')
      expect(readiness.detail).toContain(expected.correctiveSnippet)
    }
  )

  it('keeps legacy and unknown saved failures generic', () => {
    const legacy = providerReadiness({
      ...baseProvider,
      verification: {
        status: 'failed',
        scope: 'connection',
        checkedAt: '2026-07-29T12:30:00.000Z'
      }
    })
    expect(legacy.title).toBe('Connection check failed')
    expect(legacy.detail).toContain('Review the saved settings')

    const unknown = providerReadiness({
      ...baseProvider,
      verification: {
        status: 'failed',
        scope: 'configuration',
        checkedAt: '2026-07-29T12:30:00.000Z',
        failureKind: 'future-provider-failure'
      }
    } as unknown as ProviderProfile)
    expect(unknown.title).toBe('Configuration check failed')
    expect(unknown.detail).toContain('Review the saved settings')
  })
})
