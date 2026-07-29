import {
  ProviderError,
  protocolProviderError,
  toProviderError
} from './errors'
import {
  assertJsonObject,
  assertJsonValue,
  type JsonObject,
  type JsonValue
} from './json'
import type {
  ModelEvent,
  ModelStopReason,
  OutputMessagePart,
  OutputPartHeader,
  ProviderNotice,
  ProviderState,
  ReducedModelResponse,
  TokenUsage,
  ToolCallPart
} from './types'
import {
  closeAdapterIteratorBestEffort,
  nextAdapterEvent,
  toAsyncAdapterIterator
} from './abortable-iteration'

const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens',
  'costUsd'
] as const satisfies ReadonlyArray<keyof TokenUsage>
export const MAX_NORMALIZED_TOKEN_COUNT = 1_000_000_000_000
export const MAX_NORMALIZED_COST_USD = 1_000_000

const STOP_REASONS = new Set<ModelStopReason>([
  'complete',
  'tool-calls',
  'max-output-tokens',
  'context-limit',
  'stop-sequence',
  'safety',
  'refusal',
  'malformed-tool-call',
  'paused',
  'unknown'
])
const MAX_NORMALIZED_PARTS = 1_000
const MAX_NORMALIZED_TEXT_CHARACTERS = 2_000_000
const MAX_NORMALIZED_REASONING_CHARACTERS = 200_000
const MAX_NORMALIZED_TOOL_ARGUMENT_CHARACTERS = 2_000_000
const MAX_PROVIDER_NOTICES = 100
const MAX_PROVIDER_NOTICE_CHARACTERS = 10_000
const MAX_PROVIDER_NOTICE_TOTAL_CHARACTERS = 80_000
const MAX_NORMALIZED_IDENTIFIER_CHARACTERS = 200
const MAX_PROVIDER_STATE_BYTES = 1_000_000
const MAX_PROVIDER_STATE_DEPTH = 64
const MAX_PROVIDER_STATE_NODES = 100_000

interface PartAccumulator {
  header: OutputPartHeader
  text: string
  rawArguments: string
  completed?: OutputMessagePart
}

export class ModelEventReducer {
  private started?: Extract<ModelEvent, { type: 'response.started' }>
  private terminal?: Extract<ModelEvent, { type: 'response.completed' }>
  private readonly partOrder: string[] = []
  private readonly parts = new Map<string, PartAccumulator>()
  private readonly providerNotices: ProviderNotice[] = []
  private usageTotals?: TokenUsage
  private emittedOutput = false
  private textCharacters = 0
  private reasoningCharacters = 0
  private toolArgumentCharacters = 0
  private providerNoticeCharacters = 0

  get hasTerminalEvent(): boolean {
    return Boolean(this.terminal)
  }

  get hasSemanticOutput(): boolean {
    return this.emittedOutput
  }

  push(value: unknown): ModelEvent {
    const event = assertModelEvent(value)
    if (this.terminal) {
      throw this.protocolError(`Received ${event.type} after response.completed`)
    }

    switch (event.type) {
      case 'provider.notice':
        if (this.providerNotices.length >= MAX_PROVIDER_NOTICES) {
          throw this.protocolError('Provider emitted too many notices')
        }
        if (
          this.providerNoticeCharacters +
            event.code.length +
            event.message.length >
          MAX_PROVIDER_NOTICE_TOTAL_CHARACTERS
        ) {
          throw this.protocolError('Provider notices exceeded their size limit')
        }
        this.providerNoticeCharacters += event.code.length + event.message.length
        this.providerNotices.push({
          level: event.level,
          code: event.code,
          message: event.message,
          retry: event.retry ? { ...event.retry } : undefined
        })
        return event
      case 'response.started':
        if (this.started) throw this.protocolError('Received response.started more than once')
        this.started = { ...event }
        return event
      case 'part.started':
        this.requireStarted(event.type)
        this.startPart(event.part)
        return event
      case 'part.delta':
        this.requireStarted(event.type)
        this.addDelta(event.partId, event.delta)
        return event
      case 'part.completed':
        this.requireStarted(event.type)
        this.completePart(event.partId, event.part)
        return event
      case 'usage.updated':
        this.requireStarted(event.type)
        this.usageTotals = mergeTokenUsage(
          this.usageTotals,
          event.usage,
          event.semantics,
          (message) => this.protocolError(message)
        )
        return event
      case 'response.completed':
        this.requireStarted(event.type)
        for (const partId of this.partOrder) {
          if (!this.parts.get(partId)?.completed) {
            throw this.protocolError(
              `Received response.completed before part "${partId}" completed`
            )
          }
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
          usage: event.usage ? { ...event.usage } : undefined,
          providerState: event.providerState
            ? cloneProviderState(event.providerState)
            : undefined,
          checkpoint:
            event.checkpoint === undefined
              ? undefined
              : cloneBoundedProviderJson(
                  event.checkpoint,
                  'Provider checkpoint'
                )
        }
        return event
    }
  }

