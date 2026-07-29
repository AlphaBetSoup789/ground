import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { CliAdapter, CliProvider } from '../../shared/types'
import { CLI_RUNTIME_ADAPTER_IDS } from '../cli-runtime-bindings'
import { createProcessLaunchEnvelope } from '../process-launch'
import {
  assertValidCliSessionId,
  expandCliArgs,
  parseCliRuntimeEvent,
  runCli,
  safeCliEnvironment,
  type CliInvocationAuthorizer,
  type CliInvocationOptions,
  type CliRunOptions
} from './cli'

function provider(overrides: Partial<CliProvider> = {}): CliProvider {
  return {
    id: 'test',
    name: 'Test CLI',
    kind: 'cli',
    model: 'model-x',
    command: process.execPath,
    args: ['run', '--model', '{model}', '--cwd', '{cwd}'],
    promptMode: 'stdin',
    outputMode: 'plain',
    trustConfirmed: true,
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

const authorizeFixture: CliInvocationAuthorizer = async (request) => ({
  launch: await createProcessLaunchEnvelope(request.command),
  cwd: await realpath(request.cwd)
})
const REDACTION_MARKER = '█'.repeat(4)

function runOptions(
  adapter: CliAdapter = 'generic',
  overrides: CliInvocationOptions = {}
): CliRunOptions {
  return {
    ...overrides,
    runtimeAdapterId: CLI_RUNTIME_ADAPTER_IDS[adapter]
  }
}

describe('CLI adapter', () => {
  it('expands each argv entry without invoking a shell', () => {
    const result = expandCliArgs(
      provider({ args: ['--model={model}', '--root={cwd}', '{prompt}'], promptMode: 'argument' }),
      'write $(touch nope)',
      '/tmp/work space'
    )
    expect(result).toEqual({
      args: ['--model=model-x', '--root=/tmp/work space', 'write $(touch nope)'],
      stdin: undefined
    })
  })

  it('streams plain CLI output', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))
    let output = ''
    await runCli(
      provider({ args: [fixture] }),
      'hello',
      process.cwd(),
      new AbortController().signal,
      {
        onText: (delta) => {
          output += delta
        },
        onDiagnostic: () => undefined
      },
      runOptions(),
      authorizeFixture
    )
    expect(output).toBe('Received: hello')
  })

  it('extracts assistant text from JSON Lines', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))
    let output = ''
    await runCli(
      provider({ args: [fixture, '--ndjson'], outputMode: 'ndjson' }),
      'hello',
      process.cwd(),
      new AbortController().signal,
      {
        onText: (delta) => {
          output += delta
        },
        onDiagnostic: () => undefined
      },
      runOptions(),
      authorizeFixture
    )
    expect(output).toBe('Received: hello')
  })

  it('preserves multibyte UTF-8 split across JSON Lines process chunks', async () => {
    const fixture = fileURLToPath(
      new URL('./fixtures/fake-agent.mjs', import.meta.url)
    )
    let output = ''
    await runCli(
      provider({
        args: [fixture, '--split-utf8'],
        outputMode: 'ndjson'
      }),
      'hello',
      process.cwd(),
      new AbortController().signal,
      {
        onText: (delta) => {
          output += delta
        },
        onDiagnostic: () => undefined
      },
      runOptions(),
      authorizeFixture
    )
    expect(output).toBe('Received 🌱: hello')
  })

  it('stops a CLI whose cumulative text output exceeds the durable history limit', async () => {
    await expect(
      runCli(
        provider({
          args: ['-e', 'process.stdout.write("x".repeat(2100000))']
        }),
        'hello',
        process.cwd(),
        new AbortController().signal,
        {
          onText: () => undefined,
          onDiagnostic: () => undefined
        },
        runOptions(),
        authorizeFixture
      )
    ).rejects.toThrow(/text output exceeded/i)
  })

  it('does not spawn a CLI for an already-cancelled run', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      runCli(
        provider({ args: ['-e', 'process.exit(99)'] }),
        'hello',
        process.cwd(),
        controller.signal,
        {
          onText: () => undefined,
          onDiagnostic: () => undefined
        },
        runOptions()
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('authorizes the final expanded argument invocation without exposing prompt text', async () => {
    const secretPrompt = 'fix this & do not reveal $(secret)'
    const authorize = vi.fn<CliInvocationAuthorizer>(async () => {
      throw new Error('authorization stopped for inspection')
    })

    await expect(
      runCli(
        provider({
          args: [
            '--model={model}',
            '--workspace={cwd}',
            '--prompt={prompt}',
            '--dangerously-skip-permissions'
          ],
          promptMode: 'argument',
          cliAdapter: 'claude'
        }),
        secretPrompt,
        process.cwd(),
        new AbortController().signal,
        { onText: () => undefined, onDiagnostic: () => undefined },
        runOptions('claude', {
          mode: 'agent',
          sessionId: 'session-1'
        }),
        authorize
      )
    ).rejects.toThrow('authorization stopped for inspection')

    expect(authorize).toHaveBeenCalledTimes(1)
    const request = authorize.mock.calls[0]?.[0]
    expect(request?.invocationSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(request?.runtimeAdapterId).toBe('anthropic.claude-code')
    expect(request?.cliAdapter).toBe('claude')
    expect(request?.displayArgs).toContain('--model=model-x')
    expect(request?.displayArgs).toContain(`--workspace=${process.cwd()}`)
    expect(request?.displayArgs.join('\n')).toContain('<prompt omitted;')
    expect(request?.displayArgs).toContain('acceptEdits')
    expect(request?.displayArgs).toContain('session-1')
    expect(request?.displayArgs).not.toContain('--dangerously-skip-permissions')
    expect(JSON.stringify(request)).not.toContain(secretPrompt)
    expect(request?.prompt).toMatchObject({
      transport: 'argument',
      byteLength: Buffer.byteLength(secretPrompt)
    })
  })

  it('forwards a delegated runtime identity and rejects a forged built-in dialect pair', async () => {
    const authorize = vi.fn<CliInvocationAuthorizer>(async () => {
      throw new Error('authorization stopped for inspection')
    })
    const generic = provider({ cliAdapter: 'generic' })

    await expect(
      runCli(
        generic,
        'Inspect this workspace.',
        process.cwd(),
        new AbortController().signal,
        { onText: () => undefined, onDiagnostic: () => undefined },
        { runtimeAdapterId: 'community.example-runtime' },
        authorize
      )
    ).rejects.toThrow('authorization stopped for inspection')
    expect(authorize.mock.calls[0]?.[0]).toMatchObject({
      runtimeAdapterId: 'community.example-runtime',
      cliAdapter: 'generic'
    })

    authorize.mockClear()
    await expect(
      runCli(
        generic,
        'Inspect this workspace.',
        process.cwd(),
        new AbortController().signal,
        { onText: () => undefined, onDiagnostic: () => undefined },
        { runtimeAdapterId: 'openai.codex-cli' },
        authorize
      )
    ).rejects.toThrow(/runtime adapter does not match/i)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects an omitted runtime identity before native authorization', async () => {
    const authorize = vi.fn(authorizeFixture)
    await expect(
      runCli(
        provider(),
        'Inspect this workspace.',
        process.cwd(),
        new AbortController().signal,
        { onText: () => undefined, onDiagnostic: () => undefined },
        {} as CliRunOptions,
        authorize
      )
    ).rejects.toThrow(/runtime adapter identity is required/i)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('reuses an stdin launch identity across prompt contents but binds argument prompts', async () => {
    const requests: Array<Parameters<CliInvocationAuthorizer>[0]> = []
    const inspect: CliInvocationAuthorizer = async (request) => {
      requests.push(request)
      throw new Error('inspect only')
    }
    const invoke = async (profile: CliProvider, prompt: string): Promise<void> => {
      await runCli(
        profile,
        prompt,
        process.cwd(),
        new AbortController().signal,
        { onText: () => undefined, onDiagnostic: () => undefined },
        runOptions(profile.cliAdapter ?? 'generic'),
        inspect
      ).catch(() => undefined)
    }

    await invoke(provider({ args: ['agent'], promptMode: 'stdin' }), 'first private prompt')
    await invoke(provider({ args: ['agent'], promptMode: 'stdin' }), 'second private prompt')
    expect(requests[0]?.prompt).toEqual({ transport: 'stdin' })
    expect(requests[1]?.prompt).toEqual({ transport: 'stdin' })
    expect(requests[0]?.runtimeAdapterId).toBe('ground.cli.generic')
    expect(requests[0]?.invocationSha256).toBe(requests[1]?.invocationSha256)

    await invoke(
      provider({ args: ['agent', '{prompt}'], promptMode: 'argument' }),
      'first private prompt'
    )
    await invoke(
      provider({ args: ['agent', '{prompt}'], promptMode: 'argument' }),
      'second private prompt'
    )
    expect(requests[2]?.invocationSha256).not.toBe(requests[3]?.invocationSha256)
  })

  it('rejects malformed resume session identifiers before authorization', async () => {
    const authorize = vi.fn(authorizeFixture)
    await expect(
      runCli(
        provider({ cliAdapter: 'claude' }),
        'continue',
        process.cwd(),
        new AbortController().signal,
        { onText: () => undefined, onDiagnostic: () => undefined },
        runOptions('claude', {
          sessionId: 'valid\n--dangerously-skip-permissions'
        }),
        authorize
      )
    ).rejects.toThrow(/session identifier/i)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('aligns native session identifiers to the canonical 200-character limit', () => {
    expect(() => assertValidCliSessionId(`s${'a'.repeat(199)}`)).not.toThrow()
    expect(() => assertValidCliSessionId(`s${'a'.repeat(200)}`)).toThrow(
      /1-200/
    )
  })

  it('enforces conservative known-runtime arguments and strips bypass flags', () => {
    const codex = expandCliArgs(
      provider({
        cliAdapter: 'codex',
        model: '',
        args: [
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          '--sandbox',
          'danger-full-access',
          '--json',
          '-'
        ]
      }),
      'inspect',
      '/tmp/project',
      { mode: 'ask' }
    )
    expect(codex.args).toEqual(['exec', '--json', '--sandbox', 'read-only', '-'])

    const claude = expandCliArgs(
      provider({
        cliAdapter: 'claude',
        model: '',
        args: ['-p', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
      }),
      'inspect',
      '/tmp/project',
      { mode: 'ask', sessionId: 'claude-session' }
    )
    expect(claude.args).toEqual([
      '-p',
      '--permission-mode',
      'plan',
      '--resume',
      'claude-session'
    ])

    const gemini = expandCliArgs(
      provider({
        cliAdapter: 'gemini',
        model: '',
        promptMode: 'argument',
        args: ['-p', '{prompt}', '--yolo', '--skip-trust', '--approval-mode', 'yolo']
      }),
      'inspect',
      '/tmp/project',
      { mode: 'agent', sessionId: 'gemini-session' }
    )
    expect(gemini.args).toEqual([
      '-p',
      'inspect',
      '--approval-mode',
      'auto_edit',
      '--resume',
      'gemini-session'
    ])
  })

  it('constructs policy-bound native Codex resume invocations with parent options before resume', () => {
    const agent = expandCliArgs(
      provider({
        cliAdapter: 'codex',
        model: '',
        args: [
          'exec',
          '--json',
          '--color',
          'never',
          '--dangerously-bypass-approvals-and-sandbox',
          '--sandbox',
          'danger-full-access',
          '-'
        ]
      }),
      'continue',
      '/tmp/project',
      { mode: 'agent', sessionId: '019faa00-session' }
    )
    expect(agent.args).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '--sandbox',
      'workspace-write',
      'resume',
      '019faa00-session',
      '-'
    ])
    expect(agent.stdin).toBe('continue')

    const ask = expandCliArgs(
      provider({
        cliAdapter: 'codex',
        model: '',
        args: ['exec', '--json', '--sandbox=workspace-write', '-']
      }),
      'continue',
      '/tmp/project',
      { mode: 'ask', sessionId: '019faa00-session' }
    )
    expect(ask.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      'resume',
      '019faa00-session',
      '-'
    ])
  })

  it('applies model overrides to recognized initial and resumed CLI invocations', () => {
    const codex = provider({
      cliAdapter: 'codex',
      model: 'gpt-ground',
      args: ['exec', '--json', '--color', 'never', '-']
    })
    expect(
      expandCliArgs(codex, 'start', '/tmp/project', { mode: 'agent' }).args
    ).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '--model',
      'gpt-ground',
      '--sandbox',
      'workspace-write',
      '-'
    ])
    expect(
      expandCliArgs(codex, 'continue', '/tmp/project', {
        mode: 'ask',
        sessionId: 'codex-session'
      }).args
    ).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '--model',
      'gpt-ground',
      '--sandbox',
      'read-only',
      'resume',
      'codex-session',
      '-'
    ])

    const claude = expandCliArgs(
      provider({
        cliAdapter: 'claude',
        model: 'claude-ground',
        args: ['-p', '--output-format', 'stream-json']
      }),
      'continue',
      '/tmp/project',
      { mode: 'agent', sessionId: 'claude-session' }
    )
    expect(claude.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--model',
      'claude-ground',
      '--permission-mode',
      'acceptEdits',
      '--resume',
      'claude-session'
    ])

    const gemini = expandCliArgs(
      provider({
        cliAdapter: 'gemini',
        model: 'gemini-ground',
        promptMode: 'argument',
        args: ['-p', '{prompt}', '--output-format', 'stream-json']
      }),
      'continue',
      '/tmp/project',
      { mode: 'agent', sessionId: 'gemini-session' }
    )
    expect(gemini.args).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--model',
      'gemini-ground',
      '--approval-mode',
      'auto_edit',
      '--resume',
      'gemini-session'
    ])
  })

  it('rejects ambiguous Codex native-resume templates', () => {
    expect(() =>
      expandCliArgs(
        provider({
          cliAdapter: 'codex',
          args: ['exec', 'resume', '{sessionId}', '-']
        }),
        'continue',
        '/tmp/project',
        { mode: 'ask', sessionId: '019faa00-session' }
      )
    ).toThrow('unambiguous')

    expect(() =>
      expandCliArgs(
        provider({
          cliAdapter: 'codex',
          promptMode: 'argument',
          args: ['exec', '--json', '{prompt}']
        }),
        'continue',
        '/tmp/project',
        { mode: 'ask', sessionId: '019faa00-session' }
      )
    ).toThrow('unambiguous')
  })

  it('normalizes Codex session, assistant, command, and usage events', () => {
    expect(
      parseCliRuntimeEvent('codex', {
        type: 'thread.started',
        thread_id: 'thread-1'
      })
    ).toEqual([{ type: 'session', sessionId: 'thread-1' }])

    expect(
      parseCliRuntimeEvent('codex', {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Done' }
      })
    ).toEqual([{ type: 'text', delta: 'Done', final: true }])

    expect(
      parseCliRuntimeEvent('codex', {
        type: 'item.completed',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'passed',
          exit_code: 0
        }
      })
    ).toEqual([
      {
        type: 'activity',
        activity: {
          runtimeId: 'codex:command-1',
          activityType: 'command',
          title: 'npm test',
          detail: '"passed"',
          status: 'success'
        }
      }
    ])

    expect(
      parseCliRuntimeEvent('codex', {
        type: 'turn.completed',
        usage: {
          input_tokens: 120,
          cached_input_tokens: 90,
          output_tokens: 12,
          reasoning_output_tokens: 5
        }
      })
    ).toEqual([
      {
        type: 'activity',
        activity: {
          runtimeId: 'codex:turn',
          activityType: 'status',
          title: 'Codex turn',
          status: 'success'
        }
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 120,
          outputTokens: 12,
          cachedInputTokens: 90,
          reasoningTokens: 5
        }
      }
    ])
  })

  it('normalizes Claude and Gemini streaming dialects', () => {
    expect(
      parseCliRuntimeEvent('claude', {
        type: 'stream_event',
        session_id: 'claude-1',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' }
        }
      })
    ).toEqual([
      { type: 'session', sessionId: 'claude-1' },
      { type: 'text', delta: 'hello' }
    ])

    expect(
      parseCliRuntimeEvent('claude', {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'npm test' }
          }
        }
      })
    ).toEqual([
      {
        type: 'activity',
        activity: {
          runtimeId: 'claude:toolu_1',
          activityType: 'command',
          title: 'Bash',
          detail: '{"command":"npm test"}',
          status: 'running'
        }
      }
    ])

    expect(
      parseCliRuntimeEvent('gemini', {
        type: 'tool_use',
        session_id: 'gemini-1',
        tool_id: 'shell-1',
        tool_name: 'run_shell_command',
        parameters: { command: 'npm test' }
      })
    ).toEqual([
      { type: 'session', sessionId: 'gemini-1' },
      {
        type: 'activity',
        activity: {
          runtimeId: 'gemini:shell-1',
          activityType: 'command',
          title: 'run_shell_command',
          detail: '{"command":"npm test"}',
          status: 'running'
        }
      }
    ])

    expect(
      parseCliRuntimeEvent('gemini', {
        type: 'tool_result',
        tool_id: 'shell-1',
        status: 'success',
        output: 'passed'
      })
    ).toEqual([
      {
        type: 'activity',
        activity: {
          runtimeId: 'gemini:shell-1',
          activityType: 'tool',
          title: 'Gemini tool result',
          detail: '"passed"',
          status: 'success'
        }
      }
    ])

    expect(
      parseCliRuntimeEvent('gemini', {
        type: 'result',
        status: 'success',
        stats: {
          input_tokens: 10,
          output_tokens: 4,
          cached: 3,
          total_tokens: 14
        }
      })
    ).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 3,
          totalTokens: 14
        }
      }
    ])
  })

  it('inherits only adapter-scoped authentication and reviewed network variables', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/tester',
      CODEX_API_KEY: 'codex-secret',
      CODEX_ACCESS_TOKEN: 'codex-access-token',
      CODEX_CA_CERTIFICATE: '/etc/codex-ca.pem',
      OPENAI_API_KEY: 'openai-secret',
      OPENAI_ORGANIZATION: 'openai-org',
      OPENAI_PROJECT: 'openai-project',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
      GEMINI_API_KEY: 'gemini-secret',
      GOOGLE_API_KEY: 'google-secret',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
      HTTPS_PROXY: 'https://proxy.example.test',
      NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
      AWS_SECRET_ACCESS_KEY: 'must-not-inherit',
      DATABASE_URL: 'must-not-inherit'
    }

    const codex = safeCliEnvironment('codex', source, 'linux')
    expect(codex.CODEX_API_KEY).toBe('codex-secret')
    expect(codex.CODEX_ACCESS_TOKEN).toBe('codex-access-token')
    expect(codex.CODEX_CA_CERTIFICATE).toBe('/etc/codex-ca.pem')
    expect(codex.OPENAI_API_KEY).toBe('openai-secret')
    expect(codex.OPENAI_ORGANIZATION).toBe('openai-org')
    expect(codex.OPENAI_PROJECT).toBe('openai-project')
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined()
    expect(codex.GEMINI_API_KEY).toBeUndefined()
    expect(codex.HTTPS_PROXY).toBe('https://proxy.example.test')
    expect(codex.NODE_EXTRA_CA_CERTS).toBe('/etc/company-ca.pem')
    expect(codex.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(codex.DATABASE_URL).toBeUndefined()

    const claude = safeCliEnvironment('claude', source, 'linux')
    expect(claude.ANTHROPIC_API_KEY).toBe('anthropic-secret')
    expect(claude.ANTHROPIC_AUTH_TOKEN).toBe('anthropic-token')
    expect(claude.OPENAI_API_KEY).toBeUndefined()
    expect(claude.GEMINI_API_KEY).toBeUndefined()

    const gemini = safeCliEnvironment('gemini', source, 'linux')
    expect(gemini.GEMINI_API_KEY).toBe('gemini-secret')
    expect(gemini.GOOGLE_API_KEY).toBe('google-secret')
    expect(gemini.GOOGLE_CLOUD_LOCATION).toBe('us-central1')
    expect(gemini.OPENAI_API_KEY).toBeUndefined()
    expect(gemini.ANTHROPIC_API_KEY).toBeUndefined()

    const generic = safeCliEnvironment('generic', source, 'linux')
    expect(generic.CODEX_API_KEY).toBeUndefined()
    expect(generic.OPENAI_API_KEY).toBeUndefined()
    expect(generic.ANTHROPIC_API_KEY).toBeUndefined()
    expect(generic.GEMINI_API_KEY).toBeUndefined()
    expect(generic.HTTPS_PROXY).toBe('https://proxy.example.test')
  })

  it('does not forward inherited sensitive values too short to redact safely', () => {
    const environment = safeCliEnvironment(
      'codex',
      {
        PATH: '/usr/bin',
        CODEX_API_KEY: 'abc',
        HTTPS_PROXY: 'x'
      },
      'linux'
    )
    expect(environment.CODEX_API_KEY).toBeUndefined()
    expect(environment.HTTPS_PROXY).toBeUndefined()
  })

  it('redacts an inherited adapter credential if the CLI echoes it', async () => {
    const previous = process.env.CODEX_API_KEY
    const secret = 'sk-ground-cli-environment-secret'
    process.env.CODEX_API_KEY = secret
    let output = ''
    try {
      await runCli(
        provider({
          cliAdapter: 'codex',
          model: '',
          args: [
            '-e',
            'const key=process.env.CODEX_API_KEY??"missing";process.stdout.write(key.slice(0,9));setTimeout(()=>process.stdout.write(key.slice(9)),5)',
            'exec',
            '-'
          ]
        }),
        'hello',
        process.cwd(),
        new AbortController().signal,
        {
          onText: (delta) => {
            output += delta
          },
          onDiagnostic: () => undefined
        },
        runOptions('codex'),
        authorizeFixture
      )
    } finally {
      if (previous === undefined) delete process.env.CODEX_API_KEY
      else process.env.CODEX_API_KEY = previous
    }

    expect(output).toContain(REDACTION_MARKER)
    expect(output).not.toContain(secret)
  })

  it('binds encrypted profile environment metadata and redacts custom values', async () => {
    const secret = 'enterprise-cli-secret'
    const fingerprint = 'e'.repeat(64)
    let output = ''
    const authorize = vi.fn(authorizeFixture)
    await runCli(
      provider({
        model: '',
        args: [
          '-e',
          'process.stdout.write(process.env.ACME_AGENT_TOKEN ?? "missing")'
        ],
        environmentVariables: ['ACME_AGENT_TOKEN'],
        environmentFingerprint: fingerprint
      }),
      'hello',
      process.cwd(),
      new AbortController().signal,
      {
        onText: (delta) => {
          output += delta
        },
        onDiagnostic: () => undefined
      },
      runOptions(),
      authorize,
      { ACME_AGENT_TOKEN: secret }
    )

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeAdapterId: 'ground.cli.generic',
        cliAdapter: 'generic',
        environmentVariables: ['ACME_AGENT_TOKEN'],
        environmentFingerprint: fingerprint
      })
    )
    expect(output).toContain(REDACTION_MARKER)
    expect(output).not.toContain(secret)
  })

  it('refuses a secret-bearing saved session before native authorization', async () => {
    const secret = 'saved-session-secret'
    const authorize = vi.fn(authorizeFixture)
    await expect(
      runCli(
        provider({
          cliAdapter: 'codex',
          model: '',
          args: ['-e', 'process.exit(0)', 'exec', '-'],
          environmentVariables: ['ACME_AGENT_TOKEN'],
          environmentFingerprint: 'a'.repeat(64)
        }),
        'hello',
        process.cwd(),
        new AbortController().signal,
        {
          onText: () => undefined,
          onDiagnostic: () => undefined
        },
        runOptions('codex', { sessionId: secret }),
        authorize,
        { ACME_AGENT_TOKEN: secret }
      )
    ).rejects.toThrow(/refused to resume/i)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('fails closed when a runtime reports a credential as its session ID', async () => {
    const secret = 'reported-session-secret'
    const onSession = vi.fn()
    await expect(
      runCli(
        provider({
          cliAdapter: 'codex',
          model: '',
          args: [
            '-e',
            `process.stdout.write(JSON.stringify({type:"thread.started",thread_id:process.env.ACME_AGENT_TOKEN})+"\\n")`,
            'exec',
            '-'
          ],
          outputMode: 'ndjson',
          environmentVariables: ['ACME_AGENT_TOKEN'],
          environmentFingerprint: 'b'.repeat(64)
        }),
        'hello',
        process.cwd(),
        new AbortController().signal,
        {
          onText: () => undefined,
          onDiagnostic: () => undefined,
          onSession
        },
        runOptions('codex'),
        authorizeFixture,
        { ACME_AGENT_TOKEN: secret }
      )
    ).rejects.toThrow(/session identifier disclosed/i)
    expect(onSession).not.toHaveBeenCalled()
  })

  it('redacts and then bounds structured activity fields, including JSON escapes', async () => {
    const titleSecret = 'activity-title-secret'
    const detailSecret = 'quoted"slash\\line\nnext'
    const runtimeSecret = 'runtime-secret'
    const boundarySecret = 'boundary-secret'
    const activities: Array<{
      runtimeId?: string
      title: string
      detail?: string
    }> = []
    const source = [
      'const emit=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");',
      'emit({type:"item.started",item:{id:process.env.RUNTIME_SECRET,type:"command_execution",command:process.env.TITLE_SECRET,changes:{value:process.env.DETAIL_SECRET}}});',
      'emit({type:"item.started",item:{id:"bounded-activity",type:"command_execution",command:process.env.TITLE_REPEAT.repeat(300),changes:"x".repeat(3998)+process.env.BOUNDARY_SECRET}});'
    ].join('')
    await runCli(
      provider({
        cliAdapter: 'codex',
        model: '',
        args: ['-e', source, 'exec', '-'],
        outputMode: 'ndjson',
        environmentVariables: [
          'BOUNDARY_SECRET',
          'DETAIL_SECRET',
          'RUNTIME_SECRET',
          'TITLE_REPEAT',
          'TITLE_SECRET'
        ],
        environmentFingerprint: 'c'.repeat(64)
      }),
      'hello',
      process.cwd(),
      new AbortController().signal,
      {
        onText: () => undefined,
        onDiagnostic: () => undefined,
        onActivity: (activity) => activities.push(activity)
      },
      runOptions('codex'),
      authorizeFixture,
      {
        BOUNDARY_SECRET: boundarySecret,
        DETAIL_SECRET: detailSecret,
        RUNTIME_SECRET: runtimeSecret,
        TITLE_REPEAT: 'aaaa',
        TITLE_SECRET: titleSecret
      }
    )

    expect(activities).toHaveLength(2)
    expect(activities[0]).toMatchObject({
      runtimeId: undefined,
      title: REDACTION_MARKER
    })
    expect(activities[0]?.detail).toContain(REDACTION_MARKER)
    expect(activities[0]?.detail).not.toContain(detailSecret)
    expect(activities[0]?.detail).not.toContain(
      JSON.stringify(detailSecret).slice(1, -1)
    )
    expect(activities[1]?.runtimeId).toBe('codex:bounded-activity')
    expect(activities[1]?.title.length).toBe(500)
    expect(activities[1]?.detail?.length).toBe(4_000)
    expect(activities[1]?.detail).not.toContain(boundarySecret)
    expect(activities[1]?.detail).not.toContain('boundary-')
    const serialized = JSON.stringify(activities)
    for (const secret of [
      titleSecret,
      detailSecret,
      runtimeSecret,
      boundarySecret
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('redacts escaped diagnostics before applying their display bound', async () => {
    const secret = 'quoted"diagnostic\\secret'
    let diagnostic = ''
    await runCli(
      provider({
        model: '',
        args: [
          '-e',
          `process.stdout.write("not-json:"+JSON.stringify(process.env.ACME_AGENT_TOKEN)+"\\n")`
        ],
        outputMode: 'ndjson',
        environmentVariables: ['ACME_AGENT_TOKEN'],
        environmentFingerprint: 'd'.repeat(64)
      }),
      'hello',
      process.cwd(),
      new AbortController().signal,
      {
        onText: () => undefined,
        onDiagnostic: (value) => {
          diagnostic += value
        }
      },
      runOptions(),
      authorizeFixture,
      { ACME_AGENT_TOKEN: secret }
    )
    expect(diagnostic.length).toBeLessThanOrEqual(500)
    expect(diagnostic).toContain(REDACTION_MARKER)
    expect(diagnostic).not.toContain(secret)
    expect(diagnostic).not.toContain(JSON.stringify(secret).slice(1, -1))
  })

  it('uses a collision-free marker that cannot recreate another secret', async () => {
    const customEnvironment = {
      FIRST_SECRET: 'enterprise-secret',
      MARKER_WORD: 'credential',
      OTHER_MARKER_WORD: 'redacted',
      BLOCK_SECRET: '████',
      JOINED_SECRET: 'ABCD'
    }
    let output = ''
    await runCli(
      provider({
        model: '',
        args: [
          '-e',
          `process.stdout.write(process.env.FIRST_SECRET+"AB"+process.env.FIRST_SECRET+"CD")`
        ],
        environmentVariables: Object.keys(customEnvironment).sort(),
        environmentFingerprint: 'e'.repeat(64)
      }),
      'hello',
      process.cwd(),
      new AbortController().signal,
      {
        onText: (delta) => {
          output += delta
        },
        onDiagnostic: () => undefined
      },
      runOptions(),
      authorizeFixture,
      customEnvironment
    )
    for (const secret of Object.values(customEnvironment)) {
      expect(output).not.toContain(secret)
    }
  })

  it('rejects custom environment values that cannot be redacted safely', () => {
    expect(() =>
      safeCliEnvironment(
        'generic',
        { PATH: '/usr/bin' },
        'linux',
        { ACME_TOGGLE: '1' }
      )
    ).toThrow(/invalid value/i)
  })

  it('never expands durable text characters while redacting credentials', async () => {
    let output = ''
    await runCli(
      provider({
        model: '',
        args: ['-e', 'process.stdout.write("aaaa".repeat(150000))'],
        environmentVariables: ['ACME_AGENT_TOKEN'],
        environmentFingerprint: 'f'.repeat(64)
      }),
      'hello',
      process.cwd(),
      new AbortController().signal,
      {
        onText: (delta) => {
          output += delta
        },
        onDiagnostic: () => undefined
      },
      runOptions(),
      authorizeFixture,
      { ACME_AGENT_TOKEN: 'aaaa' }
    )
    expect(output).toHaveLength(600_000)
    expect(output).not.toContain('aaaa')
  })
})
