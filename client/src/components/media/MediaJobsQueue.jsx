import { useMemo, useState, useCallback, useEffect } from 'react';
import { ListOrdered, Image as ImageIcon, Film, Cpu, X, RefreshCw, ChevronDown, ChevronRight, Trash2, RotateCw, Zap, Pencil } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { FormField } from '../ui/FormField';
import { listMediaJobs, cancelMediaJob, cancelQueuedMediaJobs, deleteMediaJob, retryMediaJob, runMediaJobNow } from '../../services/apiMediaJobs.js';
import { listLoraTrainingCheckpoints } from '../../services/apiLoraTraining.js';
import { isCloudCliMode, IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_EFFORT, supportsCloudModelOverride, modeLabel } from '../../lib/imageGenBackends';
import { ANTIGRAVITY_CONFIGURED_DEFAULT, CODEX_EFFORT_LEVELS, isConfiguredDefaultModel } from '../../utils/providers';
import { lossSparklineGeometry } from '../../lib/lossSparkline';
import {
  DEFAULT_I2V_REFERENCE_MODE, isDefaultI2vReferenceMode, normalizeI2vReferenceMode,
  resolveI2vReferenceStrength, runtimeSupportsI2vReferenceMode,
} from '../../lib/videoReferenceModes';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import useMounted from '../../hooks/useMounted';
import { formatTimeOfDaySeconds } from '../../utils/formatters';
import { getVideoGenStatus } from '../../services/apiImageVideo.js';
import { listLorasFull } from '../../services/api';
import ModelSelect from '../ModelSelect';
import ResolutionField from './ResolutionField';
import AdvancedParamsPanel from '../videoGen/AdvancedParamsPanel';
import { resolutionOptionsForModel } from '../../lib/videoGenResolutions';
import {
  videoEdgeBoundsForModel, textEncoderOptionsForModel, STOCK_TEXT_ENCODER_ID,
  normalizeTextEncoderForModel,
  DEFAULT_SPEED_PROFILE_ID, normalizeSpeedProfileForModel, speedProfileIdFromRecord,
  isFullDecodeId, resolveDraftDecodeForModel, draftDecodeFromRecord,
} from '../../lib/videoGenParams';
import { isDeliveryVideoModel } from '../../lib/videoFinish';
import { loraFamilyOf, videoLoraFamily } from '../../lib/runnerFamilies';
import LoraPicker from '../imageGen/LoraPicker';

const STATUS_BADGE = {
  queued: 'bg-port-border text-port-text-muted',
  running: 'bg-port-accent/30 text-port-accent',
  completed: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
  canceled: 'bg-port-warning/30 text-port-warning',
};

const KIND_ICON = { video: Film, image: ImageIcon, training: Cpu };

// Creative Director scene renders use the same durable media queue as manual
// Video Gen renders, but carry an owner tag so the orchestrator can reconcile
// completion. Keep that ownership visible in the shared queue: otherwise an
// agent-enqueued render looks like an unrelated anonymous video job (or, when
// the prompt is absent on a malformed projection, like no useful row at all).
const isCreativeDirectorJob = (job) => typeof job?.owner === 'string'
  && (job.owner.startsWith('cd:') || job.owner.startsWith('creative-director:'));

const ownerLabel = (job) => isCreativeDirectorJob(job) ? 'Creative Director' : job?.owner;

// Safe-read a Codex job's stored reasoning effort. Mirrors codex.js's server-side
// guard (`typeof effort === 'string' && effort.trim()`): a non-string value from
// hand-edited media-jobs.json returns '' instead of throwing on `.trim()`, and a
// blank/absent value returns '' so callers can apply their own fallback (the row
// resolves to the shipped default level; the retry editor to its 'default' option).
const codexEffortOf = (raw) => (typeof raw === 'string' ? raw.trim() : '');

