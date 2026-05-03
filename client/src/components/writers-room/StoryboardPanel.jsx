import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, Loader2, RefreshCcw, Settings as SettingsIcon, AlertTriangle, Palette, Check, Dice5, Cpu, Users, MapPin as MapPinIcon, ArrowRight } from 'lucide-react';
import { randomSeed } from '../../lib/genUtils';
import toast from '../ui/Toast';
import {
  listWritersRoomAnalyses,
  getWritersRoomAnalysis,
  listWritersRoomStylePresets,
} from '../../services/apiWritersRoom';
import { getSettings, updateSettings } from '../../services/apiSystem';
import { listImageModels } from '../../services/apiImageVideo';
import { timeAgo } from '../../utils/formatters';
import useMounted from '../../hooks/useMounted';
import SceneCard from './SceneCard';
import StagePromptModelPicker from './StagePromptModelPicker';
import {
  WR_IMAGE_DEFAULTS,
  buildCharByKey,
  buildSettingByKey,
  readWrImageSettings,
  STYLE_ID,
  EMPTY_IMAGE_STYLE,
} from './sceneCardHelpers';

const SCRIPT_STAGE = 'writers-room-script';

export default function StoryboardPanel({
  work,
  characters = [],
  settings = [],
  onJumpToScene,
  onDebug,
  onRunAdapt,
  onRunCharacters,
  onRunSettings,
  onRunFullPipeline,
  runningAdapt = false,
  runningKind = null,
  readingTheme = 'dark',
  activeSceneId = null,
  onStyleChange,
}) {
  const [latestScript, setLatestScript] = useState(null);
  const [latestFailure, setLatestFailure] = useState(null);
  const [loading, setLoading] = useState(false);
  const [imageCfg, setImageCfg] = useState(WR_IMAGE_DEFAULTS);
  const [models, setModels] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [stylePresets, setStylePresets] = useState([]);
  const mountedRef = useMounted();

  const imageStyle = work.imageStyle || EMPTY_IMAGE_STYLE;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSettings().catch(() => ({})),
      listImageModels().catch(() => []),
      listWritersRoomStylePresets().catch(() => []),
    ]).then(([settings, modelList, presets]) => {
      if (cancelled) return;
      setImageCfg(readWrImageSettings(settings));
      setModels(Array.isArray(modelList) ? modelList : []);
      setStylePresets(Array.isArray(presets) ? presets : []);
    });
    return () => { cancelled = true; };
  }, []);

  const loadLatestScript = useCallback(async () => {
    setLoading(true);
    const list = await listWritersRoomAnalyses(work.id).catch(() => []);
    if (!mountedRef.current) return;
    // listAnalyses is sorted createdAt desc, so the first match per status is
    // also the most-recent one. Track failures only when newer than the latest
    // success — a stale failure under a newer success is just history.
    const scripts = list.filter((a) => a.kind === 'script');
    const latestRun = scripts[0] || null;
    const latestSucceeded = scripts.find((a) => a.status === 'succeeded') || null;
    const failureIsNewer = latestRun?.status === 'failed'
      && (!latestSucceeded || (latestRun.createdAt || '') > (latestSucceeded.createdAt || ''));
    setLatestFailure(failureIsNewer ? latestRun : null);
    if (!latestSucceeded) {
      setLatestScript(null);
      setLoading(false);
      return;
    }
    // listAnalyses returns metadata only — fetch the full snapshot for scenes + sceneImages.
    const full = await getWritersRoomAnalysis(work.id, latestSucceeded.id).catch(() => null);
    if (!mountedRef.current) return;
    setLatestScript(full);
    setLoading(false);
  }, [work.id]);

  useEffect(() => {
    setLatestScript(null);
    setLatestFailure(null);
    loadLatestScript();
  }, [loadLatestScript]);

  // Refetch when Adapt completes — parent toggles runningAdapt true→false.
  // Also flag this as a freshly-finished Adapt so the next latestScript
  // load triggers an auto-queue of every missing image render.
  const prevRunning = useRef(runningAdapt);
  const justFinishedAdaptRef = useRef(false);
  useEffect(() => {
    if (prevRunning.current && !runningAdapt) {
      justFinishedAdaptRef.current = true;
      loadLatestScript();
    }
    prevRunning.current = runningAdapt;
  }, [runningAdapt, loadLatestScript]);

  // Refs to each SceneCard's imperative API so we can call .generate() on
  // every card without each card needing to know whether it's auto-queued.
  // Map keyed by sceneId — replaced wholesale on each script load.
  const sceneRefs = useRef({});

  // Auto-queue every missing image when latestScript updates *because* of a
  // just-finished Adapt run. requestAnimationFrame defers until the cards
  // have actually mounted with the new scenes — useImperativeHandle has to
  // commit before .canGenerate()/.generate() exist on the refs.
  useEffect(() => {
    if (!latestScript || !justFinishedAdaptRef.current) return;
    justFinishedAdaptRef.current = false;
    const handle = requestAnimationFrame(() => {
      let queued = 0;
      for (const sceneId in sceneRefs.current) {
        const handle = sceneRefs.current[sceneId];
        if (handle?.canGenerate?.()) {
          handle.generate();
          queued += 1;
        }
      }
      if (queued > 0) toast.success(`Queued ${queued} scene render${queued === 1 ? '' : 's'}`);
    });
    return () => cancelAnimationFrame(handle);
  }, [latestScript]);

  const persistCfg = useCallback(async (next) => {
    setImageCfg(next);
    const current = await getSettings().catch(() => ({}));
    await updateSettings({
      ...current,
      writersRoom: { ...(current.writersRoom || {}), imageGen: next },
    }).catch((err) => toast.error(`Settings save failed: ${err.message}`));
  }, []);

  const charByKey = useMemo(() => buildCharByKey(characters), [characters]);
  const settingByKey = useMemo(() => buildSettingByKey(settings), [settings]);
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
        {imageStyle.presetId !== STYLE_ID.NONE && (
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="text-port-accent/80 hover:text-port-accent flex items-center gap-1 text-[10px]"
            title="World style applied — click to edit"
          >
            <Palette size={11} /> {styleChip(imageStyle, stylePresets)}
          </button>
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
        <div className="px-3 py-2 border-b border-port-border bg-port-card/30 shrink-0 space-y-3 max-h-[60vh] overflow-y-auto">
          <StagePromptModelPicker
            stageName={SCRIPT_STAGE}
            label="Adapt LLM"
            icon={<Cpu size={10} />}
            hint="Used when you click Run Adapt to break prose into scenes."
          />
          <WorldStyleRow
            value={imageStyle}
            presets={stylePresets}
            onChange={onStyleChange}
          />
          <ImageGenSettingsRow cfg={imageCfg} models={models} onChange={persistCfg} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {loading && (
          <div className="flex items-center justify-center text-[11px] text-gray-500 gap-2 py-6">
            <Loader2 size={14} className="animate-spin" /> Loading storyboard…
          </div>
        )}

        {!loading && latestFailure && (
          <FailedAdaptBanner
            failure={latestFailure}
            onRunAdapt={onRunAdapt}
            runningAdapt={runningAdapt}
            onOpenSettings={() => setShowSettings(true)}
            hasPriorScript={!!latestScript}
          />
        )}

        {!loading && !latestScript && !latestFailure && (
          <StoryboardSetup
            charactersCount={characters.length}
            settingsCount={settings.length}
            onRunCharacters={onRunCharacters}
            onRunSettings={onRunSettings}
            onRunAdapt={onRunAdapt}
            onRunFullPipeline={onRunFullPipeline}
            runningKind={runningKind}
          />
        )}

        {!loading && latestScript && isStale && !latestFailure && (
          <StaleBanner onRunAdapt={onRunAdapt} runningAdapt={runningAdapt} />
        )}

        {!loading && latestScript && !isStale && !latestFailure && (characters.length === 0 || settings.length === 0) && (
          <BiblesMissingNotice
            charactersMissing={characters.length === 0}
            settingsMissing={settings.length === 0}
            onRunCharacters={onRunCharacters}
            onRunSettings={onRunSettings}
            runningKind={runningKind}
          />
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
              ref={(handle) => {
                if (handle) sceneRefs.current[sceneId] = handle;
                else delete sceneRefs.current[sceneId];
              }}
              scene={{ ...scene, id: sceneId }}
              workId={work.id}
              analysisId={latestScript.id}
              workTitle={work.title}
              imageCfg={imageCfg}
              imageStyle={imageStyle}
              initialImage={sceneImages[sceneId] || null}
              readingTheme={readingTheme}
              charByKey={charByKey}
              settingByKey={settingByKey}
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

// 3-step setup that replaces the old single "Run Adapt" CTA. Recommended
// order is characters → settings → script so Adapt's prompt has the bibles
// to cite (otherwise the LLM re-improvises descriptions every scene). The
// user can skip any step (clicking later steps directly is allowed) or just
// click "Run all in order" to fire the sequential pipeline.
function StoryboardSetup({
  charactersCount,
  settingsCount,
  onRunCharacters,
  onRunSettings,
  onRunAdapt,
  onRunFullPipeline,
  runningKind,
}) {
  const isRunning = !!runningKind;
  const charDone = charactersCount > 0;
  const setDone = settingsCount > 0;

  const Step = ({ n, kind, done, label, sublabel, hint, onClick, primary = false }) => {
    const running = runningKind === kind;
    const Icon = done ? Check : kind === 'characters' ? Users : kind === 'settings' ? MapPinIcon : Clapperboard;
    return (
      <div className={`flex items-start gap-2.5 p-2.5 border rounded ${
        done ? 'border-port-success/40 bg-port-success/5' :
        running ? 'border-port-accent/60 bg-port-accent/5' :
        'border-port-border bg-port-card/30'
      }`}>
        <div className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-semibold ${
          done ? 'border-port-success text-port-success' :
          running ? 'border-port-accent text-port-accent' :
          'border-port-border text-gray-500'
        }`}>
          {done ? <Check size={10} /> : running ? <Loader2 size={10} className="animate-spin" /> : n}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Icon size={12} className={done ? 'text-port-success' : running ? 'text-port-accent' : 'text-gray-500'} />
            <span className="text-[11px] font-medium text-gray-200">{label}</span>
            {done && <span className="text-[10px] text-port-success">{sublabel}</span>}
          </div>
          {!done && (
            <div className="text-[10px] text-gray-500 mt-0.5">{hint}</div>
          )}
          <button
            type="button"
            onClick={onClick}
            disabled={isRunning || !onClick}
            className={`mt-1.5 inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded disabled:opacity-50 ${
              primary
                ? 'bg-port-accent text-white hover:bg-port-accent/80'
                : 'border border-port-border text-gray-300 hover:bg-port-border/40'
            }`}
          >
            {running ? <Loader2 size={10} className="animate-spin" /> : null}
            {done ? 'Re-run' : running ? 'Running…' : `Run ${kind === 'script' ? 'Adapt' : kind}`}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="px-3 py-4 space-y-3">
      <div className="text-center space-y-1">
        <Clapperboard size={24} className="mx-auto text-gray-600" />
        <div className="text-[12px] text-gray-300 font-medium">No storyboard yet</div>
        <div className="text-[11px] text-gray-500 max-w-[36ch] mx-auto">
          For best results, scan your prose for characters and settings first — Adapt will reference both bibles when generating scene descriptions, keeping people and places visually consistent.
        </div>
      </div>

      <div className="space-y-1.5">
        <Step
          n={1}
          kind="characters"
          done={charDone}
          label="Extract characters"
          sublabel={`${charactersCount} found`}
          hint="Names, image-gen-ready physical descriptions, personality, role"
          onClick={onRunCharacters}
        />
        <Step
          n={2}
          kind="settings"
          done={setDone}
          label="Extract settings / world"
          sublabel={`${settingsCount} location${settingsCount === 1 ? '' : 's'}`}
          hint="Locations keyed by slugline (description, palette, era, recurring details)"
          onClick={onRunSettings}
        />
        <Step
          n={3}
          kind="script"
          done={false}
          label="Run Adapt"
          sublabel=""
          hint="Break prose into scene-by-scene storyboard. Cites the bibles above for consistency."
          onClick={onRunAdapt}
          primary
        />
      </div>

      <button
        type="button"
        onClick={onRunFullPipeline}
        disabled={isRunning || !onRunFullPipeline}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-port-accent text-white text-[11px] rounded hover:bg-port-accent/80 disabled:opacity-50"
        title="Runs all three steps sequentially: characters → settings → Adapt. Skip if you want to run them individually."
      >
        {isRunning ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
        {isRunning ? `Running ${runningKind}…` : 'Run all in order →'}
      </button>

      {(charDone || setDone) && (
        <div className="text-[10px] text-gray-500 text-center">
          Tip: edit either bible in the Work overflow menu before running Adapt.
        </div>
      )}
    </div>
  );
}

function FailedAdaptBanner({ failure, onRunAdapt, runningAdapt, onOpenSettings, hasPriorScript }) {
  const error = failure?.error || 'Adapt failed for an unknown reason';
  const isTimeout = /timed out/i.test(error);
  return (
    <div className="p-3 mb-2 border border-port-error/40 bg-port-error/5 rounded text-[11px] space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="text-port-error mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-port-error font-medium">Adapt failed</div>
          <div className="text-gray-300 break-words">{error}</div>
          {isTimeout && (
            <div className="text-gray-500 mt-1">
              Long drafts are heavy for small/light models — try a faster model
              (e.g. an API provider) via the gear icon.
            </div>
          )}
          {!hasPriorScript && (
            <div className="text-gray-500 mt-1">
              No prior storyboard to fall back to — re-running will create the first one.
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-1 px-2 py-1 border border-port-border text-gray-300 rounded text-[10px] hover:bg-port-border/40"
        >
          <SettingsIcon size={10} /> Adjust LLM
        </button>
        <button
          onClick={onRunAdapt}
          disabled={runningAdapt || !onRunAdapt}
          className="flex items-center gap-1 px-2 py-1 bg-port-error/20 border border-port-error/40 text-port-error rounded text-[10px] hover:bg-port-error/30 disabled:opacity-50"
        >
          {runningAdapt ? <Loader2 size={10} className="animate-spin" /> : <RefreshCcw size={10} />}
          Re-run Adapt
        </button>
      </div>
    </div>
  );
}

// Surfaced when the storyboard exists but one or both bibles are empty —
// Adapt's visualPrompts won't be referencing canonical descriptions, so
// the user gets visual drift across scenes. Inline run buttons let them
// fix it without leaving the panel; re-running Adapt afterwards picks up
// the populated bibles.
function BiblesMissingNotice({ charactersMissing, settingsMissing, onRunCharacters, onRunSettings, runningKind }) {
  const isRunning = !!runningKind;
  const missing = [
    charactersMissing && 'character bible',
    settingsMissing && 'setting bible',
  ].filter(Boolean);
  return (
    <div className="flex items-start gap-2 p-2 mb-1 border border-port-warning/40 bg-port-warning/5 rounded text-[11px]">
      <AlertTriangle size={12} className="text-port-warning mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-port-warning">
          Storyboard built without {missing.join(' or ')}
        </div>
        <div className="text-gray-500">
          Scene visualPrompts re-improvise descriptions every render — populating the bibles and re-running Adapt locks them in.
        </div>
        <div className="flex gap-1.5 mt-1.5">
          {charactersMissing && (
            <button
              onClick={onRunCharacters}
              disabled={isRunning || !onRunCharacters}
              className="flex items-center gap-1 px-2 py-1 border border-port-border text-gray-300 rounded text-[10px] hover:bg-port-border/40 disabled:opacity-50"
            >
              {runningKind === 'characters' ? <Loader2 size={10} className="animate-spin" /> : <Users size={10} />}
              Extract characters
            </button>
          )}
          {settingsMissing && (
            <button
              onClick={onRunSettings}
              disabled={isRunning || !onRunSettings}
              className="flex items-center gap-1 px-2 py-1 border border-port-border text-gray-300 rounded text-[10px] hover:bg-port-border/40 disabled:opacity-50"
            >
              {runningKind === 'settings' ? <Loader2 size={10} className="animate-spin" /> : <MapPinIcon size={10} />}
              Extract settings
            </button>
          )}
        </div>
      </div>
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

function styleChip(style, presets) {
  if (!style || style.presetId === STYLE_ID.NONE) return null;
  if (style.presetId === STYLE_ID.CUSTOM) return 'Custom style';
  const p = presets.find((x) => x.id === style.presetId);
  return p?.label || style.presetId;
}

// World style picker — dropdown of curated presets + Custom + None.
// Selecting a preset fills the prompt textarea; the user can edit it freely
// from there, which flips the presetId to 'custom' the moment text diverges.
// Saves are debounced into a single PATCH on blur (not per-keystroke) — the
// onChange contract is "give me the next imageStyle" not "save it now."
function WorldStyleRow({ value, presets, onChange }) {
  const [draftPrompt, setDraftPrompt] = useState(value.prompt || '');
  const [draftNeg, setDraftNeg] = useState(value.negativePrompt || '');

  // Pull the saved value down when the work id swaps (or anything else that
  // replaces the value object identity from the parent).
  useEffect(() => {
    setDraftPrompt(value.prompt || '');
    setDraftNeg(value.negativePrompt || '');
  }, [value.presetId, value.prompt, value.negativePrompt]);

  const pickPreset = (presetId) => {
    if (presetId === STYLE_ID.NONE) {
      onChange?.(EMPTY_IMAGE_STYLE);
      return;
    }
    if (presetId === STYLE_ID.CUSTOM) {
      // Keep whatever's in the textarea — just flip the discriminator.
      onChange?.({ presetId: STYLE_ID.CUSTOM, prompt: draftPrompt, negativePrompt: draftNeg });
      return;
    }
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    onChange?.({ presetId: preset.id, prompt: preset.prompt, negativePrompt: preset.negativePrompt });
  };

  const commitDraft = () => {
    if (draftPrompt === value.prompt && draftNeg === value.negativePrompt) return;
    // If the user edited a preset's text, flip to 'custom' so the dropdown
    // reflects that the prompt no longer matches the curated preset.
    const matchingPreset = presets.find((p) => p.id === value.presetId);
    const stillMatchesPreset = matchingPreset
      && matchingPreset.prompt === draftPrompt
      && matchingPreset.negativePrompt === draftNeg;
    onChange?.({
      presetId: stillMatchesPreset ? value.presetId : STYLE_ID.CUSTOM,
      prompt: draftPrompt,
      negativePrompt: draftNeg,
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-gray-500 flex items-center gap-1">
          <Palette size={10} /> World style
        </span>
        {value.presetId !== STYLE_ID.NONE && (
          <button
            type="button"
            onClick={() => pickPreset(STYLE_ID.NONE)}
            className="text-[9px] text-gray-500 hover:text-port-error"
            title="Clear style"
          >
            Clear
          </button>
        )}
      </div>
      <select
        value={value.presetId}
        onChange={(e) => pickPreset(e.target.value)}
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200"
      >
        <option value={STYLE_ID.NONE}>None — use scene visualPrompt only</option>
        <optgroup label="Presets">
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </optgroup>
        <option value={STYLE_ID.CUSTOM}>Custom</option>
      </select>
      {value.presetId !== STYLE_ID.NONE && (
        <>
          <label className="block">
            <span className="text-[9px] uppercase tracking-wider text-gray-500">
              Style prompt {value.presetId === STYLE_ID.CUSTOM && <Check size={9} className="inline text-port-accent" />}
            </span>
            <textarea
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              onBlur={commitDraft}
              rows={3}
              placeholder="cinematic still, anamorphic lens…"
              className="w-full mt-0.5 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 font-sans resize-y"
            />
          </label>
          <label className="block">
            <span className="text-[9px] uppercase tracking-wider text-gray-500">Negative prompt (optional)</span>
            <textarea
              value={draftNeg}
              onChange={(e) => setDraftNeg(e.target.value)}
              onBlur={commitDraft}
              rows={2}
              placeholder="cartoon, low quality…"
              className="w-full mt-0.5 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 font-sans resize-y"
            />
          </label>
          <div className="text-[10px] text-gray-500">
            Style is prepended to every scene's image prompt. Re-render scenes to see the change.
          </div>
        </>
      )}
    </div>
  );
}

const RES_PRESETS = [
  { label: '768×512 (3:2)',  width: 768, height: 512 },
  { label: '512×512 (1:1)',  width: 512, height: 512 },
  { label: '512×768 (2:3)',  width: 512, height: 768 },
  { label: '1024×576 (16:9)', width: 1024, height: 576 },
  { label: '1024×1024 (1:1)', width: 1024, height: 1024 },
];

function ImageGenSettingsRow({ cfg, models, onChange }) {
  const presetMatch = RES_PRESETS.find((p) => p.width === cfg.width && p.height === cfg.height);
  const currentModel = models.find((m) => m.id === cfg.modelId);
  const inputCls = 'w-full mt-0.5 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none';
  const labelCls = 'text-[9px] uppercase tracking-wider text-gray-500';
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <label className="block">
          <span className={labelCls}>Image model</span>
          <select
            value={cfg.modelId}
            onChange={(e) => onChange({ ...cfg, modelId: e.target.value })}
            className={inputCls}
          >
            {models.length === 0 && <option value={cfg.modelId}>{cfg.modelId}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name || m.id}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Resolution</span>
          <select
            value={presetMatch ? `${cfg.width}x${cfg.height}` : 'custom'}
            onChange={(e) => {
              if (e.target.value === 'custom') return;
              const [w, h] = e.target.value.split('x').map(Number);
              onChange({ ...cfg, width: w, height: h });
            }}
            className={inputCls}
          >
            {RES_PRESETS.map((p) => (
              <option key={p.label} value={`${p.width}x${p.height}`}>{p.label}</option>
            ))}
            {!presetMatch && <option value="custom">Custom ({cfg.width}×{cfg.height})</option>}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="block">
          <span className={labelCls}>
            Steps {currentModel?.steps && <span className="normal-case text-gray-600">(default {currentModel.steps})</span>}
          </span>
          <input
            type="number" min={1} max={150}
            value={cfg.steps}
            onChange={(e) => onChange({ ...cfg, steps: e.target.value })}
            placeholder={String(currentModel?.steps || 'auto')}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>Seed</span>
          <div className="flex items-stretch gap-1 mt-0.5">
            <input
              type="number"
              value={cfg.seed}
              onChange={(e) => onChange({ ...cfg, seed: e.target.value })}
              placeholder="random"
              className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200 focus:border-port-accent outline-none"
            />
            <button
              type="button"
              onClick={() => onChange({ ...cfg, seed: randomSeed() })}
              className="px-1.5 text-gray-500 hover:text-port-accent border border-port-border rounded"
              title="Randomize seed"
              aria-label="Randomize seed"
            >
              <Dice5 size={11} />
            </button>
          </div>
        </label>
      </div>
    </div>
  );
}
