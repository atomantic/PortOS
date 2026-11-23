import { assertMusicVideoMediaSelections } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
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

import { droppedTakeAssets, fileMusicVideoMedia, fileAppendedTakes, assertNewMediaSelections, markPoolAssets } from './mediaPool.js';
import { presentMusicVideoDependencies, retainMusicVideoDependencies } from '../../lib/musicVideo/musicVideoDependencies.js';
import { createRecordStoreBackendSelector } from '../../lib/pgFileFacade.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { VIDEO_GEN_MODE, resolveVideoMode } from '../videoGen/modes.js';
import { getSettings } from '../settings.js';
import { withStyleSnapshots } from './styleSnapshots.js';
import { queueProjectCatalogLinkSync } from './catalogLinks.js';
import { labelProjectReferences } from './referenceLabels.js';
import { musicVideoEvents } from './events.js';
import { audioRevisionOf } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { renumberShotLabels } from '../../lib/musicVideo/musicVideoColdOpen.js';
import { removeProjectSegments } from './shotSegmentPaths.js';

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

// The catalog link sync and reference naming read and write through this store, which hands them its
// own accessors so neither module imports it back.
const syncCatalogLinks = (id) => queueProjectCatalogLinkSync(id, { getProject });

const hasLinkedSubjects = (project) => Array.isArray(project?.concept?.subjects) && project.concept.subjects.some((subject) => subject?.ingredientId);

export async function listProjects(options = {}) {
  const projects = await (await selectBackend()).listProjects(options);
  if (getBackendName() !== 'postgres' || !projects.some(hasLinkedSubjects)) return projects;
  const { resolveProjectsCatalogDescriptions } = await import('./subjectDescriptionSync.js');
  return resolveProjectsCatalogDescriptions(projects);
}

/** Live `{ id, name }` rows for the sidebar's Music Video sub-nav. */
export async function listProjectNames() {
  return (await selectBackend()).listProjectNames();
}

export async function listProjectPage(options = {}) {
  const page = await (await selectBackend()).listProjectPage(options);
  if (getBackendName() !== 'postgres' || !page.items.some(hasLinkedSubjects)) return page;
  const { resolveProjectsCatalogDescriptions } = await import('./subjectDescriptionSync.js');
  return { ...page, items: await resolveProjectsCatalogDescriptions(page.items) };
}

/** Ids of projects that may count toward a catalog record's completion (projectFilmActions.listProjectCompletion). */
export async function listCompletionCandidateIds(ingredientIds) {
  return (await selectBackend()).listCompletionCandidateIds(ingredientIds);
}

/** Stored records for a batch of ids, unpresented (projectFilmActions.listProjectCompletion). */
export async function getStoredProjectsByIds(ids) {
  return (await selectBackend()).getProjectsByIds(ids);
}

/** The record exactly as stored, with no dependency or catalog presentation (a pacing recut hashes it). */
export async function getStoredProjectRecord(id, options = {}) {
  return (await selectBackend()).getProject(id, options);
}

/** The stored snapshots, used when offering a legacy difference for review. */
export async function getStoredProject(id, options = {}) {
  return presentMusicVideoDependencies(await (await selectBackend()).getProject(id, options));
}

async function withCatalogDescriptions(project, { catalogReads = null } = {}) {
  let current = project;
  if (getBackendName() === 'postgres' && hasLinkedSubjects(project)) {
    const { resolveProjectCatalogDescriptions } = await import('./subjectDescriptionSync.js');
    current = await resolveProjectCatalogDescriptions(project);
  }
  if (current?.castAndSets?.source !== 'catalog') return current;
  const { withCatalogCheckin } = await import('./catalogCheckin.js');
  return catalogReads ? withCatalogCheckin(current, { reads: catalogReads }) : withCatalogCheckin(current);
}

/**
 * Null when missing; linked descriptions come from the catalog when usable.
 * `options.catalogReads` (catalogCheckin.createCatalogReads) lets a read route reuse this
 * check-in's catalog reads for the next one it resolves.
 */
export async function getProject(id, options = {}) {
  const { catalogReads = null, ...readOptions } = options;
  const backend = await selectBackend();
  return presentMusicVideoDependencies(await withCatalogDescriptions(await backend.getProject(id, readOptions), { catalogReads }));
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
import { getTrack } from '../tracks/index.js';
import { parseLyricCues } from './timedText.js';
import { setSceneLastFailure, appendSceneTakes as appendTakes, appendTakesAcrossScenes as appendTakesAcross, selectSceneTake as selectTake, rejectUnusedTakes, swapSceneFrames, reviewSceneTake as reviewTake } from './takes.js';

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
  syncCatalogLinks(project.id);
  return withCatalogDescriptions(project);
}

