export type RunMode = 'ask' | 'agent'
export type RunStatus = 'idle' | 'running' | 'awaiting-approval' | 'failed'
export type ActivityStatus = 'pending' | 'running' | 'success' | 'error' | 'denied'
export type ModelProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible'
export type ProviderKind = ModelProviderKind | 'cli'
export type CliAdapter =
  | 'generic'
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'antigravity'
export type ReasoningEffort = 'low' | 'medium' | 'high'

export const PROVIDER_FAILURE_KINDS = [
  'connection-refused',
  'dns',
  'tls',
  'authentication',
  'rate-limit',
  'timeout',
  'protocol-shape',
  'executable-not-found',
  'external-runtime-startup'
] as const

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number]

export type ProviderVerification =
  | {
      status: 'unverified'
    }
  | {
      status: 'passed'
      scope: 'connection' | 'configuration'
      checkedAt: string
    }
  | {
      status: 'failed'
      scope: 'connection' | 'configuration'
      checkedAt: string
      /**
       * A bounded main-process classification. Display diagnostics and
       * provider response text are deliberately never persisted.
       */
      failureKind?: ProviderFailureKind
    }

export interface BaseProvider {
  id: string
  name: string
  kind: ProviderKind
  model: string
  /**
   * A bounded status record for the exact persisted provider revision.
   * Missing records from older Ground versions are treated as unverified.
   */
  verification?: ProviderVerification
  createdAt: string
  updatedAt: string
}

