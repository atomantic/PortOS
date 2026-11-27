/** Revision-bound creative approvals. Technical renders never imply approval. */
import { GUIDE_MIME_TYPES } from '../../lib/musicVideo/musicVideoGuideMimeTypes.js';
import { canonicalSnapshotChecksum as hash } from '../../lib/snapshotChecksum.js';
import { ServerError } from '../../lib/errorHandler.js';
import { musicVideoAllowsMedia } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { normalizeBlenderRecord } from '../../lib/musicVideo/musicVideoBlender.js';

import { isNonBlankStr as text } from '../../lib/textUtils.js';
import { cameraMovementFromText, getCameraMovement, shotCameraLabel } from '../../lib/cameraMovements.js';
import { cameraVarietyReport } from './shotCamera.js';
import { overlayTextReport } from './overlayText.js';
import { hasPlayableLyricWordTimings } from './timedText.js';
import { cuesSungWithin, lyricAnchorOnset } from '../../lib/musicVideo/musicVideoLyricAnchors.js';
import { isLayeredComposition, sceneTakeProblems, sceneVisualLayer } from '../../lib/musicVideo/musicVideoLayers.js';
import { coldOpenScenes, songScenes } from '../../lib/musicVideo/musicVideoColdOpen.js';
import { CHARACTER_REFERENCE_CHANGED, musicVideoSceneCharacterReferenceTakes } from '../../lib/musicVideo/musicVideoCharacterReferenceAge.js';

import {
  alignmentBasisMatches, ALIGNMENT_UNVERIFIED_PROBLEM, artifact, castAndSetsApprovalInputs, changedInputs,
  documentStoryboardBasis, overlayTextBasis, pickReviewFields, productionAlignmentBasis, productionApprovalInputs,
  productionReviewBasis, reviewInputHash, staleApproval, storyboardApprovalCurrent, withRevertible,
} from './productionReviewBasis.js';
import { SHOT_APPROVER_FIELDS, storeProductionApproval } from './productionReviewRecords.js';
import { carryApprovedProductionStages, productionApprovalValues, restoreApprovedInput, unavailableRevert } from './productionReviewRevisions.js';

export {
  alignmentBasisMatches, ALIGNMENT_UNVERIFIED_PROBLEM, castAndSetsApprovalInputs, documentStoryboardBasis,
  overlayTextBasis, productionAlignmentBasis, productionReviewBasis,
} from './productionReviewBasis.js';
export { productionFeedbackContext, recordProductionFeedback, resolveProductionFeedback, slimProjectReview } from './productionReviewRecords.js';
export { carryReviewThroughSceneOrder, carryStoryboardApproval, castAndSetsApprovalValues } from './productionReviewRevisions.js';

// Share the evidence contract between new decisions and persisted approvals:
// a legacy automatic waiver must not become production-ready after an upgrade.
// Playback notes are optional: approving is the director's call, not a form to fill in.
function hasProofEvidence(review) {
  if (!review || review.autoApproved) return false;
  if (review.method === 'machine') {
    const evidence = review.machineEvidence;
    return review.watchedWithAudio === false && text(evidence?.visualReview) && evidence.visualReview.trim().length >= 40
      && text(evidence?.audioReview) && evidence.audioReview.trim().length >= 40 && text(evidence?.limitations);
  }
  return (review.method == null || review.method === 'playback') && review.watchedWithAudio === true;
}

const describeDirection = value => typeof value === 'string' ? value : JSON.stringify(value || {}, null, 2);

