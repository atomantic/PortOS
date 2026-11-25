import { useRef } from 'react';
import toast from '../../ui/Toast';
import {
  addMusicVideoScene,
  approveMusicVideoFinal,
  cutMusicVideoScenesOnLyrics,
  deleteMusicVideoScene,
  getMusicVideoProject,
  mergeMusicVideoNextScene,
  mergeMusicVideoPreviousScene,
  moveMusicVideoSceneEnd,
  moveMusicVideoSceneStart,
  reorderMusicVideoScenes,
  splitMusicVideoScene,
  updateMusicVideoScene,
  varyMusicVideoWipes,
} from '../../../services/apiMusicVideo.js';
import { ownWrite } from '../../../services/socketWriteOrigin.js';
import useMusicVideoSceneMedia from '../../../hooks/useMusicVideoSceneMedia.js';
import useMusicVideoTakes from './useMusicVideoTakes.js';
import useMusicVideoRevisions from './useMusicVideoRevisions.js';
import useMusicVideoProduction from './useMusicVideoProduction.js';
import { createClipTimingWrites, isClipTimingPatch } from './clipTimingWrites.js';
import { compositionDraft } from '../compositionDraft.js';
import { isLtx2FamilyRuntime } from '../../../lib/runnerFamilies';
import { mergeCameoScenes } from '../../../lib/musicVideoCameos.js';
import { pluralize } from '../../../lib/textUtils.js';
import { formatTimecode } from '../../../utils/formatters.js';

/**
 * Shots step (Produce): per-shot media and takes, the board's shot edits
 * (add, split, merge, move, reorder, field saves), selective revisions and the
 * server production run.
 *
 * Shot edits name this tab on their request and patch the open project from the reply's edit
 * result (#16247), so neither the edit nor its change broadcast reads the whole project again.
 */
