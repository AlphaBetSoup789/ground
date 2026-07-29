import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  loadPackagedInventories,
  packageKey,
  releaseArtifactNames,
  sha256File
} from './lib/packaged-components.mjs'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(import.meta.dirname, '..')
const outputPath = path.resolve(
  projectRoot,
  process.argv[2] ?? 'release/ground-release-sbom.cdx.json'
)
const artifactDirectory = path.resolve(
  projectRoot,
  process.argv[3] ?? path.dirname(outputPath)
)
const packageDocument = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)

const npmSbom = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  [
    'sbom',
    '--omit=dev',
    '--sbom-format=cyclonedx',
    '--package-lock-only'
  ],
  {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false
  }
)
if (npmSbom.error) throw npmSbom.error
if (npmSbom.status !== 0) {
  throw new Error(
    `npm could not generate the production dependency SBOM:\n${npmSbom.stderr.trim()}`
  )
}

const document = JSON.parse(npmSbom.stdout)
if (
  document?.bomFormat !== 'CycloneDX' ||
  !Array.isArray(document.components) ||
  !Array.isArray(document.dependencies) ||
  !document.metadata?.component?.['bom-ref']
) {
  throw new Error('npm returned an unexpected CycloneDX document')
}

const electronPackage = require('electron/package.json')
const electronExecutable = require('electron')
const runtimeProbe = spawnSync(
  electronExecutable,
  ['-p', 'JSON.stringify(process.versions)'],
  {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    maxBuffer: 1024 * 1024,
    shell: false
  }
)
if (runtimeProbe.error) throw runtimeProbe.error
if (runtimeProbe.status !== 0) {
  throw new Error(
    `Electron runtime inspection failed:\n${runtimeProbe.stderr.trim()}`
  )
}

const runtimeVersions = JSON.parse(runtimeProbe.stdout)
for (const key of ['electron', 'chrome', 'node']) {
  if (typeof runtimeVersions[key] !== 'string' || !runtimeVersions[key]) {
    throw new Error(`Electron did not report its embedded ${key} version`)
  }
}
if (runtimeVersions.electron !== electronPackage.version) {
  throw new Error('Installed Electron package and runtime versions do not match')
}

const electronRef = `electron@${runtimeVersions.electron}`
const chromiumRef = `ground-runtime:chromium@${runtimeVersions.chrome}`
const nodeRef = `ground-runtime:node@${runtimeVersions.node}`
const shippedProperty = {
  name: 'ground:release:shipped-runtime',
  value: 'true'
}

function addProperty(component, property) {
  component.properties ??= []
  if (
    !component.properties.some(
      (candidate) =>
        candidate.name === property.name && candidate.value === property.value
    )
  ) {
    component.properties.push(property)
  }
}

