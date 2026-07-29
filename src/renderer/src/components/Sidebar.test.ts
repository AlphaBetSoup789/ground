import { describe, expect, it } from 'vitest'
import type { Task } from '../../../shared/types'
import { taskMatchesQuery } from './Sidebar'

function taskWithMessages(contents: string[]): Task {
  const timestamp = '2026-07-28T12:00:00.000Z'
  return {
    id: 'task',
    title: 'Lifecycle work',
    providerId: 'provider',
    mode: 'agent',
    runStatus: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
    items: contents.map((content, index) => ({
      id: `message-${index}`,
      kind: 'message',
      role: 'user',
      content,
      createdAt: timestamp
    }))
  }
}

describe('sidebar task search', () => {
  it('matches bounded timeline content as well as task metadata', () => {
    const task = taskWithMessages(['Earlier context', 'A distinctive timeline phrase'])

    expect(
      taskMatchesQuery(task, 'Provider name', 'model-name', 'timeline phrase')
    ).toBe(true)
    expect(
      taskMatchesQuery(task, 'Provider name', 'model-name', 'provider name')
    ).toBe(true)
  })

  it('does not scan unbounded history or oversized message fields', () => {
    const tooOld = taskWithMessages([
      'needle outside item window',
      ...Array.from({ length: 80 }, (_, index) => `recent message ${index}`)
    ])
    const tooDeep = taskWithMessages([
      `${'x'.repeat(4_000)}needle outside field window`
    ])

    expect(
      taskMatchesQuery(tooOld, undefined, undefined, 'needle outside')
    ).toBe(false)
    expect(
      taskMatchesQuery(tooDeep, undefined, undefined, 'needle outside')
    ).toBe(false)
  })
})
