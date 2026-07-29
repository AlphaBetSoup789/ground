import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(import.meta.dirname, '..')
const minimatchInstallations = [
  'node_modules/@electron/asar/node_modules/minimatch',
  'node_modules/@electron/universal/node_modules/minimatch',
  'node_modules/filelist/node_modules/minimatch',
  'node_modules/minimatch'
]
const samplePath = 'src/main/index.ts'
const samplePattern = 'src/{main,preload}/**/*.ts'

for (const relativePath of minimatchInstallations) {
  const api = require(path.join(projectRoot, relativePath))
  const minimatch = typeof api === 'function' ? api : api.minimatch
  if (
    typeof minimatch !== 'function' ||
    !minimatch(samplePath, samplePattern)
  ) {
    throw new Error(
      `The security-fixed brace-expansion bridge is incompatible with ${relativePath}`
    )
  }
}

const expand = require(
  path.join(projectRoot, 'vendor/brace-expansion-compat')
)
const boundedExpansion = expand('{1..100001}')
if (!Array.isArray(boundedExpansion) || boundedExpansion.length > 100_000) {
  throw new Error('brace-expansion did not enforce its fixed expansion limit')
}

process.stdout.write(
  'Verified the security-fixed brace-expansion bridge across the Electron build graph.\n'
)
