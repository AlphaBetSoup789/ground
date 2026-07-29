import { describe, expect, it, vi } from 'vitest'
import {
  shouldInertMainSurface,
  releaseFocusBeforeSidebarClose,
  restoreFocusAfterSidebarClose
} from './sidebar-focus'

describe('responsive sidebar focus', () => {
  it('inerts task content only while the narrow overlay is open', () => {
    expect(shouldInertMainSurface(true, true)).toBe(true)
    expect(shouldInertMainSurface(false, true)).toBe(false)
    expect(shouldInertMainSurface(true, false)).toBe(false)
  })

  it('releases focus before a sidebar control becomes hidden and inert', () => {
    const blur = vi.fn()
    const root = {
      activeElement: {
        blur,
        closest: () => ({})
      },
      querySelector: () => null
    } as unknown as Document

    releaseFocusBeforeSidebarClose(root)

    expect(blur).toHaveBeenCalledOnce()
  })

  it('does not disturb focus already in persistent task content', () => {
    const blur = vi.fn()
    const root = {
      activeElement: {
        blur,
        closest: () => null
      },
      querySelector: () => null
    } as unknown as Document

    releaseFocusBeforeSidebarClose(root)

    expect(blur).not.toHaveBeenCalled()
  })

  it('moves mobile task selection to the composer with safe fallbacks', () => {
    const composerFocus = vi.fn()
    const titleFocus = vi.fn()
    const root = {
      activeElement: null,
      querySelector: (selector: string) =>
        selector.startsWith('#task-message-composer')
          ? { focus: composerFocus }
          : selector.startsWith('.task-title-input')
            ? { focus: titleFocus }
            : null
    } as unknown as Document

    restoreFocusAfterSidebarClose(root, 'task')

    expect(composerFocus).toHaveBeenCalledWith({ preventScroll: true })
    expect(titleFocus).not.toHaveBeenCalled()
  })

  it('restores ordinary close focus to the sidebar reopen control', () => {
    const reopenFocus = vi.fn()
    const root = {
      activeElement: null,
      querySelector: (selector: string) =>
        selector === '.sidebar-reopen' ? { focus: reopenFocus } : null
    } as unknown as Document

    restoreFocusAfterSidebarClose(root, 'reopen')

    expect(reopenFocus).toHaveBeenCalledWith({ preventScroll: true })
  })
})
