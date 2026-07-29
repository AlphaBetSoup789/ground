export type JsonPrimitive = null | boolean | number | string
export type JsonArray = JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new Set<object>())
}

export function assertJsonValue(
  value: unknown,
  label = 'Value'
): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError(`${label} must be composed only of JSON-safe values`)
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainRecord(value) && isJsonValue(value)
}

export function assertJsonObject(
  value: unknown,
  label = 'Value'
): asserts value is JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be a JSON-safe object`)
  }
}

function isJsonValueInternal(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) return false
      const propertyNames = Object.getOwnPropertyNames(value)
      if (propertyNames.length !== value.length + 1 || !propertyNames.includes('length')) {
        return false
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false
        if (!isJsonValueInternal(value[index], ancestors)) return false
      }
      return true
    }

    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
      return false
    }
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false
      if (!isJsonValueInternal(descriptor.value, ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
