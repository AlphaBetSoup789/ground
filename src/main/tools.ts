import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createTwoFilesPatch } from 'diff'
import { z } from 'zod'
import type { ToolDefinition } from './providers/openai'
import {
  createProcessLaunchEnvelope,
  executableCandidates,
  executableSearchPath,
  isFrozenProcessLaunchEnvelope,
  processLaunchArguments,
  revalidateProcessLaunchEnvelope,
  safeChildEnvironment,
  type ProcessLaunchEnvelope
} from './process-launch'
import { terminateProcessTree } from './process-tree'

const MAX_FILE_READ_BYTES = 1_000_000
const MAX_SEARCH_FILES = 2_500
const MAX_SEARCH_BYTES = 16_000_000
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_OUTPUT = 50_000
const MAX_WRITE_CHARACTERS = 2_000_000
const MAX_WRITE_BYTES = 2_000_000
const WRITE_PREVIEW_LIMIT = 30_000
const COMMAND_PREVIEW_LIMIT = 30_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const PROCESS_KILL_GRACE_MS = 500
const MAX_WORKSPACE_INSTRUCTION_BYTES = 64_000
const MAX_COMBINED_WORKSPACE_INSTRUCTION_CHARACTERS = 96_000
const WORKSPACE_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md'
] as const

const SENSITIVE_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.terraform',
  '.docker',
  '.direnv',
  '.secrets',
  'secrets',
  '.credentials',
  'credentials',
  '.tokens',
  'tokens'
])

const SENSITIVE_FILENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.my.cnf',
  '.terraformrc',
  '.vault-token',
  '.envrc',
  'terraform.rc',
  'kubeconfig',
  'auth.json',
  'config.json.gpg'
])

const ENV_EXAMPLE_MARKERS = new Set(['example', 'sample', 'template', 'dist'])
const SENSITIVE_FILE_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.kdbx',
  '.tfstate',
  '.tfstate.backup',
  '.tfvars',
  '.tfvars.json'
]

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache'
])

const listFilesSchema = z.object({
  path: z.string().max(8_192).optional(),
  depth: z.number().int().min(1).max(8).optional()
})
const readFileSchema = z.object({
  path: z.string().min(1).max(8_192),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional()
})
const searchFilesSchema = z.object({
  query: z.string().min(1).max(2_000),
  path: z.string().max(8_192).optional(),
  glob: z.string().max(500).optional()
})
const writeFileSchema = z.object({
  path: z.string().min(1).max(8_192),
  content: z.string().max(MAX_WRITE_CHARACTERS)
})
const editFileSchema = z.object({
  path: z.string().min(1).max(8_192),
  old_text: z.string().min(1).max(MAX_WRITE_CHARACTERS),
  new_text: z.string().max(MAX_WRITE_CHARACTERS),
  replace_all: z.boolean().optional()
})
const runCommandSchema = z.object({
  command: z.string().min(1).max(2_000),
  args: z.array(z.string().max(8_192)).max(64).optional(),
  cwd: z.string().max(8_192).optional(),
  timeout_ms: z.number().int().min(250).max(300_000).optional()
})

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories inside the active workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory. Defaults to root.' },
          depth: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum depth.' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the active workspace, with optional line bounds.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search for literal text inside non-sensitive files in the active workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string', description: 'Workspace-relative search root.' },
          glob: {
            type: 'string',
            description: 'Optional file glob, for example *.ts or src/**/*.tsx.'
          }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or replace a UTF-8 file in the active workspace. The user must approve the exact diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'Complete new file contents.' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace exact text in an existing UTF-8 file. By default old_text must occur exactly once; set replace_all only when every occurrence should change. The user must approve the exact diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          old_text: {
            type: 'string',
            description: 'Exact text currently in the file, including whitespace.'
          },
          new_text: { type: 'string', description: 'Replacement text.' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every exact occurrence. Defaults to false.'
          }
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run one executable with an argument array in the workspace. Shell syntax is not supported. The user must approve it.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Executable name or absolute path.' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Arguments passed directly to the executable.'
          },
          cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
          timeout_ms: {
            type: 'integer',
            minimum: 250,
            maximum: 300000,
            description: 'Optional timeout in milliseconds. Defaults to 120000.'
          }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  }
]

export function toolRequiresApproval(name: string): boolean {
  return name === 'write_file' || name === 'edit_file' || name === 'run_command'
}

export interface SensitivePathClassification {
  sensitive: boolean
  reason?: string
}

