import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChevronDown,
  Copy,
  Download,
  FileText,
  FileUp,
  Folder,
  GitBranch,
  MoreHorizontal,
  PanelLeftClose,
  Settings2,
  Sparkles,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import type {
  DesktopActivityItem,
  DesktopTask,
  ProviderProfile,
  RunMode,
  TaskExportFormat,
  TaskPatch
} from '../../../shared/types'
import { providerReadiness } from '../lib/provider-readiness'
import type { AskToAgentHandoffSource } from '../lib/ask-agent-handoff'
import { Composer } from './Composer'
import { GitPanel } from './GitPanel'
import { TerminalPanel } from './TerminalPanel'
import { Timeline } from './Timeline'

type WorkspacePanel = 'git' | 'terminal'

interface TaskViewProps {
  task: DesktopTask
  providers: ProviderProfile[]
  draft: string
  onDraftChange: (value: string) => void
  askToAgentPending: boolean
  sidebarOpen: boolean
  onCloseSidebar: () => void
  onUpdateTask: (patch: TaskPatch) => void
  onContinueInAgent: (
    source: AskToAgentHandoffSource
  ) => Promise<boolean>
  onChooseWorkspace: () => void
  onRevealWorkspace: () => void
  onStartRun: (prompt: string) => Promise<void>
  onStopRun: () => Promise<void>
  onResolveApproval: (
    item: DesktopActivityItem,
    approved: boolean
  ) => Promise<void>
  onOpenSettings: (providerId?: string) => void
  onImportTask: () => void
  onForkTask: () => void
  onSetArchived: (archived: boolean) => void
  onExportTask: (format: TaskExportFormat) => void
  onDeleteTask: () => void
  onAddHunkToPrompt: (taskId: string, block: string) => void
  onTaskCreated: (task: DesktopTask) => void
  onWorkspaceTasksChanged: () => void
  onError: (error: unknown) => void
}

