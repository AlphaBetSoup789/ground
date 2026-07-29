import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { access, open, realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import {
  MCP_APP_MIME_TYPE,
  createMCPClient,
  validateJSONRPCMessage,
  type CallToolResult,
  type JSONRPCMessage,
  type ListToolsResult,
  type MCPTransport
} from '@ai-sdk/mcp'
import { dynamicTool, jsonSchema, type ToolSet } from '@ai-sdk/provider-utils'
import { detectToolDrift, fingerprintTools } from 'ai'
import { assertJsonObject, type JsonObject, type JsonValue } from './agent/json'
import type { ToolDefinition } from './agent/types'
import { terminateProcessTree } from './process-tree'

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RESULT_BYTES = 512_000
const MAX_RESULT_BYTES = 2_000_000
const MAX_ARGUMENT_BYTES = 512_000
const MAX_SCHEMA_BYTES = 256_000
const MAX_STDIO_LINE_BYTES = 4_000_000
const MAX_STDIO_ARGUMENT_DISPLAY_BYTES = 32_000
const MAX_TOOLS_PER_SERVER = 512
const MAX_TOOL_PAGES = 100
const PROCESS_KILL_GRACE_MS = 500
const PROCESS_KILL_POLL_MS = 25
const CLIENT_CLOSE_TIMEOUT_MS = 2_000
const MAX_EXECUTABLE_HASH_BYTES = 256 * 1024 * 1024
const EXECUTABLE_HASH_CHUNK_BYTES = 64 * 1024
const EXECUTABLE_IDENTITY_ATTEMPTS = 2
const UNAVAILABLE_EXECUTABLE_IDENTITY = createHash('sha256')
  .update('ground:mcp:stdio-executable-unavailable:v1')
  .digest('hex')

const LOOPBACK_NAMES = new Set(['localhost', '::1'])
const BLOCKED_ENVIRONMENT_KEYS = new Set([
  'BASH_ENV',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ELECTRON_RUN_AS_NODE',
  'ENV',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'RUBYOPT'
])

export interface RemoteMcpServerConfig {
  id: string
  name: string
  namespace?: string
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  maxResultBytes?: number
}

export interface LocalStdioMcpServerConfig {
  id: string
  name: string
  namespace?: string
  transport: 'stdio'
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  maxResultBytes?: number
}

export type McpServerConfig = RemoteMcpServerConfig | LocalStdioMcpServerConfig

interface NormalizedMcpServerBase {
  id: string
  name: string
  namespace: string
  connectTimeoutMs: number
  requestTimeoutMs: number
  maxResultBytes: number
}

export interface NormalizedRemoteMcpServerConfig extends NormalizedMcpServerBase {
  transport: 'streamable-http'
  url: string
  headers: Record<string, string>
}

export interface NormalizedLocalStdioMcpServerConfig extends NormalizedMcpServerBase {
  transport: 'stdio'
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  executableIdentity: McpExecutableIdentity
}

export type NormalizedMcpServerConfig =
  | NormalizedRemoteMcpServerConfig
  | NormalizedLocalStdioMcpServerConfig

export type McpClientTransportDescriptor =
  | {
      type: 'http'
      url: string
      headers: Record<string, string>
      redirect: 'error'
    }
  | {
      type: 'stdio'
      command: string
      executableIdentity: McpExecutableIdentity
      args: string[]
      cwd: string
      env: Record<string, string>
      shell: false
    }

export interface McpClientLike {
  readonly serverInfo?: {
    name: string
    version: string
    title?: string
  }
  listTools(options?: {
    params?: { cursor?: string }
    options?: {
      signal?: AbortSignal
      timeout?: number
      maxTotalTimeout?: number
    }
  }): Promise<ListToolsResult>
  callTool(args: {
    name: string
    arguments?: Record<string, unknown>
    options?: {
      signal?: AbortSignal
      timeout?: number
      maxTotalTimeout?: number
    }
  }): Promise<CallToolResult>
  close(): Promise<void>
}

export interface McpClientFactoryInput {
  server: Readonly<NormalizedMcpServerConfig>
  transport: Readonly<McpClientTransportDescriptor>
  lifecycleSignal: AbortSignal
}

export type McpClientFactory = (
  input: McpClientFactoryInput
) => Promise<McpClientLike>

export interface McpExecutableIdentity {
  canonicalPath: string
  device: string
  inode: string
  mode: string
  size: string
  modifiedAtNs: string
  changedAtNs: string
  /**
   * Present for regular executables no larger than the bounded hashing limit.
   * Larger files retain path and metadata binding but omit a content hash.
   */
  sha256?: string
  fingerprint: string
}

export interface McpStdioLaunchTrustRequest {
  serverId: string
  serverName: string
  executable: string
  executableIdentity: McpExecutableIdentity
  args: string[]
  cwd: string
  environmentKeys: string[]
  invocationFingerprint: string
}

export type ConfirmMcpStdioLaunch = (
  request: Readonly<McpStdioLaunchTrustRequest>
) => Promise<boolean>

export type McpToolTrustStatus = 'approved' | 'pending' | 'changed'

export interface McpToolMetadata {
  source: 'mcp'
  approvalRequired: true
  serverId: string
  serverName: string
  originalName: string
  title?: string
  fingerprint: string
  trustStatus: McpToolTrustStatus
}

export interface McpExposedTool {
  definition: ToolDefinition
  metadata: McpToolMetadata
}

export interface McpToolDrift {
  added: string[]
  removed: string[]
  changed: string[]
}

export interface McpServerSnapshot {
  id: string
  name: string
  namespace: string
  transport: McpServerConfig['transport']
  resolvedExecutable?: string
  serverInfo?: {
    name: string
    version: string
    title?: string
  }
  tools: McpExposedTool[]
  fingerprints: Record<string, string>
  drift: McpToolDrift
}

export interface McpConnectOptions {
  trustedFingerprints?: Readonly<Record<string, string>>
  signal?: AbortSignal
}

export interface McpExecuteOptions {
  /**
   * MCP calls are denied unless the main-process approval flow explicitly sets
   * this for the exact call it is executing.
   */
  approvalGranted?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface McpToolExecutionResult {
  serverId: string
  toolName: string
  isError: boolean
  result: JsonValue
  truncated: boolean
  byteLength: number
}

export type McpServiceErrorCode =
  | 'aborted'
  | 'approval-required'
  | 'closed'
  | 'configuration'
  | 'connection'
  | 'not-found'
  | 'timeout'
  | 'tool-drift'

export class McpServiceError extends Error {
  readonly code: McpServiceErrorCode

  constructor(code: McpServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpServiceError'
    this.code = code
  }
}

interface InternalTool {
  namespacedName: string
  originalName: string
  title?: string
  schemaFingerprint: string
  fingerprint: string
  definition: ToolDefinition
}

interface Discovery {
  tools: Map<string, InternalTool>
  fingerprints: Record<string, string>
}

interface Connection {
  config: NormalizedMcpServerConfig
  client: McpClientLike
  lifecycle: AbortController
  discovery: Discovery
  trustedFingerprints: Record<string, string>
  executableDrift?: {
    expected: string
    observed?: string
  }
  refresh?: Promise<void>
}

interface PendingConnection {
  lifecycle: AbortController
  promise: Promise<McpServerSnapshot>
}

function configurationError(message: string, cause?: unknown): McpServiceError {
  return new McpServiceError(
    'configuration',
    message,
    cause === undefined ? undefined : { cause }
  )
}

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase()
}

export function isLoopbackMcpUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate)
    const hostname = normalizedHostname(url)
    if (LOOPBACK_NAMES.has(hostname)) return true
    return isIP(hostname) === 4 && hostname.startsWith('127.')
  } catch {
    return false
  }
}

