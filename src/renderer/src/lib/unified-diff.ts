export const UNIFIED_DIFF_BOUNDS = Object.freeze({
  inputCharacters: 1_000_000,
  files: 512,
  hunks: 2_048,
  lines: 50_000,
  lineCharacters: 100_000
})

export type UnifiedDiffFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'binary'
  | 'unknown'

export type UnifiedDiffLineKind =
  | 'context'
  | 'addition'
  | 'deletion'
  | 'note'

export interface UnifiedDiffLine {
  readonly kind: UnifiedDiffLineKind
  readonly raw: string
  readonly content: string
  readonly oldLine?: number
  readonly newLine?: number
}

export interface UnifiedDiffHunk {
  readonly id: string
  readonly header: string
  readonly section?: string
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly complete: boolean
  readonly lines: readonly UnifiedDiffLine[]
}

export type UnifiedDiffIssue =
  | 'binary'
  | 'combined-diff'
  | 'file-limit'
  | 'hunk-limit'
  | 'incomplete-hunk'
  | 'input-limit'
  | 'line-limit'
  | 'line-too-long'
  | 'malformed'
  | 'missing-file-header'
  | 'unsupported'

export interface UnifiedDiffFile {
  readonly id: string
  readonly displayPath: string
  readonly oldPath?: string
  readonly newPath?: string
  readonly status: UnifiedDiffFileStatus
  readonly additions: number
  readonly deletions: number
  readonly metadata: readonly string[]
  readonly hunks: readonly UnifiedDiffHunk[]
  readonly raw: string
  readonly structured: boolean
  readonly issue?: UnifiedDiffIssue
}

export interface ParsedUnifiedDiff {
  readonly raw: string
  readonly files: readonly UnifiedDiffFile[]
  readonly inputTruncated: boolean
  readonly issue?: UnifiedDiffIssue
}

interface ParserBudget {
  hunks: number
  lines: number
}

interface HunkRange {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  section?: string
}

const FILE_HEADER_PATTERN = /^diff --git /gmu
const HUNK_HEADER_PATTERN =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/u
const INDEX_METADATA_PATTERN =
  /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/iu
const MODE_METADATA_PATTERN =
  /^(?:old mode|new mode|deleted file mode|new file mode) [0-7]{6}$/u
const SIMILARITY_METADATA_PATTERN =
  /^(?:similarity|dissimilarity) index \d{1,3}%$/u
const PATH_METADATA_PATTERN =
  /^(?:rename|copy) (?:from|to) .+$/u
const MARKER_METADATA_PATTERN = /^(?:---|\+\+\+) .+$/u
const DISPLAY_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu
const RAW_DISPLAY_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export function safeDiffDisplayText(value: string): string {
  return value.replace(DISPLAY_CONTROL_PATTERN, escapeDisplayCharacter)
}

export function safeRawDiffDisplayText(value: string): string {
  return value.replace(
    RAW_DISPLAY_CONTROL_PATTERN,
    escapeDisplayCharacter
  )
}

export function parseUnifiedDiff(input: string): ParsedUnifiedDiff {
  const inputTruncated = input.length > UNIFIED_DIFF_BOUNDS.inputCharacters
  const raw = inputTruncated
    ? safePrefix(input, UNIFIED_DIFF_BOUNDS.inputCharacters)
    : input
  if (!raw) {
    return {
      raw,
      files: [],
      inputTruncated,
      ...(inputTruncated ? { issue: 'input-limit' as const } : {})
    }
  }

  const starts: number[] = []
  for (const match of raw.matchAll(FILE_HEADER_PATTERN)) {
    if (match.index === undefined) continue
    starts.push(match.index)
    if (starts.length > UNIFIED_DIFF_BOUNDS.files) break
  }
  const segments: string[] = []
  if (!starts.length) {
    segments.push(raw)
  } else {
    const firstStart = starts[0] ?? 0
    if (firstStart > 0 && raw.slice(0, firstStart).trim()) {
      segments.push(raw.slice(0, firstStart))
    }
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index]
      if (start === undefined) continue
      segments.push(raw.slice(start, starts[index + 1] ?? raw.length))
    }
  }

  const budget: ParserBudget = { hunks: 0, lines: 0 }
  const files: UnifiedDiffFile[] = []
  let issue: UnifiedDiffIssue | undefined = inputTruncated
    ? 'input-limit'
    : undefined
  for (const segment of segments) {
    if (files.length >= UNIFIED_DIFF_BOUNDS.files) {
      issue = 'file-limit'
      break
    }
    const file = parseFileSegment(segment, files.length, budget)
    files.push(file)
    issue ??= file.issue
  }

  return {
    raw,
    files,
    inputTruncated,
    ...(issue ? { issue } : {})
  }
}

