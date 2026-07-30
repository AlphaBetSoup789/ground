export type TaskDrafts = Readonly<Record<string, string>>

export function updateTaskDraft(
  drafts: TaskDrafts,
  taskId: string,
  value: string
): TaskDrafts {
  if (!value) {
    if (!(taskId in drafts)) return drafts
    const next = { ...drafts }
    delete next[taskId]
    return next
  }

  if (drafts[taskId] === value) return drafts
  return { ...drafts, [taskId]: value }
}

export function restoreTaskDraftIfEmpty(
  drafts: TaskDrafts,
  taskId: string,
  value: string
): TaskDrafts {
  if ((drafts[taskId] ?? '').length > 0) return drafts
  return updateTaskDraft(drafts, taskId, value)
}
