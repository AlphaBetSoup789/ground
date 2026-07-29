export interface ProviderStartBinding {
  taskId: string
  taskRevision: string
  providerId: string
  providerRevision: string
  providerFingerprint: string
  credentialBoundary: string
}

export interface ProviderStartReservation {
  readonly binding: Readonly<ProviderStartBinding>
}

function sameStartBinding(
  left: Readonly<ProviderStartBinding>,
  right: Readonly<ProviderStartBinding>
): boolean {
  return (
    left.taskId === right.taskId &&
    left.taskRevision === right.taskRevision &&
    left.providerId === right.providerId &&
    left.providerRevision === right.providerRevision &&
    left.providerFingerprint === right.providerFingerprint &&
    left.credentialBoundary === right.credentialBoundary
  )
}

export class ProviderOperationGate {
  private readonly mutations = new Set<string>()
  private readonly starts = new Map<
    string,
    Set<ProviderStartReservation>
  >()
  private readonly issuedStarts = new WeakSet<ProviderStartReservation>()

  reserveMutation(
    providerId: string,
    isProviderActive: () => boolean
  ): () => void {
    if (this.mutations.has(providerId)) {
      throw new Error('This provider is already being changed')
    }
    if (this.mutations.size > 0) {
      throw new Error('Another provider is already being changed')
    }
    if ((this.starts.get(providerId)?.size ?? 0) > 0) {
      throw new Error(
        'Wait for starting runs to finish before changing this provider'
      )
    }
    if (isProviderActive()) {
      throw new Error('Stop active runs before changing this provider')
    }
    this.mutations.add(providerId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.mutations.delete(providerId)
    }
  }

  reserveStart(
    binding: Readonly<ProviderStartBinding>
  ): ProviderStartReservation {
    if (this.mutations.has(binding.providerId)) {
      throw new Error(
        'Wait for the provider change to finish before starting a run'
      )
    }
    const reservation: ProviderStartReservation = Object.freeze({
      binding: Object.freeze({ ...binding })
    })
    const providerStarts =
      this.starts.get(binding.providerId) ??
      new Set<ProviderStartReservation>()
    providerStarts.add(reservation)
    this.starts.set(binding.providerId, providerStarts)
    this.issuedStarts.add(reservation)
    return reservation
  }

  assertStartReservation(
    reservation: ProviderStartReservation,
    binding: Readonly<ProviderStartBinding>
  ): void {
    if (
      !this.issuedStarts.has(reservation) ||
      !this.starts.get(binding.providerId)?.has(reservation) ||
      !sameStartBinding(reservation.binding, binding)
    ) {
      throw new Error(
        'The task or provider changed while the run was starting'
      )
    }
  }

  releaseStart(reservation: ProviderStartReservation): void {
    if (!this.issuedStarts.has(reservation)) return
    this.issuedStarts.delete(reservation)
    const providerId = reservation.binding.providerId
    const providerStarts = this.starts.get(providerId)
    providerStarts?.delete(reservation)
    if (providerStarts?.size === 0) this.starts.delete(providerId)
  }

  isMutationReserved(providerId: string): boolean {
    return this.mutations.has(providerId)
  }

  isStartReserved(providerId: string): boolean {
    return (this.starts.get(providerId)?.size ?? 0) > 0
  }
}
