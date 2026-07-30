import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
  DatabaseBackup,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Plus,
  Server,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import type {
  DetectedCli,
  McpServerProfile,
  ProviderDraft,
  ProviderProfile,
  ProviderTestResult
} from '../../../shared/types'
import { desktop } from '../lib/desktop'
import { providerReadiness } from '../lib/provider-readiness'
import { McpSettingsPane } from './McpSettingsPane'
import { RecoverySettingsPane } from './RecoverySettingsPane'

type ApiProviderKind = Exclude<ProviderDraft['kind'], 'cli'>
export type ProviderConnectionPath = 'hosted' | 'local' | 'cli'
type CliDetectionStatus = 'pending' | 'succeeded' | 'failed'

interface ApiProviderOption {
  kind: ApiProviderKind
  label: string
  description: string
  defaultName: string
  defaultBaseUrl: string
  keyHint: string
}

const API_PROVIDER_OPTIONS: readonly ApiProviderOption[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    description: 'Responses API',
    defaultName: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyHint: 'Required for hosted OpenAI accounts.'
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    description: 'Messages API',
    defaultName: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    keyHint: 'Required for hosted Anthropic accounts.'
  },
  {
    kind: 'google',
    label: 'Google',
    description: 'Generative AI API',
    defaultName: 'Google AI',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyHint: 'Required for hosted Google AI accounts.'
  },
  {
    kind: 'openai-compatible',
    label: 'Compatible',
    description: 'OpenAI-style API',
    defaultName: 'OpenAI-compatible',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    keyHint: 'Optional for local endpoints; hosted services may require one.'
  }
]

const API_PROVIDER_OPTIONS_BY_KIND = new Map(
  API_PROVIDER_OPTIONS.map((option) => [option.kind, option])
)

const CLI_ADAPTER_LABELS = {
  generic: 'Default model',
  codex: 'Codex CLI',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity CLI'
} as const

export function providerConnectionPathForDraft(
  draft: ProviderDraft
): ProviderConnectionPath {
  if (draft.kind === 'cli') return 'cli'
  if (draft.kind !== 'openai-compatible' || !draft.baseUrl) return 'hosted'
  try {
    const hostname = new URL(draft.baseUrl).hostname
      .replace(/^\[(.*)\]$/u, '$1')
      .toLowerCase()
    return hostname === 'localhost' ||
      hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname)
      ? 'local'
      : 'hosted'
  } catch {
    return 'hosted'
  }
}

export function providerDraftForConnectionPath(
  path: ProviderConnectionPath
): ProviderDraft {
  if (path === 'cli') return blankDraft('cli')
  if (path === 'hosted') return blankDraft('openai')
  return {
    ...blankDraft('openai-compatible'),
    name: 'Ollama · local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    supportsTools: true,
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096
  }
}

export function shouldShowLocalServerRecovery(
  draft: ProviderDraft,
  result: ProviderTestResult
): boolean {
  return (
    !result.ok &&
    result.failureKind === 'connection-refused' &&
    providerConnectionPathForDraft(draft) === 'local'
  )
}

export function providerConnectionPathExplanation(
  selectedPath: ProviderConnectionPath,
  detected: readonly DetectedCli[],
  detectionStatus: CliDetectionStatus
): string {
  if (selectedPath === 'hosted') {
    return 'Ground connects directly to the hosted API. Test sends a real request with this profile; Ground does not proxy model traffic.'
  }
  if (selectedPath === 'local') {
    return 'The included local-server values are only a connection template. Ground does not supply, install, or start a local runtime, and it does not download models.'
  }
  if (detectionStatus === 'pending') {
    return 'Ground is checking for recognized agent CLIs installed locally. You can still choose an executable that is already installed.'
  }
  if (detectionStatus === 'failed') {
    return 'Ground could not complete local CLI detection. You can still choose an executable that is already installed.'
  }
  const detectedNames = detected.map((candidate) => candidate.name)
  return detectedNames.length
    ? `${detectedNames.join(', ')} ${detectedNames.length === 1 ? 'was' : 'were'} detected locally. Detection does not prove sign-in, model access, or a successful turn.`
    : 'No recognized agent CLI was detected locally. You can still choose an executable that is already installed.'
}

interface ProviderModalProps {
  providers: ProviderProfile[]
  mcpServers: McpServerProfile[]
  initialProviderId?: string
  onClose: () => void
  onSaved: () => Promise<void>
  onError: (error: unknown) => void
}

