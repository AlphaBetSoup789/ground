import { z } from 'zod'
import {
  mcpServerSchema,
  modelRuntimeSessionSchema,
  providerSchema,
  runtimeSessionSchema,
  taskItemSchema,
  taskSchema
} from '../state-schema'
import type { EventKind, GroundLedgerEvent } from './types'

/**
 * Payload contracts for every semantic ledger event except the bootstrap fact,
 * which carries a whole normalized projection and stays special-cased in the
 * codec.
 *
 * Two rules hold for every entry here:
 *
 * - Payload schemas are `strict`, so an unknown key fails closed rather than
 *   surviving a round trip as unvalidated authority.
 * - Entity bodies are normalized through the projection's own domain schemas
 *   before encoding, so the ledger vocabulary cannot drift away from the state
 *   schema and no unmodelled field becomes durable.
 */

const identifier = z.string().min(1).max(200)
const stateTimestamp = z.string().min(1).max(100)
const exactTimestamp = z.iso.datetime({ offset: true })
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
/**
 * Entity bodies are normalized through the same domain schemas the projection
 * uses, before canonical encoding.
 *
 * This matters because the ledger is append-only: a field the projection would
 * later drop as unknown would nevertheless already be durable, and can never be
 * edited out. Normalizing first means an unmodelled structural field — a stray
 * credential, a renderer-supplied grant, anything the schema does not name —
 * cannot reach the ledger at all.
 *
 * It is deliberately not a key-name denylist. Arbitrary user and tool content
 * stays intact wherever the schema permits it (tool arguments, tool results,
 * message text), so a legitimate `{"token": ...}` inside recorded tool input
 * survives, while an unmodelled `apiKey` on a provider profile does not.
 */
const taskBody = normalizedEntity(taskSchema, 'task')
const providerBody = normalizedEntity(providerSchema, 'provider')
const mcpServerBody = normalizedEntity(mcpServerSchema, 'MCP server')
const taskItemBody = normalizedEntity(taskItemSchema, 'timeline item')
const runtimeSessionBody = normalizedEntity(
  runtimeSessionSchema,
  'runtime session'
)
const modelSessionBody = normalizedEntity(
  modelRuntimeSessionSchema,
  'model session'
)

function normalizedEntity<Schema extends z.ZodType>(
  schema: Schema,
  label: string
): z.ZodType<Record<string, unknown>> {
  return z.unknown().transform((value, context) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        message: `Ledger ${label} body failed domain validation`,
        params: { issues: parsed.error.issues }
      })
      return z.NEVER
    }
    return parsed.data as Record<string, unknown>
  }) as unknown as z.ZodType<Record<string, unknown>>
}

const settingsEntityId = 'settings'
const secretCleanupEntityId = 'secret-cleanup'

const taskFieldUpdate = {
  taskId: identifier,
  updatedAt: stateTimestamp
}

const sidebarCollapsedPayload = z
  .object({ collapsed: z.boolean() })
  .strict()

const selectedTaskPayload = z
  .object({ taskId: identifier.nullable() })
  .strict()

const defaultProviderPayload = z
  .object({ providerId: identifier })
  .strict()

const providerUpsertedPayload = z
  .object({ providerId: identifier, provider: providerBody })
  .strict()

const providerSecretTransitionPayload = z
  .object({
    providerId: identifier,
    provider: providerBody,
    stagedReference: identifier.optional(),
    obsoleteReferences: z.array(identifier).max(5_000)
  })
  .strict()

const providerDeletedPayload = z
  .object({
    providerId: identifier,
    obsoleteReferences: z.array(identifier).max(5_000)
  })
  .strict()

const secretCleanupQueuedPayload = z
  .object({ reference: identifier })
  .strict()

const secretCleanupAcknowledgedPayload = z
  .object({ references: z.array(identifier).max(5_000) })
  .strict()

const mcpServerSavedPayload = z
  .object({ serverId: identifier, server: mcpServerBody })
  .strict()

const mcpServerDeletedPayload = z
  .object({ serverId: identifier })
  .strict()