// Compact "engine / model" badge so a failed row tells the user *what* failed,
// not just that it failed. Codex jobs carry `params.model`; local image/video
// jobs carry `params.modelId`; training jobs carry a runtime + character. A
// federated job is badged `remote` off the server-projected `job.renderer`.
// Trims long HF repo paths to the tail segment.
function modelLabel(params, renderer) {
  if (!params) return null;
  if (params.runtime || params.runId) {
    // Training job — surface the engine + who's being trained, not a prompt.
    const who = (params.characterName || '').trim();
    return `${params.runtime || 'training'}${who ? ` / ${who}` : ''}`;
  }
  if (params.mode === IMAGE_GEN_MODE.CODEX) {
    const m = (params.model || '').trim();
    // Resolve the effective effort. `codexEffortOf` mirrors codex.js's own guard
    // (`typeof === 'string' && trim`) so a non-string effort from hand-edited
    // media-jobs.json can't throw on `.trim()`; an absent/blank value resolves to
    // the shipped default the server actually rendered at.
    const eff = codexEffortOf(params.effort) || CODEX_IMAGEGEN_DEFAULT_EFFORT;
    const base = m ? `codex / ${m}` : 'codex';
    return `${base} · ${eff}`;
  }
  if (params.mode === IMAGE_GEN_MODE.GROK) {
    // No model/effort knobs — grok's image tools run on xAI's fixed backend;
    // the aspect ratio is the only distinguishing render param.
    const ratio = (typeof params.aspectRatio === 'string' ? params.aspectRatio.trim() : '');
    return ratio ? `grok · ${ratio}` : 'grok';
  }
  if (params.mode === IMAGE_GEN_MODE.AGY) {
    const model = (typeof params.model === 'string' ? params.model.trim() : '');
    return model && model !== ANTIGRAVITY_CONFIGURED_DEFAULT
      ? `agy / ${model}`
      : 'agy / configured default';
  }
  const id = (params.modelId || '').trim();
  // A federated render ran on a peer, so it must not wear the local badge. The
  // server projects `job.renderer` (and rebuilds `modelId` off the wire request)
  // for exactly this — the raw job nulls both to fail closed on a downgrade.
  const where = renderer === 'remote' ? 'remote' : 'local';
  if (!id) return where;
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return `${where} / ${tail}`;
}

