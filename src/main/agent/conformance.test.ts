import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_RUNTIME_CAPABILITIES,
  DEFAULT_MODEL_CAPABILITIES
} from './capabilities'
import {
  AdapterConformanceError,
  AGENT_RUNTIME_EVENT_LIMITS,
  AgentRuntimeEventReducer,
  GROUND_ADAPTER_API_VERSION,
  GROUND_ADAPTER_CONFORMANCE_VERSION,
  assertAgentRuntimeAdapterConformance,
  assertModelAdapterConformance,
  consumeAgentRuntimeEventStream,
  runAgentRuntimeAdapterConformance,
  runModelAdapterConformance
} from './conformance'
import type {
  AgentRuntimeAdapter,
  ModelAdapter
} from './contracts'
import {
  MAX_NORMALIZED_COST_USD,
  MAX_NORMALIZED_TOKEN_COUNT,
  ModelEventReducer
} from './event-stream'
import { cancelledProviderError } from './errors'
import type {
  AgentRuntimeEvent,
  ModelEvent
} from './types'

interface FixtureConfig {
  endpoint: string
}

function validateFixtureConfig(value: unknown): FixtureConfig {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { endpoint?: unknown }).endpoint !== 'string'
  ) {
    throw new TypeError('endpoint is required')
  }
  return { endpoint: (value as { endpoint: string }).endpoint }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledProviderError('Fixture was cancelled', signal.reason)
  }
}

function conformingModelAdapter(): ModelAdapter<FixtureConfig> {
  return {
    id: 'fixture.model',
    validateConfig: validateFixtureConfig,
    async inspect(context) {
      throwIfAborted(context.signal)
      return {
        models: [{ id: 'fixture-model', contextWindowTokens: 16_000 }],
        capabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          streaming: 'native',
          usageReporting: 'native',
          cancellation: 'abort-signal'
        }
      }
    },
    async *stream(_request, context): AsyncIterable<ModelEvent> {
      throwIfAborted(context.signal)
      yield {
        type: 'response.started',
        responseId: 'fixture-response',
        servingModel: 'fixture-model'
      }
      await Promise.resolve()
      throwIfAborted(context.signal)
      yield {
        type: 'part.started',
        part: { kind: 'text', partId: 'fixture-text' }
      }
      yield {
        type: 'part.delta',
        partId: 'fixture-text',
        delta: { kind: 'text', text: 'fixture response' }
      }
      yield {
        type: 'part.completed',
        partId: 'fixture-text',
        part: { kind: 'text', text: 'fixture response' }
      }
      yield {
        type: 'provider.notice',
        level: 'info',
        code: 'fixture',
        message: 'deterministic fixture'
      }
      yield {
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
          costUsd: 0.001
        }
      }
      yield {
        type: 'response.completed',
        messageId: 'fixture-message',
        stopReason: 'complete',
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
          costUsd: 0.001
        }
      }
    }
  }
}

function conformingRuntimeAdapter(): AgentRuntimeAdapter<FixtureConfig> {
  return {
    id: 'fixture.runtime',
    validateConfig: validateFixtureConfig,
    async inspect(context) {
      throwIfAborted(context.signal)
      return {
        version: '1.0.0-fixture',
        capabilities: {
          ...DEFAULT_AGENT_RUNTIME_CAPABILITIES,
          structuredEvents: 'native',
          sessionResume: 'native',
          assistantStreaming: 'native',
          cancellation: 'process-signal',
          permissionOwner: 'runtime'
        }
      }
    },
    async *run(_request, context): AsyncIterable<AgentRuntimeEvent> {
      throwIfAborted(context.signal)
      yield {
        type: 'runtime.started',
        sessionId: 'fixture-session',
        servingModel: 'fixture-model'
      }
      await Promise.resolve()
      throwIfAborted(context.signal)
      yield { type: 'assistant.delta', delta: 'fixture response' }
      yield {
        type: 'activity.started',
        activityId: 'fixture-activity',
        kind: 'diagnostic',
        title: 'Inspect fixture'
      }
      yield {
        type: 'activity.completed',
        activityId: 'fixture-activity',
        status: 'success'
      }
      yield {
        type: 'provider.notice',
        level: 'info',
        code: 'fixture',
        message: 'deterministic fixture'
      }
      yield {
        type: 'usage.updated',
        semantics: 'delta',
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.002 }
      }
      yield {
        type: 'runtime.completed',
        sessionId: 'fixture-session',
        stopReason: 'complete',
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.002 }
      }
    }
  }
}

