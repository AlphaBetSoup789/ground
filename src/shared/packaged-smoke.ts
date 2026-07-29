export const PACKAGED_SMOKE_ARGUMENT_PREFIX = '--ground-packaged-smoke='
export const PACKAGED_SMOKE_PRELOAD_ARGUMENT_PREFIX =
  '--ground-packaged-smoke-preload='
export const PACKAGED_SMOKE_PRELOAD_CHANNEL =
  'ground:internal:packaged-smoke-preload-ready'

export type PackagedSmokeScope = 'launch' | 'native'

export interface PackagedSmokeArgument {
  token: string
  scope: PackagedSmokeScope
}

const TOKEN_PATTERN = /^[a-f0-9]{32}$/u

export function isPackagedSmokeToken(value: string): boolean {
  return TOKEN_PATTERN.test(value)
}

export function parsePackagedSmokeArgument(
  argumentsList: readonly string[]
): PackagedSmokeArgument | undefined {
  const matches = argumentsList.filter((argument) =>
    argument.startsWith(PACKAGED_SMOKE_ARGUMENT_PREFIX)
  )
  if (matches.length !== 1) return undefined
  const serialized = matches[0]?.slice(PACKAGED_SMOKE_ARGUMENT_PREFIX.length)
  const separator = serialized?.lastIndexOf(':') ?? -1
  if (!serialized || separator < 1) return undefined
  const token = serialized.slice(0, separator)
  const scope = serialized.slice(separator + 1)
  if (
    !isPackagedSmokeToken(token) ||
    (scope !== 'launch' && scope !== 'native')
  ) {
    return undefined
  }
  return { token, scope }
}

export function parsePackagedSmokePreloadToken(
  argumentsList: readonly string[]
): string | undefined {
  const matches = argumentsList.filter((argument) =>
    argument.startsWith(PACKAGED_SMOKE_PRELOAD_ARGUMENT_PREFIX)
  )
  if (matches.length !== 1) return undefined
  const token = matches[0]?.slice(
    PACKAGED_SMOKE_PRELOAD_ARGUMENT_PREFIX.length
  )
  return token && isPackagedSmokeToken(token) ? token : undefined
}
