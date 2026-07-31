import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesktopTask, ProviderProfile } from '../../../shared/types'
import type { FailedRunRetrySource } from '../lib/failed-run-retry'
import {
  Composer,
  acceptComposerStart,
  claimComposerStart,
  composerShortcutAction,
  composerStartReachedRunBoundary,
  composerStatePolicy,
  releaseComposerStart,
  shouldRestoreFailedSendFocus,
  type PendingComposerStart
} from './Composer'

function task(
  id: string,
  runStatus: DesktopTask['runStatus'] = 'idle'
): DesktopTask {
  return {
    id,
    title: id,
    providerId: 'provider',
    mode: 'agent',
    runStatus,
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:00:00.000Z',
    items: []
  }
}

const provider: ProviderProfile = {
  id: 'provider',
  name: 'Local model',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'test',
  hasApiKey: false,
  supportsTools: true,
  createdAt: '2026-07-30T12:00:00.000Z',
  updatedAt: '2026-07-30T12:00:00.000Z'
}

function renderComposer(
  currentTask: DesktopTask,
  disabled = false,
  options?: {
    draft?: string
    failedRunRetry?: FailedRunRetrySource
  }
): string {
  return renderToStaticMarkup(
    createElement(Composer, {
      draft: options?.draft ?? 'Prepare the next turn',
      onDraftChange: () => undefined,
      onRestoreDraft: () => undefined,
      task: currentTask,
      provider,
      failedRunRetry: options?.failedRunRetry,
      disabled,
      onChooseWorkspace: () => undefined,
      onPrepareFailedRunRetry: () => undefined,
      onSend: async () => undefined,
      onStop: async () => undefined
    })
  )
}

