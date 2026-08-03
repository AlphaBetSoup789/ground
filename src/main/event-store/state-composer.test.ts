import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityItem, ProviderProfile, Task } from '../../shared/types'
import type { PersistedStateData } from '../state-schema'
import { StatePersistenceError } from '../store'
import {
  decodeLedgerEvent,
  encodeProjection,
  EventStoreConflictError,
  EventStorePersistenceUncertainError,
  fileHeadWitnessStore,
  replayLedgerDeterministically,
  sha256,
  SqliteEventStore,
  type DecodedLedgerRecord,
  type EventStoreDependencies,
  type EventStoreFaultPoint,
  type LegacyStateBootstrappedEvent
} from './index'
import { SqliteStateComposer } from './state-composer'
import type { StateMutation } from './state-mutation-plan'

/**
 * Verification for the SQLite composition layer.
 *
 * The mapping tests prove every typed mutation reaches the ledger. The failure
 * tests matter more: they prove the layer tells apart a mutation that definitely
 * did not commit from one whose durable outcome it cannot describe, because that
 * distinction is what a production cutover would rest on.
 */

const TIMESTAMP = '2026-07-31T12:00:00.000Z'
const ACTION_SHA = sha256('action')
const APPROVAL_SHA = sha256('approval')

const temporaryDirectories: string[] = []
const openLedgers: SqliteEventStore[] = []

afterEach(async () => {
  // Windows refuses to unlink an open database file, so every ledger a test
  // opened is closed before its directory is removed. A sealed store still
  // closes; its close error is irrelevant to cleanup.
  await Promise.all(
    openLedgers.splice(0).map((ledger) => ledger.close().catch(() => undefined))
  )
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

/** Registers a ledger for deterministic close before directory cleanup. */
function track(ledger: SqliteEventStore): SqliteEventStore {
  openLedgers.push(ledger)
  return ledger
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ground-state-composer-')
  )
  temporaryDirectories.push(directory)
  return directory
}

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

function initialState(): PersistedStateData {
  return {
    version: 2,
    providers: [provider(), provider({ id: 'provider_second', name: 'Second' })],
    mcpServers: [],
    tasks: [],
    settings: {
      defaultProviderId: 'provider_local',
      sidebarCollapsed: false
    },
    pendingSecretDeletes: []
  } as PersistedStateData
}

function bootstrap(
  state: PersistedStateData = initialState()
): LegacyStateBootstrappedEvent {
  const normalized = encodeProjection(state)
  return {
    kind: 'legacy-state.bootstrapped',
    sourceFormat: 'ground-json',
    sourceStateVersion: 2,
    sourceSha256: sha256('legacy-json-source'),
    sourceByteLength: Buffer.byteLength('legacy-json-source'),
    normalizedStateSha256: normalized.stateSha256,
    state: normalized.state
  }
}

let clock = 0
function deterministicDependencies(
  fault?: (point: EventStoreFaultPoint) => void
): EventStoreDependencies {
  return {
    now: () => new Date(Date.UTC(2026, 6, 31, 12, 0, (clock += 1))).toISOString(),
    fault
  }
}

interface Harness {
  readonly ledger: SqliteEventStore
  readonly composer: SqliteStateComposer
  readonly databasePath: string
  readonly uncertainties: StatePersistenceError[]
}

async function harness(
  options: {
    readonly state?: PersistedStateData
    readonly fault?: (point: EventStoreFaultPoint) => void
  } = {}
): Promise<Harness> {
  const directory = await temporaryDirectory()
  const databasePath = path.join(directory, 'ground.sqlite')
  const ledger = track(
    await SqliteEventStore.create({
      databasePath,
      bootstrap: bootstrap(options.state),
      dependencies: deterministicDependencies(options.fault)
    })
  )
  const uncertainties: StatePersistenceError[] = []
  const composer = SqliteStateComposer.adopt(ledger, {
    onPersistenceUncertain: (error) => uncertainties.push(error)
  })
  return { ledger, composer, databasePath, uncertainties }
}

/** A task body shaped the way `StateStore.createTask` produces one. */
function taskBody(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    title: 'New task',
    providerId: 'provider_local',
    mode: 'agent',
    runStatus: 'idle',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    items: [],
    ...overrides
  } as Task
}

