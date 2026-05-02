import { useEffect, useState, useCallback, useRef } from 'react';
import { Sparkles, FileSignature, Clapperboard, Loader2, RotateCcw, AlertTriangle, Image as ImageIcon, Check, Settings as SettingsIcon } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listWritersRoomAnalyses,
  runWritersRoomAnalysis,
  getWritersRoomAnalysis,
} from '../../services/apiWritersRoom';
import { generateImage, getSettings, updateSettings } from '../../services/apiSystem';
import { listImageModels } from '../../services/apiImageVideo';
import { timeAgo } from '../../utils/formatters';
import socket from '../../services/socket';

// Defaults for the per-scene image gen pipe. The user picked Klein-4B because
// it's the fastest of the FLUX.2 variants on Apple Silicon, and 768×512 is a
// 3:2 aspect that suits scene/storyboard work better than a square.
const WR_IMAGE_DEFAULTS = {
  modelId: 'flux2-klein-4b',
  mode: 'local',
  width: 768,
  height: 512,
};

function readWrImageSettings(settings) {
  const stored = settings?.writersRoom?.imageGen || {};
  return {
    modelId: stored.modelId || WR_IMAGE_DEFAULTS.modelId,
    mode: stored.mode || WR_IMAGE_DEFAULTS.mode,
    width: Number.isFinite(stored.width) ? stored.width : WR_IMAGE_DEFAULTS.width,
    height: Number.isFinite(stored.height) ? stored.height : WR_IMAGE_DEFAULTS.height,
  };
}

const KIND_META = {
  evaluate: { label: 'Evaluate', icon: Sparkles, hint: 'Editorial critique: logline, themes, issues, suggestions' },
  format:   { label: 'Format',   icon: FileSignature, hint: 'Tidy prose: paragraphing, dialogue, whitespace, typos' },
  script:   { label: 'Adapt',    icon: Clapperboard, hint: 'Adapt prose into scene-by-scene script with visual prompts' },
};

const SEVERITY_COLOR = {
  major: 'text-port-error border-port-error/40',
  moderate: 'text-port-warning border-port-warning/40',
  minor: 'text-gray-400 border-port-border',
};

