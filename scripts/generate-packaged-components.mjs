import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { inventoryAsars } from './lib/packaged-components.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const outputPath = path.resolve(
  projectRoot,
  process.argv[2] ?? 'release/ground-packaged-components.json'
)
const searchRoot = path.resolve(
  projectRoot,
  process.argv[3] ?? path.dirname(outputPath)
)
const inventory = await inventoryAsars(searchRoot)

if (!inventory.archives.length) {
  throw new Error(`No packaged app.asar files found in ${searchRoot}`)
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o644
})

const packageCount = new Set(
  inventory.archives.flatMap((archive) =>
    archive.packages.map((component) => `${component.name}@${component.version}`)
  )
).size
process.stdout.write(
  `Recorded ${packageCount} shipped package identities from ${inventory.archives.length} app.asar archive${inventory.archives.length === 1 ? '' : 's'}.\n`
)