  finish(): ReducedModelResponse {
    if (!this.terminal) {
      throw this.protocolError('Provider stream ended without response.completed')
    }
    const terminal = this.terminal
    const outputParts = this.partOrder.map((partId) => {
      const completed = this.parts.get(partId)?.completed
      if (!completed) {
        throw this.protocolError(`Part "${partId}" did not complete`)
      }
      return cloneOutputPart(completed)
    })
    return {
      responseId: this.started?.responseId,
      servingModel: this.started?.servingModel,
      output: {
        kind: 'message',
        id: terminal.messageId,
        role: 'assistant',
        parts: outputParts,
        providerState: terminal.providerState
          ? cloneProviderState(terminal.providerState)
          : undefined
      },
      stopReason: terminal.stopReason,
      providerStopReason: terminal.providerStopReason,
      usage: this.usageTotals ? { ...this.usageTotals } : undefined,
      notices: this.providerNotices.map((notice) => ({
        ...notice,
        retry: notice.retry ? { ...notice.retry } : undefined
      })),
      checkpoint:
        terminal.checkpoint === undefined
          ? undefined
          : cloneBoundedProviderJson(
              terminal.checkpoint,
              'Provider checkpoint'
            )
    }
  }

  private startPart(header: OutputPartHeader): void {
    if (this.partOrder.length >= MAX_NORMALIZED_PARTS) {
      throw this.protocolError('Provider emitted too many output parts')
    }
    if (this.parts.has(header.partId)) {
      throw this.protocolError(`Part "${header.partId}" started more than once`)
    }
    this.parts.set(header.partId, {
      header: { ...header },
      text: '',
      rawArguments: ''
    })
    this.partOrder.push(header.partId)
  }

  private addDelta(
    partId: string,
    delta: Extract<ModelEvent, { type: 'part.delta' }>['delta']
  ): void {
    const part = this.requireOpenPart(partId)
    const expectedKind =
      part.header.kind === 'tool-call' ? 'tool-arguments' : part.header.kind
    if (delta.kind !== expectedKind) {
      throw this.protocolError(
        `Part "${partId}" is ${part.header.kind}, but received ${delta.kind} delta`
      )
    }
    if (delta.kind === 'tool-arguments') {
      this.reserveCharacters('tool-arguments', delta.text.length)
      part.rawArguments += delta.text
    } else {
      this.reserveCharacters(delta.kind, delta.text.length)
      part.text += delta.text
    }
    if (delta.text) this.emittedOutput = true
  }

  private completePart(partId: string, candidate: OutputMessagePart): void {
    const accumulator = this.requireOpenPart(partId)
    if (candidate.kind !== accumulator.header.kind) {
      throw this.protocolError(
        `Part "${partId}" started as ${accumulator.header.kind}, but completed as ${candidate.kind}`
      )
    }

    let completed: OutputMessagePart
    if (candidate.kind === 'tool-call' && accumulator.header.kind === 'tool-call') {
      if (
        accumulator.header.callId &&
        accumulator.header.callId !== candidate.callId
      ) {
        throw this.protocolError(`Part "${partId}" changed its tool call id`)
      }
      if (accumulator.header.name && accumulator.header.name !== candidate.name) {
        throw this.protocolError(`Part "${partId}" changed its tool name`)
      }
      if (
        accumulator.rawArguments &&
        accumulator.rawArguments !== candidate.rawArguments
      ) {
        throw this.protocolError(
          `Part "${partId}" completed with tool arguments that do not match its deltas`
        )
      }
      if (!accumulator.rawArguments) {
        this.reserveCharacters('tool-arguments', candidate.rawArguments.length)
      }
      completed = finalizeToolCall({
        ...candidate,
        rawArguments: accumulator.rawArguments || candidate.rawArguments
      })
    } else if (
      (candidate.kind === 'text' || candidate.kind === 'reasoning-summary') &&
      (accumulator.header.kind === 'text' ||
        accumulator.header.kind === 'reasoning-summary')
    ) {
      if (accumulator.text && accumulator.text !== candidate.text) {
        throw this.protocolError(
          `Part "${partId}" completed with text that does not match its deltas`
        )
      }
      if (!accumulator.text) {
        this.reserveCharacters(candidate.kind, candidate.text.length)
      }
      completed = {
        ...candidate,
        text: accumulator.text || candidate.text
      }
    } else {
      throw this.protocolError(`Unsupported completed part for "${partId}"`)
    }

    accumulator.completed = cloneOutputPart(completed)
    this.emittedOutput = true
  }

