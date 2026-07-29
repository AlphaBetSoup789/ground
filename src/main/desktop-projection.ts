import type {
  ActivityItem,
  AppSnapshot,
  DesktopActivityItem,
  DesktopRunEvent,
  DesktopRunEventEnvelope,
  DesktopTask,
  DesktopTaskItem,
  RunEvent,
  RunEventEnvelope,
  Task
} from '../shared/types'
import type { StateSnapshot } from './store'
import type { WorkspaceGrantRegistry } from './trust-boundary'

type MaybePromise<Value> = Value | PromiseLike<Value>

export function toDesktopActivityItem(
  item: Readonly<ActivityItem>
): DesktopActivityItem {
  const {
    managedExecution: _managedExecution,
    ...desktopItem
  } = item
  return structuredClone(desktopItem)
}

export function toDesktopTaskItem(
  item: Readonly<Task['items'][number]>
): DesktopTaskItem {
  return item.kind === 'activity'
    ? toDesktopActivityItem(item)
    : structuredClone(item)
}

export function toDesktopRunEvent(
  event: Readonly<RunEvent>
): DesktopRunEvent {
  switch (event.type) {
    case 'item-added':
    case 'item-updated':
      return structuredClone({
        ...event,
        item: toDesktopTaskItem(event.item)
      })
    case 'approval-requested':
      return structuredClone({
        ...event,
        item: toDesktopActivityItem(event.item)
      })
    default:
      return structuredClone(event)
  }
}

export function toDesktopRunEventEnvelope(
  envelope: Readonly<RunEventEnvelope>
): DesktopRunEventEnvelope {
  return {
    revision: envelope.revision,
    event: toDesktopRunEvent(envelope.event)
  }
}

export function toDesktopTask(
  task: Readonly<Task>,
  workspaceGrants: WorkspaceGrantRegistry
): DesktopTask {
  const workspace = task.workspacePath
    ? workspaceGrants.describeStoredPath(task.workspacePath)
    : undefined
  return structuredClone({
    id: task.id,
    title: task.title,
    ...(workspace ? { workspace } : {}),
    providerId: task.providerId,
    mode: task.mode,
    ...(task.includeImportedHistory === undefined
      ? {}
      : { includeImportedHistory: task.includeImportedHistory }),
    runStatus: task.runStatus,
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    items: task.items.map(toDesktopTaskItem)
  })
}

export function projectDesktopTaskOperation<Arguments extends unknown[]>(
  workspaceGrants: WorkspaceGrantRegistry,
  operation: (
    ...args: Arguments
  ) => MaybePromise<Readonly<Task> | undefined>
): (...args: Arguments) => Promise<DesktopTask | undefined> {
  return async (...args) => {
    const task = await operation(...args)
    return task ? toDesktopTask(task, workspaceGrants) : undefined
  }
}

export function toDesktopSnapshot(
  snapshot: Readonly<StateSnapshot>,
  workspaceGrants: WorkspaceGrantRegistry
): AppSnapshot {
  return structuredClone({
    providers: snapshot.providers,
    mcpServers: snapshot.mcpServers,
    tasks: snapshot.tasks.map((task) =>
      toDesktopTask(task, workspaceGrants)
    ),
    settings: snapshot.settings,
    ...(snapshot.recoveryNotice
      ? { recoveryNotice: snapshot.recoveryNotice }
      : {})
  })
}
