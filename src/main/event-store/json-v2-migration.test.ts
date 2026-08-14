import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
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
import {
  createExclusiveLegacySourceMigrationGate
} from '../legacy-state-recovery'
import { PersistedStateVersionError } from '../state-migrations'
import type { PersistedStateData } from '../state-schema'
import {
  EventStoreCorruptionError,
  EventStoreConflictError,
  EventStoreVersionError,
  EventStorePersistenceUncertainError,
  JsonV2MigrationError,
  migrateJsonV2ToSqlite,
  SqliteEventStore
} from './index'

const INTERRUPTED_AT = '2026-08-12T00:00:00.000Z'

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

/**
 * Required migration authority plus the injected recovery instant. Both are
 * mandatory inputs, so every call site supplies them explicitly.
 */
function migrationAuthority() {
  return {
    gate: createExclusiveLegacySourceMigrationGate(),
    interruptedAt: INTERRUPTED_AT
  }
}

/** Narrow a migration outcome to its successful shape. */
function migrated(
  outcome: Awaited<ReturnType<typeof migrateJsonV2ToSqlite>>
) {
  if (outcome.outcome !== 'migrated') {
    throw new Error(`Expected a migrated outcome, received ${outcome.outcome}`)
  }
  return outcome
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

function legacyStateWithRunningTask(): PersistedStateData {
  const timestamp = '2026-07-30T20:00:00.000Z'
  const state = legacyState()
  state.tasks = [
    {
      id: 'task_active',
      title: 'Active task',
      providerId: 'provider_local',
      mode: 'agent',
      runStatus: 'running',
      items: [
        {
          id: 'activity_running',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Reading files',
          status: 'running',
          createdAt: timestamp
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ]
  return state
}

async function writeGeneration(
  filePath: string,
  state: PersistedStateData | string
): Promise<string> {
  const payload =
    typeof state === 'string' ? state : `${JSON.stringify(state, null, 2)}\n`
  await writeFile(filePath, payload, { encoding: 'utf8', mode: 0o600 })
  return payload
}

describe('JSON v2 copy-on-migrate', () => {
  it('publishes a verified SQLite database while preserving exact source bytes', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    const source = `${JSON.stringify(legacyState(), null, 2)}\n`
    await writeFile(sourcePath, source, { encoding: 'utf8', mode: 0o600 })

    const result = migrated(await migrateJsonV2ToSqlite({
      ...migrationAuthority(),
      sourceJsonPath: sourcePath,
      databasePath
    }))
    expect(result.head.sequence).toBe(1)
    expect(result.sourceGeneration).toBe('primary')
    expect(result.retainedIndex).toBeUndefined()
    expect(result.unreadableGenerationCount).toBe(0)
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
        ...migrationAuthority(),
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
        ...migrationAuthority(),
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
        ...migrationAuthority(),
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
          ...migrationAuthority(),
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
        ...migrationAuthority(),
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
        ...migrationAuthority(),
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
        ...migrationAuthority(),
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
        ...migrationAuthority(),
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
        ...migrationAuthority(),
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
        ...migrationAuthority(),
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
          ...migrationAuthority(),
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
        ...migrationAuthority(),
        sourceJsonPath: linkedSource,
        databasePath
      })
    ).rejects.toThrow(/symbolic or non-regular/)
  })
})

