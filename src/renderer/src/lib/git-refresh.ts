import type { RunStatus } from '../../../shared/types'

function isActiveRunStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'awaiting-approval'
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'idle' || status === 'failed'
}

export function shouldRefreshGitOverviewAfterRun(
  previous: RunStatus,
  current: RunStatus
): boolean {
  return isActiveRunStatus(previous) && isTerminalRunStatus(current)
}
