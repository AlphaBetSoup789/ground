import { createHash } from 'node:crypto'
import { assertJsonObject, type JsonObject, type JsonValue } from './agent/json'
import type { McpExposedTool } from './mcp-service'
import {
  isFrozenProcessLaunchEnvelope,
  type LaunchFileIdentity
} from './process-launch'
import type { PreparedCommandAction, PreparedWriteAction } from './tools'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BINDING_SCHEMA = 'ground.prepared-action'

/**
 * Main-process-only MCP call envelope. It captures the exact trusted tool and
 * a detached, deeply frozen copy of the arguments before native approval.
 */
export interface PreparedMcpExecutionCall {
  readonly version: 1
  readonly namespacedName: string
  readonly serverId: string
  readonly connectionFingerprint: string
  readonly originalName: string
  readonly toolFingerprint: string
  readonly arguments: JsonObject
  readonly argumentsSha256: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function failIntegrity(): never {
  throw new Error('Prepared execution binding failed integrity validation')
}

function requireString(value: unknown): asserts value is string {
  if (typeof value !== 'string') failIntegrity()
}

function requireNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) failIntegrity()
}

function requireFiniteNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) failIntegrity()
}

function requireSha256(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) failIntegrity()
}

function canonicalJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) failIntegrity()
    return serialized
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const item = value[key]
      if (item === undefined) failIntegrity()
      return `${JSON.stringify(key)}:${canonicalJson(item)}`
    })
    .join(',')}}`
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreezeJson(item)
  }
  return Object.freeze(value) as JsonValue
}

function isDeeplyFrozenJson(value: JsonValue): boolean {
  if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
    return value === null || typeof value !== 'object'
  }
  return Array.isArray(value)
    ? value.every((item) => isDeeplyFrozenJson(item))
    : Object.values(value).every((item) => isDeeplyFrozenJson(item))
}

function canonicalArguments(input: unknown): {
  value: JsonObject
  json: string
  sha256: string
} {
  try {
    assertJsonObject(input, 'MCP arguments')
  } catch {
    failIntegrity()
  }
  const json = canonicalJson(input)
  const clone = JSON.parse(json) as unknown
  try {
    assertJsonObject(clone, 'MCP arguments')
  } catch {
    failIntegrity()
  }
  return {
    value: deepFreezeJson(clone) as JsonObject,
    json,
    sha256: sha256(json)
  }
}

function launchIdentityPayload(identity: Readonly<LaunchFileIdentity>): object {
  requireNonEmptyString(identity.path)
  requireSha256(identity.sha256)
  requireFiniteNumber(identity.size)
  requireFiniteNumber(identity.modifiedMs)
  requireFiniteNumber(identity.changedMs)
  requireFiniteNumber(identity.device)
  requireFiniteNumber(identity.inode)
  return {
    path: identity.path,
    sha256: identity.sha256,
    size: identity.size,
    modifiedMs: identity.modifiedMs,
    changedMs: identity.changedMs,
    device: identity.device,
    inode: identity.inode
  }
}

function writeActionPayload(action: Readonly<PreparedWriteAction>): object {
  if (
    !Object.isFrozen(action) ||
    action.version !== 1 ||
    action.previewStatus !== 'complete' ||
    typeof action.existed !== 'boolean'
  ) {
    failIntegrity()
  }
  requireNonEmptyString(action.workspaceRoot)
  requireNonEmptyString(action.relativePath)
  requireNonEmptyString(action.canonicalTarget)
  requireSha256(action.baseSha256)
  requireSha256(action.newContentSha256)
  requireString(action.newContent)
  requireFiniteNumber(action.fileMode)
  requireString(action.preview)
  if (sha256(action.newContent) !== action.newContentSha256) failIntegrity()

  return {
    version: action.version,
    workspaceRoot: action.workspaceRoot,
    relativePath: action.relativePath,
    canonicalTarget: action.canonicalTarget,
    existed: action.existed,
    baseSha256: action.baseSha256,
    newContentSha256: action.newContentSha256,
    newContent: action.newContent,
    fileMode: action.fileMode,
    preview: action.preview,
    previewStatus: action.previewStatus
  }
}

function commandActionPayload(action: Readonly<PreparedCommandAction>): object {
  if (
    !Object.isFrozen(action) ||
    !Object.isFrozen(action.args) ||
    action.version !== 1 ||
    action.previewStatus !== 'complete' ||
    !isFrozenProcessLaunchEnvelope(action.launch) ||
    action.launch.version !== 1
  ) {
    failIntegrity()
  }
  requireNonEmptyString(action.workspaceRoot)
  requireNonEmptyString(action.cwd)
  requireNonEmptyString(action.relativeCwd)
  requireNonEmptyString(action.executable)
  requireSha256(action.executableSha256)
  requireFiniteNumber(action.executableSize)
  requireFiniteNumber(action.executableModifiedMs)
  requireFiniteNumber(action.timeoutMs)
  requireString(action.preview)
  requireSha256(action.launch.fingerprint)
  if (
    action.args.some((argument) => typeof argument !== 'string') ||
    action.launch.argumentPrefix.some((argument) => typeof argument !== 'string')
  ) {
    failIntegrity()
  }

  const entry = launchIdentityPayload(action.launch.entry)
  const executable = launchIdentityPayload(action.launch.executable)
  const shim = action.launch.shim
    ? launchIdentityPayload(action.launch.shim)
    : null
  const script = action.launch.script
    ? launchIdentityPayload(action.launch.script)
    : null
  if (
    action.executable !== action.launch.executable.path ||
    action.executableSha256 !== action.launch.executable.sha256 ||
    action.executableSize !== action.launch.executable.size ||
    action.executableModifiedMs !== action.launch.executable.modifiedMs
  ) {
    failIntegrity()
  }

  return {
    version: action.version,
    workspaceRoot: action.workspaceRoot,
    cwd: action.cwd,
    relativeCwd: action.relativeCwd,
    launch: {
      version: action.launch.version,
      kind: action.launch.kind,
      entry,
      executable,
      argumentPrefix: [...action.launch.argumentPrefix],
      shim,
      script,
      fingerprint: action.launch.fingerprint
    },
    executable: action.executable,
    executableSha256: action.executableSha256,
    executableSize: action.executableSize,
    executableModifiedMs: action.executableModifiedMs,
    args: [...action.args],
    timeoutMs: action.timeoutMs,
    preview: action.preview,
    previewStatus: action.previewStatus
  }
}

function mcpActionPayload(call: Readonly<PreparedMcpExecutionCall>): object {
  if (!Object.isFrozen(call) || call.version !== 1) failIntegrity()
  requireNonEmptyString(call.namespacedName)
  requireNonEmptyString(call.serverId)
  requireSha256(call.connectionFingerprint)
  requireNonEmptyString(call.originalName)
  requireSha256(call.toolFingerprint)
  requireSha256(call.argumentsSha256)

  const preparedArguments = canonicalArguments(call.arguments)
  if (
    !isDeeplyFrozenJson(call.arguments) ||
    preparedArguments.sha256 !== call.argumentsSha256
  ) {
    failIntegrity()
  }
  return {
    version: call.version,
    namespacedName: call.namespacedName,
    serverId: call.serverId,
    connectionFingerprint: call.connectionFingerprint,
    originalName: call.originalName,
    toolFingerprint: call.toolFingerprint,
    argumentsSha256: call.argumentsSha256,
    argumentsJson: preparedArguments.json
  }
}

function actionFingerprint(
  kind: 'workspace-write' | 'command' | 'mcp',
  action: object
): string {
  return sha256(
    JSON.stringify({
      schema: BINDING_SCHEMA,
      version: 1,
      kind,
      action
    })
  )
}

export function fingerprintPreparedWriteAction(
  action: Readonly<PreparedWriteAction>
): string {
  return actionFingerprint('workspace-write', writeActionPayload(action))
}

export function fingerprintPreparedCommandAction(
  action: Readonly<PreparedCommandAction>
): string {
  return actionFingerprint('command', commandActionPayload(action))
}

export function prepareMcpExecutionCall(
  tool: Readonly<McpExposedTool>,
  input: unknown
): PreparedMcpExecutionCall {
  if (
    tool.metadata.source !== 'mcp' ||
    tool.metadata.approvalRequired !== true ||
    tool.metadata.trustStatus !== 'approved' ||
    tool.definition.name.length === 0 ||
    tool.metadata.serverId.length === 0 ||
    tool.metadata.originalName.length === 0 ||
    !SHA256_PATTERN.test(tool.metadata.connectionFingerprint) ||
    !SHA256_PATTERN.test(tool.metadata.fingerprint)
  ) {
    failIntegrity()
  }
  const preparedArguments = canonicalArguments(input)
  return Object.freeze({
    version: 1,
    namespacedName: tool.definition.name,
    serverId: tool.metadata.serverId,
    connectionFingerprint: tool.metadata.connectionFingerprint,
    originalName: tool.metadata.originalName,
    toolFingerprint: tool.metadata.fingerprint,
    arguments: preparedArguments.value,
    argumentsSha256: preparedArguments.sha256
  })
}

export function fingerprintPreparedMcpCall(
  call: Readonly<PreparedMcpExecutionCall>
): string {
  return actionFingerprint('mcp', mcpActionPayload(call))
}
