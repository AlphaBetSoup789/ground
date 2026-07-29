import { describe, expect, it } from 'vitest'
import {
  RuntimeSecretStreamRedactor,
  createRuntimeSecretRedactionPlan,
  redactRuntimeSecrets,
  runtimeTextContainsSecret
} from './runtime-secret-redaction'

describe('runtime secret redaction', () => {
  it('redacts raw and JSON-escaped values without retaining caller input', () => {
    const secret = 'token-"quoted"\\tail'
    const escaped = JSON.stringify(secret).slice(1, -1)
    const plan = createRuntimeSecretRedactionPlan([secret])

    expect(runtimeTextContainsSecret(`raw=${secret}`, plan)).toBe(true)
    expect(runtimeTextContainsSecret(`json=${escaped}`, plan)).toBe(true)
    expect(redactRuntimeSecrets(`raw=${secret}; json=${escaped}`, plan))
      .not.toContain(secret)
    expect(redactRuntimeSecrets(`raw=${secret}; json=${escaped}`, plan))
      .not.toContain(escaped)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.patterns)).toBe(true)
  })

  it('redacts secrets split across arbitrary assistant deltas', () => {
    const secret = 'runtime-secret-value'
    const plan = createRuntimeSecretRedactionPlan([secret])
    const redactor = new RuntimeSecretStreamRedactor(plan)
    const output = [
      redactor.push('before runtime-'),
      redactor.push('secret-'),
      redactor.push('value after'),
      redactor.finish()
    ].join('')

    expect(output).toContain('before ')
    expect(output).toContain(' after')
    expect(output).not.toContain(secret)
    expect(output).toContain(plan.marker)
  })

  it('redacts an astral secret split between its UTF-16 surrogates', () => {
    const secret = 'ab😀cd'
    const plan = createRuntimeSecretRedactionPlan([secret])
    const redactor = new RuntimeSecretStreamRedactor(plan)
    const emojiIndex = secret.indexOf('😀')
    const output = [
      redactor.push(secret.slice(0, emojiIndex + 1)),
      redactor.push(secret.slice(emojiIndex + 1)),
      redactor.finish()
    ].join('')

    expect(output).toBe(plan.marker)
    expect(output).not.toContain(secret)
  })

  it('redacts a trailing secret prefix instead of leaking partial material', () => {
    const plan = createRuntimeSecretRedactionPlan(['credential-value'])
    const redactor = new RuntimeSecretStreamRedactor(plan)
    const output = `${redactor.push('safe credential-')}${redactor.finish()}`

    expect(output).toBe(`safe ${plan.marker}`)
    expect(output).not.toContain('credential-')
  })

  it('retains only a possible secret prefix instead of delaying unrelated text', () => {
    const plan = createRuntimeSecretRedactionPlan([
      `token-${'x'.repeat(10_000)}`
    ])
    const redactor = new RuntimeSecretStreamRedactor(plan)

    expect(redactor.push('Immediate output.')).toBe('Immediate output.')
    expect(redactor.push(' token-')).toBe(' ')
    expect(redactor.finish()).toBe(plan.marker)
  })

  it('redacts overlapping repeated-character secrets', () => {
    const plan = createRuntimeSecretRedactionPlan(['aaaa'])
    const redactor = new RuntimeSecretStreamRedactor(plan)

    expect(`${redactor.push('aaaa')}${redactor.finish()}`).toBe(plan.marker)
  })

  it('ignores empty and too-short values that would over-redact output', () => {
    const plan = createRuntimeSecretRedactionPlan(['', 'abc'])
    expect(plan.patterns).toEqual([])
    expect(redactRuntimeSecrets('abc remains readable', plan)).toBe(
      'abc remains readable'
    )
  })
})
