import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import type { RunEvent } from '../shared/types'
import { isPackagedSmokeToken } from '../shared/packaged-smoke'
import type { ProviderService } from './provider-service'
import { resolveExecutable } from './providers/cli'
import type { RunManager } from './run-manager'
import { StateStore } from './store'
import type {
  CliTrustRequest,
  WorkspaceGrantRegistry
} from './trust-boundary'
import type { PackagedSmokeConfig } from './packaged-smoke'

const FIXTURE_MODEL = 'ground-packaged-codex-cli'
const MAX_CHILD_INPUT_BYTES = 1_000_000
const RUN_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 25
const WARNING =
  'Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter.'
const BLOCKED_CHILD_ENVIRONMENT = [
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
] as const

export const PACKAGED_CLI_SMOKE_PROVES = [
  'The packaged production registry and RunManager can invoke a source-registered Codex-dialect CLI adapter through Ground’s exact executable, configuration, invocation, workspace, argument, and prompt trust boundaries.',
  'A token-bound deterministic CLI child can stream a Codex session, successful command lifecycle, non-fatal warning, assistant response, completion, and usage through the packaged app and durable task state without inheriting external credentials.',
  'A completed Codex error item remains a persisted non-fatal runtime notice while the containing task turn completes successfully.'
] as const

export const PACKAGED_CLI_SMOKE_DOES_NOT_PROVE = [
  'An installed or authenticated Codex CLI, Codex service or network compatibility, vendor tool execution, vendor sandbox behavior, or vendor permission behavior.',
  'Human acceptance of the native CLI configuration or invocation dialogs, passive CLI detection, CLI adapters other than Codex, or race-free binding of interpreter script arguments against concurrent same-user replacement, including for this smoke-owned fixture.',
  'Cleanup of a hung or hostile external CLI after abnormal application exit.'
] as const

export interface PackagedCliSmokeTrustEvidence {
  configurationAuthorizations: 1
  invocationAuthorizations: 1
  exactLaunchEnvelopeValidated: true
  exactConfigurationValidated: true
  exactInvocationValidated: true
  fixtureRevalidatedBeforeEachAuthorization: true
  humanApprovalExercised: false
}

export interface PackagedCliSmokeEvidence {
  version: 1
  fixture: {
    dialect: 'codex'
    adapterId: 'openai.codex-cli'
    binding: 'token-bound-runner-node-child'
    selection: 'source-registered-recognized-adapter'
    passiveDetectionExercised: false
    externalCredentialsUsed: false
    externalVendorCliUsed: false
    runnerNodeSha256: string
    scriptSha256: string
    structuredRecordsEmitted: 7
    stdinPromptTokenObserved: true
  }
  readiness: {
    passed: true
    persisted: true
    scope: 'configuration'
  }
  trust: PackagedCliSmokeTrustEvidence
  firstTurn: {
    runCompletedEventObserved: true
    taskIdleAfterStateReload: true
    assistantMarkerPersisted: true
    providerAttributionPersisted: true
    runtimeSessionPersisted: true
    successfulCommandLifecyclePersisted: true
    usagePersisted: true
    warningNoticeCount: 1
    noFailurePersisted: true
  }
  claims: {
    proves: string[]
    doesNotProve: string[]
  }
}

interface PackagedCliSmokeInput {
  config: PackagedSmokeConfig
  store: StateStore
  providers: ProviderService
  runs: RunManager
  workspaceGrants: WorkspaceGrantRegistry
  trustAuthority: PackagedCliSmokeTrustAuthority
  runEvents: () => readonly RunEvent[]
}

interface ArmedTrustSpec {
  runnerPath: string
  runnerSha256: string
  fixturePath: string
  fixtureSha256: string
  workspacePath: string
  configurationArgs: readonly string[]
  invocationArgs: readonly string[]
}

function requireCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message)
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  return process.platform === 'win32'
    ? path.toNamespacedPath(resolvedLeft).toLowerCase() ===
        path.toNamespacedPath(resolvedRight).toLowerCase()
    : resolvedLeft === resolvedRight
}

