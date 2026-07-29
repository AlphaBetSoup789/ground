import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  ActivityItem,
  CliProvider,
  RunEvent,
  Task
} from '../shared/types'
import {
  AdapterRegistry,
  DEFAULT_AGENT_RUNTIME_CAPABILITIES,
  type AdapterContext,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type AgentRuntimeEvent
} from './agent'
import { cliEnvironmentSecretReference } from './cli-environment'
import {
  RunManager,
  createRegisteredAgentRuntimeFactory,
  type AgentRuntimeFactory
} from './run-manager'
import type { SecretVault } from './secrets'
import { StateStore } from './store'

const TIMESTAMP = '2026-07-29T12:00:00.000Z'
const PROVIDER_ID = 'custom-agent-runtime'

interface ScriptedRuntimeConfig {
  providerId: string
}

interface ScriptedRuntimeOptions {
  id: string
  events: (
    request: AgentRunRequest,
    context: AdapterContext<ScriptedRuntimeConfig>
  ) => readonly unknown[] | Promise<readonly unknown[]>
  onRequest?: (request: AgentRunRequest) => void
}

interface FixtureResult {
  events: RunEvent[]
  task: Task
  terminal: RunEvent
  runAgain(prompt?: string): Promise<RunEvent>
  getTask(): Task
}

function scriptedRuntime(
  options: ScriptedRuntimeOptions
): AgentRuntimeAdapter<ScriptedRuntimeConfig> {
  return {
    id: options.id,
    validateConfig(value: unknown): ScriptedRuntimeConfig {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as Record<string, unknown>).providerId !== 'string'
      ) {
        throw new TypeError('Scripted runtime configuration is invalid')
      }
      return Object.freeze({
        providerId: (value as { providerId: string }).providerId
      })
    },
    async inspect() {
      return { capabilities: DEFAULT_AGENT_RUNTIME_CAPABILITIES }
    },
    async *run(request, context) {
      options.onRequest?.(structuredClone(request))
      for (const event of await options.events(request, context)) {
        yield event as AgentRuntimeEvent
      }
    }
  }
}

function runtimeFactory(
  adapter: AgentRuntimeAdapter<ScriptedRuntimeConfig>,
  sessionCompatibilityId?: string
): AgentRuntimeFactory {
  const registry = new AdapterRegistry().registerAgentRuntime(adapter)
  return createRegisteredAgentRuntimeFactory(registry, (provider) => ({
    adapterId: adapter.id,
    config: { providerId: provider.id },
    ...(sessionCompatibilityId === undefined
      ? {}
      : { sessionCompatibilityId })
  }))
}

function successfulRuntimeEvents(
  request: AgentRunRequest
): readonly AgentRuntimeEvent[] {
  const sessionId = request.resume?.sessionId ?? 'runtime-session-next'
  return [
    {
      type: 'runtime.started',
      ...(request.resume ? { sessionId } : {}),
      servingModel: 'custom-serving-model'
    },
    { type: 'assistant.delta', delta: 'Hello ' },
    { type: 'assistant.delta', delta: 'from the runtime.' },
    {
      type: 'activity.started',
      activityId: 'runtime-command-1',
      kind: 'command',
      title: 'npm test',
      detail: 'Starting tests'
    },
    {
      type: 'activity.updated',
      activityId: 'runtime-command-1',
      detail: 'Tests are running'
    },
    {
      type: 'activity.completed',
      activityId: 'runtime-command-1',
      status: 'success',
      detail: 'All tests passed'
    },
    {
      type: 'usage.updated',
      semantics: 'cumulative',
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6,
        costUsd: 0.25
      }
    },
    {
      type: 'runtime.completed',
      sessionId,
      stopReason: 'complete'
    }
  ]
}

