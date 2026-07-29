import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesktopTask } from '../../../shared/types'
import { shouldFollowTimeline, Timeline } from './Timeline'

describe('timeline output following', () => {
  it('keeps following while the viewport is at or near the latest output', () => {
    expect(
      shouldFollowTimeline({
        clientHeight: 600,
        scrollHeight: 1_600,
        scrollTop: 920
      })
    ).toBe(true)
  })

  it('stops following after the user scrolls away from the latest output', () => {
    expect(
      shouldFollowTimeline({
        clientHeight: 600,
        scrollHeight: 1_600,
        scrollTop: 800
      })
    ).toBe(false)
  })

  it('separates streamed text from its batched screen-reader announcer', () => {
    const task: DesktopTask = {
      id: 'task',
      title: 'Accessible streaming',
      providerId: 'provider',
      mode: 'agent',
      runStatus: 'running',
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
      items: [
        {
          id: 'assistant-message',
          kind: 'message',
          runId: 'run',
          role: 'assistant',
          content: 'A response in progress',
          createdAt: '2026-07-29T12:00:00.000Z'
        }
      ]
    }

    const markup = renderToStaticMarkup(
      createElement(Timeline, {
        task,
        suggestions: [],
        onSuggestion: () => undefined,
        onResolveApproval: async () => undefined,
        onSetImportedHistory: () => undefined
      })
    )

    expect(markup).toContain('role="log"')
    expect(markup).toContain('aria-relevant="additions"')
    expect(markup).toContain('aria-live="off"')
    expect(markup).toContain(
      'class="visually-hidden assistant-announcement" role="status" aria-live="polite" aria-atomic="true" aria-relevant="additions text"'
    )
  })
})
