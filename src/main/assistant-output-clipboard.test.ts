import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import type { CopyAssistantOutputInput, Task } from '../shared/types'
import {
  assistantOutputClipboardIpcOperation,
  AssistantOutputClipboardService
} from './assistant-output-clipboard'

const content = 'Result\n\n```ts\nconst exact = "🌱"\n\n```\n'
const sourceTask: Task = {
  id: 'task',
  title: 'Clipboard source',
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
      content,
      createdAt: '2026-07-30T12:01:00.000Z'
    }
  ]
}

const responseRequest: CopyAssistantOutputInput = {
  taskId: 'task',
  messageId: 'assistant',
  expectedContent: content,
  target: { kind: 'response' }
}

describe('AssistantOutputClipboardService', () => {
  it('binds the service to only the dedicated reviewed IPC channel', async () => {
    const copy = vi.fn(async () => true)
    const operation = assistantOutputClipboardIpcOperation({ copy })

    expect(operation.channel).toBe(IPC.copyAssistantOutput)
    await expect(operation.invoke(responseRequest)).resolves.toBe(true)
    expect(copy).toHaveBeenCalledOnce()
    expect(copy).toHaveBeenCalledWith(responseRequest)
  })

  it('writes the exact canonical response through the injected plain-text writer', async () => {
    const writeText = vi.fn()
    const getTask = vi.fn(() => structuredClone(sourceTask))
    const service = new AssistantOutputClipboardService(
      { getTask },
      { writeText }
    )

    await expect(service.copy(responseRequest)).resolves.toBe(true)
    expect(getTask).toHaveBeenCalledWith('task')
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(content)
  })

  it('writes only the canonical fenced-code value selected by source offsets', async () => {
    const writeText = vi.fn()
    const service = new AssistantOutputClipboardService(
      { getTask: () => structuredClone(sourceTask) },
      { writeText }
    )
    const startOffset = content.indexOf('```')
    const endOffset = content.lastIndexOf('```') + 3

    await expect(
      service.copy({
        ...responseRequest,
        target: { kind: 'code', startOffset, endOffset }
      })
    ).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('const exact = "🌱"\n\n')
  })

  it('writes an empty represented fenced block without inventing a newline', async () => {
    const emptyContent = 'Empty:\n\n```\n\n```\n'
    const emptyTask = structuredClone(sourceTask)
    const message = emptyTask.items[0]
    if (!message || message.kind !== 'message') {
      throw new Error('Clipboard fixture message is missing')
    }
    message.content = emptyContent
    const writeText = vi.fn()
    const service = new AssistantOutputClipboardService(
      { getTask: () => structuredClone(emptyTask) },
      { writeText }
    )

    await expect(
      service.copy({
        ...responseRequest,
        expectedContent: emptyContent,
        target: {
          kind: 'code',
          startOffset: emptyContent.indexOf('```'),
          endOffset: emptyContent.lastIndexOf('```') + 3
        }
      })
    ).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('')
  })

  it('fails closed for malformed, stale, missing, active, and writer-failure requests', async () => {
    const writeText = vi.fn()
    const mutableTask = structuredClone(sourceTask)
    const service = new AssistantOutputClipboardService(
      {
        getTask: (taskId) => {
          if (taskId === 'missing') throw new Error('Task not found')
          return structuredClone(mutableTask)
        }
      },
      { writeText }
    )

    await expect(
      service.copy({ ...responseRequest, extra: 'arbitrary' })
    ).resolves.toBe(false)
    await expect(
      service.copy({
        ...responseRequest,
        expectedContent: `${content}stale`
      })
    ).resolves.toBe(false)
    await expect(
      service.copy({ ...responseRequest, taskId: 'missing' })
    ).resolves.toBe(false)
    mutableTask.runStatus = 'running'
    await expect(service.copy(responseRequest)).resolves.toBe(false)
    expect(writeText).not.toHaveBeenCalled()

    mutableTask.runStatus = 'idle'
    const failedWriter = new AssistantOutputClipboardService(
      { getTask: () => structuredClone(mutableTask) },
      {
        writeText: () => {
          throw new Error('OS clipboard rejected the write')
        }
      }
    )
    await expect(failedWriter.copy(responseRequest)).resolves.toBe(false)

    const rejectedWriter = new AssistantOutputClipboardService(
      { getTask: () => structuredClone(mutableTask) },
      {
        writeText: () =>
          Promise.reject(
            new Error('OS clipboard rejected the asynchronous write')
          )
      }
    )
    await expect(rejectedWriter.copy(responseRequest)).resolves.toBe(
      false
    )
  })
})
