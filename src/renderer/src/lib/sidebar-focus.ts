export type SidebarCloseFocusTarget = 'reopen' | 'task'
export const NARROW_SIDEBAR_MEDIA_QUERY = '(max-width: 900px)'

type SidebarFocusDocument = Pick<
  Document,
  'activeElement' | 'querySelector'
>

type TaskSelectionFocusDocument = Pick<
  Document,
  'activeElement' | 'body'
>

const TRANSIENT_SIDEBAR_FOCUS =
  '.sidebar, .sidebar-scrim, .header-sidebar-button'

const TASK_FOCUS_TARGETS = [
  '#task-message-composer:not(:disabled)',
  '.task-title-input:not(:disabled)',
  '.archived-task-restore',
  '.sidebar-reopen'
] as const

export function shouldInertMainSurface(
  sidebarOpen: boolean,
  narrowLayout: boolean
): boolean {
  return sidebarOpen && narrowLayout
}

export function shouldRestoreTaskSelectionFocus(
  root: TaskSelectionFocusDocument,
  focusOrigin: Element | null
): boolean {
  const activeElement = root.activeElement
  return (
    !activeElement ||
    activeElement === root.body ||
    activeElement === focusOrigin
  )
}

export function releaseFocusBeforeSidebarClose(
  root: SidebarFocusDocument
): void {
  const activeElement = root.activeElement
  if (!activeElement?.closest(TRANSIENT_SIDEBAR_FOCUS)) return
  const blur = (activeElement as Partial<HTMLElement>).blur
  if (typeof blur === 'function') blur.call(activeElement)
}

export function restoreFocusAfterSidebarClose(
  root: SidebarFocusDocument,
  target: SidebarCloseFocusTarget
): void {
  const selectors =
    target === 'task' ? TASK_FOCUS_TARGETS : ['.sidebar-reopen']
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector)
    if (!element) continue
    element.focus({ preventScroll: true })
    return
  }
}
