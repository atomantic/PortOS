import { plateRequirementBasis, selectedPlatePasses } from '../../lib/musicVideoPlateEvidence.js';
import { musicVideoDependencyChanges } from '../../lib/musicVideoDependencies.js';
/**
 * Music Video — server-owned production run (#9066): pure record transforms.
 *
 * A production run is an install-local checkpoint on the project
 * (`project.productionRuns[]`) that exists only because the director pressed
 * Start with:
 *
 *   - a free-text `directive` (steers the plan when the board is empty);
 *   - an allowlist `pool` of image/video `{ kind, mode, model }` routes — the
 *     only routes any step may dispatch to (re-checked at dispatch, see
 *     productionPool.js; there is never a silent fallback to another route);
 *   - `limits`: `maxGenerations` (paid scene-generation jobs, including the
 *     review's revisions), `maxReviewAttempts` (reviewer calls on the
 *     continuous excerpt) and an optional `spendCapUsd`, accepted only when
 *     every metered route in the pool has a known price.
 *
 * The run records a `basis` — a checksum of the creative setup (concept,
 * visual spec, treatment brief, automation brief, audio analysis, pacing,
 * composition) — at Start. Any later change halts the run `needs-replan`;
 * only an explicit resume that accepts the new basis continues.
 *
 * Every dispatch is a STEP with a stable key, reserved (and charged) in one
 * serialized write BEFORE the job is enqueued, then linked to its job id.
 * The queue (not the record) is the in-flight truth: a scene with a live job
 * for its slot — ours or the director's — is never dispatched again, so a
 * lost write between enqueue and link cannot cause a duplicate job. A step
 * settles exactly once (duplicate completion events are no-ops), and only a
 * step whose job provably never reached the queue is refunded.
 *
 * `processId` pins a running run to the server process that started or
 * resumed it: after a restart the checkpoint loads, completion events of
 * already-queued jobs still settle their steps, but nothing is dispatched
 * until the director explicitly resumes.
 *
 * Peer sync: `productionRuns` is WIRE-LOCAL (lib/syncWire.js) — the pool names
 * this install's providers, and a peer must never execute another machine's
 * run. `mergeProjectRecord` restores the local runs over a newer remote copy.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';
import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';
import { isLayeredComposition, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { codeFirstProductionAssets, normalizeMusicVideoProductionPolicy, summarizeMusicVideoMediumPlan } from '../../lib/musicVideoMediumPlan.js';
import { projectAutoReviews } from './autoReview.js';
import { projectRevisions } from './revision.js';
import { castAndSetsSettled } from './castAndSets.js';

const PRODUCTION_LIMIT_BOUNDS = Object.freeze({
  maxGenerations: Object.freeze({ min: 1, max: 500 }),
  maxReviewAttempts: Object.freeze({ min: 1, max: 10 }),
  spendCapUsd: Object.freeze({ min: 0, max: 100000 }),
});
const PRODUCTION_DIRECTIVE_MAX = 4000;
const PRODUCTION_POOL_MAX = 12;
const PRODUCTION_STATUSES = Object.freeze([
  'running', 'stopped', 'limit-reached', 'blocked', 'needs-replan', 'completed', 'needs-human', 'failed', 'canceled',
]);
const RESUMABLE = new Set(['running', 'stopped', 'limit-reached', 'blocked', 'needs-replan']);
const LIVE_STEP = new Set(['reserved', 'queued']);
const LIVE_JOB = new Set(['queued', 'running']);
// A reserved step whose job never showed up in the queue after this long did
// not reach it (enqueue persists synchronously before returning).
const RESERVATION_LEASE_MS = 60_000;
const MAX_PROJECT_RUNS = 10;
const MAX_RUN_STEPS = 1000;
const MAX_ERROR_LEN = 500;

const productionError = (status, code, message, context) =>
  new ServerError(message, { status, code, ...(context ? { context } : {}) });

/** The run array on a project, tolerating a legacy record with none. */
export const projectProductionRuns = (project) => (Array.isArray(project?.productionRuns) ? project.productionRuns : []);

/** The run that is still live (running or resumable), if any. */
const activeProductionRun = (project) => projectProductionRuns(project).find((r) => RESUMABLE.has(r.status)) || null;

export function findProductionRun(project, runId) {
  const run = projectProductionRuns(project).find((r) => r.id === runId);
  if (!run) throw productionError(404, 'NOT_FOUND', 'Production run not found');
  return run;
}

function replaceRun(project, run) {
  return { ...project, productionRuns: projectProductionRuns(project).map((r) => (r.id === run.id ? run : r)) };
}

function mutateRun(project, runId, fn, now) {
  const run = findProductionRun(project, runId);
  const next = { ...run, ...fn(run), updatedAt: now };
  return { project: replaceRun(project, next), run: next };
}

function pruneRuns(runs) {
  const next = runs.slice();
  for (let i = 0; i < next.length && next.length > MAX_PROJECT_RUNS;) {
    if (RESUMABLE.has(next[i].status)) i += 1;
    else next.splice(i, 1);
  }
  return next;
}

/**
 * The creative inputs a run was planned against. Scenes are deliberately NOT
 * part of it: the run itself seeds and fills them, and a director editing one
 * scene's prompt mid-run changes only what that scene generates next.
 */
