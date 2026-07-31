import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Ref
} from 'react'
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Copy,
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
import {
  fencedAssistantCodeBlocks,
  type FencedAssistantCodeBlock
} from '../../../shared/assistant-output-clipboard'
import type {
  CopyAssistantOutputInput,
  DesktopActivityItem,
  DesktopTask,
  ProviderProfile,
  RunStatus
} from '../../../shared/types'
import { providerFailureGuidance } from '../../../shared/provider-failure-guidance'
import {
  askToAgentHandoffSource,
  type AskToAgentHandoffSource
} from '../lib/ask-agent-handoff'
import {
  ASSISTANT_ANNOUNCEMENT_INTERVAL_MS,
  assistantRunFinishedAnnouncement,
  assistantRunStartedAnnouncement,
  takeAssistantAnnouncementBatch
} from '../lib/assistant-announcements'
import {
  ASSISTANT_CODE_COPY_LABEL,
  ASSISTANT_RESPONSE_COPY_LABEL,
  type AssistantOutputCopyPhase,
  type AssistantOutputCopyRequest,
  assistantOutputCopyStatus,
  canCopyAssistantOutput,
  deriveAssistantOutputCopyEligibility,
  shouldApplyAssistantOutputCopyResult
} from '../lib/copy-assistant-output'

interface TimelineProps {
  task: DesktopTask
  provider?: ProviderProfile
  suggestions: string[]
  onSuggestion: (prompt: string) => void
  onResolveApproval: (
    item: DesktopActivityItem,
    approved: boolean
  ) => Promise<void>
  onSetImportedHistory: (include: boolean) => void
  onContinueInAgent?: (
    source: AskToAgentHandoffSource
  ) => Promise<boolean>
  onCopyAssistantOutput?: (
    input: CopyAssistantOutputInput
  ) => Promise<boolean>
}

const TIMELINE_PAGE_SIZE = 200
const TIMELINE_FOLLOW_DISTANCE_PX = 80
const TIMELINE_JUMP_ANNOUNCEMENT =
  'Moved to latest activity. Following new output.'

export function shouldFollowTimeline(
  viewport: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>
): boolean {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    TIMELINE_FOLLOW_DISTANCE_PX
  )
}

export function shouldOfferTimelineJump(
  viewport: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>
): boolean {
  return (
    viewport.scrollHeight > viewport.clientHeight &&
    !shouldFollowTimeline(viewport)
  )
}

export function shouldContinueTimelineFollow(
  currentlyFollowing: boolean,
  viewport: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>
): boolean {
  return currentlyFollowing && shouldFollowTimeline(viewport)
}

export function shouldApplyTimelineJump(input: {
  requestedTaskId: string
  currentTaskId: string
  requestedViewportIsCurrent: boolean
}): boolean {
  return (
    input.requestedTaskId === input.currentTaskId &&
    input.requestedViewportIsCurrent
  )
}

function moveTimelineToLatest(timeline: HTMLElement): void {
  const priorScrollBehavior = timeline.style.scrollBehavior
  timeline.style.scrollBehavior = 'auto'
  timeline.scrollTop = timeline.scrollHeight
  timeline.style.scrollBehavior = priorScrollBehavior
}

function isActiveRunStatus(status: RunStatus | undefined): boolean {
  return status === 'running' || status === 'awaiting-approval'
}

interface AssistantAnnouncementState {
  text: string
  revision: number
}

interface TimelineJumpState {
  taskId: string
  visible: boolean
  announcement: string
  revision: number
}

interface AssistantOutputCopyFeedback {
  request: AssistantOutputCopyRequest
  phase: AssistantOutputCopyPhase
  revision: number
}

function initialTimelineJumpState(taskId: string): TimelineJumpState {
  return {
    taskId,
    visible: false,
    announcement: '',
    revision: 0
  }
}

