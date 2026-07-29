import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  AppSnapshot,
  McpServerDraft,
  McpServerProfile,
  McpServerStatus
} from '../shared/types'
import { createId, nowIso } from './lib/ids'
import { StatePersistenceError } from './store'
import {
  McpService,
  McpServiceError,
  validateRemoteMcpUrl,
  type ConfirmMcpStdioLaunch,
  type McpConnectOptions,
  type McpExecuteOptions,
  type McpExposedTool,
  type McpServerConfig,
  type McpServerSnapshot,
  type McpToolExecutionResult
} from './mcp-service'

const DEFAULT_STARTUP_CONCURRENCY = 4
const MANAGER_CLOSE_TIMEOUT_MS = 2_500
const EMPTY_DRIFT = Object.freeze({
  added: [] as string[],
  removed: [] as string[],
  changed: [] as string[]
})

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: 'Control characters are not allowed'
  })
const displayName = identifier
const optionalNamespace = z
  .string()
  .max(128)
  .transform((value) => value.trim())
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: 'Control characters are not allowed'
  })
  .optional()
const argument = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes('\u0000'), {
    message: 'Arguments cannot contain null bytes'
  })

const remoteDraftSchema = z
  .object({
    id: identifier.optional(),
    name: displayName,
    namespace: optionalNamespace,
    enabled: z.boolean().optional(),
    transport: z.literal('streamable-http'),
    url: z.string().trim().min(1).max(2_000)
  })
  .strict()

const stdioDraftSchema = z
  .object({
    id: identifier.optional(),
    name: displayName,
    namespace: optionalNamespace,
    enabled: z.boolean().optional(),
    transport: z.literal('stdio'),
    command: z
      .string()
      .trim()
      .min(1)
      .max(8_192)
      .refine((value) => !value.includes('\u0000'), {
        message: 'Executable cannot contain null bytes'
      }),
    args: z.array(argument).max(128).optional()
  })
  .strict()

const draftSchema = z.discriminatedUnion('transport', [
  remoteDraftSchema,
  stdioDraftSchema
])

const fingerprintsSchema = z
  .record(z.string().min(1).max(200), z.string().regex(/^[a-f0-9]{64}$/u))
  .refine((value) => Object.keys(value).length <= 1_000, {
    message: 'Too many MCP tool fingerprints'
  })

export interface McpManagerStore {
  snapshot(): Pick<AppSnapshot, 'mcpServers'>
  getMcpServer(serverId: string): McpServerProfile
  saveMcpServer(server: McpServerProfile): Promise<McpServerProfile>
  deleteMcpServer(serverId: string): Promise<void>
}

export interface McpServiceCoordinator {
  connect(
    config: McpServerConfig,
    options?: McpConnectOptions
  ): Promise<McpServerSnapshot>
  refreshServer(serverId: string, signal?: AbortSignal): Promise<McpServerSnapshot>
  trustToolDefinitions(
    serverId: string,
    expectedFingerprints: Readonly<Record<string, string>>,
    signal?: AbortSignal
  ): Promise<McpServerSnapshot>
  inspectServer(serverId: string): McpServerSnapshot
  listServers(): McpServerSnapshot[]
  listTools(): McpExposedTool[]
  getTrustedFingerprints(serverId: string): Record<string, string>
  forgetTrust(serverId: string): void
  executeTool(
    namespacedName: string,
    input: unknown,
    options?: McpExecuteOptions,
    assertDispatchAuthorized?: () => void
  ): Promise<McpToolExecutionResult>
  disconnect(serverId: string): Promise<void>
  close(): Promise<void>
}

export interface McpManagerOptions {
  startupConcurrency?: number
  now?: () => string
  createServerId?: () => string
  /**
   * Main-owned native confirmation. Without it, stdio profiles can be saved
   * but their first process launch is denied.
   */
  confirmStdioLaunch?: ConfirmMcpStdioLaunch
}

interface RuntimeStatus {
  connection: McpServerStatus['connection']
  snapshot?: McpServerSnapshot
  error?: string
}

function parseError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 2_000)
  }
  return 'Unknown MCP error'
}

function validateStartupConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_STARTUP_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new TypeError('MCP startup concurrency must be an integer from 1 to 16')
  }
  return concurrency
}

function defaultNamespace(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 128)
  return normalized || 'server'
}

function normalizeNamespace(
  draft: McpServerDraft,
  existing: McpServerProfile | undefined
): string {
  return draft.namespace?.trim() || existing?.namespace || defaultNamespace(draft.name)
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function trustSensitiveConfigurationChanged(
  existing: McpServerProfile,
  next: McpServerProfile
): boolean {
  if (existing.namespace !== next.namespace || existing.transport !== next.transport) {
    return true
  }
  if (
    existing.transport === 'streamable-http' &&
    next.transport === 'streamable-http'
  ) {
    return existing.url !== next.url
  }
  if (existing.transport === 'stdio' && next.transport === 'stdio') {
    return (
      existing.command !== next.command ||
      !arraysEqual(existing.args, next.args)
    )
  }
  return true
}

function runtimeConfigurationChanged(
  existing: McpServerProfile,
  next: McpServerProfile
): boolean {
  return (
    existing.name !== next.name ||
    trustSensitiveConfigurationChanged(existing, next)
  )
}

function profileToConfig(profile: McpServerProfile): McpServerConfig {
  const common = {
    id: profile.id,
    name: profile.name,
    namespace: profile.namespace
  }
  if (profile.transport === 'streamable-http') {
    return {
      ...common,
      transport: 'streamable-http',
      url: profile.url
    }
  }
  return {
    ...common,
    transport: 'stdio',
    command: profile.command,
    args: [...profile.args]
  }
}

function cloneFingerprints(
  fingerprints: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(Object.entries(fingerprints))
}

/**
 * Binds a live connection to the exact persisted profile that authorized it.
 * Timestamps are included so disabling and later recreating an otherwise
 * byte-identical profile cannot silently revive an old process connection.
 */
function profileRuntimeIdentity(profile: McpServerProfile): string {
  const common = {
    id: profile.id,
    name: profile.name,
    namespace: profile.namespace,
    enabled: profile.enabled,
    trustedFingerprints: Object.entries(profile.trustedFingerprints).sort(
      ([left], [right]) => left.localeCompare(right)
    ),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
  const identity =
    profile.transport === 'streamable-http'
      ? {
          ...common,
          transport: profile.transport,
          url: profile.url
        }
      : {
          ...common,
          transport: profile.transport,
          command: profile.command,
          args: [...profile.args]
        }
  return createHash('sha256')
    .update('ground:mcp:persisted-profile:v1\0')
    .update(JSON.stringify(identity))
    .digest('hex')
}

async function settleManagerOperationsBounded(
  operations: ReadonlyArray<Promise<void>>
): Promise<void> {
  if (operations.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(operations).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MANAGER_CLOSE_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function validateMcpServerDraft(value: unknown): McpServerDraft {
  const parsed = draftSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new TypeError(
      `Invalid MCP server configuration: ${issue?.message ?? 'unknown validation error'}`
    )
  }
  if (parsed.data.transport === 'streamable-http') {
    return {
      ...parsed.data,
      namespace: parsed.data.namespace || undefined,
      url: validateRemoteMcpUrl(parsed.data.url)
    }
  }
  return {
    ...parsed.data,
    namespace: parsed.data.namespace || undefined,
    args: [...(parsed.data.args ?? [])]
  }
}

export class McpManager {
  private readonly service: McpServiceCoordinator
  private readonly startupConcurrency: number
  private readonly clock: () => string
  private readonly createServerId: () => string
  private readonly runtime = new Map<string, RuntimeStatus>()
  private readonly connectedProfileIdentities = new Map<string, string>()
  private readonly operations = new Map<string, Promise<void>>()
  private initialization?: Promise<McpServerStatus[]>
  private closed = false
  private closePromise?: Promise<void>

  constructor(
    private readonly store: McpManagerStore,
    service: McpServiceCoordinator | undefined = undefined,
    options: McpManagerOptions = {}
  ) {
    this.service =
      service ??
      new McpService(undefined, options.confirmStdioLaunch)
    this.startupConcurrency = validateStartupConcurrency(
      options.startupConcurrency
    )
    this.clock = options.now ?? nowIso
    this.createServerId = options.createServerId ?? (() => createId('mcp'))
  }

  initialize(): Promise<McpServerStatus[]> {
    this.requireOpen()
    if (!this.initialization) {
      this.initialization = this.initializeInternal().catch((error) => {
        this.initialization = undefined
        throw error
      })
    }
    return this.initialization
  }

  private async initializeInternal(): Promise<McpServerStatus[]> {
    const profiles = this.store.snapshot().mcpServers
    for (const profile of profiles) {
      if (!this.runtime.has(profile.id)) {
        this.runtime.set(profile.id, { connection: 'disconnected' })
      }
    }
    const enabled = profiles.filter((profile) => profile.enabled)
    const remote = enabled.filter(
      (profile) => profile.transport === 'streamable-http'
    )
    const local = enabled.filter((profile) => profile.transport === 'stdio')
    await Promise.all([
      this.connectStartupProfiles(remote, this.startupConcurrency),
      // A local server launch can require a main-owned native confirmation.
      // Keep those dialogs strictly sequential even while remote connections
      // initialize in parallel.
      this.connectStartupProfiles(local, 1)
    ])
    return this.getStatuses()
  }

  private async connectStartupProfiles(
    profiles: readonly McpServerProfile[],
    concurrency: number
  ): Promise<void> {
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(concurrency, profiles.length) },
      async () => {
        while (true) {
          if (this.closed) return
          const index = cursor
          cursor += 1
          const profile = profiles[index]
          if (!profile) return
          await this.enqueue(profile.id, () => {
            this.requireOpen()
            const current = this.currentProfile(profile.id)
            if (!current) {
              this.connectedProfileIdentities.delete(profile.id)
              this.runtime.delete(profile.id)
              return Promise.resolve(this.statusFor(profile.id))
            }
            if (!current.enabled) {
              this.connectedProfileIdentities.delete(profile.id)
              this.runtime.set(profile.id, { connection: 'disconnected' })
              return Promise.resolve(this.statusFor(profile.id))
            }
            if (
              profileRuntimeIdentity(current) !== profileRuntimeIdentity(profile)
            ) {
              // A save may have connected the replacement profile before this
              // captured startup turn was enqueued. Preserve that current
              // connection; otherwise fail closed without launching stale data.
              if (this.isCurrentConnectedProfile(current.id)) {
                return Promise.resolve(this.statusFor(current.id))
              }
              this.runtime.set(profile.id, { connection: 'disconnected' })
              return Promise.resolve(this.statusFor(profile.id))
            }
            if (this.isCurrentConnectedProfile(current.id)) {
              return Promise.resolve(this.statusFor(current.id))
            }
            return this.connectProfile(current)
          })
        }
      }
    )
    await Promise.all(workers)
  }

  async ready(): Promise<void> {
    await this.initialize()
  }

  async save(value: unknown): Promise<McpServerProfile> {
    this.requireOpen()
    const draft = validateMcpServerDraft(value)
    const serverId = draft.id ?? this.createServerId()
    return this.enqueue(serverId, async () => {
      this.requireOpen()
      const existing = draft.id
        ? this.store.getMcpServer(draft.id)
        : undefined
      const timestamp = this.clock()
      const namespace = normalizeNamespace(draft, existing)
      const common = {
        id: serverId,
        name: draft.name,
        namespace,
        enabled: draft.enabled ?? existing?.enabled ?? true,
        trustedFingerprints: existing
          ? cloneFingerprints(existing.trustedFingerprints)
          : {},
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      let next: McpServerProfile
      if (draft.transport === 'streamable-http') {
        next = {
          ...common,
          transport: 'streamable-http',
          url: draft.url as string
        }
      } else {
        next = {
          ...common,
          transport: 'stdio',
          command: draft.command as string,
          args: [...(draft.args ?? [])]
        }
      }

      const resetTrust =
        existing !== undefined &&
        trustSensitiveConfigurationChanged(existing, next)
      if (resetTrust) next.trustedFingerprints = {}
      const connectionMatchedExisting =
        existing !== undefined &&
        this.connectedProfileIdentities.get(serverId) ===
          profileRuntimeIdentity(existing)
      const saved = await this.store.saveMcpServer(next)

      if (resetTrust) this.service.forgetTrust(serverId)
      if (!saved.enabled) {
        await this.disconnectProfile(serverId)
      } else if (
        !existing ||
        runtimeConfigurationChanged(existing, saved) ||
        this.runtime.get(serverId)?.connection !== 'connected' ||
        !connectionMatchedExisting
      ) {
        if (existing) await this.reconnectProfile(saved)
        else await this.connectProfile(saved)
      } else if (existing && connectionMatchedExisting) {
        // Saving an otherwise unchanged connected profile advances updatedAt.
        // Carry that exact persisted identity forward without blessing a stale
        // or untracked service connection.
        this.connectedProfileIdentities.set(
          serverId,
          profileRuntimeIdentity(saved)
        )
      }
      return saved
    })
  }

  connect(serverId: string): Promise<McpServerStatus> {
    this.requireOpen()
    return this.enqueue(serverId, async () => {
      this.requireOpen()
      const current = this.runtime.get(serverId)
      const profile = this.store.getMcpServer(serverId)
      if (!profile.enabled) {
        return this.disconnectProfile(serverId)
      }
      if (
        current?.connection === 'connected' &&
        current.snapshot &&
        this.isCurrentConnectedProfile(serverId)
      ) {
        return this.statusFor(serverId)
      }
      if (current?.connection === 'connected') {
        return this.reconnectProfile(profile)
      }
      return this.connectProfile(profile)
    })
  }

  reconnect(serverId: string): Promise<McpServerStatus> {
    this.requireOpen()
    return this.enqueue(serverId, async () => {
      this.requireOpen()
      const profile = this.store.getMcpServer(serverId)
      if (!profile.enabled) return this.disconnectProfile(serverId)
      return this.reconnectProfile(profile)
    })
  }

  disconnect(serverId: string): Promise<McpServerStatus> {
    this.requireOpen()
    return this.enqueue(serverId, async () => {
      this.requireOpen()
      this.store.getMcpServer(serverId)
      return this.disconnectProfile(serverId)
    })
  }

  async delete(serverId: string): Promise<void> {
    this.requireOpen()
    await this.enqueue(serverId, async () => {
      this.requireOpen()
      this.store.getMcpServer(serverId)
      // Publish the durable deletion before tearing down the live connection.
      // If persistence fails, the still-saved profile and its runtime/trust
      // state remain coherent and can be retried.
      await this.store.deleteMcpServer(serverId)
      this.connectedProfileIdentities.delete(serverId)
      this.runtime.delete(serverId)
      await this.service.disconnect(serverId).catch(() => undefined)
      this.service.forgetTrust(serverId)
    })
  }

  trustTools(
    serverId: string,
    expectedFingerprints: unknown,
    signal?: AbortSignal
  ): Promise<McpServerStatus> {
    this.requireOpen()
    const parsed = fingerprintsSchema.safeParse(expectedFingerprints)
    if (!parsed.success) {
      throw new TypeError(
        `Invalid MCP fingerprint approval: ${parsed.error.issues[0]?.message ?? 'unknown validation error'}`
      )
    }
    const expected = cloneFingerprints(parsed.data)
    return this.enqueue(serverId, async () => {
      this.requireOpen()
      const profile = this.store.getMcpServer(serverId)
      this.assertCurrentEnabledConnection(serverId)
      try {
        const snapshot = await this.service.trustToolDefinitions(
          serverId,
          expected,
          signal
        )
        const updated: McpServerProfile = {
          ...profile,
          trustedFingerprints: cloneFingerprints(snapshot.fingerprints),
          updatedAt: this.clock()
        }
        try {
          await this.store.saveMcpServer(updated)
        } catch (error) {
          if (error instanceof StatePersistenceError) throw error
          this.service.forgetTrust(serverId)
          this.runtime.set(serverId, {
            connection: 'connected',
            snapshot: this.safeInspect(serverId, snapshot),
            error: parseError(error)
          })
          return this.statusFor(serverId)
        }
        this.connectedProfileIdentities.set(
          serverId,
          profileRuntimeIdentity(updated)
        )
        this.runtime.set(serverId, {
          connection: 'connected',
          snapshot
        })
      } catch (error) {
        if (error instanceof StatePersistenceError) throw error
        const snapshot = this.safeInspect(serverId)
        this.runtime.set(serverId, {
          connection: snapshot ? 'connected' : 'error',
          ...(snapshot ? { snapshot } : {}),
          error: parseError(error)
        })
      }
      return this.statusFor(serverId)
    })
  }

  getStatuses(): McpServerStatus[] {
    const profiles = this.store.snapshot().mcpServers
    return profiles.map((profile) => this.statusFor(profile.id))
  }

  listApprovedTools(): McpExposedTool[] {
    this.requireOpen()
    return this.service
      .listTools()
      .filter((tool) =>
        this.isCurrentConnectedProfile(tool.metadata.serverId)
      )
  }

  async executeTool(
    namespacedName: string,
    input: unknown,
    options?: McpExecuteOptions
  ): Promise<McpToolExecutionResult> {
    this.requireOpen()
    const execute = async (): Promise<McpToolExecutionResult> => {
      this.requireOpen()
      let executionError: string | undefined
      try {
        if (options?.approvalGranted === true) {
          this.assertCurrentEnabledConnection(options.expectedServerId)
        }
        return await this.service.executeTool(
          namespacedName,
          input,
          options,
          options?.approvalGranted === true
            ? () =>
                this.assertCurrentEnabledConnection(
                  options.expectedServerId
                )
            : undefined
        )
      } catch (error) {
        executionError = parseError(error)
        throw error
      } finally {
        this.synchronizeSnapshots(executionError, namespacedName)
      }
    }
    if (options?.approvalGranted === true) {
      return this.enqueue(options.expectedServerId, execute)
    }
    return execute()
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    const operations = [...this.operations.values()]
    const serviceClose = this.service.close()
    await settleManagerOperationsBounded([serviceClose, ...operations])
    for (const serverId of this.runtime.keys()) {
      this.runtime.set(serverId, { connection: 'disconnected' })
    }
    this.connectedProfileIdentities.clear()
  }

  private async connectProfile(profile: McpServerProfile): Promise<McpServerStatus> {
    if (!profile.enabled) {
      this.connectedProfileIdentities.delete(profile.id)
      this.runtime.set(profile.id, { connection: 'disconnected' })
      return this.statusFor(profile.id)
    }
    const expectedIdentity = profileRuntimeIdentity(profile)
    this.runtime.set(profile.id, { connection: 'connecting' })
    try {
      const snapshot = await this.service.connect(profileToConfig(profile), {
        trustedFingerprints: cloneFingerprints(profile.trustedFingerprints)
      })
      const current = this.currentProfile(profile.id)
      if (
        !current ||
        !current.enabled ||
        profileRuntimeIdentity(current) !== expectedIdentity
      ) {
        await this.service.disconnect(profile.id).catch(() => undefined)
        this.connectedProfileIdentities.delete(profile.id)
        if (!current) this.runtime.delete(profile.id)
        else this.runtime.set(profile.id, { connection: 'disconnected' })
        return this.statusFor(profile.id)
      }
      this.connectedProfileIdentities.set(profile.id, expectedIdentity)
      this.runtime.set(profile.id, {
        connection: 'connected',
        snapshot
      })
    } catch (error) {
      this.connectedProfileIdentities.delete(profile.id)
      this.runtime.set(profile.id, {
        connection: 'error',
        error: parseError(error)
      })
    }
    return this.statusFor(profile.id)
  }

  private async reconnectProfile(profile: McpServerProfile): Promise<McpServerStatus> {
    this.connectedProfileIdentities.delete(profile.id)
    try {
      await this.service.disconnect(profile.id)
    } catch (error) {
      this.runtime.set(profile.id, {
        connection: 'error',
        error: parseError(error)
      })
      return this.statusFor(profile.id)
    }
    return this.connectProfile(profile)
  }

  private async disconnectProfile(serverId: string): Promise<McpServerStatus> {
    this.connectedProfileIdentities.delete(serverId)
    try {
      await this.service.disconnect(serverId)
      this.runtime.set(serverId, { connection: 'disconnected' })
    } catch (error) {
      this.runtime.set(serverId, {
        connection: 'error',
        error: parseError(error)
      })
    }
    return this.statusFor(serverId)
  }

  private statusFor(serverId: string): McpServerStatus {
    const observedRuntime = this.runtime.get(serverId) ?? {
      connection: 'disconnected' as const
    }
    const runtime =
      observedRuntime.connection === 'connected' &&
      !this.isCurrentConnectedProfile(serverId)
        ? { connection: 'disconnected' as const }
        : observedRuntime
    const snapshot = runtime.snapshot
    return structuredClone({
      id: serverId,
      connection: runtime.connection,
      ...(runtime.error ? { error: runtime.error } : {}),
      ...(snapshot?.serverInfo ? { serverInfo: snapshot.serverInfo } : {}),
      tools:
        snapshot?.tools.map((tool) => ({
          name: tool.definition.name,
          originalName: tool.metadata.originalName,
          ...(tool.metadata.title ? { title: tool.metadata.title } : {}),
          description: tool.definition.description,
          fingerprint: tool.metadata.fingerprint,
          trustStatus: tool.metadata.trustStatus
        })) ?? [],
      fingerprints: snapshot ? cloneFingerprints(snapshot.fingerprints) : {},
      drift: snapshot
        ? {
            added: [...snapshot.drift.added],
            removed: [...snapshot.drift.removed],
            changed: [...snapshot.drift.changed]
          }
        : {
            added: [...EMPTY_DRIFT.added],
            removed: [...EMPTY_DRIFT.removed],
            changed: [...EMPTY_DRIFT.changed]
          }
    } satisfies McpServerStatus)
  }

  private safeInspect(
    serverId: string,
    fallback?: McpServerSnapshot
  ): McpServerSnapshot | undefined {
    try {
      return this.service.inspectServer(serverId)
    } catch {
      return fallback
    }
  }

  private synchronizeSnapshots(error?: string, toolName?: string): void {
    let snapshots: McpServerSnapshot[]
    try {
      snapshots = this.service.listServers()
    } catch {
      return
    }
    for (const snapshot of snapshots) {
      if (!this.isCurrentConnectedProfile(snapshot.id)) {
        this.runtime.set(snapshot.id, {
          connection: 'disconnected',
          ...(error ? { error } : {})
        })
        continue
      }
      const previous = this.runtime.get(snapshot.id)
      const ownsTool =
        toolName === undefined ||
        snapshot.tools.some((tool) => tool.definition.name === toolName)
      this.runtime.set(snapshot.id, {
        connection: 'connected',
        snapshot,
        ...(error && ownsTool
          ? { error }
          : previous?.error && !ownsTool
            ? { error: previous.error }
            : {})
      })
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('MCP manager is closed')
  }

  private currentProfile(serverId: string): McpServerProfile | undefined {
    try {
      const profile = this.store.getMcpServer(serverId)
      return profile.id === serverId ? profile : undefined
    } catch {
      return undefined
    }
  }

  private isCurrentConnectedProfile(serverId: string): boolean {
    const current = this.currentProfile(serverId)
    const connectedIdentity = this.connectedProfileIdentities.get(serverId)
    const matches =
      current?.enabled === true &&
      connectedIdentity !== undefined &&
      connectedIdentity === profileRuntimeIdentity(current)
    if (!matches && connectedIdentity !== undefined) {
      this.connectedProfileIdentities.delete(serverId)
    }
    return matches
  }

  private assertCurrentEnabledConnection(serverId: string): void {
    if (this.isCurrentConnectedProfile(serverId)) return
    this.connectedProfileIdentities.delete(serverId)
    throw new McpServiceError(
      'tool-drift',
      'The approved MCP server profile was disabled, deleted, or changed'
    )
  }

  private enqueue<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(serverId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    this.operations.set(serverId, settled)
    void settled.finally(() => {
      if (this.operations.get(serverId) === settled) {
        this.operations.delete(serverId)
      }
    })
    return result
  }
}
