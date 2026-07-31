import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import type { CopyAssistantOutputInput } from '../shared/types'
import {
  createCopyAssistantOutputInvoker,
  hasActiveUserActivation
} from './user-activation'

const input: CopyAssistantOutputInput = {
  taskId: 'task',
  messageId: 'assistant',
  expectedContent: 'Exact response',
  target: { kind: 'response' }
}

describe('clipboard user activation guard', () => {
  it('allows only an explicitly active renderer gesture', () => {
    expect(hasActiveUserActivation({ isActive: true })).toBe(true)
    expect(hasActiveUserActivation({ isActive: false })).toBe(false)
    expect(hasActiveUserActivation(undefined)).toBe(false)
  })

  it('does not invoke IPC when the exposed method lacks active user activation', async () => {
    const invoke = vi.fn(async () => true)
    const copyAssistantOutput = createCopyAssistantOutputInvoker({
      currentUserActivation: () => ({ isActive: false }),
      invoke
    })

    await expect(copyAssistantOutput(input)).resolves.toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('invokes only the dedicated channel for an actively triggered request', async () => {
    const invoke = vi.fn(async () => true)
    const copyAssistantOutput = createCopyAssistantOutputInvoker({
      currentUserActivation: () => ({ isActive: true }),
      invoke
    })

    await expect(copyAssistantOutput(input)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      IPC.copyAssistantOutput,
      input
    )
  })
})
