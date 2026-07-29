import type {
  AgentRuntimeCapabilities,
  CapabilitySupport,
  ModelCapabilities
} from './capabilities'
import type {
  AdapterContext,
  AgentRuntimeAdapter,
  AgentRuntimeInspection,
  ModelAdapter,
  ModelAdapterInspection,
  SecretResolver
} from './contracts'
import {
  ProviderError,
  cancelledProviderError,
  isAbortLikeError,
  protocolProviderError,
  toProviderError
} from './errors'
import {
  assertTokenUsage,
  consumeModelEventStream,
  mergeTokenUsage
} from './event-stream'
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ModelDescriptor,
  ModelEvent,
  ModelRequest,
  ProviderNotice,
  TokenUsage
} from './types'
import {
  closeAdapterIteratorBestEffort,
  nextAdapterEvent,
  toAsyncAdapterIterator
} from './abortable-iteration'

export const GROUND_ADAPTER_API_VERSION = 1 as const
export const GROUND_ADAPTER_CONFORMANCE_VERSION = 1 as const

export const AGENT_RUNTIME_EVENT_LIMITS = Object.freeze({
  events: 100_000,
  identifierCharacters: 200,
  assistantTextCharacters: 2_000_000,
  activities: 2_000,
  activityTitleCharacters: 500,
  activityDetailCharacters: 100_000,
  activityTextCharacters: 2_000_000,
  notices: 100,
  noticeCodeCharacters: 200,
  noticeCharacters: 10_000,
  noticeTotalCharacters: 80_000,
  servingModelCharacters: 200
})

export interface ReducedAgentRuntimeResponse {
  sessionId?: string
  servingModel?: string
  assistantText: string
  stopReason: Extract<
    AgentRuntimeEvent,
    { type: 'runtime.completed' }
  >['stopReason']
  usage?: TokenUsage
  notices: ProviderNotice[]
  completedActivityCount: number
}

export class AgentRuntimeEventReducer {
  private started?: Extract<AgentRuntimeEvent, { type: 'runtime.started' }>
  private terminal?: Extract<AgentRuntimeEvent, { type: 'runtime.completed' }>
  private readonly seenActivityIds = new Set<string>()
  private readonly openActivityIds = new Set<string>()
  private readonly notices: ProviderNotice[] = []
  private assistantText = ''
  private activityTextCharacters = 0
  private noticeCharacters = 0
  private eventCount = 0
  private completedActivityCount = 0
  private usageTotals?: TokenUsage

  get hasTerminalEvent(): boolean {
    return Boolean(this.terminal)
  }

  get hasSemanticOutput(): boolean {
    return (
      this.assistantText.length > 0 ||
      this.seenActivityIds.size > 0
    )
  }

  push(value: unknown): AgentRuntimeEvent {
    if (this.terminal) {
      throw this.protocolError('Received an event after runtime.completed')
    }

    const event = assertAgentRuntimeEvent(value)
    this.eventCount += 1
    if (this.eventCount > AGENT_RUNTIME_EVENT_LIMITS.events) {
      throw this.protocolError('Runtime emitted too many events')
    }

    if (event.type === 'runtime.started') {
      if (this.eventCount !== 1) {
        throw this.protocolError('runtime.started must be the first event')
      }
      if (this.started) {
        throw this.protocolError('Received runtime.started more than once')
      }
      this.started = event
      return event
    }

    if (!this.started) {
      throw this.protocolError(`Received ${event.type} before runtime.started`)
    }

    switch (event.type) {
      case 'assistant.delta':
        if (
          this.assistantText.length + event.delta.length >
          AGENT_RUNTIME_EVENT_LIMITS.assistantTextCharacters
        ) {
          throw this.protocolError('Runtime assistant text exceeded its size limit')
        }
        this.assistantText += event.delta
        return event
      case 'activity.started':
        if (this.seenActivityIds.has(event.activityId)) {
          throw this.protocolError(
            `Activity "${event.activityId}" started more than once`
          )
        }
        if (this.seenActivityIds.size >= AGENT_RUNTIME_EVENT_LIMITS.activities) {
          throw this.protocolError('Runtime emitted too many activities')
        }
        this.reserveActivityText(event.title.length + (event.detail?.length ?? 0))
        this.seenActivityIds.add(event.activityId)
        this.openActivityIds.add(event.activityId)
        return event
      case 'activity.updated':
        this.requireOpenActivity(event.activityId, event.type)
        this.reserveActivityText(event.detail?.length ?? 0)
        return event
      case 'activity.completed':
        this.requireOpenActivity(event.activityId, event.type)
        this.reserveActivityText(event.detail?.length ?? 0)
        this.openActivityIds.delete(event.activityId)
        this.completedActivityCount += 1
        return event
      case 'provider.notice':
        if (this.notices.length >= AGENT_RUNTIME_EVENT_LIMITS.notices) {
          throw this.protocolError('Runtime emitted too many notices')
        }
        if (
          this.noticeCharacters + event.code.length + event.message.length >
          AGENT_RUNTIME_EVENT_LIMITS.noticeTotalCharacters
        ) {
          throw this.protocolError('Runtime notices exceeded their total size limit')
        }
        this.noticeCharacters += event.code.length + event.message.length
        this.notices.push({
          level: event.level,
          code: event.code,
          message: event.message,
          retry: event.retry ? { ...event.retry } : undefined
        })
        return event
      case 'usage.updated':
        this.usageTotals = mergeTokenUsage(
          this.usageTotals,
          event.usage,
          event.semantics,
          (message) => this.protocolError(message)
        )
        return event
      case 'runtime.completed':
        if (this.openActivityIds.size > 0) {
          throw this.protocolError(
            'Received runtime.completed before every activity completed'
          )
        }
        if (
          this.started.sessionId &&
          event.sessionId &&
          this.started.sessionId !== event.sessionId
        ) {
          throw this.protocolError(
            'runtime.completed changed the runtime session id'
          )
        }
        if (event.usage) {
          this.usageTotals = mergeTokenUsage(
            this.usageTotals,
            event.usage,
            'cumulative',
            (message) => this.protocolError(message)
          )
        }
        this.terminal = {
          ...event,
          usage: event.usage ? { ...event.usage } : undefined
        }
        return event
    }
  }

