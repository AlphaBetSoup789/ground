export type HoldApplicationMutationGate = () => void

/**
 * Tracks renderer-initiated application operations as one process-wide
 * boundary. A local-state restore can close the boundary synchronously, drain
 * everything that entered before it closed, and keep it closed through
 * process exit after the replacement state is published.
 */
export class ApplicationMutationGate {
  private readonly active = new Set<Promise<void>>()
  private sealed = false
  private restoreRequestPending = false

  async run<Result>(
    operation: () => Result | PromiseLike<Result>
  ): Promise<Result> {
    if (this.sealed) {
      throw new Error(
        'Ground is restoring local state and relaunching; changes are disabled'
      )
    }
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.active.add(completion)
    try {
      return await operation()
    } finally {
      this.active.delete(completion)
      finish()
    }
  }

  async withExclusiveRestore<Result>(
    operation: (holdForProcessExit: HoldApplicationMutationGate) => Promise<Result>
  ): Promise<Result> {
    if (this.sealed) {
      throw new Error('A local state restore is already in progress')
    }
    this.sealed = true
    await Promise.allSettled([...this.active])
    let heldForProcessExit = false
    try {
      return await operation(() => {
        heldForProcessExit = true
      })
    } finally {
      if (!heldForProcessExit) this.sealed = false
    }
  }

  async withRestoreRequest<Result>(
    request: () => Promise<Result>
  ): Promise<Result> {
    if (this.restoreRequestPending || this.sealed) {
      throw new Error('A local state restore request is already in progress')
    }
    this.restoreRequestPending = true
    try {
      return await request()
    } finally {
      this.restoreRequestPending = false
    }
  }

  isSealed(): boolean {
    return this.sealed
  }

  /**
   * Fail closed after an atomic publication reports an ambiguous late error.
   * The caller exits the process immediately, so no drain is attempted from
   * within the currently admitted operation.
   */
  sealForProcessExit(): void {
    this.sealed = true
  }

  activeMutationCount(): number {
    return this.active.size
  }

  hasPendingRestoreRequest(): boolean {
    return this.restoreRequestPending
  }
}