function productionBasisRevision(project, version = 1) {
  const pick = (value) => value ?? null;
  return canonicalSnapshotChecksum({
    concept: pick(project?.concept),
    visualSpec: pick(project?.visualSpec),
    ...(project?.styleReferences?.length ? { styleReferences: project.styleReferences } : {}),
    brief: pick(project?.treatment?.brief),
    automation: pick(project?.automation),
    audio: {
      trackId: pick(project?.trackId),
      uploadedAudioFilename: pick(project?.uploadedAudioFilename),
      sections: pick(project?.audioAnalysis?.sections),
      durationSec: pick(project?.audioAnalysis?.durationSec),
    },
    pacing: pick(project?.pacing),
    composition: pick(project?.composition?.mode),
    ...(version >= 2 ? {
      productionPolicy: normalizeMusicVideoProductionPolicy(project?.productionPolicy),
      ...(normalizeMusicVideoProductionPolicy(project?.productionPolicy).strategy === 'code-first'
        ? { shotDirections: pick(project?.treatment?.shotDirections) } : {}),
      ...(version >= 3 ? {
        sceneTiming: (project?.scenes || []).map(({ sceneId, startSec, endSec, shotMode }) => ({ sceneId, startSec, endSec, shotMode: shotMode || 'cutaway' })),
        videoSettings: pick(project?.videoSettings),
        treatment: pick(project?.treatment),
        audioAnalysis: pick(project?.audioAnalysis),
        lyricCues: pick(project?.lyricCues),
        lyricMarkers: pick(project?.lyricMarkers),
        compositionStyle: pick(project?.composition?.style),
      } : {}),
    } : {}),
  });
}

