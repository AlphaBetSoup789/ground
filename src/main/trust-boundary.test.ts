import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderDraft } from '../shared/types'
import {
  canonicalProviderEndpoint,
  CliTrustRegistry,
  type CliTrustRequest,
  isExpectedRendererUrl,
  isLoopbackRendererUrl,
  revealWorkspacePath,
  resolveRendererTarget,
  WorkspaceGrantRegistry
} from './trust-boundary'

describe('renderer trust boundary', () => {
  it('ignores a development renderer URL in packaged builds', () => {
    const rendererFile = '/Applications/Ground.app/renderer/index.html'
    const target = resolveRendererTarget(
      true,
      'http://127.0.0.1:5173',
      rendererFile
    )
    expect(target.kind).toBe('file')
    expect(target.value).toBe(pathToFileURL(rendererFile).toString())
  })

  it('accepts only loopback HTTP(S) development renderers', () => {
    expect(isLoopbackRendererUrl('http://localhost:5173/')).toBe(true)
    expect(isLoopbackRendererUrl('https://127.0.0.1:5173/')).toBe(true)
    expect(isLoopbackRendererUrl('http://127.1:5173/')).toBe(true)
    expect(isLoopbackRendererUrl('https://example.com/')).toBe(false)
    expect(isLoopbackRendererUrl('file:///tmp/index.html')).toBe(false)
    expect(() =>
      resolveRendererTarget(false, 'https://example.com/', '/tmp/index.html')
    ).toThrow(/loopback/i)
  })

  it('requires the exact expected renderer URL', () => {
    expect(
      isExpectedRendererUrl(
        'http://127.0.0.1:5173/#preview',
        'http://127.0.0.1:5173/'
      )
    ).toBe(true)
    expect(
      isExpectedRendererUrl(
        'http://127.0.0.1:5173/other',
        'http://127.0.0.1:5173/'
      )
    ).toBe(false)
    expect(
      isExpectedRendererUrl(
        'http://localhost:5173/',
        'http://127.0.0.1:5173/'
      )
    ).toBe(false)
  })
})

describe('provider endpoint identity', () => {
  it('normalizes an endpoint without collapsing distinct paths', () => {
    expect(canonicalProviderEndpoint('HTTPS://API.EXAMPLE.COM:443/v1///')).toBe(
      'https://api.example.com/v1'
    )
    expect(canonicalProviderEndpoint('https://api.example.com/v2')).not.toBe(
      canonicalProviderEndpoint('https://api.example.com/v1')
    )
    expect(() =>
      canonicalProviderEndpoint('https://user:secret@api.example.com/v1')
    ).toThrow(/credentials/i)
    expect(() =>
      canonicalProviderEndpoint('https://api.example.com/v1?target=other')
    ).toThrow(/query/i)
    expect(() =>
      canonicalProviderEndpoint('http://api.example.com/v1')
    ).toThrow(/must use HTTPS/i)
    expect(canonicalProviderEndpoint('http://localhost:11434/v1/')).toBe(
      'http://localhost:11434/v1'
    )
    expect(canonicalProviderEndpoint('http://127.42.0.9:1234/v1')).toBe(
      'http://127.42.0.9:1234/v1'
    )
    expect(canonicalProviderEndpoint('http://[::1]:1234/v1')).toBe(
      'http://[::1]:1234/v1'
    )
    expect(() =>
      canonicalProviderEndpoint('http://localhost.example.com/v1')
    ).toThrow(/must use HTTPS/i)
  })
})

