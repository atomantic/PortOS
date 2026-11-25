/**
 * Music Video board edits: the shot, take and project writes the editing tab
 * makes, each answering with the board edit result (editResult.js, #16247)
 * rather than the whole project, plus the edits that keep a following
 * storyboard in step (storyboards/followShots.js), pacing recuts and the
 * user-started plate check.
 *
 * These sit above the project store (projects.js) and import it downward. A
 * name shared with projects.js (updateProject, updateScene, selectSceneTake…)
 * is the edit-result form of that store write; the store keeps the plain one
 * for every other caller.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { plateFrameRole } from '../../lib/musicVideo/musicVideoPlateEvidence.js';
import { fileAppendedTakes, markPoolAssets, projectTakeAssets } from './mediaPool.js';
import { getProject, getStoredProjectRecord, mutateProjectRecord, updateProjectForEdit } from './projects.js';
import {
  appendSceneTakes as appendTakes, selectSceneTake as selectTake, rejectUnusedTakes, swapSceneFrames, reviewSceneTake as reviewTake,
  plateCheckPrompt, plateCheckTake, recordTakePlateEvidence, moveSceneTake as moveTake,
} from './takes.js';

const presentEdit = async ({ before, after }) => (await import('./editResult.js')).presentEditResult({ before, after });

// The write fills `edit` with the record before and after it (mutateProjectRecord's `edit` option);
// `after` replaces its saved record when a board write followed.
async function editWrite(id, transform, options = {}) {
  const edit = {};
  const outcome = await mutateProjectRecord(id, transform, { ...options, presentProject: false, edit });
  return { outcome, edit };
}
async function withEditResult(outcome, edit, after = edit.after) {
  return { ...outcome, edit: await presentEdit({ before: edit.before, after }) };
}
// A shot as the edit result presents it (as GET does), falling back to the write's own copy.
const presentedScene = (edit, sceneId, fallback) => edit.scenes.find((scene) => scene.sceneId === sceneId) || fallback;

/** Merge a project patch. Answers `{ edit }`, taken after the write's own follow-ups (reference naming, style snapshots). */
export async function updateProject(id, patch) {
  return { edit: await presentEdit(await updateProjectForEdit(id, patch)) };
}

/** Add a director's shot at its time; shots locked before stay locked. Answers `{ scene, edit }`. */
export async function addProjectScene(id, sceneInput) {
  const [{ addScene }, { carryShotLocks }] = await Promise.all([import('./projectsLogic.js'), import('./productionReview.js')]);
  const { outcome, edit } = await editWrite(id, (current) => {
    const added = addScene(current, sceneInput);
    return { ...added, project: carryShotLocks(current, added.project) };
  });
  const { edit: result } = await withEditResult({}, edit);
  return { scene: outcome.scene, edit: result };
}

/** Edit a shot against the fresh record so concurrent changes are not overwritten. Answers `{ scene, edit }`. */
export async function updateScene(id, sceneId, patch) {
  const { applySceneUpdate } = await import('./projectsLogic.js');
  const { outcome, edit } = await editWrite(id, (current) => applySceneUpdate(current, sceneId, patch));
  const { edit: result } = await withEditResult({}, edit);
  return { scene: outcome.updated, edit: result };
}

/** "Vary wipes" over a run of shots (projectsLogic.varySceneWipes). Answers `{ project, scenes, edit }`. */
export async function varyProjectWipes(id, options) {
  const { varySceneWipes } = await import('./projectsLogic.js');
  const { outcome, edit } = await editWrite(id, (current) => varySceneWipes(current, options));
  return withEditResult(outcome, edit);
}

/** Remove a shot. Answers `{ project, edit }`. */
export async function deleteScene(id, sceneId) {
  const { removeScene } = await import('./projectsLogic.js');
  const { outcome, edit } = await editWrite(id, (current) => ({ project: removeScene(current, sceneId) }));
  return withEditResult(outcome, edit);
}

/** Put the shots in `orderedIds` order (each slot keeps its timing). Answers `{ project, edit }`. */
export async function reorderProjectScenes(id, orderedIds) {
  const { reorderScenes } = await import('./projectsLogic.js');
  const { outcome, edit } = await editWrite(id, (current) => ({ project: reorderScenes(current, orderedIds) }));
  return withEditResult(outcome, edit);
}

