import { describe, expect, it, vi } from 'vitest'
import type {
  AppSnapshot,
  McpServerProfile
} from '../shared/types'
import {
  McpManager,
  validateMcpServerDraft,
  type McpManagerStore,
  type McpServiceCoordinator
} from './mcp-manager'
import type {
  McpConnectOptions,
  McpExecuteOptions,
  McpExposedTool,
  McpServerConfig,
  McpServerSnapshot,
  McpToolExecutionResult
} from './mcp-service'

const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)

function profile(
  overrides: Partial<McpServerProfile> = {}
): McpServerProfile {
  return {
    id: 'server-one',
    name: 'Server one',
    namespace: 'server_one',
    enabled: true,
    trustedFingerprints: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/rpc',
    ...overrides
  } as McpServerProfile
}

function tool(
  serverId = 'server-one',
  fingerprint = FINGERPRINT_A,
  trustStatus: 'approved' | 'pending' | 'changed' = 'pending'
): McpExposedTool {
  return {
    definition: {
      name: `mcp__${serverId.replace(/-/gu, '_')}__read_file`,
      description: 'Read a file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path'],
        additionalProperties: false
      }
    },
    metadata: {
      source: 'mcp',
      approvalRequired: true,
      serverId,
      serverName: serverId,
      originalName: 'read_file',
      fingerprint,
      trustStatus
    }
  }
}

function serverSnapshot(
  config: McpServerConfig,
  fingerprints: Record<string, string> = {}
): McpServerSnapshot {
  const exposed = tool(
    config.id,
    Object.values(fingerprints)[0] ?? FINGERPRINT_A,
    Object.keys(fingerprints).length ? 'approved' : 'pending'
  )
  const keyedFingerprints = Object.keys(fingerprints).length
    ? { ...fingerprints }
    : { [exposed.definition.name]: FINGERPRINT_A }
  return {
    id: config.id,
    name: config.name,
    namespace: config.namespace ?? config.id,
    transport: config.transport,
    serverInfo: {
      name: `fake-${config.id}`,
      version: '1.0.0'
    },
    tools: [
      {
        ...exposed,
        metadata: {
          ...exposed.metadata,
          fingerprint: keyedFingerprints[exposed.definition.name] ?? FINGERPRINT_A,
          trustStatus:
            keyedFingerprints[exposed.definition.name] ===
            fingerprints[exposed.definition.name]
              ? 'approved'
              : 'pending'
        }
      }
    ],
    fingerprints: keyedFingerprints,
    drift: {
      added: Object.keys(fingerprints).length
        ? []
        : [exposed.definition.name],
      removed: [],
      changed: []
    }
  }
}

class FakeStore implements McpManagerStore {
  readonly profiles = new Map<string, McpServerProfile>()
  saveCount = 0
  failNextSave = false

  constructor(profiles: McpServerProfile[] = []) {
    for (const item of profiles) this.profiles.set(item.id, structuredClone(item))
  }

  snapshot(): Pick<AppSnapshot, 'mcpServers'> {
    return {
      mcpServers: [...this.profiles.values()].map((item) => structuredClone(item))
    }
  }

  getMcpServer(serverId: string): McpServerProfile {
    const item = this.profiles.get(serverId)
    if (!item) throw new Error('MCP server not found')
    return structuredClone(item)
  }

  async saveMcpServer(server: McpServerProfile): Promise<McpServerProfile> {
    this.saveCount += 1
    if (this.failNextSave) {
      this.failNextSave = false
      throw new Error('disk is full')
    }
    this.profiles.set(server.id, structuredClone(server))
    return structuredClone(server)
  }

  async deleteMcpServer(serverId: string): Promise<void> {
    if (!this.profiles.delete(serverId)) throw new Error('MCP server not found')
  }
}

class FakeService implements McpServiceCoordinator {
  readonly snapshots = new Map<string, McpServerSnapshot>()
  readonly connectCalls: Array<{
    config: McpServerConfig
    options?: McpConnectOptions
  }> = []
  readonly disconnectCalls: string[] = []
  readonly forgotten: string[] = []
  readonly trusted: Array<{
    id: string
    fingerprints: Readonly<Record<string, string>>
  }> = []
  readonly executeCalls: Array<{
    name: string
    input: unknown
    options?: McpExecuteOptions
  }> = []
  failConnect = new Set<string>()
  failTrust = false
  connectDelayMs = 0
  activeConnects = 0
  maxActiveConnects = 0
  closeCount = 0
  closeNeverSettles = false

