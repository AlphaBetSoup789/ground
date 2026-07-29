import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  FileCode2,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  ActivityItem,
  DesktopTask,
  ProviderProfile,
} from '../../../shared/types'

interface TimelineProps {
  task: DesktopTask
  provider?: ProviderProfile
  suggestions: string[]
  onSuggestion: (prompt: string) => void
  onResolveApproval: (item: ActivityItem, approved: boolean) => Promise<void>
  onSetImportedHistory: (include: boolean) => void
}

const TIMELINE_PAGE_SIZE = 200

export function Timeline(props: TimelineProps): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(TIMELINE_PAGE_SIZE)
  const lastItem = props.task.items.at(-1)
  const contentKey = useMemo(
    () => `${props.task.id}:${props.task.items.length}:${
      lastItem?.kind === 'message'
        ? lastItem.content.length
        : (lastItem?.status ?? '')
    }`,
    [lastItem, props.task.id, props.task.items.length]
  )

  useEffect(() => {
    setVisibleCount(TIMELINE_PAGE_SIZE)
  }, [props.task.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [contentKey])

  if (!props.task.items.length) {
    return (
      <section
        className="timeline timeline-empty"
        aria-label="Task conversation"
      >
        <div className="empty-task">
          <div className="empty-task-icon">
            <Sparkles size={18} />
          </div>
          <p className="empty-kicker">
            {props.task.mode === 'agent' ? 'Agent workspace' : 'Focused conversation'}
          </p>
          <h2>What would you like to work on?</h2>
          <p className="empty-description">
            {props.task.mode === 'agent'
              ? 'I can inspect this workspace, propose edits, and run approved commands.'
              : 'Ask for an explanation, review, or plan. Workspace access stays read-only.'}
          </p>
          <div className="suggestion-list">
            {props.suggestions.map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => props.onSuggestion(suggestion)}>
                <span>{suggestion}</span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
          <div className="empty-provider">
            <span className={props.provider?.kind === 'cli' ? 'provider-pip cli' : 'provider-pip'} />
            {props.provider?.name ?? 'Choose a provider'}
            {props.provider?.model && <span>· {props.provider.model}</span>}
          </div>
        </div>
      </section>
    )
  }

  const lastAssistant = [...props.task.items]
    .reverse()
    .find((item) => item.kind === 'message' && item.role === 'assistant')
  const hiddenItemCount = Math.max(
    0,
    props.task.items.length - visibleCount
  )
  const visibleItems =
    hiddenItemCount > 0
      ? props.task.items.slice(hiddenItemCount)
      : props.task.items

  return (
    <section
      className="timeline"
      role="log"
      aria-label="Task conversation"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={props.task.runStatus === 'running'}
    >
      <div className="timeline-column">
        {props.task.items.some((item) => item.historyOnly) && (
          <div className="imported-history-note">
            <ShieldCheck size={13} />
            <span>
              <strong>
                Imported history is{' '}
                {props.task.includeImportedHistory
                  ? 'included in model context.'
                  : 'visible only.'}
              </strong>{' '}
              It is untrusted and carries no workspace or action authority.
            </span>
            <button
              type="button"
              aria-pressed={props.task.includeImportedHistory === true}
              disabled={
                Boolean(props.task.archivedAt) ||
                props.task.runStatus === 'running' ||
                props.task.runStatus === 'awaiting-approval'
              }
              onClick={() =>
                props.onSetImportedHistory(
                  props.task.includeImportedHistory !== true
                )
              }
            >
              {props.task.includeImportedHistory
                ? 'Exclude from context'
                : 'Include in context'}
            </button>
          </div>
        )}
        {hiddenItemCount > 0 && (
          <button
            className="timeline-load-older"
            type="button"
            onClick={() =>
              setVisibleCount((current) =>
                Math.min(
                  props.task.items.length,
                  current + TIMELINE_PAGE_SIZE
                )
              )
            }
          >
            Load {Math.min(hiddenItemCount, TIMELINE_PAGE_SIZE)} older timeline
            {Math.min(hiddenItemCount, TIMELINE_PAGE_SIZE) === 1
              ? ' item'
              : ' items'}
            <span>{hiddenItemCount.toLocaleString()} hidden</span>
          </button>
        )}
        {visibleItems.map((item) =>
          item.kind === 'message' ? (
            <article
              key={item.id}
              className={`message message-${item.role} ${
                item.id === lastAssistant?.id && props.task.runStatus === 'running'
                  ? 'message-streaming'
                  : ''
              }`}
            >
              {item.role === 'user' && (
                <span className="visually-hidden">You said:</span>
              )}
              {item.role === 'assistant' && (
                <div className="assistant-gutter" aria-hidden="true">
                  <div className="assistant-avatar">G</div>
                </div>
              )}
              <div className="message-body">
                {item.role === 'assistant' && (
                  <div className="message-author">
                    Ground
                    <span>{item.provider?.name ?? props.provider?.name}</span>
                  </div>
                )}
                {item.content ? (
                  <div className="markdown">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ children }) => <span className="markdown-link">{children}</span>
                      }}
                    >
                      {item.content}
                    </ReactMarkdown>
                    {item.id === lastAssistant?.id && props.task.runStatus === 'running' && (
                      <span className="stream-caret" />
                    )}
                  </div>
                ) : (
                  <div className="thinking-dots" role="status" aria-label="Ground is thinking">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>
            </article>
          ) : (
            <ActivityCard
              key={item.id}
              item={item}
              onResolve={(approved) => props.onResolveApproval(item, approved)}
            />
          )
        )}
        {props.task.runStatus === 'awaiting-approval' && (
          <div className="awaiting-note">
            <CircleDot size={12} />
            Waiting for your approval
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </section>
  )
}