/**
 * Split a shot longer than its backend renders in one take into contiguous
 * scenes on lyric/phrase boundaries (#8977, projectsLogic.splitScene), or in
 * two at `options.atSec`. A locked still stays locked on every piece. Answers `{ project, scenes, edit }`.
 */
export async function splitProjectScene(id, sceneId, options = {}) {
  const [{ splitScene }, { carryShotLocks }, followShots] = await Promise.all([import('./projectsLogic.js'), import('./productionReview.js'), import('../storyboards/followShots.js')]);
  // A board with no room for the new panels refuses before the shots change.
  const stored = await getStoredProjectRecord(id);
  if (!stored) throw new ServerError('Music video not found', { status: 404, code: 'NOT_FOUND' });
  const panelIds = followShots.boardFollowsShots(stored)
    ? await followShots.reservePanelsForSplit(stored, sceneId, splitScene(stored, sceneId, options).scenes.length - 1) : [];
  const { outcome, edit } = await editWrite(id, (current) => {
    const split = splitScene(current, sceneId, options);
    const from = Object.fromEntries(split.scenes.slice(1).map((piece) => [piece.sceneId, sceneId]));
    if (!panelIds.length) return { ...split, project: carryShotLocks(current, split.project, { from }) };
    if (split.scenes.length - 1 !== panelIds.length) throw new ServerError('The shot changed while it was being split. Try again.', { status: 409, code: 'SHOTS_CHANGED' });
    // Each later piece gets a panel of its own, so the shots stay 1:1 with the board.
    const ownPanel = new Map(split.scenes.slice(1).map((piece, i) => [piece.sceneId, panelIds[i]]));
    const scenes = split.project.scenes.map((scene) => (ownPanel.has(scene.sceneId) ? { ...scene, panelId: ownPanel.get(scene.sceneId) } : scene));
    const project = carryShotLocks(current, { ...split.project, scenes }, { from });
    return { project, scenes: split.scenes.map((piece) => (ownPanel.has(piece.sceneId) ? { ...piece, panelId: ownPanel.get(piece.sceneId) } : piece)) };
  });
  if (!panelIds.length) return withEditResult(outcome, edit);
  const [first, ...later] = outcome.scenes;
  await followShots.applyShotEditToBoard(outcome.project, {
    lengths: [followShots.panelLength(first)].filter(Boolean),
    copies: later.map((piece) => ({ fromPanelId: first.panelId, id: piece.panelId, seconds: followShots.panelLength(piece)[1] })),
  });
  return afterBoardWrite(id, outcome, edit);
}

// The board write's sync may have touched the shots, so answer with the record as it is now. Its read
// reuses the write's catalog reads, and the edit result is taken against it.
async function afterBoardWrite(id, outcome, edit) {
  const project = await getProject(id, edit.reads ? { catalogReads: edit.reads } : {});
  const fresh = (scene) => project.scenes?.find((entry) => entry.sceneId === scene?.sceneId) ?? scene;
  return withEditResult({ ...outcome, project,
    ...(outcome.scene ? { scene: fresh(outcome.scene) } : {}),
    ...(outcome.scenes ? { scenes: outcome.scenes.map(fresh) } : {}),
    ...(outcome.previous ? { previous: fresh(outcome.previous) } : {}),
    ...(outcome.next ? { next: fresh(outcome.next) } : {}),
  }, edit, project);
}

/** A merge's panels: the kept shot's takes the joined length and the removed shot's goes. */
async function mergeIntoBoard(id, before, outcome, edit) {
  const followShots = await import('../storyboards/followShots.js');
  if (!followShots.boardFollowsShots(outcome.project)) return withEditResult(outcome, edit);
  const stillThere = new Set(outcome.project.scenes.map((scene) => scene.sceneId));
  const removed = before.filter((scene) => !stillThere.has(scene.sceneId) && scene.panelId && scene.panelId !== outcome.scene.panelId).map((scene) => scene.panelId);
  await followShots.applyShotEditToBoard(outcome.project, { lengths: [followShots.panelLength(outcome.scene)].filter(Boolean), remove: removed });
  return afterBoardWrite(id, outcome, edit);
}

