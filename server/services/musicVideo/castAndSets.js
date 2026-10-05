/**
 * Music Video — Cast & Sets check-in stage: pure record transforms over
 * `project.castAndSets`.
 *
 * The stage runs before the shot plan: a creative-direction call, then the
 * reference images (character sheet first; see castAndSetsPlan.js), then a
 * self-contained check-in sheet saved as a `cast-sets` development artifact.
 * With `automation.checkins.castAndSets === 'review'` (the default) it stops
 * at `review` until the director approves; with `auto` it approves itself.
 *
 *   {
 *     revision, status, stopReason, error,
 *     processId,            // the server process that may dispatch for it
 *     productionRunId,      // the production run that started it, if any
 *     route: { mode, model },
 *     direction,            // castAndSetsDirection.js shape (`medium`: absent = photographic)
 *     moodImages: [{ kind, filename }],
 *     plan:   { [key]: { key, kind, label, prompt, deps, refKeys, moodRefs?, setId?, testIndex? } },
 *     images: { [key]: { status, jobId, imageId, history, failures, error, updatedAt,
 *       submittedPrompt?, submittedPromptTruncated?, submittedReferences?, submittedRevision? } },
 *     artifactId, artifactVersion, notesApplied,
 *     createdAt, updatedAt, approvedAt,
 *     approvedInputs,       // labeled input hashes the approval rests on (productionReview.js); absent on legacy approvals
 *     approvedValues,       // capped approved values of the revertible inputs, keyed like approvedInputs; absent = not revertible
 *   }
 *
 * Status: `directing` → `imaging` → `assembling` → `review` → `approved`, or
 * `failed` / `skipped`. A stage in one of the three working states whose
 * `processId` is not this process was interrupted by a restart: completions of
 * jobs already queued still land, but nothing new is dispatched (and no
 * provider is called) until the director resumes it.
 *
 * Peer sync: `castAndSets` is WIRE-LOCAL like `productionRuns` — it names this
 * install's jobs, processes and development files. What an approval produces
 * (visual-spec references, concept subjects) is ordinary project content and
 * syncs as usual.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { trimTo } from '../../lib/textUtils.js';

export const CAST_SETS_STATUSES = Object.freeze(['directing', 'imaging', 'assembling', 'review', 'approved', 'failed', 'skipped']);
export const CAST_SETS_WORKING = Object.freeze(['directing', 'imaging', 'assembling']);
// Settled = the autopilot may continue past the stage.
export const CAST_SETS_SETTLED = Object.freeze(['approved', 'skipped']);
// A key whose render failed this many times in a row stops the stage.
const MAX_IMAGE_FAILURES = 2;
const MAX_HISTORY = 20;
const MAX_REASON = 500;

const stageError = (status, code, message) => new ServerError(message, { status, code });

/** The check-in mode for a project (default: review). */
export const castAndSetsCheckinMode = (project) => (project?.automation?.checkins?.castAndSets === 'auto' ? 'auto' : 'review');

/** The direction a code-authoring request may reuse: only an APPROVED stage's. */
export const approvedCastAndSetsDirection = (project) => (project?.castAndSets?.status === 'approved' ? (project.castAndSets.direction || null) : null);

export const castAndSetsSettled = (stage) => CAST_SETS_SETTLED.includes(stage?.status);

/** The stage as the director sees it: `interrupted` when a restart unpinned a working stage. */
export const presentCastAndSets = (stage, processId) => (stage
  ? { ...stage, interrupted: CAST_SETS_WORKING.includes(stage.status) && stage.processId !== processId }
  : null);

function requireStage(project) {
  const stage = project?.castAndSets;
  if (!stage) throw stageError(404, 'NOT_FOUND', 'This project has no Cast & Sets check-in yet');
  return stage;
}

function write(project, stage, now) {
  return { project: { ...project, castAndSets: { ...stage, updatedAt: now }, updatedAt: now }, stage: { ...stage, updatedAt: now } };
}

/**
 * Begin (or restart) the stage. Refuses while a working stage is live in
 * this process, and while a sheet awaits review (regenerate instead). A
 * skipped or approved stage restarts as a Rebuild: the prior sheet's artifact
 * keeps its versions, so the earlier sheet stays in history. Returns `{ project, stage }`.
 */
