import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { RunEvent } from '../shared/types'
import { isPackagedSmokeToken } from '../shared/packaged-smoke'
import type { ProviderService } from './provider-service'
import type { RunManager } from './run-manager'
import { StateStore } from './store'
import type { WorkspaceGrantRegistry } from './trust-boundary'

const MALFORMED_FIXTURE_MODEL = 'ground-packaged-malformed'
const MAX_REQUEST_BYTES = 1_000_000
const STOP_TIMEOUT_MS = 5_000
const CREDENTIAL_HEADER_NAMES = [
  'api-key',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key'
] as const

export const PACKAGED_PROVIDER_FAILURE_SMOKE_PROVES = [
  'The packaged main process classifies a closed literal-loopback compatible endpoint as connection-refused, persists failed connection readiness, and blocks task dispatch through that provider.',
  'The packaged main process rejects deterministic malformed OpenAI-compatible readiness responses, persists failed connection readiness, and does not misclassify them as a refused connection.'
] as const

export const PACKAGED_PROVIDER_FAILURE_SMOKE_DOES_NOT_PROVE = [
  'DNS, TLS, authentication, rate-limit, timeout, renderer presentation of corrective guidance, or exclusive ownership of the released closed-port number between allocation and probe.',
  'Every malformed response shape, hostile arbitrary servers, external vendor behavior, credential handling, CLI execution, tool execution, or protocols other than OpenAI-compatible.'
] as const

export interface PackagedProviderFailureSmokeEvidence {
  version: 1
  fixture: {
    protocol: 'openai-compatible'
    binding: 'token-bound-literal-loopback'
    externalCredentialsUsed: false
    malformedModelDiscoveryRequests: 1
    malformedGenerationRequests: 1
  }
  unavailableLoopback: {
    expectedFailureObserved: true
    failureKind: 'connection-refused'
    failedConnectionReadinessPersisted: true
    correctiveGuidanceObserved: true
    genericFetchFailureHidden: true
    runBlockedBeforeDispatch: true
  }
  malformedResponse: {
    expectedFailureObserved: true
    phase: 'readiness'
    failedConnectionReadinessPersisted: true
    invalidAssistantShapeObserved: true
    notMisclassifiedAsConnectionRefused: true
    runBlockedBeforeDispatch: true
  }
  claims: {
    proves: string[]
    doesNotProve: string[]
  }
}

export interface PackagedProviderFailureSmokeInput {
  token: string
  directory: string
  userDataPath: string
  store: StateStore
  providers: ProviderService
  runs: RunManager
  workspaceGrants: WorkspaceGrantRegistry
  runEvents: () => readonly RunEvent[]
}

