import { describe, expect, it } from 'vitest'
import type { ProviderFailureKind } from './types'
import { providerFailureGuidance } from './provider-failure-guidance'

const EXPECTED_GUIDANCE = {
  'connection-refused': {
    title: 'Connection refused',
    correctiveGuidance:
      'Confirm the provider or local API server is running and that its Base URL and port are correct, then test again.'
  },
  dns: {
    title: 'Provider host was not found',
    correctiveGuidance:
      'Check the hostname in the Base URL and your DNS or network connection, then test again.'
  },
  tls: {
    title: 'Secure connection failed',
    correctiveGuidance:
      'Check the Base URL, system clock, proxy, and certificate configuration. Do not disable certificate verification.'
  },
  authentication: {
    title: 'Provider rejected the credential',
    correctiveGuidance:
      'Check that the saved API key or CLI sign-in is current and authorized for this provider and model, then test again.'
  },
  'rate-limit': {
    title: 'Provider rate limit reached',
    correctiveGuidance:
      "Wait for the provider's retry window or review the account's quota and billing status, then test again."
  },
  timeout: {
    title: 'Provider did not respond in time',
    correctiveGuidance:
      'Check provider availability and network or proxy connectivity, then test again. For a local server, confirm the model is loaded.'
  },
  'protocol-shape': {
    title: 'Provider returned an incompatible response',
    correctiveGuidance:
      'Confirm the Base URL targets the expected API version and that the selected provider type matches the endpoint.'
  },
  'executable-not-found': {
    title: 'CLI executable was not found',
    correctiveGuidance:
      'Choose the installed executable again or restore it at the saved path, then test the profile.'
  },
  'external-runtime-startup': {
    title: 'CLI runtime could not start',
    correctiveGuidance:
      'Run the CLI directly to complete setup or sign-in, and check its permissions, arguments, and environment before testing again.'
  }
} as const satisfies Record<
  ProviderFailureKind,
  {
    readonly title: string
    readonly correctiveGuidance: string
  }
>

describe('provider failure guidance', () => {
  it.each(Object.entries(EXPECTED_GUIDANCE))(
    'provides stable, corrective copy for %s',
    (kind, expected) => {
      expect(providerFailureGuidance(kind)).toEqual(expected)
    }
  )

  it.each([undefined, null, '', 'future-failure-kind', 'toString', 42])(
    'does not guess guidance for unknown category %j',
    (kind) => {
      expect(providerFailureGuidance(kind)).toBeUndefined()
    }
  )
})
