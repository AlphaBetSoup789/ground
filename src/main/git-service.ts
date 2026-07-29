import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { terminateProcessTree } from './process-tree'

const DEFAULT_TIMEOUT_MS = 15_000
const MUTATION_TIMEOUT_MS = 60_000
const TERMINATION_GRACE_MS = 1_500
const DEFAULT_DIFF_BYTES = 1_000_000
const DEFAULT_LOG_BYTES = 2_000_000
const DEFAULT_MAX_OUTPUT_BYTES = 8_000_000
const MIN_OUTPUT_BYTES = 128
const MAX_TIMEOUT_MS = 120_000
const MAX_LOG_ENTRIES = 200
const MAX_FILTER_DRIVERS = 256
const MAX_FILTER_CONFIG_BYTES = 262_144
const MAX_MUTATION_PATHS = 256
const MAX_MUTATION_PATH_BYTES = 4_096
const MAX_MUTATION_PATH_TOTAL_BYTES = 32_768
const MAX_COMMIT_MESSAGE_BYTES = 65_536
const MAX_IDENTITY_BYTES = 1_024
const SENSITIVE_METADATA_SEGMENTS = new Set(['.git', '.hg', '.svn'])

type TerminationReason = 'abort' | 'timeout' | 'output-limit'

interface ProcessResult {
  stdout: string
  stderr: string
  truncated: boolean
}

interface RunProcessOptions {
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
  maxOutputBytes: number
  allowTruncation?: boolean
}

interface RawWorktree {
  absolutePath: string
  head: string
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

export type GitServiceErrorCode =
  | 'ABORTED'
  | 'COMMAND_FAILED'
  | 'INVALID_ARGUMENT'
  | 'NOT_A_REPOSITORY'
  | 'NOT_FOUND'
  | 'OUTPUT_LIMIT'
  | 'TIMEOUT'
  | 'UNSAFE_CONFIGURATION'
  | 'UNSAFE_PATH'
  | 'WORKTREE_DIRTY'

export class GitServiceError extends Error {
  readonly code: GitServiceErrorCode
  readonly exitCode?: number
  readonly stderr?: string

  constructor(
    code: GitServiceErrorCode,
    message: string,
    options: { cause?: unknown; exitCode?: number; stderr?: string } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'GitServiceError'
    this.code = code
    this.exitCode = options.exitCode
    this.stderr = options.stderr
  }
}

export interface GitServiceOptions {
  /**
   * An absolute workspace path. The factory resolves it once and pins all
   * repository operations to that canonical directory.
   */
  workspacePath: string
  /**
   * An existing, dedicated directory outside the workspace. Ground-created
   * worktrees must be descendants of this root.
   */
  worktreeRoot: string
  /**
   * An optional absolute Git executable. When omitted, only conventional
   * system installation locations are searched.
   */
  gitExecutable?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface GitOperationOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface GitStatusSummary {
  branch: string | null
  detached: boolean
  ahead?: number
  behind?: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
  conflicted: string[]
}

export interface GitDiffOptions extends GitOperationOptions {
  staged?: boolean
  path?: string
  contextLines?: number
  maxBytes?: number
}

export interface GitDiffResult {
  text: string
  truncated: boolean
  bytes: number
}

export interface GitLogOptions extends GitOperationOptions {
  limit?: number
  maxBytes?: number
}

export interface GitLogEntry {
  hash: string
  shortHash: string
  authorName: string
  authorEmail: string
  authoredAt: string
  parents: string[]
  subject: string
  body: string
}

export interface GitLogResult {
  entries: GitLogEntry[]
  truncated: boolean
}

export interface GitWorktreeSummary {
  /**
   * "." identifies the main workspace. Every other value is relative to the
   * configured Ground worktree root; absolute host paths are never exposed.
   */
  relativePath: string
  isMain: boolean
  head: string
  branch: string | null
  detached: boolean
  locked: boolean
  prunable: boolean
}

export interface CreateGitWorktreeOptions extends GitOperationOptions {
  relativePath: string
  branch: string
  /**
   * Defaults to true. If false, `branch` must already resolve to a commit and
   * `startPoint` must be omitted.
   */
  createBranch?: boolean
  startPoint?: string
}

export interface RemoveGitWorktreeOptions extends GitOperationOptions {
  relativePath: string
  force?: boolean
}

export interface GitIdentity {
  name?: string
  email?: string
}

export type GitPathMutationKind = 'stage' | 'unstage'

export interface PreparedGitPathMutation {
  readonly kind: GitPathMutationKind
  readonly paths: readonly string[]
}

export interface PreparedGitCommit {
  readonly treeOid: string
  readonly expectedHeadOid: string | null
  readonly branch: string | null
  readonly detached: boolean
  readonly stagedPaths: readonly string[]
}

export interface GitCommitOptions extends GitOperationOptions {
  message: string
  authorName: string
  authorEmail: string
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function escapeUnsafeDisplayCharacters(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u{${character.codePointAt(0)?.toString(16).padStart(4, '0')}}`
  )
}

function escapeUnsafeMultilineText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u{${character.codePointAt(0)?.toString(16).padStart(4, '0')}}`
  )
}

function toDisplayPath(value: string): string {
  const withPortableSeparators =
    path.sep === '/' ? value : value.split(path.sep).join('/')
  return escapeUnsafeDisplayCharacters(withPortableSeparators)
}

function safeDiagnostic(value: string): string {
  return escapeUnsafeDisplayCharacters(value).trim().slice(0, 4_000)
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new GitServiceError(
      'INVALID_ARGUMENT',
      `Timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`
    )
  }
  return Math.floor(value)
}

function boundedOutputLimit(value: number | undefined, fallback: number, hardLimit: number): number {
  if (value === undefined) return Math.min(fallback, hardLimit)
  if (!Number.isFinite(value) || value < MIN_OUTPUT_BYTES || value > hardLimit) {
    throw new GitServiceError(
      'INVALID_ARGUMENT',
      `Output limit must be between ${MIN_OUTPUT_BYTES} and ${hardLimit} bytes`
    )
  }
  return Math.floor(value)
}

function abortError(): DOMException {
  return new DOMException('Git operation stopped', 'AbortError')
}

function sendProcessSignal(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  terminateProcessTree(child, signal)
}

function minimalGitEnvironment(executable: string, cwd: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(cwd),
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PAGER: 'cat',
    PATH: path.dirname(executable),
    TERM: 'dumb'
  }
  if (process.platform === 'win32') {
    environment.SystemRoot = process.env.SystemRoot
  }
  return environment
}

