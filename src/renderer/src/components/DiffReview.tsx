import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Code2,
  FileCode2
} from 'lucide-react'
import type { GitDiffResult } from '../../../shared/types'
import {
  parseUnifiedDiff,
  safeDiffDisplayText,
  safeRawDiffDisplayText,
  type UnifiedDiffFile,
  type UnifiedDiffFileStatus,
  type UnifiedDiffHunk,
  type UnifiedDiffIssue,
  type UnifiedDiffLine
} from '../lib/unified-diff'

const INITIAL_VISIBLE_LINES = 1_200
const VISIBLE_LINE_INCREMENT = 1_200
const MAX_VISIBLE_METADATA_LINES = 20

const STATUS_LABELS = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  binary: 'Binary',
  unknown: 'Unparsed'
} as const satisfies Record<UnifiedDiffFileStatus, string>

const ISSUE_MESSAGES = {
  binary: 'This binary change has no line-oriented patch to review.',
  'combined-diff':
    'Combined merge diffs are preserved as raw patch text.',
  'file-limit':
    'The structured review reached its file safety limit.',
  'hunk-limit':
    'The structured review reached its hunk safety limit.',
  'incomplete-hunk':
    'This partial hunk is shown as received. Check the raw patch for full context.',
  'input-limit':
    'The structured review reached its input safety limit.',
  'line-limit':
    'The structured review reached its line safety limit.',
  'line-too-long':
    'A patch line exceeded the structured-review safety limit.',
  malformed:
    'Ground could not safely interpret this patch segment.',
  'missing-file-header':
    'This patch does not include a supported Git file header.',
  unsupported:
    'This patch format is not supported by the structured review.'
} as const satisfies Record<UnifiedDiffIssue, string>

interface DiffReviewProps {
  title: string
  diff: GitDiffResult
}

interface DiffFileEntry {
  file: UnifiedDiffFile
  selectionKey: string
}

