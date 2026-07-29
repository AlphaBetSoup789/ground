import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import {
  PACKAGED_SMOKE_PRELOAD_ARGUMENT_PREFIX,
  PACKAGED_SMOKE_PRELOAD_CHANNEL
} from '../shared/packaged-smoke'
import type {
  GitOverview,
  RunEvent,
  RunEventEnvelope,
  TaskExportFormat,
  TerminalSessionInfo
} from '../shared/types'
import {
  GitServiceError,
  GitWorkspaceService
} from './git-service'
import { McpManager } from './mcp-manager'
import type { McpStdioLaunchTrustRequest } from './mcp-service'
import { ProviderService } from './provider-service'
import { ProviderOperationGate } from './provider-operation-gate'
import { RunManager } from './run-manager'
import { SecretVault } from './secrets'
import { StateStore } from './store'
import {
  ensureTaskExportExtension,
  readBoundedTextFile,
  safeTaskFilename,
  writeTextFileAtomically
} from './task-files'
import {
  exportGroundTaskMarkdown,
  GROUND_TASK_BUNDLE_LIMITS,
  importGroundTaskBundle,
  serializeGroundTaskBundle
} from './task-portability'
import {
  TerminalLaunchCancelledError,
  TerminalService,
  type TerminalLaunchDetails
} from './terminal-service'
import { TerminalAccessRegistry } from './terminal-access'
import {
  parseNonEmptyId,
  parsePrompt,
  parseTaskPatch,
  parseWorkspacePath
} from './validation'
import { migrateLegacyData } from './migration'
import {
  preparePackagedSmokeDirectory,
  resolvePackagedSmokeConfig,
  runPackagedNativeSmoke,
  shouldMigrateLegacyData,
  writePackagedSmokeResult
} from './packaged-smoke'
import {
  CliTrustRegistry,
  type CliTrustRequest,
  isExpectedRendererUrl,
  resolveRendererTarget,
  WorkspaceGrantRegistry
} from './trust-boundary'

let mainWindow: BrowserWindow | undefined
let runManager: RunManager | undefined
let terminalService: TerminalService | undefined
let mcpManager: McpManager | undefined
let quitCleanup: Promise<void> | undefined
let quittingAfterCleanup = false
let windowCreation: Promise<void> | undefined
let fatalStartupHandled = false
let appInitialized = false
const trustedRendererUrls = new Map<number, string>()
let runEventRevision = 0
const activeRunEvents = new Map<string, RunEventEnvelope[]>()
const packagedSmokeConfig = resolvePackagedSmokeConfig({
  isPackaged: app.isPackaged,
  temporaryDirectory: os.tmpdir()
})
let packagedSmokeFinished = false
let resolvePackagedSmokePreload: (() => void) | undefined
const packagedSmokePreloadReady = packagedSmokeConfig
  ? new Promise<void>((resolve) => {
      resolvePackagedSmokePreload = resolve
    })
  : undefined

if (packagedSmokeConfig) {
  preparePackagedSmokeDirectory(packagedSmokeConfig)
  app.setPath('userData', packagedSmokeConfig.userDataPath)
}

function emitRunEvent(event: RunEvent): void {
  const envelope: RunEventEnvelope = {
    revision: (runEventRevision += 1),
    event
  }
  if (event.type === 'run-started') {
    activeRunEvents.set(event.runId, [envelope])
  } else if (
    event.type !== 'run-completed' &&
    event.type !== 'run-stopped' &&
    event.type !== 'run-error'
  ) {
    const events = activeRunEvents.get(event.runId)
    if (events) {
      const previous = events.at(-1)
      if (
        previous?.event.type === 'text-delta' &&
        event.type === 'text-delta' &&
        previous.event.itemId === event.itemId
      ) {
        previous.event.delta += event.delta
        previous.revision = envelope.revision
      } else {
        events.push(envelope)
      }
    }
  }
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC.runEvent, envelope)
  }
  if (
    event.type === 'run-completed' ||
    event.type === 'run-stopped' ||
    event.type === 'run-error'
  ) {
    activeRunEvents.delete(event.runId)
  }
}

function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  const expectedUrl = trustedRendererUrls.get(event.sender.id)
  if (
    !expectedUrl ||
    event.senderFrame !== event.sender.mainFrame ||
    !isExpectedRendererUrl(event.senderFrame.url, expectedUrl)
  ) {
    throw new Error('Rejected IPC from an untrusted renderer')
  }
}

function handlePackagedSmokePreload(
  event: Electron.IpcMainEvent,
  token: unknown
): void {
  if (
    !packagedSmokeConfig ||
    token !== packagedSmokeConfig.token ||
    event.sender !== mainWindow?.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    return
  }
  const expectedUrl = trustedRendererUrls.get(event.sender.id)
  if (
    !expectedUrl ||
    !isExpectedRendererUrl(event.senderFrame.url, expectedUrl)
  ) {
    return
  }
  resolvePackagedSmokePreload?.()
  resolvePackagedSmokePreload = undefined
}

if (packagedSmokeConfig) {
  ipcMain.on(
    PACKAGED_SMOKE_PRELOAD_CHANNEL,
    handlePackagedSmokePreload
  )
}

type TrustedIpcHandler = (
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown

function handleTrusted(channel: string, handler: TrustedIpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event)
    return handler(event, ...args)
  })
}

