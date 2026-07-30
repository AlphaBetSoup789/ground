import type {
  AppSnapshot,
  DesktopApi,
  DesktopRunEvent,
  DesktopRunEventEnvelope,
  DesktopTask,
  DesktopTaskItem,
  ProviderDraft,
  ProviderProfile,
  TaskPatch,
  TerminalEvent,
  TerminalSessionInfo
} from '../../../shared/types'
import { resolveDesktopBridge } from './desktop-bridge'

const listeners = new Set<(event: DesktopRunEventEnvelope) => void>()
const terminalListeners = new Set<(event: TerminalEvent) => void>()
const mockTerminals = new Map<string, TerminalSessionInfo>()
const mockTerminalAttachments = new Map<string, string>()
const mockRuns = new Map<
  string,
  {
    taskId: string
    runId: string
    timers: Set<number>
  }
>()
const timestamp = new Date().toISOString()
const previewUnstagedDiff = `diff --git a/src/renderer/src/App.tsx b/src/renderer/src/App.tsx
index 1234567..89abcde 100644
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -42,5 +42,6 @@ export function App() {
   const [ready, setReady] = useState(false)
${' '}
+  // Ground keeps Git operations local.
   useEffect(() => {
     setReady(true)
   }, [])
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index 2345678..9abcdef 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -84,4 +84,4 @@ button:focus-visible {
-  outline: none;
+  outline: 2px solid currentColor;
   outline-offset: 2px;
   border-radius: 8px;
 }
@@ -6374,4 +6374,6 @@ @media (prefers-reduced-motion: reduce) {
-  * {
-    transition-duration: 0s;
+  *,
+  *::before,
+  *::after {
+    transition-duration: 0.01ms;
   }
 }
\\ No newline at end of file`
const previewUnstagedDiffBytes = new TextEncoder().encode(
  previewUnstagedDiff
).byteLength
const previewWorkspace = {
  id: 'workspace_00000000-0000-4000-8000-000000000001',
  name: 'acme-dashboard'
}
const selectableWorkspace = {
  id: 'workspace_00000000-0000-4000-8000-000000000002',
  name: 'new-workspace'
}
let mockSnapshot: AppSnapshot = {
  runEventRevision: 0,
  providers: [
    {
      id: 'ollama-local',
      name: 'Ollama · local',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: '',
      supportsTools: true,
      hasApiKey: false,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: 'codex-preview',
      name: 'Codex CLI',
      kind: 'cli',
      command: '/opt/homebrew/bin/codex',
      args: ['exec', '--json', '-'],
      promptMode: 'stdin',
      outputMode: 'ndjson',
      trustConfirmed: true,
      model: '',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ],
  mcpServers: [],
  tasks: [
    {
      id: 'preview-task',
      title: 'Refine the project dashboard',
      workspace: previewWorkspace,
      providerId: 'codex-preview',
      mode: 'agent',
      runStatus: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      items: [
        {
          id: 'preview-user',
          kind: 'message',
          role: 'user',
          content:
            'Audit the dashboard empty state and make the next action feel obvious.',
          createdAt: timestamp
        },
        {
          id: 'preview-tool',
          kind: 'activity',
          runId: 'preview-run',
          activityType: 'tool',
          title: 'Read 4 interface files',
          detail: 'src/app/dashboard/page.tsx\nsrc/components/empty-state.tsx\nsrc/styles/dashboard.css',
          status: 'success',
          durationMs: 183,
          createdAt: timestamp
        },
        {
          id: 'preview-assistant',
          kind: 'message',
          role: 'assistant',
          content:
            'I found the friction: the page offers three equal-weight actions before the user has any data. I’d make **Create your first project** the single primary path, keep import secondary, and move documentation into supporting copy.\n\nThe implementation is scoped to the empty-state component and its styles.',
          createdAt: timestamp
        }
      ]
    },
    {
      id: 'preview-task-two',
      title: 'Explain the auth flow',
      workspace: previewWorkspace,
      providerId: 'ollama-local',
      mode: 'ask',
      runStatus: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      items: [
        {
          id: 'preview-auth-user',
          kind: 'message',
          role: 'user',
          content: 'Explain the current authentication flow and propose a safe cleanup.',
          createdAt: timestamp
        },
        {
          id: 'preview-auth-assistant',
          kind: 'message',
          role: 'assistant',
          content:
            'The flow keeps credential access in the main process and gives the renderer only provider-safe metadata. I would keep that boundary, consolidate duplicated readiness checks, and add a regression around expired workspace access before changing the UI.',
          createdAt: timestamp
        }
      ]
    }
  ],
  settings: {
    selectedTaskId: 'preview-task',
    defaultProviderId: 'codex-preview',
    sidebarCollapsed: false
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function mockEnvironmentFingerprint(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function emit(event: DesktopRunEvent): void {
  const envelope = {
    revision: (mockSnapshot.runEventRevision ?? 0) + 1,
    event
  }
  mockSnapshot.runEventRevision = envelope.revision
  for (const listener of listeners) listener(envelope)
}

function emitTerminal(event: TerminalEvent): void {
  for (const listener of terminalListeners) listener(event)
}

function scheduleMockRun(
  run: { taskId: string; runId: string; timers: Set<number> },
  callback: () => void,
  delayMs: number
): void {
  const timer = window.setTimeout(() => {
    run.timers.delete(timer)
    if (mockRuns.get(run.taskId) !== run) return
    callback()
  }, delayMs)
  run.timers.add(timer)
}

const mockApi: DesktopApi = {
  getSnapshot: async () => clone(mockSnapshot),
  listStateSnapshots: async () => [
    {
      id: 'state_snapshot_00000000-0000-4000-8000-000000000001',
      kind: 'current',
      generation: 0,
      status: 'valid',
      capturedAt: timestamp,
      sizeBytes: 24_640,
      taskCount: mockSnapshot.tasks.length,
      providerCount: mockSnapshot.providers.length
    },
    ...[1, 2, 3].map((generation) => ({
      id: `state_snapshot_00000000-0000-4000-8000-00000000000${generation + 1}`,
      kind: 'retained' as const,
      generation,
      status: 'unavailable' as const
    }))
  ],
  exportStateSnapshot: async () => false,
  restoreStateSnapshot: async () => false,
  createTask: async (workspaceGrantId) => {
    const provider =
      mockSnapshot.providers.find(
        (candidate) =>
          candidate.id === mockSnapshot.settings.defaultProviderId
      ) ?? mockSnapshot.providers[0]
    if (!provider) throw new Error('No provider')
    mockSnapshot.settings.defaultProviderId = provider.id
    const workspace =
      workspaceGrantId === undefined
        ? undefined
        : workspaceGrantId === selectableWorkspace.id
          ? selectableWorkspace
          : mockSnapshot.tasks.find(
              (candidate) => candidate.workspace?.id === workspaceGrantId
            )?.workspace
    if (workspaceGrantId !== undefined && !workspace) {
      throw new Error('Workspace access expired')
    }
    const task: DesktopTask = {
      id: crypto.randomUUID(),
      title: 'New task',
      ...(workspace ? { workspace: clone(workspace) } : {}),
      providerId: provider.id,
      mode: 'agent',
      runStatus: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: []
    }
    mockSnapshot.tasks.unshift(task)
    mockSnapshot.settings.selectedTaskId = task.id
    return clone(task)
  },
  forkTask: async (taskId) => {
    const source = mockSnapshot.tasks.find((candidate) => candidate.id === taskId)
    if (!source) throw new Error('Task not found')
    if (source.runStatus === 'running' || source.runStatus === 'awaiting-approval') {
      throw new Error('Stop this task before forking it')
    }
    const forkedAt = new Date().toISOString()
    const runIds = new Map<string, string>()
    const callIds = new Map<string, string>()
    const mappedId = (ids: Map<string, string>, sourceId: string): string => {
      const existing = ids.get(sourceId)
      if (existing) return existing
      const created = crypto.randomUUID()
      ids.set(sourceId, created)
      return created
    }
    const task: DesktopTask = {
      id: crypto.randomUUID(),
      title: `${source.title.slice(0, 113).trimEnd()} (fork)`,
      workspace: source.workspace,
      providerId: source.providerId,
      mode: source.mode,
      includeImportedHistory: source.includeImportedHistory,
      runStatus: 'idle',
      createdAt: forkedAt,
      updatedAt: forkedAt,
      items: source.items.map((item): DesktopTaskItem => {
        if (item.kind === 'message') {
          return {
            ...clone(item),
            id: crypto.randomUUID(),
            runId: item.runId ? mappedId(runIds, item.runId) : undefined
          }
        }
        return {
          ...clone(item),
          id: crypto.randomUUID(),
          runId: mappedId(runIds, item.runId),
          status:
            item.status === 'pending' || item.status === 'running'
              ? 'error'
              : item.status,
          approvalId: undefined,
          callId: item.callId
            ? mappedId(callIds, item.callId)
            : undefined
        } as DesktopTaskItem
      })
    }
    mockSnapshot.tasks.unshift(task)
    mockSnapshot.settings.selectedTaskId = task.id
    return clone(task)
  },
  setTaskArchived: async (taskId, archived) => {
    const task = mockSnapshot.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new Error('Task not found')
    if (task.runStatus === 'running' || task.runStatus === 'awaiting-approval') {
      throw new Error(`Stop this task before ${archived ? 'archiving' : 'unarchiving'} it`)
    }
    if (archived) task.archivedAt ??= new Date().toISOString()
    else delete task.archivedAt
    task.updatedAt = new Date().toISOString()
    if (archived && mockSnapshot.settings.selectedTaskId === taskId) {
      mockSnapshot.settings.selectedTaskId = mockSnapshot.tasks.find(
        (candidate) => candidate.id !== taskId && !candidate.archivedAt
      )?.id
    } else if (!archived) {
      mockSnapshot.settings.selectedTaskId = taskId
    }
    return clone(task)
  },
  importTaskBundle: async () => {
    const provider =
      mockSnapshot.providers.find(
        (candidate) =>
          candidate.id ===
          mockSnapshot.tasks.find(
            (task) => task.id === mockSnapshot.settings.selectedTaskId
          )?.providerId
      ) ?? mockSnapshot.providers[0]
    if (!provider) throw new Error('No provider')
    const importedAt = new Date().toISOString()
    const task: DesktopTask = {
      id: crypto.randomUUID(),
      title: 'Imported task',
      providerId: provider.id,
      mode: 'agent',
      includeImportedHistory: false,
      runStatus: 'idle',
      createdAt: importedAt,
      updatedAt: importedAt,
      items: [
        {
          id: crypto.randomUUID(),
          kind: 'message',
          role: 'user',
          content: 'This is imported history from a portable Ground task bundle.',
          createdAt: importedAt,
          historyOnly: true
        },
        {
          id: crypto.randomUUID(),
          kind: 'message',
          role: 'assistant',
          content:
            'The transcript is readable, but it does not inherit workspace access or pending actions.',
          createdAt: importedAt,
          historyOnly: true
        }
      ]
    }
    mockSnapshot.tasks.unshift(task)
    mockSnapshot.settings.selectedTaskId = task.id
    return clone(task)
  },
  exportTask: async (taskId) => {
    if (!mockSnapshot.tasks.some((task) => task.id === taskId)) {
      throw new Error('Task not found')
    }
    return true
  },
  deleteTask: async (taskId) => {
    const task = mockSnapshot.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new Error('Task not found')
    if (task.runStatus === 'running' || task.runStatus === 'awaiting-approval') {
      throw new Error('Stop this task before deleting it')
    }
    mockSnapshot.tasks = mockSnapshot.tasks.filter(
      (candidate) => candidate.id !== taskId
    )
    if (mockSnapshot.settings.selectedTaskId === taskId) {
      mockSnapshot.settings.selectedTaskId =
        mockSnapshot.tasks.find((candidate) => !candidate.archivedAt)?.id ??
        mockSnapshot.tasks[0]?.id
    }
    return true
  },
  selectTask: async (taskId) => {
    mockSnapshot.settings.selectedTaskId = taskId
  },
  updateTask: async (taskId, patch: TaskPatch) => {
    if (taskId === 'preview-task-two' && patch.mode === 'agent') {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 200)
      })
    }
    const task = mockSnapshot.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new Error('Task not found')
    const {
      workspaceGrantId,
      ...taskPatch
    } = patch
    Object.assign(task, taskPatch)
    if (workspaceGrantId !== undefined) {
      const workspace =
        workspaceGrantId === selectableWorkspace.id
          ? selectableWorkspace
          : mockSnapshot.tasks.find(
              (candidate) => candidate.workspace?.id === workspaceGrantId
            )?.workspace
      if (!workspace) throw new Error('Workspace access expired')
      task.workspace = clone(workspace)
    }
    if (patch.providerId) {
      mockSnapshot.settings.defaultProviderId = patch.providerId
    }
    return clone(task)
  },
  chooseWorkspace: async () => clone(selectableWorkspace),
  revealWorkspace: async () => undefined,
  saveProvider: async (draft: ProviderDraft) => {
    const existing = draft.id
      ? mockSnapshot.providers.find((provider) => provider.id === draft.id)
      : undefined
    const provider: ProviderProfile =
      draft.kind === 'cli'
        ? {
            id: draft.id ?? crypto.randomUUID(),
            name: draft.name,
            kind: 'cli',
            model: draft.model,
            command: draft.command ?? '',
            args: draft.args ?? [],
            promptMode: draft.promptMode ?? 'stdin',
            outputMode: draft.outputMode ?? 'plain',
            cliAdapter: draft.cliAdapter ?? 'generic',
            ...((draft.cliEnvironment?.length ?? 0) > 0
              ? {
                  environmentVariables: draft.cliEnvironment?.map(
                    (entry) => entry.name
                  ),
                  environmentFingerprint:
                    existing?.kind === 'cli' &&
                    existing.environmentVariables?.join('\0') ===
                      draft.cliEnvironment
                        ?.map((entry) => entry.name)
                        .join('\0') &&
                    (draft.cliEnvironment?.every((entry) => !entry.value) ??
                      false)
                      ? existing.environmentFingerprint ??
                        mockEnvironmentFingerprint()
                      : mockEnvironmentFingerprint()
                }
              : {}),
            trustConfirmed: true,
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp
          }
        : {
            id: draft.id ?? crypto.randomUUID(),
            name: draft.name,
            kind: draft.kind,
            model: draft.model,
            baseUrl: draft.baseUrl ?? '',
            supportsTools: draft.supportsTools ?? true,
            contextWindowTokens: draft.contextWindowTokens,
            maxOutputTokens: draft.maxOutputTokens,
            reasoningEffort: draft.reasoningEffort,
            hasApiKey:
              Boolean(draft.apiKey) ||
              Boolean(
                existing &&
                  existing.kind !== 'cli' &&
                  existing.kind === draft.kind &&
                  existing.hasApiKey
              ),
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp
          }
    if (existing) {
      mockSnapshot.providers = mockSnapshot.providers.map((candidate) =>
        candidate.id === provider.id ? provider : candidate
      )
    } else {
      mockSnapshot.providers.push(provider)
    }
    return clone(provider)
  },
  deleteProvider: async (providerId) => {
    mockSnapshot.providers = mockSnapshot.providers.filter((provider) => provider.id !== providerId)
  },
  testProvider: async (draft) => {
    if (
      draft.kind === 'openai-compatible' &&
      draft.baseUrl?.includes('127.0.0.1:1/')
    ) {
      return {
        ok: false,
        title: 'Could not connect',
        detail:
          'No service is listening at http://127.0.0.1:1/v1 (connection refused, ECONNREFUSED).',
        failureKind: 'connection-refused'
      }
    }
    return {
      ok: true,
      title: draft.kind === 'cli' ? 'Executable found' : 'Connection successful',
      detail:
        draft.kind === 'cli'
          ? `${draft.command}\nPrompt transport: ${draft.promptMode}`
          : draft.model
            ? 'The endpoint responded and the configured model is ready.'
            : 'The endpoint responded. Enter a model ID to finish setup.',
      models: draft.kind !== 'cli' && draft.model ? [draft.model] : undefined
    }
  },
  detectClis: async () => [
    {
      id: 'codex',
      name: 'Codex CLI',
      path: '/opt/homebrew/bin/codex',
      description: 'Workspace agent with JSONL events and native sandboxing.',
      draft: {
        name: 'Codex CLI',
        kind: 'cli',
        model: '',
        command: '/opt/homebrew/bin/codex',
        args: ['exec', '--json', '-'],
        promptMode: 'stdin',
        outputMode: 'ndjson',
        cliAdapter: 'codex',
        trustConfirmed: false
      }
    },
    {
      id: 'claude',
      name: 'Claude Code',
      path: '/Users/you/.local/bin/claude',
      description: 'Claude’s coding agent in streamed, non-interactive mode.',
      draft: {
        name: 'Claude Code',
        kind: 'cli',
        model: '',
        command: '/Users/you/.local/bin/claude',
        args: ['-p', '--output-format', 'stream-json'],
        promptMode: 'stdin',
        outputMode: 'ndjson',
        cliAdapter: 'claude',
        trustConfirmed: false
      }
    }
  ],
  chooseCliExecutable: async () => '/usr/local/bin/ground-agent',
  startRun: async ({ taskId, prompt }) => {
    const task = mockSnapshot.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new Error('Task not found')
    if (mockRuns.has(taskId)) throw new Error('Task already running')
    const runId = crypto.randomUUID()
    const run = { taskId, runId, timers: new Set<number>() }
    mockRuns.set(taskId, run)
    const userItem = {
      id: crypto.randomUUID(),
      kind: 'message' as const,
      role: 'user' as const,
      runId,
      content: prompt,
      createdAt: new Date().toISOString()
    }
    task.items.push(userItem)
    task.runStatus = 'running'
    emit({ type: 'run-started', taskId, runId })
    emit({ type: 'item-added', taskId, runId, item: userItem })
    const assistantId = crypto.randomUUID()
    const assistant = {
      id: assistantId,
      kind: 'message' as const,
      role: 'assistant' as const,
      runId,
      content: '',
      createdAt: new Date().toISOString()
    }
    task.items.push(assistant)
    scheduleMockRun(
      run,
      () => emit({ type: 'item-added', taskId, runId, item: assistant }),
      250
    )
    const response =
      'I’m connected. This browser preview is using the deterministic mock runtime; the desktop build streams from your configured API or CLI.'
    const words = response.split(' ')
    words.forEach((word, index) => {
      scheduleMockRun(run, () => {
        const delta = `${index ? ' ' : ''}${word}`
        const offset = assistant.content.length
        assistant.content += delta
        emit({
          type: 'text-delta',
          taskId,
          runId,
          itemId: assistantId,
          delta,
          offset
        })
        if (index === words.length - 1) {
          mockRuns.delete(taskId)
          task.runStatus = 'idle'
          emit({ type: 'run-completed', taskId, runId })
        }
      }, 1_000 + index * 500)
    })
    return { runId }
  },
  stopRun: async (taskId) => {
    const run = mockRuns.get(taskId)
    if (!run) return
    mockRuns.delete(taskId)
    for (const timer of run.timers) window.clearTimeout(timer)
    run.timers.clear()
    const task = mockSnapshot.tasks.find((candidate) => candidate.id === taskId)
    if (task) task.runStatus = 'idle'
    emit({ type: 'run-stopped', taskId, runId: run.runId })
  },
  resolveApproval: async () => undefined,
  onRunEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  listTerminals: async (taskId) =>
    clone([...mockTerminals.values()].filter((session) => session.taskId === taskId)),
  createTerminal: async (taskId, dimensions) => {
    const session: TerminalSessionInfo = {
      id: crypto.randomUUID(),
      taskId,
      pid: 4242,
      cols: dimensions?.cols ?? 100,
      rows: dimensions?.rows ?? 30,
      createdAt: Date.now()
    }
    mockTerminals.set(session.id, session)
    return clone(session)
  },
  attachTerminal: async (taskId, sessionId) => {
    const session = mockTerminals.get(sessionId)
    if (!session || session.taskId !== taskId) {
      throw new Error('Terminal session not found')
    }
    const attachmentId = crypto.randomUUID()
    mockTerminalAttachments.set(sessionId, attachmentId)
    window.setTimeout(() => {
      emitTerminal({
        type: 'data',
        sessionId,
        sequence: 1,
        data: '\x1b[38;2;216;255;125mGround preview terminal\x1b[0m\r\n$ ',
        replayed: true,
        timestamp: Date.now()
      })
    }, 20)
    return { attachmentId }
  },
  detachTerminal: async (sessionId, attachmentId) => {
    if (mockTerminalAttachments.get(sessionId) !== attachmentId) return
    mockTerminalAttachments.delete(sessionId)
  },
  terminalInput: async (sessionId, attachmentId, data) => {
    if (
      !mockTerminals.has(sessionId) ||
      mockTerminalAttachments.get(sessionId) !== attachmentId
    ) {
      throw new Error('Terminal is not attached to this view')
    }
    emitTerminal({
      type: 'data',
      sessionId,
      sequence: Date.now(),
      data,
      replayed: false,
      timestamp: Date.now()
    })
    if (data.includes('\r')) {
      emitTerminal({
        type: 'data',
        sessionId,
        sequence: Date.now() + 1,
        data: '\r\nPreview mode does not execute commands.\r\n$ ',
        replayed: false,
        timestamp: Date.now()
      })
    }
  },
  terminalResize: async (sessionId, attachmentId, dimensions) => {
    const session = mockTerminals.get(sessionId)
    if (
      !session ||
      mockTerminalAttachments.get(sessionId) !== attachmentId
    ) {
      throw new Error('Terminal is not attached to this view')
    }
    Object.assign(session, dimensions)
    return clone(session)
  },
  terminalClose: async (sessionId, attachmentId) => {
    if (mockTerminalAttachments.get(sessionId) !== attachmentId) {
      throw new Error('Terminal is not attached to this view')
    }
    mockTerminalAttachments.delete(sessionId)
    if (!mockTerminals.delete(sessionId)) return
    emitTerminal({
      type: 'exit',
      sessionId,
      exitCode: null,
      reason: 'disposed',
      timestamp: Date.now()
    })
  },
  onTerminalEvent: (listener) => {
    terminalListeners.add(listener)
    return () => terminalListeners.delete(listener)
  },
  getGitOverview: async () => ({
    isRepository: true,
    status: {
      branch: 'main',
      detached: false,
      staged: [],
      unstaged: [
        'src/renderer/src/App.tsx',
        'src/renderer/src/styles.css'
      ],
      untracked: ['src/renderer/src/components/GitPanel.tsx'],
      conflicted: []
    },
    unstagedDiff: {
      text: previewUnstagedDiff,
      truncated: false,
      bytes: previewUnstagedDiffBytes
    },
    stagedDiff: { text: '', truncated: false, bytes: 0 },
    commits: [
      {
        hash: '8a72fbcddb2c3c516cd92dfbc12579ec9ab35121',
        shortHash: '8a72fbc',
        authorName: 'Ground contributor',
        authorEmail: 'contributor@example.com',
        authoredAt: timestamp,
        parents: [],
        subject: 'Build provider-neutral agent workspace',
        body: ''
      }
    ],
    historyTruncated: false,
    recoveries: [
      {
        id: '12345678-1234-4123-8123-123456789abc',
        createdAt: timestamp,
        status: 'applied',
        trackedPaths: ['src/renderer/src/App.tsx'],
        untrackedPaths: [],
        canUndo: true
      }
    ],
    recoveriesTruncated: false,
    worktrees: [
      {
        relativePath: '.',
        isMain: true,
        head: '8a72fbcddb2c3c516cd92dfbc12579ec9ab35121',
        branch: 'main',
        detached: false,
        locked: false,
        prunable: false
      }
    ]
  }),
  chooseGitExecutable: async () => true,
  createGitWorktree: async (taskId, input) => {
    const source = mockSnapshot.tasks.find((candidate) => candidate.id === taskId)
    if (!source) throw new Error('Task not found')
    const created: DesktopTask = {
      ...clone(source),
      id: crypto.randomUUID(),
      title: input.branch,
      workspace: {
        id: `workspace_${crypto.randomUUID()}`,
        name: input.branch
      },
      runStatus: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: []
    }
    mockSnapshot.tasks.unshift(created)
    mockSnapshot.settings.selectedTaskId = created.id
    return clone(created)
  },
  stageGitPaths: async () => true,
  unstageGitPaths: async () => true,
  revertGitPaths: async (_taskId, paths) => ({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'applied',
    trackedPaths: clone(paths),
    untrackedPaths: [],
    canUndo: true
  }),
  undoGitRecovery: async (_taskId, recoveryId) => ({
    id: recoveryId,
    createdAt: new Date().toISOString(),
    status: 'restored',
    trackedPaths: [],
    untrackedPaths: [],
    canUndo: false
  }),
  commitGitChanges: async (_taskId, input) => ({
    hash: '9b83f89ea4c0bed1169830f1f3c2c9fc8339a2fd',
    shortHash: '9b83f89',
    authorName: input.authorName,
    authorEmail: input.authorEmail,
    authoredAt: new Date().toISOString(),
    parents: ['8a72fbcddb2c3c516cd92dfbc12579ec9ab35121'],
    subject: input.message.split(/\r?\n/u, 1)[0] || 'Commit',
    body: input.message.split(/\r?\n/u).slice(1).join('\n').trim()
  }),
  removeGitWorktree: async () => [],
  saveMcpServer: async (draft) => {
    const existing = draft.id
      ? mockSnapshot.mcpServers.find((server) => server.id === draft.id)
      : undefined
    const common = {
      id: draft.id ?? crypto.randomUUID(),
      name: draft.name,
      namespace: draft.namespace ?? draft.name.toLowerCase().replace(/\W+/gu, '_'),
      enabled: draft.enabled ?? true,
      trustedFingerprints: existing?.trustedFingerprints ?? {},
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const server =
      draft.transport === 'stdio'
        ? {
            ...common,
            transport: 'stdio' as const,
            command: draft.command ?? '',
            args: draft.args ?? []
          }
        : {
            ...common,
            transport: 'streamable-http' as const,
            url: draft.url ?? ''
          }
    mockSnapshot.mcpServers = existing
      ? mockSnapshot.mcpServers.map((candidate) =>
          candidate.id === server.id ? server : candidate
        )
      : [...mockSnapshot.mcpServers, server]
    return clone(server)
  },
  deleteMcpServer: async (serverId) => {
    mockSnapshot.mcpServers = mockSnapshot.mcpServers.filter(
      (server) => server.id !== serverId
    )
  },
  getMcpServerStatuses: async () =>
    mockSnapshot.mcpServers.map((server) => ({
      id: server.id,
      connection: 'connected' as const,
      tools: [],
      fingerprints: {},
      drift: { added: [], removed: [], changed: [] }
    })),
  connectMcpServer: async (serverId) => ({
    id: serverId,
    connection: 'connected',
    tools: [],
    fingerprints: {},
    drift: { added: [], removed: [], changed: [] }
  }),
  trustMcpTools: async (serverId, fingerprints) => ({
    id: serverId,
    connection: 'connected',
    tools: [],
    fingerprints,
    drift: { added: [], removed: [], changed: [] }
  })
}

const previewBuild =
  import.meta.env.VITE_GROUND_BROWSER_PREVIEW === 'true'

export const desktopBridge = resolveDesktopBridge(
  window.ground,
  previewBuild,
  () => mockApi
)

const unavailableDesktop = new Proxy({} as DesktopApi, {
  get() {
    throw new Error(
      'Ground could not connect to its secure desktop bridge. Restart the desktop app.'
    )
  }
})

export const desktop: DesktopApi =
  desktopBridge.status === 'ready' ? desktopBridge.api : unavailableDesktop
export const isDesktop =
  desktopBridge.status === 'ready' && desktopBridge.mode === 'desktop'
export const isBrowserPreview =
  desktopBridge.status === 'ready' && desktopBridge.mode === 'preview'