export function validateRemoteMcpUrl(candidate: string): string {
  let url: URL
  try {
    url = new URL(candidate)
  } catch (error) {
    throw configurationError('MCP server URL is invalid', error)
  }
  if (url.username || url.password) {
    throw configurationError('MCP server URLs cannot contain credentials')
  }
  if (url.hash) {
    throw configurationError('MCP server URLs cannot contain fragments')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw configurationError('MCP servers must use HTTPS or loopback HTTP')
  }
  if (url.protocol === 'http:' && !isLoopbackMcpUrl(url.toString())) {
    throw configurationError('Cleartext MCP is allowed only on a loopback address')
  }
  return url.toString()
}

function validateIdentifier(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) {
    throw configurationError(`${label} must contain between 1 and 128 characters`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw configurationError(`${label} cannot contain control characters`)
  }
  return trimmed
}

function validateDuration(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const duration = value ?? fallback
  if (!Number.isInteger(duration) || duration < 250 || duration > 300_000) {
    throw configurationError(`${label} must be an integer from 250 to 300000`)
  }
  return duration
}

function validateResultLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_RESULT_BYTES
  if (!Number.isInteger(limit) || limit < 1_024 || limit > MAX_RESULT_BYTES) {
    throw configurationError(
      `maxResultBytes must be an integer from 1024 to ${MAX_RESULT_BYTES}`
    )
  }
  return limit
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = Object.create(null)
  const entries = Object.entries(headers ?? {})
  if (entries.length > 64) throw configurationError('MCP headers are limited to 64 entries')
  for (const [name, value] of entries) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) {
      throw configurationError(`Invalid MCP header name: ${name}`)
    }
    if (value.length > 16_384 || /[\r\n\u0000]/u.test(value)) {
      throw configurationError(`Invalid value for MCP header: ${name}`)
    }
    normalized[name] = value
  }
  return normalized
}

function executableCandidates(command: string): string[] {
  if (path.isAbsolute(command) || /[\\/]/u.test(command)) {
    return [path.resolve(command)]
  }
  const extensions =
    process.platform === 'win32' && path.extname(command) === ''
      ? ['.EXE', '.COM']
      : ['']
  const result: string[] = []
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      result.push(path.join(directory, `${command}${extension}`))
    }
  }
  return result
}

export function isDirectlySpawnableMcpExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return true
  const extension = path.win32.extname(candidate).toLowerCase()
  return extension === '.exe' || extension === '.com'
}

export async function resolveMcpExecutable(command: string): Promise<string> {
  const trimmed = command.trim()
  if (!trimmed) {
    throw configurationError('MCP stdio executable is required')
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw configurationError(
      'MCP stdio executable cannot contain control characters'
    )
  }
  if (trimmed.length > 8_192) {
    throw configurationError('MCP stdio executable path is too long')
  }
  for (const candidate of executableCandidates(trimmed)) {
    if (!isDirectlySpawnableMcpExecutable(candidate)) continue
    try {
      await access(candidate, constants.X_OK)
      const canonical = await realpath(candidate)
      if (/[\u0000-\u001f\u007f]/u.test(canonical)) {
        throw configurationError(
          'Resolved MCP stdio executable cannot contain control characters'
        )
      }
      if (!isDirectlySpawnableMcpExecutable(canonical)) continue
      const details = await stat(canonical)
      if (details.isFile()) return canonical
    } catch (error) {
      if (error instanceof McpServiceError) throw error
      // Continue searching.
    }
  }
  throw configurationError(`MCP stdio executable was not found: ${trimmed}`)
}

function sameExecutableMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function hashExecutable(
  handle: Awaited<ReturnType<typeof open>>,
  size: bigint
): Promise<string | undefined> {
  if (size > BigInt(MAX_EXECUTABLE_HASH_BYTES)) return undefined
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(EXECUTABLE_HASH_CHUNK_BYTES)
  let position = 0
  const expectedBytes = Number(size)
  while (position < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead === 0) {
      throw new Error('Executable changed while it was being fingerprinted')
    }
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

function executableIdentityFrom(
  canonicalPath: string,
  details: BigIntStats,
  sha256: string | undefined
): McpExecutableIdentity {
  const identityFields = {
    canonicalPath,
    device: details.dev.toString(),
    inode: details.ino.toString(),
    mode: details.mode.toString(),
    size: details.size.toString(),
    modifiedAtNs: details.mtimeNs.toString(),
    changedAtNs: details.ctimeNs.toString(),
    ...(sha256 ? { sha256 } : {})
  }
  return Object.freeze({
    ...identityFields,
    fingerprint: createHash('sha256')
      .update('ground:mcp:stdio-executable:v1\0')
      .update(JSON.stringify(identityFields))
      .digest('hex')
  })
}

/**
 * Resolves and fingerprints the executable in the main process. Content hashing
 * is streaming and bounded; executables above MAX_EXECUTABLE_HASH_BYTES retain a
 * conservative canonical-path and metadata identity.
 */
export async function resolveMcpExecutableIdentity(
  command: string
): Promise<McpExecutableIdentity> {
  let lastError: unknown
  for (let attempt = 0; attempt < EXECUTABLE_IDENTITY_ATTEMPTS; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const canonicalPath = await resolveMcpExecutable(command)
      await access(canonicalPath, constants.X_OK)
      handle = await open(canonicalPath, 'r')
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) {
        throw configurationError('MCP stdio executable is not a regular file')
      }
      const sha256 = await hashExecutable(handle, before.size)
      const afterHandle = await handle.stat({ bigint: true })
      const afterPath = await stat(canonicalPath, { bigint: true })
      const recanonicalized = await realpath(canonicalPath)
      if (
        recanonicalized !== canonicalPath ||
        !sameExecutableMetadata(before, afterHandle) ||
        !sameExecutableMetadata(afterHandle, afterPath)
      ) {
        throw new Error('Executable changed while it was being fingerprinted')
      }
      return executableIdentityFrom(canonicalPath, afterPath, sha256)
    } catch (error) {
      lastError = error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  if (lastError instanceof McpServiceError) throw lastError
  throw configurationError(
    'MCP stdio executable could not be fingerprinted consistently',
    lastError
  )
}

function metadataMatchesIdentity(
  canonicalPath: string,
  details: BigIntStats,
  expected: McpExecutableIdentity
): boolean {
  return (
    canonicalPath === expected.canonicalPath &&
    details.dev.toString() === expected.device &&
    details.ino.toString() === expected.inode &&
    details.mode.toString() === expected.mode &&
    details.size.toString() === expected.size &&
    details.mtimeNs.toString() === expected.modifiedAtNs &&
    details.ctimeNs.toString() === expected.changedAtNs
  )
}

async function revalidateMcpExecutableIdentity(
  command: string,
  expected: McpExecutableIdentity
): Promise<McpExecutableIdentity> {
  const canonicalPath = await resolveMcpExecutable(command)
  const details = await stat(canonicalPath, { bigint: true })
  if (!details.isFile()) {
    throw configurationError('MCP stdio executable is not a regular file')
  }
  if (metadataMatchesIdentity(canonicalPath, details, expected)) {
    return expected
  }
  // Metadata drift is uncommon and security-sensitive. Recompute the bounded
  // content identity so snapshots can show a deterministic changed fingerprint.
  return resolveMcpExecutableIdentity(command)
}

function validateEnvironmentOverrides(
  overrides: Record<string, string> | undefined
): Record<string, string> {
  const normalized: Record<string, string> = Object.create(null)
  const entries = Object.entries(overrides ?? {})
  if (entries.length > 64) {
    throw configurationError('MCP stdio environment is limited to 64 entries')
  }
  let totalBytes = 0
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw configurationError(`Invalid MCP environment variable name: ${name}`)
    }
    if (BLOCKED_ENVIRONMENT_KEYS.has(name.toUpperCase())) {
      throw configurationError(`MCP environment variable is not allowed: ${name}`)
    }
    if (value.includes('\u0000')) {
      throw configurationError(`MCP environment variable contains a null byte: ${name}`)
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    if (totalBytes > 128_000) {
      throw configurationError('MCP stdio environment is too large')
    }
    normalized[name] = value
  }
  return normalized
}

export function buildMinimalMcpEnvironment(
  executable: string,
  overrides?: Record<string, string>
): Record<string, string> {
  const environment: Record<string, string> = Object.create(null)
  const executableDirectory = path.dirname(executable)
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (systemRoot) environment.SystemRoot = systemRoot
    const comSpec = process.env.ComSpec ?? process.env.COMSPEC
    if (comSpec) environment.ComSpec = comSpec
    environment.PATH = [
      executableDirectory,
      systemRoot ? path.join(systemRoot, 'System32') : undefined
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter)
    environment.PATHEXT = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM'
    if (process.env.TEMP) environment.TEMP = process.env.TEMP
    if (process.env.TMP) environment.TMP = process.env.TMP
  } else {
    environment.PATH = [
      executableDirectory,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin'
    ].join(path.delimiter)
    environment.LANG = 'C.UTF-8'
  }
  environment.NO_COLOR = '1'
  Object.assign(environment, validateEnvironmentOverrides(overrides))
  return environment
}

function validateArgs(args: string[] | undefined): string[] {
  if ((args?.length ?? 0) > 128) {
    throw configurationError('MCP stdio is limited to 128 arguments')
  }
  const normalized = (args ?? []).map((argument) => {
    if (typeof argument !== 'string' || argument.length > 32_768 || argument.includes('\u0000')) {
      throw configurationError('MCP stdio arguments must be bounded strings without null bytes')
    }
    return argument
  })
  if (
    Buffer.byteLength(JSON.stringify(normalized)) >
    MAX_STDIO_ARGUMENT_DISPLAY_BYTES
  ) {
    throw configurationError(
      'MCP stdio arguments are too large for complete native confirmation'
    )
  }
  return normalized
}

async function normalizeWorkingDirectory(
  candidate: string | undefined,
  executable: string
): Promise<string> {
  if (!candidate) return path.dirname(executable)
  if (/[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw configurationError(
      'MCP stdio working directory cannot contain control characters'
    )
  }
  if (!path.isAbsolute(candidate)) {
    throw configurationError('MCP stdio working directory must be absolute')
  }
  try {
    const canonical = await realpath(candidate)
    if (/[\u0000-\u001f\u007f]/u.test(canonical)) {
      throw new Error('resolved path contains control characters')
    }
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error('not a directory')
    }
    return canonical
  } catch (error) {
    throw configurationError('MCP stdio working directory is invalid', error)
  }
}

export async function normalizeMcpServerConfig(
  config: McpServerConfig
): Promise<NormalizedMcpServerConfig> {
  const id = validateIdentifier(config.id, 'MCP server id')
  const name = validateIdentifier(config.name, 'MCP server name')
  const namespace = validateIdentifier(config.namespace ?? id, 'MCP namespace')
  const common: NormalizedMcpServerBase = {
    id,
    name,
    namespace,
    connectTimeoutMs: validateDuration(
      config.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs'
    ),
    requestTimeoutMs: validateDuration(
      config.requestTimeoutMs,
      DEFAULT_CALL_TIMEOUT_MS,
      'requestTimeoutMs'
    ),
    maxResultBytes: validateResultLimit(config.maxResultBytes)
  }

  if (config.transport === 'streamable-http') {
    return {
      ...common,
      transport: 'streamable-http',
      url: validateRemoteMcpUrl(config.url),
      headers: normalizeHeaders(config.headers)
    }
  }

  const executableIdentity = await resolveMcpExecutableIdentity(config.command)
  const executable = executableIdentity.canonicalPath
  return {
    ...common,
    transport: 'stdio',
    command: executable,
    args: validateArgs(config.args),
    cwd: await normalizeWorkingDirectory(config.cwd, executable),
    env: buildMinimalMcpEnvironment(executable, config.env),
    executableIdentity
  }
}

function descriptorFor(config: NormalizedMcpServerConfig): McpClientTransportDescriptor {
  if (config.transport === 'streamable-http') {
    return {
      type: 'http',
      url: config.url,
      headers: { ...config.headers },
      redirect: 'error'
    }
  }
  return {
    type: 'stdio',
    command: config.command,
    executableIdentity: structuredClone(config.executableIdentity),
    args: [...config.args],
    cwd: config.cwd,
    env: { ...config.env },
    shell: false
  }
}

