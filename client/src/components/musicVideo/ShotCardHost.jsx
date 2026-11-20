import { useEffect, useState } from 'react';
import SceneCard from './SceneCard.jsx';
import { shotNumbers } from './ShotStepper.jsx';
import { blenderShotThumbPath } from '../../lib/musicVideoBlender.js';
import { musicVideoBlenderMediaUrl } from '../../services/apiMusicVideo.js';
import { previousShot, shotHandoffSource } from '../../../../server/lib/musicVideo/musicVideoHandoffFrame.js';
import { coldOpenScenes } from '../../../../server/lib/musicVideo/musicVideoColdOpen.js';
import { isLayeredComposition } from '../../lib/musicVideoLayers.js';
import { musicVideoAspect } from '../../lib/musicVideoAspect.js';
import { FOOTAGE_OPTIONAL_MODES, sceneShotName } from '../../lib/musicVideoStages.js';
import { getStoryboard } from '../../services/api';
import { storyboardShotPanel } from '../../../../server/lib/storyboardFit.js';

/** The video's linked storyboard, read when its shots open (null when none is linked or it is gone). */
export function useLinkedStoryboard(storyboardId) {
  const [board, setBoard] = useState(null);
  useEffect(() => {
    setBoard(null);
    if (!storyboardId) return undefined;
    let active = true;
    getStoryboard(storyboardId, { silent: true }).then((next) => { if (active) setBoard(next); }).catch(() => {});
    return () => { active = false; };
  }, [storyboardId]);
  return [board, setBoard];
}

/** A Blender film's shot thumbnails by scene id (empty for any other render style): they are workspace files, not takes. */
export function blenderShotPosters(project, blender) {
  const posters = new Map();
  if (project.composition?.mode !== 'blender') return posters;
  const state = blender?.state;
  for (const shot of state?.manifest?.shots || []) {
    const sceneId = project.blender?.sceneMap?.[shot.id] || shot.sceneId;
    const path = blenderShotThumbPath(state, shot);
    if (sceneId && path) posters.set(sceneId, musicVideoBlenderMediaUrl(project.id, path));
  }
  return posters;
}

/** Each shot's name as the board and the player count it: its number in song order, or its place in the cold open. */
export function shotNamer(project) {
  const numbers = shotNumbers(project.scenes || []);
  const coldNumbers = new Map(coldOpenScenes(project).map((scene, i) => [scene.sceneId, i + 1]));
  const shotName = (scene) => sceneShotName(scene, { number: numbers.get(scene.sceneId), coldOpen: coldNumbers.get(scene.sceneId) });
  // Play order: the cold open first, then the song.
  const playOrder = (scene) => (coldNumbers.has(scene.sceneId) ? coldNumbers.get(scene.sceneId) - coldNumbers.size
    : numbers.get(scene.sceneId) ?? Infinity);
  return { numbers, shotName, playOrder };
}

/** The newest auto-review reading of each shot's selected clip, keyed `sceneId:takeId`. */
function performanceReviewsOf(project) {
  const reviews = new Map();
  const attempts = (project.autoReviews || []).flatMap((run) => run.attempts || []).slice().reverse();
  for (const attempt of attempts) {
    const temporal = attempt.review?.evidence?.temporal;
    for (const shot of temporal?.shots || []) {
      const key = `${shot.sceneId}:${shot.takeId}`;
      if (!reviews.has(key)) reviews.set(key, {
        shot: { ...shot, status: attempt.review.dependencyState?.status === 'current' ? temporal.status : 'unverified', lipSync: attempt.review.checks?.lipSync, analyzer: temporal.analyzer },
        excerptStartSec: attempt.review.evidence.excerptStartSec,
        excerptId: attempt.excerptId,
      });
    }
  }
  return reviews;
}

/**
 * One shot's card wired to the Shots board's edits, media and takes, so every
 * surface that opens a shot (the scene board's drawer, the editor's inspector)
 * edits it the same way. `storyboard` / `onStoryboard` are `useLinkedStoryboard`;
 * `onClose` closes the card and `onOpenShot(scene)` opens another (previous /
 * next walk every shot in play order).
 */
