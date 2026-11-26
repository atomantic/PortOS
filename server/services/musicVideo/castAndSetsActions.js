/** Director actions that review, revise, or approve a Music Video Cast & Sets check-in. */
import { createCatalogReads, isCatalogCheckin, resolveCatalogCheckin, withCatalogCheckin, assertLegacyCheckin, remapCatalogShotReferences } from './catalogCheckin.js';
import { previewCastSetsImageEdit, requestCastSetsImageEdit, acceptCastSetsImageEdit, discardCastSetsImageEdit } from './castAndSetsImageEdit.js';
import { castAndSetsApprovalInputs, castAndSetsApprovalValues } from './productionReview.js';
import { randomUUID } from 'crypto';
import { castSetsInspectionInputs, currentCastSetsInspection, sameCastSetsInspectionInputs } from '../../lib/musicVideo/musicVideoCastSetsInspection.js';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { mutateProjectRecord } from './projects.js';
import { CAST_SETS_PROCESS_ID as PROCESS_ID } from './processPins.js';
import { requireProject } from './requireProject.js';
import {
  CAST_SETS_WORKING,
  CAST_SETS_MAX_KEY_NOTES,
  CAST_SETS_MAX_IMAGE_HISTORY,
  presentCastAndSets,
  addCastAndSetsFeedback,
  reconfirmCastAndSetsOnProject,
  removeCastAndSetsFeedback,
  removeCastAndSetsImageNote,
  reviseCastAndSetsOnProject,
  setCastAndSetsStatus,
} from './castAndSets.js';
import {
  applyCastAndSetsDirectionEdits,
  applyCastAndSetsDirectionTextEdits,
  fixedSupportingCast,
  songSections,
  newUnknownFormSubjects,
  withCheckedFormSubjects,
} from './castAndSetsDirection.js';
import {
  CAST_SETS_REF_PREFIX,
  buildCastAndSetsImagePlan,
  castAndSetsReferences,
  noteImageKeys,
  plannedTests,
} from './castAndSetsPlan.js';
import { findDevArtifact, resolveDevArtifactNotes } from './devArtifacts.js';
import { PRODUCTION_RESUMABLE_STATUSES } from './production.js';
import {
  approveCastAndSetsCheckin,
  short,
  pendingGreyboxState,
  publish,
  settleAndRebase,
  approveCatalogCheckin,
} from './castAndSetsApproval.js';
import {
  castAndSetsDeps,
  keyNotesText,
  currentImagePlan,
  writePlan,
  runDirection,
  refundUnusedCheckinSteps,
  advance,
  inBackground,
  queueApprovedSheetRefresh,
} from './castAndSetsDispatch.js';

/** Approve the current check-in and refresh a legacy sheet when needed. */
export async function approveCastAndSets(projectId, input = {}) {
  return approveCastAndSetsCheckin(projectId, input, { catalog: castAndSetsDeps.catalog, refreshSheet: queueApprovedSheetRefresh });
}

// A legacy card has no test snapshot. Use the same complete plan comparison
// for read-time hydration and write-time edits; a partial match is ambiguous.
function matchingTestCards(project, stage) {
  const direction = stage.direction;
  const effective = plannedTests(project, direction);
  const rebuilt = buildCastAndSetsImagePlan(project, direction, { revisionNotes: keyNotesText(stage.keyNotes) });
  const cards = Object.values(stage.plan || {}).filter((item) => item.kind === 'test').sort((a, b) => a.testIndex - b.testIndex);
  const matchesLegacy = (card) => {
    const fresh = rebuilt[card.key];
    return fresh && card.prompt === fresh.prompt && card.setId === fresh.setId && card.label === fresh.label
      && JSON.stringify(card.deps) === JSON.stringify(fresh.deps) && JSON.stringify(card.refKeys) === JSON.stringify(fresh.refKeys);
  };
  if (cards.length !== effective.length || cards.some((card, i) => card.testIndex !== i || (card.test
    ? JSON.stringify(card.test) !== JSON.stringify(effective[i])
    : !matchesLegacy(card)))) return null;
  return cards.map((card, i) => card.test || effective[i]);
}

function presentStage(project) {
  const stage = presentCastAndSets(project?.castAndSets, PROCESS_ID);
  if (!stage?.direction) return stage;
  // Older malformed records should remain readable; an unverified card stays
  // unhydrated and the edit route continues to reject a mismatched plan.
  try {
    if (!Object.values(stage.plan || {}).some((item) => item.kind === 'test' && !item.test)) return stage;
    const tests = matchingTestCards(project, stage);
    if (!tests) return stage;
    return { ...stage, plan: Object.fromEntries(Object.entries(stage.plan).map(([key, item]) => [key,
      item.kind === 'test' && !item.test ? { ...item, test: tests[item.testIndex] } : item])) };
  } catch { return stage; }
}

