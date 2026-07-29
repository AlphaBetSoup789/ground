import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Archive,
  ChevronDown,
  CircleDot,
  Command,
  FileUp,
  FolderOpen,
  Inbox,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  TerminalSquare,
  X
} from 'lucide-react'
import type {
  AppSnapshot,
  DesktopTask
} from '../../../shared/types'
import { timeAgo } from '../lib/format'

interface SidebarProps {
  open: boolean
  backgroundInert?: boolean
  snapshot: AppSnapshot
  selectedTaskId?: string
  onSelectTask: (taskId: string) => void
  onCreateTask: () => void
  onChooseWorkspace: () => void
  onImportTask: () => void
  onOpenCommands: () => void
  onOpenSettings: () => void
  onClose: () => void
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().slice(0, 200).toLocaleLowerCase()
  const activeCount = props.snapshot.tasks.filter((task) => !task.archivedAt).length
  const archivedCount = props.snapshot.tasks.length - activeCount
  const selectedIsArchived = props.snapshot.tasks.find(
    (task) => task.id === props.selectedTaskId
  )?.archivedAt

  useEffect(() => {
    if (props.selectedTaskId) setShowArchived(Boolean(selectedIsArchived))
  }, [props.selectedTaskId, selectedIsArchived])

  const groups = useMemo(() => {
    const filtered = props.snapshot.tasks.filter((task) => {
      if (Boolean(task.archivedAt) !== showArchived) return false
      if (!normalizedQuery) return true
      const provider = props.snapshot.providers.find(
        (candidate) => candidate.id === task.providerId
      )
      return taskMatchesQuery(task, provider?.name, provider?.model, normalizedQuery)
    })
    return groupTasksByWorkspace(filtered)
  }, [
    normalizedQuery,
    props.snapshot.providers,
    props.snapshot.tasks,
    showArchived
  ])