export interface PreparedWriteAction {
  readonly version: 1
  readonly workspaceRoot: string
  readonly relativePath: string
  readonly canonicalTarget: string
  readonly existed: boolean
  readonly baseSha256: string
  readonly newContentSha256: string
  readonly newContent: string
  readonly fileMode: number
  readonly preview: string
  readonly previewStatus: 'complete' | 'truncated'
}

export interface PreparedCommandAction {
  readonly version: 1
  readonly workspaceRoot: string
  readonly cwd: string
  readonly relativeCwd: string
  readonly launch: ProcessLaunchEnvelope
  readonly executable: string
  readonly executableSha256: string
  readonly executableSize: number
  readonly executableModifiedMs: number
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly preview: string
  readonly previewStatus: 'complete' | 'truncated'
}

interface WritableTargetSnapshot {
  root: string
  relativePath: string
  canonicalTarget: string
  existed: boolean
  contents: Buffer
  fileMode: number
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function toWorkspaceRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '')
  return normalized || '.'
}

export function classifySensitiveWorkspacePath(
  workspaceRelativePath: string
): SensitivePathClassification {
  const normalized = toWorkspaceRelative(workspaceRelativePath)
  const segments = normalized
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .map((segment) => segment.toLowerCase())
  const basename = segments.at(-1) ?? ''

  if (basename === '.env' || basename.startsWith('.env.')) {
    const suffixParts = basename.split('.').slice(2)
    if (!suffixParts.some((part) => ENV_EXAMPLE_MARKERS.has(part))) {
      return { sensitive: true, reason: 'environment file' }
    }
  }

  const sensitiveDirectory = segments.find((segment) =>
    SENSITIVE_DIRECTORIES.has(segment)
  )
  if (sensitiveDirectory) {
    return { sensitive: true, reason: `sensitive directory ${sensitiveDirectory}` }
  }
  if (
    segments.some(
      (segment, index) =>
        segment === '.config' &&
        ['gcloud', 'gh'].includes(segments[index + 1] ?? '')
    )
  ) {
    return { sensitive: true, reason: 'cloud or account configuration' }
  }
  if (SENSITIVE_FILENAMES.has(basename)) {
    return { sensitive: true, reason: `sensitive file ${basename}` }
  }
  if (SENSITIVE_FILE_EXTENSIONS.some((extension) => basename.endsWith(extension))) {
    return { sensitive: true, reason: 'credential, key, or Terraform state file' }
  }
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(basename)) {
    return { sensitive: true, reason: 'SSH identity file' }
  }
  if (
    /^(?:credentials?|tokens?|secrets?)(?:\.(?:json|ya?ml|toml|ini|conf|config|txt|xml|csv|db))?$/.test(
      basename
    ) ||
    /^(?:api[_-]?key|client[_-]?secret|service[_-]?account(?:[_-]?key)?|private[_-]?key)(?:[._-].*)?$/.test(
      basename
    )
  ) {
    return { sensitive: true, reason: 'credential or token file' }
  }
  return { sensitive: false }
}

function assertNonSensitivePath(workspaceRelativePath: string): void {
  if (classifySensitiveWorkspacePath(workspaceRelativePath).sensitive) {
    throw new Error(
      `Sensitive workspace path is unavailable to model tools: ${toWorkspaceRelative(workspaceRelativePath)}`
    )
  }
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Run stopped', 'AbortError')
}

async function canonicalWorkspace(workspacePath: string): Promise<string> {
  const root = await realpath(workspacePath)
  const rootStats = await stat(root)
  if (!rootStats.isDirectory()) throw new Error('The workspace is not a directory')
  return root
}

