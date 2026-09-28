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

import { createRecordStoreBackendSelector } from '../../lib/pgFileFacade.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { VIDEO_GEN_MODE, resolveVideoMode } from '../videoGen/modes.js';
import { getSettings } from '../settings.js';

// Shared dispatcher (#2899). ensureSchema() runs inside the selector (mirroring
// memoryBackend.js) so the backend is self-sufficient regardless of boot ordering.
const { selectBackend, getBackendName } = createRecordStoreBackendSelector({
  label: 'Music Video',
  loadFileBackend: () => import('./projectsFile.js'),
  loadDbBackend: () => import('./projectsDB.js'),
  requireDbMessage: 'Music Video requires PostgreSQL — run `npm run setup:db` (dev/test only: set PGMODE=file in .env)',
});

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

export async function getProject(id, options = {}) {
  return (await selectBackend()).getProject(id, options);
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

export async function createProject(input) {
  const project = await (await selectBackend()).createProject(await seedVideoBackendDefault(input));
  announceNewProject(project.id);
  return project;
}

export async function cloneProject(id, options = {}) {
  const project = await (await selectBackend()).cloneProject(id, options);
  announceNewProject(project.id);
  return project;
}

export async function updateProject(id, patch) {
  const next = await (await selectBackend()).updateProject(id, patch);
  emitRecordUpdated('musicVideoProject', id);
  return next;
}

export async function deleteProject(id) {
  const result = await (await selectBackend()).deleteProject(id);
  // Soft-delete tombstone — push the deletion to subscribed peers immediately.
  emitRecordDeleted('musicVideoProject', id);
  return result;
}

export async function setProjectAnalysis(id, analysis) {
  const next = await (await selectBackend()).setProjectAnalysis(id, analysis);
  emitRecordUpdated('musicVideoProject', id);
  return next;
}

export async function setProjectMidiTranscription(id, midi) {
  const next = await (await selectBackend()).setProjectMidiTranscription(id, midi);
  emitRecordUpdated('musicVideoProject', id);
  return next;
}

export async function addProjectScene(id, sceneInput) {
  const scene = await (await selectBackend()).addProjectScene(id, sceneInput);
  emitRecordUpdated('musicVideoProject', id);
  return scene;
}

/**
 * Bulk-append scenes (the autonomous planner, #1855) — emits one update, not
 * N. Returns `{ project, scenes }` — the freshly-persisted project, so a
 * caller composing a response never has to re-fetch or risk overwriting a
 * concurrent edit with stale state.
 */
export async function addProjectScenes(id, sceneInputs) {
  const { project, scenes } = await (await selectBackend()).addProjectScenes(id, sceneInputs);
  emitRecordUpdated('musicVideoProject', id);
  return { project, scenes };
}

export async function updateScene(id, sceneId, patch) {
  const result = await (await selectBackend()).updateScene(id, sceneId, patch);
  emitRecordUpdated('musicVideoProject', id);
  return result;
}

export async function deleteScene(id, sceneId) {
  const next = await (await selectBackend()).deleteScene(id, sceneId);
  emitRecordUpdated('musicVideoProject', id);
  return next;
}

export async function reorderProjectScenes(id, orderedIds) {
  const next = await (await selectBackend()).reorderProjectScenes(id, orderedIds);
  emitRecordUpdated('musicVideoProject', id);
  return next;
}

// ---- scene takes (#8965) ----
// Append candidate takes to one scene: `{ scene, appended }`. A take fills its
// slot only while the slot is empty — never replaces a selection (takes.js).
export async function appendSceneTakes(id, sceneId, inputs) {
  const result = await (await selectBackend()).appendSceneTakes(id, sceneId, inputs);
  emitRecordUpdated('musicVideoProject', id);
  return result;
}

/** Append takes across scenes in one write (handoff import): `{ project, appended }`. */
export async function appendTakesAcrossScenes(id, items) {
  const result = await (await selectBackend()).appendTakesAcrossScenes(id, items);
  emitRecordUpdated('musicVideoProject', id);
  return result;
}

/** Explicitly select a take for its scene slot. Returns the updated scene. */
export async function selectSceneTake(id, sceneId, takeId) {
  const scene = await (await selectBackend()).selectSceneTake(id, sceneId, takeId);
  emitRecordUpdated('musicVideoProject', id);
  return scene;
}

/** Reject/restore a take and/or set its note. Returns the updated scene. */
export async function reviewSceneTake(id, sceneId, takeId, review) {
  const scene = await (await selectBackend()).reviewSceneTake(id, sceneId, takeId, review);
  emitRecordUpdated('musicVideoProject', id);
  return scene;
}

/**
 * Apply a pure record transform under the backend's write serialization (file
 * write tail / PG row lock). `transform(project)` returns `{ project, ...result }`;
 * resolves to that outcome with the persisted project. Used by the treatment
 * service (#8980) so its revision checks run against the freshest record.
 */
export async function mutateProjectRecord(id, transform) {
  const outcome = await (await selectBackend()).mutateProjectRecord(id, transform);
  emitRecordUpdated('musicVideoProject', id);
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
