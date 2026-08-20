import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ActivityItem, ManagedExecutionKind, Task } from '../shared/types'
import {
  PersistedStateVersionError,
  StateMigrationContractError
} from './state-migrations'
import {
  MAX_PERSISTED_TASK_ITEMS,
  type PersistedStateData
} from './state-schema'

/**
 * Shared legacy-JSON generation-selection policy.
 *
 * This module owns *policy* — candidate order, which failures may fall through,
 * deterministic interrupted-run recovery, and selected-generation metadata. It
 * deliberately owns no reader. `StateStore` and the SQLite copy-on-migrate path
 * have different and intentionally unequal filesystem contracts: the store
 * repairs legacy permissions and quarantines unreadable files, while the
 * migration must never mutate anything it touches. Sharing one reader would
 * force the stricter consumer down to the weaker contract, so callers supply
 * their own reader and error classifier and share only this policy.
 */

export const STATE_BACKUP_RETENTION = 3

// Exported because the ledger reducer must reproduce these exact strings when
// it replays a recovery plan. Parity is byte-exact on canonical JSON, so a
// second copy of the wording would be a silent divergence rather than a
// compile error.
export const MANAGED_EXECUTION_OUTCOME_UNKNOWN =
  'Outcome unknown: Ground closed after this action started. Review the workspace or external system before deciding what to do next. Ground will not retry this action automatically.'
export const LEGACY_MANAGED_EXECUTION_OUTCOME_UNKNOWN =
  'Outcome unknown: Ground closed while this mutating action was running before durable execution claims were available. Review the workspace or external system before deciding what to do next. Ground will not retry this action automatically.'
export const MAX_INTERRUPTED_RUN_SUMMARIES = 256

/**
 * How one candidate generation failed, and therefore whether the bounded search
 * may continue to an older generation.
 *
 * - `missing` and `corrupt` may fall through. A generation that is absent or
 *   structurally damaged carries no information about the ones behind it.
 * - `version` and `contract` must not. A newer document is intact state from a
 *   future build, and a broken migration plan is Ground's own defect; reading an
 *   older backup after either would silently serve stale data.
 * - `operational` is never a recovery signal. It propagates unchanged so a
 *   permission or I/O fault is not mistaken for data loss.
 */
export type LegacyCandidateFailure =
  | 'missing'
  | 'corrupt'
  | 'version'
  | 'contract'
  | 'operational'

export interface LegacyCandidateOutcome {
  readonly path: string
  readonly failure: Exclude<LegacyCandidateFailure, 'operational'>
}

export interface LegacyStateCandidate {
  readonly state: PersistedStateData
}

export interface LegacySelectionOptions<T extends LegacyStateCandidate> {
  /** Consumer-owned reader. Its filesystem contract is not this module's. */
  readonly read: (filePath: string) => Promise<T>
  /** Consumer-owned typed classification of its own reader's failures. */
  readonly classify: (error: unknown) => LegacyCandidateFailure
  /**
   * One injected recovery timestamp. Selection never resolves time itself, so a
   * caller can replay an identical selection and compare the results byte for
   * byte.
   */
  readonly interruptedAt: string
}

interface SelectedGenerationBase<T> {
  readonly candidate: T
  /**
   * Recovered projection. Always a clone: the candidate the reader returned is
   * never mutated, so a caller may still hash the pre-recovery document.
   */
  readonly state: PersistedStateData
  readonly recovered: boolean
  /** Absolute path. Main-process only; never projected outward. */
  readonly path: string
  readonly encountered: readonly LegacyCandidateOutcome[]
}

export type LegacyGenerationSelection<T extends LegacyStateCandidate> =
  | ({ readonly source: 'primary' } & SelectedGenerationBase<T>)
  | ({
      readonly source: 'retained'
      readonly retainedIndex: number
    } & SelectedGenerationBase<T>)
  | {
      readonly source: 'none'
      readonly encountered: readonly LegacyCandidateOutcome[]
    }

