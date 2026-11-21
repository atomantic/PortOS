/**
 * Creative Director PostgreSQL project store.
 *
 * Storage: `db-primary` (`creative_director_projects` JSONB) — federated through
 * the version-gated `creativeDirectorProjects` sync category. Video workspace
 * drafts (`workspace: 'video'`) add optional fields to the same record (draft,
 * treatment script/artifact/history, planning context, reviews, cuts) rather than
 * a new store, so legacy records keep prior behavior with no backfill; each
 * semantic step bumps the sync version so older peers cannot discard or bypass
 * it. Synced Video copies are read-only replicas of `videoOwnerInstanceId`;
 * `videoExecution` receipts and the replica flag are machine-local and never
 * ride the wire. Rendered media stays in its existing asset stores.
 */

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
  const seeded = { ...input };
  if (input.workspace === 'video') {
    const { ensureInstanceId } = await import('../instanceIdentity.js');
    seeded.videoOwnerInstanceId = await ensureInstanceId();
  }
  return store.createProject(seeded, async ({ id }) => {
    // A Creative Commission run files into its job's shared collection.
    if (typeof input.collectionId === 'string' && input.collectionId) return { collectionId: input.collectionId };
    const collection = await createCollection({
      name: `Creative Director: ${input.name}`,
      description: `Auto-created for project ${id}`,
      source: 'auto',
    });
    return { collectionId: collection.id };
  });
}

export async function setTreatment(id, treatmentInput) {
  const { assertVideoSourcesAvailable } = await import('./videoSources.js');
  const { project } = await withLockedProject(id, async (current) => {
    const sourceRevisions = await assertVideoSourcesAvailable(current);
    return { project: logic.applyTreatment(current, treatmentInput, sourceRevisions) };
  });
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

export async function mutateVideoProject(id, mutate) {
  return withLockedProject(id, mutate);
}
