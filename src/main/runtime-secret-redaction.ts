export interface RuntimeSecretRedactionPlan {
  readonly patterns: readonly string[]
  readonly marker: string
}

interface CompiledRedactionPattern {
  readonly value: string
  readonly failure: Uint32Array
}

const COMPILED_PATTERNS = new WeakMap<
  RuntimeSecretRedactionPlan,
  readonly CompiledRedactionPattern[]
>()
const MIN_REDACTED_PARTIAL_PATTERN_CHARACTERS = 4
const MAX_REDACTION_PATTERN_CHARACTERS = 1_000_000

function redactionMarker(patterns: readonly string[]): string {
  const usedCharacters = new Set<string>()
  for (const pattern of patterns) {
    for (let index = 0; index < pattern.length; index += 1) {
      usedCharacters.add(pattern[index] as string)
    }
  }
  if (!usedCharacters.has('█')) return '█'.repeat(4)
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCharCode(codePoint)
    if (!usedCharacters.has(candidate)) return candidate.repeat(4)
  }
  for (let codePoint = 0x00a1; codePoint <= 0xd7ff; codePoint += 1) {
    const candidate = String.fromCharCode(codePoint)
    if (!usedCharacters.has(candidate)) return candidate.repeat(4)
  }
  for (let codePoint = 0xf900; codePoint <= 0xfffd; codePoint += 1) {
    const candidate = String.fromCharCode(codePoint)
    if (!usedCharacters.has(candidate)) return candidate.repeat(4)
  }
  for (let codePoint = 0x21; codePoint <= 0x7e; codePoint += 1) {
    const candidate = String.fromCharCode(codePoint)
    if (!usedCharacters.has(candidate)) return candidate.repeat(4)
  }
  throw new Error('Unable to construct a safe runtime redaction marker')
}

export function createRuntimeSecretRedactionPlan(
  values: Iterable<string>
): RuntimeSecretRedactionPlan {
  const patterns = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 4) continue
    patterns.add(value)
    const serialized = JSON.stringify(value)
    patterns.add(serialized.slice(1, -1))
  }
  const sortedPatterns = Object.freeze(
    [...patterns].sort(
      (left, right) =>
        right.length - left.length || left.localeCompare(right)
    )
  )
  const patternCharacters = sortedPatterns.reduce(
    (total, pattern) => total + pattern.length,
    0
  )
  if (patternCharacters > MAX_REDACTION_PATTERN_CHARACTERS) {
    throw new Error('Runtime credential redaction patterns exceeded their size limit')
  }
  return Object.freeze({
    patterns: sortedPatterns,
    marker: sortedPatterns.length ? redactionMarker(sortedPatterns) : ''
  })
}

function patternFailureTable(pattern: string): Uint32Array {
  const failure = new Uint32Array(pattern.length)
  let matched = 0
  for (let index = 1; index < pattern.length; index += 1) {
    const character = pattern[index] as string
    while (
      matched > 0 &&
      pattern[matched] !== character
    ) {
      matched = failure[matched - 1] as number
    }
    if (pattern[matched] === character) matched += 1
    failure[index] = matched
  }
  return failure
}

function compiledRedactionPatterns(
  plan: RuntimeSecretRedactionPlan
): readonly CompiledRedactionPattern[] {
  const cached = COMPILED_PATTERNS.get(plan)
  if (cached) return cached

  const compiled = Object.freeze(
    plan.patterns.map((value) =>
      Object.freeze({
        value,
        failure: patternFailureTable(value)
      })
    )
  )
  COMPILED_PATTERNS.set(plan, compiled)
  return compiled
}

export function runtimeTextContainsSecret(
  value: string,
  plan: RuntimeSecretRedactionPlan
): boolean {
  return plan.patterns.some((pattern) => value.includes(pattern))
}

export function redactRuntimeSecrets(
  value: string,
  plan: RuntimeSecretRedactionPlan
): string {
  if (!plan.patterns.length) return value
  const redactor = new RuntimeSecretStreamRedactor(plan)
  return `${redactor.push(value)}${redactor.finish()}`
}

export class RuntimeSecretStreamRedactor {
  private pending = ''
  private readonly patterns: readonly CompiledRedactionPattern[]
  private readonly matchedPrefixLengths: Uint32Array

  constructor(private readonly plan: RuntimeSecretRedactionPlan) {
    this.patterns = compiledRedactionPatterns(plan)
    this.matchedPrefixLengths = new Uint32Array(this.patterns.length)
  }

  push(chunk: string): string {
    if (!this.plan.patterns.length) return chunk
    let output = ''
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index] as string
      this.pending += character
      let completedPatternLength = 0
      let retainedPrefixLength = 0

      for (
        let patternIndex = 0;
        patternIndex < this.patterns.length;
        patternIndex += 1
      ) {
        const pattern = this.patterns[patternIndex] as CompiledRedactionPattern
        let matched = this.matchedPrefixLengths[patternIndex] as number
        while (
          matched > 0 &&
          pattern.value[matched] !== character
        ) {
          matched = pattern.failure[matched - 1] as number
        }
        if (pattern.value[matched] === character) matched += 1
        this.matchedPrefixLengths[patternIndex] = matched
        if (matched === pattern.value.length) {
          completedPatternLength = Math.max(
            completedPatternLength,
            pattern.value.length
          )
        } else {
          retainedPrefixLength = Math.max(retainedPrefixLength, matched)
        }
      }

      if (completedPatternLength > 0) {
        output += this.pending.slice(0, -completedPatternLength)
        output += this.plan.marker
        this.pending = ''
        this.matchedPrefixLengths.fill(0)
        continue
      }

      const safeCharacters = this.pending.length - retainedPrefixLength
      if (safeCharacters > 0) {
        output += this.pending.slice(0, safeCharacters)
        this.pending = this.pending.slice(safeCharacters)
      }
    }
    return output
  }

  finish(): string {
    if (!this.plan.patterns.length) return ''
    const output =
      this.pending.length >= MIN_REDACTED_PARTIAL_PATTERN_CHARACTERS
        ? this.plan.marker
        : this.pending
    this.pending = ''
    this.matchedPrefixLengths.fill(0)
    return output
  }
}
