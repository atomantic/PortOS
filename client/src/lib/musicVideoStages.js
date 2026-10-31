/**
 * Music Video page stages: the tab set, which stage a project is in, the one
 * "next action" the sticky header offers for it, and the project's generation
 * spend. Pure functions over the project record so the header, the progress
 * strip and the tests all read the same answer.
 */
import { composedDrawsLyrics, isLayeredComposition, isSelfDrawnLayer, sceneRenderReady, sceneVisualLayer } from './musicVideoLayers.js';
import {
  AUTONOMOUS_CHECKPOINT_LABELS, AUTONOMOUS_LYRICS_STEP_LABELS, AUTONOMOUS_SONG_STEP_LABELS, AUTONOMOUS_STATUS_LABELS,
} from './musicVideoAutonomous.js';
import { formatCount, formatDurationSec, formatTimecode } from '../utils/formatters.js';
import { isNonBlankStr } from './textUtils';
import { modeLabel } from './imageGenModes.js';
import { meteredModelLabel, meteredSceneTake } from './musicVideoShotTiming.js';
import { unlockedShots } from './musicVideoSceneAttention.js';
import { latestMusicVideoReviewDraft } from '../../../server/lib/musicVideoReviewDraft.js';
import { supersededStillsCheckpoint } from '../../../server/lib/musicVideoAutonomous.js';
import { FINISHED_OUTSIDE_RERENDER_NOTE, finishedOutside, finishedOutsideCovers } from '../../../server/lib/musicVideoFinishedOutside.js';
import { coldOpenScenes, normalizePreMusic, songScenes } from '../../../server/lib/musicVideoColdOpen.js';

/**
 * The steps of a music video, in the order the director decides them: the
 * story is planned shot by shot before the Look is cast. The
 * ids are the route's `:stage` values and stay stable across the relabel
 * (#10297 follow-up): Song is `setup`, Look is `cast-sets`, Storyboard (once
 * Plan) is `board`, Shots (once Make) is `produce` — each shot's still,
 * clip and locks, then the composition over them — and Final render is
 * `review`. `doneWhen` is the one line a step shows under its title.
 */
export const MUSIC_VIDEO_STAGES = [
  { id: 'setup', label: 'Song', title: 'Song', doneWhen: 'Done when the track is analyzed and every lyric word is timed to the vocal.' },
  { id: 'story', label: 'Story', title: 'Story', optional: true, doneWhen: 'Done when the story direction is ready; this step is optional.' },
  { id: 'board', label: 'Storyboard', title: 'Storyboard', doneWhen: 'Done when timed shots cover the whole song, each with its action, staging, camera and lyric.' },
  { id: 'cast-sets', label: 'Look', title: 'Look', doneWhen: 'Done when the art direction is written, a visual guide is chosen, and you approve it.' },
  { id: 'produce', label: 'Shots', title: 'Shots', doneWhen: 'Done when every shot is locked (a video shot: its still, then its clip) and the composition is ready.' },
  { id: 'review', label: 'Final render', title: 'Final render', doneWhen: 'Done when the full video is rendered from the approved plan and is up to date.' },
  { id: 'publish', label: 'Publish', title: 'Publish', doneWhen: 'Done when every platform you turned on has a post.' },
];

/**
 * Pages beside the steps: listed under them, unnumbered, and never a step the
 * project is "at". Assets is every still and clip made for the video.
 */
export const MUSIC_VIDEO_PAGES = [
  { id: 'assets', label: 'Assets', title: 'Assets' },
  { id: 'cleanup', label: 'Cleanup', title: 'Cleanup' },
];

// Old links name the Compose tab, which is now part of Shots; the new names work as links too.
const LEGACY_STAGE_IDS = { compose: 'produce', plan: 'board', storyboard: 'board', shots: 'produce' };


export const isStageId = (value) => MUSIC_VIDEO_STAGES.some((stage) => stage.id === value);

/** A production run in one of these states can still be resumed (or is live). */
export const RESUMABLE_RUN_STATUSES = new Set(['running', 'stopped', 'limit-reached', 'blocked', 'needs-replan', 'awaiting-video']);
// A stopped run that needs the director's attention rather than a click on Resume.
const RUN_BLOCKED_STATUSES = new Set(['limit-reached', 'blocked', 'needs-replan', 'needs-human', 'failed']);
const CAST_WORKING = new Set(['directing', 'imaging', 'assembling']);

/** The run worth showing: the live one, else the most recent. */
export const currentProductionRun = (project) => {
  const runs = Array.isArray(project?.productionRuns) ? project.productionRuns : [];
  return runs.find((r) => RESUMABLE_RUN_STATUSES.has(r.status)) || runs[runs.length - 1] || null;
};

/**
 * Current review guidance for a stopped approval-gated run; retain other failures.
 * Runs wait on art and storyboard only: the animated proof is optional.
 */
export function productionReviewStopGuidance(run, readiness, through = 'storyboard') {
  const reason = run?.stopReason || run?.error;
  if (!readiness || !reason || !['blocked', 'needs-human', 'stopped', 'failed'].includes(run.status)) return null;
  const approvalStop = run.errorCode === 'MUSIC_VIDEO_APPROVAL_REQUIRED'
    || /^(?:Review and approve the current art direction|A reviewer must approve the current|Lyric alignment is provisional or changed|Production review needs human approval)/.test(reason);
  if (!approvalStop) return null;
  const stages = ['art', 'storyboard', 'proof'];
  const stage = stages.slice(0, stages.indexOf(through) + 1).find(key => !readiness[key]?.approved);
  const current = stage ? readiness[stage].problems?.[0]
    || `Review and approve the current ${stage === 'art' ? 'art direction' : stage}.` : 'Review requirements are satisfied — ready to resume explicitly.';
  return { current, historical: current !== reason ? reason : null };
}

export function projectShotSummary(project) {
  const draft = project?.productionReview?.draft;
  const document = project?.composition?.mode === 'document' && draft?.storyboardSource === 'document';
  const count = (document ? draft.storyboard : project?.scenes)?.length || 0;
  return `${formatCount(count)} ${document ? 'document shot' : 'scene'}${count === 1 ? '' : 's'}`;
}

export const projectHasAudio = (project) => !!(project?.trackId || project?.uploadedAudioFilename);

const VIDEO_BACKEND_LABELS = { local: 'Local video', grok: 'Grok video', fal: 'fal.ai video' };
/** "Images: Local · Video: fal.ai video" — the project's saved image (frame) and video render services. */
export const projectServicesSummary = (project) => [
  `Images: ${project?.imageMode ? modeLabel(project.imageMode) : 'install default'}`,
  `Video: ${VIDEO_BACKEND_LABELS[project?.videoSettings?.backend] || 'install default'}`,
].join(' · ');

/**
 * What the project has spent on paid generation across its production runs,
 * against the cap that applies now: the live/latest run's, else the autopilot
 * brief's budget. `capUsd` is null when nothing caps it.
 */
export function projectSpend(project) {
  const runs = Array.isArray(project?.productionRuns) ? project.productionRuns : [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const autopilot = runs.reduce((sum, run) => sum + num(run?.usage?.spentUsd), 0);
  // #10157: board-started fal takes record the estimate they were priced at.
  let manual = 0;
  let autoReview = 0;
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    for (const take of Array.isArray(scene?.takes) ? scene.takes : []) {
      if (take?.spendKind === 'autoReview') autoReview += num(take.costUsd);
      else if (take?.spendKind === 'manual') manual += num(take.costUsd);
    }
  }
  const spentUsd = autopilot + manual + autoReview;
  const run = currentProductionRun(project);
  const runCap = run?.limits?.spendCapUsd;
  const briefCap = project?.automation?.budgetUsd;
  const capUsd = runCap != null ? runCap : (briefCap != null ? briefCap : null);
  return { spentUsd, capUsd, autopilot, manual, autoReview, total: spentUsd };
}

/**
 * What the project has spent on fal.ai, by model, from the estimates its paid
 * takes and production-run steps recorded: `{ totalUsd, models: [{ modelId,
 * label, usd, count }] }`, dearest first. `modelId` is null for spend recorded
 * before takes named their model. Estimates, not fal's invoice; a take pruned
 * from a full scene no longer counts.
 */
export function projectFalSpend(project) {
  const byModel = new Map();
  const add = (modelId, usd) => {
    if (!(Number.isFinite(usd) && usd > 0)) return;
    const key = modelId || null;
    const row = byModel.get(key) || { modelId: key, label: key ? meteredModelLabel(key) || key : 'Model not recorded', usd: 0, count: 0 };
    row.usd += usd;
    row.count += 1;
    byModel.set(key, row);
  };
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    for (const take of Array.isArray(scene?.takes) ? scene.takes : []) {
      if (take?.spendKind) add(take.costModelId, Number(take.costUsd));
    }
  }
  for (const run of Array.isArray(project?.productionRuns) ? project.productionRuns : []) {
    for (const step of Array.isArray(run?.steps) ? run.steps : []) {
      if ((step?.route?.mode === 'fal' || step?.route?.mode === 'runway') && step.status !== 'refused') add(step.costModelId || step.route.model, Number(step.costUsd));
    }
  }
  const models = [...byModel.values()].map((row) => ({ ...row, usd: Math.round(row.usd * 1e4) / 1e4 })).sort((a, b) => b.usd - a.usd);
  return { totalUsd: Math.round(models.reduce((sum, row) => sum + row.usd, 0) * 1e4) / 1e4, models };
}

/**
 * What generating the rest of the board takes (#10157): scenes still missing a
 * frame or a clip, the generation limit that covers them plus a 25% review
 * allowance, and the known fal.ai price of the missing clips. A frame, or a
 * clip on a route with no quote, counts as unpriced. Card and code shots in a
 * layered composition are drawn, not generated (#10297), so they need neither.
 */