const intIn = (value, { min, max }, name) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw productionError(422, 'VALIDATION_ERROR', `${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
};

/** Every limit but the dollar cap is REQUIRED — a run never picks its own budget. */
function normalizeProductionLimits(limits) {
  const cap = limits?.spendCapUsd;
  if (cap != null && !(typeof cap === 'number' && cap >= PRODUCTION_LIMIT_BOUNDS.spendCapUsd.min && cap <= PRODUCTION_LIMIT_BOUNDS.spendCapUsd.max)) {
    throw productionError(422, 'VALIDATION_ERROR', `spendCapUsd must be a number from 0 to ${PRODUCTION_LIMIT_BOUNDS.spendCapUsd.max}, or null`);
  }
  return {
    maxGenerations: intIn(limits?.maxGenerations, PRODUCTION_LIMIT_BOUNDS.maxGenerations, 'maxGenerations'),
    maxReviewAttempts: intIn(limits?.maxReviewAttempts, PRODUCTION_LIMIT_BOUNDS.maxReviewAttempts, 'maxReviewAttempts'),
    spendCapUsd: cap == null ? null : cap,
  };
}

/** A pool route's identity: the same backend + model always compares equal. */
export const routeKey = (route) => `${route.kind}:${route.mode}:${route.model || ''}`;

/** De-duplicate a validated pool, keeping the director's order (it is the preference order). */
export function normalizeProductionPool(pool, { allowEmpty = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(pool) ? pool : []) {
    if (!entry || (entry.kind !== 'image' && entry.kind !== 'video') || !isNonBlankStr(entry.mode)) continue;
    const route = { kind: entry.kind, mode: entry.mode.trim(), model: isNonBlankStr(entry.model) ? entry.model.trim() : null };
    if (seen.has(routeKey(route))) continue;
    seen.add(routeKey(route));
    out.push(route);
  }
  if (!out.length && !allowEmpty) throw productionError(422, 'VALIDATION_ERROR', 'The allowed pool needs at least one image or video route');
  if (out.length > PRODUCTION_POOL_MAX) throw productionError(422, 'VALIDATION_ERROR', `The allowed pool holds at most ${PRODUCTION_POOL_MAX} routes`);
  return out;
}

/** Is `route` literally a member of the run's allowlist? */
export const poolHasRoute = (run, route) => !!route && run.pool.some((r) => routeKey(r) === routeKey(route));

/**
 * Start a run. Refuses while another production run, an auto-review run, or
 * a manual revision is live — the run needs those slots for its own review.
 * `pricing` maps routeKey → price per generation in USD (0 for local, null
 * when unknown); a dollar cap requires every route to have a known price.
 */
export function startProductionOnProject(project, {
  directive = '', pool, limits, reviewer = {}, authoring = null, processId, pricing = {},
}, now = new Date().toISOString()) {
  const live = activeProductionRun(project);
  if (live) throw productionError(409, 'PRODUCTION_IN_PROGRESS', 'Finish, cancel or resume the existing production run first', { runId: live.id });
  const liveReview = projectAutoReviews(project).find((r) => ['running', 'stopped', 'limit-reached'].includes(r.status));
  if (liveReview) throw productionError(409, 'AUTO_REVIEW_IN_PROGRESS', 'Finish or cancel the auto-review run before starting production', { runId: liveReview.id });
  const openRevision = projectRevisions(project).find((r) => r.status === 'open' || r.status === 'rendering');
  if (openRevision) throw productionError(409, 'REVISION_IN_PROGRESS', 'Finish or cancel the open revision before starting production', { revisionId: openRevision.id });
  const codeFirst = normalizeMusicVideoProductionPolicy(project?.productionPolicy).strategy === 'code-first';
  if (codeFirst) {
    if (project?.composition?.mode !== 'document') throw productionError(409, 'PRODUCTION_UNSUPPORTED', 'Code-first production needs document composition mode');
    const assets = codeFirstProductionAssets(project);
    if (!project.scenes?.length || assets.conflicts.length) throw productionError(409, 'PRODUCTION_MEDIUM_CONFLICT', assets.conflicts.join(' ') || 'Approve a timed medium plan before starting production');
    if (!authoring?.providerId || !authoring?.model) throw productionError(422, 'PRODUCTION_AUTHORING_REQUIRED', 'Select a separate code-authoring provider and model');
  }
  if (!codeFirst && project?.composition?.mode === 'code') {
    throw productionError(409, 'PRODUCTION_UNSUPPORTED', 'A code-rendered project generates no footage — render it directly');
  }
  if (!Array.isArray(project?.audioAnalysis?.sections) || !project.audioAnalysis.sections.length) {
    throw productionError(409, 'NOT_ANALYZED', 'Analyze the song before starting production');
  }
  const normalizedPool = normalizeProductionPool(pool, { allowEmpty: codeFirst });
  const normalizedLimits = normalizeProductionLimits(limits);
  if (normalizedLimits.spendCapUsd !== null) {
    if (codeFirst && authoring.costUsd == null) throw productionError(409, 'PRODUCTION_COST_UNKNOWN', 'Code-authoring has no bounded dollar price. Choose a free/local authoring provider or remove the dollar cap; every authoring call still consumes the generation limit.');
    const unpriced = normalizedPool.filter((r) => typeof pricing[routeKey(r)] !== 'number');
    if (unpriced.length) {
      throw productionError(409, 'PRODUCTION_COST_UNKNOWN',
        `A dollar cap needs a known price for every route; ${unpriced.map((r) => `${r.kind} ${r.mode}${r.model ? ` (${r.model})` : ''}`).join(', ')} has none. Remove the cap (the generation limit still applies) or remove those routes.`);
    }
  }
  const run = {
    id: `mvpr-${randomUUID()}`,
    status: 'running',
    directive: trimTo(typeof directive === 'string' ? directive : '', PRODUCTION_DIRECTIVE_MAX) || '',
    pool: normalizedPool,
    pricing: Object.fromEntries(normalizedPool.map((r) => [routeKey(r), typeof pricing[routeKey(r)] === 'number' ? pricing[routeKey(r)] : null])),
    limits: normalizedLimits,
    ...(codeFirst ? { authoring: { ...authoring }, documentCheckpoint: null, finalRender: null } : {}),
    reviewer: {
      providerId: isNonBlankStr(reviewer.providerId) ? reviewer.providerId : null,
      model: isNonBlankStr(reviewer.model) ? reviewer.model : null,
    },
    basis: { version: codeFirst ? 3 : 2, revision: productionBasisRevision(project, codeFirst ? 3 : 2), capturedAt: now },
    usage: { generations: 0, spentUsd: 0 },
    planned: false,
    reviewRunId: null,
    steps: [],
    processId: processId || null,
    stopReason: null,
    error: null,
    createdAt: now,
    resumedAt: now,
    updatedAt: now,
  };
  return { project: { ...project, productionRuns: pruneRuns([...projectProductionRuns(project), run]), updatedAt: now }, run };
}

/** Final submission guard, called after provider preparation and before queueing. */
export function assertProductionStepOpen(project, runId, stepKey, { sceneId, kind, processId }) {
  const run = findProductionRun(project, runId);
  const step = run.steps.find((entry) => entry.key === stepKey);
  if (run.status !== 'running' || run.processId !== processId || !step || step.status !== 'reserved' || step.sceneId !== sceneId
    || JOB_KIND[step.kind] !== kind) {
    throw productionError(409, 'PRODUCTION_STEP_CLOSED', 'The production step was stopped or changed before submission');
  }
  if (productionBasisRevision(project, run.basis.version || 1) !== run.basis.revision) {
    throw productionError(409, 'PRODUCTION_BASIS_CHANGED', 'The production policy or approved plan changed before submission');
  }
  if (normalizeMusicVideoProductionPolicy(project?.productionPolicy).strategy === 'code-first') {
    const plan = summarizeMusicVideoMediumPlan(project);
    const medium = project.treatment?.shotDirections?.find((direction) => direction.sceneId === sceneId)?.medium;
    if (plan.blocked || (kind === 'video' && medium !== 'generated-footage')
      || (kind === 'image' && !['still', 'generated-footage'].includes(medium))) {
      throw productionError(409, 'PRODUCTION_MEDIUM_CONFLICT', 'The approved medium plan or generated-video allowance no longer permits this submission');
    }
    if (kind !== 'code' && step.submissionBasis !== productionSceneBasis(project, sceneId)) throw productionError(409, 'PRODUCTION_BASIS_CHANGED', 'This shot changed while its provider request was being prepared');
  }
  if (kind === 'video' && step.plateAdmission) {
    const scene = project.scenes.find((entry) => entry.sceneId === sceneId);
    if (scene.referenceImageId !== step.plateAdmission.assetId || plateRequirementBasis(scene) !== step.plateAdmission.basis || !selectedPlatePasses(scene, runId)) throw productionError(409, 'PRODUCTION_PLATE_CHANGED', 'The selected plate or its requirements changed before animation');
  }
  return step;
}

// ---- deriving the next step -------------------------------------------------

const SLOT = Object.freeze({ frame: 'referenceImageId', clip: 'videoHistoryId' });
const JOB_KIND = Object.freeze({ frame: 'image', clip: 'video', author: 'code', plate: 'plate' });

const productionSceneBasis = (project, sceneId) => canonicalSnapshotChecksum({
  scene: (project.scenes || []).find((scene) => scene.sceneId === sceneId) || null,
  videoSettings: project.videoSettings || null,
});

// A retry is a new provider operation only when its actual inputs changed.
// Take history, review timestamps and UI labels must not clear a terminal refusal.
const productionRetryBasis = (project, sceneId, kind) => {
  const scene = (project.scenes || []).find((entry) => entry.sceneId === sceneId) || {};
  return canonicalSnapshotChecksum({
    kind,
    framePrompt: scene.framePrompt ?? null,
    prompt: scene.prompt ?? null,
    direction: scene.direction ?? null,
    shotMode: scene.shotMode ?? null,
    startSec: scene.startSec ?? null,
    endSec: scene.endSec ?? null,
    ...(kind === 'clip' ? { referenceImageId: scene.referenceImageId ?? null } : {}),
    concept: project.concept ?? null,
    treatment: project.treatment ?? null,
    sectionIndex: scene.sectionIndex ?? null,
    visualSpec: project.visualSpec ?? null,
    castAndSets: project.castAndSets?.direction?.songMap ?? null,
    lyricCues: kind === 'clip' ? project.lyricCues ?? null : null,
    phrases: kind === 'clip' ? project.phrases ?? null : null,
    audioAnalysis: kind === 'clip' ? project.audioAnalysis ?? null : null,
    styleReferences: project.styleReferences ?? null,
    videoSettings: project.videoSettings ?? null,
  });
};

const terminalRefusal = (project, run, sceneId, kind, route = null) =>
  run.steps.find((step) => step.sceneId === sceneId && step.kind === kind && step.retryBlocked
    && step.retryBasis === productionRetryBasis(project, sceneId, kind)
    && (!route || routeKey(step.route) === routeKey(route)));

/** All code-first work stays tied to the process and approved plan that reserved it. */
export function assertProductionActive(project, runId, processId) {
  const run = findProductionRun(project, runId);
  if (run.status !== 'running' || run.processId !== processId) throw productionError(409, 'PRODUCTION_NOT_RUNNING', 'Resume this production run before dispatching more work');
  if (productionBasisRevision(project, run.basis.version || 1) !== run.basis.revision) throw productionError(409, 'PRODUCTION_BASIS_CHANGED', 'The approved setup changed — review it and resume');
  if (run.documentCheckpoint?.scenesRevision && run.documentCheckpoint.scenesRevision !== canonicalSnapshotChecksum(project.scenes || [])) throw productionError(409, 'PRODUCTION_BASIS_CHANGED', 'The selected media changed since the document was authored — replan and review it');
  if (run.authoring && codeFirstProductionAssets(project)?.conflicts.length) throw productionError(409, 'PRODUCTION_MEDIUM_CONFLICT', codeFirstProductionAssets(project).conflicts.join(' '));
  return run;
}

/** The scenes that need a still frame and a clip, per the project's render mode. */
function productionTargets(project) {
  const assets = codeFirstProductionAssets(project);
  if (assets) {
    const ids = (action) => new Set(assets.steps.filter((step) => step.action === action).map((step) => step.sceneId));
    const frames = ids('generate-image');
    const clips = ids('generate-video');
    return { frame: project.scenes.filter((scene) => frames.has(scene.sceneId)), clip: project.scenes.filter((scene) => clips.has(scene.sceneId)) };
  }
  const layered = isLayeredComposition(project);
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  return {
    frame: scenes.filter((s) => sceneVisualLayer(s, { layered }) !== 'card'),
    clip: scenes.filter((s) => sceneVisualLayer(s, { layered }) === 'footage'),
  };
}

/** A live media job generating this scene slot — ours, a revision's, or the director's own. */
function liveSlotJob(jobs, projectId, sceneId, stepKind) {
  return (jobs || []).find((job) => job?.kind === JOB_KIND[stepKind] && LIVE_JOB.has(job.status)
    && job.params?.musicVideo?.projectId === projectId && job.params.musicVideo.sceneId === sceneId) || null;
}

const slotSteps = (run, sceneId, stepKind, revisionId = null) => run.steps
  .filter((s) => s.sceneId === sceneId && s.kind === stepKind && (s.revisionId || null) === revisionId);

/**
 * Pure: what the run should do next, from the record and the queue alone:
 *   `cast-and-sets` — the board is empty and no Cast & Sets check-in exists:
 *                start one (it runs before the plan; see castAndSetsService.js);
 *   `plan`     — the board is empty: seed it (one planner call, first time only);
 *   `dispatch` — generate `kind` (frame|clip) for `sceneId`;
 *   `author-document` / `revise-document` — author the approved document or
 *                just the failed song sections, without changing its assets;
 *   `render-document` — encode the chosen document after continuous review;
 *   `review`   — every scene holds its media: hand the continuous excerpt
 *                `[startSec, endSec)` to an auto-review run;
 *   `wait`     — work in flight (generation jobs, or the review run);
 *   `halt`     — stop now with `status` + `reason`;
 *   `idle`     — not running, or pinned to another process (restart).
 */
export function nextProductionStep(project, run, { jobs = [], processId = null } = {}) {
  if (run.status !== 'running') return { type: 'idle' };
  if (!processId || run.processId !== processId) return { type: 'idle', interrupted: true };
  if (productionBasisRevision(project, run.basis.version || 1) !== run.basis.revision) {
    return { type: 'halt', status: 'needs-replan', reason: 'The creative setup changed since Start — review it, then resume against the new setup' };
  }
  if (run.authoring) {
    const assets = codeFirstProductionAssets(project);
    if (!assets || assets.conflicts.length) return { type: 'halt', status: 'needs-replan', reason: assets?.conflicts.join(' ') || 'The code-first policy changed' };
    if (run.documentCheckpoint && (run.documentCheckpoint.directory !== project.composition?.document?.directory
      || run.documentCheckpoint.scenesRevision !== canonicalSnapshotChecksum(project.scenes || []))) return { type: 'halt', status: 'needs-replan', reason: 'The selected document changed — review and resume against the new setup' };
  }
  if (run.reviewRunId) {
    const review = projectAutoReviews(project).find((r) => r.id === run.reviewRunId);
    if (!review) return { type: 'halt', status: 'needs-human', reason: 'The review run is gone — watch the draft yourself' };
    if (review.status === 'running') {
      const attempt = review.attempts?.[review.attempts.length - 1];
      if (run.authoring && attempt?.review?.verdict === 'revise') return { type: 'revise-document', reviewRunId: review.id, attemptN: attempt.n };
      return { type: 'wait', on: 'review' };
    }
    if (review.status === 'passed') {
      const evidence = review.attempts?.at(-1)?.review?.dependencies;
      if (musicVideoDependencyChanges(project, evidence).length) return { type: 'halt', status: 'needs-human', reason: 'The passing review has changed or unrecorded dependencies — rebuild and review the current draft' };
      if (!run.authoring) return { type: 'halt', status: 'completed', reason: null };
      if (run.documentCheckpoint?.directory !== project.composition?.document?.directory) return { type: 'halt', status: 'needs-replan', reason: 'The selected document changed after review — start a fresh run' };
      if (!run.finalRender) return { type: 'render-document' };
      if (run.finalRender.status === 'completed') return { type: 'halt', status: 'completed', reason: null };
      if (run.finalRender.status === 'failed') return { type: 'halt', status: 'blocked', reason: run.finalRender.error || 'The final document render failed — resume to retry' };
      return { type: 'wait', on: 'final-render' };
    }
    if (review.status === 'stopped' || review.status === 'limit-reached') {
      return { type: 'halt', status: review.status === 'limit-reached' ? 'limit-reached' : 'stopped', reason: `The review paused: ${review.stopReason || review.status}` };
    }
    return { type: 'halt', status: 'needs-human', reason: review.stopReason || `The review ended ${review.status}` };
  }
  const scenes = Array.isArray(project.scenes) ? project.scenes : [];
  if (!scenes.length) {
    if (run.planned) return { type: 'halt', status: 'blocked', reason: 'Planning produced no scenes — check the song analysis' };
    const gate = castAndSetsGate(project, run);
    if (gate) return gate;
    return { type: 'plan' };
  }
  const targets = productionTargets(project);
  if (run.authoring && targets.frame.some((scene) => scene.shotMode === 'performance')) {
    const gate = castAndSetsGate(project, run);
    if (gate) return { type: 'halt', status: 'blocked', reason: 'This selected performance shot needs the reviewed Cast & Sets references. Build and approve that check-in, then resume; production will not start an unbudgeted image batch.' };
  }
  let waiting = false;
  for (const stepKind of ['frame', 'clip']) {
    for (const scene of targets[stepKind]) {
      if (scene[SLOT[stepKind]]) continue;
      // A clip is generated from the scene's frame; wait for it.
      if (stepKind === 'clip' && !scene.referenceImageId) { waiting = true; continue; }
      const steps = slotSteps(run, scene.sceneId, stepKind);
      if (steps.some((s) => LIVE_STEP.has(s.status)) || liveSlotJob(jobs, project.id, scene.sceneId, stepKind)) { waiting = true; continue; }
      const refused = terminalRefusal(project, run, scene.sceneId, stepKind);
      if (refused) return { type: 'halt', status: 'blocked', reason: `"${scene.label || scene.sceneId}" has a terminal ${stepKind} refusal (${refused.errorCode}). Change its inputs or start a new run with another supported route; Resume will not repeat it.` };
      // A paid failure is not evidence that the same operation will work next
      // time. Pause before another charge; explicit Resume permits a transient retry.
      const failed = steps.find((s) => s.status === 'failed' && !(run.retryAcknowledged || []).includes(s.key));
      if (failed) return { type: 'halt', status: 'blocked', reason: `"${scene.label || scene.sceneId}" failed to generate its ${stepKind}. Inspect the failure and repair its inputs, or resume explicitly to retry.` };
      return { type: 'dispatch', kind: stepKind, sceneId: scene.sceneId };
    }
  }
  if (waiting) return { type: 'wait', on: 'generation' };
  if (run.authoring && !run.documentCheckpoint) return { type: 'author-document' };
  const spans = scenes.filter((s) => typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec);
  if (!spans.length) return { type: 'halt', status: 'blocked', reason: 'No scene is timed on the song, so there is no excerpt to review' };
  return {
    type: 'review',
    startSec: Math.min(...spans.map((s) => s.startSec)),
    endSec: Math.max(...spans.map((s) => s.endSec)),
  };
}

/**
 * The Cast & Sets check-in runs before the plan. Returns the step it needs,
 * or null once it is approved or skipped.
 */
function castAndSetsGate(project, run) {
  const stage = project?.castAndSets || null;
  if (castAndSetsSettled(stage)) return null;
  if (!stage) {
    return run.castAndSetsStarted
      ? { type: 'halt', status: 'blocked', reason: 'The Cast & Sets check-in did not start — start it from the Autopilot panel, or skip it' }
      : { type: 'cast-and-sets' };
  }
  if (stage.status === 'review') return { type: 'wait', on: 'checkin' };
  if (stage.status === 'failed') {
    return { type: 'halt', status: 'blocked', reason: `The Cast & Sets check-in failed: ${stage.stopReason || 'unknown error'} — resume or skip it, then resume the run` };
  }
  return { type: 'wait', on: 'cast-and-sets' };
}

// ---- dispatch accounting ------------------------------------------------------

/**
 * Reserve (and charge) one generation step BEFORE its job is enqueued. Throws
 * 409 when the run is not running in this process, the slot already has a
 * live step (a concurrent advance or a double submit), or a limit would be
 * exceeded — so a job past the budget is refused before it is paid for.
 * `costUsd` is the step's own estimate when the caller can price the scene
 * (a fal take); absent, the route's start-time price applies.
 * Returns `{ project, run, step }`.
 */
export function reserveProductionStep(project, runId, {
  kind, sceneId, revisionId = null, route, rationale = '', processId, costUsd: stepCostUsd = undefined, plateRepairBasis = null,
}, now = new Date().toISOString()) {
  let step = null;
  const out = mutateRun(project, runId, (run) => {
    if (run.status !== 'running') throw productionError(409, 'PRODUCTION_NOT_RUNNING', `This production run is ${run.status}`);
    if (run.processId !== processId) throw productionError(409, 'PRODUCTION_INTERRUPTED', 'The server restarted since this run was started — resume it first');
    assertProductionActive(project, runId, processId);
    const author = kind === 'author';
    const plate = kind === 'plate';
    const plateRoute = plate && route?.kind === 'plate' && (!run.reviewer?.providerId || route.mode === run.reviewer.providerId) && (!run.reviewer?.model || route.model === run.reviewer.model);
    const authorRoute = author && run.authoring && route?.kind === 'code' && route.mode === run.authoring.providerId && route.model === run.authoring.model;
    if (!(authorRoute || plateRoute || (!author && !plate && poolHasRoute(run, route)))) throw productionError(409, 'PRODUCTION_ROUTE_NOT_ALLOWED', `${route?.kind} ${route?.mode} is not in this run's allowed pool`);
    if (!author && run.authoring) {
      const medium = project.treatment?.shotDirections?.find((d) => d.sceneId === sceneId)?.medium;
      if ((kind === 'clip' && medium !== 'generated-footage') || (kind === 'frame' && !['still', 'generated-footage'].includes(medium))) throw productionError(409, 'PRODUCTION_MEDIUM_CONFLICT', 'This shot does not permit the requested generation');
    }
    if (terminalRefusal(project, run, sceneId, kind, route)) throw productionError(409, 'PRODUCTION_TERMINAL_REFUSAL', 'This route already refused these inputs; repair them or start a run with a supported route');
    const existing = slotSteps(run, sceneId, kind, revisionId);
    if (existing.some((s) => LIVE_STEP.has(s.status))) {
      throw productionError(409, 'PRODUCTION_STEP_IN_FLIGHT', 'This scene is already generating for the production run', { sceneId });
    }
    if (run.usage.generations >= run.limits.maxGenerations) {
      throw productionError(409, 'PRODUCTION_SPEND_LIMIT', `This production run reached its ${run.limits.maxGenerations}-generation limit`);
    }
    // A scene-specific estimate (a fal take priced by its own length and
    // resolution) wins over the route's flat start-time price.
    const price = stepCostUsd !== undefined ? stepCostUsd : run.pricing?.[routeKey(route)];
    const costUsd = typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : null;
    if (run.limits.spendCapUsd !== null) {
      if (costUsd === null) throw productionError(409, 'PRODUCTION_COST_UNKNOWN', 'This route has no known price, so the dollar cap cannot bound it');
      if (run.usage.spentUsd + costUsd > run.limits.spendCapUsd + 1e-9) {
        throw productionError(409, 'PRODUCTION_BUDGET_EXHAUSTED', `The next generation would exceed the $${run.limits.spendCapUsd} cap`);
      }
    }
    if (run.steps.length >= MAX_RUN_STEPS) throw productionError(409, 'PRODUCTION_STEP_LIMIT', 'This run recorded its maximum number of steps');
    const scene = (project.scenes || []).find((entry) => entry.sceneId === sceneId);
    step = {
      key: `${kind}:${sceneId}:${revisionId || 'base'}:${existing.length + 1}`,
      kind,
      sceneId,
      revisionId,
      route: { kind: route.kind, mode: route.mode, model: route.model || null },
      rationale: trimTo(rationale, MAX_ERROR_LEN) || '',
      costUsd,
      ...(['frame', 'clip'].includes(kind) ? { retryBasis: productionRetryBasis(project, sceneId, kind) } : {}),
      ...(kind === 'clip' && scene?.direction?.actionContract ? { plateAdmission: { assetId: scene.referenceImageId, basis: plateRequirementBasis(scene) } } : {}),
      ...(plateRepairBasis ? { plateRepairBasis } : {}),
      ...(run.authoring && !author ? { submissionBasis: productionSceneBasis(project, sceneId) } : {}),
      ...(run.authoring && kind === 'clip' ? { editInterval: (({ startSec, endSec }) => ({ startSec, endSec }))(project.scenes.find((scene) => scene.sceneId === sceneId)) } : {}),
      status: 'reserved',
      jobId: null,
      error: null,
      reservedAt: now,
      settledAt: null,
    };
    return {
      usage: { ...run.usage, generations: run.usage.generations + 1, spentUsd: run.usage.spentUsd + (costUsd || 0) },
      steps: [...run.steps, step],
    };
  }, now);
  return { ...out, step };
}

