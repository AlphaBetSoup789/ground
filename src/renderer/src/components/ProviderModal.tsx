import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
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
import { McpSettingsPane } from './McpSettingsPane'

type ApiProviderKind = Exclude<ProviderDraft['kind'], 'cli'>

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
  gemini: 'Gemini CLI'
} as const

interface ProviderModalProps {
  providers: ProviderProfile[]
  mcpServers: McpServerProfile[]
  onClose: () => void
  onSaved: () => Promise<void>
  onError: (error: unknown) => void
}

export function ProviderModal(props: ProviderModalProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(props.onClose)
  const [selectedId, setSelectedId] = useState(props.providers[0]?.id)
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    providerToDraft(props.providers[0])
  )
  const [detected, setDetected] = useState<DetectedCli[]>([])
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'providers' | 'mcp'>(
    'providers'
  )

  const selectedProvider = useMemo(
    () => props.providers.find((provider) => provider.id === selectedId),
    [props.providers, selectedId]
  )
  const mobileSectionValue =
    settingsSection === 'mcp'
      ? 'mcp'
      : selectedId
        ? `provider:${selectedId}`
        : draft.kind === 'cli'
          ? 'new:cli'
          : 'new:api'

  useEffect(() => {
    void desktop
      .detectClis()
      .then(setDetected)
      .catch(props.onError)
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

  const selectMobileSection = (value: string): void => {
    if (value === 'mcp') {
      setSettingsSection('mcp')
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
      setTestResult(await desktop.testProvider(draft))
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
        title: 'Provider saved',
        detail: `${provider.name} is ready for new runs.`
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
              <h2>Providers</h2>
            </div>
          </div>

          <div className="provider-list">
            <p className="nav-section-label">Connected</p>
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
                  <small>{provider.model || providerKindLabel(provider)}</small>
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
              onChanged={() => setTestResult(undefined)}
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
                {testResult.models && testResult.models.length > 0 && (
                  <div className="model-suggestions">
                    {testResult.models.slice(0, 8).map((model) => (
                      <button
                        type="button"
                        key={model}
                        onClick={() => setDraft((current) => ({ ...current, model }))}
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
                onClick={() => void test()}
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
                type="button"
                onClick={() => void save()}
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
      </select>
    </label>
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
          <span>Quick local setup</span>
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
  onChanged: () => void
}): React.JSX.Element {
  const set = (patch: Partial<ProviderDraft>): void => {
    props.onChanged()
    props.setDraft((current) => ({ ...current, ...patch }))
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

      <label>
        <span>Executable</span>
        <div className="input-with-icon mono-input">
          <TerminalSquare size={14} />
          <input
            value={props.draft.command ?? ''}
            onChange={(event) => set({ command: event.target.value })}
            placeholder="/absolute/path/to/agent"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            maxLength={2_000}
            required
          />
        </div>
      </label>

      <label>
        <span>Arguments · one argument per line</span>
        <textarea
          className="args-input"
          value={(props.draft.args ?? []).join('\n')}
          onChange={(event) => set({ args: event.target.value.split('\n') })}
          placeholder={'run\n--json\n{prompt}'}
          rows={6}
          spellCheck={false}
          maxLength={32_000}
        />
        <small>
          Tokens: <code>{'{prompt}'}</code> <code>{'{model}'}</code> <code>{'{cwd}'}</code>. No shell
          interpolation is used.
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
