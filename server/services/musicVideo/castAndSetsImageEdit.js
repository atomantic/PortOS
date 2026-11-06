/** A preview edits one saved image; only an explicit accept replaces the stage image. */
import { CAST_SETS_MAX_KEY_NOTES, CAST_SETS_MAX_IMAGE_HISTORY } from './castAndSets.js';
import { randomUUID } from 'node:crypto';
import { buildCastSetsImageEditPrompt } from '../../lib/musicVideoCastSetsImageEdit.js';
import { isEditCapableMode, maxInputImages } from '../../lib/imageGenCapabilities.js';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { castSetsInspectionInputs, sameCastSetsInspectionInputs } from '../../lib/musicVideoCastSetsInspection.js';
import { mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { findProductionRun, reserveProductionStep, settleProductionStep } from './production.js';

const editError = (message) => new ServerError(message, { status: 409, code: 'CAST_SETS_EDIT_STALE' });
const editable = (stage) => stage && stage.source !== 'catalog' && !stage.feedbackRenderPlan && ['review', 'approved'].includes(stage.status);
const currentCandidate = (stage, key, id) => {
  const edit = stage?.images?.[key]?.edit;
  return edit?.requestId === id && stage.revision === edit.revision
    && sameCastSetsInspectionInputs(edit.inputs, castSetsInspectionInputs(stage, key)) ? edit : null;
};
const withEdit = (project, key, edit) => ({ ...project, castAndSets: { ...project.castAndSets,
  images: { ...project.castAndSets.images, [key]: { ...project.castAndSets.images[key], edit } } } });

async function prepareImageEdit(projectId, input, { getSettings, imageParams }) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  if (!editable(stage) || stage.revision !== input.revision || stage.images?.[input.key]?.imageId !== input.imageId
    || !castSetsInspectionInputs(stage, input.key)) throw editError('This image changed. Refresh the check-in before editing it.');
  if (!stage.route || !isEditCapableMode(stage.route.mode) || maxInputImages(stage.route.mode, stage.route.model) === 0) {
    throw new ServerError('This image renderer cannot edit an input image. Choose an image-edit renderer and rebuild the check-in.', { status: 409, code: 'CAST_SETS_EDIT_UNSUPPORTED' });
  }
  const path = resolveGalleryImage(input.imageId);
  if (!path) throw editError('The source image is missing. Restore it before editing.');
  const settings = await getSettings();
  const composed = buildCastSetsImageEditPrompt(input.instruction);
  const requestId = randomUUID();
  const params = await imageParams(settings, stage.route, { ...composed, width: 1536, height: 1024,
    initImagePath: path, initImageStrength: 0.15,
    musicVideo: { projectId, castAndSets: { key: input.key, revision: stage.revision, editRequestId: requestId } } });
  return { stage, settings, composed, requestId, params };
}

export async function previewCastSetsImageEdit(projectId, input, deps) {
  const { stage, settings, params } = await prepareImageEdit(projectId, input, deps);
  return deps.previewPrompt({ params, mode: stage.route.mode, settings });
}

export async function requestCastSetsImageEdit(projectId, input, deps) {
  const { processId, enqueue, publish } = deps;
  const { stage, settings, composed, requestId, params } = await prepareImageEdit(projectId, input, deps);
  const modelInput = await deps.previewPrompt({ params, mode: stage.route.mode, settings });
  const reserved = await mutateProjectRecord(projectId, (current) => {
    const live = current.castAndSets;
    if (!editable(live) || live.revision !== input.revision
      || !sameCastSetsInspectionInputs(castSetsInspectionInputs(stage, input.key), castSetsInspectionInputs(live, input.key))) throw editError('This image changed. Refresh the check-in before editing it.');
    if (live.images[input.key].edit?.status === 'queued' && live.images[input.key].edit.processId === processId) {
      throw editError('An edit of this image is already rendering. Discard it before requesting another.');
    }
    let next = current;
    let productionRunId = null;
    let productionStepKey = null;
    const run = live.productionRunId ? findProductionRun(current, live.productionRunId) : null;
    if (run?.status === 'running') {
      const reserved = reserveProductionStep(current, run.id, { kind: 'checkin', sceneId: input.key,
        revisionId: `image-edit:${requestId}`, route: { kind: 'image', ...live.route }, processId: run.processId });
      next = reserved.project;
      productionRunId = run.id;
      productionStepKey = reserved.step.key;
    }
    const edit = { requestId, processId, revision: live.revision, inputs: castSetsInspectionInputs(live, input.key),
      instruction: input.instruction, ...composed, modelInput, status: 'queued', jobId: null, imageId: null, error: null,
      productionRunId, productionStepKey };
    return { project: withEdit(next, input.key, edit), edit };
  });
  publish(projectId, reserved.project);
  const edit = reserved.edit;
  const sent = await enqueue({ kind: 'image', params: { ...params, musicVideo: { ...params.musicVideo,
    ...(edit.productionRunId ? { productionRunId: edit.productionRunId, productionStepKey: edit.productionStepKey } : {}) } },
    owner: `music-video-cast-sets:${projectId}` }).catch((error) => ({ error }));
  const out = await mutateProjectRecord(projectId, (current) => {
    let next = current;
    const failed = !!sent?.error || !sent?.jobId;
    if (edit.productionRunId) next = settleProductionStep(next, edit.productionRunId, edit.productionStepKey, {
      status: failed ? 'refused' : 'queued', jobId: sent?.jobId, error: failed ? 'The image edit was not queued' : null }).project;
    const candidate = currentCandidate(next.castAndSets, input.key, requestId);
    if (!candidate) return { project: next };
    return { project: withEdit(next, input.key, { ...candidate, jobId: sent?.jobId || candidate.jobId,
      ...(failed ? { status: 'failed', error: 'The image edit could not be queued. Try again.' } : {}) }) };
  });
  publish(projectId, out.project);
  return { project: out.project };
}