/** Record an explicit operator decision on this exact image, including unavailable vision. */
export async function acknowledgeCastAndSetsImage(projectId, input, reviewer) {
  assertLegacyCheckin(await requireProject(projectId));
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const stage = current.castAndSets;
    if (stage?.status !== 'review') throw new ServerError('The sheet is not waiting for review', { status: 409, code: 'CAST_SETS_NOT_IN_REVIEW' });
    if (stage.feedbackRenderPlan) throw new ServerError('Finish the feedback plan before accepting images', { status: 409, code: 'CAST_SETS_FEEDBACK_PENDING' });
    const inputs = castSetsInspectionInputs(stage, input.inputs.key);
    const inspection = currentCastSetsInspection(stage, input.inputs.key);
    if (!sameCastSetsInspectionInputs(inputs, input.inputs) || input.inspectionId !== (inspection?.id || null)) throw new ServerError('This image or inspection changed. Review it again.', { status: 409, code: 'CAST_SETS_INSPECTION_STALE' });
    // A verdict still on its way could turn out to be a mismatch the director never saw.
    if (inspection?.verdict === 'pending') throw new ServerError('Vision is still checking this image. Wait for its answer.', { status: 409, code: 'CAST_SETS_INSPECTION_PENDING' });
    const image = stage.images[input.inputs.key];
    return { project: { ...current, castAndSets: { ...stage, images: { ...stage.images,
      [input.inputs.key]: { ...image, inspectionAcknowledgement: { inputs, inspectionId: input.inspectionId, reviewer, at: new Date().toISOString() } } } } } };
  });
  publish(projectId, out.project);
  return { project: out.project };
}

/** Re-run vision on existing images (all unreviewed/mismatched when `keys` is omitted) without touching approval. */
export async function reinspectCastAndSetsImages(projectId, { keys } = {}) {
  assertLegacyCheckin(await requireProject(projectId));
  const project = await requireProject(projectId);
  if (project.castAndSets?.feedbackRenderPlan) throw new ServerError('Finish the feedback plan before inspecting images', { status: 409, code: 'CAST_SETS_FEEDBACK_PENDING' });
  const { reinspectCastAndSetsImages: run } = await import('./castAndSetsInspection.js');
  return run(projectId, { keys, resolveReviewer: castAndSetsDeps.resolveReviewer, reviewImage: castAndSetsDeps.reviewImage, publish });
}

/** Adopt a gallery take without re-rendering it or approving uninspected pixels. */
export async function useCastAndSetsImage(projectId, { key, imageId }) {
  assertLegacyCheckin(await requireProject(projectId));
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const stage = current.castAndSets;
    if (!stage || !['review', 'approved'].includes(stage.status)) throw new ServerError('Wait for the check-in to finish before choosing an image', { status: 409, code: 'CAST_SETS_NOT_IN_REVIEW' });
    if (stage.feedbackRenderPlan) throw new ServerError('Finish the feedback plan before choosing an image', { status: 409, code: 'CAST_SETS_FEEDBACK_PENDING' });
    if (!Object.hasOwn(stage.plan || {}, key) || !Object.hasOwn(stage.images || {}, key)) throw new ServerError('This image slot no longer exists', { status: 404, code: 'NOT_FOUND' });
    if (!resolveGalleryImage(imageId)) throw new ServerError('The selected gallery image is missing', { status: 404, code: 'NOT_FOUND' });
    const old = stage.images[key];
    const revision = stage.revision + 1;
    // `updatedAt` is when this slot took its image: a frame rendered before it did not use it (#16473).
    const image = { ...old, imageId, status: 'done', jobId: null, error: null, edit: null, updatedAt: new Date().toISOString(),
      inspection: null, inspectionAcknowledgement: null, submittedRevision: revision,
      submittedPrompt: null, promptAdditions: [], submittedPromptTruncated: false,
      submittedReferences: [], submittedReferencesTruncated: false,
      history: [...new Set([...(old.history || []), old.imageId].filter((id) => id && id !== imageId))].slice(-CAST_SETS_MAX_IMAGE_HISTORY) };
    const next = { ...stage, revision, processId: PROCESS_ID, status: 'imaging', manualImageEditReview: true,
      approvedAt: null, approvedInputs: null, approvedValues: null,
      images: { ...stage.images, [key]: image } };
    // Only this slot changes now; other hand-picked project references remain intact.
    const refId = `${CAST_SETS_REF_PREFIX}${key.replace(':', '-')}`.slice(0, 64);
    const reference = castAndSetsReferences(current, next).find((ref) => ref.id === refId);
    const references = current.visualSpec?.references || [];
    const updated = references.some((ref) => ref.id === refId)
      ? references.map((ref) => ref.id === refId ? { ...ref, imageId } : ref)
      : reference ? [...references, reference] : references;
    return { project: { ...current, castAndSets: next, visualSpec: { ...current.visualSpec, references: updated } } };
  });
  publish(projectId, out.project);
  inBackground('The chosen image', projectId, async () => {
    await castAndSetsDeps.syncCatalogImage(projectId, key).catch((err) => console.error(`❌ Music Video Cast & Sets ${short(projectId)}: saving chosen image to the catalog failed; approval will retry: ${err.message}`));
    await advance(projectId);
  });
  return { project: out.project };
}

