import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  ProviderDraft,
  ProviderFailureKind,
  ProviderProfile,
  ProviderTestResult
} from '../../../shared/types'

vi.mock('../lib/desktop', () => ({ desktop: {} }))

import {
  cliDraftWithChosenExecutable,
  createProviderTestRequestGuard,
  ProviderModal,
  providerConnectionPathForDraft,
  providerConnectionPathExplanation,
  providerDraftForConnectionPath,
  providerTestResultPresentation,
  shouldShowLocalServerRecovery
} from './ProviderModal'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const FAILURE_TITLES = {
  'connection-refused': 'Connection refused',
  dns: 'Provider host was not found',
  tls: 'Secure connection failed',
  authentication: 'Provider rejected the credential',
  'rate-limit': 'Provider rate limit reached',
  timeout: 'Provider did not respond in time',
  'protocol-shape': 'Provider returned an incompatible response',
  'executable-not-found': 'CLI executable was not found',
  'external-runtime-startup': 'CLI runtime could not start'
} as const satisfies Record<ProviderFailureKind, string>

describe('provider settings', () => {
  it('uses native form submission and exposes every built-in runtime adapter', () => {
    const cliProvider: ProviderProfile = {
      id: 'provider',
      name: 'Local agent',
      kind: 'cli',
      model: '',
      command: '/usr/bin/agent',
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      trustConfirmed: true,
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z'
    }
    const markup = renderToStaticMarkup(
      createElement(ProviderModal, {
        providers: [cliProvider],
        mcpServers: [],
        initialProviderId: cliProvider.id,
        onClose: () => undefined,
        onSaved: async () => undefined,
        onError: () => undefined
      })
    )

    expect(markup).toContain('<form class="settings-provider-form"')
    expect(markup).toContain('type="submit"')
    expect(markup).toContain('Save provider')
    expect(markup).toContain('value="codex"')
    expect(markup).toContain('value="claude"')
    expect(markup).toContain('value="gemini"')
    expect(markup).toContain('value="antigravity"')
    expect(markup).toContain('>Recovery<')
    expect(markup).toContain('value="recovery"')
    expect(markup).toContain('Choose executable…')
    expect(markup).toContain('aria-describedby="cli-executable-help"')
    expect(markup).toContain(
      'Saving and each invocation still require their own native confirmation.'
    )
  })

  it('opens on the provider requested by the current task', () => {
    const ollamaProvider: ProviderProfile = {
      id: 'ollama',
      name: 'Ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      hasApiKey: false,
      supportsTools: true,
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z'
    }
    const codexProvider: ProviderProfile = {
      id: 'codex',
      name: 'Codex CLI',
      kind: 'cli',
      model: '',
      command: '/usr/local/bin/codex',
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'codex',
      trustConfirmed: true,
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z'
    }

    const markup = renderToStaticMarkup(
      createElement(ProviderModal, {
        providers: [ollamaProvider, codexProvider],
        mcpServers: [],
        initialProviderId: codexProvider.id,
        onClose: () => undefined,
        onSaved: async () => undefined,
        onError: () => undefined
      })
    )

    expect(markup).toContain(
      '<h3 id="settings-dialog-title">Edit Codex CLI</h3>'
    )
    expect(markup).toContain('value="/usr/local/bin/codex"')
    expect(markup).not.toContain(
      '<h3 id="settings-dialog-title">Edit Ollama</h3>'
    )
  })

  it('distinguishes truthful hosted, local-server, and installed-CLI paths', () => {
    const localTemplate: ProviderProfile = {
      id: 'ollama-template',
      name: 'Ollama · local',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3',
      hasApiKey: false,
      supportsTools: true,
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z'
    }
    const markup = renderToStaticMarkup(
      createElement(ProviderModal, {
        providers: [localTemplate],
        mcpServers: [],
        onClose: () => undefined,
        onSaved: async () => undefined,
        onError: () => undefined
      })
    )

    expect(markup).toContain('<legend>Connection path</legend>')
    expect(markup).toContain('value="hosted"')
    expect(markup).toContain('>Hosted API<')
    expect(markup).toContain('value="local"')
    expect(markup).toContain('>Local server<')
    expect(markup).toContain('value="cli"')
    expect(markup).toContain('>Installed CLI<')
    expect(markup).toContain(
      'The included local-server values are only a connection template'
    )
    expect(markup).toContain(
      '<h3 id="settings-dialog-title">Connect a provider</h3>'
    )
    expect(markup).not.toContain(
      '<h3 id="settings-dialog-title">Edit Ollama · local</h3>'
    )

    const localDraft = providerDraftForConnectionPath('local')
    expect(localDraft).toMatchObject({
      kind: 'openai-compatible',
      name: 'Ollama · local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: ''
    })
    expect(providerConnectionPathForDraft(localDraft)).toBe('local')
    expect(
      providerConnectionPathForDraft({
        ...localDraft,
        baseUrl: 'https://models.example.test/v1'
      })
    ).toBe('hosted')
    expect(providerDraftForConnectionPath('cli')).toMatchObject({
      kind: 'cli',
      command: '',
      trustConfirmed: false
    })
    expect(
      shouldShowLocalServerRecovery(localDraft, {
        ok: false,
        title: 'Could not connect',
        detail: 'No service is listening.',
        failureKind: 'connection-refused'
      })
    ).toBe(true)
    expect(
      shouldShowLocalServerRecovery(localDraft, {
        ok: false,
        title: 'Could not connect',
        detail: '401 Unauthorized'
      })
    ).toBe(false)
    for (const failureKind of Object.keys(
      FAILURE_TITLES
    ) as ProviderFailureKind[]) {
      expect(
        shouldShowLocalServerRecovery(localDraft, {
          ok: false,
          title: 'Untrusted display title',
          detail: 'Credential-safe diagnostic.',
          failureKind
        })
      ).toBe(failureKind === 'connection-refused')
    }
    expect(
      shouldShowLocalServerRecovery(
        {
          ...localDraft,
          baseUrl: 'https://models.example.test/v1'
        },
        {
          ok: false,
          title: 'Could not connect',
          detail: 'Connection refused.',
          failureKind: 'connection-refused'
        }
      )
    ).toBe(false)
    expect(
      providerConnectionPathExplanation('cli', [], 'pending')
    ).toMatch(/checking for recognized agent CLIs/iu)
    expect(
      providerConnectionPathExplanation('cli', [], 'failed')
    ).toMatch(/could not complete local CLI detection/iu)
    expect(
      providerConnectionPathExplanation('cli', [], 'succeeded')
    ).toMatch(/No recognized agent CLI was detected locally/iu)
  })

  it.each(Object.entries(FAILURE_TITLES))(
    'uses shared corrective presentation for an immediate %s failure',
    (failureKind, expectedTitle) => {
      const presentation = providerTestResultPresentation({
        ok: false,
        title: 'Unstable transport title',
        detail: 'Credential-safe diagnostic detail.',
        failureKind: failureKind as ProviderFailureKind
      })

      expect(presentation.title).toBe(expectedTitle)
      expect(presentation.detail).toBe('Credential-safe diagnostic detail.')
      expect(presentation.correctiveGuidance).toBeTruthy()
      expect(presentation.correctiveGuidance).not.toContain(
        'Credential-safe diagnostic detail.'
      )
    }
  )

  it('preserves immediate success and generic legacy failure presentations', () => {
    expect(
      providerTestResultPresentation({
        ok: true,
        title: 'Connection checked',
        detail: 'The endpoint responded.'
      })
    ).toEqual({
      title: 'Connection checked',
      detail: 'The endpoint responded.'
    })

    expect(
      providerTestResultPresentation({
        ok: false,
        title: 'Provider check failed',
        detail: 'Review the diagnostic.'
      })
    ).toEqual({
      title: 'Provider check failed',
      detail: 'Review the diagnostic.'
    })

    expect(
      providerTestResultPresentation({
        ok: false,
        title: 'Future failure',
        detail: 'A future Ground version retained this category.',
        failureKind: 'future-provider-failure'
      } as unknown as ProviderTestResult)
    ).toEqual({
      title: 'Future failure',
      detail: 'A future Ground version retained this category.'
    })
  })

  it('discards typed guidance and model suggestions after the tested draft changes', async () => {
    const guard = createProviderTestRequestGuard()
    guard.activate()
    let currentDraft: ProviderDraft = {
      id: 'provider-a',
      name: 'Local API',
      kind: 'openai-compatible',
      model: 'model-before-test',
      baseUrl: 'http://127.0.0.1:11434/v1'
    }
    const request = guard.begin(currentDraft, 'provider-a', 'providers')
    const pending = deferred<ProviderTestResult>()
    const applied: ProviderTestResult[] = []
    const completion = pending.promise.then((result) => {
      if (
        guard.isCurrent(
          request,
          currentDraft,
          'provider-a',
          'providers'
        )
      ) {
        applied.push(result)
      }
    })

    currentDraft = { ...currentDraft, model: 'edited-while-testing' }
    guard.invalidate()
    pending.resolve({
      ok: false,
      title: 'Unstable transport title',
      detail: 'Credential-safe diagnostic detail.',
      failureKind: 'protocol-shape',
      models: ['stale-model-suggestion']
    })
    await completion

    expect(applied).toEqual([])
    expect(guard.isLatest(request)).toBe(false)

    const identityOnlyGuard = createProviderTestRequestGuard()
    identityOnlyGuard.activate()
    const identityRequest = identityOnlyGuard.begin(
      currentDraft,
      'provider-a',
      'providers'
    )
    expect(
      identityOnlyGuard.isCurrent(
        identityRequest,
        { ...currentDraft, apiKey: 'changed-key' },
        'provider-a',
        'providers'
      )
    ).toBe(false)
  })

  it('discards a pending test when the connection path or selected provider changes', async () => {
    const guard = createProviderTestRequestGuard()
    guard.activate()
    let currentDraft = providerDraftForConnectionPath('local')
    let selectedProviderId: string | undefined
    const connectionRequest = guard.begin(
      currentDraft,
      selectedProviderId,
      'providers'
    )
    const connectionPending = deferred<ProviderTestResult>()
    const connectionResults: ProviderTestResult[] = []
    const connectionCompletion = connectionPending.promise.then((result) => {
      if (
        guard.isCurrent(
          connectionRequest,
          currentDraft,
          selectedProviderId,
          'providers'
        )
      ) {
        connectionResults.push(result)
      }
    })

    currentDraft = providerDraftForConnectionPath('cli')
    guard.invalidate()
    connectionPending.resolve({
      ok: false,
      title: 'Could not connect',
      detail: 'No service is listening.',
      failureKind: 'connection-refused'
    })
    await connectionCompletion
    expect(connectionResults).toEqual([])

    currentDraft = {
      id: 'provider-a',
      name: 'Provider A',
      kind: 'openai',
      model: 'model-a',
      baseUrl: 'https://api.openai.com/v1'
    }
    selectedProviderId = 'provider-a'
    const providerRequest = guard.begin(
      currentDraft,
      selectedProviderId,
      'providers'
    )
    const providerPending = deferred<ProviderTestResult>()
    const providerResults: ProviderTestResult[] = []
    const providerCompletion = providerPending.promise.then((result) => {
      if (
        guard.isCurrent(
          providerRequest,
          currentDraft,
          selectedProviderId,
          'providers'
        )
      ) {
        providerResults.push(result)
      }
    })

    currentDraft = {
      id: 'provider-b',
      name: 'Provider B',
      kind: 'anthropic',
      model: 'model-b',
      baseUrl: 'https://api.anthropic.com/v1'
    }
    selectedProviderId = 'provider-b'
    guard.invalidate()
    providerPending.resolve({
      ok: true,
      title: 'Connection checked',
      detail: 'The old provider responded.',
      models: ['stale-model']
    })
    await providerCompletion
    expect(providerResults).toEqual([])
  })

  it('discards a pending provider test after settings navigation or unmount', async () => {
    const draft = providerDraftForConnectionPath('local')
    const guard = createProviderTestRequestGuard()
    guard.activate()
    const navigationRequest = guard.begin(draft, undefined, 'providers')

    expect(
      guard.isCurrent(navigationRequest, draft, undefined, 'mcp')
    ).toBe(false)

    const pending = deferred<ProviderTestResult>()
    const applied: ProviderTestResult[] = []
    const completion = pending.promise.then((result) => {
      if (
        guard.isCurrent(
          navigationRequest,
          draft,
          undefined,
          'providers'
        )
      ) {
        applied.push(result)
      }
    })

    guard.dispose()
    pending.resolve({
      ok: false,
      title: 'Could not connect',
      detail: 'The modal is already closed.',
      failureKind: 'timeout'
    })
    await completion

    expect(applied).toEqual([])
    expect(guard.isLatest(navigationRequest)).toBe(false)
  })

  it('keeps picker cancellation harmless and resets acknowledgement for a changed path', () => {
    const draft: ProviderDraft = {
      name: 'Local agent',
      kind: 'cli',
      model: '',
      command: '/usr/bin/agent',
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      trustConfirmed: true
    }

    expect(cliDraftWithChosenExecutable(draft, undefined)).toBe(draft)
    expect(
      cliDraftWithChosenExecutable(draft, '/usr/local/bin/other-agent')
    ).toMatchObject({
      command: '/usr/local/bin/other-agent',
      trustConfirmed: false
    })
    expect(
      cliDraftWithChosenExecutable(draft, '/usr/bin/agent')
    ).toMatchObject({
      command: '/usr/bin/agent',
      trustConfirmed: true
    })
  })
})
