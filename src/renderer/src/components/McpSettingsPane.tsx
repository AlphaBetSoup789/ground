import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Check,
  CircleAlert,
  Cloud,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import type {
  McpServerDraft,
  McpServerProfile,
  McpServerStatus,
  McpToolSummary
} from '../../../shared/types'
import { desktop } from '../lib/desktop'

interface McpSettingsPaneProps {
  servers: McpServerProfile[]
  onSaved: () => Promise<void>
  onError: (error: unknown) => void
}

type McpOperation =
  | 'save'
  | 'toggle'
  | 'connect'
  | 'trust'
  | 'delete'

interface BusyState {
  operation: McpOperation
  serverId?: string
}

function blankDraft(
  transport: McpServerDraft['transport'] = 'streamable-http'
): McpServerDraft {
  if (transport === 'stdio') {
    return {
      name: '',
      namespace: '',
      enabled: true,
      transport,
      command: '',
      args: []
    }
  }
  return {
    name: '',
    namespace: '',
    enabled: true,
    transport,
    url: ''
  }
}

function profileToDraft(profile: McpServerProfile): McpServerDraft {
  const common = {
    id: profile.id,
    name: profile.name,
    namespace: profile.namespace,
    enabled: profile.enabled
  }
  if (profile.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: profile.command,
      args: [...profile.args]
    }
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: profile.url
  }
}

function transportLabel(profile: McpServerProfile): string {
  return profile.transport === 'stdio' ? 'Local stdio' : 'Streamable HTTP'
}

function statusLabel(
  status: McpServerStatus | undefined,
  enabled: boolean
): string {
  if (!enabled) return 'Disabled'
  if (!status) return 'Checking'
  switch (status.connection) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'error':
      return 'Connection error'
    case 'disconnected':
      return 'Disconnected'
  }
}

function statusClass(
  status: McpServerStatus | undefined,
  enabled: boolean
): string {
  if (!enabled) return 'disabled'
  return status?.connection ?? 'loading'
}

function trustLabel(status: McpToolSummary['trustStatus']): string {
  switch (status) {
    case 'approved':
      return 'Trusted'
    case 'pending':
      return 'Review required'
    case 'changed':
      return 'Definition changed'
  }
}

function draftCanSave(draft: McpServerDraft): boolean {
  if (!draft.name.trim()) return false
  if (draft.transport === 'stdio') return Boolean(draft.command?.trim())
  return Boolean(draft.url?.trim())
}

function sameFingerprintSet(
  status: McpServerStatus | undefined
): boolean {
  if (!status) return false
  const entries = Object.entries(status.fingerprints)
  if (entries.length !== status.tools.length) return false
  return status.tools.every(
    (tool) => status.fingerprints[tool.name] === tool.fingerprint
  )
}

function serverRevision(servers: McpServerProfile[]): string {
  return servers
    .map((server) => `${server.id}:${server.updatedAt}:${server.enabled}`)
    .join('|')
}