export function DiffReview(props: DiffReviewProps): React.JSX.Element {
  const parsed = useMemo(
    () => parseUnifiedDiff(props.diff.text),
    [props.diff.text]
  )
  const fileEntries = useMemo(
    () => indexDiffFiles(parsed.files),
    [parsed.files]
  )
  const [selectedFileKey, setSelectedFileKey] = useState(
    fileEntries[0]?.selectionKey ?? ''
  )
  const [rawVisible, setRawVisible] = useState(false)
  const [visibleLineLimit, setVisibleLineLimit] = useState(
    INITIAL_VISIBLE_LINES
  )
  const [activeHunkIndex, setActiveHunkIndex] = useState(0)
  const fileButtons = useRef<Array<HTMLButtonElement | null>>([])
  const hunkHeadings = useRef(new Map<string, HTMLHeadingElement>())
  const titleId = useId()

  const selectedEntry =
    fileEntries.find(
      (entry) => entry.selectionKey === selectedFileKey
    ) ?? fileEntries[0]
  const selectedFile = selectedEntry?.file

  useEffect(() => {
    if (
      selectedFileKey &&
      fileEntries.some(
        (entry) => entry.selectionKey === selectedFileKey
      )
    ) {
      return
    }
    setSelectedFileKey(fileEntries[0]?.selectionKey ?? '')
  }, [fileEntries, selectedFileKey])

  useEffect(() => {
    setRawVisible(false)
    setVisibleLineLimit(INITIAL_VISIBLE_LINES)
    setActiveHunkIndex(0)
  }, [props.diff.text])

  useEffect(() => {
    setVisibleLineLimit(INITIAL_VISIBLE_LINES)
    setActiveHunkIndex(0)
  }, [selectedFile?.id])

  const selectFile = (index: number, moveFocus = false): void => {
    const entry = fileEntries[index]
    if (!entry) return
    setSelectedFileKey(entry.selectionKey)
    if (moveFocus) {
      requestAnimationFrame(() => fileButtons.current[index]?.focus())
    }
  }

  const onFileListKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    let nextIndex: number | undefined
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIndex = Math.min(fileEntries.length - 1, index + 1)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIndex = Math.max(0, index - 1)
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = fileEntries.length - 1
    }
    if (nextIndex === undefined) return
    event.preventDefault()
    if (nextIndex === index) return
    selectFile(nextIndex, true)
  }

  const showHunk = (nextIndex: number): void => {
    if (!selectedFile?.hunks.length) return
    const boundedIndex = Math.max(
      0,
      Math.min(selectedFile.hunks.length - 1, nextIndex)
    )
    const target = selectedFile.hunks[boundedIndex]
    if (!target) return
    setActiveHunkIndex(boundedIndex)
    setVisibleLineLimit(INITIAL_VISIBLE_LINES)
    requestAnimationFrame(() => hunkHeadings.current.get(target.id)?.focus())
  }

  const displayedHunkIndex = selectedFile?.hunks.length
    ? Math.min(activeHunkIndex, selectedFile.hunks.length - 1)
    : 0
  const activeHunk = selectedFile?.hunks[displayedHunkIndex]
  const visibleHunks = activeHunk
    ? [
        {
          hunk: activeHunk,
          lines: activeHunk.lines.slice(0, visibleLineLimit),
          index: displayedHunkIndex
        }
      ]
    : []
  const selectedLineCount = activeHunk?.lines.length ?? 0
  const hiddenLineCount = Math.max(
    0,
    selectedLineCount - visibleLineLimit
  )

  return (
    <section className="git-diff-review" aria-labelledby={titleId}>
      <header className="git-diff-review-header">
        <div className="git-diff-header-copy">
          <FileCode2 size={14} aria-hidden="true" />
          <div>
            <h3 id={titleId}>{props.title}</h3>
            <p>
              {formatBytes(props.diff.bytes)}
              {parsed.files.length
                ? ` · ${plural(parsed.files.length, 'file')}`
                : ''}
            </p>
          </div>
        </div>
        <button
          className="git-diff-raw-toggle"
          type="button"
          onClick={() => setRawVisible((visible) => !visible)}
          aria-pressed={rawVisible}
        >
          <Code2 size={13} aria-hidden="true" />
          {rawVisible
            ? 'Show structured review'
            : 'Show exact raw patch'}
        </button>
      </header>

      {rawVisible ? (
        <RawPatch
          label={`${props.title} exact raw patch`}
          raw={props.diff.text}
        />
      ) : parsed.files.length && selectedFile ? (
        <div className="git-diff-review-layout">
          <div
            className="git-diff-file-list"
            role="listbox"
            aria-label={`${props.title} files`}
            aria-orientation="vertical"
          >
            {fileEntries.map(({ file, selectionKey }, index) => {
              const selected = selectionKey === selectedEntry.selectionKey
              return (
                <button
                  key={file.id}
                  ref={(element) => {
                    fileButtons.current[index] = element
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={fileOptionLabel(file)}
                  tabIndex={selected ? 0 : -1}
                  className={selected ? 'selected' : undefined}
                  onClick={() => selectFile(index)}
                  onKeyDown={(event) => onFileListKeyDown(event, index)}
                >
                  <span className="git-diff-file-name" title={file.displayPath}>
                    {file.displayPath}
                  </span>
                  <span
                    className={`git-diff-file-status git-diff-file-status-${file.status}`}
                  >
                    {STATUS_LABELS[file.status]}
                  </span>
                  <span className="git-diff-file-stats" aria-hidden="true">
                    <span className="addition">+{file.additions}</span>
                    <span className="deletion">−{file.deletions}</span>
                  </span>
                </button>
              )
            })}
          </div>

          <article
            className="git-diff-file-review"
            aria-label={`Review of ${selectedFile.displayPath}`}
          >
            <div className="git-diff-file-heading">
              <div>
                <code title={selectedFile.displayPath}>
                  {selectedFile.displayPath}
                </code>
                <span
                  className={`git-diff-status git-diff-status-${selectedFile.status}`}
                >
                  {STATUS_LABELS[selectedFile.status]}
                </span>
              </div>
              <span className="git-diff-file-stats">
                <span
                  className="addition"
                  aria-label={plural(selectedFile.additions, 'addition')}
                >
                  +{selectedFile.additions}
                </span>
                <span
                  className="deletion"
                  aria-label={plural(selectedFile.deletions, 'deletion')}
                >
                  −{selectedFile.deletions}
                </span>
              </span>
            </div>

            {selectedFile.structured ? (
              <>
                <DiffMetadata file={selectedFile} />
                {selectedFile.hunks.length ? (
                  <>
                    <div className="git-diff-hunk-navigation">
                      <button
                        type="button"
                        onClick={() => showHunk(displayedHunkIndex - 1)}
                        disabled={displayedHunkIndex <= 0}
                        aria-label="Previous hunk"
                      >
                        <ChevronLeft size={13} aria-hidden="true" />
                      </button>
                      <span
                        className="git-diff-hunk-position"
                        aria-live="polite"
                      >
                        Hunk {displayedHunkIndex + 1} of{' '}
                        {selectedFile.hunks.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => showHunk(displayedHunkIndex + 1)}
                        disabled={
                          displayedHunkIndex >=
                          selectedFile.hunks.length - 1
                        }
                        aria-label="Next hunk"
                      >
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    </div>
                    <DiffTable
                      file={selectedFile}
                      hunks={visibleHunks}
                      setHunkHeading={(hunkId, element) => {
                        if (element) hunkHeadings.current.set(hunkId, element)
                        else hunkHeadings.current.delete(hunkId)
                      }}
                    />
                    {hiddenLineCount > 0 ? (
                      <button
                        className="git-diff-show-more"
                        type="button"
                        onClick={() =>
                          setVisibleLineLimit((current) =>
                            Math.min(
                              selectedLineCount,
                              current + VISIBLE_LINE_INCREMENT
                            )
                          )
                        }
                      >
                        Show next{' '}
                        {Math.min(VISIBLE_LINE_INCREMENT, hiddenLineCount)} lines
                        <span>
                          {' '}
                          · {plural(hiddenLineCount, 'line')} hidden
                        </span>
                      </button>
                    ) : null}
                  </>
                ) : (
                  <p className="git-diff-no-hunks">
                    No line-oriented hunks are present in this file change.
                  </p>
                )}
              </>
            ) : (
              <RawFallback file={selectedFile} />
            )}
          </article>
        </div>
      ) : (
        <div className="git-diff-fallback">
          <p>
            Ground could not find a supported file patch, so the exact text is
            shown below.
          </p>
          <RawPatch label={`${props.title} raw patch`} raw={props.diff.text} />
        </div>
      )}

      {parsed.inputTruncated ? (
        <p className="git-diff-truncated" role="note">
          <AlertCircle size={12} aria-hidden="true" />
          Structured review stopped at Ground’s parser safety limit. The raw
          view retains the captured patch.
        </p>
      ) : null}
      {parsed.issue === 'file-limit' ? (
        <p className="git-diff-truncated" role="note">
          <AlertCircle size={12} aria-hidden="true" />
          {ISSUE_MESSAGES['file-limit']} The raw view retains every captured
          file.
        </p>
      ) : null}
      {props.diff.truncated ? (
        <p className="git-diff-truncated" role="note">
          <AlertCircle size={12} aria-hidden="true" />
          Diff capture stopped at Ground’s output safety limit.
        </p>
      ) : null}
    </section>
  )
}

function DiffMetadata(props: {
  file: UnifiedDiffFile
}): React.JSX.Element | null {
  const metadata = props.file.metadata.filter(
    (line) =>
      line &&
      !line.startsWith('diff --git ') &&
      !line.startsWith('index ') &&
      !line.startsWith('--- ') &&
      !line.startsWith('+++ ')
  )
  if (!metadata.length) return null
  const shown = metadata.slice(0, MAX_VISIBLE_METADATA_LINES)
  return (
    <div className="git-diff-metadata" role="note">
      {shown.map((line, index) => (
        <code key={`${index}:${line}`}>
          {safeDiffDisplayText(line)}
        </code>
      ))}
      {metadata.length > shown.length ? (
        <span>{plural(metadata.length - shown.length, 'metadata line')} hidden</span>
      ) : null}
    </div>
  )
}

function DiffTable(props: {
  file: UnifiedDiffFile
  hunks: ReadonlyArray<{
    hunk: UnifiedDiffHunk
    lines: readonly UnifiedDiffLine[]
    index: number
  }>
  setHunkHeading: (
    hunkId: string,
    element: HTMLHeadingElement | null
  ) => void
}): React.JSX.Element {
  return (
    <div className="git-diff-table-wrap" tabIndex={0}>
      <table className="git-diff-table">
        <caption className="visually-hidden">
          Line changes for {props.file.displayPath}
        </caption>
        <tbody>
          {props.hunks.map(({ hunk, lines, index }) => (
            <DiffHunkRows
              key={hunk.id}
              hunk={hunk}
              lines={lines}
              index={index}
              total={props.file.hunks.length}
              setHunkHeading={props.setHunkHeading}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DiffHunkRows(props: {
  hunk: UnifiedDiffHunk
  lines: readonly UnifiedDiffLine[]
  index: number
  total: number
  setHunkHeading: (
    hunkId: string,
    element: HTMLHeadingElement | null
  ) => void
}): React.JSX.Element {
  return (
    <>
      <tr className="git-diff-hunk-row">
        <th colSpan={3}>
          <h4
            ref={(element) => props.setHunkHeading(props.hunk.id, element)}
            tabIndex={-1}
            aria-label={`Hunk ${props.index + 1} of ${props.total}: ${safeDiffDisplayText(
              props.hunk.header
            )}`}
          >
            <span>{safeDiffDisplayText(props.hunk.header)}</span>
            {!props.hunk.complete ? (
              <span className="git-diff-hunk-partial">Partial</span>
            ) : null}
          </h4>
        </th>
      </tr>
      {props.lines.map((line, index) => (
        <DiffLineRow
          key={`${props.hunk.id}:${index}`}
          line={line}
        />
      ))}
    </>
  )
}

function DiffLineRow(props: {
  line: UnifiedDiffLine
}): React.JSX.Element {
  const label = lineLabel(props.line)
  const prefix =
    props.line.kind === 'addition'
      ? '+'
      : props.line.kind === 'deletion'
        ? '−'
        : props.line.kind === 'note'
          ? '!'
          : ' '
  return (
    <tr className={`git-diff-line git-diff-line-${props.line.kind}`}>
      <td className="git-diff-line-number" aria-hidden="true">
        {props.line.oldLine ?? ''}
      </td>
      <td className="git-diff-line-number" aria-hidden="true">
        {props.line.newLine ?? ''}
      </td>
      <td className="git-diff-line-code">
        <span className="visually-hidden">{label}: </span>
        <span className="git-diff-line-prefix" aria-hidden="true">
          {prefix}
        </span>
        <code>{safeDiffDisplayText(props.line.content)}</code>
      </td>
    </tr>
  )
}

function RawFallback(props: {
  file: UnifiedDiffFile
}): React.JSX.Element {
  return (
    <div className="git-diff-fallback">
      <p role="note">
        <AlertCircle size={13} aria-hidden="true" />
        {props.file.issue
          ? ISSUE_MESSAGES[props.file.issue]
          : ISSUE_MESSAGES.unsupported}
      </p>
      <RawPatch
        label={`Raw patch for ${props.file.displayPath}`}
        raw={props.file.raw}
      />
    </div>
  )
}

function RawPatch(props: {
  label: string
  raw: string
}): React.JSX.Element {
  const displayText = safeRawDiffDisplayText(props.raw)
  const controlsEscaped = displayText !== props.raw
  const [copyStatus, setCopyStatus] = useState<
    'idle' | 'copied' | 'failed'
  >('idle')

  useEffect(() => {
    setCopyStatus('idle')
  }, [props.raw])

  const copyExactPatch = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(props.raw)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
  }

  return (
    <div className="git-diff-raw-shell">
      {controlsEscaped ? (
        <div className="git-diff-raw-warning" role="note">
          <AlertCircle size={13} aria-hidden="true" />
          <div>
            <p>
              Presentation controls are shown as visible Unicode escapes.
              Copying the exact patch includes those controls.
            </p>
            <button
              className="git-diff-copy-exact"
              type="button"
              onClick={() => void copyExactPatch()}
            >
              Copy exact raw patch
            </button>
            <span
              className="git-diff-copy-status"
              role="status"
              aria-live="polite"
            >
              {copyStatus === 'copied'
                ? 'Exact patch copied.'
                : copyStatus === 'failed'
                  ? 'Exact copy was unavailable.'
                  : ''}
            </span>
          </div>
        </div>
      ) : null}
      <pre
        className="git-unified-diff git-diff-raw"
        tabIndex={0}
        aria-label={props.label}
        dir="ltr"
      >
        <code>{displayText}</code>
      </pre>
    </div>
  )
}

function fileOptionLabel(file: UnifiedDiffFile): string {
  return [
    `Review ${file.displayPath}`,
    STATUS_LABELS[file.status],
    plural(file.additions, 'addition'),
    plural(file.deletions, 'deletion')
  ].join(', ')
}

function fileSelectionKey(file: UnifiedDiffFile): string {
  return [
    file.oldPath ?? '',
    file.newPath ?? '',
    file.status,
    file.displayPath
  ].join('\u0000')
}

function indexDiffFiles(
  files: readonly UnifiedDiffFile[]
): DiffFileEntry[] {
  const occurrences = new Map<string, number>()
  return files.map((file) => {
    const baseKey = fileSelectionKey(file)
    const occurrence = occurrences.get(baseKey) ?? 0
    occurrences.set(baseKey, occurrence + 1)
    return {
      file,
      selectionKey: `${baseKey}\u0000${occurrence}`
    }
  })
}

function lineLabel(line: UnifiedDiffLine): string {
  if (line.kind === 'addition') return `Added line ${line.newLine ?? ''}`.trim()
  if (line.kind === 'deletion') return `Deleted line ${line.oldLine ?? ''}`.trim()
  if (line.kind === 'note') return 'Patch note'
  return `Context line ${line.oldLine ?? ''}, new line ${line.newLine ?? ''}`.trim()
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}
