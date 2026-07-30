import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunEvent } from '../shared/types'
import {
  PACKAGED_CLI_SMOKE_DOES_NOT_PROVE,
  PACKAGED_CLI_SMOKE_PROVES,
  PackagedCliSmokeTrustAuthority,
  runPackagedCliSmoke
} from './packaged-cli-smoke'
import type { PackagedSmokeConfig } from './packaged-smoke'
import { ProviderOperationGate } from './provider-operation-gate'
import { ProviderService } from './provider-service'
import {
  createBuiltinAdapterRegistry,
  createRegisteredAgentRuntimeFactory,
  createRegisteredModelRuntimeFactory,
  resolveBuiltinAgentRuntimeBinding,
  resolveBuiltinModelAdapterBinding,
  RunManager
} from './run-manager'
import type { SecretVault } from './secrets'
import { createProcessLaunchEnvelope } from './process-launch'
import { StateStore } from './store'
import { CliTrustRegistry, WorkspaceGrantRegistry } from './trust-boundary'

const TOKEN = '0123456789abcdef0123456789abcdef'
const temporaryDirectories: string[] = []
const runManagers: RunManager[] = []
const environmentRestorations: Array<() => void> = []
const BLOCKED_ENVIRONMENT = new Set([
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'CODEX_CA_CERTIFICATE',
  'CODEX_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE'
])

function inMemoryVault(): SecretVault {
  const values = new Map<string, string>()
  return {
    get: (reference: string) => values.get(reference),
    has: (reference: string) => values.has(reference),
    set: async (reference: string, value: string) => {
      values.set(reference, value)
    },
    delete: async (reference: string) => {
      values.delete(reference)
    },
    deleteMany: async (references: Iterable<string>) => {
      for (const reference of references) values.delete(reference)
    },
    assertSteadyState: () => {
      // This fixture does not configure a CLI environment.
    }
  } as unknown as SecretVault
}

