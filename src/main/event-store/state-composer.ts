import type { PersistedStateData } from '../state-schema'
import { StatePersistenceError } from '../store'
import { encodeProjection } from './codec'
import {
  EventStoreConflictError,
  EventStorePersistenceUncertainError
} from './errors'
import { reduceLedgerEvent } from './reducer'
import type { SqliteEventStore } from './sqlite-event-store'
import {
  planStateMutation,
  type PlannedMutation,
  type StateMutation
} from './state-mutation-plan'
import type { LedgerHead } from './types'

/**
 * Composes production state mutations against the SQLite ledger.
 *
 * The planner says which events a mutation becomes and the event store says how
 * a batch reaches disk. Neither owns the rule that makes a cutover safe: that
 * durable publication happens *before* anything observable changes, and that an
 * ambiguous publication stops the process rather than letting a caller proceed
 * on state that may not exist on disk. This class owns that rule.
 *
 * ## Authority
 *
 * Where this composer is used, SQLite is the only authority. It plans against
 * its own projection — never against a JSON document — and it refreshes memory
 * only from `AppendEventBatchResult.projection`, the state the ledger itself
 * materialized and committed. It never writes JSON, and there is deliberately no
 * seam through which a JSON document could become a second authority or a
 * fallback.
 *
 * ## Order of operations
 *
 * Every commit runs the same sequence, and each step exists because skipping it
 * would create a state the next startup could not explain:
 *
 * 1. Refuse outright if a previous publication was ambiguous.
 * 2. Plan against the current projection. A rejected mutation fails here, with
 *    no batch and no ledger contact at all.
 * 3. Append with the exact head the plan was built against, so a writer this
 *    composer never saw conflicts before publication rather than interleaving.
 * 4. Verify the committed projection is the one the plan predicted.
 * 5. Only then adopt the committed projection as memory.
 *
 * ## Failure classification
 *
 * The distinction that matters most is between *failed* and *unknown*.
 *
 * A planner rejection, a schema rejection, or a head conflict all mean the batch
 * definitely did not commit. They are ordinary operational errors: memory and
 * the ledger head are untouched and the caller may retry. A head conflict
 * additionally resynchronizes this view from the ledger, so a writer that
 * arrived first cannot wedge every later mutation against a head that no longer
 * exists.
 *
 * An ambiguous commit, a post-commit witness failure, or a committed projection
 * that does not match the plan all mean durable state may have moved in a way
 * this process can no longer describe. Those seal the composer and invoke the
 * same process-exit authority the JSON `StateStore` uses, via the same
 * `StatePersistenceError` and `onPersistenceUncertain` contract, so a caller can
 * never observe a mutation the disk may not agree with.
 *
 * ## Not selected in production
 *
 * Nothing here is constructed by `index.ts`. The desktop remains on the JSON
 * `StateStore`, because activating SQLite today would regress three recovery
 * behaviors this layer does not address: copy-on-migrate does not perform the
 * interrupted-run transition `StateStore.load` performs, it reads only the
 * primary JSON document rather than falling through retained backups, and local
 * snapshot export/restore is defined over rotated JSON generations that have no
 * ledger equivalent yet. Those are recovery-contract work, not composition work.
 */

export interface StateComposerOptions {
  /**
   * Invoked after a publication becomes ambiguous, exactly as
   * `StateStoreOptions.onPersistenceUncertain` is. The composer seals itself
   * before calling this, so a delayed process exit still cannot admit another
   * mutation from state the disk may not share.
   */
  readonly onPersistenceUncertain?: (error: StatePersistenceError) => void
}

export interface ComposedMutation {
  readonly name: string
  /** The batch that was appended; empty when the mutation was a no-op. */
  readonly plan: PlannedMutation
  /** The committed projection, or the unchanged projection for a no-op. */
  readonly state: PersistedStateData
  /** The ledger head after the commit. Unchanged for a no-op. */
  readonly head: LedgerHead
  readonly committed: boolean
}

