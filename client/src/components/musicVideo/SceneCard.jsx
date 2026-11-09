import { musicVideoGreyboxReference } from '../../../../server/lib/musicVideoGreybox.js';
import PlateComparison from './PlateComparison.jsx';
import ShotActionInspector from './ShotActionInspector.jsx';
import SceneCameraControls from './SceneCameraControls.jsx';
import SceneStartFrame from './SceneStartFrame.jsx';
import SceneClipLength from './SceneClipLength.jsx';
import SceneClipTiming from './SceneClipTiming.jsx';
import SceneRejectUnused from './SceneRejectUnused.jsx';
import ShotFinalRender from './ShotFinalRender.jsx';
import ShotColorMatch from './ShotColorMatch.jsx';
import ShotFilmLook from './ShotFilmLook.jsx';
import ShotStoryboardPanel from './ShotStoryboardPanel.jsx';
import ShotEditorGroup from './ShotEditorGroup.jsx';
import ShotSheetFields from './ShotSheetFields.jsx';
import { normalizeShotSheet, shotSheetDrivesPrompt, shotSheetPromptLines } from '../../../../server/lib/musicVideoShotSheet.js';
import TabPills from '../ui/TabPills.jsx';
import AutoSizeTextarea from '../ui/AutoSizeTextarea.jsx';
import InfoTooltip from '../ui/InfoTooltip';
import { LTX_REFERENCES_GENERATION_MODE, isLtx25Model, ltxReferenceSheetPrefix, ltxReferencesUnavailableReason } from '../../lib/musicVideoLtxReferences.js';
import SceneStoryboardClip, { storyboardClipOffered } from './SceneStoryboardClip.jsx';
import { MUSIC_VIDEO_MEDIUM_LABELS } from '../../../../server/lib/musicVideoMediumPlan.js';
import { storyboardShotDirection } from '../../../../server/lib/musicVideoShotPrompt.js';
import { useCallback, useRef, useState } from 'react';
import { Trash2, Activity, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, X, Video, AlertTriangle, Clapperboard, Shuffle } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import SceneTakePicker from './SceneTakePicker.jsx';
import { formatTimecode } from '../../utils/formatters.js';
import useSceneClipPlayback from '../../hooks/useSceneClipPlayback.js';
import SceneClipPreview from './SceneClipPreview.jsx';
import SceneClipCoverageNotice from './SceneClipCoverageNotice.jsx';
import PerformanceEvidence from './PerformanceEvidence.jsx';
import { grokSceneRequestDuration, isPerformanceScene, planPerformanceRepair } from '../../lib/musicVideoShotTiming.js';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import { sceneEndFramePlanFor } from './SceneEndFrame.jsx';
import SceneFrames from './SceneFrames.jsx';
import SceneClipReferences from './SceneClipReferences.jsx';
import { musicVideoClipConditioningReferences, musicVideoClipReferenceCapacity, musicVideoClipReferenceChoices, musicVideoSceneCastIds } from '../../../../server/lib/musicVideoConditioning.js';
import { getFalVideoModel } from '../../lib/falVideoModels.js';
import { getRunwayVideoModel } from '../../lib/runwayVideoModels.js';
import { falSceneTake, runwaySceneTake } from '../../lib/musicVideoShotTiming.js';
import { CLIP_TIMING_FPS, MUSIC_VIDEO_VISUAL_LAYERS, clipReversed, composedDrawsLyrics, sceneHasAuthoredSpan, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import CastGuidesRetry from './CastGuidesRetry.jsx';

// #8985: what a composed render shows for this scene's span.
const LAYER_LABELS = { footage: 'Footage', still: 'Still image', card: 'Title card', code: 'Code-drawn' };
const STILL_MOVE_LABELS = [['hold', 'Hold'], ['push', 'Push in'], ['pan', 'Pan']];
// #10583: the shared lyric type's zone and style for this shot (composition documents).
const SHOT_MODE_LABELS = { cutaway: 'Cutaway', performance: 'Performance (lip-sync)', music: 'Performance (music-driven)' };
const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0 whitespace-nowrap';
const SECONDARY_BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0 whitespace-nowrap';
import { buildSceneTimingPresentation } from '../../lib/musicVideoSceneTiming.js';
import SceneTimingPlan from './SceneTimingPlan.jsx';
import SceneShotCuts, { SceneCutField, SceneDuration } from './SceneShotCuts.jsx';
import SceneRenderProgress from './SceneRenderProgress.jsx';
import { SCENE_ATTENTION_LABELS, sceneAttention, selectedFrameReadiness } from '../../lib/musicVideoSceneAttention.js';
import ScenePoster from './ScenePoster.jsx';
import SceneRenderTarget, { lastRenderTarget, renderTargetOverrides } from './SceneRenderTarget.jsx';
import SceneRenderInputs, { shotCardRenderRequest, shotCardRequestProblem } from './SceneRenderInputs.jsx';
import { isLowResVideo } from '../../lib/videoResolution.js';
import SceneSequenceCoverage from './SceneSequenceCoverage.jsx';
import SceneFrameFit from './SceneFrameFit.jsx';
import SceneCutEffect from './SceneCutEffect.jsx';
import { plannedTransitions } from '../../lib/musicVideoCutEffects.js';
import { shotEffectLabel, shotEffects } from '../../lib/musicVideoShotEffects.js';
import SceneGlitches from './SceneGlitches.jsx';
import { PreMusicSound, PreMusicTiming } from './ScenePreMusic.jsx';
import { isPreMusicShot, normalizePreMusic, preMusicSoundSummary } from '../../../../server/lib/musicVideoColdOpen.js';
import { sceneShotName } from '../../lib/musicVideoStages.js';
import SceneLyricType from './SceneLyricType.jsx';
import SceneTransitions from './SceneTransitions.jsx';
import SceneImageEffect from './SceneImageEffect.jsx';
import ScenePicturePreview from './ScenePicturePreview.jsx';
import { isEndFrameImageEffect } from '../../lib/musicVideoImageEffects.js';

// The two timeline-bound scene fields rendered as identical number inputs.
const SCENE_TIME_FIELDS = [['Start', 'startSec'], ['End', 'endSec']];
// A time as a frame of the 24 fps cut grid, the numbers the director counts in.
const frameAt = (sec) => Math.round(sec * CLIP_TIMING_FPS);
const frameSpan = (scene) => `fr ${frameAt(scene.startSec)}–${frameAt(scene.endSec)}`;

/**
 * One scene on the board: ordering/delete, the shot + reference-frame prompts
 * (optimistic local edit, PATCH on blur), the authored timeline span, and the
 * per-scene reference-frame / clip render controls.
 *
 * `onOpenPreview(key)` opens the page-level MediaLightbox for a frame
 * (`image:<filename>`) or clip (`video:<historyId>`). The frame thumb is the
 * whole button; the clip keeps native play/pause and uses a corner expand
 * control so the open handler never fights the player.
 *
 * Each slot's takes (#8965) render as a review strip under it: a regenerate
 * adds a candidate rather than replacing the selection, and the director picks,
 * rejects, or notes takes there. `onImportTake` adds an externally generated
 * frame (gallery pick or upload) as a take; `onImportClipTake` (#8978) does the
 * same for an existing gallery clip.
 *
 * The layer picker (#8985) chooses what a composed render (`layered`) shows
 * for the scene's span: its footage, its selected frame with a camera move, a
 * title card, or a code shot the composition draws (#10297; no frame or clip
 * controls — and, unless `documentComposition`, a note that a composed render
 * shows it as a black frame). A plain render always plays footage, and says so.
 * The shot mode (#8977) picks Cutaway (any image-to-video lane) or Performance
 * (a singer lip-synced to the master recording). `lipSyncBackend` is the lane a
 * render would use ('' = install default); a performance shot on a lane without
 * verified source-audio conditioning is blocked here with the reason, and a
 * capable one names the provider, model, song window and cost before the
 * director spends anything. `songDurationSec` bounds the planned window.
 * `falVideoSettings` (the project's saved render pins) prices a fal take with
 * `falSceneTake` — the same answer the submit payload is built from — so the
 * card shows each take's estimated cost before it is paid for.
 * A shot longer than that lane renders in one take (the lip-sync audio window,
 * or Grok's longest clip) offers `onSplit(sceneId, backend)`, which cuts it
 * into contiguous scenes at lyric pauses / phrase boundaries server-side.
 * Any scene but the last offers `onMergeNext(sceneId, backend)` (with `nextEndSec`, the next scene's end), the inverse,
 * and any but the first `onMergePrevious(sceneId, backend)` (with `prevStartSec`), which keeps this shot and removes the
 * one before; each is hidden when the joined span would exceed that lane's longest take.
 *
 * It fills the shot drawer: a sticky header (frame thumbnail, title, timing,
 * lyric line, status, previous / next shot and `onClose`) sits outside the
 * `locked` fieldset so navigation always works; under it the linked storyboard panel, then
 * one picture at a time behind a Still / Clip switch (the still stands in for a
 * clip not made yet), each with its takes, its make / "Swap from unused" /
 * import buttons and its prompt. Swap from unused
 * (`onPlacePoolItem(scene, { kind, assetId, withAssetId? })`) opens
 * SceneTakePicker over the project's unused stills or clips. The
 * settings sit in ShotEditorGroup groups (Timing, Sound, Transitions & effects,
 * Lyrics, Shot type, Direction), each header naming what is set: beside the
 * picture in a wide drawer and open there, stacked and closed on a phone.
 * Move earlier / later and Delete shot sit in the Timing group.
 */
// #11040: the one owner of whether a video render may start. The server reloads
// the persisted scene (and its speaker), so an unsaved or failed speaker edit
// must hold back every video entry point — Generate video and the failure Retry.
// Returns the refusal reason, or null when the render may go ahead.
// A clip from the storyboard panel (`needsStill: false`) makes its own first frame.
// Where the shot sits in the cut: move it a slot earlier or later (the song timing and
// lyric stay with the slot), or delete it after a confirm.
function SceneOrderActions({ index, isLast, manifestOwnsShots, onMove, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {onMove && (
          <>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => onMove(index, -1)} disabled={index === 0 || manifestOwnsShots}>
              <ArrowUp size={12} aria-hidden="true" /> Move earlier
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => onMove(index, 1)} disabled={isLast || manifestOwnsShots}>
              <ArrowDown size={12} aria-hidden="true" /> Move later
            </button>
          </>
        )}
        {onDelete && (confirming ? (
          <ConfirmButtonPair prompt="Delete this shot?" confirmText="Delete shot" confirmIcon={Trash2} className="ml-auto"
            onConfirm={() => { setConfirming(false); onDelete(); }} onCancel={() => setConfirming(false)} responsiveTouchTargets />
        ) : (
          <button type="button" onClick={() => setConfirming(true)}
            className="ml-auto flex min-h-[44px] items-center gap-1 rounded px-2 py-1.5 text-xs text-port-error hover:bg-port-error/15 pointer-fine:sm:min-h-0">
            <Trash2 size={12} aria-hidden="true" /> Delete shot
          </button>
        ))}
      </div>
      {manifestOwnsShots && (
        <p className="text-[11px] text-port-text-muted">Shot order comes from the composition document, so it can&apos;t be reordered here.</p>
      )}
    </div>
  );
}

