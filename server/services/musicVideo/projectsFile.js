/**
 * Music Video — file-backed project store (escape-hatch / test backend).
 *
 * Persists to data/music-video-projects.json (array, atomicWrite). Reachable
 * only via MEMORY_BACKEND=file or NODE_ENV=test — PostgreSQL (projectsDB.js) is
 * the default. All mutation semantics live in projectsLogic.js so this backend
 * and the PG backend can't drift; this module only does load/find/persist.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  buildProjectRecord,
  applyProjectPatch,
  setAudioAnalysis,
  addScene,
  addScenes,
  applySceneUpdate,
  removeScene,
  reorderScenes,
  mergeProjectRecord,
} from './projectsLogic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';

const PROJECTS_FILE = join(PATHS.data, 'music-video-projects.json');

async function loadAll() {
  const raw = await readJSONFile(PROJECTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

async function saveAll(projects) {
  await ensureDir(PATHS.data);
  await atomicWrite(PROJECTS_FILE, projects);
}

export async function listProjects({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return includeDeleted ? all : all.filter((p) => !p.deleted);
}

export async function getProject(id, { includeDeleted = false } = {}) {
  const all = await loadAll();
  const found = all.find((p) => p.id === id);
  if (!found) return null;
  return includeDeleted || !found.deleted ? found : null;
}

/** Live project ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listProjectIds({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((p) => !p.deleted)).map((p) => p.id);
}

export async function createProject(input) {
  const id = `mv-${randomUUID()}`;
  const now = new Date().toISOString();
  const project = buildProjectRecord(input, { id, now });
  const all = await loadAll();
  all.push(project);
  await saveAll(all);
  console.log(`🎞️ Created Music Video project: ${id} (${input.name})`);
  return project;
}

// Locate a live (non-tombstoned) project for a user-facing mutator, or throw 404.
async function loadAllAndIndex(id) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return { all, idx };
}

export async function updateProject(id, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = applyProjectPatch(all[idx], patch);
  await saveAll(all);
  return all[idx];
}

export async function deleteProject(id) {
  const { all, idx } = await loadAllAndIndex(id);
  const now = new Date().toISOString();
  all[idx] = { ...all[idx], deleted: true, deletedAt: now, updatedAt: now };
  await saveAll(all);
  return { ok: true };
}

/**
 * File-backend mirror of projectsDB.js `mergeProjectsFromSync` — LWW-per-id
 * (tombstone-aware) via the shared `mergeProjectRecord` decision so the two
 * backends can't drift. Single load → per-record merge → single save.
 */
export async function mergeProjectsFromSync(remoteProjects, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteProjects)) return { applied: false, count: 0 };
  const all = await loadAll();
  const byId = new Map(all.map((p) => [p.id, p]));
  let changed = 0;
  for (const remote of remoteProjects) {
    const local = byId.get(remote?.id) || null;
    const { next, inserted, remoteWins, changed: didChange } = mergeProjectRecord(local, remote);
    if (!next) continue;
    if (inserted) {
      byId.set(next.id, next);
      await setSyncBaseHash('musicVideoProject', next.id, contentHashForRecord('musicVideoProject', next));
      changed += 1;
      continue;
    }
    if (!remoteWins || !didChange) continue;
    await maybeJournalBeforeOverwrite({ kind: 'musicVideoProject', id: next.id, local, remote: next, source });
    byId.set(next.id, next);
    await setSyncBaseHash('musicVideoProject', next.id, contentHashForRecord('musicVideoProject', next));
    changed += 1;
  }
  if (changed > 0) await saveAll([...byId.values()]);
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/**
 * Hard-remove tombstoned projects whose deletedAt is older than the cutoff.
 * Mirrors projectsDB.js `pruneTombstonedProjects`; evicts each pruned project's
 * base hash.
 */
export async function pruneTombstonedProjects(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const all = await loadAll();
  const survivors = [];
  const pruned = [];
  for (const p of all) {
    const ms = p.deleted ? Date.parse(p.deletedAt || '') : NaN;
    if (p.deleted && Number.isFinite(ms) && ms < olderThanMs) pruned.push(p.id);
    else survivors.push(p);
  }
  if (pruned.length === 0) return { pruned: 0 };
  await saveAll(survivors);
  for (const id of pruned) await deleteSyncBaseHash('musicVideoProject', id);
  return { pruned: pruned.length };
}

export async function setProjectAnalysis(id, analysis) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = setAudioAnalysis(all[idx], analysis);
  await saveAll(all);
  return all[idx];
}

export async function addProjectScene(id, sceneInput) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, scene } = addScene(all[idx], sceneInput);
  all[idx] = project;
  await saveAll(all);
  return scene;
}

/**
 * Bulk-append scenes (the autonomous planner, #1855) — one load/save round
 * trip. Returns `{ project, scenes }` (the freshly-persisted project, not a
 * pre-mutation snapshot) so a caller composing a response never has to
 * re-fetch or risk overwriting a concurrent edit with stale state.
 */
export async function addProjectScenes(id, sceneInputs) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, scenes } = addScenes(all[idx], sceneInputs);
  all[idx] = project;
  await saveAll(all);
  return { project, scenes };
}

export async function updateScene(id, sceneId, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, updated } = applySceneUpdate(all[idx], sceneId, patch);
  all[idx] = project;
  await saveAll(all);
  return updated;
}

export async function deleteScene(id, sceneId) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = removeScene(all[idx], sceneId);
  await saveAll(all);
  return all[idx];
}

export async function reorderProjectScenes(id, orderedIds) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = reorderScenes(all[idx], orderedIds);
  await saveAll(all);
  return all[idx];
}