/**
 * At least one generation exists but none of them validated.
 *
 * This is deliberately distinct from `source: 'none'`. Absence is a fresh
 * install; unreadable data is a recovery event. Collapsing the two would let a
 * consumer initialize empty state on top of a user's damaged history.
 */
export class LegacyStateUnrecoverableError extends Error {
  readonly encountered: readonly LegacyCandidateOutcome[]

  constructor(encountered: readonly LegacyCandidateOutcome[]) {
    super(
      'No valid Ground state generation remains; every existing generation failed to load'
    )
    this.name = 'LegacyStateUnrecoverableError'
    this.encountered = Object.freeze([...encountered])
  }
}

/**
 * Exclusive access to the legacy JSON source for the duration of a migration.
 *
 * The SQLite writer lock coordinates ledger writers only. `StateStore` never
 * acquires it, so without a separate authority a live store can rewrite the
 * primary document between the migration's final revalidation and the database
 * hard-link — and because database presence is the sole engine signal and
 * publication never falls back to JSON, those writes would be silently lost.
 */
export interface LegacySourceMigrationGate {
  withExclusiveMigration<Result>(
    operation: (holdForProcessExit: () => void) => Promise<Result>
  ): Promise<Result>
}

/**
 * Reference gate: serializes exclusive scopes and supports a terminal hold.
 *
 * Production selection will adapt `ApplicationMutationGate` to this interface;
 * this implementation exists so the authority boundary is testable without
 * wiring SQLite into the desktop.
 */
export function createExclusiveLegacySourceMigrationGate(): LegacySourceMigrationGate & {
  readonly isHeldForProcessExit: () => boolean
} {
  let queue: Promise<unknown> = Promise.resolve()
  let heldForProcessExit = false
  return {
    isHeldForProcessExit: () => heldForProcessExit,
    async withExclusiveMigration<Result>(
      operation: (holdForProcessExit: () => void) => Promise<Result>
    ): Promise<Result> {
      const run = queue.then(async () => {
        if (heldForProcessExit) {
          throw new Error(
            'The legacy source migration gate is held until this process exits'
          )
        }
        return operation(() => {
          heldForProcessExit = true
        })
      })
      queue = run.then(
        () => undefined,
        () => undefined
      )
      return run
    }
  }
}

/**
 * Bounded generation order: primary first, then retained generations newest to
 * oldest. Both consumers must search the same list in the same order.
 */
export function stateBackupPaths(filePath: string): string[] {
  return Array.from({ length: STATE_BACKUP_RETENTION }, (_, index) =>
    index === 0 ? `${filePath}.bak` : `${filePath}.bak.${index + 1}`
  )
}

export function legacyGenerationPaths(primaryPath: string): string[] {
  return [primaryPath, ...stateBackupPaths(primaryPath)]
}

/**
 * Select the newest generation that validates, then apply deterministic
 * interrupted-run recovery to a clone of it.
 *
 * Stops at the first success, so generations behind the selected one are never
 * read. Performs no filesystem mutation of any kind; a consumer that quarantines
 * or rewrites does so afterward using `encountered`.
 */
export async function selectLegacyStateGeneration<
  T extends LegacyStateCandidate
>(
  primaryPath: string,
  options: LegacySelectionOptions<T>
): Promise<LegacyGenerationSelection<T>> {
  assertRecoveryTimestamp(options.interruptedAt, 'interruptedAt')
  const paths = legacyGenerationPaths(primaryPath)
  const encountered: LegacyCandidateOutcome[] = []

  for (const [index, candidatePath] of paths.entries()) {
    let candidate: T
    try {
      candidate = await options.read(candidatePath)
    } catch (error) {
      const failure = options.classify(error)
      if (failure === 'operational') throw error
      if (failure === 'version' || failure === 'contract') throw error
      encountered.push({ path: candidatePath, failure })
      continue
    }

    const state = structuredClone(candidate.state)
    const recovered = recoverInterruptedRuns(state, options.interruptedAt)
    const base = {
      candidate,
      state,
      recovered,
      path: candidatePath,
      encountered: Object.freeze([...encountered])
    }
    return index === 0
      ? { source: 'primary', ...base }
      : { source: 'retained', retainedIndex: index - 1, ...base }
  }

  if (encountered.some((outcome) => outcome.failure !== 'missing')) {
    throw new LegacyStateUnrecoverableError(encountered)
  }
  return { source: 'none', encountered: Object.freeze([...encountered]) }
}

