import { useCallback, useEffect, useState } from 'react'
import {
  CircleAlert,
  DatabaseBackup,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck
} from 'lucide-react'
import type { LocalStateSnapshot } from '../../../shared/types'
import { desktop } from '../lib/desktop'

interface RecoverySettingsPaneProps {
  onError: (error: unknown) => void
}

export function formatSnapshotBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

export function snapshotTitle(snapshot: LocalStateSnapshot): string {
  return snapshot.kind === 'current'
    ? 'Current state'
    : `Retained snapshot ${snapshot.generation}`
}

export function RecoverySettingsPane(
  props: RecoverySettingsPaneProps
): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<LocalStateSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string>()
  const [announcement, setAnnouncement] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setSnapshots(await desktop.listStateSnapshots())
    } catch (error) {
      props.onError(error)
    } finally {
      setLoading(false)
    }
  }, [props.onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const exportSnapshot = async (
    snapshot: LocalStateSnapshot
  ): Promise<void> => {
    setBusyId(snapshot.id)
    setAnnouncement('')
    try {
      const exported = await desktop.exportStateSnapshot(snapshot.id)
      setAnnouncement(
        exported ? `${snapshotTitle(snapshot)} exported.` : 'Export canceled.'
      )
    } catch (error) {
      props.onError(error)
      await refresh()
    } finally {
      setBusyId(undefined)
    }
  }

  const restoreSnapshot = async (
    snapshot: LocalStateSnapshot
  ): Promise<void> => {
    setBusyId(snapshot.id)
    setAnnouncement('')
    try {
      const restoring = await desktop.restoreStateSnapshot(snapshot.id)
      if (!restoring) {
        setAnnouncement('Restore canceled.')
        setBusyId(undefined)
      }
    } catch (error) {
      props.onError(error)
      setBusyId(undefined)
      await refresh()
    }
  }

  return (
    <div className="recovery-pane">
      <div className="recovery-intro">
        <span className="recovery-intro-icon">
          <DatabaseBackup size={17} aria-hidden="true" />
        </span>
        <div>
          <h2>Local state snapshots</h2>
          <p>
            Browse the current state and three rotating last-known-good
            generations. Exports include task history, provider settings, and
            MCP configuration.
          </p>
        </div>
        <button
          type="button"
          className="secondary-button recovery-refresh"
          onClick={() => void refresh()}
          disabled={loading || busyId !== undefined}
        >
          <RefreshCw
            className={loading ? 'status-spin' : undefined}
            size={13}
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>

      <div className="recovery-secret-boundary">
        <ShieldCheck size={15} aria-hidden="true" />
        <p>
          <strong>Credential-vault contents are never included.</strong> Saved
          API keys and CLI environment secrets stay in the operating-system vault.
          Re-enter them if a restored provider references a key that is no
          longer available. Task text and workspace references can still be
          private, so review exports before sharing them.
        </p>
      </div>

      <div
        className="recovery-snapshot-list"
        aria-busy={loading}
        aria-label="Local state snapshots"
      >
        {loading && snapshots.length === 0 ? (
          <div className="recovery-loading" role="status">
            <LoaderCircle
              className="status-spin"
              size={16}
              aria-hidden="true"
            />
            Inspecting private local snapshots…
          </div>
        ) : (
          snapshots.map((snapshot) => {
            const valid = snapshot.status === 'valid'
            const busy = busyId === snapshot.id
            return (
              <article
                className={`recovery-snapshot ${snapshot.status}`}
                key={snapshot.id}
              >
                <div className="recovery-snapshot-heading">
                  <span
                    className="recovery-snapshot-led"
                    aria-hidden="true"
                  />
                  <div>
                    <h3>{snapshotTitle(snapshot)}</h3>
                    <span className="recovery-snapshot-status">
                      {snapshot.status === 'valid'
                        ? snapshot.kind === 'current'
                          ? 'Ready to export'
                          : 'Ready to export or restore'
                        : snapshot.status === 'invalid'
                          ? 'Invalid snapshot'
                          : 'Not available'}
                    </span>
                  </div>
                </div>

                {valid ? (
                  <dl className="recovery-snapshot-metadata">
                    <div>
                      <dt>Captured</dt>
                      <dd>
                        {snapshot.capturedAt ? (
                          <time dateTime={snapshot.capturedAt}>
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short'
                            }).format(new Date(snapshot.capturedAt))}
                          </time>
                        ) : (
                          'Unknown'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>
                        {snapshot.sizeBytes === undefined
                          ? 'Unknown'
                          : formatSnapshotBytes(snapshot.sizeBytes)}
                      </dd>
                    </div>
                    <div>
                      <dt>Tasks</dt>
                      <dd>{snapshot.taskCount ?? 0}</dd>
                    </div>
                    <div>
                      <dt>Providers</dt>
                      <dd>{snapshot.providerCount ?? 0}</dd>
                    </div>
                  </dl>
                ) : (
                  <div className="recovery-snapshot-unavailable-detail">
                    {snapshot.capturedAt &&
                      snapshot.sizeBytes !== undefined && (
                        <dl className="recovery-snapshot-metadata invalid-metadata">
                          <div>
                            <dt>Modified</dt>
                            <dd>
                              <time dateTime={snapshot.capturedAt}>
                                {new Intl.DateTimeFormat(undefined, {
                                  dateStyle: 'medium',
                                  timeStyle: 'short'
                                }).format(new Date(snapshot.capturedAt))}
                              </time>
                            </dd>
                          </div>
                          <div>
                            <dt>Size</dt>
                            <dd>{formatSnapshotBytes(snapshot.sizeBytes)}</dd>
                          </div>
                        </dl>
                      )}
                    <p className="recovery-snapshot-unavailable">
                      <CircleAlert size={13} aria-hidden="true" />
                      {snapshot.status === 'invalid'
                        ? 'Ground could not validate this generation. Export and restore are disabled.'
                        : 'No validated state is available in this generation.'}
                    </p>
                  </div>
                )}

                <div className="recovery-snapshot-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!valid || busyId !== undefined}
                    onClick={() => void exportSnapshot(snapshot)}
                  >
                    {busy ? (
                      <LoaderCircle
                        className="status-spin"
                        size={13}
                        aria-hidden="true"
                      />
                    ) : (
                      <Download size={13} aria-hidden="true" />
                    )}
                    Export
                  </button>
                  {snapshot.kind === 'retained' && (
                    <button
                      type="button"
                      className="secondary-button recovery-restore"
                      disabled={!valid || busyId !== undefined}
                      onClick={() => void restoreSnapshot(snapshot)}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      Restore…
                    </button>
                  )}
                </div>
              </article>
            )
          })
        )}
      </div>

      <p className="recovery-footnote">
        Restore is blocked while any agent run is active. Ground preserves your
        current state as the newest recovery generation, repairs interrupted
        run markers, then relaunches.
      </p>
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  )
}
