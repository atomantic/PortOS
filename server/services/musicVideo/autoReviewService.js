/**
 * Music Video — opt-in automatic review/retries (#8988): the orchestrator
 * over the pure checkpoint in autoReview.js and the evidence gate in
 * autoReviewJudge.js.
 *
 * `advanceAutoReview` derives the run's next step from the record and keeps
 * taking steps until the run has to wait: for a draft render, for generation
 * jobs, or for the director's board to submit the sections it hands out
 * (generation goes through the board's normal scene lanes, tagged with the
 * run's revision — the same path a manual #8987 revision uses, so every job
 * passes the enqueue-time spend check in `assertRevisionOpen`).
 *
 * What moves a run forward:
 *   - the director — start, resume (and the board submitting handed-out
 *     sections);
 *   - completion events of work THIS run put in flight: its draft render
 *     finishing (`excerpt-render`) or a take landing on one of its revised
 *     sections (`scene-image` / `scene-video`).
 * Nothing at boot advances a run, and a run that is not `running` ignores
 * every event — so no provider call is ever made without the director's
 * explicit, limited request. Advances for one run are coalesced in-process,
 * so an event arriving mid-step can never start a second review.
 */

import { unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir } from '../../lib/fileUtils.js';
import { execFile } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { findFfmpeg, findFfprobe, probeVideoStreamInfo, safeUnder } from '../../lib/ffmpeg.js';
import { isVisionCapableCliProvider } from '../../lib/localModelHeuristics.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';
import { startExcerptRender } from './excerptRender.js';
import { cancelRevision, resumeRevision } from './revisionService.js';
import { projectExcerpts } from './excerpt.js';
import { projectRevisions, releaseRevisionClaim, revisionSectionStates, startRevisionOnProject } from './revision.js';
import {
  attachAttemptExcerpt,
  attachAttemptRevision,
  beginAttemptReview,
  beginNextAttempt,
  cancelAutoReviewOnProject,
  haltAutoReview,
  nextAutoReviewStep,
  projectAutoReviews,
  recordAttemptReview,
  remainingGenerations,
  resumeAutoReviewOnProject,
  runAwaitingExcerpt,
  runOwningRevision,
  startAutoReviewOnProject,
  stopAutoReviewOnProject,
} from './autoReview.js';
import {
  SHEET_COLUMNS,
  SHEET_TILES,
  buildAutoReviewPrompt,
  planStripTimes,
  gateAutoReview,
  parseAutoReviewResponse,
  parseFreezeIntervals,
  parseStreamDurations,
  unplannedFreezes,
  FREEZE_MIN_SEC,
} from './autoReviewJudge.js';

const execFileAsync = promisify(execFile);
// A run takes at most this many steps per advance before yielding — a guard
// against a step that fails to change the record looping forever.
const MAX_STEPS_PER_ADVANCE = 16;
const REVIEW_TIMEOUT_MS = 240_000;

const advancing = new Map();

const short = (id) => String(id || '').slice(5, 13);

function findRun(project, runId) {
  const run = projectAutoReviews(project).find((r) => r.id === runId);
  if (!run) throw new ServerError('Auto-review run not found', { status: 404, code: 'NOT_FOUND' });
  return run;
}

async function requireProject(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

function publish(projectId, project, run, action) {
  musicVideoEvents.emit('auto-review', { projectId, runId: run.id, run, action, project });
}

async function halt(projectId, runId, { status, reason, error = null }) {
  const out = await mutateProjectRecord(projectId, (current) => haltAutoReview(current, runId, { status, reason, error }));
  const log = status === 'failed' ? console.error : console.warn;
  log(`${status === 'failed' ? '❌' : '⏸️'} Music Video auto-review ${short(runId)} ${status}: ${reason}`);
  return out;
}

// ---- continuous-excerpt analysis + reviewer call ---------------------------

/** Analyse the encoded excerpt end to end: A/V stream parity and footage freezes. */
async function analyzeContinuousExcerpt(excerptPath, spanSec, sections) {
  const [ffmpeg, ffprobe] = await Promise.all([findFfmpeg(), findFfprobe()]);
  if (!ffmpeg || !ffprobe) return { ok: false, error: 'ffmpeg/ffprobe not found' };
  const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', excerptPath],
    safeChildProcessOptions({ timeout: 15_000 }));
  const durations = parseStreamDurations(stdout);
  if (durations.video === null || durations.audio === null) return { ok: false, error: 'The draft is missing its video or audio stream' };
  const { stderr } = await execFileAsync(ffmpeg, ['-hide_banner', '-nostats', '-i', excerptPath, '-map', '0:v:0', '-vf', `freezedetect=n=-60dB:d=${FREEZE_MIN_SEC}`, '-f', 'null', '-'],
    safeChildProcessOptions({ timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }));
  return {
    ok: true,
    spanSec,
    avDriftSec: Math.round((durations.audio - durations.video) * 1000) / 1000,
    freezes: unplannedFreezes(parseFreezeIntervals(stderr, spanSec), sections),
  };
}