function sameStringList(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sameResolvedParent(
  candidate: string,
  expectedParent: string
): boolean {
  try {
    return samePath(
      realpathSync(path.dirname(candidate)),
      realpathSync(expectedParent)
    )
  } catch {
    return false
  }
}

function requireSmokeBoundary(config: PackagedSmokeConfig): void {
  requireCondition(
    config.scope === 'native' && isPackagedSmokeToken(config.token),
    'Packaged CLI smoke requires a valid native token'
  )
  requireCondition(
    path.basename(path.resolve(config.directory)) ===
      `ground-packaged-smoke-${config.token}` &&
      sameResolvedParent(config.userDataPath, config.directory) &&
      path.basename(config.userDataPath) === 'user-data',
    'Packaged CLI smoke requires token-bound user data'
  )
}

async function sha256File(candidate: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(candidate))
    .digest('hex')
}

async function requireExactRegularFile(
  candidate: string,
  expectedPath: string,
  expectedSha256: string
): Promise<void> {
  const details = await lstat(candidate)
  requireCondition(
    details.isFile() && !details.isSymbolicLink(),
    'Packaged CLI smoke launch material must be a regular file'
  )
  const canonical = await realpath(candidate)
  requireCondition(
    samePath(canonical, expectedPath) &&
      (await sha256File(canonical)) === expectedSha256,
    'Packaged CLI smoke launch material changed'
  )
}

function directLaunchMatches(
  request: CliTrustRequest,
  spec: ArmedTrustSpec
): boolean {
  const { launch } = request
  return (
    launch.kind === 'direct' &&
    samePath(launch.entry.path, spec.runnerPath) &&
    samePath(launch.executable.path, spec.runnerPath) &&
    launch.entry.sha256 === spec.runnerSha256 &&
    launch.executable.sha256 === spec.runnerSha256 &&
    launch.entry.size === launch.executable.size &&
    launch.entry.modifiedMs === launch.executable.modifiedMs &&
    launch.entry.changedMs === launch.executable.changedMs &&
    launch.entry.device === launch.executable.device &&
    launch.entry.inode === launch.executable.inode &&
    launch.argumentPrefix.length === 0 &&
    launch.shim === undefined &&
    launch.script === undefined &&
    /^[a-f0-9]{64}$/u.test(launch.fingerprint)
  )
}

export class PackagedCliSmokeTrustAuthority {
  private readonly canonicalDirectory: string
  private spec: ArmedTrustSpec | undefined
  private configurationFingerprint: string | undefined
  private configurationAuthorizations = 0
  private invocationAuthorizations = 0

  constructor(config: PackagedSmokeConfig) {
    requireSmokeBoundary(config)
    this.canonicalDirectory = realpathSync(config.directory)
  }

  arm(spec: ArmedTrustSpec): void {
    requireCondition(
      this.spec === undefined &&
        this.configurationAuthorizations === 0 &&
        this.invocationAuthorizations === 0,
      'Packaged CLI smoke trust authority cannot be rearmed'
    )
    requireCondition(
      sameResolvedParent(
        spec.fixturePath,
        path.join(this.canonicalDirectory, 'recognized-cli')
      ) &&
        sameResolvedParent(spec.workspacePath, this.canonicalDirectory) &&
        /^[a-f0-9]{64}$/u.test(spec.runnerSha256) &&
        /^[a-f0-9]{64}$/u.test(spec.fixtureSha256),
      'Packaged CLI smoke trust authority received an invalid fixture boundary'
    )
    this.spec = {
      ...spec,
      configurationArgs: Object.freeze([...spec.configurationArgs]),
      invocationArgs: Object.freeze([...spec.invocationArgs])
    }
  }

  readonly confirm = async (
    request: CliTrustRequest
  ): Promise<boolean> => {
    const spec = this.spec
    requireCondition(
      spec !== undefined,
      'Packaged CLI smoke trust authority is not armed'
    )
    await Promise.all([
      requireExactRegularFile(
        spec.runnerPath,
        spec.runnerPath,
        spec.runnerSha256
      ),
      requireExactRegularFile(
        spec.fixturePath,
        spec.fixturePath,
        spec.fixtureSha256
      )
    ])
    requireCondition(
      directLaunchMatches(request, spec) &&
        request.runtimeAdapterId === 'openai.codex-cli' &&
        request.cliAdapter === 'codex' &&
        request.promptMode === 'stdin' &&
        request.outputMode === 'ndjson' &&
        request.environmentVariables.length === 0 &&
        request.environmentFingerprint === undefined &&
        /^[a-f0-9]{64}$/u.test(request.fingerprint),
      'Packaged CLI smoke rejected an unexpected launch envelope'
    )

    if (request.phase === 'configuration') {
      requireCondition(
        this.configurationAuthorizations === 0 &&
          this.invocationAuthorizations === 0 &&
          request.cwd === undefined &&
          request.prompt === undefined &&
          sameStringList(request.args, spec.configurationArgs),
        'Packaged CLI smoke rejected an unexpected configuration authorization'
      )
      this.configurationAuthorizations = 1
      this.configurationFingerprint = request.fingerprint
      return true
    }

    requireCondition(
      this.configurationAuthorizations === 1 &&
        this.invocationAuthorizations === 0 &&
        this.configurationFingerprint !== request.fingerprint &&
        request.cwd !== undefined &&
        samePath(request.cwd, spec.workspacePath) &&
        request.prompt?.transport === 'stdin' &&
        sameStringList(request.args, spec.invocationArgs),
      'Packaged CLI smoke rejected an unexpected invocation authorization'
    )
    this.invocationAuthorizations = 1
    return true
  }

