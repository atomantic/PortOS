/** Creative Director file-backed project store (test/development escape hatch). */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollection } from '../mediaCollections.js';
import { createProjectFileStore } from '../projectFileStore.js';
import * as logic from './projectsLogic.js';

const store = createProjectFileStore({
  file: join(PATHS.data, 'creative-director-projects.json'),
  kind: 'creativeDirectorProject',
  idPrefix: 'cd',
  logEmoji: '🎬',
  logLabel: 'Creative Director',
  logic,
});

export const {
  loadAll, saveAll, loadAllAndIndex, listProjects, getProject,
  getProjectsByIds, listProjectIds, updateProject, deleteProject,
  mergeProjectsFromSync, pruneTombstonedProjects,
} = store;

export async function listProjectsByCommissionId(commissionId) {
  if (!commissionId) return [];
  const all = await loadAll();
  return all.filter((project) => !project.deleted && project.commissionId === commissionId);
}

export async function createProject(input) {
  return store.createProject(input, async ({ id }) => {
    const collection = await createCollection({
      name: `Creative Director: ${input.name}`,
      description: `Auto-created for project ${id}`,
      source: 'auto',
    });
    return { collectionId: collection.id };
  });
}

export async function setTreatment(id, treatmentInput) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.applyTreatment(all[idx], treatmentInput);
  await saveAll(all);
  return all[idx];
}

export async function setPlan(id, planInput) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = logic.applyPlan(all[idx], planInput);
  await saveAll(all);
  return all[idx];
}

export async function updatePlanStep(id, stepId, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, updated } = logic.applyPlanStepUpdate(all[idx], stepId, patch);
  all[idx] = project;
  await saveAll(all);
  return updated;
}

export async function updateScene(id, sceneId, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, updated } = logic.applySceneUpdate(all[idx], sceneId, patch);
  all[idx] = project;
  await saveAll(all);
  return updated;
}

export async function recordRun(id, runEntry) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, run } = logic.appendRun(all[idx], runEntry);
  all[idx] = project;
  await saveAll(all);
  return run;
}

export async function updateRun(id, runId, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, updated } = logic.applyRunUpdate(all[idx], runId, patch);
  if (updated === null) return null;
  all[idx] = project;
  await saveAll(all);
  return updated;
}
