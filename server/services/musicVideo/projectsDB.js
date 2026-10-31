/** Music Video PostgreSQL project store. */

import { randomUUID } from 'crypto';
import { withTransaction } from '../../lib/db.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createProjectDbStore } from '../projectDbStore.js';
import * as logic from './projectsLogic.js';
import * as takes from './takes.js';

const store = createProjectDbStore({
  table: 'music_video_projects',
  kind: 'musicVideoProject',
  idPrefix: 'mv',
  logEmoji: '🎞️',
  logLabel: 'Music Video',
  logic,
});

const { withLockedProject, rowToProject } = store;

export const {
  persist, listProjects, listProjectPage, getProject, getProjectsByIds, listProjectIds, listProjectNames,
} = store;

async function cloneProjectUnqueued(id, options = {}) {
  return withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT id, data FROM music_video_projects WHERE id = $1 FOR SHARE`,
      [id],
    );
    const source = rowToProject(selected.rows[0]);
    if (!source || source.deleted) {
      throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
    }
    const clone = logic.cloneProjectRecord(source, {
      ...options,
      id: `mv-${randomUUID()}`,
      now: new Date().toISOString(),
    });
    await persist(client.query.bind(client), clone);
    return clone;
  });
}

async function setProjectAnalysisUnqueued(id, analysis, sourceProject) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.setAudioAnalysis(current, analysis, sourceProject) }));
  return project;
}

async function setProjectMidiTranscriptionUnqueued(id, midi) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.setMidiTranscription(current, midi) }));
  return project;
}

async function addProjectSceneUnqueued(id, sceneInput) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, scene } = logic.addScene(current, sceneInput);
    return { project, result: scene };
  });
  return result;
}

async function addProjectScenesUnqueued(id, sceneInputs) {
  const { project, result: scenes } = await withLockedProject(id, (current) => {
    const outcome = logic.addScenes(current, sceneInputs);
    return { project: outcome.project, result: outcome.scenes };
  });
  return { project, scenes };
}

async function updateSceneUnqueued(id, sceneId, patch) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, updated } = logic.applySceneUpdate(current, sceneId, patch);
    return { project, result: updated };
  });
  return result;
}

async function deleteSceneUnqueued(id, sceneId) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.removeScene(current, sceneId) }));
  return project;
}

async function reorderProjectScenesUnqueued(id, orderedIds) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.reorderScenes(current, orderedIds) }));
  return project;
}

// ---- scene takes (#8965) — each operation runs under the project row lock,
// so a job completion and a director's select/reject can't interleave. -------
async function mutateLocked(id, transform) {
  const { result } = await withLockedProject(id, async (current) => {
    const outcome = await transform(current);
    return { project: outcome.project, result: outcome };
  });
  return result;
}

// Generic pure-transform mutation under the row lock (#8980 treatment ops):
// `transform(project)` returns `{ project, ...result }`; resolves to that
// outcome with `project` replaced by the persisted record.
async function mutateProjectRecordUnqueued(id, transform) {
  const { project, result } = await withLockedProject(id, async (current) => {
    const outcome = await transform(current);
    return { project: outcome.project, result: outcome, skipPersist: outcome.skipPersist === true };
  });
  return { ...result, project };
}

async function appendSceneTakesUnqueued(id, sceneId, inputs) {
  const { scene, appended } = await mutateLocked(id, (p) => takes.appendSceneTakes(p, sceneId, inputs));
  return { scene, appended };
}

async function appendTakesAcrossScenesUnqueued(id, items) {
  return mutateLocked(id, (p) => takes.appendTakesAcrossScenes(p, items));
}

async function selectSceneTakeUnqueued(id, sceneId, takeId) {
  const { scene } = await mutateLocked(id, (p) => takes.selectSceneTake(p, sceneId, takeId));
  return scene;
}

async function reviewSceneTakeUnqueued(id, sceneId, takeId, review) {
  const { scene } = await mutateLocked(id, (p) => takes.reviewSceneTake(p, sceneId, takeId, review));
  return scene;
}

// One same-install admission precedes row locks, including inserts and sync.
// Pool deletion needs a stable all-project selection scan through file removal.
// Row locks still protect the persisted read/modify/write transaction.
const queueWrite = createFileWriteQueue();
const serialized = (fn) => (...args) => queueWrite(() => fn(...args));
export const createProject = serialized(store.createProject);
export const updateProject = serialized(store.updateProject);
export const deleteProject = serialized(store.deleteProject);
export const mergeProjectsFromSync = serialized(store.mergeProjectsFromSync);
export const pruneTombstonedProjects = serialized(store.pruneTombstonedProjects);
export const cloneProject = serialized(cloneProjectUnqueued);
export const setProjectAnalysis = serialized(setProjectAnalysisUnqueued);
export const setProjectMidiTranscription = serialized(setProjectMidiTranscriptionUnqueued);
export const addProjectScene = serialized(addProjectSceneUnqueued);
export const addProjectScenes = serialized(addProjectScenesUnqueued);
export const updateScene = serialized(updateSceneUnqueued);
export const deleteScene = serialized(deleteSceneUnqueued);
export const reorderProjectScenes = serialized(reorderProjectScenesUnqueued);
export const mutateProjectRecord = serialized(mutateProjectRecordUnqueued);
export const appendSceneTakes = serialized(appendSceneTakesUnqueued);
export const appendTakesAcrossScenes = serialized(appendTakesAcrossScenesUnqueued);
export const selectSceneTake = serialized(selectSceneTakeUnqueued);
export const reviewSceneTake = serialized(reviewSceneTakeUnqueued);

export function withProjectMutation(work) {
  return queueWrite(() => work({ mutateProjectRecord: mutateProjectRecordUnqueued }));
}