async function existingWorkspacePath(workspacePath: string, requested = '.'): Promise<string> {
  if (path.isAbsolute(requested)) throw new Error('Use a workspace-relative path')
  const root = await canonicalWorkspace(workspacePath)
  const lexicalTarget = path.resolve(root, requested)
  if (!isInside(root, lexicalTarget)) throw new Error('Path escapes the active workspace')
  let target: string
  try {
    target = await realpath(lexicalTarget)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Workspace path does not exist: ${toWorkspaceRelative(requested)}`)
    }
    throw new Error(`Could not resolve workspace path: ${toWorkspaceRelative(requested)}`, {
      cause: error
    })
  }
  if (!isInside(root, target)) throw new Error('Path escapes the active workspace')
  return target
}

async function readRegularFile(
  target: string,
  maximumBytes: number,
  allowTruncatedPrefix = false
): Promise<{
  contents: Buffer
  mode: number
  truncated?: boolean
}> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(target, constants.O_RDONLY | noFollow)
  try {
    const details = await handle.stat()
    if (!details.isFile()) throw new Error('Requested path is not a file')
    if (details.size > maximumBytes && !allowTruncatedPrefix) {
      throw new Error(
        `File is larger than the ${(maximumBytes / 1_000_000).toLocaleString()} MB read limit`
      )
    }
    const bounded = Buffer.allocUnsafe(maximumBytes + 1)
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
    const truncated = details.size > maximumBytes || offset > maximumBytes
    if (truncated && !allowTruncatedPrefix) {
      throw new Error(
        `File is larger than the ${(maximumBytes / 1_000_000).toLocaleString()} MB read limit`
      )
    }
    return {
      contents: Buffer.from(
        bounded.subarray(0, Math.min(offset, maximumBytes))
      ),
      mode: details.mode & 0o777,
      ...(allowTruncatedPrefix && truncated
        ? { truncated: true }
        : {})
    }
  } finally {
    await handle.close()
  }
}

export async function loadWorkspaceInstructions(
  workspacePath: string
): Promise<string> {
  const root = await canonicalWorkspace(workspacePath)
  const sections: string[] = []
  let remaining = MAX_COMBINED_WORKSPACE_INSTRUCTION_CHARACTERS

  for (const relativePath of WORKSPACE_INSTRUCTION_FILES) {
    if (remaining <= 0) break
    assertNonSensitivePath(relativePath)
    const lexicalTarget = path.resolve(root, relativePath)
    if (!isInside(root, lexicalTarget)) continue

    try {
      const lexicalDetails = await lstat(lexicalTarget)
      if (lexicalDetails.isSymbolicLink() || !lexicalDetails.isFile()) continue
      const target = await realpath(lexicalTarget)
      if (!isInside(root, target)) continue
      const file = await readRegularFile(
        target,
        MAX_WORKSPACE_INSTRUCTION_BYTES,
        true
      )
      if (file.contents.includes(0)) continue
      const prefix = file.contents.toString('utf8').trim()
      const content = file.truncated
        ? `${prefix}\n[Ground truncated this instruction file.]`
        : prefix
      if (!content) continue
      const marker = `--- WORKSPACE INSTRUCTIONS: ${relativePath} ---`
      const available = Math.max(0, remaining - marker.length - 2)
      const bounded =
        content.length <= available
          ? content
          : `${content.slice(0, Math.max(0, available - 44))}\n[Ground truncated this instruction file.]`
      sections.push(`${marker}\n${bounded}`)
      remaining -= marker.length + bounded.length + 2
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Workspace guidance is optional. Permission or race failures must not
        // turn an otherwise valid user request into a failed run.
      }
    }
  }

  return sections.join('\n\n')
}

async function writableTargetSnapshot(
  workspacePath: string,
  requested: string
): Promise<WritableTargetSnapshot> {
  if (path.isAbsolute(requested)) throw new Error('Use a workspace-relative path')
  assertNonSensitivePath(requested)
  const root = await canonicalWorkspace(workspacePath)
  const lexicalTarget = path.resolve(root, requested)
  if (!isInside(root, lexicalTarget)) throw new Error('Path escapes the active workspace')

  let lexicalDetails
  try {
    lexicalDetails = await lstat(lexicalTarget)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not inspect write target: ${toWorkspaceRelative(requested)}`, {
        cause: error
      })
    }
  }

  if (lexicalDetails) {
    if (lexicalDetails.isSymbolicLink()) {
      throw new Error(
        'Refusing to write through a symbolic link because the target may leave the workspace'
      )
    }
    const canonicalTarget = await realpath(lexicalTarget)
    if (!isInside(root, canonicalTarget)) {
      throw new Error('Path traverses outside the workspace')
    }
    const relativePath = toWorkspaceRelative(path.relative(root, canonicalTarget))
    assertNonSensitivePath(relativePath)
    const existing = await readRegularFile(canonicalTarget, 2_000_000)
    return {
      root,
      relativePath,
      canonicalTarget,
      existed: true,
      contents: existing.contents,
      fileMode: existing.mode
    }
  }

  const unresolved: string[] = []
  let ancestor = lexicalTarget
  while (true) {
    try {
      const ancestorDetails = await lstat(ancestor)
      if (ancestorDetails.isSymbolicLink()) {
        throw new Error('Write target changed: parent became a symbolic link')
      }
      if (!ancestorDetails.isDirectory()) {
        throw new Error('The write target parent is not a directory')
      }
      const canonicalAncestor = await realpath(ancestor)
      if (!isInside(root, canonicalAncestor)) {
        throw new Error('Path traverses outside the workspace')
      }
      const canonicalTarget = path.resolve(canonicalAncestor, ...unresolved)
      if (!isInside(root, canonicalTarget) || canonicalTarget === root) {
        throw new Error('Path escapes the active workspace')
      }
      return {
        root,
        relativePath: toWorkspaceRelative(path.relative(root, canonicalTarget)),
        canonicalTarget,
        existed: false,
        contents: Buffer.alloc(0),
        fileMode: 0o600
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      unresolved.unshift(path.basename(ancestor))
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw new Error('Could not resolve the destination path')
      ancestor = parent
    }
  }
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text || '{}')
  } catch {
    throw new Error('The model returned invalid tool arguments')
  }
}

