import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const TERMINAL_LIMITS = Object.freeze({
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 300,
  maxInputBytes: 64 * 1024,
  defaultScrollbackBytes: 1024 * 1024,
  defaultMaxSessions: 8
})

export interface TerminalDimensions {
  cols: number
  rows: number
}

export interface TerminalPtySpawnOptions extends TerminalDimensions {
  name: string
  cwd: string
  env: Record<string, string>
  encoding?: 'utf8'
}

export interface TerminalDisposable {
  dispose(): void
}

export interface TerminalPty {
  readonly pid: number
  readonly onData: (
    listener: (data: string) => void
  ) => TerminalDisposable
  readonly onExit: (
    listener: (event: { exitCode: number; signal?: number }) => void
  ) => TerminalDisposable
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface TerminalPtyFactory {
  spawn(
    executable: string,
    args: string[],
    options: TerminalPtySpawnOptions
  ): TerminalPty
}

export interface TerminalShell {
  executable: string
  args: string[]
}

export interface TerminalLaunchDetails {
  executable: string
  args: readonly string[]
  cwd: string
}

export type TerminalLaunchAuthorizer = (
  details: Readonly<TerminalLaunchDetails>
) => Promise<boolean>

export class TerminalLaunchCancelledError extends Error {
  constructor() {
    super('Terminal launch canceled')
    this.name = 'TerminalLaunchCancelledError'
  }
}

export interface TerminalSessionInfo extends TerminalDimensions {
  id: string
  pid: number
  createdAt: number
}

export interface TerminalDataEvent {
  type: 'data'
  sessionId: string
  sequence: number
  data: string
  replayed: boolean
  timestamp: number
}

export interface TerminalExitEvent {
  type: 'exit'
  sessionId: string
  exitCode: number | null
  signal?: number
  reason: 'process-exit' | 'disposed' | 'service-disposed'
  timestamp: number
}

export interface TerminalSubscriber {
  onData?(event: TerminalDataEvent): void
  onExit?(event: TerminalExitEvent): void
}

export type AuthorizedWorkspaceResolver = (
  candidate: string
) => Promise<string>

export interface TerminalServiceOptions {
  /**
   * This must be a main-process trust-boundary function such as
   * WorkspaceGrantRegistry.require. The renderer's path is never used as a cwd
   * until this resolver returns an authorized path and the service canonicalizes it.
   */
  authorizeWorkspace: AuthorizedWorkspaceResolver
  ptyFactory?: TerminalPtyFactory | (() => Promise<TerminalPtyFactory>)
  shellResolver?: () => Promise<TerminalShell>
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  maxSessions?: number
  scrollbackBytes?: number
  createId?: () => string
  now?: () => number
  onCallbackError?: (error: unknown) => void
}

interface ScrollbackEntry {
  sequence: number
  data: string
  bytes: number
  timestamp: number
}

interface InternalSubscriber {
  callbacks: TerminalSubscriber
  active: boolean
  replaying: boolean
  queued: TerminalDataEvent[]
}

interface InternalSession {
  info: TerminalSessionInfo
  pty: TerminalPty
  closed: boolean
  sequence: number
  scrollback: ScrollbackEntry[]
  scrollbackBytes: number
  subscribers: Set<InternalSubscriber>
  dataListener?: TerminalDisposable
  exitListener?: TerminalDisposable
}

const COMMON_ENVIRONMENT_KEYS = new Set([
  'home',
  'user',
  'logname',
  'path',
  'lang',
  'tmpdir',
  'ssh_auth_sock',
  'xdg_cache_home',
  'xdg_config_home',
  'xdg_data_home',
  'xdg_runtime_dir',
  '__cf_user_text_encoding'
])

const WINDOWS_ENVIRONMENT_KEYS = new Set([
  'appdata',
  'comspec',
  'homedrive',
  'homepath',
  'localappdata',
  'path',
  'pathext',
  'programdata',
  'programfiles',
  'programfiles(x86)',
  'programw6432',
  'systemdrive',
  'systemroot',
  'temp',
  'tmp',
  'username',
  'userprofile',
  'windir'
])

function checkedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return result
}

