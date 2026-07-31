import type { CliAdapter, CliProvider } from '../../shared/types'
import {
  BUILT_IN_CLI_RUNTIME_BINDINGS,
  BUILT_IN_CLI_RUNTIME_DIALECTS
} from '../cli-runtime-bindings'
import {
  normalizeCliEnvironmentVariableNames,
  resolveCliEnvironmentWithSecretResolver
} from '../cli-environment'
import {
  assertValidCliSessionId,
  CliProcessExitError,
  CliProtocolError,
  runCli,
  type CliActivity,
  type CliInvocationAuthorizer,
  type CliRunResult,
  type CliUsage
} from '../providers/cli'
import { mergeAgentRuntimeCapabilities } from './capabilities'
import type {
  AdapterContext,
  AgentRuntimeAdapter,
  AgentRuntimeInspection
} from './contracts'
import { MAX_NORMALIZED_COST_USD } from './event-stream'
import {
  ProviderError,
  protocolProviderError,
  toProviderError
} from './errors'
import type {
  AgentActivityKind,
  AgentRunRequest,
  AgentRuntimeEvent,
  TokenUsage
} from './types'
import { z } from 'zod'

const MAX_CLI_ARGUMENT_CHARACTERS = 32_000
const MAX_DIAGNOSTIC_NOTICE_CHARACTERS = 10_000

function cliRuntimeFailure(
  error: unknown,
  signal: AbortSignal
): unknown {
  // Preserve the adapter contract's native AbortError. The outer conformance
  // layer owns cancellation normalization after iterator cleanup.
  if (signal.aborted) return error
  if (error instanceof ProviderError) return error
  if (error instanceof CliProtocolError) {
    return protocolProviderError(error.message, error)
  }
  if (error instanceof CliProcessExitError) {
    return new ProviderError(error.message, {
      category: 'process-exit',
      retryable: false,
      cause: error
    })
  }
  const code =
    error && typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code.toUpperCase()
      : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ProviderError(
      error instanceof Error ? error.message : 'CLI executable was not found',
      {
        category: 'executable-not-found',
        retryable: false,
        providerCode: code,
        cause: error
      }
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ProviderError(
      error instanceof Error ? error.message : 'CLI process could not start',
      {
        category: 'process-exit',
        retryable: false,
        providerCode: code,
        cause: error
      }
    )
  }
  return toProviderError(error, { signal })
}

export * from '../cli-runtime-bindings'

const CLI_PROVIDER_SCHEMA = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(80),
    kind: z.literal('cli'),
    model: z.string().max(200),
    command: z
      .string()
      .min(1)
      .max(8_192)
      .refine((value) => !value.includes('\0'), {
        message: 'CLI command cannot contain null bytes'
      }),
    args: z.array(
      z.string().max(8_192).refine((value) => !value.includes('\0'), {
        message: 'CLI arguments cannot contain null bytes'
      })
    ).max(64),
    promptMode: z.enum(['stdin', 'argument']),
    outputMode: z.enum(['plain', 'ndjson']),
    cliAdapter: z
      .enum(['generic', 'codex', 'claude', 'gemini', 'antigravity'])
      .optional(),
    environmentVariables: z.array(z.string().min(1).max(128)).max(32).optional(),
    environmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    environmentRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    trustConfirmed: z.literal(true),
    createdAt: z.string().min(1).max(100),
    updatedAt: z.string().min(1).max(100)
  })
  .strict()
  .superRefine((provider, context) => {
    const argumentCharacters = provider.args.reduce(
      (total, argument) => total + argument.length,
      0
    )
    if (argumentCharacters > MAX_CLI_ARGUMENT_CHARACTERS) {
      context.addIssue({
        code: 'custom',
        message: 'CLI arguments are too large to review safely',
        path: ['args']
      })
    }
    const hasVariables = Boolean(provider.environmentVariables?.length)
    const hasFingerprint = provider.environmentFingerprint !== undefined
    if (hasVariables !== hasFingerprint) {
      context.addIssue({
        code: 'custom',
        message:
          'CLI environment variables and fingerprint must be configured together',
        path: hasVariables
          ? ['environmentFingerprint']
          : ['environmentVariables']
      })
    }
    try {
      normalizeCliEnvironmentVariableNames(
        provider.environmentVariables ?? []
      )
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message:
          error instanceof Error
            ? error.message
            : 'CLI environment variables are invalid',
        path: ['environmentVariables']
      })
    }
    if (!hasVariables && provider.environmentRevision !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'CLI environment revision requires environment variables',
        path: ['environmentRevision']
      })
    }
  })

