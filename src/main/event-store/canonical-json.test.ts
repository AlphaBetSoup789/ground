import { describe, expect, it } from 'vitest'
import {
  CanonicalJsonError,
  encodeCanonicalJson,
  parseCanonicalJson
} from './canonical-json'

describe('canonical JSON', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(
      encodeCanonicalJson({
        z: [{ beta: 2, alpha: 1 }, 0, -0],
        a: 'ground'
      })
    ).toBe(
      '{"a":"ground","z":[{"alpha":1,"beta":2},0,0]}'
    )
  })

  it('rejects coercible or omitted JavaScript values', () => {
    expect(() => encodeCanonicalJson({ missing: undefined })).toThrow(
      CanonicalJsonError
    )
    expect(() => encodeCanonicalJson(Number.NaN)).toThrow(
      CanonicalJsonError
    )
    expect(() => encodeCanonicalJson(new Date())).toThrow(
      CanonicalJsonError
    )
  })

  it('rejects alternate encodings and duplicate-key JSON', () => {
    expect(() => parseCanonicalJson(' { "a": 1 } ')).toThrow(
      /not canonically encoded/
    )
    expect(() => parseCanonicalJson('{"a":1,"a":1}')).toThrow(
      /not canonically encoded/
    )
    expect(parseCanonicalJson('{"a":1,"b":[true,null]}')).toEqual({
      a: 1,
      b: [true, null]
    })
  })

  it('enforces byte, depth, node, and cycle bounds', () => {
    expect(() =>
      encodeCanonicalJson('ground', { maxBytes: 3 })
    ).toThrow(/byte limit/)
    expect(() =>
      encodeCanonicalJson({ a: { b: true } }, { maxDepth: 1 })
    ).toThrow(/depth limit/)
    expect(() =>
      encodeCanonicalJson([1, 2, 3], { maxNodes: 3 })
    ).toThrow(/node limit/)

    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => encodeCanonicalJson(cyclic)).toThrow(/cycle/)
  })
})
