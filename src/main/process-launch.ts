import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_LAUNCH_FILE_BYTES = 512_000_000
const MAX_WINDOWS_SHIM_BYTES = 512_000
const SAFE_WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.EXE', '.COM', '.CMD', '.BAT'])
const DEFAULT_WINDOWS_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'] as const

export interface LaunchFileIdentity {
  readonly path: string
  readonly sha256: string
  readonly size: number
  readonly modifiedMs: number
  readonly changedMs: number
  readonly device: number
  readonly inode: number
}

export interface ProcessLaunchEnvelope {
  readonly version: 1
  readonly kind: 'direct' | 'windows-node-shim'
  readonly entry: LaunchFileIdentity
  readonly executable: LaunchFileIdentity
  readonly argumentPrefix: readonly string[]
  readonly shim?: LaunchFileIdentity
  readonly script?: LaunchFileIdentity
  readonly fingerprint: string
}

export interface CreateProcessLaunchOptions {
  platform?: NodeJS.Platform
  pathValue?: string
  pathEntries?: readonly string[]
}

function safeWindowsExtension(value: string): string | undefined {
  const normalized = value.trim().toUpperCase()
  if (!/^\.[A-Z0-9]{1,8}$/.test(normalized)) return undefined
  return SAFE_WINDOWS_EXECUTABLE_EXTENSIONS.has(normalized) ? normalized : undefined
}

export function safeWindowsPathExt(value: string | undefined): readonly string[] {
  const extensions = (value ?? DEFAULT_WINDOWS_PATHEXT.join(';'))
    .split(';')
    .map(safeWindowsExtension)
    .filter((extension): extension is string => Boolean(extension))
  return Object.freeze([...new Set(extensions.length ? extensions : DEFAULT_WINDOWS_PATHEXT)])
}

export function windowsCommandCandidates(
  command: string,
  pathExt: string | undefined
): readonly string[] {
  if (path.win32.extname(command)) return Object.freeze([command])
  return Object.freeze(
    safeWindowsPathExt(pathExt).map((extension) => `${command}${extension}`)
  )
}

export function executableSearchPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const pathApi = platform === 'win32' ? path.win32 : path
  const pathKey =
    platform === 'win32'
      ? Object.keys(environment).find((key) => key.toLowerCase() === 'path')
      : 'PATH'
  const entries = ((pathKey ? environment[pathKey] : undefined) ?? '')
    .split(pathApi.delimiter)
    .filter((entry) => entry && pathApi.isAbsolute(entry))
  if (platform === 'darwin') {
    entries.push('/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'))
  } else if (platform !== 'win32') {
    entries.push('/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin')
  }
  return [...new Set(entries)].join(pathApi.delimiter)
}

export function executableCandidates(
  command: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT
): readonly string[] {
  return platform === 'win32' ? windowsCommandCandidates(command, pathExt) : [command]
}

function copyEnvironmentValue(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  requestedKey: string,
  platform: NodeJS.Platform
): void {
  const key =
    platform === 'win32'
      ? Object.keys(source).find((candidate) => candidate.toLowerCase() === requestedKey.toLowerCase())
      : requestedKey
  if (key && source[key] !== undefined) target[key] = source[key]
}

export function safeChildEnvironment(
  additionalKeys: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const commonKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'SHELL',
    'TERM',
    'COLORTERM'
  ]
  const windowsKeys = [
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA'
  ]
  const environment: NodeJS.ProcessEnv = {}
  for (const key of [
    ...commonKeys,
    ...(platform === 'win32' ? windowsKeys : []),
    ...additionalKeys
  ]) {
    copyEnvironmentValue(environment, source, key, platform)
  }

  const existingPathKey =
    platform === 'win32'
      ? Object.keys(environment).find((key) => key.toLowerCase() === 'path')
      : 'PATH'
  if (existingPathKey && existingPathKey !== 'PATH') delete environment[existingPathKey]
  environment.PATH = executableSearchPath(source, platform)
  environment.NO_COLOR = '1'
  environment.TERM = 'dumb'
  return environment
}

function freezeIdentity(identity: LaunchFileIdentity): LaunchFileIdentity {
  return Object.freeze(identity)
}

