export type StateDocument = Record<string, unknown> & {
  version: number
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
    throw new Error('Current persisted state version is invalid')
  }
  let document = versionedDocument(value)
  if (document.version > plan.currentVersion) {
    throw new Error(
      `Persisted state version ${document.version} is newer than this Ground build supports`
    )
  }
  while (document.version < plan.currentVersion) {
    const sourceVersion = document.version
    const migration = plan.migrations.get(sourceVersion)
    if (!migration) {
      throw new Error(
        `No persisted state migration is registered for version ${sourceVersion}`
      )
    }
    const migrated = migration(structuredClone(document))
    document = versionedDocument(migrated)
    if (document.version !== sourceVersion + 1) {
      throw new Error(
        `Persisted state migration ${sourceVersion} must produce version ${sourceVersion + 1}`
      )
    }
  }
  return document
}