export type CliRuntimeRunner = (
  provider: CliProvider,
  prompt: string,
  workspacePath: string,
  signal: AbortSignal,
  callbacks: Parameters<typeof runCli>[4],
  options: Parameters<typeof runCli>[5],
  authorizeInvocation: CliInvocationAuthorizer,
  customEnvironment: Readonly<Record<string, string>>
) => Promise<CliRunResult>

interface ActivityState {
  id: string
  open: boolean
}

class AgentRuntimeEventQueue {
  private readonly events: AgentRuntimeEvent[] = []
  private waiter:
    | {
        resolve: (result: IteratorResult<AgentRuntimeEvent>) => void
        reject: (error: unknown) => void
      }
    | undefined
  private closed = false
  private failure: unknown
  private failed = false

  push(event: AgentRuntimeEvent): void {
    if (this.closed) return
    const waiter = this.waiter
    if (waiter) {
      this.waiter = undefined
      waiter.resolve({ done: false, value: event })
      return
    }
    this.events.push(event)
  }

  close(error?: unknown): void {
    if (this.closed) return
    this.closed = true
    if (error !== undefined) {
      this.failed = true
      this.failure = error
    }
    this.settleWaiter()
  }

  next(): Promise<IteratorResult<AgentRuntimeEvent>> {
    const event = this.events.shift()
    if (event) return Promise.resolve({ done: false, value: event })
    if (this.closed) {
      return this.failed
        ? Promise.reject(this.failure)
        : Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  private settleWaiter(): void {
    if (!this.waiter || this.events.length) return
    const waiter = this.waiter
    this.waiter = undefined
    if (this.failed) {
      waiter.reject(this.failure)
    } else {
      waiter.resolve({ done: true, value: undefined })
    }
  }
}

class DiagnosticAccumulator {
  private tail = ''
  private truncated = false

  append(detail: string): void {
    if (!detail) return
    const combined = `${this.tail}${detail}`
    if (combined.length <= MAX_DIAGNOSTIC_NOTICE_CHARACTERS) {
      this.tail = combined
      return
    }
    this.truncated = true
    this.tail = combined.slice(-MAX_DIAGNOSTIC_NOTICE_CHARACTERS)
  }

  notice(): Extract<AgentRuntimeEvent, { type: 'provider.notice' }> | undefined {
    const detail = this.tail.trim()
    if (!detail) return undefined
    const prefix = this.truncated
      ? 'Earlier CLI diagnostics were truncated.\n'
      : ''
    return {
      type: 'provider.notice',
      level: 'warning',
      code: 'cli.diagnostics',
      message: `${prefix}${detail.slice(
        -(MAX_DIAGNOSTIC_NOTICE_CHARACTERS - prefix.length)
      )}`
    }
  }
}

class ActivityNormalizer {
  private readonly byRuntimeId = new Map<string, ActivityState>()
  private readonly openActivities = new Map<string, ActivityState>()
  private readonly allocatedIds = new Set<string>()
  private nextId = 0

  constructor(private readonly queue: AgentRuntimeEventQueue) {}

  push(activity: CliActivity): void {
    let state = activity.runtimeId
      ? this.byRuntimeId.get(activity.runtimeId)
      : undefined
    if (state && !state.open) return

    if (!state) {
      state = {
        id: this.allocateId(activity.runtimeId),
        open: true
      }
      if (activity.runtimeId) {
        this.byRuntimeId.set(activity.runtimeId, state)
      }
      this.openActivities.set(state.id, state)
      this.queue.push({
        type: 'activity.started',
        activityId: state.id,
        kind: activityKind(activity.activityType),
        title: activity.title,
        detail: activity.detail
      })
    } else if (activity.status === 'running') {
      this.queue.push({
        type: 'activity.updated',
        activityId: state.id,
        detail: activity.detail
      })
    }

    if (activity.status !== 'running') {
      this.complete(
        state,
        activity.status === 'success' ? 'success' : 'error',
        activity.detail
      )
    }
  }

  finish(status: 'success' | 'error', detail?: string): void {
    for (const state of [...this.openActivities.values()]) {
      this.complete(state, status, detail)
    }
  }

  private complete(
    state: ActivityState,
    status: 'success' | 'error',
    detail?: string
  ): void {
    if (!state.open) return
    state.open = false
    this.openActivities.delete(state.id)
    this.queue.push({
      type: 'activity.completed',
      activityId: state.id,
      status,
      detail
    })
  }

  private allocateId(preferred?: string): string {
    if (preferred && !this.allocatedIds.has(preferred)) {
      this.allocatedIds.add(preferred)
      return preferred
    }
    let generated: string
    do {
      generated = `ground:cli-activity:${++this.nextId}`
    } while (this.allocatedIds.has(generated))
    this.allocatedIds.add(generated)
    return generated
  }
}

function activityKind(
  activityType: CliActivity['activityType']
): AgentActivityKind {
  if (activityType === 'command') return 'command'
  if (activityType === 'tool') return 'tool'
  return 'diagnostic'
}

function selectedModel(
  request: AgentRunRequest,
  provider: CliProvider
): string {
  if (request.model === undefined) return provider.model
  return z.string().max(200).parse(request.model)
}

const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'totalTokens'
] as const satisfies ReadonlyArray<keyof CliUsage & keyof TokenUsage>

function cumulativeCliUsage(
  current: TokenUsage | undefined,
  candidate: CliUsage
): TokenUsage | undefined {
  const next: TokenUsage = current ? { ...current } : {}
  let hasUsage = Boolean(current)
  for (const key of USAGE_KEYS) {
    const value = candidate[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      continue
    }
    hasUsage = true
    next[key] = Math.max(next[key] ?? 0, Math.floor(value))
  }
  if (
    typeof candidate.costUsd === 'number' &&
    Number.isFinite(candidate.costUsd) &&
    candidate.costUsd >= 0 &&
    candidate.costUsd <= MAX_NORMALIZED_COST_USD
  ) {
    hasUsage = true
    next.costUsd = Math.max(next.costUsd ?? 0, candidate.costUsd)
  }
  if (next.inputTokens !== undefined || next.outputTokens !== undefined) {
    next.totalTokens = Math.max(
      next.totalTokens ?? 0,
      (next.inputTokens ?? 0) + (next.outputTokens ?? 0)
    )
  }
  return hasUsage ? next : undefined
}

function usageChanged(
  previous: TokenUsage | undefined,
  next: TokenUsage | undefined
): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next)
}