export async function settleCastSetsImageEdit({ projectId, key, editRequestId, jobId, filename, error, status, productionRunId, productionStepKey }, publish) {
  const out = await mutateProjectRecord(projectId, (current) => {
    if (current.castAndSets?.source === 'catalog') return { project: current, changed: false };
    const candidate = currentCandidate(current.castAndSets, key, editRequestId);
    const available = filename && resolveGalleryImage(filename);
    let next = current;
    const step = productionRunId ? (current.productionRuns || []).find((run) => run.id === productionRunId)?.steps?.find((step) => step.key === productionStepKey) : null;
    if (step?.kind === 'checkin' && step.sceneId === key && step.revisionId === `image-edit:${editRequestId}` && (!step.jobId || step.jobId === jobId)) {
      next = settleProductionStep(next, productionRunId, productionStepKey, {
        status: available ? 'completed' : status === 'canceled' ? 'canceled' : 'failed', jobId, error: error || (filename && !available ? 'Image edit output is missing' : null) }).project;
    }
    if (!candidate || candidate.status !== 'queued' || (candidate.jobId && candidate.jobId !== jobId)) return { project: next, changed: next !== current };
    return { project: withEdit(next, key, { ...candidate, jobId, status: available ? 'done' : 'failed', imageId: available ? filename : null,
      error: available ? null : 'The image edit failed or its output is missing. Try again.' }), changed: true };
  });
  if (out.changed) publish(projectId, out.project);
  return out.changed;
}

export async function discardCastSetsImageEdit(projectId, { key, requestId }, publish) {
  const out = await mutateProjectRecord(projectId, (current) => {
    if (current.castAndSets?.source === 'catalog') throw editError('Historical check-in images are read-only. Edit current catalog items in the catalog.');
    if (current.castAndSets?.images?.[key]?.edit?.requestId !== requestId) throw editError('This image edit changed. Refresh the check-in.');
    return { project: withEdit(current, key, null) };
  });
  publish(projectId, out.project);
  return { project: out.project };
}

export async function acceptCastSetsImageEdit(projectId, { key, requestId }, processId) {
  return mutateProjectRecord(projectId, (current) => {
    const stage = current.castAndSets;
    const edit = currentCandidate(stage, key, requestId);
    if (!editable(stage) || edit?.status !== 'done' || !resolveGalleryImage(edit.imageId)) throw editError('This edit or its source changed. Render and review a new edit.');
    const old = stage.images[key];
    const revision = stage.revision + 1;
    const image = { ...old, edit: null, imageId: edit.imageId, jobId: edit.jobId, status: 'done', error: null,
      inspection: null, inspectionAcknowledgement: null,
      history: [...(old.history || []).filter((id) => id !== old.imageId), old.imageId].slice(-CAST_SETS_MAX_IMAGE_HISTORY),
      submittedRevision: revision, submittedPrompt: edit.modelInput.sentPrompt, promptAdditions: edit.modelInput.promptAdditions || [], submittedPromptTruncated: false,
      submittedReferences: [{ kind: 'image', filename: old.imageId }], submittedReferencesTruncated: false };
    const next = { ...stage, revision, processId, status: 'imaging', manualImageEditReview: true,
      productionRunId: edit.productionRunId,
      approvedAt: null, approvedInputs: null, approvedValues: null,
      images: { ...stage.images, [key]: image },
      plan: { ...stage.plan, [key]: { ...stage.plan[key], prompt: `${stage.plan[key].prompt}\n\nAccepted image edit (overrides conflicting details): ${edit.instruction}` } },
      keyNotes: { ...stage.keyNotes, [key]: [...(stage.keyNotes?.[key] || []), edit.instruction].slice(-CAST_SETS_MAX_KEY_NOTES) },
      changeSummary: { revision, changes: [`Edited ${stage.plan[key].label || key} image`], rerendered: [key], at: new Date().toISOString() } };
    return { project: { ...current, castAndSets: next }, stage: next };
  });
}
