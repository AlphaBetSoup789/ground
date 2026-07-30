import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitDiffResult } from '../../../shared/types'
import type { DiffFollowupSource } from '../lib/diff-followup'
import { parseUnifiedDiff } from '../lib/unified-diff'
import {
  diffFileSelectionKeys,
  diffHunkSelectionKeys,
  DiffReview
} from './DiffReview'

function render(
  text: string,
  truncated = false,
  source: DiffFollowupSource = 'working'
): string {
  const diff: GitDiffResult = {
    text,
    truncated,
    bytes: new TextEncoder().encode(text).byteLength
  }
  return renderToStaticMarkup(
    createElement(DiffReview, {
      title: 'Working tree diff',
      diff,
      source,
      onAddHunkToPrompt: () => undefined
    })
  )
}

function addPromptButton(markup: string): string | undefined {
  return markup.match(
    /<button class="git-diff-add-prompt"[^>]*>/u
  )?.[0]
}

describe('structured diff review', () => {
  it('keeps file selection keys stable across unrelated insertion and reordering', () => {
    const firstPatch = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old app
+new app
diff --git a/src/styles.css b/src/styles.css
--- a/src/styles.css
+++ b/src/styles.css
@@ -1 +1 @@
-color: red;
+color: green;
`)
    const refreshedPatch = parseUnifiedDiff(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-Old heading
+New heading
diff --git a/src/styles.css b/src/styles.css
--- a/src/styles.css
+++ b/src/styles.css
@@ -1 +1 @@
-color: red;
+color: green;
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old app
+new app
`)
    const firstKeys = diffFileSelectionKeys(firstPatch.files)
    const refreshedKeys = diffFileSelectionKeys(refreshedPatch.files)
    expect(firstKeys).toHaveLength(2)
    expect(refreshedKeys).toHaveLength(3)
    const firstByPath = new Map(
      firstPatch.files.map((file, index) => [
        file.displayPath,
        firstKeys[index]
      ])
    )
    const refreshedByPath = new Map(
      refreshedPatch.files.map((file, index) => [
        file.displayPath,
        refreshedKeys[index]
      ])
    )

    expect(refreshedByPath.get('src/app.ts')).toBe(
      firstByPath.get('src/app.ts')
    )
    expect(refreshedByPath.get('src/styles.css')).toBe(
      firstByPath.get('src/styles.css')
    )
  })

  it('keeps exact hunk keys stable when an unrelated hunk is added', () => {
    const firstPatch = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old one
+new one
@@ -10 +10 @@
-old ten
+new ten
`)
    const refreshedPatch = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old one
+new one
@@ -5 +5 @@
-old five
+new five
@@ -10 +10 @@
-old ten
+new ten
`)
    const firstFile = firstPatch.files[0]
    const refreshedFile = refreshedPatch.files[0]
    expect(firstFile).toBeDefined()
    expect(refreshedFile).toBeDefined()
    const firstFileKey = diffFileSelectionKeys(firstPatch.files)[0]
    const refreshedFileKey = diffFileSelectionKeys(refreshedPatch.files)[0]
    expect(refreshedFileKey).toBe(firstFileKey)

    const firstKeys = diffHunkSelectionKeys(
      firstFileKey ?? '',
      firstFile?.hunks ?? []
    )
    const refreshedKeys = diffHunkSelectionKeys(
      refreshedFileKey ?? '',
      refreshedFile?.hunks ?? []
    )

    expect(firstKeys).toHaveLength(2)
    expect(refreshedKeys).toHaveLength(3)
    expect(refreshedKeys[0]).toBe(firstKeys[0])
    expect(refreshedKeys[2]).toBe(firstKeys[1])
  })

  it('does not retain a hunk key after its range shifts', () => {
    const firstPatch = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10 +10 @@ render()
-old value
+new value
`)
    const shiftedPatch = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -11 +11 @@ render()
-old value
+new value
`)
    const firstFileKey = diffFileSelectionKeys(firstPatch.files)[0] ?? ''
    const shiftedFileKey =
      diffFileSelectionKeys(shiftedPatch.files)[0] ?? ''
    const firstHunkKey = diffHunkSelectionKeys(
      firstFileKey,
      firstPatch.files[0]?.hunks ?? []
    )[0]
    const shiftedHunkKeys = diffHunkSelectionKeys(
      shiftedFileKey,
      shiftedPatch.files[0]?.hunks ?? []
    )

    expect(firstHunkKey).toBeDefined()
    expect(shiftedHunkKeys).not.toContain(firstHunkKey)
  })

  it('gives duplicate identical hunks distinct occurrence keys', () => {
    const parsed = parseUnifiedDiff(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old value
+new value
@@ -1 +1 @@
-old value
+new value
`)
    const fileKey = diffFileSelectionKeys(parsed.files)[0] ?? ''
    const hunkKeys = diffHunkSelectionKeys(
      fileKey,
      parsed.files[0]?.hunks ?? []
    )

    expect(hunkKeys).toHaveLength(2)
    expect(new Set(hunkKeys)).toHaveProperty('size', 2)
  })

  it('renders a focused, accessible multi-file and multi-hunk review', () => {
    const markup = render(`diff --git a/src/App.tsx b/src/App.tsx
index 1111111..2222222 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,2 +1,2 @@
-const oldValue = true
+const nextValue = true
 context
diff --git a/src/styles.css b/src/styles.css
--- a/src/styles.css
+++ b/src/styles.css
@@ -1 +1 @@
-color: red;
+color: green;
@@ -8 +8,2 @@
 display: block;
+padding: 1rem;
`)

    expect(markup).toContain('role="listbox"')
    expect(markup).toContain('aria-label="Working tree diff files"')
    expect(markup).toContain(
      'aria-label="Review src/App.tsx, Modified, 1 addition, 1 deletion"'
    )
    expect(markup).toContain(
      'aria-label="Review src/styles.css, Modified, 2 additions, 1 deletion"'
    )
    expect(markup).toContain('aria-selected="true"')
    expect(markup).toContain('aria-label="Previous hunk"')
    expect(markup).toContain('aria-label="Next hunk"')
    expect(markup).toContain('aria-label="Hunk 1 of 1:')
    expect(markup).toContain('Add hunk to prompt')
    expect(markup).toContain(
      'aria-label="Add working-tree hunk 1 from src/App.tsx'
    )
    expect(markup).toContain('Deleted line 1: ')
    expect(markup).toContain('Added line 1: ')
    expect(markup).toContain('Show exact raw patch')
    expect(markup).not.toContain('dangerouslySetInnerHTML')
  })

  it('uses raw fallback for binary patches and escapes hostile display text', () => {
    const dangerousPath = 'image\u202e\u0007.png'
    const binaryMarkup = render(`diff --git a/${dangerousPath} b/${dangerousPath}
Binary files a/${dangerousPath} and b/${dangerousPath} differ
`)

    expect(binaryMarkup).toContain(
      'This binary change has no line-oriented patch to review.'
    )
    expect(binaryMarkup).toContain('aria-label="Raw patch for')
    expect(binaryMarkup).toContain('dir="ltr"')
    expect(binaryMarkup).toContain('image\\u202e\\u0007.png')
    expect(binaryMarkup).toContain('diff --git')
    expect(binaryMarkup).toContain(
      'Presentation controls are shown as visible Unicode escapes.'
    )
    expect(binaryMarkup).toContain('Copy exact raw patch')
    expect(binaryMarkup).not.toContain('Add hunk to prompt')
    expect(binaryMarkup).not.toContain(dangerousPath)
  })

  it('discloses large structured patches incrementally and reports capture limits', () => {
    const additions = Array.from(
      { length: 1_205 },
      (_, index) => `+line ${index + 1}`
    ).join('\n')
    const markup = render(
      `diff --git a/large.txt b/large.txt
new file mode 100644
--- /dev/null
+++ b/large.txt
@@ -0,0 +1,1205 @@
${additions}
@@ -0,0 +2000 @@
+second-hunk-only
`,
      true
    )

    expect(markup).toContain('Show next 5 lines')
    expect(markup).toContain('5 lines hidden')
    expect(markup).not.toContain('line 1201')
    expect(markup).not.toContain('second-hunk-only')
    expect(markup).toContain('Hunk 1 of 2')
    expect(markup).toContain(
      'Diff capture stopped at Ground’s output safety limit.'
    )
    expect(addPromptButton(markup)).toContain('disabled=""')
    expect(markup).toContain(
      'Only a complete, non-truncated hunk can be added to a message draft.'
    )
  })

  it('announces when the structured file navigator reaches its limit', () => {
    const files = Array.from(
      { length: 513 },
      (_, index) =>
        `diff --git a/file-${index}.txt b/file-${index}.txt\n` +
        `--- a/file-${index}.txt\n` +
        `+++ b/file-${index}.txt\n`
    ).join('')
    const markup = render(files)

    expect(markup).toContain(
      'The structured review reached its file safety limit.'
    )
    expect(markup).toContain(
      'The raw view retains every captured file.'
    )
    expect(markup).toContain('512 files')
    expect(markup).not.toContain('Review file-512.txt')
  })

  it('keeps exactly one option selected when hostile input repeats a path', () => {
    const repeated = `diff --git a/repeated.txt b/repeated.txt
--- a/repeated.txt
+++ b/repeated.txt
@@ -1 +1 @@
-one
+two
`
    const markup = render(repeated + repeated)

    expect(markup.match(/role="option"/gu)).toHaveLength(2)
    expect(markup.match(/aria-selected="true"/gu)).toHaveLength(1)
  })

  it('labels staged provenance and refuses incomplete or oversized prompt blocks', () => {
    const staged = render(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`, false, 'staged')
    expect(staged).toContain(
      'aria-label="Add staged hunk 1 from src/app.ts'
    )
    expect(staged).toMatch(
      /<button class="git-diff-add-prompt" type="button" aria-describedby=/u
    )

    const incomplete = render(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
-old
+new
`)
    expect(addPromptButton(incomplete)).toContain('disabled=""')
    expect(incomplete).toContain(
      'Only a complete, non-truncated hunk can be added to a message draft.'
    )

    const hostileLine = `+\u0000${'x'.repeat(31_999)}`
    const oversized = render(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -0,0 +1 @@
${hostileLine}
`)
    expect(addPromptButton(oversized)).toContain('disabled=""')
    expect(oversized).toContain(
      'This hunk is too large to add to one message draft.'
    )
  })

  it('refuses empty hunks and complete hunks in a file with a sibling issue', () => {
    const empty = render(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,0 +1,0 @@
`)
    expect(addPromptButton(empty)).toContain('disabled=""')
    expect(empty).toContain(
      'This hunk has no line content to add to a message draft.'
    )

    const siblingIssue = render(`diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
@@ -4,2 +4,2 @@
-incomplete
+replacement
`)
    expect(siblingIssue).toContain('Hunk 1 of 2')
    expect(addPromptButton(siblingIssue)).toContain('disabled=""')
    expect(siblingIssue).toContain(
      'Only a complete, non-truncated hunk can be added to a message draft.'
    )
  })

  it.each([
    `diff --cc src/app.ts
index 1111111,2222222..3333333
--- a/src/app.ts
+++ b/src/app.ts
@@@ -1,1 -1,1 +1,1 @@@
- old
+ new
`,
    `diff --git a/src/app.ts b/src/app.ts
unsupported metadata
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
    'not a unified patch'
  ])('does not expose a prompt action for raw-only fallback', (text) => {
    expect(render(text)).not.toContain('Add hunk to prompt')
  })
})
