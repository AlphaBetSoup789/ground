import type {
  ActivityStatus,
  ManagedExecutionKind,
  McpServerProfile,
  ProviderProfile,
  Task,
  TaskItem
} from '../../shared/types'
import type { PersistedStateData } from '../state-schema'
import type { GroundLedgerEvent } from './types'

/**
 * Translates every production `StateStore` mutation into the named semantic
 * event batch that reproduces it on the ledger.
 *
 * This is the planning half of the JSON-to-SQLite cutover: the reducers landed
 * with the event vocabulary, but nothing yet said which batch a given product
 * operation should write. Each planner case mirrors exactly one `StateStore`
 * method, including the parts that are easy to lose in a rewrite:
 *
 * - **Compound operations produce more than one event.** Archiving a task both
 *   stamps the task and moves the selection, so it plans two events in one
 *   batch rather than leaning on a reducer side effect that does not exist.
 * - **No-ops produce an empty batch.** Where `StateStore` silently returns
 *   without touching state — deleting an unknown provider, queueing a secret
 *   reference that is already pending — the plan is empty. Emitting a "harmless"
 *   event instead would either desynchronize the two stores or write a reducer
 *   assertion failure into an append-only log.
 * - **Rejections throw before any event exists.** A refused mutation must leave
 *   the ledger byte-identical, so preconditions are checked here rather than
 *   discovered by the reducer mid-batch.
 *
 * ## Ambient inputs are explicit
 *
 * `StateStore` mints IDs with `createId` and timestamps with `nowIso` inside its
 * transaction. A planner that re-minted them could never agree with a store that
 * already ran, so every generated identity and timestamp is an explicit field on
 * the mutation. The parity harness sources those fields from the JSON store's
 * own result, which keeps the comparison focused on state logic — ordering,
 * cascades, selection fallbacks, set semantics — instead of clock and ID
 * generation, which are not what the cutover puts at risk.
 *
 * ## Coverage
 *
 * Every `StateStore` mutation has a case here. The reverse is not true, by
 * design: `settings.sidebar-collapsed-set` has a reducer and a payload codec but
 * no case below, because nothing in production writes `sidebarCollapsed` — it is
 * only ever set by initial state. The event kind stays in the vocabulary on
 * purpose. It is a valid persisted setting, and being the simplest possible
 * payload makes it the foundation's transaction and fault-injection event. The
 * absent writer is a documented fact about the product, not a gap in this
 * module.
 */

export interface PlannedMutation {
  /** Stable name for the operation, used in parity reports and ledger review. */
  readonly name: string
  /** Empty when the source mutation is a no-op against this state. */
  readonly events: readonly GroundLedgerEvent[]
}

/** Fields every task-scoped mutation carries, mirroring `task.updatedAt`. */
interface TaskMutationBase {
  readonly taskId: string
  /** The `updatedAt` the JSON store stamped for this same operation. */
  readonly updatedAt: string
}