  finish(): ReducedAgentRuntimeResponse {
    if (!this.terminal) {
      throw this.protocolError('Runtime stream ended without runtime.completed')
    }
    if (this.openActivityIds.size > 0) {
      throw this.protocolError('Runtime stream ended with incomplete activities')
    }
    return {
      sessionId: this.terminal.sessionId ?? this.started?.sessionId,
      servingModel: this.started?.servingModel,
      assistantText: this.assistantText,
      stopReason: this.terminal.stopReason,
      usage: this.usageTotals ? { ...this.usageTotals } : undefined,
      notices: this.notices.map((notice) => ({
        ...notice,
        retry: notice.retry ? { ...notice.retry } : undefined
      })),
      completedActivityCount: this.completedActivityCount
    }
  }

  private requireOpenActivity(activityId: string, eventType: string): void {
    if (!this.openActivityIds.has(activityId)) {
      throw this.protocolError(
        `Received ${eventType} for unknown or completed activity "${activityId}"`
      )
    }
  }

  private reserveActivityText(additional: number): void {
    if (
      this.activityTextCharacters + additional >
      AGENT_RUNTIME_EVENT_LIMITS.activityTextCharacters
    ) {
      throw this.protocolError('Runtime activity text exceeded its total size limit')
    }
    this.activityTextCharacters += additional
  }

  private protocolError(message: string, cause?: unknown): ProviderError {
    return protocolProviderError(message, cause, this.hasSemanticOutput)
  }
}

export async function consumeAgentRuntimeEventStream(
  events: AsyncIterable<unknown> | Iterable<unknown>,
  options: {
    signal?: AbortSignal
    onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>
  } = {}
): Promise<ReducedAgentRuntimeResponse> {
  const reducer = new AgentRuntimeEventReducer()
  if (options.signal?.aborted) {
    throw cancelledProviderError(
      'Agent runtime operation was cancelled',
      options.signal.reason
    )
  }
  const iterator = toAsyncAdapterIterator(events)
  let completed = false

  try {
    while (true) {
      const result = await nextAdapterEvent(iterator, options.signal)
      if (result.done) {
        completed = true
        break
      }
      if (options.signal?.aborted) {
        throw cancelledProviderError(
          'Agent runtime operation was cancelled',
          options.signal.reason,
          reducer.hasSemanticOutput
        )
      }
      const event = reducer.push(result.value)
      await options.onEvent?.(event)
    }
    if (options.signal?.aborted) {
      throw cancelledProviderError(
        'Agent runtime operation was cancelled',
        options.signal.reason,
        reducer.hasSemanticOutput
      )
    }
    return reducer.finish()
  } catch (error) {
    if (reducer.hasTerminalEvent) {
      throw protocolProviderError(
        'Runtime stream raised an error after runtime.completed',
        error,
        reducer.hasSemanticOutput
      )
    }
    throw toProviderError(error, {
      signal: options.signal,
      partialOutput: reducer.hasSemanticOutput
    })
  } finally {
    if (!completed) closeAdapterIteratorBestEffort(iterator)
  }
}

