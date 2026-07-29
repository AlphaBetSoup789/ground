export class ProviderOperationGate {
  private readonly mutations = new Set<string>()

  reserveMutation(
    providerId: string,
    isProviderActive: () => boolean
  ): () => void {
    if (this.mutations.has(providerId)) {
      throw new Error('This provider is already being changed')
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

  isMutationReserved(providerId: string): boolean {
    return this.mutations.has(providerId)
  }
}
