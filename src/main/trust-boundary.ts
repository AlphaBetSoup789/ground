import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  CliProvider,
  ProviderDraft,
  WorkspaceGrant
} from '../shared/types'
import { normalizeCliEnvironmentVariableNames } from './cli-environment'
import { createId } from './lib/ids'
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

export async function revealWorkspacePath(
  canonicalPath: string,
  openPath: (candidate: string) => Promise<string>
): Promise<void> {
  try {
    const error = await openPath(canonicalPath)
    if (error) throw new Error(error)
  } catch {
    throw new Error('Ground could not reveal this workspace')
  }
}

interface WorkspaceGrantRecord {
  canonicalPath: string
  name: string
  device: number
  inode: number
}

export interface WorkspaceDirectoryIdentity {
  canonicalPath: string
  device: number
  inode: number
}

export type WorkspaceDirectoryResolver = (
  candidate: string
) => Promise<WorkspaceDirectoryIdentity>

async function canonicalDirectory(candidate: string): Promise<string> {
  const canonical = await realpath(candidate)
  const details = await stat(canonical)
  if (!details.isDirectory()) throw new Error('Choose a directory')
  return canonical
}

async function resolveWorkspaceDirectory(
  candidate: string
): Promise<WorkspaceDirectoryIdentity> {
  const canonicalPath = await canonicalDirectory(candidate)
  const details = await stat(canonicalPath)
  return {
    canonicalPath,
    device: details.dev,
    inode: details.ino
  }
}

export class WorkspaceGrantRegistry {
  private readonly grantsById = new Map<string, WorkspaceGrantRecord>()
  private readonly grantIdsByPath = new Map<string, string>()
  private readonly issuedDisplayNames = new Set<string>()
  private readonly pendingGrantsByPath = new Map<
    string,
    Promise<WorkspaceGrant>
  >()

  constructor(
    private readonly resolveDirectory: WorkspaceDirectoryResolver =
      resolveWorkspaceDirectory
  ) {}

  async grant(candidate: string): Promise<WorkspaceGrant> {
    const identity = await this.resolveDirectory(candidate).catch(() => {
      throw unavailableWorkspaceGrant()
    })
    const canonical = identity.canonicalPath
    const existingId = this.grantIdsByPath.get(canonical)
    if (existingId) {
      const existing = this.grantsById.get(existingId)
      if (existing) {
        const stillAuthorized = await this.revalidate(existingId, existing)
          .then(() => true)
          .catch(() => false)
        if (stillAuthorized) {
          this.grantIdsByPath.set(path.resolve(candidate), existingId)
          return { id: existingId, name: existing.name }
        }
      }
    }
    const pending = this.pendingGrantsByPath.get(canonical)
    if (pending) {
      const grant = await pending
      this.grantIdsByPath.set(path.resolve(candidate), grant.id)
      return grant
    }
    const creation = this.createGrant(identity)
    this.pendingGrantsByPath.set(canonical, creation)
    try {
      const grant = await creation
      this.grantIdsByPath.set(path.resolve(candidate), grant.id)
      return grant
    } finally {
      if (this.pendingGrantsByPath.get(canonical) === creation) {
        this.pendingGrantsByPath.delete(canonical)
      }
    }
  }

  private async createGrant(
    identity: Readonly<WorkspaceDirectoryIdentity>
  ): Promise<WorkspaceGrant> {
    const canonical = identity.canonicalPath
    const id = createId('workspace')
    const name = this.issueDisplayName(workspaceDisplayName(canonical))
    this.grantsById.set(id, {
      canonicalPath: canonical,
      name,
      device: identity.device,
      inode: identity.inode
    })
    this.grantIdsByPath.set(canonical, id)
    return { id, name }
  }

  private issueDisplayName(basename: string): string {
    for (let ordinal = 1; ; ordinal += 1) {
      const candidate =
        ordinal === 1 ? basename : `${basename} · ${ordinal}`
      if (this.issuedDisplayNames.has(candidate)) continue
      this.issuedDisplayNames.add(candidate)
      return candidate
    }
  }

  async restore(candidates: Iterable<string | undefined>): Promise<void> {
    for (const candidate of candidates) {
      if (!candidate) continue
      await this.grant(candidate).catch(() => undefined)
    }
  }

  async require(grantId: string): Promise<string> {
    const record = this.grantsById.get(grantId)
    if (!record) throw unavailableWorkspaceGrant()
    return this.revalidate(grantId, record)
  }

  async requireStoredPath(storedPath: string): Promise<string> {
    if (
      typeof storedPath !== 'string' ||
      !path.isAbsolute(storedPath) ||
      storedPath.includes('\0')
    ) {
      throw unavailableWorkspaceGrant()
    }
    const canonicalCandidate = path.resolve(storedPath)
    const grantId = this.grantIdsByPath.get(canonicalCandidate)
    const record = grantId ? this.grantsById.get(grantId) : undefined
    if (!grantId || !record) throw unavailableWorkspaceGrant()
    return this.revalidate(grantId, record)
  }

  describeStoredPath(storedPath: string): WorkspaceGrant | undefined {
    if (
      typeof storedPath !== 'string' ||
      !path.isAbsolute(storedPath) ||
      storedPath.includes('\0')
    ) {
      return undefined
    }
    const grantId = this.grantIdsByPath.get(path.resolve(storedPath))
    const record = grantId ? this.grantsById.get(grantId) : undefined
    return grantId && record
      ? { id: grantId, name: record.name }
      : undefined
  }

  revoke(grantId: string): void {
    if (!this.grantsById.has(grantId)) return
    this.grantsById.delete(grantId)
    for (const [candidate, candidateGrantId] of this.grantIdsByPath) {
      if (candidateGrantId === grantId) {
        this.grantIdsByPath.delete(candidate)
      }
    }
  }

  private async revalidate(
    grantId: string,
    record: Readonly<WorkspaceGrantRecord>
  ): Promise<string> {
    try {
      const current = await this.resolveDirectory(record.canonicalPath)
      if (
        current.canonicalPath !== record.canonicalPath ||
        current.device !== record.device ||
        current.inode !== record.inode ||
        this.grantsById.get(grantId) !== record
      ) {
        throw unavailableWorkspaceGrant()
      }
      return current.canonicalPath
    } catch {
      this.revoke(grantId)
      throw unavailableWorkspaceGrant()
    }
  }
}

function unavailableWorkspaceGrant(): Error {
  return new Error(
    'Workspace access expired; choose this workspace through Ground again'
  )
}

function workspaceDisplayName(canonicalPath: string): string {
  const basename = path.basename(canonicalPath)
  const visible: string[] = []
  let visibleLength = 0
  for (const character of basename) {
    const safeCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)
      ? `\\u{${character.codePointAt(0)?.toString(16).padStart(4, '0')}}`
      : character
    const nextLength = [...safeCharacter].length
    if (visibleLength + nextLength > 140) break
    visible.push(safeCharacter)
    visibleLength += nextLength
  }
  return visible.join('').trim() || 'Workspace'
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
