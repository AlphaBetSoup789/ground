import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderDraft } from '../shared/types'
import {
  canonicalProviderEndpoint,
  CliTrustRegistry,
  type CliTrustRequest,
  isExpectedRendererUrl,
  isLoopbackRendererUrl,
  resolveRendererTarget,
  WorkspaceGrantRegistry
} from './trust-boundary'

describe('renderer trust boundary', () => {
  it('ignores a development renderer URL in packaged builds', () => {
    const target = resolveRendererTarget(
      true,
      'http://127.0.0.1:5173',
      '/Applications/Ground.app/renderer/index.html'
    )
    expect(target.kind).toBe('file')
    expect(target.value).toBe(
      'file:///Applications/Ground.app/renderer/index.html'
    )
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
  it('accepts only directories granted by the main process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ground-grants-'))
    const allowed = path.join(root, 'allowed')
    const denied = path.join(root, 'denied')
    await Promise.all([mkdir(allowed), mkdir(denied)])
    const grants = new WorkspaceGrantRegistry()

    await expect(grants.require(allowed)).rejects.toThrow(/choose this workspace/i)
    const canonical = await grants.grant(allowed)
    await expect(grants.require(allowed)).resolves.toBe(canonical)
    await expect(grants.require(denied)).rejects.toThrow(/choose this workspace/i)
    grants.revoke(canonical)
    await expect(grants.require(allowed)).rejects.toThrow(/choose this workspace/i)
    expect(() => grants.revoke('relative/path')).toThrow(/absolute canonical path/i)
  })

  it('can restore grants from previously persisted tasks', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-grants-'))
    const grants = new WorkspaceGrantRegistry()
    await grants.restore([undefined, workspace])
    await expect(grants.require(workspace)).resolves.toBe(await realpath(workspace))
  })
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