/** A moved cut's panels: both shots beside it take their new lengths. */
async function moveCutOnBoard(id, outcome, shots, edit) {
  const followShots = await import('../storyboards/followShots.js');
  if (!followShots.boardFollowsShots(outcome.project)) return withEditResult(outcome, edit);
  await followShots.applyShotEditToBoard(outcome.project, { lengths: shots.map(followShots.panelLength).filter(Boolean) });
  return afterBoardWrite(id, outcome, edit);
}

/** Cut shots on sung words over the chosen lyric lines, or lay them out on an empty board (projectsLogic.cutScenesOnLyricWords, #14820). */
export async function cutProjectScenesOnLyrics(id, options) {
  const [{ cutScenesOnLyricWords }, { carryShotLocks }] = await Promise.all([import('./projectsLogic.js'), import('./productionReview.js')]);
  const { outcome, edit } = await editWrite(id, (current) => {
    const { project, scenes, skipped, from, laidOut } = cutScenesOnLyricWords(current, options);
    return { project: carryShotLocks(current, project, { from }), scenes, skipped, laidOut };
  });
  return withEditResult(outcome, edit);
}

/** Read the raw record so preview and the serialized apply hash identical inputs. */
export async function previewProjectPacingRecut(id) {
  const { previewPacingRecut } = await import('./pacingRecut.js');
  return previewPacingRecut(await getStoredProjectRecord(id));
}

export async function recutProjectToPacing(id, revision) {
  const [{ applyPacingRecut }, { carryShotLocks }] = await Promise.all([import('./pacingRecut.js'), import('./productionReview.js')]);
  return mutateProjectRecord(id, (current) => {
    const { project, added, from } = applyPacingRecut(current, revision);
    return { project: carryShotLocks(current, project, { from }), added };
  });
}

/**
 * Join a scene with the next one (projectsLogic.mergeNextScene) — the inverse
 * of the split. Answers `{ project, scene, edit }`.
 */
export async function mergeProjectNextScene(id, sceneId, options = {}) {
  const [{ mergeNextScene }, { assertBoardHoldsShotLengths }] = await Promise.all([import('./projectsLogic.js'), import('../storyboards/followShots.js')]);
  let before = [];
  const { outcome, edit } = await editWrite(id, (current) => {
    before = current.scenes || [];
    const merged = mergeNextScene(current, sceneId, options);
    assertBoardHoldsShotLengths(current, [merged.scene]);
    return merged;
  });
  return mergeIntoBoard(id, before, outcome, edit);
}

/**
 * Merge a scene over the one before it (projectsLogic.mergePreviousScene): this
 * scene starts where the previous one did and the previous one is removed.
 * Answers `{ project, scene, edit }`.
 */
export async function mergeProjectPreviousScene(id, sceneId, options = {}) {
  const [{ mergePreviousScene }, { assertBoardHoldsShotLengths }] = await Promise.all([import('./projectsLogic.js'), import('../storyboards/followShots.js')]);
  let before = [];
  const { outcome, edit } = await editWrite(id, (current) => {
    before = current.scenes || [];
    const merged = mergePreviousScene(current, sceneId, options);
    assertBoardHoldsShotLengths(current, [merged.scene]);
    return merged;
  });
  return mergeIntoBoard(id, before, outcome, edit);
}

// A shot looked up by id after an edit: a retime re-sorts the board, so its old index may name another shot.
const sceneById = (project, sceneId) => (project.scenes || []).find((scene) => scene.sceneId === sceneId) || null;

/**
 * Move the cut before a shot: the shot starts at `startSec` and the shot
 * before it ends there, so the two stay joined. Answers `{ project, scene, previous, edit }`.
 */
