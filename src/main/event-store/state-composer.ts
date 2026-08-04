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
 * A planner rejection or a schema rejection means the batch definitely did not
 * commit. Those are ordinary operational errors: memory and the ledger head are
 * untouched and the caller may retry immediately.
 *
 * A head conflict also means the batch definitely did not commit, so it is not
 * persistence uncertainty and never invokes the exit authority. It is, however,
 * unrecoverable from here. The conflicting writer may have been a second
 * `SqliteEventStore` handle on the same database, in which case this handle's
 * `getProjection()` and `getHead()` are exactly as stale as this composer;
 * adopting them would serve pre-conflict state while claiming to have
 * resynchronized. Re-reading the database belongs to `SqliteEventStore`, behind
 * its integrity checks and writer lock. So a conflict marks the composer stale:
 * it stops answering reads and refuses further mutations until the ledger is
 * reopened.
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

/**
 * A conflicting writer invalidated a composer's view of the ledger.
 *
 * Deliberately not a `StatePersistenceError`: nothing was published, the durable
 * state is intact, and the process must not exit. The composer simply cannot be
 * trusted to describe the ledger any more, and the caller must reopen it.
 */
export class StateComposerStaleError extends Error {
  constructor(cause: unknown) {
    super(
      'Ground SQLite state composer is stale; reopen the ledger before mutating',
      { cause }
    )
    this.name = 'StateComposerStaleError'
  }
}

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
  private staleness?: StateComposerStaleError
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

  /**
   * The composer's authoritative state: the ledger's committed projection.
   *
   * Throws once the composer is stale, because a reader handed pre-conflict
   * state could not tell it apart from current state — which is the failure
   * this fails closed against.
   *
   * A seal does not block reads. `StateStore` gates mutations on persistence
   * uncertainty and leaves reads alone, and the state here is still the last
   * state this process durably committed; it is the *next* publication that
   * cannot be trusted. The process is exiting regardless.
   */
  snapshot(): PersistedStateData {
    this.assertFresh()
    return structuredClone(this.state)
  }

  /** The head this composer's state was derived from. */
  head(): LedgerHead {
    this.assertFresh()
    return { ...this.trackedHead }
  }

  /** True once a publication became ambiguous and the composer stopped. */
  isSealed(): boolean {
    return this.persistenceUncertainty !== undefined
  }

  /**
   * True once a conflicting writer made this view untrustworthy. Unlike a seal,
   * this is not a persistence ambiguity: nothing was published, and the process
   * does not exit. The ledger must be reopened.
   */
  isStale(): boolean {
    return this.staleness !== undefined
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
    // Captured at invocation time, before anything is queued. Callers hold live
    // references to the objects inside a mutation — the streaming timeline
    // writer keeps mutating its renderer-facing item after queueing the
    // insertion, which is why `StateStore.addItem` clones too. Planning against
    // the object as it looks whenever the queue drains would persist a
    // different fact than the caller asked for.
    const captured = structuredClone(mutation)
    return this.enqueueTransaction(async () => {
      this.assertUsable()

      // Planned against the ledger's own committed projection. A planner
      // rejection throws here, before the ledger has been contacted at all.
      const before = this.state
      const plan = planStateMutation(before, captured)

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
          // batch definitely did not commit, so this is not persistence
          // uncertainty and must not invoke the exit authority.
          //
          // It is also not recoverable from here. `getProjection()` and
          // `getHead()` return the handle's own cache, and when the writer was
          // a second handle on the same database that cache is exactly as stale
          // as this composer — adopting it would serve pre-conflict state while
          // claiming to have resynchronized. Re-reading the database is
          // `SqliteEventStore`'s responsibility, behind its own integrity
          // checks and writer lock, and this layer deliberately does not own
          // opening or repairing a database.
          //
          // So the composer fails closed: it keeps its state to itself and
          // refuses further work until a caller reopens the ledger.
          this.markStale(error)
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

  /**
   * Records that a conflicting writer invalidated this view.
   *
   * The conflict itself is rethrown by the caller so the true cause survives;
   * this only stops the composer from being used again.
   */
  private markStale(cause: EventStoreConflictError): void {
    this.staleness ??= new StateComposerStaleError(cause)
  }

  /** Mutation gate: neither an uncertain publication nor a stale view. */
  private assertUsable(): void {
    if (this.persistenceUncertainty) {
      throw this.persistenceUncertainty
    }
    this.assertFresh()
  }

  /** Read gate: this view must still describe the ledger. */
  private assertFresh(): void {
    if (this.staleness) {
      throw this.staleness
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
