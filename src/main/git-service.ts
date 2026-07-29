import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
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
const MAX_REVERT_PREVIEW_BYTES = 4_000_000
const MAX_REVERT_FILE_BYTES = 32_000_000
const MAX_REVERT_TOTAL_BYTES = 128_000_000
const MAX_RECOVERY_MANIFEST_BYTES = 2_000_000
const RECOVERY_DIRECTORY_NAME = '.ground-recovery'
const RECOVERY_MANIFEST_NAME = 'manifest.json'
const RECOVERY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
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
  /**
   * Optional main-process trust callback. When provided, Ground invokes it
   * immediately before every Git process launch and requires it to return the
   * same canonical executable path selected when this service was opened.
   */
  revalidateGitExecutable?: () => Promise<string>
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
  readonly version: 1
  readonly treeOid: string
  readonly expectedHeadOid: string | null
  /** The exact checked-out local branch ref approved by the user. */
  readonly symbolicRef: string
  readonly branch: string
  readonly detached: false
  readonly repositoryIdentitySha256: string
  readonly worktreeIdentitySha256: string
  readonly stagedPaths: readonly string[]
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
  readonly preview: string
  readonly previewSha256: string
  readonly actionSha256: string
}

export interface GitCommitOptions extends GitOperationOptions {
  message: string
  authorName: string
  authorEmail: string
}

interface FilesystemIdentity {
  readonly device: string
  readonly inode: string
  readonly size: string
  readonly mode: number
  readonly modifiedNs: string
  readonly changedNs: string
}

interface StableDirectoryBinding {
  readonly canonicalPath: string
  readonly identity: FilesystemIdentity
}

interface GitCommitAuthority {
  readonly workspace: StableDirectoryBinding
  readonly gitDirectory: StableDirectoryBinding
  readonly commonDirectory: StableDirectoryBinding
  readonly expectedHeadOid: string | null
  readonly symbolicRef: string
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
}

interface ParentDirectoryIdentity {
  readonly relativePath: string
  readonly identity: FilesystemIdentity
}

interface GitWorkingPathSnapshot {
  readonly relativePath: string
  readonly existed: boolean
  readonly sha256?: string
  readonly identity?: FilesystemIdentity
  readonly parents: readonly ParentDirectoryIdentity[]
}

interface GitIndexEntry {
  readonly relativePath: string
  readonly mode: '100644' | '100755'
  readonly oid: string
}

export interface PreparedGitPathRevert {
  readonly version: 1
  readonly trackedPaths: readonly string[]
  readonly untrackedPaths: readonly string[]
  readonly indexEntries: readonly GitIndexEntry[]
  readonly workingSnapshots: readonly GitWorkingPathSnapshot[]
  readonly preview: string
  readonly previewSha256: string
  readonly actionSha256: string
}

export type GitRecoveryStatus =
  | 'applied'
  | 'recovery-required'
  | 'restored'

export interface GitRecoverySummary {
  readonly id: string
  readonly createdAt: string
  readonly status: GitRecoveryStatus
  readonly trackedPaths: readonly string[]
  readonly untrackedPaths: readonly string[]
  readonly canUndo: boolean
}

export interface GitPathRevertResult {
  readonly recovery: GitRecoverySummary
}

export interface PreparedGitRecoveryUndo {
  readonly version: 1
  readonly recoveryId: string
  readonly manifestSha256: string
  readonly currentSnapshots: readonly GitWorkingPathSnapshot[]
  readonly preview: string
  readonly previewSha256: string
  readonly actionSha256: string
}

interface RecoveryTrackedEntry {
  relativePath: string
  indexEntry: GitIndexEntry
  before: GitWorkingPathSnapshot
  backupName?: string
  after?: GitWorkingPathSnapshot
}

interface RecoveryUntrackedEntry {
  relativePath: string
  before: GitWorkingPathSnapshot
  quarantineName: string
  moved: boolean
  after?: GitWorkingPathSnapshot
}

interface GitRecoveryManifest {
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  status: GitRecoveryStatus | 'prepared' | 'mutating' | 'undoing'
  actionSha256: string
  tracked: RecoveryTrackedEntry[]
  untracked: RecoveryUntrackedEntry[]
  error?: string
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

export function gitSupportsRequiredFeatures(versionOutput: string): boolean {
  const match = /^git version (\d{1,9})\.(\d{1,9})(?:\.\d{1,9})?(?:[.\s-]|$)/u.exec(
    versionOutput.trim()
  )
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 2 || (major === 2 && minor >= 23)
}

/**
 * Probe an explicitly approved executable without involving repository
 * configuration. Callers must still retain and revalidate their executable
 * identity before every later launch.
 */
export async function verifyGitExecutableVersion(
  explicitExecutable: string,
  options: {
    cwd: string
    signal?: AbortSignal
  }
): Promise<string> {
  const executable = await resolveGitExecutable(explicitExecutable)
  if (!executable) {
    throw new GitServiceError(
      'NOT_FOUND',
      'The selected Git executable is no longer available'
    )
  }
  const cwd = await canonicalDirectory(options.cwd, 'Git probe directory')
  const result = await runAbsoluteProcess(executable, ['--version'], {
    cwd,
    signal: options.signal,
    timeoutMs: 5_000,
    maxOutputBytes: 16_384
  })
  if (!gitSupportsRequiredFeatures(result.stdout)) {
    throw new GitServiceError(
      'INVALID_ARGUMENT',
      'Ground requires Git 2.23 or newer'
    )
  }
  return result.stdout.trim()
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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

interface BigIntStatLike {
  dev: bigint
  ino: bigint
  size: bigint
  mode: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

function filesystemIdentity(details: BigIntStatLike): FilesystemIdentity {
  return Object.freeze({
    device: details.dev.toString(),
    inode: details.ino.toString(),
    size: details.size.toString(),
    mode: Number(details.mode & 0o777n),
    modifiedNs: details.mtimeNs.toString(),
    changedNs: details.ctimeNs.toString()
  })
}

function sameFilesystemIdentity(
  left: Readonly<FilesystemIdentity> | undefined,
  right: Readonly<FilesystemIdentity> | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  )
}

function sameParentDirectoryIdentity(
  left: Readonly<FilesystemIdentity>,
  right: Readonly<FilesystemIdentity>
): boolean {
  // Child creation/removal legitimately changes a directory's size and
  // timestamps. The stable directory identity is its device/inode plus type
  // and mode; every capture separately rejects symlinks and re-canonicalizes
  // the full parent chain.
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  )
}

function freezeStableDirectoryBinding(
  binding: StableDirectoryBinding
): StableDirectoryBinding {
  return Object.freeze({
    canonicalPath: binding.canonicalPath,
    identity: Object.freeze({ ...binding.identity })
  })
}

function sameStableDirectoryBinding(
  left: Readonly<StableDirectoryBinding>,
  right: Readonly<StableDirectoryBinding>
): boolean {
  return (
    samePath(left.canonicalPath, right.canonicalPath) &&
    sameParentDirectoryIdentity(left.identity, right.identity)
  )
}

function stableDirectoryFingerprint(
  label: 'repository' | 'worktree',
  bindings: readonly Readonly<StableDirectoryBinding>[]
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      label,
      directories: bindings.map((binding) => ({
        canonicalPath:
          process.platform === 'win32'
            ? binding.canonicalPath.toLowerCase()
            : binding.canonicalPath,
        device: binding.identity.device,
        inode: binding.identity.inode,
        mode: binding.identity.mode
      }))
    })
  )
}

