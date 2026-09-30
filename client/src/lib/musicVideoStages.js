/**
 * Music Video page stages: the tab set, which stage a project is in, the one
 * "next action" the sticky header offers for it, and the project's generation
 * spend. Pure functions over the project record so the header, the progress
 * strip and the tests all read the same answer.
 */
import { isLayeredComposition, sceneRenderReady } from './musicVideoLayers.js';

export const MUSIC_VIDEO_STAGES = [
  { id: 'setup', label: 'Setup', title: 'Setup' },
  { id: 'cast-sets', label: 'Cast & Sets', title: 'Cast & Sets' },
  { id: 'board', label: 'Board', title: 'Board' },
  { id: 'produce', label: 'Produce', title: 'Produce' },
  { id: 'compose', label: 'Compose', title: 'Compose' },
  { id: 'review', label: 'Review', title: 'Review & Export' },
];

// Stages whose tab keeps the preview player docked beside the content.
export const PREVIEW_STAGES = new Set(['board', 'compose', 'review']);

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

export const projectHasAudio = (project) => !!(project?.trackId || project?.uploadedAudioFilename);

/**
 * What the project has spent on paid generation across its production runs,
 * against the cap that applies now: the live/latest run's, else the autopilot
 * brief's budget. `capUsd` is null when nothing caps it.
 */
export function projectSpend(project) {
  const runs = Array.isArray(project?.productionRuns) ? project.productionRuns : [];
  const spentUsd = runs.reduce((sum, run) => {
    const spent = Number(run?.usage?.spentUsd);
    return sum + (Number.isFinite(spent) ? spent : 0);
  }, 0);
  const run = currentProductionRun(project);
  const runCap = run?.limits?.spendCapUsd;
  const briefCap = project?.automation?.budgetUsd;
  const capUsd = runCap != null ? runCap : (briefCap != null ? briefCap : null);
  return { spentUsd, capUsd };
}

/**
 * What the docked preview plays: the composition document when the project
 * renders as one, otherwise the newest finished draft excerpt, otherwise
 * nothing (the dock stays out of the way).
 */
export function resolvePreviewSource(project) {
  if (project?.composition?.mode === 'document' && project.composition.document) return { kind: 'document' };
  const excerpt = [...(project?.excerpts || [])].reverse().find((e) => e.status === 'complete' && e.filename);
  return excerpt ? { kind: 'excerpt', excerpt } : null;
}

/** Resolve the `:stage` route param; an unknown or missing value is null. */
export const resolveStageParam = (value) => (isStageId(value) ? value : null);

const composeDone = (project, mode) => {
  if (mode === 'composed') return (project.composition?.textCues || []).length > 0;
  if (mode === 'document') return !!project.composition?.document;
  // Footage has nothing to compose; a code-rendered video is composed by its own panel on demand.
  return true;
};

/**
 * Each stage's state derived from the project record — `done`, `blocked`
 * (stopped and needs the director), `active` (the stage the project is in), or
 * `todo` — plus `current`, the first stage that is not done. A live production
 * run owns the project, so it pins `current` to Produce.
 */
export function deriveStages(project) {
  const scenes = project?.scenes || [];
  const mode = project?.composition?.mode || 'concat';
  const cast = project?.castAndSets || null;
  const run = currentProductionRun(project);
  const liveRun = !!run && RESUMABLE_RUN_STATUSES.has(run.status);
  const layered = isLayeredComposition(project);
  // Code and document renders draw the picture themselves; scene footage is optional there.
  const footageOptional = mode === 'code' || mode === 'document';
  const planned = scenes.length > 0;
  const castApplies = !!cast || !!project?.automation;
  const castStopped = !!cast && (cast.interrupted || cast.status === 'failed');
  const castDone = !castApplies || cast?.status === 'approved' || cast?.status === 'skipped' || (!cast && planned);
  const produceDone = planned && (footageOptional || scenes.every((scene) => sceneRenderReady(scene, { layered })));

  const done = {
    setup: projectHasAudio(project) && !!project?.audioAnalysis,
    'cast-sets': castDone,
    board: planned,
    produce: produceDone,
    compose: composeDone(project || {}, mode),
    review: !!project?.renderHistoryId,
  };
  const blocked = {
    'cast-sets': castStopped,
    produce: !!run && RUN_BLOCKED_STATUSES.has(run.status),
  };
  const current = liveRun
    ? 'produce'
    : (MUSIC_VIDEO_STAGES.find((stage) => !done[stage.id])?.id || 'review');
  const stages = MUSIC_VIDEO_STAGES.map((stage) => {
    let state = 'todo';
    if (done[stage.id] && !(stage.id === current && liveRun)) state = 'done';
    else if (stage.id === current) state = blocked[stage.id] ? 'blocked' : 'active';
    return { ...stage, state };
  });
  return { stages, current };
}

