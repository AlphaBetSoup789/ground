import { z } from 'zod'
import type {
  AppSettings,
  McpServerProfile,
  ProviderProfile,
  Task
} from '../shared/types'
import {
  assertSafeCliEnvironmentVariableName,
  normalizeCliEnvironmentVariableNames
} from './cli-environment'

export interface PersistedStateData {
  version: 1
  providers: ProviderProfile[]
  mcpServers: McpServerProfile[]
  tasks: Task[]
  settings: AppSettings
}

const timestamp = z.string().min(1).max(100)
const archivedTimestamp = z.iso.datetime({ offset: true })
const identifier = z.string().min(1).max(200)
const portableJson = z.json()
const portableJsonObject = z.record(z.string(), portableJson)

const baseProvider = {
  id: identifier,
  name: z.string().min(1).max(80),
  model: z.string().max(200),
  createdAt: timestamp,
  updatedAt: timestamp
}

const modelProviderFields = {
  ...baseProvider,
  baseUrl: z.string().url().max(2_000),
  hasApiKey: z.boolean(),
  supportsTools: z.boolean(),
  contextWindowTokens: z.number().int().min(4_096).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(128).max(262_144).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional()
}

const cliProviderSchema = z
  .object({
    ...baseProvider,
    kind: z.literal('cli'),
    command: z.string().min(1).max(8_192),
    args: z.array(z.string().max(8_192)).max(64),
    promptMode: z.enum(['stdin', 'argument']),
    outputMode: z.enum(['plain', 'ndjson']),
    cliAdapter: z.enum(['generic', 'codex', 'claude', 'gemini']).optional(),
    environmentVariables: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .refine(
            (value) => {
              try {
                assertSafeCliEnvironmentVariableName(value)
                return true
              } catch {
                return false
              }
            },
            { message: 'Unsafe CLI environment variable name' }
          )
      )
      .max(32)
      .superRefine((value, context) => {
        try {
          normalizeCliEnvironmentVariableNames(value)
        } catch (error) {
          context.addIssue({
            code: 'custom',
            message:
              error instanceof Error
                ? error.message
                : 'Invalid CLI environment variables'
          })
        }
      })
      .optional(),
    environmentFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    trustConfirmed: z.boolean()
  })
  .superRefine((value, context) => {
    const hasVariables = Boolean(value.environmentVariables?.length)
    const hasFingerprint = value.environmentFingerprint !== undefined
    if (hasVariables !== hasFingerprint) {
      context.addIssue({
        code: 'custom',
        message:
          'CLI environment variables and fingerprint must be saved together',
        path: hasVariables
          ? ['environmentFingerprint']
          : ['environmentVariables']
      })
    }
  })

const providerSchema = z.discriminatedUnion('kind', [
  z.object({ ...modelProviderFields, kind: z.literal('openai') }),
  z.object({ ...modelProviderFields, kind: z.literal('anthropic') }),
  z.object({ ...modelProviderFields, kind: z.literal('google') }),
  z.object({ ...modelProviderFields, kind: z.literal('openai-compatible') }),
  cliProviderSchema
])

const mcpFingerprintSchema = z
  .record(z.string().min(1).max(200), z.string().regex(/^[a-f0-9]{64}$/u))
  .refine((value) => Object.keys(value).length <= 1_000, {
    message: 'Too many trusted MCP tool definitions'
  })

const baseMcpServer = {
  id: identifier,
  name: z.string().min(1).max(128),
  namespace: z.string().min(1).max(128),
  enabled: z.boolean(),
  trustedFingerprints: mcpFingerprintSchema,
  createdAt: timestamp,
  updatedAt: timestamp
}

const mcpServerSchema = z.discriminatedUnion('transport', [
  z.object({
    ...baseMcpServer,
    transport: z.literal('streamable-http'),
    url: z.string().url().max(2_000)
  }),
  z.object({
    ...baseMcpServer,
    transport: z.literal('stdio'),
    command: z.string().min(1).max(8_192),
    args: z.array(z.string().max(32_768)).max(128)
  })
])

const providerAttributionSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(80),
  kind: z.enum(['openai', 'anthropic', 'google', 'openai-compatible', 'cli']),
  model: z.string().max(200)
})

const messageItemSchema = z.object({
  id: identifier,
  kind: z.literal('message'),
  runId: identifier.optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(2_000_000),
  createdAt: timestamp,
  historyOnly: z.boolean().optional(),
  provider: providerAttributionSchema.optional()
})