function reviewedCommitValue(value: string): string {
  return JSON.stringify(value).replace(
    /[\u202a-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u{${character.codePointAt(0)?.toString(16).padStart(4, '0')}}`
  )
}

function preparedCommitFingerprint(
  prepared: Omit<PreparedGitCommit, 'actionSha256'>
): string {
  return sha256(
    JSON.stringify({
      version: prepared.version,
      treeOid: prepared.treeOid,
      expectedHeadOid: prepared.expectedHeadOid,
      symbolicRef: prepared.symbolicRef,
      branch: prepared.branch,
      detached: prepared.detached,
      repositoryIdentitySha256: prepared.repositoryIdentitySha256,
      worktreeIdentitySha256: prepared.worktreeIdentitySha256,
      stagedPaths: prepared.stagedPaths,
      message: prepared.message,
      authorName: prepared.authorName,
      authorEmail: prepared.authorEmail,
      previewSha256: prepared.previewSha256
    })
  )
}

function freezeParentIdentity(
  parent: ParentDirectoryIdentity
): ParentDirectoryIdentity {
  return Object.freeze({
    relativePath: parent.relativePath,
    identity: Object.freeze({ ...parent.identity })
  })
}

function freezeWorkingSnapshot(
  snapshot: GitWorkingPathSnapshot
): GitWorkingPathSnapshot {
  return Object.freeze({
    relativePath: snapshot.relativePath,
    existed: snapshot.existed,
    ...(snapshot.sha256 ? { sha256: snapshot.sha256 } : {}),
    ...(snapshot.identity
      ? { identity: Object.freeze({ ...snapshot.identity }) }
      : {}),
    parents: Object.freeze(snapshot.parents.map(freezeParentIdentity))
  })
}

function freezeIndexEntry(entry: GitIndexEntry): GitIndexEntry {
  return Object.freeze({ ...entry })
}

function sameWorkingSnapshot(
  left: Readonly<GitWorkingPathSnapshot>,
  right: Readonly<GitWorkingPathSnapshot>
): boolean {
  if (
    left.relativePath !== right.relativePath ||
    left.existed !== right.existed ||
    left.sha256 !== right.sha256 ||
    !(
      (left.identity === undefined && right.identity === undefined) ||
      sameFilesystemIdentity(left.identity, right.identity)
    ) ||
    left.parents.length !== right.parents.length
  ) {
    return false
  }
  return left.parents.every((parent, index) => {
    const candidate = right.parents[index]
    return (
      candidate !== undefined &&
      parent.relativePath === candidate.relativePath &&
      sameParentDirectoryIdentity(parent.identity, candidate.identity)
    )
  })
}

function sameWorkingFileState(
  left: Readonly<GitWorkingPathSnapshot>,
  right: Readonly<GitWorkingPathSnapshot>
): boolean {
  return (
    left.relativePath === right.relativePath &&
    left.existed === right.existed &&
    left.sha256 === right.sha256 &&
    ((left.identity === undefined && right.identity === undefined) ||
      sameFilesystemIdentity(left.identity, right.identity))
  )
}

function sameIndexEntry(
  left: Readonly<GitIndexEntry>,
  right: Readonly<GitIndexEntry>
): boolean {
  return (
    left.relativePath === right.relativePath &&
    left.mode === right.mode &&
    left.oid === right.oid
  )
}

function preparedRevertFingerprint(
  prepared: Omit<PreparedGitPathRevert, 'actionSha256'>
): string {
  return sha256(
    JSON.stringify({
      version: prepared.version,
      trackedPaths: prepared.trackedPaths,
      untrackedPaths: prepared.untrackedPaths,
      indexEntries: prepared.indexEntries,
      workingSnapshots: prepared.workingSnapshots,
      previewSha256: prepared.previewSha256
    })
  )
}

function preparedUndoFingerprint(
  prepared: Omit<PreparedGitRecoveryUndo, 'actionSha256'>
): string {
  return sha256(
    JSON.stringify({
      version: prepared.version,
      recoveryId: prepared.recoveryId,
      manifestSha256: prepared.manifestSha256,
      currentSnapshots: prepared.currentSnapshots,
      previewSha256: prepared.previewSha256
    })
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maximum = 8_192
): string {
  const value = record[key]
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest is invalid'
    )
  }
  return value
}

function parseFilesystemIdentity(value: unknown): FilesystemIdentity {
  if (!isRecord(value)) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest identity is invalid'
    )
  }
  const device = requiredString(value, 'device', 100)
  const inode = requiredString(value, 'inode', 100)
  const size = requiredString(value, 'size', 100)
  const modifiedNs = requiredString(value, 'modifiedNs', 100)
  const changedNs = requiredString(value, 'changedNs', 100)
  const mode = value.mode
  if (
    ![device, inode, size, modifiedNs, changedNs].every((candidate) =>
      /^\d+$/u.test(candidate)
    ) ||
    typeof mode !== 'number' ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0o777
  ) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest identity is invalid'
    )
  }
  return Object.freeze({
    device,
    inode,
    size,
    mode,
    modifiedNs,
    changedNs
  })
}

function parseWorkingSnapshot(value: unknown): GitWorkingPathSnapshot {
  if (!isRecord(value) || typeof value.existed !== 'boolean') {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest path snapshot is invalid'
    )
  }
  const relativePath = requiredString(value, 'relativePath')
  if (!Array.isArray(value.parents) || value.parents.length > 512) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest parent snapshot is invalid'
    )
  }
  const parents = value.parents.map((candidate): ParentDirectoryIdentity => {
    if (!isRecord(candidate)) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery manifest parent snapshot is invalid'
      )
    }
    return freezeParentIdentity({
      relativePath: requiredString(candidate, 'relativePath'),
      identity: parseFilesystemIdentity(candidate.identity)
    })
  })
  if (!value.existed) {
    if (value.sha256 !== undefined || value.identity !== undefined) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery manifest missing-path snapshot is invalid'
      )
    }
    return freezeWorkingSnapshot({
      relativePath,
      existed: false,
      parents
    })
  }
  const digest = requiredString(value, 'sha256', 64)
  if (!SHA256_PATTERN.test(digest)) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest path digest is invalid'
    )
  }
  return freezeWorkingSnapshot({
    relativePath,
    existed: true,
    sha256: digest,
    identity: parseFilesystemIdentity(value.identity),
    parents
  })
}

function parseIndexEntry(value: unknown): GitIndexEntry {
  if (!isRecord(value)) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest index entry is invalid'
    )
  }
  const relativePath = requiredString(value, 'relativePath')
  const mode = requiredString(value, 'mode', 6)
  const oid = requiredString(value, 'oid', 64)
  if (
    (mode !== '100644' && mode !== '100755') ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)
  ) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest index entry is invalid'
    )
  }
  return freezeIndexEntry({ relativePath, mode, oid })
}

function recoveryPayloadName(value: unknown, prefix: string): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${prefix}-\\d{6}\\.bin$`, 'u').test(value)
  ) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest payload name is invalid'
    )
  }
  return value
}

function parseRecoveryManifest(value: unknown): GitRecoveryManifest {
  if (!isRecord(value) || value.version !== 1) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest is invalid'
    )
  }
  const id = requiredString(value, 'id', 64)
  const createdAt = requiredString(value, 'createdAt', 100)
  const updatedAt = requiredString(value, 'updatedAt', 100)
  const actionSha256 = requiredString(value, 'actionSha256', 64)
  const status = value.status
  if (
    !RECOVERY_ID_PATTERN.test(id) ||
    !SHA256_PATTERN.test(actionSha256) ||
    ![
      'prepared',
      'mutating',
      'applied',
      'recovery-required',
      'undoing',
      'restored'
    ].includes(typeof status === 'string' ? status : '') ||
    !Array.isArray(value.tracked) ||
    !Array.isArray(value.untracked) ||
    value.tracked.length + value.untracked.length < 1 ||
    value.tracked.length + value.untracked.length > MAX_MUTATION_PATHS
  ) {
    throw new GitServiceError(
      'UNSAFE_CONFIGURATION',
      'Git recovery manifest is invalid'
    )
  }

  const tracked = value.tracked.map((candidate, index): RecoveryTrackedEntry => {
    if (!isRecord(candidate)) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery tracked entry is invalid'
      )
    }
    const before = parseWorkingSnapshot(candidate.before)
    const relativePath = requiredString(candidate, 'relativePath')
    if (before.relativePath !== relativePath) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery tracked entry does not match its path'
      )
    }
    const backupName =
      candidate.backupName === undefined
        ? undefined
        : recoveryPayloadName(candidate.backupName, 'tracked')
    if (before.existed !== Boolean(backupName)) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery tracked backup is invalid'
      )
    }
    const expectedName = `tracked-${index.toString().padStart(6, '0')}.bin`
    if (backupName && backupName !== expectedName) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery tracked backup order is invalid'
      )
    }
    return {
      relativePath,
      indexEntry: parseIndexEntry(candidate.indexEntry),
      before,
      ...(backupName ? { backupName } : {}),
      ...(candidate.after === undefined
        ? {}
        : { after: parseWorkingSnapshot(candidate.after) })
    }
  })
  const untracked = value.untracked.map(
    (candidate, index): RecoveryUntrackedEntry => {
      if (!isRecord(candidate) || typeof candidate.moved !== 'boolean') {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          'Git recovery untracked entry is invalid'
        )
      }
      const before = parseWorkingSnapshot(candidate.before)
      const relativePath = requiredString(candidate, 'relativePath')
      const quarantineName = recoveryPayloadName(
        candidate.quarantineName,
        'untracked'
      )
      if (
        !before.existed ||
        before.relativePath !== relativePath ||
        quarantineName !==
          `untracked-${index.toString().padStart(6, '0')}.bin`
      ) {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          'Git recovery untracked entry does not match its path'
        )
      }
      return {
        relativePath,
        before,
        quarantineName,
        moved: candidate.moved,
        ...(candidate.after === undefined
          ? {}
          : { after: parseWorkingSnapshot(candidate.after) })
      }
    }
  )

  for (const entry of tracked) {
    if (entry.indexEntry.relativePath !== entry.relativePath) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery index entry does not match its path'
      )
    }
  }

  return {
    version: 1,
    id,
    createdAt,
    updatedAt,
    status: status as GitRecoveryManifest['status'],
    actionSha256,
    tracked,
    untracked,
    ...(typeof value.error === 'string'
      ? { error: value.error.slice(0, 4_000) }
      : {})
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    // Windows and some filesystems do not support fsync on directories. Real
    // I/O failures still fail closed before the workspace mutation continues.
    if (
      !['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP', 'EBADF'].includes(
        (error as NodeJS.ErrnoException).code ?? ''
      )
    ) {
      throw error
    }
  }
}

async function readExactlyBounded(
  handle: FileHandle,
  expectedBytes: number,
  maximumBytes: number
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > maximumBytes
  ) {
    throw new GitServiceError(
      'OUTPUT_LIMIT',
      'File exceeds Ground’s bounded recovery read limit'
    )
  }
  const bounded = Buffer.allocUnsafe(expectedBytes + 1)
  let offset = 0
  while (offset < bounded.byteLength) {
    const { bytesRead } = await handle.read(
      bounded,
      offset,
      bounded.byteLength - offset,
      null
    )
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset !== expectedBytes) {
    throw new GitServiceError(
      'UNSAFE_PATH',
      'File changed while Ground was reading its bounded snapshot'
    )
  }
  return Buffer.from(bounded.subarray(0, offset))
}

