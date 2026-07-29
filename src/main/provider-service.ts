import type {
  CliProvider,
  DetectedCli,
  ModelApiProvider,
  ModelProviderKind,
  ProviderDraft,
  ProviderProfile,
  ProviderTestResult
} from '../shared/types'
import {
  cliEnvironmentSecretReference,
  prepareCliEnvironmentPlan,
  type CliEnvironmentPlan
} from './cli-environment'
import { createId, nowIso } from './lib/ids'
import {
  providerCredentialReference,
  providerCredentialReferenceFor,
  resolveProviderCredential
} from './provider-credentials'
import { ProviderOperationGate } from './provider-operation-gate'
import { modelsEndpoint } from './providers/openai'
import { expandCliArgs, resolveExecutable } from './providers/cli'
import { SecretVault } from './secrets'
import { StateStore } from './store'
import { canonicalProviderEndpoint, CliTrustRegistry } from './trust-boundary'
import { parseProviderDraft } from './validation'

const MAX_MODEL_DISCOVERY_BYTES = 2_000_000
const MAX_PROVIDER_ERROR_BYTES = 2_000

function isModelApiProvider(
  provider: ProviderProfile | undefined
): provider is ModelApiProvider {
  return Boolean(provider && provider.kind !== 'cli')
}

function requiresApiKey(kind: ModelProviderKind): boolean {
  return kind !== 'openai-compatible'
}

function isSameCredentialBoundary(
  provider: ProviderProfile | undefined,
  kind: ModelProviderKind,
  endpoint: string
): provider is ModelApiProvider {
  return Boolean(
    isModelApiProvider(provider) &&
      provider.kind === kind &&
      canonicalProviderEndpoint(provider.baseUrl) === endpoint
  )
}

function createModelApiProvider(
  kind: ModelProviderKind,
  fields: Omit<ModelApiProvider, 'kind'>
): ModelApiProvider {
  switch (kind) {
    case 'openai':
      return { ...fields, kind: 'openai' }
    case 'anthropic':
      return { ...fields, kind: 'anthropic' }
    case 'google':
      return { ...fields, kind: 'google' }
    case 'openai-compatible':
      return { ...fields, kind: 'openai-compatible' }
  }
}

function modelDiscoveryEndpoint(kind: ModelProviderKind, baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/models')) return normalized
  if (kind === 'openai' || kind === 'openai-compatible') {
    return modelsEndpoint(normalized)
  }
  if (kind === 'anthropic' && normalized.endsWith('/messages')) {
    return `${normalized.slice(0, -'/messages'.length)}/models`
  }
  return `${normalized}/models`
}

function discoveryHeaders(
  kind: ModelProviderKind,
  apiKey: string | undefined
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (!apiKey) return headers
  switch (kind) {
    case 'openai':
    case 'openai-compatible':
      headers.Authorization = `Bearer ${apiKey}`
      break
    case 'anthropic':
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      break
    case 'google':
      headers['x-goog-api-key'] = apiKey
      break
  }
  return headers
}

function discoveredModels(kind: ModelProviderKind, payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  const entries = kind === 'google' ? root.models : root.data
  if (!Array.isArray(entries)) return []
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return undefined
      const value =
        kind === 'google'
          ? (entry as Record<string, unknown>).name
          : (entry as Record<string, unknown>).id
      if (typeof value !== 'string') return undefined
      return kind === 'google' ? value.replace(/^models\//, '') : value
    })
    .filter((model): model is string => Boolean(model))
    .slice(0, 100)
}

async function readResponseText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error('Provider response exceeds its size limit')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        throw new Error('Provider response exceeds its size limit')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function redactKnownSecret(value: string, secret: string | undefined): string {
  return secret && secret.length >= 4
    ? value.replaceAll(secret, '[redacted]')
    : value
}

export class ProviderService {
  constructor(
    private readonly store: StateStore,
    private readonly vault: SecretVault,
    private readonly cliTrust: CliTrustRegistry,
    private readonly isProviderActive: (providerId: string) => boolean = () =>
      false,
    private readonly providerOperations?: ProviderOperationGate
  ) {}