describe('workspace grants', () => {
  it('does not disclose a workspace path through reveal failures', async () => {
    const workspace = path.resolve(os.tmpdir(), 'ground-private-workspace')
    const returnedFailure = vi.fn(async () => `Cannot open ${workspace}`)
    const thrownFailure = vi.fn(async () => {
      throw new Error(`Cannot open ${workspace}`)
    })

    await expect(
      revealWorkspacePath(workspace, returnedFailure)
    ).rejects.toThrow('Ground could not reveal this workspace')
    await expect(
      revealWorkspacePath(workspace, thrownFailure)
    ).rejects.toThrow('Ground could not reveal this workspace')
    for (const operation of [returnedFailure, thrownFailure]) {
      expect(operation).toHaveBeenCalledWith(workspace)
      try {
        await revealWorkspacePath(workspace, operation)
      } catch (error) {
        expect((error as Error).message).not.toContain(workspace)
      }
    }
  })

  it('accepts only opaque IDs granted by the main process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ground-grants-'))
    const allowed = path.join(root, 'allowed')
    const denied = path.join(root, 'denied')
    await Promise.all([mkdir(allowed), mkdir(denied)])
    const grants = new WorkspaceGrantRegistry()

    await expect(grants.require(allowed)).rejects.toThrow(/choose this workspace/i)
    const grant = await grants.grant(allowed)
    expect(grant.id).toMatch(/^workspace_/u)
    expect(grant.id).not.toContain(allowed)
    expect(grant).not.toHaveProperty('path')
    await expect(grants.require(grant.id)).resolves.toBe(await realpath(allowed))
    await expect(grants.require(denied)).rejects.toThrow(/choose this workspace/i)
    grants.revoke(grant.id)
    await expect(grants.require(grant.id)).rejects.toThrow(/choose this workspace/i)
  })

  it('deduplicates a path in one process and issues a fresh ID after restart restoration', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-grants-'))
    const firstRegistry = new WorkspaceGrantRegistry()
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => firstRegistry.grant(workspace))
    )
    const first = concurrent[0]
    if (!first) throw new Error('Expected a workspace grant')
    expect(concurrent).toEqual(Array.from({ length: 8 }, () => first))
    expect(await firstRegistry.grant(workspace)).toEqual(first)

    const restoredRegistry = new WorkspaceGrantRegistry()
    await restoredRegistry.restore([undefined, workspace])
    const restored = restoredRegistry.describeStoredPath(workspace)
    expect(restored).toBeDefined()
    expect(restored?.id).not.toBe(first.id)
    await expect(
      restoredRegistry.require(restored?.id as string)
    ).resolves.toBe(await realpath(workspace))
    await expect(restoredRegistry.require(first.id)).rejects.toThrow(
      /choose this workspace/i
    )
  })

  it('issues path-free unique labels for duplicate folder basenames', async () => {
    const firstRoot = await mkdtemp(
      path.join(os.tmpdir(), 'ground-label-first-')
    )
    const secondRoot = await mkdtemp(
      path.join(os.tmpdir(), 'ground-label-second-')
    )
    const firstWorkspace = path.join(firstRoot, 'project')
    const secondWorkspace = path.join(secondRoot, 'project')
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)])
    const grants = new WorkspaceGrantRegistry()

    const first = await grants.grant(firstWorkspace)
    const second = await grants.grant(secondWorkspace)

    expect(first.name).toBe('project')
    expect(second.name).toBe('project · 2')
    expect(second.name).not.toContain(firstRoot)
    expect(second.name).not.toContain(secondRoot)
  })

  it('expires a missing directory without disclosing its path', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-grants-'))
    const grants = new WorkspaceGrantRegistry()
    const grant = await grants.grant(workspace)
    await rm(workspace, { recursive: true })

    let error: unknown
    try {
      await grants.require(grant.id)
    } catch (candidate) {
      error = candidate
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/choose this workspace/i)
    expect((error as Error).message).not.toContain(workspace)
    expect(grants.describeStoredPath(workspace)).toBeUndefined()
  })

  it('expires a grant when another directory replaces the authorized path', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-grants-'))
    const moved = `${workspace}-moved`
    const grants = new WorkspaceGrantRegistry()
    const grant = await grants.grant(workspace)
    await rename(workspace, moved)
    await mkdir(workspace)

    await expect(grants.require(grant.id)).rejects.toThrow(
      /choose this workspace/i
    )
    expect(grants.describeStoredPath(workspace)).toBeUndefined()
    const replacementGrant = await grants.grant(workspace)
    expect(replacementGrant.id).not.toBe(grant.id)
    await expect(grants.require(replacementGrant.id)).resolves.toBe(
      await realpath(workspace)
    )
  })

  it('does not finish an in-flight authorization after its grant is revoked', async () => {
    const identity = {
      canonicalPath: path.resolve(os.tmpdir(), 'ground-virtual-workspace'),
      device: 42,
      inode: 84
    }
    let release: (value: typeof identity) => void = () => undefined
    const blocked = new Promise<typeof identity>((resolve) => {
      release = resolve
    })
    const resolver = vi
      .fn()
      .mockResolvedValueOnce(identity)
      .mockReturnValueOnce(blocked)
    const grants = new WorkspaceGrantRegistry(resolver)
    const grant = await grants.grant(identity.canonicalPath)

    const authorization = grants.require(grant.id)
    grants.revoke(grant.id)
    release(identity)

    await expect(authorization).rejects.toThrow(/choose this workspace/i)
  })

  it.each([
    ['bidirectional override', '\u202e', '\\u{202e}'],
    ['Arabic letter mark', '\u061c', '\\u{061c}'],
    ['left-to-right mark', '\u200e', '\\u{200e}'],
    ['C1 control', '\u0085', '\\u{0085}'],
    ['line separator', '\u2028', '\\u{2028}']
  ])(
    'visibly escapes %s in the display-only folder name',
    async (_label, control, escaped) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'ground-grants-'))
      const workspace = path.join(root, `safe${control}name`)
      await mkdir(workspace)
      const grants = new WorkspaceGrantRegistry()
      const grant = await grants.grant(workspace)

      expect(grant.name).toBe(`safe${escaped}name`)
      expect(grant.name).not.toContain(control)
    }
  )
})

