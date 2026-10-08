import { musicVideoMediaMode, musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';
import { prepareProductionReview } from './productionReviewService.js';
import { ALIGNMENT_UNVERIFIED_PROBLEM, assertProductionApproval, productionAlignmentBasis, productionReadiness, productionReviewBasis } from './productionReview.js';
import { CAST_SETS_WORKING } from './castAndSets.js';

/**
 * Fully-autonomous Music Video — the run orchestrator.
 *
 * One prompt drives a whole video: creative brief → lyrics → mood board & style
 * → Suno song (PortOS Browser) → beat analysis → the existing production run
 * (image/video tools) or a code-rendered video. The vocabulary, brief shape and
 * Suno field limits live in `lib/musicVideoAutonomous.js`.
 *
 * The run is an install-local checkpoint on the project (`project.autonomousRun`,
 * wire-local like `productionRuns`: it names this install's providers and the
 * peer must never execute it). Each stage settles in one serialized project
 * write, so a crash resumes at the stage that did not settle; a stage's output
 * is stored before the next one reads it. `processId` pins a running run to the
 * server process that started it — after a restart nothing advances until the
 * operator (or the scheduled task) explicitly resumes (AI Provider Usage
 * Policy: no cold-bootstrap work).
 *
 * Checkpoints are optional approval gates after `lyrics` / `style` / `song`:
 * the run parks `awaiting-approval` and continues on approve; at the song
 * checkpoint the director may instead retake the song (`retakeSong`), which
 * discards it and generates a new one before parking there again. A signed-out
 * Suno parks `needs-human`; any other failure parks `failed`. Both resume at the
 * stage that stopped, reusing Suno songs already submitted. A brief may instead
 * (or as a fallback, `localFallback`) make the song with the on-device Music
 * Designer engines (`autonomousLocalSong.js`), so a run finishes with Suno
 * unavailable.
 *
 * Production is delegated: `produce` starts the server-owned production run (or
 * the code render) and finishes when that reports back over the `production`
 * event. A code-first production run renders the film itself; when that render
 * is still the project's current final video the run adopts it instead of
 * rendering the same document again (#10563). Either way `produce` stays
 * running ("Rendering final video") until the final render job settles over
 * the `render` event: success completes the run, failure parks it `failed` and
 * Retry re-renders only. A run interrupted while rendering re-checks
 * `renderHistoryId` on resume (reattach, finish, or render again). Only
 * explicit start/resume requests begin work.
 *
 * Production review (art → storyboard → proof) parks `produce` until approved.
 * An authenticated start/resume can grant `brief.autoApprove` for planning;
 * the route binds the grant to a session and each automatic decision to this run.
 * Proof always requires recorded playback or machine review evidence. Older
 * briefs granting proof auto-approval still wait for rendering, then park for review.
 *
 * An ORCHESTRATED run (`brief.orchestrator`) replaces the director at every
 * review point instead: the orchestrator model judges the lyrics, the sound and
 * look, the song, the art direction, the lyric timing, the storyboard and the
 * final video, and either approves each or revises it and judges again
 * (bounded by `limits.maxReviewAttempts`, then the last version is accepted).
 * Every decision lands in `run.orchestration.reviews`. It is approval
 * authority, so like `autoApprove` it is granted only to a signed-in session.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';
import { trimTo } from '../../lib/textUtils.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { IMAGE_GEN_MODE } from '../../lib/generationModes.js';
import { assertFootageVideoModelsCapable, loadPoolEnv } from './productionPool.js';
import { PRODUCTION_RESUMABLE_STATUSES } from './production.js';
import {
  AUTONOMOUS_DEFAULT_LIMITS,
  AUTONOMOUS_LIVE_STATUSES,
  AUTONOMOUS_STAGE_IDS,
  autonomousLyricsReviewEnabled,
  autonomousMedium,
  autonomousPool,
  isOrchestratedRun,
  nextAutonomousStage,
  ORCHESTRATOR_REVIEW_LOG_MAX,
  normalizeAutoApprove,
  normalizeAutonomousBrief,
  normalizeLocalMusicOptions,
  normalizeSunoOptions,
  sunoSongFields,
} from '../../lib/musicVideoAutonomous.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';
import { musicVideoDependencyChanges } from '../../lib/musicVideoDependencies.js';

const PROCESS_ID = `proc-${randomUUID()}`;
const inflight = new Map();
const sunoControllers = new Map();
const short = (id) => String(id).slice(0, 8);

// Lazy imports keep this module's static closure small: it is reached by the
// route table and the scheduled handler, and each dependency below pulls a
// whole subtree (LLM runner, mood board store, browser driver, production).
const defaults = {
  createProject: async (input) => (await import('./projects.js')).createProject(input),
  updateProject: async (id, patch) => (await import('./projects.js')).updateProject(id, patch),
  resolveLlm: async (pin) => (await import('./llmRoute.js')).resolveMusicVideoLlm(pin),
  recordRoute: async (projectId, stage, route) => (await import('./llmRoute.js')).recordLlmRoute(projectId, stage, route),
  draftCreativeBrief: async (args) => (await import('./autonomousBrief.js')).draftCreativeBrief(args),
  writeLyrics: async (args) => (await import('../musicDesigner.js')).writeLyrics(args),
  reviewLyrics: async (args) => (await import('../musicDesigner.js')).reviewLyrics(args),
  createMoodBoard: async (spec, opts) => (await import('./autonomousBoard.js')).createAutonomousMoodBoard(spec, opts),
  generateSunoSong: async (fields, opts) => (await import('./autonomousSuno.js')).generateSunoSong(fields, opts),
  generateLocalSong: async (args) => (await import('./autonomousLocalSong.js')).generateLocalSong(args),
  cancelLocalSong: async (jobId) => (await import('../mediaJobQueue/index.js')).cancelJob(jobId),
  createTrack: async (input) => (await import('../trackAlbumMembership.js')).createTrackWithAlbum(input).then((r) => r.track),
  attachAudio: async (trackId, filename, take) => (await import('../trackAudioAttach.js')).attachAudioAsRender(trackId, filename, take),
  probeDuration: (filename) => probeVideoDuration(join(PATHS.music, filename)).catch(() => null),
  analyzeSong: async (projectId) => (await import('./projectAudio.js')).analyzeProjectSong(projectId),
  designCoverArt: async (projectId, input) => (await import('./coverArt.js')).designCoverArt(projectId, input),
  startProduction: async (...args) => (await import('./productionService.js')).startProduction(...args),
  resumeProduction: async (...args) => (await import('./productionService.js')).resumeProduction(...args),
  stopProduction: async (...args) => (await import('./productionService.js')).stopProduction(...args),
  cancelProduction: async (...args) => (await import('./productionService.js')).cancelProduction(...args),
  generateDocument: async (...args) => (await import('./documentGeneration.js')).generateMixedMediaDocument(...args),
  acceptDocument: async (...args) => (await import('./documentGeneration.js')).acceptMixedMediaDocument(...args),
  generateCode: async (...args) => (await import('./codeGeneration.js')).generateMusicVideoCode(...args),
  renderVideo: async (...args) => (await import('./render.js')).renderMusicVideo(...args),
  activeRenderJobId: async (projectId) => (await import('./render.js')).getActiveRenderJobId(projectId),
  cancelRender: async (jobId) => (await import('./render.js')).cancelRender(jobId),
  // An interrupted (previous process) Cast & Sets stage re-pins to this one; true when it did.
  resumeInterruptedCastAndSets: async (project) => {
    const { presentProjectCastAndSets, resumeCastAndSets } = await import('./castAndSetsService.js');
    if (!presentProjectCastAndSets(project).castAndSets?.interrupted) return false;
    await resumeCastAndSets(project.id);
    return true;
  },
  // The review persistence path; session authority was checked on start/resume.
  approveProductionReview: async (...args) => (await import('./productionReviewService.js')).approveProductionReview(...args),
  // Orchestrated mode: the reviewer call, and the edits a reviewer makes by hand.
  orchestrate: async (args) => (await import('./orchestratorReview.js')).askOrchestrator(args),
  alignLyrics: async (projectId) => (await import('./lyricAlign.js')).alignProjectLyrics(projectId),
  verifyAlignment: async (...args) => (await import('./productionReviewService.js')).reverifyProductionAlignment(...args),
  addFeedback: async (...args) => (await import('./productionReviewService.js')).addProductionFeedback(...args),
  closeFeedback: async (...args) => (await import('./productionReviewService.js')).closeProductionFeedback(...args),
  reviseFromFeedback: async (...args) => (await import('./productionReviewService.js')).reviseProductionFromFeedback(...args),
  guideImagePath: async (artifact) => (await import('./devArtifactStore.js')).resolveDevArtifactFile(artifact.file),
  finalReviewFrames: async (jobId) => (await import('./orchestratorReview.js')).captureFinalReviewFrames(jobId),
  // The final-video revision of footage: a board-owned auto-review over the flagged window.
  startAutoReview: async (...args) => (await import('./autoReviewService.js')).startAutoReview(...args),
  cancelAutoReview: async (...args) => (await import('./autoReviewService.js')).cancelAutoReview(...args),
  stopAutoReview: async (...args) => (await import('./autoReviewService.js')).stopAutoReview(...args),
  resumeAutoReview: async (...args) => (await import('./autoReviewService.js')).resumeAutoReview(...args),
  wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};
let deps = { ...defaults };
export function __setAutonomousDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }

const runError = (status, code, message, context) =>
  new ServerError(message, { status, code, ...(context ? { context } : {}) });

const projectAutonomousRun = (project) => project?.autonomousRun || null;

async function requireRun(projectId) {
  const project = await getProject(projectId);
  if (!project) throw runError(404, 'NOT_FOUND', 'Project not found');
  const run = projectAutonomousRun(project);
  if (!run) throw runError(404, 'NO_AUTONOMOUS_RUN', 'This project has no autonomous run');
  return { project, run };
}

/** The run as the client sees it: `interrupted` when it was pinned to a previous server process. */
export const presentAutonomousRun = (run) => (run
  ? { ...run, interrupted: run.status === 'running' && run.processId !== PROCESS_ID }
  : null);

/** `presentAutonomousRun` for a project read; reader-only — never persist the result. */
export const presentProjectAutonomousRun = (project) => (project?.autonomousRun
  ? { ...project, autonomousRun: presentAutonomousRun(project.autonomousRun) }
  : project);

/** Test seam: this process's pin id. */
export const __autonomousProcessId = () => PROCESS_ID;

function publish(project, run) {
  musicVideoEvents.emit('autonomous', { projectId: project.id, runId: run.id, run: presentAutonomousRun(run), project: { ...project, autonomousRun: presentAutonomousRun(run) } });
}

/** One serialized write of the run record; `fn` returns the patch to merge. */
async function patchRun(projectId, fn) {
  const now = new Date().toISOString();
  const out = await mutateProjectRecord(projectId, (current) => {
    const run = projectAutonomousRun(current);
    if (!run) throw runError(404, 'NO_AUTONOMOUS_RUN', 'This project has no autonomous run');
    const patch = fn(run, current) || {};
    const next = {
      ...run,
      ...patch,
      stages: { ...run.stages, ...(patch.stages || {}) },
      output: { ...run.output, ...(patch.output || {}) },
      updatedAt: now,
    };
    return { project: { ...current, autonomousRun: next }, run: next };
  });
  publish(out.project, out.run);
  return out;
}

const stagePatch = (run, stage, patch) => ({ stages: { [stage]: { ...run.stages[stage], ...patch } } });

// ---- production review auto-approval (brief.autoApprove) --------------------------

const RENDER_STEP = 'rendering';
const CAST_STEP = 'cast-and-sets';
const autoApproves = (run, stage) => normalizeAutoApprove(run.brief.autoApprove).includes(stage);

/**
 * The brief fields for an auto-approve request: none when it lists no stage,
 * else the stages plus when the operator granted them. A non-empty list the
 * route did not authorize (authenticated session) is refused.
 */
function autoApproveGrant(list, authorized) {
  const autoApprove = normalizeAutoApprove(list);
  if (!autoApprove.length) return { autoApprove: [], autoApproveAuthorizedAt: null, autoApproveAuthorizedBy: null };
  if (!authorized) throw runError(403, 'AUTH_REQUIRED', 'Sign in to grant automatic planning approvals.');
  return { autoApprove, autoApproveAuthorizedAt: new Date().toISOString(),
    ...(typeof authorized === 'object' ? { autoApproveAuthorizedBy: structuredClone(authorized) } : {}) };
}

/**
 * The orchestrator approves Production review stages and verifies lyric timing
 * on the operator's behalf, so — like an auto-approve grant — only an
 * authenticated session may start an orchestrated run, and the grant records who.
 */
function orchestratorGrant(authorized) {
  if (!authorized) throw runError(403, 'AUTH_REQUIRED', 'Sign in to start an orchestrated run: the orchestrator approves stages for you.');
  return { orchestratorAuthorizedAt: new Date().toISOString(),
    orchestratorAuthorizedBy: typeof authorized === 'object' ? structuredClone(authorized) : null };
}

/** Approve `stage` for the run when the brief allows it and its readiness is clean; returns the fresh project. */
async function autoApproveStage(project, run, stage) {
  if (!autoApproves(run, stage)) return project;
  const readiness = productionReadiness(project);
  if (readiness[stage].approved || readiness[stage].problems.length) return project;
  await deps.approveProductionReview(project.id, { stage, basis: readiness.basis[stage], approvedBy: 'autopilot',
    reviewer: { kind: 'autopilot', runId: run.id, authorizedBy: run.brief.autoApproveAuthorizedBy || null } });
  console.log(`🤖 Autonomous music video ${short(run.id)} auto-approved ${stage} (brief.autoApprove)`);
  return getProject(project.id);
}

// ---- orchestrated mode (brief.orchestrator) --------------------------------------
// The orchestrator stands in for the director at each review point. A review is
// one provider call; a revision is applied and judged again until it approves or
// `limits.maxReviewAttempts` revisions of that checkpoint are spent — then the
// last version is accepted and the log says so. Revisions are counted from the
// persisted log, so a retried stage cannot buy itself a fresh allowance.

const reviewLimit = (run) => run.brief.limits?.maxReviewAttempts || AUTONOMOUS_DEFAULT_LIMITS.maxReviewAttempts;
const latestRun = async (projectId) => projectAutonomousRun(await getProject(projectId));
const revisionsSpent = (run, checkpoint) => (run?.orchestration?.reviews || [])
  .filter((r) => r.checkpoint === checkpoint && (r.verdict === 'revise' || r.verdict === 'retake')).length;
const reviewModule = () => import('./orchestratorReview.js');
const ideaOf = (run) => ({ prompt: run.brief.prompt, guidance: run.brief.guidance || '' });
const orchestratorIdentity = (run, route) => ({ kind: 'orchestrator', runId: run.id,
  providerId: route?.providerId || run.brief.orchestrator.providerId, model: route?.model || run.brief.orchestrator.model || null,
  authorizedBy: run.brief.orchestratorAuthorizedBy || null });

/**
 * Append one decision to the run's review log (oldest dropped past the cap).
 * `output` lands in the same write, so a revision is never logged without the
 * revised value a retry resumes from.
 */
async function recordReview(projectId, entry, output) {
  const at = new Date().toISOString();
  const { run } = await patchRun(projectId, (r) => ({ ...(output ? { output } : {}), orchestration: { ...r.orchestration,
    reviews: [...(r.orchestration?.reviews || []), { id: randomUUID(), at, ...entry }].slice(-ORCHESTRATOR_REVIEW_LOG_MAX) } }));
  console.log(`🎬 Autonomous music video ${short(run.id)} orchestrator ${entry.verdict} ${entry.checkpoint}${entry.score ? ` (${entry.score}/10)` : ''}`);
  return run;
}

/** One review call, parsed. `images` ride along when the orchestrator can see them. */
async function askReview(run, checkpoint, prompt, images = []) {
  const { parseOrchestratorVerdict } = await reviewModule();
  const reply = await deps.orchestrate({ orchestrator: run.brief.orchestrator, prompt, images, source: 'music-video-orchestrator-review' });
  return { ...parseOrchestratorVerdict(reply.text, checkpoint), route: reply.route || null, visual: reply.visual === true };
}

const reviewEntry = (checkpoint, review, overrides = {}) => ({
  checkpoint, verdict: review.verdict, score: review.score ?? null, notes: review.notes || '',
  route: review.route || null, visual: review.visual === true, ...overrides,
});

/**
 * Review a text checkpoint until it is approved: `apply(review)` returns the
 * revised value, or null when the review carried nothing to apply. `persist(value)`
 * names the run output that holds the value under review, written with each
 * revision so a retry judges the latest one. Returns the accepted value.
 */
async function reviewUntilApproved(projectId, run, checkpoint, { value, prompt, apply, persist }) {
  let current = value;
  for (;;) {
    const review = await askReview(run, checkpoint, prompt(current));
    const revised = review.verdict === 'revise' ? apply(review, current) : null;
    if (revised !== null && revisionsSpent(await latestRun(projectId), checkpoint) < reviewLimit(run)) {
      await recordReview(projectId, reviewEntry(checkpoint, review, { verdict: 'revise' }), persist(revised));
      current = revised;
      continue;
    }
    const why = review.verdict !== 'revise' ? '' : revised === null ? 'No revision was supplied; accepted as is. ' : 'Revision limit reached; accepted the latest version. ';
    await recordReview(projectId, reviewEntry(checkpoint, review, { verdict: 'approve', notes: `${why}${review.notes || ''}`.trim() }));
    return current;
  }
}

async function orchestrateLyrics(projectId, run, lyrics) {
  const { buildLyricsReviewPrompt } = await reviewModule();
  return reviewUntilApproved(projectId, run, 'lyrics', {
    value: lyrics,
    prompt: (current) => buildLyricsReviewPrompt({ ...ideaOf(run), title: run.output.title, description: run.output.musicalDescription, lyrics: current }),
    apply: (review) => review.lyrics || null,
    persist: (revised) => ({ lyricsForReview: revised }),
  });
}

/** The sound & look, judged before the song is made and the mood board created from it. */
async function orchestrateStyle(projectId, run) {
  const { buildStyleReviewPrompt } = await reviewModule();
  // A retried review resumes from the last revision rather than the first draft.
  const value = run.output.styleDraft || { sunoStyle: run.output.sunoStyle, concept: run.output.concept || {}, moodBoard: run.output.moodBoard || {} };
  return reviewUntilApproved(projectId, run, 'style', {
    value,
    prompt: (current) => buildStyleReviewPrompt({ ...ideaOf(run), title: run.output.title, description: run.output.musicalDescription, ...current }),
    apply: (review, current) => (review.sunoStyle || review.conceptStyle || review.lookPrompt ? {
      sunoStyle: review.sunoStyle || current.sunoStyle,
      concept: { ...current.concept, ...(review.conceptStyle ? { style: review.conceptStyle } : {}) },
      moodBoard: { ...current.moodBoard, ...(review.lookPrompt ? { stylePrompt: review.lookPrompt } : {}) },
    } : null),
    persist: (revised) => ({ styleDraft: revised }),
  });
}

const cueText = (cue) => (typeof cue?.text === 'string' ? cue.text.trim() : '');
const validSpan = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end > start;
const MIN_WORD_SEC = 0.05;
// Below this share of recognizer-heard words the timings are mostly interpolated
// (the aligner itself discards a line below the same share).
const MIN_HEARD_WORD_SHARE = 0.5;

/**
 * Give a lyric line with no usable word timings evenly spaced words inside its
 * own span, else a share of the gap its neighbours leave — what a director does
 * by hand after alignment skips a line. Consecutive skipped lines split that gap
 * by word count rather than each taking all of it. Returns the repaired cues
 * and the line count.
 */
function repairLyricWordTimings(cues, durationSec) {
  const wordsOf = cues.map((cue) => cueText(cue).split(/\s+/).filter(Boolean));
  const usable = (cue) => Array.isArray(cue.words) && cue.words.length > 0 && cue.words.every((w) => validSpan(w.startSec, w.endSec))
    && validSpan(cue.startSec, cue.endSec) && cue.words.every((w) => w.startSec >= cue.startSec && w.endSec <= cue.endSec);
  const ownSpan = (cue) => validSpan(cue.startSec, cue.endSec) && cue.endSec <= durationSec;
  const needs = cues.map((cue, i) => wordsOf[i].length > 0 && !usable(cue));
  const spans = cues.map(() => null);
  for (let i = 0; i < cues.length; i += 1) {
    if (!needs[i]) continue;
    if (ownSpan(cues[i])) { spans[i] = [cues[i].startSec, cues[i].endSec]; continue; }
    let last = i;
    while (last + 1 < cues.length && needs[last + 1] && !ownSpan(cues[last + 1])) last += 1;
    const prevEnd = i > 0 && Number.isFinite(cues[i - 1].endSec) ? cues[i - 1].endSec : 0;
    const nextStart = last < cues.length - 1 && Number.isFinite(cues[last + 1].startSec) ? cues[last + 1].startSec : durationSec;
    const total = wordsOf.slice(i, last + 1).reduce((sum, words) => sum + words.length, 0);
    let at = prevEnd;
    for (let k = i; k <= last; k += 1) {
      const end = k === last ? nextStart : at + ((nextStart - prevEnd) * wordsOf[k].length) / total;
      spans[k] = [at, end];
      at = end;
    }
    i = last;
  }
  let repaired = 0;
  const round = (n) => Math.round(n * 1000) / 1000;
  const out = cues.map((cue, i) => {
    if (!spans[i]) return cue;
    const words = wordsOf[i];
    const [start, end] = spans[i];
    if (!validSpan(start, end) || (end - start) / words.length < MIN_WORD_SEC) return cue;
    const step = (end - start) / words.length;
    repaired += 1;
    return { ...cue, startSec: round(start), endSec: round(end),
      words: words.map((w, k) => ({ w, startSec: round(start + k * step), endSec: round(k === words.length - 1 ? end : start + (k + 1) * step), conf: 'interpolated' })) };
  });
  return { cues: out, repaired };
}

/**
 * Align the vocal to the lyric sheet and time the lines alignment skipped —
 * the timings the storyboard gate needs. Returns the alignment error, if any,
 * and keeps it on the run (`output.alignmentError`) so the storyboard gate
 * will not verify guessed timings; the repair still runs so a failed
 * alignment leaves what it can.
 */
async function alignRunLyrics(projectId, run) {
  if (run.brief.instrumental || !(await getProject(projectId))?.lyricCues?.some((c) => cueText(c))) return null;
  let alignError = null;
  await deps.alignLyrics(projectId).catch((err) => { alignError = err.message; });
  await mutateProjectRecord(projectId, (current) => {
    const { cues, repaired } = repairLyricWordTimings(current.lyricCues || [], current.audioAnalysis?.durationSec);
    return { project: repaired ? { ...current, lyricCues: cues } : current };
  });
  // Bound to the timings it left, so a later re-alignment by hand is judged on its own.
  const basis = alignError ? productionAlignmentBasis(await getProject(projectId)) : null;
  await patchRun(projectId, () => ({ output: { alignmentError: alignError ? { message: trimTo(alignError, 300), basis } : null } }));
  return alignError;
}

/** The song as measurements: analysis plus how much of the written lyric the recognizer heard. */
function songFacts(project, run, alignError) {
  const analysis = project.audioAnalysis || {};
  const cues = (project.lyricCues || []).filter((c) => cueText(c));
  const words = cues.flatMap((c) => c.words || []);
  return {
    instrumental: run.brief.instrumental === true,
    songSource: run.output.songSource || run.brief.songSource,
    durationSec: Number.isFinite(analysis.durationSec) ? Math.round(analysis.durationSec * 10) / 10 : null,
    tempoBpm: Number.isFinite(analysis.bpm) ? Math.round(analysis.bpm) : Number.isFinite(analysis.tempo) ? Math.round(analysis.tempo) : null,
    sections: (analysis.sections || []).slice(0, 24).map((s) => s.label || s.type || 'section'),
    ...(run.brief.instrumental ? {} : {
      lyricLines: cues.length,
      linesWithWordTimings: cues.filter((c) => c.words?.length).length,
      lyricWords: words.length,
      recognizedWordShare: words.length ? Math.round((words.filter((w) => w.conf === 'matched').length / words.length) * 100) / 100 : null,
      ...(alignError ? { alignmentError: trimTo(alignError, 300) } : {}),
    }),
  };
}

/**
 * The song checkpoint, at the end of analysis: align the vocal to the lyric
 * sheet (the timings the storyboard needs anyway), fill lines alignment
 * skipped, then judge the song from those measurements. A retake is taken only
 * for a local song (free) with revisions left; a Suno retake would spend
 * credits the operator did not approve, so that song is kept and the reason logged.
 */
async function orchestrateSong(projectId, run) {
  const alignError = await alignRunLyrics(projectId, run);
  const { buildSongReviewPrompt } = await reviewModule();
  const project = await getProject(projectId);
  const facts = songFacts(project, run, alignError);
  const review = await askReview(run, 'song', buildSongReviewPrompt({ ...ideaOf(run), title: run.output.title, facts }));
  if (review.verdict === 'retake') {
    const local = facts.songSource === 'local';
    const left = revisionsSpent(await latestRun(projectId), 'song') < reviewLimit(run);
    if (local && left) {
      await recordReview(projectId, reviewEntry('song', review, { facts }));
      return { retake: true };
    }
    const why = local ? 'Retake limit reached; kept this song.' : 'Kept: retaking a Suno song spends credits.';
    await recordReview(projectId, reviewEntry('song', review, { verdict: 'approve', facts, notes: `${why} ${review.notes || ''}`.trim() }));
    return { retake: false };
  }
  await recordReview(projectId, reviewEntry('song', review, { facts }));
  return { retake: false };
}

/**
 * Verify the lyric timing for the storyboard gate. Alignment already ran after
 * analysis; this records the check of it as the verification a director gives
 * by listening — by the orchestrator, or by an autopilot the operator granted
 * storyboard approval. It verifies only when every line has bounded word
 * timings, alignment ran without error and the recognizer heard at least
 * `MIN_HEARD_WORD_SHARE` of the words; otherwise the timings are mostly
 * guesses, so it returns why and leaves them for a director. An instrumental
 * is marked as one.
 */
async function settleLyricTiming(projectId, run) {
  const orchestrated = isOrchestratedRun(run);
  const record = (verdict, notes) => (orchestrated
    ? recordReview(projectId, { checkpoint: 'alignment', verdict, score: null, notes, route: null, visual: false }) : null);
  const project = await getProject(projectId);
  const draft = project.productionReview?.draft;
  if (!draft || draft.storyboardSource === 'document') return;
  const status = productionReadiness(project).alignment.status;
  if (status === 'verified' || status === 'instrumental') return;
  const cues = (project.lyricCues || []).filter((c) => cueText(c));
  if (!cues.length) {
    if (!run.brief.instrumental) return;
    await mutateProjectRecord(projectId, (current) => ({ project: { ...current, productionReview: { ...current.productionReview,
      draft: { ...current.productionReview.draft, lyricsMode: 'instrumental', timingNotes: 'Instrumental song: no lyric timing to verify.' } } } }));
    await record('approve', 'Instrumental song: no lyric timing to verify.');
    return;
  }
  const words = cues.flatMap((c) => c.words || []);
  const timed = cues.filter((c) => c.words?.length && validSpan(c.startSec, c.endSec)).length;
  const matched = words.filter((w) => w.conf === 'matched').length;
  const notes = `Checked by the ${orchestrated ? 'orchestrator' : 'autopilot'}: ${timed} of ${cues.length} lines carry word timings; ${matched} of ${words.length} words were heard by the recognizer, the rest interpolated.`;
  const failedAlignment = projectAutonomousRun(project)?.output?.alignmentError;
  const alignmentError = failedAlignment?.basis === productionAlignmentBasis(project) ? failedAlignment.message : null;
  const held = timed < cues.length ? 'Lines without timings need a director.'
    : alignmentError ? `Lyric alignment failed (${alignmentError}), so these timings are guesses; a director needs to listen and verify them.`
      : matched / words.length < MIN_HEARD_WORD_SHARE ? 'Too little of the vocal was heard to trust these timings; a director needs to listen and verify them.'
        : null;
  if (held) {
    await record('revise', `${notes} ${held}`);
    return `${notes} ${held}`;
  }
  const reviewer = orchestrated ? orchestratorIdentity(run) : { kind: 'autopilot', runId: run.id, authorizedBy: run.brief.autoApproveAuthorizedBy || null };
  await deps.verifyAlignment(projectId, { basis: productionAlignmentBasis(project), notes, reviewer });
  await record('approve', notes);
}

/** Anchor every storyboard shot to the lyric lines it overlaps (the "Review lyric anchors" chore). */
async function anchorStoryboardLyrics(projectId) {
  await mutateProjectRecord(projectId, (current) => {
    const draft = current.productionReview?.draft;
    if (!draft?.storyboard?.length || draft.storyboardSource === 'document') return { project: current };
    const cues = (current.lyricCues || []).filter((c) => cueText(c));
    let changed = false;
    const storyboard = draft.storyboard.map((shot) => {
      const scene = current.scenes?.find((s) => s.sceneId === shot.sceneId);
      if (!scene) return shot;
      const ids = cues.filter((c) => c.startSec < scene.endSec && c.endSec > scene.startSec).map((c) => c.id);
      if (ids.length === (shot.lyricCueIds || []).length && ids.every((id) => shot.lyricCueIds.includes(id))) return shot;
      changed = true;
      return { ...shot, lyricCueIds: ids };
    });
    return { project: changed ? { ...current, productionReview: { ...current.productionReview, draft: { ...draft, storyboard } } } : current };
  });
}

const STORYBOARD_FIELDS = ['action', 'staging', 'camera', 'transition'];
const blankShotFields = (shot) => STORYBOARD_FIELDS.filter((key) => !(typeof shot?.[key] === 'string' && shot[key].trim()));
// What a director types into a blank storyboard field when the orchestrator left it empty.
const STORYBOARD_FIELD_DEFAULT = Object.freeze({ staging: 'Medium shot', camera: 'Locked-off camera', transition: 'Cut' });

/** Fill blank storyboard fields from the review's `fill`, then plain defaults. */
async function fillStoryboard(projectId, fill = []) {
  await mutateProjectRecord(projectId, (current) => {
    const draft = current.productionReview?.draft;
    if (!draft?.storyboard?.length || draft.storyboardSource === 'document') return { project: current };
    let changed = false;
    const storyboard = draft.storyboard.map((shot) => {
      const blank = blankShotFields(shot);
      if (!blank.length) return shot;
      const scene = current.scenes?.find((s) => s.sceneId === shot.sceneId);
      const given = fill.find((f) => f.sceneId === shot.sceneId) || {};
      changed = true;
      return { ...shot, ...Object.fromEntries(blank.map((key) => [key,
        given[key] || (key === 'action' ? scene?.visualIntent || scene?.prompt || scene?.label || 'Hold on the subject' : STORYBOARD_FIELD_DEFAULT[key])])) };
    });
    return { project: changed ? { ...current, productionReview: { ...current.productionReview, draft: { ...draft, storyboard } } } : current };
  });
}

async function reviewArt(run, project) {
  const { buildArtReviewPrompt } = await reviewModule();
  const draft = project.productionReview?.draft || {};
  const guide = project.devArtifacts?.find((a) => a.id === draft.guideArtifactId && !a.deleted);
  const image = guide?.mimeType?.startsWith('image/') ? await deps.guideImagePath(guide).catch(() => null) : null;
  // The guide sheet is not redrawn after a text revision, so a re-review is told it shows the earlier text.
  const sheetPredatesEdits = !!image && revisionsSpent(await latestRun(project.id), 'art') > 0;
  return askReview(run, 'art', buildArtReviewPrompt({ ...ideaOf(run), concept: project.concept, draft, hasImage: !!image, sheetPredatesEdits }), image ? [image] : []);
}

async function reviewStoryboard(run, project) {
  const { buildStoryboardReviewPrompt } = await reviewModule();
  const draft = project.productionReview?.draft || {};
  const cues = project.lyricCues || [];
  const shots = (draft.storyboard || []).slice(0, 120).map((shot) => {
    const scene = project.scenes?.find((s) => s.sceneId === shot.sceneId) || {};
    return { sceneId: shot.sceneId, startSec: scene.startSec ?? null, endSec: scene.endSec ?? null,
      lyrics: (shot.lyricCueIds || []).map((id) => cueText(cues.find((c) => c.id === id))).filter(Boolean).join(' / '),
      ...Object.fromEntries(STORYBOARD_FIELDS.map((key) => [key, trimTo(shot[key], 400)])) };
  });
  const incomplete = (draft.storyboard || []).filter((shot) => blankShotFields(shot).length).map((shot) => shot.sceneId);
  return askReview(run, 'storyboard', buildStoryboardReviewPrompt({ ...ideaOf(run), concept: project.concept, shots, incomplete }));
}

/**
 * Apply a revise verdict to a production stage; returns false when nothing could
 * be applied. A storyboard re-plan that fails throws, so the stage fails and a
 * Retry asks again rather than approving shots the orchestrator asked to change.
 */
async function applyProductionRevision(projectId, run, stage, review) {
  if (stage === 'art') {
    if (!review.changes.length) return false;
    await mutateProjectRecord(projectId, (current) => ({ project: { ...current, productionReview: { ...current.productionReview,
      draft: { ...current.productionReview?.draft, ...Object.fromEntries(review.changes.map((c) => [c.field, c.text])) } } } }));
    return true;
  }
  const project = await getProject(projectId);
  const known = new Set((project.productionReview?.draft?.storyboard || []).map((shot) => shot.sceneId));
  const changes = review.changes.filter((c) => known.has(c.sceneId));
  if (!changes.length || project.productionReview?.draft?.storyboardSource === 'document') return false;
  const before = new Set((project.productionReview?.feedback || []).map((f) => f.id));
  const basis = productionReviewBasis(project).storyboard;
  for (const change of changes) {
    await deps.addFeedback(projectId, { stage, basis, target: change.sceneId, text: change.text, decision: 'request-changes' });
  }
  const { route, ...plan } = await llmOf(run, 'plan');
  const failure = await deps.reviseFromFeedback(projectId, { stage, ...plan }).then(() => null, (err) => err);
  const created = ((await getProject(projectId)).productionReview?.feedback || []).filter((f) => !before.has(f.id) && !f.resolvedAt);
  const resolution = failure ? `The re-plan failed (${trimTo(failure.message, 200)}); the orchestrator will ask again on Retry.` : 'Revised by the orchestrator.';
  for (const entry of created) {
    await deps.closeFeedback(projectId, { feedbackId: entry.id, resolution, reviewer: orchestratorIdentity(run, review.route) });
  }
  if (failure) {
    throw runError(502, 'ORCHESTRATOR_REVISION_FAILED', `The storyboard re-plan failed: ${trimTo(failure.message, 200)}`);
  }
  return true;
}

/**
 * Clear one Production review gate (art or storyboard) as the director would:
 * review, revise and review again, then approve the current revision. A
 * readiness problem the orchestrator cannot fix leaves the gate closed, and
 * the run parks for a human with that problem named.
 */
async function orchestrateProductionStage(project, run, stage) {
  for (;;) {
    const ready = productionReadiness(project);
    if (ready[stage].approved || (stage === 'storyboard' && !ready.art.approved)) return project;
    if (stage === 'storyboard') await anchorStoryboardLyrics(project.id);
    const review = stage === 'art' ? await reviewArt(run, await getProject(project.id)) : await reviewStoryboard(run, await getProject(project.id));
    if (stage === 'storyboard') await fillStoryboard(project.id, review.fill);
    const spent = revisionsSpent(await latestRun(project.id), stage);
    if (review.verdict === 'revise' && spent < reviewLimit(run) && await applyProductionRevision(project.id, run, stage, review)) {
      await recordReview(project.id, reviewEntry(stage, review, { changes: review.changes.map((c) => trimTo(`${c.field || c.sceneId}: ${c.text}`, 300)) }));
      project = await getProject(project.id);
      continue;
    }
    project = await getProject(project.id);
    const readiness = productionReadiness(project);
    const why = review.verdict !== 'revise' ? '' : spent >= reviewLimit(run) ? 'Revision limit reached; accepted the latest version. ' : 'Nothing to revise was supplied; accepted as is. ';
    if (readiness[stage].problems.length) {
      await recordReview(project.id, reviewEntry(stage, review, { verdict: 'revise', notes: `Could not approve: ${trimTo(readiness[stage].problems[0], 300)} ${review.notes || ''}`.trim() }));
      return project;
    }
    await deps.approveProductionReview(project.id, { stage, basis: readiness.basis[stage], approvedBy: 'orchestrator', reviewer: orchestratorIdentity(run, review.route) });
    await recordReview(project.id, reviewEntry(stage, review, { verdict: 'approve', notes: `${why}${review.notes || ''}`.trim() }));
    return getProject(project.id);
  }
}

/** Art and storyboard: the orchestrator when the run has one, else the operator's auto-approve grant. */
const settleProductionStage = (project, run, stage) => (isOrchestratedRun(run)
  ? orchestrateProductionStage(project, run, stage)
  : autoApproveStage(project, run, stage));

/**
 * The orchestrator's look at the finished film. Nothing is left to change at
 * this point, so a critical verdict is logged as notes (`noted`) beside the
 * render rather than holding the run. A failed look is logged, never fatal.
 */
/**
 * Watch the finished film and send flagged sections back, as a director would:
 * a `revise` verdict with timecoded issues starts one revision (startFinalRevision)
 * while revisions remain; anything else is logged and the film is kept. Returns
 * 'rerender' (re-authored: render the film again), 'wait' (a footage revision
 * is under way) or null (keep this film).
 */
async function orchestrateFinal(projectId, run) {
  const project = await getProject(projectId);
  const frames = await deps.finalReviewFrames(run.output.renderJobId).catch((err) => ({ images: [], frameTimes: [], facts: { error: err.message }, cleanup: async () => {} }));
  let review;
  try {
    const { buildFinalReviewPrompt } = await reviewModule();
    review = await askReview(run, 'final', buildFinalReviewPrompt({ ...ideaOf(run), concept: project?.concept, facts: frames.facts, frameTimes: frames.frameTimes }), frames.images);
  } catch (err) {
    await recordReview(projectId, { checkpoint: 'final', verdict: 'noted', score: null, notes: `The final review could not run: ${trimTo(err.message, 300)}`, route: null, visual: false });
    return null;
  } finally {
    await frames.cleanup?.().catch(() => {});
  }
  const issues = review.issues || [];
  const blind = frames.images.length ? '' : `Judged without frames (${frames.facts?.error || 'none could be captured'}). `;
  const keep = (why = '') => recordReview(projectId, reviewEntry('final', review, { verdict: review.verdict === 'approve' ? 'approve' : 'noted', issues,
    notes: `${blind}${why}${review.notes || ''}`.trim() }));
  if (review.verdict !== 'revise' || !issues.length) return keep(review.verdict === 'revise' ? 'No timecoded issue to revise; kept this film. ' : '').then(() => null);
  if (revisionsSpent(await latestRun(projectId), 'final') >= reviewLimit(run)) return keep('Revision limit reached; kept the latest film. ').then(() => null);
  let next;
  try {
    next = await startFinalRevision(projectId, run, issues);
  } catch (err) {
    await keep(`The revision did not go through (${trimTo(err.message, 200)}); kept this film. `);
    return null;
  }
  await recordReview(projectId, reviewEntry('final', review, { issues, notes: `${blind}${review.notes || ''}`.trim() }));
  return next;
}

const FINAL_REVISION_STEP = 'final-revision';
const timecode = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** The scenes the issues fall in, as one window (the auto-review's range). */
function issueWindow(project, issues) {
  const scenes = (project.scenes || []).filter((scene) => issues.some((issue) => issue.atSec >= scene.startSec && issue.atSec < scene.endSec));
  if (!scenes.length) return null;
  return { startSec: Math.min(...scenes.map((s) => s.startSec)), endSec: Math.max(...scenes.map((s) => s.endSec)) };
}

/**
 * Send the flagged sections back. A code or document composition is
 * re-authored with the issues as change requests on the film (the authoring
 * prompt carries open requests), then rendered again. Footage gets a
 * board-owned auto-review over the scenes the issues fall in, judged by the
 * orchestrator and limited to the generations production left unspent; the
 * film is rendered again when it ends (onAutoReviewEvent). Throws when no
 * revision can start.
 */
async function startFinalRevision(projectId, run, issues) {
  const project = await getProject(projectId);
  const code = musicVideoMediaMode(project) === 'code-only' || autonomousMedium(run.brief.tools) === 'code';
  await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'running', step: FINAL_REVISION_STEP }));
  if (code) return reauthorFinal(projectId, run, issues).then(() => 'rerender');
  const window = issueWindow(project, issues);
  if (!window) throw runError(409, 'NO_FLAGGED_SCENE', 'No scene covers the flagged times');
  const production = (project.productionRuns || []).find((r) => r.id === run.output.productionRunId);
  // A dollar cap is production's to enforce; a board revision cannot, so it is not spent past it.
  if (production?.limits?.spendCapUsd != null) throw runError(409, 'FINAL_REVISION_BUDGET', 'a dollar budget is set, which a board revision cannot enforce');
  const left = production ? Math.max(0, production.limits.maxGenerations - (production.usage?.generations || 0)) : 0;
  if (!left) throw runError(409, 'FINAL_REVISION_BUDGET', 'production spent its generations');
  const { run: review } = await deps.startAutoReview(projectId, { ...window, limits: { maxAttempts: 2, maxGenerations: Math.min(left, 100) },
    reviewer: { providerId: run.brief.orchestrator.providerId, model: run.brief.orchestrator.model || null } });
  await patchRun(projectId, () => ({ output: { finalAutoReviewId: review.id } }));
  console.log(`🎬 Autonomous music video ${short(run.id)} sent ${timecode(window.startSec)}-${timecode(window.endSec)} back for revision`);
  return 'wait';
}

