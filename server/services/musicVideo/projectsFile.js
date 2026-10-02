/** Music Video file-backed project store (test/development escape hatch). */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createProjectFileStore } from '../projectFileStore.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import * as logic from './projectsLogic.js';
import * as takes from './takes.js';

const store = createProjectFileStore({
  file: join(PATHS.data, 'music-video-projects.json'),
  kind: 'musicVideoProject',
  idPrefix: 'mv',
  logEmoji: '🎞️',
  logLabel: 'Music Video',
  logic,
});

export const {
  loadAll, saveAll, loadAllAndIndex, listProjects, getProject, getProjectsByIds, listProjectIds,
} = store;

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
    id: `mv-${randomUUID()}`,
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

async function setProjectMidiTranscriptionUnqueued(id, midi) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.setMidiTranscription(all[idx], midi);
  await saveAll(all);
  return all[idx];
}

async function addProjectSceneUnqueued(id, sceneInput) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, scene } = logic.addScene(all[idx], sceneInput);
  all[idx] = project;
  await saveAll(all);
  return scene;
}

async function addProjectScenesUnqueued(id, sceneInputs) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, scenes } = logic.addScenes(all[idx], sceneInputs);
  all[idx] = project;
  await saveAll(all);
  return { project, scenes };
}

async function updateSceneUnqueued(id, sceneId, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, updated } = logic.applySceneUpdate(all[idx], sceneId, patch);
  all[idx] = project;
  await saveAll(all);
  return updated;
}

async function deleteSceneUnqueued(id, sceneId) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.removeScene(all[idx], sceneId);
  await saveAll(all);
  return all[idx];
}

async function reorderProjectScenesUnqueued(id, orderedIds) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.reorderScenes(all[idx], orderedIds);
  await saveAll(all);
  return all[idx];
}

// ---- scene takes (#8965) — one load/modify/save per take operation ----------
async function mutateProject(id, transform) {
  const { all, idx } = await loadAllAndIndex(id);
  const outcome = transform(all[idx]);
  all[idx] = outcome.project;
  await saveAll(all);
  return outcome;
}

async function appendSceneTakesUnqueued(id, sceneId, inputs) {
  const { scene, appended } = await mutateProject(id, (p) => takes.appendSceneTakes(p, sceneId, inputs));
  return { scene, appended };
}

async function appendTakesAcrossScenesUnqueued(id, items) {
  return mutateProject(id, (p) => takes.appendTakesAcrossScenes(p, items));
}

async function selectSceneTakeUnqueued(id, sceneId, takeId) {
  const { scene } = await mutateProject(id, (p) => takes.selectSceneTake(p, sceneId, takeId));
  return scene;
}

async function reviewSceneTakeUnqueued(id, sceneId, takeId, review) {
  const { scene } = await mutateProject(id, (p) => takes.reviewSceneTake(p, sceneId, takeId, review));
  return scene;
}

export const cloneProject = serialized(cloneProjectUnqueued);
export const setProjectAnalysis = serialized(setProjectAnalysisUnqueued);
export const setProjectMidiTranscription = serialized(setProjectMidiTranscriptionUnqueued);
export const addProjectScene = serialized(addProjectSceneUnqueued);
export const addProjectScenes = serialized(addProjectScenesUnqueued);
export const updateScene = serialized(updateSceneUnqueued);
export const deleteScene = serialized(deleteSceneUnqueued);
export const reorderProjectScenes = serialized(reorderProjectScenesUnqueued);
export const appendSceneTakes = serialized(appendSceneTakesUnqueued);
export const appendTakesAcrossScenes = serialized(appendTakesAcrossScenesUnqueued);
export const selectSceneTake = serialized(selectSceneTakeUnqueued);
export const reviewSceneTake = serialized(reviewSceneTakeUnqueued);
// Generic pure-transform mutation (#8980 treatment ops): `transform(project)`
// returns `{ project, ...result }`; resolves to that outcome.
export const mutateProjectRecord = serialized(mutateProject);