// Import and clone workflows (projectFilmActions.js) create through these, so the record never exists
// without its machine-local film: a failure in `create` or `finish` removes the half-made record and runs
// `rollback`, then rethrows. Success announces the project like any new one.
async function admitNewProject(create, { finish = null, rollback = null } = {}) {
  const backend = await selectBackend();
  let project = null;
  try {
    project = await create(backend);
    if (finish) await finish(project);
  } catch (error) {
    await Promise.all([project ? backend.deleteProject(project.id) : null, rollback?.()]);
    throw error;
  }
  announceNewProject(project.id);
  return project;
}

/** Create a seeded project; the backend runs `prepare({ id })` inside its create and stores what it returns. */
export async function createProjectWith(input, { prepare, finish, rollback } = {}) {
  const seeded = await seedTrackMetadata(await seedVideoBackendDefault(input));
  return admitNewProject((backend) => backend.createProject(seeded, prepare), { finish, rollback });
}

/** Clone a project record (`options.id` names the new version); resolves to the clone as GET presents it. */
export async function cloneProjectWith(id, options, { finish, rollback } = {}) {
  const project = await admitNewProject((backend) => backend.cloneProject(id, options), { finish, rollback });
  syncCatalogLinks(project.id);
  return withCatalogDescriptions(project);
}

// The patch as it is written: the linked track's song metadata and the style snapshots it names.
async function resolveProjectPatch(backend, id, patch) {
  const seeded = await seedTrackMetadataOnUpdate(id, patch);
  const { catalogDescriptionBases = [], ...projectPatch } = seeded;
  const needsSnapshot = projectPatch?.concept?.universeId !== undefined || projectPatch?.concept?.characterStyleId !== undefined
    || projectPatch?.visualSpec?.moodBoardId !== undefined;
  const resolved = needsSnapshot ? await withStyleSnapshots(projectPatch, await backend.getProject(id)) : projectPatch;
  return {
    resolved,
    catalogDescriptionBases,
    castChanged: resolved?.concept?.subjects !== undefined,
    // A reference added from the gallery or a mood board takes its catalog record's name.
    // Linking the cast alone leaves approvals current, so naming then must not stale them.
    referencesChanged: resolved?.visualSpec?.references !== undefined,
  };
}

const nameProjectReferences = (id, referencesChanged) => labelProjectReferences(id, { backfill: !referencesChanged, getProject, mutateProjectRecord });

/** Merge a project patch; resolves to the saved project. */
export async function updateProject(id, patch) {
  const backend = await selectBackend();
  const { resolved, catalogDescriptionBases, castChanged, referencesChanged } = await resolveProjectPatch(backend, id, patch);
  const nameReferences = async (saved) => (referencesChanged || castChanged
    ? (await nameProjectReferences(id, referencesChanged))?.project || saved : saved);
  if (!castChanged && !Array.isArray(resolved.scenes)) {
    const next = await backend.updateProject(id, resolved);
    emitRecordUpdated('musicVideoProject', id);
    // The render listener compares its job's revision with the row's itself.
    if ('trackId' in resolved || 'uploadedAudioFilename' in resolved) announceAudioChange(id, next);
    return nameReferences(await withCatalogDescriptions(next));
  }
  const { applyProjectPatch } = await import('./projectsLogic.js');
  const { project } = await mutateProjectRecord(id, (current) => ({ project: applyProjectPatch(current, resolved) }),
    { catalogDescriptionBases, includeNewLinks: true });
  if (castChanged) syncCatalogLinks(id);
  return nameReferences(project);
}

/**
 * The editing tab's project patch, which projectBoardEdits.updateProject presents as an edit result:
 * resolves to `{ before, after }`, the records around the write and its follow-ups (reference naming).
 */
