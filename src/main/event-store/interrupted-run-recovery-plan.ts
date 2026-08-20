import type { ActivityItem, Task } from '../../shared/types'
import {
  LEGACY_MANAGED_EXECUTION_OUTCOME_UNKNOWN,
  MANAGED_EXECUTION_OUTCOME_UNKNOWN,
  MAX_INTERRUPTED_RUN_SUMMARIES,
  assertRecoveryTimestamp,
  deterministicUnusedId,
  isTaskActive,
  managedExecutionKind,
  managedStartedAt
} from '../legacy-state-recovery'
import { MAX_PERSISTED_TASK_ITEMS, type PersistedStateData } from '../state-schema'
import type { PlannedMutation } from './state-mutation-plan'
import type { GroundLedgerEvent } from './types'

/**
 * The ledger form of `recoverInterruptedRuns`.
 *
 * `StateStore` recovers interrupted runs by mutating a loaded document in
 * place. The ledger cannot: state there is the fold of an append-only event
 * sequence, so the same recovery has to be expressed as the batch of named
 * events that reproduces it. This module is that translation, and it is the
 * only thing standing between the two representations at startup.
 *
 * ## Why it is a plan rather than a second implementation
 *
 * The two paths must agree byte for byte on canonical JSON — that is the
 * property `interrupted-run-recovery-plan.test.ts` asserts by SHA-256 over
 * generated states and every existing recovery fixture. Agreement is only
 * durable if there is exactly one copy of each derivation, so every rule that
 * decides *what* recovery does is imported from `legacy-state-recovery`:
 * `isTaskActive`, `managedExecutionKind`, `managedStartedAt`,
 * `deterministicUnusedId`, the two outcome-unknown strings, and the summary
 * cap. What lives here is only the mapping from those decisions onto events.
 * A rule that drifts is then a compile error or a parity failure, never a
 * quiet divergence.
 *
 * ## Two kinds of interruption
 *
 * An activity carrying an exact `approved`/`started` claim becomes
 * outcome-unknown through `managed-execution.interrupted`, which preserves the
 * action and approval digests it was begun with. An activity that was merely
 * `running` with no marker at all predates durable claims, so it becomes
 * outcome-unknown through `managed-execution.legacy-interrupted` instead. The
 * second event exists precisely so recovery never has to invent an action or
 * approval hash to reuse the first one.
 *
 * ## Not wired into startup
 *
 * Nothing here is called by `index.ts` or `StateStore`. Where the batch is
 * committed during cutover — one batch, after the marker check and before
 * services — is a later change; this module only produces it.
 */

/** Ambient inputs are explicit, exactly as in `planStateMutation`. */
export interface InterruptedRunRecoveryPlan extends PlannedMutation {
  /**
   * Tasks the plan touches, in state order. Empty when nothing was
   * interrupted, which is also when `events` is empty.
   */
  readonly taskIds: readonly string[]
}

export function planInterruptedRunRecovery(
  state: PersistedStateData,
  interruptedAt: string
): InterruptedRunRecoveryPlan {
  assertRecoveryTimestamp(interruptedAt, 'interruptedAt')
  const events: GroundLedgerEvent[] = []
  const taskIds: string[] = []

  for (const task of state.tasks) {
    const before = events.length
    planTask(task, interruptedAt, events)
    if (events.length > before) taskIds.push(task.id)
  }

  return {
    name: 'recover-interrupted-runs',
    events,
    taskIds
  }
}

