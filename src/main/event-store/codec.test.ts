import { describe, expect, it } from 'vitest'
import {
  decodeLedgerEvent,
  EventStoreCorruptionError,
  EventStoreVersionError
} from './index'

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
