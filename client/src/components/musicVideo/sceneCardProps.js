import { sceneButtonClass as SECONDARY_BUTTON } from './controlClasses.js';
import { CLIP_TIMING_FPS } from '../../lib/musicVideoLayers.js';

// #8985: what a composed render shows for this scene's span.
export const LAYER_LABELS = { footage: 'Footage', still: 'Still image', card: 'Title card', code: 'Code-drawn' };
export const STILL_MOVE_LABELS = [['hold', 'Hold'], ['push', 'Push in'], ['pan', 'Pan']];
// #10583: the shared lyric type's zone and style for this shot (composition documents).
export const SHOT_MODE_LABELS = { cutaway: 'Cutaway', performance: 'Performance (lip-sync)', music: 'Performance (music-driven)' };
export const PRIMARY_BUTTON = 'flex items-center gap-1 bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[44px] pointer-fine:sm:min-h-0 whitespace-nowrap';
export const DOWNLOAD_FIELDS = new Set(['startSec', 'endSec', 'offsetFrames', 'speedFps', 'reverse', 'loop', 'holdLastFrame', 'sourceTake', 'videoHistoryId', 'frameFit', 'imageTreatments']);
// The two timeline-bound scene fields rendered as identical number inputs.
export const SCENE_TIME_FIELDS = [['Start', 'startSec'], ['End', 'endSec']];

// A time as a frame of the 24 fps cut grid, the numbers the director counts in.
export const frameAt = (sec) => Math.round(sec * CLIP_TIMING_FPS);
export const frameSpan = (scene) => `fr ${frameAt(scene.startSec)}–${frameAt(scene.endSec)}`;

// A clip already rendering never blocks another (#15128): a shot can render locally and on grok at once.
// #11040: the one owner of whether a video render may start.
export function videoGenerationRefusal({ settingsSaving, speakerUnsaved, referenceImageId, videoBlockedReason, performanceBlocked, needsStill = true }) {
  if (videoBlockedReason) return videoBlockedReason;
  if (performanceBlocked) return performanceBlocked;
  if (speakerUnsaved) return 'Save the speaker / singer edit first';
  if (settingsSaving) return 'Saving settings…';
  if (needsStill && !referenceImageId) return 'Generate a reference frame first';
  return null;
}

const pick = (group, legacy, key, fallback = undefined) => {
  if (group && group[key] !== undefined) return group[key];
  if (legacy && legacy[key] !== undefined) return legacy[key];
  return fallback;
};

/**
 * Normalizes SceneCard's domain-grouped props (`position`, `composition`, `media`, `takes`, `actions`)
 * while preserving backward compatibility with flat legacy props used by existing test suites.
 */
