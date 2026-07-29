import { describe, expect, it } from 'vitest'
import {
  ModelEventReducer,
  assertModelEvent,
  consumeModelEventStream
} from './event-stream'
import { ProviderError } from './errors'
import type { ModelEvent } from './types'

const start: ModelEvent = {
  type: 'response.started',
  responseId: 'response_1',
  servingModel: 'provider/model'
}

function completed(
  stopReason: Extract<ModelEvent, { type: 'response.completed' }>['stopReason'] =
    'complete'
): ModelEvent {
  return {
    type: 'response.completed',
    messageId: 'message_1',
    stopReason
  }
}

describe('model event reduction', () => {
  it('assembles streaming text and preserves provider notices it does not interpret', async () => {
    const result = await consumeModelEventStream([
      {
        type: 'provider.notice',
        level: 'info',
        code: 'provider.experimental.cache-hit',
        message: 'A provider-specific event was normalized as a notice.'
      },
      start,
      {
        type: 'part.started',
        part: { kind: 'text', partId: 'text_1' }
      },
      {
        type: 'part.delta',
        partId: 'text_1',
        delta: { kind: 'text', text: 'Hello' }
      },
      {
        type: 'part.delta',
        partId: 'text_1',
        delta: { kind: 'text', text: ', ground.' }
      },
      {
        type: 'part.completed',
        partId: 'text_1',
        part: { kind: 'text', text: 'Hello, ground.' }
      },
      {
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { inputTokens: 10, outputTokens: 3 }
      },
      completed()
    ])

    expect(result).toMatchObject({
      responseId: 'response_1',
      servingModel: 'provider/model',
      output: {
        id: 'message_1',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'Hello, ground.' }]
      },
      stopReason: 'complete',
      usage: { inputTokens: 10, outputTokens: 3 },
      notices: [
        {
          level: 'info',
          code: 'provider.experimental.cache-hit'
        }
      ]
    })
  })

  it('keeps start order while assembling interleaved reasoning and parallel tool calls', async () => {
    const result = await consumeModelEventStream([
      start,
      {
        type: 'part.started',
        part: { kind: 'reasoning-summary', partId: 'reasoning_1' }
      },
      {
        type: 'part.started',
        part: {
          kind: 'tool-call',
          partId: 'tool_1',
          callId: 'call_weather',
          name: 'weather'
        }
      },
      {
        type: 'part.started',
        part: {
          kind: 'tool-call',
          partId: 'tool_2',
          callId: 'call_time',
          name: 'time'
        }
      },
      {
        type: 'part.delta',
        partId: 'tool_1',
        delta: { kind: 'tool-arguments', text: '{"city":"' }
      },
      {
        type: 'part.delta',
        partId: 'reasoning_1',
        delta: { kind: 'reasoning-summary', text: 'I will check both.' }
      },
      {
        type: 'part.delta',
        partId: 'tool_2',
        delta: { kind: 'tool-arguments', text: '{"zone":"UTC"}' }
      },
      {
        type: 'part.delta',
        partId: 'tool_1',
        delta: { kind: 'tool-arguments', text: 'New York"}' }
      },
      {
        type: 'part.completed',
        partId: 'tool_2',
        part: {
          kind: 'tool-call',
          callId: 'call_time',
          name: 'time',
          rawArguments: '{"zone":"UTC"}'
        }
      },
      {
        type: 'part.completed',
        partId: 'reasoning_1',
        part: {
          kind: 'reasoning-summary',
          text: 'I will check both.'
        }
      },
      {
        type: 'part.completed',
        partId: 'tool_1',
        part: {
          kind: 'tool-call',
          callId: 'call_weather',
          name: 'weather',
          rawArguments: '{"city":"New York"}',
          providerState: {
            adapterId: 'provider',
            schemaVersion: 1,
            data: { opaqueItemId: 'item_1' }
          }
        }
      },
      {
        type: 'response.completed',
        messageId: 'message_1',
        stopReason: 'tool-calls',
        providerStopReason: 'function_call',
        providerState: {
          adapterId: 'provider',
          schemaVersion: 1,
          data: { continuation: 'opaque_1' }
        },
        checkpoint: { responseId: 'response_1' }
      }
    ])

    expect(result.output.parts).toEqual([
      {
        kind: 'reasoning-summary',
        text: 'I will check both.'
      },
      {
        kind: 'tool-call',
        callId: 'call_weather',
        name: 'weather',
        rawArguments: '{"city":"New York"}',
        arguments: { city: 'New York' },
        providerState: {
          adapterId: 'provider',
          schemaVersion: 1,
          data: { opaqueItemId: 'item_1' }
        }
      },
      {
        kind: 'tool-call',
        callId: 'call_time',
        name: 'time',
        rawArguments: '{"zone":"UTC"}',
        arguments: { zone: 'UTC' }
      }
    ])
    expect(result).toMatchObject({
      stopReason: 'tool-calls',
      providerStopReason: 'function_call',
      checkpoint: { responseId: 'response_1' },
      output: {
        providerState: {
          adapterId: 'provider',
          data: { continuation: 'opaque_1' }
        }
      }
    })
  })

  it('applies declared cumulative and delta usage semantics', async () => {
    const result = await consumeModelEventStream([
      start,
      {
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { inputTokens: 10, outputTokens: 1 }
      },
      {
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { inputTokens: 10, outputTokens: 3 }
      },
      {
        type: 'usage.updated',
        semantics: 'delta',
        usage: { outputTokens: 2, reasoningTokens: 1 }
      },
      completed()
    ])

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1
    })
  })

  it('retains malformed tool arguments as debuggable output', async () => {
    const result = await consumeModelEventStream([
      start,
      {
        type: 'part.started',
        part: {
          kind: 'tool-call',
          partId: 'tool_1',
          callId: 'call_1',
          name: 'broken'
        }
      },
      {
        type: 'part.delta',
        partId: 'tool_1',
        delta: { kind: 'tool-arguments', text: '{"unfinished":' }
      },
      {
        type: 'part.completed',
        partId: 'tool_1',
        part: {
          kind: 'tool-call',
          callId: 'call_1',
          name: 'broken',
          rawArguments: '{"unfinished":'
        }
      },
      completed('malformed-tool-call')
    ])

    expect(result.output.parts[0]).toMatchObject({
      kind: 'tool-call',
      rawArguments: '{"unfinished":'
    })
    expect(result.output.parts[0]).toHaveProperty('parseError')
  })
})

