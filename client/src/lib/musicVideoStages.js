/**
 * Music Video page stages: the tab set, which stage a project is in, the one
 * "next action" the sticky header offers for it, and the project's generation
 * spend. Pure functions over the project record so the header, the progress
 * strip and the tests all read the same answer.
 */
import { isLayeredComposition, sceneRenderReady } from './musicVideoLayers.js';
import {
  AUTONOMOUS_CHECKPOINT_LABELS, AUTONOMOUS_LYRICS_STEP_LABELS, AUTONOMOUS_SONG_STEP_LABELS, AUTONOMOUS_STATUS_LABELS,
} from './musicVideoAutonomous.js';
import { formatCount, formatTimecode } from '../utils/formatters.js';
import { isNonBlankStr } from './textUtils';
import { modeLabel } from './imageGenModes.js';

export const MUSIC_VIDEO_STAGES = [
  { id: 'setup', label: 'Setup', title: 'Setup' },
  { id: 'cast-sets', label: 'Cast & Sets', title: 'Cast & Sets' },
  { id: 'board', label: 'Board', title: 'Board' },
  { id: 'produce', label: 'Produce', title: 'Produce' },
  { id: 'compose', label: 'Compose', title: 'Compose' },
  { id: 'review', label: 'Review', title: 'Review & Export' },
  { id: 'publish', label: 'Publish', title: 'Publish' },
];


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
 * Everything the docked preview can play, in the order it picks a default:
 * the final render (its resolved `finalVideoSrc`), the composition document,
 * then each finished draft excerpt, newest first. While editing the
 * composition (`liveFirst`, the Compose stage) the live document leads so an
 * old final render is not what the user sees by default. A final render whose
 * inputs changed is labelled out of date. Each entry has a stable `id`
 * (the `?play=` value) and a `label` for the source picker.
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
  return sources;
}

// A stopped run can be resumed as is; the others need the director first.
const PRODUCTION_RUN_LABELS = {
  running: 'Production running', stopped: 'Production paused', blocked: 'Production blocked',
  'limit-reached': 'Production at its limit', 'needs-replan': 'Production needs a replan',
};

const APPROVAL_LABELS = { art: 'art', storyboard: 'storyboard', proof: 'proof' };

/** One line for the production-approval gate: which of the three approvals the current revision holds. */
export function approvalSummary(readiness) {
  if (!readiness) return null;
  const keys = Object.keys(APPROVAL_LABELS);
  const approved = keys.filter((key) => readiness[key]?.approved).length;
  const missing = keys.filter((key) => !readiness[key]?.approved).map((key) => APPROVAL_LABELS[key]);
  return approved === keys.length ? 'All 3 approved' : `${approved} of 3 approved · needs ${missing.join(', ')}`;
}

/**
 * The project's "where does it stand" line for the sticky header: the stage it
 * is in (and whether that stage is waiting on the director), plus short facts
 * for the autopilot run, the production run, the approvals and what there is to
 * watch. `progress` is `deriveStages(…)`; `nextAction` is `deriveNextAction(…)`.
 * Fact tones are `ok`, `warn` or `muted`.
 */
export function describeProjectStatus(project, { progress, nextAction = null, readiness = project?.productionReadiness } = {}) {
  if (!project || !progress) return null;
  const index = MUSIC_VIDEO_STAGES.findIndex((stage) => stage.id === progress.current);
  const entry = progress.stages.find((stage) => stage.id === progress.current);
  const allDone = progress.stages.every((stage) => stage.state === 'done');
  // A goto into Production review is a human approval, not something the app does by itself.
  const needsYou = entry?.state === 'blocked' || nextAction?.id === 'review-production' || nextAction?.id === 'approve-cast-sets';
  const activeEvidence = ['draft-progress', 'proof-progress'].includes(nextAction?.id);
  const headline = activeEvidence ? 'Review render in progress' : allDone
    ? 'Published'
    : `Stage ${index + 1} of ${MUSIC_VIDEO_STAGES.length}: ${entry?.label || ''}${needsYou ? ' · needs you' : ''}`;
  const facts = [];
  const auto = project.autonomousRun;
  if (auto && nextAction?.id !== 'review-production' && !activeEvidence) {
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
    facts.push({ id: 'autopilot', label, tone });
  }
  const run = currentProductionRun(project);
  if (run && RESUMABLE_RUN_STATUSES.has(run.status)) {
    facts.push({ id: 'production', label: PRODUCTION_RUN_LABELS[run.status] || 'Production paused', tone: run.status === 'running' ? 'muted' : 'warn' });
  }
  const approvals = approvalSummary(readiness);
  const showApprovals = progress.current !== 'setup' || (project.scenes || []).length > 0;
  if (approvals && showApprovals) facts.push({ id: 'approvals', label: `Approvals: ${approvals}`, tone: readiness.readyForProduction ? 'ok' : 'warn' });
  const drafts = (project.excerpts || []).filter((e) => e.status === 'complete' && e.filename).length;
  if (project.renderHistoryId) facts.push({ id: 'render', label: 'Final render ready', tone: 'ok' });
  else if (drafts) facts.push({ id: 'render', label: `${drafts} draft ${drafts === 1 ? 'excerpt' : 'excerpts'}, no final render`, tone: 'muted' });
  else facts.push({ id: 'render', label: 'Nothing rendered yet', tone: 'muted' });
  return { headline, tone: activeEvidence ? 'muted' : allDone ? 'ok' : needsYou ? 'warn' : 'muted', facts };
}