export default function useProduceStageWiring({
  selected, videoSettings, renderJob, productionReview, excerpts, unsavedSceneFields, takesRef, mergeFetchedProject,
  applyEdit, reloadOpenProject,
  replaceProject, patchProject, patchScene, editProjectLocal, saveProjectFields, seekToScene, routeSceneId, navigate, sceneStage = 'produce',
}) {
  const sceneMedia = useMusicVideoSceneMedia({
    project: selected,
    videoSettings,
    applyScenePatch: patchScene,
    // Renders that finished while the socket was down missed their attach events.
    onReconciled: (projectId) => getMusicVideoProject(projectId, { silent: true }).then(replaceProject).catch(() => {}),
  });
  const timingWrites = useRef(null);
  timingWrites.current ??= createClipTimingWrites();
  const takes = useMusicVideoTakes({ project: selected, applyScenePatch: patchScene, patchProject, reloadProject: mergeFetchedProject, applyEdit,
    beforeWrite: () => timingWrites.current.settled(),
  });
  // The page's change listener reads through it; the workspace remounts per project.
  takesRef.current = takes;
  // Selective section revision (#8987): regenerate only a draft's flagged
  // sections, resumable from the server's checkpoint.
  const revisions = useMusicVideoRevisions({ project: selected, replaceProject, sceneMedia, attachRender: excerpts.attachRender });
  const production = useMusicVideoProduction({ project: selected, replaceProject });

  // One shot edit from this tab: sent with its origin, so its own change broadcast is skipped, and
  // its reply's edit result patched in. A take decision that started while it was in flight may be
  // newer than the reply, and a refused (409) edit may leave the board behind: both reload instead.
  // Resolves to the reply.
  const boardEdit = (send) => {
    const projectId = selected.id;
    const mark = takes.writeMark();
    return send(projectId, ownWrite()).then((reply) => {
      if (reply?.edit && takes.settledSince(mark)) applyEdit(projectId, reply.edit);
      else void reloadOpenProject(projectId);
      return reply;
    }, (err) => {
      if (err?.status === 409) void reloadOpenProject(projectId);
      throw err;
    });
  };
  // A field save's PATCH: the saved scene, with the edit result beside its fields.
  const saveSceneFields = (sceneId, patch) => boardEdit((projectId, options) => updateMusicVideoScene(projectId, sceneId, patch, options));

  const handleToggleSceneExpand = (sceneId, isExpanded) => {
    if (!selected) return;
    // The stage showing the shot: Shots, or the editor when the shot was opened there.
    const stage = sceneStage;
    if (isExpanded) {
      navigate(`/music-video/${selected.id}/${stage}/scene/${sceneId}`, { replace: true });
    } else if (routeSceneId === sceneId) {
      navigate(`/music-video/${selected.id}/${stage}`, { replace: true });
    }
  };

  const handleAddScene = () => {
    boardEdit((projectId, options) => addMusicVideoScene(projectId, { prompt: '' }, options))
      .catch((err) => toast.error(err?.message || 'Failed to add scene'));
  };

  // A render refusal's one-tap fix: the same patch on each shot it names.
  // Sequential, like auto-arrange, so each PATCH merges against the last.
  const patchShots = (sceneIds, patch, doneMessage) => {
    if (!selected || !sceneIds.length) return Promise.resolve();
    const snapshot = selected;
    const ids = new Set(sceneIds);
    replaceProject({ ...selected, scenes: selected.scenes.map((s) => (ids.has(s.sceneId) ? { ...s, ...patch } : s)) });
    return (async () => {
      for (const sceneId of sceneIds) await saveSceneFields(sceneId, patch);
    })()
      .then(() => {
        renderJob.clearFailure();
        toast.success(`${doneMessage} — render again`);
      })
      .catch((err) => {
        replaceProject(snapshot);
        void reloadOpenProject(snapshot.id);
        toast.error(err?.message || 'Could not change the shots');
      });
  };

  // Optimistic local edit; PATCH on blur (silent — this owns its error toast).
  const editSceneLocal = (sceneId, patch) => {
    const keys = unsavedSceneFields.current.get(sceneId) || new Set();
    Object.keys(patch).forEach((k) => keys.add(k));
    unsavedSceneFields.current.set(sceneId, keys);
    // Reads the current project: shot sheet Apply calls this repeatedly from one retained closure.
    patchProject(selected.id, (project) => ({ scenes: project.scenes?.map((s) => (s.sceneId === sceneId ? { ...s, ...patch } : s)) }));
  };
  const persistScene = async (sceneId, patch) => {
    try {
      await saveSceneFields(sceneId, patch);
      for (const field of Object.keys(patch)) {
        if (!timingWrites.current.hasNewerField(sceneId, field)) unsavedSceneFields.current.get(sceneId)?.delete(field);
      }
      return true;
    } catch (err) {
      toast.error(err?.message || 'Failed to save scene');
      return false;
    }
  };

  const saveScene = (sceneId, patch) => isClipTimingPatch(patch)
    ? timingWrites.current.enqueue(sceneId, patch, persistScene)
    : persistScene(sceneId, patch);

  const setSceneDone = (sceneId, checked) => {
    const scene = selected.scenes?.find((entry) => entry.sceneId === sceneId);
    if (!scene) return Promise.resolve(false);
    // The reply's edit result carries the ticked shot and the "Needs attention" counts it changes.
    return saveScene(sceneId, { shotSheet: { checked } });
  };

  // #16136: tick or clear shots for the final upgrade. Only `finalApproval` changes here, from the server's reply.
  const approveFinal = (sceneIds, approved) => boardEdit((projectId, options) => approveMusicVideoFinal(projectId, { sceneIds, approved }, options))
    .then(() => true)
    .catch((err) => { toast.error(err?.message || 'Could not change the final approval'); return false; });

  // BeatTimeline drag commit — same optimistic-local + silent-PATCH pattern as
  // the other scene field editors (#1854).
  const commitSceneTiming = (sceneId, patch) => {
    editSceneLocal(sceneId, patch);
    saveScene(sceneId, patch);
  };

  const handleDeleteScene = (sceneId) => {
    boardEdit((projectId, options) => deleteMusicVideoScene(projectId, sceneId, options))
      .catch((err) => toast.error(err?.message || 'Failed to delete scene'));
  };

  // #8977: split a shot its backend cannot render in one take on lyric/phrase
  // boundaries. `backend` is the lane the card measured against.
  // `atSec` cuts the shot in two at that song time instead (the card's "Split shot").
  const handleSplitScene = (sceneId, backend, atSec = null) => {
    boardEdit((projectId, options) => splitMusicVideoScene(projectId, sceneId, backend, { atSec, ...options }))
      .then(({ scenes }) => {
        toast.success(`Split into ${pluralize(scenes.length, 'shot')}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to split scene'));
  };

  // Cut the board on sung words over a run of lyric lines (#14820).
  const handleCutOnLyrics = ({ cueIds, mode }) => boardEdit((projectId, options) => cutMusicVideoScenesOnLyrics(projectId, { cueIds, mode }, options))
    .then(({ scenes, skipped, laidOut }) => {
      toast.success(`${laidOut ? 'Laid out' : 'Cut'} ${pluralize(scenes.length, 'shot')} on the words${skipped ? ` (${pluralize(skipped, 'word')} skipped: ${laidOut ? '' : 'outside a shot or '}too close to a cut)` : ''}`);
    })
    .catch((err) => toast.error(err?.message || 'Failed to cut on the lyric words'));

  // Join a scene with the next one (the inverse of the split above).
  const handleMergeNextScene = (sceneId, backend) => {
    boardEdit((projectId, options) => mergeMusicVideoNextScene(projectId, sceneId, backend, options))
      .then(() => toast.success('Merged with the next shot'))
      .catch((err) => toast.error(err?.message || 'Failed to merge scenes'));
  };

  // Extend a scene back over the previous one, which is removed (the mirror of the merge above).
  const handleMergePreviousScene = (sceneId, backend) => {
    boardEdit((projectId, options) => mergeMusicVideoPreviousScene(projectId, sceneId, backend, options))
      .then(() => toast.success('Merged over the previous shot'))
      .catch((err) => toast.error(err?.message || 'Failed to merge scenes'));
  };

  // Move the cut before a shot: it starts at `startSec` and the shot before it ends there.
  const handleMoveSceneStart = (sceneId, startSec) => boardEdit((projectId, options) => moveMusicVideoSceneStart(projectId, sceneId, startSec, options))
    .catch((err) => toast.error(err?.message || 'Failed to move the shot start'));

  // Move the cut after a shot: it ends at `endSec` and the next shot starts there, growing or shrinking.
  const handleMoveSceneEnd = (sceneId, endSec) => boardEdit((projectId, options) => moveMusicVideoSceneEnd(projectId, sceneId, endSec, options))
    .catch((err) => toast.error(err?.message || 'Failed to change the shot length'));

  // Reorder the board to `ids` (every scene id once); `moved` is the shot the director moved.
  // The server keeps each slot's song timing and lyric and moves the shots
  // between them, so the moved shot now plays at the time of the slot it took.
  const reorderShots = (ids, moved) => {
    const wasApproved = !!productionReview.readiness?.storyboard?.approved;
    return boardEdit((projectId, options) => reorderMusicVideoScenes(projectId, ids, options))
      .then(({ edit }) => {
        // Reordering keeps each slot's timing: the moved shot's new time is in the reply.
        const now = edit?.scenes?.find((s) => s.sceneId === moved.sceneId);
        if (now) seekToScene(now);
        const at = typeof now?.startSec === 'number' ? ` to ${formatTimecode(now.startSec)}` : '';
        toast.success(`Moved ${moved.label || 'shot'}${at}${wasApproved ? '; re-approve the storyboard' : ''}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to reorder'));
  };
  const moveScene = (idx, dir) => {
    const scenes = selected.scenes || [];
    const target = idx + dir;
    if (target < 0 || target >= scenes.length) return;
    const ids = scenes.map((s) => s.sceneId);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    reorderShots(ids, scenes[idx]);
  };

  const canContinueShot = videoSettings.settings.backend === 'local'
    && videoSettings.settings.generationMode === 'image'
    && isLtx2FamilyRuntime(videoSettings.activeModel?.runtime);

  return {
    sceneMedia,
    takes,
    revisions,
    production,
    board: {
      activeSceneId: routeSceneId || null,
      onToggleSceneExpand: handleToggleSceneExpand,
      sceneMedia,
      onPatchShots: patchShots,
      production,
      takes,
      revisions,
      canContinueShot,
      saveCompositionGrade: (patch) => saveProjectFields(patch),
      applyShotReferenceRepair: ({ sceneId, patch, updatedAt }) => patchProject(selected.id, (project) => {
        if (project.updatedAt > updatedAt) return {};
        const unsaved = unsavedSceneFields.current.get(sceneId);
        const saved = Object.fromEntries(Object.entries(patch).filter(([field]) => !unsaved?.has(field)));
        return { scenes: project.scenes?.map(scene => scene.sceneId === sceneId ? { ...scene, ...saved } : scene), updatedAt };
      }),
      // A roster edit answers the shots it may have refilled; only their cameo fields and still change here.
      applyCameos: ({ cameos, scenes, updatedAt }) => patchProject(selected.id, (p) => ({
        cameos,
        scenes: mergeCameoScenes(p.scenes, scenes),
        ...(updatedAt ? { updatedAt } : {}),
      })),
      // "Vary wipes": a wipe out of each of `count` shots from this one; only their cut-out fields change here.
      varyWipes: (fromSceneId, count) => boardEdit((projectId, options) => varyMusicVideoWipes(projectId, { fromSceneId, count, seed: Math.floor(Math.random() * 2147483646) }, options))
        .then(({ scenes }) => {
          toast.success(`Wipes on ${scenes.length} cut${scenes.length === 1 ? '' : 's'}`);
        })
        .catch((err) => toast.error(err?.message || 'Failed to vary the wipes')),
      onAddScene: handleAddScene,
      onDeleteScene: handleDeleteScene,
      onSplitScene: handleSplitScene,
      onCutOnLyrics: handleCutOnLyrics,
      onMergeNextScene: handleMergeNextScene,
      onMergePreviousScene: handleMergePreviousScene,
      onMoveSceneStart: handleMoveSceneStart,
      onMoveSceneEnd: handleMoveSceneEnd,
      onRepairPerformance: revisions.repairPerformance,
      repairBusy: revisions.busy,
      onRenderStyle: (mode) => {
        const composition = compositionDraft(selected, { mode });
        editProjectLocal({ composition });
        saveProjectFields({ composition });
      },
      editSceneLocal,
      // A shot change a route already saved: patched in without marking the fields as typed and unsaved.
      applySavedScene: (sceneId, patch) => patchScene(selected.id, sceneId, patch),
      saveScene,
      setSceneDone,
      approveFinal,
      moveScene,
      reorderShots,
      commitSceneTiming,
    },
  };
}
