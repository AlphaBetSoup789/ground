import {
  parsePersistedState,
  type PersistedStateData
} from '../state-schema'
import { encodeProjection } from './codec'
import { EventStoreCorruptionError } from './errors'
import type {
  GroundLedgerEvent,
  LedgerEventRecord
} from './types'

export interface DecodedLedgerRecord {
  readonly record: LedgerEventRecord
  readonly event: GroundLedgerEvent
}

export function reduceLedgerEvent(
  current: PersistedStateData | undefined,
  event: GroundLedgerEvent,
  sequence: number
): PersistedStateData {
  switch (event.kind) {
    case 'legacy-state.bootstrapped': {
      if (current || sequence !== 1) {
        throw new EventStoreCorruptionError(
          'Legacy-state bootstrap must be the first and only bootstrap event'
        )
      }
      const encoded = encodeProjection(event.state)
      if (encoded.stateSha256 !== event.normalizedStateSha256) {
        throw new EventStoreCorruptionError(
          'Legacy-state bootstrap projection hash is invalid'
        )
      }
      return encoded.state
    }
    case 'settings.sidebar-collapsed-set': {
      if (!current) {
        throw new EventStoreCorruptionError(
          'Settings event appeared before the semantic bootstrap'
        )
      }
      return parsePersistedState({
        ...current,
        settings: {
          ...current.settings,
          sidebarCollapsed: event.collapsed
        }
      })
    }
    default: {
      const neverEvent: never = event
      throw new EventStoreCorruptionError(
        `Reducer does not support event ${String(
          (neverEvent as { kind?: unknown }).kind
        )}`
      )
    }
  }
}

export function replayLedger(
  records: readonly DecodedLedgerRecord[]
): PersistedStateData {
  let state: PersistedStateData | undefined
  for (const { record, event } of records) {
    state = reduceLedgerEvent(state, event, record.sequence)
  }
  if (!state) {
    throw new EventStoreCorruptionError(
      'Ledger has no semantic bootstrap projection'
    )
  }
  return state
}

export function replayLedgerDeterministically(
  records: readonly DecodedLedgerRecord[]
): {
  readonly state: PersistedStateData
  readonly stateJson: string
  readonly stateSha256: string
} {
  const first = encodeProjection(replayLedger(records))
  const second = encodeProjection(replayLedger(records))
  if (
    first.stateJson !== second.stateJson ||
    first.stateSha256 !== second.stateSha256
  ) {
    throw new EventStoreCorruptionError(
      'Ledger reducer did not rebuild deterministic canonical bytes'
    )
  }
  return first
}
