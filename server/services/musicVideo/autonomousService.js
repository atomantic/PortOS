import { musicVideoMediaMode, musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';
import { prepareProductionReview } from './productionReviewService.js';
import { assertProductionApproval, productionAlignmentBasis, productionReadiness, productionReviewBasis } from './productionReview.js';

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
 * event. Either way `produce` stays running ("Rendering final video") until the
 * final render job settles over the `render` event: success completes the run,
 * failure parks it `failed` and Retry re-renders only. A run interrupted while
 * rendering re-checks `renderHistoryId` on resume (reattach, finish, or render
 * again). Only explicit start/resume requests begin work.
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
  createMoodBoard: async (spec) => (await import('./autonomousBoard.js')).createAutonomousMoodBoard(spec),
  generateSunoSong: async (fields, opts) => (await import('./autonomousSuno.js')).generateSunoSong(fields, opts),
  generateLocalSong: async (args) => (await import('./autonomousLocalSong.js')).generateLocalSong(args),
  cancelLocalSong: async (jobId) => (await import('../mediaJobQueue/index.js')).cancelJob(jobId),
  createTrack: async (input) => (await import('../trackAlbumMembership.js')).createTrackWithAlbum(input).then((r) => r.track),
  attachAudio: async (trackId, filename, take) => (await import('../trackAudioAttach.js')).attachAudioAsRender(trackId, filename, take),
  probeDuration: (filename) => probeVideoDuration(join(PATHS.music, filename)).catch(() => null),
  analyzeSong: async (projectId) => (await import('./projectAudio.js')).analyzeProjectSong(projectId),
  designCoverArt: async (projectId, input) => (await import('./coverArt.js')).designCoverArt(projectId, input),
  startProduction: async (...args) => (await import('./productionService.js')).startProduction(...args),
  generateDocument: async (...args) => (await import('./documentGeneration.js')).generateMixedMediaDocument(...args),
  acceptDocument: async (...args) => (await import('./documentGeneration.js')).acceptMixedMediaDocument(...args),
  generateCode: async (...args) => (await import('./codeGeneration.js')).generateMusicVideoCode(...args),
  renderVideo: async (...args) => (await import('./render.js')).renderMusicVideo(...args),
  activeRenderJobId: async (projectId) => (await import('./render.js')).getActiveRenderJobId(projectId),
  cancelRender: async (jobId) => (await import('./render.js')).cancelRender(jobId),
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

/**
 * Give a lyric line with no usable word timings evenly spaced words inside its
 * own span, else the gap its neighbours leave — what a director does by hand
 * after alignment skips a line. Returns the repaired cues and the line count.
 */
function repairLyricWordTimings(cues, durationSec) {
  let repaired = 0;
  const out = cues.map((cue, i) => {
    const words = cueText(cue).split(/\s+/).filter(Boolean);
    if (!words.length) return cue;
    const usable = Array.isArray(cue.words) && cue.words.length > 0 && cue.words.every((w) => validSpan(w.startSec, w.endSec))
      && validSpan(cue.startSec, cue.endSec) && cue.words.every((w) => w.startSec >= cue.startSec && w.endSec <= cue.endSec);
    if (usable) return cue;
    const prevEnd = i > 0 && Number.isFinite(cues[i - 1].endSec) ? cues[i - 1].endSec : 0;
    const nextStart = i < cues.length - 1 && Number.isFinite(cues[i + 1].startSec) ? cues[i + 1].startSec : durationSec;
    const [start, end] = validSpan(cue.startSec, cue.endSec) && cue.endSec <= durationSec ? [cue.startSec, cue.endSec] : [prevEnd, nextStart];
    if (!validSpan(start, end) || (end - start) / words.length < MIN_WORD_SEC) return cue;
    const step = (end - start) / words.length;
    const round = (n) => Math.round(n * 1000) / 1000;
    repaired += 1;
    return { ...cue, startSec: round(start), endSec: round(end),
      words: words.map((w, k) => ({ w, startSec: round(start + k * step), endSec: round(k === words.length - 1 ? end : start + (k + 1) * step), conf: 'interpolated' })) };
  });
  return { cues: out, repaired };
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
  let alignError = null;
  if (!run.brief.instrumental && (await getProject(projectId))?.lyricCues?.some((c) => cueText(c))) {
    await deps.alignLyrics(projectId).catch((err) => { alignError = err.message; });
    await mutateProjectRecord(projectId, (current) => {
      const { cues, repaired } = repairLyricWordTimings(current.lyricCues || [], current.audioAnalysis?.durationSec);
      return { project: repaired ? { ...current, lyricCues: cues } : current };
    });
  }
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
 * Verify the lyric timing for the storyboard gate. Alignment already ran at the
 * song checkpoint; this records the orchestrator's check of it (every line has
 * bounded word timings) as the verification a director gives by listening.
 * An instrumental is marked as one. Problems it cannot fix stay for readiness to name.
 */
async function orchestrateAlignment(projectId, run) {
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
    await recordReview(projectId, { checkpoint: 'alignment', verdict: 'approve', score: null, notes: 'Instrumental song: no lyric timing to verify.', route: null, visual: false });
    return;
  }
  const words = cues.flatMap((c) => c.words || []);
  const timed = cues.filter((c) => c.words?.length && validSpan(c.startSec, c.endSec)).length;
  const matched = words.filter((w) => w.conf === 'matched').length;
  const notes = `Checked by the orchestrator: ${timed} of ${cues.length} lines carry word timings; ${matched} of ${words.length} words were heard by the recognizer, the rest interpolated.`;
  if (timed < cues.length) {
    await recordReview(projectId, { checkpoint: 'alignment', verdict: 'revise', score: null, notes: `${notes} Lines without timings need a director.`, route: null, visual: false });
    return;
  }
  await deps.verifyAlignment(projectId, { basis: productionAlignmentBasis(project), notes, reviewer: orchestratorIdentity(run) });
  await recordReview(projectId, { checkpoint: 'alignment', verdict: 'approve', score: null, notes, route: null, visual: false });
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
async function orchestrateFinal(projectId, run) {
  const project = await getProject(projectId);
  const frames = await deps.finalReviewFrames(run.output.renderJobId).catch((err) => ({ images: [], frameTimes: [], facts: { error: err.message }, cleanup: async () => {} }));
  try {
    const { buildFinalReviewPrompt } = await reviewModule();
    const review = await askReview(run, 'final', buildFinalReviewPrompt({ ...ideaOf(run), concept: project?.concept, facts: frames.facts, frameTimes: frames.frameTimes }), frames.images);
    await recordReview(projectId, reviewEntry('final', review, { verdict: review.verdict === 'approve' ? 'approve' : 'noted',
      issues: review.issues || [], ...(frames.images.length ? {} : { notes: `Judged without frames (${frames.facts?.error || 'none could be captured'}). ${review.notes || ''}`.trim() }) }));
  } catch (err) {
    await recordReview(projectId, { checkpoint: 'final', verdict: 'noted', score: null, notes: `The final review could not run: ${trimTo(err.message, 300)}`, route: null, visual: false });
  } finally {
    await frames.cleanup?.().catch(() => {});
  }
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
  const step = (name) => patchRun(project.id, (r) => stagePatch(r, 'lyrics', { step: name }));
  let draft = review ? run.output.lyricsDraft : null;
  let draftRoute = review ? run.output.lyricsRoute : null;
  if (!draft) {
    if (review) await step('draft');
    const { route, ...llm } = await llmOf(run, 'lyrics');
    ({ lyrics: draft } = await deps.writeLyrics({ description, guidance, ...llm }));
    draftRoute = route;
    await recordRoute(project, 'lyrics', route);
    if (!review) return { output: { lyrics: draft, ...(route ? { lyricsRoute: route } : {}) } };
    await save({ output: { lyricsDraft: draft, ...(route ? { lyricsRoute: route } : {}) } });
  }
  await step('review');
  const { route, ...llm } = await llmOf(run, 'lyricsReview');
  const revised = await deps.reviewLyrics({ lyrics: draft, description, guidance, ...llm });
  await recordRoute(project, 'lyricsReview', route);
  return { output: {
    lyricsDraft: draft,
    lyrics: revised.lyrics,
    lyricsReviewNotes: revised.notes || '',
    ...(draftRoute ? { lyricsRoute: draftRoute } : {}),
    ...(route ? { lyricsReviewRoute: route } : {}),
  } };
}

async function createRunStyle({ project, run }) {
  if (musicVideoMediaMode(project) === 'code-only') {
    await deps.updateProject(project.id, { concept: { prompt: run.output.concept.prompt, style: run.output.concept.style || run.output.moodBoard?.stylePrompt || '' } });
    return { output: { moodBoardId: null } };
  }
  const board = run.output.moodBoard;
  const moodBoardId = run.brief.moodBoardId || run.output.moodBoardId || (await deps.createMoodBoard(board)).id;
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
    const artWasApproved = productionReadiness(project).art.approved;
    project = await settleProductionStage(project, run, 'art');
    if (!artWasApproved && productionReadiness(project).art.approved) {
      // Preparing stops at the art gate; with art approved it drafts the storyboard.
      await prepareProductionReview(project.id);
      project = await getProject(project.id);
    }
    if (isOrchestratedRun(run)) {
      await orchestrateAlignment(project.id, run);
      project = await getProject(project.id);
    }
    project = await settleProductionStage(project, run, 'storyboard');
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
      pool: autonomousPool(run.brief.tools, run.brief.models).filter((route) => musicVideoAllowsMedia(project, route.kind)),
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
        console.log(`🎬 Autonomous music video ${short(run.id)} handed ${stage} to ${result.step === RENDER_STEP ? 'the final render' : 'production'}`);
        // The render may have settled before its job id was stored on the run.
        if (result.step === RENDER_STEP) await reconcileFinalRender(projectId);
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
export async function startAutonomousVideo(input, { autoApproveAuthorized = false } = {}) {
  const brief = { ...normalizeAutonomousBrief(input), ...autoApproveGrant(input?.autoApprove, autoApproveAuthorized) };
  if (!brief.prompt) throw runError(400, 'VALIDATION_ERROR', 'A prompt is required');
  if (brief.orchestrator) Object.assign(brief, orchestratorGrant(autoApproveAuthorized));
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
  const resumable = AUTONOMOUS_LIVE_STATUSES.includes(run.status) || run.status === 'failed';
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
  assertResumable(run);
  // "Auto-approve the rest": replaces the brief's grant (an empty list clears it).
  const grant = edits.autoApprove !== undefined ? autoApproveGrant(edits.autoApprove, autoApproveAuthorized) : null;
  const retake = edits.retakeSong === true;
  if (retake) assertAtSongCheckpoint(run);
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
      ...(edits.suno || edits.localMusic !== undefined || grant ? { brief: {
        ...r.brief,
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
  if (out.run.stage === 'produce' && (out.run.output.renderJobId || out.run.output.productionDone)) {
    // Production (or the code render) already finished; only the final render is left.
    await reconcileFinalRender(projectId, { restart: true });
    const latest = await getProject(projectId);
    return { project: presentProjectAutonomousRun(latest), run: presentAutonomousRun(projectAutonomousRun(latest)) };
  }
  if (out.run.stage === 'produce' && out.run.output.productionRunId) {
    const { resumeProduction } = await import('./productionService.js');
    const failure = await resumeProduction(projectId, out.run.output.productionRunId, { acceptBasis: true }).then(() => null, (err) => err);
    if (failure) {
      // A failed or canceled production run cannot be resumed; say so rather than leave the run looking live.
      const parked = await park(projectId, 'needs-human', { error: trimTo(`Production could not resume: ${failure.message}`, 500), errorCode: failure.code || null });
      return { project: parked.project, run: presentAutonomousRun(parked.run) };
    }
    return { project: out.project, run: presentAutonomousRun(out.run) };
  }
  advanceInBackground(projectId);
  return { project: out.project, run: presentAutonomousRun(out.run) };
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
    const { stopProduction } = await import('./productionService.js');
    await stopProduction(projectId, run.output.productionRunId).catch(() => {});
  }
  sunoControllers.get(run.id)?.abort();
  await cancelLocalSongJob(out.run);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

export async function cancelAutonomousVideo(projectId) {
  const { run } = await requireRun(projectId);
  if (!(AUTONOMOUS_LIVE_STATUSES.includes(run.status) || run.status === 'failed')) throw runError(409, 'NOT_CANCELABLE', `A ${run.status} run cannot be canceled`);
  const out = await patchRun(projectId, () => ({ status: 'canceled', awaiting: null }));
  if (run.output.renderJobId) await deps.cancelRender(run.output.renderJobId).catch(() => {});
  if (run.output.productionRunId) {
    const { cancelProduction } = await import('./productionService.js');
    await cancelProduction(projectId, run.output.productionRunId).catch(() => {});
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
    await patchRun(projectId, () => ({ status: 'running', processId: PROCESS_ID, output: { productionDone: true } }));
    await reconcileFinalRender(projectId, { restart: true });
  } else if (production.status === 'failed') {
    await park(projectId, 'failed', { error: reason || 'Production failed', errorCode: 'PRODUCTION_FAILED' });
  } else if (production.status === 'canceled') {
    await park(projectId, 'canceled', { error: reason || null });
  } else if (PRODUCTION_PARKED.has(production.status) && run.status === 'running') {
    await park(projectId, 'needs-human', { error: reason || `Production is ${production.status}`, errorCode: 'PRODUCTION_PARKED' });
  }
}

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
      await orchestrateFinal(projectId, run);
      await patchRun(projectId, () => ({ output: { finalReviewedJobId: run.output.renderJobId || null } }));
    })();
    finalReviews.set(projectId, review);
    try { await review; } finally { finalReviews.delete(projectId); }
    // Stopped or canceled while the orchestrator watched: leave that state alone.
    if ((await latestRun(projectId))?.status !== 'running') return;
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
  const render = await deps.renderVideo(projectId).catch((err) => ({ error: err }));
  if (render.error) return failFinalRender(projectId, `The final render did not start: ${render.error.message}`, render.error.code || 'FINAL_RENDER_FAILED');
  await patchRun(projectId, (r) => ({ output: { renderJobId: render.jobId || null }, ...stagePatch(r, 'produce', { status: 'running', error: null, step: RENDER_STEP }), error: null, errorCode: null }));
  console.log(`🎬 Autonomous music video ${short(run.id)} is rendering the final video`);
  // A render that settled before its id was stored.
  await reconcileFinalRender(projectId);
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

export const __testing = { onProductionEvent, onRenderEvent, advance, settleBackground };
