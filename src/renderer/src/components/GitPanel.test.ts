import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  GitOverview,
  GitRecoverySummary,
  GitStatusSummary
} from '../../../shared/types'

vi.mock('../lib/desktop', () => ({ desktop: {} }))

import {
  eligibleGitStagePaths,
  eligibleGitRestorePaths,
  eligibleGitUnstagePaths,
  gitOverviewForTask,
  GitRecoveryActions,
  RecoveryRequiredNotice,
  retainEligibleGitPaths
} from './GitPanel'

const timestamp = '2026-07-28T12:00:00.000Z'

function recovery(
  status: GitRecoverySummary['status'],
  canUndo: boolean
): GitRecoverySummary {
  return {
    id: '12345678-1234-4123-8123-123456789abc',
    createdAt: timestamp,
    status,
    trackedPaths: ['src/modified.ts'],
    untrackedPaths: ['notes/new file.txt'],
    canUndo
  }
}

describe('GitPanel recoverable restore presentation', () => {
  it('never exposes an overview loaded for a different task', () => {
    const overview: GitOverview = {
      isRepository: true,
      commits: [],
      historyTruncated: false,
      worktrees: [],
      recoveries: [],
      recoveriesTruncated: false
    }
    const loaded = { taskId: 'source-task', overview }

    expect(gitOverviewForTask(loaded, 'source-task')).toBe(overview)
    expect(gitOverviewForTask(loaded, 'other-task')).toBeUndefined()
    expect(gitOverviewForTask(undefined, 'source-task')).toBeUndefined()
  })

  it('offers only eligible modified and untracked paths', () => {
    const status: GitStatusSummary = {
      branch: 'main',
      detached: false,
      staged: ['src/staged-only.ts'],
      unstaged: ['src/conflicted.ts', 'src/modified.ts'],
      untracked: ['notes/new file.txt', 'src/conflicted.ts'],
      conflicted: ['src/conflicted.ts']
    }

    expect(eligibleGitRestorePaths(status)).toEqual([
      'notes/new file.txt',
      'src/modified.ts'
    ])
  })

  it('builds stable stage and unstage eligibility without conflict ambiguity', () => {
    const status: GitStatusSummary = {
      branch: 'main',
      detached: false,
      staged: ['src/staged.ts', 'src/conflicted.ts'],
      unstaged: [
        'src/conflicted.ts',
        'src/modified.ts',
        'src/modified.ts'
      ],
      untracked: [
        'notes/new.txt',
        'src/modified.ts',
        'src/conflicted.ts',
        'notes/new.txt'
      ],
      conflicted: ['src/conflicted.ts']
    }

    expect(eligibleGitStagePaths(status)).toEqual([
      'src/conflicted.ts',
      'src/modified.ts',
      'notes/new.txt'
    ])
    expect(eligibleGitUnstagePaths(status)).toEqual(['src/staged.ts'])
  })

  it('retains valid selections in user order and prunes stale paths', () => {
    expect(
      retainEligibleGitPaths(
        [
          'src/keep-second.ts',
          'src/removed.ts',
          'src/moved.ts',
          'src/conflicted.ts',
          'src/keep-first.ts'
        ],
        ['src/keep-first.ts', 'src/keep-second.ts']
      )
    ).toEqual(['src/keep-second.ts', 'src/keep-first.ts'])
  })

  it('empties every path selection when Git status is unavailable', () => {
    expect(eligibleGitStagePaths(undefined)).toEqual([])
    expect(eligibleGitUnstagePaths(undefined)).toEqual([])
    expect(eligibleGitRestorePaths(undefined)).toEqual([])
    expect(retainEligibleGitPaths(['src/selected.ts'], [])).toEqual([])
  })

  it('renders accessible selection and a conservative undo without exposing recovery IDs', () => {
    const record = recovery('applied', true)
    const markup = renderToStaticMarkup(
      createElement(GitRecoveryActions, {
        eligiblePaths: ['src/modified.ts', 'notes/new file.txt'],
        selectedPaths: ['src/modified.ts'],
        recoveries: [record],
        recoveriesTruncated: false,
        onSelectedPathsChange: () => undefined,
        onRestore: () => undefined,
        onUndoRecovery: () => undefined
      })
    )

    expect(markup).toContain(
      'Select modified or untracked paths to restore'
    )
    expect(markup).toContain('Restore selected (1)')
    expect(markup).toContain('Staged changes remain staged')
    expect(markup).toContain('Undo available')
    expect(markup).toContain('Undo recoverable restore from')
    expect(markup).not.toContain(record.id)
  })

  it('surfaces an incomplete restore as an alert with conservative guidance', () => {
    const markup = renderToStaticMarkup(
      createElement(RecoveryRequiredNotice, {
        recoveries: [recovery('recovery-required', false)]
      })
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Git recovery required')
    expect(markup).toContain('Avoid editing the affected paths')
    expect(markup).toContain('automatic undo is disabled')
  })
})