/**
 * Keep an approved check-in approved on the project's current concept, style,
 * subjects and song (#10141): clears the "changed since" note without
 * rebuilding the sheet or re-applying its references. Returns `{ project, stage }`.
 */
export async function reconfirmCastAndSets(projectId, input = {}) {
  if (isCatalogCheckin(await requireProject(projectId))) return approveCatalogCheckin(projectId, input, castAndSetsDeps.catalog);
  await requireProject(projectId);
  const now = new Date().toISOString();
  const out = await mutateProjectRecord(projectId, (current) => reconfirmCastAndSetsOnProject(current, castAndSetsApprovalInputs(current), castAndSetsApprovalValues(current), now));
  console.log(`✅ Music Video Cast & Sets ${short(projectId)} kept approved on current inputs`);
  publish(projectId, out.project);
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Skip the check-in (e.g. no image backend): the autopilot continues without it. */
export async function skipCastAndSets(projectId) {
  assertLegacyCheckin(await requireProject(projectId));
  await requireProject(projectId);
  const now = new Date().toISOString();
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const base = current.castAndSets ? current : { ...current, castAndSets: { revision: 0, images: {}, plan: {}, createdAt: now } };
    if (base.castAndSets.feedbackRenderPlan) throw new ServerError('Finish or discard the feedback plan before skipping the check-in', { status: 409, code: 'CAST_SETS_FEEDBACK_PENDING' });
    if (base.castAndSets.status === 'approved') throw new ServerError('The Cast & Sets check-in is already approved', { status: 409, code: 'CAST_SETS_EXISTS' });
    // A skip also releases work in flight for it: this process stops dispatching.
    return settleAndRebase(setCastAndSetsStatus(refundUnusedCheckinSteps(base), 'skipped', { reason: 'Skipped by the director' }, now), now);
  });
  console.log(`⏭️ Music Video Cast & Sets ${short(projectId)} skipped`);
  publish(projectId, out.project);
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Render an isolated candidate; the approved stage remains unchanged until acceptance. */
export const previewCastAndSetsImageEdit = async (projectId, input) => {
  assertLegacyCheckin(await requireProject(projectId));
  return previewCastSetsImageEdit(projectId, input, castAndSetsDeps);
};

export const editCastAndSetsImage = async (projectId, input) => {
  assertLegacyCheckin(await requireProject(projectId));
  return requestCastSetsImageEdit(projectId, input, { ...castAndSetsDeps, processId: PROCESS_ID, publish });
};

export async function discardCastAndSetsImageEdit(projectId, input) {
  assertLegacyCheckin(await requireProject(projectId));
  return discardCastSetsImageEdit(projectId, input, publish);
}

export async function acceptCastAndSetsImageEdit(projectId, input) {
  assertLegacyCheckin(await requireProject(projectId));
  const out = await acceptCastSetsImageEdit(projectId, input, PROCESS_ID);
  publish(projectId, out.project);
  inBackground('The accepted image edit', projectId, () => advance(projectId));
  return { project: out.project };
}

/**
 * Regenerate, with notes or without. `notes` default to the open notes on the stage's
 * sheet. A note aimed at an image (`character`, `looks`, `set:<id>`,
 * `test:<n>`, …) re-renders that image and what depends on it; any other
 * note revises the direction, and only images whose prompt changed re-render.
 * The consumed notes are resolved on the sheet. Returns `{ project, stage }`.
 */