function parseFileSegment(
  raw: string,
  fileIndex: number,
  budget: ParserBudget
): UnifiedDiffFile {
  const id = `diff-file-${fileIndex + 1}`
  const inspection = inspectPhysicalLines(raw)
  const remainingLines = UNIFIED_DIFF_BOUNDS.lines - budget.lines
  if (inspection.lines > remainingLines) {
    budget.lines = UNIFIED_DIFF_BOUNDS.lines
    const [oldPath, newPath] = boundedHeaderPaths(raw)
    return unstructuredFile(
      id,
      raw,
      'line-limit',
      oldPath,
      newPath
    )
  }
  budget.lines += inspection.lines
  if (inspection.lineTooLong) {
    const [oldPath, newPath] = boundedHeaderPaths(raw)
    return unstructuredFile(
      id,
      raw,
      'line-too-long',
      oldPath,
      newPath
    )
  }
  const lines = raw.split(/\r?\n/u)
  const header = lines[0] ?? ''
  if (!header.startsWith('diff --git ')) {
    return unstructuredFile(id, raw, 'missing-file-header')
  }
  const headerDetails = parseDiffGitHeaderDetails(header)
  const headerPaths = headerDetails.paths
  let oldPath = headerPaths[0]
  let newPath = headerPaths[1]
  let oldPathDeclared = false
  let newPathDeclared = false
  const metadata: string[] = [header]
  const hunks: UnifiedDiffHunk[] = []
  let additions = 0
  let deletions = 0
  let current: {
    range: HunkRange
    header: string
    lines: UnifiedDiffLine[]
    oldLine: number
    newLine: number
    oldConsumed: number
    newConsumed: number
  } | undefined
  let issue: UnifiedDiffIssue | undefined

  const finishHunk = (): void => {
    if (!current) return
    const complete =
      current.oldConsumed === current.range.oldCount &&
      current.newConsumed === current.range.newCount
    if (!complete) issue ??= 'incomplete-hunk'
    hunks.push({
      id: `${id}-hunk-${hunks.length + 1}`,
      header: current.header,
      ...current.range,
      complete,
      lines: current.lines
    })
    current = undefined
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (
      current &&
      line === '' &&
      index === lines.length - 1 &&
      /\r?\n$/u.test(raw)
    ) {
      continue
    }
    if (line.startsWith('@@@')) {
      return unstructuredFile(
        id,
        raw,
        'combined-diff',
        oldPath,
        newPath
      )
    }
    if (line.startsWith('@@')) {
      finishHunk()
      const range = parseHunkRange(line)
      if (!range) {
        return unstructuredFile(id, raw, 'malformed', oldPath, newPath)
      }
      if (budget.hunks >= UNIFIED_DIFF_BOUNDS.hunks) {
        return unstructuredFile(id, raw, 'hunk-limit', oldPath, newPath)
      }
      budget.hunks += 1
      current = {
        range,
        header: line,
        lines: [],
        oldLine: range.oldStart,
        newLine: range.newStart,
        oldConsumed: 0,
        newConsumed: 0
      }
      continue
    }

    if (!current) {
      if (
        line.startsWith('Binary files ') ||
        line === 'GIT binary patch'
      ) {
        return binaryFile(
          id,
          raw,
          reliablePath(
            oldPath,
            oldPathDeclared,
            headerDetails.ambiguous
          ),
          reliablePath(
            newPath,
            newPathDeclared,
            headerDetails.ambiguous
          )
        )
      }
      if (!supportedMetadataLine(line)) {
        return unstructuredFile(
          id,
          raw,
          'unsupported',
          reliablePath(
            oldPath,
            oldPathDeclared,
            headerDetails.ambiguous
          ),
          reliablePath(
            newPath,
            newPathDeclared,
            headerDetails.ambiguous
          )
        )
      }
      metadata.push(line)
      if (line.startsWith('--- ')) {
        oldPath = markerPath(line.slice(4))
        oldPathDeclared = true
      }
      if (line.startsWith('+++ ')) {
        newPath = markerPath(line.slice(4))
        newPathDeclared = true
      }
      if (
        line.startsWith('rename from ') ||
        line.startsWith('copy from ')
      ) {
        oldPath = extendedHeaderPath(line.slice(line.indexOf(' from ') + 6))
        oldPathDeclared = true
      }
      if (
        line.startsWith('rename to ') ||
        line.startsWith('copy to ')
      ) {
        newPath = extendedHeaderPath(line.slice(line.indexOf(' to ') + 4))
        newPathDeclared = true
      }
      continue
    }

    if (line.startsWith('\\ No newline at end of file')) {
      current.lines.push({
        kind: 'note',
        raw: line,
        content: line
      })
      continue
    }
    const kind = diffLineKind(line)
    if (!kind) {
      return unstructuredFile(id, raw, 'malformed', oldPath, newPath)
    }
    const content = line.slice(1)
    if (kind === 'addition') {
      current.lines.push({
        kind,
        raw: line,
        content,
        newLine: current.newLine
      })
      current.newLine += 1
      current.newConsumed += 1
      additions += 1
    } else if (kind === 'deletion') {
      current.lines.push({
        kind,
        raw: line,
        content,
        oldLine: current.oldLine
      })
      current.oldLine += 1
      current.oldConsumed += 1
      deletions += 1
    } else {
      current.lines.push({
        kind,
        raw: line,
        content,
        oldLine: current.oldLine,
        newLine: current.newLine
      })
      current.oldLine += 1
      current.newLine += 1
      current.oldConsumed += 1
      current.newConsumed += 1
    }
  }
  finishHunk()

  if (
    headerDetails.ambiguous &&
    !(oldPathDeclared && newPathDeclared)
  ) {
    return unstructuredFile(
      id,
      raw,
      'unsupported',
      oldPathDeclared ? oldPath : undefined,
      newPathDeclared ? newPath : undefined
    )
  }
  const status = fileStatus(metadata, oldPath, newPath)
  if (status === 'binary') {
    return binaryFile(id, raw, oldPath, newPath)
  }
  const displayPath = displayFilePath(oldPath, newPath, headerPaths)
  return {
    id,
    displayPath,
    ...(oldPath ? { oldPath } : {}),
    ...(newPath ? { newPath } : {}),
    status,
    additions,
    deletions,
    metadata,
    hunks,
    raw,
    structured: true,
    ...(issue ? { issue } : {})
  }
}

