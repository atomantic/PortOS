/** Builds Music Video stage checklists, storyboard problem groups, shot rows, and progress notes. */
import { composedDrawsLyrics, isLayeredComposition, sceneRenderReady } from './musicVideoLayers.js';
import { formatCount, formatDurationSec, formatTimecode } from '../utils/formatters.js';
import { isNonBlankStr } from './textUtils';
import {
  ART_APPROVAL_CODE, ART_DIRECTION_ANCHOR, ART_DIRECTION_FIELDS, CAST_CHECKIN_ANCHOR, FOOTAGE_OPTIONAL_MODES,
  LOOK_GUIDES_ANCHOR, PUBLISH_ANCHOR, RESUMABLE_RUN_STATUSES, SHOT_SHEET_ANCHOR, STALE_RENDER_MESSAGE,
  artDirectionGaps, autonomousRunPhase, blenderShotsDone, castSetsPhase, codeComposed, currentProductionRun,
  deriveStages, footageReady, isFinalRenderStale, lyricSetupState, notFeedback, planProblem, problemItemsOf,
  projectHasAudio, publishPlatformProgress, publishRowAnchor, staleApprovalText,
} from './musicVideoStageProgress.js';
import { supersededStillsCheckpoint } from '../../../server/lib/musicVideo/musicVideoAutonomous.js';
import { FINISHED_OUTSIDE_RERENDER_NOTE, finishedOutside, finishedOutsideCovers } from '../../../server/lib/musicVideo/musicVideoFinishedOutside.js';
import { coldOpenScenes, normalizePreMusic, songScenes } from '../../../server/lib/musicVideo/musicVideoColdOpen.js';
import { shotCameraLabel } from '../../../server/lib/cameraMovements.js';
import { shotSheetDoneProgress } from '../../../server/lib/musicVideo/musicVideoShotSheet.js';
import { projectPreviz } from '../../../server/lib/musicVideo/musicVideoPreviz.js';

const AUTONOMOUS_SONG_DETAILS = {
  running: 'The autonomous run is making the song.',
  awaiting: 'The autonomous run is waiting for your approval.',
  paused: 'The autonomous run is paused. Resume it to make the song.',
};

const APPROVAL_ANCHORS = { art: 'mv-review-art', storyboard: 'mv-review-storyboard', proof: 'mv-review-proof' };
const APPROVAL_STAGES = { art: 'cast-sets', storyboard: 'produce', proof: 'produce' };

// The server names every unfinished shot in its own sentence; on a long song
// that is dozens of near-identical lines. The director judges shots by
// watching the preview, so each per-shot problem kind collapses into one count.
// A shot missing its timing ('shot-timing') and one missing only text fields count on one line.
const perShotKind = (code) => (code === 'shot-timing' ? 'shot-incomplete' : code);
const PER_SHOT_PROBLEMS = {
  'shot-incomplete': (n) => `${n} shot${n === 1 ? '' : 's'} missing timing, action, staging, camera or transition.`,
  'lyric-anchors': (n) => `${n} shot${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} lyric anchors reviewed.`,
};