async function runAbsoluteProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions
): Promise<ProcessResult> {
  if (options.signal?.aborted) throw abortError()

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: minimalGitEnvironment(executable, options.cwd),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let capturedBytes = 0
    let settled = false
    let terminationReason: TerminationReason | undefined
    let killTimer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort)
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
    }

    const settleError = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const beginTermination = (reason: TerminationReason): void => {
      if (terminationReason || settled) return
      terminationReason = reason
      sendProcessSignal(child, 'SIGTERM')
      killTimer = setTimeout(() => sendProcessSignal(child, 'SIGKILL'), TERMINATION_GRACE_MS)
      killTimer.unref()
    }

    const onAbort = (): void => beginTermination('abort')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) beginTermination('abort')

    const timeoutTimer = setTimeout(
      () => beginTermination('timeout'),
      options.timeoutMs
    )
    timeoutTimer.unref()

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, options.maxOutputBytes - capturedBytes)
      if (remaining > 0) {
        const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
        target.push(accepted)
        capturedBytes += accepted.byteLength
      }
      if (chunk.byteLength > remaining) beginTermination('output-limit')
    }

    child.stdout.on('data', (chunk: Buffer) => capture(stdoutChunks, chunk))
    child.stderr.on('data', (chunk: Buffer) => capture(stderrChunks, chunk))
    child.once('error', (error) => {
      settleError(
        new GitServiceError('COMMAND_FAILED', 'Unable to start the Git process', {
          cause: error
        })
      )
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      cleanup()
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')

      if (terminationReason === 'abort') {
        reject(abortError())
        return
      }
      if (terminationReason === 'timeout') {
        reject(
          new GitServiceError(
            'TIMEOUT',
            `Git operation timed out after ${options.timeoutMs} milliseconds`
          )
        )
        return
      }
      if (terminationReason === 'output-limit') {
        if (options.allowTruncation) {
          resolve({ stdout, stderr, truncated: true })
        } else {
          reject(
            new GitServiceError(
              'OUTPUT_LIMIT',
              `Git output exceeded the ${options.maxOutputBytes} byte safety limit`
            )
          )
        }
        return
      }
      if (exitCode !== 0) {
        const diagnostic = safeDiagnostic(stderr)
        reject(
          new GitServiceError(
            'COMMAND_FAILED',
            `Git exited with code ${exitCode ?? 'unknown'}${
              diagnostic ? `: ${diagnostic}` : ''
            }`,
            { exitCode: exitCode ?? undefined, stderr: diagnostic || undefined }
          )
        )
        return
      }
      resolve({ stdout, stderr, truncated: false })
    })
  })
}

async function canonicalDirectory(input: string, label: string): Promise<string> {
  if (!path.isAbsolute(input)) {
    throw new GitServiceError('UNSAFE_PATH', `${label} must be an absolute path`)
  }
  let canonical: string
  try {
    canonical = await realpath(path.resolve(input))
    const details = await stat(canonical)
    if (!details.isDirectory()) {
      throw new GitServiceError('UNSAFE_PATH', `${label} must be a directory`)
    }
  } catch (error) {
    if (error instanceof GitServiceError) throw error
    throw new GitServiceError('NOT_FOUND', `${label} does not exist`, { cause: error })
  }
  return canonical
}

async function verifiedExecutable(candidate: string): Promise<string | undefined> {
  if (!path.isAbsolute(candidate)) return undefined
  try {
    const canonical = await realpath(candidate)
    const details = await stat(canonical)
    if (!details.isFile()) return undefined
    await access(canonical, constants.X_OK)
    return canonical
  } catch {
    return undefined
  }
}

function defaultGitCandidates(): string[] {
  if (process.platform === 'win32') {
    return [
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe')
        : '',
      process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe')
        : ''
    ].filter(Boolean)
  }
  if (process.platform === 'darwin') {
    return ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
  }
  return ['/usr/bin/git', '/bin/git', '/usr/local/bin/git']
}

/**
 * Resolve Git without invoking a shell or trusting the process working
 * directory. A custom executable must be absolute; default discovery only
 * considers conventional system installation paths.
 */
export async function resolveGitExecutable(
  explicitExecutable?: string
): Promise<string | undefined> {
  const candidates = explicitExecutable ? [explicitExecutable] : defaultGitCandidates()
  for (const candidate of candidates) {
    const executable = await verifiedExecutable(candidate)
    if (executable) return executable
  }
  return undefined
}