function parseHunkRange(line: string): HunkRange | undefined {
  const match = HUNK_HEADER_PATTERN.exec(line)
  if (!match) return undefined
  const oldStart = Number(match[1])
  const oldCount = match[2] === undefined ? 1 : Number(match[2])
  const newStart = Number(match[3])
  const newCount = match[4] === undefined ? 1 : Number(match[4])
  if (
    ![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)
  ) {
    return undefined
  }
  return {
    oldStart,
    oldCount,
    newStart,
    newCount,
    ...(match[5] ? { section: safeDiffDisplayText(match[5]) } : {})
  }
}

function diffLineKind(
  line: string
): Exclude<UnifiedDiffLineKind, 'note'> | undefined {
  if (line.startsWith('+')) return 'addition'
  if (line.startsWith('-')) return 'deletion'
  if (line.startsWith(' ')) return 'context'
  return undefined
}

function markerPath(value: string): string | undefined {
  const path = value.split('\t', 1)[0]?.trim()
  if (!path || path === '/dev/null') return undefined
  return stripDiffPrefix(unquoteGitToken(path))
}

function parseDiffGitHeader(line: string): [string?, string?] {
  return parseDiffGitHeaderDetails(line).paths
}

function parseDiffGitHeaderDetails(line: string): {
  paths: [string?, string?]
  ambiguous: boolean
} {
  const tokenized = tokenizeGitHeader(line.slice('diff --git '.length))
  return {
    paths: [
      tokenized.tokens[0]
        ? stripDiffPrefix(tokenized.tokens[0])
        : undefined,
      tokenized.tokens[1]
        ? stripDiffPrefix(tokenized.tokens[1])
        : undefined
    ],
    ambiguous:
      !tokenized.complete || tokenized.tokens.length !== 2
  }
}