describe('published adapter conformance', () => {
  it('passes a deterministic model adapter through every required check', async () => {
    const report = await assertModelAdapterConformance({
      adapter: conformingModelAdapter(),
      validConfig: { endpoint: 'https://fixture.invalid' },
      invalidConfigs: [null, {}],
      timeoutMs: 500
    })

    expect(report).toMatchObject({
      apiVersion: GROUND_ADAPTER_API_VERSION,
      conformanceVersion: GROUND_ADAPTER_CONFORMANCE_VERSION,
      adapterKind: 'model',
      adapterId: 'fixture.model',
      passed: true
    })
    expect(report.checks).toEqual(
      expect.arrayContaining([
        { id: 'config.valid', status: 'passed' },
        { id: 'config.invalid', status: 'passed' },
        { id: 'inspection', status: 'passed' },
        { id: 'stream.lifecycle', status: 'passed' },
        { id: 'cancellation.pre-aborted', status: 'passed' },
        { id: 'cancellation.during-stream', status: 'passed' }
      ])
    )
  })

  it('passes a deterministic runtime adapter through lifecycle and process cancellation', async () => {
    const report = await assertAgentRuntimeAdapterConformance({
      adapter: conformingRuntimeAdapter(),
      validConfig: { endpoint: 'fixture-cli' },
      invalidConfigs: [undefined, 'fixture-cli'],
      timeoutMs: 500
    })

    expect(report).toMatchObject({
      apiVersion: 1,
      conformanceVersion: 1,
      adapterKind: 'agent-runtime',
      adapterId: 'fixture.runtime',
      passed: true
    })
    expect(
      report.checks.filter((check) => check.status === 'failed')
    ).toEqual([])
  })

  it('accepts compliant adapters that reject a pre-aborted signal synchronously', async () => {
    const modelDelegate = conformingModelAdapter()
    const model: ModelAdapter<FixtureConfig> = {
      ...modelDelegate,
      stream(request, context) {
        context.signal.throwIfAborted()
        return modelDelegate.stream(request, context)
      }
    }
    const runtimeDelegate = conformingRuntimeAdapter()
    const runtime: AgentRuntimeAdapter<FixtureConfig> = {
      ...runtimeDelegate,
      run(request, context) {
        context.signal.throwIfAborted()
        return runtimeDelegate.run(request, context)
      }
    }

    const [modelReport, runtimeReport] = await Promise.all([
      runModelAdapterConformance({
        adapter: model,
        validConfig: { endpoint: 'https://fixture.invalid' },
        invalidConfigs: [null],
        timeoutMs: 500
      }),
      runAgentRuntimeAdapterConformance({
        adapter: runtime,
        validConfig: { endpoint: 'fixture-cli' },
        invalidConfigs: [null],
        timeoutMs: 500
      })
    ])

    for (const report of [modelReport, runtimeReport]) {
      expect(
        report.checks.find(
          (check) => check.id === 'cancellation.pre-aborted'
        )
      ).toEqual({
        id: 'cancellation.pre-aborted',
        status: 'passed'
      })
      expect(report.passed).toBe(true)
    }
  })

  it('does not construct an adapter iterator for pre-aborted consumption', async () => {
    const controller = new AbortController()
    controller.abort()
    let iteratorConstructions = 0
    const stream: AsyncIterable<AgentRuntimeEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
        iteratorConstructions += 1
        return {
          next: async () => ({ done: true, value: undefined })
        }
      }
    }

    await expect(
      consumeAgentRuntimeEventStream(stream, {
        signal: controller.signal
      })
    ).rejects.toMatchObject({
      category: 'cancelled',
      retryable: false,
      partialOutput: false
    })
    expect(iteratorConstructions).toBe(0)
  })

  it('reports dishonest cancellation and throws only from the assert helper', async () => {
    const runtime = conformingRuntimeAdapter()
    runtime.run = async function* (): AsyncIterable<AgentRuntimeEvent> {
      yield { type: 'runtime.started' }
      yield { type: 'runtime.completed', stopReason: 'complete' }
    }
    const fixture = {
      adapter: runtime,
      validConfig: { endpoint: 'fixture-cli' },
      invalidConfigs: [null],
      timeoutMs: 500
    }

    const report = await runAgentRuntimeAdapterConformance(fixture)
    expect(report.passed).toBe(false)
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cancellation.pre-aborted',
          status: 'failed'
        }),
        expect.objectContaining({
          id: 'cancellation.during-stream',
          status: 'failed'
        })
      ])
    )
    await expect(
      assertAgentRuntimeAdapterConformance(fixture)
    ).rejects.toBeInstanceOf(AdapterConformanceError)
  })

  it('does not misclassify unrelated adapter failures as cancellation', async () => {
    const runtime = conformingRuntimeAdapter()
    runtime.run = async function* (
      _request,
      context
    ): AsyncIterable<AgentRuntimeEvent> {
      if (context.signal.aborted) {
        throw new Error('authentication setup failed')
      }
      yield { type: 'runtime.started' }
      if (context.signal.aborted) {
        throw new Error('unrelated process crash')
      }
      yield { type: 'runtime.completed', stopReason: 'complete' }
    }

    const report = await runAgentRuntimeAdapterConformance({
      adapter: runtime,
      validConfig: { endpoint: 'fixture-cli' },
      invalidConfigs: [null],
      timeoutMs: 500
    })

    expect(
      report.checks.find((check) => check.id === 'stream.lifecycle')
    ).toEqual({ id: 'stream.lifecycle', status: 'passed' })
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cancellation.pre-aborted',
          status: 'failed',
          detail: expect.stringMatching(/instead of cancellation/u)
        }),
        expect.objectContaining({
          id: 'cancellation.during-stream',
          status: 'failed',
          detail: expect.stringMatching(/instead of cancellation/u)
        })
      ])
    )
    expect(report.passed).toBe(false)
  })

  it('aborts timed-out work and closes a hanging stream best effort', async () => {
    const runtime = conformingRuntimeAdapter()
    let inspectionAborted = false
    let streamAborted = false
    let iteratorReturnCalls = 0

    runtime.inspect = (context) =>
      new Promise((_resolve) => {
        context.signal.addEventListener(
          'abort',
          () => {
            inspectionAborted = true
          },
          { once: true }
        )
      })
    runtime.run = (_request, context) => {
      context.signal.addEventListener(
        'abort',
        () => {
          streamAborted = true
        },
        { once: true }
      )
      const iterator: AsyncIterator<AgentRuntimeEvent> = {
        next: () => new Promise(() => undefined),
        return: async () => {
          iteratorReturnCalls += 1
          return { done: true, value: undefined }
        }
      }
      return {
        [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
          return iterator
        }
      }
    }

    const report = await runAgentRuntimeAdapterConformance({
      adapter: runtime,
      validConfig: { endpoint: 'fixture-cli' },
      invalidConfigs: [null],
      timeoutMs: 50
    })

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'inspection', status: 'failed' }),
        expect.objectContaining({ id: 'stream.lifecycle', status: 'failed' })
      ])
    )
    expect(inspectionAborted).toBe(true)
    expect(streamAborted).toBe(true)
    expect(iteratorReturnCalls).toBeGreaterThanOrEqual(1)
  })

  it('rejects incomplete inspections and missing invalid-config fixtures', async () => {
    const model = conformingModelAdapter()
    model.inspect = async () => ({
      capabilities: {
        streaming: 'native'
      } as never
    })

    const report = await runModelAdapterConformance({
      adapter: model,
      validConfig: { endpoint: 'https://fixture.invalid' },
      invalidConfigs: []
    })

    expect(report.passed).toBe(false)
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'config.invalid', status: 'failed' }),
        expect.objectContaining({ id: 'inspection', status: 'failed' })
      ])
    )
  })
})

