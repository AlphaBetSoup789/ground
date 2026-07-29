import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesktopTask } from '../../../shared/types'
import {
  Sidebar,
  groupTasksByWorkspace,
  taskMatchesQuery
} from './Sidebar'

function taskWithMessages(contents: string[]): DesktopTask {
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
  it('groups by opaque identity even when display names collide', () => {
    const first = taskWithMessages([])
    const second = { ...taskWithMessages([]), id: 'second' }
    const shared = { ...taskWithMessages([]), id: 'shared' }
    first.workspace = {
      id: 'workspace_12345678-1234-4123-8123-123456789abc',
      name: 'project'
    }
    second.workspace = {
      id: 'workspace_87654321-4321-4321-8321-cba987654321',
      name: 'project'
    }
    shared.workspace = { ...first.workspace }

    const groups = groupTasksByWorkspace([first, second, shared])

    expect(groups).toHaveLength(2)
    expect(groups.map(([, tasks]) => tasks.map((task) => task.id))).toEqual([
      ['task', 'shared'],
      ['second']
    ])
  })

  it('renders main-issued path-free disambiguated workspace labels', () => {
    const first = taskWithMessages([])
    const second = { ...taskWithMessages([]), id: 'second' }
    first.workspace = {
      id: 'workspace_12345678-1234-4123-8123-123456789abc',
      name: 'project'
    }
    second.workspace = {
      id: 'workspace_87654321-4321-4321-8321-cba987654321',
      name: 'project · 2'
    }

    const markup = renderToStaticMarkup(
      createElement(Sidebar, {
        open: true,
        snapshot: {
          providers: [],
          mcpServers: [],
          tasks: [first, second],
          settings: {
            defaultProviderId: 'provider',
            sidebarCollapsed: false
          }
        },
        onSelectTask: () => undefined,
        onCreateTask: () => undefined,
        onChooseWorkspace: () => undefined,
        onImportTask: () => undefined,
        onOpenSettings: () => undefined,
        onClose: () => undefined
      })
    )

    expect(markup).toContain('project')
    expect(markup).toContain('project · 2')
  })

  it('matches bounded timeline content as well as task metadata', () => {
    const task = taskWithMessages(['Earlier context', 'A distinctive timeline phrase'])
    task.workspace = {
      id: 'workspace_12345678-1234-4123-8123-123456789abc',
      name: 'Acme dashboard'
    }

    expect(
      taskMatchesQuery(task, 'Provider name', 'model-name', 'timeline phrase')
    ).toBe(true)
    expect(
      taskMatchesQuery(task, 'Provider name', 'model-name', 'provider name')
    ).toBe(true)
    expect(
      taskMatchesQuery(task, 'Provider name', 'model-name', 'acme dashboard')
    ).toBe(true)
    expect(
      taskMatchesQuery(task, 'Provider name', 'model-name', '123456789abc')
    ).toBe(false)
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
