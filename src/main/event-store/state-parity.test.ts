import { describe, expect, it } from 'vitest'
import type {
  ActivityItem,
  McpServerProfile,
  ProviderProfile,
  Task
} from '../../shared/types'
import type { PersistedStateData } from '../state-schema'
import { sha256 } from './index'
import type { StateMutation } from './state-mutation-plan'
import { StateParity, withStateParity } from './state-parity'

/**
 * Parity scenarios for the production SQLite cutover.
 *
 * Each scenario drives the real `StateStore` and the ledger through the same
 * product operations and compares canonical state after every commit. The
 * scenarios are grouped by the domains the cutover has to carry over intact:
 * tasks, providers and their secret references, MCP servers, settings, and
 * managed execution — including the compound, refused, and interrupted paths
 * that a naive one-event-per-call translation gets wrong.
 */

const TIMESTAMP = '2026-07-31T12:00:00.000Z'
const ACTION_SHA = sha256('action')
const APPROVAL_SHA = sha256('approval')

function provider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider_local',
    name: 'Local',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'test-model',
    hasApiKey: false,
    supportsTools: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides
  } as ProviderProfile
}

function mcpServer(overrides: Partial<McpServerProfile> = {}): McpServerProfile {
  return {
    id: 'server_docs',
    name: 'Docs',
    namespace: 'docs',
    enabled: true,
    trustedFingerprints: {},
    transport: 'stdio',
    command: 'docs-server',
    args: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides
  } as McpServerProfile
}

function initialState(
  overrides: Partial<PersistedStateData> = {}
): PersistedStateData {
  return {
    version: 2,
    providers: [provider(), provider({ id: 'provider_second', name: 'Second' })],
    mcpServers: [],
    tasks: [],
    settings: {
      defaultProviderId: 'provider_local',
      sidebarCollapsed: false
    },
    pendingSecretDeletes: [],
    ...overrides
  } as PersistedStateData
}

/** Mirrors the shape `StateStore` records so the plan names the same facts. */
function createTaskStep(): {
  name: string
  apply: (store: import('../store').StateStore) => Promise<StateMutation>
} {
  return {
    name: 'create-task',
    apply: async (store) => {
      const task = await store.createTask()
      return { kind: 'create-task', task }
    }
  }
}

function pendingApproval(runId: string, callId: string): ActivityItem {
  return {
    id: 'activity_approval',
    kind: 'activity',
    runId,
    callId,
    activityType: 'approval',
    approvalId: 'approval_1',
    toolName: 'run_command',
    title: 'Run a command',
    status: 'pending',
    createdAt: TIMESTAMP
  } as ActivityItem
}

