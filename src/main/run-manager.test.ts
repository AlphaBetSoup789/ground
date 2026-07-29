import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  ModelApiProvider,
  ProviderProfile,
  RunEvent
} from '../shared/types'
import type {
  AiSdkAdapterConfig,
  JsonObject,
  ModelAdapter,
  ModelEvent,
  ModelRequest
} from './agent'
import {
  createModelRuntime,
  modelRequestByteBudget,
  RunManager,
  selectModelContext,
  type McpRuntime,
  type ModelRuntimeFactory
} from './run-manager'
import {
  providerCredentialReference,
  providerCredentialReferenceFor
} from './provider-credentials'
import { agentApprovalFingerprint } from './native-agent-approval'
import { ProviderOperationGate } from './provider-operation-gate'
import { providerConfigurationFingerprint } from './provider-revision'
import { SecretVault } from './secrets'
import {
  StatePersistenceError,
  StateStore
} from './store'

type ModelScript = (request: ModelRequest) => AsyncIterable<ModelEvent>

function scriptedRuntime(
  scripts: ModelScript[],
  requests: ModelRequest[]
): ModelRuntimeFactory {
  let index = 0
  const adapter = {
    id: 'test.model',
    stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request))
      const script = scripts[index]
      index += 1
      if (!script) throw new Error(`Unexpected model round ${index}`)
      return script(request)
    }
  } as unknown as ModelAdapter<AiSdkAdapterConfig>
  return () => ({
    adapter,
    adapterId: adapter.id,
    config: {
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1'
    }
  })
}

function credentialResolvingRuntime(
  referenceFor: (provider: ModelApiProvider) => string,
  observed: { secret?: string }
): ModelRuntimeFactory {
  return (provider) => {
    const config: AiSdkAdapterConfig = {
      protocol: 'openai-compatible',
      baseUrl: provider.baseUrl,
      apiKeyRef: referenceFor(provider)
    }
    const adapter = {
      id: 'credential.test',
      stream(
        request: ModelRequest,
        context: {
          config: AiSdkAdapterConfig
          secrets: { resolve(reference: string): Promise<string> }
        }
      ): AsyncIterable<ModelEvent> {
        return (async function* () {
          observed.secret = await context.secrets.resolve(
            context.config.apiKeyRef as string
          )
          yield* textResponse(request, 'Credential resolved.')
        })()
      }
    } as unknown as ModelAdapter<AiSdkAdapterConfig>
    return { adapter, adapterId: adapter.id, config }
  }
}

function credentialFailingRuntime(
  failure: (secret: string) => Error,
  options?: {
    beforeFailure?: Promise<void>
    onCredentialResolved?: () => void
  }
): ModelRuntimeFactory {
  return (provider) => {
    const reference = providerCredentialReferenceFor(provider)
    const config: AiSdkAdapterConfig = {
      protocol: 'openai-compatible',
      baseUrl: provider.baseUrl,
      apiKeyRef: reference
    }
    const adapter = {
      id: 'credential.failure-test',
      stream(
        _request: ModelRequest,
        context: {
          secrets: { resolve(reference: string): Promise<string> }
        }
      ): AsyncIterable<ModelEvent> {
        return (async function* () {
          const secret = await context.secrets.resolve(reference)
          options?.onCredentialResolved?.()
          await options?.beforeFailure
          throw failure(secret)
        })()
      }
    } as unknown as ModelAdapter<AiSdkAdapterConfig>
    return { adapter, adapterId: adapter.id, config }
  }
}

function credentialReflectingRuntime(
  events: (
    secret: string,
    request: ModelRequest
  ) => AsyncIterable<ModelEvent>
): ModelRuntimeFactory {
  return (provider) => {
    const config: AiSdkAdapterConfig = {
      protocol: 'openai-compatible',
      baseUrl: provider.baseUrl,
      apiKeyRef: providerCredentialReferenceFor(provider)
    }
    const adapter = {
      id: 'credential.reflection-test',
      stream(
        request: ModelRequest,
        context: {
          secrets: { resolve(reference: string): Promise<string> }
        }
      ): AsyncIterable<ModelEvent> {
        return (async function* () {
          const secret = await context.secrets.resolve(
            config.apiKeyRef as string
          )
          yield* events(secret, request)
        })()
      }
    } as unknown as ModelAdapter<AiSdkAdapterConfig>
    return { adapter, adapterId: adapter.id, config }
  }
}

function credentialRacingRuntime(): ModelRuntimeFactory {
  return (provider) => {
    const config: AiSdkAdapterConfig = {
      protocol: 'openai-compatible',
      baseUrl: provider.baseUrl,
      apiKeyRef: providerCredentialReferenceFor(provider)
    }
    const adapter = {
      id: 'credential.race-test',
      stream(
        request: ModelRequest,
        context: {
          secrets: { resolve(reference: string): Promise<string> }
        }
      ): AsyncIterable<ModelEvent> {
        return (async function* () {
          const credential = context.secrets.resolve(
            config.apiKeyRef as string
          )
          yield { type: 'response.started', servingModel: request.model }
          yield* textResponse(request, await credential)
        })()
      }
    } as unknown as ModelAdapter<AiSdkAdapterConfig>
    return { adapter, adapterId: adapter.id, config }
  }
}

function credentialVault(initial: Iterable<[string, string]> = []): {
  instance: SecretVault
  entries: Map<string, string>
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
} {
  const entries = new Map(initial)
  const get = vi.fn((reference: string) => entries.get(reference))
  const set = vi.fn(async (reference: string, value: string) => {
    entries.set(reference, value)
  })
  const remove = vi.fn(async (reference: string) => {
    entries.delete(reference)
  })
  return {
    instance: {
      get,
      has: vi.fn((reference: string) => entries.has(reference)),
      set,
      delete: remove
    } as unknown as SecretVault,
    entries,
    get,
    set,
    delete: remove
  }
}

async function* toolCallResponse(
  request: ModelRequest,
  name: string,
  input: JsonObject,
  fixedCallId?: string
): AsyncIterable<ModelEvent> {
  const callId = fixedCallId ?? `${request.requestId}:call`
  const rawArguments = JSON.stringify(input)
  yield { type: 'response.started', servingModel: request.model }
  yield {
    type: 'part.started',
    part: { kind: 'tool-call', partId: callId, callId, name }
  }
  yield {
    type: 'part.delta',
    partId: callId,
    delta: { kind: 'tool-arguments', text: rawArguments }
  }
  yield {
    type: 'part.completed',
    partId: callId,
    part: {
      kind: 'tool-call',
      callId,
      name,
      rawArguments,
      arguments: input
    }
  }
  yield {
    type: 'response.completed',
    messageId: `${request.requestId}:assistant`,
    stopReason: 'tool-calls'
  }
}

async function* multipleToolCallResponse(
  request: ModelRequest,
  calls: ReadonlyArray<{
    name: string
    input: JsonObject
  }>
): AsyncIterable<ModelEvent> {
  yield { type: 'response.started', servingModel: request.model }
  for (const [index, call] of calls.entries()) {
    const callId = `${request.requestId}:call:${index + 1}`
    const rawArguments = JSON.stringify(call.input)
    yield {
      type: 'part.started',
      part: { kind: 'tool-call', partId: callId, callId, name: call.name }
    }
    yield {
      type: 'part.completed',
      partId: callId,
      part: {
        kind: 'tool-call',
        callId,
        name: call.name,
        rawArguments,
        arguments: call.input
      }
    }
  }
  yield {
    type: 'response.completed',
    messageId: `${request.requestId}:assistant`,
    stopReason: 'tool-calls'
  }
}

async function* duplicateToolCallResponse(
  request: ModelRequest,
  name: string,
  input: JsonObject
): AsyncIterable<ModelEvent> {
  const callId = `${request.requestId}:duplicate`
  const rawArguments = JSON.stringify(input)
  yield { type: 'response.started', servingModel: request.model }
  for (const suffix of ['first', 'second']) {
    const partId = `${callId}:${suffix}`
    yield {
      type: 'part.started',
      part: { kind: 'tool-call', partId, callId, name }
    }
    yield {
      type: 'part.completed',
      partId,
      part: {
        kind: 'tool-call',
        callId,
        name,
        rawArguments,
        arguments: input
      }
    }
  }
  yield {
    type: 'response.completed',
    messageId: `${request.requestId}:assistant`,
    stopReason: 'tool-calls'
  }
}

async function* textResponse(
  request: ModelRequest,
  text: string,
  usage = false
): AsyncIterable<ModelEvent> {
  const partId = `${request.requestId}:text`
  yield { type: 'response.started', servingModel: request.model }
  yield { type: 'part.started', part: { kind: 'text', partId } }
  yield {
    type: 'part.delta',
    partId,
    delta: { kind: 'text', text }
  }
  yield {
    type: 'part.completed',
    partId,
    part: { kind: 'text', text }
  }
  if (usage) {
    yield {
      type: 'usage.updated',
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      semantics: 'cumulative'
    }
  }
  yield {
    type: 'response.completed',
    messageId: `${request.requestId}:assistant`,
    stopReason: 'complete'
  }
}

function terminalEvents(
  events: RunEvent[]
): {
  emit: (event: RunEvent) => void
  terminal: Promise<RunEvent>
  approval: Promise<Extract<RunEvent, { type: 'approval-requested' }>>
} {
  let resolveTerminal: (event: RunEvent) => void = () => undefined
  let resolveApproval: (
    event: Extract<RunEvent, { type: 'approval-requested' }>
  ) => void = () => undefined
  const terminal = new Promise<RunEvent>((resolve) => {
    resolveTerminal = resolve
  })
  const approval = new Promise<Extract<RunEvent, { type: 'approval-requested' }>>(
    (resolve) => {
      resolveApproval = resolve
    }
  )
  return {
    emit: (event) => {
      events.push(event)
      if (event.type === 'approval-requested') resolveApproval(event)
      if (
        event.type === 'run-completed' ||
        event.type === 'run-error' ||
        event.type === 'run-stopped'
      ) {
        resolveTerminal(event)
      }
    },
    terminal,
    approval
  }
}

async function approvePending(
  manager: RunManager,
  runId: string,
  approvalId: string
): Promise<void> {
  const pending = manager.getPendingApproval(runId, approvalId)
  await manager.resolveApproval(
    runId,
    approvalId,
    true,
    agentApprovalFingerprint(pending)
  )
}

