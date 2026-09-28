/**
 * Music Video — selective section revision (#8987, part of #8966): pure record
 * transforms.
 *
 * A director reviews a draft excerpt (#8986), flags the moments that don't
 * work, and asks for a revision. The revision is a persisted CHECKPOINT on the
 * project (`project.revisions[]`) that:
 *
 *   - maps the excerpt's flagged notes onto the sections the draft actually
 *     rendered (`excerpt.sections`, absolute song time) and REJECTS the selected
 *     take of each flagged section — the slot clears, so that section, and only
 *     that section, reads as "needs a take" again (takes.js semantics);
 *   - leaves every other section in the window APPROVED and untouched, with its
 *     selection snapshotted (`keptAssetId`) so the record shows what was kept;
 *   - is resumed by `resumeRevision` (revisionService.js), which re-derives each
 *     rejected section's state from the record plus the media-job queue EVERY
 *     time rather than trusting a stored "submitted" flag. A section whose slot
 *     holds a take is `ready` and is never asked to generate again, whatever
 *     happened to the render — so a rendering retry, a restart, or a second
 *     click can never re-submit paid generation for it.
 *
 * Title cards are code-rendered (no paid generation, #8985), so a flagged card
 * is reported as skipped rather than revised — its fix is an edit, not a take.
 *
 * Peer sync: `revisions` (like `excerpts`) is an additive field on the
 * whole-record LWW project body. An older peer stores it verbatim and has no
 * route that acts on it, so no `musicVideoProjects` schema bump is needed.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { isNonBlankStr } from '../../lib/textUtils.js';
import { ensureSceneTakes, reviewSceneTake, TAKE_SLOT } from './takes.js';
import { projectExcerpts } from './excerpt.js';

// A project row carries its recent revisions; the oldest SETTLED ones are
// dropped past this so a long review loop can't grow one record without bound.
const MAX_PROJECT_REVISIONS = 20;
// A resume that hands a section out for generation CLAIMS it for this long, so
// a second resume (another tab, a double submit) in the window between the
// hand-out and the job reaching the queue can't hand it out again. After the
// lease a section with no job and no take is handed out again — the earlier
// submission evidently never reached the queue.
const GENERATION_CLAIM_LEASE_MS = 90_000;
// A job that completed but whose take never attached (a failed attach write)
// counts as in flight only this long, so it can't wedge the revision forever.
const TAKE_ATTACH_GRACE_MS = 120_000;

const revisionError = (status, code, message, context) =>
  new ServerError(message, { status, code, ...(context ? { context } : {}) });

/** The revision array on a project, tolerating a legacy record with none. */
export const projectRevisions = (project) => (Array.isArray(project?.revisions) ? project.revisions : []);

const isActive = (revision) => revision.status === 'open' || revision.status === 'rendering';

function findRevision(project, revisionId) {
  const revision = projectRevisions(project).find((r) => r.id === revisionId);
  if (!revision) throw revisionError(404, 'NOT_FOUND', 'Revision not found');
  return revision;
}

function replaceRevision(project, revision) {
  return { ...project, revisions: projectRevisions(project).map((r) => (r.id === revision.id ? revision : r)) };
}

function pruneRevisions(revisions) {
  const next = revisions.slice();
  for (let i = 0; i < next.length && next.length > MAX_PROJECT_REVISIONS;) {
    if (isActive(next[i])) i += 1;
    else next.splice(i, 1);
  }
  return next;
}

// The section a song-time instant falls in. Sections are half-open, except the
// window's last one also owns its end instant (a note dropped on the final frame).
function sectionAt(sections, t) {
  const last = sections[sections.length - 1];
  return sections.find((s) => t >= s.startSec - 1e-6 && t < s.endSec - 1e-6)
    || (last && Math.abs(t - last.endSec) <= 1e-6 ? last : null);
}

/**
 * Open a revision from one reviewed excerpt. `sceneIds` (optional) names the
 * sections to reject explicitly; otherwise every section holding a `flagged`
 * note is rejected. Returns `{ project, revision, skippedSceneIds }`.
 */