  private requireOpenPart(partId: string): PartAccumulator {
    const part = this.parts.get(partId)
    if (!part) {
      throw this.protocolError(`Received an event for unknown part "${partId}"`)
    }
    if (part.completed) {
      throw this.protocolError(`Received an event after part "${partId}" completed`)
    }
    return part
  }

  private requireStarted(eventType: ModelEvent['type']): void {
    if (!this.started) {
      throw this.protocolError(`Received ${eventType} before response.started`)
    }
  }

  private reserveCharacters(
    kind: 'text' | 'reasoning-summary' | 'tool-arguments',
    additional: number
  ): void {
    const [current, maximum, label] =
      kind === 'text'
        ? [
            this.textCharacters,
            MAX_NORMALIZED_TEXT_CHARACTERS,
            'assistant text'
          ]
        : kind === 'reasoning-summary'
          ? [
              this.reasoningCharacters,
              MAX_NORMALIZED_REASONING_CHARACTERS,
              'reasoning summary'
            ]
          : [
              this.toolArgumentCharacters,
              MAX_NORMALIZED_TOOL_ARGUMENT_CHARACTERS,
              'tool arguments'
            ]
    if (current + additional > maximum) {
      throw this.protocolError(`Provider ${label} exceeded its size limit`)
    }
    if (kind === 'text') this.textCharacters += additional
    else if (kind === 'reasoning-summary') {
      this.reasoningCharacters += additional
    } else {
      this.toolArgumentCharacters += additional
    }
  }

  private protocolError(message: string, cause?: unknown): ProviderError {
    return protocolProviderError(message, cause, this.emittedOutput)
  }
}