export function assertAgentRuntimeEvent(value: unknown): AgentRuntimeEvent {
  const event = asRecord(value, 'Agent runtime event')
  const type = boundedNonEmptyString(
    event.type,
    'Agent runtime event type',
    100
  )

  switch (type) {
    case 'runtime.started':
      return {
        type,
        ...optionalStringProperty(
          event.sessionId,
          'sessionId',
          AGENT_RUNTIME_EVENT_LIMITS.identifierCharacters
        ),
        ...optionalNamedStringProperty(
          'servingModel',
          event.servingModel,
          'servingModel',
          AGENT_RUNTIME_EVENT_LIMITS.servingModelCharacters
        )
      }
    case 'assistant.delta':
      return {
        type,
        delta: boundedString(
          event.delta,
          'Assistant delta',
          AGENT_RUNTIME_EVENT_LIMITS.assistantTextCharacters
        )
      }
    case 'activity.started': {
      const kind = boundedNonEmptyString(event.kind, 'Activity kind', 100)
      if (
        ![
          'command',
          'file-change',
          'tool',
          'plan',
          'reasoning',
          'diagnostic'
        ].includes(kind)
      ) {
        throw protocolProviderError(`Unknown activity kind "${kind}"`)
      }
      return {
        type,
        activityId: boundedNonEmptyString(
          event.activityId,
          'Activity id',
          AGENT_RUNTIME_EVENT_LIMITS.identifierCharacters
        ),
        kind: kind as Extract<
          AgentRuntimeEvent,
          { type: 'activity.started' }
        >['kind'],
        title: boundedNonEmptyString(
          event.title,
          'Activity title',
          AGENT_RUNTIME_EVENT_LIMITS.activityTitleCharacters
        ),
        ...optionalNamedStringProperty(
          'detail',
          event.detail,
          'Activity detail',
          AGENT_RUNTIME_EVENT_LIMITS.activityDetailCharacters,
          false
        )
      }
    }
    case 'activity.updated':
      return {
        type,
        activityId: boundedNonEmptyString(
          event.activityId,
          'Activity id',
          AGENT_RUNTIME_EVENT_LIMITS.identifierCharacters
        ),
        ...optionalNamedStringProperty(
          'detail',
          event.detail,
          'Activity detail',
          AGENT_RUNTIME_EVENT_LIMITS.activityDetailCharacters,
          false
        )
      }
    case 'activity.completed': {
      const status = boundedNonEmptyString(
        event.status,
        'Activity status',
        100
      )
      if (!['success', 'error', 'denied'].includes(status)) {
        throw protocolProviderError(`Unknown activity status "${status}"`)
      }
      return {
        type,
        activityId: boundedNonEmptyString(
          event.activityId,
          'Activity id',
          AGENT_RUNTIME_EVENT_LIMITS.identifierCharacters
        ),
        status: status as Extract<
          AgentRuntimeEvent,
          { type: 'activity.completed' }
        >['status'],
        ...optionalNamedStringProperty(
          'detail',
          event.detail,
          'Activity detail',
          AGENT_RUNTIME_EVENT_LIMITS.activityDetailCharacters,
          false
        )
      }
    }
    case 'provider.notice': {
      const level = boundedNonEmptyString(event.level, 'Notice level', 100)
      if (!['debug', 'info', 'warning'].includes(level)) {
        throw protocolProviderError(`Unknown provider notice level "${level}"`)
      }
      let retry: ProviderNotice['retry']
      if (event.retry !== undefined) {
        const candidate = asRecord(event.retry, 'Retry notice')
        retry = {
          attempt: positiveInteger(candidate.attempt, 'Retry attempt'),
          delayMs: nonNegativeInteger(candidate.delayMs, 'Retry delay')
        }
      }
      return {
        type,
        level: level as ProviderNotice['level'],
        code: boundedNonEmptyString(
          event.code,
          'Notice code',
          AGENT_RUNTIME_EVENT_LIMITS.noticeCodeCharacters
        ),
        message: boundedString(
          event.message,
          'Notice message',
          AGENT_RUNTIME_EVENT_LIMITS.noticeCharacters
        ),
        ...(retry ? { retry } : {})
      }
    }
    case 'usage.updated': {
      if (event.semantics !== 'cumulative' && event.semantics !== 'delta') {
        throw protocolProviderError('Usage semantics must be cumulative or delta')
      }
      assertTokenUsage(event.usage)
      return {
        type,
        usage: { ...event.usage },
        semantics: event.semantics
      }
    }
    case 'runtime.completed': {
      const stopReason = boundedNonEmptyString(
        event.stopReason,
        'Runtime stop reason',
        100
      )
      if (!['complete', 'max-steps', 'unknown'].includes(stopReason)) {
        throw protocolProviderError(
          `Unknown runtime stop reason "${stopReason}"`
        )
      }
      let usage: TokenUsage | undefined
      if (event.usage !== undefined) {
        assertTokenUsage(event.usage)
        usage = { ...event.usage }
      }
      return {
        type,
        ...optionalStringProperty(
          event.sessionId,
          'sessionId',
          AGENT_RUNTIME_EVENT_LIMITS.identifierCharacters
        ),
        stopReason: stopReason as Extract<
          AgentRuntimeEvent,
          { type: 'runtime.completed' }
        >['stopReason'],
        ...(usage ? { usage } : {})
      }
    }
    default:
      throw protocolProviderError(
        `Unknown normalized agent runtime event "${type}"`
      )
  }
}

export type AdapterConformanceCheckStatus = 'passed' | 'failed' | 'skipped'

