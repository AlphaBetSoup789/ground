import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
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
    expect((await lstat(databasePath)).nlink).toBe(1)
    expect((await lstat(`${databasePath}.head.json`)).nlink).toBe(1)
    await store.close()
  })

  it('rejects an external hard link to the legacy JSON source without selecting or changing either name', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const sourceAliasPath = path.join(directory, 'external-state-alias.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    const witnessPath = `${databasePath}.head.json`
    const source = `${JSON.stringify(legacyState(), null, 2)}\n`
    await writeFile(sourcePath, source, { encoding: 'utf8', mode: 0o600 })
    await link(sourcePath, sourceAliasPath)

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toThrow(/multiple hard links/)

    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    expect(await readFile(sourceAliasPath, 'utf8')).toBe(source)
    expect((await lstat(sourcePath)).nlink).toBe(2)
    expect((await lstat(sourceAliasPath)).nlink).toBe(2)
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(lstat(witnessPath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('refuses to use a destination SQLite sidecar as the migration source and preserves it exactly', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const sourcePath = `${databasePath}-wal`
    const source = `${JSON.stringify(legacyState(), null, 2)}\n`
    await writeFile(sourcePath, source, { encoding: 'utf8', mode: 0o600 })

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toBeInstanceOf(EventStoreConflictError)
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects a migration source hard-linked through the destination WAL namespace without changing either link', async () => {
    const directory = await temporaryDirectory()
    const databasePath = path.join(directory, 'ground.sqlite')
    const sourcePath = path.join(directory, 'state.json')
    const reservedWalPath = `${databasePath}-wal`
    const source = `${JSON.stringify(legacyState(), null, 2)}\n`
    await writeFile(sourcePath, source, { encoding: 'utf8', mode: 0o600 })
    await link(sourcePath, reservedWalPath)

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toThrow(/hard-link alias/)
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    expect(await readFile(reservedWalPath, 'utf8')).toBe(source)
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a destination WAL symlink to the migration source before selection and preserves the source',
    async () => {
      const directory = await temporaryDirectory()
      const databasePath = path.join(directory, 'ground.sqlite')
      const sourcePath = path.join(directory, 'state.json')
      const reservedWalPath = `${databasePath}-wal`
      const source = `${JSON.stringify(legacyState(), null, 2)}\n`
      await writeFile(sourcePath, source, {
        encoding: 'utf8',
        mode: 0o600
      })
      await symlink(sourcePath, reservedWalPath)

      await expect(
        migrateJsonV2ToSqlite({
          sourceJsonPath: sourcePath,
          databasePath
        })
      ).rejects.toThrow(/symbolic or non-regular/)
      expect(await readFile(sourcePath, 'utf8')).toBe(source)
      expect((await lstat(reservedWalPath)).isSymbolicLink()).toBe(true)
      await expect(lstat(databasePath)).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  )

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

  it('removes every temporary SQLite database, sidecar, and coordination file after a pre-publication failure', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeFile(sourcePath, JSON.stringify(legacyState()), {
      encoding: 'utf8',
      mode: 0o600
    })

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath,
        fault: (point) => {
          if (point === 'after-temporary-created') {
            throw new Error('stop after temporary creation')
          }
        }
      })
    ).rejects.toBeInstanceOf(JsonV2MigrationError)
    expect((await readdir(directory)).sort()).toEqual(['state.json'])
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

  it('reports a post-selection migration-cleanup failure as persistence uncertainty after still cleaning temporary files', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeFile(sourcePath, JSON.stringify(legacyState()), {
      encoding: 'utf8',
      mode: 0o600
    })

    await expect(
      migrateJsonV2ToSqlite({
        sourceJsonPath: sourcePath,
        databasePath,
        fault: (point) => {
          if (point === 'before-migration-temporary-cleanup') {
            throw new Error('injected migration cleanup failure')
          }
        }
      })
    ).rejects.toBeInstanceOf(EventStorePersistenceUncertainError)
    expect(
      (await readdir(directory)).filter(
        (entry) =>
          entry.startsWith('.ground.sqlite.') ||
          entry.includes('.migration.sqlite')
      )
    ).toEqual([])

    const selected = await SqliteEventStore.open({
      databasePath,
      integrityCheck: 'full'
    })
    expect(selected.getProjection()).toEqual(legacyState())
    await selected.close()
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
    ).rejects.toThrow(/symbolic or non-regular/)
  })
})
