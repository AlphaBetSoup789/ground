import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  loadPackagedInventories,
  packageKey,
  releaseArtifactNames,
  sha256File
} from './lib/packaged-components.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const sbomPath = path.resolve(
  projectRoot,
  process.argv[2] ?? 'release/ground-release-sbom.cdx.json'
)
const artifactDirectory = path.resolve(
  projectRoot,
  process.argv[3] ?? path.dirname(sbomPath)
)
const document = JSON.parse(await readFile(sbomPath, 'utf8'))

if (
  document?.bomFormat !== 'CycloneDX' ||
  !Array.isArray(document.components) ||
  typeof document.metadata?.component?.name !== 'string' ||
  typeof document.metadata.component.version !== 'string'
) {
  throw new Error('Release SBOM is not a supported CycloneDX document')
}

const inventory = await loadPackagedInventories(artifactDirectory)
if (!inventory.archives.length) {
  throw new Error(
    `No app.asar or packaged-component inventory found in ${artifactDirectory}`
  )
}

const represented = new Map(
  document.components
    .filter(
      (component) =>
        typeof component?.name === 'string' &&
        typeof component.version === 'string'
    )
    .map((component) => [packageKey(component), component])
)
represented.set(packageKey(document.metadata.component), document.metadata.component)

const packaged = new Map()
for (const archive of inventory.archives) {
  for (const component of archive.packages) {
    packaged.set(packageKey(component), component)
  }
}

const missing = [...packaged.keys()].filter((key) => !represented.has(key)).sort()
if (missing.length) {
  throw new Error(`Release SBOM is missing shipped packages:\n${missing.join('\n')}`)
}

for (const key of packaged.keys()) {
  const component = represented.get(key)
  if (component === document.metadata.component) continue
  const markedShipped = component.properties?.some(
    (property) =>
      property.name === 'ground:release:app-asar' && property.value === 'true'
  )
  if (!markedShipped) {
    throw new Error(`Release SBOM does not mark ${key} as shipped in app.asar`)
  }
}

const artifactNames = await releaseArtifactNames(artifactDirectory)
for (const name of artifactNames) {
  const expectedHash = await sha256File(path.join(artifactDirectory, name))
  const artifact = document.components.find(
    (component) =>
      component.type === 'file' &&
      component.name === name &&
      component.hashes?.some(
        (hash) => hash.alg === 'SHA-256' && hash.content === expectedHash
      )
  )
  if (!artifact) {
    throw new Error(`Release SBOM is missing the SHA-256 identity for ${name}`)
  }
}

process.stdout.write(
  `Verified ${packaged.size} shipped package identities and ${artifactNames.length} release artifact hashes in the SBOM.\n`
)
