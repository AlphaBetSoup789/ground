import { describe, expect, it, vi } from 'vitest'
import {
  ensureLocalStateSnapshotExtension,
  exportSelectedLocalStateSnapshot,
  localStateSnapshotFilename,
  restoreSelectedLocalStateSnapshot,
  stateRestoreConfirmationOptions
} from './local-state-backup'
import { ApplicationMutationGate } from './application-mutation-gate'
import type { LocalStateSnapshotReview, StateStore } from './store'

const snapshotReview: LocalStateSnapshotReview = {
  id: 'state_snapshot_00000000-0000-4000-8000-000000000000',
  kind: 'retained',
  generation: 2,
  capturedAt: '2026-07-28T12:34:56.000Z',
  sizeBytes: 12_345,
  taskCount: 7,
  providerCount: 3,
  contentSha256: 'a'.repeat(64)
}

function fakeStore(): {
  store: StateStore
  exportSnapshot: ReturnType<typeof vi.fn>
  restoreSnapshot: ReturnType<typeof vi.fn>
  assertSelection: ReturnType<typeof vi.fn>
} {
  const exportSnapshot = vi.fn(async () => undefined)
  const restoreSnapshot = vi.fn(async () => undefined)
  const assertSelection = vi.fn(async () => snapshotReview)
  return {
    store: {
      assertLocalStateSnapshotSelection: assertSelection,
      exportLocalStateSnapshot: exportSnapshot,
      restoreLocalStateSnapshot: restoreSnapshot
    } as unknown as StateStore,
    exportSnapshot,
    restoreSnapshot,
    assertSelection
  }
}

function mutationGate(
  order?: string[]
): {
  gate: {
    withRestoreRequest<Result>(
      request: () => Promise<Result>
    ): Promise<Result>
    withExclusiveRestore<Result>(
      restore: (holdForProcessExit: () => void) => Promise<Result>
    ): Promise<Result>
  }
  exclusive: ReturnType<typeof vi.fn>
  held: ReturnType<typeof vi.fn>
} {
  const held = vi.fn(() => {
    order?.push('hold')
  })
  const exclusive = vi.fn()
  const gate = {
    async withRestoreRequest<Result>(
      request: () => Promise<Result>
    ): Promise<Result> {
      return request()
    },
    async withExclusiveRestore<Result>(
      restore: (holdForProcessExit: () => void) => Promise<Result>
    ): Promise<Result> {
      exclusive()
      order?.push('exclusive')
      return restore(held)
    }
  }
  return { gate, exclusive, held }
}