describe('CLI invocation grants', () => {
  it('requires main-owned confirmation and caches only an exact invocation', async () => {
    const confirm = vi.fn(async (_request: CliTrustRequest) => true)
    const grants = new CliTrustRegistry(confirm)
    const base = {
      command: process.execPath,
      args: ['--version'],
      promptMode: 'stdin' as const,
      outputMode: 'plain' as const
    }

    await expect(grants.authorize(base)).resolves.toBe(await realpath(process.execPath))
    await grants.authorize(base)
    expect(confirm).toHaveBeenCalledTimes(1)

    await grants.authorize({ ...base, args: ['--help'] })
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('does not accept a renderer assertion when native confirmation is denied', async () => {
    const grants = new CliTrustRegistry(async () => false)
    const draft: ProviderDraft = {
      name: 'Untrusted',
      kind: 'cli',
      model: '',
      command: process.execPath,
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      trustConfirmed: true
    }
    await expect(grants.authorize(draft)).rejects.toThrow(/not authorized/i)
  })

  it('authorizes the final invocation separately and caches only its exact digest', async () => {
    const confirm = vi.fn(async (_request: CliTrustRequest) => true)
    const grants = new CliTrustRegistry(confirm)
    const template = {
      command: process.execPath,
      args: ['--version'],
      promptMode: 'stdin' as const,
      outputMode: 'plain' as const,
      cliAdapter: 'generic' as const,
      environmentVariables: []
    }
    await grants.authorize(template)
    const invocation = {
      command: process.execPath,
      displayArgs: ['--version'],
      invocationSha256: 'a'.repeat(64),
      cwd: process.cwd(),
      prompt: { transport: 'stdin' as const },
      promptMode: 'stdin' as const,
      outputMode: 'plain' as const,
      cliAdapter: 'generic' as const,
      environmentVariables: []
    }

    const authorized = await grants.authorizeInvocation(invocation)
    expect(authorized.cwd).toBe(await realpath(process.cwd()))
    expect(authorized.launch.executable.path).toBe(await realpath(process.execPath))
    await grants.authorizeInvocation(invocation)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls.map(([request]) => request.phase)).toEqual([
      'configuration',
      'invocation'
    ])

    await grants.authorizeInvocation({
      ...invocation,
      invocationSha256: 'b'.repeat(64)
    })
    expect(confirm).toHaveBeenCalledTimes(3)
  })

  it('invalidates CLI grants when the encrypted environment revision changes', async () => {
    const confirm = vi.fn(async (_request: CliTrustRequest) => true)
    const grants = new CliTrustRegistry(confirm)
    const configuration = {
      command: process.execPath,
      args: ['--version'],
      promptMode: 'stdin' as const,
      outputMode: 'plain' as const,
      cliAdapter: 'generic' as const,
      environmentVariables: ['ACME_AGENT_TOKEN'],
      environmentFingerprint: 'a'.repeat(64)
    }

    await grants.authorize(configuration)
    await grants.authorize(configuration)
    await grants.authorize({
      ...configuration,
      environmentFingerprint: 'b'.repeat(64)
    })
    expect(confirm).toHaveBeenCalledTimes(2)

    const invocation = {
      command: process.execPath,
      displayArgs: ['--version'],
      invocationSha256: 'c'.repeat(64),
      cwd: process.cwd(),
      prompt: { transport: 'stdin' as const },
      promptMode: 'stdin' as const,
      outputMode: 'plain' as const,
      cliAdapter: 'generic' as const,
      environmentVariables: ['ACME_AGENT_TOKEN'],
      environmentFingerprint: 'a'.repeat(64)
    }
    await grants.authorizeInvocation(invocation)
    await grants.authorizeInvocation(invocation)
    await grants.authorizeInvocation({
      ...invocation,
      environmentFingerprint: 'b'.repeat(64)
    })
    expect(confirm).toHaveBeenCalledTimes(4)
    expect(
      confirm.mock.calls.map(([request]) => request.environmentFingerprint)
    ).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
      'a'.repeat(64),
      'b'.repeat(64)
    ])
  })

  it('sends only redacted argument-prompt details to native confirmation', async () => {
    const secretPrompt = 'private prompt with & and %PATH%'
    const confirm = vi.fn(async (_request: CliTrustRequest) => true)
    const grants = new CliTrustRegistry(confirm)

    await grants.authorizeInvocation({
      command: process.execPath,
      displayArgs: ['--prompt', '<prompt omitted>'],
      invocationSha256: 'c'.repeat(64),
      cwd: process.cwd(),
      prompt: {
        transport: 'argument',
        byteLength: Buffer.byteLength(secretPrompt),
        sha256: 'd'.repeat(64)
      },
      promptMode: 'argument',
      outputMode: 'plain',
      cliAdapter: 'generic',
      environmentVariables: []
    })

    const request = confirm.mock.calls[0]?.[0]
    expect(request?.phase).toBe('invocation')
    expect(request?.args).toEqual(['--prompt', '<prompt omitted>'])
    expect(JSON.stringify(request)).not.toContain(secretPrompt)
  })
})
