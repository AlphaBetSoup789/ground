import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_ANNOUNCEMENT_INTERVAL_MS,
  assistantRunFinishedAnnouncement,
  assistantRunStartedAnnouncement,
  normalizeAssistantAnnouncement,
  takeAssistantAnnouncementBatch
} from './assistant-announcements'

describe('assistant response announcements', () => {
  it('turns accumulated markdown into a concise spoken update', () => {
    expect(
      normalizeAssistantAnnouncement(
        '## Result\n\nUse **Ground** with [`local models`](https://example.com) and `tools`.'
      )
    ).toBe('Result Use Ground with local models and tools.')
  })

  it('batches only content added after the prior announcement', () => {
    const content =
      'Already announced. This is the next accessible response segment with more detail.'
    const batch = takeAssistantAnnouncementBatch(
      content,
      'Already announced. '.length,
      34
    )

    expect(batch).toEqual({
      text: 'This is the next accessible',
      nextOffset: 47,
      hasMore: true
    })
  })

  it('reports completion and points to the conversation when text remains', () => {
    expect(
      assistantRunFinishedAnnouncement('idle', {
        text: 'A final batched excerpt.',
        nextOffset: 24,
        hasMore: true
      })
    ).toBe(
      'Ground says: A final batched excerpt. Ground finished responding. The full response is available in the conversation.'
    )
  })

  it('announces run phases without claiming an approval pause is complete', () => {
    expect(assistantRunStartedAnnouncement('running')).toBe(
      'Ground is responding.'
    )
    expect(assistantRunStartedAnnouncement('awaiting-approval')).toBe(
      'Ground is waiting for your approval.'
    )
    expect(assistantRunFinishedAnnouncement('failed')).toBe(
      'Ground stopped because the run failed.'
    )
  })

  it('uses multi-second batches instead of announcing individual tokens', () => {
    expect(ASSISTANT_ANNOUNCEMENT_INTERVAL_MS).toBeGreaterThanOrEqual(3_000)
  })
})
