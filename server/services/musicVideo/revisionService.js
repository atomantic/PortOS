/**
 * Music Video — selective section revision I/O (#8987) over the pure
 * transforms in `revision.js`.
 *
 * The lifecycle is a resumable checkpoint, driven by explicit director actions
 * (never by boot — no paid generation is ever queued on its own):
 *
 *   start  → reject the flagged sections' selected takes, keep the rest;
 *   resume → re-derive every rejected section's state from the record and the
 *            media-job queue. Sections still without a take are returned as
 *            `needsGeneration` (the director's board generates exactly those,
 *            through the normal scene lanes); once every one holds a take, the
 *            draft window is re-rendered. A section that holds a take is never
 *            in `needsGeneration`, so retrying a failed/cancelled/interrupted
 *            render generates nothing;
 *   cancel → close the revision and stop its draft render if one is running.
 *
 * Every record write goes through `mutateProjectRecord`, so each transform runs
 * against the freshest record under the backend's write serialization.
 */

import { getProject, mutateProjectRecord } from './projects.js';
import { cancelExcerptRender, startExcerptRender } from './excerptRender.js';
import {
  cancelRevisionOnProject,
  claimRevisionGeneration,
  projectRevisions,
  revisionSectionStates,
  startRevisionOnProject,
} from './revision.js';

/** Open a revision from a reviewed excerpt. Returns `{ project, revision, skippedSceneIds }`. */
export async function startRevision(projectId, excerptId, input = {}) {
  return mutateProjectRecord(projectId, (current) => startRevisionOnProject(current, excerptId, input));
}

/**
 * Continue a revision from its checkpoint. Returns
 * `{ project, revision, needsGeneration, generating, render }` — `render` is the
 * draft re-render's `{ jobId, excerptId }` when every rejected section already
 * holds a take, otherwise null.
 */
export async function resumeRevision(projectId, revisionId) {
  // Deferred: the queue module's closure is large and only this path needs it.
  const { listJobs } = await import('../mediaJobQueue/index.js');
  const jobs = [...listJobs({ kind: 'video' }), ...listJobs({ kind: 'image' })];
  // Derive + claim under the record's write serialization, so two overlapping
  // resumes can never both hand the same section out for (paid) generation.
  const claim = await mutateProjectRecord(projectId, (current) => claimRevisionGeneration(current, revisionId, jobs));
  if (claim.needsGeneration.length || claim.generating.length) return { ...claim, render: null };
  // Every rejected section holds a take: re-render the draft window. The
  // excerpt render links itself to the revision in its creation write (and
  // refuses one that closed or is already rendering meanwhile).
  const render = await startExcerptRender(projectId, { startSec: claim.revision.startSec, endSec: claim.revision.endSec }, { revisionId });
  const fresh = await getProject(projectId);
  const current = projectRevisions(fresh).find((r) => r.id === revisionId) || claim.revision;
  return { project: fresh, revision: { ...current, sections: revisionSectionStates(fresh, current, jobs) }, needsGeneration: [], generating: [], render };
}

/** Cancel a revision; a draft render it started is cancelled too. Returns `{ project, revision }`. */
export async function cancelRevision(projectId, revisionId) {
  const { project, revision, renderExcerptId } = await mutateProjectRecord(projectId, (current) => cancelRevisionOnProject(current, revisionId));
  if (renderExcerptId) cancelExcerptRender(renderExcerptId);
  return { project, revision };
}