async function reauthorFinal(projectId, run, issues) {
  const project = await getProject(projectId);
  const basis = productionReviewBasis(project).proof;
  const before = new Set((project.productionReview?.feedback || []).map((f) => f.id));
  for (const issue of issues.slice(0, 12)) {
    await deps.addFeedback(projectId, { stage: 'proof', basis, target: `final@${timecode(issue.atSec)}`, text: issue.text, decision: 'request-changes' });
  }
  const authoring = !run.brief.llmStages?.authoring && run.brief.authoring ? run.brief.authoring : await llmOf(run, 'authoring');
  const input = { providerId: authoring.providerId, model: authoring.model || undefined, ...(authoring.effort ? { effort: authoring.effort } : {}) };
  const failure = await (async () => {
    if ((await getProject(projectId)).composition?.mode === 'code') return deps.generateCode(projectId, input);
    const candidate = await deps.generateDocument(projectId, input);
    return deps.acceptDocument(projectId, candidate.document.directory);
  })().then(() => null, (err) => err);
  // Requests stay open through authoring (the prompt carries them), then close either way.
  const created = ((await getProject(projectId)).productionReview?.feedback || []).filter((f) => !before.has(f.id) && !f.resolvedAt);
  const resolution = failure ? `The re-authoring failed (${trimTo(failure.message, 200)}); kept the film.` : 'Re-authored by the orchestrator.';
  for (const entry of created) await deps.closeFeedback(projectId, { feedbackId: entry.id, resolution, reviewer: orchestratorIdentity(run) });
  if (failure) throw failure;
}