function approvalActivity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: 'activity_approval',
    kind: 'activity',
    runId: 'run_1',
    callId: 'call_1',
    activityType: 'approval',
    approvalId: 'approval_1',
    toolName: 'run_command',
    title: 'Run a command',
    status: 'pending',
    createdAt: TIMESTAMP,
    ...overrides
  } as ActivityItem
}

/** Drives a task to a started managed execution. */
async function startedExecution(composer: SqliteStateComposer): Promise<void> {
  await composer.commit({ kind: 'create-task', task: taskBody() })
  await composer.commit({
    kind: 'append-task-item',
    taskId: 'task_1',
    updatedAt: TIMESTAMP,
    item: approvalActivity()
  })
  await composer.commit({
    kind: 'patch-task',
    taskId: 'task_1',
    updatedAt: TIMESTAMP,
    patch: { runStatus: 'awaiting-approval' }
  })
  await composer.commit({
    kind: 'begin-managed-execution',
    taskId: 'task_1',
    updatedAt: TIMESTAMP,
    itemId: 'activity_approval',
    runId: 'run_1',
    callId: 'call_1',
    toolName: 'run_command',
    executionKind: 'command',
    actionSha256: ACTION_SHA,
    approvalSha256: APPROVAL_SHA,
    startedAt: TIMESTAMP
  })
}