export interface AdapterConformanceCheck {
  id: string
  status: AdapterConformanceCheckStatus
  detail?: string
}

export interface AdapterConformanceReport {
  apiVersion: typeof GROUND_ADAPTER_API_VERSION
  conformanceVersion: typeof GROUND_ADAPTER_CONFORMANCE_VERSION
  adapterKind: 'model' | 'agent-runtime'
  adapterId: string
  passed: boolean
  checks: AdapterConformanceCheck[]
}

interface BaseAdapterConformanceFixture {
  invalidConfigs: readonly unknown[]
  secrets?: SecretResolver
  timeoutMs?: number
}

export interface ModelAdapterConformanceFixture<C>
  extends BaseAdapterConformanceFixture {
  adapter: ModelAdapter<C>
  validConfig: unknown
  request?: ModelRequest
}

export interface AgentRuntimeAdapterConformanceFixture<C>
  extends BaseAdapterConformanceFixture {
  adapter: AgentRuntimeAdapter<C>
  validConfig: unknown
  request?: AgentRunRequest
}

export class AdapterConformanceError extends Error {
  constructor(readonly report: AdapterConformanceReport) {
    const failed = report.checks
      .filter((check) => check.status === 'failed')
      .map((check) => check.id)
      .join(', ')
    super(
      `${report.adapterKind} adapter "${report.adapterId}" failed conformance: ${failed}`
    )
    this.name = 'AdapterConformanceError'
  }
}

export function createModelConformanceRequest(): ModelRequest {
  return {
    requestId: 'ground-conformance-model-request',
    model: 'ground-conformance-model',
    instructions: 'Return the deterministic adapter conformance fixture.',
    conversation: [
      {
        kind: 'message',
        id: 'ground-conformance-user-message',
        role: 'user',
        parts: [{ kind: 'text', text: 'adapter conformance fixture' }]
      }
    ]
  }
}

export function createAgentRuntimeConformanceRequest(): AgentRunRequest {
  return {
    requestId: 'ground-conformance-runtime-request',
    prompt: 'Run the deterministic adapter conformance fixture.',
    workspacePath: '/ground-conformance/workspace',
    mode: 'ask'
  }
}

export async function runModelAdapterConformance<C>(
  fixture: ModelAdapterConformanceFixture<C>
): Promise<AdapterConformanceReport> {
  const checks: AdapterConformanceCheck[] = []
  const timeoutMs = normalizeTimeout(fixture.timeoutMs)

  await captureCheck(checks, 'adapter.id', () => {
    assertAdapterId(fixture.adapter.id)
  })

  const configuration = await captureCheck(
    checks,
    'config.valid',
    () => fixture.adapter.validateConfig(fixture.validConfig)
  )
  await captureCheck(checks, 'config.invalid', () => {
    assertInvalidConfigsRejected(
      fixture.invalidConfigs,
      (value) => fixture.adapter.validateConfig(value)
    )
  })

  let inspection:
    | { ok: true; value: ModelAdapterInspection }
    | { ok: false }
  if (configuration.ok) {
    inspection = await captureCheck(checks, 'inspection', async () => {
      const controller = new AbortController()
      const result = await withTimeout(
        fixture.adapter.inspect(
          createContext(
            configuration.value,
            controller.signal,
            fixture.secrets
          )
        ),
        timeoutMs,
        'Model adapter inspection',
        () => abortForTimeout(controller, 'Model adapter inspection')
      )
      return assertModelInspection(result)
    })
  } else {
    inspection = { ok: false }
    skipCheck(checks, 'inspection', 'Valid configuration was not available')
  }

  const request = fixture.request ?? createModelConformanceRequest()
  if (configuration.ok) {
    await captureCheck(checks, 'stream.lifecycle', async () => {
      const controller = new AbortController()
      const iterator = fixture.adapter
        .stream(
          request,
          createContext(
            configuration.value,
            controller.signal,
            fixture.secrets
          )
        )
        [Symbol.asyncIterator]()
      return withTimeout(
        consumeModelEventStream(iterableFromIterator(iterator), {
          signal: controller.signal
        }),
        timeoutMs,
        'Model adapter stream',
        () => {
          abortForTimeout(controller, 'Model adapter stream')
          closeIteratorBestEffort(iterator)
        }
      )
    })
  } else {
    skipCheck(checks, 'stream.lifecycle', 'Valid configuration was not available')
  }

  const cancellation =
    inspection.ok ? inspection.value.capabilities.cancellation : undefined
  if (configuration.ok && cancellation && cancellation !== 'none') {
    await captureCheck(checks, 'cancellation.pre-aborted', () =>
      verifyModelPreAbortedCancellation(
        fixture.adapter,
        configuration.value,
        request,
        fixture.secrets,
        timeoutMs
      )
    )
    await captureCheck(checks, 'cancellation.during-stream', () =>
      verifyModelMidStreamCancellation(
        fixture.adapter,
        configuration.value,
        request,
        fixture.secrets,
        timeoutMs
      )
    )
  } else {
    const reason = configuration.ok
      ? inspection.ok
        ? 'Adapter declares cancellation as none'
        : 'Inspection was not available'
      : 'Valid configuration was not available'
    skipCheck(checks, 'cancellation.pre-aborted', reason)
    skipCheck(checks, 'cancellation.during-stream', reason)
  }

  return createReport('model', fixture.adapter.id, checks)
}