interface MalformedFixtureState {
  modelDiscoveryRequests: number
  generationRequests: number
  generationRequestValidated: boolean
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

function sameResolvedParent(
  candidate: string,
  expectedParent: string
): boolean {
  const left = path.resolve(path.dirname(candidate))
  const right = path.resolve(expectedParent)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function requireSmokeBoundary(input: PackagedProviderFailureSmokeInput): void {
  requireCondition(
    isPackagedSmokeToken(input.token),
    'Packaged provider failure smoke requires a valid token'
  )
  requireCondition(
    path.basename(path.resolve(input.directory)) ===
      `ground-packaged-smoke-${input.token}` &&
      sameResolvedParent(input.userDataPath, input.directory) &&
      path.basename(input.userDataPath) === 'user-data',
    'Packaged provider failure smoke requires token-bound user data'
  )
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
      throw new Error(
        'Packaged malformed-provider fixture request exceeded 1 MB'
      )
    }
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  requireCondition(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'Packaged malformed-provider fixture expected a JSON object'
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

function requireNoCredentialHeaders(request: IncomingMessage): void {
  requireCondition(
    CREDENTIAL_HEADER_NAMES.every(
      (header) => request.headers[header] === undefined
    ),
    'Packaged malformed-provider fixture rejected an unexpected credential header'
  )
}

function malformedFixtureHandler(input: {
  token: string
  state: MalformedFixtureState
}): (request: IncomingMessage, response: ServerResponse) => void {
  const modelPath = `/${input.token}/malformed/v1/models`
  const generationPath = `/${input.token}/malformed/v1/chat/completions`
  return (request, response) => {
    void (async () => {
      requireCondition(
        request.socket.remoteAddress === '127.0.0.1',
        'Packaged malformed-provider fixture rejected a non-loopback peer'
      )
      requireNoCredentialHeaders(request)

      if (request.url === modelPath) {
        requireCondition(
          request.method === 'GET',
          'Packaged malformed-provider fixture expected model discovery'
        )
        input.state.modelDiscoveryRequests += 1
        writeJson(response, 200, { models: [] })
        return
      }

      if (request.url === generationPath) {
        requireCondition(
          request.method === 'POST',
          'Packaged malformed-provider fixture expected a generation probe'
        )
        requireCondition(
          typeof request.headers['content-type'] === 'string' &&
            request.headers['content-type'].startsWith('application/json'),
          'Packaged malformed-provider fixture expected JSON content'
        )
        const body = await readJsonBody(request)
        requireCondition(
          body.model === MALFORMED_FIXTURE_MODEL,
          'Packaged malformed-provider fixture received the wrong model'
        )
        requireCondition(
          body.stream === false && body.max_tokens === 4,
          'Packaged malformed-provider fixture received an unsafe generation probe'
        )
        requireCondition(
          JSON.stringify(body.messages) ===
            JSON.stringify([{ role: 'user', content: 'Reply with OK.' }]),
          'Packaged malformed-provider fixture received the wrong probe prompt'
        )
        requireCondition(
          !Object.hasOwn(body, 'tools') && !Object.hasOwn(body, 'tool_choice'),
          'Packaged malformed-provider fixture received unexpected tools'
        )
        input.state.generationRequests += 1
        input.state.generationRequestValidated = true
        writeJson(response, 200, { choices: [{}] })
        return
      }

      throw new Error(
        'Packaged malformed-provider fixture received an unexpected request'
      )
    })().catch((error: unknown) => {
      input.state.failure ??= boundedFixtureFailure(error)
      if (!response.headersSent) {
        writeJson(response, 400, {
          error: 'packaged malformed-provider fixture rejected request'
        })
      } else {
        response.destroy()
      }
    })
  }
}

async function listenOnLoopback(server: Server): Promise<AddressInfo> {
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
    'Packaged provider failure fixture did not bind a TCP port'
  )
  return address as AddressInfo
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

async function closedLoopbackEndpoint(token: string): Promise<string> {
  const server = createServer()
  server.maxConnections = 1
  server.headersTimeout = 5_000
  server.requestTimeout = 5_000
  const address = await listenOnLoopback(server)
  await closeServer(server)
  return `http://127.0.0.1:${address.port}/${token}/unavailable/v1`
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
                `Packaged provider failure task cancellation timed out after ${STOP_TIMEOUT_MS}ms`
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

async function requirePersistedFailedReadiness(
  input: PackagedProviderFailureSmokeInput,
  providerId: string
): Promise<void> {
  const reloaded = new StateStore(
    path.join(input.userDataPath, 'ground-state.json')
  )
  await reloaded.load()
  const provider = reloaded.getProvider(providerId)
  requireCondition(
    provider.verification?.status === 'failed' &&
      provider.verification.scope === 'connection',
    'Packaged provider failure smoke did not retain failed connection readiness'
  )
}

async function requireRunBlockedBeforeDispatch(
  input: PackagedProviderFailureSmokeInput,
  providerId: string,
  providerName: string,
  workspacePath: string
): Promise<void> {
  const created = await input.store.createTask(workspacePath)
  await input.store.mutateTask(created.id, (task) => {
    task.providerId = providerId
    task.mode = 'agent'
  })
  const before = input.store.getTask(created.id)
  const eventOffset = input.runEvents().length
  let startError: unknown
  let unexpectedlyStarted = false
  try {
    await input.runs.start(
      created.id,
      'This packaged failure-smoke prompt must not be dispatched.'
    )
    unexpectedlyStarted = true
  } catch (error) {
    startError = error
  }

  if (input.runs.isTaskActive(created.id)) {
    await stopTaskWithinBound(input.runs, created.id)
  }
  requireCondition(
    !unexpectedlyStarted,
    'Packaged provider failure smoke unexpectedly dispatched a run'
  )
  requireCondition(
    startError instanceof Error &&
      startError.message ===
        `Test ${providerName} in Settings before its first run or after changing its configuration.`,
    'Packaged provider failure smoke did not receive the expected pre-dispatch readiness rejection'
  )
  requireCondition(
    !input.runs.isTaskActive(created.id),
    'Packaged provider failure smoke left a task active'
  )
  requireCondition(
    !input
      .runEvents()
      .slice(eventOffset)
      .some((event) => event.taskId === created.id),
    'Packaged provider failure smoke emitted a run event before dispatch'
  )

  const after = input.store.getTask(created.id)
  requireCondition(
    JSON.stringify(after) === JSON.stringify(before),
    'Packaged provider failure smoke mutated the blocked task'
  )
  const reloaded = new StateStore(
    path.join(input.userDataPath, 'ground-state.json')
  )
  await reloaded.load()
  requireCondition(
    JSON.stringify(reloaded.getTask(created.id)) === JSON.stringify(before),
    'Packaged provider failure smoke did not durably preserve the blocked task'
  )
}

async function smokeUnavailableLoopback(
  input: PackagedProviderFailureSmokeInput,
  workspacePath: string
): Promise<void> {
  const providerName = 'Packaged unavailable loopback'
  let providerId: string | undefined
  let observed:
    | {
        baseUrl: string
        providerId: string
        tested: Awaited<ReturnType<ProviderService['test']>>
      }
    | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const baseUrl = await closedLoopbackEndpoint(input.token)
    const draft = {
      ...(providerId ? { id: providerId } : {}),
      name: providerName,
      kind: 'openai-compatible' as const,
      model: 'ground-packaged-unavailable',
      baseUrl,
      supportsTools: false
    }
    const saved = await input.providers.save(draft)
    providerId = saved.id
    const tested = await input.providers.test({
      ...draft,
      id: saved.id
    })
    if (
      tested.ok === false &&
      tested.persisted === true &&
      tested.title === 'Could not connect' &&
      tested.failureKind === 'connection-refused'
    ) {
      observed = {
        baseUrl,
        providerId: saved.id,
        tested
      }
      break
    }
  }
  requireCondition(
    observed !== undefined,
    'Packaged unavailable-loopback smoke did not observe the expected persisted failure'
  )
  const { baseUrl, tested } = observed
  requireCondition(
    tested.detail.includes(`No service is listening at ${baseUrl}`) &&
      /ECONNREFUSED/iu.test(tested.detail) &&
      /Start Ollama or LM Studio/iu.test(tested.detail) &&
      /correct the Base URL/iu.test(tested.detail),
    'Packaged unavailable-loopback smoke did not observe corrective guidance'
  )
  requireCondition(
    !/fetch failed/iu.test(tested.detail),
    'Packaged unavailable-loopback smoke exposed a generic fetch failure'
  )
  await requirePersistedFailedReadiness(input, observed.providerId)
  await requireRunBlockedBeforeDispatch(
    input,
    observed.providerId,
    providerName,
    workspacePath
  )
}

async function smokeMalformedResponse(
  input: PackagedProviderFailureSmokeInput,
  workspacePath: string
): Promise<void> {
  const providerName = 'Packaged malformed compatible'
  const state: MalformedFixtureState = {
    modelDiscoveryRequests: 0,
    generationRequests: 0,
    generationRequestValidated: false
  }
  const server = createServer(
    malformedFixtureHandler({
      token: input.token,
      state
    })
  )
  server.maxConnections = 4
  server.headersTimeout = 5_000
  server.requestTimeout = 10_000
  server.keepAliveTimeout = 1_000
  try {
    const address = await listenOnLoopback(server)
    const baseUrl =
      `http://127.0.0.1:${address.port}` + `/${input.token}/malformed/v1`
    const draft = {
      name: providerName,
      kind: 'openai-compatible' as const,
      model: MALFORMED_FIXTURE_MODEL,
      baseUrl,
      supportsTools: false
    }
    const saved = await input.providers.save(draft)
    const tested = await input.providers.test({
      ...draft,
      id: saved.id
    })
    requireCondition(
      tested.ok === false &&
        tested.persisted === true &&
        tested.title === 'Could not connect',
      'Packaged malformed-provider smoke did not observe the expected persisted failure'
    )
    requireCondition(
      tested.failureKind === undefined,
      'Packaged malformed-provider smoke was misclassified as a refused connection'
    )
    requireCondition(
      /Model listing failed:/iu.test(tested.detail) &&
        /OpenAI-compatible data array/iu.test(tested.detail) &&
        /Generation probe failed:/iu.test(tested.detail) &&
        /invalid assistant message/iu.test(tested.detail),
      'Packaged malformed-provider smoke did not observe both protocol-shape failures'
    )
    requireCondition(
      !/fetch failed/iu.test(tested.detail),
      'Packaged malformed-provider smoke exposed a generic fetch failure'
    )
    await requirePersistedFailedReadiness(input, saved.id)
    await requireRunBlockedBeforeDispatch(
      input,
      saved.id,
      providerName,
      workspacePath
    )
    requireCondition(
      state.failure === undefined &&
        state.modelDiscoveryRequests === 1 &&
        state.generationRequests === 1 &&
        state.generationRequestValidated,
      `Packaged malformed-provider fixture contract failed${
        state.failure ? `: ${state.failure}` : ''
      }`
    )
  } finally {
    await closeServer(server)
  }
}

export async function runPackagedProviderFailureSmoke(
  input: PackagedProviderFailureSmokeInput
): Promise<PackagedProviderFailureSmokeEvidence> {
  requireSmokeBoundary(input)

  const workspace = path.join(input.directory, 'provider-failure-workspace')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const grant = await input.workspaceGrants.grant(workspace)
  const canonicalWorkspace = await input.workspaceGrants.require(grant.id)

  await smokeUnavailableLoopback(input, canonicalWorkspace)
  await smokeMalformedResponse(input, canonicalWorkspace)

  return {
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
  }
}
