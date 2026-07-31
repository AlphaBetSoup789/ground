import { describe, expect, it } from 'vitest'
import type {
  CopyAssistantOutputInput,
  DesktopTask
} from '../../../shared/types'
import {
  ASSISTANT_CODE_COPIED_STATUS,
  ASSISTANT_OUTPUT_COPY_FAILED_STATUS,
  ASSISTANT_OUTPUT_COPY_PENDING_STATUS,
  ASSISTANT_RESPONSE_COPIED_STATUS,
  assistantOutputCopyStatus,
  canCopyAssistantOutput,
  deriveAssistantOutputCopyEligibility,
  shouldApplyAssistantOutputCopyResult
} from './copy-assistant-output'

function task(
  overrides: Partial<DesktopTask> = {}
): DesktopTask {
  return {
    id: 'task',
    title: 'Copy ownership',
    providerId: 'provider',
    mode: 'agent',
    runStatus: 'idle',
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:01:00.000Z',
    items: [
      {
        id: 'assistant',
        kind: 'message',
        role: 'assistant',
        content: 'Exact response',
        createdAt: '2026-07-30T12:01:00.000Z'
      }
    ],
    ...overrides
  }
}

const responseInput: CopyAssistantOutputInput = {
  taskId: 'task',
  messageId: 'assistant',
  expectedContent: 'Exact response',
  target: { kind: 'response' }
}

describe('copy assistant output ownership', () => {
  it('offers copy only for completed canonical assistant output', () => {
    const idleEligibility = deriveAssistantOutputCopyEligibility(task())
    expect(
      canCopyAssistantOutput(
        idleEligibility,
        'assistant',
        'Exact response'
      )
    ).toBe(true)
    const runningEligibility = deriveAssistantOutputCopyEligibility(
      task({ runStatus: 'running' })
    )
    expect(
      canCopyAssistantOutput(
        runningEligibility,
        'assistant',
        'Exact response'
      )
    ).toBe(false)
    const awaitingApprovalEligibility =
      deriveAssistantOutputCopyEligibility(
        task({ runStatus: 'awaiting-approval' })
      )
    expect(
      canCopyAssistantOutput(
        awaitingApprovalEligibility,
        'assistant',
        'Exact response'
      )
    ).toBe(false)
    expect(
      canCopyAssistantOutput(
        idleEligibility,
        'assistant',
        'stale'
      )
    ).toBe(false)
  })

  it('derives eligibility with one task scan and reuses it for every message lookup', () => {
    const items = Array.from({ length: 500 }, (_, index) => ({
      id: `assistant-${index}`,
      kind: 'message' as const,
      role: 'assistant' as const,
      content: `Response ${index}`,
      createdAt: '2026-07-30T12:01:00.000Z'
    }))
    let taskScans = 0
    const measuredItems = new Proxy(items, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          return function* () {
            taskScans += 1
            yield* target
          }
        }
        return Reflect.get(target, property, receiver)
      }
    })
    const measuredTask = task({ items: measuredItems })

    const eligibility =
      deriveAssistantOutputCopyEligibility(measuredTask)
    for (const item of items) {
      expect(
        canCopyAssistantOutput(
          eligibility,
          item.id,
          item.content
        )
      ).toBe(true)
    }

    expect(taskScans).toBe(1)
  })

  it('keeps completed earlier output eligible while withholding the active latest output', () => {
    const activeTask = task({
      runStatus: 'running',
      items: [
        {
          id: 'assistant-complete',
          kind: 'message',
          role: 'assistant',
          content: 'Completed response',
          createdAt: '2026-07-30T12:00:00.000Z'
        },
        {
          id: 'user',
          kind: 'message',
          role: 'user',
          content: 'Continue',
          createdAt: '2026-07-30T12:00:30.000Z'
        },
        {
          id: 'assistant-active',
          kind: 'message',
          role: 'assistant',
          content: 'Partial response',
          createdAt: '2026-07-30T12:01:00.000Z'
        }
      ]
    })
    const eligibility =
      deriveAssistantOutputCopyEligibility(activeTask)

    expect(
      canCopyAssistantOutput(
        eligibility,
        'assistant-complete',
        'Completed response'
      )
    ).toBe(true)
    expect(
      canCopyAssistantOutput(
        eligibility,
        'assistant-active',
        'Partial response'
      )
    ).toBe(false)
  })

  it('accepts a result only for the latest exact task/message/content request', () => {
    const request = { requestId: 4, input: responseInput }
    expect(
      shouldApplyAssistantOutputCopyResult({
        request,
        currentRequestId: 4,
        currentTask: task()
      })
    ).toBe(true)
    expect(
      shouldApplyAssistantOutputCopyResult({
        request,
        currentRequestId: 5,
        currentTask: task()
      })
    ).toBe(false)
    expect(
      shouldApplyAssistantOutputCopyResult({
        request,
        currentRequestId: 4,
        currentTask: task({ id: 'other-task' })
      })
    ).toBe(false)
    expect(
      shouldApplyAssistantOutputCopyResult({
        request,
        currentRequestId: 4,
        currentTask: task({
          items: [
            {
              id: 'assistant',
              kind: 'message',
              role: 'assistant',
              content: 'Changed response',
              createdAt: '2026-07-30T12:01:00.000Z'
            }
          ]
        })
      })
    ).toBe(false)
  })

  it('uses fixed, content-free, target-specific status messages', () => {
    expect(
      assistantOutputCopyStatus('pending', { kind: 'response' })
    ).toBe(ASSISTANT_OUTPUT_COPY_PENDING_STATUS)
    expect(
      assistantOutputCopyStatus('copied', { kind: 'response' })
    ).toBe(ASSISTANT_RESPONSE_COPIED_STATUS)
    expect(
      assistantOutputCopyStatus('copied', {
        kind: 'code',
        startOffset: 0,
        endOffset: 10
      })
    ).toBe(ASSISTANT_CODE_COPIED_STATUS)
    expect(
      assistantOutputCopyStatus('failed', { kind: 'response' })
    ).toBe(ASSISTANT_OUTPUT_COPY_FAILED_STATUS)
  })
})
