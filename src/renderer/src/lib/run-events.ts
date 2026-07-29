import type {
  AppSnapshot,
  DesktopRunEvent,
  DesktopRunEventEnvelope,
  DesktopTask
} from '../../../shared/types'

export function applyRunEvent(
  snapshot: AppSnapshot,
  event: DesktopRunEvent
): AppSnapshot {
  const taskIndex = snapshot.tasks.findIndex(
    (candidate) => candidate.id === event.taskId
  )
  if (taskIndex === -1) return snapshot
  const currentTask = snapshot.tasks[taskIndex] as DesktopTask
  let task = currentTask

  switch (event.type) {
    case 'run-started':
      task = { ...currentTask, runStatus: 'running' }
      break
    case 'item-added':
      task = currentTask.items.some((item) => item.id === event.item.id)
        ? { ...currentTask }
        : {
            ...currentTask,
            items: [...currentTask.items, structuredClone(event.item)]
          }
      break
    case 'text-delta': {
      const itemIndex = currentTask.items.findIndex(
        (candidate) => candidate.id === event.itemId
      )
      const item = currentTask.items[itemIndex]
      if (item?.kind !== 'message') return snapshot
      if (event.offset !== undefined) {
        if (
          item.content.slice(
            event.offset,
            event.offset + event.delta.length
          ) === event.delta
        ) {
          return snapshot
        }
        if (item.content.length !== event.offset) return snapshot
      }
      const items = [...currentTask.items]
      items[itemIndex] = { ...item, content: `${item.content}${event.delta}` }
      task = { ...currentTask, items }
      break
    }
    case 'item-updated': {
      const itemIndex = currentTask.items.findIndex(
        (candidate) => candidate.id === event.item.id
      )
      const items = [...currentTask.items]
      const item = structuredClone(event.item)
      if (itemIndex === -1) items.push(item)
      else items[itemIndex] = item
      task = { ...currentTask, items }
      break
    }
    case 'approval-requested':
      task = { ...currentTask, runStatus: 'awaiting-approval' }
      break
    case 'run-completed':
    case 'run-stopped':
      task = { ...currentTask, runStatus: 'idle' }
      break
    case 'run-error':
      task = { ...currentTask, runStatus: 'failed' }
      break
  }
  task = { ...task, updatedAt: new Date().toISOString() }
  const tasks = [...snapshot.tasks]
  tasks[taskIndex] = task
  return { ...snapshot, tasks }
}

export function applyRunEventEnvelope(
  snapshot: AppSnapshot,
  envelope: DesktopRunEventEnvelope
): AppSnapshot {
  if (envelope.revision <= (snapshot.runEventRevision ?? 0)) return snapshot
  const updated = applyRunEvent(snapshot, envelope.event)
  return { ...updated, runEventRevision: envelope.revision }
}

export function materializeActiveRunEvents(
  snapshot: AppSnapshot
): AppSnapshot {
  const activeEvents = snapshot.activeRunEvents ?? []
  let materialized: AppSnapshot = {
    ...snapshot,
    activeRunEvents: undefined
  }
  for (const envelope of activeEvents) {
    materialized = applyRunEvent(materialized, envelope.event)
  }
  return {
    ...materialized,
    runEventRevision: snapshot.runEventRevision
  }
}

export function reconcileSnapshotWithEvents(
  snapshot: AppSnapshot,
  envelopes: readonly DesktopRunEventEnvelope[]
): AppSnapshot {
  return envelopes.reduce(
    applyRunEventEnvelope,
    materializeActiveRunEvents(snapshot)
  )
}
