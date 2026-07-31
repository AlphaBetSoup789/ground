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

/**
 * The first engine slice deliberately exposes only semantic facts that its
 * reducer understands. Later task/run/approval facts extend this union rather
 * than introducing a generic state replacement or JSON-patch escape hatch.
 */
export type GroundLedgerEvent =
  | LegacyStateBootstrappedEvent
  | SidebarCollapsedSetEvent

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
  readonly sourceSha256: string
  readonly normalizedStateSha256: string
  readonly sourceByteLength: number
  readonly head: LedgerHead
}
