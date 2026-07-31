import { describe, expect, it } from 'vitest'
import type {
  DesktopTask,
  ProviderProfile,
  RunMode,
  RunStatus
} from '../../../shared/types'
import {
  ASK_TO_AGENT_DRAFT,
  askToAgentHandoffSource,
  prepareAskToAgentDraft,
  taskMatchesAskToAgentHandoff
} from './ask-agent-handoff'

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

function task(
  overrides: Partial<DesktopTask> = {},
  assistantOverrides: Partial<
    Extract<DesktopTask['items'][number], { kind: 'message' }>
  > = {}
): DesktopTask {
  return {
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
        id: 'user',
        kind: 'message',
        role: 'user',
        content: 'Plan the change',
        createdAt: '2026-07-29T12:00:00.000Z'
      },
      {
        id: 'assistant',
        kind: 'message',
        role: 'assistant',
        content: 'Here is a bounded implementation plan.',
        createdAt: '2026-07-29T12:01:00.000Z',
        ...assistantOverrides
      }
    ],
    ...overrides
  }
}

describe('Ask-to-Agent handoff', () => {
  it('binds an eligible handoff to the exact task, provider, and response', () => {
    const source = askToAgentHandoffSource(task(), provider)

    expect(source).toEqual({
      taskId: 'task',
      providerId: 'provider',
      providerUpdatedAt: '2026-07-29T12:00:00.000Z',
      assistantMessageId: 'assistant',
      assistantContent: 'Here is a bounded implementation plan.'
    })
    expect(
      taskMatchesAskToAgentHandoff(
        task({ mode: 'agent' }),
        provider,
        source!,
        'agent'
      )
    ).toBe(true)
  })

  it.each([
    ['running task', { runStatus: 'running' as RunStatus }, {}],
    ['failed task', { runStatus: 'failed' as RunStatus }, {}],
    [
      'archived task',
      { archivedAt: '2026-07-29T12:02:00.000Z' },
      {}
    ],
    ['task without a workspace', { workspace: undefined }, {}],
    ['Agent task', { mode: 'agent' as RunMode }, {}],
    ['empty assistant response', {}, { content: '   ' }],
    ['imported assistant response', {}, { historyOnly: true }]
  ])('rejects an ineligible %s', (_label, overrides, assistantOverrides) => {
    expect(
      askToAgentHandoffSource(
        task(overrides, assistantOverrides),
        provider
      )
    ).toBeUndefined()
  })

  it('rejects a provider that cannot expose Agent tools', () => {
    const readOnlyProvider: ProviderProfile = {
      ...provider,
      supportsTools: false
    }

    expect(
      askToAgentHandoffSource(task(), readOnlyProvider)
    ).toBeUndefined()
  })

  it('rejects a stale response or a later conversation message', () => {
    const current = task({
      items: [
        ...task().items,
        {
          id: 'later-user',
          kind: 'message',
          role: 'user',
          content: 'Actually, use a different approach.',
          createdAt: '2026-07-29T12:02:00.000Z'
        }
      ]
    })
    const staleSource = {
      taskId: current.id,
      providerId: current.providerId,
      providerUpdatedAt: provider.updatedAt,
      assistantMessageId: 'assistant',
      assistantContent: 'Here is a bounded implementation plan.'
    }

    expect(
      askToAgentHandoffSource(current, provider)
    ).toBeUndefined()
    expect(
      taskMatchesAskToAgentHandoff(
        task({ mode: 'agent' }),
        provider,
        { ...staleSource, assistantMessageId: 'other-response' },
        'agent'
      )
    ).toBe(false)
    expect(
      taskMatchesAskToAgentHandoff(
        task({ mode: 'agent' }),
        { ...provider, updatedAt: '2026-07-29T12:03:00.000Z' },
        staleSource,
        'agent'
      )
    ).toBe(false)
    expect(
      taskMatchesAskToAgentHandoff(
        task({ mode: 'agent' }),
        provider,
        { ...staleSource, assistantContent: 'A changed response.' },
        'agent'
      )
    ).toBe(false)
  })

  it('preserves an existing draft exactly and fills only a blank composer', () => {
    expect(prepareAskToAgentDraft('My existing draft\n')).toBe(
      'My existing draft\n'
    )
    expect(prepareAskToAgentDraft(' \n ')).toBe(ASK_TO_AGENT_DRAFT)
  })
})