export async function runAgentRuntimeAdapterConformance<C>(
  fixture: AgentRuntimeAdapterConformanceFixture<C>
): Promise<AdapterConformanceReport> {
  const checks: AdapterConformanceCheck[] = []
  const timeoutMs = normalizeTimeout(fixture.timeoutMs)

  await captureCheck(checks, 'adapter.id', () => {
    assertAdapterId(fixture.adapter.id)
  })

  const configuration = await captureCheck(
    checks,
    'config.valid',
    () => fixture.adapter.validateConfig(fixture.validConfig)
  )
  await captureCheck(checks, 'config.invalid', () => {
    assertInvalidConfigsRejected(
      fixture.invalidConfigs,
      (value) => fixture.adapter.validateConfig(value)
    )
  })

  let inspection:
    | { ok: true; value: AgentRuntimeInspection }
    | { ok: false }
  if (configuration.ok) {
    inspection = await captureCheck(checks, 'inspection', async () => {
      const controller = new AbortController()
      const result = await withTimeout(
        fixture.adapter.inspect(
          createContext(
            configuration.value,
            controller.signal,
            fixture.secrets
          )
        ),
        timeoutMs,
        'Agent runtime inspection',
        () => abortForTimeout(controller, 'Agent runtime inspection')
      )
      return assertAgentRuntimeInspection(result)
    })
  } else {
    inspection = { ok: false }
    skipCheck(checks, 'inspection', 'Valid configuration was not available')
  }

  const request = fixture.request ?? createAgentRuntimeConformanceRequest()
  if (configuration.ok) {
    await captureCheck(checks, 'stream.lifecycle', async () => {
      const controller = new AbortController()
      const iterator = fixture.adapter
        .run(
          request,
          createContext(
            configuration.value,
            controller.signal,
            fixture.secrets
          )
        )
        [Symbol.asyncIterator]()
      return withTimeout(
        consumeAgentRuntimeEventStream(iterableFromIterator(iterator), {
          signal: controller.signal
        }),
        timeoutMs,
        'Agent runtime stream',
        () => {
          abortForTimeout(controller, 'Agent runtime stream')
          closeIteratorBestEffort(iterator)
        }
      )
    })
  } else {
    skipCheck(checks, 'stream.lifecycle', 'Valid configuration was not available')
  }

  const cancellation =
    inspection.ok ? inspection.value.capabilities.cancellation : undefined
  if (configuration.ok && cancellation && cancellation !== 'none') {
    await captureCheck(checks, 'cancellation.pre-aborted', () =>
      verifyRuntimePreAbortedCancellation(
        fixture.adapter,
        configuration.value,
        request,
        fixture.secrets,
        timeoutMs
      )
    )
    await captureCheck(checks, 'cancellation.during-stream', () =>
      verifyRuntimeMidStreamCancellation(
        fixture.adapter,
        configuration.value,
        request,
        fixture.secrets,
        timeoutMs
      )
    )
  } else {
    const reason = configuration.ok
      ? inspection.ok
        ? 'Adapter declares cancellation as none'
        : 'Inspection was not available'
      : 'Valid configuration was not available'
    skipCheck(checks, 'cancellation.pre-aborted', reason)
    skipCheck(checks, 'cancellation.during-stream', reason)
  }

  return createReport('agent-runtime', fixture.adapter.id, checks)
}

export async function assertModelAdapterConformance<C>(
  fixture: ModelAdapterConformanceFixture<C>
): Promise<AdapterConformanceReport> {
  const report = await runModelAdapterConformance(fixture)
  if (!report.passed) throw new AdapterConformanceError(report)
  return report
}

export async function assertAgentRuntimeAdapterConformance<C>(
  fixture: AgentRuntimeAdapterConformanceFixture<C>
): Promise<AdapterConformanceReport> {
  const report = await runAgentRuntimeAdapterConformance(fixture)
  if (!report.passed) throw new AdapterConformanceError(report)
  return report
}

function assertModelInspection(value: unknown): ModelAdapterInspection {
  const inspection = asRecord(value, 'Model adapter inspection')
  return {
    capabilities: assertModelCapabilities(inspection.capabilities),
    ...(inspection.models === undefined
      ? {}
      : { models: assertModelDescriptors(inspection.models) })
  }
}

