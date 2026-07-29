import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

export const inventorySchema = 'ground-packaged-components/v1'

export function packageKey(component) {
  return `${component.name}@${component.version}`
}

export async function sha256File(filePath) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

async function findFiles(directory, predicate) {
  const matches = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      matches.push(...(await findFiles(entryPath, predicate)))
    } else if (entry.isFile() && predicate(entry.name, entryPath)) {
      matches.push(entryPath)
    }
  }
  return matches
}

function normalizeRelativePath(root, target) {
  return path.relative(root, target).split(path.sep).join('/')
}

export async function inspectAsar(archivePath, searchRoot) {
  const packagesByKey = new Map()
  for (const archiveEntry of asar
    .listPackage(archivePath)
    .filter((entry) => entry.endsWith('/package.json'))) {
    let packageDocument
    try {
      packageDocument = JSON.parse(
        asar.extractFile(archivePath, archiveEntry.replace(/^\//u, '')).toString()
      )
    } catch {
      continue
    }
    if (
      typeof packageDocument.name !== 'string' ||
      !packageDocument.name ||
      typeof packageDocument.version !== 'string' ||
      !packageDocument.version
    ) {
      continue
    }
    const component = {
      name: packageDocument.name,
      version: packageDocument.version,
      path: archiveEntry
    }
    const key = packageKey(component)
    const existing = packagesByKey.get(key)
    if (!existing || archiveEntry.length < existing.path.length) {
      packagesByKey.set(key, component)
    }
  }

  if (!packagesByKey.size) {
    throw new Error(`No package identities were found in ${archivePath}`)
  }

  return {
    path: normalizeRelativePath(searchRoot, archivePath),
    sha256: await sha256File(archivePath),
    packages: [...packagesByKey.values()].sort((left, right) =>
      packageKey(left).localeCompare(packageKey(right))
    )
  }
}

export async function inventoryAsars(searchRoot) {
  const archives = (
    await findFiles(searchRoot, (name) => name === 'app.asar')
  ).sort()
  return {
    schema: inventorySchema,
    archives: await Promise.all(
      archives.map((archivePath) => inspectAsar(archivePath, searchRoot))
    )
  }
}

function validateInventory(document, source) {
  if (document?.schema !== inventorySchema || !Array.isArray(document.archives)) {
    throw new Error(`Invalid packaged-component inventory: ${source}`)
  }
  for (const archive of document.archives) {
    if (
      typeof archive?.path !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(archive.sha256) ||
      !Array.isArray(archive.packages) ||
      !archive.packages.length
    ) {
      throw new Error(`Invalid archive record in packaged-component inventory: ${source}`)
    }
    for (const component of archive.packages) {
      if (
        typeof component?.name !== 'string' ||
        !component.name ||
        typeof component.version !== 'string' ||
        !component.version ||
        typeof component.path !== 'string' ||
        !component.path.startsWith('/')
      ) {
        throw new Error(`Invalid package record in packaged-component inventory: ${source}`)
      }
    }
  }
  return document
}

export async function loadPackagedInventories(searchRoot) {
  const direct = await inventoryAsars(searchRoot)
  if (direct.archives.length) return direct

  const manifestPaths = (
    await findFiles(
      searchRoot,
      (name) =>
        name === 'ground-packaged-components.json' ||
        /^ground-packaged-components-[a-z0-9_-]+\.json$/iu.test(name)
    )
  ).sort()
  const archives = []
  for (const manifestPath of manifestPaths) {
    const document = validateInventory(
      JSON.parse(await readFile(manifestPath, 'utf8')),
      manifestPath
    )
    archives.push(...document.archives)
  }
  return { schema: inventorySchema, archives }
}

export async function releaseArtifactNames(directory) {
  const names = []
  for (const entry of await readdir(directory)) {
    if (
      entry.startsWith('Ground-') &&
      /\.(?:AppImage|deb|dmg|exe|zip)$/u.test(entry) &&
      (await lstat(path.join(directory, entry))).isFile()
    ) {
      names.push(entry)
    }
  }
  return names.sort()
}

export async function packagedInventoryNames(directory) {
  const names = []
  for (const entry of await readdir(directory)) {
    if (
      (entry === 'ground-packaged-components.json' ||
        /^ground-packaged-components-[a-z0-9_-]+\.json$/iu.test(entry)) &&
      (await lstat(path.join(directory, entry))).isFile()
    ) {
      names.push(entry)
    }
  }
  return names.sort()
}