async function runFixture(options: {
  factory: AgentRuntimeFactory
  savedSession?: {
    adapterId: string
    sessionCompatibilityId: string
    sessionId?: string
  }
  environmentSecret?: string
  onEvent?: (event: RunEvent, manager: RunManager) => void
  configureStore?: (store: StateStore) => void
}): Promise<FixtureResult> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ground-agent-runtime-integration-')
  )
  const workspaceCandidate = path.join(directory, 'workspace')
  await mkdir(workspaceCandidate)
  const workspace = await realpath(workspaceCandidate)
  const store = new StateStore(path.join(directory, 'state.json'))
  await store.load()
  options.configureStore?.(store)
  const provider: CliProvider = {
    id: PROVIDER_ID,
    name: 'Custom agent runtime',
    kind: 'cli',
    model: 'custom-model',
    command: process.execPath,
    args: [],
    promptMode: 'stdin',
    outputMode: 'ndjson',
    cliAdapter: 'generic',
    ...(options.environmentSecret
      ? {
          environmentVariables: ['ACME_RUNTIME_TOKEN'],
          environmentFingerprint: 'e'.repeat(64)
        }
      : {}),
    trustConfirmed: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  }
  await store.upsertProvider(provider)
  const created = await store.createTask(workspace)
  await store.mutateTask(created.id, (task) => {
    task.providerId = provider.id
    if (options.savedSession) {
      task.runtimeSessions = {
        [provider.id]: {
          ...options.savedSession,
          sessionId:
            options.savedSession.sessionId ??
            'runtime-session-previous',
          providerRevision: provider.updatedAt,
          workspacePath: workspace,
          mode: task.mode,
          updatedAt: TIMESTAMP
        }
      }
    }
  })

  const events: RunEvent[] = []
  let resolveTerminal: (event: RunEvent) => void = () => undefined
  const terminal = new Promise<RunEvent>((resolve) => {
    resolveTerminal = resolve
  })
  let manager: RunManager
  manager = new RunManager(
    store,
    {
      get: () =>
        options.environmentSecret
          ? JSON.stringify({
              version: 1,
              fingerprint: provider.environmentFingerprint,
              values: {
                ACME_RUNTIME_TOKEN: options.environmentSecret
              }
            })
          : undefined
    } as unknown as SecretVault,
    (event) => {
      events.push(event)
      options.onEvent?.(event, manager)
      if (
        event.type === 'run-completed' ||
        event.type === 'run-stopped' ||
        event.type === 'run-error'
      ) {
        resolveTerminal(event)
      }
    },
    undefined,
    undefined,
    undefined,
    undefined,
    (candidate) => realpath(candidate),
    options.factory
  )

  await manager.start(created.id, 'Inspect this workspace')
  const terminalEvent = await terminal
  return {
    events,
    task: store.getTask(created.id),
    terminal: terminalEvent,
    runAgain: async (prompt = 'Continue this task') => {
      const nextTerminal = new Promise<RunEvent>((resolve) => {
        resolveTerminal = resolve
      })
      await manager.start(created.id, prompt)
      return nextTerminal
    },
    getTask: () => store.getTask(created.id)
  }
}

