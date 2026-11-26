/** Music Video file-backed project store (test/development escape hatch). */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createProjectFileStore } from '../projectFileStore.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import * as logic from './projectsLogic.js';

const store = createProjectFileStore({
  file: join(PATHS.data, 'music-video-projects.json'),
  kind: 'musicVideoProject',
  idPrefix: 'mv',
  logEmoji: '🎞️',
  logLabel: 'Music Video',
  logic,
});

export const {
  loadAll, saveAll, loadAllAndIndex, listProjects, listProjectPage, getProject, getProjectsByIds, listProjectIds, listProjectNames,
} = store;

export async function listProjectVersionPage(rootId, { limit, offset }) {
  const family = (await store.loadStoredProjects())
    .filter(project => !project.deleted && (project.rootProjectId || project.id) === rootId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.id.localeCompare(b.id));
  const items = family.slice(offset, offset + limit)
    .map(({ id, name, version }) => ({ id, name, version: version || 1, rootProjectId: rootId }));
  return { items, total: family.length, limit, offset };
}

export async function listMidiSourceRows() {
  return (await store.loadStoredProjects())
    .filter(project => !project.deleted && project.trackId !== undefined && project.midiTranscription?.filename !== undefined)
    .map(({ id, name, trackId, midiTranscription }) => ({
      id, name, trackId,
      midiTranscription: {
        filename: midiTranscription.filename,
        model: midiTranscription.model,
        createdAt: midiTranscription.createdAt,
      },
    }));
}

export async function listCompletionCandidateIds(ingredientIds) {
  const wanted = ingredientIds && new Set(ingredientIds);
  return (await listProjects()).filter((project) => {
    if (project.status !== 'complete' || !(project.renderHistoryId && project.renderDependencies) && project.composition?.mode !== 'blender') return false;
    return !wanted || (project.castAndSets?.source === 'catalog'
      && Array.isArray(project.renderDependencies?.references)
      && project.renderDependencies.references.some(({ role }) => role === 'clipReferences')
      && project.concept?.subjects?.some(({ ingredientId }) => wanted.has(ingredientId)));
  }).map(({ id }) => id);
}

// Every mutator below is a load → modify → save of the ONE projects file, so
// they all share a single write tail: a render-completion hook appending a take
// can't interleave with a director's select/reject (or any other edit) and
// persist a stale pre-image over it. The PG backend gets the same guarantee
// from its row lock (projectsDB.js withLockedProject).
const queueWrite = createFileWriteQueue();
const serialized = (fn) => (...args) => queueWrite(() => fn(...args));

export const createProject = serialized(store.createProject);
export const updateProject = serialized(store.updateProject);
export const deleteProject = serialized(store.deleteProject);
export const mergeProjectsFromSync = serialized(store.mergeProjectsFromSync);
export const pruneTombstonedProjects = serialized(store.pruneTombstonedProjects);

async function cloneProjectUnqueued(id, options = {}) {
  const all = await loadAll();
  const source = all.find((project) => project.id === id && !project.deleted);
  if (!source) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const clone = logic.cloneProjectRecord(source, {
    ...options,
    // The service names the id when it already placed files under it (a Blender film's scripts).
    id: options.id || `mv-${randomUUID()}`,
    now: new Date().toISOString(),
  });
  all.push(clone);
  await saveAll(all);
  return clone;
}

async function setProjectAnalysisUnqueued(id, analysis, sourceProject) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.setAudioAnalysis(all[idx], analysis, sourceProject);
  await saveAll(all);
  return all[idx];
}

async function mutateProject(id, transform) {
  const { all, idx } = await loadAllAndIndex(id);
  const outcome = await transform(all[idx]);
  if (outcome.skipPersist) return outcome;
  all[idx] = outcome.project;
  await saveAll(all);
  return outcome;
}

export const cloneProject = serialized(cloneProjectUnqueued);
export const setProjectAnalysis = serialized(setProjectAnalysisUnqueued);
// Generic pure-transform mutation (#8980 treatment ops): `transform(project)`
// returns `{ project, ...result }`; resolves to that outcome.
export const mutateProjectRecord = serialized(mutateProject);

/** Hold the same file tail as every writer; cleanup uses the unqueued mutation. */
export function withProjectMutation(work) {
  return queueWrite(() => work({ mutateProjectRecord: mutateProject }));
}