export class CliRuntimeAdapter implements AgentRuntimeAdapter<CliProvider> {
  readonly id: string

  constructor(
    readonly dialect: CliAdapter,
    private readonly authorizeInvocation: CliInvocationAuthorizer,
    private readonly cliRunner: CliRuntimeRunner = runCli
  ) {
    this.id = BUILT_IN_CLI_RUNTIME_BINDINGS[dialect].adapterId
  }

  validateConfig(value: unknown): CliProvider {
    const parsed = CLI_PROVIDER_SCHEMA.parse(value)
    const configuredDialect = parsed.cliAdapter ?? 'generic'
    const binding = BUILT_IN_CLI_RUNTIME_BINDINGS[this.dialect]
    if (
      configuredDialect !== this.dialect ||
      binding.adapterId !== this.id
    ) {
      throw new Error(
        `Adapter ${this.id} cannot load ${configuredDialect} CLI configuration`
      )
    }
    return Object.freeze({
      ...parsed,
      args: Object.freeze([...parsed.args]) as unknown as string[],
      cliAdapter: configuredDialect,
      ...(parsed.environmentVariables
        ? {
            environmentVariables: Object.freeze([
              ...parsed.environmentVariables
            ]) as unknown as string[]
          }
        : {})
    })
  }

  async inspect(
    context: AdapterContext<CliProvider>
  ): Promise<AgentRuntimeInspection> {
    context.signal.throwIfAborted()
    const provider = this.validateConfig(context.config)
    const structured = provider.outputMode === 'ndjson'
    const recognized = this.dialect !== 'generic'
    return {
      ...(provider.model
        ? {
            models: [
              {
                id: provider.model,
                name: provider.model
              }
            ]
          }
        : {}),
      capabilities: mergeAgentRuntimeCapabilities({
        structuredEvents: structured ? 'native' : 'emulated',
        sessionResume: recognized ? 'native' : 'unsupported',
        assistantStreaming: 'native',
        toolActivities: recognized ? 'native' : 'unsupported',
        commandActivities: recognized ? 'native' : 'unsupported',
        fileActivities: 'unknown',
        usageReporting: recognized ? 'native' : 'unsupported',
        interactiveApprovals:
          this.dialect === 'antigravity'
            ? 'unsupported'
            : recognized
              ? 'native'
              : 'unknown',
        cancellation: 'process-signal',
        permissionOwner: 'runtime'
      })
    }
  }