const refund = (run, step) => ({
  ...run.usage,
  generations: Math.max(0, run.usage.generations - 1),
  spentUsd: Math.max(0, run.usage.spentUsd - (step.costUsd || 0)),
});

/**
 * Settle a step. `queued` links its job; `completed`/`failed`/`canceled` end
 * it; `refused` ends a step whose submission never reached the queue and
 * refunds its charge. Idempotent: a step already in a terminal state is left
 * untouched (duplicate completion events), and only a reserved step can be
 * refused — a charge whose job reached the queue stays spent.
 * Returns `{ project, run, step, changed }`.
 */
export function settleProductionStep(project, runId, stepKey, { status, jobId = null, error = null, errorCode = null, retryBlocked = false }, now = new Date().toISOString()) {
  const run = findProductionRun(project, runId);
  const step = run.steps.find((s) => s.key === stepKey);
  if (!step) return { project, run, step: null, changed: false };
  const allowed = status === 'queued' ? step.status === 'reserved'
    : status === 'refused' ? step.status === 'reserved'
      : LIVE_STEP.has(step.status);
  if (!allowed) return { project, run, step, changed: false };
  const settled = {
    ...step,
    status,
    jobId: jobId || step.jobId,
    error: error ? trimTo(String(error), MAX_ERROR_LEN) : step.error,
    ...(errorCode ? { errorCode: trimTo(String(errorCode), 100) } : {}),
    ...(status === 'refused' && retryBlocked ? { retryBlocked: true } : {}),
    settledAt: status === 'queued' ? null : now,
  };
  const out = mutateRun(project, runId, (r) => ({
    steps: r.steps.map((s) => (s.key === stepKey ? settled : s)),
    ...(status === 'refused' ? { usage: refund(r, step) } : {}),
  }), now);
  return { ...out, step: settled, changed: true };
}