function boundedHeaderPaths(raw: string): [string?, string?] {
  const newline = raw.indexOf('\n')
  const end = newline === -1 ? raw.length : newline
  if (end > UNIFIED_DIFF_BOUNDS.lineCharacters) return []
  const header = raw.slice(0, end).replace(/\r$/u, '')
  return header.startsWith('diff --git ')
    ? parseDiffGitHeader(header)
    : []
}

function tokenizeGitHeader(value: string): {
  tokens: string[]
  complete: boolean
} {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  for (const character of value) {
    if (escaped) {
      current += `\\${character}`
      escaped = false
      continue
    }
    if (quoted && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') {
      quoted = !quoted
      current += character
      continue
    }
    if (!quoted && /\s/u.test(character)) {
      if (current) {
        tokens.push(unquoteGitToken(current))
        current = ''
      }
      continue
    }
    current += character
  }
  if (escaped) current += '\\'
  if (current) tokens.push(unquoteGitToken(current))
  return { tokens, complete: !quoted && !escaped }
}

function unquoteGitToken(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value
  const inner = value.slice(1, -1)
  let result = ''
  let octalBytes: number[] = []
  let octalSource = ''
  const flushOctalBytes = (): void => {
    if (!octalBytes.length) return
    try {
      result += UTF8_DECODER.decode(Uint8Array.from(octalBytes))
    } catch {
      result += octalSource
    }
    octalBytes = []
    octalSource = ''
  }

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index] ?? ''
    if (character !== '\\') {
      flushOctalBytes()
      result += character
      continue
    }
    const escaped = inner[index + 1]
    if (escaped === undefined) {
      flushOctalBytes()
      result += '\\'
      continue
    }
    if (/[0-7]/u.test(escaped)) {
      let digits = escaped
      while (
        digits.length < 3 &&
        /[0-7]/u.test(inner[index + digits.length + 1] ?? '')
      ) {
        digits += inner[index + digits.length + 1]
      }
      const byte = Number.parseInt(digits, 8)
      if (byte > 0xff) {
        flushOctalBytes()
        result += `\\${digits}`
      } else {
        octalBytes.push(byte)
        octalSource += `\\${digits}`
      }
      index += digits.length
      continue
    }
    flushOctalBytes()
    const replacement = cEscapeReplacement(escaped)
    result += replacement ?? `\\${escaped}`
    index += 1
  }
  flushOctalBytes()
  return result
}

function stripDiffPrefix(value: string): string {
  return value.startsWith('a/') || value.startsWith('b/')
    ? value.slice(2)
    : value
}

function displayFilePath(
  oldPath: string | undefined,
  newPath: string | undefined,
  headerPaths: [string?, string?]
): string {
  const candidate =
    newPath ?? oldPath ?? headerPaths[1] ?? headerPaths[0] ?? 'Unparsed patch'
  return safeDiffDisplayText(candidate) || 'Unparsed patch'
}

