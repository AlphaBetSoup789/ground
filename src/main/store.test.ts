import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  ModelApiProvider,
  RecoveryNotice,
  TaskItem
} from '../shared/types'
import { MAX_PERSISTED_TASK_ITEMS } from './state-schema'
import {
  StatePersistenceError,
  StateStore
} from './store'
import type { GroundTaskImportTemplate } from './task-portability'
import { providerConfigurationFingerprint } from './provider-revision'

const importedTemplate = (
  overrides: Partial<GroundTaskImportTemplate> = {}
): GroundTaskImportTemplate => ({
  title: 'Portable task',
  mode: 'agent',
  provider: {
    type: 'model-api',
    kind: 'anthropic',
    name: 'Anthropic',
    model: 'claude-test',
    supportsTools: true
  },
  timeline: [
    {
      kind: 'message',
      role: 'user',
      content: 'Review this project.',
      provider: {
        kind: 'anthropic',
        name: 'Anthropic',
        model: 'claude-test'
      }
    },
    {
      kind: 'activity',
      activityType: 'approval',
      title: 'Previous command',
      status: 'interrupted',
      toolName: 'run_command',
      input: { command: 'npm test' }
    }
  ],
  conversation: [
    {
      kind: 'message',
      role: 'user',
      parts: [{ kind: 'text', text: 'Review this project.' }]
    },
    {
      kind: 'message',
      role: 'assistant',
      parts: [
        {
          kind: 'tool-call',
          callId: 'import-call-1',
          name: 'read_file',
          rawArguments: '{}',
          arguments: {}
        }
      ]
    },
    {
      kind: 'tool-result',
      callId: 'import-call-1',
      name: 'read_file',
      content: [{ kind: 'text', text: 'Historical result' }]
    }
  ],
  source: {
    formatVersion: 1,
    exportedAt: '2026-07-28T12:00:00.000Z'
  },
  ...overrides
})