// Embeds the live render queue inline on the Image / Video gen pages so the
// user can watch in-flight jobs (and cancel them) without leaving the page.
// Completed jobs are excluded from the recent reel — those render as preview
// cards on the gen page already, so listing them here is duplicate noise.
export default function MediaJobsQueue({ kind, recentLimit = 10, className = '' }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [showRecent, setShowRecent] = useState(false);

  const fetchJobs = useCallback(async () => {
    const outcome = await listMediaJobs(kind ? { kind } : {}).then(
      (value) => ({ value }),
      () => ({ error: true }),
    );
    if (outcome.error || !Array.isArray(outcome.value)) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    setJobs(outcome.value);
    setHasSnapshot(true);
    setLoadError(false);
    setLoading(false);
  }, [kind]);

  useAutoRefetch(fetchJobs, 3000, { pollOnly: true });

  const handleCancel = (id) => cancelMediaJob(id, { silent: true })
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
  const handleRetry = (id, overrides = null) => retryMediaJob(id, overrides, { silent: true })
    .then(({ jobId }) => {
      toast.success(`Re-queued as ${jobId.slice(0, 8)}${overrides ? ' (edited)' : ''}`);
      // Optimistic: drop the original failed/canceled row immediately. The
      // server's retry endpoint already prunes it from the archive, but the
      // next 3s poll would otherwise leave the stale row + button visible.
      setJobs((prev) => prev.filter((j) => j.id !== id));
      fetchJobs();
    })
    .catch((err) => toast.error(err?.message || 'Retry failed'));

  const handleRunNow = (id) => runMediaJobNow(id, { silent: true })
    .then(() => {
      toast.success('Started in parallel');
      fetchJobs();
    })
    .catch((err) => toast.error(err?.message || 'Run-now failed'));

  const handleDelete = (id) => deleteMediaJob(id, { silent: true })
    .then(() => {
      setJobs((prev) => prev.filter((j) => j.id !== id));
    })
    .catch((err) => toast.error(err?.message || 'Delete failed'));
  const KIND_LABEL = { image: 'Image', video: 'Video', training: 'Training' };
  const headerLabel = kind ? `${KIND_LABEL[kind] || ''} ${kind === 'training' ? 'Queue' : 'Render Queue'}`.trim() : 'Render Queue';

  const handleClearQueued = () => {
    if (!queuedCount) return;
    cancelQueuedMediaJobs(kind ? { kind } : {}, { silent: true })
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
            {loadError && !hasSnapshot ? 'status unavailable' : formatCounts(live, recent, failedCount)}
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
            title="Refresh" aria-label="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {loadError && hasSnapshot && (
        <div className="rounded border border-port-warning/30 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          Queue refresh failed. Showing the last known snapshot.
        </div>
      )}

      {loading && !hasSnapshot ? (
        <div className="text-xs"><BrailleSpinner text="Loading…" /></div>
      ) : loadError && !hasSnapshot ? (
        <div className="text-xs text-port-warning">Queue status unavailable.</div>
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
  const mountedRef = useMounted();

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
  const isQueuedCloud = job.status === 'queued' && job.kind === 'image' && isCloudCliMode(job.params?.mode);
  const canRunNow = isQueuedCloud && typeof onRunNow === 'function';
  // Number.isFinite (not typeof === 'number') so a NaN from a hand-edited
  // media-jobs.json can't render as `NaN%` / `width: NaN%`.
  const progressPct = Number.isFinite(job.progress)
    ? Math.max(0, Math.min(100, Math.round(job.progress * 100)))
    : 0;
  // Inline edit form for retry-with-overrides.
  const [editing, setEditing] = useState(false);
  // A federated job renders from the wire request inside its `remoteMedia`
  // marker, so a prompt/model edit here would never reach the peer — and the
  // server re-normalizes the retry anyway. Offer the plain Retry, not the
  // editor, rather than showing a form whose edits are silently discarded.
  const canEdit = canRetry && job.renderer !== 'remote';
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
              {modelLabel(job.params, job.renderer) && (
                <span className="text-port-text-muted" title={job.params.model || job.params.modelId || ''}>
                  {' · '}{modelLabel(job.params, job.renderer)}
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
              {ownerLabel(job) && <span> · {ownerLabel(job)}</span>}
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
        {job.queuedAt && `queued ${formatTimeOfDaySeconds(job.queuedAt)}`}
        {job.startedAt && ` · started ${formatTimeOfDaySeconds(job.startedAt)}`}
        {job.completedAt && ` · finished ${formatTimeOfDaySeconds(job.completedAt)}`}
      </div>
      {editing && (job.kind === 'video' ? (
          <VideoRetryForm
            job={job}
            onSubmit={(overrides) => {
              setEditing(false);
              onRetry(job.id, overrides);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <EditRetryForm
            job={job}
            onSubmit={(overrides) => {
              setEditing(false);
              onRetry(job.id, overrides);
            }}
            onCancel={() => setEditing(false)}
          />
        ))}
    </div>
  );
}

// Clear-to-default sentinel for the Codex reasoning-effort control — mirrors the
// server's EFFORT_CLEAR_SENTINEL in routes/mediaJobs.js. A job with no explicit
// effort is "using the shipped default", represented in the <select> by this value;
// submitting it against a job that HAD an explicit effort tells the server to reset
// to the default (drop params.effort).
const EFFORT_DEFAULT_OPTION = 'default';

// Inline form for the Edit-and-retry flow. Shows the fields the server's
// retry override schema accepts (prompt, negative, model, dimensions, steps, effort)
// and submits only the keys the user actually changed — leaving unchanged
// fields out of the patch so the original job's values ride through.
function EditRetryForm({ job, onSubmit, onCancel }) {
  const p = job.params || {};
  const isCodex = p.mode === IMAGE_GEN_MODE.CODEX;
  // Codex and Agy both run under a CLI model id carried on `params.model`;
  // local jobs use `params.modelId` (a PortOS image-model registry id). Binding
  // an Agy retry to `modelId` would edit a field its provider never reads AND
  // leave the actual model unchangeable, so the field follows `params.model`
  // for every backend that takes a CLI model — the same capability list the
  // gen form's override picker is gated on.
  const usesCliModel = supportsCloudModelOverride(p.mode);
  const [prompt, setPrompt] = useState(p.prompt || '');
  const [negativePrompt, setNegativePrompt] = useState(p.negativePrompt || '');
  // A configured-default sentinel means "let the CLI's own config pick" — display
  // it as an empty field so the "leave empty for default" placeholder is honest.
  // The submit comparison below uses this same blanked value, not the raw
  // `p.model`: otherwise an untouched sentinel field reads as an edit and
  // submits `model: ''` on every retry.
  const originalModel = isConfiguredDefaultModel(p.model) ? '' : (p.model || '');
  const [model, setModel] = useState(originalModel);
  const [modelId, setModelId] = useState(p.modelId || '');
  const [width, setWidth] = useState(p.width ?? '');
  const [height, setHeight] = useState(p.height ?? '');
  const [steps, setSteps] = useState(p.steps ?? '');
  // The job's stored effort (a CODEX_EFFORT_LEVELS value) or the "default" option
  // when it carried none. On submit we only send `effort` when this differs from
  // the original — the sentinel resets to default, a level pins that level.
  const originalEffort = codexEffortOf(p.effort) || EFFORT_DEFAULT_OPTION;
  const [effort, setEffort] = useState(originalEffort);

  const submit = (e) => {
    e.preventDefault();
    const overrides = {};
    const trimEq = (a, b) => (a || '').trim() === (b || '').trim();
    const numEq = (a, b) => (a === '' ? null : Number(a)) === (b ?? null);
    if (!trimEq(prompt, p.prompt) && prompt.trim()) overrides.prompt = prompt.trim();
    if (!trimEq(negativePrompt, p.negativePrompt)) overrides.negativePrompt = negativePrompt.trim();
    if (usesCliModel && !trimEq(model, originalModel)) overrides.model = model.trim();
    if (!usesCliModel && !trimEq(modelId, p.modelId)) overrides.modelId = modelId.trim();
    if (!numEq(width, p.width) && width !== '') overrides.width = Number(width);
    if (!numEq(height, p.height) && height !== '') overrides.height = Number(height);
    if (!numEq(steps, p.steps) && steps !== '') overrides.steps = Number(steps);
    // Codex-only: send effort only when changed. The sentinel ('default') resets
    // to the shipped default; a concrete level pins the retry to that level.
    if (isCodex && effort !== originalEffort) overrides.effort = effort;
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
        {/* 'Codex model' / 'Agy model' come from the shared backend META rather
            than a per-backend ternary ladder — a new CLI backend gets the right
            label from its registry entry alone. */}
        <FormField className="col-span-2" label={usesCliModel ? `${modeLabel(p.mode)} model` : 'Model id'} labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="text"
            value={usesCliModel ? model : modelId}
            onChange={(e) => (usesCliModel ? setModel(e.target.value) : setModelId(e.target.value))}
            placeholder={usesCliModel ? 'leave empty for default' : 'e.g. z-image-turbo-bf16'}
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
      {isCodex && (
        <FormField label="Reasoning effort" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          {/* No fixed id — FormField wires the label to a useId()-generated id,
              so two retry editors open at once don't collide on one shared id. */}
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          >
            <option value={EFFORT_DEFAULT_OPTION}>Default ({CODEX_IMAGEGEN_DEFAULT_EFFORT})</option>
            {CODEX_EFFORT_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>{lvl}</option>
            ))}
          </select>
        </FormField>
      )}
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

// The retry editor deliberately reuses the same resolution and advanced
// controls rendered by VideoGen. Keeping the capability predicates in those
// components means a newly-supported video knob is not silently absent here.
function VideoRetryForm({ job, onSubmit, onCancel }) {
  const p = job.params || {};
  const [models, setModels] = useState([]);
  const [modelId, setModelId] = useState(p.modelId || '');
  const [prompt, setPrompt] = useState(p.prompt || '');
  const [negativePrompt, setNegativePrompt] = useState(p.negativePrompt || '');
  const [width, setWidth] = useState(p.width ?? '');
  const [height, setHeight] = useState(p.height ?? '');
  const [numFrames, setNumFrames] = useState(p.numFrames ?? '');
  const [fps, setFps] = useState(p.fps ?? '');
  const [chunks, setChunks] = useState(p.chunks ?? 1);
  const [chunkPrompts, setChunkPrompts] = useState(p.chunkPrompts || []);
  const [contextFrames, setContextFrames] = useState(p.contextFrames ?? 0);
  const [seed, setSeed] = useState(p.seed ?? '');
  const [steps, setSteps] = useState(p.steps ?? '');
  const [guidanceScale, setGuidanceScale] = useState(p.guidanceScale ?? '');
  const [imageStrength, setImageStrength] = useState(p.imageStrength ?? '');
  // The conditioning promise rides the retry the same way the strength does — a
  // retry that silently dropped it would re-render an anchored clip under the
  // original job's Inspire label. Absent means the default.
  const [i2vReferenceMode, setI2vReferenceMode] = useState(normalizeI2vReferenceMode(p.i2vReferenceMode));
  const [tiling, setTiling] = useState(p.tiling || 'auto');
  const [disableAudio, setDisableAudio] = useState(p.disableAudio === true);
  const [textEncoderId, setTextEncoderId] = useState(p.textEncoderId || STOCK_TEXT_ENCODER_ID);
  // The failed job's sampler schedule (#4875). Seeded from its params so the
  // picker reports what the render actually used rather than always reading
  // "Quality", and so an unchanged retry re-submits the same schedule.
  const [speedProfileId, setSpeedProfileId] = useState(speedProfileIdFromRecord(p.speedProfileId));
  // The decode the job was submitted with (#5423, #5449). Seeded from its params
  // for the same reason the schedule above is: an untouched requeue must
  // re-submit what the original render asked for, not snap silently back to Full.
  const [draftDecode, setDraftDecode] = useState(draftDecodeFromRecord(p.draftDecode));
  const [availableLoras, setAvailableLoras] = useState([]);
  const [selectedLoras, setSelectedLoras] = useState(Array.isArray(p.loras) ? p.loras : []);

  useEffect(() => {
    getVideoGenStatus({ silent: true })
      .then((status) => setModels(Array.isArray(status?.models) ? status.models : []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    listLorasFull({ silent: true })
      .then((loras) => setAvailableLoras(Array.isArray(loras) ? loras : []))
      .catch(() => {});
  }, []);

  const currentModel = models.find((model) => model.id === modelId) || null;
  // Switching the retry to a model that pins frame one has to clear the promise
  // with it (#4874) — the picker offers only Anchor there, so leaving `inspire`
  // in state would strand the form on a value the user cannot see or change and
  // the server would reject on submit. Mirrors the same snap-back in
  // useVideoGenForm — including the deferral: `models` loads async from
  // getVideoGenStatus, so an unresolved `currentModel` means "not known yet",
  // never "cannot honor it".
  useEffect(() => {
    if (isDefaultI2vReferenceMode(i2vReferenceMode)) return;
    if (!currentModel) return;
    if (runtimeSupportsI2vReferenceMode(currentModel.runtime, i2vReferenceMode)) return;
    setI2vReferenceMode(DEFAULT_I2V_REFERENCE_MODE);
  }, [currentModel, i2vReferenceMode]);
  const isGrok = p.mode === 'grok';
  const loraFamily = videoLoraFamily(currentModel);
  const videoLoras = loraFamily ? availableLoras.filter((lora) => loraFamilyOf(lora) === loraFamily) : [];
  const encoderOptions = textEncoderOptionsForModel(currentModel);
  const originalEncoder = normalizeTextEncoderForModel(p.textEncoderId || STOCK_TEXT_ENCODER_ID, currentModel);
  const originalSpeedProfileForModel = normalizeSpeedProfileForModel(speedProfileIdFromRecord(p.speedProfileId), currentModel);
  // Preview-fidelity decode (#5449). A model the finish graph names as a
  // DELIVERY target always decodes on its own decoder, so the picker is locked
  // to Full there rather than offering a draft the server would decline — the
  // same reset the Video Gen form makes when Finish switches models.
  const deliveryModel = isDeliveryVideoModel(currentModel, models);
  const recordedDraftDecode = draftDecodeFromRecord(p.draftDecode);
  // What an UNTOUCHED requeue would re-submit. Two deliberate readings:
  //   - until `models` resolves, an unknown model means "not known yet", never
  //     "no draft decoder", so the baseline stays the recorded value and a
  //     requeue submitted mid-load still sends no decode override at all;
  //   - on a delivery model it ALSO stays the recorded value, so the lock's
  //     reset to Full counts as a change and clears the stale request rather
  //     than silently re-inheriting a decode the render can never perform.
  const originalDraftDecode = (currentModel && !deliveryModel)
    ? resolveDraftDecodeForModel(recordedDraftDecode, currentModel, models)
    : recordedDraftDecode;
  // Models arrive asynchronously, so the recorded profile can only be validated
  // once the entry resolves. Until then state holds the raw recorded id; this
  // snaps it to what the model actually declares, so an untouched form can't
  // re-submit a schedule the registry no longer offers.
  useEffect(() => {
    if (!currentModel) return;
    setSpeedProfileId((current) => normalizeSpeedProfileForModel(current, currentModel));
  }, [currentModel]);
  // Same deferral for the decode: snap the recorded request onto what the
  // resolved model declares (and onto Full for a delivery model) once the entry
  // is known, so the <select> can never hold a value it has no <option> for.
  useEffect(() => {
    if (!currentModel) return;
    setDraftDecode((current) => resolveDraftDecodeForModel(current, currentModel, models));
  }, [currentModel, models]);
  // Multi-keyframe inputs are not exposed in the sanitized queue projection,
  // but FFLF is their persisted semantic mode. IC/a2v conditioning also pins
  // a single render, so keep the shared chaining controls consistent with the
  // normal VideoGen form for those retry records.
  const chainingLocked = p.mode === 'fflf' || p.mode === 'a2v' || p.mode?.startsWith('ic-');
  const handleModelChange = (event) => {
    const nextModelId = event.target.value;
    const nextModel = models.find((model) => model.id === nextModelId) || null;
    setModelId(nextModelId);
    setTextEncoderId(normalizeTextEncoderForModel(textEncoderId, nextModel));
    setSpeedProfileId(normalizeSpeedProfileForModel(speedProfileId, nextModel));
    if (videoLoraFamily(nextModel) !== loraFamily) setSelectedLoras([]);
  };
  const setChunkPromptAt = (index, value) => setChunkPrompts((prev) => {
    const next = [...prev];
    while (next.length <= index) next.push('');
    next[index] = value;
    return next;
  });
  const displayedNumFrames = numFrames === '' ? (currentModel?.defaultFrames ?? 121) : numFrames;
  const displayedFps = fps === '' ? 24 : fps;

  const submit = (e) => {
    e.preventDefault();
    const overrides = {};
    const textChanged = (value, original) => (value || '').trim() !== (original || '').trim();
    const numberChanged = (value, original) => (value === '' ? null : Number(value)) !== (original ?? null);
    if (!prompt.trim()) return;
    if (textChanged(prompt, p.prompt)) overrides.prompt = prompt.trim();
    if (textChanged(negativePrompt, p.negativePrompt)) overrides.negativePrompt = negativePrompt.trim();
    if (textChanged(modelId, p.modelId)) overrides.modelId = modelId.trim();
    if (numberChanged(width, p.width) && width !== '') overrides.width = Number(width);
    if (numberChanged(height, p.height) && height !== '') overrides.height = Number(height);
    if (numFrames !== '' && numberChanged(numFrames, p.numFrames)) overrides.numFrames = Number(numFrames);
    if (fps !== '' && numberChanged(fps, p.fps)) overrides.fps = Number(fps);
    if (numberChanged(chunks, p.chunks ?? 1)) overrides.chunks = Number(chunks);
    if (Number(chunks) <= 1 && Number(p.chunks ?? 1) > 1) overrides.chunkPrompts = [];
    else if (JSON.stringify(chunkPrompts) !== JSON.stringify(p.chunkPrompts || [])) overrides.chunkPrompts = chunkPrompts;
    if (numberChanged(contextFrames, p.contextFrames ?? 0)) overrides.contextFrames = Number(contextFrames);
    const setNumericOverride = (key, value, original, clearable = false) => {
      if (value === '') {
        if (clearable && original != null) overrides[key] = null;
        return;
      }
      if (numberChanged(value, original)) overrides[key] = Number(value);
    };
    setNumericOverride('seed', seed, p.seed, true);
    setNumericOverride('steps', steps, p.steps, true);
    setNumericOverride('guidanceScale', guidanceScale, p.guidanceScale, true);
    setNumericOverride('imageStrength', imageStrength, p.imageStrength, true);
    if (i2vReferenceMode !== normalizeI2vReferenceMode(p.i2vReferenceMode)) {
      // `null` clears the persisted value, mirroring the numeric knobs above — an
      // explicit 'anchor' would leave the retry carrying a knob that changed nothing.
      overrides.i2vReferenceMode = isDefaultI2vReferenceMode(i2vReferenceMode) ? null : i2vReferenceMode;
    }
    if (tiling !== (p.tiling || 'auto')) overrides.tiling = tiling;
    if (disableAudio !== (p.disableAudio === true)) overrides.disableAudio = disableAudio;
    // A model switch can normalize an inherited encoder to stock locally;
    // submit that reset explicitly so the retry does not retain the old,
    // incompatible encoder from the failed job.
    if (modelId !== p.modelId || textEncoderId !== originalEncoder) overrides.textEncoderId = textEncoderId;
    // Same model-switch clause its sibling above carries: switching to a model
    // that declares no profiles snaps BOTH the local value and
    // its baseline to the default, so they compare equal and no
    // override would be sent — leaving the old job's `speedProfileId` in the
    // inherited params for the queue to echo as a profile the render never used.
    if (modelId !== p.modelId || speedProfileId !== originalSpeedProfileForModel) {
      overrides.speedProfileId = speedProfileId === DEFAULT_SPEED_PROFILE_ID ? null : speedProfileId;
    }
    // Same model-switch clause as its two siblings above, and the same clear:
    // `null` resets the inherited request to Full, because an explicit 'full'
    // and an absent field are the same request — sending the sentinel would
    // leave the requeued job carrying a knob that changed nothing.
    // `textChanged` rather than the siblings' raw `!==`: a job stored without a
    // modelId leaves state at '' against an undefined param, which compares
    // unequal and would make an UNTOUCHED requeue send a decode override.
    if (textChanged(modelId, p.modelId) || draftDecode !== originalDraftDecode) {
      overrides.draftDecode = isFullDecodeId(draftDecode) ? null : draftDecode;
    }
    if (JSON.stringify(selectedLoras) !== JSON.stringify(p.loras || [])) overrides.loras = selectedLoras;
    onSubmit(Object.keys(overrides).length ? overrides : null);
  };

  return (
    <form onSubmit={submit} className="mt-3 pt-3 border-t border-port-border space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FormField label="Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={8000} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white" />
        </FormField>
        <FormField label="Negative Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <textarea value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} rows={3} maxLength={8000} className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white" />
        </FormField>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {!isGrok && (
          <FormField className="col-span-2 sm:col-span-3" label="Model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
            {models.length > 0 ? <ModelSelect models={models} value={modelId} onChange={handleModelChange} /> : (
              <input value={modelId} onChange={(e) => setModelId(e.target.value)} className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white" />
            )}
          </FormField>
        )}
        <ResolutionField presets={resolutionOptionsForModel(currentModel)} width={width} height={height} onChange={(w, h) => { setWidth(w); setHeight(h); }} {...videoEdgeBoundsForModel(currentModel)} snapOnBlur />
      </div>
      {!isGrok && encoderOptions.length > 1 && (
        <FormField label="Text encoder" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <ModelSelect models={encoderOptions} value={textEncoderId} onChange={(e) => setTextEncoderId(e.target.value)} getLabel={(option) => option.label} />
        </FormField>
      )}
      {!isGrok && loraFamily && videoLoras.length > 0 && (
        <LoraPicker
          availableLoras={videoLoras}
          selected={selectedLoras}
          onChange={setSelectedLoras}
          currentRunnerFamily={loraFamily}
          currentCompatKey={loraFamily}
          prompt={prompt}
        />
      )}
      {!isGrok && (
        <AdvancedParamsPanel
          mode={p.mode || 'text'} currentModel={currentModel}
          numFrames={displayedNumFrames} onNumFramesChange={setNumFrames}
          chunks={chunks} onChunksChange={setChunks} keyframesActive={chainingLocked}
          chunkPrompts={chunkPrompts} onChunkPromptChange={setChunkPromptAt} chainingActive={chunks > 1 && !chainingLocked}
          contextFrames={contextFrames} onContextFramesChange={setContextFrames}
          fps={displayedFps} onFpsChange={setFps} seed={seed} onSeedChange={setSeed} onRandomSeed={() => setSeed(Math.floor(Math.random() * 2147483647))}
          steps={steps} onStepsChange={setSteps} guidanceScale={guidanceScale} onGuidanceScaleChange={setGuidanceScale}
          speedProfileId={speedProfileId} onSpeedProfileChange={setSpeedProfileId}
          draftDecode={draftDecode} onDraftDecodeChange={setDraftDecode} draftDecodeLocked={deliveryModel}
          imageStrength={imageStrength} onImageStrengthChange={setImageStrength} tiling={tiling} onTilingChange={setTiling}
          i2vReferenceMode={i2vReferenceMode} onI2vReferenceModeChange={setI2vReferenceMode}
          effectiveImageStrength={resolveI2vReferenceStrength(i2vReferenceMode, imageStrength)}
          disableAudio={disableAudio} onDisableAudioChange={setDisableAudio}
          idPrefix={`retry-video-${job.id}`}
        />
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1 text-xs text-port-text-muted hover:text-white">Cancel</button>
        <button type="submit" className="inline-flex items-center gap-1 px-3 py-1 bg-port-accent text-white text-xs rounded hover:bg-port-accent/90"><RotateCw className="w-3 h-3" />Retry with changes</button>
      </div>
    </form>
  );
}