/**
 * Classify an error against the shared policy using the typed evidence both
 * consumers can observe. Consumers wrap this with their own reader-specific
 * cases before delegating.
 */
export function classifySharedStateFailure(
  error: unknown
): LegacyCandidateFailure | undefined {
  if (error instanceof PersistedStateVersionError) return 'version'
  if (error instanceof StateMigrationContractError) return 'contract'
  return undefined
}

const MAX_RECOVERY_TIMESTAMP_CHARACTERS = 40

/**
 * The exact schema persisted timestamps use, so a value accepted here is always
 * accepted by `managedExecution.interruptedAt` and `startedAt` afterward.
 * Deriving the rule from that schema rather than a hand-written pattern keeps
 * the two from drifting apart.
 *
 * `Date.parse` alone is not sufficient: it accepts locale strings such as
 * `Aug 13 2026` and timezone-less values such as `2026-08-13T00:00:00`, which
 * would make one recovery's stamp ambiguous across hosts.
 */
const RECOVERY_TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true })

export function assertRecoveryTimestamp(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length > MAX_RECOVERY_TIMESTAMP_CHARACTERS ||
    !RECOVERY_TIMESTAMP_SCHEMA.safeParse(value).success
  ) {
    throw new TypeError(
      `${label} must be a bounded ISO-8601 timestamp with an explicit offset`
    )
  }
}

export function isTaskActive(task: Task): boolean {
  return task.runStatus === 'running' || task.runStatus === 'awaiting-approval'
}

export function managedExecutionKind(
  item: Readonly<ActivityItem>
): ManagedExecutionKind | undefined {
  if (item.toolName === 'write_file' || item.toolName === 'edit_file') {
    return 'workspace-write'
  }
  if (item.toolName === 'run_command') return 'command'
  if (item.toolName?.startsWith('mcp__')) return 'mcp'
  return undefined
}

/**
 * Unambiguous encoding of hash inputs.
 *
 * Joining with a delimiter is ambiguous: any part that can itself contain the
 * delimiter lets two different input tuples produce the same digest. Persisted
 * task and run identifiers are arbitrary bounded strings, so each part is
 * length-prefixed instead and no delimiter is needed.
 */
function encodeHashInputs(parts: readonly string[]): string {
  return parts
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
    .join('')
}

/**
 * Deterministic identity for recovery-generated entries that is also guaranteed
 * unused within its namespace.
 *
 * A random identifier would make recovery non-reproducible: two selections of
 * the same bytes at the same injected instant would produce different documents,
 * so a caller could never prove a re-selection matched its first one. But a bare
 * derived identifier is not enough either — persisted state is untrusted input
 * and may already contain the exact value this function would derive, which
 * would collide a recovery entry onto existing content. The counter keeps the
 * result deterministic while stepping past any occupied candidate.
 */
export function deterministicUnusedId(
  prefix: string,
  parts: readonly string[],
  occupied: ReadonlySet<string>
): string {
  const encoded = encodeHashInputs(parts)
  for (let attempt = 0; ; attempt += 1) {
    const digest = createHash('sha256')
      .update(encodeHashInputs([encoded, String(attempt)]))
      .digest('hex')
    const candidate = `${prefix}_recovered_${digest.slice(0, 32)}`
    if (!occupied.has(candidate)) return candidate
  }
}

