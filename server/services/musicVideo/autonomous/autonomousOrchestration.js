/** Reviews, repairs and settlement at the autonomous run checkpoints. */

import { musicVideoMediaMode } from '../../../lib/musicVideo/musicVideoMediaPolicy.js';
import {
  alignmentBasisMatches,
  carryProductionApprovals,
  nameShots,
  productionAlignmentBasis,
  productionReadiness,
  productionReviewBasis,
} from '../productionReview.js';
import { hasPlayableLyricWordTimings } from '../timedText.js';
import { applyTreatmentPatch, applyTreatmentToProject } from '../treatment.js';
import {
  codeFirstProductionAssets,
  normalizeMusicVideoProductionPolicy,
} from '../../../lib/musicVideo/musicVideoMediumPlan.js';
import { randomUUID } from 'crypto';
import { trimTo } from '../../../lib/textUtils.js';
import { canonicalSnapshotChecksum } from '../../../lib/snapshotChecksum.js';
import { PRODUCTION_TRANSIENT_RETRIES, acceptProductionPilot, transientProductionRetry } from '../production.js';
import { currentPilotPass, pilotInputBasis, pilotRepair } from '../productionPilot.js';
import {
  AUTONOMOUS_DEFAULT_LIMITS,
  autonomousMedium,
  isOrchestratedRun,
  ORCHESTRATOR_REVIEW_LOG_MAX,
  normalizeAutoApprove,
} from '../../../lib/musicVideo/musicVideoAutonomous.js';
import { getProject } from '../projects.js';
import { ensureSceneTakes } from '../takes.js';
import { musicVideoDependencyChanges } from '../../../lib/musicVideo/musicVideoDependencies.js';
import {
  mutateProjectRecord,
  PROCESS_ID,
  short,
  deps,
  runError,
  projectAutonomousRun,
  latestRun,
  patchRun,
  stagePatch,
  park,
  llmOf,
  ownsProduction,
} from './autonomousRunStore.js';

export const autoApproves = (run, stage) => normalizeAutoApprove(run.brief.autoApprove).includes(stage);

/** Approve `stage` for the run when the brief allows it and its readiness is clean; returns the fresh project. */
async function autoApproveStage(project, run, stage) {
  if (!autoApproves(run, stage)) return project;
  const readiness = productionReadiness(project);
  if (readiness[stage].approved || readiness[stage].problems.length) return project;
  const blocker = stageBlockers(project, run, stage)[0];
  if (blocker) {
    console.warn(`⚠️ Autonomous music video ${short(run.id)} left the ${stage} unapproved: ${trimTo(blocker, 200)}`);
    return project;
  }
  await deps.approveProductionReview(project.id, { stage, basis: readiness.basis[stage], approvedBy: 'autopilot',
    reviewer: { kind: 'autopilot', runId: run.id, authorizedBy: run.brief.autoApproveAuthorizedBy || null } });
  console.log(`🤖 Autonomous music video ${short(run.id)} auto-approved ${stage} (brief.autoApprove)`);
  return getProject(project.id);
}

// ---- orchestrated mode (brief.orchestrator) --------------------------------------
// The orchestrator stands in for the director at each review point. A review is
// one provider call; a revision is applied and judged again until it approves or
// `limits.maxReviewAttempts` revisions of that checkpoint are spent — then a
// text checkpoint accepts the last version and the log says so, while an art or
// storyboard gate with changes still asked for parks for the director with them
// named. Revisions are counted from the
// persisted log, so a retried stage cannot buy itself a fresh allowance.

const reviewLimit = (run) => run.brief.limits?.maxReviewAttempts || AUTONOMOUS_DEFAULT_LIMITS.maxReviewAttempts;

const revisionsSpent = (run, checkpoint) => (run?.orchestration?.reviews || [])
  .filter((r) => r.checkpoint === checkpoint && (r.verdict === 'revise' || r.verdict === 'retake')).length;
const reviewModule = () => import('../orchestratorReview.js');
const ideaOf = (run) => ({ prompt: run.brief.prompt, guidance: run.brief.guidance || '' });
const orchestratorIdentity = (run, route) => ({ kind: 'orchestrator', runId: run.id,
  providerId: route?.providerId || run.brief.orchestrator.providerId, model: route?.model || run.brief.orchestrator.model || null,
  authorizedBy: run.brief.orchestratorAuthorizedBy || null });
// Who acts on the run's own change requests: its orchestrator, else the autopilot.
const runReviewer = (run) => (isOrchestratedRun(run) ? orchestratorIdentity(run)
  : { kind: 'autopilot', runId: run.id, authorizedBy: run.brief.autoApproveAuthorizedBy || null });

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

