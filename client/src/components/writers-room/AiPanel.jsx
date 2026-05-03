import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Sparkles, FileSignature, Clapperboard, Users, Loader2, RotateCcw, AlertTriangle, Image as ImageIcon, Check, Settings as SettingsIcon, Pencil, Trash2, Plus, X } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listWritersRoomAnalyses,
  runWritersRoomAnalysis,
  getWritersRoomAnalysis,
  attachWritersRoomSceneImage,
  listWritersRoomCharacters,
  createWritersRoomCharacter,
  updateWritersRoomCharacter,
  deleteWritersRoomCharacter,
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
  evaluate:   { label: 'Evaluate',   icon: Sparkles,      hint: 'Editorial critique: logline, themes, issues, suggestions' },
  format:     { label: 'Format',     icon: FileSignature, hint: 'Tidy prose: paragraphing, dialogue, whitespace, typos' },
  script:     { label: 'Adapt',      icon: Clapperboard,  hint: 'Adapt prose into scene-by-scene script with visual prompts' },
  characters: { label: 'Characters', icon: Users,         hint: 'Build/refresh character profiles with image-gen-ready physical descriptions. Preserves your edits — fills gaps from prose.' },
};

const SEVERITY_COLOR = {
  major: 'text-port-error border-port-error/40',
  moderate: 'text-port-warning border-port-warning/40',
  minor: 'text-gray-400 border-port-border',
};

