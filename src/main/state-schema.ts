import { z } from 'zod'
import { PROVIDER_FAILURE_KINDS } from '../shared/types'
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
import { BUILT_IN_CLI_RUNTIME_BINDINGS } from './cli-runtime-bindings'
import {
  migrateStateDocument,
  type StateMigration
} from './state-migrations'

export interface PersistedStateData {
  version: 2
  providers: ProviderProfile[]
  mcpServers: McpServerProfile[]
  tasks: Task[]
  settings: AppSettings
  /**
   * Main-only write-ahead cleanup intents for the separate encrypted vault.
   * These exact references are never projected to the renderer.
   */
  pendingSecretDeletes: string[]
}

export const MAX_PERSISTED_TASK_ITEMS = 100_000
export const CURRENT_PERSISTED_STATE_VERSION = 2

const STATE_MIGRATIONS = new Map<number, StateMigration>([
  [
    1,
    (document) => ({
      ...document,
      version: 2
    })
  ]
])

const timestamp = z.string().min(1).max(100)
const archivedTimestamp = z.iso.datetime({ offset: true })
const managedExecutionTimestamp = z.iso.datetime({ offset: true })
const identifier = z.string().min(1).max(200)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const portableJson = z.json()
const portableJsonObject = z.record(z.string(), portableJson)
const providerFailureKindSchema = z.enum(PROVIDER_FAILURE_KINDS)
const providerVerificationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unverified') }).strict(),
  z
    .object({
      status: z.literal('passed'),
      scope: z.enum(['connection', 'configuration']),
      checkedAt: z.iso.datetime({ offset: true })
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      scope: z.enum(['connection', 'configuration']),
      checkedAt: z.iso.datetime({ offset: true }),
      failureKind: providerFailureKindSchema.optional()
    })
    .strict()
])

const baseProvider = {
  id: identifier,
  name: z.string().min(1).max(80),
  model: z.string().max(200),
  verification: providerVerificationSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp
}

const modelProviderFields = {
  ...baseProvider,
  baseUrl: z.string().url().max(2_000),
  hasApiKey: z.boolean(),
  credentialRevision: identifier.optional(),
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
    cliAdapter: z
      .enum(['generic', 'codex', 'claude', 'gemini', 'antigravity'])
      .optional(),
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
    environmentRevision: z
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
    if (!hasVariables && value.environmentRevision !== undefined) {
      context.addIssue({
        code: 'custom',
        message:
          'CLI environment revision requires environment variables',
        path: ['environmentRevision']
      })
    }
  })

