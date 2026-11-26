import { TAKE_SLOT } from '../../lib/musicVideo/musicVideoLayers.js';
import { currentPlateEvidence, plateFrameRole, plateRequirementBasis } from '../../lib/musicVideo/musicVideoPlateEvidence.js';
import { assertMusicVideoMedia } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
/**
 * Music Video scene takes (#8965) — pure record transforms.
 *
 * A scene slot (`referenceImageId` for the still, `videoHistoryId` for the
 * clip) used to hold only the newest render: every completion overwrote it, so
 * an earlier render the director preferred was lost, and two out-of-order jobs
 * could replace a frame the director had already approved. Now every asset
 * offered for a slot becomes an immutable take in `scene.takes`, and the slot
 * field is the director's explicit SELECTION of one of them:
 *
 *   - a completed/imported asset is APPENDED as a candidate and only fills the
 *     slot while the slot is empty (initial generation) — it never replaces a
 *     selection, unless the submit asked to (`replaceSelection`, a one-tap
 *     re-render of a still);
 *   - selecting a take is an explicit action (`selectSceneTake`);
 *   - rejecting the selected take clears the slot, so the next completion (or
 *     "Generate missing") fills it — selective regeneration.
 *
 * The slot fields keep their names so render.js, the peer-sync asset manifest
 * and older records read the selection unchanged. Pre-#8965 scenes carry no
 * `takes`; `ensureSceneTakes` materializes their selected asset as a `legacy`
 * take the first time a take operation touches the scene (no record rewrite).
 */

import { musicVideoCastInputsRecord } from '../../lib/musicVideo/musicVideoCastLook.js';
import { captureImageFrameDependencies, captureTakeDependencies, musicVideoTakeChanges, retainMusicVideoDependencies } from '../../lib/musicVideo/musicVideoDependencies.js';
import { musicVideoTakeCharacterReferenceState } from '../../lib/musicVideo/musicVideoCharacterReferenceAge.js';
import { extendTakeRecord, sequenceTakeRecord, sequenceTakeSelectionPatch } from '../../lib/musicVideo/musicVideoSequenceTake.js';
import { isMusicVideoRenderTier } from '../../lib/musicVideo/musicVideoRenderTier.js';
import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';

export { TAKE_SLOT };

/** `codeClip` describes the clip it was set on: another clip in the slot is not code-rendered. */
export function keepCodeClipWithItsClip(before, after) {
  if (!after.codeClip || before?.videoHistoryId === after.videoHistoryId) return after;
  const { codeClip: _stale, ...rest } = after;
  return rest;
}

// Per-scene cap. Takes are small pointer records, but an unattended "regenerate
// until it looks right" loop must not grow one project row without bound. When
// full, the oldest rejected take is dropped first, then the oldest unselected
// candidate; a selected take is never pruned.
export const MAX_SCENE_TAKES = 60;

// A recorded failure reason is a one-line chip, not a log: bound it.
export const MAX_FAILURE_ERROR_CHARS = 300;

// Optional provenance text: bounded, and null (not '') when absent.
const clip = (v, max) => (isNonBlankStr(v) ? trimTo(v, max) : null);

// A basename only — an imported file's name is provenance, never a path.
const takeOriginalName = (name) => (isNonBlankStr(name) ? clip(name.split(/[\\/]/).pop(), 200) : null);