describe('JSON and SQLite state parity', () => {
  it('keeps a whole task lifecycle in step', async () => {
    await withStateParity(initialState(), async (parity) => {
      let created: Task | undefined

      await parity.commit({
        name: 'create the first task',
        apply: async (store) => {
          created = await store.createTask('/workspace/one')
          return { kind: 'create-task', task: created }
        }
      })

      const taskId = created!.id

      await parity.commit({
        name: 'rename the task',
        apply: async (store) => {
          const task = await store.mutateTask(taskId, (mutable) => {
            mutable.title = 'Reviewed task'
          })
          return {
            kind: 'patch-task',
            taskId,
            updatedAt: task.updatedAt,
            patch: { title: 'Reviewed task' }
          }
        }
      })

      await parity.commit({
        name: 'create a second task',
        apply: async (store) => {
          const task = await store.createTask()
          return { kind: 'create-task', task }
        }
      })

      await parity.commit({
        name: 'reselect the first task',
        apply: async (store) => {
          await store.selectTask(taskId)
          return { kind: 'select-task', taskId }
        }
      })

      await parity.commit({
        name: 'fork the first task',
        apply: async (store) => {
          const forked = await store.forkTask(taskId)
          return { kind: 'fork-task', sourceTaskId: taskId, task: forked }
        }
      })

      await parity.commit({
        name: 'delete the first task',
        apply: async (store) => {
          await store.deleteTask(taskId)
          return { kind: 'delete-task', taskId }
        }
      })
    })
  })

  it('carries the selection move that archiving performs in the same commit', async () => {
    await withStateParity(initialState(), async (parity) => {
      const first = await createdTask(parity)
      const second = await createdTask(parity)

      // The newest task is selected, so archiving it must also move the
      // selection — two events in one batch.
      await parity.commit({
        name: 'archive the selected task',
        apply: async (store) => {
          const task = await store.setTaskArchived(second, true)
          return {
            kind: 'set-task-archived',
            taskId: second,
            updatedAt: task.updatedAt,
            archived: true,
            archivedAt: task.archivedAt ?? null
          }
        }
      })

      await parity.commit({
        name: 'archive the remaining task, leaving nothing selected',
        apply: async (store) => {
          const task = await store.setTaskArchived(first, true)
          return {
            kind: 'set-task-archived',
            taskId: first,
            updatedAt: task.updatedAt,
            archived: true,
            archivedAt: task.archivedAt ?? null
          }
        }
      })

      await parity.commit({
        name: 'unarchive, which reselects the task',
        apply: async (store) => {
          const task = await store.setTaskArchived(first, false)
          return {
            kind: 'set-task-archived',
            taskId: first,
            updatedAt: task.updatedAt,
            archived: false,
            archivedAt: null
          }
        }
      })
    })
  })

  it('plans a compound field patch as one batch of per-field facts', async () => {
    await withStateParity(initialState(), async (parity) => {
      const taskId = await createdTask(parity)

      await parity.commit({
        name: 'change title, mode, provider and workspace at once',
        apply: async (store) => {
          const task = await store.mutateTask(taskId, (mutable) => {
            mutable.title = 'Compound change'
            mutable.mode = 'ask'
            mutable.providerId = 'provider_second'
            mutable.workspacePath = '/workspace/compound'
          })
          return {
            kind: 'patch-task',
            taskId,
            updatedAt: task.updatedAt,
            patch: {
              title: 'Compound change',
              mode: 'ask',
              providerId: 'provider_second',
              workspacePath: '/workspace/compound'
            }
          }
        }
      })

      // Pull `defaultProviderId` away from the first task's provider, so a
      // redundant `task.provider-set` would be visible rather than masked by a
      // default that already happens to match.
      let second = ''
      await parity.commit({
        name: 'create a second task on the other provider',
        apply: async (store) => {
          const task = await store.createTask()
          second = task.id
          return { kind: 'create-task', task }
        }
      })
      await parity.commit({
        name: 'move the second task back to the first provider',
        apply: async (store) => {
          const task = await store.mutateTask(second, (mutable) => {
            mutable.providerId = 'provider_local'
          })
          return {
            kind: 'patch-task',
            taskId: second,
            updatedAt: task.updatedAt,
            patch: { providerId: 'provider_local' }
          }
        }
      })

      // `defaultProviderId` is now `provider_local` while the first task still
      // points at `provider_second`. Re-applying the first task's existing
      // values must not re-promote its provider to the default.
      await parity.commit({
        name: 'reapply identical values',
        apply: async (store) => {
          const task = await store.mutateTask(taskId, (mutable) => {
            mutable.title = 'Compound change'
            mutable.providerId = 'provider_second'
          })
          return {
            kind: 'patch-task',
            taskId,
            updatedAt: task.updatedAt,
            patch: { title: 'Compound change', providerId: 'provider_second' }
          }
        }
      })

      const midpoint = JSON.parse(parity.canonicalState()) as PersistedStateData
      expect(midpoint.settings.defaultProviderId).toBe('provider_local')

      await parity.commit({
        name: 'clear the workspace path',
        apply: async (store) => {
          const task = await store.mutateTask(taskId, (mutable) => {
            delete mutable.workspacePath
          })
          return {
            kind: 'patch-task',
            taskId,
            updatedAt: task.updatedAt,
            patch: { workspacePath: null }
          }
        }
      })
    })
  })

  it('keeps provider deletion cascades and secret references in step', async () => {
    await withStateParity(initialState(), async (parity) => {
      const taskId = await createdTask(parity)

      await parity.commit({
        name: 'point the task at the provider that will be deleted',
        apply: async (store) => {
          const task = await store.mutateTask(taskId, (mutable) => {
            mutable.providerId = 'provider_second'
          })
          return {
            kind: 'patch-task',
            taskId,
            updatedAt: task.updatedAt,
            patch: { providerId: 'provider_second' }
          }
        }
      })

      await parity.commit({
        name: 'queue a provisional secret delete',
        apply: async (store) => {
          await store.queueProvisionalSecretDelete('secret_staged')
          return {
            kind: 'queue-provisional-secret-delete',
            reference: 'secret_staged'
          }
        }
      })

      await parity.commit({
        name: 'queue the same reference again',
        apply: async (store) => {
          await store.queueProvisionalSecretDelete('secret_staged')
          return {
            kind: 'queue-provisional-secret-delete',
            reference: 'secret_staged'
          }
        }
      })

      await parity.commit({
        name: 'publish a secret transition that clears the staged reference',
        apply: async (store) => {
          const updated = provider({
            id: 'provider_second',
            name: 'Second',
            hasApiKey: true,
            updatedAt: '2026-07-31T13:00:00.000Z'
          })
          await store.publishProviderSecretTransition(updated, 'secret_staged', [
            'secret_old_a',
            'secret_old_b'
          ])
          return {
            kind: 'publish-provider-secret-transition',
            provider: updated,
            stagedReference: 'secret_staged',
            obsoleteReferences: ['secret_old_a', 'secret_old_b']
          }
        }
      })

      await parity.commit({
        name: 'acknowledge one of the obsolete references',
        apply: async (store) => {
          await store.acknowledgeSecretDeletes(['secret_old_a'])
          return {
            kind: 'acknowledge-secret-deletes',
            references: ['secret_old_a']
          }
        }
      })

      // Deleting the task's provider must reassign the task and the default.
      await parity.commit({
        name: 'delete the provider with its remaining secret references',
        apply: async (store) => {
          await store.deleteProviderWithSecretTransition('provider_second', [
            'secret_old_b',
            'secret_final'
          ])
          return {
            kind: 'delete-provider-with-secret-transition',
            providerId: 'provider_second',
            obsoleteReferences: ['secret_old_b', 'secret_final']
          }
        }
      })

      const state = JSON.parse(parity.canonicalState()) as PersistedStateData
      expect(state.providers).toHaveLength(1)
      expect(state.tasks[0]?.providerId).toBe('provider_local')
      expect(state.settings.defaultProviderId).toBe('provider_local')
    })
  })

  it('treats a deletion the store ignores as a no-op on both sides', async () => {
    await withStateParity(initialState(), async (parity) => {
      // The store returns without touching state — including without recording
      // the obsolete references it was handed.
      await parity.commit({
        name: 'delete an unknown provider',
        apply: async (store) => {
          await store.deleteProviderWithSecretTransition('provider_missing', [
            'secret_never_queued'
          ])
          return {
            kind: 'delete-provider-with-secret-transition',
            providerId: 'provider_missing',
            obsoleteReferences: ['secret_never_queued']
          }
        }
      })

      await parity.commit({
        name: 'acknowledge references that were never pending',
        apply: async (store) => {
          await store.acknowledgeSecretDeletes(['secret_never_queued'])
          return {
            kind: 'acknowledge-secret-deletes',
            references: ['secret_never_queued']
          }
        }
      })

      const state = JSON.parse(parity.canonicalState()) as PersistedStateData
      expect(state.pendingSecretDeletes).toEqual([])
      expect(state.providers).toHaveLength(2)
    })
  })

  it('refuses the same operations on both sides without moving the ledger', async () => {
    await withStateParity(
      initialState({ providers: [provider()] }),
      async (parity) => {
        await parity.rejects({
          name: 'delete the last remaining provider',
          expect: /Keep at least one provider connected/u,
          apply: (store) => store.deleteProvider('provider_local'),
          plan: () => ({ kind: 'delete-provider', providerId: 'provider_local' })
        })

        await parity.rejects({
          name: 'delete an unknown MCP server',
          expect: /MCP server not found/u,
          apply: (store) => store.deleteMcpServer('server_missing'),
          plan: () => ({ kind: 'delete-mcp-server', serverId: 'server_missing' })
        })
      }
    )
  })

  it('keeps MCP server saves, updates and deletes in step', async () => {
    await withStateParity(initialState(), async (parity) => {
      await parity.commit({
        name: 'save a server',
        apply: async (store) => {
          const saved = await store.saveMcpServer(mcpServer())
          return { kind: 'save-mcp-server', server: saved }
        }
      })

      await parity.commit({
        name: 'update the same server',
        apply: async (store) => {
          const saved = await store.saveMcpServer(
            mcpServer({ name: 'Docs v2', enabled: false })
          )
          return { kind: 'save-mcp-server', server: saved }
        }
      })

      await parity.commit({
        name: 'save a second server',
        apply: async (store) => {
          const saved = await store.saveMcpServer(
            mcpServer({ id: 'server_search', name: 'Search', namespace: 'search' })
          )
          return { kind: 'save-mcp-server', server: saved }
        }
      })

      await parity.commit({
        name: 'delete the first server',
        apply: async (store) => {
          await store.deleteMcpServer('server_docs')
          return { kind: 'delete-mcp-server', serverId: 'server_docs' }
        }
      })
    })
  })

  it('keeps a managed execution from approval through completion', async () => {
    await withStateParity(initialState(), async (parity) => {
      const taskId = await createdTask(parity)
      const approval = pendingApproval('run_1', 'call_1')

      await parity.commit({
        name: 'append the pending approval',
        apply: async (store) => {
          await store.addItem(taskId, approval)
          return {
            kind: 'append-task-item',
            taskId,
            updatedAt: store.getTask(taskId).updatedAt,
            item: approval
          }
        }
      })

      await parity.commit({
        name: 'await approval',
        apply: async (store) => {
          const task = await store.mutateTask(taskId, (mutable) => {
            mutable.runStatus = 'awaiting-approval'
          })
          return {
            kind: 'patch-task',
            taskId,
            updatedAt: task.updatedAt,
            patch: { runStatus: 'awaiting-approval' }
          }
        }
      })

      await parity.commit({
        name: 'begin the managed execution',
        apply: async (store) => {
          await store.beginManagedExecution({
            taskId,
            itemId: approval.id,
            runId: 'run_1',
            callId: 'call_1',
            toolName: 'run_command',
            kind: 'command',
            actionSha256: ACTION_SHA,
            approvalSha256: APPROVAL_SHA,
            startedAt: TIMESTAMP
          })
          return {
            kind: 'begin-managed-execution',
            taskId,
            updatedAt: store.getTask(taskId).updatedAt,
            itemId: approval.id,
            runId: 'run_1',
            callId: 'call_1',
            toolName: 'run_command',
            executionKind: 'command',
            actionSha256: ACTION_SHA,
            approvalSha256: APPROVAL_SHA,
            startedAt: TIMESTAMP
          }
        }
      })

      await parity.commit({
        name: 'complete the managed execution',
        apply: async (store) => {
          await store.completeManagedExecution({
            taskId,
            itemId: approval.id,
            operationId: approval.id,
            actionSha256: ACTION_SHA,
            status: 'success',
            result: 'done',
            durationMs: 1_200,
            completedAt: '2026-07-31T12:01:00.000Z'
          })
          return {
            kind: 'complete-managed-execution',
            taskId,
            updatedAt: store.getTask(taskId).updatedAt,
            itemId: approval.id,
            operationId: approval.id,
            actionSha256: ACTION_SHA,
            status: 'success',
            result: 'done',
            durationMs: 1_200,
            completedAt: '2026-07-31T12:01:00.000Z'
          }
        }
      })

      const state = JSON.parse(parity.canonicalState()) as PersistedStateData
      const item = state.tasks[0]?.items[0]
      expect(item?.kind === 'activity' && item.managedExecution?.phase).toBe(
        'completed'
      )
    })
  })

  it('refuses to complete a managed execution twice on either side', async () => {
    await withStateParity(initialState(), async (parity) => {
      const taskId = await createdTask(parity)
      const approval = pendingApproval('run_1', 'call_1')
      await startedExecution(parity, taskId, approval)

      const completion = {
        taskId,
        itemId: approval.id,
        operationId: approval.id,
        actionSha256: ACTION_SHA,
        status: 'success' as const,
        result: 'done',
        durationMs: 5,
        completedAt: '2026-07-31T12:01:00.000Z'
      }

      await parity.commit({
        name: 'complete once',
        apply: async (store) => {
          await store.completeManagedExecution(completion)
          return {
            kind: 'complete-managed-execution',
            ...completion,
            updatedAt: store.getTask(taskId).updatedAt
          }
        }
      })

      // The ledger would reject the replay in its reducer, so the planner has
      // nothing to refuse — the JSON store is the authority for this guard.
      await expect(
        parity.jsonStore.completeManagedExecution(completion)
      ).rejects.toThrow(/not an exact started claim/u)
    })
  })

  it('keeps an interrupted managed execution in step', async () => {
    await withStateParity(initialState(), async (parity) => {
      const taskId = await createdTask(parity)
      const approval = pendingApproval('run_1', 'call_1')
      await startedExecution(parity, taskId, approval)

      // `StateStore` reaches the uncertain phase through load-time recovery
      // rather than a mutation, so the parity check here is that the ledger's
      // own interruption event produces the same activity state the recovery
      // path produces: status `error` and phase `uncertain`.
      await parity.commit({
        name: 'interrupt the started execution',
        apply: async (store) => {
          const updated = await store.updateItem(
            taskId,
            approval.id,
            (item) => {
              if (item.kind !== 'activity') return
              item.status = 'error'
              item.managedExecution = {
                ...item.managedExecution!,
                phase: 'uncertain',
                interruptedAt: '2026-07-31T12:02:00.000Z'
              }
            }
          )
          expect(updated.kind).toBe('activity')
          return {
            kind: 'interrupt-managed-execution',
            taskId,
            updatedAt: store.getTask(taskId).updatedAt,
            itemId: approval.id,
            operationId: approval.id,
            interruptedAt: '2026-07-31T12:02:00.000Z'
          }
        }
      })

      const state = JSON.parse(parity.canonicalState()) as PersistedStateData
      const item = state.tasks[0]?.items[0]
      expect(item?.kind === 'activity' && item.managedExecution?.phase).toBe(
        'uncertain'
      )
      expect(item?.kind === 'activity' && item.status).toBe('error')
    })
  })

  it('finalizes several open activities in one commit', async () => {
    await withStateParity(initialState(), async (parity) => {
      const taskId = await createdTask(parity)
      const activities: ActivityItem[] = [
        {
          id: 'activity_one',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'First',
          status: 'running',
          createdAt: TIMESTAMP
        } as ActivityItem,
        {
          id: 'activity_two',
          kind: 'activity',
          runId: 'run_1',
          activityType: 'tool',
          title: 'Second',
          status: 'pending',
          createdAt: TIMESTAMP
        } as ActivityItem
      ]

      for (const activity of activities) {
        await parity.commit({
          name: `append ${activity.id}`,
          apply: async (store) => {
            await store.addItem(taskId, activity)
            return {
              kind: 'append-task-item',
              taskId,
              updatedAt: store.getTask(taskId).updatedAt,
              item: activity
            }
          }
        })
      }

      await parity.commit({
        name: 'finalize both activities at once',
        apply: async (store) => {
          const task = await store.mutateTask(taskId, (mutable) => {
            for (const item of mutable.items) {
              if (item.kind !== 'activity') continue
              item.status = 'error'
              item.detail = 'The run stopped.'
            }
          })
          return {
            kind: 'update-activities',
            taskId,
            updatedAt: task.updatedAt,
            updates: activities.map((activity) => ({
              itemId: activity.id,
              status: 'error' as const,
              detail: 'The run stopped.'
            }))
          }
        }
      })

      const state = JSON.parse(parity.canonicalState()) as PersistedStateData
      expect(
        state.tasks[0]?.items.every(
          (item) => item.kind === 'activity' && item.status === 'error'
        )
      ).toBe(true)
    })
  })

  it('appends a message and revises its content', async () => {
    await withStateParity(initialState(), async (parity) => {
      const taskId = await createdTask(parity)
      const message = {
        id: 'message_1',
        kind: 'message' as const,
        role: 'assistant' as const,
        content: 'partial',
        createdAt: TIMESTAMP
      }

      await parity.commit({
        name: 'append a streaming message',
        apply: async (store) => {
          await store.addItem(taskId, message)
          return {
            kind: 'append-task-item',
            taskId,
            updatedAt: store.getTask(taskId).updatedAt,
            item: message
          }
        }
      })

      await parity.commit({
        name: 'revise the message content',
        apply: async (store) => {
          await store.updateItem(taskId, message.id, (item) => {
            if (item.kind === 'message') item.content = 'complete answer'
          })
          return {
            kind: 'set-message-content',
            taskId,
            updatedAt: store.getTask(taskId).updatedAt,
            itemId: message.id,
            content: 'complete answer'
          }
        }
      })
    })
  })
})

