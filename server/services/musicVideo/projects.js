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

import { droppedTakeAssets, fileMusicVideoMedia, assertNewMediaSelections, markPoolAssets, projectTakeAssets } from './mediaPool.js';
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

export async function listProjectCompletion({ ingredientIds, matchesName } = {}) {
  const backend = await selectBackend();
  const ids = await backend.listCompletionCandidateIds(ingredientIds);
  if (!ids.length) return [];
  const [{ readProjectCompletion }, { createCatalogReads }] = await Promise.all([
    import('./projectPresentation.js'),
    import('./catalogCheckin.js'),
  ]);
  const reads = createCatalogReads();
  const states = [];
  const batchSize = 30;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const records = await backend.getProjectsByIds(ids.slice(offset, offset + batchSize));
    const candidates = records.filter(project => project.status === 'complete' && (!matchesName || matchesName(project)));
    states.push(...await Promise.all(candidates.map(async (project) => ({
      id: project.id,
      name: project.name,
      isCompleted: await readProjectCompletion(project, { reads, requireCatalog: !!ingredientIds }),
    }))));
  }
  return states;
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
import { getTrack, updateTrack } from '../tracks/index.js';
import { parseLyricCues } from './timedText.js';
import { ServerError } from '../../lib/errorHandler.js';
import { randomUUID } from 'crypto';
import { setSceneLastFailure, appendSceneTakes as appendTakes, appendTakesAcrossScenes as appendTakesAcross, selectSceneTake as selectTake, rejectUnusedTakes, swapSceneFrames, reviewSceneTake as reviewTake, plateCheckPrompt, plateCheckTake, recordTakePlateEvidence } from './takes.js';
import { plateFrameRole } from '../../lib/musicVideo/musicVideoPlateEvidence.js';

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
  return withCatalogDescriptions(project);
}

/** Import a standalone film into a fresh, unanalyzed project; never starts work. */
export async function createProjectFromFilm(input, sourceOwner, settings) {
  const backend = await selectBackend();
  const [{ copyBlenderFilm, removeBlenderFilmCopy }, { musicVideoFilmOwner }, { readBlenderManifest, writeBlenderManifest }, { normalizeBlenderRecord }] = await Promise.all([
    import('../film/fork.js'), import('./blender/owner.js'), import('../film/manifest.js'), import('../../lib/musicVideo/musicVideoBlender.js'),
  ]);
  const seeded = await seedTrackMetadata(await seedVideoBackendDefault(input));
  let target = null;
  let project = null;
  try {
    project = await backend.createProject(seeded, async ({ id }) => {
      target = musicVideoFilmOwner(id);
      const [{ lstat }, { join }] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      const copied = await copyBlenderFilm(sourceOwner, target);
      if (!copied || !(await lstat(join(target.workspaceDir, 'src', 'film.py')).catch(() => null))?.isFile()) {
        throw new ServerError('Create the film workspace before sending it to Music Video', { status: 409, code: 'MUSIC_VIDEO_BLENDER_NO_FILM' });
      }
      const manifest = await readBlenderManifest(target);
      // Keep the authored shot/options inventory, but its timing has never been synced to this song.
      if (manifest) await writeBlenderManifest(target, { ...manifest, syncedAt: null });
      return { blender: { settings }, sourceFilm: { kind: sourceOwner.kind, projectId: sourceOwner.id } };
    });
    const { writeBlenderSong } = await import('./blender/song.js');
    await writeBlenderSong(project, normalizeBlenderRecord(project.blender).settings);
  } catch (error) {
    await Promise.all([project ? backend.deleteProject(project.id) : null, target ? removeBlenderFilmCopy(target) : null]);
    throw error;
  }
  announceNewProject(project.id);
  return project;
}

