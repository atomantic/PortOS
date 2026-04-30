import { useState, memo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {HardDrive,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Eye,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock} from 'lucide-react';
import BrailleSpinner from './BrailleSpinner';
import toast from './ui/Toast';
import * as api from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function computeHealth(status) {
  if (!status || status.status === 'error') return 'critical';
  if (status.status === 'never') return 'warning';
  if (status.status === 'running') return 'healthy';
  if (!status.lastRun) return 'warning';
  const hoursSince = (Date.now() - new Date(status.lastRun).getTime()) / (1000 * 60 * 60);
  if (hoursSince < 25) return 'healthy';
  if (hoursSince < 49) return 'warning';
  return 'critical';
}

function relativeTime(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.floor(abs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let label;
  if (minutes < 2) label = 'just now';
  else if (minutes < 60) label = `${minutes} min`;
  else if (hours < 24) label = `${hours} hour${hours !== 1 ? 's' : ''}`;
  else label = `${days} day${days !== 1 ? 's' : ''}`;

  if (label === 'just now') return label;
  return future ? `in ${label}` : `${label} ago`;
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

// ---------------------------------------------------------------------------
// RestorePanel
// ---------------------------------------------------------------------------

function RestorePanel({ snapshot, onClose }) {
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    setPreview(null);
    const result = await api.restoreBackup({
      snapshotId: snapshot.id,
      dryRun: true,
      subdirFilter: filter.trim() || null
    }).catch(err => {
      toast.error(`Preview failed: ${err.message}`);
      return null;
    });
    setPreviewing(false);
    if (result) setPreview(result);
  }, [snapshot.id, filter]);

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    const result = await api.restoreBackup({
      snapshotId: snapshot.id,
      dryRun: false,
      subdirFilter: filter.trim() || null
    }).catch(err => {
      toast.error(`Restore failed: ${err.message}`);
      return null;
    });
    setRestoring(false);
    if (result) {
      toast.success(`Restore complete — ${result.changedFiles?.length ?? 0} file(s) restored`);
      onClose();
    }
  }, [snapshot.id, filter, onClose]);

  return (
    <div className="mt-3 p-3 bg-port-bg rounded-lg border border-port-border space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-300">
          Restore snapshot: {snapshot.id}
        </span>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors text-xs min-h-[32px] px-1"
        >
          Cancel
        </button>
      </div>

      {/* Subdirectory filter */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          Selective restore (optional)
        </label>
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
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
        disabled={previewing}
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

function SnapshotList() {
  const { data: snapshots, loading } = useAutoRefetch(
    () => api.getBackupSnapshots({ silent: true }).catch(() => null),
    120000
  );
  const [selectedId, setSelectedId] = useState(null);

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
        <div key={snap.id}>
          <div className="flex items-center justify-between py-1.5 px-2 rounded bg-port-bg/50 hover:bg-port-bg/80 transition-colors">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-gray-300 font-mono truncate">{snap.id}</div>
              <div className="text-xs text-gray-600">{snap.fileCount} files</div>
            </div>
            <button
              onClick={() => setSelectedId(selectedId === snap.id ? null : snap.id)}
              className="ml-2 flex items-center gap-1 px-2 py-1 text-xs text-port-accent hover:text-port-accent/80 transition-colors min-h-[32px]"
            >
              <RotateCcw size={12} />
              Restore
            </button>
          </div>
          {selectedId === snap.id && (
            <RestorePanel
              snapshot={snap}
              onClose={() => setSelectedId(null)}
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
  const { data: status } = useAutoRefetch(
    () => api.getBackupStatus({ silent: true }).catch(() => null),
    60000
  );
  const [triggering, setTriggering] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);

  const health = computeHealth(status);
  const { dot, text, icon: HealthIcon } = HEALTH_STYLES[health];

  const handleBackupNow = useCallback(async () => {
    setTriggering(true);
    await api.triggerBackup().catch(err => {
      toast.error(`Backup failed: ${err.message}`);
    }).then(result => {
      if (result) {
        toast.success('Backup started', { icon: '💾' });
      }
    });
    setTriggering(false);
  }, []);

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
              {status?.lastRun ? relativeTime(status.lastRun) : '—'}
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
              {status?.nextRun ? relativeTime(status.nextRun) : '—'}
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
          className="flex items-center gap-1.5 px-3 py-2 bg-port-border/50 hover:bg-port-border text-gray-300 rounded-lg text-sm transition-colors min-h-[40px]"
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
          <SnapshotList />
        </div>
      )}
    </div>
  );
});

export default BackupWidget;