export class GitWorkspaceService {
  readonly gitExecutable: string
  private readonly workspacePath: string
  private readonly worktreeRoot: string
  private readonly defaultTimeoutMs: number
  private readonly maxOutputBytes: number
  private readonly filterDiscovery = new Map<string, Promise<string[]>>()
  private readonly preparedPathMutations = new WeakSet<object>()
  private readonly preparedCommits = new WeakMap<object, GitCommitAuthority>()
  private readonly preparedPathReverts = new WeakSet<object>()
  private readonly preparedRecoveryUndos = new WeakSet<object>()

  private constructor(
    gitExecutable: string,
    workspacePath: string,
    worktreeRoot: string,
    defaultTimeoutMs: number,
    maxOutputBytes: number,
    private readonly revalidateGitExecutable?: () => Promise<string>
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
      maxOutputBytes,
      options.revalidateGitExecutable
    )
    const version = await service.runGit(['--version'], {
      signal: options.signal,
      timeoutMs,
      maxOutputBytes: 16_384
    })
    if (!gitSupportsRequiredFeatures(version.stdout)) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Ground requires Git 2.23 or newer'
      )
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
    await this.currentGitExecutable()
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
    const executable = await this.currentGitExecutable()
    return runAbsoluteProcess(
      executable,
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

  private async currentGitExecutable(): Promise<string> {
    if (!this.revalidateGitExecutable) return this.gitExecutable
    let executable: string
    try {
      executable = await this.revalidateGitExecutable()
    } catch (error) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'The trusted Git executable changed or became unavailable',
        { cause: error }
      )
    }
    if (!samePath(executable, this.gitExecutable)) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git executable trust resolved to a different path'
      )
    }
    return executable
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
        const executable = await this.currentGitExecutable()
        result = await runAbsoluteProcess(
          executable,
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

  private async parentDirectorySnapshots(
    relativePath: string
  ): Promise<readonly ParentDirectoryIdentity[]> {
    const segments = relativePath.split(path.sep)
    segments.pop()
    const directories = [this.workspacePath]
    let current = this.workspacePath
    for (const segment of segments) {
      current = path.join(current, segment)
      directories.push(current)
    }

    const snapshots: ParentDirectoryIdentity[] = []
    for (const directory of directories) {
      let details: Awaited<ReturnType<typeof lstat>>
      try {
        details = await lstat(directory, { bigint: true })
      } catch (error) {
        throw new GitServiceError(
          'UNSAFE_PATH',
          `Selected path parent does not exist: ${toDisplayPath(relativePath)}`,
          { cause: error }
        )
      }
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new GitServiceError(
          'UNSAFE_PATH',
          `Selected path parent is not a regular directory: ${toDisplayPath(relativePath)}`
        )
      }
      const canonical = await realpath(directory)
      if (
        !samePath(canonical, directory) ||
        (!samePath(canonical, this.workspacePath) &&
          !isPathInside(this.workspacePath, canonical))
      ) {
        throw new GitServiceError(
          'UNSAFE_PATH',
          `Selected path parent leaves the workspace: ${toDisplayPath(relativePath)}`
        )
      }
      snapshots.push(
        freezeParentIdentity({
          relativePath:
            samePath(directory, this.workspacePath)
              ? '.'
              : path.relative(this.workspacePath, directory),
          identity: filesystemIdentity(details)
        })
      )
    }
    return Object.freeze(snapshots)
  }

  private async captureWorkspacePath(
    relativePath: string,
    allowMissing: boolean
  ): Promise<{
    snapshot: GitWorkingPathSnapshot
    contents?: Buffer
  }> {
    const target = this.resolveWorkspacePath(relativePath)
    const parents = await this.parentDirectorySnapshots(target.relative)
    let lexicalDetails: Awaited<ReturnType<typeof lstat>>
    try {
      lexicalDetails = await lstat(target.absolute, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) {
        return {
          snapshot: freezeWorkingSnapshot({
            relativePath: target.relative,
            existed: false,
            parents
          })
        }
      }
      throw new GitServiceError(
        'NOT_FOUND',
        `Selected path does not exist: ${toDisplayPath(target.relative)}`,
        { cause: error }
      )
    }
    if (lexicalDetails.isSymbolicLink() || !lexicalDetails.isFile()) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        `Selected path must be a regular file, not a directory, symlink, or submodule: ${toDisplayPath(target.relative)}`
      )
    }
    if (lexicalDetails.size > BigInt(MAX_REVERT_FILE_BYTES)) {
      throw new GitServiceError(
        'OUTPUT_LIMIT',
        `Selected file exceeds the ${MAX_REVERT_FILE_BYTES} byte recovery limit: ${toDisplayPath(target.relative)}`
      )
    }
    const canonical = await realpath(target.absolute)
    if (!samePath(canonical, target.absolute)) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        `Selected path is not canonical: ${toDisplayPath(target.relative)}`
      )
    }

    const noFollow =
      typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(target.absolute, constants.O_RDONLY | noFollow)
    try {
      const before = await handle.stat({ bigint: true })
      if (
        !before.isFile() ||
        before.dev !== lexicalDetails.dev ||
        before.ino !== lexicalDetails.ino ||
        before.size > BigInt(MAX_REVERT_FILE_BYTES)
      ) {
        throw new GitServiceError(
          'UNSAFE_PATH',
          `Selected path changed while it was inspected: ${toDisplayPath(target.relative)}`
        )
      }
      const contents = await readExactlyBounded(
        handle,
        Number(before.size),
        MAX_REVERT_FILE_BYTES
      )
      const after = await handle.stat({ bigint: true })
      if (
        contents.byteLength !== Number(before.size) ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new GitServiceError(
          'UNSAFE_PATH',
          `Selected path changed while it was read: ${toDisplayPath(target.relative)}`
        )
      }
      return {
        snapshot: freezeWorkingSnapshot({
          relativePath: target.relative,
          existed: true,
          sha256: sha256(contents),
          identity: filesystemIdentity(after),
          parents
        }),
        contents
      }
    } finally {
      await handle.close()
    }
  }

  private async captureIndexEntries(
    paths: readonly string[],
    options: GitOperationOptions = {}
  ): Promise<readonly GitIndexEntry[]> {
    if (paths.length === 0) return Object.freeze([])
    const result = await this.runGit(
      ['ls-files', '--stage', '-z', '--', ...paths],
      {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options),
        maxOutputBytes: Math.min(this.maxOutputBytes, 2_000_000)
      }
    )
    const entriesByPath = new Map<string, GitIndexEntry[]>()
    for (const record of result.stdout.split('\0').filter(Boolean)) {
      const separator = record.indexOf('\t')
      if (separator < 0) {
        throw new GitServiceError(
          'COMMAND_FAILED',
          'Git returned an invalid index entry'
        )
      }
      const header = record.slice(0, separator)
      const rawPath = record.slice(separator + 1)
      const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u.exec(
        header
      )
      if (!match) {
        throw new GitServiceError(
          'COMMAND_FAILED',
          'Git returned an invalid index entry'
        )
      }
      const normalizedPath = this.resolveWorkspacePath(rawPath).relative
      const mode = match[1]
      if (match[3] !== '0') {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Conflicted paths cannot be restored in Ground: ${toDisplayPath(normalizedPath)}`
        )
      }
      if (mode === '160000') {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Submodules cannot be restored in Ground: ${toDisplayPath(normalizedPath)}`
        )
      }
      if (mode === '120000') {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Tracked symlinks cannot be restored in Ground: ${toDisplayPath(normalizedPath)}`
        )
      }
      if (mode !== '100644' && mode !== '100755') {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Unsupported tracked file mode for restore: ${toDisplayPath(normalizedPath)}`
        )
      }
      const entry = freezeIndexEntry({
        relativePath: normalizedPath,
        mode,
        oid: match[2] as string
      })
      const existing = entriesByPath.get(normalizedPath) ?? []
      existing.push(entry)
      entriesByPath.set(normalizedPath, existing)
    }

    return Object.freeze(
      paths.map((selectedPath) => {
        const entries = entriesByPath.get(selectedPath)
        if (!entries || entries.length !== 1) {
          throw new GitServiceError(
            'INVALID_ARGUMENT',
            `Selected tracked path no longer has one ordinary index entry: ${toDisplayPath(selectedPath)}`
          )
        }
        return entries[0] as GitIndexEntry
      })
    )
  }

  private async selectedWorkingDiff(
    trackedPaths: readonly string[],
    options: GitOperationOptions = {}
  ): Promise<string> {
    if (trackedPaths.length === 0) return ''
    const previewLimit = Math.min(
      MAX_REVERT_PREVIEW_BYTES,
      this.maxOutputBytes
    )
    try {
      const result = await this.runGit(
        [
          'diff',
          '--binary',
          '--full-index',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--',
          ...trackedPaths
        ],
        {
          signal: options.signal,
          timeoutMs: this.operationTimeout(options),
          maxOutputBytes: previewLimit,
          neutralizeFilters: true
        }
      )
      return result.stdout
    } catch (error) {
      if (
        error instanceof GitServiceError &&
        error.code === 'OUTPUT_LIMIT'
      ) {
        throw new GitServiceError(
          'OUTPUT_LIMIT',
          'The complete selected restore preview exceeds Ground’s safety limit'
        )
      }
      throw error
    }
  }

  private revertPreview(
    trackedDiff: string,
    untrackedSnapshots: readonly GitWorkingPathSnapshot[]
  ): string {
    const sections: string[] = []
    if (trackedDiff) {
      sections.push(
        [
          'Tracked working-tree changes that will be restored to the current Git index:',
          '',
          trackedDiff.replace(/\n+$/u, '')
        ].join('\n')
      )
    }
    if (untrackedSnapshots.length > 0) {
      sections.push(
        [
          'Untracked files that will be moved into Ground recovery (not deleted):',
          '',
          ...untrackedSnapshots.map(
            (snapshot, index) =>
              `${index + 1}. ${toDisplayPath(snapshot.relativePath)} — ${
                snapshot.identity?.size ?? '0'
              } bytes — SHA-256 ${snapshot.sha256 ?? '(missing)'}`
          )
        ].join('\n')
      )
    }
    const preview = sections.join('\n\n')
    if (
      !preview ||
      Buffer.byteLength(preview, 'utf8') > MAX_REVERT_PREVIEW_BYTES
    ) {
      throw new GitServiceError(
        'OUTPUT_LIMIT',
        'The complete selected restore preview exceeds Ground’s safety limit'
      )
    }
    return preview
  }

  private async assertPreparedPathRevertCurrent(
    prepared: PreparedGitPathRevert,
    options: GitOperationOptions = {}
  ): Promise<void> {
    const status = await this.status(options)
    const conflicts = new Set(status.conflicted)
    const trackedEligible = new Set(status.unstaged)
    const untrackedEligible = new Set(status.untracked)
    for (const selectedPath of prepared.trackedPaths) {
      const displayPath = toDisplayPath(selectedPath)
      if (
        conflicts.has(displayPath) ||
        !trackedEligible.has(displayPath)
      ) {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Selected tracked path changed since review: ${displayPath}`
        )
      }
    }
    for (const selectedPath of prepared.untrackedPaths) {
      const displayPath = toDisplayPath(selectedPath)
      if (!untrackedEligible.has(displayPath)) {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Selected untracked path changed since review: ${displayPath}`
        )
      }
    }

    const currentIndex = await this.captureIndexEntries(
      prepared.trackedPaths,
      options
    )
    if (
      currentIndex.length !== prepared.indexEntries.length ||
      currentIndex.some(
        (entry, index) =>
          !sameIndexEntry(
            entry,
            prepared.indexEntries[index] as GitIndexEntry
          )
      )
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'The selected Git index entries changed since review'
      )
    }

    const currentSnapshots: GitWorkingPathSnapshot[] = []
    for (const selectedPath of [
      ...prepared.trackedPaths,
      ...prepared.untrackedPaths
    ]) {
      currentSnapshots.push(
        (
          await this.captureWorkspacePath(
            selectedPath,
            prepared.trackedPaths.includes(selectedPath)
          )
        ).snapshot
      )
    }
    if (
      currentSnapshots.length !== prepared.workingSnapshots.length ||
      currentSnapshots.some(
        (snapshot, index) =>
          !sameWorkingSnapshot(
            snapshot,
            prepared.workingSnapshots[index] as GitWorkingPathSnapshot
          )
      )
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Selected working-tree contents or parents changed since review'
      )
    }

    const trackedDiff = await this.selectedWorkingDiff(
      prepared.trackedPaths,
      options
    )
    const preview = this.revertPreview(
      trackedDiff,
      currentSnapshots.slice(prepared.trackedPaths.length)
    )
    if (
      sha256(preview) !== prepared.previewSha256 ||
      preview !== prepared.preview
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'The complete selected restore preview changed since review'
      )
    }
  }

  private async assertTrackedRevertCurrent(
    prepared: PreparedGitPathRevert,
    options: GitOperationOptions = {}
  ): Promise<void> {
    const currentIndex = await this.captureIndexEntries(
      prepared.trackedPaths,
      options
    )
    if (
      currentIndex.length !== prepared.indexEntries.length ||
      currentIndex.some(
        (entry, index) =>
          !sameIndexEntry(
            entry,
            prepared.indexEntries[index] as GitIndexEntry
          )
      )
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'The selected Git index entries changed before restore'
      )
    }
    for (let index = 0; index < prepared.trackedPaths.length; index += 1) {
      const selectedPath = prepared.trackedPaths[index] as string
      const current = (
        await this.captureWorkspacePath(selectedPath, true)
      ).snapshot
      if (
        !sameWorkingFileState(
          current,
          prepared.workingSnapshots[index] as GitWorkingPathSnapshot
        )
      ) {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Selected tracked path changed before restore: ${toDisplayPath(selectedPath)}`
        )
      }
    }
  }

  private preparedPathRevertIntegrity(
    prepared: PreparedGitPathRevert
  ): boolean {
    if (
      !Object.isFrozen(prepared) ||
      prepared.version !== 1 ||
      !Object.isFrozen(prepared.trackedPaths) ||
      !Object.isFrozen(prepared.untrackedPaths) ||
      !Object.isFrozen(prepared.indexEntries) ||
      !Object.isFrozen(prepared.workingSnapshots) ||
      sha256(prepared.preview) !== prepared.previewSha256
    ) {
      return false
    }
    const {
      actionSha256: _actionSha256,
      ...withoutFingerprint
    } = prepared
    return (
      SHA256_PATTERN.test(prepared.actionSha256) &&
      preparedRevertFingerprint(withoutFingerprint) ===
        prepared.actionSha256
    )
  }

  async preparePathRevert(
    inputPaths: readonly string[],
    options: GitOperationOptions = {}
  ): Promise<PreparedGitPathRevert> {
    await this.assertRootStillPinned()
    const paths = this.resolveMutationPaths(inputPaths).sort((left, right) =>
      toDisplayPath(left).localeCompare(toDisplayPath(right))
    )
    const status = await this.status(options)
    const conflicted = new Set(status.conflicted)
    const unstaged = new Set(status.unstaged)
    const untracked = new Set(status.untracked)
    const trackedPaths: string[] = []
    const untrackedPaths: string[] = []
    for (const selectedPath of paths) {
      const displayPath = toDisplayPath(selectedPath)
      if (conflicted.has(displayPath)) {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Resolve this conflict before restoring it in Ground: ${displayPath}`
        )
      }
      if (unstaged.has(displayPath)) {
        trackedPaths.push(selectedPath)
        continue
      }
      if (untracked.has(displayPath)) {
        untrackedPaths.push(selectedPath)
        continue
      }
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        `Selected path is no longer an unstaged or untracked file: ${displayPath}`
      )
    }

    const indexEntries = await this.captureIndexEntries(
      trackedPaths,
      options
    )
    const workingSnapshots: GitWorkingPathSnapshot[] = []
    let totalBytes = 0
    for (const selectedPath of [...trackedPaths, ...untrackedPaths]) {
      const captured = await this.captureWorkspacePath(
        selectedPath,
        trackedPaths.includes(selectedPath)
      )
      if (
        untrackedPaths.includes(selectedPath) &&
        !captured.snapshot.existed
      ) {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Selected untracked file disappeared during review: ${toDisplayPath(selectedPath)}`
        )
      }
      totalBytes += Number(captured.snapshot.identity?.size ?? '0')
      if (totalBytes > MAX_REVERT_TOTAL_BYTES) {
        throw new GitServiceError(
          'OUTPUT_LIMIT',
          `Selected files exceed the ${MAX_REVERT_TOTAL_BYTES} byte recovery limit`
        )
      }
      workingSnapshots.push(captured.snapshot)
    }
    const trackedDiff = await this.selectedWorkingDiff(
      trackedPaths,
      options
    )
    if (trackedPaths.length > 0 && !trackedDiff) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Selected tracked changes disappeared during review'
      )
    }
    const preview = this.revertPreview(
      trackedDiff,
      workingSnapshots.slice(trackedPaths.length)
    )
    const base = {
      version: 1 as const,
      trackedPaths: Object.freeze([...trackedPaths]),
      untrackedPaths: Object.freeze([...untrackedPaths]),
      indexEntries: Object.freeze(indexEntries.map(freezeIndexEntry)),
      workingSnapshots: Object.freeze(
        workingSnapshots.map(freezeWorkingSnapshot)
      ),
      preview,
      previewSha256: sha256(preview)
    }
    const prepared = Object.freeze({
      ...base,
      actionSha256: preparedRevertFingerprint(base)
    }) satisfies PreparedGitPathRevert
    await this.assertPreparedPathRevertCurrent(prepared, options)
    this.preparedPathReverts.add(prepared)
    return prepared
  }

  private async recoveryRoot(
    create: boolean
  ): Promise<string | undefined> {
    await this.assertRootStillPinned()
    const candidate = path.join(this.worktreeRoot, RECOVERY_DIRECTORY_NAME)
    let details: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      details = await lstat(candidate, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!details && !create) return undefined
    if (!details) {
      try {
        await mkdir(candidate, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      details = await lstat(candidate, { bigint: true })
      await syncDirectory(this.worktreeRoot)
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Ground’s Git recovery root is not a regular directory'
      )
    }
    const canonical = await realpath(candidate)
    if (
      !samePath(canonical, candidate) ||
      !isPathInside(this.worktreeRoot, canonical)
    ) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Ground’s Git recovery root is not canonical'
      )
    }
    return canonical
  }

  private async recoveryOperationDirectory(
    recoveryId: string,
    create: boolean
  ): Promise<string> {
    if (!RECOVERY_ID_PATTERN.test(recoveryId)) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Git recovery identifier is invalid'
      )
    }
    const root = await this.recoveryRoot(create)
    if (!root) {
      throw new GitServiceError('NOT_FOUND', 'Git recovery was not found')
    }
    const operationDirectory = path.join(root, recoveryId)
    if (create) {
      await mkdir(operationDirectory, { mode: 0o700 })
      await syncDirectory(root)
    }
    const details = await lstat(operationDirectory, { bigint: true }).catch(
      (error: unknown) => {
        throw new GitServiceError('NOT_FOUND', 'Git recovery was not found', {
          cause: error
        })
      }
    )
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Git recovery operation is not a regular directory'
      )
    }
    const canonical = await realpath(operationDirectory)
    if (
      !samePath(canonical, operationDirectory) ||
      !isPathInside(root, canonical)
    ) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Git recovery operation is not canonical'
      )
    }
    return canonical
  }

  private recoveryPayloadPath(
    operationDirectory: string,
    name: string
  ): string {
    if (
      !/^(?:tracked|untracked|undo-current)-\d{6}\.bin$/u.test(name)
    ) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery payload name is invalid'
      )
    }
    const candidate = path.join(operationDirectory, name)
    if (!isPathInside(operationDirectory, candidate)) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Git recovery payload escapes its operation'
      )
    }
    return candidate
  }

  private async writeRecoveryPayload(
    operationDirectory: string,
    name: string,
    contents: Buffer,
    mode: number
  ): Promise<void> {
    const target = this.recoveryPayloadPath(operationDirectory, name)
    const noFollow =
      typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        noFollow,
      0o600
    )
    try {
      await handle.writeFile(contents)
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(operationDirectory)
  }

  private async readRecoveryPayload(
    operationDirectory: string,
    name: string,
    expected: GitWorkingPathSnapshot,
    requireOriginalFileIdentity = false
  ): Promise<Buffer> {
    if (!expected.existed || !expected.sha256 || !expected.identity) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery payload has no expected file identity'
      )
    }
    const target = this.recoveryPayloadPath(operationDirectory, name)
    const lexical = await lstat(target, { bigint: true }).catch(
      (error: unknown) => {
        throw new GitServiceError(
          'NOT_FOUND',
          'Git recovery payload is missing',
          { cause: error }
        )
      }
    )
    if (
      lexical.isSymbolicLink() ||
      !lexical.isFile() ||
      lexical.size > BigInt(MAX_REVERT_FILE_BYTES)
    ) {
      throw new GitServiceError(
        'UNSAFE_PATH',
        'Git recovery payload is not a bounded regular file'
      )
    }
    const noFollow =
      typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(target, constants.O_RDONLY | noFollow)
    try {
      const before = await handle.stat({ bigint: true })
      const contents = await readExactlyBounded(
        handle,
        Number(before.size),
        MAX_REVERT_FILE_BYTES
      )
      const after = await handle.stat({ bigint: true })
      if (
        before.dev !== lexical.dev ||
        before.ino !== lexical.ino ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        contents.byteLength !== Number(after.size) ||
        after.size.toString() !== expected.identity.size ||
        Number(after.mode & 0o777n) !== expected.identity.mode ||
        (requireOriginalFileIdentity &&
          (after.dev.toString() !== expected.identity.device ||
            after.ino.toString() !== expected.identity.inode)) ||
        sha256(contents) !== expected.sha256
      ) {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          'Git recovery payload changed or failed validation'
        )
      }
      return contents
    } finally {
      await handle.close()
    }
  }

  private serializedRecoveryManifest(
    manifest: GitRecoveryManifest
  ): string {
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`
    if (
      Buffer.byteLength(serialized, 'utf8') >
      MAX_RECOVERY_MANIFEST_BYTES
    ) {
      throw new GitServiceError(
        'OUTPUT_LIMIT',
        'Git recovery manifest exceeds Ground’s safety limit'
      )
    }
    return serialized
  }

  private async writeRecoveryManifest(
    operationDirectory: string,
    manifest: GitRecoveryManifest
  ): Promise<void> {
    const serialized = this.serializedRecoveryManifest(manifest)
    const target = path.join(operationDirectory, RECOVERY_MANIFEST_NAME)
    const temporary = path.join(
      operationDirectory,
      `.manifest-${randomUUID()}.tmp`
    )
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    )
    let temporaryExists = true
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
      await handle.close()
      await rename(temporary, target)
      temporaryExists = false
      await syncDirectory(operationDirectory)
    } finally {
      await handle.close().catch(() => undefined)
      if (temporaryExists) await unlink(temporary).catch(() => undefined)
    }
  }

  private async loadRecoveryManifest(
    recoveryId: string
  ): Promise<{
    manifest: GitRecoveryManifest
    operationDirectory: string
    serialized: string
  }> {
    const operationDirectory = await this.recoveryOperationDirectory(
      recoveryId,
      false
    )
    const manifestPath = path.join(
      operationDirectory,
      RECOVERY_MANIFEST_NAME
    )
    const lexical = await lstat(manifestPath, { bigint: true }).catch(
      (error: unknown) => {
        throw new GitServiceError(
          'NOT_FOUND',
          'Git recovery manifest is missing',
          { cause: error }
        )
      }
    )
    if (
      lexical.isSymbolicLink() ||
      !lexical.isFile() ||
      lexical.size > BigInt(MAX_RECOVERY_MANIFEST_BYTES)
    ) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery manifest is not a bounded regular file'
      )
    }
    const noFollow =
      typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(manifestPath, constants.O_RDONLY | noFollow)
    let serialized: string
    try {
      const before = await handle.stat({ bigint: true })
      if (
        before.dev !== lexical.dev ||
        before.ino !== lexical.ino ||
        before.size > BigInt(MAX_RECOVERY_MANIFEST_BYTES)
      ) {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          'Git recovery manifest changed before it was read'
        )
      }
      const contents = await readExactlyBounded(
        handle,
        Number(before.size),
        MAX_RECOVERY_MANIFEST_BYTES
      )
      const after = await handle.stat({ bigint: true })
      if (contents.byteLength !== Number(lexical.size)) {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          'Git recovery manifest changed while it was read'
        )
      }
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          'Git recovery manifest changed while it was read'
        )
      }
      serialized = contents.toString('utf8')
    } finally {
      await handle.close()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(serialized)
    } catch (error) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery manifest is invalid JSON',
        { cause: error }
      )
    }
    const manifest = parseRecoveryManifest(parsed)
    if (manifest.id !== recoveryId) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery manifest identifier does not match its directory'
      )
    }
    const resolvedPaths = this.resolveMutationPaths([
      ...manifest.tracked.map((entry) => entry.relativePath),
      ...manifest.untracked.map((entry) => entry.relativePath)
    ])
    const manifestPaths = [
      ...manifest.tracked.map((entry) => entry.relativePath),
      ...manifest.untracked.map((entry) => entry.relativePath)
    ]
    if (
      resolvedPaths.length !== manifestPaths.length ||
      resolvedPaths.some(
        (candidate, index) => candidate !== manifestPaths[index]
      )
    ) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Git recovery manifest paths are invalid'
      )
    }
    return { manifest, operationDirectory, serialized }
  }

  private recoverySummary(
    manifest: GitRecoveryManifest
  ): GitRecoverySummary {
    const publicStatus: GitRecoveryStatus =
      manifest.status === 'applied' ||
      manifest.status === 'restored' ||
      manifest.status === 'recovery-required'
        ? manifest.status
        : 'recovery-required'
    return Object.freeze({
      id: manifest.id,
      createdAt: manifest.createdAt,
      status: publicStatus,
      trackedPaths: Object.freeze(
        manifest.tracked.map((entry) => toDisplayPath(entry.relativePath))
      ),
      untrackedPaths: Object.freeze(
        manifest.untracked.map((entry) => toDisplayPath(entry.relativePath))
      ),
      canUndo: manifest.status === 'applied'
    })
  }

  async executePreparedPathRevert(
    prepared: PreparedGitPathRevert,
    options: GitOperationOptions = {}
  ): Promise<GitPathRevertResult> {
    if (
      !prepared ||
      !this.preparedPathReverts.has(prepared) ||
      !this.preparedPathRevertIntegrity(prepared)
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Git path restore was not prepared by this workspace'
      )
    }
    this.preparedPathReverts.delete(prepared)
    await this.assertRootStillPinned()
    await this.assertPreparedPathRevertCurrent(prepared, options)

    const recoveryId = randomUUID()
    const operationDirectory = await this.recoveryOperationDirectory(
      recoveryId,
      true
    )
    const timestamp = new Date().toISOString()
    const manifest: GitRecoveryManifest = {
      version: 1,
      id: recoveryId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'prepared',
      actionSha256: prepared.actionSha256,
      tracked: prepared.trackedPaths.map((relativePath, index) => ({
        relativePath,
        indexEntry: prepared.indexEntries[index] as GitIndexEntry,
        before:
          prepared.workingSnapshots[index] as GitWorkingPathSnapshot,
        ...((prepared.workingSnapshots[index] as GitWorkingPathSnapshot)
          .existed
          ? {
              backupName: `tracked-${index
                .toString()
                .padStart(6, '0')}.bin`
            }
          : {})
      })),
      untracked: prepared.untrackedPaths.map((relativePath, index) => ({
        relativePath,
        before: prepared.workingSnapshots[
          prepared.trackedPaths.length + index
        ] as GitWorkingPathSnapshot,
        quarantineName: `untracked-${index
          .toString()
          .padStart(6, '0')}.bin`,
        moved: false
      }))
    }

    let manifestPersisted = false
    try {
      for (const entry of manifest.tracked) {
        if (!entry.before.existed || !entry.backupName) continue
        const captured = await this.captureWorkspacePath(
          entry.relativePath,
          false
        )
        if (
          !sameWorkingSnapshot(captured.snapshot, entry.before) ||
          !captured.contents
        ) {
          throw new GitServiceError(
            'INVALID_ARGUMENT',
            `Tracked file changed while its recovery copy was created: ${toDisplayPath(entry.relativePath)}`
          )
        }
        await this.writeRecoveryPayload(
          operationDirectory,
          entry.backupName,
          captured.contents,
          entry.before.identity?.mode ?? 0o600
        )
      }

      // This fsynced manifest is the durable boundary before any workspace
      // path is moved or restored.
      await this.writeRecoveryManifest(operationDirectory, manifest)
      manifestPersisted = true
      await this.assertPreparedPathRevertCurrent(prepared, options)

      manifest.status = 'mutating'
      manifest.updatedAt = new Date().toISOString()
      await this.writeRecoveryManifest(operationDirectory, manifest)

      for (const entry of manifest.untracked) {
        const captured = await this.captureWorkspacePath(
          entry.relativePath,
          false
        )
        if (!sameWorkingFileState(captured.snapshot, entry.before)) {
          throw new GitServiceError(
            'INVALID_ARGUMENT',
            `Untracked file changed before quarantine: ${toDisplayPath(entry.relativePath)}`
          )
        }
        const source = this.resolveWorkspacePath(entry.relativePath).absolute
        const destination = this.recoveryPayloadPath(
          operationDirectory,
          entry.quarantineName
        )
        await lstat(destination)
          .then(() => {
            throw new GitServiceError(
              'UNSAFE_PATH',
              'Git recovery quarantine destination already exists'
            )
          })
          .catch((error: unknown) => {
            if (
              error instanceof GitServiceError ||
              (error as NodeJS.ErrnoException).code !== 'ENOENT'
            ) {
              throw error
            }
          })
        await rename(source, destination)
        await this.readRecoveryPayload(
          operationDirectory,
          entry.quarantineName,
          entry.before,
          true
        )
        entry.moved = true
        manifest.updatedAt = new Date().toISOString()
        await this.writeRecoveryManifest(operationDirectory, manifest)
      }

      if (prepared.trackedPaths.length > 0) {
        await this.assertTrackedRevertCurrent(prepared, options)
        await this.runGit(
          ['restore', '--worktree', '--', ...prepared.trackedPaths],
          {
            signal: options.signal,
            timeoutMs: this.operationTimeout(
              options,
              MUTATION_TIMEOUT_MS
            ),
            maxOutputBytes: this.maxOutputBytes,
            neutralizeFilters: true
          }
        )
        const restoredIndex = await this.captureIndexEntries(
          prepared.trackedPaths,
          options
        )
        if (
          restoredIndex.length !== prepared.indexEntries.length ||
          restoredIndex.some(
            (entry, index) =>
              !sameIndexEntry(
                entry,
                prepared.indexEntries[index] as GitIndexEntry
              )
          )
        ) {
          throw new GitServiceError(
            'INVALID_ARGUMENT',
            'The selected Git index entries changed while files were restored'
          )
        }
      }

      const afterSnapshots: GitWorkingPathSnapshot[] = []
      for (const selectedPath of [
        ...prepared.trackedPaths,
        ...prepared.untrackedPaths
      ]) {
        afterSnapshots.push(
          (await this.captureWorkspacePath(selectedPath, true)).snapshot
        )
      }
      const remainingDiff = await this.selectedWorkingDiff(
        prepared.trackedPaths,
        options
      )
      if (remainingDiff) {
        throw new GitServiceError(
          'COMMAND_FAILED',
          'Selected tracked paths still differ from the Git index after restore'
        )
      }
      for (let index = 0; index < manifest.tracked.length; index += 1) {
        const after = afterSnapshots[index] as GitWorkingPathSnapshot
        if (!after.existed) {
          throw new GitServiceError(
            'COMMAND_FAILED',
            'Git did not restore every selected tracked file'
          )
        }
        ;(manifest.tracked[index] as RecoveryTrackedEntry).after = after
      }
      for (let index = 0; index < manifest.untracked.length; index += 1) {
        const after = afterSnapshots[
          manifest.tracked.length + index
        ] as GitWorkingPathSnapshot
        if (after.existed) {
          throw new GitServiceError(
            'COMMAND_FAILED',
            'An untracked path reappeared during quarantine'
          )
        }
        ;(manifest.untracked[index] as RecoveryUntrackedEntry).after = after
      }
      manifest.status = 'applied'
      manifest.updatedAt = new Date().toISOString()
      delete manifest.error
      await this.writeRecoveryManifest(operationDirectory, manifest)
      return {
        recovery: this.recoverySummary(manifest)
      }
    } catch (error) {
      if (manifestPersisted) {
        manifest.status = 'recovery-required'
        manifest.updatedAt = new Date().toISOString()
        manifest.error =
          error instanceof Error
            ? safeDiagnostic(error.message)
            : 'Unknown Git restore failure'
        await this.writeRecoveryManifest(operationDirectory, manifest).catch(
          () => undefined
        )
        throw new GitServiceError(
          'COMMAND_FAILED',
          `Git restore did not finish cleanly. Recovery ${recoveryId} was preserved.`,
          { cause: error }
        )
      }
      throw error
    }
  }

  async listRecoveries(): Promise<GitRecoverySummary[]> {
    const root = await this.recoveryRoot(false)
    if (!root) return []
    const entries = await readdir(root, { withFileTypes: true })
    const recoveries: GitRecoverySummary[] = []
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !RECOVERY_ID_PATTERN.test(entry.name)
      ) {
        continue
      }
      try {
        const { manifest } = await this.loadRecoveryManifest(entry.name)
        recoveries.push(this.recoverySummary(manifest))
      } catch {
        // Corrupt or tampered recovery data grants no workspace authority.
      }
    }
    return recoveries.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    )
  }

  private async assertManifestAfterState(
    manifest: GitRecoveryManifest
  ): Promise<readonly GitWorkingPathSnapshot[]> {
    const currentSnapshots: GitWorkingPathSnapshot[] = []
    for (const entry of [...manifest.tracked, ...manifest.untracked]) {
      if (!entry.after) {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          'Git recovery has no completed after-state'
        )
      }
      const current = (
        await this.captureWorkspacePath(entry.relativePath, true)
      ).snapshot
      if (!sameWorkingSnapshot(current, entry.after)) {
        throw new GitServiceError(
          'INVALID_ARGUMENT',
          `Workspace path changed after Git restore; undo will not overwrite it: ${toDisplayPath(entry.relativePath)}`
        )
      }
      currentSnapshots.push(current)
    }
    return Object.freeze(currentSnapshots.map(freezeWorkingSnapshot))
  }

  private async validateRecoveryPayloads(
    manifest: GitRecoveryManifest,
    operationDirectory: string
  ): Promise<void> {
    for (const entry of manifest.tracked) {
      if (entry.before.existed && entry.backupName) {
        await this.readRecoveryPayload(
          operationDirectory,
          entry.backupName,
          entry.before
        )
      }
    }
    for (const entry of manifest.untracked) {
      if (!entry.moved) {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          'Git recovery did not quarantine every untracked file'
        )
      }
      await this.readRecoveryPayload(
        operationDirectory,
        entry.quarantineName,
        entry.before,
        true
      )
    }
  }

  private preparedUndoIntegrity(
    prepared: PreparedGitRecoveryUndo
  ): boolean {
    if (
      !Object.isFrozen(prepared) ||
      prepared.version !== 1 ||
      !Object.isFrozen(prepared.currentSnapshots) ||
      sha256(prepared.preview) !== prepared.previewSha256
    ) {
      return false
    }
    const {
      actionSha256: _actionSha256,
      ...withoutFingerprint
    } = prepared
    return (
      SHA256_PATTERN.test(prepared.manifestSha256) &&
      SHA256_PATTERN.test(prepared.actionSha256) &&
      preparedUndoFingerprint(withoutFingerprint) ===
        prepared.actionSha256
    )
  }

  async prepareRecoveryUndo(
    recoveryId: string
  ): Promise<PreparedGitRecoveryUndo> {
    await this.assertRootStillPinned()
    const { manifest, operationDirectory, serialized } =
      await this.loadRecoveryManifest(recoveryId)
    if (manifest.status !== 'applied') {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Only a completed Git restore can be undone automatically'
      )
    }
    const currentSnapshots = await this.assertManifestAfterState(manifest)
    await this.validateRecoveryPayloads(manifest, operationDirectory)
    const preview = [
      'Undo this completed Git restore without overwriting later workspace changes:',
      '',
      ...manifest.tracked.map(
        (entry, index) =>
          `${index + 1}. Restore tracked pre-action state: ${toDisplayPath(entry.relativePath)}`
      ),
      ...manifest.untracked.map(
        (entry, index) =>
          `${manifest.tracked.length + index + 1}. Return quarantined untracked file: ${toDisplayPath(entry.relativePath)}`
      ),
      '',
      `Recovery manifest SHA-256: ${sha256(serialized)}`
    ].join('\n')
    if (Buffer.byteLength(preview, 'utf8') > MAX_REVERT_PREVIEW_BYTES) {
      throw new GitServiceError(
        'OUTPUT_LIMIT',
        'The complete recovery undo preview exceeds Ground’s safety limit'
      )
    }
    const base = {
      version: 1 as const,
      recoveryId,
      manifestSha256: sha256(serialized),
      currentSnapshots: Object.freeze(
        currentSnapshots.map(freezeWorkingSnapshot)
      ),
      preview,
      previewSha256: sha256(preview)
    }
    const prepared = Object.freeze({
      ...base,
      actionSha256: preparedUndoFingerprint(base)
    }) satisfies PreparedGitRecoveryUndo
    this.preparedRecoveryUndos.add(prepared)
    return prepared
  }

  private async installFileWithoutOverwrite(
    target: string,
    contents: Buffer,
    mode: number
  ): Promise<void> {
    const parent = path.dirname(target)
    const temporary = path.join(
      parent,
      `.ground-recovery-${randomUUID()}.tmp`
    )
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    )
    let temporaryExists = true
    try {
      await handle.writeFile(contents)
      await handle.chmod(mode)
      await handle.sync()
      await handle.close()
      // link(2) fails with EEXIST instead of overwriting a path that appeared
      // after the final validation.
      await link(temporary, target)
      await unlink(temporary)
      temporaryExists = false
      await syncDirectory(parent)
    } finally {
      await handle.close().catch(() => undefined)
      if (temporaryExists) await unlink(temporary).catch(() => undefined)
    }
  }

  private async returnQuarantinedFileWithoutOverwrite(
    operationDirectory: string,
    entry: RecoveryUntrackedEntry
  ): Promise<void> {
    const source = this.recoveryPayloadPath(
      operationDirectory,
      entry.quarantineName
    )
    const target = this.resolveWorkspacePath(entry.relativePath).absolute
    // Hard-link creation is an atomic no-overwrite operation for the regular
    // files accepted by preparation. Initial quarantine used rename, so source
    // and target are necessarily on the same filesystem.
    await link(source, target)
    await unlink(source)
    await syncDirectory(path.dirname(target))
    await syncDirectory(operationDirectory)
  }

  async executePreparedRecoveryUndo(
    prepared: PreparedGitRecoveryUndo
  ): Promise<GitRecoverySummary> {
    if (
      !prepared ||
      !this.preparedRecoveryUndos.has(prepared) ||
      !this.preparedUndoIntegrity(prepared)
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Git recovery undo was not prepared by this workspace'
      )
    }
    this.preparedRecoveryUndos.delete(prepared)
    await this.assertRootStillPinned()
    const { manifest, operationDirectory, serialized } =
      await this.loadRecoveryManifest(prepared.recoveryId)
    if (
      manifest.status !== 'applied' ||
      sha256(serialized) !== prepared.manifestSha256
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Git recovery changed since undo review'
      )
    }
    const currentSnapshots = await this.assertManifestAfterState(manifest)
    if (
      currentSnapshots.length !== prepared.currentSnapshots.length ||
      currentSnapshots.some(
        (snapshot, index) =>
          !sameWorkingSnapshot(
            snapshot,
            prepared.currentSnapshots[index] as GitWorkingPathSnapshot
          )
      )
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Workspace paths changed since undo review'
      )
    }
    await this.validateRecoveryPayloads(manifest, operationDirectory)

    manifest.status = 'undoing'
    manifest.updatedAt = new Date().toISOString()
    await this.writeRecoveryManifest(operationDirectory, manifest)
    try {
      for (let index = 0; index < manifest.tracked.length; index += 1) {
        const entry = manifest.tracked[index] as RecoveryTrackedEntry
        const current = await this.captureWorkspacePath(
          entry.relativePath,
          false
        )
        if (
          !entry.after ||
          !sameWorkingFileState(current.snapshot, entry.after)
        ) {
          throw new GitServiceError(
            'INVALID_ARGUMENT',
            `Tracked path changed before undo: ${toDisplayPath(entry.relativePath)}`
          )
        }
        const target = this.resolveWorkspacePath(entry.relativePath).absolute
        const displacedName = `undo-current-${index
          .toString()
          .padStart(6, '0')}.bin`
        const displaced = this.recoveryPayloadPath(
          operationDirectory,
          displacedName
        )
        await lstat(displaced)
          .then(() => {
            throw new GitServiceError(
              'UNSAFE_PATH',
              'Git recovery undo destination already exists'
            )
          })
          .catch((error: unknown) => {
            if (
              error instanceof GitServiceError ||
              (error as NodeJS.ErrnoException).code !== 'ENOENT'
            ) {
              throw error
            }
          })
        await rename(target, displaced)
        await syncDirectory(operationDirectory)
        await syncDirectory(path.dirname(target))
        if (entry.before.existed && entry.backupName) {
          const contents = await this.readRecoveryPayload(
            operationDirectory,
            entry.backupName,
            entry.before
          )
          await this.installFileWithoutOverwrite(
            target,
            contents,
            entry.before.identity?.mode ?? 0o600
          )
        }
      }

      for (const entry of manifest.untracked) {
        const current = (
          await this.captureWorkspacePath(entry.relativePath, true)
        ).snapshot
        if (current.existed) {
          throw new GitServiceError(
            'INVALID_ARGUMENT',
            `Undo will not overwrite a recreated untracked path: ${toDisplayPath(entry.relativePath)}`
          )
        }
        await this.readRecoveryPayload(
          operationDirectory,
          entry.quarantineName,
          entry.before,
          true
        )
        await this.returnQuarantinedFileWithoutOverwrite(
          operationDirectory,
          entry
        )
      }

      for (const entry of [...manifest.tracked, ...manifest.untracked]) {
        const current = (
          await this.captureWorkspacePath(entry.relativePath, true)
        ).snapshot
        if (
          current.existed !== entry.before.existed ||
          current.sha256 !== entry.before.sha256 ||
          current.identity?.size !== entry.before.identity?.size ||
          current.identity?.mode !== entry.before.identity?.mode
        ) {
          throw new GitServiceError(
            'COMMAND_FAILED',
            `Git recovery undo could not verify restored content: ${toDisplayPath(entry.relativePath)}`
          )
        }
      }
      manifest.status = 'restored'
      manifest.updatedAt = new Date().toISOString()
      delete manifest.error
      await this.writeRecoveryManifest(operationDirectory, manifest)
      return this.recoverySummary(manifest)
    } catch (error) {
      manifest.status = 'recovery-required'
      manifest.updatedAt = new Date().toISOString()
      manifest.error =
        error instanceof Error
          ? safeDiagnostic(error.message)
          : 'Unknown Git recovery undo failure'
      await this.writeRecoveryManifest(operationDirectory, manifest).catch(
        () => undefined
      )
      throw new GitServiceError(
        'COMMAND_FAILED',
        `Git recovery undo did not finish cleanly. Recovery ${manifest.id} was preserved.`,
        { cause: error }
      )
    }
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

  private async captureStableDirectory(
    candidate: string,
    label: string
  ): Promise<StableDirectoryBinding> {
    const canonicalPath = await canonicalDirectory(candidate, label)
    let details: Awaited<ReturnType<typeof lstat>>
    try {
      details = await lstat(canonicalPath, { bigint: true })
    } catch (error) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        `${label} became unavailable`,
        { cause: error }
      )
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        `${label} is not a stable directory`
      )
    }
    return freezeStableDirectoryBinding({
      canonicalPath,
      identity: filesystemIdentity(details)
    })
  }

  private async captureCommitDirectories(
    options: GitOperationOptions
  ): Promise<{
    workspace: StableDirectoryBinding
    gitDirectory: StableDirectoryBinding
    commonDirectory: StableDirectoryBinding
  }> {
    const readDirectory = async (
      argument: '--git-dir' | '--git-common-dir',
      label: string
    ): Promise<StableDirectoryBinding> => {
      const result = await this.runGit(['rev-parse', argument], {
        signal: options.signal,
        timeoutMs: this.operationTimeout(options),
        maxOutputBytes: 64_000
      })
      const raw = result.stdout.replace(/\r?\n$/u, '')
      if (
        !raw ||
        raw !== raw.trim() ||
        raw.includes('\0') ||
        /[\r\n\u0001-\u001f\u007f]/u.test(raw)
      ) {
        throw new GitServiceError(
          'UNSAFE_CONFIGURATION',
          `Git returned an unsafe ${label.toLowerCase()} path`
        )
      }
      return this.captureStableDirectory(
        path.resolve(this.workspacePath, raw),
        label
      )
    }

    return {
      workspace: await this.captureStableDirectory(
        this.workspacePath,
        'Git worktree'
      ),
      gitDirectory: await readDirectory('--git-dir', 'Git worktree metadata'),
      commonDirectory: await readDirectory(
        '--git-common-dir',
        'Git repository metadata'
      )
    }
  }

  private async captureCommitRefState(
    options: GitOperationOptions
  ): Promise<{
    expectedHeadOid: string | null
    symbolicRef: string
  }> {
    const symbolicRef =
      (await this.optionalGitOutput(
        ['symbolic-ref', '--quiet', 'HEAD'],
        options
      )) ?? null
    const expectedHeadOid =
      (await this.optionalGitOutput(
        ['rev-parse', '--verify', 'HEAD'],
        options
      )) ?? null

    if (
      expectedHeadOid !== null &&
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expectedHeadOid)
    ) {
      throw new GitServiceError(
        'COMMAND_FAILED',
        'Git returned an invalid HEAD identity'
      )
    }
    if (symbolicRef === null) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'Ground commits require a checked-out local branch; detached HEAD commits are refused'
      )
    }
    if (!symbolicRef.startsWith('refs/heads/')) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'HEAD points outside the local branch namespace'
      )
    }
    const branch = symbolicRef.slice('refs/heads/'.length)
    validateBranchName(branch)
    if (`refs/heads/${branch}` !== symbolicRef) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'HEAD points to an unsafe local branch ref'
      )
    }

    return Object.freeze({ expectedHeadOid, symbolicRef })
  }

  private async captureCommitAuthority(
    details: {
      message: string
      authorName: string
      authorEmail: string
    },
    options: GitOperationOptions
  ): Promise<GitCommitAuthority> {
    const firstDirectories = await this.captureCommitDirectories(options)
    const firstRef = await this.captureCommitRefState(options)
    const secondDirectories = await this.captureCommitDirectories(options)
    const secondRef = await this.captureCommitRefState(options)
    if (
      !sameStableDirectoryBinding(
        firstDirectories.workspace,
        secondDirectories.workspace
      ) ||
      !sameStableDirectoryBinding(
        firstDirectories.gitDirectory,
        secondDirectories.gitDirectory
      ) ||
      !sameStableDirectoryBinding(
        firstDirectories.commonDirectory,
        secondDirectories.commonDirectory
      ) ||
      firstRef.expectedHeadOid !== secondRef.expectedHeadOid ||
      firstRef.symbolicRef !== secondRef.symbolicRef
    ) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'The Git repository or checked-out ref changed while Ground was binding the commit'
      )
    }
    return Object.freeze({
      workspace: secondDirectories.workspace,
      gitDirectory: secondDirectories.gitDirectory,
      commonDirectory: secondDirectories.commonDirectory,
      expectedHeadOid: secondRef.expectedHeadOid,
      symbolicRef: secondRef.symbolicRef,
      message: details.message,
      authorName: details.authorName,
      authorEmail: details.authorEmail
    })
  }

  private async assertCommitAuthorityStillCurrent(
    expected: Readonly<GitCommitAuthority>,
    options: GitOperationOptions
  ): Promise<void> {
    const current = await this.captureCommitAuthority(
      {
        message: expected.message,
        authorName: expected.authorName,
        authorEmail: expected.authorEmail
      },
      options
    )
    if (
      !sameStableDirectoryBinding(expected.workspace, current.workspace) ||
      !sameStableDirectoryBinding(
        expected.gitDirectory,
        current.gitDirectory
      ) ||
      !sameStableDirectoryBinding(
        expected.commonDirectory,
        current.commonDirectory
      ) ||
      expected.expectedHeadOid !== current.expectedHeadOid ||
      expected.symbolicRef !== current.symbolicRef
    ) {
      throw new GitServiceError(
        'UNSAFE_CONFIGURATION',
        'The Git repository or checked-out ref changed after commit approval'
      )
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

  async prepareCommit(options: GitCommitOptions): Promise<PreparedGitCommit> {
    await this.assertRootStillPinned()
    const message = validateCommitMessage(options.message)
    const authorName = validateAuthorName(options.authorName)
    const authorEmail = validateAuthorEmail(options.authorEmail)
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
    const authority = await this.captureCommitAuthority(
      { message, authorName, authorEmail },
      options
    )
    const branch = escapeUnsafeDisplayCharacters(
      authority.symbolicRef.slice('refs/heads/'.length)
    )
    const repositoryIdentitySha256 = stableDirectoryFingerprint(
      'repository',
      [authority.commonDirectory]
    )
    const worktreeIdentitySha256 = stableDirectoryFingerprint('worktree', [
      authority.workspace,
      authority.gitDirectory
    ])
    const stagedPaths = Object.freeze([...status.staged])
    const preview = [
      'Bound checkout and repository:',
      `Ref state: ${
        authority.expectedHeadOid
          ? 'symbolic local branch'
          : 'unborn symbolic local branch'
      }`,
      `Exact approved ref: ${reviewedCommitValue(authority.symbolicRef)}`,
      `Expected parent: ${authority.expectedHeadOid ?? '(initial commit)'}`,
      `Repository identity SHA-256: ${repositoryIdentitySha256}`,
      `Worktree identity SHA-256: ${worktreeIdentitySha256}`,
      `Exact staged tree: ${treeOid}`,
      '',
      `Author name: ${reviewedCommitValue(authorName)}`,
      `Author email: ${reviewedCommitValue(authorEmail)}`,
      '',
      'Commit message:',
      reviewedCommitValue(message),
      '',
      'Staged paths:',
      ...stagedPaths.map(
        (filePath, index) =>
          `${index + 1}. ${reviewedCommitValue(filePath)}`
      )
    ].join('\n')
    const preparedWithoutAction = Object.freeze({
      version: 1 as const,
      treeOid,
      expectedHeadOid: authority.expectedHeadOid,
      symbolicRef: authority.symbolicRef,
      branch,
      detached: false as const,
      repositoryIdentitySha256,
      worktreeIdentitySha256,
      stagedPaths,
      message,
      authorName,
      authorEmail,
      preview,
      previewSha256: sha256(preview)
    }) satisfies Omit<PreparedGitCommit, 'actionSha256'>
    const prepared = Object.freeze({
      ...preparedWithoutAction,
      actionSha256: preparedCommitFingerprint(preparedWithoutAction)
    }) satisfies PreparedGitCommit
    this.preparedCommits.set(prepared, authority)
    return prepared
  }

  async executePreparedCommit(
    prepared: PreparedGitCommit,
    options: GitCommitOptions
  ): Promise<GitLogEntry> {
    const authority = prepared
      ? this.preparedCommits.get(prepared)
      : undefined
    if (!prepared || !authority) {
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

    const {
      actionSha256: _actionSha256,
      ...preparedWithoutAction
    } = prepared
    const expectedRepositoryIdentitySha256 = stableDirectoryFingerprint(
      'repository',
      [authority.commonDirectory]
    )
    const expectedWorktreeIdentitySha256 = stableDirectoryFingerprint(
      'worktree',
      [authority.workspace, authority.gitDirectory]
    )
    if (
      !Object.isFrozen(prepared) ||
      !Object.isFrozen(prepared.stagedPaths) ||
      prepared.version !== 1 ||
      sha256(prepared.preview) !== prepared.previewSha256 ||
      preparedCommitFingerprint(preparedWithoutAction) !==
        prepared.actionSha256 ||
      prepared.expectedHeadOid !== authority.expectedHeadOid ||
      prepared.symbolicRef !== authority.symbolicRef ||
      prepared.detached !== false ||
      prepared.branch !==
        escapeUnsafeDisplayCharacters(
          authority.symbolicRef.slice('refs/heads/'.length)
        ) ||
      prepared.repositoryIdentitySha256 !==
        expectedRepositoryIdentitySha256 ||
      prepared.worktreeIdentitySha256 !== expectedWorktreeIdentitySha256 ||
      prepared.message !== authority.message ||
      prepared.authorName !== authority.authorName ||
      prepared.authorEmail !== authority.authorEmail ||
      message !== authority.message ||
      authorName !== authority.authorName ||
      authorEmail !== authority.authorEmail
    ) {
      throw new GitServiceError(
        'INVALID_ARGUMENT',
        'Prepared Git commit integrity validation failed'
      )
    }

    // Rebind the repository, worktree, exact checked-out local branch, and
    // expected parent immediately before creating the approved object.
    await this.assertCommitAuthorityStillCurrent(authority, options)

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

    // Revalidate again after object creation and immediately before the only
    // ref mutation. For a symbolic checkout, update the exact approved local
    // branch ref rather than the moving HEAD alias. A checkout race therefore
    // cannot put the approved commit on a different same-OID branch.
    await this.assertCommitAuthorityStillCurrent(authority, options)
    const expected =
      prepared.expectedHeadOid ?? '0'.repeat(commitOid.length)
    const approvedRef = prepared.symbolicRef
    const reflogSubject = escapeUnsafeDisplayCharacters(
      message.split(/\r?\n/u, 1)[0] ?? ''
    ).slice(0, 200)
    await this.runGit(
      [
        'update-ref',
        // Never dereference the exact local branch target.
        '--no-deref',
        '-m',
        `commit: ${reflogSubject}`,
        approvedRef,
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
