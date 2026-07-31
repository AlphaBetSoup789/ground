import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
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
  DesktopRunEventEnvelope,
  GitOverview,
  RunEvent,
  Task,
  TaskExportFormat,
  TerminalSessionInfo
} from '../shared/types'
import { ApplicationMutationGate } from './application-mutation-gate'
import {
  assistantOutputClipboardIpcOperation,
  AssistantOutputClipboardService
} from './assistant-output-clipboard'
import {
  GitServiceError,
  GitWorkspaceService,
  verifyGitExecutableVersion
} from './git-service'
import {
  absoluteGitSearchPathEntries,
  GitExecutableTrustService
} from './git-executable-discovery'
import {
  GitExecutableCoordinator,
  GitExecutableSelectionRequiredError
} from './git-executable-coordinator'
import { GitExecutablePreferenceStore } from './git-executable-preference'
import { gitExecutableConfirmationOptions } from './git-executable-presentation'
import {
  gitPathRevertConfirmationOptions,
  gitRecoveryUndoConfirmationOptions,
  projectGitRecoveries,
  projectGitRecovery
} from './git-recovery-presentation'
import { McpManager } from './mcp-manager'
import type { McpStdioLaunchTrustRequest } from './mcp-service'
import { ProviderService } from './provider-service'
import { validateCliExecutablePath } from './cli-executable-discovery'
import { ProviderOperationGate } from './provider-operation-gate'
import {
  createBuiltinAdapterRegistry,
  createRegisteredAgentRuntimeFactory,
  createRegisteredModelRuntimeFactory,
  resolveBuiltinAgentRuntimeBinding,
  resolveBuiltinModelAdapterBinding,
  RunManager
} from './run-manager'
import { SecretVault } from './secrets'
import { StateStore } from './store'
import {
  findCredentialRecoveryNotice,
  reconcileCredentialVault
} from './credential-recovery'
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
  ensureLocalStateSnapshotExtension,
  exportSelectedLocalStateSnapshot,
  localStateSnapshotFilename,
  restoreSelectedLocalStateSnapshot,
  stateRestoreConfirmationOptions
} from './local-state-backup'
import {
  parseNonEmptyId,
  parseLocalStateSnapshotId,
  parsePrompt,
  parseTaskPatch,
  parseWorkspaceGrantId
} from './validation'
import { migrateLegacyData } from './migration'
import {
  agentApprovalDialogOptions,
  agentApprovalFingerprint
} from './native-agent-approval'
import {
  projectDesktopTaskOperation,
  toDesktopRunEventEnvelope,
  toDesktopSnapshot
} from './desktop-projection'
import {
  preparePackagedSmokeDirectory,
  resolvePackagedSmokeConfig,
  runPackagedNativeSmoke,
  shouldMigrateLegacyData,
  writePackagedSmokeResult
} from './packaged-smoke'
import {
  PackagedCliSmokeTrustAuthority,
  runPackagedCliSmoke
} from './packaged-cli-smoke'
import { runPackagedProviderSmoke } from './packaged-provider-smoke'
import { runPackagedProviderFailureSmoke } from './packaged-provider-failure-smoke'
import {
  CliTrustRegistry,
  type CliTrustRequest,
  isExpectedRendererUrl,
  revealWorkspacePath,
  resolveRendererTarget,
  WorkspaceGrantRegistry
} from './trust-boundary'
import { resolveWindowChromeOptions } from './window-chrome'
import { WorkspaceLifecycleGate } from './workspace-lifecycle-gate'

let mainWindow: BrowserWindow | undefined
let runManager: RunManager | undefined
let terminalService: TerminalService | undefined
let mcpManager: McpManager | undefined
let quitCleanup: Promise<void> | undefined
let quittingAfterCleanup = false
let windowCreation: Promise<void> | undefined
let fatalStartupHandled = false
let appInitialized = false
const applicationMutationGate = new ApplicationMutationGate()
const stateRestoreGateBypassChannels = new Set<string>([
  IPC.getSnapshot,
  IPC.restoreStateSnapshot
])
const trustedRendererUrls = new Map<number, string>()
let runEventRevision = 0
const activeRunEvents = new Map<string, DesktopRunEventEnvelope[]>()
const packagedSmokeRunEvents: RunEvent[] = []
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
  if (packagedSmokeConfig) {
    packagedSmokeRunEvents.push(structuredClone(event))
  }
  const envelope = toDesktopRunEventEnvelope({
    revision: (runEventRevision += 1),
    event
  })
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