export async function moveProjectSceneStart(id, sceneId, { startSec }) {
  const [{ applySceneUpdate }, { assertBoardHoldsFirstStart, assertBoardHoldsShotLengths }] = await Promise.all([import('./projectsLogic.js'), import('../storyboards/followShots.js')]);
  const { outcome, edit } = await editWrite(id, (current) => {
    const scenes = current.scenes || [];
    const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
    if (index < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
    const scene = scenes[index];
    const previous = index > 0 ? scenes[index - 1] : null;
    if (typeof previous?.startSec !== 'number') assertBoardHoldsFirstStart(current, startSec);
    if (typeof scene.endSec === 'number' && startSec >= scene.endSec) {
      throw new ServerError('A shot has to start before it ends', { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (previous && typeof previous.startSec === 'number' && startSec <= previous.startSec) {
      throw new ServerError('The shot before this one would have no length left', { status: 400, code: 'VALIDATION_ERROR' });
    }
    let project = applySceneUpdate(current, sceneId, { startSec }).project;
    if (previous) project = applySceneUpdate(project, previous.sceneId, { endSec: startSec }).project;
    const moved = sceneById(project, sceneId);
    const prior = previous ? sceneById(project, previous.sceneId) : null;
    assertBoardHoldsShotLengths(current, [moved, prior]);
    return { project, scene: moved, previous: prior };
  });
  return moveCutOnBoard(id, outcome, [outcome.previous, outcome.scene], edit);
}

// The shortest shot a moved end leaves behind it (projectsLogic MIN_SPLIT_PIECE_SEC).
const MIN_SHOT_SEC = 0.1;

/**
 * Move the cut after a shot: the shot ends at `endSec` and the next shot starts
 * there, growing or shrinking to meet it while its own end stays put. The last
 * shot just ends there, inside the song. Answers `{ project, scene, next, edit }`.
 */
export async function moveProjectSceneEnd(id, sceneId, { endSec }) {
  const [{ applySceneUpdate }, { assertBoardHoldsLastEnd, assertBoardHoldsShotLengths }] = await Promise.all([import('./projectsLogic.js'), import('../storyboards/followShots.js')]);
  const { outcome, edit } = await editWrite(id, (current) => {
    const scenes = current.scenes || [];
    const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
    if (index < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
    const scene = scenes[index];
    const following = scenes[index + 1];
    const next = following && typeof following.startSec === 'number' && typeof following.endSec === 'number' ? following : null;
    if (typeof scene.startSec === 'number' && endSec < scene.startSec + MIN_SHOT_SEC) {
      throw new ServerError(`A shot has to run at least ${MIN_SHOT_SEC}s`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (next && endSec > next.endSec - MIN_SHOT_SEC) {
      throw new ServerError('That would leave the next shot with no length. Merge the two shots instead, or pick an earlier end.', { status: 400, code: 'VALIDATION_ERROR' });
    }
    const songSec = current.audioAnalysis?.durationSec;
    if (!next && songSec > 0 && endSec > songSec) {
      throw new ServerError('The last shot can\'t run past the end of the song', { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (!next) assertBoardHoldsLastEnd(current, endSec);
    let project = applySceneUpdate(current, sceneId, { endSec }).project;
    if (next) project = applySceneUpdate(project, next.sceneId, { startSec: endSec }).project;
    const moved = sceneById(project, sceneId);
    const nextShot = next ? sceneById(project, next.sceneId) : null;
    assertBoardHoldsShotLengths(current, [moved, nextShot]);
    return { project, scene: moved, next: nextShot };
  });
  return moveCutOnBoard(id, outcome, [outcome.scene, outcome.next], edit);
}

// A take decision with the edit result, so the board shows the readiness and neighbour take
// staleness the decision changed without a project read.
async function takeDecisionWrite(id, transform) {
  const { outcome, edit } = await editWrite(id, transform);
  return withEditResult(outcome, edit);
}

/**
 * Mark assets ★ ingredient or ✕ bad (null clears). Answers the project's marks, the shots whose
 * takes a bad mark rejected or moved, the per-shot changes list and the edit result.
 */
export async function markMediaPoolAssets(id, keys, mark, options = {}) {
  let changes = [];
  const { project, scenes, edit } = await takeDecisionWrite(id, (current) => {
    const outcome = markPoolAssets(current, keys, mark, options);
    changes = outcome.changes || [];
    return outcome;
  });
  return { assetMarks: project.assetMarks || {}, scenes, changes, edit };
}

// ---- scene takes (#8965) ----
// Append candidate takes to one scene: `{ scene, appended, edit }`. A take fills its
// slot only while the slot is empty, unless `replaceSelection` names a still re-render (takes.js).
export async function appendSceneTakes(id, sceneId, inputs) {
  const source = inputs.some(input => input.source === 'generated') ? 'generation-completion' : null;
  const { outcome, edit } = await editWrite(id, current => appendTakes(current, sceneId, inputs), { source });
  await fileAppendedTakes(outcome.project, outcome.appended.map(take => ({ sceneId, take })));
  const { edit: result } = await withEditResult({}, edit);
  // The edit result's copy of the shot is presented as GET presents it; an import of a take the shot already has changes nothing.
  return { scene: presentedScene(result, sceneId, outcome.scene), appended: outcome.appended, edit: result };
}

/**
 * Start a shot from a frame: the frame becomes a take and the shot's start frame; with `keepStillAsEnd`
 * its current start frame becomes its end frame (continue from previous). One write, so the reply's edit
 * result covers the whole change. Answers `{ scene, edit }`.
 */
export async function startSceneFromFrame(id, sceneId, { imageId, prompt, keepStillAsEnd = false }) {
  const { outcome, edit } = await editWrite(id, (current) => {
    const scene = current.scenes?.find(entry => entry.sceneId === sceneId);
    const plannedStill = keepStillAsEnd && scene?.referenceImageId && scene.referenceImageId !== imageId ? scene.referenceImageId : null;
    let result = appendTakes(current, sceneId, [
      { kind: 'image', assetId: imageId, source: 'generated', provider: 'portos', prompt },
      ...(plannedStill ? [{ kind: 'endImage', assetId: plannedStill, source: 'imported', provider: 'portos' }] : []),
    ]);
    for (const take of result.appended) result = { ...selectTake(result.project, sceneId, take.takeId), appended: result.appended };
    return result;
  }, { source: 'generation-completion' });
  await fileAppendedTakes(outcome.project, outcome.appended.map(take => ({ sceneId, take })));
  const { edit: result } = await withEditResult({}, edit);
  return { scene: presentedScene(result, sceneId, outcome.scene), edit: result };
}

/** Explicitly select a take for its scene slot. Answers `{ scene, edit }`. */
export async function selectSceneTake(id, sceneId, takeId, options = {}) {
  const { scene, edit } = await takeDecisionWrite(id, (current) => selectTake(current, sceneId, takeId, options));
  return { scene, edit };
}

/**
 * Put an unused still or clip from the project's pool on a shot (the shot
 * card's "Swap from unused"): it becomes a take of the shot and its selection.
 * `withAssetId` brings its partner too: a still's clip, or a clip's still.
 * `kind: 'endImage'` puts a still on the shot's end frame instead.
 * The take keeps the prompt and provider of the take it came from, and the
 * shot's start or end frame prompt becomes the one that still was made from.
 * Answers `{ scene, edit }`.
 */
export async function placeMediaPoolItem(id, sceneId, { kind, assetId, withAssetId = null }) {
  const { authoredFramePrompt } = await import('./handoff.js');
  // A still off the floor has no take left to name its prompt; its image sidecar still does.
  const placedStill = kind === 'video' ? withAssetId : assetId;
  const sidecarPrompt = placedStill
    ? await import('../imageGen/local.js').then(({ readImageSidecar }) => readImageSidecar(placedStill))
      .then(({ metadata }) => (typeof metadata?.prompt === 'string' ? metadata.prompt : null)).catch(() => null)
    : null;
  const { outcome: placed, edit } = await editWrite(id, (current) => {
    const origin = new Map(projectTakeAssets(current).filter(asset => asset.take).map(asset => [`${asset.kind}:${asset.ref}`, asset.take]));
    const still = kind === 'video' ? withAssetId : assetId;
    const clip = kind === 'video' ? assetId : withAssetId;
    const input = (takeKind, ref) => {
      const from = origin.get(`${takeKind === 'video' ? 'video' : 'image'}:${ref}`);
      return { kind: takeKind, assetId: ref, source: 'reused', provider: from?.provider || null,
        prompt: from?.prompt || (takeKind !== 'video' && ref === placedStill ? sidecarPrompt : null),
        ...(takeKind === 'video' && still ? { sourceImageId: still } : {}) };
    };
    const inputs = kind === 'endImage'
      ? [input('endImage', assetId)]
      : [...(still ? [input('image', still)] : []), ...(clip ? [input('video', clip)] : [])];
    let outcome = appendTakes(current, sceneId, inputs);
    for (const take of outcome.appended) outcome = { ...selectTake(outcome.project, sceneId, take.takeId), appended: outcome.appended };
    // The placed still's frame prompt comes with it, so the start or end prompt matches the picture. Re-placing the
    // shot's own selected still (to pair it with a clip) changes no picture: rewriting the prompt then would only
    // invalidate that still's frame evidence and every clip made from it (#15982).
    const stillTake = outcome.appended.find((take) => take.kind !== 'video');
    const before = current.scenes.find((scene) => scene.sceneId === sceneId);
    const slot = stillTake?.kind === 'endImage' ? 'endImageId' : 'referenceImageId';
    const framePrompt = stillTake && before?.[slot] !== stillTake.assetId ? authoredFramePrompt(current, stillTake.prompt) : null;
    if (framePrompt) {
      const field = stillTake.kind === 'endImage' ? 'endFramePrompt' : 'framePrompt';
      const scenes = outcome.project.scenes.map((scene) => (scene.sceneId === sceneId ? { ...scene, [field]: framePrompt } : scene));
      outcome = { ...outcome, project: { ...outcome.project, scenes }, scene: scenes.find((scene) => scene.sceneId === sceneId) };
    }
    return outcome;
  });
  const { edit: result } = await withEditResult({}, edit);
  return { scene: placed.scene, edit: result };
}

/**
 * Move a take from one shot to another (takes.js moveSceneTake). Answers `{ scene, target, take, edit }`:
 * both shots as GET presents them, so the board redraws both strips from the reply.
 */
export async function moveSceneTake(id, sceneId, takeId, { toSceneId }) {
  const { outcome, edit } = await editWrite(id, (current) => moveTake(current, sceneId, takeId, { toSceneId }));
  const { edit: result } = await withEditResult({}, edit);
  return { scene: presentedScene(result, sceneId, outcome.scene), target: presentedScene(result, toSceneId, outcome.target), take: outcome.take, edit: result };
}

/** Reject every take of a shot that is not its selected frame, end frame or clip. Answers `{ scene, rejected, edit }`. */
export async function rejectUnusedSceneTakes(id, sceneId) {
  const { scene, rejected, edit } = await takeDecisionWrite(id, (current) => rejectUnusedTakes(current, sceneId));
  return { scene, rejected, edit };
}

/** Swap a shot's start and end frames (and their prompts). Answers `{ scene, edit }`. */
export async function swapProjectSceneFrames(id, sceneId) {
  const { scene, edit } = await takeDecisionWrite(id, (current) => swapSceneFrames(current, sceneId));
  return { scene, edit };
}

/**
 * Reject/restore a take and/or set its note. Answers `{ scene, edit }`; the shot is presented as GET
 * presents it (catalog check-in included), which accepting character references needs (#16473).
 */
export async function reviewSceneTake(id, sceneId, takeId, review) {
  const { scene, edit } = await takeDecisionWrite(id, (current) => reviewTake(current, sceneId, takeId, review));
  return { scene: presentedScene(edit, sceneId, scene), edit };
}

/**
 * User-started plate check of one frame take, outside a production run: the
 * same vision review a run does, on the project's chosen reviewer or the
 * default (Codex when ready, else an API provider).
 * Its evidence carries a manual run id, so a production run still reviews for itself.
 * Answers `{ scene, edit }`.
 */
export async function checkSceneTakePlate(id, sceneId, takeId) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Music video project not found', { status: 404, code: 'NOT_FOUND' });
  const { scene, take } = plateCheckTake(project, sceneId, takeId);
  const { resolvePlateReviewer, reviewPlate } = await import('./plateReview.js');
  const pinned = project.plateReviewer?.providerId ? { providerId: project.plateReviewer.providerId, ...(project.plateReviewer.model ? { model: project.plateReviewer.model } : {}) } : {};
  const reviewer = await resolvePlateReviewer(pinned).catch((error) => { throw new ServerError(error.message, { status: error.status || 422, code: error.code || 'PLATE_REVIEWER_UNAVAILABLE' }); });
  const frameRole = plateFrameRole(take);
  const evidence = await reviewPlate({ scene, subjects: project.concept?.subjects || [], project, assetId: take.assetId, runId: `manual-${randomUUID()}`, reviewer,
    prompt: plateCheckPrompt(scene, take), frameRole });
  const { outcome, edit } = await editWrite(id, (current) => recordTakePlateEvidence(current, sceneId, takeId, evidence));
  const { edit: result } = await withEditResult({}, edit);
  return { scene: presentedScene(result, sceneId, outcome.scene), edit: result };
}