function parseTaskExportFormat(value: unknown): TaskExportFormat {
  if (value !== 'bundle' && value !== 'markdown') {
    throw new Error('Unsupported task export format')
  }
  return value
}

async function confirmCliTrust(request: CliTrustRequest): Promise<boolean> {
  const argumentsText = request.args.length
    ? request.args.map((argument, index) => `argv[${index}]: ${JSON.stringify(argument)}`).join('\n')
    : '(none)'
  const launchDetails =
    request.launch.kind === 'windows-node-shim'
      ? [
          'Recognized Windows Node package shim:',
          JSON.stringify(request.launch.entry.path),
          `Shim SHA-256: ${request.launch.entry.sha256}`,
          '',
          'Bound Node interpreter:',
          JSON.stringify(request.launch.executable.path),
          `Interpreter SHA-256: ${request.launch.executable.sha256}`,
          '',
          'Bound package script:',
          JSON.stringify(request.launch.script?.path),
          `Script SHA-256: ${request.launch.script?.sha256}`,
          '',
          'Ground parses this reviewed shim shape and launches Node directly; cmd.exe does not interpret these arguments.'
        ]
      : [
          'Executable:',
          JSON.stringify(request.launch.executable.path),
          `Executable SHA-256: ${request.launch.executable.sha256}`
        ]
  const promptDetails =
    request.phase === 'configuration'
      ? ['This approval records the saved argument template. Every final launch is authorized separately.']
      : request.prompt?.transport === 'argument'
        ? [
            `Prompt: omitted from this dialog (${request.prompt.byteLength} UTF-8 bytes)`,
            `Prompt SHA-256: ${request.prompt.sha256}`
          ]
        : [
            'Prompt: delivered through stdin and omitted from this dialog.',
            'Stdin prompt content is data and is not part of this reusable launch grant.'
          ]
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: [
      'Cancel',
      request.phase === 'configuration'
        ? 'Save trusted configuration'
        : 'Authorize exact invocation'
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Authorize CLI runtime',
    message: `${
      request.phase === 'configuration' ? 'Trust' : 'Run'
    } ${JSON.stringify(path.basename(request.launch.entry.path))} as your user?`,
    detail: [
      ...launchDetails,
      '',
      'Arguments:',
      argumentsText,
      '',
      ...(request.cwd ? ['Working directory:', JSON.stringify(request.cwd), ''] : []),
      `Runtime adapter: ${request.cliAdapter}`,
      `Prompt transport: ${request.promptMode}`,
      `Output parser: ${request.outputMode}`,
      `Environment keys: ${
        request.environmentVariables.length
          ? request.environmentVariables.join(', ')
          : '(reviewed adapter defaults only)'
      }`,
      ...(request.environmentFingerprint
        ? [
            `Encrypted environment fingerprint: ${request.environmentFingerprint}`
          ]
        : []),
      '',
      ...promptDetails,
      '',
      ...(request.phase === 'invocation'
        ? ['This exact fingerprint may be reused until Ground exits.', '']
        : []),
      `Authorization fingerprint: ${request.fingerprint}`,
      '',
      'This process is not confined by Ground and can access anything available to your user account.'
    ].join('\n')
  }
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

async function confirmMcpStdioLaunch(
  request: Readonly<McpStdioLaunchTrustRequest>
): Promise<boolean> {
  const argumentsText = request.args.length
    ? request.args
        .map(
          (argument, index) =>
            `argv[${index}]: ${JSON.stringify(argument)}`
        )
        .join('\n')
    : '(none)'
  const contentIdentity = request.executableIdentity.sha256
    ? `Executable SHA-256: ${request.executableIdentity.sha256}`
    : [
        'Executable SHA-256: omitted because the executable exceeds the bounded hashing limit',
        `Executable identity: ${request.executableIdentity.fingerprint}`
      ].join('\n')
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Cancel', 'Authorize this launch'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Authorize local MCP server',
    message: 'Allow this local MCP server to run as your user?',
    detail: [
      `MCP server: ${request.serverName}`,
      '',
      'Resolved executable:',
      JSON.stringify(request.executable),
      contentIdentity,
      `Executable bytes: ${request.executableIdentity.size}`,
      '',
      'Arguments:',
      argumentsText,
      '',
      'Working directory:',
      JSON.stringify(request.cwd),
      '',
      `Environment keys: ${request.environmentKeys.join(', ') || '(none)'}`,
      `Invocation identity: ${request.invocationFingerprint}`,
      '',
      'This process and any helpers it starts are not sandboxed by Ground. They inherit the permissions of your user account.'
    ].join('\n')
  }
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response === 1
}

async function createWindow(): Promise<void> {
  const rendererFile = path.join(__dirname, '../renderer/index.html')
  const target = resolveRendererTarget(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
    rendererFile
  )
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#171713',
    title: 'Ground',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      ...(packagedSmokeConfig
        ? {
            additionalArguments: [
              `${PACKAGED_SMOKE_PRELOAD_ARGUMENT_PREFIX}${packagedSmokeConfig.token}`
            ]
          }
        : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  mainWindow = window
  const webContentsId = window.webContents.id
  trustedRendererUrls.set(webContentsId, target.value)

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event, url) => {
    if (!isExpectedRendererUrl(url, target.value)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  window.once('ready-to-show', () => {
    if (!packagedSmokeConfig) window.show()
  })
  window.on('closed', () => {
    trustedRendererUrls.delete(webContentsId)
    if (mainWindow === window) mainWindow = undefined
  })

  try {
    await window.loadURL(target.value)
  } catch (error) {
    trustedRendererUrls.delete(webContentsId)
    if (!window.isDestroyed()) window.destroy()
    if (mainWindow === window) mainWindow = undefined
    throw error
  }
}

function ensureMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return Promise.resolve()
  }
  if (windowCreation) return windowCreation
  windowCreation = createWindow().finally(() => {
    windowCreation = undefined
  })
  return windowCreation
}

