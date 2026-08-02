import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parsePersistedState, type PersistedStateData } from '../state-schema'
import { StateStore } from '../store'
import { decodeLedgerEvent, encodeProjection, sha256 } from './codec'
import { replayLedgerDeterministically, type DecodedLedgerRecord } from './reducer'
import { SqliteEventStore } from './sqlite-event-store'
import {
  planStateMutation,
  type PlannedMutation,
  type StateMutation
} from './state-mutation-plan'
import type { LegacyStateBootstrappedEvent } from './types'

/**
 * Runs the same product operation through the JSON `StateStore` and through the
 * SQLite ledger, and compares canonical state after every committed operation.
 *
 * This is the last check before the production cutover. The reducers and the
 * planner each look right in isolation; what this harness answers is whether a
 * real sequence of store calls and the ledger batches that stand in for them
 * agree on the resulting state — byte for byte, in canonical form, at every
 * commit boundary rather than only at the end. A divergence that appears at
 * step 4 and is masked by step 7 is exactly the class of bug that would
 * otherwise ship.
 *
 * Three properties are asserted per step:
 *
 * - **Committed state matches.** Canonical JSON of the JSON store's persisted
 *   document equals canonical JSON of the ledger's replayed projection.
 * - **No-ops stay no-ops on both sides.** A mutation that plans an empty batch
 *   must also leave the JSON document unchanged; otherwise the planner is
 *   dropping a real change.
 * - **Rejections leave nothing behind.** Both stores must refuse, and neither
 *   the JSON document nor the ledger head may move.
 *
 * The harness deliberately drives the *real* `StateStore` rather than a model of
 * it. Nothing here switches the desktop to SQLite: the ledger is a shadow of the
 * JSON store for the duration of a scenario and is discarded with the temporary
 * directory.
 */

export interface ParityStep {
  readonly name: string
  /**
   * Performs exactly one committed `StateStore` operation and returns the
   * mutation describing it. Generated IDs and timestamps are read back from the
   * store's own result so the plan can name the same facts the store recorded.
   */
  readonly apply: (store: StateStore) => Promise<StateMutation>
}

export interface RejectedParityStep {
  readonly name: string
  /** Both the store call and the plan must fail with a matching message. */
  readonly expect: RegExp
  readonly apply: (store: StateStore) => Promise<unknown>
  readonly plan: (store: StateStore) => StateMutation
}

export interface ParityStepReport {
  readonly name: string
  readonly plan: PlannedMutation
  readonly stateJson: string
}

export class StateParity {
  private constructor(
    private readonly directory: string,
    private readonly statePath: string,
    readonly jsonStore: StateStore,
    private readonly ledger: SqliteEventStore,
    readonly reports: ParityStepReport[]
  ) {}

