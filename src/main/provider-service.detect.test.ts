import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderDraft, ProviderProfile } from '../shared/types'
import {
  antigravitySupportsStructuredOutput,
  ProviderService
} from './provider-service'
import type { SecretVault } from './secrets'
import type { StateStore } from './store'
import { CliTrustRegistry } from './trust-boundary'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

function detectionService(workspaceRoots: readonly string[] = []): ProviderService {
  return new ProviderService(
    {} as StateStore,
    {} as SecretVault,
    {} as CliTrustRegistry,
    () => false,
    undefined,
    () => workspaceRoots
  )
}

function saveService(
  confirm: () => Promise<boolean>,
  workspaceRoots: readonly string[] = []
): {
  service: ProviderService
  upsertProvider: ReturnType<typeof vi.fn>
} {
  const upsertProvider = vi.fn(async (_provider: ProviderProfile) => undefined)
  const store = {
    getProvider: () => {
      throw new Error('Provider not found')
    },
    upsertProvider,
    publishProviderSecretTransition: vi.fn(
      async (provider: ProviderProfile) => {
        await upsertProvider(provider)
      }
    ),
    pendingSecretDeletes: () => [],
    shouldDeferPendingSecretDeletes: () => false
  }
  const vault = {
    get: vi.fn(() => undefined),
    has: vi.fn(() => false),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    deleteMany: vi.fn(async () => undefined),
    assertSteadyState: vi.fn()
  }
  return {
    service: new ProviderService(
      store as unknown as StateStore,
      vault as unknown as SecretVault,
      new CliTrustRegistry(confirm),
      () => false,
      undefined,
      () => workspaceRoots
    ),
    upsertProvider
  }
}

function antigravityDraft(command: string): ProviderDraft {
  return {
    name: 'Antigravity CLI',
    kind: 'cli',
    model: '',
    command,
    args: ['-p', '{prompt}', '--output-format', 'stream-json'],
    promptMode: 'argument',
    outputMode: 'ndjson',
    cliAdapter: 'antigravity',
    trustConfirmed: true
  }
}

function genericDraft(command: string): ProviderDraft {
  return {
    name: 'Generic CLI',
    kind: 'cli',
    model: '',
    command,
    args: [],
    promptMode: 'stdin',
    outputMode: 'plain',
    cliAdapter: 'generic',
    trustConfirmed: true
  }
}

async function executableExists(candidate: string): Promise<boolean> {
  return access(candidate).then(
    () => true,
    () => false
  )
}

describe.sequential('CLI provider detection', () => {
  it('accepts only stable Antigravity versions with structured output', () => {
    expect(antigravitySupportsStructuredOutput('1.1.8')).toBe(true)
    expect(
      antigravitySupportsStructuredOutput('Antigravity CLI v1.2.0')
    ).toBe(true)
    expect(antigravitySupportsStructuredOutput('1.1.7')).toBe(false)
    expect(antigravitySupportsStructuredOutput('1.1.8-beta.1')).toBe(false)
    expect(antigravitySupportsStructuredOutput('unknown')).toBe(false)
  })

  it('resolves the detected preset without executing untrusted native code', async () => {
    if (process.platform === 'win32') return

    const directory = await mkdtemp(
      path.join(tmpdir(), 'ground-antigravity-detection-')
    )
    temporaryDirectories.push(directory)
    const executable = path.join(directory, 'agy')
    const marker = path.join(directory, 'executed')
    await writeFile(
      executable,
      [
        '#!/usr/bin/env node',
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
        'process.stdout.write("1.1.8\\n")',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )

    const previousPath = process.env.PATH
    process.env.PATH = [directory, previousPath]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter)
    try {
      const detected = (await detectionService().detectClis()).find(
        (candidate) => candidate.id === 'antigravity'
      )
      const canonicalExecutable = await realpath(executable)
      expect(detected).toMatchObject({
        id: 'antigravity',
        path: canonicalExecutable,
        draft: {
          command: canonicalExecutable,
          args: ['-p', '{prompt}', '--output-format', 'stream-json'],
          promptMode: 'argument',
          outputMode: 'ndjson',
          cliAdapter: 'antigravity'
        }
      })
      expect(await executableExists(marker)).toBe(false)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it('refuses a workspace-controlled executable before testing or native save confirmation', async () => {
    if (process.platform === 'win32') return

    const workspace = await mkdtemp(
      path.join(tmpdir(), 'ground-workspace-cli-')
    )
    temporaryDirectories.push(workspace)
    const executable = path.join(workspace, 'agent')
    await writeFile(executable, '#!/bin/sh\n', { mode: 0o755 })

    const testResult = await detectionService([workspace]).test(
      genericDraft(executable)
    )
    expect(testResult).toMatchObject({
      ok: false,
      title: 'Configuration check failed'
    })
    expect(testResult.detail).toMatch(/inside a Ground workspace/u)

    const confirm = vi.fn(async () => true)
    await expect(
      saveService(confirm, [workspace]).service.save(genericDraft(executable))
    ).rejects.toThrow(/inside a Ground workspace/u)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects Antigravity before persistence when the post-authorization probe reports an old version', async () => {
    if (process.platform === 'win32') return

    const directory = await mkdtemp(
      path.join(tmpdir(), 'ground-antigravity-save-')
    )
    temporaryDirectories.push(directory)
    const executable = path.join(directory, 'agy')
    const marker = path.join(directory, 'version-probed')
    await writeFile(
      executable,
      [
        '#!/usr/bin/env node',
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
        'process.stdout.write("1.0.9\\n")',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    let authorized = false
    const harness = saveService(async () => {
      authorized = true
      return true
    })

    await expect(
      harness.service.save(antigravityDraft(executable))
    ).rejects.toThrow(/Antigravity CLI 1\.1\.8 or newer/u)
    expect(authorized).toBe(true)
    expect(await executableExists(marker)).toBe(true)
    expect(harness.upsertProvider).not.toHaveBeenCalled()
  })

  it('persists Antigravity after confirmation and a successful 1.1.8 probe', async () => {
    if (process.platform === 'win32') return

    const directory = await mkdtemp(
      path.join(tmpdir(), 'ground-antigravity-save-')
    )
    temporaryDirectories.push(directory)
    const executable = path.join(directory, 'agy')
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stdout.write("1.1.8\\n")\n',
      { mode: 0o755 }
    )
    const harness = saveService(async () => true)

    const saved = await harness.service.save(
      antigravityDraft(executable)
    )
    expect(saved).toMatchObject({
      kind: 'cli',
      command: await realpath(executable),
      cliAdapter: 'antigravity',
      outputMode: 'ndjson',
      trustConfirmed: true
    })
    expect(harness.upsertProvider).toHaveBeenCalledTimes(1)
  })
})
