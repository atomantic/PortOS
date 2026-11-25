import { useState, useEffect } from 'react';
import { Image as ImageIcon, Film, Cpu, X, Trash2, RotateCw, Zap, Pencil } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { isCloudCliMode, IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_EFFORT, modeLabel, isCloudVideoMode } from '../../lib/imageGenBackends';
import { ANTIGRAVITY_CONFIGURED_DEFAULT } from '../../utils/providers';
import socket from '../../services/socket';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import { formatTimeOfDaySeconds } from '../../utils/formatters';
import {
  getVideoHistoryItem,
  getTopazJobStatus,
  cancelTopazRemoteJob,
  recoverTopazJob,
} from '../../services/apiImageVideo.js';
import ContinuationDetails from '../videoGen/ContinuationDetails';
import TrainingJobDetail, { trainingSummary } from './TrainingJobDetail';
import EditRetryForm from './EditRetryForm';
import VideoRetryForm from './VideoRetryForm';
import { codexEffortOf } from './retryOverrides';

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
  if (renderer !== 'remote' && isCloudVideoMode(params.mode)) {
    // fal.ai / Reactor renders happen in the provider's cloud on a model id the
    // provider owns, so the row must name the provider rather than fall through
    // to the local-engine badge below (grok video is caught by the mode branch
    // above, which adds its aspect ratio).
    // Video jobs carry `modelId`; a fal.ai IMAGE job (same 'fal' literal)
    // carries its catalog id in `model`.
    const cloudModel = (params.modelId || params.model || '').trim();
    const provider = modeLabel(params.mode);
    return cloudModel ? `${provider} / ${cloudModel}` : provider;
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

function RunningJobProgress({ job, snapshotRequestedAt }) {
  const { id, startedAt } = job;
  const [frame, setFrame] = useState(null);
  useEffect(() => {
    const onProgress = (update) => {
      if (update.id === id && update.startedAt === startedAt) {
        setFrame({ ...update, receivedAt: performance.now() });
      }
    };
    socket.on('media-jobs:progress', onProgress);
    return () => socket.off('media-jobs:progress', onProgress);
  }, [id, startedAt]);

  // A frame received during a snapshot request may be newer than that response.
  const latest = frame?.id === id && frame.startedAt === startedAt && frame.receivedAt >= snapshotRequestedAt ? frame : job;
  const progressPct = Number.isFinite(latest.progress)
    ? Math.max(0, Math.min(100, Math.round(latest.progress * 100)))
    : 0;
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs text-port-text-muted">
        <span className="truncate" title={latest.statusMsg || undefined}>{latest.statusMsg || 'Running'}</span>
        <span className="font-mono shrink-0">{progressPct}%</span>
      </div>
      <div className="h-1.5 bg-port-border rounded overflow-hidden">
        <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
      </div>
    </div>
  );
}

// Topaz upscale rows carry remote-provider state (status checks, cancellation,
// recovery, and original-vs-result comparison) that no other job kind has, so
// it lives in its own component instead of widening JobRow's state.
function TopazJobSection({ job, canCancel }) {
  const [topazStatus, setTopazStatus] = useState(null);
  const [checkingTopaz, setCheckingTopaz] = useState(false);
  const [topazSource, setTopazSource] = useState(null);
  useEffect(() => {
    if (job.status !== 'completed' || !job.result?.upscaledFrom) return undefined;
    let current = true;
    getVideoHistoryItem(job.result.upscaledFrom, { silent: true })
      .then(item => { if (current) setTopazSource(item); })
      .catch(() => { if (current) setTopazSource(null); });
    return () => { current = false; };
  }, [job.status, job.result?.upscaledFrom]);
  const checkTopaz = (cancelRemote = false) => {
    setCheckingTopaz(true);
    (cancelRemote ? cancelTopazRemoteJob(job.id, { silent: true }) : getTopazJobStatus(job.id, { silent: true }))
      .then(result => setTopazStatus(`Topaz request ${result.requestId}: ${result.status}`))
      .catch(error => setTopazStatus(error.message || 'Could not check Topaz status'))
      .finally(() => setCheckingTopaz(false));
  };
  const recoverTopaz = () => {
    setCheckingTopaz(true);
    recoverTopazJob(job.id, { silent: true })
      .then(() => setTopazStatus('Result retrieval queued.'))
      .catch(error => setTopazStatus(error.message || 'Could not retrieve Topaz result'))
      .finally(() => setCheckingTopaz(false));
  };
  return (
    <>
      {!canCancel && (job.result?.topazUncertain || topazStatus || job.result?.topazProviderStatus || job.result?.topazRecoveryAvailable) && (
        <div className="mt-2 space-y-1 text-xs text-port-warning">
          {job.result?.topazUncertain && <>
            <p>Topaz processing or charges may continue. Check the existing request before starting another.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => checkTopaz()} disabled={checkingTopaz} className="rounded border border-port-border px-2 py-1 disabled:opacity-50">{checkingTopaz ? 'Checking…' : 'Check Topaz status'}</button>
              <button type="button" onClick={() => checkTopaz(true)} disabled={checkingTopaz} className="rounded border border-port-border px-2 py-1 disabled:opacity-50">Request Topaz cancellation</button>
            </div>
          </>}
          {job.result?.topazRecoveryAvailable && <button type="button" onClick={recoverTopaz} disabled={checkingTopaz} className="rounded border border-port-border px-2 py-1 disabled:opacity-50">Retrieve Topaz result</button>}
          {(topazStatus || job.result?.topazProviderStatus) && <p role="status">{topazStatus || `Topaz status: ${job.result.topazProviderStatus}`}</p>}
        </div>
      )}
      {job.status === 'completed' && job.result?.filename && (
        <div className="mt-2 space-y-1 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {topazSource?.filename && <div><p>Original master</p><video controls preload="metadata" src={`/data/videos/${encodeURIComponent(topazSource.filename)}`} className="max-w-full max-h-64" /></div>}
            <div><p>Topaz result</p><video controls preload="metadata" src={`/data/videos/${encodeURIComponent(job.result.filename)}`} className="max-w-full max-h-64" /></div>
          </div>
          <a href={`/data/videos/${encodeURIComponent(job.result.filename)}`} download className="text-port-accent">Download upscaled video</a>
        </div>
      )}
    </>
  );
}

