/**
 * SuperColliderStage — the SuperCollider half of the Music Designer's Code
 * engine (#9414, epic #9407).
 *
 * Unlike Strudel/Tone.js, SuperCollider never runs in the browser: the server
 * renders the editor's source offline inside a contained Docker runtime
 * (docs/SUPERCOLLIDER.md). This stage owns that workflow:
 *
 *   readiness  → GET status on mount (read-only; never builds or renders)
 *   setup      → explicit "Set up" button streams the image build
 *   render     → "Render preview" queues a media-queue job; progress over SSE
 *   preview    → the validated WAV plays in a normal audio element; a preview
 *                never touches the track
 *   save       → "Save as take" stores that exact preview, with its provenance
 *                (source, hash, seed, runtime version), as the active take
 *
 * Nothing here calls an AI provider.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Save, Settings2, Sparkles, Square } from 'lucide-react';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import { useSseProgress } from '../../hooks/useSseProgress';
import { GHOST_BTN, PRIMARY_BTN } from './designerStyles';
import {
  cancelSuperColliderRender, getSuperColliderStatus, renderSuperCollider, saveSuperColliderTake,
  setupSuperCollider, superColliderRenderEventsUrl,
} from '../../services/api';

const LOG_TAIL = 6;

export default function SuperColliderStage({
  code, durationSec, trackId, description = '', title = '', disabled = false, onRendered,
}) {
  const mountedRef = useMounted();
  const [status, setStatus] = useState(null); // null = checking
  const [statusError, setStatusError] = useState('');
  const [setupLog, setSetupLog] = useState(null); // null = not running
  const [job, setJob] = useState(null); // { jobId, code } of the render in flight / last finished
  const [queuePosition, setQueuePosition] = useState(null);
  const [progress, setProgress] = useState({ message: '', progress: null });
  const [preview, setPreview] = useState(null); // validated preview for `job`
  const [renderError, setRenderError] = useState('');
  const [saving, setSaving] = useState(false);
  const handledRef = useRef(null);

  const refreshStatus = async () => {
    const next = await getSuperColliderStatus({ silent: true })
      .catch((err) => { if (mountedRef.current) setStatusError(err?.message || 'Could not read SuperCollider status'); return null; });
    if (!mountedRef.current || !next) return;
    setStatusError('');
    setStatus(next);
  };
  useEffect(() => { refreshStatus(); }, []);

  const rendering = !!job && !preview && !renderError;
  const { latest } = useSseProgress(job ? superColliderRenderEventsUrl(job.jobId) : null, { enabled: rendering });

  // Fold each frame into view state once. `latest` keeps its identity until the
  // next frame, so a ref of the last handled frame stops a re-render replaying it.
  useEffect(() => {
    if (!latest || !job || handledRef.current === latest) return;
    handledRef.current = latest;
    if (latest.type === 'queued') setQueuePosition(latest.position ?? null);
    else if (latest.type === 'started') setQueuePosition(null);
    else if (latest.type === 'progress') setProgress((p) => ({ ...p, progress: latest.progress ?? p.progress }));
    else if (latest.type === 'status') setProgress((p) => ({ ...p, message: latest.message || p.message }));
    else if (latest.type === 'complete') setPreview(latest.result);
    else if (latest.type === 'canceled') { setRenderError('Render canceled'); }
    else if (latest.type === 'error') { setRenderError(String(latest.error || 'The render failed')); refreshStatus(); }
  }, [latest, job]);

  const setup = async (rebuild = false) => {
    setSetupLog([]);
    let failed = '';
    await setupSuperCollider({ rebuild }, (frame) => {
      if (!mountedRef.current) return;
      if (frame.type === 'log') setSetupLog((log) => [...(log || []), frame.message].slice(-200));
      else if (frame.type === 'error') failed = frame.message || 'SuperCollider setup failed';
      else if (frame.type === 'complete') setStatus(frame.status);
    }).catch((err) => { failed = err?.message || 'SuperCollider setup failed'; });
    if (!mountedRef.current) return;
    if (failed) toast.error(failed);
    else toast.success('SuperCollider is ready');
    setSetupLog(null);
    refreshStatus();
  };

  const render = async () => {
    setRenderError('');
    setPreview(null);
    setProgress({ message: '', progress: null });
    handledRef.current = null;
    const queued = await renderSuperCollider({ code, durationSec }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not start the render'); if (err?.code === 'SUPERCOLLIDER_UNAVAILABLE') refreshStatus(); return null; });
    if (!mountedRef.current || !queued) return;
    setQueuePosition(queued.position ?? null);
    setJob({ jobId: queued.jobId, code });
  };

  const cancel = async () => {
    if (!job) return;
    await cancelSuperColliderRender(job.jobId, { silent: true })
      .catch((err) => toast.error(err?.message || 'Could not cancel the render'));
  };

  const save = async () => {
    if (!preview || !trackId) return;
    setSaving(true);
    const res = await saveSuperColliderTake(trackId, {
      jobId: job.jobId,
      ...(description.trim() ? { prompt: description.trim() } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not save the take'); return null; });
    if (!mountedRef.current) return;
    setSaving(false);
    if (!res?.track) return;
    toast.success(`Saved the SuperCollider take (${res.durationSec}s)`);
    onRendered?.(res.track);
  };

  // A preview stands for the source it rendered; once the editor changes, saving
  // it would attach that audio to different text.
  const stale = !!preview && !!job && job.code !== code;
  const hasCode = !!code.trim();
  const ready = !!status?.ready;

  if (statusError && !status) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-port-error">{statusError}</p>
        <button type="button" onClick={refreshStatus} className={GHOST_BTN}><span>Retry</span></button>
      </div>
    );
  }
  if (!status) return <p className="text-xs text-gray-500">Checking SuperCollider…</p>;

  if (!ready) {
    const settingUp = setupLog !== null;
    return (
      <div className="space-y-3 rounded border border-port-border bg-port-bg/60 p-3">
        <p className="text-sm text-gray-300">SuperCollider is not set up yet: {status.message}</p>
        {status.action && <p className="text-xs text-gray-500">{status.action}</p>}
        <p className="text-xs text-gray-500">
          SuperCollider code renders offline inside a locked-down Docker container. The first setup compiles the runtime
          (10–30 minutes) and needs Docker running. Nothing is built until you press the button.
        </p>
        {settingUp && (
          <pre aria-label="Setup log" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-port-bg p-2 text-[11px] text-gray-400">
            {setupLog.slice(-LOG_TAIL * 4).join('\n')}
          </pre>
        )}
        {status.state.startsWith('docker-') ? (
          <button type="button" onClick={refreshStatus} className={GHOST_BTN}><span>Check again</span></button>
        ) : (
          <button type="button" onClick={() => setup(status.state === 'smoke-failed' || status.state === 'image-stale')} disabled={settingUp || disabled} className={PRIMARY_BTN}>
            {settingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
            <span>{settingUp ? 'Setting up…' : 'Set up SuperCollider'}</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={render} disabled={disabled || rendering || saving || !hasCode} className={PRIMARY_BTN}>
          {rendering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          <span>{rendering ? 'Rendering…' : 'Render preview'}</span>
        </button>
        {rendering && (
          <button type="button" onClick={cancel} className={GHOST_BTN}>
            <Square className="h-4 w-4" />
            <span>Cancel</span>
          </button>
        )}
        {preview && (
          <button type="button" onClick={save} disabled={disabled || saving || !trackId || stale} className={PRIMARY_BTN}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            <span>{saving ? 'Saving…' : 'Save as take'}</span>
          </button>
        )}
      </div>
      {rendering && (
        <p role="status" className="text-xs text-gray-500">
          {queuePosition ? `Queued (position ${queuePosition})…` : progress.message || 'Rendering offline in the contained runtime…'}
          {typeof progress.progress === 'number' && ` ${Math.round(progress.progress * 100)}%`}
        </p>
      )}
      {renderError && (
        <p role="alert" className="whitespace-pre-wrap break-words rounded border border-port-error/50 bg-port-error/10 px-3 py-2 font-mono text-xs text-port-error">
          {renderError}
        </p>
      )}
      {stale && <p className="text-xs text-port-warning">The code changed after this preview. Render again to save it.</p>}
      {preview && (
        <div className="space-y-1">
          <audio controls src={preview.audioUrl} aria-label="SuperCollider preview" className="w-full" />
          <p className="text-xs text-gray-500">
            Preview only, not saved. Seed {preview.seed}, {preview.settings?.durationSec}s at {preview.settings?.sampleRate} Hz.
            {' '}Saving keeps this exact render with its source, seed and runtime version.
          </p>
        </div>
      )}
      <p className="text-xs text-gray-500">
        Rendering runs the source in a Docker container with no network access. The last expression must be a pattern (for example <code className="text-gray-300">Ppar</code>).
      </p>
    </div>
  );
}
