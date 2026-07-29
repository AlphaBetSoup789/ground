import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type {
  ActivityItem,
  AppSnapshot,
  McpServerProfile,
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
import { parsePersistedState, type PersistedStateData } from './state-schema'
import type {
  GroundConversationItem,
  GroundProviderAttribution,
  GroundProviderDescriptor,
  GroundTaskImportTemplate
} from './task-portability'

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

class InvalidStateFileError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'InvalidStateFileError'
  }
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
    version: 1,
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
    }
  }
}

export class StateStore {
  private state: PersistedStateData = createInitialState()
  private recoveryNotice: RecoveryNotice | undefined
  private transactionQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await this.enqueueTransaction(async () => {
      const backupPath = `${this.filePath}.bak`
      let candidate: PersistedStateData
      let rewritePrimary = false
      let nextRecoveryNotice: RecoveryNotice | undefined

      try {
        candidate = await readStateFile(this.filePath)
      } catch (primaryError) {
        if (!isStateRecoveryError(primaryError)) throw primaryError

        try {
          candidate = await readStateFile(backupPath)
          if (isCorruptStateFileError(primaryError)) {
            await quarantineCorruptFile(this.filePath)
          }
          rewritePrimary = true
          nextRecoveryNotice = {
            id: `backup-restored:${Date.now()}`,
            kind: 'backup-restored',
            title: 'Recovered local history',
            detail:
              'Ground could not read the newest state file and restored the last known-good local backup. The unreadable file was preserved for diagnosis.'
          }
        } catch (backupError) {
          if (!isStateRecoveryError(backupError)) throw backupError

          if (isCorruptStateFileError(primaryError)) {
            await quarantineCorruptFile(this.filePath)
          }
          if (isCorruptStateFileError(backupError)) {
            await quarantineCorruptFile(backupPath)
          }

          candidate = createInitialState()
          rewritePrimary = true
          if (
            !isMissingStateFileError(primaryError) ||
            !isMissingStateFileError(backupError)
          ) {
            nextRecoveryNotice = {
              id: `state-reset:${Date.now()}`,
              kind: 'state-reset',
              title: 'Local state needs attention',
              detail:
                'Ground could not validate the saved state or its backup, so it opened a clean local workspace. The unreadable files were preserved for diagnosis.'
            }
          }
        }
      }

      const recoveredCandidate = structuredClone(candidate)
      const recovered = recoverInterruptedRuns(recoveredCandidate)
      const normalized = normalizeState(recoveredCandidate)
      if (rewritePrimary || recovered) {
        await persistState(this.filePath, normalized.payload)
      }

      this.state = normalized.state
      this.recoveryNotice = nextRecoveryNotice
    })
  }

  snapshot(): AppSnapshot {
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
                model: session.model,
                workspacePath: session.workspacePath,
                mode: session.mode,
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
              model: exactProvider.model,
              mode: templateSnapshot.mode,
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

  async addActivity(taskId: string, activity: ActivityItem): Promise<void> {
    await this.addItem(taskId, activity)
  }

  async flush(): Promise<void> {
    await this.changeState(
      () => undefined,
      () => undefined
    )
  }

  async settledSnapshot(): Promise<AppSnapshot> {
    return this.enqueueTransaction(async () => this.snapshot())
  }

  private changeState<Token, Result>(
    mutate: (candidate: PersistedStateData) => Token,
    project: (normalized: PersistedStateData, token: Token) => Result,
    persist = true
  ): Promise<Result> {
    return this.enqueueTransaction(async () => {
      const candidate = structuredClone(this.state)
      const token = mutate(candidate)
      const normalized = normalizeState(candidate)
      const result = structuredClone(project(normalized.state, token))
      if (persist) {
        await persistState(this.filePath, normalized.payload)
      }
      this.state = normalized.state
      return result
    })
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

async function persistState(filePath: string, payload: string): Promise<void> {
  const directory = path.dirname(filePath)
  const backupPath = `${filePath}.bak`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = await writePrivateTemporaryFile(
    directory,
    path.basename(filePath),
    payload
  )
  let temporaryCreated = true
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
      const backupTemporary = await writePrivateTemporaryFile(
        directory,
        path.basename(backupPath),
        previousPayload
      )
      let backupTemporaryCreated = true
      try {
        await rename(backupTemporary, backupPath)
        backupTemporaryCreated = false
      } finally {
        if (backupTemporaryCreated) {
          await unlink(backupTemporary).catch(() => undefined)
        }
      }
    }

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
  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlocking =
    typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
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
      return new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, totalBytes)
      )
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
    for (const item of task.items) {
      if (
        item.kind === 'activity' &&
        (item.status === 'pending' || item.status === 'running')
      ) {
        item.status = 'error'
        delete item.approvalId
        activityRecovered = true
      }
    }
    if (!taskWasActive) {
      if (activityRecovered) {
        task.updatedAt = nowIso()
        recovered = true
      }
      continue
    }

    recovered = true
    task.items.push({
      id: createId('activity'),
      kind: 'activity',
      runId: interruptedRunId,
      activityType: 'error',
      title: 'Run interrupted',
      detail:
        'Ground closed before this run reached a terminal state. Review the workspace before retrying.',
      status: 'error',
      createdAt: nowIso()
    })
    task.runStatus = 'failed'
    task.updatedAt = nowIso()
  }
  return recovered
}
