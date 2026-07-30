import { useEffect, useId, useRef, useState } from 'react'
import {
  ArrowUp,
  FolderPlus,
  ShieldCheck,
  Square,
  TerminalSquare
} from 'lucide-react'
import type {
  DesktopTask,
  ProviderProfile,
  RunStatus
} from '../../../shared/types'

interface ComposerProps {
  draft: string
  onDraftChange: (value: string) => void
  onRestoreDraft: (value: string) => void
  task: DesktopTask
  provider?: ProviderProfile
  disabled?: boolean
  sendBlocked?: boolean
  onChooseWorkspace: () => void
  onSend: (prompt: string) => Promise<void>
  onStop: () => Promise<void>
}

export interface PendingComposerStart {
  request: number
  baselineItemCount: number
  baselineStatus: RunStatus
  accepted: boolean
}

export interface ComposerStatePolicyInput {
  disabled: boolean
  draft: string
  needsWorkspace: boolean
  runStatus: RunStatus
  sendBlocked: boolean
  startPending: boolean
}

export interface ComposerStatePolicy {
  contextDisabled: boolean
  isBusy: boolean
  runActive: boolean
  sendDisabled: boolean
  textareaDisabled: boolean
}

export function composerStatePolicy(
  input: ComposerStatePolicyInput
): ComposerStatePolicy {
  const runActive =
    input.runStatus === 'running' || input.runStatus === 'awaiting-approval'
  const initialStartPending = input.startPending && !runActive
  return {
    contextDisabled:
      input.disabled ||
      input.sendBlocked ||
      input.startPending ||
      runActive,
    isBusy: input.startPending,
    runActive,
    sendDisabled:
      input.disabled ||
      input.sendBlocked ||
      input.startPending ||
      runActive ||
      input.needsWorkspace ||
      !input.draft.trim(),
    textareaDisabled: input.disabled || initialStartPending
  }
}

export function claimComposerStart(
  pending: Map<string, PendingComposerStart>,
  task: DesktopTask,
  request: number
): boolean {
  if (pending.has(task.id)) return false
  pending.set(task.id, {
    request,
    baselineItemCount: task.items.length,
    baselineStatus: task.runStatus,
    accepted: false
  })
  return true
}

export function acceptComposerStart(
  pending: Map<string, PendingComposerStart>,
  taskId: string,
  request: number
): boolean {
  const current = pending.get(taskId)
  if (!current || current.request !== request) return false
  current.accepted = true
  return true
}

export function releaseComposerStart(
  pending: Map<string, PendingComposerStart>,
  taskId: string,
  request: number
): boolean {
  if (pending.get(taskId)?.request !== request) return false
  pending.delete(taskId)
  return true
}

export function composerStartReachedRunBoundary(
  pending: PendingComposerStart | undefined,
  task: DesktopTask
): boolean {
  if (!pending?.accepted) return false
  return (
    task.runStatus === 'running' ||
    task.runStatus === 'awaiting-approval' ||
    task.runStatus !== pending.baselineStatus ||
    task.items.length > pending.baselineItemCount
  )
}

export type ComposerShortcutAction = 'send' | 'suppress'

export function composerShortcutAction(input: {
  ctrlKey: boolean
  isComposing: boolean
  key: string
  metaKey: boolean
  runActive: boolean
}): ComposerShortcutAction | undefined {
  if (
    input.isComposing ||
    input.key !== 'Enter' ||
    (!input.metaKey && !input.ctrlKey)
  ) {
    return undefined
  }
  return input.runActive ? 'suppress' : 'send'
}

