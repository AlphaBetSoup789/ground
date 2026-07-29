import type { OpenAICompatibleProvider } from '../../shared/types'

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ParsedToolCall {
  id: string
  name: string
  argumentsText: string
}

export interface CompletionRoundResult {
  content: string
  toolCalls: ParsedToolCall[]
  finishReason?: string
}

interface StreamCompletionInput {
  provider: OpenAICompatibleProvider
  apiKey?: string
  messages: OpenAIMessage[]
  tools?: ToolDefinition[]
  signal: AbortSignal
  onText: (delta: string) => void
}

interface ToolCallAccumulator {
  id: string
  name: string
  argumentsText: string
}

function chatEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

export function modelsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) {
    return `${normalized.slice(0, -'/chat/completions'.length)}/models`
  }
  return `${normalized}/models`
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text
      }
      return ''
    })
    .join('')
}

function ingestChunk(
  payload: unknown,
  accumulator: { content: string; finishReason?: string; tools: Map<number, ToolCallAccumulator> },
  onText: (delta: string) => void
): void {
  if (!payload || typeof payload !== 'object') return
  const root = payload as Record<string, unknown>
  if (root.error) {
    const error = root.error as Record<string, unknown>
    throw new Error(typeof error.message === 'string' ? error.message : 'Provider returned an error')
  }
  const choices = root.choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return
  const choice = choices[0] as Record<string, unknown>
  if (typeof choice.finish_reason === 'string') accumulator.finishReason = choice.finish_reason
  const delta =
    choice.delta && typeof choice.delta === 'object'
      ? (choice.delta as Record<string, unknown>)
      : undefined
  const message =
    choice.message && typeof choice.message === 'object'
      ? (choice.message as Record<string, unknown>)
      : undefined
  const text = extractText(delta?.content ?? message?.content)
  if (text) {
    accumulator.content += text
    onText(text)
  }
  const toolCalls = delta?.tool_calls ?? message?.tool_calls
  if (!Array.isArray(toolCalls)) return
  toolCalls.forEach((raw, fallbackIndex) => {
    if (!raw || typeof raw !== 'object') return
    const call = raw as Record<string, unknown>
    const index = typeof call.index === 'number' ? call.index : fallbackIndex
    const current = accumulator.tools.get(index) ?? {
      id: '',
      name: '',
      argumentsText: ''
    }
    if (typeof call.id === 'string') current.id += call.id
    const fn =
      call.function && typeof call.function === 'object'
        ? (call.function as Record<string, unknown>)
        : undefined
    if (typeof fn?.name === 'string') current.name += fn.name
    if (typeof fn?.arguments === 'string') current.argumentsText += fn.arguments
    accumulator.tools.set(index, current)
  })
}

export async function streamCompletion(input: StreamCompletionInput): Promise<CompletionRoundResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  }
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`

  const response = await fetch(chatEndpoint(input.provider.baseUrl), {
    method: 'POST',
    headers,
    redirect: 'error',
    signal: input.signal,
    body: JSON.stringify({
      model: input.provider.model,
      messages: input.messages,
      stream: true,
      ...(input.tools?.length
        ? {
            tools: input.tools,
            tool_choice: 'auto'
          }
        : {})
    })
  })

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 4_000)
    throw new Error(`${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`)
  }

  const accumulator: {
    content: string
    finishReason?: string
    tools: Map<number, ToolCallAccumulator>
  } = {
    content: '',
    tools: new Map()
  }
  const contentType = response.headers.get('content-type') ?? ''

  if (!response.body || contentType.includes('application/json')) {
    ingestChunk(await response.json(), accumulator, input.onText)
  } else {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let complete = false
    while (!complete) {
      const chunk = await reader.read()
      complete = chunk.done
      buffer += decoder.decode(chunk.value, { stream: !complete })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
        if (data === '[DONE]') {
          complete = true
          break
        }
        try {
          ingestChunk(JSON.parse(data), accumulator, input.onText)
        } catch (error) {
          if (error instanceof SyntaxError) continue
          throw error
        }
      }
    }
  }

  return {
    content: accumulator.content,
    finishReason: accumulator.finishReason,
    toolCalls: [...accumulator.tools.values()]
      .filter((call) => call.name)
      .map((call, index) => ({
        id: call.id || `tool_call_${index}`,
        name: call.name,
        argumentsText: call.argumentsText || '{}'
      }))
  }
}
