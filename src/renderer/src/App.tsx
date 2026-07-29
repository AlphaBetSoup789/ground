import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PanelLeft, Settings2 } from 'lucide-react'
import type {
  AppSnapshot,
  DesktopTask,
  RunEventEnvelope,
  TaskExportFormat,
  TaskItem,
  TaskPatch
} from '../../shared/types'
import { desktop } from './lib/desktop'
import { readableError } from './lib/format'
import {
  applyRunEventEnvelope,
  reconcileSnapshotWithEvents
} from './lib/run-events'
import { Sidebar } from './components/Sidebar'
import { TaskView } from './components/TaskView'
import { ProviderModal } from './components/ProviderModal'

export default function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot>()
  const [snapshotError, setSnapshotError] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const pendingRunEventsRef = useRef<RunEventEnvelope[]>([])
  const refreshQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingRefreshesRef = useRef(0)
  const [toast, setToast] = useState<{
    message: string
    tone: 'error' | 'success'
  }>()
  const toastTimerRef = useRef<number | undefined>(undefined)
  const snapshotLoadedRef = useRef(false)
  const [dismissedRecoveryId, setDismissedRecoveryId] = useState<string>()

  const showToast = useCallback(
    (message: string, tone: 'error' | 'success', durationMs: number) => {
      if (toastTimerRef.current !== undefined) {
        window.clearTimeout(toastTimerRef.current)
      }
      setToast({ message, tone })
      toastTimerRef.current = window.setTimeout(() => {
        toastTimerRef.current = undefined
        setToast(undefined)
      }, durationMs)
    },
    []
  )

  const showError = useCallback((error: unknown) => {
    showToast(readableError(error), 'error', 6_000)
  }, [showToast])

  const openSidebar = useCallback((focusSearch = false) => {
    setSidebarOpen(true)
    if (focusSearch) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('#task-search')?.focus()
      })
    }
  }, [])

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('.sidebar-reopen')?.focus()
    })
  }, [])

  const refresh = useCallback((): Promise<void> => {
    pendingRefreshesRef.current += 1
    const executeRefresh = async (): Promise<void> => {
      try {
        const nextSnapshot = await desktop.getSnapshot()
        const pendingEvents = pendingRunEventsRef.current
        pendingRunEventsRef.current = []
        snapshotLoadedRef.current = true
        setSnapshot(
          reconcileSnapshotWithEvents(nextSnapshot, pendingEvents)
        )
        setSnapshotError(undefined)
      } catch (error) {
        if (snapshotLoadedRef.current) showError(error)
        else setSnapshotError(readableError(error))
      } finally {
        pendingRefreshesRef.current -= 1
        if (
          pendingRefreshesRef.current === 0 &&
          pendingRunEventsRef.current.length
        ) {
          const pendingEvents = pendingRunEventsRef.current
          pendingRunEventsRef.current = []
          setSnapshot((current) =>
            current
              ? pendingEvents.reduce(applyRunEventEnvelope, current)
              : current
          )
        }
      }
    }
    const queued = refreshQueueRef.current.then(
      executeRefresh,
      executeRefresh
    )
    refreshQueueRef.current = queued.catch(() => undefined)
    return queued
  }, [showError])

  useEffect(() => {
    const unsubscribe = desktop.onRunEvent((envelope) => {
      if (
        !snapshotLoadedRef.current ||
        pendingRefreshesRef.current > 0
      ) {
        pendingRunEventsRef.current.push(envelope)
        return
      }
      setSnapshot((current) =>
        current ? applyRunEventEnvelope(current, envelope) : current
      )
    })
    void refresh()
    return unsubscribe
  }, [refresh])

  useEffect(
    () => () => {
      if (toastTimerRef.current !== undefined) {
        window.clearTimeout(toastTimerRef.current)
      }
    },
    []
  )

  const selectedTask = useMemo(() => {
    if (!snapshot) return undefined
    return (
      snapshot.tasks.find((task) => task.id === snapshot.settings.selectedTaskId) ??
      snapshot.tasks.find((task) => !task.archivedAt)
    )
  }, [snapshot])

  const selectTask = useCallback(
    async (taskId: string) => {
      if (!snapshot) return
      setSnapshot({
        ...snapshot,
        settings: { ...snapshot.settings, selectedTaskId: taskId }
      })
      try {
        await desktop.selectTask(taskId)
        if (window.matchMedia('(max-width: 900px)').matches) {
          setSidebarOpen(false)
        }
      } catch (error) {
        showError(error)
      }
    },
    [snapshot, showError]
  )

  const createTask = useCallback(
    async (withWorkspace = true) => {
      try {
        const task = await desktop.createTask(
          withWorkspace ? selectedTask?.workspace?.id : undefined
        )
        setSnapshot((current) =>
          current
            ? {
                ...current,
                tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)],
                settings: { ...current.settings, selectedTaskId: task.id }
              }
            : current
        )
      } catch (error) {
        showError(error)
      }
    },
    [selectedTask?.workspace?.id, showError]
  )

  const updateTask = useCallback(
    async (taskId: string, patch: TaskPatch) => {
      try {
        const updated = await desktop.updateTask(taskId, patch)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks.map((task) => (task.id === taskId ? updated : task)),
                settings:
                  patch.providerId === undefined
                    ? current.settings
                    : {
                        ...current.settings,
                        defaultProviderId: patch.providerId
                      }
              }
            : current
        )
      } catch (error) {
        showError(error)
      }
    },
    [showError]
  )

  const acceptCreatedTask = useCallback((task: DesktopTask) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            tasks: [task, ...current.tasks.filter((candidate) => candidate.id !== task.id)],
            settings: { ...current.settings, selectedTaskId: task.id }
          }
        : current
    )
  }, [])

  const importTask = useCallback(async () => {
    try {
      const imported = await desktop.importTaskBundle()
      if (!imported) return
      acceptCreatedTask(imported)
    } catch (error) {
      showError(error)
    }
  }, [acceptCreatedTask, showError])

  const forkTask = useCallback(async () => {
    if (!selectedTask) return
    try {
      const forked = await desktop.forkTask(selectedTask.id)
      acceptCreatedTask(forked)
      showToast('Task forked with inert history', 'success', 4_000)
    } catch (error) {
      showError(error)
    }
  }, [acceptCreatedTask, selectedTask, showError, showToast])

  const setTaskArchived = useCallback(
    async (archived: boolean) => {
      if (!selectedTask) return
      try {
        await desktop.setTaskArchived(selectedTask.id, archived)
        await refresh()
        showToast(
          archived ? 'Task archived' : 'Task restored',
          'success',
          4_000
        )
      } catch (error) {
        showError(error)
      }
    },
    [refresh, selectedTask, showError, showToast]
  )

  const exportTask = useCallback(
    async (format: TaskExportFormat) => {
      if (!selectedTask) return
      try {
        const exported = await desktop.exportTask(selectedTask.id, format)
        if (!exported) return
        showToast(
          format === 'bundle'
            ? 'Portable task bundle exported'
            : 'Markdown transcript exported',
          'success',
          4_000
        )
      } catch (error) {
        showError(error)
      }
    },
    [selectedTask, showError, showToast]
  )

  const deleteTask = useCallback(async () => {
    if (!selectedTask) return
    try {
      const deleted = await desktop.deleteTask(selectedTask.id)
      if (!deleted) return
      await refresh()
    } catch (error) {
      showError(error)
    }
  }, [refresh, selectedTask, showError])

  const chooseWorkspace = useCallback(async () => {
    try {
      const workspace = await desktop.chooseWorkspace()
      if (!workspace) return
      if (selectedTask) {
        await updateTask(selectedTask.id, {
          workspaceGrantId: workspace.id
        })
      } else {
        const task = await desktop.createTask(workspace.id)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                tasks: [task, ...current.tasks],
                settings: { ...current.settings, selectedTaskId: task.id }
              }
            : current
        )
      }
    } catch (error) {
      showError(error)
    }
  }, [selectedTask, showError, updateTask])

  const startRun = useCallback(
    async (prompt: string) => {
      if (!selectedTask) return
      try {
        if (selectedTask.title === 'New task') {
          const compact = prompt.replace(/\s+/g, ' ').trim()
          const title = compact.length > 54 ? `${compact.slice(0, 51)}…` : compact
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  tasks: current.tasks.map((task) =>
                    task.id === selectedTask.id ? { ...task, title } : task
                  )
                }
              : current
          )
        }
        await desktop.startRun({ taskId: selectedTask.id, prompt })
      } catch (error) {
        showError(error)
        throw error
      }
    },
    [selectedTask, showError]
  )

  const stopRun = useCallback(async () => {
    if (!selectedTask) return
    try {
      await desktop.stopRun(selectedTask.id)
    } catch (error) {
      showError(error)
    }
  }, [selectedTask, showError])

  const resolveApproval = useCallback(
    async (item: Extract<TaskItem, { kind: 'activity' }>, approved: boolean) => {
      if (!item.approvalId) return
      try {
        await desktop.resolveApproval(item.runId, item.approvalId, approved)
      } catch (error) {
        showError(error)
      }
    },
    [showError]
  )

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      const dialogOpen = Boolean(document.querySelector('[role="dialog"]'))
      if (dialogOpen) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createTask()
      }
      if (event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
      if (
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        openSidebar(true)
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [createTask, openSidebar])

  if (!snapshot) {
    if (snapshotError) {
      return (
        <div className="loading-screen loading-error" role="alert">
          <div className="brand-mark large" aria-hidden="true">
            <span />
            <span />
          </div>
          <h1>Ground could not open</h1>
          <p>{snapshotError}</p>
          <button
            className="primary-button"
            type="button"
            onClick={() => void refresh()}
          >
            Try again
          </button>
        </div>
      )
    }
    return (
      <div className="loading-screen" role="status" aria-live="polite">
        <div className="brand-mark large" aria-hidden="true">
          <span />
          <span />
        </div>
        <p>Opening Ground…</p>
      </div>
    )
  }

  return (
    <main className="app-shell">
      <Sidebar
        open={sidebarOpen}
        snapshot={snapshot}
        selectedTaskId={selectedTask?.id}
        onSelectTask={selectTask}
        onCreateTask={() => void createTask()}
        onChooseWorkspace={() => void chooseWorkspace()}
        onImportTask={() => void importTask()}
        onOpenSettings={() => setSettingsOpen(true)}
        onClose={closeSidebar}
      />
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          type="button"
          onClick={() => setSidebarOpen(false)}
          tabIndex={-1}
          aria-hidden="true"
        />
      )}

      <section
        className={`main-surface${sidebarOpen ? '' : ' sidebar-hidden'}`}
        aria-label="Current task"
      >
        {snapshot.recoveryNotice &&
          snapshot.recoveryNotice.id !== dismissedRecoveryId && (
            <div
              className={`recovery-banner recovery-banner-${snapshot.recoveryNotice.kind}`}
              role={
                snapshot.recoveryNotice.kind === 'state-reset'
                  ? 'alert'
                  : 'status'
              }
              aria-live={
                snapshot.recoveryNotice.kind === 'state-reset'
                  ? 'assertive'
                  : 'polite'
              }
            >
              <div>
                <strong>{snapshot.recoveryNotice.title}</strong>
                <span>{snapshot.recoveryNotice.detail}</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  setDismissedRecoveryId(snapshot.recoveryNotice?.id)
                }
                aria-label="Dismiss recovery notice"
              >
                ×
              </button>
            </div>
          )}
        {!sidebarOpen && (
          <button
            className="sidebar-reopen icon-button"
            type="button"
            onClick={() => openSidebar(true)}
            aria-label="Open sidebar"
          >
            <PanelLeft size={17} />
          </button>
        )}
        {selectedTask ? (
          <TaskView
            task={selectedTask}
            providers={snapshot.providers}
            sidebarOpen={sidebarOpen}
            onCloseSidebar={closeSidebar}
            onUpdateTask={(patch) => void updateTask(selectedTask.id, patch)}
            onChooseWorkspace={() => void chooseWorkspace()}
            onRevealWorkspace={() => {
              if (selectedTask.workspace) {
                void desktop
                  .revealWorkspace(selectedTask.workspace.id)
                  .catch(showError)
              }
            }}
            onStartRun={startRun}
            onStopRun={stopRun}
            onResolveApproval={resolveApproval}
            onOpenSettings={() => setSettingsOpen(true)}
            onImportTask={() => void importTask()}
            onForkTask={() => void forkTask()}
            onSetArchived={(archived) => void setTaskArchived(archived)}
            onExportTask={(format) => void exportTask(format)}
            onDeleteTask={() => void deleteTask()}
            onTaskCreated={acceptCreatedTask}
            onWorkspaceTasksChanged={() => void refresh()}
            onError={showError}
          />
        ) : (
          <EmptyApp
            onChooseWorkspace={() => void chooseWorkspace()}
            onNewTask={() => void createTask(false)}
            onImportTask={() => void importTask()}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
      </section>

      {settingsOpen && (
        <ProviderModal
          providers={snapshot.providers}
          mcpServers={snapshot.mcpServers}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await refresh()
          }}
          onError={showError}
        />
      )}

      {toast && (
        <div
          className={`toast toast-${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        >
          <span className="toast-dot" />
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => {
              if (toastTimerRef.current !== undefined) {
                window.clearTimeout(toastTimerRef.current)
                toastTimerRef.current = undefined
              }
              setToast(undefined)
            }}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      )}
    </main>
  )
}

function EmptyApp(props: {
  onChooseWorkspace: () => void
  onNewTask: () => void
  onImportTask: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  return (
    <div className="first-run">
      <div className="first-run-glow" />
      <div className="first-run-content">
        <div className="eyebrow">
          <span className="status-led" />
          Local-first agent workbench
        </div>
        <h1>
          Your models.
          <br />
          One calm place to work.
        </h1>
        <p>
          Connect an API or an agent CLI, choose a folder, and keep every task in one
          persistent workspace.
        </p>
        <div className="first-run-actions">
          <button className="primary-button large-button" type="button" onClick={props.onChooseWorkspace}>
            Open a workspace
          </button>
          <button className="secondary-button large-button" type="button" onClick={props.onNewTask}>
            Start without a folder
          </button>
        </div>
        <button className="text-button setup-link" type="button" onClick={props.onImportTask}>
          Import a portable task
        </button>
        <button className="text-button setup-link" type="button" onClick={props.onOpenSettings}>
          <Settings2 size={14} />
          Configure providers
        </button>
      </div>
    </div>
  )
}
