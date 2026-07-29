import { realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  createProcessLaunchEnvelope,
  revalidateProcessLaunchEnvelope,
  type ProcessLaunchEnvelope
} from './process-launch'

export type GitExecutableSource =
  | 'conventional'
  | 'search-path'
  | 'picked'

export interface GitExecutableCandidate {
  readonly path: string
  readonly source: Exclude<GitExecutableSource, 'picked'>
}

/**
 * An immutable, main-process-only description of a Git executable that was
 * fingerprinted without executing it. Bindings are intentionally not
 * serializable trust grants: a GitExecutableTrustService only accepts the
 * exact objects it issued during this process lifetime.
 */
export interface GitExecutableBinding {
  readonly version: 1
  readonly source: GitExecutableSource
  readonly path: string
  readonly sha256: string
  readonly size: number
  readonly modifiedMs: number
  readonly changedMs: number
  readonly device: number
  readonly inode: number
  readonly fingerprint: string
}

export type GitWorkspaceRootsProvider = () =>
  | readonly string[]
  | Promise<readonly string[]>

export interface GitExecutableTrustServiceOptions {
  /**
   * Absolute PATH entries selected by trusted main-process configuration.
   * Relative and empty entries are ignored; the ambient working directory is
   * never searched.
   */
  searchPathEntries?: readonly string[]
  /**
   * Resolve every workspace currently capable of influencing a Git launch.
   * The provider is consulted for discovery, picker validation, and every
   * pre-use revalidation so a newly opened workspace cannot widen old trust.
   */
  workspaceRoots: GitWorkspaceRootsProvider
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
}

export interface EnumerateGitExecutableCandidatesOptions {
  workspaceRoots: readonly string[]
  searchPathEntries?: readonly string[]
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
}

interface WorkspaceBoundaries {
  readonly lexical: readonly string[]
  readonly canonical: readonly string[]
}

interface IssuedGitExecutable {
  readonly source: GitExecutableSource
  readonly launch: ProcessLaunchEnvelope
}

function pathApiFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

function comparisonKey(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLowerCase() : value
}

function isAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  return (
    value.length > 0 &&
    !value.includes('\0') &&
    pathApiFor(platform).isAbsolute(value)
  )
}

function normalizedAbsolutePath(
  value: string,
  platform: NodeJS.Platform
): string | undefined {
  if (!isAbsolutePath(value, platform)) return undefined
  return pathApiFor(platform).resolve(value)
}

function pathIsWithin(
  root: string,
  candidate: string,
  platform: NodeJS.Platform
): boolean {
  const pathApi = pathApiFor(platform)
  const relative = pathApi.relative(root, candidate)
  if (relative === '') return true
  if (pathApi.isAbsolute(relative)) return false
  const firstSegment = relative.split(pathApi.sep)[0]
  return firstSegment !== '..'
}

function pathIsWithinAny(
  candidate: string,
  roots: readonly string[],
  platform: NodeJS.Platform
): boolean {
  return roots.some((root) => pathIsWithin(root, candidate, platform))
}

function deduplicatePaths(
  candidates: Iterable<string>,
  platform: NodeJS.Platform
): readonly string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const normalized = normalizedAbsolutePath(candidate, platform)
    if (!normalized) continue
    const key = comparisonKey(normalized, platform)
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(normalized)
  }
  return Object.freeze(paths)
}

function normalizedWorkspaceRoots(
  roots: readonly string[],
  platform: NodeJS.Platform
): readonly string[] {
  for (const root of roots) {
    if (!normalizedAbsolutePath(root, platform)) {
      throw new Error('Workspace roots must be absolute paths')
    }
  }
  return deduplicatePaths(roots, platform)
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return environment[name]
  const actualName = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  )
  return actualName ? environment[actualName] : undefined
}

/**
 * Parse an app-owned PATH value without ever treating an empty entry as the
 * current directory. Environment expansion, quotes, and relative entries are
 * deliberately not interpreted.
 */
export function absoluteGitSearchPathEntries(
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform
): readonly string[] {
  if (!pathValue) return Object.freeze([])
  const pathApi = pathApiFor(platform)
  return deduplicatePaths(pathValue.split(pathApi.delimiter), platform)
}

/**
 * Fixed, conventional Git locations. No directory is enumerated and no
 * executable is run; callers subsequently validate the exact candidate file.
 */