// ---- stage executors -------------------------------------------------------------
// Each returns `{ output }` (merged into run.output) or `{ output, wait: true }`
// when the stage's completion arrives later (production).

/**
 * The LLM for one of a run's stages, resolved each time the stage runs: the
 * run's pin for that stage (`brief.llmStages[stage]`), else — for `authoring` —
 * its code-authoring pin, else its direction pin (`brief.llm`), else an
 * eligible TUI provider, else the active one (llmRoute.js). The resolved route
 * rides along (`route`) so the stage can record it on the run; a failed
 * registry read degrades to the plain pin rather than failing the stage.
 */
async function llmOf(run, stage) {
  const { llm, llmStages, authoring } = run.brief;
  const own = llmStages?.[stage] || (stage === 'authoring' && authoring) || llm;
  const pin = { providerId: own?.providerId, model: own?.model || undefined, effort: own?.effort || undefined };
  const resolved = await deps.resolveLlm({
    stage,
    automation: { llm: llm || null, llmStages: llmStages || null },
    ...(stage === 'authoring' && authoring ? { authoring } : {}),
  }).catch((err) => {
    console.warn(`⚠️ Autonomous music video: LLM route resolution failed: ${err.message}`);
    return null;
  });
  const route = resolved?.route;
  if (!route) return { ...pin, route: null };
  return { providerId: route.providerId, model: route.model || undefined, effort: route.effort || undefined, route };
}