export async function updateProjectForEdit(id, patch) {
  const backend = await selectBackend();
  const { resolved, catalogDescriptionBases, castChanged, referencesChanged } = await resolveProjectPatch(backend, id, patch);
  const { applyProjectPatch } = await import('./projectsLogic.js');
  const edit = {};
  await mutateProjectRecord(id, (current) => ({ project: applyProjectPatch(current, resolved) }),
    { catalogDescriptionBases, includeNewLinks: true, presentProject: false, edit });
  if (castChanged) syncCatalogLinks(id);
  // Naming the references is a second write: when it changed any, the edit result is taken against the record as it is now.
  const named = referencesChanged || castChanged ? await nameProjectReferences(id, referencesChanged) : null;
  return { before: edit.before, after: named ? await getProject(id, edit.reads ? { catalogReads: edit.reads } : {}) : edit.after };
}

export async function deleteProject(id) {
  const result = await (await selectBackend()).deleteProject(id);
  // Soft-delete tombstone — push the deletion to subscribed peers immediately.
  emitRecordDeleted('musicVideoProject', id);
  syncCatalogLinks(id);
  // Its cached shot segments are regenerable, and only this machine's.
  await removeProjectSegments(id).catch((err) => {
    console.warn(`⚠️ Music Video ${id.slice(0, 8)}: could not remove its cached shot segments: ${err.message}`);
  });
  return result;
}

export async function setProjectAnalysis(id, analysis, sourceProject) {
  const next = await (await selectBackend()).setProjectAnalysis(id, analysis, sourceProject);
  emitRecordUpdated('musicVideoProject', id);
  return withCatalogDescriptions(next);
}

/** Replace the song map with the director's edited sections; resolves to the updated project. */
export async function setProjectSections(id, sections) {
  const { setAnalysisSections } = await import('./projectsLogic.js');
  const { project } = await mutateProjectRecord(id, (current) => ({ project: setAnalysisSections(current, sections) }));
  return project;
}

/** Add a director's shot at its time; shots locked before stay locked. Resolves to the new shot. */
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

// Shot edits that answer with shots: the write keeps its clean-up (it still resolves the
// check-in to drop stale catalog picks) but does not present the saved project afterwards.
const SCENES_REPLY = Object.freeze({ presentProject: false });

/** Edit a shot against the fresh record so concurrent changes are not overwritten. Returns the scene. */
export async function updateScene(id, sceneId, patch) {
  const { applySceneUpdate } = await import('./projectsLogic.js');
  const { updated } = await mutateProjectRecord(id, (current) => applySceneUpdate(current, sceneId, patch), SCENES_REPLY);
  return updated;
}

// Take decisions (select, reject, mark, swap) touch only scenes and marks and answer with
// scenes, so they skip the catalog check-in and description resolution around the write:
// those read every linked catalog record and stat its media, twice per click.
const SCENE_ONLY = Object.freeze({ sceneOnly: true });

/**
 * Mark assets ★ ingredient or ✕ bad (null clears). Returns the project's marks,
 * the shots whose takes a bad mark rejected or moved, and the per-shot changes list.
 */
export async function markMediaPoolAssets(id, keys, mark, options = {}) {
  let changes = [];
  const { project, scenes } = await mutateProjectRecord(id, (current) => {
    const outcome = markPoolAssets(current, keys, mark, options);
    changes = outcome.changes || [];
    return outcome;
  }, SCENE_ONLY);
  return { assetMarks: project.assetMarks || {}, scenes, changes };
}

// ---- scene takes (#8965) ----
// Append candidate takes to one scene: `{ scene, appended }`. A take fills its
// slot only while the slot is empty, unless `replaceSelection` names a still
// re-render (takes.js).
export async function appendSceneTakes(id, sceneId, inputs) {
  const source = inputs.some(input => input.source === 'generated') ? 'generation-completion' : null;
  const outcome = await mutateProjectRecord(id, current => appendTakes(current, sceneId, inputs), { source });
  await fileAppendedTakes(outcome.project, outcome.appended.map(take => ({ sceneId, take })));
  return { scene: outcome.project.scenes.find(scene => scene.sceneId === sceneId), appended: outcome.appended };
}

/**
 * Persist (or clear, with `failure` null) a scene's last generation failure —
 * `{ lane: 'image'|'video', error, at }` (#10154). Returns the updated scene.
 */
export async function recordSceneFailure(id, sceneId, failure) {
  const { scene } = await mutateProjectRecord(id, (current) => setSceneLastFailure(current, sceneId, failure), SCENES_REPLY);
  return scene;
}

/** Append takes across scenes in one write (handoff import): `{ project, appended }`. */
export async function appendTakesAcrossScenes(id, items) {
  const result = await mutateProjectRecord(id, current => appendTakesAcross(current, items));
  await fileAppendedTakes(result.project, result.appended.filter(Boolean));
  return result;
}