type TrustedTaskIpcHandler = (
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
) => Task | undefined | PromiseLike<Task | undefined>

function handleTrusted(channel: string, handler: TrustedIpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event)
    if (stateRestoreGateBypassChannels.has(channel)) {
      return handler(event, ...args)
    }
    return applicationMutationGate.run(async () =>
      handler(event, ...args)
    )
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
      `Runtime adapter ID: ${request.runtimeAdapterId}`,
      `CLI dialect: ${request.cliAdapter}`,
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
    ...resolveWindowChromeOptions(process.platform),
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
  const assistantOutputClipboard = new AssistantOutputClipboardService(
    store,
    clipboard
  )
  const assistantOutputClipboardIpc =
    assistantOutputClipboardIpcOperation(assistantOutputClipboard)
  const terminalAccess = new TerminalAccessRegistry()
  const terminalSenderCleanupInstalled = new Set<number>()
  const gitServices = new Map<string, Promise<GitWorkspaceService>>()
  const nativeApprovalPrompts = new Set<string>()
  let cliExecutablePickerOpen = false
  let gitExecutablePickerOpen = false
  const workspaceLifecycle = new WorkspaceLifecycleGate()
  const handleWorkspaceLifecycle = (
    channel: string,
    handler: TrustedIpcHandler
  ): void => {
    handleTrusted(channel, (event, ...args) =>
      workspaceLifecycle.run(() => handler(event, ...args))
    )
  }
  const handleTaskResult = (
    channel: string,
    handler: TrustedTaskIpcHandler
  ): void => {
    handleTrusted(
      channel,
      projectDesktopTaskOperation(workspaceGrants, handler)
    )
  }
  const handleWorkspaceTaskResult = (
    channel: string,
    handler: TrustedTaskIpcHandler
  ): void => {
    const projected = projectDesktopTaskOperation(workspaceGrants, handler)
    handleTrusted(channel, (event, ...args) =>
      workspaceLifecycle.run(() => projected(event, ...args))
    )
  }

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
      workspacePath: await workspaceGrants.requireStoredPath(
        task.workspacePath
      )
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

  const gitExecutableTrust = new GitExecutableTrustService({
    searchPathEntries: absoluteGitSearchPathEntries(process.env.PATH),
    workspaceRoots: async () => {
      const roots = await Promise.all(
        store
          .snapshot()
          .tasks.map((task) =>
            task.workspacePath
              ? workspaceGrants
                  .requireStoredPath(task.workspacePath)
                  .catch(() => undefined)
              : Promise.resolve(undefined)
          )
      )
      return [
        ...new Set(
          roots.filter((candidate): candidate is string => Boolean(candidate))
        )
      ]
    }
  })
  const gitExecutableCoordinator = new GitExecutableCoordinator(
    gitExecutableTrust,
    new GitExecutablePreferenceStore(path.resolve(dataDirectory))
  )
  const verifyTrustedGit = async (candidate: string): Promise<void> => {
    await verifyGitExecutableVersion(candidate, { cwd: dataDirectory })
  }

  const gitServiceFor = async (
    workspacePath: string
  ): Promise<{ service: GitWorkspaceService; worktreeRoot: string }> => {
    const worktreeRoot = await worktreeRootFor(workspacePath)
    let pending = gitServices.get(workspacePath)
    if (!pending) {
      let created: Promise<GitWorkspaceService>
      created = (async () => {
        const trustedGit =
          await gitExecutableCoordinator.resolve(verifyTrustedGit)
        return GitWorkspaceService.open({
          workspacePath,
          worktreeRoot,
          gitExecutable: trustedGit.path,
          revalidateGitExecutable: async () => {
            try {
              return (
                await gitExecutableCoordinator.revalidate(
                  trustedGit.binding
                )
              ).path
            } catch (error) {
              if (gitServices.get(workspacePath) === created) {
                gitServices.delete(workspacePath)
              }
              throw error
            }
          }
        })
      })()
      pending = created
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

  const tasksUsingWorkspace = (storedPath: string) => {
    const targetGrant = workspaceGrants.describeStoredPath(storedPath)
    return store.snapshot().tasks.filter((task) => {
      if (task.workspacePath === storedPath) return true
      if (!targetGrant || !task.workspacePath) return false
      return (
        workspaceGrants.describeStoredPath(task.workspacePath)?.id ===
        targetGrant.id
      )
    })
  }

  interface GitTaskWorkspaceBinding {
    taskId: string
    storedWorkspacePath: string
    workspacePath: string
  }

  const requireIdleGitTaskWorkspace = async (
    rawTaskId: unknown,
    expected?: GitTaskWorkspaceBinding
  ): Promise<GitTaskWorkspaceBinding> => {
    const { taskId, workspacePath } = await requireTaskWorkspace(rawTaskId)
    const task = store.getTask(taskId)
    if (!task.workspacePath) throw new Error('Choose a workspace first')
    const binding = {
      taskId,
      storedWorkspacePath: task.workspacePath,
      workspacePath
    }
    if (
      expected &&
      (binding.taskId !== expected.taskId ||
        binding.storedWorkspacePath !== expected.storedWorkspacePath ||
        binding.workspacePath !== expected.workspacePath)
    ) {
      throw new Error('The task workspace changed during Git review')
    }
    if (
      tasksUsingWorkspace(task.workspacePath).some(
        (candidate) =>
          candidate.runStatus === 'running' ||
          candidate.runStatus === 'awaiting-approval' ||
          runs.isTaskActive(candidate.id)
      )
    ) {
      throw new Error(
        'Stop active runs in this workspace before restoring Git files'
      )
    }
    terminalAccess.reconcile(
      new Set(terminals.listSessions().map((session) => session.id))
    )
    if (
      tasksUsingWorkspace(task.workspacePath).some(
        (candidate) =>
          terminalAccess.sessionsForTask(candidate.id).length > 0
      )
    ) {
      throw new Error(
        'Close Ground terminals in this workspace before restoring Git files'
      )
    }
    return binding
  }

  const revokeWorkspaceIfUnused = async (
    storedPath: string | undefined
  ): Promise<void> => {
    if (!storedPath) return
    const grant = workspaceGrants.describeStoredPath(storedPath)
    if (!grant) return
    if (tasksUsingWorkspace(storedPath).length > 0) return
    const canonical = await workspaceGrants
      .require(grant.id)
      .catch(() => undefined)
    workspaceGrants.revoke(grant.id)
    gitServices.delete(storedPath)
    if (canonical) gitServices.delete(canonical)
  }

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
      ...toDesktopSnapshot(snapshot, workspaceGrants),
      runEventRevision: revision,
      activeRunEvents: activeEvents
    }
  })

  handleTrusted(
    assistantOutputClipboardIpc.channel,
    (_event, rawInput: unknown) =>
      assistantOutputClipboardIpc.invoke(rawInput)
  )

  handleTrusted(IPC.listStateSnapshots, () =>
    store.listLocalStateSnapshots()
  )

  handleTrusted(
    IPC.exportStateSnapshot,
    async (event, rawSnapshotId: unknown) => {
      const snapshotId = parseLocalStateSnapshotId(rawSnapshotId)
      return exportSelectedLocalStateSnapshot(
        store,
        snapshotId,
        async () => {
          const options: Electron.SaveDialogOptions = {
            title: 'Export a Ground local state snapshot',
            buttonLabel: 'Export snapshot',
            defaultPath: localStateSnapshotFilename(),
            filters: [
              {
                name: 'Ground state snapshot',
                extensions: ['json']
              }
            ]
          }
          const owner =
            BrowserWindow.fromWebContents(event.sender) ?? mainWindow
          const result = owner
            ? await dialog.showSaveDialog(owner, options)
            : await dialog.showSaveDialog(options)
          if (result.canceled || !result.filePath) return undefined
          return ensureLocalStateSnapshotExtension(result.filePath)
        }
      )
    }
  )

  handleTrusted(
    IPC.restoreStateSnapshot,
    async (event, rawSnapshotId: unknown) => {
      const snapshotId = parseLocalStateSnapshotId(rawSnapshotId)
      return restoreSelectedLocalStateSnapshot(
        store,
        runs,
        applicationMutationGate,
        snapshotId,
        async (snapshot) => {
          const options = stateRestoreConfirmationOptions(snapshot)
          const owner =
            BrowserWindow.fromWebContents(event.sender) ?? mainWindow
          const result = owner
            ? await dialog.showMessageBox(owner, options)
            : await dialog.showMessageBox(options)
          return result.response === 1
        },
        async () => {
          await mcpManager?.close()
        },
        () => {
          try {
            app.relaunch()
          } finally {
            app.quit()
          }
        }
      )
    }
  )

  handleWorkspaceTaskResult(
    IPC.createTask,
    async (_event, workspaceGrantId?: unknown) => {
      const canonical =
        workspaceGrantId === undefined
          ? undefined
          : await workspaceGrants.require(
              parseWorkspaceGrantId(workspaceGrantId)
            )
      return store.createTask(canonical)
    }
  )

  handleWorkspaceTaskResult(IPC.forkTask, async (_event, rawTaskId: unknown) => {
    const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
    if (runs.isTaskActive(taskId)) {
      throw new Error('Stop this task before forking it')
    }
    return store.forkTask(taskId)
  })

  handleWorkspaceTaskResult(
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

  handleTaskResult(IPC.importTaskBundle, async (event) => {
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

  handleWorkspaceLifecycle(
    IPC.deleteTask,
    async (event, rawTaskId: unknown) => {
      const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
      const task = store.getTask(taskId)
      if (
        task.runStatus === 'running' ||
        task.runStatus === 'awaiting-approval'
      ) {
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
      await revokeWorkspaceIfUnused(task.workspacePath)
      return true
    }
  )

  handleTrusted(IPC.selectTask, async (_event, taskId: unknown) => {
    await store.selectTask(parseNonEmptyId(taskId, 'Task identifier'))
  })

  handleWorkspaceTaskResult(
    IPC.updateTask,
    async (event, taskId: unknown, rawPatch: unknown) => {
      const id = parseNonEmptyId(taskId, 'Task identifier')
      const patch = parseTaskPatch(rawPatch)
      const currentTask = store.getTask(id)
      if (currentTask.archivedAt) {
        throw new Error('Restore this task before changing it')
      }
      if (
        runs.isTaskActive(id) &&
        (patch.workspaceGrantId !== undefined ||
          patch.providerId !== undefined ||
          patch.mode !== undefined ||
          patch.includeImportedHistory !== undefined)
      ) {
        throw new Error(
          'Stop the active run before changing its workspace, provider, mode, or imported-history context'
        )
      }
      if (patch.providerId) store.getProvider(patch.providerId)
      const workspacePath =
        patch.workspaceGrantId === undefined
          ? undefined
          : await workspaceGrants.require(patch.workspaceGrantId)
      if (
        patch.includeImportedHistory === true &&
        currentTask.includeImportedHistory !== true
      ) {
        const provider = store.getProvider(
          patch.providerId ?? currentTask.providerId
        )
        const options: Electron.MessageBoxOptions = {
          type: 'warning',
          buttons: ['Keep excluded', 'Include imported history'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Include untrusted imported history?',
          message: 'Allow imported content into future model context?',
          detail: [
            `Task: ${reviewValue(currentTask.title)}`,
            `Current provider: ${reviewValue(provider.name)}`,
            '',
            'Imported transcripts are untrusted. They can contain prompt injection, private text, or misleading tool results.',
            'If this task uses a Ground-managed model API, its imported history will be sent to that configured provider on the next run.',
            'Imported history never restores workspace, credential, executable, session, or approval authority.',
            '',
            'You can exclude it again before a later run.'
          ].join('\n')
        }
        const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
        const result = owner
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options)
        if (result.response !== 1) {
          return currentTask
        }
      }
      const { workspaceGrantId: _workspaceGrantId, ...taskPatch } = patch
      const updated = await store.mutateTask(id, (task) => {
        Object.assign(task, taskPatch)
        if (workspacePath !== undefined) task.workspacePath = workspacePath
      })
      if (
        workspacePath !== undefined &&
        currentTask.workspacePath !== workspacePath
      ) {
        for (const sessionId of terminalAccess.removeTask(id)) {
          terminals.kill(sessionId)
        }
        await revokeWorkspaceIfUnused(currentTask.workspacePath)
      }
      return updated
    }
  )

  handleWorkspaceLifecycle(IPC.chooseWorkspace, async () => {
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

  handleWorkspaceLifecycle(
    IPC.revealWorkspace,
    async (_event, rawGrantId: unknown) => {
      const workspacePath = await workspaceGrants.require(
        parseWorkspaceGrantId(rawGrantId)
      )
      await revealWorkspacePath(workspacePath, (candidate) =>
        shell.openPath(candidate)
      )
    }
  )

  handleTrusted(IPC.saveProvider, (_event, draft: unknown) => providers.save(draft))
  handleTrusted(IPC.deleteProvider, async (_event, providerId: unknown) => {
    await providers.delete(parseNonEmptyId(providerId, 'Provider identifier'))
  })
  handleTrusted(IPC.testProvider, (_event, draft: unknown) => providers.test(draft))
  handleTrusted(IPC.detectClis, () => providers.detectClis())
  handleTrusted(IPC.chooseCliExecutable, async (event) => {
    if (cliExecutablePickerOpen) {
      throw new Error('The executable picker is already open')
    }
    cliExecutablePickerOpen = true
    try {
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a CLI executable',
        message:
          'Choose the direct executable or recognized Node package command shim Ground should review.',
        properties: ['openFile'],
        ...(process.platform === 'win32'
          ? {
              filters: [
                {
                  name: 'Executables and Node command shims',
                  extensions: ['exe', 'com', 'cmd']
                },
                { name: 'All files', extensions: ['*'] }
              ]
            }
          : {})
      }
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      const selected = result.filePaths[0]
      if (result.canceled || !selected) return undefined
      return validateCliExecutablePath(selected, {
        workspaceRoots: store
          .snapshot()
          .tasks.map((task) => task.workspacePath)
          .filter((candidate): candidate is string => Boolean(candidate))
      })
    } finally {
      cliExecutablePickerOpen = false
    }
  })

  handleWorkspaceLifecycle(IPC.chooseGitExecutable, async (event) => {
    if (gitExecutablePickerOpen) {
      throw new Error('The Git executable picker is already open')
    }
    gitExecutablePickerOpen = true
    try {
      const options: Electron.OpenDialogOptions = {
        title: 'Choose Git executable',
        message:
          'Choose the direct Git executable Ground should fingerprint and review.',
        properties: ['openFile'],
        ...(process.platform === 'win32'
          ? {
              filters: [
                { name: 'Git executable', extensions: ['exe'] },
                { name: 'All files', extensions: ['*'] }
              ]
            }
          : {})
      }
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      const selected = result.filePaths[0]
      if (result.canceled || !selected) return false
      const binding =
        await gitExecutableCoordinator.preparePicked(selected)
      const approved = await confirmGitMutation(
        event,
        gitExecutableConfirmationOptions(binding)
      )
      if (!approved) return false
      await gitExecutableCoordinator.commitPicked(
        binding,
        verifyTrustedGit
      )
      gitServices.clear()
      return true
    } finally {
      gitExecutablePickerOpen = false
    }
  })

  handleWorkspaceLifecycle(IPC.startRun, async (_event, input: unknown) => {
    const record =
      input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const taskId = parseNonEmptyId(record.taskId, 'Task identifier')
    const prompt = parsePrompt(record.prompt)
    return { runId: await runs.start(taskId, prompt) }
  })
  handleTrusted(IPC.stopRun, async (_event, taskId: unknown) => {
    const id = parseNonEmptyId(taskId, 'Task identifier')
    store.getTask(id)
    await runs.stopTask(id)
  })
  handleTrusted(
    IPC.resolveApproval,
    async (event, runId: unknown, approvalId: unknown, approved: unknown) => {
      if (typeof approved !== 'boolean') throw new Error('Approval decision must be a boolean')
      const parsedRunId = parseNonEmptyId(runId, 'Run identifier')
      const parsedApprovalId = parseNonEmptyId(
        approvalId,
        'Approval identifier'
      )
      if (!approved) {
        await runs.resolveApproval(parsedRunId, parsedApprovalId, false)
        return
      }

      const presenceKey = `${parsedRunId}\u0000${parsedApprovalId}`
      if (nativeApprovalPrompts.has(presenceKey)) {
        throw new Error('Native confirmation is already open for this action')
      }
      const pending = runs.getPendingApproval(parsedRunId, parsedApprovalId)
      nativeApprovalPrompts.add(presenceKey)
      try {
        const approvalSha256 = agentApprovalFingerprint(pending)
        const options = agentApprovalDialogOptions(pending)
        const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
        const result = owner
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options)
        await runs.resolveApproval(
          parsedRunId,
          parsedApprovalId,
          result.response === 1,
          result.response === 1 ? approvalSha256 : undefined
        )
      } catch (error) {
        await runs
          .resolveApproval(parsedRunId, parsedApprovalId, false)
          .catch(() => undefined)
        throw error
      } finally {
        nativeApprovalPrompts.delete(presenceKey)
      }
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

  handleWorkspaceLifecycle(
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

  handleWorkspaceLifecycle(
    IPC.attachTerminal,
    (event, rawTaskId: unknown, rawSessionId: unknown) => {
      const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
      const sessionId = parseNonEmptyId(
        rawSessionId,
        'Terminal session identifier'
      )
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
    }
  )

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

  handleWorkspaceLifecycle(IPC.getGitOverview, async (_event, rawTaskId: unknown) => {
    const taskId = parseNonEmptyId(rawTaskId, 'Task identifier')
    const task = store.getTask(taskId)
    if (!task.workspacePath) {
      return {
        isRepository: false,
        message: 'Choose a workspace to inspect Git.',
        commits: [],
        historyTruncated: false,
        worktrees: [],
        recoveries: [],
        recoveriesTruncated: false
      } satisfies GitOverview
    }

    try {
      const workspacePath = await workspaceGrants.requireStoredPath(
        task.workspacePath
      )
      const { service } = await gitServiceFor(workspacePath)
      const [
        status,
        identity,
        unstagedDiff,
        stagedDiff,
        history,
        worktrees,
        serviceRecoveries
      ] =
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
          service.listWorktrees(),
          service.listRecoveries()
        ])
      const recoveryProjection = projectGitRecoveries(serviceRecoveries)
      return {
        isRepository: true,
        status,
        identity,
        unstagedDiff,
        stagedDiff,
        commits: history.entries,
        historyTruncated: history.truncated,
        worktrees,
        ...recoveryProjection
      } satisfies GitOverview
    } catch (error) {
      if (error instanceof GitExecutableSelectionRequiredError) {
        return {
          isRepository: false,
          requiresGitExecutable: true,
          message: error.message,
          commits: [],
          historyTruncated: false,
          worktrees: [],
          recoveries: [],
          recoveriesTruncated: false
        } satisfies GitOverview
      }
      if (
        error instanceof GitServiceError &&
        (error.code === 'NOT_A_REPOSITORY' ||
          error.code === 'NOT_FOUND' ||
          error.code === 'INVALID_ARGUMENT' ||
          error.code === 'UNSAFE_CONFIGURATION')
      ) {
        return {
          isRepository: false,
          ...(error.code === 'NOT_A_REPOSITORY'
            ? {}
            : { requiresGitExecutable: true }),
          message: error.message,
          commits: [],
          historyTruncated: false,
          worktrees: [],
          recoveries: [],
          recoveriesTruncated: false
        } satisfies GitOverview
      }
      throw error
    }
  })

  handleWorkspaceTaskResult(
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
      let createdGrantId: string | undefined
      try {
        const createdGrant = await workspaceGrants.grant(
          path.join(worktreeRoot, relativePath)
        )
        createdGrantId = createdGrant.id
        const createdWorkspace = await workspaceGrants.require(createdGrant.id)
        const created = await store.createTask(createdWorkspace)
        taskCreated = true
        const updated = await store.mutateTask(created.id, (task) => {
          task.title = branch
          task.providerId = sourceTask.providerId
          task.mode = sourceTask.mode
        })
        return updated
      } catch (error) {
        if (!taskCreated) {
          if (createdGrantId) workspaceGrants.revoke(createdGrantId)
          await service.removeWorktree({ relativePath }).catch(() => undefined)
        }
        throw error
      }
    }
  )

  handleWorkspaceLifecycle(
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

  handleWorkspaceLifecycle(
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

  handleWorkspaceLifecycle(
    IPC.revertGitPaths,
    async (event, rawTaskId: unknown, rawPaths: unknown) => {
      const binding = await requireIdleGitTaskWorkspace(rawTaskId)
      const { service } = await gitServiceFor(binding.workspacePath)
      const prepared = await service.preparePathRevert(
        parseGitPaths(rawPaths)
      )
      const confirmation = gitPathRevertConfirmationOptions(prepared)

      // Re-resolve the opaque task/workspace authority and active-run state at
      // both privileged boundaries. The prepared envelope itself never leaves
      // this serialized main-process handler.
      await requireIdleGitTaskWorkspace(rawTaskId, binding)
      const approved = await confirmGitMutation(event, confirmation)
      if (!approved) return undefined

      await requireIdleGitTaskWorkspace(rawTaskId, binding)
      const result = await service.executePreparedPathRevert(prepared)
      return projectGitRecovery(result.recovery)
    }
  )

  handleWorkspaceLifecycle(
    IPC.undoGitRecovery,
    async (event, rawTaskId: unknown, rawRecoveryId: unknown) => {
      const binding = await requireIdleGitTaskWorkspace(rawTaskId)
      const recoveryId = parseNonEmptyId(
        rawRecoveryId,
        'Git recovery identifier'
      )
      const { service } = await gitServiceFor(binding.workspacePath)
      const prepared = await service.prepareRecoveryUndo(recoveryId)
      const confirmation = gitRecoveryUndoConfirmationOptions(prepared)

      await requireIdleGitTaskWorkspace(rawTaskId, binding)
      const approved = await confirmGitMutation(event, confirmation)
      if (!approved) return undefined

      await requireIdleGitTaskWorkspace(rawTaskId, binding)
      return projectGitRecovery(
        await service.executePreparedRecoveryUndo(prepared)
      )
    }
  )

  handleWorkspaceLifecycle(
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
      const prepared = await service.prepareCommit({
        message,
        authorName,
        authorEmail
      })
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
          'Complete reviewed preview:',
          '',
          prepared.preview,
          '',
          `Preview SHA-256: ${prepared.previewSha256}`,
          `Action SHA-256: ${prepared.actionSha256}`,
          '',
          'Ground revalidates the bound repository, worktree, exact checked-out local branch, and expected parent immediately before object creation and ref update. Detached-HEAD commits are refused. It commits only the exact staged tree shown above. Concurrent working-tree and index edits are preserved. Hooks and signing are disabled.'
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

  handleWorkspaceLifecycle(
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
      const linkedTasks = tasksUsingWorkspace(managedWorkspace)
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

      const currentLinkedTasks = tasksUsingWorkspace(managedWorkspace)
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
      const managedGrant =
        workspaceGrants.describeStoredPath(managedWorkspace)
      if (managedGrant) workspaceGrants.revoke(managedGrant.id)
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
  handleTrusted(IPC.getMcpServerStatuses, async () => {
    await mcp.ready()
    return mcp.getStatuses()
  })
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
    let persistenceExitStarted = false
    const exitAfterPersistenceUncertainty = (): void => {
      // Startup has not exposed writable services yet. Let the startup chain
      // report the fatal error and quit instead of entering a relaunch loop on
      // a persistent filesystem fault.
      if (!appInitialized) return
      if (persistenceExitStarted) return
      persistenceExitStarted = true
      applicationMutationGate.sealForProcessExit()
      try {
        app.relaunch()
      } finally {
        app.exit(1)
      }
    }
    // The smoke profile is intentionally empty and must never ingest a real
    // legacy task snapshot or credential vault from the host account.
    if (shouldMigrateLegacyData(packagedSmokeConfig)) {
      await migrateLegacyData(dataDirectory, app.getPath('appData'))
    }
    const store = new StateStore(
      path.join(dataDirectory, 'ground-state.json'),
      {
        onPersistenceUncertain: exitAfterPersistenceUncertainty
      }
    )
    const vault = new SecretVault(path.join(dataDirectory, 'ground-secrets.json'))
    const [, vaultLoadNotice] = await Promise.all([
      store.load(),
      vault.load()
    ])
    if (vaultLoadNotice) store.addRecoveryNotice(vaultLoadNotice)
    const vaultReconciliationNotice = await reconcileCredentialVault(
      store,
      vault
    )
    if (vaultReconciliationNotice) {
      store.addRecoveryNotice(vaultReconciliationNotice)
    }
    const credentialNotice = findCredentialRecoveryNotice(
      store.snapshot().providers,
      vault
    )
    if (credentialNotice) store.addRecoveryNotice(credentialNotice)
    const workspaceGrants = new WorkspaceGrantRegistry()
    await workspaceGrants.restore(store.snapshot().tasks.map((task) => task.workspacePath))
    const packagedCliSmokeTrustAuthority =
      packagedSmokeConfig?.scope === 'native'
        ? new PackagedCliSmokeTrustAuthority(packagedSmokeConfig)
        : undefined
    const cliTrust = new CliTrustRegistry(
      packagedCliSmokeTrustAuthority
        ? packagedCliSmokeTrustAuthority.confirm
        : confirmCliTrust
    )
    const authorizeCliInvocation = (
      request: Parameters<CliTrustRegistry['authorizeInvocation']>[0]
    ) => cliTrust.authorizeInvocation(request)
    const adapterRegistry = createBuiltinAdapterRegistry(
      authorizeCliInvocation
    )
    const modelRuntimeFactory = createRegisteredModelRuntimeFactory(
      adapterRegistry,
      resolveBuiltinModelAdapterBinding
    )
    const agentRuntimeFactory = createRegisteredAgentRuntimeFactory(
      adapterRegistry,
      resolveBuiltinAgentRuntimeBinding
    )
    mcpManager = new McpManager(store, undefined, {
      confirmStdioLaunch: confirmMcpStdioLaunch
    })
    const providerOperations = new ProviderOperationGate()
    const runs = new RunManager(
      store,
      vault,
      emitRunEvent,
      modelRuntimeFactory,
      mcpManager,
      authorizeCliInvocation,
      providerOperations,
      (candidate) => workspaceGrants.requireStoredPath(candidate),
      agentRuntimeFactory,
      async (provider) => {
        if (provider.kind === 'cli') await cliTrust.authorize(provider)
      }
    )
    runManager = runs
    const providers = new ProviderService(
      store,
      vault,
      cliTrust,
      (providerId) => runs.isProviderActive(providerId),
      providerOperations,
      () =>
        store
          .snapshot()
          .tasks.map((task) => task.workspacePath)
          .filter((candidate): candidate is string => Boolean(candidate)),
      exitAfterPersistenceUncertainty
    )
    terminalService = new TerminalService({
      authorizeWorkspace: (candidate) =>
        workspaceGrants.requireStoredPath(candidate)
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
          await runPackagedNativeSmoke(packagedSmokeConfig, {
            provider: () =>
              runPackagedProviderSmoke({
                token: packagedSmokeConfig.token,
                directory: packagedSmokeConfig.directory,
                userDataPath: packagedSmokeConfig.userDataPath,
                store,
                providers,
                runs,
                workspaceGrants,
                runEvents: () => packagedSmokeRunEvents
              }),
            providerFailures: () =>
              runPackagedProviderFailureSmoke({
                token: packagedSmokeConfig.token,
                directory: packagedSmokeConfig.directory,
                userDataPath: packagedSmokeConfig.userDataPath,
                store,
                providers,
                runs,
                workspaceGrants,
                runEvents: () => packagedSmokeRunEvents
              }),
            cli: () => {
              if (!packagedCliSmokeTrustAuthority) {
                throw new Error(
                  'Packaged native CLI smoke trust authority is unavailable'
                )
              }
              return runPackagedCliSmoke({
                config: packagedSmokeConfig,
                store,
                providers,
                runs,
                workspaceGrants,
                trustAuthority: packagedCliSmokeTrustAuthority,
                runEvents: () => packagedSmokeRunEvents
              })
            }
          })
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
