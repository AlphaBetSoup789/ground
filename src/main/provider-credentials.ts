import { createHash } from 'node:crypto'
import type { ModelApiProvider, ModelProviderKind } from '../shared/types'
import { canonicalProviderEndpoint } from './trust-boundary'

export interface ProviderCredentialVault {
  get(reference: string): string | undefined
  has(reference: string): boolean
  set(reference: string, value: string): Promise<void>
  delete(reference: string): Promise<void>
}

const CREDENTIAL_REFERENCE_PREFIX = 'provider-credential:v1:'

export function providerCredentialReference(
  providerId: string,
  kind: ModelProviderKind,
  baseUrl: string
): string {
  const digest = createHash('sha256')
    .update('ground-provider-credential-boundary\0', 'utf8')
    .update(
      JSON.stringify([
        providerId,
        kind,
        canonicalProviderEndpoint(baseUrl)
      ]),
      'utf8'
    )
    .digest('hex')
  return `${CREDENTIAL_REFERENCE_PREFIX}${digest}`
}

export function providerCredentialReferenceFor(
  provider: ModelApiProvider
): string {
  return providerCredentialReference(
    provider.id,
    provider.kind,
    provider.baseUrl
  )
}

/**
 * Resolve only the credential reference belonging to this immutable provider
 * snapshot. Legacy provider-id entries are accepted only for profiles that
 * explicitly say they have a key, then migrated without making resolution
 * depend on the migration succeeding.
 */
export async function resolveProviderCredential(
  vault: ProviderCredentialVault,
  provider: ModelApiProvider,
  reference: string
): Promise<string | undefined> {
  if (!provider.hasApiKey) return undefined

  const expectedReference = providerCredentialReferenceFor(provider)
  if (reference !== expectedReference) return undefined

  const scoped = vault.get(expectedReference)
  if (scoped) return scoped

  const legacy = vault.get(provider.id)
  if (!legacy) return undefined

  try {
    await vault.set(expectedReference, legacy)
    await vault.delete(provider.id).catch(() => undefined)
  } catch {
    // A legacy key remains usable even if best-effort migration is unavailable.
  }
  return legacy
}