export function boardJobEstimate(project) {
  const layered = isLayeredComposition(project);
  const scenes = (Array.isArray(project?.scenes) ? project.scenes : [])
    .filter((scene) => !isSelfDrawnLayer(sceneVisualLayer(scene, { layered })));
  const settings = project?.videoSettings || {};
  const missingFrames = scenes.filter((scene) => !scene?.referenceImageId).length;
  const missingClips = scenes.filter((scene) => !scene?.videoHistoryId);
  let knownUsd = 0;
  let unpriced = missingFrames;
  for (const scene of missingClips) {
    const cost = meteredSceneTake(settings.backend, { scene, videoSettings: settings, songDurationSec: project?.audioAnalysis?.durationSec ?? null })?.costUsd ?? null;
    if (Number.isFinite(cost)) knownUsd += cost;
    else unpriced += 1;
  }
  const jobs = missingFrames + missingClips.length;
  return { jobs, knownUsd, unpriced, suggestedMaxGenerations: Math.min(500, Math.max(1, Math.ceil(jobs * 1.25))) };
}

/**
 * Everything the docked preview can play, in the order it picks a default:
 * the final render (its resolved `finalVideoSrc`), the composition document,
 * then each finished draft excerpt, newest first. `leadWith` picks the
 * ordering: `"final"` (default) as above; `"drafts"` (Final render stage)
 * puts the drafts before the composition; `"storyboard"` (Plan and Shots
 * stages) puts the live document, then the animatic, first. A final render whose
 * inputs changed is labelled out of date. Last comes the storyboard animatic —
 * the song under each shot's frame or card — so a project with a track and
 * shots always has something to watch — and after it the lyric timing
 * playthrough once the words are aligned. Each entry has a stable `id` (the
 * `?play=` value) and a `label` for the source picker.
 */
export function listPreviewSources(project, { finalVideoSrc = null, leadWith = 'final' } = {}) {
  const sources = [];
  const final = project?.renderHistoryId && finalVideoSrc
    ? { id: 'final', kind: 'video', label: project.renderDependencyState?.status === 'stale' ? 'Final render (out of date)' : 'Final render', src: finalVideoSrc, startSec: 0, endSec: null }
    : null;
  const live = project?.composition?.mode === 'document' && project.composition.document
    ? { id: 'document', kind: 'document', label: 'Composition (live)' }
    : null;
  const drafts = (project?.excerpts || []).filter((e) => e.status === 'complete' && e.filename).reverse().map((excerpt) => ({
    id: `excerpt:${excerpt.id}`, kind: 'video', src: `/data/videos/${excerpt.filename}`,
    startSec: excerpt.startSec, endSec: excerpt.endSec,
    label: `${excerpt.dependencyState?.status === 'stale' ? 'Older draft' : 'Draft'} ${formatTimecode(excerpt.startSec)}–${formatTimecode(excerpt.endSec)} · ${excerpt.id.slice(-6)}`,
  }));
  // Final render is reviewed by watching its drafts until the final render exists.
  const ordered = leadWith === 'storyboard' ? [live, final, ...drafts] : leadWith === 'drafts' ? [final, ...drafts, live] : [final, live, ...drafts];
  sources.push(...ordered.filter(Boolean));
  if (projectHasAudio(project) && (project?.scenes || []).length > 0) {
    const animatic = { id: 'animatic', kind: 'animatic', label: 'Storyboard animatic' };
    // On Storyboard the storyboard itself leads (the live document, else the animatic): a draft
    // clip covers only its own range, so most shots could not be played from it.
    if (leadWith === 'storyboard') sources.splice(live ? 1 : 0, 0, animatic);
    else sources.push(animatic);
  }
  // The aligned words over a plain frame, for checking timing before there is any picture.
  if (projectHasAudio(project) && project.audioAnalysis
    && (project.lyricCues || []).some((cue) => typeof cue.startSec === 'number' && isNonBlankStr(cue.text))) {
    const lyrics = { id: 'lyrics', kind: 'lyrics', label: 'Lyric timing' };
    // On Song the words are being checked: lead with them. The animatic and renders
    // follow the lyric overlay setting, so with overlays off they show no words.
    if (leadWith === 'lyrics') sources.unshift(lyrics);
    else sources.push(lyrics);
  }
  return sources;
}

// A stopped run can be resumed as is; the others need the director first.
const PRODUCTION_RUN_LABELS = {
  running: 'Production running', stopped: 'Production paused', blocked: 'Production blocked',
  'limit-reached': 'Production at its limit', 'needs-replan': 'Production needs a replan', 'awaiting-video': 'Production stills done',
};

/**
 * One reading of the autonomous run for the header chip, the busy/resume action
 * and the Song checklist: `running`, `awaiting` (a checkpoint waits on the
 * director), `paused` (interrupted, stopped or needs attention), `failed`, or
 * `inactive` (none, finished or cancelled). While running, `step` is the current
 * step's label: the lyrics or song step, else the checkpoint stage's name.
 */
function autonomousRunPhase(auto) {
  if (!auto || auto.status === 'completed' || auto.status === 'canceled') return { phase: 'inactive', step: null };
  if (auto.status === 'awaiting-approval') return { phase: 'awaiting', step: null };
  if (auto.status === 'running' && !auto.interrupted) {
    const step = auto.stages?.[auto.stage]?.step;
    return { phase: 'running', step: (auto.stage === 'lyrics' && AUTONOMOUS_LYRICS_STEP_LABELS[step])
      || (auto.stage === 'song' && AUTONOMOUS_SONG_STEP_LABELS[step])
      || AUTONOMOUS_CHECKPOINT_LABELS[auto.stage] || null };
  }
  return { phase: auto.status === 'failed' && !auto.interrupted ? 'failed' : 'paused', step: null };
}

const AUTONOMOUS_SONG_DETAILS = {
  running: 'The autonomous run is making the song.',
  awaiting: 'The autonomous run is waiting for your approval.',
  paused: 'The autonomous run is paused. Resume it to make the song.',
};

/** The Cast & Sets sheet's state: `absent`, `building`, `stopped`, `review` (check-in open) or `settled`. */
function castSetsPhase(cast) {
  if (!cast) return 'absent';
  if (cast.status === 'review') return 'review';
  if (cast.interrupted || cast.status === 'failed') return 'stopped';
  return CAST_WORKING.has(cast.status) ? 'building' : 'settled';
}

/**
 * Scene footage gates Produce: a footage mode needs at least one scene and every
 * scene render-ready; modes that draw their own picture skip the gate.
 */
function footageReady(project) {
  if (FOOTAGE_OPTIONAL_MODES.has(project?.composition?.mode || 'concat')) return true;
  const scenes = project?.scenes || [];
  const layered = isLayeredComposition(project);
  return scenes.length > 0 && scenes.every((scene) => sceneRenderReady(scene, { layered }));
}

/**
 * Whether the header sends the director to an approval panel: the project has a
 * track and analysis, something is left to approve (or a pilot proof is parked),
 * and nothing else owns the header (a render, kickoff, running production, the
 * Cast & Sets build, or a stage action of its own).
 */
function shouldJumpToReview(project, { run, art, board, pilotParked, busy, ownAction }) {
  return !busy && !ownAction && !finishedOutside(project) && projectHasAudio(project) && !!project.audioAnalysis
    && !CAST_WORKING.has(project.castAndSets?.status) && (art || board || pilotParked) && run?.status !== 'running';
}

const autonomousChipLabel = (auto, { phase, step }) => {
  if (phase === 'running') return step ? `Autonomous run: ${step.toLowerCase()}` : 'Autonomous run running';
  return `Autonomous run ${auto.interrupted ? 'interrupted' : (AUTONOMOUS_STATUS_LABELS[auto.status] || auto.status).toLowerCase()}`;
};

/**
 * What the header's Autopilot button says: the autonomous run's current step or
 * state, else a live or parked production run, else just "Autopilot". Tones are
 * `ok`, `warn` or `muted`; `short` is the phone label.
 */
export function autopilotStatus(project, readiness = project?.productionReadiness) {
  const auto = supersededStillsCheckpoint(project, readiness) ? null : project?.autonomousRun;
  const { phase, step } = autonomousRunPhase(auto);
  if (phase !== 'inactive') {
    const running = phase === 'running';
    return { label: autonomousChipLabel(auto, { phase, step }), short: running ? 'Autopilot running' : 'Autopilot needs you', tone: running ? 'muted' : 'warn' };
  }
  const run = currentProductionRun(project);
  // A parked run whose shots are all done since needs nothing from the director.
  if (run && RESUMABLE_RUN_STATUSES.has(run.status) && deriveStages(project, readiness).liveRun) {
    const running = run.status === 'running';
    return { label: PRODUCTION_RUN_LABELS[run.status] || 'Production paused', short: running ? 'Autopilot running' : 'Autopilot needs you', tone: running ? 'muted' : 'warn' };
  }
  return { label: 'Autopilot', short: 'Autopilot', tone: 'muted' };
}

/**
 * The project's "where does it stand" line for the sticky header: the step it
 * is in, or the step waiting on the director (`needsYouStage`, also marked in
 * the step list). A stopped step, an approval to give (`review-production`,
 * which may sit on a later step than the first unfinished one), a Cast & Sets
 * check-in or an autonomous checkpoint all need the director. `progress` is
 * `deriveStages(…)`; `nextAction` is `deriveNextAction(…)`.
 */
export function describeProjectStatus(project, { progress, nextAction = null, reviewingDraft = false, reviewDraftState } = {}) {
  if (!project || !progress) return null;
  const entry = progress.stages.find((stage) => stage.id === progress.current);
  const allDone = progress.stages.every((stage) => stage.optional || stage.state === 'done');
  const blocked = entry?.state === 'blocked';
  const asksForYou = ['review-production', 'approve-cast-sets', 'review-autonomous'].includes(nextAction?.id);
  const needsYou = blocked || asksForYou;
  const needsYouStage = !needsYou ? null : blocked ? progress.current
    : nextAction.id === 'approve-cast-sets' ? 'cast-sets' : nextAction.stage || progress.current;
  const shownId = needsYouStage || progress.current;
  const index = MUSIC_VIDEO_STAGES.findIndex((stage) => stage.id === shownId);
  const shown = progress.stages.find((stage) => stage.id === shownId);
  const activeEvidence = ['draft-progress', 'proof-progress'].includes(nextAction?.id);
  const reviewDraft = reviewingDraft && reviewDraftState ? reviewDraftState.draft : latestMusicVideoReviewDraft(project);
  const headline = reviewingDraft ? reviewDraftState?.checking ? 'Checking review draft' : reviewDraft ? 'Imported draft for review' : 'Choose an available review file' : activeEvidence ? 'Review render in progress' : allDone
    ? 'Published'
    : `Step ${index + 1} of ${MUSIC_VIDEO_STAGES.length}: ${shown?.label || ''}${needsYou ? ' needs you' : ''}`;
  const quiet = reviewingDraft || activeEvidence || allDone;
  return {
    headline,
    tone: reviewingDraft || activeEvidence ? 'muted' : allDone ? 'ok' : needsYou ? 'warn' : 'muted',
    needsYouStage: quiet ? null : needsYouStage,
  };
}

