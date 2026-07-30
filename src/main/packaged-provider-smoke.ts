import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { RunEvent } from '../shared/types'
import { isPackagedSmokeToken } from '../shared/packaged-smoke'
import type { ProviderService } from './provider-service'
import type { RunManager } from './run-manager'
import { StateStore } from './store'
import type { WorkspaceGrantRegistry } from './trust-boundary'

const FIXTURE_MODEL = 'ground-packaged-compatible'
const MAX_REQUEST_BYTES = 1_000_000
const RUN_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 25
const CREDENTIAL_HEADER_NAMES = [
  'api-key',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key'
] as const

export const PACKAGED_PROVIDER_SMOKE_PROVES = [
  'The packaged main process can save and persistently verify a credential-free OpenAI-compatible provider against a token-bound literal-loopback endpoint.',
  'The packaged production adapter registry and RunManager can stream a first task turn and persist its successful assistant output, provider attribution, continuation state, and idle status.'
] as const

export const PACKAGED_PROVIDER_SMOKE_DOES_NOT_PROVE = [
  'Live hosted-provider credentials, internet reachability, or behavior of an external vendor service.',
  'CLI-agent execution, tool execution, or provider protocols other than OpenAI-compatible.'
] as const

export interface PackagedProviderSmokeEvidence {
  version: 1
  fixture: {
    protocol: 'openai-compatible'
    binding: 'token-bound-literal-loopback'
    externalCredentialsUsed: false
    modelDiscoveryRequests: 1
    streamingCompletionRequests: 1
    streamedContentChunks: 2
  }
  readiness: {
    passed: true
    persisted: true
    scope: 'connection'
  }
  firstTurn: {
    runCompletedEventObserved: true
    taskIdleAfterStateReload: true
    assistantMarkerPersisted: true
    providerAttributionPersisted: true
    modelSessionPersisted: true
    noFailurePersisted: true
  }
  claims: {
    proves: string[]
    doesNotProve: string[]
  }
}

interface PackagedProviderSmokeInput {
  token: string
  directory: string
  userDataPath: string
  store: StateStore
  providers: ProviderService
  runs: RunManager
  workspaceGrants: WorkspaceGrantRegistry
  runEvents: () => readonly RunEvent[]
}

interface FixtureState {
  modelDiscoveryRequests: number
  streamingCompletionRequests: number
  streamedContentChunks: number
  streamingRequestValidated: boolean
  failure?: string
}

function requireCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message)
}

function boundedFixtureFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/gu, ' ').trim().slice(0, 500)
}

async function readJsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let receivedBytes = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    receivedBytes += chunk.byteLength
    if (receivedBytes > MAX_REQUEST_BYTES) {
      throw new Error('Packaged provider fixture request exceeded 1 MB')
    }
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  requireCondition(
    parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed),
    'Packaged provider fixture expected a JSON object'
  )
  return parsed as Record<string, unknown>
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  const payload = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    connection: 'close'
  })
  response.end(payload)
}

