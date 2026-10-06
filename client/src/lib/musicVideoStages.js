/**
 * Music Video page stages: the tab set, which stage a project is in, the one
 * "next action" the sticky header offers for it, and the project's generation
 * spend. Pure functions over the project record so the header, the progress
 * strip and the tests all read the same answer.
 */
import { isLayeredComposition, isSelfDrawnLayer, sceneRenderReady, sceneVisualLayer } from './musicVideoLayers.js';
import {
  AUTONOMOUS_CHECKPOINT_LABELS, AUTONOMOUS_LYRICS_STEP_LABELS, AUTONOMOUS_SONG_STEP_LABELS, AUTONOMOUS_STATUS_LABELS,
} from './musicVideoAutonomous.js';
import { formatCount, formatDurationSec, formatTimecode } from '../utils/formatters.js';
import { isNonBlankStr } from './textUtils';
import { modeLabel } from './imageGenModes.js';
import { falSceneTake } from './musicVideoShotTiming.js';
import { latestMusicVideoReviewDraft } from '../../../server/lib/musicVideoReviewDraft.js';

/**
 * The six steps of a music video, in the order the director decides them. The
 * ids are the route's `:stage` values and stay stable across the relabel
 * (#10297 follow-up): Song is `setup`, Look is `cast-sets`, Storyboard is
 * `board`, Make is `produce` (footage, composition and the proof that closes
 * them) and Final render is `review`. `doneWhen` is the one line a step
 * shows under its title.
 */
export const MUSIC_VIDEO_STAGES = [
  { id: 'setup', label: 'Song', title: 'Song', doneWhen: 'Done when the track is analyzed and every lyric word is timed to the vocal.' },
  { id: 'cast-sets', label: 'Look', title: 'Look', doneWhen: 'Done when the art direction is written, a visual guide is chosen, and you approve it.' },
  { id: 'board', label: 'Storyboard', title: 'Storyboard', doneWhen: 'Done when shots cover the whole song and you approve the timed storyboard.' },
  { id: 'produce', label: 'Make', title: 'Make', doneWhen: 'Done when every shot has its picture and you approve a proof watched with sound.' },
  { id: 'review', label: 'Final render', title: 'Final render', doneWhen: 'Done when the full video is rendered from the approved plan and is up to date.' },
  { id: 'publish', label: 'Publish', title: 'Publish', doneWhen: 'Done when every platform you turned on has a post.' },
];

// Old links name the Compose tab, which is now part of Make.
const LEGACY_STAGE_IDS = { compose: 'produce' };


export const isStageId = (value) => MUSIC_VIDEO_STAGES.some((stage) => stage.id === value);

/** A production run in one of these states can still be resumed (or is live). */
export const RESUMABLE_RUN_STATUSES = new Set(['running', 'stopped', 'limit-reached', 'blocked', 'needs-replan']);
// A stopped run that needs the director's attention rather than a click on Resume.
const RUN_BLOCKED_STATUSES = new Set(['limit-reached', 'blocked', 'needs-replan', 'needs-human', 'failed']);
const CAST_WORKING = new Set(['directing', 'imaging', 'assembling']);

/** The run worth showing: the live one, else the most recent. */
export const currentProductionRun = (project) => {
  const runs = Array.isArray(project?.productionRuns) ? project.productionRuns : [];
  return runs.find((r) => RESUMABLE_RUN_STATUSES.has(r.status)) || runs[runs.length - 1] || null;
};

/** Current review guidance for a stopped approval-gated run; retain other failures. */
export function productionReviewStopGuidance(run, readiness, through = 'proof') {
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
    const cost = settings.backend === 'fal'
      ? falSceneTake({ scene, videoSettings: settings, songDurationSec: project?.audioAnalysis?.durationSec ?? null }).costUsd
      : null;
    if (Number.isFinite(cost)) knownUsd += cost;
    else unpriced += 1;
  }
  const jobs = missingFrames + missingClips.length;
  return { jobs, knownUsd, unpriced, suggestedMaxGenerations: Math.min(500, Math.max(1, Math.ceil(jobs * 1.25))) };
}