/** The step a media job belongs to (by its tag, then by job id). */
export function stepForJob(run, job) {
  const tag = job?.params?.musicVideo;
  return run.steps.find((s) => (tag?.productionStepKey && s.key === tag.productionStepKey) || (job?.id && s.jobId === job.id)) || null;
}

/**
 * Reconcile the run's live steps against the queue (resume, after a restart):
 * a step whose job is found adopts its state; a reserved step with no job
 * after the lease never reached the queue and is refunded. Returns
 * `{ project, run }`.
 */
export function reconcileProductionSteps(project, runId, jobs = [], nowMs = Date.now(), now = new Date(nowMs).toISOString()) {
  const run = findProductionRun(project, runId);
  let usage = run.usage;
  const steps = run.steps.map((step) => {
    if (!LIVE_STEP.has(step.status)) return step;
    // A direct provider call is not a queue job: after interruption its reserved
    // budget stays spent, and explicit Resume may retry with another charge.
    if (step.kind === 'author' || step.kind === 'plate') return { ...step, status: 'failed', error: 'Provider call interrupted — resume explicitly to retry', settledAt: now };
    const job = (jobs || []).find((j) => (step.jobId && j.id === step.jobId)
      || (j.params?.musicVideo?.productionRunId === runId && j.params.musicVideo.productionStepKey === step.key));
    if (job) {
      if (LIVE_JOB.has(job.status)) return { ...step, status: 'queued', jobId: job.id };
      if (job.status === 'completed') return { ...step, status: 'completed', jobId: job.id, settledAt: now };
      return { ...step, status: job.status === 'canceled' ? 'canceled' : 'failed', jobId: job.id, error: trimTo(String(job.error || job.status), MAX_ERROR_LEN), settledAt: now };
    }
    if (step.status === 'reserved' && nowMs - Date.parse(step.reservedAt) >= RESERVATION_LEASE_MS) {
      usage = refund({ usage }, step);
      return { ...step, status: 'refused', error: 'The submission never reached the queue', settledAt: now };
    }
    // A queued step whose job left the queue's history: the take (if any)
    // already landed; count it settled without guessing the outcome.
    if (step.status === 'queued') return { ...step, status: 'failed', error: 'The job is no longer in the queue history', settledAt: now };
    return step;
  });
  return mutateRun(project, runId, () => ({ steps, usage }), now);
}

