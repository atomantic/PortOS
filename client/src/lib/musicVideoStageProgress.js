/** Defines Music Video stages and derives project progress, header status, and the next action. */
import {
  AUTONOMOUS_CHECKPOINT_LABELS, AUTONOMOUS_LYRICS_STEP_LABELS, AUTONOMOUS_SONG_STEP_LABELS,
} from './musicVideoAutonomous.js';
import { formatCount } from '../utils/formatters.js';
import { isNonBlankStr } from './textUtils';
import { modeLabel } from './imageGenModes.js';
import { latestMusicVideoReviewDraft } from '../../../server/lib/musicVideo/musicVideoReviewDraft.js';
import { supersededStillsCheckpoint } from '../../../server/lib/musicVideo/musicVideoAutonomous.js';
import { finishedOutside, finishedOutsideCovers } from '../../../server/lib/musicVideo/musicVideoFinishedOutside.js';
import { shotSheetDoneProgress } from '../../../server/lib/musicVideo/musicVideoShotSheet.js';
import { previzCoversShots } from '../../../server/lib/musicVideo/musicVideoPreviz.js';
import {
  RESUMABLE_RUN_STATUSES, FOOTAGE_OPTIONAL_MODES, currentRun, footageReady, codeComposed, blenderShotsDone, selectCurrentStage, shotsFacts,
} from '../../../server/lib/musicVideo/musicVideoStageSelection.js';
import { RUN_STATUS_LABELS } from './musicVideoRunStatus.js';

/**
 * The steps of a music video, in the order the director decides them: the
 * story comes before the song, and is planned shot by shot before the Look
 * is cast. The
 * ids are the route's `:stage` values and stay stable across the relabel
 * (#10297 follow-up): Song is `setup`, Look is `cast-sets`, Storyboard (once
 * Plan) is `board`, Shots (once Make) is `produce` — each shot's still,
 * clip, then the composition over them — and Final render is
 * `review`. `doneWhen` is the one line a step shows under its title.
 */
export const MUSIC_VIDEO_STAGES = [
  { id: 'story', label: 'Story', title: 'Story', optional: true, doneWhen: 'Done when the story direction is ready; this step is optional.' },
  { id: 'setup', label: 'Song', title: 'Song', doneWhen: 'Done when the track is analyzed and every lyric word is timed to the vocal.' },
  { id: 'board', label: 'Storyboard', title: 'Storyboard', doneWhen: 'Done when timed shots cover the whole song, each with its action, staging, camera and lyric.' },
  { id: 'cast-sets', label: 'Look', title: 'Look', doneWhen: 'Done when the art direction is written, a visual guide is chosen, and you approve it.' },
  { id: 'previz', label: 'Previz', title: 'Previz', optional: true, doneWhen: 'Done when every shot has a greybox previz cut; this step is optional.' },
  { id: 'produce', label: 'Shots', title: 'Shots', doneWhen: 'Done when the shots and composition are ready.' },
  { id: 'review', label: 'Final render', title: 'Final render', doneWhen: 'Done when the full video is rendered from the approved plan and is up to date.' },
  { id: 'publish', label: 'Publish', title: 'Publish', doneWhen: 'Done when every platform you turned on has a post.' },
];

/**
 * Pages beside the steps: listed under them, unnumbered, and never a step the
 * project is "at". The editor is the shots on a timeline under the player;
 * Assets is every still and clip made for the video.
 */
export const MUSIC_VIDEO_PAGES = [
  // The editor fills the screen like an editing application, so its title is for screen readers only.
  { id: 'editor', label: 'Editor', title: 'Editor', quietTitle: true },
  { id: 'assets', label: 'Assets', title: 'Assets' },
  { id: 'making-of', label: 'Making of', title: 'Making of' },
  { id: 'cleanup', label: 'Cleanup', title: 'Cleanup' },
];

// Old links name the Compose tab, which is now part of Shots; the new names work as links too.
const LEGACY_STAGE_IDS = { compose: 'produce', plan: 'board', storyboard: 'board', shots: 'produce' };