export async function regenerateCastAndSets(projectId, { notes = null, keys = null, providerId, model, effort } = {}) {
  assertLegacyCheckin(await requireProject(projectId));
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  if (!stage?.direction) throw new ServerError('There is no Cast & Sets sheet to regenerate yet', { status: 409, code: 'CAST_SETS_NO_DIRECTION' });
  const unknownKeys = (keys || []).filter((key) => !stage.plan?.[key]);
  if (unknownKeys.length) throw new ServerError(`No image on this sheet is called ${unknownKeys.join(', ')}`, { status: 422, code: 'CAST_SETS_UNKNOWN_IMAGE' });
  const artifact = stage.artifactId ? (() => { try { return findDevArtifact(project, stage.artifactId); } catch { return null; } })() : null;
  // Re-rendering chosen images (`keys`) is another take of just those: open sheet notes stay open.
  const reviewNotes = keys?.length ? [] : (project.productionReview?.feedback || []).filter(n => n.stage === 'art' && !n.resolvedAt)
    .map(n => ({ target: `production-review:${n.target}`, text: n.text }));
  const sheetNotes = keys?.length ? [] : (artifact?.notes || []).filter((n) => !n.resolvedAt);
  const source = [...(Array.isArray(notes) ? notes : sheetNotes), ...reviewNotes];
  const imageNotes = {};
  const directionNotes = [];
  for (const note of source) {
    const keys = noteImageKeys(note.target, stage.plan || {});
    if (keys) keys.forEach((k) => { imageNotes[k] = [...(imageNotes[k] || []), note.text]; });
    else directionNotes.push(note);
  }
  const redirect = directionNotes.length > 0;
  const consumed = new Set(source.map((n) => n.id).filter(Boolean));
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const revised = reviseCastAndSetsOnProject(current, { processId: PROCESS_ID, notesApplied: source, redirect });
    const keyNotes = { ...(revised.stage.keyNotes || {}) };
    for (const [k, list] of Object.entries(imageNotes)) keyNotes[k] = [...(keyNotes[k] || []), ...list].slice(-CAST_SETS_MAX_KEY_NOTES);
    let next = { ...revised.project, castAndSets: { ...revised.stage, keyNotes } };
    if (artifact && consumed.size) next = resolveDevArtifactNotes(next, artifact.id, (n) => consumed.has(n.id)).project;
    return { project: next, stage: next.castAndSets };
  });
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} regenerating r${out.stage.revision} (${keys?.length ? `${keys.length} image(s), ` : ''}${source.length} note(s)${redirect ? ', new direction' : ''})`);
  publish(projectId, out.project);
  // With no notes the director asks for another take: of the images they
  // picked, else of every image, from the current direction.
  const forceKeys = keys?.length ? [...new Set([...keys, ...Object.keys(imageNotes)])]
    : source.length ? Object.keys(imageNotes) : Object.keys(stage.plan || {});
  inBackground('The regeneration', projectId, () => (redirect
    ? runDirection(projectId, { providerId, model, effort, notes: directionNotes, forceKeys })
    : writePlan(projectId, { forceKeys })));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/**
 * Apply the director's plain-text feedback on the sheet. Aimed at one image
 * (`target`: `character`, `looks`, `set:<id>`, a set's name, …) it is that
 * image's revision note (see regenerateCastAndSets). Aimed at the whole sheet
 * (no target) it becomes STANDING feedback: the direction is rewritten to
 * honor it, including the scene look line set plates and in-set frames carry, and every
 * later direction call (a rebuild included) keeps honoring it until the
 * director removes it. The resulting image plan is held for explicit review.
 * Returns `{ project, stage }`.
 */
export async function applyCastAndSetsFeedback(projectId, { text, target = null, providerId, model, effort } = {}) {
  assertLegacyCheckin(await requireProject(projectId));
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const stage = current.castAndSets;
    if (!stage?.direction) throw new ServerError('There is no Cast & Sets sheet to give feedback on yet', { status: 409, code: 'CAST_SETS_NO_DIRECTION' });
    if (!['review', 'approved'].includes(stage.status)) throw new ServerError('Wait for the check-in to stop before applying feedback', { status: 409, code: 'CAST_SETS_NOT_IN_REVIEW' });
    if (Object.values(stage.images || {}).some((image) => image.status === 'queued')) throw new ServerError('Wait for previously queued images to finish before applying more feedback.', { status: 409, code: 'CAST_SETS_JOBS_IN_FLIGHT' });
    const forceKeys = target ? noteImageKeys(target, stage.plan || {}) : [];
    if (target && !forceKeys) throw new ServerError(`No image on this sheet is called ${target}`, { status: 422, code: 'CAST_SETS_UNKNOWN_IMAGE' });
    const feedbackId = target ? null : `fb-${randomUUID().slice(0, 8)}`;
    const note = { id: feedbackId, target: target || 'sheet', text };
    const added = target ? { project: current } : addCastAndSetsFeedback(current, { id: feedbackId, text });
    const revised = reviseCastAndSetsOnProject(added.project, { processId: PROCESS_ID, notesApplied: [note], redirect: !target, feedbackRevision: true });
    const keyNotes = { ...(revised.stage.keyNotes || {}) };
    for (const key of forceKeys) keyNotes[key] = [...(keyNotes[key] || []), text].slice(-CAST_SETS_MAX_KEY_NOTES);
    const run = (current.productionRuns || []).find((item) => item.id === stage.productionRunId);
    const productionRunId = stage.productionRunId && (!run || !PRODUCTION_RESUMABLE_STATUSES.has(run.status)) ? null : stage.productionRunId;
    const next = { ...revised.stage, productionRunId, keyNotes, feedbackRenderPlan: { phase: 'planning', kind: target ? 'image' : 'direction', keys: stage.feedbackRenderPlan?.keys || [], forceKeys } };
    return { project: { ...revised.project, castAndSets: next }, stage: next };
  });
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} planning feedback r${out.stage.revision}`);
  publish(projectId, out.project);
  inBackground('The feedback', projectId, () => (target
    ? writePlan(projectId, { forceKeys: out.stage.feedbackRenderPlan.forceKeys })
    : runDirection(projectId, { providerId, model, effort, notes: out.stage.notesApplied })));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Start exactly the feedback plan the director reviewed, never a later revision. */