  async save(rawDraft: unknown): Promise<ProviderProfile> {
    const draft = parseProviderDraft(rawDraft)
    const timestamp = nowIso()
    const id = draft.id || createId('provider')
    const releaseMutation = this.providerOperations
      ? this.providerOperations.reserveMutation(id, () =>
          this.isProviderActive(id)
        )
      : (() => {
          if (this.isProviderActive(id)) {
            throw new Error('Stop active runs before changing this provider')
          }
          return () => undefined
        })()
    try {
    let existing: ProviderProfile | undefined
    try {
      existing = this.store.getProvider(id)
    } catch {
      existing = undefined
    }
    const newApiKey = draft.apiKey?.trim()
    if (newApiKey && newApiKey.length < 4) {
      throw new Error('API keys must contain at least 4 characters')
    }

    let provider: ProviderProfile
    if (draft.kind !== 'cli') {
      const endpoint = canonicalProviderEndpoint(draft.baseUrl as string)
      const credentialReference = providerCredentialReference(
        id,
        draft.kind,
        endpoint
      )
      const credentialBoundaryChanged = Boolean(
        existing && !isSameCredentialBoundary(existing, draft.kind, endpoint)
      )
      const sameBoundaryProvider = isSameCredentialBoundary(
        existing,
        draft.kind,
        endpoint
      )
        ? existing
        : undefined
      let hasScopedCredential = false
      let hasLegacyCredential = false
      if (sameBoundaryProvider?.hasApiKey) {
        hasScopedCredential = this.vault.has(credentialReference)
        hasLegacyCredential = this.vault.has(id)
      }
      const canReuseApiKey =
        !credentialBoundaryChanged &&
        Boolean(
          sameBoundaryProvider?.hasApiKey &&
            (hasScopedCredential || hasLegacyCredential)
        )

      if (requiresApiKey(draft.kind) && !newApiKey && !canReuseApiKey) {
        throw new Error(`${draft.name.trim()} requires an API key`)
      }

      let migratedLegacyCredential = false
      if (newApiKey) {
        await this.vault.set(credentialReference, newApiKey)
      } else if (
        canReuseApiKey &&
        !hasScopedCredential &&
        hasLegacyCredential
      ) {
        const legacy = this.vault.get(id)
        if (legacy) {
          try {
            await this.vault.set(credentialReference, legacy)
            migratedLegacyCredential = true
          } catch {
            // Keep the legacy entry as the source of truth if migration is unavailable.
          }
        }
      }

      const hasApiKey = Boolean(newApiKey || canReuseApiKey)

      provider = createModelApiProvider(draft.kind, {
        id,
        name: draft.name.trim(),
        baseUrl: endpoint,
        model: draft.model.trim(),
        supportsTools: draft.supportsTools ?? true,
        ...(draft.contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: draft.contextWindowTokens }),
        ...(draft.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: draft.maxOutputTokens }),
        ...(draft.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: draft.reasoningEffort }),
        hasApiKey,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      })
      await this.store.upsertProvider(provider)

