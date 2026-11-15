import toast from '../../ui/Toast';
import {
  addMusicVideoScene,
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
import useMusicVideoSceneMedia from '../../../hooks/useMusicVideoSceneMedia.js';
import useMusicVideoTakes from '../../../hooks/useMusicVideoTakes.js';
import useMusicVideoRevisions from '../../../hooks/useMusicVideoRevisions.js';
import useMusicVideoProduction from '../../../hooks/useMusicVideoProduction.js';
import { compositionDraft } from '../compositionDraft.js';
import { isLtx2FamilyRuntime } from '../../../lib/runnerFamilies';
import { mergeCameoScenes } from '../../../lib/musicVideoCameos.js';
import { pluralize } from '../../../lib/textUtils.js';
import { formatTimecode } from '../../../utils/formatters.js';

/**
 * Shots step (Produce): per-shot media and takes, the board's shot edits
 * (add, split, merge, move, reorder, field saves), selective revisions and the
 * server production run.
 */
export default function useProduceStageWiring({
  selected, videoSettings, renderJob, productionReview, excerpts, unsavedSceneFields, takesRef, mergeFetchedProject,
  replaceProject, patchProject, patchScene, editProjectLocal, saveProjectFields, seekToScene, routeSceneId, navigate,
}) {
  const sceneMedia = useMusicVideoSceneMedia({
    project: selected,
    videoSettings,
    applyScenePatch: patchScene,
    // Renders that finished while the socket was down missed their attach events.
    onReconciled: (projectId) => getMusicVideoProject(projectId, { silent: true }).then(replaceProject).catch(() => {}),
  });
  const takes = useMusicVideoTakes({ project: selected, applyScenePatch: patchScene, patchProject, reloadProject: mergeFetchedProject });
  // The page's change listener reads through it; the workspace remounts per project.
  takesRef.current = takes;
  // Selective section revision (#8987): regenerate only a draft's flagged
  // sections, resumable from the server's checkpoint.
  const revisions = useMusicVideoRevisions({ project: selected, replaceProject, sceneMedia, attachRender: excerpts.attachRender });
  const production = useMusicVideoProduction({ project: selected, replaceProject });

  const handleToggleSceneExpand = (sceneId, isExpanded) => {
    if (!selected) return;
    const stage = 'produce';
    if (isExpanded) {
      navigate(`/music-video/${selected.id}/${stage}/scene/${sceneId}`, { replace: true });
    } else if (routeSceneId === sceneId) {
      navigate(`/music-video/${selected.id}/${stage}`, { replace: true });
    }
  };

  const handleAddScene = () => {
    addMusicVideoScene(selected.id, { prompt: '' }, { silent: true })
      .then((scene) => replaceProject({ ...selected, scenes: [...(selected.scenes || []), scene] }))
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
      for (const sceneId of sceneIds) await updateMusicVideoScene(selected.id, sceneId, patch, { silent: true });
    })()
      .then(() => {
        renderJob.clearFailure();
        toast.success(`${doneMessage} — render again`);
      })
      .catch((err) => {
        replaceProject(snapshot);
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
  const saveScene = (sceneId, patch) => {
    return updateMusicVideoScene(selected.id, sceneId, patch, { silent: true })
      .then(() => { Object.keys(patch).forEach((k) => unsavedSceneFields.current.get(sceneId)?.delete(k)); return true; })
      .catch((err) => { toast.error(err?.message || 'Failed to save scene'); return false; });
  };

  const setSceneDone = (sceneId, checked) => {
    const scene = selected.scenes?.find((entry) => entry.sceneId === sceneId);
    if (!scene) return Promise.resolve(false);
    return saveScene(sceneId, { shotSheet: { checked } }).then((saved) => {
      if (saved) patchProject(selected.id, (project) => ({ scenes: project.scenes?.map((entry) => entry.sceneId === sceneId
        ? { ...entry, shotSheet: { ...entry.shotSheet, checked } } : entry) }));
      return saved;
    });
  };

  // BeatTimeline drag commit — same optimistic-local + silent-PATCH pattern as
  // the other scene field editors (#1854).
  const commitSceneTiming = (sceneId, patch) => {
    editSceneLocal(sceneId, patch);
    saveScene(sceneId, patch);
  };

  const handleDeleteScene = (sceneId) => {
    deleteMusicVideoScene(selected.id, sceneId, { silent: true })
      .then((proj) => replaceProject(proj))
      .catch((err) => toast.error(err?.message || 'Failed to delete scene'));
  };

  // #8977: split a shot its backend cannot render in one take on lyric/phrase
  // boundaries. `backend` is the lane the card measured against.
  // `atSec` cuts the shot in two at that song time instead (the card's "Split shot").
  const handleSplitScene = (sceneId, backend, atSec = null) => {
    splitMusicVideoScene(selected.id, sceneId, backend, { atSec, silent: true })
      .then(({ project, scenes }) => {
        replaceProject(project);
        toast.success(`Split into ${pluralize(scenes.length, 'shot')}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to split scene'));
  };

  // Cut the board on sung words over a run of lyric lines (#14820).
  const handleCutOnLyrics = ({ cueIds, mode }) => cutMusicVideoScenesOnLyrics(selected.id, { cueIds, mode }, { silent: true })
    .then(({ project, scenes, skipped, laidOut }) => {
      replaceProject(project);
      toast.success(`${laidOut ? 'Laid out' : 'Cut'} ${pluralize(scenes.length, 'shot')} on the words${skipped ? ` (${pluralize(skipped, 'word')} skipped: ${laidOut ? '' : 'outside a shot or '}too close to a cut)` : ''}`);
    })
    .catch((err) => toast.error(err?.message || 'Failed to cut on the lyric words'));

  // Join a scene with the next one (the inverse of the split above).
  const handleMergeNextScene = (sceneId, backend) => {
    mergeMusicVideoNextScene(selected.id, sceneId, backend, { silent: true })
      .then(({ project }) => {
        replaceProject(project);
        toast.success('Merged with the next shot');
      })
      .catch((err) => toast.error(err?.message || 'Failed to merge scenes'));
  };

  // Extend a scene back over the previous one, which is removed (the mirror of the merge above).
  const handleMergePreviousScene = (sceneId, backend) => {
    mergeMusicVideoPreviousScene(selected.id, sceneId, backend, { silent: true })
      .then(({ project }) => {
        replaceProject(project);
        toast.success('Merged over the previous shot');
      })
      .catch((err) => toast.error(err?.message || 'Failed to merge scenes'));
  };

  // Move the cut before a shot: it starts at `startSec` and the shot before it ends there.
  const handleMoveSceneStart = (sceneId, startSec) => moveMusicVideoSceneStart(selected.id, sceneId, startSec, { silent: true })
    .then(({ project }) => replaceProject(project))
    .catch((err) => toast.error(err?.message || 'Failed to move the shot start'));

  // Move the cut after a shot: it ends at `endSec` and the next shot starts there, growing or shrinking.
  const handleMoveSceneEnd = (sceneId, endSec) => moveMusicVideoSceneEnd(selected.id, sceneId, endSec, { silent: true })
    .then(({ project }) => replaceProject(project))
    .catch((err) => toast.error(err?.message || 'Failed to change the shot length'));

  const moveScene = (idx, dir) => {
    const scenes = selected.scenes || [];
    const target = idx + dir;
    if (target < 0 || target >= scenes.length) return;
    const ids = scenes.map((s) => s.sceneId);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    // The server keeps each slot's song timing and lyric and moves the shots
    // between them, so the moved shot now plays at its neighbor's time.
    const moved = scenes[idx];
    const wasApproved = !!productionReview.readiness?.storyboard?.approved;
    reorderMusicVideoScenes(selected.id, ids, { silent: true })
      .then((proj) => {
        replaceProject(proj);
        const now = (proj.scenes || []).find((s) => s.sceneId === moved.sceneId);
        if (now) seekToScene(now);
        const at = typeof now?.startSec === 'number' ? ` to ${formatTimecode(now.startSec)}` : '';
        toast.success(`Moved ${moved.label || 'shot'}${at}${wasApproved ? '; re-approve the storyboard' : ''}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to reorder'));
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
      saveCompositionGrade: (patch) => saveProjectFields(patch, { applyComposition: true }),
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
      varyWipes: (fromSceneId, count) => varyMusicVideoWipes(selected.id, { fromSceneId, count, seed: Math.floor(Math.random() * 2147483646) }, { silent: true })
        .then(({ scenes, updatedAt }) => {
          const byId = new Map(scenes.map((scene) => [scene.sceneId, scene]));
          patchProject(selected.id, (p) => ({
            scenes: p.scenes.map((scene) => (byId.has(scene.sceneId) ? { ...scene, ...byId.get(scene.sceneId) } : scene)),
            ...(updatedAt ? { updatedAt } : {}),
          }));
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
      saveScene,
      setSceneDone,
      moveScene,
      commitSceneTiming,
    },
  };
}
