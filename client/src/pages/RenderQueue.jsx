import { useEffect, useState, useCallback } from 'react';
import { ListOrdered, Image as ImageIcon, Film, X, RefreshCw } from 'lucide-react';
import toast from '../components/ui/Toast';
import { listMediaJobs, cancelMediaJob } from '../services/apiMediaJobs.js';

const STATUS_BADGE = {
  queued: 'bg-port-border text-port-text-muted',
  running: 'bg-port-accent/30 text-port-accent',
  completed: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
  canceled: 'bg-port-warning/30 text-port-warning',
};

const KIND_ICON = {
  video: Film,
  image: ImageIcon,
};

export default function RenderQueue() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchJobs = useCallback(() => {
    listMediaJobs()
      .then((data) => { setJobs(data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchJobs();
    const t = setInterval(fetchJobs, 3000);
    return () => clearInterval(t);
  }, [fetchJobs]);

  const handleCancel = async (id) => {
    try {
      await cancelMediaJob(id);
      // Optimistic update: queued jobs flip straight to 'canceled' (the worker
      // never picks them up so the next poll will show the same). For running
      // jobs we leave the server status as-is and track a UI-only
      // `cancelRequested` flag so the badge stays valid (the server status
      // model only knows queued|running|completed|failed|canceled — using a
      // synthetic 'canceling' here would render an unstyled badge until the
      // next poll). The next /jobs poll resolves the row to 'canceled' once
      // the worker observes the cancellation.
      setJobs((prev) => prev.map((j) => {
        if (j.id !== id) return j;
        if (j.status === 'queued') return { ...j, status: 'canceled', cancelRequested: false };
        return { ...j, cancelRequested: true };
      }));
      toast.success('Cancel requested');
    } catch (err) {
      toast.error(err.message || 'Cancel failed');
    }
  };

  if (loading) return <div className="text-port-text-muted text-sm">Loading…</div>;

  const live = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const recent = jobs.filter((j) => j.status !== 'queued' && j.status !== 'running').slice(0, 30);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListOrdered className="w-5 h-5 text-port-accent" />
          <h2 className="text-lg font-semibold">Render Queue</h2>
          <span className="text-xs text-port-text-muted">
            {live.length} active • {recent.length} recent
          </span>
        </div>
        <button onClick={fetchJobs} className="flex items-center gap-1 px-2 py-1 bg-port-card border border-port-border rounded text-xs">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {live.length === 0 && (
        <div className="text-port-text-muted text-sm">No image or video renders in flight.</div>
      )}

      {live.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-port-text-muted uppercase tracking-wide">Active</h3>
          {live.map((j) => <JobRow key={j.id} job={j} onCancel={handleCancel} />)}
        </section>
      )}

      {recent.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-port-text-muted uppercase tracking-wide">Recent (last 24h)</h3>
          {recent.map((j) => <JobRow key={j.id} job={j} onCancel={handleCancel} />)}
        </section>
      )}
    </div>
  );
}

function JobRow({ job, onCancel }) {
  const Icon = KIND_ICON[job.kind] || Film;
  const canCancel = job.status === 'queued' || job.status === 'running';
  return (
    <div className="bg-port-card border border-port-border rounded p-3">
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
