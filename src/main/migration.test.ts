import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateLegacyData } from './migration'

describe('migrateLegacyData', () => {
  it('copies legacy state and opaque secret data into the Ground data directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ground-migration-'))
    const appData = path.join(root, 'Application Support')
    const legacyDirectory = path.join(appData, 'ModelDock')
    const groundDirectory = path.join(appData, 'Ground')
    await mkdir(legacyDirectory, { recursive: true })
    await writeFile(path.join(legacyDirectory, 'modeldock-state.json'), '{"tasks":[]}')
    await writeFile(path.join(legacyDirectory, 'modeldock-secrets.json'), 'opaque-encrypted-data')

    await migrateLegacyData(groundDirectory, appData)

    await expect(readFile(path.join(groundDirectory, 'ground-state.json'), 'utf8')).resolves.toBe(
      '{"tasks":[]}'
    )
    await expect(readFile(path.join(groundDirectory, 'ground-secrets.json'), 'utf8')).resolves.toBe(
      'opaque-encrypted-data'
    )
  })

  it('does not overwrite Ground data that already exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ground-migration-'))
    const legacyDirectory = path.join(root, 'ModelDock')
    const groundDirectory = path.join(root, 'Ground')
    await mkdir(legacyDirectory, { recursive: true })
    await mkdir(groundDirectory, { recursive: true })
    await writeFile(path.join(legacyDirectory, 'modeldock-state.json'), 'legacy')
    await writeFile(path.join(groundDirectory, 'ground-state.json'), 'current')

    await migrateLegacyData(groundDirectory, root)

    await expect(readFile(path.join(groundDirectory, 'ground-state.json'), 'utf8')).resolves.toBe(
      'current'
    )
  })
})
