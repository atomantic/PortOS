import { useEffect, useState, useCallback } from 'react';
import { ListOrdered, Image as ImageIcon, Film, X, RefreshCw, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import { listMediaJobs, cancelMediaJob, cancelQueuedMediaJobs } from '../../services/apiMediaJobs.js';

const STATUS_BADGE = {
  queued: 'bg-port-border text-port-text-muted',
  running: 'bg-port-accent/30 text-port-accent',
  completed: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
  canceled: 'bg-port-warning/30 text-port-warning',
};

const KIND_ICON = { video: Film, image: ImageIcon };

// Embeds the live render queue inline on the Image / Video gen pages so the
// user can watch in-flight jobs (and cancel them) without leaving the page.
//
// Props:
//   kind        — 'image' | 'video' | undefined (no filter; shows both)
//   recentLimit — how many recent rows to show (default 5)
//   className   — extra classes on the outer card
export default function MediaJobsQueue({ kind, recentLimit = 5, className = '' }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showRecent, setShowRecent] = useState(false);

  const fetchJobs = useCallback(() => {
    listMediaJobs(kind ? { kind } : {})
      .then((data) => { setJobs(data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [kind]);

  useEffect(() => {
    fetchJobs();
    const t = setInterval(fetchJobs, 3000);
    return () => clearInterval(t);
  }, [fetchJobs]);

  const handleCancel = (id) => cancelMediaJob(id)
    .then(() => {
      // Optimistic update: queued jobs flip to 'canceled' immediately (the
      // worker won't pick them up). For running jobs leave the server status
      // alone and track a UI-only `cancelRequested` flag — the next poll
      // resolves to 'canceled' once the worker observes it.
      setJobs((prev) => prev.map((j) => {
        if (j.id !== id) return j;
        if (j.status === 'queued') return { ...j, status: 'canceled', cancelRequested: false };
        return { ...j, cancelRequested: true };
      }));
      toast.success('Cancel requested');
    })
    .catch((err) => toast.error(err?.message || 'Cancel failed'));

  const live = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const recent = jobs.filter((j) => j.status !== 'queued' && j.status !== 'running').slice(0, recentLimit);
  const queuedCount = live.filter((j) => j.status === 'queued').length;
  const headerLabel = kind ? `${kind === 'image' ? 'Image' : 'Video'} Render Queue` : 'Render Queue';

  const handleClearQueued = () => {
    if (!queuedCount) return;
    cancelQueuedMediaJobs(kind ? { kind } : {})
      .then(({ canceled }) => {
        // Optimistic flip: queued → canceled (running jobs stay untouched).
        // The next 3s poll will reconcile if anything raced through.
        setJobs((prev) => prev.map((j) => (j.status === 'queued' ? { ...j, status: 'canceled' } : j)));
        toast.success(`Cleared ${canceled} queued job${canceled === 1 ? '' : 's'}`);
      })
      .catch((err) => toast.error(err?.message || 'Clear failed'));
  };

  return (
    <div className={`bg-port-card border border-port-border rounded-xl p-4 space-y-2 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ListOrdered className="w-4 h-4 text-port-accent shrink-0" />
          <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide truncate">{headerLabel}</h2>
          <span className="text-xs text-port-text-muted">
            {live.length} active{recent.length > 0 ? ` • ${recent.length} recent` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {queuedCount > 0 && (
            <button
              onClick={handleClearQueued}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-port-error hover:bg-port-error/10 border border-port-border hover:border-port-error/40"
              title={`Cancel all ${queuedCount} queued job${queuedCount === 1 ? '' : 's'} (running jobs are not affected)`}
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear queued ({queuedCount})</span>
            </button>
          )}
          <button
            onClick={fetchJobs}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-port-text-muted text-xs">Loading…</div>
      ) : live.length === 0 && recent.length === 0 ? (
        <div className="text-port-text-muted text-xs">No {kind || 'media'} renders queued.</div>
      ) : (
        <div className="space-y-2">
          {live.map((j) => <JobRow key={j.id} job={j} onCancel={handleCancel} />)}

          {recent.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRecent((s) => !s)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 pt-1"
            >
              {showRecent ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {showRecent ? 'Hide' : 'Show'} recent ({recent.length})
            </button>
          )}
          {showRecent && recent.map((j) => <JobRow key={j.id} job={j} onCancel={handleCancel} />)}
        </div>
      )}
    </div>
  );
}

function JobRow({ job, onCancel }) {
  const Icon = KIND_ICON[job.kind] || Film;
  const canCancel = job.status === 'queued' || job.status === 'running';
  return (
    <div className="bg-port-bg border border-port-border rounded p-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-4 h-4 text-port-accent shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              <span className="font-mono">{job.id.slice(0, 8)}</span>
              <span className="text-port-text-muted"> · {job.kind}</span>
              {job.position && job.status === 'queued' && (
                <span className="text-port-text-muted"> · #{job.position} in queue</span>
              )}
            </div>
            <div className="text-xs text-port-text-muted truncate">
              {job.params?.prompt ? `"${job.params.prompt.slice(0, 80)}${job.params.prompt.length > 80 ? '…' : ''}"` : 'no prompt'}
              {job.owner && <span> · {job.owner}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE[job.status] || ''}`}>{job.status}</span>
          {job.cancelRequested && (
            <span className="text-xs text-port-warning" title="Cancellation requested — waiting for worker">cancelling…</span>
          )}
          {canCancel && !job.cancelRequested && (
            <button
              onClick={() => onCancel(job.id)}
              className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs hover:bg-port-error/20 hover:text-port-error"
              title="Cancel"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
      {job.status === 'failed' && job.error && (
        <div className="text-xs text-port-error mt-2 truncate" title={job.error}>{job.error}</div>
      )}
      <div className="text-xs text-port-text-muted mt-1">
        {job.queuedAt && `queued ${new Date(job.queuedAt).toLocaleTimeString()}`}
        {job.startedAt && ` · started ${new Date(job.startedAt).toLocaleTimeString()}`}
        {job.completedAt && ` · finished ${new Date(job.completedAt).toLocaleTimeString()}`}
      </div>
    </div>
  );
}
