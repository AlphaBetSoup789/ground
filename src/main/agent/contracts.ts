import type {
  AgentRuntimeCapabilities,
  ModelCapabilities
} from './capabilities'
import type { JsonValue } from './json'
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ModelDescriptor,
  ModelEvent,
  ModelRequest
} from './types'

export interface SecretResolver {
  resolve(ref: string): Promise<string>
}

export interface AdapterContext<C = unknown> {
  config: C
  signal: AbortSignal
  secrets: SecretResolver
  log?: (entry: {
    level: 'debug' | 'info' | 'warning'
    message: string
    detail?: JsonValue
  }) => void
}

export interface ModelAdapterInspection {
  models?: ModelDescriptor[]
  capabilities: Readonly<ModelCapabilities>
}

export interface AgentRuntimeInspection {
  version?: string
  models?: ModelDescriptor[]
  capabilities: Readonly<AgentRuntimeCapabilities>
}

export interface ModelAdapter<C = unknown> {
  readonly id: string
  validateConfig(value: unknown): C
  inspect(context: AdapterContext<C>): Promise<ModelAdapterInspection>
  stream(
    request: ModelRequest,
    context: AdapterContext<C>
  ): AsyncIterable<ModelEvent>
}

export interface AgentRuntimeAdapter<C = unknown> {
  readonly id: string
  validateConfig(value: unknown): C
  inspect(context: AdapterContext<C>): Promise<AgentRuntimeInspection>
  run(
    request: AgentRunRequest,
    context: AdapterContext<C>
  ): AsyncIterable<AgentRuntimeEvent>
}
