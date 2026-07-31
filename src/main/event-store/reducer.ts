import {
  parsePersistedState,
  type PersistedStateData
} from '../state-schema'
import type { ActivityItem, Task, TaskItem } from '../../shared/types'
import { encodeProjection } from './codec'
import { EventStoreCorruptionError } from './errors'
import type {
  GroundLedgerEvent,
  LedgerEntityBody,
  LedgerEventRecord
} from './types'

export interface DecodedLedgerRecord {
  readonly record: LedgerEventRecord
  readonly event: GroundLedgerEvent
}

/**
 * A mutable working copy of the projection. Every reducer branch mutates this
 * draft and the fold re-validates it through `parsePersistedState`, which stays
 * the single authority on entity shape.
 */
type StateDraft = {
  -readonly [Key in keyof PersistedStateData]: PersistedStateData[Key]
}

export function reduceLedgerEvent(
  current: PersistedStateData | undefined,
  event: GroundLedgerEvent,
  sequence: number
): PersistedStateData {
  if (event.kind === 'legacy-state.bootstrapped') {
    if (current || sequence !== 1) {
      throw new EventStoreCorruptionError(
        'Legacy-state bootstrap must be the first and only bootstrap event'
      )
    }
    const encoded = encodeProjection(event.state)
    if (encoded.stateSha256 !== event.normalizedStateSha256) {
      throw new EventStoreCorruptionError(
        'Legacy-state bootstrap projection hash is invalid'
      )
    }
    return encoded.state
  }

  if (!current) {
    throw new EventStoreCorruptionError(
      `Event ${event.kind} appeared before the semantic bootstrap`
    )
  }

  const draft = structuredClone(current) as StateDraft
  applyEvent(draft, event)
  return validateDraft(draft, event)
}

