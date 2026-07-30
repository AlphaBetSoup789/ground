import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  DesktopTask,
  ProviderFailureKind,
  ProviderProfile
} from '../../../shared/types'
import {
  shouldApplyTimelineJump,
  shouldFollowTimeline,
  shouldOfferTimelineJump,
  Timeline,
  TimelineJumpControl
} from './Timeline'

const TIMELINE_FAILURE_PRESENTATIONS = {
  'connection-refused': {
    title: 'Connection refused',
    correctiveSnippet: 'Base URL and port'
  },
  dns: {
    title: 'Provider host was not found',
    correctiveSnippet: 'DNS or network connection'
  },
  tls: {
    title: 'Secure connection failed',
    correctiveSnippet: 'certificate verification'
  },
  authentication: {
    title: 'Provider rejected the credential',
    correctiveSnippet: 'saved API key or CLI sign-in'
  },
  'rate-limit': {
    title: 'Provider rate limit reached',
    correctiveSnippet: 'retry window'
  },
  timeout: {
    title: 'Provider did not respond in time',
    correctiveSnippet: 'provider availability'
  },
  'protocol-shape': {
    title: 'Provider returned an incompatible response',
    correctiveSnippet: 'selected provider type'
  },
  'executable-not-found': {
    title: 'CLI executable was not found',
    correctiveSnippet: 'saved path'
  },
  'external-runtime-startup': {
    title: 'CLI runtime could not start',
    correctiveSnippet: 'permissions, arguments, and environment'
  }
} as const satisfies Record<
  ProviderFailureKind,
  { readonly title: string; readonly correctiveSnippet: string }
>

function renderFailureTimeline(
  failureKind?: ProviderFailureKind
): string {
  const task: DesktopTask = {
    id: 'task',
    title: 'Failed runtime',
    providerId: 'provider',
    mode: 'agent',
    runStatus: 'failed',
    createdAt: '2026-07-29T12:00:00.000Z',
    updatedAt: '2026-07-29T12:01:00.000Z',
    items: [
      {
        id: 'failure',
        kind: 'activity',
        runId: 'run',
        activityType: 'error',
        title: 'Run failed',
        detail: 'Credential-safe provider diagnostic.',
        ...(failureKind ? { failureKind } : {}),
        status: 'error',
        createdAt: '2026-07-29T12:01:00.000Z'
      }
    ]
  }
  return renderToStaticMarkup(
    createElement(Timeline, {
      task,
      suggestions: [],
      onSuggestion: () => undefined,
      onResolveApproval: async () => undefined,
      onSetImportedHistory: () => undefined
    })
  )
}

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
        scrollTop: 919
      })
    ).toBe(false)
  })

  it('offers a jump only for a scrollable viewport beyond the follow threshold', () => {
    expect(
      shouldOfferTimelineJump({
        clientHeight: 600,
        scrollHeight: 600,
        scrollTop: 0
      })
    ).toBe(false)
    expect(
      shouldOfferTimelineJump({
        clientHeight: 600,
        scrollHeight: 1_600,
        scrollTop: 920
      })
    ).toBe(false)
    expect(
      shouldOfferTimelineJump({
        clientHeight: 600,
        scrollHeight: 1_600,
        scrollTop: 919
      })
    ).toBe(true)
  })

  it('applies a jump only to the exact current task viewport', () => {
    expect(
      shouldApplyTimelineJump({
        requestedTaskId: 'task-a',
        currentTaskId: 'task-a',
        requestedViewportIsCurrent: true
      })
    ).toBe(true)
    expect(
      shouldApplyTimelineJump({
        requestedTaskId: 'task-a',
        currentTaskId: 'task-b',
        requestedViewportIsCurrent: true
      })
    ).toBe(false)
    expect(
      shouldApplyTimelineJump({
        requestedTaskId: 'task-a',
        currentTaskId: 'task-a',
        requestedViewportIsCurrent: false
      })
    ).toBe(false)
  })

  it('renders a native jump action outside a polite status region', () => {
    const markup = renderToStaticMarkup(
      createElement(TimelineJumpControl, {
        visible: true,
        announcement:
          'Moved to latest activity. Following new output.',
        revision: 1,
        controlsId: 'task-timeline',
        onJump: () => undefined
      })
    )

    expect(markup).toContain(
      'class="timeline-jump-latest" type="button" aria-controls="task-timeline"'
    )
    expect(markup).toContain('Jump to latest')
    expect(markup).toContain(
      'class="visually-hidden timeline-jump-status" role="status" aria-live="polite" aria-atomic="true"'
    )
    expect(markup).toContain(
      'Moved to latest activity. Following new output.'
    )

    const hiddenMarkup = renderToStaticMarkup(
      createElement(TimelineJumpControl, {
        visible: false,
        announcement: '',
        revision: 0,
        controlsId: 'task-timeline',
        onJump: () => undefined
      })
    )
    expect(hiddenMarkup).not.toContain('Jump to latest')
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

  it.each(Object.entries(TIMELINE_FAILURE_PRESENTATIONS))(
    'shows shared corrective guidance for a retained %s run failure',
    (failureKind, expected) => {
      const markup = renderFailureTimeline(
        failureKind as ProviderFailureKind
      )

      expect(markup).toContain(
        'class="provider-failure-guidance" aria-label="Provider failure guidance"'
      )
      expect(markup).toContain(expected.title)
      expect(markup).toContain(expected.correctiveSnippet)
      expect(markup).toContain('Credential-safe provider diagnostic.')
    }
  )

  it('keeps legacy run failures generic', () => {
    const markup = renderFailureTimeline()
    expect(markup).toContain('Run failed')
    expect(markup).toContain('Credential-safe provider diagnostic.')
    expect(markup).not.toContain('provider-failure-guidance')
  })

  it('offers an explicit, unsent Agent handoff after an eligible Ask response', () => {
    const provider: ProviderProfile = {
      id: 'provider',
      name: 'Local model',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'test-model',
      hasApiKey: false,
      supportsTools: true,
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z'
    }
    const task: DesktopTask = {
      id: 'task',
      title: 'Plan a change',
      workspace: { id: 'workspace', name: 'ground' },
      providerId: provider.id,
      mode: 'ask',
      runStatus: 'idle',
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:01:00.000Z',
      items: [
        {
          id: 'assistant',
          kind: 'message',
          role: 'assistant',
          content: 'Here is a bounded implementation plan.',
          createdAt: '2026-07-29T12:01:00.000Z'
        }
      ]
    }

    const markup = renderToStaticMarkup(
      createElement(Timeline, {
        task,
        provider,
        suggestions: [],
        onSuggestion: () => undefined,
        onResolveApproval: async () => undefined,
        onSetImportedHistory: () => undefined,
        onContinueInAgent: async () => true
      })
    )

    expect(markup).toContain('Ready to implement?')
    expect(markup).toContain('Continue in Agent')
    expect(markup).toContain('Nothing runs until you send it.')
  })
})
