import { describe, expect, it } from 'vitest'
import {
  ProviderOperationGate,
  type ProviderStartBinding
} from './provider-operation-gate'

function binding(
  overrides: Partial<ProviderStartBinding> = {}
): ProviderStartBinding {
  return {
    taskId: 'task-one',
    taskRevision: 'task-revision-one',
    providerId: 'provider-one',
    providerRevision: 'provider-revision-one',
    providerFingerprint: 'a'.repeat(64),
    credentialBoundary: 'credential-boundary-one',
    ...overrides
  }
}

describe('ProviderOperationGate', () => {
  it('holds provider mutations behind every in-flight start reservation', () => {
    const gate = new ProviderOperationGate()
    const first = gate.reserveStart(binding())
    const second = gate.reserveStart(
      binding({
        taskId: 'task-two',
        taskRevision: 'task-revision-two'
      })
    )

    expect(() =>
      gate.reserveMutation('provider-one', () => false)
    ).toThrow(/starting runs/i)
    gate.releaseStart(first)
    expect(() =>
      gate.reserveMutation('provider-one', () => false)
    ).toThrow(/starting runs/i)
    gate.releaseStart(second)

    const releaseMutation = gate.reserveMutation(
      'provider-one',
      () => false
    )
    releaseMutation()
  })

  it('preserves concurrency across unrelated providers', () => {
    const gate = new ProviderOperationGate()
    const start = gate.reserveStart(binding())
    const releaseMutation = gate.reserveMutation(
      'provider-two',
      () => false
    )

    expect(gate.isStartReserved('provider-one')).toBe(true)
    expect(gate.isMutationReserved('provider-two')).toBe(true)
    releaseMutation()
    gate.releaseStart(start)
  })

  it('serializes credential-bearing mutations across providers', () => {
    const gate = new ProviderOperationGate()
    const releaseFirst = gate.reserveMutation(
      'provider-one',
      () => false
    )

    expect(() =>
      gate.reserveMutation('provider-two', () => false)
    ).toThrow(/another provider/i)

    releaseFirst()
    const releaseSecond = gate.reserveMutation(
      'provider-two',
      () => false
    )
    releaseSecond()
  })

  it('rejects forged, released, or revision-mismatched reservations', () => {
    const gate = new ProviderOperationGate()
    const expected = binding()
    const start = gate.reserveStart(expected)

    expect(() =>
      gate.assertStartReservation(start, {
        ...expected,
        credentialBoundary: 'replacement-boundary'
      })
    ).toThrow(/changed while the run was starting/i)
    expect(() =>
      gate.assertStartReservation(
        { binding: expected },
        expected
      )
    ).toThrow(/changed while the run was starting/i)

    gate.releaseStart(start)
    expect(() =>
      gate.assertStartReservation(start, expected)
    ).toThrow(/changed while the run was starting/i)
  })

  it('blocks starts during a mutation and still checks active runs', () => {
    const gate = new ProviderOperationGate()
    const releaseMutation = gate.reserveMutation(
      'provider-one',
      () => false
    )
    expect(() => gate.reserveStart(binding())).toThrow(/provider change/i)
    releaseMutation()

    expect(() =>
      gate.reserveMutation('provider-one', () => true)
    ).toThrow(/active runs/i)
  })
})