function checkedNonNegativeInteger(
  name: string,
  value: number | undefined,
  fallback: number
): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return result
}

function checkedPositiveInteger(
  name: string,
  value: number | undefined,
  fallback: number
): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return result
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  wantedKey: string
): string | undefined {
  const normalized = wantedKey.toLowerCase()
  const entry = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === normalized
  )
  return entry?.[1]
}

function safeWindowsRoot(environment: NodeJS.ProcessEnv): string {
  const configured =
    environmentValue(environment, 'SystemRoot') ??
    environmentValue(environment, 'WINDIR')
  if (
    configured &&
    /^[a-z]:\\/i.test(configured) &&
    path.win32.isAbsolute(configured)
  ) {
    return path.win32.normalize(configured)
  }
  return 'C:\\Windows'
}

export function resolveWindowsCommandProcessor(
  environment: NodeJS.ProcessEnv = process.env
): string {
  return path.win32.join(
    safeWindowsRoot(environment),
    'System32',
    'cmd.exe'
  )
}

function defaultShellCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): TerminalShell[] {
  if (platform === 'win32') {
    const root = safeWindowsRoot(environment)
    return [
      {
        executable: path.win32.join(
          root,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        ),
        args: ['-NoLogo']
      },
      {
        executable: path.win32.join(root, 'System32', 'cmd.exe'),
        args: []
      }
    ]
  }

  if (platform === 'darwin') {
    return [
      { executable: '/bin/zsh', args: [] },
      { executable: '/bin/bash', args: [] },
      { executable: '/bin/sh', args: [] }
    ]
  }

  return [
    { executable: '/bin/bash', args: [] },
    { executable: '/usr/bin/bash', args: [] },
    { executable: '/bin/sh', args: [] }
  ]
}

export async function resolveDefaultTerminalShell(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  isExecutable: (candidate: string) => Promise<boolean> = async (candidate) => {
    try {
      await access(
        candidate,
        platform === 'win32' ? constants.F_OK : constants.X_OK
      )
      return true
    } catch {
      return false
    }
  }
): Promise<TerminalShell> {
  for (const candidate of defaultShellCandidates(platform, environment)) {
    if (await isExecutable(candidate.executable)) return candidate
  }
  throw new Error('Ground could not find a supported system shell')
}

export function buildTerminalEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  shell: string,
  workspace: string
): Record<string, string> {
  const allowed =
    platform === 'win32'
      ? new Set([...COMMON_ENVIRONMENT_KEYS, ...WINDOWS_ENVIRONMENT_KEYS])
      : COMMON_ENVIRONMENT_KEYS
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase()
    if (
      value === undefined ||
      value.includes('\0') ||
      value.length > 32_768 ||
      (!allowed.has(normalized) && !normalized.startsWith('lc_'))
    ) {
      continue
    }
    result[key] = value
  }

  result.TERM = 'xterm-256color'
  result.COLORTERM = 'truecolor'
  result.GROUND_TERMINAL = '1'
  if (platform === 'win32') {
    for (const key of Object.keys(result)) {
      if (key.toLowerCase() === 'comspec') delete result[key]
    }
    result.ComSpec = resolveWindowsCommandProcessor(source)
  } else {
    result.SHELL = shell
    result.PWD = workspace
  }
  return result
}

async function defaultPtyFactory(): Promise<TerminalPtyFactory> {
  const nodePty = await import('node-pty')
  return {
    spawn: (executable, args, options) =>
      nodePty.spawn(executable, args, options)
  }
}

function utf8Tail(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return ''
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= maximumBytes) return value

  let start = encoded.byteLength - maximumBytes
  while (
    start < encoded.byteLength &&
    ((encoded[start] ?? 0) & 0b1100_0000) === 0b1000_0000
  ) {
    start += 1
  }
  return encoded.subarray(start).toString('utf8')
}

/**
 * Owns interactive PTYs in Ground's main process.
 *
 * SECURITY: A PTY is not a sandbox. The shell inherits the operating-system
 * permissions of the Ground process and can access anything that user account can
 * access. Workspace authorization constrains the starting directory and prevents a
 * renderer from selecting an arbitrary cwd; it does not impose an OS filesystem
 * boundary. IPC callers must additionally enforce Ground's trusted-frame checks and
 * require an explicit user action before creating a session.
 */
