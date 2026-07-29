import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeAdapterIteratorWithGrace } from './abortable-iteration'

describe('adapter iterator cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for cooperative cleanup', async () => {
    vi.useFakeTimers()
    let cleaned = false
    const iterator: AsyncIterator<number> = {
      next: async () => ({ done: true, value: undefined }),
      return: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        cleaned = true
        return { done: true, value: undefined }
      }
    }

    const closing = closeAdapterIteratorWithGrace(iterator, 250)
    await vi.advanceTimersByTimeAsync(25)
    await closing

    expect(cleaned).toBe(true)
  })

  it('does not let broken cleanup strand cancellation', async () => {
    vi.useFakeTimers()
    const iterator: AsyncIterator<number> = {
      next: async () => ({ done: true, value: undefined }),
      return: () => new Promise<IteratorResult<number>>(() => undefined)
    }

    const closing = closeAdapterIteratorWithGrace(iterator, 250)
    await vi.advanceTimersByTimeAsync(250)

    await expect(closing).resolves.toBeUndefined()
  })
})