// ---- lifecycle ---------------------------------------------------------------

/** Mark the Cast & Sets check-in as started by this run (so a failed start halts instead of looping). */
export const markProductionCastAndSets = (project, runId, now = new Date().toISOString()) =>
  mutateRun(project, runId, () => ({ castAndSetsStarted: true }), now);

/**
 * An approved (or skipped) Cast & Sets check-in writes the visual spec and
 * concept subjects a run's creative-setup checksum covers. A running run that
 * has not planned yet was waiting on exactly that change, so its basis is
 * re-captured in the same write instead of halting it `needs-replan`.
 * Returns `{ project }`.
 */
export function rebaseProductionAfterCheckin(project, now = new Date().toISOString()) {
  const runs = projectProductionRuns(project);
  if (!runs.some((r) => r.status === 'running' && !r.planned)) return { project };
  return {
    project: {
      ...project,
      productionRuns: runs.map((r) => (r.status === 'running' && !r.planned
        ? { ...r, basis: { ...r.basis, revision: productionBasisRevision(project, r.basis.version || 1), capturedAt: now }, updatedAt: now } : r)),
    },
  };
}

/** Mark the board as planned by this run (so an empty plan halts instead of looping). */
export const markProductionPlanned = (project, runId, now = new Date().toISOString()) =>
  mutateRun(project, runId, () => ({ planned: true }), now);

