import { useEffect, useMemo, useState, useCallback } from 'react';
import { ListOrdered, Image as ImageIcon, Film, X, RefreshCw, ChevronDown, ChevronRight, Trash2, RotateCw, Zap, Pencil } from 'lucide-react';
import toast from '../ui/Toast';
import { listMediaJobs, cancelMediaJob, cancelQueuedMediaJobs, deleteMediaJob, retryMediaJob, runMediaJobNow } from '../../services/apiMediaJobs.js';

const STATUS_BADGE = {
  queued: 'bg-port-border text-port-text-muted',
  running: 'bg-port-accent/30 text-port-accent',
  completed: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
  canceled: 'bg-port-warning/30 text-port-warning',
};

const KIND_ICON = { video: Film, image: ImageIcon };

// Compact "engine / model" badge so a failed row tells the user *what* failed,
// not just that it failed. Codex jobs carry `params.model`; local image/video
// jobs carry `params.modelId`. Trims long HF repo paths to the tail segment.
function modelLabel(params) {
  if (!params) return null;
  if (params.mode === 'codex') {
    const m = (params.model || '').trim();
    return m ? `codex / ${m}` : 'codex';
  }
  const id = (params.modelId || '').trim();
  if (!id) return 'local';
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return `local / ${tail}`;
}

// Embeds the live render queue inline on the Image / Video gen pages so the
// user can watch in-flight jobs (and cancel them) without leaving the page.
// Completed jobs are excluded from the recent reel — those render as preview
// cards on the gen page already, so listing them here is duplicate noise.
export default function MediaJobsQueue({ kind, recentLimit = 10, className = '' }) {
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

  const { live, recent, queuedCount, failedCount } = useMemo(() => {
    const liveJobs = [];
    const recentJobs = [];
    let queued = 0;
    let failed = 0;
    for (const j of jobs) {
      if (j.status === 'queued' || j.status === 'running') {
        liveJobs.push(j);
        if (j.status === 'queued') queued += 1;
      } else if ((j.status === 'failed' || j.status === 'canceled') && recentJobs.length < recentLimit) {
        recentJobs.push(j);
        if (j.status === 'failed') failed += 1;
      }
    }
    return { live: liveJobs, recent: recentJobs, queuedCount: queued, failedCount: failed };
  }, [jobs, recentLimit]);

  // Accepts optional `overrides` so the inline Edit form can patch prompt /
  // negativePrompt / model / dimensions before the re-enqueue. No overrides =
  // same behavior as the plain Retry button.
  const handleRetry = (id, overrides = null) => retryMediaJob(id, overrides)
    .then(({ jobId }) => {
      toast.success(`Re-queued as ${jobId.slice(0, 8)}${overrides ? ' (edited)' : ''}`);
      // Optimistic: drop the original failed/canceled row immediately. The
      // server's retry endpoint already prunes it from the archive, but the
      // next 3s poll would otherwise leave the stale row + button visible.
      setJobs((prev) => prev.filter((j) => j.id !== id));
      fetchJobs();
    })
    .catch((err) => toast.error(err?.message || 'Retry failed'));

  const handleRunNow = (id) => runMediaJobNow(id)
    .then(() => {
      toast.success('Started in parallel');
      fetchJobs();
    })
    .catch((err) => toast.error(err?.message || 'Run-now failed'));

  const handleDelete = (id) => deleteMediaJob(id)
    .then(() => {
      setJobs((prev) => prev.filter((j) => j.id !== id));
    })
    .catch((err) => toast.error(err?.message || 'Delete failed'));
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
          <span className="text-xs text-port-text-muted">{formatCounts(live, recent, failedCount)}</span>
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
          {live.map((j) => <JobRow key={j.id} job={j} onCancel={handleCancel} onRetry={handleRetry} onRunNow={handleRunNow} />)}

          {recent.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRecent((s) => !s)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 pt-1"
            >
              {showRecent ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {showRecent ? 'Hide' : 'Show'} failed / canceled ({recent.length})
            </button>
          )}
          {showRecent && recent.map((j) => <JobRow key={j.id} job={j} onCancel={handleCancel} onRetry={handleRetry} onDelete={handleDelete} />)}
        </div>
      )}
    </div>
  );
}

function formatCounts(live, recent, failedCount) {
  const parts = [`${live.length} active`];
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  const canceledCount = recent.length - failedCount;
  if (canceledCount > 0) parts.push(`${canceledCount} canceled`);
  return parts.join(' • ');
}

