/** Creative Director PostgreSQL project store. */

import { query } from '../../lib/db.js';
import { createCollection } from '../mediaCollections.js';
import { createProjectDbStore } from '../projectDbStore.js';
import * as logic from './projectsLogic.js';

const store = createProjectDbStore({
  table: 'creative_director_projects',
  kind: 'creativeDirectorProject',
  idPrefix: 'cd',
  logEmoji: '🎬',
  logLabel: 'Creative Director',
  logic,
});

const { withLockedProject, rowToProject } = store;

export const {
  persist, listProjects, getProject, getProjectsByIds, listProjectIds,
  updateProject, deleteProject, mergeProjectsFromSync, pruneTombstonedProjects,
} = store;

export async function listProjectsByCommissionId(commissionId) {
  if (!commissionId) return [];
  const result = await query(
    `SELECT id, data FROM creative_director_projects
     WHERE deleted = FALSE AND data->>'commissionId' = $1 ORDER BY created_at ASC`,
    [commissionId],
  );
  return result.rows.map(rowToProject);
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
  const { project } = await withLockedProject(id, (current) => ({ project: logic.applyTreatment(current, treatmentInput) }));
  return project;
}

export async function setPlan(id, planInput) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.applyPlan(current, planInput) }));
  return project;
}

export async function updatePlanStep(id, stepId, patch) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, updated } = logic.applyPlanStepUpdate(current, stepId, patch);
    return { project, result: updated };
  });
  return result;
}

export async function updateScene(id, sceneId, patch) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, updated } = logic.applySceneUpdate(current, sceneId, patch);
    return { project, result: updated };
  });
  return result;
}

export async function recordRun(id, runEntry) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, run } = logic.appendRun(current, runEntry);
    return { project, result: run };
  });
  return result;
}

export async function updateRun(id, runId, patch) {
  const outcome = await withLockedProject(id, (current) => {
    const { project, updated } = logic.applyRunUpdate(current, runId, patch);
    return { project, result: updated, skipPersist: updated === null };
  }, { allowMissing: true });
  return outcome.__missing ? null : outcome.result;
}
