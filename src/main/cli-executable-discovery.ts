import { constants } from 'node:fs'
import { open, opendir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createProcessLaunchEnvelope,
  executableCandidates,
  executableSearchPath,
  revalidateProcessLaunchEnvelope,
  type ProcessLaunchEnvelope
} from './process-launch'

const MAX_NVM_ALIAS_BYTES = 512
const MAX_NVM_VERSION_ENTRIES = 512
const FORBIDDEN_SCRIPT_EXTENSIONS = new Set([
  '.BAT',
  '.PS1',
  '.PSD1',
  '.PSM1'
])

export interface CliExecutableSearchOptions {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  homeDirectory?: string
  workspaceRoots?: readonly string[]
}

export interface CliExecutableValidationOptions
  extends CliExecutableSearchOptions {
  pathEntries?: readonly string[]
}

function platformPath(platform: NodeJS.Platform): typeof path {
  return platform === 'win32' ? path.win32 : path
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return environment[key]
  const matchingKey = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase()
  )
  return matchingKey ? environment[matchingKey] : undefined
}

function isWithinRoot(
  candidate: string,
  root: string,
  platform: NodeJS.Platform
): boolean {
  const pathApi = platformPath(platform)
  const relative = pathApi.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  )
}

function isWorkspaceControlled(
  candidate: string,
  workspaceRoots: readonly string[],
  platform: NodeJS.Platform
): boolean {
  return workspaceRoots.some((root) =>
    isWithinRoot(candidate, root, platform)
  )
}

async function canonicalWorkspaceRoots(
  roots: readonly string[],
  platform: NodeJS.Platform
): Promise<string[]> {
  const pathApi = platformPath(platform)
  const canonical = new Set<string>()
  for (const root of roots) {
    if (
      typeof root !== 'string' ||
      root.includes('\0') ||
      !pathApi.isAbsolute(root)
    ) {
      continue
    }
    const resolved = pathApi.resolve(root)
    if (platform === process.platform) {
      canonical.add(await realpath(resolved).catch(() => resolved))
    } else {
      canonical.add(resolved)
    }
  }
  return [...canonical]
}

function launchIdentityPaths(launch: ProcessLaunchEnvelope): string[] {
  return [
    launch.entry.path,
    launch.executable.path,
    ...(launch.shim ? [launch.shim.path] : []),
    ...(launch.script ? [launch.script.path] : [])
  ]
}

async function readBoundedNvmAlias(
  aliasPath: string
): Promise<string | undefined> {
  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(aliasPath, constants.O_RDONLY | noFollow)
    const details = await handle.stat()
    if (!details.isFile() || details.size > MAX_NVM_ALIAS_BYTES) {
      return undefined
    }
    const buffer = Buffer.alloc(details.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== buffer.length) return undefined
    const value = buffer.toString('utf8').trim()
    return /^v?\d+(?:\.\d+){0,2}$/u.test(value) ? value : undefined
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      code === 'EACCES' ||
      code === 'ELOOP'
    ) {
      return undefined
    }
    throw error
  } finally {
    await handle?.close()
  }
}

function semanticVersion(
  value: string
): readonly [number, number, number] | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(value)
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined
}

function compareSemanticVersions(left: string, right: string): number {
  const leftVersion = semanticVersion(left)
  const rightVersion = semanticVersion(right)
  if (!leftVersion || !rightVersion) return 0
  for (let index = 0; index < leftVersion.length; index += 1) {
    const difference =
      (leftVersion[index] as number) - (rightVersion[index] as number)
    if (difference !== 0) return difference
  }
  return 0
}