async function fingerprintFile(
  candidate: string,
  platform: NodeJS.Platform,
  requireExecutable: boolean
): Promise<LaunchFileIdentity> {
  const canonical = await realpath(candidate)
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(canonical, constants.O_RDONLY | noFollow)
  try {
    const details = await handle.stat()
    if (!details.isFile()) throw new Error('Launch target is not a regular file')
    if (details.size > MAX_LAUNCH_FILE_BYTES) {
      throw new Error('Launch target is too large to fingerprint safely')
    }
    if (requireExecutable && platform !== 'win32' && (details.mode & 0o111) === 0) {
      throw new Error('Launch target is not executable')
    }

    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < details.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, details.size - position),
        position
      )
      if (bytesRead === 0) break
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    if (position !== details.size) throw new Error('Could not fingerprint the full launch target')

    return freezeIdentity({
      path: canonical,
      sha256: digest.digest('hex'),
      size: details.size,
      modifiedMs: details.mtimeMs,
      changedMs: details.ctimeMs,
      device: details.dev,
      inode: details.ino
    })
  } finally {
    await handle.close()
  }
}

function identityFingerprint(identity: LaunchFileIdentity): Record<string, unknown> {
  return {
    path: identity.path,
    sha256: identity.sha256,
    size: identity.size,
    modifiedMs: identity.modifiedMs,
    changedMs: identity.changedMs,
    device: identity.device,
    inode: identity.inode
  }
}

function envelopeFingerprint(
  kind: ProcessLaunchEnvelope['kind'],
  entry: LaunchFileIdentity,
  executable: LaunchFileIdentity,
  argumentPrefix: readonly string[],
  shim?: LaunchFileIdentity,
  script?: LaunchFileIdentity
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        kind,
        entry: identityFingerprint(entry),
        executable: identityFingerprint(executable),
        argumentPrefix,
        shim: shim ? identityFingerprint(shim) : undefined,
        script: script ? identityFingerprint(script) : undefined
      })
    )
    .digest('hex')
}