function useAssistantRunAnnouncement(
  task: DesktopTask
): AssistantAnnouncementState {
  const assistant = [...task.items]
    .reverse()
    .find((item) => item.kind === 'message' && item.role === 'assistant')
  const messageId = assistant?.id
  const content = assistant?.kind === 'message' ? assistant.content : ''
  const [announcement, setAnnouncement] =
    useState<AssistantAnnouncementState>({ text: '', revision: 0 })
  const announce = useCallback((text: string): void => {
    setAnnouncement((current) => ({
      text,
      revision: current.revision + 1
    }))
  }, [])
  const sourceRef = useRef({
    messageId,
    content,
    status: task.runStatus
  })
  const taskIdRef = useRef(task.id)
  const messageIdRef = useRef(messageId)
  const statusRef = useRef<RunStatus | undefined>(undefined)
  const announcedOffsetRef = useRef(content.length)

  sourceRef.current = {
    messageId,
    content,
    status: task.runStatus
  }

  useEffect(() => {
    const taskChanged = taskIdRef.current !== task.id
    if (taskChanged) {
      taskIdRef.current = task.id
      messageIdRef.current = messageId
      statusRef.current = undefined
      announcedOffsetRef.current = content.length
      announce('')
    }

    const previousStatus = statusRef.current
    const messageChanged = messageIdRef.current !== messageId
    if (messageChanged) {
      messageIdRef.current = messageId
      announcedOffsetRef.current = isActiveRunStatus(task.runStatus)
        ? 0
        : content.length
    }

    statusRef.current = task.runStatus
    const wasActive = isActiveRunStatus(previousStatus)
    const isActive = isActiveRunStatus(task.runStatus)

    if (!wasActive && isActive) {
      if (!messageChanged && !taskChanged) {
        announcedOffsetRef.current = content.length
      }
      const started = assistantRunStartedAnnouncement(task.runStatus)
      if (started) announce(started)
      return
    }

    if (
      previousStatus === 'awaiting-approval' &&
      task.runStatus === 'running'
    ) {
      announce('Ground resumed responding.')
      return
    }

    if (
      previousStatus === 'running' &&
      task.runStatus === 'awaiting-approval'
    ) {
      announce('Ground is waiting for your approval.')
      return
    }

    if (wasActive && !isActive) {
      const pendingBatch = takeAssistantAnnouncementBatch(
        content,
        announcedOffsetRef.current
      )
      announcedOffsetRef.current = content.length
      announce(
        assistantRunFinishedAnnouncement(task.runStatus, pendingBatch)
      )
    }
  }, [announce, content, messageId, task.id, task.runStatus])

  useEffect(() => {
    if (task.runStatus !== 'running') return

    const interval = window.setInterval(() => {
      const source = sourceRef.current
      if (
        source.status !== 'running' ||
        source.messageId !== messageIdRef.current
      ) {
        return
      }
      const batch = takeAssistantAnnouncementBatch(
        source.content,
        announcedOffsetRef.current
      )
      if (!batch) {
        announcedOffsetRef.current = source.content.length
        return
      }
      announcedOffsetRef.current = batch.nextOffset
      announce(`Ground says: ${batch.text}`)
    }, ASSISTANT_ANNOUNCEMENT_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [announce, messageId, task.id, task.runStatus])

  return announcement
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  const timelineRef = useRef<HTMLElement>(null)
  const timelineColumnRef = useRef<HTMLDivElement>(null)
  const jumpButtonRef = useRef<HTMLButtonElement>(null)
  const followOutputRef = useRef(true)
  const taskIdRef = useRef(props.task.id)
  const copyTaskRef = useRef(props.task)
  const copyRequestIdRef = useRef(0)
  const handoffButtonRef = useRef<HTMLButtonElement>(null)
  const [visibleCount, setVisibleCount] = useState(TIMELINE_PAGE_SIZE)
  const [handoffPending, setHandoffPending] = useState<string>()
  const [handoffStatus, setHandoffStatus] = useState('')
  const [copyFeedback, setCopyFeedback] =
    useState<AssistantOutputCopyFeedback>()
  const [jumpState, setJumpState] = useState<TimelineJumpState>(() =>
    initialTimelineJumpState(props.task.id)
  )
  const timelineId = useId()
  const handoffDescriptionId = useId()
  const assistantAnnouncement = useAssistantRunAnnouncement(props.task)
  const lastItem = props.task.items.at(-1)
  const copyEligibility = useMemo(
    () => deriveAssistantOutputCopyEligibility(props.task),
    [props.task.id, props.task.items, props.task.runStatus]
  )
  const lastAssistant = [...props.task.items]
    .reverse()
    .find((item) => item.kind === 'message' && item.role === 'assistant')
  const handoffSource = props.onContinueInAgent
    ? askToAgentHandoffSource(props.task, props.provider)
    : undefined
  taskIdRef.current = props.task.id
  copyTaskRef.current = props.task
  const jumpVisible =
    jumpState.taskId === props.task.id && jumpState.visible
  const jumpAnnouncement =
    jumpState.taskId === props.task.id
      ? jumpState.announcement
      : ''
  const visibleCopyFeedback =
    copyFeedback &&
    shouldApplyAssistantOutputCopyResult({
      request: copyFeedback.request,
      currentRequestId: copyRequestIdRef.current,
      currentTask: props.task
    })
      ? copyFeedback
      : undefined
  const focusTimelineIfJumpFocused = useCallback(
    (timeline: HTMLElement): void => {
      if (jumpButtonRef.current === document.activeElement) {
        timeline.focus({ preventScroll: true })
      }
    },
    []
  )
  const updateTimelineJumpVisibility = useCallback(
    (timeline: HTMLElement, visible: boolean): void => {
      const sourceTaskId = props.task.id
      if (taskIdRef.current !== sourceTaskId) return

      if (!visible) focusTimelineIfJumpFocused(timeline)
      setJumpState((current) => {
        if (taskIdRef.current !== sourceTaskId) return current
        const source =
          current.taskId === sourceTaskId
            ? current
            : initialTimelineJumpState(sourceTaskId)
        const announcement = visible ? '' : source.announcement
        if (
          source.visible === visible &&
          source.announcement === announcement
        ) {
          return source
        }
        return {
          ...source,
          visible,
          announcement
        }
      })
    },
    [focusTimelineIfJumpFocused, props.task.id]
  )
  const updateTimelineFollow = useCallback(
    (timeline: HTMLElement): void => {
      const sourceTaskId = props.task.id
      if (taskIdRef.current !== sourceTaskId) return

      followOutputRef.current = shouldContinueTimelineFollow(
        followOutputRef.current,
        timeline
      )
      updateTimelineJumpVisibility(
        timeline,
        shouldOfferTimelineJump(timeline)
      )
    },
    [props.task.id, updateTimelineJumpVisibility]
  )
  const jumpToLatest = useCallback((): void => {
    const requestedTaskId = props.task.id
    const timeline = timelineRef.current
    if (
      !timeline ||
      !shouldApplyTimelineJump({
        requestedTaskId,
        currentTaskId: taskIdRef.current,
        requestedViewportIsCurrent: timelineRef.current === timeline
      })
    ) {
      return
    }
    if (!shouldOfferTimelineJump(timeline)) {
      focusTimelineIfJumpFocused(timeline)
      setJumpState((current) =>
        current.taskId === requestedTaskId
          ? { ...current, visible: false }
          : current
      )
      return
    }

    followOutputRef.current = true
    moveTimelineToLatest(timeline)
    timeline.focus({ preventScroll: true })
    setJumpState((current) => {
      if (
        !shouldApplyTimelineJump({
          requestedTaskId,
          currentTaskId: taskIdRef.current,
          requestedViewportIsCurrent: timelineRef.current === timeline
        })
      ) {
        return current
      }
      const source =
        current.taskId === requestedTaskId
          ? current
          : initialTimelineJumpState(requestedTaskId)
      return {
        ...source,
        visible: false,
        announcement: TIMELINE_JUMP_ANNOUNCEMENT,
        revision: source.revision + 1
      }
    })
  }, [focusTimelineIfJumpFocused, props.task.id])
  const requestAgentHandoff = useCallback(
    (source: AskToAgentHandoffSource): void => {
      const continueInAgent = props.onContinueInAgent
      if (handoffPending || !continueInAgent) return

      setHandoffPending(source.assistantMessageId)
      setHandoffStatus('Switching this task to Agent mode.')
      void (async () => {
        let prepared = false
        try {
          prepared = await continueInAgent(source)
          if (taskIdRef.current !== source.taskId) return
          setHandoffStatus(
            prepared
              ? 'Agent mode selected. Review the draft, then send when ready.'
              : 'The Agent draft was not prepared.'
          )
        } catch {
          if (taskIdRef.current === source.taskId) {
            setHandoffStatus('The Agent draft was not prepared.')
          }
        } finally {
          if (taskIdRef.current !== source.taskId) return
          setHandoffPending(undefined)
          if (!prepared) {
            window.requestAnimationFrame(() => {
              if (taskIdRef.current === source.taskId) {
                handoffButtonRef.current?.focus()
              }
            })
          }
        }
      })()
    },
    [handoffPending, props.onContinueInAgent]
  )
  const requestAssistantOutputCopy = useCallback(
    (input: CopyAssistantOutputInput): void => {
      const request: AssistantOutputCopyRequest = {
        requestId: copyRequestIdRef.current + 1,
        input
      }
      copyRequestIdRef.current = request.requestId
      setCopyFeedback((current) => ({
        request,
        phase: 'pending',
        revision: (current?.revision ?? 0) + 1
      }))

      void (async () => {
        let copied = false
        try {
          copied =
            (await props.onCopyAssistantOutput?.(input)) ?? false
        } catch {
          copied = false
        }

        if (
          !shouldApplyAssistantOutputCopyResult({
            request,
            currentRequestId: copyRequestIdRef.current,
            currentTask: copyTaskRef.current
          })
        ) {
          return
        }
        setCopyFeedback((current) => {
          if (current?.request.requestId !== request.requestId) {
            return current
          }
          return {
            request,
            phase: copied ? 'copied' : 'failed',
            revision: current.revision + 1
          }
        })
      })()
    },
    [props.onCopyAssistantOutput]
  )
  const contentKey = useMemo(
    () => `${props.task.id}:${props.task.items.length}:${
      lastItem?.kind === 'message'
        ? lastItem.content.length
        : (lastItem?.status ?? '')
    }`,
    [lastItem, props.task.id, props.task.items.length]
  )

  useEffect(() => {
    copyRequestIdRef.current += 1
    setVisibleCount(TIMELINE_PAGE_SIZE)
    setHandoffPending(undefined)
    setHandoffStatus('')
    setCopyFeedback(undefined)
    setJumpState(initialTimelineJumpState(props.task.id))
    followOutputRef.current = true
  }, [props.task.id])

  useEffect(() => {
    setCopyFeedback((current) => {
      if (
        !current ||
        shouldApplyAssistantOutputCopyResult({
          request: current.request,
          currentRequestId: copyRequestIdRef.current,
          currentTask: props.task
        })
      ) {
        return current
      }
      return undefined
    })
  }, [props.task])

  useEffect(() => {
    const timeline = timelineRef.current
    if (!timeline || typeof ResizeObserver === 'undefined') return

    const sourceTaskId = props.task.id
    const observer = new ResizeObserver(() => {
      if (
        taskIdRef.current === sourceTaskId &&
        timelineRef.current === timeline
      ) {
        if (followOutputRef.current) {
          moveTimelineToLatest(timeline)
          updateTimelineJumpVisibility(timeline, false)
        } else {
          updateTimelineJumpVisibility(
            timeline,
            shouldOfferTimelineJump(timeline)
          )
        }
      }
    })
    observer.observe(timeline)
    if (timelineColumnRef.current) {
      observer.observe(timelineColumnRef.current)
    }

    return () => observer.disconnect()
  }, [
    props.task.id,
    props.task.items.length === 0,
    updateTimelineJumpVisibility
  ])

  useEffect(() => {
    const timeline = timelineRef.current
    if (timeline && followOutputRef.current) {
      moveTimelineToLatest(timeline)
      setJumpState((current) =>
        current.taskId === props.task.id && current.visible
          ? { ...current, visible: false }
          : current
      )
    }
  }, [contentKey, props.task.id])

  if (!props.task.items.length) {
    return (
      <>
        <div className="timeline-shell" data-task-id={props.task.id}>
          <section
            ref={timelineRef}
            id={timelineId}
            className="timeline timeline-empty"
            aria-label="Task conversation"
            tabIndex={-1}
            onScroll={(event) =>
              updateTimelineFollow(event.currentTarget)
            }
          >
            <div className="empty-task">
              <div className="empty-task-icon">
                <Sparkles size={18} />
              </div>
              <p className="empty-kicker">
                {props.task.mode === 'agent'
                  ? 'Agent workspace'
                  : 'Focused conversation'}
              </p>
              <h2>What would you like to work on?</h2>
              <p className="empty-description">
                {props.task.mode === 'agent'
                  ? 'I can inspect this workspace, propose edits, and run approved commands.'
                  : 'Ask for an explanation, review, or plan. Workspace access stays read-only.'}
              </p>
              <div className="suggestion-list">
                {props.suggestions.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    onClick={() => props.onSuggestion(suggestion)}
                  >
                    <span>{suggestion}</span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
              <div className="empty-provider">
                <span
                  className={
                    props.provider?.kind === 'cli'
                      ? 'provider-pip cli'
                      : 'provider-pip'
                  }
                />
                {props.provider?.name ?? 'Choose a provider'}
                {props.provider?.model && (
                  <span>· {props.provider.model}</span>
                )}
              </div>
            </div>
          </section>
          <TimelineJumpControl
            visible={false}
            announcement=""
            revision={jumpState.revision}
            controlsId={timelineId}
            onJump={jumpToLatest}
          />
        </div>
        <AssistantAnnouncement announcement={assistantAnnouncement} />
      </>
    )
  }

  const hiddenItemCount = Math.max(
    0,
    props.task.items.length - visibleCount
  )
  const visibleItems =
    hiddenItemCount > 0
      ? props.task.items.slice(hiddenItemCount)
      : props.task.items

  return (
    <>
      <div className="timeline-shell" data-task-id={props.task.id}>
        <section
          ref={timelineRef}
          id={timelineId}
          className="timeline"
          role="log"
          aria-label="Task conversation"
          aria-live="polite"
          aria-relevant="additions"
          tabIndex={-1}
          onScroll={(event) =>
            updateTimelineFollow(event.currentTarget)
          }
        >
          <div ref={timelineColumnRef} className="timeline-column">
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
                  props.task.runStatus === 'awaiting-approval' ||
                  Boolean(handoffPending)
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
          {visibleItems.map((item) => {
            const isStreaming =
              item.kind === 'message' &&
              item.role === 'assistant' &&
              item.id === lastAssistant?.id &&
              props.task.runStatus === 'running'
            const copyEnabled =
              item.kind === 'message' &&
              item.role === 'assistant' &&
              canCopyAssistantOutput(
                copyEligibility,
                item.id,
                item.content
              )

            return item.kind === 'message' ? (
              <article
                key={item.id}
                className={`message message-${item.role} ${
                  isStreaming ? 'message-streaming' : ''
                }`}
                aria-live={isStreaming ? 'off' : undefined}
                aria-busy={isStreaming || undefined}
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
                      <div className="message-author-identity">
                        Ground
                        <span>
                          {item.provider?.name ?? props.provider?.name}
                        </span>
                      </div>
                      {copyEnabled && (
                        <AssistantOutputCopyControl
                          taskId={props.task.id}
                          messageId={item.id}
                          content={item.content}
                          onCopy={requestAssistantOutputCopy}
                        />
                      )}
                    </div>
                  )}
                  {item.content ? (
                    <div className="markdown">
                      {item.role === 'assistant' ? (
                        <AssistantMarkdown
                          taskId={props.task.id}
                          messageId={item.id}
                          content={item.content}
                          copyEnabled={copyEnabled}
                          onCopy={requestAssistantOutputCopy}
                        />
                      ) : (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ children }) => (
                              <span className="markdown-link">{children}</span>
                            )
                          }}
                        >
                          {item.content}
                        </ReactMarkdown>
                      )}
                      {item.id === lastAssistant?.id &&
                        props.task.runStatus === 'running' && (
                          <span className="stream-caret" />
                        )}
                    </div>
                  ) : (
                    <div className="thinking-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                  {handoffSource?.assistantMessageId === item.id && (
                    <div className="ask-agent-handoff">
                      <div>
                        <strong>Ready to implement?</strong>
                        <span id={handoffDescriptionId}>
                          Switches this task to Agent and prepares an editable
                          draft. Nothing runs until you send it.
                        </span>
                      </div>
                      <button
                        ref={handoffButtonRef}
                        type="button"
                        aria-describedby={handoffDescriptionId}
                        disabled={handoffPending === item.id}
                        onClick={() =>
                          requestAgentHandoff(handoffSource)
                        }
                      >
                        <Bot size={14} aria-hidden="true" />
                        {handoffPending === item.id
                          ? 'Preparing Agent draft…'
                          : 'Continue in Agent'}
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
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
          })}
          {props.task.runStatus === 'awaiting-approval' && (
            <div className="awaiting-note">
              <CircleDot size={12} />
              Waiting for your approval
            </div>
          )}
          </div>
        </section>
        <TimelineJumpControl
          visible={jumpVisible}
          announcement={jumpAnnouncement}
          revision={jumpState.revision}
          controlsId={timelineId}
          onJump={jumpToLatest}
          buttonRef={jumpButtonRef}
        />
        <AssistantOutputCopyStatus feedback={visibleCopyFeedback} />
      </div>
      <div
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {handoffStatus}
      </div>
      <AssistantAnnouncement announcement={assistantAnnouncement} />
    </>
  )
}

