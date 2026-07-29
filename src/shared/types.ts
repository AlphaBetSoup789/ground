export type RunMode = 'ask' | 'agent'
export type RunStatus = 'idle' | 'running' | 'awaiting-approval' | 'failed'
export type ActivityStatus = 'pending' | 'running' | 'success' | 'error' | 'denied'
export type ModelProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible'
export type ProviderKind = ModelProviderKind | 'cli'
export type CliAdapter = 'generic' | 'codex' | 'claude' | 'gemini'
export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface BaseProvider {
  id: string
  name: string
  kind: ProviderKind
  model: string
  createdAt: string
  updatedAt: string
}

interface BaseModelApiProvider extends BaseProvider {
  kind: ModelProviderKind
  baseUrl: string
  hasApiKey: boolean
  supportsTools: boolean
  contextWindowTokens?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
}

export interface OpenAIProvider extends BaseModelApiProvider {
  kind: 'openai'
}

export interface AnthropicProvider extends BaseModelApiProvider {
  kind: 'anthropic'
}

export interface GoogleProvider extends BaseModelApiProvider {
  kind: 'google'
}

export interface OpenAICompatibleProvider extends BaseModelApiProvider {
  kind: 'openai-compatible'
}

export type ModelApiProvider =
  | OpenAIProvider
  | AnthropicProvider
  | GoogleProvider
  | OpenAICompatibleProvider

export interface CliProvider extends BaseProvider {
  kind: 'cli'
  command: string
  args: string[]
  promptMode: 'stdin' | 'argument'
  outputMode: 'plain' | 'ndjson'
  cliAdapter?: CliAdapter
  environmentVariables?: string[]
  environmentFingerprint?: string
  trustConfirmed: boolean
}

export type ProviderProfile = ModelApiProvider | CliProvider

export interface CliEnvironmentVariableDraft {
  name: string
  /**
   * Omit or leave blank to retain an existing encrypted value. Values are
   * accepted by IPC but are never part of ProviderProfile or AppSnapshot.
   */
  value?: string
}

export interface ProviderDraft {
  id?: string
  name: string
  kind: ProviderKind
  model: string
  apiKey?: string
  baseUrl?: string
  supportsTools?: boolean
  contextWindowTokens?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  command?: string
  args?: string[]
  promptMode?: 'stdin' | 'argument'
  outputMode?: 'plain' | 'ndjson'
  cliAdapter?: CliAdapter
  cliEnvironment?: CliEnvironmentVariableDraft[]
  trustConfirmed?: boolean
}

export interface RuntimeSession {
  adapter: Exclude<CliAdapter, 'generic'>
  sessionId: string
  providerRevision: string
  workspacePath: string
  mode: RunMode
  updatedAt: string
}

export type PortableJsonPrimitive = null | boolean | number | string
export type PortableJsonValue =
  | PortableJsonPrimitive
  | PortableJsonValue[]
  | { [key: string]: PortableJsonValue }
export interface PortableJsonObject {
  [key: string]: PortableJsonValue
}

export interface StoredProviderState {
  adapterId: string
  schemaVersion: 1
  data: PortableJsonValue
}

export type StoredModelMessagePart =
  | {
      kind: 'text'
      text: string
      providerState?: StoredProviderState
    }
  | {
      kind: 'reasoning-summary'
      text: string
      providerState?: StoredProviderState
    }
  | {
      kind: 'tool-call'
      callId: string
      name: string
      rawArguments: string
      arguments?: PortableJsonObject
      parseError?: string
      providerState?: StoredProviderState
    }

export type StoredModelConversationItem =
  | {
      kind: 'message'
      id: string
      role: 'user' | 'assistant'
      parts: StoredModelMessagePart[]
      providerState?: StoredProviderState
    }
  | {
      kind: 'tool-result'
      id: string
      callId: string
      name?: string
      content: Array<
        | { kind: 'text'; text: string }
        | { kind: 'json'; value: PortableJsonValue }
      >
      isError?: boolean
      providerState?: StoredProviderState
    }

export interface ModelRuntimeSession {
  adapterId: string
  providerRevision: string
  model: string
  workspacePath?: string
  mode: RunMode
  /**
   * Binds provider continuation state to the user's imported-history context
   * choice. Older sessions omit this field and are handled conservatively.
   */
  includesImportedHistory?: boolean
  /**
   * Marks portable provider-neutral conversation that has not yet been
   * accepted into a fresh Ground-owned model session.
   */
  origin?: 'ground' | 'imported'
  conversation: StoredModelConversationItem[]
  checkpoint?: PortableJsonValue
  updatedAt: string
}

export interface ProviderAttribution {
  id: string
  name: string
  kind: ProviderKind
  model: string
}