/** Keep the route a text stage ran on in the project's brief too (best-effort, never fails the stage). */
const recordRoute = (project, stage, route) => (route ? deps.recordRoute(project.id, stage, route).catch(() => null) : null);

/**
 * The local song source: the track is created first (its id is stored at once),
 * the render is queued onto it, and the stage settles once the audio has landed.
 * A retry rejoins the stored render instead of queuing a second one.
 */
async function localSong({ project, run, save }) {
  const title = trimTo(run.output.title, 200) || 'Untitled';
  const lyrics = run.brief.instrumental ? '' : run.output.lyrics || '';
  // The style line is editable at the style checkpoint, so it conditions the render alongside the description.
  const prompt = [run.output.musicalDescription, run.output.sunoStyle].filter(Boolean).join('\n\n') || run.brief.prompt;
  let trackId = run.output.localTrackId;
  if (!trackId) {
    const track = await deps.createTrack({ title, concept: run.brief.prompt, lyrics, prompt });
    trackId = track.id;
    await save({ output: { localTrackId: trackId } });
  }
  await deps.generateLocalSong({
    trackId, title, prompt, lyrics, instrumental: run.brief.instrumental, jobId: run.output.localSongJobId,
    localMusic: run.brief.localMusic,
    onSubmitted: async (jobId) => {
      await save({ output: { localSongJobId: jobId } });
      // Stop/cancel cancel the job they find on the record; one that landed
      // before this id was stored never saw it, so settle that race here.
      const latest = projectAutonomousRun(await getProject(project.id));
      if (latest?.status === 'running' && latest.processId === PROCESS_ID) return;
      await deps.cancelLocalSong(jobId).catch(() => {});
      throw runError(409, 'NOT_RUNNING', 'The run was stopped before its song render started');
    },
  });
  // Linking the track seeds the project's timed lyric cues from the track lyrics.
  await deps.updateProject(project.id, { trackId });
  return { output: { trackId, songSource: 'local' } };
}

