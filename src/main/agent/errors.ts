export type ProviderErrorCategory =
  | 'cancelled'
  | 'authentication'
  | 'permission'
  | 'billing'
  | 'quota'
  | 'rate-limit'
  | 'invalid-request'
  | 'not-found'
  | 'model-not-found'
  | 'context-limit'
  | 'request-too-large'
  | 'conflict'
  | 'safety'
  | 'timeout'
  | 'network'
  | 'overloaded'
  | 'server'
  | 'protocol'
  | 'executable-not-found'
  | 'process-exit'
  | 'unknown'

export interface ProviderErrorOptions {
  category: ProviderErrorCategory
  retryable?: boolean
  status?: number
  providerCode?: string
  requestId?: string
  retryAfterMs?: number
  partialOutput?: boolean
  cause?: unknown
}

export interface HttpProviderErrorInput {
  status: number
  message: string
  providerCode?: string
  requestId?: string
  retryAfter?: string | number
  partialOutput?: boolean
  cause?: unknown
}

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory
  readonly retryable: boolean
  readonly status?: number
  readonly providerCode?: string
  readonly requestId?: string
  readonly retryAfterMs?: number
  readonly partialOutput: boolean

  constructor(message: string, options: ProviderErrorOptions) {
    super(message)
    this.name = 'ProviderError'
    this.category = options.category
    this.retryable = options.retryable ?? isRetryableCategory(options.category)
    this.status = options.status
    this.providerCode = options.providerCode
    this.requestId = options.requestId
    this.retryAfterMs = options.retryAfterMs
    this.partialOutput = options.partialOutput ?? false
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false
      })
    }
  }

  withPartialOutput(partialOutput = true): ProviderError {
    if (this.partialOutput === partialOutput) return this
    return new ProviderError(this.message, {
      category: this.category,
      retryable: this.retryable,
      status: this.status,
      providerCode: this.providerCode,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
      partialOutput,
      cause: this
    })
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      status: this.status,
      providerCode: this.providerCode,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
      partialOutput: this.partialOutput
    }
  }
}

export function providerErrorFromHttp(
  input: HttpProviderErrorInput,
  now = Date.now()
): ProviderError {
  const category = classifyProviderFailure(input.status, input.providerCode)
  return new ProviderError(input.message, {
    category,
    status: input.status,
    providerCode: input.providerCode,
    requestId: input.requestId,
    retryAfterMs: parseRetryAfter(input.retryAfter, now),
    partialOutput: input.partialOutput,
    cause: input.cause
  })
}

export function cancelledProviderError(
  message = 'Provider operation was cancelled',
  cause?: unknown,
  partialOutput = false
): ProviderError {
  return new ProviderError(message, {
    category: 'cancelled',
    retryable: false,
    partialOutput,
    cause
  })
}

export function protocolProviderError(
  message: string,
  cause?: unknown,
  partialOutput = false
): ProviderError {
  return new ProviderError(message, {
    category: 'protocol',
    retryable: false,
    partialOutput,
    cause
  })
}

export function toProviderError(
  error: unknown,
  options: {
    signal?: AbortSignal
    partialOutput?: boolean
  } = {}
): ProviderError {
  const partialOutput = options.partialOutput ?? false
  if (options.signal?.aborted || isAbortLikeError(error)) {
    return cancelledProviderError(readableError(error, 'Provider operation was cancelled'), error, partialOutput)
  }
  if (error instanceof ProviderError) {
    return partialOutput ? error.withPartialOutput(true) : error
  }

  const loose = asLooseError(error)
  const status = readFiniteInteger(loose?.status) ?? readFiniteInteger(loose?.statusCode)
  const providerCode = typeof loose?.code === 'string' ? loose.code : undefined
  const message = readableError(error, 'Unknown provider error')
  if (status !== undefined) {
    return providerErrorFromHttp({
      status,
      message,
      providerCode,
      requestId:
        typeof loose?.requestId === 'string'
          ? loose.requestId
          : typeof loose?.request_id === 'string'
            ? loose.request_id
            : undefined,
      partialOutput,
      cause: error
    })
  }

  const normalizedCode = providerCode?.toUpperCase()
  const timeoutCodes = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT'])
  const networkCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE'
  ])
  const category: ProviderErrorCategory =
    normalizedCode && timeoutCodes.has(normalizedCode)
      ? 'timeout'
      : normalizedCode && networkCodes.has(normalizedCode)
        ? 'network'
        : error instanceof TypeError
          ? 'network'
          : 'unknown'
  return new ProviderError(message, {
    category,
    providerCode,
    partialOutput,
    cause: error
  })
}

export function classifyProviderFailure(
  status?: number,
  providerCode?: string
): ProviderErrorCategory {
  const code = providerCode?.toLowerCase()
  if (code) {
    if (['cancelled', 'canceled'].includes(code)) return 'cancelled'
    if (code.includes('authentication') || code === 'unauthorized') return 'authentication'
    if (code.includes('permission') || code === 'forbidden') return 'permission'
    if (code.includes('billing')) return 'billing'
    if (code.includes('quota') || code === 'insufficient_quota') return 'quota'
    if (code.includes('rate_limit') || code === 'resource_exhausted') return 'rate-limit'
    if (code.includes('model_not_found')) return 'model-not-found'
    if (code.includes('not_found')) return 'not-found'
    if (code.includes('context') && (code.includes('length') || code.includes('window'))) {
      return 'context-limit'
    }
    if (code.includes('too_large')) return 'request-too-large'
    if (code.includes('invalid') || code.includes('bad_request')) return 'invalid-request'
    if (
      ['safety', 'recitation', 'prohibited_content', 'spii', 'blocklist'].includes(code)
    ) {
      return 'safety'
    }
    if (code.includes('timeout') || code === 'deadline_exceeded') return 'timeout'
    if (code.includes('overloaded') || code === 'service_unavailable') return 'overloaded'
  }

  switch (status) {
    case 400:
    case 422:
      return 'invalid-request'
    case 401:
      return 'authentication'
    case 402:
      return 'billing'
    case 403:
      return 'permission'
    case 404:
      return 'not-found'
    case 408:
    case 504:
      return 'timeout'
    case 409:
      return 'conflict'
    case 413:
      return 'request-too-large'
    case 429:
      return 'rate-limit'
    case 499:
      return 'cancelled'
    case 503:
    case 529:
      return 'overloaded'
    default:
      if (status !== undefined && status >= 500) return 'server'
      return 'unknown'
  }
}

export function parseRetryAfter(
  value: string | number | undefined,
  now = Date.now()
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined
    return Math.round(value * 1_000)
  }
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const timestamp = Date.parse(trimmed)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, timestamp - now)
}

export function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const loose = error as Record<string, unknown>
  return (
    loose.name === 'AbortError' ||
    loose.code === 'ABORT_ERR' ||
    loose.code === 'ERR_ABORTED'
  )
}

function isRetryableCategory(category: ProviderErrorCategory): boolean {
  return ['rate-limit', 'timeout', 'network', 'overloaded', 'server', 'conflict'].includes(
    category
  )
}

function readableError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}

function asLooseError(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined
}

function readFiniteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}