export function McpSettingsPane(
  props: McpSettingsPaneProps
): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    props.servers[0]?.id
  )
  const [draft, setDraft] = useState<McpServerDraft>(() =>
    props.servers[0] ? profileToDraft(props.servers[0]) : blankDraft()
  )
  const [statuses, setStatuses] = useState<
    Record<string, McpServerStatus>
  >({})
  const [busy, setBusy] = useState<BusyState>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmTrust, setConfirmTrust] = useState(false)
  const mountedRef = useRef(false)
  const busyRef = useRef<BusyState | undefined>(undefined)
  const statusRequestRef = useRef(0)
  const onErrorRef = useRef(props.onError)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const trustTriggerRef = useRef<HTMLButtonElement>(null)
  const trustCancelRef = useRef<HTMLButtonElement>(null)
  const revision = useMemo(
    () => serverRevision(props.servers),
    [props.servers]
  )

  const selectedServer = useMemo(
    () => props.servers.find((server) => server.id === selectedId),
    [props.servers, selectedId]
  )
  const selectedStatus = selectedId ? statuses[selectedId] : undefined
  const selectedFingerprintRevision = selectedStatus
    ? JSON.stringify({
        fingerprints: Object.entries(selectedStatus.fingerprints).sort(
          ([left], [right]) => left.localeCompare(right)
        ),
        drift: selectedStatus.drift
      })
    : ''
  const toolsNeedingReview =
    selectedStatus?.tools.filter((tool) => tool.trustStatus !== 'approved') ??
    []
  const reviewNeeded =
    toolsNeedingReview.length > 0 ||
    (selectedStatus?.drift.added.length ?? 0) > 0 ||
    (selectedStatus?.drift.changed.length ?? 0) > 0 ||
    (selectedStatus?.drift.removed.length ?? 0) > 0
  const reviewChangeCount = new Set([
    ...toolsNeedingReview.map((tool) => tool.name),
    ...(selectedStatus?.drift.added ?? []),
    ...(selectedStatus?.drift.changed ?? []),
    ...(selectedStatus?.drift.removed ?? [])
  ]).size
  const fingerprintsMatchReview = sameFingerprintSet(selectedStatus)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      busyRef.current = undefined
      statusRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    onErrorRef.current = props.onError
  }, [props.onError])

  const reportError = useCallback((error: unknown): void => {
    onErrorRef.current(error)
  }, [])

  const replaceStatus = useCallback((status: McpServerStatus): void => {
    setStatuses((current) => ({ ...current, [status.id]: status }))
  }, [])

  const refreshStatuses = useCallback(async (): Promise<void> => {
    const request = (statusRequestRef.current += 1)
    try {
      const next = await desktop.getMcpServerStatuses()
      if (!mountedRef.current || statusRequestRef.current !== request) return
      setStatuses(
        Object.fromEntries(next.map((status) => [status.id, status]))
      )
    } catch (error) {
      if (mountedRef.current && statusRequestRef.current === request) {
        reportError(error)
      }
    }
  }, [reportError])

  useEffect(() => {
    void refreshStatuses()
  }, [refreshStatuses, revision])

  useEffect(() => {
    if (!selectedId) return
    if (props.servers.some((server) => server.id === selectedId)) return
    const fallback = props.servers[0]
    setSelectedId(fallback?.id)
    setDraft(fallback ? profileToDraft(fallback) : blankDraft())
    setConfirmDelete(false)
    setConfirmTrust(false)
  }, [props.servers, selectedId])

  useEffect(() => {
    setConfirmTrust(false)
  }, [selectedFingerprintRevision, selectedId])

  useEffect(() => {
    if (confirmDelete) {
      window.requestAnimationFrame(() => deleteCancelRef.current?.focus())
    }
  }, [confirmDelete])

  useEffect(() => {
    if (confirmTrust) {
      window.requestAnimationFrame(() => trustCancelRef.current?.focus())
    }
  }, [confirmTrust])

  const beginOperation = (
    operation: McpOperation,
    serverId?: string
  ): boolean => {
    if (busyRef.current) return false
    const next = { operation, ...(serverId ? { serverId } : {}) }
    busyRef.current = next
    setBusy(next)
    return true
  }

  const finishOperation = (): void => {
    busyRef.current = undefined
    if (mountedRef.current) setBusy(undefined)
  }

  const selectServer = (server: McpServerProfile): void => {
    if (busyRef.current) return
    setSelectedId(server.id)
    setDraft(profileToDraft(server))
    setConfirmDelete(false)
    setConfirmTrust(false)
  }

  const beginNew = (): void => {
    if (busyRef.current) return
    setSelectedId(undefined)
    setDraft(blankDraft())
    setConfirmDelete(false)
    setConfirmTrust(false)
  }

  const updateDraft = (patch: Partial<McpServerDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setConfirmTrust(false)
  }

  const changeTransport = (
    transport: McpServerDraft['transport']
  ): void => {
    setDraft((current) => ({
      id: current.id,
      name: current.name,
      namespace: current.namespace,
      enabled: current.enabled,
      transport,
      ...(transport === 'stdio'
        ? { command: '', args: [] }
        : { url: '' })
    }))
    setConfirmTrust(false)
  }

  const save = async (): Promise<void> => {
    if (!draftCanSave(draft) || !beginOperation('save', selectedId)) return
    try {
      const saved = await desktop.saveMcpServer({
        ...draft,
        name: draft.name.trim(),
        namespace: draft.namespace?.trim() || undefined,
        ...(draft.transport === 'stdio'
          ? {
              command: draft.command?.trim(),
              args: [...(draft.args ?? [])]
            }
          : { url: draft.url?.trim() })
      })
      if (mountedRef.current) {
        setSelectedId(saved.id)
        setDraft(profileToDraft(saved))
        setConfirmDelete(false)
        setConfirmTrust(false)
      }
      await props.onSaved()
      if (mountedRef.current) await refreshStatuses()
    } catch (error) {
      if (mountedRef.current) reportError(error)
    } finally {
      finishOperation()
    }
  }

  const toggleEnabled = async (
    server: McpServerProfile,
    enabled: boolean
  ): Promise<void> => {
    if (!beginOperation('toggle', server.id)) return
    try {
      const saved = await desktop.saveMcpServer({
        ...profileToDraft(server),
        enabled
      })
      if (mountedRef.current && selectedId === saved.id) {
        setDraft(profileToDraft(saved))
      }
      await props.onSaved()
      if (mountedRef.current) await refreshStatuses()
    } catch (error) {
      if (mountedRef.current) reportError(error)
    } finally {
      finishOperation()
    }
  }

  const connect = async (server: McpServerProfile): Promise<void> => {
    if (!server.enabled || !beginOperation('connect', server.id)) return
    setStatuses((current) => ({
      ...current,
      [server.id]: {
        id: server.id,
        connection: 'connecting',
        tools: current[server.id]?.tools ?? [],
        fingerprints: current[server.id]?.fingerprints ?? {},
        drift: current[server.id]?.drift ?? {
          added: [],
          removed: [],
          changed: []
        }
      }
    }))
    setConfirmTrust(false)
    try {
      const status = await desktop.connectMcpServer(server.id)
      if (mountedRef.current) replaceStatus(status)
    } catch (error) {
      if (mountedRef.current) reportError(error)
      await refreshStatuses()
    } finally {
      finishOperation()
    }
  }

  const trustCurrentDefinitions = async (): Promise<void> => {
    if (
      !selectedId ||
      !selectedStatus ||
      selectedStatus.connection !== 'connected' ||
      !reviewNeeded ||
      endpointChanged ||
      !fingerprintsMatchReview ||
      !confirmTrust ||
      !beginOperation('trust', selectedId)
    ) {
      return
    }

    // Snapshot exactly what is displayed. The main process independently rejects
    // this approval if discovery changes before the operation reaches it.
    const expectedFingerprints = Object.fromEntries(
      Object.entries(selectedStatus.fingerprints)
    )
    try {
      const status = await desktop.trustMcpTools(
        selectedId,
        expectedFingerprints
      )
      if (mountedRef.current) {
        replaceStatus(status)
        setConfirmTrust(false)
      }
      await props.onSaved()
    } catch (error) {
      if (mountedRef.current) reportError(error)
    } finally {
      finishOperation()
    }
  }

  const remove = async (): Promise<void> => {
    if (!selectedId || !confirmDelete || !beginOperation('delete', selectedId)) {
      return
    }
    const deletingId = selectedId
    try {
      await desktop.deleteMcpServer(deletingId)
      if (mountedRef.current) {
        setStatuses((current) => {
          const next = { ...current }
          delete next[deletingId]
          return next
        })
        const fallback = props.servers.find(
          (server) => server.id !== deletingId
        )
        setSelectedId(fallback?.id)
        setDraft(fallback ? profileToDraft(fallback) : blankDraft())
        setConfirmDelete(false)
        setConfirmTrust(false)
      }
      await props.onSaved()
    } catch (error) {
      if (mountedRef.current) reportError(error)
    } finally {
      finishOperation()
    }
  }

  const selectedBusy =
    busy && busy.serverId === selectedId ? busy.operation : undefined
  const endpointChanged =
    selectedServer !== undefined &&
    (selectedServer.transport !== draft.transport ||
      selectedServer.namespace !== (draft.namespace?.trim() || selectedServer.namespace) ||
      (selectedServer.transport === 'streamable-http' &&
        draft.transport === 'streamable-http' &&
        selectedServer.url !== draft.url?.trim()) ||
      (selectedServer.transport === 'stdio' &&
        draft.transport === 'stdio' &&
        (selectedServer.command !== draft.command?.trim() ||
          JSON.stringify(selectedServer.args) !==
            JSON.stringify(draft.args ?? []))))

  return (
    <section
      className="mcp-pane"
      aria-labelledby="mcp-pane-title"
      aria-busy={Boolean(busy)}
    >
      <header className="mcp-header">
        <div>
          <span className="mcp-eyebrow">Model Context Protocol</span>
          <h2 id="mcp-pane-title">Tools and servers</h2>
          <p>
            Connect local or remote MCP servers, inspect every discovered tool,
            and approve definitions by fingerprint.
          </p>
        </div>
        <button
          className="mcp-add-button"
          type="button"
          onClick={beginNew}
          disabled={Boolean(busy)}
        >
          <Plus size={14} aria-hidden="true" />
          Add server
        </button>
      </header>

      <div className="mcp-layout">
        <aside className="mcp-server-list" aria-label="Configured MCP servers">
          {props.servers.length === 0 ? (
            <div className="mcp-server-list-empty">
              <Server size={20} aria-hidden="true" />
              <p>No MCP servers configured.</p>
              <button type="button" onClick={beginNew}>
                Add your first server
              </button>
            </div>
          ) : (
            props.servers.map((server) => {
              const status = statuses[server.id]
              const isSelected = selectedId === server.id
              const isBusy = busy?.serverId === server.id
              return (
                <article
                  className={`mcp-server-card ${isSelected ? 'mcp-selected' : ''}`}
                  key={server.id}
                >
                  <button
                    className="mcp-server-select"
                    type="button"
                    onClick={() => selectServer(server)}
                    aria-pressed={isSelected}
                  >
                    <span className="mcp-server-icon" aria-hidden="true">
                      {server.transport === 'stdio' ? (
                        <TerminalSquare size={15} />
                      ) : (
                        <Cloud size={15} />
                      )}
                    </span>
                    <span className="mcp-server-copy">
                      <strong>{server.name}</strong>
                      <small>{transportLabel(server)}</small>
                    </span>
                    <span
                      className={`mcp-connection-dot mcp-${statusClass(
                        status,
                        server.enabled
                      )}`}
                      title={statusLabel(status, server.enabled)}
                      role="img"
                      aria-label={statusLabel(status, server.enabled)}
                    />
                  </button>
                  <label className="mcp-enabled-toggle">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={server.enabled}
                      disabled={Boolean(busy)}
                      aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`}
                      onChange={(event) =>
                        void toggleEnabled(server, event.target.checked)
                      }
                    />
                    <span>{server.enabled ? 'Enabled' : 'Disabled'}</span>
                    {isBusy && busy?.operation === 'toggle' && (
                      <LoaderCircle
                        className="mcp-spin"
                        size={12}
                        aria-label="Saving"
                      />
                    )}
                  </label>
                </article>
              )
            })
          )}
        </aside>

        <div className="mcp-detail">
          <section
            className="mcp-editor"
            aria-labelledby="mcp-editor-title"
          >
            <div className="mcp-section-heading">
              <div>
                <span className="mcp-section-kicker">
                  {selectedServer ? 'Configuration' : 'New connection'}
                </span>
                <h3 id="mcp-editor-title">
                  {selectedServer
                    ? `Edit ${selectedServer.name}`
                    : 'Add an MCP server'}
                </h3>
              </div>
              {selectedServer && (
                <Pencil size={15} aria-hidden="true" />
              )}
            </div>

            <fieldset className="mcp-transport-picker">
              <legend>Transport</legend>
              <label
                className={
                  draft.transport === 'streamable-http'
                    ? 'mcp-transport-selected'
                    : ''
                }
              >
                <input
                  type="radio"
                  name="mcp-transport"
                  checked={draft.transport === 'streamable-http'}
                  onChange={() => changeTransport('streamable-http')}
                  disabled={Boolean(busy)}
                />
                <Cloud size={15} aria-hidden="true" />
                <span>
                  <strong>Remote</strong>
                  <small>Streamable HTTP</small>
                </span>
              </label>
              <label
                className={
                  draft.transport === 'stdio'
                    ? 'mcp-transport-selected'
                    : ''
                }
              >
                <input
                  type="radio"
                  name="mcp-transport"
                  checked={draft.transport === 'stdio'}
                  onChange={() => changeTransport('stdio')}
                  disabled={Boolean(busy)}
                />
                <TerminalSquare size={15} aria-hidden="true" />
                <span>
                  <strong>Local</strong>
                  <small>stdio process</small>
                </span>
              </label>
            </fieldset>

            <div className="mcp-form-grid">
              <label className="mcp-field">
                <span>Display name</span>
                <input
                  value={draft.name}
                  onChange={(event) =>
                    updateDraft({ name: event.target.value })
                  }
                  placeholder="Filesystem tools"
                  maxLength={128}
                  disabled={Boolean(busy)}
                  autoComplete="off"
                  required
                />
              </label>
              <label className="mcp-field">
                <span>Tool namespace</span>
                <input
                  value={draft.namespace ?? ''}
                  onChange={(event) =>
                    updateDraft({ namespace: event.target.value })
                  }
                  placeholder="Generated from the name"
                  maxLength={128}
                  disabled={Boolean(busy)}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <small>
                  Prefixes tool names so servers cannot silently collide.
                </small>
              </label>
            </div>

            {draft.transport === 'streamable-http' ? (
              <>
                <label className="mcp-field">
                  <span>Server URL</span>
                  <input
                    type="url"
                    inputMode="url"
                    value={draft.url ?? ''}
                    onChange={(event) =>
                      updateDraft({ url: event.target.value })
                    }
                    placeholder="https://mcp.example.com/mcp"
                    maxLength={2_000}
                    disabled={Boolean(busy)}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
                <div className="mcp-notice mcp-notice-info" role="note">
                  <CircleAlert size={15} aria-hidden="true" />
                  <p>
                    Ground currently supports unauthenticated Streamable HTTP
                    endpoints. Headers, bearer tokens, and OAuth sign-in are not
                    supported yet.
                  </p>
                </div>
              </>
            ) : (
              <>
                <label className="mcp-field">
                  <span>Executable</span>
                  <input
                    value={draft.command ?? ''}
                    onChange={(event) =>
                      updateDraft({ command: event.target.value })
                    }
                    placeholder="/absolute/path/to/mcp-server"
                    maxLength={8_192}
                    disabled={Boolean(busy)}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
                <label className="mcp-field">
                  <span>Arguments</span>
                  <textarea
                    value={(draft.args ?? []).join('\n')}
                    onChange={(event) =>
                      updateDraft({
                        args:
                          event.target.value === ''
                            ? []
                            : event.target.value.split('\n')
                      })
                    }
                    placeholder={'--mode\nworkspace'}
                    rows={4}
                    disabled={Boolean(busy)}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <small>
                    One argument per line. Ground launches the executable
                    directly without a shell.
                  </small>
                </label>
                <div className="mcp-notice mcp-notice-warning" role="note">
                  <ShieldAlert size={15} aria-hidden="true" />
                  <p>
                    Local stdio servers run with your operating-system user
                    permissions. MCP tool trust limits which discovered tools
                    agents may call; it is not a process sandbox.
                  </p>
                </div>
              </>
            )}

            <label className="mcp-editor-enabled">
              <input
                type="checkbox"
                role="switch"
                checked={draft.enabled ?? true}
                onChange={(event) =>
                  updateDraft({ enabled: event.target.checked })
                }
                disabled={Boolean(busy)}
              />
              <span>
                <strong>Enable this server</strong>
                <small>
                  Enabled servers may connect immediately after saving.
                </small>
              </span>
            </label>

            {endpointChanged && (
              <div className="mcp-notice mcp-notice-warning" role="status">
                <ShieldAlert size={15} aria-hidden="true" />
                <p>
                  This changes the server identity or launch configuration.
                  Existing tool trust will be cleared and every definition must
                  be reviewed again.
                </p>
              </div>
            )}

            <div className="mcp-editor-actions">
              <div className="mcp-delete-area">
                {selectedServer &&
                  (confirmDelete ? (
                    <div
                      className="mcp-delete-confirmation"
                      role="alert"
                      aria-live="assertive"
                    >
                      <span>
                        Delete {selectedServer.name} and its saved trust?
                      </span>
                      <button
                        ref={deleteCancelRef}
                        type="button"
                        onClick={() => {
                          setConfirmDelete(false)
                          window.requestAnimationFrame(() =>
                            deleteTriggerRef.current?.focus()
                          )
                        }}
                        disabled={Boolean(busy)}
                      >
                        Cancel
                      </button>
                      <button
                        className="mcp-delete-confirm"
                        type="button"
                        onClick={() => void remove()}
                        disabled={Boolean(busy)}
                      >
                        {selectedBusy === 'delete' ? (
                          <LoaderCircle
                            className="mcp-spin"
                            size={13}
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 size={13} aria-hidden="true" />
                        )}
                        Delete server
                      </button>
                    </div>
                  ) : (
                    <button
                      ref={deleteTriggerRef}
                      className="mcp-delete-button"
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      disabled={Boolean(busy)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      Delete
                    </button>
                  ))}
              </div>
              <button
                className="mcp-save-button"
                type="button"
                onClick={() => void save()}
                disabled={Boolean(busy) || !draftCanSave(draft)}
                aria-busy={selectedBusy === 'save'}
              >
                {selectedBusy === 'save' && (
                  <LoaderCircle
                    className="mcp-spin"
                    size={13}
                    aria-hidden="true"
                  />
                )}
                {selectedServer ? 'Save changes' : 'Add server'}
              </button>
            </div>
          </section>

          {selectedServer ? (
            <section
              className="mcp-runtime"
              aria-labelledby="mcp-runtime-title"
            >
              <div className="mcp-section-heading">
                <div>
                  <span className="mcp-section-kicker">Runtime</span>
                  <h3 id="mcp-runtime-title">Connection and tools</h3>
                </div>
                <span
                  className={`mcp-status-badge mcp-status-${statusClass(
                    selectedStatus,
                    selectedServer.enabled
                  )}`}
                  role="status"
                  aria-live="polite"
                >
                  <span aria-hidden="true" />
                  {statusLabel(selectedStatus, selectedServer.enabled)}
                </span>
              </div>

              <div className="mcp-runtime-summary">
                <div>
                  <strong>{selectedServer.namespace}</strong>
                  <small>
                    {selectedStatus?.serverInfo
                      ? `${selectedStatus.serverInfo.title ?? selectedStatus.serverInfo.name} · ${selectedStatus.serverInfo.version}`
                      : transportLabel(selectedServer)}
                  </small>
                </div>
                <button
                  className="mcp-connect-button"
                  type="button"
                  onClick={() => void connect(selectedServer)}
                  disabled={
                    Boolean(busy) ||
                    endpointChanged ||
                    !selectedServer.enabled ||
                    selectedStatus?.connection === 'connecting'
                  }
                >
                  {selectedBusy === 'connect' ||
                  selectedStatus?.connection === 'connecting' ? (
                    <LoaderCircle
                      className="mcp-spin"
                      size={13}
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw size={13} aria-hidden="true" />
                  )}
                  {selectedStatus?.connection === 'connected'
                    ? 'Reconnect and rediscover'
                    : 'Connect and discover'}
                </button>
              </div>

              {!selectedServer.enabled && (
                <div className="mcp-notice mcp-notice-info" role="status">
                  <CircleAlert size={15} aria-hidden="true" />
                  <p>Enable and save this server before connecting.</p>
                </div>
              )}

              {endpointChanged && (
                <div className="mcp-notice mcp-notice-info" role="status">
                  <CircleAlert size={15} aria-hidden="true" />
                  <p>
                    The runtime status below belongs to the saved
                    configuration. Save your identity or launch changes before
                    reconnecting or trusting tools.
                  </p>
                </div>
              )}

              {selectedStatus?.error && (
                <div className="mcp-notice mcp-notice-error" role="alert">
                  <CircleAlert size={15} aria-hidden="true" />
                  <div>
                    <strong>Server error</strong>
                    <p>{selectedStatus.error}</p>
                  </div>
                </div>
              )}

              {selectedStatus?.connection === 'connected' ? (
                <div className="mcp-tools">
                  <div className="mcp-tools-heading">
                    <div>
                      <Wrench size={14} aria-hidden="true" />
                      <strong>
                        {selectedStatus.tools.length}{' '}
                        {selectedStatus.tools.length === 1 ? 'tool' : 'tools'}{' '}
                        discovered
                      </strong>
                    </div>
                    {reviewNeeded ? (
                      <span className="mcp-review-count">
                        {reviewChangeCount}{' '}
                        {reviewChangeCount === 1 ? 'change' : 'changes'} to
                        review
                      </span>
                    ) : (
                      <span className="mcp-trusted-count">
                        <Check size={12} aria-hidden="true" />
                        Definitions trusted
                      </span>
                    )}
                  </div>

                  {selectedStatus.drift.removed.length > 0 && (
                    <div className="mcp-removed-tools" role="note">
                      <strong>Removed definitions</strong>
                      <p>
                        Trusting the current set also accepts removal of:{' '}
                        {selectedStatus.drift.removed.join(', ')}
                      </p>
                    </div>
                  )}

                  {selectedStatus.tools.length > 0 ? (
                    <div className="mcp-tool-list">
                      {selectedStatus.tools.map((tool) => (
                        <article
                          className={`mcp-tool-card mcp-tool-${tool.trustStatus}`}
                          key={tool.name}
                        >
                          <div className="mcp-tool-heading">
                            <div>
                              <strong>{tool.title ?? tool.name}</strong>
                              {tool.title && <code>{tool.name}</code>}
                            </div>
                            <span className="mcp-tool-trust">
                              {tool.trustStatus === 'approved' ? (
                                <ShieldCheck size={13} aria-hidden="true" />
                              ) : (
                                <ShieldAlert size={13} aria-hidden="true" />
                              )}
                              {trustLabel(tool.trustStatus)}
                            </span>
                          </div>
                          <p>
                            {tool.description || 'No description provided.'}
                          </p>
                          {tool.originalName !== tool.name && (
                            <small className="mcp-tool-original-name">
                              Server name: <code>{tool.originalName}</code>
                            </small>
                          )}
                          <div className="mcp-tool-fingerprint">
                            <span>SHA-256 definition fingerprint</span>
                            <code title={tool.fingerprint}>
                              {tool.fingerprint}
                            </code>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="mcp-tools-empty">
                      <Wrench size={18} aria-hidden="true" />
                      <p>This server did not advertise any tools.</p>
                    </div>
                  )}

                  {reviewNeeded && (
                    <div className="mcp-trust-review">
                      <div className="mcp-notice mcp-notice-warning">
                        <ShieldAlert size={15} aria-hidden="true" />
                        <p>
                          Review the names, descriptions, and full fingerprints
                          above. Approval applies only to this exact discovered
                          tool set; later schema changes are blocked until
                          reviewed again. Definition trust does not approve an
                          individual tool execution.
                        </p>
                      </div>

                      {!fingerprintsMatchReview && (
                        <div
                          className="mcp-notice mcp-notice-error"
                          role="alert"
                        >
                          <CircleAlert size={15} aria-hidden="true" />
                          <p>
                            The displayed definitions do not match the current
                            fingerprint snapshot. Reconnect before approving.
                          </p>
                        </div>
                      )}

                      {confirmTrust ? (
                        <div
                          className="mcp-trust-confirmation"
                          role="alert"
                          aria-live="assertive"
                        >
                          <div>
                            <strong>Trust this exact tool set?</strong>
                            <p>
                              Ground will submit{' '}
                              {Object.keys(selectedStatus.fingerprints).length}{' '}
                              exact fingerprints. This does not approve future
                              definitions.
                            </p>
                          </div>
                          <div className="mcp-trust-confirmation-actions">
                            <button
                              ref={trustCancelRef}
                              type="button"
                              onClick={() => {
                                setConfirmTrust(false)
                                window.requestAnimationFrame(() =>
                                  trustTriggerRef.current?.focus()
                                )
                              }}
                              disabled={Boolean(busy)}
                            >
                              Cancel
                            </button>
                            <button
                              className="mcp-trust-button"
                              type="button"
                              onClick={() =>
                                void trustCurrentDefinitions()
                              }
                              disabled={
                                Boolean(busy) ||
                                endpointChanged ||
                                !fingerprintsMatchReview
                              }
                            >
                              {selectedBusy === 'trust' ? (
                                <LoaderCircle
                                  className="mcp-spin"
                                  size={13}
                                  aria-hidden="true"
                                />
                              ) : (
                                <ShieldCheck
                                  size={13}
                                  aria-hidden="true"
                                />
                              )}
                              Trust these fingerprints
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          ref={trustTriggerRef}
                          className="mcp-review-button"
                          type="button"
                          onClick={() => setConfirmTrust(true)}
                          disabled={
                            Boolean(busy) ||
                            endpointChanged ||
                            !fingerprintsMatchReview
                          }
                        >
                          <ShieldCheck size={14} aria-hidden="true" />
                          Review and trust current definitions
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mcp-runtime-empty">
                  {selectedStatus?.connection === 'connecting' ? (
                    <LoaderCircle
                      className="mcp-spin"
                      size={20}
                      aria-hidden="true"
                    />
                  ) : (
                    <Server size={20} aria-hidden="true" />
                  )}
                  <p>
                    {selectedStatus?.connection === 'connecting'
                      ? 'Connecting and discovering tool definitions…'
                      : 'Connect to discover this server’s tools. Discovery does not grant tool trust.'}
                  </p>
                </div>
              )}
            </section>
          ) : (
            <section className="mcp-runtime mcp-runtime-unsaved">
              <Server size={21} aria-hidden="true" />
              <h3>Save before connecting</h3>
              <p>
                Ground will discover tool definitions after this configuration
                is saved and enabled. No discovered tool is trusted
                automatically.
              </p>
            </section>
          )}
        </div>
      </div>
    </section>
  )
}