function JobRow({ job, onCancel, onRetry, onRunNow, onDelete }) {
  const Icon = KIND_ICON[job.kind] || Film;
  const canCancel = job.status === 'queued' || job.status === 'running';
  const canRetry = (job.status === 'failed' || job.status === 'canceled') && typeof onRetry === 'function';
  // Delete only on terminal rows — live jobs go through Cancel.
  const canDelete = (job.status === 'failed' || job.status === 'canceled' || job.status === 'completed')
    && typeof onDelete === 'function';
  // Run-now is codex-only — GPU jobs serialize on the single MLX runtime.
  const isQueuedCodex = job.status === 'queued' && job.kind === 'image' && job.params?.mode === 'codex';
  const canRunNow = isQueuedCodex && typeof onRunNow === 'function';
  // Inline edit form for retry-with-overrides.
  const [editing, setEditing] = useState(false);
  const canEdit = canRetry;
  return (
    <div className="bg-port-bg border border-port-border rounded p-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-4 h-4 text-port-accent shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              <span className="font-mono">{job.id.slice(0, 8)}</span>
              <span className="text-port-text-muted"> · {job.kind}</span>
              {modelLabel(job.params) && (
                <span className="text-port-text-muted" title={job.params.model || job.params.modelId || ''}>
                  {' · '}{modelLabel(job.params)}
                </span>
              )}
              {job.position && job.status === 'queued' && (
                <span className="text-port-text-muted"> · #{job.position} in queue</span>
              )}
            </div>
            <div className="text-xs text-port-text-muted truncate" title={job.params?.prompt || undefined}>
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
          {canRunNow && (
            <button
              onClick={() => onRunNow(job.id)}
              className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-gray-300 hover:text-port-warning hover:border-port-warning/50"
              title="Run now — start in parallel with currently-running jobs (bypasses the configured codex parallel limit for this one job)"
            >
              <Zap className="w-3 h-3" />
              <span>Run now</span>
            </button>
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
          {canEdit && (
            <button
              onClick={() => setEditing((s) => !s)}
              className={`flex items-center gap-1 px-2 py-1 bg-port-bg border rounded text-xs ${editing ? 'border-port-accent/60 text-port-accent' : 'border-port-border text-gray-500 hover:text-gray-300 hover:border-port-border'}`}
              title="Edit prompt / config, then retry"
              aria-label="Edit and retry"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {canRetry && (
            <button
              onClick={() => onRetry(job.id)}
              className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-gray-300 hover:text-port-accent hover:border-port-accent/50"
              title="Re-queue this job with the same params"
            >
              <RotateCw className="w-3 h-3" />
              <span>Retry</span>
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => onDelete(job.id)}
              className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-gray-500 hover:text-port-error hover:border-port-error/50"
              title="Remove this row from the history"
              aria-label="Delete from history"
            >
              <Trash2 className="w-3 h-3" />
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
      {editing && (
        <EditRetryForm
          job={job}
          onSubmit={(overrides) => {
            setEditing(false);
            onRetry(job.id, overrides);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// Inline form for the Edit-and-retry flow. Shows the fields the server's
// retry override schema accepts (prompt, negative, model, dimensions, steps)
// and submits only the keys the user actually changed — leaving unchanged
// fields out of the patch so the original job's values ride through.
function EditRetryForm({ job, onSubmit, onCancel }) {
  const p = job.params || {};
  const isCodex = p.mode === 'codex';
  const [prompt, setPrompt] = useState(p.prompt || '');
  const [negativePrompt, setNegativePrompt] = useState(p.negativePrompt || '');
  const [model, setModel] = useState(p.model || '');
  const [modelId, setModelId] = useState(p.modelId || '');
  const [width, setWidth] = useState(p.width ?? '');
  const [height, setHeight] = useState(p.height ?? '');
  const [steps, setSteps] = useState(p.steps ?? '');

  const submit = (e) => {
    e.preventDefault();
    const overrides = {};
    const trimEq = (a, b) => (a || '').trim() === (b || '').trim();
    const numEq = (a, b) => (a === '' ? null : Number(a)) === (b ?? null);
    if (!trimEq(prompt, p.prompt) && prompt.trim()) overrides.prompt = prompt.trim();
    if (!trimEq(negativePrompt, p.negativePrompt)) overrides.negativePrompt = negativePrompt.trim();
    if (isCodex && !trimEq(model, p.model)) overrides.model = model.trim();
    if (!isCodex && !trimEq(modelId, p.modelId)) overrides.modelId = modelId.trim();
    if (!numEq(width, p.width) && width !== '') overrides.width = Number(width);
    if (!numEq(height, p.height) && height !== '') overrides.height = Number(height);
    if (!numEq(steps, p.steps) && steps !== '') overrides.steps = Number(steps);
    onSubmit(Object.keys(overrides).length ? overrides : null);
  };

  return (
    <form onSubmit={submit} className="mt-3 pt-3 border-t border-port-border space-y-2">
      <label className="block text-[10px] uppercase tracking-wide text-port-text-muted">Prompt</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs"
        maxLength={8000}
      />
      <label className="block text-[10px] uppercase tracking-wide text-port-text-muted">Negative prompt</label>
      <textarea
        value={negativePrompt}
        onChange={(e) => setNegativePrompt(e.target.value)}
        rows={2}
        className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs"
        maxLength={8000}
      />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="col-span-2">
          <label className="block text-[10px] uppercase tracking-wide text-port-text-muted">{isCodex ? 'Codex model' : 'Model id'}</label>
          <input
            type="text"
            value={isCodex ? model : modelId}
            onChange={(e) => (isCodex ? setModel(e.target.value) : setModelId(e.target.value))}
            placeholder={isCodex ? 'leave empty for default' : 'e.g. z-image-turbo-bf16'}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
            maxLength={200}
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-port-text-muted">Width</label>
          <input
            type="number" min={64} max={4096} step={8}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-port-text-muted">Height</label>
          <input
            type="number" min={64} max={4096} step={8}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-port-text-muted">Steps</label>
          <input
            type="number" min={1} max={200} step={1}
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 text-xs text-port-text-muted hover:text-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="inline-flex items-center gap-1 px-3 py-1 bg-port-accent text-white text-xs rounded hover:bg-port-accent/90"
        >
          <RotateCw className="w-3 h-3" />
          Retry with changes
        </button>
      </div>
    </form>
  );
}
