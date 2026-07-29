import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'fixtures', 'compatibility')
const MANIFEST_ROOTS = [
  path.join(FIXTURE_ROOT, 'api'),
  path.join(FIXTURE_ROOT, 'cli')
]
const PROVENANCE_VALUES = new Set([
  'synthetic-contract',
  'documented-example'
])
const CLI_ADAPTERS = ['codex', 'claude', 'gemini']
const API_PACKAGES = [
  'ai',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/openai-compatible'
]
const API_PROTOCOLS = [
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'openai-compatible'
]

function fail(message) {
  throw new Error(`Compatibility fixture check failed: ${message}`)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`)
}

function assertExactKeys(value, expected, label) {
  assertRecord(value, label)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(
      `${label} keys must be exactly ${wanted.join(', ')}; received ${actual.join(', ')}`
    )
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`)
  }
}

function assertStableId(value, label) {
  assertNonEmptyString(value, label)
  if (!/^[a-z0-9][a-z0-9._-]+$/u.test(value)) {
    fail(`${label} must be a stable lowercase identifier`)
  }
}

function assertVersion(value, label) {
  assertNonEmptyString(value, label)
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    fail(`${label} must be an exact semantic version`)
  }
}

function assertDate(value, label) {
  assertNonEmptyString(value, label)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(`${label} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} is not a valid calendar date`)
  }
}

function assertArray(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(`${label} must be an array with at least ${minimum} item(s)`)
  }
}

function assertEventArray(value, label, minimum) {
  assertArray(value, label, minimum)
  value.forEach((event, index) => {
    assertRecord(event, `${label}[${index}]`)
    assertNonEmptyString(event.type, `${label}[${index}].type`)
  })
}

async function readJson(relativePath) {
  const absolutePath = path.join(PROJECT_ROOT, relativePath)
  return readJsonFile(absolutePath, relativePath)
}

async function readJsonFile(absolutePath, label) {
  try {
    return JSON.parse(await readFile(absolutePath, 'utf8'))
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`)
  }
}

async function findJsonFiles(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...(await findJsonFiles(target)))
    else if (entry.isFile() && entry.name.endsWith('.json')) output.push(target)
  }
  return output
}

function validateVersions(value) {
  assertExactKeys(value, ['schemaVersion', 'cli', 'apiPackages'], 'versions.json')
  if (value.schemaVersion !== 1) fail('versions.json schemaVersion must be 1')
  assertExactKeys(value.cli, CLI_ADAPTERS, 'versions.json.cli')
  for (const adapter of CLI_ADAPTERS) {
    const runtime = value.cli[adapter]
    assertExactKeys(
      runtime,
      ['runtime', 'version'],
      `versions.json.cli.${adapter}`
    )
    assertNonEmptyString(runtime.runtime, `versions.json.cli.${adapter}.runtime`)
    assertVersion(runtime.version, `versions.json.cli.${adapter}.version`)
  }
  assertExactKeys(
    value.apiPackages,
    API_PACKAGES,
    'versions.json.apiPackages'
  )
  for (const packageName of API_PACKAGES) {
    assertVersion(
      value.apiPackages[packageName],
      `versions.json.apiPackages.${packageName}`
    )
  }
  return value
}

function isValidSchemaDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

function compileManifestSchema(schema, label) {
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true
    })
    ajv.addFormat('date', {
      type: 'string',
      validate: isValidSchemaDate
    })
    return ajv.compile(schema)
  } catch (error) {
    fail(`${label} does not compile as draft-2020-12 JSON Schema: ${error.message}`)
  }
}

function validateAgainstManifestSchema(validate, manifest, label) {
  if (validate(manifest)) return
  const details = (validate.errors ?? [])
    .map((error) => {
      const location = error.instancePath || '/'
      return `${location} ${error.message ?? 'is invalid'}`
    })
    .join('; ')
  fail(`${label} does not satisfy manifest.schema.json: ${details}`)
}

function validateProvenance(suite, label) {
  if (!PROVENANCE_VALUES.has(suite.provenance)) {
    fail(`${label}.provenance must be synthetic-contract or documented-example`)
  }
  assertNonEmptyString(suite.provenanceNote, `${label}.provenanceNote`)
  if (suite.provenanceNote.length < 20) {
    fail(`${label}.provenanceNote must describe the fixture source`)
  }
  if (
    suite.provenance === 'synthetic-contract' &&
    !/not captured/iu.test(suite.provenanceNote)
  ) {
    fail(`${label}.provenanceNote must state that synthetic input was not captured`)
  }
  if (
    /(?:is|was) (?:a )?live capture/iu.test(suite.provenanceNote) ||
    /captured from (?:a )?(?:live|authenticated)/iu.test(
      suite.provenanceNote.replace(/not captured/giu, '')
    )
  ) {
    fail(`${label}.provenanceNote must not claim a live capture`)
  }
  if (suite.liveCapture !== false) {
    fail(`${label}.liveCapture must be false for the published credential-free set`)
  }
}

function validateCases(cases, kind, label) {
  assertArray(cases, `${label}.cases`, 1)
  const caseIds = new Set()
  cases.forEach((fixtureCase, index) => {
    const caseLabel = `${label}.cases[${index}]`
    const keys =
      kind === 'api'
        ? [
            'id',
            'description',
            'request',
            'inputEvents',
            'expectedCanonicalEvents'
          ]
        : ['id', 'description', 'inputEvents', 'expectedCanonicalEvents']
    assertExactKeys(fixtureCase, keys, caseLabel)
    assertStableId(fixtureCase.id, `${caseLabel}.id`)
    if (caseIds.has(fixtureCase.id)) {
      fail(`${label} contains duplicate case ID ${fixtureCase.id}`)
    }
    caseIds.add(fixtureCase.id)
    assertNonEmptyString(fixtureCase.description, `${caseLabel}.description`)
    if (kind === 'api') assertRecord(fixtureCase.request, `${caseLabel}.request`)
    assertEventArray(fixtureCase.inputEvents, `${caseLabel}.inputEvents`, 1)
    assertEventArray(
      fixtureCase.expectedCanonicalEvents,
      `${caseLabel}.expectedCanonicalEvents`,
      kind === 'api' ? 1 : 0
    )
  })
}

function validateCliManifest(manifest, relativePath, versions) {
  const label = relativePath
  assertExactKeys(manifest, ['schemaVersion', 'suite', 'cases'], label)
  if (manifest.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`)
  assertExactKeys(
    manifest.suite,
    [
      'id',
      'kind',
      'adapter',
      'runtime',
      'version',
      'fixtureDate',
      'provenance',
      'provenanceNote',
      'liveCapture'
    ],
    `${label}.suite`
  )
  const suite = manifest.suite
  if (suite.kind !== 'cli') fail(`${label}.suite.kind must be cli`)
  if (!CLI_ADAPTERS.includes(suite.adapter)) {
    fail(`${label}.suite.adapter is not a recognized CLI adapter`)
  }
  const declared = versions.cli[suite.adapter]
  if (suite.runtime !== declared.runtime || suite.version !== declared.version) {
    fail(
      `${label} targets ${suite.runtime} ${suite.version}, expected ${declared.runtime} ${declared.version}`
    )
  }
  assertStableId(suite.id, `${label}.suite.id`)
  assertDate(suite.fixtureDate, `${label}.suite.fixtureDate`)
  validateProvenance(suite, `${label}.suite`)
  validateCases(manifest.cases, 'cli', label)
  return suite
}

