/**
 * One media collection per Creative Commission job. Runs used to mint a dated
 * "Creative Director: <job> — YYYY-MM-DD" collection per fire; this folds every
 * such collection (found through the job's projects) and any stray collection
 * already carrying the job's collection name into the job's deterministic
 * collection, and points the job's projects at it. Idempotent: a second pass
 * finds nothing left to fold.
 */
import { listProjects, updateProject } from '../creativeDirector/local.js';
import { listCommissions } from './store.js';
import { findOrCreateCommissionCollection, joinCollections, listCollections } from '../mediaCollections.js';

// The scheduler appends ` — YYYY-MM-DD` to each run's project name.
const RUN_DATE_SUFFIX = /\s+—\s+\d{4}-\d{2}-\d{2}$/;
const RANDOM_COLLECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const jobNameFromProject = (project) => String(project?.name ?? '').replace(RUN_DATE_SUFFIX, '').replace(/…$/, '').trim();

export async function consolidateCommissionCollections() {
  const [projects, commissions, collections] = await Promise.all([
    listProjects(), listCommissions(), listCollections(),
  ]);
  const commissionNames = new Map(commissions.map((c) => [c.id, c.name]));
  const liveCollectionIds = new Set(collections.map((c) => c.id));
  const byCommission = new Map();
  for (const project of projects) {
    if (!project?.commissionId) continue;
    if (!byCommission.has(project.commissionId)) byCommission.set(project.commissionId, []);
    byCommission.get(project.commissionId).push(project);
  }

  const result = { jobs: 0, mergedCollections: 0, repointedProjects: 0 };
  for (const [commissionId, jobProjects] of byCommission) {
    const newest = [...jobProjects].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const commissionName = commissionNames.get(commissionId) || jobNameFromProject(newest);
    const target = await findOrCreateCommissionCollection({ commissionId, commissionName });
    const needle = target.name.trim().toLowerCase();
    const strays = collections
      .filter((c) => RANDOM_COLLECTION_ID.test(c.id) && c.name.trim().toLowerCase() === needle)
      .map((c) => c.id);
    const sourceIds = [...new Set([...jobProjects.map((p) => p.collectionId), ...strays])]
      .filter((id) => id && id !== target.id && liveCollectionIds.has(id));
    const retired = new Set();
    if (sourceIds.length) {
      const joined = await joinCollections({ name: target.name, collectionIds: [target.id, ...sourceIds] });
      for (const id of joined.removedCollectionIds) retired.add(id);
      result.mergedCollections += retired.size;
    }
    // The join already re-pointed projects on the collections it retired; this
    // covers projects left on a deleted collection.
    for (const project of jobProjects) {
      if (project.collectionId === target.id || retired.has(project.collectionId)) continue;
      await updateProject(project.id, { collectionId: target.id });
      result.repointedProjects += 1;
    }
    result.jobs += 1;
  }
  return result;
}