export function TimelineJumpControl(props: {
  visible: boolean
  announcement: string
  revision: number
  controlsId: string
  onJump: () => void
  buttonRef?: Ref<HTMLButtonElement>
}): React.JSX.Element {
  return (
    <>
      {props.visible && (
        <button
          className="timeline-jump-latest"
          type="button"
          aria-controls={props.controlsId}
          onClick={props.onJump}
          ref={props.buttonRef}
        >
          <ArrowDown size={14} aria-hidden="true" />
          Jump to latest
        </button>
      )}
      <div
        className="visually-hidden timeline-jump-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span key={props.revision}>{props.announcement}</span>
      </div>
    </>
  )
}

export function AssistantOutputCopyControl(props: {
  taskId: string
  messageId: string
  content: string
  onCopy: (input: CopyAssistantOutputInput) => void
}): React.JSX.Element {
  return (
    <div className="assistant-output-copy">
      <button
        className="assistant-output-copy-button"
        type="button"
        aria-label={ASSISTANT_RESPONSE_COPY_LABEL}
        title={ASSISTANT_RESPONSE_COPY_LABEL}
        onClick={() =>
          props.onCopy({
            taskId: props.taskId,
            messageId: props.messageId,
            expectedContent: props.content,
            target: { kind: 'response' }
          })
        }
      >
        <Copy size={13} aria-hidden="true" />
        Copy response
      </button>
    </div>
  )
}

