import { assertMusicVideoMediaSelections } from '../../lib/musicVideoMediaPolicy.js';
/**
 * Music Video — project store backend dispatcher (#1760, Phase 1).
 *
 * Mirrors the Creative Director dispatcher (services/creativeDirector/local.js):
 * a thin layer that picks the backend so every import site + test mock targets
 * one module.
 *
 * Backend selection (same posture as the memory backend):
 *   - PostgreSQL (projectsDB.js) for normal installs.
 *   - File (projectsFile.js) only via MEMORY_BACKEND=file (escape hatch) or
 *     NODE_ENV=test — both UNSUPPORTED for production. Tests boot without a DB,
 *     so they exercise the file backend.
 *
 * Federation (#1770): peer-sync of `musicVideoProject` records mirrors the CD
 * store — the structural mutators emit record events (announce on create,
 * updated on edits, deleted on tombstone) routed through the recordEvents
 * subscription adapter (a no-op until peerSync registers it at boot, so this
 * store never imports peerSync and no load-order cycle forms). The backends
 * carry the LWW merge (`mergeProjectsFromSync`) + tombstone GC
 * (`pruneTombstonedProjects`); both are re-exported here for peerSync + the GC
 * sweep. The soft-delete fields were already on the record, so this was additive.
 */

import { setSceneLastFailure } from './takes.js';
import { droppedTakeAssets, fileMusicVideoMedia, assertNewMediaSelections } from './mediaPool.js';
import { presentMusicVideoDependencies, retainMusicVideoDependencies } from '../../lib/musicVideoDependencies.js';
import { createRecordStoreBackendSelector } from '../../lib/pgFileFacade.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { VIDEO_GEN_MODE, resolveVideoMode } from '../videoGen/modes.js';
import { getSettings } from '../settings.js';
import { withStyleSnapshots } from './styleSnapshots.js';
import { queueProjectCatalogLinkSync } from './catalogLinks.js';
import { labelProjectReferences } from './referenceLabels.js';

// Shared dispatcher (#2899). ensureSchema() runs inside the selector (mirroring
// memoryBackend.js) so the backend is self-sufficient regardless of boot ordering.
const { selectBackend, getBackendName } = createRecordStoreBackendSelector({
  label: 'Music Video',
  loadFileBackend: () => import('./projectsFile.js'),
  loadDbBackend: () => import('./projectsDB.js'),
  requireDbMessage: 'Music Video requires PostgreSQL — run `npm run setup:db` (dev/test only: set PGMODE=file in .env)',
});

/** Pool deletion joins the actual backend write boundary and cleans up without re-entering it. */
export async function withProjectMediaMutation(work) {
  const backend = await selectBackend();
  return backend.withProjectMutation(({ mutateProjectRecord: mutateAdmitted }) => work({
    mutateProjectRecord: (id, transform) => mutateProjectRecordAdmitted(id, transform, {}, mutateAdmitted),
  }));
}

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getProjectsBackendName() {
  return getBackendName();
}

// Announce a newly-created project to the per-record peer-sync pipeline: emit the
// 'updated' event so any existing subscription pushes it, AND auto-subscribe
// every musicVideoProjects-enabled peer so brand-new projects (and their later
// tombstones) propagate. Routed through the recordEvents subscription adapter (a
// no-op until peerSync registers it at boot) so this store doesn't import
// peerSync — peerSync statically imports mergeProjectsFromSync from here, so
// importing it back would close a load-order cycle. Mirrors CD announceNewProject.
function announceNewProject(id) {
  emitRecordUpdated('musicVideoProject', id);
  autoSubscribeRecordToAllPeers('musicVideoProject', id).catch(() => {});
}

export async function listProjects(options = {}) {
  return (await selectBackend()).listProjects(options);
}

/** Live `{ id, name }` rows for the sidebar's Music Video sub-nav. */
export async function listProjectNames() {
  return (await selectBackend()).listProjectNames();
}

export async function listProjectPage(options = {}) {
  return (await selectBackend()).listProjectPage(options);
}