/**
 * The single primary action the sticky header offers. `kind: 'run'` calls a
 * handler the page owns (keyed by `id`); `kind: 'goto'` opens a stage (and
 * optionally scrolls to `anchor`). `disabled` carries the reason it can't run
 * yet. A live production run, a render in flight and a running kickoff win
 * over the stage: they own the project until they settle.
 */
export function deriveNextAction(project, {
  renderActive = false, renderProgress = 0, renderPending = false, renderBlockedByOther = false,
  kickoffRunning = false, kickoffStep = '', kickoffBlockedReason = null,
  planning = false, analyzing = false,
} = {}) {
  if (!project) return null;
  const { current } = deriveStages(project);
  const run = currentProductionRun(project);
  const cast = project.castAndSets || null;
  const scenes = project.scenes || [];

  if (run && RESUMABLE_RUN_STATUSES.has(run.status)) {
    if (run.status === 'running' && !run.interrupted) return { id: 'stop-production', kind: 'run', label: 'Stop production', runId: run.id };
    return {
      id: 'resume-production', kind: 'run', runId: run.id, acceptBasis: run.status === 'needs-replan',
      label: run.status === 'needs-replan' ? 'Resume with new setup' : 'Resume production',
    };
  }
  if (renderActive) {
    return {
      id: 'render-progress', kind: 'run', label: renderPending ? 'Preparing…' : `Rendering… ${Math.round(renderProgress)}%`,
      disabled: true,
    };
  }
  if (kickoffRunning || analyzing || planning) {
    return { id: 'busy', kind: 'run', label: kickoffStep || (planning ? 'Planning…' : 'Working…'), disabled: true };
  }

  switch (current) {
    case 'setup':
      if (!projectHasAudio(project)) return { id: 'goto-setup', kind: 'goto', stage: 'setup', anchor: 'mv-track', label: 'Attach a track' };
      if (project.automation && scenes.length === 0) {
        return { id: 'kickoff', kind: 'run', label: 'Run autopilot', disabled: !!kickoffBlockedReason, reason: kickoffBlockedReason || undefined };
      }
      return { id: 'analyze', kind: 'run', label: 'Analyze song' };
    case 'cast-sets':
      if (cast?.status === 'review') return { id: 'approve-cast-sets', kind: 'run', label: 'Approve cast & sets' };
      if (cast && (cast.interrupted || cast.status === 'failed')) return { id: 'resume-cast-sets', kind: 'run', label: 'Resume cast & sets' };
      if (cast && CAST_WORKING.has(cast.status)) return { id: 'busy', kind: 'run', label: 'Building cast & sets…', disabled: true };
      return { id: 'kickoff', kind: 'run', label: 'Run autopilot', disabled: !!kickoffBlockedReason, reason: kickoffBlockedReason || undefined };
    case 'board':
      return { id: 'plan', kind: 'run', label: 'Plan the shots', disabled: !project.audioAnalysis, reason: project.audioAnalysis ? undefined : 'Analyze the track first' };
    case 'produce':
      if (run?.status === 'needs-human') return { id: 'goto-review', kind: 'goto', stage: 'review', label: 'Review the draft' };
      return { id: 'goto-produce', kind: 'goto', stage: 'produce', anchor: 'mv-production-start', label: 'Set up production' };
    case 'compose':
      return {
        id: 'goto-compose', kind: 'goto', stage: 'compose',
        label: (project.composition?.mode === 'document') ? 'Attach a composition' : 'Add typography',
      };
    default:
      if (project.renderHistoryId) return { id: 'goto-final', kind: 'goto', stage: 'review', anchor: 'mv-final-video', label: 'Watch final video' };
      return {
        id: 'render-final', kind: 'run', label: 'Render final video',
        disabled: renderBlockedByOther, reason: renderBlockedByOther ? 'Wait for the other project render to finish' : undefined,
      };
  }
}