  async connect(
    config: McpServerConfig,
    options?: McpConnectOptions
  ): Promise<McpServerSnapshot> {
    this.connectCalls.push({
      config: structuredClone(config),
      options: options
        ? {
            ...options,
            trustedFingerprints: options.trustedFingerprints
              ? { ...options.trustedFingerprints }
              : undefined
          }
        : undefined
    })
    this.activeConnects += 1
    this.maxActiveConnects = Math.max(
      this.maxActiveConnects,
      this.activeConnects
    )
    try {
      if (this.connectDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs))
      }
      if (this.failConnect.has(config.id)) {
        throw new Error(`connection failed for ${config.id}`)
      }
      const snapshot = serverSnapshot(
        config,
        options?.trustedFingerprints
          ? { ...options.trustedFingerprints }
          : {}
      )
      this.snapshots.set(config.id, snapshot)
      return structuredClone(snapshot)
    } finally {
      this.activeConnects -= 1
    }
  }

  async refreshServer(serverId: string): Promise<McpServerSnapshot> {
    return this.inspectServer(serverId)
  }

  async trustToolDefinitions(
    serverId: string,
    expectedFingerprints: Readonly<Record<string, string>>
  ): Promise<McpServerSnapshot> {
    this.trusted.push({ id: serverId, fingerprints: { ...expectedFingerprints } })
    if (this.failTrust) throw new Error('definitions changed during review')
    const current = this.inspectServer(serverId)
    if (
      JSON.stringify(current.fingerprints) !==
      JSON.stringify(expectedFingerprints)
    ) {
      throw new Error('definitions changed during review')
    }
    const snapshot = {
      ...current,
      tools: current.tools.map((item) => ({
        ...item,
        metadata: { ...item.metadata, trustStatus: 'approved' as const }
      })),
      drift: { added: [], removed: [], changed: [] }
    }
    this.snapshots.set(serverId, snapshot)
    return structuredClone(snapshot)
  }

  inspectServer(serverId: string): McpServerSnapshot {
    const snapshot = this.snapshots.get(serverId)
    if (!snapshot) throw new Error('not connected')
    return structuredClone(snapshot)
  }

  listServers(): McpServerSnapshot[] {
    return [...this.snapshots.values()].map((item) => structuredClone(item))
  }

  listTools(): McpExposedTool[] {
    return this.listServers()
      .flatMap((snapshot) => snapshot.tools)
      .filter((item) => item.metadata.trustStatus === 'approved')
  }

  getTrustedFingerprints(serverId: string): Record<string, string> {
    return { ...(this.snapshots.get(serverId)?.fingerprints ?? {}) }
  }

  forgetTrust(serverId: string): void {
    this.forgotten.push(serverId)
    const snapshot = this.snapshots.get(serverId)
    if (!snapshot) return
    this.snapshots.set(serverId, {
      ...snapshot,
      tools: snapshot.tools.map((item) => ({
        ...item,
        metadata: { ...item.metadata, trustStatus: 'pending' }
      }))
    })
  }

  async executeTool(
    namespacedName: string,
    input: unknown,
    options?: McpExecuteOptions
  ): Promise<McpToolExecutionResult> {
    this.executeCalls.push({ name: namespacedName, input, options })
    return {
      serverId: 'server-one',
      toolName: namespacedName,
      isError: false,
      result: { ok: true },
      truncated: false,
      byteLength: 11
    }
  }

  async disconnect(serverId: string): Promise<void> {
    this.disconnectCalls.push(serverId)
    this.snapshots.delete(serverId)
  }

  async close(): Promise<void> {
    this.closeCount += 1
    if (this.closeNeverSettles) {
      await new Promise<void>(() => undefined)
    }
    this.snapshots.clear()
  }
}