/** Problem items with each per-shot kind folded into one count item, in first-seen order. */
export function summarizeStoryboardProblems(problems = []) {
  const counts = new Map();
  for (const { code } of problems) if (PER_SHOT_PROBLEMS[perShotKind(code)]) counts.set(perShotKind(code), (counts.get(perShotKind(code)) || 0) + 1);
  return problems.flatMap((problem) => {
    const kind = perShotKind(problem.code);
    const line = PER_SHOT_PROBLEMS[kind];
    if (!line) return [problem];
    if (!counts.has(kind)) return [];
    const folded = { code: kind, message: line(counts.get(kind)) };
    counts.delete(kind); // only the first of its kind carries the count line
    return [folded];
  });
}

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
    ? { action: 'Authors a revised composition candidate with these requests. Accept it in Shots, then render a new proof.' }
    : { unavailable: 'This composition was imported from its own source. Revise that source and reimport it, then resolve each request.' };
  if (mode === 'blender') return { unavailable: 'This proof is cut from the Blender shots. Revise the film scripts, render the affected shots again, then render a new proof.' };
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
// server tags each problem with a code; the first group listing it wins and the last takes the rest.
const STORYBOARD_PROBLEM_GROUPS = [
  // A document storyboard needs a manifest from its current build; its message mentions timing, so it is matched first.
  { id: 'manifest', label: 'Document shot manifest', codes: ['manifest-stale'], action: { label: 'Import the shot manifest', anchor: 'mv-review-planning' } },
  { id: 'lyrics', label: 'Lyrics', codes: ['lyrics-missing', 'instrumental-has-lyrics'], action: { label: 'Import lyrics', stage: 'setup', anchor: 'mv-lyrics-import' } },
  // The per-shot count lines ("3 shots missing timing, …") mention timing too; they belong to Shot details.
  { id: 'timing', label: 'Lyric timing', codes: ['alignment-unverified', 'word-timings', 'song-unanalyzed', 'anchor-word-untimed'], action: { label: 'Verify timing', stage: 'setup', anchor: 'mv-lyric-timing' } },
  { id: 'coverage', label: 'Shot coverage', codes: ['coverage', 'no-shots'], action: { label: 'Open the treatment', stage: 'produce', anchor: 'mv-board-treatment' } },
  { id: 'shots', label: 'Shot details', codes: null, action: { label: 'Edit the storyboard', anchor: APPROVAL_ANCHORS.storyboard } },
];

/** One open checklist item per group of storyboard readiness problems, per-shot problems counted rather than listed. */
function storyboardProblemItems(readiness, scenes = []) {
  // Shots whose lyric anchors differ from the singing get a row of their own that names each shot.
  const anchors = lyricAnchorItem(readiness, scenes);
  const stale = staleRowsItem(readiness);
  const problems = summarizeStoryboardProblems(problemItemsOf(readiness?.storyboard).filter(planProblem)
    .filter((p) => (!anchors || p.code !== 'lyric-anchors') && (!stale || p.code !== 'stale-rows')));
  if (readiness?.storyboard?.approved || (!problems.length && !anchors && !stale)) return [];
  return [...STORYBOARD_PROBLEM_GROUPS.flatMap((group) => {
    const mine = problems.filter((p) => group.codes ? group.codes.includes(p.code) : !STORYBOARD_PROBLEM_GROUPS.some((g) => g.codes?.includes(p.code)));
    if (!mine.length) return [];
    return [namedShots({ id: `board-${group.id}`, label: group.label, done: false, details: mine.map((p) => p.message), action: group.action }, readiness, scenes, mine)];
  }), ...(stale ? [stale] : []), ...(anchors ? [anchors] : [])];
}

const spanText = (startSec, endSec) => `${formatTimecode(startSec)}–${formatTimecode(endSec)}`;
const gapSec = ({ startSec, endSec }) => `${(endSec - startSec).toFixed(2)} s`;
const COVERAGE_TEXT = {
  'late-start': (c) => `Nothing covers the start of the song, ${spanText(c.startSec, c.endSec)}`,
  gap: (c) => `Gap of ${gapSec(c)} before this shot, ${spanText(c.startSec, c.endSec)}`,
  overlap: (c) => `Overlaps the shot before by ${gapSec(c)}, ${spanText(c.startSec, c.endSec)}`,
  'past-end': (c) => `Runs ${gapSec(c)} past the end of the song, ${spanText(c.startSec, c.endSec)}`,
  'early-end': (c) => `Ends ${gapSec(c)} before the song does, ${spanText(c.startSec, c.endSec)}`,
};

// A label that is itself a shot number ("Shot 14", "Shot 14 · 2/3"). Its position
// stops matching once an earlier shot is deleted, so showing both reads as two numbers.
const numberedLabel = (scene) => /^(shot|scene)\s+\d/i.test(scene?.label || '');