/** Resolve the `:stage` route param; an unknown or missing value is null. */
export const resolveStageParam = (value) => (isStageId(value) ? value : null);

// Footage-optional modes draw their own picture, so scene footage never gates Produce.
const FOOTAGE_OPTIONAL_MODES = new Set(['code', 'document', 'eidoverse']);

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
 * Each stage's state derived from the project record — `done`, `blocked`
 * (stopped and needs the director), `active` (the stage the project is in), or
 * `todo` — plus `current`, the first stage that is not done. A live production
 * run owns the project, so it pins `current` to Produce.
 */
export function deriveStages(project, readiness = project?.productionReadiness) {
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
    setup: projectHasAudio(project) && !!project?.audioAnalysis,
    'cast-sets': castDone,
    board: planned,
    produce: produceDone && !!readiness?.proof.approved,
    compose: !!readiness?.proof.approved && composeDone(project || {}, mode),
    review: !!project?.renderHistoryId,
    // #9281/#9282: a release is published once any platform post is recorded.
    publish: Object.keys(project?.publishKit?.posts || {}).length > 0,
  };
  const blocked = {
    'cast-sets': castStopped,
    produce: !!run && RUN_BLOCKED_STATUSES.has(run.status),
  };
  const current = liveRun
    ? 'produce'
    : (MUSIC_VIDEO_STAGES.find((stage) => !done[stage.id])?.id || 'publish');
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
 * optionally scrolls to `anchor`). `label` is the full control name; `shortLabel`
 * is what a phone shows so the project name keeps room. `disabled` carries the
 * reason it can't run yet. A live production run, a render in flight and a
 * running kickoff win over the stage: they own the project until they settle.
 */