describe('MCP manager validation and persistence', () => {
  it('validates transport-specific drafts and secure remote URLs', () => {
    expect(
      validateMcpServerDraft({
        name: 'Local',
        transport: 'stdio',
        command: 'node',
        args: ['server.mjs']
      })
    ).toMatchObject({
      name: 'Local',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs']
    })
    expect(() =>
      validateMcpServerDraft({
        name: 'Remote',
        transport: 'streamable-http',
        url: 'http://mcp.example.com/rpc'
      })
    ).toThrow(/loopback/i)
    expect(() =>
      validateMcpServerDraft({
        name: 'Remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        command: 'unexpected'
      })
    ).toThrow(/unrecognized key/i)
  })

  it('creates profiles with defaults and stable timestamps', async () => {
    const store = new FakeStore()
    const service = new FakeService()
    const timestamps = [
      '2026-07-28T12:00:00.000Z',
      '2026-07-28T13:00:00.000Z'
    ]
    const manager = new McpManager(store, service, {
      createServerId: () => 'created-id',
      now: () => timestamps.shift() as string
    })
    const created = await manager.save({
      name: 'My Tools',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/rpc',
      enabled: false
    })
    expect(created).toMatchObject({
      id: 'created-id',
      namespace: 'my_tools',
      enabled: false,
      trustedFingerprints: {},
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z'
    })
    const updated = await manager.save({
      id: created.id,
      name: 'Renamed',
      transport: 'streamable-http',
      url: created.transport === 'streamable-http' ? created.url : '',
      enabled: false
    })
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).toBe('2026-07-28T13:00:00.000Z')
  })

  it('can save an enabled stdio profile but cannot launch it without main-owned confirmation', async () => {
    const store = new FakeStore()
    const manager = new McpManager(store, undefined, {
      createServerId: () => 'local-unconfirmed'
    })
    try {
      const saved = await manager.save({
        name: 'Local unconfirmed',
        transport: 'stdio',
        command: process.execPath,
        args: ['--version'],
        enabled: true
      })
      expect(saved.enabled).toBe(true)
      expect(store.getMcpServer(saved.id)).toMatchObject({
        command: process.execPath,
        args: ['--version']
      })
      expect(manager.getStatuses()[0]).toMatchObject({
        connection: 'error',
        error: expect.stringMatching(/native confirmation/i)
      })
    } finally {
      await manager.close()
    }
  })

  it('retains trust for presentation changes and resets it for security-sensitive changes', async () => {
    const name = 'mcp__server_one__read_file'
    const original = profile({
      enabled: false,
      trustedFingerprints: { [name]: FINGERPRINT_A }
    })
    const store = new FakeStore([original])
    const service = new FakeService()
    const manager = new McpManager(store, service)

    const renamed = await manager.save({
      id: original.id,
      name: 'New display name',
      namespace: original.namespace,
      enabled: false,
      transport: 'streamable-http',
      url: original.transport === 'streamable-http' ? original.url : ''
    })
    expect(renamed.trustedFingerprints).toEqual({
      [name]: FINGERPRINT_A
    })
    expect(service.forgotten).toEqual([])

    const endpointChanged = await manager.save({
      id: original.id,
      name: renamed.name,
      namespace: renamed.namespace,
      enabled: false,
      transport: 'streamable-http',
      url: 'https://different.example.com/rpc'
    })
    expect(endpointChanged.trustedFingerprints).toEqual({})
    expect(service.forgotten).toEqual([original.id])
  })

  it.each([
    {
      label: 'namespace',
      draft: {
        id: 'stdio',
        name: 'Stdio',
        namespace: 'changed',
        enabled: false,
        transport: 'stdio',
        command: 'node',
        args: ['a.mjs']
      }
    },
    {
      label: 'command',
      draft: {
        id: 'stdio',
        name: 'Stdio',
        namespace: 'stdio',
        enabled: false,
        transport: 'stdio',
        command: '/usr/bin/node',
        args: ['a.mjs']
      }
    },
    {
      label: 'arguments',
      draft: {
        id: 'stdio',
        name: 'Stdio',
        namespace: 'stdio',
        enabled: false,
        transport: 'stdio',
        command: 'node',
        args: ['b.mjs']
      }
    },
    {
      label: 'transport',
      draft: {
        id: 'stdio',
        name: 'Stdio',
        namespace: 'stdio',
        enabled: false,
        transport: 'streamable-http',
        url: 'https://mcp.example.com/rpc'
      }
    }
  ])('resets stdio trust when $label changes', async ({ draft }) => {
    const stored = profile({
      id: 'stdio',
      name: 'Stdio',
      namespace: 'stdio',
      enabled: false,
      transport: 'stdio',
      command: 'node',
      args: ['a.mjs'],
      trustedFingerprints: {
        mcp__stdio__read_file: FINGERPRINT_A
      }
    })
    const store = new FakeStore([stored])
    const service = new FakeService()
    const manager = new McpManager(store, service)
    const saved = await manager.save(draft)
    expect(saved.trustedFingerprints).toEqual({})
    expect(service.forgotten).toEqual(['stdio'])
  })
})