export class SqliteStateComposer {
  private state: PersistedStateData
  /**
   * The head `state` was derived from.
   *
   * Tracked rather than re-read at append time, because the expected head has
   * to be the one the plan was built against. Reading a fresh head would let a
   * batch planned on a stale projection append cleanly on top of a writer the
   * composer never saw, turning a conflict that belongs before the commit into
   * a divergence discovered after it.
   */
  private trackedHead: LedgerHead
  private persistenceUncertainty?: StatePersistenceError
  private transactionQueue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly ledger: SqliteEventStore,
    private readonly onPersistenceUncertain?: (
      error: StatePersistenceError
    ) => void
  ) {
    this.state = ledger.getProjection()
    this.trackedHead = ledger.getHead()
  }

  /**
   * Adopts an already-open ledger. Opening, migrating, and verifying a database
   * stay with `SqliteEventStore`, so this layer cannot introduce a second way to
   * select or repair one.
   */
  static adopt(
    ledger: SqliteEventStore,
    options: StateComposerOptions = {}
  ): SqliteStateComposer {
    return new SqliteStateComposer(ledger, options.onPersistenceUncertain)
  }

  /** The composer's authoritative state: the ledger's committed projection. */
  snapshot(): PersistedStateData {
    return structuredClone(this.state)
  }

  /** The head this composer's state was derived from. */
  head(): LedgerHead {
    return { ...this.trackedHead }
  }

  /** True once a publication became ambiguous and the composer stopped. */
  isSealed(): boolean {
    return this.persistenceUncertainty !== undefined
  }

  /**
   * Plans, publishes, and only then adopts one production mutation.
   *
   * Serialized through a transaction queue for the same reason `StateStore`
   * serializes: two mutations planned against the same projection would both
   * carry the same expected head, and the loser would fail a conflict it never
   * needed to hit.
   */
  commit(mutation: StateMutation): Promise<ComposedMutation> {
    return this.enqueueTransaction(async () => {
      this.assertPersistenceCertain()

      // Planned against the ledger's own committed projection. A planner
      // rejection throws here, before the ledger has been contacted at all.
      const before = this.state
      const plan = planStateMutation(before, mutation)

      if (!plan.events.length) {
        return {
          name: plan.name,
          plan,
          state: structuredClone(before),
          head: { ...this.trackedHead },
          committed: false
        }
      }

      // The head the plan was built against, so a writer this composer never
      // saw is rejected before publication rather than discovered after it.
      const expectedHead = this.trackedHead
      const predicted = this.predictProjection(before, plan)

      let appended
      try {
        appended = await this.ledger.appendEventBatch({
          expectedHead,
          events: plan.events
        })
      } catch (error) {
        if (error instanceof EventStorePersistenceUncertainError) {
          // Ambiguous commit or post-commit witness failure. Durable state may
          // have moved; this process can no longer describe it.
          throw this.sealForUncertainty(error)
        }
        if (error instanceof EventStoreConflictError) {
          // A writer this composer never saw reached the ledger first. The
          // batch definitely did not commit, but this view is now stale, and
          // leaving it stale would fail every later mutation against a head
          // that no longer exists.
          //
          // Resynchronize from the ledger — still the only authority — and
          // rethrow. The mutation is deliberately not replanned or retried
          // here: its preconditions were checked against state that no longer
          // holds, so re-deciding it belongs to the caller, against the fresh
          // projection.
          this.state = this.ledger.getProjection()
          this.trackedHead = this.ledger.getHead()
        }
        // A definite failure before publication. Nothing moved, so this stays an
        // ordinary operational error and must not be reported as uncertainty.
        throw error
      }

      const committed = encodeProjection(appended.projection).stateJson
      if (committed !== predicted) {
        // The batch committed, but not as the plan described. The durable state
        // is real and this process cannot explain it, so treat it exactly like
        // an ambiguous publication rather than adopting either version.
        throw this.sealForUncertainty(
          new EventStorePersistenceUncertainError(
            'SQLite ledger committed a projection that does not match its plan'
          )
        )
      }

      // Memory changes only here, from the projection the ledger committed.
      this.state = appended.projection
      this.trackedHead = appended.head
      return {
        name: plan.name,
        plan,
        state: structuredClone(appended.projection),
        head: appended.head,
        committed: true
      }
    })
  }

  /**
   * Folds the planned batch onto the current projection so the committed result
   * can be checked against it. This is a second, independent derivation: the
   * append path reduces the same events inside its transaction, and agreement
   * between the two is what makes the commit explainable.
   */
  private predictProjection(
    before: PersistedStateData,
    plan: PlannedMutation
  ): string {
    let projected = before
    let sequence = this.trackedHead.sequence
    for (const event of plan.events) {
      sequence += 1
      projected = reduceLedgerEvent(projected, event, sequence)
    }
    return encodeProjection(projected).stateJson
  }

  private sealForUncertainty(
    cause: EventStorePersistenceUncertainError
  ): StatePersistenceError {
    const sealed = new StatePersistenceError(cause)
    this.persistenceUncertainty ??= sealed
    try {
      this.onPersistenceUncertain?.(sealed)
    } catch {
      // The composer is already sealed. Preserve the publication error that
      // explains why the process must exit rather than trusting callback
      // behavior.
    }
    return this.persistenceUncertainty
  }

  private assertPersistenceCertain(): void {
    if (this.persistenceUncertainty) {
      throw this.persistenceUncertainty
    }
  }

  private enqueueTransaction<Result>(
    operation: () => Promise<Result>
  ): Promise<Result> {
    const result = this.transactionQueue.then(operation)
    this.transactionQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