export interface MessageItem {
  id: string
  kind: 'message'
  runId?: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  historyOnly?: boolean
  provider?: ProviderAttribution
}

export interface ActivityItem {
  id: string
  kind: 'activity'
  runId: string
  activityType: 'status' | 'tool' | 'command' | 'approval' | 'error' | 'diagnostic'
  title: string
  detail?: string
  status: ActivityStatus
  createdAt: string
  approvalId?: string
  toolName?: string
  input?: Record<string, unknown>
  result?: string
  durationMs?: number
  historyOnly?: boolean
  callId?: string
  provider?: ProviderAttribution
}

export type TaskItem = MessageItem | ActivityItem

export interface Task {
  id: string
  title: string
  workspacePath?: string
  providerId: string
  mode: RunMode
  includeImportedHistory?: boolean
  runStatus: RunStatus
  archivedAt?: string
  createdAt: string
  updatedAt: string
  runtimeSessions?: Record<string, RuntimeSession>
  modelSessions?: Record<string, ModelRuntimeSession>
  items: TaskItem[]
}

export interface AppSettings {
  selectedTaskId?: string
  defaultProviderId: string
  sidebarCollapsed: boolean
}

export interface RecoveryNotice {
  id: string
  kind: 'backup-restored' | 'state-reset'
  title: string
  detail: string
}