const taskCreatedPayload = z
  .object({ taskId: identifier, task: taskBody })
  .strict()

const taskForkedPayload = z
  .object({
    taskId: identifier,
    sourceTaskId: identifier,
    task: taskBody
  })
  .strict()

const taskImportedPayload = z
  .object({ taskId: identifier, task: taskBody })
  .strict()

const taskDeletedPayload = z.object({ taskId: identifier }).strict()

const taskArchivedPayload = z
  .object({
    ...taskFieldUpdate,
    archivedAt: exactTimestamp.nullable()
  })
  .strict()

const taskTitlePayload = z
  .object({ ...taskFieldUpdate, title: z.string().min(1).max(120) })
  .strict()

const taskProviderPayload = z
  .object({ ...taskFieldUpdate, providerId: identifier })
  .strict()

const taskModePayload = z
  .object({ ...taskFieldUpdate, mode: z.enum(['ask', 'agent']) })
  .strict()

const taskWorkspacePayload = z
  .object({
    ...taskFieldUpdate,
    workspacePath: z.string().min(1).max(8_192).nullable()
  })
  .strict()

const taskImportedHistoryPayload = z
  .object({
    ...taskFieldUpdate,
    includeImportedHistory: z.boolean().nullable()
  })
  .strict()

const taskRunStatusPayload = z
  .object({
    ...taskFieldUpdate,
    runStatus: z.enum(['idle', 'running', 'awaiting-approval', 'failed'])
  })
  .strict()

const taskRuntimeSessionPayload = z
  .object({
    ...taskFieldUpdate,
    providerId: identifier,
    session: runtimeSessionBody.nullable()
  })
  .strict()

const taskModelSessionPayload = z
  .object({
    ...taskFieldUpdate,
    providerId: identifier,
    session: modelSessionBody.nullable()
  })
  .strict()

const taskItemAppendedPayload = z
  .object({
    ...taskFieldUpdate,
    itemId: identifier,
    item: taskItemBody
  })
  .strict()

const taskMessageContentPayload = z
  .object({
    ...taskFieldUpdate,
    itemId: identifier,
    content: z.string().max(2_000_000)
  })
  .strict()

const taskActivityUpdatedPayload = z
  .object({
    ...taskFieldUpdate,
    itemId: identifier,
    status: z
      .enum(['pending', 'running', 'success', 'error', 'denied'])
      .optional(),
    title: z.string().max(500).optional(),
    detail: z.string().max(100_000).nullable().optional(),
    result: z.string().max(100_000).nullable().optional(),
    durationMs: z
      .number()
      .finite()
      .nonnegative()
      .max(86_400_000)
      .nullable()
      .optional(),
    failureKind: z.string().min(1).max(200).nullable().optional(),
    approvalId: identifier.nullable().optional()
  })
  .strict()
  .refine(
    (payload) =>
      Object.keys(payload).some(
        (key) => key !== 'taskId' && key !== 'itemId' && key !== 'updatedAt'
      ),
    { message: 'Activity update must change at least one field' }
  )

const managedExecutionStartedPayload = z
  .object({
    ...taskFieldUpdate,
    itemId: identifier,
    runId: identifier,
    callId: identifier,
    toolName: z.string().min(1).max(200),
    executionKind: z.enum(['workspace-write', 'command', 'mcp']),
    actionSha256: sha256,
    approvalSha256: sha256,
    startedAt: exactTimestamp
  })
  .strict()

const managedExecutionCompletedPayload = z
  .object({
    ...taskFieldUpdate,
    itemId: identifier,
    operationId: identifier,
    actionSha256: sha256,
    status: z.enum(['success', 'error']),
    result: z.string().max(100_000).optional(),
    durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
    completedAt: exactTimestamp
  })
  .strict()

const managedExecutionInterruptedPayload = z
  .object({
    ...taskFieldUpdate,
    itemId: identifier,
    operationId: identifier,
    interruptedAt: exactTimestamp
  })
  .strict()

export interface SemanticPayloadCodec {
  readonly schema: z.ZodType<Record<string, unknown>>
  /** Derives the row's exact entity ID from the validated payload. */
  readonly entityId: (payload: Record<string, unknown>) => string
}

