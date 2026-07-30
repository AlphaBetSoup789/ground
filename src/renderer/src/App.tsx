import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { PanelLeft, Settings2 } from 'lucide-react'
import type {
  AppSnapshot,
  DesktopActivityItem,
  DesktopRunEventEnvelope,
  DesktopTask,
  TaskExportFormat,
  TaskPatch
} from '../../shared/types'
import { desktop } from './lib/desktop'
import { readableError } from './lib/format'
import {
  NARROW_SIDEBAR_MEDIA_QUERY,
  releaseFocusBeforeSidebarClose,
  restoreFocusAfterSidebarClose,
  shouldRestoreTaskSelectionFocus,
  shouldInertMainSurface,
  type SidebarCloseFocusTarget
} from './lib/sidebar-focus'
import {
  applyRunEventEnvelope,
  reconcileSnapshotWithEvents
} from './lib/run-events'
import {
  prepareAskToAgentDraft,
  taskMatchesAskToAgentHandoff,
  type AskToAgentHandoffSource
} from './lib/ask-agent-handoff'
import {
  appendDiffFollowupDraft,
  canAppendDiffFollowupBlock,
  shouldFocusDiffFollowupComposer
} from './lib/diff-followup'
import {
  preserveNewerTaskSelection,
  selectTaskInSnapshot,
  type TaskSelectionRequest
} from './lib/task-selection'
import { updateTaskDraft, type TaskDrafts } from './lib/task-drafts'
import { Sidebar } from './components/Sidebar'
import { TaskView } from './components/TaskView'
import { ProviderModal } from './components/ProviderModal'
import {
  CommandPalette,
  type CommandPaletteAction
} from './components/CommandPalette'

