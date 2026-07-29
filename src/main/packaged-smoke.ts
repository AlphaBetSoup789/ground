import { spawn } from 'node:child_process'
import { createMCPClient } from '@ai-sdk/mcp'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import {
  mkdir,
  readFile,
  realpath,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import {
  parsePackagedSmokeArgument,
  type PackagedSmokeScope
} from '../shared/packaged-smoke'
import {
  GitWorkspaceService,
  resolveGitExecutable
} from './git-service'
import {
  McpService,
  SecureStdioMcpTransport,
  type McpClientFactory
} from './mcp-service'
import { terminateProcessTree } from './process-tree'
import {
  resolveDefaultTerminalShell,
  TerminalService,
  type TerminalPtyFactory
} from './terminal-service'

const SMOKE_DIRECTORY_PREFIX = 'ground-packaged-smoke-'
const RESULT_FILENAME = 'result.json'
const MAX_DIAGNOSTIC_LENGTH = 4_000

export interface PackagedSmokeConfig {
  token: string
  scope: PackagedSmokeScope
  directory: string
  resultPath: string
  userDataPath: string
}

export interface PackagedSmokeResult {
  version: 1
  status: 'passed' | 'failed'
  token: string
  scope: PackagedSmokeScope
  platform: NodeJS.Platform
  architecture: string
  checks: Record<string, boolean>
  error?: {
    name: string
    message: string
  }
}

export function shouldMigrateLegacyData(
  config: PackagedSmokeConfig | undefined
): boolean {
  return config === undefined
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

function safeDiagnostic(value: unknown): {
  name: string
  message: string
} {
  const error = value instanceof Error ? value : new Error(String(value))
  return {
    name: /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
      ? error.name
      : 'SmokeError',
    message: error.message
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
      .slice(0, MAX_DIAGNOSTIC_LENGTH)
  }
}

export function resolvePackagedSmokeConfig(input: {
  isPackaged: boolean
  argv?: readonly string[]
  environment?: NodeJS.ProcessEnv
  temporaryDirectory: string
}): PackagedSmokeConfig | undefined {
  if (!input.isPackaged) return undefined
  const request = parsePackagedSmokeArgument(input.argv ?? process.argv)
  if (!request) return undefined
  const environment = input.environment ?? process.env
  const unexpectedControlKey = Object.keys(environment).find(
    (key) =>
      key.startsWith('GROUND_PACKAGED_SMOKE_') &&
      key !== 'GROUND_PACKAGED_SMOKE_DIRECTORY'
  )
  if (unexpectedControlKey) return undefined
  const configuredDirectory = environment.GROUND_PACKAGED_SMOKE_DIRECTORY
  if (
    !configuredDirectory ||
    configuredDirectory.includes('\0') ||
    !path.isAbsolute(configuredDirectory)
  ) {
    return undefined
  }
  const expectedDirectory = path.join(
    path.resolve(input.temporaryDirectory),
    `${SMOKE_DIRECTORY_PREFIX}${request.token}`
  )
  const directory = path.resolve(configuredDirectory)
  if (!samePath(directory, expectedDirectory)) return undefined

  return {
    token: request.token,
    scope: request.scope,
    directory,
    resultPath: path.join(directory, RESULT_FILENAME),
    userDataPath: path.join(directory, 'user-data')
  }
}

export function preparePackagedSmokeDirectory(
  config: PackagedSmokeConfig
): void {
  const details = lstatSync(config.directory)
  if (details.isSymbolicLink()) {
    throw new Error('Packaged smoke directory must not be a symbolic link')
  }
  if (!details.isDirectory()) {
    throw new Error('Packaged smoke path is not a directory')
  }
  mkdirSync(config.userDataPath, { recursive: false, mode: 0o700 })
  const userDataDetails = lstatSync(config.userDataPath)
  if (
    userDataDetails.isSymbolicLink() ||
    !userDataDetails.isDirectory()
  ) {
    throw new Error('Packaged smoke user-data path is not a private directory')
  }
  const canonicalDirectory = realpathSync(config.directory)
  const canonicalUserData = realpathSync(config.userDataPath)
  if (
    !samePath(path.dirname(canonicalUserData), canonicalDirectory) ||
    path.basename(canonicalUserData) !== 'user-data'
  ) {
    throw new Error(
      'Packaged smoke user-data path escaped its token-bound directory'
    )
  }
}

export async function writePackagedSmokeResult(
  config: PackagedSmokeConfig,
  checks: Record<string, boolean>,
  error?: unknown
): Promise<void> {
  const result: PackagedSmokeResult = {
    version: 1,
    status: error === undefined ? 'passed' : 'failed',
    token: config.token,
    scope: config.scope,
    platform: process.platform,
    architecture: process.arch,
    checks,
    ...(error === undefined ? {} : { error: safeDiagnostic(error) })
  }
  await writeFile(
    config.resultPath,
    `${JSON.stringify(result, null, 2)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    }
  )
}

async function waitFor<T>(
  label: string,
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function smokeTerminal(workspace: string): Promise<void> {
  const canonicalWorkspace = await realpath(workspace)
  const packagedExecutable = await realpath(process.execPath)
  const program = [
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  if (!chunk.includes('ground-packaged-pty-input')) return;",
    "  process.stdout.write('ground-packaged-pty-ok\\n');",
    '  process.exit(0);',
    '});',
    "process.stdout.write('ground-packaged-pty-ready\\n');",
    'setInterval(() => {}, 1000);'
  ].join('\n')
  const shell =
    process.platform === 'win32'
      ? await resolveDefaultTerminalShell('win32', process.env)
      : {
          executable: packagedExecutable,
          args: ['-e', program]
        }
  const windowsShellName = path.win32
    .basename(shell.executable)
    .toLowerCase()
  const input =
    process.platform !== 'win32'
      ? 'ground-packaged-pty-input\r'
      : windowsShellName === 'powershell.exe'
        ? "Write-Output ('ground-packaged-pty-' + 'ok'); exit 0\r"
        : 'echo ground-packaged-pty-o^k & exit /b 0\r'
  const ptyFactory = async (): Promise<TerminalPtyFactory> => {
    const nodePty = await import('node-pty')
    return {
      spawn: (executable, args, options) => {
        if (
          !samePath(executable, shell.executable) ||
          args.length !== shell.args.length ||
          args.some((argument, index) => argument !== shell.args[index])
        ) {
          throw new Error('Packaged PTY smoke refused an unexpected invocation')
        }
        return nodePty.spawn(executable, args, {
          ...options,
          env: {
            ...options.env,
            ...(process.platform === 'win32'
              ? {}
              : { ELECTRON_RUN_AS_NODE: '1' })
          }
        })
      }
    }
  }
  const service = new TerminalService({
    authorizeWorkspace: async (candidate) => {
      const canonicalCandidate = await realpath(candidate)
      if (!samePath(canonicalCandidate, canonicalWorkspace)) {
        throw new Error('Packaged PTY smoke rejected an unexpected workspace')
      }
      return canonicalWorkspace
    },
    shellResolver: async () => shell,
    ptyFactory,
    maxSessions: 1
  })
  try {
    const session = await service.createForWorkspace(canonicalWorkspace, {
      cols: 80,
      rows: 24
    })
    let output = ''
    let resolveReady: (() => void) | undefined
    let rejectReady: ((error: Error) => void) | undefined
    let resolveMarker: (() => void) | undefined
    let rejectMarker: ((error: Error) => void) | undefined
    let resolveExit: (() => void) | undefined
    let rejectExit: ((error: Error) => void) | undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const marker = new Promise<void>((resolve, reject) => {
      resolveMarker = resolve
      rejectMarker = reject
    })
    const exited = new Promise<void>((resolve, reject) => {
      resolveExit = resolve
      rejectExit = reject
    })
    const subscription = service.subscribe(session.id, {
      onData: (event) => {
        output = `${output}${event.data}`.slice(-16_384)
        if (
          process.platform === 'win32'
            ? event.data.length > 0
            : output.includes('ground-packaged-pty-ready')
        ) {
          resolveReady?.()
        }
        if (output.includes('ground-packaged-pty-ok')) resolveMarker?.()
      },
      onExit: (event) => {
        if (!output.includes('ground-packaged-pty-ok')) {
          const error = new Error(
            `Packaged PTY exited before its marker (exit ${String(
              event.exitCode
            )})`
          )
          rejectReady?.(error)
          rejectMarker?.(error)
          rejectExit?.(error)
        } else if (event.exitCode !== 0) {
          rejectExit?.(
            new Error(`Packaged PTY exited with ${String(event.exitCode)}`)
          )
        } else {
          resolveExit?.()
        }
      }
    })
    try {
      await waitFor('Packaged PTY readiness', ready, 12_000)
      service.sendInput(session.id, input)
      await waitFor(
        'Packaged PTY marker and exit',
        Promise.all([marker, exited]),
        12_000
      )
    } finally {
      subscription.dispose()
      service.kill(session.id)
    }
  } finally {
    service.dispose()
  }
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PATH: path.dirname(executable),
    TERM: 'dumb'
  }
  if (process.platform === 'win32') {
    environment.SystemRoot = 'C:\\Windows'
    environment.WINDIR = 'C:\\Windows'
    environment.TEMP = cwd
    environment.TMP = cwd
    environment.USERPROFILE = cwd
  } else {
    environment.HOME = cwd
    environment.TMPDIR = cwd
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    const diagnostics: Buffer[] = []
    let diagnosticBytes = 0
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const capture = (chunk: Buffer): void => {
      if (diagnosticBytes >= 32_768) return
      const accepted = chunk.subarray(0, 32_768 - diagnosticBytes)
      diagnostics.push(accepted)
      diagnosticBytes += accepted.byteLength
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (code === 0) {
        finish()
        return
      }
      finish(
        new Error(
          `Native process exited with ${String(code)}: ${Buffer.concat(
            diagnostics
          )
            .toString('utf8')
            .trim()}`
        )
      )
    })
    const timer = setTimeout(() => {
      terminateProcessTree(child, 'SIGKILL')
      finish(new Error(`Native process timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
}

async function smokeGit(
  workspace: string,
  worktreeRoot: string
): Promise<void> {
  let gitExecutable: string | undefined
  if (process.platform === 'win32') {
    for (const candidate of [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
    ]) {
      gitExecutable = await resolveGitExecutable(candidate)
      if (gitExecutable) break
    }
  } else {
    gitExecutable = await resolveGitExecutable()
  }
  if (!gitExecutable) throw new Error('Git was not found for packaged smoke')
  await runProcess(
    gitExecutable,
    ['-c', 'init.defaultBranch=main', 'init', workspace],
    path.dirname(workspace),
    12_000
  )
  await writeFile(path.join(workspace, 'ground-smoke.txt'), 'ground-git-ok\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
  const service = await GitWorkspaceService.open({
    workspacePath: workspace,
    worktreeRoot,
    gitExecutable,
    timeoutMs: 12_000,
    maxOutputBytes: 256_000
  })
  const status = await service.status({ timeoutMs: 12_000 })
  if (!status.untracked.includes('ground-smoke.txt')) {
    throw new Error('Packaged Git service did not report the smoke file')
  }
}

function mcpFixtureSource(): string {
  return String.raw`import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true
})
writeFileSync(
  process.env.GROUND_SMOKE_PID_FILE,
  JSON.stringify({ server: process.pid, descendant: descendant.pid })
)
process.on('SIGTERM', () => {})
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  while (true) {
    const newline = input.indexOf('\n')
    if (newline < 0) break
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (request.method === 'notifications/initialized') continue
    let result
    if (request.method === 'initialize') {
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'ground-packaged-smoke', version: '1.0.0' }
      }
    } else if (request.method === 'tools/list') {
      result = {
        tools: [{
          name: 'echo',
          description: 'Return the packaged smoke marker.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }]
      }
    } else if (request.method === 'tools/call') {
      result = {
        content: [{ type: 'text', text: 'ground-packaged-mcp-ok' }],
        isError: false
      }
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' }
      }) + '\n')
      continue
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result
    }) + '\n')
  }
})
setInterval(() => {}, 1000)
`
}

async function waitForPidFile(
  pidPath: string
): Promise<{ server: number; descendant: number }> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(pidPath, 'utf8')) as {
        server?: unknown
        descendant?: unknown
      }
      if (
        Number.isSafeInteger(parsed.server) &&
        (parsed.server as number) > 0 &&
        Number.isSafeInteger(parsed.descendant) &&
        (parsed.descendant as number) > 0
      ) {
        return {
          server: parsed.server as number,
          descendant: parsed.descendant as number
        }
      }
    } catch {
      // The fixture may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('MCP PID record timed out after 5000ms')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    )
  }
}

async function waitForProcessesToExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + 4_000
  while (pids.some(processIsAlive)) {
    if (Date.now() >= deadline) {
      throw new Error('MCP process-tree cleanup timed out after 4000ms')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function smokeMcpAndCancellation(
  config: PackagedSmokeConfig
): Promise<void> {
  const pidPath = path.join(config.directory, 'mcp-smoke-pids.json')
  const fixture = mcpFixtureSource()
  const packagedExecutable = await realpath(process.execPath)
  const clientFactory: McpClientFactory = async ({
    transport,
    lifecycleSignal
  }) => {
    if (
      transport.type !== 'stdio' ||
      !samePath(transport.command, packagedExecutable) ||
      transport.args.length !== 2 ||
      transport.args[0] !== '-e' ||
      transport.args[1] !== fixture
    ) {
      throw new Error('Packaged MCP smoke refused an unexpected invocation')
    }
    const runtime = new SecureStdioMcpTransport(
      {
        ...transport,
        env: {
          ...transport.env,
          ELECTRON_RUN_AS_NODE: '1'
        }
      },
      lifecycleSignal
    )
    return createMCPClient({
      transport: runtime,
      clientName: 'ground-packaged-smoke',
      version: '1.0.0',
      capabilities: {},
      maxRetries: 0
    })
  }
  const service = new McpService(clientFactory, async () => true)
  let pids: { server: number; descendant: number } | undefined
  try {
    const connected = await service.connect({
      id: 'packaged-smoke',
      name: 'Packaged smoke',
      namespace: 'packaged_smoke',
      transport: 'stdio',
      command: packagedExecutable,
      args: ['-e', fixture],
      cwd: config.directory,
      env: {
        GROUND_SMOKE_PID_FILE: pidPath
      },
      connectTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
      maxResultBytes: 32_000
    })
    pids = await waitForPidFile(pidPath)
    const trusted = await service.trustToolDefinitions(
      connected.id,
      connected.fingerprints
    )
    const toolName = trusted.tools[0]?.definition.name
    if (!toolName) throw new Error('Packaged MCP fixture exposed no tool')
    const result = await service.executeTool(
      toolName,
      {},
      {
        approvalGranted: true,
        timeoutMs: 10_000
      }
    )
    if (!JSON.stringify(result.result).includes('ground-packaged-mcp-ok')) {
      throw new Error('Packaged MCP call did not return its marker')
    }
  } finally {
    await service.close()
  }
  if (!pids) throw new Error('Packaged MCP fixture did not record process IDs')
  await waitForProcessesToExit([pids.server, pids.descendant])
}

function reportNativeSmokeProgress(
  check: 'pty' | 'git' | 'mcp',
  state: 'starting' | 'passed'
): void {
  process.stderr.write(`ground-packaged-smoke-${check}-${state}\n`)
}

export async function runPackagedNativeSmoke(
  config: PackagedSmokeConfig
): Promise<Record<string, boolean>> {
  const workspace = path.join(config.directory, 'workspace')
  const worktreeRoot = path.join(config.directory, 'worktrees')
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(worktreeRoot, { mode: 0o700 })
  ])
  const checks: Record<string, boolean> = {}

  reportNativeSmokeProgress('pty', 'starting')
  await smokeTerminal(workspace)
  checks.pty = true
  reportNativeSmokeProgress('pty', 'passed')

  reportNativeSmokeProgress('git', 'starting')
  await smokeGit(workspace, worktreeRoot)
  checks.git = true
  reportNativeSmokeProgress('git', 'passed')

  reportNativeSmokeProgress('mcp', 'starting')
  await smokeMcpAndCancellation(config)
  checks.mcp = true
  checks.processTreeCancellation = true
  reportNativeSmokeProgress('mcp', 'passed')

  return checks
}