export function conventionalGitExecutablePaths(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): readonly string[] {
  if (platform === 'win32') {
    const pathApi = path.win32
    const programRoots = [
      environmentValue(environment, 'ProgramW6432', platform),
      environmentValue(environment, 'ProgramFiles', platform),
      environmentValue(environment, 'ProgramFiles(x86)', platform)
    ].filter((value): value is string => Boolean(value))
    const localAppData = environmentValue(
      environment,
      'LOCALAPPDATA',
      platform
    )
    const candidates: string[] = []
    for (const root of programRoots) {
      candidates.push(
        pathApi.join(root, 'Git', 'cmd', 'git.exe'),
        pathApi.join(root, 'Git', 'bin', 'git.exe')
      )
    }
    if (localAppData) {
      candidates.push(
        pathApi.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
        pathApi.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe')
      )
    }
    return deduplicatePaths(candidates, platform)
  }

  if (platform === 'darwin') {
    return Object.freeze([
      '/usr/bin/git',
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      '/opt/local/bin/git',
      '/Library/Developer/CommandLineTools/usr/bin/git',
      '/Applications/Xcode.app/Contents/Developer/usr/bin/git'
    ])
  }

  return Object.freeze([
    '/usr/bin/git',
    '/usr/local/bin/git',
    '/bin/git',
    '/snap/bin/git',
    '/opt/bin/git'
  ])
}

export function isDirectGitExecutablePath(
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalized = normalizedAbsolutePath(candidate, platform)
  if (!normalized) return false
  return (
    platform !== 'win32' ||
    path.win32.extname(normalized).toLowerCase() === '.exe'
  )
}

/**
 * Build the exact candidate list without probing the filesystem. Conventional
 * paths precede app-supplied PATH entries, duplicate paths are removed, and
 * paths lexically controlled by a workspace are omitted before any I/O.
 */
export function enumerateGitExecutableCandidates(
  options: EnumerateGitExecutableCandidatesOptions
): readonly GitExecutableCandidate[] {
  const platform = options.platform ?? process.platform
  const roots = normalizedWorkspaceRoots(options.workspaceRoots, platform)
  const candidates: GitExecutableCandidate[] = []
  const seen = new Set<string>()

  const add = (
    candidate: string,
    source: GitExecutableCandidate['source']
  ): void => {
    const normalized = normalizedAbsolutePath(candidate, platform)
    if (
      !normalized ||
      pathIsWithinAny(normalized, roots, platform) ||
      !isDirectGitExecutablePath(normalized, platform)
    ) {
      return
    }
    const key = comparisonKey(normalized, platform)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(Object.freeze({ path: normalized, source }))
  }

  for (const candidate of conventionalGitExecutablePaths(
    platform,
    options.environment
  )) {
    add(candidate, 'conventional')
  }
  const executableName = platform === 'win32' ? 'git.exe' : 'git'
  const pathApi = pathApiFor(platform)
  for (const directory of deduplicatePaths(
    options.searchPathEntries ?? [],
    platform
  )) {
    add(pathApi.join(directory, executableName), 'search-path')
  }
  return Object.freeze(candidates)
}

function sameBinding(
  binding: GitExecutableBinding,
  issued: IssuedGitExecutable
): boolean {
  const identity = issued.launch.entry
  return (
    Object.isFrozen(binding) &&
    binding.version === 1 &&
    binding.source === issued.source &&
    binding.path === identity.path &&
    binding.sha256 === identity.sha256 &&
    binding.size === identity.size &&
    binding.modifiedMs === identity.modifiedMs &&
    binding.changedMs === identity.changedMs &&
    binding.device === identity.device &&
    binding.inode === identity.inode &&
    binding.fingerprint === issued.launch.fingerprint
  )
}

function assertDirectLaunch(
  launch: ProcessLaunchEnvelope,
  platform: NodeJS.Platform
): void {
  if (
    launch.kind !== 'direct' ||
    launch.argumentPrefix.length !== 0 ||
    launch.shim !== undefined ||
    launch.script !== undefined ||
    launch.entry !== launch.executable ||
    !isDirectGitExecutablePath(launch.entry.path, platform)
  ) {
    throw new Error('Git must be a direct executable file')
  }
}

