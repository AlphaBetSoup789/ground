import { createHash } from 'node:crypto'
import type { ProviderProfile } from '../shared/types'

/**
 * Bind runtime continuity and asynchronous verification to the exact
 * provider configuration, independently from wall-clock timestamp precision.
 * Verification metadata is deliberately excluded because publishing a check
 * does not change the configuration that was checked.
 */
export function providerConfigurationFingerprint(
  provider: ProviderProfile
): string {
  const material =
    provider.kind === 'cli'
      ? [
          provider.id,
          provider.name,
          provider.kind,
          provider.model,
          provider.command,
          provider.args,
          provider.promptMode,
          provider.outputMode,
          provider.cliAdapter ?? null,
          provider.environmentVariables ?? [],
          provider.environmentFingerprint ?? null,
          provider.environmentRevision ?? null,
          provider.trustConfirmed,
          provider.createdAt,
          provider.updatedAt
        ]
      : [
          provider.id,
          provider.name,
          provider.kind,
          provider.model,
          provider.baseUrl,
          provider.hasApiKey,
          provider.credentialRevision ?? null,
          provider.supportsTools,
          provider.contextWindowTokens ?? null,
          provider.maxOutputTokens ?? null,
          provider.reasoningEffort ?? null,
          provider.createdAt,
          provider.updatedAt
        ]
  return createHash('sha256')
    .update(JSON.stringify(material), 'utf8')
    .digest('hex')
}