export default function AiPanel({ work, onApplyFormat }) {
  const [analyses, setAnalyses] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [running, setRunning] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [details, setDetails] = useState({});

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const activeDraft = (work.drafts || []).find((d) => d.id === work.activeDraftVersionId);
  const activeHash = activeDraft?.contentHash || null;

  const refresh = useCallback(async () => {
    setLoadingList(true);
    const list = await listWritersRoomAnalyses(work.id).catch((err) => {
      if (mountedRef.current) toast.error(`Failed to list analyses: ${err.message}`);
      return [];
    });
    if (!mountedRef.current) return;
    setLoadingList(false);
    setAnalyses(list);
  }, [work.id]);

  useEffect(() => {
    // Clear synchronously so a work-switch doesn't briefly render the previous
    // work's analyses while the new fetch is in flight.
    setAnalyses([]);
    setExpanded(null);
    setDetails({});
    refresh();
  }, [work.id, refresh]);

  const runKind = async (kind) => {
    if (running) return;
    setRunning(kind);
    const snapshot = await runWritersRoomAnalysis(work.id, { kind }).catch((err) => {
      if (mountedRef.current) toast.error(`${KIND_META[kind].label} failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    setRunning(null);
    if (!snapshot) return;
    if (snapshot.status === 'failed') {
      toast.error(`${KIND_META[kind].label} failed: ${snapshot.error || 'unknown error'}`);
    } else {
      toast.success(`${KIND_META[kind].label} complete`);
    }
    // Splice into the local list instead of refetching — the snapshot already
    // carries every field listAnalyses returns.
    setDetails((d) => ({ ...d, [snapshot.id]: snapshot }));
    setExpanded(snapshot.id);
    setAnalyses((prev) => [snapshot, ...prev.filter((a) => a.id !== snapshot.id)]);
  };

  const expand = async (analysis) => {
    if (expanded === analysis.id) {
      setExpanded(null);
      return;
    }
    setExpanded(analysis.id);
    if (details[analysis.id]) return;
    const full = await getWritersRoomAnalysis(work.id, analysis.id).catch((err) => {
      if (mountedRef.current) toast.error(`Failed to load analysis: ${err.message}`);
      return null;
    });
    if (full && mountedRef.current) setDetails((d) => ({ ...d, [analysis.id]: full }));
  };

  return (
    <div className="space-y-3 text-xs">
      <div>
        <h3 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">AI Actions</h3>
        <div className="grid grid-cols-3 gap-1">
          {Object.entries(KIND_META).map(([kind, meta]) => {
            const Icon = meta.icon;
            const isRunning = running === kind;
            return (
              <button
                key={kind}
                onClick={() => runKind(kind)}
                disabled={!!running}
                title={meta.hint}
                className={`flex flex-col items-center gap-1 px-2 py-2 rounded border text-[11px] transition-colors ${
                  isRunning
                    ? 'border-port-accent bg-port-accent/20 text-port-accent'
                    : running
                      ? 'border-port-border bg-port-bg text-gray-600 cursor-not-allowed'
                      : 'border-port-border bg-port-bg text-gray-300 hover:border-port-accent hover:text-white'
                }`}
              >
                {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h3 className="text-[10px] uppercase tracking-wider text-gray-500">History</h3>
          <button
            onClick={refresh}
            disabled={loadingList}
            className="text-gray-500 hover:text-white disabled:opacity-50"
            title="Refresh analyses"
            aria-label="Refresh analyses"
          >
            <RotateCcw size={11} className={loadingList ? 'animate-spin' : ''} />
          </button>
        </div>
        {analyses.length === 0 && !loadingList && (
          <div className="text-gray-600 italic px-1">No analyses yet — try one above.</div>
        )}
        <ul className="space-y-1">
          {analyses.map((a) => {
            const meta = KIND_META[a.kind] || { label: a.kind, icon: Sparkles };
            const Icon = meta.icon;
            const stale = a.sourceContentHash && activeHash && a.sourceContentHash !== activeHash;
            const isOpen = expanded === a.id;
            const full = details[a.id];
            return (
              <li key={a.id} className="border border-port-border rounded">
                <button
                  onClick={() => expand(a)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-port-bg"
                >
                  <Icon size={12} className="text-gray-400 shrink-0" />
                  <span className="flex-1 truncate">
                    {meta.label}
                    {a.status === 'failed' && <span className="text-port-error"> · failed</span>}
                    {a.status === 'running' && <span className="text-port-accent"> · running…</span>}
                  </span>
                  {stale && (
                    <span title="Source draft has changed since this analysis ran" className="text-port-warning">
                      <AlertTriangle size={10} />
                    </span>
                  )}
                  <span className="text-[10px] text-gray-500 shrink-0">{timeAgo(a.completedAt || a.createdAt, '')}</span>
                </button>
                {isOpen && (
                  <div className="border-t border-port-border bg-port-bg/40 p-2 space-y-2">
                    {!full && <div className="text-gray-500">Loading…</div>}
                    {full?.status === 'failed' && (
                      <div className="text-port-error text-[11px] whitespace-pre-wrap">{full.error || 'Unknown error'}</div>
                    )}
                    {full?.status === 'succeeded' && full.kind === 'evaluate' && (
                      <EvaluateResult result={full.result} />
                    )}
                    {full?.status === 'succeeded' && full.kind === 'format' && (
                      <FormatResult result={full.result} onApply={(text) => onApplyFormat?.(text)} />
                    )}
                    {full?.status === 'succeeded' && full.kind === 'script' && (
                      <ScriptResult result={full.result} workTitle={work.title} />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function EvaluateResult({ result }) {
  if (!result) return null;
  return (
    <div className="space-y-2 text-[11px] text-gray-300">
      {result.logline && <div><span className="text-gray-500 uppercase text-[9px]">Logline</span><div className="italic">{result.logline}</div></div>}
      {result.summary && <div><span className="text-gray-500 uppercase text-[9px]">Summary</span><div>{result.summary}</div></div>}
      {result.themes?.length > 0 && (
        <div>
          <span className="text-gray-500 uppercase text-[9px]">Themes</span>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {result.themes.map((t, i) => <span key={i} className="px-1.5 py-0.5 bg-port-card border border-port-border rounded text-[10px]">{t}</span>)}
          </div>
        </div>
      )}
      {result.strengths?.length > 0 && (
        <div>
          <span className="text-gray-500 uppercase text-[9px]">Strengths</span>
          <ul className="list-disc list-inside space-y-0.5 mt-0.5 text-gray-400">
            {result.strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
      {result.issues?.length > 0 && (
        <div>
          <span className="text-gray-500 uppercase text-[9px]">Issues</span>
          <ul className="space-y-1 mt-0.5">
            {result.issues.map((iss, i) => (
              <li key={i} className={`pl-2 border-l-2 ${SEVERITY_COLOR[iss.severity] || SEVERITY_COLOR.minor}`}>
                <div className="text-[10px] uppercase tracking-wide opacity-80">{iss.severity || 'minor'} · {iss.category || 'note'}</div>
                <div>{iss.note}</div>
                {iss.excerpt && <div className="text-gray-500 italic mt-0.5">"{iss.excerpt}"</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.suggestions?.length > 0 && (
        <div>
          <span className="text-gray-500 uppercase text-[9px]">Suggestions</span>
          <ul className="space-y-1 mt-0.5">
            {result.suggestions.map((s, i) => (
              <li key={i} className="pl-2 border-l-2 border-port-accent/40">
                <div className="text-[10px] uppercase tracking-wide opacity-80 text-port-accent">{s.target}</div>
                <div>{s.recommendation}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FormatResult({ result, onApply }) {
  const text = result?.formattedBody || '';
  if (!text) return <div className="text-gray-500">Format pass returned no text.</div>;
  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="text-gray-500 uppercase text-[9px]">Cleaned prose ({text.length.toLocaleString()} chars)</span>
        <button
          onClick={() => onApply?.(text)}
          className="flex items-center gap-1 px-2 py-1 bg-port-accent text-white rounded text-[10px] hover:bg-port-accent/80"
          title="Replace the current draft buffer with this cleaned text (you can still cancel by not saving)"
        >
          <Check size={10} /> Apply to draft
        </button>
      </div>
      <pre className="whitespace-pre-wrap font-serif text-gray-300 bg-port-bg border border-port-border rounded p-2 max-h-64 overflow-y-auto">{text}</pre>
    </div>
  );
}

function ScriptResult({ result, workTitle }) {
  // Image-gen settings are scoped to the Writers Room (not the global Image Gen
  // page) so a writer can pick a fast/small model + 3:2 aspect without
  // disrupting the dedicated Image Gen workflow.
  const [imageCfg, setImageCfg] = useState(WR_IMAGE_DEFAULTS);
  const [models, setModels] = useState([]);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSettings().catch(() => ({})),
      listImageModels().catch(() => []),
    ]).then(([settings, modelList]) => {
      if (cancelled) return;
      setImageCfg(readWrImageSettings(settings));
      setModels(Array.isArray(modelList) ? modelList : []);
    });
    return () => { cancelled = true; };
  }, []);

  const persistCfg = useCallback(async (next) => {
    setImageCfg(next); // optimistic
    const current = await getSettings().catch(() => ({}));
    await updateSettings({
      ...current,
      writersRoom: { ...(current.writersRoom || {}), imageGen: next },
    }).catch((err) => toast.error(`Settings save failed: ${err.message}`));
  }, []);

  if (!result || !result.scenes?.length) return <div className="text-gray-500">No scenes returned.</div>;
  return (
    <div className="space-y-2 text-[11px] text-gray-300">
      <div className="flex items-center justify-between gap-2 px-1">
        {result.logline ? <div className="italic text-gray-400 truncate">"{result.logline}"</div> : <div />}
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-white shrink-0"
          title="Image-gen settings for this Writers Room"
        >
          <SettingsIcon size={10} /> {imageCfg.modelId} · {imageCfg.width}×{imageCfg.height}
        </button>
      </div>
      {showSettings && (
        <ImageGenSettingsRow cfg={imageCfg} models={models} onChange={persistCfg} />
      )}
      {result.scenes.map((scene, i) => (
        <SceneCard key={scene.id || i} scene={scene} workTitle={workTitle} imageCfg={imageCfg} />
      ))}
    </div>
  );
}

function ImageGenSettingsRow({ cfg, models, onChange }) {
  // Resolution presets that match common scene/storyboard aspects. Free-form
  // numeric inputs would invite invalid sizes (the FLUX.2 runner needs 64-px
  // multiples) so we expose a curated dropdown instead. "Custom" reveals the
  // raw inputs for power users who edit settings.json directly anyway.
  const RES_PRESETS = [
    { label: '768×512 (3:2)',  width: 768, height: 512 },
    { label: '512×512 (1:1)',  width: 512, height: 512 },
    { label: '512×768 (2:3)',  width: 512, height: 768 },
    { label: '1024×576 (16:9)', width: 1024, height: 576 },
    { label: '1024×1024 (1:1)', width: 1024, height: 1024 },
  ];
  const presetMatch = RES_PRESETS.find((p) => p.width === cfg.width && p.height === cfg.height);
  return (
    <div className="border border-port-border rounded p-2 bg-port-bg/40 space-y-1.5">
      <label className="block">
        <span className="text-[9px] uppercase tracking-wider text-gray-500">Model</span>
        <select
          value={cfg.modelId}
          onChange={(e) => onChange({ ...cfg, modelId: e.target.value })}
          className="w-full mt-0.5 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200"
        >
          {models.length === 0 && <option value={cfg.modelId}>{cfg.modelId}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.name || m.id}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[9px] uppercase tracking-wider text-gray-500">Resolution</span>
        <select
          value={presetMatch ? `${cfg.width}x${cfg.height}` : 'custom'}
          onChange={(e) => {
            if (e.target.value === 'custom') return;
            const [w, h] = e.target.value.split('x').map(Number);
            onChange({ ...cfg, width: w, height: h });
          }}
          className="w-full mt-0.5 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200"
        >
          {RES_PRESETS.map((p) => (
            <option key={p.label} value={`${p.width}x${p.height}`}>{p.label}</option>
          ))}
          {!presetMatch && <option value="custom">Custom ({cfg.width}×{cfg.height})</option>}
        </select>
      </label>
    </div>
  );
}

function SceneCard({ scene, workTitle, imageCfg = WR_IMAGE_DEFAULTS }) {
  // genStatus drives the button + preview overlay:
  //   idle    → no preview area shown
  //   running → preview area shows spinner / live diffusion frame from socket
  //   done    → preview area shows the final rendered image
  //   error   → preview area shows the error
  const [genStatus, setGenStatus] = useState('idle');
  const [generated, setGenerated] = useState(null);
  const [error, setError] = useState(null);
  // Live diffusion progress for THIS scene's job, filtered by the jobId we
  // got back from generateImage. Each SceneCard tracks its own job, so two
  // cards rendering at once don't fight over a shared progress hook.
  const [progress, setProgress] = useState(null);
  const jobIdRef = useRef(null);

  useEffect(() => {
    const onStarted = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      setProgress((prev) => ({
        ...(prev || {}),
        progress: 0,
        step: 0,
        totalSteps: data.totalSteps ?? prev?.totalSteps ?? null,
        currentImage: null,
      }));
    };
    const onProgress = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      setProgress((prev) => ({
        ...(prev || {}),
        progress: data.progress ?? prev?.progress ?? 0,
        step: data.step ?? prev?.step ?? 0,
        totalSteps: data.totalSteps ?? prev?.totalSteps ?? null,
        eta: data.eta ?? prev?.eta ?? null,
        currentImage: data.currentImage ?? prev?.currentImage ?? null,
      }));
    };
    const onCompleted = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      setGenerated((prev) => prev ? { ...prev, path: data.path || prev.path } : prev);
      setGenStatus('done');
      setProgress(null);
      jobIdRef.current = null;
    };
    const onFailed = (data) => {
      if (!jobIdRef.current || data.generationId !== jobIdRef.current) return;
      setError(data.error || data.message || 'Generation failed');
      setGenStatus('error');
      setProgress(null);
      jobIdRef.current = null;
    };
    socket.on('image-gen:started', onStarted);
    socket.on('image-gen:progress', onProgress);
    socket.on('image-gen:completed', onCompleted);
    socket.on('image-gen:failed', onFailed);
    return () => {
      socket.off('image-gen:started', onStarted);
      socket.off('image-gen:progress', onProgress);
      socket.off('image-gen:completed', onCompleted);
      socket.off('image-gen:failed', onFailed);
    };
  }, []);

  const generate = async () => {
    if (genStatus === 'running') return;
    if (!scene.visualPrompt?.trim()) {
      toast('No visual prompt for this scene', { icon: '⚠️' });
      return;
    }
    setGenStatus('running');
    setError(null);
    setProgress(null);
    setGenerated(null);
    // Truncate at 1900 chars to stay under the 2000-char API limit even when
    // the model returns a chatty visualPrompt.
    const prompt = `${workTitle ? `${workTitle}. ` : ''}${scene.visualPrompt}`.slice(0, 1900);
    const res = await generateImage({
      prompt,
      modelId: imageCfg.modelId,
      mode: imageCfg.mode,
      width: imageCfg.width,
      height: imageCfg.height,
    }).catch((err) => {
      setError(err.message);
      setGenStatus('error');
      return null;
    });
    if (!res) return;
    // Local mode returns a queued/running status and the canonical path; the
    // PNG lands there once the queue worker emits `image-gen:completed`.
    // External/codex modes return synchronously with the image already on disk.
    jobIdRef.current = res.jobId || res.generationId || null;
    setGenerated({ path: res.path, jobId: res.jobId, prompt });
    if (res.status !== 'queued' && res.status !== 'running') {
      setGenStatus('done');
    }
  };

  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;
  // `view` collapses the (genStatus, progress, generated) tuple to a single
  // discriminator so the preview-area JSX is one switch instead of nested
  // ternaries.
  const view = progress?.currentImage ? 'live'
    : genStatus === 'done' && generated?.path ? 'final'
    : genStatus === 'running' ? 'spinner'
    : genStatus === 'error' ? 'error'
    : null;
  const showPreviewArea = view !== null;

  return (
    <div className="border border-port-border rounded p-2 space-y-1.5 bg-port-card/40">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-white truncate">{scene.heading}</div>
          {scene.slugline && <div className="text-[10px] text-port-accent uppercase tracking-wide">{scene.slugline}</div>}
        </div>
        <button
          onClick={generate}
          disabled={genStatus === 'running'}
          className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-[10px] text-gray-300 hover:border-port-accent hover:text-white disabled:opacity-50"
          title="Queue an image render using this scene's visual prompt"
        >
          {genStatus === 'running' ? <Loader2 size={10} className="animate-spin" /> : <ImageIcon size={10} />}
          {genStatus === 'running' ? 'Rendering…' : genStatus === 'done' ? 'Re-render' : 'Image'}
        </button>
      </div>

      {showPreviewArea && (
        <div
          style={{ aspectRatio: `${imageCfg.width} / ${imageCfg.height}` }}
          className="w-full bg-port-bg border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative">
          {view === 'live' && (
            <img
              src={`data:image/png;base64,${progress.currentImage}`}
              alt="Diffusing…"
              decoding="async"
              className="w-full h-full object-contain"
            />
          )}
          {view === 'final' && (
            <a href={generated.path} target="_blank" rel="noreferrer" className="block w-full h-full">
              <img
                src={generated.path}
                alt={scene.heading}
                loading="lazy"
                className="w-full h-full object-contain"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            </a>
          )}
          {view === 'spinner' && (
            <div className="text-gray-500 text-xs flex flex-col items-center gap-2 px-3 text-center">
              <Loader2 size={20} className="animate-spin text-port-accent" />
              <span className="font-medium text-gray-300">
                {progress?.step != null && progress?.totalSteps
                  ? `Step ${progress.step}/${progress.totalSteps}`
                  : 'Queued — waiting for first preview…'}
              </span>
              {progress?.eta != null && (
                <span className="text-[10px] text-gray-500">~{Math.max(0, Math.round(progress.eta))}s remaining</span>
              )}
            </div>
          )}
          {view === 'error' && (
            <div className="text-port-error text-xs px-3 text-center break-words">
              {error || 'Generation failed'}
            </div>
          )}

          {genStatus === 'running' && progressPct != null && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
              <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          )}
        </div>
      )}
      {genStatus === 'done' && generated?.jobId && (
        <div className="text-[9px] text-gray-500 truncate">job {generated.jobId}</div>
      )}

      {scene.summary && <div className="text-gray-400">{scene.summary}</div>}
      {scene.characters?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {scene.characters.map((c, i) => <span key={i} className="px-1.5 py-0.5 bg-port-bg border border-port-border rounded text-[9px] uppercase tracking-wider">{c}</span>)}
        </div>
      )}
      {scene.action && <div className="text-gray-300 whitespace-pre-wrap font-serif">{scene.action}</div>}
      {scene.dialogue?.length > 0 && (
        <div className="space-y-1 pl-3 border-l border-port-border">
          {scene.dialogue.map((d, i) => (
            <div key={i}>
              <div className="text-[9px] uppercase tracking-wider text-gray-500">{d.character}</div>
              <div className="text-gray-300 italic">"{d.line}"</div>
            </div>
          ))}
        </div>
      )}
      {scene.visualPrompt && (
        <details className="text-[10px] text-gray-500">
          <summary className="cursor-pointer hover:text-white">Visual prompt</summary>
          <div className="mt-1 italic">{scene.visualPrompt}</div>
        </details>
      )}
    </div>
  );
}
