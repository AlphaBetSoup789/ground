import {
  access,
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  absoluteGitSearchPathEntries,
  conventionalGitExecutablePaths,
  enumerateGitExecutableCandidates,
  GitExecutableTrustService,
  isDirectGitExecutablePath,
  type GitExecutableBinding
} from './git-executable-discovery'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ground-git-discovery-')
  )
  temporaryDirectories.push(directory)
  return directory
}

async function createExecutable(
  directory: string,
  marker?: string
): Promise<string> {
  const executable = path.join(
    directory,
    process.platform === 'win32' ? 'git.exe' : 'git'
  )
  if (process.platform === 'win32') {
    await copyFile(process.execPath, executable)
  } else {
    await writeFile(
      executable,
      [
        '#!/bin/sh',
        marker ? `printf executed > ${JSON.stringify(marker)}` : 'exit 0',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
  }
  return executable
}

async function pathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(
    () => true,
    () => false
  )
}

describe('Git executable candidate policy', () => {
  it('parses only absolute app-owned PATH entries and never implies cwd', () => {
    if (process.platform === 'win32') {
      expect(
        absoluteGitSearchPathEntries(
          String.raw`C:\Tools;.\workspace;;C:\Other;C:\Tools`,
          'win32'
        )
      ).toEqual([String.raw`C:\Tools`, String.raw`C:\Other`])
      return
    }
    expect(
      absoluteGitSearchPathEntries('/opt/tools:./workspace::/usr/bin:/opt/tools')
    ).toEqual(['/opt/tools', '/usr/bin'])
  })

  it('uses only direct .exe candidates at conventional Windows locations', () => {
    const candidates = conventionalGitExecutablePaths('win32', {
      ProgramFiles: String.raw`C:\Program Files`,
      'ProgramFiles(x86)': String.raw`C:\Program Files (x86)`,
      LOCALAPPDATA: String.raw`C:\Users\Ada\AppData\Local`
    })

    expect(candidates).toContain(
      String.raw`C:\Program Files\Git\cmd\git.exe`
    )
    expect(candidates).toContain(
      String.raw`C:\Users\Ada\AppData\Local\Programs\Git\bin\git.exe`
    )
    expect(candidates.every((candidate) => candidate.endsWith('.exe'))).toBe(
      true
    )
    expect(
      isDirectGitExecutablePath(String.raw`C:\Tools\git.exe`, 'win32')
    ).toBe(true)
    expect(
      isDirectGitExecutablePath(String.raw`C:\Tools\git.cmd`, 'win32')
    ).toBe(false)
    expect(
      isDirectGitExecutablePath(String.raw`C:\Tools\git.bat`, 'win32')
    ).toBe(false)
  })

  it('omits workspace PATH entries before any filesystem discovery', async () => {
    const parent = await temporaryRoot()
    const workspace = path.join(parent, 'workspace')
    const trustedTools = path.join(parent, 'trusted-tools')
    await Promise.all([mkdir(workspace), mkdir(trustedTools)])

    const candidates = enumerateGitExecutableCandidates({
      platform: process.platform,
      environment: {},
      workspaceRoots: [workspace],
      searchPathEntries: [
        workspace,
        path.join(workspace, 'nested'),
        trustedTools,
        'relative-tools'
      ]
    })

    expect(
      candidates.some((candidate) =>
        candidate.path.startsWith(`${workspace}${path.sep}`)
      )
    ).toBe(false)
    expect(candidates).toContainEqual({
      path: path.join(
        trustedTools,
        process.platform === 'win32' ? 'git.exe' : 'git'
      ),
      source: 'search-path'
    })
  })

  it('fails closed on relative workspace roots and safely deduplicates repeats', () => {
    expect(() =>
      enumerateGitExecutableCandidates({
        workspaceRoots: ['relative-workspace']
      })
    ).toThrow(/workspace roots/i)

    const root =
      process.platform === 'win32'
        ? String.raw`C:\workspace`
        : '/private/workspace'
    const once = enumerateGitExecutableCandidates({
      platform: process.platform,
      workspaceRoots: [root],
      environment: {}
    })
    expect(
      enumerateGitExecutableCandidates({
        platform: process.platform,
        workspaceRoots: [root, root],
        environment: {}
      })
    ).toEqual(once)
  })
})

describe('Git executable trust service', () => {
  it('discovers and fingerprints candidates without executing them', async () => {
    const parent = await temporaryRoot()
    const tools = path.join(parent, 'tools')
    const workspace = path.join(parent, 'workspace')
    const marker = path.join(parent, 'executed')
    await Promise.all([mkdir(tools), mkdir(workspace)])
    const executable = await createExecutable(tools, marker)
    const service = new GitExecutableTrustService({
      searchPathEntries: [tools],
      workspaceRoots: () => [workspace]
    })

    const discovered = await service.discover()
    const canonical = await realpath(executable)
    const binding = discovered.find((entry) => entry.path === canonical)

    expect(binding).toMatchObject({
      version: 1,
      source: 'search-path',
      path: canonical
    })
    expect(binding?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(binding?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(await pathExists(marker)).toBe(false)
  })

  it('rejects picked executables inside a workspace through direct and symlink paths', async () => {
    const parent = await temporaryRoot()
    const workspace = path.join(parent, 'workspace')
    const linkedWorkspace = path.join(parent, 'linked-workspace')
    await mkdir(workspace)
    const executable = await createExecutable(workspace)
    await symlink(
      workspace,
      linkedWorkspace,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const service = new GitExecutableTrustService({
      workspaceRoots: () => [workspace]
    })

    await expect(
      service.validatePickedExecutable(executable)
    ).rejects.toThrow(/inside a workspace/i)
    await expect(
      service.validatePickedExecutable(
        path.join(linkedWorkspace, path.basename(executable))
      )
    ).rejects.toThrow(/inside a workspace/i)
  })

  it('omits a workspace canonical path even when the workspace was granted through an alias', async () => {
    const parent = await temporaryRoot()
    const workspace = path.join(parent, 'workspace')
    const workspaceAlias = path.join(parent, 'workspace-alias')
    await mkdir(workspace)
    await symlink(
      workspace,
      workspaceAlias,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const service = new GitExecutableTrustService({
      searchPathEntries: [workspace],
      workspaceRoots: () => [workspaceAlias]
    })

    const candidates = await service.candidatePaths()
    const canonicalWorkspace = await realpath(workspace)
    expect(
      candidates.some((candidate) =>
        candidate.path.startsWith(`${canonicalWorkspace}${path.sep}`)
      )
    ).toBe(false)
  })

  it('canonicalizes a picked executable and revalidates its exact identity', async () => {
    const parent = await temporaryRoot()
    const tools = path.join(parent, 'tools')
    const workspace = path.join(parent, 'workspace')
    await Promise.all([mkdir(tools), mkdir(workspace)])
    const executable = await createExecutable(tools)
    const service = new GitExecutableTrustService({
      workspaceRoots: () => [workspace]
    })
    const binding = await service.validatePickedExecutable(executable)

    expect(binding.source).toBe('picked')
    expect(binding.path).toBe(await realpath(executable))
    await expect(service.revalidateBeforeUse(binding)).resolves.toBe(
      binding.path
    )

    await appendFile(executable, '\nchanged\n')
    if (process.platform !== 'win32') await chmod(executable, 0o755)
    await expect(service.revalidateBeforeUse(binding)).rejects.toThrow(
      /changed|unavailable/i
    )
    await expect(service.revalidateBeforeUse(binding)).rejects.toThrow(
      /invalid|expired/i
    )
  })

  it('rejects copied or fabricated binding objects', async () => {
    const parent = await temporaryRoot()
    const tools = path.join(parent, 'tools')
    await mkdir(tools)
    const executable = await createExecutable(tools)
    const service = new GitExecutableTrustService({
      workspaceRoots: () => []
    })
    const binding = await service.validatePickedExecutable(executable)
    const copied = Object.freeze({ ...binding }) as GitExecutableBinding

    await expect(service.revalidateBeforeUse(copied)).rejects.toThrow(
      /invalid|expired/i
    )
    await expect(service.revalidateBeforeUse(binding)).resolves.toBe(
      binding.path
    )
  })

  it('revokes an old binding when a workspace later gains control of its path', async () => {
    const parent = await temporaryRoot()
    const tools = path.join(parent, 'tools')
    await mkdir(tools)
    const executable = await createExecutable(tools)
    let workspaceRoots: readonly string[] = []
    const service = new GitExecutableTrustService({
      workspaceRoots: () => workspaceRoots
    })
    const binding = await service.validatePickedExecutable(executable)

    workspaceRoots = [tools]
    await expect(service.revalidateBeforeUse(binding)).rejects.toThrow(
      /workspace-controlled/i
    )
  })

  it('rejects relative, non-executable, and Windows shim picker results', async () => {
    const service = new GitExecutableTrustService({
      workspaceRoots: () => []
    })
    await expect(
      service.validatePickedExecutable('relative/git')
    ).rejects.toThrow(/unavailable|unsafe/i)

    if (process.platform !== 'win32') {
      const parent = await temporaryRoot()
      const candidate = path.join(parent, 'git')
      await writeFile(candidate, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
      await expect(
        service.validatePickedExecutable(candidate)
      ).rejects.toThrow(/not executable|unavailable/i)
    }

    expect(
      isDirectGitExecutablePath(String.raw`C:\Tools\git.cmd`, 'win32')
    ).toBe(false)
    expect(
      isDirectGitExecutablePath(String.raw`C:\Tools\git.bat`, 'win32')
    ).toBe(false)
  })
})
