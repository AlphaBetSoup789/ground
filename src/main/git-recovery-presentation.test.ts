import { describe, expect, it } from 'vitest'
import type {
  GitRecoverySummary,
  PreparedGitPathRevert,
  PreparedGitRecoveryUndo
} from './git-service'
import {
  gitPathRevertConfirmationOptions,
  gitRecoveryUndoConfirmationOptions,
  MAX_OVERVIEW_GIT_RECOVERIES,
  projectGitRecoveries
} from './git-recovery-presentation'

const sha = 'a'.repeat(64)
const otherSha = 'b'.repeat(64)

describe('Git recovery IPC presentation', () => {
  it('keeps restore approval default-cancel and includes the complete bound preview', () => {
    const prepared = {
      version: 1,
      trackedPaths: ['tracked.txt'],
      untrackedPaths: ['new.txt'],
      indexEntries: [],
      workingSnapshots: [],
      preview: 'complete\npreview\nbody',
      previewSha256: sha,
      actionSha256: otherSha
    } as unknown as PreparedGitPathRevert

    const options = gitPathRevertConfirmationOptions(prepared)

    expect(options).toMatchObject({
      buttons: ['Cancel', 'Restore selected files'],
      defaultId: 0,
      cancelId: 0
    })
    expect(options.detail).toContain(prepared.preview)
    expect(options.detail).toContain(`Preview SHA-256: ${sha}`)
    expect(options.detail).toContain(`Action SHA-256: ${otherSha}`)
    expect(options.detail).toContain('Existing staged changes stay staged')
    expect(options.detail).toContain('moved into that recovery area instead of being deleted')
  })

  it('keeps conservative undo approval default-cancel and fully fingerprinted', () => {
    const prepared = {
      version: 1,
      recoveryId: '12345678-1234-4123-8123-123456789abc',
      manifestSha256: sha,
      currentSnapshots: [],
      preview: 'complete undo preview',
      previewSha256: sha,
      actionSha256: otherSha
    } as unknown as PreparedGitRecoveryUndo

    const options = gitRecoveryUndoConfirmationOptions(prepared)

    expect(options).toMatchObject({
      buttons: ['Cancel', 'Undo restore'],
      defaultId: 0,
      cancelId: 0
    })
    expect(options.detail).toContain(prepared.preview)
    expect(options.detail).toContain(`Preview SHA-256: ${sha}`)
    expect(options.detail).toContain(`Action SHA-256: ${otherSha}`)
    expect(options.detail).toContain('refuse to overwrite later changes')
  })

  it('projects a bounded path-only recovery listing', () => {
    const serviceRecoveries: GitRecoverySummary[] = Array.from(
      { length: MAX_OVERVIEW_GIT_RECOVERIES + 2 },
      (_, index) => ({
        id: `12345678-1234-4123-8123-${index.toString().padStart(12, '0')}`,
        createdAt: `2026-07-28T12:${index.toString().padStart(2, '0')}:00.000Z`,
        status: 'applied',
        trackedPaths: Object.freeze([`tracked-${index}.txt`]),
        untrackedPaths: Object.freeze([]),
        canUndo: true
      })
    )

    const projected = projectGitRecoveries(serviceRecoveries)

    expect(projected.recoveries).toHaveLength(MAX_OVERVIEW_GIT_RECOVERIES)
    expect(projected.recoveriesTruncated).toBe(true)
    expect(projected.recoveries[0]).toEqual({
      ...serviceRecoveries[0],
      trackedPaths: ['tracked-0.txt'],
      untrackedPaths: []
    })
    expect(Object.isFrozen(projected.recoveries[0]?.trackedPaths)).toBe(false)
    expect(JSON.stringify(projected)).not.toContain('preview')
    expect(JSON.stringify(projected)).not.toContain('actionSha256')
  })

  it('prioritizes recovery-required records inside the bounded overview', () => {
    const routine = Array.from(
      { length: MAX_OVERVIEW_GIT_RECOVERIES + 2 },
      (_, index) => ({
        id: `12345678-1234-4123-8123-${index.toString().padStart(12, '0')}`,
        createdAt: `2026-07-28T12:${index.toString().padStart(2, '0')}:00.000Z`,
        status: 'restored' as const,
        trackedPaths: [],
        untrackedPaths: [],
        canUndo: false
      })
    )
    const required: GitRecoverySummary = {
      id: '87654321-4321-4321-8321-cba987654321',
      createdAt: '2026-07-20T12:00:00.000Z',
      status: 'recovery-required',
      trackedPaths: ['important.ts'],
      untrackedPaths: [],
      canUndo: false
    }

    const projected = projectGitRecoveries([...routine, required])

    expect(projected.recoveries[0]).toMatchObject({
      id: required.id,
      status: 'recovery-required'
    })
    expect(projected.recoveries).toHaveLength(MAX_OVERVIEW_GIT_RECOVERIES)
    expect(projected.recoveriesTruncated).toBe(true)
  })
})
