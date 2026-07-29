import { createHash, randomBytes } from 'node:crypto'
import type {
  CliEnvironmentVariableDraft,
  CliProvider
} from '../shared/types'
import type { SecretVault } from './secrets'

const CLI_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const CLI_ENVIRONMENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u
const MAX_CLI_ENVIRONMENT_VARIABLES = 32
const MAX_CLI_ENVIRONMENT_VALUE_CHARACTERS = 20_000
const MAX_CLI_ENVIRONMENT_TOTAL_BYTES = 128_000

const DENIED_CLI_ENVIRONMENT_NAMES = new Set([
  'BASH_ENV',
  'BUNDLE_GEMFILE',
  'CDPATH',
  'CLASSPATH',
  'COMSPEC',
  'DOTNET_ADDITIONAL_DEPS',
  'DOTNET_STARTUP_HOOKS',
  'ELECTRON_RUN_AS_NODE',
  'ENV',
  'GCONV_PATH',
  'GEM_HOME',
  'GEM_PATH',
  'GLIBC_TUNABLES',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'IFS',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LOCPATH',
  'LUA_CPATH',
  'LUA_PATH',
  'NLSPATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'OLDPWD',
  'PATH',
  'PATHEXT',
  'PERL5LIB',
  'PERL5OPT',
  'PHP_INI_SCAN_DIR',
  'PHPRC',
  'PYTHONHOME',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYLIB',
  'RUBYOPT',
  'SHELL',
  'SHELLOPTS',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'ZDOTDIR',
  '__COMPAT_LAYER',
  '_JAVA_OPTIONS'
])

const DENIED_CLI_ENVIRONMENT_PREFIXES = [
  'COMPLUS_',
  'COR_',
  'CORECLR_',
  'DYLD_',
  'LD_'
] as const

interface CliEnvironmentSecretEnvelope {
  version: 1
  fingerprint: string
  values: Readonly<Record<string, string>>
}

export interface CliEnvironmentPlan {
  variables: readonly string[]
  fingerprint?: string
  secretReference: string
  previousSerializedSecret?: string
  desiredSerializedSecret?: string
  mutation: 'none' | 'set' | 'delete'
}

function assertFingerprint(fingerprint: string): string {
  if (!CLI_ENVIRONMENT_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('CLI environment fingerprint is invalid')
  }
  return fingerprint
}

export function assertSafeCliEnvironmentVariableName(name: string): string {
  if (!CLI_ENVIRONMENT_NAME_PATTERN.test(name)) {
    throw new Error(
      'Environment variable names must use 1-128 ASCII letters, numbers, or underscores and cannot begin with a number'
    )
  }
  const normalized = name.toUpperCase()
  if (
    DENIED_CLI_ENVIRONMENT_NAMES.has(normalized) ||
    DENIED_CLI_ENVIRONMENT_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix)
    )
  ) {
    throw new Error(
      `${name} cannot be set because it can alter process loading or execution`
    )
  }
  return name
}

export function normalizeCliEnvironmentVariableNames(
  names: readonly string[]
): readonly string[] {
  if (names.length > MAX_CLI_ENVIRONMENT_VARIABLES) {
    throw new Error(
      `A CLI profile can define at most ${MAX_CLI_ENVIRONMENT_VARIABLES} environment variables`
    )
  }
  const normalized: string[] = []
  const caseInsensitiveNames = new Set<string>()
  for (const rawName of names) {
    if (typeof rawName !== 'string') {
      throw new Error('Environment variable names must be strings')
    }
    const name = assertSafeCliEnvironmentVariableName(rawName.trim())
    const portableIdentity = name.toUpperCase()
    if (caseInsensitiveNames.has(portableIdentity)) {
      throw new Error(`Environment variable ${name} is duplicated`)
    }
    caseInsensitiveNames.add(portableIdentity)
    normalized.push(name)
  }
  return Object.freeze(normalized.sort())
}