async function callReviewer(run, prompt, screenshots, projectId) {
  const { resolveProviderAndModel, runPromptThroughProvider, assertVisionRunUsedImages } = await import('../promptRunner.js');
  const { provider, selectedModel } = await resolveProviderAndModel(run.reviewer);
  if (!provider) throw new Error('No AI provider is configured');
  if (provider.enabled === false) throw new Error(`Provider "${provider.name || provider.id}" is disabled`);
  const used = { providerId: provider.id, model: selectedModel || null };
  let beforeExecute;
  if (run.documentRevisions && run.productionRunId) {
    const { assertProductionContinuation } = await import('./productionService.js');
    beforeExecute = () => assertProductionContinuation(projectId, run.productionRunId);
    await assertProductionContinuation(projectId, run.productionRunId);
  }
  if (provider.type !== 'api') {
    if (!isVisionCapableCliProvider(provider)) throw new Error(`Provider "${provider.name || provider.id}" cannot read images`);
    const { describeImagesFromPaths } = await import('../visionCli.js');
    const result = await describeImagesFromPaths({ provider, imagePaths: screenshots, prompt, model: selectedModel, timeout: provider.timeout || REVIEW_TIMEOUT_MS, ...(beforeExecute ? { beforeExecute } : {}) });
    return { text: result.text, used };
  }
  const result = await runPromptThroughProvider({
    provider, model: selectedModel, prompt, screenshots, source: 'music-video-auto-review', timeout: provider.timeout || REVIEW_TIMEOUT_MS,
    ...(beforeExecute ? { beforeExecute, allowFallback: false } : {}),
  });
  assertVisionRunUsedImages(result, provider);
  return { text: result.text, used: { ...used, model: result.model || used.model } };
}

// Tile the sampled times into 4x3 contact sheets. Returns the sheet files and
// the times actually captured (a failed sheet drops its own times, keeping
// tiles and the prompt's frameTimes aligned).
async function extractStripSheets(excerptPath, jobId, times) {
  const { encodeFileContactSheetAtTimes } = await import('../htmlComposition/encode.js');
  const info = await probeVideoStreamInfo(excerptPath).catch(() => ({}));
  const fps = info.fps > 0 ? info.fps : 24;
  await ensureDir(PATHS.videoThumbnails);
  const sheets = [];
  const captured = [];
  for (let i = 0; i * SHEET_TILES < times.length; i += 1) {
    const chunk = times.slice(i * SHEET_TILES, (i + 1) * SHEET_TILES);
    const out = join(PATHS.videoThumbnails, `${jobId}-s${i + 1}.jpg`);
    const ok = await encodeFileContactSheetAtTimes(excerptPath, out, chunk, { width: info.width, height: info.height, fps, columns: SHEET_COLUMNS })
      .then(() => true, () => false);
    if (ok && existsSync(out)) { sheets.push(out); captured.push(...chunk); }
  }
  return { sheets, captured };
}

