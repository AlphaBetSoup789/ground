import type { LegacySourceMigrationGate } from '../legacy-state-recovery'
import type { PersistedStateData } from '../state-schema'

export const DATABASE_FORMAT_VERSION = 1 as const
export const EVENT_SCHEMA_VERSION = 1 as const
export const REDUCER_VERSION = 1 as const
export const PROJECTION_SCHEMA_VERSION = 1 as const
export const HEAD_WITNESS_VERSION = 1 as const

export const GENESIS_EVENT_HASH = '0'.repeat(64)
export const GENESIS_TRANSACTION_ID = 'genesis'

export const MAX_EVENT_BATCH_SIZE = 1_000
export const MAX_EVENT_ROWS = 1_000_000
export const MAX_PROJECTION_BYTES = 128 * 1024 * 1024
export const MAX_EVENT_PAYLOAD_BYTES =
  MAX_PROJECTION_BYTES + 64 * 1024
export const MAX_DATABASE_BYTES = 512 * 1024 * 1024

export type EventKind =
  | 'legacy-state.bootstrapped'
  | 'settings.sidebar-collapsed-set'
  | 'settings.selected-task-set'
  | 'settings.default-provider-set'
  | 'provider.upserted'
  | 'provider.secret-transition-published'
  | 'provider.deleted'
  | 'secret-cleanup.queued'
  | 'secret-cleanup.acknowledged'
  | 'mcp-server.saved'
  | 'mcp-server.deleted'
  | 'task.created'
  | 'task.forked'
  | 'task.imported'
  | 'task.deleted'
  | 'task.archived-set'
  | 'task.title-set'
  | 'task.provider-set'
  | 'task.mode-set'
  | 'task.workspace-set'
  | 'task.imported-history-set'
  | 'task.run-status-set'
  | 'task.runtime-session-set'
  | 'task.model-session-set'
  | 'task.item-appended'
  | 'task.message-content-set'
  | 'task.activity-updated'
  | 'managed-execution.started'
  | 'managed-execution.completed'
  | 'managed-execution.interrupted'
  | 'managed-execution.legacy-interrupted'

/**
 * Entity bodies are carried as opaque portable JSON here and validated in full
 * by `parsePersistedState` when the reducer folds them into the projection.
 * Keeping one validation authority prevents the ledger vocabulary and the state
 * schema from drifting apart.
 */
export type LedgerEntityBody = Record<string, unknown>

export interface LegacyStateBootstrappedEvent {
  readonly kind: 'legacy-state.bootstrapped'
  readonly sourceFormat: 'ground-json'
  readonly sourceStateVersion: 2
  readonly sourceSha256: string
  readonly sourceByteLength: number
  readonly normalizedStateSha256: string
  readonly state: PersistedStateData
}

export interface SidebarCollapsedSetEvent {
  readonly kind: 'settings.sidebar-collapsed-set'
  readonly collapsed: boolean
}

export interface SelectedTaskSetEvent {
  readonly kind: 'settings.selected-task-set'
  /** `null` clears the selection without deleting a task. */
  readonly taskId: string | null
}

export interface DefaultProviderSetEvent {
  readonly kind: 'settings.default-provider-set'
  readonly providerId: string
}

export interface ProviderUpsertedEvent {
  readonly kind: 'provider.upserted'
  readonly providerId: string
  readonly provider: LedgerEntityBody
}

/**
 * Publishes an exact provider revision together with the vault-cleanup
 * references that revision makes obsolete. The ledger records only opaque
 * references; secret material never enters an event.
 */
export interface ProviderSecretTransitionPublishedEvent {
  readonly kind: 'provider.secret-transition-published'
  readonly providerId: string
  readonly provider: LedgerEntityBody
  readonly stagedReference?: string
  readonly obsoleteReferences: readonly string[]
}

export interface ProviderDeletedEvent {
  readonly kind: 'provider.deleted'
  readonly providerId: string
  readonly obsoleteReferences: readonly string[]
}

export interface SecretCleanupQueuedEvent {
  readonly kind: 'secret-cleanup.queued'
  readonly reference: string
}

export interface SecretCleanupAcknowledgedEvent {
  readonly kind: 'secret-cleanup.acknowledged'
  readonly references: readonly string[]
}

export interface McpServerSavedEvent {
  readonly kind: 'mcp-server.saved'
  readonly serverId: string
  readonly server: LedgerEntityBody
}

export interface McpServerDeletedEvent {
  readonly kind: 'mcp-server.deleted'
  readonly serverId: string
}

