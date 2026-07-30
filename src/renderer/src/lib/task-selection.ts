import type { AppSnapshot } from '../../../shared/types'

export interface TaskSelectionRequest {
  request: number
  taskId: string
}

export function selectTaskInSnapshot(
  snapshot: AppSnapshot | undefined,
  taskId: string
): AppSnapshot | undefined {
  if (
    !snapshot ||
    snapshot.settings.selectedTaskId === taskId ||
    !snapshot.tasks.some((task) => task.id === taskId)
  ) {
    return snapshot
  }

  return {
    ...snapshot,
    settings: {
      ...snapshot.settings,
      selectedTaskId: taskId
    }
  }
}

export function preserveNewerTaskSelection(
  snapshot: AppSnapshot,
  requestBoundary: number,
  latestSelection: TaskSelectionRequest | undefined
): AppSnapshot {
  if (!latestSelection || latestSelection.request <= requestBoundary) {
    return snapshot
  }
  return selectTaskInSnapshot(snapshot, latestSelection.taskId) ?? snapshot
}