interface BaseMcpServerProfile {
  id: string
  name: string
  namespace: string
  enabled: boolean
  trustedFingerprints: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface RemoteMcpServerProfile extends BaseMcpServerProfile {
  transport: 'streamable-http'
  url: string
}

export interface StdioMcpServerProfile extends BaseMcpServerProfile {
  transport: 'stdio'
  command: string
  args: string[]
}

export type McpServerProfile = RemoteMcpServerProfile | StdioMcpServerProfile

export interface McpServerDraft {
  id?: string
  name: string
  namespace?: string
  enabled?: boolean
  transport: 'streamable-http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
}

export interface McpToolSummary {
  name: string
  originalName: string
  title?: string
  description: string
  fingerprint: string
  trustStatus: 'approved' | 'pending' | 'changed'
}

export interface McpServerStatus {
  id: string
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  serverInfo?: {
    name: string
    version: string
    title?: string
  }
  tools: McpToolSummary[]
  fingerprints: Record<string, string>
  drift: {
    added: string[]
    removed: string[]
    changed: string[]
  }
}

export interface AppSnapshot {
  providers: ProviderProfile[]
  mcpServers: McpServerProfile[]
  tasks: Task[]
  settings: AppSettings
  /**
   * Ephemeral startup information. This is intentionally not persisted into the
   * primary state document or exported with a task.
   */
  recoveryNotice?: RecoveryNotice
  /**
   * Ephemeral main-process sequence included by the desktop snapshot IPC. It
   * lets a newly created renderer reconcile events emitted while the snapshot
   * was being read without replaying deltas already represented by that
   * snapshot.
   */
  runEventRevision?: number
  /**
   * Ephemeral projection of events for runs that are still active. These
   * events are included because streamed assistant text is committed
   * transactionally at a response boundary rather than on every token.
   */
  activeRunEvents?: RunEventEnvelope[]
}

export interface StartRunInput {
  taskId: string
  prompt: string
}

export type RunEvent =
  | {
      type: 'run-started'
      taskId: string
      runId: string
    }
  | {
      type: 'item-added'
      taskId: string
      runId: string
      item: TaskItem
    }
  | {
      type: 'text-delta'
      taskId: string
      runId: string
      itemId: string
      delta: string
      /**
       * Character offset of this delta in the assistant item. Built-in
       * runtimes provide it so reconnect replay is idempotent.
       */
      offset?: number
    }
  | {
      type: 'item-updated'
      taskId: string
      runId: string
      item: TaskItem
    }
  | {
      type: 'approval-requested'
      taskId: string
      runId: string
      item: ActivityItem
    }
  | {
      type: 'run-completed'
      taskId: string
      runId: string
    }
  | {
      type: 'run-stopped'
      taskId: string
      runId: string
    }
  | {
      type: 'run-error'
      taskId: string
      runId: string
      message: string
    }

export interface RunEventEnvelope {
  revision: number
  event: RunEvent
}

export interface TaskPatch {
  title?: string
  providerId?: string
  mode?: RunMode
  workspacePath?: string
  includeImportedHistory?: boolean
}

export type TaskExportFormat = 'bundle' | 'markdown'

export interface ProviderTestResult {
  ok: boolean
  title: string
  detail: string
  models?: string[]
}

export interface DetectedCli {
  id: 'codex' | 'claude' | 'gemini'
  name: string
  path: string
  description: string
  draft: ProviderDraft
}

export interface TerminalDimensions {
  cols: number
  rows: number
}

export interface TerminalSessionInfo extends TerminalDimensions {
  id: string
  taskId: string
  pid: number
  createdAt: number
}

export type TerminalEvent =
  | {
      type: 'data'
      sessionId: string
      sequence: number
      data: string
      replayed: boolean
      timestamp: number
    }
  | {
      type: 'exit'
      sessionId: string
      exitCode: number | null
      signal?: number
      reason: 'process-exit' | 'disposed' | 'service-disposed'
      timestamp: number
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

export interface GitDiffResult {
  text: string
  truncated: boolean
  bytes: number
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

export interface GitWorktreeSummary {
  relativePath: string
  isMain: boolean
  head: string
  branch: string | null
  detached: boolean
  locked: boolean
  prunable: boolean
}

export interface GitIdentity {
  name?: string
  email?: string
}

export interface GitOverview {
  isRepository: boolean
  message?: string
  status?: GitStatusSummary
  identity?: GitIdentity
  unstagedDiff?: GitDiffResult
  stagedDiff?: GitDiffResult
  commits: GitLogEntry[]
  historyTruncated: boolean
  worktrees: GitWorktreeSummary[]
}

export interface CreateGitWorktreeInput {
  branch: string
  startPoint?: string
}

export interface GitCommitInput {
  message: string
  authorName: string
  authorEmail: string
}

export interface DesktopApi {
  getSnapshot: () => Promise<AppSnapshot>
  createTask: (workspacePath?: string) => Promise<Task>
  forkTask: (taskId: string) => Promise<Task>
  setTaskArchived: (taskId: string, archived: boolean) => Promise<Task>
  importTaskBundle: () => Promise<Task | undefined>
  exportTask: (taskId: string, format: TaskExportFormat) => Promise<boolean>
  deleteTask: (taskId: string) => Promise<boolean>
  selectTask: (taskId: string) => Promise<void>
  updateTask: (taskId: string, patch: TaskPatch) => Promise<Task>
  chooseWorkspace: () => Promise<string | undefined>
  revealWorkspace: (workspacePath: string) => Promise<void>
  saveProvider: (draft: ProviderDraft) => Promise<ProviderProfile>
  deleteProvider: (providerId: string) => Promise<void>
  testProvider: (draft: ProviderDraft) => Promise<ProviderTestResult>
  detectClis: () => Promise<DetectedCli[]>
  startRun: (input: StartRunInput) => Promise<{ runId: string }>
  stopRun: (taskId: string) => Promise<void>
  resolveApproval: (runId: string, approvalId: string, approved: boolean) => Promise<void>
  onRunEvent: (listener: (envelope: RunEventEnvelope) => void) => () => void
  listTerminals: (taskId: string) => Promise<TerminalSessionInfo[]>
  createTerminal: (
    taskId: string,
    dimensions?: Partial<TerminalDimensions>
  ) => Promise<TerminalSessionInfo | undefined>
  attachTerminal: (
    taskId: string,
    sessionId: string
  ) => Promise<{ attachmentId: string }>
  detachTerminal: (
    sessionId: string,
    attachmentId: string
  ) => Promise<void>
  terminalInput: (
    sessionId: string,
    attachmentId: string,
    data: string
  ) => Promise<void>
  terminalResize: (
    sessionId: string,
    attachmentId: string,
    dimensions: TerminalDimensions
  ) => Promise<TerminalSessionInfo>
  terminalClose: (
    sessionId: string,
    attachmentId: string
  ) => Promise<void>
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void
  getGitOverview: (taskId: string) => Promise<GitOverview>
  createGitWorktree: (
    taskId: string,
    input: CreateGitWorktreeInput
  ) => Promise<Task | undefined>
  stageGitPaths: (taskId: string, paths: string[]) => Promise<boolean>
  unstageGitPaths: (taskId: string, paths: string[]) => Promise<boolean>
  commitGitChanges: (
    taskId: string,
    input: GitCommitInput
  ) => Promise<GitLogEntry | undefined>
  removeGitWorktree: (
    taskId: string,
    relativePath: string
  ) => Promise<string[] | undefined>
  saveMcpServer: (draft: McpServerDraft) => Promise<McpServerProfile>
  deleteMcpServer: (serverId: string) => Promise<void>
  getMcpServerStatuses: () => Promise<McpServerStatus[]>
  connectMcpServer: (serverId: string) => Promise<McpServerStatus>
  trustMcpTools: (
    serverId: string,
    expectedFingerprints: Record<string, string>
  ) => Promise<McpServerStatus>
}