export const STALE_RENDER_MESSAGE = 'Final render is out of date — re-render';

/** The server's dependency projection says scenes changed after the final render was made. */
export const isFinalRenderStale = (project) => !!project?.renderHistoryId && project.renderDependencyState?.status === 'stale';

/** The server's dependency projection says the final render still matches every scene. */
export const isFinalRenderCurrent = (project) => !!project?.renderHistoryId && project.renderDependencyState?.status === 'current';

/**
 * Publish progress per enabled platform. `publish.targets` is the director's
 * enabled `[{ target, label }]` list (machine-level settings, so the caller
 * supplies it) and `publish.drafts` the drafts filled this session. With no
 * platform enabled there is nothing to count per platform, so any one recorded
 * post still counts as published.
 */
export function publishPlatformProgress(project, publish = {}) {
  const posts = project?.publishKit?.posts || {};
  const rows = (publish.targets || []).map(({ target, label }) => ({
    target, label, state: posts[target] ? 'posted' : publish.drafts?.[target] ? 'draft' : 'none',
  }));
  const posted = rows.length ? rows.filter((row) => row.state === 'posted').length : Object.keys(posts).length;
  return { rows, posted, total: rows.length, done: rows.length ? posted === rows.length : posted > 0 };
}

/** Resolve the `:stage` route param (a step or a page; a retired id maps to its step); an unknown or missing value is null. */
export const resolveStageParam = (value) => (isStageId(value) || MUSIC_VIDEO_PAGES.some((page) => page.id === value)
  ? value : LEGACY_STAGE_IDS[value] || null);

// Footage-optional modes draw their own picture, so scene footage never gates Produce.
export const FOOTAGE_OPTIONAL_MODES = new Set(['code', 'document', 'eidoverse']);

// A code video is composed once it was generated or the director holds sections to render.
const codeComposed = (project) => {
  const code = project.composition?.codeVideo;
  return !!code?.generatedAt || (code?.sections || []).length > 0;
};

const composeDone = (project, mode) => {
  if (mode === 'composed') return (project.composition?.textCues || []).length > 0 || composedDrawsLyrics(project);
  if (mode === 'document') return !!project.composition?.document;
  if (mode === 'eidoverse') return !!project.composition?.eidoverseScene?.inlineScript;
  if (mode === 'code') return codeComposed(project);
  // Footage has nothing to compose.
  return true;
};

/**
 * Clip locks count toward Shots once the director has started using them: a
 * board where no clip was ever locked (an autopilot run, say) is not held open.
 */
function clipsLockedDone(readiness) {
  const clips = Object.values(readiness?.storyboard?.clipLocks || {});
  return !clips.some((state) => state === 'locked' || state === 'changed') || !(readiness.storyboard.clipsUnlocked || []).length;
}

/**
 * Lyric half of Setup: storyboard approval needs lyrics imported and their word
 * timings verified (or an explicit instrumental exception). `readiness.alignment`
 * is the server's verdict; the draft is the fallback before readiness loads.
 * `ok` also holds once the storyboard is approved, which implies both.
 */
export function lyricSetupState(project, readiness = project?.productionReadiness) {
  const draft = project?.productionReview?.draft || {};
  const instrumental = draft.lyricsMode === 'instrumental';
  const lines = (project?.lyricCues || []).filter((cue) => isNonBlankStr(cue.text)).length;
  const alignment = readiness?.alignment?.status || (instrumental ? 'instrumental' : draft.timingStatus === 'verified' ? 'verified' : 'provisional');
  const imported = instrumental || lines > 0;
  const verified = alignment === 'verified' || alignment === 'instrumental';
  return { instrumental, lines, alignment, imported, verified, ok: !!readiness?.storyboard?.approved || (imported && verified) };
}

/**
 * Each stage's state derived from the project record — `done`, `blocked`
 * (stopped and needs the director), `active` (the stage the project is in), or
 * `todo`, with `stale` when an approval it owns was given on inputs that have
 * changed since — plus `current`, the first stage that is not done. A live production
 * run owns the project, so it pins `current` to Produce.
 *
 * Plan (`board`) is done once timed shots cover the song. Shots (`produce`)
 * is done once every still is locked (the storyboard approval), every clip is
 * locked once the director has started locking clips, the footage is in and the
 * composition is ready. Its animated proof is an optional check: neither Shots
 * nor the final render waits on a proof approval.
 */
export function deriveStages(project, readiness = project?.productionReadiness, publish = {}) {
  const mode = project?.composition?.mode || 'concat';
  const cast = project?.castAndSets || null;
  const run = currentProductionRun(project);
  const planned = !!readiness?.storyboard.approved;
  const shotsPlanned = (project?.scenes || []).length > 0 && !!readiness && !(readiness.storyboard.problems || []).some((text) => !ART_APPROVAL_PROBLEM.test(text));
  const castStopped = castSetsPhase(cast) === 'stopped';
  const castDone = !!readiness?.art.approved;
  // Code and document renders draw the picture themselves; scene footage is optional there.
  const produceDone = planned && clipsLockedDone(readiness) && footageReady(project);

  const shotsDone = produceDone && composeDone(project || {}, mode);
  // A run parked short of running (stopped, awaiting video) whose shots are all done since is
  // finished in fact: it no longer holds Shots open or owns the header.
  const liveRun = !!run && RESUMABLE_RUN_STATUSES.has(run.status) && (run.status === 'running' || !shotsDone);
  const done = {
    setup: projectHasAudio(project) && !!project?.audioAnalysis && lyricSetupState(project, readiness).ok,
    story: !!(project?.concept?.prompt?.trim() || project?.storySummary?.trim() || project?.treatment?.brief?.premise?.trim()),
    'cast-sets': castDone,
    // Reopened for rework, the storyboard waits for Approve storyboard whatever else is done.
    board: (planned || shotsPlanned) && !project?.storyboardReopenedAt,
    produce: shotsDone,
    // A render made before later scene edits no longer counts as the final video.
    review: !!project?.renderHistoryId && !isFinalRenderStale(project),
    // #9281/#9282: published once every enabled platform has a recorded post.
    publish: publishPlatformProgress(project, publish).done,
  };
  // Finished outside PortOS: the steps it made elsewhere count as done, with no approval to go stale.
  const external = !!finishedOutside(project);
  if (external) for (const id of Object.keys(done)) if (finishedOutsideCovers(project, id)) done[id] = true;
  if (external) done.story = true;
  const blocked = {
    'cast-sets': castStopped,
    produce: !!run && RUN_BLOCKED_STATUSES.has(run.status),
  };
  // Approved earlier, inputs changed since (#10141): the tab says so rather than
  // reading as never done. The check-in sheet stays approved while stale.
  const stale = external ? {} : {
    'cast-sets': !!readiness?.art?.stale || !!readiness?.castAndSets?.stale,
    produce: !!readiness?.storyboard?.stale,
  };
  const current = liveRun
    ? 'produce'
    : (MUSIC_VIDEO_STAGES.find((stage) => !stage.optional && !done[stage.id])?.id || 'publish');
  const stages = MUSIC_VIDEO_STAGES.map((stage) => {
    let state = 'todo';
    if (done[stage.id] && !(stage.id === current && liveRun)) state = 'done';
    else if (stage.id === current) state = blocked[stage.id] ? 'blocked' : 'active';
    return { ...stage, state, stale: !!stale[stage.id] };
  });
  return { stages, current, liveRun };
}

// The approval panel the header sends the director to: unwritten art direction is written on the step, not approved.
function reviewProductionAction({ art, board, artUnwritten }) {
  if (artUnwritten) return { id: 'review-production', kind: 'goto', stage: 'cast-sets', anchor: ART_DIRECTION_ANCHOR, label: 'Write art direction', shortLabel: 'Write art' };
  return { id: 'review-production', kind: 'goto', stage: art ? 'cast-sets' : 'produce',
    anchor: art ? 'mv-review-art' : board ? 'mv-review-storyboard' : 'mv-review-proof',
    label: art ? 'Review art direction' : board ? 'Lock the stills' : 'Review pilot proof',
    shortLabel: art ? 'Review art' : board ? 'Lock stills' : 'Review proof' };
}

// A live or parked production run offers Stop while it works, else Resume.
function productionRunAction(run) {
  if (run.status === 'running' && !run.interrupted) return { id: 'stop-production', kind: 'run', label: 'Stop production', shortLabel: 'Stop', runId: run.id };
  const replan = run.status === 'needs-replan';
  return { id: 'resume-production', kind: 'run', runId: run.id, acceptBasis: replan, label: replan ? 'Resume with new setup' : run.status === 'awaiting-video' ? 'Make the clips' : 'Resume production', shortLabel: 'Resume' };
}

// The header action for an autonomous run that still owns the project, or null once it is finished or cancelled.
function autonomousNextAction(auto) {
  const { phase, step } = autonomousRunPhase(auto);
  if (phase === 'running') {
    const text = step || 'Autonomous run running';
    const busyLabel = text.endsWith('…') ? text : `${text}…`;
    return { id: 'busy', kind: 'run', label: busyLabel, shortLabel: busyLabel, disabled: true };
  }
  if (phase === 'awaiting') {
    const target = AUTONOMOUS_CHECKPOINT_LABELS[auto.awaiting] || auto.awaiting || 'checkpoint';
    // The checkpoint editor is in Project settings › Autopilot; the page opens it.
    return { id: 'review-autonomous', kind: 'open', label: `Review ${target}`, shortLabel: 'Review' };
  }
  if (phase === 'paused') return { id: 'resume-autonomous', kind: 'run', label: 'Resume autonomous run', shortLabel: 'Resume' };
  if (phase === 'failed') return { id: 'retry-autonomous', kind: 'run', label: 'Retry autonomous run', shortLabel: 'Retry' };
  return null;
}

