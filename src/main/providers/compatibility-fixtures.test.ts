import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import {
  AiSdkModelAdapter,
  type AiSdkProtocol
} from '../agent/ai-sdk-adapter'
import type { ModelEvent, ModelRequest } from '../agent/types'
import { parseCliRuntimeEvent, type CliRuntimeEvent } from './cli'

interface FixtureSuiteBase {
  id: string
  kind: 'api' | 'cli'
  provenance: 'synthetic-contract' | 'documented-example'
  provenanceNote: string
  liveCapture: false
}

interface CliFixtureCase {
  id: string
  description: string
  inputEvents: Array<Record<string, unknown>>
  expectedCanonicalEvents: CliRuntimeEvent[]
}

interface CliFixtureManifest {
  schemaVersion: 1
  suite: FixtureSuiteBase & {
    kind: 'cli'
    adapter: 'codex' | 'claude' | 'gemini' | 'antigravity'
    runtime: string
    version: string
    fixtureDate: string
  }
  cases: CliFixtureCase[]
}

interface ApiFixtureCase {
  id: string
  description: string
  request: ModelRequest
  inputEvents: LanguageModelV4StreamPart[]
  expectedCanonicalEvents: ModelEvent[]
}

interface ApiFixtureManifest {
  schemaVersion: 1
  suite: FixtureSuiteBase & {
    kind: 'api'
    adapterBoundary: 'ai-sdk-language-model-v4'
    protocols: AiSdkProtocol[]
    packages: Record<string, string>
    fixtureDate: string
  }
  cases: ApiFixtureCase[]
}

interface ManifestSchemaShape {
  oneOf: Array<{ $ref: string }>
  $defs: {
    cliSuite: {
      properties: {
        kind: {
          const: string
        }
      }
    }
  }
}

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'fixtures', 'compatibility')
const CLI_MANIFEST_PATHS = [
  'cli/codex-0.144.1.json',
  'cli/claude-2.1.218.json',
  'cli/gemini-0.47.0.json',
  'cli/antigravity-1.1.8.json'
]

async function readFixture<T>(relativePath: string): Promise<T> {
  return JSON.parse(
    await readFile(path.join(FIXTURE_ROOT, relativePath), 'utf8')
  ) as T
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function collectModelEvents(
  iterable: AsyncIterable<ModelEvent>
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('version-pinned compatibility fixtures', () => {
  it('passes the strict schema and package/declaration drift check', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(PROJECT_ROOT, 'scripts', 'check-compatibility-fixtures.mjs')],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8'
      }
    )
    expect(output).toMatch(/pinned and valid \(5 manifests\)/u)
  })

  it('rejects corrupted published schema constraints and references', async () => {
    const original = await readFixture<ManifestSchemaShape>(
      'manifest.schema.json'
    )
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), 'ground-compatibility-schema-')
    )
    try {
      const mutations: Array<{
        name: string
        mutate: (schema: ManifestSchemaShape) => void
        expectedError: RegExp
      }> = [
        {
          name: 'constraint',
          mutate: (schema) => {
            schema.$defs.cliSuite.properties.kind.const = 'corrupted-cli-kind'
          },
          expectedError: /does not satisfy manifest\.schema\.json/iu
        },
        {
          name: 'reference',
          mutate: (schema) => {
            schema.oneOf[0]!.$ref = '#/$defs/missingCliManifest'
          },
          expectedError: /does not compile as draft-2020-12 JSON Schema/iu
        }
      ]

      for (const mutation of mutations) {
        const schema = structuredClone(original)
        mutation.mutate(schema)
        const schemaPath = path.join(
          temporaryDirectory,
          `${mutation.name}.schema.json`
        )
        await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`)
        const result = spawnSync(
          process.execPath,
          [
            path.join(
              PROJECT_ROOT,
              'scripts',
              'check-compatibility-fixtures.mjs'
            ),
            '--schema',
            schemaPath
          ],
          {
            cwd: PROJECT_ROOT,
            encoding: 'utf8'
          }
        )
        expect(result.status, result.stderr).toBe(1)
        expect(result.stderr).toMatch(mutation.expectedError)
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('feeds every pinned CLI event case through the production parser', async () => {
    for (const manifestPath of CLI_MANIFEST_PATHS) {
      const manifest = await readFixture<CliFixtureManifest>(manifestPath)
      for (const fixtureCase of manifest.cases) {
        const actual = fixtureCase.inputEvents.flatMap((event) =>
          parseCliRuntimeEvent(manifest.suite.adapter, event)
        )
        expect(
          actual,
          `${manifest.suite.id}/${fixtureCase.id}: ${fixtureCase.description}`
        ).toEqual(fixtureCase.expectedCanonicalEvents)
      }
    }
  })

  it('feeds pinned AI SDK contract events through every production API adapter boundary', async () => {
    const manifest = await readFixture<ApiFixtureManifest>(
      'api/ai-sdk-v4-locked.json'
    )

    for (const protocol of manifest.suite.protocols) {
      for (const fixtureCase of manifest.cases) {
        const model = new MockLanguageModelV4({
          provider: `fixture-${protocol}`,
          modelId: fixtureCase.request.model,
          doStream: {
            stream: simulateReadableStream<LanguageModelV4StreamPart>({
              chunks: structuredClone(fixtureCase.inputEvents),
              initialDelayInMs: null,
              chunkDelayInMs: null
            })
          }
        })
        const adapter = new AiSdkModelAdapter(protocol, () => model)
        const config =
          protocol === 'openai-compatible'
            ? {
                protocol,
                baseUrl: 'http://127.0.0.1:11434/v1'
              }
            : {
                protocol,
                apiKeyRef: 'fixture-secret'
              }
        const actual = await collectModelEvents(
          adapter.stream(structuredClone(fixtureCase.request), {
            config,
            signal: new AbortController().signal,
            secrets: {
              resolve: async () => 'fixture-key-never-sent'
            }
          })
        )

        expect(
          jsonRoundTrip(actual),
          `${protocol}/${fixtureCase.id}: ${fixtureCase.description}`
        ).toEqual(fixtureCase.expectedCanonicalEvents)
      }
    }
  })
})
