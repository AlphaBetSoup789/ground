import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  packagedInventoryNames,
  releaseArtifactNames,
  sha256File
} from './lib/packaged-components.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const outputPath = path.resolve(
  projectRoot,
  process.argv[2] ?? 'release/SHA256SUMS.txt'
)
const artifactDirectory = path.resolve(
  projectRoot,
  process.argv[3] ?? path.dirname(outputPath)
)
const artifactNames = await releaseArtifactNames(artifactDirectory)
const inventoryNames = await packagedInventoryNames(artifactDirectory)
const runtimeEvidenceNames = (await readdir(artifactDirectory))
  .filter((name) =>
    /^ground-package-runtime-evidence-[a-z0-9._-]+\.json$/u.test(name)
  )
  .sort()
const sbomName = 'ground-release-sbom.cdx.json'
const names = [
  ...artifactNames,
  ...inventoryNames,
  ...runtimeEvidenceNames,
  sbomName
].sort()

if (!artifactNames.length) {
  throw new Error(`No Ground release artifacts found in ${artifactDirectory}`)
}
if (!runtimeEvidenceNames.length) {
  throw new Error(
    `No Ground package runtime evidence found in ${artifactDirectory}`
  )
}

const lines = []
for (const name of names) {
  lines.push(`${await sha256File(path.join(artifactDirectory, name))}  ${name}`)
}
await writeFile(outputPath, `${lines.join('\n')}\n`, {
  encoding: 'utf8',
  mode: 0o644
})
process.stdout.write(`Generated SHA-256 checksums for ${names.length} files.\n`)