export interface TaskCreatedEvent {
  readonly kind: 'task.created'
  readonly taskId: string
  readonly task: LedgerEntityBody
}

export interface TaskForkedEvent {
  readonly kind: 'task.forked'
  readonly taskId: string
  readonly sourceTaskId: string
  readonly task: LedgerEntityBody
}

export interface TaskImportedEvent {
  readonly kind: 'task.imported'
  readonly taskId: string
  readonly task: LedgerEntityBody
}

export interface TaskDeletedEvent {
  readonly kind: 'task.deleted'
  readonly taskId: string
}

export interface TaskArchivedSetEvent {
  readonly kind: 'task.archived-set'
  readonly taskId: string
  /** `null` unarchives; a timestamp archives at that exact instant. */
  readonly archivedAt: string | null
  readonly updatedAt: string
}

export interface TaskTitleSetEvent {
  readonly kind: 'task.title-set'
  readonly taskId: string
  readonly title: string
  readonly updatedAt: string
}

export interface TaskProviderSetEvent {
  readonly kind: 'task.provider-set'
  readonly taskId: string
  readonly providerId: string
  readonly updatedAt: string
}

export interface TaskModeSetEvent {
  readonly kind: 'task.mode-set'
  readonly taskId: string
  readonly mode: 'ask' | 'agent'
  readonly updatedAt: string
}

export interface TaskWorkspaceSetEvent {
  readonly kind: 'task.workspace-set'
  readonly taskId: string
  readonly workspacePath: string | null
  readonly updatedAt: string
}

export interface TaskImportedHistorySetEvent {
  readonly kind: 'task.imported-history-set'
  readonly taskId: string
  readonly includeImportedHistory: boolean | null
  readonly updatedAt: string
}

export interface TaskRunStatusSetEvent {
  readonly kind: 'task.run-status-set'
  readonly taskId: string
  readonly runStatus: 'idle' | 'running' | 'awaiting-approval' | 'failed'
  readonly updatedAt: string
}

export interface TaskRuntimeSessionSetEvent {
  readonly kind: 'task.runtime-session-set'
  readonly taskId: string
  readonly providerId: string
  /** `null` forgets exactly one runtime session binding. */
  readonly session: LedgerEntityBody | null
  readonly updatedAt: string
}

export interface TaskModelSessionSetEvent {
  readonly kind: 'task.model-session-set'
  readonly taskId: string
  readonly providerId: string
  /** `null` forgets exactly one model session binding. */
  readonly session: LedgerEntityBody | null
  readonly updatedAt: string
}

export interface TaskItemAppendedEvent {
  readonly kind: 'task.item-appended'
  readonly taskId: string
  readonly itemId: string
  readonly item: LedgerEntityBody
  readonly updatedAt: string
}

export interface TaskMessageContentSetEvent {
  readonly kind: 'task.message-content-set'
  readonly taskId: string
  readonly itemId: string
  readonly content: string
  readonly updatedAt: string
}

/**
 * A bounded, named-field activity progression. Absent fields are unchanged and
 * an explicit `null` clears exactly one optional field; there is deliberately no
 * arbitrary-path patch form.
 */
export interface TaskActivityUpdatedEvent {
  readonly kind: 'task.activity-updated'
  readonly taskId: string
  readonly itemId: string
  readonly updatedAt: string
  readonly status?: 'pending' | 'running' | 'success' | 'error' | 'denied'
  readonly title?: string
  readonly detail?: string | null
  readonly result?: string | null
  readonly durationMs?: number | null
  readonly failureKind?: string | null
  readonly approvalId?: string | null
}

export interface ManagedExecutionStartedEvent {
  readonly kind: 'managed-execution.started'
  readonly taskId: string
  readonly itemId: string
  readonly runId: string
  readonly callId: string
  readonly toolName: string
  readonly executionKind: 'workspace-write' | 'command' | 'mcp'
  readonly actionSha256: string
  readonly approvalSha256: string
  readonly startedAt: string
  readonly updatedAt: string
}

export interface ManagedExecutionCompletedEvent {
  readonly kind: 'managed-execution.completed'
  readonly taskId: string
  readonly itemId: string
  readonly operationId: string
  readonly actionSha256: string
  readonly status: 'success' | 'error'
  readonly result?: string
  readonly durationMs?: number
  readonly completedAt: string
  readonly updatedAt: string
}

/**
 * Immutable outcome-unknown evidence. Nothing in the reducer may rewrite an
 * interrupted operation into a completed or failed one.
 */