// Publish: build the kit, then one platform at a time, never "publish everything": the next platform
// not yet posted, so a click can't repeat a post that already went out.
function publishNextAction(project, publish) {
  if (!project.publishKit?.builtAt) return { id: 'goto-publish', kind: 'goto', stage: 'publish', label: 'Build the publishing kit', shortLabel: 'Kit' };
  const { rows, total, posted } = publishPlatformProgress(project, publish);
  const next = rows.find((row) => row.state !== 'posted');
  return next
    ? { id: 'goto-publish', kind: 'goto', stage: 'publish', anchor: publishRowAnchor(next.target), label: `Next: post to ${next.label} · ${total - posted} left`, shortLabel: next.label }
    : { id: 'goto-publish', kind: 'goto', stage: 'publish', anchor: PUBLISH_ANCHOR, label: total ? 'All posted' : 'Open publishing', shortLabel: 'Publish' };
}

// Progress-only header states: a render in flight, else a kickoff, analysis or shot plan at work.
function renderProgressAction({ renderPending, renderProgress }) {
  const label = renderPending ? 'Preparing…' : `Rendering… ${Math.round(renderProgress)}%`;
  return { id: 'render-progress', kind: 'run', label, shortLabel: label, disabled: true };
}

function workingAction({ kickoffStep, planning }) {
  const label = kickoffStep || (planning ? 'Planning…' : 'Working…');
  return { id: 'busy', kind: 'run', label, shortLabel: label, disabled: true };
}

/**
 * What is left to approve, and whether a stage owns the header for it instead of
 * the approval panel. `art` / `board` are the open approvals. The approval panel
 * only opens once the stage's own work exists: a stage with nothing built yet (no
 * check-in, no shots) offers Start / Plan, and an open or interrupted check-in
 * offers Approve / Resume — those come from the stage resolvers, so `ownAction`
 * keeps the header off the panel. With no art direction written yet there is
 * nothing to review either (`artUnwritten`): a project whose sheet was never
 * built (planned from a treatment, say) builds it first. `pilotParked` sends the
 * director to the optional animated proof only while a production run is parked
 * on its pilot before paid bulk generation. `planUnfinished`: shots planned with
 * gaps (timing, staging, lyric anchors) are finished on Plan before their stills
 * are locked.
 */
function approvalNeeds(project, readiness, run) {
  const scenes = project.scenes || [];
  const art = !readiness?.art.approved;
  const board = !readiness?.storyboard.approved;
  const artUnwritten = art && !artDirectionGaps(project).ready;
  const castPhase = castSetsPhase(project.castAndSets || null);
  const castNeedsOwnAction = art && (castPhase === 'review' || castPhase === 'stopped'
    || (castPhase === 'absent' && (scenes.length === 0 || (artUnwritten && !project.automation))));
  // A document storyboard brings its shots from the authored source, so it has nothing to plan on the board.
  const draftReview = project.productionReview?.draft || {};
  const documentShots = draftReview.storyboardSource === 'document' && (draftReview.storyboard || []).length > 0;
  // Plan comes before Look, so an unplanned board is the director's own action whatever the art's state.
  const boardNeedsOwnAction = board && scenes.length === 0 && !documentShots;
  const pilotParked = !!run && RESUMABLE_RUN_STATUSES.has(run.status) && !!run.pilot?.scenes?.length && !readiness?.proof?.approved;
  const planUnfinished = board && scenes.length > 0 && !documentShots && (readiness?.storyboard?.problems || []).some(planProblem);
  return { art, board, artUnwritten, castPhase, ownAction: castNeedsOwnAction || boardNeedsOwnAction, pilotParked, planUnfinished };
}

const kickoffAction = (kickoffBlockedReason) => ({ id: 'kickoff', kind: 'run', label: 'Run autopilot', shortLabel: 'Autopilot', disabled: !!kickoffBlockedReason, reason: kickoffBlockedReason || undefined });
// Building the sheet and planning the shots both read the song analysis.
const analyzeFirst = (project) => ({ disabled: !project.audioAnalysis, reason: project.audioAnalysis ? undefined : 'Analyze the track first' });

// The current stage's primary action once nothing else owns the header, one resolver per stage.
function setupNextAction({ project, readiness, kickoffBlockedReason }) {
  if (!projectHasAudio(project)) return { id: 'goto-setup', kind: 'goto', stage: 'setup', anchor: 'mv-track', label: 'Attach a track', shortLabel: 'Track' };
  if (project.automation && (project.scenes || []).length === 0) return kickoffAction(kickoffBlockedReason);
  if (!project.audioAnalysis) return { id: 'analyze', kind: 'run', label: 'Analyze song', shortLabel: 'Analyze' };
  // Analyzed: what keeps Song open is the lyrics or their timing, finished on the step itself.
  return lyricSetupState(project, readiness).imported
    ? { id: 'verify-timing', kind: 'goto', stage: 'setup', anchor: 'mv-lyric-timing', label: 'Verify lyric timing', shortLabel: 'Timing' }
    : { id: 'import-lyrics', kind: 'goto', stage: 'setup', anchor: 'mv-lyrics-import', label: 'Add the lyrics', shortLabel: 'Lyrics' };
}

function castSetsNextAction({ project, castPhase, kickoffBlockedReason }) {
  if (castPhase === 'review') return { id: 'approve-cast-sets', kind: 'run', label: 'Approve cast & sets', shortLabel: 'Approve' };
  if (castPhase === 'stopped') return { id: 'resume-cast-sets', kind: 'run', label: 'Resume cast & sets', shortLabel: 'Resume' };
  if (castPhase === 'building') return { id: 'busy', kind: 'run', label: 'Building cast & sets…', shortLabel: 'Building…', disabled: true };
  if (castPhase === 'absent' && !project.automation) return { id: 'start-cast-sets', kind: 'run', label: 'Build cast & sets', shortLabel: 'Build', ...analyzeFirst(project) };
  return kickoffAction(kickoffBlockedReason);
}

// An autopilot project with nothing planned yet is the run's to start (or its Cast & Sets check-in to settle).
const boardNextAction = (args) => (args.project.automation && !(args.project.scenes || []).length && args.castPhase !== 'settled'
  ? castSetsNextAction(args)
  : { id: 'plan', kind: 'run', label: 'Plan the shots', shortLabel: 'Plan', ...analyzeFirst(args.project) });

// The composition step's name by render mode; concat and the other footage-only modes add typography.
const COMPOSE_LABELS = { document: ['Attach a composition', 'Attach'], eidoverse: ['Save the Eidoverse scene', 'Save'], code: ['Generate the code video', 'Generate'] };

function produceNextAction({ project, readiness, run }) {
  if (run?.status === 'needs-human') return { id: 'goto-review', kind: 'goto', stage: 'review', label: 'Review the draft', shortLabel: 'Review' };
  if (!footageReady(project)) return { id: 'goto-produce', kind: 'goto', stage: 'produce', anchor: 'mv-generation', label: 'Make the footage', shortLabel: 'Make' };
  if (!clipsLockedDone(readiness)) {
    const left = readiness.storyboard.clipsUnlocked.length;
    return { id: 'lock-clips', kind: 'goto', stage: 'produce', anchor: 'mv-scene-board', label: `Lock ${formatCount(left)} video${left === 1 ? '' : 's'}`, shortLabel: 'Lock videos' };
  }
  const [label, shortLabel] = COMPOSE_LABELS[project.composition?.mode] || ['Add typography', 'Type'];
  return { id: 'goto-compose', kind: 'goto', stage: 'produce', anchor: 'mv-composition', label, shortLabel };
}

// Final render: watch a current one, else render (again, once scene edits made the last one stale).
function finalRenderAction({ project, renderBlockedByOther }) {
  const stale = isFinalRenderStale(project);
  if (project.renderHistoryId && !stale) return { id: 'goto-final', kind: 'goto', stage: 'review', anchor: 'mv-final-video', label: 'Watch final video', shortLabel: 'Watch' };
  return {
    id: 'render-final', kind: 'run', label: stale ? 'Re-render final video' : 'Render final video', shortLabel: stale ? 'Re-render' : 'Render',
    disabled: renderBlockedByOther, reason: renderBlockedByOther ? 'Wait for the other project render to finish' : undefined,
  };
}

const STAGE_NEXT_ACTIONS = {
  setup: setupNextAction, 'cast-sets': castSetsNextAction, board: boardNextAction, produce: produceNextAction,
  review: finalRenderAction, publish: ({ project, publish }) => publishNextAction(project, publish),
};

/**
 * The single primary action the sticky header offers. `kind: 'run'` calls a
 * handler the page owns (keyed by `id`); `kind: 'open'` opens a Project
 * settings tab (`review-autonomous` → Autopilot); `kind: 'goto'` opens a stage (and
 * optionally scrolls to `anchor`). `label` is the full control name; `shortLabel`
 * is what a phone shows so the project name keeps room. `disabled` carries the
 * reason it can't run yet. A live production run, a render in flight and a
 * running kickoff win over the stage: they own the project until they settle.
 */
export function deriveNextAction(project, {
  draftActive = false, proofActive = false, renderActive = false, renderProgress = 0, renderPending = false, renderBlockedByOther = false,
  kickoffRunning = false, kickoffStep = '', kickoffBlockedReason = null,
  planning = false, analyzing = false, readiness = project?.productionReadiness, publish = {},
} = {}) {
  if (!project) return null;
  const { current, liveRun } = deriveStages(project, readiness, publish);
  const latestRun = currentProductionRun(project);
  const run = latestRun && RESUMABLE_RUN_STATUSES.has(latestRun.status) && !liveRun ? null : latestRun;

  if (proofActive) return { id: 'proof-progress', kind: 'goto', stage: 'produce', anchor: 'mv-review-render', label: 'View review render', shortLabel: 'Review' };
  if (draftActive) return { id: 'draft-progress', kind: 'goto', stage: 'review', anchor: 'mv-draft-excerpts', label: 'View draft render', shortLabel: 'Draft' };
  const needs = approvalNeeds(project, readiness, run);
  const resumable = !!run && RESUMABLE_RUN_STATUSES.has(run.status);
  const busy = renderActive || kickoffRunning;
  if (needs.planUnfinished && !busy && !resumable) return { id: 'finish-plan', kind: 'goto', stage: 'board', label: 'Finish the storyboard', shortLabel: 'Storyboard' };
  if (shouldJumpToReview(project, { run, art: needs.art, board: needs.board, pilotParked: needs.pilotParked, busy, ownAction: needs.ownAction })) {
    return reviewProductionAction(needs);
  }
  if (resumable) return productionRunAction(run);
  if (renderActive) return renderProgressAction({ renderPending, renderProgress });
  if (kickoffRunning || analyzing || planning) return workingAction({ kickoffStep, planning });

  const autonomousAction = supersededStillsCheckpoint(project, readiness) ? null : autonomousNextAction(project.autonomousRun);
  if (autonomousAction) return autonomousAction;

  return (STAGE_NEXT_ACTIONS[current] || finalRenderAction)({ project, readiness, publish, run, castPhase: needs.castPhase, kickoffBlockedReason, renderBlockedByOther });
}

