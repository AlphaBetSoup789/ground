export class EventStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EventStoreError'
  }
}

export class EventStoreVersionError extends EventStoreError {
  constructor(
    readonly boundary:
      | 'database'
      | 'event'
      | 'reducer'
      | 'projection'
      | 'witness',
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'EventStoreVersionError'
  }
}

export class EventCodecError extends EventStoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EventCodecError'
  }
}

export class EventStoreCorruptionError extends EventStoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EventStoreCorruptionError'
  }
}

export class EventStoreRollbackError extends EventStoreError {
  constructor(message: string) {
    super(message)
    this.name = 'EventStoreRollbackError'
  }
}

export class EventStoreConflictError extends EventStoreError {
  constructor(message: string) {
    super(message)
    this.name = 'EventStoreConflictError'
  }
}

export class EventStoreSealedError extends EventStoreError {
  constructor() {
    super('Ground SQLite event store is sealed')
    this.name = 'EventStoreSealedError'
  }
}

export class EventStorePersistenceUncertainError extends EventStoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EventStorePersistenceUncertainError'
  }
}

export class JsonV2MigrationError extends EventStoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JsonV2MigrationError'
  }
}
