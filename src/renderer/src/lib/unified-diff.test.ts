import { describe, expect, it } from 'vitest'
import {
  parseUnifiedDiff,
  safeDiffDisplayText,
  safeRawDiffDisplayText,
  UNIFIED_DIFF_BOUNDS
} from './unified-diff'

const ordinary = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ export const value = 1
 export const value = 1
-export const oldName = true
+export const newName = true
+export const added = true
 export const tail = true
\\ No newline at end of file
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +10,2 @@
-old
+new
 context
@@ -20 +20,2 @@
 context
+second
`

describe('unified diff parser', () => {
  it('parses multiple files, hunks, line numbers, totals, and raw segments', () => {
    const parsed = parseUnifiedDiff(ordinary)

    expect(parsed.inputTruncated).toBe(false)
    expect(parsed.files).toHaveLength(2)
    const first = parsed.files[0]
    expect(first).toMatchObject({
      displayPath: 'src/a.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      structured: true
    })
    expect(first?.hunks).toHaveLength(1)
    expect(first?.hunks[0]?.lines).toEqual([
      {
        kind: 'context',
        raw: ' export const value = 1',
        content: 'export const value = 1',
        oldLine: 1,
        newLine: 1
      },
      {
        kind: 'deletion',
        raw: '-export const oldName = true',
        content: 'export const oldName = true',
        oldLine: 2
      },
      {
        kind: 'addition',
        raw: '+export const newName = true',
        content: 'export const newName = true',
        newLine: 2
      },
      {
        kind: 'addition',
        raw: '+export const added = true',
        content: 'export const added = true',
        newLine: 3
      },
      {
        kind: 'context',
        raw: ' export const tail = true',
        content: 'export const tail = true',
        oldLine: 3,
        newLine: 4
      },
      {
        kind: 'note',
        raw: '\\ No newline at end of file',
        content: '\\ No newline at end of file'
      }
    ])
    expect(first?.raw).toBe(ordinary.slice(0, ordinary.indexOf('diff --git a/src/b.ts')))
    expect(parsed.files[1]?.hunks).toHaveLength(2)
  })

  it('derives create, delete, rename, and binary status conservatively', () => {
    const input = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-old
diff --git a/before name.txt b/after name.txt
similarity index 100%
rename from before name.txt
rename to after name.txt
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`
    const parsed = parseUnifiedDiff(input)

    expect(parsed.files.map((file) => file.status)).toEqual([
      'added',
      'deleted',
      'renamed',
      'binary'
    ])
    expect(parsed.files[2]).toMatchObject({
      displayPath: 'after name.txt',
      structured: true
    })
    expect(parsed.files[3]).toMatchObject({
      displayPath: 'image.png',
      structured: false,
      issue: 'binary'
    })
  })

  it('retains malformed, combined, and headerless patches as raw fallback', () => {
    const malformed = parseUnifiedDiff(`diff --git a/a b/a
--- a/a
+++ b/a
@@ malformed @@
+text`)
    const combined = parseUnifiedDiff(`diff --git a/a b/a
@@@ -1,1 -1,1 +1,1 @@@
++text`)
    const headerless = parseUnifiedDiff('--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new')
    const unsupportedMetadata = parseUnifiedDiff(`diff --git a/a b/a
index 1111111..2222222 100644
this is not unified diff metadata
--- a/a
+++ b/a`)
    const ambiguousModeOnly = parseUnifiedDiff(`diff --git a/file name.txt b/file name.txt
old mode 100644
new mode 100755`)

    expect(malformed.files[0]).toMatchObject({
      structured: false,
      issue: 'malformed'
    })
    expect(malformed.files[0]?.raw).toContain('@@ malformed @@')
    expect(combined.files[0]).toMatchObject({
      structured: false,
      issue: 'combined-diff'
    })
    expect(headerless.files[0]).toMatchObject({
      structured: false,
      issue: 'missing-file-header'
    })
    expect(unsupportedMetadata.files[0]).toMatchObject({
      structured: false,
      issue: 'unsupported'
    })
    expect(ambiguousModeOnly.files[0]).toMatchObject({
      structured: false,
      issue: 'unsupported'
    })
  })

  it('escapes display controls and bidi characters without altering raw data', () => {
    const dangerous = 'src/\u202eevil\u0007.ts'
    const input = `diff --git "a/${dangerous}" "b/${dangerous}"
--- "a/${dangerous}"
+++ "b/${dangerous}"
@@ -1 +1 @@
-old
+new`
    const parsed = parseUnifiedDiff(input)

    expect(parsed.files[0]?.displayPath).toBe(
      'src/\\u202eevil\\u0007.ts'
    )
    expect(parsed.files[0]?.raw).toContain(dangerous)
    expect(safeDiffDisplayText('\u2066x\u2069')).toBe(
      '\\u2066x\\u2069'
    )
    expect(
      safeDiffDisplayText('\u061c\u200b\u200e\u200f\u2028\u2029\ufeff')
    ).toBe(
      '\\u061c\\u200b\\u200e\\u200f\\u2028\\u2029\\ufeff'
    )
    expect(safeRawDiffDisplayText('\tline\n\u202e\u001b')).toBe(
      '\tline\n\\u202e\\u001b'
    )
  })

  it('decodes valid Git-quoted UTF-8 paths and preserves invalid byte escapes', () => {
    const utf8 = parseUnifiedDiff(String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"
--- "a/caf\303\251.txt"
+++ "b/caf\303\251.txt"
@@ -1 +1 @@
-old
+new`)
    const invalid = parseUnifiedDiff(String.raw`diff --git "a/bad\377.txt" "b/bad\377.txt"
--- "a/bad\377.txt"
+++ "b/bad\377.txt"
@@ -1 +1 @@
-old
+new`)
    const spaced = parseUnifiedDiff(`diff --git a/file name.txt b/file name.txt
--- a/file name.txt
+++ b/file name.txt
@@ -1 +1 @@
-old
+new`)

    expect(utf8.files[0]).toMatchObject({
      displayPath: 'café.txt',
      oldPath: 'café.txt',
      newPath: 'café.txt'
    })
    expect(invalid.files[0]).toMatchObject({
      displayPath: 'bad\\377.txt',
      oldPath: 'bad\\377.txt',
      newPath: 'bad\\377.txt'
    })
    expect(spaced.files[0]).toMatchObject({
      displayPath: 'file name.txt',
      oldPath: 'file name.txt',
      newPath: 'file name.txt',
      structured: true
    })
  })

  it('reports incomplete hunks while retaining safe structured rows', () => {
    const parsed = parseUnifiedDiff(`diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,3 +1,3 @@
 line one
-line two`)

    expect(parsed.files[0]).toMatchObject({
      structured: true,
      issue: 'incomplete-hunk'
    })
    expect(parsed.files[0]?.hunks[0]?.complete).toBe(false)
  })

  it('bounds oversized input and lines without throwing or splitting surrogates', () => {
    const oversized =
      `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n+` +
      'x'.repeat(UNIFIED_DIFF_BOUNDS.inputCharacters) +
      '\ud83dextra'
    const parsed = parseUnifiedDiff(oversized)
    expect(parsed.inputTruncated).toBe(true)
    expect(parsed.raw.length).toBeLessThanOrEqual(
      UNIFIED_DIFF_BOUNDS.inputCharacters
    )
    expect(parsed.issue).toBe('input-limit')

    const longLine = parseUnifiedDiff(
      `diff --git a/a b/a\n${'x'.repeat(
        UNIFIED_DIFF_BOUNDS.lineCharacters + 1
      )}`
    )
    expect(longLine.files[0]).toMatchObject({
      structured: false,
      issue: 'line-too-long'
    })
  })

  it('caps hostile file fan-out after accepting the exact file limit', () => {
    const input = Array.from(
      { length: UNIFIED_DIFF_BOUNDS.files + 1 },
      (_, index) =>
        `diff --git a/file-${index}.txt b/file-${index}.txt\n` +
        `--- a/file-${index}.txt\n` +
        `+++ b/file-${index}.txt\n` +
        (index === 0
          ? `Binary files a/file-${index}.txt and b/file-${index}.txt differ\n`
          : '')
    ).join('')
    const parsed = parseUnifiedDiff(input)

    expect(parsed.inputTruncated).toBe(false)
    expect(parsed.raw).toBe(input)
    expect(parsed.files).toHaveLength(UNIFIED_DIFF_BOUNDS.files)
    expect(parsed.files[0]).toMatchObject({
      structured: false,
      issue: 'binary'
    })
    expect(parsed.files.at(-1)).toMatchObject({
      displayPath: `file-${UNIFIED_DIFF_BOUNDS.files - 1}.txt`,
      structured: true
    })
    expect(
      parsed.files.some(
        (file) =>
          file.displayPath === `file-${UNIFIED_DIFF_BOUNDS.files}.txt`
      )
    ).toBe(false)
    expect(parsed.issue).toBe('file-limit')
  })

  it('enforces the global hunk limit without exposing a partial offending file', () => {
    const acceptedHunks = '@@ -0,0 +0,0 @@\n'.repeat(
      UNIFIED_DIFF_BOUNDS.hunks
    )
    const input =
      `diff --git a/accepted.txt b/accepted.txt\n` +
      `--- a/accepted.txt\n` +
      `+++ b/accepted.txt\n` +
      acceptedHunks +
      `diff --git a/rejected.txt b/rejected.txt\n` +
      `--- a/rejected.txt\n` +
      `+++ b/rejected.txt\n` +
      `@@ -0,0 +0,0 @@\n`
    const parsed = parseUnifiedDiff(input)

    expect(parsed.inputTruncated).toBe(false)
    expect(parsed.raw).toBe(input)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]).toMatchObject({
      displayPath: 'accepted.txt',
      structured: true
    })
    expect(parsed.files[0]?.hunks).toHaveLength(
      UNIFIED_DIFF_BOUNDS.hunks
    )
    expect(parsed.files[0]?.hunks.every((hunk) => hunk.complete)).toBe(
      true
    )
    expect(parsed.files[1]).toMatchObject({
      displayPath: 'rejected.txt',
      structured: false,
      issue: 'hunk-limit',
      additions: 0,
      deletions: 0,
      hunks: []
    })
    expect(parsed.issue).toBe('hunk-limit')
  })

  it('enforces the global line limit without exposing a partial offending file', () => {
    const acceptedLineCount = UNIFIED_DIFF_BOUNDS.lines - 4
    const acceptedLines = '+x\n'.repeat(acceptedLineCount)
    const input =
      `diff --git a/accepted.txt b/accepted.txt\n` +
      `--- a/accepted.txt\n` +
      `+++ b/accepted.txt\n` +
      `@@ -0,0 +1,${acceptedLineCount} @@\n` +
      acceptedLines +
      `diff --git a/rejected.txt b/rejected.txt\n` +
      `--- a/rejected.txt\n` +
      `+++ b/rejected.txt\n` +
      `@@ -0,0 +1 @@\n` +
      `+y\n`
    const parsed = parseUnifiedDiff(input)

    expect(parsed.inputTruncated).toBe(false)
    expect(parsed.raw).toBe(input)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]).toMatchObject({
      displayPath: 'accepted.txt',
      structured: true,
      additions: acceptedLineCount,
      deletions: 0
    })
    expect(parsed.files[0]?.hunks[0]?.lines).toHaveLength(
      acceptedLineCount
    )
    expect(parsed.files[0]?.hunks[0]?.complete).toBe(true)
    expect(parsed.files[1]).toMatchObject({
      displayPath: 'rejected.txt',
      structured: false,
      issue: 'line-limit',
      additions: 0,
      deletions: 0,
      hunks: []
    })
    expect(parsed.issue).toBe('line-limit')
  })

  it('counts metadata and patch notes before allocating line arrays', () => {
    const metadataFlood =
      'diff --git a/a b/a\n' +
      '\n'.repeat(UNIFIED_DIFF_BOUNDS.lines)
    const parsed = parseUnifiedDiff(metadataFlood)

    expect(parsed.inputTruncated).toBe(false)
    expect(parsed.raw).toBe(metadataFlood)
    expect(parsed.files[0]).toMatchObject({
      structured: false,
      issue: 'line-limit',
      metadata: [],
      hunks: []
    })
    expect(parsed.issue).toBe('line-limit')
  })
})
