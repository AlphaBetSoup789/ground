function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('Adapter iteration was cancelled', 'AbortError')
  )
}

/**
 * Await one adapter event without trusting the adapter to observe cancellation.
 * The abandoned next() remains handled by Promise.race, while iterator cleanup
 * is deliberately best effort so a broken return() cannot block Stop.
 */
export async function nextAdapterEvent<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal
): Promise<IteratorResult<T>> {
  if (!signal) return iterator.next()
  if (signal.aborted) throw abortReason(signal)

  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const next = Promise.resolve().then(() => iterator.next())
  try {
    return await Promise.race([next, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export function closeAdapterIteratorBestEffort<T>(
  iterator: AsyncIterator<T>
): void {
  try {
    const closing = iterator.return?.()
    if (closing) void Promise.resolve(closing).catch(() => undefined)
  } catch {
    // A nonconforming iterator must not prevent cancellation from completing.
  }
}

/**
 * Give a cooperative adapter a short opportunity to finish its own cleanup
 * without allowing a broken return() implementation to strand cancellation.
 */
export async function closeAdapterIteratorWithGrace<T>(
  iterator: AsyncIterator<T>,
  graceMilliseconds = 250
): Promise<void> {
  let closing: PromiseLike<IteratorResult<T>> | IteratorResult<T> | undefined
  try {
    closing = iterator.return?.()
  } catch {
    return
  }
  if (!closing) return

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(closing).then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, Math.max(0, graceMilliseconds))
      })
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export function toAsyncAdapterIterator<T>(
  events: AsyncIterable<T> | Iterable<T>
): AsyncIterator<T> {
  const asyncIterator = (events as AsyncIterable<T>)[Symbol.asyncIterator]
  if (typeof asyncIterator === 'function') {
    return asyncIterator.call(events)
  }
  const iterator = (events as Iterable<T>)[Symbol.iterator]()
  return {
    next: async () => iterator.next(),
    return:
      typeof iterator.return === 'function'
        ? async () => iterator.return?.() ?? { done: true, value: undefined }
        : undefined
  }
}