function handleFatalStartup(error: unknown): void {
  if (fatalStartupHandled) return
  fatalStartupHandled = true
  if (packagedSmokeConfig) {
    void finishPackagedSmoke(
      {
        main: false,
        preload: false,
        rendererDocument: false
      },
      error
    )
    return
  }
  const category =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
      ? error.name
      : 'StartupError'
  dialog.showErrorBox(
    'Ground could not start',
    [
      'Ground could not initialize its local state or open the desktop window.',
      'No workspace files were deleted. Quit Ground, check that its application-data directory is readable and writable, then try again.',
      `Error category: ${category}`
    ].join('\n\n')
  )
  app.quit()
}

async function waitForPackagedSmokePreload(): Promise<void> {
  if (!packagedSmokePreloadReady) {
    throw new Error('Packaged preload smoke was not configured')
  }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      packagedSmokePreloadReady,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Packaged preload did not report readiness')),
          12_000
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function finishPackagedSmoke(
  checks: Record<string, boolean>,
  error?: unknown
): Promise<void> {
  if (!packagedSmokeConfig || packagedSmokeFinished) return
  packagedSmokeFinished = true
  ipcMain.removeListener(
    PACKAGED_SMOKE_PRELOAD_CHANNEL,
    handlePackagedSmokePreload
  )
  try {
    await writePackagedSmokeResult(packagedSmokeConfig, checks, error)
  } finally {
    if (error === undefined) app.quit()
    else app.exit(1)
  }
}

function registerIpc(
  store: StateStore,
  providers: ProviderService,
  runs: RunManager,
  workspaceGrants: WorkspaceGrantRegistry,
  cliTrust: CliTrustRegistry,
  terminals: TerminalService,
  mcp: McpManager,
  dataDirectory: string
): void {
  const terminalAccess = new TerminalAccessRegistry()
  const terminalSenderCleanupInstalled = new Set<number>()
  const gitServices = new Map<string, Promise<GitWorkspaceService>>()

  const requireTaskWorkspace = async (
    rawTaskId: unknown
  ): Promise<{ taskId: string; workspacePath: string }> => {
    const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
    const task = store.getTask(taskId)
    if (task.archivedAt) {
      throw new Error('Restore this task before using workspace actions')
    }
    if (!task.workspacePath) throw new Error('Choose a workspace first')
    return {
      taskId,
      workspacePath: await workspaceGrants.require(task.workspacePath)
    }
  }

  const worktreeRootFor = async (workspacePath: string): Promise<string> => {
    const workspaceId = createHash('sha256')
      .update(workspacePath)
      .digest('hex')
      .slice(0, 24)
    const root = path.join(dataDirectory, 'worktrees', workspaceId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    return root
  }

  const gitServiceFor = async (
    workspacePath: string
  ): Promise<{ service: GitWorkspaceService; worktreeRoot: string }> => {
    const worktreeRoot = await worktreeRootFor(workspacePath)
    let pending = gitServices.get(workspacePath)
    if (!pending) {
      pending = GitWorkspaceService.open({ workspacePath, worktreeRoot })
      gitServices.set(workspacePath, pending)
      void pending.catch(() => {
        if (gitServices.get(workspacePath) === pending) {
          gitServices.delete(workspacePath)
        }
      })
    }
    return { service: await pending, worktreeRoot }
  }

  const confirmGitMutation = async (
    event: Electron.IpcMainInvokeEvent,
    options: Electron.MessageBoxOptions
  ): Promise<boolean> => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options)
    return result.response === 1
  }

  const parseGitPaths = (rawPaths: unknown): string[] => {
    if (!Array.isArray(rawPaths)) throw new Error('Git paths must be an array')
    return rawPaths.map((candidate) => {
      if (typeof candidate !== 'string') {
        throw new Error('Every Git path must be a string')
      }
      return candidate
    })
  }

  const reviewValue = (value: string): string =>
    JSON.stringify(value).replace(
      /[\u202a-\u202e\u2066-\u2069]/gu,
      (character) =>
        `\\u{${character.codePointAt(0)?.toString(16).padStart(4, '0')}}`
    )

  handleTrusted(IPC.getSnapshot, async () => {
    // Capture the event boundary before queueing the snapshot. RunManager
    // queues each streaming state mutation before emitting its event, so the
    // settled snapshot includes every event up through this revision.
    const revision = runEventRevision
    const activeEvents = structuredClone(
      [...activeRunEvents.values()].flat()
    )
    const snapshot = await store.settledSnapshot()
    return {
      ...snapshot,
      runEventRevision: revision,
      activeRunEvents: activeEvents
    }
  })

  handleTrusted(IPC.createTask, async (_event, workspacePath?: unknown) => {
    const canonical =
      workspacePath === undefined
        ? undefined
        : await workspaceGrants.require(parseWorkspacePath(workspacePath))
    return store.createTask(canonical)
  })

  handleTrusted(IPC.forkTask, async (_event, rawTaskId: unknown) => {
    const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
    if (runs.isTaskActive(taskId)) {
      throw new Error('Stop this task before forking it')
    }
    return store.forkTask(taskId)
  })

  handleTrusted(
    IPC.setTaskArchived,
    async (_event, rawTaskId: unknown, rawArchived: unknown) => {
      const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
      if (typeof rawArchived !== 'boolean') {
        throw new Error('Archived state must be a boolean')
      }
      if (runs.isTaskActive(taskId)) {
        throw new Error(
          `Stop this task before ${rawArchived ? 'archiving' : 'unarchiving'} it`
        )
      }
      return store.setTaskArchived(taskId, rawArchived)
    }
  )

  handleTrusted(IPC.importTaskBundle, async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import a Ground task',
      buttonLabel: 'Import task',
      filters: [{ name: 'Ground task bundles', extensions: ['json'] }],
      properties: ['openFile']
    }
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return undefined
    const source = await readBoundedTextFile(
      filePath,
      GROUND_TASK_BUNDLE_LIMITS.serializedBytes
    )
    return store.importTask(importGroundTaskBundle(source))
  })

  handleTrusted(
    IPC.exportTask,
    async (event, rawTaskId: unknown, rawFormat: unknown) => {
      const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
      const format = parseTaskExportFormat(rawFormat)
      const initial = store.getTask(taskId)
      const options: Electron.SaveDialogOptions = {
        title:
          format === 'bundle'
            ? 'Export portable Ground task'
            : 'Export task transcript',
        buttonLabel: 'Export',
        defaultPath: safeTaskFilename(initial.title, format),
        filters: [
          format === 'bundle'
            ? { name: 'Ground task bundle', extensions: ['json'] }
            : { name: 'Markdown transcript', extensions: ['md'] }
        ]
      }
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
      const result = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return false

      const task = store.getTask(taskId)
      const provider = store.getProvider(task.providerId)
      const content =
        format === 'bundle'
          ? serializeGroundTaskBundle(task, provider)
          : exportGroundTaskMarkdown(task, provider)
      await writeTextFileAtomically(
        ensureTaskExportExtension(result.filePath, format),
        content,
        format === 'bundle'
          ? GROUND_TASK_BUNDLE_LIMITS.serializedBytes
          : GROUND_TASK_BUNDLE_LIMITS.serializedBytes * 2
      )
      return true
    }
  )

  handleTrusted(IPC.deleteTask, async (event, rawTaskId: unknown) => {
    const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
    const task = store.getTask(taskId)
    if (task.runStatus === 'running' || task.runStatus === 'awaiting-approval') {
      throw new Error('Stop this task before deleting it')
    }
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Cancel', 'Delete task'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Delete task',
      message: `Delete ${JSON.stringify(task.title)}?`,
      detail:
        'This removes the task and its local conversation history from Ground. Open terminals for this task will close; workspace files are not changed.'
    }
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options)
    if (result.response !== 1) return false
    await store.deleteTask(taskId)
    for (const sessionId of terminalAccess.removeTask(taskId)) {
      terminals.kill(sessionId)
    }
    return true
  })

  handleTrusted(IPC.selectTask, async (_event, taskId: unknown) => {
    await store.selectTask(parseNonEmptyId(taskId, 'Task identifier'))
  })

  handleTrusted(IPC.updateTask, async (_event, taskId: unknown, rawPatch: unknown) => {
    const id = parseNonEmptyId(taskId, 'Task identifier')
    const patch = parseTaskPatch(rawPatch)
    if (store.getTask(id).archivedAt) {
      throw new Error('Restore this task before changing it')
    }
    if (
      runs.isTaskActive(id) &&
      (patch.workspacePath !== undefined ||
        patch.providerId !== undefined ||
        patch.mode !== undefined)
    ) {
      throw new Error(
        'Stop the active run before changing its workspace, provider, or mode'
      )
    }
    if (patch.providerId) store.getProvider(patch.providerId)
    if (patch.workspacePath) {
      patch.workspacePath = await workspaceGrants.require(patch.workspacePath)
    }
    return store.mutateTask(id, (task) => Object.assign(task, patch))
  })

  handleTrusted(IPC.chooseWorkspace, async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a workspace',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return undefined
    return workspaceGrants.grant(result.filePaths[0])
  })

  handleTrusted(IPC.revealWorkspace, async (_event, rawPath: unknown) => {
    const workspacePath = await workspaceGrants.require(parseWorkspacePath(rawPath))
    const error = await shell.openPath(workspacePath)
    if (error) throw new Error(error)
  })

  handleTrusted(IPC.saveProvider, (_event, draft: unknown) => providers.save(draft))
  handleTrusted(IPC.deleteProvider, async (_event, providerId: unknown) => {
    await providers.delete(parseNonEmptyId(providerId, 'Provider identifier'))
  })
  handleTrusted(IPC.testProvider, (_event, draft: unknown) => providers.test(draft))
  handleTrusted(IPC.detectClis, () => providers.detectClis())

  handleTrusted(IPC.startRun, async (_event, input: unknown) => {
    const record =
      input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const taskId = parseNonEmptyId(record.taskId, 'Task identifier')
    const prompt = parsePrompt(record.prompt)
    const task = store.getTask(taskId)
    if (task.archivedAt) {
      throw new Error('Unarchive this task before starting a run')
    }
    const provider = store.getProvider(task.providerId)
    if (provider.kind === 'cli') await cliTrust.authorize(provider)
    return { runId: await runs.start(taskId, prompt) }
  })
  handleTrusted(IPC.stopRun, async (_event, taskId: unknown) => {
    const id = parseNonEmptyId(taskId, 'Task identifier')
    store.getTask(id)
    await runs.stopTask(id)
  })
  handleTrusted(
    IPC.resolveApproval,
    async (_event, runId: unknown, approvalId: unknown, approved: unknown) => {
      if (typeof approved !== 'boolean') throw new Error('Approval decision must be a boolean')
      await runs.resolveApproval(
        parseNonEmptyId(runId, 'Run identifier'),
        parseNonEmptyId(approvalId, 'Approval identifier'),
        approved
      )
    }
  )

  handleTrusted(IPC.listTerminals, (_event, rawTaskId: unknown) => {
    const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
    store.getTask(taskId)
    const active = new Map(terminals.listSessions().map((session) => [session.id, session]))
    terminalAccess.reconcile(new Set(active.keys()))
    return terminalAccess
      .sessionsForTask(taskId)
      .map((sessionId) => active.get(sessionId))
      .filter((session): session is NonNullable<typeof session> => Boolean(session))
      .map(
        (session): TerminalSessionInfo => ({
          ...session,
          taskId
        })
      )
  })

  handleTrusted(
    IPC.createTerminal,
    async (event, rawTaskId: unknown, rawDimensions: unknown) => {
      const { taskId, workspacePath } = await requireTaskWorkspace(rawTaskId)
      const record =
        rawDimensions && typeof rawDimensions === 'object'
          ? (rawDimensions as Record<string, unknown>)
          : {}
      const dimensions = {
        ...(typeof record.cols === 'number' ? { cols: record.cols } : {}),
        ...(typeof record.rows === 'number' ? { rows: record.rows } : {})
      }
      const confirmLaunch = async (
        details: Readonly<TerminalLaunchDetails>
      ): Promise<boolean> => {
        const argumentsText =
          details.args.length === 0
            ? '(none)'
            : JSON.stringify(details.args)
        const options: Electron.MessageBoxOptions = {
          type: 'warning',
          buttons: ['Cancel', 'Open terminal'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Open a system terminal?',
          message: 'Allow Ground to start this shell?',
          detail:
            'This process is not sandboxed and runs with your user account permissions.\n\n' +
            `Executable: ${JSON.stringify(details.executable)}\n` +
            `Arguments: ${argumentsText}\n` +
            `Working directory: ${JSON.stringify(details.cwd)}`
        }
        const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
        const result = owner
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options)
        return result.response === 1
      }
      try {
        const session = await terminals.createForWorkspace(
          workspacePath,
          dimensions,
          confirmLaunch
        )
        try {
          terminalAccess.register(session.id, taskId)
        } catch (error) {
          terminals.kill(session.id)
          throw error
        }
        return { ...session, taskId } satisfies TerminalSessionInfo
      } catch (error) {
        if (error instanceof TerminalLaunchCancelledError) return undefined
        throw error
      }
    }
  )

  handleTrusted(IPC.attachTerminal, (event, rawTaskId: unknown, rawSessionId: unknown) => {
    const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
    const sessionId = parseNonEmptyId(rawSessionId, 'Terminal session identifier')
    store.getTask(taskId)
    terminalAccess.assertOwnedByTask(sessionId, taskId)

    const sender = event.sender
    const senderId = sender.id
    const attachmentId = terminalAccess.attach(
      sessionId,
      taskId,
      senderId,
      () =>
        terminals.subscribe(
          sessionId,
          {
            onData: (terminalEvent) => {
              if (!sender.isDestroyed()) {
                sender.send(IPC.terminalEvent, terminalEvent)
              }
            },
            onExit: (terminalEvent) => {
              terminalAccess.remove(sessionId)
              if (!sender.isDestroyed()) {
                sender.send(IPC.terminalEvent, terminalEvent)
              }
            }
          },
          true
        )
    )
    if (!terminalSenderCleanupInstalled.has(senderId)) {
      terminalSenderCleanupInstalled.add(senderId)
      sender.once('destroyed', () => {
        terminalAccess.releaseSender(senderId)
        terminalSenderCleanupInstalled.delete(senderId)
      })
    }
    return { attachmentId }
  })

  handleTrusted(
    IPC.detachTerminal,
    (event, rawSessionId: unknown, rawAttachmentId: unknown) => {
      const sessionId = parseNonEmptyId(
        rawSessionId,
        'Terminal session identifier'
      )
      const attachmentId = parseNonEmptyId(
        rawAttachmentId,
        'Terminal attachment identifier'
      )
      terminalAccess.detach(sessionId, attachmentId, event.sender.id)
    }
  )

  handleTrusted(
    IPC.terminalInput,
    (
      event,
      rawSessionId: unknown,
      rawAttachmentId: unknown,
      rawData: unknown
    ) => {
      const sessionId = parseNonEmptyId(rawSessionId, 'Terminal session identifier')
      const attachmentId = parseNonEmptyId(
        rawAttachmentId,
        'Terminal attachment identifier'
      )
      terminalAccess.authorize(sessionId, attachmentId, event.sender.id)
      if (typeof rawData !== 'string') throw new Error('Terminal input must be text')
      terminals.sendInput(sessionId, rawData)
    }
  )

  handleTrusted(
    IPC.terminalResize,
    (
      event,
      rawSessionId: unknown,
      rawAttachmentId: unknown,
      rawDimensions: unknown
    ) => {
      const sessionId = parseNonEmptyId(rawSessionId, 'Terminal session identifier')
      const attachmentId = parseNonEmptyId(
        rawAttachmentId,
        'Terminal attachment identifier'
      )
      const { taskId } = terminalAccess.authorize(
        sessionId,
        attachmentId,
        event.sender.id
      )
      const record =
        rawDimensions && typeof rawDimensions === 'object'
          ? (rawDimensions as Record<string, unknown>)
          : {}
      if (typeof record.cols !== 'number' || typeof record.rows !== 'number') {
        throw new Error('Terminal dimensions are required')
      }
      return {
        ...terminals.resize(sessionId, {
          cols: record.cols,
          rows: record.rows
        }),
        taskId
      } satisfies TerminalSessionInfo
    }
  )

  handleTrusted(
    IPC.terminalClose,
    (event, rawSessionId: unknown, rawAttachmentId: unknown) => {
      const sessionId = parseNonEmptyId(
        rawSessionId,
        'Terminal session identifier'
      )
      const attachmentId = parseNonEmptyId(
        rawAttachmentId,
        'Terminal attachment identifier'
      )
      terminalAccess.authorize(sessionId, attachmentId, event.sender.id)
      terminals.kill(sessionId)
      terminalAccess.remove(sessionId)
    }
  )

  handleTrusted(IPC.getGitOverview, async (_event, rawTaskId: unknown) => {
    const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
    const task = store.getTask(taskId)
    if (!task.workspacePath) {
      return {
        isRepository: false,
        message: 'Choose a workspace to inspect Git.',
        commits: [],
        historyTruncated: false,
        worktrees: []
      } satisfies GitOverview
    }

    try {
      const workspacePath = await workspaceGrants.require(task.workspacePath)
      const { service } = await gitServiceFor(workspacePath)
      const [status, identity, unstagedDiff, stagedDiff, history, worktrees] =
        await Promise.all([
          service.status(),
          service.identity(),
          service.diff(),
          service.diff({ staged: true }),
          service.log().catch((error: unknown) => {
            if (
              error instanceof GitServiceError &&
              error.code === 'COMMAND_FAILED'
            ) {
              return { entries: [], truncated: false }
            }
            throw error
          }),
          service.listWorktrees()
        ])
      return {
        isRepository: true,
        status,
        identity,
        unstagedDiff,
        stagedDiff,
        commits: history.entries,
        historyTruncated: history.truncated,
        worktrees
      } satisfies GitOverview
    } catch (error) {
      if (
        error instanceof GitServiceError &&
        (error.code === 'NOT_A_REPOSITORY' || error.code === 'NOT_FOUND')
      ) {
        return {
          isRepository: false,
          message: error.message,
          commits: [],
          historyTruncated: false,
          worktrees: []
        } satisfies GitOverview
      }
      throw error
    }
  })

  handleTrusted(
    IPC.createGitWorktree,
    async (event, rawTaskId: unknown, rawInput: unknown) => {
      const { taskId, workspacePath } = await requireTaskWorkspace(rawTaskId)
      const sourceTask = store.getTask(taskId)
      const record =
        rawInput && typeof rawInput === 'object'
          ? (rawInput as Record<string, unknown>)
          : {}
      const branch = parseNonEmptyId(record.branch, 'Branch name')
      const startPoint =
        record.startPoint === undefined
          ? undefined
          : parseNonEmptyId(record.startPoint, 'Start point')
      const slug =
        branch
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/gu, '-')
          .replace(/^-+|-+$/gu, '')
          .slice(0, 48) || 'worktree'
      const relativePath = `${slug}-${randomUUID().slice(0, 8)}`
      const { service, worktreeRoot } = await gitServiceFor(workspacePath)
      const approved = await confirmGitMutation(event, {
        type: 'question',
        buttons: ['Cancel', 'Create worktree'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Create Git worktree',
        message: `Create branch ${reviewValue(branch)} in a managed worktree?`,
        detail: [
          `Branch: ${reviewValue(branch)}`,
          `Start point: ${reviewValue(startPoint ?? 'HEAD')}`,
          `Managed location: ${reviewValue(relativePath)}`,
          '',
          'Ground will create the branch and worktree using Git without invoking a shell.'
        ].join('\n')
      })
      if (!approved) return undefined
      await service.createWorktree({
        relativePath,
        branch,
        startPoint,
        createBranch: true
      })

      let taskCreated = false
      try {
        const createdWorkspace = await workspaceGrants.grant(
          path.join(worktreeRoot, relativePath)
        )
        const created = await store.createTask(createdWorkspace)
        taskCreated = true
        return store.mutateTask(created.id, (task) => {
          task.title = branch
          task.providerId = sourceTask.providerId
          task.mode = sourceTask.mode
        })
      } catch (error) {
        if (!taskCreated) {
          await service.removeWorktree({ relativePath }).catch(() => undefined)
        }
        throw error
      }
    }
  )

  handleTrusted(
    IPC.stageGitPaths,
    async (event, rawTaskId: unknown, rawPaths: unknown) => {
      const { workspacePath } = await requireTaskWorkspace(rawTaskId)
      const { service } = await gitServiceFor(workspacePath)
      const prepared = await service.preparePathMutation(
        'stage',
        parseGitPaths(rawPaths)
      )
      const approved = await confirmGitMutation(event, {
        type: 'question',
        buttons: ['Cancel', 'Stage selected paths'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Stage Git changes',
        message: `Stage ${prepared.paths.length} selected ${
          prepared.paths.length === 1 ? 'path' : 'paths'
        }?`,
        detail: [
          ...prepared.paths.map(
            (filePath, index) => `${index + 1}. ${reviewValue(filePath)}`
          ),
          '',
          'This updates only the Git index. Working-tree files are not overwritten. Ground disables repository hooks and executable content filters for this operation.'
        ].join('\n')
      })
      if (!approved) return false
      await service.executePreparedPathMutation(prepared)
      return true
    }
  )

  handleTrusted(
    IPC.unstageGitPaths,
    async (event, rawTaskId: unknown, rawPaths: unknown) => {
      const { workspacePath } = await requireTaskWorkspace(rawTaskId)
      const { service } = await gitServiceFor(workspacePath)
      const prepared = await service.preparePathMutation(
        'unstage',
        parseGitPaths(rawPaths)
      )
      const approved = await confirmGitMutation(event, {
        type: 'question',
        buttons: ['Cancel', 'Unstage selected paths'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Unstage Git changes',
        message: `Unstage ${prepared.paths.length} selected ${
          prepared.paths.length === 1 ? 'path' : 'paths'
        }?`,
        detail: [
          ...prepared.paths.map(
            (filePath, index) => `${index + 1}. ${reviewValue(filePath)}`
          ),
          '',
          'This updates only the Git index. Working-tree files and their current contents are preserved.'
        ].join('\n')
      })
      if (!approved) return false
      await service.executePreparedPathMutation(prepared)
      return true
    }
  )

  handleTrusted(
    IPC.commitGitChanges,
    async (event, rawTaskId: unknown, rawInput: unknown) => {
      const { workspacePath } = await requireTaskWorkspace(rawTaskId)
      const record =
        rawInput && typeof rawInput === 'object'
          ? (rawInput as Record<string, unknown>)
          : {}
      const message =
        typeof record.message === 'string' ? record.message : ''
      const authorName =
        typeof record.authorName === 'string' ? record.authorName : ''
      const authorEmail =
        typeof record.authorEmail === 'string' ? record.authorEmail : ''
      if (
        !message.trim() ||
        message.includes('\0') ||
        Buffer.byteLength(message, 'utf8') > 65_536 ||
        !authorName.trim() ||
        Buffer.byteLength(authorName, 'utf8') > 1_024 ||
        /[\u0000-\u001f\u007f-\u009f<>]/u.test(authorName.trim()) ||
        !authorEmail.trim() ||
        !authorEmail.includes('@') ||
        Buffer.byteLength(authorEmail, 'utf8') > 1_024 ||
        /[\u0000-\u0020\u007f-\u009f<>]/u.test(authorEmail.trim())
      ) {
        throw new Error('Commit details exceed Ground’s safety limits')
      }

      const { service } = await gitServiceFor(workspacePath)
      const prepared = await service.prepareCommit()
      const approved = await confirmGitMutation(event, {
        type: 'question',
        buttons: ['Cancel', 'Create commit'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Create Git commit',
        message: `Commit ${prepared.stagedPaths.length} staged ${
          prepared.stagedPaths.length === 1 ? 'path' : 'paths'
        }?`,
        detail: [
          `Branch: ${
            prepared.detached
              ? 'detached HEAD'
              : reviewValue(prepared.branch ?? '(unborn branch)')
          }`,
          `Expected parent: ${prepared.expectedHeadOid ?? '(initial commit)'}`,
          `Exact staged tree: ${prepared.treeOid}`,
          `Author name: ${reviewValue(authorName.trim())}`,
          `Author email: ${reviewValue(authorEmail.trim())}`,
          '',
          'Commit message:',
          reviewValue(message),
          '',
          'Staged paths:',
          ...prepared.stagedPaths.map(
            (filePath, index) => `${index + 1}. ${reviewValue(filePath)}`
          ),
          '',
          'Ground commits the exact staged tree shown above. Concurrent working-tree and index edits are preserved. Hooks and signing are disabled.'
        ].join('\n')
      })
      if (!approved) return undefined
      return service.executePreparedCommit(prepared, {
        message,
        authorName,
        authorEmail
      })
    }
  )

  handleTrusted(
    IPC.removeGitWorktree,
    async (event, rawTaskId: unknown, rawRelativePath: unknown) => {
      const { workspacePath } = await requireTaskWorkspace(rawTaskId)
      const relativePath = parseNonEmptyId(
        rawRelativePath,
        'Managed worktree path'
      )
      const { service, worktreeRoot } = await gitServiceFor(workspacePath)
      const worktrees = await service.listWorktrees()
      const target = worktrees.find(
        (candidate) =>
          !candidate.isMain && candidate.relativePath === relativePath
      )
      if (!target) throw new Error('Managed worktree was not found')
      if (target.locked) {
        throw new Error('Unlock this worktree in Git before removing it')
      }

      const managedWorkspace = path.join(worktreeRoot, relativePath)
      const linkedTasks = store
        .snapshot()
        .tasks.filter((task) => task.workspacePath === managedWorkspace)
      if (
        linkedTasks.some(
          (task) =>
            task.runStatus === 'running' ||
            task.runStatus === 'awaiting-approval'
        )
      ) {
        throw new Error('Stop linked tasks before removing this worktree')
      }
      const approved = await confirmGitMutation(event, {
        type: 'warning',
        buttons: ['Cancel', 'Remove clean worktree'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Remove managed worktree',
        message: `Remove worktree ${reviewValue(relativePath)}?`,
        detail: [
          `Branch: ${reviewValue(target.branch ?? 'detached HEAD')}`,
          `HEAD: ${target.head}`,
          `Managed location: ${reviewValue(relativePath)}`,
          '',
          'Ground removes only clean, registered worktrees under its managed root. If files changed while this confirmation was open, Git will refuse the removal.',
          linkedTasks.length
            ? `${linkedTasks.length} linked Ground ${
                linkedTasks.length === 1 ? 'task keeps its history' : 'tasks keep their history'
              } but will be detached from the removed workspace. Open terminals for those tasks will close.`
            : 'No Ground tasks are linked to this worktree.'
        ].join('\n')
      })
      if (!approved) return undefined

      const currentLinkedTasks = store
        .snapshot()
        .tasks.filter((task) => task.workspacePath === managedWorkspace)
      if (
        currentLinkedTasks.some(
          (task) =>
            task.runStatus === 'running' ||
            task.runStatus === 'awaiting-approval'
        )
      ) {
        throw new Error('A linked task started running before removal')
      }
      await service.removeWorktree({ relativePath })
      for (const task of currentLinkedTasks) {
        for (const sessionId of terminalAccess.removeTask(task.id)) {
          terminals.kill(sessionId)
        }
      }
      workspaceGrants.revoke(managedWorkspace)
      gitServices.delete(managedWorkspace)
      for (const task of currentLinkedTasks) {
        await store.mutateTask(task.id, (record) => {
          delete record.workspacePath
        })
      }
      return currentLinkedTasks.map((task) => task.id)
    }
  )

  handleTrusted(IPC.saveMcpServer, (_event, draft: unknown) => mcp.save(draft))
  handleTrusted(IPC.deleteMcpServer, async (_event, rawServerId: unknown) => {
    await mcp.delete(parseNonEmptyId(rawServerId, 'MCP server identifier'))
  })
  handleTrusted(IPC.getMcpServerStatuses, () => mcp.getStatuses())
  handleTrusted(IPC.connectMcpServer, (_event, rawServerId: unknown) =>
    mcp.reconnect(parseNonEmptyId(rawServerId, 'MCP server identifier'))
  )
  handleTrusted(
    IPC.trustMcpTools,
    (_event, rawServerId: unknown, expectedFingerprints: unknown) =>
      mcp.trustTools(
        parseNonEmptyId(rawServerId, 'MCP server identifier'),
        expectedFingerprints
      )
  )
}

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!app.isReady() || !appInitialized) return
    void ensureMainWindow().catch(handleFatalStartup)
  })

  app.whenReady().then(async () => {
    const dataDirectory = app.getPath('userData')
    // The smoke profile is intentionally empty and must never ingest a real
    // legacy task snapshot or credential vault from the host account.
    if (shouldMigrateLegacyData(packagedSmokeConfig)) {
      await migrateLegacyData(dataDirectory, app.getPath('appData'))
    }
    const store = new StateStore(path.join(dataDirectory, 'ground-state.json'))
    const vault = new SecretVault(path.join(dataDirectory, 'ground-secrets.json'))
    await Promise.all([store.load(), vault.load()])
    const workspaceGrants = new WorkspaceGrantRegistry()
    await workspaceGrants.restore(store.snapshot().tasks.map((task) => task.workspacePath))
    const cliTrust = new CliTrustRegistry(confirmCliTrust)
    mcpManager = new McpManager(store, undefined, {
      confirmStdioLaunch: confirmMcpStdioLaunch
    })
    const providerOperations = new ProviderOperationGate()
    const runs = new RunManager(
      store,
      vault,
      emitRunEvent,
      undefined,
      mcpManager,
      (request) => cliTrust.authorizeInvocation(request),
      providerOperations
    )
    runManager = runs
    const providers = new ProviderService(
      store,
      vault,
      cliTrust,
      (providerId) => runs.isProviderActive(providerId),
      providerOperations
    )
    terminalService = new TerminalService({
      authorizeWorkspace: (candidate) => workspaceGrants.require(candidate)
    })
    registerIpc(
      store,
      providers,
      runs,
      workspaceGrants,
      cliTrust,
      terminalService,
      mcpManager,
      dataDirectory
    )
    appInitialized = true
    await ensureMainWindow()
    if (packagedSmokeConfig) {
      const checks: Record<string, boolean> = {
        main: true,
        rendererDocument: true
      }
      await waitForPackagedSmokePreload()
      checks.preload = true
      if (packagedSmokeConfig.scope === 'native') {
        Object.assign(
          checks,
          await runPackagedNativeSmoke(packagedSmokeConfig)
        )
      }
      await finishPackagedSmoke(checks)
      return
    }
    void mcpManager.initialize().catch(() => undefined)

    app.on('activate', () => {
      void ensureMainWindow().catch(handleFatalStartup)
    })
  }).catch(handleFatalStartup)

  app.on('before-quit', (event) => {
    if (quittingAfterCleanup) return
    event.preventDefault()
    if (quitCleanup) return
    terminalService?.dispose()
    quitCleanup = (async () => {
      await Promise.allSettled([
        runManager?.stopAll(),
        mcpManager?.close()
      ])
    })()
      .catch(() => undefined)
      .finally(() => {
        quittingAfterCleanup = true
        app.quit()
      })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
