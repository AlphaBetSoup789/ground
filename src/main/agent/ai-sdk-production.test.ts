import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { AiSdkModelAdapter, type AiSdkProtocol } from './ai-sdk-adapter'
import { consumeModelEventStream } from './event-stream'
import type { ModelRequest } from './types'

function request(): ModelRequest {
  return {
    requestId: 'redirect-test',
    model: 'test-model',
    conversation: [
      {
        kind: 'message',
        id: 'user',
        role: 'user',
        parts: [{ kind: 'text', text: 'Do not redirect this prompt.' }]
      }
    ],
    toolChoice: 'none'
  }
}

describe('production AI SDK network policy', () => {
  it.each<AiSdkProtocol>([
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
    'openai-compatible'
  ])('does not forward %s request bodies across redirects', async (protocol) => {
    let redirectedRequestReceived = false
    const server = createServer((incoming, response) => {
      if (incoming.url === '/redirect-target') {
        redirectedRequestReceived = true
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      const address = server.address() as AddressInfo
      response.writeHead(307, {
        location: `http://127.0.0.1:${address.port}/redirect-target`
      })
      response.end()
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address() as AddressInfo
      const adapter = new AiSdkModelAdapter(protocol)
      await expect(
        consumeModelEventStream(
          adapter.stream(request(), {
            config: {
              protocol,
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiKeyRef:
                protocol === 'openai-compatible'
                  ? undefined
                  : 'test-secret'
            },
            signal: new AbortController().signal,
            secrets: {
              resolve: async () => 'not-a-real-key'
            }
          })
        )
      ).rejects.toThrow()
      expect(redirectedRequestReceived).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }, 30_000)
})