function assertAgentRuntimeInspection(value: unknown): AgentRuntimeInspection {
  const inspection = asRecord(value, 'Agent runtime inspection')
  return {
    ...(inspection.version === undefined
      ? {}
      : {
          version: boundedNonEmptyString(
            inspection.version,
            'Runtime version',
            200
          )
        }),
    capabilities: assertAgentRuntimeCapabilities(inspection.capabilities),
    ...(inspection.models === undefined
      ? {}
      : { models: assertModelDescriptors(inspection.models) })
  }
}

const MODEL_CAPABILITY_KEYS = [
  'streaming',
  'systemInstructions',
  'customTools',
  'parallelToolCalls',
  'toolArgumentStreaming',
  'strictToolSchemas',
  'structuredOutput',
  'reasoningSummaries',
  'opaqueStateReplay',
  'imageInput',
  'fileInput',
  'usageReporting',
  'modelDiscovery',
  'statefulContinuation'
] as const satisfies ReadonlyArray<
  Exclude<keyof ModelCapabilities, 'cancellation'>
>

const RUNTIME_CAPABILITY_KEYS = [
  'structuredEvents',
  'sessionResume',
  'assistantStreaming',
  'toolActivities',
  'commandActivities',
  'fileActivities',
  'usageReporting',
  'interactiveApprovals'
] as const satisfies ReadonlyArray<
  Exclude<
    keyof AgentRuntimeCapabilities,
    'cancellation' | 'permissionOwner'
  >
>

function assertModelCapabilities(value: unknown): Readonly<ModelCapabilities> {
  const capabilities = asRecord(value, 'Model capabilities')
  assertExactKeys(capabilities, [...MODEL_CAPABILITY_KEYS, 'cancellation'])
  const result = {} as Record<string, unknown>
  for (const key of MODEL_CAPABILITY_KEYS) {
    result[key] = assertCapabilitySupport(capabilities[key], key)
  }
  result.cancellation = assertCancellation(capabilities.cancellation)
  return Object.freeze(result as unknown as ModelCapabilities)
}

function assertAgentRuntimeCapabilities(
  value: unknown
): Readonly<AgentRuntimeCapabilities> {
  const capabilities = asRecord(value, 'Agent runtime capabilities')
  assertExactKeys(capabilities, [
    ...RUNTIME_CAPABILITY_KEYS,
    'cancellation',
    'permissionOwner'
  ])
  const result = {} as Record<string, unknown>
  for (const key of RUNTIME_CAPABILITY_KEYS) {
    result[key] = assertCapabilitySupport(capabilities[key], key)
  }
  result.cancellation = assertCancellation(capabilities.cancellation)
  if (!['ground', 'runtime', 'none'].includes(String(capabilities.permissionOwner))) {
    throw new TypeError(
      'permissionOwner must be "ground", "runtime", or "none"'
    )
  }
  result.permissionOwner = capabilities.permissionOwner
  return Object.freeze(result as unknown as AgentRuntimeCapabilities)
}

function assertCapabilitySupport(
  value: unknown,
  label: string
): CapabilitySupport {
  if (!['native', 'emulated', 'unsupported', 'unknown'].includes(String(value))) {
    throw new TypeError(
      `${label} must be native, emulated, unsupported, or unknown`
    )
  }
  return value as CapabilitySupport
}

function assertCancellation(
  value: unknown
): ModelCapabilities['cancellation'] {
  if (!['abort-signal', 'process-signal', 'none'].includes(String(value))) {
    throw new TypeError(
      'cancellation must be "abort-signal", "process-signal", or "none"'
    )
  }
  return value as ModelCapabilities['cancellation']
}

function assertModelDescriptors(value: unknown): ModelDescriptor[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Inspection models must be an array')
  }
  if (value.length > 10_000) {
    throw new TypeError('Inspection returned too many models')
  }
  const ids = new Set<string>()
  return value.map((candidate, index) => {
    const model = asRecord(candidate, `Model descriptor ${index}`)
    const id = boundedNonEmptyString(model.id, 'Model id', 200)
    if (ids.has(id)) throw new TypeError(`Duplicate model id "${id}"`)
    ids.add(id)
    return {
      id,
      ...(model.name === undefined
        ? {}
        : { name: boundedNonEmptyString(model.name, 'Model name', 500) }),
      ...(model.contextWindowTokens === undefined
        ? {}
        : {
            contextWindowTokens: boundedPositiveInteger(
              model.contextWindowTokens,
              'contextWindowTokens'
            )
          }),
      ...(model.maxOutputTokens === undefined
        ? {}
        : {
            maxOutputTokens: boundedPositiveInteger(
              model.maxOutputTokens,
              'maxOutputTokens'
            )
          })
    }
  })
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): void {
  const expectedSet = new Set(expected)
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new TypeError(`Unknown capability field "${key}"`)
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`Missing capability field "${key}"`)
    }
  }
}

function createContext<C>(
  config: C,
  signal: AbortSignal,
  secrets?: SecretResolver
): AdapterContext<C> {
  return {
    config,
    signal,
    secrets: secrets ?? {
      async resolve(ref: string): Promise<string> {
        throw new Error(
          `Conformance fixture did not provide secret reference "${ref}"`
        )
      }
    }
  }
}

