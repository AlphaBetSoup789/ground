import type { LocalStateSnapshotReview, StateStore } from './store'

const STATE_EXPORT_SUFFIX = '.ground-state.json'

export interface StateRestoreRunGate {
  hasActiveRuns(): boolean
  withStateRestoreReservation(
    restore: () => Promise<void>
  ): Promise<void>
}

export interface StateRestoreMutationGate {
  withRestoreRequest<Result>(request: () => Promise<Result>): Promise<Result>
  withExclusiveRestore<Result>(
    restore: (holdForProcessExit: () => void) => Promise<Result>
  ): Promise<Result>
}

export interface StateRestoreConfirmationOptions {
  type: 'warning'
  buttons: [string, string]
  defaultId: 0
  cancelId: 0
  noLink: true
  title: string
  message: string
  detail: string
}

export function stateRestoreConfirmationOptions(
  snapshot: LocalStateSnapshotReview
): StateRestoreConfirmationOptions {
  return {
    type: 'warning',
    buttons: ['Cancel', 'Restore and relaunch'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Restore retained local state',
    message: 'Replace Ground’s current local history with this snapshot?',
    detail: [
      `Retained generation: ${snapshot.generation}`,
      `Captured: ${snapshot.capturedAt}`,
      `Tasks: ${snapshot.taskCount}`,
      `Providers: ${snapshot.providerCount}`,
      `Size: ${snapshot.sizeBytes.toLocaleString('en-US')} bytes`,
      `Content SHA-256: ${snapshot.contentSha256.slice(0, 16)}…`,
      '',
      'Ground will preserve the current state as the newest recovery generation, restore the exact retained snapshot you selected, and relaunch immediately.',
      '',
      'Provider credentials remain in the operating-system credential vault and are not part of state snapshots.',
      '',
      'Review the restored tasks before continuing any previously interrupted work.'
    ].join('\n')
  }
}

export function localStateSnapshotFilename(timestamp = new Date()): string {
  return `Ground state ${timestamp.toISOString().slice(0, 10)}${STATE_EXPORT_SUFFIX}`
}

export function ensureLocalStateSnapshotExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith(STATE_EXPORT_SUFFIX)
    ? filePath
    : `${filePath}${STATE_EXPORT_SUFFIX}`
}

export async function exportSelectedLocalStateSnapshot(
  store: StateStore,
  snapshotId: string,
  chooseTargetPath: () => Promise<string | undefined>
): Promise<boolean> {
  await store.assertLocalStateSnapshotSelection(snapshotId, false)
  const targetPath = await chooseTargetPath()
  if (!targetPath) return false
  await store.exportLocalStateSnapshot(snapshotId, targetPath)
  return true
}

export async function restoreSelectedLocalStateSnapshot(
  store: StateStore,
  runs: StateRestoreRunGate,
  mutations: StateRestoreMutationGate,
  snapshotId: string,
  confirm: (snapshot: LocalStateSnapshotReview) => Promise<boolean>,
  prepareForRestore: () => Promise<void>,
  relaunch: () => void
): Promise<boolean> {
  return mutations.withRestoreRequest(async () => {
    if (runs.hasActiveRuns()) {
      throw new Error('Stop active runs before restoring local state')
    }
    const review = await store.assertLocalStateSnapshotSelection(
      snapshotId,
      true
    )
    if (!(await confirm(review))) return false
    await runs.withStateRestoreReservation(async () => {
      await mutations.withExclusiveRestore(async (holdForProcessExit) => {
        // Mutations that entered before the latch closed may have rotated the
        // retained generations. Revalidate the opaque, content-bound selection
        // only after every such mutation has settled.
        await store.assertLocalStateSnapshotSelection(snapshotId, true)

        // From this point onward, any failure is fail-closed through a process
        // restart. MCP startup is aborted/drained before replacement, and the
        // latch cannot reopen if the state rename succeeds but a later fsync
        // reports failure.
        holdForProcessExit()
        try {
          await prepareForRestore()
          await store.assertLocalStateSnapshotSelection(snapshotId, true)
          await store.restoreLocalStateSnapshot(snapshotId)
        } finally {
          relaunch()
        }
      })
    })
    return true
  })
}