function buildTake({ kind, assetId, source, provider = null, jobId = null, prompt = null, sourceImageId = null, originalName = null, shotInstruction = null, use = 'final', dependencies = null, frameDependencies = null, inputAssets = null, castInputs = null, costUsd = null, spendKind = null, costModelId = null, sequence = null, extend = null, tier = null, now }) {
  const sequenceRecord = kind === 'video' ? sequenceTakeRecord(sequence) : null;
  const extendRecord = kind === 'video' ? extendTakeRecord(extend) : null;
  // A clip records the character references it was sent too (#16473).
  const recordedCastInputs = TAKE_SLOT[kind] ? musicVideoCastInputsRecord(castInputs) : null;
  return {
    takeId: `mvt-${randomUUID()}`,
    kind,
    assetId,
    source,
    provider: clip(provider, 40),
    jobId: clip(jobId, 128),
    prompt: typeof prompt === 'string' ? prompt : null,
    sourceImageId: clip(sourceImageId, 256),
    originalName: takeOriginalName(originalName),
    status: 'candidate',
    ...(dependencies ? { dependencies: structuredClone(dependencies) } : {}),
    ...(frameDependencies ? { frameDependencies: structuredClone(frameDependencies) } : {}),
    ...(recordedCastInputs ? { castInputs: recordedCastInputs } : {}),
    ...(inputAssets?.length ? { inputAssets: structuredClone(inputAssets) } : {}),
    // #8980 — 'motion-reference' scaffolding never fills the slot on its own.
    use: use === 'motion-reference' ? 'motion-reference' : 'final',
    note: null,
    createdAt: now,
    // #10157: the quoted generation cost, present only on a priced paid take.
    ...(Number.isFinite(costUsd) && costUsd >= 0 ? {
      costUsd, spendKind: spendKind === 'autoReview' ? 'autoReview' : 'manual',
      // The paid model the quote priced, so project spend can say where it went.
      ...(isNonBlankStr(costModelId) ? { costModelId: clip(costModelId, 200) } : {}),
    } : {}),
    // #16136: a clip rendered as a draft or a final; absent on untiered takes.
    ...(tier === 'draft' || tier === 'final' ? { tier } : {}),
    // #8977: the immutable record of what a performance take was generated
    // against (audio revision, song interval, edit in/out, cues, capability).
    // Present only on takes that carry one, so other takes keep their shape.
    ...(shotInstruction && typeof shotInstruction === 'object' ? { shotInstruction: structuredClone(shotInstruction) } : {}),
    // #16128: one clip covering a run of shots, and where this shot's window starts in it.
    ...(sequenceRecord ? { sequence: sequenceRecord } : {}),
    // #16150: a hosted extension of another take, and the in-point of its new footage.
    ...(extendRecord ? { parentTakeId: extendRecord.parentTakeId, extend: extendRecord } : {}),
  };
}

/**
 * The scene's takes, with any selected slot asset that has no take yet
 * materialized as a take — `legacy` for a pre-#8965 record, `manual` for a slot
 * set through the plain scene PATCH. Returns the same array when nothing needed
 * adding.
 */
export function ensureSceneTakes(scene, now = new Date().toISOString(), source = 'legacy') {
  const takes = Array.isArray(scene?.takes) ? scene.takes : [];
  const added = [];
  for (const [kind, field] of Object.entries(TAKE_SLOT)) {
    const assetId = scene?.[field];
    if (!isNonBlankStr(assetId)) continue;
    if (takes.some((t) => t?.kind === kind && t.assetId === assetId)) continue;
    added.push(buildTake({ kind, assetId, source, now }));
  }
  return added.length ? [...takes, ...added] : takes;
}

// Drop the oldest prunable take until the list fits the cap.
function pruneTakes(takes, scene) {
  if (takes.length <= MAX_SCENE_TAKES) return takes;
  const selected = new Set(Object.entries(TAKE_SLOT)
    .map(([kind, field]) => (isNonBlankStr(scene[field]) ? `${kind}:${scene[field]}` : null))
    .filter(Boolean));
  const next = takes.slice();
  for (const wanted of ['rejected', 'candidate']) {
    for (let i = 0; i < next.length && next.length > MAX_SCENE_TAKES;) {
      const t = next[i];
      if (t.status === wanted && !selected.has(`${t.kind}:${t.assetId}`)) next.splice(i, 1);
      else i += 1;
    }
  }
  return next;
}

