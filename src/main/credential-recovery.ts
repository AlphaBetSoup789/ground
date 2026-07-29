import type {
  ProviderProfile,
  RecoveryNotice
} from '../shared/types'
import {
  cliEnvironmentSecretReference,
  resolveCliEnvironmentSecret
} from './cli-environment'
import {
  providerCredentialReferenceFor
} from './provider-credentials'
import {
  SecretVaultPersistenceError,
  type SecretVault
} from './secrets'
import {
  StatePersistenceError,
  type StateStore
} from './store'

type CredentialReader = Pick<SecretVault, 'get' | 'has'>

function reconciliationNotice(detail: string): RecoveryNotice {
  return {
    id: `credential-warning:reconciliation:${Date.now()}`,
    kind: 'credential-warning',
    title: 'Saved credentials need attention',
    detail
  }
}

export function liveCredentialReferences(
  providers: readonly ProviderProfile[]
): ReadonlySet<string> {
  const references = new Set<string>()
  for (const provider of providers) {
    if (provider.kind === 'cli') {
      if (provider.environmentVariables?.length) {
        references.add(
          cliEnvironmentSecretReference(
            provider.id,
            provider.environmentRevision
          )
        )
      }
      continue
    }
    if (!provider.hasApiKey) continue
    references.add(providerCredentialReferenceFor(provider))
    if (!provider.credentialRevision) references.add(provider.id)
  }
  return references
}

export interface PendingSecretCleanupResult {
  deferred: boolean
  retiredLiveIntents: number
  deletedReferences: number
}

/**
 * Drain only exact references that a prior state transaction journaled for
 * deletion. Never enumerate-and-sweep the complement of current provider
 * state: a recovered backup or temporarily unavailable OS keychain is not
 * proof that unreferenced ciphertext is disposable.
 */
export async function drainPendingSecretDeletes(
  store: StateStore,
  vault: SecretVault
): Promise<PendingSecretCleanupResult> {
  const pending = store.pendingSecretDeletes()
  if (!pending.length) {
    vault.assertSteadyState()
    return {
      deferred: false,
      retiredLiveIntents: 0,
      deletedReferences: 0
    }
  }
  if (store.shouldDeferPendingSecretDeletes()) {
    return {
      deferred: true,
      retiredLiveIntents: 0,
      deletedReferences: 0
    }
  }

  const live = liveCredentialReferences(store.snapshot().providers)
  const deletable = pending.filter((reference) => !live.has(reference))
  const retiredLiveIntents = pending.length - deletable.length
  await vault.deleteMany(deletable)
  await store.acknowledgeSecretDeletes(pending)
  vault.assertSteadyState()
  return {
    deferred: false,
    retiredLiveIntents,
    deletedReferences: deletable.length
  }
}

export async function reconcileCredentialVault(
  store: StateStore,
  vault: SecretVault
): Promise<RecoveryNotice | undefined> {
  try {
    const result = await drainPendingSecretDeletes(store, vault)
    if (result.deferred) {
      return reconciliationNotice(
        'Encrypted credential cleanup was deferred because Ground recovered an older state generation. No queued ciphertext was deleted; restart after reviewing the recovery notice to retry.'
      )
    }
    if (result.retiredLiveIntents > 0) {
      return reconciliationNotice(
        'Ground retired a stale credential-cleanup intent because the selected provider state still references that encrypted value. The live credential was not deleted.'
      )
    }
    return undefined
  } catch (error) {
    if (
      error instanceof SecretVaultPersistenceError ||
      error instanceof StatePersistenceError
    ) {
      // A rename may already have selected a different durable generation.
      // Startup must abort before it exposes any writable service backed by
      // stale in-memory state.
      throw error
    }
    return reconciliationNotice(
      'Ground could not finish its exact encrypted-credential cleanup journal. Live credentials were not inferred from decryption failures; restart Ground before saving more provider values.'
    )
  }
}

function credentialsExpected(provider: ProviderProfile): boolean {
  return provider.kind === 'cli'
    ? Boolean(provider.environmentVariables?.length)
    : provider.hasApiKey
}

function providerCredentialIsAvailable(
  provider: ProviderProfile,
  vault: CredentialReader
): boolean {
  if (!credentialsExpected(provider)) return true
  if (provider.kind !== 'cli') {
    return (
      vault.has(providerCredentialReferenceFor(provider)) ||
      (!provider.credentialRevision && vault.has(provider.id))
    )
  }
  try {
    resolveCliEnvironmentSecret(
      provider,
      vault.get(
        cliEnvironmentSecretReference(
          provider.id,
          provider.environmentRevision
        )
      )
    )
    return true
  } catch {
    return false
  }
}

/**
 * Reconciles persisted provider metadata with decryptable vault contents.
 * This is derived on every startup so a warning survives vault quarantine
 * without persisting secret references or stale health flags in app state.
 */
export function findCredentialRecoveryNotice(
  providers: readonly ProviderProfile[],
  vault: CredentialReader
): RecoveryNotice | undefined {
  if (providers.every((provider) => providerCredentialIsAvailable(provider, vault))) {
    return undefined
  }
  return {
    id: `credential-warning:references:${Date.now()}`,
    kind: 'credential-warning',
    title: 'Saved credentials need attention',
    detail:
      'One or more configured providers can no longer read their saved credentials. Re-enter affected API keys or CLI environment values before starting a run.'
  }
}