  const resultCount = groups.reduce((count, [, tasks]) => count + tasks.length, 0)
  const moveTaskFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>
  ): void => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }
    const rows = [
      ...event.currentTarget
        .closest('.task-groups')
        ?.querySelectorAll<HTMLButtonElement>('.task-row') ?? []
    ]
    if (!rows.length) return
    event.preventDefault()
    const currentIndex = rows.indexOf(event.currentTarget)
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(rows.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1)
    rows[nextIndex]?.focus()
  }

  return (
    <aside
      className={`sidebar ${props.open ? 'sidebar-open' : 'sidebar-closed'}`}
      aria-label="Task navigation"
      aria-hidden={!props.open || props.backgroundInert}
      inert={!props.open || props.backgroundInert}
    >
      <div className="sidebar-drag-region">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <span>Ground</span>
        </div>
        <button
          className="icon-button sidebar-close"
          type="button"
          onClick={props.onClose}
          aria-label="Close sidebar"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="sidebar-actions">
        <button className="new-task-button" type="button" onClick={props.onCreateTask}>
          <span className="new-task-icon">
            <Plus size={15} />
          </span>
          New task
          <kbd>⌘/Ctrl N</kbd>
        </button>
        <button className="workspace-button" type="button" onClick={props.onChooseWorkspace}>
          <FolderOpen size={15} />
          Open workspace
        </button>
        <button className="workspace-button" type="button" onClick={props.onImportTask}>
          <FileUp size={15} />
          Import task
        </button>
      </div>

      <div className="task-scope-switch" role="group" aria-label="Task view">
        <button
          type="button"
          className={!showArchived ? 'active' : ''}
          aria-pressed={!showArchived}
          onClick={() => {
            setShowArchived(false)
            const selected = props.snapshot.tasks.find(
              (task) => task.id === props.selectedTaskId
            )
            if (selected?.archivedAt) {
              const firstActive = props.snapshot.tasks.find((task) => !task.archivedAt)
              if (firstActive) props.onSelectTask(firstActive.id)
            }
          }}
        >
          <Inbox size={12} aria-hidden="true" />
          Tasks
          <span>{activeCount}</span>
        </button>
        <button
          type="button"
          className={showArchived ? 'active' : ''}
          aria-pressed={showArchived}
          onClick={() => {
            setShowArchived(true)
            const selected = props.snapshot.tasks.find(
              (task) => task.id === props.selectedTaskId
            )
            if (!selected?.archivedAt) {
              const firstArchived = props.snapshot.tasks.find(
                (task) => task.archivedAt
              )
              if (firstArchived) props.onSelectTask(firstArchived.id)
            }
          }}
        >
          <Archive size={12} aria-hidden="true" />
          Archived
          <span>{archivedCount}</span>
        </button>
      </div>

      <label className="sidebar-search">
        <Search size={14} />
        <input
          ref={searchRef}
          id="task-search"
          type="search"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value.slice(0, 200))}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            if (query) setQuery('')
            else event.currentTarget.blur()
          }}
          placeholder={showArchived ? 'Search archived' : 'Search tasks'}
          aria-label={showArchived ? 'Search archived tasks' : 'Search tasks'}
          aria-controls="task-search-results"
          aria-keyshortcuts="Meta+K Control+K"
        />
        {query && (
          <button
            className="sidebar-search-clear"
            type="button"
            onClick={() => {
              setQuery('')
              searchRef.current?.focus()
            }}
            aria-label="Clear task search"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </label>
      <span className="visually-hidden" role="status" aria-live="polite">
        {normalizedQuery
          ? `${resultCount} ${resultCount === 1 ? 'task' : 'tasks'} found`
          : `${showArchived ? archivedCount : activeCount} ${
              (showArchived ? archivedCount : activeCount) === 1
                ? 'task'
                : 'tasks'
            }`}
      </span>

      <div className="task-groups" id="task-search-results">
        {groups.length ? (
          groups.map(([workspaceGrantId, tasks]) => (
            <section
              className="task-group"
              key={workspaceGrantId || 'scratch'}
            >
              <h2 className="task-group-header">
                <ChevronDown size={12} />
                <span>{tasks[0]?.workspace?.name ?? 'No workspace'}</span>
                <span className="task-count">{tasks.length}</span>
              </h2>
              <div className="task-list">
                {tasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className={`task-row ${
                      props.selectedTaskId === task.id ? 'task-row-selected' : ''
                    }`}
                    onClick={() => props.onSelectTask(task.id)}
                    onKeyDown={moveTaskFocus}
                    aria-current={props.selectedTaskId === task.id ? 'page' : undefined}
                  >
                    <TaskStatus task={task} />
                    <span className="task-row-copy">
                      <span className="task-row-title">{task.title}</span>
                      <span className="task-row-meta">
                        {providerLabel(props.snapshot, task.providerId)}
                        <span>·</span>
                        {timeAgo(task.updatedAt)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="sidebar-empty">
            {showArchived && !query ? <Archive size={18} /> : <Search size={18} />}
            <p>
              {query
                ? 'No matching tasks'
                : showArchived
                  ? 'No archived tasks'
                  : 'No active tasks'}
            </p>
            {query && (
              <button type="button" onClick={() => setQuery('')}>
                Clear search
              </button>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          onClick={props.onOpenCommands}
          aria-keyshortcuts="Meta+Shift+P Control+Shift+P F1"
        >
          <span className="footer-icon">
            <Command size={15} />
          </span>
          Commands
          <kbd>⇧⌘P / Ctrl⇧P</kbd>
        </button>
        <button type="button" onClick={props.onOpenSettings}>
          <span className="footer-icon">
            <Settings2 size={15} />
          </span>
          Providers & settings
          <kbd>⌘/Ctrl ,</kbd>
        </button>
        <div className="local-note">
          <TerminalSquare size={12} />
          Runs locally
        </div>
      </div>
    </aside>
  )
}

function TaskStatus({ task }: { task: DesktopTask }): React.JSX.Element {
  if (task.archivedAt) {
    return (
      <span className="task-status archived" title="Archived">
        <Archive size={12} />
        <span className="visually-hidden">Archived</span>
      </span>
    )
  }
  if (task.runStatus === 'running') {
    return (
      <span className="task-status running" title="Running">
        <LoaderCircle size={13} />
        <span className="visually-hidden">Running</span>
      </span>
    )
  }
  if (task.runStatus === 'awaiting-approval') {
    return (
      <span className="task-status approval" title="Needs approval">
        <CircleDot size={13} />
        <span className="visually-hidden">Needs approval</span>
      </span>
    )
  }
  if (task.runStatus === 'failed') {
    return (
      <span className="task-status failed" title="Failed">
        <AlertCircle size={13} />
        <span className="visually-hidden">Failed</span>
      </span>
    )
  }
  return (
    <span className="task-status idle">
      <span className="visually-hidden">Idle</span>
    </span>
  )
}

function providerLabel(snapshot: AppSnapshot, providerId: string): string {
  return snapshot.providers.find((provider) => provider.id === providerId)?.name ?? 'Provider'
}

const SEARCH_TIMELINE_ITEM_LIMIT = 80
const SEARCH_TIMELINE_CHARACTER_LIMIT = 48_000
const SEARCH_FIELD_CHARACTER_LIMIT = 4_000

export function groupTasksByWorkspace(
  tasks: readonly DesktopTask[]
): Array<[string, DesktopTask[]]> {
  return Object.entries(
    tasks.reduce<Record<string, DesktopTask[]>>((result, task) => {
      const key = task.workspace?.id ?? ''
      result[key] ??= []
      result[key].push(task)
      return result
    }, {})
  )
}

export function taskMatchesQuery(
  task: DesktopTask,
  providerName: string | undefined,
  providerModel: string | undefined,
  normalizedQuery: string
): boolean {
  const metadata = [
    task.title,
    task.workspace?.name,
    providerName,
    providerModel
  ]
  if (
    metadata.some((value) =>
      value?.slice(0, SEARCH_FIELD_CHARACTER_LIMIT).toLocaleLowerCase().includes(
        normalizedQuery
      )
    )
  ) {
    return true
  }

  let remainingCharacters = SEARCH_TIMELINE_CHARACTER_LIMIT
  let inspectedItems = 0
  for (let index = task.items.length - 1; index >= 0; index -= 1) {
    if (
      inspectedItems >= SEARCH_TIMELINE_ITEM_LIMIT ||
      remainingCharacters <= 0
    ) {
      break
    }
    const item = task.items[index]
    if (!item) continue
    inspectedItems += 1
    const fields =
      item.kind === 'message'
        ? [item.content]
        : [item.title, item.detail, item.result, item.toolName]
    for (const value of fields) {
      if (!value || remainingCharacters <= 0) continue
      const inspected = value.slice(
        0,
        Math.min(SEARCH_FIELD_CHARACTER_LIMIT, remainingCharacters)
      )
      remainingCharacters -= inspected.length
      if (inspected.toLocaleLowerCase().includes(normalizedQuery)) return true
    }
  }
  return false
}