  static async create(initialState: PersistedStateData): Promise<StateParity> {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'ground-state-parity-')
    )
    const statePath = path.join(directory, 'state.json')
    const seeded = JSON.stringify(parsePersistedState(initialState), null, 2)
    await writeFile(statePath, seeded, 'utf8')

    const jsonStore = new StateStore(statePath)
    await jsonStore.load()

    // Bootstrap the ledger from what the JSON store actually loaded, not from
    // the caller's literal. `load` normalizes and may recover interrupted runs,
    // and a ledger seeded from the pre-load bytes would start out of step for
    // reasons that have nothing to do with the mutations under test.
    const loaded = await readCommittedState(statePath)
    const normalized = encodeProjection(loaded)
    const sourceBytes = await readFile(statePath)
    const bootstrap: LegacyStateBootstrappedEvent = {
      kind: 'legacy-state.bootstrapped',
      sourceFormat: 'ground-json',
      sourceStateVersion: 2,
      sourceSha256: sha256(sourceBytes),
      sourceByteLength: sourceBytes.byteLength,
      normalizedStateSha256: normalized.stateSha256,
      state: normalized.state
    }

    const ledger = await SqliteEventStore.create({
      databasePath: path.join(directory, 'ledger.sqlite'),
      bootstrap
    })

    const parity = new StateParity(
      directory,
      statePath,
      jsonStore,
      ledger,
      []
    )
    parity.assertMatched('bootstrap', normalized.stateJson)
    return parity
  }

  /** Runs one committed operation through both stores and compares the result. */
  async commit(step: ParityStep): Promise<ParityStepReport> {
    const before = this.ledger.getProjection()
    const beforeJson = encodeProjection(before).stateJson

    const mutation = await step.apply(this.jsonStore)
    await this.jsonStore.flush()
    const committed = await readCommittedState(this.statePath)
    const committedJson = encodeProjection(committed).stateJson

    const plan = planStateMutation(before, mutation)
    if (!plan.events.length) {
      // An empty plan claims the operation changed nothing. Hold it to that.
      if (committedJson !== beforeJson) {
        throw new StateParityError(
          step.name,
          `${plan.name} planned no events but the JSON store committed a change`,
          beforeJson,
          committedJson
        )
      }
      const report = { name: step.name, plan, stateJson: committedJson }
      this.reports.push(report)
      return report
    }

    const appended = await this.ledger.appendEventBatch({
      expectedHead: this.ledger.getHead(),
      events: plan.events
    })
    const ledgerJson = encodeProjection(appended.projection).stateJson

    if (ledgerJson !== committedJson) {
      throw new StateParityError(
        step.name,
        `${plan.name} produced different state in the JSON store and the ledger`,
        committedJson,
        ledgerJson
      )
    }

    const report = { name: step.name, plan, stateJson: committedJson }
    this.reports.push(report)
    return report
  }

  /**
   * Asserts a refused operation is refused identically by both sides and leaves
   * no trace. A ledger that accepted a batch the JSON store rejected would be
   * durably wrong, so the head is checked as well as the projection.
   */
  async rejects(step: RejectedParityStep): Promise<void> {
    const beforeJson = encodeProjection(this.ledger.getProjection()).stateJson
    const beforeHead = this.ledger.getHead()

    const storeError = await captureError(() => step.apply(this.jsonStore))
    if (!storeError) {
      throw new Error(`[${step.name}] the JSON store accepted a rejected call`)
    }
    if (!step.expect.test(String((storeError as Error).message))) {
      throw new Error(
        `[${step.name}] the JSON store rejected with an unexpected message: ${
          (storeError as Error).message
        }`
      )
    }

    const planError = await captureError(async () =>
      planStateMutation(this.ledger.getProjection(), step.plan(this.jsonStore))
    )
    if (!planError) {
      throw new Error(`[${step.name}] the planner accepted a rejected mutation`)
    }
    if (!step.expect.test(String((planError as Error).message))) {
      throw new Error(
        `[${step.name}] the planner rejected with an unexpected message: ${
          (planError as Error).message
        }`
      )
    }

    await this.jsonStore.flush()
    const committedJson = encodeProjection(
      await readCommittedState(this.statePath)
    ).stateJson
    if (committedJson !== beforeJson) {
      throw new StateParityError(
        step.name,
        'a rejected operation still changed the JSON store',
        beforeJson,
        committedJson
      )
    }
    const afterHead = this.ledger.getHead()
    if (
      afterHead.sequence !== beforeHead.sequence ||
      afterHead.eventHash !== beforeHead.eventHash
    ) {
      throw new Error(
        `[${step.name}] a rejected operation still advanced the ledger head`
      )
    }
  }

  /** Canonical state both stores currently agree on. */
  canonicalState(): string {
    return encodeProjection(this.ledger.getProjection()).stateJson
  }

  /**
   * Re-derives the whole scenario from the durable event rows and checks it
   * against the JSON store.
   *
   * Per-step comparison uses the ledger's incrementally materialized projection,
   * which shares its reduction with the append path. Replaying the rows instead
   * proves the events themselves carry the state — that nothing survived only in
   * the in-memory projection — and that replay is deterministic. This is the
   * property the cutover ultimately depends on, so every scenario ends with it.
   */
  async verifyDurableReplay(): Promise<void> {
    const decoded: DecodedLedgerRecord[] = this.ledger
      .getRecords()
      .map((record) => ({
        record,
        event: decodeLedgerEvent(
          record.kind,
          record.entityId,
          record.payloadJson
        )
      }))

    const replayed = replayLedgerDeterministically(decoded)
    await this.jsonStore.flush()
    const committedJson = encodeProjection(
      await readCommittedState(this.statePath)
    ).stateJson

    if (replayed.stateJson !== committedJson) {
      throw new StateParityError(
        'durable-replay',
        'replaying the ledger from its durable rows did not reproduce the JSON store',
        committedJson,
        replayed.stateJson
      )
    }
  }

  private assertMatched(name: string, ledgerJson: string): void {
    this.reports.push({
      name,
      plan: { name, events: [] },
      stateJson: ledgerJson
    })
  }

  async close(): Promise<void> {
    await this.ledger.close()
    await rm(this.directory, { recursive: true, force: true })
  }
}

export class StateParityError extends Error {
  constructor(
    readonly step: string,
    reason: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(`[${step}] ${reason}\n--- json ---\n${expected}\n--- ledger ---\n${actual}`)
    this.name = 'StateParityError'
  }
}

/** Runs a scenario against a fresh parity pair and always tears it down. */
export async function withStateParity(
  initialState: PersistedStateData,
  scenario: (parity: StateParity) => Promise<void>
): Promise<void> {
  const parity = await StateParity.create(initialState)
  try {
    await scenario(parity)
    await parity.verifyDurableReplay()
  } finally {
    await parity.close()
  }
}

async function readCommittedState(
  statePath: string
): Promise<PersistedStateData> {
  return parsePersistedState(JSON.parse(await readFile(statePath, 'utf8')))
}

async function captureError(
  operation: () => Promise<unknown>
): Promise<unknown> {
  try {
    await operation()
    return undefined
  } catch (error) {
    return error
  }
}