function planTask(
  task: Task,
  interruptedAt: string,
  events: GroundLedgerEvent[]
): void {
  const taskWasActive = isTaskActive(task)
  const base = { taskId: task.id, updatedAt: interruptedAt } as const

  // Both namespaces are tracked for the same reason the in-place recovery
  // tracks them: persisted state is untrusted and may already contain the
  // identifiers this plan would derive.
  const occupiedItemIds = new Set(task.items.map((item) => item.id))
  const occupiedRunIds = new Set(
    task.items
      .map((item) => item.runId)
      .filter((runId): runId is string => typeof runId === 'string')
  )
  const activeActivity = [...task.items]
    .reverse()
    .find(
      (item) =>
        item.kind === 'activity' &&
        (item.status === 'pending' || item.status === 'running')
    )
  const interruptedRunId =
    activeActivity?.kind === 'activity'
      ? activeActivity.runId
      : [...task.items]
          .reverse()
          .find((item) => item.kind === 'message' && item.runId)?.runId ??
        deterministicUnusedId(
          'run',
          [task.id, 'interrupted', interruptedAt],
          occupiedRunIds
        )

  const recoveredRunIds = new Set<string>()
  const outcomeUnknownRunIds = new Set<string>()

  for (const item of task.items) {
    if (item.kind !== 'activity') continue
    const marker = item.managedExecution

    if (marker?.claim === 'approved' && marker.phase === 'started') {
      events.push({
        kind: 'managed-execution.interrupted',
        ...base,
        itemId: item.id,
        operationId: marker.operationId,
        interruptedAt
      })
      // `managed-execution.interrupted` is deliberately narrow: it moves the
      // claim to `uncertain` and fails the activity, and nothing more. The
      // operator-facing result and the stale approval and duration are a
      // separate, ordinary activity update.
      events.push({
        kind: 'task.activity-updated',
        ...base,
        itemId: item.id,
        result: MANAGED_EXECUTION_OUTCOME_UNKNOWN,
        approvalId: null,
        durationMs: null
      })
      recoveredRunIds.add(item.runId)
      outcomeUnknownRunIds.add(item.runId)
      continue
    }

    if (item.status === 'running' && !marker) {
      const legacyKind = managedExecutionKind(item)
      if (legacyKind) {
        events.push({
          kind: 'managed-execution.legacy-interrupted',
          ...base,
          itemId: item.id,
          executionKind: legacyKind,
          startedAt: managedStartedAt(item.createdAt, interruptedAt),
          interruptedAt
        })
        outcomeUnknownRunIds.add(item.runId)
        // The legacy event already fails the activity and drops the stale
        // approval, so the shared pending/running branch below contributes no
        // further event for this item — only its bookkeeping.
        recoveredRunIds.add(item.runId)
        continue
      }
    }

    if (item.status === 'pending' || item.status === 'running') {
      events.push({
        kind: 'task.activity-updated',
        ...base,
        itemId: item.id,
        status: 'error',
        approvalId: null
      })
      recoveredRunIds.add(item.runId)
    }
  }

  const invalidatesContinuation = taskWasActive || outcomeUnknownRunIds.size > 0

  if (invalidatesContinuation && task.runtimeSessions) {
    for (const providerId of Object.keys(task.runtimeSessions)) {
      events.push({
        kind: 'task.runtime-session-set',
        ...base,
        providerId,
        session: null
      })
    }
  }
  if (invalidatesContinuation && task.modelSessions) {
    for (const [providerId, session] of Object.entries(task.modelSessions)) {
      if (!Object.hasOwn(session, 'checkpoint')) continue
      // Only the checkpoint is dropped. The rest of the model session is
      // still the truth about that conversation, so this rewrites the entry
      // rather than clearing it.
      const { checkpoint: _checkpoint, ...withoutCheckpoint } = session
      events.push({
        kind: 'task.model-session-set',
        ...base,
        providerId,
        session: withoutCheckpoint as unknown as Record<string, unknown>
      })
    }
  }

  const summaryRunIds = new Set<string>()
  if (taskWasActive) {
    for (const runId of recoveredRunIds) summaryRunIds.add(runId)
    if (!summaryRunIds.size) summaryRunIds.add(interruptedRunId)
  } else {
    for (const runId of outcomeUnknownRunIds) summaryRunIds.add(runId)
  }

  let summariesAdded = 0
  const summaryLimit = Math.min(
    MAX_INTERRUPTED_RUN_SUMMARIES,
    Math.max(0, MAX_PERSISTED_TASK_ITEMS - task.items.length)
  )
  for (const runId of summaryRunIds) {
    if (summariesAdded >= summaryLimit) break
    if (
      task.items.some(
        (item) =>
          item.kind === 'activity' &&
          item.runId === runId &&
          item.activityType === 'error' &&
          item.title === 'Run interrupted'
      )
    ) {
      continue
    }
    const outcomeUnknown = outcomeUnknownRunIds.has(runId)
    const summaryId = deterministicUnusedId(
      'activity',
      [task.id, runId, 'run-interrupted', interruptedAt],
      occupiedItemIds
    )
    occupiedItemIds.add(summaryId)
    const summary: ActivityItem = {
      id: summaryId,
      kind: 'activity',
      runId,
      activityType: 'error',
      title: 'Run interrupted',
      detail: outcomeUnknown
        ? 'Ground closed after a mutating action started. Its outcome is unknown, Ground did not retry it, and any native runtime continuation or model checkpoint was cleared. Review the workspace or external system before continuing.'
        : 'Ground closed before this run reached a terminal state. Review the workspace before retrying.',
      status: 'error',
      createdAt: interruptedAt
    }
    events.push({
      kind: 'task.item-appended',
      ...base,
      itemId: summaryId,
      item: portable(summary)
    })
    summariesAdded += 1
  }

  if (taskWasActive || outcomeUnknownRunIds.size > 0) {
    events.push({
      kind: 'task.run-status-set',
      ...base,
      runStatus: 'failed'
    })
  }

  // `task.updatedAt` is not a separate event: every event above carries
  // `updatedAt`, and `mutateTask` stamps it. The in-place recovery stamps
  // `updatedAt` under exactly `activityRecovered || taskWasActive ||
  // continuationCleared || summariesAdded > 0`, and every event this function
  // emits implies one of those, so a task that would not have been stamped
  // contributes no events and keeps its original `updatedAt`.
}

function portable(entity: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entity)) as Record<string, unknown>
}
