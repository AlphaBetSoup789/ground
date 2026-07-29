import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpenAICompatibleProvider } from '../../shared/types'
import { streamCompletion } from './openai'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

describe('OpenAI-compatible streaming adapter', () => {
  it('normalizes text and fragmented tool calls from SSE', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(
        'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n'
      )
      response.write(
        'data: {"choices":[{"delta":{"content":"there","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\\\"path\\\":"}}]},"finish_reason":null}]}\n\n'
      )
      response.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\\"README.md\\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
      )
      response.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP server')
    const provider: OpenAICompatibleProvider = {
      id: 'test',
      name: 'Test',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'test-model',
      hasApiKey: false,
      supportsTools: true,
      createdAt: '',
      updatedAt: ''
    }
    let streamed = ''
    const result = await streamCompletion({
      provider,
      messages: [{ role: 'user', content: 'Hello' }],
      signal: new AbortController().signal,
      onText: (delta) => {
        streamed += delta
      }
    })

    expect(streamed).toBe('Hello there')
    expect(result.content).toBe('Hello there')
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'read_file',
        argumentsText: '{"path":"README.md"}'
      }
    ])
  })
})
