import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunEvent } from '../shared/types'
import {
  PACKAGED_PROVIDER_FAILURE_SMOKE_DOES_NOT_PROVE,
  PACKAGED_PROVIDER_FAILURE_SMOKE_PROVES,
  runPackagedProviderFailureSmoke
} from './packaged-provider-failure-smoke'
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
import { StateStore } from './store'
import { CliTrustRegistry, WorkspaceGrantRegistry } from './trust-boundary'

const TOKEN = '0123456789abcdef0123456789abcdef'
const temporaryDirectories: string[] = []
const runManagers: RunManager[] = []

function keylessVault(): SecretVault {
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
      // This keyless fixture never approaches vault capacity.
    }
  } as unknown as SecretVault
}

interface FailureSmokeHarness {
  directory: string
  userDataPath: string
  statePath: string
  store: StateStore
  providers: ProviderService
  runs: RunManager
  workspaceGrants: WorkspaceGrantRegistry
  events: RunEvent[]
}

async function createHarness(): Promise<FailureSmokeHarness> {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), 'ground-packaged-provider-failure-test-')
  )
  temporaryDirectories.push(parent)
  const directory = path.join(parent, `ground-packaged-smoke-${TOKEN}`)
  const userDataPath = path.join(directory, 'user-data')
  await mkdir(userDataPath, { recursive: true, mode: 0o700 })
  const statePath = path.join(userDataPath, 'ground-state.json')
  const store = new StateStore(statePath)
  await store.load()
  const vault = keylessVault()
  const workspaceGrants = new WorkspaceGrantRegistry()
  const providerOperations = new ProviderOperationGate()
  const events: RunEvent[] = []
  const adapterRegistry = createBuiltinAdapterRegistry()
  const runs = new RunManager(
    store,
    vault,
    (event) => events.push(structuredClone(event)),
    createRegisteredModelRuntimeFactory(
      adapterRegistry,
      resolveBuiltinModelAdapterBinding
    ),
    undefined,
    undefined,
    providerOperations,
    (candidate) => workspaceGrants.requireStoredPath(candidate),
    createRegisteredAgentRuntimeFactory(
      adapterRegistry,
      resolveBuiltinAgentRuntimeBinding
    )
  )
  runManagers.push(runs)
  const providers = new ProviderService(
    store,
    vault,
    new CliTrustRegistry(async () => false),
    (providerId) => runs.isProviderActive(providerId),
    providerOperations,
    () =>
      store
        .snapshot()
        .tasks.map((task) => task.workspacePath)
        .filter((candidate): candidate is string => Boolean(candidate))
  )
  return {
    directory,
    userDataPath,
    statePath,
    store,
    providers,
    runs,
    workspaceGrants,
    events
  }
}

afterEach(async () => {
  await Promise.all(runManagers.splice(0).map((runs) => runs.stopAll()))
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('packaged provider expected-failure smoke', () => {
  it('proves unavailable and malformed readiness fail durably before dispatch', async () => {
    const harness = await createHarness()

    const evidence = await runPackagedProviderFailureSmoke({
      token: TOKEN,
      directory: harness.directory,
      userDataPath: harness.userDataPath,
      store: harness.store,
      providers: harness.providers,
      runs: harness.runs,
      workspaceGrants: harness.workspaceGrants,
      runEvents: () => harness.events
    })

    expect(evidence).toEqual({
      version: 1,
      fixture: {
        protocol: 'openai-compatible',
        binding: 'token-bound-literal-loopback',
        externalCredentialsUsed: false,
        malformedModelDiscoveryRequests: 1,
        malformedGenerationRequests: 1
      },
      unavailableLoopback: {
        expectedFailureObserved: true,
        failureKind: 'connection-refused',
        failedConnectionReadinessPersisted: true,
        correctiveGuidanceObserved: true,
        genericFetchFailureHidden: true,
        runBlockedBeforeDispatch: true
      },
      malformedResponse: {
        expectedFailureObserved: true,
        phase: 'readiness',
        failedConnectionReadinessPersisted: true,
        invalidAssistantShapeObserved: true,
        notMisclassifiedAsConnectionRefused: true,
        runBlockedBeforeDispatch: true
      },
      claims: {
        proves: [...PACKAGED_PROVIDER_FAILURE_SMOKE_PROVES],
        doesNotProve: [...PACKAGED_PROVIDER_FAILURE_SMOKE_DOES_NOT_PROVE]
      }
    })
    expect(JSON.stringify(evidence)).not.toContain(TOKEN)
    expect(harness.events).toEqual([])

    const reloaded = new StateStore(harness.statePath)
    await reloaded.load()
    const failureProviders = reloaded
      .snapshot()
      .providers.filter((provider) =>
        [
          'Packaged unavailable loopback',
          'Packaged malformed compatible'
        ].includes(provider.name)
      )
    expect(failureProviders).toHaveLength(2)
    expect(
      failureProviders.every(
        (provider) =>
          provider.verification?.status === 'failed' &&
          provider.verification.scope === 'connection'
      )
    ).toBe(true)
    expect(reloaded.snapshot().tasks).toHaveLength(2)
    expect(
      reloaded
        .snapshot()
        .tasks.every(
          (task) =>
            task.runStatus === 'idle' &&
            task.items.length === 0 &&
            task.modelSessions === undefined &&
            task.runtimeSessions === undefined
        )
    ).toBe(true)
  })

  it('rejects a mismatched token-bound root before mutating state', async () => {
    const harness = await createHarness()
    const otherToken = 'abcdef0123456789abcdef0123456789'
    const before = harness.store.snapshot()

    await expect(
      runPackagedProviderFailureSmoke({
        token: otherToken,
        directory: harness.directory,
        userDataPath: harness.userDataPath,
        store: harness.store,
        providers: harness.providers,
        runs: harness.runs,
        workspaceGrants: harness.workspaceGrants,
        runEvents: () => harness.events
      })
    ).rejects.toThrow(/requires token-bound user data/iu)
    expect(harness.store.snapshot()).toEqual(before)
    expect(harness.events).toEqual([])
  })
})
