import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  preparePackagedSmokeDirectory,
  resolvePackagedSmokeConfig,
  shouldMigrateLegacyData
} from './packaged-smoke'

const TOKEN = '0123456789abcdef0123456789abcdef'

describe('packaged smoke configuration', () => {
  it('accepts only an exact token-bound child of the OS temporary directory', () => {
    const temporaryDirectory = path.resolve(os.tmpdir())
    const directory = path.join(
      temporaryDirectory,
      `ground-packaged-smoke-${TOKEN}`
    )
    expect(
      resolvePackagedSmokeConfig({
        isPackaged: true,
        argv: [`--ground-packaged-smoke=${TOKEN}:native`],
        environment: {
          GROUND_PACKAGED_SMOKE_DIRECTORY: directory
        },
        temporaryDirectory
      })
    ).toMatchObject({
      token: TOKEN,
      scope: 'native',
      directory,
      resultPath: path.join(directory, 'result.json'),
      userDataPath: path.join(directory, 'user-data')
    })
  })

  it('rejects development mode and a mismatched directory', () => {
    const temporaryDirectory = path.resolve(os.tmpdir())
    const exactDirectory = path.join(
      temporaryDirectory,
      `ground-packaged-smoke-${TOKEN}`
    )
    expect(
      resolvePackagedSmokeConfig({
        isPackaged: false,
        argv: [`--ground-packaged-smoke=${TOKEN}:launch`],
        environment: {
          GROUND_PACKAGED_SMOKE_DIRECTORY: exactDirectory
        },
        temporaryDirectory
      })
    ).toBeUndefined()
    expect(
      resolvePackagedSmokeConfig({
        isPackaged: true,
        argv: [`--ground-packaged-smoke=${TOKEN}:launch`],
        environment: {
          GROUND_PACKAGED_SMOKE_DIRECTORY: path.join(
            temporaryDirectory,
            'somewhere-else'
          )
        },
        temporaryDirectory
      })
    ).toBeUndefined()
  })

  it('rejects caller-controlled smoke executables and extra control environment', () => {
    const temporaryDirectory = path.resolve(os.tmpdir())
    const exactDirectory = path.join(
      temporaryDirectory,
      `ground-packaged-smoke-${TOKEN}`
    )
    expect(
      resolvePackagedSmokeConfig({
        isPackaged: true,
        argv: [`--ground-packaged-smoke=${TOKEN}:native`],
        environment: {
          GROUND_PACKAGED_SMOKE_DIRECTORY: exactDirectory,
          GROUND_PACKAGED_SMOKE_NODE: '/tmp/caller-controlled'
        },
        temporaryDirectory
      })
    ).toBeUndefined()
    expect(
      resolvePackagedSmokeConfig({
        isPackaged: true,
        argv: [`--ground-packaged-smoke=${TOKEN}:launch`],
        environment: {
          GROUND_PACKAGED_SMOKE_DIRECTORY: exactDirectory,
          GROUND_PACKAGED_SMOKE_COMMAND: 'anything'
        },
        temporaryDirectory
      })
    ).toBeUndefined()
  })

  it('skips legacy-profile migration for an isolated packaged smoke', () => {
    const directory = path.join(
      path.resolve(os.tmpdir()),
      `ground-packaged-smoke-${TOKEN}`
    )
    const smokeConfig = resolvePackagedSmokeConfig({
      isPackaged: true,
      argv: [`--ground-packaged-smoke=${TOKEN}:launch`],
      environment: {
        GROUND_PACKAGED_SMOKE_DIRECTORY: directory
      },
      temporaryDirectory: path.resolve(os.tmpdir())
    })
    expect(smokeConfig).toBeDefined()
    expect(shouldMigrateLegacyData(smokeConfig)).toBe(false)
    expect(shouldMigrateLegacyData(undefined)).toBe(true)
  })

  it('creates one new contained user-data directory and rejects a precreated child', async () => {
    const parent = await mkdtemp(
      path.join(os.tmpdir(), 'ground-packaged-smoke-test-')
    )
    const firstDirectory = path.join(parent, 'first')
    const secondDirectory = path.join(parent, 'second')
    await Promise.all([
      mkdir(firstDirectory, { mode: 0o700 }),
      mkdir(path.join(secondDirectory, 'user-data'), {
        recursive: true,
        mode: 0o700
      })
    ])
    try {
      const first = {
        token: TOKEN,
        scope: 'launch' as const,
        directory: firstDirectory,
        resultPath: path.join(firstDirectory, 'result.json'),
        userDataPath: path.join(firstDirectory, 'user-data')
      }
      expect(() => preparePackagedSmokeDirectory(first)).not.toThrow()
      expect(() => preparePackagedSmokeDirectory(first)).toThrow()
      expect(() =>
        preparePackagedSmokeDirectory({
          ...first,
          directory: secondDirectory,
          resultPath: path.join(secondDirectory, 'result.json'),
          userDataPath: path.join(secondDirectory, 'user-data')
        })
      ).toThrow()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