function findSceneIndex(project, sceneId) {
  const idx = (project.scenes || []).findIndex((s) => s.sceneId === sceneId);
  if (idx < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  return idx;
}

function replaceScene(project, idx, scene) {
  const scenes = project.scenes.slice();
  scenes[idx] = keepCodeClipWithItsClip(project.scenes[idx], scene);
  return retainMusicVideoDependencies(project, { ...project, scenes, updatedAt: new Date().toISOString() });
}

/**
 * Append candidate takes to one scene. Idempotent per asset: an asset already
 * present as a take of that kind is not duplicated (a replayed job completion
 * or a re-import is a no-op for the list). A slot is filled only while it is
 * empty, by the first appended take of that kind. An existing selection is
 * replaced only when that input sets `replaceSelection` on an image or end
 * frame. A motion-reference take (#8980) never fills a slot — it
 * becomes final picture only by an explicit select. A take already stale
 * against the whole PROJECT (its plate, timing, or for a supplied-audio take
 * the song master/lyrics) does not fill either; the check needs the real
 * project, since a song reference reads the project's song fields. Returns
 * `{ scene, appended }` — `appended` lists the take for every input, whether
 * newly created or already present.
 */
function appendToScene(project, scene, inputs, now) {
  let takes = ensureSceneTakes(scene, now);
  const next = { ...scene };
  const appended = [];
  for (const input of inputs) {
    const existing = takes.find((t) => t.kind === input.kind && t.assetId === input.assetId);
    const dependencies = input.dependencies || (input.kind === 'video' && input.sourceImageId ? captureTakeDependencies(scene, input.sourceImageId) : null);
    const frameSlot = input.kind === 'endImage' ? 'end' : 'start';
    // A stamp from submit time wins. A generated still with no stamp (the
    // synchronous lane, or a job queued before stamps existed) is captured
    // here unless the caller sets skipFrameCapture — a late completion must
    // not snapshot the shot as it stands now.
    const frameDependencies = input.kind === 'image' || input.kind === 'endImage'
      ? input.frameDependencies || (input.skipFrameCapture || input.source !== 'generated' ? null : captureImageFrameDependencies(project, scene, { slot: frameSlot }))
      : null;
    const { skipFrameCapture: _skipFrameCapture, ...stored } = input;
    // A slot materialized before this completion has no stamp yet. Keep the
    // first stamp; a replay must not replace evidence already recorded.
    const stamped = existing && frameDependencies && !existing.frameDependencies
      ? { ...existing, frameDependencies: structuredClone(frameDependencies) }
      : existing;
    const take = existing ? stamped : buildTake({ ...stored, dependencies, frameDependencies, now });
    if (!existing) takes = [...takes, take];
    else if (take !== existing) takes = takes.map((entry) => (entry === existing ? take : entry));
    appended.push(take);
    const field = TAKE_SLOT[input.kind];
    // The takes appended in this batch are the plates a same-call clip was built on.
    const selectable = input.autoSelect !== false && take.status !== 'rejected' && take.use !== 'motion-reference'
      && !musicVideoTakeChanges(project, { ...scene, takes }, take).length;
    const replaceFrame = input.replaceSelection === true && (input.kind === 'image' || input.kind === 'endImage');
    const selectionUnchanged = input.expectedSelection !== undefined && (next[field] || null) === input.expectedSelection;
    const repairDone = input.kind === 'image' && input.stillRepairAt && next.stillFixes?.pending === true
      && next.stillFixes.at === input.stillRepairAt;
    if (selectable && (replaceFrame ? selectionUnchanged && (!input.stillRepairAt || repairDone) : !isNonBlankStr(next[field]))) next[field] = take.assetId;
    if (repairDone) {
      const { pending: _pending, replaces: _replaces, ...fixes } = next.stillFixes;
      next.stillFixes = fixes;
    }
  }
  next.takes = pruneTakes(takes, next);
  // A take landing for the lane a failure was recorded against is the retry
  // succeeding — drop the "failed" chip (#10154).
  if (next.lastFailure && appended.some((t) => t.kind === next.lastFailure.lane)) delete next.lastFailure;
  return { scene: next, appended };
}

/**
 * Record (or, with `failure` null, clear) the last generation failure on a
 * scene (#10154): `{ lane: 'image'|'video', error, at }`. Persisted so the
 * board shows which scene failed and why after a reload, instead of a toast
 * that vanishes and a card that silently returns to idle. Throws 404 for a
 * deleted scene so a late failure can't resurrect it.
 */
export function setSceneLastFailure(project, sceneId, failure) {
  const idx = findSceneIndex(project, sceneId);
  const { lastFailure: _previous, ...rest } = project.scenes[idx];
  const scene = failure
    ? { ...rest, lastFailure: {
      lane: failure.lane === 'video' ? 'video' : 'image',
      error: trimTo(String(failure.error || '').replace(/\s+/g, ' ').trim(), MAX_FAILURE_ERROR_CHARS) || 'Render failed',
      at: failure.at || new Date().toISOString(),
      ...(failure.lane === 'video' && isMusicVideoRenderTier(failure.tier) ? { tier: failure.tier } : {}),
    } }
    : rest;
  return { project: replaceScene(project, idx, scene), scene };
}

/** Append takes to one scene. Throws 404 for a deleted/unknown scene. */
export function appendSceneTakes(project, sceneId, inputs) {
  for (const input of inputs) assertMusicVideoMedia(project, input.kind, 'take import');
  const idx = findSceneIndex(project, sceneId);
  const { scene, appended } = appendToScene(project, project.scenes[idx], inputs, new Date().toISOString());
  return { project: replaceScene(project, idx, scene), scene, appended };
}

/**
 * Append takes across scenes in one record write (a handoff import). `items`
 * are `{ sceneId, ...takeInput }`; every sceneId must exist or the whole batch
 * is refused, so a partially applied import can't strand half a handoff.
 */
export function appendTakesAcrossScenes(project, items) {
  for (const item of items) assertMusicVideoMedia(project, item.kind, 'handoff import');
  const bySceneId = new Map();
  items.forEach((item, index) => {
    findSceneIndex(project, item.sceneId);
    const list = bySceneId.get(item.sceneId) || [];
    list.push({ item, index });
    bySceneId.set(item.sceneId, list);
  });
  const now = new Date().toISOString();
  // Reported in INPUT order, so a caller can pair each result with its item.
  const appended = new Array(items.length);
  const scenes = project.scenes.map((scene) => {
    const entries = bySceneId.get(scene.sceneId);
    if (!entries) return scene;
    const result = appendToScene(project, scene, entries.map((e) => e.item), now);
    entries.forEach((e, i) => { appended[e.index] = { sceneId: scene.sceneId, take: result.appended[i] }; });
    return result.scene;
  });
  return { project: retainMusicVideoDependencies(project, { ...project, scenes, updatedAt: now }), appended };
}

function locateTake(project, sceneId, takeId) {
  const idx = findSceneIndex(project, sceneId);
  const scene = project.scenes[idx];
  const takes = ensureSceneTakes(scene);
  const take = takes.find((t) => t.takeId === takeId);
  if (!take) throw new ServerError('Take not found', { status: 404, code: 'NOT_FOUND' });
  return { idx, scene, takes, take };
}

/** The still a plate check may inspect: a start frame or an end frame, never a clip. */
export function plateCheckTake(project, sceneId, takeId) {
  const { scene, take } = locateTake(project, sceneId, takeId);
  if (take.kind !== 'image' && take.kind !== 'endImage') throw new ServerError('Only frame takes can be checked', { status: 400, code: 'VALIDATION_ERROR' });
  return { scene, take };
}

/** The prompt a plate check judges. An end frame never falls through to the start prompt. */
export function plateCheckPrompt(scene, take) {
  if (plateFrameRole(take) === 'end') return take.prompt ?? scene.endFramePrompt ?? '';
  return take.prompt ?? scene.framePrompt ?? scene.prompt ?? '';
}

/** Save a plate check's evidence on the take, unless the shot's intent changed while it ran. */
export function recordTakePlateEvidence(project, sceneId, takeId, evidence) {
  const { idx, scene, takes, take } = locateTake(project, sceneId, takeId);
  if (take.assetId !== evidence.assetId || plateRequirementBasis(scene, plateFrameRole(take), project) !== evidence.basis) {
    throw new ServerError('The shot or frame changed during the check. Check it again.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
  }
  const next = { ...scene, takes: takes.map((t) => (t.takeId === takeId ? { ...t, plateEvidence: evidence } : t)) };
  return { project: replaceScene(project, idx, next), scene: next };
}

/** Explicitly select a take for its slot. Selecting a rejected take restores it. */
export function selectSceneTake(project, sceneId, takeId, options = {}) {
  const { idx, scene, takes, take } = locateTake(project, sceneId, takeId);
  if (Object.hasOwn(options, 'expectedSelectedAssetId') && (scene[TAKE_SLOT[take.kind]] || null) !== options.expectedSelectedAssetId) {
    throw new ServerError('This shot has a newer take selection; Undo kept it.', { status: 409, code: 'MUSIC_VIDEO_UNDO_CONFLICT' });
  }
  assertMusicVideoMedia(project, take.kind, 'take selection');
  const nextTakes = takes.map((t) => (t.takeId === takeId && t.status === 'rejected' ? { ...t, status: 'candidate' } : t));
  const next = { ...scene, takes: nextTakes, [TAKE_SLOT[take.kind]]: take.assetId };
  // A sequence take plays from its own in-point on this shot (#16128); leaving one clears it.
  const offset = sequenceTakeSelectionPatch({ ...scene, takes }, take);
  if (offset.offsetFrames === null) delete next.offsetFrames;
  else if (Number.isInteger(offset.offsetFrames)) next.offsetFrames = offset.offsetFrames;
  if (next.selectedTakeMarkedBad) {
    const selectedVideo = nextTakes.find((entry) => entry.kind === 'video' && entry.assetId === next.videoHistoryId);
    const source = selectedVideo?.sourceImageId || selectedVideo?.dependencies?.references?.find((ref) => ref.role === 'plate')?.assetId;
    const mismatch = source && next.referenceImageId && source !== next.referenceImageId;
    const bad = Object.entries(TAKE_SLOT).some(([kind, field]) => next[field] && project.assetMarks?.[`${kind === 'video' ? 'video' : 'image'}:${next[field]}`] === 'bad');
    if (!mismatch && !bad) delete next.selectedTakeMarkedBad;
  }
  return { project: replaceScene(project, idx, next), scene: next };
}

/**
 * Move one take to another shot, to organize takes that were made for (or fit) a different shot.
 * The take keeps its id, status, note and provenance, and lands on the target as an unselected
 * take: it never changes the target's selection, and its dependencies still name the shot it was
 * made for, so the target shows it as made for another shot until it is used. The take a shot is
 * using must be swapped out first, so a move never empties a shot. A take covering a run of
 * shots (`sequence`) belongs to that run and does not move. When the target already holds a take
 * of the same file, the source's copy is dropped and the target's own take is kept.
 * Returns `{ project, scene, target, take }` (`take` as it now sits on the target).
 */
export function moveSceneTake(project, sceneId, takeId, { toSceneId }) {
  if (toSceneId === sceneId) throw new ServerError('The take is already on that shot', { status: 400, code: 'VALIDATION_ERROR' });
  const { idx, scene, takes, take } = locateTake(project, sceneId, takeId);
  const targetIdx = findSceneIndex(project, toSceneId);
  if (scene[TAKE_SLOT[take.kind]] === take.assetId) {
    throw new ServerError('This shot is using that take. Use another take on this shot before moving it.', { status: 409, code: 'MUSIC_VIDEO_TAKE_IN_USE' });
  }
  if (take.sequence) {
    throw new ServerError('A clip covering several shots stays with its run of shots', { status: 409, code: 'MUSIC_VIDEO_TAKE_SEQUENCE' });
  }
  assertMusicVideoMedia(project, take.kind, 'take move');
  const now = new Date().toISOString();
  const source = { ...scene, takes: takes.filter((t) => t.takeId !== takeId) };
  const targetScene = project.scenes[targetIdx];
  const targetTakes = ensureSceneTakes(targetScene, now);
  const existing = targetTakes.find((t) => t.kind === take.kind && t.assetId === take.assetId);
  // A clip with no recorded dependencies gets them from the shot it was made for, before it leaves that shot.
  const provenance = take.kind === 'video' && !take.dependencies && take.sourceImageId
    ? { dependencies: captureTakeDependencies(scene, take.sourceImageId) } : {};
  const moved = existing || { ...take, ...provenance, movedFrom: { sceneId, at: now } };
  const target = { ...targetScene, takes: existing ? targetTakes : pruneTakes([...targetTakes, moved], targetScene) };
  const scenes = project.scenes.slice();
  scenes[idx] = source;
  scenes[targetIdx] = target;
  const saved = retainMusicVideoDependencies(project, { ...project, scenes, updatedAt: now });
  return { project: saved, scene: saved.scenes[idx], target: saved.scenes[targetIdx], take: moved };
}

/**
 * Reject/restore a take and/or set its review note. Rejecting the SELECTED take
 * clears the slot so the scene reads as "needs a take" again.
 */
/**
 * Finalize a shot's takes: every take that is not the selected frame, end
 * frame or clip becomes rejected. Files and notes stay, the selection does not
 * change, and Use or Restore brings any of them back.
 */
export function rejectUnusedTakes(project, sceneId) {
  const scenes = project.scenes || [];
  const idx = scenes.findIndex((s) => s.sceneId === sceneId);
  if (idx < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const scene = scenes[idx];
  const unused = (take) => take?.takeId && TAKE_SLOT[take.kind] && take.status !== 'rejected' && scene[TAKE_SLOT[take.kind]] !== take.assetId;
  const takes = Array.isArray(scene.takes) ? scene.takes : [];
  const rejected = takes.filter(unused).length;
  if (!rejected) return { project, scene, rejected };
  const next = { ...scene, takes: takes.map((take) => (unused(take) ? { ...take, status: 'rejected' } : take)) };
  const saved = replaceScene(project, idx, next);
  return { project: saved, scene: saved.scenes[idx], rejected };
}

/**
 * Swap a shot's selected start and end frames, with their prompts. Each still
 * becomes a take of the other frame (an existing one is reused), so both stay
 * selected takes and neither frame's other takes change.
 */
export function swapSceneFrames(project, sceneId) {
  const idx = findSceneIndex(project, sceneId);
  const scene = project.scenes[idx];
  const start = scene.referenceImageId;
  const end = scene.endImageId;
  if (!isNonBlankStr(start) || !isNonBlankStr(end)) {
    throw new ServerError('This shot needs both a start and an end frame to swap them.', { status: 409, code: 'MUSIC_VIDEO_SWAP_FRAMES_MISSING' });
  }
  const now = new Date().toISOString();
  const takes = ensureSceneTakes(scene, now);
  const origin = (kind, assetId) => takes.find((t) => t.kind === kind && t.assetId === assetId);
  const { scene: withTakes } = appendToScene(project, { ...scene, takes }, [
    { kind: 'image', assetId: end, source: 'imported', provider: 'portos', prompt: origin('endImage', end)?.prompt ?? null },
    { kind: 'endImage', assetId: start, source: 'imported', provider: 'portos', prompt: origin('image', start)?.prompt ?? null },
  ], now);
  // A take the director had rejected comes back as a candidate once it is selected, as selectSceneTake does.
  const restore = (t) => ((t.kind === 'image' && t.assetId === end) || (t.kind === 'endImage' && t.assetId === start)) && t.status === 'rejected'
    ? { ...t, status: 'candidate' } : t;
  const next = { ...withTakes, takes: withTakes.takes.map(restore), referenceImageId: end, endImageId: start,
    framePrompt: scene.endFramePrompt ?? null, endFramePrompt: scene.framePrompt ?? null };
  return { project: replaceScene(project, idx, next), scene: next };
}

export function reviewSceneTake(project, sceneId, takeId, { status, note, acknowledgeRenderQuality, confirmFrame, acceptCharacterReferences, reviewer }) {
  const { idx, scene, takes, take } = locateTake(project, sceneId, takeId);
  // "Still matches" for an older character reference (#16473) binds to the revision the warning showed:
  // a reference that changed again since needs looking at again.
  if (acceptCharacterReferences) {
    const state = musicVideoTakeCharacterReferenceState(project, { ...scene, takes }, take);
    if (!reviewer || !state || state.revision !== acceptCharacterReferences.revision) {
      throw new ServerError('The character references changed. Look at this take again before keeping it.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
    }
  }
  // The director confirms the selected still still matches the shot as it now reads (#15982): its frame evidence is
  // re-stamped against the current prompt, camera, place, cast and references, without making a new picture.
  if (confirmFrame) {
    if (take.kind !== 'image' && take.kind !== 'endImage') {
      throw new ServerError('Only a start or end frame can be confirmed', { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (scene[TAKE_SLOT[take.kind]] !== take.assetId) {
      throw new ServerError('Select this frame for the shot before confirming it', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
    }
  }
  if (acknowledgeRenderQuality) {
    const evidence = currentPlateEvidence(scene, take, project);
    const defect = evidence?.checks.find((check) => check.id === 'render-quality' && check.status === 'fail');
    if (!reviewer || !defect || acknowledgeRenderQuality.basis !== evidence.basis || acknowledgeRenderQuality.note !== defect.note) {
      throw new ServerError('The image or rendering defect changed. Inspect it again before acknowledging.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
    }
  }
  const updated = {
    ...take,
    ...(acknowledgeRenderQuality ? { renderQualityAcknowledgement: { ...acknowledgeRenderQuality, reviewer, at: new Date().toISOString() } } : {}),
    ...(confirmFrame ? {
      frameDependencies: captureImageFrameDependencies(project, scene, { slot: take.kind === 'endImage' ? 'end' : 'start' }),
      frameConfirmation: { reviewer, at: new Date().toISOString() },
    } : {}),
    ...(acceptCharacterReferences ? { characterReferenceAcceptance: { revision: acceptCharacterReferences.revision, reviewer, at: new Date().toISOString() } } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(note !== undefined ? { note: note && note.trim() ? note.trim().slice(0, 1000) : null } : {}),
  };
  const field = TAKE_SLOT[take.kind];
  const next = {
    ...scene,
    takes: takes.map((t) => (t.takeId === takeId ? updated : t)),
    ...(updated.status === 'rejected' && scene[field] === take.assetId ? { [field]: null } : {}),
  };
  const saved = replaceScene(project, idx, next);
  // The saved scene carries freshly computed take states; `next` still holds each take's state from
  // before this review, so a confirmed frame would read stale until the next load (#16274).
  return { project: saved, scene: saved.scenes[idx] };
}
