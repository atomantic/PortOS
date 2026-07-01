import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Clapperboard, Loader2, Users, MapPin as MapPinIcon,
  ListTree, SlidersHorizontal, Package,
} from 'lucide-react';
import toast from '../ui/Toast';
import {
  listWritersRoomAnalyses,
  getWritersRoomAnalysis,
} from '../../services/apiWritersRoom';
import { getSettings, patchSettingsSlice, listImageStylePresets } from '../../services/apiSystem';
import { listImageModels } from '../../services/apiImageVideo';
import { deriveAvailableBackends } from '../../lib/imageGenBackends';
import useMounted from '../../hooks/useMounted';
import Drawer from '../Drawer';
import TabPills from '../ui/TabPills';
import { ImageGenTab } from '../settings/ImageGenTab';
import StoryboardBibleTab from './StoryboardBibleTab';
import StoryboardScenesTab from './StoryboardScenesTab';
import StoryboardBoardsTab from './StoryboardBoardsTab';
import StoryboardConfigTab from './StoryboardConfigTab';
import { WR_IMAGE_DEFAULTS, readWrImageSettings, EMPTY_IMAGE_STYLE } from '../../lib/wrImageDefaults';
import { buildCharByKey, buildPlaceByKey } from '../../lib/scenePrompt';

export const STORYBOARD_TAB = {
  CHARACTERS: 'characters',
  WORLD: 'world',
  OBJECTS: 'objects',
  SCENES: 'scenes',
  BOARDS: 'boards',
  CONFIG: 'config',
};
const TAB = STORYBOARD_TAB;
export const STORYBOARD_TAB_VALUES = Object.values(TAB);

const RUN_LABEL = {
  characters: 'Refreshing characters',
  places: 'Refreshing world',
  objects: 'Refreshing objects',
  script: 'Running Adapt',
  evaluate: 'Editorial pass',
  format: 'Format pass',
};

