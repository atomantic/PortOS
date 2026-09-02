import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { readJSONFile, atomicWrite, ensureDir } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { makeSyncKind } from '../lib/projectStoreKit.js';
import {
  maybeJournalBeforeOverwrite,
  setSyncBaseHash,
  contentHashForRecord,
  flushBaseHashes,
  deleteSyncBaseHash,
  withBaseHashFlushBatch,
} from '../lib/conflictJournal.js';

export function createProjectFileStore({ file, kind, idPrefix, logEmoji, logLabel, logic }) {
  const sync = makeSyncKind(kind);

  async function loadAll() {
    const raw = await readJSONFile(file, []);
    return Array.isArray(raw) ? raw : [];
  }

  async function saveAll(projects) {
    await ensureDir(dirname(file));
    const prepared = logic.beforeSave ? projects.map((project) => logic.beforeSave(project)) : projects;
    await atomicWrite(file, prepared);
    return prepared;
  }

  async function loadAllAndIndex(id) {
    const all = await loadAll();
    const idx = all.findIndex((project) => project.id === id);
    if (idx < 0 || all[idx].deleted) {
      throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
    }
    return { all, idx };
  }

  async function listProjects({ includeDeleted = false } = {}) {
    const all = await loadAll();
    return includeDeleted ? all : all.filter((project) => !project.deleted);
  }

  async function getProject(id, { includeDeleted = false } = {}) {
    const all = await loadAll();
    const found = all.find((project) => project.id === id);
    if (!found) return null;
    return includeDeleted || !found.deleted ? found : null;
  }

  async function getProjectsByIds(ids, { includeDeleted = false } = {}) {
    const wanted = new Set((ids || []).filter(Boolean));
    if (wanted.size === 0) return [];
    const all = await loadAll();
    return all.filter((project) => wanted.has(project.id) && (includeDeleted || !project.deleted));
  }

  async function listProjectIds({ includeDeleted = false } = {}) {
    const all = await loadAll();
    return (includeDeleted ? all : all.filter((project) => !project.deleted)).map((project) => project.id);
  }

  async function createProject(input, buildOptions = {}) {
    const id = `${idPrefix}-${randomUUID()}`;
    const extra = typeof buildOptions === 'function'
      ? await buildOptions({ id, input })
      : buildOptions;
    const project = logic.buildProjectRecord(input, { id, now: new Date().toISOString(), ...extra });
    const all = await loadAll();
    all.push(project);
    const persisted = await saveAll(all);
    console.log(`${logEmoji} Created ${logLabel} project: ${id} (${input.name})`);
    return persisted[persisted.length - 1];
  }

  async function updateProject(id, patch) {
    const { all, idx } = await loadAllAndIndex(id);
    all[idx] = logic.applyProjectPatch(all[idx], patch);
    const persisted = await saveAll(all);
    return persisted[idx];
  }

  async function deleteProject(id) {
    const { all, idx } = await loadAllAndIndex(id);
    const now = new Date().toISOString();
    all[idx] = { ...all[idx], deleted: true, deletedAt: now, updatedAt: now };
    await saveAll(all);
    return { ok: true };
  }

  async function mergeProjectsFromSync(remoteProjects, { source = { via: 'sync', peerId: null } } = {}) {
    if (!Array.isArray(remoteProjects)) return { applied: false, count: 0 };
    const all = await loadAll();
    const { byId, changes } = sync.applySyncMerge({
      byId: new Map(all.map((project) => [project.id, project])),
      remoteProjects,
      source,
      mergeProjectRecord: logic.mergeProjectRecord,
    });
    for (const change of changes) {
      if (!change.inserted) await maybeJournalBeforeOverwrite(change);
      await setSyncBaseHash(kind, change.id, contentHashForRecord(kind, change.remote));
    }
    if (changes.length > 0) await saveAll([...byId.values()]);
    await flushBaseHashes();
    return { applied: changes.length > 0, count: changes.length };
  }

  async function pruneTombstonedProjects(olderThanMs) {
    const all = await loadAll();
    const { survivors, prunedIds } = sync.selectExpiredTombstones(all, olderThanMs);
    if (prunedIds.length === 0) return { pruned: 0 };
    await saveAll(survivors);
    await withBaseHashFlushBatch(async () => {
      for (const id of prunedIds) await deleteSyncBaseHash(kind, id);
    });
    return { pruned: prunedIds.length };
  }

  return {
    loadAll,
    saveAll,
    loadAllAndIndex,
    listProjects,
    getProject,
    getProjectsByIds,
    listProjectIds,
    createProject,
    updateProject,
    deleteProject,
    mergeProjectsFromSync,
    pruneTombstonedProjects,
  };
}
