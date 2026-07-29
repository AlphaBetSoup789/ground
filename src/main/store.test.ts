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
import { describe, expect, it } from 'vitest'
import type { ModelApiProvider } from '../shared/types'
import { StateStore } from './store'
import type { GroundTaskImportTemplate } from './task-portability'

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
          adapter: 'codex',
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
})
