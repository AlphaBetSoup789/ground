import { describe, expect, it } from 'vitest'
import type {
  AppSnapshot,
  DesktopRunEvent,
  DesktopTask
} from '../../shared/types'
import {
  applyRunEvent,
  applyRunEventEnvelope,
  materializeActiveRunEvents,
  reconcileSnapshotWithEvents
} from './lib/run-events'

function task(id: string, content: string): DesktopTask {
  return {
    id,
    title: id,
    providerId: 'provider',
    mode: 'agent',
    runStatus: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [
      {
        id: `${id}-message`,
        kind: 'message',
        runId: `${id}-run`,
        role: 'assistant',
        content,
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]
  }
}

function snapshot(): AppSnapshot {
  return {
    providers: [
      {
        id: 'provider',
        name: 'Local model',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'test',
        hasApiKey: false,
        supportsTools: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    mcpServers: [],
    tasks: [task('selected', 'Hello'), task('unrelated', 'Keep me stable')],
    settings: {
      sidebarCollapsed: false,
      defaultProviderId: 'provider',
      selectedTaskId: 'selected'
    }
  }
}

describe('applyRunEvent', () => {
  it('updates only the affected task and item during streaming', () => {
    const current = snapshot()
    const event: DesktopRunEvent = {
      type: 'text-delta',
      taskId: 'selected',
      runId: 'selected-run',
      itemId: 'selected-message',
      delta: ' world'
    }

    const next = applyRunEvent(current, event)

    expect(next).not.toBe(current)
    expect(next.providers).toBe(current.providers)
    expect(next.settings).toBe(current.settings)
    expect(next.tasks).not.toBe(current.tasks)
    expect(next.tasks[1]).toBe(current.tasks[1])
    expect(next.tasks[0]).not.toBe(current.tasks[0])
    expect(next.tasks[0]?.items[0]).not.toBe(current.tasks[0]?.items[0])
    expect(next.tasks[0]?.items[0]).toMatchObject({
      kind: 'message',
      content: 'Hello world'
    })
    expect(current.tasks[0]?.items[0]).toMatchObject({
      kind: 'message',
      content: 'Hello'
    })
  })

  it('keeps the existing snapshot when an event targets an unknown task', () => {
    const current = snapshot()
    const event: DesktopRunEvent = {
      type: 'run-stopped',
      taskId: 'missing',
      runId: 'missing-run'
    }

    expect(applyRunEvent(current, event)).toBe(current)
  })

  it('replays only events newer than a settled snapshot', () => {
    const current = { ...snapshot(), runEventRevision: 4 }
    const old = applyRunEventEnvelope(current, {
      revision: 4,
      event: {
        type: 'text-delta',
        taskId: 'selected',
        runId: 'selected-run',
        itemId: 'selected-message',
        delta: ' duplicate'
      }
    })
    const next = applyRunEventEnvelope(old, {
      revision: 5,
      event: {
        type: 'text-delta',
        taskId: 'selected',
        runId: 'selected-run',
        itemId: 'selected-message',
        delta: ' once'
      }
    })

    expect(old).toBe(current)
    expect(next.runEventRevision).toBe(5)
    expect(next.tasks[0]?.items[0]).toMatchObject({
      content: 'Hello once'
    })
  })

  it('materializes an active streamed item when a renderer reconnects', () => {
    const current = snapshot()
    current.tasks[0] = {
      ...(current.tasks[0] as DesktopTask),
      items: []
    }
    current.runEventRevision = 8
    current.activeRunEvents = [
      {
        revision: 6,
        event: {
          type: 'item-added',
          taskId: 'selected',
          runId: 'selected-run',
          item: {
            id: 'streamed',
            kind: 'message',
            runId: 'selected-run',
            role: 'assistant',
            content: '',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        }
      },
      {
        revision: 8,
        event: {
          type: 'text-delta',
          taskId: 'selected',
          runId: 'selected-run',
          itemId: 'streamed',
          delta: 'Still working'
        }
      }
    ]

    const next = materializeActiveRunEvents(current)

    expect(next.activeRunEvents).toBeUndefined()
    expect(next.runEventRevision).toBe(8)
    expect(next.tasks[0]?.items[0]).toMatchObject({
      id: 'streamed',
      content: 'Still working'
    })
  })

  it('does not duplicate an active delta already present in durable state', () => {
    const current = snapshot()
    current.runEventRevision = 20
    current.activeRunEvents = [
      {
        revision: 19,
        event: {
          type: 'item-added',
          taskId: 'selected',
          runId: 'selected-run',
          item: {
            id: 'selected-message',
            kind: 'message',
            runId: 'selected-run',
            role: 'assistant',
            content: '',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        }
      },
      {
        revision: 20,
        event: {
          type: 'text-delta',
          taskId: 'selected',
          runId: 'selected-run',
          itemId: 'selected-message',
          delta: 'Hello',
          offset: 0
        }
      }
    ]

    const next = materializeActiveRunEvents(current)
    expect(next.tasks[0]?.items[0]).toMatchObject({
      content: 'Hello'
    })
  })

  it('replays an event delivered while a later snapshot refresh is in flight', () => {
    const stale = snapshot()
    stale.runEventRevision = 10
    const selected = stale.tasks[0] as DesktopTask
    selected.items = [
      {
        id: 'streamed',
        kind: 'message',
        runId: 'selected-run',
        role: 'assistant',
        content: 'A',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]

    const next = reconcileSnapshotWithEvents(stale, [
      {
        revision: 11,
        event: {
          type: 'text-delta',
          taskId: 'selected',
          runId: 'selected-run',
          itemId: 'streamed',
          delta: 'B'
        }
      },
      {
        revision: 12,
        event: {
          type: 'run-completed',
          taskId: 'selected',
          runId: 'selected-run'
        }
      }
    ])

    expect(next.runEventRevision).toBe(12)
    expect(next.tasks[0]?.runStatus).toBe('idle')
    expect(next.tasks[0]?.items[0]).toMatchObject({ content: 'AB' })
  })
})