  async *run(
    request: AgentRunRequest,
    context: AdapterContext<CliProvider>
  ): AsyncIterable<AgentRuntimeEvent> {
    const provider = this.validateConfig(context.config)
    const model = selectedModel(request, provider)
    const binding = BUILT_IN_CLI_RUNTIME_BINDINGS[this.dialect]
    if (
      request.resume &&
      !('sessionCompatibilityId' in binding)
    ) {
      throw new Error(`${this.id} does not support native session resume`)
    }
    context.signal.throwIfAborted()
    yield {
      type: 'runtime.started',
      sessionId: request.resume?.sessionId,
      servingModel: model || undefined
    }

    const localController = new AbortController()
    const signal = AbortSignal.any([
      context.signal,
      localController.signal
    ])
    const queue = new AgentRuntimeEventQueue()
    const execution = this.execute(
      request,
      {
        ...provider,
        model
      },
      context,
      signal,
      queue
    )

    try {
      while (true) {
        const result = await queue.next()
        if (result.done) break
        yield result.value
      }
    } finally {
      if (!localController.signal.aborted) {
        localController.abort(
          new DOMException('Runtime event consumer closed', 'AbortError')
        )
      }
      await execution
    }
  }

  private async execute(
    request: AgentRunRequest,
    provider: CliProvider,
    context: AdapterContext<CliProvider>,
    signal: AbortSignal,
    queue: AgentRuntimeEventQueue
  ): Promise<void> {
    const diagnostics = new DiagnosticAccumulator()
    const activities = new ActivityNormalizer(queue)
    let sessionId = request.resume?.sessionId
    let usage: TokenUsage | undefined

    const emitUsage = (candidate: CliUsage): void => {
      if (
        candidate.costUsd !== undefined &&
        (
          typeof candidate.costUsd !== 'number' ||
          !Number.isFinite(candidate.costUsd) ||
          candidate.costUsd < 0 ||
          candidate.costUsd > MAX_NORMALIZED_COST_USD
        )
      ) {
        diagnostics.append(
          'Ground ignored an invalid CLI cost usage value.\n'
        )
      }
      const next = cumulativeCliUsage(usage, candidate)
      if (!usageChanged(usage, next)) return
      usage = next
      if (usage) {
        queue.push({
          type: 'usage.updated',
          usage: { ...usage },
          semantics: 'cumulative'
        })
      }
    }
    const emitDiagnostics = (): void => {
      const notice = diagnostics.notice()
      if (notice) queue.push(notice)
    }

    try {
      signal.throwIfAborted()
      const environment = await resolveCliEnvironmentWithSecretResolver(
        context.secrets,
        provider
      )
      signal.throwIfAborted()
      const result = await this.cliRunner(
        provider,
        request.prompt,
        request.workspacePath,
        signal,
        {
          onText: (delta) => {
            if (delta) queue.push({ type: 'assistant.delta', delta })
          },
          onDiagnostic: (detail) => {
            diagnostics.append(detail)
          },
          onSession: (nextSessionId) => {
            assertValidCliSessionId(nextSessionId)
            if (
              request.resume &&
              nextSessionId !== request.resume.sessionId
            ) {
              throw new Error(
                `${this.id} changed the native session identifier during resume`
              )
            }
            sessionId = nextSessionId
          },
          onActivity: (activity) => {
            activities.push(activity)
          },
          onUsage: emitUsage
        },
        {
          mode: request.mode,
          sessionId: request.resume?.sessionId,
          runtimeAdapterId: this.id
        },
        this.authorizeInvocation,
        environment
      )
      signal.throwIfAborted()
      if (result.sessionId) {
        assertValidCliSessionId(result.sessionId)
        if (
          request.resume &&
          result.sessionId !== request.resume.sessionId
        ) {
          throw new Error(
            `${this.id} changed the native session identifier during resume`
          )
        }
        sessionId = result.sessionId
      }
      if (result.usage) emitUsage(result.usage)
      activities.finish('success')
      emitDiagnostics()
      queue.push({
        type: 'runtime.completed',
        sessionId,
        stopReason: 'complete',
        usage: usage ? { ...usage } : undefined
      })
      queue.close()
    } catch (error) {
      activities.finish(
        'error',
        signal.aborted
          ? 'The CLI runtime was cancelled before reporting completion.'
          : 'The CLI runtime ended before reporting completion.'
      )
      emitDiagnostics()
      queue.close(cliRuntimeFailure(error, signal))
    }
  }
}

export function createBuiltInCliRuntimeAdapters(
  authorizeInvocation: CliInvocationAuthorizer
): readonly CliRuntimeAdapter[] {
  return Object.freeze(
    BUILT_IN_CLI_RUNTIME_DIALECTS.map(
      (dialect) => new CliRuntimeAdapter(dialect, authorizeInvocation)
    )
  )
}
