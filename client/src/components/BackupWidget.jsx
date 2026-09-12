import { useState, memo, useCallback, useId, useRef } from 'react';
import { Link } from 'react-router';
import {HardDrive,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Download,
  Eye,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock} from 'lucide-react';
import BrailleSpinner from './BrailleSpinner';
import toast from './ui/Toast';
import * as api from '../services/api';
import { useBackupRun } from '../hooks/useBackupRun';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { useTimeTick } from '../hooks/useTimeTick';
import { equalByKeys, equalListByKeys } from '../lib/compareHelpers';
import { timeAgo, timeUntil } from '../utils/formatters';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function computeHealth(status) {
  if (!status || status.status === 'error') return 'critical';
  // 'degraded' = files backed up but the DB dump failed — surface as a warning.
  if (status.status === 'degraded') return 'warning';
  if (status.status === 'never') return 'warning';
  if (status.status === 'running') return 'healthy';
  if (!status.lastRun) return 'warning';
  const hoursSince = (Date.now() - new Date(status.lastRun).getTime()) / (1000 * 60 * 60);
  if (hoursSince < 25) return 'healthy';
  if (hoursSince < 49) return 'warning';
  return 'critical';
}

const HEALTH_STYLES = {
  healthy: {
    dot: 'bg-port-success',
    text: 'text-port-success',
    icon: CheckCircle
  },
  warning: {
    dot: 'bg-port-warning',
    text: 'text-port-warning',
    icon: AlertTriangle
  },
  critical: {
    dot: 'bg-port-error',
    text: 'text-port-error',
    icon: XCircle
  }
};

const snapshotIdentity = (snapshot) =>
  snapshot.selectionKey || `${snapshot.source || 'current'}/${snapshot.id}`;
const snapshotSourceLabel = (snapshot) =>
  snapshot.sourceLabel || snapshot.source || 'Current machine';

// ---------------------------------------------------------------------------
// RestorePanel
// ---------------------------------------------------------------------------

