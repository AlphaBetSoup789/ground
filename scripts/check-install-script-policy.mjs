import { readFile } from 'node:fs/promises'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const [packageDocument, lockDocument, npmrc] = await Promise.all([
  readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(projectRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
  readFile(path.join(projectRoot, '.npmrc'), 'utf8')
])

const requiredNpmrc = new Map([
  ['engine-strict', 'true'],
  ['strict-allow-scripts', 'true'],
  ['dangerously-allow-all-scripts', 'false'],
  ['allow-git', 'none'],
  ['allow-remote', 'none'],
  ['allow-file', 'none']
])
const configuredNpmrc = new Map(
  npmrc
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=')
      return separator === -1
        ? [line, '']
        : [line.slice(0, separator), line.slice(separator + 1)]
    })
)

for (const [key, value] of requiredNpmrc) {
  if (configuredNpmrc.get(key) !== value) {
    throw new Error(`.npmrc must set ${key}=${value}`)
  }
}

const approvals = packageDocument.allowScripts
if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) {
  throw new Error('package.json must contain an allowScripts policy')
}

const installScriptPackages = new Map()
for (const [location, entry] of Object.entries(lockDocument.packages ?? {})) {
  if (!location || !entry?.hasInstallScript || !entry.version) continue
  const marker = 'node_modules/'
  const markerIndex = location.lastIndexOf(marker)
  const inferredName = location.slice(markerIndex + marker.length)
  const name = entry.name ?? inferredName
  installScriptPackages.set(`${name}@${entry.version}`, { name, version: entry.version })
}

for (const [identity, { name }] of installScriptPackages) {
  if (approvals[identity] === true || approvals[name] === false) continue
  throw new Error(`Install scripts for ${identity} have not been explicitly reviewed`)
}

for (const [selector, decision] of Object.entries(approvals)) {
  if (decision !== true && decision !== false) {
    throw new Error(`allowScripts.${selector} must be a boolean`)
  }
  if (decision === true && !installScriptPackages.has(selector)) {
    throw new Error(
      `Allowed install script ${selector} must match an installed name and version`
    )
  }
  const matched = [...installScriptPackages].some(
    ([identity, { name }]) =>
      selector === identity || (decision === false && selector === name)
  )
  if (!matched) {
    throw new Error(`allowScripts contains stale entry ${selector}`)
  }
}

process.stdout.write(
  `Verified strict install-script policy for ${installScriptPackages.size} package identities.\n`
)
