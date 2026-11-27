/** Restore approved inputs, carry review bindings, and apply storyboard revision fields. */
import { shotCameraLabel } from '../../lib/cameraMovements.js';
import { ServerError } from '../../lib/errorHandler.js';
import { canonicalSnapshotChecksum as hash } from '../../lib/snapshotChecksum.js';
import { keepCatalogFields, pickReviewFields, productionApprovalInputs, productionReviewBasis, storyboardApprovalCurrent } from './productionReviewBasis.js';

export const unavailableRevert = message => new ServerError(message, { status: 409, code: 'MUSIC_VIDEO_REVERT_UNAVAILABLE' });

// Approved VALUES for the small text inputs a director edits by hand, stored
// beside the hashes so a changed input can be reverted (#10241). Anything over
// the cap, and anything that is not text (media, takes, the song), keeps only
// its hash and so is never revertible. Absent from the record = not revertible.
const MAX_SNAPSHOT_CHARS = 8 * 1024;
const snapshotValue = v => {
  const json = JSON.stringify(v);
  return json !== undefined && json.length <= MAX_SNAPSHOT_CHARS ? JSON.parse(json) : undefined;
};
const snapshotAll = entries => Object.fromEntries(Object.entries(entries)
  .map(([label, v]) => [label, snapshotValue(v)]).filter(([, v]) => v !== undefined));
const DRAFT_FIELD_LABELS = { cast: 'cast', environments: 'environments', 'visual language': 'visualLanguage',
  'motion language': 'motionLanguage', 'implementation plan': 'implementationPlan' };
const SCENE_PROMPT_LABEL = /^scene \d+ prompt$/;
const SCENE_PROMPT_KEYS = ['visualIntent', 'prompt', 'framePrompt'];

/** The approved values of a production stage's revertible inputs, keyed by the same labels as its hashes. */
export function productionApprovalValues(project, stage) {
  const draft = project.productionReview?.draft || {};
  const entries = { concept: project.concept };
  for (const [label, key] of Object.entries(DRAFT_FIELD_LABELS)) entries[label] = draft[key];
  if (stage !== 'art') {
    for (const [i, s] of (project.scenes || []).entries()) {
      entries[`scene ${i + 1} prompt`] = { sceneId: s.sceneId, visualIntent: s.visualIntent, prompt: s.prompt, framePrompt: s.framePrompt };
    }
  }
  return snapshotAll(entries);
}

const CAST_SETS_CONCEPT_STYLE_KEYS = ['style', 'universeStyle', 'moodBoardStyle'];
const CAST_SETS_SPEC_STYLE_KEYS = ['palette', 'typography', 'cameraRules', 'moodBoardId'];
const objectConcept = project => project.concept && typeof project.concept === 'object' ? project.concept : {};

/** The approved values behind a Cast & Sets approval's `concept`, `style` and `subjects` hashes. */
export function castAndSetsApprovalValues(project) {
  const { subjects, style, universeStyle, moodBoardStyle, ...concept } = objectConcept(project);
  return snapshotAll({ concept, subjects: subjects ?? [],
    style: { ...pickReviewFields(objectConcept(project), CAST_SETS_CONCEPT_STYLE_KEYS), ...pickReviewFields(project.visualSpec, CAST_SETS_SPEC_STYLE_KEYS), styleReferences: project.styleReferences ?? null } });
}

function restoreScenePrompt(project, value) {
  if (!project.scenes?.some(s => s.sceneId === value.sceneId)) throw unavailableRevert('That scene no longer exists, so its prompt cannot be restored.');
  return { ...project, scenes: project.scenes.map(s => s.sceneId === value.sceneId ? { ...s, ...Object.fromEntries(SCENE_PROMPT_KEYS.map(k => [k, value[k]])) } : s) };
}

function restoreCastAndSets(project, field, value) {
  const concept = objectConcept(project);
  if (field === 'concept') return { ...project, concept: { ...value, ...pickReviewFields(concept, ['subjects', ...CAST_SETS_CONCEPT_STYLE_KEYS]) } };
  if (field === 'subjects') return { ...project, concept: { ...concept, subjects: keepCatalogFields(value, concept.subjects) } };
  const { styleReferences, ...rest } = value;
  const nextConcept = { ...concept };
  for (const k of CAST_SETS_CONCEPT_STYLE_KEYS) delete nextConcept[k];
  return { ...project, concept: { ...nextConcept, ...pickReviewFields(rest, CAST_SETS_CONCEPT_STYLE_KEYS) },
    visualSpec: { ...project.visualSpec, ...pickReviewFields(rest, CAST_SETS_SPEC_STYLE_KEYS) }, styleReferences };
}

export function restoreApprovedInput(project, field, value, cast) {
  if (cast) return restoreCastAndSets(project, field, value);
  if (field === 'concept') return { ...project, concept: value?.subjects ? { ...value, subjects: keepCatalogFields(value.subjects, project.concept?.subjects) } : value };
  if (DRAFT_FIELD_LABELS[field]) return { ...project, productionReview: { ...project.productionReview,
    draft: { ...project.productionReview?.draft, [DRAFT_FIELD_LABELS[field]]: value } } };
  if (SCENE_PROMPT_LABEL.test(field)) return restoreScenePrompt(project, value);
  throw unavailableRevert('That input cannot be reverted.');
}

