import { describe, expect, it } from 'vitest'
import type { AppSnapshot, DesktopTask } from '../../../shared/types'
import {
  preserveNewerTaskSelection,
  selectTaskInSnapshot
} from './task-selection'

const timestamp = '2026-07-30T00:00:00.000Z'

function task(id: string): DesktopTask {
  return {
    id,
    title: id,
    providerId: 'provider',
    mode: 'agent',
    runStatus: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
    items: []
  }
}

function snapshot(): AppSnapshot {
  return {
    providers: [],
    mcpServers: [],
    tasks: [task('task-a'), task('task-b')],
    settings: {
      defaultProviderId: 'provider',
      sidebarCollapsed: false,
      selectedTaskId: 'task-a'
    },
    runEventRevision: 42
  }
}

describe('task selection snapshots', () => {
  it('changes only settings on the exact latest snapshot', () => {
    const current = snapshot()
    const next = selectTaskInSnapshot(current, 'task-b')

    expect(next).not.toBe(current)
    expect(next?.settings).toEqual({
      defaultProviderId: 'provider',
      sidebarCollapsed: false,
      selectedTaskId: 'task-b'
    })
    expect(next?.tasks).toBe(current.tasks)
    expect(next?.providers).toBe(current.providers)
    expect(next?.runEventRevision).toBe(42)
  })

  it('keeps the current snapshot for an existing selection or missing task', () => {
    const current = snapshot()

    expect(selectTaskInSnapshot(current, 'task-a')).toBe(current)
    expect(selectTaskInSnapshot(current, 'missing')).toBe(current)
    expect(selectTaskInSnapshot(undefined, 'task-a')).toBeUndefined()
  })

  it('preserves a newer optimistic selection across an older refresh boundary', () => {
    const refreshed = snapshot()

    const preserved = preserveNewerTaskSelection(refreshed, 4, {
      request: 5,
      taskId: 'task-b'
    })

    expect(preserved.settings.selectedTaskId).toBe('task-b')
    expect(preserved.tasks).toBe(refreshed.tasks)
    expect(
      preserveNewerTaskSelection(refreshed, 5, {
        request: 5,
        taskId: 'task-b'
      })
    ).toBe(refreshed)
    expect(
      preserveNewerTaskSelection(refreshed, 4, {
        request: 5,
        taskId: 'missing'
      })
    ).toBe(refreshed)
  })
})
