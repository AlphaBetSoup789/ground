import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitDiffResult } from '../../../shared/types'
import { DiffReview } from './DiffReview'

function render(text: string, truncated = false): string {
  const diff: GitDiffResult = {
    text,
    truncated,
    bytes: new TextEncoder().encode(text).byteLength
  }
  return renderToStaticMarkup(
    createElement(DiffReview, {
      title: 'Working tree diff',
      diff
    })
  )
}

describe('structured diff review', () => {
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
})