export interface ManagedExecutionInterruptedEvent {
  readonly kind: 'managed-execution.interrupted'
  readonly taskId: string
  readonly itemId: string
  readonly operationId: string
  readonly interruptedAt: string
  readonly updatedAt: string
}

/**
 * Outcome-unknown evidence for an execution that predates durable operation
 * claims: state written before markers existed records a running activity with
 * no `managedExecution` at all.
 *
 * It is a separate event from `managed-execution.interrupted` because that one
 * requires an exact `approved`/`started` claim to transition, and none exists
 * here. Recovery must not manufacture one. Deliberately absent are
 * `actionSha256` and `approvalSha256`: no prepared side-effect envelope and no
 * native approval envelope were ever recorded, and a synthesized digest would
 * be indistinguishable from a real one while attesting to nothing. The
 * resulting marker is `claim: 'legacy-untracked'`, which carries neither field.
 *
 * `startedAt` is derived from the activity's own `createdAt` only when that is
 * a strict offset timestamp, and otherwise falls back to `interruptedAt`; both
 * are supplied by the planner so every layer of one recovery stamps the same
 * instant.
 */
export interface ManagedExecutionLegacyInterruptedEvent {
  readonly kind: 'managed-execution.legacy-interrupted'
  readonly taskId: string
  readonly itemId: string
  readonly executionKind: 'workspace-write' | 'command' | 'mcp'
  readonly startedAt: string
  readonly interruptedAt: string
  readonly updatedAt: string
}

/**
 * Every fact the reducer understands. New durable behavior extends this union
 * with a named event rather than introducing a generic state replacement, a
 * JSON-patch escape hatch, or a whole-snapshot mutation.
 */
export type GroundLedgerEvent =
  | LegacyStateBootstrappedEvent
  | SidebarCollapsedSetEvent
  | SelectedTaskSetEvent
  | DefaultProviderSetEvent
  | ProviderUpsertedEvent
  | ProviderSecretTransitionPublishedEvent
  | ProviderDeletedEvent
  | SecretCleanupQueuedEvent
  | SecretCleanupAcknowledgedEvent
  | McpServerSavedEvent
  | McpServerDeletedEvent
  | TaskCreatedEvent
  | TaskForkedEvent
  | TaskImportedEvent
  | TaskDeletedEvent
  | TaskArchivedSetEvent
  | TaskTitleSetEvent
  | TaskProviderSetEvent
  | TaskModeSetEvent
  | TaskWorkspaceSetEvent
  | TaskImportedHistorySetEvent
  | TaskRunStatusSetEvent
  | TaskRuntimeSessionSetEvent
  | TaskModelSessionSetEvent
  | TaskItemAppendedEvent
  | TaskMessageContentSetEvent
  | TaskActivityUpdatedEvent
  | ManagedExecutionStartedEvent
  | ManagedExecutionCompletedEvent
  | ManagedExecutionInterruptedEvent
  | ManagedExecutionLegacyInterruptedEvent

export interface LedgerEventRecord {
  readonly eventSchemaVersion: typeof EVENT_SCHEMA_VERSION
  readonly sequence: number
  readonly transactionId: string
  readonly transactionOrdinal: number
  readonly transactionSize: number
  readonly kind: EventKind
  readonly entityId?: string
  readonly recordedAt: string
  readonly previousEventHash: string
  readonly payloadJson: string
  readonly eventHash: string
}

export interface LedgerHead {
  readonly sequence: number
  readonly eventHash: string
  readonly transactionId: string
  readonly updatedAt: string
}

export interface HeadWitness {
  readonly witnessVersion: typeof HEAD_WITNESS_VERSION
  readonly databaseId: string
  readonly recoveryEpoch: string
  readonly sequence: number
  readonly eventHash: string
  readonly transactionId: string
  readonly publishedAt: string
}

export interface LedgerMetadata {
  readonly databaseFormatVersion: typeof DATABASE_FORMAT_VERSION
  readonly eventSchemaVersion: typeof EVENT_SCHEMA_VERSION
  readonly reducerVersion: typeof REDUCER_VERSION
  readonly projectionSchemaVersion: typeof PROJECTION_SCHEMA_VERSION
  readonly databaseId: string
  readonly recoveryEpoch: string
  readonly createdAt: string
}

export interface MigrationProvenance {
  readonly sourceFormat: 'ground-json'
  readonly sourceStateVersion: 2
  readonly sourceSha256: string
  readonly sourceByteLength: number
  readonly normalizedStateSha256: string
  readonly migratedAt: string
}