/** The one name a shot goes by on the Shots list, the board and its card. */
export function sceneShotName(scene, { number = null, coldOpen = null } = {}) {
  const place = coldOpen ? `Cold open ${coldOpen}` : number && !numberedLabel(scene) ? `Shot ${number}` : null;
  return [place, scene.label || scene.sectionLabel].filter(Boolean).join(' · ') || `Scene ${(scene.order ?? 0) + 1}`;
}

/** A checklist row's short button to a shot's card, numbered as that card is. */
function checklistShotLabel(scenes, sceneId) {
  const at = scenes.findIndex((scene) => scene.sceneId === sceneId);
  if (at < 0) return 'Shot';
  return numberedLabel(scenes[at]) ? scenes[at].label : `Shot ${at + 1}`;
}

/**
 * The Shot coverage and Shot details rows name each shot they are about (a
 * button to its card) and say what is wrong with it, in place of the generic
 * sentence or count.
 */
function namedShots(item, readiness, scenes, problems) {
  const detailsWithout = (kind) => problems.filter((p) => perShotKind(p.code) !== kind).map((p) => p.message);
  const label = (sceneId) => checklistShotLabel(scenes, sceneId);
  const byShot = (entries, text) => [...entries.reduce((map, entry) => map.set(entry.sceneId,
    [...(map.get(entry.sceneId) || []), text(entry)]), new Map())].map(([sceneId, lines]) => ({ sceneId, label: label(sceneId), text: lines.join(' · ') }));
  const coverage = readiness?.storyboard?.coverage;
  if (item.id === 'board-coverage' && coverage?.length) {
    return { ...item, details: detailsWithout('coverage'),
      detail: 'Move these cuts so every moment of the song has exactly one shot.',
      shots: byShot(coverage, (c) => (COVERAGE_TEXT[c.issue] || (() => c.issue))(c)) };
  }
  const incomplete = readiness?.storyboard?.incompleteShots;
  if (item.id === 'board-shots' && incomplete?.length) {
    return { ...item, details: detailsWithout('shot-incomplete'),
      shots: byShot(incomplete, (shot) => `Missing ${shot.missing.join(', ')}`) };
  }
  return item;
}

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
  return {
    id: 'board-anchors', label: 'Lyric anchors', done: false,
    detail: 'These shots are anchored to lyrics other than the ones sung over them.',
    shots: flagged.map(({ sceneId, sung, anchored }) => ({
      sceneId, label: checklistShotLabel(scenes, sceneId),
      text: `Sung: ${quoted(sung)} · anchored: ${quoted(anchored)}`,
    })),
    action: { label: 'Anchor to the sung lyrics', run: 'sync-lyric-anchors' },
  };
}

