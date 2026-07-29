import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StateSnapshot } from './store'
import {
  projectDesktopTaskOperation,
  toDesktopSnapshot,
  toDesktopTask
} from './desktop-projection'
import { WorkspaceGrantRegistry } from './trust-boundary'

function stateTask(workspacePath: string) {
  const timestamp = '2026-07-29T00:00:00.000Z'
  return {
    id: 'task-1',
    title: 'Protected workspace',
    workspacePath,
    providerId: 'provider-1',
    mode: 'agent' as const,
    includeImportedHistory: true,
    runStatus: 'idle' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    runtimeSessions: {
      'provider-1': {
        adapter: 'codex' as const,
        sessionId: 'native-secret-session',
        providerRevision: timestamp,
        workspacePath,
        mode: 'agent' as const,
        updatedAt: timestamp
      }
    },
    modelSessions: {
      'provider-1': {
        adapterId: 'openai.responses',
        providerRevision: timestamp,
        model: 'model',
        workspacePath,
        mode: 'agent' as const,
        conversation: [],
        checkpoint: { privateContinuation: 'provider-owned' },
        updatedAt: timestamp
      }
    },
    items: []
  }
}

describe('desktop task projection', () => {
  it('allowlists renderer fields and replaces every structural path with one opaque grant', async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), 'ground-projection-')
    )
    const grants = new WorkspaceGrantRegistry()
    const grant = await grants.grant(workspacePath)
    const projected = toDesktopTask(stateTask(workspacePath), grants)
    const serialized = JSON.stringify(projected)

    expect(projected).toMatchObject({
      id: 'task-1',
      includeImportedHistory: true,
      workspace: grant
    })
    expect(projected).not.toHaveProperty('workspacePath')
    expect(projected).not.toHaveProperty('runtimeSessions')
    expect(projected).not.toHaveProperty('modelSessions')
    expect(serialized).not.toContain(workspacePath)
    expect(serialized).not.toContain('native-secret-session')
    expect(serialized).not.toContain('provider-owned')
  })

  it('uses the same process-scoped grant for shared paths and no authority for unrestored paths', async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), 'ground-projection-shared-')
    )
    const grants = new WorkspaceGrantRegistry()
    await grants.grant(workspacePath)
    const first = stateTask(workspacePath)
    const second = {
      ...stateTask(workspacePath),
      id: 'task-2'
    }
    const missing = {
      ...stateTask(path.join(workspacePath, 'missing')),
      id: 'task-3'
    }
    const state: StateSnapshot = {
      providers: [
        {
          id: 'provider-1',
          name: 'Local',
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'model',
          hasApiKey: false,
          supportsTools: true,
          createdAt: first.createdAt,
          updatedAt: first.updatedAt
        }
      ],
      mcpServers: [],
      tasks: [first, second, missing],
      settings: {
        defaultProviderId: 'provider-1',
        sidebarCollapsed: false
      }
    }

    const projected = toDesktopSnapshot(state, grants)
    expect(projected.tasks[0]?.workspace?.id).toBe(
      projected.tasks[1]?.workspace?.id
    )
    expect(projected.tasks[2]?.workspace).toBeUndefined()
  })

  it('projects every task-returning operation through the same boundary', async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), 'ground-projection-operation-')
    )
    const grants = new WorkspaceGrantRegistry()
    await grants.grant(workspacePath)
    const internal = stateTask(workspacePath)
    const projectedOperation = projectDesktopTaskOperation(
      grants,
      async (include: boolean) => (include ? internal : undefined)
    )

    const projected = await projectedOperation(true)
    expect(projected).toMatchObject({
      id: internal.id,
      workspace: { name: path.basename(workspacePath) }
    })
    expect(projected).not.toHaveProperty('workspacePath')
    expect(projected).not.toHaveProperty('runtimeSessions')
    expect(projected).not.toHaveProperty('modelSessions')
    expect(JSON.stringify(projected)).not.toContain('native-secret-session')
    await expect(projectedOperation(false)).resolves.toBeUndefined()
  })
})
