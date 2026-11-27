/** Record, retain, and compact approval and feedback history for reviewed Music Video revisions. */
import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { pickReviewFields, productionReviewBasis } from './productionReviewBasis.js';

export const SHOT_APPROVER_FIELDS = ['approvedAt', 'approvedBy', 'reviewer'];
const BOARD_SHOT_LOCK_FIELDS = [...SHOT_APPROVER_FIELDS, 'fromBoardApproval', 'basis', 'v', 'inheritedStillId'];

// A refreshed snapshot is re-inserted last so insertion order doubles as recency.
const omitKey = (obj, key) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => k !== key));
const MAX_APPROVAL_HISTORY = 50;
const MAX_RECENT_REVISIONS = 5;

/*
 * The per-shot plan a reviewed revision keeps (#16210). A snapshot rides every
 * project write, so it holds what a reviewer judged, never the render history:
 * `takes` (each with its composed prompt and plate evidence) and other render
 * bookkeeping are dropped. Nothing recomputes a basis from a snapshot (approval
 * bases hash the live project), so slimming one never changes what counts as reviewed.
 * - identity and place: sceneId, order, label, sectionIndex — which shot, in which slot
 * - timing and lyrics: startSec, endSec, lyricText, lyricAnchor — the span and words it covers
 * - wording and shot sheet: visualIntent, prompt, framePrompt, camera, shotSheet, shotMode,
 *   performanceSpeaker, coverage, transitionIn, transitionOut — what the shot shows, as reviewed
 * - references: frameReferenceIds, clipReferenceIds, setReference, characterVariant — who and where
 * - selections: referenceImageId, videoHistoryId — the frame and clip on screen when reviewed
 * - proof inputs: performanceEdit, direction, visualLayer, preMusic, photoSequence,
 *   templateEffects — the remaining per-shot fields the proof basis hashes
 *   (`productionReviewBasis`), so a snapshot still shows every shot input a review covered
 */
const REVIEWED_SCENE_FIELDS = ['sceneId', 'order', 'label', 'sectionIndex', 'startSec', 'endSec', 'lyricText', 'lyricAnchor',
  'visualIntent', 'prompt', 'framePrompt', 'camera', 'shotSheet', 'shotMode', 'performanceSpeaker', 'coverage', 'transitionIn', 'transitionOut',
  'frameReferenceIds', 'clipReferenceIds', 'setReference', 'characterVariant', 'referenceImageId', 'videoHistoryId',
  'performanceEdit', 'direction', 'visualLayer', 'preMusic', 'photoSequence', 'imageTreatments', 'templateEffects'];
const REVIEWED_SCENE_FIELD_SET = new Set(REVIEWED_SCENE_FIELDS);

/** One shot as a reviewed revision stores it: the plan a reviewer saw, without takes or render bookkeeping. */
function reviewedSceneSnapshot(scene) {
  if (!scene || typeof scene !== 'object') return scene;
  return structuredClone(Object.fromEntries(REVIEWED_SCENE_FIELDS.filter(k => scene[k] !== undefined).map(k => [k, scene[k]])));
}
const reviewedScenes = scenes => (Array.isArray(scenes) ? scenes : []).map(reviewedSceneSnapshot);
const sceneIsSlim = scene => !scene || typeof scene !== 'object' || Object.keys(scene).every(k => REVIEWED_SCENE_FIELD_SET.has(k));

// History keeps who decided what, on which basis, and the proof evidence. The
// per-input hashes and approved values feed the staleness report and revert,
// which read only `approvals[stage]`; history keeps them on each stage's latest
// entry and drops them from older ones, where they are dead weight.
function slimApprovalHistory(history) {
  if (!Array.isArray(history)) return history;
  const latest = new Map();
  history.forEach((entry, i) => latest.set(entry?.stage, i));
  let changed = false;
  const next = history.map((entry, i) => {
    if (latest.get(entry?.stage) === i || !entry || typeof entry !== 'object' || !('inputs' in entry || 'values' in entry)) return entry;
    changed = true;
    const { inputs: _inputs, values: _values, ...kept } = entry;
    return kept;
  });
  return changed ? next : history;
}

/**
 * Shrink older review records on write (#16210, #18706). Keep the reviewed
 * shot plan, drop input hashes and values from older history entries, and
 * remove copied board data from shot locks while preserving their bindings.
 */
