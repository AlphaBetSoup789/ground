import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet
} from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import { mergeModelCapabilities } from './capabilities'
import type { AdapterContext, ModelAdapter, ModelAdapterInspection } from './contracts'
import { isJsonObject, type JsonObject, type JsonValue } from './json'
import type {
  ConversationItem,
  MessagePart,
  ModelEvent,
  ModelRequest,
  ModelStopReason,
  ProviderState,
  TokenUsage,
  ToolDefinition
} from './types'

export type AiSdkProtocol =
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'openai-compatible'

export interface AiSdkAdapterConfig {
  protocol: AiSdkProtocol
  baseUrl?: string
  apiKeyRef?: string
  providerName?: string
}

type ModelFactory = (input: {
  protocol: AiSdkProtocol
  config: AiSdkAdapterConfig
  modelId: string
  apiKey?: string
}) => LanguageModel

const CONFIG_SCHEMA = z
  .object({
    protocol: z.enum([
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai',
      'openai-compatible'
    ]),
    baseUrl: z.url().optional(),
    apiKeyRef: z.string().min(1).max(500).optional(),
    providerName: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/u)
      .max(80)
      .optional()
  })
  .strict()
  .superRefine((config, context) => {
    if (config.protocol === 'openai-compatible' && !config.baseUrl) {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'OpenAI-compatible adapters require a base URL'
      })
    }
    if (config.protocol !== 'openai-compatible' && !config.apiKeyRef) {
      context.addIssue({
        code: 'custom',
        path: ['apiKeyRef'],
        message: 'Hosted providers require a secret reference'
      })
    }
  })

const ADAPTER_IDS: Record<AiSdkProtocol, string> = {
  'openai-responses': 'openai.responses',
  'anthropic-messages': 'anthropic.messages',
  'google-generative-ai': 'google.generative-ai',
  'openai-compatible': 'openai.compatible'
}

const DEFAULT_BASE_URLS: Record<Exclude<AiSdkProtocol, 'openai-compatible'>, string> = {
  'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com/v1',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta'
}
const MAX_PROVIDER_RESPONSE_BYTES = 32_000_000
const MAX_PROVIDER_STREAM_CHUNKS = 50_000
const MAX_PROVIDER_METADATA_BYTES = 1_000_000

interface OutputAccumulator {
  id: string
  kind: 'text' | 'reasoning-summary' | 'tool-call'
  text: string
  rawArguments: string
  toolName?: string
  input?: unknown
  providerMetadata?: JsonObject
}

export async function limitProviderResponse(
  response: Response,
  maximumBytes = MAX_PROVIDER_RESPONSE_BYTES
): Promise<Response> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Provider response exceeded Ground’s 32 MB safety limit')
  }
  if (!response.body) return response

  const reader = response.body.getReader()
  let receivedBytes = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        receivedBytes += value.byteLength
        if (receivedBytes > maximumBytes) {
          await reader.cancel().catch(() => undefined)
          controller.error(
            new Error('Provider response exceeded Ground’s 32 MB safety limit')
          )
          return
        }
        controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

export const providerFetch: typeof fetch = async (input, init) =>
  limitProviderResponse(await fetch(input, {
    ...init,
    redirect: 'error'
  }))

function defaultModelFactory(input: {
  protocol: AiSdkProtocol
  config: AiSdkAdapterConfig
  modelId: string
  apiKey?: string
}): LanguageModel {
  const { protocol, config, modelId, apiKey } = input
  if (protocol === 'openai-responses') {
    return createOpenAI({
      apiKey,
      baseURL: config.baseUrl ?? DEFAULT_BASE_URLS[protocol],
      fetch: providerFetch
    }).responses(modelId)
  }
  if (protocol === 'anthropic-messages') {
    return createAnthropic({
      apiKey,
      baseURL: config.baseUrl ?? DEFAULT_BASE_URLS[protocol],
      fetch: providerFetch
    }).messages(modelId)
  }
  if (protocol === 'google-generative-ai') {
    return createGoogle({
      apiKey,
      baseURL: config.baseUrl ?? DEFAULT_BASE_URLS[protocol],
      fetch: providerFetch
    }).generativeAI(modelId)
  }
  return createOpenAICompatible({
    name: config.providerName ?? 'ground-compatible',
    baseURL: config.baseUrl as string,
    apiKey,
    includeUsage: false,
    fetch: providerFetch
  }).chatModel(modelId)
}