function npmPurl(name, version) {
  const encodedName = encodeURIComponent(name).replace(/%2F/giu, '/')
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

document.metadata.component.type = 'application'
document.metadata.component.name = packageDocument.name
document.metadata.component.version = packageDocument.version
document.metadata.lifecycles = [{ phase: 'post-build' }]
document.metadata.tools ??= []
document.metadata.tools.push({
  vendor: 'Ground contributors',
  name: 'generate-release-sbom.mjs',
  version: document.metadata.component.version
})
document.components.push(
  {
    'bom-ref': electronRef,
    type: 'framework',
    name: 'electron',
    version: runtimeVersions.electron,
    scope: 'required',
    purl: `pkg:npm/electron@${runtimeVersions.electron}`,
    licenses: [{ license: { id: 'MIT' } }],
    properties: [shippedProperty]
  },
  {
    'bom-ref': chromiumRef,
    type: 'framework',
    group: 'Chromium',
    name: 'Chromium',
    version: runtimeVersions.chrome,
    scope: 'required',
    purl: `pkg:generic/chromium@${runtimeVersions.chrome}`,
    licenses: [{ license: { id: 'BSD-3-Clause' } }],
    properties: [shippedProperty]
  },
  {
    'bom-ref': nodeRef,
    type: 'framework',
    group: 'OpenJS Foundation',
    name: 'Node.js',
    version: runtimeVersions.node,
    scope: 'required',
    purl: `pkg:generic/node.js@${runtimeVersions.node}`,
    licenses: [{ license: { id: 'MIT' } }],
    properties: [shippedProperty]
  }
)

const nodePty = document.components.find(
  (component) => component.name === 'node-pty'
)
if (!nodePty) throw new Error('The release SBOM is missing node-pty')
nodePty.properties ??= []
nodePty.properties.push({
  name: 'ground:release:native-addon',
  value: 'true'
})

const rootDependency = document.dependencies.find(
  (dependency) =>
    dependency.ref === document.metadata.component['bom-ref']
)
if (!rootDependency) throw new Error('The release SBOM is missing its root dependency')
rootDependency.dependsOn ??= []
rootDependency.dependsOn.push(electronRef)
document.dependencies.push({
  ref: electronRef,
  dependsOn: [chromiumRef, nodeRef]
})

const inventory = await loadPackagedInventories(artifactDirectory)
if (!inventory.archives.length) {
  throw new Error(
    `No app.asar or packaged-component inventory found in ${artifactDirectory}`
  )
}
const packagedComponents = new Map()
for (const archive of inventory.archives) {
  for (const component of archive.packages) {
    const key = packageKey(component)
    const current = packagedComponents.get(key) ?? {
      name: component.name,
      version: component.version,
      paths: new Set()
    }
    current.paths.add(component.path)
    packagedComponents.set(key, current)
  }
}

const rootKey = packageKey(document.metadata.component)
if (!packagedComponents.has(rootKey)) {
  throw new Error(`Packaged app.asar does not contain ${rootKey} at its root`)
}
addProperty(document.metadata.component, {
  name: 'ground:release:app-asar',
  value: 'true'
})

const componentsByKey = new Map(
  document.components
    .filter(
      (component) =>
        typeof component?.name === 'string' &&
        typeof component.version === 'string'
    )
    .map((component) => [packageKey(component), component])
)
for (const [key, packaged] of packagedComponents) {
  if (key === rootKey) continue
  let component = componentsByKey.get(key)
  if (!component) {
    component = {
      'bom-ref': key,
      type: 'library',
      name: packaged.name,
      version: packaged.version,
      scope: 'required',
      purl: npmPurl(packaged.name, packaged.version),
      properties: []
    }
    document.components.push(component)
    componentsByKey.set(key, component)
  }
  addProperty(component, {
    name: 'ground:release:app-asar',
    value: 'true'
  })
  addProperty(component, {
    name: 'ground:release:asar-package-paths',
    value: JSON.stringify([...packaged.paths].sort())
  })
  const dependency = document.dependencies.find(
    (candidate) => candidate.ref === component['bom-ref']
  )
  if (!dependency) {
    document.dependencies.push({ ref: component['bom-ref'], dependsOn: [] })
  }
  rootDependency.dependsOn.push(component['bom-ref'])
}

const artifactNames = await releaseArtifactNames(artifactDirectory)
if (!artifactNames.length) {
  throw new Error(`No Ground release artifacts found in ${artifactDirectory}`)
}

for (const name of artifactNames) {
  const absolutePath = path.join(artifactDirectory, name)
  const details = await stat(absolutePath)
  if (!details.isFile()) continue
  const sha256 = await sha256File(absolutePath)
  document.components.push({
    'bom-ref': `ground-artifact:${name}:${sha256}`,
    type: 'file',
    name,
    version: document.metadata.component.version,
    scope: 'required',
    hashes: [{ alg: 'SHA-256', content: sha256 }],
    properties: [
      {
        name: 'ground:release:artifact-size-bytes',
        value: String(details.size)
      }
    ]
  })
}

document.components.sort((left, right) =>
  String(left['bom-ref']).localeCompare(String(right['bom-ref']))
)
rootDependency.dependsOn = [...new Set(rootDependency.dependsOn)].sort()

await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o644
})
process.stdout.write(
  `Generated release SBOM with ${document.components.length} components, ${packagedComponents.size} shipped package identities, and ${artifactNames.length} artifact${artifactNames.length === 1 ? '' : 's'}.\n`
)