export type StateMutation =
  // ── MCP servers ───────────────────────────────────────────────────────────
  | { readonly kind: 'save-mcp-server'; readonly server: McpServerProfile }
  | { readonly kind: 'delete-mcp-server'; readonly serverId: string }
  // ── Providers and secret cleanup ──────────────────────────────────────────
  | { readonly kind: 'upsert-provider'; readonly provider: ProviderProfile }
  | { readonly kind: 'queue-provisional-secret-delete'; readonly reference: string }
  | {
      readonly kind: 'publish-provider-secret-transition'
      readonly provider: ProviderProfile
      readonly stagedReference?: string
      readonly obsoleteReferences: readonly string[]
    }
  | {
      readonly kind: 'acknowledge-secret-deletes'
      readonly references: readonly string[]
    }
  | { readonly kind: 'delete-provider'; readonly providerId: string }
  | {
      readonly kind: 'delete-provider-with-secret-transition'
      readonly providerId: string
      readonly obsoleteReferences: readonly string[]
    }
  // ── Task lifecycle ────────────────────────────────────────────────────────
  | { readonly kind: 'create-task'; readonly task: Task }
  | { readonly kind: 'fork-task'; readonly sourceTaskId: string; readonly task: Task }
  | { readonly kind: 'import-task'; readonly task: Task }
  | { readonly kind: 'delete-task'; readonly taskId: string }
  | { readonly kind: 'select-task'; readonly taskId: string }
  | ({
      readonly kind: 'set-task-archived'
      readonly archived: boolean
      /** The resulting `archivedAt`; `null` when unarchiving. */
      readonly archivedAt: string | null
    } & TaskMutationBase)
  // ── Task fields ───────────────────────────────────────────────────────────
  | ({
      readonly kind: 'patch-task'
      /**
       * The compound field patch behind `StateStore.mutateTask`. Only fields
       * that actually change are planned, matching the store's own guard on
       * `defaultProviderId`.
       */
      readonly patch: TaskFieldPatch
    } & TaskMutationBase)
  | ({
      readonly kind: 'set-task-runtime-session'
      readonly providerId: string
      readonly session: Record<string, unknown> | null
    } & TaskMutationBase)
  | ({
      readonly kind: 'set-task-model-session'
      readonly providerId: string
      readonly session: Record<string, unknown> | null
    } & TaskMutationBase)
  // ── Timeline ──────────────────────────────────────────────────────────────
  | ({ readonly kind: 'append-task-item'; readonly item: TaskItem } & TaskMutationBase)
  | ({
      readonly kind: 'set-message-content'
      readonly itemId: string
      readonly content: string
    } & TaskMutationBase)
  | ({
      readonly kind: 'update-activities'
      /** One commit may finalize several open activities at once. */
      readonly updates: readonly ActivityUpdate[]
    } & TaskMutationBase)
  // ── Managed execution ─────────────────────────────────────────────────────
  | ({
      readonly kind: 'begin-managed-execution'
      readonly itemId: string
      readonly runId: string
      readonly callId: string
      readonly toolName: string
      readonly executionKind: ManagedExecutionKind
      readonly actionSha256: string
      readonly approvalSha256: string
      readonly startedAt: string
    } & TaskMutationBase)
  | ({
      readonly kind: 'complete-managed-execution'
      readonly itemId: string
      readonly operationId: string
      readonly actionSha256: string
      readonly status: Extract<ActivityStatus, 'success' | 'error'>
      readonly result?: string
      readonly durationMs?: number
      readonly completedAt: string
    } & TaskMutationBase)
  | ({
      readonly kind: 'interrupt-managed-execution'
      readonly itemId: string
      readonly operationId: string
      readonly interruptedAt: string
    } & TaskMutationBase)

export interface TaskFieldPatch {
  readonly title?: string
  readonly providerId?: string
  readonly mode?: Task['mode']
  /** `null` clears the workspace, matching `delete task.workspacePath`. */
  readonly workspacePath?: string | null
  readonly includeImportedHistory?: boolean | null
  readonly runStatus?: Task['runStatus']
}

export interface ActivityUpdate {
  readonly itemId: string
  readonly status?: ActivityStatus
  readonly title?: string
  readonly detail?: string | null
  readonly result?: string | null
  readonly durationMs?: number | null
  readonly failureKind?: string | null
  readonly approvalId?: string | null
}

