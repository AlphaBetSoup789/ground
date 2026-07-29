export type CapabilitySupport = 'native' | 'emulated' | 'unsupported' | 'unknown'

export interface ModelCapabilities {
  streaming: CapabilitySupport
  systemInstructions: CapabilitySupport
  customTools: CapabilitySupport
  parallelToolCalls: CapabilitySupport
  toolArgumentStreaming: CapabilitySupport
  strictToolSchemas: CapabilitySupport
  structuredOutput: CapabilitySupport
  reasoningSummaries: CapabilitySupport
  opaqueStateReplay: CapabilitySupport
  imageInput: CapabilitySupport
  fileInput: CapabilitySupport
  usageReporting: CapabilitySupport
  modelDiscovery: CapabilitySupport
  statefulContinuation: CapabilitySupport
  cancellation: 'abort-signal' | 'process-signal' | 'none'
}

export interface AgentRuntimeCapabilities {
  structuredEvents: CapabilitySupport
  sessionResume: CapabilitySupport
  assistantStreaming: CapabilitySupport
  toolActivities: CapabilitySupport
  commandActivities: CapabilitySupport
  fileActivities: CapabilitySupport
  usageReporting: CapabilitySupport
  interactiveApprovals: CapabilitySupport
  cancellation: 'abort-signal' | 'process-signal' | 'none'
  permissionOwner: 'ground' | 'runtime' | 'none'
}

export const DEFAULT_MODEL_CAPABILITIES: Readonly<ModelCapabilities> = Object.freeze({
  streaming: 'unknown',
  systemInstructions: 'unknown',
  customTools: 'unknown',
  parallelToolCalls: 'unknown',
  toolArgumentStreaming: 'unknown',
  strictToolSchemas: 'unknown',
  structuredOutput: 'unknown',
  reasoningSummaries: 'unknown',
  opaqueStateReplay: 'unknown',
  imageInput: 'unknown',
  fileInput: 'unknown',
  usageReporting: 'unknown',
  modelDiscovery: 'unknown',
  statefulContinuation: 'unknown',
  cancellation: 'none'
})

export const DEFAULT_AGENT_RUNTIME_CAPABILITIES: Readonly<AgentRuntimeCapabilities> =
  Object.freeze({
    structuredEvents: 'unknown',
    sessionResume: 'unknown',
    assistantStreaming: 'unknown',
    toolActivities: 'unknown',
    commandActivities: 'unknown',
    fileActivities: 'unknown',
    usageReporting: 'unknown',
    interactiveApprovals: 'unknown',
    cancellation: 'none',
    permissionOwner: 'runtime'
  })

export function mergeModelCapabilities(
  overrides: Partial<ModelCapabilities>,
  base: Readonly<ModelCapabilities> = DEFAULT_MODEL_CAPABILITIES
): Readonly<ModelCapabilities> {
  return Object.freeze({ ...base, ...overrides })
}

export function mergeAgentRuntimeCapabilities(
  overrides: Partial<AgentRuntimeCapabilities>,
  base: Readonly<AgentRuntimeCapabilities> = DEFAULT_AGENT_RUNTIME_CAPABILITIES
): Readonly<AgentRuntimeCapabilities> {
  return Object.freeze({ ...base, ...overrides })
}