const AssistantMarkdown = memo(function AssistantMarkdown(props: {
  taskId: string
  messageId: string
  content: string
  copyEnabled: boolean
  onCopy: (input: CopyAssistantOutputInput) => void
}): React.JSX.Element {
  const blocks = props.copyEnabled
    ? fencedAssistantCodeBlocks(props.content)
    : []
  const blockByOffsets = new Map(
    blocks.map((block, index) => [
      `${block.startOffset}:${block.endOffset}`,
      { block, index }
    ])
  )

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children }) => (
          <span className="markdown-link">{children}</span>
        ),
        pre: ({ node, children }) => {
          const startOffset = node?.position?.start.offset
          const endOffset = node?.position?.end.offset
          const match =
            typeof startOffset === 'number' &&
            typeof endOffset === 'number'
              ? blockByOffsets.get(`${startOffset}:${endOffset}`)
              : undefined
          if (!match) return <pre>{children}</pre>
          return (
            <AssistantCodeBlock
              taskId={props.taskId}
              messageId={props.messageId}
              content={props.content}
              block={match.block}
              index={match.index}
              onCopy={props.onCopy}
            >
              {children}
            </AssistantCodeBlock>
          )
        }
      }}
    >
      {props.content}
    </ReactMarkdown>
  )
})

