import { describe, expect, it, vi } from 'vitest'
import type { LocalStateSnapshot } from '../../../shared/types'

vi.mock('../lib/desktop', () => ({ desktop: {} }))

import {
  formatSnapshotBytes,
  snapshotTitle
} from './RecoverySettingsPane'

const retained: LocalStateSnapshot = {
  id: 'state_snapshot_12345678-1234-4123-8123-123456789abc',
  kind: 'retained',
  generation: 2,
  status: 'valid'
}

describe('RecoverySettingsPane presentation', () => {
  it('labels current and retained generations without exposing IDs', () => {
    expect(snapshotTitle(retained)).toBe('Retained snapshot 2')
    expect(
      snapshotTitle({ ...retained, kind: 'current', generation: 0 })
    ).toBe('Current state')
    expect(snapshotTitle(retained)).not.toContain(retained.id)
  })

  it('formats bounded byte counts for snapshot metadata', () => {
    expect(formatSnapshotBytes(512)).toBe('512 B')
    expect(formatSnapshotBytes(1_536)).toBe('1.5 KB')
    expect(formatSnapshotBytes(2 * 1_024 * 1_024)).toBe('2.0 MB')
  })
})
