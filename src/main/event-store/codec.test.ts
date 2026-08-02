import { describe, expect, it } from 'vitest'
import type { GroundLedgerEvent } from './types'
import {
  decodeLedgerEvent,
  encodeLedgerEvent,
  EventCodecError,
  EventStoreCorruptionError,
  EventStoreVersionError
} from './index'

/**
 * Names that resolve to truthy values through `Object.prototype`. A registry
 * lookup guarded only by truthiness would hand back an inherited value and die
 * on `codec.schema` with a TypeError, skipping the boundary's typed error.
 */
const INHERITED_KEYS = ['constructor', 'toString', '__proto__'] as const

describe('ledger event codec', () => {
  it('fails closed on an unknown semantic event kind', () => {
    let error: unknown
    try {
      decodeLedgerEvent('future.event', undefined, '{}')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EventStoreVersionError)
    expect((error as EventStoreVersionError).boundary).toBe('event')
  })

  it.each(INHERITED_KEYS)(
    'refuses %s as a decoded event kind rather than inheriting a codec',
    (kind) => {
      let error: unknown
      try {
        decodeLedgerEvent(kind, undefined, '{}')
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(EventStoreVersionError)
      expect((error as EventStoreVersionError).boundary).toBe('event')
      expect((error as Error).message).toContain(
        `Unsupported ledger event kind ${kind}`
      )
    }
  )

  it.each(INHERITED_KEYS)(
    'refuses %s as an encoded event kind rather than inheriting a codec',
    (kind) => {
      let error: unknown
      try {
        encodeLedgerEvent({ kind } as unknown as GroundLedgerEvent)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(EventCodecError)
      expect((error as Error).message).toContain(
        `Unsupported ledger event kind ${kind}`
      )
    }
  )

  it('refuses non-canonical payload bytes before reduction', () => {
    expect(() =>
      decodeLedgerEvent(
        'settings.sidebar-collapsed-set',
        'settings',
        '{ "collapsed": true }'
      )
    ).toThrow(EventStoreCorruptionError)
  })
})
