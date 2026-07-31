import { describe, expect, it } from 'vitest'
import {
  MAX_ASSISTANT_OUTPUT_COPY_CHARACTERS,
  fencedAssistantCodeBlocks,
  parseCopyAssistantOutputInput,
  resolveAssistantOutputCopyText
} from './assistant-output-clipboard'
import type {
  CopyAssistantOutputInput,
  DesktopTask
} from './types'

const completedContent =
  'Plan:\r\n\r\n~~~ts meta\r\n\tconst café = "🌱"\r\n\r\n~~~\r\n'

function task(
  overrides: Partial<DesktopTask> = {}
): DesktopTask {
  return {
    id: 'task',
    title: 'Clipboard source',
    providerId: 'provider',
    mode: 'agent',
    runStatus: 'idle',
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:01:00.000Z',
    items: [
      {
        id: 'assistant',
        kind: 'message',
        role: 'assistant',
        content: completedContent,
        createdAt: '2026-07-30T12:01:00.000Z'
      }
    ],
    ...overrides
  }
}

function responseInput(
  overrides: Partial<CopyAssistantOutputInput> = {}
): CopyAssistantOutputInput {
  return {
    taskId: 'task',
    messageId: 'assistant',
    expectedContent: completedContent,
    target: { kind: 'response' },
    ...overrides
  }
}

describe('assistant output clipboard source resolution', () => {
  it('finds only fenced blocks and preserves represented code text', () => {
    const blocks = fencedAssistantCodeBlocks(
      [
        '`inline`',
        '',
        '    indented()',
        '',
        '> ```js',
        '> const nested = "✓"',
        '> ',
        '> ```',
        ''
      ].join('\n')
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toBe('const nested = "✓"\n\n')
  })

  it('keeps an empty fenced block empty like the pinned renderer pipeline', () => {
    const content = 'Before\n\n```\n\n```\n'
    const blocks = fencedAssistantCodeBlocks(content)

    expect(blocks).toEqual([
      {
        startOffset: content.indexOf('```'),
        endOffset: content.lastIndexOf('```') + 3,
        text: ''
      }
    ])
    expect(
      resolveAssistantOutputCopyText(
        task({
          items: [
            {
              id: 'assistant',
              kind: 'message',
              role: 'assistant',
              content,
              createdAt: '2026-07-30T12:01:00.000Z'
            }
          ]
        }),
        {
          taskId: 'task',
          messageId: 'assistant',
          expectedContent: content,
          target: {
            kind: 'code',
            startOffset: blocks[0]?.startOffset ?? -1,
            endOffset: blocks[0]?.endOffset ?? -1
          }
        }
      )
    ).toBe('')
  })

  it('preserves exact response Markdown and resolves code by exact offsets', () => {
    const blocks = fencedAssistantCodeBlocks(completedContent)
    expect(blocks).toEqual([
      {
        startOffset: completedContent.indexOf('~~~'),
        endOffset: completedContent.lastIndexOf('~~~') + 3,
        text: '\tconst café = "🌱"\r\n\n'
      }
    ])
    expect(
      resolveAssistantOutputCopyText(task(), responseInput())
    ).toBe(completedContent)

    const block = blocks[0]
    expect(block).toBeDefined()
    expect(
      resolveAssistantOutputCopyText(
        task(),
        responseInput({
          target: {
            kind: 'code',
            startOffset: block?.startOffset ?? -1,
            endOffset: block?.endOffset ?? -1
          }
        })
      )
    ).toBe('\tconst café = "🌱"\r\n\n')
  })

  it('rejects stale content, guessed offsets, non-assistant sources, and empty output', () => {
    expect(
      resolveAssistantOutputCopyText(
        task(),
        responseInput({ expectedContent: `${completedContent}changed` })
      )
    ).toBeUndefined()
    expect(
      resolveAssistantOutputCopyText(
        task(),
        responseInput({
          target: { kind: 'code', startOffset: 0, endOffset: 3 }
        })
      )
    ).toBeUndefined()
    expect(
      resolveAssistantOutputCopyText(
        task({
          items: [
            {
              id: 'assistant',
              kind: 'message',
              role: 'user',
              content: completedContent,
              createdAt: '2026-07-30T12:01:00.000Z'
            }
          ]
        }),
        responseInput()
      )
    ).toBeUndefined()
    expect(
      resolveAssistantOutputCopyText(
        task({
          items: [
            {
              id: 'assistant',
              kind: 'message',
              role: 'assistant',
              content: '',
              createdAt: '2026-07-30T12:01:00.000Z'
            }
          ]
        }),
        responseInput({ expectedContent: '' })
      )
    ).toBeUndefined()
  })

  it('rejects the latest assistant while active but permits older completed output', () => {
    const active = task({
      runStatus: 'running',
      items: [
        ...(task().items),
        {
          id: 'active-assistant',
          kind: 'message',
          role: 'assistant',
          content: 'Still streaming',
          createdAt: '2026-07-30T12:02:00.000Z'
        }
      ]
    })

    expect(
      resolveAssistantOutputCopyText(active, responseInput())
    ).toBe(completedContent)
    expect(
      resolveAssistantOutputCopyText(
        active,
        responseInput({
          messageId: 'active-assistant',
          expectedContent: 'Still streaming'
        })
      )
    ).toBeUndefined()
    expect(
      resolveAssistantOutputCopyText(
        { ...active, runStatus: 'awaiting-approval' },
        responseInput({
          messageId: 'active-assistant',
          expectedContent: 'Still streaming'
        })
      )
    ).toBeUndefined()
  })
})

describe('assistant output clipboard request validation', () => {
  it('accepts only the strict bounded request shape', () => {
    expect(parseCopyAssistantOutputInput(responseInput())).toEqual(
      responseInput()
    )
    expect(() =>
      parseCopyAssistantOutputInput({
        ...responseInput(),
        arbitraryText: 'write me instead'
      })
    ).toThrow()
    expect(() =>
      parseCopyAssistantOutputInput({
        ...responseInput(),
        expectedContent: 'x'.repeat(
          MAX_ASSISTANT_OUTPUT_COPY_CHARACTERS + 1
        )
      })
    ).toThrow()
    expect(() =>
      parseCopyAssistantOutputInput(
        responseInput({
          target: {
            kind: 'code',
            startOffset: 12,
            endOffset: 12
          }
        })
      )
    ).toThrow()
  })
})