export class AiSdkModelAdapter implements ModelAdapter<AiSdkAdapterConfig> {
  readonly id: string

  constructor(
    readonly protocol: AiSdkProtocol,
    private readonly modelFactory: ModelFactory = defaultModelFactory
  ) {
    this.id = ADAPTER_IDS[protocol]
  }

  validateConfig(value: unknown): AiSdkAdapterConfig {
    const config = CONFIG_SCHEMA.parse(value)
    if (config.protocol !== this.protocol) {
      throw new Error(`Adapter ${this.id} cannot load ${config.protocol} configuration`)
    }
    return config
  }

  async inspect(): Promise<ModelAdapterInspection> {
    return {
      capabilities: mergeModelCapabilities({
        streaming: 'native',
        systemInstructions: 'native',
        customTools: 'native',
        parallelToolCalls: this.protocol === 'openai-compatible' ? 'unknown' : 'native',
        toolArgumentStreaming: 'native',
        strictToolSchemas: this.protocol === 'openai-compatible' ? 'unknown' : 'native',
        structuredOutput: this.protocol === 'openai-compatible' ? 'unknown' : 'native',
        reasoningSummaries: this.protocol === 'openai-compatible' ? 'unknown' : 'native',
        opaqueStateReplay: 'native',
        imageInput: this.protocol === 'openai-compatible' ? 'unknown' : 'native',
        fileInput:
          this.protocol === 'anthropic-messages' || this.protocol === 'google-generative-ai'
            ? 'native'
            : 'unknown',
        usageReporting: this.protocol === 'openai-compatible' ? 'unknown' : 'native',
        modelDiscovery: 'unsupported',
        statefulContinuation: 'unsupported',
        cancellation: 'abort-signal'
      })
    }
  }