export async function renderCastAndSetsFeedback(projectId, { revision, count }) {
  assertLegacyCheckin(await requireProject(projectId));
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const stage = current.castAndSets;
    const plan = stage?.feedbackRenderPlan;
    if (stage?.status !== 'review' || plan?.phase !== 'ready' || stage.revision !== revision || plan.keys.length !== count) {
      throw new ServerError('The feedback plan changed. Review its current image count before rendering.', { status: 409, code: 'CAST_SETS_PLAN_STALE' });
    }
    if (Object.values(stage.images || {}).some((image) => image.status === 'queued')) throw new ServerError('Wait for previously queued images to finish before rendering the remaining plan.', { status: 409, code: 'CAST_SETS_JOBS_IN_FLIGHT' });
    if (count && !stage.route) throw new ServerError('No image renderer is available. Enable one, then refresh the renderer.', { status: 409, code: 'CAST_SETS_NO_IMAGE_ROUTE' });
    const run = (current.productionRuns || []).find((item) => item.id === stage.productionRunId);
    if (run && run.status !== 'running' && PRODUCTION_RESUMABLE_STATUSES.has(run.status)) {
      throw new ServerError('The production run is not running. Resume the run before rendering this feedback plan.', { status: 409, code: 'CAST_SETS_NOT_RUNNING' });
    }
    const next = { ...stage, productionRunId: stage.productionRunId && (!run || !PRODUCTION_RESUMABLE_STATUSES.has(run.status)) ? null : stage.productionRunId,
      feedbackRenderPlan: null, processId: PROCESS_ID, status: 'imaging', manualImageEditReview: true };
    return { project: { ...current, castAndSets: next }, stage: next };
  });
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} rendering feedback r${revision} (${count} planned)`);
  publish(projectId, out.project);
  inBackground('The feedback render', projectId, () => advance(projectId));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Re-resolve an unavailable renderer without repeating feedback or calling a model. */
export async function refreshCastAndSetsFeedbackRenderer(projectId, { revision }) {
  assertLegacyCheckin(await requireProject(projectId));
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const stage = current.castAndSets;
    if (stage?.status !== 'review' || stage.feedbackRenderPlan?.phase !== 'ready' || stage.revision !== revision) {
      throw new ServerError('The feedback plan changed. Review it before refreshing the renderer.', { status: 409, code: 'CAST_SETS_PLAN_STALE' });
    }
    if (Object.values(stage.images || {}).some((image) => image.status === 'queued')) throw new ServerError('Wait for previously queued images to finish before refreshing the renderer.', { status: 409, code: 'CAST_SETS_JOBS_IN_FLIGHT' });
    const now = new Date().toISOString();
    const next = { ...stage, revision: stage.revision + 1, status: 'imaging', processId: PROCESS_ID, updatedAt: now,
      feedbackRenderPlan: { ...stage.feedbackRenderPlan, phase: 'planning', kind: 'image', forceKeys: [] } };
    return { project: { ...current, castAndSets: next, updatedAt: now }, stage: next };
  });
  publish(projectId, out.project);
  inBackground('The feedback renderer refresh', projectId, () => writePlan(projectId));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Stop honoring one piece of standing sheet feedback. Nothing re-renders until the next revision. Returns `{ project, stage }`. */
export async function removeCastAndSetsFeedbackEntry(projectId, feedbackId) {
  assertLegacyCheckin(await requireProject(projectId));
  await requireProject(projectId);
  const out = await mutateProjectRecord(projectId, (current) => removeCastAndSetsFeedback(current, feedbackId));
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} feedback removed (${out.stage.feedback.length} standing)`);
  publish(projectId, out.project);
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

