/**
 * Training launch + live-run panel for a dataset.
 *
 * Launch gates on dataset readiness AND no in-flight trigger-word save
 * (the run reads the persisted trigger word, not the form). Live progress
 * streams over the run's media-job SSE; sample previews ride the 'preview'
 * frames. Completed runs surface the registered LoRA with a deep link.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Dumbbell, Loader2, Square, CheckCircle2, XCircle, Sparkles, RotateCcw, Moon, AlertTriangle, Eraser } from 'lucide-react';
import toast from '../ui/Toast';
import { useSseProgress } from '../../hooks/useSseProgress';
import CheckpointPicker from './CheckpointPicker';
import LiveSampleGallery from './LiveSampleGallery';
import {
  getLoraTrainingStatus,
  listLoraTrainingRuns,
  startLoraTrainingRun,
  cancelLoraTrainingRun,
  resumeLoraTrainingRun,
  listImageModels,
  stripLoraDatasetSharedCaptionFragments,
} from '../../services/api';

const isActive = (run) => run && ['queued', 'running'].includes(run.status);

export default function TrainingPanel({ dataset, readiness, triggerSaving, onRunFinished }) {
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [baseModelId, setBaseModelId] = useState('');
  const [params, setParams] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [starting, setStarting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [resuming, setResuming] = useState(false);
  // Server-detected caption identity-leak (409 CAPTION_IDENTITY_LEAK): the
  // fragments that repeat + the captioned-image total they're measured against.
  // Non-empty fragments → render the inline confirm row instead of queueing.
  const [captionLeak, setCaptionLeak] = useState({ fragments: [], total: 0 });
  const [strippingLeak, setStrippingLeak] = useState(false);

  useEffect(() => {
    getLoraTrainingStatus().then((s) => {
      setStatus(s);
      setParams((prev) => prev || { ...s.defaults });
    }).catch(err => { console.warn('⚠️ Failed to load training status: ' + err.message); setStatus({ runtimes: {}, defaults: {} }); });
    listImageModels().then((list) => {
      // FLUX.2 Klein only — mflux ≥0.17 dropped FLUX.1 training, and the
      // torch fallback trains the same bf16 Klein bases.
      const trainable = (Array.isArray(list) ? list : []).filter((m) => m.runner === 'flux2');
      setModels(trainable);
      // Default to the 9B base — it captures identity better than 4B and trains
      // fine via 4-bit QLoRA (the server forces the panic-safe quant tier
      // regardless of which inference id is picked). Prefer the plain 9B id we
      // validated (flux2-klein-9b); avoid the explicit *-bf16 variant (the heavy
      // path that GPU-watchdog-panics this M5). Fall back to any 9B, then first.
      setBaseModelId((prev) => {
        if (prev) return prev;
        const nineB = trainable.filter((m) => /9b/i.test(m.id));
        const nonBf16 = nineB.find((m) => !/bf16/i.test(m.id));
        return (nonBf16 || nineB[0] || trainable[0])?.id || '';
      });
    }).catch(err => { console.warn('⚠️ Failed to load image models: ' + err.message); setModels([]); });
  }, []);

  // A reassigned dataset keeps its id but its old runs belong to the previous
  // subject. Re-fetch (and re-filter) whenever the subject identity moves,
  // not just the id, and show only runs matching the current (universeId,
  // entryId) so the panel + checkpoint picker can't surface/promote a stale
  // run from the prior subject.
  const charEntryId = dataset.character?.entryId;
  const charUniverseId = dataset.character?.universeId;
  const charEntryKind = dataset.character?.entryKind || 'characters';
  const refreshRuns = useCallback(() => {
    // Query by dataset id, then guard by the full subject identity. That covers
    // character/object/place reassignments without relying on the legacy
    // `character_id` mirror column.
    listLoraTrainingRuns({ datasetId: dataset.id, limit: 5 }).then((runs) => {
      const own = (Array.isArray(runs) ? runs : []).filter(
        (r) => !r.character || (
          r.character.entryId === charEntryId
          && r.character.universeId === charUniverseId
          && (r.character.entryKind || 'characters') === charEntryKind
        ),
      );
      setActiveRun(own.find(isActive) || null);
      setLastRun(own.find((r) => !isActive(r)) || null);
    }).catch(err => console.warn('⚠️ Failed to refresh training runs: ' + err.message));
  }, [dataset.id, charEntryId, charEntryKind, charUniverseId]);
  useEffect(() => { refreshRuns(); }, [refreshRuns]);

  const sseUrl = activeRun ? `/api/lora-training/runs/${activeRun.id}/events` : null;
  const { frames, latest, closed } = useSseProgress(sseUrl, { enabled: !!activeRun });

  useEffect(() => {
    if (!closed || !activeRun) return;
    // Terminal frame (or stream loss) — re-read the run record for truth.
    refreshRuns();
    onRunFinished?.();
  }, [closed, activeRun, refreshRuns, onRunFinished]);

  // Engine pick mirrors the server: mflux (MLX) when its trainer is
  // installed, else the torch venv. Either being ready unblocks training.
  const engineReady = !!(status?.runtimes?.mflux?.ready || status?.runtimes?.flux2?.ready);

  // `silent: true` — this owns its own error surfacing: the expected
  // CAPTION_IDENTITY_LEAK 409 becomes the inline confirm row (not a toast), and
  // every other failure toasts here exactly once.
  const start = async ({ acknowledgeCaptionLeak = false } = {}) => {
    setStarting(true);
    try {
      await startLoraTrainingRun(
        { datasetId: dataset.id, baseModelId, params, acknowledgeCaptionLeak },
        { silent: true },
      );
      setCaptionLeak({ fragments: [], total: 0 });
      toast.success('Training queued');
      refreshRuns();
    } catch (err) {
      if (err?.code === 'CAPTION_IDENTITY_LEAK') {
        setCaptionLeak({ fragments: err.context?.sharedFragments || [], total: err.context?.total || 0 });
      } else {
        toast.error(err?.message || 'Failed to queue training');
      }
    } finally {
      setStarting(false);
    }
  };

  // From the leak row: strip the shared identity fragments server-side, sync the
  // parent's caption view, then re-launch (the gate now passes).
  const stripAndQueue = async () => {
    setStrippingLeak(true);
    try {
      const { removedFragments } = await stripLoraDatasetSharedCaptionFragments(dataset.id);
      if (removedFragments?.length) {
        toast.success(`Stripped ${removedFragments.length} shared identity fragment${removedFragments.length === 1 ? '' : 's'}`);
      }
      onRunFinished?.(); // parent reloads the dataset so captions + the lint banner refresh
      setCaptionLeak({ fragments: [], total: 0 });
      await start();
    } catch (err) {
      toast.error(err?.message || 'Failed to strip captions');
    } finally {
      setStrippingLeak(false);
    }
  };

  const cancel = async () => {
    if (!activeRun) return;
    setCanceling(true);
    try {
      await cancelLoraTrainingRun(activeRun.id);
      toast.success('Cancel requested — the trainer saves a checkpoint first');
    } finally {
      setCanceling(false);
    }
  };

  const resume = async () => {
    if (!lastRun) return;
    setResuming(true);
    try {
      const { fromStep } = await resumeLoraTrainingRun(lastRun.id);
      toast.success(`Resuming from checkpoint @ step ${fromStep}`);
      refreshRuns();
    } finally {
      setResuming(false);
    }
  };

  const setParam = (key, value) => setParams((prev) => ({ ...prev, [key]: value }));

  // A killed run keeps its checkpoints — surface the picker (view + salvage a
  // partial LoRA) whenever a non-completed run recorded one, and a Resume button
  // for any failed/canceled run. Gate Resume on status, NOT the recorded
  // checkpoint count: a crash can kill the run before the debounced record
  // persists its last checkpoint, yet the server resumes from disk — let its
  // 409 (NO_RESUMABLE_CHECKPOINT) handle the genuinely-empty case. Both runtimes
  // support true optimizer-state resume (mflux via --resume, FLUX.2 torch via
  // --resume-from), so this no longer filters by runtime.
  const lastRunCheckpoints = lastRun?.artifacts?.checkpoints?.length || 0;
  const canResume = lastRun && ['failed', 'canceled'].includes(lastRun.status);

  const disabledReason = !readiness?.trainable
    ? `Needs ${readiness?.required ?? 10} captioned images (have ${readiness?.captioned ?? 0})`
    : triggerSaving ? 'Saving trigger word…'
    : !baseModelId ? 'Pick a base model'
    : (status && !engineReady) ? 'No training engine — install mflux ≥0.17 or run scripts/setup-image-video.sh'
    : null;

  if (activeRun) {
    const progress = typeof latest?.progress === 'number' ? latest.progress : (activeRun.progress?.step || 0) / (activeRun.progress?.totalSteps || 1);
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-white font-medium">
            <Loader2 className="w-4 h-4 animate-spin text-port-warning" />
            Training {activeRun.runtime} · {activeRun.baseModelId}
          </div>
          <button
            type="button"
            onClick={cancel}
            disabled={canceling}
            className="px-2 py-1 text-xs rounded bg-port-error/20 text-port-error hover:bg-port-error/30 flex items-center gap-1 disabled:opacity-50"
          >
            <Square className="w-3 h-3" /> {canceling ? 'Canceling…' : 'Cancel'}
          </button>
        </div>
        <div className="h-2 bg-port-bg rounded overflow-hidden">
          <div className="h-full bg-port-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        {activeRun.status === 'queued' ? (
          <div className="text-xs text-gray-400">Queued (position {latest?.position ?? '…'})</div>
        ) : (
          <LiveSampleGallery run={activeRun} frames={frames} progress={progress} message={latest?.message} />
        )}
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 text-white font-medium">
        <Dumbbell className="w-4 h-4 text-port-accent" /> Train LoRA
      </div>
      {lastRun && (
        <div className="text-xs flex items-center gap-1.5">
          {lastRun.status === 'completed' ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-port-success" />
              <span className="text-gray-300">
                Last run completed
                {lastRun.output?.loraFilename && (
                  <> — <Link to="/media/loras" className="text-port-accent hover:underline inline-flex items-center gap-1"><Sparkles className="w-3 h-3" />{lastRun.output.loraFilename}</Link></>
                )}
              </span>
            </>
          ) : (
            <>
              <XCircle className="w-3.5 h-3.5 text-port-error" />
              <span className="text-gray-400" title={lastRun.error || ''}>Last run {lastRun.status}{lastRun.error ? ` — ${lastRun.error.slice(0, 120)}` : ''}</span>
            </>
          )}
        </div>
      )}
      {lastRun?.status === 'failed' && lastRun.errorCode === 'HF_AUTH' && (
        <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning space-y-2">
          <div className="font-semibold text-sm">Model access required</div>
          <div className="text-port-warning/90">
            The training base model is gated on HuggingFace. Accept its license with the account
            that owns your stored token, then retry — no token change needed.
          </div>
          {lastRun.errorRepo && (
            <a
              href={`https://huggingface.co/${lastRun.errorRepo}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80"
            >
              Request access to {lastRun.errorRepo} ↗
            </a>
          )}
        </div>
      )}
      {canResume && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-port-accent/30 bg-port-accent/5 px-3 py-2">
          <span className="text-xs text-gray-300">
            {lastRunCheckpoints > 0
              ? `${lastRunCheckpoints} checkpoint${lastRunCheckpoints === 1 ? '' : 's'} saved — pick up where it stopped.`
              : 'Pick up from the last saved checkpoint.'}
          </span>
          <button
            type="button"
            onClick={resume}
            disabled={resuming}
            className="px-2.5 py-1.5 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
          >
            {resuming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Resume training
          </button>
        </div>
      )}
      {(lastRun?.status === 'completed' || lastRunCheckpoints > 0) && (
        <CheckpointPicker run={lastRun} onPromoted={refreshRuns} />
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label htmlFor="lt-base-model" className="block text-xs text-gray-400 mb-1">Base model</label>
          <select
            id="lt-base-model"
            value={baseModelId}
            onChange={(e) => setBaseModelId(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
          >
            {!models.length && <option value="">No trainable models registered</option>}
            {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
          </select>
        </div>
        {params && [
          ['steps', 'Steps', 10, 10000],
          ['rank', 'Rank', 1, 128],
          ['checkpointEvery', 'Checkpoint every', 0, 5000],
          ['sampleEvery', 'Sample every', 0, 5000],
        ].map(([key, label, min, max]) => (
          <div key={key}>
            <label htmlFor={`lt-param-${key}`} className="block text-xs text-gray-400 mb-1">{label}</label>
            <input
              id={`lt-param-${key}`}
              type="number"
              min={min}
              max={max}
              value={params[key] ?? ''}
              onChange={(e) => setParam(key, Number(e.target.value))}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            />
          </div>
        ))}
        {params && (
          <div>
            <label htmlFor="lt-param-resolution" className="block text-xs text-gray-400 mb-1">Resolution</label>
            <select
              id="lt-param-resolution"
              value={params.resolution ?? 512}
              onChange={(e) => setParam('resolution', Number(e.target.value))}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            >
              {[512, 768, 1024].map((r) => <option key={r} value={r}>{r}px</option>)}
            </select>
          </div>
        )}
        {params && (
          <div>
            <label htmlFor="lt-param-lr" className="block text-xs text-gray-400 mb-1">Learning rate</label>
            <input
              id="lt-param-lr"
              type="number"
              step="0.00001"
              min="0.000001"
              max="0.1"
              value={params.learningRate ?? ''}
              onChange={(e) => setParam('learningRate', Number(e.target.value))}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            />
          </div>
        )}
        {/* Frozen-base overrides (issue #1407 / #1321) — only feed the mflux
            config builder, so gate on the mflux engine being the one that'll
            run (the torch/FLUX2 path always trains the bf16 base and ignores
            these). "Auto" sends an explicit `null` (NOT absent): the server
            re-merges saved settings.loraTraining.defaults into the run, so an
            omitted key would silently keep a configured default — `null` is a
            deliberate clear that forces the memory-derived tier (still clamped
            by LORA_TRAIN_MAX_QUANT_BITS). buildMfluxTrainConfig treats a
            null/non-boolean as "no override". */}
        {params && status?.runtimes?.mflux?.ready && (
          <div>
            <label htmlFor="lt-param-baseQuant" className="block text-xs text-gray-400 mb-1">Base quant</label>
            <select
              id="lt-param-baseQuant"
              value={params.baseQuant ?? ''}
              onChange={(e) => setParam('baseQuant', e.target.value === '' ? null : Number(e.target.value))}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            >
              <option value="">Auto</option>
              <option value={16}>bf16 (heaviest)</option>
              <option value={8}>8-bit</option>
              <option value={4}>4-bit (lightest)</option>
            </select>
          </div>
        )}
        {params && status?.runtimes?.mflux?.ready && (
          <div>
            <label htmlFor="lt-param-lowRam" className="block text-xs text-gray-400 mb-1">Low RAM spill</label>
            <select
              id="lt-param-lowRam"
              value={params.lowRam === true ? 'on' : params.lowRam === false ? 'off' : ''}
              onChange={(e) => setParam('lowRam', e.target.value === '' ? null : e.target.value === 'on')}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            >
              <option value="">Auto</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </div>
        )}
      </div>
      {status?.runtimes?.mflux?.ready && (
        <div className="flex items-start gap-2 rounded-lg border border-port-border bg-port-bg/50 px-3 py-2 text-xs text-gray-400">
          <Moon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-port-accent" />
          <div className="space-y-1">
            <div className="text-gray-300">
              By default, this Mac's display is slept while training and woken when the run finishes.
            </div>
            <div>
              On Apple Silicon, an <span className="text-gray-300">active display can crash the whole machine</span>{' '}
              (GPU watchdog kernel panic) during heavy LoRA training — so PortOS puts the display to sleep for you
              and the system keeps running underneath. Big runs (9B, bf16) can take hours: start one and{' '}
              <span className="text-gray-300">let it run overnight</span>. Don't close the lid (that sleeps the
              whole Mac and pauses the run); just leave it be, or drive it over SSH. If you've set{' '}
              <code className="text-gray-300">loraTraining.displaySleep: false</code> (e.g. headless), PortOS leaves
              the display alone — keep it off the GPU yourself.
            </div>
          </div>
        </div>
      )}
      {captionLeak.fragments.length > 0 && (
        <div className="bg-port-warning/10 border border-port-warning/40 rounded-lg p-3 text-sm space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-port-warning shrink-0 mt-0.5" />
            <p className="text-gray-200 min-w-0">
              <span className="font-medium text-port-warning">Identity is leaking into the captions.</span>{' '}
              These fragments repeat across most images, so the{' '}
              <span className="font-mono text-gray-300">{dataset.triggerWord || 'trigger'}</span>{' '}
              token would learn a generic subject. Strip them so the trigger absorbs the fixed identity, or train anyway.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {captionLeak.fragments.map((f) => (
              <span
                key={f.normalized}
                className="text-xs px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-300 font-mono"
                title={`in ${f.count} of ${captionLeak.total} captions`}
              >
                {f.fragment}<span className="text-gray-500"> ·{f.count}</span>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={stripAndQueue}
              disabled={strippingLeak || starting}
              className="px-3 py-1.5 text-xs rounded bg-port-warning/20 text-port-warning hover:bg-port-warning/30 flex items-center gap-2 disabled:opacity-50"
            >
              {strippingLeak ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eraser className="w-3.5 h-3.5" />}
              Strip identity &amp; queue
            </button>
            <button
              type="button"
              onClick={() => start({ acknowledgeCaptionLeak: true })}
              disabled={strippingLeak || starting}
              className="px-3 py-1.5 text-xs rounded border border-port-border text-gray-300 hover:bg-port-bg flex items-center gap-2 disabled:opacity-50"
            >
              Train anyway
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs ${!disabledReason && readiness?.quality === 'minimum' ? 'text-port-warning' : 'text-gray-500'}`}>
          {disabledReason
            || (readiness?.quality === 'minimum'
              ? `Trains on ${readiness?.captioned ?? 0} — ${Math.max(0, (readiness?.recommended ?? 20) - (readiness?.captioned ?? 0))} more recommended`
              : `Trains on ${readiness?.captioned ?? 0} captioned images`)}
        </span>
        <button
          type="button"
          onClick={() => start()}
          disabled={!!disabledReason || starting || strippingLeak}
          className="px-3 py-2 text-sm rounded bg-port-accent text-white disabled:opacity-50 flex items-center gap-2"
        >
          {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Dumbbell className="w-4 h-4" />}
          Train
        </button>
      </div>
    </div>
  );
}