export function normalizeSceneCardProps({ position, composition, media, takes, actions, ...legacy }) {
  const pos = {
    index: pick(position, legacy, 'index'),
    isLast: pick(position, legacy, 'isLast'),
    shotName: pick(position, legacy, 'shotName', null),
    posterSrc: pick(position, legacy, 'posterSrc'),
    prevStartSec: pick(position, legacy, 'prevStartSec', null),
    nextEndSec: pick(position, legacy, 'nextEndSec', null),
    previousHasClip: pick(position, legacy, 'previousHasClip', false),
    stepShot: pick(position, legacy, 'stepShot', null),
  };

  const comp = {
    projectId: pick(composition, legacy, 'projectId', null),
    aspect: pick(composition, legacy, 'aspect', '16:9'),
    shotNumbers: pick(composition, legacy, 'shotNumbers', undefined),
    layered: pick(composition, legacy, 'layered', false),
    documentComposition: pick(composition, legacy, 'documentComposition', false),
    manifestOwnsShots: pick(composition, legacy, 'manifestOwnsShots', false),
    shotOrderOwner: pick(composition, legacy, 'shotOrderOwner', 'the composition document'),
    footageOptional: pick(composition, legacy, 'footageOptional', false),
    songDurationSec: pick(composition, legacy, 'songDurationSec', null),
    songReview: pick(composition, legacy, 'songReview', null),
    storyboardId: pick(composition, legacy, 'storyboardId', null),
    storyboardShot: pick(composition, legacy, 'storyboardShot', null),
  };

  const med = {
    generatingFrame: pick(media, legacy, 'generatingFrame'),
    generatingVideo: pick(media, legacy, 'generatingVideo'),
    generatingEndFrame: pick(media, legacy, 'generatingEndFrame', false),
    frameProgress: pick(media, legacy, 'frameProgress', null),
    videoProgress: pick(media, legacy, 'videoProgress', null),
    videoJobs: pick(media, legacy, 'videoJobs', null),
    settingsSaving: pick(media, legacy, 'settingsSaving'),
    videoBlockedReason: pick(media, legacy, 'videoBlockedReason'),
    videoBlockedReasonFor: pick(media, legacy, 'videoBlockedReasonFor', null),
    lipSyncBackend: pick(media, legacy, 'lipSyncBackend', ''),
    falVideoSettings: pick(media, legacy, 'falVideoSettings', null),
    videoModels: pick(media, legacy, 'videoModels', []),
    defaultVideoModel: pick(media, legacy, 'defaultVideoModel', ''),
    canContinueShot: pick(media, legacy, 'canContinueShot'),
    castMedia: pick(media, legacy, 'castMedia', null),
    greyboxPlaces: pick(media, legacy, 'greyboxPlaces', {}),
    failedScenes: pick(media, legacy, 'failedScenes', null),
    performanceReview: pick(media, legacy, 'performanceReview', null),
    repairBusy: pick(media, legacy, 'repairBusy', false),
  };

  const tk = {
    busy: takes?.busy !== undefined ? takes.busy : (legacy.takeBusy ?? false),
    pending: takes?.pending !== undefined ? takes.pending : (legacy.pendingTakes ?? null),
    checking: takes?.checking !== undefined ? takes.checking : (legacy.checkingTakes ?? null),
  };

  const act = {
    onMove: pick(actions, legacy, 'onMove'),
    onDelete: pick(actions, legacy, 'onDelete'),
    onEditLocal: pick(actions, legacy, 'onEditLocal'),
    onSave: pick(actions, legacy, 'onSave'),
    onApplySaved: pick(actions, legacy, 'onApplySaved', null),
    onSetDone: pick(actions, legacy, 'onSetDone', null),
    onApproveFinal: pick(actions, legacy, 'onApproveFinal', null),
    onSplit: pick(actions, legacy, 'onSplit'),
    onMergeNext: pick(actions, legacy, 'onMergeNext'),
    onMergePrevious: pick(actions, legacy, 'onMergePrevious', null),
    onMoveStart: pick(actions, legacy, 'onMoveStart', null),
    onMoveEnd: pick(actions, legacy, 'onMoveEnd', null),
    onRepairPerformance: pick(actions, legacy, 'onRepairPerformance'),
    onGenerateFrame: pick(actions, legacy, 'onGenerateFrame'),
    onGenerateEndFrame: pick(actions, legacy, 'onGenerateEndFrame'),
    onGenerateVideo: pick(actions, legacy, 'onGenerateVideo'),
    onContinueVideo: pick(actions, legacy, 'onContinueVideo'),
    onReloadCastMedia: pick(actions, legacy, 'onReloadCastMedia', null),
    onOpenPreview: pick(actions, legacy, 'onOpenPreview'),
    onSelectTake: pick(actions, legacy, 'onSelectTake'),
    onReviewTake: pick(actions, legacy, 'onReviewTake'),
    onRejectUnusedTakes: pick(actions, legacy, 'onRejectUnusedTakes', null),
    onSwapFrames: pick(actions, legacy, 'onSwapFrames', null),
    onMarkTake: pick(actions, legacy, 'onMarkTake', null),
    onCheckTake: pick(actions, legacy, 'onCheckTake', null),
    onPoolMarked: pick(actions, legacy, 'onPoolMarked', null),
    onImportTake: pick(actions, legacy, 'onImportTake'),
    onImportClipTake: pick(actions, legacy, 'onImportClipTake'),
    onPlacePoolItem: pick(actions, legacy, 'onPlacePoolItem'),
    onTrimClip: pick(actions, legacy, 'onTrimClip'),
    onHandheldClip: pick(actions, legacy, 'onHandheldClip', null),
    onContinueFromPrevious: pick(actions, legacy, 'onContinueFromPrevious'),
    onStoryboardBoard: pick(actions, legacy, 'onStoryboardBoard', null),
    onApplyCameos: pick(actions, legacy, 'onApplyCameos', null),
    onVaryWipes: pick(actions, legacy, 'onVaryWipes', null),
    onClose: pick(actions, legacy, 'onClose', null),
  };

  return { position: pos, composition: comp, media: med, takes: tk, actions: act };
}