async function verifyModelPreAbortedCancellation<C>(
  adapter: ModelAdapter<C>,
  config: C,
  request: ModelRequest,
  secrets: SecretResolver | undefined,
  timeoutMs: number
): Promise<void> {
  const controller = abortedController()
  let iterator: AsyncIterator<ModelEvent> | undefined
  try {
    await expectCancelled(
      () => {
        iterator = adapter
          .stream(request, createContext(config, controller.signal, secrets))
          [Symbol.asyncIterator]()
        return withTimeout(
          iterator.next(),
          timeoutMs,
          'Pre-aborted model stream',
          () => {
            if (iterator) closeIteratorBestEffort(iterator)
          }
        )
      },
      controller.signal
    )
  } finally {
    if (iterator) closeIteratorBestEffort(iterator)
  }
}

async function verifyModelMidStreamCancellation<C>(
  adapter: ModelAdapter<C>,
  config: C,
  request: ModelRequest,
  secrets: SecretResolver | undefined,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController()
  const iterator = adapter
    .stream(request, createContext(config, controller.signal, secrets))
    [Symbol.asyncIterator]()
  try {
    const first = await withTimeout(
      iterator.next(),
      timeoutMs,
      'Model stream first event',
      () => {
        abortForTimeout(controller, 'Model stream first event')
        closeIteratorBestEffort(iterator)
      }
    )
    if (first.done) throw new Error('Model stream ended before cancellation')
    controller.abort(createConformanceAbortReason())
    await expectCancelled(
      () =>
        withTimeout(
          iterator.next(),
          timeoutMs,
          'Cancelled model stream',
          () => closeIteratorBestEffort(iterator)
        ),
      controller.signal
    )
  } finally {
    closeIteratorBestEffort(iterator)
  }
}

async function verifyRuntimePreAbortedCancellation<C>(
  adapter: AgentRuntimeAdapter<C>,
  config: C,
  request: AgentRunRequest,
  secrets: SecretResolver | undefined,
  timeoutMs: number
): Promise<void> {
  const controller = abortedController()
  let iterator: AsyncIterator<AgentRuntimeEvent> | undefined
  try {
    await expectCancelled(
      () => {
        iterator = adapter
          .run(request, createContext(config, controller.signal, secrets))
          [Symbol.asyncIterator]()
        return withTimeout(
          iterator.next(),
          timeoutMs,
          'Pre-aborted agent runtime stream',
          () => {
            if (iterator) closeIteratorBestEffort(iterator)
          }
        )
      },
      controller.signal
    )
  } finally {
    if (iterator) closeIteratorBestEffort(iterator)
  }
}

async function verifyRuntimeMidStreamCancellation<C>(
  adapter: AgentRuntimeAdapter<C>,
  config: C,
  request: AgentRunRequest,
  secrets: SecretResolver | undefined,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController()
  const iterator = adapter
    .run(request, createContext(config, controller.signal, secrets))
    [Symbol.asyncIterator]()
  try {
    const first = await withTimeout(
      iterator.next(),
      timeoutMs,
      'Agent runtime first event',
      () => {
        abortForTimeout(controller, 'Agent runtime first event')
        closeIteratorBestEffort(iterator)
      }
    )
    if (first.done) throw new Error('Agent runtime ended before cancellation')
    controller.abort(createConformanceAbortReason())
    await expectCancelled(
      () =>
        withTimeout(
          iterator.next(),
          timeoutMs,
          'Cancelled agent runtime stream',
          () => closeIteratorBestEffort(iterator)
        ),
      controller.signal
    )
  } finally {
    closeIteratorBestEffort(iterator)
  }
}

async function expectCancelled(
  operation: () => Promise<unknown>,
  signal: AbortSignal
): Promise<void> {
  try {
    const result = await operation()
    if (isIteratorResult(result) && !result.done) {
      throw new ConformanceViolation(
        'Adapter emitted another event after cancellation'
      )
    }
    throw new ConformanceViolation(
      'Adapter completed without reporting cancellation'
    )
  } catch (error) {
    if (
      error instanceof ConformanceViolation ||
      error instanceof ConformanceTimeoutError
    ) {
      throw error
    }
    if (
      error === signal.reason ||
      (error instanceof ProviderError && error.category === 'cancelled') ||
      isAbortLikeError(error)
    ) {
      return
    }
    const reported =
      error instanceof ProviderError
        ? error.category
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : typeof error
    throw new ConformanceViolation(
      `Adapter reported ${reported} instead of cancellation`
    )
  }
}

function abortedController(): AbortController {
  const controller = new AbortController()
  controller.abort(createConformanceAbortReason())
  return controller
}

function isIteratorResult(value: unknown): value is IteratorResult<unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { done?: unknown }).done === 'boolean'
  )
}