function unavailablePickedGitExecutable(): Error {
  return new Error(
    'The selected Git executable is unavailable, unsafe, or not executable'
  )
}

class WorkspaceControlledGitExecutableError extends Error {
  constructor() {
    super('Git executables inside a workspace cannot be trusted')
    this.name = 'WorkspaceControlledGitExecutableError'
  }
}

function workspaceControlledGitExecutable(): WorkspaceControlledGitExecutableError {
  return new WorkspaceControlledGitExecutableError()
}

export class GitExecutableTrustService {
  private readonly platform: NodeJS.Platform
  private readonly environment: NodeJS.ProcessEnv
  private readonly searchPathEntries: readonly string[]
  private readonly issued = new WeakMap<
    GitExecutableBinding,
    IssuedGitExecutable
  >()

  constructor(private readonly options: GitExecutableTrustServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.environment = { ...(options.environment ?? process.env) }
    this.searchPathEntries = deduplicatePaths(
      options.searchPathEntries ?? [],
      this.platform
    )
  }

  async candidatePaths(): Promise<readonly GitExecutableCandidate[]> {
    const boundaries = await this.workspaceBoundaries()
    const searchPathEntries = await this.resolvedSearchPathEntries(boundaries)
    return enumerateGitExecutableCandidates({
      platform: this.platform,
      environment: this.environment,
      searchPathEntries,
      workspaceRoots: [...boundaries.lexical, ...boundaries.canonical]
    })
  }

  /**
   * Passively fingerprint all available candidates. Invalid, inaccessible, or
   * workspace-controlled candidates are omitted rather than executed.
   */
  async discover(): Promise<readonly GitExecutableBinding[]> {
    const boundaries = await this.workspaceBoundaries()
    const searchPathEntries = await this.resolvedSearchPathEntries(boundaries)
    const candidates = enumerateGitExecutableCandidates({
      platform: this.platform,
      environment: this.environment,
      searchPathEntries,
      workspaceRoots: [...boundaries.lexical, ...boundaries.canonical]
    })
    const bindings: GitExecutableBinding[] = []
    const canonicalPaths = new Set<string>()
    for (const candidate of candidates) {
      try {
        const canonical = await this.canonicalCandidate(
          candidate.path,
          boundaries
        )
        const key = comparisonKey(canonical, this.platform)
        if (canonicalPaths.has(key)) continue
        const binding = await this.bindCanonical(
          canonical,
          candidate.source,
          boundaries
        )
        canonicalPaths.add(key)
        bindings.push(binding)
      } catch {
        // Passive discovery is best-effort and must not make startup brittle.
      }
    }
    return Object.freeze(bindings)
  }

  /**
   * Validate an absolute path selected by a native main-process file picker.
   * Selection authorizes inspection only; the returned identity must still be
   * revalidated immediately before every spawn or other use.
   */
  async validatePickedExecutable(
    candidate: string
  ): Promise<GitExecutableBinding> {
    if (!isDirectGitExecutablePath(candidate, this.platform)) {
      throw unavailablePickedGitExecutable()
    }
    const boundaries = await this.workspaceBoundaries()
    if (
      pathIsWithinAny(
        pathApiFor(this.platform).resolve(candidate),
        boundaries.lexical,
        this.platform
      )
    ) {
      throw workspaceControlledGitExecutable()
    }
    try {
      const canonical = await this.canonicalCandidate(candidate, boundaries)
      return await this.bindCanonical(canonical, 'picked', boundaries)
    } catch (error) {
      if (error instanceof WorkspaceControlledGitExecutableError) throw error
      throw unavailablePickedGitExecutable()
    }
  }

  /**
   * Revalidate the exact canonical path, content hash, metadata, device, and
   * inode immediately before a caller uses the executable. A failed binding is
   * revoked for the remainder of this process lifetime.
   */
  async revalidateBeforeUse(
    binding: GitExecutableBinding
  ): Promise<string> {
    const issued = this.issued.get(binding)
    if (!issued || !sameBinding(binding, issued)) {
      throw new Error('Git executable trust binding is invalid or expired')
    }
    try {
      const boundaries = await this.workspaceBoundaries()
      await this.assertOutsideWorkspaces(issued.launch.entry.path, boundaries)
      await revalidateProcessLaunchEnvelope(issued.launch, {
        platform: this.platform
      })
      await this.assertOutsideWorkspaces(issued.launch.entry.path, boundaries)
      return issued.launch.executable.path
    } catch {
      this.issued.delete(binding)
      throw new Error(
        'Git executable changed, became unavailable, or is now workspace-controlled'
      )
    }
  }