function slimProductionReview(review) {
  if (!review || typeof review !== 'object') return review;
  let revisions = review.reviewedRevisions;
  if (revisions && typeof revisions === 'object' && Object.values(revisions).some(r => Array.isArray(r?.scenes) && !r.scenes.every(sceneIsSlim))) {
    revisions = Object.fromEntries(Object.entries(revisions).map(([basis, r]) =>
      [basis, Array.isArray(r?.scenes) && !r.scenes.every(sceneIsSlim) ? { ...r, scenes: reviewedScenes(r.scenes) } : r]));
  }
  const approvalHistory = slimApprovalHistory(review.approvalHistory);
  let shotApprovals = review.shotApprovals;
  for (const [id, lock] of Object.entries(review.shotApprovals || {})) {
    if (!lock?.fromBoardApproval || Object.keys(lock).every(key => BOARD_SHOT_LOCK_FIELDS.includes(key))) continue;
    if (shotApprovals === review.shotApprovals) shotApprovals = { ...shotApprovals };
    shotApprovals[id] = pickReviewFields(lock, BOARD_SHOT_LOCK_FIELDS);
  }
  if (revisions === review.reviewedRevisions && approvalHistory === review.approvalHistory && shotApprovals === review.shotApprovals) return review;
  return { ...review, ...(revisions !== review.reviewedRevisions ? { reviewedRevisions: revisions } : {}),
    ...(approvalHistory !== review.approvalHistory ? { approvalHistory } : {}),
    ...(shotApprovals !== review.shotApprovals ? { shotApprovals } : {}) };
}

/** A whole project with `slimProductionReview` applied; the same object when nothing changed. */
export function slimProjectReview(project) {
  const review = slimProductionReview(project?.productionReview);
  return review === project?.productionReview ? project : { ...project, productionReview: review };
}

/**
 * Bound the reviewed-revision snapshots, which ride every project write and sync:
 * keep the newest few plus every snapshot an open comment still points at.
 */
function pruneReviewedRevisions(snapshots, feedback) {
  const keep = new Set((feedback || []).filter(f => !f.resolvedAt).map(f => f.basis));
  // Reversed first so a same-millisecond tie keeps the later-inserted (newer) snapshot.
  Object.entries(snapshots).reverse().sort(([, a], [, b]) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
    .slice(0, MAX_RECENT_REVISIONS).forEach(([key]) => keep.add(key));
  return Object.fromEntries(Object.entries(snapshots).filter(([key]) => keep.has(key)));
}

/** Comments retain the exact reviewed draft, even after a replacement import. */
export function recordProductionFeedback(project, input) {
  const review = project.productionReview || {};
  const basis = productionReviewBasis(project)[input.stage];
  if (input.basis !== basis) throw new ServerError('This revision changed. Review the current revision before commenting.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
  const snapshots = { ...review.reviewedRevisions };
  if (!snapshots[basis]) snapshots[basis] = { draft: structuredClone(review.draft || {}),
    scenes: reviewedScenes(project.scenes), capturedAt: new Date().toISOString() };
  const entry = { id: randomUUID(), stage: input.stage, target: input.target, text: input.text,
    decision: input.decision, basis, createdAt: new Date().toISOString() };
  const approvals = { ...review.approvals };
  if (input.decision === 'request-changes') {
    for (const stage of ['art', 'storyboard', 'proof'].slice(['art', 'storyboard', 'proof'].indexOf(input.stage))) delete approvals[stage];
  }
  const feedback = [...(review.feedback || []), entry];
  return { ...project, productionReview: { ...review, approvals, reviewedRevisions: pruneReviewedRevisions(snapshots, feedback), feedback } };
}

export function resolveProductionFeedback(project, { feedbackId, resolution, reviewer }) {
  const review = project.productionReview || {};
  const entry = review.feedback?.find(f => f.id === feedbackId);
  if (!entry || entry.resolvedAt) throw new ServerError('Open feedback not found.', { status: 409, code: 'MUSIC_VIDEO_FEEDBACK_CLOSED' });
  return { ...project, productionReview: { ...review, feedback: review.feedback.map(f => f.id === feedbackId
    ? { ...f, resolution, ...(reviewer ? { resolvedBy: structuredClone(reviewer) } : {}), resolvedAt: new Date().toISOString(), resolvedBasis: productionReviewBasis(project)[f.stage] } : f) } };
}

export function productionFeedbackContext(project) {
  const feedback = (project.productionReview?.feedback || []).filter(f => !f.resolvedAt);
  return feedback.length ? `\nUNRESOLVED REVIEW FEEDBACK (retain until an authenticated reviewer resolves it):\n${feedback.map(f => `${f.stage} / ${f.target} / ${f.decision}: ${f.text}`).join('\n')}` : '';
}

// A normalized storyboard can advance the decision basis while its reviewed snapshot keeps the supplied key.
export function storeProductionApproval(project, basis, decision) {
  const stage = decision.stage;
  return { ...project, productionReview: { ...project.productionReview,
    approvalHistory: slimApprovalHistory([...(project.productionReview?.approvalHistory || []), decision].slice(-MAX_APPROVAL_HISTORY)),
    reviewedRevisions: pruneReviewedRevisions({ ...omitKey(project.productionReview?.reviewedRevisions, basis), [basis]: { draft: structuredClone(project.productionReview?.draft || {}), scenes: reviewedScenes(project.scenes), proof: structuredClone(project.productionReview?.proof || null), capturedAt: new Date().toISOString() } }, project.productionReview?.feedback),
    approvals: { ...project.productionReview?.approvals, [stage]: decision } } };
}
