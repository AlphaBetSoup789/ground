import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CliProvider, ProviderDraft } from '../shared/types'
import { normalizeCliEnvironmentVariableNames } from './cli-environment'
import {
  createProcessLaunchEnvelope,
  revalidateProcessLaunchEnvelope,
  type ProcessLaunchEnvelope
} from './process-launch'
import {
  resolveExecutable,
  type AuthorizedCliInvocation,
  type CliInvocationAuthorizationRequest,
  type CliPromptSummary
} from './providers/cli'

const LOOPBACK_NAMES = new Set(['localhost', '::1'])

export interface RendererTarget {
  kind: 'file' | 'url'
  value: string
}

export interface CliTrustRequest {
  phase: 'configuration' | 'invocation'
  launch: ProcessLaunchEnvelope
  args: readonly string[]
  promptMode: 'stdin' | 'argument'
  outputMode: 'plain' | 'ndjson'
  cliAdapter: 'generic' | 'codex' | 'claude' | 'gemini'
  environmentVariables: readonly string[]
  environmentFingerprint?: string
  cwd?: string
  prompt?: CliPromptSummary
  fingerprint: string
}

type CliLike = (
  | Pick<
      CliProvider,
      'command' | 'args' | 'promptMode' | 'outputMode' | 'cliAdapter'
    >
  | Pick<
      ProviderDraft,
      'command' | 'args' | 'promptMode' | 'outputMode' | 'cliAdapter'
    >
) & {
  environmentVariables?: readonly string[]
  environmentFingerprint?: string
}

type ConfirmCliTrust = (request: CliTrustRequest) => Promise<boolean>

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
}

export function isLiteralLoopbackUrl(url: URL): boolean {
  const hostname = normalizedHostname(url)
  if (LOOPBACK_NAMES.has(hostname)) return true
  return isIP(hostname) === 4 && hostname.startsWith('127.')
}

export function isLoopbackRendererUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    if (url.username || url.password) return false
    return isLiteralLoopbackUrl(url)
  } catch {
    return false
  }
}

export function resolveRendererTarget(
  isPackaged: boolean,
  developmentUrl: string | undefined,
  rendererFile: string
): RendererTarget {
  if (!isPackaged && developmentUrl) {
    if (!isLoopbackRendererUrl(developmentUrl)) {
      throw new Error('The development renderer URL must use HTTP(S) on a loopback address')
    }
    return {
      kind: 'url',
      value: new URL(developmentUrl).toString()
    }
  }
  return {
    kind: 'file',
    value: pathToFileURL(rendererFile).toString()
  }
}

export function isExpectedRendererUrl(actual: string, expected: string): boolean {
  try {
    const actualUrl = new URL(actual)
    const expectedUrl = new URL(expected)
    actualUrl.hash = ''
    expectedUrl.hash = ''
    return actualUrl.toString() === expectedUrl.toString()
  } catch {
    return false
  }
}

