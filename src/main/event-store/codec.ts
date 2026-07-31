import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  CURRENT_PERSISTED_STATE_VERSION,
  parsePersistedState,
  type PersistedStateData
} from '../state-schema'
import {
  encodeCanonicalJson,
  parseCanonicalJson,
  type CanonicalJsonValue
} from './canonical-json'
import {
  EventCodecError,
  EventStoreCorruptionError,
  EventStoreVersionError
} from './errors'
import {
  EVENT_SCHEMA_VERSION,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_PROJECTION_BYTES,
  PROJECTION_SCHEMA_VERSION,
  REDUCER_VERSION,
  type EventKind,
  type GroundLedgerEvent,
  type LedgerEventRecord
} from './types'

const identifierSchema = z.string().min(1).max(200)
const timestampSchema = z.iso.datetime({ offset: true })
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const positiveBoundedIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

const bootstrapPayloadSchema = z
  .object({
    sourceFormat: z.literal('ground-json'),
    sourceStateVersion: z.literal(CURRENT_PERSISTED_STATE_VERSION),
    sourceSha256: sha256Schema,
    sourceByteLength: positiveBoundedIntegerSchema.max(
      MAX_PROJECTION_BYTES
    ),
    normalizedStateSha256: sha256Schema,
    state: z.unknown()
  })
  .strict()

const sidebarCollapsedPayloadSchema = z
  .object({
    collapsed: z.boolean()
  })
  .strict()

const databaseEventRowSchema = z
  .object({
    event_schema_version: z.number().int(),
    sequence: positiveBoundedIntegerSchema,
    transaction_id: identifierSchema,
    transaction_ordinal: positiveBoundedIntegerSchema,
    transaction_size: positiveBoundedIntegerSchema,
    kind: z.string().min(1).max(200),
    entity_id: z.union([identifierSchema, z.null()]),
    recorded_at: timestampSchema,
    previous_event_hash: sha256Schema,
    payload_json: z.string(),
    event_hash: sha256Schema
  })
  .strict()

export interface EncodedLedgerEvent {
  readonly event: GroundLedgerEvent
  readonly kind: EventKind
  readonly entityId?: string
  readonly payloadJson: string
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function encodeProjection(state: PersistedStateData): {
  readonly state: PersistedStateData
  readonly stateJson: string
  readonly stateSha256: string
} {
  assertExactPersistedStateVersion(state)
  const normalized = parsePersistedState(state)
  const stateJson = encodeCanonicalJson(normalized, {
    maxBytes: MAX_PROJECTION_BYTES
  })
  return {
    state: normalized,
    stateJson,
    stateSha256: sha256(stateJson)
  }
}

export function decodeProjection(
  stateJson: string,
  stateSha256: string,
  versions: {
    readonly reducerVersion: number
    readonly projectionSchemaVersion: number
  }
): PersistedStateData {
  if (versions.reducerVersion !== REDUCER_VERSION) {
    throw new EventStoreVersionError(
      'reducer',
      `Unsupported reducer version ${versions.reducerVersion}`
    )
  }
  if (versions.projectionSchemaVersion !== PROJECTION_SCHEMA_VERSION) {
    throw new EventStoreVersionError(
      'projection',
      `Unsupported projection schema version ${versions.projectionSchemaVersion}`
    )
  }
  if (Buffer.byteLength(stateJson, 'utf8') > MAX_PROJECTION_BYTES) {
    throw new EventStoreCorruptionError(
      'Materialized projection exceeds its byte limit'
    )
  }
  if (sha256(stateJson) !== stateSha256) {
    throw new EventStoreCorruptionError(
      'Materialized projection hash does not match its canonical bytes'
    )
  }

  const parsed = parseCanonicalJson(stateJson, {
    maxBytes: MAX_PROJECTION_BYTES
  })
  assertExactPersistedStateVersion(parsed)
  try {
    return parsePersistedState(parsed)
  } catch (error) {
    throw new EventStoreCorruptionError(
      'Materialized projection failed state-schema validation',
      { cause: error }
    )
  }
}

export function encodeLedgerEvent(event: GroundLedgerEvent): EncodedLedgerEvent {
  switch (event.kind) {
    case 'legacy-state.bootstrapped': {
      const normalized = parseBootstrapEvent(event)
      const {
        kind: _kind,
        state,
        normalizedStateSha256,
        ...source
      } = normalized
      const encodedState = encodeProjection(state)
      if (encodedState.stateSha256 !== normalizedStateSha256) {
        throw new EventCodecError(
          'Bootstrap normalized-state hash does not match its state'
        )
      }
      return {
        event: normalized,
        kind: normalized.kind,
        payloadJson: encodeCanonicalJson(
          {
            ...source,
            normalizedStateSha256,
            state: encodedState.state
          },
          { maxBytes: MAX_EVENT_PAYLOAD_BYTES }
        )
      }
    }
    case 'settings.sidebar-collapsed-set': {
      const parsed = sidebarCollapsedPayloadSchema.safeParse({
        collapsed: event.collapsed
      })
      if (!parsed.success) {
        throw new EventCodecError(
          'Sidebar-collapse event failed schema validation',
          { cause: parsed.error }
        )
      }
      return {
        event: {
          kind: event.kind,
          collapsed: parsed.data.collapsed
        },
        kind: event.kind,
        entityId: 'settings',
        payloadJson: encodeCanonicalJson(parsed.data, {
          maxBytes: MAX_EVENT_PAYLOAD_BYTES
        })
      }
    }
    default: {
      const neverEvent: never = event
      throw new EventCodecError(
        `Unsupported ledger event kind ${String(
          (neverEvent as { kind?: unknown }).kind
        )}`
      )
    }
  }
}

export function decodeLedgerEvent(
  kind: string,
  entityId: string | undefined,
  payloadJson: string
): GroundLedgerEvent {
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new EventStoreCorruptionError(
      'Ledger event payload exceeds its byte limit'
    )
  }

