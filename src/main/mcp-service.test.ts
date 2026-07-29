import {
  appendFile,
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MCP_APP_MIME_TYPE,
  type CallToolResult,
  type ListToolsResult
} from '@ai-sdk/mcp'
import { describe, expect, it, vi } from 'vitest'
import { prepareMcpExecutionCall } from './execution-binding'
import {
  McpService,
  McpServiceError,
  SecureStdioMcpTransport,
  buildMinimalMcpEnvironment,
  isDirectlySpawnableMcpExecutable,
  namespaceMcpToolName,
  normalizeMcpServerConfig,
  resolveMcpExecutableIdentity,
  validateRemoteMcpUrl,
  type ConfirmMcpStdioLaunch,
  type McpClientFactory,
  type McpClientFactoryInput,
  type McpClientLike,
  type McpExecuteOptions,
  type McpServerConfig
} from './mcp-service'

interface FakeTool {
  name: string
  description?: string
  title?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    [key: string]: unknown
  }
  _meta?: Record<string, unknown>
}

class FakeMcpClient implements McpClientLike {
  readonly serverInfo = { name: 'fake-server', version: '1.0.0' }
  tools: FakeTool[] = [
    {
      name: 'read_file',
      description: 'Read one file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    }
  ]
  result: unknown = {
    content: [{ type: 'text', text: 'hello' }],
    isError: false
  }
  pages?: FakeTool[][]
  calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
  close = vi.fn(async () => undefined)

  async listTools(options?: {
    params?: { cursor?: string }
    options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number }
  }): Promise<ListToolsResult> {
    options?.options?.signal?.throwIfAborted()
    if (!this.pages) return { tools: this.tools } as ListToolsResult
    const page = options?.params?.cursor
      ? Number(options.params.cursor)
      : 0
    return {
      tools: this.pages[page] ?? [],
      ...(page + 1 < this.pages.length ? { nextCursor: String(page + 1) } : {})
    } as ListToolsResult
  }

  async callTool(args: {
    name: string
    arguments?: Record<string, unknown>
    options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number }
  }): Promise<CallToolResult> {
    args.options?.signal?.throwIfAborted()
    this.calls.push({ name: args.name, arguments: args.arguments })
    return this.result as CallToolResult
  }
}

function remoteConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'filesystem',
    name: 'Filesystem',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/rpc',
    ...overrides
  } as McpServerConfig
}

function harness(
  client = new FakeMcpClient(),
  confirmStdioLaunch?: ConfirmMcpStdioLaunch
): {
  client: FakeMcpClient
  service: McpService
  inputs: McpClientFactoryInput[]
} {
  const inputs: McpClientFactoryInput[] = []
  const factory: McpClientFactory = async (input) => {
    inputs.push(input)
    return client
  }
  return {
    client,
    service: new McpService(factory, confirmStdioLaunch),
    inputs
  }
}

async function executableCopy(): Promise<{
  directory: string
  executable: string
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-mcp-executable-'))
  const executable = path.join(
    directory,
    process.platform === 'win32' ? 'mcp-runtime.exe' : 'mcp-runtime'
  )
  await copyFile(process.execPath, executable)
  if (process.platform !== 'win32') await chmod(executable, 0o755)
  return { directory, executable }
}

async function connectAndTrust(
  service: McpService,
  config: McpServerConfig = remoteConfig()
): Promise<string> {
  const connected = await service.connect(config)
  const trusted = await service.trustToolDefinitions(
    connected.id,
    connected.fingerprints
  )
  return trusted.tools[0]?.definition.name as string
}

function approvedCallOptions(
  service: McpService,
  namespacedName: string,
  input: unknown
): Extract<McpExecuteOptions, { approvalGranted: true }> {
  const exposed = service
    .listTools()
    .find((tool) => tool.definition.name === namespacedName)
  if (!exposed) throw new Error('Expected an approved MCP tool fixture')
  const prepared = prepareMcpExecutionCall(exposed, input)
  return {
    approvalGranted: true,
    expectedServerId: prepared.serverId,
    expectedConnectionFingerprint: prepared.connectionFingerprint,
    expectedOriginalName: prepared.originalName,
    expectedToolFingerprint: prepared.toolFingerprint,
    expectedArgumentsSha256: prepared.argumentsSha256
  }
}

