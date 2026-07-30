import { describe, expect, it } from 'vitest'
import type { RunStatus } from '../../../shared/types'
import { shouldRefreshGitOverviewAfterRun } from './git-refresh'

const RUN_STATUSES: readonly RunStatus[] = [
  'idle',
  'running',
  'awaiting-approval',
  'failed'
]

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  'running',
  'awaiting-approval'
])

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['idle', 'failed'])

const TRANSITIONS = RUN_STATUSES.flatMap((previous) =>
  RUN_STATUSES.map((current) => ({
    previous,
    current,
    expected:
      ACTIVE_RUN_STATUSES.has(previous) &&
      TERMINAL_RUN_STATUSES.has(current)
  }))
)

describe('Git overview run-transition refresh', () => {
  it.each(TRANSITIONS)(
    'returns $expected for $previous → $current',
    ({ previous, current, expected }) => {
      expect(
        shouldRefreshGitOverviewAfterRun(previous, current)
      ).toBe(expected)
    }
  )

  it('emits one refresh boundary for each active-to-terminal transition', () => {
    const statuses: readonly RunStatus[] = [
      'idle',
      'running',
      'running',
      'awaiting-approval',
      'awaiting-approval',
      'idle',
      'idle',
      'failed',
      'running',
      'failed',
      'failed'
    ]

    const refreshBoundaries = statuses
      .slice(1)
      .filter((current, index) =>
        shouldRefreshGitOverviewAfterRun(
          statuses[index] ?? 'idle',
          current
        )
      )

    expect(refreshBoundaries).toEqual(['idle', 'failed'])
  })
})
