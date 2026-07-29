import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CommandPalette,
  filterCommandPaletteActions,
  shouldHandleCommandPaletteKey,
  shouldHandleCommandPaletteWindowKey,
  type CommandPaletteAction
} from './CommandPalette'

const actions: CommandPaletteAction[] = [
  {
    id: 'new-task',
    label: 'New task',
    description: 'Start another task',
    keywords: ['conversation'],
    perform: () => undefined
  },
  {
    id: 'providers',
    label: 'Provider settings',
    description: 'Connect an API or agent CLI',
    keywords: ['models', 'credentials'],
    perform: () => undefined
  }
]

describe('command palette', () => {
  it('matches every search term across labels, descriptions, and keywords', () => {
    expect(
      filterCommandPaletteActions(actions, 'agent models').map(
        (action) => action.id
      )
    ).toEqual(['providers'])
    expect(
      filterCommandPaletteActions(actions, 'conversation').map(
        (action) => action.id
      )
    ).toEqual(['new-task'])
  })

  it('renders an accessible command list', () => {
    const markup = renderToStaticMarkup(
      createElement(CommandPalette, {
        actions,
        onClose: () => undefined
      })
    )

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('aria-label="Search commands"')
    expect(markup).toContain('role="listbox"')
    expect(markup).toContain('role="option" tabindex="-1"')
    expect(markup).toContain('Provider settings')
  })

  it('does not execute a command while an input method is composing text', () => {
    expect(shouldHandleCommandPaletteKey('Enter', true)).toBe(false)
    expect(shouldHandleCommandPaletteKey('Enter', false)).toBe(true)
    expect(shouldHandleCommandPaletteWindowKey('Escape', true)).toBe(false)
    expect(shouldHandleCommandPaletteWindowKey('Tab', true)).toBe(false)
    expect(shouldHandleCommandPaletteWindowKey('Escape', false)).toBe(true)
  })
})