/**
 * Everything the docked preview can play, in the order it picks a default:
 * the final render (its resolved `finalVideoSrc`), the composition document,
 * then each finished draft excerpt, newest first. While editing the
 * composition (`liveFirst`, the Compose stage) the live document leads so an
 * old final render is not what the user sees by default. A final render whose
 * inputs changed is labelled out of date. Last comes the storyboard animatic —
 * the song under each shot's frame or card — so a project with a track and
 * shots always has something to watch. Each entry has a stable `id` (the
 * `?play=` value) and a `label` for the source picker.
 */
export function listPreviewSources(project, { finalVideoSrc = null, liveFirst = false } = {}) {
  const sources = [];
  const final = project?.renderHistoryId && finalVideoSrc
    ? { id: 'final', kind: 'video', label: project.renderDependencyState?.status === 'stale' ? 'Final render (out of date)' : 'Final render', src: finalVideoSrc, startSec: 0, endSec: null }
    : null;
  const live = project?.composition?.mode === 'document' && project.composition.document
    ? { id: 'document', kind: 'document', label: 'Composition (live)' }
    : null;
  sources.push(...(liveFirst ? [live, final] : [final, live]).filter(Boolean));
  const excerpts = (project?.excerpts || []).filter((e) => e.status === 'complete' && e.filename).reverse();
  for (const excerpt of excerpts) {
    sources.push({
      id: `excerpt:${excerpt.id}`, kind: 'video', src: `/data/videos/${excerpt.filename}`,
      startSec: excerpt.startSec, endSec: excerpt.endSec,
      label: `${excerpt.dependencyState?.status === 'stale' ? 'Older draft' : 'Draft'} ${formatTimecode(excerpt.startSec)}–${formatTimecode(excerpt.endSec)} · ${excerpt.id.slice(-6)}`,
    });
  }
  if (projectHasAudio(project) && (project?.scenes || []).length > 0) {
    sources.push({ id: 'animatic', kind: 'animatic', label: 'Storyboard animatic' });
  }
  return sources;
}

// A stopped run can be resumed as is; the others need the director first.
const PRODUCTION_RUN_LABELS = {
  running: 'Production running', stopped: 'Production paused', blocked: 'Production blocked',
  'limit-reached': 'Production at its limit', 'needs-replan': 'Production needs a replan',
};

/**
 * What the header's Autopilot button says: the autonomous run's current step or
 * state, else a live or parked production run, else just "Autopilot". Tones are
 * `ok`, `warn` or `muted`; `short` is the phone label.
 */
