import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectAsar } from './packaged-components.mjs'

const require = createRequire(import.meta.url)
const asarCli = require.resolve('@electron/asar/bin/asar.js')

describe('packaged component inventory', () => {
  it('normalizes and inventories package manifests inside an ASAR', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'ground-packaged-components-test-')
    )
    const source = path.join(root, 'app')
    const dependency = path.join(
      source,
      'node_modules',
      'example-package'
    )
    const archivePath = path.join(root, 'app.asar')

    try {
      await mkdir(dependency, { recursive: true })
      await Promise.all([
        writeFile(
          path.join(source, 'package.json'),
          JSON.stringify({ name: 'ground-fixture', version: '1.0.0' })
        ),
        writeFile(
          path.join(dependency, 'package.json'),
          JSON.stringify({
            name: 'example-package',
            version: '2.0.0'
          })
        )
      ])
      const packed = spawnSync(
        process.execPath,
        [asarCli, 'pack', source, archivePath],
        {
          encoding: 'utf8',
          shell: false,
          windowsHide: true
        }
      )
      if (packed.error) throw packed.error
      expect(packed.status).toBe(0)
      expect(packed.stderr).toBe('')

      const inventory = await inspectAsar(archivePath, root)

      expect(inventory.path).toBe('app.asar')
      expect(inventory.sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(inventory.packages).toEqual([
        {
          name: 'example-package',
          version: '2.0.0',
          path: '/node_modules/example-package/package.json'
        },
        {
          name: 'ground-fixture',
          version: '1.0.0',
          path: '/package.json'
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