async function harness(
  scripts: ModelScript[],
  mcp?: McpRuntime,
  options?: {
    vault?: SecretVault
    runtimeFactory?: ModelRuntimeFactory
    providerOperations?: ProviderOperationGate
    authorizeWorkspace?: (storedPath: string) => Promise<string>
    authorizeProviderStart?: (
      provider: Readonly<ProviderProfile>
    ) => Promise<void>
  }
): Promise<{
  directory: string
  workspace: string
  store: StateStore
  manager: RunManager
  taskId: string
  requests: ModelRequest[]
  events: RunEvent[]
  terminal: Promise<RunEvent>
  approval: Promise<Extract<RunEvent, { type: 'approval-requested' }>>
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-run-manager-'))
  const workspaceCandidate = path.join(directory, 'workspace')
  await mkdir(workspaceCandidate)
  const workspace = await realpath(workspaceCandidate)
  const store = new StateStore(path.join(directory, 'state.json'))
  await store.load()
  const defaultProviderId = store.snapshot().settings.defaultProviderId
  const defaultProvider = store.getProvider(defaultProviderId)
  await store.upsertProvider({
    ...defaultProvider,
    verification: {
      status: 'passed',
      scope: 'connection',
      checkedAt: '2026-07-29T12:00:00.000Z'
    }
  })
  const task = await store.createTask(workspace)
  const requests: ModelRequest[] = []
  const events: RunEvent[] = []
  const waiting = terminalEvents(events)
  const vault =
    options?.vault ??
    ({ get: () => undefined } as unknown as SecretVault)
  const manager = new RunManager(
    store,
    vault,
    waiting.emit,
    options?.runtimeFactory ?? scriptedRuntime(scripts, requests),
    mcp,
    undefined,
    options?.providerOperations,
    options?.authorizeWorkspace ?? ((candidate) => realpath(candidate)),
    undefined,
    options?.authorizeProviderStart
  )
  return {
    directory,
    workspace,
    store,
    manager,
    taskId: task.id,
    requests,
    events,
    terminal: waiting.terminal,
    approval: waiting.approval
  }
}

