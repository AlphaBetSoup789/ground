import { describe, expect, it } from 'vitest'
import type { ProviderProfile } from '../../../shared/types'
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
})
