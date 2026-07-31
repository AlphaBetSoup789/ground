import type { ProviderProfile } from '../../../shared/types'
import { providerFailureGuidance } from '../../../shared/provider-failure-guidance'

export interface ProviderReadinessPresentation {
  tone: 'neutral' | 'success' | 'error'
  shortLabel: string
  title: string
  detail: string
}

function checkedTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? 'previously' : date.toLocaleString()
}

export function providerReadiness(
  provider: ProviderProfile
): ProviderReadinessPresentation {
  const verification = provider.verification
  if (!verification || verification.status === 'unverified') {
    return {
      tone: 'neutral',
      shortLabel: 'Not tested',
      title: 'Configured, not tested',
      detail:
        provider.kind === 'cli'
          ? 'Run Test to check this executable configuration before its first run.'
          : 'Run Test to confirm this saved endpoint and credential before its first run.'
    }
  }

  const checkedAt = checkedTime(verification.checkedAt)
  if (verification.status === 'failed') {
    const guidance = providerFailureGuidance(verification.failureKind)
    return {
      tone: 'error',
      shortLabel: 'Check failed',
      title:
        guidance?.title ??
        (verification.scope === 'connection'
          ? 'Connection check failed'
          : 'Configuration check failed'),
      detail: guidance
        ? `Last checked ${checkedAt}. ${guidance.correctiveGuidance}`
        : `Last checked ${checkedAt}. Review the saved settings and run Test again.`
    }
  }

  return verification.scope === 'connection'
    ? {
        tone: 'success',
        shortLabel: 'Connection checked',
        title: 'Connection checked',
        detail: `This saved API endpoint responded successfully ${checkedAt}. Saving any change requires another test.`
      }
    : {
        tone: 'success',
        shortLabel: 'Configuration checked',
        title: 'Configuration checked',
        detail: `This saved executable configuration was checked ${checkedAt}. This does not claim a live CLI connection.`
      }
}