export function managedStartedAt(
  createdAt: string,
  recoveryTimestamp: string
): string {
  // Activity createdAt is a loose 1–100 character string. Date.parse treats
  // timezone-less values as local time, so the same bytes would produce a
  // different startedAt across hosts. Only a strict offset timestamp is a
  // portable instant; anything else uses the injected recovery stamp.
  if (!RECOVERY_TIMESTAMP_SCHEMA.safeParse(createdAt).success) {
    return recoveryTimestamp
  }
  const parsed = Date.parse(createdAt)
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : recoveryTimestamp
}

/**
 * Transition interrupted runs into terminal or outcome-unknown state.
 *
 * `interruptedAt` is injected rather than resolved here so that every layer of
 * one recovery — store load, snapshot restore, migration selection, and the
 * migration's pre-publication revalidation — stamps the identical instant. Two
 * selections of the same bytes must produce byte-identical projections, which is
 * impossible if any layer calls the clock itself.
 */
export function recoverInterruptedRuns(
  state: PersistedStateData,
  interruptedAt: string
): boolean {
  assertRecoveryTimestamp(interruptedAt, 'interruptedAt')
  let recovered = false
  for (const task of state.tasks) {
    const taskWasActive = isTaskActive(task)
    // Persisted state is untrusted input: it may already contain the exact
    // identifiers this recovery would derive. Track both namespaces so a
    // generated entry can never land on existing content.
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
          // Only the invented fallback needs collision avoidance; the run ids
          // recovered from existing items are intentionally real.
          deterministicUnusedId(
            'run',
            [task.id, 'interrupted', interruptedAt],
            occupiedRunIds
          )
    let activityRecovered = false
    const recoveredRunIds = new Set<string>()
    const outcomeUnknownRunIds = new Set<string>()
    for (const item of task.items) {
      if (item.kind !== 'activity') continue
      const marker = item.managedExecution
      if (
        marker?.claim === 'approved' &&
        marker.phase === 'started'
      ) {
        item.managedExecution = {
          ...marker,
          phase: 'uncertain',
          interruptedAt
        }
        item.status = 'error'
        item.result = MANAGED_EXECUTION_OUTCOME_UNKNOWN
        delete item.approvalId
        delete item.durationMs
        activityRecovered = true
        recoveredRunIds.add(item.runId)
        outcomeUnknownRunIds.add(item.runId)
        continue
      }
      if (item.status === 'running' && !marker) {
        const legacyKind = managedExecutionKind(item)
        if (legacyKind) {
          item.activityType =
            legacyKind === 'command' ? 'command' : 'tool'
          item.managedExecution = {
            version: 1,
            operationId: item.id,
            claim: 'legacy-untracked',
            kind: legacyKind,
            phase: 'uncertain',
            startedAt: managedStartedAt(item.createdAt, interruptedAt),
            interruptedAt
          }
          item.result = LEGACY_MANAGED_EXECUTION_OUTCOME_UNKNOWN
          delete item.durationMs
          outcomeUnknownRunIds.add(item.runId)
        }
      }
      if (item.status === 'pending' || item.status === 'running') {
        item.status = 'error'
        delete item.approvalId
        activityRecovered = true
        recoveredRunIds.add(item.runId)
      }
    }

    const invalidatesContinuation =
      taskWasActive || outcomeUnknownRunIds.size > 0
    let continuationCleared = false
    if (invalidatesContinuation && task.runtimeSessions) {
      delete task.runtimeSessions
      continuationCleared = true
    }
    if (invalidatesContinuation && task.modelSessions) {
      for (const session of Object.values(task.modelSessions)) {
        if (Object.hasOwn(session, 'checkpoint')) {
          delete session.checkpoint
          continuationCleared = true
        }
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
      task.items.push({
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
      })
      summariesAdded += 1
    }

    if (
      taskWasActive ||
      outcomeUnknownRunIds.size > 0
    ) {
      task.runStatus = 'failed'
    }
    if (
      activityRecovered ||
      taskWasActive ||
      continuationCleared ||
      summariesAdded > 0
    ) {
      task.updatedAt = interruptedAt
      recovered = true
    }
  }
  return recovered
}
