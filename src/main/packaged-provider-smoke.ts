import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RunEvent } from '../shared/types'
import { isPackagedSmokeToken } from '../shared/packaged-smoke'
import type { ProviderService } from './provider-service'
import type { RunManager } from './run-manager'
import { StateStore } from './store'
import type { WorkspaceGrantRegistry } from './trust-boundary'

const FIXTURE_MODEL = 'ground-packaged-compatible'
const OPENAI_RESPONSES_FIXTURE_MODEL =
  'ground-packaged-openai-responses'
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
const EXPECTED_TOOLLESS_SYSTEM_PROMPT = [
  'You are a concise, practical assistant running inside Ground.',
  'The user selected a local workspace for context. You cannot inspect it unless tools are supplied.',
  'Do not claim to have read or changed local files when you have not.'
].join('\n')

export const PACKAGED_PROVIDER_SMOKE_PROVES = [
  'The packaged main process can save and persistently verify a credential-free OpenAI-compatible provider against a token-bound literal-loopback endpoint.',
  'The packaged production adapter registry and RunManager can stream a first task turn and persist its successful assistant output, provider attribution, continuation state, and idle status.',
  'The packaged main process can save and persistently verify a first-class OpenAI provider with a synthetic versioned credential, then reuse that saved credential as exact Bearer authorization for readiness and runtime without exposing it in persisted state or evidence.',
  'The packaged production registry routes the first-class provider through openai.responses, sends a store-disabled Responses API request, parses its streamed Responses events, and durably persists the successful OpenAI-attributed first turn.'
] as const

export const PACKAGED_PROVIDER_SMOKE_DOES_NOT_PROVE = [
  'Live hosted-provider credentials, internet, DNS, or TLS reachability, authentication against OpenAI, rate-limit behavior, or any external vendor service.',
  'CLI-agent execution, tool execution, reasoning, multi-turn continuation, malformed or unavailable-provider handling, or first-class API protocols other than OpenAI Responses.'
] as const