function parseStatus(output: string): GitStatusSummary {
  let branch: string | null = null
  let detached = false
  let ahead: number | undefined
  let behind: number | undefined
  const staged = new Set<string>()
  const unstaged = new Set<string>()
  const untracked = new Set<string>()
  const conflicted = new Set<string>()
  const fields = output.split('\0')

  const addTrackedStatus = (xy: string, rawPath: string, forceConflict = false): void => {
    const displayPath = toDisplayPath(rawPath)
    const indexState = xy[0] ?? '.'
    const worktreeState = xy[1] ?? '.'
    if (indexState !== '.') staged.add(displayPath)
    if (worktreeState !== '.') unstaged.add(displayPath)
    if (
      forceConflict ||
      indexState === 'U' ||
      worktreeState === 'U' ||
      xy === 'AA' ||
      xy === 'DD'
    ) {
      conflicted.add(displayPath)
    }
  }

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index] as string
    if (!record) continue
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length)
      if (head === '(detached)') {
        detached = true
        branch = null
      } else {
        branch = escapeUnsafeDisplayCharacters(head)
      }
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }
    if (record.startsWith('1 ')) {
      const parts = record.split(' ')
      addTrackedStatus(parts[1] ?? '..', parts.slice(8).join(' '))
      continue
    }
    if (record.startsWith('2 ')) {
      const parts = record.split(' ')
      addTrackedStatus(parts[1] ?? '..', parts.slice(9).join(' '))
      index += 1 // Porcelain v2 puts the rename source path in the next NUL field.
      continue
    }
    if (record.startsWith('u ')) {
      const parts = record.split(' ')
      addTrackedStatus(parts[1] ?? 'UU', parts.slice(10).join(' '), true)
      continue
    }
    if (record.startsWith('? ')) {
      untracked.add(toDisplayPath(record.slice(2)))
    }
  }

  const sorted = (values: Set<string>): string[] =>
    [...values].sort((left, right) => left.localeCompare(right))

  return {
    branch,
    detached,
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    staged: sorted(staged),
    unstaged: sorted(unstaged),
    untracked: sorted(untracked),
    conflicted: sorted(conflicted)
  }
}

function parseLog(output: string): GitLogEntry[] {
  const entries: GitLogEntry[] = []
  // NUL is forbidden in commit metadata. Parse eight fields at a time instead
  // of splitting records on a double NUL: an empty commit body otherwise makes
  // the field separator and record delimiter ambiguous.
  const fields = output.split('\0')
  let index = 0
  while (index + 8 <= fields.length) {
    const hash = (fields[index] ?? '').replace(/^\n+/u, '')
    const shortHash = fields[index + 1] ?? ''
    const authorName = fields[index + 2] ?? ''
    const authorEmail = fields[index + 3] ?? ''
    const authoredAt = fields[index + 4] ?? ''
    const parentList = fields[index + 5] ?? ''
    const subject = fields[index + 6] ?? ''
    const body = fields[index + 7] ?? ''
    index += 8
    while (fields[index] === '') index += 1
    if (!hash) continue
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(hash)) break
    entries.push({
      hash,
      shortHash,
      authorName: escapeUnsafeDisplayCharacters(authorName),
      authorEmail: escapeUnsafeDisplayCharacters(authorEmail),
      authoredAt,
      parents: parentList ? parentList.split(' ').filter(Boolean) : [],
      subject: escapeUnsafeDisplayCharacters(subject),
      body: escapeUnsafeMultilineText(body.replace(/\n+$/, ''))
    })
  }
  return entries
}

