/** Music Video PostgreSQL project store. */

import { randomUUID } from 'crypto';
import { withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createProjectDbStore } from '../projectDbStore.js';
import * as logic from './projectsLogic.js';

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
  persist, listProjects, getProject, getProjectsByIds, listProjectIds, createProject,
  updateProject, deleteProject, mergeProjectsFromSync, pruneTombstonedProjects,
} = store;

export async function cloneProject(id, options = {}) {
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

export async function setProjectAnalysis(id, analysis) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.setAudioAnalysis(current, analysis) }));
  return project;
}

export async function setProjectMidiTranscription(id, midi) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.setMidiTranscription(current, midi) }));
  return project;
}

export async function addProjectScene(id, sceneInput) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, scene } = logic.addScene(current, sceneInput);
    return { project, result: scene };
  });
  return result;
}

export async function addProjectScenes(id, sceneInputs) {
  const { project, result: scenes } = await withLockedProject(id, (current) => {
    const outcome = logic.addScenes(current, sceneInputs);
    return { project: outcome.project, result: outcome.scenes };
  });
  return { project, scenes };
}

export async function updateScene(id, sceneId, patch) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, updated } = logic.applySceneUpdate(current, sceneId, patch);
    return { project, result: updated };
  });
  return result;
}

export async function deleteScene(id, sceneId) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.removeScene(current, sceneId) }));
  return project;
}

export async function reorderProjectScenes(id, orderedIds) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.reorderScenes(current, orderedIds) }));
  return project;
}
