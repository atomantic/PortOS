import { musicVideoGreyboxReference } from '../../../../server/lib/musicVideoGreybox.js';
import PlateComparison from './PlateComparison.jsx';
import ShotActionInspector from './ShotActionInspector.jsx';
import SceneCameraControls from './SceneCameraControls.jsx';
import SceneStartFrame from './SceneStartFrame.jsx';
import SceneClipTiming from './SceneClipTiming.jsx';
import SceneRejectUnused from './SceneRejectUnused.jsx';
import ShotFinalRender from './ShotFinalRender.jsx';
import ShotStoryboardPanel from './ShotStoryboardPanel.jsx';
import ShotEditorGroup from './ShotEditorGroup.jsx';
import TabPills from '../ui/TabPills.jsx';
import SceneStoryboardClip, { storyboardClipOffered } from './SceneStoryboardClip.jsx';
import { MUSIC_VIDEO_MEDIUM_LABELS } from '../../../../server/lib/musicVideoMediumPlan.js';
import { storyboardShotDirection } from '../../../../server/lib/musicVideoShotPrompt.js';
import { useRef, useState } from 'react';
import { Trash2, Activity, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Video, AlertTriangle, Clapperboard, Shuffle } from 'lucide-react';
import OverflowMenu from '../ui/OverflowMenu.jsx';
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
import { CLIP_TIMING_FPS, MUSIC_VIDEO_VISUAL_LAYERS, clipReversed, composedDrawsLyrics, sceneHasAuthoredSpan, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';

// #8985: what a composed render shows for this scene's span.
const LAYER_LABELS = { footage: 'Footage', still: 'Still image', card: 'Title card', code: 'Code-drawn' };
const STILL_MOVE_LABELS = [['hold', 'Hold'], ['push', 'Push in'], ['pan', 'Pan']];
// #10583: the shared lyric type's zone and style for this shot (composition documents).
const SHOT_MODE_LABELS = { cutaway: 'Cutaway', performance: 'Performance (lip-sync)', music: 'Performance (music-driven)' };
const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';
const SECONDARY_BUTTON = 'flex items-center gap-1 bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] sm:min-h-0 whitespace-nowrap';
import { buildSceneTimingPresentation } from '../../lib/musicVideoSceneTiming.js';
import SceneTimingPlan from './SceneTimingPlan.jsx';
import SceneRenderProgress from './SceneRenderProgress.jsx';
import { SCENE_ATTENTION_LABELS, sceneAttention } from '../../lib/musicVideoSceneAttention.js';
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
 * The card is a disclosure: collapsed it is one row — frame thumbnail, title,
 * timing, lyric line and status — and it opens on tap to the full editor:
 * a "…" menu (move, delete), the linked storyboard panel, then
 * one picture at a time behind a Still / Clip switch (the still stands in for a
 * clip not made yet), each with its takes, its make / "Swap from unused" /
 * import buttons and its prompt. Swap from unused
 * (`onPlacePoolItem(scene, { kind, assetId, withAssetId? })`) opens
 * SceneTakePicker over the project's unused stills or clips. The
 * settings sit in ShotEditorGroup groups (Timing, Sound, Transitions & effects,
 * Lyrics, Shot type, Direction), each header naming what is set: beside the
 * picture in a wide drawer and open there, stacked and closed on a phone.
 * Opening or closing it also calls `onSeek(scene)`, so the docked preview
 * jumps to the scene's start.
 */
// #11040: the one owner of whether a video render may start. The server reloads
// the persisted scene (and its speaker), so an unsaved or failed speaker edit
// must hold back every video entry point — Generate video and the failure Retry.
// Returns the refusal reason, or null when the render may go ahead.
// A clip from the storyboard panel (`needsStill: false`) makes its own first frame.
function videoGenerationRefusal({ settingsSaving, speakerUnsaved, referenceImageId, generatingVideo, videoBlockedReason, performanceBlocked, needsStill = true }) {
  if (videoBlockedReason) return videoBlockedReason;
  if (performanceBlocked) return performanceBlocked;
  if (speakerUnsaved) return 'Save the speaker / singer edit first';
  if (settingsSaving) return 'Saving settings…';
  if (needsStill && !referenceImageId) return 'Generate a reference frame first';
  if (generatingVideo) return 'A video is already generating';
  return null;
}

export default function SceneCard({
  scene, index, shotNumber = null, isLast, generatingFrame, generatingVideo, frameProgress = null, videoProgress = null,
  settingsSaving, videoBlockedReason, videoBlockedReasonFor = null, canContinueShot,
  onMove, onDelete, onEditLocal, onSave,
  project = null, castMedia = null, greyboxPlaces = {}, onGenerateFrame, onGenerateVideo, onContinueVideo, onGenerateEndFrame, generatingEndFrame = false, onContinueFromPrevious, previousHasClip = false,
  onOpenPreview, onSelectTake, onReviewTake, onRejectUnusedTakes = null, onSwapFrames = null, onMarkTake = null, onPoolMarked = null, onImportTake, onImportClipTake, onPlacePoolItem, onTrimClip, projectId = null, aspect = '16:9', videoModels = [], defaultVideoModel = '', shotNumbers = undefined, takeBusy = false, layered = false, documentComposition = false,
  lipSyncBackend = '', songDurationSec = null, onSplit, onMergeNext, onMergePrevious = null, prevStartSec = null, onMoveStart = null, nextEndSec = null, falVideoSettings = null, onSeek, performanceReview = null, onRepairPerformance, repairBusy = false,
  expanded, onToggleExpand, stepShot = null, footageOptional = false, failedScenes = null, songReview = null,
  storyboardId = null, storyboardShot = null, onStoryboardBoard = null,
}) {
  const detailsRef = useRef(null);

  // Keep playback mounted even when this shot shows a still or performance evidence.
  const clipPlayback = useSceneClipPlayback(scene);
  const { clipSrc, clipSec, clipSize, loops, playedSec } = clipPlayback;
  const [speakerDirty, setSpeakerDirty] = useState(false);
  const [speakerSaving, setSpeakerSaving] = useState(false);
  // Which slot's "Swap from unused" picker is open: 'image', 'video' or null.
  const [swapKind, setSwapKind] = useState(null);
  const applyPatch = (patch) => { onEditLocal(scene.sceneId, patch); onSave(scene.sceneId, patch); };
  const layer = MUSIC_VIDEO_VISUAL_LAYERS.includes(scene.visualLayer) ? scene.visualLayer : 'footage';
  const lead = (project?.scenes || []).filter(s => !isPreMusicShot(s)).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .find(s => s.videoHistoryId && sceneVisualLayer(s, { layered }) === 'footage');
  const leadFile = useVideoFileSrc(documentComposition ? null : lead?.videoHistoryId, { geometry: true, enabled: layered && layer === 'still' });
  const photoFps = documentComposition ? 24 : leadFile.fps || 24;
  const fieldId = (name) => `mv-scene-${scene.sceneId}-${name}`;
  // #10297: a code shot is drawn by the composition, so it has no frame or clip to make.
  const codeShot = layered && layer === 'code';
  // Where this shot's clip renders: the last pick made on this device, else the project's saved renderer.
  const [initialRender] = useState(() => lastRenderTarget({ performance: isPerformanceScene(scene), saved: falVideoSettings || {} }));
  const [renderPick, setRenderPick] = useState(initialRender.pick);
  const [renderOptions, setRenderOptions] = useState(initialRender.options);
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
    nextEndSec, isLast, documentComposition, hasMergeNext: !!onMergeNext,
    prevStartSec, isFirst: index === 0, hasMergePrevious: !!onMergePrevious,
    lineCues: isPerformanceScene(scene) && renderInputs.wholeLine === true ? project?.lyricCues || [] : null,
  });
  const { performance, capability, performanceBlocked, performanceCost } = timing;
  const instruction = scene.takes?.find((take) => take.kind === 'video' && take.assetId === scene.videoHistoryId)?.shotInstruction;
  const repairPlan = planPerformanceRepair({ scene, temporal: performanceReview?.shot,
    excerptStartSec: performanceReview?.excerptStartSec, backend: lipSyncBackend, videoSettings: falVideoSettings || {} });
  const shotModeId = `mv-shot-mode-${scene.sceneId}`;
  // #10152: what needs the director's attention, visible without opening the card.
  const attention = sceneAttention(scene, { layered, footageOptional, lipSyncBackend, songDurationSec, clipSec: playedSec, failed: failedScenes || {}, songReview, videoSettings: falVideoSettings });
  const songChange = songReview?.[scene.sceneId];
  const generatingLane = generatingFrame && generatingVideo ? 'Frame + clip' : generatingFrame ? 'Frame' : generatingVideo ? 'Clip' : null;
  // #10154: the server-persisted failure of the last render, shown until a
  // retry is in flight (or lands a take, which clears it server-side).
  const failure = scene.lastFailure && !(scene.lastFailure.lane === 'video' ? generatingVideo : generatingFrame)
    ? scene.lastFailure : null;
  const endFramePlan = sceneEndFramePlanFor(scene, renderSettings || {}, { models: videoModels, defaultModel: defaultVideoModel });
  // Exactly what Render sends: the prompt as typed and the inputs the card toggles.
  const cardRequest = shotCardRenderRequest({ project, scene, greybox, settings: renderSettings || {}, performance, endFramePlan,
    models: videoModels, defaultModel: defaultVideoModel, inputs: renderInputs, plan: timing.plan });
  const greyboxRefusal = greyboxSaving ? 'Saving greybox reference…' : greybox?.error;
  const refusalInputs = {
    settingsSaving, speakerUnsaved: performance && (speakerDirty || speakerSaving),
    referenceImageId: scene.referenceImageId, generatingVideo, performanceBlocked,
    videoBlockedReason: renderOverrides && videoBlockedReasonFor ? videoBlockedReasonFor(renderSettings) : videoBlockedReason,
  };
  const otherRefusal = videoGenerationRefusal(refusalInputs) || shotCardRequestProblem(cardRequest);
  const videoRefusal = greyboxRefusal || otherRefusal;
  const sendRender = () => {
    const { songAudio, endFrame, wholeLine } = cardRequest;
    const card = {
      prompt: cardRequest.authored,
      ...(endFrame ? { endFrame: endFrame.state === 'on' } : {}),
      ...(wholeLine?.state === 'on' ? { wholeLine: true } : {}),
      ...(songAudio.state === 'on' || songAudio.state === 'off' ? { songAudio: songAudio.state === 'on' } : {}),
    };
    onGenerateVideo?.(scene, { ...(renderOverrides ? { target: renderOverrides } : {}), card });
  };
  const renderBlocked = !!videoRefusal;
  const generateVideo = () => {
    if (renderBlocked) return;
    sendRender();
  };
  // A shot fitted from a storyboard panel with no still yet leads with Clip from storyboard:
  // its still renders first, then the server animates it on this card's lane.
  const storyboardDefault = storyboardClipOffered({ scene, layer, performance });
  const storyboardRefusal = storyboardDefault ? greyboxRefusal || videoGenerationRefusal({ ...refusalInputs, needsStill: false }) : null;
  const generateStoryboardClip = () => {
    if (storyboardRefusal) return;
    const model = renderOverrides?.modelId || renderOverrides?.falModelId || renderOverrides?.runwayModelId;
    onGenerateFrame?.(scene, { thenClip: { ...(renderLane ? { backend: renderLane } : {}), ...(model ? { model } : {}) } });
  };
  const renderCost = performance ? performanceCost : timing.falCost;
  // A composed still shows its picture (the still, or the still playing its image effect) in place of a clip.
  const stillPicture = layered && layer === 'still';
  // A footage shot's start and end frames show as a pair, the end frame optional; an effect
  // from the start frame to the end frame needs both.
  const endFrames = Boolean(onGenerateEndFrame) && (layer === 'footage' || (stillPicture && isEndFrameImageEffect(scene.imageEffect)));
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
        <button type="button" onClick={() => applyPatch({ beatNeedsReview: false })} className="min-h-[44px] rounded border border-port-border px-2 sm:min-h-0">Mark beat ready</button>
      </div>}
      <textarea
        aria-label="Shot prompt"
        value={followsBoard ? boardDirection : scene.prompt || ''} rows={2}
        onChange={(e) => onEditLocal(scene.sceneId, { prompt: e.target.value })}
        onBlur={(e) => onSave(scene.sceneId, { prompt: boardDirection && e.target.value.trim() === boardDirection ? '' : e.target.value })}
        placeholder={layer === 'footage' ? 'Motion prompt: what happens in this shot' : "Shot prompt — what this scene's video should show"}
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
      />
      {boardDirection && (followsBoard ? (
        <p className="text-[11px] text-port-text-muted" data-testid="prompt-from-storyboard">From the storyboard panel · stays in sync</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-text-muted" data-testid="prompt-own">
          <span>This shot's own prompt, not the panel's</span>
          <button type="button" onClick={() => { onEditLocal(scene.sceneId, { prompt: '' }); onSave(scene.sceneId, { prompt: '' }); }} className="underline min-h-[44px] sm:min-h-0">Use storyboard direction</button>
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
    <SceneTimingPlan timing={timing} sceneId={scene.sceneId} lipSyncBackend={renderLane} onSplit={onSplit} onMergeNext={onMergeNext} onMergePrevious={onMergePrevious}
      span={sceneHasAuthoredSpan(scene) ? { startSec: scene.startSec, endSec: scene.endSec } : null} />
  );
  const settingsGroups = (
    <>
      <ShotEditorGroup title="Timing" summary={timingSummary} testId="shot-group-timing">
        {/* Whether the shot plays before the song (the cold open), with its own length. */}
        <PreMusicTiming fieldId={fieldId} scene={scene} onChange={applyPatch} />
        {/* Move the cut before this shot a frame at a time; the shot before ends where this one starts. */}
        {!preMusic && onMoveStart && sceneHasAuthoredSpan(scene) && (
          <SceneStartFrame id={fieldId('start-frame')} scene={scene} joinsPrevious={(scene.order ?? index) > 0} onMove={onMoveStart} />
        )}
        <div className="flex flex-wrap gap-2 items-center text-xs">
          {!preMusic && SCENE_TIME_FIELDS.map(([labelText, key]) => {
            const toValue = (v) => (v === '' ? null : Number(v));
            return (
              <label key={key} className="flex items-center gap-1">{labelText}
                <input type="number" min="0" step="0.1" value={scene[key] ?? ''} className="w-20 bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0"
                  onChange={(e) => onEditLocal(scene.sceneId, { [key]: toValue(e.target.value) })}
                  onBlur={(e) => onSave(scene.sceneId, { [key]: toValue(e.target.value) })} />
                {typeof scene[key] === 'number' && <span className="tabular-nums text-port-text-muted">fr {frameAt(scene[key])}</span>}
              </label>
            );
          })}
          <label className="flex items-center gap-1 min-h-[44px] sm:min-h-0">
            <input type="checkbox" checked={!!scene.beatAligned}
              onChange={(e) => { onEditLocal(scene.sceneId, { beatAligned: e.target.checked }); onSave(scene.sceneId, { beatAligned: e.target.checked }); }} />
            Beat-aligned
          </label>
          <label className="flex items-center gap-1 min-h-[44px] sm:min-h-0" title="Repeat the generated clip to fill a span longer than the clip. Off: the shot must be covered by its clip (trim, continue, or replace it).">
            <input type="checkbox" checked={loops} disabled={performance || clipReversed(scene)} onChange={(e) => applyPatch({ loop: e.target.checked })} />
            Loop clip
          </label>
        </div>
      </ShotEditorGroup>
      {preMusic && (
        <ShotEditorGroup title="Sound" summary={preMusicSoundSummary(scene.preMusic).toLowerCase()} testId="shot-group-sound">
          <PreMusicSound fieldId={fieldId} scene={scene} onChange={applyPatch} />
        </ShotEditorGroup>
      )}
      <ShotEditorGroup title="Transitions & effects" summary={effectsSummary} testId="shot-group-effects">
        {/* A VHS glitch riding on the cut into or out of this shot; never moves the cut. */}
        <SceneTransitions fieldId={fieldId} scene={scene} onChange={applyPatch} />
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
            className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0">
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
                className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0"
                title="Cutaway: any video lane animates the frame under the song. Lip-sync: a singer's mouth follows the song. Music-driven: the song slice drives the whole frame's motion (a drummer on the beat). Both need a source-audio provider.">
                {Object.entries(SHOT_MODE_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
              {/* #14241: neighbouring cutaways on one set can share one timed generation. */}
              {shotModeValue === 'cutaway' && (
                <>
                  <label htmlFor={fieldId('coverage')}>Coverage</label>
                  <select id={fieldId('coverage')} value={scene.coverage === 'sequence' ? 'sequence' : 'per-shot'}
                    onChange={(e) => applyPatch({ coverage: e.target.value })}
                    className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0"
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
                className="bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0 disabled:opacity-50">
                {STILL_MOVE_LABELS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </>
          )}
          {layer === 'card' && (
            <>
              <label htmlFor={fieldId('card-text')}>Card text</label>
              <input id={fieldId('card-text')} type="text" maxLength={500} value={scene.cardText || ''}
                placeholder="Title shown on the card"
                onChange={(e) => onEditLocal(scene.sceneId, { cardText: e.target.value })}
                onBlur={(e) => onSave(scene.sceneId, { cardText: e.target.value.trim() || null })}
                className="min-w-0 flex-1 basis-40 bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0" />
              <label htmlFor={fieldId('card-color')}>Background</label>
              <input id={fieldId('card-color')} type="color" value={scene.cardColor || '#000000'}
                onChange={(e) => onEditLocal(scene.sceneId, { cardColor: e.target.value })}
                onBlur={(e) => onSave(scene.sceneId, { cardColor: e.target.value })}
                className="h-8 w-10 min-h-[44px] sm:min-h-0 bg-port-bg border border-port-border rounded" />
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
  return (
    <div className="min-w-0">
    <details
      ref={detailsRef}
      id={`scene-${scene.sceneId}`}
      open={expanded != null ? expanded : undefined}
      onToggle={(e) => {
        onToggleExpand?.(scene.sceneId, e.currentTarget.open);
      }}
      className="group relative rounded-lg border border-port-border bg-port-card"
    >
      <summary
        onClick={() => onSeek?.(scene)}
        className="flex min-h-[44px] cursor-pointer select-none items-center gap-3 p-2 marker:content-none flex-wrap sm:group-open:pr-72 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-port-text-muted transition-transform group-open:rotate-90" />
        <ScenePoster scene={scene} iconSize={14} className="aspect-video w-16 shrink-0 rounded border border-port-border sm:w-20 max-sm:group-open:hidden" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {[shotNumber ? `Shot ${shotNumber}` : null, scene.sectionLabel || scene.label].filter(Boolean).join(' · ') || `Scene ${scene.order + 1}`}
          </div>
          <div className="truncate text-[11px] text-port-text-muted">
            {typeof scene.startSec === 'number' && typeof scene.endSec === 'number'
              ? `${(scene.endSec - scene.startSec).toFixed(2)}s · ${formatTimecode(scene.startSec)}–${formatTimecode(scene.endSec)} · ${frameSpan(scene)}`
              : `#${scene.order + 1}`}
            {scene.referenceImageId ? ' · frame ready' : ''}
            {scene.videoHistoryId ? ' · video ready' : ''}
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
        {/* Render status wraps under the title on a phone instead of squeezing it. */}
        {(generatingLane || generatingFrame || generatingVideo) && (
          <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 max-sm:basis-full max-sm:pl-6">
            {generatingLane && (
              <span className="flex items-center gap-1 text-[11px] text-port-accent">
                <Activity size={14} className="animate-spin" aria-label="Generating" />
                {generatingLane}
              </span>
            )}
            <SceneRenderProgress kind="Frame" generating={generatingFrame} progress={frameProgress} />
            <SceneRenderProgress kind="Video" generating={generatingVideo} progress={videoProgress} />
          </span>
        )}
      </summary>
      {/* The open card's shot arrows, lock and "…" menu: their own row under the title on a
          phone, the top-right corner from sm up. A move swaps this shot with its neighbor;
          the song timing and lyric stay with the slot. */}
      <div className="flex items-center justify-end gap-1 px-2 pb-2 sm:absolute sm:right-2 sm:top-2 sm:z-10 sm:p-0">
        {stepShot && (
          <span className="mr-auto flex items-center gap-1 sm:mr-0">
            <button type="button" onClick={stepShot.prev || undefined} disabled={!stepShot.prev} aria-label="Previous shot" title="Previous shot"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-port-border text-port-text hover:bg-port-border disabled:opacity-40 sm:min-h-[32px] sm:min-w-[32px]">
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <button type="button" onClick={stepShot.next || undefined} disabled={!stepShot.next} aria-label="Next shot" title="Next shot"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-port-border text-port-text hover:bg-port-border disabled:opacity-40 sm:min-h-[32px] sm:min-w-[32px]">
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </span>
        )}
        <OverflowMenu label="Shot actions" items={[
          { id: 'earlier', label: 'Move earlier', icon: ArrowUp, onSelect: () => onMove(index, -1), disabled: index === 0 || documentComposition },
          { id: 'later', label: 'Move later', icon: ArrowDown, onSelect: () => onMove(index, 1), disabled: isLast || documentComposition },
          { id: 'delete', label: 'Delete shot', icon: Trash2, tone: 'danger', onSelect: () => onDelete(scene.sceneId) },
        ]} />
      </div>
      <div className="space-y-3 p-3 pt-0">
        {documentComposition && (
          <p className="text-[11px] text-port-text-muted">Shot order comes from the composition document, so it can&apos;t be reordered here.</p>
        )}
        {songChange && !songChange.resolved && songChange.status !== 'kept' && (
          <p className="break-words text-[11px] text-port-warning">{songChange.status === 'new' ? 'New shot for lines the revised song added.' : `Before the song revision: ${songChange.previousLyricText ? `♪ ${songChange.previousLyricText}` : 'instrumental'}`}</p>
        )}
        {/* The storyboard panel this shot is drawn from, first: shots and panels are linked 1:1. */}
        <ShotStoryboardPanel projectId={project?.id} storyboardId={storyboardId} scene={scene} linked={storyboardShot}
          onSceneUpdated={onEditLocal} onUnlink={() => applyPatch({ panelId: null, panelRev: null, panelArt: null })} onBoard={onStoryboardBoard} />
        <SceneClipCoverageNotice scene={scene} playback={clipPlayback} onChange={applyPatch} />
        {layer !== 'footage' && layered && !sceneHasAuthoredSpan(scene) && (
          <p role="alert" className="text-[11px] text-port-warning">
            Set a start and end — a {{ card: 'title card', code: 'code-drawn shot' }[layer] || 'still'} runs for exactly its span.
          </p>
        )}
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
        <SceneFrames project={project} castMedia={castMedia} greyboxPlaces={greyboxPlaces} greyboxSaving={greyboxSaving} onGreyboxSaving={setGreyboxSaving} scene={scene} index={index} endFrames={endFrames} generatingFrame={!!generatingFrame} generatingEndFrame={!!generatingEndFrame}
          onGenerateFrame={onGenerateFrame} onGenerateEndFrame={onGenerateEndFrame} onEditLocal={onEditLocal} onSave={onSave}
          onOpenPreview={onOpenPreview} takeBusy={takeBusy} onSelectTake={onSelectTake} onReviewTake={onReviewTake}
          onSwap={onPlacePoolItem ? setSwapKind : null} onSwapFrames={onSwapFrames ? () => onSwapFrames(scene) : null} onImportTake={onImportTake}
          onContinueFromPrevious={layer === 'footage' && index > 0 ? onContinueFromPrevious : null} previousHasClip={previousHasClip}
          assetMarks={project?.assetMarks} onMarkTake={onMarkTake} />
        </div>
        {/* Clip: the picture and its takes, Render, the motion prompt and where it renders, then other ways to get a clip. */}
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
          <SceneTakeStrip scene={scene} kind="video" busy={takeBusy} grid
            onSelect={(take) => onSelectTake?.(scene, take)}
            onReview={(take, review) => onReviewTake?.(scene, take, review)}
            onOpenPreview={onOpenPreview} marks={project?.assetMarks} onMark={onMarkTake} />
          <div className="flex flex-wrap items-center gap-2">
            {storyboardDefault && (
              <SceneStoryboardClip refusal={storyboardRefusal} generatingFrame={!!generatingFrame}
                onClip={generateStoryboardClip} onStill={onGenerateFrame ? () => onGenerateFrame(scene) : null} />
            )}
            {!storyboardDefault && <button onClick={generateVideo}
              disabled={renderBlocked}
              className={PRIMARY_BUTTON}
              title={videoRefusal || (performance ? `${capability.style === 'music' ? "Animate this scene's frame to the song" : "Lip-sync this scene's frame to the song"} via ${capability.label} — ${performanceCost}`
                  : "Render this shot's clip from its still")}>
              {generatingVideo ? <Activity size={14} className="animate-spin" /> : <Video size={14} />}
              {generatingVideo ? 'Rendering…' : `Render${scene.videoHistoryId ? ' again' : ''}`}
            </button>}
          </div>
          {/* Why Render is off, on the card itself: a tooltip never shows on a phone. */}
          {videoRefusal && videoRefusal !== performanceBlocked && !generatingVideo && layer === 'footage' && !storyboardDefault && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-warning" data-testid="render-refusal">
              <span>{videoRefusal}</span>
            </div>
          )}
          {layer === 'footage' && promptField}
          {/* The camera move sits with the motion prompt and shows the text it adds to it. */}
          {layer === 'footage' && (
            <SceneCameraControls scene={scene} fieldId={fieldId} onEditLocal={onEditLocal} onSave={onSave}
              adds={cardRequest.promptAdditions.find((item) => item.id === 'camera-move')?.text || null} />
          )}
          {speakerField}
          <div className="flex flex-wrap items-center gap-2">
            <SceneRenderTarget id={fieldId('render-on')} value={renderPick} onChange={setRenderPick} performance={performance}
              options={renderOptions} onOptionsChange={setRenderOptions} scene={scene} models={videoModels} defaultModel={defaultVideoModel}
              saved={falVideoSettings || {}} disabled={!!generatingVideo} />
            {renderCost && <span className="text-[11px] text-port-text-muted">{renderCost}</span>}
          </div>
          {timingPlan}
          {layer === 'footage' && (
            <SceneRenderInputs id={fieldId('inputs')} request={cardRequest} onChange={(patch) => setRenderInputs((prev) => ({ ...prev, ...patch }))}
              grokPreview={expanded && (!renderSettings?.backend || renderSettings.backend === 'grok') && project?.id && scene.referenceImageId ? {
                ...(renderSettings?.backend ? { backend: renderSettings.backend } : {}), prompt: cardRequest.authored, mode: 'image', sourceImageFile: scene.referenceImageId,
                grokDuration: renderSettings?.backend === 'grok' ? grokSceneRequestDuration(scene, renderSettings, renderOverrides) : renderSettings?.grokDuration,
                musicVideo: { projectId: project.id, sceneId: scene.sceneId, compose: true, promptAsTyped: true },
              } : null} previewRevision={JSON.stringify([project?.updatedAt, castMedia])} />
          )}
          {layer === 'footage' && scene.coverage === 'sequence' && <SceneSequenceCoverage project={project} scene={scene} />}
          {endFramePlan.endImageId && (
            <p className={`text-[11px] ${endFramePlan.used ? 'text-port-text-muted' : 'text-port-warning'}`} data-testid="end-frame-plan">
              {endFramePlan.used ? 'The clip ends on the end frame.' : `${endFramePlan.reason}.`}
            </p>
          )}
          {/* Other ways to fill the shot, after Render and its settings so Render stays the one action under the takes. */}
          {(onPlacePoolItem || onImportClipTake || (scene.videoHistoryId && canContinueShot)) && (
          <div className="flex flex-wrap items-center gap-2" data-testid="clip-other-sources">
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
          )}
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
        {project?.composition?.mode === 'composed' && <ShotFinalRender project={project} scene={scene} onChange={applyPatch} fieldId={fieldId} />}
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
      </div>
      {swapKind && (
        <SceneTakePicker open onClose={() => setSwapKind(null)} projectId={projectId} scene={scene} kind={swapKind}
          shotNumbers={shotNumbers} busy={takeBusy} onPlace={(pick) => onPlacePoolItem?.(scene, pick)}
          onMarked={(result) => onPoolMarked?.(projectId, result)} />
      )}
    </details>
    {failure && (
      <div className="mt-1 flex items-start gap-2 rounded border border-port-error/40 bg-port-error/10 px-2 py-1 text-xs text-port-error">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">
          {failure.lane === 'video' ? 'Video' : 'Frame'} failed: {failure.error}
        </span>
        <button type="button"
          onClick={() => (failure.lane === 'video' ? generateVideo() : onGenerateFrame?.(scene))}
          disabled={failure.lane === 'video' && renderBlocked}
          title={failure.lane === 'video' ? videoRefusal || undefined : undefined}
          className="inline-flex min-h-[44px] shrink-0 items-center px-1 font-medium underline disabled:opacity-50 sm:min-h-0">
          Retry
        </button>
      </div>
    )}
    </div>
  );
}