export function carryApprovedProductionStages(after, was, reason) {
  const basis = productionReviewBasis(after);
  const inputs = productionApprovalInputs(after);
  const proofExcerpt = after.excerpts?.find(e => e.id === after.productionReview?.proof?.excerptId);
  const approvals = { ...after.productionReview?.approvals };
  for (const stage of ['art', 'storyboard', 'proof']) {
    if (!was[stage]?.approved || !approvals[stage]) continue;
    const next = stage === 'proof' ? hash({ basis: basis.proof, excerptId: proofExcerpt?.id, filename: proofExcerpt?.filename }) : basis[stage];
    approvals[stage] = { ...approvals[stage], basis: next, ...(stage === 'storyboard' ? { shotsBasis: basis.storyboardShots } : {}), inputs: inputs[stage], carriedOver: { reason, at: new Date().toISOString() } };
  }
  return { ...after, productionReview: { ...after.productionReview, approvals } };
}

/**
 * Keep a current storyboard approval across a director's own shot edit (a cut,
 * a merge, a retime or a reworded prompt): it adds no shot or lyric the
 * approval did not already cover, so the director is not asked to approve the
 * same board again. The proof stays bound to its render and stales
 * as before. Returns `after` unchanged when the storyboard was not approved on
 * `before`'s current revision.
 */
export function carryStoryboardApproval(before, after, reason) {
  const approval = before.productionReview?.approvals?.storyboard;
  if (!storyboardApprovalCurrent(approval, productionReviewBasis(before))) return after;
  const basis = productionReviewBasis(after);
  const approvals = { ...after.productionReview?.approvals, storyboard: { ...approval,
    basis: basis.storyboard, shotsBasis: basis.storyboardShots, inputs: productionApprovalInputs(after).storyboard,
    carriedOver: { reason, at: new Date().toISOString() } } };
  return { ...after, productionReview: { ...after.productionReview, approvals } };
}

// Labeled inputs and values name a shot by its board position ("scene 3 timing").
const SCENE_POSITION_KEY = /^scene (\d+) (.+)$/;

/**
 * Re-stamp the review bindings across a change that only puts the same shots in
 * time order (#16117). The bases hash `scenes` by position, so without this the
 * repair of a board stored out of time order would stale approvals and the
 * rendered proof though nothing in the cut changed. Only a binding that held on
 * `before` moves to `after`; a stale one stays stale. Position keys of an
 * approval's recorded inputs and values follow their shots, so a later
 * staleness check still names what changed since the approval.
 */
export function carryReviewThroughSceneOrder(before, after) {
  const review = after.productionReview;
  if (!review) return after;
  const was = productionReviewBasis(before);
  const now = productionReviewBasis(after);
  const wasInputs = productionApprovalInputs(before);
  const nowInputs = productionApprovalInputs(after);
  const newIndex = new Map((after.scenes || []).map((scene, i) => [scene.sceneId, i + 1]));
  const position = new Map((before.scenes || []).map((scene, i) => [i + 1, newIndex.get(scene.sceneId) ?? i + 1]));
  const moveKey = (key) => {
    const match = SCENE_POSITION_KEY.exec(key);
    return match ? `scene ${position.get(Number(match[1])) ?? match[1]} ${match[2]}` : key;
  };
  const moveKeys = (record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [moveKey(key), value]));
  // An order-sensitive input that held (the proof's take list) re-stamps; the rest move with their shots.
  const carryInputs = (inputs, stage) => {
    const moved = moveKeys(inputs);
    for (const key of Object.keys(moved)) {
      if (!SCENE_POSITION_KEY.test(key) && inputs[key] === wasInputs[stage][key]) moved[key] = nowInputs[stage][key];
    }
    return moved;
  };
  const carryApproval = (approval, stage) => ({ ...approval,
    ...(approval.inputs && typeof approval.inputs === 'object' ? { inputs: carryInputs(approval.inputs, stage) } : {}),
    ...(approval.values && typeof approval.values === 'object' ? { values: moveKeys(approval.values) } : {}) });
  const approvals = review.approvals ? { ...review.approvals } : review.approvals;
  const board = approvals?.storyboard;
  if (board && (board.basis === was.storyboard || (!!was.storyboardShots && board.shotsBasis === was.storyboardShots))) {
    approvals.storyboard = { ...carryApproval(board, 'storyboard'),
      ...(board.basis === was.storyboard ? { basis: now.storyboard } : {}),
      ...(board.shotsBasis && board.shotsBasis === was.storyboardShots ? { shotsBasis: now.storyboardShots } : {}) };
  }
  const excerpt = (after.excerpts || []).find((e) => e.id === review.proof?.excerptId);
  const proofKey = (basis) => hash({ basis, excerptId: excerpt?.id, filename: excerpt?.filename });
  if (approvals?.proof && excerpt && approvals.proof.basis === proofKey(was.proof)) {
    approvals.proof = { ...carryApproval(approvals.proof, 'proof'), basis: proofKey(now.proof) };
  }
  const next = { ...review, ...(approvals ? { approvals } : {}) };
  if (review.proof?.basis && review.proof.basis === was.proof) next.proof = { ...review.proof, basis: now.proof };
  return { ...after, productionReview: next };
}

/** Apply proposed shot edits to both the board scenes and their derived review rows. */
export function applyStoryboardReviewRevision(current, updates) {
  const scenes = current.scenes.map(scene => updates.has(scene.sceneId) ? { ...scene, ...updates.get(scene.sceneId) } : scene);
  const draft = current.productionReview?.draft;
  const storyboard = draft?.storyboard?.map(shot => {
    const fields = updates.get(shot.sceneId);
    return fields ? { ...shot, ...(fields.prompt ? { action: fields.prompt } : {}), ...(fields.framePrompt ? { staging: fields.framePrompt } : {}),
      ...(fields.camera ? { camera: shotCameraLabel(fields.camera) } : {}) } : shot;
  });
  return { ...current, scenes, updatedAt: new Date().toISOString(),
    ...(storyboard ? { productionReview: { ...current.productionReview, draft: { ...draft, storyboard } } } : {}) };
}
