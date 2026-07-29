import { z } from 'zod'
import type {
  AppSnapshot,
  McpServerDraft,
  McpServerProfile,
  McpServerStatus
} from '../shared/types'
import { createId, nowIso } from './lib/ids'
import {
  McpService,
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
    options?: McpExecuteOptions
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
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(this.startupConcurrency, enabled.length) },
      async () => {
        while (true) {
          if (this.closed) return
          const index = cursor
          cursor += 1
          const profile = enabled[index]
          if (!profile) return
          await this.enqueue(profile.id, () => {
            this.requireOpen()
            return this.connectProfile(profile)
          })
        }
      }
    )
    await Promise.all(workers)
    return this.getStatuses()
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
      const saved = await this.store.saveMcpServer(next)

      if (resetTrust) this.service.forgetTrust(serverId)
      if (!saved.enabled) {
        await this.disconnectProfile(serverId)
      } else if (
        !existing ||
        runtimeConfigurationChanged(existing, saved) ||
        this.runtime.get(serverId)?.connection !== 'connected'
      ) {
        if (existing) await this.reconnectProfile(saved)
        else await this.connectProfile(saved)
      }
      return saved
    })
  }

  connect(serverId: string): Promise<McpServerStatus> {
    this.requireOpen()
    return this.enqueue(serverId, async () => {
      this.requireOpen()
      const current = this.runtime.get(serverId)
      if (current?.connection === 'connected' && current.snapshot) {
        return this.statusFor(serverId)
      }
      return this.connectProfile(this.store.getMcpServer(serverId))
    })
  }

  reconnect(serverId: string): Promise<McpServerStatus> {
    this.requireOpen()
    return this.enqueue(serverId, async () => {
      this.requireOpen()
      return this.reconnectProfile(this.store.getMcpServer(serverId))
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
      await this.service.disconnect(serverId).catch(() => undefined)
      this.service.forgetTrust(serverId)
      await this.store.deleteMcpServer(serverId)
      this.runtime.delete(serverId)
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
          this.service.forgetTrust(serverId)
          this.runtime.set(serverId, {
            connection: 'connected',
            snapshot: this.safeInspect(serverId, snapshot),
            error: parseError(error)
          })
          return this.statusFor(serverId)
        }
        this.runtime.set(serverId, {
          connection: 'connected',
          snapshot
        })
      } catch (error) {
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
    return this.service.listTools()
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
        return await this.service.executeTool(namespacedName, input, options)
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
  }

  private async connectProfile(profile: McpServerProfile): Promise<McpServerStatus> {
    this.runtime.set(profile.id, { connection: 'connecting' })
    try {
      const snapshot = await this.service.connect(profileToConfig(profile), {
        trustedFingerprints: cloneFingerprints(profile.trustedFingerprints)
      })
      this.runtime.set(profile.id, {
        connection: 'connected',
        snapshot
      })
    } catch (error) {
      this.runtime.set(profile.id, {
        connection: 'error',
        error: parseError(error)
      })
    }
    return this.statusFor(profile.id)
  }

  private async reconnectProfile(profile: McpServerProfile): Promise<McpServerStatus> {
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
    const runtime = this.runtime.get(serverId) ?? {
      connection: 'disconnected' as const
    }
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