/**
 * Plan's shot list: every shot in song order (untimed ones last, `number` null)
 * with what the timing check reads — its name, its span, the lyric it was
 * planned on, its action and camera, and each problem the storyboard readiness
 * names for it (`flags`, one sentence each). Lyric anchors drop out once the
 * storyboard is approved, as on the checklist.
 *
 * A storyboard row describes a shot only when its action is on no other shot's
 * row: a split copies the parent's row onto every piece and later rewrites of
 * the pieces' prompts leave those copies behind. Projects already hold such
 * copies with nothing marking them, so the shared text is the only signal. The
 * shot then reads from its sheet's action, else its own prompt.
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
  const actionUses = new Map();
  for (const scene of project?.scenes || []) {
    const action = rows.get(scene?.sceneId)?.action?.trim();
    if (action) actionUses.set(action, (actionUses.get(action) || 0) + 1);
  }
  // Untimed shots (a new scene before its timing is set) follow the timed ones, unnumbered, so their problems stay visible.
  // Shots before the song (the cold open) lead, in play order, numbered on their own (`coldOpen`).
  const coldOpen = coldOpenScenes(project);
  const scenes = songScenes(project);
  const timed = scenes.filter((scene) => Number.isFinite(scene?.startSec)).sort((a, b) => a.startSec - b.startSec);
  const untimed = scenes.filter((scene) => scene && !Number.isFinite(scene.startSec));
  return [...coldOpen, ...timed, ...untimed]
    .map((scene, at) => {
      const drafted = rows.get(scene.sceneId);
      const row = actionUses.get(drafted?.action?.trim()) > 1 ? null : drafted;
      const i = at - coldOpen.length;
      const number = i >= 0 && i < timed.length ? i + 1 : null;
      const coldOpenNumber = i < 0 ? at + 1 : null;
      return {
        scene, number, name: sceneShotName(scene, { number, coldOpen: coldOpenNumber }),
        ...(coldOpenNumber ? { coldOpen: coldOpenNumber, durationSec: normalizePreMusic(scene.preMusic).durationSec } : {}),
        lyric: typeof scene.lyricText === 'string' ? scene.lyricText.trim() : '',
        action: row?.action?.trim() || scene.shotSheet?.action?.trim() || scene.prompt?.trim() || scene.visualIntent?.trim() || scene.framePrompt?.trim() || '',
        camera: row?.camera || shotCameraLabel(scene.camera) || scene.direction?.camera || '',
        flags: flags.get(scene.sceneId) || [],
      };
    });
}

// The art-direction row's detail and action for each Cast & Sets phase, while fields are still unwritten.
const CAST_DIRECTION_ROWS = {
  absent: ({ stillMissing, write, analyzed }) => ({ detail: `${stillMissing}Link the cast & sets from the catalog, then write the art direction separately.`,
    action: { label: 'Link cast & sets', run: 'start-cast-sets', disabled: !analyzed, reason: analyzed ? undefined : 'Analyze the track first' }, secondary: write }),
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
  const blocker = problemItemsOf(readiness?.[key]).find(notFeedback)?.message || changeRequestBlocker(openChangeRequests(project, key));
  const keepable = !!stale && !approved && !blocker && key !== 'proof';
  return {
    id: `approve-${key}`, label: `${label} approved`, done: approved, stale: !!stale,
    detail: approved || !readiness ? null : (stale ? (keepable ? stale : `${stale} Re-approve in the editor below.`) : blocker || waitingText),
    ...(keepable
      ? { action: { label: 'Keep approved', run: 'keep-approval', stage: key, hint: 'Approve it again as it is now.' },
        secondary: { label: `Review ${label.toLowerCase()}`, anchor: APPROVAL_ANCHORS[key], stage: APPROVAL_STAGES[key], hint: 'Check the changes first, then approve.' } }
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
  const catalogMode = cast?.source === 'catalog';
  const fromSheet = !catalogMode && cast?.status === 'approved' && !!cast.direction;
  const stillMissing = missing.length && missing.length < ART_DIRECTION_FIELDS.length ? `Still missing: ${missing.join(', ')}. ` : '';
  const write = { label: 'Write it yourself', anchor: ART_DIRECTION_ANCHOR };
  const direction = missing.length === 0 ? { detail: null, action: null }
    : catalogMode ? { detail: `${stillMissing}Catalog links define the cast and sets. Write the art direction separately.`, action: { label: 'Write art direction', anchor: ART_DIRECTION_ANCHOR } }
      : castDirectionRow(castPhase, { missing, stillMissing, write, fromSheet, analyzed: !!project.audioAnalysis });
  const sheetPending = !!cast && !catalogMode && castPhase !== 'settled';
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
    { id: 'guide', label: guide ? `Visual guide chosen: ${guide.title || guide.filename || 'sheet'}${guide.version ? ` v${guide.version}` : ''}` : 'Visual guide chosen', done: !!guide, ...guideRow },
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
  const ready = scenes.filter((scene) => sceneRenderReady(scene, { layered, scenes, assetMarks: project.assetMarks })).length;
  const footageDone = footageReady(project);
  return { id: 'footage', label: `Footage for every shot (${formatCount(ready)} of ${formatCount(scenes.length)})`, done: footageDone,
    action: footageDone ? null : { label: 'Make the footage', anchor: 'mv-generation' } };
}

// Make's composition row by render mode; concat and the other footage-only modes have none.
const COMPOSITION_ITEMS = {
  // Timed lyrics with no subtitle cues are drawn by the render itself, as the player shows them.
  composed: (composition, project) => composition.noTypography === true
    ? { id: 'composition', label: 'No typography (dismissed)', done: true, action: { label: 'Undo', anchor: 'mv-typo-none' } }
    : composedDrawsLyrics(project)
    ? { id: 'composition', label: 'Lyrics drawn over the footage', done: true }
    : { id: 'composition', label: 'Timed typography added', done: (composition.textCues || []).length > 0, action: { label: 'Add typography', anchor: 'mv-typo-font' } },
  document: (composition) => ({ id: 'composition', label: 'Composition document attached', done: !!composition.document, action: { label: 'Attach a document', anchor: 'mv-doc-folder' } }),
  eidoverse: (composition) => {
    const saved = !!composition.eidoverseScene?.inlineScript;
    return { id: 'composition', label: 'Save the Eidoverse scene', done: saved, action: saved ? null : { label: 'Save the scene', anchor: 'mv-eidoverse-scene' } };
  },
  blender: (_composition, project) => {
    const done = blenderShotsDone(project);
    const film = project.blenderShots;
    return { id: 'composition', label: film?.total ? `Final render for every Blender shot (${formatCount(film.finalReady)} of ${formatCount(film.total)})` : 'Final render for every Blender shot', done,
      detail: done ? null : film && !film.total ? 'Sync the shots from the film scripts first.' : 'Render each shot at final quality in Blender film.',
      action: done ? null : { label: 'Open Blender film', anchor: 'mv-blender-film' } };
  },
  code: (composition, project) => {
    const done = codeComposed(project);
    return { id: 'composition', label: composition.codeVideo?.generatedAt ? 'Code video generated' : 'Code video sections ready', done,
      detail: done ? null : 'Generate the code video from the Code Video panel.',
      action: done ? null : { label: 'Open Code Video', anchor: 'mv-code-section' } };
  },
};

// Make: the footage, the storyboard review, and the composition over them.
function produceChecklist({ project, readiness, scenes, mode }) {
  const items = FOOTAGE_OPTIONAL_MODES.has(mode) ? [] : [footageItem(project, scenes)];
  const reviewed = approvalItem(project, readiness, 'storyboard', 'Timed storyboard', 'Ready for your review below.');
  const planOpen = problemItemsOf(readiness?.storyboard).some(planProblem) && !reviewed.stale;
  const lookOpen = !planOpen && !reviewed.stale && problemItemsOf(readiness?.storyboard).some((p) => p.code === ART_APPROVAL_CODE);
  items.push(reviewed.done ? reviewed
    : planOpen ? { ...reviewed, detail: 'Finish the storyboard first.', action: { label: 'Open the storyboard', stage: 'board' } }
      : lookOpen ? { ...reviewed, detail: 'Approve the Look first.', action: { label: 'Open Look', stage: 'cast-sets', anchor: APPROVAL_ANCHORS.art } }
        : reviewed);
  const sheet = shotSheetDoneProgress(project);
  if (sheet) {
    items.push({ id: 'shots-done', label: 'Every shot marked done', done: sheet.all,
      detail: sheet.all ? null : `${formatCount(sheet.done)} of ${formatCount(sheet.total)} done.`,
      action: sheet.all ? null : { label: 'Open the shot sheet', anchor: SHOT_SHEET_ANCHOR } });
  }
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
    detail: isFinalRenderStale(project) ? `${STALE_RENDER_MESSAGE}.${finishedOutside(project) && !(readiness?.renderable ?? readiness?.readyForProduction) ? ` ${FINISHED_OUTSIDE_RERENDER_NOTE}` : ''}` : null,
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
      action: kitCurrent ? null : { label: 'Build the kit', run: 'build-publish-kit', anchor: PUBLISH_ANCHOR, disabled: !project.renderHistoryId, reason: !project.renderHistoryId ? 'Render the final video first' : undefined } },
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

/** True when this stage tab defines a checklist builder. */
export function stageHasChecklist(stageId) {
  return Boolean(STAGE_CHECKLISTS[stageId]);
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
 * nothing to say yet maps to an empty string. The caller can reuse `progress`
 * derived with the same readiness and publish state.
 */
export function stepNotes(project, readiness = project?.productionReadiness, publish = {}, { progress } = {}) {
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
  // The guide's version names the one the director settled on (e.g. "Visual guide v35").
  const look = guide ? (guide.version ? `Visual guide v${guide.version}` : 'Visual guide chosen') : project.castAndSets?.source === 'catalog' ? 'Catalog cast and sets linked' : project.castAndSets ? 'Cast and sets built' : '';
  const board = scenes.length ? `${formatCount(scenes.length)} ${scenes.length === 1 ? 'shot' : 'shots'}` : '';
  const mode = project.composition?.mode || 'concat';
  let make = '';
  if (scenes.length && !FOOTAGE_OPTIONAL_MODES.has(mode)) {
    const layered = isLayeredComposition(project);
    const ready = scenes.filter((scene) => sceneRenderReady(scene, { layered, scenes, assetMarks: project.assetMarks })).length;
    const staleFrames = scenes.filter((scene) => (scene.takes || []).some((take) => (
      (take.kind === 'image' && take.assetId === scene.referenceImageId) || (take.kind === 'endImage' && take.assetId === scene.endImageId)
    ) && take.dependencyState?.status === 'stale')).length;
    make = `${formatCount(ready)} of ${formatCount(scenes.length)} shots have their picture`;
    if (staleFrames) make += ` · ${formatCount(staleFrames)} ${staleFrames === 1 ? 'frame' : 'frames'} out of date`;
    // #16473: the server's advice by code, one item per shot.
    const olderCharacters = (readiness?.storyboard?.adviceItems || []).filter((item) => item.code === 'character-reference-changed').length;
    if (olderCharacters) make += ` · ${formatCount(olderCharacters)} from an older character reference`;
  } else if (mode === 'blender' && project.blenderShots?.total) {
    const film = project.blenderShots;
    make = `${formatCount(film.finalReady)} of ${formatCount(film.total)} finals done`;
  } else if (scenes.length) make = 'Picture drawn by the composition';
  // Once the picture is in, an unfinished Shots step names what is left instead.
  if (scenes.length && readiness && (progress ?? deriveStages(project, readiness, publish)).stages.find((stage) => stage.id === 'produce')?.state !== 'done') {
    const open = stageChecklist('produce', project, readiness, publish).filter((item) => !item.done && !item.optional);
    const sheet = shotSheetDoneProgress(project);
    if (open.length && !open.some((item) => item.id === 'footage')) {
      make = sheet && !sheet.all ? `${formatCount(sheet.done)}/${formatCount(sheet.total)} shots done` : `To do: ${open[0].label}`;
    }
  }
  // Before a final render, the drafts and proofs to watch are what Final render holds.
  const drafts = (project.excerpts || []).filter((e) => e.status === 'complete' && e.filename).length;
  const review = isFinalRenderStale(project) ? 'Out of date' : project.renderHistoryId ? 'Rendered'
    : drafts ? `${formatCount(drafts)} ${drafts === 1 ? 'draft' : 'drafts'} to watch` : '';
  const posts = publishPlatformProgress(project, publish);
  const publishNote = posts.total ? `${formatCount(posts.posted)} of ${formatCount(posts.total)} posted` : posts.posted ? 'Posted' : '';
  const cuts = projectPreviz(project)?.cuts.length || 0;
  const previz = cuts ? `${formatCount(cuts)} cut${cuts === 1 ? '' : 's'}` : '';
  return { setup: song, story: project.concept?.prompt?.trim() ? 'Concept written' : '', 'cast-sets': look, board, previz, produce: make, review, publish: publishNote };
}
