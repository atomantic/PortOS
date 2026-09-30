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

import { ServerError } from '../../lib/errorHandler.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { cancelExcerptRender, startExcerptRender } from './excerptRender.js';
import {
  assertRevisionOpenForGeneration,
  cancelRevisionOnProject,
  claimRevisionGeneration,
  projectRevisions,
  releaseRevisionClaim,
  revisionGenerationJobs,
  revisionSectionStates,
  startRevisionOnProject,
} from './revision.js';
import { chargeAutoReviewGeneration, refundAutoReviewGeneration, runOwningRevision } from './autoReview.js';

/** Open a revision from a reviewed excerpt. Returns `{ project, revision, skippedSceneIds }`. */
export async function startRevision(projectId, excerptId, input = {}) {
  return mutateProjectRecord(projectId, (current) => startRevisionOnProject(current, excerptId, input));
}

/**
 * Enqueue-time guard (#9011): a video/image request tagged with a revision
 * refuses BEFORE the job reaches the queue when that revision is no longer
 * open — the generation route calls this ahead of `enqueueJob` so a closed
 * revision's cancel/kickoff race is closed server-side rather than raced.
 * Throws 404/409 (ServerError, code REVISION_CLOSED); a no-op when the tag
 * carries no revisionId.
 *
 * #8988: this is also the spend choke point of an opt-in auto-review run. A
 * job for a revision a RUNNING run opened is charged against the run's
 * `maxGenerations` in one serialized write, and refused (409
 * AUTO_REVIEW_SPEND_LIMIT) once the limit is spent — before it is queued. A
 * second job for a section whose job for this revision is still queued or
 * running (a double submit) is refused too, so it is never paid for twice.
 */
export async function assertRevisionOpen(projectId, revisionId, { sceneId = null, kind = null } = {}) {
  if (!revisionId) return;
  const project = await getProject(projectId);
  assertRevisionOpenForGeneration(project, revisionId, { sceneId, kind });
  if (!project || !runOwningRevision(project, revisionId)) return;
  const { listJobs } = await import('../mediaJobQueue/index.js');
  const jobs = [...listJobs({ kind: 'video' }), ...listJobs({ kind: 'image' })];
  await mutateProjectRecord(projectId, (current) => {
    const revision = assertRevisionOpenForGeneration(current, revisionId, { sceneId, kind });
    const inFlight = sceneId && revisionGenerationJobs(current, revision, jobs)
      .some((job) => job.params?.musicVideo?.sceneId === sceneId && (!kind || job.kind === kind));
    if (inFlight) {
      throw new ServerError('This section is already generating for the auto-review run', { status: 409, code: 'AUTO_REVIEW_SECTION_IN_FLIGHT', context: { sceneId } });
    }
    return chargeAutoReviewGeneration(current, revisionId, { sceneId, kind, jobs });
  });
}

/**
 * Clear a claimed section's `claimedAt` after its generation kickoff failed to
 * reach the queue, so the very next resume hands it out again immediately
 * instead of waiting out the claim lease. Returns `{ project, revision }`.
 */
export async function releaseRevisionSection(projectId, revisionId, sceneId) {
  // #8988: a kickoff that never reached the queue also returns its charge to
  // the owning auto-review run's spend budget (never one whose job did).
  const { listJobs } = await import('../mediaJobQueue/index.js');
  const jobs = [...listJobs({ kind: 'video' }), ...listJobs({ kind: 'image' })];
  return mutateProjectRecord(projectId, (current) => {
    const released = releaseRevisionClaim(current, revisionId, sceneId);
    return { ...released, project: refundAutoReviewGeneration(released.project, revisionId, sceneId, jobs).project };
  });
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

/**
 * Cancel a revision. Its draft render and any generation job it started that
 * is still queued/running are cancelled too, so a closed revision incurs no
 * further paid work. Returns `{ project, revision, canceledJobIds }`.
 * `alsoOnProject` (#8988) applies a further transform in the SAME write — an
 * auto-review run cancels itself with its revision, so no window exists in
 * which the revision is open but its run no longer guards its spend.
 */
export async function cancelRevision(projectId, revisionId, { alsoOnProject = null } = {}) {
  const { project, revision, renderExcerptId } = await mutateProjectRecord(projectId, (current) => {
    const out = cancelRevisionOnProject(current, revisionId);
    return alsoOnProject ? { ...out, project: alsoOnProject(out.project) } : out;
  });
  if (renderExcerptId) cancelExcerptRender(renderExcerptId);
  const { listJobs, cancelJob } = await import('../mediaJobQueue/index.js');
  const live = revisionGenerationJobs(project, revision, [...listJobs({ kind: 'video' }), ...listJobs({ kind: 'image' })]);
  const canceledJobIds = [];
  for (const job of live) {
    await cancelJob(job.id).then(() => canceledJobIds.push(job.id), (err) => {
      console.error(`❌ Music Video revision ${revisionId.slice(4, 12)} could not cancel generation job ${job.id.slice(0, 8)}: ${err.message}`);
    });
  }
  if (canceledJobIds.length) console.log(`🛑 Music Video revision ${revisionId.slice(4, 12)} cancelled ${canceledJobIds.length} generation job(s)`);
  return { project, revision, canceledJobIds };
}
