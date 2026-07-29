import { describe, expect, it } from 'vitest'
import { shouldFollowTimeline } from './Timeline'

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
})