  async *stream(
    request: ModelRequest,
    context: AdapterContext<AiSdkAdapterConfig>
  ): AsyncIterable<ModelEvent> {
    const config = this.validateConfig(context.config)
    const apiKey = config.apiKeyRef
      ? await context.secrets.resolve(config.apiKeyRef)
      : undefined
    const model = this.modelFactory({
      protocol: this.protocol,
      config,
      modelId: request.model,
      apiKey
    })
    const tools = createToolSet(request.tools)
    const result = streamText({
      model,
      instructions: request.instructions,
      messages: toAiSdkMessages(request.conversation, this.id),
      tools,
      toolChoice: toAiSdkToolChoice(request.toolChoice),
      maxOutputTokens: request.generation?.maxOutputTokens,
      temperature: request.generation?.temperature,
      topP: request.generation?.topP,
      stopSequences: request.generation?.stopSequences,
      abortSignal: context.signal,
      maxRetries: 2,
      timeout: {
        totalMs: 10 * 60_000,
        stepMs: 5 * 60_000,
        firstChunkMs: 60_000,
        chunkMs: 60_000
      },
      providerOptions: providerOptionsForRequest(this.protocol, request)
    })

    const outputOrder: string[] = []
    const output = new Map<string, OutputAccumulator>()
    let responseId: string | undefined
    let servingModel = request.model
    let finishReason: ModelStopReason = 'unknown'
    let providerFinishReason: string | undefined
    let usage: TokenUsage | undefined
    let terminalProviderMetadata: JsonObject | undefined

    yield {
      type: 'response.started',
      servingModel
    }

    let streamChunks = 0
    for await (const chunk of result.stream) {
      streamChunks += 1
      if (streamChunks > MAX_PROVIDER_STREAM_CHUNKS) {
        throw new Error('Provider emitted too many streaming events')
      }
      switch (chunk.type) {
        case 'start-step':
          for (const warning of chunk.warnings) {
            yield {
              type: 'provider.notice',
              level: 'warning',
              code: 'ai-sdk.warning',
              message: formatAiSdkWarning(warning)
            }
          }
          break
        case 'text-start':
          startOutputPart(output, outputOrder, {
            id: chunk.id,
            kind: 'text',
            text: '',
            rawArguments: '',
            providerMetadata: toJsonObject(chunk.providerMetadata)
          })
          yield {
            type: 'part.started',
            part: { kind: 'text', partId: chunk.id }
          }
          break
        case 'text-delta': {
          const part = requireOutputPart(output, chunk.id, 'text')
          part.text += chunk.text
          part.providerMetadata = toJsonObject(chunk.providerMetadata) ?? part.providerMetadata
          yield {
            type: 'part.delta',
            partId: chunk.id,
            delta: { kind: 'text', text: chunk.text }
          }
          break
        }
        case 'text-end':
          requireOutputPart(output, chunk.id, 'text').providerMetadata =
            toJsonObject(chunk.providerMetadata) ??
            requireOutputPart(output, chunk.id, 'text').providerMetadata
          break
        case 'reasoning-start':
          startOutputPart(output, outputOrder, {
            id: chunk.id,
            kind: 'reasoning-summary',
            text: '',
            rawArguments: '',
            providerMetadata: toJsonObject(chunk.providerMetadata)
          })
          yield {
            type: 'part.started',
            part: { kind: 'reasoning-summary', partId: chunk.id }
          }
          break
        case 'reasoning-delta': {
          const part = requireOutputPart(output, chunk.id, 'reasoning-summary')
          part.text += chunk.text
          part.providerMetadata = toJsonObject(chunk.providerMetadata) ?? part.providerMetadata
          yield {
            type: 'part.delta',
            partId: chunk.id,
            delta: { kind: 'reasoning-summary', text: chunk.text }
          }
          break
        }
        case 'reasoning-end':
          requireOutputPart(output, chunk.id, 'reasoning-summary').providerMetadata =
            toJsonObject(chunk.providerMetadata) ??
            requireOutputPart(output, chunk.id, 'reasoning-summary').providerMetadata
          break
        case 'tool-input-start':
          startOutputPart(output, outputOrder, {
            id: chunk.id,
            kind: 'tool-call',
            text: '',
            rawArguments: '',
            toolName: chunk.toolName,
            providerMetadata: toJsonObject(chunk.providerMetadata)
          })
          yield {
            type: 'part.started',
            part: {
              kind: 'tool-call',
              partId: chunk.id,
              callId: chunk.id,
              name: chunk.toolName
            }
          }
          break
        case 'tool-input-delta': {
          const part = requireOutputPart(output, chunk.id, 'tool-call')
          part.rawArguments += chunk.delta
          part.providerMetadata = toJsonObject(chunk.providerMetadata) ?? part.providerMetadata
          yield {
            type: 'part.delta',
            partId: chunk.id,
            delta: { kind: 'tool-arguments', text: chunk.delta }
          }
          break
        }
        case 'tool-input-end':
          requireOutputPart(output, chunk.id, 'tool-call').providerMetadata =
            toJsonObject(chunk.providerMetadata) ??
            requireOutputPart(output, chunk.id, 'tool-call').providerMetadata
          break
        case 'tool-call': {
          let part = output.get(chunk.toolCallId)
          if (!part) {
            part = {
              id: chunk.toolCallId,
              kind: 'tool-call',
              text: '',
              rawArguments: '',
              toolName: chunk.toolName
            }
            startOutputPart(output, outputOrder, part)
            yield {
              type: 'part.started',
              part: {
                kind: 'tool-call',
                partId: chunk.toolCallId,
                callId: chunk.toolCallId,
                name: chunk.toolName
              }
            }
          }
          part.toolName = chunk.toolName
          part.input = chunk.input
          part.providerMetadata = toJsonObject(chunk.providerMetadata) ?? part.providerMetadata
          if (!part.rawArguments) part.rawArguments = JSON.stringify(chunk.input)
          break
        }
        case 'finish-step':
          responseId = chunk.response.id
          servingModel = chunk.response.modelId ?? servingModel
          finishReason = normalizeFinishReason(chunk.finishReason)
          providerFinishReason = chunk.rawFinishReason
          usage = normalizeUsage(chunk.usage)
          terminalProviderMetadata = toJsonObject(chunk.providerMetadata)
          break
        case 'finish':
          finishReason = normalizeFinishReason(chunk.finishReason)
          providerFinishReason = chunk.rawFinishReason
          usage = normalizeUsage(chunk.totalUsage)
          break
        case 'error':
          throw chunk.error
        case 'abort':
          throw new DOMException(chunk.reason ?? 'Model request aborted', 'AbortError')
        case 'tool-error':
          throw chunk.error
        case 'custom':
        case 'file':
        case 'reasoning-file':
        case 'source':
        case 'start':
        case 'tool-approval-request':
        case 'tool-approval-response':
        case 'tool-output-denied':
        case 'tool-result':
          break
      }
    }

    const responseMessages = await result.responseMessages
    const responseParts = collectAssistantResponseParts(responseMessages)
    const claimedResponseParts = new Set<number>()
    for (const partId of outputOrder) {
      const part = output.get(partId) as OutputAccumulator
      const responsePart = findResponsePart(responseParts, claimedResponseParts, part)
      const providerState =
        providerStateFromOptions(this.id, responsePart?.providerOptions) ??
        providerStateFromMetadata(this.id, part.providerMetadata)
      if (part.kind === 'text') {
        yield {
          type: 'part.completed',
          partId,
          part: {
            kind: 'text',
            text: part.text,
            providerState
          }
        }
      } else if (part.kind === 'reasoning-summary') {
        yield {
          type: 'part.completed',
          partId,
          part: {
            kind: 'reasoning-summary',
            text: part.text,
            providerState
          }
        }
      } else {
        const rawArguments = part.rawArguments || JSON.stringify(part.input ?? {})
        yield {
          type: 'part.completed',
          partId,
          part: {
            kind: 'tool-call',
            callId: part.id,
            name: part.toolName ?? 'unknown_tool',
            rawArguments,
            arguments: isJsonObject(part.input) ? part.input : undefined,
            providerState
          }
        }
      }
    }

    if (usage) {
      yield {
        type: 'usage.updated',
        usage,
        semantics: 'cumulative'
      }
    }
    yield {
      type: 'response.completed',
      messageId: `${request.requestId}:assistant`,
      stopReason: finishReason,
      providerStopReason: providerFinishReason,
      providerState: providerStateFromMetadata(this.id, terminalProviderMetadata),
      checkpoint: undefined
    }
  }
}

