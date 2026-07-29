/**
 * Serializes task/workspace authority changes with privileged operations that
 * depend on the same binding. A rejected operation never poisons the queue.
 */
export class WorkspaceLifecycleGate {
  private tail: Promise<void> = Promise.resolve()

  run<Result>(
    operation: () => Result | PromiseLike<Result>
  ): Promise<Result> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