const byTaskId = (payload: Record<string, unknown>): string =>
  payload.taskId as string

const constantEntityId =
  (value: string) =>
  (): string =>
    value

export const SEMANTIC_PAYLOAD_CODECS: Readonly<
  Partial<Record<EventKind, SemanticPayloadCodec>>
> = Object.freeze({
  'settings.sidebar-collapsed-set': {
    schema: sidebarCollapsedPayload,
    entityId: constantEntityId(settingsEntityId)
  },
  'settings.selected-task-set': {
    schema: selectedTaskPayload,
    entityId: constantEntityId(settingsEntityId)
  },
  'settings.default-provider-set': {
    schema: defaultProviderPayload,
    entityId: constantEntityId(settingsEntityId)
  },
  'provider.upserted': {
    schema: providerUpsertedPayload,
    entityId: (payload) => payload.providerId as string
  },
  'provider.secret-transition-published': {
    schema: providerSecretTransitionPayload,
    entityId: (payload) => payload.providerId as string
  },
  'provider.deleted': {
    schema: providerDeletedPayload,
    entityId: (payload) => payload.providerId as string
  },
  'secret-cleanup.queued': {
    schema: secretCleanupQueuedPayload,
    entityId: constantEntityId(secretCleanupEntityId)
  },
  'secret-cleanup.acknowledged': {
    schema: secretCleanupAcknowledgedPayload,
    entityId: constantEntityId(secretCleanupEntityId)
  },
  'mcp-server.saved': {
    schema: mcpServerSavedPayload,
    entityId: (payload) => payload.serverId as string
  },
  'mcp-server.deleted': {
    schema: mcpServerDeletedPayload,
    entityId: (payload) => payload.serverId as string
  },
  'task.created': { schema: taskCreatedPayload, entityId: byTaskId },
  'task.forked': { schema: taskForkedPayload, entityId: byTaskId },
  'task.imported': { schema: taskImportedPayload, entityId: byTaskId },
  'task.deleted': { schema: taskDeletedPayload, entityId: byTaskId },
  'task.archived-set': { schema: taskArchivedPayload, entityId: byTaskId },
  'task.title-set': { schema: taskTitlePayload, entityId: byTaskId },
  'task.provider-set': { schema: taskProviderPayload, entityId: byTaskId },
  'task.mode-set': { schema: taskModePayload, entityId: byTaskId },
  'task.workspace-set': { schema: taskWorkspacePayload, entityId: byTaskId },
  'task.imported-history-set': {
    schema: taskImportedHistoryPayload,
    entityId: byTaskId
  },
  'task.run-status-set': { schema: taskRunStatusPayload, entityId: byTaskId },
  'task.runtime-session-set': {
    schema: taskRuntimeSessionPayload,
    entityId: byTaskId
  },
  'task.model-session-set': {
    schema: taskModelSessionPayload,
    entityId: byTaskId
  },
  'task.item-appended': {
    schema: taskItemAppendedPayload,
    entityId: byTaskId
  },
  'task.message-content-set': {
    schema: taskMessageContentPayload,
    entityId: byTaskId
  },
  'task.activity-updated': {
    schema: taskActivityUpdatedPayload,
    entityId: byTaskId
  },
  'managed-execution.started': {
    schema: managedExecutionStartedPayload,
    entityId: byTaskId
  },
  'managed-execution.completed': {
    schema: managedExecutionCompletedPayload,
    entityId: byTaskId
  },
  'managed-execution.interrupted': {
    schema: managedExecutionInterruptedPayload,
    entityId: byTaskId
  }
} satisfies Partial<Record<EventKind, SemanticPayloadCodec>>)

/**
 * Strips `kind` and drops absent optional fields. Canonical JSON refuses
 * `undefined`, so an optional field must be omitted rather than encoded.
 */
export function toEventPayload(
  event: GroundLedgerEvent
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (key === 'kind' || value === undefined) continue
    payload[key] = value
  }
  return payload
}