export function TaskView(props: TaskViewProps): React.JSX.Element {
  const [title, setTitle] = useState(props.task.title)
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>()
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const taskMenuRef = useRef<HTMLDivElement>(null)
  const taskMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const provider = props.providers.find((candidate) => candidate.id === props.task.providerId)
  const readiness = provider ? providerReadiness(provider) : undefined

  useEffect(() => {
    setTaskMenuOpen(false)
  }, [props.task.id])

  useEffect(() => {
    if (props.askToAgentPending) setTaskMenuOpen(false)
  }, [props.askToAgentPending])

  useEffect(() => {
    if (props.task.archivedAt) setWorkspacePanel(undefined)
  }, [props.task.archivedAt])

  useEffect(() => {
    setTitle(props.task.title)
  }, [props.task.id, props.task.title])

  useEffect(() => {
    if (!taskMenuOpen) return
    const focusFrame = window.requestAnimationFrame(() => {
      taskMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus()
    })
    const dismiss = (event: PointerEvent): void => {
      if (!taskMenuRef.current?.contains(event.target as Node)) {
        setTaskMenuOpen(false)
      }
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setTaskMenuOpen(false)
      taskMenuTriggerRef.current?.focus()
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', dismissOnEscape)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', dismissOnEscape)
    }
  }, [taskMenuOpen])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== '`') return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      if (props.task.archivedAt) return
      setWorkspacePanel((current) => (current === 'terminal' ? undefined : 'terminal'))
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [props.task.archivedAt])

  const isRunning =
    props.task.runStatus === 'running' || props.task.runStatus === 'awaiting-approval'
  const isArchived = Boolean(props.task.archivedAt)

  const suggestions = useMemo(
    () =>
      props.task.mode === 'agent'
        ? [
            'Map this codebase and explain the architecture',
            'Find the highest-impact issue and propose a fix',
            'Run the tests and diagnose any failures'
          ]
        : [
            'Explain the main ideas in this project',
            'Review this approach and identify tradeoffs',
            'Help me plan the next implementation step'
          ],
    [props.task.mode]
  )

  const commitTitle = (): void => {
    const next = title.trim()
    if (!next) {
      setTitle(props.task.title)
      return
    }
    if (next !== props.task.title) props.onUpdateTask({ title: next })
  }

  const togglePanel = (panel: WorkspacePanel): void => {
    setWorkspacePanel((current) => (current === panel ? undefined : panel))
  }

  return (
    <div
      className={`task-view${workspacePanel ? ' workspace-panel-open' : ''}${
        workspacePanel ? ` workspace-panel-${workspacePanel}` : ''
      }${
        isArchived ? ' archived-task-view' : ''
      }${provider?.verification?.status !== 'passed' ? ' provider-needs-test' : ''}`}
    >
      <header className="task-header">
        <div className="task-header-left">
          {props.sidebarOpen && (
            <button
              className="icon-button header-sidebar-button"
              type="button"
              onClick={props.onCloseSidebar}
              aria-label="Close sidebar"
            >
              <PanelLeftClose size={16} />
            </button>
          )}
          <div className="task-heading">
            <h1 className="visually-hidden">{title}</h1>
            <input
              className="task-title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') {
                  setTitle(props.task.title)
                  event.currentTarget.blur()
                }
              }}
              aria-label="Task title"
              disabled={isArchived}
            />
            <button
              className="workspace-path"
              type="button"
              title={props.task.workspace?.name ?? 'Choose a workspace'}
              onClick={
                props.task.workspace
                  ? props.onRevealWorkspace
                  : props.onChooseWorkspace
              }
              disabled={isArchived && !props.task.workspace}
            >
              <Folder size={11} />
              {props.task.workspace?.name ?? 'Choose workspace'}
            </button>
          </div>
        </div>

        <div className="task-header-controls">
          <div className="mode-switch" role="group" aria-label="Run mode">
            {(['ask', 'agent'] as RunMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={props.task.mode === mode ? 'active' : ''}
                onClick={() => props.onUpdateTask({ mode })}
                disabled={
                  isRunning || isArchived || props.askToAgentPending
                }
                aria-pressed={props.task.mode === mode}
                title={mode === 'ask' ? 'Ask mode' : 'Agent mode'}
              >
                {mode === 'ask' ? <Sparkles size={12} /> : <Bot size={12} />}
                <span>{mode === 'ask' ? 'Ask' : 'Agent'}</span>
              </button>
            ))}
          </div>

          <label className="provider-picker">
            <span
              className={`provider-kind-icon ${provider?.kind === 'cli' ? 'cli' : 'api'}`}
            >
              {provider?.kind === 'cli' ? '›_' : '◆'}
            </span>
            <select
              value={props.task.providerId}
              onChange={(event) => props.onUpdateTask({ providerId: event.target.value })}
              disabled={
                isRunning || isArchived || props.askToAgentPending
              }
              aria-label="Provider"
              title="Provider for this task. New tasks use your latest choice."
            >
              {props.providers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.model ? ` · ${candidate.model}` : ''}
                  {` — ${providerReadiness(candidate).shortLabel}`}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>

          <div className="workspace-panel-switch" aria-label="Workspace tools">
            <button
              className={workspacePanel === 'git' ? 'icon-button active' : 'icon-button'}
              type="button"
              onClick={() => togglePanel('git')}
              disabled={isArchived}
              aria-label={workspacePanel === 'git' ? 'Hide Git panel' : 'Show Git panel'}
              aria-pressed={workspacePanel === 'git'}
              aria-controls="workspace-tool-panel"
              title="Git"
            >
              <GitBranch size={15} />
            </button>
            <button
              className={
                workspacePanel === 'terminal' ? 'icon-button active' : 'icon-button'
              }
              type="button"
              onClick={() => togglePanel('terminal')}
              disabled={isArchived}
              aria-label={
                workspacePanel === 'terminal'
                  ? 'Hide terminal'
                  : 'Show terminal (⌘/Ctrl + `)'
              }
              aria-pressed={workspacePanel === 'terminal'}
              aria-controls="workspace-tool-panel"
              title="Terminal (⌘/Ctrl + `)"
            >
              <SquareTerminal size={15} />
            </button>
          </div>

          <button
            className="icon-button header-settings"
            type="button"
            onClick={() => props.onOpenSettings(provider?.id)}
            disabled={props.askToAgentPending}
            aria-label="Provider settings"
          >
            <Settings2 size={16} />
          </button>

          <div className="task-actions" ref={taskMenuRef}>
            <button
              ref={taskMenuTriggerRef}
              className="icon-button"
              type="button"
              onClick={() => setTaskMenuOpen((current) => !current)}
              disabled={props.askToAgentPending}
              aria-label="Task actions"
              aria-haspopup="menu"
              aria-expanded={taskMenuOpen}
              aria-controls="task-actions-menu"
            >
              <MoreHorizontal size={17} />
            </button>
            {taskMenuOpen && (
              <div
                id="task-actions-menu"
                className="task-actions-popover"
                role="menu"
                aria-label="Task actions"
                onKeyDown={(event) => {
                  if (event.key === 'Tab') {
                    setTaskMenuOpen(false)
                    return
                  }
                  if (
                    event.key !== 'ArrowDown' &&
                    event.key !== 'ArrowUp' &&
                    event.key !== 'Home' &&
                    event.key !== 'End'
                  ) {
                    return
                  }
                  event.preventDefault()
                  const items = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="menuitem"]:not(:disabled)'
                    )
                  ]
                  if (!items.length) return
                  const currentIndex = items.indexOf(
                    document.activeElement as HTMLButtonElement
                  )
                  const nextIndex =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? items.length - 1
                        : event.key === 'ArrowDown'
                          ? (currentIndex + 1) % items.length
                          : (currentIndex - 1 + items.length) % items.length
                  items[nextIndex]?.focus()
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={isRunning}
                  title={isRunning ? 'Stop this task before forking it' : undefined}
                  onClick={() => {
                    setTaskMenuOpen(false)
                    props.onForkTask()
                  }}
                >
                  <Copy size={14} />
                  Fork task
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={isRunning}
                  title={
                    isRunning
                      ? `Stop this task before ${isArchived ? 'restoring' : 'archiving'} it`
                      : undefined
                  }
                  onClick={() => {
                    setTaskMenuOpen(false)
                    props.onSetArchived(!isArchived)
                  }}
                >
                  {isArchived ? (
                    <ArchiveRestore size={14} />
                  ) : (
                    <Archive size={14} />
                  )}
                  {isArchived ? 'Restore task' : 'Archive task'}
                </button>
                <div className="task-actions-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setTaskMenuOpen(false)
                    props.onImportTask()
                  }}
                >
                  <FileUp size={14} />
                  Import task
                </button>
                <div className="task-actions-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setTaskMenuOpen(false)
                    props.onExportTask('bundle')
                  }}
                >
                  <Download size={14} />
                  Export JSON
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setTaskMenuOpen(false)
                    props.onExportTask('markdown')
                  }}
                >
                  <FileText size={14} />
                  Export Markdown
                </button>
                <div className="task-actions-divider" role="separator" />
                <button
                  className="danger"
                  type="button"
                  role="menuitem"
                  disabled={isRunning}
                  title={isRunning ? 'Stop this task before deleting it' : undefined}
                  onClick={() => {
                    setTaskMenuOpen(false)
                    props.onDeleteTask()
                  }}
                >
                  <Trash2 size={14} />
                  Delete task
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {provider && provider.verification?.status !== 'passed' && readiness && (
        <div
          className={`provider-readiness-banner ${readiness.tone}`}
          role={readiness.tone === 'error' ? 'alert' : 'status'}
        >
          <div>
            <strong>{readiness.title}</strong>
            <span>{readiness.detail}</span>
          </div>
          <button
            type="button"
            onClick={() => props.onOpenSettings(provider.id)}
          >
            {readiness.tone === 'error' ? 'Review and retest' : 'Test provider'}
          </button>
        </div>
      )}

      {isArchived && (
        <div className="archived-task-banner" role="status">
          <Archive size={14} aria-hidden="true" />
          <span>
            This task is archived. Its history is read-only until you restore it.
          </span>
          <button
            type="button"
            onClick={() => props.onSetArchived(false)}
          >
            Restore task
          </button>
        </div>
      )}

      <Timeline
        task={props.task}
        provider={provider}
        suggestions={isArchived ? [] : suggestions}
        onSuggestion={(prompt) => {
          props.onDraftChange(prompt)
          window.requestAnimationFrame(() => {
            document
              .querySelector<HTMLTextAreaElement>('#task-message-composer')
              ?.focus()
          })
        }}
        onResolveApproval={props.onResolveApproval}
        onSetImportedHistory={(include) =>
          props.onUpdateTask({ includeImportedHistory: include })
        }
        onContinueInAgent={props.onContinueInAgent}
      />

      <Composer
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        task={props.task}
        provider={provider}
        disabled={isArchived}
        sendBlocked={props.askToAgentPending}
        onChooseWorkspace={props.onChooseWorkspace}
        onSend={props.onStartRun}
        onStop={props.onStopRun}
      />

      {workspacePanel && (
        <div
          className="workspace-panel"
          id="workspace-tool-panel"
          role="region"
          aria-label={workspacePanel === 'terminal' ? 'Workspace terminal' : 'Git workspace'}
        >
          {workspacePanel === 'terminal' ? (
            <TerminalPanel
              taskId={props.task.id}
              workspaceReady={Boolean(props.task.workspace)}
              onError={props.onError}
            />
          ) : (
            <GitPanel
              key={props.task.id}
              taskId={props.task.id}
              workspaceReady={Boolean(props.task.workspace)}
              onAddHunkToPrompt={props.onAddHunkToPrompt}
              onTaskCreated={props.onTaskCreated}
              onWorkspaceTasksChanged={props.onWorkspaceTasksChanged}
              onError={props.onError}
            />
          )}
        </div>
      )}
    </div>
  )
}