// The editable art-direction fields the art approval needs before art can be approved.
const ART_DIRECTION_FIELDS = [['cast', 'cast'], ['environments', 'sets'], ['visualLanguage', 'visual language'], ['motionLanguage', 'motion']];
/** Where the Look step's art-direction fields and its visual-guide files are on the page. */
export const ART_DIRECTION_ANCHOR = 'mv-art-direction-editor';
export const LOOK_GUIDES_ANCHOR = 'mv-look-guides';
export const CAST_CHECKIN_ANCHOR = 'mv-cast-checkin';
/**
 * What the art approval is still waiting on before there is anything to
 * approve: the unwritten art-direction fields (`missing`, by label) and the
 * chosen visual guide (null when none is chosen or it was deleted). `ready`
 * is true once both exist; until then the approval has nothing to show.
 */
export function artDirectionGaps(project) {
  const draft = project?.productionReview?.draft || {};
  const missing = ART_DIRECTION_FIELDS.filter(([key]) => !isNonBlankStr(draft[key])).map(([, label]) => label);
  const guide = (project?.devArtifacts || []).find((a) => a.id === draft.guideArtifactId && !a.deleted) || null;
  return { missing, guide, ready: missing.length === 0 && !!guide };
}
/** "Approved earlier — changed since: concept, scene 3 prompt" for an approval whose inputs moved; null otherwise. */
export function staleApprovalText(stale) {
  if (!stale) return null;
  return stale.changedFields.length ? `Approved earlier — changed since: ${changedFieldsText(stale.changedFields)}.` : 'Approved earlier — its inputs changed since.';
}
const SCENE_FIELD = /^scene \d+ (.+)$/;
const SCENE_FIELD_PLURALS = { prompt: 'prompts', timing: 'timings', lyrics: 'lyrics', camera: 'cameras' };
/**
 * "concept, 26 scene prompts +2 more": the first `limit` changed inputs of a
 * stale approval, with each per-scene kind (prompt, timing, …) folded into one count.
 */
export function changedFieldsText(changedFields, limit = 4) {
  const scenes = new Map();
  const labels = [];
  for (const field of changedFields) {
    const kind = SCENE_FIELD.exec(field)?.[1];
    if (!kind) { labels.push(field); continue; }
    if (!scenes.has(kind)) { scenes.set(kind, []); labels.push({ kind }); }
    scenes.get(kind).push(field);
  }
  const text = labels.map((label) => {
    if (typeof label === 'string') return label;
    const fields = scenes.get(label.kind);
    return fields.length === 1 ? fields[0] : `${formatCount(fields.length)} scene ${SCENE_FIELD_PLURALS[label.kind] || label.kind}`;
  });
  const more = text.length > limit ? ` +${text.length - limit} more` : '';
  return `${text.slice(0, limit).join(', ')}${more}`;
}
const APPROVAL_ANCHORS = { art: 'mv-review-art', storyboard: 'mv-review-storyboard', proof: 'mv-review-proof' };
const APPROVAL_STAGES = { art: 'cast-sets', storyboard: 'produce', proof: 'produce' };
const PUBLISH_ANCHOR = 'mv-publish-kit';
/** The anchor of one platform's row in the posting panel. */
export const publishRowAnchor = (target) => `mv-post-${target}`;

// The server names every unfinished shot in its own sentence; on a long song
// that is dozens of near-identical lines. The director judges shots by
// watching the preview, so each per-shot problem kind collapses into one count.
const PER_SHOT_PROBLEMS = [
  { test: /^Complete timing, action, staging, camera and transition for /, text: (n) => `${n} shot${n === 1 ? '' : 's'} missing timing, action, staging, camera or transition.` },
  { test: /^Review lyric anchors for /, text: (n) => `${n} shot${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} lyric anchors reviewed.` },
];
/** Storyboard readiness problems with each per-shot kind folded into one count line, in first-seen order. */
export function summarizeStoryboardProblems(problems = []) {
  const kindOf = (text) => PER_SHOT_PROBLEMS.find((k) => k.test.test(text));
  const counts = new Map();
  for (const text of problems) { const kind = kindOf(text); if (kind) counts.set(kind, (counts.get(kind) || 0) + 1); }
  return problems.flatMap((text) => {
    const kind = kindOf(text);
    if (!kind) return [text];
    if (!counts.has(kind)) return [];
    const line = kind.text(counts.get(kind));
    counts.delete(kind); // only the first of its kind carries the count line
    return [line];
  });
}

// Once any shot is locked one at a time, the board is approved when every shot is: say how many are left.
function unlockedDetail(readiness, item) {
  const left = unlockedShots(readiness).stills.length;
  if (!left) return item;
  const count = `${formatCount(left)} shot${left === 1 ? '' : 's'} not locked yet.`;
  // A stale board keeps its "changed since" text (and Keep approved) after the count.
  return { ...item, detail: item.stale ? `${count} ${item.detail}` : `${count} Lock each on its card, or lock them all below.` };
}

// The server names each open change request as a readiness problem; the
// checklist lists those requests on their own Feedback row instead.
const FEEDBACK_PROBLEM = /^Resolve (art|storyboard|proof) feedback for /;
const notFeedback = (text) => !FEEDBACK_PROBLEM.test(text);
// Plan comes before Look, so the storyboard gate's "approve the art first" is Look's to settle, not Plan's.
const ART_APPROVAL_PROBLEM = /^Review and approve the current art direction/;
const planProblem = (text) => notFeedback(text) && !ART_APPROVAL_PROBLEM.test(text);

/**
 * Whether Make shows the animated proof: only while something needs it — a
 * production run parked on its pilot proof before bulk generation, a proof
 * rendering, or open change requests on one. The final render never waits on it.
 */
export function proofReviewInUse(project, readiness, { proofActive = false } = {}) {
  const run = currentProductionRun(project);
  return proofActive || openChangeRequests(project, 'proof').length > 0
    || (!!run && RESUMABLE_RUN_STATUSES.has(run.status) && !!run.pilot?.scenes?.length && !readiness?.proof?.approved);
}

/** The open change requests on one approval stage ('art' | 'storyboard' | 'proof'). */
export const openChangeRequests = (project, stage) => (project?.productionReview?.feedback || [])
  .filter((f) => f.stage === stage && f.decision === 'request-changes' && !f.resolvedAt);

/**
 * What "Revise from feedback" does for one stage, mirroring the server's revise
 * routing: `{ action }` describes the revision, `{ unavailable }` says why
 * there is none and what to do instead.
 */
export function feedbackRevisionScope(project, stage) {
  if (stage === 'art') return project.castAndSets?.direction
    ? { action: 'Regenerates the Cast & Sets direction and sheet with these requests. Review the new sheet before approving.' }
    : { unavailable: 'This art direction has no Cast & Sets direction to regenerate. Edit the guide, then resolve each request.' };
  if (stage === 'storyboard') {
    if (project.productionReview?.draft?.storyboardSource === 'document') return { unavailable: 'Document shots come from the authored source. Revise it, reimport its shot manifest, then resolve each request.' };
    return project.scenes?.length
      ? { action: 'Re-plans the shots these requests name (every shot when a request names none) in place, keeping their takes and selected media.' }
      : { unavailable: 'Plan timed Board shots before revising them from feedback.' };
  }
  const mode = project.composition?.mode;
  if (mode === 'code') return { action: 'Regenerates the code composition with these requests. Render a new proof afterwards.' };
  if (mode === 'document') return ['generated', 'template', undefined].includes(project.composition?.document?.source?.kind)
    ? { action: 'Authors a revised composition candidate with these requests. Accept it in Make, then render a new proof.' }
    : { unavailable: 'This composition was imported from its own source. Revise that source and reimport it, then resolve each request.' };
  return { unavailable: 'This proof is assembled from Board footage. Revise the affected storyboard shots or takes, then render a new proof.' };
}

/** The line an approval shows while change requests block it: the one note by name, or how many. */
export function changeRequestBlocker(requests) {
  if (!requests?.length) return null;
  return requests.length === 1 ? `Resolve the change request on ${requests[0].target} first.` : `Resolve the ${requests.length} change requests above first.`;
}

// One Feedback row per stage with open change requests: each note carries its
// own Mark resolved button, and the row offers Revise from feedback where the
// stage supports it. An approved stage has nothing left to block.
function feedbackItem(project, stage, readiness, { optional = false } = {}) {
  const requests = openChangeRequests(project, stage);
  if (!requests.length || readiness?.[stage]?.approved) return null;
  const scope = feedbackRevisionScope(project, stage);
  return {
    id: `feedback-${stage}`, label: 'Feedback', done: false, optional,
    notes: requests.map(({ id, target, text }) => ({ id, target, text })),
    detail: scope.unavailable || null,
    action: scope.unavailable ? null : { label: 'Revise from feedback', run: 'revise-feedback', stage, reason: scope.action },
  };
}

