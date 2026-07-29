import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type {
  ActivityItem,
  AppSettings,
  BeginManagedExecutionInput,
  CompleteManagedExecutionInput,
  ManagedExecutionKind,
  McpServerProfile,
  LocalStateSnapshot,
  ModelApiProvider,
  ProviderAttribution,
  ProviderProfile,
  RecoveryNotice,
  StoredModelMessagePart,
  StoredModelConversationItem,
  Task,
  TaskItem
} from '../shared/types'
import { createId, nowIso } from './lib/ids'
import {
  MAX_PERSISTED_TASK_ITEMS,
  parsePersistedState,
  type PersistedStateData
} from './state-schema'
import { providerConfigurationFingerprint } from './provider-revision'
import type {
  GroundConversationItem,
  GroundProviderAttribution,
  GroundProviderDescriptor,
  GroundTaskImportTemplate
} from './task-portability'

export interface StateSnapshot {
  providers: ProviderProfile[]
  mcpServers: McpServerProfile[]
  tasks: Task[]
  settings: AppSettings
  recoveryNotice?: RecoveryNotice
}

const MODEL_ADAPTER_IDS: Record<ModelApiProvider['kind'], string> = {
  openai: 'openai.responses',
  anthropic: 'anthropic.messages',
  google: 'google.generative-ai',
  'openai-compatible': 'openai.compatible'
}

const IMPORT_FIELD_LIMITS = Object.freeze({
  taskTitle: 120,
  activityDetail: 100_000,
  activityResult: 100_000,
  toolName: 200,
  parseError: 10_000
})

const MAX_STATE_FILE_BYTES = 128 * 1024 * 1024
const STATE_READ_CHUNK_BYTES = 64 * 1024
const STATE_BACKUP_RETENTION = 3
const LOCAL_STATE_SNAPSHOT_ID_PATTERN =
  /^state_snapshot_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MANAGED_EXECUTION_OUTCOME_UNKNOWN =
  'Outcome unknown: Ground closed after this action started. Review the workspace or external system before deciding what to do next. Ground will not retry this action automatically.'
const LEGACY_MANAGED_EXECUTION_OUTCOME_UNKNOWN =
  'Outcome unknown: Ground closed while this mutating action was running before durable execution claims were available. Review the workspace or external system before deciding what to do next. Ground will not retry this action automatically.'
const MAX_INTERRUPTED_RUN_SUMMARIES = 256

interface LocalStateSnapshotSelection {
  filePath: string
  kind: LocalStateSnapshot['kind']
  generation: number
  status: LocalStateSnapshot['status']
  sourceSha256?: string
}

interface BoundedStateDocument {
  payload: string
  sizeBytes: number
  capturedAt: string
}

interface ValidStateMaterial extends BoundedStateDocument {
  sourceSha256: string
  state: PersistedStateData
  normalizedPayload: string
}

/**
 * Main-process review data re-derived from an opaque, content-bound snapshot
 * selection immediately before a native approval.
 */
export interface LocalStateSnapshotReview {
  id: string
  kind: LocalStateSnapshot['kind']
  generation: number
  capturedAt: string
  sizeBytes: number
  taskCount: number
  providerCount: number
  contentSha256: string
}

class InvalidStateFileError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'InvalidStateFileError'
  }
}

/**
 * A state write may have crossed its atomic rename before a later durability
 * operation failed. Callers must treat disk publication as uncertain and
 * relaunch before issuing another state mutation.
 */
export class StatePersistenceError extends Error {
  readonly code?: string

  constructor(cause: unknown) {
    super('Ground could not conclusively publish local state', { cause })
    this.name = 'StatePersistenceError'
    this.code = (cause as NodeJS.ErrnoException | undefined)?.code
  }
}

export interface StateStoreOptions {
  /**
   * Invoked after a state publication becomes ambiguous. The store seals
   * itself before calling this hook, so even a delayed process exit cannot
   * permit another mutation from stale in-memory state.
   */
  onPersistenceUncertain?: (error: StatePersistenceError) => void
  /**
   * Test seam for exercising post-publication failures without weakening the
   * production persistence implementation.
   */
  persistStateDocument?: (
    filePath: string,
    payload: string
  ) => Promise<void>
}

function boundedImportedText(value: string, maximum: number): string {
  const bounded = value.slice(0, maximum)
  return /[\ud800-\udbff]$/u.test(bounded) ? bounded.slice(0, -1) : bounded
}

function providerMatchesHint(
  provider: ProviderProfile,
  hint: GroundProviderDescriptor
): boolean {
  if (hint.type === 'agent-cli') {
    return (
      provider.kind === 'cli' &&
      provider.name === hint.name &&
      provider.model === hint.model &&
      (provider.cliAdapter ?? 'generic') === hint.adapter
    )
  }
  return (
    provider.kind !== 'cli' &&
    provider.kind === hint.kind &&
    provider.name === hint.name &&
    provider.model === hint.model &&
    provider.supportsTools === hint.supportsTools
  )
}

function importedConversation(
  conversation: GroundConversationItem[]
): StoredModelConversationItem[] {
  return conversation.map((item) => {
    if (item.kind === 'message') {
      return {
        kind: 'message',
        id: createId('message'),
        role: item.role,
        parts: item.parts.map((part) =>
          part.kind === 'tool-call'
            ? {
                ...structuredClone(part),
                name:
                  boundedImportedText(
                    part.name,
                    IMPORT_FIELD_LIMITS.toolName
                  ) || 'tool',
                parseError:
                  part.parseError === undefined
                    ? undefined
                    : boundedImportedText(
                        part.parseError,
                        IMPORT_FIELD_LIMITS.parseError
                      )
              }
            : structuredClone(part)
        )
      }
    }
    return {
      kind: 'tool-result',
      id: createId('tool-result'),
      callId: item.callId,
      name:
        item.name === undefined
          ? undefined
          : boundedImportedText(item.name, IMPORT_FIELD_LIMITS.toolName),
      content: structuredClone(item.content),
      isError: item.isError
    }
  })
}

function importedTaskTitle(value: string): string {
  return boundedImportedText(value, IMPORT_FIELD_LIMITS.taskTitle).trim() || 'Imported task'
}

function forkedTaskTitle(value: string): string {
  const suffix = ' (fork)'
  const maximumBaseLength = IMPORT_FIELD_LIMITS.taskTitle - suffix.length
  const base = boundedImportedText(value.trim(), maximumBaseLength).trimEnd()
  return `${base || 'Untitled task'}${suffix}`
}

function isTaskActive(task: Task): boolean {
  return task.runStatus === 'running' || task.runStatus === 'awaiting-approval'
}

function managedExecutionKind(
  item: Readonly<ActivityItem>
): ManagedExecutionKind | undefined {
  if (item.toolName === 'write_file' || item.toolName === 'edit_file') {
    return 'workspace-write'
  }
  if (item.toolName === 'run_command') return 'command'
  if (item.toolName?.startsWith('mcp__')) return 'mcp'
  return undefined
}

function requireSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`)
  }
}

function managedStartedAt(
  createdAt: string,
  recoveryTimestamp: string
): string {
  const parsed = Date.parse(createdAt)
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : recoveryTimestamp
}

function requireActivityItem(task: Task, itemId: string): ActivityItem {
  const item = task.items.find((candidate) => candidate.id === itemId)
  if (!item || item.kind !== 'activity') {
    throw new Error('Managed execution activity was not found')
  }
  return item
}

interface ForkIds {
  itemIds: Map<string, string>
  runIds: Map<string, string>
  callIds: Map<string, string>
}

function mappedForkId(
  values: Map<string, string>,
  source: string,
  prefix: string
): string {
  const existing = values.get(source)
  if (existing) return existing
  const created = createId(prefix)
  values.set(source, created)
  return created
}

function forkTimeline(items: TaskItem[], ids: ForkIds): TaskItem[] {
  return items.map((item): TaskItem => {
    const id = mappedForkId(ids.itemIds, item.id, item.kind)
    if (item.kind === 'message') {
      return {
        ...structuredClone(item),
        id,
        ...(item.runId
          ? { runId: mappedForkId(ids.runIds, item.runId, 'history-run') }
          : {})
      }
    }

    const {
      approvalId: _approvalId,
      callId: _callId,
      managedExecution: _managedExecution,
      ...history
    } = structuredClone(item)
    const status =
      item.status === 'pending' || item.status === 'running'
        ? 'error'
        : item.status
    return {
      ...history,
      id,
      runId: mappedForkId(ids.runIds, item.runId, 'history-run'),
      status,
      ...(item.callId
        ? {
            callId: mappedForkId(ids.callIds, item.callId, 'history-call')
          }
        : {})
    }
  })
}

function completeConversationCallIds(
  conversation: StoredModelConversationItem[]
): Set<string> {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const item of conversation) {
    if (item.kind === 'tool-result') {
      results.add(item.callId)
      continue
    }
    for (const part of item.parts) {
      if (part.kind === 'tool-call') calls.add(part.callId)
    }
  }
  return new Set([...calls].filter((callId) => results.has(callId)))
}

function forkConversationPart(
  part: StoredModelMessagePart,
  ids: ForkIds,
  completeCalls: Set<string>
): StoredModelMessagePart | undefined {
  if (part.kind === 'tool-call') {
    if (!completeCalls.has(part.callId)) return undefined
    return {
      kind: 'tool-call',
      callId: mappedForkId(ids.callIds, part.callId, 'history-call'),
      name: part.name,
      rawArguments: part.rawArguments,
      arguments:
        part.arguments === undefined
          ? undefined
          : structuredClone(part.arguments),
      parseError: part.parseError
    }
  }
  return {
    kind: part.kind,
    text: part.text
  }
}

function forkConversation(
  conversation: StoredModelConversationItem[],
  ids: ForkIds
): StoredModelConversationItem[] {
  const completeCalls = completeConversationCallIds(conversation)
  const forked: StoredModelConversationItem[] = []

  for (const item of conversation) {
    if (item.kind === 'tool-result') {
      if (!completeCalls.has(item.callId)) continue
      forked.push({
        kind: 'tool-result',
        id: createId('tool-result'),
        callId: mappedForkId(ids.callIds, item.callId, 'history-call'),
        name: item.name,
        content: structuredClone(item.content),
        isError: item.isError
      })
      continue
    }

    const parts = item.parts
      .map((part) => forkConversationPart(part, ids, completeCalls))
      .filter((part): part is StoredModelMessagePart => Boolean(part))
    if (!parts.length) continue
    forked.push({
      kind: 'message',
      id: mappedForkId(ids.itemIds, item.id, 'message'),
      role: item.role,
      parts
    })
  }
  return forked
}

function importedProviderAttribution(
  provider: GroundProviderAttribution,
  existingProviders: ProviderProfile[],
  syntheticIds: Map<string, string>
): ProviderAttribution {
  const existing = existingProviders.find(
    (candidate) =>
      candidate.kind === provider.kind &&
      candidate.name === provider.name &&
      candidate.model === provider.model
  )
  const key = `${provider.kind}\u0000${provider.name}\u0000${provider.model}`
  let id = existing?.id ?? syntheticIds.get(key)
  if (!id) {
    id = createId('history-provider')
    syntheticIds.set(key, id)
  }
  return {
    id,
    kind: provider.kind,
    name: provider.name,
    model: provider.model
  }
}

function createInitialState(): PersistedStateData {
  const timestamp = nowIso()
  return {
    version: 2,
    providers: [
      {
        id: 'ollama-local',
        name: 'Ollama · local',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'llama3.2',
        hasApiKey: false,
        supportsTools: true,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    mcpServers: [],
    tasks: [],
    settings: {
      defaultProviderId: 'ollama-local',
      sidebarCollapsed: false
    },
    pendingSecretDeletes: []
  }
}

export class StateStore {
  private state: PersistedStateData = createInitialState()
  private recoveryNotice: RecoveryNotice | undefined
  private stateRecoveryFallbackUsed = false
  private recoveryNoticeIds = new Set<string>()
  private localStateSnapshotSelections =
    new Map<string, LocalStateSnapshotSelection>()
  private transactionQueue: Promise<void> = Promise.resolve()
  private persistenceUncertainty?: StatePersistenceError
  private readonly onPersistenceUncertain?: (
    error: StatePersistenceError
  ) => void
  private readonly persistStateDocument: (
    filePath: string,
    payload: string
  ) => Promise<void>

  constructor(
    private readonly filePath: string,
    options: StateStoreOptions = {}
  ) {
    this.onPersistenceUncertain = options.onPersistenceUncertain
    this.persistStateDocument =
      options.persistStateDocument ?? persistState
  }

  async load(): Promise<void> {
    await this.enqueueTransaction(async () => {
      const backupPaths = stateBackupPaths(this.filePath)
      let candidate: PersistedStateData | undefined
      let rewritePrimary = false
      let nextRecoveryNotice: RecoveryNotice | undefined

      try {
        candidate = await readStateFile(this.filePath)
      } catch (primaryError) {
        if (!isStateRecoveryError(primaryError)) throw primaryError
        const recoveryErrors: unknown[] = [primaryError]
        if (isCorruptStateFileError(primaryError)) {
          await quarantineCorruptFile(this.filePath)
        }
        for (const backupPath of backupPaths) {
          try {
            candidate = await readStateFile(backupPath)
            break
          } catch (backupError) {
            if (!isStateRecoveryError(backupError)) throw backupError
            recoveryErrors.push(backupError)
            if (isCorruptStateFileError(backupError)) {
              await quarantineCorruptFile(backupPath)
            }
          }
        }

        rewritePrimary = true
        if (candidate) {
          nextRecoveryNotice = {
            id: `backup-restored:${Date.now()}`,
            kind: 'backup-restored',
            title: 'Recovered local history',
            detail:
              'Ground could not read the newest state file and restored a retained last-known-good local backup. Unreadable files were preserved for diagnosis.'
          }
        } else {
          candidate = createInitialState()
          if (recoveryErrors.some((error) => !isMissingStateFileError(error))) {
            nextRecoveryNotice = {
              id: `state-reset:${Date.now()}`,
              kind: 'state-reset',
              title: 'Local state needs attention',
              detail:
                'Ground could not validate the saved state or any retained backup, so it opened a clean local workspace. Unreadable files were preserved for diagnosis.'
            }
          }
        }
      }

      if (!candidate) throw new Error('Ground state recovery produced no state')
      const recoveredCandidate = structuredClone(candidate)
      const recovered = recoverInterruptedRuns(recoveredCandidate)
      const normalized = normalizeState(recoveredCandidate)
      if (rewritePrimary || recovered) {
        await this.persistStateDocument(this.filePath, normalized.payload)
      }

      this.state = normalized.state
      this.recoveryNotice = nextRecoveryNotice
      this.stateRecoveryFallbackUsed =
        nextRecoveryNotice?.kind === 'backup-restored' ||
        nextRecoveryNotice?.kind === 'state-reset'
      this.recoveryNoticeIds = new Set(
        nextRecoveryNotice ? [nextRecoveryNotice.id] : []
      )
    })
  }

  addRecoveryNotice(notice: RecoveryNotice): void {
    const incoming = structuredClone(notice)
    if (this.recoveryNoticeIds.has(incoming.id)) return
    this.recoveryNoticeIds.add(incoming.id)
    const current = this.recoveryNotice
    if (!current) {
      this.recoveryNotice = incoming
      return
    }
    const severity: Record<RecoveryNotice['kind'], number> = {
      'backup-restored': 0,
      'credential-warning': 1,
      'state-reset': 2
    }
    const detail = [current.detail, incoming.detail]
      .filter((value, index, values) => values.indexOf(value) === index)
      .join('\n\n')
    this.recoveryNotice = {
      id: `combined:${[...this.recoveryNoticeIds].sort().join('|')}`,
      kind:
        severity[incoming.kind] > severity[current.kind]
          ? incoming.kind
          : current.kind,
      title: 'Local data needs attention',
      detail
    }
  }

  snapshot(): StateSnapshot {
    return structuredClone({
      providers: this.state.providers,
      mcpServers: this.state.mcpServers,
      tasks: this.state.tasks,
      settings: this.state.settings,
      recoveryNotice: this.recoveryNotice
    })
  }

  getTask(taskId: string): Task {
    return structuredClone(this.requireTask(taskId))
  }

  private requireTask(taskId: string): Task {
    return requireTask(this.state, taskId)
  }

  getProvider(providerId: string): ProviderProfile {
    const provider = this.state.providers.find((candidate) => candidate.id === providerId)
    if (!provider) throw new Error('Provider not found')
    return structuredClone(provider)
  }

  pendingSecretDeletes(): string[] {
    return structuredClone(this.state.pendingSecretDeletes)
  }

  shouldDeferPendingSecretDeletes(): boolean {
    return this.stateRecoveryFallbackUsed
  }

  getMcpServer(serverId: string): McpServerProfile {
    const server = this.state.mcpServers.find((candidate) => candidate.id === serverId)
    if (!server) throw new Error('MCP server not found')
    return structuredClone(server)
  }

  async saveMcpServer(server: McpServerProfile): Promise<McpServerProfile> {
    const serverSnapshot = structuredClone(server)
    return this.changeState(
      (state) => {
        const index = state.mcpServers.findIndex(
          (candidate) => candidate.id === serverSnapshot.id
        )
        if (index === -1) state.mcpServers.push(serverSnapshot)
        else state.mcpServers[index] = serverSnapshot
        return serverSnapshot.id
      },
      (state, serverId) => requireMcpServer(state, serverId)
    )
  }

  async deleteMcpServer(serverId: string): Promise<void> {
    await this.changeState(
      (state) => {
        const before = state.mcpServers.length
        state.mcpServers = state.mcpServers.filter(
          (candidate) => candidate.id !== serverId
        )
        if (state.mcpServers.length === before) {
          throw new Error('MCP server not found')
        }
      },
      () => undefined
    )
  }

  async createTask(workspacePath?: string): Promise<Task> {
    return this.changeState(
      (state) => {
        const timestamp = nowIso()
        const provider =
          state.providers.find(
            (candidate) =>
              candidate.id === state.settings.defaultProviderId
          ) ?? state.providers[0]
        if (!provider) throw new Error('Connect a provider before creating a task')
        state.settings.defaultProviderId = provider.id
        const task: Task = {
          id: createId('task'),
          title: 'New task',
          workspacePath,
          providerId: provider.id,
          mode: 'agent',
          runStatus: 'idle',
          createdAt: timestamp,
          updatedAt: timestamp,
          items: []
        }
        state.tasks.unshift(task)
        state.settings.selectedTaskId = task.id
        return task.id
      },
      (state, taskId) => requireTask(state, taskId)
    )
  }

  async forkTask(taskId: string): Promise<Task> {
    return this.changeState(
      (state) => {
        const source = requireTask(state, taskId)
        if (isTaskActive(source)) {
          throw new Error('Stop this task before forking it')
        }

        const timestamp = nowIso()
        const ids: ForkIds = {
          itemIds: new Map(),
          runIds: new Map(),
          callIds: new Map()
        }
        const task: Task = {
          id: createId('task'),
          title: forkedTaskTitle(source.title),
          workspacePath: source.workspacePath,
          providerId: source.providerId,
          mode: source.mode,
          includeImportedHistory: source.includeImportedHistory,
          runStatus: 'idle',
          createdAt: timestamp,
          updatedAt: timestamp,
          items: forkTimeline(source.items, ids)
        }

        if (source.modelSessions) {
          const sessions = Object.entries(source.modelSessions).map(
            ([providerId, session]) => [
              providerId,
              {
                adapterId: session.adapterId,
                providerRevision: session.providerRevision,
                providerFingerprint: session.providerFingerprint,
                model: session.model,
                workspacePath: session.workspacePath,
                mode: session.mode,
                includesImportedHistory: session.includesImportedHistory,
                origin: session.origin,
                conversation: forkConversation(session.conversation, ids),
                updatedAt: timestamp
              }
            ] as const
          )
          if (sessions.length) task.modelSessions = Object.fromEntries(sessions)
        }

        state.tasks.unshift(task)
        state.settings.selectedTaskId = task.id
        return task.id
      },
      (state, forkedTaskId) => requireTask(state, forkedTaskId)
    )
  }

  async setTaskArchived(taskId: string, archived: boolean): Promise<Task> {
    return this.changeState(
      (state) => {
        const task = requireTask(state, taskId)
        if (isTaskActive(task)) {
          throw new Error(
            `Stop this task before ${archived ? 'archiving' : 'unarchiving'} it`
          )
        }

        if (archived) task.archivedAt ??= nowIso()
        else delete task.archivedAt
        task.updatedAt = nowIso()

        if (archived && state.settings.selectedTaskId === task.id) {
          state.settings.selectedTaskId = state.tasks.find(
            (candidate) => candidate.id !== task.id && !candidate.archivedAt
          )?.id
        } else if (!archived) {
          state.settings.selectedTaskId = task.id
        }
        return task.id
      },
      (state, archivedTaskId) => requireTask(state, archivedTaskId)
    )
  }

  async importTask(template: GroundTaskImportTemplate): Promise<Task> {
    const templateSnapshot = structuredClone(template)
    return this.changeState(
      (state) => {
        const exactProvider = state.providers.find((provider) =>
          providerMatchesHint(provider, templateSnapshot.provider)
        )
        const selectedProvider = state.tasks.find(
          (task) => task.id === state.settings.selectedTaskId
        )?.providerId
        const fallbackProvider =
          state.providers.find((provider) => provider.id === selectedProvider) ??
          state.providers[0]
        const provider = exactProvider ?? fallbackProvider
        if (!provider) throw new Error('Connect a provider before importing a task')

        const timestamp = nowIso()
        const historyRunId = createId('import')
        const syntheticProviderIds = new Map<string, string>()
        const task: Task = {
          id: createId('task'),
          title: importedTaskTitle(templateSnapshot.title),
          providerId: provider.id,
          mode: templateSnapshot.mode,
          includeImportedHistory: false,
          runStatus: 'idle',
          createdAt: timestamp,
          updatedAt: timestamp,
          items: templateSnapshot.timeline.map((entry): TaskItem => {
            if (entry.kind === 'message') {
              return {
                id: createId('message'),
                kind: 'message',
                role: entry.role,
                content: entry.content,
                createdAt: timestamp,
                historyOnly: true,
                ...(entry.provider === undefined
                  ? {}
                  : {
                      provider: importedProviderAttribution(
                        entry.provider,
                        state.providers,
                        syntheticProviderIds
                      )
                    })
              }
            }
            return {
              id: createId('activity'),
              kind: 'activity',
              runId: historyRunId,
              activityType: entry.activityType,
              title: entry.title,
              detail:
                entry.detail === undefined
                  ? undefined
                  : boundedImportedText(
                      entry.detail,
                      IMPORT_FIELD_LIMITS.activityDetail
                    ),
              status: entry.status === 'interrupted' ? 'error' : entry.status,
              createdAt: timestamp,
              toolName:
                entry.toolName === undefined
                  ? undefined
                  : boundedImportedText(
                      entry.toolName,
                      IMPORT_FIELD_LIMITS.toolName
                    ),
              input:
                entry.input === undefined
                  ? undefined
                  : structuredClone(entry.input),
              result:
                entry.result === undefined
                  ? undefined
                  : boundedImportedText(
                      entry.result,
                      IMPORT_FIELD_LIMITS.activityResult
                    ),
              durationMs: entry.durationMs,
              historyOnly: true,
              ...(entry.provider === undefined
                ? {}
                : {
                    provider: importedProviderAttribution(
                      entry.provider,
                      state.providers,
                      syntheticProviderIds
                    )
                  })
            }
          })
        }

        if (
          exactProvider &&
          exactProvider.kind !== 'cli' &&
          templateSnapshot.provider.type === 'model-api' &&
          templateSnapshot.conversation.length
        ) {
          task.modelSessions = {
            [exactProvider.id]: {
              adapterId: MODEL_ADAPTER_IDS[exactProvider.kind],
              providerRevision: exactProvider.updatedAt,
              providerFingerprint:
                providerConfigurationFingerprint(exactProvider),
              model: exactProvider.model,
              mode: templateSnapshot.mode,
              includesImportedHistory: true,
              origin: 'imported',
              conversation: importedConversation(
                templateSnapshot.conversation
              ),
              updatedAt: timestamp
            }
          }
        }

        state.tasks.unshift(task)
        state.settings.selectedTaskId = task.id
        return task.id
      },
      (state, importedTaskId) => requireTask(state, importedTaskId)
    )
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.changeState(
      (state) => {
        const task = requireTask(state, taskId)
        if (isTaskActive(task)) {
          throw new Error('Stop this task before deleting it')
        }
        const index = state.tasks.findIndex(
          (candidate) => candidate.id === task.id
        )
        state.tasks.splice(index, 1)
        if (state.settings.selectedTaskId === task.id) {
          state.settings.selectedTaskId =
            state.tasks.find((candidate) => !candidate.archivedAt)?.id ??
            state.tasks[0]?.id
        }
      },
      () => undefined
    )
  }

  async selectTask(taskId: string): Promise<void> {
    await this.changeState(
      (state) => {
        requireTask(state, taskId)
        state.settings.selectedTaskId = taskId
      },
      () => undefined
    )
  }

  async mutateTask(
    taskId: string,
    mutation: (task: Task) => void,
    persist = true
  ): Promise<Task> {
    return this.changeState(
      (state) => {
        const task = requireTask(state, taskId)
        const previousProviderId = task.providerId
        mutation(task)
        if (
          task.providerId !== previousProviderId &&
          state.providers.some(
            (provider) => provider.id === task.providerId
          )
        ) {
          state.settings.defaultProviderId = task.providerId
        }
        task.updatedAt = nowIso()
        return task.id
      },
      (state, mutatedTaskId) => requireTask(state, mutatedTaskId),
      persist
    )
  }

  /**
   * Atomically consumes one exact pending approval and persists the durable
   * execution claim before its caller may perform the side effect.
   */
  async beginManagedExecution(
    input: Readonly<BeginManagedExecutionInput>
  ): Promise<ActivityItem> {
    const claim = structuredClone(input)
    requireSha256(claim.actionSha256, 'Action hash')
    requireSha256(claim.approvalSha256, 'Approval hash')
    return this.changeState(
      (state) => {
        const task = requireTask(state, claim.taskId)
        if (task.archivedAt) {
          throw new Error('Archived tasks cannot begin managed execution')
        }
        if (task.runStatus !== 'awaiting-approval') {
          throw new Error(
            'Managed execution requires the task to be awaiting approval'
          )
        }
        const item = requireActivityItem(task, claim.itemId)
        if (
          item.status !== 'pending' ||
          item.activityType !== 'approval' ||
          !item.approvalId ||
          item.managedExecution
        ) {
          throw new Error(
            'Managed execution requires an unconsumed pending approval'
          )
        }
        if (
          item.runId !== claim.runId ||
          item.callId !== claim.callId ||
          item.toolName !== claim.toolName
        ) {
          throw new Error(
            'Managed execution identity does not match the pending approval'
          )
        }
        if (item.historyOnly) {
          throw new Error('Imported history cannot begin managed execution')
        }
        if (
          managedExecutionKind(item) !== claim.kind
        ) {
          throw new Error(
            'Managed execution kind does not match the pending activity'
          )
        }
        for (const candidateTask of state.tasks) {
          for (const candidate of candidateTask.items) {
            if (
              candidate.kind !== 'activity' ||
              !candidate.managedExecution
            ) {
              continue
            }
            if (candidate.managedExecution.operationId === item.id) {
              throw new Error('Managed execution operation already exists')
            }
            if (
              candidate.managedExecution.claim === 'approved' &&
              candidate.runId === claim.runId &&
              candidate.callId === claim.callId
            ) {
              throw new Error(
                'Managed execution call already has a durable claim'
              )
            }
          }
        }

        item.status = 'running'
        item.activityType =
          claim.kind === 'command' ? 'command' : 'tool'
        delete item.approvalId
        delete item.result
        delete item.durationMs
        item.managedExecution = {
          version: 1,
          operationId: item.id,
          claim: 'approved',
          kind: claim.kind,
          actionSha256: claim.actionSha256,
          approvalSha256: claim.approvalSha256,
          phase: 'started',
          startedAt: claim.startedAt
        }
        task.runStatus = 'running'
        task.updatedAt = nowIso()
        return { taskId: task.id, itemId: item.id }
      },
      (state, started) =>
        requireActivityItem(
          requireTask(state, started.taskId),
          started.itemId
        )
    )
  }

  /**
   * Atomically records the known result of exactly one started claim. An
   * uncertain or already completed operation can never pass this transition.
   */
  async completeManagedExecution(
    input: Readonly<CompleteManagedExecutionInput>
  ): Promise<ActivityItem> {
    const completion = structuredClone(input)
    requireSha256(completion.actionSha256, 'Action hash')
    return this.changeState(
      (state) => {
        const task = requireTask(state, completion.taskId)
        const item = requireActivityItem(task, completion.itemId)
        const marker = item.managedExecution
        if (
          !marker ||
          marker.operationId !== completion.operationId ||
          marker.operationId !== item.id ||
          marker.claim !== 'approved' ||
          marker.phase !== 'started' ||
          item.status !== 'running'
        ) {
          throw new Error(
            marker?.phase === 'uncertain'
              ? 'Managed execution outcome is unknown and cannot be completed or retried'
              : 'Managed execution is not an exact started claim'
          )
        }
        if (marker.actionSha256 !== completion.actionSha256) {
          throw new Error(
            'Managed execution action hash does not match the started claim'
          )
        }

        item.status = completion.status
        item.result = completion.result
        item.durationMs = completion.durationMs
        item.managedExecution = {
          ...marker,
          phase: 'completed',
          completedAt: completion.completedAt
        }
        task.updatedAt = nowIso()
        return { taskId: task.id, itemId: item.id }
      },
      (state, completed) =>
        requireActivityItem(
          requireTask(state, completed.taskId),
          completed.itemId
        )
    )
  }

  async addItem(taskId: string, item: TaskItem, persist = true): Promise<void> {
    // Capture the event at invocation time. Streaming callers intentionally
    // keep mutating their renderer-facing item after queueing the insertion.
    const itemSnapshot = structuredClone(item)
    await this.mutateTask(
      taskId,
      (task) => {
        task.items.push(itemSnapshot)
      },
      persist
    )
  }

  async updateItem(
    taskId: string,
    itemId: string,
    mutation: (item: TaskItem) => void,
    persist = true
  ): Promise<TaskItem> {
    return this.changeState(
      (state) => {
        const task = requireTask(state, taskId)
        const item = task.items.find((candidate) => candidate.id === itemId)
        if (!item) throw new Error('Timeline item not found')
        mutation(item)
        task.updatedAt = nowIso()
        return { taskId: task.id, itemId: item.id }
      },
      (state, updated) => {
        const item = requireTask(state, updated.taskId).items.find(
          (candidate) => candidate.id === updated.itemId
        )
        if (!item) throw new Error('Timeline item not found')
        return item
      },
      persist
    )
  }

  async upsertProvider(provider: ProviderProfile): Promise<void> {
    const providerSnapshot = structuredClone(provider)
    await this.changeState(
      (state) => {
        const index = state.providers.findIndex(
          (candidate) => candidate.id === providerSnapshot.id
        )
        if (index === -1) state.providers.push(providerSnapshot)
        else state.providers[index] = providerSnapshot
      },
      () => undefined
    )
  }

  async queueProvisionalSecretDelete(reference: string): Promise<void> {
    await this.changeState(
      (state) => {
        if (!state.pendingSecretDeletes.includes(reference)) {
          state.pendingSecretDeletes.push(reference)
        }
      },
      () => undefined
    )
  }

  async publishProviderSecretTransition(
    provider: ProviderProfile,
    stagedReference: string | undefined,
    obsoleteReferences: readonly string[]
  ): Promise<void> {
    const providerSnapshot = structuredClone(provider)
    await this.changeState(
      (state) => {
        const index = state.providers.findIndex(
          (candidate) => candidate.id === providerSnapshot.id
        )
        if (index === -1) state.providers.push(providerSnapshot)
        else state.providers[index] = providerSnapshot
        const pending = new Set(state.pendingSecretDeletes)
        if (stagedReference) pending.delete(stagedReference)
        for (const reference of obsoleteReferences) {
          if (reference !== stagedReference) pending.add(reference)
        }
        state.pendingSecretDeletes = [...pending]
      },
      () => undefined
    )
  }

  async acknowledgeSecretDeletes(
    references: readonly string[]
  ): Promise<void> {
    const acknowledged = new Set(references)
    await this.changeState(
      (state) => {
        state.pendingSecretDeletes = state.pendingSecretDeletes.filter(
          (reference) => !acknowledged.has(reference)
        )
      },
      () => undefined
    )
  }

  async deleteProvider(providerId: string): Promise<void> {
    await this.changeState(
      (state) => {
        if (state.providers.length <= 1) {
          throw new Error('Keep at least one provider connected')
        }
        const index = state.providers.findIndex(
          (candidate) => candidate.id === providerId
        )
        if (index === -1) return
        state.providers.splice(index, 1)
        const fallback = state.providers[0]
        if (!fallback) return
        if (state.settings.defaultProviderId === providerId) {
          state.settings.defaultProviderId = fallback.id
        }
        for (const task of state.tasks) {
          if (task.providerId === providerId) task.providerId = fallback.id
        }
      },
      () => undefined
    )
  }

  async deleteProviderWithSecretTransition(
    providerId: string,
    obsoleteReferences: readonly string[]
  ): Promise<void> {
    await this.changeState(
      (state) => {
        if (state.providers.length <= 1) {
          throw new Error('Keep at least one provider connected')
        }
        const index = state.providers.findIndex(
          (candidate) => candidate.id === providerId
        )
        if (index === -1) return
        state.providers.splice(index, 1)
        const fallback = state.providers[0]
        if (fallback) {
          if (state.settings.defaultProviderId === providerId) {
            state.settings.defaultProviderId = fallback.id
          }
          for (const task of state.tasks) {
            if (task.providerId === providerId) {
              task.providerId = fallback.id
            }
          }
        }
        const pending = new Set(state.pendingSecretDeletes)
        for (const reference of obsoleteReferences) pending.add(reference)
        state.pendingSecretDeletes = [...pending]
      },
      () => undefined
    )
  }

  async addActivity(taskId: string, activity: ActivityItem): Promise<void> {
    await this.addItem(taskId, activity)
  }

  async flush(): Promise<void> {
    await this.changeState(
      () => undefined,
      () => undefined
    )
  }

  async settledSnapshot(): Promise<StateSnapshot> {
    return this.enqueueTransaction(async () => this.snapshot())
  }

  async listLocalStateSnapshots(): Promise<LocalStateSnapshot[]> {
    return this.enqueueTransaction(async () => {
      const slots = [
        {
          filePath: this.filePath,
          kind: 'current' as const,
          generation: 0
        },
        ...stateBackupPaths(this.filePath).map((filePath, index) => ({
          filePath,
          kind: 'retained' as const,
          generation: index + 1
        }))
      ]
      const selections = new Map<string, LocalStateSnapshotSelection>()
      const snapshots: LocalStateSnapshot[] = []
      for (const slot of slots) {
        const id = `state_snapshot_${randomUUID()}`
        let document: BoundedStateDocument
        try {
          document = await readBoundedStateDocument(slot.filePath)
        } catch (error) {
          const status =
            error instanceof InvalidStateFileError ||
            errorCode(error) === 'ELOOP'
              ? 'invalid'
              : 'unavailable'
          selections.set(id, { ...slot, status })
          snapshots.push({
            id,
            kind: slot.kind,
            generation: slot.generation,
            status
          })
          continue
        }
        try {
          const material = validStateMaterialFromDocument(document)
          selections.set(id, {
            ...slot,
            status: 'valid',
            sourceSha256: material.sourceSha256
          })
          snapshots.push({
            id,
            kind: slot.kind,
            generation: slot.generation,
            status: 'valid',
            capturedAt: material.capturedAt,
            sizeBytes: material.sizeBytes,
            taskCount: material.state.tasks.length,
            providerCount: material.state.providers.length
          })
        } catch {
          selections.set(id, { ...slot, status: 'invalid' })
          snapshots.push({
            id,
            kind: slot.kind,
            generation: slot.generation,
            status: 'invalid',
            capturedAt: document.capturedAt,
            sizeBytes: document.sizeBytes
          })
        }
      }
      this.localStateSnapshotSelections = selections
      return structuredClone(snapshots)
    })
  }

  async exportLocalStateSnapshot(
    snapshotId: string,
    targetPath: string
  ): Promise<void> {
    await this.enqueueTransaction(async () => {
      if (!path.isAbsolute(targetPath)) {
        throw new Error('Snapshot export destination must be absolute')
      }
      const material = await this.readSelectedLocalStateSnapshot(
        snapshotId,
        false
      )
      await writePrivateSnapshotFile(targetPath, material.normalizedPayload)
    })
  }

  async assertLocalStateSnapshotSelection(
    snapshotId: string,
    retainedOnly: boolean
  ): Promise<LocalStateSnapshotReview> {
    return this.enqueueTransaction(async () => {
      const material = await this.readSelectedLocalStateSnapshot(
        snapshotId,
        retainedOnly
      )
      const selection = this.localStateSnapshotSelections.get(snapshotId)
      if (!selection) {
        throw new Error('Snapshot selection expired; refresh local snapshots')
      }
      return structuredClone({
        id: snapshotId,
        kind: selection.kind,
        generation: selection.generation,
        capturedAt: material.capturedAt,
        sizeBytes: material.sizeBytes,
        taskCount: material.state.tasks.length,
        providerCount: material.state.providers.length,
        contentSha256: material.sourceSha256
      } satisfies LocalStateSnapshotReview)
    })
  }

  async restoreLocalStateSnapshot(snapshotId: string): Promise<void> {
    await this.enqueueTransaction(async () => {
      const material = await this.readSelectedLocalStateSnapshot(
        snapshotId,
        true
      )
      const candidate = structuredClone(material.state)
      recoverInterruptedRuns(candidate)
      const normalized = normalizeState(candidate)
      await this.publishRuntimeState(normalized.payload)
      this.state = normalized.state
      this.localStateSnapshotSelections.clear()
    })
  }

  private async readSelectedLocalStateSnapshot(
    snapshotId: string,
    retainedOnly: boolean
  ): Promise<ValidStateMaterial> {
    if (
      typeof snapshotId !== 'string' ||
      !LOCAL_STATE_SNAPSHOT_ID_PATTERN.test(snapshotId)
    ) {
      throw new Error('Snapshot identifier is invalid')
    }
    const selection = this.localStateSnapshotSelections.get(snapshotId)
    if (!selection) {
      throw new Error('Snapshot selection expired; refresh local snapshots')
    }
    if (retainedOnly && selection.kind !== 'retained') {
      throw new Error('Only a retained snapshot can be restored')
    }
    if (selection.status !== 'valid' || !selection.sourceSha256) {
      throw new Error('Selected snapshot is not available for this action')
    }
    let material: ValidStateMaterial
    try {
      material = await readValidStateMaterial(selection.filePath)
    } catch {
      throw new Error(
        'Selected snapshot changed or became unavailable; refresh local snapshots'
      )
    }
    if (material.sourceSha256 !== selection.sourceSha256) {
      throw new Error(
        'Selected snapshot changed or became unavailable; refresh local snapshots'
      )
    }
    return material
  }

  private changeState<Token, Result>(
    mutate: (candidate: PersistedStateData) => Token,
    project: (normalized: PersistedStateData, token: Token) => Result,
    persist = true
  ): Promise<Result> {
    return this.enqueueTransaction(async () => {
      this.assertPersistenceCertain()
      const candidate = structuredClone(this.state)
      const token = mutate(candidate)
      const normalized = normalizeState(candidate)
      const result = structuredClone(project(normalized.state, token))
      if (persist) {
        await this.publishRuntimeState(normalized.payload)
      }
      this.state = normalized.state
      return result
    })
  }

  private assertPersistenceCertain(): void {
    if (this.persistenceUncertainty) {
      throw this.persistenceUncertainty
    }
  }

  private async publishRuntimeState(payload: string): Promise<void> {
    this.assertPersistenceCertain()
    try {
      await this.persistStateDocument(this.filePath, payload)
    } catch (error) {
      if (!(error instanceof StatePersistenceError)) throw error
      this.persistenceUncertainty = error
      try {
        this.onPersistenceUncertain?.(error)
      } catch {
        // The store is already sealed. Preserve the publication error that
        // explains why the process must exit rather than trusting callback
        // behavior.
      }
      throw error
    }
  }

  private enqueueTransaction<Result>(
    operation: () => Promise<Result>
  ): Promise<Result> {
    const result = this.transactionQueue.then(operation)
    this.transactionQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function requireTask(state: PersistedStateData, taskId: string): Task {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error('Task not found')
  return task
}

function requireMcpServer(
  state: PersistedStateData,
  serverId: string
): McpServerProfile {
  const server = state.mcpServers.find((candidate) => candidate.id === serverId)
  if (!server) throw new Error('MCP server not found')
  return server
}

function normalizeState(candidate: PersistedStateData): {
  state: PersistedStateData
  payload: string
} {
  // Zod creates the canonical object graph first, so unknown fields are
  // stripped before serialization and can never leak into durable state.
  const state = parsePersistedState(candidate)
  const payload = JSON.stringify(state, null, 2)
  if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_FILE_BYTES) {
    throw new Error('Ground state exceeds its local size limit')
  }
  return { state, payload }
}

async function readStateFile(filePath: string): Promise<PersistedStateData> {
  return parseStatePayload(await readBoundedStateFile(filePath))
}

async function readValidStatePayload(filePath: string): Promise<string> {
  return JSON.stringify(
    parseStatePayload(await readBoundedStateFile(filePath)),
    null,
    2
  )
}

async function readValidStateMaterial(
  filePath: string
): Promise<ValidStateMaterial> {
  const document = await readBoundedStateDocument(filePath)
  return validStateMaterialFromDocument(document)
}

function validStateMaterialFromDocument(
  document: BoundedStateDocument
): ValidStateMaterial {
  const parsed = parseStatePayload(document.payload)
  let normalized: ReturnType<typeof normalizeState>
  try {
    normalized = normalizeState(parsed)
  } catch (error) {
    throw new InvalidStateFileError(
      'Ground state cannot be normalized safely',
      error
    )
  }
  return {
    ...document,
    sourceSha256: createHash('sha256')
      .update(document.payload, 'utf8')
      .digest('hex'),
    state: normalized.state,
    normalizedPayload: normalized.payload
  }
}

async function persistState(filePath: string, payload: string): Promise<void> {
  const directory = path.dirname(filePath)
  const backupPaths = stateBackupPaths(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = await writePrivateTemporaryFile(
    directory,
    path.basename(filePath),
    payload
  )
  let temporaryCreated = true
  let primaryPublicationAttempted = false
  try {
    let previousPayload: string | undefined
    try {
      previousPayload = await readValidStatePayload(filePath)
    } catch (error) {
      if (
        !(error instanceof InvalidStateFileError) &&
        !isMissingStateFileError(error)
      ) {
        throw error
      }
      // An absent or structurally corrupt primary must not replace the last
      // known-good backup. Operational read failures remain fatal.
    }

    if (previousPayload !== undefined) {
      const retainedPayloads: Array<string | undefined> = []
      for (const backupPath of backupPaths.slice(0, -1)) {
        try {
          retainedPayloads.push(await readValidStatePayload(backupPath))
        } catch (error) {
          if (
            !(error instanceof InvalidStateFileError) &&
            !isMissingStateFileError(error)
          ) {
            throw error
          }
          retainedPayloads.push(undefined)
        }
      }
      for (let index = retainedPayloads.length - 1; index >= 0; index -= 1) {
        const retainedPayload = retainedPayloads[index]
        const target = backupPaths[index + 1]
        if (retainedPayload && target) {
          await replacePrivateStateFile(target, retainedPayload)
        }
      }
      const newestBackup = backupPaths[0]
      if (!newestBackup) throw new Error('Ground backup retention is invalid')
      await replacePrivateStateFile(newestBackup, previousPayload)
    }

    primaryPublicationAttempted = true
    await rename(temporary, filePath)
    temporaryCreated = false
    await syncDirectory(directory)
  } catch (error) {
    if (
      primaryPublicationAttempted &&
      !(error instanceof StatePersistenceError)
    ) {
      throw new StatePersistenceError(error)
    }
    throw error
  } finally {
    if (temporaryCreated) {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

function stateBackupPaths(filePath: string): string[] {
  return Array.from({ length: STATE_BACKUP_RETENTION }, (_, index) =>
    index === 0 ? `${filePath}.bak` : `${filePath}.bak.${index + 1}`
  )
}

async function replacePrivateStateFile(
  filePath: string,
  payload: string
): Promise<void> {
  const directory = path.dirname(filePath)
  const temporary = await writePrivateTemporaryFile(
    directory,
    path.basename(filePath),
    payload
  )
  let temporaryCreated = true
  try {
    await rename(temporary, filePath)
    temporaryCreated = false
  } finally {
    if (temporaryCreated) {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

async function writePrivateSnapshotFile(
  filePath: string,
  payload: string
): Promise<void> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = await writePrivateTemporaryFile(
    directory,
    path.basename(filePath),
    payload
  )
  let temporaryCreated = true
  try {
    await rename(temporary, filePath)
    temporaryCreated = false
    await syncDirectory(directory)
  } finally {
    if (temporaryCreated) {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

function parseStatePayload(payload: string): PersistedStateData {
  try {
    return parsePersistedState(JSON.parse(payload))
  } catch (error) {
    throw new InvalidStateFileError(
      'Ground state is not valid persisted JSON',
      error
    )
  }
}

async function readBoundedStateFile(filePath: string): Promise<string> {
  return (await readBoundedStateDocument(filePath)).payload
}

async function readBoundedStateDocument(
  filePath: string
): Promise<BoundedStateDocument> {
  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlocking =
    typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  const pathDetails = await lstat(filePath)
  if (!pathDetails.isFile()) {
    throw new InvalidStateFileError(
      'Ground state path is not a regular file'
    )
  }
  const handle = await open(
    filePath,
    constants.O_RDONLY | noFollow | nonBlocking
  )
  try {
    const details = await handle.stat()
    if (!details.isFile()) {
      throw new InvalidStateFileError(
        'Ground state path is not a regular file'
      )
    }
    if (
      pathDetails.dev !== details.dev ||
      pathDetails.ino !== details.ino
    ) {
      throw new InvalidStateFileError(
        'Ground state changed while it was being opened'
      )
    }
    if (details.size > MAX_STATE_FILE_BYTES) {
      throw new InvalidStateFileError(
        'Ground state exceeds its local size limit'
      )
    }
    if (process.platform !== 'win32' && (details.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600)
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes <= MAX_STATE_FILE_BYTES) {
      const remaining = MAX_STATE_FILE_BYTES + 1 - totalBytes
      const chunk = Buffer.allocUnsafe(
        Math.min(STATE_READ_CHUNK_BYTES, remaining)
      )
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      chunks.push(chunk.subarray(0, bytesRead))
    }
    if (totalBytes > MAX_STATE_FILE_BYTES) {
      throw new InvalidStateFileError(
        'Ground state exceeds its local size limit'
      )
    }
    try {
      return {
        payload: new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks, totalBytes)
        ),
        sizeBytes: totalBytes,
        capturedAt: details.mtime.toISOString()
      }
    } catch (error) {
      throw new InvalidStateFileError(
        'Ground state is not valid UTF-8',
        error
      )
    }
  } finally {
    await handle.close()
  }
}

async function writePrivateTemporaryFile(
  directory: string,
  targetName: string,
  payload: string
): Promise<string> {
  const temporary = path.join(
    directory,
    `.${targetName}.${randomUUID()}.tmp`
  )
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  )
  let complete = false
  try {
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
    complete = true
  } finally {
    await handle.close()
    if (!complete) await unlink(temporary).catch(() => undefined)
  }
  return temporary
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
    const code = errorCode(error)
    if (
      code === 'EINVAL' ||
      code === 'ENOTSUP' ||
      code === 'ENOSYS' ||
      code === 'EISDIR' ||
      (process.platform === 'win32' && code === 'EPERM')
    ) {
      // Directory fsync is unavailable on some supported filesystems.
      return
    }
    throw error
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function isMissingStateFileError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function isCorruptStateFileError(error: unknown): boolean {
  return (
    error instanceof InvalidStateFileError ||
    errorCode(error) === 'ELOOP'
  )
}

function isStateRecoveryError(error: unknown): boolean {
  return isMissingStateFileError(error) || isCorruptStateFileError(error)
}

async function quarantineCorruptFile(filePath: string): Promise<void> {
  try {
    await rename(
      filePath,
      `${filePath}.unreadable-${Date.now()}-${randomUUID()}`
    )
  } catch (error) {
    // A concurrent delete is equivalent to a successful quarantine. Other
    // filesystem failures are operational and must remain visible to callers.
    if (!isMissingStateFileError(error)) throw error
  }
}

function recoverInterruptedRuns(state: PersistedStateData): boolean {
  let recovered = false
  const interruptedAt = nowIso()
  for (const task of state.tasks) {
    const taskWasActive = isTaskActive(task)
    const activeActivity = [...task.items]
      .reverse()
      .find(
        (item) =>
          item.kind === 'activity' &&
          (item.status === 'pending' || item.status === 'running')
      )
    const interruptedRunId =
      activeActivity?.kind === 'activity'
        ? activeActivity.runId
        : [...task.items]
            .reverse()
            .find((item) => item.kind === 'message' && item.runId)?.runId ??
          createId('run')
    let activityRecovered = false
    const recoveredRunIds = new Set<string>()
    const outcomeUnknownRunIds = new Set<string>()
    for (const item of task.items) {
      if (item.kind !== 'activity') continue
      const marker = item.managedExecution
      if (
        marker?.claim === 'approved' &&
        marker.phase === 'started'
      ) {
        item.managedExecution = {
          ...marker,
          phase: 'uncertain',
          interruptedAt
        }
        item.status = 'error'
        item.result = MANAGED_EXECUTION_OUTCOME_UNKNOWN
        delete item.approvalId
        delete item.durationMs
        activityRecovered = true
        recoveredRunIds.add(item.runId)
        outcomeUnknownRunIds.add(item.runId)
        continue
      }
      if (item.status === 'running' && !marker) {
        const legacyKind = managedExecutionKind(item)
        if (legacyKind) {
          item.activityType =
            legacyKind === 'command' ? 'command' : 'tool'
          item.managedExecution = {
            version: 1,
            operationId: item.id,
            claim: 'legacy-untracked',
            kind: legacyKind,
            phase: 'uncertain',
            startedAt: managedStartedAt(item.createdAt, interruptedAt),
            interruptedAt
          }
          item.result = LEGACY_MANAGED_EXECUTION_OUTCOME_UNKNOWN
          delete item.durationMs
          outcomeUnknownRunIds.add(item.runId)
        }
      }
      if (item.status === 'pending' || item.status === 'running') {
        item.status = 'error'
        delete item.approvalId
        activityRecovered = true
        recoveredRunIds.add(item.runId)
      }
    }

    const invalidatesContinuation =
      taskWasActive || outcomeUnknownRunIds.size > 0
    let continuationCleared = false
    if (invalidatesContinuation && task.runtimeSessions) {
      delete task.runtimeSessions
      continuationCleared = true
    }
    if (invalidatesContinuation && task.modelSessions) {
      for (const session of Object.values(task.modelSessions)) {
        if (Object.hasOwn(session, 'checkpoint')) {
          delete session.checkpoint
          continuationCleared = true
        }
      }
    }

    const summaryRunIds = new Set<string>()
    if (taskWasActive) {
      for (const runId of recoveredRunIds) summaryRunIds.add(runId)
      if (!summaryRunIds.size) summaryRunIds.add(interruptedRunId)
    } else {
      for (const runId of outcomeUnknownRunIds) summaryRunIds.add(runId)
    }
    let summariesAdded = 0
    const summaryLimit = Math.min(
      MAX_INTERRUPTED_RUN_SUMMARIES,
      Math.max(0, MAX_PERSISTED_TASK_ITEMS - task.items.length)
    )
    for (const runId of summaryRunIds) {
      if (summariesAdded >= summaryLimit) break
      if (
        task.items.some(
          (item) =>
            item.kind === 'activity' &&
            item.runId === runId &&
            item.activityType === 'error' &&
            item.title === 'Run interrupted'
        )
      ) {
        continue
      }
      const outcomeUnknown = outcomeUnknownRunIds.has(runId)
      task.items.push({
        id: createId('activity'),
        kind: 'activity',
        runId,
        activityType: 'error',
        title: 'Run interrupted',
        detail: outcomeUnknown
          ? 'Ground closed after a mutating action started. Its outcome is unknown, Ground did not retry it, and any native runtime continuation or model checkpoint was cleared. Review the workspace or external system before continuing.'
          : 'Ground closed before this run reached a terminal state. Review the workspace before retrying.',
        status: 'error',
        createdAt: interruptedAt
      })
      summariesAdded += 1
    }

    if (
      taskWasActive ||
      outcomeUnknownRunIds.size > 0
    ) {
      task.runStatus = 'failed'
    }
    if (
      activityRecovered ||
      taskWasActive ||
      continuationCleared ||
      summariesAdded > 0
    ) {
      task.updatedAt = interruptedAt
      recovered = true
    }
  }
  return recovered
}