/** Review one rendered draft. Never throws — a failed look is an inconclusive review. */
async function reviewDraft(project, run, excerpt) {
  const excerptPath = safeUnder(PATHS.videos, excerpt.filename || '');
  const spanSec = excerpt.endSec - excerpt.startSec;
  const sections = (excerpt.sections || []).map((s) => ({
    ...s, startSec: Math.max(0, s.startSec - excerpt.startSec), endSec: Math.min(spanSec, s.endSec - excerpt.startSec),
  }));
  if (!excerptPath || !existsSync(excerptPath)) {
    return gateAutoReview({ parsed: null, analysis: { ok: false, error: 'The draft file is missing' } });
  }
  const analysis = await analyzeContinuousExcerpt(excerptPath, spanSec, sections).catch((err) => ({ ok: false, error: err.message }));
  const attemptN = run.attempts.length;
  const sheet = excerpt.contactSheetFilename ? safeUnder(PATHS.videoThumbnails, excerpt.contactSheetFilename) : null;
  const hasSheet = !!sheet && existsSync(sheet);
  const planned = planStripTimes(spanSec, sections, { hasContactSheet: hasSheet });
  const { sheets: strip, captured: frameTimes } = await extractStripSheets(excerptPath, `mvar-${short(run.id)}-a${attemptN}`, planned).catch(() => ({ sheets: [], captured: [] }));
  const screenshots = [...(hasSheet ? [sheet] : []), ...strip];
  const evidence = { boundaryFrames: hasSheet ? 1 : 0, continuousFrames: frameTimes.length };

  let parsed = null;
  let reviewerError = null;
  let used = { providerId: run.reviewer.providerId, model: run.reviewer.model };
  if (screenshots.length) {
    const prompt = buildAutoReviewPrompt({ spanSec, sections, frameTimes, hasContactSheet: hasSheet, tiled: true, concept: project.concept });
    try {
      const reply = await callReviewer(run, prompt, screenshots, project.id);
      used = reply.used;
      parsed = parseAutoReviewResponse(reply.text);
      if (!parsed) reviewerError = 'The reviewer returned no usable verdict';
    } catch (err) {
      reviewerError = err.message;
      console.warn(`⚠️ Music Video auto-review ${short(run.id)} reviewer call failed: ${err.message}`);
    }
  } else {
    reviewerError = 'No frames could be extracted from the draft';
  }
  await Promise.all(strip.map((p) => unlink(p).catch(() => {})));
  const review = gateAutoReview({ parsed, analysis, evidence });
  return {
    ...review,
    reason: review.verdict === 'inconclusive' && reviewerError ? `${reviewerError} — watch this draft yourself` : review.reason,
    reviewer: used,
  };
}

// ---- the step loop ----------------------------------------------------------