function stdioInvocationFingerprint(
  config: NormalizedLocalStdioMcpServerConfig,
  executableIdentityFingerprint = config.executableIdentity.fingerprint
): string {
  return createHash('sha256')
    .update('ground:mcp:stdio-invocation:v1\0')
    .update(
      JSON.stringify({
        executableIdentity: executableIdentityFingerprint,
        args: config.args,
        cwd: config.cwd,
        environment: Object.entries(config.env).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      })
    )
    .digest('hex')
}

function boundStdioToolFingerprint(
  schemaFingerprint: string,
  invocationFingerprint: string
): string {
  return createHash('sha256')
    .update('ground:mcp:stdio-tool:v1\0')
    .update(invocationFingerprint)
    .update('\0')
    .update(schemaFingerprint)
    .digest('hex')
}

function bindDiscoveryToStdioInvocation(
  discovery: Discovery,
  invocationFingerprint: string
): void {
  const fingerprints: Record<string, string> = Object.create(null)
  for (const [name, tool] of discovery.tools) {
    const fingerprint = boundStdioToolFingerprint(
      tool.schemaFingerprint,
      invocationFingerprint
    )
    tool.fingerprint = fingerprint
    fingerprints[name] = fingerprint
  }
  discovery.fingerprints = fingerprints
}