describe('StateStore', () => {
  it('persists the latest chosen provider as the default for new tasks', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const first = new StateStore(filePath)
    await first.load()
    const current = await first.createTask(directory)
    const timestamp = new Date().toISOString()
    const chosen: ModelApiProvider = {
      id: 'chosen-provider',
      name: 'Chosen provider',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
      hasApiKey: true,
      supportsTools: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await first.upsertProvider(chosen)
    await first.mutateTask(current.id, (task) => {
      task.providerId = chosen.id
    })

    expect(first.snapshot().settings.defaultProviderId).toBe(chosen.id)

    const reloaded = new StateStore(filePath)
    await reloaded.load()
    expect(reloaded.snapshot().settings.defaultProviderId).toBe(chosen.id)
    await expect(reloaded.createTask()).resolves.toMatchObject({
      providerId: chosen.id
    })
  })

  it('normalizes the default provider when that provider is removed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const store = new StateStore(path.join(directory, 'state.json'))
    await store.load()
    const timestamp = new Date().toISOString()
    const chosen: ModelApiProvider = {
      id: 'temporary-provider',
      name: 'Temporary provider',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'test-model',
      hasApiKey: true,
      supportsTools: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await store.upsertProvider(chosen)
    const task = await store.createTask()
    await store.mutateTask(task.id, (mutable) => {
      mutable.providerId = chosen.id
    })

    await store.deleteProvider(chosen.id)

    expect(store.snapshot().settings.defaultProviderId).toBe('ollama-local')
    await expect(store.createTask()).resolves.toMatchObject({
      providerId: 'ollama-local'
    })
  })

  it('atomically journals staged and obsolete credential references outside renderer snapshots', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const timestamp = new Date().toISOString()
    const provider: ModelApiProvider = {
      id: 'journaled-provider',
      name: 'Journaled provider',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'test-model',
      hasApiKey: true,
      credentialRevision: 'credential_current',
      supportsTools: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const staged = 'provider-credential:v2:staged'
    const obsolete = 'provider-credential:v1:obsolete'

    await store.queueProvisionalSecretDelete(staged)
    expect(store.pendingSecretDeletes()).toEqual([staged])
    expect(store.snapshot()).not.toHaveProperty('pendingSecretDeletes')

    await store.publishProviderSecretTransition(
      provider,
      staged,
      [obsolete]
    )
    expect(store.pendingSecretDeletes()).toEqual([obsolete])

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      pendingSecretDeletes?: string[]
    }
    expect(persisted.pendingSecretDeletes).toEqual([obsolete])

    const reloaded = new StateStore(filePath)
    await reloaded.load()
    expect(reloaded.pendingSecretDeletes()).toEqual([obsolete])
    await reloaded.acknowledgeSecretDeletes([obsolete])
    expect(reloaded.pendingSecretDeletes()).toEqual([])

    await reloaded.deleteProviderWithSecretTransition(provider.id, [staged])
    expect(reloaded.pendingSecretDeletes()).toEqual([staged])
    expect(() => reloaded.getProvider(provider.id)).toThrow(/not found/i)
  })

  it('persists tasks and recovers interrupted run status', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const first = new StateStore(filePath)
    await first.load()
    const task = await first.createTask(directory)
    await first.mutateTask(task.id, (mutable) => {
      mutable.title = 'Persistent task'
      mutable.runStatus = 'running'
      mutable.items.push(
        {
          id: 'pending-approval',
          kind: 'activity',
          runId: 'interrupted-run',
          activityType: 'approval',
          title: 'Approve a write',
          status: 'pending',
          approvalId: 'stale-approval',
          createdAt: '2026-07-28T12:00:00.000Z'
        },
        {
          id: 'running-tool',
          kind: 'activity',
          runId: 'interrupted-run',
          activityType: 'tool',
          title: 'Writing a file',
          status: 'running',
          createdAt: '2026-07-28T12:00:01.000Z'
        }
      )
    })

    const second = new StateStore(filePath)
    await second.load()
    const restored = second.getTask(task.id)
    expect(restored.title).toBe('Persistent task')
    expect(restored.runStatus).toBe('failed')
    expect(restored.items.at(-1)).toMatchObject({
      kind: 'activity',
      activityType: 'error',
      title: 'Run interrupted',
      status: 'error'
    })
    expect(
      restored.items
        .slice(0, 2)
        .map((item) => (item.kind === 'activity' ? item.status : undefined))
    ).toEqual(['error', 'error'])
    expect(restored.items[0]).not.toHaveProperty('approvalId')
    expect(restored.items.at(-1)).toMatchObject({
      kind: 'activity',
      runId: 'interrupted-run'
    })

    const third = new StateStore(filePath)
    await third.load()
    const loadedTwice = third.getTask(task.id)
    expect(loadedTwice.items).toHaveLength(restored.items.length)
    expect(
      loadedTwice.items.filter(
        (item) =>
          item.kind === 'activity' &&
          item.activityType === 'error' &&
          item.title === 'Run interrupted'
      )
    ).toHaveLength(1)
  })

  it('terminalizes stale activities but only adds an interruption to an active task', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const first = new StateStore(filePath)
    await first.load()
    const inactive = await first.createTask(directory)
    const active = await first.createTask(directory)

    await first.mutateTask(inactive.id, (task) => {
      task.items.push({
        id: 'inactive-pending',
        kind: 'activity',
        runId: 'inactive-run',
        activityType: 'approval',
        title: 'Stale inactive approval',
        status: 'pending',
        approvalId: 'inactive-approval',
        createdAt: '2026-07-28T12:00:00.000Z'
      })
    })
    await first.mutateTask(active.id, (task) => {
      task.runStatus = 'awaiting-approval'
      task.items.push(
        {
          id: 'active-pending',
          kind: 'activity',
          runId: 'active-run',
          activityType: 'approval',
          title: 'Stale active approval',
          status: 'pending',
          approvalId: 'active-approval',
          createdAt: '2026-07-28T12:00:01.000Z'
        },
        {
          id: 'active-running',
          kind: 'activity',
          runId: 'active-run',
          activityType: 'tool',
          title: 'Running tool',
          status: 'running',
          createdAt: '2026-07-28T12:00:02.000Z'
        }
      )
    })

    const recovered = new StateStore(filePath)
    await recovered.load()
    const inactiveTask = recovered.getTask(inactive.id)
    const activeTask = recovered.getTask(active.id)

    expect(inactiveTask.runStatus).toBe('idle')
    expect(inactiveTask.items[0]).toMatchObject({ status: 'error' })
    expect(inactiveTask.items[0]).not.toHaveProperty('approvalId')
    expect(
      inactiveTask.items.filter(
        (item) =>
          item.kind === 'activity' && item.title === 'Run interrupted'
      )
    ).toEqual([])

    expect(activeTask.runStatus).toBe('failed')
    expect(
      activeTask.items
        .slice(0, 2)
        .map((item) => (item.kind === 'activity' ? item.status : undefined))
    ).toEqual(['error', 'error'])
    expect(activeTask.items[0]).not.toHaveProperty('approvalId')
    expect(
      activeTask.items.filter(
        (item) =>
          item.kind === 'activity' && item.title === 'Run interrupted'
      )
    ).toHaveLength(1)
  })

  it('atomically begins and completes an exact approved managed execution claim', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    const createdAt = '2026-07-28T12:00:00.000Z'
    await store.mutateTask(task.id, (mutable) => {
      mutable.runStatus = 'awaiting-approval'
      mutable.items.push({
        id: 'managed-write',
        kind: 'activity',
        runId: 'managed-run',
        activityType: 'approval',
        title: 'Write src/app.ts',
        detail: 'Exact approved diff',
        status: 'pending',
        approvalId: 'approval-1',
        toolName: 'write_file',
        callId: 'call-1',
        input: { path: 'src/app.ts', content: 'next' },
        createdAt
      })
    })

    const begin = {
      taskId: task.id,
      itemId: 'managed-write',
      runId: 'managed-run',
      callId: 'call-1',
      toolName: 'write_file',
      kind: 'workspace-write' as const,
      actionSha256: 'a'.repeat(64),
      approvalSha256: 'b'.repeat(64),
      startedAt: '2026-07-28T12:00:01.000Z'
    }
    await expect(
      store.beginManagedExecution({ ...begin, runId: 'wrong-run' })
    ).rejects.toThrow(/identity/i)
    expect(store.getTask(task.id).items[0]).toMatchObject({
      status: 'pending',
      approvalId: 'approval-1'
    })
    expect(store.getTask(task.id).items[0]).not.toHaveProperty(
      'managedExecution'
    )

    const started = await store.beginManagedExecution(begin)
    expect(started).toMatchObject({
      id: 'managed-write',
      activityType: 'tool',
      status: 'running',
      managedExecution: {
        version: 1,
        operationId: 'managed-write',
        claim: 'approved',
        kind: 'workspace-write',
        actionSha256: 'a'.repeat(64),
        approvalSha256: 'b'.repeat(64),
        phase: 'started',
        startedAt: '2026-07-28T12:00:01.000Z'
      }
    })
    expect(started).not.toHaveProperty('approvalId')
    expect(store.getTask(task.id).runStatus).toBe('running')
    await expect(store.beginManagedExecution(begin)).rejects.toThrow(
      /awaiting approval|unconsumed pending approval/i
    )

    const completion = {
      taskId: task.id,
      itemId: 'managed-write',
      operationId: 'managed-write',
      actionSha256: 'a'.repeat(64),
      status: 'success' as const,
      result: 'Wrote src/app.ts.',
      durationMs: 42,
      completedAt: '2026-07-28T12:00:02.000Z'
    }
    await expect(
      store.completeManagedExecution({
        ...completion,
        actionSha256: 'c'.repeat(64)
      })
    ).rejects.toThrow(/action hash/i)
    expect(
      (
        store.getTask(task.id).items[0] as {
          managedExecution?: { phase?: string }
        }
      ).managedExecution?.phase
    ).toBe('started')

    const completed = await store.completeManagedExecution(completion)
    expect(completed).toMatchObject({
      status: 'success',
      result: 'Wrote src/app.ts.',
      durationMs: 42,
      managedExecution: {
        operationId: 'managed-write',
        actionSha256: 'a'.repeat(64),
        approvalSha256: 'b'.repeat(64),
        phase: 'completed',
        completedAt: '2026-07-28T12:00:02.000Z'
      }
    })
    await expect(
      store.completeManagedExecution(completion)
    ).rejects.toThrow(/exact started claim/i)

    await store.mutateTask(task.id, (mutable) => {
      mutable.runStatus = 'idle'
    })
    const forked = await store.forkTask(task.id)
    expect(forked.items[0]).not.toHaveProperty('managedExecution')

    const reloaded = new StateStore(filePath)
    await reloaded.load()
    expect(reloaded.getTask(task.id).items[0]).toMatchObject({
      managedExecution: {
        phase: 'completed',
        actionSha256: 'a'.repeat(64)
      }
    })
  })

  it('recovers an unresolved approved execution as outcome-unknown without retrying it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const first = new StateStore(filePath)
    await first.load()
    const task = await first.createTask(directory)
    const timestamp = '2026-07-28T12:00:00.000Z'
    await first.mutateTask(task.id, (mutable) => {
      mutable.runStatus = 'awaiting-approval'
      mutable.runtimeSessions = {
        'ollama-local': {
          adapterId: 'openai.codex-cli',
          sessionCompatibilityId: 'codex',
          sessionId: 'native-session',
          providerRevision: timestamp,
          workspacePath: directory,
          mode: 'agent',
          updatedAt: timestamp
        }
      }
      mutable.modelSessions = {
        'ollama-local': {
          adapterId: 'openai.compatible',
          providerRevision: timestamp,
          model: 'llama3.2',
          workspacePath: directory,
          mode: 'agent',
          conversation: [],
          checkpoint: { responseId: 'provider-checkpoint' },
          updatedAt: timestamp
        }
      }
      mutable.items.push({
        id: 'unresolved-command',
        kind: 'activity',
        runId: 'unresolved-run',
        activityType: 'approval',
        title: 'Run npm test',
        status: 'pending',
        approvalId: 'approval-command',
        toolName: 'run_command',
        callId: 'command-call',
        input: { command: 'npm', args: ['test'] },
        createdAt: timestamp
      })
    })
    await first.beginManagedExecution({
      taskId: task.id,
      itemId: 'unresolved-command',
      runId: 'unresolved-run',
      callId: 'command-call',
      toolName: 'run_command',
      kind: 'command',
      actionSha256: 'd'.repeat(64),
      approvalSha256: 'e'.repeat(64),
      startedAt: '2026-07-28T12:00:01.000Z'
    })

    const recovered = new StateStore(filePath)
    await recovered.load()
    const recoveredTask = recovered.getTask(task.id)
    const recoveredItem = recoveredTask.items.find(
      (item) => item.id === 'unresolved-command'
    )
    expect(recoveredTask.runStatus).toBe('failed')
    expect(recoveredTask.runtimeSessions).toBeUndefined()
    expect(
      recoveredTask.modelSessions?.['ollama-local']
    ).not.toHaveProperty('checkpoint')
    expect(recoveredItem).toMatchObject({
      kind: 'activity',
      activityType: 'command',
      status: 'error',
      result: expect.stringMatching(/Outcome unknown.*will not retry/is),
      managedExecution: {
        operationId: 'unresolved-command',
        claim: 'approved',
        kind: 'command',
        actionSha256: 'd'.repeat(64),
        approvalSha256: 'e'.repeat(64),
        phase: 'uncertain',
        startedAt: '2026-07-28T12:00:01.000Z',
        interruptedAt: expect.any(String)
      }
    })
    expect(
      recoveredTask.items.filter(
        (item) =>
          item.kind === 'activity' &&
          item.runId === 'unresolved-run' &&
          item.title === 'Run interrupted'
      )
    ).toHaveLength(1)
    await expect(
      recovered.completeManagedExecution({
        taskId: task.id,
        itemId: 'unresolved-command',
        operationId: 'unresolved-command',
        actionSha256: 'd'.repeat(64),
        status: 'success',
        result: 'must not be accepted',
        durationMs: 1,
        completedAt: new Date().toISOString()
      })
    ).rejects.toThrow(/outcome is unknown/i)

    const recoveredMarker =
      recoveredItem?.kind === 'activity'
        ? structuredClone(recoveredItem.managedExecution)
        : undefined
    const loadedAgain = new StateStore(filePath)
    await loadedAgain.load()
    const loadedAgainTask = loadedAgain.getTask(task.id)
    const loadedAgainItem = loadedAgainTask.items.find(
      (item) => item.id === 'unresolved-command'
    )
    expect(
      loadedAgainItem?.kind === 'activity'
        ? loadedAgainItem.managedExecution
        : undefined
    ).toEqual(recoveredMarker)
    expect(
      loadedAgainTask.items.filter(
        (item) =>
          item.kind === 'activity' &&
          item.runId === 'unresolved-run' &&
          item.title === 'Run interrupted'
      )
    ).toHaveLength(1)
  })

  it('marks legacy running mutators uncertain without inventing approval hashes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const first = new StateStore(filePath)
    await first.load()
    const task = await first.createTask(directory)
    const timestamp = '2026-07-28T12:00:00.000Z'
    await first.mutateTask(task.id, (mutable) => {
      mutable.runStatus = 'running'
      mutable.items.push(
        {
          id: 'legacy-write',
          kind: 'activity',
          runId: 'legacy-write-run',
          activityType: 'tool',
          title: 'Writing a file',
          toolName: 'edit_file',
          callId: 'legacy-write-call',
          status: 'running',
          createdAt: timestamp
        },
        {
          id: 'legacy-command',
          kind: 'activity',
          runId: 'legacy-command-run',
          activityType: 'command',
          title: 'Running a command',
          toolName: 'run_command',
          callId: 'legacy-command-call',
          status: 'running',
          createdAt: timestamp
        },
        {
          id: 'legacy-mcp',
          kind: 'activity',
          runId: 'legacy-mcp-run',
          activityType: 'tool',
          title: 'Calling an MCP tool',
          toolName: 'mcp__tracker__create_issue',
          callId: 'legacy-mcp-call',
          status: 'running',
          createdAt: timestamp
        },
        {
          id: 'legacy-read',
          kind: 'activity',
          runId: 'legacy-read-run',
          activityType: 'tool',
          title: 'Reading a file',
          toolName: 'read_file',
          callId: 'legacy-read-call',
          status: 'running',
          createdAt: timestamp
        }
      )
    })

    const recovered = new StateStore(filePath)
    await recovered.load()
    const restored = recovered.getTask(task.id)
    for (const [itemId, kind] of [
      ['legacy-write', 'workspace-write'],
      ['legacy-command', 'command'],
      ['legacy-mcp', 'mcp']
    ] as const) {
      const item = restored.items.find((candidate) => candidate.id === itemId)
      expect(item).toMatchObject({
        kind: 'activity',
        status: 'error',
        result: expect.stringMatching(/before durable execution claims.*will not retry/is),
        managedExecution: {
          version: 1,
          operationId: itemId,
          claim: 'legacy-untracked',
          kind,
          phase: 'uncertain',
          startedAt: timestamp,
          interruptedAt: expect.any(String)
        }
      })
      expect(JSON.stringify(item)).not.toContain('actionSha256')
      expect(JSON.stringify(item)).not.toContain('approvalSha256')
    }
    expect(
      restored.items.find((item) => item.id === 'legacy-read')
    ).not.toHaveProperty('managedExecution')
    expect(
      restored.items.filter(
        (item) =>
          item.kind === 'activity' && item.title === 'Run interrupted'
      )
    ).toHaveLength(4)

    const loadedAgain = new StateStore(filePath)
    await loadedAgain.load()
    expect(
      loadedAgain
        .getTask(task.id)
        .items.filter(
          (item) =>
            item.kind === 'activity' && item.title === 'Run interrupted'
        )
    ).toHaveLength(4)
  })

  it('bounds recovery summaries by the remaining persisted task-item capacity', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const timestamp = '2026-07-28T12:00:00.000Z'
    const fillerCount = MAX_PERSISTED_TASK_ITEMS - 3
    const items: TaskItem[] = Array.from(
      { length: fillerCount },
      (_, index) => ({
        id: `filler-${index}`,
        kind: 'message' as const,
        role: 'user' as const,
        content: '',
        createdAt: timestamp
      })
    )
    items.push(
      {
        id: 'capacity-running-one',
        kind: 'activity' as const,
        runId: 'capacity-run-one',
        activityType: 'tool' as const,
        title: 'First interrupted read',
        toolName: 'read_file',
        status: 'running' as const,
        createdAt: timestamp
      },
      {
        id: 'capacity-running-two',
        kind: 'activity' as const,
        runId: 'capacity-run-two',
        activityType: 'tool' as const,
        title: 'Second interrupted read',
        toolName: 'read_file',
        status: 'running' as const,
        createdAt: timestamp
      }
    )
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'ollama-local',
            name: 'Ollama · local',
            kind: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'llama3.2',
            hasApiKey: false,
            supportsTools: true,
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ],
        mcpServers: [],
        tasks: [
          {
            id: 'capacity-task',
            title: 'Capacity recovery',
            providerId: 'ollama-local',
            mode: 'agent',
            runStatus: 'running',
            createdAt: timestamp,
            updatedAt: timestamp,
            items
          }
        ],
        settings: {
          selectedTaskId: 'capacity-task',
          defaultProviderId: 'ollama-local',
          sidebarCollapsed: false
        }
      })
    )

    const recovered = new StateStore(filePath)
    await recovered.load()
    const task = recovered.getTask('capacity-task')
    expect(task.items).toHaveLength(MAX_PERSISTED_TASK_ITEMS)
    expect(
      task.items.filter(
        (item) =>
          item.kind === 'activity' && item.title === 'Run interrupted'
      )
    ).toHaveLength(1)
    expect(
      task.items
        .flatMap(
          (item) =>
            item.kind === 'activity' &&
            item.id.startsWith('capacity-running-')
              ? [item.status]
              : []
        )
    ).toEqual(['error', 'error'])
    expect(task.runStatus).toBe('failed')
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('state.json.unreadable-')
      )
    ).toBe(false)

    const loadedAgain = new StateStore(filePath)
    await loadedAgain.load()
    expect(loadedAgain.getTask('capacity-task').items).toHaveLength(
      MAX_PERSISTED_TASK_ITEMS
    )
  })

  it('does not expose mutable references to persisted task state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const store = new StateStore(path.join(directory, 'state.json'))
    await store.load()
    const created = await store.createTask(directory)

    const exposed = store.getTask(created.id)
    exposed.title = 'Changed without the store'
    exposed.items.push({
      id: 'forged',
      kind: 'message',
      role: 'assistant',
      content: 'not persisted',
      createdAt: new Date().toISOString()
    })

    const persisted = store.getTask(created.id)
    expect(persisted.title).toBe('New task')
    expect(persisted.items).toEqual([])
  })

  it('imports inert history and only seeds conversation for an exact model hint', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const exactProvider: ModelApiProvider = {
      id: 'anthropic-existing',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
      hasApiKey: true,
      supportsTools: true,
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z'
    }
    await store.upsertProvider(exactProvider)

    const imported = await store.importTask(importedTemplate())

    expect(imported).toMatchObject({
      title: 'Portable task',
      providerId: exactProvider.id,
      includeImportedHistory: false,
      runStatus: 'idle'
    })
    expect(imported).not.toHaveProperty('workspacePath')
    expect(imported).not.toHaveProperty('runtimeSessions')
    expect(imported.items).toHaveLength(2)
    expect(imported.items.every((item) => item.historyOnly)).toBe(true)
    expect(imported.items[0]?.provider).toEqual({
      id: exactProvider.id,
      kind: exactProvider.kind,
      name: exactProvider.name,
      model: exactProvider.model
    })
    expect(imported.items[1]).toMatchObject({
      kind: 'activity',
      status: 'error'
    })
    expect(imported.items[1]).not.toHaveProperty('approvalId')
    expect(imported.modelSessions?.[exactProvider.id]).toMatchObject({
      adapterId: 'anthropic.messages',
      providerRevision: exactProvider.updatedAt,
      providerFingerprint:
        providerConfigurationFingerprint(exactProvider),
      model: exactProvider.model,
      includesImportedHistory: true,
      origin: 'imported'
    })
    expect(imported.modelSessions?.[exactProvider.id]).not.toHaveProperty(
      'workspacePath'
    )
    expect(imported.modelSessions?.[exactProvider.id]).not.toHaveProperty(
      'checkpoint'
    )
    expect(JSON.stringify(imported)).not.toContain('providerState')

    const restored = new StateStore(filePath)
    await restored.load()
    expect(restored.getTask(imported.id).items.every((item) => item.historyOnly)).toBe(
      true
    )
  })

  it('falls back to the current provider without attaching incompatible conversation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const store = new StateStore(path.join(directory, 'state.json'))
    await store.load()
    await store.upsertProvider({
      id: 'current-cli',
      name: 'Current CLI',
      kind: 'cli',
      model: '',
      command: '/usr/bin/true',
      args: [],
      promptMode: 'stdin',
      outputMode: 'plain',
      cliAdapter: 'generic',
      trustConfirmed: true,
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z'
    })
    const current = await store.createTask()
    await store.mutateTask(current.id, (task) => {
      task.providerId = 'current-cli'
    })

    const imported = await store.importTask(
      importedTemplate({
        provider: {
          type: 'model-api',
          kind: 'openai',
          name: 'Missing provider',
          model: 'missing-model',
          supportsTools: true
        }
      })
    )

    expect(imported.providerId).toBe('current-cli')
    expect(imported.modelSessions).toBeUndefined()
    expect(imported.workspacePath).toBeUndefined()
  })

  it('bounds portable fields to the durable state schema before persisting', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const exactProvider: ModelApiProvider = {
      id: 'bounded-anthropic',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
      hasApiKey: true,
      supportsTools: true,
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z'
    }
    await store.upsertProvider(exactProvider)

    const imported = await store.importTask(
      importedTemplate({
        title: '😀'.repeat(100),
        timeline: [
          {
            kind: 'activity',
            activityType: 'tool',
            title: 'Historical tool',
            detail: 'd'.repeat(100_100),
            result: 'r'.repeat(100_100),
            status: 'success',
            toolName: 't'.repeat(512)
          }
        ],
        conversation: [
          {
            kind: 'message',
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                callId: 'import-call-1',
                name: 'n'.repeat(512),
                rawArguments: '{}',
                parseError: 'p'.repeat(10_100)
              }
            ]
          }
        ]
      })
    )

    expect(imported.title.length).toBeLessThanOrEqual(120)
    expect(
      imported.items[0]?.kind === 'activity'
        ? imported.items[0].detail?.length
        : undefined
    ).toBe(100_000)
    expect(
      imported.items[0]?.kind === 'activity'
        ? imported.items[0].toolName?.length
        : undefined
    ).toBe(200)

    const restored = new StateStore(filePath)
    await restored.load()
    const restoredTask = restored.getTask(imported.id)
    const conversation = restoredTask.modelSessions?.[exactProvider.id]?.conversation
    const toolCall =
      conversation?.[0]?.kind === 'message'
        ? conversation[0].parts.find((part) => part.kind === 'tool-call')
        : undefined
    expect(toolCall?.name.length).toBe(200)
    expect(toolCall?.parseError?.length).toBe(10_000)
  })

  it('never deletes a running task and selects a safe neighbor after deletion', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const store = new StateStore(path.join(directory, 'state.json'))
    await store.load()
    const first = await store.createTask()
    const second = await store.createTask()
    await store.mutateTask(second.id, (task) => {
      task.runStatus = 'running'
    })

    await expect(store.deleteTask(second.id)).rejects.toThrow(
      'Stop this task before deleting it'
    )
    expect(store.snapshot().tasks.map((task) => task.id)).toContain(second.id)

    await store.mutateTask(second.id, (task) => {
      task.runStatus = 'idle'
    })
    await store.deleteTask(second.id)

    expect(store.snapshot().tasks.map((task) => task.id)).toEqual([first.id])
    expect(store.snapshot().settings.selectedTaskId).toBe(first.id)
  })

  it('archives reversibly, keeps archived tasks out of the active selection, and blocks active tasks', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const neighbor = await store.createTask()
    const task = await store.createTask()

    await store.mutateTask(task.id, (mutable) => {
      mutable.runStatus = 'awaiting-approval'
    })
    await expect(store.setTaskArchived(task.id, true)).rejects.toThrow(
      'Stop this task before archiving it'
    )
    await expect(store.forkTask(task.id)).rejects.toThrow(
      'Stop this task before forking it'
    )

    await store.mutateTask(task.id, (mutable) => {
      mutable.runStatus = 'idle'
    })
    const archived = await store.setTaskArchived(task.id, true)
    expect(archived.archivedAt).toBeTruthy()
    expect(store.snapshot().settings.selectedTaskId).toBe(neighbor.id)

    const restored = await store.setTaskArchived(task.id, false)
    expect(restored.archivedAt).toBeUndefined()
    expect(store.snapshot().settings.selectedTaskId).toBe(task.id)

    await store.setTaskArchived(task.id, true)
    const reloaded = new StateStore(filePath)
    await reloaded.load()
    expect(reloaded.getTask(task.id).archivedAt).toBeTruthy()
    expect(reloaded.snapshot().settings.selectedTaskId).toBe(neighbor.id)
  })

  it('forks inert provider-neutral history without carrying native or approval authority', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const store = new StateStore(path.join(directory, 'state.json'))
    await store.load()
    const source = await store.createTask(directory)
    await store.mutateTask(source.id, (task) => {
      task.title = 'Long-running review'
      task.includeImportedHistory = true
      task.items = [
        {
          id: 'source-user',
          kind: 'message',
          runId: 'source-run',
          role: 'user',
          content: 'Review the implementation.',
          createdAt: '2026-07-28T12:00:00.000Z'
        },
        {
          id: 'source-approval',
          kind: 'activity',
          runId: 'source-run',
          activityType: 'approval',
          title: 'Write src/index.ts',
          status: 'pending',
          createdAt: '2026-07-28T12:00:01.000Z',
          approvalId: 'approval-authority',
          toolName: 'write_file',
          input: { path: 'src/index.ts', content: 'changed' },
          callId: 'source-call'
        },
        {
          id: 'source-imported',
          kind: 'message',
          role: 'assistant',
          content: 'Imported background.',
          historyOnly: true,
          createdAt: '2026-07-28T12:00:02.000Z'
        }
      ]
      task.runtimeSessions = {
        'ollama-local': {
          adapterId: 'openai.codex-cli',
          sessionCompatibilityId: 'codex',
          sessionId: 'native-session-authority',
          providerRevision: '2026-07-28T12:00:00.000Z',
          workspacePath: directory,
          mode: 'agent',
          updatedAt: '2026-07-28T12:00:00.000Z'
        }
      }
      task.modelSessions = {
        'ollama-local': {
          adapterId: 'openai.compatible',
          providerRevision: store.getProvider('ollama-local').updatedAt,
          providerFingerprint: providerConfigurationFingerprint(
            store.getProvider('ollama-local')
          ),
          model: 'llama3.2',
          workspacePath: directory,
          mode: 'agent',
          includesImportedHistory: true,
          origin: 'ground',
          conversation: [
            {
              kind: 'message',
              id: 'source-user',
              role: 'user',
              parts: [
                {
                  kind: 'text',
                  text: 'Review the implementation.',
                  providerState: {
                    adapterId: 'private-adapter',
                    schemaVersion: 1,
                    data: { secretCheckpoint: 'opaque' }
                  }
                }
              ],
              providerState: {
                adapterId: 'private-adapter',
                schemaVersion: 1,
                data: 'opaque-message-state'
              }
            },
            {
              kind: 'message',
              id: 'source-assistant',
              role: 'assistant',
              parts: [
                {
                  kind: 'tool-call',
                  callId: 'source-call',
                  name: 'write_file',
                  rawArguments: '{"path":"src/index.ts"}',
                  arguments: { path: 'src/index.ts' },
                  providerState: {
                    adapterId: 'private-adapter',
                    schemaVersion: 1,
                    data: 'opaque-call-state'
                  }
                },
                {
                  kind: 'tool-call',
                  callId: 'unpaired-call',
                  name: 'run_command',
                  rawArguments: '{}'
                }
              ]
            },
            {
              kind: 'tool-result',
              id: 'source-result',
              callId: 'source-call',
              name: 'write_file',
              content: [{ kind: 'text', text: 'Approval was requested.' }],
              providerState: {
                adapterId: 'private-adapter',
                schemaVersion: 1,
                data: 'opaque-result-state'
              }
            },
            {
              kind: 'tool-result',
              id: 'orphan-result',
              callId: 'orphan-call',
              name: 'read_file',
              content: [{ kind: 'text', text: 'orphaned' }]
            }
          ],
          checkpoint: { nativeResumeToken: 'do-not-copy' },
          updatedAt: '2026-07-28T12:00:03.000Z'
        }
      }
    })
    await store.setTaskArchived(source.id, true)

    const forked = await store.forkTask(source.id)

    expect(forked).toMatchObject({
      title: 'Long-running review (fork)',
      workspacePath: directory,
      providerId: 'ollama-local',
      mode: 'agent',
      includeImportedHistory: true,
      runStatus: 'idle'
    })
    expect(forked.id).not.toBe(source.id)
    expect(forked.archivedAt).toBeUndefined()
    expect(forked.runtimeSessions).toBeUndefined()
    expect(forked.items.map((item) => item.id)).not.toContain('source-user')
    expect(forked.items[0]).toMatchObject({ kind: 'message' })
    expect(forked.items[0]).not.toHaveProperty('historyOnly')
    expect(forked.items[1]).toMatchObject({
      kind: 'activity',
      status: 'error'
    })
    expect(forked.items[1]).not.toHaveProperty('approvalId')
    expect(forked.items[2]).toMatchObject({
      kind: 'message',
      historyOnly: true
    })

    const session = forked.modelSessions?.['ollama-local']
    expect(session).not.toHaveProperty('checkpoint')
    expect(session).toMatchObject({
      providerFingerprint: providerConfigurationFingerprint(
        store.getProvider('ollama-local')
      ),
      includesImportedHistory: true,
      origin: 'ground'
    })
    const userMessage = session?.conversation.find(
      (item) => item.kind === 'message' && item.role === 'user'
    )
    expect(userMessage?.id).toBe(forked.items[0]?.id)
    const toolCall =
      session?.conversation
        .filter((item) => item.kind === 'message')
        .flatMap((item) => (item.kind === 'message' ? item.parts : []))
        .find((part) => part.kind === 'tool-call')
    const toolResult = session?.conversation.find(
      (item) => item.kind === 'tool-result'
    )
    expect(toolCall?.kind === 'tool-call' ? toolCall.callId : undefined).toBe(
      toolResult?.kind === 'tool-result' ? toolResult.callId : undefined
    )
    expect(toolCall?.kind === 'tool-call' ? toolCall.callId : undefined).toBe(
      forked.items[1]?.kind === 'activity'
        ? forked.items[1].callId
        : undefined
    )
    expect(JSON.stringify(forked)).not.toContain('providerState')
    expect(JSON.stringify(forked)).not.toContain('nativeResumeToken')
    expect(JSON.stringify(forked)).not.toContain('unpaired-call')
    expect(JSON.stringify(forked)).not.toContain('orphan-call')
    expect(JSON.stringify(store.getTask(source.id))).toContain(
      'native-session-authority'
    )
  })

  it('quarantines structurally invalid state instead of trusting loose JSON', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'provider',
            name: 'Forged provider',
            kind: 'unknown-protocol',
            model: 'model',
            createdAt: 'now',
            updatedAt: 'now'
          }
        ],
        tasks: 'not-an-array',
        settings: { sidebarCollapsed: false }
      })
    )

    const store = new StateStore(filePath)
    await store.load()

    expect(store.snapshot().providers[0]).toMatchObject({
      id: 'ollama-local',
      kind: 'openai-compatible'
    })
    expect(store.snapshot().tasks).toEqual([])
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('state.json.unreadable-')
      )
    ).toBe(true)
    expect(store.snapshot().recoveryNotice).toMatchObject({
      kind: 'state-reset',
      title: 'Local state needs attention'
    })
  })

  it('persists and exposes only the normalized state-schema result', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)

    await store.mutateTask(task.id, (mutable) => {
      const unsafe = mutable as unknown as Record<string, unknown>
      unsafe.unexpectedAuthority = {
        approval: true,
        valueThatJsonCannotSerialize: 1n
      }
    })

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(persisted.tasks[0]).not.toHaveProperty('unexpectedAuthority')
    expect(store.getTask(task.id)).not.toHaveProperty('unexpectedAuthority')
  })

  it('does not publish a rejected mutation or poison the next transaction', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)

    await expect(
      store.mutateTask(task.id, (mutable) => {
        mutable.title = ''
      })
    ).rejects.toThrow()
    expect(store.getTask(task.id).title).toBe('New task')

    await store.mutateTask(task.id, (mutable) => {
      mutable.title = 'Valid after rejection'
    })
    const restored = new StateStore(filePath)
    await restored.load()
    expect(restored.getTask(task.id).title).toBe('Valid after rejection')
  })

  it('queues non-persistent stream deltas ahead of a later durable flush', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    const item = {
      id: 'streamed-assistant',
      kind: 'message' as const,
      runId: 'stream-run',
      role: 'assistant' as const,
      content: '',
      createdAt: '2026-07-28T12:00:00.000Z'
    }

    const inserted = store.addItem(task.id, item, false)
    item.content = 'caller-owned text that must not be captured'
    const firstDelta = store.updateItem(
      task.id,
      item.id,
      (stored) => {
        if (stored.kind === 'message') stored.content += 'first'
      },
      false
    )
    const secondDelta = store.updateItem(
      task.id,
      item.id,
      (stored) => {
        if (stored.kind === 'message') stored.content += ' second'
      },
      false
    )
    await store.flush()
    await Promise.all([inserted, firstDelta, secondDelta])

    const restored = new StateStore(filePath)
    await restored.load()
    expect(restored.getTask(task.id).items).toMatchObject([
      {
        id: item.id,
        kind: 'message',
        content: 'first second'
      }
    ])
  })

  it('does not quarantine, reset, or publish on an operational write failure', async () => {
    const outerDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'ground-store-')
    )
    const stateDirectory = path.join(outerDirectory, 'state')
    const movedDirectory = path.join(outerDirectory, 'state-preserved')
    const filePath = path.join(stateDirectory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(outerDirectory)

    await rename(stateDirectory, movedDirectory)
    await writeFile(stateDirectory, 'blocks the state directory', 'utf8')
    await expect(
      store.mutateTask(task.id, (mutable) => {
        mutable.title = 'Must not publish'
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/EEXIST|ENOTDIR/u) })
    expect(store.getTask(task.id).title).toBe('New task')

    await unlink(stateDirectory)
    await rename(movedDirectory, stateDirectory)
    expect(
      (await readdir(stateDirectory)).some((name) =>
        name.includes('.unreadable-')
      )
    ).toBe(false)

    await store.mutateTask(task.id, (mutable) => {
      mutable.title = 'Recovered after I/O failure'
    })
    const restored = new StateStore(filePath)
    await restored.load()
    expect(restored.getTask(task.id).title).toBe(
      'Recovered after I/O failure'
    )
    expect(restored.snapshot().recoveryNotice).toBeUndefined()
  })

  it('seals every later mutation after an ambiguous state publication', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'ground-store-uncertain-')
    )
    const filePath = path.join(directory, 'state.json')
    const bootstrap = new StateStore(filePath)
    await bootstrap.load()
    const task = await bootstrap.createTask()
    const uncertainty = new StatePersistenceError(
      Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    )
    const persistStateDocument = vi.fn(
      async (targetPath: string, payload: string) => {
        // Model a successful primary rename followed by a late directory-fsync
        // failure: disk has selected the candidate while memory must not.
        await writeFile(targetPath, payload, { encoding: 'utf8', mode: 0o600 })
        throw uncertainty
      }
    )
    const onPersistenceUncertain = vi.fn()
    const store = new StateStore(filePath, {
      persistStateDocument,
      onPersistenceUncertain
    })
    await store.load()

    await expect(
      store.mutateTask(task.id, (mutable) => {
        mutable.title = 'Disk-selected candidate'
      })
    ).rejects.toBe(uncertainty)

    expect(store.getTask(task.id).title).toBe('New task')
    expect(onPersistenceUncertain).toHaveBeenCalledOnce()
    expect(onPersistenceUncertain).toHaveBeenCalledWith(uncertainty)

    const selectedDiskGeneration = new StateStore(filePath)
    await selectedDiskGeneration.load()
    expect(selectedDiskGeneration.getTask(task.id).title).toBe(
      'Disk-selected candidate'
    )

    await expect(
      store.mutateTask(task.id, (mutable) => {
        mutable.title = 'Must never publish'
      })
    ).rejects.toBe(uncertainty)
    expect(persistStateDocument).toHaveBeenCalledTimes(1)
    expect(onPersistenceUncertain).toHaveBeenCalledTimes(1)
  })

  it('propagates operational load errors without treating them as corruption', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const blockingPath = path.join(directory, 'not-a-directory')
    await writeFile(blockingPath, 'ordinary file', 'utf8')
    const store = new StateStore(path.join(blockingPath, 'state.json'))

    await expect(store.load()).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:EEXIST|ENOTDIR)$/u)
    })
    expect(store.snapshot().recoveryNotice).toBeUndefined()
    expect(await readdir(directory)).toEqual(['not-a-directory'])
  })

  it('rejects an oversized state file before reading it into memory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    await writeFile(filePath, '')
    await truncate(filePath, 128 * 1024 * 1024 + 1)

    const store = new StateStore(filePath)
    await store.load()

    expect(store.snapshot().tasks).toEqual([])
    expect(store.snapshot().recoveryNotice?.kind).toBe('state-reset')
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('state.json.unreadable-')
      )
    ).toBe(true)
  })

  it('rotates the previous valid state into a local backup before replacing it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    await store.mutateTask(task.id, (mutable) => {
      mutable.title = 'Latest title'
    })

    const primary = JSON.parse(await readFile(filePath, 'utf8')) as {
      tasks: Array<{ title: string }>
    }
    const backup = JSON.parse(await readFile(`${filePath}.bak`, 'utf8')) as {
      tasks: Array<{ title: string }>
    }

    expect(primary.tasks[0]?.title).toBe('Latest title')
    expect(backup.tasks[0]?.title).toBe('New task')
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      expect((await stat(`${filePath}.bak`)).mode & 0o777).toBe(0o600)
    }
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
  })

  it('retains three generations of validated local state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    for (const title of ['First', 'Second', 'Third']) {
      await store.mutateTask(task.id, (mutable) => {
        mutable.title = title
      })
    }

    const titles = await Promise.all(
      [
        filePath,
        `${filePath}.bak`,
        `${filePath}.bak.2`,
        `${filePath}.bak.3`
      ].map(async (candidate) => {
        const state = JSON.parse(await readFile(candidate, 'utf8')) as {
          tasks: Array<{ title: string }>
        }
        return state.tasks[0]?.title
      })
    )
    expect(titles).toEqual(['Third', 'Second', 'First', 'New task'])
  })

  it('lists current and retained snapshots with opaque bounded metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    await store.mutateTask(task.id, (mutable) => {
      mutable.title = 'First'
    })

    const snapshots = await store.listLocalStateSnapshots()

    expect(snapshots).toHaveLength(4)
    expect(snapshots.map((snapshot) => snapshot.generation)).toEqual([
      0, 1, 2, 3
    ])
    expect(snapshots.map((snapshot) => snapshot.kind)).toEqual([
      'current',
      'retained',
      'retained',
      'retained'
    ])
    expect(snapshots[0]).toMatchObject({
      status: 'valid',
      taskCount: 1,
      providerCount: 1
    })
    expect(snapshots[0]?.id).toMatch(
      /^state_snapshot_[0-9a-f-]{36}$/u
    )
    expect(snapshots[0]).not.toHaveProperty('filePath')
    expect(snapshots[3]).toMatchObject({ status: 'unavailable' })
    expect(snapshots[3]).not.toHaveProperty('capturedAt')

    snapshots[0]!.status = 'invalid'
    const refreshed = await store.listLocalStateSnapshots()
    expect(refreshed[0]?.status).toBe('valid')
  })

  it('exports the exact validated generation without credential material', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const exportPath = path.join(directory, 'selected.ground-state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    for (const title of ['First', 'Second', 'Third']) {
      await store.mutateTask(task.id, (mutable) => {
        mutable.title = title
      })
    }
    const snapshots = await store.listLocalStateSnapshots()
    const selected = snapshots.find(
      (snapshot) => snapshot.generation === 2
    )
    expect(selected?.status).toBe('valid')

    await store.exportLocalStateSnapshot(selected!.id, exportPath)

    const exportedText = await readFile(exportPath, 'utf8')
    const exported = JSON.parse(exportedText) as {
      version: number
      tasks: Array<{ title: string }>
    }
    expect(exported.version).toBe(2)
    expect(exported.tasks[0]?.title).toBe('First')
    expect(exportedText).not.toContain('apiKey')
    expect(exportedText).not.toContain('ground-secrets')
    if (process.platform !== 'win32') {
      expect((await stat(exportPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects traversal, corrupt generations, and selections that changed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const targetPath = path.join(directory, 'should-not-exist.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    await store.mutateTask(task.id, (mutable) => {
      mutable.title = 'First'
    })

    await expect(
      store.exportLocalStateSnapshot('../../state.json', targetPath)
    ).rejects.toThrow('identifier')
    await writeFile(`${filePath}.bak`, '{"version":2,"tasks":', 'utf8')
    const withCorruption = await store.listLocalStateSnapshots()
    const corrupt = withCorruption.find(
      (snapshot) => snapshot.generation === 1
    )
    expect(corrupt).toEqual(
      expect.objectContaining({
        status: 'invalid',
        capturedAt: expect.any(String),
        sizeBytes: expect.any(Number)
      })
    )
    expect(corrupt).not.toHaveProperty('detail')
    await expect(
      store.exportLocalStateSnapshot(corrupt!.id, targetPath)
    ).rejects.toThrow('not available')

    const validCurrent = withCorruption[0]!
    await store.mutateTask(task.id, (mutable) => {
      mutable.title = 'Changed after selection'
    })
    await expect(
      store.exportLocalStateSnapshot(validCurrent.id, targetPath)
    ).rejects.toThrow('changed or became unavailable')
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform !== 'win32')(
    'does not follow a retained-snapshot symlink during listing or export',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
      const filePath = path.join(directory, 'state.json')
      const targetPath = path.join(directory, 'export.json')
      const store = new StateStore(filePath)
      await store.load()
      await store.createTask(directory)

      const outsidePath = path.join(directory, 'outside.json')
      const outsideStore = new StateStore(outsidePath)
      await outsideStore.load()
      const outsideTask = await outsideStore.createTask(directory)
      await outsideStore.mutateTask(outsideTask.id, (mutable) => {
        mutable.title = 'Must never be selected'
      })
      const outsideContents = await readFile(outsidePath, 'utf8')

      await unlink(`${filePath}.bak`)
      await symlink(outsidePath, `${filePath}.bak`)
      const snapshots = await store.listLocalStateSnapshots()
      const linked = snapshots.find(
        (snapshot) => snapshot.generation === 1
      )!

      expect(linked.status).toBe('invalid')
      expect(linked).not.toHaveProperty('taskCount')
      await expect(
        store.exportLocalStateSnapshot(linked.id, targetPath)
      ).rejects.toThrow('not available')
      expect(await readFile(outsidePath, 'utf8')).toBe(outsideContents)
      await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('migrates a validated version-1 retained snapshot during restore', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    await store.createTask(directory)
    const retainedPath = `${filePath}.bak`
    const retained = JSON.parse(await readFile(retainedPath, 'utf8')) as {
      version: number
    }
    retained.version = 1
    await writeFile(retainedPath, JSON.stringify(retained), {
      encoding: 'utf8',
      mode: 0o600
    })
    const snapshots = await store.listLocalStateSnapshots()
    const versionOne = snapshots.find(
      (snapshot) => snapshot.generation === 1
    )!

    expect(versionOne.status).toBe('valid')
    await store.restoreLocalStateSnapshot(versionOne.id)

    const restored = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
    }
    expect(restored.version).toBe(2)
  })

  it('restores only the selected retained snapshot and rotates current state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    for (const title of ['First', 'Second', 'Third']) {
      await store.mutateTask(task.id, (mutable) => {
        mutable.title = title
      })
    }
    const snapshots = await store.listLocalStateSnapshots()
    const current = snapshots[0]!
    const selected = snapshots.find(
      (snapshot) => snapshot.generation === 2
    )!

    await expect(
      store.restoreLocalStateSnapshot(current.id)
    ).rejects.toThrow('retained')
    await store.restoreLocalStateSnapshot(selected.id)

    expect(store.getTask(task.id).title).toBe('First')
    const titles = await Promise.all(
      [
        filePath,
        `${filePath}.bak`,
        `${filePath}.bak.2`,
        `${filePath}.bak.3`
      ].map(async (candidate) => {
        const state = JSON.parse(await readFile(candidate, 'utf8')) as {
          tasks: Array<{ title: string }>
        }
        return state.tasks[0]?.title
      })
    )
    expect(titles).toEqual(['First', 'Third', 'Second', 'First'])
    await expect(
      store.restoreLocalStateSnapshot(selected.id)
    ).rejects.toThrow('expired')
  })

  it('recovers interrupted markers while restoring a retained snapshot', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const task = await store.createTask(directory)
    await store.mutateTask(task.id, (mutable) => {
      mutable.runStatus = 'running'
      mutable.items.push({
        id: 'pending-restored-approval',
        kind: 'activity',
        runId: 'restored-run',
        activityType: 'approval',
        title: 'Approve restored action',
        status: 'pending',
        approvalId: 'stale-restored-approval',
        createdAt: '2026-07-28T12:00:00.000Z'
      })
    })
    await store.mutateTask(task.id, (mutable) => {
      mutable.runStatus = 'idle'
      const activity = mutable.items[0]
      if (activity?.kind === 'activity') {
        activity.status = 'success'
        delete activity.approvalId
      }
    })
    const snapshots = await store.listLocalStateSnapshots()
    const interrupted = snapshots.find(
      (snapshot) => snapshot.generation === 1
    )!

    await store.restoreLocalStateSnapshot(interrupted.id)

    const restored = store.getTask(task.id)
    expect(restored.runStatus).toBe('failed')
    expect(restored.items[0]).toMatchObject({
      kind: 'activity',
      status: 'error'
    })
    expect(restored.items[0]).not.toHaveProperty('approvalId')
    expect(restored.items.at(-1)).toMatchObject({
      kind: 'activity',
      activityType: 'error',
      title: 'Run interrupted'
    })
  })

  it('falls back through corrupt retained backups to the oldest valid generation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const first = new StateStore(filePath)
    await first.load()
    const task = await first.createTask(directory)
    for (const title of ['First', 'Second', 'Third']) {
      await first.mutateTask(task.id, (mutable) => {
        mutable.title = title
      })
    }
    await Promise.all(
      [filePath, `${filePath}.bak`, `${filePath}.bak.2`].map((candidate) =>
        writeFile(candidate, '{"version":1,"tasks":', 'utf8')
      )
    )

    const recovered = new StateStore(filePath)
    await recovered.load()

    expect(recovered.getTask(task.id).title).toBe('New task')
    expect(recovered.snapshot().recoveryNotice?.kind).toBe('backup-restored')
    const entries = await readdir(directory)
    expect(
      entries.filter((name) => name.includes('.unreadable-'))
    ).toHaveLength(3)
  })

  it.runIf(process.platform !== 'win32')(
    'does not follow a state-file symlink or alter its target',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
      const outsidePath = path.join(directory, 'outside.json')
      const outsideStore = new StateStore(outsidePath)
      await outsideStore.load()
      await outsideStore.createTask(directory)
      const outsideContents = await readFile(outsidePath, 'utf8')

      const filePath = path.join(directory, 'state.json')
      await symlink(outsidePath, filePath)
      const store = new StateStore(filePath)
      await store.load()

      expect(store.snapshot().tasks).toEqual([])
      expect(store.snapshot().recoveryNotice?.kind).toBe('state-reset')
      expect(await readFile(outsidePath, 'utf8')).toBe(outsideContents)
      expect((await lstat(filePath)).isFile()).toBe(true)
      const quarantined = (await readdir(directory)).find((name) =>
        name.startsWith('state.json.unreadable-')
      )
      expect(quarantined).toBeDefined()
      expect(
        (await lstat(path.join(directory, quarantined as string))).isSymbolicLink()
      ).toBe(true)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'uses unpredictable temporary names instead of following a fixed temp symlink',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
      const filePath = path.join(directory, 'state.json')
      const outsidePath = path.join(directory, 'outside.txt')
      await writeFile(outsidePath, 'leave me alone', 'utf8')
      await symlink(outsidePath, `${filePath}.tmp`)

      const store = new StateStore(filePath)
      await store.load()
      await store.createTask(directory)

      expect(await readFile(outsidePath, 'utf8')).toBe('leave me alone')
      expect((await lstat(`${filePath}.tmp`)).isSymbolicLink()).toBe(true)
    }
  )

  it('restores the last known-good backup and quarantines a corrupt primary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const first = new StateStore(filePath)
    await first.load()
    const task = await first.createTask(directory)
    await first.mutateTask(task.id, (mutable) => {
      mutable.title = 'Newest state'
    })
    await writeFile(filePath, '{"version":1,"tasks":')

    const recovered = new StateStore(filePath)
    await recovered.load()

    expect(recovered.getTask(task.id).title).toBe('New task')
    expect(recovered.snapshot().recoveryNotice).toMatchObject({
      kind: 'backup-restored',
      title: 'Recovered local history'
    })
    expect(recovered.shouldDeferPendingSecretDeletes()).toBe(true)
    recovered.addRecoveryNotice({
      id: 'credential-warning:combined',
      kind: 'credential-warning',
      title: 'Saved credentials need attention',
      detail: 'Credential warning'
    })
    expect(recovered.shouldDeferPendingSecretDeletes()).toBe(true)
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith('state.json.unreadable-')
      )
    ).toBe(true)
  })

  it('recovers from the backup when an interrupted atomic replace leaves no primary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const first = new StateStore(filePath)
    await first.load()
    const task = await first.createTask(directory)
    await first.mutateTask(task.id, (mutable) => {
      mutable.title = 'State after backup'
    })
    await rename(filePath, `${filePath}.missing-simulation`)

    const recovered = new StateStore(filePath)
    await recovered.load()

    expect(recovered.getTask(task.id).title).toBe('New task')
    expect(recovered.snapshot().recoveryNotice?.kind).toBe('backup-restored')
  })

  it('merges recovery notices by severity without persisting or duplicating them', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ground-store-'))
    const filePath = path.join(directory, 'state.json')
    const store = new StateStore(filePath)
    await store.load()
    const credentialNotice: RecoveryNotice = {
      id: 'credential-warning:test',
      kind: 'credential-warning',
      title: 'Saved credentials need attention',
      detail: 'Re-enter affected credentials.'
    }
    store.addRecoveryNotice(credentialNotice)
    store.addRecoveryNotice(credentialNotice)
    await store.createTask(directory)
    const stateNotice: RecoveryNotice = {
      id: 'state-reset:test',
      kind: 'state-reset',
      title: 'Local state needs attention',
      detail: 'State was reset.'
    }
    store.addRecoveryNotice(stateNotice)

    const snapshot = store.snapshot()
    expect(snapshot.recoveryNotice).toMatchObject({
      kind: 'state-reset',
      title: 'Local data needs attention'
    })
    expect(snapshot.recoveryNotice?.detail).toContain(
      'Re-enter affected credentials.'
    )
    expect(snapshot.recoveryNotice?.detail).toContain('State was reset.')
    expect(
      snapshot.recoveryNotice?.detail.match(/Re-enter affected credentials\./gu)
    ).toHaveLength(1)

    if (snapshot.recoveryNotice) snapshot.recoveryNotice.detail = 'mutated'
    expect(store.snapshot().recoveryNotice?.detail).not.toBe('mutated')

    const reloaded = new StateStore(filePath)
    await reloaded.load()
    expect(reloaded.snapshot().recoveryNotice).toBeUndefined()
  })
})