describe('agent runtime event reducer', () => {
  it('returns detached events and reduces a complete, bounded lifecycle', () => {
    const reducer = new AgentRuntimeEventReducer()
    const rawStarted = {
      type: 'runtime.started',
      sessionId: 'session-1',
      servingModel: 'model-1',
      ignored: 'not propagated'
    }
    const started = reducer.push(rawStarted)
    expect(started).toEqual({
      type: 'runtime.started',
      sessionId: 'session-1',
      servingModel: 'model-1'
    })
    expect(started).not.toBe(rawStarted)

    reducer.push({ type: 'assistant.delta', delta: 'Hello' })
    reducer.push({
      type: 'activity.started',
      activityId: 'activity-1',
      kind: 'command',
      title: 'Run fixture'
    })
    reducer.push({
      type: 'activity.updated',
      activityId: 'activity-1',
      detail: 'Still running'
    })
    reducer.push({
      type: 'activity.completed',
      activityId: 'activity-1',
      status: 'success'
    })
    const rawUsage = {
      type: 'usage.updated',
      semantics: 'cumulative',
      usage: { inputTokens: 2, costUsd: 0.25 }
    }
    const validatedUsage = reducer.push(rawUsage)
    rawUsage.usage.inputTokens = 999
    expect(validatedUsage).toMatchObject({
      usage: { inputTokens: 2, costUsd: 0.25 }
    })
    reducer.push({
      type: 'runtime.completed',
      sessionId: 'session-1',
      stopReason: 'complete',
      usage: { inputTokens: 2, costUsd: 0.25 }
    })

    expect(reducer.finish()).toEqual({
      sessionId: 'session-1',
      servingModel: 'model-1',
      assistantText: 'Hello',
      stopReason: 'complete',
      usage: { inputTokens: 2, costUsd: 0.25 },
      notices: [],
      completedActivityCount: 1
    })
  })

  it('accounts for each activity text field exactly once at the aggregate boundary', () => {
    const reducer = new AgentRuntimeEventReducer()
    reducer.push({ type: 'runtime.started' })
    const detail = 'd'.repeat(
      AGENT_RUNTIME_EVENT_LIMITS.activityTextCharacters / 20 - 1
    )
    for (let index = 0; index < 20; index += 1) {
      reducer.push({
        type: 'activity.started',
        activityId: `activity-${index}`,
        kind: 'diagnostic',
        title: 'x',
        detail
      })
      reducer.push({
        type: 'activity.completed',
        activityId: `activity-${index}`,
        status: 'success'
      })
    }
    reducer.push({ type: 'runtime.completed', stopReason: 'complete' })
    expect(reducer.finish().completedActivityCount).toBe(20)

    const overflowing = new AgentRuntimeEventReducer()
    overflowing.push({ type: 'runtime.started' })
    for (let index = 0; index < 20; index += 1) {
      overflowing.push({
        type: 'activity.started',
        activityId: `activity-${index}`,
        kind: 'diagnostic',
        title: 'x',
        detail
      })
      if (index < 19) {
        overflowing.push({
          type: 'activity.completed',
          activityId: `activity-${index}`,
          status: 'success'
        })
      }
    }
    expect(() =>
      overflowing.push({
        type: 'activity.updated',
        activityId: 'activity-19',
        detail: 'x'
      })
    ).toThrow(/activity text exceeded/)
  })

  it('bounds the number of activities in one runtime response', () => {
    const reducer = new AgentRuntimeEventReducer()
    reducer.push({ type: 'runtime.started' })
    for (
      let index = 0;
      index < AGENT_RUNTIME_EVENT_LIMITS.activities;
      index += 1
    ) {
      reducer.push({
        type: 'activity.started',
        activityId: `activity-${index}`,
        kind: 'diagnostic',
        title: 'x'
      })
      reducer.push({
        type: 'activity.completed',
        activityId: `activity-${index}`,
        status: 'success'
      })
    }

    expect(() =>
      reducer.push({
        type: 'activity.started',
        activityId: 'one-too-many',
        kind: 'diagnostic',
        title: 'x'
      })
    ).toThrow(/too many activities/)
  })

  it('rejects illegal order, activity reuse, session drift, and post-terminal events', () => {
    const beforeStart = new AgentRuntimeEventReducer()
    expect(() =>
      beforeStart.push({ type: 'assistant.delta', delta: 'early' })
    ).toThrow(/before runtime\.started/)

    const duplicateStart = new AgentRuntimeEventReducer()
    duplicateStart.push({ type: 'runtime.started' })
    expect(() =>
      duplicateStart.push({ type: 'runtime.started' })
    ).toThrow(/first event|more than once/)

    const activities = new AgentRuntimeEventReducer()
    activities.push({ type: 'runtime.started' })
    expect(() =>
      activities.push({
        type: 'activity.updated',
        activityId: 'missing',
        detail: 'unknown'
      })
    ).toThrow(/unknown or completed/)
    activities.push({
      type: 'activity.started',
      activityId: 'same',
      kind: 'tool',
      title: 'Fixture'
    })
    expect(() =>
      activities.push({ type: 'runtime.completed', stopReason: 'complete' })
    ).toThrow(/before every activity completed/)
    activities.push({
      type: 'activity.completed',
      activityId: 'same',
      status: 'success'
    })
    expect(() =>
      activities.push({
        type: 'activity.started',
        activityId: 'same',
        kind: 'tool',
        title: 'Fixture again'
      })
    ).toThrow(/started more than once/)

    const session = new AgentRuntimeEventReducer()
    session.push({ type: 'runtime.started', sessionId: 'session-a' })
    expect(() =>
      session.push({
        type: 'runtime.completed',
        sessionId: 'session-b',
        stopReason: 'complete'
      })
    ).toThrow(/changed the runtime session id/)

    const terminal = new AgentRuntimeEventReducer()
    terminal.push({ type: 'runtime.started' })
    terminal.push({ type: 'runtime.completed', stopReason: 'complete' })
    expect(() =>
      terminal.push({ type: 'assistant.delta', delta: 'late' })
    ).toThrow(/after runtime\.completed/)

    const incomplete = new AgentRuntimeEventReducer()
    incomplete.push({ type: 'runtime.started' })
    expect(() => incomplete.finish()).toThrow(/without runtime\.completed/)
  })

  it('rejects future events and bounded-field or usage violations', () => {
    const future = new AgentRuntimeEventReducer()
    expect(() =>
      future.push({ type: 'runtime.future-wire-event' })
    ).toThrow(/Unknown normalized agent runtime event/)

    const identifier = new AgentRuntimeEventReducer()
    expect(() =>
      identifier.push({
        type: 'runtime.started',
        sessionId: 's'.repeat(
          AGENT_RUNTIME_EVENT_LIMITS.identifierCharacters + 1
        )
      })
    ).toThrow(/size limit/)

    const notices = new AgentRuntimeEventReducer()
    notices.push({ type: 'runtime.started' })
    for (let index = 0; index < AGENT_RUNTIME_EVENT_LIMITS.notices; index += 1) {
      notices.push({
        type: 'provider.notice',
        level: 'debug',
        code: `notice-${index}`,
        message: ''
      })
    }
    expect(() =>
      notices.push({
        type: 'provider.notice',
        level: 'debug',
        code: 'one-too-many',
        message: ''
      })
    ).toThrow(/too many notices/)

    const usage = new AgentRuntimeEventReducer()
    usage.push({ type: 'runtime.started' })
    expect(() =>
      usage.push({
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { inputTokens: 1.5 }
      })
    ).toThrow(/non-negative integer/)
    expect(() =>
      usage.push({
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { costUsd: MAX_NORMALIZED_COST_USD + 1 }
      })
    ).toThrow(/costUsd/)
    expect(() =>
      usage.push({
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { totalTokens: MAX_NORMALIZED_TOKEN_COUNT + 1 }
      })
    ).toThrow(/totalTokens/)
    usage.push({
      type: 'usage.updated',
      semantics: 'cumulative',
      usage: { inputTokens: 2 }
    })
    expect(() =>
      usage.push({
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { inputTokens: 1 }
      })
    ).toThrow(/decreased/)
  })
})