function validateApiManifest(manifest, relativePath, versions) {
  const label = relativePath
  assertExactKeys(manifest, ['schemaVersion', 'suite', 'cases'], label)
  if (manifest.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`)
  assertExactKeys(
    manifest.suite,
    [
      'id',
      'kind',
      'adapterBoundary',
      'protocols',
      'packages',
      'fixtureDate',
      'provenance',
      'provenanceNote',
      'liveCapture'
    ],
    `${label}.suite`
  )
  const suite = manifest.suite
  if (suite.kind !== 'api') fail(`${label}.suite.kind must be api`)
  if (suite.adapterBoundary !== 'ai-sdk-language-model-v4') {
    fail(`${label}.suite.adapterBoundary is unsupported`)
  }
  assertArray(suite.protocols, `${label}.suite.protocols`, 1)
  const protocols = [...suite.protocols].sort()
  if (JSON.stringify(protocols) !== JSON.stringify([...API_PROTOCOLS].sort())) {
    fail(`${label}.suite.protocols must cover all built-in AI SDK API adapters`)
  }
  assertExactKeys(suite.packages, API_PACKAGES, `${label}.suite.packages`)
  for (const packageName of API_PACKAGES) {
    if (suite.packages[packageName] !== versions.apiPackages[packageName]) {
      fail(
        `${label} pins ${packageName} ${suite.packages[packageName]}, expected ${versions.apiPackages[packageName]}`
      )
    }
  }
  assertStableId(suite.id, `${label}.suite.id`)
  assertDate(suite.fixtureDate, `${label}.suite.fixtureDate`)
  validateProvenance(suite, `${label}.suite`)
  validateCases(manifest.cases, 'api', label)
  return suite
}

async function validatePackageVersions(versions) {
  const packageJson = await readJson('package.json')
  const packageLock = await readJson('package-lock.json')
  assertRecord(packageJson.dependencies, 'package.json.dependencies')
  assertRecord(packageLock.packages, 'package-lock.json.packages')
  assertRecord(packageLock.packages[''], 'package-lock.json root package')
  assertRecord(
    packageLock.packages[''].dependencies,
    'package-lock.json root dependencies'
  )
  for (const packageName of API_PACKAGES) {
    const declaredRange = packageJson.dependencies[packageName]
    assertNonEmptyString(
      declaredRange,
      `package.json dependency ${packageName}`
    )
    if (packageLock.packages[''].dependencies[packageName] !== declaredRange) {
      fail(`${packageName} declaration differs between package.json and package-lock.json`)
    }
    const lockedPackage = packageLock.packages[`node_modules/${packageName}`]
    assertRecord(lockedPackage, `package-lock.json ${packageName}`)
    if (lockedPackage.version !== versions.apiPackages[packageName]) {
      fail(
        `${packageName} fixture pin ${versions.apiPackages[packageName]} differs from package-lock.json ${lockedPackage.version}`
      )
    }
  }
}

async function validateCliObservation(versions) {
  const observationPath = 'docs/compatibility/cli-help-2026-07-28.md'
  const observation = await readFile(
    path.join(PROJECT_ROOT, observationPath),
    'utf8'
  )
  for (const adapter of CLI_ADAPTERS) {
    const { runtime, version } = versions.cli[adapter]
    if (!observation.includes(`| ${runtime} | ${version} |`)) {
      fail(`${observationPath} does not declare ${runtime} ${version}`)
    }
  }
}

export async function checkCompatibilityFixtures(options = {}) {
  const versions = validateVersions(
    await readJson('fixtures/compatibility/versions.json')
  )
  const schemaPath = options.schemaPath
    ? path.resolve(options.schemaPath)
    : path.join(FIXTURE_ROOT, 'manifest.schema.json')
  const schemaLabel = path.relative(PROJECT_ROOT, schemaPath)
  const schema = await readJsonFile(schemaPath, schemaLabel)
  if (
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    !Array.isArray(schema.oneOf)
  ) {
    fail('manifest.schema.json must remain a draft 2020-12 union schema')
  }
  const validateManifestSchema = compileManifestSchema(schema, schemaLabel)

  await validatePackageVersions(versions)
  await validateCliObservation(versions)

  const manifestPaths = (
    await Promise.all(MANIFEST_ROOTS.map((directory) => findJsonFiles(directory)))
  )
    .flat()
    .sort()
  if (manifestPaths.length === 0) fail('no compatibility manifests were found')

  const seenSuiteIds = new Set()
  const seenCliAdapters = new Set()
  let apiManifestCount = 0
  for (const absolutePath of manifestPaths) {
    const relativePath = path.relative(PROJECT_ROOT, absolutePath)
    const manifest = await readJson(relativePath)
    validateAgainstManifestSchema(
      validateManifestSchema,
      manifest,
      relativePath
    )
    assertRecord(manifest.suite, `${relativePath}.suite`)
    const suite =
      manifest.suite.kind === 'cli'
        ? validateCliManifest(manifest, relativePath, versions)
        : manifest.suite.kind === 'api'
          ? validateApiManifest(manifest, relativePath, versions)
          : fail(`${relativePath}.suite.kind must be cli or api`)
    if (seenSuiteIds.has(suite.id)) fail(`duplicate suite ID ${suite.id}`)
    seenSuiteIds.add(suite.id)
    if (suite.kind === 'cli') {
      if (seenCliAdapters.has(suite.adapter)) {
        fail(`more than one manifest targets CLI adapter ${suite.adapter}`)
      }
      seenCliAdapters.add(suite.adapter)
    } else {
      apiManifestCount += 1
    }
  }

  for (const adapter of CLI_ADAPTERS) {
    if (!seenCliAdapters.has(adapter)) fail(`missing ${adapter} CLI fixture manifest`)
  }
  if (apiManifestCount === 0) fail('missing an API fixture manifest')

  return {
    manifestCount: manifestPaths.length,
    suiteIds: [...seenSuiteIds].sort()
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2)
  const validArguments =
    arguments_.length === 0 ||
    (arguments_.length === 2 &&
      arguments_[0] === '--schema' &&
      Boolean(arguments_[1]))
  if (!validArguments) {
    process.stderr.write(
      'Usage: node scripts/check-compatibility-fixtures.mjs [--schema PATH]\n'
    )
    process.exitCode = 1
  } else {
    const schemaPath = arguments_[1]
    checkCompatibilityFixtures({ schemaPath })
      .then(({ manifestCount }) => {
        process.stdout.write(
          `Compatibility fixtures are pinned and valid (${manifestCount} manifests).\n`
        )
      })
      .catch((error) => {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 1
      })
  }
}