export function autopilotStatus(project) {
  const auto = project?.autonomousRun;
  if (auto && auto.status !== 'canceled') {
    let label;
    if (auto.status === 'running' && !auto.interrupted) {
      const step = auto.stages?.[auto.stage]?.step;
      const stepDetail = (auto.stage === 'lyrics' && AUTONOMOUS_LYRICS_STEP_LABELS[step])
        || (auto.stage === 'song' && AUTONOMOUS_SONG_STEP_LABELS[step])
        || (AUTONOMOUS_CHECKPOINT_LABELS[auto.stage] ? AUTONOMOUS_CHECKPOINT_LABELS[auto.stage].toLowerCase() : null);
      label = stepDetail ? `Autonomous run: ${stepDetail.toLowerCase()}` : 'Autonomous run running';
    } else {
      const statusLabel = auto.interrupted ? 'interrupted' : (AUTONOMOUS_STATUS_LABELS[auto.status] || auto.status).toLowerCase();
      label = `Autonomous run ${statusLabel}`;
    }
    const tone = auto.status === 'completed' ? 'ok' : auto.status === 'running' && !auto.interrupted ? 'muted' : 'warn';
    if (auto.status !== 'completed') return { label, short: tone === 'warn' ? 'Autopilot needs you' : 'Autopilot running', tone };
  }
  const run = currentProductionRun(project);
  if (run && RESUMABLE_RUN_STATUSES.has(run.status)) {
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
  const allDone = progress.stages.every((stage) => stage.state === 'done');
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

/** Resolve the `:stage` route param (a retired id maps to its step); an unknown or missing value is null. */
export const resolveStageParam = (value) => (isStageId(value) ? value : LEGACY_STAGE_IDS[value] || null);

// Footage-optional modes draw their own picture, so scene footage never gates Produce.
export const FOOTAGE_OPTIONAL_MODES = new Set(['code', 'document', 'eidoverse']);

// A code video is composed once it was generated or the director holds sections to render.
const codeComposed = (project) => {
  const code = project.composition?.codeVideo;
  return !!code?.generatedAt || (code?.sections || []).length > 0;
};

const composeDone = (project, mode) => {
  if (mode === 'composed') return (project.composition?.textCues || []).length > 0;
  if (mode === 'document') return !!project.composition?.document;
  if (mode === 'eidoverse') return !!project.composition?.eidoverseScene?.inlineScript;
  if (mode === 'code') return codeComposed(project);
  // Footage has nothing to compose.
  return true;
};

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
 * Make (`produce`) holds the footage, the composition over it and the animated
 * proof that closes both (#10140): the proof's basis covers the whole
 * composition (typography, grade), so it is judged last. A later typography or
 * grade edit marks Make stale until the proof is approved again.
 */
export function deriveStages(project, readiness = project?.productionReadiness, publish = {}) {
  const scenes = project?.scenes || [];
  const mode = project?.composition?.mode || 'concat';
  const cast = project?.castAndSets || null;
  const run = currentProductionRun(project);
  const liveRun = !!run && RESUMABLE_RUN_STATUSES.has(run.status);
  const layered = isLayeredComposition(project);
  // Code and document renders draw the picture themselves; scene footage is optional there.
  const footageOptional = FOOTAGE_OPTIONAL_MODES.has(mode);
  const planned = !!readiness?.storyboard.approved;
  const castStopped = !!cast && (cast.interrupted || cast.status === 'failed');
  const castDone = !!readiness?.art.approved;
  const produceDone = planned && (footageOptional || scenes.every((scene) => sceneRenderReady(scene, { layered })));

  const done = {
    setup: projectHasAudio(project) && !!project?.audioAnalysis && lyricSetupState(project, readiness).ok,
    'cast-sets': castDone,
    board: planned,
    produce: produceDone && composeDone(project || {}, mode) && !!readiness?.proof.approved,
    // A render made before later scene edits no longer counts as the final video.
    review: !!project?.renderHistoryId && !isFinalRenderStale(project),
    // #9281/#9282: published once every enabled platform has a recorded post.
    publish: publishPlatformProgress(project, publish).done,
  };
  const blocked = {
    'cast-sets': castStopped,
    produce: !!run && RUN_BLOCKED_STATUSES.has(run.status),
  };
  // Approved earlier, inputs changed since (#10141): the tab says so rather than
  // reading as never done. The check-in sheet stays approved while stale.
  const stale = {
    'cast-sets': !!readiness?.art?.stale || !!readiness?.castAndSets?.stale,
    board: !!readiness?.storyboard?.stale,
    produce: !!readiness?.proof?.stale,
  };
  const current = liveRun
    ? 'produce'
    : (MUSIC_VIDEO_STAGES.find((stage) => !done[stage.id])?.id || 'publish');
  const stages = MUSIC_VIDEO_STAGES.map((stage) => {
    let state = 'todo';
    if (done[stage.id] && !(stage.id === current && liveRun)) state = 'done';
    else if (stage.id === current) state = blocked[stage.id] ? 'blocked' : 'active';
    return { ...stage, state, stale: !!stale[stage.id] };
  });
  return { stages, current };
}

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
  const { current } = deriveStages(project, readiness, publish);
  const run = currentProductionRun(project);
  const cast = project.castAndSets || null;
  const scenes = project.scenes || [];

  if (proofActive) return { id: 'proof-progress', kind: 'goto', stage: 'produce', anchor: 'mv-review-render', label: 'View review render', shortLabel: 'Review' };
  if (draftActive) return { id: 'draft-progress', kind: 'goto', stage: 'review', anchor: 'mv-draft-excerpts', label: 'View draft render', shortLabel: 'Draft' };
  const art = !readiness?.art.approved;
  const board = !readiness?.storyboard.approved;
  // The approval panel only opens once the stage's own work exists: a stage with
  // nothing built yet (no check-in, no shots) offers Start / Plan, and an open
  // or interrupted check-in offers Approve / Resume — those come from the stage switch below.
  const castNeedsOwnAction = art && ((!cast && scenes.length === 0) || (cast && (cast.status === 'review' || cast.interrupted || cast.status === 'failed')));
  const boardNeedsOwnAction = !art && board && scenes.length === 0;
  // The proof closes Make, so it waits for Make's footage — unless a production
  // run is parked on its pilot proof, which only the approval frees.
  const footageOptional = FOOTAGE_OPTIONAL_MODES.has(project.composition?.mode || 'concat');
  const layered = isLayeredComposition(project);
  const footageDone = footageOptional || scenes.every((scene) => sceneRenderReady(scene, { layered }));
  const proofDue = current !== 'produce' || footageDone || (!!run && RESUMABLE_RUN_STATUSES.has(run.status));
  if (projectHasAudio(project) && project.audioAnalysis && !CAST_WORKING.has(cast?.status) && !readiness?.readyForProduction && (art || board || proofDue)
    && run?.status !== 'running' && !renderActive && !kickoffRunning
    && !castNeedsOwnAction && !boardNeedsOwnAction) {
    return { id: 'review-production', kind: 'goto', stage: art ? 'cast-sets' : board ? 'board' : 'produce',
      anchor: art ? 'mv-review-art' : board ? 'mv-review-storyboard' : 'mv-review-proof',
      label: art ? 'Review art direction' : board ? 'Review timed storyboard' : 'Review animated proof',
      shortLabel: art ? 'Review art' : board ? 'Review storyboard' : 'Review proof' };
  }
  if (run && RESUMABLE_RUN_STATUSES.has(run.status)) {
    if (run.status === 'running' && !run.interrupted) return { id: 'stop-production', kind: 'run', label: 'Stop production', shortLabel: 'Stop', runId: run.id };
    return {
      id: 'resume-production', kind: 'run', runId: run.id, acceptBasis: run.status === 'needs-replan',
      label: run.status === 'needs-replan' ? 'Resume with new setup' : 'Resume production',
      shortLabel: 'Resume',
    };
  }
  if (renderActive) {
    const label = renderPending ? 'Preparing…' : `Rendering… ${Math.round(renderProgress)}%`;
    return { id: 'render-progress', kind: 'run', label, shortLabel: label, disabled: true };
  }
  if (kickoffRunning || analyzing || planning) {
    const label = kickoffStep || (planning ? 'Planning…' : 'Working…');
    return { id: 'busy', kind: 'run', label, shortLabel: label, disabled: true };
  }

  const auto = project.autonomousRun;
  if (auto && auto.status !== 'completed' && auto.status !== 'canceled') {
    if (auto.status === 'running' && !auto.interrupted) {
      const step = auto.stages?.[auto.stage]?.step;
      const stepText = (auto.stage === 'lyrics' && AUTONOMOUS_LYRICS_STEP_LABELS[step])
        || (auto.stage === 'song' && AUTONOMOUS_SONG_STEP_LABELS[step])
        || (AUTONOMOUS_CHECKPOINT_LABELS[auto.stage] ? `${AUTONOMOUS_CHECKPOINT_LABELS[auto.stage]}…` : 'Autonomous run running…');
      const busyLabel = stepText.endsWith('…') ? stepText : `${stepText}…`;
      return { id: 'busy', kind: 'run', label: busyLabel, shortLabel: busyLabel, disabled: true };
    }
    if (auto.status === 'awaiting-approval') {
      const target = AUTONOMOUS_CHECKPOINT_LABELS[auto.awaiting] || auto.awaiting || 'checkpoint';
      // The checkpoint editor is in Project settings › Autopilot; the page opens it.
      return { id: 'review-autonomous', kind: 'open', label: `Review ${target}`, shortLabel: 'Review' };
    }
    if (auto.interrupted || auto.status === 'stopped' || auto.status === 'needs-human') {
      return { id: 'resume-autonomous', kind: 'run', label: 'Resume autonomous run', shortLabel: 'Resume' };
    }
    if (auto.status === 'failed') {
      return { id: 'retry-autonomous', kind: 'run', label: 'Retry autonomous run', shortLabel: 'Retry' };
    }
  }

  switch (current) {
    case 'setup':
      if (!projectHasAudio(project)) return { id: 'goto-setup', kind: 'goto', stage: 'setup', anchor: 'mv-track', label: 'Attach a track', shortLabel: 'Track' };
      if (project.automation && scenes.length === 0) {
        return { id: 'kickoff', kind: 'run', label: 'Run autopilot', shortLabel: 'Autopilot', disabled: !!kickoffBlockedReason, reason: kickoffBlockedReason || undefined };
      }
      if (!project.audioAnalysis) return { id: 'analyze', kind: 'run', label: 'Analyze song', shortLabel: 'Analyze' };
      // Analyzed: what keeps Song open is the lyrics or their timing, finished on the step itself.
      return lyricSetupState(project, readiness).imported
        ? { id: 'verify-timing', kind: 'goto', stage: 'setup', anchor: 'mv-lyric-timing', label: 'Verify lyric timing', shortLabel: 'Timing' }
        : { id: 'import-lyrics', kind: 'goto', stage: 'setup', anchor: 'mv-lyrics-import', label: 'Add the lyrics', shortLabel: 'Lyrics' };
    case 'cast-sets':
      if (cast?.status === 'review') return { id: 'approve-cast-sets', kind: 'run', label: 'Approve cast & sets', shortLabel: 'Approve' };
      if (cast && (cast.interrupted || cast.status === 'failed')) return { id: 'resume-cast-sets', kind: 'run', label: 'Resume cast & sets', shortLabel: 'Resume' };
      if (cast && CAST_WORKING.has(cast.status)) return { id: 'busy', kind: 'run', label: 'Building cast & sets…', shortLabel: 'Building…', disabled: true };
      if (!cast && !project.automation) return { id: 'start-cast-sets', kind: 'run', label: 'Build cast & sets', shortLabel: 'Build', disabled: !project.audioAnalysis, reason: project.audioAnalysis ? undefined : 'Analyze the track first' };
      return { id: 'kickoff', kind: 'run', label: 'Run autopilot', shortLabel: 'Autopilot', disabled: !!kickoffBlockedReason, reason: kickoffBlockedReason || undefined };
    case 'board':
      return { id: 'plan', kind: 'run', label: 'Plan the shots', shortLabel: 'Plan', disabled: !project.audioAnalysis, reason: project.audioAnalysis ? undefined : 'Analyze the track first' };
    case 'produce': {
      if (run?.status === 'needs-human') return { id: 'goto-review', kind: 'goto', stage: 'review', label: 'Review the draft', shortLabel: 'Review' };
      if (!footageDone) return { id: 'goto-produce', kind: 'goto', stage: 'produce', anchor: 'mv-generation', label: 'Make the footage', shortLabel: 'Make' };
      const label = { document: 'Attach a composition', eidoverse: 'Save the Eidoverse scene', code: 'Generate the code video' }[project.composition?.mode] || 'Add typography';
      const shortLabel = { document: 'Attach', eidoverse: 'Save', code: 'Generate' }[project.composition?.mode] || 'Type';
      return { id: 'goto-compose', kind: 'goto', stage: 'produce', anchor: 'mv-composition', label, shortLabel };
    }
    case 'publish':
      return project.publishKit?.builtAt
        ? { id: 'goto-publish', kind: 'goto', stage: 'publish', label: 'Publish the release', shortLabel: 'Publish' }
        : { id: 'goto-publish', kind: 'goto', stage: 'publish', label: 'Build the publishing kit', shortLabel: 'Kit' };
    default:
      if (isFinalRenderStale(project)) {
        return {
          id: 'render-final', kind: 'run', label: 'Re-render final video', shortLabel: 'Re-render',
          disabled: renderBlockedByOther, reason: renderBlockedByOther ? 'Wait for the other project render to finish' : undefined,
        };
      }
      if (project.renderHistoryId) return { id: 'goto-final', kind: 'goto', stage: 'review', anchor: 'mv-final-video', label: 'Watch final video', shortLabel: 'Watch' };
      return {
        id: 'render-final', kind: 'run', label: 'Render final video', shortLabel: 'Render',
        disabled: renderBlockedByOther, reason: renderBlockedByOther ? 'Wait for the other project render to finish' : undefined,
      };
  }
}

// The editable art-direction fields the art approval needs before art can be approved.
const ART_DIRECTION_FIELDS = [['cast', 'cast'], ['environments', 'sets'], ['visualLanguage', 'visual language'], ['motionLanguage', 'motion']];
/** "Approved earlier — changed since: concept, scene 3 prompt" for an approval whose inputs moved; null otherwise. */
export function staleApprovalText(stale) {
  if (!stale) return null;
  return stale.changedFields.length ? `Approved earlier — changed since: ${changedFieldsText(stale.changedFields)}.` : 'Approved earlier — its inputs changed since.';
}
/** "concept, scene 3 prompt +2 more": the first `limit` changed inputs of a stale approval. */
export function changedFieldsText(changedFields, limit = 4) {
  const more = changedFields.length > limit ? ` +${changedFields.length - limit} more` : '';
  return `${changedFields.slice(0, limit).join(', ')}${more}`;
}
const APPROVAL_ANCHORS = { art: 'mv-review-art', storyboard: 'mv-review-storyboard', proof: 'mv-review-proof' };
const APPROVAL_STAGES = { art: 'cast-sets', storyboard: 'board', proof: 'produce' };
const PUBLISH_ANCHOR = 'mv-publish-kit';

// Storyboard readiness problems, grouped by what the user has to go fix. The
// server returns plain sentences; the first matching rule picks the group.
const STORYBOARD_PROBLEM_GROUPS = [
  { id: 'art', label: 'Art direction', test: /art direction|art feedback/i, action: { label: 'Review art direction', anchor: APPROVAL_ANCHORS.art } },
  { id: 'lyrics', label: 'Lyrics', test: /lyrics|instrumental/i, action: { label: 'Import lyrics', stage: 'setup', anchor: 'mv-lyrics-import' } },
  { id: 'timing', label: 'Lyric timing', test: /alignment|timing|vocal|master song/i, action: { label: 'Verify timing', stage: 'setup', anchor: 'mv-lyric-timing' } },
  { id: 'coverage', label: 'Shot coverage', test: /cover the master|gaps or overlaps|create a timed/i, action: { label: 'Open the treatment', anchor: 'mv-board-treatment' } },
  { id: 'shots', label: 'Shot details', test: /./, action: { label: 'Edit the storyboard', anchor: APPROVAL_ANCHORS.storyboard } },
];

/** One open checklist item per group of storyboard readiness problems, listing every problem in it. */
function storyboardProblemItems(readiness) {
  const problems = readiness?.storyboard?.problems || [];
  if (readiness?.storyboard?.approved || !problems.length) return [];
  return STORYBOARD_PROBLEM_GROUPS.flatMap((group, index) => {
    const earlier = STORYBOARD_PROBLEM_GROUPS.slice(0, index);
    const mine = problems.filter((text) => group.test.test(text) && !earlier.some((g) => g.test.test(text)));
    return mine.length ? [{ id: `board-${group.id}`, label: group.label, done: false, details: mine, action: group.action }] : [];
  });
}

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
  const draft = project.productionReview?.draft || {};
  const scenes = project.scenes || [];
  const mode = project.composition?.mode || 'concat';
  const approval = (key, label, waitingText) => {
    const approved = !!readiness?.[key]?.approved;
    const stale = staleApprovalText(readiness?.[key]?.stale);
    return {
      id: `approve-${key}`, label: `${label} approved`, done: approved, stale: !!stale,
      detail: approved || !readiness ? null : (stale ? `${stale} Re-approve in the editor below.` : readiness[key]?.problems?.[0] || waitingText),
      action: approved ? null : { label: `Review ${label.toLowerCase()}`, anchor: APPROVAL_ANCHORS[key], stage: APPROVAL_STAGES[key] },
      // Inputs whose approved value the server kept: each gets a Revert button.
      revert: !approved && stale && readiness[key].stale.revertible?.length ? { stage: key, fields: readiness[key].stale.revertible } : null,
    };
  };
  switch (stageId) {
    case 'setup': {
      // An autonomous run that is still going writes the song itself.
      const autoSong = !!project.autonomousRun && !['completed', 'canceled', 'failed'].includes(project.autonomousRun.status);
      const hasAudio = projectHasAudio(project);
      const lyrics = lyricSetupState(project, readiness);
      return [
        { id: 'track', label: 'Track attached', done: hasAudio, detail: !hasAudio && autoSong ? 'The autonomous run is making the song.' : null,
          action: hasAudio || autoSong ? null : { label: 'Attach a track', anchor: 'mv-track' } },
        { id: 'analysis', label: 'Song analyzed', done: !!project.audioAnalysis,
          action: project.audioAnalysis ? null : { label: 'Analyze', anchor: 'mv-analyze' } },
        { id: 'lyrics', label: lyrics.instrumental ? 'Instrumental, no lyrics needed' : 'Lyrics imported', done: lyrics.imported || lyrics.ok,
          detail: 'Import the lyrics, or mark the song instrumental under Time and verify.',
          action: autoSong ? null : { label: 'Import lyrics', anchor: 'mv-lyrics-import' } },
        { id: 'timing', label: lyrics.instrumental ? 'Instrumental confirmed' : 'Lyric timing verified', done: lyrics.verified || lyrics.ok,
          detail: lyrics.alignment === 'stale' ? 'Word timings or the master changed since you verified them; verify again.'
            : lyrics.instrumental ? 'Say why the song has no lyrics under Time and verify.'
              : 'Align the words, listen back, then mark the timing verified under Time and verify.',
          action: autoSong ? null : { label: 'Verify timing', anchor: 'mv-lyric-timing' } },
      ];
    }
    case 'cast-sets': {
      const missing = ART_DIRECTION_FIELDS.filter(([key]) => !isNonBlankStr(draft[key])).map(([, label]) => label);
      const guide = (project.devArtifacts || []).find((a) => a.id === draft.guideArtifactId && !a.deleted) || null;
      return [
        { id: 'direction', label: 'Art direction written', done: missing.length === 0, detail: missing.length ? `Still missing: ${missing.join(', ')}.` : null,
          action: missing.length ? { label: 'Write art direction', anchor: APPROVAL_ANCHORS.art } : null },
        { id: 'guide', label: guide ? `Visual guide chosen: ${guide.title || guide.filename || 'sheet'}` : 'Visual guide chosen', done: !!guide,
          detail: guide ? null : 'Pick a Cast & Sets sheet as the visual guide in the art direction editor below.',
          action: guide ? null : { label: 'Choose a guide', anchor: APPROVAL_ANCHORS.art } },
        approval('art', 'Art direction', 'Ready for your review. Approving a sheet file does not approve the art direction; approve it below.'),
      ];
    }
    case 'board': {
      const planned = scenes.length > 0 || (draft.storyboard || []).length > 0;
      return [
        { id: 'shots', label: 'Shots planned', done: planned, detail: planned ? null : 'Plan the shots from the header, or add scenes by hand.',
          action: planned ? null : { label: 'Open the treatment', anchor: 'mv-board-treatment' } },
        ...storyboardProblemItems(readiness),
        approval('storyboard', 'Timed storyboard', 'Ready for your review below.'),
      ];
    }
    case 'produce': {
      // Make: footage (unless the render style draws its own picture), the
      // composition over it, then the proof that closes both (see deriveStages).
      const items = [];
      if (!FOOTAGE_OPTIONAL_MODES.has(mode)) {
        const layered = isLayeredComposition(project);
        const ready = scenes.filter((scene) => sceneRenderReady(scene, { layered })).length;
        const footageDone = scenes.length > 0 && ready === scenes.length;
        items.push({ id: 'footage', label: `Footage for every shot (${formatCount(ready)} of ${formatCount(scenes.length)})`, done: footageDone,
          action: footageDone ? null : { label: 'Make the footage', anchor: 'mv-generation' } });
      }
      const proof = approval('proof', 'Animated proof', 'Render the proof over this composition, watch it with sound, then approve it below.');
      const composition = project.composition || {};
      let work = null;
      if (mode === 'composed') work = { id: 'composition', label: 'Timed typography added', done: (composition.textCues || []).length > 0, action: { label: 'Add typography', anchor: 'mv-typo-font' } };
      else if (mode === 'document') work = { id: 'composition', label: 'Composition document attached', done: !!composition.document, action: { label: 'Attach a document', anchor: 'mv-doc-folder' } };
      else if (mode === 'eidoverse') {
        const saved = !!composition.eidoverseScene?.inlineScript;
        work = { id: 'composition', label: 'Save the Eidoverse scene', done: saved, action: saved ? null : { label: 'Save the scene', anchor: 'mv-eidoverse-scene' } };
      } else if (mode === 'code') {
        const done = codeComposed(project);
        work = { id: 'composition', label: composition.codeVideo?.generatedAt ? 'Code video generated' : 'Code video sections ready', done,
          detail: done ? null : 'Generate the code video from the Code Video panel.',
          action: done ? null : { label: 'Open Code Video', anchor: 'mv-code-section' } };
      }
      return [...items, ...(work ? [work] : []), proof];
    }
    case 'review':
      return [{
        id: 'final', label: 'Final video rendered', done: !!project.renderHistoryId && !isFinalRenderStale(project),
        detail: isFinalRenderStale(project) ? `${STALE_RENDER_MESSAGE}.` : null,
        action: project.renderHistoryId && !isFinalRenderStale(project) ? null : { label: project.renderHistoryId ? 'Re-render' : 'Render', anchor: 'mv-final-video' },
      }];
    case 'publish': {
      const kit = project.publishKit || {};
      const kitCurrent = !!kit.builtAt && (!kit.master?.renderHistoryId || kit.master.renderHistoryId === project.renderHistoryId);
      const progress = publishPlatformProgress(project, publish);
      const items = [
        { id: 'kit', label: 'Kit built from the current render', done: kitCurrent,
          detail: kit.builtAt && !kitCurrent ? 'The final render changed since the kit was built; rebuild it.' : null,
          action: kitCurrent ? null : { label: 'Build the kit', anchor: PUBLISH_ANCHOR } },
        { id: 'copy', label: 'Copy drafted', done: !!(kit.copyDraftedAt || kit.copy), action: kit.copyDraftedAt || kit.copy ? null : { label: 'Draft the copy', anchor: PUBLISH_ANCHOR } },
      ];
      if (!progress.rows.length) return [...items, { id: 'posted', label: 'Posted to a platform', done: progress.done, action: progress.done ? null : { label: 'Open publishing', anchor: PUBLISH_ANCHOR } }];
      items.push({ id: 'posted', label: `Posted to every enabled platform (${formatCount(progress.posted)} of ${formatCount(progress.total)})`, done: progress.done, action: progress.done ? null : { label: 'Open publishing', anchor: PUBLISH_ANCHOR } });
      const STATE_LABELS = { posted: 'posted', draft: 'draft filled', none: 'not started' };
      for (const row of progress.rows) items.push({ id: `post-${row.target}`, label: `${row.label}: ${STATE_LABELS[row.state]}`, done: row.state === 'posted', action: row.state === 'posted' ? null : { label: 'Open publishing', anchor: PUBLISH_ANCHOR } });
      return items;
    }
    default:
      return [];
  }
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
  const review = isFinalRenderStale(project) ? 'Out of date' : project.renderHistoryId ? 'Rendered' : '';
  const posts = publishPlatformProgress(project, publish);
  const publishNote = posts.total ? `${formatCount(posts.posted)} of ${formatCount(posts.total)} posted` : posts.posted ? 'Posted' : '';
  return { setup: song, 'cast-sets': look, board, produce: make, review, publish: publishNote };
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