/** Explicitly select a take for its scene slot. Returns the updated scene. */
export async function selectSceneTake(id, sceneId, takeId, options = {}) {
  return (await mutateProjectRecord(id, (current) => selectTake(current, sceneId, takeId, options), SCENE_ONLY)).scene;
}

/** Reject every take of a shot that is not its selected frame, end frame or clip. Returns `{ scene, rejected }`. */
export async function rejectUnusedSceneTakes(id, sceneId) {
  const { scene, rejected } = await mutateProjectRecord(id, (current) => rejectUnusedTakes(current, sceneId), SCENE_ONLY);
  return { scene, rejected };
}

/** Swap a shot's start and end frames (and their prompts). Returns the scene. */
export async function swapProjectSceneFrames(id, sceneId) {
  return (await mutateProjectRecord(id, (current) => swapSceneFrames(current, sceneId), SCENE_ONLY)).scene;
}

/** Reject/restore a take and/or set its note. Returns the updated scene. */
export async function reviewSceneTake(id, sceneId, takeId, review) {
  // A catalog project's character references come from its check-in, which only the full write resolves (#16473).
  const accepting = Boolean(review.acceptCharacterReferences);
  const { project, scene } = await mutateProjectRecord(id, (current) => reviewTake(current, sceneId, takeId, review), accepting ? {} : SCENE_ONLY);
  // The full write's saved project already carries its check-in; present the accepted shot as GET does.
  if (accepting) return presentMusicVideoDependencies(project).scenes.find((entry) => entry.sceneId === sceneId) || scene;
  // A scene-only write presents takes against the stored record. A confirmation's reply is what the
  // board shows as cleared, so present it as GET does, with the catalog check-in (#16274).
  if (!review.confirmFrame || project?.castAndSets?.source !== 'catalog') return scene;
  const { withCatalogCheckin } = await import('./catalogCheckin.js');
  const presented = presentMusicVideoDependencies(await withCatalogCheckin(project));
  return presented.scenes.find((entry) => entry.sceneId === sceneId) || scene;
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

// A changed song cancels this instance's render of the old one (render.js).
const announceAudioChange = (projectId, project) => musicVideoEvents.emit('audio-changed', { projectId, project });

// The scenes a transform answers with, as the clean-up saved them.
function withCleanedScenes(outcome, project) {
  const byId = new Map((project.scenes || []).map((scene) => [scene.sceneId, scene]));
  const fresh = (scene) => (scene?.sceneId && byId.get(scene.sceneId)) || scene;
  const result = { project };
  for (const key of ['scene', 'updated', 'previous', 'next']) if (outcome[key]?.sceneId) result[key] = fresh(outcome[key]);
  if (Array.isArray(outcome.scenes)) result.scenes = outcome.scenes.map(fresh);
  return result;
}

async function mutateProjectRecordAdmitted(id, transform, options = {}, mutate = null) {
  let dropped = null;
  let audioChanged = false;
  let catalogRecords = [];
  let descriptions = null;
  const write = mutate || (await selectBackend()).mutateProjectRecord;
  const sceneOnly = options.sceneOnly === true;
  // A mutator that answers with shots, never the project, skips presenting the saved record:
  // nothing reads its catalog descriptions or check-in, which re-read every linked record (#16210).
  const presentProject = options.presentProject !== false;
  // `options.edit` (an object): fill it with the record before and after the write, both with their
  // catalog check-in, so the caller can answer with an edit result (editResult.js) instead of the project.
  // Both check-ins share one set of catalog reads, so the edit result adds none of its own.
  const edit = options.edit && !sceneOnly ? options.edit : null;
  const reads = edit ? (await import('./catalogCheckin.js')).createCatalogReads() : null;
  let presentedConcept = null;
  const outcome = await write(id, async (stored, context = {}) => {
    if (sceneOnly) {
      const outcome = await transform(stored, { ...context, storedProject: stored });
      const cleaned = renumberShotLabels(outcome.project);
      if (cleaned !== outcome.project) Object.assign(outcome, withCleanedScenes(outcome, cleaned));
      await assertNewMediaSelections(stored, outcome.project);
      dropped = { project: stored, assets: droppedTakeAssets(stored, outcome.project) };
      return { ...outcome, project: retainMusicVideoDependencies(stored, outcome.project) };
    }
    if (context.client && hasLinkedSubjects(stored)) descriptions = await import('./subjectDescriptionSync.js');
    let current = descriptions ? await descriptions.resolveProjectCatalogDescriptions(stored, { client: context.client }) : stored;
    if (current?.castAndSets?.source === 'catalog') {
      const { withCatalogCheckin } = await import('./catalogCheckin.js');
      current = await withCatalogCheckin(current, { client: context.client, ...(reads ? { reads } : {}) });
    }
    if (edit) edit.before = current;
    // A transform may be async: the thumbnail heal re-checks job liveness under the lock.
    const outcome = await transform(current, { ...context, storedProject: stored });
    // Automatic clean-up in the same write (#15317): default "Shot N" labels follow the
    // shot's number, and picks of catalog images that can never render again go.
    if (outcome.project && !outcome.skipPersist) {
      const picked = current?.castAndSets?.catalogCheckin
        ? (await import('./catalogCheckin.js')).dropStaleCatalogPicks(current, outcome.project) : outcome.project;
      const cleaned = renumberShotLabels(picked);
      if (cleaned !== outcome.project) Object.assign(outcome, withCleanedScenes(outcome, cleaned));
    }
    if (outcome.project?.castAndSets?.catalogCheckin) {
      const { catalogCheckin: _projection, ...stage } = outcome.project.castAndSets;
      outcome.project = { ...outcome.project, castAndSets: stage };
    }
    // A newly linked subject may be the first catalog link on this project.
    if (context.client && !descriptions && hasLinkedSubjects(outcome.project)) descriptions = await import('./subjectDescriptionSync.js');
    const bases = options.catalogDescriptionBases ?? (current.concept?.subjects || []).map((subject) => ({ subjectId: subject.id, description: subject.description || '' }));
    const synced = descriptions && !outcome.skipPersist && !options.skipDescriptionSync
      ? await descriptions.syncEditedSubjectDescriptions(current, outcome.project, { client: context.client, bases, includeNewLinks: options.includeNewLinks })
      : { project: outcome.project, records: [] };
    catalogRecords = [...(outcome.catalogRecords || []), ...synced.records];
    // The saved record keeps unchanged description snapshots; GET shows the live ones, as `synced` has them.
    presentedConcept = descriptions ? synced.project?.concept ?? null : null;
    const next = descriptions ? descriptions.preserveUnchangedDescriptionSnapshots(stored, current, synced.project, options.commitSubjectIds) : synced.project;
    await assertNewMediaSelections(stored, next);
    dropped = { project: stored, assets: droppedTakeAssets(stored, next) };
    audioChanged = audioRevisionOf(next) !== audioRevisionOf(stored);
    return { ...outcome, project: retainMusicVideoDependencies(stored, next) };
  });
  emitRecordUpdated('musicVideoProject', id);
  if (audioChanged) announceAudioChange(id, outcome.project);
  // A cut shot, a merge or a re-plan drops takes from the board: they stay findable in the project's collection.
  if (dropped?.assets.length) await fileMusicVideoMedia(dropped.project, dropped.assets);
  if (descriptions) {
    // The project and catalog are already committed; a notification failure
    // must not report the saved edit as failed and invite a conflicting retry.
    await descriptions.announceDescriptionEdits(catalogRecords)
      .catch((err) => console.error(`🔁 catalog change notification failed: ${err.message}`));
    if (presentProject) outcome.project = await descriptions.resolveProjectCatalogDescriptions(outcome.project);
  }
  // Presentation is reconstructed after commit: sockets and mutation replies need
  // the same live catalog state as GET, without storing its derived media list.
  if (!sceneOnly && presentProject && outcome.project?.castAndSets?.source === 'catalog') {
    const { withCatalogCheckin } = await import('./catalogCheckin.js');
    outcome.project = await withCatalogCheckin(outcome.project);
  }
  if (edit && outcome.project) {
    let after = presentedConcept ? { ...outcome.project, concept: presentedConcept } : outcome.project;
    if (after.castAndSets?.source === 'catalog' && !after.castAndSets.catalogCheckin) {
      const { withCatalogCheckin } = await import('./catalogCheckin.js');
      // A write that also edited catalog records reads them again; otherwise the write's reads still hold.
      after = await withCatalogCheckin(after, catalogRecords.length ? {} : { reads });
    }
    edit.after = after;
    edit.reads = catalogRecords.length ? null : reads;
  }
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
