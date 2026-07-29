import type { AgentRuntimeAdapter, ModelAdapter } from './contracts'

export type AdapterKind = 'model' | 'agent-runtime'

export interface AdapterRegistration {
  id: string
  kind: AdapterKind
}

type RegisteredAdapter =
  | {
      kind: 'model'
      adapter: ModelAdapter<unknown>
    }
  | {
      kind: 'agent-runtime'
      adapter: AgentRuntimeAdapter<unknown>
    }

export class DuplicateAdapterError extends Error {
  constructor(readonly adapterId: string) {
    super(`An adapter with id "${adapterId}" is already registered`)
    this.name = 'DuplicateAdapterError'
  }
}

export class UnknownAdapterError extends Error {
  constructor(readonly adapterId: string) {
    super(`No adapter with id "${adapterId}" is registered`)
    this.name = 'UnknownAdapterError'
  }
}

export class AdapterKindMismatchError extends Error {
  constructor(
    readonly adapterId: string,
    readonly expected: AdapterKind,
    readonly actual: AdapterKind
  ) {
    super(`Adapter "${adapterId}" is ${actual}, not ${expected}`)
    this.name = 'AdapterKindMismatchError'
  }
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, RegisteredAdapter>()

  registerModel<C>(adapter: ModelAdapter<C>): this {
    this.register(adapter.id, {
      kind: 'model',
      adapter: adapter as unknown as ModelAdapter<unknown>
    })
    return this
  }

  registerAgentRuntime<C>(adapter: AgentRuntimeAdapter<C>): this {
    this.register(adapter.id, {
      kind: 'agent-runtime',
      adapter: adapter as unknown as AgentRuntimeAdapter<unknown>
    })
    return this
  }

  has(adapterId: string): boolean {
    return this.adapters.has(adapterId)
  }

  requireModel(adapterId: string): ModelAdapter<unknown> {
    const registered = this.require(adapterId)
    if (registered.kind !== 'model') {
      throw new AdapterKindMismatchError(adapterId, 'model', registered.kind)
    }
    return registered.adapter
  }

  requireAgentRuntime(adapterId: string): AgentRuntimeAdapter<unknown> {
    const registered = this.require(adapterId)
    if (registered.kind !== 'agent-runtime') {
      throw new AdapterKindMismatchError(adapterId, 'agent-runtime', registered.kind)
    }
    return registered.adapter
  }

  list(): AdapterRegistration[] {
    return [...this.adapters.entries()].map(([id, registered]) => ({
      id,
      kind: registered.kind
    }))
  }

  private register(adapterId: string, registered: RegisteredAdapter): void {
    assertAdapterId(adapterId)
    if (this.adapters.has(adapterId)) throw new DuplicateAdapterError(adapterId)
    this.adapters.set(adapterId, registered)
  }

  private require(adapterId: string): RegisteredAdapter {
    const adapter = this.adapters.get(adapterId)
    if (!adapter) throw new UnknownAdapterError(adapterId)
    return adapter
  }
}

function assertAdapterId(adapterId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(adapterId)) {
    throw new TypeError(
      'Adapter ids must begin with a lowercase letter or digit and contain only lowercase letters, digits, ".", "_", or "-"'
    )
  }
}