/** Null when missing; a caller that answers 404 for that uses requireProject.js. */
export async function getProject(id, options = {}) {
  return presentMusicVideoDependencies(await (await selectBackend()).getProject(id, options));
}

/** Live project ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listProjectIds(options = {}) {
  return (await selectBackend()).listProjectIds(options);
}

// #3231 Phase 4 — seed a new project's video backend from the video pin ladder
// (`renderDefaults['music-video'].videoMode` → `settings.videoGen.mode`). The
// director board always sends the record's `videoSettings.backend` with each
// clip render (an explicit `body.backend`), so a target/install video pin can
// only take effect HERE, at record creation — the same explicit-body seeding
// trap the universe batch form and sprites page picker hit on the image side.
import { getTrack, updateTrack } from '../tracks/index.js';
import { parseLyricCues } from './timedText.js';
import { ServerError } from '../../lib/errorHandler.js';

// resolveVideoMode usability-gates the pin (a disabled grok pin seeds local);
// an input that names a backend explicitly wins untouched.
async function seedVideoBackendDefault(input) {
  if (input?.videoSettings?.backend) return input;
  const settings = await getSettings().catch(() => null);
  if (!settings) return input;
  const backend = resolveVideoMode(null, settings, { target: RENDER_TARGET.MUSIC_VIDEO });
  // Local is buildProjectRecord's own default — leave the input byte-identical.
  if (backend === VIDEO_GEN_MODE.LOCAL) return input;
  return { ...input, videoSettings: { ...(input?.videoSettings || {}), backend } };
}

// Automatically read lyrics and creative context from the linked music track
// in the music creation system when creating a project.
const trackSongStyle = (track) => (typeof track?.prompt === 'string' ? track.prompt.trim().slice(0, 2000) : '');

async function seedTrackMetadata(input) {
  if (!input?.trackId) return input;
  const track = await getTrack(input.trackId).catch(() => null);
  if (!track) return input;
  let lyricCues = input.lyricCues;
  let lyricMarkers = input.lyricMarkers;
  if ((!lyricCues || lyricCues.length === 0) && track.lyrics) {
    const parsed = parseLyricCues(track.lyrics);
    if (parsed.cues && parsed.cues.length > 0) {
      lyricCues = parsed.cues;
      lyricMarkers = parsed.markers;
    }
  }
  let name = input.name;
  if (!name && track.title) {
    name = track.title;
  }
  let concept = input.concept;
  // The track's prompt is the song's Suno style: it seeds `songStyle`, which
  // the planners translate into design. It is not the visual style.
  if (track.concept || track.prompt) {
    concept = {
      ...(concept || {}),
      ...(track.concept && !concept?.prompt ? { prompt: track.concept } : {}),
      ...(track.prompt && !concept?.songStyle ? { songStyle: trackSongStyle(track) } : {}),
    };
  }
  return {
    ...input,
    ...(name ? { name } : {}),
    ...(lyricCues ? { lyricCues } : {}),
    ...(lyricMarkers ? { lyricMarkers } : {}),
    ...(concept ? { concept } : {}),
  };
}

// Automatically read lyrics and creative context when the project's track is changed.
async function seedTrackMetadataOnUpdate(id, patch) {
  if (!patch?.trackId) return patch;
  const project = await getProject(id).catch(() => null);
  if (!project || project.trackId === patch.trackId) return patch;
  const track = await getTrack(patch.trackId).catch(() => null);
  if (!track) return patch;
  let lyricCues = patch.lyricCues;
  let lyricMarkers = patch.lyricMarkers;
  if (!lyricCues && track.lyrics) {
    const parsed = parseLyricCues(track.lyrics);
    if (parsed.cues && parsed.cues.length > 0) {
      lyricCues = parsed.cues;
      lyricMarkers = parsed.markers;
    }
  }
  let concept = patch.concept;
  // A different song brings its own style, so the snapshot follows the track.
  const songStyle = typeof concept?.songStyle === 'string' ? concept.songStyle : trackSongStyle(track);
  if ((track.concept && !project.concept?.prompt) || songStyle !== (project.concept?.songStyle || '')) {
    concept = {
      ...(project.concept || {}),
      ...(concept || {}),
      ...(track.concept && !project.concept?.prompt && !concept?.prompt ? { prompt: track.concept } : {}),
      songStyle,
    };
  }
  return {
    ...patch,
    ...(lyricCues ? { lyricCues } : {}),
    ...(lyricMarkers ? { lyricMarkers } : {}),
    ...(concept ? { concept } : {}),
  };
}

export async function createProject(input) {
  assertMusicVideoMediaSelections(input);
  const seeded = await seedTrackMetadata(await seedVideoBackendDefault(input));
  const snapshotted = await withStyleSnapshots(seeded);
  const project = await (await selectBackend()).createProject(snapshotted);
  announceNewProject(project.id);
  queueProjectCatalogLinkSync(project.id);
  return project;
}

export async function cloneProject(id, options = {}) {
  const project = await (await selectBackend()).cloneProject(id, options);
  announceNewProject(project.id);
  queueProjectCatalogLinkSync(project.id);
  return project;
}

export async function updateProject(id, patch) {
  const backend = await selectBackend();
  const seeded = await seedTrackMetadataOnUpdate(id, patch);
  const needsSnapshot = seeded?.concept?.universeId !== undefined || seeded?.concept?.characterStyleId !== undefined
    || seeded?.visualSpec?.moodBoardId !== undefined;
  const resolved = needsSnapshot ? await withStyleSnapshots(seeded, await backend.getProject(id)) : seeded;
  const castChanged = resolved?.concept?.subjects !== undefined;
  // A reference added from the gallery or a mood board takes its catalog record's name.
  // Linking the cast alone leaves approvals current, so naming then must not stale them.
  const referencesChanged = resolved?.visualSpec?.references !== undefined;
  const nameReferences = async (saved) => (referencesChanged || castChanged
    ? (await labelProjectReferences(id, { backfill: !referencesChanged }))?.project || saved : saved);
  if (!Array.isArray(resolved.scenes)) {
    const next = await backend.updateProject(id, resolved);
    emitRecordUpdated('musicVideoProject', id);
    if (castChanged) queueProjectCatalogLinkSync(id);
    return nameReferences(next);
  }
  const { applyProjectPatch } = await import('./projectsLogic.js');
  const { project } = await mutateProjectRecord(id, current => ({ project: applyProjectPatch(current, resolved) }));
  if (castChanged) queueProjectCatalogLinkSync(id);
  return nameReferences(project);
}

/**
 * Re-read the song's style from its Suno link, excluded styles included, for a
 * song imported before they were captured. Sets the project's song style and
 * the linked track's style prompt, so later projects on the track get it too.
 */