// A Blender film's scripts live in the source's workspace. A new version gets its own copy,
// placed under the id it is about to take, so the record never exists without its film.
// Resolves null when the source has no film to copy (the clone then keeps only its settings).
async function forkBlenderFilm(backend, sourceId) {
  const source = await backend.getProject(sourceId);
  if (!source?.blender || source.deleted) return null;
  const { copyBlenderFilm, removeBlenderFilmCopy } = await import('./blender/fork.js');
  const id = `mv-${randomUUID()}`;
  if (!(await copyBlenderFilm(sourceId, id))) return null;
  return { id, discard: () => removeBlenderFilmCopy(id) };
}

export async function cloneProject(id, options = {}) {
  const backend = await selectBackend();
  const cloneOptions = { ...options };
  delete cloneOptions.id;
  delete cloneOptions.blenderFilm;
  // A footage adaptation leaves the film behind: its shots become footage.
  const film = cloneOptions.variant === 'video-generation' ? null : await forkBlenderFilm(backend, id);
  let project = null;
  try {
    project = await backend.cloneProject(id, { ...cloneOptions, id: film?.id ?? `mv-${randomUUID()}`, blenderFilm: Boolean(film) });
    if (film) {
      // The copied song.json names the source project; publish the fork only after its own is written.
      const [{ writeBlenderSong }, { normalizeBlenderRecord }] = await Promise.all([import('./blender/song.js'), import('../../lib/musicVideo/musicVideoBlender.js')]);
      await writeBlenderSong(project, normalizeBlenderRecord(project.blender).settings);
    }
  } catch (error) {
    await Promise.all([project ? backend.deleteProject(project.id) : null, film?.discard()]);
    throw error;
  }
  announceNewProject(project.id);
  queueProjectCatalogLinkSync(project.id);
  return withCatalogDescriptions(project);
}

/**
 * Merge a project patch. With `{ edit: true }` it answers `{ edit }` (editResult.js) instead of the
 * project, taken after the write's own follow-ups (reference naming, style snapshots), so the editing
 * tab patches its board and never reads the project again.
 */
export async function updateProject(id, patch, { edit: answerEdit = false } = {}) {
  const backend = await selectBackend();
  const seeded = await seedTrackMetadataOnUpdate(id, patch);
  const { catalogDescriptionBases = [], ...projectPatch } = seeded;
  const needsSnapshot = projectPatch?.concept?.universeId !== undefined || projectPatch?.concept?.characterStyleId !== undefined
    || projectPatch?.visualSpec?.moodBoardId !== undefined;
  const resolved = needsSnapshot ? await withStyleSnapshots(projectPatch, await backend.getProject(id)) : projectPatch;
  const castChanged = resolved?.concept?.subjects !== undefined;
  // A reference added from the gallery or a mood board takes its catalog record's name.
  // Linking the cast alone leaves approvals current, so naming then must not stale them.
  const referencesChanged = resolved?.visualSpec?.references !== undefined;
  if (answerEdit) {
    const { applyProjectPatch } = await import('./projectsLogic.js');
    const { edit } = await editWrite(id, (current) => ({ project: applyProjectPatch(current, resolved) }),
      { catalogDescriptionBases, includeNewLinks: true });
    if (castChanged) queueProjectCatalogLinkSync(id);
    // Naming the references is a second write: when it changed any, the edit result is taken against the record as it is now.
    const named = referencesChanged || castChanged ? await labelProjectReferences(id, { backfill: !referencesChanged }) : null;
    if (!named) return withEditResult({}, edit);
    return withEditResult({}, edit, await getProject(id, edit.reads ? { catalogReads: edit.reads } : {}));
  }
  const nameReferences = async (saved) => (referencesChanged || castChanged
    ? (await labelProjectReferences(id, { backfill: !referencesChanged }))?.project || saved : saved);
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
  return withCatalogDescriptions(next);
}

/** Replace the song map with the director's edited sections; resolves to the updated project. */
export async function setProjectSections(id, sections) {
  const { setAnalysisSections } = await import('./projectsLogic.js');
  const { project } = await mutateProjectRecord(id, (current) => ({ project: setAnalysisSections(current, sections) }));
  return project;
}

