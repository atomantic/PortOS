/**
 * One media collection per Creative Commission job. Runs used to mint a dated
 * "Creative Director: <job> — YYYY-MM-DD" collection per fire; this folds every
 * such collection (found through the job's projects) and any stray collection
 * already carrying the job's collection name into the job's deterministic
 * collection, and points the job's projects at it. Idempotent: a second pass
 * finds nothing left to fold.
 */
import { listProjects, repointProjectCollections } from '../creativeDirector/local.js';
import { listCommissions } from './store.js';
import { findOrCreateCommissionCollection, isOwnerManaged, joinCollections, listCollections } from '../mediaCollections.js';

// The scheduler appends ` — YYYY-MM-DD` to each run's project name.
const RUN_DATE_SUFFIX = /\s+—\s+\d{4}-\d{2}-\d{2}$/;

const jobNameFromProject = (project) => String(project?.name ?? '').replace(RUN_DATE_SUFFIX, '').replace(/…$/, '').trim();

export async function consolidateCommissionCollections() {
  const [projects, commissions, collections] = await Promise.all([
    listProjects(), listCommissions(), listCollections(),
  ]);
  const commissionNames = new Map(commissions.map((c) => [c.id, c.name]));
  const liveCollectionIds = new Set(collections.map((c) => c.id));
  const byCommission = Map.groupBy(projects.filter((project) => project?.commissionId), (project) => project.commissionId);

  const result = { jobs: 0, mergedCollections: 0, repointedProjects: 0 };
  for (const [commissionId, jobProjects] of byCommission) {
    const newest = [...jobProjects].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const commissionName = commissionNames.get(commissionId) || jobNameFromProject(newest);
    const target = await findOrCreateCommissionCollection({ commissionId, commissionName });
    const needle = target.name.trim().toLowerCase();
    const strays = collections
      .filter((c) => !isOwnerManaged(c) && c.name.trim().toLowerCase() === needle)
      .map((c) => c.id);
    const sourceIds = [...new Set([...jobProjects.map((p) => p.collectionId), ...strays])]
      .filter((id) => id && id !== target.id && liveCollectionIds.has(id));
    if (sourceIds.length) {
      const joined = await joinCollections({ name: target.name, collectionIds: [target.id, ...sourceIds] });
      result.mergedCollections += joined.removedCollectionIds.length;
    }
    // The join re-pointed projects on the collections it retired; this covers
    // projects still on a deleted collection.
    const stale = jobProjects.map((p) => p.collectionId).filter((id) => id && id !== target.id && !sourceIds.includes(id));
    if (stale.length) result.repointedProjects += await repointProjectCollections(stale, target.id);
    result.jobs += 1;
  }
  return result;
}