export default function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot>()
  const [snapshotError, setSnapshotError] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsProviderId, setSettingsProviderId] = useState<string>()
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [taskDrafts, setTaskDrafts] = useState<TaskDrafts>({})
  const [askToAgentPendingTaskIds, setAskToAgentPendingTaskIds] =
    useState<ReadonlySet<string>>(() => new Set())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [narrowSidebarLayout, setNarrowSidebarLayout] = useState(() =>
    window.matchMedia(NARROW_SIDEBAR_MEDIA_QUERY).matches
  )
  const narrowSidebarLayoutRef = useRef(narrowSidebarLayout)
  const mainSurfaceRef = useRef<HTMLElement>(null)
  const pendingRunEventsRef = useRef<DesktopRunEventEnvelope[]>([])
  const refreshQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingRefreshesRef = useRef(0)
  const snapshotRef = useRef<AppSnapshot | undefined>(undefined)
  const selectedTaskIdRef = useRef<string | undefined>(undefined)
  const selectedTaskEpochRef = useRef(0)
  const taskSelectionRequestRef = useRef(0)
  const taskSelectionFocusRef = useRef(0)
  const taskSelectionInteractionCleanupRef = useRef<
    (() => void) | undefined
  >(undefined)
  const latestTaskSelectionRef = useRef<TaskSelectionRequest | undefined>(
    undefined
  )
  const pendingTaskFocusRef = useRef<
    | {
        request: number
        focusRequest: number
        focusOrigin: Element | null
        taskId: string
      }
    | undefined
  >(undefined)
  const pendingSidebarCloseFocusRef = useRef<
    | {
        focusRequest: number
        target: SidebarCloseFocusTarget
      }
    | undefined
  >(undefined)
  const pendingAskToAgentHandoffsRef = useRef(new Set<string>())
  const taskMutationRevisionRef = useRef(new Map<string, number>())
  const activeTaskMutationsRef = useRef(new Map<string, number>())
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

  const cancelPendingTaskFocus = useCallback(() => {
    taskSelectionFocusRef.current += 1
    taskSelectionInteractionCleanupRef.current?.()
    pendingTaskFocusRef.current = undefined
    pendingSidebarCloseFocusRef.current = undefined
  }, [])

  const openSettings = useCallback(
    (providerId?: string) => {
      cancelPendingTaskFocus()
      setSettingsProviderId(providerId)
      setSettingsOpen(true)
    },
    [cancelPendingTaskFocus]
  )

  const openCommandPalette = useCallback(() => {
    cancelPendingTaskFocus()
    setCommandPaletteOpen(true)
  }, [cancelPendingTaskFocus])

  const openSidebar = useCallback((focusSearch = false) => {
    const focusRequest = ++taskSelectionFocusRef.current
    taskSelectionInteractionCleanupRef.current?.()
    pendingTaskFocusRef.current = undefined
    pendingSidebarCloseFocusRef.current = undefined
    setSidebarOpen(true)
    if (focusSearch) {
      let userInteracted = false
      const markUserInteraction = (): void => {
        userInteracted = true
      }
      window.addEventListener('keydown', markUserInteraction, true)
      window.addEventListener('pointerdown', markUserInteraction, true)
      window.requestAnimationFrame(() => {
        window.removeEventListener('keydown', markUserInteraction, true)
        window.removeEventListener('pointerdown', markUserInteraction, true)
        if (
          taskSelectionFocusRef.current !== focusRequest ||
          userInteracted
        ) {
          return
        }
        document.querySelector<HTMLInputElement>('#task-search')?.focus()
      })
    }
  }, [])

  const closeSidebar = useCallback(
    (focusTarget: SidebarCloseFocusTarget = 'reopen') => {
      const focusRequest = ++taskSelectionFocusRef.current
      taskSelectionInteractionCleanupRef.current?.()
      pendingTaskFocusRef.current = undefined
      pendingSidebarCloseFocusRef.current = {
        focusRequest,
        target: focusTarget
      }
      releaseFocusBeforeSidebarClose(document)
      setSidebarOpen(false)
    },
    []
  )

  useEffect(() => {
    const media = window.matchMedia(NARROW_SIDEBAR_MEDIA_QUERY)
    const updateLayout = (): void => {
      narrowSidebarLayoutRef.current = media.matches
      setNarrowSidebarLayout(media.matches)
    }
    updateLayout()
    media.addEventListener('change', updateLayout)
    return () => media.removeEventListener('change', updateLayout)
  }, [])

  const mainSurfaceInert = shouldInertMainSurface(
    sidebarOpen,
    narrowSidebarLayout
  )
  const modalOpen = settingsOpen || commandPaletteOpen

  useLayoutEffect(() => {
    if (
      sidebarOpen ||
      mainSurfaceInert ||
      mainSurfaceRef.current?.inert
    ) {
      return
    }
    const pending = pendingSidebarCloseFocusRef.current
    if (!pending) return
    pendingSidebarCloseFocusRef.current = undefined
    if (taskSelectionFocusRef.current !== pending.focusRequest) return
    restoreFocusAfterSidebarClose(document, pending.target)
  }, [mainSurfaceInert, sidebarOpen])

  useLayoutEffect(() => {
    const activeElement = document.activeElement
    if (
      !mainSurfaceInert ||
      !activeElement ||
      !mainSurfaceRef.current?.contains(activeElement)
    ) {
      return
    }
    document
      .querySelector<HTMLInputElement>('#task-search')
      ?.focus({ preventScroll: true })
  }, [mainSurfaceInert])

  const refresh = useCallback(
    (): Promise<void> => {
      const selectionRequestBoundary = taskSelectionRequestRef.current
      pendingRefreshesRef.current += 1
      const executeRefresh = async (): Promise<void> => {
        try {
          const nextSnapshot = await desktop.getSnapshot()
          const pendingEvents = pendingRunEventsRef.current
          pendingRunEventsRef.current = []
          snapshotLoadedRef.current = true
          const reconciled = reconcileSnapshotWithEvents(
            nextSnapshot,
            pendingEvents
          )
          setSnapshot(
            preserveNewerTaskSelection(
              reconciled,
              selectionRequestBoundary,
              latestTaskSelectionRef.current
            )
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
    },
    [showError]
  )

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
      taskSelectionInteractionCleanupRef.current?.()
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
  snapshotRef.current = snapshot
  if (selectedTaskIdRef.current !== selectedTask?.id) {
    selectedTaskEpochRef.current += 1
    selectedTaskIdRef.current = selectedTask?.id
  }

  useLayoutEffect(() => {
    if (mainSurfaceInert || mainSurfaceRef.current?.inert) return
    const pending = pendingTaskFocusRef.current
    if (!pending) return
    pendingTaskFocusRef.current = undefined
    if (
      taskSelectionRequestRef.current !== pending.request ||
      taskSelectionFocusRef.current !== pending.focusRequest ||
      selectedTaskIdRef.current !== pending.taskId ||
      !shouldRestoreTaskSelectionFocus(document, pending.focusOrigin) ||
      document.querySelector<HTMLElement>('.task-view')?.dataset.taskId !==
        pending.taskId
    ) {
      return
    }
    restoreFocusAfterSidebarClose(document, 'task')
  }, [mainSurfaceInert, selectedTask?.id])

  const selectTask = useCallback(
    async (taskId: string) => {
      if (
        !snapshotRef.current?.tasks.some((task) => task.id === taskId)
      ) {
        return
      }
      const request = ++taskSelectionRequestRef.current
      const focusRequest = ++taskSelectionFocusRef.current
      const focusOrigin = document.activeElement
      taskSelectionInteractionCleanupRef.current?.()
      let userInteracted = false
      const markUserInteraction = (): void => {
        userInteracted = true
      }
      const stopWatchingInteraction = (): void => {
        window.removeEventListener('keydown', markUserInteraction, true)
        window.removeEventListener('pointerdown', markUserInteraction, true)
        window.removeEventListener('blur', markUserInteraction)
        if (
          taskSelectionInteractionCleanupRef.current ===
          stopWatchingInteraction
        ) {
          taskSelectionInteractionCleanupRef.current = undefined
        }
      }
      window.addEventListener('keydown', markUserInteraction, true)
      window.addEventListener('pointerdown', markUserInteraction, true)
      window.addEventListener('blur', markUserInteraction)
      taskSelectionInteractionCleanupRef.current = stopWatchingInteraction
      latestTaskSelectionRef.current = { request, taskId }
      pendingSidebarCloseFocusRef.current = undefined
      setSnapshot((current) => selectTaskInSnapshot(current, taskId))
      try {
        await desktop.selectTask(taskId)
        if (taskSelectionRequestRef.current !== request) {
          stopWatchingInteraction()
          return
        }
        window.requestAnimationFrame(() => {
          stopWatchingInteraction()
          if (
            taskSelectionRequestRef.current !== request ||
            taskSelectionFocusRef.current !== focusRequest ||
            selectedTaskIdRef.current !== taskId ||
            userInteracted ||
            !shouldRestoreTaskSelectionFocus(document, focusOrigin)
          ) {
            return
          }
          const taskView = document.querySelector<HTMLElement>('.task-view')
          if (taskView?.dataset.taskId !== taskId) return
          const narrowLayout = narrowSidebarLayoutRef.current
          if (!narrowLayout && mainSurfaceRef.current?.inert) return
          if (narrowLayout) {
            pendingTaskFocusRef.current = {
              request,
              focusRequest,
              focusOrigin,
              taskId
            }
            releaseFocusBeforeSidebarClose(document)
            setSidebarOpen(false)
            return
          }
          restoreFocusAfterSidebarClose(document, 'task')
        })
      } catch (error) {
        stopWatchingInteraction()
        if (taskSelectionRequestRef.current !== request) return
        showError(error)
        await refresh()
      }
    },
    [refresh, showError]
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
      const mutationRevision =
        (taskMutationRevisionRef.current.get(taskId) ?? 0) + 1
      taskMutationRevisionRef.current.set(taskId, mutationRevision)
      activeTaskMutationsRef.current.set(
        taskId,
        (activeTaskMutationsRef.current.get(taskId) ?? 0) + 1
      )
      try {
        const updated = await desktop.updateTask(taskId, patch)
        const isCurrent =
          taskMutationRevisionRef.current.get(taskId) ===
          mutationRevision
        const applyUpdate = (current: AppSnapshot): AppSnapshot => ({
          ...current,
          tasks: current.tasks.map((task) =>
            task.id === taskId ? updated : task
          ),
          settings:
            patch.providerId === undefined
              ? current.settings
              : {
                  ...current.settings,
                  defaultProviderId: patch.providerId
                }
        })
        if (snapshotRef.current) {
          snapshotRef.current = applyUpdate(snapshotRef.current)
        }
        setSnapshot((current) =>
          current ? applyUpdate(current) : current
        )
        return { task: updated, isCurrent }
      } catch (error) {
        showError(error)
        return undefined
      } finally {
        const activeCount =
          (activeTaskMutationsRef.current.get(taskId) ?? 1) - 1
        if (activeCount > 0) {
          activeTaskMutationsRef.current.set(taskId, activeCount)
        } else {
          activeTaskMutationsRef.current.delete(taskId)
        }
      }
    },
    [showError]
  )

  const continueAskTaskInAgent = useCallback(
    async (source: AskToAgentHandoffSource): Promise<boolean> => {
      const requestKey = `${source.taskId}:${source.assistantMessageId}`
      if (pendingAskToAgentHandoffsRef.current.has(requestKey)) {
        return false
      }
      if ((activeTaskMutationsRef.current.get(source.taskId) ?? 0) > 0) {
        return false
      }

      const currentSnapshot = snapshotRef.current
      const currentTask = currentSnapshot?.tasks.find(
        (task) => task.id === source.taskId
      )
      const currentProvider = currentSnapshot?.providers.find(
        (provider) => provider.id === source.providerId
      )
      if (
        !taskMatchesAskToAgentHandoff(
          currentTask,
          currentProvider,
          source,
          'ask'
        )
      ) {
        return false
      }

      pendingAskToAgentHandoffsRef.current.add(requestKey)
      setAskToAgentPendingTaskIds((current) => {
        const next = new Set(current)
        next.add(source.taskId)
        return next
      })
      try {
        const result = await updateTask(source.taskId, {
          mode: 'agent'
        })
        if (!result?.isCurrent) return false

        const latestTask = snapshotRef.current?.tasks.find(
          (task) => task.id === source.taskId
        )
        const latestProvider = snapshotRef.current?.providers.find(
          (provider) => provider.id === source.providerId
        )
        if (
          !taskMatchesAskToAgentHandoff(
            latestTask,
            latestProvider,
            source,
            'agent'
          )
        ) {
          return false
        }

        setTaskDrafts((current) =>
          updateTaskDraft(
            current,
            source.taskId,
            prepareAskToAgentDraft(current[source.taskId] ?? '')
          )
        )
        if (selectedTaskIdRef.current === source.taskId) {
          window.requestAnimationFrame(() => {
            if (selectedTaskIdRef.current !== source.taskId) return
            document
              .querySelector<HTMLTextAreaElement>(
                '#task-message-composer'
              )
              ?.focus()
          })
        }
        return true
      } finally {
        pendingAskToAgentHandoffsRef.current.delete(requestKey)
        setAskToAgentPendingTaskIds((current) => {
          if (!current.has(source.taskId)) return current
          const next = new Set(current)
          next.delete(source.taskId)
          return next
        })
      }
    },
    [updateTask]
  )

  const addHunkToPrompt = useCallback(
    (taskId: string, block: string): void => {
      const sourceTaskExists = Boolean(
        snapshotRef.current?.tasks.some((task) => task.id === taskId)
      )
      if (!canAppendDiffFollowupBlock(block, sourceTaskExists)) {
        return
      }
      setTaskDrafts((current) =>
        updateTaskDraft(
          current,
          taskId,
          appendDiffFollowupDraft(current[taskId] ?? '', block)
        )
      )
      if (selectedTaskIdRef.current !== taskId) return
      const selectionEpoch = selectedTaskEpochRef.current
      window.requestAnimationFrame(() => {
        const composer =
          document.querySelector<HTMLTextAreaElement>(
            '#task-message-composer'
          )
        if (
          composer &&
          shouldFocusDiffFollowupComposer({
            sourceTaskId: taskId,
            requestedSelectionEpoch: selectionEpoch,
            selectedTaskId: selectedTaskIdRef.current,
            currentSelectionEpoch: selectedTaskEpochRef.current,
            composerTaskId: composer.dataset.taskId,
            composerDisabled: composer.disabled
          })
        ) {
          composer.focus()
        }
      })
    },
    []
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
      setTaskDrafts((current) =>
        updateTaskDraft(current, selectedTask.id, '')
      )
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
    async (item: DesktopActivityItem, approved: boolean) => {
      if (!item.approvalId) return
      try {
        await desktop.resolveApproval(item.runId, item.approvalId, approved)
      } catch (error) {
        showError(error)
      }
    },
    [showError]
  )

  const commandPaletteActions = useMemo<CommandPaletteAction[]>(
    () => [
      {
        id: 'new-task',
        label: 'New task',
        description: 'Start a task in the current workspace',
        keywords: ['conversation', 'chat'],
        shortcut: '⌘/Ctrl N',
        perform: () => void createTask()
      },
      {
        id: 'open-workspace',
        label: 'Open a workspace',
        description: 'Grant Ground access to a local folder',
        keywords: ['folder', 'project', 'directory'],
        perform: () => void chooseWorkspace()
      },
      {
        id: 'search-tasks',
        label: 'Search tasks',
        description: 'Find a task by title, workspace, provider, or history',
        keywords: ['sidebar', 'conversation'],
        shortcut: '⌘/Ctrl K',
        perform: () => openSidebar(true)
      },
      {
        id: 'import-task',
        label: 'Import a portable task',
        description: 'Restore a Ground task bundle from disk',
        keywords: ['json', 'history', 'migration'],
        perform: () => void importTask()
      },
      {
        id: 'provider-settings',
        label: 'Provider settings',
        description: 'Connect an API, local model, or agent CLI',
        keywords: ['models', 'credentials', 'mcp', 'codex', 'claude', 'gemini'],
        shortcut: '⌘/Ctrl ,',
        perform: () => openSettings()
      },
      {
        id: 'toggle-sidebar',
        label: sidebarOpen ? 'Close sidebar' : 'Open sidebar',
        description: sidebarOpen
          ? 'Give the current task more room'
          : 'Show workspaces and task history',
        keywords: ['navigation', 'panel'],
        perform: () => {
          if (sidebarOpen) closeSidebar('task')
          else openSidebar(true)
        }
      }
    ],
    [
      chooseWorkspace,
      closeSidebar,
      createTask,
      importTask,
      openSidebar,
      openSettings,
      sidebarOpen
    ]
  )

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      const opensCommandPalette =
        event.key === 'F1' ||
        ((event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          event.key.toLowerCase() === 'p')
      if (opensCommandPalette) {
        if (document.querySelector('[role="dialog"]')) return
        event.preventDefault()
        openCommandPalette()
        return
      }
      if (!(event.metaKey || event.ctrlKey)) return
      const dialogOpen = Boolean(document.querySelector('[role="dialog"]'))
      if (dialogOpen) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createTask()
      }
      if (event.key === ',') {
        event.preventDefault()
        openSettings()
      }
      if (
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        openSidebar(true)
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [createTask, openCommandPalette, openSettings, openSidebar])

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
        backgroundInert={modalOpen}
        narrowLayout={narrowSidebarLayout}
        snapshot={snapshot}
        selectedTaskId={selectedTask?.id}
        onSelectTask={selectTask}
        onCreateTask={() => void createTask()}
        onChooseWorkspace={() => void chooseWorkspace()}
        onImportTask={() => void importTask()}
        onOpenCommands={openCommandPalette}
        onOpenSettings={() => openSettings()}
        onClose={() => closeSidebar()}
        onCloseToTask={() => closeSidebar('task')}
      />
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          type="button"
          onClick={() => closeSidebar()}
          tabIndex={-1}
          aria-hidden="true"
        />
      )}

      <section
        ref={mainSurfaceRef}
        className={`main-surface${sidebarOpen ? '' : ' sidebar-hidden'}`}
        aria-label="Current task"
        inert={mainSurfaceInert || modalOpen}
      >
        {snapshot.recoveryNotice &&
          snapshot.recoveryNotice.id !== dismissedRecoveryId && (
            <div
              className={`recovery-banner recovery-banner-${snapshot.recoveryNotice.kind}`}
              role={
                snapshot.recoveryNotice.kind === 'backup-restored'
                  ? 'status'
                  : 'alert'
              }
              aria-live={
                snapshot.recoveryNotice.kind === 'backup-restored'
                  ? 'polite'
                  : 'assertive'
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
            draft={taskDrafts[selectedTask.id] ?? ''}
            onDraftChange={(value) =>
              setTaskDrafts((current) =>
                updateTaskDraft(current, selectedTask.id, value)
              )
            }
            sidebarOpen={sidebarOpen}
            onCloseSidebar={() => closeSidebar()}
            onUpdateTask={(patch) => void updateTask(selectedTask.id, patch)}
            onContinueInAgent={continueAskTaskInAgent}
            askToAgentPending={askToAgentPendingTaskIds.has(
              selectedTask.id
            )}
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
            onOpenSettings={openSettings}
            onImportTask={() => void importTask()}
            onForkTask={() => void forkTask()}
            onSetArchived={(archived) => void setTaskArchived(archived)}
            onExportTask={(format) => void exportTask(format)}
            onDeleteTask={() => void deleteTask()}
            onAddHunkToPrompt={addHunkToPrompt}
            onTaskCreated={acceptCreatedTask}
            onWorkspaceTasksChanged={() => void refresh()}
            onError={showError}
          />
        ) : (
          <EmptyApp
            onChooseWorkspace={() => void chooseWorkspace()}
            onNewTask={() => void createTask(false)}
            onImportTask={() => void importTask()}
            onOpenSettings={() => openSettings()}
          />
        )}
      </section>

      {settingsOpen && (
        <ProviderModal
          providers={snapshot.providers}
          mcpServers={snapshot.mcpServers}
          initialProviderId={settingsProviderId}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await refresh()
          }}
          onError={showError}
        />
      )}

      {commandPaletteOpen && (
        <CommandPalette
          actions={commandPaletteActions}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}

      {toast && (
        <div
          className={`toast toast-${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          <span className="toast-dot" />
          <span>{toast.message}</span>
          {!modalOpen && (
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
          )}
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
          Connect a hosted API, a local server you already run, or an installed
          agent CLI. Then choose a folder and keep every task in one persistent
          workspace.
        </p>
        <div className="first-run-actions">
          <button
            className="primary-button large-button"
            type="button"
            onClick={props.onOpenSettings}
          >
            <Settings2 size={15} />
            Configure a model
          </button>
          <button
            className="secondary-button large-button"
            type="button"
            onClick={props.onChooseWorkspace}
          >
            Open a workspace
          </button>
        </div>
        <div className="first-run-secondary-actions">
          <button className="text-button setup-link" type="button" onClick={props.onNewTask}>
            Start without a folder
          </button>
          <button className="text-button setup-link" type="button" onClick={props.onImportTask}>
            Import a portable task
          </button>
        </div>
      </div>
    </div>
  )
}
