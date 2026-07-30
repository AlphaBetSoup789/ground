import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedStateData } from '../state-schema'
import {
  EventStoreConflictError,
  EventStorePersistenceUncertainError,
  JsonV2MigrationError,
  migrateJsonV2ToSqlite,
  SqliteEventStore
} from './index'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ground-json-migration-')
  )
  temporaryDirectories.push(directory)
  return directory
}

function legacyState(): PersistedStateData {
  const timestamp = '2026-07-30T20:00:00.000Z'
  return {
    version: 2,
    providers: [
      {
        id: 'provider_local',
        name: 'Local',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'test-model',
        hasApiKey: false,
        supportsTools: true,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    mcpServers: [],
    tasks: [],
    settings: {
      defaultProviderId: 'provider_local',
      sidebarCollapsed: true
    },
    pendingSecretDeletes: ['opaque-live-cleanup-reference']
  }
}

describe('JSON v2 copy-on-migrate', () => {
  it('publishes a verified SQLite database while preserving exact source bytes', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    const source = `${JSON.stringify(legacyState(), null, 2)}\n`
    await writeFile(sourcePath, source, { encoding: 'utf8', mode: 0o600 })

    const result = await migrateJsonV2ToSqlite({
      sourceJsonPath: sourcePath,
      databasePath
    })
    expect(result.head.sequence).toBe(1)
    expect(await readFile(sourcePath, 'utf8')).toBe(source)

    const store = await SqliteEventStore.open({
      databasePath,
      integrityCheck: 'full'
    })
    expect(store.getProjection()).toEqual(legacyState())
    expect(store.getMigrationProvenance()).toMatchObject({
      sourceStateVersion: 2,
      sourceByteLength: Buffer.byteLength(source),
      sourceSha256: result.sourceSha256,
      normalizedStateSha256: result.normalizedStateSha256
    })
    if (process.platform !== 'win32') {
      expect((await lstat(databasePath)).mode & 0o777).toBe(0o600)
      expect(
        (await lstat(`${databasePath}.head.json`)).mode & 0o777
      ).toBe(0o600)
    }
    await store.close()
  })

  it('can retry after a pre-selection witness publication fault', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    const source = JSON.stringify(legacyState())
    await writeFile(sourcePath, source, { encoding: 'utf8', mode: 0o600 })

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath,
        fault: (point) => {
          if (point === 'after-witness-published') {
            throw new Error('stop before database selection')
          }
        }
      })
    ).rejects.toBeInstanceOf(JsonV2MigrationError)
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(sourcePath, 'utf8')).toBe(source)

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).resolves.toMatchObject({ head: { sequence: 1 } })
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
  })

  it('leaves a published selected database fail-closed after a post-publication fault', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    const source = JSON.stringify(legacyState())
    await writeFile(sourcePath, source, { encoding: 'utf8', mode: 0o600 })

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath,
        fault: (point) => {
          if (point === 'after-database-published') {
            throw new Error('stop after database selection')
          }
        }
      })
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    expect(await readFile(sourcePath, 'utf8')).toBe(source)

    const selected = await SqliteEventStore.open({ databasePath })
    expect(selected.getProjection()).toEqual(legacyState())
    await selected.close()
    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toBeInstanceOf(EventStoreConflictError)
  })

  it('fails closed on future, skipped, and malformed source versions', async () => {
    const directory = await temporaryDirectory()
    for (const version of [1, 3, 99]) {
      const sourcePath = path.join(directory, `state-${version}.json`)
      const databasePath = path.join(directory, `ground-${version}.sqlite`)
      await writeFile(
        sourcePath,
        JSON.stringify({ ...legacyState(), version }),
        { encoding: 'utf8', mode: 0o600 }
      )
      await expect(
        migrateJsonV2ToSqlite({
          sourceJsonPath: sourcePath,
          databasePath
        })
      ).rejects.toThrow(/exact JSON state version 2/)
      await expect(lstat(databasePath)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  })

  it('refuses a symlinked legacy source', async () => {
    if (process.platform === 'win32') return
    const directory = await temporaryDirectory()
    const realSource = path.join(directory, 'real-state.json')
    const linkedSource = path.join(directory, 'linked-state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeFile(realSource, JSON.stringify(legacyState()), {
      encoding: 'utf8',
      mode: 0o600
    })
    await symlink(realSource, linkedSource)

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: linkedSource,
        databasePath
      })
    ).rejects.toThrow(/not a regular file/)
  })
})