export function startCastAndSetsOnProject(project, { processId, productionRunId = null }, now = new Date().toISOString()) {
  const current = project?.castAndSets || null;
  if (current && CAST_SETS_WORKING.includes(current.status) && current.processId === processId) {
    throw stageError(409, 'CAST_SETS_IN_PROGRESS', 'The Cast & Sets check-in is already being prepared');
  }
  if (current?.status === 'review') {
    throw stageError(409, 'CAST_SETS_EXISTS', 'This project already has a Cast & Sets sheet awaiting review — regenerate it instead');
  }
  const stage = {
    revision: (current?.revision || 0) + 1,
    status: 'directing',
    stopReason: null,
    error: null,
    processId,
    productionRunId,
    route: current?.route || null,
    direction: current?.direction || null,
    moodImages: current?.moodImages || [],
    plan: current?.plan || {},
    images: current?.images || {},
    artifactId: current?.artifactId || null,
    artifactVersion: current?.artifactVersion || null,
    notesApplied: [],
    createdAt: current?.createdAt || now,
    approvedAt: null,
  };
  return write(project, stage, now);
}

/**
 * Re-open an existing sheet for a revision (Regenerate with notes). The stage
 * goes back to `directing` when the direction itself must change, else
 * straight to `imaging`. Returns `{ project, stage }`.
 */
export function reviseCastAndSetsOnProject(project, { processId, notesApplied = [], redirect }, now = new Date().toISOString()) {
  const stage = requireStage(project);
  if (CAST_SETS_WORKING.includes(stage.status) && stage.processId === processId) {
    throw stageError(409, 'CAST_SETS_IN_PROGRESS', 'The Cast & Sets check-in is already being prepared');
  }
  if (!stage.direction) throw stageError(409, 'CAST_SETS_NO_DIRECTION', 'There is no direction to revise yet — start the check-in first');
  return write(project, {
    ...stage,
    revision: stage.revision + 1,
    status: redirect ? 'directing' : 'imaging',
    stopReason: null,
    error: null,
    processId,
    notesApplied: notesApplied.map((n) => ({ id: n.id || null, target: n.target || null, text: trimTo(n.text, 2000) })),
    approvedAt: null,
    approvedInputs: null,
    approvedValues: null,
  }, now);
}

/** Re-pin an interrupted working stage to this process. Returns `{ project, stage }`. */
export function resumeCastAndSetsOnProject(project, { processId }, now = new Date().toISOString()) {
  const stage = requireStage(project);
  if (!CAST_SETS_WORKING.includes(stage.status) && stage.status !== 'failed') {
    throw stageError(409, 'CAST_SETS_NOT_RESUMABLE', `The Cast & Sets check-in is ${stage.status}`);
  }
  // A failed stage resumes where it stopped: failed keys get another try.
  const images = Object.fromEntries(Object.entries(stage.images || {}).map(([key, img]) => [key,
    img.status === 'failed' || (img.status === 'queued' && !img.jobId) ? { ...img, status: 'pending', failures: 0, error: null } : img]));
  const status = stage.status === 'failed' ? (stage.direction ? 'imaging' : 'directing') : stage.status;
  return write(project, { ...stage, status, images, processId, stopReason: null, error: null }, now);
}

/**
 * Record the direction and its image plan. `renderKeys` are the plan keys to
 * (re)render; every other key keeps its image. Keys no longer in the plan are
 * dropped. Returns `{ project, stage }`.
 */
export function setCastAndSetsDirection(project, { direction, plan, moodImages, route, renderKeys }, now = new Date().toISOString()) {
  const stage = requireStage(project);
  const rerender = new Set(renderKeys);
  const images = {};
  for (const key of Object.keys(plan)) {
    const prev = stage.images?.[key];
    images[key] = !prev || rerender.has(key)
      ? { status: 'pending', jobId: null, imageId: prev?.imageId || null, history: prev?.history || [], failures: 0, error: null, updatedAt: now }
      : prev;
  }
  return write(project, {
    ...stage,
    status: 'imaging',
    direction,
    plan,
    moodImages: moodImages ?? stage.moodImages ?? [],
    route: route ?? stage.route ?? null,
    images,
  }, now);
}

/** Keys whose image may be dispatched now: pending, with every dependency done. */
export function dispatchableImageKeys(stage) {
  const images = stage?.images || {};
  return Object.values(stage?.plan || {})
    .filter((item) => images[item.key]?.status === 'pending' && item.deps.every((d) => images[d]?.status === 'done'))
    .map((item) => item.key);
}

// A procedural direction with no planned images (a code-only project) has
// nothing to render: its characters and worlds are code, so the sheet can go
// straight to review.
export const allCastAndSetsImagesDone = (stage) => {
  const keys = Object.keys(stage?.plan || {});
  if (!keys.length) return stage?.direction?.medium === 'procedural';
  return keys.every((key) => stage.images?.[key]?.status === 'done');
};