describe('composer active-run drafting', () => {
  it('keeps only archived and unresolved initial-start editors disabled', () => {
    const base = {
      disabled: false,
      draft: 'Next',
      needsWorkspace: false,
      runStatus: 'idle' as const,
      sendBlocked: false,
      startPending: false
    }

    expect(composerStatePolicy(base)).toMatchObject({
      runActive: false,
      textareaDisabled: false,
      sendDisabled: false
    })
    expect(
      composerStatePolicy({ ...base, startPending: true })
    ).toMatchObject({
      isBusy: true,
      textareaDisabled: true,
      sendDisabled: true
    })
    for (const runStatus of ['running', 'awaiting-approval'] as const) {
      expect(
        composerStatePolicy({ ...base, runStatus, startPending: true })
      ).toMatchObject({
        runActive: true,
        textareaDisabled: false,
        contextDisabled: true,
        sendDisabled: true
      })
    }
    expect(
      composerStatePolicy({ ...base, disabled: true })
    ).toMatchObject({
      textareaDisabled: true,
      sendDisabled: true
    })
    expect(
      composerStatePolicy({ ...base, sendBlocked: true })
    ).toMatchObject({
      textareaDisabled: false,
      contextDisabled: true,
      sendDisabled: true
    })
  })

  it('renders an editable, explicitly unqueued draft with Stop while active', () => {
    const markup = renderComposer(task('active', 'running'))
    const textarea = markup.match(/<textarea[^>]*>/u)?.[0]

    expect(textarea).toBeDefined()
    expect(textarea).not.toContain('disabled=""')
    expect(textarea).toContain('aria-label="Message"')
    expect(textarea).not.toContain('aria-keyshortcuts')
    expect(markup).toContain('aria-label="Stop run"')
    expect(markup).not.toContain('aria-label="Send message"')
    expect(markup).toContain(
      'Draft only — not queued, sent, or steering this run'
    )
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
  })

  it('keeps task start latches independent and refuses same-task duplicates', () => {
    const pending = new Map<string, PendingComposerStart>()
    const first = task('first')
    const second = task('second')

    expect(claimComposerStart(pending, first, 1)).toBe(true)
    expect(claimComposerStart(pending, first, 2)).toBe(false)
    expect(claimComposerStart(pending, second, 3)).toBe(true)
    expect(pending.has('second')).toBe(true)

    expect(acceptComposerStart(pending, 'first', 1)).toBe(true)
    expect(
      composerStartReachedRunBoundary(pending.get('first'), {
        ...first,
        runStatus: 'running'
      })
    ).toBe(true)
    expect(releaseComposerStart(pending, 'first', 2)).toBe(false)
    expect(releaseComposerStart(pending, 'first', 1)).toBe(true)
    expect(pending.has('second')).toBe(true)
  })

  it('holds an accepted latch until task evidence crosses the run boundary', () => {
    const pending = new Map<string, PendingComposerStart>()
    const source = task('source')
    expect(claimComposerStart(pending, source, 1)).toBe(true)
    expect(acceptComposerStart(pending, source.id, 1)).toBe(true)

    expect(
      composerStartReachedRunBoundary(pending.get(source.id), source)
    ).toBe(false)
    expect(
      composerStartReachedRunBoundary(pending.get(source.id), {
        ...source,
        items: [
          {
            id: 'user-message',
            kind: 'message',
            role: 'user',
            content: 'Sent',
            createdAt: source.createdAt
          }
        ]
      })
    ).toBe(true)
  })

  it('suppresses the send shortcut during a run and respects composition', () => {
    const base = {
      ctrlKey: true,
      isComposing: false,
      key: 'Enter',
      metaKey: false,
      runActive: false
    }
    expect(composerShortcutAction(base)).toBe('send')
    expect(
      composerShortcutAction({ ...base, ctrlKey: false, metaKey: true })
    ).toBe('send')
    expect(
      composerShortcutAction({ ...base, runActive: true })
    ).toBe('suppress')
    expect(
      composerShortcutAction({ ...base, isComposing: true })
    ).toBeUndefined()
    expect(
      composerShortcutAction({ ...base, ctrlKey: false })
    ).toBeUndefined()
  })

  it('allows failed-start focus restoration only for the exact live task request', () => {
    const base = {
      composerDisabled: false,
      composerTaskId: 'source',
      focusRemainsInComposer: true,
      latestTaskRequest: 4,
      request: 4,
      sourceTaskId: 'source'
    }
    expect(shouldRestoreFailedSendFocus(base)).toBe(true)
    expect(
      shouldRestoreFailedSendFocus({
        ...base,
        composerTaskId: 'other'
      })
    ).toBe(false)
    expect(
      shouldRestoreFailedSendFocus({
        ...base,
        latestTaskRequest: 5
      })
    ).toBe(false)
    expect(
      shouldRestoreFailedSendFocus({
        ...base,
        focusRemainsInComposer: false
      })
    ).toBe(false)
  })

  it('offers failed-run recovery as an editable unsent draft action', () => {
    const source: FailedRunRetrySource = {
      taskId: 'failed',
      runId: 'run',
      failureItemId: 'failure',
      failureItemIndex: 1,
      userMessageId: 'user',
      userMessageIndex: 0,
      userContent: 'Retry exactly'
    }
    const markup = renderComposer(
      task('failed', 'failed'),
      false,
      {
        draft: '',
        failedRunRetry: source
      }
    )

    expect(markup).toContain('aria-label="Failed request recovery"')
    expect(markup).toContain('Request failed')
    expect(markup).toContain('Prepare retry')
    expect(markup).toContain(
      'The failed run may have made changes. Copy its request into a draft to review; nothing is sent now.'
    )
    expect(markup).toContain(
      '<button type="button" title="Copy the failed request into this task draft">Prepare retry</button>'
    )
  })

  it('describes an exact failed request already in the draft as ready to review', () => {
    const source: FailedRunRetrySource = {
      taskId: 'failed',
      runId: 'run',
      failureItemId: 'failure',
      failureItemIndex: 1,
      userMessageId: 'user',
      userMessageIndex: 0,
      userContent: 'Retry exactly'
    }
    const markup = renderComposer(
      task('failed', 'failed'),
      false,
      {
        draft: source.userContent,
        failedRunRetry: source
      }
    )

    expect(markup).toContain(
      'The failed request is ready in the draft. Review or edit it, then Send when ready.'
    )
    expect(markup).toContain(
      '<button type="button" disabled="" title="The failed request is ready in this task draft">Prepared</button>'
    )
    expect(markup).not.toContain(
      'Clear it before preparing this retry.'
    )
  })

  it('preserves an occupied failed-task draft instead of offering replacement', () => {
    const markup = renderComposer(
      task('failed', 'failed'),
      false,
      {
        draft: '   ',
        failedRunRetry: {
          taskId: 'failed',
          runId: 'run',
          failureItemId: 'failure',
          failureItemIndex: 1,
          userMessageId: 'user',
          userMessageIndex: 0,
          userContent: 'Retry exactly'
        }
      }
    )
    const retryButton = markup.match(
      /<button[^>]*disabled=""[^>]*>Prepare retry<\/button>/u
    )

    expect(retryButton).toBeDefined()
    expect(markup).toContain(
      'Your current draft is preserved. Clear it before preparing this retry.'
    )
  })
})