export function planStateMutation(
  state: PersistedStateData,
  mutation: StateMutation
): PlannedMutation {
  switch (mutation.kind) {
    case 'save-mcp-server':
      return {
        name: 'save-mcp-server',
        events: [
          {
            kind: 'mcp-server.saved',
            serverId: mutation.server.id,
            server: portable(mutation.server)
          }
        ]
      }

    case 'delete-mcp-server': {
      // `StateStore.deleteMcpServer` rejects an unknown ID rather than treating
      // it as a no-op, so the plan must fail before producing a batch.
      if (!state.mcpServers.some((server) => server.id === mutation.serverId)) {
        throw new Error('MCP server not found')
      }
      return {
        name: 'delete-mcp-server',
        events: [{ kind: 'mcp-server.deleted', serverId: mutation.serverId }]
      }
    }

    case 'upsert-provider':
      return {
        name: 'upsert-provider',
        events: [
          {
            kind: 'provider.upserted',
            providerId: mutation.provider.id,
            provider: portable(mutation.provider)
          }
        ]
      }

    case 'queue-provisional-secret-delete': {
      // Already-pending references leave state untouched in the JSON store.
      if (state.pendingSecretDeletes.includes(mutation.reference)) {
        return { name: 'queue-provisional-secret-delete', events: [] }
      }
      return {
        name: 'queue-provisional-secret-delete',
        events: [
          { kind: 'secret-cleanup.queued', reference: mutation.reference }
        ]
      }
    }

    case 'publish-provider-secret-transition':
      return {
        name: 'publish-provider-secret-transition',
        events: [
          {
            kind: 'provider.secret-transition-published',
            providerId: mutation.provider.id,
            provider: portable(mutation.provider),
            ...(mutation.stagedReference === undefined
              ? {}
              : { stagedReference: mutation.stagedReference }),
            obsoleteReferences: [...mutation.obsoleteReferences]
          }
        ]
      }

    case 'acknowledge-secret-deletes': {
      const acknowledged = new Set(mutation.references)
      const clears = state.pendingSecretDeletes.some((reference) =>
        acknowledged.has(reference)
      )
      if (!clears) return { name: 'acknowledge-secret-deletes', events: [] }
      return {
        name: 'acknowledge-secret-deletes',
        events: [
          {
            kind: 'secret-cleanup.acknowledged',
            references: [...mutation.references]
          }
        ]
      }
    }

    case 'delete-provider':
      return planProviderDeletion(state, mutation.providerId, [], 'delete-provider')

    case 'delete-provider-with-secret-transition':
      return planProviderDeletion(
        state,
        mutation.providerId,
        mutation.obsoleteReferences,
        'delete-provider-with-secret-transition'
      )

    case 'create-task':
      return {
        name: 'create-task',
        events: [
          {
            kind: 'task.created',
            taskId: mutation.task.id,
            task: portable(mutation.task)
          }
        ]
      }

    case 'fork-task':
      return {
        name: 'fork-task',
        events: [
          {
            kind: 'task.forked',
            taskId: mutation.task.id,
            sourceTaskId: mutation.sourceTaskId,
            task: portable(mutation.task)
          }
        ]
      }

    case 'import-task':
      return {
        name: 'import-task',
        events: [
          {
            kind: 'task.imported',
            taskId: mutation.task.id,
            task: portable(mutation.task)
          }
        ]
      }

    case 'delete-task':
      return {
        name: 'delete-task',
        events: [{ kind: 'task.deleted', taskId: mutation.taskId }]
      }

    case 'select-task':
      return {
        name: 'select-task',
        events: [
          { kind: 'settings.selected-task-set', taskId: mutation.taskId }
        ]
      }

    case 'set-task-archived':
      return planArchive(state, mutation)

    case 'patch-task':
      return planTaskPatch(state, mutation)

    case 'set-task-runtime-session':
      return {
        name: 'set-task-runtime-session',
        events: [
          {
            kind: 'task.runtime-session-set',
            taskId: mutation.taskId,
            updatedAt: mutation.updatedAt,
            providerId: mutation.providerId,
            session: mutation.session === null ? null : portable(mutation.session)
          }
        ]
      }

    case 'set-task-model-session':
      return {
        name: 'set-task-model-session',
        events: [
          {
            kind: 'task.model-session-set',
            taskId: mutation.taskId,
            updatedAt: mutation.updatedAt,
            providerId: mutation.providerId,
            session: mutation.session === null ? null : portable(mutation.session)
          }
        ]
      }

    case 'append-task-item':
      return {
        name: 'append-task-item',
        events: [
          {
            kind: 'task.item-appended',
            taskId: mutation.taskId,
            updatedAt: mutation.updatedAt,
            itemId: mutation.item.id,
            item: portable(mutation.item)
          }
        ]
      }

    case 'set-message-content':
      return {
        name: 'set-message-content',
        events: [
          {
            kind: 'task.message-content-set',
            taskId: mutation.taskId,
            updatedAt: mutation.updatedAt,
            itemId: mutation.itemId,
            content: mutation.content
          }
        ]
      }

    case 'update-activities': {
      // An empty batch is a claim that the store changed nothing, and this
      // operation can never honestly make it: the store restamps `updatedAt`
      // for any commit it accepts. A caller with nothing to update should not
      // have committed, so refuse rather than plan a silent divergence.
      if (!mutation.updates.length) {
        throw new Error('Activity update must change at least one activity')
      }

      const events = mutation.updates.map((update) => {
        const changes = definedFields({
          status: update.status,
          title: update.title,
          detail: update.detail,
          result: update.result,
          durationMs: update.durationMs,
          failureKind: update.failureKind,
          approvalId: update.approvalId
        })
        // The payload schema refuses an update that names an activity without
        // changing any of its fields. Catching it here rather than at encode
        // time is what keeps the two stores in step: the JSON store has already
        // committed its restamped `updatedAt` by the time a batch reaches the
        // codec, so a codec rejection would leave the ledger permanently one
        // commit behind with no way to catch up.
        if (!Object.keys(changes).length) {
          throw new Error(
            `Activity update for ${update.itemId} must change at least one field`
          )
        }
        return {
          kind: 'task.activity-updated',
          taskId: mutation.taskId,
          updatedAt: mutation.updatedAt,
          itemId: update.itemId,
          ...changes
        }
      }) as readonly GroundLedgerEvent[]

      return { name: 'update-activities', events }
    }

    case 'begin-managed-execution':
      return {
        name: 'begin-managed-execution',
        events: [
          {
            kind: 'managed-execution.started',
            taskId: mutation.taskId,
            updatedAt: mutation.updatedAt,
            itemId: mutation.itemId,
            runId: mutation.runId,
            callId: mutation.callId,
            toolName: mutation.toolName,
            executionKind: mutation.executionKind,
            actionSha256: mutation.actionSha256,
            approvalSha256: mutation.approvalSha256,
            startedAt: mutation.startedAt
          }
        ]
      }

    case 'complete-managed-execution':
      return {
        name: 'complete-managed-execution',
        events: [
          {
            kind: 'managed-execution.completed',
            taskId: mutation.taskId,
            updatedAt: mutation.updatedAt,
            itemId: mutation.itemId,
            operationId: mutation.operationId,
            actionSha256: mutation.actionSha256,
            status: mutation.status,
            ...(mutation.result === undefined ? {} : { result: mutation.result }),
            ...(mutation.durationMs === undefined
              ? {}
              : { durationMs: mutation.durationMs }),
            completedAt: mutation.completedAt
          }
        ]
      }

    case 'interrupt-managed-execution':
      return {
        name: 'interrupt-managed-execution',
        events: [
          {
            kind: 'managed-execution.interrupted',
            taskId: mutation.taskId,
            updatedAt: mutation.updatedAt,
            itemId: mutation.itemId,
            operationId: mutation.operationId,
            interruptedAt: mutation.interruptedAt
          }
        ]
      }

    default: {
      const unreachable: never = mutation
      throw new Error(
        `No ledger plan for mutation ${String(
          (unreachable as { kind?: unknown }).kind
        )}`
      )
    }
  }
}