function fixtureHandler(input: {
  token: string
  marker: string
  prompt: string
  state: FixtureState
}): (request: IncomingMessage, response: ServerResponse) => void {
  const modelPath = `/${input.token}/v1/models`
  const completionPath = `/${input.token}/v1/chat/completions`
  return (request, response) => {
    void (async () => {
      requireCondition(
        request.socket.remoteAddress === '127.0.0.1',
        'Packaged provider fixture rejected a non-loopback peer'
      )
      requireCondition(
        CREDENTIAL_HEADER_NAMES.every(
          (header) => request.headers[header] === undefined
        ),
        'Packaged provider fixture rejected an unexpected credential header'
      )
      if (request.method === 'GET' && request.url === modelPath) {
        input.state.modelDiscoveryRequests += 1
        writeJson(response, 200, {
          object: 'list',
          data: [
            {
              id: FIXTURE_MODEL,
              object: 'model',
              created: 1_785_283_200,
              owned_by: 'ground-packaged-smoke'
            }
          ]
        })
        return
      }
      requireCondition(
        request.method === 'POST' && request.url === completionPath,
        'Packaged provider fixture received an unexpected request'
      )
      const body = await readJsonBody(request)
      requireCondition(
        body.model === FIXTURE_MODEL,
        'Packaged provider fixture received the wrong model'
      )
      requireCondition(
        body.stream === true,
        'Packaged provider fixture requires a streaming request'
      )
      requireCondition(
        JSON.stringify(body.messages).includes(input.prompt),
        'Packaged provider fixture did not receive the expected task prompt'
      )
      input.state.streamingCompletionRequests += 1
      input.state.streamingRequestValidated = true
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'close'
      })
      const split = Math.ceil(input.marker.length / 2)
      for (const content of [
        input.marker.slice(0, split),
        input.marker.slice(split)
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${input.token}`,
            object: 'chat.completion.chunk',
            created: 1_785_283_200,
            model: FIXTURE_MODEL,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        input.state.streamedContentChunks += 1
      }
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${input.token}`,
          object: 'chat.completion.chunk',
          created: 1_785_283_200,
          model: FIXTURE_MODEL,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }
          ]
        })}\n\n`
      )
      response.end('data: [DONE]\n\n')
    })().catch((error: unknown) => {
      input.state.failure ??= boundedFixtureFailure(error)
      if (!response.headersSent) {
        writeJson(response, 400, { error: 'packaged provider fixture rejected request' })
      } else {
        response.destroy()
      }
    })
  }
}

async function waitForValue<T>(
  label: string,
  read: () => T | undefined
): Promise<T> {
  const deadline = Date.now() + RUN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS)
    })
  }
  throw new Error(`${label} timed out after ${RUN_TIMEOUT_MS}ms`)
}

async function stopTaskWithinBound(
  runs: RunManager,
  taskId: string
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      runs.stopTask(taskId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Packaged provider task cancellation timed out after ${STOP_TIMEOUT_MS}ms`
              )
            ),
          STOP_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sameResolvedParent(candidate: string, expectedParent: string): boolean {
  const left = path.resolve(path.dirname(candidate))
  const right = path.resolve(expectedParent)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

export async function runPackagedProviderSmoke(
  input: PackagedProviderSmokeInput
): Promise<PackagedProviderSmokeEvidence> {
  requireCondition(
    isPackagedSmokeToken(input.token),
    'Packaged provider smoke requires a valid token'
  )
  requireCondition(
    path.basename(path.resolve(input.directory)) ===
      `ground-packaged-smoke-${input.token}` &&
      sameResolvedParent(input.userDataPath, input.directory) &&
      path.basename(input.userDataPath) === 'user-data',
    'Packaged provider smoke requires token-bound user data'
  )

  const marker = `ground-packaged-provider-ok-${input.token}`
  const prompt = `Reply with exactly ${marker}.`
  const state: FixtureState = {
    modelDiscoveryRequests: 0,
    streamingCompletionRequests: 0,
    streamedContentChunks: 0,
    streamingRequestValidated: false
  }
  const server = createServer(
    fixtureHandler({
      token: input.token,
      marker,
      prompt,
      state
    })
  )
  server.maxConnections = 8
  server.headersTimeout = 5_000
  server.requestTimeout = 10_000
  let taskId: string | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    requireCondition(
      address !== null && typeof address !== 'string',
      'Packaged provider fixture did not bind a TCP port'
    )
    const baseUrl =
      `http://127.0.0.1:${(address as AddressInfo).port}` +
      `/${input.token}/v1`
    const draft = {
      name: 'Packaged compatible smoke',
      kind: 'openai-compatible' as const,
      model: FIXTURE_MODEL,
      baseUrl,
      supportsTools: false
    }
    const saved = await input.providers.save(draft)
    const tested = await input.providers.test({
      ...draft,
      id: saved.id
    })
    requireCondition(
      tested.ok,
      `Packaged provider readiness failed: ${tested.title} — ${tested.detail}`
    )
    requireCondition(
      tested.persisted === true,
      'Packaged provider readiness was not persisted'
    )
    requireCondition(
      tested.models?.includes(FIXTURE_MODEL),
      'Packaged provider readiness did not discover the fixture model'
    )
    const verified = input.store.getProvider(saved.id)
    requireCondition(
      verified.verification?.status === 'passed' &&
        verified.verification.scope === 'connection',
      'Packaged provider did not retain passed connection readiness'
    )

    const workspace = path.join(input.directory, 'provider-workspace')
    await mkdir(workspace, { mode: 0o700 })
    const grant = await input.workspaceGrants.grant(workspace)
    const canonicalWorkspace = await input.workspaceGrants.require(grant.id)
    const created = await input.store.createTask(canonicalWorkspace)
    taskId = created.id
    await input.store.mutateTask(created.id, (task) => {
      task.providerId = saved.id
      task.mode = 'agent'
    })

    const eventOffset = input.runEvents().length
    const runId = await input.runs.start(created.id, prompt)
    const terminal = await waitForValue('Packaged provider first turn', () =>
      input
        .runEvents()
        .slice(eventOffset)
        .find(
          (event) =>
            event.runId === runId &&
            (event.type === 'run-completed' ||
              event.type === 'run-stopped' ||
              event.type === 'run-error')
        )
    )
    requireCondition(
      terminal.type === 'run-completed',
      `Packaged provider first turn ended with ${terminal.type}`
    )
    await waitForValue('Packaged provider run cleanup', () =>
      input.runs.isTaskActive(created.id) ? undefined : true
    )

    const reloaded = new StateStore(
      path.join(input.userDataPath, 'ground-state.json')
    )
    await reloaded.load()
    const persistedTask = reloaded.getTask(created.id)
    requireCondition(
      persistedTask.runStatus === 'idle',
      'Packaged provider task was not durably idle'
    )
    const assistant = persistedTask.items.find(
      (item) =>
        item.kind === 'message' &&
        item.role === 'assistant' &&
        item.runId === runId
    )
    requireCondition(
      assistant?.kind === 'message' &&
        assistant.role === 'assistant' &&
        assistant.content === marker,
      'Packaged provider assistant marker was not persisted'
    )
    requireCondition(
      assistant.provider?.id === saved.id &&
        assistant.provider.kind === 'openai-compatible' &&
        assistant.provider.model === FIXTURE_MODEL,
      'Packaged provider attribution was not persisted'
    )
    const session = persistedTask.modelSessions?.[saved.id]
    requireCondition(
      session?.adapterId === 'openai.compatible' &&
        session.origin === 'ground' &&
        session.providerRevision === verified.updatedAt &&
        session.workspacePath === canonicalWorkspace &&
        session.model === FIXTURE_MODEL,
      'Packaged provider continuation state was not persisted'
    )
    requireCondition(
      !persistedTask.items.some(
        (item) =>
          item.kind === 'activity' &&
          item.runId === runId &&
          (item.activityType === 'error' || item.status === 'error')
      ),
      'Packaged provider first turn persisted a failure'
    )
    requireCondition(
      !input
        .runEvents()
        .slice(eventOffset)
        .some((event) => event.runId === runId && event.type === 'run-error'),
      'Packaged provider first turn emitted a failure'
    )
    requireCondition(
      state.failure === undefined &&
        state.modelDiscoveryRequests === 1 &&
        state.streamingCompletionRequests === 1 &&
        state.streamingRequestValidated &&
        state.streamedContentChunks === 2,
      `Packaged provider fixture contract failed${
        state.failure ? `: ${state.failure}` : ''
      }`
    )

    return {
      version: 1,
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
    }
  } finally {
    try {
      if (taskId && input.runs.isTaskActive(taskId)) {
        await stopTaskWithinBound(input.runs, taskId)
      }
    } finally {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}