export function createAiSdkModelAdapters(): AiSdkModelAdapter[] {
  return [
    new AiSdkModelAdapter('openai-responses'),
    new AiSdkModelAdapter('anthropic-messages'),
    new AiSdkModelAdapter('google-generative-ai'),
    new AiSdkModelAdapter('openai-compatible')
  ]
}

function createToolSet(definitions: ToolDefinition[] | undefined): ToolSet | undefined {
  if (!definitions?.length) return undefined
  const tools: ToolSet = Object.create(null) as ToolSet
  for (const definition of definitions) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/u.test(definition.name)) {
      throw new Error(`Invalid tool name: ${definition.name}`)
    }
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(
        definition.inputSchema as Parameters<typeof jsonSchema>[0]
      ),
      strict: definition.strict
    })
  }
  return tools
}

function toAiSdkToolChoice(
  choice: ModelRequest['toolChoice']
): 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string } | undefined {
  if (choice === undefined || typeof choice === 'string') return choice
  return { type: 'tool', toolName: choice.name }
}

export function toAiSdkMessages(
  conversation: ConversationItem[],
  adapterId: string
): ModelMessage[] {
  return conversation.map((item): ModelMessage => {
    if (item.kind === 'tool-result') {
      const first = item.content[0]
      const providerOptions = providerOptionsFromState(item.providerState, adapterId)
      const output =
        item.content.length === 1 && first?.kind === 'json'
          ? {
              type: item.isError ? ('error-json' as const) : ('json' as const),
              value: first.value,
              providerOptions
            }
          : {
              type: item.isError ? ('error-text' as const) : ('text' as const),
              value: item.content
                .map((part) =>
                  part.kind === 'text' ? part.text : JSON.stringify(part.value)
                )
                .join('\n'),
              providerOptions
            }
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: item.callId,
            toolName: item.name ?? 'unknown_tool',
            output,
            providerOptions
          }
        ]
      }
    }
    if (item.role === 'user') {
      const content = item.parts.map((part) => toUserPart(part, adapterId))
      return {
        role: 'user',
        content
      }
    }
    return {
      role: 'assistant',
      content: item.parts
        .filter(
          (part): part is Extract<MessagePart, { kind: 'text' | 'reasoning-summary' | 'tool-call' }> =>
            part.kind === 'text' ||
            part.kind === 'reasoning-summary' ||
            part.kind === 'tool-call'
        )
        .map((part) => {
          const providerOptions = providerOptionsFromState(part.providerState, adapterId)
          if (part.kind === 'text') {
            return { type: 'text' as const, text: part.text, providerOptions }
          }
          if (part.kind === 'reasoning-summary') {
            return { type: 'reasoning' as const, text: part.text, providerOptions }
          }
          return {
            type: 'tool-call' as const,
            toolCallId: part.callId,
            toolName: part.name,
            input: part.arguments ?? safeParseObject(part.rawArguments),
            providerOptions
          }
        })
    }
  })
}

