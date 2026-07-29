import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  AlertCircle,
  Check,
  CircleDot,
  FileDiff,
  FilePlus2,
  FileWarning,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import type {
  DesktopTask,
  GitDiffResult,
  GitLogEntry,
  GitOverview,
  GitRecoverySummary,
  GitStatusSummary,
  GitWorktreeSummary
} from '../../../shared/types'
import { desktop } from '../lib/desktop'

type GitPanelTab = 'changes' | 'history' | 'worktrees'

interface GitPanelProps {
  taskId: string
  workspaceReady: boolean
  onTaskCreated: (task: DesktopTask) => void
  onWorkspaceTasksChanged: () => void
  onError: (error: unknown) => void
}

interface LoadError {
  message: string
}

type GitMutation =
  | 'stage'
  | 'unstage'
  | 'revert'
  | 'undo-recovery'
  | 'commit'
  | 'create-worktree'
  | 'remove-worktree'

const TABS: ReadonlyArray<{
  id: GitPanelTab
  label: string
  icon: typeof FileDiff
}> = [
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'history', label: 'History', icon: History },
  { id: 'worktrees', label: 'Worktrees', icon: GitFork }
]

export function GitPanel(props: GitPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<GitPanelTab>('changes')
  const [overview, setOverview] = useState<GitOverview>()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<LoadError>()
  const [branch, setBranch] = useState('')
  const [startPoint, setStartPoint] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()
  const [selectedStagePaths, setSelectedStagePaths] = useState<string[]>([])
  const [selectedUnstagePaths, setSelectedUnstagePaths] = useState<string[]>([])
  const [selectedRestorePaths, setSelectedRestorePaths] = useState<string[]>([])
  const [commitMessage, setCommitMessage] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [authorEmail, setAuthorEmail] = useState('')
  const [mutation, setMutation] = useState<GitMutation>()
  const [mutationError, setMutationError] = useState<string>()
  const [mutationStatus, setMutationStatus] = useState<string>()
  const [removingWorktree, setRemovingWorktree] = useState<string>()
  const [undoingRecovery, setUndoingRecovery] = useState<string>()
  const [choosingGit, setChoosingGit] = useState(false)
  const requestVersion = useRef(0)
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([])
  const idPrefix = useId()

  const loadOverview = useCallback(
    async (clearCurrent = false): Promise<void> => {
      const request = ++requestVersion.current
      if (!props.workspaceReady) {
        setOverview(undefined)
        setLoadError(undefined)
        setLoading(false)
        return
      }
      if (clearCurrent) setOverview(undefined)
      setLoading(true)
      setLoadError(undefined)
      try {
        const nextOverview = await desktop.getGitOverview(props.taskId)
        if (request === requestVersion.current) {
          setOverview(nextOverview)
          setAuthorName((current) => current || nextOverview.identity?.name || '')
          setAuthorEmail((current) => current || nextOverview.identity?.email || '')
          const eligibleRestorePaths = new Set(
            eligibleGitRestorePaths(nextOverview.status)
          )
          setSelectedRestorePaths((current) =>
            current.filter((candidate) => eligibleRestorePaths.has(candidate))
          )
        }
      } catch (error) {
        if (request !== requestVersion.current) return
        setLoadError({ message: errorMessage(error, 'Unable to inspect this repository.') })
        props.onError(error)
      } finally {
        if (request === requestVersion.current) setLoading(false)
      }
    },
    [props.onError, props.taskId, props.workspaceReady]
  )

  useEffect(() => {
    setActiveTab('changes')
    setBranch('')
    setStartPoint('')
    setCreateError(undefined)
    setSelectedStagePaths([])
    setSelectedUnstagePaths([])
    setSelectedRestorePaths([])
    setCommitMessage('')
    setAuthorName('')
    setAuthorEmail('')
    setMutation(undefined)
    setMutationError(undefined)
    setMutationStatus(undefined)
    setRemovingWorktree(undefined)
    setUndoingRecovery(undefined)
    void loadOverview(true)
    return () => {
      requestVersion.current += 1
    }
  }, [loadOverview])

  const changedFileCount = useMemo(() => {
    const status = overview?.status
    if (!status) return 0
    return new Set([
      ...status.staged,
      ...status.unstaged,
      ...status.untracked,
      ...status.conflicted
    ]).size
  }, [overview?.status])

  const tabCount = (tab: GitPanelTab): number => {
    if (tab === 'changes') return changedFileCount
    if (tab === 'history') return overview?.commits.length ?? 0
    return overview?.worktrees.length ?? 0
  }

  const selectAdjacentTab = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = TABS.length - 1
    if (nextIndex === undefined) return
    event.preventDefault()
    const nextTab = TABS[nextIndex]
    if (!nextTab) return
    setActiveTab(nextTab.id)
    tabButtons.current[nextIndex]?.focus()
  }

  const createWorktree = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const nextBranch = branch.trim()
    const nextStartPoint = startPoint.trim()
    if (!nextBranch || creating || mutation) return
    setCreating(true)
    setMutation('create-worktree')
    setCreateError(undefined)
    try {
      const task = await desktop.createGitWorktree(props.taskId, {
        branch: nextBranch,
        ...(nextStartPoint ? { startPoint: nextStartPoint } : {})
      })
      if (!task) return
      setBranch('')
      setStartPoint('')
      props.onTaskCreated(task)
      await loadOverview()
    } catch (error) {
      setCreateError(errorMessage(error, 'Unable to create the worktree.'))
      props.onError(error)
    } finally {
      setCreating(false)
      setMutation(undefined)
    }
  }

  const mutatePaths = async (
    kind: 'stage' | 'unstage',
    paths: string[]
  ): Promise<void> => {
    if (!paths.length || mutation) return
    setMutation(kind)
    setMutationError(undefined)
    setMutationStatus(undefined)
    try {
      const changed =
        kind === 'stage'
          ? await desktop.stageGitPaths(props.taskId, paths)
          : await desktop.unstageGitPaths(props.taskId, paths)
      if (!changed) return
      if (kind === 'stage') setSelectedStagePaths([])
      else setSelectedUnstagePaths([])
      setMutationStatus(
        `${kind === 'stage' ? 'Staged' : 'Unstaged'} ${paths.length} ${
          paths.length === 1 ? 'path' : 'paths'
        }.`
      )
      await loadOverview()
    } catch (error) {
      setMutationError(
        errorMessage(
          error,
          kind === 'stage'
            ? 'Unable to stage the selected paths.'
            : 'Unable to unstage the selected paths.'
        )
      )
      props.onError(error)
    } finally {
      setMutation(undefined)
    }
  }

  const commitChanges = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    if (
      mutation ||
      !commitMessage.trim() ||
      !authorName.trim() ||
      !authorEmail.trim()
    ) {
      return
    }
    setMutation('commit')
    setMutationError(undefined)
    setMutationStatus(undefined)
    try {
      const committed = await desktop.commitGitChanges(props.taskId, {
        message: commitMessage.trim(),
        authorName: authorName.trim(),
        authorEmail: authorEmail.trim()
      })
      if (!committed) return
      setCommitMessage('')
      setSelectedUnstagePaths([])
      setMutationStatus(`Committed ${committed.shortHash}: ${committed.subject}`)
      await loadOverview()
    } catch (error) {
      setMutationError(errorMessage(error, 'Unable to create the commit.'))
      props.onError(error)
    } finally {
      setMutation(undefined)
    }
  }

  const restorePaths = async (paths: string[]): Promise<void> => {
    if (!paths.length || mutation) return
    setMutation('revert')
    setMutationError(undefined)
    setMutationStatus(undefined)
    try {
      const recovery = await desktop.revertGitPaths(props.taskId, paths)
      if (!recovery) return
      setSelectedRestorePaths([])
      setSelectedStagePaths((current) =>
        current.filter((candidate) => !paths.includes(candidate))
      )
      setMutationStatus(
        `Restored ${paths.length} ${
          paths.length === 1 ? 'path' : 'paths'
        } with a recoverable undo.`
      )
      await loadOverview()
    } catch (error) {
      setMutationError(
        errorMessage(error, 'Unable to restore the selected paths safely.')
      )
      props.onError(error)
      await loadOverview()
    } finally {
      setMutation(undefined)
    }
  }

  const undoRecovery = async (recoveryId: string): Promise<void> => {
    if (mutation) return
    setMutation('undo-recovery')
    setUndoingRecovery(recoveryId)
    setMutationError(undefined)
    setMutationStatus(undefined)
    try {
      const recovery = await desktop.undoGitRecovery(
        props.taskId,
        recoveryId
      )
      if (!recovery) return
      setMutationStatus(
        'Returned the affected files to their exact pre-restore state.'
      )
      await loadOverview()
    } catch (error) {
      setMutationError(
        errorMessage(
          error,
          'Ground refused to undo because the workspace or recovery changed.'
        )
      )
      props.onError(error)
      await loadOverview()
    } finally {
      setUndoingRecovery(undefined)
      setMutation(undefined)
    }
  }

  const removeWorktree = async (relativePath: string): Promise<void> => {
    if (creating || mutation) return
    setMutation('remove-worktree')
    setRemovingWorktree(relativePath)
    setMutationError(undefined)
    setMutationStatus(undefined)
    try {
      const changedTaskIds = await desktop.removeGitWorktree(
        props.taskId,
        relativePath
      )
      if (!changedTaskIds) return
      setMutationStatus(`Removed managed worktree ${relativePath}.`)
      await loadOverview()
      if (changedTaskIds.length > 0) props.onWorkspaceTasksChanged()
    } catch (error) {
      setMutationError(errorMessage(error, 'Unable to remove the worktree.'))
      props.onError(error)
    } finally {
      setRemovingWorktree(undefined)
      setMutation(undefined)
    }
  }

  const chooseGitExecutable = async (): Promise<void> => {
    if (choosingGit || mutation) return
    setChoosingGit(true)
    setLoadError(undefined)
    setMutationError(undefined)
    setMutationStatus(undefined)
    try {
      const selected = await desktop.chooseGitExecutable()
      if (!selected) return
      setMutationStatus('Trusted Git executable updated.')
      await loadOverview(true)
    } catch (error) {
      setLoadError({
        message: errorMessage(error, 'Unable to trust this Git executable.')
      })
      props.onError(error)
    } finally {
      setChoosingGit(false)
    }
  }

  const hasInitialError = Boolean(loadError && !overview)
  const recoveryRequired =
    overview?.recoveries.filter(
      (recovery) => recovery.status === 'recovery-required'
    ) ?? []

  return (
    <section className="git-panel" aria-label="Git workspace">
      <header className="git-panel-header">
        <div className="git-panel-heading">
          <span className="git-panel-heading-icon" aria-hidden="true">
            <GitBranch size={16} />
          </span>
          <div>
            <h2>Git</h2>
            <p>{repositoryLabel(overview)}</p>
          </div>
        </div>
        <div className="git-panel-header-actions">
          <button
            className="git-panel-executable"
            type="button"
            onClick={() => void chooseGitExecutable()}
            disabled={choosingGit || Boolean(mutation)}
            aria-label={
              choosingGit
                ? 'Choosing Git executable'
                : 'Choose Git executable'
            }
            title="Choose Git executable"
          >
            {choosingGit ? (
              <LoaderCircle
                className="git-panel-spinner"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <FolderGit2 size={14} aria-hidden="true" />
            )}
            <span>Executable</span>
          </button>
          <button
            className="git-panel-refresh"
            type="button"
            onClick={() => void loadOverview()}
            disabled={!props.workspaceReady || loading}
            aria-label={loading ? 'Refreshing Git status' : 'Refresh Git status'}
            title="Refresh Git status"
          >
            {loading ? (
              <LoaderCircle className="git-panel-spinner" size={15} aria-hidden="true" />
            ) : (
              <RefreshCw size={15} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      {!props.workspaceReady ? (
        <PanelState
          icon={<FolderGit2 size={22} />}
          title="Choose a workspace"
          description="Git status, history, and worktrees appear after this task has a workspace."
        />
      ) : loading && !overview ? (
        <PanelState
          icon={<LoaderCircle className="git-panel-spinner" size={22} />}
          title="Reading repository"
          description="Ground is loading status, diffs, history, and worktrees."
          live
        />
      ) : hasInitialError ? (
        <PanelState
          icon={<AlertCircle size={22} />}
          title="Git status unavailable"
          description={loadError?.message ?? 'Ground could not inspect this workspace.'}
          action={
            <button type="button" onClick={() => void loadOverview(true)}>
              Try again
            </button>
          }
          error
        />
      ) : overview && !overview.isRepository ? (
        <PanelState
          icon={<FolderGit2 size={22} />}
          title={
            overview.requiresGitExecutable
              ? 'Choose Git'
              : 'Not a Git repository'
          }
          description={
            overview.message ??
            'This workspace is not initialized as a Git repository yet.'
          }
          action={
            overview.requiresGitExecutable ? (
              <button
                type="button"
                onClick={() => void chooseGitExecutable()}
                disabled={choosingGit}
              >
                {choosingGit ? 'Reviewing…' : 'Choose Git executable'}
              </button>
            ) : undefined
          }
        />
      ) : overview ? (
        <>
          <RepositorySummary
            status={overview.status}
            changedFileCount={changedFileCount}
          />

          <div
            className="git-panel-feedback"
            hidden={
              !loadError &&
              !mutationError &&
              !mutationStatus &&
              recoveryRequired.length === 0
            }
          >
            {recoveryRequired.length > 0 && (
              <RecoveryRequiredNotice recoveries={recoveryRequired} />
            )}
            {loadError && (
              <div className="git-panel-inline-error" role="alert">
                <AlertCircle size={14} aria-hidden="true" />
                <span>{loadError.message}</span>
                <button type="button" onClick={() => void loadOverview()}>
                  Retry
                </button>
              </div>
            )}
            {mutationError && (
              <div className="git-panel-inline-error" role="alert">
                <AlertCircle size={14} aria-hidden="true" />
                <span>{mutationError}</span>
              </div>
            )}
            {mutationStatus && (
              <p className="git-mutation-status" role="status">
                <Check size={13} aria-hidden="true" />
                {mutationStatus}
              </p>
            )}
          </div>

          <div className="git-panel-tabs" role="tablist" aria-label="Git views">
            {TABS.map((tab, index) => {
              const Icon = tab.icon
              const selected = activeTab === tab.id
              const count = tabCount(tab.id)
              return (
                <button
                  ref={(element) => {
                    tabButtons.current[index] = element
                  }}
                  key={tab.id}
                  id={`${idPrefix}-${tab.id}-tab`}
                  className={selected ? 'git-panel-tab active' : 'git-panel-tab'}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${idPrefix}-${tab.id}-panel`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => selectAdjacentTab(event, index)}
                >
                  <Icon size={13} aria-hidden="true" />
                  <span>{tab.label}</span>
                  <span className="git-panel-tab-count" aria-label={`${count} items`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>

          <div
            id={`${idPrefix}-changes-panel`}
            className="git-panel-content"
            role="tabpanel"
            aria-labelledby={`${idPrefix}-changes-tab`}
            tabIndex={0}
            hidden={activeTab !== 'changes'}
          >
            {activeTab === 'changes' && (
              <ChangesView
                overview={overview}
                selectedStagePaths={selectedStagePaths}
                selectedUnstagePaths={selectedUnstagePaths}
                selectedRestorePaths={selectedRestorePaths}
                commitMessage={commitMessage}
                authorName={authorName}
                authorEmail={authorEmail}
                mutation={mutation}
                undoingRecovery={undoingRecovery}
                onSelectedStagePathsChange={setSelectedStagePaths}
                onSelectedUnstagePathsChange={setSelectedUnstagePaths}
                onSelectedRestorePathsChange={setSelectedRestorePaths}
                onCommitMessageChange={setCommitMessage}
                onAuthorNameChange={setAuthorName}
                onAuthorEmailChange={setAuthorEmail}
                onStage={(paths) => void mutatePaths('stage', paths)}
                onUnstage={(paths) => void mutatePaths('unstage', paths)}
                onRestore={(paths) => void restorePaths(paths)}
                onUndoRecovery={(recoveryId) => void undoRecovery(recoveryId)}
                onCommit={commitChanges}
              />
            )}
          </div>
          <div
            id={`${idPrefix}-history-panel`}
            className="git-panel-content"
            role="tabpanel"
            aria-labelledby={`${idPrefix}-history-tab`}
            tabIndex={0}
            hidden={activeTab !== 'history'}
          >
            {activeTab === 'history' && (
              <HistoryView
                commits={overview.commits}
                truncated={overview.historyTruncated}
              />
            )}
          </div>
          <div
            id={`${idPrefix}-worktrees-panel`}
            className="git-panel-content"
            role="tabpanel"
            aria-labelledby={`${idPrefix}-worktrees-tab`}
            tabIndex={0}
            hidden={activeTab !== 'worktrees'}
          >
            {activeTab === 'worktrees' && (
              <WorktreesView
                worktrees={overview.worktrees}
                branch={branch}
                startPoint={startPoint}
                creating={creating}
                mutationBusy={Boolean(mutation)}
                createError={createError}
                removingWorktree={removingWorktree}
                onBranchChange={setBranch}
                onStartPointChange={setStartPoint}
                onSubmit={createWorktree}
                onRemove={(relativePath) => void removeWorktree(relativePath)}
              />
            )}
          </div>
        </>
      ) : null}
    </section>
  )
}

function RepositorySummary(props: {
  status?: GitStatusSummary
  changedFileCount: number
}): React.JSX.Element {
  const { status } = props
  const branchLabel = status?.detached
    ? 'Detached HEAD'
    : status?.branch ?? 'Repository'
  return (
    <div className="git-repository-summary" aria-label="Repository status">
      <div className="git-repository-branch" title={branchLabel}>
        <GitBranch size={13} aria-hidden="true" />
        <span>{branchLabel}</span>
      </div>
      <div className="git-repository-facts">
        {status?.ahead !== undefined && (
          <span title={`${status.ahead} commits ahead of upstream`}>
            ↑ {status.ahead}
          </span>
        )}
        {status?.behind !== undefined && (
          <span title={`${status.behind} commits behind upstream`}>
            ↓ {status.behind}
          </span>
        )}
        <span
          className={props.changedFileCount ? 'git-change-count dirty' : 'git-change-count clean'}
        >
          <CircleDot size={10} aria-hidden="true" />
          {props.changedFileCount
            ? `${props.changedFileCount} changed`
            : 'Working tree clean'}
        </span>
      </div>
    </div>
  )
}

export function eligibleGitRestorePaths(
  status: GitStatusSummary | undefined
): string[] {
  if (!status) return []
  const conflicts = new Set(status.conflicted)
  return [...new Set([...status.unstaged, ...status.untracked])]
    .filter((filePath) => !conflicts.has(filePath))
    .sort((left, right) => left.localeCompare(right))
}

export function RecoveryRequiredNotice(props: {
  recoveries: GitRecoverySummary[]
}): React.JSX.Element {
  const affectedPaths = new Set(
    props.recoveries.flatMap((recovery) => [
      ...recovery.trackedPaths,
      ...recovery.untrackedPaths
    ])
  ).size
  return (
    <div className="git-recovery-required" role="alert">
      <ShieldAlert size={15} aria-hidden="true" />
      <div>
        <strong>Git recovery required</strong>
        <p>
          Ground preserved pre-restore data for {affectedPaths}{' '}
          {affectedPaths === 1 ? 'path' : 'paths'}, but the restore did not
          finish cleanly. Avoid editing the affected paths and copy the
          workspace before manual repair; automatic undo is disabled.
        </p>
      </div>
    </div>
  )
}

function ChangesView(props: {
  overview: GitOverview
  selectedStagePaths: string[]
  selectedUnstagePaths: string[]
  selectedRestorePaths: string[]
  commitMessage: string
  authorName: string
  authorEmail: string
  mutation?: GitMutation
  undoingRecovery?: string
  onSelectedStagePathsChange: (paths: string[]) => void
  onSelectedUnstagePathsChange: (paths: string[]) => void
  onSelectedRestorePathsChange: (paths: string[]) => void
  onCommitMessageChange: (value: string) => void
  onAuthorNameChange: (value: string) => void
  onAuthorEmailChange: (value: string) => void
  onStage: (paths: string[]) => void
  onUnstage: (paths: string[]) => void
  onRestore: (paths: string[]) => void
  onUndoRecovery: (recoveryId: string) => void
  onCommit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
}): React.JSX.Element {
  const { overview } = props
  const status = overview.status
  const hasFiles = Boolean(
    status &&
      (status.staged.length ||
        status.unstaged.length ||
        status.untracked.length ||
        status.conflicted.length)
  )
  const hasDiff = Boolean(overview.stagedDiff?.text || overview.unstagedDiff?.text)
  const conflicts = new Set(status?.conflicted ?? [])
  const stagedPaths = status?.staged.filter((filePath) => !conflicts.has(filePath)) ?? []
  const modifiedPaths =
    status?.unstaged.filter((filePath) => !conflicts.has(filePath)) ?? []
  const restorePaths = eligibleGitRestorePaths(status)
  const busy = Boolean(props.mutation)

  const togglePath = (
    selected: string[],
    onChange: (paths: string[]) => void,
    filePath: string,
    checked: boolean
  ): void => {
    onChange(
      checked
        ? [...new Set([...selected, filePath])]
        : selected.filter((candidate) => candidate !== filePath)
    )
  }

  if (!hasFiles && !hasDiff && props.overview.recoveries.length === 0) {
    return (
      <EmptyView
        icon={<Check size={20} />}
        title="No local changes"
        description="Your working tree and index are clean."
      />
    )
  }

  return (
    <div className="git-changes-view">
      {(restorePaths.length > 0 || overview.recoveries.length > 0) && (
        <GitRecoveryActions
          eligiblePaths={restorePaths}
          selectedPaths={props.selectedRestorePaths}
          recoveries={overview.recoveries}
          recoveriesTruncated={overview.recoveriesTruncated}
          mutation={props.mutation}
          undoingRecovery={props.undoingRecovery}
          onSelectedPathsChange={props.onSelectedRestorePathsChange}
          onRestore={props.onRestore}
          onUndoRecovery={props.onUndoRecovery}
        />
      )}
      {status && hasFiles && (
        <>
          <div className="git-index-actions" aria-label="Git index actions">
            <button
              type="button"
              onClick={() => props.onStage(props.selectedStagePaths)}
              disabled={busy || props.selectedStagePaths.length === 0}
            >
              {props.mutation === 'stage' ? (
                <LoaderCircle className="git-panel-spinner" size={13} aria-hidden="true" />
              ) : (
                <Plus size={13} aria-hidden="true" />
              )}
              Stage selected
              {props.selectedStagePaths.length > 0 && (
                <span>{props.selectedStagePaths.length}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => props.onUnstage(props.selectedUnstagePaths)}
              disabled={busy || props.selectedUnstagePaths.length === 0}
            >
              {props.mutation === 'unstage' ? (
                <LoaderCircle className="git-panel-spinner" size={13} aria-hidden="true" />
              ) : (
                <Minus size={13} aria-hidden="true" />
              )}
              Unstage selected
              {props.selectedUnstagePaths.length > 0 && (
                <span>{props.selectedUnstagePaths.length}</span>
              )}
            </button>
          </div>
          <div className="git-file-groups" aria-label="Changed files">
            <FileGroup
              title="Conflicts"
              paths={status.conflicted}
              tone="conflict"
              icon={<AlertCircle size={13} />}
              operation="stage"
              selectedPaths={props.selectedStagePaths}
              disabled={busy}
              onToggle={(filePath, checked) =>
                togglePath(
                  props.selectedStagePaths,
                  props.onSelectedStagePathsChange,
                  filePath,
                  checked
                )
              }
            />
            <FileGroup
              title="Staged"
              paths={stagedPaths}
              tone="staged"
              icon={<Check size={13} />}
              operation="unstage"
              selectedPaths={props.selectedUnstagePaths}
              disabled={busy}
              onToggle={(filePath, checked) =>
                togglePath(
                  props.selectedUnstagePaths,
                  props.onSelectedUnstagePathsChange,
                  filePath,
                  checked
                )
              }
            />
            <FileGroup
              title="Modified"
              paths={modifiedPaths}
              tone="modified"
              icon={<FileWarning size={13} />}
              operation="stage"
              selectedPaths={props.selectedStagePaths}
              disabled={busy}
              onToggle={(filePath, checked) =>
                togglePath(
                  props.selectedStagePaths,
                  props.onSelectedStagePathsChange,
                  filePath,
                  checked
                )
              }
            />
            <FileGroup
              title="Untracked"
              paths={status.untracked}
              tone="untracked"
              icon={<FilePlus2 size={13} />}
              operation="stage"
              selectedPaths={props.selectedStagePaths}
              disabled={busy}
              onToggle={(filePath, checked) =>
                togglePath(
                  props.selectedStagePaths,
                  props.onSelectedStagePathsChange,
                  filePath,
                  checked
                )
              }
            />
          </div>
        </>
      )}

      <div className="git-diff-stack">
        {overview.stagedDiff?.text && (
          <DiffBlock title="Staged diff" diff={overview.stagedDiff} />
        )}
        {overview.unstagedDiff?.text && (
          <DiffBlock title="Working tree diff" diff={overview.unstagedDiff} />
        )}
        {!hasDiff && status?.untracked.length ? (
          <p className="git-diff-note">
            Untracked files appear in a diff after they are staged.
          </p>
        ) : null}
      </div>

      {status?.staged.length ? (
        <form className="git-commit-form" onSubmit={(event) => void props.onCommit(event)}>
          <div className="git-commit-form-heading">
            <GitCommitHorizontal size={15} aria-hidden="true" />
            <div>
              <h3>Commit staged changes</h3>
              <p>The native confirmation binds the exact staged tree.</p>
            </div>
          </div>
          <label>
            <span>Commit message</span>
            <textarea
              value={props.commitMessage}
              onChange={(event) => props.onCommitMessageChange(event.target.value)}
              placeholder="Describe this change"
              maxLength={65_536}
              disabled={busy}
              required
            />
          </label>
          <div className="git-commit-identity">
            <label>
              <span>Author name</span>
              <input
                value={props.authorName}
                onChange={(event) => props.onAuthorNameChange(event.target.value)}
                autoComplete="name"
                maxLength={1_024}
                disabled={busy}
                required
              />
            </label>
            <label>
              <span>Author email</span>
              <input
                type="email"
                value={props.authorEmail}
                onChange={(event) => props.onAuthorEmailChange(event.target.value)}
                autoComplete="email"
                maxLength={1_024}
                disabled={busy}
                required
              />
            </label>
          </div>
          <button
            className="git-commit-submit"
            type="submit"
            disabled={
              busy ||
              !props.commitMessage.trim() ||
              !props.authorName.trim() ||
              !props.authorEmail.trim()
            }
          >
            {props.mutation === 'commit' ? (
              <LoaderCircle className="git-panel-spinner" size={14} aria-hidden="true" />
            ) : (
              <GitCommitHorizontal size={14} aria-hidden="true" />
            )}
            {props.mutation === 'commit' ? 'Committing…' : 'Commit staged changes'}
          </button>
        </form>
      ) : null}
    </div>
  )
}

export function GitRecoveryActions(props: {
  eligiblePaths: string[]
  selectedPaths: string[]
  recoveries: GitRecoverySummary[]
  recoveriesTruncated: boolean
  mutation?: GitMutation
  undoingRecovery?: string
  onSelectedPathsChange: (paths: string[]) => void
  onRestore: (paths: string[]) => void
  onUndoRecovery: (recoveryId: string) => void
}): React.JSX.Element {
  const titleId = useId()
  const busy = Boolean(props.mutation)
  const togglePath = (filePath: string, checked: boolean): void => {
    props.onSelectedPathsChange(
      checked
        ? [...new Set([...props.selectedPaths, filePath])]
        : props.selectedPaths.filter((candidate) => candidate !== filePath)
    )
  }

  return (
    <section className="git-recovery-actions" aria-labelledby={titleId}>
      <div className="git-recovery-heading">
        <ShieldCheck size={15} aria-hidden="true" />
        <div>
          <h3 id={titleId}>Recoverable restore</h3>
          <p>
            Restore working files to the current Git index while Ground keeps
            private recovery copies. Staged changes remain staged.
          </p>
        </div>
      </div>

      {props.eligiblePaths.length > 0 && (
        <fieldset className="git-restore-picker" disabled={busy}>
          <legend>Select modified or untracked paths to restore</legend>
          <ul>
            {props.eligiblePaths.map((filePath) => (
              <li key={filePath}>
                <label>
                  <input
                    type="checkbox"
                    checked={props.selectedPaths.includes(filePath)}
                    onChange={(event) =>
                      togglePath(filePath, event.target.checked)
                    }
                  />
                  <code title={filePath}>{filePath}</code>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => props.onRestore(props.selectedPaths)}
            disabled={busy || props.selectedPaths.length === 0}
          >
            {props.mutation === 'revert' ? (
              <LoaderCircle
                className="git-panel-spinner"
                size={13}
                aria-hidden="true"
              />
            ) : (
              <RotateCcw size={13} aria-hidden="true" />
            )}
            {props.mutation === 'revert'
              ? 'Restoring safely…'
              : `Restore selected${
                  props.selectedPaths.length
                    ? ` (${props.selectedPaths.length})`
                    : ''
                }`}
          </button>
        </fieldset>
      )}

      {props.recoveries.length > 0 && (
        <div className="git-recovery-history">
          <h4>Recent restore recoveries</h4>
          <ul aria-label="Recent recoverable Git restores">
            {props.recoveries.map((recovery) => {
              const paths = [
                ...recovery.trackedPaths,
                ...recovery.untrackedPaths
              ]
              return (
                <li
                  key={recovery.id}
                  className={`git-recovery-record ${recovery.status}`}
                >
                  <div>
                    <strong>{recoveryStatusLabel(recovery)}</strong>
                    <span>
                      <time dateTime={recovery.createdAt}>
                        {formatRelativeDate(recovery.createdAt)}
                      </time>
                      {' · '}
                      {paths.length} {paths.length === 1 ? 'path' : 'paths'}
                    </span>
                    <span className="git-recovery-paths">
                      {paths.slice(0, 2).map((filePath) => (
                        <code title={filePath} key={filePath}>
                          {filePath}
                        </code>
                      ))}
                      {paths.length > 2 && <em>+{paths.length - 2} more</em>}
                    </span>
                  </div>
                  {recovery.canUndo && (
                    <button
                      type="button"
                      onClick={() => props.onUndoRecovery(recovery.id)}
                      disabled={busy}
                      aria-label={`Undo recoverable restore from ${formatCommitDate(
                        recovery.createdAt
                      )}`}
                    >
                      {props.undoingRecovery === recovery.id ? (
                        <LoaderCircle
                          className="git-panel-spinner"
                          size={13}
                          aria-hidden="true"
                        />
                      ) : (
                        <RotateCcw size={13} aria-hidden="true" />
                      )}
                      {props.undoingRecovery === recovery.id
                        ? 'Undoing…'
                        : 'Undo'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          {props.recoveriesTruncated && (
            <p className="git-recovery-truncated" role="note">
              Showing the newest restore recoveries.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function recoveryStatusLabel(recovery: GitRecoverySummary): string {
  if (recovery.status === 'recovery-required') return 'Recovery required'
  if (recovery.status === 'restored') return 'Restore undone'
  return recovery.canUndo ? 'Undo available' : 'Restore completed'
}

function FileGroup(props: {
  title: string
  paths: string[]
  tone: string
  icon: React.ReactNode
  operation: 'stage' | 'unstage'
  selectedPaths: string[]
  disabled: boolean
  onToggle: (filePath: string, checked: boolean) => void
}): React.JSX.Element | null {
  if (!props.paths.length) return null
  return (
    <section className={`git-file-group git-file-group-${props.tone}`}>
      <h3>
        <span aria-hidden="true">{props.icon}</span>
        {props.title}
        <span>{props.paths.length}</span>
      </h3>
      <ul>
        {props.paths.map((filePath) => (
          <li key={filePath}>
            <input
              type="checkbox"
              checked={props.selectedPaths.includes(filePath)}
              onChange={(event) => props.onToggle(filePath, event.target.checked)}
              disabled={props.disabled}
              aria-label={`Select ${filePath} to ${props.operation}`}
            />
            <code title={filePath}>{filePath}</code>
          </li>
        ))}
      </ul>
    </section>
  )
}

function DiffBlock(props: {
  title: string
  diff: GitDiffResult
}): React.JSX.Element {
  return (
    <section className="git-diff-block">
      <div className="git-diff-header">
        <h3>{props.title}</h3>
        <span>{formatBytes(props.diff.bytes)}</span>
      </div>
      <pre className="git-unified-diff" tabIndex={0} aria-label={props.title}>
        <code>{props.diff.text}</code>
      </pre>
      {props.diff.truncated && (
        <p className="git-diff-truncated" role="note">
          <AlertCircle size={12} aria-hidden="true" />
          Diff stopped at Ground’s output safety limit.
        </p>
      )}
    </section>
  )
}

function HistoryView(props: {
  commits: GitLogEntry[]
  truncated: boolean
}): React.JSX.Element {
  if (!props.commits.length) {
    return (
      <EmptyView
        icon={<GitCommitHorizontal size={20} />}
        title="No commits yet"
        description="Commit history will appear here after the repository’s first commit."
      />
    )
  }

  return (
    <div className="git-history-view">
      <ol className="git-commit-list">
        {props.commits.map((commit) => (
          <li className="git-commit" key={commit.hash}>
            <span className="git-commit-node" aria-hidden="true">
              <GitCommitHorizontal size={14} />
            </span>
            <div className="git-commit-copy">
              <div className="git-commit-heading">
                <h3>{commit.subject || 'Untitled commit'}</h3>
                <code title={commit.hash}>{commit.shortHash}</code>
              </div>
              <p className="git-commit-meta">
                <span title={commit.authorEmail}>{commit.authorName}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={commit.authoredAt} title={formatCommitDate(commit.authoredAt)}>
                  {formatRelativeDate(commit.authoredAt)}
                </time>
              </p>
              {commit.body && <pre className="git-commit-body">{commit.body}</pre>}
            </div>
          </li>
        ))}
      </ol>
      {props.truncated && (
        <p className="git-history-truncated" role="note">
          <AlertCircle size={12} aria-hidden="true" />
          Showing the newest commits within Ground’s history limit.
        </p>
      )}
    </div>
  )
}

function WorktreesView(props: {
  worktrees: GitWorktreeSummary[]
  branch: string
  startPoint: string
  creating: boolean
  mutationBusy: boolean
  createError?: string
  removingWorktree?: string
  onBranchChange: (value: string) => void
  onStartPointChange: (value: string) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
  onRemove: (relativePath: string) => void
}): React.JSX.Element {
  return (
    <div className="git-worktrees-view">
      <form className="git-worktree-form" onSubmit={(event) => void props.onSubmit(event)}>
        <div className="git-worktree-form-heading">
          <span aria-hidden="true">
            <Plus size={14} />
          </span>
          <div>
            <h3>New worktree</h3>
            <p>Create an isolated branch and open it as a new Ground task.</p>
          </div>
        </div>
        <label>
          <span>Branch name</span>
          <input
            value={props.branch}
            onChange={(event) => props.onBranchChange(event.target.value)}
            placeholder="feature/my-change"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={props.creating || props.mutationBusy}
            required
          />
        </label>
        <label>
          <span>Start point <small>optional</small></span>
          <input
            value={props.startPoint}
            onChange={(event) => props.onStartPointChange(event.target.value)}
            placeholder="HEAD"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={props.creating || props.mutationBusy}
          />
        </label>
        {props.createError && (
          <p className="git-worktree-form-error" role="alert">
            <AlertCircle size={12} aria-hidden="true" />
            {props.createError}
          </p>
        )}
        <button
          className="git-worktree-create"
          type="submit"
          disabled={!props.branch.trim() || props.creating || props.mutationBusy}
        >
          {props.creating ? (
            <LoaderCircle className="git-panel-spinner" size={14} aria-hidden="true" />
          ) : (
            <GitFork size={14} aria-hidden="true" />
          )}
          {props.creating ? 'Creating…' : 'Create worktree'}
        </button>
      </form>

      {props.worktrees.length ? (
        <ul className="git-worktree-list" aria-label="Repository worktrees">
          {props.worktrees.map((worktree) => (
            <li
              className={worktree.isMain ? 'git-worktree main' : 'git-worktree'}
              key={`${worktree.isMain ? 'main' : 'managed'}:${worktree.relativePath}`}
            >
              <span className="git-worktree-icon" aria-hidden="true">
                <GitFork size={14} />
              </span>
              <div className="git-worktree-copy">
                <div className="git-worktree-heading">
                  <strong>
                    {worktree.detached
                      ? 'Detached HEAD'
                      : worktree.branch ?? 'Unknown branch'}
                  </strong>
                  {worktree.isMain && <span className="git-worktree-badge">Main</span>}
                  {worktree.locked && <span className="git-worktree-badge">Locked</span>}
                  {worktree.prunable && (
                    <span className="git-worktree-badge warning">Prunable</span>
                  )}
                </div>
                <code title={worktree.relativePath}>{worktree.relativePath}</code>
              </div>
              <code className="git-worktree-head" title={worktree.head}>
                {worktree.head.slice(0, 7)}
              </code>
              {!worktree.isMain && (
                <button
                  className="git-worktree-remove"
                  type="button"
                  onClick={() => props.onRemove(worktree.relativePath)}
                  disabled={
                    props.creating ||
                    Boolean(props.removingWorktree) ||
                    worktree.locked
                  }
                  aria-label={`Remove worktree ${worktree.relativePath}`}
                  title={
                    worktree.locked
                      ? 'Unlock this worktree in Git before removing it'
                      : 'Remove managed worktree'
                  }
                >
                  {props.removingWorktree === worktree.relativePath ? (
                    <LoaderCircle
                      className="git-panel-spinner"
                      size={13}
                      aria-hidden="true"
                    />
                  ) : (
                    <Trash2 size={13} aria-hidden="true" />
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyView
          icon={<GitFork size={20} />}
          title="No worktrees"
          description="Create a worktree to work on another branch without changing this workspace."
        />
      )}
    </div>
  )
}

function PanelState(props: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
  live?: boolean
  error?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`git-panel-state${props.error ? ' error' : ''}`}
      role={props.error ? 'alert' : undefined}
      aria-live={props.live ? 'polite' : undefined}
    >
      <span className="git-panel-state-icon" aria-hidden="true">
        {props.icon}
      </span>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.action}
    </div>
  )
}

function EmptyView(props: {
  icon: React.ReactNode
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="git-panel-empty">
      <span aria-hidden="true">{props.icon}</span>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
    </div>
  )
}

function repositoryLabel(overview?: GitOverview): string {
  if (!overview) return 'Workspace source control'
  if (!overview.isRepository) return 'Unavailable in this workspace'
  if (overview.status?.detached) return 'Detached HEAD'
  return overview.status?.branch ?? 'Git repository'
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    return error.message
  }
  return fallback
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function formatCommitDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

function formatRelativeDate(value: string): string {
  const timestamp = new Date(value).valueOf()
  if (!Number.isFinite(timestamp)) return value
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1_000)
  const intervals: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60]
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, seconds] of intervals) {
    if (Math.abs(elapsedSeconds) >= seconds) {
      return formatter.format(Math.round(elapsedSeconds / seconds), unit)
    }
  }
  return formatter.format(elapsedSeconds, 'second')
}
