import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  ActivityItem,
  RunEvent,
  Task
} from '../shared/types'
import type { StateSnapshot } from './store'
import {
  projectDesktopTaskOperation,
  toDesktopRunEventEnvelope,
  toDesktopSnapshot,
  toDesktopTask
} from './desktop-projection'
import { WorkspaceGrantRegistry } from './trust-boundary'

const ACTION_SHA256 = 'a'.repeat(64)
const APPROVAL_SHA256 = 'b'.repeat(64)

function managedActivity(): ActivityItem {
  const timestamp = '2026-07-29T00:00:00.000Z'
  return {
    id: 'operation-secret',
    kind: 'activity',
    runId: 'run-1',
    activityType: 'tool',
    title: 'Write a file',
    status: 'success',
    createdAt: timestamp,
    toolName: 'write_file',
    callId: 'call-1',
    managedExecution: {
      version: 1,
      claim: 'approved',
      phase: 'completed',
      operationId: 'operation-secret',
      kind: 'workspace-write',
      actionSha256: ACTION_SHA256,
      approvalSha256: APPROVAL_SHA256,
      startedAt: timestamp,
      completedAt: timestamp
    }
  }
}

function stateTask(workspacePath: string): Task {
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
    items: [managedActivity()]
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
    expect(projected.items[0]).not.toHaveProperty('managedExecution')
    expect(serialized).not.toContain(workspacePath)
    expect(serialized).not.toContain('native-secret-session')
    expect(serialized).not.toContain('provider-owned')
    expect(serialized).not.toContain(ACTION_SHA256)
    expect(serialized).not.toContain(APPROVAL_SHA256)
    expect(serialized).not.toContain('"operationId"')
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

  it('strips managed execution evidence from live and replayed run events', () => {
    const activity = managedActivity()
    const events: RunEvent[] = [
      {
        type: 'item-added',
        taskId: 'task-1',
        runId: activity.runId,
        item: activity
      },
      {
        type: 'item-updated',
        taskId: 'task-1',
        runId: activity.runId,
        item: activity
      },
      {
        type: 'approval-requested',
        taskId: 'task-1',
        runId: activity.runId,
        item: activity
      }
    ]

    for (const [index, event] of events.entries()) {
      const projected = toDesktopRunEventEnvelope({
        revision: index + 1,
        event
      })
      const serialized = JSON.stringify(projected)
      expect(projected.event).toHaveProperty('item')
      expect(
        (projected.event as { item: object }).item
      ).not.toHaveProperty('managedExecution')
      expect(serialized).not.toContain(ACTION_SHA256)
      expect(serialized).not.toContain(APPROVAL_SHA256)
      expect(serialized).not.toContain('"operationId"')
    }

    expect(activity.managedExecution).toBeDefined()
  })
})
