import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
      // This focused fixture never approaches vault capacity.
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
    const vault = inMemoryVault()
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
      version: 2,
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
      openAiResponses: {
        fixture: {
          providerKind: 'openai',
          protocol: 'openai-responses',
          adapterId: 'openai.responses',
          binding: 'token-bound-literal-loopback',
          externalCredentialsUsed: false,
          syntheticCredentialAuthorizationValidated: true,
          modelDiscoveryRequests: 1,
          streamingResponseRequests: 1,
          streamedContentChunks: 2,
          responsesRequestValidated: true,
          storeDisabled: true
        },
        credentials: {
          required: true,
          versionedReferencePersisted: true,
          reusedForReadiness: true,
          reusedForFirstTurn: true,
          absentFromPersistedState: true
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
        }
      },
      claims: {
        proves: [...PACKAGED_PROVIDER_SMOKE_PROVES],
        doesNotProve: [...PACKAGED_PROVIDER_SMOKE_DOES_NOT_PROVE]
      }
    })
    expect(
      events.filter((event) => event.type === 'run-completed')
    ).toHaveLength(2)
    expect(events.some((event) => event.type === 'run-error')).toBe(false)
    expect(JSON.stringify(evidence)).not.toContain(
      'ground-packaged-fixture-'
    )

    const reloaded = new StateStore(statePath)
    await reloaded.load()
    const snapshot = reloaded.snapshot()
    const tasks = snapshot.tasks
    expect(tasks).toHaveLength(2)
    const openAiProvider = snapshot.providers.find(
      (provider) => provider.kind === 'openai'
    )
    expect(openAiProvider).toMatchObject({
      kind: 'openai',
      model: 'ground-packaged-openai-responses',
      hasApiKey: true,
      verification: {
        status: 'passed',
        scope: 'connection'
      }
    })
    expect(openAiProvider?.credentialRevision).toMatch(
      /^credential_/u
    )
    expect(
      tasks.find((task) =>
        task.items.some(
          (item) =>
            item.kind === 'message' &&
            item.role === 'assistant' &&
            item.provider?.kind === 'openai-compatible'
        )
      )
    ).toMatchObject({
      runStatus: 'idle',
      mode: 'agent'
    })
    const openAiTask = tasks.find(
      (task) => task.providerId === openAiProvider?.id
    )
    expect(
      openAiProvider
        ? openAiTask?.modelSessions?.[openAiProvider.id]
        : undefined
    ).toMatchObject({
      adapterId: 'openai.responses',
      origin: 'ground',
      model: 'ground-packaged-openai-responses'
    })
    expect(
      tasks
        .flatMap((task) => task.items)
        .find(
          (item) =>
            item.kind === 'message' &&
            item.role === 'assistant' &&
            item.provider?.kind === 'openai-compatible'
        )
    ).toMatchObject({
      content: `ground-packaged-provider-ok-${TOKEN}`,
      provider: {
        kind: 'openai-compatible',
        model: 'ground-packaged-compatible'
      }
    })
    expect(
      tasks.find((task) =>
        task.items.some(
          (item) =>
            item.kind === 'message' &&
            item.role === 'assistant' &&
            item.provider?.kind === 'openai'
        )
      )
    ).toMatchObject({
      runStatus: 'idle',
      mode: 'agent'
    })
    expect(
      tasks
        .flatMap((task) => task.items)
        .find(
          (item) =>
            item.kind === 'message' &&
            item.role === 'assistant' &&
            item.provider?.kind === 'openai'
        )
    ).toMatchObject({
      content:
        `ground-packaged-openai-responses-ok-${TOKEN}`,
      provider: {
        kind: 'openai',
        model: 'ground-packaged-openai-responses'
      }
    })
    expect(await readFile(statePath, 'utf8')).not.toContain(
      'ground-packaged-fixture-'
    )
  })
})