      const obsoleteReferences: string[] = []
      if (isModelApiProvider(existing)) {
        const previousReference = providerCredentialReferenceFor(existing)
        if (previousReference !== credentialReference) {
          obsoleteReferences.push(previousReference)
        }
      } else if (existing?.kind === 'cli') {
        obsoleteReferences.push(cliEnvironmentSecretReference(existing.id))
      }
      if (!hasApiKey) obsoleteReferences.push(credentialReference)
      if (
        !hasApiKey ||
        credentialBoundaryChanged ||
        Boolean(newApiKey) ||
        hasScopedCredential ||
        migratedLegacyCredential
      ) {
        obsoleteReferences.push(id)
      }
      await this.deleteCredentialsBestEffort(obsoleteReferences)
    } else {
      const cliAdapter =
        draft.cliAdapter ?? (existing?.kind === 'cli' ? existing.cliAdapter : undefined) ?? 'generic'
      const environmentReference = cliEnvironmentSecretReference(id)
      const previousEnvironmentSecret = this.vault.get(environmentReference)
      const environmentPlan = prepareCliEnvironmentPlan(
        id,
        draft.cliEnvironment,
        existing?.kind === 'cli' ? existing : undefined,
        previousEnvironmentSecret
      )
      const executable = await this.cliTrust.authorize({
        ...draft,
        cliAdapter,
        environmentVariables: environmentPlan.variables,
        environmentFingerprint: environmentPlan.fingerprint
      })
      provider = {
        id,
        kind: 'cli',
        name: draft.name.trim(),
        model: draft.model.trim(),
        command: executable,
        args: draft.args ?? [],
        promptMode: draft.promptMode ?? 'stdin',
        outputMode: draft.outputMode ?? 'plain',
        cliAdapter,
        ...(environmentPlan.variables.length
          ? {
              environmentVariables: [...environmentPlan.variables],
              environmentFingerprint: environmentPlan.fingerprint
            }
          : {}),
        trustConfirmed: true,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      await this.persistCliEnvironmentAndProvider(environmentPlan, provider)
      if (isModelApiProvider(existing)) {
        await this.deleteCredentialsBestEffort([
          providerCredentialReferenceFor(existing),
          id
        ])
      } else {
        await this.deleteCredentialsBestEffort([id])
      }
    }
      return provider
    } finally {
      releaseMutation()
    }
  }

  async delete(providerId: string): Promise<void> {
    const releaseMutation = this.providerOperations
      ? this.providerOperations.reserveMutation(providerId, () =>
          this.isProviderActive(providerId)
        )
      : (() => {
          if (this.isProviderActive(providerId)) {
            throw new Error('Stop active runs before deleting this provider')
          }
          return () => undefined
        })()
    try {
      const provider = this.store.getProvider(providerId)
      if (provider.kind === 'cli') {
        await this.deleteCliProviderTransactionally(provider)
      } else {
        await this.store.deleteProvider(providerId)
      }
      await this.deleteCredentialsBestEffort([
        ...(isModelApiProvider(provider)
          ? [providerCredentialReferenceFor(provider)]
          : []),
        providerId
      ])
    } finally {
      releaseMutation()
    }
  }

  async test(rawDraft: unknown): Promise<ProviderTestResult> {
    let draft: ProviderDraft
    try {
      draft = parseProviderDraft(rawDraft)
    } catch (error) {
      return {
        ok: false,
        title: 'Configuration needs attention',
        detail: readableError(error)
      }
    }
    if (draft.kind === 'cli') return this.testCli(draft)
    return this.testModelApi(draft)
  }

  async detectClis(): Promise<DetectedCli[]> {
    const candidates: Array<{
      id: DetectedCli['id']
      name: string
      command: string
      description: string
      draft: ProviderDraft
    }> = [
      {
        id: 'codex',
        name: 'Codex CLI',
        command: 'codex',
        description: 'Workspace agent with JSONL events and native sandboxing.',
        draft: {
          name: 'Codex CLI',
          kind: 'cli',
          model: '',
          command: 'codex',
          args: [
            'exec',
            '--json',
            '--color',
            'never',
            '--skip-git-repo-check',
            '--sandbox',
            'workspace-write',
            '-'
          ],
          promptMode: 'stdin',
          outputMode: 'ndjson',
          cliAdapter: 'codex',
          trustConfirmed: false
        }
      },
      {
        id: 'claude',
        name: 'Claude Code',
        command: 'claude',
        description: 'Claude’s coding agent in streamed, non-interactive mode.',
        draft: {
          name: 'Claude Code',
          kind: 'cli',
          model: '',
          command: 'claude',
          args: [
            '-p',
            '--verbose',
            '--output-format',
            'stream-json',
            '--include-partial-messages'
          ],
          promptMode: 'stdin',
          outputMode: 'ndjson',
          cliAdapter: 'claude',
          trustConfirmed: false
        }
      },
      {
        id: 'gemini',
        name: 'Gemini CLI',
        command: 'gemini',
        description: 'Gemini’s headless coding agent with streamed JSON output.',
        draft: {
          name: 'Gemini CLI',
          kind: 'cli',
          model: '',
          command: 'gemini',
          args: [
            '-p',
            '{prompt}',
            '--output-format',
            'stream-json'
          ],
          promptMode: 'argument',
          outputMode: 'ndjson',
          cliAdapter: 'gemini',
          trustConfirmed: false
        }
      }
    ]
    const detected: DetectedCli[] = []
    for (const candidate of candidates) {
      const executable = await resolveExecutable(candidate.command)
      if (!executable) continue
      detected.push({
        id: candidate.id,
        name: candidate.name,
        path: executable,
        description: candidate.description,
        draft: {
          ...candidate.draft,
          command: executable
        }
      })
    }
    return detected
  }

  private async testCli(draft: ProviderDraft): Promise<ProviderTestResult> {
    const executable = await resolveExecutable(draft.command as string)
    if (!executable) {
      return {
        ok: false,
        title: 'Executable not found',
        detail: `Ground could not resolve ${draft.command}. Choose an absolute executable path.`
      }
    }
    const previewProvider: CliProvider = {
      id: draft.id ?? 'preview',
      kind: 'cli',
      name: draft.name,
      model: draft.model,
      command: executable,
      args: draft.args ?? [],
      promptMode: draft.promptMode ?? 'stdin',
      outputMode: draft.outputMode ?? 'plain',
      cliAdapter: draft.cliAdapter,
      environmentVariables: (draft.cliEnvironment ?? []).map(
        (entry) => entry.name
      ),
      trustConfirmed: true,
      createdAt: '',
      updatedAt: ''
    }
    const preview = expandCliArgs(previewProvider, 'Your prompt appears here', '/path/to/workspace')
    return {
      ok: true,
      title: 'Executable found',
      detail: [
        executable,
        ...preview.args.map((argument, index) => `argv[${index}]: ${argument}`),
        preview.stdin ? 'Prompt transport: stdin' : 'Prompt transport: argument',
        ...(draft.cliEnvironment?.length
          ? [
              `Profile environment keys: ${draft.cliEnvironment
                .map((entry) => entry.name)
                .join(', ')}`
            ]
          : [])
      ].join('\n')
    }
  }

  private async testModelApi(draft: ProviderDraft): Promise<ProviderTestResult> {
    if (draft.kind === 'cli') {
      throw new Error('CLI drafts must be tested with the CLI tester')
    }
    const providerId = draft.id
    const endpoint = canonicalProviderEndpoint(draft.baseUrl as string)
    let apiKey = draft.apiKey?.trim()
    if (!apiKey && providerId) {
      let existing: ProviderProfile | undefined
      try {
        existing = this.store.getProvider(providerId)
      } catch {
        existing = undefined
      }
      if (isModelApiProvider(existing) && existing.hasApiKey) {
        if (!isSameCredentialBoundary(existing, draft.kind, endpoint)) {
          return {
            ok: false,
            title: 'API key needs confirmation',
            detail: 'Re-enter the API key after changing the provider protocol or endpoint.'
          }
        }
        apiKey = await resolveProviderCredential(
          this.vault,
          existing,
          providerCredentialReferenceFor(existing)
        )
      }
    }
    if (requiresApiKey(draft.kind) && !apiKey) {
      return {
        ok: false,
        title: 'API key required',
        detail: `${draft.name.trim()} requires an API key before Ground can connect.`
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(modelDiscoveryEndpoint(draft.kind, endpoint), {
        headers: discoveryHeaders(draft.kind, apiKey),
        redirect: 'error',
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = redactKnownSecret(
          await readResponseText(response, MAX_PROVIDER_ERROR_BYTES),
          apiKey
        )
        throw new Error(`${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`)
      }
      const payloadText = await readResponseText(
        response,
        MAX_MODEL_DISCOVERY_BYTES
      )
      let payload: unknown
      try {
        payload = JSON.parse(payloadText)
      } catch {
        throw new Error('Provider returned invalid model-discovery JSON')
      }
      const models = discoveredModels(draft.kind, payload)
      return {
        ok: true,
        title: 'Connection successful',
        detail: models.length
          ? `Found ${models.length} available model${models.length === 1 ? '' : 's'}.`
          : 'The endpoint responded successfully.',
        models
      }
    } catch (error) {
      return {
        ok: false,
        title: 'Could not connect',
        detail:
          error instanceof Error && error.name === 'AbortError'
            ? 'The endpoint did not respond within 10 seconds.'
            : redactKnownSecret(readableError(error), apiKey)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async deleteCredentialsBestEffort(
    references: Iterable<string>
  ): Promise<void> {
    for (const reference of new Set(references)) {
      try {
        await this.vault.delete(reference)
      } catch {
        // A stale, unreferenced credential is safer than rolling back persisted state.
      }
    }
  }

  private async persistCliEnvironmentAndProvider(
    plan: CliEnvironmentPlan,
    provider: CliProvider
  ): Promise<void> {
    let vaultMutated = false
    try {
      if (plan.mutation === 'set') {
        if (!plan.desiredSerializedSecret) {
          throw new Error('CLI environment update is incomplete')
        }
        await this.vault.set(
          plan.secretReference,
          plan.desiredSerializedSecret
        )
        vaultMutated = true
      } else if (plan.mutation === 'delete') {
        await this.vault.delete(plan.secretReference)
        vaultMutated = true
      }
      await this.store.upsertProvider(provider)
    } catch (error) {
      if (!vaultMutated) throw error
      try {
        if (plan.previousSerializedSecret === undefined) {
          await this.vault.delete(plan.secretReference)
        } else {
          await this.vault.set(
            plan.secretReference,
            plan.previousSerializedSecret
          )
        }
      } catch (rollbackError) {
        throw new Error(
          'Provider save failed and its CLI environment could not be restored; re-enter the environment values before running it',
          { cause: new AggregateError([error, rollbackError]) }
        )
      }
      throw error
    }
  }

  private async deleteCliProviderTransactionally(
    provider: CliProvider
  ): Promise<void> {
    const reference = cliEnvironmentSecretReference(provider.id)
    const previous = this.vault.get(reference)
    let vaultMutated = false
    try {
      if (previous !== undefined) {
        await this.vault.delete(reference)
        vaultMutated = true
      }
      await this.store.deleteProvider(provider.id)
    } catch (error) {
      if (!vaultMutated || previous === undefined) throw error
      try {
        await this.vault.set(reference, previous)
      } catch (rollbackError) {
        throw new Error(
          'Provider deletion failed and its CLI environment could not be restored; re-enter the environment values before running it',
          { cause: new AggregateError([error, rollbackError]) }
        )
      }
      throw error
    }
  }
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
