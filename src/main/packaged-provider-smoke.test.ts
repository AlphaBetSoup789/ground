import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunEvent } from '../shared/types'
import {
  PACKAGED_PROVIDER_SMOKE_DOES_NOT_PROVE,
  PACKAGED_PROVIDER_SMOKE_PROVES,
  runPackagedProviderSmoke
} from './packaged-provider-smoke'
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
import {
  CliTrustRegistry,
  WorkspaceGrantRegistry
} from './trust-boundary'

const TOKEN = '0123456789abcdef0123456789abcdef'
const temporaryDirectories: string[] = []

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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('packaged provider first-turn smoke', () => {
  it('crosses production readiness, registry, RunManager, and durable state', async () => {
    const parent = await mkdtemp(
      path.join(os.tmpdir(), 'ground-packaged-provider-test-')
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

    const evidence = await runPackagedProviderSmoke({
      token: TOKEN,
      directory,
      userDataPath,
      store,
      providers,
      runs,
      workspaceGrants,
      runEvents: () => events
    })

    expect(evidence).toMatchObject({
      fixture: {
        protocol: 'openai-compatible',
        binding: 'token-bound-literal-loopback',
        externalCredentialsUsed: false,
        modelDiscoveryRequests: 1,
        streamingCompletionRequests: 1,
        streamedContentChunks: 2
      },
      readiness: {
        passed: true,
        persisted: true,
        scope: 'connection'
      },
      firstTurn: {
        runCompletedEventObserved: true,
        taskIdleAfterStateReload: true,
        assistantMarkerPersisted: true,
        providerAttributionPersisted: true,
        modelSessionPersisted: true,
        noFailurePersisted: true
      },
      claims: {
        proves: [...PACKAGED_PROVIDER_SMOKE_PROVES],
        doesNotProve: [...PACKAGED_PROVIDER_SMOKE_DOES_NOT_PROVE]
      }
    })
    expect(events.some((event) => event.type === 'run-completed')).toBe(true)
    expect(events.some((event) => event.type === 'run-error')).toBe(false)

    const reloaded = new StateStore(statePath)
    await reloaded.load()
    const task = reloaded.snapshot().tasks[0]
    expect(task).toMatchObject({
      runStatus: 'idle',
      mode: 'agent'
    })
    expect(
      task?.items.find(
        (item) => item.kind === 'message' && item.role === 'assistant'
      )
    ).toMatchObject({
      content: `ground-packaged-provider-ok-${TOKEN}`,
      provider: {
        kind: 'openai-compatible',
        model: 'ground-packaged-compatible'
      }
    })
  })
})