async function prepareRunnerEnvironment(): Promise<void> {
  const previous = new Map<string, string | undefined>()
  for (const name of Object.keys(process.env)) {
    if (!BLOCKED_ENVIRONMENT.has(name.toUpperCase())) continue
    previous.set(name, process.env[name])
    delete process.env[name]
  }
  previous.set('PATH', process.env.PATH)
  const runnerDirectory = path.dirname(await realpath(process.execPath))
  process.env.PATH = [
    runnerDirectory,
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((entry) => entry && path.isAbsolute(entry))
      .filter((entry) => path.resolve(entry) !== runnerDirectory)
  ].join(path.delimiter)
  environmentRestorations.push(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

interface CliSmokeHarness {
  config: PackagedSmokeConfig
  statePath: string
  store: StateStore
  providers: ProviderService
  runs: RunManager
  workspaceGrants: WorkspaceGrantRegistry
  trustAuthority: PackagedCliSmokeTrustAuthority
  events: RunEvent[]
}

async function createHarness(): Promise<CliSmokeHarness> {
  await prepareRunnerEnvironment()
  const parent = await mkdtemp(
    path.join(os.tmpdir(), 'ground-packaged-cli-test-')
  )
  temporaryDirectories.push(parent)
  const directory = path.join(parent, `ground-packaged-smoke-${TOKEN}`)
  const userDataPath = path.join(directory, 'user-data')
  await mkdir(userDataPath, { recursive: true, mode: 0o700 })
  const config: PackagedSmokeConfig = {
    token: TOKEN,
    scope: 'native',
    directory,
    userDataPath,
    resultPath: path.join(directory, 'result.json')
  }
  const statePath = path.join(userDataPath, 'ground-state.json')
  const store = new StateStore(statePath)
  await store.load()
  const vault = inMemoryVault()
  const workspaceGrants = new WorkspaceGrantRegistry()
  const providerOperations = new ProviderOperationGate()
  const events: RunEvent[] = []
  const trustAuthority = new PackagedCliSmokeTrustAuthority(config)
  const cliTrust = new CliTrustRegistry(trustAuthority.confirm)
  const authorizeInvocation = (
    request: Parameters<CliTrustRegistry['authorizeInvocation']>[0]
  ) => cliTrust.authorizeInvocation(request)
  const adapterRegistry = createBuiltinAdapterRegistry(
    authorizeInvocation
  )
  const runs = new RunManager(
    store,
    vault,
    (event) => events.push(structuredClone(event)),
    createRegisteredModelRuntimeFactory(
      adapterRegistry,
      resolveBuiltinModelAdapterBinding
    ),
    undefined,
    authorizeInvocation,
    providerOperations,
    (candidate) => workspaceGrants.requireStoredPath(candidate),
    createRegisteredAgentRuntimeFactory(
      adapterRegistry,
      resolveBuiltinAgentRuntimeBinding
    ),
    async (provider) => {
      if (provider.kind === 'cli') await cliTrust.authorize(provider)
    }
  )
  runManagers.push(runs)
  const providers = new ProviderService(
    store,
    vault,
    cliTrust,
    (providerId) => runs.isProviderActive(providerId),
    providerOperations,
    () =>
      store
        .snapshot()
        .tasks.map((task) => task.workspacePath)
        .filter((candidate): candidate is string => Boolean(candidate))
  )
  return {
    config,
    statePath,
    store,
    providers,
    runs,
    workspaceGrants,
    trustAuthority,
    events
  }
}

afterEach(async () => {
  await Promise.all(runManagers.splice(0).map((runs) => runs.stopAll()))
  for (const restore of environmentRestorations.splice(0).reverse()) {
    restore()
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
  )
})

describe('packaged recognized CLI smoke', () => {
  it('runs a deterministic Codex child through production trust and persistence', async () => {
    const harness = await createHarness()

    const evidence = await runPackagedCliSmoke({
      config: harness.config,
      store: harness.store,
      providers: harness.providers,
      runs: harness.runs,
      workspaceGrants: harness.workspaceGrants,
      trustAuthority: harness.trustAuthority,
      runEvents: () => harness.events
    })

    expect(evidence).toEqual({
      version: 1,
      fixture: {
        dialect: 'codex',
        adapterId: 'openai.codex-cli',
        binding: 'token-bound-runner-node-child',
        selection: 'source-registered-recognized-adapter',
        passiveDetectionExercised: false,
        externalCredentialsUsed: false,
        externalVendorCliUsed: false,
        runnerNodeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        scriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        structuredRecordsEmitted: 7,
        stdinPromptTokenObserved: true
      },
      readiness: {
        passed: true,
        persisted: true,
        scope: 'configuration'
      },
      trust: {
        configurationAuthorizations: 1,
        invocationAuthorizations: 1,
        exactLaunchEnvelopeValidated: true,
        exactConfigurationValidated: true,
        exactInvocationValidated: true,
        fixtureRevalidatedBeforeEachAuthorization: true,
        humanApprovalExercised: false
      },
      firstTurn: {
        runCompletedEventObserved: true,
        taskIdleAfterStateReload: true,
        assistantMarkerPersisted: true,
        providerAttributionPersisted: true,
        runtimeSessionPersisted: true,
        successfulCommandLifecyclePersisted: true,
        usagePersisted: true,
        warningNoticeCount: 1,
        noFailurePersisted: true
      },
      claims: {
        proves: [...PACKAGED_CLI_SMOKE_PROVES],
        doesNotProve: [...PACKAGED_CLI_SMOKE_DOES_NOT_PROVE]
      }
    })
    expect(JSON.stringify(evidence)).not.toContain(TOKEN)
    expect(
      harness.events.filter((event) => event.type === 'run-completed')
    ).toHaveLength(1)
    expect(
      harness.events.some((event) => event.type === 'run-error')
    ).toBe(false)

    const reloaded = new StateStore(harness.statePath)
    await reloaded.load()
    const task = reloaded.snapshot().tasks[0]
    expect(task).toMatchObject({
      runStatus: 'idle',
      mode: 'agent'
    })
    expect(
      task?.items.find(
        (item) =>
          item.kind === 'activity' &&
          item.title === 'Runtime notices'
      )
    ).toMatchObject({
      activityType: 'diagnostic',
      status: 'success'
    })
    expect(
      task?.items.some(
        (item) =>
          item.kind === 'activity' &&
          (item.activityType === 'error' || item.status === 'error')
      )
    ).toBe(false)
  })

  it('rejects a non-native or mismatched token boundary before arming trust', () => {
    expect(
      () =>
        new PackagedCliSmokeTrustAuthority({
          token: TOKEN,
          scope: 'launch',
          directory: path.join(
            os.tmpdir(),
            `ground-packaged-smoke-${TOKEN}`
          ),
          userDataPath: path.join(
            os.tmpdir(),
            `ground-packaged-smoke-${TOKEN}`,
            'user-data'
          ),
          resultPath: path.join(os.tmpdir(), 'result.json')
        })
    ).toThrow(/requires a valid native token/iu)
  })

  it('rejects fixture mutation between configuration and invocation authorization', async () => {
    const parent = await mkdtemp(
      path.join(os.tmpdir(), 'ground-packaged-cli-trust-test-')
    )
    temporaryDirectories.push(parent)
    const directory = path.join(
      parent,
      `ground-packaged-smoke-${TOKEN}`
    )
    const fixtureDirectory = path.join(directory, 'recognized-cli')
    const workspacePath = path.join(directory, 'cli-workspace')
    const userDataPath = path.join(directory, 'user-data')
    await Promise.all([
      mkdir(fixtureDirectory, { recursive: true, mode: 0o700 }),
      mkdir(workspacePath, { recursive: true, mode: 0o700 }),
      mkdir(userDataPath, { recursive: true, mode: 0o700 })
    ])
    const config: PackagedSmokeConfig = {
      token: TOKEN,
      scope: 'native',
      directory,
      userDataPath,
      resultPath: path.join(directory, 'result.json')
    }
    const authority = new PackagedCliSmokeTrustAuthority(config)
    const runnerPath = await realpath(process.execPath)
    const runnerSha256 = createHash('sha256')
      .update(await readFile(runnerPath))
      .digest('hex')
    const fixturePath = path.join(
      fixtureDirectory,
      'ground-codex-child.cjs'
    )
    await writeFile(fixturePath, 'original\n', {
      flag: 'wx',
      mode: 0o600
    })
    const canonicalFixturePath = await realpath(fixturePath)
    const fixtureSha256 = createHash('sha256')
      .update('original\n')
      .digest('hex')
    const canonicalWorkspace = await realpath(workspacePath)
    const configurationArgs = [canonicalFixturePath, 'configuration']
    const invocationArgs = [canonicalFixturePath, 'invocation']
    authority.arm({
      runnerPath,
      runnerSha256,
      fixturePath: canonicalFixturePath,
      fixtureSha256,
      workspacePath: canonicalWorkspace,
      configurationArgs,
      invocationArgs
    })
    const launch = await createProcessLaunchEnvelope(runnerPath)
    await expect(
      authority.confirm({
        phase: 'configuration',
        launch,
        args: configurationArgs,
        promptMode: 'stdin',
        outputMode: 'ndjson',
        runtimeAdapterId: 'openai.codex-cli',
        cliAdapter: 'codex',
        environmentVariables: [],
        fingerprint: 'a'.repeat(64)
      })
    ).resolves.toBe(true)

    await writeFile(canonicalFixturePath, 'mutated\n')
    await expect(
      authority.confirm({
        phase: 'invocation',
        launch,
        args: invocationArgs,
        promptMode: 'stdin',
        outputMode: 'ndjson',
        runtimeAdapterId: 'openai.codex-cli',
        cliAdapter: 'codex',
        environmentVariables: [],
        cwd: canonicalWorkspace,
        prompt: { transport: 'stdin' },
        fingerprint: 'b'.repeat(64)
      })
    ).rejects.toThrow(/launch material changed/iu)
  })
})
