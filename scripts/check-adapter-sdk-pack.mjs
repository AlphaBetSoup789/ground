import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const packageRoot = join(repositoryRoot, 'packages', 'adapter-sdk')
const packageManifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8')
)
const npmCli = process.env.npm_execpath
if (!npmCli) {
  throw new Error(
    'npm_execpath is unavailable; run this check through npm run adapter-sdk:pack-check'
  )
}

execFileSync(
  process.execPath,
  [join(scriptDirectory, 'build-adapter-sdk.mjs')],
  {
    cwd: repositoryRoot,
    stdio: 'inherit'
  }
)

const temporaryRoot = mkdtempSync(
  join(tmpdir(), 'ground-adapter-sdk-pack-')
)
try {
  const packDirectory = join(temporaryRoot, 'pack')
  mkdirSync(packDirectory)
  const packOutput = execFileSync(
    process.execPath,
    [
      npmCli,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory
    ],
    {
      cwd: packageRoot,
      encoding: 'utf8'
    }
  )
  const packResult = JSON.parse(packOutput)
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new Error('npm pack did not return exactly one package result')
  }
  const packed = packResult[0]
  const paths = new Set(
    packed.files.map((entry) => String(entry.path))
  )
  const expectedPaths = new Set([
    'LICENSE',
    'README.md',
    'package.json',
    'dist/abortable-iteration.d.ts',
    'dist/abortable-iteration.js',
    'dist/capabilities.d.ts',
    'dist/capabilities.js',
    'dist/conformance.d.ts',
    'dist/conformance.js',
    'dist/contracts.d.ts',
    'dist/contracts.js',
    'dist/errors.d.ts',
    'dist/errors.js',
    'dist/event-stream.d.ts',
    'dist/event-stream.js',
    'dist/json.d.ts',
    'dist/json.js',
    'dist/registry.d.ts',
    'dist/registry.js',
    'dist/sdk.d.ts',
    'dist/sdk.js',
    'dist/types.d.ts',
    'dist/types.js'
  ])
  for (const expected of expectedPaths) {
    if (!paths.has(expected)) {
      throw new Error(`Packed adapter SDK is missing ${expected}`)
    }
  }
  for (const path of paths) {
    if (!expectedPaths.has(path)) {
      throw new Error(`Packed adapter SDK contains unexpected path ${path}`)
    }
  }

  const consumerDirectory = join(temporaryRoot, 'consumer')
  mkdirSync(consumerDirectory)
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    JSON.stringify({ private: true }, null, 2)
  )
  const tarball = join(packDirectory, String(packed.filename))
  execFileSync(
    process.execPath,
    [
      npmCli,
      'install',
      '--ignore-scripts',
      '--allow-file=all',
      '--allow-git=none',
      '--allow-remote=none',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball
    ],
    {
      cwd: consumerDirectory,
      stdio: 'inherit'
    }
  )

  const probe = `
    const sdk = require(${JSON.stringify(packageManifest.name)});
    if (sdk.GROUND_ADAPTER_API_VERSION !== 1) {
      throw new Error('missing adapter API version');
    }
    if (sdk.GROUND_ADAPTER_CONFORMANCE_VERSION !== 1) {
      throw new Error('missing conformance version');
    }
    for (const name of [
      'AdapterRegistry',
      'AgentRuntimeEventReducer',
      'consumeModelEventStream',
      'nextAdapterEvent',
      'runModelAdapterConformance',
      'runAgentRuntimeAdapterConformance'
    ]) {
      if (typeof sdk[name] !== 'function') {
        throw new Error('missing SDK export ' + name);
      }
    }
    for (const name of Object.keys(sdk)) {
      if (/ai.?sdk|electron|cli.?runtime.?adapter/i.test(name)) {
        throw new Error('production-only export ' + name);
      }
    }
  `
  execFileSync(process.execPath, ['--eval', probe], {
    cwd: consumerDirectory,
    stdio: 'inherit'
  })

  writeFileSync(
    join(consumerDirectory, 'probe.ts'),
    `
      import {
        AgentRuntimeEventReducer,
        GROUND_ADAPTER_API_VERSION,
        type ModelAdapter
      } from ${JSON.stringify(packageManifest.name)}

      const apiVersion: 1 = GROUND_ADAPTER_API_VERSION
      const reducer = new AgentRuntimeEventReducer()
      const adapterTypeOnly: ModelAdapter<unknown> | undefined = undefined
      void apiVersion
      void reducer
      void adapterTypeOnly
    `
  )
  execFileSync(
    process.execPath,
    [
      join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'Node16',
      '--moduleResolution',
      'Node16',
      join(consumerDirectory, 'probe.ts')
    ],
    {
      cwd: consumerDirectory,
      stdio: 'inherit'
    }
  )

  console.log(
    `Verified npm pack contents plus clean-room JavaScript and declaration imports for ${packageManifest.name}`
  )
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