export function shouldRestoreFailedSendFocus(input: {
  composerDisabled: boolean
  composerTaskId: string | undefined
  focusRemainsInComposer: boolean
  latestTaskRequest: number | undefined
  request: number
  sourceTaskId: string
}): boolean {
  return (
    input.latestTaskRequest === input.request &&
    input.composerTaskId === input.sourceTaskId &&
    !input.composerDisabled &&
    input.focusRemainsInComposer
  )
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingStartsRef = useRef(new Map<string, PendingComposerStart>())
  const latestStartRequestByTaskRef = useRef(new Map<string, number>())
  const nextStartRequestRef = useRef(0)
  const [, setPendingStartsVersion] = useState(0)
  const helpId = useId()
  const pendingStart = pendingStartsRef.current.get(props.task.id)
  const startPending = Boolean(pendingStart)
  const needsWorkspace =
    !props.disabled && props.provider?.kind === 'cli' && !props.task.workspace
  const policy = composerStatePolicy({
    disabled: Boolean(props.disabled),
    draft: props.draft,
    needsWorkspace,
    runStatus: props.task.runStatus,
    sendBlocked: Boolean(props.sendBlocked),
    startPending
  })

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`
  }, [props.draft])

  useEffect(() => {
    if (!policy.textareaDisabled) textareaRef.current?.focus()
  }, [props.disabled, props.task.id])

  useEffect(() => {
    if (
      !pendingStart ||
      !composerStartReachedRunBoundary(pendingStart, props.task)
    ) {
      return
    }
    if (
      releaseComposerStart(
        pendingStartsRef.current,
        props.task.id,
        pendingStart.request
      )
    ) {
      if (
        latestStartRequestByTaskRef.current.get(props.task.id) ===
        pendingStart.request
      ) {
        latestStartRequestByTaskRef.current.delete(props.task.id)
      }
      setPendingStartsVersion((current) => current + 1)
    }
  }, [
    pendingStart?.accepted,
    pendingStart?.request,
    props.task.id,
    props.task.items.length,
    props.task.runStatus
  ])

  const send = async (): Promise<void> => {
    const sourceDraft = props.draft
    const prompt = sourceDraft.trim()
    if (
      !prompt ||
      policy.runActive ||
      props.disabled ||
      needsWorkspace ||
      props.sendBlocked
    ) {
      return
    }
    const sourceTaskId = props.task.id
    const request = ++nextStartRequestRef.current
    if (
      !claimComposerStart(
        pendingStartsRef.current,
        props.task,
        request
      )
    ) {
      return
    }
    latestStartRequestByTaskRef.current.set(sourceTaskId, request)
    const sourceOnDraftChange = props.onDraftChange
    const sourceOnRestoreDraft = props.onRestoreDraft
    const sourceOnSend = props.onSend
    sourceOnDraftChange('')
    setPendingStartsVersion((current) => current + 1)
    let accepted = false
    try {
      await sourceOnSend(prompt)
      accepted = acceptComposerStart(
        pendingStartsRef.current,
        sourceTaskId,
        request
      )
      if (accepted) {
        setPendingStartsVersion((current) => current + 1)
      }
    } catch {
      if (
        pendingStartsRef.current.get(sourceTaskId)?.request === request
      ) {
        sourceOnRestoreDraft(sourceDraft)
      }
      window.requestAnimationFrame(() => {
        const composer = textareaRef.current
        const activeElement = document.activeElement
        const focusRemainsInComposer =
          activeElement === document.body ||
          Boolean(
            composer
              ?.closest('.composer')
              ?.contains(activeElement)
          )
        const shouldFocus =
          composer &&
          shouldRestoreFailedSendFocus({
            composerDisabled: composer.disabled,
            composerTaskId: composer.dataset.taskId,
            focusRemainsInComposer,
            latestTaskRequest:
              latestStartRequestByTaskRef.current.get(sourceTaskId),
            request,
            sourceTaskId
          })
        if (
          latestStartRequestByTaskRef.current.get(sourceTaskId) ===
          request
        ) {
          latestStartRequestByTaskRef.current.delete(sourceTaskId)
        }
        if (shouldFocus) composer.focus()
      })
    } finally {
      if (
        !accepted &&
        releaseComposerStart(
          pendingStartsRef.current,
          sourceTaskId,
          request
        )
      ) {
        setPendingStartsVersion((current) => current + 1)
      }
    }
  }

  return (
    <div className="composer-wrap">
      {needsWorkspace && (
        <button
          className="composer-notice"
          type="button"
          onClick={props.onChooseWorkspace}
        >
          <FolderPlus size={14} />
          CLI agents need a workspace. Choose a folder to continue.
          <span>Choose folder</span>
        </button>
      )}
      <div
        className={`composer ${
          policy.runActive || startPending ? 'composer-running' : ''
        } ${props.disabled ? 'composer-disabled' : ''}`}
        aria-busy={startPending}
      >
        <textarea
          ref={textareaRef}
          id="task-message-composer"
          data-task-id={props.task.id}
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            const action = composerShortcutAction({
              ctrlKey: event.ctrlKey,
              isComposing: event.nativeEvent.isComposing,
              key: event.key,
              metaKey: event.metaKey,
              runActive: policy.runActive
            })
            if (!action) return
            event.preventDefault()
            if (action === 'send') void send()
          }}
          placeholder={
            props.disabled
              ? 'Restore this task to continue…'
              : props.task.mode === 'agent'
              ? 'Ask Ground to inspect, change, or run something…'
              : 'Ask anything about your work…'
          }
          disabled={policy.textareaDisabled}
          rows={1}
          aria-label="Message"
          aria-describedby={helpId}
          aria-keyshortcuts={
            policy.runActive ||
            policy.textareaDisabled ||
            props.sendBlocked ||
            needsWorkspace
              ? undefined
              : 'Meta+Enter Control+Enter'
          }
        />

        <div className="composer-toolbar">
          <div className="composer-context">
            <button
              className="context-chip"
              type="button"
              onClick={props.onChooseWorkspace}
              title={props.task.workspace?.name}
              disabled={policy.contextDisabled}
            >
              <span className="context-chip-icon">
                {props.provider?.kind === 'cli' ? (
                  <TerminalSquare size={12} />
                ) : (
                  <span className="tiny-diamond">◆</span>
                )}
              </span>
              {props.task.workspace?.name ?? 'No workspace'}
            </button>
            <span className="permission-label">
              <ShieldCheck size={12} />
              {props.provider?.kind === 'cli'
                ? 'CLI permission policy'
                : props.task.mode === 'agent'
                  ? 'Changes ask first'
                  : 'Read-only workspace'}
            </span>
          </div>

          {policy.runActive ? (
            <button
              key="stop-run"
              className="send-button stop-button"
              type="button"
              onClick={() => void props.onStop()}
              aria-label="Stop run"
              title="Stop run"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              key="send-message"
              className="send-button"
              type="button"
              onClick={() => void send()}
              disabled={policy.sendDisabled}
              aria-label={
                props.sendBlocked
                  ? 'Preparing Agent draft'
                  : startPending
                    ? 'Sending message'
                    : 'Send message'
              }
              aria-busy={startPending}
              title="Send · ⌘/Ctrl Enter"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-caption" id={helpId}>
        <span>{props.disabled ? 'Archived task' : props.provider?.name ?? 'No provider'}</span>
        <span role="status" aria-live="polite" aria-atomic="true">
          {props.disabled
            ? 'Restore to continue'
            : policy.runActive
              ? 'Draft only — not queued, sent, or steering this run'
              : props.sendBlocked
              ? 'Preparing Agent draft…'
              : startPending
                ? 'Sending…'
                : '⌘/Ctrl Enter to send'}
        </span>
      </div>
    </div>
  )
}