function linkSignal(target: AbortController, source: AbortSignal | undefined): () => void {
  if (!source) return () => undefined
  const abort = (): void => {
    if (!target.signal.aborted) target.abort(source.reason)
  }
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

function abortError(reason: unknown, label: string): Error {
  if (reason instanceof Error) return reason
  return new McpServiceError('aborted', `${label} was aborted`)
}

async function awaitAbortable<T>(
  label: string,
  promise: Promise<T>,
  signals: Array<AbortSignal | undefined>
): Promise<T> {
  const active = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  )
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
  const aborted = new Promise<never>((_resolve, reject) => {
    for (const signal of active) {
      if (signal.aborted) {
        reject(abortError(signal.reason, label))
        return
      }
      const listener = (): void =>
        reject(abortError(signal.reason, label))
      listeners.push({ signal, listener })
      signal.addEventListener('abort', listener, { once: true })
    }
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    for (const { signal, listener } of listeners) {
      signal.removeEventListener('abort', listener)
    }
  }
}

async function runBounded<T>(
  label: string,
  timeoutMs: number,
  lifecycleSignal: AbortSignal,
  externalSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const unlinkLifecycle = linkSignal(controller, lifecycleSignal)
  const unlinkExternal = linkSignal(controller, externalSignal)
  const timer = setTimeout(() => {
    controller.abort(new McpServiceError('timeout', `${label} timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(abortError(controller.signal.reason, label))
      return
    }
    controller.signal.addEventListener(
      'abort',
      () => reject(abortError(controller.signal.reason, label)),
      { once: true }
    )
  })
  try {
    return await Promise.race([operation(controller.signal), aborted])
  } finally {
    clearTimeout(timer)
    unlinkLifecycle()
    unlinkExternal()
  }
}

async function closeClientBounded(
  client: McpClientLike,
  label: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = Promise.resolve().then(() => client.close())
  // A late close rejection remains handled if the timeout wins the race.
  void close.catch(() => undefined)
  try {
    await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new McpServiceError(
                'timeout',
                `${label} did not close within ${CLIENT_CLOSE_TIMEOUT_MS}ms`
              )
            ),
          CLIENT_CLOSE_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function settleConnectionBounded(
  connection: Promise<unknown>,
  label: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      connection.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new McpServiceError(
                'timeout',
                `${label} did not settle within ${CLIENT_CLOSE_TIMEOUT_MS}ms`
              )
            ),
          CLIENT_CLOSE_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class SecureStdioMcpTransport implements MCPTransport {
  private process?: ChildProcess
  private processGroupId?: number
  private stdoutBuffer = Buffer.alloc(0)
  private closing = false
  private closePromise?: Promise<void>
  private readonly lifecycleAbort: () => void

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(
    private readonly descriptor: Extract<McpClientTransportDescriptor, { type: 'stdio' }>,
    lifecycleSignal: AbortSignal
  ) {
    this.lifecycleAbort = () => {
      void this.close()
    }
    if (lifecycleSignal.aborted) this.lifecycleAbort()
    else lifecycleSignal.addEventListener('abort', this.lifecycleAbort, { once: true })
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('MCP stdio transport is already running')
    if (this.closing) throw new Error('MCP stdio transport is closed')
    const launchIdentity = await revalidateMcpExecutableIdentity(
      this.descriptor.command,
      this.descriptor.executableIdentity
    )
    if (
      launchIdentity.fingerprint !==
      this.descriptor.executableIdentity.fingerprint
    ) {
      throw new McpServiceError(
        'tool-drift',
        'MCP stdio executable changed immediately before launch'
      )
    }
    // close() may have raced the asynchronous identity check. Do not create a
    // child after its one-shot cleanup promise has already completed.
    if (this.closing) throw new Error('MCP stdio transport is closed')

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.descriptor.command, this.descriptor.args, {
        cwd: this.descriptor.cwd,
        env: this.descriptor.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // A detached POSIX child becomes a process-group leader so shutdown can
        // terminate helpers spawned by the MCP server without signaling Ground.
        detached: process.platform !== 'win32'
      })
      this.process = child
      if (process.platform !== 'win32' && child.pid) {
        this.processGroupId = child.pid
      }
      let started = false
      child.once('spawn', () => {
        started = true
        resolve()
      })
      child.once('error', (error) => {
        if (!started) reject(error)
        this.onerror?.(error)
      })
      child.once('close', () => {
        this.process = undefined
        this.stdoutBuffer = Buffer.alloc(0)
        if (!this.closing && this.processGroupId) void this.close()
        this.onclose?.()
      })
      child.stdout?.on('data', (chunk: Buffer | string) => {
        this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      child.stdout?.on('error', (error) => this.onerror?.(error))
      child.stdin?.on('error', (error) => this.onerror?.(error))
      // Stderr is intentionally drained but never surfaced to the model.
      child.stderr?.on('data', () => undefined)
      child.stderr?.on('error', (error) => this.onerror?.(error))
    })
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    if (this.stdoutBuffer.length > MAX_STDIO_LINE_BYTES && this.stdoutBuffer.indexOf(10) === -1) {
      this.onerror?.(new Error('MCP stdio server emitted an oversized protocol line'))
      void this.close()
      return
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(10)
      if (newline === -1) return
      const line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > MAX_STDIO_LINE_BYTES) {
        this.onerror?.(new Error('MCP stdio server emitted an oversized protocol line'))
        void this.close()
        return
      }
      try {
        this.onmessage?.(validateJSONRPCMessage(JSON.parse(line.toString('utf8'))))
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error('MCP stdio server emitted invalid JSON-RPC')
        )
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.process?.stdin
    if (!stdin || stdin.destroyed) throw new Error('MCP stdio transport is not connected')
    const serialized = `${JSON.stringify(message)}\n`
    if (stdin.write(serialized)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const cleanup = (): void => {
        stdin.removeListener('drain', onDrain)
        stdin.removeListener('error', onError)
      }
      stdin.once('drain', onDrain)
      stdin.once('error', onError)
    })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    const child = this.process
    const processGroupId = this.processGroupId
    if (!child && !processGroupId) return
    child?.stdin?.end()
    this.signalProcessTree(child, processGroupId, 'SIGTERM')
    const graceful = await this.waitForProcessTreeExit(
      child,
      processGroupId,
      PROCESS_KILL_GRACE_MS
    )
    if (!graceful) {
      this.signalProcessTree(child, processGroupId, 'SIGKILL')
      await this.waitForProcessTreeExit(
        child,
        processGroupId,
        PROCESS_KILL_GRACE_MS
      )
    }
    this.processGroupId = undefined
  }

  private signalProcessTree(
    child: ChildProcess | undefined,
    processGroupId: number | undefined,
    signal: NodeJS.Signals
  ): void {
    if (child) {
      terminateProcessTree(child, signal)
      return
    }
    if (processGroupId && process.platform !== 'win32') {
      try {
        process.kill(-processGroupId, signal)
      } catch {
        // The process group may already have exited.
      }
    }
  }

  private processTreeIsAlive(
    child: ChildProcess | undefined,
    processGroupId: number | undefined
  ): boolean {
    if (processGroupId && process.platform !== 'win32') {
      try {
        process.kill(-processGroupId, 0)
        return true
      } catch (error) {
        return !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ESRCH'
        )
      }
    }
    return Boolean(
      child &&
        child.exitCode === null &&
        child.signalCode === null
    )
  }

  private async waitForProcessTreeExit(
    child: ChildProcess | undefined,
    processGroupId: number | undefined,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.processTreeIsAlive(child, processGroupId)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(PROCESS_KILL_POLL_MS, remaining))
      )
    }
    return true
  }
}

function fetchWithLifecycle(lifecycleSignal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const unlinkLifecycle = linkSignal(controller, lifecycleSignal)
    const unlinkRequest = linkSignal(controller, init?.signal ?? undefined)
    try {
      return await fetch(input, {
        ...init,
        redirect: 'error',
        signal: controller.signal
      })
    } finally {
      unlinkLifecycle()
      unlinkRequest()
    }
  }
}

export const defaultMcpClientFactory: McpClientFactory = async ({
  transport,
  lifecycleSignal
}) => {
  const resolvedTransport =
    transport.type === 'stdio'
      ? new SecureStdioMcpTransport(transport, lifecycleSignal)
      : {
          ...transport,
          type: 'http' as const,
          fetch: fetchWithLifecycle(lifecycleSignal)
        }
  return createMCPClient({
    transport: resolvedTransport,
    clientName: 'ground',
    version: '0.1.0',
    capabilities: {},
    maxRetries: 0
  })
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function safeNameSegment(value: string, maxLength: number): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/gu, '_').replace(/_+/gu, '_')
  const usable = normalized || 'tool'
  if (usable === value && usable.length <= maxLength) return usable
  const prefix = usable.slice(0, Math.max(1, maxLength - 9))
  return `${prefix}_${shortHash(value)}`
}

export function namespaceMcpToolName(server: string, tool: string): string {
  return `mcp__${safeNameSegment(server, 23)}__${safeNameSegment(tool, 34)}`
}

function normalizeJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return null
  }
  if (depth > 100) return '[Maximum depth exceeded]'
  if (ancestors.has(value)) return '[Circular]'

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJsonValue(item, ancestors, depth + 1))
    }
    const record: JsonObject = Object.create(null)
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === '_meta') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) continue
      const child = descriptor.value
      if (
        key === 'mimeType' &&
        child === MCP_APP_MIME_TYPE
      ) {
        return {
          type: 'text',
          text: '[MCP Apps/UI content omitted by Ground]'
        }
      }
      record[key] = normalizeJsonValue(child, ancestors, depth + 1)
    }
    return record
  } finally {
    ancestors.delete(value)
  }
}

function normalizeSchema(value: unknown, toolName: string): JsonObject {
  const schema = normalizeJsonValue(value)
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new McpServiceError(
      'connection',
      `MCP tool ${toolName} supplied a non-object input schema`
    )
  }
  const serialized = JSON.stringify(schema)
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES) {
    throw new McpServiceError(
      'connection',
      `MCP tool ${toolName} supplied an oversized input schema`
    )
  }
  return schema
}

function buildFingerprintTools(tools: Iterable<InternalTool>): ToolSet {
  const result: Record<string, ReturnType<typeof dynamicTool>> = Object.create(null)
  for (const tool of tools) {
    result[tool.namespacedName] = dynamicTool({
      title: tool.title,
      description: tool.definition.description,
      inputSchema: jsonSchema(tool.definition.inputSchema as never),
      execute: async () => ({})
    })
  }
  return result as ToolSet
}

function normalizeFingerprintBaseline(
  fingerprints: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const normalized: Record<string, string> = Object.create(null)
  for (const [name, fingerprint] of Object.entries(fingerprints ?? {})) {
    if (!name || name.length > 256 || !fingerprint || fingerprint.length > 256) {
      throw configurationError('MCP tool fingerprint baseline is invalid')
    }
    normalized[name] = fingerprint
  }
  return normalized
}

function sameFingerprints(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftNames = Object.keys(left).sort()
  const rightNames = Object.keys(right).sort()
  return (
    leftNames.length === rightNames.length &&
    leftNames.every(
      (name, index) =>
        name === rightNames[index] && left[name] === right[name]
    )
  )
}

function toolStatus(
  name: string,
  fingerprint: string,
  baseline: Readonly<Record<string, string>>
): McpToolTrustStatus {
  if (!Object.hasOwn(baseline, name)) return 'pending'
  return baseline[name] === fingerprint ? 'approved' : 'changed'
}

function capResult(
  value: unknown,
  maxBytes: number
): Pick<McpToolExecutionResult, 'result' | 'truncated' | 'byteLength'> {
  const normalized = normalizeJsonValue(value)
  const serialized = JSON.stringify(normalized)
  const byteLength = Buffer.byteLength(serialized)
  if (byteLength <= maxBytes) {
    return {
      result: JSON.parse(serialized) as JsonValue,
      truncated: false,
      byteLength
    }
  }
  const previewBudget = Math.max(128, maxBytes - 512)
  const preview = Buffer.from(serialized).subarray(0, previewBudget).toString('utf8')
  return {
    result: {
      type: 'truncated-mcp-result',
      preview,
      originalByteLength: byteLength
    },
    truncated: true,
    byteLength
  }
}

function cloneTool(tool: McpExposedTool): McpExposedTool {
  return structuredClone(tool)
}

export class McpService {
  private readonly connections = new Map<string, Connection>()
  private readonly pendingConnections = new Map<string, PendingConnection>()
  private readonly trustStore = new Map<string, Record<string, string>>()
  private readonly stdioLaunchGrants = new Set<string>()
  private readonly pendingStdioLaunchGrants = new Map<string, Promise<boolean>>()
  private closed = false
  private closePromise?: Promise<void>

  constructor(
    private readonly clientFactory: McpClientFactory = defaultMcpClientFactory,
    private readonly confirmStdioLaunch?: ConfirmMcpStdioLaunch
  ) {}

  private async authorizeStdioLaunch(
    config: NormalizedLocalStdioMcpServerConfig,
    lifecycleSignal: AbortSignal,
    externalSignal?: AbortSignal
  ): Promise<void> {
    lifecycleSignal.throwIfAborted()
    externalSignal?.throwIfAborted()
    const invocationFingerprint = stdioInvocationFingerprint(config)
    if (this.stdioLaunchGrants.has(invocationFingerprint)) return
    const confirm = this.confirmStdioLaunch
    if (!confirm) {
      throw new McpServiceError(
        'approval-required',
        `MCP stdio launch requires native confirmation: ${config.name}`
      )
    }

    let decision = this.pendingStdioLaunchGrants.get(invocationFingerprint)
    if (!decision) {
      decision = Promise.resolve().then(() =>
        confirm({
          serverId: config.id,
          serverName: config.name,
          executable: config.command,
          executableIdentity: structuredClone(config.executableIdentity),
          args: [...config.args],
          cwd: config.cwd,
          environmentKeys: Object.keys(config.env).sort(),
          invocationFingerprint
        })
      )
      this.pendingStdioLaunchGrants.set(invocationFingerprint, decision)
      void decision
        .finally(() => {
          if (
            this.pendingStdioLaunchGrants.get(invocationFingerprint) ===
            decision
          ) {
            this.pendingStdioLaunchGrants.delete(invocationFingerprint)
          }
        })
        .catch(() => undefined)
    }

    const approved = await awaitAbortable(
      `Authorizing MCP stdio server ${config.name}`,
      decision,
      [lifecycleSignal, externalSignal]
    )
    if (approved !== true) {
      throw new McpServiceError(
        'approval-required',
        `MCP stdio launch was not authorized: ${config.name}`
      )
    }
    lifecycleSignal.throwIfAborted()
    externalSignal?.throwIfAborted()
    this.stdioLaunchGrants.add(invocationFingerprint)
  }

  private async assertNormalizedExecutableUnchanged(
    config: NormalizedLocalStdioMcpServerConfig,
    label: string
  ): Promise<void> {
    let current: McpExecutableIdentity
    try {
      current = await revalidateMcpExecutableIdentity(
        config.command,
        config.executableIdentity
      )
    } catch (error) {
      throw new McpServiceError(
        'tool-drift',
        `${label}: the MCP stdio executable could not be revalidated`,
        { cause: error }
      )
    }
    if (current.fingerprint !== config.executableIdentity.fingerprint) {
      throw new McpServiceError(
        'tool-drift',
        `${label}: the MCP stdio executable changed; authorize and reconnect before using it`
      )
    }
  }

  private markExecutableDrift(
    connection: Connection,
    observed?: McpExecutableIdentity
  ): void {
    if (connection.config.transport !== 'stdio') return
    connection.executableDrift = {
      expected: connection.config.executableIdentity.fingerprint,
      ...(observed ? { observed: observed.fingerprint } : {})
    }
    bindDiscoveryToStdioInvocation(
      connection.discovery,
      stdioInvocationFingerprint(
        connection.config,
        observed?.fingerprint ?? UNAVAILABLE_EXECUTABLE_IDENTITY
      )
    )
  }

  private async assertConnectionExecutableUnchanged(
    connection: Connection
  ): Promise<void> {
    if (connection.config.transport !== 'stdio') return
    let current: McpExecutableIdentity
    try {
      current = await revalidateMcpExecutableIdentity(
        connection.config.command,
        connection.config.executableIdentity
      )
    } catch (error) {
      this.markExecutableDrift(connection)
      throw new McpServiceError(
        'tool-drift',
        `MCP stdio executable could not be revalidated; reconnect and review ${connection.config.name}`,
        { cause: error }
      )
    }
    if (
      current.fingerprint !==
      connection.config.executableIdentity.fingerprint
    ) {
      this.markExecutableDrift(connection, current)
      throw new McpServiceError(
        'tool-drift',
        `MCP stdio executable changed; authorize, reconnect, and review ${connection.config.name}`
      )
    }
    if (connection.executableDrift) {
      bindDiscoveryToStdioInvocation(
        connection.discovery,
        stdioInvocationFingerprint(connection.config)
      )
      connection.executableDrift = undefined
    }
  }

  async connect(
    config: McpServerConfig,
    options: McpConnectOptions = {}
  ): Promise<McpServerSnapshot> {
    if (this.closed) throw new McpServiceError('closed', 'MCP service is closed')
    const id = validateIdentifier(config.id, 'MCP server id')
    if (this.connections.has(id) || this.pendingConnections.has(id)) {
      throw new McpServiceError('connection', `MCP server is already connected: ${id}`)
    }
    const lifecycle = new AbortController()
    const promise = this.connectInternal(config, options, lifecycle)
    this.pendingConnections.set(id, { lifecycle, promise })
    try {
      return await promise
    } finally {
      this.pendingConnections.delete(id)
    }
  }

  private async connectInternal(
    config: McpServerConfig,
    options: McpConnectOptions,
    lifecycle: AbortController
  ): Promise<McpServerSnapshot> {
    let client: McpClientLike | undefined
    try {
      const normalized = await normalizeMcpServerConfig(config)
      if (normalized.transport === 'stdio') {
        await this.authorizeStdioLaunch(
          normalized,
          lifecycle.signal,
          options.signal
        )
        // Confirmation can remain open indefinitely. Re-resolve immediately
        // afterward so the approved bytes and metadata are still the launch target.
        await this.assertNormalizedExecutableUnchanged(
          normalized,
          `Connecting to MCP server ${normalized.name}`
        )
      }
      lifecycle.signal.throwIfAborted()
      options.signal?.throwIfAborted()
      const factoryPromise = this.clientFactory({
        server: normalized,
        transport: descriptorFor(normalized),
        lifecycleSignal: lifecycle.signal
      })
      void factoryPromise
        .then((lateClient) => {
          if (lifecycle.signal.aborted) {
            return closeClientBounded(
              lateClient,
              `MCP server ${normalized.name}`
            ).catch(() => undefined)
          }
          return undefined
        })
        .catch(() => undefined)
      client = await runBounded(
        `Connecting to MCP server ${normalized.name}`,
        normalized.connectTimeoutMs,
        lifecycle.signal,
        options.signal,
        async () => factoryPromise
      )
      if (normalized.transport === 'stdio') {
        await this.assertNormalizedExecutableUnchanged(
          normalized,
          `Connected MCP server ${normalized.name}`
        )
      }
      const trustedFingerprints = normalizeFingerprintBaseline(
        options.trustedFingerprints ?? this.trustStore.get(normalized.id)
      )
      const discovery = await this.discover(
        normalized,
        client,
        lifecycle.signal,
        options.signal
      )
      if (normalized.transport === 'stdio') {
        await this.assertNormalizedExecutableUnchanged(
          normalized,
          `Discovering tools from MCP server ${normalized.name}`
        )
      }
      this.assertNoGlobalCollisions(normalized.id, discovery)
      const connection: Connection = {
        config: normalized,
        client,
        lifecycle,
        discovery,
        trustedFingerprints
      }
      this.connections.set(normalized.id, connection)
      if (options.trustedFingerprints) {
        this.trustStore.set(normalized.id, { ...trustedFingerprints })
      }
      return this.snapshot(connection)
    } catch (error) {
      lifecycle.abort(error)
      if (client) {
        await closeClientBounded(client, `MCP server ${config.name}`).catch(
          () => undefined
        )
      }
      if (error instanceof McpServiceError) throw error
      throw new McpServiceError('connection', 'Could not connect to MCP server', {
        cause: error
      })
    }
  }

  private async discover(
    config: NormalizedMcpServerConfig,
    client: McpClientLike,
    lifecycleSignal: AbortSignal,
    externalSignal?: AbortSignal
  ): Promise<Discovery> {
    const rawTools: ListToolsResult['tools'] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await runBounded(
        `Listing MCP tools from ${config.name}`,
        config.connectTimeoutMs,
        lifecycleSignal,
        externalSignal,
        (signal) =>
          client.listTools({
            params: cursor ? { cursor } : undefined,
            options: {
              signal,
              timeout: config.connectTimeoutMs,
              maxTotalTimeout: config.connectTimeoutMs
            }
          })
      )
      rawTools.push(...result.tools)
      if (rawTools.length > MAX_TOOLS_PER_SERVER) {
        throw new McpServiceError(
          'connection',
          `MCP server ${config.name} exposes more than ${MAX_TOOLS_PER_SERVER} tools`
        )
      }
      cursor = result.nextCursor
      if (!cursor) break
      if (seenCursors.has(cursor)) {
        throw new McpServiceError(
          'connection',
          `MCP server ${config.name} repeated a pagination cursor`
        )
      }
      seenCursors.add(cursor)
      if (page === MAX_TOOL_PAGES - 1) {
        throw new McpServiceError(
          'connection',
          `MCP server ${config.name} exceeded the tool pagination limit`
        )
      }
    }

    const tools = new Map<string, InternalTool>()
    const originalNames = new Set<string>()
    for (const raw of rawTools) {
      const originalName = validateIdentifier(raw.name, 'MCP tool name')
      if (originalNames.has(originalName)) {
        throw new McpServiceError(
          'connection',
          `MCP server ${config.name} returned duplicate tool ${originalName}`
        )
      }
      originalNames.add(originalName)
      const namespacedName = namespaceMcpToolName(config.namespace, originalName)
      if (tools.has(namespacedName)) {
        throw new McpServiceError(
          'connection',
          `MCP tools collide after namespacing: ${namespacedName}`
        )
      }
      const description = (raw.description ?? `Tool from MCP server ${config.name}`).slice(
        0,
        32_000
      )
      const title = (raw.title ?? raw.annotations?.title)?.slice(0, 1_024)
      tools.set(namespacedName, {
        namespacedName,
        originalName,
        title,
        schemaFingerprint: '',
        fingerprint: '',
        definition: {
          name: namespacedName,
          description,
          inputSchema: normalizeSchema(raw.inputSchema, originalName)
        }
      })
    }
    const schemaFingerprints = await fingerprintTools(
      buildFingerprintTools(tools.values())
    )
    const fingerprints: Record<string, string> = Object.create(null)
    for (const [name, tool] of tools) {
      const schemaFingerprint = schemaFingerprints[name]
      if (!schemaFingerprint) {
        throw new McpServiceError('connection', `Could not fingerprint MCP tool ${name}`)
      }
      const fingerprint =
        config.transport === 'stdio'
          ? boundStdioToolFingerprint(
              schemaFingerprint,
              stdioInvocationFingerprint(config)
            )
          : schemaFingerprint
      tool.schemaFingerprint = schemaFingerprint
      tool.fingerprint = fingerprint
      fingerprints[name] = fingerprint
    }
    return { tools, fingerprints }
  }

  private assertNoGlobalCollisions(serverId: string, discovery: Discovery): void {
    for (const name of discovery.tools.keys()) {
      for (const [otherId, connection] of this.connections) {
        if (otherId !== serverId && connection.discovery.tools.has(name)) {
          throw new McpServiceError(
            'connection',
            `MCP tool name collides with server ${otherId}: ${name}`
          )
        }
      }
    }
  }

  private requireConnection(serverId: string): Connection {
    const connection = this.connections.get(serverId)
    if (!connection) {
      throw new McpServiceError('not-found', `MCP server is not connected: ${serverId}`)
    }
    return connection
  }

  private async refreshConnection(
    connection: Connection,
    signal?: AbortSignal
  ): Promise<void> {
    if (!connection.refresh) {
      connection.refresh = (async () => {
        await this.assertConnectionExecutableUnchanged(connection)
        const next = await this.discover(
          connection.config,
          connection.client,
          connection.lifecycle.signal,
          signal
        )
        await this.assertConnectionExecutableUnchanged(connection)
        this.assertNoGlobalCollisions(connection.config.id, next)
        connection.discovery = next
      })().finally(() => {
        connection.refresh = undefined
      })
    }
    await connection.refresh
  }

  async refreshServer(serverId: string, signal?: AbortSignal): Promise<McpServerSnapshot> {
    const connection = this.requireConnection(serverId)
    await this.refreshConnection(connection, signal)
    return this.snapshot(connection)
  }

  async trustToolDefinitions(
    serverId: string,
    expectedFingerprints: Readonly<Record<string, string>>,
    signal?: AbortSignal
  ): Promise<McpServerSnapshot> {
    const connection = this.requireConnection(serverId)
    const expected = normalizeFingerprintBaseline(expectedFingerprints)
    await this.refreshConnection(connection, signal)
    if (!sameFingerprints(expected, connection.discovery.fingerprints)) {
      throw new McpServiceError(
        'tool-drift',
        'MCP tool definitions changed while approval was pending; review them again'
      )
    }
    connection.trustedFingerprints = { ...connection.discovery.fingerprints }
    this.trustStore.set(serverId, { ...connection.trustedFingerprints })
    return this.snapshot(connection)
  }

  getTrustedFingerprints(serverId: string): Record<string, string> {
    const connection = this.connections.get(serverId)
    const fingerprints = connection?.trustedFingerprints ?? this.trustStore.get(serverId) ?? {}
    return { ...fingerprints }
  }

  forgetTrust(serverId: string): void {
    this.trustStore.delete(serverId)
    const connection = this.connections.get(serverId)
    if (connection) connection.trustedFingerprints = {}
  }

  inspectServer(serverId: string): McpServerSnapshot {
    return this.snapshot(this.requireConnection(serverId))
  }

  listServers(): McpServerSnapshot[] {
    return [...this.connections.values()].map((connection) => this.snapshot(connection))
  }

  /**
   * Returns only definition-trusted tools. Every returned tool still has
   * approvalRequired=true and executeTool denies calls without explicit approval.
   */
  listTools(): McpExposedTool[] {
    return this.listServers()
      .flatMap((server) => server.tools)
      .filter((tool) => tool.metadata.trustStatus === 'approved')
      .map(cloneTool)
  }

  private snapshot(connection: Connection): McpServerSnapshot {
    const drift = detectToolDrift(
      connection.discovery.fingerprints,
      connection.trustedFingerprints
    )
    const tools = [...connection.discovery.tools.values()]
      .map<McpExposedTool>((tool) => ({
        definition: structuredClone(tool.definition),
        metadata: {
          source: 'mcp',
          approvalRequired: true,
          serverId: connection.config.id,
          serverName: connection.config.name,
          originalName: tool.originalName,
          ...(tool.title ? { title: tool.title } : {}),
          fingerprint: tool.fingerprint,
          trustStatus: toolStatus(
            tool.namespacedName,
            tool.fingerprint,
            connection.trustedFingerprints
          )
        }
      }))
      .sort((left, right) => left.definition.name.localeCompare(right.definition.name))
    return {
      id: connection.config.id,
      name: connection.config.name,
      namespace: connection.config.namespace,
      transport: connection.config.transport,
      ...(connection.config.transport === 'stdio'
        ? { resolvedExecutable: connection.config.command }
        : {}),
      ...(connection.client.serverInfo
        ? { serverInfo: structuredClone(connection.client.serverInfo) }
        : {}),
      tools,
      fingerprints: { ...connection.discovery.fingerprints },
      drift: {
        added: [...drift.added],
        removed: [...drift.removed],
        changed: [...drift.changed]
      }
    }
  }

  async executeTool(
    namespacedName: string,
    input: unknown,
    options: McpExecuteOptions = {}
  ): Promise<McpToolExecutionResult> {
    if (!options.approvalGranted) {
      throw new McpServiceError(
        'approval-required',
        `MCP tool calls require approval: ${namespacedName}`
      )
    }
    assertJsonObject(input, 'MCP tool arguments')
    const serializedInput = JSON.stringify(input)
    if (Buffer.byteLength(serializedInput) > MAX_ARGUMENT_BYTES) {
      throw configurationError('MCP tool arguments are too large')
    }
    const safeInput = JSON.parse(serializedInput) as JsonObject
    let connection: Connection | undefined
    for (const candidate of this.connections.values()) {
      if (candidate.discovery.tools.has(namespacedName)) {
        connection = candidate
        break
      }
    }
    if (!connection) {
      throw new McpServiceError('not-found', `MCP tool was not found: ${namespacedName}`)
    }

    await this.refreshConnection(connection, options.signal)
    const tool = connection.discovery.tools.get(namespacedName)
    if (!tool) {
      throw new McpServiceError(
        'tool-drift',
        `MCP tool was removed after it was listed: ${namespacedName}`
      )
    }
    if (
      connection.trustedFingerprints[namespacedName] !== tool.fingerprint
    ) {
      throw new McpServiceError(
        'tool-drift',
        `MCP tool definition is new or changed and must be approved: ${namespacedName}`
      )
    }

    const timeoutMs = validateDuration(
      options.timeoutMs,
      connection.config.requestTimeoutMs,
      'MCP call timeout'
    )
    // Refresh already revalidates stdio identity around discovery. Check once
    // more at the dispatch boundary so a replaced executable invalidates trust
    // even when its advertised schemas are byte-for-byte identical.
    await this.assertConnectionExecutableUnchanged(connection)
    const rawResult = await runBounded(
      `MCP tool ${namespacedName}`,
      timeoutMs,
      connection.lifecycle.signal,
      options.signal,
      (signal) =>
        connection.client.callTool({
          name: tool.originalName,
          arguments: safeInput,
          options: {
            signal,
            timeout: timeoutMs,
            maxTotalTimeout: timeoutMs
          }
        })
    )
    const capped = capResult(rawResult, connection.config.maxResultBytes)
    return {
      serverId: connection.config.id,
      toolName: namespacedName,
      isError: rawResult.isError === true,
      ...capped
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const pending = this.pendingConnections.get(serverId)
    pending?.lifecycle.abort(
      new McpServiceError('aborted', `MCP connection was closed: ${serverId}`)
    )
    const connection = this.connections.get(serverId)
    if (!connection) {
      if (pending) {
        await settleConnectionBounded(
          pending.promise,
          `Pending MCP connection ${serverId}`
        ).catch(() => undefined)
      }
      return
    }
    this.connections.delete(serverId)
    connection.lifecycle.abort(
      new McpServiceError('aborted', `MCP connection was closed: ${serverId}`)
    )
    await closeClientBounded(
      connection.client,
      `MCP server ${connection.config.name}`
    )
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    const pending = [...this.pendingConnections.values()]
    for (const item of pending) {
      item.lifecycle.abort(new McpServiceError('closed', 'MCP service is shutting down'))
    }
    const connections = [...this.connections.values()]
    this.connections.clear()
    for (const connection of connections) {
      connection.lifecycle.abort(
        new McpServiceError('closed', 'MCP service is shutting down')
      )
    }
    await Promise.allSettled([
      ...connections.map((connection) =>
        closeClientBounded(
          connection.client,
          `MCP server ${connection.config.name}`
        )
      ),
      ...pending.map((item) =>
        settleConnectionBounded(item.promise, 'Pending MCP connection')
      )
    ])
  }
}