// Draft, then — when the brief asks for it — review & revise on the
// `lyricsReview` stage's LLM. The review is a step inside the lyrics stage (the
// stage list is wire/UI contract), reported through `stages.lyrics.step`. The
// draft is stored before the review runs, so a failed review retries only the review.
async function writeRunLyrics({ project, run, save }) {
  if (run.brief.instrumental) return { output: { lyrics: '' } };
  const review = autonomousLyricsReviewEnabled(run.brief);
  const description = run.output.musicalDescription;
  const guidance = run.brief.guidance || undefined;
  // The prompt carries the lyrical intent (hook, subject, imagery); the musical description only the sound.
  const request = run.brief.prompt || undefined;
  const step = (name) => patchRun(project.id, (r) => stagePatch(r, 'lyrics', { step: name }));
  let draft = review ? run.output.lyricsDraft : null;
  let draftRoute = review ? run.output.lyricsRoute : null;
  if (!draft) {
    if (review) await step('draft');
    const { route, ...llm } = await llmOf(run, 'lyrics');
    ({ lyrics: draft } = await deps.writeLyrics({ description, guidance, request, ...llm }));
    draftRoute = route;
    await recordRoute(project, 'lyrics', route);
    if (!review) return { output: { lyrics: draft, ...(route ? { lyricsRoute: route } : {}) } };
    await save({ output: { lyricsDraft: draft, ...(route ? { lyricsRoute: route } : {}) } });
  }
  await step('review');
  const { route, ...llm } = await llmOf(run, 'lyricsReview');
  const revised = await deps.reviewLyrics({ lyrics: draft, description, guidance, request, ...llm });
  await recordRoute(project, 'lyricsReview', route);
  return { output: {
    lyricsDraft: draft,
    lyrics: revised.lyrics,
    lyricsReviewNotes: revised.notes || '',
    ...(draftRoute ? { lyricsRoute: draftRoute } : {}),
    ...(route ? { lyricsReviewRoute: route } : {}),
  } };
}

// The board's notes render on the run's first image tool with its pinned model.
// Null keeps the board text-only: the brief names no image tool (its tool list
// is what autopilot may use), or the run has a dollar cap and the tool is not
// the free local backend — these pre-production renders are not counted
// against production's spend cap, so a capped run never spends on them.
// Only reached in a mode that allows images (code-only builds no board).
function boardRenderRoute(run) {
  const tool = (run.brief.tools || []).find((id) => id.startsWith('image:'));
  if (!tool) return null;
  const mode = tool.slice('image:'.length);
  if (run.brief.budgetUsd != null && mode !== IMAGE_GEN_MODE.LOCAL) return null;
  return { target: RENDER_TARGET.MUSIC_VIDEO, mode, model: run.brief.models?.[tool] || undefined };
}

async function createRunStyle({ project, run }) {
  if (musicVideoMediaMode(project) === 'code-only') {
    await deps.updateProject(project.id, { concept: { prompt: run.output.concept.prompt, style: run.output.concept.style || run.output.moodBoard?.stylePrompt || '' } });
    return { output: { moodBoardId: null } };
  }
  const board = run.output.moodBoard;
  const moodBoardId = run.brief.moodBoardId || run.output.moodBoardId
    || (await deps.createMoodBoard(board, { renderRoute: boardRenderRoute(run) })).id;
  // The board is also the project's linked mood board; the server derives the
  // authored style snapshot from it (styleSnapshots.js).
  await deps.updateProject(project.id, {
    concept: { prompt: run.output.concept.prompt, ...(run.output.concept.style ? { style: run.output.concept.style } : {}) },
    visualSpec: { moodBoardId },
  });
  return { output: { moodBoardId } };
}

const STAGES = {
  async brief({ project, run }) {
    const { route, ...llm } = await llmOf(run, 'brief');
    const { brief } = await deps.draftCreativeBrief({
      prompt: run.brief.prompt, guidance: run.brief.guidance, instrumental: run.brief.instrumental, ...llm,
    });
    // A blank project name from the prompt gives way to the song title.
    if (!run.brief.name) await deps.updateProject(project.id, { name: trimTo(brief.title, 200) });
    await recordRoute(project, 'brief', route);
    return { output: { ...brief, ...(route ? { briefRoute: route } : {}) } };
  },

  // The orchestrator judges the written lyrics and may rewrite them (orchestrateLyrics).
  async lyrics(ctx) {
    const { project, run, save } = ctx;
    if (run.brief.instrumental || !isOrchestratedRun(run)) return writeRunLyrics(ctx);
    // The draft (or reviewed draft) is stored before the orchestrator judges it,
    // so a failed review retries only the review.
    let written = run.output.lyricsForReview ? { output: { lyrics: run.output.lyricsForReview } } : null;
    if (!written) {
      written = await writeRunLyrics(ctx);
      await save({ output: { ...written.output, lyricsForReview: written.output.lyrics } });
    }
    const lyrics = await orchestrateLyrics(project.id, run, written.output.lyrics);
    return { output: { ...written.output, lyrics, lyricsForReview: null } };
  },

  async style({ project, run, save }) {
    // The orchestrator judges the sound & look before the mood board is made from it.
    if (isOrchestratedRun(run) && !run.output.styleReviewed) {
      const reviewed = await orchestrateStyle(project.id, run);
      ({ run } = await save({ output: { ...reviewed, styleDraft: null, styleReviewed: true } }));
    }
    return createRunStyle({ project, run });
  },

  async song({ project, run, save }) {
    if (run.output.trackId) return { output: {} };
    // `output.songSource` records a fallback already taken, so a resume stays local.
    if ((run.output.songSource || run.brief.songSource) === 'local') return localSong({ project, run, save });
    const fields = sunoSongFields({
      title: run.output.title, style: run.output.sunoStyle, lyrics: run.output.lyrics, instrumental: run.brief.instrumental, suno: run.brief.suno,
    });
    let submitted = run.output.sunoSongIds?.length > 0;
    let song;
    const controller = new AbortController();
    sunoControllers.set(run.id, controller);
    try {
      const latest = projectAutonomousRun(await getProject(project.id));
      if (latest?.id !== run.id || latest.status !== 'running') controller.abort();
      controller.signal.throwIfAborted();
      song = await deps.generateSunoSong(fields, {
        songIds: run.output.sunoSongIds,
        signal: controller.signal,
        // The long stage's sub-step rides the run record (and its socket event) so the page can show it.
        onProgress: (step) => { patchRun(project.id, (r) => stagePatch(r, 'song', { step })).catch(() => {}); },
        // Stored the moment Suno accepts the request, so a failed download retries
        // the same songs instead of spending credits on another generation.
        onSubmitted: (ids) => { submitted = true; return save({ output: { sunoSongIds: ids } }); },
      });
    } catch (err) {
      // Only before Suno accepted a request: after that, credits are spent and a
      // retry reuses those songs rather than paying for a second render.
      if (controller.signal.aborted || !run.brief.localFallback || submitted) throw err;
      console.warn(`⚠️ Autonomous music video ${short(run.id)} could not use Suno (${trimTo(err.message, 200)}) — rendering the song locally`);
      await save({ output: { songSource: 'local', songFallbackReason: trimTo(err.message, 500) } });
      return localSong({ project, run, save });
    } finally {
      sunoControllers.delete(run.id);
    }
    controller.signal.throwIfAborted();
    const track = await deps.createTrack({
      title: fields.title, concept: run.brief.prompt, lyrics: fields.lyrics, prompt: fields.style,
    });
    const durationSec = await deps.probeDuration(song.filename);
    // The imported M4A is already durable; the track row that first names it
    // commits under a backup lease (#9982).
    await withBackupAssetPublication(() => deps.attachAudio(track.id, song.filename, { source: 'suno', prompt: fields.style, lyrics: fields.lyrics, durationSec }));
    // Linking the track seeds the project's timed lyric cues from the track lyrics.
    await deps.updateProject(project.id, { trackId: track.id });
    return { output: { trackId: track.id, sunoSongIds: song.songIds } };
  },

  async analyze({ project, run }) {
    await deps.analyzeSong(project.id);
    // A storyboard grant needs the lyric timings production verifies, so the autopilot aligns too.
    if (!isOrchestratedRun(run) && autoApproves(run, 'storyboard')) await alignRunLyrics(project.id, run);
    if (isOrchestratedRun(run) && (await orchestrateSong(project.id, run)).retake) {
      // A local fallback stays local: the retake must not send the run back to Suno.
      const reset = Object.fromEntries(SONG_OUTPUT_KEYS.filter((key) => key !== 'songSource' && key !== 'songFallbackReason').map((key) => [key, null]));
      return { output: reset, goto: 'song', unlinkTrack: run.output.trackId || null };
    }
    // The single's own cover design, drafted from the song just made, ready
    // for the publishing kit. Best-effort: a failed draft never stops the video.
    if (!project.publishKit?.coverArt?.design) {
      const { providerId, model } = await llmOf(run, 'brief');
      await deps.designCoverArt(project.id, { providerId: providerId || null, model: model || null })
        .catch((err) => console.warn(`⚠️ Autonomous music video ${short(run.id)} cover design skipped: ${trimTo(err.message, 200)}`));
    }
    return { output: {} };
  },

  async produce({ project, run }) {
    const medium = musicVideoMediaMode(project) === 'code-only' ? 'code' : autonomousMedium(run.brief.tools);
    if (medium === 'code' && !['code', 'document'].includes(project.composition?.mode)) {
      await deps.updateProject(project.id, { composition: { mode: 'document', authoringRenderer: 'three' } });
    }
    await prepareProductionReview(project.id);
    project = await getProject(project.id);
    // The guide is generated in the background; the art gate is only meaningful once it exists.
    const castStage = project.castAndSets;
    if (castStage?.status === 'failed') {
      throw runError(500, 'CAST_SETS_FAILED', `Cast & Sets failed: ${castStage.stopReason || castStage.error || 'unknown error'}`);
    }
    if (CAST_SETS_WORKING.includes(castStage?.status) && productionReadiness(project).art.problems.length) {
      await deps.resumeInterruptedCastAndSets(project);
      return { output: {}, wait: true, step: CAST_STEP };
    }
    const artWasApproved = productionReadiness(project).art.approved;
    project = await settleProductionStage(project, run, 'art');
    if (!artWasApproved && productionReadiness(project).art.approved) {
      // Preparing stops at the art gate; with art approved it drafts the storyboard.
      await prepareProductionReview(project.id);
      project = await getProject(project.id);
    }
    let timingHeld = null;
    if (isOrchestratedRun(run) || autoApproves(run, 'storyboard')) {
      timingHeld = await settleLyricTiming(project.id, run);
      // The orchestrator anchors inside its storyboard review; the autopilot does it here.
      if (!isOrchestratedRun(run)) await anchorStoryboardLyrics(project.id);
      project = await getProject(project.id);
    }
    project = await settleProductionStage(project, run, 'storyboard');
    // Name why the timing was left unverified rather than only that it is provisional,
    // with the storyboard's other open problems so one resume can clear them all.
    const storyboard = productionReadiness(project).storyboard;
    if (timingHeld && !storyboard.approved) {
      const others = storyboard.problems.filter((p) => p !== ALIGNMENT_UNVERIFIED_PROBLEM);
      throw runError(409, 'MUSIC_VIDEO_APPROVAL_REQUIRED', trimTo([timingHeld, ...others].join(' '), 500));
    }
    assertProductionApproval(project, 'storyboard');
    // The authoring stage's pin, else the run's code-authoring pin taken as
    // given (production checks it exactly), else the direction LLM.
    const authoring = !run.brief.llmStages?.authoring && run.brief.authoring ? run.brief.authoring : await llmOf(run, 'authoring');
    const input = { providerId: authoring.providerId, model: authoring.model || undefined, ...(authoring.effort ? { effort: authoring.effort } : {}) };
    if (medium === 'code') {
      if (project.composition?.mode === 'code') {
        if (!project.composition?.codeVideo?.sections?.length) await deps.generateCode(project.id, input);
      } else if (!project.composition?.document) {
        const candidate = project.composition?.documentDraft ? { document: project.composition.documentDraft }
          : await deps.generateDocument(project.id, input);
        await deps.acceptDocument(project.id, candidate.document.directory);
      }
      // The animated proof is optional review evidence, so the run renders the film once the
      // storyboard is approved; the director can still render and approve a proof by hand.
      const render = await deps.renderVideo(project.id);
      // The run is not finished until the MP4 exists: stay on produce and let the render's own event settle it.
      return { output: { renderJobId: render?.jobId || null }, wait: true, step: RENDER_STEP };
    }
    const started = await deps.startProduction(project.id, {
      directive: trimTo([run.brief.prompt, run.brief.guidance].filter(Boolean).join('\n\n'), 4000),
      pool: briefProductionPool(run.brief, project),
      limits: { ...run.brief.limits, ...(run.brief.budgetUsd != null ? { spendCapUsd: run.brief.budgetUsd } : {}) },
      // The orchestrator also judges production's plates and drafts when the run has one.
      reviewer: isOrchestratedRun(run)
        ? { providerId: run.brief.orchestrator.providerId, model: run.brief.orchestrator.model || null }
        : { providerId: run.brief.llm?.providerId || null, model: run.brief.llm?.model || null },
      authoring: input,
    });
    return { output: { productionRunId: started.run.id }, wait: true };
  },
};