export class TerminalService {
  private readonly sessions = new Map<string, InternalSession>()
  private readonly authorizeWorkspace: AuthorizedWorkspaceResolver
  private readonly ptyFactory:
    | TerminalPtyFactory
    | (() => Promise<TerminalPtyFactory>)
  private readonly shellResolver: () => Promise<TerminalShell>
  private readonly environment: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly maxSessions: number
  private readonly scrollbackBytes: number
  private readonly createId: () => string
  private readonly now: () => number
  private readonly onCallbackError: (error: unknown) => void
  private pendingCreations = 0
  private closed = false

  constructor(options: TerminalServiceOptions) {
    this.authorizeWorkspace = options.authorizeWorkspace
    this.ptyFactory = options.ptyFactory ?? defaultPtyFactory
    this.environment = options.environment ?? process.env
    this.platform = options.platform ?? process.platform
    this.shellResolver =
      options.shellResolver ??
      (() =>
        resolveDefaultTerminalShell(this.platform, this.environment))
    this.maxSessions = checkedPositiveInteger(
      'maxSessions',
      options.maxSessions,
      TERMINAL_LIMITS.defaultMaxSessions
    )
    this.scrollbackBytes = checkedNonNegativeInteger(
      'scrollbackBytes',
      options.scrollbackBytes,
      TERMINAL_LIMITS.defaultScrollbackBytes
    )
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.onCallbackError = options.onCallbackError ?? (() => undefined)
  }

  async createForWorkspace(
    workspaceCandidate: string,
    dimensions: Partial<TerminalDimensions> = {},
    authorizeLaunch?: TerminalLaunchAuthorizer
  ): Promise<TerminalSessionInfo> {
    if (this.closed) throw new Error('Terminal service is disposed')
    if (
      typeof workspaceCandidate !== 'string' ||
      workspaceCandidate.length === 0 ||
      workspaceCandidate.length > 32_768 ||
      workspaceCandidate.includes('\0')
    ) {
      throw new Error('A valid authorized workspace is required')
    }
    if (this.sessions.size + this.pendingCreations >= this.maxSessions) {
      throw new Error(`Terminal session limit reached (${this.maxSessions})`)
    }

    const cols = checkedInteger(
      'cols',
      dimensions.cols,
      100,
      TERMINAL_LIMITS.minCols,
      TERMINAL_LIMITS.maxCols
    )
    const rows = checkedInteger(
      'rows',
      dimensions.rows,
      30,
      TERMINAL_LIMITS.minRows,
      TERMINAL_LIMITS.maxRows
    )

    this.pendingCreations += 1
    let pty: TerminalPty | undefined
    try {
      const authorized = await this.authorizeWorkspace(workspaceCandidate)
      if (typeof authorized !== 'string' || !path.isAbsolute(authorized)) {
        throw new Error('Workspace authorizer returned an invalid path')
      }
      const canonicalWorkspace = await realpath(authorized)
      const details = await stat(canonicalWorkspace)
      if (!details.isDirectory()) {
        throw new Error('Authorized workspace is not a directory')
      }
      if (this.closed) throw new Error('Terminal service is disposed')

      const shell = await this.shellResolver()
      if (
        !path.isAbsolute(shell.executable) ||
        !Array.isArray(shell.args) ||
        shell.args.some(
          (arg) =>
            typeof arg !== 'string' ||
            arg.length > 32_768 ||
            arg.includes('\0')
        )
      ) {
        throw new Error('Shell resolver returned an invalid system shell')
      }
      if (this.closed) throw new Error('Terminal service is disposed')

      const launchDetails: Readonly<TerminalLaunchDetails> = Object.freeze({
        executable: shell.executable,
        args: Object.freeze([...shell.args]),
        cwd: canonicalWorkspace
      })
      if (authorizeLaunch && !(await authorizeLaunch(launchDetails))) {
        throw new TerminalLaunchCancelledError()
      }
      if (this.closed) throw new Error('Terminal service is disposed')

      const factory =
        typeof this.ptyFactory === 'function'
          ? await this.ptyFactory()
          : this.ptyFactory
      if (this.closed) throw new Error('Terminal service is disposed')

      const spawnOptions: TerminalPtySpawnOptions = {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: canonicalWorkspace,
        env: buildTerminalEnvironment(
          this.environment,
          this.platform,
          shell.executable,
          canonicalWorkspace
        )
      }
      // node-pty always emits UTF-8 strings on Windows and warns when its
      // unsupported encoding option is present. POSIX accepts the explicit
      // encoding and uses it for both sides of the pseudoterminal.
      if (this.platform !== 'win32') spawnOptions.encoding = 'utf8'
      pty = factory.spawn(
        shell.executable,
        [...shell.args],
        spawnOptions
      )

      const id = this.allocateId()
      const state: InternalSession = {
        info: {
          id,
          pid: pty.pid,
          cols,
          rows,
          createdAt: this.now()
        },
        pty,
        closed: false,
        sequence: 0,
        scrollback: [],
        scrollbackBytes: 0,
        subscribers: new Set()
      }

      this.sessions.set(id, state)
      pty = undefined
      try {
        const dataListener = state.pty.onData((data) => {
          this.handleData(state, data)
        })
        state.dataListener = dataListener
        if (state.closed) dataListener.dispose()

        const exitListener = state.pty.onExit((event) => {
          this.finishSession(state, {
            exitCode: event.exitCode,
            signal: event.signal,
            reason: 'process-exit'
          })
        })
        state.exitListener = exitListener
        if (state.closed) exitListener.dispose()
      } catch (error) {
        this.finishSession(
          state,
          {
            exitCode: null,
            reason: 'disposed'
          },
          true
        )
        throw error
      }
      if (state.closed) {
        throw new Error('Terminal process exited during startup')
      }
      return { ...state.info }
    } catch (error) {
      if (pty) {
        try {
          pty.kill()
        } catch {
          // The process may already have exited while creation was failing.
        }
      }
      throw error
    } finally {
      this.pendingCreations -= 1
    }
  }