function toUserPart(part: MessagePart, adapterId: string) {
  const providerOptions = providerOptionsFromState(part.providerState, adapterId)
  if (part.kind === 'text' || part.kind === 'reasoning-summary') {
    return { type: 'text' as const, text: part.text, providerOptions }
  }
  if (part.kind === 'tool-call') {
    return {
      type: 'text' as const,
      text: `[Previous tool request ${part.name}: ${part.rawArguments}]`,
      providerOptions
    }
  }
  if (part.source.kind === 'file') {
    throw new Error('File-path message parts must be resolved before reaching a model adapter')
  }
  const data = part.source.kind === 'url' ? new URL(part.source.url) : part.source.data
  if (part.kind === 'image') {
    return { type: 'image' as const, image: data, mediaType: part.mimeType, providerOptions }
  }
  return {
    type: 'file' as const,
    data,
    mediaType: part.mimeType,
    filename: part.name,
    providerOptions
  }
}

function providerOptionsFromState(
  state: ProviderState | undefined,
  adapterId: string
): ProviderOptions | undefined {
  if (!state || state.adapterId !== adapterId || !isJsonObject(state.data)) return undefined
  const options = state.data.providerOptions
  return isJsonObject(options) ? (structuredClone(options) as ProviderOptions) : undefined
}

function providerStateFromOptions(
  adapterId: string,
  options: unknown
): ProviderState | undefined {
  const jsonOptions = toJsonObject(options)
  return jsonOptions
    ? {
        adapterId,
        schemaVersion: 1,
        data: { providerOptions: jsonOptions }
      }
    : undefined
}

function providerStateFromMetadata(
  adapterId: string,
  metadata: JsonObject | undefined
): ProviderState | undefined {
  return metadata
    ? {
        adapterId,
        schemaVersion: 1,
        data: { providerMetadata: metadata }
      }
    : undefined
}

