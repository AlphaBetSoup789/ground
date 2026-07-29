import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  CliProvider,
  DetectedCli,
  ModelApiProvider,
  ModelProviderKind,
  ProviderDraft,
  ProviderProfile,
  ProviderTestResult,
  ProviderVerification
} from '../shared/types'
import {
  cliEnvironmentSecretReference,
  cliEnvironmentSecretReferencesFor,
  normalizeCliEnvironmentVariableNames,
  prepareCliEnvironmentPlan,
  type CliEnvironmentPlan
} from './cli-environment'
import { createId, nowIso } from './lib/ids'
import { drainPendingSecretDeletes } from './credential-recovery'
import {
  providerCredentialReference,
  providerCredentialReferenceFor,
  resolveProviderCredential
} from './provider-credentials'
import { ProviderOperationGate } from './provider-operation-gate'
import { providerConfigurationFingerprint } from './provider-revision'
import { safeChildEnvironment } from './process-launch'
import { modelsEndpoint } from './providers/openai'
import { expandCliArgs, resolveExecutable } from './providers/cli'
import {
  discoverCliExecutable,
  validateCliExecutablePath
} from './cli-executable-discovery'
import {
  SecretVault,
  SecretVaultPersistenceError
} from './secrets'
import {
  StatePersistenceError,
  StateStore
} from './store'
import {
  canonicalProviderEndpoint,
  CliTrustRegistry,
  isLiteralLoopbackUrl
} from './trust-boundary'
import { parseProviderDraft } from './validation'

const MAX_MODEL_DISCOVERY_BYTES = 2_000_000
const MAX_PROVIDER_ERROR_BYTES = 2_000
const MAX_COMPATIBLE_GENERATION_BYTES = 256_000
const MAX_CLI_VERSION_BYTES = 16_384
const CLI_VERSION_TIMEOUT_MS = 2_000
const PROVIDER_DISCOVERY_TIMEOUT_MS = 10_000
const COMPATIBLE_GENERATION_TIMEOUT_MS = 10_000
const COMPATIBLE_GENERATION_MAX_TOKENS = 4
const execFileAsync = promisify(execFile)

export function assertProviderCanStartRun(provider: ProviderProfile): void {
  if (provider.verification?.status !== 'passed') {
    throw new Error(
      `Test ${provider.name} in Settings before its first run or after changing its configuration.`
    )
  }
}

export function antigravitySupportsStructuredOutput(
  versionOutput: string
): boolean {
  const match =
    /^(?:(?:antigravity(?:\s+cli)?|agy)(?:\s+version)?\s+)?v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/iu.exec(
      versionOutput.trim()
    )
  if (!match) return false
  const version = match.slice(1).map(Number)
  const minimum = [1, 1, 8]
  for (let index = 0; index < minimum.length; index += 1) {
    if ((version[index] as number) > (minimum[index] as number)) return true
    if ((version[index] as number) < (minimum[index] as number)) return false
  }
  return true
}

export async function probeAntigravityStructuredOutput(
  executable: string
): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(
      executable,
      ['--version'],
      {
        encoding: 'utf8',
        env: safeChildEnvironment(),
        killSignal: 'SIGKILL',
        maxBuffer: MAX_CLI_VERSION_BYTES,
        shell: false,
        timeout: CLI_VERSION_TIMEOUT_MS,
        windowsHide: true
      }
    )
    return antigravitySupportsStructuredOutput(`${stdout}\n${stderr}`)
  } catch {
    return false
  }
}

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