describe('MCP manager lifecycle', () => {
  it('initializes enabled servers with bounded concurrency and isolates failures', async () => {
    const profiles = Array.from({ length: 9 }, (_, index) =>
      profile({
        id: `server-${index}`,
        name: `Server ${index}`,
        namespace: `server_${index}`,
        enabled: index !== 8
      })
    )
    const store = new FakeStore(profiles)
    const service = new FakeService()
    service.connectDelayMs = 10
    service.failConnect.add('server-3')
    const manager = new McpManager(store, service, {
      startupConcurrency: 4
    })
    const statuses = await manager.initialize()
    expect(service.maxActiveConnects).toBeLessThanOrEqual(4)
    expect(service.connectCalls).toHaveLength(8)
    expect(statuses.find((item) => item.id === 'server-3')).toMatchObject({
      connection: 'error',
      error: 'connection failed for server-3'
    })
    expect(statuses.find((item) => item.id === 'server-8')).toMatchObject({
      connection: 'disconnected'
    })
    expect(
      statuses.filter((item) => item.connection === 'connected')
    ).toHaveLength(7)
  })

  it('passes persisted trust into connections and maps snapshots to public status', async () => {
    const exposedName = 'mcp__server_one__read_file'
    const stored = profile({
      trustedFingerprints: { [exposedName]: FINGERPRINT_A }
    })
    const store = new FakeStore([stored])
    const service = new FakeService()
    const manager = new McpManager(store, service)
    const status = await manager.connect(stored.id)
    expect(service.connectCalls[0]).toMatchObject({
      config: {
        id: stored.id,
        name: stored.name,
        namespace: stored.namespace,
        transport: 'streamable-http',
        url: 'https://mcp.example.com/rpc'
      },
      options: {
        trustedFingerprints: { [exposedName]: FINGERPRINT_A }
      }
    })
    expect(status).toMatchObject({
      connection: 'connected',
      serverInfo: { name: 'fake-server-one', version: '1.0.0' },
      tools: [
        {
          name: exposedName,
          originalName: 'read_file',
          description: 'Read a file.',
          fingerprint: FINGERPRINT_A,
          trustStatus: 'approved'
        }
      ],
      drift: { added: [], removed: [], changed: [] }
    })
  })

  it('reconnects, disconnects, and deletes through one serialized lifecycle', async () => {
    const stored = profile()
    const store = new FakeStore([stored])
    const service = new FakeService()
    const manager = new McpManager(store, service)
    await manager.connect(stored.id)
    const reconnected = await manager.reconnect(stored.id)
    expect(reconnected.connection).toBe('connected')
    expect(service.disconnectCalls).toEqual([stored.id])
    expect(service.connectCalls).toHaveLength(2)

    const disconnected = await manager.disconnect(stored.id)
    expect(disconnected.connection).toBe('disconnected')
    await manager.delete(stored.id)
    expect(service.disconnectCalls).toEqual([
      stored.id,
      stored.id,
      stored.id
    ])
    expect(service.forgotten).toContain(stored.id)
    expect(store.profiles.has(stored.id)).toBe(false)
  })

  it('automatically connects enabled saves and disconnects disabled updates', async () => {
    const store = new FakeStore()
    const service = new FakeService()
    const manager = new McpManager(store, service, {
      createServerId: () => 'auto'
    })
    await manager.save({
      name: 'Auto',
      namespace: 'auto',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/rpc'
    })
    expect(service.connectCalls).toHaveLength(1)
    await manager.save({
      id: 'auto',
      name: 'Auto',
      namespace: 'auto',
      enabled: false,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/rpc'
    })
    expect(service.disconnectCalls).toEqual(['auto'])
    expect(manager.getStatuses()[0]?.connection).toBe('disconnected')
  })
})