async function nvmDefaultBin(nvmRoot: string): Promise<string | undefined> {
  const alias = await readBoundedNvmAlias(path.join(nvmRoot, 'alias', 'default'))
  if (!alias) return undefined
  const requested = alias.replace(/^v/u, '').split('.').map(Number)
  const versionsDirectory = path.join(nvmRoot, 'versions', 'node')
  let directory: Awaited<ReturnType<typeof opendir>> | undefined
  const matches: string[] = []
  try {
    directory = await opendir(versionsDirectory)
    let inspected = 0
    for await (const entry of directory) {
      inspected += 1
      if (inspected > MAX_NVM_VERSION_ENTRIES) break
      if (!entry.isDirectory()) continue
      const version = semanticVersion(entry.name)
      if (
        version &&
        requested.every((component, index) => component === version[index])
      ) {
        matches.push(entry.name)
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'ENOENT' &&
      code !== 'ENOTDIR' &&
      code !== 'EACCES'
    ) {
      throw error
    }
  } finally {
    await directory?.close().catch(() => undefined)
  }
  const selected = matches.sort(compareSemanticVersions).at(-1)
  return selected
    ? path.join(versionsDirectory, selected, 'bin')
    : undefined
}

/**
 * Returns a bounded, non-recursive set of directories used only for passive
 * recognized-CLI detection. Nothing in these directories is executed here.
 */
export async function cliExecutableSearchDirectories(
  options: CliExecutableSearchOptions = {}
): Promise<readonly string[]> {
  const platform = options.platform ?? process.platform
  const pathApi = platformPath(platform)
  const environment = options.environment ?? process.env
  const homeDirectory = options.homeDirectory ?? os.homedir()
  const workspaceRoots = options.workspaceRoots ?? []
  const directories: string[] = []

  const add = (candidate: string | undefined): void => {
    if (
      !candidate ||
      candidate.includes('\0') ||
      !pathApi.isAbsolute(candidate)
    ) {
      return
    }
    const resolved = pathApi.resolve(candidate)
    if (
      isWorkspaceControlled(resolved, workspaceRoots, platform) ||
      directories.includes(resolved)
    ) {
      return
    }
    directories.push(resolved)
  }

  const rawPath = environmentValue(environment, 'PATH', platform) ?? ''
  for (const entry of rawPath.split(pathApi.delimiter)) add(entry)

  if (platform === 'win32') {
    const userProfile =
      environmentValue(environment, 'USERPROFILE', platform) ??
      homeDirectory
    const appData = environmentValue(environment, 'APPDATA', platform)
    const localAppData = environmentValue(
      environment,
      'LOCALAPPDATA',
      platform
    )
    const programFiles = environmentValue(
      environment,
      'ProgramFiles',
      platform
    )
    const programFilesX86 = environmentValue(
      environment,
      'ProgramFiles(x86)',
      platform
    )
    add(appData ? pathApi.join(appData, 'npm') : undefined)
    add(localAppData ? pathApi.join(localAppData, 'pnpm') : undefined)
    add(
      localAppData
        ? pathApi.join(localAppData, 'Programs', 'nodejs')
        : undefined
    )
    add(programFiles ? pathApi.join(programFiles, 'nodejs') : undefined)
    add(programFilesX86 ? pathApi.join(programFilesX86, 'nodejs') : undefined)
    add(
      pathApi.isAbsolute(userProfile)
        ? pathApi.join(userProfile, '.volta', 'bin')
        : undefined
    )
    add(
      pathApi.isAbsolute(userProfile)
        ? pathApi.join(userProfile, '.bun', 'bin')
        : undefined
    )
    return Object.freeze(directories)
  }

  add('/opt/homebrew/bin')
  add('/usr/local/bin')
  add('/usr/bin')
  add('/bin')
  if (platform === 'linux') add('/snap/bin')

  if (pathApi.isAbsolute(homeDirectory)) {
    add(pathApi.join(homeDirectory, '.local', 'bin'))
    add(pathApi.join(homeDirectory, '.volta', 'bin'))
    add(pathApi.join(homeDirectory, '.bun', 'bin'))
    add(pathApi.join(homeDirectory, '.asdf', 'shims'))
    add(
      platform === 'darwin'
        ? pathApi.join(homeDirectory, 'Library', 'pnpm')
        : pathApi.join(homeDirectory, '.local', 'share', 'pnpm')
    )
  }

  const voltaHome = environmentValue(environment, 'VOLTA_HOME', platform)
  add(
    voltaHome && pathApi.isAbsolute(voltaHome)
      ? pathApi.join(voltaHome, 'bin')
      : undefined
  )
  const pnpmHome = environmentValue(environment, 'PNPM_HOME', platform)
  add(pnpmHome)
  const bunInstall = environmentValue(environment, 'BUN_INSTALL', platform)
  add(
    bunInstall && pathApi.isAbsolute(bunInstall)
      ? pathApi.join(bunInstall, 'bin')
      : undefined
  )
  const asdfData = environmentValue(environment, 'ASDF_DATA_DIR', platform)
  add(
    asdfData && pathApi.isAbsolute(asdfData)
      ? pathApi.join(asdfData, 'shims')
      : undefined
  )

  const configuredNvmRoot = environmentValue(
    environment,
    'NVM_DIR',
    platform
  )
  const nvmRoot =
    configuredNvmRoot && pathApi.isAbsolute(configuredNvmRoot)
      ? configuredNvmRoot
      : pathApi.isAbsolute(homeDirectory)
        ? pathApi.join(homeDirectory, '.nvm')
        : undefined
  const nvmBin = environmentValue(environment, 'NVM_BIN', platform)
  add(nvmBin)
  if (
    nvmRoot &&
    !isWorkspaceControlled(
      pathApi.resolve(nvmRoot),
      workspaceRoots,
      platform
    )
  ) {
    add(pathApi.join(nvmRoot, 'current', 'bin'))
    add(await nvmDefaultBin(nvmRoot))
  }

  return Object.freeze(directories)
}

/**
 * Validates a user-selected executable without running it. The returned value
 * is the canonical entry path only; the launch identity remains main-owned.
 */
export async function validateCliExecutablePath(
  candidate: string,
  options: CliExecutableValidationOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform
  const pathApi = platformPath(platform)
  if (
    typeof candidate !== 'string' ||
    candidate.includes('\0') ||
    !pathApi.isAbsolute(candidate)
  ) {
    throw new Error('Choose an absolute executable file')
  }

  const extension = pathApi.extname(candidate).toUpperCase()
  if (
    FORBIDDEN_SCRIPT_EXTENSIONS.has(extension) ||
    (extension === '.CMD' && platform !== 'win32')
  ) {
    throw new Error(
      'Choose a direct executable or a recognized Windows Node package .cmd shim'
    )
  }

  const pathEntries =
    options.pathEntries ??
    executableSearchPath(options.environment ?? process.env, platform)
      .split(pathApi.delimiter)
      .filter((entry) => entry && pathApi.isAbsolute(entry))
  const launchOptions = {
    platform,
    pathEntries
  }
  const launch = await createProcessLaunchEnvelope(candidate, launchOptions)
  await revalidateProcessLaunchEnvelope(launch, launchOptions)

  const workspaceRoots = await canonicalWorkspaceRoots(
    options.workspaceRoots ?? [],
    platform
  )
  if (
    launchIdentityPaths(launch).some((launchPath) =>
      isWorkspaceControlled(launchPath, workspaceRoots, platform)
    )
  ) {
    throw new Error(
      'Executables and package scripts inside a Ground workspace cannot be selected'
    )
  }
  return launch.entry.path
}

export async function discoverCliExecutable(
  command: string,
  options: CliExecutableSearchOptions = {}
): Promise<string | undefined> {
  if (
    typeof command !== 'string' ||
    !command ||
    command.includes('\0') ||
    command.includes('/') ||
    command.includes('\\')
  ) {
    return undefined
  }
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  const pathApi = platformPath(platform)
  const directories = await cliExecutableSearchDirectories({
    ...options,
    platform,
    environment
  })
  const pathExt = environmentValue(environment, 'PATHEXT', platform)
  const names = new Set(executableCandidates(command, platform, pathExt))
  if (platform === 'win32') {
    names.add(`${command}.EXE`)
    names.add(`${command}.COM`)
    names.add(`${command}.CMD`)
  }
  for (const directory of directories) {
    for (const name of names) {
      try {
        return await validateCliExecutablePath(pathApi.join(directory, name), {
          ...options,
          platform,
          environment,
          pathEntries: directories
        })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          code === 'ENOENT' ||
          code === 'ENOTDIR' ||
          code === 'EACCES'
        ) {
          continue
        }
        // An unsafe or malformed candidate must not prevent Ground from
        // checking the next fixed location for the same recognized CLI.
        continue
      }
    }
  }
  return undefined
}