function assertInvalidConfigsRejected(
  values: readonly unknown[],
  validate: (value: unknown) => unknown
): void {
  if (values.length === 0) {
    throw new ConformanceViolation(
      'At least one invalid configuration fixture is required'
    )
  }
  for (const [index, value] of values.entries()) {
    let rejected = false
    try {
      validate(value)
    } catch {
      rejected = true
    }
    if (!rejected) {
      throw new ConformanceViolation(
        `Invalid configuration fixture ${index} was accepted`
      )
    }
  }
}

async function captureCheck<T>(
  checks: AdapterConformanceCheck[],
  id: string,
  operation: () => T | Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const value = await operation()
    checks.push({ id, status: 'passed' })
    return { ok: true, value }
  } catch (error) {
    checks.push({
      id,
      status: 'failed',
      detail: readableError(error).slice(0, 1_000)
    })
    return { ok: false }
  }
}

function skipCheck(
  checks: AdapterConformanceCheck[],
  id: string,
  detail: string
): void {
  checks.push({ id, status: 'skipped', detail })
}

function createReport(
  adapterKind: AdapterConformanceReport['adapterKind'],
  adapterId: string,
  checks: AdapterConformanceCheck[]
): AdapterConformanceReport {
  return {
    apiVersion: GROUND_ADAPTER_API_VERSION,
    conformanceVersion: GROUND_ADAPTER_CONFORMANCE_VERSION,
    adapterKind,
    adapterId:
      typeof adapterId === 'string'
        ? adapterId.slice(0, 200)
        : '<invalid-adapter-id>',
    passed: checks.every((check) => check.status !== 'failed'),
    checks
  }
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? 2_000
  if (
    !Number.isInteger(timeout) ||
    timeout < 50 ||
    timeout > 30_000
  ) {
    throw new TypeError(
      'Conformance timeoutMs must be an integer from 50 through 30000'
    )
  }
  return timeout
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ConformanceTimeoutError(`${label} timed out`))
          try {
            onTimeout?.()
          } catch {
            // Cleanup is best effort; the timeout remains the primary failure.
          }
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function createConformanceAbortReason(
  message = 'Ground conformance cancellation fixture'
): Error {
  const reason = new Error(message)
  reason.name = 'AbortError'
  return reason
}

function abortForTimeout(controller: AbortController, label: string): void {
  if (!controller.signal.aborted) {
    controller.abort(createConformanceAbortReason(`${label} timed out`))
  }
}

function iterableFromIterator<T>(
  iterator: AsyncIterator<T>
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iterator
    }
  }
}

function closeIteratorBestEffort(iterator: AsyncIterator<unknown>): void {
  if (typeof iterator.return !== 'function') return
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined)
  } catch {
    // A broken cleanup path must not obscure the primary conformance result.
  }
}

class ConformanceTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConformanceTimeoutError'
  }
}

class ConformanceViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConformanceViolation'
  }
}

function assertAdapterId(adapterId: string): void {
  boundedNonEmptyString(adapterId, 'Adapter id', 200)
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(adapterId)) {
    throw new TypeError(
      'Adapter ids must begin with a lowercase letter or digit and contain only lowercase letters, digits, ".", "_", or "-"'
    )
  }
}

function optionalStringProperty(
  value: unknown,
  label: string,
  maximumCharacters: number
): { sessionId?: string } {
  return optionalNamedStringProperty(
    'sessionId',
    value,
    label,
    maximumCharacters
  )
}

function optionalNamedStringProperty<K extends string>(
  key: K,
  value: unknown,
  label: string,
  maximumCharacters: number,
  nonEmpty = true
): Partial<Record<K, string>> {
  if (value === undefined) return {}
  return {
    [key]: nonEmpty
      ? boundedNonEmptyString(value, label, maximumCharacters)
      : boundedString(value, label, maximumCharacters)
  } as Partial<Record<K, string>>
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolProviderError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function boundedString(
  value: unknown,
  label: string,
  maximumCharacters: number
): string {
  if (typeof value !== 'string') {
    throw protocolProviderError(`${label} must be a string`)
  }
  if (value.length > maximumCharacters) {
    throw protocolProviderError(`${label} exceeds its size limit`)
  }
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  const result = boundedString(value, label, Number.MAX_SAFE_INTEGER)
  if (!result) throw protocolProviderError(`${label} must not be empty`)
  return result
}

function boundedNonEmptyString(
  value: unknown,
  label: string,
  maximumCharacters: number
): string {
  const result = boundedString(value, label, maximumCharacters)
  if (!result) throw protocolProviderError(`${label} must not be empty`)
  return result
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw protocolProviderError(`${label} must be a non-negative integer`)
  }
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label)
  if (result === 0) {
    throw protocolProviderError(`${label} must be greater than zero`)
  }
  return result
}

function boundedPositiveInteger(value: unknown, label: string): number {
  const result = positiveInteger(value, label)
  if (result > 1_000_000_000) {
    throw new TypeError(`${label} exceeds its supported limit`)
  }
  return result
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Unknown conformance failure'
}
