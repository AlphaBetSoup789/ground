import type { DesktopTask } from '../../../shared/types'
import {
  restoreTaskDraftIfEmpty,
  type TaskDrafts
} from './task-drafts'

export const MAX_FAILED_RUN_RETRY_CHARACTERS = 1_000_000

export interface FailedRunRetrySource {
  readonly taskId: string
  readonly runId: string
  readonly failureItemId: string
  readonly failureItemIndex: number
  readonly userMessageId: string
  readonly userMessageIndex: number
  readonly userContent: string
}

export function failedRunRetrySource(
  task: DesktopTask | undefined
): FailedRunRetrySource | undefined {
  if (
    !task ||
    task.archivedAt ||
    task.runStatus !== 'failed'
  ) {
    return undefined
  }

  let failureItemIndex = -1
  for (let index = task.items.length - 1; index >= 0; index -= 1) {
    const item = task.items[index]
    if (
      item?.kind === 'activity' &&
      item.historyOnly !== true &&
      item.activityType === 'error' &&
      item.status === 'error' &&
      (item.title === 'Run failed' || item.title === 'Run interrupted')
    ) {
      failureItemIndex = index
      break
    }
  }
  if (failureItemIndex === -1) return undefined

  const failure = task.items[failureItemIndex]
  if (
    !failure ||
    failure.kind !== 'activity' ||
    !failure.runId ||
    failure.title !== 'Run failed'
  ) {
    return undefined
  }

  const latestRetainedRunId = task.items
    .findLast(
      (item) =>
        item.historyOnly !== true &&
        typeof item.runId === 'string' &&
        item.runId.length > 0
    )
    ?.runId
  if (latestRetainedRunId !== failure.runId) return undefined

  let userMessageIndex = -1
  for (let index = failureItemIndex - 1; index >= 0; index -= 1) {
    const item = task.items[index]
    if (
      item?.kind === 'message' &&
      item.role === 'user' &&
      item.historyOnly !== true &&
      item.runId === failure.runId
    ) {
      userMessageIndex = index
      break
    }
  }
  if (userMessageIndex === -1) return undefined

  const userMessage = task.items[userMessageIndex]
  if (
    !userMessage ||
    userMessage.kind !== 'message' ||
    !userMessage.content.trim() ||
    userMessage.content.length > MAX_FAILED_RUN_RETRY_CHARACTERS
  ) {
    return undefined
  }

  return Object.freeze({
    taskId: task.id,
    runId: failure.runId,
    failureItemId: failure.id,
    failureItemIndex,
    userMessageId: userMessage.id,
    userMessageIndex,
    userContent: userMessage.content
  })
}

export function taskMatchesFailedRunRetry(
  task: DesktopTask | undefined,
  source: FailedRunRetrySource
): boolean {
  const current = failedRunRetrySource(task)
  return (
    current?.taskId === source.taskId &&
    current.runId === source.runId &&
    current.failureItemId === source.failureItemId &&
    current.failureItemIndex === source.failureItemIndex &&
    current.userMessageId === source.userMessageId &&
    current.userMessageIndex === source.userMessageIndex &&
    current.userContent === source.userContent
  )
}

export function prepareFailedRunRetryDraft(
  drafts: TaskDrafts,
  task: DesktopTask | undefined,
  source: FailedRunRetrySource
): TaskDrafts {
  if (!taskMatchesFailedRunRetry(task, source)) return drafts
  return restoreTaskDraftIfEmpty(
    drafts,
    source.taskId,
    source.userContent
  )
}

export function shouldFocusFailedRunRetryComposer(input: {
  sourceTaskId: string
  requestedSelectionEpoch: number
  selectedTaskId: string | undefined
  currentSelectionEpoch: number
  sourceStillCurrent: boolean
  composerTaskId: string | undefined
  composerDisabled: boolean
  composerValue: string
  expectedDraft: string
}): boolean {
  return (
    input.selectedTaskId === input.sourceTaskId &&
    input.currentSelectionEpoch === input.requestedSelectionEpoch &&
    input.sourceStillCurrent &&
    input.composerTaskId === input.sourceTaskId &&
    !input.composerDisabled &&
    input.composerValue === input.expectedDraft
  )
}
