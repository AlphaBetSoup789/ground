import { useEffect, useId, useRef, useState } from 'react'
import {
  ArrowUp,
  FolderPlus,
  ShieldCheck,
  Square,
  TerminalSquare
} from 'lucide-react'
import type { DesktopTask, ProviderProfile } from '../../../shared/types'

interface ComposerProps {
  draft: string
  onDraftChange: (value: string) => void
  task: DesktopTask
  provider?: ProviderProfile
  disabled?: boolean
  sendBlocked?: boolean
  onChooseWorkspace: () => void
  onSend: (prompt: string) => Promise<void>
  onStop: () => Promise<void>
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wasRunningRef = useRef(false)
  const [sending, setSending] = useState(false)
  const helpId = useId()
  const isRunning =
    props.task.runStatus === 'running' || props.task.runStatus === 'awaiting-approval'
  const isBusy = isRunning || sending
  const interactionDisabled = isBusy || Boolean(props.disabled)
  const needsWorkspace =
    !props.disabled && props.provider?.kind === 'cli' && !props.task.workspace

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`
  }, [props.draft])

  useEffect(() => {
    if (!props.disabled) textareaRef.current?.focus()
  }, [props.disabled, props.task.id])

  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      textareaRef.current?.focus()
    }
    wasRunningRef.current = isRunning
  }, [isRunning])

  const send = async (): Promise<void> => {
    const prompt = props.draft.trim()
    if (
      !prompt ||
      interactionDisabled ||
      needsWorkspace ||
      props.sendBlocked
    ) {
      return
    }
    props.onDraftChange('')
    setSending(true)
    try {
      await props.onSend(prompt)
    } catch {
      props.onDraftChange(prompt)
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    } finally {
      setSending(false)
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
        className={`composer ${isBusy ? 'composer-running' : ''} ${
          props.disabled ? 'composer-disabled' : ''
        }`}
        aria-busy={isBusy}
      >
        <textarea
          ref={textareaRef}
          id="task-message-composer"
          data-task-id={props.task.id}
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={
            props.disabled
              ? 'Restore this task to continue…'
              : props.task.mode === 'agent'
              ? 'Ask Ground to inspect, change, or run something…'
              : 'Ask anything about your work…'
          }
          disabled={interactionDisabled}
          rows={1}
          aria-label="Message"
          aria-describedby={helpId}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        />

        <div className="composer-toolbar">
          <div className="composer-context">
            <button
              className="context-chip"
              type="button"
              onClick={props.onChooseWorkspace}
              title={props.task.workspace?.name}
              disabled={interactionDisabled || props.sendBlocked}
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

          {isRunning ? (
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
              disabled={
                !props.draft.trim() ||
                needsWorkspace ||
                sending ||
                props.sendBlocked ||
                Boolean(props.disabled)
              }
              aria-label={
                props.sendBlocked
                  ? 'Preparing Agent draft'
                  : sending
                    ? 'Sending message'
                    : 'Send message'
              }
              aria-busy={sending}
              title="Send · ⌘/Ctrl Enter"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-caption" id={helpId}>
        <span>{props.disabled ? 'Archived task' : props.provider?.name ?? 'No provider'}</span>
        <span>
          {props.disabled
            ? 'Restore to continue'
            : props.sendBlocked
              ? 'Preparing Agent draft…'
              : sending
                ? 'Sending…'
                : '⌘/Ctrl Enter to send'}
        </span>
      </div>
    </div>
  )
}