export function normalizeToolInput(name: string, argumentsText: string): Record<string, unknown> {
  const parsed = parseArguments(argumentsText)
  switch (name) {
    case 'list_files':
      return listFilesSchema.parse(parsed)
    case 'read_file':
      return readFileSchema.parse(parsed)
    case 'search_files':
      return searchFilesSchema.parse(parsed)
    case 'write_file':
      return writeFileSchema.parse(parsed)
    case 'edit_file':
      return editFileSchema.parse(parsed)
    case 'run_command':
      return runCommandSchema.parse(parsed)
    default:
      throw new Error(`Unsupported tool: ${name}`)
  }
}

function preparedWriteActionFromSnapshot(
  target: WritableTargetSnapshot,
  newContent: string
): PreparedWriteAction {
  if (Buffer.byteLength(newContent, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(
      `File content exceeds the ${(MAX_WRITE_BYTES / 1_000_000).toLocaleString()} MB write limit`
    )
  }
  const previous = target.contents.toString('utf8')
  const fullPreview = createTwoFilesPatch(
    target.existed ? `a/${target.relativePath}` : '/dev/null',
    `b/${target.relativePath}`,
    previous,
    newContent,
    '',
    '',
    { context: 3 }
  )
  const previewStatus =
    fullPreview.length <= WRITE_PREVIEW_LIMIT ? 'complete' : 'truncated'
  const preview =
    previewStatus === 'complete'
      ? fullPreview
      : `${fullPreview.slice(0, WRITE_PREVIEW_LIMIT)}\n…preview truncated; approval must not use this incomplete envelope`

  return Object.freeze({
    version: 1 as const,
    workspaceRoot: target.root,
    relativePath: target.relativePath,
    canonicalTarget: target.canonicalTarget,
    existed: target.existed,
    baseSha256: sha256(target.contents),
    newContentSha256: sha256(newContent),
    newContent,
    fileMode: target.fileMode,
    preview,
    previewStatus
  })
}

export async function prepareWriteAction(
  input: Record<string, unknown>,
  workspacePath: string
): Promise<PreparedWriteAction> {
  const parsed = writeFileSchema.parse(input)
  const target = await writableTargetSnapshot(workspacePath, parsed.path)
  return preparedWriteActionFromSnapshot(target, parsed.content)
}

export async function prepareEditAction(
  input: Record<string, unknown>,
  workspacePath: string
): Promise<PreparedWriteAction> {
  const parsed = editFileSchema.parse(input)
  const target = await writableTargetSnapshot(workspacePath, parsed.path)
  if (!target.existed) {
    throw new Error(`Cannot edit a file that does not exist: ${target.relativePath}`)
  }
  if (
    target.contents.includes(0) ||
    !Buffer.from(target.contents.toString('utf8'), 'utf8').equals(target.contents)
  ) {
    throw new Error(`Cannot edit a non-UTF-8 text file: ${target.relativePath}`)
  }

  const previous = target.contents.toString('utf8')
  let occurrences = 0
  let cursor = 0
  while (cursor <= previous.length - parsed.old_text.length) {
    const match = previous.indexOf(parsed.old_text, cursor)
    if (match === -1) break
    occurrences += 1
    cursor = match + parsed.old_text.length
  }
  if (occurrences === 0) {
    throw new Error(`Exact old_text was not found in ${target.relativePath}`)
  }
  if (occurrences > 1 && !parsed.replace_all) {
    throw new Error(
      `Exact old_text occurs ${occurrences} times in ${target.relativePath}; include more context or set replace_all`
    )
  }

  const replacementCount = parsed.replace_all ? occurrences : 1
  const nextLength =
    previous.length +
    replacementCount * (parsed.new_text.length - parsed.old_text.length)
  if (nextLength > MAX_WRITE_CHARACTERS) {
    throw new Error(
      `Edited file would exceed the ${MAX_WRITE_CHARACTERS.toLocaleString()} character write limit`
    )
  }
  const firstMatch = previous.indexOf(parsed.old_text)
  const next = parsed.replace_all
    ? previous.replaceAll(parsed.old_text, parsed.new_text)
    : `${previous.slice(0, firstMatch)}${parsed.new_text}${previous.slice(
        firstMatch + parsed.old_text.length
      )}`
  if (next === previous) {
    throw new Error(`The requested edit would not change ${target.relativePath}`)
  }
  return preparedWriteActionFromSnapshot(target, next)
}

async function revalidatePreparedWrite(
  action: PreparedWriteAction
): Promise<WritableTargetSnapshot> {
  const current = await writableTargetSnapshot(action.workspaceRoot, action.relativePath)
  if (
    current.root !== action.workspaceRoot ||
    current.canonicalTarget !== action.canonicalTarget
  ) {
    throw new Error(`Write target changed since approval: ${action.relativePath}`)
  }
  if (current.existed !== action.existed || sha256(current.contents) !== action.baseSha256) {
    throw new Error(`File changed since approval: ${action.relativePath}`)
  }
  return current
}

export async function executePreparedWriteAction(
  action: PreparedWriteAction,
  signal?: AbortSignal
): Promise<void> {
  if (!Object.isFrozen(action) || action.version !== 1) {
    throw new Error('Prepared write action must be an immutable version 1 envelope')
  }
  if (
    sha256(action.newContent) !== action.newContentSha256 ||
    action.previewStatus !== 'complete' ||
    !Number.isInteger(action.fileMode) ||
    action.fileMode < 0 ||
    action.fileMode > 0o777 ||
    !path.isAbsolute(action.workspaceRoot) ||
    !path.isAbsolute(action.canonicalTarget) ||
    !isInside(action.workspaceRoot, action.canonicalTarget)
  ) {
    throw new Error('Prepared write action failed integrity validation')
  }

  throwIfAborted(signal)
  await revalidatePreparedWrite(action)
  await mkdir(path.dirname(action.canonicalTarget), { recursive: true })
  await revalidatePreparedWrite(action)
  throwIfAborted(signal)

  const temporary = path.join(
    path.dirname(action.canonicalTarget),
    `.ground-write-${path.basename(action.canonicalTarget)}-${randomUUID()}.tmp`
  )
  let temporaryCreated = false
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      action.fileMode
    )
    temporaryCreated = true
    try {
      await handle.writeFile(action.newContent, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    throwIfAborted(signal)
    await revalidatePreparedWrite(action)
    await rename(temporary, action.canonicalTarget)
    temporaryCreated = false

    try {
      const directory = await open(path.dirname(action.canonicalTarget), constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch {
      // Some platforms do not permit fsync on directories. The file replacement is still atomic.
    }
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => undefined)
  }
}

function commandPathEntries(): string[] {
  return executableSearchPath()
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry))
}