// ---- the advance loop ------------------------------------------------------------

const isLoginRequired = (err) => err?.code === 'PUBLISH_LOGIN_REQUIRED';

async function park(projectId, status, patch) {
  const out = await patchRun(projectId, () => ({ status, ...patch }));
  const log = status === 'failed' ? console.error : status === 'completed' ? console.log : console.warn;
  log(`${status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏸️'} Autonomous music video ${short(out.run.id)} ${status}${patch.error ? `: ${patch.error}` : ''}`);
  return out;
}

async function advance(projectId) {
  if (inflight.has(projectId)) return;
  const settlement = Promise.withResolvers();
  inflight.set(projectId, settlement.promise);
  try {
    for (;;) {
      const project = await getProject(projectId);
      const run = projectAutonomousRun(project);
      if (!run || run.status !== 'running' || run.processId !== PROCESS_ID) return;
      const stage = run.stage;
      const executor = STAGES[stage];
      if (!executor) {
        await park(projectId, 'failed', { error: `Unknown stage "${stage}"`, errorCode: 'UNKNOWN_STAGE' });
        return;
      }
      await patchRun(projectId, (r) => stagePatch(r, stage, { status: 'running', startedAt: new Date().toISOString(), error: null, step: null }));
      let result;
      try {
        result = await executor({ project, run, save: (patch) => patchRun(projectId, () => patch) });
      } catch (err) {
        // A stop/cancel mid-stage (it cancels the song operation) must not become a failure.
        const latest = projectAutonomousRun(await getProject(projectId));
        if (latest?.status !== 'running' || latest.processId !== PROCESS_ID) return;
        await patchRun(projectId, (r) => stagePatch(r, stage, { status: 'failed', error: trimTo(err.message, 500), step: null }));
        await park(projectId, isLoginRequired(err) || err.code === 'MUSIC_VIDEO_APPROVAL_REQUIRED' ? 'needs-human' : 'failed', { error: trimTo(err.message, 500), errorCode: err.code || null });
        return;
      }
      const finishedAt = new Date().toISOString();
      if (result.goto) {
        // The orchestrator sent the run back (a song retake): both stages run again.
        const pending = { status: 'pending', startedAt: null, finishedAt: null, error: null, step: null };
        await patchRun(projectId, (r) => ({ output: result.output, stage: result.goto,
          stages: { [stage]: { ...r.stages[stage], ...pending }, [result.goto]: { ...r.stages[result.goto], ...pending } } }));
        if (result.unlinkTrack) await unlinkRunTrack(projectId, run.id, result.unlinkTrack);
        console.log(`🎬 Autonomous music video ${short(run.id)} going back to ${result.goto}`);
        continue;
      }
      if (result.wait) {
        await patchRun(projectId, (r) => ({ output: result.output, ...stagePatch(r, stage, { status: 'running', step: result.step || null }) }));
        console.log(`🎬 Autonomous music video ${short(run.id)} handed ${stage} to ${result.step === RENDER_STEP ? 'the final render' : result.step === CAST_STEP ? 'Cast & Sets' : 'production'}`);
        // The render may have settled before its job id was stored on the run.
        if (result.step === RENDER_STEP) await reconcileFinalRender(projectId);
        // Cast & Sets may likewise have settled while the wait was being stored.
        // It runs once this loop releases the project, so the re-entry it triggers is not dropped as "already running".
        else if (result.step === CAST_STEP) {
          settlement.promise.then(() => reconcileCastAndSets(projectId))
            .catch((err) => console.error(`❌ Autonomous music video could not settle on Cast & Sets: ${err.message}`));
        }
        return;
      }
      const next = nextAutonomousStage(stage);
      const checkpoint = run.brief.checkpoints.includes(stage);
      await patchRun(projectId, (r) => ({
        output: result.output,
        ...stagePatch(r, stage, { status: 'done', finishedAt, step: null }),
        ...(checkpoint ? { status: 'awaiting-approval', awaiting: stage, stage: next } : next ? { stage: next } : { status: 'completed', stage }),
      }));
      console.log(`🎬 Autonomous music video ${short(run.id)} finished ${stage}${checkpoint ? ' — waiting for approval' : ''}`);
      if (checkpoint || !next) return;
    }
  } catch (err) {
    console.error(`❌ Autonomous music video advance failed for ${short(projectId)}: ${err.message}`);
  } finally {
    inflight.delete(projectId);
    settlement.resolve();
  }
}

function advanceInBackground(projectId) {
  advance(projectId).catch((err) => console.error(`❌ Autonomous music video advance failed for ${short(projectId)}: ${err.message}`));
}

/**
 * Drop the project's link to a retaken song. The rejected track stays in the
 * music library (the director may still want it); only the link goes, and
 * only while it still names that track (never one the director picked since).
 * Unlinking keeps the lyric cues' text and clears their timings (applyProjectPatch
 * → invalidateTimedText), and the new song's link re-seeds them from its own
 * lyrics. A failed unlink is not fatal: that same link replaces the old one.
 */
async function unlinkRunTrack(projectId, runId, trackId) {
  const project = await getProject(projectId);
  if (project?.trackId === trackId) {
    await deps.updateProject(projectId, { trackId: null })
      .catch((err) => console.warn(`⚠️ Autonomous music video ${short(runId)} could not unlink the retaken track: ${err.message}`));
  }
  console.log(`🎬 Autonomous music video ${short(runId)} retaking its song`);
}

// ---- director actions ------------------------------------------------------------

const emptyStages = () => Object.fromEntries(AUTONOMOUS_STAGE_IDS.map((id) => [id, { status: 'pending', startedAt: null, finishedAt: null, error: null }]));

/**
 * Start a run from one prompt: creates the project (autonomous mode, no track
 * yet) and begins the pipeline in the background. Returns `{ project, run }`.
 */
/** The production pool a brief allows on this project. */
const briefProductionPool = (brief, project) => autonomousPool(brief.tools, brief.models)
  .filter((route) => musicVideoAllowsMedia(project, route.kind));

/** Refuse a pinned video model that cannot animate a frame (#10457) before the run records it. */
async function assertBriefVideoModelsCapable(tools, models) {
  const pool = autonomousPool(tools, models);
  if (pool.some((route) => route.kind === 'video' && route.model)) await assertFootageVideoModelsCapable(pool, await loadPoolEnv());
}

export async function startAutonomousVideo(input, { autoApproveAuthorized = false } = {}) {
  const brief = { ...normalizeAutonomousBrief(input), ...autoApproveGrant(input?.autoApprove, autoApproveAuthorized) };
  if (!brief.prompt) throw runError(400, 'VALIDATION_ERROR', 'A prompt is required');
  if (brief.orchestrator) Object.assign(brief, orchestratorGrant(autoApproveAuthorized));
  await assertBriefVideoModelsCapable(brief.tools, brief.models);
  const now = new Date().toISOString();
  const created = await deps.createProject({
    name: brief.name || trimTo(brief.prompt.replace(/\s+/g, ' '), 60) || 'Autonomous music video',
    mode: 'autonomous',
    mediaMode: brief.mediaMode,
    ...(brief.mediaMode !== 'code-images-video' ? { productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } } : {}),
    concept: { prompt: trimTo(brief.prompt, 8000) },
    automation: {
      tools: brief.tools,
      guidance: brief.guidance,
      budgetUsd: brief.budgetUsd,
      checkins: { castAndSets: brief.checkpoints.includes('cast') ? 'review' : 'auto' },
      // The run's LLM pins also steer the stages production starts later (Cast & Sets, shot planning, authoring).
      ...(brief.llm ? { llm: brief.llm } : {}),
      ...(brief.llmStages ? { llmStages: brief.llmStages } : {}),
    },
  });
  const run = {
    id: `mvar-${randomUUID()}`,
    status: 'running',
    stage: AUTONOMOUS_STAGE_IDS[0],
    awaiting: null,
    brief,
    stages: emptyStages(),
    output: {},
    error: null,
    errorCode: null,
    processId: PROCESS_ID,
    createdAt: now,
    updatedAt: now,
  };
  const out = await mutateProjectRecord(created.id, (current) => ({ project: { ...current, autonomousRun: run }, run }));
  console.log(`🎬 Autonomous music video ${short(run.id)} started (${brief.tools.length} tool(s), ${brief.orchestrator ? `orchestrated by ${brief.orchestrator.providerId}` : `${brief.checkpoints.length} checkpoint(s)`}${brief.autoApprove.length ? `, auto-approve ${brief.autoApprove.join('/')}` : ''}${brief.origin.kind === 'schedule' ? ', scheduled' : ''})`);
  publish(out.project, out.run);
  advanceInBackground(created.id);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

export async function getAutonomousRun(projectId) {
  const { run } = await requireRun(projectId);
  return { run: presentAutonomousRun(run) };
}

/**
 * Resume a parked, failed or interrupted run at the stage that stopped — or
 * approve the checkpoint it is waiting on (optionally replacing the stage
 * output the director edited). Returns `{ project, run }`.
 */
const assertResumable = (run) => {
  // A run canceled while it waited on production can pick up again: resume adopts the
  // director's own production run, or starts a new one from the brief.
  const resumable = AUTONOMOUS_LIVE_STATUSES.includes(run.status) || run.status === 'failed'
    || (run.status === 'canceled' && run.stage === 'produce');
  if (!resumable) throw runError(409, 'NOT_RESUMABLE', `A ${run.status} run cannot be resumed`);
  if (run.status === 'running' && run.processId === PROCESS_ID) throw runError(409, 'ALREADY_RUNNING', 'This run is already running');
};

