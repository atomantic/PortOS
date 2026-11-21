/**
 * One media collection per Creative Commission job. Runs used to mint a dated
 * "Creative Director: <job> — YYYY-MM-DD" collection per fire; this folds every
 * such collection (found through the job's projects) and any stray collection
 * carrying the job's collection name, dated or not, into the job's deterministic
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

  const result = { jobs: 0, mergedCollections: 0, repointedProjects: 0, failedJobs: 0 };
  for (const [commissionId, jobProjects] of byCommission) {
    try {
      await consolidateJob(commissionId, jobProjects, { projects, commissionNames, collections, liveCollectionIds, result });
      result.jobs += 1;
    } catch (error) {
      // One job's failure (a union over the item cap, a vanished collection)
      // must not stop the other jobs or the organize pass that runs this.
      result.failedJobs += 1;
      console.error(`❌ Commission collection consolidation for ${commissionId} failed: ${error.message}`);
    }
  }
  return result;
}

async function consolidateJob(commissionId, jobProjects, { projects, commissionNames, collections, liveCollectionIds, result }) {
  const newest = [...jobProjects].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const commissionName = commissionNames.get(commissionId) || jobNameFromProject(newest);
  const target = await findOrCreateCommissionCollection({ commissionId, commissionName });
  const needle = target.name.trim().toLowerCase();
  // A same-named collection that another project files into is that
  // project's, not this job's. A dated run collection whose project was
  // deleted is reachable only by its name, so the date suffix is ignored.
  const jobIds = new Set(jobProjects.map((p) => p.id));
  const ownedElsewhere = new Set(projects.filter((p) => !jobIds.has(p.id)).map((p) => p.collectionId));
  const strays = collections
    .filter((c) => !isOwnerManaged(c) && !ownedElsewhere.has(c.id) && c.name.replace(RUN_DATE_SUFFIX, '').trim().toLowerCase() === needle)
    .map((c) => c.id);
  const sourceIds = [...new Set([...jobProjects.map((p) => p.collectionId), ...strays])]
    .filter((id) => id && id !== target.id && liveCollectionIds.has(id));
  if (sourceIds.length) {
    const joined = await joinCollections({ name: target.name, collectionIds: [target.id, ...sourceIds] });
    result.mergedCollections += joined.removedCollectionIds.length;
    for (const id of joined.removedCollectionIds) liveCollectionIds.delete(id);
  }
  // The join re-pointed projects on the collections it retired; this covers
  // projects still on a deleted collection.
  const stale = jobProjects.map((p) => p.collectionId).filter((id) => id && id !== target.id && !sourceIds.includes(id));
  if (stale.length) result.repointedProjects += await repointProjectCollections(stale, target.id);
}