export function ProviderModal(props: ProviderModalProps): React.JSX.Element {
  const initialProvider = props.initialProviderId
    ? props.providers.find(
        (provider) => provider.id === props.initialProviderId
      )
    : undefined
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(props.onClose)
  const [selectedId, setSelectedId] = useState(initialProvider?.id)
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    providerToDraft(initialProvider)
  )
  const [detected, setDetected] = useState<DetectedCli[]>([])
  const [cliDetectionStatus, setCliDetectionStatus] =
    useState<CliDetectionStatus>('pending')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [settingsSection, setSettingsSection] = useState<
    'providers' | 'mcp' | 'recovery'
  >('providers')

  const selectedProvider = useMemo(
    () => props.providers.find((provider) => provider.id === selectedId),
    [props.providers, selectedId]
  )
  const mobileSectionValue =
    settingsSection !== 'providers'
      ? settingsSection
      : selectedId
        ? `provider:${selectedId}`
        : draft.kind === 'cli'
          ? 'new:cli'
          : 'new:api'

  useEffect(() => {
    void desktop
      .detectClis()
      .then((candidates) => {
        setDetected(candidates)
        setCliDetectionStatus('succeeded')
      })
      .catch((error: unknown) => {
        setCliDetectionStatus('failed')
        props.onError(error)
      })
  }, [props.onError])

  useEffect(() => {
    onCloseRef.current = props.onClose
  }, [props.onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement
    closeButtonRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') return
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? [])
      ].filter(
        (element) =>
          element.getClientRects().length > 0 &&
          !element.closest('[aria-hidden="true"]')
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [])

  useEffect(() => {
    if (!confirmDelete) return
    window.requestAnimationFrame(() => deleteCancelRef.current?.focus())
  }, [confirmDelete])

  const selectProvider = (provider: ProviderProfile): void => {
    setSettingsSection('providers')
    setSelectedId(provider.id)
    setDraft(providerToDraft(provider))
    setTestResult(undefined)
    setConfirmDelete(false)
  }

  const beginNew = (kind: ProviderDraft['kind'], preset?: Partial<ProviderDraft>): void => {
    setSettingsSection('providers')
    setSelectedId(undefined)
    setDraft({ ...blankDraft(kind), ...preset, kind })
    setTestResult(undefined)
    setConfirmDelete(false)
  }

  const chooseConnectionPath = (path: ProviderConnectionPath): void => {
    const nextDraft = providerDraftForConnectionPath(path)
    beginNew(nextDraft.kind, nextDraft)
  }

  const configureDetectedCli = (candidate: DetectedCli): void => {
    beginNew('cli', candidate.draft)
  }

  const selectMobileSection = (value: string): void => {
    if (value === 'mcp') {
      setSettingsSection('mcp')
      setConfirmDelete(false)
      return
    }
    if (value === 'recovery') {
      setSettingsSection('recovery')
      setConfirmDelete(false)
      return
    }
    if (value === 'new:api') {
      beginNew('openai')
      return
    }
    if (value === 'new:cli') {
      beginNew('cli')
      return
    }
    const providerId = value.startsWith('provider:')
      ? value.slice('provider:'.length)
      : undefined
    const provider = props.providers.find((candidate) => candidate.id === providerId)
    if (provider) selectProvider(provider)
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(undefined)
    try {
      const result = await desktop.testProvider(draft)
      setTestResult(result)
      if (result.persisted) await props.onSaved()
    } catch (error) {
      props.onError(error)
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const provider = await desktop.saveProvider(draft)
      setSelectedId(provider.id)
      setDraft(providerToDraft(provider))
      await props.onSaved()
      setTestResult({
        ok: true,
        title: 'Saved, not tested',
        detail: `Run Test to check ${provider.name} before its first run.`,
        persisted: true
      })
    } catch (error) {
      props.onError(error)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!selectedId) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    try {
      await desktop.deleteProvider(selectedId)
      await props.onSaved()
      const fallback = props.providers.find((provider) => provider.id !== selectedId)
      setSelectedId(fallback?.id)
      setDraft(providerToDraft(fallback))
      setConfirmDelete(false)
    } catch (error) {
      props.onError(error)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <div
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside className="settings-nav">
          <div className="settings-nav-header">
            <div>
              <span className="settings-eyebrow">Ground</span>
              <h2>Settings</h2>
            </div>
          </div>

          <div className="provider-list">
            <p className="nav-section-label">Providers</p>
            {props.providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={`provider-nav-row ${
                  settingsSection === 'providers' && selectedId === provider.id
                    ? 'selected'
                    : ''
                }`}
                aria-current={
                  settingsSection === 'providers' &&
                  selectedId === provider.id
                    ? 'page'
                    : undefined
                }
                onClick={() => selectProvider(provider)}
              >
                <span className={`provider-nav-icon ${provider.kind === 'cli' ? 'cli' : ''}`}>
                  {provider.kind === 'cli' ? <TerminalSquare size={14} /> : <Cloud size={14} />}
                </span>
                <span>
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.model || providerKindLabel(provider)}
                    {' · '}
                    {providerReadiness(provider).shortLabel}
                  </small>
                </span>
                <ChevronRight size={13} />
              </button>
            ))}

            <div className="provider-add-buttons">
              <button type="button" onClick={() => beginNew('openai')}>
                <Plus size={13} /> API
              </button>
              <button type="button" onClick={() => beginNew('cli')}>
                <Plus size={13} /> CLI
              </button>
            </div>
          </div>

          <div className="settings-area-list">
            <p className="nav-section-label">Agent tools</p>
            <button
              type="button"
              className={`provider-nav-row ${
                settingsSection === 'mcp' ? 'selected' : ''
              }`}
              aria-current={settingsSection === 'mcp' ? 'page' : undefined}
              onClick={() => setSettingsSection('mcp')}
            >
              <span className="provider-nav-icon mcp">
                <Server size={14} />
              </span>
              <span>
                <strong>MCP servers</strong>
                <small>
                  {props.mcpServers.length
                    ? `${props.mcpServers.length} configured`
                    : 'Connect external tools'}
                </small>
              </span>
              <ChevronRight size={13} />
            </button>
            <p className="nav-section-label settings-data-label">
              Local data
            </p>
            <button
              type="button"
              className={`provider-nav-row ${
                settingsSection === 'recovery' ? 'selected' : ''
              }`}
              aria-current={
                settingsSection === 'recovery' ? 'page' : undefined
              }
              onClick={() => setSettingsSection('recovery')}
            >
              <span className="provider-nav-icon recovery">
                <DatabaseBackup size={14} />
              </span>
              <span>
                <strong>Recovery</strong>
                <small>Export or restore local state</small>
              </span>
              <ChevronRight size={13} />
            </button>
          </div>

          {detected.length > 0 && (
            <div className="detected-list">
              <p className="nav-section-label">
                Detected locally
                <span>{detected.length}</span>
              </p>
              {detected.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  onClick={() => beginNew('cli', candidate.draft)}
                >
                  <span className="detected-led" />
                  <span>
                    <strong>{candidate.name}</strong>
                    <small>{candidate.path}</small>
                  </span>
                  <Plus size={12} />
                </button>
              ))}
            </div>
          )}

          <div className="settings-nav-footer">
            <ShieldAlert size={12} />
            Secrets use your OS credential vault.
          </div>
        </aside>

        <section className="settings-content">
          {settingsSection === 'mcp' ? (
            <>
              <div className="settings-content-header mcp-settings-shell-header">
                <MobileSettingsSwitcher
                  value={mobileSectionValue}
                  providers={props.providers}
                  onChange={selectMobileSection}
                />
                <div>
                  <div className="settings-content-kind">Agent tools</div>
                  <h3 id="settings-dialog-title">MCP servers</h3>
                </div>
                <button
                  ref={closeButtonRef}
                  className="icon-button"
                  type="button"
                  onClick={props.onClose}
                  aria-label="Close settings"
                >
                  <X size={17} />
                </button>
              </div>
              <McpSettingsPane
                servers={props.mcpServers}
                onSaved={props.onSaved}
                onError={props.onError}
              />
            </>
          ) : settingsSection === 'recovery' ? (
            <>
              <div className="settings-content-header recovery-settings-shell-header">
                <MobileSettingsSwitcher
                  value={mobileSectionValue}
                  providers={props.providers}
                  onChange={selectMobileSection}
                />
                <div>
                  <div className="settings-content-kind">Local data</div>
                  <h3 id="settings-dialog-title">Recovery</h3>
                </div>
                <button
                  ref={closeButtonRef}
                  className="icon-button"
                  type="button"
                  onClick={props.onClose}
                  aria-label="Close settings"
                >
                  <X size={17} />
                </button>
              </div>
              <RecoverySettingsPane onError={props.onError} />
            </>
          ) : (
            <>
          <div className="settings-content-header">
            <MobileSettingsSwitcher
              value={mobileSectionValue}
              providers={props.providers}
              onChange={selectMobileSection}
            />
            <div>
              <div className="settings-content-kind">
                {draft.kind === 'cli' ? 'CLI runtime' : 'API connection'}
              </div>
              <h3 id="settings-dialog-title">
                {selectedProvider ? `Edit ${selectedProvider.name}` : 'Connect a provider'}
              </h3>
            </div>
            <button
              ref={closeButtonRef}
              className="icon-button"
              type="button"
              onClick={props.onClose}
              aria-label="Close provider settings"
            >
              <X size={17} />
            </button>
          </div>

          <form
            className="settings-provider-form"
            aria-busy={saving || testing}
            onSubmit={(event) => {
              event.preventDefault()
              if (!saving && !testing) void save()
            }}
          >
            {!selectedProvider && (
              <ProviderConnectionPicker
                draft={draft}
                detected={detected}
                detectionStatus={cliDetectionStatus}
                onChoose={chooseConnectionPath}
                onConfigureDetectedCli={configureDetectedCli}
              />
            )}
            {draft.kind !== 'cli' ? (
              <ApiProviderForm
                draft={draft}
                setDraft={setDraft}
                selected={selectedProvider}
                onChanged={() => setTestResult(undefined)}
              />
            ) : (
              <CliProviderForm
                draft={draft}
                setDraft={setDraft}
                selected={selectedProvider}
                onChanged={() => setTestResult(undefined)}
                onError={props.onError}
              />
            )}

            {testResult && (
              <div
                className={`test-result ${testResult.ok ? 'success' : 'error'}`}
                role={testResult.ok ? 'status' : 'alert'}
                aria-live={testResult.ok ? 'polite' : 'assertive'}
              >
                <span className="test-result-icon">
                  {testResult.ok ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <CircleAlert size={14} aria-hidden="true" />
                  )}
                </span>
                <div>
                  <strong>{testResult.title}</strong>
                  <p>{testResult.detail}</p>
                  {shouldShowLocalServerRecovery(draft, testResult) && (
                    <LocalServerRecovery
                      detected={detected}
                      onChooseCli={() => chooseConnectionPath('cli')}
                      onConfigureDetectedCli={configureDetectedCli}
                    />
                  )}
                  {testResult.persisted === false && (
                    <p className="test-result-retention">
                      Draft-only check. Save these settings, then test the saved
                      profile to retain its status.
                    </p>
                  )}
                  {testResult.models && testResult.models.length > 0 && (
                    <div className="model-suggestions">
                      {testResult.models.slice(0, 8).map((model) => (
                        <button
                          type="button"
                          key={model}
                          onClick={() => {
                            setTestResult(undefined)
                            setDraft((current) => ({ ...current, model }))
                          }}
                        >
                          {model}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="settings-actions">
              <div>
                {selectedId &&
                  (confirmDelete ? (
                    <div
                      className="provider-delete-confirmation"
                      role="alert"
                      aria-live="assertive"
                    >
                      <span>Remove {selectedProvider?.name ?? 'this provider'}?</span>
                      <button
                        ref={deleteCancelRef}
                        type="button"
                        onClick={() => {
                          setConfirmDelete(false)
                          window.requestAnimationFrame(() =>
                            deleteTriggerRef.current?.focus()
                          )
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="delete-provider confirm"
                        type="button"
                        onClick={() => void remove()}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button
                      ref={deleteTriggerRef}
                      className="delete-provider"
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      Remove
                    </button>
                  ))}
              </div>
              <div className="settings-primary-actions">
                <button
                  className="test-button"
                  type="button"
                  onClick={(event) => {
                    if (!event.currentTarget.form?.reportValidity()) return
                    void test()
                  }}
                  disabled={testing || saving}
                  aria-busy={testing}
                >
                  {testing ? (
                    <LoaderCircle className="status-spin" size={13} aria-hidden="true" />
                  ) : (
                    <Sparkles size={13} aria-hidden="true" />
                  )}
                  {testing ? 'Testing…' : 'Test'}
                </button>
                <button
                  className="primary-button save-provider"
                  type="submit"
                  disabled={saving || testing}
                  aria-busy={saving}
                >
                  {saving && (
                    <LoaderCircle className="status-spin" size={13} aria-hidden="true" />
                  )}
                  {saving ? 'Saving…' : 'Save provider'}
                </button>
              </div>
            </div>
          </form>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function MobileSettingsSwitcher(props: {
  value: string
  providers: ProviderProfile[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="settings-mobile-switcher">
      <span className="visually-hidden">Settings section</span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        aria-label="Settings section"
      >
        <optgroup label="Providers">
          {props.providers.map((provider) => (
            <option key={provider.id} value={`provider:${provider.id}`}>
              {provider.name}
            </option>
          ))}
          <option value="new:api">Add API provider</option>
          <option value="new:cli">Add CLI provider</option>
        </optgroup>
        <optgroup label="Agent tools">
          <option value="mcp">MCP servers</option>
        </optgroup>
        <optgroup label="Local data">
          <option value="recovery">Recovery</option>
        </optgroup>
      </select>
    </label>
  )
}

function ProviderConnectionPicker(props: {
  draft: ProviderDraft
  detected: DetectedCli[]
  detectionStatus: CliDetectionStatus
  onChoose: (path: ProviderConnectionPath) => void
  onConfigureDetectedCli: (candidate: DetectedCli) => void
}): React.JSX.Element {
  const selectedPath = providerConnectionPathForDraft(props.draft)
  const explanationId = 'provider-connection-path-explanation'
  const explanation = providerConnectionPathExplanation(
    selectedPath,
    props.detected,
    props.detectionStatus
  )

  return (
    <fieldset className="connection-path-picker">
      <legend>Connection path</legend>
      <div className="connection-path-options">
        <label className={selectedPath === 'hosted' ? 'selected' : ''}>
          <input
            type="radio"
            name="provider-connection-path"
            value="hosted"
            checked={selectedPath === 'hosted'}
            aria-describedby={explanationId}
            onChange={() => props.onChoose('hosted')}
          />
          <span>
            <Cloud size={15} aria-hidden="true" />
            <span>
              <strong>Hosted API</strong>
              <small>Cloud endpoint and API key</small>
            </span>
          </span>
        </label>
        <label className={selectedPath === 'local' ? 'selected' : ''}>
          <input
            type="radio"
            name="provider-connection-path"
            value="local"
            checked={selectedPath === 'local'}
            aria-describedby={explanationId}
            onChange={() => props.onChoose('local')}
          />
          <span>
            <Server size={15} aria-hidden="true" />
            <span>
              <strong>Local server</strong>
              <small>Ollama, LM Studio, or compatible</small>
            </span>
          </span>
        </label>
        <label className={selectedPath === 'cli' ? 'selected' : ''}>
          <input
            type="radio"
            name="provider-connection-path"
            value="cli"
            checked={selectedPath === 'cli'}
            aria-describedby={explanationId}
            onChange={() => props.onChoose('cli')}
          />
          <span>
            <TerminalSquare size={15} aria-hidden="true" />
            <span>
              <strong>Installed CLI</strong>
              <small>Existing coding-agent executable</small>
            </span>
          </span>
        </label>
      </div>
      <p
        id={explanationId}
        className="connection-path-explanation"
        aria-live="polite"
        aria-atomic="true"
      >
        {explanation}
      </p>
      {selectedPath === 'cli' && props.detected.length > 0 && (
        <div
          className="connection-path-detected"
          role="group"
          aria-label="Detected CLI executables"
        >
          <span>Configure a detected executable</span>
          <div>
            {props.detected.map((candidate) => (
              <button
                type="button"
                key={candidate.id}
                onClick={() => props.onConfigureDetectedCli(candidate)}
              >
                <TerminalSquare size={12} aria-hidden="true" />
                {candidate.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </fieldset>
  )
}

function LocalServerRecovery(props: {
  detected: DetectedCli[]
  onChooseCli: () => void
  onConfigureDetectedCli: (candidate: DetectedCli) => void
}): React.JSX.Element {
  return (
    <div className="local-server-recovery">
      <strong>Before testing this local server again</strong>
      <ol>
        <li>Start its API server and keep it running.</li>
        <li>Pull or load the exact model identifier entered above.</li>
        <li>Confirm the server&apos;s port and Base URL, then choose Test again.</li>
      </ol>
      <p>
        Ground does not install or start the server and does not pull models for
        it.
      </p>
      <div className="local-server-alternatives">
        {props.detected.map((candidate) => (
          <button
            type="button"
            key={candidate.id}
            onClick={() => props.onConfigureDetectedCli(candidate)}
          >
            <TerminalSquare size={12} aria-hidden="true" />
            Configure {candidate.name}
          </button>
        ))}
        <button type="button" onClick={props.onChooseCli}>
          Choose another installed CLI
        </button>
      </div>
      <small>
        A detected executable is only a path match; Ground has not verified its
        authentication or model access.
      </small>
    </div>
  )
}

function ApiProviderForm(props: {
  draft: ProviderDraft
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>
  selected?: ProviderProfile
  onChanged: () => void
}): React.JSX.Element {
  const hasStoredKey =
    props.selected?.kind !== 'cli' &&
    props.selected?.kind === props.draft.kind &&
    props.selected.hasApiKey
  const selectedOption =
    props.draft.kind === 'cli'
      ? API_PROVIDER_OPTIONS_BY_KIND.get('openai-compatible')!
      : API_PROVIDER_OPTIONS_BY_KIND.get(props.draft.kind)!
  const set = (patch: Partial<ProviderDraft>): void => {
    props.onChanged()
    props.setDraft((current) => ({ ...current, ...patch }))
  }
  const selectApiKind = (kind: ApiProviderKind): void => {
    const option = API_PROVIDER_OPTIONS_BY_KIND.get(kind)!
    props.onChanged()
    props.setDraft((current) => ({
      ...current,
      kind,
      name: option.defaultName,
      baseUrl: option.defaultBaseUrl,
      model: '',
      apiKey: ''
    }))
  }
  const optionalInteger = (value: string): number | undefined => {
    if (!value.trim()) return undefined
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  return (
    <div className="provider-form">
      {props.selected && props.selected.kind !== 'cli' && (
        <ProviderVerificationSummary provider={props.selected} />
      )}
      <fieldset className="api-kind-picker">
        <legend>API protocol</legend>
        <div className="api-kind-options">
          {API_PROVIDER_OPTIONS.map((option) => (
            <label
              key={option.kind}
              className={props.draft.kind === option.kind ? 'selected' : ''}
            >
              <input
                type="radio"
                name="api-provider-kind"
                value={option.kind}
                checked={props.draft.kind === option.kind}
                onChange={() => selectApiKind(option.kind)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {props.draft.kind === 'openai-compatible' ? (
        <div className="local-preset-row" aria-label="Local API presets">
          <span>Local server must be running</span>
          <div>
            <button
              type="button"
              onClick={() =>
                set({
                  name: 'Ollama · local',
                  baseUrl: 'http://127.0.0.1:11434/v1',
                  model: '',
                  supportsTools: true,
                  contextWindowTokens: 32_768,
                  maxOutputTokens: 4_096
                })
              }
            >
              <Server size={13} /> Ollama
            </button>
            <button
              type="button"
              onClick={() =>
                set({
                  name: 'LM Studio · local',
                  baseUrl: 'http://127.0.0.1:1234/v1',
                  model: '',
                  supportsTools: true,
                  contextWindowTokens: 32_768,
                  maxOutputTokens: 4_096
                })
              }
            >
              <Server size={13} /> LM Studio
            </button>
          </div>
        </div>
      ) : null}

      <div className="form-grid">
        <label>
          <span>Display name</span>
          <input
            value={props.draft.name}
            onChange={(event) => set({ name: event.target.value })}
            placeholder="My provider"
            autoComplete="off"
            maxLength={80}
            required
          />
        </label>
        <label>
          <span>Model identifier</span>
          <input
            value={props.draft.model}
            onChange={(event) => set({ model: event.target.value })}
            placeholder="Exact model ID from your provider"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            maxLength={200}
            required
          />
        </label>
      </div>

      <label>
        <span>Base URL</span>
        <div className="input-with-icon">
          <Cloud size={14} />
          <input
            type="url"
            value={props.draft.baseUrl ?? ''}
            onChange={(event) => set({ baseUrl: event.target.value })}
            placeholder={selectedOption.defaultBaseUrl}
            spellCheck={false}
            inputMode="url"
            autoCapitalize="none"
            autoComplete="url"
            maxLength={2_000}
            required
          />
        </div>
        <small>HTTPS is required except for endpoints on this computer.</small>
      </label>

      <label>
        <span>
          API key
          {hasStoredKey && <em>Stored securely</em>}
        </span>
        <div className="input-with-icon">
          <KeyRound size={14} />
          <input
            type="password"
            value={props.draft.apiKey ?? ''}
            onChange={(event) => set({ apiKey: event.target.value })}
            placeholder={hasStoredKey ? 'Leave blank to keep the saved key' : 'Paste API key'}
            autoComplete="new-password"
            spellCheck={false}
            maxLength={20_000}
            required={
              !hasStoredKey && props.draft.kind !== 'openai-compatible'
            }
          />
        </div>
        <small>{selectedOption.keyHint}</small>
      </label>

      <label className="toggle-row">
        <span>
          <strong>Agent tool calling</strong>
          <small>Expose scoped read tools and approval-gated writes and commands.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={props.draft.supportsTools ?? true}
          onChange={(event) => set({ supportsTools: event.target.checked })}
        />
      </label>

      <details className="provider-advanced">
        <summary>Model limits and reasoning</summary>
        <div className="provider-advanced-content">
          <div className="form-grid">
            <label>
              <span>Context window</span>
              <input
                type="number"
                min={4_096}
                max={2_000_000}
                step={1_024}
                value={props.draft.contextWindowTokens ?? ''}
                onChange={(event) =>
                  set({
                    contextWindowTokens: optionalInteger(event.target.value)
                  })
                }
                placeholder={
                  props.draft.kind === 'openai-compatible'
                    ? '32768'
                    : '128000'
                }
                inputMode="numeric"
              />
              <small>
                Tokens available to the prompt and response. Leave blank for
                Ground&apos;s conservative protocol default.
              </small>
            </label>
            <label>
              <span>Maximum response</span>
              <input
                type="number"
                min={128}
                max={262_144}
                step={128}
                value={props.draft.maxOutputTokens ?? ''}
                onChange={(event) =>
                  set({ maxOutputTokens: optionalInteger(event.target.value) })
                }
                placeholder="Provider default"
                inputMode="numeric"
              />
              <small>
                Optional output cap. Ground reserves 8,192 tokens when estimating
                context if this is blank.
              </small>
            </label>
          </div>

          <label>
            <span>Reasoning effort</span>
            <select
              value={props.draft.reasoningEffort ?? ''}
              onChange={(event) =>
                set({
                  reasoningEffort:
                    (event.target.value || undefined) as
                      | 'low'
                      | 'medium'
                      | 'high'
                      | undefined
                })
              }
            >
              <option value="">Provider default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <small>
              Sent only when selected. Models that do not support reasoning controls
              may reject the request.
            </small>
          </label>
        </div>
      </details>
    </div>
  )
}

function CliProviderForm(props: {
  draft: ProviderDraft
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>
  selected?: ProviderProfile
  onChanged: () => void
  onError: (error: unknown) => void
}): React.JSX.Element {
  const [choosingExecutable, setChoosingExecutable] = useState(false)
  const set = (patch: Partial<ProviderDraft>): void => {
    props.onChanged()
    props.setDraft((current) => ({ ...current, ...patch }))
  }
  const chooseExecutable = async (): Promise<void> => {
    setChoosingExecutable(true)
    try {
      const selected = await desktop.chooseCliExecutable()
      if (!selected) return
      props.onChanged()
      props.setDraft((current) =>
        cliDraftWithChosenExecutable(current, selected)
      )
    } catch (error) {
      props.onError(error)
    } finally {
      setChoosingExecutable(false)
    }
  }
  const environment = props.draft.cliEnvironment ?? []
  const updateEnvironment = (
    index: number,
    patch: { name?: string; value?: string }
  ): void => {
    set({
      cliEnvironment: environment.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry
      )
    })
  }

  return (
    <div className="provider-form">
      {props.selected?.kind === 'cli' && (
        <ProviderVerificationSummary provider={props.selected} />
      )}
      <div className="cli-warning">
        <ShieldAlert size={16} />
        <div>
          <strong>A CLI runs with your user account.</strong>
          <p>
            Ground passes exact arguments directly and sets the workspace as its working folder.
            The executable is still outside Ground&apos;s app sandbox, so use one you trust.
          </p>
        </div>
      </div>

      <div className="form-grid">
        <label>
          <span>Display name</span>
          <input
            value={props.draft.name}
            onChange={(event) => set({ name: event.target.value })}
            placeholder="My CLI"
            autoComplete="off"
            maxLength={80}
            required
          />
        </label>
        <label>
          <span>Model override</span>
          <input
            value={props.draft.model}
            onChange={(event) => set({ model: event.target.value })}
            placeholder="Optional"
            maxLength={200}
          />
        </label>
      </div>

      <div className="cli-executable-field">
        <label htmlFor="cli-executable-path">Executable</label>
        <div className="cli-executable-controls">
          <div className="input-with-icon mono-input">
            <TerminalSquare size={14} />
            <input
              id="cli-executable-path"
              value={props.draft.command ?? ''}
              onChange={(event) =>
                set({
                  command: event.target.value,
                  ...((props.draft.command ?? '') !== event.target.value
                    ? { trustConfirmed: false }
                    : {})
                })
              }
              placeholder="/absolute/path/to/agent"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              maxLength={2_000}
              aria-describedby="cli-executable-help"
              required
            />
          </div>
          <button
            type="button"
            className="secondary-button cli-executable-choose"
            onClick={() => void chooseExecutable()}
            disabled={choosingExecutable}
            aria-busy={choosingExecutable}
          >
            {choosingExecutable ? (
              <LoaderCircle
                className="status-spin"
                size={13}
                aria-hidden="true"
              />
            ) : (
              <FolderOpen size={13} aria-hidden="true" />
            )}
            {choosingExecutable ? 'Choosing…' : 'Choose executable…'}
          </button>
        </div>
        <small id="cli-executable-help">
          The native picker validates the executable without running it. Saving
          and each invocation still require their own native confirmation.
        </small>
      </div>

      <label>
        <span>Arguments · one argument per line</span>
        <textarea
          className="args-input"
          value={(props.draft.args ?? []).join('\n')}
          onChange={(event) => set({ args: event.target.value.split('\n') })}
          placeholder={'run\n--json'}
          rows={6}
          spellCheck={false}
          maxLength={32_000}
        />
        <small>
          Tokens: <code>{'{model}'}</code> <code>{'{cwd}'}</code>. Use{' '}
          <code>{'{prompt}'}</code> only with Argument transport; Standard input
          keeps the prompt out of argv. No shell interpolation is used.
        </small>
      </label>

      <div className="form-grid form-grid-three">
        <label>
          <span>Runtime adapter</span>
          <select
            value={props.draft.cliAdapter ?? 'generic'}
            onChange={(event) =>
              set({
                cliAdapter: event.target.value as NonNullable<ProviderDraft['cliAdapter']>
              })
            }
          >
            <option value="generic">Generic CLI</option>
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude Code</option>
            <option value="gemini">Gemini CLI</option>
            <option value="antigravity">Antigravity CLI</option>
          </select>
        </label>
        <label>
          <span>Prompt transport</span>
          <select
            value={props.draft.promptMode ?? 'stdin'}
            onChange={(event) =>
              set({ promptMode: event.target.value as 'stdin' | 'argument' })
            }
          >
            <option value="stdin">Standard input</option>
            <option value="argument">Argument token</option>
          </select>
        </label>
        <label>
          <span>Output parser</span>
          <select
            value={props.draft.outputMode ?? 'plain'}
            onChange={(event) =>
              set({ outputMode: event.target.value as 'plain' | 'ndjson' })
            }
          >
            <option value="plain">Plain streamed text</option>
            <option value="ndjson">JSON Lines / stream JSON</option>
          </select>
        </label>
      </div>

      <section className="cli-environment-section" aria-labelledby="cli-environment-title">
        <div className="cli-environment-header">
          <div>
            <span id="cli-environment-title">
              <KeyRound size={13} />
              Profile environment
            </span>
            <small>
              Optional. Native CLI sign-in and credential stores remain the default.
            </small>
          </div>
          <button
            type="button"
            className="secondary-button cli-environment-add"
            onClick={() =>
              set({
                cliEnvironment: [
                  ...environment,
                  { name: '', value: '' }
                ]
              })
            }
          >
            <Plus size={12} />
            Add variable
          </button>
        </div>

        {environment.length ? (
          <div className="cli-environment-list">
            {environment.map((entry, index) => (
              <div className="cli-environment-row" key={index}>
                <label>
                  <span>Variable name</span>
                  <input
                    className="mono-input"
                    value={entry.name}
                    onChange={(event) =>
                      updateEnvironment(index, { name: event.target.value })
                    }
                    placeholder="MY_AGENT_TOKEN"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={128}
                    required
                  />
                </label>
                <label>
                  <span>Encrypted value</span>
                  <input
                    type="password"
                    value={entry.value ?? ''}
                    onChange={(event) =>
                      updateEnvironment(index, { value: event.target.value })
                    }
                    placeholder={
                      entry.value === undefined
                        ? 'Saved · leave blank to keep'
                        : 'Enter a value'
                    }
                    autoComplete="new-password"
                    maxLength={20_000}
                  />
                </label>
                <button
                  type="button"
                  className="icon-button cli-environment-remove"
                  aria-label={`Remove ${entry.name || 'environment variable'}`}
                  onClick={() =>
                    set({
                      cliEnvironment: environment.filter(
                        (_candidate, candidateIndex) =>
                          candidateIndex !== index
                      )
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="cli-environment-empty">
            No profile-specific variables. Ground will pass only the adapter&apos;s
            reviewed authentication, proxy, and certificate variables.
          </p>
        )}
        <small className="cli-environment-note">
          Values are encrypted in the operating-system vault and never enter task
          snapshots. Names are visible in the profile and native launch
          confirmation. Loader and process-control variables such as{' '}
          <code>PATH</code>, <code>NODE_OPTIONS</code>, and <code>LD_PRELOAD</code>{' '}
          are refused.
        </small>
      </section>

      <label className="trust-check">
        <input
          type="checkbox"
          checked={props.draft.trustConfirmed ?? false}
          onChange={(event) => set({ trustConfirmed: event.target.checked })}
          aria-describedby="cli-trust-note"
          required
        />
        <span id="cli-trust-note">
          I understand this executable receives my prompts and can access whatever my user account
          can access. Ground separately asks for native confirmation of the exact executable and
          arguments; this acknowledgement does not grant permission.
        </span>
      </label>
    </div>
  )
}

export function cliDraftWithChosenExecutable(
  draft: ProviderDraft,
  selected: string | undefined
): ProviderDraft {
  if (!selected) return draft
  return {
    ...draft,
    command: selected,
    ...(draft.command === selected ? {} : { trustConfirmed: false })
  }
}

function ProviderVerificationSummary(props: {
  provider: ProviderProfile
}): React.JSX.Element {
  const readiness = providerReadiness(props.provider)
  return (
    <div
      className={`provider-verification-summary ${readiness.tone}`}
      role={readiness.tone === 'error' ? 'alert' : 'status'}
    >
      <span className="provider-verification-led" aria-hidden="true" />
      <div>
        <strong>{readiness.title}</strong>
        <p>{readiness.detail}</p>
      </div>
    </div>
  )
}

function blankDraft(kind: ProviderDraft['kind']): ProviderDraft {
  return kind === 'cli'
    ? {
        name: 'Custom CLI',
        kind,
        model: '',
        command: '',
        args: [],
        promptMode: 'stdin',
        outputMode: 'plain',
        cliAdapter: 'generic',
        cliEnvironment: [],
        trustConfirmed: false
      }
    : {
        name: API_PROVIDER_OPTIONS_BY_KIND.get(kind)?.defaultName ?? 'API provider',
        kind,
        model: '',
        baseUrl: API_PROVIDER_OPTIONS_BY_KIND.get(kind)?.defaultBaseUrl ?? 'https://',
        supportsTools: true
      }
}

function providerToDraft(provider?: ProviderProfile): ProviderDraft {
  if (!provider) return blankDraft('openai-compatible')
  return provider.kind === 'cli'
    ? {
        id: provider.id,
        name: provider.name,
        kind: 'cli',
        model: provider.model,
        command: provider.command,
        args: provider.args,
        promptMode: provider.promptMode,
        outputMode: provider.outputMode,
        cliAdapter: provider.cliAdapter,
        cliEnvironment: (provider.environmentVariables ?? []).map((name) => ({
          name
        })),
        trustConfirmed: provider.trustConfirmed
      }
    : {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        model: provider.model,
        baseUrl: provider.baseUrl,
        supportsTools: provider.supportsTools,
        contextWindowTokens: provider.contextWindowTokens,
        maxOutputTokens: provider.maxOutputTokens,
        reasoningEffort: provider.reasoningEffort
      }
}

function providerKindLabel(provider: ProviderProfile): string {
  switch (provider.kind) {
    case 'openai':
      return 'OpenAI API'
    case 'anthropic':
      return 'Anthropic API'
    case 'google':
      return 'Google AI API'
    case 'openai-compatible':
      return 'Compatible API'
    case 'cli':
      return CLI_ADAPTER_LABELS[provider.cliAdapter ?? 'generic']
  }
}
