import { useCallback, useEffect, useRef, useState } from 'react'
import { CirclePlus, RefreshCw, SquareTerminal, Trash2 } from 'lucide-react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type {
  TerminalEvent,
  TerminalSessionInfo
} from '../../../shared/types'
import { desktop } from '../lib/desktop'

interface TerminalPanelProps {
  taskId: string
  workspaceReady: boolean
  onError: (error: unknown) => void
}

type TerminalStatus =
  | 'workspace-required'
  | 'connecting'
  | 'connected'
  | 'idle'
  | 'error'

type TerminalAction = 'new' | 'switch' | 'restart' | 'kill'

interface TerminalAttachment {
  sessionId: string
  attachmentId: string
}

interface AcquiredTerminal {
  session?: TerminalSessionInfo
  sessions: TerminalSessionInfo[]
}

const MIN_COLS = 20
const MAX_COLS = 500
const MIN_ROWS = 5
const MAX_ROWS = 300
const INPUT_CHUNK_CHARS = 16_000

// React Strict Mode mounts effects twice in development. Sharing only an in-flight
// acquisition prevents duplicate native launch prompts or duplicate shells.
const taskAcquisitions = new Map<string, Promise<AcquiredTerminal>>()

function proposedDimensions(
  fitAddon: FitAddon | undefined
): { cols: number; rows: number } | undefined {
  const dimensions = fitAddon?.proposeDimensions()
  if (
    !dimensions ||
    dimensions.cols < MIN_COLS ||
    dimensions.rows < MIN_ROWS
  ) {
    return undefined
  }
  return {
    cols: Math.min(MAX_COLS, dimensions.cols),
    rows: Math.min(MAX_ROWS, dimensions.rows)
  }
}

function sortedSessions(
  sessions: readonly TerminalSessionInfo[]
): TerminalSessionInfo[] {
  return [...sessions].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )
}

function acquireTaskTerminal(
  taskId: string,
  dimensions: { cols?: number; rows?: number }
): Promise<AcquiredTerminal> {
  const pending = taskAcquisitions.get(taskId)
  if (pending) return pending

  const acquisition = (async (): Promise<AcquiredTerminal> => {
    const sessions = sortedSessions(await desktop.listTerminals(taskId))
    const existing = sessions.at(-1)
    if (existing) return { session: existing, sessions }

    const created = await desktop.createTerminal(taskId, dimensions)
    return {
      session: created,
      sessions: created ? [created] : []
    }
  })()
  taskAcquisitions.set(taskId, acquisition)
  const release = (): void => {
    if (taskAcquisitions.get(taskId) === acquisition) {
      taskAcquisitions.delete(taskId)
    }
  }
  void acquisition.then(release, release)
  return acquisition
}

function exitDescription(event: Extract<TerminalEvent, { type: 'exit' }>): string {
  if (event.reason === 'disposed' || event.reason === 'service-disposed') {
    return 'Terminal closed'
  }
  if (event.signal !== undefined) return `Process exited (signal ${event.signal})`
  return `Process exited with code ${event.exitCode ?? 'unknown'}`
}

function statusLabel(status: TerminalStatus): string {
  switch (status) {
    case 'workspace-required':
      return 'Workspace required'
    case 'connecting':
      return 'Connecting'
    case 'connected':
      return 'Connected'
    case 'idle':
      return 'No active terminal'
    case 'error':
      return 'Connection error'
  }
}