export async function orchestrateLyrics(projectId, run, lyrics) {
  const { buildLyricsReviewPrompt } = await reviewModule();
  return reviewUntilApproved(projectId, run, 'lyrics', {
    value: lyrics,
    prompt: (current) => buildLyricsReviewPrompt({ ...ideaOf(run), title: run.output.title, description: run.output.musicalDescription, lyrics: current }),
    apply: (review) => review.lyrics || null,
    persist: (revised) => ({ lyricsForReview: revised }),
  });
}

/** The sound & look, judged before the song is made and the mood board created from it. */
export async function orchestrateStyle(projectId, run) {
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

export const cueText = (cue) => (typeof cue?.text === 'string' ? cue.text.trim() : '');
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
  const ownSpan = (cue) => validSpan(cue.startSec, cue.endSec) && cue.endSec <= durationSec;
  const needs = cues.map((cue, i) => wordsOf[i].length > 0 && !hasPlayableLyricWordTimings(cue, durationSec));
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
export async function alignRunLyrics(projectId, run) {
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
export async function orchestrateSong(projectId, run) {
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
export async function settleLyricTiming(projectId, run) {
  const orchestrated = isOrchestratedRun(run);
  const record = (verdict, notes) => (orchestrated
    ? recordReview(projectId, { checkpoint: 'alignment', verdict, score: null, notes, route: null, visual: false }) : null);
  const project = await getProject(projectId);
  const draft = project.productionReview?.draft;
  if (!draft || draft.storyboardSource === 'document') return;
  const status = productionReadiness(project).alignment.status;
  if (status === 'verified' || status === 'instrumental') return;
  const reviewer = runReviewer(run);
  const cues = (project.lyricCues || []).filter((c) => cueText(c));
  if (!cues.length) {
    if (!run.brief.instrumental) return;
    await mutateProjectRecord(projectId, (current) => ({ project: { ...current, productionReview: { ...current.productionReview,
      draft: { ...current.productionReview.draft, lyricsMode: 'instrumental', timingNotes: 'Instrumental song: no lyric timing to verify.' } } } }));
    await record('approve', 'Instrumental song: no lyric timing to verify.');
    return;
  }
  const timed = cues.filter((c) => hasPlayableLyricWordTimings(c, project.audioAnalysis?.durationSec)).length;
  if (timed < cues.length) {
    const notes = `Only ${timed} of ${cues.length} lyric lines have playable word timings. A director needs to repair the remaining lines.`;
    await record('revise', notes);
    return notes;
  }
  // A reused song's timing a director already verified on its source project, untouched since.
  const reusedBasis = run.brief.songFrom?.verifiedAlignmentBasis;
  if (alignmentBasisMatches(project, reusedBasis)) {
    const notes = 'Lyric timing carried over unchanged from the source project, where it was verified.';
    await deps.verifyAlignment(projectId, { basis: reusedBasis, notes, reviewer });
    await record('approve', notes);
    return;
  }
  const words = cues.flatMap((c) => c.words || []);
  const matched = words.filter((w) => w.conf === 'matched').length;
  const notes = `Checked by the ${orchestrated ? 'orchestrator' : 'autopilot'}: ${timed} of ${cues.length} lines carry word timings; ${matched} of ${words.length} words were heard by the recognizer, the rest interpolated.`;
  const failedAlignment = projectAutonomousRun(project)?.output?.alignmentError;
  const alignmentError = alignmentBasisMatches(project, failedAlignment?.basis) ? failedAlignment.message : null;
  const held = alignmentError ? `Lyric alignment failed (${alignmentError}), so these timings are guesses; a director needs to listen and verify them.`
    : matched / words.length < MIN_HEARD_WORD_SHARE ? 'Too little of the vocal was heard to trust these timings; a director needs to listen and verify them.'
      : null;
  if (held) {
    await record('revise', `${notes} ${held}`);
    return `${notes} ${held}`;
  }
  await deps.verifyAlignment(projectId, { basis: productionAlignmentBasis(project), notes, reviewer });
  await record('approve', notes);
}

/** Anchor every storyboard shot to the lyric lines it overlaps (the "Review lyric anchors" chore). */
export async function anchorStoryboardLyrics(projectId) {
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

const ART_REVIEW_PLATES = 6;

/** The Cast & Sets renders the art review looks at: the character sheet first, then the plates in plan order. */
async function castAndSetsImagePaths(project) {
  const stage = project.castAndSets || {};
  const keys = Object.keys(stage.images || {}).filter((key) => stage.images[key]?.status === 'done' && stage.images[key].imageId)
    .sort((a, b) => Number(stage.plan?.[b]?.kind === 'character') - Number(stage.plan?.[a]?.kind === 'character'));
  const paths = [];
  for (const key of keys) {
    if (paths.length >= ART_REVIEW_PLATES) break;
    const path = await deps.galleryImagePath(stage.images[key].imageId).catch(() => null);
    if (path) paths.push(path);
  }
  return paths;
}

async function reviewArt(run, project) {
  const { buildArtReviewPrompt } = await reviewModule();
  const draft = project.productionReview?.draft || {};
  const guide = project.devArtifacts?.find((a) => a.id === draft.guideArtifactId && !a.deleted);
  const image = guide?.mimeType?.startsWith('image/') ? await deps.guideImagePath(guide).catch(() => null) : null;
  const images = [...(image ? [image] : []), ...await castAndSetsImagePaths(project)];
  // The sheet and plates are not redrawn after a text revision, so a re-review is told they show the earlier text.
  const sheetPredatesEdits = images.length > 0 && revisionsSpent(await latestRun(project.id), 'art') > 0;
  return askReview(run, 'art', buildArtReviewPrompt({ ...ideaOf(run), concept: project.concept, draft, hasImage: images.length > 0, sheetPredatesEdits }), images);
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

async function fileReviseAndClose(projectId, { requests, revise, resolutionFor, reviewer }) {
  const feedbackIds = [];
  for (const request of requests) {
    const { feedbackId } = await deps.addFeedback(projectId, request);
    feedbackIds.push(feedbackId);
  }
  const failure = await revise().then(() => null, (err) => err);
  for (const feedbackId of feedbackIds) {
    try {
      await deps.closeFeedback(projectId, { feedbackId, resolution: resolutionFor(failure), reviewer });
    } catch (err) {
      // Only tolerate a reviewer resolving this run's request while revision was in flight.
      const entry = err.code === 'MUSIC_VIDEO_FEEDBACK_CLOSED'
        ? (await getProject(projectId)).productionReview?.feedback?.find((item) => item.id === feedbackId) : null;
      if (!entry?.resolvedAt) throw err;
      console.warn(`🎬 Autonomous feedback ${feedbackId} was already resolved; preserving its resolution`);
    }
  }
  return failure;
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
  const basis = productionReviewBasis(project).storyboard;
  const { route, ...plan } = await llmOf(run, 'plan');
  const failure = await fileReviseAndClose(projectId, {
    requests: changes.map((change) => ({ stage, basis, target: change.sceneId, text: change.text, decision: 'request-changes' })),
    revise: () => deps.reviseFromFeedback(projectId, { stage, ...plan }),
    resolutionFor: (error) => error ? `The re-plan failed (${trimTo(error.message, 200)}); the orchestrator will ask again on Retry.` : 'Revised by the orchestrator.',
    reviewer: orchestratorIdentity(run, review.route),
  });
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
    // Out of revisions with changes still asked for: the director decides, never a silent approval.
    if (review.verdict === 'revise' && spent >= reviewLimit(run) && review.changes.length) {
      const open = review.changes.map((c) => `${c.field || c.sceneId}: ${c.text}`);
      await recordReview(project.id, reviewEntry(stage, review, { verdict: 'revise',
        notes: `Revision limit reached; left for the director. ${review.notes || ''}`.trim(), changes: open.map((line) => trimTo(line, 300)) }));
      throw runError(409, 'MUSIC_VIDEO_APPROVAL_REQUIRED', trimTo(`The orchestrator still wants changes to the ${stage} after ${spent} revision${spent === 1 ? '' : 's'}: ${open.join(' · ')} Approve the ${stage} yourself, or resume with more revisions per step.`, 500));
    }
    const readiness = productionReadiness(project);
    const why = review.verdict === 'revise' ? 'Nothing to revise was supplied; accepted as is. ' : '';
    const problem = readiness[stage].problems[0] || stageBlockers(project, run, stage)[0];
    if (problem) {
      await recordReview(project.id, reviewEntry(stage, review, { verdict: 'revise', notes: `Could not approve: ${trimTo(problem, 300)} ${review.notes || ''}`.trim() }));
      return project;
    }
    await deps.approveProductionReview(project.id, { stage, basis: readiness.basis[stage], approvedBy: 'orchestrator', reviewer: orchestratorIdentity(run, review.route) });
    await recordReview(project.id, reviewEntry(stage, review, { verdict: 'approve', notes: `${why}${review.notes || ''}`.trim() }));
    return getProject(project.id);
  }
}

/** The brief's prompt and guidance as production's planning directive. */
export const briefDirective = (brief) => trimTo([brief.prompt, brief.guidance].filter(Boolean).join('\n\n'), 4000);

/** The run renders its film from code alone rather than through production. */
export const rendersFromCode = (project, run) => musicVideoMediaMode(project) === 'code-only' || autonomousMedium(run.brief.tools) === 'code';


/**
 * A footage project left in document mode with no document (projects created
 * with a media mode used to default to it) cannot render; it is composed from its shots.
 */
export async function ensureFootageComposition(projectId) {
  const project = await getProject(projectId);
  const composition = project?.composition;
  if (composition?.mode !== 'document' || composition.document || composition.documentDraft
    || normalizeMusicVideoProductionPolicy(project.productionPolicy).strategy === 'code-first') return false;
  // The manifest is replaced whole, so its cues, cutting and grade ride along.
  await deps.updateProject(projectId, { composition: { ...composition, mode: 'composed' } });
  // No one reviewed this switch, so the approvals it would stale carry over.
  await mutateProjectRecord(projectId, (current) => ({ project: carryProductionApprovals(project, current, 'Composed the footage of a project with no composition document') }));
  console.log(`🎬 Autonomous music video set ${short(projectId)} to compose its footage (it had no composition document)`);
  return true;
}

/**
 * What would stop production of an approved storyboard: the code-first plan's
 * medium conflicts. Approving over them only moves the failure to
 * production, so a run that approves for the director leaves the gate closed.
 */
export const stageBlockers = (project, run, stage) => (stage === 'storyboard' && !rendersFromCode(project, run)
  ? codeFirstProductionAssets(project)?.conflicts || [] : []);

/**
 * A performance direction planned without footage (no video tool, or no
 * generated-video allowance left) blocks production until the plan is revised.
 * A run that approves the storyboard itself makes that revision as the
 * conflict asks: those shots become cutaways, and the plan is applied again.
 * Any other conflict is left for stageBlockers to name.
 */
async function reviseUnfilmablePerformances(project, run) {
  const ready = productionReadiness(project);
  if (ready.storyboard.approved || !ready.art.approved || !(isOrchestratedRun(run) || autoApproves(run, 'storyboard'))) return project;
  if (!stageBlockers(project, run, 'storyboard').length) return project;
  const sceneIds = (project.treatment?.shotDirections || [])
    .filter((d) => d.mode === 'performance' && !['existing-footage', 'generated-footage'].includes(d.medium)).map((d) => d.sceneId);
  if (!sceneIds.length) return project;
  const rationale = 'No footage is planned for this shot, so it is staged as a cutaway rather than a visible performance.';
  const revised = await mutateProjectRecord(project.id, (current) => {
    const patched = applyTreatmentPatch(current, { baseRevision: current.treatment?.revision ?? 0,
      shotDirections: sceneIds.map((sceneId) => ({ sceneId, mode: 'cutaway', rationale })) });
    return applyTreatmentToProject(patched, { revision: patched.treatment.revision });
  }).then(({ project: next }) => next, (err) => {
    console.warn(`⚠️ Autonomous music video ${short(run.id)} could not re-plan ${sceneIds.length} performance shot(s): ${err.message}`);
    return null;
  });
  if (!revised) return project;
  const note = `Re-planned ${sceneIds.length} performance shot${sceneIds.length === 1 ? '' : 's'} as cutaways: no footage is planned for them.`;
  if (isOrchestratedRun(run)) await recordReview(project.id, { checkpoint: 'storyboard', verdict: 'revise', notes: note });
  console.log(`🎬 Autonomous music video ${short(run.id)}: ${note}`);
  return revised;
}

/** Art and storyboard: the orchestrator when the run has one, else the operator's auto-approve grant. */
export const settleProductionStage = async (project, run, stage) => {
  if (stage === 'storyboard') project = await reviseUnfilmablePerformances(project, run);
  return isOrchestratedRun(run) ? orchestrateProductionStage(project, run, stage) : autoApproveStage(project, run, stage);
};

/**
 * Watch the finished film and send flagged sections back, as a director would:
 * a `revise` verdict with timecoded issues starts one revision (startFinalRevision)
 * while revisions remain; anything else is logged and the film is kept. Returns
 * 'rerender' (re-authored: render the film again), 'wait' (a footage revision
 * is under way) or null (keep this film).
 */
export async function orchestrateFinal(projectId, run) {
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

export const FINAL_REVISION_STEP = 'final-revision';
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
  const code = rendersFromCode(project, run);
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

async function reauthorFinal(projectId, run, issues, { target = 'final' } = {}) {
  const project = await getProject(projectId);
  const basis = productionReviewBasis(project).proof;
  const authoring = !run.brief.llmStages?.authoring && run.brief.authoring ? run.brief.authoring : await llmOf(run, 'authoring');
  const input = { providerId: authoring.providerId, model: authoring.model || undefined, ...(authoring.effort ? { effort: authoring.effort } : {}) };
  const failure = await fileReviseAndClose(projectId, {
    requests: issues.slice(0, 12).map((issue) => ({ stage: 'proof', basis, target: `${target}@${timecode(issue.atSec)}`, text: issue.text, decision: 'request-changes' })),
    revise: async () => {
      if ((await getProject(projectId)).composition?.mode === 'code') return deps.generateCode(projectId, input);
      const candidate = await deps.generateDocument(projectId, input);
      return deps.acceptDocument(projectId, candidate.document.directory);
    },
    resolutionFor: (error) => error ? `The re-authoring failed (${trimTo(error.message, 200)}); kept the film.`
      : `Re-authored by the ${isOrchestratedRun(run) ? 'orchestrator' : 'autopilot'}.`,
    reviewer: runReviewer(run),
  });
  if (failure) throw failure;
}

const TEXT_CHECK_STEP = 'text-check';
const TEXT_CHECKPOINT = 'text';
const textEntry = (verdict, notes, issues = []) => ({ checkpoint: TEXT_CHECKPOINT, verdict, score: null, notes, issues, route: null, visual: false });

/**
 * The overlay text pass before the film renders (overlayTextService.js): check
 * the composition document's text where it appears; when the run's own
 * generated document collides, runs off frame, blends in or is too small,
 * send the findings back to its author and check again, bounded by the run's
 * review attempts. A hand-made document is never rewritten (its findings are
 * logged for the director), and a check that cannot run never holds the
 * render. Returns false when the run stopped meanwhile.
 */
export async function settleOverlayText(projectId, run) {
  for (;;) {
    const project = await getProject(projectId);
    if (project?.composition?.mode !== 'document' || !project.composition.document?.directory) return true;
    await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'running', step: TEXT_CHECK_STEP }));
    const check = await deps.checkOverlayText(projectId).catch((err) => ({ status: 'failed', error: err.message }));
    if ((await latestRun(projectId))?.status !== 'running') return false;
    if (check?.status !== 'complete') {
      await recordReview(projectId, textEntry('noted', `The overlay text check could not run (${trimTo(check?.error || 'it was replaced by a newer check', 200)}); rendering anyway.`));
      return true;
    }
    const findings = check.findings || [];
    if (!findings.length) {
      await recordReview(projectId, textEntry('approve', `No overlay text problems in ${check.textSamples ?? 0} frames with text.`));
      return true;
    }
    const issues = findings.slice(0, 12).map((f) => ({ atSec: f.atSec, text: trimTo(f.message, 300) }));
    const generated = project.composition.document.source?.kind === 'generated';
    if (!generated || revisionsSpent(await latestRun(projectId), TEXT_CHECKPOINT) >= reviewLimit(run)) {
      await recordReview(projectId, textEntry('noted', generated ? 'Revision limit reached; rendering the latest document.' : 'This document was made by hand, so it is left for the director to fix; rendering it as is.', issues));
      return true;
    }
    try {
      await reauthorFinal(projectId, run, issues, { target: 'text' });
    } catch (err) {
      await recordReview(projectId, textEntry('noted', `The re-authoring did not go through (${trimTo(err.message, 200)}); rendering the current document.`, issues));
      return true;
    }
    await recordReview(projectId, textEntry('revise', `Sent ${issues.length} overlay text problem${issues.length === 1 ? '' : 's'} back to the document's author.`, issues));
  }
}

// ---- stills before video -----------------------------------------------------------
// A run that asked to stop before video, or whose tools make no video, has
// production make every still and stop before the first clip. The orchestrator
// then checks the stills and has the ones it flags regenerated, up to
// `limits.maxReviewAttempts` rounds; the run then waits on `stills` for the
// director, whose approval goes on to the clips.

const STILLS_BATCH = 6;
const STILL_FIXES_MAX = 1000;

/**
 * One review round over every still. Marks flagged stills for regeneration
 * (their fixes ride the next prompt) and returns those shots:
 * none once the rounds are spent, when the reviewer could not see the images,
 * or when a shot changed during the review. Null when a stop or
 * cancel released the run during the review, which then changes nothing.
 */
async function reviewStills(projectId, run, productionRunId) {
  const { buildStillsReviewPrompt } = await reviewModule();
  const project = await getProject(projectId);
  const shots = (project.scenes || []).filter((scene) => scene.referenceImageId);
  const issues = [];
  const reviews = [];
  let shown = 0;
  for (let i = 0; i < shots.length; i += STILLS_BATCH) {
    const listed = [];
    const images = [];
    for (const scene of shots.slice(i, i + STILLS_BATCH)) {
      const path = await deps.galleryImagePath(scene.referenceImageId).catch(() => null);
      if (path) { listed.push(scene); images.push(path); }
    }
    if (!listed.length) continue;
    const review = await askReview(run, 'stills', buildStillsReviewPrompt({ ...ideaOf(run), concept: project.concept,
      cast: project.productionReview?.draft?.cast || '',
      shots: listed.map((scene, n) => ({ image: n + 1, sceneId: scene.sceneId, label: scene.label || '', still: scene.framePrompt || scene.prompt || '' })) }), images);
    reviews.push(review);
    if (review.visual) shown += listed.length;
    // A review that could not see the stills cannot judge them.
    const known = new Set(listed.map((scene) => scene.sceneId));
    if (review.visual && review.verdict === 'revise') issues.push(...review.issues.filter((issue) => known.has(issue.sceneId)));
  }
  const spent = revisionsSpent(await latestRun(projectId), 'stills');
  const flagged = spent < reviewLimit(run) ? issues : [];
  if (!await ownsProduction(projectId, productionRunId)) return null;
  const fixes = new Map();
  for (const issue of flagged) fixes.set(issue.sceneId, [fixes.get(issue.sceneId), issue.text].filter(Boolean).join(' '));
  const at = new Date().toISOString();
  // Only repair the shots actually reviewed: a director may have changed a
  // selection while the reviewer was running. Keep it selected until its
  // replacement lands, and retain legacy selections in the take history.
  const reviewed = new Map(shots.map((scene) => [scene.sceneId, canonicalSnapshotChecksum(scene)]));
  const repair = fixes.size > 0 ? await mutateProjectRecord(projectId, (current) => {
    const latest = projectAutonomousRun(current);
    if (latest?.status !== 'running' || latest.processId !== PROCESS_ID || latest.output?.productionRunId !== productionRunId) {
      return { project: current, stopped: true };
    }
    const changed = [...fixes.keys()].some((id) => {
      const scene = (current.scenes || []).find((item) => item.sceneId === id);
      return !scene || canonicalSnapshotChecksum(scene) !== reviewed.get(id);
    });
    if (changed) return { project: current, rejected: true };
    return { project: { ...current, scenes: (current.scenes || []).map((scene) => (fixes.has(scene.sceneId)
      ? { ...scene, takes: ensureSceneTakes(scene), stillFixes: { text: trimTo(fixes.get(scene.sceneId), STILL_FIXES_MAX), at, pending: true, replaces: scene.referenceImageId } } : scene)) } };
  }) : null;
  if (repair?.stopped) return null;
  const refused = repair?.rejected === true;
  const regenerate = refused ? [] : flagged;
  const scored = reviews.map((r) => r.score).filter((n) => n != null);
  // Approval needs every still seen and nothing flagged; an inconclusive or unresolved round is not one.
  const conclusive = shots.length > 0 && shown === shots.length;
  const unresolved = issues.length > 0 && !regenerate.length;
  const why = !reviews.length ? 'No still could be shown to the reviewer. '
    : reviews.some((r) => !r.visual) ? 'The reviewer could not see every still. '
      : refused ? `${nameShots(project, [...fixes.keys()])} changed while the stills were being reviewed; review again before regenerating. `
        : unresolved ? 'Revision limit reached with changes still open. ' : '';
  await recordReview(projectId, { checkpoint: 'stills', verdict: regenerate.length || unresolved || !conclusive ? 'revise' : 'approve',
    score: scored.length ? Math.min(...scored) : null, route: reviews.at(-1)?.route || null, visual: reviews.length > 0 && reviews.every((r) => r.visual),
    notes: trimTo(`${why}${regenerate.length ? `Regenerating ${regenerate.length} still${regenerate.length === 1 ? '' : 's'}. ` : ''}${reviews.map((r) => r.notes).filter(Boolean).join(' ')}`, 1500),
    ...(regenerate.length || unresolved ? { changes: (regenerate.length ? regenerate : issues).map((issue) => trimTo(`${issue.sceneId}: ${issue.text}`, 300)) } : {}) });
  return regenerate;
}

/**
 * Production made every still. An orchestrated run reviews them and sends the
 * flagged ones back to production; otherwise (or once they pass) the run waits
 * on `stills` for the director.
 */
const settlingStills = new Set();

export async function settleStills(projectId, run, productionRunId) {
  // Production announces the stop more than once; one review round answers it.
  if (settlingStills.has(productionRunId)) return;
  settlingStills.add(productionRunId);
  try {
    await reviewOrPark(projectId, run, productionRunId);
  } catch (err) {
    if (await ownsProduction(projectId, productionRunId)) await park(projectId, 'needs-human', { error: trimTo(`The stills review failed: ${err.message}`, 500), errorCode: err.code || 'STILLS_REVIEW_FAILED' });
  } finally {
    settlingStills.delete(productionRunId);
  }
}

async function reviewOrPark(projectId, run, productionRunId) {
  if (isOrchestratedRun(run)) {
    const regenerate = await reviewStills(projectId, run, productionRunId);
    // A stop or cancel can also land while the repair and its review entry are written.
    if (!regenerate || !await ownsProduction(projectId, productionRunId)) return;
    if (regenerate.length) {
      await deps.resumeProduction(projectId, productionRunId, { acceptBasis: true, stopBefore: 'clips' });
      return;
    }
  }
  await park(projectId, 'awaiting-approval', { awaiting: 'stills' });
}

// ---- a blocked production run, settled by the run itself --------------------------
// A run set to approve does not stop production for the director: a staled art or
// storyboard approval is reviewed and approved again (settleProductionStage), and
// in an orchestrated run a failed pilot is repaired and generated again, up to
// `limits.maxReviewAttempts` repairs per pilot, then its last take is accepted
// with the open findings noted; a passing pilot is then approved as the proof
// from the pilot review's own evidence. Anything else parks for the director.

const CLIP_FIXES_MAX = 1000;
const settlingProduction = new Set();

/** A pilot whose review of its current inputs and media did not pass. */
function failedPilot(project, production) {
  for (const pilot of production.pilot?.scenes || []) {
    if (currentPilotPass(project, pilot)) continue;
    const review = (project.autoReviews || []).find((r) => r.id === pilot.reviewRunId);
    const result = review?.attempts?.at(-1)?.review;
    if (result && result.verdict !== 'pass' && !['running', 'stopped', 'limit-reached'].includes(review.status)
      && pilot.inputBasis === pilotInputBasis(project, pilot.sceneId)) return { pilot, result };
  }
  return null;
}

/** The review's own words for what failed: its reason and blocking findings. */
const pilotProblems = (result) => [...new Set([result.reason, ...(result.findings || [])
  .filter((f) => f.severity === 'blocking').map((f) => f.note)].filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))];

/**
 * Repair a failed pilot as its review asks: the fix rides the shot's next
 * prompt (a failed plate makes a new still too), which changes the pilot's
 * inputs so production makes it again and reviews the new take. Once the
 * pilot's repairs are spent, the last take is accepted with the findings noted.
 */
async function repairPilot(projectId, run, productionRunId, { pilot, result }) {
  const project = await getProject(projectId);
  const scene = (project.scenes || []).find((s) => s.sceneId === pilot.sceneId);
  if (!scene) return false;
  const repair = pilotRepair(result, scene, project);
  const problems = pilotProblems(result).join(' ') || `The pilot review returned ${result.verdict}.`;
  const spent = ((await latestRun(projectId))?.orchestration?.reviews || [])
    .filter((r) => r.checkpoint === 'pilot' && r.sceneId === pilot.sceneId && r.verdict === 'revise').length;
  if (spent < reviewLimit(run)) {
    const at = new Date().toISOString();
    const slot = repair.category === 'plate' ? 'stillFixes' : 'clipFixes';
    const sceneBasis = canonicalSnapshotChecksum(scene);
    const { rejected } = await mutateProjectRecord(projectId, (current) => {
      const latest = projectAutonomousRun(current);
      const live = (current.scenes || []).find((s) => s.sceneId === pilot.sceneId);
      if (!live || canonicalSnapshotChecksum(live) !== sceneBasis || latest?.status !== 'running'
        || latest.processId !== PROCESS_ID || latest.output?.productionRunId !== productionRunId
        || pilot.inputBasis !== pilotInputBasis(current, pilot.sceneId)
        || musicVideoDependencyChanges(current, result.dependencies).length) return { project: current, rejected: true };
      return { project: { ...current, scenes: (current.scenes || []).map((s) => {
        if (s.sceneId !== pilot.sceneId) return s;
        // Earlier fixes stay in the prompt so a repair never undoes the last one; the newest win the length cap.
        const text = [s[slot]?.text, problems].filter(Boolean).join(' ');
        return { ...s, ...(slot === 'stillFixes' ? { takes: ensureSceneTakes(s) } : {}), [slot]: {
          text: text.slice(-(slot === 'stillFixes' ? STILL_FIXES_MAX : CLIP_FIXES_MAX)), at,
          ...(slot === 'stillFixes' && s.referenceImageId ? { pending: true, replaces: s.referenceImageId } : {}),
        } };
      }) } };
    });
    if (rejected) {
      // Nothing landed, so production would make the same take again: leave it to the director.
      await recordReview(projectId, { checkpoint: 'pilot', sceneId: pilot.sceneId, verdict: 'revise',
        notes: trimTo(`Pilot ${scene.label || pilot.sceneId}: ${repair.category} repair not applied; ${nameShots(project, [pilot.sceneId])} changed during review. Review it again before regenerating. ${problems}`, 1500),
        changes: [trimTo(`${pilot.sceneId}: ${problems}`, 300)] });
      return false;
    }
    await recordReview(projectId, { checkpoint: 'pilot', sceneId: pilot.sceneId, verdict: 'revise',
      notes: trimTo(`Pilot ${scene.label || pilot.sceneId}: ${repair.category} repair (${spent + 1} of ${reviewLimit(run)}), generated again with the fix. ${problems}`, 1500),
      changes: [trimTo(`${pilot.sceneId}: ${problems}`, 300)] });
    return true;
  }
  const note = trimTo(`Revision limit reached; accepted the last take with open findings: ${problems}`, 1000);
  await mutateProjectRecord(projectId, (current) => acceptProductionPilot(current, productionRunId, pilot.sceneId, { by: 'orchestrator', note }));
  await recordReview(projectId, { checkpoint: 'pilot', sceneId: pilot.sceneId, verdict: 'approve', notes: note });
  return true;
}

/** Approve the rendered pilot as the proof, from the machine evidence of its passing (or accepted) review. */
async function approvePilotProof(projectId, run, production) {
  const project = await getProject(projectId);
  const pilots = production.pilot?.scenes || [];
  const readiness = productionReadiness(project);
  const excerpt = (project.excerpts || []).find((e) => e.id === project.productionReview?.proof?.excerptId);
  if (readiness.proof.approved || readiness.proof.problems.length || !excerpt?.filename
    || !pilots.length || !pilots.every((pilot) => currentPilotPass(project, pilot))) return false;
  const verdicts = pilots.map((pilot) => {
    const result = (project.autoReviews || []).find((r) => r.id === pilot.reviewRunId)?.attempts?.at(-1)?.review || {};
    const checks = Object.entries(result.checks || {}).map(([check, value]) => `${check} ${value}`);
    return { pilot, result, checks, accepted: result.verdict !== 'pass' };
  });
  const audio = ['audioSync', 'lipSync'];
  const visualReview = verdicts.map(({ pilot, result, checks, accepted }) => `Pilot ${pilot.sceneId} (${pilot.operation}): ${accepted ? 'accepted at the revision limit' : 'passed'}`
    + `${checks.length ? `; checks ${checks.join(', ')}` : ''}${result.reason ? `. ${result.reason}` : ''}`).join(' ');
  const audioReview = verdicts.map(({ pilot, result }) => `Pilot ${pilot.sceneId} audio: ${audio.map((check) => `${check} ${result.checks?.[check] || 'not checked'}`).join(', ')}`).join(' ');
  const open = verdicts.filter((v) => v.accepted).map((v) => v.pilot.accepted?.note).filter(Boolean);
  const limitations = trimTo(['Machine review of the rendered pilot by the run\'s orchestrator reviewer; no human playback.', ...open].join(' '), 4000);
  await deps.approveProductionReview(projectId, { stage: 'proof', basis: readiness.basis.proof, approvedBy: 'orchestrator', reviewer: orchestratorIdentity(run),
    proofReview: { method: 'machine', watchedWithAudio: false, excerptId: excerpt.id, filename: excerpt.filename,
      machineEvidence: { visualReview: trimTo(`Rendered pilot review. ${visualReview}`, 8000), audioReview: trimTo(`Audio checks from the pilot review. ${audioReview}`, 8000), limitations } } });
  await recordReview(projectId, { checkpoint: 'proof', verdict: 'approve', notes: trimTo(`Approved the rendered pilot from its review. ${limitations}`, 1500) });
  return true;
}

/**
 * Production stopped (`blocked`, or `stopped` by its draft review) on something
 * the run can settle itself. Returns true when it settled it and production
 * resumed; false parks the run for the director as before.
 */
export async function settleBlockedProduction(projectId, run, productionRunId) {
  if (settlingProduction.has(productionRunId)) return true;
  settlingProduction.add(productionRunId);
  try {
    let project = await getProject(projectId);
    const production = (project.productionRuns || []).find((r) => r.id === productionRunId);
    if (!production) return false;
    const orchestrated = isOrchestratedRun(run);
    const readiness = productionReadiness(project);
    const retry = production.status === 'blocked' && orchestrated ? transientProductionRetry(production) : null;
    let settled = false;
    if (production.status === 'stopped') {
      // Only the draft review's own refusal, never a director's stop: a footage
      // project made before it composed its shots has no document to render.
      settled = /no composition document/i.test(production.stopReason || '') && await ensureFootageComposition(projectId);
    } else if (retry) {
      // The machine failed, not the shot: generate it again, within the slot's retries.
      console.log(`🔁 Autonomous music video ${short(run.id)} retrying ${retry.map((s) => `${s.kind} ${s.sceneId}`).join(', ')} after a transient failure (up to ${PRODUCTION_TRANSIENT_RETRIES} retries)`);
      settled = true;
    } else if (!readiness.storyboard.approved && (orchestrated || autoApproves(run, 'storyboard'))) {
      project = await settleProductionStage(project, run, 'art');
      project = await settleProductionStage(project, run, 'storyboard');
      settled = productionReadiness(project).storyboard.approved;
    } else if (readiness.storyboard.approved && orchestrated) {
      const failed = failedPilot(project, production);
      settled = failed ? await repairPilot(projectId, run, productionRunId, failed) : await approvePilotProof(projectId, run, production);
    }
    if (!settled || !await ownsProduction(projectId, productionRunId)) return false;
    await deps.resumeProduction(projectId, productionRunId, { acceptBasis: true });
    return true;
  } catch (err) {
    console.warn(`⚠️ Autonomous music video ${short(run.id)} could not settle blocked production: ${err.message}`);
    return false;
  } finally {
    settlingProduction.delete(productionRunId);
  }
}