describe('RunManager registered agent-runtime integration', () => {
  it('persists normalized text, activity, usage, and compatible session metadata', async () => {
    const adapter = scriptedRuntime({
      id: 'community.scripted-runtime',
      events: successfulRuntimeEvents
    })
    const run = await runFixture({
      factory: runtimeFactory(adapter, 'scripted-session-v1')
    })

    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    expect(
      run.task.items.find(
        (item) => item.kind === 'message' && item.role === 'assistant'
      )
    ).toMatchObject({
      content: 'Hello from the runtime.',
      provider: {
        id: PROVIDER_ID,
        model: 'custom-model'
      }
    })
    const command = run.task.items.find(
      (item): item is ActivityItem =>
        item.kind === 'activity' &&
        item.title === 'npm test'
    )
    expect(command).toMatchObject({
      activityType: 'command',
      title: 'npm test',
      detail: 'All tests passed',
      status: 'success',
      callId: expect.stringMatching(
        /^runtime-activity_[0-9a-f-]{36}$/u
      )
    })
    expect(
      run.task.items.find(
        (item) =>
          item.kind === 'activity' &&
          item.title === 'Usage'
      )
    ).toMatchObject({
      detail: expect.stringContaining(
        '4 input · 2 output · 6 total · $0.2500'
      ),
      status: 'success'
    })
    expect(run.task.runtimeSessions?.[PROVIDER_ID]).toMatchObject({
      adapterId: adapter.id,
      sessionCompatibilityId: 'scripted-session-v1',
      sessionId: 'runtime-session-next',
      providerRevision: TIMESTAMP
    })
    expect(
      run.events.filter((event) => event.type === 'text-delta')
    ).toEqual([
      expect.objectContaining({ delta: 'Hello ', offset: 0 }),
      expect.objectContaining({
        delta: 'from the runtime.',
        offset: 6
      })
    ])
  })

  it('redacts resolved environment secrets from every persisted runtime projection', async () => {
    const configuredSecret = 'adapter-"secret"\\😀tail'
    const escapedSecret = JSON.stringify(configuredSecret).slice(1, -1)
    const adapter = scriptedRuntime({
      id: 'community.secret-reflecting-runtime',
      events: async (_request, context) => {
        const envelope = JSON.parse(
          await context.secrets.resolve(
            cliEnvironmentSecretReference(PROVIDER_ID)
          )
        ) as {
          values: { ACME_RUNTIME_TOKEN: string }
        }
        const secret = envelope.values.ACME_RUNTIME_TOKEN
        const escaped = JSON.stringify(secret).slice(1, -1)
        const split = secret.indexOf('😀') + 1
        const escapedSplit = Math.floor(escaped.length / 2)
        const activityId = `runtime-${secret}`
        return [
          { type: 'runtime.started', servingModel: 'safe-model' },
          {
            type: 'assistant.delta',
            delta: `before ${secret.slice(0, split)}`
          },
          {
            type: 'assistant.delta',
            delta: `${secret.slice(split)} and ${escaped.slice(
              0,
              escapedSplit
            )}`
          },
          {
            type: 'assistant.delta',
            delta: `${escaped.slice(escapedSplit)} after`
          },
          {
            type: 'activity.started',
            activityId,
            kind: 'command',
            title: secret,
            detail: `escaped=${escaped}`
          },
          {
            type: 'activity.completed',
            activityId,
            status: 'success',
            detail: `raw=${secret}; escaped=${escaped}`
          },
          {
            type: 'provider.notice',
            level: 'warning',
            code: `runtime.${secret}`,
            message: `notice ${escaped}`
          },
          {
            type: 'runtime.completed',
            sessionId: 'safe-runtime-session',
            stopReason: 'complete'
          }
        ]
      }
    })
    const run = await runFixture({
      factory: runtimeFactory(adapter, 'secret-session-v1'),
      environmentSecret: configuredSecret
    })

    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    const persistedProjection = JSON.stringify({
      events: run.events,
      task: run.task
    })
    expect(persistedProjection).not.toContain(configuredSecret)
    expect(persistedProjection).not.toContain(escapedSecret)
    expect(
      run.task.items.find(
        (item) => item.kind === 'message' && item.role === 'assistant'
      )
    ).toMatchObject({
      content: expect.stringMatching(
        /^before █{4} and █{4} after$/u
      )
    })
    expect(
      run.task.items.find(
        (item): item is ActivityItem =>
          item.kind === 'activity' &&
          item.activityType === 'command'
      )
    ).toMatchObject({
      title: '████',
      detail: expect.stringContaining('████'),
      callId: expect.stringMatching(
        /^runtime-activity_[0-9a-f-]{36}$/u
      )
    })
    expect(
      run.task.items.find(
        (item) =>
          item.kind === 'activity' &&
          item.title === 'Runtime notices'
      )
    ).toMatchObject({
      detail: expect.stringContaining('████')
    })
    expect(run.task.runtimeSessions?.[PROVIDER_ID]).toMatchObject({
      sessionId: 'safe-runtime-session'
    })
  })

  it('coalesces transient runtime activity updates into one durable completion', async () => {
    const transientEvents = Array.from({ length: 100 }, (_, index) =>
      index % 2 === 0
        ? {
            type: 'activity.updated',
            activityId: 'progress-1'
          }
        : {
            type: 'activity.updated',
            activityId: 'progress-1',
            detail: `Progress ${index}`
          }
    )
    const adapter = scriptedRuntime({
      id: 'community.progress-runtime',
      events: () => [
        { type: 'runtime.started' },
        {
          type: 'activity.started',
          activityId: 'progress-1',
          kind: 'diagnostic',
          title: 'Long operation',
          detail: 'Starting'
        },
        ...transientEvents,
        {
          type: 'activity.completed',
          activityId: 'progress-1',
          status: 'success'
        },
        { type: 'runtime.completed', stopReason: 'complete' }
      ]
    })
    let updateItem: ReturnType<typeof vi.spyOn> | undefined
    const run = await runFixture({
      factory: runtimeFactory(adapter),
      configureStore: (store) => {
        updateItem = vi.spyOn(store, 'updateItem')
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    expect(updateItem).toHaveBeenCalledTimes(1)
    expect(
      run.task.items.find(
        (item) =>
          item.kind === 'activity' &&
          item.title === 'Long operation'
      )
    ).toMatchObject({
      detail: 'Progress 99',
      status: 'success'
    })
  })

  it('persists the latest coalesced activity detail when the runtime fails', async () => {
    const adapter = scriptedRuntime({
      id: 'community.failed-progress-runtime',
      events: () => [
        { type: 'runtime.started' },
        {
          type: 'activity.started',
          activityId: 'progress-1',
          kind: 'diagnostic',
          title: 'Long operation',
          detail: 'Starting'
        },
        {
          type: 'activity.updated',
          activityId: 'progress-1',
          detail: 'Latest checkpoint'
        },
        { type: 'runtime.future-wire-event' }
      ]
    })
    let updateItem: ReturnType<typeof vi.spyOn> | undefined
    const run = await runFixture({
      factory: runtimeFactory(adapter),
      configureStore: (store) => {
        updateItem = vi.spyOn(store, 'updateItem')
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-error' })
    expect(updateItem).not.toHaveBeenCalled()
    expect(
      run.task.items.find(
        (item) =>
          item.kind === 'activity' &&
          item.title === 'Long operation'
      )
    ).toMatchObject({
      detail:
        'Latest checkpoint\n\nThe runtime ended before reporting completion.',
      status: 'error'
    })
  })

  it('batches every open activity finalization into one state mutation', async () => {
    const activityCount = 5
    const adapter = scriptedRuntime({
      id: 'community.batched-failure-runtime',
      events: () => [
        { type: 'runtime.started' },
        ...Array.from({ length: activityCount }, (_, index) => [
          {
            type: 'activity.started',
            activityId: `batch-${index}`,
            kind: 'diagnostic',
            title: `Batch activity ${index}`,
            detail: 'Starting'
          },
          {
            type: 'activity.updated',
            activityId: `batch-${index}`,
            detail: `Latest checkpoint ${index}`
          }
        ]).flat(),
        { type: 'runtime.future-wire-event' }
      ]
    })
    let mutationCalls = 0
    let callsAfterLastActivityStarted: number | undefined
    const run = await runFixture({
      factory: runtimeFactory(adapter),
      configureStore: (store) => {
        const original = store.mutateTask.bind(store)
        vi.spyOn(store, 'mutateTask').mockImplementation(
          async (taskId, mutator, persist) => {
            mutationCalls += 1
            return original(taskId, mutator, persist)
          }
        )
      },
      onEvent: (event) => {
        if (
          event.type === 'item-added' &&
          event.item.kind === 'activity' &&
          event.item.title === `Batch activity ${activityCount - 1}`
        ) {
          callsAfterLastActivityStarted = mutationCalls
        }
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-error' })
    expect(callsAfterLastActivityStarted).toBeTypeOf('number')
    expect(mutationCalls - (callsAfterLastActivityStarted ?? 0)).toBe(2)
    for (let index = 0; index < activityCount; index += 1) {
      expect(
        run.task.items.find(
          (item) =>
            item.kind === 'activity' &&
            item.title === `Batch activity ${index}`
        )
      ).toMatchObject({
        detail: `Latest checkpoint ${index}\n\nThe runtime ended before reporting completion.`,
        status: 'error'
      })
    }
  })

  it('closes a blocked runtime before finalizing its open activities', async () => {
    let cleanupFinished = false
    let activityUpdateObservedAfterCleanup = false
    const adapter: AgentRuntimeAdapter<ScriptedRuntimeConfig> = {
      id: 'community.cleanup-order-runtime',
      validateConfig(value: unknown): ScriptedRuntimeConfig {
        return value as ScriptedRuntimeConfig
      },
      async inspect() {
        return { capabilities: DEFAULT_AGENT_RUNTIME_CAPABILITIES }
      },
      run() {
        let step = 0
        const iterator: AsyncIterator<AgentRuntimeEvent> = {
          next: () => {
            step += 1
            if (step === 1) {
              return Promise.resolve({
                done: false,
                value: { type: 'runtime.started' }
              })
            }
            if (step === 2) {
              return Promise.resolve({
                done: false,
                value: {
                  type: 'activity.started',
                  activityId: 'blocking-activity',
                  kind: 'diagnostic',
                  title: 'Blocking activity',
                  detail: 'Waiting'
                }
              })
            }
            return new Promise<IteratorResult<AgentRuntimeEvent>>(
              () => undefined
            )
          },
          return: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
            cleanupFinished = true
            return { done: true, value: undefined }
          }
        }
        return {
          [Symbol.asyncIterator]: () => iterator
        }
      }
    }
    let stopScheduled = false
    const run = await runFixture({
      factory: runtimeFactory(adapter),
      onEvent: (event, manager) => {
        if (
          event.type === 'item-added' &&
          event.item.kind === 'activity' &&
          event.item.title === 'Blocking activity' &&
          !stopScheduled
        ) {
          stopScheduled = true
          setTimeout(() => {
            void manager.stop(event.runId)
          }, 0)
        }
        if (
          event.type === 'item-updated' &&
          event.item.kind === 'activity' &&
          event.item.title === 'Blocking activity'
        ) {
          activityUpdateObservedAfterCleanup = cleanupFinished
        }
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-stopped' })
    expect(cleanupFinished).toBe(true)
    expect(activityUpdateObservedAfterCleanup).toBe(true)
    expect(
      run.task.items.find(
        (item) =>
          item.kind === 'activity' &&
          item.title === 'Blocking activity'
      )
    ).toMatchObject({
      detail:
        'Waiting\n\nThe run stopped before the runtime reported completion.',
      status: 'error'
    })
  })

  it('compensates a runtime-session write when Stop lands during persistence', async () => {
    const adapter = scriptedRuntime({
      id: 'community.session-race-runtime',
      events: successfulRuntimeEvents
    })
    let activeManager: RunManager | undefined
    let mutationCalls = 0
    const run = await runFixture({
      factory: runtimeFactory(adapter, 'session-race-v1'),
      onEvent: (_event, manager) => {
        activeManager = manager
      },
      configureStore: (store) => {
        const original = store.mutateTask.bind(store)
        vi.spyOn(store, 'mutateTask').mockImplementation(
          async (taskId, mutator) => {
            mutationCalls += 1
            if (mutationCalls === 3) {
              const persistence = original(taskId, mutator)
              queueMicrotask(() => {
                if (activeManager) {
                  void activeManager.stopTask(taskId)
                }
              })
              return persistence
            }
            return original(taskId, mutator)
          }
        )
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-stopped' })
    expect(run.task.runtimeSessions).toBeUndefined()
  })

  it('fails closed instead of persisting a secret-bearing runtime session', async () => {
    const configuredSecret = 'session-secret-value'
    const adapter = scriptedRuntime({
      id: 'community.secret-session-runtime',
      events: async (_request, context) => {
        const envelope = JSON.parse(
          await context.secrets.resolve(
            cliEnvironmentSecretReference(PROVIDER_ID)
          )
        ) as {
          values: { ACME_RUNTIME_TOKEN: string }
        }
        return [
          { type: 'runtime.started' },
          { type: 'assistant.delta', delta: 'Safe partial response.' },
          {
            type: 'runtime.completed',
            sessionId:
              `session-${envelope.values.ACME_RUNTIME_TOKEN}`,
            stopReason: 'complete'
          }
        ]
      }
    })
    const run = await runFixture({
      factory: runtimeFactory(adapter, 'secret-session-v1'),
      environmentSecret: configuredSecret
    })

    expect(run.terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(
        /protected CLI environment value/i
      )
    })
    expect(run.task.runtimeSessions).toBeUndefined()
    expect(JSON.stringify({ events: run.events, task: run.task }))
      .not.toContain(configuredSecret)
  })

  it('fails closed on a malformed stream and never persists its proposed session', async () => {
    const requests: AgentRunRequest[] = []
    let calls = 0
    const adapter = scriptedRuntime({
      id: 'community.malformed-runtime',
      onRequest: (request) => requests.push(request),
      events: (request) => {
        calls += 1
        return calls === 1
          ? [
              {
                type: 'runtime.started',
                sessionId: request.resume?.sessionId
              },
              {
                type: 'assistant.delta',
                delta: 'Partial response'
              },
              {
                type: 'runtime.future-wire-event',
                sessionId: 'must-not-persist'
              }
            ]
          : successfulRuntimeEvents(request)
      }
    })
    const run = await runFixture({
      factory: runtimeFactory(adapter, 'malformed-session-v1'),
      savedSession: {
        adapterId: adapter.id,
        sessionCompatibilityId: 'malformed-session-v1'
      }
    })

    expect(run.terminal).toMatchObject({
      type: 'run-error',
      message: expect.stringMatching(
        /unknown normalized agent runtime event/i
      )
    })
    expect(run.task.runStatus).toBe('failed')
    expect(run.task.runtimeSessions).toBeUndefined()
    expect(
      run.task.items.find(
        (item) => item.kind === 'message' && item.role === 'assistant'
      )
    ).toMatchObject({ content: 'Partial response' })
    expect(requests[0]?.resume).toEqual({
      sessionId: 'runtime-session-previous'
    })

    await expect(run.runAgain()).resolves.toMatchObject({
      type: 'run-completed'
    })
    expect(requests[1]?.resume).toBeUndefined()
  })

  it('projects no terminal output or session after the run is stopped', async () => {
    const adapter = scriptedRuntime({
      id: 'community.abort-ignoring-runtime',
      events: () => [
        { type: 'runtime.started' },
        {
          type: 'provider.notice',
          level: 'warning',
          code: 'should-not-persist',
          message: 'This notice was emitted before a late terminal event.'
        },
        {
          type: 'usage.updated',
          semantics: 'cumulative',
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }
        },
        { type: 'assistant.delta', delta: 'Do not persist this partial output.' },
        {
          type: 'runtime.completed',
          sessionId: 'late-session-after-abort',
          stopReason: 'complete'
        }
      ]
    })
    let stopRequested = false
    const run = await runFixture({
      factory: runtimeFactory(adapter, 'abort-session-v1'),
      onEvent: (event, manager) => {
        if (event.type !== 'text-delta' || stopRequested) return
        stopRequested = true
        void manager.stop(event.runId)
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-stopped' })
    expect(stopRequested).toBe(true)
    expect(run.task.runtimeSessions).toBeUndefined()
    expect(
      run.task.items.some(
        (item) => item.kind === 'message' && item.role === 'assistant'
      )
    ).toBe(false)
    expect(
      run.task.items.some(
        (item) =>
          item.kind === 'activity' &&
          (item.title === 'Usage' || item.title === 'Runtime notices')
      )
    ).toBe(false)
  })

  it('stops a blocked iterator promptly and consumes its saved session lease', async () => {
    const requests: AgentRunRequest[] = []
    let runCalls = 0
    let returnCalls = 0
    const adapter: AgentRuntimeAdapter<ScriptedRuntimeConfig> = {
      id: 'community.blocked-runtime',
      validateConfig(value: unknown): ScriptedRuntimeConfig {
        return {
          providerId: (value as ScriptedRuntimeConfig).providerId
        }
      },
      async inspect() {
        return { capabilities: DEFAULT_AGENT_RUNTIME_CAPABILITIES }
      },
      run(request) {
        requests.push(structuredClone(request))
        runCalls += 1
        if (runCalls > 1) {
          return (async function* () {
            for (const event of successfulRuntimeEvents(request)) {
              yield event
            }
          })()
        }
        let step = 0
        const iterator: AsyncIterator<AgentRuntimeEvent> = {
          next: () => {
            step += 1
            if (step === 1) {
              return Promise.resolve({
                done: false,
                value: {
                  type: 'runtime.started',
                  sessionId: request.resume?.sessionId
                }
              })
            }
            if (step === 2) {
              return Promise.resolve({
                done: false,
                value: {
                  type: 'assistant.delta',
                  delta: 'Block after this delta.'
                }
              })
            }
            return new Promise<IteratorResult<AgentRuntimeEvent>>(
              () => undefined
            )
          },
          return: async () => {
            returnCalls += 1
            return { done: true, value: undefined }
          }
        }
        return {
          [Symbol.asyncIterator]: () => iterator
        }
      }
    }
    let stopScheduled = false
    const run = await runFixture({
      factory: runtimeFactory(adapter, 'blocked-session-v1'),
      savedSession: {
        adapterId: adapter.id,
        sessionCompatibilityId: 'blocked-session-v1'
      },
      onEvent: (event, manager) => {
        if (event.type !== 'text-delta' || stopScheduled) return
        stopScheduled = true
        setTimeout(() => {
          void manager.stop(event.runId)
        }, 0)
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-stopped' })
    expect(requests[0]?.resume).toEqual({
      sessionId: 'runtime-session-previous'
    })
    expect(run.task.runtimeSessions).toBeUndefined()
    expect(returnCalls).toBe(1)

    await expect(run.runAgain()).resolves.toMatchObject({
      type: 'run-completed'
    })
    expect(requests[1]?.resume).toBeUndefined()
  })

  it.each([
    {
      label: 'adapter identity',
      savedAdapterId: 'community.other-runtime',
      savedCompatibilityId: 'scripted-session-v1'
    },
    {
      label: 'session compatibility identity',
      savedAdapterId: 'community.resume-runtime',
      savedCompatibilityId: 'scripted-session-v0'
    }
  ])(
    'does not resume when the saved $label differs',
    async ({ savedAdapterId, savedCompatibilityId }) => {
      const requests: AgentRunRequest[] = []
      const adapter = scriptedRuntime({
        id: 'community.resume-runtime',
        events: successfulRuntimeEvents,
        onRequest: (request) => requests.push(request)
      })
      const run = await runFixture({
        factory: runtimeFactory(adapter, 'scripted-session-v1'),
        savedSession: {
          adapterId: savedAdapterId,
          sessionCompatibilityId: savedCompatibilityId
        }
      })

      expect(run.terminal).toMatchObject({ type: 'run-completed' })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.resume).toBeUndefined()
      expect(run.task.runtimeSessions?.[PROVIDER_ID]).toMatchObject({
        adapterId: adapter.id,
        sessionCompatibilityId: 'scripted-session-v1',
        sessionId: 'runtime-session-next'
      })
    }
  )

  it('does not resume a stored session beyond the canonical identifier limit', async () => {
    const requests: AgentRunRequest[] = []
    const adapter = scriptedRuntime({
      id: 'community.bounded-session-runtime',
      events: successfulRuntimeEvents,
      onRequest: (request) => requests.push(request)
    })
    const run = await runFixture({
      factory: runtimeFactory(adapter, 'bounded-session-v1'),
      savedSession: {
        adapterId: adapter.id,
        sessionCompatibilityId: 'bounded-session-v1',
        sessionId: 's'.repeat(201)
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    expect(requests[0]?.resume).toBeUndefined()
    expect(run.task.runtimeSessions?.[PROVIDER_ID]?.sessionId).toBe(
      'runtime-session-next'
    )
  })

  it('never persists a native session without a compatibility identity', async () => {
    const requests: AgentRunRequest[] = []
    const adapter = scriptedRuntime({
      id: 'community.stateless-runtime',
      events: successfulRuntimeEvents,
      onRequest: (request) => requests.push(request)
    })
    const run = await runFixture({
      factory: runtimeFactory(adapter),
      savedSession: {
        adapterId: 'community.previous-runtime',
        sessionCompatibilityId: 'previous-session-v1'
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.resume).toBeUndefined()
    expect(run.task.runtimeSessions).toBeUndefined()
  })

  it('clears an incompatible session so switching back cannot resume stale native context', async () => {
    const oldRuntimeRequests: AgentRunRequest[] = []
    const stateless = scriptedRuntime({
      id: 'community.stateless-switch-runtime',
      events: successfulRuntimeEvents
    })
    const oldRuntime = scriptedRuntime({
      id: 'community.old-switch-runtime',
      events: successfulRuntimeEvents,
      onRequest: (request) => oldRuntimeRequests.push(request)
    })
    const statelessFactory = runtimeFactory(stateless)
    const oldRuntimeFactory = runtimeFactory(oldRuntime, 'old-session-v1')
    let factoryCalls = 0
    const switchingFactory: AgentRuntimeFactory = (provider) => {
      factoryCalls += 1
      return factoryCalls === 1
        ? statelessFactory(provider)
        : oldRuntimeFactory(provider)
    }
    const run = await runFixture({
      factory: switchingFactory,
      savedSession: {
        adapterId: oldRuntime.id,
        sessionCompatibilityId: 'old-session-v1'
      }
    })

    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    expect(run.task.runtimeSessions).toBeUndefined()

    await expect(run.runAgain()).resolves.toMatchObject({
      type: 'run-completed'
    })
    expect(oldRuntimeRequests).toHaveLength(1)
    expect(oldRuntimeRequests[0]?.resume).toBeUndefined()
    expect(run.getTask().runtimeSessions?.[PROVIDER_ID]).toMatchObject({
      adapterId: oldRuntime.id,
      sessionCompatibilityId: 'old-session-v1',
      sessionId: 'runtime-session-next'
    })
  })
})