  listSessions(): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .map(({ info }) => ({ ...info }))
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  subscribe(
    sessionId: string,
    callbacks: TerminalSubscriber,
    replay = true
  ): TerminalDisposable {
    const state = this.requireSession(sessionId)
    const subscriber: InternalSubscriber = {
      callbacks,
      active: true,
      replaying: replay,
      queued: []
    }
    state.subscribers.add(subscriber)

    if (replay) {
      const snapshot = [...state.scrollback]
      for (const entry of snapshot) {
        if (!subscriber.active) break
        this.invokeData(subscriber, {
          type: 'data',
          sessionId,
          sequence: entry.sequence,
          data: entry.data,
          replayed: true,
          timestamp: entry.timestamp
        })
      }
      subscriber.replaying = false
      for (const event of subscriber.queued.splice(0)) {
        if (!subscriber.active) break
        this.invokeData(subscriber, event)
      }
    }

    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        subscriber.active = false
        subscriber.queued.length = 0
        state.subscribers.delete(subscriber)
      }
    }
  }

  sendInput(sessionId: string, data: string): void {
    const state = this.requireSession(sessionId)
    if (typeof data !== 'string') throw new Error('Terminal input must be text')
    const bytes = Buffer.byteLength(data, 'utf8')
    if (bytes > TERMINAL_LIMITS.maxInputBytes) {
      throw new Error(
        `Terminal input exceeds ${TERMINAL_LIMITS.maxInputBytes} bytes`
      )
    }
    state.pty.write(data)
  }

  resize(sessionId: string, dimensions: TerminalDimensions): TerminalSessionInfo {
    const state = this.requireSession(sessionId)
    const cols = checkedInteger(
      'cols',
      dimensions.cols,
      state.info.cols,
      TERMINAL_LIMITS.minCols,
      TERMINAL_LIMITS.maxCols
    )
    const rows = checkedInteger(
      'rows',
      dimensions.rows,
      state.info.rows,
      TERMINAL_LIMITS.minRows,
      TERMINAL_LIMITS.maxRows
    )
    state.pty.resize(cols, rows)
    state.info.cols = cols
    state.info.rows = rows
    return { ...state.info }
  }

  kill(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)
    if (!state) return false
    this.finishSession(
      state,
      {
        exitCode: null,
        reason: 'disposed'
      },
      true
    )
    return true
  }

  disposeSession(sessionId: string): boolean {
    return this.kill(sessionId)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const state of [...this.sessions.values()]) {
      this.finishSession(
        state,
        {
          exitCode: null,
          reason: 'service-disposed'
        },
        true
      )
    }
  }

  private allocateId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.createId()
      if (id && !this.sessions.has(id)) return id
    }
    throw new Error('Could not allocate a unique terminal session ID')
  }

  private requireSession(sessionId: string): InternalSession {
    const state = this.sessions.get(sessionId)
    if (!state || state.closed) throw new Error('Terminal session not found')
    return state
  }

  private handleData(state: InternalSession, data: string): void {
    if (state.closed || typeof data !== 'string' || data.length === 0) return
    const sequence = (state.sequence += 1)
    const timestamp = this.now()
    const entry: ScrollbackEntry = {
      sequence,
      data,
      bytes: Buffer.byteLength(data, 'utf8'),
      timestamp
    }
    this.appendScrollback(state, entry)

    const event: TerminalDataEvent = {
      type: 'data',
      sessionId: state.info.id,
      sequence,
      data,
      replayed: false,
      timestamp
    }
    for (const subscriber of [...state.subscribers]) {
      if (!subscriber.active) continue
      if (subscriber.replaying) subscriber.queued.push(event)
      else this.invokeData(subscriber, event)
    }
  }

  private appendScrollback(
    state: InternalSession,
    entry: ScrollbackEntry
  ): void {
    if (this.scrollbackBytes === 0) return
    if (entry.bytes > this.scrollbackBytes) {
      entry.data = utf8Tail(entry.data, this.scrollbackBytes)
      entry.bytes = Buffer.byteLength(entry.data, 'utf8')
    }
    state.scrollback.push(entry)
    state.scrollbackBytes += entry.bytes

    while (
      state.scrollbackBytes > this.scrollbackBytes &&
      state.scrollback.length > 0
    ) {
      const first = state.scrollback[0]
      if (!first) break
      const excess = state.scrollbackBytes - this.scrollbackBytes
      if (first.bytes <= excess) {
        state.scrollback.shift()
        state.scrollbackBytes -= first.bytes
        continue
      }
      first.data = utf8Tail(first.data, first.bytes - excess)
      const nextBytes = Buffer.byteLength(first.data, 'utf8')
      state.scrollbackBytes += nextBytes - first.bytes
      first.bytes = nextBytes
    }
  }

  private invokeData(
    subscriber: InternalSubscriber,
    event: TerminalDataEvent
  ): void {
    if (!subscriber.active || !subscriber.callbacks.onData) return
    try {
      subscriber.callbacks.onData(event)
    } catch (error) {
      this.onCallbackError(error)
    }
  }

  private finishSession(
    state: InternalSession,
    event: Omit<TerminalExitEvent, 'type' | 'sessionId' | 'timestamp'>,
    killProcess = false
  ): void {
    if (state.closed) return
    state.closed = true
    this.sessions.delete(state.info.id)
    state.dataListener?.dispose()
    state.exitListener?.dispose()

    const terminalEvent: TerminalExitEvent = {
      type: 'exit',
      sessionId: state.info.id,
      ...event,
      timestamp: this.now()
    }
    for (const subscriber of [...state.subscribers]) {
      subscriber.active = false
      subscriber.queued.length = 0
      try {
        subscriber.callbacks.onExit?.(terminalEvent)
      } catch (error) {
        this.onCallbackError(error)
      }
    }
    state.subscribers.clear()
    state.scrollback.length = 0
    state.scrollbackBytes = 0

    if (killProcess) {
      try {
        state.pty.kill()
      } catch {
        // Killing an already-exited PTY is harmless during idempotent cleanup.
      }
    }
  }
}