describe('JSON v2 copy-on-migrate generation recovery', () => {
  it('migrates the newest valid retained generation and hashes that exact file', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    const corruptPrimary = '{ not json'
    await writeGeneration(sourcePath, corruptPrimary)
    const backupPayload = await writeGeneration(
      `${sourcePath}.bak`,
      legacyState()
    )

    const result = migrated(
      await migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath
      })
    )

    expect(result.sourceGeneration).toBe('retained')
    expect(result.retainedIndex).toBe(0)
    expect(result.unreadableGenerationCount).toBe(1)
    // The digest must describe the backup that supplied the state, never the
    // corrupt primary that did not.
    expect(result.sourceByteLength).toBe(Buffer.byteLength(backupPayload))
    expect(result.sourceSha256).toBe(
      createHash('sha256').update(backupPayload).digest('hex')
    )
    expect(result.sourceSha256).not.toBe(
      createHash('sha256').update(corruptPrimary).digest('hex')
    )

    const store = await SqliteEventStore.open({
      databasePath,
      integrityCheck: 'full'
    })
    expect(store.getMigrationProvenance()).toMatchObject({
      sourceStateVersion: 2,
      sourceSha256: result.sourceSha256,
      sourceByteLength: Buffer.byteLength(backupPayload)
    })
    await store.close()

    // Neither legacy generation may be modified, rotated, or quarantined.
    expect(await readFile(sourcePath, 'utf8')).toBe(corruptPrimary)
    expect(await readFile(`${sourcePath}.bak`, 'utf8')).toBe(backupPayload)
  })

  it('skips a corrupt newest backup and selects an older valid generation', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, '{ not json')
    await writeGeneration(`${sourcePath}.bak`, 'also not json')
    const olderPayload = await writeGeneration(
      `${sourcePath}.bak.2`,
      legacyState()
    )

    const result = migrated(
      await migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath
      })
    )

    expect(result.sourceGeneration).toBe('retained')
    expect(result.retainedIndex).toBe(1)
    expect(result.unreadableGenerationCount).toBe(2)
    expect(result.sourceSha256).toBe(
      createHash('sha256').update(olderPayload).digest('hex')
    )
  })

  it('applies interrupted-run recovery before constructing the bootstrap projection', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, legacyStateWithRunningTask())

    await migrateJsonV2ToSqlite({
      ...migrationAuthority(),
      sourceJsonPath: sourcePath,
      databasePath
    })

    const store = await SqliteEventStore.open({
      databasePath,
      integrityCheck: 'full'
    })
    const task = store.getProjection().tasks[0]!
    expect(task.runStatus).toBe('failed')
    expect(task.updatedAt).toBe(INTERRUPTED_AT)
    expect(
      task.items.some(
        (item) => item.kind === 'activity' && item.status === 'running'
      )
    ).toBe(false)
    expect(
      task.items.some(
        (item) => item.kind === 'activity' && item.title === 'Run interrupted'
      )
    ).toBe(true)
    await store.close()
  })

  it('creates no database, witness, or bootstrap when no generation exists', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')

    const outcome = await migrateJsonV2ToSqlite({
      ...migrationAuthority(),
      sourceJsonPath: sourcePath,
      databasePath
    })

    expect(outcome.outcome).toBe('no-legacy-source')
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      lstat(`${databasePath}.head.json`)
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(directory)).toEqual([])
  })

  it('refuses to publish when every existing generation is unreadable', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, '{ not json')
    await writeGeneration(`${sourcePath}.bak`, 'also not json')

    // Corrupt-all must fail visibly. If it returned no-legacy-source, a later
    // startup could read it as permission to initialize empty SQLite state.
    await expect(
      migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toBeInstanceOf(EventStoreCorruptionError)

    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(sourcePath, 'utf8')).toBe('{ not json')
  })

  it('rejects a non-v2 primary without falling through to a v2 backup', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, {
      ...legacyState(),
      version: 9
    } as unknown as PersistedStateData)
    const backupPayload = await writeGeneration(
      `${sourcePath}.bak`,
      legacyState()
    )

    await expect(
      migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toBeInstanceOf(EventStoreVersionError)

    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('falls back from a malformed-version primary to a valid v2 backup', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    // A version field that is not a usable version number is damage, not a
    // version this reader declines. It must not block recovery.
    await writeGeneration(sourcePath, {
      ...legacyState(),
      version: 'two'
    } as unknown as PersistedStateData)
    const backupPayload = await writeGeneration(
      `${sourcePath}.bak`,
      legacyState()
    )

    const result = migrated(
      await migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath
      })
    )

    expect(result.sourceGeneration).toBe('retained')
    expect(result.retainedIndex).toBe(0)
    expect(result.sourceSha256).toBe(
      createHash('sha256').update(backupPayload).digest('hex')
    )
  })

  it.each([
    { label: 'a missing version', document: {} },
    { label: 'a fractional version', document: { version: 2.5 } },
    { label: 'a zero version', document: { version: 0 } },
    { label: 'a negative version', document: { version: -2 } },
    { label: 'a non-finite version', document: { version: 'NaN' } },
    { label: 'a JSON array', document: [] },
    { label: 'a JSON scalar', document: 42 }
  ])(
    'treats $label as corruption that may fall through',
    async ({ document }) => {
      const directory = await temporaryDirectory()
      const sourcePath = path.join(directory, 'state.json')
      const databasePath = path.join(directory, 'ground.sqlite')
      await writeGeneration(
        sourcePath,
        document as unknown as PersistedStateData
      )
      await writeGeneration(`${sourcePath}.bak`, legacyState())

      const result = migrated(
        await migrateJsonV2ToSqlite({
          ...migrationAuthority(),
          sourceJsonPath: sourcePath,
          databasePath
        })
      )
      expect(result.sourceGeneration).toBe('retained')
    }
  )

  it('rejects a version-1 primary that StateStore would migrate', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, {
      ...legacyState(),
      version: 1
    } as unknown as PersistedStateData)
    await writeGeneration(`${sourcePath}.bak`, legacyState())

    // The bootstrap event records sourceStateVersion as exactly 2 while
    // sourceSha256 hashes the selected file, so migrating a v1 document would
    // make those two fields describe different things.
    await expect(
      migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toBeInstanceOf(EventStoreVersionError)
    // v1 is a version decision, so no backup fallback follows it either.
    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('leaves legacy file metadata untouched on success', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    const payload = await writeGeneration(sourcePath, legacyState())
    const before = await lstat(sourcePath)

    await migrateJsonV2ToSqlite({
      ...migrationAuthority(),
      sourceJsonPath: sourcePath,
      databasePath
    })

    const after = await lstat(sourcePath)
    expect(await readFile(sourcePath, 'utf8')).toBe(payload)
    expect(after.mode).toBe(before.mode)
    expect(after.size).toBe(before.size)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.nlink).toBe(1)
  })

  it('detects a selection change between construction and publication', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, '{ not json')
    await writeGeneration(`${sourcePath}.bak`, legacyState())

    await expect(
      migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath,
        fault: (point) => {
          if (point !== 'after-temporary-verified') return
          // The primary becomes valid, so the migration would otherwise publish
          // a snapshot selected from the now-stale backup.
          writeFileSync(
            sourcePath,
            `${JSON.stringify(legacyState(), null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600 }
          )
        }
      })
    ).rejects.toThrow(/changed during migration/)

    await expect(lstat(databasePath)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('detects selected backup contents changing before publication', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, '{ not json')
    await writeGeneration(`${sourcePath}.bak`, legacyState())

    await expect(
      migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath,
        fault: (point) => {
          if (point !== 'after-temporary-verified') return
          const mutated = legacyState()
          mutated.settings.sidebarCollapsed = false
          writeFileSync(
            `${sourcePath}.bak`,
            `${JSON.stringify(mutated, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600 }
          )
        }
      })
    ).rejects.toThrow(/changed during migration/)
  })

  it('detects a source change made before the exclusive scope opens', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, legacyState())

    const gate = createExclusiveLegacySourceMigrationGate()
    const mutated = legacyState()
    mutated.settings.sidebarCollapsed = false
    const mutatedPayload = `${JSON.stringify(mutated, null, 2)}\n`
    await writeFile(sourcePath, mutatedPayload, {
      encoding: 'utf8',
      mode: 0o600
    })

    const result = migrated(
      await migrateJsonV2ToSqlite({
        gate,
        interruptedAt: INTERRUPTED_AT,
        sourceJsonPath: sourcePath,
        databasePath
      })
    )

    // Selection runs inside the scope, so the pre-exclusive write is simply the
    // state that gets migrated - consistently, and with its own digest.
    expect(result.sourceSha256).toBe(
      createHash('sha256').update(mutatedPayload).digest('hex')
    )
  })

  it('requires a migration gate and a bounded recovery timestamp', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, legacyState())

    await expect(
      migrateJsonV2ToSqlite({
        gate: undefined as never,
        interruptedAt: INTERRUPTED_AT,
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toThrow(/migration gate is required/)
    await expect(
      migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        interruptedAt: 'nope',
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toThrow(/bounded ISO-8601/)
    // Date.parse accepts this timezone-less value. The outer gate must still
    // reject it as the recovery schema does, rather than admitting it and
    // wrapping a later TypeError as a generic pre-selection failure.
    await expect(
      migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        interruptedAt: '2026-08-13T00:00:00.000',
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toMatchObject({
      name: 'JsonV2MigrationError',
      message: expect.stringMatching(/bounded ISO-8601/)
    })
    await expect(
      migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        interruptedAt: 'August 13, 2026 00:00:00 GMT',
        sourceJsonPath: sourcePath,
        databasePath
      })
    ).rejects.toThrow(/bounded ISO-8601/)
  })

  it('holds the gate after publication and reopens it after a pre-publication failure', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, legacyState())

    const failingGate = createExclusiveLegacySourceMigrationGate()
    await expect(
      migrateJsonV2ToSqlite({
        gate: failingGate,
        interruptedAt: INTERRUPTED_AT,
        sourceJsonPath: sourcePath,
        databasePath,
        fault: (point) => {
          if (point === 'after-temporary-verified') {
            throw new Error('injected pre-publication fault')
          }
        }
      })
    ).rejects.toBeInstanceOf(JsonV2MigrationError)
    expect(failingGate.isHeldForProcessExit()).toBe(false)

    const gate = createExclusiveLegacySourceMigrationGate()
    await migrateJsonV2ToSqlite({
      gate,
      interruptedAt: INTERRUPTED_AT,
      sourceJsonPath: sourcePath,
      databasePath
    })
    expect(gate.isHeldForProcessExit()).toBe(true)
  })

  it('replays a deterministic projection after reopening the published database', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'state.json')
    const databasePath = path.join(directory, 'ground.sqlite')
    await writeGeneration(sourcePath, legacyStateWithRunningTask())

    const result = migrated(
      await migrateJsonV2ToSqlite({
        ...migrationAuthority(),
        sourceJsonPath: sourcePath,
        databasePath
      })
    )

    const first = await SqliteEventStore.open({
      databasePath,
      integrityCheck: 'full'
    })
    const firstProjection = structuredClone(first.getProjection())
    await first.close()

    const second = await SqliteEventStore.open({
      databasePath,
      integrityCheck: 'full'
    })
    expect(second.getProjection()).toEqual(firstProjection)
    expect(second.getHead().eventHash).toBe(result.head.eventHash)
    await second.close()
  })
})
