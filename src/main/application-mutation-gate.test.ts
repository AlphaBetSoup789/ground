import { describe, expect, it, vi } from 'vitest'
import { ApplicationMutationGate } from './application-mutation-gate'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('ApplicationMutationGate', () => {
  it('closes synchronously, drains entered mutations, and stays closed for exit', async () => {
    const gate = new ApplicationMutationGate()
    const blocker = deferred()
    const active = gate.run(async () => blocker.promise)
    expect(gate.activeMutationCount()).toBe(1)
    const exclusiveOperation = vi.fn()
    const restore = gate.withExclusiveRestore(async (holdForProcessExit) => {
      exclusiveOperation()
      holdForProcessExit()
      return 'restored'
    })

    expect(gate.isSealed()).toBe(true)
    expect(exclusiveOperation).not.toHaveBeenCalled()
    await expect(
      gate.run(async () => 'late mutation')
    ).rejects.toThrow(/changes are disabled/i)

    blocker.resolve()
    await active
    await expect(restore).resolves.toBe('restored')
    expect(exclusiveOperation).toHaveBeenCalledTimes(1)
    expect(gate.activeMutationCount()).toBe(0)
    expect(gate.isSealed()).toBe(true)
  })

  it('reopens when draining or restoring fails before process-exit handoff', async () => {
    const gate = new ApplicationMutationGate()

    await expect(
      gate.withExclusiveRestore(async () => {
        throw new Error('restore failed')
      })
    ).rejects.toThrow('restore failed')
    expect(gate.isSealed()).toBe(false)
    await expect(gate.run(async () => 'available')).resolves.toBe(
      'available'
    )
  })

  it('waits for an entered failure without letting it prevent the restore', async () => {
    const gate = new ApplicationMutationGate()
    const blocker = deferred()
    const active = gate.run(async () => {
      await blocker.promise
      throw new Error('entered mutation failed')
    })
    const restore = vi.fn(async () => 'restored')
    const exclusive = gate.withExclusiveRestore(restore)

    blocker.resolve()
    await expect(active).rejects.toThrow('entered mutation failed')
    await expect(exclusive).resolves.toBe('restored')
    expect(restore).toHaveBeenCalledTimes(1)
    expect(gate.isSealed()).toBe(false)
  })

  it('admits only one restore request before native confirmation', async () => {
    const gate = new ApplicationMutationGate()
    const blocker = deferred()
    const first = gate.withRestoreRequest(async () => {
      await blocker.promise
      return 'canceled'
    })

    expect(gate.hasPendingRestoreRequest()).toBe(true)
    await expect(
      gate.withRestoreRequest(async () => 'second')
    ).rejects.toThrow(/restore request is already in progress/i)

    blocker.resolve()
    await expect(first).resolves.toBe('canceled')
    expect(gate.hasPendingRestoreRequest()).toBe(false)
    await expect(
      gate.withRestoreRequest(async () => 'available')
    ).resolves.toBe('available')
  })

  it('seals immediately for fail-closed process exit after uncertain publication', async () => {
    const gate = new ApplicationMutationGate()
    gate.sealForProcessExit()

    expect(gate.isSealed()).toBe(true)
    await expect(
      gate.run(async () => 'must not run')
    ).rejects.toThrow(/changes are disabled/i)
  })
})
