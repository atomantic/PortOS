import { useId, useState } from 'react';
import { Archive, Trash2 } from 'lucide-react';
import { formatBytes } from '../../utils/formatters';
import { pluralize } from '../../lib/textUtils';
import BrailleSpinner from '../BrailleSpinner';
import CollapsibleListItem from '../ui/CollapsibleListItem';
import CollapsibleSection from '../ui/CollapsibleSection';
import Modal from '../ui/Modal';

export default function BackupSnapshotsSection({
  snapshots, snapshotState, saving, open, onOpenChange, refreshSnapshots,
  restoreAction, handleRestoreDb, closeRestore, confirmRestoreDb,
  deleteTarget, handleDeleteSnapshot, closeDelete, confirmDeleteSnapshot,
  deletingIds, finishDeleteAnimation,
}) {
  const snapshotsPanelId = useId();
  const [allSnapshots, setAllSnapshots] = useState(false);
  const restoring = restoreAction?.phase === 'restore';
  const restoreTarget = restoring || restoreAction?.phase === 'confirm' ? restoreAction : null;
  const actionsBlocked = !!(restoreAction || deleteTarget);
  const snapshotSummary = snapshotState === 'error'
    ? 'Unavailable — open to retry'
    : snapshotState === 'loading' ? 'Loading…'
    : snapshotState !== 'loaded' ? 'Open to load'
    : snapshots.length > 0
    ? `${snapshots.length} ${snapshots.length === 1 ? 'snapshot' : 'snapshots'}`
    : 'No snapshots yet';

  return (
    <>
      <div className="border-t border-port-border pt-5">
        {restoreAction?.phase === 'preview' && (
          <BrailleSpinner text={`Preparing database restore preview for ${restoreAction.snapshotId}…`} className="block px-1 text-sm" />
        )}
        <CollapsibleSection
          label="Snapshot history"
          icon={Archive}
          summary={snapshotSummary}
          id={snapshotsPanelId}
          open={open}
          onOpenChange={onOpenChange}
          size="bar"
          className="space-y-3"
          bodyClassName="space-y-2 pt-2"
        >
          {saving || snapshotState === 'idle' || snapshotState === 'loading' ? (
            <BrailleSpinner text="Loading snapshot history" />
          ) : snapshotState === 'error' ? (
            <div className="text-sm text-port-warning">
              Snapshot history is unavailable.{' '}
              <button type="button" onClick={refreshSnapshots} className="px-3 py-2 border border-port-border rounded-lg hover:bg-port-border">Retry</button>
            </div>
          ) : snapshots.length === 0 ? (
            <p className="text-sm text-gray-500">No snapshots have been recorded on this machine yet.</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {(allSnapshots ? snapshots : snapshots.slice(0, 10)).map((snap) => {
                  const identity = snap.selectionKey;
                  return (
                    <li key={identity}>
                      <CollapsibleListItem
                        removing={deletingIds.has(identity)}
                        spacing="0.375rem"
                        onExited={() => finishDeleteAnimation(identity)}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs bg-port-bg border border-port-border rounded-lg px-2.5 py-1.5">
                          <span className="min-w-0">
                            <span className="block text-gray-300 truncate">{snap.id}</span>
                            <span className="block text-gray-500 truncate">Source: {snap.sourceLabel}</span>
                            {snap.interrupted ? (
                              <span className="block text-port-warning">Interrupted</span>
                            ) : snap.failed && (
                              <span className="block text-port-error">Backup failed — download only</span>
                            )}
                            {snap.incomplete && (
                              <span className="block text-gray-500">Still being written…</span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleRestoreDb(snap)}
                              disabled={actionsBlocked || snap.failed || snap.incomplete || snap.interrupted}
                              title={snap.interrupted
                                ? 'An interrupted backup snapshot cannot be restored'
                                : snap.failed ? 'Failed backup snapshots can only be downloaded for salvage' : undefined}
                              className="px-2 py-2 min-h-[40px] bg-port-border hover:bg-port-border/70 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Restore DB
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteSnapshot(snap)}
                              disabled={actionsBlocked || snap.incomplete}
                              title="Permanently delete this snapshot"
                              aria-label={`Delete snapshot ${snap.id}`}
                              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 min-h-[40px] min-w-[40px] bg-port-border hover:bg-port-error/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Trash2 size={14} />
                            </button>
                          </span>
                        </div>
                      </CollapsibleListItem>
                    </li>
                  );
                })}
              </ul>
              {snapshots.length > 10 && (
                <button
                  type="button"
                  onClick={() => setAllSnapshots(previous => !previous)}
                  aria-expanded={allSnapshots}
                  className="text-xs text-port-accent hover:text-port-accent/80 transition-colors min-h-[32px]"
                >
                  {allSnapshots ? 'Show newest 10 snapshots' : `Show all ${snapshots.length} snapshots`}
                </button>
              )}
            </>
          )}
        </CollapsibleSection>
      </div>

      <Modal
        open={!!restoreTarget}
        onClose={closeRestore}
        closeOnBackdrop={!restoring}
        closeOnEsc={!restoring}
        size="sm"
        usePortal
        ariaLabel="Restore database"
      >
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
          <h3 className="text-white text-sm font-medium">Restore database?</h3>
          <p className="text-sm text-gray-400">
            This replays <code>portos-db.sql</code> from snapshot <code className="text-gray-300">{restoreTarget?.request.snapshotId}</code>
            {' '}on <span className="text-gray-300">{restoreTarget?.sourceLabel}</span>
            {restoreTarget?.preview && <> ({formatBytes(restoreTarget.preview.sizeBytes || 0)} · {pluralize(restoreTarget.preview.tableCount, 'table')})</>}
            {' '}as a full replacement of the live PostgreSQL database. All current application tables and rows are replaced, including tables added after this snapshot. Newer tables are recreated empty and current migrations run afterward.
          </p>
          {restoring && <BrailleSpinner text="Restoring database…" />}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeRestore} disabled={restoring} className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50">Cancel</button>
            <button type="button" onClick={confirmRestoreDb} disabled={restoring || saving} className="px-3 py-2 text-sm bg-port-warning hover:bg-port-warning/80 text-black font-medium rounded-lg transition-colors disabled:opacity-50">Restore</button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={closeDelete}
        size="sm"
        usePortal
        ariaLabel="Delete snapshot"
      >
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
          <h3 className="text-white text-sm font-medium">Delete snapshot?</h3>
          <p className="text-sm text-gray-400">
            This permanently deletes snapshot <code className="text-gray-300">{deleteTarget?.snapshotId}</code>
            {' '}on <span className="text-gray-300">{deleteTarget?.sourceLabel}</span>, including its files and database dump. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeDelete} className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
            <button type="button" onClick={confirmDeleteSnapshot} disabled={!!restoreAction || saving} className="px-3 py-2 text-sm bg-port-error hover:bg-port-error/80 text-white font-medium rounded-lg transition-colors disabled:opacity-50">Delete</button>
          </div>
        </div>
      </Modal>
    </>
  );
}