/** Link the auto-review run this production handed its draft to. */
export const attachProductionReview = (project, runId, reviewRunId, now = new Date().toISOString()) =>
  mutateRun(project, runId, () => ({ reviewRunId }), now);

/** Stop the run with a status/reason. */
export function haltProduction(project, runId, { status, reason = null, error = null }, now = new Date().toISOString()) {
  if (!PRODUCTION_STATUSES.includes(status) || status === 'running') throw new Error(`haltProduction: invalid status ${status}`);
  return mutateRun(project, runId, (run) => {
    if (!RESUMABLE.has(run.status)) throw productionError(409, 'PRODUCTION_CLOSED', `This production run is already ${run.status}`);
    return { status, stopReason: reason, error: error ? trimTo(String(error), MAX_ERROR_LEN) : null };
  }, now);
}

/** Director Stop: nothing new is dispatched; work in flight keeps its evidence. */
export function stopProductionOnProject(project, runId, now = new Date().toISOString()) {
  const run = findProductionRun(project, runId);
  if (!RESUMABLE.has(run.status)) throw productionError(409, 'PRODUCTION_CLOSED', `This production run is already ${run.status}`);
  return haltProduction(project, runId, { status: 'stopped', reason: 'Stopped by the director' }, now);
}

/**
 * Explicit resume: re-pins the run to this process. `limits` may only RAISE a
 * budget. A run halted on a changed creative setup continues only when the
 * director accepts the new basis (`acceptBasis`), which re-snapshots it.
 */