export function startRevisionOnProject(project, excerptId, { sceneIds } = {}, now = new Date().toISOString()) {
  const active = projectRevisions(project).find(isActive);
  if (active) {
    throw revisionError(409, 'REVISION_IN_PROGRESS', 'Finish or cancel the open revision before starting another', { revisionId: active.id });
  }
  const excerpt = projectExcerpts(project).find((e) => e.id === excerptId);
  if (!excerpt) throw revisionError(404, 'NOT_FOUND', 'Excerpt not found');
  if (excerpt.status !== 'complete') throw revisionError(409, 'EXCERPT_NOT_READY', 'Only a finished draft excerpt can be revised');
  const sections = Array.isArray(excerpt.sections) ? excerpt.sections.filter((s) => isNonBlankStr(s?.sceneId)) : null;
  if (!sections?.length) {
    throw revisionError(422, 'EXCERPT_SECTIONS_UNKNOWN', 'This draft predates section tracking — render the excerpt again to revise it');
  }
  const inWindow = new Set(sections.map((s) => s.sceneId));

  // Notes are timecoded on the excerpt's OWN timeline; sections are in song time.
  const noteIdsByScene = new Map();
  for (const note of excerpt.notes || []) {
    if (note.verdict !== 'flagged') continue;
    const section = sectionAt(sections, excerpt.startSec + note.atSec);
    if (!section) continue;
    noteIdsByScene.set(section.sceneId, [...(noteIdsByScene.get(section.sceneId) || []), note.id]);
  }
  let rejectIds;
  if (Array.isArray(sceneIds)) {
    const outside = sceneIds.filter((id) => !inWindow.has(id));
    if (outside.length) throw revisionError(422, 'SCENE_NOT_IN_EXCERPT', 'Every revised section must be part of this draft excerpt', { sceneIds: outside });
    rejectIds = new Set(sceneIds);
  } else {
    rejectIds = new Set(noteIdsByScene.keys());
  }

  const scenesById = new Map((project.scenes || []).map((s) => [s.sceneId, s]));
  const skippedSceneIds = [];
  let next = project;
  const revisionSections = [];
  const seen = new Set();
  for (const section of sections) {
    if (seen.has(section.sceneId)) continue; // a scene appears once however it was cut
    seen.add(section.sceneId);
    const scene = scenesById.get(section.sceneId);
    if (!scene) continue; // deleted since the draft — nothing left to keep or revise
    const rejected = rejectIds.has(section.sceneId);
    if (section.layer === 'card') {
      if (rejected) skippedSceneIds.push(section.sceneId);
      continue;
    }
    const kind = section.layer === 'still' ? 'image' : 'video';
    const assetId = isNonBlankStr(scene[TAKE_SLOT[kind]]) ? scene[TAKE_SLOT[kind]] : null;
    if (rejected && assetId) {
      // Materialize a legacy selection as a take first, so the take id the
      // review below resolves is the one persisted (ensureSceneTakes mints
      // fresh ids on every call for a selection that has no take yet).
      const idx = next.scenes.findIndex((s) => s.sceneId === section.sceneId);
      const withTakes = { ...next.scenes[idx], takes: ensureSceneTakes(next.scenes[idx], now) };
      const scenes = next.scenes.slice();
      scenes[idx] = withTakes;
      next = { ...next, scenes };
      const take = withTakes.takes.find((t) => t.kind === kind && t.assetId === assetId);
      next = reviewSceneTake(next, section.sceneId, take.takeId, { status: 'rejected' }).project;
    }
    revisionSections.push({
      sceneId: section.sceneId,
      layer: section.layer,
      kind,
      verdict: rejected ? 'rejected' : 'approved',
      rejectedAssetId: rejected ? assetId : null,
      keptAssetId: rejected ? null : assetId,
      noteIds: noteIdsByScene.get(section.sceneId) || [],
    });
  }
  if (!revisionSections.some((s) => s.verdict === 'rejected')) {
    throw revisionError(422, 'NOTHING_TO_REVISE', skippedSceneIds.length
      ? 'The flagged sections are title cards — edit their text instead; there is no footage to regenerate'
      : 'Flag a moment in this draft (or pick a section) before revising it', skippedSceneIds.length ? { skippedSceneIds } : undefined);
  }

  const revision = {
    id: `mvr-${randomUUID()}`,
    excerptId,
    startSec: excerpt.startSec,
    endSec: excerpt.endSec,
    status: 'open',
    sections: revisionSections,
    renderExcerptId: null,
    renderAttempts: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    project: { ...next, revisions: pruneRevisions([...projectRevisions(next), revision]), updatedAt: now },
    revision,
    skippedSceneIds,
  };
}

const tagMatches = (job, projectId, sceneId) =>
  job?.params?.musicVideo?.projectId === projectId && job.params.musicVideo.sceneId === sceneId;

const within = (iso, windowMs, nowMs) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && nowMs - t < windowMs;
};

/**
 * Pure: each section of a revision with its current `state`:
 *   - `kept`             — approved; its selection is untouched;
 *   - `removed`          — the scene was deleted since;
 *   - `ready`            — the slot holds a take (a new one landed, or the
 *                          director selected one) — never generated again;
 *   - `generating`       — a generation job for the scene is queued/running,
 *                          finished moments ago but its take hasn't attached
 *                          yet, or a resume claimed it within the lease;
 *   - `needs-generation` — nothing selected and nothing in flight.
 * `jobs` is the media-job queue's list (queued, running and recent archive).
 */