export async function refreshSongStyleFromSuno(id, url) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { readSunoSongStyle } = await import('../trackSunoImport.js');
  const { style, excludedStylesKnown } = await readSunoSongStyle(url);
  if (project.trackId) await updateTrack(project.trackId, { prompt: style });
  const updated = await updateProject(id, { concept: { songStyle: style.slice(0, 2000) } });
  return { project: updated, excludedStylesKnown };
}

export async function deleteProject(id) {
  const result = await (await selectBackend()).deleteProject(id);
  // Soft-delete tombstone — push the deletion to subscribed peers immediately.
  emitRecordDeleted('musicVideoProject', id);
  queueProjectCatalogLinkSync(id);
  // Its cached shot segments are regenerable, and only this machine's.
  await import('./shotSegments.js').then(({ removeProjectSegments }) => removeProjectSegments(id)).catch((err) => {
    console.warn(`⚠️ Music Video ${id.slice(0, 8)}: could not remove its cached shot segments: ${err.message}`);
  });
  return result;
}

export async function setProjectAnalysis(id, analysis, sourceProject) {
  const next = await (await selectBackend()).setProjectAnalysis(id, analysis, sourceProject);
  emitRecordUpdated('musicVideoProject', id);
  return next;
}

export async function setProjectMidiTranscription(id, midi) {
  const next = await (await selectBackend()).setProjectMidiTranscription(id, midi);
  emitRecordUpdated('musicVideoProject', id);
  return next;
}