describe('model stream protocol safeguards', () => {
  it('rejects malformed event ordering and mismatched deltas', () => {
    const beforeStart = new ModelEventReducer()
    expect(() =>
      beforeStart.push({
        type: 'part.delta',
        partId: 'text_1',
        delta: { kind: 'text', text: 'early' }
      })
    ).toThrow(/before response\.started/)

    const unknownPart = new ModelEventReducer()
    unknownPart.push(start)
    expect(() =>
      unknownPart.push({
        type: 'part.delta',
        partId: 'missing',
        delta: { kind: 'text', text: 'lost' }
      })
    ).toThrow(/unknown part/)

    const wrongDelta = new ModelEventReducer()
    wrongDelta.push(start)
    wrongDelta.push({
      type: 'part.started',
      part: { kind: 'text', partId: 'text_1' }
    })
    expect(() =>
      wrongDelta.push({
        type: 'part.delta',
        partId: 'text_1',
        delta: { kind: 'tool-arguments', text: '{}' }
      })
    ).toThrow(/received tool-arguments delta/)

    expect(() => assertModelEvent({ type: 'provider.future-wire-event' })).toThrow(
      /Unknown normalized model event/
    )
  })

  it('rejects incomplete, contradictory, and unterminated streams', async () => {
    await expect(
      consumeModelEventStream([
        start,
        {
          type: 'part.started',
          part: { kind: 'text', partId: 'text_1' }
        },
        completed()
      ])
    ).rejects.toThrow(/before part "text_1" completed/)

    await expect(
      consumeModelEventStream([
        start,
        {
          type: 'part.started',
          part: { kind: 'text', partId: 'text_1' }
        },
        {
          type: 'part.delta',
          partId: 'text_1',
          delta: { kind: 'text', text: 'one' }
        },
        {
          type: 'part.completed',
          partId: 'text_1',
          part: { kind: 'text', text: 'different' }
        }
      ])
    ).rejects.toThrow(/does not match its deltas/)

    await expect(consumeModelEventStream([start])).rejects.toThrow(
      /without response\.completed/
    )
  })

  it('rejects duplicate terminal events and decreasing cumulative usage', () => {
    const duplicate = new ModelEventReducer()
    duplicate.push(start)
    duplicate.push(completed())
    expect(() => duplicate.push(completed())).toThrow(
      /after response\.completed/
    )

    const usage = new ModelEventReducer()
    usage.push(start)
    usage.push({
      type: 'usage.updated',
      semantics: 'cumulative',
      usage: { outputTokens: 5 }
    })
    expect(() =>
      usage.push({
        type: 'usage.updated',
        semantics: 'cumulative',
        usage: { outputTokens: 4 }
      })
    ).toThrow(/decreased from 5 to 4/)
  })

  it('bounds cumulative normalized model output before it reaches durable history', () => {
    const reducer = new ModelEventReducer()
    reducer.push(start)
    reducer.push({
      type: 'part.started',
      part: { kind: 'text', partId: 'text_1' }
    })
    reducer.push({
      type: 'part.delta',
      partId: 'text_1',
      delta: { kind: 'text', text: 'x'.repeat(1_000_000) }
    })

    let failure: unknown
    try {
      reducer.push({
        type: 'part.delta',
        partId: 'text_1',
        delta: { kind: 'text', text: 'y'.repeat(1_000_001) }
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      category: 'protocol',
      partialOutput: true
    })
    expect(String(failure)).toMatch(/assistant text exceeded its size limit/i)
  })

  it('bounds provider-controlled identifiers and notice counts', () => {
    expect(() =>
      assertModelEvent({
        type: 'response.started',
        responseId: 'r'.repeat(201)
      })
    ).toThrow(/responseId exceeds its size limit/i)

    const reducer = new ModelEventReducer()
    for (let index = 0; index < 100; index += 1) {
      reducer.push({
        type: 'provider.notice',
        level: 'info',
        code: `notice-${index}`,
        message: 'bounded'
      })
    }
    expect(() =>
      reducer.push({
        type: 'provider.notice',
        level: 'info',
        code: 'notice-overflow',
        message: 'bounded'
      })
    ).toThrow(/too many notices/i)
  })

  it('bounds opaque provider state and continuation checkpoints', () => {
    expect(() =>
      assertModelEvent({
        type: 'response.completed',
        messageId: 'message',
        stopReason: 'complete',
        providerState: {
          adapterId: 'test.adapter',
          schemaVersion: 1,
          data: {
            value: 'x'.repeat(1_000_001)
          }
        }
      })
    ).toThrow(/1 MB size limit/i)

    expect(() =>
      assertModelEvent({
        type: 'response.completed',
        messageId: 'message',
        stopReason: 'complete',
        checkpoint: {
          value: 'x'.repeat(1_000_001)
        }
      })
    ).toThrow(/1 MB size limit/i)
  })

  it('reports cancellation distinctly', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      consumeModelEventStream([], { signal: controller.signal })
    ).rejects.toMatchObject({
      category: 'cancelled',
      retryable: false,
      partialOutput: false
    })
  })

  it('marks transport errors after emitted output as partial', async () => {
    async function* brokenStream(): AsyncGenerator<ModelEvent> {
      yield start
      yield {
        type: 'part.started',
        part: { kind: 'text', partId: 'text_1' }
      }
      yield {
        type: 'part.delta',
        partId: 'text_1',
        delta: { kind: 'text', text: 'partial' }
      }
      throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    }

    await expect(consumeModelEventStream(brokenStream())).rejects.toMatchObject({
      category: 'network',
      retryable: true,
      partialOutput: true
    })
  })

  it('turns failures after the terminal event into protocol errors', async () => {
    async function* brokenStream(): AsyncGenerator<ModelEvent> {
      yield start
      yield completed()
      throw new Error('late transport failure')
    }

    const rejection = consumeModelEventStream(brokenStream())
    await expect(rejection).rejects.toBeInstanceOf(ProviderError)
    await expect(rejection).rejects.toMatchObject({
      category: 'protocol',
      retryable: false
    })
  })
})
