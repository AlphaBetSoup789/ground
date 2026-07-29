import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cliExecutableSearchDirectories,
  discoverCliExecutable,
  validateCliExecutablePath
} from './cli-executable-discovery'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

describe('CLI executable selection', () => {
  it('returns only a canonical path and never executes the selected file', async () => {
    if (process.platform === 'win32') return
    const directory = await temporaryDirectory('ground-cli-picker-')
    const marker = path.join(directory, 'executed')
    const executable = path.join(directory, 'agent')
    await writeFile(
      executable,
      [
        '#!/bin/sh',
        `printf ran > ${JSON.stringify(marker)}`,
        ''
      ].join('\n'),
      { mode: 0o755 }
    )

    await expect(validateCliExecutablePath(executable)).resolves.toBe(
      await realpath(executable)
    )
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects relative, non-executable, oversized, and shell-script entries', async () => {
    if (process.platform === 'win32') return
    const directory = await temporaryDirectory('ground-cli-picker-invalid-')
    const nonExecutable = path.join(directory, 'not-executable')
    await writeFile(nonExecutable, '#!/bin/sh\n', { mode: 0o644 })
    await expect(validateCliExecutablePath('agent')).rejects.toThrow(
      /absolute executable/u
    )
    await expect(validateCliExecutablePath(nonExecutable)).rejects.toThrow(
      /not executable/u
    )

    const oversized = path.join(directory, 'oversized')
    await writeFile(oversized, '')
    await chmod(oversized, 0o755)
    await truncate(oversized, 512_000_001)
    await expect(validateCliExecutablePath(oversized)).rejects.toThrow(
      /too large/u
    )

    for (const extension of ['bat', 'ps1', 'psm1', 'psd1', 'cmd']) {
      const script = path.join(directory, `agent.${extension}`)
      await writeFile(script, '#!/bin/sh\n', { mode: 0o755 })
      await expect(validateCliExecutablePath(script)).rejects.toThrow(
        /direct executable|recognized Windows/u
      )
    }
  })

  it('rejects an executable controlled by a configured workspace', async () => {
    if (process.platform === 'win32') return
    const directory = await temporaryDirectory('ground-cli-picker-workspace-')
    const workspace = path.join(directory, 'project')
    const executable = path.join(workspace, 'tools', 'agent')
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, '#!/bin/sh\n', { mode: 0o755 })

    await expect(
      validateCliExecutablePath(executable, { workspaceRoots: [workspace] })
    ).rejects.toThrow(/inside a Ground workspace/u)
  })
})

describe('passive CLI discovery locations', () => {
  it('enumerates fixed user manager locations and a bounded nvm default without a shell', async () => {
    if (process.platform === 'win32') return
    const directory = await temporaryDirectory('ground-cli-search-')
    const homeDirectory = path.join(directory, 'home')
    const workspace = path.join(directory, 'workspace')
    const nvmRoot = path.join(homeDirectory, '.nvm')
    await mkdir(path.join(nvmRoot, 'alias'), { recursive: true })
    await mkdir(path.join(nvmRoot, 'versions', 'node', 'v20.2.0'), {
      recursive: true
    })
    await mkdir(path.join(nvmRoot, 'versions', 'node', 'v20.11.1'), {
      recursive: true
    })
    await writeFile(path.join(nvmRoot, 'alias', 'default'), '20\n')

    const directories = await cliExecutableSearchDirectories({
      platform: process.platform,
      homeDirectory,
      environment: {
        PATH: [
          'relative/bin',
          '',
          path.join(workspace, 'bin'),
          '/fixed/tools'
        ].join(path.delimiter),
        NVM_DIR: nvmRoot,
        PNPM_HOME: path.join(homeDirectory, 'pnpm'),
        VOLTA_HOME: 'relative-volta',
        BUN_INSTALL: path.join(homeDirectory, 'custom-bun'),
        ASDF_DATA_DIR: path.join(homeDirectory, 'custom-asdf')
      },
      workspaceRoots: [workspace]
    })

    expect(directories).toContain('/fixed/tools')
    expect(directories).toContain(path.join(homeDirectory, '.local', 'bin'))
    expect(directories).toContain(path.join(homeDirectory, '.volta', 'bin'))
    expect(directories).toContain(path.join(homeDirectory, 'pnpm'))
    expect(directories).toContain(
      path.join(homeDirectory, 'custom-bun', 'bin')
    )
    expect(directories).toContain(
      path.join(homeDirectory, 'custom-asdf', 'shims')
    )
    expect(directories).toContain(
      path.join(nvmRoot, 'versions', 'node', 'v20.11.1', 'bin')
    )
    expect(directories).not.toContain(path.join(workspace, 'bin'))
    expect(directories).not.toContain('relative/bin')
    expect(directories).not.toContain('relative-volta')
  })

  it('includes conventional Windows npm locations and omits relative/workspace PATH entries', async () => {
    const directories = await cliExecutableSearchDirectories({
      platform: 'win32',
      homeDirectory: String.raw`C:\Users\Ada`,
      environment: {
        Path: [
          'relative',
          String.raw`C:\Users\Ada\project\tools`,
          String.raw`C:\Tools`
        ].join(';'),
        APPDATA: String.raw`C:\Users\Ada\AppData\Roaming`,
        LOCALAPPDATA: String.raw`C:\Users\Ada\AppData\Local`,
        ProgramFiles: String.raw`C:\Program Files`,
        'ProgramFiles(x86)': String.raw`C:\Program Files (x86)`
      },
      workspaceRoots: [String.raw`C:\Users\Ada\project`]
    })

    expect(directories).toContain(String.raw`C:\Tools`)
    expect(directories).toContain(
      String.raw`C:\Users\Ada\AppData\Roaming\npm`
    )
    expect(directories).toContain(
      String.raw`C:\Users\Ada\AppData\Local\Programs\nodejs`
    )
    expect(directories).toContain(String.raw`C:\Program Files\nodejs`)
    expect(directories).not.toContain(
      String.raw`C:\Users\Ada\project\tools`
    )
    expect(directories).not.toContain('relative')
  })

  it('ignores a workspace-controlled recognized CLI and does not execute it', async () => {
    if (process.platform === 'win32') return
    const directory = await temporaryDirectory('ground-cli-detect-workspace-')
    const workspace = path.join(directory, 'workspace')
    const bin = path.join(workspace, 'bin')
    const marker = path.join(directory, 'executed')
    await mkdir(bin, { recursive: true })
    const command = 'ground-workspace-only-agent'
    await writeFile(
      path.join(bin, command),
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 }
    )

    await expect(
      discoverCliExecutable(command, {
        environment: { PATH: bin },
        homeDirectory: path.join(directory, 'empty-home'),
        workspaceRoots: [workspace]
      })
    ).resolves.toBeUndefined()
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