export default function AiPanel({ work, onApplyFormat, readingTheme = 'dark' }) {
  const [analyses, setAnalyses] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [running, setRunning] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [details, setDetails] = useState({});
  const [characters, setCharacters] = useState([]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const activeDraft = (work.drafts || []).find((d) => d.id === work.activeDraftVersionId);
  const activeHash = activeDraft?.contentHash || null;

  const refresh = useCallback(async () => {
    setLoadingList(true);
    const [list, chars] = await Promise.all([
      listWritersRoomAnalyses(work.id).catch((err) => {
        if (mountedRef.current) toast.error(`Failed to list analyses: ${err.message}`);
        return [];
      }),
      listWritersRoomCharacters(work.id).catch(() => []),
    ]);
    if (!mountedRef.current) return;
    setLoadingList(false);
    setAnalyses(list);
    setCharacters(chars);
  }, [work.id]);

  useEffect(() => {
    // Clear synchronously so a work-switch doesn't briefly render the previous
    // work's analyses while the new fetch is in flight.
    setAnalyses([]);
    setExpanded(null);
    setDetails({});
    setCharacters([]);
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
    if (kind === 'characters' && snapshot.status === 'succeeded' && Array.isArray(snapshot.result?.mergedProfiles)) {
      setCharacters(snapshot.result.mergedProfiles);
    }
  };

  const upsertCharacterLocal = (next) => {
    setCharacters((prev) => {
      const idx = prev.findIndex((c) => c.id === next.id);
      if (idx < 0) return [...prev, next].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const copy = [...prev];
      copy[idx] = next;
      return copy.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    });
  };

  const removeCharacterLocal = (id) => {
    setCharacters((prev) => prev.filter((c) => c.id !== id));
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
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

      <CharactersBible
        workId={work.id}
        characters={characters}
        onLocalChange={upsertCharacterLocal}
        onLocalDelete={removeCharacterLocal}
        readingTheme={readingTheme}
      />

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
                      <EvaluateResult result={full.result} readingTheme={readingTheme} />
                    )}
                    {full?.status === 'succeeded' && full.kind === 'format' && (
                      <FormatResult result={full.result} onApply={(text) => onApplyFormat?.(text)} readingTheme={readingTheme} />
                    )}
                    {full?.status === 'succeeded' && full.kind === 'script' && (
                      <ScriptResult
                        result={full.result}
                        workId={work.id}
                        analysisId={full.id}
                        sceneImages={full.sceneImages || {}}
                        workTitle={work.title}
                        readingTheme={readingTheme}
                        characters={characters}
                      />
                    )}
                    {full?.status === 'succeeded' && full.kind === 'characters' && (
                      <CharactersAnalysisResult result={full.result} readingTheme={readingTheme} />
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

function EvaluateResult({ result, readingTheme = 'dark' }) {
  if (!result) return null;
  const light = readingTheme === 'light';
  const labelCls = `uppercase text-[9px] ${light ? 'text-gray-600' : 'text-gray-500'}`;
  return (
    <div className={`space-y-2 text-[11px] rounded p-2 ${light ? 'bg-[var(--wr-reading-paper)] text-gray-900' : 'text-gray-300'}`}>
      {result.logline && <div><span className={labelCls}>Logline</span><div className="italic">{result.logline}</div></div>}
      {result.summary && <div><span className={labelCls}>Summary</span><div>{result.summary}</div></div>}
      {result.themes?.length > 0 && (
        <div>
          <span className={labelCls}>Themes</span>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {result.themes.map((t, i) => (
              <span key={i} className={`px-1.5 py-0.5 border rounded text-[10px] ${light ? 'bg-white border-gray-300 text-gray-800' : 'bg-port-card border-port-border'}`}>{t}</span>
            ))}
          </div>
        </div>
      )}
      {result.strengths?.length > 0 && (
        <div>
          <span className={labelCls}>Strengths</span>
          <ul className={`list-disc list-inside space-y-0.5 mt-0.5 ${light ? 'text-gray-800' : 'text-gray-400'}`}>
            {result.strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
      {result.issues?.length > 0 && (
        <div>
          <span className={labelCls}>Issues</span>
          <ul className="space-y-1 mt-0.5">
            {result.issues.map((iss, i) => (
              <li key={i} className={`pl-2 border-l-2 ${SEVERITY_COLOR[iss.severity] || SEVERITY_COLOR.minor}`}>
                <div className="text-[10px] uppercase tracking-wide opacity-80">{iss.severity || 'minor'} · {iss.category || 'note'}</div>
                <div>{iss.note}</div>
                {iss.excerpt && <div className={`italic mt-0.5 ${light ? 'text-gray-700' : 'text-gray-500'}`}>"{iss.excerpt}"</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.suggestions?.length > 0 && (
        <div>
          <span className={labelCls}>Suggestions</span>
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

function FormatResult({ result, onApply, readingTheme = 'dark' }) {
  const text = result?.formattedBody || '';
  if (!text) return <div className="text-gray-500">Format pass returned no text.</div>;
  const light = readingTheme === 'light';
  const labelCls = `uppercase text-[9px] ${light ? 'text-gray-600' : 'text-gray-500'}`;
  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className={labelCls}>Cleaned prose ({text.length.toLocaleString()} chars)</span>
        <button
          onClick={() => onApply?.(text)}
          className="flex items-center gap-1 px-2 py-1 bg-port-accent text-white rounded text-[10px] hover:bg-port-accent/80"
          title="Replace the current draft buffer with this cleaned text (you can still cancel by not saving)"
        >
          <Check size={10} /> Apply to draft
        </button>
      </div>
      <pre className={`whitespace-pre-wrap font-serif border rounded p-2 max-h-64 overflow-y-auto ${
        light ? 'text-gray-900 bg-[var(--wr-reading-paper)] border-gray-300' : 'text-gray-300 bg-port-bg border-port-border'
      }`}>{text}</pre>
    </div>
  );
}

function ScriptResult({ result, workId, analysisId, sceneImages = {}, workTitle, readingTheme = 'dark', characters = [] }) {
  const charByKey = useMemo(() => buildCharByKey(characters), [characters]);
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
      {result.scenes.map((scene, i) => {
        const sceneId = scene.id || `scene-${i}`;
        return (
          <SceneCard
            key={sceneId}
            scene={{ ...scene, id: sceneId }}
            workId={workId}
            analysisId={analysisId}
            workTitle={workTitle}
            imageCfg={imageCfg}
            initialImage={sceneImages[sceneId] || null}
            readingTheme={readingTheme}
            charByKey={charByKey}
          />
        );
      })}
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

// LLM scene lists use bare names ("ARIA"), profiles may use full names
// ("Aria Reyes") or "the bartender" — strip leading "the " and lowercase so
// either side resolves to the same key.
const normCharKey = (s) => String(s || '').trim().toLowerCase().replace(/^the\s+/, '');

// Build a name+alias → profile lookup. One pass at the panel level so chip
// rendering is O(1) per chip instead of O(N) per render.
function buildCharByKey(allCharacters) {
  const map = new Map();
  for (const profile of allCharacters) {
    map.set(normCharKey(profile.name), profile);
    for (const alias of profile.aliases || []) map.set(normCharKey(alias), profile);
  }
  return map;
}

function matchSceneCharacters(sceneCharacterNames = [], charByKey) {
  if (!Array.isArray(sceneCharacterNames) || !sceneCharacterNames.length) return [];
  const matched = [];
  const seen = new Set();
  for (const name of sceneCharacterNames) {
    const profile = charByKey?.get(normCharKey(name));
    if (profile && !seen.has(profile.id)) {
      matched.push(profile);
      seen.add(profile.id);
    }
  }
  return matched;
}

const PROMPT_MAX = 1900;

// The scene's visualPrompt is the load-bearing part of the image-gen prompt
// (location, action, mood) — it must always survive truncation. Reserve room
// for title + visual prompt first, then fit the "Featuring" block into
// whatever is left, dropping characters one-by-one if needed.
function buildScenePromptWithCharacters(workTitle, scene, matchedCharacters) {
  const titlePart = workTitle ? `${workTitle}. ` : '';
  const visual = scene.visualPrompt || '';
  const featuringFragments = matchedCharacters
    .filter((c) => c.physicalDescription && c.physicalDescription.trim())
    .map((c) => `${c.name}: ${c.physicalDescription.trim()}`);
  const PREFIX = 'Featuring — ';
  const reserveForVisual = titlePart.length + visual.length + 1; // +1 for the join space
  let budget = PROMPT_MAX - reserveForVisual - PREFIX.length;
  const fitFragments = [];
  for (const frag of featuringFragments) {
    const cost = (fitFragments.length === 0 ? 0 : 1) + frag.length; // +1 for join space
    if (cost > budget) break;
    fitFragments.push(frag);
    budget -= cost;
  }
  const segs = [titlePart.trim()];
  if (fitFragments.length > 0) segs.push(`${PREFIX}${fitFragments.join(' ')}`);
  if (visual) segs.push(visual);
  return segs.filter(Boolean).join(' ').slice(0, PROMPT_MAX);
}

function SceneCard({ scene, workId, analysisId, workTitle, imageCfg = WR_IMAGE_DEFAULTS, initialImage = null, readingTheme = 'dark', charByKey = null }) {
  const light = readingTheme === 'light';
  const matchedCharacters = useMemo(
    () => matchSceneCharacters(scene.characters, charByKey),
    [scene.characters, charByKey]
  );
  const matchedNameKeys = useMemo(() => {
    const keys = new Set();
    for (const c of matchedCharacters) {
      keys.add(normCharKey(c.name));
      for (const a of c.aliases || []) keys.add(normCharKey(a));
    }
    return keys;
  }, [matchedCharacters]);
  // genStatus drives the button + preview overlay:
  //   idle    → no preview area shown
  //   running → preview area shows spinner / live diffusion frame from socket
  //   done    → preview area shows the final rendered image
  //   error   → preview area shows the error
  // Seed from initialImage so a previously-rendered scene shows its image
  // immediately on remount (e.g. after navigating back to the work).
  const [genStatus, setGenStatus] = useState(initialImage ? 'done' : 'idle');
  const [generated, setGenerated] = useState(initialImage
    ? { path: `/data/images/${initialImage.filename}`, jobId: initialImage.jobId, prompt: initialImage.prompt }
    : null);
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
      const completedJobId = jobIdRef.current;
      setGenerated((prev) => prev ? { ...prev, path: data.path || prev.path } : prev);
      setGenStatus('done');
      setProgress(null);
      jobIdRef.current = null;
      // Persist the scene→image link so the user sees the same image when
      // they navigate back. The image filename is `<jobId>.png` per the local
      // image-gen route's response shape.
      if (workId && analysisId && scene.id) {
        attachWritersRoomSceneImage(workId, analysisId, {
          sceneId: scene.id,
          filename: `${completedJobId}.png`,
          jobId: completedJobId,
          prompt: data.prompt || null,
        }).catch((err) => {
          console.warn(`scene-image persist failed: ${err.message}`);
        });
      }
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
  }, [workId, analysisId, scene.id]);

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
    const prompt = buildScenePromptWithCharacters(workTitle, scene, matchedCharacters);
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
    <div className={`border rounded p-2 space-y-1.5 ${
      light ? 'border-gray-300 bg-[var(--wr-reading-paper)] text-gray-900' : 'border-port-border bg-port-card/40'
    }`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className={`font-semibold truncate ${light ? 'text-gray-900' : 'text-white'}`}>{scene.heading}</div>
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

      {scene.summary && <div className={light ? 'text-gray-700' : 'text-gray-400'}>{scene.summary}</div>}
      {scene.characters?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {scene.characters.map((c, i) => {
            const isMatched = matchedNameKeys.has(normCharKey(c));
            return (
              <span
                key={i}
                title={isMatched ? 'Profile linked — physical description injected into image prompt' : 'No matching profile — run Characters to add'}
                className={`px-1.5 py-0.5 border rounded text-[9px] uppercase tracking-wider ${
                  isMatched
                    ? 'border-port-accent text-port-accent bg-port-accent/10'
                    : light ? 'bg-white border-gray-300 text-gray-700' : 'bg-port-bg border-port-border'
                }`}>
                {c}
              </span>
            );
          })}
        </div>
      )}
      {scene.action && (
        <div className={`whitespace-pre-wrap font-serif ${light ? 'text-gray-900' : 'text-gray-300'}`}>{scene.action}</div>
      )}
      {scene.dialogue?.length > 0 && (
        <div className={`space-y-1 pl-3 border-l ${light ? 'border-gray-400' : 'border-port-border'}`}>
          {scene.dialogue.map((d, i) => (
            <div key={i}>
              <div className={`text-[9px] uppercase tracking-wider ${light ? 'text-gray-600' : 'text-gray-500'}`}>{d.character}</div>
              <div className={`italic ${light ? 'text-gray-900' : 'text-gray-300'}`}>"{d.line}"</div>
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

// ---------- character bible (editable, persistent across analysis runs) ----------

const CHARACTER_FIELDS = [
  { key: 'aliases',             label: 'Aliases',              placeholder: 'nicknames, titles (comma-separated)',                                                                  kind: 'csv' },
  { key: 'role',                label: 'Role',                 placeholder: 'protagonist, mentor, antagonist…',                                                                     kind: 'text' },
  { key: 'physicalDescription', label: 'Physical description', placeholder: 'Age, build, hair, eyes, distinctive features, signature wardrobe. Used directly in image-gen prompts.', kind: 'multiline' },
  { key: 'personality',         label: 'Personality',          placeholder: 'Temperament, voice, quirks',                                                                           kind: 'multiline' },
  { key: 'background',          label: 'Background',           placeholder: 'Who they are, where they come from',                                                                   kind: 'multiline' },
  { key: 'notes',               label: 'Notes',                placeholder: 'Anything else worth tracking',                                                                         kind: 'multiline' },
];

function CharactersBible({ workId, characters, onLocalChange, onLocalDelete, readingTheme }) {
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-[10px] uppercase tracking-wider text-gray-500">Characters</h3>
        <button
          onClick={() => { setCreating(true); setEditingId(null); }}
          className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-port-accent"
          title="Add a character profile manually"
        >
          <Plus size={11} /> Add
        </button>
      </div>

      {characters.length === 0 && !creating && (
        <div className="text-gray-600 italic px-1 mb-2">
          No profiles yet. Run <span className="text-gray-400">Characters</span> to extract from prose, or add one manually.
        </div>
      )}

      {creating && (
        <CharacterEditor
          workId={workId}
          character={null}
          onSaved={(c) => { onLocalChange(c); setCreating(false); }}
          onCancel={() => setCreating(false)}
          readingTheme={readingTheme}
        />
      )}

      <ul className="space-y-1">
        {characters.map((c) => {
          const isEditing = editingId === c.id;
          if (isEditing) {
            return (
              <li key={c.id}>
                <CharacterEditor
                  workId={workId}
                  character={c}
                  onSaved={(updated) => { onLocalChange(updated); setEditingId(null); }}
                  onDeleted={() => { onLocalDelete(c.id); setEditingId(null); }}
                  onCancel={() => setEditingId(null)}
                  readingTheme={readingTheme}
                />
              </li>
            );
          }
          return (
            <li key={c.id} className="border border-port-border rounded">
              <CharacterRow character={c} onEdit={() => setEditingId(c.id)} readingTheme={readingTheme} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CharacterRow({ character, onEdit, readingTheme }) {
  const light = readingTheme === 'light';
  const blanks = CHARACTER_FIELDS.filter((f) => {
    if (f.key === 'notes' || f.key === 'aliases') return false;
    return !String(character[f.key] || '').trim();
  });
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-semibold ${light ? 'text-gray-900' : 'text-white'}`}>{character.name}</span>
            {character.role && (
              <span className="text-[9px] uppercase tracking-wider text-port-accent">{character.role}</span>
            )}
            {character.source === 'ai' && (
              <span className="text-[9px] text-gray-500" title="Created by AI extraction — edit to mark as user-curated">ai</span>
            )}
            {character.aliases?.length > 0 && (
              <span className="text-[10px] text-gray-500 truncate">aka {character.aliases.join(', ')}</span>
            )}
          </div>
          {character.physicalDescription ? (
            <div className={`text-[11px] mt-0.5 ${light ? 'text-gray-700' : 'text-gray-400'}`}>
              {character.physicalDescription}
            </div>
          ) : (
            <div className="text-[11px] mt-0.5 text-port-warning italic">No physical description — image gen will use scene context only</div>
          )}
          {blanks.length > 0 && (
            <div className="text-[10px] text-port-warning mt-1 flex items-center gap-1">
              <AlertTriangle size={9} /> Missing: {blanks.map((f) => f.label.toLowerCase()).join(', ')}
            </div>
          )}
          {character.missingFromProse?.length > 0 && (
            <div className="text-[10px] text-gray-500 mt-1">
              <span className="uppercase tracking-wider text-[9px]">Prose gaps:</span> {character.missingFromProse.join(', ')}
            </div>
          )}
        </div>
        <button
          onClick={onEdit}
          className="text-gray-500 hover:text-port-accent shrink-0"
          title="Edit profile"
          aria-label={`Edit ${character.name}`}
        >
          <Pencil size={11} />
        </button>
      </div>
    </div>
  );
}

function CharacterEditor({ workId, character, onSaved, onDeleted, onCancel, readingTheme }) {
  const isCreate = !character;
  const [draft, setDraft] = useState(() => {
    const seed = { name: character?.name || '' };
    for (const f of CHARACTER_FIELDS) {
      seed[f.key] = f.kind === 'csv' ? (character?.[f.key] || []).join(', ') : (character?.[f.key] || '');
    }
    return seed;
  });
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setDraft((d) => ({ ...d, [field]: e.target.value }));

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    const payload = { name: draft.name.trim() };
    for (const f of CHARACTER_FIELDS) {
      payload[f.key] = f.kind === 'csv'
        ? draft[f.key].split(',').map((s) => s.trim()).filter(Boolean)
        : draft[f.key];
    }
    const result = await (isCreate
      ? createWritersRoomCharacter(workId, payload)
      : updateWritersRoomCharacter(workId, character.id, payload)
    ).catch((err) => {
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    setSaving(false);
    if (!result) return;
    toast.success(`${result.name} saved`);
    onSaved?.(result);
  };

  const remove = async () => {
    if (!character) return;
    setSaving(true);
    const ok = await deleteWritersRoomCharacter(workId, character.id).then(() => true).catch((err) => {
      toast.error(`Delete failed: ${err.message}`);
      return false;
    });
    setSaving(false);
    if (ok) {
      toast.success(`${character.name} removed`);
      onDeleted?.();
    }
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none';

  return (
    <div className="border border-port-accent/40 rounded p-2 bg-port-card/40 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <input
          value={draft.name}
          onChange={set('name')}
          placeholder="Character name"
          className={`${inputCls} font-semibold`}
        />
        <button
          onClick={onCancel}
          className="text-gray-500 hover:text-white shrink-0"
          aria-label="Cancel edit"
          title="Cancel"
        >
          <X size={12} />
        </button>
      </div>
      {CHARACTER_FIELDS.map((f) => (
        <label key={f.key} className="block">
          <span className="text-[9px] uppercase tracking-wider text-gray-500">{f.label}</span>
          {f.kind === 'multiline' ? (
            <textarea value={draft[f.key]} onChange={set(f.key)} placeholder={f.placeholder} rows={f.key === 'physicalDescription' ? 3 : 2} className={`${inputCls} font-sans resize-y`} />
          ) : (
            <input value={draft[f.key]} onChange={set(f.key)} placeholder={f.placeholder} className={inputCls} />
          )}
        </label>
      ))}
      <div className="flex items-center justify-between pt-1">
        {!isCreate ? (
          <button
            onClick={remove}
            disabled={saving}
            className="flex items-center gap-1 text-[10px] text-port-error hover:underline disabled:opacity-50"
          >
            <Trash2 size={10} /> Delete
          </button>
        ) : <span />}
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1 px-2 py-1 bg-port-accent text-white rounded text-[10px] hover:bg-port-accent/80 disabled:opacity-50"
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Save
        </button>
      </div>
    </div>
  );
}

// Read-only summary of the most recent characters analysis snapshot, shown in
// the History expander. The editable bible above is the source of truth for
// scene-image injection — this view exists so the user can compare what came
// back from this specific run against what's now in the bible.
function CharactersAnalysisResult({ result, readingTheme }) {
  const light = readingTheme === 'light';
  const list = result?.characters || [];
  if (!list.length) return <div className="text-gray-500">No characters returned.</div>;
  return (
    <div className={`space-y-2 text-[11px] ${light ? 'text-gray-900' : 'text-gray-300'}`}>
      <div className="text-[10px] text-gray-500">
        {list.length} character{list.length === 1 ? '' : 's'} extracted. Edits to the bible above persist across re-runs.
      </div>
      <ul className="space-y-1.5">
        {list.map((c, i) => (
          <li key={i} className={`border rounded p-2 ${light ? 'border-gray-300 bg-white' : 'border-port-border bg-port-bg/40'}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-semibold ${light ? 'text-gray-900' : 'text-white'}`}>{c.name}</span>
              {c.role && <span className="text-[9px] uppercase tracking-wider text-port-accent">{c.role}</span>}
            </div>
            {c.physicalDescription && (
              <div className={`mt-1 ${light ? 'text-gray-700' : 'text-gray-400'}`}>{c.physicalDescription}</div>
            )}
            {c.missingFromProse?.length > 0 && (
              <div className="text-[10px] text-port-warning mt-1">
                Prose gaps: {c.missingFromProse.join(', ')}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
