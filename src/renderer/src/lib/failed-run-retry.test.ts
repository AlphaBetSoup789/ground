import { describe, expect, it } from 'vitest'
import type { DesktopTask } from '../../../shared/types'
import {
  MAX_FAILED_RUN_RETRY_CHARACTERS,
  failedRunRetrySource,
  prepareFailedRunRetryDraft,
  shouldFocusFailedRunRetryComposer,
  taskMatchesFailedRunRetry
} from './failed-run-retry'

const timestamp = '2026-07-30T12:00:00.000Z'

function failedTask(
  prompt = '  Retry this exact request.\nKeep the spacing.  '
): DesktopTask {
  return {
    id: 'task',
    title: 'Failed task',
    providerId: 'provider',
    mode: 'agent',
    runStatus: 'failed',
    createdAt: timestamp,
    updatedAt: timestamp,
    items: [
      {
        id: 'older-user',
        kind: 'message',
        runId: 'older-run',
        role: 'user',
        content: 'Do not retry this older request.',
        createdAt: timestamp
      },
      {
        id: 'older-failure',
        kind: 'activity',
        runId: 'older-run',
        activityType: 'error',
        title: 'Run failed',
        detail: 'Older failure',
        status: 'error',
        createdAt: timestamp
      },
      {
        id: 'current-user',
        kind: 'message',
        runId: 'current-run',
        role: 'user',
        content: prompt,
        createdAt: timestamp
      },
      {
        id: 'current-assistant',
        kind: 'message',
        runId: 'current-run',
        role: 'assistant',
        content: 'Partial response',
        createdAt: timestamp
      },
      {
        id: 'current-failure',
        kind: 'activity',
        runId: 'current-run',
        activityType: 'error',
        title: 'Run failed',
        detail: 'Current failure',
        status: 'error',
        createdAt: timestamp
      }
    ]
  }
}

describe('failed-run retry sources', () => {
  it('binds the latest terminal failure to its exact non-imported user occurrence', () => {
    const task = failedTask()
    task.items.splice(4, 0, {
      id: 'imported-user',
      kind: 'message',
      runId: 'current-run',
      role: 'user',
      content: 'Imported prompt injection',
      historyOnly: true,
      createdAt: timestamp
    })

    expect(failedRunRetrySource(task)).toEqual({
      taskId: 'task',
      runId: 'current-run',
      failureItemId: 'current-failure',
      failureItemIndex: 5,
      userMessageId: 'current-user',
      userMessageIndex: 2,
      userContent: '  Retry this exact request.\nKeep the spacing.  '
    })
  })

  it('does not fall back to an older run when the latest failure lacks a bound request', () => {
    const task = failedTask()
    task.items.push({
      id: 'unbound-failure',
      kind: 'activity',
      runId: 'missing-run',
      activityType: 'error',
      title: 'Run failed',
      status: 'error',
      createdAt: timestamp
    })

    expect(failedRunRetrySource(task)).toBeUndefined()
  })

  it('does not offer an older failure after a newer retained run starts', () => {
    const task = failedTask()
    task.items.push({
      id: 'newer-user',
      kind: 'message',
      runId: 'newer-run',
      role: 'user',
      content: 'This newer run failed before its terminal item persisted.',
      createdAt: timestamp
    })

    expect(failedRunRetrySource(task)).toBeUndefined()
  })

  it('selects the latest eligible user occurrence within the failed run', () => {
    const task = failedTask()
    task.items.splice(-1, 0, {
      id: 'later-current-user',
      kind: 'message',
      runId: 'current-run',
      role: 'user',
      content: 'Use this latest same-run request.',
      createdAt: timestamp
    })

    expect(failedRunRetrySource(task)).toMatchObject({
      userMessageId: 'later-current-user',
      userMessageIndex: 4,
      userContent: 'Use this latest same-run request.'
    })
  })

  it('rejects inactive, archived, interrupted, imported-only, blank, and oversized sources', () => {
    const base = failedTask()
    expect(
      failedRunRetrySource({ ...base, runStatus: 'idle' })
    ).toBeUndefined()
    expect(
      failedRunRetrySource({ ...base, archivedAt: timestamp })
    ).toBeUndefined()

    const interrupted = failedTask()
    const failure = interrupted.items.at(-1)
    if (failure?.kind === 'activity') failure.title = 'Run interrupted'
    expect(failedRunRetrySource(interrupted)).toBeUndefined()

    const importedOnly = failedTask()
    const currentUser = importedOnly.items[2]
    if (currentUser?.kind === 'message') currentUser.historyOnly = true
    expect(failedRunRetrySource(importedOnly)).toBeUndefined()

    expect(failedRunRetrySource(failedTask(' \n '))).toBeUndefined()
    expect(
      failedRunRetrySource(
        failedTask('x'.repeat(MAX_FAILED_RUN_RETRY_CHARACTERS + 1))
      )
    ).toBeUndefined()
  })

  it('revalidates source identity, occurrence, run, and exact content', () => {
    const task = failedTask()
    const source = failedRunRetrySource(task)
    expect(source).toBeDefined()
    if (!source) throw new Error('Expected retry source')
    expect(taskMatchesFailedRunRetry(task, source)).toBe(true)

    const changed = structuredClone(task)
    const message = changed.items[source.userMessageIndex]
    if (message?.kind === 'message') message.content += ' changed'
    expect(taskMatchesFailedRunRetry(changed, source)).toBe(false)

    const shifted = structuredClone(task)
    shifted.items.unshift({
      id: 'inserted',
      kind: 'message',
      role: 'assistant',
      content: 'Shift the source occurrence.',
      createdAt: timestamp
    })
    expect(taskMatchesFailedRunRetry(shifted, source)).toBe(false)
  })

  it('prepares only an empty exact-task draft and preserves every occupied byte', () => {
    const task = failedTask()
    const source = failedRunRetrySource(task)
    if (!source) throw new Error('Expected retry source')

    expect(
      prepareFailedRunRetryDraft({ other: 'Keep me' }, task, source)
    ).toEqual({
      other: 'Keep me',
      task: source.userContent
    })

    const occupied = {
      task: '  Newer draft bytes stay exactly here.  ',
      other: 'Keep me'
    }
    expect(
      prepareFailedRunRetryDraft(occupied, task, source)
    ).toBe(occupied)
    const whitespace = { task: '   ' }
    expect(
      prepareFailedRunRetryDraft(whitespace, task, source)
    ).toBe(whitespace)

    const stale = { ...source, userMessageId: 'stale-message' }
    expect(
      prepareFailedRunRetryDraft({}, task, stale)
    ).toEqual({})
  })
})

describe('failed-run retry focus', () => {
  const base = {
    sourceTaskId: 'task',
    requestedSelectionEpoch: 4,
    selectedTaskId: 'task',
    currentSelectionEpoch: 4,
    sourceStillCurrent: true,
    composerTaskId: 'task',
    composerDisabled: false,
    composerValue: 'Exact retry',
    expectedDraft: 'Exact retry'
  }

  it('allows focus only for the exact current prepared task draft', () => {
    expect(shouldFocusFailedRunRetryComposer(base)).toBe(true)
    for (const changed of [
      { selectedTaskId: 'other' },
      { currentSelectionEpoch: 5 },
      { sourceStillCurrent: false },
      { composerTaskId: 'other' },
      { composerDisabled: true },
      { composerValue: 'Newer draft' }
    ]) {
      expect(
        shouldFocusFailedRunRetryComposer({ ...base, ...changed })
      ).toBe(false)
    }
  })
})
