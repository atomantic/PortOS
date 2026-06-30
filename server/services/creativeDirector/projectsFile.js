/**
 * Creative Director — file-backed project store (escape-hatch / test backend).
 *
 * Persists to data/creative-director-projects.json (array, atomicWrite). This
 * is the ORIGINAL storage; as of Phase 3 (#997) PostgreSQL is the default and
 * this backend is reachable only via the MEMORY_BACKEND=file escape hatch or
 * NODE_ENV=test — same posture as the memory backend (see memoryBackend.js).
 * The dispatcher in local.js picks between this and projectsDB.js.
 *
 * All mutation semantics live in projectsLogic.js so this backend and the PG
 * backend can't drift; this module only does load/find/persist.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createCollection } from '../mediaCollections.js';
import {
  trimRuns,
  buildProjectRecord,
  applyProjectPatch,
  applyTreatment,
  applySceneUpdate,
  appendRun,
  applyRunUpdate,
  mergeProjectRecord,
} from './projectsLogic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
  withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';

const PROJECTS_FILE = join(PATHS.data, 'creative-director-projects.json');

async function loadAll() {
  const raw = await readJSONFile(PROJECTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

async function saveAll(projects) {
  // Defense for first-run on a fresh checkout where data/ may not exist yet.
  await ensureDir(PATHS.data);
  // Enforce the runs[] cap at the single write chokepoint so every mutator
  // shrinks legacy over-cap arrays on first save without each having to remember.
  for (const p of projects) {
    if (Array.isArray(p?.runs)) p.runs = trimRuns(p.runs);
  }
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
  const id = `cd-${randomUUID()}`;
  const now = new Date().toISOString();
  // Auto-create a media collection scoped to this project. All segment renders
  // + the final stitched output land in here.
  const collection = await createCollection({ name: `Creative Director: ${input.name}`, description: `Auto-created for project ${id}` });
  const project = buildProjectRecord(input, { id, now, collectionId: collection.id });
  const all = await loadAll();
  all.push(project);
  await saveAll(all);
  console.log(`🎬 Created Creative Director project: ${id} (${input.name})`);
  return project;
}

export async function updateProject(id, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  // Missing OR tombstoned (#1564 soft-delete) → gone for user-facing mutators, so a
  // post-delete write can't resurrect + re-push a modified tombstone.
  if (idx < 0 || all[idx].deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  all[idx] = applyProjectPatch(all[idx], patch);
  await saveAll(all);
  return all[idx];
}

export async function deleteProject(id) {
  // Soft-delete tombstone (#1564) — mirrors projectsDB.deleteProject so the two
  // backends can't drift. The record stays so the deletion can federate.
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
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
      await setSyncBaseHash('creativeDirectorProject', next.id, contentHashForRecord('creativeDirectorProject', next));
      changed += 1;
      continue;
    }
    if (!remoteWins || !didChange) continue;
    await maybeJournalBeforeOverwrite({ kind: 'creativeDirectorProject', id: next.id, local, remote: next, source });
    byId.set(next.id, next);
    await setSyncBaseHash('creativeDirectorProject', next.id, contentHashForRecord('creativeDirectorProject', next));
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
  // Coalesce the per-project base-hash evictions into ONE disk write.
  await withBaseHashFlushBatch(async () => {
    for (const id of pruned) await deleteSyncBaseHash('creativeDirectorProject', id);
  });
  return { pruned: pruned.length };
}

export async function setTreatment(id, treatmentInput) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  // Missing OR tombstoned (#1564 soft-delete) → gone for user-facing mutators, so a
  // post-delete write can't resurrect + re-push a modified tombstone.
  if (idx < 0 || all[idx].deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  all[idx] = applyTreatment(all[idx], treatmentInput);
  await saveAll(all);
  return all[idx];
}

export async function updateScene(id, sceneId, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  // Missing OR tombstoned (#1564 soft-delete) → gone for user-facing mutators, so a
  // post-delete write can't resurrect + re-push a modified tombstone.
  if (idx < 0 || all[idx].deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { project, updated } = applySceneUpdate(all[idx], sceneId, patch);
  all[idx] = project;
  await saveAll(all);
  return updated;
}

export async function recordRun(id, runEntry) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  // Missing OR tombstoned (#1564 soft-delete) → gone for user-facing mutators, so a
  // post-delete write can't resurrect + re-push a modified tombstone.
  if (idx < 0 || all[idx].deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { project, run } = appendRun(all[idx], runEntry);
  all[idx] = project;
  await saveAll(all);
  return run;
}

export async function updateRun(id, runId, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  // Missing OR tombstoned (#1564 soft-delete) → gone for user-facing mutators, so a
  // post-delete write can't resurrect + re-push a modified tombstone.
  if (idx < 0 || all[idx].deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { project, updated } = applyRunUpdate(all[idx], runId, patch);
  if (updated === null) return null;
  all[idx] = project;
  await saveAll(all);
  return updated;
}