function applyEvent(draft: StateDraft, event: GroundLedgerEvent): void {
  switch (event.kind) {
    case 'legacy-state.bootstrapped':
      throw new EventStoreCorruptionError(
        'Legacy-state bootstrap must be the first and only bootstrap event'
      )

    case 'settings.sidebar-collapsed-set':
      draft.settings = { ...draft.settings, sidebarCollapsed: event.collapsed }
      return

    case 'settings.selected-task-set': {
      if (event.taskId !== null) requireTask(draft, event.taskId)
      const settings = { ...draft.settings }
      if (event.taskId === null) delete settings.selectedTaskId
      else settings.selectedTaskId = event.taskId
      draft.settings = settings
      return
    }

    case 'settings.default-provider-set': {
      requireProvider(draft, event.providerId)
      draft.settings = {
        ...draft.settings,
        defaultProviderId: event.providerId
      }
      return
    }

    case 'provider.upserted': {
      upsertProvider(draft, event.providerId, event.provider)
      return
    }

    case 'provider.secret-transition-published': {
      upsertProvider(draft, event.providerId, event.provider)
      const pending = new Set(draft.pendingSecretDeletes)
      if (event.stagedReference) pending.delete(event.stagedReference)
      for (const reference of event.obsoleteReferences) {
        if (reference !== event.stagedReference) pending.add(reference)
      }
      draft.pendingSecretDeletes = [...pending]
      return
    }

    case 'provider.deleted': {
      if (draft.providers.length <= 1) {
        throw new EventStoreCorruptionError(
          'Ledger cannot delete the last remaining provider'
        )
      }
      const index = draft.providers.findIndex(
        (candidate) => candidate.id === event.providerId
      )
      if (index === -1) {
        throw new EventStoreCorruptionError(
          `Ledger deleted unknown provider ${event.providerId}`
        )
      }
      draft.providers = draft.providers.filter(
        (candidate) => candidate.id !== event.providerId
      )
      const fallback = draft.providers[0]
      if (fallback) {
        if (draft.settings.defaultProviderId === event.providerId) {
          draft.settings = {
            ...draft.settings,
            defaultProviderId: fallback.id
          }
        }
        draft.tasks = draft.tasks.map((task) =>
          task.providerId === event.providerId
            ? { ...task, providerId: fallback.id }
            : task
        )
      }
      const pending = new Set(draft.pendingSecretDeletes)
      for (const reference of event.obsoleteReferences) pending.add(reference)
      draft.pendingSecretDeletes = [...pending]
      return
    }

    case 'secret-cleanup.queued': {
      if (!draft.pendingSecretDeletes.includes(event.reference)) {
        draft.pendingSecretDeletes = [
          ...draft.pendingSecretDeletes,
          event.reference
        ]
      }
      return
    }

    case 'secret-cleanup.acknowledged': {
      const acknowledged = new Set(event.references)
      draft.pendingSecretDeletes = draft.pendingSecretDeletes.filter(
        (reference) => !acknowledged.has(reference)
      )
      return
    }

    case 'mcp-server.saved': {
      const server = requireEntityId(event.server, event.serverId, 'MCP server')
      const index = draft.mcpServers.findIndex(
        (candidate) => candidate.id === event.serverId
      )
      const servers = [...draft.mcpServers]
      if (index === -1) servers.push(server as unknown as (typeof servers)[number])
      else servers[index] = server as unknown as (typeof servers)[number]
      draft.mcpServers = servers
      return
    }

    case 'mcp-server.deleted': {
      const remaining = draft.mcpServers.filter(
        (candidate) => candidate.id !== event.serverId
      )
      if (remaining.length === draft.mcpServers.length) {
        throw new EventStoreCorruptionError(
          `Ledger deleted unknown MCP server ${event.serverId}`
        )
      }
      draft.mcpServers = remaining
      return
    }

    case 'task.created':
    case 'task.imported': {
      const task = insertTask(draft, event.taskId, event.task)
      draft.settings = {
        ...draft.settings,
        selectedTaskId: task.id,
        ...(event.kind === 'task.created'
          ? { defaultProviderId: task.providerId }
          : {})
      }
      return
    }

    case 'task.forked': {
      requireTask(draft, event.sourceTaskId)
      const task = insertTask(draft, event.taskId, event.task)
      draft.settings = { ...draft.settings, selectedTaskId: task.id }
      return
    }

    case 'task.deleted': {
      const task = requireTask(draft, event.taskId)
      draft.tasks = draft.tasks.filter((candidate) => candidate.id !== task.id)
      if (draft.settings.selectedTaskId === task.id) {
        const next =
          draft.tasks.find((candidate) => !candidate.archivedAt)?.id ??
          draft.tasks[0]?.id
        const settings = { ...draft.settings }
        if (next === undefined) delete settings.selectedTaskId
        else settings.selectedTaskId = next
        draft.settings = settings
      }
      return
    }

    case 'task.archived-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        if (event.archivedAt === null) delete task.archivedAt
        else task.archivedAt = event.archivedAt
      })

    case 'task.title-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        task.title = event.title
      })

    case 'task.provider-set': {
      requireProvider(draft, event.providerId)
      mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        task.providerId = event.providerId
      })
      draft.settings = {
        ...draft.settings,
        defaultProviderId: event.providerId
      }
      return
    }

    case 'task.mode-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        task.mode = event.mode
      })

    case 'task.workspace-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        if (event.workspacePath === null) delete task.workspacePath
        else task.workspacePath = event.workspacePath
      })

    case 'task.imported-history-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        if (event.includeImportedHistory === null) {
          delete task.includeImportedHistory
        } else {
          task.includeImportedHistory = event.includeImportedHistory
        }
      })

    case 'task.run-status-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        task.runStatus = event.runStatus
      })

    case 'task.runtime-session-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        const sessions = { ...(task.runtimeSessions ?? {}) }
        if (event.session === null) delete sessions[event.providerId]
        else {
          sessions[event.providerId] = event.session as unknown as NonNullable<
            Task['runtimeSessions']
          >[string]
        }
        if (Object.keys(sessions).length) task.runtimeSessions = sessions
        else delete task.runtimeSessions
      })

    case 'task.model-session-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        const sessions = { ...(task.modelSessions ?? {}) }
        if (event.session === null) delete sessions[event.providerId]
        else {
          sessions[event.providerId] = event.session as unknown as NonNullable<
            Task['modelSessions']
          >[string]
        }
        if (Object.keys(sessions).length) task.modelSessions = sessions
        else delete task.modelSessions
      })

    case 'task.item-appended':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        if (task.items.some((candidate) => candidate.id === event.itemId)) {
          throw new EventStoreCorruptionError(
            `Timeline item ${event.itemId} already exists`
          )
        }
        const item = requireEntityId(event.item, event.itemId, 'Timeline item')
        task.items = [...task.items, item as unknown as TaskItem]
      })

    case 'task.message-content-set':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        const item = requireItem(task, event.itemId)
        if (item.kind !== 'message') {
          throw new EventStoreCorruptionError(
            `Timeline item ${event.itemId} is not a message`
          )
        }
        item.content = event.content
      })

    case 'task.activity-updated':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        const activity = requireActivity(task, event.itemId)
        if (event.status !== undefined) activity.status = event.status
        if (event.title !== undefined) activity.title = event.title
        assignOptional(activity, 'detail', event.detail)
        assignOptional(activity, 'result', event.result)
        assignOptional(activity, 'durationMs', event.durationMs)
        assignOptional(
          activity,
          'failureKind',
          event.failureKind as ActivityItem['failureKind'] | null | undefined
        )
        assignOptional(activity, 'approvalId', event.approvalId)
      })

    case 'managed-execution.started':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        if (task.archivedAt) {
          throw new EventStoreCorruptionError(
            'Archived tasks cannot begin managed execution'
          )
        }
        const activity = requireActivity(task, event.itemId)
        if (activity.managedExecution) {
          throw new EventStoreCorruptionError(
            `Managed execution ${event.itemId} already has a durable claim`
          )
        }
        if (
          activity.runId !== event.runId ||
          activity.callId !== event.callId ||
          activity.toolName !== event.toolName
        ) {
          throw new EventStoreCorruptionError(
            'Managed execution identity does not match its approval activity'
          )
        }
        activity.status = 'running'
        activity.activityType =
          event.executionKind === 'command' ? 'command' : 'tool'
        delete activity.approvalId
        delete activity.result
        delete activity.durationMs
        activity.managedExecution = {
          version: 1,
          operationId: activity.id,
          claim: 'approved',
          kind: event.executionKind,
          actionSha256: event.actionSha256,
          approvalSha256: event.approvalSha256,
          phase: 'started',
          startedAt: event.startedAt
        }
        task.runStatus = 'running'
      })

    case 'managed-execution.completed':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        const activity = requireActivity(task, event.itemId)
        const marker = activity.managedExecution
        if (
          !marker ||
          marker.operationId !== event.operationId ||
          marker.operationId !== activity.id ||
          marker.claim !== 'approved' ||
          marker.phase !== 'started'
        ) {
          throw new EventStoreCorruptionError(
            marker?.phase === 'uncertain'
              ? 'Managed execution outcome is unknown and can never be completed'
              : 'Managed execution is not an exact started claim'
          )
        }
        if (marker.actionSha256 !== event.actionSha256) {
          throw new EventStoreCorruptionError(
            'Managed execution action hash does not match its started claim'
          )
        }
        activity.status = event.status
        assignOptional(activity, 'result', event.result ?? null)
        assignOptional(activity, 'durationMs', event.durationMs ?? null)
        activity.managedExecution = {
          ...marker,
          phase: 'completed',
          completedAt: event.completedAt
        }
      })

    case 'managed-execution.interrupted':
      return mutateTask(draft, event.taskId, event.updatedAt, (task) => {
        const activity = requireActivity(task, event.itemId)
        const marker = activity.managedExecution
        if (
          !marker ||
          marker.operationId !== event.operationId ||
          marker.claim !== 'approved' ||
          marker.phase !== 'started'
        ) {
          throw new EventStoreCorruptionError(
            'Only an exact started claim can become outcome-unknown'
          )
        }
        activity.status = 'error'
        activity.managedExecution = {
          ...marker,
          phase: 'uncertain',
          interruptedAt: event.interruptedAt
        }
      })

    default: {
      const neverEvent: never = event
      throw new EventStoreCorruptionError(
        `Reducer does not support event ${String(
          (neverEvent as { kind?: unknown }).kind
        )}`
      )
    }
  }
}

