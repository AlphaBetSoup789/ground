import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, Search } from 'lucide-react'

export interface CommandPaletteAction {
  id: string
  label: string
  description: string
  keywords?: readonly string[]
  shortcut?: string
  disabled?: boolean
  perform: () => void
}

interface CommandPaletteProps {
  actions: readonly CommandPaletteAction[]
  onClose: () => void
}

export function shouldHandleCommandPaletteKey(
  key: string,
  isComposing: boolean
): boolean {
  return (
    !isComposing &&
    (key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'Home' ||
      key === 'End' ||
      key === 'Enter')
  )
}

export function shouldHandleCommandPaletteWindowKey(
  key: string,
  isComposing: boolean
): boolean {
  return !isComposing && (key === 'Escape' || key === 'Tab')
}

export function filterCommandPaletteActions(
  actions: readonly CommandPaletteAction[],
  query: string
): CommandPaletteAction[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!terms.length) return [...actions]

  return actions.filter((action) => {
    const searchable = [
      action.label,
      action.description,
      ...(action.keywords ?? [])
    ]
      .join(' ')
      .toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
}

export function CommandPalette(
  props: CommandPaletteProps
): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(props.onClose)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const actions = useMemo(
    () => filterCommandPaletteActions(props.actions, query),
    [props.actions, query]
  )
  const selectedIndex = actions.length
    ? Math.min(activeIndex, actions.length - 1)
    : -1

  useEffect(() => {
    onCloseRef.current = props.onClose
  }, [props.onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!shouldHandleCommandPaletteWindowKey(event.key, event.isComposing)) {
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? [])
      ]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [])

  const execute = (action: CommandPaletteAction | undefined): void => {
    if (!action || action.disabled) return
    props.onClose()
    action.perform()
  }

  return (
    <div
      className="modal-backdrop command-palette-backdrop"
      role="presentation"
      onMouseDown={props.onClose}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (!actions.length) return
          if (
            !shouldHandleCommandPaletteKey(
              event.key,
              event.nativeEvent.isComposing
            )
          ) return
          event.preventDefault()
          if (event.key === 'Enter') {
            execute(actions[selectedIndex])
            return
          }
          const nextIndex =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? actions.length - 1
                : event.key === 'ArrowDown'
                  ? (selectedIndex + 1) % actions.length
                  : (selectedIndex - 1 + actions.length) % actions.length
          setActiveIndex(nextIndex)
          document
            .querySelector<HTMLElement>(
              `#command-palette-action-${actions[nextIndex]?.id}`
            )
            ?.scrollIntoView({ block: 'nearest' })
        }}
      >
        <h2 className="visually-hidden" id="command-palette-title">
          Ground commands
        </h2>
        <div className="command-palette-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            placeholder="Search Ground commands…"
            aria-label="Search commands"
            aria-controls="command-palette-actions"
            aria-activedescendant={
              selectedIndex >= 0
                ? `command-palette-action-${actions[selectedIndex]?.id}`
                : undefined
            }
          />
          <kbd>Esc</kbd>
        </div>
        <div
          className="command-palette-actions"
          id="command-palette-actions"
          role="listbox"
          aria-label="Commands"
        >
          {actions.length ? (
            actions.map((action, index) => (
              <button
                id={`command-palette-action-${action.id}`}
                key={action.id}
                className={index === selectedIndex ? 'selected' : ''}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === selectedIndex}
                disabled={action.disabled}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => execute(action)}
              >
                <span className="command-palette-icon" aria-hidden="true">
                  <Command size={14} />
                </span>
                <span>
                  <strong>{action.label}</strong>
                  <small>{action.description}</small>
                </span>
                {action.shortcut && <kbd>{action.shortcut}</kbd>}
              </button>
            ))
          ) : (
            <p className="command-palette-empty">No matching commands</p>
          )}
        </div>
        <div className="command-palette-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Run</span>
          <span>Ground keeps provider choice separate from the command</span>
        </div>
      </div>
    </div>
  )
}
