import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitRecoverySummary, GitStatusSummary } from '../../../shared/types'

vi.mock('../lib/desktop', () => ({ desktop: {} }))

import {
  eligibleGitRestorePaths,
  GitRecoveryActions,
  RecoveryRequiredNotice
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