function fileStatus(
  metadata: readonly string[],
  oldPath: string | undefined,
  newPath: string | undefined
): UnifiedDiffFileStatus {
  if (
    metadata.some(
      (line) =>
        line.startsWith('Binary files ') ||
        line === 'GIT binary patch'
    )
  ) {
    return 'binary'
  }
  if (metadata.some((line) => line.startsWith('new file mode ')) || !oldPath) {
    return 'added'
  }
  if (
    metadata.some((line) => line.startsWith('deleted file mode ')) ||
    !newPath
  ) {
    return 'deleted'
  }
  if (
    metadata.some(
      (line) =>
        line.startsWith('rename from ') || line.startsWith('rename to ')
    ) ||
    oldPath !== newPath
  ) {
    return 'renamed'
  }
  return oldPath || newPath ? 'modified' : 'unknown'
}

function supportedMetadataLine(line: string): boolean {
  return (
    line === '' ||
    INDEX_METADATA_PATTERN.test(line) ||
    MODE_METADATA_PATTERN.test(line) ||
    SIMILARITY_METADATA_PATTERN.test(line) ||
    PATH_METADATA_PATTERN.test(line) ||
    MARKER_METADATA_PATTERN.test(line)
  )
}

function extendedHeaderPath(value: string): string | undefined {
  const path = value.trim()
  return path ? unquoteGitToken(path) : undefined
}

function reliablePath(
  value: string | undefined,
  declared: boolean,
  ambiguousHeader: boolean
): string | undefined {
  return declared || !ambiguousHeader ? value : undefined
}

function binaryFile(
  id: string,
  raw: string,
  oldPath?: string,
  newPath?: string
): UnifiedDiffFile {
  return {
    ...unstructuredFile(id, raw, 'binary', oldPath, newPath),
    status: 'binary'
  }
}

function unstructuredFile(
  id: string,
  raw: string,
  issue: UnifiedDiffIssue,
  oldPath?: string,
  newPath?: string
): UnifiedDiffFile {
  return {
    id,
    displayPath: displayFilePath(oldPath, newPath, [oldPath, newPath]),
    ...(oldPath ? { oldPath } : {}),
    ...(newPath ? { newPath } : {}),
    status: issue === 'binary' ? 'binary' : 'unknown',
    additions: 0,
    deletions: 0,
    metadata: [],
    hunks: [],
    raw,
    structured: false,
    issue
  }
}

function safePrefix(value: string, maximum: number): string {
  const prefix = value.slice(0, maximum)
  return /[\ud800-\udbff]$/u.test(prefix)
    ? prefix.slice(0, -1)
    : prefix
}

function inspectPhysicalLines(raw: string): {
  lines: number
  lineTooLong: boolean
} {
  if (!raw) return { lines: 0, lineTooLong: false }
  let lines = 1
  let lineCharacters = 0
  let lineTooLong = false
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    if (code === 0x0a) {
      if (index < raw.length - 1) lines += 1
      lineCharacters = 0
      continue
    }
    if (code === 0x0d && raw.charCodeAt(index + 1) === 0x0a) {
      continue
    }
    lineCharacters += 1
    if (lineCharacters > UNIFIED_DIFF_BOUNDS.lineCharacters) {
      lineTooLong = true
    }
  }
  return { lines, lineTooLong }
}

function escapeDisplayCharacter(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0
  return `\\u${codePoint.toString(16).padStart(4, '0')}`
}

function cEscapeReplacement(character: string): string | undefined {
  if (character === 'a') return '\u0007'
  if (character === 'b') return '\b'
  if (character === 't') return '\t'
  if (character === 'n') return '\n'
  if (character === 'v') return '\v'
  if (character === 'f') return '\f'
  if (character === 'r') return '\r'
  if (character === '\\' || character === '"') return character
  return undefined
}