// What the art draft fields are seeded from. A seeded field that the user has
// not edited follows the newest approved direction; an edited one is kept.
const ART_SEEDS = {
  cast: d => d.protagonist,
  environments: d => d.sets,
  visualLanguage: d => ({ look: d.look, palette: d.protagonist?.palette, world: d.world }),
  motionLanguage: d => ({ movement: d.protagonist?.movement, camera: d.world?.camera, transitions: d.world?.transitions }),
};
// Equal content in any formatting: JSON compares by value (key order and
// whitespace ignored), plain text by its trimmed string.
const parsedJson = value => {
  if (!/^[[{]/.test(value.trim())) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};
const sameContent = (a, b) => {
  const [x, y] = [parsedJson(a), parsedJson(b)];
  return x !== undefined && y !== undefined ? hash(x) === hash(y) : a.trim() === b.trim();
};

/**
 * Seed the art-direction draft fields (and the visual guide) from a Cast & Sets
 * sheet. A blank field, or one still holding the exact text an earlier approval
 * seeded, follows the newest direction. Text that already says what the
 * direction says is kept as written (rewriting its formatting would stale an
 * art approval for nothing), and any other text the director or an agent
 * entered — and a guide already chosen — is never overwritten. A document-shot
 * draft is left alone. Seeding supplies editable content only; it never records
 * an approval.
 */
export function seedArtDraft(project, stage = project.castAndSets) {
  const prior = project.productionReview?.draft || {};
  if (prior.storyboardSource === 'document' || !stage?.direction) return project;
  const recorded = project.productionReview?.seededDraft || {};
  const draft = { lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [], ...prior,
    guideArtifactId: prior.guideArtifactId || (artifact(project, stage.artifactId) ? stage.artifactId : null) };
  // Kept outside the strict draft schema: the hash of each field as last seeded.
  // A field absent here was entered by hand and is never rewritten.
  const seededDraft = {};
  for (const [key, from] of Object.entries(ART_SEEDS)) {
    const seed = describeDirection(from(stage.direction));
    const current = text(prior[key]) ? prior[key] : null;
    if (current && sameContent(current, seed)) seededDraft[key] = hash(current);
    else if (!current || recorded[key] === hash(current)) {
      draft[key] = seed;
      seededDraft[key] = hash(seed);
    }
  }
  return { ...project, productionReview: { ...project.productionReview, draft, seededDraft } };
}

/** Point Art at `artifactId` unless a live guide is already selected; the director's own choice stands. */
export function selectArtGuideIfNone(project, artifactId) {
  const prior = project.productionReview?.draft || {};
  if (artifact(project, prior.guideArtifactId) || !artifact(project, artifactId)) return project;
  return { ...project, productionReview: { ...project.productionReview,
    draft: { lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [], ...prior, guideArtifactId: artifactId } } };
}

/**
 * The art-direction guides the director wrote (or accepted from a story
 * draft): cast, environments, visual language. A field still holding the text
 * a Cast & Sets approval seeded is the sheet's own echo, so it is left out.
 */
export function directorArtGuides(project) {
  const draft = project?.productionReview?.draft || {};
  const seeded = project?.productionReview?.seededDraft || {};
  return Object.fromEntries(['cast', 'environments', 'visualLanguage']
    .filter((key) => text(draft[key]) && seeded[key] !== hash(draft[key]))
    .map((key) => [key, draft[key].trim()]));
}

/**
 * What one Board shot renders from: its prompts and direction, its span and
 * lyric, its selected frames and performance setup, and its storyboard row.
 * The selected clip is the shot's output, not an input. A lock saved before
 * still locks ignored timing (no `v`) still binds to this whole basis.
 */
function shotApprovalBasis(project, scene) {
  const row = (project.productionReview?.draft?.storyboard || []).find(shot => shot?.sceneId === scene.sceneId);
  const { prompt, framePrompt, visualIntent, camera, direction, startSec, endSec, lyricText, referenceImageId, endImageId,
    shotMode, performanceSpeaker, performanceStyle, visualLayer, loop } = scene;
  return hash({ prompt, framePrompt, visualIntent, camera, direction, startSec, endSec, lyricText, referenceImageId, endImageId,
    shotMode, performanceSpeaker, performanceStyle, visualLayer, loop,
    row: row ? { action: row.action, staging: row.staging, camera: row.camera, transition: row.transition, lyricCueIds: row.lyricCueIds } : null });
}

/**
 * What a still lock (`productionReview.shotApprovals[sceneId]`, `v: 2`) binds
 * to: the shot's render inputs without its timing. Moving a cut, and the lyric
 * that moves with it, keeps the still approved.
 */
function stillLockBasis(project, scene) {
  const row = (project.productionReview?.draft?.storyboard || []).find(shot => shot?.sceneId === scene.sceneId);
  const { prompt, framePrompt, visualIntent, camera, direction, referenceImageId, endImageId,
    shotMode, performanceSpeaker, performanceStyle, visualLayer, loop } = scene;
  return hash({ prompt, framePrompt, visualIntent, camera, direction, referenceImageId, endImageId,
    shotMode, performanceSpeaker, performanceStyle, visualLayer, loop,
    row: row ? { action: row.action, staging: row.staging, camera: row.camera, transition: row.transition } : null });
}

const STILL_LOCK_VERSION = 2;
const stillLock = (project, scene, fields) => ({ ...fields, basis: stillLockBasis(project, scene), v: STILL_LOCK_VERSION });
const stillLockHolds = (project, scene, approval) => approval.v === STILL_LOCK_VERSION
  ? approval.basis === stillLockBasis(project, scene) : approval.basis === shotApprovalBasis(project, scene);

/** Is the whole-board storyboard approval (given before shots locked one by one, or by Approve all) current? */
const boardApprovalCovers = project => storyboardApprovalCurrent(project.productionReview?.approvals?.storyboard, productionReviewBasis(project));

/**
 * Each Board shot's lock: `locked`, `changed` (locked, then edited) or `open`. Null for a document storyboard.
 * A shot with no lock of its own is locked while a current whole-board approval covers it, so a board
 * approved before per-shot locks existed stays approved after one shot is locked or unlocked.
 */
export function shotLocks(project) {
  if (project.productionReview?.draft?.storyboardSource === 'document') return null;
  const approvals = project.productionReview?.shotApprovals || {};
  const covered = (project.scenes || []).some(scene => !approvals[scene.sceneId]) && boardApprovalCovers(project);
  return Object.fromEntries((project.scenes || []).map(scene => {
    const approval = approvals[scene.sceneId];
    if (!approval) return [scene.sceneId, covered ? 'locked' : 'open'];
    // A manual split lends the original still's lock to the new piece. Its
    // replacement has no per-shot approval, even when the board is current.
    if (approval.inheritedStillId !== undefined && approval.inheritedStillId !== (scene.referenceImageId ?? null)) return [scene.sceneId, 'open'];
    return [scene.sceneId, stillLockHolds(project, scene, approval) ? 'locked' : 'changed'];
  }));
}

/**
 * Whether a shot locks in two steps: a generated clip locks its still (ready to
 * render), then the clip. Stills, cards, code shots and clips rendered from code
 * have nothing more to approve after their first lock.
 */
const shotHasVideoStage = (project, scene) => !scene.codeClip
  && sceneVisualLayer(scene, { layered: isLayeredComposition(project) }) === 'footage';

/**
 * Read-only legacy approval compatibility: no route or service sets a clip lock
 * any more, but projects locked before lock removal keep `clipApprovals`, and
 * the render gates still exempt their `locked` clips so those projects render.
 * Each video shot's clip lock (`productionReview.clipApprovals[sceneId]`):
 * `locked` while its still stays locked and the clip it locked is still the
 * selected one, `changed` once either moved, `open` before it is locked. Null
 * for a shot with no video step, and for a document storyboard.
 */
export function clipLocks(project, locks = shotLocks(project)) {
  if (!locks) return null;
  const approvals = project.productionReview?.clipApprovals || {};
  return Object.fromEntries((project.scenes || []).map(scene => {
    if (!shotHasVideoStage(project, scene)) return [scene.sceneId, null];
    const approval = approvals[scene.sceneId];
    return [scene.sceneId, !approval ? 'open'
      : locks[scene.sceneId] === 'locked' && approval.videoHistoryId === scene.videoHistoryId ? 'locked' : 'changed'];
  }));
}

/** Each timed scene's shot number as the board shows it: song order, from 1. */
export function shotNumbers(project) {
  // Cold-open shots play before the song and are numbered on their own (nameShots).
  const order = songScenes(project).filter(scene => Number.isFinite(scene?.startSec)).sort((a, b) => a.startSec - b.startSec);
  return new Map(order.map((scene, i) => [scene.sceneId, i + 1]));
}

/**
 * Names shots for an error message in song order: "Shot 4", "Shots 2, 9", or
 * with notes "Shots 2 (re-timed), 9 (not lip-synced)". `entries` are sceneIds
 * or `{ sceneId, note }`. Untimed scenes have no number, so a list that holds
 * one falls back to a count ("3 shots"). Shots before the song are named in
 * cold-open order: "Cold open shot 1".
 */
export function nameShots(project, entries) {
  const numbers = shotNumbers(project);
  const cold = new Map(coldOpenScenes(project).map((scene, i) => [scene.sceneId, i + 1]));
  const items = entries.map(entry => (typeof entry === 'string' ? { sceneId: entry } : entry));
  const name = (list, number, singular, plural) => {
    if (!list.length) return null;
    const numbered = list.map(({ sceneId, note }) => ({ n: number.get(sceneId), note }));
    if (numbered.some(({ n }) => !n)) return `${numbered.length} ${numbered.length === 1 ? 'shot' : 'shots'}`;
    const text = numbered.sort((a, b) => a.n - b.n).map(({ n, note }) => (note ? `${n} (${note})` : `${n}`)).join(', ');
    return `${numbered.length === 1 ? singular : plural} ${text}`;
  };
  const before = name(items.filter(({ sceneId }) => cold.has(sceneId)), cold, 'Cold open shot', 'Cold open shots');
  const song = name(items.filter(({ sceneId }) => !cold.has(sceneId)), numbers, 'Shot', 'Shots');
  return [before, song].filter(Boolean).join(' and ') || '0 shots';
}

/**
 * Keep the director's still locks through a change that adds shots or reshapes
 * the board (a new shot, a split). Every shot locked before stays locked by its
 * own timing-free lock, even one covered only by a whole-board approval the
 * change stales; `from` maps a new shot to the shot it was cut from, and a new
 * piece of a locked still is locked too. Manual cut pieces borrow that lock
 * only for the still they inherit. Clip locks stay with their original shot.
 */
export function carryShotLocks(before, after, { from = {}, inheritStillOnly = false } = {}) {
  const locks = shotLocks(before);
  if (!locks) return after;
  const held = before.productionReview?.shotApprovals || {};
  const board = before.productionReview?.approvals?.storyboard;
  const lockOf = scene => held[scene.sceneId] || { ...pickReviewFields(board, SHOT_APPROVER_FIELDS), fromBoardApproval: true };
  const shotApprovals = { ...after.productionReview?.shotApprovals };
  let carried = false;
  for (const scene of before.scenes || []) {
    if (locks[scene.sceneId] !== 'locked' || !after.scenes?.some(s => s.sceneId === scene.sceneId)) continue;
    const own = held[scene.sceneId];
    if (own?.v === STILL_LOCK_VERSION) continue;
    shotApprovals[scene.sceneId] = stillLock(before, scene, lockOf(scene));
    carried = true;
  }
  for (const [pieceId, sourceId] of Object.entries(from)) {
    const source = before.scenes?.find(s => s.sceneId === sourceId);
    const piece = after.scenes?.find(s => s.sceneId === pieceId);
    if (!source || !piece || locks[sourceId] !== 'locked') continue;
    const inherited = inheritStillOnly ? { inheritedStillId: source.referenceImageId ?? null } : {};
    shotApprovals[pieceId] = stillLock(after, piece, { ...lockOf(source), ...inherited });
    carried = true;
  }
  return carried ? { ...after, productionReview: { ...after.productionReview, shotApprovals } } : after;
}

const STORY_INPUT_LABELS = { story: null, 'cast guide': 'cast', 'environment guide': 'environments', 'visual language': 'visualLanguage' };

/**
 * The director's own words a Cast & Sets direction reads: the story and the
 * guides they wrote (seeded echoes excluded), hashed per label. Stored on the
 * stage as `directedInputs` each time the direction is written.
 */
export function castAndSetsStoryInputs(project) {
  const guides = directorArtGuides(project);
  return Object.fromEntries(Object.entries(STORY_INPUT_LABELS)
    .map(([label, key]) => [label, reviewInputHash(key ? guides[key] || null : text(project?.storySummary) ? project.storySummary.trim() : null)]));
}

/**
 * `{ changedFields }` when the story or a director-written guide moved since
 * the direction was written; null otherwise. A direction written before the
 * story was recorded never read it, so a sheet in review (or failed) with no
 * `directedInputs` is out of date on every story input that now has text. A
 * legacy approved sheet is left alone: its approval already names what moved.
 */
function castAndSetsStoryStale(project) {
  const stage = project.castAndSets;
  if (!stage?.direction || stage.status === 'skipped') return null;
  const now = castAndSetsStoryInputs(project);
  const empty = reviewInputHash(null);
  const changedFields = stage.directedInputs ? changedInputs(stage.directedInputs, now)
    : stage.status === 'approved' ? [] : Object.keys(now).filter(label => now[label] !== empty);
  return changedFields.length ? { changedFields } : null;
}

/**
 * The Cast & Sets check-in as an approval: `{ approved, stale, storyStale }`. An approved
 * stage stays approved when its inputs move (its references still condition
 * the frames) but reports what changed since. A stage approved before inputs
 * were recorded has no basis to compare and reports no staleness.
 */
function castAndSetsApproval(project) {
  const stage = project.castAndSets;
  if (stage?.source === 'catalog') {
    const checkin = stage.catalogCheckin;
    return { approved: !!checkin?.approved, stale: stage.status === 'approved' && !checkin?.approved
      ? { approvedAt: stage.approvedAt || null, changedFields: ['catalog links or images'] } : null, storyStale: null,
    problems: checkin?.problems || [{ code: 'CATALOG_UNRESOLVED', message: 'Reload the current catalog check-in.' }] };
  }
  const approved = stage?.status === 'approved';
  const storyStale = castAndSetsStoryStale(project);
  if (!approved || !stage.approvedInputs) return { approved, stale: null, storyStale };
  const changedFields = changedInputs(stage.approvedInputs, castAndSetsApprovalInputs(project));
  return { approved, stale: changedFields.length ? withRevertible({ approvedAt: stage.approvedAt || null, changedFields }, stage.approvedValues) : null, storyStale };
}

// A treatment's per-shot entry and exit (scene.direction, treatment.js), as one storyboard transition line.
const sceneTransition = direction => [direction?.transitionIn && `Entry: ${direction.transitionIn}`, direction?.transitionOut && `Exit: ${direction.transitionOut}`]
  .filter(part => text(part)).join('. ');

/**
 * The storyboard row a Board scene with no draft shot of its own stands for:
 * its planned action, staging and camera, its treatment entry and exit as the
 * transition, the Cast & Sets world's camera and transition language where the
 * scene has none (unless the sheet was skipped; a photographic direction has
 * no world), else a plain cut, and the lyric lines it overlaps. Planning shots
 * after the art approval writes scenes without draft rows, so the storyboard
 * reads them this way until a director edits a shot; preparing the review
 * writes the same rows.
 */
function boardShotFromScene(project, scene) {
  const world = (project.castAndSets?.status !== 'skipped' && project.castAndSets?.direction?.world) || {};
  return {
    sceneId: scene.sceneId,
    lyricCueIds: cuesSungWithin(project.lyricCues, scene.startSec, scene.endSec).map(c => c.id),
    action: scene.visualIntent || scene.prompt || '', staging: scene.framePrompt || '',
    camera: shotCameraLabel(scene.camera) || scene.direction?.camera || world.camera || '', transition: sceneTransition(scene.direction) || world.transitions || 'Cut',
  };
}

/** The Board storyboard as reviewed: every draft shot, then a derived row for each scene that has none. */
export function boardStoryboard(project, storyboard = project.productionReview?.draft?.storyboard || []) {
  return [...storyboard, ...(project.scenes || []).filter(scene => !storyboard.some(shot => shot.sceneId === scene.sceneId))
    .map(scene => boardShotFromScene(project, scene))];
}

/** Draft rows still bound to a Board scene that no longer exists: leftovers from a cut, merge or re-plan. */
function staleStoryboardRows(project) {
  const draft = project.productionReview?.draft;
  if (!Array.isArray(draft?.storyboard) || draft.storyboardSource === 'document') return [];
  const ids = new Set((project.scenes || []).map(scene => scene.sceneId));
  return draft.storyboard.filter(shot => shot?.sceneId && !ids.has(shot.sceneId));
}

/** The project without its stale draft rows; unchanged when there are none. Unbound rows stay to be bound. */
export function dropStaleStoryboardRows(project) {
  const stale = staleStoryboardRows(project);
  if (!stale.length) return project;
  const draft = project.productionReview.draft;
  return { ...project, productionReview: { ...project.productionReview,
    draft: { ...draft, storyboard: draft.storyboard.filter(shot => !stale.includes(shot)) } } };
}

/**
 * Re-anchor the storyboard rows of `sceneIds` (every shot when null) to the
 * lyric lines sung over their scenes now, keeping each row's span in step with
 * its scene. A shot with no draft row already reads its anchors from its scene.
 * Returns the project unchanged when nothing moved.
 */
export function anchorShotsToSungLyrics(project, sceneIds = null) {
  const draft = project.productionReview?.draft;
  if (!Array.isArray(draft?.storyboard) || draft.storyboardSource === 'document') return project;
  const scenes = new Map((project.scenes || []).map(scene => [scene.sceneId, scene]));
  const cues = (project.lyricCues || []).filter(c => text(c.text));
  let moved = false;
  const storyboard = draft.storyboard.map(shot => {
    const scene = shot?.sceneId && scenes.get(shot.sceneId);
    if (!scene || (sceneIds && !sceneIds.includes(shot.sceneId))) return shot;
    const lyricCueIds = cuesSungWithin(cues, scene.startSec, scene.endSec).map(c => c.id);
    const span = 'startSec' in shot || 'endSec' in shot ? { startSec: scene.startSec, endSec: scene.endSec } : {};
    const same = lyricCueIds.length === (shot.lyricCueIds || []).length && lyricCueIds.every((id, i) => shot.lyricCueIds[i] === id)
      && Object.entries(span).every(([key, value]) => shot[key] === value);
    if (same) return shot;
    moved = true;
    return { ...shot, ...span, lyricCueIds };
  });
  return moved ? { ...project, productionReview: { ...project.productionReview, draft: { ...draft, storyboard } } } : project;
}

const unresolvedFeedback = (review, stage) => (review.feedback || []).filter(f => f.stage === stage && f.decision === 'request-changes' && !f.resolvedAt);
/**
 * A readiness problem: `message` is the sentence people read (and the legacy `problems` string);
 * `code` is the stable identity clients group and link by, never reworded; `sceneId` names the shot
 * a per-shot problem belongs to.
 */
const problem = (code, message, sceneId) => ({ code, message, ...(sceneId ? { sceneId } : {}) });
const technicalFields = items => {
  const technical = problemFields(items.filter(i => TECHNICAL_PROBLEM_CODES.has(i.code)));
  return { technicalProblems: technical.problems, technicalProblemItems: technical.problemItems };
};
const problemFields = items => {
  const unique = [...new Map(items.map(i => [JSON.stringify([i.code, i.message, i.sceneId ?? null]), i])).values()];
  return { problems: [...new Set(items.map(i => i.message))], problemItems: unique };
};
/**
 * Storyboard problems that make a render impossible or wrong whoever starts it: no analysed song,
 * lyrics or word timings missing, shots that leave the song uncovered, untimed or unbound. Everything
 * else on the storyboard (change requests, the art and lyric-timing approvals, anchor and field
 * review) is approval state, which the director sees as advice and unattended runs still wait on.
 */
const TECHNICAL_PROBLEM_CODES = new Set(['song-unanalyzed', 'lyrics-missing', 'instrumental-has-lyrics', 'word-timings', 'manifest-stale',
  'document-shot-ids', 'shot-unbound', 'stale-rows', 'shot-duplicate-scene', 'no-shots', 'coverage', 'shot-timing', 'anchor-word-untimed']);
const feedbackProblems = (review, stage) => unresolvedFeedback(review, stage).map(f => problem('feedback', `Resolve ${stage} feedback for ${f.target}: ${f.text}`));

/**
 * Advice on the board, shaped like a problem item but never among `problems`: it does not block an approval
 * or a render. One item per shot whose selected frame, end frame or clip was rendered from an older
 * character reference (#16473), read off the presented takes.
 */
function characterReferenceAdvice(project) {
  return (project.scenes || []).flatMap((scene, index) => {
    const flagged = musicVideoSceneCharacterReferenceTakes(scene);
    if (!flagged.length) return [];
    const names = [...new Set(flagged.flatMap(({ take }) => take.characterReferenceState.characters.map(c => c.name)))];
    const what = [...new Set(flagged.map(({ kind }) => (kind === 'video' ? 'clip' : kind === 'endImage' ? 'end frame' : 'frame')))].join(' and ');
    return [problem(CHARACTER_REFERENCE_CHANGED, `${scene.label || `Shot ${index + 1}`}: ${what} rendered from an older character reference (${names.join(', ')}).`, scene.sceneId)];
  });
}

const ART_GUIDE_FIELDS = [['cast', 'Cast guide'], ['environments', 'Environment guide'],
  ['visualLanguage', 'Visual guide and mood board'], ['motionLanguage', 'Motion guide']];

// Art direction: open change requests, every guide written, and a visual sheet the render mode accepts.
function artDirectionProblems(project, review, draft) {
  const problems = feedbackProblems(review, 'art');
  for (const [key, label] of ART_GUIDE_FIELDS) if (!text(draft[key])) problems.push(problem('art-guide-text', `${label} needs editable direction.`));
  const guide = artifact(project, draft.guideArtifactId);
  if (!GUIDE_MIME_TYPES.includes(guide?.mimeType)) problems.push(problem('art-guide-sheet', 'Attach a visual cast/environment sheet from Development artifacts.'));
  if (guide?.mimeType?.startsWith('image/') && !musicVideoAllowsMedia(project, 'image')) problems.push(problem('art-guide-media', 'Code only requires a code-authored visual guide; select a compatible Development artifact.'));
  return problems;
}

// Lyric timing: an instrumental has no sung lines; a song with lyrics needs them imported, aligned
// to the current master, and every line's words bounded inside the song.
function lyricTimingProblems(review, draft, cues, duration, alignmentVerified) {
  if (draft.lyricsMode === 'instrumental') return cues.length ? [problem('instrumental-has-lyrics', 'This song has lyrics. Remove the instrumental exception or correct the song data.')] : [];
  const problems = [];
  if (!cues.length) problems.push(problem('lyrics-missing', 'Import lyrics and align them to the current vocal; missing lyrics are not an instrumental.'));
  if (draft.timingStatus !== 'verified' || !alignmentVerified) problems.push(problem('alignment-unverified', ALIGNMENT_UNVERIFIED_PROBLEM));
  if (cues.some(c => !hasPlayableLyricWordTimings(c, duration))) {
    problems.push(problem('word-timings', 'Every lyric line needs bounded, positive-duration word timings; repair zero-length or missing words.'));
  }
  return problems;
}

// Where the shots come from: a document manifest imported from the current authored source and
// master, or Board rows each bound to its own live scene.
function shotSourceProblems(project, review, draft, scenes, documentShots, staleRows) {
  const problems = [];
  if (documentShots) {
    if (project.composition?.mode !== 'document' || !project.composition.document?.directory
      || review.documentStoryboard?.basis !== documentStoryboardBasis(project)) {
      problems.push(problem('manifest-stale', 'Import a shot manifest from the current authored document and master audio. Reauthor or reimport after source, timing or shot changes.'));
    }
    if (new Set(scenes.map(s => s.id)).size !== scenes.length || scenes.some(s => !text(s.id))) problems.push(problem('document-shot-ids', 'Document shots need unique source IDs.'));
    return problems;
  }
  if (draft.storyboard?.some(shot => !shot.sceneId)) problems.push(problem('shot-unbound', 'Bind every draft shot to a real Board scene.'));
  if (staleRows.length) problems.push(problem('stale-rows', `Remove ${staleRows.length} storyboard row${staleRows.length === 1 ? '' : 's'} left from deleted shots.`));
  if (new Set((draft.storyboard || []).map(s => s.sceneId)).size !== draft.storyboard?.length) problems.push(problem('shot-duplicate-scene', 'Each storyboard shot must bind to its own Board scene.'));
  return problems;
}

const FRAME = 1 / 24;
// A Blender film is cut on its own frame grid and must cover the frame holding the song's last sample
// (blender/manifest.js), so its last shot ends up to one film frame after the song. Mirrored shot times
// are rounded to six decimals.
const pastSongSlack = (project) => (project.composition?.mode === 'blender'
  ? 1 / normalizeBlenderRecord(project.blender).settings.fps + 1e-6 : 0);
// Each place the shots leave the song uncovered or covered twice, on the shot where it happens, so the checklist can name it.
function storyboardCoverage(timedScenes, duration, pastSlack = 0) {
  if (!timedScenes.length) return [];
  const coverage = [];
  const [first, last] = [timedScenes[0], timedScenes.at(-1)];
  if (first.startSec > FRAME) coverage.push({ sceneId: first.sceneId, issue: 'late-start', startSec: 0, endSec: first.startSec });
  timedScenes.forEach((s, i) => {
    const prev = timedScenes[i - 1];
    if (!prev || Math.abs(s.startSec - prev.endSec) <= FRAME) return;
    coverage.push({ sceneId: s.sceneId, issue: s.startSec > prev.endSec ? 'gap' : 'overlap',
      startSec: Math.min(s.startSec, prev.endSec), endSec: Math.max(s.startSec, prev.endSec) });
  });
  if (duration - last.endSec > FRAME || last.endSec - duration > Math.max(FRAME, pastSlack)) coverage.push({ sceneId: last.sceneId, issue: last.endSec > duration ? 'past-end' : 'early-end',
    startSec: Math.min(last.endSec, duration), endSec: Math.max(last.endSec, duration) });
  return coverage;
}

// A Board shot with no camera note is a valid choice (a cutaway rendered from its start frame plays
// whatever motion its clip has); camera variety stays advice. Document shots spell out every field.
const BOARD_SHOT_FIELDS = ['action', 'staging', 'transition'];
const DOCUMENT_SHOT_FIELDS = ['action', 'staging', 'camera', 'transition'];

/**
 * A shot cut on a sung word (#14820) whose start is no longer on that word: the
 * word lost its timing, or it moved (a Board shot follows on its own unless the
 * move was blocked; a document shot's time lives in its manifest).
 */
function wordAnchorProblem(shot, cues, documentShots) {
  if (!shot?.lyricAnchor) return null;
  const name = shot.label || shot.id || 'A shot';
  const onset = lyricAnchorOnset(cues, shot.lyricAnchor);
  if (!onset) return problem('anchor-word-untimed', `${name} is cut on a lyric word that has no timing now. Align the words again or cut it again.`, shot.sceneId);
  if (!(Math.abs(onset.startSec - shot.startSec) > 1 / 48)) return null;
  const fix = documentShots ? 'Update its start in the shot manifest and import it again.' : 'Move its start, or cut it on the words again.';
  return problem('anchor-word-moved', `${name} starts at ${shot.startSec.toFixed(2)}s, but "${onset.text}" is sung at ${onset.startSec.toFixed(2)}s. ${fix}`, shot.sceneId);
}

/**
 * Every shot's open work: the timing or storyboard fields it is missing
 * (`incompleteShots`), and lyric anchors that disagree with the lines sung over it
 * (`lyricAnchors`, with both sides so the checklist can show and fix them), each
 * also named in `problems`. A selected take marked bad is advice (`selectedTakeMarkedBad`),
 * never a problem: the user may keep or pick any take.
 */
function shotProblems(project, draft, scenes, { documentShots, cues, duration }) {
  const problems = [];
  const incompleteShots = [];
  const lyricAnchors = [];
  const songEnd = duration + pastSongSlack(project);
  for (const scene of scenes) {
    const shot = documentShots ? scene : draft.storyboard?.find(s => s.sceneId === scene.sceneId) || boardShotFromScene(project, scene);
    const untimed = !(Number.isFinite(scene.startSec) && scene.endSec > scene.startSec);
    const missing = untimed ? ['timing'] : scene.endSec > songEnd ? ['an end inside the song'] : [];
    const timingMissing = missing.length > 0;
    missing.push(...(documentShots ? DOCUMENT_SHOT_FIELDS : BOARD_SHOT_FIELDS).filter(key => !text(shot?.[key])));
    if (missing.length) {
      problems.push(problem(timingMissing ? 'shot-timing' : 'shot-incomplete', `Complete timing, action, staging, camera and transition for ${scene.label || 'each shot'}.`, scene.sceneId));
      incompleteShots.push({ sceneId: scene.sceneId, missing });
    }
    // A shot anchors every line sung over it, counted from the line's first sung word (lib/musicVideo/musicVideoLyricAnchors.js).
    const sung = cuesSungWithin(cues, scene.startSec, scene.endSec);
    if (sung.some(c => !shot?.lyricCueIds?.includes(c.id))
      || shot?.lyricCueIds?.some(id => !cues.some(c => c.id === id))) {
      problems.push(problem('lyric-anchors', `Review lyric anchors for ${scene.label || 'each shot'}.`, scene.sceneId));
      if (!documentShots) lyricAnchors.push({ sceneId: scene.sceneId, sung: sung.map(c => c.text),
        anchored: (shot?.lyricCueIds || []).map(id => cues.find(c => c.id === id)?.text).filter(Boolean) });
    }
    const wordProblem = wordAnchorProblem(scene, cues, documentShots);
    if (wordProblem) problems.push(wordProblem);
  }
  return { problems, incompleteShots, lyricAnchors };
}

// The animated proof: a current chorus excerpt rendered with the master and watched once the storyboard is approved.
function proofReadiness(project, review, basis, storyboardApproved) {
  const proof = review.proof;
  const excerpt = (project.excerpts || []).find(e => e.id === proof?.excerptId);
  const problems = feedbackProblems(review, 'proof');
  if (!storyboardApproved) problems.push(problem('proof-needs-storyboard', 'Approve the current lyric-timed storyboard before the animated proof.'));
  if (!proof || proof.basis !== basis.proof || excerpt?.status !== 'complete' || !excerpt?.filename) {
    problems.push(problem('proof-needed', 'Render and watch a current animated chorus proof with the master song.'));
  }
  const approved = !problems.length && hasProofEvidence(review.approvals?.proof?.proofReview) && review.approvals?.proof?.basis === hash({ basis: basis.proof, excerptId: excerpt.id, filename: excerpt.filename });
  return { approved, ...problemFields(problems), excerptId: excerpt?.id || null };
}

const alignmentStatus = (draft, alignmentVerified) => draft.lyricsMode === 'instrumental' ? 'instrumental'
  : draft.timingStatus !== 'verified' ? 'provisional' : alignmentVerified ? 'verified' : 'stale';

export function productionReadiness(project) {
  const review = project.productionReview || {};
  const draft = review.draft || {};
  const basis = productionReviewBasis(project);
  const alignmentBasis = productionAlignmentBasis(project);
  const alignmentVerified = alignmentBasisMatches(project, review.alignmentBasis);
  const inputs = productionApprovalInputs(project);
  const artProblems = artDirectionProblems(project, review, draft);
  const artApproved = !artProblems.length && review.approvals?.art?.basis === basis.art;
  const boardProblems = feedbackProblems(review, 'storyboard');
  if (!artApproved) boardProblems.push(problem('art-unapproved', 'Review and approve the current art direction first.'));
  const duration = project.audioAnalysis?.durationSec;
  if (!(duration > 0)) boardProblems.push(problem('song-unanalyzed', 'Analyze the current master song.'));
  const cues = (project.lyricCues || []).filter(c => text(c.text));
  boardProblems.push(...lyricTimingProblems(review, draft, cues, duration, alignmentVerified));
  const documentShots = draft.storyboardSource === 'document';
  // Each row left from a deleted shot, by its span and action, so the checklist can name it and remove them all.
  const staleRows = documentShots ? [] : staleStoryboardRows(project)
    .map(shot => ({ id: shot.id || null, sceneId: shot.sceneId, startSec: shot.startSec ?? null, endSec: shot.endSec ?? null, action: shot.action || '' }));
  // Shots before the song (the cold open) have no song time to cover or anchor lyrics to.
  const scenes = documentShots ? (draft.storyboard || []).map(shot => ({ ...shot, sceneId: shot.id, label: shot.id })) : songScenes(project);
  boardProblems.push(...shotSourceProblems(project, review, draft, scenes, documentShots, staleRows));
  if (!scenes.length) boardProblems.push(problem('no-shots', 'Create a timed shot storyboard.'));
  const timedScenes = scenes.filter(s => Number.isFinite(s.startSec) && s.endSec > s.startSec).sort((a, b) => a.startSec - b.startSec);
  const coverage = storyboardCoverage(timedScenes, duration, pastSongSlack(project));
  if (coverage.length) boardProblems.push(problem('coverage', 'Storyboard shots must cover the master without unintended gaps or overlaps.'));
  const shots = shotProblems(project, draft, scenes, { documentShots, cues, duration });
  boardProblems.push(...shots.problems);
  // Once any shot has been locked, the board is approved exactly when every shot is.
  const locks = shotLocks(project);
  const byShot = !!locks && Object.keys(review.shotApprovals || {}).length > 0;
  const unlocked = locks ? Object.keys(locks).filter(id => locks[id] !== 'locked') : [];
  const clips = clipLocks(project, locks);
  // A current whole-board approval is independent of old per-shot locks. Keep
  // previously completed per-shot reviews valid for projects saved before this change.
  const storyboardApproved = !boardProblems.length && (storyboardApprovalCurrent(review.approvals?.storyboard, basis)
    || (byShot && scenes.length > 0 && !unlocked.length));
  const mediaScenes = project.scenes || [];
  const takeContext = { layered: isLayeredComposition(project), scenes: mediaScenes, assetMarks: project.assetMarks };
  const selectedTakeMarkedBad = mediaScenes.some(scene => sceneTakeProblems(scene, takeContext).bad);
  const camera = storyboardCameraReport(scenes, documentShots ? null : boardStoryboard(project));
  const proof = proofReadiness(project, review, basis, storyboardApproved);
  return { basis, inputs, alignment: { basis: alignmentBasis, status: alignmentStatus(draft, alignmentVerified) }, documentShotImport: { documentDirectory: project.composition?.document?.directory || null, audioBasis: alignmentBasis }, art: { approved: artApproved, ...problemFields(artProblems), stale: artApproved ? null : staleApproval(project, 'art', basis.art, inputs) },
    // The overlay text check is advice on the storyboard, like camera variety; it never blocks approval.
    storyboard: { approved: storyboardApproved, ...problemFields(boardProblems), ...technicalFields(boardProblems), camera, selectedTakeMarkedBad,
      // Advice by code, like problemItems (#16399), that never blocks approval.
      adviceItems: characterReferenceAdvice(project),
      // Board shots as reviewed, derived rows included, so the editor and approval card show what the gate checked.
      shots: documentShots ? null : boardStoryboard(project), lyricAnchors: shots.lyricAnchors, staleRows, coverage, incompleteShots: shots.incompleteShots, text: overlayTextReport(project, overlayTextBasis), stale: storyboardApproved ? null : staleApproval(project, 'storyboard', basis.storyboard, inputs),
      shotLocks: locks, unlocked: byShot ? unlocked : [], clipLocks: clips,
      // Video shots whose clip is not locked yet: the board is finished when every shot is fully locked.
      clipsUnlocked: clips ? Object.keys(clips).filter(id => clips[id] && clips[id] !== 'locked') : [] },
    proof: { ...proof, stale: proof.approved ? null : staleApproval(project, 'proof', basis.proof, inputs) },
    castAndSets: castAndSetsApproval(project),
    selectedTakeMarkedBad,
    // The animated proof is optional review evidence: the approved storyboard is what the final render needs.
    readyForProduction: storyboardApproved,
    // The storyboard has no technical problem: what a render the director starts needs (approvals are advice there).
    renderable: boardProblems.every(i => !TECHNICAL_PROBLEM_CODES.has(i.code)) };
}

/**
 * Non-blocking camera-variety notes for the storyboard (#10589). A Board
 * scene's planned `camera.move` wins; otherwise the draft shot's free-text
 * camera is matched against the catalog (document shots use their own text).
 */
function storyboardCameraReport(scenes, draftShots) {
  const shots = scenes.filter(s => Number.isFinite(s.startSec)).sort((a, b) => a.startSec - b.startSec).map((scene) => {
    const shot = draftShots ? draftShots.find(s => s.sceneId === scene.sceneId) : scene;
    const planned = getCameraMovement(scene.camera?.move)?.value;
    return { label: scene.label || scene.sceneId, move: planned || cameraMovementFromText(typeof shot?.camera === 'string' ? shot.camera : ''),
      sectionKey: scene.sectionIndex ?? scene.sectionLabel ?? null, sectionLabel: scene.sectionLabel || '', startSec: scene.startSec };
  });
  return cameraVarietyReport(shots);
}

/**
 * Write one changed input back to the value an approval was granted on (#10241).
 * Refuses (409) unless the approval is stale, that input's hash moved, and a
 * value was recorded for it; a legacy approval or an oversized/media input has none.
 */
export function revertApprovedInput(project, { stage, field }) {
  const cast = stage === 'castAndSets';
  let record;
  let now;
  if (cast) {
    const approval = project.castAndSets;
    if (approval?.status !== 'approved') throw unavailableRevert('The Cast & Sets check-in is not approved.');
    record = { inputs: approval.approvedInputs, values: approval.approvedValues };
    now = castAndSetsApprovalInputs(project);
  } else {
    const readiness = productionReadiness(project);
    if (readiness[stage].approved) throw unavailableRevert('This approval is current; there is nothing to revert.');
    record = project.productionReview?.approvals?.[stage];
    now = readiness.inputs[stage];
  }
  if (!record?.inputs || changedInputs(record.inputs, now).includes(field) === false) throw unavailableRevert('That input has not changed since the approval.');
  const value = record.values?.[field];
  if (value === undefined) throw unavailableRevert('The approved value of that input was not kept, so it cannot be restored.');
  return restoreApprovedInput(project, field, value, cast);
}

/**
 * Marks a render or generation a director started from a user-facing route. A symbol, so no request
 * body can carry it: only server code that knows the entry point passes it. Production runs, autopilot
 * and every other unattended caller omit it and keep the full approval gate.
 */
export const DIRECTOR_STARTED = Symbol('music-video.director-started');

export function assertProductionApproval(project, stage = 'proof', { startedBy } = {}) {
  const readiness = productionReadiness(project);
  if (startedBy === DIRECTOR_STARTED && stage === 'storyboard') {
    // The owner's own render is not gated on approvals: only the technical problems refuse it.
    const [first] = readiness.storyboard.technicalProblems;
    if (first) throw new ServerError(first, { status: 409, code: 'MUSIC_VIDEO_STORYBOARD_INCOMPLETE', context: { stage, readiness } });
    return;
  }
  if (!readiness[stage].approved) throw new ServerError(
    readiness[stage].problems[0] || `A reviewer must approve the current ${stage === 'art' ? 'art direction' : stage} in Production review.`,
    { status: 409, code: 'MUSIC_VIDEO_APPROVAL_REQUIRED', context: { stage, readiness } });
}

/** Evidence is bound to the exact revision and excerpt. Machine review never
 * claims human playback; rendering alone is not a review. */
export function approveProductionStage(project, { stage, basis, proofReview, approvedBy, reviewer }) {
  const readiness = productionReadiness(project);
  let expected = stage === 'proof'
    ? hash({ basis: readiness.basis.proof, excerptId: project.productionReview?.proof?.excerptId,
      filename: project.excerpts?.find(e => e.id === project.productionReview?.proof?.excerptId)?.filename })
    : readiness.basis[stage];
  if (basis !== readiness.basis[stage]) throw new ServerError('This revision changed while you were reviewing it. Review it again.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
  if (readiness[stage].problems.length) throw new ServerError(readiness[stage].problems.join(' '), { status: 409, code: 'MUSIC_VIDEO_REVIEW_INCOMPLETE' });
  if (stage === 'proof') {
    const excerpt = project.excerpts?.find(e => e.id === project.productionReview?.proof?.excerptId);
    if (!hasProofEvidence(proofReview)) {
      throw new ServerError('Review this proof with audio and record the energy comparison and timecoded choreography notes. Machine reviews also require visual, audio and limitation evidence.', { status: 409, code: 'MUSIC_VIDEO_PROOF_REVIEW_REQUIRED' });
    }
    if (proofReview.excerptId !== excerpt?.id || proofReview.filename !== excerpt?.filename || !excerpt?.filename) {
      throw new ServerError('The rendered proof changed. Play and review the new excerpt before approving.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
    }
  }
  // Approving a Board storyboard writes the derived rows it was judged on (boardStoryboard) into the
  // draft, so code, renders and the making-of read the approved shots. The approval binds to that revision.
  if (stage === 'storyboard' && project.productionReview?.draft?.storyboardSource !== 'document' && (project.scenes || []).length) {
    project = { ...project, productionReview: { ...project.productionReview,
      draft: { ...project.productionReview?.draft, storyboard: boardStoryboard(project) } } };
    expected = productionReviewBasis(project).storyboard;
  }
  const decision = { stage, basis: expected, ...(stage === 'storyboard' ? { shotsBasis: productionReviewBasis(project).storyboardShots } : {}), inputs: productionApprovalInputs(project)[stage], values: productionApprovalValues(project, stage), approvedAt: new Date().toISOString(),
    ...(approvedBy ? { approvedBy } : {}), ...(reviewer ? { reviewer: structuredClone(reviewer) } : {}),
    ...(stage === 'proof' ? { proofReview: structuredClone(proofReview) } : {}) };
  return storeProductionApproval(project, basis, decision);
}

/**
 * Re-bind the stages that were approved before a machine-only change (a legacy
 * footage project switched to compose its shots) onto the changed project, so
 * a change no one reviewed does not stale an approval no one revoked. A stage
 * that was not approved stays as it was.
 */
export function carryProductionApprovals(before, after, reason) {
  return carryApprovedProductionStages(after, productionReadiness(before), reason);
}

/** A live capture keeps its slot; failed, canceled or missing evidence is retryable on explicit Resume. */
export function productionProofNeedsRender(project, basis) {
  const proof = project.productionReview?.proof;
  const excerpt = project.excerpts?.find(e => e.id === proof?.excerptId);
  if (excerpt?.status === 'rendering') return false;
  return !proof || proof.basis !== basis || excerpt?.status !== 'complete' || !excerpt.filename;
}
