import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderDraft, ProviderProfile } from '../../../shared/types'

vi.mock('../lib/desktop', () => ({ desktop: {} }))

import {
  cliDraftWithChosenExecutable,
  ProviderModal
} from './ProviderModal'

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