export async function removeCastAndSetsImageFeedback(projectId, input) {
  assertLegacyCheckin(await requireProject(projectId));
  const out = await mutateProjectRecord(projectId, (current) => removeCastAndSetsImageNote(current, { ...input, processId: PROCESS_ID }));
  publish(projectId, out.project);
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/**
 * Save the director's direct edits to the direction (a protagonist field, the
 * moods, the other ages, the looks, a cast member, a set, a test; edits or
 * removals, see applyCastAndSetsDirectionEdits) through the revision path: the
 * stage re-opens as a new revision, the edited direction is persisted in the
 * same write, and only images whose prompt changed re-render before the sheet
 * is re-assembled; a removed item's image leaves the sheet (it stays in the
 * gallery). Works on a sheet in review, an approved one (it goes back to
 * review) and a failed one. No direction (text) provider call is made; a
 * changed image prompt is the director's save acting on the image queue.
 * Returns `{ project, stage }`.
 */
export async function editCastAndSetsDirection(projectId, edits) {
  assertLegacyCheckin(await requireProject(projectId));
  const project = await requireProject(projectId);
  const sections = songSections(project);
  const referencesOnly = edits?.sets?.length && !edits.protagonist && !edits.world && edits.sets.every((s) => Object.hasOwn(s, 'setReference') && !Object.hasOwn(s, 'imageRole'));
  if (referencesOnly) {
    const out = await mutateProjectRecord(projectId, async (current) => {
    assertLegacyCheckin(current);
      if (!current.castAndSets?.direction || !['review', 'approved'].includes(current.castAndSets.status)) throw new ServerError('The Cast & Sets direction is not ready to edit.', { status: 409, code: 'CAST_SETS_NOT_IN_REVIEW' });
      if (current.castAndSets.feedbackRenderPlan) throw new ServerError('Finish the feedback plan before editing the direction', { status: 409, code: 'CAST_SETS_FEEDBACK_PENDING' });
      const edited = applyCastAndSetsDirectionEdits(current.castAndSets.direction, edits, { sections });
      const pending = await pendingGreyboxState(current, castAndSetsDeps.catalog);
      const pendingSetIds = new Set(pending.direct);
      const legacySetIds = new Set(pending.legacy);
      for (const set of edits.sets) {
        const rendered = current.castAndSets.plan?.[`set:${set.id}`]?.setReference;
        // A matching camera id can now resolve to a different capture or environment.
        legacySetIds.delete(set.id);
        if (set.setReference?.greyboxShotId || rendered?.greyboxShotId) pendingSetIds.add(set.id);
        else pendingSetIds.delete(set.id);
      }
      const greyboxPending = pendingSetIds.size > 0 || legacySetIds.size > 0;
      const stage = { ...current.castAndSets, direction: edited.direction, greyboxPending, greyboxPendingSetIds: [...pendingSetIds], greyboxLegacyPendingSetIds: [...legacySetIds], status: greyboxPending ? 'review' : current.castAndSets.status, updatedAt: new Date().toISOString() };
      return { project: { ...current, castAndSets: stage }, stage };
    });
    publish(projectId, out.project);
    return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
  }
  let changed = [];
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const stage = current.castAndSets;
    if (!stage?.direction) throw new ServerError('There is no Cast & Sets direction to edit yet', { status: 409, code: 'CAST_SETS_NO_DIRECTION' });
    if (stage.status === 'skipped') throw new ServerError('The Cast & Sets check-in was skipped — rebuild it first', { status: 409, code: 'CAST_SETS_NOT_IN_REVIEW' });
    let direction = stage.direction;
    if (edits.tests?.length) {
      const tests = matchingTestCards(current, stage);
      if (!tests) {
        throw new ServerError('The saved test cards no longer match this direction. Rebuild the check-in before editing them.', { status: 409, code: 'CAST_SETS_TEST_PLAN_STALE' });
      }
      direction = { ...direction, tests };
    }
    const edited = applyCastAndSetsDirectionEdits(direction, edits, { sections, fixedCast: fixedSupportingCast(current) });
    if (newUnknownFormSubjects(current, edited.direction, direction).length) {
      throw new ServerError('That age is linked to a character this video has not cast from the catalog. Link the character in Creative setup first.', { status: 422, code: 'CAST_SETS_UNKNOWN_SUBJECT' });
    }
    if (!edited.changed.length) throw new ServerError('Nothing changed — edit a field first', { status: 422, code: 'CAST_SETS_NO_EDITS' });
    changed = edited.changed;
    const notesApplied = [{ id: null, target: 'direction', text: `Edited by the director: ${changed.join(', ')}` }];
    const revised = reviseCastAndSetsOnProject(current, { processId: PROCESS_ID, notesApplied, redirect: false });
    const next = { ...revised.project, castAndSets: { ...revised.stage, direction: withCheckedFormSubjects(current, edited.direction, direction) } };
    return { project: next, stage: next.castAndSets };
  });
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} direction edited r${out.stage.revision} (${changed.length} field(s))`);
  publish(projectId, out.project);
  inBackground('The direction edit', projectId, () => writePlan(projectId));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/**
 * Save a text-only edit to a catalog check-in's stored direction (look line,
 * protagonist signature/rules/expressions, props, overlay concept). When a
 * catalog-first check-in has no stored direction yet, creates a text-only
 * direction from the submitted fields. The catalog owns the cast, environments
 * and objects, so nothing re-renders, the revision and status stay put, and the
 * catalog approval (bound to the catalog, not this text) is untouched. Returns
 * `{ project, stage }`.
 */
export async function editCastAndSetsDirectionText(projectId, edits) {
  let changed = [];
  const out = await mutateProjectRecord(projectId, (current) => {
    if (!isCatalogCheckin(current)) throw new ServerError('This check-in renders from its direction. Edit it through the direction editor.', { status: 409, code: 'CAST_SETS_NOT_CATALOG' });
    const stage = current.castAndSets;
    const edited = applyCastAndSetsDirectionTextEdits(stage.direction || {}, edits);
    if (!edited.changed.length) throw new ServerError('Nothing changed — edit a field first', { status: 422, code: 'CAST_SETS_NO_EDITS' });
    changed = edited.changed;
    const next = { ...current, castAndSets: { ...stage, direction: edited.direction, updatedAt: new Date().toISOString() } };
    return { project: next, stage: next.castAndSets };
  });
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} catalog direction text edited (${changed.join(', ')})`);
  publish(projectId, out.project);
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/**
 * Throw the check-in away so it can be built again from the story (Start
 * over). Refused while it is working in this process, once approved (Rebuild
 * keeps an approved sheet's history), and while a production run owns it.
 * The rendered images stay in the gallery and an assembled sheet stays in the
 * development artifacts. Returns `{ project }`.
 */