async function resolveCommandExecutable(
  command: string,
  workspaceRoot: string,
  cwd: string
): Promise<string> {
  if (command.includes('\0')) throw new Error('Command contains an invalid null byte')
  const hasPathSeparator = command.includes('/') || command.includes('\\')
  const candidates: string[] = []
  if (path.isAbsolute(command)) {
    candidates.push(...executableCandidates(command))
  } else if (hasPathSeparator) {
    for (const commandCandidate of executableCandidates(command)) {
      const candidate = path.resolve(cwd, commandCandidate)
      if (!isInside(workspaceRoot, candidate)) {
        throw new Error('Relative command paths must stay inside the active workspace')
      }
      candidates.push(candidate)
    }
  } else {
    for (const directory of commandPathEntries()) {
      for (const candidate of executableCandidates(command)) {
        candidates.push(path.join(directory, candidate))
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate)
      const details = await stat(executable)
      if (!details.isFile()) continue
      if (process.platform !== 'win32' && (details.mode & 0o111) === 0) continue
      return executable
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') continue
      throw error
    }
  }
  throw new Error(`Executable not found: ${command}`)
}

export async function prepareCommandAction(
  input: Record<string, unknown>,
  workspacePath: string
): Promise<PreparedCommandAction> {
  const parsed = runCommandSchema.parse(input)
  if ((parsed.args ?? []).some((argument) => argument.includes('\0'))) {
    throw new Error('Command arguments contain an invalid null byte')
  }
  const workspaceRoot = await canonicalWorkspace(workspacePath)
  const cwd = await existingWorkspacePath(workspaceRoot, parsed.cwd || '.')
  const cwdDetails = await stat(cwd)
  if (!cwdDetails.isDirectory()) throw new Error('Command working directory is not a directory')
  const entry = await resolveCommandExecutable(parsed.command, workspaceRoot, cwd)
  const launch = await createProcessLaunchEnvelope(entry)
  const executable = launch.executable.path
  const args = Object.freeze([...(parsed.args ?? [])])
  const spawnedArgs = processLaunchArguments(launch, args)
  const relativeCwd = toWorkspaceRelative(path.relative(workspaceRoot, cwd))
  const fullPreview = [
    ...(launch.kind === 'windows-node-shim'
      ? [
          `Requested command shim: ${launch.entry.path}`,
          `Shim SHA-256: ${launch.entry.sha256}`,
          `Bound package script: ${launch.script?.path}`,
          `Script SHA-256: ${launch.script?.sha256}`
        ]
      : []),
    `Executable: ${executable}`,
    spawnedArgs.length
      ? `Arguments:\n${spawnedArgs
          .map((argument, index) => `argv[${index}]: ${JSON.stringify(argument)}`)
          .join('\n')}`
      : 'Arguments: (none)',
    `Working directory: ${relativeCwd}`,
    `Timeout: ${parsed.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS}ms`,
    `Executable SHA-256: ${launch.executable.sha256}`,
    `Launch-envelope SHA-256: ${launch.fingerprint}`
  ].join('\n\n')
  const previewStatus =
    fullPreview.length <= COMMAND_PREVIEW_LIMIT ? 'complete' : 'truncated'
  const preview =
    previewStatus === 'complete'
      ? fullPreview
      : `${fullPreview.slice(0, COMMAND_PREVIEW_LIMIT)}\n…preview truncated; approval must not use this incomplete envelope`

  return Object.freeze({
    version: 1 as const,
    workspaceRoot,
    cwd,
    relativeCwd,
    launch,
    executable,
    executableSha256: launch.executable.sha256,
    executableSize: launch.executable.size,
    executableModifiedMs: launch.executable.modifiedMs,
    args,
    timeoutMs: parsed.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
    preview,
    previewStatus
  })
}