export function revisionSectionStates(project, revision, jobs = [], nowMs = Date.now()) {
  const scenesById = new Map((project.scenes || []).map((s) => [s.sceneId, s]));
  return (revision.sections || []).map((section) => {
    if (section.verdict !== 'rejected') return { ...section, state: 'kept' };
    const scene = scenesById.get(section.sceneId);
    if (!scene) return { ...section, state: 'removed' };
    if (isNonBlankStr(scene[TAKE_SLOT[section.kind]])) return { ...section, state: 'ready' };
    const takes = Array.isArray(scene.takes) ? scene.takes : [];
    const pending = jobs.some((job) => job?.kind === section.kind && tagMatches(job, project.id, section.sceneId) && (
      job.status === 'queued' || job.status === 'running'
      // Completed after the revision opened, but its take isn't on the scene
      // yet: the attach hook is still writing it. Asking again would pay twice.
      || (job.status === 'completed' && typeof job.queuedAt === 'string' && job.queuedAt >= revision.createdAt
        && within(job.completedAt, TAKE_ATTACH_GRACE_MS, nowMs) && !takes.some((t) => t.jobId === job.id))
    ));
    const claimed = within(section.claimedAt, GENERATION_CLAIM_LEASE_MS, nowMs);
    return { ...section, state: pending || claimed ? 'generating' : 'needs-generation' };
  });
}

/** Find a revision that can still be resumed (open, or rendering). Throws 404/409. */
function resumableRevision(project, revisionId) {
  const revision = findRevision(project, revisionId);
  if (!isActive(revision)) {
    throw revisionError(409, 'REVISION_CLOSED', `This revision is already ${revision.status}`);
  }
  return revision;
}

/**
 * Pure: the live (queued/running) generation jobs a revision started — tagged
 * for one of its rejected sections and queued since it opened. Cancelling the
 * revision cancels these, so no paid work keeps running for a closed revision.
 */
export function revisionGenerationJobs(project, revision, jobs = []) {
  const rejected = (revision.sections || []).filter((s) => s.verdict === 'rejected');
  return jobs.filter((job) => (job?.status === 'queued' || job?.status === 'running')
    && typeof job.queuedAt === 'string' && job.queuedAt >= revision.createdAt
    && rejected.some((s) => job.kind === s.kind && tagMatches(job, project.id, s.sceneId)));
}

/**
 * Resume's atomic step (run under the record's write serialization): derive
 * every section's state and CLAIM the ones about to be handed out for
 * generation, so two overlapping resumes can never both hand out the same
 * section. Returns `{ project, revision, needsGeneration, generating }` —
 * `revision.sections` carry their derived `state`.
 */
export function claimRevisionGeneration(project, revisionId, jobs = [], nowMs = Date.now()) {
  const revision = resumableRevision(project, revisionId);
  const states = revisionSectionStates(project, revision, jobs, nowMs);
  const ref = ({ sceneId, kind }) => ({ sceneId, kind });
  const needsGeneration = states.filter((s) => s.state === 'needs-generation').map(ref);
  const generating = states.filter((s) => s.state === 'generating').map(ref);
  if (!needsGeneration.length) return { project, revision: { ...revision, sections: states }, needsGeneration, generating };
  const claimedAt = new Date(nowMs).toISOString();
  const claimIds = new Set(needsGeneration.map((s) => s.sceneId));
  const next = { ...revision, sections: revision.sections.map((s) => (claimIds.has(s.sceneId) ? { ...s, claimedAt } : s)), updatedAt: claimedAt };
  return {
    project: replaceRevision(project, next),
    revision: { ...next, sections: states.map((s) => (claimIds.has(s.sceneId) ? { ...s, claimedAt } : s)) },
    needsGeneration,
    generating,
  };
}

/**
 * Link a draft re-render to an open revision (same write as the excerpt's
 * creation, so a fast finish can always find the revision it settles).
 */
export function markRevisionRendering(project, revisionId, renderExcerptId, now = new Date().toISOString()) {
  const revision = resumableRevision(project, revisionId);
  if (revision.status === 'rendering') {
    const current = projectExcerpts(project).find((e) => e.id === revision.renderExcerptId);
    if (current?.status === 'rendering') {
      throw revisionError(409, 'REVISION_RENDERING', 'This revision is already rendering its draft', { excerptId: current.id });
    }
  }
  return replaceRevision(project, {
    ...revision,
    status: 'rendering',
    renderExcerptId,
    renderAttempts: (revision.renderAttempts || 0) + 1,
    error: null,
    updatedAt: now,
  });
}

/**
 * Settle every revision whose draft re-render just ended. `complete` closes the
 * revision; an error or a cancel returns it to `open` (resumable — the next
 * resume re-renders without generating anything). A canceled revision stays so.
 */
export function settleRevisionRender(project, excerptId, { status, error = null }, now = new Date().toISOString()) {
  let changed = false;
  const revisions = projectRevisions(project).map((revision) => {
    if (revision.renderExcerptId !== excerptId || revision.status !== 'rendering') return revision;
    changed = true;
    return status === 'complete'
      ? { ...revision, status: 'complete', error: null, updatedAt: now }
      : { ...revision, status: 'open', error: error || 'The draft render was cancelled', updatedAt: now };
  });
  return changed ? { ...project, revisions } : project;
}

/** Cancel a revision. Its rejected takes stay rejected — the director can re-select one. */
export function cancelRevisionOnProject(project, revisionId, now = new Date().toISOString()) {
  const revision = resumableRevision(project, revisionId);
  const next = { ...revision, status: 'canceled', updatedAt: now };
  return { project: replaceRevision(project, next), revision: next, renderExcerptId: revision.status === 'rendering' ? revision.renderExcerptId : null };
}
