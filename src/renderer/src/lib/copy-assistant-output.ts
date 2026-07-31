import {
  resolveAssistantOutputCopyText
} from '../../../shared/assistant-output-clipboard'
import type {
  CopyAssistantOutputInput,
  DesktopTask
} from '../../../shared/types'

export const ASSISTANT_RESPONSE_COPY_LABEL = 'Copy assistant response'
export const ASSISTANT_CODE_COPY_LABEL = 'Copy code block'
export const ASSISTANT_RESPONSE_COPIED_STATUS =
  'Assistant response copied.'
export const ASSISTANT_CODE_COPIED_STATUS = 'Code block copied.'
export const ASSISTANT_OUTPUT_COPY_PENDING_STATUS = 'Copying…'
export const ASSISTANT_OUTPUT_COPY_FAILED_STATUS =
  'Copy was unavailable.'

export type AssistantOutputCopyPhase =
  | 'pending'
  | 'copied'
  | 'failed'

export interface AssistantOutputCopyRequest {
  requestId: number
  input: CopyAssistantOutputInput
}

export interface AssistantOutputCopyEligibility {
  taskId: string
  contentByMessageId: ReadonlyMap<string, string>
}

/**
 * Derives renderer-only presentation eligibility in one pass over a task.
 *
 * The privileged copy service still re-resolves the task, message, exact
 * content, and target before writing to the clipboard. This index only avoids
 * rescanning the complete task for every rendered assistant message.
 */
export function deriveAssistantOutputCopyEligibility(
  task: DesktopTask
): AssistantOutputCopyEligibility {
  const contentByMessageId = new Map<string, string>()
  let latestAssistantId: string | undefined

  for (const item of task.items) {
    if (item.kind !== 'message' || item.role !== 'assistant') continue

    latestAssistantId = item.id
    if (item.content.length > 0) {
      contentByMessageId.set(item.id, item.content)
    } else {
      contentByMessageId.delete(item.id)
    }
  }

  const runActive =
    task.runStatus === 'running' ||
    task.runStatus === 'awaiting-approval'
  if (runActive && latestAssistantId) {
    contentByMessageId.delete(latestAssistantId)
  }

  return {
    taskId: task.id,
    contentByMessageId
  }
}

export function canCopyAssistantOutput(
  eligibility: AssistantOutputCopyEligibility,
  messageId: string,
  content: string
): boolean {
  return eligibility.contentByMessageId.get(messageId) === content
}

export function shouldApplyAssistantOutputCopyResult(input: {
  request: AssistantOutputCopyRequest
  currentRequestId: number
  currentTask: DesktopTask
}): boolean {
  return (
    input.request.requestId === input.currentRequestId &&
    resolveAssistantOutputCopyText(
      input.currentTask,
      input.request.input
    ) !== undefined
  )
}

export function assistantOutputCopyStatus(
  phase: AssistantOutputCopyPhase,
  target: CopyAssistantOutputInput['target']
): string {
  if (phase === 'pending') return ASSISTANT_OUTPUT_COPY_PENDING_STATUS
  if (phase === 'failed') return ASSISTANT_OUTPUT_COPY_FAILED_STATUS
  return target.kind === 'response'
    ? ASSISTANT_RESPONSE_COPIED_STATUS
    : ASSISTANT_CODE_COPIED_STATUS
}