export default function StoryboardPanel({
  work,
  characters = [],
  places = [],
  onJumpToScene,
  onDebug,
  onRunAdapt,
  onRunCharacters,
  onRunPlaces,
  onRunFullPipeline,
  runningAdapt = false,
  runningKind = null,
  readingTheme = 'dark',
  activeSceneId = null,
  onStyleChange,
  onCharactersChange,
  onPlacesChange,
  onScenesChange,
  onLiveRenderContextChange,
  registerSceneImageMerge,
  objects = [],
  onObjectsChange,
  onRunObjects,
  hotRef = null,
  onSceneHover,
  onSceneRenderStart,
  tab,
  onTabChange,
}) {
  const setTab = onTabChange;
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsOpen = searchParams.get('settings') === 'imagegen';
  const openImageGenSettings = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('settings', 'imagegen');
      return next;
    });
  }, [setSearchParams]);
  const closeImageGenSettings = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('settings');
      return next;
    });
  }, [setSearchParams]);
  const [latestScript, setLatestScript] = useState(null);
  const [latestFailure, setLatestFailure] = useState(null);
  const [loading, setLoading] = useState(false);
  const [imageCfg, setImageCfg] = useState(WR_IMAGE_DEFAULTS);
  const [models, setModels] = useState([]);
  const [stylePresets, setStylePresets] = useState([]);
  const [sysSettings, setSysSettings] = useState(null);
  const mountedRef = useMounted();
  // All three backends emit started/progress/completed via imageGenEvents →
  // socket.io, so the storyboard supports Local, Codex, and External SD-API.
  const availableBackends = useMemo(
    () => deriveAvailableBackends(sysSettings),
    [sysSettings],
  );

  const imageStyle = work.imageStyle || EMPTY_IMAGE_STYLE;
  const activeDraft = (work.drafts || []).find((d) => d.id === work.activeDraftVersionId);

  const applyFreshSettings = useCallback((s) => {
    setSysSettings(s);
    setImageCfg(readWrImageSettings(s, deriveAvailableBackends(s)));
  }, []);

  // Re-runnable so the Settings drawer can refresh availableBackends/imageCfg
  // when it closes — without this, enabling Codex in the drawer wouldn't
  // surface the chip until the user reloaded the page.
  const reloadSysSettings = useCallback(async () => {
    const s = await getSettings().catch(() => ({}));
    if (!mountedRef.current) return;
    applyFreshSettings(s);
  }, [mountedRef, applyFreshSettings]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSettings().catch(() => ({})),
      listImageModels().catch(() => []),
      listImageStylePresets().catch(() => []),
    ]).then(([s, modelList, presets]) => {
      if (cancelled) return;
      applyFreshSettings(s);
      setModels(Array.isArray(modelList) ? modelList : []);
      setStylePresets(Array.isArray(presets) ? presets : []);
    });
    return () => { cancelled = true; };
  }, [applyFreshSettings]);

  // When the user closes the Image Gen settings drawer, settings may have
  // changed (e.g. they enabled Codex) — reload so the chip strip reflects
  // the new state without a page refresh. Mirrors the pattern in ImageGen.jsx.
  const wasSettingsOpenRef = useRef(false);
  useEffect(() => {
    if (wasSettingsOpenRef.current && !settingsOpen) {
      reloadSysSettings();
    }
    wasSettingsOpenRef.current = settingsOpen;
  }, [settingsOpen, reloadSysSettings]);

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
        const h = sceneRefs.current[sceneId];
        if (h?.canGenerate?.()) {
          h.generate();
          queued += 1;
        }
      }
      if (queued > 0) toast.success(`Queued ${queued} scene render${queued === 1 ? '' : 's'}`);
    });
    return () => cancelAnimationFrame(handle);
  }, [latestScript]);

  // refresh-characters/settings stay on whichever tab the user is on (they
  // have their own per-tab spinner); only Adapt yanks them to Boards so the
  // newly-built storyboard is what they see when it finishes.
  useEffect(() => {
    if (runningKind === 'script') setTab(TAB.BOARDS);
    // setTab intentionally omitted — caller may not memoize it, and the
    // effect should only fire on runningKind transitions.
  }, [runningKind]);

  const persistCfg = useCallback(async (next) => {
    setImageCfg(next);
    await patchSettingsSlice('writersRoom', { imageGen: next }, { silent: true })
      .catch((err) => toast.error(`Settings save failed: ${err.message}`));
  }, []);

  const charByKey = useMemo(() => buildCharByKey(characters), [characters]);
  const placeByKey = useMemo(() => buildPlaceByKey(places), [places]);
  const scenesCount = useMemo(
    () => (activeDraft?.segmentIndex || []).filter((s) => s.kind === 'scene').length,
    [activeDraft?.segmentIndex]
  );
  const activeHash = activeDraft?.contentHash || null;
  const isStale = !!latestScript?.sourceContentHash && !!activeHash && latestScript.sourceContentHash !== activeHash;
  const scenes = latestScript?.result?.scenes || [];
  const sceneImages = latestScript?.sceneImages || {};

  // Surface the scene list up to WorkEditor (for ProseReader anchors). Fires
  // every time latestScript changes, including the initial null load.
  useEffect(() => {
    onScenesChange?.(scenes);
    // We intentionally key on latestScript identity rather than scenes (which
    // is recreated each render) — array identity changes coincide with the
    // analysis snapshot changing.
  }, [latestScript]);

  // Surface everything the Phase 5 live render preview needs to render the
  // scene under the cursor: the scenes + their owning analysis id (for the
  // scene-image attach), the bible lookup maps, and the active image config /
  // world style. The panel reuses SceneCard's exact prompt + render path, so it
  // needs the same inputs. Keyed on the analysis snapshot identity (scenes /
  // charByKey / placeByKey are all derived from it or from the bible props).
  useEffect(() => {
    onLiveRenderContextChange?.({
      analysisId: latestScript?.id || null,
      scenes,
      charByKey,
      placeByKey,
      imageCfg,
      imageStyle,
    });
  }, [latestScript, charByKey, placeByKey, imageCfg, imageStyle]);

  // Expose an imperative "merge a freshly-attached sceneImages map" up to
  // WorkEditor so the live render preview's completion updates the boards
  // reactively (no refetch) — only when the attach targeted the analysis we're
  // currently showing (a stale attach against a since-replaced analysis is
  // dropped). The merged-in snapshot supersedes the prior sceneImages.
  useEffect(() => {
    if (!registerSceneImageMerge) return undefined;
    registerSceneImageMerge((analysis) => {
      if (!analysis?.id || !analysis.sceneImages) return;
      setLatestScript((prev) => (
        prev && prev.id === analysis.id
          ? { ...prev, sceneImages: { ...prev.sceneImages, ...analysis.sceneImages } }
          : prev
      ));
    });
    return () => registerSceneImageMerge(null);
  }, [registerSceneImageMerge]);

  return (
    <div className="flex flex-col h-full">
      <TabPills
        size="xs"
        stretch
        activeTab={tab}
        onChange={setTab}
        runningKind={runningKind}
        tabs={[
          { id: TAB.CHARACTERS, label: 'Characters', icon: Users, count: characters.length, runningKind: 'characters' },
          { id: TAB.WORLD, label: 'World', icon: MapPinIcon, count: places.length, runningKind: 'places' },
          { id: TAB.OBJECTS, label: 'Objects', icon: Package, count: objects.length, runningKind: 'objects' },
          { id: TAB.SCENES, label: 'Scenes', icon: ListTree, count: scenesCount },
          { id: TAB.BOARDS, label: 'Boards', icon: Clapperboard, count: scenes.length, runningKind: 'script' },
          { id: TAB.CONFIG, label: 'Config', icon: SlidersHorizontal },
        ]}
      />

      {runningKind && (
        <div className="px-3 py-1.5 border-b border-port-border bg-port-accent/10 text-[11px] text-port-accent flex items-center gap-2 shrink-0">
          <Loader2 size={11} className="animate-spin" />
          <span>{RUN_LABEL[runningKind] || runningKind}…</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {tab === TAB.CHARACTERS && (
          <StoryboardBibleTab
            kind="characters"
            workId={work.id}
            items={characters}
            onItemsChange={onCharactersChange}
            onRefresh={onRunCharacters}
            running={runningKind === 'characters'}
            anyRunning={!!runningKind}
            readingTheme={readingTheme}
            hotRefId={hotRef?.kind === 'char' ? hotRef.refId : null}
          />
        )}
        {tab === TAB.WORLD && (
          <StoryboardBibleTab
            kind="world"
            workId={work.id}
            items={places}
            onItemsChange={onPlacesChange}
            onRefresh={onRunPlaces}
            running={runningKind === 'places'}
            anyRunning={!!runningKind}
            readingTheme={readingTheme}
            hotRefId={hotRef?.kind === 'place' ? hotRef.refId : null}
          />
        )}
        {tab === TAB.OBJECTS && (
          <StoryboardBibleTab
            kind="objects"
            workId={work.id}
            items={objects}
            onItemsChange={onObjectsChange}
            onRefresh={onRunObjects}
            running={runningKind === 'objects'}
            anyRunning={!!runningKind}
            readingTheme={readingTheme}
            hotRefId={hotRef?.kind === 'object' ? hotRef.refId : null}
          />
        )}
        {tab === TAB.SCENES && (
          <StoryboardScenesTab activeDraft={activeDraft} onJumpToScene={onJumpToScene} />
        )}
        {tab === TAB.BOARDS && (
          <StoryboardBoardsTab
            work={work}
            scenes={scenes}
            sceneImages={sceneImages}
            latestScript={latestScript}
            latestFailure={latestFailure}
            loading={loading}
            isStale={isStale}
            imageCfg={imageCfg}
            imageStyle={imageStyle}
            stylePresets={stylePresets}
            charByKey={charByKey}
            placeByKey={placeByKey}
            charactersCount={characters.length}
            placesCount={places.length}
            sceneRefs={sceneRefs}
            onJumpToScene={onJumpToScene}
            onDebug={onDebug}
            onRunAdapt={onRunAdapt}
            onRunCharacters={onRunCharacters}
            onRunPlaces={onRunPlaces}
            onRunFullPipeline={onRunFullPipeline}
            runningAdapt={runningAdapt}
            runningKind={runningKind}
            readingTheme={readingTheme}
            activeSceneId={activeSceneId}
            onOpenConfig={() => setTab(TAB.CONFIG)}
            hotRef={hotRef}
            onSceneHover={onSceneHover}
            onSceneRenderStart={onSceneRenderStart}
          />
        )}
        {tab === TAB.CONFIG && (
          <StoryboardConfigTab
            imageCfg={imageCfg}
            models={models}
            availableBackends={availableBackends}
            onCfgChange={persistCfg}
            stylePresets={stylePresets}
            imageStyle={imageStyle}
            onStyleChange={onStyleChange}
            onOpenImageGenSettings={openImageGenSettings}
          />
        )}
      </div>

      <Drawer open={settingsOpen} onClose={closeImageGenSettings} title="Image Gen Settings" size="lg">
        <ImageGenTab />
      </Drawer>
    </div>
  );
}