describe('MCP manager trust and execution', () => {
  it('persists trust only after exact service approval', async () => {
    const stored = profile()
    const store = new FakeStore([stored])
    const service = new FakeService()
    const manager = new McpManager(store, service)
    const connected = await manager.connect(stored.id)
    const approved = await manager.trustTools(
      stored.id,
      connected.fingerprints
    )
    expect(approved.tools[0]?.trustStatus).toBe('approved')
    expect(store.getMcpServer(stored.id).trustedFingerprints).toEqual(
      connected.fingerprints
    )
    expect(service.trusted).toEqual([
      { id: stored.id, fingerprints: connected.fingerprints }
    ])
  })

  it('does not persist fingerprints when exact approval fails', async () => {
    const stored = profile()
    const store = new FakeStore([stored])
    const service = new FakeService()
    const manager = new McpManager(store, service)
    const connected = await manager.connect(stored.id)
    service.failTrust = true
    const before = store.saveCount
    const status = await manager.trustTools(
      stored.id,
      connected.fingerprints
    )
    expect(status).toMatchObject({
      connection: 'connected',
      error: 'definitions changed during review'
    })
    expect(store.saveCount).toBe(before)
    expect(store.getMcpServer(stored.id).trustedFingerprints).toEqual({})
  })

  it('rolls service trust back if persistence fails', async () => {
    const stored = profile()
    const store = new FakeStore([stored])
    const service = new FakeService()
    const manager = new McpManager(store, service)
    const connected = await manager.connect(stored.id)
    store.failNextSave = true
    const status = await manager.trustTools(
      stored.id,
      connected.fingerprints
    )
    expect(service.forgotten).toEqual([stored.id])
    expect(status).toMatchObject({
      connection: 'connected',
      error: 'disk is full'
    })
    expect(store.getMcpServer(stored.id).trustedFingerprints).toEqual({})
  })

  it('proxies approved tools and executions without weakening approval options', async () => {
    const exposedName = 'mcp__server_one__read_file'
    const stored = profile({
      trustedFingerprints: { [exposedName]: FINGERPRINT_A }
    })
    const store = new FakeStore([stored])
    const service = new FakeService()
    const manager = new McpManager(store, service)
    await manager.connect(stored.id)
    expect(manager.listApprovedTools()).toHaveLength(1)
    const result = await manager.executeTool(
      exposedName,
      { path: 'README.md' },
      { approvalGranted: true, timeoutMs: 500 }
    )
    expect(result.result).toEqual({ ok: true })
    expect(service.executeCalls).toEqual([
      {
        name: exposedName,
        input: { path: 'README.md' },
        options: { approvalGranted: true, timeoutMs: 500 }
      }
    ])
  })

  it('closes the underlying service once and marks runtime state disconnected', async () => {
    const stored = profile()
    const store = new FakeStore([stored])
    const service = new FakeService()
    const manager = new McpManager(store, service)
    await manager.connect(stored.id)
    const firstClose = manager.close()
    const secondClose = manager.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    expect(service.closeCount).toBe(1)
    expect(manager.getStatuses()[0]?.connection).toBe('disconnected')
    expect(() => manager.listApprovedTools()).toThrow(/closed/i)
  })

  it('bounds manager shutdown when underlying cleanup never settles', async () => {
    vi.useFakeTimers()
    try {
      const store = new FakeStore([profile()])
      const service = new FakeService()
      service.closeNeverSettles = true
      const manager = new McpManager(store, service)
      const closing = manager.close()
      await vi.advanceTimersByTimeAsync(2_500)
      await expect(closing).resolves.toBeUndefined()
      expect(service.closeCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
