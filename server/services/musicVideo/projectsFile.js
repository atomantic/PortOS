/** Music Video file-backed project store (test/development escape hatch). */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createProjectFileStore } from '../projectFileStore.js';
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
  loadAll, saveAll, loadAllAndIndex, listProjects, getProject, getProjectsByIds,
  listProjectIds, createProject, updateProject, deleteProject, mergeProjectsFromSync,
  pruneTombstonedProjects,
} = store;

export async function cloneProject(id, options = {}) {
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

export async function setProjectAnalysis(id, analysis) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.setAudioAnalysis(all[idx], analysis);
  await saveAll(all);
  return all[idx];
}

export async function setProjectMidiTranscription(id, midi) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.setMidiTranscription(all[idx], midi);
  await saveAll(all);
  return all[idx];
}

export async function addProjectScene(id, sceneInput) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, scene } = logic.addScene(all[idx], sceneInput);
  all[idx] = project;
  await saveAll(all);
  return scene;
}

export async function addProjectScenes(id, sceneInputs) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, scenes } = logic.addScenes(all[idx], sceneInputs);
  all[idx] = project;
  await saveAll(all);
  return { project, scenes };
}

export async function updateScene(id, sceneId, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, updated } = logic.applySceneUpdate(all[idx], sceneId, patch);
  all[idx] = project;
  await saveAll(all);
  return updated;
}

export async function deleteScene(id, sceneId) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.removeScene(all[idx], sceneId);
  await saveAll(all);
  return all[idx];
}

export async function reorderProjectScenes(id, orderedIds) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.reorderScenes(all[idx], orderedIds);
  await saveAll(all);
  return all[idx];
}