// A clip already rendering never blocks another (#15128): a shot can render locally and on grok at once.
function videoGenerationRefusal({ settingsSaving, speakerUnsaved, referenceImageId, videoBlockedReason, performanceBlocked, needsStill = true }) {
  if (videoBlockedReason) return videoBlockedReason;
  if (performanceBlocked) return performanceBlocked;
  if (speakerUnsaved) return 'Save the speaker / singer edit first';
  if (settingsSaving) return 'Saving settings…';
  if (needsStill && !referenceImageId) return 'Generate a reference frame first';
  return null;
}

export default function SceneCard({
  scene, index, shotName = null, isLast, generatingFrame, generatingVideo, frameProgress = null, videoProgress = null, videoJobs = null,
  settingsSaving, videoBlockedReason, videoBlockedReasonFor = null, canContinueShot,
  onMove, onDelete, onEditLocal, onSave,
  project = null, castMedia = null, onReloadCastMedia = null, greyboxPlaces = {}, onGenerateFrame, onGenerateVideo, onContinueVideo, onGenerateEndFrame, generatingEndFrame = false, onContinueFromPrevious, previousHasClip = false,
  onOpenPreview, onSelectTake, onReviewTake, onRejectUnusedTakes = null, onSwapFrames = null, onMarkTake = null, onCheckTake = null, checkingTakes = null, onPoolMarked = null, onImportTake, onImportClipTake, onPlacePoolItem, onTrimClip, projectId = null, aspect = '16:9', videoModels = [], defaultVideoModel = '', shotNumbers = undefined, takeBusy = false, layered = false, documentComposition = false, manifestOwnsShots = false,
  lipSyncBackend = '', songDurationSec = null, onSplit, onMergeNext, onMergePrevious = null, prevStartSec = null, onMoveStart = null, onMoveEnd = null, nextEndSec = null, falVideoSettings = null, performanceReview = null, onRepairPerformance, repairBusy = false,
  onClose = null, locked = false, stepShot = null, footageOptional = false, failedScenes = null, songReview = null,
  storyboardId = null, storyboardShot = null, onStoryboardBoard = null, onApplyCameos = null, onVaryWipes = null,
}) {
  // Keep playback mounted even when this shot shows a still or performance evidence.
  const clipPlayback = useSceneClipPlayback(scene, project?.scenes);
  const { clipSrc, clipSec, clipSize, loops, playedSec, spanExtraSec } = clipPlayback;
  const [speakerDirty, setSpeakerDirty] = useState(false);
  const [speakerSaving, setSpeakerSaving] = useState(false);
  const [clipReferenceSaveState, setClipReferenceSaveState] = useState('saved');
  // Which slot's "Swap from unused" picker is open: 'image', 'video' or null.
  const [swapKind, setSwapKind] = useState(null);
  // Fields typed in since they last loaded: a blur saves only those, so an untouched box never writes a stale copy over a newer edit made elsewhere.
  const dirtyFields = useRef(new Set());
  const markDirty = (key) => dirtyFields.current.add(key);
  const saveIfDirty = (key, patch) => {
    if (!dirtyFields.current.has(key)) return;
    dirtyFields.current.delete(key);
    Promise.resolve(onSave(scene.sceneId, patch)).then((saved) => { if (saved === false) markDirty(key); }, () => markDirty(key));
  };
  const applyPatch = (patch) => { onEditLocal(scene.sceneId, patch); onSave(scene.sceneId, patch); };
  const layer = MUSIC_VIDEO_VISUAL_LAYERS.includes(scene.visualLayer) ? scene.visualLayer : 'footage';
  const lead = (project?.scenes || []).filter(s => !isPreMusicShot(s)).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .find(s => s.videoHistoryId && sceneVisualLayer(s, { layered }) === 'footage');
  const leadFile = useVideoFileSrc(documentComposition ? null : lead?.videoHistoryId, { geometry: true, enabled: layered && layer === 'still' });
  const photoFps = documentComposition ? 24 : leadFile.fps || 24;
  const fieldId = (name) => `mv-scene-${scene.sceneId}-${name}`;
  // #10297: a code shot is drawn by the composition, so it has no frame or clip to make.
  const codeShot = layered && layer === 'code';
  // The shot sheet's plan for this shot, edited here or on the sheet: one record, so both stay in sync.
  const fromSheet = shotSheetDrivesPrompt(scene);
  // Where this shot's clip renders: the last pick made on this device, else the project's saved renderer.
  const [initialRender] = useState(() => lastRenderTarget({ performance: isPerformanceScene(scene), saved: falVideoSettings || {} }));
  const [renderPick, setRenderPick] = useState(initialRender.pick);
  const [renderOptions, setRenderOptions] = useState(initialRender.options);
  // The Frames tab reports the image service for this shot. Retry and Clip from storyboard read it after the tab is hidden.
  const frameImageTarget = useRef(null);
  const onFrameImageTarget = useCallback((target) => { frameImageTarget.current = target; }, []);
  const withFrameTarget = (extra) => {
    const target = frameImageTarget.current;
    if (!target) return extra;
    return extra ? { ...extra, imageTarget: target } : { imageTarget: target };
  };
  const renderOverrides = renderTargetOverrides(renderPick, falVideoSettings || {}, renderOptions,
    { models: videoModels, defaultModel: defaultVideoModel, performance: isPerformanceScene(scene), scene });
  const renderSettings = renderOverrides ? { ...falVideoSettings, ...renderOverrides } : falVideoSettings;
  // The card's input toggles (SceneRenderInputs); Whole sung line also re-plans the take below.
  const [renderInputs, setRenderInputs] = useState({});
  const [greyboxSaving, setGreyboxSaving] = useState(false);
  const greybox = musicVideoGreyboxReference(project, scene, greyboxPlaces);
  const renderLane = renderOverrides
    ? (renderSettings.backend === 'local' && renderSettings.generationMode === 'audioReactive' ? 'local' : renderSettings.backend)
    : lipSyncBackend;
  const timing = buildSceneTimingPresentation({
    scene, layer, lipSyncBackend: renderLane, songDurationSec, falVideoSettings: renderSettings,
    nextEndSec, isLast, manifestOwnsShots, hasMergeNext: !!onMergeNext,
    prevStartSec, isFirst: index === 0, hasMergePrevious: !!onMergePrevious,
    lineCues: isPerformanceScene(scene) && renderInputs.wholeLine === true ? project?.lyricCues || [] : null,
  });
  const { performance, capability, performanceBlocked, performanceCost } = timing;
  const instruction = scene.takes?.find((take) => take.kind === 'video' && take.assetId === scene.videoHistoryId)?.shotInstruction;
  const repairPlan = planPerformanceRepair({ scene, temporal: performanceReview?.shot,
    excerptStartSec: performanceReview?.excerptStartSec, backend: lipSyncBackend, videoSettings: falVideoSettings || {} });
  const shotModeId = `mv-shot-mode-${scene.sceneId}`;
  // #10152: what needs the director's attention, visible without opening the card.
  const attention = sceneAttention(scene, { layered, footageOptional, lipSyncBackend, songDurationSec, clipSec: playedSec, spanExtraSec, failed: failedScenes || {}, songReview, videoSettings: falVideoSettings });
  const frameReadiness = selectedFrameReadiness(scene);
  const songChange = songReview?.[scene.sceneId];
  // Every clip in flight for this shot, each with where it renders. A render whose
  // request is still on its way has no job yet: Render waits for it, so a double tap
  // can't send the same (possibly paid) render twice.
  const clipJobs = Array.isArray(videoJobs) ? videoJobs : generatingVideo ? [{ key: 'clip', label: null, running: !!videoProgress, progress: videoProgress?.progress ?? null }] : [];
  const sendingClip = clipJobs.some((job) => job.key !== 'clip' && !job.jobId);
  const clipLane = clipJobs.length > 1 ? `${clipJobs.length} clips` : 'Clip';
  const generatingLane = generatingFrame && generatingVideo ? `Frame + ${clipLane.toLowerCase()}` : generatingFrame ? 'Frame' : generatingVideo ? clipLane : null;
  // #10154: the server-persisted failure of the last render, shown until a
  // retry is in flight (or lands a take, which clears it server-side).
  const failure = scene.lastFailure && !(scene.lastFailure.lane === 'video' ? generatingVideo : generatingFrame)
    ? scene.lastFailure : null;
  const endFramePlan = sceneEndFramePlanFor(scene, renderSettings || {}, { models: videoModels, defaultModel: defaultVideoModel });
  const peerPool = ['both', 'peers'].includes(renderSettings?.renderPool?.mode);
  const referenceBackend = peerPool ? 'remote' : renderSettings?.backend || renderLane;
  const referenceModel = referenceBackend === 'fal'
    ? getFalVideoModel(falSceneTake({ scene, videoSettings: renderSettings || {} }).modelId)
    : referenceBackend === 'runway' ? getRunwayVideoModel(runwaySceneTake({ scene, videoSettings: renderSettings || {} }).modelId)
      : referenceBackend === 'local' ? videoModels.find((model) => model.id === (renderSettings?.modelId || defaultVideoModel)) : null;
  // Storyboard-to-clip chaining cannot yet pass LTX reference inputs. Offer
  // them after the storyboard's first frame has landed instead.
  const storyboardDefault = storyboardClipOffered({ scene, layer, performance });
  const ltxReferencesAvailable = !performance && referenceBackend === 'local' && isLtx25Model(referenceModel)
    && renderSettings?.generationMode !== 'audioReactive';
  const canUseLtxReferences = ltxReferencesAvailable && !storyboardDefault;
  const ltxReferencesGreyboxBlocked = !!scene.setReference?.greyboxShotId;
  // The project's LTX 2.5 References mode makes the box default on; unticking is this shot's override.
  const ltxReferencesProjectDefault = renderSettings?.generationMode === LTX_REFERENCES_GENERATION_MODE && !ltxReferencesGreyboxBlocked;
  // Say why References is not offered instead of hiding the option, but only where
  // LTX is in play: on Grok, fal or Runway the shot sends its own references.
  const ltxReferencesRelevant = referenceBackend === 'local' || renderSettings?.generationMode === LTX_REFERENCES_GENERATION_MODE;
  const ltxReferencesReason = layer === 'footage' && !canUseLtxReferences && ltxReferencesRelevant
    ? ltxReferencesUnavailableReason({ performance, backend: referenceBackend, model: referenceModel,
      audioReactive: renderSettings?.generationMode === 'audioReactive', storyboardDefault })
    : null;
  // References the director picked turn the box on. Auto cast does not, since it
  // costs the shot its song audio. Unticking, or asking for song audio or an end frame, wins.
  const ltxReferencesPicked = !ltxReferencesGreyboxBlocked && scene.clipReferenceIds?.length > 0;
  const useLtxReferences = canUseLtxReferences && (renderInputs.ltxReferences ?? (ltxReferencesProjectDefault || ltxReferencesPicked));
  // Exactly what Render sends: the prompt as typed and the inputs the card toggles.
  const cardRequest = shotCardRenderRequest({ project, scene, castMedia, greybox, settings: renderSettings || {}, performance, endFramePlan,
    models: videoModels, defaultModel: defaultVideoModel, inputs: useLtxReferences ? { ...renderInputs, songAudio: false, endFrame: false } : renderInputs, plan: timing.plan });
  // Most Runway models cannot mix keyframes with references, so an end frame sends none there.
  const runwayEndFrameOn = referenceBackend === 'runway' && cardRequest.endFrame?.state === 'on';
  const endFrameBlocksReferences = runwayEndFrameOn && !!referenceModel?.referenceImages && !referenceModel.referenceImages.keepsFrames;
  // Grok can take the start frame as a layout reference instead of the locked opening frame,
  // so the people it shows can take the clip references' likeness.
  const startFrameLayout = referenceBackend === 'grok' && !storyboardDefault && renderInputs.startFrameLayout === true;
  const referenceCapacity = useLtxReferences ? 8 : musicVideoClipReferenceCapacity(referenceBackend, referenceModel, { endFrame: runwayEndFrameOn, startFrameLayout });
  const guidesPending = referenceCapacity > 0 && castMedia && musicVideoSceneCastIds(project, scene).some((id) => castMedia[id] === undefined);
  // A failed read (null) would otherwise send the clip without the member's guides.
  const guidesFailed = referenceCapacity > 0 && castMedia && musicVideoSceneCastIds(project, scene).some((id) => castMedia[id] === null);
  const availableReferences = musicVideoClipReferenceChoices(project, scene, castMedia);
  const selectedClipReferences = musicVideoClipConditioningReferences(project, scene, castMedia, { limit: referenceCapacity });
  const referenceLabels = selectedClipReferences.map((ref) => ref.label || ref.role || 'visual reference');
  const referenceSheetPrefix = ltxReferenceSheetPrefix(referenceLabels);
  const previewRequest = useLtxReferences ? { ...cardRequest,
    prompt: `${referenceSheetPrefix}${cardRequest.prompt}`,
    promptAdditions: [{ id: 'ltx-reference-sheet', label: 'Reference sheet', text: referenceSheetPrefix.trim() }, ...cardRequest.promptAdditions],
  } : cardRequest;
  const missingReference = referenceCapacity > 0 && Array.isArray(scene.clipReferenceIds)
    && scene.clipReferenceIds.some((id) => !availableReferences.some((ref) => ref.id === id));
  // Hosted cutaways cannot use the Local project's supplied-audio default. Preserve
  // an unknown Local model and required performance/audio-reactive inputs for the server to validate.
  const songAudioState = cardRequest.songAudio.state;
  const silentHostedCutaway = !performance && songAudioState === 'unavailable'
    && ['grok', 'fal', 'runway', 'gemini'].includes(renderSettings?.backend);
  const songAudioField = songAudioState === 'on' || songAudioState === 'off' || silentHostedCutaway
    ? { songAudio: songAudioState === 'on' } : {};
  const greyboxRefusal = greyboxSaving ? 'Saving greybox reference…' : greybox?.error;
  const refusalInputs = {
    settingsSaving, speakerUnsaved: performance && (speakerDirty || speakerSaving),
    referenceImageId: scene.referenceImageId, performanceBlocked,
    videoBlockedReason: renderOverrides && videoBlockedReasonFor ? videoBlockedReasonFor(renderSettings) : videoBlockedReason,
  };
  const otherRefusal = videoGenerationRefusal(refusalInputs) || shotCardRequestProblem(cardRequest);
  const referenceRefusal = clipReferenceSaveState === 'saving' ? 'Saving clip references…'
    : clipReferenceSaveState === 'failed' ? 'Save the clip references before rendering'
      : guidesPending ? 'Cast guides are still loading'
        : guidesFailed ? 'Cast guides could not be loaded'
        : missingReference ? 'A selected clip reference is unavailable'
          : useLtxReferences && ltxReferencesGreyboxBlocked ? 'Clear the greybox reference before using LTX reference images'
            : useLtxReferences && !selectedClipReferences.length ? 'Choose at least one clip reference'
              : useLtxReferences && !cardRequest.authored?.trim() ? 'Add a shot prompt first' : null;
  const videoRefusal = greyboxRefusal || referenceRefusal || otherRefusal;
  const sendRender = () => {
    const { endFrame, wholeLine } = cardRequest;
    const card = {
      prompt: useLtxReferences
        ? `${referenceSheetPrefix}${cardRequest.authored}`
        : cardRequest.authored,
      ...(endFrame ? { endFrame: endFrame.state === 'on' } : {}),
      ...(wholeLine?.state === 'on' ? { wholeLine: true } : {}),
      expectedClipReferenceFiles: selectedClipReferences.map((ref) => ref.imageId),
      ...songAudioField,
      ...(useLtxReferences ? { ltxReferences: true, songAudio: false, endFrame: false, expectedClipReferenceLabels: referenceLabels }
        : canUseLtxReferences && ltxReferencesProjectDefault ? { ltxReferences: false } : {}),
      ...(startFrameLayout ? { startFrameLayout: true } : {}),
    };
    onGenerateVideo?.(scene, { ...(renderOverrides ? { target: renderOverrides } : {}), card });
  };
  const renderBlocked = !!videoRefusal || sendingClip;
  const generateVideo = () => {
    if (renderBlocked) return;
    sendRender();
  };
  // A shot fitted from a storyboard panel with no still yet leads with Clip from storyboard:
  // its still renders first, then the server animates it on this card's lane.
  const storyboardRefusal = storyboardDefault ? greyboxRefusal || referenceRefusal || videoGenerationRefusal({ ...refusalInputs, needsStill: false }) : null;
  const generateStoryboardClip = () => {
    if (storyboardRefusal) return;
    const model = renderOverrides?.modelId || renderOverrides?.falModelId || renderOverrides?.runwayModelId;
    onGenerateFrame?.(scene, withFrameTarget({ thenClip: { ...(renderLane ? { backend: renderLane } : {}), ...(model ? { model } : {}), ...songAudioField } }));
  };
  const renderCost = performance ? performanceCost : timing.falCost;
  // A composed still shows its picture (the still, or the still playing its image effect) in place of a clip.
  const stillPicture = layered && layer === 'still';
  // A footage shot's start and end frames show as a pair, the end frame optional; an effect
  // from the start frame to the end frame needs both, and the same Use end frame switch.
  const endFrameEffect = stillPicture && isEndFrameImageEffect(scene.imageEffect);
  const endFrames = Boolean(onGenerateEndFrame) && (layer === 'footage' || endFrameEffect);
  // The editor shows one picture at a time: the frames, or the clip (the still stands in until it has one).
  // A shot that leads with Clip from storyboard opens on the clip, where that action lives.
  const [view, setView] = useState(() => (scene.videoHistoryId || scene.referenceImageId || stillPicture || storyboardDefault ? 'clip' : 'frames'));
  const views = [['frames', endFrames ? 'Frames' : 'Still'], ['clip', stillPicture ? 'Picture' : 'Clip']];
  const shotModeValue = performance ? (scene.performanceStyle === 'music' ? 'music' : 'performance') : 'cutaway';
  // A shot before the song has a length of its own instead of a span of the song.
  const preMusic = isPreMusicShot(scene);
  const planned = plannedTransitions(project?.productionReview?.draft?.storyboard);
  // Each group's header says what is set, so a closed group still reads at a glance.
  const timingSummary = [
    preMusic ? `before the song · ${normalizePreMusic(scene.preMusic).durationSec.toFixed(2)}s` : null,
    !preMusic && typeof scene.startSec === 'number' && typeof scene.endSec === 'number' ? `${scene.startSec.toFixed(2)}–${scene.endSec.toFixed(2)}s (${frameSpan(scene)})` : null,
    scene.beatAligned ? 'beat-aligned' : null,
    scene.pacingCut ? 'pacing cut' : null,
    layer === 'footage' && loops && !performance ? 'loops' : null,
  ].filter(Boolean).join(' · ');
  const typeSummary = [
    layer === 'footage' ? SHOT_MODE_LABELS[shotModeValue] : LAYER_LABELS[layer],
    layer !== 'footage' && scene.camera?.move ? `camera ${scene.camera.move}` : null,
  ].filter(Boolean).join(' · ');
  const effectLabels = [...new Set(Object.values(shotEffects(scene, { layered, planned })).flat().map(shotEffectLabel))];
  const effectsSummary = effectLabels.join(', ') || 'none';
  const lyricType = !preMusic && (documentComposition || (layer !== 'card' && composedDrawsLyrics(project)));
  // A storyboard-linked shot's prompt is its panel's direction, read live so it stays in
  // sync, until the director types one of their own; typing the panel's words back re-links it.
  const boardDirection = storyboardShotDirection(scene);
  const followsBoard = !!boardDirection && !scene.prompt?.trim();
  const promptField = (
    <div className="space-y-1">
      {scene.beatNeedsReview && <div className="flex flex-wrap items-center gap-2 text-xs text-port-warning">
        <span>Needs its own beat — this prompt was copied from the longer shot.</span>
        <button type="button" onClick={() => applyPatch({ beatNeedsReview: false })} className="min-h-[44px] rounded border border-port-border px-2 pointer-fine:sm:min-h-0">Mark beat ready</button>
      </div>}
      <div className="flex items-center gap-1 text-[11px] text-port-text-muted">
        <label htmlFor={fieldId('prompt')}>{layer === 'footage' ? 'Clip prompt' : 'Shot prompt'}</label>
        <InfoTooltip label={layer === 'footage' ? 'About the clip prompt' : 'About the shot prompt'} placement="below" align="start" width={280}>
          {layer === 'footage'
            ? `What happens during the clip. The video model gets this text with the start frame (and end frame, if used)${fromSheet ? ', followed by the shot details' : ''}. What the frame looks like is its own prompt on the Frames tab.`
            : 'Describes the shot. The frame renders from it only when its own frame prompt is empty.'}
        </InfoTooltip>
      </div>
      <AutoSizeTextarea
        id={fieldId('prompt')}
        value={followsBoard ? boardDirection : scene.prompt || ''} rows={3}
        onChange={(e) => { markDirty('prompt'); onEditLocal(scene.sceneId, { prompt: e.target.value }); }}
        onBlur={(e) => saveIfDirty('prompt', { prompt: boardDirection && e.target.value.trim() === boardDirection ? '' : e.target.value })}
        placeholder={layer === 'footage' ? 'What happens in this shot' : 'What this shot shows'}
        className="block w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
      />
      {boardDirection && (followsBoard ? (
        <p className="text-[11px] text-port-text-muted" data-testid="prompt-from-storyboard">From the storyboard panel · stays in sync</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-text-muted" data-testid="prompt-own">
          <span>This shot's own prompt, not the panel's</span>
          <button type="button" onClick={() => { dirtyFields.current.delete('prompt'); onEditLocal(scene.sceneId, { prompt: '' }); onSave(scene.sceneId, { prompt: '' }); }} className="underline min-h-[44px] pointer-fine:sm:min-h-0">Use storyboard direction</button>
        </div>
      ))}
    </div>
  );
  // A music-driven shot follows the whole mix, not one voice; a lip-sync needs its singer before it renders.
  const speakerField = performance && scene.performanceStyle !== 'music' && (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={fieldId('speaker')}>Speaker / singer</label>
      <input id={fieldId('speaker')} value={scene.performanceSpeaker || ''} maxLength={120}
        onChange={(e) => { setSpeakerDirty(true); onEditLocal(scene.sceneId, { performanceSpeaker: e.target.value }); }}
        onBlur={(e) => {
          setSpeakerSaving(true);
          Promise.resolve(onSave(scene.sceneId, { performanceSpeaker: e.target.value || null }))
            .then((saved) => setSpeakerDirty(saved === false), () => setSpeakerDirty(true))
            .finally(() => setSpeakerSaving(false));
        }}
        className="bg-port-bg border border-port-border rounded px-2 py-1" placeholder="Intended singer" />
    </div>
  );
  // What this shot's render covers and costs, and what blocks it, stays beside Render.
  const timingPlan = !preMusic && (
    <SceneTimingPlan timing={timing} lipSyncBackend={renderLane} />
  );
  // A timed shot's cuts move with the shot beside them; an untimed one sets its own times first.
  const cutMoves = sceneHasAuthoredSpan(scene) ? { startSec: onMoveStart, endSec: onMoveEnd } : {};
  const detailsSummary = fromSheet
    ? shotSheetPromptLines(project, scene).map((line) => line.label.toLowerCase()).join(', ') || 'none set'
    : 'not in the prompts';
  const detailsGroup = !codeShot && layer !== 'card' && (
    <ShotEditorGroup title="Shot details" summary={detailsSummary} defaultOpen testId="shot-group-details">
      <label htmlFor={fieldId('from-sheet')} className="flex items-center gap-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0">
        <input id={fieldId('from-sheet')} type="checkbox" checked={fromSheet}
          onChange={(e) => applyPatch({ shotSheet: normalizeShotSheet({ ...scene.shotSheet, promptFromSheet: e.target.checked }) })} />
        Use these details in the prompts
      </label>
      <p className="text-[11px] text-port-text-muted">
        {fromSheet
          ? 'Each detail is added to the still prompt and the clip prompt as its own labeled part (shown under each prompt). The prompt boxes hold only what the details don\'t cover.'
          : 'Off: this shot\'s hand-written prompts are sent as they are. To move a long prompt into these details, use Split frame prompts into details on the shot sheet.'}
      </p>
      <ShotSheetFields project={project} scene={scene} onChange={applyPatch} />
    </ShotEditorGroup>
  );
  const settingsGroups = (
    <>
      {detailsGroup}
      <ShotEditorGroup title="Timing" summary={timingSummary} testId="shot-group-timing">
        {/* Whether the shot plays before the song (the cold open), with its own length. */}
        <PreMusicTiming fieldId={fieldId} scene={scene} onChange={applyPatch} />
        {/* Move the cut before this shot a frame at a time; the shot before ends where this one starts. */}
        {!preMusic && onMoveStart && sceneHasAuthoredSpan(scene) && (
          <SceneStartFrame id={fieldId('start-frame')} scene={scene} joinsPrevious={(scene.order ?? index) > 0} onMove={onMoveStart} />
        )}
        {/* How long the shot runs; the next shot grows or shrinks to meet the new end. */}
        {!preMusic && onMoveEnd && sceneHasAuthoredSpan(scene) && (
          <SceneDuration id={fieldId('duration')} scene={scene} nextEndSec={isLast ? null : nextEndSec} songDurationSec={songDurationSec} onMoveEnd={onMoveEnd} />
        )}
        <div className="flex flex-wrap gap-2 items-center text-xs">
          {!preMusic && SCENE_TIME_FIELDS.map(([labelText, key]) => {
            const toValue = (v) => (v === '' ? null : Number(v));
            if (cutMoves[key]) return <SceneCutField key={key} label={labelText} value={scene[key]} onCommit={(sec) => cutMoves[key](scene.sceneId, sec)} />;
            return (
              <label key={key} className="flex items-center gap-1">{labelText}
                <input type="number" min="0" step="0.1" value={scene[key] ?? ''} className="w-20 bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0"
                  onChange={(e) => { markDirty(key); onEditLocal(scene.sceneId, { [key]: toValue(e.target.value) }); }}
                  onBlur={(e) => saveIfDirty(key, { [key]: toValue(e.target.value) })} />
                {typeof scene[key] === 'number' && <span className="tabular-nums text-port-text-muted">fr {frameAt(scene[key])}</span>}
              </label>
            );
          })}
          <label className="flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0">
            <input type="checkbox" checked={!!scene.beatAligned}
              onChange={(e) => { onEditLocal(scene.sceneId, { beatAligned: e.target.checked }); onSave(scene.sceneId, { beatAligned: e.target.checked }); }} />
            Beat-aligned
          </label>
          <label className="flex items-center gap-1 min-h-[44px] pointer-fine:sm:min-h-0" title="Repeat the generated clip to fill a span longer than the clip. Off: the shot must be covered by its clip (trim, continue, or replace it).">
            <input type="checkbox" checked={loops} disabled={performance || clipReversed(scene)} onChange={(e) => applyPatch({ loop: e.target.checked })} />
            Loop clip
          </label>
        </div>
        {/* Split and merge belong to the shot, not its render, so a photo or a shot with no clip has them too. */}
        {!preMusic && (
          <SceneShotCuts timing={timing} sceneId={scene.sceneId} lipSyncBackend={renderLane} onSplit={onSplit} onMergeNext={onMergeNext} onMergePrevious={onMergePrevious}
            span={sceneHasAuthoredSpan(scene) ? { startSec: scene.startSec, endSec: scene.endSec } : null} />
        )}
        <SceneOrderActions index={index} isLast={isLast} manifestOwnsShots={manifestOwnsShots}
          onMove={onMove} onDelete={onDelete ? () => onDelete(scene.sceneId) : null} />
      </ShotEditorGroup>
      {preMusic && (
        <ShotEditorGroup title="Sound" summary={preMusicSoundSummary(scene.preMusic).toLowerCase()} testId="shot-group-sound">
          <PreMusicSound fieldId={fieldId} scene={scene} onChange={applyPatch} />
        </ShotEditorGroup>
      )}
      <ShotEditorGroup title="Transitions & effects" summary={effectsSummary} testId="shot-group-effects">
        {/* A glitch or a wipe on the cut into or out of this shot; never moves the cut. */}
        <SceneTransitions fieldId={fieldId} scene={scene} onChange={applyPatch} isLast={!!isLast}
          onVaryWipes={onVaryWipes ? (count) => onVaryWipes(scene.sceneId, count) : null} />
        {/* How this shot hands over to the next: a cut, beat toggle, dissolve or fade, as its storyboard row plans until one is picked. */}
        <SceneCutEffect fieldId={fieldId} scene={scene} isLast={!!isLast} onChange={applyPatch} planned={planned.get(scene.sceneId)} />
        {/* Glitches at moments inside the shot, set and moved on a slider; they add no time. */}
        <SceneGlitches fieldId={fieldId} scene={scene} onChange={applyPatch} />
      </ShotEditorGroup>
      {/* Where the lyrics over this shot sit, their style and size, whenever the render draws lyrics (a card draws its own text). */}
      {lyricType && (
        <ShotEditorGroup title="Lyrics" testId="shot-group-lyrics">
          <SceneLyricType fieldId={fieldId} scene={scene} onChange={applyPatch} />
        </ShotEditorGroup>
      )}
      {/* What the shot is: its layer, a footage shot's mode, a still's move, a card's text, a non-footage shot's camera. */}
      <ShotEditorGroup title="Shot type" summary={typeSummary} testId="shot-group-type">
        <div className="flex flex-wrap gap-2 items-center text-xs">
          <label htmlFor={fieldId('layer')}>Layer</label>
          <select id={fieldId('layer')} value={layer} onChange={(e) => applyPatch({ visualLayer: e.target.value })}
            className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0">
            {MUSIC_VIDEO_VISUAL_LAYERS.map((value) => <option key={value} value={value}>{LAYER_LABELS[value]}</option>)}
          </select>
          {/* A performance is sung footage — only the footage layer offers it. */}
          {layer === 'footage' && (
            <>
              <label htmlFor={shotModeId} className="flex items-center gap-1">Shot</label>
              <select id={shotModeId} value={shotModeValue}
                onChange={(e) => applyPatch(e.target.value === 'cutaway' ? { shotMode: 'cutaway' }
                  : e.target.value === 'music' ? { shotMode: 'performance', performanceStyle: 'music' }
                    // Clear the style only when one is stored, so a plain lip-sync switch stays one field.
                    : { shotMode: 'performance', ...(scene.performanceStyle ? { performanceStyle: null } : {}) })}
                className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0"
                title="Cutaway: any video lane animates the frame under the song. Lip-sync: a singer's mouth follows the song. Music-driven: the song slice drives the whole frame's motion (a drummer on the beat). Both need a source-audio provider.">
                {Object.entries(SHOT_MODE_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
              {/* #14241: neighbouring cutaways on one set can share one timed generation. */}
              {shotModeValue === 'cutaway' && (
                <>
                  <label htmlFor={fieldId('coverage')}>Coverage</label>
                  <select id={fieldId('coverage')} value={scene.coverage === 'sequence' ? 'sequence' : 'per-shot'}
                    onChange={(e) => applyPatch({ coverage: e.target.value })}
                    className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0"
                    title="Per shot: one clip per shot. Sequence: neighbouring cutaways that share a set and protagonist render in one timed request, cut back onto each shot.">
                    <option value="per-shot">Per shot</option>
                    <option value="sequence">Sequence</option>
                  </select>
                </>
              )}
            </>
          )}
          {layer === 'still' && (
            <>
              <label htmlFor={fieldId('move')}>Move</label>
              <select id={fieldId('move')} value={scene.stillMove || 'hold'} onChange={(e) => applyPatch({ stillMove: e.target.value })}
                disabled={documentComposition && !!scene.camera?.move} title={documentComposition && scene.camera?.move ? 'The planned camera move drives this still.' : undefined}
                className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50">
                {STILL_MOVE_LABELS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </>
          )}
          {layer === 'card' && (
            <>
              <label htmlFor={fieldId('card-text')}>Card text</label>
              <input id={fieldId('card-text')} type="text" maxLength={500} value={scene.cardText || ''}
                placeholder="Title shown on the card"
                onChange={(e) => { markDirty('cardText'); onEditLocal(scene.sceneId, { cardText: e.target.value }); }}
                onBlur={(e) => saveIfDirty('cardText', { cardText: e.target.value.trim() || null })}
                className="min-w-0 flex-1 basis-40 bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] pointer-fine:sm:min-h-0" />
              <label htmlFor={fieldId('card-color')}>Background</label>
              <input id={fieldId('card-color')} type="color" value={scene.cardColor || '#000000'}
                onChange={(e) => { markDirty('cardColor'); onEditLocal(scene.sceneId, { cardColor: e.target.value }); }}
                onBlur={(e) => saveIfDirty('cardColor', { cardColor: e.target.value })}
                className="h-8 w-10 min-h-[44px] pointer-fine:sm:min-h-0 bg-port-bg border border-port-border rounded" />
            </>
          )}
        </div>
        {layer !== 'footage' && !layered && (
          <p className="text-[11px] text-port-text-muted">
            {LAYER_LABELS[layer]} sections render in composed or document mode — a plain render plays this scene&apos;s footage.
          </p>
        )}
        {layer !== 'card' && layer !== 'footage' && <SceneCameraControls scene={scene} fieldId={fieldId} onEditLocal={onEditLocal} onSave={onSave} />}
      </ShotEditorGroup>
    </>
  );
  const showSongRevision = songChange && !songChange.resolved && songChange.status !== 'kept';
  const showSpanWarning = layer !== 'footage' && layered && !sceneHasAuthoredSpan(scene);
  // Chrome lays the @container body out at 0×0 when the coverage notice is inserted
  // above that body inside the same fieldset. These rows stay above the body, in
  // their own fieldset, so a locked shot still disables them.
  const showAboveBody = showSongRevision || storyboardShot || clipPlayback.underCovered || showSpanWarning;
  return (
    <div className="min-w-0">
    <section id={`scene-${scene.sceneId}`} aria-labelledby={`scene-${scene.sceneId}-title`}>
      {/* The drawer's header: it stays put while the editor scrolls, and sits outside the
          locked fieldset so stepping between shots and closing always work. */}
      <header className="port-opaque-surface sticky top-0 z-10 -mx-4 -mt-4 mb-3 flex flex-wrap items-center gap-3 border-b border-port-border px-4 py-2">
        <ScenePoster scene={scene} iconSize={14} className="aspect-video w-20 shrink-0 rounded border border-port-border max-sm:hidden" />
        <div className="min-w-0 flex-1">
          <h2 id={`scene-${scene.sceneId}-title`} tabIndex={-1} data-shot-heading className="truncate text-base font-medium text-white focus:outline-hidden">
            {shotName || sceneShotName(scene)}
          </h2>
          <div className="truncate text-[11px] text-port-text-muted">
            {typeof scene.startSec === 'number' && typeof scene.endSec === 'number'
              ? `${(scene.endSec - scene.startSec).toFixed(2)}s · ${formatTimecode(scene.startSec)}–${formatTimecode(scene.endSec)} · ${frameSpan(scene)}`
              : `#${scene.order + 1}`}
            {frameReadiness.text ? ` · ${frameReadiness.text}` : ''}
            {scene.videoHistoryId ? ' · video ready' : ''}
            {frameReadiness.reasons.length > 0 && <span className="block truncate text-port-warning">{frameReadiness.reasons.join(' · ')}</span>}
            {clipSec != null ? ` · clip ${clipSec.toFixed(1)}s` : ''}
          </div>
          {scene.lyricText && <div className="truncate text-[11px] italic text-port-text-muted">♪ {scene.lyricText}</div>}
          {attention.length > 0 && (
            <ul aria-label="Needs attention" className="mt-0.5 flex flex-wrap gap-1">
              {attention.map((code) => (
                <li key={code} data-attention={code} className="whitespace-nowrap rounded border border-port-warning/40 bg-port-warning/10 px-1.5 text-[10px] text-port-warning">
                  {SCENE_ATTENTION_LABELS[code]}
                </li>
              ))}
            </ul>
          )}
        </div>
        {stepShot && (
          <>
            <button type="button" onClick={stepShot.prev || undefined} disabled={!stepShot.prev} aria-label="Previous shot" title="Previous shot" className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-port-border text-port-text hover:bg-port-border disabled:opacity-40 pointer-fine:sm:min-h-[36px] pointer-fine:sm:min-w-[36px]">
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <button type="button" onClick={stepShot.next || undefined} disabled={!stepShot.next} aria-label="Next shot" title="Next shot" className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-port-border text-port-text hover:bg-port-border disabled:opacity-40 pointer-fine:sm:min-h-[36px] pointer-fine:sm:min-w-[36px]">
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </>
        )}
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close shot" title="Close shot"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-port-border/50 hover:text-white">
            <X size={20} aria-hidden="true" />
          </button>
        )}
        {/* Render status wraps under the title instead of squeezing it. */}
        {(generatingLane || generatingFrame || generatingVideo) && (
          <span className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1">
            {generatingLane && (
              <span className="flex items-center gap-1 text-[11px] text-port-accent">
                <Activity size={14} className="animate-spin" aria-label="Generating" />
                {generatingLane}
              </span>
            )}
            <SceneRenderProgress kind="Frame" generating={generatingFrame} progress={frameProgress} />
            {clipJobs.map((job) => (
              <SceneRenderProgress key={job.key} kind={job.label ? `Video (${job.label})` : 'Video'} generating
                progress={job.running ? { progress: job.progress } : null} retry={job.retry} />
            ))}
          </span>
        )}
      </header>
      <div className="space-y-3">
        {showAboveBody && (
          <fieldset disabled={locked} className="min-w-0 space-y-3">
            {showSongRevision && (
              <p className="break-words text-[11px] text-port-warning">{songChange.status === 'new' ? 'New shot for lines the revised song added.' : `Before the song revision: ${songChange.previousLyricText ? `♪ ${songChange.previousLyricText}` : 'instrumental'}`}</p>
            )}
            {/* The storyboard panel this shot is drawn from, first: shots and panels are linked 1:1. */}
            <ShotStoryboardPanel projectId={project?.id} storyboardId={storyboardId} scene={scene} linked={storyboardShot}
              onSceneUpdated={onEditLocal} onUnlink={() => applyPatch({ panelId: null, panelRev: null, panelArt: null })} onBoard={onStoryboardBoard} />
            <SceneClipCoverageNotice scene={scene} playback={clipPlayback} onChange={applyPatch} />
            {showSpanWarning && (
              <p role="alert" className="text-[11px] text-port-warning">
                Set a start and end — a {{ card: 'title card', code: 'code-drawn shot' }[layer] || 'still'} runs for exactly its span.
              </p>
            )}
          </fieldset>
        )}
        <fieldset disabled={locked} className="min-w-0">
        {/* Two columns in a wide drawer: the picture, its takes and Render on the left, the settings groups on the right. */}
        <div className="@container">
        <div className="grid gap-3 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)] @3xl:items-start">
        <div className="min-w-0 space-y-3">
        {(layer !== 'footage' || codeShot) && promptField}
        {codeShot ? (
          <p className="text-xs text-port-text-muted" data-testid="code-shot-note">
            The composition draws this shot, so it needs no frame or clip.
            {!documentComposition && ' A composed render shows it as a black frame under the typography; render from a composition document to draw it.'}
          </p>
        ) : (
        <>
        <TabPills variant="filter" size="xs" ariaLabel="Show" tabs={views.map(([id, label]) => ({ id, label }))} activeTab={view} onChange={setView} />
        {/* Finalize the shot: only the frames and clip in use stay candidates. */}
        <SceneRejectUnused scene={scene} busy={takeBusy} onReject={onRejectUnusedTakes} />
        {/* Frames: the still this shot starts from and, optionally, the one it ends on (#11173),
            each with its prompt and Render under it, then the tapped frame's takes. */}
        <div hidden={view !== 'frames'}>
        <SceneFrames project={project} castMedia={castMedia} onReloadCastMedia={onReloadCastMedia} greyboxPlaces={greyboxPlaces} greyboxSaving={greyboxSaving} onGreyboxSaving={setGreyboxSaving} scene={scene} index={index} endFrames={endFrames} endFrameToggle={layer === 'footage' || endFrameEffect} generatingFrame={!!generatingFrame} generatingEndFrame={!!generatingEndFrame}
          onGenerateFrame={onGenerateFrame} onGenerateEndFrame={onGenerateEndFrame} onImageTargetChange={onFrameImageTarget} onEditLocal={onEditLocal} onSave={onSave}
          onOpenPreview={onOpenPreview} takeBusy={takeBusy} onSelectTake={onSelectTake} onReviewTake={onReviewTake}
          onSwap={onPlacePoolItem ? setSwapKind : null} onSwapFrames={onSwapFrames ? () => onSwapFrames(scene) : null} onImportTake={onImportTake}
          onContinueFromPrevious={layer === 'footage' && index > 0 ? onContinueFromPrevious : null} previousHasClip={previousHasClip}
          assetMarks={project?.assetMarks} onMarkTake={onMarkTake} onCheckTake={onCheckTake} checkingTakes={checkingTakes} onApplyCameos={onApplyCameos} />
        </div>
        {/* Clip: the picture and its takes, where it renders and its references, the clip prompt, then Render and other ways to get a clip. */}
        <div hidden={view !== 'clip'}>
        <section aria-label="Render" className="min-w-0 space-y-2">
          {/* A clip, the still, or the still playing a code-drawn image effect (no model call). */}
          {layered && (layer === 'footage' || layer === 'still') && (
            <SceneImageEffect fieldId={fieldId} scene={scene} onChange={applyPatch} beats={project?.audioAnalysis?.beats} fps={photoFps} />
          )}
          {stillPicture ? <ScenePicturePreview scene={scene} beats={project?.audioAnalysis?.beats} fps={photoFps} /> : (
          <>
          {scene.videoHistoryId && performance && (
            <PerformanceEvidence key={scene.videoHistoryId} clipSrc={clipSrc} instruction={instruction}
              temporal={performanceReview?.shot} excerptStartSec={performanceReview?.excerptStartSec || 0}
              repair={repairPlan} repairBusy={repairBusy || settingsSaving || generatingVideo || takeBusy}
              onRepair={onRepairPerformance ? () => onRepairPerformance(scene.sceneId, {
                excerptId: performanceReview.excerptId, sourceAssetId: repairPlan.sourceAssetId, boundarySec: repairPlan.boundarySec,
              }) : null} />
          )}
          <SceneClipPreview scene={scene} index={index} performance={performance} playback={clipPlayback}
            onOpenPreview={onOpenPreview} onTrimClip={onTrimClip}
            takeBusy={takeBusy} generatingVideo={generatingVideo} />
          {/* One take cut across shots needs a source clip longer than this shot's span, and may need another model. */}
          {layer === 'footage' && !performance && (
            <SceneClipLength fieldId={fieldId} scene={scene} settings={renderSettings || {}} onChange={applyPatch} />
          )}
          {/* Speed and offset by hand, from the same clip file, in the player and the final render. */}
          {scene.videoHistoryId && layer === 'footage' && (
            <SceneClipTiming fieldId={fieldId} scene={scene} onChange={applyPatch} />
          )}
          {/* A clip of another shape (a 3:2 local render) zooms to fill, or keeps its ratio with covered edges. */}
          {scene.videoHistoryId && (
            <SceneFrameFit id={fieldId('frame-fit')} scene={scene} clipSize={clipSize} aspect={aspect}
              onChange={(frameFit) => applyPatch({ frameFit })} />
          )}
          {/* A clip under 720p (grok's 480p default) goes soft in a 1080p render. */}
          {scene.videoHistoryId && clipSize && isLowResVideo(clipSize) && (
            <p className="text-xs text-port-warning" data-testid="clip-low-res">
              Low-res clip: {clipSize.width}×{clipSize.height}, under 720p. Upscale it in Media History or regenerate it before the final render.
            </p>
          )}
          {/* Until the clip exists its still stands in, so the player is never an empty box. */}
          {!scene.videoHistoryId && layer === 'footage' && (
            <div className="relative" data-testid="clip-placeholder">
              <ScenePoster scene={scene} className="aspect-video w-full rounded border border-port-border" />
              <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{scene.referenceImageId ? 'Still · no clip yet' : 'No clip yet'}</span>
            </div>
          )}
          <SceneTakeStrip scene={scene} kind="video" busy={takeBusy} grid pending={clipJobs}
            onSelect={(take) => onSelectTake?.(scene, take)}
            onReview={(take, review) => onReviewTake?.(scene, take, review)}
            onOpenPreview={onOpenPreview} marks={project?.assetMarks} onMark={onMarkTake} />
          {speakerField}
          <div className="flex flex-wrap items-center gap-2">
            <SceneRenderTarget id={fieldId('render-on')} value={renderPick} onChange={setRenderPick} performance={performance}
              options={renderOptions} onOptionsChange={setRenderOptions} scene={scene} models={videoModels} defaultModel={defaultVideoModel}
              saved={falVideoSettings || {}} minFrames={useLtxReferences ? 121 : null} />
            {renderCost && <span className="text-[11px] text-port-text-muted">{renderCost}</span>}
          </div>
          {layer === 'footage' && canUseLtxReferences && (
            <label className="flex items-center gap-2 text-xs text-port-text-muted">
              <input type="checkbox" checked={useLtxReferences} disabled={ltxReferencesGreyboxBlocked}
                onChange={(event) => setRenderInputs((prev) => ({ ...prev, ltxReferences: event.target.checked,
                  ...(event.target.checked ? { songAudio: false, endFrame: false } : {}) }))} />
              Use LTX reference images (requires Ingredients adapter; at least 121 frames; no song audio or end frame)
            </label>
          )}
          {ltxReferencesReason && <p className="text-xs text-port-text-muted">{ltxReferencesReason}</p>}
          {canUseLtxReferences && ltxReferencesGreyboxBlocked && (
            <p className="text-xs text-port-text-muted">Clear the greybox reference to use LTX reference images.</p>
          )}
          {layer === 'footage' && referenceBackend === 'grok' && !storyboardDefault && scene.referenceImageId && (
            <label className="flex items-center gap-2 text-xs text-port-text-muted">
              <input type="checkbox" checked={startFrameLayout}
                onChange={(event) => setRenderInputs((prev) => ({ ...prev, startFrameLayout: event.target.checked }))} />
              Start frame for layout only (its people take the clip references' looks; the clip may not open on it exactly)
            </label>
          )}
          {layer === 'footage' && <SceneClipReferences project={project} scene={scene} castMedia={castMedia} startFrameLayout={startFrameLayout}
            backend={referenceBackend} model={referenceModel} capacityOverride={useLtxReferences ? 8 : runwayEndFrameOn ? referenceCapacity : undefined} endFrameBlocksReferences={endFrameBlocksReferences} ltxReferencesOff={canUseLtxReferences && !useLtxReferences} onEditLocal={onEditLocal} onSave={onSave}
            saveState={clipReferenceSaveState} onSaveState={setClipReferenceSaveState} />}
          {/* The clip prompt sits under the clip's references, like each frame's prompt under its frame. */}
          {layer === 'footage' && promptField}
          {/* The camera move sits with the clip prompt and shows the text it adds to it. */}
          {layer === 'footage' && (
            <SceneCameraControls scene={scene} fieldId={fieldId} onEditLocal={onEditLocal} onSave={onSave}
              adds={cardRequest.promptAdditions.find((item) => item.id === 'camera-move')?.text || null} />
          )}
          {timingPlan}
          {layer === 'footage' && (
            <SceneRenderInputs id={fieldId('inputs')} request={previewRequest} onChange={(patch) => setRenderInputs((prev) => ({ ...prev, ...patch,
              ...(patch.songAudio === true || patch.endFrame === true ? { ltxReferences: false } : {}) }))}
              grokPreview={(!renderSettings?.backend || renderSettings.backend === 'grok') && project?.id && scene.referenceImageId ? {
                ...(renderSettings?.backend ? { backend: renderSettings.backend } : {}), prompt: cardRequest.authored, mode: 'image', sourceImageFile: scene.referenceImageId,
                grokDuration: renderSettings?.backend === 'grok' ? grokSceneRequestDuration(scene, renderSettings, renderOverrides) : renderSettings?.grokDuration,
                musicVideo: { projectId: project.id, sceneId: scene.sceneId, catalogBasis: project.castAndSets?.catalogCheckin?.basis, compose: true, promptAsTyped: true, ...songAudioField,
                  ...(startFrameLayout ? { startFrameLayout: true } : {}) },
              } : null} previewRevision={JSON.stringify([project?.updatedAt, castMedia])} />
          )}
          {layer === 'footage' && scene.coverage === 'sequence' && <SceneSequenceCoverage project={project} scene={scene} />}
          {endFramePlan.endImageId && (
            <p className={`text-[11px] ${endFramePlan.used ? 'text-port-text-muted' : 'text-port-warning'}`} data-testid="end-frame-plan">
              {endFramePlan.used ? 'The clip ends on the end frame.' : `${endFramePlan.reason}.`}
            </p>
          )}
          {/* Render and the other ways to fill the shot, under all its prompts and settings. */}
          <div className="flex flex-wrap items-center gap-2" data-testid="clip-actions">
            {storyboardDefault && (
              <SceneStoryboardClip refusal={storyboardRefusal} generatingFrame={!!generatingFrame}
                onClip={generateStoryboardClip} onStill={onGenerateFrame ? () => {
                  const options = withFrameTarget(null);
                  if (options) onGenerateFrame(scene, options);
                  else onGenerateFrame(scene);
                } : null} />
            )}
            {!storyboardDefault && <button onClick={generateVideo}
              disabled={renderBlocked}
              className={PRIMARY_BUTTON}
              title={videoRefusal || (performance ? `${capability.style === 'music' ? "Animate this scene's frame to the song" : "Lip-sync this scene's frame to the song"} via ${capability.label} — ${performanceCost}`
                  : "Render this shot's clip from its still")}>
              {sendingClip ? <Activity size={14} className="animate-spin" /> : <Video size={14} />}
              {sendingClip ? 'Sending…' : `Render${scene.videoHistoryId || clipJobs.length ? ' again' : ''}`}
            </button>}
            {onPlacePoolItem && (
              <button type="button" onClick={() => setSwapKind('video')} disabled={takeBusy} className={SECONDARY_BUTTON}
                title="Pick a clip made for this video that no shot uses: this shot's other takes, other shots', or the floor">
                <Shuffle size={14} /> Swap from unused
              </button>
            )}
            {scene.videoHistoryId && canContinueShot && (
              <button
                onClick={() => onContinueVideo(scene)}
                disabled={settingsSaving || !!generatingVideo}
                className={SECONDARY_BUTTON}
                title="Native-extend this clip from its final latent frames and attach the longer result to this scene"
              >
                <Video size={14} /> Continue shot
              </button>
            )}
            {onImportClipTake && (
              <button type="button" onClick={() => onImportClipTake(scene)} disabled={takeBusy} className={SECONDARY_BUTTON}
                title="Pick an existing clip from the gallery (e.g. made in an external tool) as a take">
                <Clapperboard size={14} /> Import clip take
              </button>
            )}
          </div>
          {/* Why Render is off, on the card itself: a tooltip never shows on a phone. */}
          {videoRefusal && videoRefusal !== performanceBlocked && layer === 'footage' && !storyboardDefault && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-warning" data-testid="render-refusal">
              <span>{videoRefusal}</span>
            </div>
          )}
          {guidesFailed && onReloadCastMedia && layer === 'footage' && !storyboardDefault && <CastGuidesRetry onRetry={onReloadCastMedia} consequence="this clip" />}
          </>
          )}
        </section>
        </div>
        </>
        )}
        </div>
        <div className="min-w-0 space-y-2">
        {codeShot && timingPlan}
        {codeShot && speakerField}
        {settingsGroups}
        {/* This shot's piece of the composed final render: cached or not, Render shot, its film look. */}
        {project?.composition?.mode === 'document' && (
          <>
            <ShotColorMatch project={project} scene={scene} fieldId={fieldId} onApplied={(patch) => onEditLocal(scene.sceneId, patch)} />
            <ShotFilmLook project={project} scene={scene} onChange={applyPatch} fieldId={fieldId} />
          </>
        )}
        {project?.composition?.mode === 'composed' && <ShotFinalRender project={project} scene={scene} onChange={applyPatch} onLocal={(patch) => onEditLocal(scene.sceneId, patch)} fieldId={fieldId} />}
        {(scene.visualIntent || scene.direction || scene.direction?.actionContract) && (
          <ShotEditorGroup title="Direction" summary={scene.visualIntent} defaultOpen={false} testId="shot-group-direction">
            <div className="space-y-2 text-[11px] text-port-text-muted">
              {scene.visualIntent && <p className="break-words">Intent: {scene.visualIntent}</p>}
              {/* Applied treatment direction (#8980) — appended to both generated prompts. */}
              {scene.direction && (
                <p className="break-words" title={scene.direction.frameClause}>
                  Direction: {scene.direction.mode}{scene.direction.medium ? ` · planned ${MUSIC_VIDEO_MEDIUM_LABELS[scene.direction.medium] || scene.direction.medium}${scene.direction.mediumPinned ? ' (pinned)' : ''}` : ''}{scene.direction.focalSubject ? ` · ${scene.direction.focalSubject}` : ''}
                  {scene.direction.typographyRole !== 'none' ? ` · ${scene.direction.typographyRole} text, ${scene.direction.negativeSpace} region kept clear` : ' · no text'}
                </p>
              )}
              <ShotActionInspector contract={scene.direction?.actionContract} scene={scene} />
              <PlateComparison scene={scene} frames={false} />
            </div>
          </ShotEditorGroup>
        )}
        </div>
        </div>
        </div>
        </fieldset>
      </div>
      {swapKind && (
        <SceneTakePicker open onClose={() => setSwapKind(null)} projectId={projectId} scene={scene} kind={swapKind}
          shotNumbers={shotNumbers} busy={takeBusy} onPlace={(pick) => onPlacePoolItem?.(scene, pick)}
          onMarked={(result) => onPoolMarked?.(projectId, result)} />
      )}
    </section>
    {failure && (
      <div className="mt-1 flex items-start gap-2 rounded border border-port-error/40 bg-port-error/10 px-2 py-1 text-xs text-port-error">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">
          {failure.lane === 'video' ? 'Video' : 'Frame'} failed: {failure.error}
        </span>
        <button type="button"
          onClick={() => {
            if (failure.lane === 'video') { generateVideo(); return; }
            const options = withFrameTarget(null);
            if (options) onGenerateFrame?.(scene, options);
            else onGenerateFrame?.(scene);
          }}
          disabled={failure.lane === 'video' && renderBlocked}
          title={failure.lane === 'video' ? videoRefusal || undefined : undefined}
          className="inline-flex min-h-[44px] shrink-0 items-center px-1 font-medium underline disabled:opacity-50 pointer-fine:sm:min-h-0">
          Retry
        </button>
      </div>
    )}
    </div>
  );
}