// Storyboard readiness problems, grouped by what the user has to go fix. The
// server returns plain sentences; the first matching rule picks the group.
const STORYBOARD_PROBLEM_GROUPS = [
  // A document storyboard needs a manifest from its current build; its message mentions timing, so it is matched first.
  { id: 'manifest', label: 'Document shot manifest', test: /shot manifest/i, action: { label: 'Import the shot manifest', anchor: 'mv-review-planning' } },
  { id: 'lyrics', label: 'Lyrics', test: /lyrics|instrumental/i, action: { label: 'Import lyrics', stage: 'setup', anchor: 'mv-lyrics-import' } },
  // The per-shot count lines ("3 shots missing timing, …") mention timing too; they belong to Shot details.
  { id: 'timing', label: 'Lyric timing', test: /^(?!\d+ shots? ).*(alignment|timing|vocal|master song)/i, action: { label: 'Verify timing', stage: 'setup', anchor: 'mv-lyric-timing' } },
  { id: 'coverage', label: 'Shot coverage', test: /cover the master|gaps or overlaps|create a timed/i, action: { label: 'Open the treatment', stage: 'produce', anchor: 'mv-board-treatment' } },
  { id: 'shots', label: 'Shot details', test: /./, action: { label: 'Edit the storyboard', anchor: APPROVAL_ANCHORS.storyboard } },
];

/** One open checklist item per group of storyboard readiness problems, per-shot problems counted rather than listed. */
function storyboardProblemItems(readiness, scenes = []) {
  // Shots whose lyric anchors differ from the singing get a row of their own that names each shot.
  const anchors = lyricAnchorItem(readiness, scenes);
  const stale = staleRowsItem(readiness);
  const problems = summarizeStoryboardProblems(readiness?.storyboard?.problems?.filter(planProblem)
    .filter((text) => (!anchors || !ANCHOR_PROBLEM.test(text)) && (!stale || !STALE_ROWS_PROBLEM.test(text))));
  if (readiness?.storyboard?.approved || (!problems.length && !anchors && !stale)) return [];
  return [...STORYBOARD_PROBLEM_GROUPS.flatMap((group, index) => {
    const earlier = STORYBOARD_PROBLEM_GROUPS.slice(0, index);
    const mine = problems.filter((text) => group.test.test(text) && !earlier.some((g) => g.test.test(text)));
    if (!mine.length) return [];
    return [namedShots({ id: `board-${group.id}`, label: group.label, done: false, details: mine, action: group.action }, readiness, scenes)];
  }), ...(stale ? [stale] : []), ...(anchors ? [anchors] : [])];
}

const MISSING_DETAILS_LINE = /^\d+ shots? missing timing, action, staging, camera or transition\.$/;
const spanText = (startSec, endSec) => `${formatTimecode(startSec)}–${formatTimecode(endSec)}`;
const gapSec = ({ startSec, endSec }) => `${(endSec - startSec).toFixed(2)} s`;
const COVERAGE_TEXT = {
  'late-start': (c) => `Nothing covers the start of the song, ${spanText(c.startSec, c.endSec)}`,
  gap: (c) => `Gap of ${gapSec(c)} before this shot, ${spanText(c.startSec, c.endSec)}`,
  overlap: (c) => `Overlaps the shot before by ${gapSec(c)}, ${spanText(c.startSec, c.endSec)}`,
  'past-end': (c) => `Runs ${gapSec(c)} past the end of the song, ${spanText(c.startSec, c.endSec)}`,
  'early-end': (c) => `Ends ${gapSec(c)} before the song does, ${spanText(c.startSec, c.endSec)}`,
};

/**
 * The Shot coverage and Shot details rows name each shot they are about (a
 * button to its card) and say what is wrong with it, in place of the generic
 * sentence or count.
 */
function namedShots(item, readiness, scenes) {
  const number = (sceneId) => scenes.findIndex((scene) => scene.sceneId === sceneId) + 1;
  const label = (sceneId) => (number(sceneId) > 0 ? `Shot ${number(sceneId)}` : 'Shot');
  const byShot = (entries, text) => [...entries.reduce((map, entry) => map.set(entry.sceneId,
    [...(map.get(entry.sceneId) || []), text(entry)]), new Map())].map(([sceneId, lines]) => ({ sceneId, label: label(sceneId), text: lines.join(' · ') }));
  const coverage = readiness?.storyboard?.coverage;
  if (item.id === 'board-coverage' && coverage?.length) {
    return { ...item, details: item.details.filter((text) => !/cover the master/.test(text)),
      detail: 'Move these cuts so every moment of the song has exactly one shot.',
      shots: byShot(coverage, (c) => (COVERAGE_TEXT[c.issue] || (() => c.issue))(c)) };
  }
  const incomplete = readiness?.storyboard?.incompleteShots;
  if (item.id === 'board-shots' && incomplete?.length) {
    return { ...item, details: item.details.filter((text) => !MISSING_DETAILS_LINE.test(text)),
      shots: byShot(incomplete, (shot) => `Missing ${shot.missing.join(', ')}`) };
  }
  return item;
}

const ANCHOR_PROBLEM = /^Review lyric anchors for /;
const STALE_ROWS_PROBLEM = /left from deleted shots\.$/;
const ROW_ACTION_CHARS = 60;

/**
 * Storyboard rows left from shots that were cut: each by its old time span and
 * action (the shot is gone, so there is no card to open), and one button that
 * removes them all.
 */
function staleRowsItem(readiness) {
  const rows = readiness?.storyboard?.staleRows;
  if (!rows?.length || readiness?.storyboard?.approved) return null;
  const span = (row) => (Number.isFinite(row.startSec) && Number.isFinite(row.endSec)
    ? `${formatTimecode(row.startSec)}–${formatTimecode(row.endSec)}` : 'Untimed');
  const action = (text) => (text.length > ROW_ACTION_CHARS ? `${text.slice(0, ROW_ACTION_CHARS).trimEnd()}…` : text);
  return {
    id: 'board-stale-rows', label: 'Rows from deleted shots', done: false,
    detail: `${rows.length === 1 ? 'This storyboard row belongs' : 'These storyboard rows belong'} to a shot that was cut.`,
    details: [...new Set(rows.map((row) => (row.action ? `${span(row)} · ${action(row.action)}` : span(row))))],
    action: { label: rows.length === 1 ? 'Remove it' : `Remove all ${rows.length}`, run: 'remove-stale-rows' },
  };
}
const quoted = (lines) => (lines.length ? lines.map((line) => `“${line}”`).join(' / ') : 'nothing');

/**
 * The Lyric anchors row: each flagged shot by number (a button to its card),
 * what is sung over it and what it is anchored to, and one button that anchors
 * them all to the singing.
 */
function lyricAnchorItem(readiness, scenes) {
  const flagged = readiness?.storyboard?.lyricAnchors;
  if (!flagged?.length || readiness?.storyboard?.approved) return null;
  const number = (sceneId) => scenes.findIndex((scene) => scene.sceneId === sceneId) + 1;
  return {
    id: 'board-anchors', label: 'Lyric anchors', done: false,
    detail: 'These shots are anchored to lyrics other than the ones sung over them.',
    shots: flagged.map(({ sceneId, sung, anchored }) => ({
      sceneId, label: number(sceneId) > 0 ? `Shot ${number(sceneId)}` : 'Shot',
      text: `Sung: ${quoted(sung)} · anchored: ${quoted(anchored)}`,
    })),
    action: { label: 'Anchor to the sung lyrics', run: 'sync-lyric-anchors' },
  };
}

/**
 * Plan's shot list: every shot in song order (untimed ones last, `number` null)
 * with what the timing check reads —
 * its span, the lyric it was planned on, its storyboard action and camera (a
 * director's draft row, else the row derived from the scene) — and each problem
 * the storyboard readiness names for it (`flags`, one sentence each). Lyric
 * anchors drop out once the storyboard is approved, as on the checklist.
 */
export function planShotRows(project, readiness = project?.productionReadiness) {
  const storyboard = readiness?.storyboard || {};
  const flags = new Map();
  const flag = (sceneId, text) => sceneId && flags.set(sceneId, [...(flags.get(sceneId) || []), text]);
  for (const c of storyboard.coverage || []) flag(c.sceneId, (COVERAGE_TEXT[c.issue] || (() => c.issue))(c));
  for (const shot of storyboard.incompleteShots || []) flag(shot.sceneId, `Missing ${shot.missing.join(', ')}`);
  if (!storyboard.approved) {
    for (const { sceneId, sung, anchored } of storyboard.lyricAnchors || []) flag(sceneId, `Sung ${quoted(sung)}, anchored to ${quoted(anchored)}`);
  }
  const rows = new Map((storyboard.shots || []).map((row) => [row.sceneId, row]));
  // Untimed shots (a new scene before its timing is set) follow the timed ones, unnumbered, so their problems stay visible.
  // Shots before the song (the cold open) lead, in play order, numbered on their own (`coldOpen`).
  const coldOpen = coldOpenScenes(project);
  const scenes = songScenes(project);
  const timed = scenes.filter((scene) => Number.isFinite(scene?.startSec)).sort((a, b) => a.startSec - b.startSec);
  const untimed = scenes.filter((scene) => scene && !Number.isFinite(scene.startSec));
  return [...coldOpen, ...timed, ...untimed]
    .map((scene, at) => {
      const row = rows.get(scene.sceneId);
      const i = at - coldOpen.length;
      return {
        scene, number: i >= 0 && i < timed.length ? i + 1 : null,
        ...(i < 0 ? { coldOpen: at + 1, durationSec: normalizePreMusic(scene.preMusic).durationSec } : {}),
        lyric: typeof scene.lyricText === 'string' ? scene.lyricText.trim() : '',
        action: row?.action || scene.visualIntent || scene.prompt || '',
        camera: row?.camera || '',
        flags: flags.get(scene.sceneId) || [],
      };
    });
}

// The art-direction row's detail and action for each Cast & Sets phase, while fields are still unwritten.
const CAST_DIRECTION_ROWS = {
  absent: ({ stillMissing, write, analyzed }) => ({ detail: `${stillMissing}Build the cast & sets to draft it from your creative direction, song style and mood board.`,
    action: { label: 'Build cast & sets', run: 'start-cast-sets', disabled: !analyzed, reason: analyzed ? undefined : 'Analyze the track first' }, secondary: write }),
  building: () => ({ detail: 'The cast & sets sheet is being built. Its art direction fills in when you approve it.', action: null }),
  stopped: ({ write }) => ({ detail: 'The cast & sets sheet stopped before it finished.', action: { label: 'Resume cast & sets', run: 'resume-cast-sets' }, secondary: write }),
  review: () => ({ detail: 'Approve the cast & sets sheet and its art direction fills in here.', action: { label: 'Review cast & sets', anchor: CAST_CHECKIN_ANCHOR } }),
  settled: ({ missing, write, fromSheet }) => fromSheet
    ? { detail: `Still missing: ${missing.join(', ')}.`, action: { label: 'Fill in from cast & sets', run: 'prepare-art' }, secondary: write }
    : { detail: `Still missing: ${missing.join(', ')}.`, action: { label: 'Write art direction', anchor: ART_DIRECTION_ANCHOR } },
};
const castDirectionRow = (phase, context) => CAST_DIRECTION_ROWS[phase](context);