  let payload: CanonicalJsonValue
  try {
    payload = parseCanonicalJson(payloadJson, {
      maxBytes: MAX_EVENT_PAYLOAD_BYTES
    })
  } catch (error) {
    throw new EventStoreCorruptionError(
      'Ledger event payload is not canonical JSON',
      { cause: error }
    )
  }

  switch (kind) {
    case 'legacy-state.bootstrapped': {
      if (entityId !== undefined) {
        throw new EventStoreCorruptionError(
          'Bootstrap event must not have an entity ID'
        )
      }
      return parseBootstrapEvent({ kind, ...(payload as object) })
    }
    case 'settings.sidebar-collapsed-set': {
      if (entityId !== 'settings') {
        throw new EventStoreCorruptionError(
          'Sidebar-collapse event has the wrong entity ID'
        )
      }
      const parsed = sidebarCollapsedPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        throw new EventStoreCorruptionError(
          'Sidebar-collapse event payload failed schema validation',
          { cause: parsed.error }
        )
      }
      return { kind, collapsed: parsed.data.collapsed }
    }
    default:
      throw new EventStoreVersionError(
        'event',
        `Unsupported ledger event kind ${kind}`
      )
  }
}

export function hashLedgerEventRecord(
  record: Omit<LedgerEventRecord, 'eventHash'>
): string {
  const payload = parseCanonicalJson(record.payloadJson, {
    maxBytes: MAX_EVENT_PAYLOAD_BYTES
  })
  return sha256(
    encodeCanonicalJson(
      {
        entityId: record.entityId ?? null,
        eventSchemaVersion: record.eventSchemaVersion,
        kind: record.kind,
        payload,
        previousEventHash: record.previousEventHash,
        recordedAt: record.recordedAt,
        sequence: record.sequence,
        transactionId: record.transactionId,
        transactionOrdinal: record.transactionOrdinal,
        transactionSize: record.transactionSize
      },
      { maxBytes: MAX_EVENT_PAYLOAD_BYTES + 4_096 }
    )
  )
}

export function parseLedgerEventRecord(value: unknown): {
  readonly record: LedgerEventRecord
  readonly event: GroundLedgerEvent
} {
  const parsed = databaseEventRowSchema.safeParse(value)
  if (!parsed.success) {
    throw new EventStoreCorruptionError(
      'Ledger event row failed schema validation',
      { cause: parsed.error }
    )
  }
  if (parsed.data.event_schema_version !== EVENT_SCHEMA_VERSION) {
    throw new EventStoreVersionError(
      'event',
      `Unsupported event schema version ${parsed.data.event_schema_version}`
    )
  }
  if (parsed.data.transaction_ordinal > parsed.data.transaction_size) {
    throw new EventStoreCorruptionError(
      'Ledger event transaction ordinal exceeds its batch size'
    )
  }

  const record: LedgerEventRecord = {
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    sequence: parsed.data.sequence,
    transactionId: parsed.data.transaction_id,
    transactionOrdinal: parsed.data.transaction_ordinal,
    transactionSize: parsed.data.transaction_size,
    kind: parsed.data.kind as EventKind,
    entityId: parsed.data.entity_id ?? undefined,
    recordedAt: parsed.data.recorded_at,
    previousEventHash: parsed.data.previous_event_hash,
    payloadJson: parsed.data.payload_json,
    eventHash: parsed.data.event_hash
  }
  const { eventHash: _eventHash, ...withoutHash } = record
  const expectedHash = hashLedgerEventRecord(withoutHash)
  if (expectedHash !== record.eventHash) {
    throw new EventStoreCorruptionError(
      `Ledger event ${record.sequence} hash mismatch`
    )
  }

  return {
    record,
    event: decodeLedgerEvent(
      parsed.data.kind,
      parsed.data.entity_id ?? undefined,
      parsed.data.payload_json
    )
  }
}

function parseBootstrapEvent(value: unknown): LegacyStateBootstrappedEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventCodecError('Bootstrap event must be an object')
  }
  const { kind, ...payload } = value as Record<string, unknown>
  if (kind !== 'legacy-state.bootstrapped') {
    throw new EventCodecError('Bootstrap event kind is invalid')
  }
  const parsed = bootstrapPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new EventCodecError(
      'Bootstrap event failed schema validation',
      { cause: parsed.error }
    )
  }

  assertExactPersistedStateVersion(parsed.data.state)
  let state: PersistedStateData
  try {
    state = parsePersistedState(parsed.data.state)
  } catch (error) {
    throw new EventCodecError(
      'Bootstrap state failed persisted-state validation',
      { cause: error }
    )
  }

  return {
    kind: 'legacy-state.bootstrapped',
    sourceFormat: 'ground-json',
    sourceStateVersion: CURRENT_PERSISTED_STATE_VERSION,
    sourceSha256: parsed.data.sourceSha256,
    sourceByteLength: parsed.data.sourceByteLength,
    normalizedStateSha256: parsed.data.normalizedStateSha256,
    state
  }
}

function assertExactPersistedStateVersion(
  value: unknown
): asserts value is PersistedStateData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventStoreVersionError(
      'projection',
      'Persisted state is missing its exact version'
    )
  }
  const version = (value as { version?: unknown }).version
  if (version !== CURRENT_PERSISTED_STATE_VERSION) {
    throw new EventStoreVersionError(
      'projection',
      `Unsupported persisted-state projection version ${String(version)}`
    )
  }
}

type LegacyStateBootstrappedEvent = Extract<
  GroundLedgerEvent,
  { kind: 'legacy-state.bootstrapped' }
>