describe('model usage cost contract', () => {
  it('accepts bounded fractional USD cost and rejects over-limit cost', () => {
    const reducer = new ModelEventReducer()
    reducer.push({ type: 'response.started' })
    reducer.push({
      type: 'usage.updated',
      semantics: 'cumulative',
      usage: { costUsd: 0.1234 }
    })
    reducer.push({
      type: 'response.completed',
      messageId: 'message',
      stopReason: 'complete',
      usage: { costUsd: 0.1234 }
    })
    expect(reducer.finish().usage).toEqual({ costUsd: 0.1234 })

    const invalid = new ModelEventReducer()
    invalid.push({ type: 'response.started' })
    expect(() =>
      invalid.push({
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { costUsd: Number.POSITIVE_INFINITY }
      })
    ).toThrow(/costUsd/)
  })

  it('tolerates floating-point rounding when delta cost becomes cumulative', () => {
    const reducer = new ModelEventReducer()
    reducer.push({ type: 'response.started' })
    reducer.push({
      type: 'usage.updated',
      semantics: 'delta',
      usage: { costUsd: 0.1 }
    })
    reducer.push({
      type: 'usage.updated',
      semantics: 'delta',
      usage: { costUsd: 0.2 }
    })
    reducer.push({
      type: 'response.completed',
      messageId: 'message',
      stopReason: 'complete',
      usage: { costUsd: 0.3 }
    })
    expect(reducer.finish().usage).toEqual({ costUsd: 0.3 })
  })
})