export function canonicalProviderEndpoint(candidate: string): string {
  const url = new URL(candidate)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Provider endpoints must use HTTP or HTTPS')
  }
  if (url.username || url.password) {
    throw new Error('Provider endpoints cannot include credentials')
  }
  if (url.search || url.hash) {
    throw new Error('Provider endpoints cannot include a query or fragment')
  }
  if (url.protocol === 'http:' && !isLiteralLoopbackUrl(url)) {
    throw new Error('Provider endpoints outside this computer must use HTTPS')
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${pathname}`
}

async function canonicalDirectory(candidate: string): Promise<string> {
  const canonical = await realpath(candidate)
  const details = await stat(canonical)
  if (!details.isDirectory()) throw new Error('Choose a directory')
  return canonical
}

export class WorkspaceGrantRegistry {
  private readonly grants = new Set<string>()

  async grant(candidate: string): Promise<string> {
    const canonical = await canonicalDirectory(candidate)
    this.grants.add(canonical)
    return canonical
  }

  async restore(candidates: Iterable<string | undefined>): Promise<void> {
    for (const candidate of candidates) {
      if (!candidate) continue
      await this.grant(candidate).catch(() => undefined)
    }
  }

  async require(candidate: string): Promise<string> {
    const canonical = await canonicalDirectory(candidate)
    if (!this.grants.has(canonical)) {
      throw new Error('Choose this workspace through Ground before using it')
    }
    return canonical
  }

  revoke(canonicalCandidate: string): void {
    if (
      typeof canonicalCandidate !== 'string' ||
      !path.isAbsolute(canonicalCandidate) ||
      canonicalCandidate.includes('\0')
    ) {
      throw new Error('Workspace grant must be an absolute canonical path')
    }
    this.grants.delete(path.resolve(canonicalCandidate))
  }
}

function validatedCliEnvironmentAuthorization(
  rawVariables: readonly string[] | undefined,
  rawFingerprint: string | undefined
): { variables: readonly string[]; fingerprint?: string } {
  const variables = normalizeCliEnvironmentVariableNames(rawVariables ?? [])
  if (!variables.length) {
    if (rawFingerprint !== undefined) {
      throw new Error('CLI environment fingerprint requires environment variables')
    }
    return { variables }
  }
  if (!rawFingerprint || !/^[a-f0-9]{64}$/u.test(rawFingerprint)) {
    throw new Error('CLI environment fingerprint is required and must be valid')
  }
  return { variables, fingerprint: rawFingerprint }
}

function cliConfigurationFingerprint(
  launch: ProcessLaunchEnvelope,
  args: readonly string[],
  promptMode: 'stdin' | 'argument',
  outputMode: 'plain' | 'ndjson',
  cliAdapter: 'generic' | 'codex' | 'claude' | 'gemini',
  environmentVariables: readonly string[],
  environmentFingerprint: string | undefined
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        phase: 'configuration',
        launchFingerprint: launch.fingerprint,
        args,
        promptMode,
        outputMode,
        cliAdapter,
        environmentVariables,
        environmentFingerprint
      })
    )
    .digest('hex')
}

function cliAuthorizedInvocationFingerprint(
  launch: ProcessLaunchEnvelope,
  input: CliInvocationAuthorizationRequest,
  cwd: string,
  cwdDetails: Awaited<ReturnType<typeof stat>>,
  environmentVariables: readonly string[],
  environmentFingerprint: string | undefined
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        phase: 'invocation',
        launchFingerprint: launch.fingerprint,
        invocationSha256: input.invocationSha256,
        cwd,
        cwdDevice: cwdDetails.dev,
        cwdInode: cwdDetails.ino,
        promptMode: input.promptMode,
        outputMode: input.outputMode,
        cliAdapter: input.cliAdapter,
        environmentVariables,
        environmentFingerprint
      })
    )
    .digest('hex')
}

export class CliTrustRegistry {
  private readonly grants = new Set<string>()
  private readonly pending = new Map<string, Promise<boolean>>()

  constructor(private readonly confirm: ConfirmCliTrust) {}

  private async requireDecision(request: CliTrustRequest): Promise<void> {
    if (this.grants.has(request.fingerprint)) return
    let decision = this.pending.get(request.fingerprint)
    if (!decision) {
      decision = this.confirm(request)
      this.pending.set(request.fingerprint, decision)
    }
    try {
      if (!(await decision)) throw new Error('CLI invocation was not authorized')
    } finally {
      this.pending.delete(request.fingerprint)
    }
  }

  async authorize(input: CliLike): Promise<string> {
    const command = input.command?.trim()
    if (!command) throw new Error('Executable is required')
    const resolved = await resolveExecutable(command)
    if (!resolved) throw new Error(`Executable not found: ${command}`)
    const launch = await createProcessLaunchEnvelope(resolved)

    const args = Object.freeze([...(input.args ?? [])])
    const promptMode = input.promptMode ?? 'stdin'
    const outputMode = input.outputMode ?? 'plain'
    const cliAdapter = input.cliAdapter ?? 'generic'
    const {
      variables: environmentVariables,
      fingerprint: environmentFingerprint
    } = validatedCliEnvironmentAuthorization(
      input.environmentVariables,
      input.environmentFingerprint
    )
    const fingerprint = cliConfigurationFingerprint(
      launch,
      args,
      promptMode,
      outputMode,
      cliAdapter,
      environmentVariables,
      environmentFingerprint
    )
    await this.requireDecision({
      phase: 'configuration',
      launch,
      args,
      promptMode,
      outputMode,
      cliAdapter,
      environmentVariables,
      ...(environmentFingerprint ? { environmentFingerprint } : {}),
      fingerprint
    })
    await revalidateProcessLaunchEnvelope(launch)
    this.grants.add(fingerprint)
    return launch.entry.path
  }

  async authorizeInvocation(
    input: CliInvocationAuthorizationRequest
  ): Promise<AuthorizedCliInvocation> {
    const command = input.command.trim()
    if (!command) throw new Error('Executable is required')
    if (!/^[a-f0-9]{64}$/.test(input.invocationSha256)) {
      throw new Error('CLI invocation digest is invalid')
    }
    if (
      input.displayArgs.some(
        (argument) => typeof argument !== 'string' || argument.includes('\0')
      )
    ) {
      throw new Error('CLI display arguments are invalid')
    }
    const {
      variables: environmentVariables,
      fingerprint: environmentFingerprint
    } = validatedCliEnvironmentAuthorization(
      input.environmentVariables,
      input.environmentFingerprint
    )

    const resolved = await resolveExecutable(command)
    if (!resolved) throw new Error(`Executable not found: ${command}`)
    const [launch, cwd] = await Promise.all([
      createProcessLaunchEnvelope(resolved),
      canonicalDirectory(input.cwd)
    ])
    const cwdDetails = await stat(cwd)
    const fingerprint = cliAuthorizedInvocationFingerprint(
      launch,
      input,
      cwd,
      cwdDetails,
      environmentVariables,
      environmentFingerprint
    )
    await this.requireDecision({
      phase: 'invocation',
      launch,
      args: Object.freeze([...input.displayArgs]),
      promptMode: input.promptMode,
      outputMode: input.outputMode,
      cliAdapter: input.cliAdapter,
      environmentVariables,
      ...(environmentFingerprint ? { environmentFingerprint } : {}),
      cwd,
      prompt: input.prompt,
      fingerprint
    })

    await revalidateProcessLaunchEnvelope(launch)
    const currentCwd = await canonicalDirectory(cwd)
    const currentCwdDetails = await stat(currentCwd)
    if (
      currentCwd !== cwd ||
      currentCwdDetails.dev !== cwdDetails.dev ||
      currentCwdDetails.ino !== cwdDetails.ino
    ) {
      throw new Error('CLI working directory changed during authorization')
    }
    this.grants.add(fingerprint)
    return Object.freeze({ launch, cwd })
  }
}