async function takeSteps(projectId, runId) {
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i += 1) {
    const project = await requireProject(projectId);
    const run = findRun(project, runId);
    if (run.documentRevisions && run.productionRunId) {
      const { assertProductionContinuation } = await import('./productionService.js');
      const permitted = await assertProductionContinuation(projectId, run.productionRunId).then(() => true, () => false);
      if (!permitted) return { project, run, action: { type: 'idle', interrupted: true } };
    }
    const step = nextAutoReviewStep(project, run);

    if (step.type === 'idle' || step.type === 'wait') return { project, run, action: step };

    if (step.type === 'halt') {
      const out = await halt(projectId, runId, { status: step.status, reason: step.reason });
      return { ...out, action: { type: 'idle' } };
    }

    if (step.type === 'render') {
      // Draft renders are free; a refusal (another draft rendering, a shot
      // that doesn't cover its span…) pauses the run so the director can fix
      // it and resume, rather than failing the whole checkpoint.
      const render = await startExcerptRender(projectId, { startSec: run.startSec, endSec: run.endSec }).catch((err) => ({ error: err }));
      if (render.error) {
        const out = await halt(projectId, runId, { status: 'stopped', reason: `The draft could not render: ${render.error.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      await mutateProjectRecord(projectId, (current) => attachAttemptExcerpt(current, runId, render.excerptId));
      console.log(`🎬 Music Video auto-review ${short(runId)} attempt ${run.attempts.length}: rendering draft${step.retry ? ' (retry)' : ''}`);
      continue;
    }

    if (step.type === 'review') {
      const begun = await mutateProjectRecord(projectId, (current) => beginAttemptReview(current, runId));
      publish(projectId, begun.project, begun.run, { type: 'reviewing', excerptId: step.excerptId });
      const excerpt = projectExcerpts(project).find((e) => e.id === step.excerptId);
      const review = await reviewDraft(project, run, excerpt);
      const out = await mutateProjectRecord(projectId, (current) => recordAttemptReview(current, runId, review));
      const log = review.verdict === 'inconclusive' ? console.warn : console.log;
      log(`🔎 Music Video auto-review ${short(runId)} attempt ${run.attempts.length}: ${review.verdict} (${review.findings.length} finding${review.findings.length === 1 ? '' : 's'})`);
      if (out.run.status !== 'running') return { ...out, action: { type: 'idle' } };
      continue;
    }

    if (step.type === 'revise-document') return { project, run, action: { type: 'revise-document', excerptId: step.excerptId } };

    if (step.type === 'revise') {
      const opened = await mutateProjectRecord(projectId, (current) => {
        const started = startRevisionOnProject(current, step.excerptId);
        return { ...attachAttemptRevision(started.project, runId, started.revision.id), revision: started.revision };
      }).catch((err) => ({ error: err }));
      if (opened.error) {
        const out = await halt(projectId, runId, { status: 'needs-human', reason: `The findings could not be revised automatically: ${opened.error.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      console.log(`🎬 Music Video auto-review ${short(runId)} opened revision ${opened.revision.id.slice(4, 12)}`);
      continue;
    }

    if (step.type === 'resume-revision') {
      const { listJobs } = await import('../mediaJobQueue/index.js');
      const jobs = [...listJobs({ kind: 'video' }), ...listJobs({ kind: 'image' })];
      const revision = projectRevisions(project).find((r) => r.id === step.revisionId);
      const needed = revisionSectionStates(project, revision, jobs).filter((s) => s.state === 'needs-generation').length;
      // Spend check BEFORE anything is handed out: the enqueue guard refuses
      // each job past the limit too, but a run that can't afford the whole
      // revision stops here instead of generating half of it.
      if (needed > remainingGenerations(run)) {
        const out = await halt(projectId, runId, {
          status: 'limit-reached',
          reason: `The revision needs ${needed} generation${needed === 1 ? '' : 's'} but only ${remainingGenerations(run)} remain of the ${run.limits.maxGenerations}-generation spend limit`,
        });
        return { ...out, action: { type: 'idle' } };
      }
      const resumed = await resumeRevision(projectId, step.revisionId);
      if (resumed.render) continue;
      const fresh = await requireProject(projectId);
      const current = findRun(fresh, runId);
      // Paused or cancelled while the revision resumed: hand nothing out.
      if (current.status !== 'running') return { project: fresh, run: current, action: { type: 'idle' } };
      if (resumed.needsGeneration.length) {
        return { project: fresh, run: current, action: { type: 'generate', revisionId: step.revisionId, sections: resumed.needsGeneration } };
      }
      return { project: fresh, run: current, action: { type: 'wait', on: 'generation', revisionId: step.revisionId } };
    }

    if (step.type === 'next-attempt') {
      await mutateProjectRecord(projectId, (current) => beginNextAttempt(current, runId, step.excerptId));
      continue;
    }
    throw new Error(`Unknown auto-review step ${step.type}`);
  }
  const project = await requireProject(projectId);
  return { project, run: findRun(project, runId), action: { type: 'wait', on: 'step-budget' } };
}

/**
 * Advance a run as far as it can go right now. Concurrent calls for one run
 * coalesce onto the in-flight advance, which then takes one more pass.
 * Returns `{ project, run, action }`.
 */
function advanceAutoReview(projectId, runId) {
  armJobEndListener();
  const live = advancing.get(runId);
  if (live) {
    live.again = true;
    return live.promise;
  }
  const entry = { again: false, promise: null };
  entry.promise = (async () => {
    try {
      let result;
      do {
        entry.again = false;
        result = await takeSteps(projectId, runId);
      } while (entry.again);
      publish(projectId, result.project, result.run, result.action);
      return result;
    } finally {
      advancing.delete(runId);
    }
  })();
  advancing.set(runId, entry);
  return entry.promise;
}

// ---- director actions ----------------------------------------------------

// A review can take minutes, so the director's request returns as soon as the
// checkpoint is written; the advance continues in the background and reports
// over the `auto-review` event.
function advanceInBackground(projectId, runId) {
  advanceAutoReview(projectId, runId).catch(async (err) => {
    console.error(`❌ Music Video auto-review ${short(runId)} step failed: ${err.message}`);
    await halt(projectId, runId, { status: 'stopped', reason: `A step failed: ${err.message}`, error: err.message })
      .then((out) => publish(projectId, out.project, out.run, { type: 'idle' }))
      .catch(() => {});
  });
}

/** Start a run (explicit director request with limits). Returns `{ project, run }`. */
export async function startAutoReview(projectId, input) {
  const out = await mutateProjectRecord(projectId, (current) => startAutoReviewOnProject(current, input));
  console.log(`🎬 Music Video auto-review ${short(out.run.id)} started: [${out.run.startSec}, ${out.run.endSec}]s, ≤${out.run.limits.maxAttempts} reviews, ≤${out.run.limits.maxGenerations} generations`);
  advanceInBackground(projectId, out.run.id);
  return out;
}

/** Resume a stopped/limit-reached run (optionally raising its limits), or re-kick a running one. Returns `{ project, run }`. */
export async function resumeAutoReview(projectId, runId, { limits } = {}) {
  const out = await mutateProjectRecord(projectId, (current) => resumeAutoReviewOnProject(current, runId, { limits }));
  advanceInBackground(projectId, runId);
  return out;
}

/** Pause a run: nothing new is handed out; work already in flight lands on the checkpoint. */
export async function stopAutoReview(projectId, runId) {
  const out = await mutateProjectRecord(projectId, (current) => stopAutoReviewOnProject(current, runId));
  publish(projectId, out.project, out.run, { type: 'idle' });
  return out;
}

/**
 * Cancel a run, and the revision it has open (which stops its generation
 * jobs) — both in one write, so the revision is never left open without its
 * run guarding the spend.
 */
export async function cancelAutoReview(projectId, runId) {
  const before = await requireProject(projectId);
  const { revisionId } = cancelAutoReviewOnProject(before, runId); // validates; the real write is below
  const cancelRun = (p) => cancelAutoReviewOnProject(p, runId).project;
  const withRevision = revisionId
    ? await cancelRevision(projectId, revisionId, { alsoOnProject: cancelRun }).then(() => true, (err) => {
      if (err?.code !== 'REVISION_CLOSED') throw err;
      return false; // the revision closed meanwhile — cancel the run alone
    })
    : false;
  if (!withRevision) await mutateProjectRecord(projectId, (current) => ({ project: cancelRun(current) }));
  const project = await requireProject(projectId);
  const run = findRun(project, runId);
  publish(projectId, project, run, { type: 'idle' });
  return { project, run };
}

// ---- completion events of work a run put in flight ------------------------

// A revised section's generation job that FAILS (or is cancelled by hand)
// pauses its run rather than retrying on its own — a retry is more paid work,
// so it waits for the director's Resume, which hands the section out again.
// Armed on a run's first advance (never at boot); the queue module is deferred
// because only this path needs it.
let jobEndListenerArmed = false;
function armJobEndListener() {
  if (jobEndListenerArmed) return;
  jobEndListenerArmed = true;
  import('../mediaJobQueue/index.js').then(({ mediaJobEvents }) => {
    const onJobEnded = (job) => {
      const tag = job?.params?.musicVideo;
      if (!tag?.projectId || !tag.revisionId || !tag.sceneId) return;
      pauseOnEndedGeneration(tag, job).catch((err) => {
        console.error(`❌ Music Video auto-review could not pause after a ${job.status} generation: ${err.message}`);
      });
    };
    mediaJobEvents.on('failed', onJobEnded);
    mediaJobEvents.on('canceled', onJobEnded);
  }).catch((err) => {
    jobEndListenerArmed = false;
    console.error(`❌ Music Video auto-review could not watch generation jobs: ${err.message}`);
  });
}

async function pauseOnEndedGeneration(tag, job) {
  const project = await getProject(tag.projectId);
  if (!project || !runOwningRevision(project, tag.revisionId)) return;
  const out = await mutateProjectRecord(tag.projectId, (current) => {
    const run = runOwningRevision(current, tag.revisionId);
    if (!run) return { project: current, run: null };
    const released = releaseRevisionClaim(current, tag.revisionId, tag.sceneId);
    const detail = job.error ? `: ${String(job.error).slice(0, 200)}` : '';
    return haltAutoReview(released.project, run.id, { status: 'stopped', reason: `A revised section's generation ${job.status}${detail} — resume to try it again` });
  });
  if (!out.run) return;
  console.warn(`⏸️ Music Video auto-review ${short(out.run.id)} paused: a revised section's generation ${job.status}`);
  publish(tag.projectId, out.project, out.run, { type: 'idle' });
}

function continueFromEvent(projectId, pickRun, label) {
  getProject(projectId)
    .then((project) => {
      const run = project ? pickRun(project) : null;
      return run ? advanceAutoReview(projectId, run.id) : null;
    })
    .catch((err) => console.error(`❌ Music Video auto-review could not continue after ${label}: ${err.message}`));
}

musicVideoEvents.on('excerpt-render', ({ projectId, excerptId } = {}) => {
  if (projectId && excerptId) continueFromEvent(projectId, (project) => runAwaitingExcerpt(project, excerptId), 'a draft render');
});

const onSceneTake = ({ projectId, sceneId } = {}) => {
  if (!projectId || !sceneId) return;
  continueFromEvent(projectId, (project) => {
    const revisions = projectRevisions(project);
    return projectAutoReviews(project).find((run) => {
      if (run.status !== 'running') return false;
      const { revisionId } = run.attempts[run.attempts.length - 1];
      const revision = revisions.find((r) => r.id === revisionId && r.status === 'open');
      return !!revision?.sections?.some((s) => s.sceneId === sceneId && s.verdict === 'rejected');
    }) || null;
  }, 'a revised take landed');
};
musicVideoEvents.on('scene-image', onSceneTake);
musicVideoEvents.on('scene-video', onSceneTake);