const activityItemSchema = z.object({
  id: identifier,
  kind: z.literal('activity'),
  runId: identifier,
  activityType: z.enum([
    'status',
    'tool',
    'command',
    'approval',
    'error',
    'diagnostic'
  ]),
  title: z.string().max(500),
  detail: z.string().max(100_000).optional(),
  status: z.enum(['pending', 'running', 'success', 'error', 'denied']),
  createdAt: timestamp,
  approvalId: identifier.optional(),
  toolName: z.string().max(200).optional(),
  input: portableJsonObject.optional(),
  result: z.string().max(100_000).optional(),
  durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
  historyOnly: z.boolean().optional(),
  callId: identifier.optional(),
  provider: providerAttributionSchema.optional()
})

const providerStateSchema = z.object({
  adapterId: z.string().min(1).max(200),
  schemaVersion: z.literal(1),
  data: portableJson
})

const storedPartSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string().max(2_000_000),
    providerState: providerStateSchema.optional()
  }),
  z.object({
    kind: z.literal('reasoning-summary'),
    text: z.string().max(2_000_000),
    providerState: providerStateSchema.optional()
  }),
  z.object({
    kind: z.literal('tool-call'),
    callId: identifier,
    name: z.string().min(1).max(200),
    rawArguments: z.string().max(2_000_000),
    arguments: portableJsonObject.optional(),
    parseError: z.string().max(10_000).optional(),
    providerState: providerStateSchema.optional()
  })
])

const storedConversationItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: identifier,
    role: z.enum(['user', 'assistant']),
    parts: z.array(storedPartSchema).max(1_000),
    providerState: providerStateSchema.optional()
  }),
  z.object({
    kind: z.literal('tool-result'),
    id: identifier,
    callId: identifier,
    name: z.string().max(200).optional(),
    content: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('text'), text: z.string().max(2_000_000) }),
          z.object({ kind: z.literal('json'), value: portableJson })
        ])
      )
      .max(1_000),
    isError: z.boolean().optional(),
    providerState: providerStateSchema.optional()
  })
])

const runtimeSessionSchema = z.object({
  adapter: z.enum(['codex', 'claude', 'gemini']),
  sessionId: z.string().min(1).max(10_000),
  providerRevision: timestamp,
  workspacePath: z.string().min(1).max(8_192),
  mode: z.enum(['ask', 'agent']),
  updatedAt: timestamp
})

const modelRuntimeSessionSchema = z.object({
  adapterId: z.string().min(1).max(200),
  providerRevision: timestamp,
  model: z.string().max(200),
  workspacePath: z.string().min(1).max(8_192).optional(),
  mode: z.enum(['ask', 'agent']),
  includesImportedHistory: z.boolean().optional(),
  origin: z.enum(['ground', 'imported']).optional(),
  conversation: z.array(storedConversationItemSchema).max(10_000),
  checkpoint: portableJson.optional(),
  updatedAt: timestamp
})

const taskSchema = z
  .object({
    id: identifier,
    title: z.string().min(1).max(120),
    workspacePath: z.string().min(1).max(8_192).optional(),
    providerId: identifier,
    mode: z.enum(['ask', 'agent']),
    includeImportedHistory: z.boolean().optional(),
    runStatus: z.enum(['idle', 'running', 'awaiting-approval', 'failed']),
    archivedAt: archivedTimestamp.optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
    runtimeSessions: z.record(identifier, runtimeSessionSchema).optional(),
    modelSessions: z.record(identifier, modelRuntimeSessionSchema).optional(),
    items: z
      .array(z.discriminatedUnion('kind', [messageItemSchema, activityItemSchema]))
      .max(100_000)
  })
  .refine(
    (task) =>
      !task.archivedAt ||
      (task.runStatus !== 'running' && task.runStatus !== 'awaiting-approval'),
    {
      message: 'Archived tasks cannot contain an active run',
      path: ['archivedAt']
    }
  )

const persistedStateSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerSchema).min(1).max(1_000),
  mcpServers: z.array(mcpServerSchema).max(100).default([]),
  tasks: z.array(taskSchema).max(10_000),
  settings: z.object({
    selectedTaskId: identifier.optional(),
    defaultProviderId: identifier.optional(),
    sidebarCollapsed: z.boolean()
  })
})

export function parsePersistedState(value: unknown): PersistedStateData {
  const state = persistedStateSchema.parse(value)
  const selectedTask = state.tasks.find(
    (task) => task.id === state.settings.selectedTaskId
  )
  const defaultProvider =
    state.providers.find(
      (provider) => provider.id === state.settings.defaultProviderId
    ) ??
    state.providers.find(
      (provider) => provider.id === selectedTask?.providerId
    ) ??
    state.providers[0]
  if (!defaultProvider) {
    throw new Error('Persisted state must contain at least one provider')
  }
  return {
    ...state,
    settings: {
      ...state.settings,
      defaultProviderId: defaultProvider.id
    }
  } as PersistedStateData
}