export function parseWindowsNodeShim(contents: string, shimPath: string): string {
  if (Buffer.byteLength(contents, 'utf8') > MAX_WINDOWS_SHIM_BYTES) {
    throw new Error('Windows command shim is too large to inspect safely')
  }
  if (contents.includes('\0')) throw new Error('Windows command shim contains a null byte')

  const targetPattern =
    /(?:^|\r?\n)[^\r\n]*?(?:"(?:%_prog%|%~dp0[\\/]node(?:\.exe)?|%dp0%[\\/]node(?:\.exe)?)"|node(?:\.exe)?)\s+"((?:%~dp0|%dp0%)[\\/][^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*\s*(?=$|\r?\n)/gim
  const targets = new Set<string>()
  for (const match of contents.matchAll(targetPattern)) {
    const rawTarget = match[1] as string
    const relative = rawTarget
      .replace(/^%~dp0[\\/]?/i, '')
      .replace(/^%dp0%[\\/]?/i, '')
    if (
      !relative ||
      /[%!^&|<>"\r\n]/.test(relative) ||
      path.win32.isAbsolute(relative)
    ) {
      throw new Error('Windows command shim contains an unsafe script target')
    }
    targets.add(path.win32.resolve(path.win32.dirname(shimPath), relative))
  }
  if (targets.size !== 1) {
    throw new Error(
      'Only recognized Node package-manager .cmd/.bat shims can be launched safely'
    )
  }
  return [...targets][0] as string
}

async function readBoundedShim(identity: LaunchFileIdentity): Promise<string> {
  if (identity.size > MAX_WINDOWS_SHIM_BYTES) {
    throw new Error('Windows command shim is too large to inspect safely')
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(identity.path, constants.O_RDONLY | noFollow)
  try {
    const details = await handle.stat()
    if (
      !details.isFile() ||
      details.size !== identity.size ||
      details.mtimeMs !== identity.modifiedMs ||
      details.ctimeMs !== identity.changedMs
    ) {
      throw new Error('Windows command shim changed while it was being inspected')
    }
    const buffer = Buffer.allocUnsafe(details.size)
    let position = 0
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        position,
        buffer.length - position,
        position
      )
      if (bytesRead === 0) break
      position += bytesRead
    }
    if (position !== buffer.length) throw new Error('Could not read the full Windows command shim')
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function regularFile(candidate: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(candidate)
    const details = await stat(canonical)
    return details.isFile() ? canonical : undefined
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return undefined
    throw error
  }
}

async function resolveWindowsNode(
  shimPath: string,
  options: CreateProcessLaunchOptions
): Promise<string> {
  const sibling = await regularFile(path.win32.join(path.win32.dirname(shimPath), 'node.exe'))
  if (sibling) return sibling

  const entries =
    options.pathEntries ??
    (options.pathValue ?? process.env.PATH ?? '')
      .split(';')
      .filter((entry) => entry && path.win32.isAbsolute(entry))
  for (const directory of entries) {
    const node = await regularFile(path.win32.join(directory, 'node.exe'))
    if (node) return node
  }
  throw new Error('Node.js executable required by the Windows command shim was not found')
}

export async function createProcessLaunchEnvelope(
  entryPath: string,
  options: CreateProcessLaunchOptions = {}
): Promise<ProcessLaunchEnvelope> {
  const platform = options.platform ?? process.platform
  const entry = await fingerprintFile(entryPath, platform, platform !== 'win32')
  const extension = path.extname(entry.path).toUpperCase()

  if (platform !== 'win32') {
    const argumentPrefix = Object.freeze([] as string[])
    return Object.freeze({
      version: 1 as const,
      kind: 'direct' as const,
      entry,
      executable: entry,
      argumentPrefix,
      fingerprint: envelopeFingerprint('direct', entry, entry, argumentPrefix)
    })
  }

  if (extension === '.EXE' || extension === '.COM') {
    const argumentPrefix = Object.freeze([] as string[])
    return Object.freeze({
      version: 1 as const,
      kind: 'direct' as const,
      entry,
      executable: entry,
      argumentPrefix,
      fingerprint: envelopeFingerprint('direct', entry, entry, argumentPrefix)
    })
  }
  if (extension !== '.CMD' && extension !== '.BAT') {
    throw new Error('Windows launches must use .exe, .com, or a recognized Node .cmd/.bat shim')
  }

  const scriptPath = parseWindowsNodeShim(await readBoundedShim(entry), entry.path)
  const [executable, script] = await Promise.all([
    fingerprintFile(await resolveWindowsNode(entry.path, options), platform, false),
    fingerprintFile(scriptPath, platform, false)
  ])
  const argumentPrefix = Object.freeze([script.path])
  return Object.freeze({
    version: 1 as const,
    kind: 'windows-node-shim' as const,
    entry,
    executable,
    argumentPrefix,
    shim: entry,
    script,
    fingerprint: envelopeFingerprint(
      'windows-node-shim',
      entry,
      executable,
      argumentPrefix,
      entry,
      script
    )
  })
}

function sameIdentity(left: LaunchFileIdentity, right: LaunchFileIdentity): boolean {
  return (
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs &&
    left.changedMs === right.changedMs &&
    left.device === right.device &&
    left.inode === right.inode
  )
}

export function isFrozenProcessLaunchEnvelope(envelope: ProcessLaunchEnvelope): boolean {
  return (
    Object.isFrozen(envelope) &&
    Object.isFrozen(envelope.entry) &&
    Object.isFrozen(envelope.executable) &&
    Object.isFrozen(envelope.argumentPrefix) &&
    (!envelope.shim || Object.isFrozen(envelope.shim)) &&
    (!envelope.script || Object.isFrozen(envelope.script))
  )
}

export async function revalidateProcessLaunchEnvelope(
  envelope: ProcessLaunchEnvelope,
  options: CreateProcessLaunchOptions = {}
): Promise<void> {
  if (
    envelope.version !== 1 ||
    !isFrozenProcessLaunchEnvelope(envelope) ||
    !/^[a-f0-9]{64}$/.test(envelope.fingerprint)
  ) {
    throw new Error('Process launch envelope failed integrity validation')
  }
  const current = await createProcessLaunchEnvelope(envelope.entry.path, options)
  if (
    current.kind !== envelope.kind ||
    current.fingerprint !== envelope.fingerprint ||
    !sameIdentity(current.entry, envelope.entry) ||
    !sameIdentity(current.executable, envelope.executable) ||
    current.argumentPrefix.length !== envelope.argumentPrefix.length ||
    current.argumentPrefix.some((argument, index) => argument !== envelope.argumentPrefix[index]) ||
    Boolean(current.shim) !== Boolean(envelope.shim) ||
    Boolean(current.script) !== Boolean(envelope.script) ||
    (current.shim && envelope.shim && !sameIdentity(current.shim, envelope.shim)) ||
    (current.script && envelope.script && !sameIdentity(current.script, envelope.script))
  ) {
    throw new Error('Process launch target changed since approval or authorization')
  }
}

export function processLaunchArguments(
  envelope: ProcessLaunchEnvelope,
  args: readonly string[]
): string[] {
  return [...envelope.argumentPrefix, ...args]
}