export async function executePreparedCommandAction(
  action: PreparedCommandAction,
  signal: AbortSignal
): Promise<string> {
  if (
    !Object.isFrozen(action) ||
    !Object.isFrozen(action.args) ||
    !isFrozenProcessLaunchEnvelope(action.launch) ||
    action.version !== 1 ||
    action.previewStatus !== 'complete' ||
    !path.isAbsolute(action.workspaceRoot) ||
    !path.isAbsolute(action.cwd) ||
    !path.isAbsolute(action.executable) ||
    action.executable !== action.launch.executable.path ||
    action.executableSha256 !== action.launch.executable.sha256 ||
    action.executableSize !== action.launch.executable.size ||
    action.executableModifiedMs !== action.launch.executable.modifiedMs ||
    !isInside(action.workspaceRoot, action.cwd)
  ) {
    throw new Error('Prepared command action failed integrity validation')
  }
  throwIfAborted(signal)
  const workspaceRoot = await canonicalWorkspace(action.workspaceRoot)
  const cwd = await realpath(action.cwd)
  if (
    workspaceRoot !== action.workspaceRoot ||
    cwd !== action.cwd ||
    !isInside(workspaceRoot, cwd)
  ) {
    throw new Error('Command workspace changed since approval')
  }
  await revalidateProcessLaunchEnvelope(action.launch)
  throwIfAborted(signal)
  return runProcess(
    action.launch,
    [...action.args],
    action.cwd,
    signal,
    action.timeoutMs
  )
}

export async function previewTool(
  name: string,
  input: Record<string, unknown>,
  workspacePath: string
): Promise<{ title: string; detail: string }> {
  if (name === 'write_file') {
    const action = await prepareWriteAction(input, workspacePath)
    if (action.previewStatus === 'truncated') {
      throw new Error(
        `Write diff is too large for complete approval preview: ${action.relativePath}`
      )
    }
    return {
      title: action.existed
        ? `Update ${action.relativePath}`
        : `Create ${action.relativePath}`,
      detail: action.preview
    }
  }
  if (name === 'edit_file') {
    const action = await prepareEditAction(input, workspacePath)
    if (action.previewStatus === 'truncated') {
      throw new Error(
        `Edit diff is too large for complete approval preview: ${action.relativePath}`
      )
    }
    return {
      title: `Edit ${action.relativePath}`,
      detail: action.preview
    }
  }
  if (name === 'run_command') {
    const action = await prepareCommandAction(input, workspacePath)
    if (action.previewStatus === 'truncated') {
      throw new Error('Command is too large for a complete approval preview')
    }
    return {
      title: `Run ${path.basename(action.launch.entry.path)}`,
      detail: action.preview
    }
  }
  return {
    title: name.replaceAll('_', ' '),
    detail: JSON.stringify(input, null, 2)
  }
}