/** Add a director's shot at its time; shots locked before stay locked. */
export async function addProjectScene(id, sceneInput) {
  const [{ addScene }, { carryShotLocks }] = await Promise.all([import('./projectsLogic.js'), import('./productionReview.js')]);
  const { scene } = await mutateProjectRecord(id, (current) => {
    const outcome = addScene(current, sceneInput);
    return { ...outcome, project: carryShotLocks(current, outcome.project) };
  });
  return scene;
}

/**
 * Bulk-append scenes (the autonomous planner, #1855) — emits one update, not
 * N. Returns `{ project, scenes }` — the freshly-persisted project, so a
 * caller composing a response never has to re-fetch or risk overwriting a
 * concurrent edit with stale state.
 */
export async function addProjectScenes(id, sceneInputs, { source = null } = {}) {
  const [{ addScenes }, { carryShotLocks }] = await Promise.all([import('./projectsLogic.js'), import('./productionReview.js')]);
  return mutateProjectRecord(id, (current) => {
    const outcome = addScenes(current, sceneInputs);
    return { ...outcome, project: carryShotLocks(current, outcome.project) };
  }, { source });
}

/** Edit against the fresh record so concurrent changes are not overwritten. */
export async function updateScene(id, sceneId, patch) {
  const { applySceneUpdate } = await import('./projectsLogic.js');
  const { updated } = await mutateProjectRecord(id, (current) => applySceneUpdate(current, sceneId, patch));
  return updated;
}

export async function deleteScene(id, sceneId) {
  const { removeScene } = await import('./projectsLogic.js');
  const { project } = await mutateProjectRecord(id, (current) => ({ project: removeScene(current, sceneId) }));
  return project;
}

export async function reorderProjectScenes(id, orderedIds) {
  const { reorderScenes } = await import('./projectsLogic.js');
  const { project } = await mutateProjectRecord(id, (current) => ({ project: reorderScenes(current, orderedIds) }));
  return project;
}

/**
 * Split a shot longer than its backend renders in one take into contiguous
 * scenes on lyric/phrase boundaries (#8977, projectsLogic.splitScene), or in
 * two at `options.atSec`. A locked still stays locked on every piece. Returns `{ project, scenes }` — the persisted project and the pieces.
 */
export async function splitProjectScene(id, sceneId, options = {}) {
  const [{ splitScene }, { carryShotLocks }] = await Promise.all([import('./projectsLogic.js'), import('./productionReview.js')]);
  return mutateProjectRecord(id, (current) => {
    const outcome = splitScene(current, sceneId, options);
    const from = Object.fromEntries(outcome.scenes.slice(1).map((piece) => [piece.sceneId, sceneId]));
    return { ...outcome, project: carryShotLocks(current, outcome.project, { from }) };
  });
}

/**
 * Join a scene with the next one (projectsLogic.mergeNextScene) — the inverse
 * of the split. Returns `{ project, scene }`.
 */
export async function mergeProjectNextScene(id, sceneId, options = {}) {
  const { mergeNextScene } = await import('./projectsLogic.js');
  return mutateProjectRecord(id, (current) => mergeNextScene(current, sceneId, options));
}

/**
 * Merge a scene over the one before it (projectsLogic.mergePreviousScene): this
 * scene starts where the previous one did and the previous one is removed.
 * Returns `{ project, scene }`.
 */
export async function mergeProjectPreviousScene(id, sceneId, options = {}) {
  const { mergePreviousScene } = await import('./projectsLogic.js');
  return mutateProjectRecord(id, (current) => mergePreviousScene(current, sceneId, options));
}

/**
 * Move the cut before a shot: the shot starts at `startSec` and the shot
 * before it ends there, so the two stay joined. Returns `{ project, scene, previous }`.
 */