  private async workspaceBoundaries(): Promise<WorkspaceBoundaries> {
    const providedRoots = await this.options.workspaceRoots()
    const lexical = normalizedWorkspaceRoots(providedRoots, this.platform)
    const canonical: string[] = []
    const seen = new Set(
      lexical.map((root) => comparisonKey(root, this.platform))
    )
    for (const root of lexical) {
      try {
        const resolved = await realpath(root)
        const normalized = normalizedAbsolutePath(resolved, this.platform)
        if (!normalized) {
          throw new Error('Workspace root did not resolve to an absolute path')
        }
        const key = comparisonKey(normalized, this.platform)
        if (seen.has(key)) continue
        seen.add(key)
        canonical.push(normalized)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw error
        }
      }
    }
    return {
      lexical,
      canonical: Object.freeze(canonical)
    }
  }

  private async resolvedSearchPathEntries(
    boundaries: WorkspaceBoundaries
  ): Promise<readonly string[]> {
    const roots = [...boundaries.lexical, ...boundaries.canonical]
    const resolvedEntries: string[] = []
    for (const entry of this.searchPathEntries) {
      if (pathIsWithinAny(entry, roots, this.platform)) continue
      try {
        const resolved = await realpath(entry)
        const normalized = normalizedAbsolutePath(resolved, this.platform)
        if (
          !normalized ||
          pathIsWithinAny(normalized, roots, this.platform)
        ) {
          continue
        }
        resolvedEntries.push(normalized)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          code !== 'ENOENT' &&
          code !== 'ENOTDIR' &&
          code !== 'EACCES'
        ) {
          throw error
        }
      }
    }
    return deduplicatePaths(resolvedEntries, this.platform)
  }

  private async canonicalCandidate(
    candidate: string,
    boundaries: WorkspaceBoundaries
  ): Promise<string> {
    const normalized = normalizedAbsolutePath(candidate, this.platform)
    if (!normalized || !isDirectGitExecutablePath(normalized, this.platform)) {
      throw unavailablePickedGitExecutable()
    }
    if (pathIsWithinAny(normalized, boundaries.lexical, this.platform)) {
      throw workspaceControlledGitExecutable()
    }
    const canonical = await realpath(normalized)
    const normalizedCanonical = normalizedAbsolutePath(
      canonical,
      this.platform
    )
    if (!normalizedCanonical) throw unavailablePickedGitExecutable()
    if (
      pathIsWithinAny(
        normalizedCanonical,
        [...boundaries.lexical, ...boundaries.canonical],
        this.platform
      )
    ) {
      throw workspaceControlledGitExecutable()
    }
    return normalizedCanonical
  }

  private async bindCanonical(
    canonical: string,
    source: GitExecutableSource,
    boundaries: WorkspaceBoundaries
  ): Promise<GitExecutableBinding> {
    const launch = await createProcessLaunchEnvelope(canonical, {
      platform: this.platform
    })
    assertDirectLaunch(launch, this.platform)
    await this.assertOutsideWorkspaces(launch.entry.path, boundaries)
    const identity = launch.entry
    const binding = Object.freeze({
      version: 1 as const,
      source,
      path: identity.path,
      sha256: identity.sha256,
      size: identity.size,
      modifiedMs: identity.modifiedMs,
      changedMs: identity.changedMs,
      device: identity.device,
      inode: identity.inode,
      fingerprint: launch.fingerprint
    })
    this.issued.set(binding, Object.freeze({ source, launch }))
    return binding
  }

  private async assertOutsideWorkspaces(
    candidate: string,
    boundaries: WorkspaceBoundaries
  ): Promise<void> {
    const canonical = await realpath(candidate)
    const normalized = normalizedAbsolutePath(canonical, this.platform)
    if (
      !normalized ||
      pathIsWithinAny(
        normalized,
        [...boundaries.lexical, ...boundaries.canonical],
        this.platform
      )
    ) {
      throw workspaceControlledGitExecutable()
    }
  }
}