async function listWorkspaceFiles(
  workspacePath: string,
  input: z.infer<typeof listFilesSchema>
): Promise<string> {
  const root = await canonicalWorkspace(workspacePath)
  assertNonSensitivePath(input.path || '.')
  const start = await existingWorkspacePath(workspacePath, input.path || '.')
  if (!isInside(root, start)) throw new Error('Path escapes the active workspace')
  assertNonSensitivePath(toWorkspaceRelative(path.relative(root, start)))
  const maximumDepth = input.depth ?? 4
  const results: string[] = []

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maximumDepth || results.length >= 500) return
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (results.length >= 500) return
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
      const absolute = path.join(directory, entry.name)
      const relative = toWorkspaceRelative(path.relative(root, absolute))
      if (classifySensitiveWorkspacePath(relative).sensitive) continue
      results.push(`${relative}${entry.isDirectory() ? '/' : ''}`)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(absolute, depth + 1)
    }
  }

  await walk(start, 1)
  return `${results.join('\n')}${results.length >= 500 ? '\n…output capped at 500 entries' : ''}`
}

async function readWorkspaceFile(
  workspacePath: string,
  input: z.infer<typeof readFileSchema>
): Promise<string> {
  assertNonSensitivePath(input.path)
  const root = await canonicalWorkspace(workspacePath)
  const target = await existingWorkspacePath(workspacePath, input.path)
  assertNonSensitivePath(toWorkspaceRelative(path.relative(root, target)))
  const file = await readRegularFile(target, MAX_FILE_READ_BYTES)
  if (file.contents.includes(0)) throw new Error('Requested path is not a UTF-8 text file')
  const contents = file.contents.toString('utf8')
  const lines = contents.split(/\r?\n/)
  const start = input.start_line ?? 1
  const end = Math.min(input.end_line ?? lines.length, start + 1_999, lines.length)
  return lines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(5)} │ ${line}`)
    .join('\n')
}

function compileSafeGlob(glob?: string): ((relativePath: string) => boolean) | undefined {
  if (!glob) return undefined
  const normalized = glob.replaceAll('\\', '/')
  let expression = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] as string
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        expression += '.*'
        index += 1
      } else {
        expression += '[^/]*'
      }
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&')
    }
  }
  expression += '$'
  const matcher = new RegExp(expression)
  const basenameOnly = !normalized.includes('/')
  return (relativePath) =>
    matcher.test(relativePath) ||
    (basenameOnly && matcher.test(path.posix.basename(relativePath)))
}

async function searchWorkspace(
  workspacePath: string,
  input: z.infer<typeof searchFilesSchema>,
  signal: AbortSignal
): Promise<string> {
  assertNonSensitivePath(input.path || '.')
  const root = await canonicalWorkspace(workspacePath)
  const searchRoot = await existingWorkspacePath(workspacePath, input.path || '.')
  assertNonSensitivePath(toWorkspaceRelative(path.relative(root, searchRoot)))
  const matchesGlob = compileSafeGlob(input.glob)
  const results: string[] = []
  let outputLength = 0
  let filesScanned = 0
  let entriesVisited = 0
  let bytesScanned = 0
  let truncated = false

  const inspectFile = async (candidate: string): Promise<void> => {
    if (
      results.length >= MAX_SEARCH_RESULTS ||
      outputLength >= MAX_SEARCH_OUTPUT ||
      filesScanned >= MAX_SEARCH_FILES ||
      bytesScanned >= MAX_SEARCH_BYTES
    ) {
      truncated = true
      return
    }
    filesScanned += 1
    throwIfAborted(signal)
    let canonical: string
    try {
      const lexical = await lstat(candidate)
      if (lexical.isSymbolicLink() || !lexical.isFile()) return
      canonical = await realpath(candidate)
    } catch {
      return
    }
    if (!isInside(root, canonical)) return
    const relative = toWorkspaceRelative(path.relative(root, canonical))
    if (
      classifySensitiveWorkspacePath(relative).sensitive ||
      (matchesGlob && !matchesGlob(relative))
    ) {
      return
    }

    let file: { contents: Buffer; mode: number }
    try {
      file = await readRegularFile(canonical, MAX_FILE_READ_BYTES)
    } catch {
      return
    }
    bytesScanned += file.contents.byteLength
    if (bytesScanned > MAX_SEARCH_BYTES) {
      truncated = true
      return
    }
    if (file.contents.includes(0)) return

    const lines = file.contents.toString('utf8').split(/\r?\n/)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      throwIfAborted(signal)
      const line = lines[lineIndex] as string
      const column = line.indexOf(input.query)
      if (column === -1) continue
      const displayLine =
        line.length <= 2_000 ? line : `${line.slice(0, 2_000)}…line truncated`
      const result = `${relative}:${lineIndex + 1}:${column + 1}:${displayLine}`
      if (
        results.length >= MAX_SEARCH_RESULTS ||
        outputLength + result.length + 1 > MAX_SEARCH_OUTPUT
      ) {
        truncated = true
        return
      }
      results.push(result)
      outputLength += result.length + 1
    }
  }

  const walk = async (directory: string): Promise<void> => {
    if (truncated) return
    throwIfAborted(signal)
    let directoryHandle
    try {
      directoryHandle = await opendir(directory)
    } catch {
      return
    }
    for await (const entry of directoryHandle) {
      if (truncated) return
      entriesVisited += 1
      if (entriesVisited > MAX_SEARCH_FILES * 4) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      const candidate = path.join(directory, entry.name)
      const relative = toWorkspaceRelative(path.relative(root, candidate))
      if (classifySensitiveWorkspacePath(relative).sensitive) continue
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(candidate)
      } else if (entry.isFile()) {
        await inspectFile(candidate)
      }
    }
  }

  const searchRootDetails = await stat(searchRoot)
  if (searchRootDetails.isFile()) await inspectFile(searchRoot)
  else if (searchRootDetails.isDirectory()) await walk(searchRoot)
  else throw new Error('Search root must be a file or directory')

  const body = results.length ? results.join('\n') : 'No matches found.'
  return truncated ? `${body}\n…search stopped at the safety limit` : body
}

async function runProcess(
  launch: ProcessLaunchEnvelope,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<string> {
  const child = spawn(launch.executable.path, processLaunchArguments(launch, args), {
    cwd,
    env: safeChildEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let terminationReason: 'abort' | 'timeout' | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let killTimer: NodeJS.Timeout | undefined
  const cap = (current: string, addition: string): string =>
    `${current}${addition}`.slice(-50_000)
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = cap(stdout, stdoutDecoder.write(chunk))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = cap(stderr, stderrDecoder.write(chunk))
  })

  const sendSignal = (terminationSignal: NodeJS.Signals): void => {
    terminateProcessTree(child, terminationSignal)
  }

  const beginTermination = (reason: 'abort' | 'timeout'): void => {
    if (terminationReason) return
    terminationReason = reason
    sendSignal('SIGTERM')
    killTimer = setTimeout(() => sendSignal('SIGKILL'), PROCESS_KILL_GRACE_MS)
    killTimer.unref()
  }
  const stop = (): void => beginTermination('abort')
  signal.addEventListener('abort', stop, { once: true })
  timeoutTimer = setTimeout(() => beginTermination('timeout'), timeoutMs)
  timeoutTimer.unref()
  if (signal.aborted) beginTermination('abort')

  const result = await new Promise<string>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      signal.removeEventListener('abort', stop)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    child.once('error', fail)
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      stdout = cap(stdout, stdoutDecoder.end())
      stderr = cap(stderr, stderrDecoder.end())
      if (terminationReason === 'abort') {
        reject(new DOMException('Run stopped', 'AbortError'))
      } else if (terminationReason === 'timeout') {
        reject(new Error(`Command timed out after ${timeoutMs}ms`))
      } else if (code === 0) {
        resolve(stdout.trim() || 'Command completed.')
      } else {
        reject(new Error(`Command exited with code ${code ?? 'unknown'}${stderr ? ` — ${stderr}` : ''}`))
      }
    })
  })
  return result
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  workspacePath: string,
  signal: AbortSignal
): Promise<string> {
  switch (name) {
    case 'list_files':
      return listWorkspaceFiles(workspacePath, listFilesSchema.parse(input))
    case 'read_file':
      return readWorkspaceFile(workspacePath, readFileSchema.parse(input))
    case 'search_files':
      return searchWorkspace(workspacePath, searchFilesSchema.parse(input), signal)
    case 'write_file': {
      const parsed = writeFileSchema.parse(input)
      const action = await prepareWriteAction(parsed, workspacePath)
      await executePreparedWriteAction(action, signal)
      return `Wrote ${parsed.content.length.toLocaleString()} characters to ${action.relativePath}.`
    }
    case 'edit_file': {
      const action = await prepareEditAction(input, workspacePath)
      await executePreparedWriteAction(action, signal)
      return `Edited ${action.relativePath}.`
    }
    case 'run_command': {
      const action = await prepareCommandAction(input, workspacePath)
      return executePreparedCommandAction(action, signal)
    }
    default:
      throw new Error(`Unsupported tool: ${name}`)
  }
}