function RestorePanel({ snapshot, onClose, restoring, onRestoreStateChange }) {
  const filterId = useId();
  const [filter, setFilter] = useState('');
  const [acceptedPreview, setAcceptedPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const previewGenerationRef = useRef(0);

  const currentRequest = {
    snapshotId: snapshot.id,
    ...(snapshot.source ? { source: snapshot.source } : {}),
    subdirFilter: filter.trim() || null,
  };
  const previewMatchesCurrentRequest = acceptedPreview
    && acceptedPreview.request.snapshotId === currentRequest.snapshotId
    && acceptedPreview.request.source === currentRequest.source
    && acceptedPreview.request.subdirFilter === currentRequest.subdirFilter;

  const handleFilterChange = useCallback((event) => {
    previewGenerationRef.current += 1;
    setFilter(event.target.value);
    setAcceptedPreview(null);
    setPreviewing(false);
  }, []);

  const handlePreview = useCallback(async () => {
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    const request = {
      snapshotId: snapshot.id,
      ...(snapshot.source ? { source: snapshot.source } : {}),
      subdirFilter: filter.trim() || null,
    };
    setPreviewing(true);
    setAcceptedPreview(null);
    const outcome = await api.restoreBackup({
      ...request,
      dryRun: true,
    }, { silent: true }).then(
      previewResult => ({ previewResult }),
      previewError => ({ previewError }),
    );

    if (previewGenerationRef.current !== generation) return;
    setPreviewing(false);
    if (outcome.previewError) {
      toast.error(`Preview failed: ${outcome.previewError.message}`);
      return;
    }
    if (outcome.previewResult) setAcceptedPreview({ request, result: outcome.previewResult });
  }, [snapshot.id, snapshot.source, filter]);

  const handleRestore = useCallback(async () => {
    if (!previewMatchesCurrentRequest || restoring) return;

    onRestoreStateChange(snapshotIdentity(snapshot));
    const result = await api.restoreBackup({
      ...acceptedPreview.request,
      dryRun: false,
    }, { silent: true }).catch(err => {
      toast.error(`Restore failed: ${err.message}`);
      return null;
    });
    onRestoreStateChange(null);
    if (result) {
      toast.success(`Restore complete — ${result.changedFiles?.length ?? 0} file(s) restored`);
      onClose();
    }
  }, [acceptedPreview, onClose, onRestoreStateChange, previewMatchesCurrentRequest, restoring, snapshot]);

  const preview = previewMatchesCurrentRequest ? acceptedPreview.result : null;

  return (
    <div className="mt-3 p-3 bg-port-bg rounded-lg border border-port-border space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-300">
          Restore snapshot: {snapshot.id}
        </span>
        <button
          onClick={onClose}
          disabled={restoring}
          className="text-gray-500 hover:text-gray-300 transition-colors text-xs min-h-[32px] px-1 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>

      <p className="text-xs text-gray-500">Source: {snapshotSourceLabel(snapshot)}</p>

      {/* Subdirectory filter */}
      <div>
        <label htmlFor={filterId} className="block text-xs text-gray-500 mb-1">
          Selective restore (optional)
        </label>
        <input
          id={filterId}
          type="text"
          value={filter}
          onChange={handleFilterChange}
          disabled={restoring}
          placeholder="e.g., brain"
          className="w-full bg-port-card border border-port-border rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent"
        />
        <p className="mt-1 text-xs text-gray-600">
          Leave blank to restore all data from this snapshot.
        </p>
      </div>

      {/* Preview button */}
      <button
        onClick={handlePreview}
        disabled={previewing || restoring}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-border hover:bg-port-border/70 text-gray-300 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px]"
      >
        {previewing ? (
          <BrailleSpinner />
        ) : (
          <Eye size={14} />
        )}
        Preview changes
      </button>

      {/* Dry-run results */}
      {preview && (
        <div>
          {preview.verification?.status === 'verified' && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-port-success" role="status">
              <CheckCircle size={13} />
              Snapshot integrity verified ({preview.verification.checkedFiles} selected file(s)).
            </p>
          )}
          {preview.verification?.status === 'unverified' && (
            <p className="mb-2 flex items-start gap-1.5 rounded border border-port-warning/40 bg-port-warning/10 p-2 text-xs text-port-warning" role="alert">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              Legacy snapshot: no integrity manifest is available. PortOS cannot verify these backup bytes before restore.
            </p>
          )}
          <p className="text-xs text-gray-500 mb-1">
            {preview.changedFiles?.length ?? 0} file(s) would change:
          </p>
          {preview.changedFiles?.length > 0 ? (
            <div className="max-h-36 overflow-y-auto space-y-0.5 rounded bg-port-bg/60 p-2">
              {preview.changedFiles.map((f, i) => (
                <div key={i} className="text-xs text-gray-400 font-mono truncate">{f}</div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-port-success">No changes — data is already up to date.</p>
          )}
        </div>
      )}

      {/* Restore button (only active after preview) */}
      {preview && (
        <button
          onClick={handleRestore}
          disabled={restoring || !preview.changedFiles?.length}
          className="flex items-center gap-2 px-3 py-1.5 bg-port-error hover:bg-port-error/80 text-white rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px]"
        >
          {restoring ? (
            <BrailleSpinner />
          ) : (
            <RotateCcw size={14} />
          )}
          {preview.changedFiles?.length
            ? `Restore ${preview.changedFiles.length} file(s)`
            : 'Nothing to restore'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SnapshotList
// ---------------------------------------------------------------------------

function SnapshotList({ restoringSnapshotId, onRestoreStateChange }) {
  // Let errors throw — `useAutoRefetch` preserves the last-good data on
  // transient failures. A `.catch(() => null)` here would wipe the snapshot
  // list on every blip per the hook's documented gotcha.
  const { data: snapshots, loading } = useAutoRefetch(
    () => api.getBackupSnapshots({ silent: true }),
    120000,
    {
      // Snapshots only change when a new backup lands or the rotation prunes
      // the oldest — walk every rendered tuple (id + fileCount) so a stale
      // server-side fileCount recount or a middle-row mutation can't hide
      // behind the head/tail id check.
      compare: (prev, next) => equalListByKeys(prev, next, [
        'selectionKey', 'id', 'source', 'fileCount', 'incomplete', 'failed',
      ]),
    },
  );
  const [selectedId, setSelectedId] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);

  const handleDownload = useCallback((snapshot) => {
    const identity = snapshotIdentity(snapshot);
    setDownloadingId(identity);
    const download = snapshot.source
      ? api.downloadBackupSnapshot(snapshot.id, snapshot.source)
      : api.downloadBackupSnapshot(snapshot.id);
    download
      .then(() => toast.success('Snapshot downloaded'))
      // Dismissing the browser's save dialog is a choice, not a failure.
      .catch(err => { if (err?.name !== 'AbortError') toast.error(`Download failed: ${err.message}`); })
      .finally(() => setDownloadingId(null));
  }, []);

  if (loading) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
        <BrailleSpinner text="Loading snapshots..." />
      </div>
    );
  }

  if (!snapshots || snapshots.length === 0) {
    return (
      <p className="mt-3 text-xs text-gray-500">No snapshots found.</p>
    );
  }

  return (
    <div className="mt-3 space-y-1">
      {snapshots.map(snap => (
        <div key={snapshotIdentity(snap)}>
          <div className="flex items-center justify-between gap-2 py-1.5 px-2 rounded bg-port-bg/50 hover:bg-port-bg/80 transition-colors">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-gray-300 font-mono truncate">{snap.id}</div>
              <div className="text-xs text-gray-500 truncate">Source: {snapshotSourceLabel(snap)}</div>
              <div className="text-xs text-gray-600">
                {snap.incomplete
                  ? 'Still being written…'
                  : snap.failed
                    ? 'Backup failed — download available for salvage'
                    : `${snap.fileCount} files`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => handleDownload(snap)}
                // Deliberately disabled across every row, not just this one:
                // each download spawns a tar over the whole snapshot on the
                // same external drive, so two at once only thrash the disk.
                disabled={downloadingId !== null || snap.incomplete}
                aria-label={`Download snapshot ${snap.id} from ${snapshotSourceLabel(snap)}`}
                className="flex items-center gap-1 px-2 py-1 text-xs text-port-accent hover:text-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[32px]"
              >
                {downloadingId === snapshotIdentity(snap) ? <BrailleSpinner /> : <Download size={12} />}
                Download
              </button>
              <button
                onClick={() => setSelectedId(selectedId === snapshotIdentity(snap) ? null : snapshotIdentity(snap))}
                disabled={snap.incomplete || snap.failed || restoringSnapshotId !== null}
                title={snap.failed ? 'Failed backup snapshots can only be downloaded for salvage' : undefined}
                className="flex items-center gap-1 px-2 py-1 text-xs text-port-accent hover:text-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[32px]"
              >
                <RotateCcw size={12} />
                Restore
              </button>
            </div>
          </div>
          {selectedId === snapshotIdentity(snap) && !snap.incomplete && !snap.failed && (
            <RestorePanel
              snapshot={snap}
              onClose={() => setSelectedId(null)}
              restoring={restoringSnapshotId === snapshotIdentity(snap)}
              onRestoreStateChange={onRestoreStateChange}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackupWidget
// ---------------------------------------------------------------------------

const BackupWidget = memo(function BackupWidget() {
  // Let errors throw — `useAutoRefetch` preserves the last-good status on
  // transient failures so a blip doesn't drop the widget to its loading state.
  const { data: status } = useAutoRefetch(
    () => api.getBackupStatus({ silent: true }),
    60000,
    {
      // Backup state only flips when a new run starts/finishes — comparing the
      // monotonic timestamps + status + error + destPath captures every
      // visible change at the widget's resolution. Avoids per-poll re-renders
      // that would re-compute relative-time labels for no visual benefit.
      compare: (prev, next) => equalByKeys(prev, next, [
        'status', 'lastRun', 'nextRun', 'error', 'filesChanged', 'destPath',
      ]),
    },
  );
  const [handleBackupNow, triggering] = useBackupRun();
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [restoringSnapshotId, setRestoringSnapshotId] = useState(null);
  // Tick every minute so the dedup-skipped widget still recomputes
  // `relativeTime(lastRun/nextRun)` labels and the `computeHealth` 25h/49h
  // thresholds when wall-clock time crosses a boundary even though the poll
  // payload is unchanged.
  useTimeTick(60000);

  const health = computeHealth(status);
  const { dot, text, icon: HealthIcon } = HEALTH_STYLES[health];

  const isRunning = status?.status === 'running';
  const isNever = status?.status === 'never';

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${health === 'healthy' ? 'bg-port-success/10' : health === 'warning' ? 'bg-port-warning/10' : 'bg-port-error/10'}`}>
            <HardDrive className={`w-5 h-5 ${text}`} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Backup</h3>
            <div className="flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full inline-block ${dot}`} />
              <span className={text}>
                {health.charAt(0).toUpperCase() + health.slice(1)}
              </span>
              {isRunning && (
                <span className="text-gray-500 flex items-center gap-1">
                  <BrailleSpinner />
                  Running...
                </span>
              )}
            </div>
          </div>
        </div>
        <Link
          to="/settings"
          className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
        >
          <span className="hidden sm:inline">Settings</span>
          <ChevronRight size={16} />
        </Link>
      </div>

      {/* Status info */}
      {!isNever ? (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-port-bg/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock size={14} className="text-gray-400" />
              <span className="text-xs text-gray-500">Last backup</span>
            </div>
            <div className="text-sm font-semibold text-white truncate">
              {status?.lastRun ? timeAgo(status.lastRun) : '—'}
            </div>
            {status?.filesChanged != null && (
              <div className="text-xs text-gray-600">{status.filesChanged} files changed</div>
            )}
          </div>
          <div className="bg-port-bg/50 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <HealthIcon size={14} className={text} />
              <span className="text-xs text-gray-500">Next backup</span>
            </div>
            <div className="text-sm font-semibold text-white truncate">
              {status?.nextRun ? timeUntil(status.nextRun) : '—'}
            </div>
            {status?.destPath && (
              <div className="text-xs text-gray-600 truncate" title={status.destPath}>
                {status.destPath}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mb-4 p-3 rounded-lg bg-port-warning/10 border border-port-warning/20">
          <p className="text-sm text-port-warning font-medium">No backups yet</p>
          <p className="text-xs text-gray-500 mt-1">
            Configure a destination path in Settings, then trigger a manual backup to get started.
          </p>
        </div>
      )}

      {/* Error message */}
      {status?.status === 'error' && status.error && (
        <div className="mb-4 p-3 rounded-lg bg-port-error/10 border border-port-error/20 flex items-start gap-2">
          <XCircle size={14} className="text-port-error shrink-0 mt-0.5" />
          <p className="text-xs text-port-error">{status.error}</p>
        </div>
      )}

      {/* Actions row */}
      <div className="flex items-center gap-2">
        {/* Backup Now button */}
        <button
          onClick={handleBackupNow}
          disabled={triggering || isRunning}
          className="flex items-center gap-2 px-3 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[40px]"
        >
          {triggering ? (
            <BrailleSpinner />
          ) : (
            <RefreshCw size={14} />
          )}
          Backup Now
        </button>

        {/* Toggle snapshots */}
        <button
          onClick={() => setSnapshotsOpen(prev => !prev)}
          disabled={restoringSnapshotId !== null}
          className="flex items-center gap-1.5 px-3 py-2 bg-port-border/50 hover:bg-port-border text-gray-300 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[40px]"
        >
          <ChevronDown
            size={14}
            className={`transition-transform ${snapshotsOpen ? 'rotate-180' : ''}`}
          />
          Snapshots
        </button>
      </div>

      {/* Snapshots section */}
      {snapshotsOpen && (
        <div className="mt-4 pt-4 border-t border-port-border">
          <SnapshotList
            restoringSnapshotId={restoringSnapshotId}
            onRestoreStateChange={setRestoringSnapshotId}
          />
        </div>
      )}
    </div>
  );
});

export default BackupWidget;