export default function ShotCardHost({ board, sceneId, storyboard = null, onStoryboard, onClose, onOpenShot }) {
  const { project, locked, sceneMedia, videoSettings, takes } = board;
  const scenes = project.scenes || [];
  const idx = scenes.findIndex((scene) => scene.sceneId === sceneId);
  if (idx < 0) return null;
  const scene = scenes[idx];
  const { numbers, shotName, playOrder } = shotNamer(project);
  const songOrder = [...scenes].sort((a, b) => playOrder(a) - playOrder(b));
  const at = songOrder.findIndex((entry) => entry.sceneId === sceneId);
  const step = (target) => target && (() => onOpenShot(target));
  const mode = project.composition?.mode || 'concat';
  return (
    <SceneCard
      key={scene.sceneId}
      scene={scene}
      project={project}
      locked={locked}
      position={{
        index: idx,
        isLast: idx === scenes.length - 1,
        shotName: shotName(scene),
        posterSrc: blenderShotPosters(project, board.blender).get(sceneId),
        prevStartSec: scenes[idx - 1]?.startSec ?? null,
        nextEndSec: scenes[idx + 1]?.endSec ?? null,
        // The server's own neighbor rule: the shot before this one by start time.
        previousHasClip: Boolean(shotHandoffSource(project, previousShot(project, scene.sceneId))),
        stepShot: { prev: step(songOrder[at - 1]), next: step(songOrder[at + 1]) },
      }}
      composition={{
        projectId: project.id,
        aspect: musicVideoAspect(project),
        shotNumbers: numbers,
        layered: isLayeredComposition(project),
        documentComposition: mode === 'document',
        // A Blender film's shots are mirrored from its scripts by the sync, so their order is the film's.
        manifestOwnsShots: mode === 'blender' || (mode === 'document' && project.productionReview?.draft?.storyboardSource === 'document'),
        shotOrderOwner: mode === 'blender' ? 'the Blender film scripts' : 'the composition document',
        footageOptional: FOOTAGE_OPTIONAL_MODES.has(mode),
        songDurationSec: project.audioAnalysis?.durationSec ?? null,
        songReview: project.songRevision?.sceneReview || null,
        storyboardId: project.storyboardId || null,
        // Until the board is read, a fitted shot shows no panel state rather than a false "deleted".
        storyboardShot: storyboard ? storyboardShotPanel(storyboard, scene) : null,
      }}
      media={{
        generatingFrame: sceneMedia.genScenes[scene.sceneId],
        generatingVideo: sceneMedia.genVideoScenes[scene.sceneId],
        generatingEndFrame: sceneMedia.genEndFrameScenes?.[scene.sceneId],
        frameProgress: sceneMedia.sceneProgress?.[scene.sceneId],
        videoProgress: sceneMedia.videoSceneProgress?.[scene.sceneId],
        videoJobs: sceneMedia.videoSceneJobs?.[scene.sceneId] || [],
        settingsSaving: videoSettings.saving,
        videoBlockedReason: videoSettings.videoBlockedReason,
        videoBlockedReasonFor: videoSettings.blockedReasonFor,
        lipSyncBackend: videoSettings.audioReactiveSelected ? 'local' : videoSettings.settings.backend,
        falVideoSettings: videoSettings.settings,
        videoModels: videoSettings.models,
        defaultVideoModel: videoSettings.defaultModel,
        canContinueShot: board.canContinueShot,
        castMedia: sceneMedia.castMedia,
        greyboxPlaces: sceneMedia.greyboxPlaces,
        failedScenes: sceneMedia.failedScenes,
        performanceReview: performanceReviewsOf(project).get(`${scene.sceneId}:${scene.videoHistoryId}`),
        repairBusy: board.repairBusy || videoSettings.saving,
      }}
      takes={{
        busy: takes.busy,
        pending: takes.pending,
        checking: takes.checking,
      }}
      actions={{
        onMove: board.moveScene,
        onDelete: board.onDeleteScene,
        onEditLocal: board.editSceneLocal,
        onSave: board.saveScene,
        onApplySaved: board.applySavedScene,
        onSetDone: board.setSceneDone,
        onApproveFinal: board.approveFinal,
        onSplit: board.onSplitScene,
        onMergeNext: board.onMergeNextScene,
        onMergePrevious: board.onMergePreviousScene,
        onMoveStart: board.onMoveSceneStart,
        onMoveEnd: board.onMoveSceneEnd,
        onRepairPerformance: ['code', 'document', 'blender'].includes(mode) ? null : board.onRepairPerformance,
        onGenerateFrame: sceneMedia.generateFrame,
        onGenerateEndFrame: sceneMedia.generateEndFrame,
        onGenerateVideo: sceneMedia.generateSceneVideo,
        onContinueVideo: sceneMedia.continueSceneVideo,
        onReloadCastMedia: sceneMedia.reloadCastMedia,
        onOpenPreview: board.openPreview,
        onSelectTake: takes.selectTake,
        onReviewTake: takes.reviewTake,
        onRejectUnusedTakes: takes.rejectUnusedTakes,
        onSwapFrames: takes.swapFrames,
        onMarkTake: takes.markTake,
        onCheckTake: takes.checkTake,
        onPoolMarked: takes.applyPoolMarks,
        onImportTake: (target) => board.setPickerTarget({ type: 'take', sceneId: target.sceneId }),
        onImportClipTake: (target) => board.setPickerTarget({ type: 'clip', sceneId: target.sceneId }),
        onPlacePoolItem: takes.placePoolItem,
        onTrimClip: takes.trimClipTake,
        onHandheldClip: takes.handheldClipTake,
        onContinueFromPrevious: takes.continueFromPrevious,
        onStoryboardBoard: onStoryboard,
        onApplyCameos: board.applyCameos,
        onVaryWipes: board.varyWipes,
        onClose,
      }}
    />
  );
}