function ActivityCard(props: {
  item: ActivityItem
  onResolve: (approved: boolean) => Promise<void>
}): React.JSX.Element {
  const { item } = props
  const [resolving, setResolving] = useState(false)
  const approvalDescriptionId = useId()
  const summaryRef = useRef<HTMLElement>(null)
  const Icon =
    item.activityType === 'command'
      ? TerminalSquare
      : item.activityType === 'error'
        ? AlertTriangle
        : item.toolName === 'write_file' || item.toolName === 'edit_file'
          ? FileCode2
          : item.toolName === 'search_files'
            ? Search
            : Code2
  const isPending = item.status === 'pending'
  const defaultOpen =
    isPending || item.status === 'error' || item.status === 'denied'
  const [isOpen, setIsOpen] = useState(defaultOpen)
  useEffect(() => {
    if (defaultOpen) setIsOpen(true)
  }, [defaultOpen])
  const resolve = async (approved: boolean): Promise<void> => {
    if (resolving) return
    setResolving(true)
    try {
      await props.onResolve(approved)
    } finally {
      setResolving(false)
      window.requestAnimationFrame(() => summaryRef.current?.focus())
    }
  }

  return (
    <div className={`activity-shell activity-${item.status}`}>
      <details
        className="activity-card"
        open={isOpen}
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
      >
        <summary ref={summaryRef}>
          <span className="activity-icon">
            <Icon size={14} />
          </span>
          <span className="activity-title">{item.title}</span>
          <span className="activity-meta">
            {item.provider?.name && <span>{item.provider.name}</span>}
            {item.durationMs !== undefined && (
              <span>
                <Clock3 size={10} />
                {formatDuration(item.durationMs)}
              </span>
            )}
            <StatusIcon status={item.status} />
            <span className="visually-hidden">
              {activityStatusLabel(item.status)}
            </span>
          </span>
          <ChevronRight className="activity-chevron" size={13} />
        </summary>

        <div className="activity-detail">
          {item.detail && (
            <pre tabIndex={0} aria-label={`${item.title} exact action`}>
              {item.detail}
            </pre>
          )}
          {item.result && (
            <div className="activity-result">
              <span>Result</span>
              <pre tabIndex={0} aria-label={`${item.title} result`}>
                {item.result}
              </pre>
            </div>
          )}
          {isPending && item.approvalId && (
            <div
              className="approval-actions"
              role="group"
              aria-labelledby={approvalDescriptionId}
              aria-busy={resolving}
            >
              <div
                className="approval-copy"
                id={approvalDescriptionId}
                role="alert"
              >
                <AlertTriangle size={13} />
                Review the exact action above. Allow once opens a native
                confirmation.
              </div>
              <div>
                <button
                  className="deny-button"
                  type="button"
                  onClick={(event) => {
                    event.preventDefault()
                    void resolve(false)
                  }}
                  disabled={resolving}
                >
                  {resolving ? 'Resolving…' : 'Deny'}
                </button>
                <button
                  className="approve-button"
                  type="button"
                  onClick={(event) => {
                    event.preventDefault()
                    void resolve(true)
                  }}
                  disabled={resolving}
                >
                  <Check size={13} />
                  Allow once
                </button>
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

function StatusIcon({ status }: { status: ActivityItem['status'] }): React.JSX.Element {
  if (status === 'running') {
    return <LoaderCircle className="status-spin" size={12} aria-hidden="true" />
  }
  if (status === 'success') {
    return <Check className="status-success" size={12} aria-hidden="true" />
  }
  if (status === 'denied') {
    return <X className="status-denied" size={12} aria-hidden="true" />
  }
  if (status === 'error') {
    return <AlertTriangle className="status-error" size={12} aria-hidden="true" />
  }
  return <CircleDot className="status-pending" size={12} aria-hidden="true" />
}

function activityStatusLabel(status: ActivityItem['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending approval'
    case 'running':
      return 'Running'
    case 'success':
      return 'Completed'
    case 'denied':
      return 'Denied'
    case 'error':
      return 'Failed'
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}
