import { Suspense, useCallback, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { shotSheetDrivesPrompt } from '../../../../server/lib/musicVideo/musicVideoShotSheet.js';
import { resolveSourceTake } from '../../../../server/lib/musicVideo/musicVideoSourceTake.js';
import { isPreMusicShot } from '../../../../server/lib/musicVideo/musicVideoColdOpen.js';
import { MUSIC_VIDEO_VISUAL_LAYERS, sceneHasAuthoredSpan, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { isEndFrameImageEffect } from '../../../../server/lib/musicVideo/musicVideoImageEffects.js';
import { isPerformanceScene } from '../../lib/musicVideoShotTiming.js';
import { sceneAttention, selectedFrameReadiness } from '../../lib/musicVideoSceneAttention.js';
import useSceneClipPlayback from './useSceneClipPlayback.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import TabPills from '../ui/TabPills.jsx';
import SceneFrames from './SceneFrames.jsx';
import SceneClipCoverageNotice from './SceneClipCoverageNotice.jsx';
import SceneRejectUnused from './SceneRejectUnused.jsx';
import SceneTakePicker from './SceneTakePicker.jsx';
import ShotStoryboardPanel from './ShotStoryboardPanel.jsx';
import { lastRenderTarget } from './SceneRenderTarget.jsx';
import SceneHeaderControls from './SceneHeaderControls.jsx';
import { ScenePromptField } from './ScenePromptField.jsx';
import SceneVideoTakesSection from './SceneVideoTakesSection.jsx';
import { lazyWithReload } from '../../utils/lazyWithReload.js';
import { DOWNLOAD_FIELDS, normalizeSceneCardProps } from './sceneCardProps.js';
import { buildSceneRenderPlan } from './sceneCardRenderPlan.js';

// The settings groups are the card's heaviest half and sit beside the picture, so they ship as their own
// chunk fetched with the card. The clip preview stays static: its <video> must be mounted with the card
// to deliver its metadata to this card's playback hook.
const SceneSettingsGroups = lazyWithReload(() => import('./SceneSettingsGroups.jsx'));

function SceneAboveBodyNotices({
  scene, project, layer, locked, songChange, storyboardId, storyboardShot,
  clipPlayback, showSongRevision, showSpanWarning,
  onEditLocal, applyPatch, onStoryboardBoard,
}) {
  // Chrome lays the @container body out at 0×0 when the coverage notice is inserted
  // above that body inside the same fieldset. These rows stay above the body, in
  // their own fieldset, so a locked shot still disables them.
  if (!showSongRevision && !storyboardShot && !clipPlayback.underCovered && !showSpanWarning) return null;
  const spanKind = { card: 'title card', code: 'code-drawn shot' }[layer] || 'still';
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      {showSongRevision && (
        <p className="break-words text-[11px] text-port-warning">
          {songChange.status === 'new'
            ? 'New shot for lines the revised song added.'
            : `Before the song revision: ${songChange.previousLyricText ? `♪ ${songChange.previousLyricText}` : 'instrumental'}`}
        </p>
      )}
      {/* The storyboard panel this shot is drawn from, first: shots and panels are linked 1:1. */}
      <ShotStoryboardPanel projectId={project?.id} storyboardId={storyboardId} scene={scene} linked={storyboardShot}
        onSceneUpdated={onEditLocal} onUnlink={() => applyPatch({ panelId: null, panelRev: null, panelArt: null })} onBoard={onStoryboardBoard} />
      <SceneClipCoverageNotice scene={scene} playback={clipPlayback} onChange={applyPatch} />
      {showSpanWarning && (
        <p role="alert" className="text-[11px] text-port-warning">
          Set a start and end — a {spanKind} runs for exactly its span.
        </p>
      )}
    </fieldset>
  );
}

function SceneFailureBanner({ failure, renderBlocked, videoRefusal, sourceWindow, tierChoices, generateVideo, onRetryFrame }) {
  if (!failure) return null;
  const isVideo = failure.lane === 'video';
  return (
    <div className="mt-1 flex items-start gap-2 rounded border border-port-error/40 bg-port-error/10 px-2 py-1 text-xs text-port-error">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words">
        {isVideo ? 'Video' : 'Frame'} failed: {failure.error}
      </span>
      <button type="button"
        onClick={() => {
          // #16178: repeat the failed tier; a failure with none recorded retries the cheap draft on a tiered lane.
          if (isVideo) { generateVideo(tierChoices ? failure.tier || 'draft' : null); return; }
          if (sourceWindow) return;
          onRetryFrame();
        }}
        disabled={(isVideo && renderBlocked) || (!isVideo && !!sourceWindow)}
        title={isVideo ? videoRefusal || undefined : undefined}
        className="inline-flex min-h-[44px] shrink-0 items-center px-1 font-medium underline disabled:opacity-50 pointer-fine:sm:min-h-0">
        Retry
      </button>
    </div>
  );
}

/**
 * One scene on the board: ordering/delete, the shot + reference-frame prompts
 * (optimistic local edit, PATCH on blur), the authored timeline span, and the
 * per-scene reference-frame / clip render controls.
 *
 * Accepts domain-grouped props (`scene`, `project`, `position`, `composition`,
 * `media`, `takes`, `actions`, `locked`) with legacy flat-prop compatibility via
 * `normalizeSceneCardProps`.
 */
export default function SceneCard({
  scene,
  project = null,
  position: positionProp,
  composition: compositionProp,
  media: mediaProp,
  takes: takesProp,
  actions: actionsProp,
  locked = false,
  ...legacy
}) {
  const { position, composition, media, takes, actions } = normalizeSceneCardProps({
    position: positionProp, composition: compositionProp, media: mediaProp, takes: takesProp, actions: actionsProp, ...legacy,
  });

  // Keep playback mounted even when this shot shows a still or performance evidence.
  const clipPlayback = useSceneClipPlayback(scene, project?.scenes);
  const { loops, playedSec, spanExtraSec } = clipPlayback;
  const [speakerDirty, setSpeakerDirty] = useState(false);
  const [speakerSaving, setSpeakerSaving] = useState(false);
  const [clipReferenceSaveState, setClipReferenceSaveState] = useState('saved');
  const [shotSaves, setShotSaves] = useState(0);
  const [shotMoves, setShotMoves] = useState(0);
  const [failedDownloadFields, setFailedDownloadFields] = useState(() => new Set());
  // Which slot's "Swap from unused" picker is open: 'image', 'video' or null.
  const [swapKind, setSwapKind] = useState(null);
  // Fields typed in since they last loaded: a blur saves only those, so an untouched box never writes a stale copy over a newer edit made elsewhere.
  const dirtyFields = useRef(new Set());
  const markDirty = (key) => dirtyFields.current.add(key);
  const clearDirty = (key) => dirtyFields.current.delete(key);
  const [doneSaving, setDoneSaving] = useState(false);
  const doneSavePending = useRef(false);
  const [greyboxSaving, setGreyboxSaving] = useState(false);
  // Where this shot's clip renders: the last pick made on this device, else the project's saved renderer.
  const [initialRender] = useState(() => lastRenderTarget({ performance: isPerformanceScene(scene), saved: media.falVideoSettings || {} }));
  const [renderPick, setRenderPick] = useState(initialRender.pick);
  const [renderOptions, setRenderOptions] = useState(initialRender.options);
  // The card's input toggles (SceneRenderInputs); Whole sung line also re-plans the take below.
  const [renderInputs, setRenderInputs] = useState({});
  // The Frames tab reports the image service for this shot. Retry and Clip from storyboard read it after the tab is hidden.
  const frameImageTarget = useRef(null);
  const onFrameImageTarget = useCallback((target) => { frameImageTarget.current = target; }, []);
  const withFrameTarget = (extra) => {
    const target = frameImageTarget.current;
    if (!target) return extra;
    return extra ? { ...extra, imageTarget: target } : { imageTarget: target };
  };

  const saveShot = (id, patch) => {
    const saved = actions.onSave(id, patch);
    const fields = Object.keys(patch).filter((field) => DOWNLOAD_FIELDS.has(field));
    if (!project?.id || !fields.length) return Promise.resolve(saved);
    const recordResult = (ok) => setFailedDownloadFields((current) => {
      const next = new Set(current);
      for (const field of fields) { if (ok) next.delete(field); else next.add(field); }
      return next;
    });
    if (!saved || typeof saved.then !== 'function') return Promise.resolve(saved);
    setShotSaves((n) => n + 1);
    return Promise.resolve(saved).then((result) => { recordResult(result !== false); return result; }, (err) => { recordResult(false); throw err; })
      .finally(() => setShotSaves((n) => n - 1));
  };

  const saveIfDirty = (key, patch) => {
    if (!dirtyFields.current.has(key)) return;
    dirtyFields.current.delete(key);
    saveShot(scene.sceneId, patch).then((saved) => { if (saved === false) markDirty(key); }, () => markDirty(key));
  };

  const setDone = (checked) => {
    if (locked || doneSavePending.current || !actions.onSetDone) return;
    doneSavePending.current = true;
    setDoneSaving(true);
    Promise.resolve(actions.onSetDone(scene.sceneId, checked))
      .finally(() => { doneSavePending.current = false; setDoneSaving(false); });
  };

  const applyPatch = (patch) => { actions.onEditLocal(scene.sceneId, patch); saveShot(scene.sceneId, patch).catch(() => {}); };
  // A change a route already saved (a color match's takes): shown as saved, never kept as typed text, or
  // every later reply and reload would keep this copy of the shot's takes over the server's (#16275).
  const applySaved = (patch) => (actions.onApplySaved ? actions.onApplySaved(scene.sceneId, patch) : actions.onEditLocal(scene.sceneId, patch));
  const moveCut = (move) => move && ((...args) => {
    const pending = move(...args);
    if (!pending || typeof pending.then !== 'function' || !project?.id || !clipPlayback.clipId) return pending;
    setShotMoves((n) => n + 1);
    return Promise.resolve(pending).finally(() => setShotMoves((n) => n - 1));
  });

  const layer = MUSIC_VIDEO_VISUAL_LAYERS.includes(scene.visualLayer) ? scene.visualLayer : 'footage';
  // A return plays another shot's clip. Its own frame and clip are not rendered.
  const sourceWindow = resolveSourceTake(scene, project?.scenes);
  const sourceNotice = sourceWindow ? `Plays ${sourceWindow.source?.label || 'the source shot'}'s take from ${sourceWindow.offsetSec.toFixed(2)}s` : null;
  const lead = (project?.scenes || []).filter((s) => !isPreMusicShot(s)).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .find((s) => s.videoHistoryId && sceneVisualLayer(s, { layered: composition.layered }) === 'footage');
  const leadFile = useVideoFileSrc(composition.documentComposition ? null : lead?.videoHistoryId, { geometry: true, enabled: composition.layered && layer === 'still' });
  const photoFps = composition.documentComposition ? 24 : leadFile.fps || 24;
  const fieldId = (name) => `mv-scene-${scene.sceneId}-${name}`;
  // #10297: a code shot is drawn by the composition, so it has no frame or clip to make.
  const codeShot = composition.layered && layer === 'code';
  // The shot sheet's plan for this shot, edited here or on the sheet: one record, so both stay in sync.
  const fromSheet = shotSheetDrivesPrompt(scene);

  const renderPlan = buildSceneRenderPlan({
    scene, project, layer, position, composition, media, actions,
    renderPick, renderOptions, renderInputs, sourceNotice,
    greyboxSaving, speakerDirty, speakerSaving, clipReferenceSaveState,
  });

  const generateVideo = (tier = null) => {
    if (renderPlan.renderBlocked) return;
    actions.onGenerateVideo?.(scene, renderPlan.buildVideoPayload(tier));
  };
  const generateStoryboardClip = () => {
    if (renderPlan.storyboardRefusal) return;
    const model = renderPlan.renderOverrides?.modelId || renderPlan.renderOverrides?.falModelId || renderPlan.renderOverrides?.runwayModelId;
    actions.onGenerateFrame?.(scene, withFrameTarget({
      thenClip: { ...(renderPlan.renderLane ? { backend: renderPlan.renderLane } : {}), ...(model ? { model } : {}), ...renderPlan.songAudioField },
    }));
  };
  const retryFrame = () => {
    const options = withFrameTarget(null);
    if (options) actions.onGenerateFrame?.(scene, options);
    else actions.onGenerateFrame?.(scene);
  };

  // #10152: what needs the director's attention, visible without opening the card.
  const attention = sceneAttention(scene, {
    project, layered: composition.layered, footageOptional: composition.footageOptional,
    lipSyncBackend: media.lipSyncBackend, songDurationSec: composition.songDurationSec,
    clipSec: playedSec, spanExtraSec, failed: media.failedScenes || {}, songReview: composition.songReview,
    videoSettings: media.falVideoSettings, scenes: project?.scenes, assetMarks: project?.assetMarks,
  });
  const frameReadiness = selectedFrameReadiness(sourceWindow?.source && sourceWindow.referenceImageId ? sourceWindow.source : scene, {
    assetMarks: project?.assetMarks, layered: composition.layered, ...(sourceWindow && { usesEnd: false }),
  });
  const songChange = composition.songReview?.[scene.sceneId];
  // #10154: the server-persisted failure of the last render, shown until a
  // retry is in flight (or lands a take, which clears it server-side).
  const failure = scene.lastFailure && !(scene.lastFailure.lane === 'video' ? media.generatingVideo : media.generatingFrame)
    ? scene.lastFailure : null;
  // A composed still shows its picture (the still, or the still playing its image effect) in place of a clip.
  const stillPicture = composition.layered && layer === 'still';
  const endFrameEffect = stillPicture && isEndFrameImageEffect(scene.imageEffect);
  const plainStill = stillPicture && !scene.imageEffect;
  const endFrames = Boolean(actions.onGenerateEndFrame) && (layer === 'footage' || endFrameEffect);
  // The editor shows one picture at a time: the frames, or the clip (the still stands in until it has one).
  const [view, setView] = useState(() => (scene.videoHistoryId || scene.referenceImageId || stillPicture || renderPlan.storyboardDefault ? 'clip' : 'frames'));
  const views = [['frames', endFrames ? 'Frames' : 'Still'], ['clip', stillPicture ? 'Picture' : 'Clip']];
  const moveStart = moveCut(actions.onMoveStart);
  const moveEnd = moveCut(actions.onMoveEnd);
  const showSongRevision = songChange && !songChange.resolved && songChange.status !== 'kept';
  const showSpanWarning = layer !== 'footage' && composition.layered && !sceneHasAuthoredSpan(scene);

  return (
    <div className="min-w-0">
      <section id={`scene-${scene.sceneId}`} aria-labelledby={`scene-${scene.sceneId}-title`}>
        <SceneHeaderControls
          scene={scene} project={project} posterSrc={position.posterSrc} shotName={position.shotName} fieldId={fieldId}
          frameReadiness={frameReadiness} clipPlayback={clipPlayback} attention={attention}
          locked={locked} doneSaving={doneSaving} onSetDone={actions.onSetDone} onToggleDone={setDone}
          onUndoBoardEdit={actions.onUndoBoardEdit} undoingBoard={actions.undoingBoard}
          stepShot={position.stepShot} onClose={actions.onClose}
          generatingLane={renderPlan.generatingLane} generatingFrame={media.generatingFrame}
          generatingVideo={media.generatingVideo} frameProgress={media.frameProgress} clipJobs={renderPlan.clipJobs} upscaleJobs={media.upscaleJobs}
        />
        <div className="space-y-3">
          <SceneAboveBodyNotices
            scene={scene} project={project} layer={layer} locked={locked}
            songChange={songChange} storyboardId={composition.storyboardId} storyboardShot={composition.storyboardShot}
            clipPlayback={clipPlayback} showSongRevision={showSongRevision} showSpanWarning={showSpanWarning}
            onEditLocal={actions.onEditLocal} applyPatch={applyPatch} onStoryboardBoard={actions.onStoryboardBoard}
          />
          <fieldset disabled={locked} className="min-w-0">
            {/* Two columns in a wide drawer: the picture, its takes and Render on the left, the settings groups on the right. */}
            <div className="@container">
              <div className="grid gap-3 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)] @3xl:items-start">
                <div className="min-w-0 space-y-3">
                  {(layer !== 'footage' || codeShot) && (
                    <ScenePromptField scene={scene} layer={layer} fromSheet={fromSheet} fieldId={fieldId}
                      applyPatch={applyPatch} markDirty={markDirty} clearDirty={clearDirty} saveIfDirty={saveIfDirty}
                      onEditLocal={actions.onEditLocal} onSave={actions.onSave} />
                  )}
                  {codeShot ? (
                    <p className="text-xs text-port-text-muted" data-testid="code-shot-note">
                      The composition draws this shot, so it needs no frame or clip.
                      {!composition.documentComposition && ' A composed render shows it as a black frame under the typography; render from a composition document to draw it.'}
                    </p>
                  ) : (
                    <>
                      <TabPills variant="filter" size="xs" ariaLabel="Show" tabs={views.map(([id, label]) => ({ id, label }))} activeTab={view} onChange={setView} />
                      {/* Finalize the shot: only the frames and clip in use stay candidates. */}
                      <SceneRejectUnused scene={scene} busy={takes.busy} pending={takes.pending} onReject={actions.onRejectUnusedTakes} />
                      {/* Frames: the still this shot starts from and, optionally, the one it ends on (#11173),
                          each with its prompt and Render under it, then the tapped frame's takes. */}
                      <div hidden={view !== 'frames'}>
                        <SceneFrames
                          project={project} castMedia={media.castMedia} onReloadCastMedia={actions.onReloadCastMedia}
                          greyboxPlaces={media.greyboxPlaces} greyboxSaving={greyboxSaving} onGreyboxSaving={setGreyboxSaving}
                          scene={scene} index={position.index} endFrames={endFrames || (Boolean(actions.onGenerateEndFrame) && plainStill)}
                          plainStill={plainStill} endFrameToggle={layer === 'footage' || endFrameEffect || plainStill}
                          generatingFrame={!!media.generatingFrame} generatingEndFrame={!!media.generatingEndFrame}
                          onGenerateFrame={sourceWindow ? undefined : actions.onGenerateFrame}
                          onGenerateEndFrame={sourceWindow ? undefined : actions.onGenerateEndFrame}
                          onImageTargetChange={onFrameImageTarget} onEditLocal={actions.onEditLocal} onSave={actions.onSave}
                          onOpenPreview={actions.onOpenPreview} shown={view === 'frames'} takeBusy={takes.busy} pendingTakes={takes.pending}
                          onSelectTake={actions.onSelectTake} onReviewTake={actions.onReviewTake}
                          onSwap={actions.onPlacePoolItem ? setSwapKind : null}
                          onSwapFrames={actions.onSwapFrames ? () => actions.onSwapFrames(scene) : null}
                          onImportTake={actions.onImportTake}
                          onContinueFromPrevious={layer === 'footage' && position.index > 0 ? actions.onContinueFromPrevious : null}
                          previousHasClip={position.previousHasClip}
                          assetMarks={project?.assetMarks} onMarkTake={actions.onMarkTake} onMoveTake={actions.onMoveTake}
                          onCheckTake={actions.onCheckTake} checkingTakes={takes.checking} onApplyCameos={actions.onApplyCameos}
                        />
                      </div>
                      {/* Clip: the picture and its takes, where it renders and its references, the clip prompt, then Render and other ways to get a clip. */}
                      <div hidden={view !== 'clip'}>
                        <SceneVideoTakesSection
                          scene={scene} project={project} layer={layer} stillPicture={stillPicture} photoFps={photoFps}
                          view={view} fromSheet={fromSheet} locked={locked} sourceWindow={sourceWindow}
                          clipPlayback={clipPlayback} renderPlan={renderPlan}
                          position={position} composition={composition} media={media} takes={takes} actions={actions} fieldId={fieldId}
                          renderPick={renderPick} setRenderPick={setRenderPick}
                          renderOptions={renderOptions} setRenderOptions={setRenderOptions} setRenderInputs={setRenderInputs}
                          clipReferenceSaveState={clipReferenceSaveState} setClipReferenceSaveState={setClipReferenceSaveState}
                          setSpeakerDirty={setSpeakerDirty} setSpeakerSaving={setSpeakerSaving}
                          shotSaves={shotSaves} shotMoves={shotMoves} failedDownloadFields={failedDownloadFields}
                          applyPatch={applyPatch} markDirty={markDirty} clearDirty={clearDirty} saveIfDirty={saveIfDirty} saveShot={saveShot}
                          generateVideo={generateVideo} generateStoryboardClip={generateStoryboardClip}
                          withFrameTarget={withFrameTarget} setSwapKind={setSwapKind}
                        />
                      </div>
                    </>
                  )}
                </div>
                <Suspense fallback={<p className="text-xs text-port-text-muted">Loading shot settings…</p>}><SceneSettingsGroups
                  scene={scene} project={project} layer={layer} codeShot={codeShot} fromSheet={fromSheet} loops={loops}
                  sourceWindow={sourceWindow} renderPlan={renderPlan}
                  position={position} composition={composition} actions={actions} fieldId={fieldId}
                  applyPatch={applyPatch} applySaved={applySaved} markDirty={markDirty} saveIfDirty={saveIfDirty} saveShot={saveShot}
                  moveStart={moveStart} moveEnd={moveEnd}
                  setSpeakerDirty={setSpeakerDirty} setSpeakerSaving={setSpeakerSaving}
                /></Suspense>
              </div>
            </div>
          </fieldset>
        </div>
        {swapKind && (
          <SceneTakePicker open onClose={() => setSwapKind(null)} projectId={composition.projectId} scene={scene} kind={swapKind}
            shotNumbers={composition.shotNumbers} busy={takes.busy} onPlace={(pick) => actions.onPlacePoolItem?.(scene, pick)}
            onMarked={(result) => actions.onPoolMarked?.(composition.projectId, result)} />
        )}
      </section>
      <SceneFailureBanner
        failure={failure} renderBlocked={renderPlan.renderBlocked} videoRefusal={renderPlan.videoRefusal}
        sourceWindow={sourceWindow} tierChoices={renderPlan.tierChoices}
        generateVideo={generateVideo} onRetryFrame={retryFrame}
      />
    </div>
  );
}