export async function moveProjectSceneStart(id, sceneId, { startSec }) {
  const { applySceneUpdate } = await import('./projectsLogic.js');
  return mutateProjectRecord(id, (current) => {
    const scenes = current.scenes || [];
    const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
    if (index < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
    const scene = scenes[index];
    const previous = index > 0 ? scenes[index - 1] : null;
    if (typeof scene.endSec === 'number' && startSec >= scene.endSec) {
      throw new ServerError('A shot has to start before it ends', { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (previous && typeof previous.startSec === 'number' && startSec <= previous.startSec) {
      throw new ServerError('The shot before this one would have no length left', { status: 400, code: 'VALIDATION_ERROR' });
    }
    let project = applySceneUpdate(current, sceneId, { startSec }).project;
    if (previous) project = applySceneUpdate(project, previous.sceneId, { endSec: startSec }).project;
    return { project, scene: project.scenes[index], previous: previous ? project.scenes[index - 1] : null };
  });
}

/**
 * Mark assets ★ ingredient or ✕ bad (null clears). Returns the project's marks and
 * the shots whose takes a bad mark rejected.
 */
export async function markMediaPoolAssets(id, keys, mark) {
  const { markPoolAssets } = await import('./mediaPool.js');
  const { project, scenes } = await mutateProjectRecord(id, (current) => markPoolAssets(current, keys, mark));
  return { assetMarks: project.assetMarks || {}, scenes };
}

// ---- scene takes (#8965) ----
// Append candidate takes to one scene: `{ scene, appended }`. A take fills its
// slot only while the slot is empty, unless `replaceSelection` names a still
// re-render (takes.js).
export async function appendSceneTakes(id, sceneId, inputs) {
  const { appendSceneTakes: append } = await import('./takes.js');
  const outcome = await mutateProjectRecord(id, current => append(current, sceneId, inputs), {
    source: inputs.some(input => input.source === 'generated') ? 'generation-completion' : null,
  });
  await fileAppendedTakes(outcome.project, outcome.appended.map(take => ({ sceneId, take })));
  return { scene: outcome.project.scenes.find(scene => scene.sceneId === sceneId), appended: outcome.appended };
}

// Every take that lands also lands in the project's own collection (mediaPool.js).
function fileAppendedTakes(project, placed) {
  return fileMusicVideoMedia(project, placed.filter(({ take }) => take?.assetId)
    .map(({ sceneId, take }) => ({ kind: take.kind === 'video' ? 'video' : 'image', ref: take.assetId, sceneId, take })));
}

/**
 * Persist (or clear, with `failure` null) a scene's last generation failure —
 * `{ lane: 'image'|'video', error, at }` (#10154). Returns the updated scene.
 */
export async function recordSceneFailure(id, sceneId, failure) {
  const { scene } = await mutateProjectRecord(id, (current) => setSceneLastFailure(current, sceneId, failure));
  return scene;
}

/** Append takes across scenes in one write (handoff import): `{ project, appended }`. */
export async function appendTakesAcrossScenes(id, items) {
  const { appendTakesAcrossScenes: append } = await import('./takes.js');
  const result = await mutateProjectRecord(id, current => append(current, items));
  await fileAppendedTakes(result.project, result.appended.filter(Boolean));
  return result;
}

/** Explicitly select a take for its scene slot. Returns the updated scene. */
export async function selectSceneTake(id, sceneId, takeId) {
  const { selectSceneTake: select } = await import('./takes.js');
  const { scene } = await mutateProjectRecord(id, (current) => select(current, sceneId, takeId));
  return scene;
}

/**
 * Put an unused still or clip from the project's pool on a shot (the shot
 * card's "Swap from unused"): it becomes a take of the shot and its selection.
 * `withAssetId` brings its partner too: a still's clip, or a clip's still.
 * `kind: 'endImage'` puts a still on the shot's end frame instead.
 * The take keeps the prompt and provider of the take it came from, and the
 * shot's start or end frame prompt becomes the one that still was made from. A shot
 * Returns the updated scene.
 */
export async function placeMediaPoolItem(id, sceneId, { kind, assetId, withAssetId = null }) {
  const [{ appendSceneTakes: append, selectSceneTake: select }, { projectTakeAssets }, { authoredFramePrompt }] = await Promise.all([
    import('./takes.js'), import('./mediaPool.js'), import('./handoff.js'),
  ]);
  // A still off the floor has no take left to name its prompt; its image sidecar still does.
  const placedStill = kind === 'video' ? withAssetId : assetId;
  const sidecarPrompt = placedStill
    ? await import('../imageGen/local.js').then(({ readImageSidecar }) => readImageSidecar(placedStill))
      .then(({ metadata }) => (typeof metadata?.prompt === 'string' ? metadata.prompt : null)).catch(() => null)
    : null;
  const { scene } = await mutateProjectRecord(id, (current) => {
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
    let outcome = append(current, sceneId, inputs);
    for (const take of outcome.appended) outcome = { ...select(outcome.project, sceneId, take.takeId), appended: outcome.appended };
    // The placed still's frame prompt comes with it, so the start or end prompt matches the picture.
    const stillTake = outcome.appended.find((take) => take.kind !== 'video');
    const framePrompt = authoredFramePrompt(current, stillTake?.prompt);
    if (framePrompt) {
      const field = stillTake.kind === 'endImage' ? 'endFramePrompt' : 'framePrompt';
      const scenes = outcome.project.scenes.map((scene) => (scene.sceneId === sceneId ? { ...scene, [field]: framePrompt } : scene));
      outcome = { ...outcome, project: { ...outcome.project, scenes }, scene: scenes.find((scene) => scene.sceneId === sceneId) };
    }
    return outcome;
  });
  return scene;
}

/** Reject every take of a shot that is not its selected frame, end frame or clip. Returns `{ scene, rejected }`. */
export async function rejectUnusedSceneTakes(id, sceneId) {
  const { rejectUnusedTakes } = await import('./takes.js');
  const { scene, rejected } = await mutateProjectRecord(id, (current) => rejectUnusedTakes(current, sceneId));
  return { scene, rejected };
}

/** Swap a shot's start and end frames (and their prompts). Returns the scene. */
export async function swapProjectSceneFrames(id, sceneId) {
  const { swapSceneFrames } = await import('./takes.js');
  const { scene } = await mutateProjectRecord(id, (current) => swapSceneFrames(current, sceneId));
  return scene;
}

/** Reject/restore a take and/or set its note. Returns the updated scene. */
export async function reviewSceneTake(id, sceneId, takeId, review) {
  const { reviewSceneTake: reviewTake } = await import('./takes.js');
  const { scene } = await mutateProjectRecord(id, (current) => reviewTake(current, sceneId, takeId, review));
  return scene;
}

/**
 * Apply a pure record transform under the backend's write serialization (file
 * write tail / PG row lock). `transform(project)` returns `{ project, ...result }`;
 * resolves to that outcome with the persisted project. Used by the treatment
 * service (#8980) so its revision checks run against the freshest record.
 */
export function mutateProjectRecord(id, transform, options = {}) {
  return mutateProjectRecordAdmitted(id, transform, options);
}

async function mutateProjectRecordAdmitted(id, transform, _options = {}, mutate = null) {
  let dropped = null;
  const write = mutate || (await selectBackend()).mutateProjectRecord;
  const outcome = await write(id, async (current) => {
    // A transform may be async: the thumbnail heal re-checks job liveness under the lock.
    const outcome = await transform(current);
    await assertNewMediaSelections(current, outcome.project);
    dropped = { project: current, assets: droppedTakeAssets(current, outcome.project) };
    return { ...outcome, project: retainMusicVideoDependencies(current, outcome.project) };
  });
  emitRecordUpdated('musicVideoProject', id);
  // A cut shot, a merge or a re-plan drops takes from the board: they stay findable in the project's collection.
  if (dropped?.assets.length) await fileMusicVideoMedia(dropped.project, dropped.assets);
  return outcome;
}

/** Merge an incoming batch of project records from a peer (LWW, tombstone-aware). */
export async function mergeProjectsFromSync(remoteProjects, options = {}) {
  return (await selectBackend()).mergeProjectsFromSync(remoteProjects, options);
}

/** Hard-remove project tombstones older than the cutoff (called by tombstone GC). */
export async function pruneTombstonedProjects(olderThanMs) {
  return (await selectBackend()).pruneTombstonedProjects(olderThanMs);
}