export function resumeProductionOnProject(project, runId, { limits, acceptBasis = false, processId } = {}, now = new Date().toISOString()) {
  return mutateRun(project, runId, (run) => {
    if (!RESUMABLE.has(run.status)) throw productionError(409, 'PRODUCTION_CLOSED', `This production run is ${run.status} — start a new run instead`);
    if (normalizeMusicVideoProductionPolicy(project?.productionPolicy).strategy === 'code-first' && !run.authoring) throw productionError(409, 'PRODUCTION_AUTHORING_REQUIRED', 'Cancel this legacy run and start a code-first run with an authoring model');
    const basisChanged = productionBasisRevision(project, run.basis.version || 1) !== run.basis.revision
      || (run.authoring && run.documentCheckpoint && (run.documentCheckpoint.directory !== project.composition?.document?.directory
        || run.documentCheckpoint.scenesRevision !== canonicalSnapshotChecksum(project.scenes || [])));
    if (basisChanged && !acceptBasis) {
      throw productionError(409, 'PRODUCTION_BASIS_CHANGED', 'The creative setup changed since Start — resume with the new setup accepted, or cancel');
    }
    const nextLimits = limits ? normalizeProductionLimits({ ...run.limits, ...limits }) : run.limits;
    const lowered = nextLimits.maxGenerations < run.limits.maxGenerations
      || nextLimits.maxReviewAttempts < run.limits.maxReviewAttempts
      || (run.limits.spendCapUsd !== null && (nextLimits.spendCapUsd === null ? false : nextLimits.spendCapUsd < run.limits.spendCapUsd));
    if (lowered) throw productionError(422, 'VALIDATION_ERROR', 'Resuming can only raise a limit, never lower it');
    if (run.limits.spendCapUsd === null && nextLimits.spendCapUsd !== null) {
      throw productionError(422, 'VALIDATION_ERROR', 'A dollar cap can only be set at Start');
    }
    return {
      status: 'running',
      limits: nextLimits,
      processId,
      resumedAt: now,
      retryAcknowledged: run.steps.filter((step) => step.status === 'failed').map((step) => step.key),
      stopReason: null,
      error: null,
      ...(run.finalRender?.status === 'failed' || (run.finalRender && run.processId !== processId) ? { finalRender: null } : {}),
      ...(basisChanged && run.authoring ? { documentCheckpoint: null, documentRevision: null, reviewRunId: null, finalRender: null } : {}),
      ...(basisChanged ? { basis: { ...run.basis, revision: productionBasisRevision(project, run.basis.version || 1), capturedAt: now } } : {}),
    };
  }, now);
}

/** Cancel (terminal). The caller cancels the run's queued jobs and review. */
export function cancelProductionOnProject(project, runId, now = new Date().toISOString()) {
  return haltProduction(project, runId, { status: 'canceled', reason: 'Cancelled by the director' }, now);
}

/** Generations still affordable before the limit. */
export const remainingProductionGenerations = (run) => Math.max(0, run.limits.maxGenerations - run.usage.generations);

/** Persist the exact authored/selected version, never a free-form model decision. */
export const attachProductionDocument = (project, runId, directory, now = new Date().toISOString()) =>
  mutateRun(project, runId, () => ({ documentCheckpoint: { directory, scenesRevision: canonicalSnapshotChecksum(project.scenes || []) } }), now);

/** Final render checkpoint; late link writes must preserve terminal evidence. */
export const setProductionRender = (project, runId, render, now = new Date().toISOString()) =>
  mutateRun(project, runId, (run) => ({ finalRender: run.finalRender && render.status !== 'reserved'
    && (render.attemptId !== run.finalRender.attemptId || (['completed', 'failed'].includes(run.finalRender.status) && render.status === 'queued'))
    ? run.finalRender : render }), now);

export const recordProductionDocumentRevision = (project, runId, checkpoint, now = new Date().toISOString()) =>
  mutateRun(project, runId, () => ({ documentRevision: checkpoint }), now);