export async function discardCastAndSets(projectId) {
  assertLegacyCheckin(await requireProject(projectId));
  await requireProject(projectId);
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const stage = current.castAndSets;
    if (!stage) throw new ServerError('This project has no Cast & Sets check-in', { status: 404, code: 'NOT_FOUND' });
    if (CAST_SETS_WORKING.includes(stage.status) && stage.processId === PROCESS_ID) throw new ServerError('The Cast & Sets check-in is still being prepared — wait for it to stop', { status: 409, code: 'CAST_SETS_IN_PROGRESS' });
    if (stage.status === 'approved') throw new ServerError('An approved check-in is rebuilt, not thrown away', { status: 409, code: 'CAST_SETS_APPROVED' });
    if (stage.productionRunId && (current.productionRuns || []).find((r) => r.id === stage.productionRunId)?.status === 'running') {
      throw new ServerError('A production run is waiting on this check-in — stop the run first', { status: 409, code: 'CAST_SETS_IN_PRODUCTION' });
    }
    const runKnown = (current.productionRuns || []).some((r) => r.id === stage.productionRunId);
    const { castAndSets: _discarded, ...rest } = runKnown ? refundUnusedCheckinSteps(current) : current;
    return { project: { ...rest, updatedAt: new Date().toISOString() } };
  });
  console.log(`🗑️ Music Video Cast & Sets ${short(projectId)} discarded`);
  publish(projectId, out.project);
  return { project: out.project };
}

/**
 * What changed in the video's Casting since its idle sheet (in review or
 * approved) was built: `{ images, cast }` or null. `images` are the sheet's
 * images (`{ key, label }`) whose reference images now differ, from a Casting
 * record's images changing or a subject being linked to (or unlinked from) a
 * record the direction already casts; re-rendering those keys picks them up.
 * `cast` names linked supporting characters the direction has no sheet for,
 * which only a rebuild from the story adds. Sets are matched by image only:
 * the direction may name a linked place's set differently.
 */