interface BaseModelApiProvider extends BaseProvider {
  kind: ModelProviderKind
  baseUrl: string
  hasApiKey: boolean
  /**
   * Main-generated opaque selector for a versioned encrypted credential.
   * Older profiles omit it and continue to use their legacy boundary-scoped
   * vault entry. Renderer drafts can never choose this value.
   */
  credentialRevision?: string
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
  /**
   * Opaque selector for the exact versioned vault record. Profiles saved
   * before versioned CLI environment records omit it and use the legacy slot.
   */
  environmentRevision?: string
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
  /**
   * Stable source-registered AgentRuntimeAdapter identity.
   */
  adapterId: string
  /**
   * Adapter-defined opaque-session compatibility boundary. This can change
   * independently from adapterId when a new adapter release cannot safely
   * resume prior native sessions.
   */
  sessionCompatibilityId: string
  sessionId: string
  providerRevision: string
  /**
   * SHA-256 binding to the exact provider configuration. Older sessions omit
   * it and are invalidated rather than trusted through timestamp collisions.
   */
  providerFingerprint?: string
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
  /**
   * SHA-256 binding to the exact provider configuration. Older sessions omit
   * it and are invalidated rather than trusted through timestamp collisions.
   */
  providerFingerprint?: string
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

export type ManagedExecutionKind = 'workspace-write' | 'command' | 'mcp'

interface ManagedExecutionMarkerBase {
  version: 1
  /**
   * Durable operation identity. This must equal the owning ActivityItem.id.
   */
  operationId: string
  kind: ManagedExecutionKind
  startedAt: string
}

interface ApprovedManagedExecutionBase extends ManagedExecutionMarkerBase {
  claim: 'approved'
  /**
   * SHA-256 of the exact prepared side-effect envelope.
   */
  actionSha256: string
  /**
   * SHA-256 of the exact native approval envelope consumed at begin.
   */
  approvalSha256: string
}

export interface StartedManagedExecution extends ApprovedManagedExecutionBase {
  phase: 'started'
}

export interface CompletedManagedExecution extends ApprovedManagedExecutionBase {
  phase: 'completed'
  completedAt: string
}

export interface UncertainManagedExecution extends ApprovedManagedExecutionBase {
  phase: 'uncertain'
  interruptedAt: string
}

/**
 * Recovery marker for state written before durable operation claims existed.
 * It intentionally carries no synthetic approval or action hash.
 */
export interface LegacyUncertainManagedExecution
  extends ManagedExecutionMarkerBase {
  claim: 'legacy-untracked'
  phase: 'uncertain'
  interruptedAt: string
}

export type ManagedExecutionMarker =
  | StartedManagedExecution
  | CompletedManagedExecution
  | UncertainManagedExecution
  | LegacyUncertainManagedExecution

export interface BeginManagedExecutionInput {
  taskId: string
  itemId: string
  runId: string
  callId: string
  toolName: string
  kind: ManagedExecutionKind
  actionSha256: string
  approvalSha256: string
  startedAt: string
}

export interface CompleteManagedExecutionInput {
  taskId: string
  itemId: string
  operationId: string
  actionSha256: string
  status: Extract<ActivityStatus, 'success' | 'error'>
  result: string
  durationMs: number
  completedAt: string
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

type ActivityType =
  | 'status'
  | 'tool'
  | 'command'
  | 'approval'
  | 'error'
  | 'diagnostic'

interface ActivityItemBase {
  id: string
  kind: 'activity'
  runId: string
  title: string
  detail?: string
  createdAt: string
  approvalId?: string
  toolName?: string
  input?: Record<string, unknown>
  result?: string
  durationMs?: number
  historyOnly?: boolean
  callId?: string
  managedExecution?: ManagedExecutionMarker
  provider?: ProviderAttribution
}

export type ActivityItem =
  | (ActivityItemBase & {
      activityType: 'error'
      status: 'error'
      /**
       * Main-process-derived provider failure classification. Raw provider
       * codes, causes, response bodies, and credentials are never retained.
       */
      failureKind?: ProviderFailureKind
    })
  | (ActivityItemBase & {
      activityType: 'error'
      status: Exclude<ActivityStatus, 'error'>
      failureKind?: never
    })
  | (ActivityItemBase & {
      activityType: Exclude<ActivityType, 'error'>
      status: ActivityStatus
      failureKind?: never
    })

export type TaskItem = MessageItem | ActivityItem

/**
 * Renderer-safe activity projection. Managed execution claims are owned by the
 * main process and are never exposed over IPC.
 */
export type DesktopActivityItem = ActivityItem extends infer Item
  ? Item extends ActivityItem
    ? Omit<Item, 'managedExecution'> & { managedExecution?: never }
    : never
  : never

export type DesktopTaskItem = MessageItem | DesktopActivityItem

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

export interface WorkspaceGrant {
  id: string
  /**
   * Display-only, bounded folder basename. It is not filesystem authority.
   */
  name: string
}

/**
 * Explicit renderer allowlist for a task. Main-only workspace paths, native
 * runtime sessions, provider continuation state, and checkpoints are omitted.
 */
export interface DesktopTask {
  id: string
  title: string
  workspace?: WorkspaceGrant
  providerId: string
  mode: RunMode
  includeImportedHistory?: boolean
  runStatus: RunStatus
  archivedAt?: string
  createdAt: string
  updatedAt: string
  items: DesktopTaskItem[]
}

export interface AppSettings {
  selectedTaskId?: string
  defaultProviderId: string
  sidebarCollapsed: boolean
}

export interface RecoveryNotice {
  id: string
  kind: 'backup-restored' | 'credential-warning' | 'state-reset'
  title: string
  detail: string
}

export type LocalStateSnapshotStatus =
  | 'valid'
  | 'invalid'
  | 'unavailable'

/**
 * Renderer-safe metadata for a private local state generation. The opaque ID
 * is short-lived and content-bound; no application-data path crosses IPC.
 */
export interface LocalStateSnapshot {
  id: string
  kind: 'current' | 'retained'
  generation: number
  status: LocalStateSnapshotStatus
  capturedAt?: string
  sizeBytes?: number
  taskCount?: number
  providerCount?: number
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
  tasks: DesktopTask[]
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
  activeRunEvents?: DesktopRunEventEnvelope[]
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
      failureKind?: ProviderFailureKind
    }

export interface RunEventEnvelope {
  revision: number
  event: RunEvent
}

export type DesktopRunEvent =
  | {
      type: 'run-started'
      taskId: string
      runId: string
    }
  | {
      type: 'item-added'
      taskId: string
      runId: string
      item: DesktopTaskItem
    }
  | {
      type: 'text-delta'
      taskId: string
      runId: string
      itemId: string
      delta: string
      offset?: number
    }
  | {
      type: 'item-updated'
      taskId: string
      runId: string
      item: DesktopTaskItem
    }
  | {
      type: 'approval-requested'
      taskId: string
      runId: string
      item: DesktopActivityItem
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
      failureKind?: ProviderFailureKind
    }

export interface DesktopRunEventEnvelope {
  revision: number
  event: DesktopRunEvent
}

export interface TaskPatch {
  title?: string
  providerId?: string
  mode?: RunMode
  workspaceGrantId?: string
  includeImportedHistory?: boolean
}

export type TaskExportFormat = 'bundle' | 'markdown'

interface BaseProviderTestResult {
  title: string
  detail: string
  models?: string[]
  /**
   * True only when this result was retained on an unchanged saved profile.
   * Draft-only checks remain useful feedback but do not change saved status.
   */
  persisted?: boolean
}

export type ProviderTestResult =
  | (BaseProviderTestResult & {
      ok: true
    })
  | (BaseProviderTestResult & {
      ok: false
      /**
       * A bounded classification derived from structured main-process
       * evidence. Display diagnostics remain presentation-only.
       */
      failureKind?: ProviderFailureKind
    })

export interface DetectedCli {
  id: 'codex' | 'claude' | 'gemini' | 'antigravity'
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

export type GitRecoveryStatus = 'applied' | 'recovery-required' | 'restored'

/**
 * Path-only, renderer-safe projection of a main-owned Git recovery manifest.
 * Prepared snapshots, previews, host paths, and action fingerprints never
 * cross the IPC boundary.
 */
export interface GitRecoverySummary {
  id: string
  createdAt: string
  status: GitRecoveryStatus
  trackedPaths: string[]
  untrackedPaths: string[]
  canUndo: boolean
}

export interface GitOverview {
  isRepository: boolean
  message?: string
  requiresGitExecutable?: boolean
  status?: GitStatusSummary
  identity?: GitIdentity
  unstagedDiff?: GitDiffResult
  stagedDiff?: GitDiffResult
  commits: GitLogEntry[]
  historyTruncated: boolean
  worktrees: GitWorktreeSummary[]
  recoveries: GitRecoverySummary[]
  recoveriesTruncated: boolean
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
  listStateSnapshots: () => Promise<LocalStateSnapshot[]>
  exportStateSnapshot: (snapshotId: string) => Promise<boolean>
  restoreStateSnapshot: (snapshotId: string) => Promise<boolean>
  createTask: (workspaceGrantId?: string) => Promise<DesktopTask>
  forkTask: (taskId: string) => Promise<DesktopTask>
  setTaskArchived: (taskId: string, archived: boolean) => Promise<DesktopTask>
  importTaskBundle: () => Promise<DesktopTask | undefined>
  exportTask: (taskId: string, format: TaskExportFormat) => Promise<boolean>
  deleteTask: (taskId: string) => Promise<boolean>
  selectTask: (taskId: string) => Promise<void>
  updateTask: (taskId: string, patch: TaskPatch) => Promise<DesktopTask>
  chooseWorkspace: () => Promise<WorkspaceGrant | undefined>
  revealWorkspace: (workspaceGrantId: string) => Promise<void>
  saveProvider: (draft: ProviderDraft) => Promise<ProviderProfile>
  deleteProvider: (providerId: string) => Promise<void>
  testProvider: (draft: ProviderDraft) => Promise<ProviderTestResult>
  detectClis: () => Promise<DetectedCli[]>
  chooseCliExecutable: () => Promise<string | undefined>
  startRun: (input: StartRunInput) => Promise<{ runId: string }>
  stopRun: (taskId: string) => Promise<void>
  resolveApproval: (runId: string, approvalId: string, approved: boolean) => Promise<void>
  onRunEvent: (
    listener: (envelope: DesktopRunEventEnvelope) => void
  ) => () => void
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
  chooseGitExecutable: () => Promise<boolean>
  createGitWorktree: (
    taskId: string,
    input: CreateGitWorktreeInput
  ) => Promise<DesktopTask | undefined>
  stageGitPaths: (taskId: string, paths: string[]) => Promise<boolean>
  unstageGitPaths: (taskId: string, paths: string[]) => Promise<boolean>
  revertGitPaths: (
    taskId: string,
    paths: string[]
  ) => Promise<GitRecoverySummary | undefined>
  undoGitRecovery: (
    taskId: string,
    recoveryId: string
  ) => Promise<GitRecoverySummary | undefined>
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