export const isStageId = (value) => MUSIC_VIDEO_STAGES.some((stage) => stage.id === value);

// A stopped run that needs the director's attention rather than a click on Resume.
const RUN_BLOCKED_STATUSES = new Set(['limit-reached', 'blocked', 'needs-replan', 'needs-human', 'failed']);
const CAST_WORKING = new Set(['directing', 'imaging', 'assembling']);

/** The run worth showing: the live one, else the most recent. */
const currentProductionRun = currentRun;
export { RESUMABLE_RUN_STATUSES, currentProductionRun };

/**
 * Current review guidance for a stopped approval-gated run; retain other failures.
 * Runs wait on art and storyboard only: the animated proof is optional.
 */
export function productionReviewStopGuidance(run, readiness, through = 'storyboard') {
  const reason = run?.stopReason || run?.error;
  if (!readiness || !reason || !['blocked', 'needs-human', 'stopped', 'failed'].includes(run.status)) return null;
  if (run.errorCode !== 'MUSIC_VIDEO_APPROVAL_REQUIRED' && run.stopCode !== 'MUSIC_VIDEO_APPROVAL_REQUIRED') return null;
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
export function autonomousRunPhase(auto) {
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

/** The Cast & Sets sheet's state: `absent`, `building`, `stopped`, `review` (check-in open) or `settled`. */
export function castSetsPhase(cast) {
  if (!cast) return 'absent';
  if (cast.status === 'review') return 'review';
  if (cast.interrupted || cast.status === 'failed') return 'stopped';
  return CAST_WORKING.has(cast.status) ? 'building' : 'settled';
}

export { footageReady };

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
  return `Autonomous run ${auto.interrupted ? 'interrupted' : (RUN_STATUS_LABELS[auto.status] || auto.status).toLowerCase()}`;
};

/**
 * What the header's Autopilot button says: the autonomous run's current step or
 * state, else a live or parked production run, else just "Autopilot". Tones are
 * `ok`, `warn` or `muted`; `short` is the phone label. A caller that already
 * derived stage progress for this project and readiness can pass it in.
 */
export function autopilotStatus(project, readiness = project?.productionReadiness, { progress } = {}) {
  const auto = supersededStillsCheckpoint(project, readiness) ? null : project?.autonomousRun;
  const { phase, step } = autonomousRunPhase(auto);
  if (phase !== 'inactive') {
    const running = phase === 'running';
    return { label: autonomousChipLabel(auto, { phase, step }), short: running ? 'Autopilot running' : 'Autopilot needs you', tone: running ? 'muted' : 'warn' };
  }
  const run = currentProductionRun(project);
  // A parked run whose shots are all done since needs nothing from the director.
  if (run && RESUMABLE_RUN_STATUSES.has(run.status) && (progress ?? deriveStages(project, readiness)).liveRun) {
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
  const asksForYou = ['review-production', 'approve-cast-sets', 'review-cast-feedback', 'review-autonomous'].includes(nextAction?.id);
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

export { FOOTAGE_OPTIONAL_MODES, codeComposed, blenderShotsDone };

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
 * is done once the storyboard is approved, the footage is in and the
 * composition is ready, and, once the shot sheet is in use, every shot is
 * marked Done on it. Its animated proof is an optional check: neither Shots
 * nor the final render waits on a proof approval.
 */
export function deriveStages(project, readiness = project?.productionReadiness, publish = {}) {
  const cast = project?.castAndSets || null;
  const run = currentProductionRun(project);
  const planned = !!readiness?.storyboard.approved;
  const shotsPlanned = (project?.scenes || []).length > 0 && !!readiness && !problemItemsOf(readiness.storyboard).some((p) => p.code !== ART_APPROVAL_CODE);
  const castStopped = castSetsPhase(cast) === 'stopped';
  const castDone = !!readiness?.art.approved;
  const { produceDone, liveRun } = shotsFacts(project, { planned, run });
  const done = {
    setup: projectHasAudio(project) && !!project?.audioAnalysis && lyricSetupState(project, readiness).ok,
    story: !!(project?.concept?.prompt?.trim() || project?.storySummary?.trim() || project?.treatment?.brief?.premise?.trim()),
    'cast-sets': castDone,
    // Reopened for rework, the storyboard waits for Approve storyboard whatever else is done.
    board: (planned || shotsPlanned) && !project?.storyboardReopenedAt,
    // Optional: every timed shot has a cut in the greybox previz.
    previz: previzCoversShots(project),
    // Once the shot sheet is in use, Shots also waits on every shot being marked Done there.
    produce: produceDone,
    // A render made before later scene edits no longer counts as the final video.
    review: !!project?.renderHistoryId && !isFinalRenderStale(project),
    // #9281/#9282: published once every enabled platform has a recorded post.
    publish: publishPlatformProgress(project, publish).done,
  };
  // Finished outside PortOS: the steps it made elsewhere count as done, with no approval to go stale.
  const external = !!finishedOutside(project);
  if (external) for (const id of Object.keys(done)) if (finishedOutsideCovers(project, id)) done[id] = true;
  if (external) { done.story = true; done.previz = true; }
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
  const current = selectCurrentStage(project, done, { liveRun });
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
    label: art ? 'Review art direction' : board ? 'Review storyboard' : 'Review pilot proof',
    shortLabel: art ? 'Review art' : board ? 'Review storyboard' : 'Review proof' };
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
  if (!project.publishKit?.builtAt) return { id: 'build-publish-kit', kind: 'run', stage: 'publish', label: 'Build the publishing kit', shortLabel: 'Build kit' };
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
 * gaps (timing, staging, lyric anchors) are finished on Plan before the board
 * is approved.
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
  const planUnfinished = board && scenes.length > 0 && !documentShots && problemItemsOf(readiness?.storyboard).some(planProblem);
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
  if (project.castAndSets?.source === 'catalog' && !project.castAndSets.catalogCheckin?.approved) return { id: 'review-catalog-cast-sets', kind: 'goto', stage: 'cast-sets', anchor: CAST_CHECKIN_ANCHOR, label: 'Review catalog cast & sets', shortLabel: 'Review' };
  if (castPhase === 'review' && project.castAndSets?.feedbackRenderPlan) return { id: 'review-cast-feedback', kind: 'goto', stage: 'cast-sets', anchor: 'mv-cast-checkin', label: 'Review feedback plan', shortLabel: 'Review' };
  if (castPhase === 'review') return { id: 'approve-cast-sets', kind: 'run', label: 'Approve cast & sets', shortLabel: 'Approve' };
  if (castPhase === 'stopped' && (project.castAndSets?.queuedImagesToCheck ?? Object.values(project.castAndSets?.images || {}).filter((image) => image.status === 'queued' && image.jobId).length)) return { id: 'review-cast-feedback', kind: 'goto', stage: 'cast-sets', anchor: 'mv-cast-checkin', label: 'Review queued images', shortLabel: 'Review' };
  if (castPhase === 'stopped') return { id: 'resume-cast-sets', kind: 'run', label: 'Resume cast & sets', shortLabel: 'Resume' };
  if (castPhase === 'building') return { id: 'busy', kind: 'run', label: 'Building cast & sets…', shortLabel: 'Building…', disabled: true };
  if (castPhase === 'absent' && !project.automation) return { id: 'start-cast-sets', kind: 'run', label: 'Link cast & sets', shortLabel: 'Build', ...analyzeFirst(project) };
  return kickoffAction(kickoffBlockedReason);
}

// An autopilot project with nothing planned yet is the run's to start (or its Cast & Sets check-in to settle).
const boardNextAction = (args) => (args.project.automation && !(args.project.scenes || []).length && args.castPhase !== 'settled'
  ? castSetsNextAction(args)
  : { id: 'plan', kind: 'run', label: 'Plan the shots', shortLabel: 'Plan', ...analyzeFirst(args.project) });

// The composition step's name by render mode; concat and the other footage-only modes add typography.
const COMPOSE_LABELS = {
  document: ['Attach a composition', 'Attach'], eidoverse: ['Save the Eidoverse scene', 'Save'], code: ['Generate the code video', 'Generate'],
  blender: ['Render the Blender shots', 'Render'],
};

function produceNextAction({ project, run }) {
  if (run?.status === 'needs-human') return { id: 'goto-review', kind: 'goto', stage: 'review', label: 'Review the draft', shortLabel: 'Review' };
  if (!footageReady(project)) return { id: 'goto-produce', kind: 'goto', stage: 'produce', anchor: 'mv-generation', label: 'Make the footage', shortLabel: 'Make' };
  if (shotSheetDoneProgress(project)?.all === false) {
    return { id: 'goto-shot-sheet', kind: 'goto', stage: 'produce', anchor: SHOT_SHEET_ANCHOR, label: 'Mark shots done', shortLabel: 'Shots' };
  }
  const [label, shortLabel] = COMPOSE_LABELS[project.composition?.mode] || ['Add typography', 'Type'];
  return { id: 'goto-compose', kind: 'goto', stage: 'produce', anchor: 'mv-composition', label, shortLabel };
}

// Final render: watch a current one, else render (again, once scene edits made the last one stale).
function finalRenderAction({ project, readiness, renderBlockedByOther }) {
  const stale = isFinalRenderStale(project);
  if (project.renderHistoryId && !stale) return { id: 'goto-final', kind: 'goto', stage: 'review', anchor: 'mv-final-video', label: 'Watch final video', shortLabel: 'Watch' };
  return {
    id: 'render-final', kind: 'run', label: stale ? 'Re-render final video' : 'Render final video', shortLabel: stale ? 'Re-render' : 'Render',
    ...(renderBlockedByOther ? { disabled: true, reason: 'Wait for the other project render to finish' }
      : readiness?.renderable === false ? { disabled: true, reason: readiness.storyboard?.technicalProblems?.[0] || 'Finish the storyboard first' }
        : { disabled: false }),
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
 * Reuse `progress` only when derived with the same readiness and publish state.
 */
export function deriveNextAction(project, {
  draftActive = false, proofActive = false, renderActive = false, renderProgress = 0, renderPending = false, renderBlockedByOther = false,
  kickoffRunning = false, kickoffStep = '', kickoffBlockedReason = null,
  planning = false, analyzing = false, readiness = project?.productionReadiness, publish = {}, progress,
} = {}) {
  if (!project) return null;
  const { current, liveRun } = progress ?? deriveStages(project, readiness, publish);
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
export const ART_DIRECTION_FIELDS = [['cast', 'cast'], ['environments', 'sets'], ['visualLanguage', 'visual language'], ['motionLanguage', 'motion']];
/** Where the Look step's art-direction fields and its visual-guide files are on the page. */
export const ART_DIRECTION_ANCHOR = 'mv-art-direction-editor';
export const LOOK_GUIDES_ANCHOR = 'mv-look-guides';
export const CAST_CHECKIN_ANCHOR = 'mv-cast-checkin';
export const SHOT_SHEET_ANCHOR = 'mv-shot-sheet';
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

export const PUBLISH_ANCHOR = 'mv-publish-kit';
/** The anchor of one platform's row in the posting panel. */
export const publishRowAnchor = (target) => `mv-post-${target}`;

/** The server's `{ code, message, sceneId? }` problems for one readiness section (art, storyboard or proof). */
export const problemItemsOf = (section) => section?.problemItems || [];

// The server names each open change request as a readiness problem; the
// checklist lists those requests on their own Feedback row instead.
export const notFeedback = (problem) => problem.code !== 'feedback';
// Plan comes before Look, so the storyboard gate's "approve the art first" is Look's to settle, not Plan's.
export const ART_APPROVAL_CODE = 'art-unapproved';
export const planProblem = (problem) => notFeedback(problem) && problem.code !== ART_APPROVAL_CODE;

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
