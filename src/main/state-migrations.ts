export type StateDocument = Record<string, unknown> & {
  version: number
}

/**
 * A source document declares a persisted-state version this build cannot read.
 *
 * This is deliberately distinct from corruption. A newer document is
 * structurally valid state written by a future build, so falling through to an
 * older retained generation would silently downgrade the user's data. Recovery
 * must fail closed on this evidence rather than inspect a backup.
 */
export class PersistedStateVersionError extends Error {
  readonly documentVersion: number
  readonly supportedVersion: number

  constructor(documentVersion: number, supportedVersion: number) {
    super(
      `Persisted state version ${documentVersion} is newer than this Ground build supports`
    )
    this.name = 'PersistedStateVersionError'
    this.documentVersion = documentVersion
    this.supportedVersion = supportedVersion
  }
}

/**
 * The registered migration plan is internally inconsistent: an invalid current
 * version, a missing step, or a step that produced the wrong next version.
 *
 * This is a defect in Ground's own migration table, not evidence that the user's
 * document is damaged. Reading an older backup cannot repair it and would only
 * hide the defect, so it fails closed without fallthrough.
 */
export class StateMigrationContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StateMigrationContractError'
  }
}

export type StateMigration = (
  document: Readonly<StateDocument>
) => StateDocument

export interface StateMigrationPlan {
  currentVersion: number
  migrations: ReadonlyMap<number, StateMigration>
}

function versionedDocument(value: unknown): StateDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Persisted state must be an object')
  }
  const document = structuredClone(value) as Record<string, unknown>
  if (
    !Number.isSafeInteger(document.version) ||
    (document.version as number) < 1
  ) {
    throw new Error('Persisted state version is invalid')
  }
  return document as StateDocument
}

/**
 * Applies explicit, single-version migrations to a cloned state document.
 * Future versions fail closed; migrations cannot skip versions or mutate the
 * caller's input. Keeping the dispatcher independent from Zod lets every
 * migrated result pass through the full current schema afterward.
 */
export function migrateStateDocument(
  value: unknown,
  plan: StateMigrationPlan
): StateDocument {
  if (!Number.isSafeInteger(plan.currentVersion) || plan.currentVersion < 1) {
    throw new StateMigrationContractError(
      'Current persisted state version is invalid'
    )
  }
  let document = versionedDocument(value)
  if (document.version > plan.currentVersion) {
    throw new PersistedStateVersionError(
      document.version,
      plan.currentVersion
    )
  }
  while (document.version < plan.currentVersion) {
    const sourceVersion = document.version
    const migration = plan.migrations.get(sourceVersion)
    if (!migration) {
      throw new StateMigrationContractError(
        `No persisted state migration is registered for version ${sourceVersion}`
      )
    }
    const migrated = migration(structuredClone(document))
    document = versionedDocument(migrated)
    if (document.version !== sourceVersion + 1) {
      throw new StateMigrationContractError(
        `Persisted state migration ${sourceVersion} must produce version ${sourceVersion + 1}`
      )
    }
  }
  return document
}