export function deriveNextAction(project, {
  draftActive = false, proofActive = false, renderActive = false, renderProgress = 0, renderPending = false, renderBlockedByOther = false,
  kickoffRunning = false, kickoffStep = '', kickoffBlockedReason = null,
  planning = false, analyzing = false, readiness = project?.productionReadiness,
} = {}) {
  if (!project) return null;
  const { current } = deriveStages(project, readiness);
  const run = currentProductionRun(project);
  const cast = project.castAndSets || null;
  const scenes = project.scenes || [];

  if (proofActive) return { id: 'proof-progress', kind: 'goto', stage: 'review', anchor: 'mv-review-render', label: 'View review render', shortLabel: 'Review' };
  if (draftActive) return { id: 'draft-progress', kind: 'goto', stage: 'review', anchor: 'mv-draft-excerpts', label: 'View draft render', shortLabel: 'Draft' };
  if (projectHasAudio(project) && project.audioAnalysis && !CAST_WORKING.has(cast?.status) && !readiness?.readyForProduction && run?.status !== 'running' && !renderActive && !kickoffRunning) {
    const art = !readiness?.art.approved;
    const board = !readiness?.storyboard.approved;
    return { id: 'review-production', kind: 'goto', stage: art ? 'cast-sets' : board ? 'board' : 'review',
      anchor: art ? 'mv-review-art' : board ? 'mv-review-storyboard' : 'mv-review-proof',
      label: art ? 'Review art direction' : board ? 'Review timed storyboard' : 'Review animated proof',
      shortLabel: art ? 'Art' : board ? 'Board' : 'Proof' };
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
      return { id: 'review-autonomous', kind: 'goto', stage: 'setup', anchor: 'mv-auto-edit', label: `Review ${target}`, shortLabel: 'Review' };
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
      return { id: 'analyze', kind: 'run', label: 'Analyze song', shortLabel: 'Analyze' };
    case 'cast-sets':
      if (cast?.status === 'review') return { id: 'approve-cast-sets', kind: 'run', label: 'Approve cast & sets', shortLabel: 'Approve' };
      if (cast && (cast.interrupted || cast.status === 'failed')) return { id: 'resume-cast-sets', kind: 'run', label: 'Resume cast & sets', shortLabel: 'Resume' };
      if (cast && CAST_WORKING.has(cast.status)) return { id: 'busy', kind: 'run', label: 'Building cast & sets…', shortLabel: 'Building…', disabled: true };
      return { id: 'kickoff', kind: 'run', label: 'Run autopilot', shortLabel: 'Autopilot', disabled: !!kickoffBlockedReason, reason: kickoffBlockedReason || undefined };
    case 'board':
      return { id: 'plan', kind: 'run', label: 'Plan the shots', shortLabel: 'Plan', disabled: !project.audioAnalysis, reason: project.audioAnalysis ? undefined : 'Analyze the track first' };
    case 'produce':
      if (run?.status === 'needs-human') return { id: 'goto-review', kind: 'goto', stage: 'review', label: 'Review the draft', shortLabel: 'Review' };
      return { id: 'goto-produce', kind: 'goto', stage: 'produce', anchor: 'mv-production-start', label: 'Set up production', shortLabel: 'Produce' };
    case 'compose': {
      const label = { document: 'Attach a composition', eidoverse: 'Save the Eidoverse scene', code: 'Generate the code video' }[project.composition?.mode] || 'Add typography';
      const shortLabel = { document: 'Attach', eidoverse: 'Save', code: 'Generate' }[project.composition?.mode] || 'Type';
      return { id: 'goto-compose', kind: 'goto', stage: 'compose', label, shortLabel };
    }
    case 'publish':
      return project.publishKit?.builtAt
        ? { id: 'goto-publish', kind: 'goto', stage: 'publish', label: 'Publish the release', shortLabel: 'Publish' }
        : { id: 'goto-publish', kind: 'goto', stage: 'publish', label: 'Build the publishing kit', shortLabel: 'Kit' };
    default:
      if (project.renderHistoryId) return { id: 'goto-final', kind: 'goto', stage: 'review', anchor: 'mv-final-video', label: 'Watch final video', shortLabel: 'Watch' };
      return {
        id: 'render-final', kind: 'run', label: 'Render final video', shortLabel: 'Render',
        disabled: renderBlockedByOther, reason: renderBlockedByOther ? 'Wait for the other project render to finish' : undefined,
      };
  }
}

// The editable art-direction fields Production approvals needs before art can be approved.
const ART_DIRECTION_FIELDS = [['cast', 'cast'], ['environments', 'sets'], ['visualLanguage', 'visual language'], ['motionLanguage', 'motion']];
const APPROVAL_ANCHORS = { art: 'mv-review-art', storyboard: 'mv-review-storyboard', proof: 'mv-review-proof' };

/**
 * What one stage tab needs before it counts as done, as a short checklist the
 * tab shows above its panels: `[{ id, label, done, detail?, action? }]`. The
 * `done` answers mirror `deriveStages`, so the tab, its status mark and the
 * header's "needs you" agree; `detail` says what is still missing (for an
 * approval, the server's first readiness problem); `action` is a
 * `{ label, anchor }` the tab can scroll to. Approvals are revision-bound and
 * live in Production approvals, never on a development file: approving a
 * Cast & Sets sheet file does not approve the art direction, so the art item
 * says so while it is open.
 */