function sameStringArray(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function providerMatchesSavedDraft(
  provider: ProviderProfile,
  draft: ProviderDraft
): boolean {
  if (
    provider.id !== draft.id ||
    provider.kind !== draft.kind ||
    provider.name !== draft.name ||
    provider.model !== draft.model
  ) {
    return false
  }

  if (provider.kind !== 'cli' && draft.kind !== 'cli') {
    return (
      !draft.apiKey?.trim() &&
      provider.baseUrl ===
        canonicalProviderEndpoint(draft.baseUrl as string) &&
      provider.supportsTools === (draft.supportsTools ?? true) &&
      provider.contextWindowTokens === draft.contextWindowTokens &&
      provider.maxOutputTokens === draft.maxOutputTokens &&
      provider.reasoningEffort === draft.reasoningEffort
    )
  }

  if (provider.kind !== 'cli' || draft.kind !== 'cli') return false
  if (
    (draft.cliEnvironment ?? []).some(
      (entry) => entry.value !== undefined && entry.value.length > 0
    )
  ) {
    return false
  }
  const environmentVariables = normalizeCliEnvironmentVariableNames(
    (draft.cliEnvironment ?? []).map((entry) => entry.name)
  )
  return (
    provider.command === draft.command &&
    sameStringArray(provider.args, draft.args ?? []) &&
    provider.promptMode === (draft.promptMode ?? 'stdin') &&
    provider.outputMode === (draft.outputMode ?? 'plain') &&
    (provider.cliAdapter ?? 'generic') ===
      (draft.cliAdapter ?? 'generic') &&
    sameStringArray(
      provider.environmentVariables ?? [],
      environmentVariables
    ) &&
    provider.trustConfirmed === (draft.trustConfirmed ?? false)
  )
}

interface ProviderVerificationTarget {
  id: string
  providerRevision: string
  providerFingerprint: string
}

interface ApiCredentialMutation {
  reference: string
  desiredSecret: string
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

function hasOpenAiCompatibleDiscoveryShape(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }
  const entries = (payload as Record<string, unknown>).data
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry) =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).id === 'string' &&
        ((entry as Record<string, unknown>).id as string).length > 0
    )
  )
}

function compatibleChatEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) return normalized
  if (normalized.endsWith('/models')) {
    return `${normalized.slice(0, -'/models'.length)}/chat/completions`
  }
  return `${normalized}/chat/completions`
}

function validateCompatibleGeneration(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Generation probe returned an invalid response object')
  }
  const choices = (payload as Record<string, unknown>).choices
  if (
    !Array.isArray(choices) ||
    choices.length === 0 ||
    !choices[0] ||
    typeof choices[0] !== 'object' ||
    Array.isArray(choices[0])
  ) {
    throw new Error('Generation probe returned an invalid choices array')
  }
  const message = (choices[0] as Record<string, unknown>).message
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    typeof (message as Record<string, unknown>).content !== 'string'
  ) {
    throw new Error('Generation probe returned an invalid assistant message')
  }
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
  return secret
    ? value.replaceAll(secret, '[redacted]')
    : value
}

function safeNetworkErrorCode(error: unknown): string | undefined {
  const pending: unknown[] = [error]
  const visited = new Set<object>()
  while (pending.length > 0 && visited.size < 32) {
    const candidate = pending.shift()
    if (
      (typeof candidate !== 'object' || candidate === null) &&
      typeof candidate !== 'function'
    ) {
      continue
    }
    if (visited.has(candidate)) continue
    visited.add(candidate)

    try {
      const code = (candidate as { code?: unknown }).code
      if (
        typeof code === 'string' &&
        /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)
      ) {
        return code
      }
      const cause = (candidate as { cause?: unknown }).cause
      if (cause !== undefined) pending.push(cause)
      if (candidate instanceof AggregateError) {
        pending.push(...candidate.errors)
      }
    } catch {
      // Treat unexpected accessors as opaque rather than exposing their output.
    }
  }
  return undefined
}

function loopbackConnectionRefusedDetail(
  endpoint: string,
  errors: readonly unknown[]
): string | undefined {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return undefined
  }
  if (
    !isLiteralLoopbackUrl(url) ||
    errors.length === 0 ||
    !errors.every((error) => safeNetworkErrorCode(error) === 'ECONNREFUSED')
  ) {
    return undefined
  }
  return (
    `No service is listening at ${endpoint} (connection refused, ECONNREFUSED). ` +
    'Start Ollama or LM Studio and ensure its local API server is running, ' +
    'or correct the Base URL in Ground.'
  )
}