export interface PackagedProviderSmokeEvidence {
  version: 2
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
  openAiResponses: {
    fixture: {
      providerKind: 'openai'
      protocol: 'openai-responses'
      adapterId: 'openai.responses'
      binding: 'token-bound-literal-loopback'
      externalCredentialsUsed: false
      syntheticCredentialAuthorizationValidated: true
      modelDiscoveryRequests: 1
      streamingResponseRequests: 1
      streamedContentChunks: 2
      responsesRequestValidated: true
      storeDisabled: true
    }
    credentials: {
      required: true
      versionedReferencePersisted: true
      reusedForReadiness: true
      reusedForFirstTurn: true
      absentFromPersistedState: true
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
  openAiResponses: {
    modelDiscoveryRequests: number
    streamingResponseRequests: number
    streamedContentChunks: number
    responsesRequestValidated: boolean
    storeDisabled: boolean
    readinessAuthorizationValidated: boolean
    runtimeAuthorizationValidated: boolean
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
}

function rawHeaderValues(
  request: IncomingMessage,
  headerName: string
): string[] {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === headerName) {
      values.push(request.rawHeaders[index + 1] ?? '')
    }
  }
  return values
}

function requireNoCredentialHeaders(request: IncomingMessage): void {
  requireCondition(
    CREDENTIAL_HEADER_NAMES.every(
      (header) => request.headers[header] === undefined
    ),
    'Packaged compatible fixture rejected an unexpected credential header'
  )
}

function requireSyntheticBearerAuthorization(
  request: IncomingMessage,
  syntheticApiKey: string
): void {
  const authorizationValues = rawHeaderValues(request, 'authorization')
  requireCondition(
    authorizationValues.length === 1 &&
      authorizationValues[0] === `Bearer ${syntheticApiKey}`,
    'Packaged OpenAI Responses fixture rejected authorization'
  )
  requireCondition(
    CREDENTIAL_HEADER_NAMES.filter(
      (header) => header !== 'authorization'
    ).every((header) => request.headers[header] === undefined),
    'Packaged OpenAI Responses fixture rejected an unexpected credential header'
  )
}

function writeServerSentEvent(
  response: ServerResponse,
  value: unknown
): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function fixtureHandler(input: {
  token: string
  marker: string
  prompt: string
  openAiMarker: string
  openAiPrompt: string
  syntheticApiKey: string
  state: FixtureState
}): (request: IncomingMessage, response: ServerResponse) => void {
  const modelPath = `/${input.token}/v1/models`
  const completionPath = `/${input.token}/v1/chat/completions`
  const openAiModelPath = `/${input.token}/openai/v1/models`
  const openAiResponsesPath = `/${input.token}/openai/v1/responses`
  return (request, response) => {
    void (async () => {
      requireCondition(
        request.socket.remoteAddress === '127.0.0.1',
        'Packaged provider fixture rejected a non-loopback peer'
      )
      if (request.url === modelPath) {
        requireNoCredentialHeaders(request)
        requireCondition(
          request.method === 'GET',
          'Packaged compatible fixture expected model discovery'
        )
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
      if (request.url === completionPath) {
        requireNoCredentialHeaders(request)
        requireCondition(
          request.method === 'POST',
          'Packaged compatible fixture expected a completion request'
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
          writeServerSentEvent(response, {
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
          })
          input.state.streamedContentChunks += 1
        }
        writeServerSentEvent(response, {
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
        })
        response.end('data: [DONE]\n\n')
        return
      }

      if (request.url === openAiModelPath) {
        requireSyntheticBearerAuthorization(
          request,
          input.syntheticApiKey
        )
        requireCondition(
          request.method === 'GET',
          'Packaged OpenAI Responses fixture expected model discovery'
        )
        requireCondition(
          request.headers.accept === 'application/json',
          'Packaged OpenAI Responses discovery did not request JSON'
        )
        input.state.openAiResponses.modelDiscoveryRequests += 1
        input.state.openAiResponses.readinessAuthorizationValidated = true
        writeJson(response, 200, {
          object: 'list',
          data: [
            {
              id: OPENAI_RESPONSES_FIXTURE_MODEL,
              object: 'model',
              created: 1_785_283_200,
              owned_by: 'ground-packaged-smoke'
            }
          ]
        })
        return
      }

      if (request.url === openAiResponsesPath) {
        requireSyntheticBearerAuthorization(
          request,
          input.syntheticApiKey
        )
        requireCondition(
          request.method === 'POST',
          'Packaged OpenAI Responses fixture expected a Responses request'
        )
        requireCondition(
          typeof request.headers['content-type'] === 'string' &&
            request.headers['content-type'].startsWith('application/json'),
          'Packaged OpenAI Responses fixture expected JSON content'
        )
        const body = await readJsonBody(request)
        requireCondition(
          !request.url.includes(input.syntheticApiKey) &&
            !JSON.stringify(body).includes(input.syntheticApiKey),
          'Packaged OpenAI Responses request exposed its credential outside authorization'
        )
        requireCondition(
          body.model === OPENAI_RESPONSES_FIXTURE_MODEL,
          'Packaged OpenAI Responses fixture received the wrong model'
        )
        requireCondition(
          body.stream === true,
          'Packaged OpenAI Responses fixture requires streaming'
        )
        requireCondition(
          body.parallel_tool_calls === false,
          'Packaged OpenAI Responses fixture requires serial tool-call policy'
        )
        requireCondition(
          body.store === false,
          'Packaged OpenAI Responses fixture requires store=false'
        )
        requireCondition(
          !Object.hasOwn(body, 'tools') &&
            !Object.hasOwn(body, 'tool_choice'),
          'Packaged OpenAI Responses fixture received unexpected tools'
        )
        requireCondition(
          Array.isArray(body.input) && body.input.length === 2,
          'Packaged OpenAI Responses fixture received invalid input'
        )
        const systemInput = body.input[0]
        const userInput = body.input[1]
        requireCondition(
          isRecord(systemInput) &&
            systemInput.role === 'system' &&
            systemInput.content === EXPECTED_TOOLLESS_SYSTEM_PROMPT,
          'Packaged OpenAI Responses fixture received unexpected system input'
        )
        requireCondition(
          isRecord(userInput) &&
            userInput.role === 'user' &&
            Array.isArray(userInput.content) &&
            userInput.content.length === 1,
          'Packaged OpenAI Responses fixture received invalid user input'
        )
        const userText = userInput.content[0]
        requireCondition(
          isRecord(userText) &&
            userText.type === 'input_text' &&
            userText.text === input.openAiPrompt,
          'Packaged OpenAI Responses fixture did not receive the expected task prompt'
        )

        input.state.openAiResponses.streamingResponseRequests += 1
        input.state.openAiResponses.responsesRequestValidated = true
        input.state.openAiResponses.storeDisabled = true
        input.state.openAiResponses.runtimeAuthorizationValidated = true
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'close'
        })
        const messageId = 'msg_ground_packaged_openai'
        writeServerSentEvent(response, {
          type: 'response.created',
          sequence_number: 0,
          response: {
            id: 'resp_ground_packaged_openai',
            created_at: 1_785_283_200,
            model: OPENAI_RESPONSES_FIXTURE_MODEL
          }
        })
        writeServerSentEvent(response, {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: {
            type: 'message',
            id: messageId
          }
        })
        const split = Math.ceil(input.openAiMarker.length / 2)
        for (const [index, delta] of [
          input.openAiMarker.slice(0, split),
          input.openAiMarker.slice(split)
        ].entries()) {
          writeServerSentEvent(response, {
            type: 'response.output_text.delta',
            sequence_number: index + 2,
            output_index: 0,
            content_index: 0,
            item_id: messageId,
            delta
          })
          input.state.openAiResponses.streamedContentChunks += 1
        }
        writeServerSentEvent(response, {
          type: 'response.output_item.done',
          sequence_number: 4,
          output_index: 0,
          item: {
            type: 'message',
            id: messageId
          }
        })
        writeServerSentEvent(response, {
          type: 'response.completed',
          sequence_number: 5,
          response: {
            incomplete_details: null,
            usage: {
              input_tokens: 4,
              input_tokens_details: {
                cached_tokens: 0
              },
              output_tokens: 5,
              output_tokens_details: {
                reasoning_tokens: 0
              }
            }
          }
        })
        response.end('data: [DONE]\n\n')
        return
      }

      throw new Error(
        'Packaged provider fixture received an unexpected request'
      )
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
  const openAiMarker =
    `ground-packaged-openai-responses-ok-${input.token}`
  const openAiPrompt = `Reply with exactly ${openAiMarker}.`
  const syntheticApiKey =
    `ground-packaged-fixture-${randomBytes(24).toString('base64url')}`
  const state: FixtureState = {
    modelDiscoveryRequests: 0,
    streamingCompletionRequests: 0,
    streamedContentChunks: 0,
    streamingRequestValidated: false,
    openAiResponses: {
      modelDiscoveryRequests: 0,
      streamingResponseRequests: 0,
      streamedContentChunks: 0,
      responsesRequestValidated: false,
      storeDisabled: false,
      readinessAuthorizationValidated: false,
      runtimeAuthorizationValidated: false
    }
  }
  const server = createServer(
    fixtureHandler({
      token: input.token,
      marker,
      prompt,
      openAiMarker,
      openAiPrompt,
      syntheticApiKey,
      state
    })
  )
  server.maxConnections = 8
  server.headersTimeout = 5_000
  server.requestTimeout = 10_000
  const taskIds: string[] = []
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
    taskIds.push(created.id)
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

    const openAiBaseUrl =
      `http://127.0.0.1:${(address as AddressInfo).port}` +
      `/${input.token}/openai/v1`
    const openAiDraft = {
      name: 'Packaged OpenAI Responses smoke',
      kind: 'openai' as const,
      model: OPENAI_RESPONSES_FIXTURE_MODEL,
      baseUrl: openAiBaseUrl,
      supportsTools: false
    }
    const openAiSaved = await input.providers.save({
      ...openAiDraft,
      apiKey: syntheticApiKey
    })
    requireCondition(
      openAiSaved.kind === 'openai' &&
        openAiSaved.hasApiKey &&
        typeof openAiSaved.credentialRevision === 'string' &&
        openAiSaved.credentialRevision.length > 0,
      'Packaged OpenAI Responses provider did not persist a versioned credential reference'
    )
    // Deliberately omit apiKey so readiness can persist only after the saved,
    // boundary-scoped credential is resolved from the main-owned vault.
    const openAiTested = await input.providers.test({
      ...openAiDraft,
      id: openAiSaved.id
    })
    requireCondition(
      openAiTested.ok,
      `Packaged OpenAI Responses readiness failed: ${openAiTested.title} — ${openAiTested.detail}`
    )
    requireCondition(
      openAiTested.persisted === true,
      'Packaged OpenAI Responses readiness was not persisted'
    )
    requireCondition(
      openAiTested.models?.includes(
        OPENAI_RESPONSES_FIXTURE_MODEL
      ),
      'Packaged OpenAI Responses readiness did not discover the fixture model'
    )
    const openAiVerified = input.store.getProvider(openAiSaved.id)
    requireCondition(
      openAiVerified.kind === 'openai' &&
        openAiVerified.hasApiKey &&
        openAiVerified.credentialRevision ===
          openAiSaved.credentialRevision &&
        openAiVerified.verification?.status === 'passed' &&
        openAiVerified.verification.scope === 'connection',
      'Packaged OpenAI Responses provider did not retain passed connection readiness'
    )

    const openAiCreated = await input.store.createTask(
      canonicalWorkspace
    )
    taskIds.push(openAiCreated.id)
    await input.store.mutateTask(openAiCreated.id, (task) => {
      task.providerId = openAiSaved.id
      task.mode = 'agent'
    })

    const openAiEventOffset = input.runEvents().length
    const openAiRunId = await input.runs.start(
      openAiCreated.id,
      openAiPrompt
    )
    const openAiTerminal = await waitForValue(
      'Packaged OpenAI Responses first turn',
      () =>
        input
          .runEvents()
          .slice(openAiEventOffset)
          .find(
            (event) =>
              event.runId === openAiRunId &&
              (event.type === 'run-completed' ||
                event.type === 'run-stopped' ||
                event.type === 'run-error')
          )
    )
    requireCondition(
      openAiTerminal.type === 'run-completed',
      `Packaged OpenAI Responses first turn ended with ${openAiTerminal.type}`
    )
    await waitForValue(
      'Packaged OpenAI Responses run cleanup',
      () =>
        input.runs.isTaskActive(openAiCreated.id)
          ? undefined
          : true
    )

    const openAiReloaded = new StateStore(
      path.join(input.userDataPath, 'ground-state.json')
    )
    await openAiReloaded.load()
    const openAiPersistedTask = openAiReloaded.getTask(
      openAiCreated.id
    )
    requireCondition(
      openAiPersistedTask.runStatus === 'idle',
      'Packaged OpenAI Responses task was not durably idle'
    )
    const openAiAssistant = openAiPersistedTask.items.find(
      (item) =>
        item.kind === 'message' &&
        item.role === 'assistant' &&
        item.runId === openAiRunId
    )
    requireCondition(
      openAiAssistant?.kind === 'message' &&
        openAiAssistant.role === 'assistant' &&
        openAiAssistant.content === openAiMarker,
      'Packaged OpenAI Responses assistant marker was not persisted'
    )
    requireCondition(
      openAiAssistant.provider?.id === openAiSaved.id &&
        openAiAssistant.provider.kind === 'openai' &&
        openAiAssistant.provider.model ===
          OPENAI_RESPONSES_FIXTURE_MODEL,
      'Packaged OpenAI Responses provider attribution was not persisted'
    )
    const openAiSession =
      openAiPersistedTask.modelSessions?.[openAiSaved.id]
    requireCondition(
      openAiSession?.adapterId === 'openai.responses' &&
        openAiSession.origin === 'ground' &&
        openAiSession.providerRevision === openAiVerified.updatedAt &&
        openAiSession.workspacePath === canonicalWorkspace &&
        openAiSession.model === OPENAI_RESPONSES_FIXTURE_MODEL,
      'Packaged OpenAI Responses continuation state was not persisted'
    )
    requireCondition(
      !openAiPersistedTask.items.some(
        (item) =>
          item.kind === 'activity' &&
          item.runId === openAiRunId &&
          (item.activityType === 'error' || item.status === 'error')
      ),
      'Packaged OpenAI Responses first turn persisted a failure'
    )
    requireCondition(
      !input
        .runEvents()
        .slice(openAiEventOffset)
        .some(
          (event) =>
            event.runId === openAiRunId &&
            event.type === 'run-error'
        ),
      'Packaged OpenAI Responses first turn emitted a failure'
    )
    requireCondition(
      state.failure === undefined &&
        state.openAiResponses.modelDiscoveryRequests === 1 &&
        state.openAiResponses.streamingResponseRequests === 1 &&
        state.openAiResponses.streamedContentChunks === 2 &&
        state.openAiResponses.responsesRequestValidated &&
        state.openAiResponses.storeDisabled &&
        state.openAiResponses.readinessAuthorizationValidated &&
        state.openAiResponses.runtimeAuthorizationValidated,
      `Packaged OpenAI Responses fixture contract failed${
        state.failure ? `: ${state.failure}` : ''
      }`
    )
    const persistedState = await readFile(
      path.join(input.userDataPath, 'ground-state.json'),
      'utf8'
    )
    requireCondition(
      !persistedState.includes(syntheticApiKey),
      'Packaged OpenAI Responses credential appeared in persisted state'
    )

    const evidence: PackagedProviderSmokeEvidence = {
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
    }
    requireCondition(
      !JSON.stringify(evidence).includes(syntheticApiKey),
      'Packaged OpenAI Responses credential appeared in smoke evidence'
    )
    return evidence
  } finally {
    try {
      await Promise.all(
        taskIds
          .filter((taskId) => input.runs.isTaskActive(taskId))
          .map((taskId) => stopTaskWithinBound(input.runs, taskId))
      )
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
