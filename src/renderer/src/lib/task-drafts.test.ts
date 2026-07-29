import { describe, expect, it } from 'vitest'
import { updateTaskDraft } from './task-drafts'

describe('task drafts', () => {
  it('preserves drafts independently while switching tasks', () => {
    const first = updateTaskDraft({}, 'task-a', 'Review the auth flow')
    const second = updateTaskDraft(first, 'task-b', 'Run the tests')

    expect(second).toEqual({
      'task-a': 'Review the auth flow',
      'task-b': 'Run the tests'
    })
  })

  it('removes empty drafts instead of retaining stale task entries', () => {
    const drafts = {
      'task-a': 'Keep this',
      'task-b': 'Send this'
    }

    expect(updateTaskDraft(drafts, 'task-b', '')).toEqual({
      'task-a': 'Keep this'
    })
    expect(updateTaskDraft({}, 'missing', '')).toEqual({})
  })

  it('keeps referential identity for unchanged values', () => {
    const drafts = { task: 'Same prompt' }

    expect(updateTaskDraft(drafts, 'task', 'Same prompt')).toBe(drafts)
  })
})
