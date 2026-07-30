import { realpath } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { CliAdapter, CliProvider } from '../../shared/types'
import { cliEnvironmentSecretReference } from '../cli-environment'
import { createProcessLaunchEnvelope } from '../process-launch'
import {
  CliProcessExitError,
  CliProtocolError,
  type CliInvocationAuthorizer
} from '../providers/cli'
import {
  BUILT_IN_CLI_RUNTIME_BINDINGS,
  CLI_RUNTIME_ADAPTER_IDS,
  CLI_RUNTIME_SESSION_COMPATIBILITY_IDS,
  CliRuntimeAdapter,
  createBuiltInCliRuntimeAdapters,
  type CliRuntimeRunner
} from './cli-runtime-adapter'
import type { AdapterContext } from './contracts'
import { consumeAgentRuntimeEventStream } from './conformance'
import type { AgentRunRequest, AgentRuntimeEvent } from './types'

const NOW = '2026-07-29T12:00:00.000Z'
const REDACTION_MARKER = '█'.repeat(4)

function provider(
  dialect: CliAdapter,
  overrides: Partial<CliProvider> = {}
): CliProvider {
  return {
    id: `${dialect}-provider`,
    name: `${dialect} CLI`,
    kind: 'cli',
    model: 'test-model',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    promptMode: 'stdin',
    outputMode: dialect === 'generic' ? 'plain' : 'ndjson',
    cliAdapter: dialect,
    trustConfirmed: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function request(
  overrides: Partial<AgentRunRequest> = {}
): AgentRunRequest {
  return {
    requestId: 'request_1',
    prompt: 'Inspect the workspace.',
    workspacePath: process.cwd(),
    mode: 'agent',
    ...overrides
  }
}

function adapterContext(
  config: CliProvider,
  signal: AbortSignal = new AbortController().signal,
  resolve: (ref: string) => Promise<string> = async () => {
    throw new Error('No secret expected')
  }
): AdapterContext<CliProvider> {
  return {
    config,
    signal,
    secrets: { resolve }
  }
}

async function collect(
  events: AsyncIterable<AgentRuntimeEvent>
): Promise<AgentRuntimeEvent[]> {
  const collected: AgentRuntimeEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

const authorizeFixture: CliInvocationAuthorizer = async (authorization) => ({
  launch: await createProcessLaunchEnvelope(authorization.command),
  cwd: await realpath(authorization.cwd)
})

describe('built-in CLI runtime bindings', () => {
  it('publishes one frozen adapter and stable session compatibility per dialect', () => {
    const adapters = createBuiltInCliRuntimeAdapters(authorizeFixture)

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      'ground.cli.generic',
      'openai.codex-cli',
      'anthropic.claude-code',
      'google.gemini-cli',
      'google.antigravity-cli'
    ])
    expect(CLI_RUNTIME_ADAPTER_IDS).toEqual({
      generic: 'ground.cli.generic',
      codex: 'openai.codex-cli',
      claude: 'anthropic.claude-code',
      gemini: 'google.gemini-cli',
      antigravity: 'google.antigravity-cli'
    })
    expect(CLI_RUNTIME_SESSION_COMPATIBILITY_IDS).toEqual({
      codex: 'codex',
      claude: 'claude',
      gemini: 'gemini',
      antigravity: 'antigravity'
    })
    expect(BUILT_IN_CLI_RUNTIME_BINDINGS.generic).not.toHaveProperty(
      'sessionCompatibilityId'
    )
    expect(Object.isFrozen(BUILT_IN_CLI_RUNTIME_BINDINGS)).toBe(true)
    expect(
      Object.values(BUILT_IN_CLI_RUNTIME_BINDINGS).every(Object.isFrozen)
    ).toBe(true)
    expect(Object.isFrozen(adapters)).toBe(true)
  })

  it('reports Antigravity headless approvals as unsupported', async () => {
    const adapter = new CliRuntimeAdapter(
      'antigravity',
      authorizeFixture
    )
    const inspection = await adapter.inspect(
      adapterContext(provider('antigravity'))
    )

    expect(inspection.capabilities).toMatchObject({
      structuredEvents: 'native',
      sessionResume: 'native',
      toolActivities: 'native',
      commandActivities: 'native',
      usageReporting: 'native',
      interactiveApprovals: 'unsupported',
      permissionOwner: 'runtime'
    })
  })
})

describe('CLI agent runtime adapter', () => {
  it.each([
    {
      label: 'missing executable',
      error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }),
      category: 'executable-not-found',
      providerCode: 'ENOENT'
    },
    {
      label: 'launch permission',
      error: Object.assign(new Error('spawn denied'), { code: 'EACCES' }),
      category: 'process-exit',
      providerCode: 'EACCES'
    },
    {
      label: 'nonzero process exit',
      error: new CliProcessExitError(
        'CLI exited with code 2',
        2,
        null
      ),
      category: 'process-exit',
      providerCode: undefined
    },
    {
      label: 'malformed runtime protocol',
      error: new CliProtocolError('CLI emitted an oversized JSON line'),
      category: 'protocol',
      providerCode: undefined
    }
  ] as const)(
    'normalizes $label failures without matching display text',
    async ({ error, category, providerCode }) => {
      const runner = vi.fn<CliRuntimeRunner>(async () => {
        throw error
      })
      const adapter = new CliRuntimeAdapter(
        'codex',
        authorizeFixture,
        runner
      )

      await expect(
        collect(adapter.run(request(), adapterContext(provider('codex'))))
      ).rejects.toMatchObject({
        name: 'ProviderError',
        category,
        retryable: false,
        ...(providerCode ? { providerCode } : {})
      })
    }
  )

  it('normalizes text, activity lifecycles, diagnostics, cumulative usage, and one terminal event', async () => {
    const authorize = vi.fn(authorizeFixture)
    const runner = vi.fn<CliRuntimeRunner>(
      async (
        _provider,
        _prompt,
        _workspacePath,
        _signal,
        callbacks,
        _options,
        receivedAuthorize
      ) => {
        expect(receivedAuthorize).toBe(authorize)
        callbacks.onSession?.('session_final')
        callbacks.onText('Hello')
        callbacks.onText(' from the CLI')
        callbacks.onActivity?.({
          runtimeId: 'command_1',
          activityType: 'command',
          title: 'npm test',
          detail: 'started',
          status: 'running'
        })
        callbacks.onActivity?.({
          runtimeId: 'command_1',
          activityType: 'command',
          title: 'npm test',
          detail: 'halfway',
          status: 'running'
        })
        callbacks.onActivity?.({
          runtimeId: 'command_1',
          activityType: 'command',
          title: 'npm test',
          detail: 'passed',
          status: 'success'
        })
        callbacks.onActivity?.({
          activityType: 'status',
          title: 'Runtime ready',
          status: 'success'
        })
        callbacks.onActivity?.({
          runtimeId: 'tool_1',
          activityType: 'tool',
          title: 'Read',
          status: 'running'
        })
        callbacks.onDiagnostic('old diagnostic')
        callbacks.onDiagnostic('x'.repeat(11_000))
        callbacks.onDiagnostic('latest diagnostic')
        callbacks.onUsage?.({ inputTokens: 10, outputTokens: 2 })
        callbacks.onUsage?.({
          inputTokens: 8,
          outputTokens: 5,
          cachedInputTokens: 1,
          costUsd: 0.01234
        })
        return {
          sessionId: 'session_final',
          usage: {
            inputTokens: 8,
            outputTokens: 5,
            cachedInputTokens: 1,
            costUsd: 0.01234
          }
        }
      }
    )
    const adapter = new CliRuntimeAdapter('codex', authorize, runner)
    const events = await collect(
      adapter.run(request(), adapterContext(provider('codex')))
    )

    expect(events[0]).toEqual({
      type: 'runtime.started',
      sessionId: undefined,
      servingModel: 'test-model'
    })
    expect(events.filter((event) => event.type === 'runtime.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'runtime.completed')).toHaveLength(1)
    expect(events.at(-1)).toEqual({
      type: 'runtime.completed',
      sessionId: 'session_final',
      stopReason: 'complete',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 1,
        totalTokens: 15,
        costUsd: 0.01234
      }
    })
    expect(
      events
        .filter(
          (
            event
          ): event is Extract<
            AgentRuntimeEvent,
            { type: 'assistant.delta' }
          > => event.type === 'assistant.delta'
        )
        .map((event) => event.delta)
    ).toEqual(['Hello', ' from the CLI'])

    const starts = events.filter(
      (
        event
      ): event is Extract<AgentRuntimeEvent, { type: 'activity.started' }> =>
        event.type === 'activity.started'
    )
    const updates = events.filter(
      (
        event
      ): event is Extract<AgentRuntimeEvent, { type: 'activity.updated' }> =>
        event.type === 'activity.updated'
    )
    const completions = events.filter(
      (
        event
      ): event is Extract<AgentRuntimeEvent, { type: 'activity.completed' }> =>
        event.type === 'activity.completed'
    )
    expect(starts).toHaveLength(3)
    expect(updates).toEqual([
      {
        type: 'activity.updated',
        activityId: starts[0]?.activityId,
        detail: 'halfway'
      }
    ])
    expect(completions).toEqual([
      {
        type: 'activity.completed',
        activityId: starts[0]?.activityId,
        status: 'success',
        detail: 'passed'
      },
      {
        type: 'activity.completed',
        activityId: starts[1]?.activityId,
        status: 'success',
        detail: undefined
      },
      {
        type: 'activity.completed',
        activityId: starts[2]?.activityId,
        status: 'success',
        detail: undefined
      }
    ])
    expect(
      events.filter((event) => event.type === 'usage.updated')
    ).toEqual([
      {
        type: 'usage.updated',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12
        },
        semantics: 'cumulative'
      },
      {
        type: 'usage.updated',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 1,
          totalTokens: 15,
          costUsd: 0.01234
        },
        semantics: 'cumulative'
      }
    ])
    const notices = events.filter(
      (
        event
      ): event is Extract<AgentRuntimeEvent, { type: 'provider.notice' }> =>
        event.type === 'provider.notice'
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]?.code).toBe('cli.diagnostics')
    expect(notices[0]?.message).toContain(
      'Earlier CLI diagnostics were truncated.'
    )
    expect(notices[0]?.message).toContain('latest diagnostic')
    expect(notices[0]?.message.length).toBeLessThanOrEqual(10_000)
  })

  it('forwards a compatible resume session and preserves its stable identity', async () => {
    const runner = vi.fn<CliRuntimeRunner>(
      async (
        providerProfile,
        prompt,
        workspacePath,
        _signal,
        callbacks,
        options
      ) => {
        expect(providerProfile.cliAdapter).toBe('claude')
        expect(providerProfile.model).toBe('override-model')
        expect(prompt).toBe('Continue.')
        expect(workspacePath).toBe(process.cwd())
        expect(options).toEqual({
          mode: 'ask',
          sessionId: 'session_old',
          runtimeAdapterId: 'anthropic.claude-code'
        })
        callbacks.onSession?.('session_old')
        return {}
      }
    )
    const adapter = new CliRuntimeAdapter(
      'claude',
      authorizeFixture,
      runner
    )
    const events: AgentRuntimeEvent[] = []
    const reduced = await consumeAgentRuntimeEventStream(
      adapter.run(
        request({
          prompt: 'Continue.',
          model: 'override-model',
          mode: 'ask',
          resume: { sessionId: 'session_old' }
        }),
        adapterContext(provider('claude'))
      ),
      {
        onEvent: (event) => {
          events.push(event)
        }
      }
    )

    expect(events[0]).toEqual({
      type: 'runtime.started',
      sessionId: 'session_old',
      servingModel: 'override-model'
    })
    expect(events.at(-1)).toEqual({
      type: 'runtime.completed',
      sessionId: 'session_old',
      stopReason: 'complete',
      usage: undefined
    })
    expect(reduced.sessionId).toBe('session_old')
  })

  it('rejects a native runtime that changes identity while resuming', async () => {
    const runner = vi.fn<CliRuntimeRunner>(
      async (
        _provider,
        _prompt,
        _workspacePath,
        _signal,
        callbacks
      ) => {
        callbacks.onSession?.('session_new')
        return {}
      }
    )
    const adapter = new CliRuntimeAdapter(
      'claude',
      authorizeFixture,
      runner
    )

    await expect(
      collect(
        adapter.run(
          request({ resume: { sessionId: 'session_old' } }),
          adapterContext(provider('claude'))
        )
      )
    ).rejects.toThrow(/changed the native session identifier/i)
  })

  it('resolves the encrypted environment envelope only through context secrets and keeps output redacted', async () => {
    const secret = 'enterprise-adapter-secret'
    const fingerprint = 'a'.repeat(64)
    const configuredProvider = provider('generic', {
      args: [
        '-e',
        'process.stdout.write(process.env.ACME_AGENT_TOKEN ?? "missing")'
      ],
      environmentVariables: ['ACME_AGENT_TOKEN'],
      environmentFingerprint: fingerprint
    })
    const resolve = vi.fn(async (reference: string) => {
      expect(reference).toBe(
        cliEnvironmentSecretReference(configuredProvider.id)
      )
      return JSON.stringify({
        version: 1,
        fingerprint,
        values: { ACME_AGENT_TOKEN: secret }
      })
    })
    const adapter = new CliRuntimeAdapter('generic', authorizeFixture)
    const events = await collect(
      adapter.run(
        request(),
        adapterContext(configuredProvider, undefined, resolve)
      )
    )
    const text = events
      .filter(
        (
          event
        ): event is Extract<
          AgentRuntimeEvent,
          { type: 'assistant.delta' }
        > => event.type === 'assistant.delta'
      )
      .map((event) => event.delta)
      .join('')

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(text).toContain(REDACTION_MARKER)
    expect(text).not.toContain(secret)
    expect(JSON.stringify(configuredProvider)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it('rejects unknown fields, inconsistent environments, untrusted profiles, and dialect mismatch', () => {
    const codex = new CliRuntimeAdapter('codex', authorizeFixture)

    expect(() =>
      codex.validateConfig({
        ...provider('codex'),
        environmentValues: { TOKEN: 'secret' }
      })
    ).toThrow()
    expect(() =>
      codex.validateConfig({
        ...provider('codex'),
        environmentVariables: ['ACME_TOKEN']
      })
    ).toThrow(/configured together/i)
    expect(() =>
      codex.validateConfig({
        ...provider('codex'),
        environmentVariables: ['PATH'],
        environmentFingerprint: 'f'.repeat(64)
      })
    ).toThrow(/alter process loading or execution/i)
    expect(() =>
      codex.validateConfig({
        ...provider('codex'),
        trustConfirmed: false
      })
    ).toThrow()
    expect(() => codex.validateConfig(provider('claude'))).toThrow(
      /cannot load claude/i
    )
  })

  it('fails closed instead of treating generic CLI sessions as compatible', async () => {
    const runner = vi.fn<CliRuntimeRunner>(async () => ({}))
    const adapter = new CliRuntimeAdapter(
      'generic',
      authorizeFixture,
      runner
    )

    await expect(
      collect(
        adapter.run(
          request({ resume: { sessionId: 'not-compatible' } }),
          adapterContext(provider('generic'))
        )
      )
    ).rejects.toThrow(/does not support native session resume/i)
    expect(runner).not.toHaveBeenCalled()
  })

  it('propagates cancellation and completes open activity lifecycles without a terminal result', async () => {
    const controller = new AbortController()
    const runner = vi.fn<CliRuntimeRunner>(
      async (
        _provider,
        _prompt,
        _workspacePath,
        signal,
        callbacks
      ) => {
        callbacks.onActivity?.({
          runtimeId: 'command_1',
          activityType: 'command',
          title: 'long command',
          status: 'running'
        })
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return {}
      }
    )
    const adapter = new CliRuntimeAdapter('codex', authorizeFixture, runner)
    const iterator = adapter.run(
      request(),
      adapterContext(provider('codex'), controller.signal)
    )[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'runtime.started',
        sessionId: undefined,
        servingModel: 'test-model'
      }
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: 'activity.started',
        kind: 'command',
        title: 'long command'
      }
    })
    const terminal = iterator.next()
    controller.abort()
    await expect(terminal).resolves.toMatchObject({
      done: false,
      value: {
        type: 'activity.completed',
        status: 'error'
      }
    })
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(runner).toHaveBeenCalledTimes(1)
  })
})