export function cliEnvironmentSecretReference(providerId: string): string {
  return `cli-env:${createHash('sha256').update(providerId).digest('hex')}`
}

function parseSecretEnvelope(serialized: string): CliEnvironmentSecretEnvelope {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Saved CLI environment credentials are unreadable')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Saved CLI environment credentials are invalid')
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.fingerprint !== 'string' ||
    !record.values ||
    typeof record.values !== 'object' ||
    Array.isArray(record.values)
  ) {
    throw new Error('Saved CLI environment credentials are invalid')
  }
  const fingerprint = assertFingerprint(record.fingerprint)
  const rawValues = record.values as Record<string, unknown>
  const variables = normalizeCliEnvironmentVariableNames(
    Object.keys(rawValues)
  )
  const values = Object.create(null) as Record<string, string>
  let totalBytes = 0
  for (const name of variables) {
    const environmentValue = rawValues[name]
    if (
      typeof environmentValue !== 'string' ||
      environmentValue.length < 4 ||
      environmentValue.length > MAX_CLI_ENVIRONMENT_VALUE_CHARACTERS ||
      environmentValue.includes('\0')
    ) {
      throw new Error('Saved CLI environment credentials are invalid')
    }
    totalBytes += Buffer.byteLength(name, 'utf8')
    totalBytes += Buffer.byteLength(environmentValue, 'utf8')
    if (totalBytes > MAX_CLI_ENVIRONMENT_TOTAL_BYTES) {
      throw new Error('Saved CLI environment credentials exceed their size limit')
    }
    values[name] = environmentValue
  }
  return Object.freeze({
    version: 1,
    fingerprint,
    values: Object.freeze(values)
  })
}

function serializeSecretEnvelope(
  fingerprint: string,
  values: Readonly<Record<string, string>>
): string {
  return JSON.stringify({
    version: 1,
    fingerprint: assertFingerprint(fingerprint),
    values
  })
}

function valuesAreEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
  variables: readonly string[]
): boolean {
  return (
    Object.keys(left).length === variables.length &&
    Object.keys(right).length === variables.length &&
    variables.every((name) => left[name] === right[name])
  )
}

function existingEnvironment(
  provider: CliProvider | undefined,
  serializedSecret: string | undefined
): CliEnvironmentSecretEnvelope | undefined {
  const variables = normalizeCliEnvironmentVariableNames(
    provider?.environmentVariables ?? []
  )
  if (!variables.length) {
    if (provider?.environmentFingerprint) {
      throw new Error('CLI environment metadata is inconsistent')
    }
    return undefined
  }
  if (!provider?.environmentFingerprint) {
    throw new Error('CLI environment metadata is incomplete')
  }
  if (!serializedSecret) {
    throw new Error(
      'Saved CLI environment credentials are unavailable; re-enter their values'
    )
  }
  const envelope = parseSecretEnvelope(serializedSecret)
  if (
    envelope.fingerprint !== provider.environmentFingerprint ||
    variables.length !== Object.keys(envelope.values).length ||
    variables.some((name) => !Object.hasOwn(envelope.values, name))
  ) {
    throw new Error(
      'Saved CLI environment credentials no longer match this profile; re-enter their values'
    )
  }
  return envelope
}

function normalizeDraftEntries(
  entries: readonly CliEnvironmentVariableDraft[]
): readonly CliEnvironmentVariableDraft[] {
  const variables = normalizeCliEnvironmentVariableNames(
    entries.map((entry) => entry.name)
  )
  const byName = new Map(
    entries.map((entry) => [entry.name.trim(), entry] as const)
  )
  return Object.freeze(
    variables.map((name) => {
      const entry = byName.get(name)
      if (!entry) throw new Error(`Environment variable ${name} is invalid`)
      if (
        entry.value !== undefined &&
        entry.value.length > 0 &&
        (entry.value.length < 4 ||
          entry.value.length > MAX_CLI_ENVIRONMENT_VALUE_CHARACTERS ||
          entry.value.includes('\0'))
      ) {
        throw new Error(
          `Environment variable ${name} must contain at least 4 characters`
        )
      }
      return Object.freeze({ name, value: entry.value })
    })
  )
}