function conciseProbeError(
  error: unknown,
  apiKey: string | undefined,
  timeoutMs: number,
  endpoint: string
): string {
  const baseDetail =
    error instanceof Error && error.name === 'AbortError'
      ? `timed out after ${timeoutMs / 1_000} seconds`
      : redactKnownSecret(readableError(error), apiKey)
  const code = safeNetworkErrorCode(error)
  const detail =
    code && !baseDetail.includes(code)
      ? `${baseDetail} (${code})`
      : baseDetail
  const normalized = `request to ${endpoint}: ${detail}`
    .replace(/\s+/gu, ' ')
    .trim()
  return normalized.length > 800
    ? `${normalized.slice(0, 797)}...`
    : normalized || 'unknown error'
}

export class ProviderService {
  constructor(
    private readonly store: StateStore,
    private readonly vault: SecretVault,
    private readonly cliTrust: CliTrustRegistry,
    private readonly isProviderActive: (providerId: string) => boolean = () =>
      false,
    private readonly providerOperations?: ProviderOperationGate,
    private readonly configuredWorkspacePaths: () => readonly string[] = () =>
      [],
    private readonly onPersistenceUncertain?: (error: Error) => void
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
        const credentialBoundaryChanged = Boolean(
          existing &&
            !isSameCredentialBoundary(existing, draft.kind, endpoint)
        )
        const sameBoundaryProvider = isSameCredentialBoundary(
          existing,
          draft.kind,
          endpoint
        )
          ? existing
          : undefined
        const currentCredentialReference = sameBoundaryProvider
          ? providerCredentialReferenceFor(sameBoundaryProvider)
          : providerCredentialReference(id, draft.kind, endpoint)
        let scopedCredential: string | undefined
        let legacyCredential: string | undefined
        if (!newApiKey && sameBoundaryProvider?.hasApiKey) {
          scopedCredential = this.vault.get(currentCredentialReference)
          if (
            !scopedCredential &&
            !sameBoundaryProvider.credentialRevision
          ) {
            legacyCredential = this.vault.get(id)
          }
          if (!scopedCredential && !legacyCredential) {
            throw new Error(
              'The saved API key is unavailable; re-enter it before saving'
            )
          }
        }
        const canReuseApiKey =
          !credentialBoundaryChanged &&
          Boolean(
            sameBoundaryProvider?.hasApiKey &&
              (scopedCredential || legacyCredential)
          )

        if (requiresApiKey(draft.kind) && !newApiKey && !canReuseApiKey) {
          throw new Error(`${draft.name.trim()} requires an API key`)
        }

        let credentialRevision =
          canReuseApiKey && scopedCredential
            ? sameBoundaryProvider?.credentialRevision
            : undefined
        let stagedSecret: string | undefined
        if (newApiKey) {
          credentialRevision = createId('credential')
          stagedSecret = newApiKey
        } else if (
          canReuseApiKey &&
          scopedCredential &&
          !sameBoundaryProvider?.credentialRevision
        ) {
          credentialRevision = createId('credential')
          stagedSecret = scopedCredential
        } else if (
          canReuseApiKey &&
          !scopedCredential &&
          legacyCredential
        ) {
          credentialRevision = createId('credential')
          stagedSecret = legacyCredential
        }

        const hasApiKey = Boolean(newApiKey || canReuseApiKey)
        const credentialReference = providerCredentialReference(
          id,
          draft.kind,
          endpoint,
          credentialRevision
        )
        const credentialMutation =
          stagedSecret === undefined
            ? undefined
            : {
                reference: credentialReference,
                desiredSecret: stagedSecret
              }

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
          ...(hasApiKey && credentialRevision
            ? { credentialRevision }
            : {}),
          verification: { status: 'unverified' },
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp
        })
        const obsoleteReferences: string[] = []
        if (isModelApiProvider(existing)) {
          const previousReference = providerCredentialReferenceFor(existing)
          if (previousReference !== credentialReference) {
            obsoleteReferences.push(previousReference)
          }
          const previousLegacyBoundary = providerCredentialReference(
            existing.id,
            existing.kind,
            existing.baseUrl
          )
          if (previousLegacyBoundary !== credentialReference) {
            obsoleteReferences.push(previousLegacyBoundary)
          }
        } else if (existing?.kind === 'cli') {
          obsoleteReferences.push(
            ...cliEnvironmentSecretReferencesFor(existing)
          )
        }
        if (!hasApiKey) obsoleteReferences.push(credentialReference)
        const currentLegacyBoundary = providerCredentialReference(
          id,
          draft.kind,
          endpoint
        )
        if (currentLegacyBoundary !== credentialReference) {
          obsoleteReferences.push(currentLegacyBoundary)
        }
        // The published API profile now either points at a scoped versioned
        // credential or explicitly has no key, so a provider-id legacy entry
        // is no longer authoritative.
        obsoleteReferences.push(id)
        await this.persistApiCredentialAndProvider(
          provider,
          credentialMutation,
          obsoleteReferences
        )
      } else {
      const cliAdapter =
        draft.cliAdapter ?? (existing?.kind === 'cli' ? existing.cliAdapter : undefined) ?? 'generic'
      const environmentReference =
        existing?.kind === 'cli'
          ? cliEnvironmentSecretReference(
              id,
              existing.environmentRevision
            )
          : cliEnvironmentSecretReference(id)
      const previousEnvironmentSecret = this.vault.get(environmentReference)
      const environmentPlan = prepareCliEnvironmentPlan(
        id,
        draft.cliEnvironment,
        existing?.kind === 'cli' ? existing : undefined,
        previousEnvironmentSecret
      )
      const selectedExecutable = await this.validatedCliExecutable(
        draft.command as string
      )
      const executable = await this.cliTrust.authorize({
        ...draft,
        command: selectedExecutable,
        cliAdapter,
        environmentVariables: environmentPlan.variables,
        environmentFingerprint: environmentPlan.fingerprint
      })
      if (
        cliAdapter === 'antigravity' &&
        !(await probeAntigravityStructuredOutput(executable))
      ) {
        throw new Error(
          'Antigravity CLI 1.1.8 or newer is required for structured streaming'
        )
      }
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
              environmentFingerprint: environmentPlan.fingerprint,
              ...(environmentPlan.revision
                ? { environmentRevision: environmentPlan.revision }
                : {})
            }
          : {}),
        trustConfirmed: true,
        verification: { status: 'unverified' },
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      const convertedCredentialReferences = isModelApiProvider(existing)
        ? [
          providerCredentialReferenceFor(existing),
          providerCredentialReference(
            existing.id,
            existing.kind,
            existing.baseUrl
          ),
          id
        ]
        : [id]
      await this.persistCliEnvironmentAndProvider(
        environmentPlan,
        provider,
        convertedCredentialReferences
      )
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
      const obsoleteReferences =
        provider.kind === 'cli'
          ? [
              ...cliEnvironmentSecretReferencesFor(provider),
              providerId
            ]
          : [
              providerCredentialReferenceFor(provider),
              providerCredentialReference(
                provider.id,
                provider.kind,
                provider.baseUrl
              ),
              providerId
            ]
      try {
        await this.store.deleteProviderWithSecretTransition(
          providerId,
          obsoleteReferences
        )
      } catch (error) {
        await this.rethrowPersistenceUncertainty(error)
      }
      await this.finishJournaledCleanup(
        'The provider was deleted, but one or more saved credentials could not be removed; cleanup remains journaled for the next Ground start'
      )
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
        detail: readableError(error),
        persisted: false
      }
    }
    const target = this.verificationTarget(draft)
    const result =
      draft.kind === 'cli'
        ? await this.testCli(draft)
        : await this.testModelApi(draft)
    const verification: ProviderVerification = {
      status: result.ok ? 'passed' : 'failed',
      scope: draft.kind === 'cli' ? 'configuration' : 'connection',
      checkedAt: nowIso()
    }
    const persisted = await this.persistVerification(
      draft,
      target,
      verification
    )
    return { ...result, persisted }
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
      },
      {
        id: 'antigravity',
        name: 'Antigravity CLI',
        command: 'agy',
        description:
          'Google’s structured headless agent; version 1.1.8+ is checked during native confirmation before save.',
        draft: {
          name: 'Antigravity CLI',
          kind: 'cli',
          model: '',
          command: 'agy',
          args: [
            '-p',
            '{prompt}',
            '--output-format',
            'stream-json'
          ],
          promptMode: 'argument',
          outputMode: 'ndjson',
          cliAdapter: 'antigravity',
          trustConfirmed: false
        }
      }
    ]
    const detected: DetectedCli[] = []
    const workspaceRoots = this.configuredWorkspacePaths()
    for (const candidate of candidates) {
      const executable = await discoverCliExecutable(candidate.command, {
        workspaceRoots
      })
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
    let executable: string
    try {
      executable = await this.validatedCliExecutable(
        draft.command as string
      )
    } catch (error) {
      return {
        ok: false,
        title: 'Configuration check failed',
        detail: readableError(error)
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
      title:
        draft.cliAdapter === 'antigravity'
          ? 'Executable found; version is checked on save'
          : 'Configuration check passed',
      detail: [
        executable,
        ...(draft.cliAdapter === 'antigravity'
          ? [
              'Antigravity 1.1.8+ will be verified only after native executable confirmation.'
            ]
          : []),
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

  private async validatedCliExecutable(command: string): Promise<string> {
    const resolved = await resolveExecutable(command)
    if (!resolved) {
      throw new Error(
        `Ground could not resolve ${command}. Choose an absolute executable path.`
      )
    }
    return validateCliExecutablePath(resolved, {
      workspaceRoots: this.configuredWorkspacePaths()
    })
  }

  private verificationTarget(
    draft: ProviderDraft
  ): ProviderVerificationTarget | undefined {
    if (!draft.id) return undefined
    try {
      const provider = this.store.getProvider(draft.id)
      return providerMatchesSavedDraft(provider, draft)
        ? {
            id: provider.id,
            providerRevision: provider.updatedAt,
            providerFingerprint:
              providerConfigurationFingerprint(provider)
          }
        : undefined
    } catch {
      return undefined
    }
  }

  private async persistVerification(
    draft: ProviderDraft,
    target: ProviderVerificationTarget | undefined,
    verification: ProviderVerification
  ): Promise<boolean> {
    if (!target) return false
    let releaseMutation: () => void = () => undefined
    if (this.providerOperations) {
      try {
        releaseMutation = this.providerOperations.reserveMutation(
          target.id,
          () => this.isProviderActive(target.id)
        )
      } catch {
        return false
      }
    }
    try {
      const provider = this.store.getProvider(target.id)
      if (
        provider.updatedAt !== target.providerRevision ||
        providerConfigurationFingerprint(provider) !==
          target.providerFingerprint ||
        !providerMatchesSavedDraft(provider, draft)
      ) {
        return false
      }
      await this.store.upsertProvider({
        ...provider,
        verification
      })
      return true
    } catch {
      return false
    } finally {
      releaseMutation()
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
    const discoveryController = new AbortController()
    const discoveryTimer = setTimeout(
      () => discoveryController.abort(),
      PROVIDER_DISCOVERY_TIMEOUT_MS
    )
    const discoveryEndpoint = modelDiscoveryEndpoint(
      draft.kind,
      endpoint
    )
    let discoveryError: unknown
    try {
      const response = await fetch(discoveryEndpoint, {
        headers: discoveryHeaders(draft.kind, apiKey),
        redirect: 'error',
        signal: discoveryController.signal
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
      if (
        draft.kind === 'openai-compatible' &&
        !hasOpenAiCompatibleDiscoveryShape(payload)
      ) {
        throw new Error(
          'Provider model listing did not return an OpenAI-compatible data array'
        )
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
      discoveryError = error
    } finally {
      clearTimeout(discoveryTimer)
    }

    if (draft.kind !== 'openai-compatible') {
      const connectionRefused = loopbackConnectionRefusedDetail(endpoint, [
        discoveryError
      ])
      return {
        ok: false,
        title: 'Could not connect',
        detail:
          connectionRefused ??
          conciseProbeError(
            discoveryError,
            apiKey,
            PROVIDER_DISCOVERY_TIMEOUT_MS,
            discoveryEndpoint
          )
      }
    }

    const generationController = new AbortController()
    const generationTimer = setTimeout(
      () => generationController.abort(),
      COMPATIBLE_GENERATION_TIMEOUT_MS
    )
    const generationEndpoint = compatibleChatEndpoint(endpoint)
    try {
      const response = await fetch(generationEndpoint, {
        method: 'POST',
        headers: {
          ...discoveryHeaders(draft.kind, apiKey),
          'Content-Type': 'application/json'
        },
        redirect: 'error',
        signal: generationController.signal,
        body: JSON.stringify({
          model: draft.model.trim(),
          messages: [
            {
              role: 'user',
              content: 'Reply with OK.'
            }
          ],
          max_tokens: COMPATIBLE_GENERATION_MAX_TOKENS,
          stream: false
        })
      })
      if (!response.ok) {
        const detail = redactKnownSecret(
          await readResponseText(response, MAX_PROVIDER_ERROR_BYTES),
          apiKey
        )
        throw new Error(
          `${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`
        )
      }
      const payloadText = await readResponseText(
        response,
        MAX_COMPATIBLE_GENERATION_BYTES
      )
      let payload: unknown
      try {
        payload = JSON.parse(payloadText)
      } catch {
        throw new Error('Generation probe returned invalid JSON')
      }
      validateCompatibleGeneration(payload)
      return {
        ok: true,
        title: 'Connection successful',
        detail:
          'Model listing was unavailable, but a minimal generation request succeeded.',
        models: []
      }
    } catch (generationError) {
      const connectionRefused = loopbackConnectionRefusedDetail(endpoint, [
        discoveryError,
        generationError
      ])
      return {
        ok: false,
        title: 'Could not connect',
        detail:
          connectionRefused ??
          [
            `Model listing failed: ${conciseProbeError(
              discoveryError,
              apiKey,
              PROVIDER_DISCOVERY_TIMEOUT_MS,
              discoveryEndpoint
            )}`,
            `Generation probe failed: ${conciseProbeError(
              generationError,
              apiKey,
              COMPATIBLE_GENERATION_TIMEOUT_MS,
              generationEndpoint
            )}`
          ].join(' ')
      }
    } finally {
      clearTimeout(generationTimer)
    }
  }

  private async rethrowPersistenceUncertainty(
    error: unknown
  ): Promise<never> {
    if (
      error instanceof StatePersistenceError ||
      error instanceof SecretVaultPersistenceError
    ) {
      this.onPersistenceUncertain?.(error)
      throw new Error(
        'Provider persistence became uncertain. Ground must relaunch before another change; its cleanup journal will resolve the selected disk generation.',
        { cause: error }
      )
    }
    throw error
  }

  private async finishJournaledCleanup(
    failureMessage: string
  ): Promise<void> {
    try {
      await drainPendingSecretDeletes(this.store, this.vault)
    } catch (error) {
      if (
        error instanceof StatePersistenceError ||
        error instanceof SecretVaultPersistenceError
      ) {
        await this.rethrowPersistenceUncertainty(error)
      }
      throw new Error(failureMessage, { cause: error })
    }
  }

  private async stageJournaledCredential(
    reference: string,
    value: string,
    obsoleteReferences: readonly string[]
  ): Promise<void> {
    try {
      await this.store.queueProvisionalSecretDelete(reference)
    } catch (error) {
      await this.rethrowPersistenceUncertainty(error)
    }

    try {
      await this.stageCredential(reference, value, obsoleteReferences)
    } catch (error) {
      if (error instanceof SecretVaultPersistenceError) {
        await this.rethrowPersistenceUncertainty(error)
      }
      try {
        await this.finishJournaledCleanup(
          'Provider save failed and its provisional credential cleanup could not be completed; restart Ground before trying again'
        )
      } catch (cleanupError) {
        throw new Error(
          'Provider save failed and its provisional credential cleanup remains pending',
          { cause: new AggregateError([error, cleanupError]) }
        )
      }
      throw error
    }
  }

  private async publishProviderSecretTransition(
    provider: ProviderProfile,
    stagedReference: string | undefined,
    obsoleteReferences: readonly string[]
  ): Promise<void> {
    try {
      await this.store.publishProviderSecretTransition(
        provider,
        stagedReference,
        obsoleteReferences
      )
    } catch (error) {
      if (error instanceof StatePersistenceError) {
        await this.rethrowPersistenceUncertainty(error)
      }
      if (stagedReference) {
        try {
          await this.finishJournaledCleanup(
            'Provider save failed and its staged credential cleanup could not be completed; restart Ground before trying again'
          )
        } catch (cleanupError) {
          throw new Error(
            'Provider save failed and its staged credential cleanup remains pending',
            { cause: new AggregateError([error, cleanupError]) }
          )
        }
      }
      throw error
    }
  }

  private async persistApiCredentialAndProvider(
    provider: ModelApiProvider,
    credentialMutation: ApiCredentialMutation | undefined,
    obsoleteReferences: readonly string[]
  ): Promise<void> {
    if (!credentialMutation) {
      await this.publishProviderSecretTransition(
        provider,
        undefined,
        obsoleteReferences
      )
      await this.finishJournaledCleanup(
        'The provider was saved, but stale credentials could not be removed; cleanup remains journaled for the next Ground start'
      )
      return
    }

    await this.stageJournaledCredential(
      credentialMutation.reference,
      credentialMutation.desiredSecret,
      obsoleteReferences
    )
    await this.publishProviderSecretTransition(
      provider,
      credentialMutation.reference,
      obsoleteReferences
    )
    await this.finishJournaledCleanup(
      'The provider was saved, but stale credentials could not be removed; cleanup remains journaled for the next Ground start'
    )
  }

  private async persistCliEnvironmentAndProvider(
    plan: CliEnvironmentPlan,
    provider: CliProvider,
    additionalObsoleteReferences: readonly string[]
  ): Promise<void> {
    const obsoleteReferences = [
      ...plan.obsoleteSecretReferences,
      ...additionalObsoleteReferences
    ]
    if (plan.mutation === 'none') {
      await this.publishProviderSecretTransition(
        provider,
        undefined,
        obsoleteReferences
      )
      await this.finishJournaledCleanup(
        'The CLI provider was saved, but stale credentials could not be removed; cleanup remains journaled for the next Ground start'
      )
      return
    }

    if (plan.mutation === 'delete') {
      await this.publishProviderSecretTransition(
        provider,
        undefined,
        obsoleteReferences
      )
      await this.finishJournaledCleanup(
        'The CLI environment was cleared, but one or more encrypted values could not be removed; cleanup remains journaled for the next Ground start'
      )
      return
    }

    if (!plan.desiredSerializedSecret || !plan.revision) {
      throw new Error('CLI environment update is incomplete')
    }
    await this.stageJournaledCredential(
      plan.secretReference,
      plan.desiredSerializedSecret,
      obsoleteReferences
    )
    await this.publishProviderSecretTransition(
      provider,
      plan.secretReference,
      obsoleteReferences
    )
    await this.finishJournaledCleanup(
      'The CLI provider was saved, but stale credentials could not be removed; cleanup remains journaled for the next Ground start'
    )
  }

  private stageCredential(
    reference: string,
    value: string,
    obsoleteReferences: readonly string[]
  ): Promise<void> {
    const vault = this.vault as SecretVault & {
      setStaged?: (
        reference: string,
        value: string,
        options?: { obsoleteReferences?: readonly string[] }
      ) => Promise<void>
    }
    return typeof vault.setStaged === 'function'
      ? vault.setStaged(reference, value, { obsoleteReferences })
      : vault.set(reference, value)
  }
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