export function stageChecklist(stageId, project, readiness = project?.productionReadiness) {
  if (!project) return [];
  const draft = project.productionReview?.draft || {};
  const scenes = project.scenes || [];
  const mode = project.composition?.mode || 'concat';
  const approval = (key, label, waitingText) => {
    const approved = !!readiness?.[key]?.approved;
    return {
      id: `approve-${key}`, label: `${label} approved`, done: approved,
      detail: approved || !readiness ? null : (readiness[key]?.problems?.[0] || waitingText),
      action: approved ? null : { label: `Review ${label.toLowerCase()}`, anchor: APPROVAL_ANCHORS[key] },
    };
  };
  switch (stageId) {
    case 'setup': {
      // An autonomous run that is still going writes the song itself.
      const autoSong = !!project.autonomousRun && !['completed', 'canceled', 'failed'].includes(project.autonomousRun.status);
      const hasAudio = projectHasAudio(project);
      return [
        { id: 'track', label: 'Track attached', done: hasAudio, detail: !hasAudio && autoSong ? 'The autonomous run is making the song.' : null,
          action: hasAudio || autoSong ? null : { label: 'Attach a track', anchor: 'mv-track' } },
        { id: 'analysis', label: 'Song analyzed', done: !!project.audioAnalysis, detail: project.audioAnalysis ? null : 'Analyze the song from the header or Song & lyrics.' },
      ];
    }
    case 'cast-sets': {
      const missing = ART_DIRECTION_FIELDS.filter(([key]) => !isNonBlankStr(draft[key])).map(([, label]) => label);
      const guide = (project.devArtifacts || []).find((a) => a.id === draft.guideArtifactId && !a.deleted) || null;
      return [
        { id: 'direction', label: 'Art direction written', done: missing.length === 0, detail: missing.length ? `Still missing: ${missing.join(', ')}.` : null },
        { id: 'guide', label: guide ? `Visual guide chosen: ${guide.title || guide.filename || 'sheet'}` : 'Visual guide chosen', done: !!guide,
          detail: guide ? null : 'Pick a Cast & Sets sheet as the visual guide in Production approvals.' },
        approval('art', 'Art direction', 'Ready for your review. Approving a sheet file does not approve the art direction; approve it in Production approvals.'),
      ];
    }
    case 'board': {
      const planned = scenes.length > 0 || (draft.storyboard || []).length > 0;
      return [
        { id: 'shots', label: 'Shots planned', done: planned, detail: planned ? null : 'Plan the shots from the header, or add scenes by hand.' },
        approval('storyboard', 'Timed storyboard', 'Ready for your review in Production approvals.'),
      ];
    }
    case 'produce': {
      const items = [];
      if (!FOOTAGE_OPTIONAL_MODES.has(mode)) {
        const layered = isLayeredComposition(project);
        const ready = scenes.filter((scene) => sceneRenderReady(scene, { layered })).length;
        items.push({ id: 'footage', label: `Footage for every shot (${formatCount(ready)} of ${formatCount(scenes.length)})`, done: scenes.length > 0 && ready === scenes.length });
      }
      items.push(approval('proof', 'Animated proof', 'Render the proof, watch it with sound, then approve it in Production approvals.'));
      return items;
    }
    case 'compose': {
      // Compose counts as done only behind an approved proof (see deriveStages).
      const proof = { id: 'proof', label: 'Animated proof approved (Produce)', done: !!readiness?.proof?.approved };
      if (mode === 'composed') return [proof, { id: 'composition', label: 'Timed typography added', done: (project.composition?.textCues || []).length > 0 }];
      if (mode === 'document') return [proof, { id: 'composition', label: 'Composition document attached', done: !!project.composition?.document }];
      if (mode === 'eidoverse') {
        const saved = !!project.composition?.eidoverseScene?.inlineScript;
        return [proof, { id: 'composition', label: 'Save the Eidoverse scene', done: saved, action: saved ? null : { label: 'Save the scene', anchor: 'mv-eidoverse-scene' } }];
      }
      if (mode === 'code') {
        const generated = !!project.composition?.codeVideo?.generatedAt;
        return [proof, { id: 'composition', label: generated ? 'Code video generated' : 'Code video sections ready', done: codeComposed(project),
          detail: codeComposed(project) ? null : 'Generate the code video from the Code Video panel.' }];
      }
      return [proof, { id: 'composition', label: 'Nothing to compose for this render style', done: true }];
    }
    case 'review':
      return [{ id: 'final', label: 'Final video rendered', done: !!project.renderHistoryId }];
    case 'publish':
      return [
        { id: 'kit', label: 'Publishing kit built', done: !!project.publishKit?.builtAt },
        { id: 'posted', label: 'Posted to a platform', done: Object.keys(project.publishKit?.posts || {}).length > 0 },
      ];
    default:
      return [];
  }
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