export async function consumeModelEventStream(
  events: AsyncIterable<unknown> | Iterable<unknown>,
  options: {
    signal?: AbortSignal
  } = {}
): Promise<ReducedModelResponse> {
  const reducer = new ModelEventReducer()
  if (options.signal?.aborted) {
    throw toProviderError(options.signal.reason, {
      signal: options.signal
    })
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
        throw toProviderError(options.signal.reason, {
          signal: options.signal,
          partialOutput: reducer.hasSemanticOutput
        })
      }
      reducer.push(result.value)
    }
    if (options.signal?.aborted) {
      throw toProviderError(options.signal.reason, {
        signal: options.signal,
        partialOutput: reducer.hasSemanticOutput
      })
    }
    return reducer.finish()
  } catch (error) {
    if (reducer.hasTerminalEvent) {
      throw protocolProviderError(
        'Provider stream raised an error after response.completed',
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

export function assertModelEvent(value: unknown): ModelEvent {
  const event = asRecord(value, 'Model event')
  const type = boundedNonEmptyString(event.type, 'Model event type', 100)

  switch (type) {
    case 'response.started': {
      const responseId = optionalBoundedNonEmptyString(
        event.responseId,
        'responseId',
        MAX_NORMALIZED_IDENTIFIER_CHARACTERS
      )
      const servingModel = optionalBoundedNonEmptyString(
        event.servingModel,
        'servingModel',
        200
      )
      return {
        type,
        ...(responseId === undefined ? {} : { responseId }),
        ...(servingModel === undefined ? {} : { servingModel })
      }
    }
    case 'part.started': {
      const part = asRecord(event.part, 'Started part')
      const kind = nonEmptyString(part.kind, 'Started part kind')
      const partId = boundedNonEmptyString(
        part.partId,
        'Started part id',
        MAX_NORMALIZED_IDENTIFIER_CHARACTERS
      )
      if (!['text', 'reasoning-summary', 'tool-call'].includes(kind)) {
        throw protocolProviderError(`Unknown started part kind "${kind}"`)
      }
      if (kind === 'tool-call') {
        const callId = optionalBoundedNonEmptyString(
          part.callId,
          'Tool call id',
          MAX_NORMALIZED_IDENTIFIER_CHARACTERS
        )
        const name = optionalBoundedNonEmptyString(part.name, 'Tool name', 200)
        return {
          type,
          part: {
            kind,
            partId,
            ...(callId === undefined ? {} : { callId }),
            ...(name === undefined ? {} : { name })
          }
        }
      }
      return {
        type,
        part: {
          kind: kind as 'text' | 'reasoning-summary',
          partId
        }
      }
    }
    case 'part.delta': {
      const partId = boundedNonEmptyString(
        event.partId,
        'Delta part id',
        MAX_NORMALIZED_IDENTIFIER_CHARACTERS
      )
      const delta = asRecord(event.delta, 'Part delta')
      const kind = nonEmptyString(delta.kind, 'Part delta kind')
      if (!['text', 'reasoning-summary', 'tool-arguments'].includes(kind)) {
        throw protocolProviderError(`Unknown part delta kind "${kind}"`)
      }
      const text = stringValue(delta.text, 'Part delta text')
      return {
        type,
        partId,
        delta:
          kind === 'text'
            ? { kind, text }
            : kind === 'reasoning-summary'
              ? { kind, text }
              : { kind: 'tool-arguments', text }
      }
    }
    case 'part.completed': {
      const partId = boundedNonEmptyString(
        event.partId,
        'Completed part id',
        MAX_NORMALIZED_IDENTIFIER_CHARACTERS
      )
      return {
        type,
        partId,
        part: normalizeOutputPart(event.part)
      }
    }
    case 'provider.notice': {
      const level = nonEmptyString(event.level, 'Notice level')
      if (!['debug', 'info', 'warning'].includes(level)) {
        throw protocolProviderError(`Unknown provider notice level "${level}"`)
      }
      const code = boundedNonEmptyString(event.code, 'Notice code', 200)
      const message = boundedString(
        event.message,
        'Notice message',
        MAX_PROVIDER_NOTICE_CHARACTERS
      )
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
        code,
        message,
        ...(retry ? { retry } : {})
      }
    }
    case 'usage.updated': {
      if (event.semantics !== 'cumulative' && event.semantics !== 'delta') {
        throw protocolProviderError('Usage semantics must be cumulative or delta')
      }
      return {
        type,
        usage: normalizeTokenUsage(event.usage),
        semantics: event.semantics
      }
    }
    case 'response.completed': {
      const messageId = boundedNonEmptyString(
        event.messageId,
        'Assistant message id',
        MAX_NORMALIZED_IDENTIFIER_CHARACTERS
      )
      if (typeof event.stopReason !== 'string' || !STOP_REASONS.has(event.stopReason as ModelStopReason)) {
        throw protocolProviderError(`Unknown model stop reason "${String(event.stopReason)}"`)
      }
      const providerStopReason = optionalBoundedNonEmptyString(
        event.providerStopReason,
        'Provider stop reason',
        500
      )
      const usage =
        event.usage === undefined
          ? undefined
          : normalizeTokenUsage(event.usage)
      const providerState =
        event.providerState === undefined
          ? undefined
          : normalizeProviderState(event.providerState)
      const checkpoint =
        event.checkpoint === undefined
          ? undefined
          : cloneBoundedProviderJson(
              event.checkpoint,
              'Provider checkpoint'
            )
      return {
        type,
        messageId,
        stopReason: event.stopReason as ModelStopReason,
        ...(providerStopReason === undefined ? {} : { providerStopReason }),
        ...(usage === undefined ? {} : { usage }),
        ...(providerState === undefined ? {} : { providerState }),
        ...(checkpoint === undefined ? {} : { checkpoint })
      }
    }
    default:
      throw protocolProviderError(`Unknown normalized model event "${type}"`)
  }
}

function normalizeOutputPart(value: unknown): OutputMessagePart {
  const part = asRecord(value, 'Output part')
  const kind = nonEmptyString(part.kind, 'Output part kind')
  const providerState =
    part.providerState === undefined
      ? undefined
      : normalizeProviderState(part.providerState)
  if (kind === 'text' || kind === 'reasoning-summary') {
    const text = boundedString(
      part.text,
      `${kind} text`,
      kind === 'text'
        ? MAX_NORMALIZED_TEXT_CHARACTERS
        : MAX_NORMALIZED_REASONING_CHARACTERS
    )
    return {
      kind,
      text,
      ...(providerState === undefined ? {} : { providerState })
    }
  }
  if (kind === 'tool-call') {
    const callId = boundedNonEmptyString(
      part.callId,
      'Tool call id',
      MAX_NORMALIZED_IDENTIFIER_CHARACTERS
    )
    const name = boundedNonEmptyString(part.name, 'Tool name', 200)
    const rawArguments = boundedString(
      part.rawArguments,
      'Raw tool arguments',
      MAX_NORMALIZED_TOOL_ARGUMENT_CHARACTERS
    )
    let args: JsonObject | undefined
    if (part.arguments !== undefined) {
      try {
        assertJsonObject(part.arguments, 'Tool arguments')
        args = cloneJsonValue(part.arguments)
      } catch (error) {
        throw protocolProviderError('Tool arguments are not a JSON-safe object', error)
      }
    }
    let parseError: string | undefined
    if (part.parseError !== undefined) {
      parseError = boundedString(part.parseError, 'Tool parse error', 10_000)
    }
    return {
      kind,
      callId,
      name,
      rawArguments,
      ...(args === undefined ? {} : { arguments: args }),
      ...(parseError === undefined ? {} : { parseError }),
      ...(providerState === undefined ? {} : { providerState })
    }
  }
  throw protocolProviderError(`Unsupported output part kind "${kind}"`)
}

function normalizeProviderState(value: unknown): ProviderState {
  const state = asRecord(value, 'Provider state')
  const adapterId = boundedNonEmptyString(
    state.adapterId,
    'Provider state adapter id',
    200
  )
  if (state.schemaVersion !== 1) {
    throw protocolProviderError('Provider state schemaVersion must be 1')
  }
  try {
    return {
      adapterId,
      schemaVersion: 1,
      data: cloneBoundedProviderJson(state.data, 'Provider state data')
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw protocolProviderError('Provider state data is not JSON-safe', error)
  }
}

function cloneProviderState(state: ProviderState): ProviderState {
  return {
    adapterId: state.adapterId,
    schemaVersion: 1,
    data: cloneBoundedProviderJson(state.data, 'Provider state data')
  }
}

function cloneOutputPart(part: OutputMessagePart): OutputMessagePart {
  return normalizeOutputPart(part)
}

function cloneBoundedProviderJson(value: unknown, label: string): JsonValue {
  try {
    assertBoundedProviderJson(value, label)
    return cloneJsonValue(value as JsonValue)
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw protocolProviderError(`${label} is not JSON-safe`, error)
  }
}

function cloneJsonValue<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry)) as T
  }
  const output: JsonObject = {}
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: cloneJsonValue(entry),
      writable: true
    })
  }
  return output as T
}