export function prepareCliEnvironmentPlan(
  providerId: string,
  draftEntries: readonly CliEnvironmentVariableDraft[] | undefined,
  existingProvider: CliProvider | undefined,
  previousSerializedSecret: string | undefined
): CliEnvironmentPlan {
  const secretReference = cliEnvironmentSecretReference(providerId)
  const existing = existingEnvironment(
    existingProvider,
    previousSerializedSecret
  )

  if (draftEntries === undefined) {
    const variables = normalizeCliEnvironmentVariableNames(
      existingProvider?.environmentVariables ?? []
    )
    return Object.freeze({
      variables,
      ...(existingProvider?.environmentFingerprint
        ? { fingerprint: existingProvider.environmentFingerprint }
        : {}),
      secretReference,
      ...(previousSerializedSecret ? { previousSerializedSecret } : {}),
      mutation: 'none'
    })
  }

  const entries = normalizeDraftEntries(draftEntries)
  if (!entries.length) {
    return Object.freeze({
      variables: Object.freeze([]),
      secretReference,
      ...(previousSerializedSecret ? { previousSerializedSecret } : {}),
      mutation: previousSerializedSecret ? 'delete' : 'none'
    })
  }

  const values = Object.create(null) as Record<string, string>
  let totalBytes = 0
  for (const entry of entries) {
    const supplied = entry.value && entry.value.length > 0
      ? entry.value
      : undefined
    const value = supplied ?? existing?.values[entry.name]
    if (value === undefined) {
      throw new Error(`Enter a value for environment variable ${entry.name}`)
    }
    values[entry.name] = value
    totalBytes += Buffer.byteLength(entry.name, 'utf8')
    totalBytes += Buffer.byteLength(value, 'utf8')
    if (totalBytes > MAX_CLI_ENVIRONMENT_TOTAL_BYTES) {
      throw new Error('CLI environment values exceed their total size limit')
    }
  }

  const variables = Object.freeze(entries.map((entry) => entry.name))
  if (
    existing &&
    existingProvider?.environmentFingerprint &&
    variables.length === (existingProvider.environmentVariables ?? []).length &&
    valuesAreEqual(existing.values, values, variables)
  ) {
    return Object.freeze({
      variables,
      fingerprint: existingProvider.environmentFingerprint,
      secretReference,
      ...(previousSerializedSecret ? { previousSerializedSecret } : {}),
      mutation: 'none'
    })
  }

  const fingerprint = randomBytes(32).toString('hex')
  return Object.freeze({
    variables,
    fingerprint,
    secretReference,
    ...(previousSerializedSecret ? { previousSerializedSecret } : {}),
    desiredSerializedSecret: serializeSecretEnvelope(fingerprint, values),
    mutation: 'set'
  })
}

export function resolveCliEnvironment(
  vault: SecretVault,
  provider: CliProvider
): Readonly<Record<string, string>> {
  const variables = normalizeCliEnvironmentVariableNames(
    provider.environmentVariables ?? []
  )
  if (!variables.length) {
    if (provider.environmentFingerprint) {
      throw new Error('CLI environment metadata is inconsistent')
    }
    return Object.freeze(Object.create(null) as Record<string, string>)
  }
  const serialized = vault.get(cliEnvironmentSecretReference(provider.id))
  const envelope = existingEnvironment(provider, serialized)
  if (!envelope) {
    throw new Error('Saved CLI environment credentials are unavailable')
  }
  const values = Object.create(null) as Record<string, string>
  for (const name of variables) values[name] = envelope.values[name] as string
  return Object.freeze(values)
}