function validateDraft(
  draft: StateDraft,
  event: GroundLedgerEvent
): PersistedStateData {
  try {
    return parsePersistedState(draft)
  } catch (error) {
    throw new EventStoreCorruptionError(
      `Event ${event.kind} produced an invalid projection`,
      { cause: error }
    )
  }
}

function mutateTask(
  draft: StateDraft,
  taskId: string,
  updatedAt: string,
  mutation: (task: Task) => void
): void {
  const index = draft.tasks.findIndex((candidate) => candidate.id === taskId)
  if (index === -1) {
    throw new EventStoreCorruptionError(`Ledger referenced unknown task ${taskId}`)
  }
  const task = draft.tasks[index] as Task
  mutation(task)
  task.updatedAt = updatedAt
}

function insertTask(
  draft: StateDraft,
  taskId: string,
  body: LedgerEntityBody
): Task {
  if (draft.tasks.some((candidate) => candidate.id === taskId)) {
    throw new EventStoreCorruptionError(`Task ${taskId} already exists`)
  }
  const task = requireEntityId(body, taskId, 'Task') as unknown as Task
  draft.tasks = [task, ...draft.tasks]
  return task
}

function upsertProvider(
  draft: StateDraft,
  providerId: string,
  body: LedgerEntityBody
): void {
  const provider = requireEntityId(body, providerId, 'Provider')
  const index = draft.providers.findIndex(
    (candidate) => candidate.id === providerId
  )
  const providers = [...draft.providers]
  if (index === -1) providers.push(provider as unknown as (typeof providers)[number])
  else providers[index] = provider as unknown as (typeof providers)[number]
  draft.providers = providers
}