/**
 * Provider deletion is the sharpest no-op in the store: an unknown ID returns
 * without touching `pendingSecretDeletes`, so the obsolete references are
 * dropped too. The reducer would instead reject an unknown provider outright,
 * which is why this cannot be planned as an unconditional event.
 */
function planProviderDeletion(
  state: PersistedStateData,
  providerId: string,
  obsoleteReferences: readonly string[],
  name: string
): PlannedMutation {
  if (state.providers.length <= 1) {
    throw new Error('Keep at least one provider connected')
  }
  if (!state.providers.some((provider) => provider.id === providerId)) {
    return { name, events: [] }
  }
  return {
    name,
    events: [
      {
        kind: 'provider.deleted',
        providerId,
        obsoleteReferences: [...obsoleteReferences]
      }
    ]
  }
}

/**
 * Archiving is compound. `task.archived-set` stamps the task but deliberately
 * leaves the selection alone, so the selection move that `StateStore` performs
 * in the same transaction has to be planned as a second event in the batch.
 */
function planArchive(
  state: PersistedStateData,
  mutation: Extract<StateMutation, { kind: 'set-task-archived' }>
): PlannedMutation {
  const events: GroundLedgerEvent[] = [
    {
      kind: 'task.archived-set',
      taskId: mutation.taskId,
      updatedAt: mutation.updatedAt,
      archivedAt: mutation.archivedAt
    }
  ]

  if (!mutation.archived) {
    events.push({
      kind: 'settings.selected-task-set',
      taskId: mutation.taskId
    })
  } else if (state.settings.selectedTaskId === mutation.taskId) {
    const next = state.tasks.find(
      (candidate) => candidate.id !== mutation.taskId && !candidate.archivedAt
    )
    events.push({
      kind: 'settings.selected-task-set',
      taskId: next?.id ?? null
    })
  }

  return { name: 'set-task-archived', events }
}

