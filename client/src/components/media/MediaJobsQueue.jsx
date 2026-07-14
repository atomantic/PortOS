import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { ListOrdered, Image as ImageIcon, Film, Cpu, X, RefreshCw, ChevronDown, ChevronRight, Trash2, RotateCw, Zap, Pencil } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { FormField } from '../ui/FormField';
import { listMediaJobs, cancelMediaJob, cancelQueuedMediaJobs, deleteMediaJob, retryMediaJob, runMediaJobNow } from '../../services/apiMediaJobs.js';
import { listLoraTrainingCheckpoints } from '../../services/apiLoraTraining.js';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';
import { lossSparklineGeometry } from '../../lib/lossSparkline';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';

const STATUS_BADGE = {
  queued: 'bg-port-border text-port-text-muted',
  running: 'bg-port-accent/30 text-port-accent',
  completed: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
  canceled: 'bg-port-warning/30 text-port-warning',
};

const KIND_ICON = { video: Film, image: ImageIcon, training: Cpu };

// Compact "engine / model" badge so a failed row tells the user *what* failed,
// not just that it failed. Codex jobs carry `params.model`; local image/video
// jobs carry `params.modelId`; training jobs carry a runtime + character.
// Trims long HF repo paths to the tail segment.
function modelLabel(params) {
  if (!params) return null;
  if (params.runtime || params.runId) {
    // Training job — surface the engine + who's being trained, not a prompt.
    const who = (params.characterName || '').trim();
    return `${params.runtime || 'training'}${who ? ` / ${who}` : ''}`;
  }
  if (params.mode === IMAGE_GEN_MODE.CODEX) {
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

  const fetchJobs = useCallback(async () => {
    const data = await listMediaJobs(kind ? { kind } : {}).catch(() => null);
    if (data) setJobs(data);
    setLoading(false);
  }, [kind]);

  useAutoRefetch(fetchJobs, 3000, { pollOnly: true });

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
  const KIND_LABEL = { image: 'Image', video: 'Video', training: 'Training' };
  const headerLabel = kind ? `${KIND_LABEL[kind] || ''} ${kind === 'training' ? 'Queue' : 'Render Queue'}`.trim() : 'Render Queue';

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
        <div className="text-port-text-muted text-xs">
          No {kind || 'media'} {kind === 'training' ? 'runs' : 'renders'} queued.
        </div>
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

// One-line training summary in place of the (absent) prompt: who's training,
// the LoRA rank, and the step budget.
function trainingSummary(params) {
  if (!params) return 'training';
  const who = (params.characterName || '').trim();
  const bits = [
    who ? `Training "${who}"` : 'Training',
    Number.isFinite(params.rank) ? `rank ${params.rank}` : null,
    Number.isFinite(params.steps) ? `${params.steps} steps` : null,
  ].filter(Boolean);
  return bits.join(' · ');
}

// Training-specific row treatment: a loss sparkline over the run's checkpoints
// plus the latest sample thumbnails. The media-job record carries no loss /
// sample data, so fetch the run's checkpoint list (step + loss + previewUrl).
// Re-fetches while the run is live so the curve grows as checkpoints land.
function TrainingJobDetail({ runId, status }) {
  const [checkpoints, setCheckpoints] = useState(null); // null = loading; [] = none yet
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(() => {
    listLoraTrainingCheckpoints(runId)
      .then((res) => {
        if (mountedRef.current) setCheckpoints(Array.isArray(res?.checkpoints) ? res.checkpoints : []);
      })
      .catch(() => { if (mountedRef.current) setCheckpoints([]); });
  }, [runId]);

  useEffect(() => { load(); }, [load]);
  // Poll only while the run is live — a terminal run's checkpoints are fixed.
  useEffect(() => {
    if (status !== 'running' && status !== 'queued') return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [status, load]);

  if (checkpoints === null) {
    return <div className="mt-2 text-[11px] text-port-text-muted">Loading checkpoints…</div>;
  }
  if (!checkpoints.length) {
    return (
      <div className="mt-2 text-[11px] text-port-text-muted">
        No checkpoints yet — samples + loss appear once the first one is saved.
      </div>
    );
  }

  const series = checkpoints
    .filter((c) => Number.isFinite(c.loss))
    .map((c) => ({ step: c.step, loss: c.loss }));
  const geo = lossSparklineGeometry(series, { width: 240, height: 36 });
  const withPreview = checkpoints.filter((c) => c.previewUrl);

  return (
    <div className="mt-2 space-y-2">
      {geo.points && (
        <div>
          <div className="flex items-center justify-between text-[11px] text-port-text-muted mb-0.5">
            <span>Loss · {series.length} checkpoints</span>
            {geo.last != null && <span className="text-gray-400 font-mono">{geo.last.toFixed(4)}</span>}
          </div>
          <svg
            viewBox="0 0 240 36"
            preserveAspectRatio="none"
            className="w-full h-9 bg-port-bg rounded border border-port-border"
            role="img"
            aria-label={`Training loss curve over ${series.length} checkpoints${geo.last != null ? `, latest ${geo.last.toFixed(4)}` : ''}`}
          >
            <polyline points={geo.points} fill="none" stroke="#3b82f6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}
      {withPreview.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {withPreview.map((c) => (
            <div key={c.step} className="shrink-0 text-center">
              <img
                src={c.previewUrl}
                alt={`sample @ step ${c.step}`}
                loading="lazy"
                className={`w-14 h-14 object-cover rounded border ${c.deployed ? 'border-port-accent' : 'border-port-border'}`}
              />
              <div className="text-[10px] text-port-text-muted mt-0.5">{c.step}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({ job, onCancel, onRetry, onRunNow, onDelete }) {
  const Icon = KIND_ICON[job.kind] || Film;
  const canCancel = job.status === 'queued' || job.status === 'running';
  const canRetry = (job.status === 'failed' || job.status === 'canceled') && typeof onRetry === 'function';
  // Delete only on terminal rows — live jobs go through Cancel.
  const canDelete = (job.status === 'failed' || job.status === 'canceled' || job.status === 'completed')
    && typeof onDelete === 'function';
  // Run-now is codex-only — GPU jobs serialize on the single MLX runtime.
  const isQueuedCodex = job.status === 'queued' && job.kind === 'image' && job.params?.mode === IMAGE_GEN_MODE.CODEX;
  const canRunNow = isQueuedCodex && typeof onRunNow === 'function';
  // Number.isFinite (not typeof === 'number') so a NaN from a hand-edited
  // media-jobs.json can't render as `NaN%` / `width: NaN%`.
  const progressPct = Number.isFinite(job.progress)
    ? Math.max(0, Math.min(100, Math.round(job.progress * 100)))
    : 0;
  // Inline edit form for retry-with-overrides.
  const [editing, setEditing] = useState(false);
  const canEdit = canRetry;
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
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
              {job.kind === 'training'
                ? trainingSummary(job.params)
                : (job.params?.prompt ? `"${job.params.prompt.slice(0, 80)}${job.params.prompt.length > 80 ? '…' : ''}"` : 'no prompt')}
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
              aria-label="Cancel"
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
            isConfirming(job.id) ? (
              <ConfirmButtonPair
                prompt="Remove?"
                confirmText="Remove"
                onConfirm={() => confirmDelete(() => onDelete(job.id))}
                onCancel={cancelDelete}
                ariaLabel="Confirm remove job from history"
              />
            ) : (
              <button
                onClick={() => requestDelete(job.id)}
                className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-gray-500 hover:text-port-error hover:border-port-error/50"
                title="Remove this row from the history"
                aria-label="Delete from history"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )
          )}
        </div>
      </div>
      {job.status === 'failed' && job.error && (
        <div className="text-xs text-port-error mt-2 truncate" title={job.error}>{job.error}</div>
      )}
      {job.status === 'running' && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs text-port-text-muted">
            <span className="truncate" title={job.statusMsg || undefined}>{job.statusMsg || 'Running'}</span>
            <span className="font-mono shrink-0">{progressPct}%</span>
          </div>
          <div className="h-1.5 bg-port-border rounded overflow-hidden">
            <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}
      {job.kind === 'training' && job.params?.runId && (
        <TrainingJobDetail runId={job.params.runId} status={job.status} />
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
  const isCodex = p.mode === IMAGE_GEN_MODE.CODEX;
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
      <FormField label="Prompt" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs"
          maxLength={8000}
        />
      </FormField>
      <FormField label="Negative prompt" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
        <textarea
          value={negativePrompt}
          onChange={(e) => setNegativePrompt(e.target.value)}
          rows={2}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs"
          maxLength={8000}
        />
      </FormField>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <FormField className="col-span-2" label={isCodex ? 'Codex model' : 'Model id'} labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="text"
            value={isCodex ? model : modelId}
            onChange={(e) => (isCodex ? setModel(e.target.value) : setModelId(e.target.value))}
            placeholder={isCodex ? 'leave empty for default' : 'e.g. z-image-turbo-bf16'}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
            maxLength={200}
          />
        </FormField>
        <FormField label="Width" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="number" min={64} max={4096} step={8}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </FormField>
        <FormField label="Height" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="number" min={64} max={4096} step={8}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </FormField>
        <FormField label="Steps" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="number" min={1} max={200} step={1}
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </FormField>
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