describe('SQLite state composer', () => {
  describe('typed mutation mapping', () => {
    it('composes every task, settings and timeline mutation onto the ledger', async () => {
      const { composer, ledger } = await harness()

      const mutations: readonly StateMutation[] = [
        { kind: 'create-task', task: taskBody() },
        {
          kind: 'patch-task',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          patch: {
            title: 'Renamed',
            mode: 'ask',
            runStatus: 'running',
            workspacePath: '/workspace',
            includeImportedHistory: true,
            providerId: 'provider_second'
          }
        },
        {
          kind: 'append-task-item',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          item: {
            id: 'message_1',
            kind: 'message',
            role: 'assistant',
            content: 'partial',
            createdAt: TIMESTAMP
          } as Task['items'][number]
        },
        {
          kind: 'set-message-content',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          itemId: 'message_1',
          content: 'complete'
        },
        {
          kind: 'set-task-runtime-session',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          providerId: 'provider_local',
          session: {
            adapterId: 'cli.codex',
            sessionCompatibilityId: 'codex',
            sessionId: 'session_1',
            providerRevision: TIMESTAMP,
            workspacePath: '/workspace',
            mode: 'agent',
            updatedAt: TIMESTAMP
          }
        },
        {
          kind: 'set-task-model-session',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          providerId: 'provider_local',
          session: {
            adapterId: 'model.openai-compatible',
            providerRevision: TIMESTAMP,
            model: 'test-model',
            mode: 'agent',
            conversation: [],
            updatedAt: TIMESTAMP
          }
        },
        {
          kind: 'set-task-runtime-session',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          providerId: 'provider_local',
          session: null
        },
        { kind: 'select-task', taskId: 'task_1' },
        {
          // Archiving refuses an active task, so the run stops first.
          kind: 'patch-task',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          patch: { runStatus: 'idle' }
        },
        {
          kind: 'set-task-archived',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          archived: false,
          archivedAt: null
        },
        { kind: 'fork-task', sourceTaskId: 'task_1', task: taskBody({ id: 'task_2' }) },
        { kind: 'import-task', task: taskBody({ id: 'task_3' }) },
        { kind: 'delete-task', taskId: 'task_3' }
      ]

      for (const mutation of mutations) {
        const result = await composer.commit(mutation)
        expect(result.committed).toBe(true)
        // Memory tracks the committed projection exactly.
        expect(encodeProjection(composer.snapshot()).stateJson).toBe(
          encodeProjection(result.state).stateJson
        )
      }

      expect(composer.snapshot().tasks.map((task) => task.id)).toEqual([
        'task_2',
        'task_1'
      ])
      expect(ledger.getHead().sequence).toBeGreaterThan(mutations.length)
    })

    it('composes every provider, secret-cleanup and MCP mutation', async () => {
      const { composer } = await harness()

      await composer.commit({
        kind: 'upsert-provider',
        provider: provider({ id: 'provider_third', name: 'Third' })
      })
      await composer.commit({
        kind: 'save-mcp-server',
        server: {
          id: 'server_docs',
          name: 'Docs',
          namespace: 'docs',
          enabled: true,
          trustedFingerprints: {},
          transport: 'stdio',
          command: 'docs-server',
          args: [],
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP
        } as never
      })
      await composer.commit({
        kind: 'delete-mcp-server',
        serverId: 'server_docs'
      })
      await composer.commit({
        kind: 'queue-provisional-secret-delete',
        reference: 'secret_staged'
      })
      await composer.commit({
        kind: 'publish-provider-secret-transition',
        provider: provider({ id: 'provider_third', hasApiKey: true }),
        stagedReference: 'secret_staged',
        obsoleteReferences: ['secret_old_a', 'secret_old_b']
      })
      await composer.commit({
        kind: 'acknowledge-secret-deletes',
        references: ['secret_old_a']
      })
      await composer.commit({
        kind: 'delete-provider-with-secret-transition',
        providerId: 'provider_third',
        obsoleteReferences: ['secret_final']
      })
      await composer.commit({
        kind: 'delete-provider',
        providerId: 'provider_second'
      })

      const state = composer.snapshot()
      expect(state.providers.map((entry) => entry.id)).toEqual(['provider_local'])
      expect(state.mcpServers).toEqual([])
      // Exact references, preserved in order and without invention.
      expect(state.pendingSecretDeletes).toEqual(['secret_old_b', 'secret_final'])
    })

    it('composes a managed execution through completion', async () => {
      const { composer } = await harness()
      await startedExecution(composer)

      await composer.commit({
        kind: 'complete-managed-execution',
        taskId: 'task_1',
        updatedAt: TIMESTAMP,
        itemId: 'activity_approval',
        operationId: 'activity_approval',
        actionSha256: ACTION_SHA,
        status: 'success',
        result: 'done',
        durationMs: 12,
        completedAt: TIMESTAMP
      })

      const item = composer.snapshot().tasks[0]?.items[0]
      expect(item?.kind === 'activity' && item.managedExecution?.phase).toBe(
        'completed'
      )
    })

    it('leaves memory and the ledger head untouched for a planned no-op', async () => {
      const { composer, ledger } = await harness()
      const before = encodeProjection(composer.snapshot()).stateJson
      const head = ledger.getHead()

      const result = await composer.commit({
        kind: 'delete-provider',
        providerId: 'provider_missing'
      })

      expect(result.committed).toBe(false)
      expect(result.plan.events).toEqual([])
      expect(encodeProjection(composer.snapshot()).stateJson).toBe(before)
      expect(ledger.getHead().sequence).toBe(head.sequence)
      expect(ledger.getHead().eventHash).toBe(head.eventHash)
    })
  })

  describe('rejected mutations', () => {
    it.each([
      [
        'the last remaining provider',
        { kind: 'delete-provider', providerId: 'provider_local' } as StateMutation,
        /Keep at least one provider connected/u
      ],
      [
        'an unknown MCP server',
        { kind: 'delete-mcp-server', serverId: 'server_missing' } as StateMutation,
        /MCP server not found/u
      ],
      [
        'an empty activity update',
        {
          kind: 'update-activities',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          updates: []
        } as StateMutation,
        /must change at least one activity/u
      ],
      [
        'a field-less activity update',
        {
          kind: 'update-activities',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          updates: [{ itemId: 'activity_approval' }]
        } as StateMutation,
        /must change at least one field/u
      ]
    ])('refuses %s without moving memory or the ledger head', async (
      _name,
      mutation,
      expected
    ) => {
      const { composer, ledger } = await harness({
        state: { ...initialState(), providers: [provider()] }
      })
      const before = encodeProjection(composer.snapshot()).stateJson
      const head = ledger.getHead()

      await expect(composer.commit(mutation)).rejects.toThrow(expected)

      // A rejection is an ordinary operational error: nothing moved and the
      // composer stays open for the next mutation.
      expect(composer.isSealed()).toBe(false)
      expect(encodeProjection(composer.snapshot()).stateJson).toBe(before)
      expect(ledger.getHead().sequence).toBe(head.sequence)
      expect(ledger.getHead().eventHash).toBe(head.eventHash)
      expect(ledger.isSealed()).toBe(false)
    })

    it('refuses to rewrite an interrupted execution into an outcome', async () => {
      const { composer } = await harness()
      await startedExecution(composer)

      await composer.commit({
        kind: 'interrupt-managed-execution',
        taskId: 'task_1',
        updatedAt: TIMESTAMP,
        itemId: 'activity_approval',
        operationId: 'activity_approval',
        interruptedAt: TIMESTAMP
      })

      const interrupted = composer.snapshot().tasks[0]?.items[0]
      expect(
        interrupted?.kind === 'activity' && interrupted.managedExecution?.phase
      ).toBe('uncertain')
      expect(interrupted?.kind === 'activity' && interrupted.status).toBe('error')

      // Outcome-unknown evidence is immutable.
      await expect(
        composer.commit({
          kind: 'complete-managed-execution',
          taskId: 'task_1',
          updatedAt: TIMESTAMP,
          itemId: 'activity_approval',
          operationId: 'activity_approval',
          actionSha256: ACTION_SHA,
          status: 'success',
          result: 'done',
          completedAt: TIMESTAMP
        })
      ).rejects.toThrow(/can never be completed|not an exact started claim/u)

      const after = composer.snapshot().tasks[0]?.items[0]
      expect(after?.kind === 'activity' && after.managedExecution?.phase).toBe(
        'uncertain'
      )
    })

    it('surfaces a head conflict as an ordinary error, not as uncertainty', async () => {
      const { composer, ledger, uncertainties } = await harness()
      const before = encodeProjection(composer.snapshot()).stateJson

      // A writer outside the composer advances the head. The composer plans
      // against the head it tracked, so this is caught before publication
      // rather than discovered as a divergence after it.
      await ledger.appendEventBatch({
        expectedHead: ledger.getHead(),
        events: [{ kind: 'settings.sidebar-collapsed-set', collapsed: true }]
      })

      await expect(
        composer.commit({ kind: 'create-task', task: taskBody() })
      ).rejects.toBeInstanceOf(EventStoreConflictError)

      // A definite failure: nothing sealed and no exit authority.
      expect(composer.isSealed()).toBe(false)
      expect(uncertainties).toEqual([])
      expect(before).not.toBe('')

      // The conflict resynchronized this view from the ledger rather than
      // leaving it stale, so the composer stays usable.
      expect(composer.snapshot().settings.sidebarCollapsed).toBe(true)
      expect(composer.head().sequence).toBe(ledger.getHead().sequence)

      const recovered = await composer.commit({
        kind: 'create-task',
        task: taskBody()
      })
      expect(recovered.committed).toBe(true)
      expect(composer.snapshot().tasks).toHaveLength(1)
      // And the outside writer's change survived the recovery.
      expect(composer.snapshot().settings.sidebarCollapsed).toBe(true)
    })
  })

  describe('publication faults', () => {
    it('treats a pre-commit fault as a retryable failure', async () => {
      let armed = false
      const { composer, ledger, uncertainties } = await harness({
        fault: (point) => {
          if (armed && point === 'before-commit') {
            throw new Error('injected before commit')
          }
        }
      })
      const before = encodeProjection(composer.snapshot()).stateJson
      const head = ledger.getHead()
      armed = true

      await expect(
        composer.commit({ kind: 'create-task', task: taskBody() })
      ).rejects.toThrow(/injected before commit/u)

      // Definitely not committed: no seal, no exit authority, nothing moved.
      expect(composer.isSealed()).toBe(false)
      expect(uncertainties).toEqual([])
      expect(encodeProjection(composer.snapshot()).stateJson).toBe(before)
      expect(ledger.getHead().sequence).toBe(head.sequence)

      // And the same mutation succeeds on retry.
      armed = false
      const retried = await composer.commit({
        kind: 'create-task',
        task: taskBody()
      })
      expect(retried.committed).toBe(true)
      expect(composer.snapshot().tasks).toHaveLength(1)
    })

    it.each([
      ['after-commit', 'after-commit' as EventStoreFaultPoint],
      ['before-witness-publish', 'before-witness-publish' as EventStoreFaultPoint],
      ['after-witness-rename', 'after-witness-rename' as EventStoreFaultPoint]
    ])(
      'seals and invokes the exit authority on a %s fault',
      async (_name, faultPoint) => {
        let armed = false
        const { composer, uncertainties } = await harness({
          fault: (point) => {
            if (armed && point === faultPoint) {
              throw new Error(`injected ${faultPoint}`)
            }
          }
        })
        const before = encodeProjection(composer.snapshot()).stateJson
        armed = true

        const error = await composer
          .commit({ kind: 'create-task', task: taskBody() })
          .then(() => undefined)
          .catch((caught: unknown) => caught)

        // Exactly the JSON store's uncertainty contract.
        expect(error).toBeInstanceOf(StatePersistenceError)
        expect((error as Error).message).toBe(
          'Ground could not conclusively publish local state'
        )
        expect((error as Error).cause).toBeInstanceOf(
          EventStorePersistenceUncertainError
        )
        expect(uncertainties).toHaveLength(1)
        expect(composer.isSealed()).toBe(true)

        // Memory never adopted the uncertain publication.
        expect(encodeProjection(composer.snapshot()).stateJson).toBe(before)

        // And the seal holds: a later mutation is refused with the same error.
        await expect(
          composer.commit({ kind: 'select-task', taskId: 'task_1' })
        ).rejects.toBe(error)
        // The exit authority is invoked once, not once per attempt.
        expect(uncertainties).toHaveLength(1)
      }
    )

    it('seals when the committed projection does not match its plan', async () => {
      const { ledger, databasePath } = await harness()
      const uncertainties: StatePersistenceError[] = []

      // A ledger that commits truthfully but reports a projection the plan does
      // not predict. This is the divergence a silent reducer drift would cause.
      const divergent = new Proxy(ledger, {
        get(target, property, receiver) {
          if (property === 'appendEventBatch') {
            return async (input: Parameters<
              SqliteEventStore['appendEventBatch']
            >[0]) => {
              const result = await target.appendEventBatch(input)
              return {
                ...result,
                projection: {
                  ...result.projection,
                  settings: {
                    ...result.projection.settings,
                    sidebarCollapsed: !result.projection.settings.sidebarCollapsed
                  }
                }
              }
            }
          }
          return Reflect.get(target, property, receiver)
        }
      })

      const composer = SqliteStateComposer.adopt(divergent, {
        onPersistenceUncertain: (error) => uncertainties.push(error)
      })
      const before = encodeProjection(composer.snapshot()).stateJson

      const error = await composer
        .commit({ kind: 'create-task', task: taskBody() })
        .then(() => undefined)
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(StatePersistenceError)
      expect(uncertainties).toHaveLength(1)
      expect(composer.isSealed()).toBe(true)
      expect(encodeProjection(composer.snapshot()).stateJson).toBe(before)
      expect(databasePath).toContain('ground.sqlite')
    })

    it('repairs a behind witness on reopen after a sealed pre-witness fault', async () => {
      const directory = await temporaryDirectory()
      const databasePath = path.join(directory, 'ground.sqlite')
      let armed = false
      const ledger = track(
        await SqliteEventStore.create({
          databasePath,
          bootstrap: bootstrap(),
          dependencies: deterministicDependencies((point) => {
            if (armed && point === 'before-witness-publish') {
              throw new Error('injected before witness publish')
            }
          })
        })
      )
      const composer = SqliteStateComposer.adopt(ledger)
      armed = true

      await expect(
        composer.commit({ kind: 'create-task', task: taskBody() })
      ).rejects.toBeInstanceOf(StatePersistenceError)
      expect(composer.isSealed()).toBe(true)
      await ledger.close()

      // The database is ahead of the witness, which is repairable.
      const reopened = track(
        await SqliteEventStore.open({ databasePath, integrityCheck: 'full' })
      )
      expect(reopened.getProjection().tasks).toHaveLength(1)
      const witness = await fileHeadWitnessStore.read(
        `${databasePath}.head.json`
      )
      expect(witness?.sequence).toBe(reopened.getHead().sequence)
      await reopened.close()
    })

    it('blocks a witness that is ahead of the database', async () => {
      const directory = await temporaryDirectory()
      const databasePath = path.join(directory, 'ground.sqlite')
      const witnessPath = `${databasePath}.head.json`
      const ledger = track(
        await SqliteEventStore.create({
          databasePath,
          bootstrap: bootstrap(),
          dependencies: deterministicDependencies()
        })
      )
      const composer = SqliteStateComposer.adopt(ledger)
      await composer.commit({ kind: 'create-task', task: taskBody() })
      const head = ledger.getHead()
      await ledger.close()

      // Forge a witness beyond the database, as a filesystem rollback of the
      // database behind an already-published head would leave things.
      const published = await fileHeadWitnessStore.read(witnessPath)
      expect(published).toBeDefined()
      await fileHeadWitnessStore.publish(witnessPath, {
        ...published!,
        sequence: head.sequence + 1,
        eventHash: sha256('forged-ahead')
      })

      await expect(
        SqliteEventStore.open({ databasePath, integrityCheck: 'full' })
      ).rejects.toThrow()
    })
  })

  describe('restart equivalence', () => {
    it('replays a composed sequence to byte-identical state', async () => {
      const directory = await temporaryDirectory()
      const databasePath = path.join(directory, 'ground.sqlite')
      const ledger = track(
        await SqliteEventStore.create({
          databasePath,
          bootstrap: bootstrap(),
          dependencies: deterministicDependencies()
        })
      )
      const composer = SqliteStateComposer.adopt(ledger)

      await startedExecution(composer)
      await composer.commit({
        kind: 'queue-provisional-secret-delete',
        reference: 'secret_staged'
      })
      await composer.commit({
        kind: 'interrupt-managed-execution',
        taskId: 'task_1',
        updatedAt: TIMESTAMP,
        itemId: 'activity_approval',
        operationId: 'activity_approval',
        interruptedAt: TIMESTAMP
      })

      const composed = encodeProjection(composer.snapshot()).stateJson
      await ledger.close()

      const reopened = track(
        await SqliteEventStore.open({ databasePath, integrityCheck: 'full' })
      )
      const restarted = SqliteStateComposer.adopt(reopened)
      expect(encodeProjection(restarted.snapshot()).stateJson).toBe(composed)

      // And re-deriving from the durable rows agrees with the materialization.
      const decoded: DecodedLedgerRecord[] = reopened.getRecords().map(
        (record) => ({
          record,
          event: decodeLedgerEvent(
            record.kind,
            record.entityId,
            record.payloadJson
          )
        })
      )
      expect(replayLedgerDeterministically(decoded).stateJson).toBe(composed)

      // Interrupted evidence survives the restart intact.
      const item = restarted.snapshot().tasks[0]?.items[0]
      expect(item?.kind === 'activity' && item.managedExecution?.phase).toBe(
        'uncertain'
      )
      expect(restarted.snapshot().pendingSecretDeletes).toEqual(['secret_staged'])
      await reopened.close()
    })

    it('refuses a second create against the same database', async () => {
      const directory = await temporaryDirectory()
      const databasePath = path.join(directory, 'ground.sqlite')
      const ledger = track(
        await SqliteEventStore.create({
          databasePath,
          bootstrap: bootstrap(),
          dependencies: deterministicDependencies()
        })
      )
      await ledger.close()
      await expect(
        SqliteEventStore.create({ databasePath, bootstrap: bootstrap() })
      ).rejects.toBeInstanceOf(EventStoreConflictError)
    })
  })

  describe('authority boundaries', () => {
    it('never reads or writes a JSON state document', async () => {
      const directory = await temporaryDirectory()
      const databasePath = path.join(directory, 'ground.sqlite')
      const jsonPath = path.join(directory, 'ground-state.json')
      // A JSON document that disagrees with the ledger. If the composer had any
      // JSON seam, this would be visible in its state.
      await writeFile(
        jsonPath,
        JSON.stringify({
          ...initialState(),
          settings: { defaultProviderId: 'provider_local', sidebarCollapsed: true }
        }),
        'utf8'
      )
      const ledger = track(
        await SqliteEventStore.create({
          databasePath,
          bootstrap: bootstrap(),
          dependencies: deterministicDependencies()
        })
      )
      const composer = SqliteStateComposer.adopt(ledger)
      await composer.commit({ kind: 'create-task', task: taskBody() })

      expect(composer.snapshot().settings.sidebarCollapsed).toBe(false)
      // SQLite alone decided the state.
      expect(encodeProjection(composer.snapshot()).stateJson).toBe(
        encodeProjection(ledger.getProjection()).stateJson
      )
      await ledger.close()
    })

    it('exposes no export, restore, renderer or recovery surface', () => {
      const surface = [
        ...Object.getOwnPropertyNames(SqliteStateComposer.prototype),
        ...Object.getOwnPropertyNames(SqliteStateComposer)
      ]
      for (const forbidden of [
        'export',
        'restore',
        'snapshotSelection',
        'listLocalStateSnapshots',
        'exportLocalStateSnapshot',
        'restoreLocalStateSnapshot',
        'recoveryNotice',
        'addRecoveryNotice'
      ]) {
        expect(surface).not.toContain(forbidden)
      }
      // The only state readers are the committed projection and the head.
      expect(surface).toContain('snapshot')
      expect(surface).toContain('head')
    })

    it('carries no credential material into the ledger', async () => {
      const { composer, ledger } = await harness()
      await composer.commit({
        kind: 'publish-provider-secret-transition',
        provider: provider({
          hasApiKey: true,
          // An unmodelled credential field must not survive normalization.
          apiKey: 'sk-should-never-persist'
        } as Partial<ProviderProfile>),
        stagedReference: 'secret_staged',
        obsoleteReferences: ['secret_old']
      })

      const payloads = ledger
        .getRecords()
        .map((record) => record.payloadJson)
        .join('\n')
      expect(payloads).not.toContain('sk-should-never-persist')
      expect(payloads).not.toContain('apiKey')
      // The exact reference journal is preserved verbatim.
      expect(composer.snapshot().pendingSecretDeletes).toEqual(['secret_old'])
      await ledger.close()
    })
  })
})