/**
 * One `mutateTask` call can change several fields at once, and each field is a
 * separate ledger fact. Unchanged fields are skipped: planning a redundant
 * `task.provider-set` would move `defaultProviderId` even though the store's
 * own guard only does so when the task's provider actually changed.
 */
function planTaskPatch(
  state: PersistedStateData,
  mutation: Extract<StateMutation, { kind: 'patch-task' }>
): PlannedMutation {
  const task = state.tasks.find((candidate) => candidate.id === mutation.taskId)
  if (!task) throw new Error('Task not found')

  const { patch, taskId, updatedAt } = mutation
  const events: GroundLedgerEvent[] = []

  if (patch.title !== undefined && patch.title !== task.title) {
    events.push({ kind: 'task.title-set', taskId, updatedAt, title: patch.title })
  }
  if (patch.mode !== undefined && patch.mode !== task.mode) {
    events.push({ kind: 'task.mode-set', taskId, updatedAt, mode: patch.mode })
  }
  if (patch.runStatus !== undefined && patch.runStatus !== task.runStatus) {
    events.push({
      kind: 'task.run-status-set',
      taskId,
      updatedAt,
      runStatus: patch.runStatus
    })
  }
  if (
    patch.workspacePath !== undefined &&
    patch.workspacePath !== (task.workspacePath ?? null)
  ) {
    events.push({
      kind: 'task.workspace-set',
      taskId,
      updatedAt,
      workspacePath: patch.workspacePath
    })
  }
  if (
    patch.includeImportedHistory !== undefined &&
    patch.includeImportedHistory !== (task.includeImportedHistory ?? null)
  ) {
    events.push({
      kind: 'task.imported-history-set',
      taskId,
      updatedAt,
      includeImportedHistory: patch.includeImportedHistory
    })
  }
  if (patch.providerId !== undefined && patch.providerId !== task.providerId) {
    // The store only promotes `defaultProviderId` for a provider it can find,
    // and the reducer promotes unconditionally, so an unknown provider must not
    // reach the ledger as a provider change.
    if (!state.providers.some((provider) => provider.id === patch.providerId)) {
      throw new Error('Provider not found')
    }
    events.push({
      kind: 'task.provider-set',
      taskId,
      updatedAt,
      providerId: patch.providerId
    })
  }

  if (!events.length) {
    // Every field already held its target value. The store still restamps
    // `updatedAt`, so the batch carries exactly that and nothing else.
    events.push({ kind: 'task.title-set', taskId, updatedAt, title: task.title })
  }

  return { name: 'patch-task', events }
}

/** Drops absent optional fields; canonical JSON refuses `undefined`. */
function definedFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const defined: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) defined[key] = value
  }
  return defined
}

/**
 * Converts a live store object into its durable form.
 *
 * In-memory entities keep optional keys with an `undefined` value: creating a
 * task with no workspace produces `workspacePath: undefined`, not an absent
 * key. `JSON.stringify` drops those, so the JSON store's document never carries
 * them, but canonical JSON refuses to encode `undefined` at all. Round-tripping
 * here puts the entity in exactly the shape the JSON store would have persisted,
 * which is the shape the two stores have to agree on.
 */
function portable(entity: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entity)) as Record<string, unknown>
}
