import type { JsonObject, JsonValue } from './json'

export interface ProviderState {
  adapterId: string
  schemaVersion: 1
  data: JsonValue
}

export interface TextPart {
  kind: 'text'
  text: string
  providerState?: ProviderState
}

export interface ReasoningSummaryPart {
  kind: 'reasoning-summary'
  text: string
  providerState?: ProviderState
}

export interface ToolCallPart {
  kind: 'tool-call'
  callId: string
  name: string
  rawArguments: string
  arguments?: JsonObject
  parseError?: string
  providerState?: ProviderState
}

export interface ImagePart {
  kind: 'image'
  mimeType: string
  source:
    | { kind: 'url'; url: string }
    | { kind: 'base64'; data: string }
    | { kind: 'file'; path: string }
  providerState?: ProviderState
}

export interface FilePart {
  kind: 'file'
  mimeType: string
  name?: string
  source:
    | { kind: 'url'; url: string }
    | { kind: 'base64'; data: string }
    | { kind: 'file'; path: string }
  providerState?: ProviderState
}

export type MessagePart =
  | TextPart
  | ReasoningSummaryPart
  | ToolCallPart
  | ImagePart
  | FilePart

export type OutputMessagePart = TextPart | ReasoningSummaryPart | ToolCallPart

export interface ConversationMessage {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  providerState?: ProviderState
}

export interface ToolResultItem {
  kind: 'tool-result'
  id: string
  callId: string
  name?: string
  content: Array<
    | { kind: 'text'; text: string }
    | { kind: 'json'; value: JsonValue }
  >
  isError?: boolean
  providerState?: ProviderState
}

export type ConversationItem = ConversationMessage | ToolResultItem

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonObject
  strict?: boolean
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string }

export interface ModelRequest {
  requestId: string
  model: string
  instructions?: string
  conversation: ConversationItem[]
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  parallelToolCalls?: boolean
  generation?: {
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
    reasoning?: {
      effort?: 'minimal' | 'low' | 'medium' | 'high'
      summary?: 'none' | 'auto' | 'concise' | 'detailed'
    }
  }
  continuation?: {
    adapterId: string
    checkpoint: JsonValue
  }
}

export type ModelStopReason =
  | 'complete'
  | 'tool-calls'
  | 'max-output-tokens'
  | 'context-limit'
  | 'stop-sequence'
  | 'safety'
  | 'refusal'
  | 'malformed-tool-call'
  | 'paused'
  | 'unknown'

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningTokens?: number
  costUsd?: number
}

export interface ProviderNotice {
  level: 'debug' | 'info' | 'warning'
  code: string
  message: string
  retry?: {
    attempt: number
    delayMs: number
  }
}

export type OutputPartHeader =
  | {
      kind: 'text'
      partId: string
    }
  | {
      kind: 'reasoning-summary'
      partId: string
    }
  | {
      kind: 'tool-call'
      partId: string
      callId?: string
      name?: string
    }

export type ModelEvent =
  | {
      type: 'response.started'
      responseId?: string
      servingModel?: string
    }
  | {
      type: 'part.started'
      part: OutputPartHeader
    }
  | {
      type: 'part.delta'
      partId: string
      delta:
        | { kind: 'text'; text: string }
        | { kind: 'reasoning-summary'; text: string }
        | { kind: 'tool-arguments'; text: string }
    }
  | {
      type: 'part.completed'
      partId: string
      part: OutputMessagePart
    }
  | ({
      type: 'provider.notice'
    } & ProviderNotice)
  | {
      type: 'usage.updated'
      usage: TokenUsage
      semantics: 'cumulative' | 'delta'
    }
  | {
      type: 'response.completed'
      messageId: string
      stopReason: ModelStopReason
      providerStopReason?: string
      usage?: TokenUsage
      providerState?: ProviderState
      checkpoint?: JsonValue
    }

export interface ReducedModelResponse {
  responseId?: string
  servingModel?: string
  output: ConversationMessage & { role: 'assistant' }
  stopReason: ModelStopReason
  providerStopReason?: string
  usage?: TokenUsage
  notices: ProviderNotice[]
  checkpoint?: JsonValue
}

export interface ModelDescriptor {
  id: string
  name?: string
  contextWindowTokens?: number
  maxOutputTokens?: number
}

export interface AgentRunRequest {
  requestId: string
  prompt: string
  workspacePath: string
  model?: string
  mode: 'ask' | 'agent'
  resume?: {
    sessionId: string
  }
}

export type AgentActivityKind =
  | 'command'
  | 'file-change'
  | 'tool'
  | 'plan'
  | 'reasoning'
  | 'diagnostic'

export type AgentRuntimeEvent =
  | {
      type: 'runtime.started'
      sessionId?: string
      servingModel?: string
    }
  | {
      type: 'assistant.delta'
      delta: string
    }
  | {
      type: 'activity.started'
      activityId: string
      kind: AgentActivityKind
      title: string
      detail?: string
    }
  | {
      type: 'activity.updated'
      activityId: string
      detail?: string
    }
  | {
      type: 'activity.completed'
      activityId: string
      status: 'success' | 'error' | 'denied'
      detail?: string
    }
  | ({
      type: 'provider.notice'
    } & ProviderNotice)
  | {
      type: 'usage.updated'
      usage: TokenUsage
      semantics: 'cumulative' | 'delta'
    }
  | {
      type: 'runtime.completed'
      sessionId?: string
      stopReason: 'complete' | 'max-steps' | 'unknown'
      usage?: TokenUsage
    }