async function createdTask(parity: StateParity): Promise<string> {
  let taskId = ''
  await parity.commit({
    name: 'create a task',
    apply: async (store) => {
      const task = await store.createTask()
      taskId = task.id
      return { kind: 'create-task', task }
    }
  })
  return taskId
}

/** Drives a task to a started managed execution through both stores. */
async function startedExecution(
  parity: StateParity,
  taskId: string,
  approval: ActivityItem
): Promise<void> {
  await parity.commit({
    name: 'append the pending approval',
    apply: async (store) => {
      await store.addItem(taskId, approval)
      return {
        kind: 'append-task-item',
        taskId,
        updatedAt: store.getTask(taskId).updatedAt,
        item: approval
      }
    }
  })
  await parity.commit({
    name: 'await approval',
    apply: async (store) => {
      const task = await store.mutateTask(taskId, (mutable) => {
        mutable.runStatus = 'awaiting-approval'
      })
      return {
        kind: 'patch-task',
        taskId,
        updatedAt: task.updatedAt,
        patch: { runStatus: 'awaiting-approval' }
      }
    }
  })
  await parity.commit({
    name: 'begin the managed execution',
    apply: async (store) => {
      await store.beginManagedExecution({
        taskId,
        itemId: approval.id,
        runId: approval.runId!,
        callId: approval.callId!,
        toolName: 'run_command',
        kind: 'command',
        actionSha256: ACTION_SHA,
        approvalSha256: APPROVAL_SHA,
        startedAt: TIMESTAMP
      })
      return {
        kind: 'begin-managed-execution',
        taskId,
        updatedAt: store.getTask(taskId).updatedAt,
        itemId: approval.id,
        runId: approval.runId!,
        callId: approval.callId!,
        toolName: 'run_command',
        executionKind: 'command',
        actionSha256: ACTION_SHA,
        approvalSha256: APPROVAL_SHA,
        startedAt: TIMESTAMP
      }
    }
  })
}