function assertBoundedProviderJson(value: unknown, label: string): void {
  assertJsonValue(value, label)
  const serialized = JSON.stringify(value)
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_PROVIDER_STATE_BYTES
  ) {
    throw protocolProviderError(`${label} exceeds its 1 MB size limit`)
  }
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 }
  ]
  let nodes = 0
  while (stack.length) {
    const current = stack.pop() as {
      value: unknown
      depth: number
    }
    nodes += 1
    if (nodes > MAX_PROVIDER_STATE_NODES) {
      throw protocolProviderError(`${label} contains too many values`)
    }
    if (current.depth > MAX_PROVIDER_STATE_DEPTH) {
      throw protocolProviderError(`${label} is nested too deeply`)
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 })
      }
    } else if (
      current.value !== null &&
      typeof current.value === 'object'
    ) {
      for (const child of Object.values(
        current.value as Record<string, unknown>
      )) {
        stack.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
}

export function assertTokenUsage(value: unknown): asserts value is TokenUsage {
  const usage = asRecord(value, 'Token usage')
  for (const key of Object.keys(usage)) {
    if (!USAGE_KEYS.includes(key as keyof TokenUsage)) {
      throw protocolProviderError(`Unknown token usage field "${key}"`)
    }
  }
  for (const key of USAGE_KEYS) {
    if (usage[key] === undefined) continue
    if (key === 'costUsd') {
      const cost = usage[key]
      if (
        typeof cost !== 'number' ||
        !Number.isFinite(cost) ||
        cost < 0 ||
        cost > MAX_NORMALIZED_COST_USD
      ) {
        throw protocolProviderError(
          `costUsd must be a finite non-negative number no greater than ${MAX_NORMALIZED_COST_USD}`
        )
      }
    } else {
      const count = nonNegativeInteger(usage[key], key)
      if (count > MAX_NORMALIZED_TOKEN_COUNT) {
        throw protocolProviderError(
          `${key} must be no greater than ${MAX_NORMALIZED_TOKEN_COUNT}`
        )
      }
    }
  }
}

function normalizeTokenUsage(value: unknown): TokenUsage {
  assertTokenUsage(value)
  const usage = value as TokenUsage
  const normalized: Record<string, number> = {}
  for (const key of USAGE_KEYS) {
    const amount = usage[key]
    if (amount !== undefined) normalized[key] = amount
  }
  return normalized
}

export function mergeTokenUsage(
  current: TokenUsage | undefined,
  update: TokenUsage,
  semantics: 'cumulative' | 'delta',
  createError: (message: string) => ProviderError = (message) =>
    protocolProviderError(message)
): TokenUsage {
  if (current) assertTokenUsage(current)
  assertTokenUsage(update)
  const merged: TokenUsage = { ...current }
  for (const key of USAGE_KEYS) {
    const next = update[key]
    if (next === undefined) continue
    const previous = merged[key]
    if (semantics === 'delta') {
      const total = (previous ?? 0) + next
      const maximum =
        key === 'costUsd'
          ? MAX_NORMALIZED_COST_USD
          : MAX_NORMALIZED_TOKEN_COUNT
      if (!Number.isFinite(total) || total > maximum) {
        throw createError(`Usage field "${key}" exceeded its supported limit`)
      }
      merged[key] = total
    } else {
      const decreased =
        previous !== undefined &&
        (key === 'costUsd'
          ? next + Math.max(1, previous, next) * 1e-12 < previous
          : next < previous)
      if (decreased) {
        throw createError(
          `Cumulative usage field "${key}" decreased from ${previous} to ${next}`
        )
      }
      merged[key] = next
    }
  }
  return merged
}

function finalizeToolCall(part: ToolCallPart): ToolCallPart {
  if (part.arguments || part.parseError) return part
  const raw = part.rawArguments.trim() || '{}'
  try {
    const parsed = JSON.parse(raw) as unknown
    assertJsonObject(parsed, 'Parsed tool arguments')
    return {
      ...part,
      arguments: parsed
    }
  } catch (error) {
    return {
      ...part,
      parseError: error instanceof Error ? error.message : String(error)
    }
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolProviderError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw protocolProviderError(`${label} must be a string`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  const result = stringValue(value, label)
  if (!result) throw protocolProviderError(`${label} must not be empty`)
  return result
}

function boundedString(
  value: unknown,
  label: string,
  maximumCharacters: number
): string {
  const result = stringValue(value, label)
  if (result.length > maximumCharacters) {
    throw protocolProviderError(`${label} exceeds its size limit`)
  }
  return result
}

function boundedNonEmptyString(
  value: unknown,
  label: string,
  maximumCharacters: number
): string {
  const result = nonEmptyString(value, label)
  if (result.length > maximumCharacters) {
    throw protocolProviderError(`${label} exceeds its size limit`)
  }
  return result
}

function optionalBoundedNonEmptyString(
  value: unknown,
  label: string,
  maximumCharacters: number
): string | undefined {
  return value === undefined
    ? undefined
    : boundedNonEmptyString(value, label, maximumCharacters)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw protocolProviderError(`${label} must be a non-negative integer`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label)
  if (result === 0) throw protocolProviderError(`${label} must be greater than zero`)
  return result
}
