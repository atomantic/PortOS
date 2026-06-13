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
import { Dumbbell, Loader2, Square, CheckCircle2, XCircle, Sparkles } from 'lucide-react';
import toast from '../ui/Toast';
import { useSseProgress } from '../../hooks/useSseProgress';
import CheckpointPicker from './CheckpointPicker';
import {
  getLoraTrainingStatus,
  listLoraTrainingRuns,
  startLoraTrainingRun,
  cancelLoraTrainingRun,
  listImageModels,
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

  useEffect(() => {
    getLoraTrainingStatus().then((s) => {
      setStatus(s);
      setParams((prev) => prev || { ...s.defaults });
    }).catch(() => setStatus({ runtimes: {}, defaults: {} }));
    listImageModels().then((list) => {
      // FLUX.2 Klein only — mflux ≥0.17 dropped FLUX.1 training, and the
      // torch fallback trains the same bf16 Klein bases.
      const trainable = (Array.isArray(list) ? list : []).filter((m) => m.runner === 'flux2');
      setModels(trainable);
      setBaseModelId((prev) => prev || trainable[0]?.id || '');
    }).catch(() => setModels([]));
  }, []);

  const refreshRuns = useCallback(() => {
    listLoraTrainingRuns({ datasetId: dataset.id, limit: 5 }).then((runs) => {
      const active = runs.find(isActive) || null;
      setActiveRun(active);
      setLastRun(runs.find((r) => !isActive(r)) || null);
    }).catch(() => {});
  }, [dataset.id]);
  useEffect(() => { refreshRuns(); }, [refreshRuns]);

  const sseUrl = activeRun ? `/api/lora-training/runs/${activeRun.id}/events` : null;
  const { latest, closed } = useSseProgress(sseUrl, { enabled: !!activeRun });

  useEffect(() => {
    if (!closed || !activeRun) return;
    // Terminal frame (or stream loss) — re-read the run record for truth.
    refreshRuns();
    onRunFinished?.();
  }, [closed, activeRun, refreshRuns, onRunFinished]);

  // Engine pick mirrors the server: mflux (MLX) when its trainer is
  // installed, else the torch venv. Either being ready unblocks training.
  const engineReady = !!(status?.runtimes?.mflux?.ready || status?.runtimes?.flux2?.ready);

  const start = async () => {
    setStarting(true);
    try {
      await startLoraTrainingRun({ datasetId: dataset.id, baseModelId, params });
      toast.success('Training queued');
      refreshRuns();
    } finally {
      setStarting(false);
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

  const setParam = (key, value) => setParams((prev) => ({ ...prev, [key]: value }));

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
        <div className="text-xs text-gray-400">{latest?.message || (activeRun.status === 'queued' ? `Queued (position ${latest?.position ?? '…'})` : 'Starting…')}</div>
        {latest?.currentImage && (
          <img src={latest.currentImage} alt="training sample" className="w-32 h-32 object-cover rounded border border-port-border" />
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
      {lastRun?.status === 'completed' && (
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
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs ${!disabledReason && readiness?.quality === 'minimum' ? 'text-port-warning' : 'text-gray-500'}`}>
          {disabledReason
            || (readiness?.quality === 'minimum'
              ? `Trains on ${readiness?.captioned ?? 0} — ${Math.max(0, (readiness?.recommended ?? 20) - (readiness?.captioned ?? 0))} more recommended`
              : `Trains on ${readiness?.captioned ?? 0} captioned images`)}
        </span>
        <button
          type="button"
          onClick={start}
          disabled={!!disabledReason || starting}
          className="px-3 py-2 text-sm rounded bg-port-accent text-white disabled:opacity-50 flex items-center gap-2"
        >
          {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Dumbbell className="w-4 h-4" />}
          Train
        </button>
      </div>
    </div>
  );
}