// A retake is only meaningful while the run sits on the song it would replace: parked for
// approval of it, or stopped / failed inside the song stage (a Suno request whose rows
// vanished leaves ids no export can find — the retake discards them and submits afresh).
const assertAtSongCheckpoint = (run) => {
  const parkedOnSong = run.status === 'awaiting-approval' && run.awaiting === 'song';
  const stuckInSong = run.stage === 'song' && ['stopped', 'failed', 'needs-human'].includes(run.status);
  if (!parkedOnSong && !stuckInSong) {
    throw runError(409, 'NOT_AT_SONG_CHECKPOINT', 'A song can only be retaken while the run is waiting for approval of its song, or is stopped or failed in the song stage');
  }
};

// Every key the song stage (and `localSong`) writes; a retake nulls them all so
// the stage runs from scratch — a new Suno request (the director's explicit,
// credit-spending choice) or a new local render on a new track.
const SONG_OUTPUT_KEYS = ['trackId', 'sunoSongIds', 'songSource', 'songFallbackReason', 'localTrackId', 'localSongJobId'];

export async function resumeAutonomousVideo(projectId, edits = {}, { autoApproveAuthorized = false } = {}) {
  const { run } = await requireRun(projectId);
  // A model swap is validated like Start, then replaces the parked production run's pool (#10473).
  const modelsPatch = briefModelsPatch(run.brief, edits.models);
  assertResumable(run);
  if (modelsPatch) await assertBriefVideoModelsCapable(run.brief.tools, modelsPatch);
  // "Auto-approve the rest": replaces the brief's grant (an empty list clears it).
  const grant = edits.autoApprove !== undefined ? autoApproveGrant(edits.autoApprove, autoApproveAuthorized) : null;
  const retake = edits.retakeSong === true;
  if (retake) assertAtSongCheckpoint(run);
  const modelsChanged = modelsPatch !== null && JSON.stringify(modelsPatch) !== JSON.stringify(run.brief.models || {});
  const limitsPatch = edits.limits ? { ...run.brief.limits, ...edits.limits } : null;
  // A production run only takes raised limits; refuse a lower one before anything changes.
  if (edits.limits && run.stage === 'produce' && Object.entries(edits.limits).some(([key, value]) => value != null && value < (run.brief.limits?.[key] ?? 0))) {
    throw runError(400, 'VALIDATION_ERROR', 'Resuming production can only raise a limit');
  }
  // Stop changes the record immediately, but its stage may still be settling.
  // Let that attempt release ownership before marking a new attempt running.
  await inflight.get(projectId);
  let retakenTrackId = null;
  const out = await patchRun(projectId, (r, current) => {
    // Cancel or another Resume may have won while the old attempt settled.
    assertResumable(r);
    if (retake) {
      assertAtSongCheckpoint(r);
      // Unlink only the track this run linked, never one the director picked since.
      if (r.output.trackId && current.trackId === r.output.trackId) retakenTrackId = r.output.trackId;
    }
    // A run waiting on production resumes by resuming that run, not by redoing
    // the stage — the stage re-runs only when production never started.
    const stage = retake ? 'song' : r.stage;
    return {
      status: 'running', awaiting: null, error: null, errorCode: null, processId: PROCESS_ID,
      ...(edits.suno || edits.localMusic !== undefined || grant || modelsPatch || limitsPatch ? { brief: {
        ...r.brief,
        ...(modelsPatch ? { models: modelsPatch } : {}),
        ...(limitsPatch ? { limits: limitsPatch } : {}),
        ...(edits.suno ? { suno: normalizeSunoOptions({ ...r.brief.suno, ...edits.suno }) } : {}),
        ...(edits.localMusic !== undefined ? { localMusic: normalizeLocalMusicOptions(edits.localMusic ? { ...r.brief.localMusic, ...edits.localMusic } : null) } : {}),
        ...(grant || {}),
      } } : {}),
      output: {
        ...(retake ? Object.fromEntries(SONG_OUTPUT_KEYS.map((key) => [key, null])) : {}),
        ...(typeof edits.lyrics === 'string' ? { lyrics: edits.lyrics } : {}),
        ...(typeof edits.style === 'string' && edits.style.trim() ? { sunoStyle: edits.style.trim() } : {}),
      },
      ...(retake
        ? { stage, ...stagePatch(r, stage, { status: 'pending', startedAt: null, finishedAt: null, error: null, step: null }) }
        : stagePatch(r, stage, { error: null })),
    };
  });
  if (retakenTrackId) await unlinkRunTrack(projectId, out.run.id, retakenTrackId);
  if (out.run.stage === 'produce' && out.run.output.finalAutoReviewId) {
    // The orchestrator's footage revision picks up where it stopped. One that
    // already ended (or a director finished) leaves a revised film to render
    // and review again; any other failure is the director's to see.
    const failure = await deps.resumeAutoReview(projectId, out.run.output.finalAutoReviewId).then(() => null, (err) => err);
    if (!failure) {
      const { project: next, run } = await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'running', step: FINAL_REVISION_STEP }));
      return { project: presentProjectAutonomousRun(next), run: presentAutonomousRun(run) };
    }
    if (!['AUTO_REVIEW_CLOSED', 'NOT_FOUND'].includes(failure.code)) {
      const parked = await park(projectId, 'needs-human', { error: trimTo(`The final revision could not resume: ${failure.message}`, 500), errorCode: failure.code || null });
      return { project: parked.project, run: presentAutonomousRun(parked.run) };
    }
    // A hand-off the director has not finished yet still holds its revision open.
    const { openAttemptRevisionId } = await import('./autoReview.js');
    if (openAttemptRevisionId(await getProject(projectId), out.run.output.finalAutoReviewId)) {
      const parked = await park(projectId, 'needs-human', { error: 'Finish or cancel the open revision of the final video first, then Resume.', errorCode: 'FINAL_REVISION_NEEDS_HUMAN' });
      return { project: parked.project, run: presentAutonomousRun(parked.run) };
    }
    const { run } = await patchRun(projectId, () => ({ output: { finalAutoReviewId: null } }));
    await startFinalRender(projectId, run);
    const latest = await getProject(projectId);
    return { project: presentProjectAutonomousRun(latest), run: presentAutonomousRun(projectAutonomousRun(latest)) };
  }
  if (out.run.stage === 'produce' && (out.run.output.renderJobId || out.run.output.productionDone)) {
    // Production (or the code render) already finished; only the final render is left.
    await reconcileFinalRender(projectId, { restart: true });
    const latest = await getProject(projectId);
    return { project: presentProjectAutonomousRun(latest), run: presentAutonomousRun(projectAutonomousRun(latest)) };
  }
  if (out.run.stage === 'produce' && out.run.output.productionRunId) {
    return resumeDelegatedProduction(projectId, out.run, { swapModels: modelsChanged, limits: edits.limits });
  }
  advanceInBackground(projectId);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

/**
 * The brief's models with a resume's per-tool swaps applied (null clears a pin), or null
 * when the resume names none. Only tools the brief already allows can be pinned.
 */
function briefModelsPatch(brief, models) {
  if (!models || !Object.keys(models).length) return null;
  const next = { ...(brief.models || {}) };
  for (const [tool, model] of Object.entries(models)) {
    if (!brief.tools.includes(tool)) throw runError(400, 'VALIDATION_ERROR', `The run does not use ${tool}`);
    if (model) next[tool] = model;
    else delete next[tool];
  }
  return next;
}

// Production runs that can still deliver the footage: live, parked or finished.
const ADOPTABLE_PRODUCTION = new Set(['running', 'completed', 'limit-reached', 'blocked', 'needs-replan', 'needs-human', 'stopped']);
const PRODUCTION_LIVE = new Set(['running', 'limit-reached', 'blocked', 'needs-replan', 'needs-human', 'stopped']);

/**
 * Hand a resumed run back to production. It follows the newest production run started
 * since the run began (the director may have replaced its own by hand) and resumes it
 * with any raised limits and swapped models, or finishes straight to the final render
 * when that run is already complete. No production run left to follow — or a model
 * swap on one that cannot resume — starts a new one from the brief by re-entering `produce`.
 */
async function resumeDelegatedProduction(projectId, run, { swapModels = false, limits } = {}) {
  const project = await getProject(projectId);
  const runs = Array.isArray(project.productionRuns) ? project.productionRuns : [];
  const current = runs.find((r) => r.id === run.output.productionRunId) || null;
  const newest = runs
    .filter((r) => ADOPTABLE_PRODUCTION.has(r.status) && String(r.createdAt || '') >= String(run.createdAt || ''))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  const adopt = swapModels && newest && !PRODUCTION_RESUMABLE_STATUSES.has(newest.status) ? null : newest;
  if (!adopt) {
    // Unlink first: the old run's own "canceled" event must no longer match this run.
    const out = await patchRun(projectId, (r) => ({ output: { productionRunId: null }, ...stagePatch(r, 'produce', { status: 'pending', error: null, step: null }) }));
    if (current && PRODUCTION_LIVE.has(current.status)) await deps.cancelProduction(projectId, current.id).catch(() => {});
    console.log(`🎬 Autonomous music video ${short(run.id)} starting a new production run${swapModels ? ' with the new models' : ''}`);
    advanceInBackground(projectId);
    return { project: out.project, run: presentAutonomousRun(out.run) };
  }
  if (adopt.id !== run.output.productionRunId) {
    await patchRun(projectId, () => ({ output: { productionRunId: adopt.id } }));
    console.log(`🎬 Autonomous music video ${short(run.id)} adopted production run ${short(adopt.id)}`);
  }
  if (adopt.status === 'completed') {
    await finishFromProduction(projectId, adopt.id);
  } else {
    // Resuming a "running" run is safe and re-pins one left by a previous server process.
    const productionLimits = limits ? Object.fromEntries(Object.entries(limits).filter(([, v]) => v != null)) : undefined;
    const failure = await deps.resumeProduction(projectId, adopt.id, {
      acceptBasis: true,
      ...(productionLimits ? { limits: productionLimits } : {}),
      ...(swapModels ? { pool: briefProductionPool(run.brief, project) } : {}),
    })
      .then(() => null, (err) => err);
    if (failure) {
      const parked = await park(projectId, 'needs-human', { error: trimTo(`Production could not resume: ${failure.message}`, 500), errorCode: failure.code || null });
      return { project: parked.project, run: presentAutonomousRun(parked.run) };
    }
  }
  const latest = await getProject(projectId);
  return { project: presentProjectAutonomousRun(latest), run: presentAutonomousRun(projectAutonomousRun(latest)) };
}

// Read from the freshly patched record, so a job id stored a moment before the status flipped is seen.
const cancelLocalSongJob = (run) => (run.stage === 'song' && run.output.localSongJobId
  ? deps.cancelLocalSong(run.output.localSongJobId).catch(() => {})
  : null);

