import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import {
  AiSdkModelAdapter,
  limitProviderResponse,
  providerFetch,
  toAiSdkMessages
} from './ai-sdk-adapter'
import { consumeModelEventStream } from './event-stream'
import type { ModelRequest } from './types'

function request(): ModelRequest {
  return {
    requestId: 'request_1',
    model: 'test-model',
    instructions: 'Work inside the logical workspace root.',
    conversation: [
      {
        kind: 'message',
        id: 'user_1',
        role: 'user',
        parts: [{ kind: 'text', text: 'Read the README.' }]
      }
    ],
    tools: [
      {
        name: 'read_file',
        description: 'Read a workspace-relative file.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          },
          required: ['path'],
          additionalProperties: false
        }
      }
    ]
  }
}

describe('AI SDK model adapter', () => {
  it('forces provider requests to reject redirects', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await providerFetch('https://api.example.com/v1/messages', {
        method: 'POST',
        redirect: 'follow'
      })
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          redirect: 'error'
        })
      )
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  it('bounds provider response bodies before protocol parsing', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.enqueue(new Uint8Array([4, 5, 6]))
          controller.close()
        }
      })
    )
    const limited = await limitProviderResponse(response, 5)
    await expect(limited.arrayBuffer()).rejects.toThrow(/safety limit/i)

    await expect(
      limitProviderResponse(
        new Response('small', {
          headers: { 'content-length': '100' }
        }),
        5
      )
    ).rejects.toThrow(/safety limit/i)
  })

  it('validates protocol-specific configuration and secret requirements', () => {
    const openai = new AiSdkModelAdapter('openai-responses')
    const compatible = new AiSdkModelAdapter('openai-compatible')

    expect(() =>
      openai.validateConfig({ protocol: 'openai-responses' })
    ).toThrow(/secret reference/i)
    expect(() =>
      compatible.validateConfig({ protocol: 'openai-compatible' })
    ).toThrow(/base URL/i)
    expect(() =>
      compatible.validateConfig({
        protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1'
      })
    ).not.toThrow()
    expect(() =>
      openai.validateConfig({
        protocol: 'anthropic-messages',
        apiKeyRef: 'provider:key'
      })
    ).toThrow(/cannot load/i)
  })

  it('normalizes streamed text, tool calls, usage, and response metadata', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'test-model',
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'response-metadata',
              id: 'response_1',
              modelId: 'served-model',
              timestamp: new Date(0)
            },
            { type: 'text-start', id: 'text_1' },
            { type: 'text-delta', id: 'text_1', delta: 'I will read it.' },
            { type: 'text-end', id: 'text_1' },
            {
              type: 'tool-input-start',
              id: 'call_1',
              toolName: 'read_file'
            },
            {
              type: 'tool-input-delta',
              id: 'call_1',
              delta: '{"path":"README.md"}'
            },
            { type: 'tool-input-end', id: 'call_1' },
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'read_file',
              input: '{"path":"README.md"}'
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: {
                inputTokens: {
                  total: 12,
                  noCache: 10,
                  cacheRead: 2,
                  cacheWrite: 0
                },
                outputTokens: {
                  total: 7,
                  text: 5,
                  reasoning: 2
                }
              }
            }
          ]
        })
      }
    })
    const adapter = new AiSdkModelAdapter('openai-compatible', () => model)
    const controller = new AbortController()
    const reduced = await consumeModelEventStream(
      adapter.stream(request(), {
        config: {
          protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:11434/v1'
        },
        signal: controller.signal,
        secrets: {
          resolve: async () => {
            throw new Error('No secret expected')
          }
        }
      })
    )

    expect(reduced).toMatchObject({
      responseId: undefined,
      servingModel: 'test-model',
      stopReason: 'tool-calls',
      providerStopReason: 'tool_calls',
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        cachedInputTokens: 2,
        reasoningTokens: 2,
        totalTokens: 19
      },
      output: {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'I will read it.' },
          {
            kind: 'tool-call',
            callId: 'call_1',
            name: 'read_file',
            rawArguments: '{"path":"README.md"}',
            arguments: { path: 'README.md' }
          }
        ]
      }
    })
    expect(reduced.checkpoint).toBeUndefined()
    expect(model.doStreamCalls).toHaveLength(1)
    expect(model.doStreamCalls[0]?.prompt).toMatchObject([
      {
        role: 'system',
        content: 'Work inside the logical workspace root.'
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Read the README.' }]
      }
    ])
  })

  it('replays opaque provider options only through their owning adapter', () => {
    const conversation: ModelRequest['conversation'] = [
      {
        kind: 'message',
        id: 'assistant_1',
        role: 'assistant',
        parts: [
          {
            kind: 'tool-call',
            callId: 'call_1',
            name: 'lookup',
            rawArguments: '{"query":"ground"}',
            arguments: { query: 'ground' },
            providerState: {
              adapterId: 'google.generative-ai',
              schemaVersion: 1,
              data: {
                providerOptions: {
                  google: {
                    thoughtSignature: 'opaque-signature'
                  }
                }
              }
            }
          }
        ]
      }
    ]

    const owning = toAiSdkMessages(conversation, 'google.generative-ai')
    const switched = toAiSdkMessages(conversation, 'anthropic.messages')

    expect(owning[0]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          providerOptions: {
            google: {
              thoughtSignature: 'opaque-signature'
            }
          }
        }
      ]
    })
    expect(switched[0]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          providerOptions: undefined
        }
      ]
    })
  })
})