export interface AppendEventBatchInput {
  readonly expectedHead: Pick<LedgerHead, 'sequence' | 'eventHash'>
  readonly events: readonly GroundLedgerEvent[]
  readonly transactionId?: string
}

export interface AppendEventBatchResult {
  readonly records: readonly LedgerEventRecord[]
  readonly head: LedgerHead
  readonly projection: PersistedStateData
}

export type EventStoreFaultPoint =
  | 'after-begin'
  | 'before-commit'
  | 'after-commit'
  | 'before-witness-publish'
  | 'after-witness-rename'
  | 'after-create-witness-published'
  | 'after-create-database-published'
  | 'before-create-temporary-cleanup'
  | 'before-backup-database-link'
  | 'after-backup-database-published'
  | 'before-backup-temporary-cleanup'

export interface EventStoreDependencies {
  readonly now?: () => string
  readonly createId?: () => string
  readonly fault?: (point: EventStoreFaultPoint) => void
  readonly witnessStore?: HeadWitnessStore
  readonly onBackupProgress?: (temporaryDatabasePath: string) => void
}

export interface HeadWitnessStore {
  read(filePath: string): Promise<HeadWitness | undefined>
  publish(
    filePath: string,
    witness: HeadWitness,
    options?: {
      readonly beforeRename?: () => void | Promise<void>
      readonly afterRename?: () => void | Promise<void>
      /**
       * Omit for an unconditional forensic/test publication. `null` requires
       * absence; a witness requires an exact current-value match.
       */
      readonly expected?: HeadWitness | null
    }
  ): Promise<void>
}

export interface CreateEventStoreInput {
  readonly databasePath: string
  readonly witnessPath?: string
  readonly bootstrap: LegacyStateBootstrappedEvent
  readonly dependencies?: EventStoreDependencies
}

export interface OpenEventStoreInput {
  readonly databasePath: string
  readonly witnessPath?: string
  readonly dependencies?: EventStoreDependencies
  readonly integrityCheck?: 'quick' | 'full'
}

export interface JsonV2MigrationInput {
  readonly sourceJsonPath: string
  readonly databasePath: string
  /**
   * Required. The SQLite writer lock coordinates ledger writers only, and
   * `StateStore` never acquires it, so without this authority a live store can
   * rewrite the legacy source between the final revalidation and the database
   * hard-link. It is deliberately not optional and has no no-op default.
   */
  readonly gate: LegacySourceMigrationGate
  /**
   * Required. One injected recovery instant used by both the initial selection
   * and the pre-publication revalidation, so two selections of identical bytes
   * produce identical projections.
   */
  readonly interruptedAt: string
  readonly witnessPath?: string
  readonly dependencies?: EventStoreDependencies
  readonly fault?: (point: JsonV2MigrationFaultPoint) => void
}

export type JsonV2MigrationFaultPoint =
  | 'after-source-read'
  | 'after-temporary-created'
  | 'after-temporary-verified'
  | 'after-witness-published'
  | 'after-database-published'
  | 'before-migration-temporary-cleanup'

export interface JsonV2MigrationResult {
  /** SHA-256 of the exact generation that supplied the state. */
  readonly sourceSha256: string
  readonly normalizedStateSha256: string
  /** Byte length of the exact generation that supplied the state. */
  readonly sourceByteLength: number
  readonly head: LedgerHead
  /**
   * Which generation was selected. Bounded main-owned metadata for startup
   * display; it deliberately never reaches the ledger, the projection, or the
   * renderer, and it never carries a filesystem path.
   */
  readonly sourceGeneration: 'primary' | 'retained'
  /** Zero-based retained-generation index when `sourceGeneration` is retained. */
  readonly retainedIndex?: number
  /** How many generations were attempted and found missing or corrupt. */
  readonly unreadableGenerationCount: number
}

/**
 * A migration attempt's outcome.
 *
 * `no-legacy-source` is a normal fresh-install condition, not a failure: there
 * is no truthful legacy source to record, the only bootstrap kind is
 * `legacy-state.bootstrapped`, and no database or witness is created. It is
 * modelled as a result rather than an error so a caller cannot confuse it with
 * unreadable state, which throws.
 */
export type JsonV2MigrationOutcome =
  | ({ readonly outcome: 'migrated' } & JsonV2MigrationResult)
  | { readonly outcome: 'no-legacy-source' }