export async function stopAutonomousVideo(projectId) {
  const { run } = await requireRun(projectId);
  if (!['running', 'awaiting-approval', 'needs-human'].includes(run.status)) throw runError(409, 'NOT_RUNNING', `A ${run.status} run cannot be stopped`);
  const out = await patchRun(projectId, () => ({ status: 'stopped' }));
  if (run.output.productionRunId) {
    await deps.stopProduction(projectId, run.output.productionRunId).catch(() => {});
  }
  if (run.output.finalAutoReviewId) await deps.stopAutoReview(projectId, run.output.finalAutoReviewId).catch(() => {});
  sunoControllers.get(run.id)?.abort();
  await cancelLocalSongJob(out.run);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

export async function cancelAutonomousVideo(projectId) {
  const { run } = await requireRun(projectId);
  if (!(AUTONOMOUS_LIVE_STATUSES.includes(run.status) || run.status === 'failed')) throw runError(409, 'NOT_CANCELABLE', `A ${run.status} run cannot be canceled`);
  const out = await patchRun(projectId, () => ({ status: 'canceled', awaiting: null }));
  if (run.output.renderJobId) await deps.cancelRender(run.output.renderJobId).catch(() => {});
  if (run.output.finalAutoReviewId) await deps.cancelAutoReview(projectId, run.output.finalAutoReviewId).catch(() => {});
  if (run.output.productionRunId) {
    await deps.cancelProduction(projectId, run.output.productionRunId).catch(() => {});
  }
  sunoControllers.get(run.id)?.abort();
  await cancelLocalSongJob(out.run);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

// ---- production completion -------------------------------------------------------

const PRODUCTION_PARKED = new Set(['limit-reached', 'blocked', 'needs-replan', 'needs-human', 'stopped']);

/**
 * A production run this autonomous run delegated to advanced. Mirrors its
 * terminal state onto the run: completed → kick off the final render and
 * finish; failed → failed; any parked state → needs-human (resume continues it).
 */
async function onProductionEvent({ projectId, runId, run: production }) {
  // Production emits on every step; only a terminal or parked state concerns us, and
  // the project is read only once one arrives.
  if (!projectId || !(['completed', 'failed', 'canceled'].includes(production?.status) || PRODUCTION_PARKED.has(production?.status))) return;
  const project = await getProject(projectId).catch(() => null);
  const run = projectAutonomousRun(project);
  if (!run || run.stage !== 'produce' || run.output.productionRunId !== runId) return;
  if (!['running', 'needs-human'].includes(run.status)) return;
  const reason = trimTo(production.stopReason || production.error || '', 500);
  if (production.status === 'completed') {
    // A repeated completion event must not start a second render.
    if (run.output.renderJobId) return;
    await finishFromProduction(projectId, runId, { status: 'running', processId: PROCESS_ID });
  } else if (production.status === 'failed') {
    await park(projectId, 'failed', { error: reason || 'Production failed', errorCode: 'PRODUCTION_FAILED' });
  } else if (production.status === 'canceled') {
    // Production canceled on its own (not by canceling this run): park, so Resume can adopt
    // the director's replacement run or start a new one.
    await park(projectId, 'needs-human', { error: reason || 'Production was canceled', errorCode: 'PRODUCTION_CANCELED' });
  } else if (PRODUCTION_PARKED.has(production.status) && run.status === 'running') {
    await park(projectId, 'needs-human', { error: reason || `Production is ${production.status}`, errorCode: 'PRODUCTION_PARKED' });
  }
}

/**
 * The job id of a completed production run's own final render (code-first runs
 * render the accepted document themselves), or null when there is none or it is
 * no longer the project's current final video: a later render replaced it, the
 * selected document changed, or the film's dependencies moved since it rendered.
 */
function currentProductionRenderJobId(project, productionRunId) {
  const production = (project.productionRuns || []).find((r) => r.id === productionRunId);
  const render = production?.finalRender;
  if (render?.status !== 'completed' || !render.jobId || project.renderHistoryId !== render.jobId) return null;
  if (production.documentCheckpoint?.directory !== project.composition?.document?.directory) return null;
  return project.renderDependencies && !musicVideoDependencyChanges(project, project.renderDependencies).length ? render.jobId : null;
}

/**
 * Production completed: adopt its own final render when it is still current
 * (the reconcile then finishes on it, final review included), otherwise render
 * the film — legacy and footage-only runs leave no render behind.
 */
async function finishFromProduction(projectId, productionRunId, patch = {}) {
  const adopted = currentProductionRenderJobId(await getProject(projectId), productionRunId);
  await patchRun(projectId, () => ({ ...patch, output: { productionDone: true, ...(adopted ? { renderJobId: adopted } : {}) } }));
  if (adopted) console.log(`🎬 Autonomous music video adopted production's final render [${short(adopted)}]`);
  await reconcileFinalRender(projectId, { restart: true });
}

// ---- Cast & Sets completion ------------------------------------------------------

/**
 * Settle a run waiting on Cast & Sets from the project's own record: still
 * working → keep waiting; failed → park failed with its error; otherwise
 * (review/approved/skipped) re-enter `produce`, which now has a guide to review.
 */
async function reconcileCastAndSets(projectId) {
  const project = await getProject(projectId).catch(() => null);
  const run = projectAutonomousRun(project);
  if (!run || run.stage !== 'produce' || run.status !== 'running' || run.processId !== PROCESS_ID || run.stages.produce?.step !== CAST_STEP) return;
  const stage = project.castAndSets;
  if (CAST_SETS_WORKING.includes(stage?.status)) return;
  if (stage?.status === 'failed') {
    const error = trimTo(`Cast & Sets failed: ${stage.stopReason || stage.error || 'unknown error'}`, 500);
    await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'failed', error, step: null }));
    await park(projectId, 'failed', { error, errorCode: 'CAST_SETS_FAILED' });
    return;
  }
  advanceInBackground(projectId);
}

musicVideoEvents.on('cast-and-sets', ({ projectId }) => {
  if (!projectId) return;
  reconcileCastAndSets(projectId).catch((err) => console.error(`❌ Autonomous music video could not settle on Cast & Sets: ${err.message}`));
});

// ---- final render completion -----------------------------------------------------

/** Park the run as failed on its final render, with the stage marked failed so Retry re-renders only. */
async function failFinalRender(projectId, message, errorCode = 'FINAL_RENDER_FAILED') {
  const error = trimTo(message, 500);
  await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'failed', error, step: null }));
  await park(projectId, 'failed', { error, errorCode });
}

// projectId -> the final review in flight, so a render event and a reconcile
// that both see the finished render share one look instead of reviewing twice.
const finalReviews = new Map();

async function completeFinalRender(projectId, run) {
  if (isOrchestratedRun(run) && run.output.finalReviewedJobId !== run.output.renderJobId) {
    if (finalReviews.has(projectId)) return finalReviews.get(projectId);
    const review = (async () => {
      await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'running', step: 'final-review' }));
      const next = await orchestrateFinal(projectId, run);
      await patchRun(projectId, () => ({ output: { finalReviewedJobId: run.output.renderJobId || null } }));
      return next;
    })();
    finalReviews.set(projectId, review);
    let next;
    try { next = await review; } finally { finalReviews.delete(projectId); }
    // Stopped or canceled while the orchestrator watched: leave that state alone.
    if ((await latestRun(projectId))?.status !== 'running') return;
    // A revision: the re-rendered film comes back here for the next review.
    if (next === 'rerender') return startFinalRender(projectId, run);
    if (next === 'wait') return;
  }
  await patchRun(projectId, (r) => ({
    status: 'completed',
    ...stagePatch(r, 'produce', { status: 'done', finishedAt: new Date().toISOString(), error: null, step: null }),
    error: null, errorCode: null,
  }));
  console.log(`✅ Autonomous music video ${short(run.id)} finished — final video rendered`);
}

/** The run, when it is live on its produce stage waiting for the final render (job id or not yet started). */
const runAwaitingRender = (project) => {
  const run = projectAutonomousRun(project);
  return run && run.stage === 'produce' && run.status === 'running' && (run.output.renderJobId || run.output.productionDone) ? run : null;
};

/**
 * Settle a run waiting on its final render from the project's own record — the
 * race where the render ended before its job id was stored, and a resume after
 * a restart (the job died with the process). Still rendering → keep waiting;
 * `renderHistoryId` equal to the job id → it finished; otherwise it failed, or
 * with `restart` (an explicit resume, or production just completed) render again.
 */
async function reconcileFinalRender(projectId, { restart = false } = {}) {
  const project = await getProject(projectId).catch(() => null);
  const run = runAwaitingRender(project);
  if (!run) return;
  const jobId = run.output.renderJobId || null;
  if (jobId && (project.status === 'rendering' || (await deps.activeRenderJobId(projectId)) === jobId)) {
    await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'running', step: RENDER_STEP }));
    return;
  }
  if (jobId && project.renderHistoryId === jobId) return completeFinalRender(projectId, run);
  if (!restart) return failFinalRender(projectId, project.renderError || 'The final render did not finish');
  return startFinalRender(projectId, run);
}

/** Render the film (again) and wait for the render's own event. */
async function startFinalRender(projectId, run) {
  const render = await deps.renderVideo(projectId).catch((err) => ({ error: err }));
  if (render.error) return failFinalRender(projectId, `The final render did not start: ${render.error.message}`, render.error.code || 'FINAL_RENDER_FAILED');
  await patchRun(projectId, (r) => ({ output: { renderJobId: render.jobId || null }, ...stagePatch(r, 'produce', { status: 'running', error: null, step: RENDER_STEP }), error: null, errorCode: null }));
  console.log(`🎬 Autonomous music video ${short(run.id)} is rendering the final video`);
  // A render that settled before its id was stored.
  await reconcileFinalRender(projectId);
}

/**
 * The orchestrator's footage revision ended. One that handed off to a human
 * (`needs-human`) or failed leaves its revision open, so the run parks with the
 * reason and keeps the revision's id: Resume, once the director has finished
 * it, renders and reviews the film again. Otherwise the film is rendered again
 * for the next final review; a run it left resumable (stopped or
 * limit-reached) is closed first so it does not hold the revision slot.
 */
async function onAutoReviewEvent({ projectId, runId, run: review }) {
  if (!projectId || !runId || !review || review.status === 'running') return;
  const project = await getProject(projectId).catch(() => null);
  const run = runAwaitingRender(project);
  if (!run || run.output.finalAutoReviewId !== runId || run.stages.produce?.step !== FINAL_REVISION_STEP) return;
  if (['needs-human', 'failed'].includes(review.status)) {
    const reason = [review.stopReason, review.error].find((v) => typeof v === 'string' && v.trim()) || `the revision ${review.status === 'failed' ? 'failed' : 'needs a director'}`;
    await park(projectId, 'needs-human', { error: trimTo(`The revision of the final video was left for a director: ${reason}`, 500), errorCode: 'FINAL_REVISION_NEEDS_HUMAN' });
    return;
  }
  await patchRun(projectId, () => ({ output: { finalAutoReviewId: null } }));
  if (['stopped', 'limit-reached'].includes(review.status)) {
    await deps.cancelAutoReview(projectId, runId).catch((err) => console.warn(`⚠️ Autonomous music video ${short(run.id)} could not close its revision: ${trimTo(err.message, 200)}`));
  }
  console.log(`🎬 Autonomous music video ${short(run.id)} revision ${review.status}; rendering the film again`);
  await startFinalRender(projectId, run);
}

async function onRenderEvent({ projectId, jobId, status, error }) {
  if (!projectId || !jobId) return;
  const project = await getProject(projectId).catch(() => null);
  const run = runAwaitingRender(project);
  if (!run || run.output.renderJobId !== jobId) return;
  if (status === 'completed') return completeFinalRender(projectId, run);
  return failFinalRender(projectId, error || (status === 'canceled' ? 'The final render was cancelled' : 'The final render failed'));
}

musicVideoEvents.on('render', (event) => {
  onRenderEvent(event).catch((err) => console.error(`❌ Autonomous music video could not settle on its final render: ${err.message}`));
});

musicVideoEvents.on('auto-review', (event) => {
  onAutoReviewEvent(event).catch((err) => console.error(`❌ Autonomous music video could not settle on its final revision: ${err.message}`));
});

musicVideoEvents.on('production', (event) => {
  onProductionEvent(event).catch((err) => console.error(`❌ Autonomous music video could not settle on production: ${err.message}`));
});

/**
 * Resolves once no background advance loop is in flight, including one a
 * resume started while the previous settled. Bounded, so a stage that never
 * returns fails the caller's teardown loudly instead of hanging it.
 */
async function settleBackground(timeoutMs = 10_000) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Autonomous advance did not settle within ${timeoutMs}ms`)), timeoutMs); });
  try {
    await Promise.race([(async () => { while (inflight.size) await Promise.allSettled([...inflight.values()]); })(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export const __testing = { onProductionEvent, onRenderEvent, onAutoReviewEvent, advance, settleBackground };