function providerOptionsForRequest(
  protocol: AiSdkProtocol,
  request: ModelRequest
): ProviderOptions | undefined {
  const reasoning = request.generation?.reasoning
  if (protocol === 'openai-responses') {
    return {
      openai: {
        store: false,
        parallelToolCalls: request.parallelToolCalls,
        reasoningEffort: reasoning?.effort,
        reasoningSummary:
          reasoning?.summary === 'none' || reasoning?.summary === 'concise'
            ? undefined
            : reasoning?.summary
      }
    }
  }
  if (protocol === 'anthropic-messages') {
    return {
      anthropic: {
        disableParallelToolUse:
          request.parallelToolCalls === undefined ? undefined : !request.parallelToolCalls,
        effort: reasoning?.effort === 'minimal' ? 'low' : reasoning?.effort
      }
    }
  }
  if (protocol === 'google-generative-ai') {
    return {
      google: {
        thinkingConfig: reasoning
          ? {
              thinkingLevel: reasoning.effort,
              includeThoughts:
                reasoning.summary !== undefined && reasoning.summary !== 'none'
            }
          : undefined
      }
    }
  }
  if (protocol === 'openai-compatible') {
    return {
      groundCompatible: {
        reasoningEffort: reasoning?.effort
      }
    }
  }
  return undefined
}

function startOutputPart(
  output: Map<string, OutputAccumulator>,
  order: string[],
  part: OutputAccumulator
): void {
  if (output.has(part.id)) throw new Error(`AI SDK output part ${part.id} started twice`)
  output.set(part.id, part)
  order.push(part.id)
}

function requireOutputPart(
  output: Map<string, OutputAccumulator>,
  id: string,
  kind: OutputAccumulator['kind']
): OutputAccumulator {
  const part = output.get(id)
  if (!part) throw new Error(`AI SDK emitted a delta for unknown part ${id}`)
  if (part.kind !== kind) throw new Error(`AI SDK changed output part ${id} from ${part.kind} to ${kind}`)
  return part
}

function collectAssistantResponseParts(
  messages: Awaited<
    ReturnType<typeof streamText>['responseMessages']
  >
): Array<Record<string, unknown>> {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!assistant) return []
  if (typeof assistant.content === 'string') {
    return [{ type: 'text', text: assistant.content }]
  }
  return assistant.content.map(
    (part) => part as unknown as Record<string, unknown>
  )
}

function findResponsePart(
  responseParts: Array<Record<string, unknown>>,
  claimed: Set<number>,
  part: OutputAccumulator
): Record<string, unknown> | undefined {
  const expectedType =
    part.kind === 'reasoning-summary'
      ? 'reasoning'
      : part.kind === 'tool-call'
        ? 'tool-call'
        : 'text'
  const index = responseParts.findIndex((candidate, candidateIndex) => {
    if (claimed.has(candidateIndex) || candidate.type !== expectedType) return false
    return (
      expectedType !== 'tool-call' ||
      candidate.toolCallId === undefined ||
      candidate.toolCallId === part.id
    )
  })
  if (index === -1) return undefined
  claimed.add(index)
  return responseParts[index]
}

function normalizeFinishReason(reason: string): ModelStopReason {
  switch (reason) {
    case 'stop':
      return 'complete'
    case 'tool-calls':
      return 'tool-calls'
    case 'length':
      return 'max-output-tokens'
    case 'content-filter':
      return 'safety'
    default:
      return 'unknown'
  }
}

function normalizeUsage(usage: LanguageModelUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
    cacheWriteInputTokens: usage.inputTokenDetails.cacheWriteTokens,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens
  }
}

function safeParseObject(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value)
    return isJsonObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    if (
      new TextEncoder().encode(serialized).byteLength >
      MAX_PROVIDER_METADATA_BYTES
    ) {
      throw new Error('Provider metadata exceeded Ground’s 1 MB safety limit')
    }
    const parsed: unknown = JSON.parse(serialized)
    return isJsonObject(parsed) && Object.keys(parsed).length ? parsed : undefined
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('safety limit')
    ) {
      throw error
    }
    return undefined
  }
}

function formatAiSdkWarning(warning: { type: string }): string {
  const record = warning as Record<string, unknown>
  const detail =
    typeof record.details === 'string'
      ? record.details
      : typeof record.message === 'string'
        ? record.message
        : typeof record.feature === 'string'
          ? record.feature
          : undefined
  return detail ? `${warning.type}: ${detail}` : warning.type
}
