import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  ActivityItem,
  CliAdapter,
  CliProvider,
  RunEvent,
  Task
} from '../shared/types'
import { createProcessLaunchEnvelope } from './process-launch'
import type { CliInvocationAuthorizer } from './providers/cli'
import { RunManager } from './run-manager'
import { SecretVault } from './secrets'
import { StateStore } from './store'

const authorizeFixture: CliInvocationAuthorizer = async (request) => ({
  launch: await createProcessLaunchEnvelope(request.command),
  cwd: await realpath(request.cwd)
})
const REDACTION_MARKER = '█'.repeat(5)

const FIXTURE_SOURCE = `
const dialect = process.argv.find((value) => value.startsWith('--dialect='))?.split('=')[1]
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
process.stdin.resume()
process.stdin.on('end', () => {
  if (dialect === 'codex') {
    emit({ type: 'thread.started', thread_id: 'codex-session' })
    emit({ type: 'turn.started' })
    emit({
      type: 'item.started',
      item: { id: 'command-1', type: 'command_execution', command: 'npm test' }
    })
    emit({
      type: 'item.completed',
      item: {
        id: 'command-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'passed',
        exit_code: 0
      }
    })
    emit({
      type: 'item.started',
      item: { id: 'inspection-1', type: 'mcp_tool_call', name: 'inspect_workspace' }
    })
    emit({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } })
    emit({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Codex finished.' }
    })
    return
  }
  emit({ type: 'init', session_id: 'gemini-session', model: 'gemini-test' })
  if (process.argv.includes('--sensitive-runtime')) {
    const secret = process.env.ACME_AGENT_TOKEN
    emit({
      type: 'tool_use',
      tool_id: secret,
      tool_name: secret,
      parameters: { echoed: secret }
    })
    emit({ type: 'message', role: 'assistant', content: 'Gemini finished.' })
    emit({ type: 'result', status: 'success' })
    return
  }
  if (process.argv.includes('--hold')) {
    emit({
      type: 'tool_use',
      tool_id: 'held-1',
      tool_name: 'read_file',
      parameters: { path: 'README.md' }
    })
    setInterval(() => undefined, 1_000)
    return
  }
  emit({
    type: 'tool_use',
    tool_id: 'shell-1',
    tool_name: 'run_shell_command',
    parameters: { command: 'npm test' }
  })
  emit({
    type: 'tool_result',
    tool_id: 'shell-1',
    status: 'success',
    output: 'passed'
  })
  emit({
    type: 'tool_use',
    tool_id: 'read-1',
    tool_name: 'read_file',
    parameters: { path: 'README.md' }
  })
  emit({
    type: 'tool_use',
    tool_name: 'search_file',
    parameters: { query: 'Ground' }
  })
  emit({ type: 'message', role: 'assistant', content: 'Gemini finished.' })
  emit({ type: 'result', status: 'success', stats: { input_tokens: 3, output_tokens: 1 } })
})
`