export default function JobRow({ job, snapshotRequestedAt, onCancel, onRetry, onRunNow, onDelete }) {
  const Icon = KIND_ICON[job.kind] || Film;
  const isTopaz = job.kind === 'video-upscale' && job.params?.mode === 'topaz';
  const canCancel = job.status === 'queued' || job.status === 'running';
  const canRetry = !isTopaz && job.kind !== 'training' && (job.status === 'failed' || job.status === 'canceled') && typeof onRetry === 'function';
  // Delete only on terminal rows — live jobs go through Cancel.
  const canDelete = (job.status === 'failed' || job.status === 'canceled' || job.status === 'completed')
    && !job.result?.topazUncertain && typeof onDelete === 'function';
  // Run-now is codex-only — GPU jobs serialize on the single MLX runtime.
  const isQueuedCloud = job.status === 'queued' && job.kind === 'image' && isCloudCliMode(job.params?.mode);
  const canRunNow = isQueuedCloud && typeof onRunNow === 'function';
  // Inline edit form for retry-with-overrides.
  const [editing, setEditing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const submitRetry = async (overrides) => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry(job.id, overrides);
    } finally {
      setRetrying(false);
    }
  };
  // A federated job renders from the wire request inside its `remoteMedia`
  // marker, so a prompt/model edit here would never reach the peer — and the
  // server re-normalizes the retry anyway. Offer the plain Retry, not the
  // editor, rather than showing a form whose edits are silently discarded.
  // The editors exist for image and video jobs only; the other kinds (audio,
  // stitch, composition, ...) have no knob grid, so they keep the plain Retry.
  const canEdit = canRetry && job.renderer !== 'remote' && (job.kind === 'image' || job.kind === 'video');
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const badge = modelLabel(job.params, job.renderer);
  return (
    <div className="bg-port-bg border border-port-border rounded p-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-4 h-4 text-port-accent shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              <span className="font-mono">{job.id.slice(0, 8)}</span>
              <span className="text-port-text-muted"> · {job.kind}</span>
              {badge && (
                <span className="text-port-text-muted" title={job.params.model || job.params.modelId || ''}>
                  {' · '}{badge}
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
          <span className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE[job.status] || ''}`}>{job.hold ? 'held' : job.status}</span>
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
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs hover:bg-port-error/20 hover:text-port-error"
              aria-label="Cancel"
              title="Cancel"
            >
              <X className="w-3 h-3" />
            </button>
          )}
          {canEdit && (
            <button
              disabled={retrying}
              onClick={() => setEditing((s) => !s)}
              className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 flex items-center gap-1 px-2 py-1 bg-port-bg border rounded text-xs ${editing ? 'border-port-accent/60 text-port-accent' : 'border-port-border text-gray-500 hover:text-gray-300 hover:border-port-border'}`}
              title="Edit prompt / config, then retry"
              aria-label="Edit and retry"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {canRetry && (
            <button
              disabled={retrying}
              onClick={() => submitRetry(null)}
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
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-gray-500 hover:text-port-error hover:border-port-error/50"
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
        <div role="status" className="text-xs text-port-error mt-2 break-words" title={job.error}>{job.error}</div>
      )}
      {isTopaz && <TopazJobSection job={job} canCancel={canCancel} />}
      {job.status === 'queued' && job.statusMsg && (
        <div role="status" className="text-xs text-port-warning-text mt-2 truncate" title={job.statusMsg}>{job.statusMsg}</div>
      )}
      {job.status === 'running' && <RunningJobProgress job={job} snapshotRequestedAt={snapshotRequestedAt} />}
      {job.kind === 'training' && job.params?.runId && (
        <TrainingJobDetail runId={job.params.runId} />
      )}
      {job.kind === 'video' && job.params?.continuation && (
        <details className="mt-2 text-xs text-port-text-muted">
          <summary className="cursor-pointer">Continuation details</summary>
          <div className="mt-2"><ContinuationDetails continuation={job.params.continuation} /></div>
        </details>
      )}
      <div className="text-xs text-port-text-muted mt-1">
        {job.queuedAt && `queued ${formatTimeOfDaySeconds(job.queuedAt)}`}
        {job.startedAt && ` · started ${formatTimeOfDaySeconds(job.startedAt)}`}
        {job.completedAt && ` · finished ${formatTimeOfDaySeconds(job.completedAt)}`}
      </div>
      {editing && canEdit && (job.kind === 'video' ? (
          <VideoRetryForm
            job={job}
            retrying={retrying}
            onSubmit={submitRetry}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <EditRetryForm
            job={job}
            retrying={retrying}
            onSubmit={submitRetry}
            onCancel={() => setEditing(false)}
          />
        ))}
    </div>
  );
}
