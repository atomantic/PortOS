import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Loader2, RefreshCcw, Settings as SettingsIcon, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listWritersRoomAnalyses,
  getWritersRoomAnalysis,
} from '../../services/apiWritersRoom';
import { getSettings, updateSettings } from '../../services/apiSystem';
import { listImageModels } from '../../services/apiImageVideo';
import { timeAgo } from '../../utils/formatters';
import SceneCard from './SceneCard';
import {
  WR_IMAGE_DEFAULTS,
  buildCharByKey,
  readWrImageSettings,
} from './sceneCardHelpers';

// Vertical storyboard companion — the scene-by-scene visual interpretation of
// the active draft. Renders cards from the latest successful Adapt analysis.
// When the Adapt is older than the current draft hash, surfaces a stale
// banner inviting a re-run.
export default function StoryboardPanel({
  work,
  characters = [],
  onJumpToScene,
  onDebug,
  onRunAdapt,
  runningAdapt = false,
  readingTheme = 'dark',
  activeSceneId = null,
}) {
  const [latestScript, setLatestScript] = useState(null);
  const [loading, setLoading] = useState(false);
  const [imageCfg, setImageCfg] = useState(WR_IMAGE_DEFAULTS);
  const [models, setModels] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Image-gen settings + model catalog — fetched once per mount, persisted to
  // settings.json so the user's resolution + model choice sticks.
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

  const loadLatestScript = useCallback(async () => {
    setLoading(true);
    const list = await listWritersRoomAnalyses(work.id).catch(() => []);
    if (!mountedRef.current) return;
    const latest = list.find((a) => a.kind === 'script' && a.status === 'succeeded');
    if (!latest) {
      setLatestScript(null);
      setLoading(false);
      return;
    }
    // We need the full snapshot (scenes + sceneImages) — list returns metadata
    // only.
    const full = await getWritersRoomAnalysis(work.id, latest.id).catch(() => null);
    if (!mountedRef.current) return;
    setLatestScript(full);
    setLoading(false);
  }, [work.id]);

  useEffect(() => {
    setLatestScript(null);
    loadLatestScript();
  }, [loadLatestScript]);

  // After Adapt finishes the parent will toggle runningAdapt false — that's
  // our cue to refetch the latest.
  const prevRunning = useRef(runningAdapt);
  useEffect(() => {
    if (prevRunning.current && !runningAdapt) {
      loadLatestScript();
    }
    prevRunning.current = runningAdapt;
  }, [runningAdapt, loadLatestScript]);

  const persistCfg = useCallback(async (next) => {
    setImageCfg(next);
    const current = await getSettings().catch(() => ({}));
    await updateSettings({
      ...current,
      writersRoom: { ...(current.writersRoom || {}), imageGen: next },
    }).catch((err) => toast.error(`Settings save failed: ${err.message}`));
  }, []);

  const charByKey = useMemo(() => buildCharByKey(characters), [characters]);
  const activeDraft = (work.drafts || []).find((d) => d.id === work.activeDraftVersionId);
  const activeHash = activeDraft?.contentHash || null;
  const isStale = !!latestScript?.sourceContentHash && !!activeHash && latestScript.sourceContentHash !== activeHash;
  const scenes = latestScript?.result?.scenes || [];
  const sceneImages = latestScript?.sceneImages || {};

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-port-border bg-port-bg/40 shrink-0">
        <Clapperboard size={13} className="text-port-accent" />
        <span className="text-[11px] font-semibold text-gray-200 uppercase tracking-wider">Storyboard</span>
        {latestScript && (
          <span className="text-[10px] text-gray-500 truncate">
            {scenes.length} scene{scenes.length === 1 ? '' : 's'} · {timeAgo(latestScript.completedAt || latestScript.createdAt, 'never')}
          </span>
        )}
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="ml-auto text-gray-500 hover:text-white"
          title={`Image gen: ${imageCfg.modelId} · ${imageCfg.width}×${imageCfg.height}`}
          aria-label="Image gen settings"
        >
          <SettingsIcon size={12} />
        </button>
      </div>

      {showSettings && (
        <div className="px-3 py-2 border-b border-port-border bg-port-card/30 shrink-0">
          <ImageGenSettingsRow cfg={imageCfg} models={models} onChange={persistCfg} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {loading && (
          <div className="flex items-center justify-center text-[11px] text-gray-500 gap-2 py-6">
            <Loader2 size={14} className="animate-spin" /> Loading storyboard…
          </div>
        )}

        {!loading && !latestScript && (
          <EmptyAdaptCTA onRunAdapt={onRunAdapt} runningAdapt={runningAdapt} />
        )}

        {!loading && latestScript && isStale && (
          <StaleBanner onRunAdapt={onRunAdapt} runningAdapt={runningAdapt} />
        )}

        {!loading && latestScript && scenes.length === 0 && (
          <div className="text-[11px] text-gray-500 italic px-1">
            Adapt finished but produced no scenes. Try adding `## Scene` headings to your prose, then re-run.
          </div>
        )}

        {!loading && scenes.map((scene, i) => {
          const sceneId = scene.id || `scene-${i}`;
          return (
            <SceneCard
              key={sceneId}
              scene={{ ...scene, id: sceneId }}
              workId={work.id}
              analysisId={latestScript.id}
              workTitle={work.title}
              imageCfg={imageCfg}
              initialImage={sceneImages[sceneId] || null}
              readingTheme={readingTheme}
              charByKey={charByKey}
              isActive={sceneId === activeSceneId}
              onJumpToProse={onJumpToScene ? () => onJumpToScene(scene, i, scenes.length) : null}
              onDebug={onDebug}
            />
          );
        })}
      </div>
    </div>
  );
}

function EmptyAdaptCTA({ onRunAdapt, runningAdapt }) {
  return (
    <div className="text-center px-3 py-8 space-y-3">
      <Clapperboard size={28} className="mx-auto text-gray-600" />
      <div className="text-[12px] text-gray-300 font-medium">No storyboard yet</div>
      <div className="text-[11px] text-gray-500 max-w-[28ch] mx-auto">
        Run Adapt to break your prose into scenes and start visualizing how the AI is reading your story.
      </div>
      <button
        onClick={onRunAdapt}
        disabled={runningAdapt || !onRunAdapt}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-port-accent text-white text-[11px] rounded hover:bg-port-accent/80 disabled:opacity-50"
      >
        {runningAdapt ? <Loader2 size={12} className="animate-spin" /> : <Clapperboard size={12} />}
        {runningAdapt ? 'Running Adapt…' : 'Run Adapt'}
      </button>
    </div>
  );
}

function StaleBanner({ onRunAdapt, runningAdapt }) {
  return (
    <div className="flex items-start gap-2 p-2 mb-1 border border-port-warning/40 bg-port-warning/5 rounded text-[11px]">
      <AlertTriangle size={12} className="text-port-warning mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="text-port-warning">Storyboard is older than your current draft.</div>
        <div className="text-gray-500">Re-run Adapt to refresh scenes against the latest prose.</div>
      </div>
      <button
        onClick={onRunAdapt}
        disabled={runningAdapt || !onRunAdapt}
        className="flex items-center gap-1 px-2 py-1 bg-port-warning/20 border border-port-warning/40 text-port-warning rounded text-[10px] hover:bg-port-warning/30 disabled:opacity-50"
      >
        {runningAdapt ? <Loader2 size={10} className="animate-spin" /> : <RefreshCcw size={10} />}
        Re-run
      </button>
    </div>
  );
}

function ImageGenSettingsRow({ cfg, models, onChange }) {
  const RES_PRESETS = [
    { label: '768×512 (3:2)',  width: 768, height: 512 },
    { label: '512×512 (1:1)',  width: 512, height: 512 },
    { label: '512×768 (2:3)',  width: 512, height: 768 },
    { label: '1024×576 (16:9)', width: 1024, height: 576 },
    { label: '1024×1024 (1:1)', width: 1024, height: 1024 },
  ];
  const presetMatch = RES_PRESETS.find((p) => p.width === cfg.width && p.height === cfg.height);
  return (
    <div className="space-y-1.5">
      <label className="block">
        <span className="text-[9px] uppercase tracking-wider text-gray-500">Image model</span>
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