export const providerSchema = z.discriminatedUnion('kind', [
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

export const mcpServerSchema = z.discriminatedUnion('transport', [
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

const managedExecutionBase = {
  version: z.literal(1),
  operationId: identifier,
  kind: z.enum(['workspace-write', 'command', 'mcp']),
  startedAt: managedExecutionTimestamp
}

const approvedManagedExecutionBase = {
  ...managedExecutionBase,
  claim: z.literal('approved'),
  actionSha256: sha256,
  approvalSha256: sha256
}

const approvedManagedExecutionSchema = z.discriminatedUnion('phase', [
  z
    .object({
      ...approvedManagedExecutionBase,
      phase: z.literal('started')
    })
    .strict(),
  z
    .object({
      ...approvedManagedExecutionBase,
      phase: z.literal('completed'),
      completedAt: managedExecutionTimestamp
    })
    .strict(),
  z
    .object({
      ...approvedManagedExecutionBase,
      phase: z.literal('uncertain'),
      interruptedAt: managedExecutionTimestamp
    })
    .strict()
])

const managedExecutionSchema = z.union([
  approvedManagedExecutionSchema,
  z
    .object({
      ...managedExecutionBase,
      claim: z.literal('legacy-untracked'),
      phase: z.literal('uncertain'),
      interruptedAt: managedExecutionTimestamp
    })
    .strict()
])

const activityItemSchema = z
  .object({
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
    failureKind: providerFailureKindSchema.optional(),
    status: z.enum(['pending', 'running', 'success', 'error', 'denied']),
    createdAt: timestamp,
    approvalId: identifier.optional(),
    toolName: z.string().max(200).optional(),
    input: portableJsonObject.optional(),
    result: z.string().max(100_000).optional(),
    durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
    historyOnly: z.boolean().optional(),
    callId: identifier.optional(),
    managedExecution: managedExecutionSchema.optional(),
    provider: providerAttributionSchema.optional()
  })
  .superRefine((item, context) => {
    if (
      item.failureKind &&
      (item.activityType !== 'error' || item.status !== 'error')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Provider failure classification requires a failed error activity',
        path: ['failureKind']
      })
    }
    const marker = item.managedExecution
    if (!marker) return
    if (marker.operationId !== item.id) {
      context.addIssue({
        code: 'custom',
        message: 'Managed execution operation must equal the activity identifier',
        path: ['managedExecution', 'operationId']
      })
    }
    if (marker.claim === 'approved' && !item.callId) {
      context.addIssue({
        code: 'custom',
        message: 'Approved managed execution requires a tool call identifier',
        path: ['callId']
      })
    }
    if (item.approvalId) {
      context.addIssue({
        code: 'custom',
        message: 'A started managed execution cannot retain pending approval authority',
        path: ['approvalId']
      })
    }
    if (item.historyOnly) {
      context.addIssue({
        code: 'custom',
        message: 'Historical activity cannot retain managed execution state',
        path: ['historyOnly']
      })
    }

    const toolMatchesKind =
      marker.kind === 'workspace-write'
        ? item.toolName === 'write_file' || item.toolName === 'edit_file'
        : marker.kind === 'command'
          ? item.toolName === 'run_command'
          : item.toolName?.startsWith('mcp__') === true
    if (!toolMatchesKind) {
      context.addIssue({
        code: 'custom',
        message: 'Managed execution kind does not match the activity tool',
        path: ['managedExecution', 'kind']
      })
    }
    const expectedActivityType =
      marker.kind === 'command' ? 'command' : 'tool'
    if (item.activityType !== expectedActivityType) {
      context.addIssue({
        code: 'custom',
        message:
          'Managed execution kind does not match the activity presentation type',
        path: ['activityType']
      })
    }

    const statusMatchesPhase =
      marker.phase === 'started'
        ? item.status === 'running'
        : marker.phase === 'completed'
          ? item.status === 'success' || item.status === 'error'
          : item.status === 'error'
    if (!statusMatchesPhase) {
      context.addIssue({
        code: 'custom',
        message: 'Managed execution phase does not match activity status',
        path: ['managedExecution', 'phase']
      })
    }
    const terminalTimestamp =
      marker.phase === 'completed'
        ? marker.completedAt
        : marker.phase === 'uncertain'
          ? marker.interruptedAt
          : undefined
    if (
      terminalTimestamp &&
      Date.parse(terminalTimestamp) < Date.parse(marker.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Managed execution terminal timestamp precedes its start',
        path: [
          'managedExecution',
          marker.phase === 'completed' ? 'completedAt' : 'interruptedAt'
        ]
      })
    }
  })

export const taskItemSchema = z.discriminatedUnion('kind', [
  messageItemSchema,
  activityItemSchema
])

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

const runtimeSessionFields = {
  sessionId: z.string().min(1).max(10_000),
  providerRevision: timestamp,
  providerFingerprint: sha256.optional(),
  workspacePath: z.string().min(1).max(8_192),
  mode: z.enum(['ask', 'agent']),
  updatedAt: timestamp
}

export const runtimeSessionSchema = z.union([
  z.object({
    adapterId: identifier,
    sessionCompatibilityId: identifier,
    ...runtimeSessionFields
  }),
  z
    .object({
      adapter: z.enum(['codex', 'claude', 'gemini', 'antigravity']),
      ...runtimeSessionFields
    })
    .transform(({ adapter, ...session }) => {
      const binding = BUILT_IN_CLI_RUNTIME_BINDINGS[adapter]
      return {
        ...session,
        adapterId: binding.adapterId,
        sessionCompatibilityId: binding.sessionCompatibilityId
      }
    })
])

const runtimeSessionsSchema = z
  .record(identifier, runtimeSessionSchema)
  .transform((sessions) =>
    Object.fromEntries(
      Object.entries(sessions).filter(
        ([, session]) => session.sessionId.length <= 200
      )
    )
  )

export const modelRuntimeSessionSchema = z.object({
  adapterId: z.string().min(1).max(200),
  providerRevision: timestamp,
  providerFingerprint: sha256.optional(),
  model: z.string().max(200),
  workspacePath: z.string().min(1).max(8_192).optional(),
  mode: z.enum(['ask', 'agent']),
  includesImportedHistory: z.boolean().optional(),
  origin: z.enum(['ground', 'imported']).optional(),
  conversation: z.array(storedConversationItemSchema).max(10_000),
  checkpoint: portableJson.optional(),
  updatedAt: timestamp
})

export const taskSchema = z
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
    runtimeSessions: runtimeSessionsSchema.optional(),
    modelSessions: z.record(identifier, modelRuntimeSessionSchema).optional(),
    items: z.array(taskItemSchema).max(MAX_PERSISTED_TASK_ITEMS)
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
  .superRefine((task, context) => {
    const operations = new Set<string>()
    const claimsByCall = new Map<string, string>()
    for (const [index, item] of task.items.entries()) {
      if (item.kind !== 'activity' || !item.managedExecution) {
        continue
      }
      const marker = item.managedExecution
      if (operations.has(marker.operationId)) {
        context.addIssue({
          code: 'custom',
          message: 'Managed execution operation is duplicated',
          path: ['items', index, 'managedExecution', 'operationId']
        })
      } else {
        operations.add(marker.operationId)
      }
      if (marker.claim !== 'approved' || !item.callId) continue
      const callKey = `${item.runId}\u0000${item.callId}`
      const existing = claimsByCall.get(callKey)
      if (existing) {
        context.addIssue({
          code: 'custom',
          message:
            existing === marker.actionSha256
              ? 'Managed execution claim is duplicated'
              : 'Managed execution call has conflicting action hashes',
          path: ['items', index, 'managedExecution', 'actionSha256']
        })
        continue
      }
      claimsByCall.set(callKey, marker.actionSha256)
    }
  })

const persistedStateSchema = z
  .object({
    version: z.literal(CURRENT_PERSISTED_STATE_VERSION),
    providers: z.array(providerSchema).min(1).max(1_000),
    mcpServers: z.array(mcpServerSchema).max(100).default([]),
    tasks: z.array(taskSchema).max(10_000),
    settings: z.object({
      selectedTaskId: identifier.optional(),
      defaultProviderId: identifier.optional(),
      sidebarCollapsed: z.boolean()
    }),
    pendingSecretDeletes: z
      .array(identifier)
      .max(5_000)
      .refine(
        (references) => new Set(references).size === references.length,
        'Pending secret cleanup references must be unique'
      )
      .default([])
  })
  .superRefine((state, context) => {
    for (const [providerIndex, provider] of state.providers.entries()) {
      if (
        provider.kind !== 'cli' &&
        !provider.hasApiKey &&
        provider.credentialRevision !== undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Credential revision requires a saved API key',
          path: ['providers', providerIndex, 'credentialRevision']
        })
      }
    }
    const operationIds = new Set<string>()
    const claimsByCall = new Map<string, string>()
    for (const [taskIndex, task] of state.tasks.entries()) {
      for (const [itemIndex, item] of task.items.entries()) {
        if (item.kind !== 'activity' || !item.managedExecution) continue
        const marker = item.managedExecution
        const markerPath = [
          'tasks',
          taskIndex,
          'items',
          itemIndex,
          'managedExecution'
        ] as Array<string | number>
        if (operationIds.has(marker.operationId)) {
          context.addIssue({
            code: 'custom',
            message: 'Managed execution operation must be globally unique',
            path: [...markerPath, 'operationId']
          })
        } else {
          operationIds.add(marker.operationId)
        }
        if (
          marker.claim !== 'approved' ||
          item.callId === undefined
        ) {
          continue
        }
        const callKey = `${item.runId}\u0000${item.callId}`
        const existing = claimsByCall.get(callKey)
        if (existing !== undefined) {
          context.addIssue({
            code: 'custom',
            message:
              existing === marker.actionSha256
                ? 'Managed execution claim must be globally unique'
                : 'Managed execution call has globally conflicting action hashes',
            path: [...markerPath, 'actionSha256']
          })
        } else {
          claimsByCall.set(callKey, marker.actionSha256)
        }
      }
    }
  })

export function parsePersistedState(value: unknown): PersistedStateData {
  const migrated = migrateStateDocument(value, {
    currentVersion: CURRENT_PERSISTED_STATE_VERSION,
    migrations: STATE_MIGRATIONS
  })
  const state = persistedStateSchema.parse(migrated)
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