/** Add a director's shot at its time; shots locked before stay locked. */
export async function addProjectScene(id, sceneInput, { edit: answerEdit = false } = {}) {
  const [{ addScene }, { carryShotLocks }] = await Promise.all([import('./projectsLogic.js'), import('./productionReview.js')]);
  const transform = (current) => {
    const outcome = addScene(current, sceneInput);
    return { ...outcome, project: carryShotLocks(current, outcome.project) };
  };
  if (!answerEdit) return (await mutateProjectRecord(id, transform)).scene;
  // `{ edit: true }` answers `{ scene, edit }`: the new shot and the edit result (editResult.js).
  const { outcome, edit } = await editWrite(id, transform);
  const { edit: result } = await withEditResult({}, edit);
  return { scene: outcome.scene, edit: result };
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

// Board edits answer with an edit result (editResult.js, #16247): the shots and read-time state the
// edit changed, so the editing tab patches its copy instead of reading the whole project again.
// `edit` is filled by mutateProjectRecord; `after` replaces its saved record when a board write followed.
async function editWrite(id, transform, options = {}) {
  const edit = {};
  const outcome = await mutateProjectRecord(id, transform, { ...options, presentProject: false, edit });
  return { outcome, edit };
}
async function withEditResult(outcome, edit, after = edit.after) {
  const { presentEditResult } = await import('./editResult.js');
  return { ...outcome, edit: await presentEditResult({ before: edit.before, after }) };
}

/**
 * Edit against the fresh record so concurrent changes are not overwritten. Returns the scene, or
 * with `{ edit: true }` `{ scene, edit }` where `edit` is the edit result.
 */
export async function updateScene(id, sceneId, patch, { edit: answerEdit = false } = {}) {
  const { applySceneUpdate } = await import('./projectsLogic.js');
  if (!answerEdit) {
    const { updated } = await mutateProjectRecord(id, (current) => applySceneUpdate(current, sceneId, patch), SCENES_REPLY);
    return updated;
  }
  const { outcome, edit } = await editWrite(id, (current) => applySceneUpdate(current, sceneId, patch));
  const { edit: result } = await withEditResult({}, edit);
  return { scene: outcome.updated, edit: result };
}

/** "Vary wipes" over a run of shots (projectsLogic.varySceneWipes). Returns `{ project, scenes, edit }`. */
export async function varyProjectWipes(id, options) {
  const { varySceneWipes } = await import('./projectsLogic.js');
  const { outcome, edit } = await editWrite(id, (current) => varySceneWipes(current, options));
  return withEditResult(outcome, edit);
}

/** Remove a shot. Returns `{ project, edit }`. */
export async function deleteScene(id, sceneId) {
  const { removeScene } = await import('./projectsLogic.js');
  const { outcome, edit } = await editWrite(id, (current) => ({ project: removeScene(current, sceneId) }));
  return withEditResult(outcome, edit);
}

/** Put the shots in `orderedIds` order (each slot keeps its timing). Returns `{ project, edit }`. */
export async function reorderProjectScenes(id, orderedIds) {
  const { reorderScenes } = await import('./projectsLogic.js');
  const { outcome, edit } = await editWrite(id, (current) => ({ project: reorderScenes(current, orderedIds) }));
  return withEditResult(outcome, edit);
}

/**
 * Split a shot longer than its backend renders in one take into contiguous
 * scenes on lyric/phrase boundaries (#8977, projectsLogic.splitScene), or in
 * two at `options.atSec`. A locked still stays locked on every piece. Returns `{ project, scenes, edit }`: the persisted project, the pieces and the edit result (editResult.js).
 */
export async function splitProjectScene(id, sceneId, options = {}) {
  const [{ splitScene }, { carryShotLocks }, followShots] = await Promise.all([import('./projectsLogic.js'), import('./productionReview.js'), import('../storyboards/followShots.js')]);
  // A board with no room for the new panels refuses before the shots change.
  const stored = await (await selectBackend()).getProject(id);
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
  return previewPacingRecut(await (await selectBackend()).getProject(id));
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
 * of the split. Returns `{ project, scene, edit }`.
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
 * Returns `{ project, scene, edit }`.
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
 * before it ends there, so the two stay joined. Returns `{ project, scene, previous, edit }`.
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
 * shot just ends there, inside the song. Returns `{ project, scene, next, edit }`.
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

// Take decisions (select, reject, mark, swap) touch only scenes and marks and answer with
// scenes, so they skip the catalog check-in and description resolution around the write:
// those read every linked catalog record and stat its media, twice per click.
const SCENE_ONLY = Object.freeze({ sceneOnly: true });

// A take decision write. With `answerEdit` it answers with the edit result (editResult.js) too, so the
// board shows the readiness and neighbour take staleness the decision changed without a project read.
async function takeDecisionWrite(id, transform, answerEdit) {
  if (!answerEdit) return mutateProjectRecord(id, transform, SCENE_ONLY);
  const { outcome, edit } = await editWrite(id, transform);
  return withEditResult(outcome, edit);
}

/**
 * Mark assets ★ ingredient or ✕ bad (null clears). Returns the project's marks,
 * the shots whose takes a bad mark rejected or moved, and the per-shot changes list.
 */
export async function markMediaPoolAssets(id, keys, mark, options = {}, { edit: answerEdit = false } = {}) {
  let resultChanges = [];
  const { project, scenes, edit } = await takeDecisionWrite(id, (current) => {
    const outcome = markPoolAssets(current, keys, mark, options);
    resultChanges = outcome.changes || [];
    return outcome;
  }, answerEdit);
  return { assetMarks: project.assetMarks || {}, scenes, changes: resultChanges, ...(edit ? { edit } : {}) };
}

// ---- scene takes (#8965) ----
// Append candidate takes to one scene: `{ scene, appended }`. A take fills its
// slot only while the slot is empty, unless `replaceSelection` names a still
// re-render (takes.js).
export async function appendSceneTakes(id, sceneId, inputs, { edit: answerEdit = false } = {}) {
  const source = inputs.some(input => input.source === 'generated') ? 'generation-completion' : null;
  const transform = current => appendTakes(current, sceneId, inputs);
  if (!answerEdit) {
    const outcome = await mutateProjectRecord(id, transform, { source });
    await fileAppendedTakes(outcome.project, outcome.appended.map(take => ({ sceneId, take })));
    return { scene: outcome.project.scenes.find(scene => scene.sceneId === sceneId), appended: outcome.appended };
  }
  const { outcome, edit } = await editWrite(id, transform, { source });
  await fileAppendedTakes(outcome.project, outcome.appended.map(take => ({ sceneId, take })));
  const { edit: result } = await withEditResult({}, edit);
  // The edit result's copy of the shot is presented as GET presents it; an import of a take the shot already has changes nothing.
  return { scene: result.scenes.find(scene => scene.sceneId === sceneId) || outcome.scene, appended: outcome.appended, edit: result };
}

/**
 * Start a shot from a frame: the frame becomes a take and the shot's start frame; with `keepStillAsEnd`
 * its current start frame becomes its end frame (continue from previous). One write, so the reply's edit
 * result covers the whole change. Returns `{ scene, edit }`.
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
  return { scene: result.scenes.find(scene => scene.sceneId === sceneId) || outcome.scene, edit: result };
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
export async function selectSceneTake(id, sceneId, takeId, options = {}, { edit: answerEdit = false } = {}) {
  const { scene, edit } = await takeDecisionWrite(id, (current) => selectTake(current, sceneId, takeId, options), answerEdit);
  return answerEdit ? { scene, edit } : scene;
}

/**
 * Put an unused still or clip from the project's pool on a shot (the shot
 * card's "Swap from unused"): it becomes a take of the shot and its selection.
 * `withAssetId` brings its partner too: a still's clip, or a clip's still.
 * `kind: 'endImage'` puts a still on the shot's end frame instead.
 * The take keeps the prompt and provider of the take it came from, and the
 * shot's start or end frame prompt becomes the one that still was made from.
 * Returns `{ scene, edit }`: the updated scene and the edit result (editResult.js).
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

/** Reject every take of a shot that is not its selected frame, end frame or clip. Returns `{ scene, rejected }`. */
export async function rejectUnusedSceneTakes(id, sceneId, { edit: answerEdit = false } = {}) {
  const { scene, rejected, edit } = await takeDecisionWrite(id, (current) => rejectUnusedTakes(current, sceneId), answerEdit);
  return { scene, rejected, ...(edit ? { edit } : {}) };
}

/** Swap a shot's start and end frames (and their prompts). Returns the scene. */
export async function swapProjectSceneFrames(id, sceneId, { edit: answerEdit = false } = {}) {
  const { scene, edit } = await takeDecisionWrite(id, (current) => swapSceneFrames(current, sceneId), answerEdit);
  return answerEdit ? { scene, edit } : scene;
}

/** Reject/restore a take and/or set its note. Returns the updated scene. */
export async function reviewSceneTake(id, sceneId, takeId, review, { edit: answerEdit = false } = {}) {
  // A catalog project's character references come from its check-in, which only the full write resolves,
  // so accepting them is checked there whether or not the caller wants an edit result (#16473).
  const accepting = Boolean(review.acceptCharacterReferences);
  const { project, scene, edit } = await takeDecisionWrite(id, (current) => reviewTake(current, sceneId, takeId, review), answerEdit || accepting);
  // The edit result's copy of the shot is presented as GET presents it (catalog check-in included).
  if (answerEdit) return { scene: edit.scenes.find((entry) => entry.sceneId === sceneId) || scene, edit };
  if (accepting) return edit.scenes.find((entry) => entry.sceneId === sceneId) || scene;
  // A scene-only write presents takes against the stored record. A confirmation's reply is what the
  // board shows as cleared, so present it as GET does, with the catalog check-in (#16274).
  if (!review.confirmFrame || project?.castAndSets?.source !== 'catalog') return scene;
  const { withCatalogCheckin } = await import('./catalogCheckin.js');
  const presented = presentMusicVideoDependencies(await withCatalogCheckin(project));
  return presented.scenes.find((entry) => entry.sceneId === sceneId) || scene;
}

/**
 * User-started plate check of one frame take, outside a production run: the
 * same vision review a run does, on the project's chosen reviewer or the
 * default (Codex when ready, else an API provider).
 * Its evidence carries a manual run id, so a production run still reviews for itself.
 */
export async function checkSceneTakePlate(id, sceneId, takeId, { edit: answerEdit = false } = {}) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Music video project not found', { status: 404, code: 'NOT_FOUND' });
  const { scene, take } = plateCheckTake(project, sceneId, takeId);
  const { resolvePlateReviewer, reviewPlate } = await import('./plateReview.js');
  const pinned = project.plateReviewer?.providerId ? { providerId: project.plateReviewer.providerId, ...(project.plateReviewer.model ? { model: project.plateReviewer.model } : {}) } : {};
  const reviewer = await resolvePlateReviewer(pinned).catch((error) => { throw new ServerError(error.message, { status: error.status || 422, code: error.code || 'PLATE_REVIEWER_UNAVAILABLE' }); });
  const frameRole = plateFrameRole(take);
  const evidence = await reviewPlate({ scene, subjects: project.concept?.subjects || [], project, assetId: take.assetId, runId: `manual-${randomUUID()}`, reviewer,
    prompt: plateCheckPrompt(scene, take), frameRole });
  const record = (current) => recordTakePlateEvidence(current, sceneId, takeId, evidence);
  if (!answerEdit) return (await mutateProjectRecord(id, record, SCENES_REPLY)).scene;
  const { outcome, edit } = await editWrite(id, record);
  const { edit: result } = await withEditResult({}, edit);
  return { scene: result.scenes.find((entry) => entry.sceneId === sceneId) || outcome.scene, edit: result };
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