describe('RunManager model runtime', () => {
  it('fails before recording a run when the main process revokes the stored workspace', async () => {
    const authorizeWorkspace = vi.fn(async () => {
      throw new Error('Workspace access expired')
    })
    const run = await harness(
      [(request) => textResponse(request, 'Must not run.')],
      undefined,
      { authorizeWorkspace }
    )

    await expect(
      run.manager.start(run.taskId, 'Do not record this prompt')
    ).rejects.toThrow(/workspace access expired/i)
    expect(authorizeWorkspace).toHaveBeenCalledWith(run.workspace)
    expect(run.requests).toEqual([])
    expect(run.events).toEqual([])
    expect(run.store.getTask(run.taskId).items).toEqual([])
    expect(run.manager.isTaskActive(run.taskId)).toBe(false)
  })

  it('reserves a task while asynchronous workspace authorization is pending', async () => {
    let releaseWorkspace: () => void = () => undefined
    const workspaceGate = new Promise<void>((resolve) => {
      releaseWorkspace = resolve
    })
    const authorizeWorkspace = vi.fn(async (candidate: string) => {
      await workspaceGate
      return realpath(candidate)
    })
    const run = await harness(
      [(request) => textResponse(request, 'Only one run started.')],
      undefined,
      { authorizeWorkspace }
    )

    const first = run.manager.start(run.taskId, 'First prompt')
    await vi.waitFor(() => expect(authorizeWorkspace).toHaveBeenCalledTimes(1))
    await expect(
      run.manager.start(run.taskId, 'Concurrent prompt')
    ).rejects.toThrow(/already has a run in progress/i)

    releaseWorkspace()
    await expect(first).resolves.toMatch(/^run_/)
    expect((await run.terminal).type).toBe('run-completed')
    expect(authorizeWorkspace).toHaveBeenCalledTimes(1)
    expect(run.requests).toHaveLength(1)
    expect(
      run.store
        .getTask(run.taskId)
        .items.filter((item) => item.kind === 'message' && item.role === 'user')
        .map((item) => (item.kind === 'message' ? item.content : ''))
    ).toEqual(['First prompt'])
  })

  it('rechecks unresolved managed claims in the atomic run-start mutation', async () => {
    let releaseWorkspace: () => void = () => undefined
    const workspaceGate = new Promise<void>((resolve) => {
      releaseWorkspace = resolve
    })
    const run = await harness(
      [(request) => textResponse(request, 'Must not be requested.')],
      undefined,
      {
        authorizeWorkspace: async (candidate) => {
          await workspaceGate
          return realpath(candidate)
        }
      }
    )

    const starting = run.manager.start(run.taskId, 'Must not be recorded')
    await run.store.mutateTask(run.taskId, (task) => {
      task.runStatus = 'running'
      task.items.push({
        id: 'unresolved-operation',
        kind: 'activity',
        runId: 'earlier-run',
        activityType: 'tool',
        title: 'Earlier write',
        status: 'running',
        toolName: 'write_file',
        callId: 'earlier-call',
        createdAt: '2026-07-28T12:00:00.000Z',
        managedExecution: {
          version: 1,
          operationId: 'unresolved-operation',
          claim: 'approved',
          kind: 'workspace-write',
          actionSha256: 'a'.repeat(64),
          approvalSha256: 'b'.repeat(64),
          phase: 'started',
          startedAt: '2026-07-28T12:00:00.000Z'
        }
      })
    })
    releaseWorkspace()

    await expect(starting).rejects.toThrow(/unresolved outcome/i)
    expect(run.requests).toEqual([])
    expect(
      run.store
        .getTask(run.taskId)
        .items.some(
          (item) =>
            item.kind === 'message' && item.content === 'Must not be recorded'
        )
    ).toBe(false)
  })

  it('refuses to start archived tasks even when called outside the desktop IPC boundary', async () => {
    const run = await harness([])
    await run.store.setTaskArchived(run.taskId, true)

    await expect(
      run.manager.start(run.taskId, 'Do not execute this request.')
    ).rejects.toThrow('Unarchive this task before starting a run')
    expect(run.requests).toEqual([])
    expect(run.store.getTask(run.taskId).items).toEqual([])
  })

  it('releases the task and provider reservation when initial persistence fails', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Recovered after the failed start.')
    ])
    const providerId = run.store.getTask(run.taskId).providerId
    const mutation = vi
      .spyOn(run.store, 'mutateTask')
      .mockRejectedValueOnce(new Error('state write failed'))

    await expect(
      run.manager.start(run.taskId, 'This start cannot persist')
    ).rejects.toThrow('state write failed')
    expect(run.manager.isTaskActive(run.taskId)).toBe(false)
    expect(run.manager.isProviderActive(providerId)).toBe(false)

    mutation.mockRestore()
    await run.manager.start(run.taskId, 'Try again')
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-completed',
      taskId: run.taskId
    })
  })

  it('does not issue a compensating state mutation after publication becomes ambiguous', async () => {
    const uncertainty = new StatePersistenceError(
      Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    )
    const run = await harness([
      async function* () {
        throw uncertainty
      }
    ])
    const mutateTask = vi.spyOn(run.store, 'mutateTask')

    await run.manager.start(run.taskId, 'Trigger ambiguous persistence')

    expect(await run.terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(/conclusively publish local state/i)
    })
    expect(mutateTask).toHaveBeenCalledTimes(1)
  })

  it('serializes run startup against a local state restore reservation', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Started after state restore.')
    ])
    let releaseRestore = (): void => undefined
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve
    })
    const restoring = run.manager.withStateRestoreReservation(async () => {
      await restoreGate
    })

    await expect(
      run.manager.start(run.taskId, 'Must not be recorded')
    ).rejects.toThrow(/state restore/i)
    expect(run.store.getTask(run.taskId).items).toEqual([])

    releaseRestore()
    await restoring
    await run.manager.start(run.taskId, 'Start after restore')
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-completed'
    })
  })

  it('rejects a local state restore reservation while any run is active', async () => {
    let releaseResponse = (): void => undefined
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const run = await harness([
      async function* (request) {
        await responseGate
        yield* textResponse(request, 'Finished.')
      }
    ])

    await run.manager.start(run.taskId, 'Keep this run active')
    expect(run.manager.hasActiveRuns()).toBe(true)
    await expect(
      run.manager.withStateRestoreReservation(async () => undefined)
    ).rejects.toThrow(/stop active runs/i)

    releaseResponse()
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-completed'
    })
    expect(run.manager.hasActiveRuns()).toBe(false)
  })

  it('serializes provider mutations against run startup in both directions', async () => {
    const providerOperations = new ProviderOperationGate()
    let releaseResponse: () => void = () => undefined
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const run = await harness(
      [
        async function* (request) {
          await responseGate
          yield* textResponse(request, 'Finished after the mutation gate.')
        }
      ],
      undefined,
      { providerOperations }
    )
    const providerId = run.store.getTask(run.taskId).providerId

    const releaseMutation = providerOperations.reserveMutation(
      providerId,
      () => run.manager.isProviderActive(providerId)
    )
    await expect(
      run.manager.start(run.taskId, 'Do not overlap the provider edit')
    ).rejects.toThrow(/provider change/i)
    releaseMutation()

    await run.manager.start(run.taskId, 'Start after the provider edit')
    await vi.waitFor(() => {
      expect(run.manager.isProviderActive(providerId)).toBe(true)
    })
    expect(() =>
      providerOperations.reserveMutation(providerId, () =>
        run.manager.isProviderActive(providerId)
      )
    ).toThrow(/active runs/i)
    releaseResponse()
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-completed'
    })
  })

  it('reserves the provider before asynchronous start authorization', async () => {
    const providerOperations = new ProviderOperationGate()
    let releaseAuthorization: () => void = () => undefined
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve
    })
    const authorizeProviderStart = vi.fn(
      async (_provider: Readonly<ProviderProfile>) => {
        await authorizationGate
      }
    )
    const run = await harness(
      [(request) => textResponse(request, 'Authorized safely.')],
      undefined,
      { providerOperations, authorizeProviderStart }
    )
    const providerId = run.store.getTask(run.taskId).providerId

    const starting = run.manager.start(
      run.taskId,
      'Wait for native provider authorization'
    )
    await vi.waitFor(() =>
      expect(authorizeProviderStart).toHaveBeenCalledTimes(1)
    )

    expect(run.manager.isTaskActive(run.taskId)).toBe(true)
    expect(providerOperations.isStartReserved(providerId)).toBe(true)
    expect(() =>
      providerOperations.reserveMutation(providerId, () => false)
    ).toThrow(/starting runs/i)

    releaseAuthorization()
    await expect(starting).resolves.toMatch(/^run_/u)
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-completed'
    })
    expect(providerOperations.isStartReserved(providerId)).toBe(false)
  })

  it('rejects fallback remapping while provider authorization is pending', async () => {
    const providerOperations = new ProviderOperationGate()
    let releaseAuthorization: () => void = () => undefined
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve
    })
    const run = await harness(
      [(request) => textResponse(request, 'Must not be requested.')],
      undefined,
      {
        providerOperations,
        authorizeProviderStart: async () => {
          await authorizationGate
        }
      }
    )
    const original = run.store.getProvider(
      run.store.getTask(run.taskId).providerId
    )
    await run.store.upsertProvider({
      ...original,
      id: 'fallback-provider',
      name: 'Fallback provider',
      createdAt: '2026-07-29T12:30:00.000Z',
      updatedAt: '2026-07-29T12:30:00.000Z'
    })

    const starting = run.manager.start(
      run.taskId,
      'Do not switch providers during startup'
    )
    await vi.waitFor(() =>
      expect(providerOperations.isStartReserved(original.id)).toBe(true)
    )
    await run.store.deleteProvider(original.id)
    releaseAuthorization()

    await expect(starting).rejects.toThrow(
      /task or provider changed while the run was starting/i
    )
    expect(run.requests).toEqual([])
    expect(run.store.getTask(run.taskId).items).toEqual([])
    expect(providerOperations.isStartReserved(original.id)).toBe(false)
  })

  it('binds startup to the exact provider and credential revision', async () => {
    const providerOperations = new ProviderOperationGate()
    let releaseAuthorization: () => void = () => undefined
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve
    })
    const run = await harness(
      [(request) => textResponse(request, 'Must not use a replacement key.')],
      undefined,
      {
        providerOperations,
        authorizeProviderStart: async () => {
          await authorizationGate
        }
      }
    )
    const original = run.store.getProvider(
      run.store.getTask(run.taskId).providerId
    )
    if (original.kind === 'cli') throw new Error('Expected an API provider')

    const starting = run.manager.start(
      run.taskId,
      'Keep the exact credential revision'
    )
    await vi.waitFor(() =>
      expect(providerOperations.isStartReserved(original.id)).toBe(true)
    )
    await run.store.upsertProvider({
      ...original,
      hasApiKey: true,
      credentialRevision: 'credential_replacement',
      // Deliberately preserve updatedAt to prove the full profile and
      // credential boundary are bound, not just the timestamp.
      updatedAt: original.updatedAt
    })
    releaseAuthorization()

    await expect(starting).rejects.toThrow(
      /task or provider changed while the run was starting/i
    )
    expect(run.requests).toEqual([])
    expect(run.store.getTask(run.taskId).items).toEqual([])
  })

  it('revalidates readiness after asynchronous start authorization', async () => {
    const providerOperations = new ProviderOperationGate()
    let releaseAuthorization: () => void = () => undefined
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve
    })
    const run = await harness(
      [(request) => textResponse(request, 'Must not use an unverified profile.')],
      undefined,
      {
        providerOperations,
        authorizeProviderStart: async () => {
          await authorizationGate
        }
      }
    )
    const original = run.store.getProvider(
      run.store.getTask(run.taskId).providerId
    )

    const starting = run.manager.start(
      run.taskId,
      'Require the saved connection test'
    )
    await vi.waitFor(() =>
      expect(providerOperations.isStartReserved(original.id)).toBe(true)
    )
    await run.store.upsertProvider({
      ...original,
      verification: { status: 'unverified' }
    })
    releaseAuthorization()

    await expect(starting).rejects.toThrow(/Test .* in Settings/i)
    expect(run.requests).toEqual([])
    expect(run.store.getTask(run.taskId).items).toEqual([])
  })

  it('persists partial assistant text when a provider stream fails', async () => {
    const run = await harness([
      async function* () {
        yield {
          type: 'response.started' as const,
          servingModel: 'test-model'
        }
        yield {
          type: 'part.started' as const,
          part: { kind: 'text' as const, partId: 'partial-text' }
        }
        yield {
          type: 'part.delta' as const,
          partId: 'partial-text',
          delta: {
            kind: 'text' as const,
            text: 'Partial answer before failure.'
          }
        }
        throw new Error('Provider connection failed')
      }
    ])
    const providerId = run.store.getTask(run.taskId).providerId
    const provider = run.store.getProvider(providerId)
    if (provider.kind === 'cli') throw new Error('Expected a model provider')
    await run.store.mutateTask(run.taskId, (task) => {
      task.modelSessions = {
        [provider.id]: {
          adapterId: 'test.model',
          providerRevision: provider.updatedAt,
          providerFingerprint:
            providerConfigurationFingerprint(provider),
          model: provider.model,
          workspacePath: task.workspacePath,
          mode: task.mode,
          conversation: [],
          updatedAt: task.updatedAt
        }
      }
    })

    await run.manager.start(run.taskId, 'Stream a partial answer')
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-error'
    })
    expect(run.store.getTask(run.taskId).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'message',
          role: 'assistant',
          content: 'Partial answer before failure.'
        })
      ])
    )
    expect(run.store.getTask(run.taskId).modelSessions).toBeUndefined()
  })

  it('can stop the active run by task after a renderer is recreated', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(request, 'write_file', {
          path: 'README.md',
          content: 'Ground updated'
        }),
      (request) => textResponse(request, 'This response should be stopped.')
    ])
    await writeFile(path.join(run.workspace, 'README.md'), 'Ground')

    await run.manager.start(run.taskId, 'Inspect the workspace')
    await run.approval
    const providerId = run.store.getTask(run.taskId).providerId
    expect(run.manager.isProviderActive(providerId)).toBe(true)

    await run.manager.stopTask(run.taskId)
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-stopped',
      taskId: run.taskId
    })
    expect(run.manager.isTaskActive(run.taskId)).toBe(false)
    expect(run.manager.isProviderActive(providerId)).toBe(false)
  })

  it('compensates a model-session write when Stop lands during persistence', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Completed at the provider.')
    ])
    const originalMutateTask = run.store.mutateTask.bind(run.store)
    let mutationCalls = 0
    const mutateTask = vi
      .spyOn(run.store, 'mutateTask')
      .mockImplementation(async (taskId, mutator) => {
        mutationCalls += 1
        if (mutationCalls === 2) {
          const persistence = originalMutateTask(taskId, mutator)
          queueMicrotask(() => {
            void run.manager.stopTask(run.taskId)
          })
          return persistence
        }
        return originalMutateTask(taskId, mutator)
      })

    try {
      await run.manager.start(run.taskId, 'Stop during continuation commit.')

      await expect(run.terminal).resolves.toMatchObject({
        type: 'run-stopped'
      })
      expect(run.store.getTask(run.taskId).modelSessions).toBeUndefined()
    } finally {
      mutateTask.mockRestore()
    }
  })

  it('does not strand an approval when stopped before pending registration', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(request, 'write_file', {
          path: 'README.md',
          content: 'Ground updated'
        })
    ])
    await writeFile(path.join(run.workspace, 'README.md'), 'Ground')

    const originalAddItem = run.store.addItem.bind(run.store)
    let releaseApprovalPersistence: () => void = () => undefined
    const approvalPersistenceReleased = new Promise<void>((resolve) => {
      releaseApprovalPersistence = resolve
    })
    let announceApprovalPersistence: () => void = () => undefined
    const approvalPersistenceStarted = new Promise<void>((resolve) => {
      announceApprovalPersistence = resolve
    })
    const addItem = vi
      .spyOn(run.store, 'addItem')
      .mockImplementation(async (taskId, item) => {
        if (
          item.kind === 'activity' &&
          item.activityType === 'approval' &&
          item.status === 'pending'
        ) {
          announceApprovalPersistence()
          await approvalPersistenceReleased
        }
        return originalAddItem(taskId, item)
      })

    try {
      await run.manager.start(run.taskId, 'Prepare a write')
      await approvalPersistenceStarted
      const stopping = run.manager.stopTask(run.taskId)
      releaseApprovalPersistence()

      await stopping
      await expect(run.terminal).resolves.toMatchObject({
        type: 'run-stopped',
        taskId: run.taskId
      })
      expect(run.manager.isTaskActive(run.taskId)).toBe(false)
      expect(
        run.store
          .getTask(run.taskId)
          .items.some(
            (item) =>
              item.kind === 'activity' &&
              item.activityType === 'approval' &&
              item.status === 'pending'
          )
      ).toBe(false)
    } finally {
      releaseApprovalPersistence()
      addItem.mockRestore()
    }
  })

  it('stops before dispatching a second approval call from the same response', async () => {
    const run = await harness([
      (request) =>
        multipleToolCallResponse(request, [
          {
            name: 'write_file',
            input: {
              path: 'first.txt',
              content: 'first'
            }
          },
          {
            name: 'write_file',
            input: {
              path: 'second.txt',
              content: 'second'
            }
          }
        ])
    ])

    await run.manager.start(run.taskId, 'Prepare two writes')
    await run.approval
    await run.manager.stopTask(run.taskId)

    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-stopped',
      taskId: run.taskId
    })
    expect(
      run.events.filter((event) => event.type === 'approval-requested')
    ).toHaveLength(1)
    await expect(
      readFile(path.join(run.workspace, 'first.txt'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(path.join(run.workspace, 'second.txt'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for active provider cleanup before stopAll returns', async () => {
    let resolveStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let cleanupFinished = false
    const runtimeFactory: ModelRuntimeFactory = () => ({
      adapter: {
        id: 'shutdown.test',
        stream(
          _request: ModelRequest,
          context: { signal: AbortSignal }
        ): AsyncIterable<ModelEvent> {
          return (async function* () {
            resolveStarted()
            await new Promise<void>((resolve) => {
              if (context.signal.aborted) {
                resolve()
                return
              }
              context.signal.addEventListener('abort', () => resolve(), {
                once: true
              })
            })
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
            cleanupFinished = true
            throw new DOMException('Run stopped', 'AbortError')
          })()
        }
      } as unknown as ModelAdapter<AiSdkAdapterConfig>,
      adapterId: 'shutdown.test',
      config: {
        protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1'
      }
    })
    const run = await harness([], undefined, { runtimeFactory })

    await run.manager.start(run.taskId, 'Wait for shutdown cleanup')
    await started
    await run.manager.stopAll()

    expect(cleanupFinished).toBe(true)
    expect(run.manager.isTaskActive(run.taskId)).toBe(false)
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-stopped',
      taskId: run.taskId
    })
  })

  it('keeps assistant tool calls and their results atomic when trimming context', () => {
    const conversation: ModelRequest['conversation'] = [
      {
        kind: 'message',
        id: 'old-user',
        role: 'user',
        parts: [{ kind: 'text', text: 'old context' }]
      },
      {
        kind: 'message',
        id: 'tool-turn',
        role: 'assistant',
        parts: [
          {
            kind: 'tool-call',
            callId: 'call-one',
            name: 'read_file',
            rawArguments: '{"path":"README.md"}',
            arguments: { path: 'README.md' }
          }
        ]
      },
      {
        kind: 'tool-result',
        id: 'tool-result',
        callId: 'call-one',
        name: 'read_file',
        content: [{ kind: 'text', text: '# Ground' }]
      }
    ]

    const selected = selectModelContext(conversation, 10_000, 2)

    expect(selected.omittedItems).toBe(1)
    expect(selected.conversation).toEqual(conversation.slice(1))
  })

  it('never returns an individual context item above the configured budget', () => {
    const conversation: ModelRequest['conversation'] = [
      {
        kind: 'message',
        id: 'oversized-user',
        role: 'user',
        parts: [{ kind: 'text', text: 'x'.repeat(20_000) }]
      }
    ]

    const selected = selectModelContext(conversation, 1_000, 10)

    expect(selected.omittedItems).toBe(1)
    expect(selected.conversation).toHaveLength(1)
    expect(JSON.stringify(selected.conversation).length).toBeLessThanOrEqual(1_000)
    expect(JSON.stringify(selected.conversation)).toContain('truncated')
  })

  it('applies context limits to UTF-8 bytes for multibyte text', () => {
    const selected = selectModelContext(
      [
        {
          kind: 'message',
          id: 'multibyte-user',
          role: 'user',
          parts: [{ kind: 'text', text: '界'.repeat(2_000) }]
        }
      ],
      1_000,
      10
    )

    expect(selected.omittedItems).toBe(1)
    expect(
      Buffer.byteLength(JSON.stringify(selected.conversation), 'utf8')
    ).toBeLessThanOrEqual(1_000)
    expect(JSON.stringify(selected.conversation)).toContain('truncated')
  })

  it('derives a conservative conversation budget from each model profile', () => {
    const provider: ModelApiProvider = {
      id: 'small-local',
      name: 'Small local model',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'small-model',
      hasApiKey: false,
      supportsTools: true,
      contextWindowTokens: 4_096,
      maxOutputTokens: 512,
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z'
    }

    expect(modelRequestByteBudget(provider, 1_000)).toBe(2_072)
  })

  it('binds the production adapter configuration to an opaque endpoint-scoped credential reference', () => {
    const provider: ModelApiProvider = {
      id: 'hosted-provider',
      name: 'Hosted provider',
      kind: 'openai',
      baseUrl: 'https://api.example.com/v1/',
      model: 'model-one',
      hasApiKey: true,
      supportsTools: true,
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z'
    }

    const runtime = createModelRuntime(provider)
    const reference = providerCredentialReferenceFor(provider)

    expect(runtime.config.apiKeyRef).toBe(reference)
    expect(reference).not.toContain(provider.id)
    expect(reference).not.toContain('api.example.com')
    expect(() =>
      createModelRuntime({ ...provider, hasApiKey: false })
    ).toThrow('Hosted providers require a secret reference')
  })

  it('resolves only the scoped reference for the immutable provider snapshot', async () => {
    const observed: { secret?: string } = {}
    const vault = credentialVault()
    const run = await harness([], undefined, {
      vault: vault.instance,
      runtimeFactory: credentialResolvingRuntime(
        providerCredentialReferenceFor,
        observed
      )
    })
    const task = run.store.getTask(run.taskId)
    const stored = run.store.getProvider(task.providerId)
    if (stored.kind === 'cli') throw new Error('Expected a model provider')
    const provider = { ...stored, hasApiKey: true }
    const reference = providerCredentialReferenceFor(provider)
    vault.entries.set(reference, 'scoped-secret')
    await run.store.upsertProvider(provider)

    await run.manager.start(run.taskId, 'Use the scoped credential.')
    expect((await run.terminal).type).toBe('run-completed')

    expect(observed.secret).toBe('scoped-secret')
    expect(vault.get).toHaveBeenCalledWith(reference)
    expect(vault.get).not.toHaveBeenCalledWith(provider.id)
  })

  it('rejects an adapter request for a different credential boundary without probing the vault', async () => {
    const observed: { secret?: string } = {}
    const vault = credentialVault()
    const run = await harness([], undefined, {
      vault: vault.instance,
      runtimeFactory: credentialResolvingRuntime(
        (provider) =>
          providerCredentialReference(
            provider.id,
            provider.kind,
            'https://attacker.example/v1'
          ),
        observed
      )
    })
    const task = run.store.getTask(run.taskId)
    const stored = run.store.getProvider(task.providerId)
    if (stored.kind === 'cli') throw new Error('Expected a model provider')
    const provider = { ...stored, hasApiKey: true }
    vault.entries.set(providerCredentialReferenceFor(provider), 'safe-secret')
    await run.store.upsertProvider(provider)

    await run.manager.start(run.taskId, 'Do not cross the credential boundary.')
    expect((await run.terminal).type).toBe('run-error')

    expect(observed.secret).toBeUndefined()
    expect(vault.get).not.toHaveBeenCalled()
  })

  it('keeps a legacy key usable without mutating the vault at runtime', async () => {
    const observed: { secret?: string } = {}
    const vault = credentialVault()
    const run = await harness([], undefined, {
      vault: vault.instance,
      runtimeFactory: credentialResolvingRuntime(
        providerCredentialReferenceFor,
        observed
      )
    })
    const task = run.store.getTask(run.taskId)
    const stored = run.store.getProvider(task.providerId)
    if (stored.kind === 'cli') throw new Error('Expected a model provider')
    const provider = { ...stored, hasApiKey: true }
    vault.entries.set(provider.id, 'legacy-secret')
    await run.store.upsertProvider(provider)

    await run.manager.start(run.taskId, 'Use the legacy credential safely.')
    expect((await run.terminal).type).toBe('run-completed')

    expect(observed.secret).toBe('legacy-secret')
    expect(vault.set).not.toHaveBeenCalled()
    expect(vault.delete).not.toHaveBeenCalled()
    expect(vault.entries.get(provider.id)).toBe('legacy-secret')
  })

  it('never falls back to an orphaned legacy key when hasApiKey is false', async () => {
    const observed: { secret?: string } = {}
    const vault = credentialVault()
    const run = await harness([], undefined, {
      vault: vault.instance,
      runtimeFactory: credentialResolvingRuntime(
        providerCredentialReferenceFor,
        observed
      )
    })
    const task = run.store.getTask(run.taskId)
    const provider = run.store.getProvider(task.providerId)
    if (provider.kind === 'cli') throw new Error('Expected a model provider')
    expect(provider.hasApiKey).toBe(false)
    vault.entries.set(provider.id, 'orphaned-legacy-secret')

    await run.manager.start(run.taskId, 'Do not use the orphaned key.')
    expect((await run.terminal).type).toBe('run-error')

    expect(observed.secret).toBeUndefined()
    expect(vault.get).not.toHaveBeenCalled()
    expect(vault.set).not.toHaveBeenCalled()
  })

  it('redacts reflected credentials across split successful text and notices', async () => {
    const secret = 'sk-ground-success-reflection'
    const vault = credentialVault()
    const run = await harness([], undefined, {
      vault: vault.instance,
      runtimeFactory: credentialReflectingRuntime(
        async function* (resolvedSecret, request) {
          const partId = `${request.requestId}:text`
          const text = `Before ${resolvedSecret} after.`
          yield {
            type: 'provider.notice',
            level: 'warning',
            code: `echo.${resolvedSecret}`,
            message: `Notice reflected ${resolvedSecret}.`
          }
          yield { type: 'response.started', servingModel: request.model }
          yield {
            type: 'part.started',
            part: { kind: 'text', partId }
          }
          yield {
            type: 'part.delta',
            partId,
            delta: {
              kind: 'text',
              text: `Before ${resolvedSecret.slice(0, 9)}`
            }
          }
          yield {
            type: 'part.delta',
            partId,
            delta: {
              kind: 'text',
              text: `${resolvedSecret.slice(9)} after.`
            }
          }
          yield {
            type: 'part.completed',
            partId,
            part: { kind: 'text', text }
          }
          yield {
            type: 'response.completed',
            messageId: `${request.requestId}:assistant`,
            stopReason: 'complete'
          }
        }
      )
    })
    const task = run.store.getTask(run.taskId)
    const stored = run.store.getProvider(task.providerId)
    if (stored.kind === 'cli') throw new Error('Expected a model provider')
    const provider = { ...stored, hasApiKey: true }
    vault.entries.set(providerCredentialReferenceFor(provider), secret)
    await run.store.upsertProvider(provider)

    await run.manager.start(run.taskId, 'Keep successful output credential-free.')
    await expect(run.terminal).resolves.toMatchObject({
      type: 'run-completed'
    })

    const completedTask = run.store.getTask(run.taskId)
    expect(
      completedTask.items.find(
        (item) => item.kind === 'message' && item.role === 'assistant'
      )
    ).toMatchObject({ content: 'Before ████ after.' })
    expect(
      completedTask.items.find(
        (item) =>
          item.kind === 'activity' &&
          item.title === 'Provider notices'
      )
    ).toMatchObject({ detail: expect.stringContaining('████') })
    expect(JSON.stringify(completedTask)).not.toContain(secret)
    expect(JSON.stringify(run.events)).not.toContain(secret)
    expect(await readFile(path.join(run.directory, 'state.json'), 'utf8'))
      .not.toContain(secret)
  })

  it('rejects output that races a pending credential resolution', async () => {
    const secret = 'sk-ground-deferred-legacy-secret'
    let releaseCredential: (value: string) => void = () => undefined
    const credentialGate = new Promise<string>((resolve) => {
      releaseCredential = resolve
    })
    const vault = credentialVault()
    const run = await harness([], undefined, {
      vault: vault.instance,
      runtimeFactory: credentialRacingRuntime()
    })
    const task = run.store.getTask(run.taskId)
    const stored = run.store.getProvider(task.providerId)
    if (stored.kind === 'cli') throw new Error('Expected a model provider')
    const provider = {
      ...stored,
      hasApiKey: true,
      credentialRevision: 'credential_deferred'
    }
    const exactReference = providerCredentialReferenceFor(provider)
    vault.get.mockImplementation((reference: string) =>
      reference === exactReference
        ? (credentialGate as unknown as string)
        : vault.entries.get(reference)
    )
    await run.store.upsertProvider(provider)

    await run.manager.start(run.taskId, 'Reject credential resolution races.')
    const terminal = await run.terminal
    releaseCredential(secret)
    expect(terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(/credential resolution was pending/i)
    })

    const failedTask = run.store.getTask(run.taskId)
    expect(failedTask.modelSessions).toBeUndefined()
    expect(
      failedTask.items.some(
        (item) => item.kind === 'message' && item.role === 'assistant'
      )
    ).toBe(false)
    expect(JSON.stringify(failedTask)).not.toContain(secret)
    expect(JSON.stringify(run.events)).not.toContain(secret)
    expect(await readFile(path.join(run.directory, 'state.json'), 'utf8'))
      .not.toContain(secret)
  })

  it.each([
    'tool arguments',
    'provider state',
    'checkpoint'
  ] as const)(
    'fails closed when successful structured %s reflect a credential',
    async (location) => {
      const secret = 'quoted"credential\\value\nnext'
      const vault = credentialVault()
      const run = await harness([], undefined, {
        vault: vault.instance,
        runtimeFactory: credentialReflectingRuntime(
          async function* (resolvedSecret, request) {
            yield { type: 'response.started', servingModel: request.model }
            if (location === 'tool arguments') {
              const partId = `${request.requestId}:tool`
              const rawArguments = JSON.stringify({ value: resolvedSecret })
              yield {
                type: 'part.started',
                part: {
                  kind: 'tool-call',
                  partId,
                  callId: 'credential-call',
                  name: 'read_file'
                }
              }
              yield {
                type: 'part.delta',
                partId,
                delta: { kind: 'tool-arguments', text: rawArguments }
              }
              yield {
                type: 'part.completed',
                partId,
                part: {
                  kind: 'tool-call',
                  callId: 'credential-call',
                  name: 'read_file',
                  rawArguments,
                  arguments: { value: resolvedSecret }
                }
              }
              yield {
                type: 'response.completed',
                messageId: `${request.requestId}:assistant`,
                stopReason: 'tool-calls'
              }
              return
            }

            const partId = `${request.requestId}:text`
            yield {
              type: 'part.started',
              part: { kind: 'text', partId }
            }
            yield {
              type: 'part.completed',
              partId,
              part: { kind: 'text', text: 'Safe response text.' }
            }
            yield {
              type: 'response.completed',
              messageId: `${request.requestId}:assistant`,
              stopReason: 'complete',
              ...(location === 'provider state'
                ? {
                    providerState: {
                      adapterId: 'credential.reflection-test',
                      schemaVersion: 1 as const,
                      data: { reflected: resolvedSecret }
                    }
                  }
                : {
                    checkpoint: { reflected: resolvedSecret }
                  })
            }
          }
        )
      })
      const task = run.store.getTask(run.taskId)
      const stored = run.store.getProvider(task.providerId)
      if (stored.kind === 'cli') throw new Error('Expected a model provider')
      const provider = { ...stored, hasApiKey: true }
      vault.entries.set(providerCredentialReferenceFor(provider), secret)
      await run.store.upsertProvider(provider)

      await run.manager.start(run.taskId, `Reject reflected ${location}.`)
      const terminal = await run.terminal
      expect(terminal).toMatchObject({
        type: 'run-error',
        message: expect.stringMatching(/protected credential/i)
      })

      const failedTask = run.store.getTask(run.taskId)
      expect(failedTask.modelSessions).toBeUndefined()
      expect(JSON.stringify(failedTask)).not.toContain(secret)
      expect(JSON.stringify(run.events)).not.toContain(secret)
      expect(await readFile(path.join(run.directory, 'state.json'), 'utf8'))
        .not.toContain(secret)
    }
  )

  it('durably fails with a bounded error and redacts a reflected active credential from state and events', async () => {
    const secret = 'sk-ground-runtime-secret'
    const vault = credentialVault()
    const run = await harness([], undefined, {
      vault: vault.instance,
      runtimeFactory: credentialFailingRuntime(
        (resolvedSecret) =>
          new Error(
            `Provider rejected Authorization: Bearer ${resolvedSecret}.\n${'x'.repeat(
              160_000
            )}`
          )
      )
    })
    const task = run.store.getTask(run.taskId)
    const stored = run.store.getProvider(task.providerId)
    if (stored.kind === 'cli') throw new Error('Expected a model provider')
    const provider = { ...stored, hasApiKey: true }
    vault.entries.set(providerCredentialReferenceFor(provider), secret)
    await run.store.upsertProvider(provider)

    await run.manager.start(run.taskId, 'Trigger a reflected provider error.')
    const terminal = await run.terminal

    expect(terminal.type).toBe('run-error')
    if (terminal.type !== 'run-error') throw new Error('Expected run-error')
    expect(terminal.message).toContain('Provider rejected Authorization')
    expect(terminal.message).toContain('[redacted credential]')
    expect(terminal.message).toContain('Error truncated by Ground')
    expect(terminal.message.length).toBeLessThanOrEqual(30_000)
    expect(terminal.message).not.toContain(secret)

    const failedTask = run.store.getTask(run.taskId)
    expect(failedTask.runStatus).toBe('failed')
    const failureActivity = failedTask.items.find(
      (item) =>
        item.kind === 'activity' &&
        item.activityType === 'error' &&
        item.title === 'Run failed'
    )
    expect(failureActivity).toMatchObject({
      kind: 'activity',
      status: 'error',
      detail: terminal.message
    })
    expect(JSON.stringify(failedTask)).not.toContain(secret)
    expect(JSON.stringify(run.events)).not.toContain(secret)

    const statePath = path.join(run.directory, 'state.json')
    expect(await readFile(statePath, 'utf8')).not.toContain(secret)
    const reloaded = new StateStore(statePath)
    await reloaded.load()
    expect(reloaded.getTask(run.taskId).runStatus).toBe('failed')
  })

  it('reports a bounded redacted live error when the failed-state write itself is unavailable', async () => {
    const secret = 'sk-ground-persistence-secret'
    let releaseFailure: () => void = () => undefined
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })
    let markCredentialResolved: () => void = () => undefined
    const credentialResolved = new Promise<void>((resolve) => {
      markCredentialResolved = resolve
    })
    const vault = credentialVault()
    const run = await harness([], undefined, {
      vault: vault.instance,
      runtimeFactory: credentialFailingRuntime(
        () => new Error('Provider request failed.'),
        {
          beforeFailure: failureGate,
          onCredentialResolved: markCredentialResolved
        }
      )
    })
    const task = run.store.getTask(run.taskId)
    const stored = run.store.getProvider(task.providerId)
    if (stored.kind === 'cli') throw new Error('Expected a model provider')
    const provider = { ...stored, hasApiKey: true }
    vault.entries.set(providerCredentialReferenceFor(provider), secret)
    await run.store.upsertProvider(provider)

    await run.manager.start(run.taskId, 'Fail while finalizing locally.')
    await credentialResolved
    const mutateTask = vi
      .spyOn(run.store, 'mutateTask')
      .mockRejectedValueOnce(
        new Error(`Disk write failed while handling ${secret}.${'y'.repeat(80_000)}`)
      )
    releaseFailure()
    const terminal = await run.terminal

    expect(terminal.type).toBe('run-error')
    if (terminal.type !== 'run-error') throw new Error('Expected run-error')
    expect(terminal.message).toContain('could not finalize this run locally')
    expect(terminal.message).toContain('[redacted credential]')
    expect(terminal.message).toContain('Error truncated by Ground')
    expect(terminal.message.length).toBeLessThanOrEqual(30_000)
    expect(terminal.message).not.toContain(secret)
    expect(run.store.getTask(run.taskId).runStatus).toBe('running')
    expect(run.manager.isTaskActive(run.taskId)).toBe(false)
    expect(
      run.events.some(
        (event) =>
          event.type === 'item-added' &&
          event.item.kind === 'activity' &&
          event.item.title === 'Run failed'
      )
    ).toBe(false)
    expect(mutateTask).toHaveBeenCalledTimes(1)
  })

  it('forwards explicit output and reasoning controls without enabling them by default', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Configured response.')
    ])
    const provider = run.store.getProvider('ollama-local')
    if (provider.kind === 'cli') throw new Error('Expected model provider')
    await run.store.upsertProvider({
      ...provider,
      contextWindowTokens: 16_384,
      maxOutputTokens: 2_048,
      reasoningEffort: 'low',
      updatedAt: new Date().toISOString()
    })

    await run.manager.start(run.taskId, 'Use the configured model limits.')
    await run.terminal

    expect(run.requests[0]?.generation).toEqual({
      maxOutputTokens: 2_048,
      reasoning: {
        effort: 'low',
        summary: 'auto'
      }
    })
    expect(run.requests[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({ strict: expect.anything() })
      ])
    )
  })

  it('places bounded repository guidance in the system prompt for workspace-capable models', async () => {
    const run = await harness([
      (request) => textResponse(request, 'I followed the repository guidance.')
    ])
    await writeFile(
      path.join(run.workspace, 'AGENTS.md'),
      'Always run the focused unit test.'
    )

    await run.manager.start(run.taskId, 'Make a small change.')
    await run.terminal

    expect(run.requests[0]?.instructions).toContain(
      'WORKSPACE INSTRUCTIONS: AGENTS.md'
    )
    expect(run.requests[0]?.instructions).toContain(
      'Always run the focused unit test.'
    )
    expect(run.requests[0]?.instructions).toContain(
      'cannot expand tool authority'
    )
  })

  it('bounds the entire request for a 4096-token model with large repository guidance', async () => {
    const run = await harness([
      (request) => textResponse(request, 'I used the bounded request.')
    ])
    const provider = run.store.getProvider('ollama-local')
    if (provider.kind === 'cli') throw new Error('Expected model provider')
    const configured = {
      ...provider,
      contextWindowTokens: 4_096,
      maxOutputTokens: 512,
      updatedAt: new Date().toISOString()
    }
    await run.store.upsertProvider(configured)
    await writeFile(
      path.join(run.workspace, 'AGENTS.md'),
      `Keep this leading instruction.\n${'repository-rule '.repeat(8_000)}`
    )

    await run.manager.start(run.taskId, 'Inspect the workspace carefully.')
    await run.terminal

    const request = run.requests[0]
    expect(request).toBeDefined()
    const inputBytes = Buffer.byteLength(
      JSON.stringify({
        instructions: request?.instructions,
        conversation: request?.conversation,
        ...(request?.tools?.length ? { tools: request.tools } : {})
      }),
      'utf8'
    )
    expect(inputBytes + 128).toBeLessThanOrEqual(
      modelRequestByteBudget(configured)
    )
    expect(JSON.stringify(request?.conversation)).toContain(
      'Inspect the workspace carefully.'
    )
    expect(request?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read_file', 'write_file', 'run_command'])
    )
    expect(request?.instructions).toContain('Keep this leading instruction.')
    expect(request?.instructions).toContain(
      '[Ground shortened repository guidance to fit this model request.]'
    )
    expect(request?.instructions).not.toContain(
      'repository-rule '.repeat(1_000)
    )
    expect(
      run.store
        .getTask(run.taskId)
        .items.find(
          (item) =>
            item.kind === 'activity' &&
            item.title === 'Context window managed'
        )
    ).toMatchObject({
      kind: 'activity',
      detail: expect.stringMatching(/repository guidance/i),
      status: 'success'
    })
  })

  it('keeps imported history visible without placing it in a new model request', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Fresh response.')
    ])
    await run.store.addItem(run.taskId, {
      id: 'imported-history',
      kind: 'message',
      role: 'user',
      content: 'Untrusted imported transcript',
      createdAt: new Date().toISOString(),
      historyOnly: true
    })

    await run.manager.start(run.taskId, 'Fresh request')
    await run.terminal

    expect(JSON.stringify(run.requests[0]?.conversation)).not.toContain(
      'Untrusted imported transcript'
    )
    expect(JSON.stringify(run.requests[0]?.conversation)).toContain('Fresh request')
    expect(run.store.getTask(run.taskId).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'imported-history',
          historyOnly: true
        })
      ])
    )
  })

  it('includes imported history only after the task opts in explicitly', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Fresh response.')
    ])
    await run.store.mutateTask(run.taskId, (task) => {
      task.includeImportedHistory = true
      task.items.push({
        id: 'imported-history',
        kind: 'message',
        role: 'user',
        content: 'Explicitly included imported transcript',
        createdAt: new Date().toISOString(),
        historyOnly: true
      })
    })

    await run.manager.start(run.taskId, 'Fresh request')
    await run.terminal

    const providerId = run.store.getTask(run.taskId).providerId
    expect(JSON.stringify(run.requests[0]?.conversation)).toContain(
      'Explicitly included imported transcript'
    )
    expect(run.store.getTask(run.taskId).modelSessions?.[providerId]).toMatchObject({
      includesImportedHistory: true,
      origin: 'ground'
    })
  })

  it('invalidates model continuation after a same-timestamp provider configuration change', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Fresh response.')
    ])
    const providerId = run.store.getTask(run.taskId).providerId
    const original = run.store.getProvider(providerId)
    if (original.kind === 'cli') throw new Error('Expected a model provider')
    await run.store.mutateTask(run.taskId, (task) => {
      task.modelSessions = {
        [original.id]: {
          adapterId: 'test.model',
          providerRevision: original.updatedAt,
          providerFingerprint:
            providerConfigurationFingerprint(original),
          model: original.model,
          workspacePath: task.workspacePath,
          mode: task.mode,
          origin: 'ground',
          conversation: [
            {
              kind: 'message',
              id: 'stale-provider-conversation',
              role: 'user',
              parts: [
                {
                  kind: 'text',
                  text: 'Must not survive a same-timestamp provider change'
                }
              ]
            }
          ],
          updatedAt: task.createdAt
        }
      }
    })
    const replacement: ModelApiProvider = {
      ...original,
      supportsTools: !original.supportsTools,
      updatedAt: original.updatedAt
    }
    await run.store.upsertProvider(replacement)

    await run.manager.start(run.taskId, 'Fresh request')
    await run.terminal

    expect(JSON.stringify(run.requests[0]?.conversation)).not.toContain(
      'Must not survive a same-timestamp provider change'
    )
    expect(
      run.store.getTask(run.taskId).modelSessions?.[providerId]
        ?.providerFingerprint
    ).toBe(providerConfigurationFingerprint(replacement))
  })

  it('invalidates an imported provider continuation while history stays excluded', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Fresh response.')
    ])
    const providerId = run.store.getTask(run.taskId).providerId
    const provider = run.store.getProvider(providerId)
    await run.store.mutateTask(run.taskId, (task) => {
      task.includeImportedHistory = false
      task.items.push({
        id: 'imported-history',
        kind: 'message',
        role: 'user',
        content: 'Excluded imported timeline',
        createdAt: task.createdAt,
        historyOnly: true
      })
      task.modelSessions = {
        [provider.id]: {
          adapterId: 'test.model',
          providerRevision: provider.updatedAt,
          providerFingerprint:
            providerConfigurationFingerprint(provider),
          model: provider.model,
          workspacePath: task.workspacePath,
          mode: task.mode,
          includesImportedHistory: true,
          origin: 'imported',
          conversation: [
            {
              kind: 'message',
              id: 'imported-provider-message',
              role: 'user',
              parts: [
                {
                  kind: 'text',
                  text: 'Excluded imported provider conversation'
                }
              ]
            }
          ],
          updatedAt: task.createdAt
        }
      }
    })

    await run.manager.start(run.taskId, 'Fresh request')
    await run.terminal

    const conversation = JSON.stringify(run.requests[0]?.conversation)
    expect(conversation).not.toContain('Excluded imported timeline')
    expect(conversation).not.toContain('Excluded imported provider conversation')
    expect(run.store.getTask(run.taskId).modelSessions?.[provider.id]).toMatchObject({
      includesImportedHistory: false,
      origin: 'ground'
    })
  })

  it('uses an opted-in imported continuation without duplicating history-only timeline items', async () => {
    const run = await harness([
      (request) => textResponse(request, 'Fresh response.')
    ])
    const providerId = run.store.getTask(run.taskId).providerId
    const provider = run.store.getProvider(providerId)
    await run.store.mutateTask(run.taskId, (task) => {
      task.includeImportedHistory = true
      task.items.push({
        id: 'visible-imported-history',
        kind: 'message',
        role: 'user',
        content: 'Visible projection of the imported turn',
        createdAt: task.createdAt,
        historyOnly: true
      })
      task.modelSessions = {
        [provider.id]: {
          adapterId: 'test.model',
          providerRevision: provider.updatedAt,
          providerFingerprint:
            providerConfigurationFingerprint(provider),
          model: provider.model,
          workspacePath: task.workspacePath,
          mode: task.mode,
          includesImportedHistory: true,
          origin: 'imported',
          conversation: [
            {
              kind: 'message',
              id: 'canonical-imported-history',
              role: 'user',
              parts: [
                {
                  kind: 'text',
                  text: 'Canonical imported provider conversation'
                }
              ]
            }
          ],
          updatedAt: task.createdAt
        }
      }
    })

    await run.manager.start(run.taskId, 'Fresh request')
    await run.terminal

    const conversation = JSON.stringify(run.requests[0]?.conversation)
    expect(conversation).toContain('Canonical imported provider conversation')
    expect(conversation).not.toContain('Visible projection of the imported turn')
    expect(conversation).toContain('Fresh request')
  })

  it('uses an exact imported API seed after the user attaches a workspace', async () => {
    const observedRequests: ModelRequest[] = []
    const adapter = {
      id: 'openai.compatible',
      stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        observedRequests.push(structuredClone(request))
        return textResponse(request, 'Imported seed accepted.')
      }
    } as unknown as ModelAdapter<AiSdkAdapterConfig>
    const run = await harness([], undefined, {
      runtimeFactory: () => ({
        adapter,
        adapterId: adapter.id,
        config: {
          protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:11434/v1'
        }
      })
    })
    const provider = run.store.getProvider(
      run.store.snapshot().settings.defaultProviderId
    )
    if (provider.kind === 'cli') {
      throw new Error('Expected the default API provider')
    }
    const imported = await run.store.importTask({
      title: 'Imported canonical seed',
      mode: 'agent',
      provider: {
        type: 'model-api',
        kind: provider.kind,
        name: provider.name,
        model: provider.model,
        supportsTools: provider.supportsTools
      },
      timeline: [
        {
          kind: 'message',
          role: 'user',
          content: 'Visible imported timeline projection'
        }
      ],
      conversation: [
        {
          kind: 'message',
          role: 'user',
          parts: [
            {
              kind: 'text',
              text: 'Canonical imported provider conversation'
            }
          ]
        }
      ],
      source: {
        formatVersion: 1,
        exportedAt: '2026-07-28T12:00:00.000Z'
      }
    })
    await run.store.mutateTask(imported.id, (task) => {
      task.includeImportedHistory = true
      task.workspacePath = run.workspace
    })

    await run.manager.start(imported.id, 'Fresh request')
    await run.terminal

    const conversation = JSON.stringify(
      observedRequests[0]?.conversation
    )
    expect(conversation).toContain(
      'Canonical imported provider conversation'
    )
    expect(conversation).not.toContain(
      'Visible imported timeline projection'
    )
    expect(conversation).toContain('Fresh request')
    expect(
      run.store.getTask(imported.id).modelSessions?.[provider.id]
    ).toMatchObject({
      origin: 'ground',
      workspacePath: run.workspace,
      providerFingerprint:
        providerConfigurationFingerprint(provider),
      includesImportedHistory: true
    })

    const replacementWorkspaceCandidate = path.join(
      run.directory,
      'replacement-workspace'
    )
    await mkdir(replacementWorkspaceCandidate)
    const replacementWorkspace = await realpath(
      replacementWorkspaceCandidate
    )
    await run.store.mutateTask(imported.id, (task) => {
      task.workspacePath = replacementWorkspace
    })
    await run.manager.start(imported.id, 'Request after workspace change')
    await vi.waitFor(() => {
      expect(observedRequests).toHaveLength(2)
      expect(run.manager.isTaskActive(imported.id)).toBe(false)
    })

    const replacementConversation = JSON.stringify(
      observedRequests[1]?.conversation
    )
    expect(replacementConversation).not.toContain(
      'Canonical imported provider conversation'
    )
    expect(replacementConversation).toContain(
      'Visible imported timeline projection'
    )
  })

  it('feeds Ground-owned tool results back through the canonical conversation', async () => {
    const run = await harness([
      (request) => toolCallResponse(request, 'list_files', { depth: 1 }),
      (request) => textResponse(request, 'The workspace contains README.md.', true),
      (request) => textResponse(request, 'The file is README.md.')
    ])
    await writeFile(path.join(run.workspace, 'README.md'), '# Ground\n')

    await run.manager.start(run.taskId, 'What is in this workspace?')
    const terminal = await run.terminal

    expect(terminal.type).toBe('run-completed')
    expect(run.requests).toHaveLength(2)
    expect(run.requests[1]?.conversation.at(-1)).toMatchObject({
      kind: 'tool-result',
      name: 'list_files',
      isError: false
    })
    const task = run.store.getTask(run.taskId)
    expect(task.modelSessions?.[task.providerId]).toMatchObject({
      adapterId: 'test.model',
      model: 'llama3.2',
      workspacePath: run.workspace,
      mode: 'agent'
    })
    expect(task.modelSessions?.[task.providerId]?.conversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool-result', name: 'list_files' }),
        expect.objectContaining({ kind: 'message', role: 'assistant' })
      ])
    )
    expect(task.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'message',
          role: 'assistant',
          content: 'The workspace contains README.md.'
        }),
        expect.objectContaining({
          kind: 'activity',
          toolName: 'list_files',
          status: 'success'
        }),
        expect.objectContaining({
          kind: 'activity',
          title: 'Usage',
          detail: '12 input · 4 output · 16 total'
        })
      ])
    )

    await run.manager.start(run.taskId, 'Which file did you find?')
    await vi.waitFor(() => {
      expect(
        run.events.filter((event) => event.type === 'run-completed')
      ).toHaveLength(2)
    })
    expect(run.requests[2]?.conversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool-result', name: 'list_files' }),
        expect.objectContaining({
          kind: 'message',
          role: 'user',
          parts: [{ kind: 'text', text: 'Which file did you find?' }]
        })
      ])
    )
  })

  it('carries normalized tool context and provider attribution across providers', async () => {
    const run = await harness([
      (request) => toolCallResponse(request, 'list_files', { depth: 1 }),
      (request) => textResponse(request, 'I found README.md.'),
      (request) => textResponse(request, 'I can continue from that inspection.')
    ])
    await writeFile(path.join(run.workspace, 'README.md'), '# Ground\n')

    await run.manager.start(run.taskId, 'Inspect the workspace')
    await run.terminal
    const original = run.store.getTask(run.taskId)
    const currentProvider = run.store.getProvider(original.providerId)
    const timestamp = new Date().toISOString()
    await run.store.upsertProvider({
      ...currentProvider,
      id: 'second-provider',
      name: 'Second provider',
      model: 'second-model',
      createdAt: timestamp,
      updatedAt: timestamp
    })
    await run.store.mutateTask(run.taskId, (task) => {
      task.providerId = 'second-provider'
    })

    await run.manager.start(run.taskId, 'Continue with the other provider')
    await vi.waitFor(() => {
      expect(
        run.events.filter((event) => event.type === 'run-completed')
      ).toHaveLength(2)
    })

    const switchedConversation = run.requests[2]?.conversation ?? []
    expect(switchedConversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'message',
          role: 'assistant',
          parts: [
            expect.objectContaining({
              kind: 'tool-call',
              name: 'list_files'
            })
          ]
        }),
        expect.objectContaining({
          kind: 'tool-result',
          name: 'list_files',
          isError: false
        })
      ])
    )
    const assistantMessages = run.store
      .getTask(run.taskId)
      .items.filter(
        (item) => item.kind === 'message' && item.role === 'assistant'
      )
    expect(assistantMessages[0]?.provider?.name).toBe('Ollama · local')
    expect(assistantMessages.at(-1)?.provider?.name).toBe('Second provider')
  })

  it('gives API Ask mode only read-only workspace tools and rejects unadvertised writes', async () => {
    const run = await harness([
      (request) => toolCallResponse(request, 'read_file', { path: 'README.md' }),
      (request) =>
        toolCallResponse(request, 'write_file', {
          path: 'unexpected.txt',
          content: 'must not be written'
        }),
      (request) => textResponse(request, 'I inspected the workspace without changing it.')
    ])
    await writeFile(path.join(run.workspace, 'README.md'), '# Ground\n')
    await run.store.mutateTask(run.taskId, (task) => {
      task.mode = 'ask'
    })

    await run.manager.start(run.taskId, 'Read the project without changing it')
    expect((await run.terminal).type).toBe('run-completed')

    expect(run.requests[0]?.tools?.map((tool) => tool.name).sort()).toEqual([
      'list_files',
      'read_file',
      'search_files'
    ])
    expect(run.requests[0]?.instructions).toContain('read-only workspace tools')
    expect(run.requests[1]?.conversation.at(-1)).toMatchObject({
      kind: 'tool-result',
      name: 'read_file',
      isError: false
    })
    expect(run.requests[2]?.conversation.at(-1)).toMatchObject({
      kind: 'tool-result',
      name: 'write_file',
      isError: true,
      content: [
        expect.objectContaining({
          kind: 'text',
          text: expect.stringMatching(/unavailable in ask mode/i)
        })
      ]
    })
    await expect(
      readFile(path.join(run.workspace, 'unexpected.txt'), 'utf8')
    ).rejects.toThrow()
  })

  it('persists a model session against the immutable run workspace and mode', async () => {
    let releaseResponse: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const run = await harness([
      async function* (request) {
        await gate
        yield* textResponse(request, 'Bound to the original workspace.')
      }
    ])
    const otherWorkspace = path.join(run.directory, 'other-workspace')
    await mkdir(otherWorkspace)

    await run.manager.start(run.taskId, 'Keep this run bound')
    await vi.waitFor(() => expect(run.requests).toHaveLength(1))
    await run.store.mutateTask(run.taskId, (task) => {
      task.workspacePath = otherWorkspace
      task.mode = 'ask'
    })
    releaseResponse()
    expect((await run.terminal).type).toBe('run-completed')

    const task = run.store.getTask(run.taskId)
    expect(task.modelSessions?.[task.providerId]).toMatchObject({
      workspacePath: run.workspace,
      mode: 'agent'
    })
  })

  it('rejects duplicate tool-call identifiers before running any tool in the response', async () => {
    const run = await harness([
      (request) =>
        duplicateToolCallResponse(request, 'write_file', {
          path: 'must-not-exist.txt',
          content: 'unsafe replay\n'
        })
    ])

    await run.manager.start(run.taskId, 'Do not replay duplicate calls')
    const terminal = await run.terminal

    expect(terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(/repeated a tool-call identifier/i)
    })
    expect(
      run.events.some((event) => event.type === 'approval-requested')
    ).toBe(false)
    await expect(
      readFile(path.join(run.workspace, 'must-not-exist.txt'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a tool-call identifier repeated across model rounds', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(
          request,
          'read_file',
          { path: 'existing.txt' },
          'provider-repeated-call'
        ),
      (request) =>
        toolCallResponse(
          request,
          'write_file',
          {
            path: 'must-not-be-written.txt',
            content: 'replayed\n'
          },
          'provider-repeated-call'
        )
    ])
    await writeFile(path.join(run.workspace, 'existing.txt'), 'read once\n')

    await run.manager.start(run.taskId, 'Reject a repeated call')
    expect(await run.terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(/repeated a tool-call identifier/i)
    })
    expect(run.requests).toHaveLength(2)
    expect(
      run.events.some((event) => event.type === 'approval-requested')
    ).toBe(false)
    await expect(
      readFile(path.join(run.workspace, 'must-not-be-written.txt'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('seeds replay protection from durable completed managed claims', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(
          request,
          'write_file',
          {
            path: 'must-not-replay.txt',
            content: 'duplicate side effect\n'
          },
          'durably-completed-call'
        )
    ])
    await run.store.mutateTask(run.taskId, (task) => {
      task.items.push({
        id: 'completed-operation',
        kind: 'activity',
        runId: 'earlier-run',
        activityType: 'tool',
        title: 'Earlier write',
        status: 'success',
        toolName: 'write_file',
        callId: 'durably-completed-call',
        result: 'Wrote the file.',
        durationMs: 5,
        createdAt: '2026-07-28T12:00:00.000Z',
        managedExecution: {
          version: 1,
          operationId: 'completed-operation',
          claim: 'approved',
          kind: 'workspace-write',
          actionSha256: 'c'.repeat(64),
          approvalSha256: 'd'.repeat(64),
          phase: 'completed',
          startedAt: '2026-07-28T12:00:00.000Z',
          completedAt: '2026-07-28T12:00:01.000Z'
        }
      })
    })

    await run.manager.start(run.taskId, 'Do not replay the earlier call')
    expect(await run.terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(/repeated a tool-call identifier/i)
    })
    expect(
      run.events.some((event) => event.type === 'approval-requested')
    ).toBe(false)
    await expect(
      readFile(path.join(run.workspace, 'must-not-replay.txt'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a positive renderer decision without the exact native approval fingerprint', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(request, 'write_file', {
          path: 'native-only.txt',
          content: 'must remain pending\n'
        }),
      (request) => textResponse(request, 'The write was denied.')
    ])

    const runId = await run.manager.start(run.taskId, 'Require native approval')
    const approval = await run.approval
    const approvalId = approval.item.approvalId as string

    await expect(
      run.manager.resolveApproval(runId, approvalId, true)
    ).rejects.toThrow(/exact native approval fingerprint/i)
    expect(run.manager.getPendingApproval(runId, approvalId)).toMatchObject({
      runId,
      approvalId
    })
    await run.manager.resolveApproval(runId, approvalId, false)
    expect((await run.terminal).type).toBe('run-completed')
    await expect(
      readFile(path.join(run.workspace, 'native-only.txt'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('executes the exact write envelope that was approved', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(request, 'write_file', {
          path: 'tracked.txt',
          content: 'model edit\n'
        }),
      (request) => textResponse(request, 'The approved edit could not be applied safely.')
    ])
    const target = path.join(run.workspace, 'tracked.txt')
    await writeFile(target, 'before\n')

    const runId = await run.manager.start(run.taskId, 'Update tracked.txt')
    const approval = await run.approval
    expect(approval.item.detail).toContain('+model edit')
    expect(
      run.manager.getPendingApproval(
        runId,
        approval.item.approvalId as string
      )
    ).toMatchObject({
      runId,
      taskId: run.taskId,
      approvalId: approval.item.approvalId,
      title: 'Update tracked.txt',
      detail: approval.item.detail,
      toolName: 'write_file'
    })

    await writeFile(target, 'concurrent user edit\n')
    await approvePending(
      run.manager,
      runId,
      approval.item.approvalId as string
    )
    const terminal = await run.terminal

    expect(terminal.type).toBe('run-completed')
    expect(await readFile(target, 'utf8')).toBe('concurrent user edit\n')
    expect(run.requests[1]?.conversation.at(-1)).toMatchObject({
      kind: 'tool-result',
      name: 'write_file',
      isError: true
    })
    const task = run.store.getTask(run.taskId)
    expect(task.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'activity',
          toolName: 'write_file',
          status: 'error',
          result: expect.stringMatching(/changed since approval/i)
        })
      ])
    )
  })

  it('never performs a managed write when the durable start claim cannot be saved', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(request, 'write_file', {
          path: 'not-started.txt',
          content: 'must not be written\n'
        })
    ])
    const begin = vi
      .spyOn(run.store, 'beginManagedExecution')
      .mockRejectedValueOnce(new Error('simulated durable start failure'))

    const runId = await run.manager.start(run.taskId, 'Fail before execution')
    const approval = await run.approval
    await approvePending(
      run.manager,
      runId,
      approval.item.approvalId as string
    )

    expect(await run.terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(/simulated durable start failure/i)
    })
    expect(begin).toHaveBeenCalledTimes(1)
    expect(run.requests).toHaveLength(1)
    await expect(
      readFile(path.join(run.workspace, 'not-started.txt'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops without model continuation or replay when outcome persistence fails after a write', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(request, 'write_file', {
          path: 'outcome-unknown.txt',
          content: 'the side effect happened\n'
        }),
      (request) => textResponse(request, 'Must not be requested.')
    ])
    const complete = vi
      .spyOn(run.store, 'completeManagedExecution')
      .mockRejectedValueOnce(new Error('simulated durable completion failure'))

    const runId = await run.manager.start(
      run.taskId,
      'Stop if the completion record fails'
    )
    const approval = await run.approval
    await approvePending(
      run.manager,
      runId,
      approval.item.approvalId as string
    )

    expect(await run.terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(/simulated durable completion failure/i)
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(run.requests).toHaveLength(1)
    expect(
      await readFile(path.join(run.workspace, 'outcome-unknown.txt'), 'utf8')
    ).toBe('the side effect happened\n')

    const unresolved = run.store
      .getTask(run.taskId)
      .items.find((item) => item.id === approval.item.id)
    expect(unresolved).toMatchObject({
      kind: 'activity',
      status: 'running',
      managedExecution: {
        operationId: approval.item.id,
        phase: 'started',
        claim: 'approved'
      }
    })
    await expect(
      run.manager.start(run.taskId, 'Do not replay the uncertain action')
    ).rejects.toThrow(/unresolved outcome/i)
    expect(run.requests).toHaveLength(1)
  })

  it.runIf(process.platform !== 'win32')(
    'keeps canonical command paths in the native approval envelope only',
    async () => {
      const run = await harness([
        (request) =>
          toolCallResponse(request, 'run_command', {
            command: './approved-command'
          }),
        (request) => textResponse(request, 'The command was denied.')
      ])
      const executable = path.join(run.workspace, 'approved-command')
      await writeFile(executable, '#!/bin/sh\nprintf approved\n')
      await chmod(executable, 0o755)

      const runId = await run.manager.start(
        run.taskId,
        'Run the workspace command'
      )
      const approval = await run.approval
      expect(approval.item.detail).toContain('<workspace>')
      expect(approval.item.detail).not.toContain(run.workspace)
      expect(
        run.manager.getPendingApproval(
          runId,
          approval.item.approvalId as string
        ).detail
      ).toContain(run.workspace)

      await run.manager.resolveApproval(
        runId,
        approval.item.approvalId as string,
        false
      )
      expect((await run.terminal).type).toBe('run-completed')
      const persisted = run.store
        .getTask(run.taskId)
        .items.find((item) => item.id === approval.item.id)
      if (!persisted || persisted.kind !== 'activity') {
        throw new Error('Expected the persisted command activity')
      }
      expect(persisted.detail).not.toContain(run.workspace)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'durably claims and completes an approved command before model continuation',
    async () => {
      const run = await harness([
        (request) =>
          toolCallResponse(request, 'run_command', {
            command: './durable-command'
          }),
        (request) => textResponse(request, 'The command completed.')
      ])
      const executable = path.join(run.workspace, 'durable-command')
      await writeFile(executable, '#!/bin/sh\nprintf durable-command-result\n')
      await chmod(executable, 0o755)

      const runId = await run.manager.start(run.taskId, 'Run it once')
      const approval = await run.approval
      const nativeApproval = run.manager.getPendingApproval(
        runId,
        approval.item.approvalId as string
      )
      await approvePending(
        run.manager,
        runId,
        approval.item.approvalId as string
      )
      expect((await run.terminal).type).toBe('run-completed')

      expect(
        run.store
          .getTask(run.taskId)
          .items.find((item) => item.id === approval.item.id)
      ).toMatchObject({
        kind: 'activity',
        activityType: 'command',
        status: 'success',
        result: expect.stringContaining('durable-command-result'),
        managedExecution: {
          operationId: approval.item.id,
          claim: 'approved',
          kind: 'command',
          phase: 'completed',
          approvalSha256: agentApprovalFingerprint(nativeApproval),
          actionSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        }
      })
      expect(run.requests).toHaveLength(2)
    }
  )

  it('shows and executes the exact localized edit envelope that was approved', async () => {
    const run = await harness([
      (request) =>
        toolCallResponse(request, 'edit_file', {
          path: 'tracked.txt',
          old_text: 'before',
          new_text: 'after'
        }),
      (request) => textResponse(request, 'The localized edit is complete.')
    ])
    const target = path.join(run.workspace, 'tracked.txt')
    await writeFile(target, 'line before line\n')

    const runId = await run.manager.start(run.taskId, 'Edit tracked.txt')
    const approval = await run.approval
    expect(approval.item.title).toBe('Edit tracked.txt')
    expect(approval.item.detail).toContain('-line before line')
    expect(approval.item.detail).toContain('+line after line')
    const nativeApproval = run.manager.getPendingApproval(
      runId,
      approval.item.approvalId as string
    )

    await approvePending(
      run.manager,
      runId,
      approval.item.approvalId as string
    )
    expect((await run.terminal).type).toBe('run-completed')
    expect(await readFile(target, 'utf8')).toBe('line after line\n')
    expect(run.requests[1]?.conversation.at(-1)).toMatchObject({
      kind: 'tool-result',
      name: 'edit_file',
      isError: false,
      content: [
        expect.objectContaining({
          kind: 'text',
          text: 'Edited tracked.txt.'
        })
      ]
    })
    expect(
      run.store
        .getTask(run.taskId)
        .items.find((item) => item.id === approval.item.id)
    ).toMatchObject({
      kind: 'activity',
      activityType: 'tool',
      status: 'success',
      managedExecution: {
        operationId: approval.item.id,
        claim: 'approved',
        kind: 'workspace-write',
        phase: 'completed',
        approvalSha256: agentApprovalFingerprint(nativeApproval),
        actionSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
  })

  it('shows exact MCP arguments and definition identity before every call', async () => {
    const connectionFingerprint = 'b'.repeat(64)
    const executeTool = vi.fn(async () => ({
      serverId: 'demo',
      toolName: 'mcp__demo__lookup',
      isError: false,
      result: { answer: 42 },
      truncated: false,
      byteLength: 13
    }))
    const mcp: McpRuntime = {
      listApprovedTools: () => [
        {
          definition: {
            name: 'mcp__demo__lookup',
            description: 'Look up a value',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false
            }
          },
          metadata: {
            source: 'mcp',
            approvalRequired: true,
            serverId: 'demo',
            serverName: 'Demo server',
            connectionFingerprint,
            originalName: 'lookup',
            fingerprint: 'a'.repeat(64),
            trustStatus: 'approved'
          }
        }
      ],
      executeTool
    }
    const run = await harness(
      [
        (request) =>
          toolCallResponse(request, 'mcp__demo__lookup', {
            query: 'meaning of life'
          }),
        (request) => textResponse(request, 'The result is 42.')
      ],
      mcp
    )

    const runId = await run.manager.start(run.taskId, 'Use the demo lookup')
    const approval = await run.approval
    const nativeApproval = run.manager.getPendingApproval(
      runId,
      approval.item.approvalId as string
    )

    expect(executeTool).not.toHaveBeenCalled()
    expect(approval.item.detail).toContain('Server: Demo server')
    expect(approval.item.detail).toContain(
      `Connection SHA-256: ${connectionFingerprint}`
    )
    expect(approval.item.detail).toContain(`Definition SHA-256: ${'a'.repeat(64)}`)
    expect(approval.item.detail).toContain('"query": "meaning of life"')
    await approvePending(
      run.manager,
      runId,
      approval.item.approvalId as string
    )
    expect((await run.terminal).type).toBe('run-completed')

    expect(executeTool).toHaveBeenCalledWith(
      'mcp__demo__lookup',
      { query: 'meaning of life' },
      expect.objectContaining({
        approvalGranted: true,
        expectedConnectionFingerprint: connectionFingerprint
      })
    )
    expect(run.requests[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'mcp__demo__lookup' })
      ])
    )
    expect(run.requests[1]?.conversation.at(-1)).toMatchObject({
      kind: 'tool-result',
      name: 'mcp__demo__lookup',
      isError: false
    })
    expect(
      run.store
        .getTask(run.taskId)
        .items.find((item) => item.id === approval.item.id)
    ).toMatchObject({
      kind: 'activity',
      activityType: 'tool',
      status: 'success',
      managedExecution: {
        operationId: approval.item.id,
        claim: 'approved',
        kind: 'mcp',
        phase: 'completed',
        approvalSha256: agentApprovalFingerprint(nativeApproval),
        actionSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
  })

  it('waits for MCP startup before planning the first model request', async () => {
    let releaseReady: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    const listApprovedTools = vi.fn(() => [])
    const mcp: McpRuntime = {
      ready: () => ready,
      listApprovedTools,
      executeTool: vi.fn(async () => {
        throw new Error('No MCP execution was expected')
      })
    }
    const run = await harness(
      [(request) => textResponse(request, 'Ready after MCP startup.')],
      mcp
    )

    await run.manager.start(run.taskId, 'Wait for tools')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(run.requests).toHaveLength(0)
    expect(listApprovedTools).not.toHaveBeenCalled()

    releaseReady()
    expect((await run.terminal).type).toBe('run-completed')
    expect(listApprovedTools).toHaveBeenCalled()
    expect(run.requests).toHaveLength(1)
  })
})
