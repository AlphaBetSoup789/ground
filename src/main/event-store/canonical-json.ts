const DEFAULT_MAX_CANONICAL_JSON_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_CANONICAL_JSON_DEPTH = 256
const DEFAULT_MAX_CANONICAL_JSON_NODES = 5_000_000

export type CanonicalJsonPrimitive = null | boolean | number | string
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

export interface CanonicalJsonLimits {
  readonly maxBytes?: number
  readonly maxDepth?: number
  readonly maxNodes?: number
}

export class CanonicalJsonError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CanonicalJsonError'
  }
}

/**
 * Encode JSON with recursively sorted object keys and no insignificant
 * whitespace. Arrays retain their source order. Values outside the JSON data
 * model fail closed instead of inheriting JSON.stringify's omission/coercion
 * behavior.
 */
export function encodeCanonicalJson(
  value: unknown,
  limits: CanonicalJsonLimits = {}
): string {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_CANONICAL_JSON_BYTES
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_CANONICAL_JSON_DEPTH
  const maxNodes = limits.maxNodes ?? DEFAULT_MAX_CANONICAL_JSON_NODES
  assertPositiveLimit(maxBytes, 'maxBytes')
  assertPositiveLimit(maxDepth, 'maxDepth')
  assertPositiveLimit(maxNodes, 'maxNodes')

  const active = new Set<object>()
  let nodes = 0

  const encode = (candidate: unknown, depth: number): string => {
    nodes += 1
    if (nodes > maxNodes) {
      throw new CanonicalJsonError('Canonical JSON exceeds its node limit')
    }
    if (depth > maxDepth) {
      throw new CanonicalJsonError('Canonical JSON exceeds its depth limit')
    }

    if (candidate === null) return 'null'
    switch (typeof candidate) {
      case 'boolean':
        return candidate ? 'true' : 'false'
      case 'number':
        if (!Number.isFinite(candidate)) {
          throw new CanonicalJsonError(
            'Canonical JSON numbers must be finite'
          )
        }
        return Object.is(candidate, -0) ? '0' : String(candidate)
      case 'string':
        return JSON.stringify(candidate)
      case 'object':
        break
      default:
        throw new CanonicalJsonError(
          `Canonical JSON cannot encode ${typeof candidate}`
        )
    }

    if (active.has(candidate)) {
      throw new CanonicalJsonError('Canonical JSON cannot encode a cycle')
    }
    active.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        return `[${candidate
          .map((entry) => encode(entry, depth + 1))
          .join(',')}]`
      }

      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError(
          'Canonical JSON objects must have a plain or null prototype'
        )
      }

      const object = candidate as Record<string, unknown>
      const keys = Object.keys(object).sort()
      const entries = keys.map(
        (key) =>
          `${JSON.stringify(key)}:${encode(object[key], depth + 1)}`
      )
      return `{${entries.join(',')}}`
    } finally {
      active.delete(candidate)
    }
  }

  const encoded = encode(value, 0)
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new CanonicalJsonError('Canonical JSON exceeds its byte limit')
  }
  return encoded
}

/**
 * Parse and require the input itself to be the canonical encoding. This rejects
 * duplicate object keys, alternate number spellings, and hidden whitespace
 * rather than accepting them as another representation of the same authority.
 */
export function parseCanonicalJson(
  payload: string,
  limits: CanonicalJsonLimits = {}
): CanonicalJsonValue {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_CANONICAL_JSON_BYTES
  assertPositiveLimit(maxBytes, 'maxBytes')
  if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
    throw new CanonicalJsonError('Canonical JSON exceeds its byte limit')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    throw new CanonicalJsonError('Canonical JSON is malformed', {
      cause: error
    })
  }

  const canonical = encodeCanonicalJson(parsed, limits)
  if (canonical !== payload) {
    throw new CanonicalJsonError('JSON payload is not canonically encoded')
  }
  return parsed as CanonicalJsonValue
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CanonicalJsonError(`${name} must be a positive safe integer`)
  }
}