/**
 * Reserve one key for dispatch in a serialized write, so two advances cannot
 * enqueue it twice. Throws 409 when it is not pending or the stage is not
 * dispatching in this process. Returns `{ project, stage }`.
 */
export function reserveCastAndSetsImage(project, key, { processId }, now = new Date().toISOString()) {
  const stage = requireStage(project);
  if (stage.status !== 'imaging' || stage.processId !== processId) throw stageError(409, 'CAST_SETS_NOT_RUNNING', 'The Cast & Sets check-in is not generating images in this process');
  const img = stage.images?.[key];
  if (!img || img.status !== 'pending') throw stageError(409, 'CAST_SETS_IMAGE_BUSY', `The ${key} image is not waiting to render`);
  return write(project, { ...stage, images: { ...stage.images, [key]: { ...img, status: 'queued', jobId: null, updatedAt: now } } }, now);
}

/** Link the queued job to its key. */
export function linkCastAndSetsJob(project, key, jobId, submission = {}, now = new Date().toISOString()) {
  const stage = requireStage(project);
  const img = stage.images?.[key];
  if (!img || (submission.submittedRevision != null && submission.submittedRevision !== stage.revision)) return { project, stage };
  return write(project, { ...stage, images: { ...stage.images, [key]: { ...img, ...submission, jobId, updatedAt: now } } }, now);
}

/**
 * Settle a key's render. `filename` = it landed; otherwise `error`. A job that
 * is not the key's current one (a superseded render) is ignored. A failure is
 * retried once (back to pending); the second consecutive failure stops the
 * stage `failed`. Returns `{ project, stage, changed }`.
 */
export function settleCastAndSetsImage(project, key, { jobId = null, filename = null, error = null, revision = null }, now = new Date().toISOString()) {
  const stage = project?.castAndSets;
  const img = stage?.images?.[key];
  if (!img || img.status !== 'queued' || (revision != null && revision !== stage.revision)
    || (jobId && img.jobId && img.jobId !== jobId)) return { project, stage, changed: false };
  if (filename) {
    const history = img.imageId && img.imageId !== filename ? [...(img.history || []), img.imageId].slice(-MAX_HISTORY) : (img.history || []);
    const next = { ...img, status: 'done', jobId: jobId || img.jobId, imageId: filename, history, failures: 0, error: null, updatedAt: now };
    return { ...write(project, { ...stage, images: { ...stage.images, [key]: next } }, now), changed: true };
  }
  const failures = (img.failures || 0) + 1;
  const reason = trimTo(String(error || 'The render failed'), MAX_REASON);
  const next = { ...img, status: failures >= MAX_IMAGE_FAILURES ? 'failed' : 'pending', jobId: null, failures, error: reason, updatedAt: now };
  const failed = next.status === 'failed';
  return {
    ...write(project, {
      ...stage,
      images: { ...stage.images, [key]: next },
      ...(failed ? { status: 'failed', stopReason: `The ${stage.plan?.[key]?.label || key} image failed twice: ${reason}` } : {}),
    }, now),
    changed: true,
  };
}

/** Enter a new working/terminal status with an optional reason. */
export function setCastAndSetsStatus(project, status, { reason = null, error = null, extra = {} } = {}, now = new Date().toISOString()) {
  if (!CAST_SETS_STATUSES.includes(status)) throw new Error(`setCastAndSetsStatus: invalid status ${status}`);
  const stage = requireStage(project);
  return write(project, {
    ...stage,
    ...extra,
    status,
    stopReason: reason ? trimTo(String(reason), MAX_REASON) : null,
    error: error ? trimTo(String(error), MAX_REASON) : null,
    ...(status === 'approved' ? { approvedAt: now } : {}),
  }, now);
}

/**
 * Keep an approved check-in approved on its current inputs ("Keep approved"):
 * re-stamps `approvedInputs` without re-applying the sheet, so the director's
 * later concept/style edits stand. Returns `{ project, stage }`.
 */
export function reconfirmCastAndSetsOnProject(project, approvedInputs, approvedValues = null, now = new Date().toISOString()) {
  const stage = requireStage(project);
  if (stage.status !== 'approved') throw stageError(409, 'CAST_SETS_NOT_APPROVED', `The Cast & Sets check-in is ${stage.status}, not approved`);
  return write(project, { ...stage, approvedInputs, approvedValues, approvedAt: now }, now);
}

/** Refuse an approval that has nothing to approve. */
export function assertCastAndSetsApprovable(project) {
  const stage = requireStage(project);
  if (stage.status !== 'review') throw stageError(409, 'CAST_SETS_NOT_IN_REVIEW', `The Cast & Sets check-in is ${stage.status}, not waiting for review`);
  return stage;
}