describe('local state backup workflow', () => {
  it('uses a recognizable bounded state-export filename', () => {
    expect(
      localStateSnapshotFilename(new Date('2026-07-29T12:00:00.000Z'))
    ).toBe('Ground state 2026-07-29.ground-state.json')
    expect(ensureLocalStateSnapshotExtension('/tmp/recovery')).toBe(
      '/tmp/recovery.ground-state.json'
    )
    expect(
      ensureLocalStateSnapshotExtension('/tmp/recovery.GROUND-STATE.JSON')
    ).toBe('/tmp/recovery.GROUND-STATE.JSON')
  })

  it('uses a native restore confirmation that cancels by default', () => {
    const options = stateRestoreConfirmationOptions(snapshotReview)
    expect(options).toMatchObject({
      type: 'warning',
      buttons: ['Cancel', 'Restore and relaunch'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    expect(options.detail).toContain('Retained generation: 2')
    expect(options.detail).toContain('Captured: 2026-07-28T12:34:56.000Z')
    expect(options.detail).toContain('Tasks: 7')
    expect(options.detail).toContain('Providers: 3')
    expect(options.detail).toContain('Size: 12,345 bytes')
    expect(options.detail).toContain(`Content SHA-256: ${'a'.repeat(16)}…`)
  })

  it('does not restore, reserve, or relaunch when confirmation is denied', async () => {
    const { store, restoreSnapshot, assertSelection } = fakeStore()
    const reserve = vi.fn(async (restore: () => Promise<void>) => restore())
    const relaunch = vi.fn()
    const mutations = mutationGate()

    await expect(
      restoreSelectedLocalStateSnapshot(
        store,
        { hasActiveRuns: () => false, withStateRestoreReservation: reserve },
        mutations.gate,
        'state_snapshot_00000000-0000-4000-8000-000000000000',
        async () => false,
        async () => undefined,
        relaunch
      )
    ).resolves.toBe(false)

    expect(reserve).not.toHaveBeenCalled()
    expect(mutations.exclusive).not.toHaveBeenCalled()
    expect(assertSelection).toHaveBeenCalledWith(
      'state_snapshot_00000000-0000-4000-8000-000000000000',
      true
    )
    expect(restoreSnapshot).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('restores the exact selected ID inside the run reservation before relaunch', async () => {
    const { store, restoreSnapshot, assertSelection } = fakeStore()
    const order: string[] = []
    restoreSnapshot.mockImplementation(async () => {
      order.push('restore')
    })
    const reserve = vi.fn(async (restore: () => Promise<void>) => {
      order.push('reserve')
      const result = await restore()
      order.push('release')
      return result
    })
    const relaunch = vi.fn(() => {
      order.push('relaunch')
    })
    const prepareForRestore = vi.fn(async () => {
      order.push('prepare')
    })
    const mutations = mutationGate(order)
    const snapshotId =
      'state_snapshot_00000000-0000-4000-8000-000000000000'

    await expect(
      restoreSelectedLocalStateSnapshot(
        store,
        { hasActiveRuns: () => false, withStateRestoreReservation: reserve },
        mutations.gate,
        snapshotId,
        async () => true,
        prepareForRestore,
        relaunch
      )
    ).resolves.toBe(true)

    expect(restoreSnapshot).toHaveBeenCalledWith(snapshotId)
    expect(mutations.held).toHaveBeenCalledTimes(1)
    expect(order).toEqual([
      'reserve',
      'exclusive',
      'hold',
      'prepare',
      'restore',
      'relaunch',
      'release'
    ])
    expect(prepareForRestore).toHaveBeenCalledTimes(1)
    expect(assertSelection).toHaveBeenCalledTimes(3)
    expect(assertSelection).toHaveBeenNthCalledWith(1, snapshotId, true)
    expect(assertSelection).toHaveBeenNthCalledWith(2, snapshotId, true)
    expect(assertSelection).toHaveBeenNthCalledWith(3, snapshotId, true)
  })

  it('rejects an active run before asking for restore confirmation', async () => {
    const { store, restoreSnapshot } = fakeStore()
    const confirm = vi.fn(async () => true)
    const reserve = vi.fn(async (restore: () => Promise<void>) => restore())
    const mutations = mutationGate()

    await expect(
      restoreSelectedLocalStateSnapshot(
        store,
        {
          hasActiveRuns: () => true,
          withStateRestoreReservation: reserve
        },
        mutations.gate,
        'state_snapshot_00000000-0000-4000-8000-000000000000',
        confirm,
        async () => undefined,
        vi.fn()
      )
    ).rejects.toThrow(/stop active runs/i)

    expect(confirm).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(mutations.exclusive).not.toHaveBeenCalled()
    expect(restoreSnapshot).not.toHaveBeenCalled()
  })

  it('keeps the application sealed and relaunches when restore publication fails', async () => {
    const { store, restoreSnapshot } = fakeStore()
    restoreSnapshot.mockRejectedValueOnce(new Error('directory fsync failed'))
    const gate = new ApplicationMutationGate()
    const relaunch = vi.fn()

    await expect(
      restoreSelectedLocalStateSnapshot(
        store,
        {
          hasActiveRuns: () => false,
          withStateRestoreReservation: async (restore) => restore()
        },
        gate,
        snapshotReview.id,
        async () => true,
        async () => undefined,
        relaunch
      )
    ).rejects.toThrow('directory fsync failed')

    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(gate.isSealed()).toBe(true)
  })

  it('rejects a concurrent restore before opening a second confirmation', async () => {
    const { store } = fakeStore()
    const gate = new ApplicationMutationGate()
    let releaseConfirmation!: () => void
    const confirmationBlocked = new Promise<void>((resolve) => {
      releaseConfirmation = resolve
    })
    const confirm = vi.fn(async () => {
      await confirmationBlocked
      return false
    })
    const runs = {
      hasActiveRuns: () => false,
      withStateRestoreReservation: async (restore: () => Promise<void>) =>
        restore()
    }
    const first = restoreSelectedLocalStateSnapshot(
      store,
      runs,
      gate,
      snapshotReview.id,
      confirm,
      async () => undefined,
      vi.fn()
    )
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))

    await expect(
      restoreSelectedLocalStateSnapshot(
        store,
        runs,
        gate,
        snapshotReview.id,
        confirm,
        async () => undefined,
        vi.fn()
      )
    ).rejects.toThrow(/restore request is already in progress/i)
    expect(confirm).toHaveBeenCalledTimes(1)

    releaseConfirmation()
    await expect(first).resolves.toBe(false)
  })

  it('exports only after the main process supplies a native destination', async () => {
    const { store, exportSnapshot, assertSelection } = fakeStore()
    const snapshotId =
      'state_snapshot_00000000-0000-4000-8000-000000000000'

    await expect(
      exportSelectedLocalStateSnapshot(
        store,
        snapshotId,
        async () => undefined
      )
    ).resolves.toBe(false)
    expect(assertSelection).toHaveBeenCalledWith(snapshotId, false)
    expect(exportSnapshot).not.toHaveBeenCalled()

    await expect(
      exportSelectedLocalStateSnapshot(
        store,
        snapshotId,
        async () => '/native/selection.ground-state.json'
      )
    ).resolves.toBe(true)
    expect(exportSnapshot).toHaveBeenCalledWith(
      snapshotId,
      '/native/selection.ground-state.json'
    )
  })
})
