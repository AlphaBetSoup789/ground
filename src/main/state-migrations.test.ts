import { describe, expect, it } from 'vitest'
import {
  migrateStateDocument,
  type StateMigration
} from './state-migrations'

describe('state migration dispatcher', () => {
  it('applies every registered migration without mutating the source', () => {
    const source = {
      version: 1,
      settings: { sidebarCollapsed: false }
    }
    const migrations = new Map<number, StateMigration>([
      [
        1,
        (document) => ({
          ...document,
          version: 2,
          providers: []
        })
      ],
      [
        2,
        (document) => ({
          ...document,
          version: 3,
          mcpServers: []
        })
      ]
    ])

    expect(
      migrateStateDocument(source, {
        currentVersion: 3,
        migrations
      })
    ).toEqual({
      version: 3,
      settings: { sidebarCollapsed: false },
      providers: [],
      mcpServers: []
    })
    expect(source).toEqual({
      version: 1,
      settings: { sidebarCollapsed: false }
    })
  })

  it('accepts the current version without requiring a migration', () => {
    expect(
      migrateStateDocument(
        { version: 2, tasks: [] },
        { currentVersion: 2, migrations: new Map() }
      )
    ).toEqual({ version: 2, tasks: [] })
  })

  it('fails closed for future, missing, and version-skipping migrations', () => {
    expect(() =>
      migrateStateDocument(
        { version: 3 },
        { currentVersion: 2, migrations: new Map() }
      )
    ).toThrow(/newer/i)
    expect(() =>
      migrateStateDocument(
        { version: 1 },
        { currentVersion: 2, migrations: new Map() }
      )
    ).toThrow(/no persisted state migration/i)
    expect(() =>
      migrateStateDocument(
        { version: 1 },
        {
          currentVersion: 3,
          migrations: new Map([
            [1, () => ({ version: 3 })]
          ])
        }
      )
    ).toThrow(/must produce version 2/i)
  })

  it.each([
    null,
    [],
    { version: 0 },
    { version: 1.5 },
    { version: '1' }
  ])('rejects malformed version envelopes %#', (value) => {
    expect(() =>
      migrateStateDocument(value, {
        currentVersion: 2,
        migrations: new Map()
      })
    ).toThrow()
  })
})