export async function getCastAndSetsCastingChanges(projectId) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  if (isCatalogCheckin(project)) return { changes: null };
  if (!stage?.direction || !['review', 'approved'].includes(stage.status)) return { changes: null };
  // Only reference images are compared, so the look line (withoutBoardLook) is not needed.
  const direction = stage.direction;
  const { plan } = await currentImagePlan(project, direction);
  const before = stage.plan || {};
  // Once approved, the sheet's own images are labeled references a name match
  // can fall back to; they are this build's output, never a Casting change.
  const own = new Set(Object.values(stage.images || {}).flatMap((img) => [img?.imageId, ...(img?.history || [])]).filter(Boolean));
  const refs = (item) => (item?.refImages || []).filter((id) => !own.has(id)).join('|');
  const images = Object.values(plan)
    .filter((item) => before[item.key] && refs(before[item.key]) !== refs(item))
    .map((item) => ({ key: item.key, label: item.label }));
  const castKey = (name) => String(name || '').trim().toLowerCase();
  const drawn = new Set([direction.protagonist?.name, ...(direction.cast || []).map((c) => c.name)].map(castKey));
  const bound = new Set((direction.protagonist?.forms || []).map((f) => f.subjectId).filter(Boolean));
  const cast = direction.medium === 'procedural' ? []
    : fixedSupportingCast(project).filter((f) => !bound.has(f.id) && !drawn.has(castKey(f.name))).map((f) => f.name);
  return { changes: images.length || cast.length ? { images, cast } : null };
}

/** The stage as the director sees it. */
export async function getCastAndSets(projectId) {
  // The project read resolves the light check-in; the full one here reuses its catalog reads.
  const reads = createCatalogReads();
  const project = await requireProject(projectId, { catalogReads: reads });
  return { stage: presentStage(project), catalogCheckin: await resolveCatalogCheckin(project, { catalog: castAndSetsDeps.catalog, reads }) };
}

/** Recompute the offered repair under the project's serialized write. */
export async function repairShotReference(projectId, problemId) {
  const { project, sceneId, patch } = await mutateProjectRecord(projectId, async (current, { client } = {}) => {
    const checkin = await resolveCatalogCheckin(current, { catalog: castAndSetsDeps.catalog, client, includeRepairPatches: true });
    const problem = checkin.shotReferenceProblems.find(row => (row.id === problemId && row.patch) || row.omit?.id === problemId);
    if (!problem) throw new ServerError('This shot reference suggestion changed. Review the current check-in and try again.', {
      status: 409, code: 'MUSIC_VIDEO_SHOT_REFERENCE_STALE',
    });
    const { sceneId } = problem;
    const patch = problem.omit?.id === problemId ? problem.omit.patch : problem.patch;
    const scenes = current.scenes.map(scene => scene.sceneId === sceneId ? { ...scene, ...patch } : scene);
    return { project: { ...current, scenes, updatedAt: new Date().toISOString() }, sceneId, patch };
  }, { sceneOnly: true });
  return { sceneId, patch, updatedAt: project.updatedAt };
}

/**
 * Explicitly switch the current check-in without rewriting historical media. Shot
 * picks of generated sheets move to the same catalog images. Calling it again
 * moves any the catalog has since come to offer, including on a video switched
 * before picks moved at all.
 */
export async function useCatalogCheckin(projectId) {
  let moved = 0;
  const remap = (resolved) => {
    const remapped = remapCatalogShotReferences(resolved);
    moved = remapped.moved;
    return { project: remapped.project };
  };
  const out = await mutateProjectRecord(projectId, async (current, { client } = {}) => {
    // mutateProjectRecord already resolved this catalog project's check-in onto `current`.
    if (isCatalogCheckin(current)) return remap(current);
    const stage = current.castAndSets;
    if ((CAST_SETS_WORKING.includes(stage?.status) && stage.processId === PROCESS_ID) || Object.values(stage?.images || {}).some(image => image.status === 'queued' || image.edit?.status === 'queued')
      || (current.productionRuns || []).some(run => ['running', 'waiting'].includes(run.status))
      || (current.productionRuns || []).some(run => (run.steps || []).some(step => ['reserved', 'queued'].includes(step.status)))
      || current.autonomousRun?.status === 'running') {
      throw new ServerError('Stop active production and finish or cancel queued check-in work before switching to catalog links.', { status: 409, code: 'CAST_SETS_IN_PROGRESS' });
    }
    const now = new Date().toISOString();
    const switched = { ...current, castAndSets: { ...stage, source: 'catalog', status: 'review',
      revision: (stage?.revision || 0) + 1, catalogApprovedBasis: null, processId: null, productionRunId: null,
      createdAt: stage?.createdAt || now, updatedAt: now } };
    return remap(await withCatalogCheckin(switched, { catalog: castAndSetsDeps.catalog, client }));
  });
  if (moved) console.log(`🔁 Music Video Cast & Sets ${short(projectId)} moved ${moved} shot references to catalog images`);
  publish(projectId, out.project);
  return { project: out.project, stage: out.project.castAndSets, catalogCheckin: await resolveCatalogCheckin(out.project, { catalog: castAndSetsDeps.catalog }) };
}