function AssistantCodeBlock(props: {
  taskId: string
  messageId: string
  content: string
  block: FencedAssistantCodeBlock
  index: number
  onCopy: (input: CopyAssistantOutputInput) => void
  children: React.ReactNode
}): React.JSX.Element {
  const label = `${ASSISTANT_CODE_COPY_LABEL} ${props.index + 1}`
  return (
    <div className="assistant-code-block">
      <div className="assistant-code-block-toolbar">
        <span>Code</span>
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={() =>
            props.onCopy({
              taskId: props.taskId,
              messageId: props.messageId,
              expectedContent: props.content,
              target: {
                kind: 'code',
                startOffset: props.block.startOffset,
                endOffset: props.block.endOffset
              }
            })
          }
        >
          <Copy size={12} aria-hidden="true" />
          Copy code
        </button>
      </div>
      <pre>{props.children}</pre>
    </div>
  )
}

function AssistantOutputCopyStatus(props: {
  feedback: AssistantOutputCopyFeedback | undefined
}): React.JSX.Element {
  const feedback = props.feedback
  const status = feedback
    ? assistantOutputCopyStatus(
        feedback.phase,
        feedback.request.input.target
      )
    : ''
  return (
    <>
      {feedback && (
        <div
          className={`assistant-output-copy-feedback ${feedback.phase}`}
          aria-hidden="true"
        >
          {feedback.phase === 'copied' ? (
            <Check size={13} aria-hidden="true" />
          ) : feedback.phase === 'failed' ? (
            <X size={13} aria-hidden="true" />
          ) : (
            <Copy size={13} aria-hidden="true" />
          )}
          <span>{status}</span>
        </div>
      )}
      <div
        className="visually-hidden assistant-output-copy-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span key={feedback?.revision ?? 0}>{status}</span>
      </div>
    </>
  )
}

function AssistantAnnouncement(props: {
  announcement: AssistantAnnouncementState
}): React.JSX.Element {
  return (
    <div
      className="visually-hidden assistant-announcement"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-relevant="additions text"
    >
      <span key={props.announcement.revision}>
        {props.announcement.text}
      </span>
    </div>
  )
}

function ActivityCard(props: {
  item: DesktopActivityItem
  onResolve: (approved: boolean) => Promise<void>
}): React.JSX.Element {
  const { item } = props
  const failureGuidance = providerFailureGuidance(item.failureKind)
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
          {failureGuidance && (
            <section
              className="provider-failure-guidance"
              aria-label="Provider failure guidance"
            >
              <strong>{failureGuidance.title}</strong>
              <p>{failureGuidance.correctiveGuidance}</p>
            </section>
          )}
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

function StatusIcon({
  status
}: {
  status: DesktopActivityItem['status']
}): React.JSX.Element {
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

function activityStatusLabel(status: DesktopActivityItem['status']): string {
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
