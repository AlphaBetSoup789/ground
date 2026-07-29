import type {
  GitRecoverySummary as ServiceGitRecoverySummary,
  PreparedGitPathRevert,
  PreparedGitRecoveryUndo
} from './git-service'
import type { GitRecoverySummary } from '../shared/types'

export const MAX_OVERVIEW_GIT_RECOVERIES = 20

function projectRecovery(
  recovery: ServiceGitRecoverySummary
): GitRecoverySummary {
  return {
    id: recovery.id,
    createdAt: recovery.createdAt,
    status: recovery.status,
    trackedPaths: [...recovery.trackedPaths],
    untrackedPaths: [...recovery.untrackedPaths],
    canUndo: recovery.canUndo
  }
}

export function projectGitRecovery(
  recovery: ServiceGitRecoverySummary
): GitRecoverySummary {
  return projectRecovery(recovery)
}

export function projectGitRecoveries(
  recoveries: readonly ServiceGitRecoverySummary[]
): {
  recoveries: GitRecoverySummary[]
  recoveriesTruncated: boolean
} {
  const ordered = [
    ...recoveries.filter(
      (recovery) => recovery.status === 'recovery-required'
    ),
    ...recoveries.filter(
      (recovery) =>
        recovery.status !== 'recovery-required' && recovery.canUndo
    ),
    ...recoveries.filter(
      (recovery) =>
        recovery.status !== 'recovery-required' && !recovery.canUndo
    )
  ]
  return {
    recoveries: ordered
      .slice(0, MAX_OVERVIEW_GIT_RECOVERIES)
      .map(projectRecovery),
    recoveriesTruncated: recoveries.length > MAX_OVERVIEW_GIT_RECOVERIES
  }
}

export function gitPathRevertConfirmationOptions(
  prepared: PreparedGitPathRevert
): Electron.MessageBoxOptions {
  const pathCount =
    prepared.trackedPaths.length + prepared.untrackedPaths.length
  return {
    type: 'warning',
    buttons: ['Cancel', 'Restore selected files'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Restore working-tree files',
    message: `Restore ${pathCount} selected ${
      pathCount === 1 ? 'file' : 'files'
    } to the current Git index?`,
    detail: [
      'Complete reviewed preview:',
      '',
      prepared.preview,
      '',
      `Preview SHA-256: ${prepared.previewSha256}`,
      `Action SHA-256: ${prepared.actionSha256}`,
      '',
      'Recovery behavior:',
      '• Tracked working-tree contents are copied into Ground’s private recovery area before Git restores them to the current index. Existing staged changes stay staged.',
      '• Selected untracked files are moved into that recovery area instead of being deleted.',
      '• Ground offers a conservative undo only while every affected path still matches the post-restore state.',
      '• If the operation cannot finish cleanly, Ground preserves the recovery and marks it as recovery required.'
    ].join('\n')
  }
}

export function gitRecoveryUndoConfirmationOptions(
  prepared: PreparedGitRecoveryUndo
): Electron.MessageBoxOptions {
  return {
    type: 'warning',
    buttons: ['Cancel', 'Undo restore'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Undo recoverable Git restore',
    message: 'Return the affected files to their exact pre-restore state?',
    detail: [
      'Complete reviewed preview:',
      '',
      prepared.preview,
      '',
      `Preview SHA-256: ${prepared.previewSha256}`,
      `Action SHA-256: ${prepared.actionSha256}`,
      '',
      'Ground will revalidate the recovery manifest, every recovery payload, and every affected workspace path immediately before undo. It will refuse to overwrite later changes.'
    ].join('\n')
  }
}
