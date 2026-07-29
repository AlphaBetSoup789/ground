import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const packageRoot = join(repositoryRoot, 'packages', 'adapter-sdk')
const outputDirectory = join(packageRoot, 'dist')
const typescriptCli = join(
  repositoryRoot,
  'node_modules',
  'typescript',
  'bin',
  'tsc'
)

rmSync(outputDirectory, { recursive: true, force: true })
execFileSync(
  process.execPath,
  [typescriptCli, '--project', join(packageRoot, 'tsconfig.json')],
  {
    cwd: repositoryRoot,
    stdio: 'inherit'
  }
)

const expectedModules = [
  'abortable-iteration',
  'capabilities',
  'conformance',
  'contracts',
  'errors',
  'event-stream',
  'json',
  'registry',
  'sdk',
  'types'
]
const expectedFiles = new Set(
  expectedModules.flatMap((moduleName) => [
    `${moduleName}.d.ts`,
    `${moduleName}.js`
  ])
)
const actualFiles = new Set(
  readdirSync(outputDirectory, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile()) {
      throw new Error(
        `Adapter SDK build emitted unexpected directory: ${entry.name}`
      )
    }
    return entry.name
  })
)

for (const expected of expectedFiles) {
  if (!actualFiles.has(expected)) {
    throw new Error(`Adapter SDK build did not emit ${expected}`)
  }
}
for (const actual of actualFiles) {
  if (!expectedFiles.has(actual)) {
    throw new Error(`Adapter SDK build emitted unexpected file ${actual}`)
  }
}

for (const file of actualFiles) {
  const content = readFileSync(join(outputDirectory, file), 'utf8')
  if (
    /(?:from|require\s*\()\s*['"](?:electron|ai|@ai-sdk\/)/u.test(content) ||
    content.includes('ai-sdk-adapter') ||
    content.includes('cli-runtime-adapter')
  ) {
    throw new Error(
      `Adapter SDK output ${relative(repositoryRoot, join(outputDirectory, file))} references a production-only adapter or Electron`
    )
  }
}

console.log(
  `Built provider-neutral adapter SDK (${actualFiles.size} files) in ${relative(repositoryRoot, outputDirectory)}`
)
