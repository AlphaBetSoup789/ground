import { createHash } from 'node:crypto'
import type { ModelApiProvider, ModelProviderKind } from '../shared/types'
import { canonicalProviderEndpoint } from './trust-boundary'

export interface ProviderCredentialVault {
  get(reference: string): string | undefined
}

const LEGACY_CREDENTIAL_REFERENCE_PREFIX = 'provider-credential:v1:'
const VERSIONED_CREDENTIAL_REFERENCE_PREFIX = 'provider-credential:v2:'

export function providerCredentialReference(
  providerId: string,
  kind: ModelProviderKind,
  baseUrl: string,
  credentialRevision?: string
): string {
  const digest = createHash('sha256')
    .update(
      credentialRevision
        ? 'ground-versioned-provider-credential-boundary\0'
        : 'ground-provider-credential-boundary\0',
      'utf8'
    )
    .update(
      JSON.stringify([
        providerId,
        kind,
        canonicalProviderEndpoint(baseUrl),
        ...(credentialRevision ? [credentialRevision] : [])
      ]),
      'utf8'
    )
    .digest('hex')
  return `${
    credentialRevision
      ? VERSIONED_CREDENTIAL_REFERENCE_PREFIX
      : LEGACY_CREDENTIAL_REFERENCE_PREFIX
  }${digest}`
}

export function providerCredentialReferenceFor(
  provider: ModelApiProvider
): string {
  return providerCredentialReference(
    provider.id,
    provider.kind,
    provider.baseUrl,
    provider.credentialRevision
  )
}

/**
 * Resolve only the credential reference belonging to this immutable provider
 * snapshot. Provider-id fallback is limited to profiles from before versioned
 * credential selectors existed; a versioned profile can never fall back to a
 * different legacy secret.
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

  if (provider.credentialRevision) return undefined
  const legacy = vault.get(provider.id)
  return legacy || undefined
}