/**
 * One approval row: done once approved; while open it names the first blocker that
 * is not a change request (those have their own Feedback row), else the waiting
 * text. A stale approval with nothing else blocking it can be kept as is, right
 * from the row, and each input whose approved value the server kept gets a Revert.
 */
function approvalItem(project, readiness, key, label, waitingText) {
  const approved = !!readiness?.[key]?.approved;
  const stale = staleApprovalText(readiness?.[key]?.stale);
  const blocker = readiness?.[key]?.problems?.find(notFeedback) || changeRequestBlocker(openChangeRequests(project, key));
  const keepable = !!stale && !approved && !blocker && key !== 'proof';
  return {
    id: `approve-${key}`, label: `${label} approved`, done: approved, stale: !!stale,
    detail: approved || !readiness ? null : (stale ? (keepable ? stale : `${stale} Re-approve in the editor below.`) : blocker || waitingText),
    ...(keepable
      ? { action: { label: 'Keep approved', run: 'keep-approval', stage: key }, secondary: { label: `Review ${label.toLowerCase()}`, anchor: APPROVAL_ANCHORS[key], stage: APPROVAL_STAGES[key] } }
      : { action: approved ? null : { label: `Review ${label.toLowerCase()}`, anchor: APPROVAL_ANCHORS[key], stage: APPROVAL_STAGES[key] } }),
    revert: !approved && stale && readiness[key].stale.revertible?.length ? { stage: key, fields: readiness[key].stale.revertible } : null,
  };
}

// Song: the track, its analysis, the lyrics and their timing. An autonomous run that is still going writes the song itself.
function setupChecklist({ project, readiness }) {
  const autoPhase = autonomousRunPhase(supersededStillsCheckpoint(project, readiness) ? null : project.autonomousRun).phase;
  const autoSong = ['running', 'awaiting', 'paused'].includes(autoPhase);
  // A parked run is not writing anything; say so instead of claiming it is.
  const autoSongDetail = AUTONOMOUS_SONG_DETAILS[autoPhase];
  const hasAudio = projectHasAudio(project);
  const lyrics = lyricSetupState(project, readiness);
  return [
    { id: 'track', label: 'Track attached', done: hasAudio, detail: !hasAudio && autoSong ? autoSongDetail : null,
      action: hasAudio || autoSong ? null : { label: 'Attach a track', anchor: 'mv-track' } },
    { id: 'analysis', label: 'Song analyzed', done: !!project.audioAnalysis,
      action: project.audioAnalysis ? null : { label: 'Analyze', anchor: 'mv-analyze' } },
    { id: 'lyrics', label: lyrics.instrumental ? 'Instrumental, no lyrics needed' : 'Lyrics imported', done: lyrics.imported || lyrics.ok,
      detail: 'Import the lyrics, or mark the song instrumental under Time and verify.',
      action: autoSong ? null : { label: 'Import lyrics', anchor: 'mv-lyrics-import' } },
    { id: 'timing', label: lyrics.instrumental ? 'Instrumental confirmed' : 'Lyric timing verified', done: lyrics.verified || lyrics.ok,
      detail: lyrics.alignment === 'stale' ? 'Word timings or the master changed since you verified them; verify again.'
        : lyrics.instrumental ? 'Confirm the song is instrumental under Time and verify.'
          : 'Watch the lyric playthrough under Time and verify, then confirm the timing looks right.',
      action: autoSong ? null : { label: 'Verify timing', anchor: 'mv-lyric-timing' } },
  ];
}

// Look: the art direction and guide come from the Cast & Sets sheet (approving its
// check-in writes them in), so each row offers the step that produces it: build or
// resume the sheet, open its check-in, or fill from an approved one. A director who
// skipped the sheet writes the direction and picks a guide by hand.
function castSetsChecklist({ project, readiness }) {
  const { missing, guide } = artDirectionGaps(project);
  const cast = project.castAndSets || null;
  const castPhase = castSetsPhase(cast);
  const fromSheet = cast?.status === 'approved' && !!cast.direction;
  const stillMissing = missing.length && missing.length < ART_DIRECTION_FIELDS.length ? `Still missing: ${missing.join(', ')}. ` : '';
  const write = { label: 'Write it yourself', anchor: ART_DIRECTION_ANCHOR };
  const direction = missing.length === 0 ? { detail: null, action: null }
    : castDirectionRow(castPhase, { missing, stillMissing, write, fromSheet, analyzed: !!project.audioAnalysis });
  const sheetPending = castPhase !== 'settled';
  const files = (project.devArtifacts || []).some((a) => !a.deleted);
  const pick = { label: files ? 'Choose a guide' : 'Import a guide', anchor: LOOK_GUIDES_ANCHOR };
  const guideRow = guide ? { detail: null, action: null }
    : fromSheet && !project.productionReview?.draft?.guideArtifactId && cast.artifactId
      ? { detail: 'Use the cast & sets sheet as the guide, or pick another file.', action: { label: 'Use the sheet', run: 'prepare-art' }, secondary: pick }
      : sheetPending ? { detail: 'Comes with the cast & sets sheet, or use a file of your own.', action: files ? pick : null, secondary: files ? null : pick }
        : { detail: 'Pick a file below with Use as visual guide, or import one.', action: pick };
  const approve = approvalItem(project, readiness, 'art', 'Art direction', 'Ready for your review. Approving a sheet file does not approve the art direction; approve it below.');
  // Until there is direction and a guide there is nothing to review, so the row sends nowhere
  // (a stale approval keeps its row: it names what changed and offers the reverts).
  const waiting = !approve.done && !approve.stale && (missing.length > 0 || !guide);
  return [
    { id: 'direction', label: 'Art direction written', done: missing.length === 0, ...direction },
    { id: 'guide', label: guide ? `Visual guide chosen: ${guide.title || guide.filename || 'sheet'}` : 'Visual guide chosen', done: !!guide, ...guideRow },
    feedbackItem(project, 'art', readiness),
    waiting ? { ...approve, detail: 'Opens once the art direction is written and a guide is chosen.', action: null } : approve,
  ].filter(Boolean);
}

// Storyboard: shots planned, then each open plan problem and the storyboard feedback.
function boardChecklist({ project, readiness, scenes, draft }) {
  const planned = scenes.length > 0 || (draft.storyboard || []).length > 0;
  const feedback = feedbackItem(project, 'storyboard', readiness);
  const problems = [...storyboardProblemItems(readiness, scenes), ...(feedback ? [feedback] : [])];
  return [
    { id: 'shots', label: 'Shots planned', done: planned, detail: planned ? null : 'Fit the panels to the song under Make shots, or run AI Plan under Shot timing on Shots.',
      action: planned ? null : project?.storyboardId ? { label: 'Make shots', anchor: 'mv-board-fit' } : { label: 'Open shot timing', stage: 'produce', anchor: 'mv-board-plan' } },
    ...(project?.storyboardReopenedAt ? [{ id: 'storyboard-approved', label: 'Storyboard approved', done: false,
      detail: 'Reopened for rework. Approve it once the panels are right.', action: { label: 'Approve storyboard', anchor: 'mv-board-approve' } }] : []),
    ...problems,
  ];
}

function footageItem(project, scenes) {
  const layered = isLayeredComposition(project);
  const ready = scenes.filter((scene) => sceneRenderReady(scene, { layered })).length;
  const footageDone = footageReady(project);
  return { id: 'footage', label: `Footage for every shot (${formatCount(ready)} of ${formatCount(scenes.length)})`, done: footageDone,
    action: footageDone ? null : { label: 'Make the footage', anchor: 'mv-generation' } };
}

// Once clip locks are in use, every video shot locks its clip; the board's Needs attention
// filter lists exactly these shots (and any other open work). Null while no clip is locked.
function clipLockItem(readiness) {
  const clips = Object.values(readiness?.storyboard?.clipLocks || {});
  if (!clips.some((state) => state === 'locked' || state === 'changed')) return null;
  const left = unlockedShots(readiness).videos.length;
  return { id: 'lock-clips', label: 'Every video locked', done: !left,
    detail: left ? `${formatCount(left)} video${left === 1 ? '' : 's'} not locked yet. Lock each on its card once its clip is right.` : null,
    action: left ? { label: left === 1 ? 'Show it' : `Show these ${formatCount(left)}`, anchor: 'mv-scene-board', params: { scenes: 'attention' } } : null };
}

// Make's composition row by render mode; concat and the other footage-only modes have none.
const COMPOSITION_ITEMS = {
  // Timed lyrics with no subtitle cues are drawn by the render itself, as the player shows them.
  composed: (composition, project) => composedDrawsLyrics(project)
    ? { id: 'composition', label: 'Lyrics drawn over the footage', done: true }
    : { id: 'composition', label: 'Timed typography added', done: (composition.textCues || []).length > 0, action: { label: 'Add typography', anchor: 'mv-typo-font' } },
  document: (composition) => ({ id: 'composition', label: 'Composition document attached', done: !!composition.document, action: { label: 'Attach a document', anchor: 'mv-doc-folder' } }),
  eidoverse: (composition) => {
    const saved = !!composition.eidoverseScene?.inlineScript;
    return { id: 'composition', label: 'Save the Eidoverse scene', done: saved, action: saved ? null : { label: 'Save the scene', anchor: 'mv-eidoverse-scene' } };
  },
  code: (composition, project) => {
    const done = codeComposed(project);
    return { id: 'composition', label: composition.codeVideo?.generatedAt ? 'Code video generated' : 'Code video sections ready', done,
      detail: done ? null : 'Generate the code video from the Code Video panel.',
      action: done ? null : { label: 'Open Code Video', anchor: 'mv-code-section' } };
  },
};