  assertComplete(): PackagedCliSmokeTrustEvidence {
    requireCondition(
      this.spec !== undefined &&
        this.configurationAuthorizations === 1 &&
        this.invocationAuthorizations === 1,
      'Packaged CLI smoke did not exercise both trust phases exactly once'
    )
    return {
      configurationAuthorizations: 1,
      invocationAuthorizations: 1,
      exactLaunchEnvelopeValidated: true,
      exactConfigurationValidated: true,
      exactInvocationValidated: true,
      fixtureRevalidatedBeforeEachAuthorization: true,
      humanApprovalExercised: false
    }
  }

  disarm(): void {
    this.spec = undefined
  }
}

function childSource(input: {
  token: string
  runnerPath: string
  workspacePath: string
  markerPath: string
  prompt: string
  marker: string
  sessionId: string
  childArgs: readonly string[]
}): string {
  const values = {
    token: input.token,
    runnerPath: input.runnerPath,
    workspacePath: input.workspacePath,
    markerPath: input.markerPath,
    prompt: input.prompt,
    marker: input.marker,
    sessionId: input.sessionId,
    childArgs: input.childArgs,
    warning: WARNING,
    blockedEnvironment: BLOCKED_CHILD_ENVIRONMENT,
    maxInputBytes: MAX_CHILD_INPUT_BYTES
  }
  return `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const expected = ${JSON.stringify(values)}
const samePath = (left, right) => {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}
const emit = (value) => {
  process.stdout.write(JSON.stringify(value) + '\\n')
}
async function main() {
  if (!samePath(fs.realpathSync(process.execPath), expected.runnerPath)) {
    throw new Error('runner')
  }
  if (!samePath(fs.realpathSync(process.cwd()), expected.workspacePath)) {
    throw new Error('cwd')
  }
  if (
    JSON.stringify(process.argv.slice(2)) !==
      JSON.stringify(expected.childArgs)
  ) {
    throw new Error('argv')
  }
  if (fs.readFileSync(expected.markerPath, 'utf8') !== expected.token + '\\n') {
    throw new Error('marker')
  }
  const blocked = new Set(expected.blockedEnvironment)
  if (
    Object.keys(process.env).some((name) =>
      blocked.has(name.toUpperCase())
    )
  ) {
    throw new Error('environment')
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > expected.maxInputBytes) throw new Error('stdin')
    chunks.push(value)
  }
  if (Buffer.concat(chunks).toString('utf8') !== expected.prompt) {
    throw new Error('prompt')
  }
  emit({ type: 'thread.started', thread_id: expected.sessionId })
  emit({ type: 'turn.started' })
  emit({
    type: 'item.completed',
    item: {
      id: 'notice_' + expected.token,
      type: 'error',
      message: expected.warning
    }
  })
  emit({
    type: 'item.started',
    item: {
      id: 'command_' + expected.token,
      type: 'command_execution',
      command: 'ground-packaged-cli-fixture',
      status: 'in_progress'
    }
  })
  emit({
    type: 'item.completed',
    item: {
      id: 'command_' + expected.token,
      type: 'command_execution',
      command: 'ground-packaged-cli-fixture',
      status: 'completed',
      exit_code: 0,
      aggregated_output: 'ground packaged CLI fixture completed'
    }
  })
  emit({
    type: 'item.completed',
    item: {
      id: 'message_' + expected.token,
      type: 'agent_message',
      text: expected.marker
    }
  })
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 12,
      cached_input_tokens: 0,
      output_tokens: 4
    }
  })
}
main().catch(() => {
  process.stderr.write('ground-packaged-cli-child-rejected\\n')
  process.exitCode = 2
})
`
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
                `Packaged CLI task cancellation timed out after ${STOP_TIMEOUT_MS}ms`
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

export async function runPackagedCliSmoke(
  input: PackagedCliSmokeInput
): Promise<PackagedCliSmokeEvidence> {
  requireSmokeBoundary(input.config)

  const fixtureDirectory = path.join(
    input.config.directory,
    'recognized-cli'
  )
  const workspace = path.join(input.config.directory, 'cli-workspace')
  await Promise.all([
    mkdir(fixtureDirectory, { mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 })
  ])
  const canonicalWorkspace = await realpath(workspace)
  const runnerCommand = await resolveExecutable('node')
  requireCondition(
    runnerCommand !== undefined,
    'Packaged CLI smoke could not resolve the runner Node executable'
  )
  const runnerPath = await realpath(runnerCommand)
  const runnerDetails = await stat(runnerPath)
  requireCondition(
    runnerDetails.isFile(),
    'Packaged CLI smoke runner Node is not a regular file'
  )
  const runnerNodeSha256 = await sha256File(runnerPath)

  const marker = `ground-packaged-cli-ok-${input.config.token}`
  const prompt =
    `Reply with exactly ${marker}. This is the token-bound packaged CLI smoke.`
  const sessionId = `ground-cli-session-${input.config.token}`
  const childArgument =
    `--ground-packaged-cli-child=${input.config.token}`
  const markerPath = path.join(
    canonicalWorkspace,
    `.ground-packaged-cli-${input.config.token}`
  )
  await writeFile(markerPath, `${input.config.token}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })

  const fixturePath = path.join(
    fixtureDirectory,
    'ground-codex-child.cjs'
  )
  const savedTail = [
    childArgument,
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-'
  ] as const
  const invocationTail = [
    childArgument,
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--model',
    FIXTURE_MODEL,
    '--sandbox',
    'workspace-write',
    '-'
  ] as const
  const source = childSource({
    token: input.config.token,
    runnerPath,
    workspacePath: canonicalWorkspace,
    markerPath,
    prompt,
    marker,
    sessionId,
    childArgs: invocationTail
  })
  await writeFile(fixturePath, source, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
  const canonicalFixturePath = await realpath(fixturePath)
  const scriptSha256 = await sha256File(canonicalFixturePath)
  const configurationArgs = [
    canonicalFixturePath,
    ...savedTail
  ] as const
  const invocationArgs = [
    canonicalFixturePath,
    ...invocationTail
  ] as const
  input.trustAuthority.arm({
    runnerPath,
    runnerSha256: runnerNodeSha256,
    fixturePath: canonicalFixturePath,
    fixtureSha256: scriptSha256,
    workspacePath: canonicalWorkspace,
    configurationArgs,
    invocationArgs
  })

  let taskId: string | undefined
  try {
    const draft = {
      name: 'Packaged recognized Codex CLI',
      kind: 'cli' as const,
      model: FIXTURE_MODEL,
      command: runnerPath,
      args: [...configurationArgs],
      promptMode: 'stdin' as const,
      outputMode: 'ndjson' as const,
      cliAdapter: 'codex' as const,
      cliEnvironment: []
    }
    const saved = await input.providers.save(draft)
    requireCondition(
      saved.kind === 'cli' &&
        saved.command === runnerPath &&
        saved.cliAdapter === 'codex' &&
        saved.trustConfirmed,
      'Packaged CLI smoke did not save the recognized adapter'
    )
    const tested = await input.providers.test({
      ...draft,
      id: saved.id,
      command: saved.command,
      trustConfirmed: true
    })
    requireCondition(
      tested.ok &&
        tested.persisted === true &&
        tested.title === 'Configuration check passed',
      `Packaged CLI configuration readiness failed: ${tested.title} — ${tested.detail}`
    )
    const verified = input.store.getProvider(saved.id)
    requireCondition(
      verified.kind === 'cli' &&
        verified.verification?.status === 'passed' &&
        verified.verification.scope === 'configuration',
      'Packaged CLI readiness was not persisted'
    )

    const grant = await input.workspaceGrants.grant(canonicalWorkspace)
    const authorizedWorkspace = await input.workspaceGrants.require(grant.id)
    const created = await input.store.createTask(authorizedWorkspace)
    taskId = created.id
    await input.store.mutateTask(created.id, (task) => {
      task.providerId = saved.id
      task.mode = 'agent'
    })

    const eventOffset = input.runEvents().length
    const runId = await input.runs.start(created.id, prompt)
    const terminal = await waitForValue(
      'Packaged recognized CLI first turn',
      () =>
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
      `Packaged recognized CLI first turn ended with ${terminal.type}`
    )
    await waitForValue('Packaged CLI run cleanup', () =>
      input.runs.isTaskActive(created.id) ? undefined : true
    )

    const reloaded = new StateStore(
      path.join(input.config.userDataPath, 'ground-state.json')
    )
    await reloaded.load()
    const persistedTask = reloaded.getTask(created.id)
    requireCondition(
      persistedTask.runStatus === 'idle',
      'Packaged CLI task was not durably idle'
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
      'Packaged CLI assistant marker was not persisted'
    )
    requireCondition(
      assistant.provider?.id === saved.id &&
        assistant.provider.kind === 'cli' &&
        assistant.provider.model === FIXTURE_MODEL,
      'Packaged CLI provider attribution was not persisted'
    )
    const session = persistedTask.runtimeSessions?.[saved.id]
    requireCondition(
      session?.adapterId === 'openai.codex-cli' &&
        session.sessionCompatibilityId === 'codex' &&
        session.sessionId === sessionId &&
        session.providerRevision === verified.updatedAt &&
        session.workspacePath === canonicalWorkspace,
      'Packaged CLI runtime session was not persisted'
    )
    const warningNotices = persistedTask.items.filter(
      (item) =>
        item.kind === 'activity' &&
        item.runId === runId &&
        item.activityType === 'diagnostic' &&
        item.title === 'Runtime notices' &&
        item.status === 'success' &&
        item.detail?.includes(WARNING)
    )
    requireCondition(
      warningNotices.length === 1,
      'Packaged CLI non-fatal warning was not persisted exactly once'
    )
    requireCondition(
      persistedTask.items.some(
        (item) =>
          item.kind === 'activity' &&
          item.runId === runId &&
          item.activityType === 'command' &&
          item.title === 'ground-packaged-cli-fixture' &&
          item.status === 'success'
      ),
      'Packaged CLI successful command lifecycle was not persisted'
    )
    requireCondition(
      persistedTask.items.some(
        (item) =>
          item.kind === 'activity' &&
          item.runId === runId &&
          item.title === 'Usage' &&
          item.status === 'success' &&
          item.detail?.includes('12 input') &&
          item.detail.includes('4 output')
      ),
      'Packaged CLI usage was not persisted'
    )
    requireCondition(
      !persistedTask.items.some(
        (item) =>
          item.runId === runId &&
          item.kind === 'activity' &&
          (item.activityType === 'error' || item.status === 'error')
      ) &&
        !input
          .runEvents()
          .slice(eventOffset)
          .some(
            (event) =>
              event.runId === runId && event.type === 'run-error'
          ),
      'Packaged CLI successful turn persisted or emitted a failure'
    )
    await Promise.all([
      requireExactRegularFile(
        runnerPath,
        runnerPath,
        runnerNodeSha256
      ),
      requireExactRegularFile(
        canonicalFixturePath,
        canonicalFixturePath,
        scriptSha256
      )
    ])
    const trust = input.trustAuthority.assertComplete()

    const evidence: PackagedCliSmokeEvidence = {
      version: 1,
      fixture: {
        dialect: 'codex',
        adapterId: 'openai.codex-cli',
        binding: 'token-bound-runner-node-child',
        selection: 'source-registered-recognized-adapter',
        passiveDetectionExercised: false,
        externalCredentialsUsed: false,
        externalVendorCliUsed: false,
        runnerNodeSha256,
        scriptSha256,
        structuredRecordsEmitted: 7,
        stdinPromptTokenObserved: true
      },
      readiness: {
        passed: true,
        persisted: true,
        scope: 'configuration'
      },
      trust,
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
    }
    requireCondition(
      !JSON.stringify(evidence).includes(input.config.token) &&
        !JSON.stringify(evidence).includes(canonicalFixturePath) &&
        !JSON.stringify(evidence).includes(canonicalWorkspace),
      'Packaged CLI smoke evidence exposed token-bound fixture data'
    )
    return evidence
  } finally {
    try {
      if (taskId && input.runs.isTaskActive(taskId)) {
        await stopTaskWithinBound(input.runs, taskId)
      }
    } finally {
      input.trustAuthority.disarm()
    }
  }
}