function requireTask(draft: StateDraft, taskId: string): Task {
  const task = draft.tasks.find((candidate) => candidate.id === taskId)
  if (!task) {
    throw new EventStoreCorruptionError(`Ledger referenced unknown task ${taskId}`)
  }
  return task
}

function requireProvider(draft: StateDraft, providerId: string): void {
  if (!draft.providers.some((candidate) => candidate.id === providerId)) {
    throw new EventStoreCorruptionError(
      `Ledger referenced unknown provider ${providerId}`
    )
  }
}

function requireItem(task: Task, itemId: string): TaskItem {
  const item = task.items.find((candidate) => candidate.id === itemId)
  if (!item) {
    throw new EventStoreCorruptionError(
      `Ledger referenced unknown timeline item ${itemId}`
    )
  }
  return item
}

function requireActivity(task: Task, itemId: string): ActivityItem {
  const item = requireItem(task, itemId)
  if (item.kind !== 'activity') {
    throw new EventStoreCorruptionError(
      `Timeline item ${itemId} is not an activity`
    )
  }
  return item
}

function requireEntityId(
  body: LedgerEntityBody,
  expectedId: string,
  label: string
): LedgerEntityBody {
  if (body.id !== expectedId) {
    throw new EventStoreCorruptionError(
      `${label} body does not match its exact entity identifier`
    )
  }
  return body
}

/**
 * Applies the absent/clear/set convention: `undefined` leaves the field alone,
 * `null` deletes exactly one optional field, and any other value assigns it.
 */
function assignOptional<Target extends object, Key extends keyof Target>(
  target: Target,
  key: Key,
  value: Target[Key] | null | undefined
): void {
  if (value === undefined) return
  if (value === null) delete target[key]
  else target[key] = value
}

export function replayLedger(
  records: readonly DecodedLedgerRecord[]
): PersistedStateData {
  let state: PersistedStateData | undefined
  for (const { record, event } of records) {
    state = reduceLedgerEvent(state, event, record.sequence)
  }
  if (!state) {
    throw new EventStoreCorruptionError(
      'Ledger has no semantic bootstrap projection'
    )
  }
  return state
}

export function replayLedgerDeterministically(
  records: readonly DecodedLedgerRecord[]
): {
  readonly state: PersistedStateData
  readonly stateJson: string
  readonly stateSha256: string
} {
  const first = encodeProjection(replayLedger(records))
  const second = encodeProjection(replayLedger(records))
  if (
    first.stateJson !== second.stateJson ||
    first.stateSha256 !== second.stateSha256
  ) {
    throw new EventStoreCorruptionError(
      'Ledger reducer did not rebuild deterministic canonical bytes'
    )
  }
  return first
}