function parseRawWorktrees(output: string): RawWorktree[] {
  const worktrees: RawWorktree[] = []
  for (const record of output.split('\0\0')) {
    if (!record) continue
    const fields = record.split('\0').filter(Boolean)
    const pathField = fields.find((field) => field.startsWith('worktree '))
    if (!pathField) continue
    const branchField = fields.find((field) => field.startsWith('branch '))
    worktrees.push({
      absolutePath: pathField.slice('worktree '.length),
      head: fields.find((field) => field.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
      branch: branchField
        ? branchField.slice('branch '.length).replace(/^refs\/heads\//, '')
        : null,
      detached: fields.includes('detached'),
      bare: fields.includes('bare'),
      locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some(
        (field) => field === 'prunable' || field.startsWith('prunable ')
      )
    })
  }
  return worktrees
}

function validateBranchName(branch: string): void {
  if (
    !branch ||
    branch.length > 512 ||
    branch.startsWith('-') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('//') ||
    branch.includes('/.') ||
    branch.endsWith('.lock') ||
    /[\u0000-\u0020\u007f~^:?*[\]\\]/u.test(branch)
  ) {
    throw new GitServiceError('INVALID_ARGUMENT', 'Branch name is not safe')
  }
}

function validateRevision(revision: string): void {
  if (
    !revision ||
    revision.length > 512 ||
    revision.startsWith('-') ||
    /[\u0000-\u0020\u007f]/u.test(revision)
  ) {
    throw new GitServiceError('INVALID_ARGUMENT', 'Start point is not safe')
  }
}

function validateCommitMessage(message: string): string {
  if (
    typeof message !== 'string' ||
    !message.trim() ||
    message.includes('\0') ||
    Buffer.byteLength(message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES
  ) {
    throw new GitServiceError(
      'INVALID_ARGUMENT',
      `Commit message must be non-empty and at most ${MAX_COMMIT_MESSAGE_BYTES} bytes`
    )
  }
  return message
}

function validateAuthorName(value: string): string {
  const normalized = value.trim()
  if (
    !normalized ||
    Buffer.byteLength(normalized, 'utf8') > MAX_IDENTITY_BYTES ||
    /[\u0000-\u001f\u007f-\u009f<>]/u.test(normalized)
  ) {
    throw new GitServiceError('INVALID_ARGUMENT', 'Commit author name is not safe')
  }
  return normalized
}

function validateAuthorEmail(value: string): string {
  const normalized = value.trim()
  if (
    !normalized ||
    !normalized.includes('@') ||
    Buffer.byteLength(normalized, 'utf8') > MAX_IDENTITY_BYTES ||
    /[\u0000-\u0020\u007f-\u009f<>]/u.test(normalized)
  ) {
    throw new GitServiceError('INVALID_ARGUMENT', 'Commit author email is not safe')
  }
  return normalized
}

export class GitWorkspaceService {
  readonly gitExecutable: string
  private readonly workspacePath: string
  private readonly worktreeRoot: string
  private readonly defaultTimeoutMs: number
  private readonly maxOutputBytes: number
  private readonly filterDiscovery = new Map<string, Promise<string[]>>()
  private readonly preparedPathMutations = new WeakSet<object>()
  private readonly preparedCommits = new WeakSet<object>()

  private constructor(
    gitExecutable: string,
    workspacePath: string,
    worktreeRoot: string,
    defaultTimeoutMs: number,
    maxOutputBytes: number
  ) {
    this.gitExecutable = gitExecutable
    this.workspacePath = workspacePath
    this.worktreeRoot = worktreeRoot
    this.defaultTimeoutMs = defaultTimeoutMs
    this.maxOutputBytes = maxOutputBytes
  }

  static async open(options: GitServiceOptions): Promise<GitWorkspaceService> {
    const gitExecutable = await resolveGitExecutable(options.gitExecutable)
    if (!gitExecutable) {
      throw new GitServiceError(
        'NOT_FOUND',
        options.gitExecutable
          ? 'The configured Git executable is not an executable absolute file'
          : 'Git was not found in a supported system location'
      )
    }
    const workspacePath = await canonicalDirectory(options.workspacePath, 'Workspace')
    const worktreeRoot = await canonicalDirectory(options.worktreeRoot, 'Worktree root')
    if (
      samePath(workspacePath, worktreeRoot) ||
      isPathInside(workspacePath, worktreeRoot) ||
      isPathInside(worktreeRoot, workspacePath)
    ) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Worktree root must be a dedicated directory outside the workspace'
      )
    }
    const timeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    const maxOutputBytes = boundedOutputLimit(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES
    )
    const service = new GitWorkspaceService(
      gitExecutable,
      workspacePath,
      worktreeRoot,
      timeoutMs,
      maxOutputBytes
    )
    const version = await service.runGit(['--version'], {
      signal: options.signal,
      timeoutMs,
      maxOutputBytes: 16_384
    })
    if (!/^git version \d/u.test(version.stdout.trim())) {
      throw new GitServiceError('INVALID_ARGUMENT', 'Configured executable is not Git')
    }
    let topLevel: ProcessResult
    try {
      topLevel = await service.runGit(['rev-parse', '--show-toplevel'], {
        signal: options.signal,
        timeoutMs,
        maxOutputBytes: 64_000
      })
    } catch (error) {
      throw new GitServiceError('NOT_A_REPOSITORY', 'Workspace is not a Git repository', {
        cause: error
      })
    }
    const repositoryRoot = await canonicalDirectory(topLevel.stdout.trim(), 'Repository root')
    if (!samePath(repositoryRoot, workspacePath)) {
      throw new GitServiceError(
        'NOT_A_REPOSITORY',
        'Workspace must be the canonical root of its Git repository'
      )
    }
    return service
  }

  private async assertPinnedDirectory(directory: string, label: string): Promise<void> {
    const canonical = await canonicalDirectory(directory, label)
    if (!samePath(canonical, directory)) {
      throw new GitServiceError('UNSAFE_PATH', `${label} changed after it was authorized`)
    }
  }

  private async runGit(
    args: string[],
    options: {
      cwd?: string
      signal?: AbortSignal
      timeoutMs?: number
      maxOutputBytes?: number
      allowTruncation?: boolean
      neutralizeFilters?: boolean
    } = {}
  ): Promise<ProcessResult> {
    const cwd = options.cwd ?? this.workspacePath
    await this.assertPinnedDirectory(cwd, 'Git working directory')
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const baseArguments = [
      '--no-pager',
      '-c',
      'color.ui=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${nullDevice}`,
      '-c',
      `core.worktree=${cwd}`,
      '-c',
      'core.bare=false',
      '-c',
      'core.quotePath=true'
    ]
    const filterOverrides = options.neutralizeFilters
      ? await this.discoverFilterOverrides(cwd, {
          signal: options.signal,
          timeoutMs: options.timeoutMs
        })
      : []
    return runAbsoluteProcess(
      this.gitExecutable,
      [
        ...baseArguments,
        ...filterOverrides,
        ...args
      ],
      {
        cwd,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? this.maxOutputBytes,
        allowTruncation: options.allowTruncation
      }
    )
  }

  /**
   * Git applies repository-defined clean/process filters while computing
   * working-tree status and diffs, and smudge/process filters while checking
   * out a worktree. Those values are shell command strings. Discover every
   * effective local driver (including local includes) with the non-executing
   * config plumbing command, then shadow all executable filter slots with
   * explicit no-op values on the exact Git invocation.
   */
  private async discoverFilterOverrides(
    cwd: string,
    options: GitOperationOptions
  ): Promise<string[]> {
    const existing = this.filterDiscovery.get(cwd)
    if (existing) return existing

    const pending = (async (): Promise<string[]> => {
      const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
      let result: ProcessResult
      try {
        result = await runAbsoluteProcess(
          this.gitExecutable,
          [
            '--no-pager',
            '-c',
            'color.ui=false',
            '-c',
            'core.fsmonitor=false',
            '-c',
            `core.hooksPath=${nullDevice}`,
            'config',
            '--includes',
            '--null',
            '--name-only',
            '--get-regexp',
            '^filter\\..*\\.(clean|smudge|process|required)$'
          ],
          {
            cwd,
            signal: options.signal,
            timeoutMs: this.operationTimeout(options),
            maxOutputBytes: MAX_FILTER_CONFIG_BYTES
          }
        )
      } catch (error) {
        if (
          error instanceof GitServiceError &&
          error.code === 'COMMAND_FAILED' &&
          error.exitCode === 1
        ) {
          return []
        }
        throw error
      }

      const drivers = new Set<string>()
      for (const key of result.stdout.split('\0').filter(Boolean)) {
        const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu.exec(key)
        if (!match?.[1] || !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(match[1])) {
          throw new GitServiceError(
            'UNSAFE_CONFIGURATION',
            'Repository filter configuration uses an unsafe driver name'
          )
        }
        drivers.add(match[1])
        if (drivers.size > MAX_FILTER_DRIVERS) {
          throw new GitServiceError(
            'UNSAFE_CONFIGURATION',
            `Repository defines more than ${MAX_FILTER_DRIVERS} content filters`
          )
        }
      }

      return [...drivers].sort().flatMap((driver) => [
        '-c',
        `filter.${driver}.clean=`,
        '-c',
        `filter.${driver}.smudge=`,
        '-c',
        `filter.${driver}.process=`,
        '-c',
        `filter.${driver}.required=false`
      ])
    })()

    this.filterDiscovery.set(cwd, pending)
    try {
      return await pending
    } finally {
      if (this.filterDiscovery.get(cwd) === pending) {
        this.filterDiscovery.delete(cwd)
      }
    }
  }

  private operationTimeout(options: GitOperationOptions, fallback = this.defaultTimeoutMs): number {
    return boundedTimeout(options.timeoutMs, fallback)
  }

  private async assertRootStillPinned(): Promise<void> {
    await this.assertPinnedDirectory(this.workspacePath, 'Workspace')
    await this.assertPinnedDirectory(this.worktreeRoot, 'Worktree root')
  }

  private resolveWorkspacePath(relativePath: string): { absolute: string; relative: string } {
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.includes('\0') ||
      /[\u0001-\u001f\u007f]/u.test(relativePath)
    ) {
      throw new GitServiceError('UNSAFE_PATH', 'Path must be workspace-relative')
    }
    const absolute = path.resolve(this.workspacePath, relativePath)
    if (!samePath(absolute, this.workspacePath) && !isPathInside(this.workspacePath, absolute)) {
      throw new GitServiceError('UNSAFE_PATH', 'Path escapes the workspace')
    }
    return {
      absolute,
      relative: path.relative(this.workspacePath, absolute) || '.'
    }
  }

  private resolveMutationPaths(paths: readonly string[]): string[] {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_MUTATION_PATHS) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        `Select between 1 and ${MAX_MUTATION_PATHS} paths`
      )
    }

    const resolved: string[] = []
    const seen = new Set<string>()
    let totalBytes = 0
    for (const candidate of paths) {
      if (
        typeof candidate !== 'string' ||
        /[\u202a-\u202e\u2066-\u2069]/u.test(candidate)
      ) {
        throw new GitServiceError('UNSAFE_PATH', 'Selected path is not safe')
      }
      const bytes = Buffer.byteLength(candidate, 'utf8')
      totalBytes += bytes
      if (
        bytes < 1 ||
        bytes > MAX_MUTATION_PATH_BYTES ||
        totalBytes > MAX_MUTATION_PATH_TOTAL_BYTES
      ) {
        throw new GitServiceError('UNSAFE_PATH', 'Selected path exceeds the safety limit')
      }

      const normalized = this.resolveWorkspacePath(candidate).relative
      if (normalized === '.') {
        throw new GitServiceError(
          'UNSAFE_PATH',
          'Repository-wide Git mutations are not allowed'
        )
      }
      const segments = normalized.split(path.sep)
      if (
        segments.some((segment) =>
          SENSITIVE_METADATA_SEGMENTS.has(segment.toLowerCase())
        )
      ) {
        throw new GitServiceError(
          'UNSAFE_PATH',
          'Git metadata paths cannot be changed through Ground'
        )
      }
      if (seen.has(normalized)) continue
      seen.add(normalized)
      resolved.push(normalized)
    }
    return resolved
  }

  private async optionalGitOutput(
    args: string[],
    options: GitOperationOptions = {}
  ): Promise<string | undefined> {
    try {
      const result = await this.runGit(args, {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options),
        maxOutputBytes: 64_000
      })
      return result.stdout.trim()
    } catch (error) {
      if (
        error instanceof GitServiceError &&
        error.code === 'COMMAND_FAILED' &&
        (error.exitCode === 1 || error.exitCode === 128)
      ) {
        return undefined
      }
      throw error
    }
  }

  private async resolveManagedDestination(
    relativePath: string,
    mustExist: boolean
  ): Promise<{ absolute: string; relative: string }> {
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.includes('\0') ||
      /[\u0001-\u001f\u007f]/u.test(relativePath)
    ) {
      throw new GitServiceError('UNSAFE_PATH', 'Worktree location must be root-relative')
    }
    const absolute = path.resolve(this.worktreeRoot, relativePath)
    if (!isPathInside(this.worktreeRoot, absolute)) {
      throw new GitServiceError('UNSAFE_PATH', 'Worktree location escapes the Ground root')
    }
    const relative = path.relative(this.worktreeRoot, absolute)
    let details: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      details = await lstat(absolute)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }
    if (mustExist) {
      if (!details?.isDirectory() || details.isSymbolicLink()) {
        throw new GitServiceError('NOT_FOUND', 'Managed worktree does not exist')
      }
      const canonical = await realpath(absolute)
      if (!samePath(canonical, absolute) || !isPathInside(this.worktreeRoot, canonical)) {
        throw new GitServiceError('UNSAFE_PATH', 'Managed worktree path is not canonical')
      }
    } else {
      if (details) {
        throw new GitServiceError('INVALID_ARGUMENT', 'Worktree destination already exists')
      }
      const parent = await canonicalDirectory(path.dirname(absolute), 'Worktree parent')
      if (
        !samePath(parent, this.worktreeRoot) &&
        !isPathInside(this.worktreeRoot, parent)
      ) {
        throw new GitServiceError('UNSAFE_PATH', 'Worktree parent escapes the Ground root')
      }
      if (!samePath(parent, path.dirname(absolute))) {
        throw new GitServiceError('UNSAFE_PATH', 'Worktree parent must be canonical')
      }
    }
    return { absolute, relative }
  }

  private async rawWorktrees(options: GitOperationOptions = {}): Promise<RawWorktree[]> {
    const result = await this.runGit(['worktree', 'list', '--porcelain', '-z'], {
      signal: options.signal,
      timeoutMs: this.operationTimeout(options),
      maxOutputBytes: this.maxOutputBytes
    })
    return parseRawWorktrees(result.stdout)
  }

  private async canonicalRawWorktreePath(worktree: RawWorktree): Promise<string> {
    const resolved = path.resolve(worktree.absolutePath)
    try {
      return await realpath(resolved)
    } catch {
      return resolved
    }
  }

  private async publicWorktree(
    worktree: RawWorktree
  ): Promise<GitWorktreeSummary | undefined> {
    const canonical = await this.canonicalRawWorktreePath(worktree)
    const isMain = samePath(canonical, this.workspacePath)
    if (!isMain && !isPathInside(this.worktreeRoot, canonical)) return undefined
    return {
      relativePath: isMain ? '.' : toDisplayPath(path.relative(this.worktreeRoot, canonical)),
      isMain,
      head: worktree.head,
      branch: worktree.branch
        ? escapeUnsafeDisplayCharacters(worktree.branch)
        : null,
      detached: worktree.detached,
      locked: worktree.locked,
      prunable: worktree.prunable
    }
  }

  async status(options: GitOperationOptions = {}): Promise<GitStatusSummary> {
    await this.assertRootStillPinned()
    const result = await this.runGit(
      ['status', '--porcelain=v2', '-z', '--branch', '--ahead-behind', '--untracked-files=all'],
      {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options),
        maxOutputBytes: this.maxOutputBytes,
        neutralizeFilters: true
      }
    )
    return parseStatus(result.stdout)
  }

  async identity(options: GitOperationOptions = {}): Promise<GitIdentity> {
    await this.assertRootStillPinned()
    const [rawName, rawEmail] = await Promise.all([
      this.optionalGitOutput(['config', '--local', '--get', 'user.name'], options),
      this.optionalGitOutput(['config', '--local', '--get', 'user.email'], options)
    ])
    const safeValue = (value: string | undefined): string | undefined => {
      if (
        !value ||
        Buffer.byteLength(value, 'utf8') > MAX_IDENTITY_BYTES ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(value)
      ) {
        return undefined
      }
      return escapeUnsafeDisplayCharacters(value)
    }
    const name = safeValue(rawName)
    const email = safeValue(rawEmail)
    return {
      ...(name ? { name } : {}),
      ...(email ? { email } : {})
    }
  }

  async preparePathMutation(
    kind: GitPathMutationKind,
    inputPaths: readonly string[],
    options: GitOperationOptions = {}
  ): Promise<PreparedGitPathMutation> {
    await this.assertRootStillPinned()
    if (kind !== 'stage' && kind !== 'unstage') {
      throw new GitServiceError('INVALID_ARGUMENT', 'Unsupported Git path mutation')
    }
    const paths = this.resolveMutationPaths(inputPaths)
    const status = await this.status(options)
    const eligible = new Set(
      kind === 'stage'
        ? [...status.unstaged, ...status.untracked, ...status.conflicted]
        : status.staged
    )
    const unavailable = paths
      .map((candidate) => toDisplayPath(candidate))
      .filter((candidate) => !eligible.has(candidate))
    if (unavailable.length > 0) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        `Selected ${kind === 'stage' ? 'working-tree' : 'staged'} paths changed before the operation: ${unavailable.join(', ')}`
      )
    }

    const prepared = Object.freeze({
      kind,
      paths: Object.freeze([...paths])
    }) satisfies PreparedGitPathMutation
    this.preparedPathMutations.add(prepared)
    return prepared
  }

  async executePreparedPathMutation(
    prepared: PreparedGitPathMutation,
    options: GitOperationOptions = {}
  ): Promise<GitStatusSummary> {
    if (!prepared || !this.preparedPathMutations.has(prepared)) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Git path mutation was not prepared by this workspace'
      )
    }
    this.preparedPathMutations.delete(prepared)
    await this.assertRootStillPinned()

    // Recheck eligibility after native confirmation. These index operations
    // never overwrite working-tree files.
    const status = await this.status(options)
    const eligible = new Set(
      prepared.kind === 'stage'
        ? [...status.unstaged, ...status.untracked, ...status.conflicted]
        : status.staged
    )
    const unavailable = prepared.paths
      .map((candidate) => toDisplayPath(candidate))
      .filter((candidate) => !eligible.has(candidate))
    if (unavailable.length > 0) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        `Selected paths changed while confirmation was open: ${unavailable.join(', ')}`
      )
    }

    if (prepared.kind === 'stage') {
      await this.runGit(['add', '--', ...prepared.paths], {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options, MUTATION_TIMEOUT_MS),
        maxOutputBytes: this.maxOutputBytes,
        neutralizeFilters: true
      })
    } else {
      const head = await this.optionalGitOutput(['rev-parse', '--verify', 'HEAD'], options)
      const args = head
        ? ['reset', '--quiet', '--', ...prepared.paths]
        : ['rm', '--quiet', '--cached', '--force', '--ignore-unmatch', '--', ...prepared.paths]
      await this.runGit(args, {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options, MUTATION_TIMEOUT_MS),
        maxOutputBytes: this.maxOutputBytes,
        neutralizeFilters: false
      })
    }
    return this.status(options)
  }

  async prepareCommit(
    options: GitOperationOptions = {}
  ): Promise<PreparedGitCommit> {
    await this.assertRootStillPinned()
    const status = await this.status(options)
    if (status.staged.length === 0) {
      throw new GitServiceError('INVALID_ARGUMENT', 'There are no staged changes to commit')
    }
    if (status.conflicted.length > 0) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Resolve all merge conflicts before committing'
      )
    }
    const inProgress = await Promise.all([
      this.optionalGitOutput(['rev-parse', '--verify', 'MERGE_HEAD'], options),
      this.optionalGitOutput(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], options),
      this.optionalGitOutput(['rev-parse', '--verify', 'REVERT_HEAD'], options)
    ])
    if (inProgress.some(Boolean)) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Finish the in-progress Git operation from a terminal before committing in Ground'
      )
    }

    const tree = await this.runGit(['write-tree'], {
      signal: options.signal,
      timeoutMs: this.operationTimeout(options),
      maxOutputBytes: 64_000
    })
    const treeOid = tree.stdout.trim()
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(treeOid)) {
      throw new GitServiceError('COMMAND_FAILED', 'Git returned an invalid staged tree identity')
    }
    const [expectedHeadOid, symbolicHead] = await Promise.all([
      this.optionalGitOutput(['rev-parse', '--verify', 'HEAD'], options),
      this.optionalGitOutput(['symbolic-ref', '--quiet', 'HEAD'], options)
    ])
    if (
      expectedHeadOid !== undefined &&
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expectedHeadOid)
    ) {
      throw new GitServiceError('COMMAND_FAILED', 'Git returned an invalid HEAD identity')
    }
    if (symbolicHead && !symbolicHead.startsWith('refs/heads/')) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'HEAD points outside the local branch namespace'
      )
    }
    const branch = symbolicHead?.startsWith('refs/heads/')
      ? escapeUnsafeDisplayCharacters(symbolicHead.slice('refs/heads/'.length))
      : null
    const prepared = Object.freeze({
      treeOid,
      expectedHeadOid: expectedHeadOid ?? null,
      branch,
      detached: !symbolicHead,
      stagedPaths: Object.freeze([...status.staged])
    }) satisfies PreparedGitCommit
    this.preparedCommits.add(prepared)
    return prepared
  }

  async executePreparedCommit(
    prepared: PreparedGitCommit,
    options: GitCommitOptions
  ): Promise<GitLogEntry> {
    if (!prepared || !this.preparedCommits.has(prepared)) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Git commit was not prepared by this workspace'
      )
    }
    const message = validateCommitMessage(options.message)
    const authorName = validateAuthorName(options.authorName)
    const authorEmail = validateAuthorEmail(options.authorEmail)
    this.preparedCommits.delete(prepared)
    await this.assertRootStillPinned()

    const commitArguments = [
      '-c',
      `user.name=${authorName}`,
      '-c',
      `user.email=${authorEmail}`,
      '-c',
      'commit.gpgSign=false',
      'commit-tree',
      prepared.treeOid
    ]
    if (prepared.expectedHeadOid) {
      commitArguments.push('-p', prepared.expectedHeadOid)
    }
    commitArguments.push('-m', message)
    const created = await this.runGit(commitArguments, {
      signal: options.signal,
      timeoutMs: this.operationTimeout(options, MUTATION_TIMEOUT_MS),
      maxOutputBytes: 64_000
    })
    const commitOid = created.stdout.trim()
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commitOid)) {
      throw new GitServiceError('COMMAND_FAILED', 'Git returned an invalid commit identity')
    }

    // Atomically move HEAD only if it still names the parent that was shown in
    // the confirmation. commit-tree binds the exact prepared index tree, so
    // concurrent working-tree and index edits are preserved.
    const expected =
      prepared.expectedHeadOid ?? '0'.repeat(commitOid.length)
    const reflogSubject = escapeUnsafeDisplayCharacters(
      message.split(/\r?\n/u, 1)[0] ?? ''
    ).slice(0, 200)
    await this.runGit(
      [
        'update-ref',
        '-m',
        `commit: ${reflogSubject}`,
        'HEAD',
        commitOid,
        expected
      ],
      {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options, MUTATION_TIMEOUT_MS),
        maxOutputBytes: this.maxOutputBytes
      }
    )

    const format =
      'format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%b%x00%x00'
    const readBack = await this.runGit(
      [
        'log',
        '--no-show-signature',
        '--max-count=1',
        `--format=${format}`,
        commitOid
      ],
      {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options),
        maxOutputBytes: 256_000
      }
    )
    const committed = parseLog(readBack.stdout)[0]
    if (!committed || committed.hash !== commitOid) {
      throw new GitServiceError(
        'COMMAND_FAILED',
        `Git created the commit but could not read it back${
          readBack.stdout ? `: ${safeDiagnostic(readBack.stdout)}` : ''
        }`
      )
    }
    return committed
  }

  async diff(options: GitDiffOptions = {}): Promise<GitDiffResult> {
    await this.assertRootStillPinned()
    const contextLines = options.contextLines ?? 3
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Diff context must be an integer between 0 and 100'
      )
    }
    const maxBytes = boundedOutputLimit(
      options.maxBytes,
      DEFAULT_DIFF_BYTES,
      this.maxOutputBytes
    )
    const args = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      `--unified=${contextLines}`
    ]
    if (options.staged) args.push('--cached')
    args.push('--')
    if (options.path) {
      args.push(this.resolveWorkspacePath(options.path).relative)
    }
    const result = await this.runGit(args, {
      signal: options.signal,
      timeoutMs: this.operationTimeout(options),
      maxOutputBytes: maxBytes,
      allowTruncation: true,
      neutralizeFilters: !options.staged
    })
    return {
      text: result.stdout,
      truncated: result.truncated,
      bytes: Buffer.byteLength(result.stdout)
    }
  }

  async log(options: GitLogOptions = {}): Promise<GitLogResult> {
    await this.assertRootStillPinned()
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_ENTRIES) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        `Log limit must be an integer between 1 and ${MAX_LOG_ENTRIES}`
      )
    }
    const maxBytes = boundedOutputLimit(
      options.maxBytes,
      DEFAULT_LOG_BYTES,
      this.maxOutputBytes
    )
    const format =
      'format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%b%x00%x00'
    const result = await this.runGit(
      [
        'log',
        '--no-show-signature',
        `--max-count=${limit}`,
        `--format=${format}`
      ],
      {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options),
        maxOutputBytes: maxBytes,
        allowTruncation: true
      }
    )
    return {
      entries: parseLog(result.stdout),
      truncated: result.truncated
    }
  }

  async listWorktrees(
    options: GitOperationOptions = {}
  ): Promise<GitWorktreeSummary[]> {
    await this.assertRootStillPinned()
    const raw = await this.rawWorktrees(options)
    const visible = await Promise.all(raw.map((worktree) => this.publicWorktree(worktree)))
    return visible
      .filter((worktree): worktree is GitWorktreeSummary => worktree !== undefined)
      .sort((left, right) => {
        if (left.isMain) return -1
        if (right.isMain) return 1
        return left.relativePath.localeCompare(right.relativePath)
      })
  }

  async createWorktree(
    options: CreateGitWorktreeOptions
  ): Promise<GitWorktreeSummary> {
    await this.assertRootStillPinned()
    validateBranchName(options.branch)
    if (options.startPoint !== undefined) validateRevision(options.startPoint)
    const createBranch = options.createBranch ?? true
    if (!createBranch && options.startPoint !== undefined) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'startPoint is only valid when creating a branch'
      )
    }
    await this.runGit(['check-ref-format', '--branch', options.branch], {
      signal: options.signal,
      timeoutMs: this.operationTimeout(options),
      maxOutputBytes: 64_000
    })
    const destination = await this.resolveManagedDestination(options.relativePath, false)
    const registered = await this.rawWorktrees(options)
    for (const worktree of registered) {
      const registeredPath = await this.canonicalRawWorktreePath(worktree)
      if (samePath(registeredPath, destination.absolute)) {
        throw new GitServiceError('INVALID_ARGUMENT', 'Worktree is already registered')
      }
    }

    const args = ['worktree', 'add', '--quiet']
    if (createBranch) args.push('-b', options.branch)
    args.push('--', destination.absolute)
    if (createBranch) args.push(options.startPoint ?? 'HEAD')
    else args.push(options.branch)
    await this.runGit(args, {
      signal: options.signal,
      timeoutMs: this.operationTimeout(options, MUTATION_TIMEOUT_MS),
      maxOutputBytes: this.maxOutputBytes,
      neutralizeFilters: true
    })

    const candidates = await this.rawWorktrees(options)
    for (const candidate of candidates) {
      if (
        samePath(
          await this.canonicalRawWorktreePath(candidate),
          destination.absolute
        )
      ) {
        const visible = await this.publicWorktree(candidate)
        if (visible) return visible
      }
    }
    throw new GitServiceError(
      'COMMAND_FAILED',
      'Git created the worktree but did not report it afterward'
    )
  }

  async removeWorktree(
    options: RemoveGitWorktreeOptions
  ): Promise<GitWorktreeSummary> {
    await this.assertRootStillPinned()
    const destination = await this.resolveManagedDestination(options.relativePath, true)
    const registered = await this.rawWorktrees(options)
    let target: RawWorktree | undefined
    for (const candidate of registered) {
      if (
        samePath(
          await this.canonicalRawWorktreePath(candidate),
          destination.absolute
        )
      ) {
        target = candidate
        break
      }
    }
    if (!target) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Refusing to remove a directory that is not a registered Ground worktree'
      )
    }
    const visible = await this.publicWorktree(target)
    if (!visible || visible.isMain || target.bare) {
      throw new GitServiceError('UNSAFE_PATH', 'The main workspace cannot be removed')
    }

    const dirty = await this.runGit(
      ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
      {
        cwd: destination.absolute,
        signal: options.signal,
        timeoutMs: this.operationTimeout(options),
        maxOutputBytes: this.maxOutputBytes,
        neutralizeFilters: true
      }
    )
    if (dirty.stdout.length > 0 && options.force !== true) {
      throw new GitServiceError(
        'WORKTREE_DIRTY',
        'Worktree has uncommitted changes; pass force: true to remove it'
      )
    }

    // Revalidate both the filesystem target and Git registry immediately before
    // the destructive operation.
    await this.resolveManagedDestination(options.relativePath, true)
    const stillRegistered = await this.rawWorktrees(options)
    let registrationStillMatches = false
    for (const candidate of stillRegistered) {
      if (
        samePath(
          await this.canonicalRawWorktreePath(candidate),
          destination.absolute
        )
      ) {
        registrationStillMatches = true
        break
      }
    }
    if (!registrationStillMatches) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Worktree registration changed before removal'
      )
    }

    const args = ['worktree', 'remove']
    if (options.force === true) args.push('--force')
    args.push('--', destination.absolute)
    await this.runGit(args, {
      signal: options.signal,
      timeoutMs: this.operationTimeout(options, MUTATION_TIMEOUT_MS),
      maxOutputBytes: this.maxOutputBytes,
      neutralizeFilters: true
    })
    return visible
  }
}