// Make: the footage (unless the render style draws its own picture), every still
// locked (the storyboard approval), every clip locked once clip locks are in use,
// the composition over them, then the optional proof while a run needs it.
function produceChecklist({ project, readiness, scenes, draft, mode }) {
  const items = FOOTAGE_OPTIONAL_MODES.has(mode) ? [] : [footageItem(project, scenes)];
  // A document storyboard is approved whole; Board shots lock their stills one by one or all at once.
  const documentBoard = draft.storyboardSource === 'document';
  const reviewed = approvalItem(project, readiness, 'storyboard', 'Timed storyboard', documentBoard ? 'Ready for your review below.' : 'Lock each still on its card, or lock them all below.');
  const planOpen = (readiness?.storyboard?.problems || []).some(planProblem) && !reviewed.stale;
  const stills = documentBoard ? reviewed : { ...unlockedDetail(readiness, reviewed), label: 'Every still locked',
    ...(reviewed.action && !reviewed.action.run ? { action: { ...reviewed.action, label: 'Lock the stills' } } : {}) };
  const lookOpen = !planOpen && !reviewed.stale && (readiness?.storyboard?.problems || []).some((text) => ART_APPROVAL_PROBLEM.test(text));
  items.push(reviewed.done ? stills
    : planOpen ? { ...stills, detail: 'Finish the storyboard first.', action: { label: 'Open the storyboard', stage: 'board' } }
      : lookOpen ? { ...stills, detail: 'Approve the Look first.', action: { label: 'Open Look', stage: 'cast-sets', anchor: APPROVAL_ANCHORS.art } }
        : stills);
  const lockClips = clipLockItem(readiness);
  if (lockClips) items.push(lockClips);
  const work = COMPOSITION_ITEMS[mode]?.(project.composition || {}, project);
  if (work) items.push(work);
  const proofFeedback = feedbackItem(project, 'proof', readiness, { optional: true });
  if (proofFeedback) items.push(proofFeedback);
  // Optional: never counted toward the step being done.
  if (proofReviewInUse(project, readiness)) {
    const proofApproval = approvalItem(project, readiness, 'proof', 'Animated proof', null);
    items.push({ ...proofApproval, label: proofApproval.done ? proofApproval.label : 'Animated proof (optional)', optional: true, detail: null });
  }
  return items;
}

function reviewChecklist({ project, readiness }) {
  return [{
    id: 'final', label: 'Final video rendered', done: !!project.renderHistoryId && !isFinalRenderStale(project),
    detail: isFinalRenderStale(project) ? `${STALE_RENDER_MESSAGE}.${finishedOutside(project) && !readiness?.readyForProduction ? ` ${FINISHED_OUTSIDE_RERENDER_NOTE}` : ''}` : null,
    action: project.renderHistoryId && !isFinalRenderStale(project) ? null : { label: project.renderHistoryId ? 'Re-render' : 'Render', anchor: 'mv-final-video' },
  }];
}

const POST_STATE_LABELS = { posted: 'posted', draft: 'draft filled', none: 'not started' };

// Publish: the kit from the current render, its copy, then one row per enabled platform.
function publishChecklist({ project, publish }) {
  const kit = project.publishKit || {};
  const kitCurrent = !!kit.builtAt && (!kit.master?.renderHistoryId || kit.master.renderHistoryId === project.renderHistoryId);
  const progress = publishPlatformProgress(project, publish);
  const items = [
    { id: 'kit', label: 'Kit built from the current render', done: kitCurrent,
      detail: kit.builtAt && !kitCurrent ? 'The final render changed since the kit was built; rebuild it.' : null,
      action: kitCurrent ? null : { label: 'Build the kit', anchor: PUBLISH_ANCHOR } },
    { id: 'copy', label: 'Copy drafted', done: !!(kit.copyDraftedAt || kit.copy), action: kit.copyDraftedAt || kit.copy ? null : { label: 'Draft the copy', anchor: PUBLISH_ANCHOR } },
  ];
  const openPublishing = progress.done ? null : { label: 'Open publishing', anchor: PUBLISH_ANCHOR };
  if (!progress.rows.length) return [...items, { id: 'posted', label: 'Posted to a platform', done: progress.done, action: openPublishing }];
  items.push({ id: 'posted', label: `Posted to every enabled platform (${formatCount(progress.posted)} of ${formatCount(progress.total)})`, done: progress.done, action: openPublishing });
  return items.concat(progress.rows.map((row) => ({
    id: `post-${row.target}`, label: `${row.label}: ${POST_STATE_LABELS[row.state]}`, done: row.state === 'posted',
    action: row.state === 'posted' ? null : { label: row.state === 'draft' ? 'Finish this post' : 'Post here', anchor: publishRowAnchor(row.target) },
  })));
}

const STAGE_CHECKLISTS = {
  setup: setupChecklist, 'cast-sets': castSetsChecklist, board: boardChecklist,
  produce: produceChecklist, review: reviewChecklist, publish: publishChecklist,
};

/**
 * What one stage tab needs before it counts as done, as a short checklist the
 * tab shows above its panels: `[{ id, label, done, detail?, action? }]`. The
 * `done` answers mirror `deriveStages`, so the tab, its status mark and the
 * header's "needs you" agree; `detail` says what is still missing (for an
 * approval, the server's first readiness problem); `action` is a
 * `{ label, anchor }` the tab can scroll to. Approvals are revision-bound and
 * are decided on their own stage tab, never on a development file: approving a
 * Cast & Sets sheet file does not approve the art direction, so the art item
 * says so while it is open.
 */
export function stageChecklist(stageId, project, readiness = project?.productionReadiness, publish = {}) {
  if (!project) return [];
  const external = finishedOutsideCovers(project, stageId) ? finishedOutside(project) : null;
  if (external) {
    return [{ id: 'finished-outside', label: 'Finished outside PortOS', done: true,
      detail: external.note || 'Marked finished in Project settings; no approval is recorded here.' }];
  }
  const build = STAGE_CHECKLISTS[stageId];
  if (!build) return [];
  return build({ project, readiness, publish, draft: project.productionReview?.draft || {}, scenes: project.scenes || [], mode: project.composition?.mode || 'concat' });
}

/**
 * One short fact per step for the step list, so where the project stands reads
 * without opening any step: the song's length and lyric count, the visual
 * guide, the shot count, how many shots have their picture, the final render's
 * state and how many platforms have a post. Keyed by stage id; a step with
 * nothing to say yet maps to an empty string.
 */
export function stepNotes(project, readiness = project?.productionReadiness, publish = {}) {
  if (!project) return {};
  const scenes = project.scenes || [];
  const lines = (project.lyricCues || []).filter((cue) => isNonBlankStr(cue.text)).length;
  const duration = project.audioAnalysis?.durationSec;
  const lyrics = lyricSetupState(project, readiness);
  const song = [
    Number.isFinite(duration) ? formatDurationSec(duration) : projectHasAudio(project) ? 'Track attached' : 'No track yet',
    lyrics.instrumental ? 'instrumental' : lines ? `${formatCount(lines)} lyric ${lines === 1 ? 'line' : 'lines'}` : null,
  ].filter(Boolean).join(' · ');
  const draft = project.productionReview?.draft || {};
  const guide = (project.devArtifacts || []).find((a) => a.id === draft.guideArtifactId && !a.deleted);
  const look = guide ? 'Visual guide chosen' : project.castAndSets ? 'Cast and sets built' : '';
  const board = scenes.length ? `${formatCount(scenes.length)} ${scenes.length === 1 ? 'shot' : 'shots'}` : '';
  const mode = project.composition?.mode || 'concat';
  let make = '';
  if (scenes.length && !FOOTAGE_OPTIONAL_MODES.has(mode)) {
    const layered = isLayeredComposition(project);
    const ready = scenes.filter((scene) => sceneRenderReady(scene, { layered })).length;
    make = `${formatCount(ready)} of ${formatCount(scenes.length)} shots have their picture`;
  } else if (scenes.length) make = 'Picture drawn by the composition';
  // Once the picture is in, an unfinished Shots step names what is left instead.
  if (scenes.length && readiness && deriveStages(project, readiness, publish).stages.find((stage) => stage.id === 'produce')?.state !== 'done') {
    const open = stageChecklist('produce', project, readiness, publish).filter((item) => !item.done && !item.optional);
    const { stills, videos } = unlockedShots(readiness);
    const unlocked = [stills.length && `${formatCount(stills.length)} ${stills.length === 1 ? 'still' : 'stills'}`,
      videos.length && `${formatCount(videos.length)} ${videos.length === 1 ? 'video' : 'videos'}`].filter(Boolean).join(' and ');
    if (open.length && !open.some((item) => item.id === 'footage')) make = unlocked ? `${unlocked} not locked` : `To do: ${open[0].label}`;
  }
  // Before a final render, the drafts and proofs to watch are what Final render holds.
  const drafts = (project.excerpts || []).filter((e) => e.status === 'complete' && e.filename).length;
  const review = isFinalRenderStale(project) ? 'Out of date' : project.renderHistoryId ? 'Rendered'
    : drafts ? `${formatCount(drafts)} ${drafts === 1 ? 'draft' : 'drafts'} to watch` : '';
  const posts = publishPlatformProgress(project, publish);
  const publishNote = posts.total ? `${formatCount(posts.posted)} of ${formatCount(posts.total)} posted` : posts.posted ? 'Posted' : '';
  return { setup: song, story: project.concept?.prompt?.trim() ? 'Concept written' : '', 'cast-sets': look, board, produce: make, review, publish: publishNote };
}

/**
 * Sort comparator to organize Music Video projects so the newest one is first.
 * Compares `createdAt` descending (newest created first), falling back to
 * `updatedAt` descending, and preserves relative order if neither is set.
 */
export function compareMusicVideoProjectsNewestFirst(a, b) {
  const aTime = Date.parse(a?.createdAt || a?.updatedAt) || 0;
  const bTime = Date.parse(b?.createdAt || b?.updatedAt) || 0;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  const aUpdated = Date.parse(a?.updatedAt) || 0;
  const bUpdated = Date.parse(b?.updatedAt) || 0;
  if (aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }
  return 0;
}