export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | undefined>(undefined)
  const fitAddonRef = useRef<FitAddon | undefined>(undefined)
  const attachmentRef = useRef<TerminalAttachment | undefined>(undefined)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const sessionRef = useRef<TerminalSessionInfo | undefined>(undefined)
  const sessionsRef = useRef<TerminalSessionInfo[]>([])
  const mountedRef = useRef(false)
  const operationGenerationRef = useRef(0)
  const resizeFrameRef = useRef<number | undefined>(undefined)
  const actionRef = useRef<TerminalAction | undefined>(undefined)
  const lastResizeRef = useRef<{
    sessionId: string
    cols: number
    rows: number
  } | undefined>(undefined)
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve())
  const onErrorRef = useRef(props.onError)

  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [session, setSession] = useState<TerminalSessionInfo>()
  const [status, setStatus] = useState<TerminalStatus>(
    props.workspaceReady ? 'connecting' : 'workspace-required'
  )
  const [action, setAction] = useState<TerminalAction>()

  useEffect(() => {
    onErrorRef.current = props.onError
  }, [props.onError])

  const reportError = useCallback((error: unknown): void => {
    onErrorRef.current(error)
  }, [])

  const replaceSessions = useCallback(
    (next: readonly TerminalSessionInfo[]): void => {
      const sorted = sortedSessions(next)
      sessionsRef.current = sorted
      setSessions(sorted)
    },
    []
  )

  const resetView = useCallback((): void => {
    terminalRef.current?.reset()
    terminalRef.current?.clear()
  }, [])

  const clearActive = useCallback((): void => {
    attachmentRef.current = undefined
    activeSessionIdRef.current = undefined
    sessionRef.current = undefined
    lastResizeRef.current = undefined
    setSession(undefined)
  }, [])

  const detachAttachment = useCallback(
    async (
      attachment: TerminalAttachment,
      reportFailure = true
    ): Promise<void> => {
      try {
        await desktop.detachTerminal(
          attachment.sessionId,
          attachment.attachmentId
        )
      } catch (error) {
        if (reportFailure) reportError(error)
      }
    },
    [reportError]
  )

  const fitAndResize = useCallback(
    (force = false): void => {
      const terminal = terminalRef.current
      const dimensions = proposedDimensions(fitAddonRef.current)
      if (!terminal || !dimensions) return

      if (
        terminal.cols !== dimensions.cols ||
        terminal.rows !== dimensions.rows
      ) {
        terminal.resize(dimensions.cols, dimensions.rows)
      }

      const attachment = attachmentRef.current
      if (!attachment) return
      const previous = lastResizeRef.current
      if (
        !force &&
        previous?.sessionId === attachment.sessionId &&
        previous.cols === dimensions.cols &&
        previous.rows === dimensions.rows
      ) {
        return
      }
      lastResizeRef.current = {
        sessionId: attachment.sessionId,
        ...dimensions
      }
      void desktop
        .terminalResize(
          attachment.sessionId,
          attachment.attachmentId,
          dimensions
        )
        .catch((error) => {
          if (
            attachmentRef.current?.attachmentId === attachment.attachmentId
          ) {
            lastResizeRef.current = undefined
            reportError(error)
          }
        })
    },
    [reportError]
  )

  const scheduleFit = useCallback((): void => {
    if (resizeFrameRef.current !== undefined) {
      window.cancelAnimationFrame(resizeFrameRef.current)
    }
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = undefined
      fitAndResize()
    })
  }, [fitAndResize])

  const attachSession = useCallback(
    async (
      nextSession: TerminalSessionInfo,
      generation: number
    ): Promise<void> => {
      const previous = attachmentRef.current
      attachmentRef.current = undefined
      activeSessionIdRef.current = undefined
      if (previous) await detachAttachment(previous)

      if (
        !mountedRef.current ||
        operationGenerationRef.current !== generation
      ) {
        return
      }

      activeSessionIdRef.current = nextSession.id
      sessionRef.current = nextSession
      lastResizeRef.current = undefined
      setSession(nextSession)
      setStatus('connecting')
      resetView()

      try {
        const { attachmentId } = await desktop.attachTerminal(
          props.taskId,
          nextSession.id
        )
        const attachment = {
          sessionId: nextSession.id,
          attachmentId
        }
        if (
          !mountedRef.current ||
          operationGenerationRef.current !== generation ||
          activeSessionIdRef.current !== nextSession.id
        ) {
          await detachAttachment(attachment, false)
          return
        }
        attachmentRef.current = attachment
        setStatus('connected')
        fitAndResize(true)
        terminalRef.current?.focus()
      } catch (error) {
        if (
          mountedRef.current &&
          operationGenerationRef.current === generation &&
          activeSessionIdRef.current === nextSession.id
        ) {
          clearActive()
          setStatus('error')
        }
        throw error
      }
    },
    [
      clearActive,
      detachAttachment,
      fitAndResize,
      props.taskId,
      resetView
    ]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    mountedRef.current = true
    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: !reduceMotion,
      cursorStyle: 'block',
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      macOptionClickForcesSelection: true,
      macOptionIsMeta: true,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
      screenReaderMode: true,
      scrollback: 5_000,
      smoothScrollDuration: reduceMotion ? 0 : 90,
      theme: {
        background: '#10110f',
        foreground: '#e7e7df',
        cursor: '#d5ff55',
        cursorAccent: '#10110f',
        selectionBackground: '#53662999',
        black: '#161713',
        red: '#ff6b68',
        green: '#b8df62',
        yellow: '#e6c766',
        blue: '#72a7ff',
        magenta: '#c891ff',
        cyan: '#73d6cf',
        white: '#e7e7df',
        brightBlack: '#777a70',
        brightRed: '#ff928f',
        brightGreen: '#d5ff82',
        brightYellow: '#ffe18b',
        brightBlue: '#9fc1ff',
        brightMagenta: '#ddb5ff',
        brightCyan: '#9cebe5',
        brightWhite: '#ffffff'
      }
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      try {
        const url = new URL(uri)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          window.open(url.toString(), '_blank', 'noopener,noreferrer')
        }
      } catch {
        // Terminal output is untrusted; malformed links are inert.
      }
    })
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(host)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const inputListener = terminal.onData((data) => {
      const attachment = attachmentRef.current
      if (!attachment || data.length === 0) return
      for (let offset = 0; offset < data.length; offset += INPUT_CHUNK_CHARS) {
        const chunk = data.slice(offset, offset + INPUT_CHUNK_CHARS)
        inputQueueRef.current = inputQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            if (
              attachmentRef.current?.attachmentId !== attachment.attachmentId
            ) {
              return
            }
            await desktop.terminalInput(
              attachment.sessionId,
              attachment.attachmentId,
              chunk
            )
          })
          .catch((error) => {
            if (
              attachmentRef.current?.attachmentId === attachment.attachmentId
            ) {
              reportError(error)
            }
          })
      }
    })

    const unsubscribe = desktop.onTerminalEvent((event) => {
      if (event.type === 'exit') {
        replaceSessions(
          sessionsRef.current.filter((candidate) => candidate.id !== event.sessionId)
        )
      }
      if (event.sessionId !== activeSessionIdRef.current) return
      if (event.type === 'data') {
        terminal.write(event.data)
        return
      }

      const description = exitDescription(event)
      clearActive()
      setStatus('idle')
      terminal.write(`\r\n\u001b[90m[${description}]\u001b[0m\r\n`)
    })

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => scheduleFit())
    resizeObserver?.observe(host)
    scheduleFit()

    return () => {
      mountedRef.current = false
      actionRef.current = undefined
      const attachment = attachmentRef.current
      clearActive()
      terminalRef.current = undefined
      fitAddonRef.current = undefined
      if (resizeFrameRef.current !== undefined) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = undefined
      }
      resizeObserver?.disconnect()
      unsubscribe()
      inputListener.dispose()
      terminal.dispose()
      if (attachment) {
        void desktop
          .detachTerminal(attachment.sessionId, attachment.attachmentId)
          .catch(() => undefined)
      }
    }
  }, [
    clearActive,
    replaceSessions,
    reportError,
    scheduleFit
  ])

  useEffect(() => {
    const generation = (operationGenerationRef.current += 1)
    const previous = attachmentRef.current
    clearActive()
    actionRef.current = undefined
    setAction(undefined)
    replaceSessions([])
    resetView()

    if (!props.workspaceReady) {
      setStatus('workspace-required')
      if (previous) void detachAttachment(previous)
      return () => {
        operationGenerationRef.current += 1
      }
    }

    setStatus('connecting')
    const dimensions = proposedDimensions(fitAddonRef.current) ?? {}
    void (async () => {
      if (previous) await detachAttachment(previous)
      try {
        const acquired = await acquireTaskTerminal(props.taskId, dimensions)
        if (
          !mountedRef.current ||
          operationGenerationRef.current !== generation
        ) {
          return
        }
        replaceSessions(acquired.sessions)
        if (!acquired.session) {
          setStatus('idle')
          return
        }
        await attachSession(acquired.session, generation)
      } catch (error) {
        if (
          mountedRef.current &&
          operationGenerationRef.current === generation
        ) {
          setStatus('error')
          reportError(error)
        }
      }
    })()

    return () => {
      operationGenerationRef.current += 1
    }
  }, [
    attachSession,
    clearActive,
    detachAttachment,
    props.taskId,
    props.workspaceReady,
    replaceSessions,
    reportError,
    resetView
  ])

  const switchSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const next = sessionsRef.current.find(
        (candidate) => candidate.id === sessionId
      )
      if (!next || next.id === sessionRef.current?.id || actionRef.current) return
      const generation = (operationGenerationRef.current += 1)
      actionRef.current = 'switch'
      setAction('switch')
      try {
        await attachSession(next, generation)
      } catch (error) {
        if (
          mountedRef.current &&
          operationGenerationRef.current === generation
        ) {
          replaceSessions(
            sessionsRef.current.filter((candidate) => candidate.id !== next.id)
          )
          reportError(error)
        }
      } finally {
        if (
          mountedRef.current &&
          operationGenerationRef.current === generation
        ) {
          actionRef.current = undefined
          setAction(undefined)
        }
      }
    },
    [attachSession, replaceSessions, reportError]
  )

  const createNew = useCallback(async (): Promise<void> => {
    if (!props.workspaceReady || actionRef.current) return
    const generation = (operationGenerationRef.current += 1)
    actionRef.current = 'new'
    setAction('new')
    try {
      const next = await desktop.createTerminal(
        props.taskId,
        proposedDimensions(fitAddonRef.current) ?? {}
      )
      if (
        !next ||
        !mountedRef.current ||
        operationGenerationRef.current !== generation
      ) {
        return
      }
      replaceSessions([...sessionsRef.current, next])
      await attachSession(next, generation)
    } catch (error) {
      if (
        mountedRef.current &&
        operationGenerationRef.current === generation
      ) {
        setStatus(sessionRef.current ? 'connected' : 'error')
        reportError(error)
      }
    } finally {
      if (
        mountedRef.current &&
        operationGenerationRef.current === generation
      ) {
        actionRef.current = undefined
        setAction(undefined)
      }
    }
  }, [
    attachSession,
    props.taskId,
    props.workspaceReady,
    replaceSessions,
    reportError
  ])

  const restart = useCallback(async (): Promise<void> => {
    if (!props.workspaceReady || actionRef.current) return
    const current = attachmentRef.current
    const currentSessionId = sessionRef.current?.id
    const generation = (operationGenerationRef.current += 1)
    actionRef.current = 'restart'
    setAction('restart')
    try {
      const next = await desktop.createTerminal(
        props.taskId,
        proposedDimensions(fitAddonRef.current) ?? {}
      )
      if (
        !next ||
        !mountedRef.current ||
        operationGenerationRef.current !== generation
      ) {
        return
      }
      replaceSessions([...sessionsRef.current, next])
      if (current && currentSessionId) {
        await desktop.terminalClose(
          current.sessionId,
          current.attachmentId
        )
        replaceSessions(
          sessionsRef.current.filter(
            (candidate) => candidate.id !== currentSessionId
          )
        )
      }
      await attachSession(next, generation)
    } catch (error) {
      if (
        mountedRef.current &&
        operationGenerationRef.current === generation
      ) {
        setStatus(sessionRef.current ? 'connected' : 'error')
        reportError(error)
      }
    } finally {
      if (
        mountedRef.current &&
        operationGenerationRef.current === generation
      ) {
        actionRef.current = undefined
        setAction(undefined)
      }
    }
  }, [
    attachSession,
    props.taskId,
    props.workspaceReady,
    replaceSessions,
    reportError
  ])

  const kill = useCallback(async (): Promise<void> => {
    const current = attachmentRef.current
    if (!current || actionRef.current) return
    const generation = (operationGenerationRef.current += 1)
    actionRef.current = 'kill'
    setAction('kill')
    try {
      await desktop.terminalClose(
        current.sessionId,
        current.attachmentId
      )
      if (
        !mountedRef.current ||
        operationGenerationRef.current !== generation
      ) {
        return
      }
      const remaining = sessionsRef.current.filter(
        (candidate) => candidate.id !== current.sessionId
      )
      replaceSessions(remaining)
      clearActive()
      const next = remaining.at(-1)
      if (next) await attachSession(next, generation)
      else setStatus('idle')
    } catch (error) {
      if (
        mountedRef.current &&
        operationGenerationRef.current === generation
      ) {
        reportError(error)
      }
    } finally {
      if (
        mountedRef.current &&
        operationGenerationRef.current === generation
      ) {
        actionRef.current = undefined
        setAction(undefined)
      }
    }
  }, [attachSession, clearActive, replaceSessions, reportError])

  const label = statusLabel(status)
  const busy = action !== undefined

  return (
    <section className="terminal-panel" aria-label="Workspace terminal">
      <header className="terminal-toolbar">
        <div className="terminal-toolbar-heading">
          <SquareTerminal size={15} aria-hidden="true" />
          <h2>Terminal</h2>
          <select
            className="terminal-session-select"
            aria-label="Active terminal session"
            value={session?.id ?? ''}
            disabled={!props.workspaceReady || busy || sessions.length === 0}
            onChange={(event) => void switchSession(event.target.value)}
          >
            <option value="">
              {sessions.length === 0 ? 'No terminals' : 'Select terminal'}
            </option>
            {sessions.map((candidate, index) => (
              <option key={candidate.id} value={candidate.id}>
                Terminal {index + 1} · PID {candidate.pid}
              </option>
            ))}
          </select>
          <span
            className={`terminal-status terminal-status-${status}`}
            role="status"
            aria-live="polite"
          >
            <span className="terminal-status-dot" aria-hidden="true" />
            {label}
          </span>
          {session && (
            <span className="terminal-process" title={`Process ${session.pid}`}>
              PID {session.pid}
            </span>
          )}
        </div>

        <div className="terminal-toolbar-actions" aria-label="Terminal actions">
          <button
            className="terminal-action"
            type="button"
            onClick={() => void createNew()}
            disabled={!props.workspaceReady || busy}
            aria-label="Create a new terminal"
            title="New terminal"
          >
            <CirclePlus size={14} aria-hidden="true" />
            <span>New</span>
          </button>
          <button
            className="terminal-action"
            type="button"
            onClick={() => void restart()}
            disabled={!session || busy}
            aria-label="Restart the terminal"
            title="Start a replacement, then close this terminal"
          >
            <RefreshCw
              className={action === 'restart' ? 'terminal-action-spinning' : ''}
              size={14}
              aria-hidden="true"
            />
            <span>Restart</span>
          </button>
          <button
            className="terminal-action terminal-action-danger"
            type="button"
            onClick={() => void kill()}
            disabled={!session || busy}
            aria-label="Kill the terminal process"
            title="Kill terminal"
          >
            <Trash2 size={14} aria-hidden="true" />
            <span>Kill</span>
          </button>
        </div>
      </header>

      <div className="terminal-stage">
        <div
          ref={hostRef}
          className="terminal-xterm-host"
          onMouseDown={() => terminalRef.current?.focus()}
          aria-label="Interactive terminal"
        />
        {!props.workspaceReady && (
          <div className="terminal-empty" role="status">
            <SquareTerminal size={24} aria-hidden="true" />
            <p>Choose a workspace to open a terminal.</p>
          </div>
        )}
        {props.workspaceReady && status === 'idle' && !session && (
          <div className="terminal-empty" role="status">
            <SquareTerminal size={24} aria-hidden="true" />
            <p>
              {sessions.length > 0
                ? 'Select a running terminal above.'
                : 'No terminal is running.'}
            </p>
            {sessions.length === 0 && (
              <button
                type="button"
                onClick={() => void createNew()}
                disabled={busy}
              >
                New terminal
              </button>
            )}
          </div>
        )}
        {props.workspaceReady && status === 'error' && (
          <div className="terminal-empty terminal-error" role="alert">
            <p>The terminal could not be attached.</p>
            <button
              type="button"
              onClick={() => void createNew()}
              disabled={busy}
            >
              New terminal
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
