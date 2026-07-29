import type { CliAdapter } from '../shared/types'

export const BUILT_IN_CLI_RUNTIME_DIALECTS = Object.freeze([
  'generic',
  'codex',
  'claude',
  'gemini'
] as const satisfies readonly CliAdapter[])

export type CliRuntimeSessionCompatibilityId = Exclude<CliAdapter, 'generic'>

export interface BuiltInCliRuntimeBinding {
  readonly adapterId: string
  readonly sessionCompatibilityId?: CliRuntimeSessionCompatibilityId
}

export const BUILT_IN_CLI_RUNTIME_BINDINGS = Object.freeze({
  generic: Object.freeze({
    adapterId: 'ground.cli.generic'
  }),
  codex: Object.freeze({
    adapterId: 'openai.codex-cli',
    sessionCompatibilityId: 'codex'
  }),
  claude: Object.freeze({
    adapterId: 'anthropic.claude-code',
    sessionCompatibilityId: 'claude'
  }),
  gemini: Object.freeze({
    adapterId: 'google.gemini-cli',
    sessionCompatibilityId: 'gemini'
  })
} as const satisfies Readonly<
  Record<CliAdapter, Readonly<BuiltInCliRuntimeBinding>>
>)

export const CLI_RUNTIME_ADAPTER_IDS: Readonly<Record<CliAdapter, string>> =
  Object.freeze({
    generic: BUILT_IN_CLI_RUNTIME_BINDINGS.generic.adapterId,
    codex: BUILT_IN_CLI_RUNTIME_BINDINGS.codex.adapterId,
    claude: BUILT_IN_CLI_RUNTIME_BINDINGS.claude.adapterId,
    gemini: BUILT_IN_CLI_RUNTIME_BINDINGS.gemini.adapterId
  })

const BUILT_IN_CLI_DIALECT_BY_ADAPTER_ID = new Map<string, CliAdapter>(
  Object.entries(CLI_RUNTIME_ADAPTER_IDS).map(([dialect, adapterId]) => [
    adapterId,
    dialect as CliAdapter
  ])
)

/**
 * Validate the source-registered runtime identity carried into native launch
 * authorization. Downstream reviewed runtimes may use a distinct id while
 * delegating to a built-in dialect, but no caller may relabel one built-in
 * runtime as another dialect.
 */
export function validateCliRuntimeAdapterBinding(
  runtimeAdapterId: string,
  dialect: CliAdapter
): string {
  if (!Object.prototype.hasOwnProperty.call(CLI_RUNTIME_ADAPTER_IDS, dialect)) {
    throw new Error('CLI dialect is invalid')
  }
  if (
    runtimeAdapterId.length < 1 ||
    runtimeAdapterId.length > 200 ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(runtimeAdapterId)
  ) {
    throw new Error('CLI runtime adapter id is invalid')
  }
  const builtInDialect =
    BUILT_IN_CLI_DIALECT_BY_ADAPTER_ID.get(runtimeAdapterId)
  if (builtInDialect !== undefined && builtInDialect !== dialect) {
    throw new Error('CLI runtime adapter does not match its CLI dialect')
  }
  return runtimeAdapterId
}

export const CLI_RUNTIME_SESSION_COMPATIBILITY_IDS: Readonly<
  Record<CliRuntimeSessionCompatibilityId, CliRuntimeSessionCompatibilityId>
> = Object.freeze({
  codex: BUILT_IN_CLI_RUNTIME_BINDINGS.codex.sessionCompatibilityId,
  claude: BUILT_IN_CLI_RUNTIME_BINDINGS.claude.sessionCompatibilityId,
  gemini: BUILT_IN_CLI_RUNTIME_BINDINGS.gemini.sessionCompatibilityId
})