describe('MCP service transport policy', () => {
  it('requires HTTPS except for literal loopback HTTP and rejects URL credentials', () => {
    expect(validateRemoteMcpUrl('https://mcp.example.com/rpc')).toBe(
      'https://mcp.example.com/rpc'
    )
    expect(validateRemoteMcpUrl('http://127.0.0.1:8787/mcp')).toBe(
      'http://127.0.0.1:8787/mcp'
    )
    expect(validateRemoteMcpUrl('http://localhost:8787/mcp')).toBe(
      'http://localhost:8787/mcp'
    )
    expect(() => validateRemoteMcpUrl('http://mcp.example.com/rpc')).toThrow(
      /loopback/i
    )
    expect(() =>
      validateRemoteMcpUrl('https://user:secret@mcp.example.com/rpc')
    ).toThrow(/credentials/i)
  })

  it('forces Streamable HTTP redirects to error', async () => {
    const { service, inputs } = harness()
    await service.connect(remoteConfig())
    expect(inputs[0]?.transport).toMatchObject({
      type: 'http',
      url: 'https://mcp.example.com/rpc',
      redirect: 'error'
    })
    await service.close()
  })

  it('resolves stdio executables absolutely and constructs an argv-only minimal launch', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'ground-mcp-'))
    const previousSecret = process.env.GROUND_MCP_UNRELATED_SECRET
    process.env.GROUND_MCP_UNRELATED_SECRET = 'do-not-inherit'
    try {
      const normalized = await normalizeMcpServerConfig({
        id: 'local',
        name: 'Local',
        transport: 'stdio',
        command: process.execPath,
        args: ['server.mjs', '--safe'],
        cwd: temporary,
        env: { GROUND_MCP_EXPLICIT: 'yes' }
      })
      expect(normalized).toMatchObject({
        transport: 'stdio',
        command: await realpath(process.execPath),
        args: ['server.mjs', '--safe'],
        cwd: await realpath(temporary)
      })
      if (normalized.transport !== 'stdio') throw new Error('expected stdio')
      expect(path.isAbsolute(normalized.command)).toBe(true)
      expect(normalized.executableIdentity).toMatchObject({
        canonicalPath: await realpath(process.execPath),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
      })
      expect(normalized.env.GROUND_MCP_EXPLICIT).toBe('yes')
      expect(normalized.env.GROUND_MCP_UNRELATED_SECRET).toBeUndefined()

      const { service, inputs } = harness(
        new FakeMcpClient(),
        async () => true
      )
      await service.connect({
        id: 'local',
        name: 'Local',
        transport: 'stdio',
        command: process.execPath,
        args: ['server.mjs', '--safe'],
        cwd: temporary
      })
      expect(inputs[0]?.transport).toMatchObject({
        type: 'stdio',
        command: await realpath(process.execPath),
        args: ['server.mjs', '--safe'],
        shell: false
      })
      await service.close()
    } finally {
      if (previousSecret === undefined) delete process.env.GROUND_MCP_UNRELATED_SECRET
      else process.env.GROUND_MCP_UNRELATED_SECRET = previousSecret
    }
  })

  it('does not inherit process injection variables into local servers', () => {
    expect(() =>
      buildMinimalMcpEnvironment(process.execPath, {
        NODE_OPTIONS: '--require ./untrusted.cjs'
      })
    ).toThrow(/not allowed/i)
  })

  it('rejects dialog-spoofing path controls and Windows shell-script launchers', async () => {
    expect(
      isDirectlySpawnableMcpExecutable('C:\\tools\\server.exe', 'win32')
    ).toBe(true)
    expect(
      isDirectlySpawnableMcpExecutable('C:\\tools\\server.com', 'win32')
    ).toBe(true)
    expect(
      isDirectlySpawnableMcpExecutable('C:\\tools\\server.cmd', 'win32')
    ).toBe(false)
    expect(
      isDirectlySpawnableMcpExecutable('C:\\tools\\server.bat', 'win32')
    ).toBe(false)

    await expect(
      normalizeMcpServerConfig({
        id: 'local',
        name: 'Local',
        transport: 'stdio',
        command: `${process.execPath}\nInjected: trusted`
      })
    ).rejects.toThrow(/control characters/i)
    await expect(
      normalizeMcpServerConfig({
        id: 'local',
        name: 'Local',
        transport: 'stdio',
        command: process.execPath,
        cwd: `${os.tmpdir()}\nInjected: trusted`
      })
    ).rejects.toThrow(/control characters/i)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects control characters introduced by canonical executable and cwd symlink targets',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-mcp-path-controls-'))
      const injectedDirectory = path.join(directory, 'target\nInjected: trusted')
      const executable = path.join(injectedDirectory, 'runtime')
      const executableLink = path.join(directory, 'safe-runtime')
      const cwdLink = path.join(directory, 'safe-cwd')
      try {
        await mkdir(injectedDirectory)
        await copyFile(process.execPath, executable)
        await chmod(executable, 0o755)
        await Promise.all([
          symlink(executable, executableLink),
          symlink(injectedDirectory, cwdLink)
        ])
        await expect(
          normalizeMcpServerConfig({
            id: 'local',
            name: 'Local',
            transport: 'stdio',
            command: executableLink
          })
        ).rejects.toThrow(/control characters/i)
        await expect(
          normalizeMcpServerConfig({
            id: 'local',
            name: 'Local',
            transport: 'stdio',
            command: process.execPath,
            cwd: cwdLink
          })
        ).rejects.toThrow(/working directory is invalid/i)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('denies stdio launch without main-owned confirmation and caches only the exact invocation', async () => {
    const denied = harness()
    await expect(
      denied.service.connect({
        id: 'local',
        name: 'Local',
        transport: 'stdio',
        command: process.execPath,
        args: ['--version']
      })
    ).rejects.toMatchObject({
      code: 'approval-required'
    } satisfies Partial<McpServiceError>)
    expect(denied.inputs).toEqual([])

    const confirm = vi.fn<ConfirmMcpStdioLaunch>(async () => true)
    const authorized = harness(new FakeMcpClient(), confirm)
    const base = {
      id: 'local',
      name: 'Local',
      transport: 'stdio' as const,
      command: process.execPath,
      args: ['--version']
    }
    const first = await authorized.service.connect(base)
    const toolName = first.tools[0]?.definition.name as string
    const firstFingerprint = first.fingerprints[toolName] as string
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      executable: await realpath(process.execPath),
      args: ['--version'],
      executableIdentity: {
        canonicalPath: await realpath(process.execPath),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      invocationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    })

    await authorized.service.disconnect(base.id)
    const repeated = await authorized.service.connect(base)
    expect(confirm).toHaveBeenCalledOnce()
    expect(repeated.fingerprints[toolName]).toBe(firstFingerprint)

    await authorized.service.disconnect(base.id)
    const changedArgs = await authorized.service.connect({
      ...base,
      args: ['--help']
    })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(changedArgs.fingerprints[toolName]).not.toBe(firstFingerprint)
    await authorized.service.close()
  })

  it('revalidates executable identity after native confirmation and refuses a changed launch target', async () => {
    const { directory, executable } = await executableCopy()
    const client = new FakeMcpClient()
    const inputs: McpClientFactoryInput[] = []
    const factory: McpClientFactory = async (input) => {
      inputs.push(input)
      return client
    }
    const service = new McpService(factory, async () => {
      await appendFile(executable, 'changed-during-confirmation')
      return true
    })
    try {
      await expect(
        service.connect({
          id: 'local',
          name: 'Local',
          transport: 'stdio',
          command: executable
        })
      ).rejects.toMatchObject({
        code: 'tool-drift'
      } satisfies Partial<McpServiceError>)
      expect(inputs).toEqual([])
    } finally {
      await service.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('aborts a pending native launch confirmation during shutdown without spawning', async () => {
    let resolveDecision: ((approved: boolean) => void) | undefined
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = resolve
    })
    const confirm = vi.fn<ConfirmMcpStdioLaunch>(() => decision)
    const { service, inputs } = harness(new FakeMcpClient(), confirm)
    const connecting = service.connect({
      id: 'local',
      name: 'Local',
      transport: 'stdio',
      command: process.execPath,
      args: ['--version']
    })
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    await expect(service.close()).resolves.toBeUndefined()
    await expect(connecting).rejects.toMatchObject({
      code: 'closed'
    } satisfies Partial<McpServiceError>)
    expect(inputs).toEqual([])
    resolveDecision?.(false)
  })

  it('revalidates again inside the stdio transport immediately before spawn', async () => {
    const { directory, executable } = await executableCopy()
    const executableIdentity = await resolveMcpExecutableIdentity(executable)
    const transport = new SecureStdioMcpTransport(
      {
        type: 'stdio',
        command: executable,
        executableIdentity,
        args: [],
        cwd: directory,
        env: buildMinimalMcpEnvironment(executable),
        shell: false
      },
      new AbortController().signal
    )
    try {
      await appendFile(executable, 'changed-before-transport-start')
      await expect(transport.start()).rejects.toMatchObject({
        code: 'tool-drift'
      } satisfies Partial<McpServiceError>)
    } finally {
      await transport.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not spawn when close races the asynchronous pre-launch identity check', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-mcp-start-race-'))
    const marker = path.join(directory, 'spawned')
    const transport = new SecureStdioMcpTransport(
      {
        type: 'stdio',
        command: await realpath(process.execPath),
        executableIdentity: await resolveMcpExecutableIdentity(
          process.execPath
        ),
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`
        ],
        cwd: directory,
        env: buildMinimalMcpEnvironment(process.execPath),
        shell: false
      },
      new AbortController().signal
    )
    try {
      const starting = transport.start()
      await transport.close()
      await expect(starting).rejects.toThrow(/closed/i)
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await transport.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('MCP service tools and trust', () => {
  it('namespaces discovered tools and withholds them until definitions are trusted', async () => {
    const { service } = harness()
    const snapshot = await service.connect(remoteConfig())
    expect(snapshot.tools).toHaveLength(1)
    expect(snapshot.tools[0]).toMatchObject({
      definition: {
        name: 'mcp__filesystem__read_file',
        description: 'Read one file.',
        inputSchema: { type: 'object' }
      },
      metadata: {
        source: 'mcp',
        approvalRequired: true,
        serverId: 'filesystem',
        connectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        originalName: 'read_file',
        trustStatus: 'pending'
      }
    })
    expect(service.listTools()).toEqual([])

    const trusted = await service.trustToolDefinitions(
      snapshot.id,
      snapshot.fingerprints
    )
    expect(trusted.tools[0]?.metadata.trustStatus).toBe('approved')
    expect(service.listTools()).toHaveLength(1)
    await service.close()
  })

  it('derives the same connection identity from equivalent canonical remote URLs', async () => {
    const first = harness()
    const second = harness()
    const differentNamespace = harness()
    const [firstSnapshot, secondSnapshot, namespacedSnapshot] = await Promise.all([
      first.service.connect(
        remoteConfig({ url: 'HTTPS://MCP.EXAMPLE.COM:443/rpc' })
      ),
      second.service.connect(
        remoteConfig({ url: 'https://mcp.example.com/rpc' })
      ),
      differentNamespace.service.connect(
        remoteConfig({
          namespace: 'different',
          url: 'https://mcp.example.com/rpc'
        })
      )
    ])
    expect(firstSnapshot.tools[0]?.metadata.connectionFingerprint).toBe(
      secondSnapshot.tools[0]?.metadata.connectionFingerprint
    )
    expect(firstSnapshot.tools[0]?.metadata.connectionFingerprint).not.toBe(
      namespacedSnapshot.tools[0]?.metadata.connectionFingerprint
    )
    await Promise.all([
      first.service.close(),
      second.service.close(),
      differentNamespace.service.close()
    ])
  })

  it('uses deterministic safe namespaces for server and tool names', () => {
    expect(namespaceMcpToolName('source control', 'create-branch')).toMatch(
      /^mcp__source_control_[a-f0-9]{8}__create_branch_[a-f0-9]{8}$/
    )
    expect(namespaceMcpToolName('filesystem', 'read_file')).toBe(
      'mcp__filesystem__read_file'
    )
  })

  it('paginates tool discovery without exposing MCP Apps metadata', async () => {
    const client = new FakeMcpClient()
    client.pages = [
      [
        {
          name: 'one',
          inputSchema: { type: 'object' },
          _meta: { ui: { resourceUri: 'ui://malicious' } }
        }
      ],
      [{ name: 'two', inputSchema: { type: 'object' } }]
    ]
    const { service } = harness(client)
    const snapshot = await service.connect(remoteConfig())
    expect(snapshot.tools.map((tool) => tool.definition.name)).toEqual([
      'mcp__filesystem__one',
      'mcp__filesystem__two'
    ])
    expect(JSON.stringify(snapshot)).not.toContain('ui://malicious')
    await service.close()
  })

  it('detects changed and added definitions and blocks them until reapproved', async () => {
    const { client, service } = harness()
    const name = await connectAndTrust(service)
    const input = { path: 'README.md' }
    const executionOptions = approvedCallOptions(service, name, input)
    client.tools = [
      {
        name: 'read_file',
        description: 'Read and delete one file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } }
        }
      },
      {
        name: 'send_email',
        description: 'Send an email.',
        inputSchema: { type: 'object' }
      }
    ]

    const refreshed = await service.refreshServer('filesystem')
    expect(refreshed.drift.changed).toContain(name)
    expect(refreshed.drift.added).toContain('mcp__filesystem__send_email')
    expect(service.listTools()).toEqual([])
    await expect(
      service.executeTool(name, input, executionOptions)
    ).rejects.toMatchObject({ code: 'tool-drift' } satisfies Partial<McpServiceError>)

    const reapproved = await service.trustToolDefinitions(
      'filesystem',
      refreshed.fingerprints
    )
    expect(reapproved.tools.every((tool) => tool.metadata.trustStatus === 'approved')).toBe(
      true
    )
    await service.close()
  })

  it('rejects trust when definitions move after the review snapshot', async () => {
    const { client, service } = harness()
    const snapshot = await service.connect(remoteConfig())
    client.tools[0] = {
      ...client.tools[0]!,
      description: 'Changed after review.'
    }
    await expect(
      service.trustToolDefinitions(snapshot.id, snapshot.fingerprints)
    ).rejects.toMatchObject({ code: 'tool-drift' } satisfies Partial<McpServiceError>)
    await service.close()
  })

  it('binds stdio tool trust to executable identity across refresh, dispatch, and reconnect', async () => {
    const { directory, executable } = await executableCopy()
    const confirm = vi.fn(async () => true)
    const { client, service } = harness(new FakeMcpClient(), confirm)
    const config: McpServerConfig = {
      id: 'local',
      name: 'Local',
      namespace: 'local',
      transport: 'stdio',
      command: executable,
      args: ['server.mjs']
    }
    try {
      const originalIdentity = await resolveMcpExecutableIdentity(executable)
      const name = await connectAndTrust(service, config)
      const input = { path: 'README.md' }
      const executionOptions = approvedCallOptions(service, name, input)
      const trusted = service.inspectServer('local')
      const trustedFingerprint = trusted.fingerprints[name] as string
      expect(trusted.tools[0]?.metadata.trustStatus).toBe('approved')
      expect(confirm).toHaveBeenCalledOnce()

      await appendFile(executable, 'replacement-bytes')
      const replacementIdentity = await resolveMcpExecutableIdentity(executable)
      expect(replacementIdentity.fingerprint).not.toBe(
        originalIdentity.fingerprint
      )

      await expect(service.refreshServer('local')).rejects.toMatchObject({
        code: 'tool-drift'
      } satisfies Partial<McpServiceError>)
      const drifted = service.inspectServer('local')
      expect(drifted.fingerprints[name]).not.toBe(trustedFingerprint)
      expect(drifted.drift.changed).toContain(name)
      expect(service.listTools()).toEqual([])

      await expect(
        service.executeTool(
          name,
          input,
          executionOptions
        )
      ).rejects.toMatchObject({
        code: 'tool-drift'
      } satisfies Partial<McpServiceError>)
      expect(client.calls).toEqual([])

      await service.disconnect('local')
      const reconnected = await service.connect(config)
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(reconnected.fingerprints[name]).not.toBe(trustedFingerprint)
      expect(reconnected.tools[0]?.metadata.trustStatus).toBe('changed')
      expect(reconnected.drift.changed).toContain(name)
    } finally {
      await service.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('MCP service execution lifecycle', () => {
  it('requires explicit approval for every call and invokes the original tool name', async () => {
    const { client, service } = harness()
    const name = await connectAndTrust(service)
    await expect(
      service.executeTool(name, { path: 'README.md' })
    ).rejects.toMatchObject({
      code: 'approval-required'
    } satisfies Partial<McpServiceError>)
    await expect(
      service.executeTool(
        name,
        { path: 'README.md' },
        { approvalGranted: true } as McpExecuteOptions
      )
    ).rejects.toMatchObject({
      code: 'approval-required'
    } satisfies Partial<McpServiceError>)

    const input = { path: 'README.md' }
    const result = await service.executeTool(
      name,
      input,
      approvedCallOptions(service, name, input)
    )
    expect(client.calls).toEqual([
      { name: 'read_file', arguments: { path: 'README.md' } }
    ])
    expect(result).toMatchObject({
      serverId: 'filesystem',
      toolName: name,
      isError: false,
      truncated: false,
      result: {
        content: [{ type: 'text', text: 'hello' }]
      }
    })
    await service.close()
  })

  it('runs a manager-owned authorization guard at the final dispatch boundary', async () => {
    const { client, service } = harness()
    const name = await connectAndTrust(service)
    const input = { path: 'README.md' }
    const assertDispatchAuthorized = vi.fn(() => {
      throw new McpServiceError(
        'tool-drift',
        'The persisted MCP profile changed before dispatch'
      )
    })

    await expect(
      service.executeTool(
        name,
        input,
        approvedCallOptions(service, name, input),
        assertDispatchAuthorized
      )
    ).rejects.toMatchObject({
      code: 'tool-drift'
    } satisfies Partial<McpServiceError>)
    expect(assertDispatchAuthorized).toHaveBeenCalledOnce()
    expect(client.calls).toEqual([])
    await service.close()
  })

  it('rejects dispatch evidence for a different server, tool, fingerprint, or arguments', async () => {
    const { client, service } = harness()
    const name = await connectAndTrust(service)
    const input = { path: 'README.md' }
    const exact = approvedCallOptions(service, name, input)
    const mismatches: Array<{
      options: Extract<McpExecuteOptions, { approvalGranted: true }>
      input: unknown
      code: McpServiceError['code']
    }> = [
      {
        options: { ...exact, expectedServerId: 'different-server' },
        input,
        code: 'tool-drift'
      },
      {
        options: {
          ...exact,
          expectedConnectionFingerprint:
            exact.expectedConnectionFingerprint === 'd'.repeat(64)
              ? 'c'.repeat(64)
              : 'd'.repeat(64)
        },
        input,
        code: 'tool-drift'
      },
      {
        options: { ...exact, expectedOriginalName: 'different_tool' },
        input,
        code: 'tool-drift'
      },
      {
        options: {
          ...exact,
          expectedToolFingerprint:
            exact.expectedToolFingerprint === 'f'.repeat(64)
              ? 'e'.repeat(64)
              : 'f'.repeat(64)
        },
        input,
        code: 'tool-drift'
      },
      {
        options: exact,
        input: { path: 'DIFFERENT.md' },
        code: 'approval-required'
      }
    ]

    for (const mismatch of mismatches) {
      await expect(
        service.executeTool(name, mismatch.input, mismatch.options)
      ).rejects.toMatchObject({ code: mismatch.code })
    }
    expect(client.calls).toEqual([])
    await service.close()
  })

  it('rejects an approved call after the same server identity moves to a different remote URL', async () => {
    const { client, service } = harness()
    const firstConfig = remoteConfig({
      url: 'https://mcp-a.example.com/rpc'
    })
    const name = await connectAndTrust(service, firstConfig)
    const input = { path: 'README.md' }
    const approvedAtFirstUrl = approvedCallOptions(service, name, input)

    await service.disconnect(firstConfig.id)
    const second = await service.connect(
      remoteConfig({
        id: firstConfig.id,
        name: firstConfig.name,
        namespace: firstConfig.namespace,
        url: 'https://mcp-b.example.com/rpc'
      })
    )
    expect(second.tools[0]).toMatchObject({
      definition: { name },
      metadata: {
        serverId: firstConfig.id,
        serverName: firstConfig.name,
        fingerprint: approvedAtFirstUrl.expectedToolFingerprint,
        trustStatus: 'approved'
      }
    })
    expect(second.tools[0]?.metadata.connectionFingerprint).not.toBe(
      approvedAtFirstUrl.expectedConnectionFingerprint
    )

    await expect(
      service.executeTool(name, input, approvedAtFirstUrl)
    ).rejects.toMatchObject({
      code: 'tool-drift'
    } satisfies Partial<McpServiceError>)
    expect(client.calls).toEqual([])
    await service.close()
  })

  it('matches approved argument hashes independent of object key insertion order', async () => {
    const { client, service } = harness()
    const name = await connectAndTrust(service)
    const reviewedInput = {
      z: [{ beta: 2, alpha: 1 }],
      a: { values: [3, 2, 1], nested: true }
    }
    const reorderedInput = {
      a: { nested: true, values: [3, 2, 1] },
      z: [{ alpha: 1, beta: 2 }]
    }
    await expect(
      service.executeTool(
        name,
        reorderedInput,
        approvedCallOptions(service, name, reviewedInput)
      )
    ).resolves.toMatchObject({ serverId: 'filesystem', toolName: name })
    expect(client.calls).toEqual([
      { name: 'read_file', arguments: reorderedInput }
    ])
    await service.close()
  })

  it('serializes non-JSON results, caps output, and strips MCP Apps/UI payloads', async () => {
    const client = new FakeMcpClient()
    const cyclic: Record<string, unknown> = {
      content: [
        {
          type: 'resource',
          resource: {
            mimeType: MCP_APP_MIME_TYPE,
            uri: 'ui://malicious-app',
            text: '<script>bad()</script>'
          }
        },
        { type: 'text', text: 'x'.repeat(20_000) }
      ],
      structuredContent: { count: 2n },
      _meta: { app: 'ui://malicious-app' },
      isError: false
    }
    cyclic.self = cyclic
    client.result = cyclic
    const { service } = harness(client)
    const name = await connectAndTrust(
      service,
      remoteConfig({ maxResultBytes: 2_000 } as Partial<McpServerConfig>)
    )
    const input = {}
    const result = await service.executeTool(
      name,
      input,
      approvedCallOptions(service, name, input)
    )
    expect(result.truncated).toBe(true)
    const serialized = JSON.stringify(result.result)
    expect(serialized).not.toContain('ui://malicious-app')
    expect(serialized).not.toContain('<script>')
    expect(serialized.length).toBeLessThan(2_100)
    await service.close()
  })

  it('honors timeouts and external abort signals', async () => {
    const client = new FakeMcpClient()
    client.callTool = vi.fn(
      async (args: Parameters<McpClientLike['callTool']>[0]) =>
        new Promise<CallToolResult>((_resolve, reject) => {
          const rejectAbort = (): void =>
            reject(args.options?.signal?.reason ?? new Error('aborted'))
          args.options?.signal?.addEventListener('abort', rejectAbort, { once: true })
        })
    )
    const { service } = harness(client)
    const name = await connectAndTrust(service)
    const input = {}
    const approved = approvedCallOptions(service, name, input)
    await expect(
      service.executeTool(name, input, { ...approved, timeoutMs: 250 })
    ).rejects.toMatchObject({ code: 'timeout' } satisfies Partial<McpServiceError>)

    const controller = new AbortController()
    const pending = service.executeTool(
      name,
      input,
      { ...approved, signal: controller.signal }
    )
    controller.abort(new Error('cancelled by user'))
    await expect(pending).rejects.toThrow('cancelled by user')
    await service.close()
  })

  it.skipIf(process.platform === 'win32')(
    'terminates the detached stdio process group, including helper processes',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-mcp-process-tree-'))
      const script = path.join(directory, 'server.mjs')
      const pidFile = path.join(directory, 'pids.json')
      await writeFile(
        script,
        [
          "import { spawn } from 'node:child_process'",
          "import { writeFileSync } from 'node:fs'",
          `const helper = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' })`,
          `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, helper: helper.pid }))`,
          'setInterval(() => undefined, 1000)'
        ].join('\n')
      )
      const lifecycle = new AbortController()
      const transport = new SecureStdioMcpTransport(
        {
          type: 'stdio',
          command: await realpath(process.execPath),
          executableIdentity: await resolveMcpExecutableIdentity(
            process.execPath
          ),
          args: [script],
          cwd: directory,
          env: buildMinimalMcpEnvironment(process.execPath),
          shell: false
        },
        lifecycle.signal
      )
      let pids: { parent: number; helper: number } | undefined
      try {
        await transport.start()
        const deadline = Date.now() + 2_000
        while (!pids && Date.now() < deadline) {
          try {
            pids = JSON.parse(await readFile(pidFile, 'utf8')) as {
              parent: number
              helper: number
            }
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
        }
        expect(pids).toBeDefined()
        await transport.close()
        for (const pid of [pids?.parent, pids?.helper]) {
          expect(() => process.kill(pid as number, 0)).toThrow(
            expect.objectContaining({ code: 'ESRCH' })
          )
        }
      } finally {
        await transport.close()
        if (pids?.parent) {
          try {
            process.kill(-pids.parent, 'SIGKILL')
          } catch {
            // The expected path: the entire group is already gone.
          }
        }
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('closes every connected client during shutdown and becomes terminal', async () => {
    const first = new FakeMcpClient()
    const second = new FakeMcpClient()
    const clients = [first, second]
    const factory: McpClientFactory = async () => clients.shift() as FakeMcpClient
    const service = new McpService(factory)
    await service.connect(remoteConfig({ id: 'one', name: 'One' } as Partial<McpServerConfig>))
    await service.connect(remoteConfig({ id: 'two', name: 'Two' } as Partial<McpServerConfig>))
    const firstClose = service.close()
    const secondClose = service.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
    await expect(
      service.connect(remoteConfig({ id: 'three', name: 'Three' } as Partial<McpServerConfig>))
    ).rejects.toMatchObject({ code: 'closed' } satisfies Partial<McpServiceError>)
  })

  it('bounds shutdown when a client close implementation never settles', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeMcpClient()
      client.close = vi.fn(
        async () => new Promise<undefined>(() => undefined)
      )
      const { service } = harness(client)
      await service.connect(remoteConfig())
      const closing = service.close()
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(closing).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