async function runCliFixture(
  adapter: CliAdapter,
  options: {
    stopAfterFirstRuntimeActivity?: boolean
    environmentSecret?: string
    emitSensitiveActivity?: boolean
    savedSessionId?: string
  } = {}
): Promise<{
  activities: ActivityItem[]
  authorizationArgs: string[][]
  events: RunEvent[]
  task: Task
  terminal: RunEvent
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-cli-run-'))
  const workspaceCandidate = path.join(directory, 'workspace')
  const fixture = path.join(directory, 'runtime-fixture.mjs')
  await Promise.all([
    mkdir(workspaceCandidate),
    writeFile(fixture, FIXTURE_SOURCE, { mode: 0o600 })
  ])
  const workspace = await realpath(workspaceCandidate)

  const store = new StateStore(path.join(directory, 'state.json'))
  await store.load()
  const timestamp = new Date().toISOString()
  const provider: CliProvider = {
    id: `${adapter}-fixture`,
    name: `${adapter} fixture`,
    kind: 'cli',
    model: '',
    command: process.execPath,
    args:
      adapter === 'codex'
        ? [fixture, 'exec', '--json', `--dialect=${adapter}`, '-']
        : [
            fixture,
            `--dialect=${adapter}`,
            ...(options.emitSensitiveActivity
              ? ['--sensitive-runtime']
              : []),
            ...(options.stopAfterFirstRuntimeActivity ? ['--hold'] : [])
          ],
    promptMode: 'stdin',
    outputMode: 'ndjson',
    cliAdapter: adapter,
    ...(options.environmentSecret
      ? {
          environmentVariables: ['ACME_AGENT_TOKEN'],
          environmentFingerprint: 'f'.repeat(64)
        }
      : {}),
    trustConfirmed: true,
    createdAt: timestamp,
    updatedAt: timestamp
  }
  await store.upsertProvider(provider)
  const task = await store.createTask(workspace)
  await store.mutateTask(task.id, (mutable) => {
    mutable.providerId = provider.id
    if (options.savedSessionId && adapter !== 'generic') {
      mutable.runtimeSessions = {
        [provider.id]: {
          adapter,
          sessionId: options.savedSessionId,
          providerRevision: provider.updatedAt,
          workspacePath: workspace,
          mode: 'agent',
          updatedAt: timestamp
        }
      }
    }
  })

  const events: RunEvent[] = []
  const authorizationArgs: string[][] = []
  let resolveTerminal: (event: RunEvent) => void = () => undefined
  let resolveRuntimeActivity: () => void = () => undefined
  const terminal = new Promise<RunEvent>((resolve) => {
    resolveTerminal = resolve
  })
  const firstRuntimeActivity = new Promise<void>((resolve) => {
    resolveRuntimeActivity = resolve
  })
  const manager = new RunManager(
    store,
    {
      get: () =>
        options.environmentSecret
          ? JSON.stringify({
              version: 1,
              fingerprint: provider.environmentFingerprint,
              values: {
                ACME_AGENT_TOKEN: options.environmentSecret
              }
            })
          : undefined
    } as unknown as SecretVault,
    (event) => {
      events.push(event)
      if (
        event.type === 'item-added' &&
        event.item.kind === 'activity' &&
        event.item.callId
      ) {
        resolveRuntimeActivity()
      }
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
    async (request) => {
      authorizationArgs.push([...request.displayArgs])
      return authorizeFixture(request)
    },
    undefined,
    (candidate) => realpath(candidate)
  )

  await manager.start(task.id, 'Inspect the workspace')
  if (options.stopAfterFirstRuntimeActivity) {
    await firstRuntimeActivity
    await manager.stopTask(task.id)
  }
  const terminalEvent = await terminal
  const taskSnapshot = store.getTask(task.id)
  return {
    activities: taskSnapshot.items.filter(
      (item): item is ActivityItem => item.kind === 'activity'
    ),
    authorizationArgs,
    events,
    task: taskSnapshot,
    terminal: terminalEvent
  }
}

describe('RunManager CLI activity lifecycle', () => {
  it('upserts Codex lifecycle events and finalizes an unfinished item', async () => {
    const run = await runCliFixture('codex')
    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    const command = run.activities.filter(
      (item) => item.callId === 'codex:command-1'
    )
    expect(command).toHaveLength(1)
    expect(command[0]).toMatchObject({
      activityType: 'command',
      title: 'npm test',
      detail: '"passed"',
      status: 'success'
    })
    expect(
      run.activities.find((item) => item.callId === 'codex:inspection-1')
    ).toMatchObject({ title: 'inspect_workspace', status: 'success' })
    expect(
      run.activities.filter((item) => item.callId === 'codex:turn')
    ).toHaveLength(1)
    expect(run.activities.some((item) => item.status === 'running')).toBe(false)
  })

  it('upserts Gemini tool results and finalizes an unfinished item', async () => {
    const run = await runCliFixture('gemini')
    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    const command = run.activities.filter(
      (item) => item.callId === 'gemini:shell-1'
    )
    expect(command).toHaveLength(1)
    expect(command[0]).toMatchObject({
      activityType: 'command',
      title: 'run_shell_command',
      detail: '"passed"',
      status: 'success'
    })
    expect(
      run.activities.find((item) => item.callId === 'gemini:read-1')
    ).toMatchObject({ title: 'read_file', status: 'success' })
    expect(
      run.activities.find(
        (item) => item.title === 'search_file' && item.callId === undefined
      )
    ).toMatchObject({ status: 'success' })
    expect(run.activities.some((item) => item.status === 'running')).toBe(false)
  })

  it('finalizes an in-flight CLI activity when the user stops the run', async () => {
    const run = await runCliFixture('gemini', {
      stopAfterFirstRuntimeActivity: true
    })
    expect(run.terminal).toMatchObject({ type: 'run-stopped' })
    expect(
      run.activities.find((item) => item.callId === 'gemini:held-1')
    ).toMatchObject({
      status: 'error',
      detail: expect.stringMatching(/run stopped before/i)
    })
    expect(run.activities.some((item) => item.status === 'running')).toBe(false)
  })

  it('never persists a reflected environment value in an activity title or call ID', async () => {
    const secret = 'runtime-secret'
    const run = await runCliFixture('gemini', {
      environmentSecret: secret,
      emitSensitiveActivity: true
    })
    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    const sensitiveActivity = run.activities.find(
      (item) => item.title === REDACTION_MARKER
    )
    expect(sensitiveActivity).toMatchObject({
      detail: expect.stringContaining(REDACTION_MARKER),
      status: 'success'
    })
    expect(sensitiveActivity).not.toHaveProperty('callId')
    expect(JSON.stringify(run.task)).not.toContain(secret)
  })

  it('cleans a secret-bearing saved session before building resume argv', async () => {
    const secret = 'saved-session-secret'
    const run = await runCliFixture('gemini', {
      environmentSecret: secret,
      savedSessionId: secret
    })
    expect(run.terminal).toMatchObject({ type: 'run-completed' })
    expect(run.authorizationArgs.flat()).not.toContain(secret)
    expect(
      run.task.runtimeSessions?.['gemini-fixture']?.sessionId
    ).toBe('gemini-session')
    expect(JSON.stringify(run.task)).not.toContain(secret)
  })
})
