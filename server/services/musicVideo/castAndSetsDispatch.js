/**
 * Runs creative direction, dispatches dependent images, and assembles the check-in sheet.
 * All work starts from a director or production request, or from settlement of its queued jobs.
 * A stage pinned to a previous process dispatches nothing until it is resumed.
 */
import { isCatalogCheckin, resolveCatalogCheckin, assertCatalogCheckinReady, assertLegacyCheckin } from './catalogCheckin.js';
import { loadProjectMidiDigest } from './songMidiDigest.js';
import { settleCastSetsImageEdit } from './castAndSetsImageEdit.js';
import { musicVideoAllowsMedia, assertMusicVideoMediaSelections } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { castAndSetsStoryInputs, directorArtGuides, productionFeedbackContext, selectArtGuideIfNone } from './productionReview.js';
import { withMusicVideoStyle } from './styleReferences.js';
import { CAST_SETS_PROCESS_ID as PROCESS_ID } from './processPins.js';
import { castSetsInspectionInputs, currentCastSetsInspection, castSetsInspectionBlockers, sameCastSetsInspectionInputs } from '../../lib/musicVideo/musicVideoCastSetsInspection.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import { FACE_SHEET_ANGLE_TEMPLATE } from '../../lib/faceSheetAngleTemplate.js';
import { atomicWrite } from '../../lib/fileCore.js';
import { basename, extname } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { QUEUEABLE_IMAGE_MODES } from '../../lib/generationModes.js';
import { resolveGalleryImage, resolveImageRef, resolveTemplateAsset } from '../../lib/pathSafety.js';
import { musicVideoReferenceCapacity } from '../../lib/musicVideo/musicVideoConditioning.js';
import { mediaRecoveryPending } from '../../lib/mediaRecoveryActivity.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { trimTo } from '../../lib/textUtils.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { requireProject } from './requireProject.js';
import { musicVideoEvents } from './events.js';
import { effortArg, recordLlmRoute, resolveMusicVideoLlm } from './llmRoute.js';
import {
  CAST_SETS_MAX_KEY_NOTES,
  allCastAndSetsImagesDone,
  castAndSetsCheckinMode,
  dispatchableImageKeys,
  linkCastAndSetsJob,
  matchesCastAndSetsStage,
  presentCastAndSets,
  releaseCastAndSetsImage,
  reserveCastAndSetsImage,
  resumeCastAndSetsOnProject,
  setCastAndSetsDirection,
  setCastAndSetsStatus,
  settleCastAndSetsImage,
  startCastAndSetsOnProject,
} from './castAndSets.js';
import {
  buildCastAndSetsPrompt,
  castAndSetsAllowsImages,
  castAndSetsMedium,
  describeDirectionChanges,
  fixedSupportingCast,
  fixedProps,
  withCheckedFormSubjects,
  mergeCastAndSetsDirection,
  moodBoardImageList,
  parseCastAndSetsResponse,
  songSections,
} from './castAndSetsDirection.js';
import {
  CAST_SETS_IMAGE_SIZE,
  affectedImageKeys,
  buildCastAndSetsImagePlan,
  noteImageKeys,
} from './castAndSetsPlan.js';
import { renderCastAndSetsSheet } from './castAndSetsSheet.js';
import { catalogSheetImageFiles, renderCatalogCastAndSetsSheet } from './castAndSetsCatalogSheet.js';
import { loadCastAndSetsCatalogLikeness } from './castAndSetsCatalogLikeness.js';
import { findProductionRun, haltProduction, reserveProductionStep, settleProductionStep } from './production.js';
import { getSettings } from '../settings.js';
import { getTrack } from '../tracks/index.js';
import { approveCastAndSetsCheckin, publish, short } from './castAndSetsApproval.js';

const MAX_SUBMITTED_PROMPT = 20_000;

const MAX_SUBMITTED_REFERENCES = 16;

// Test seam: provider, queue, settings and mood-board access are swappable.
const defaults = {
  syncCatalogImage: async (projectId, key) => (await import('./catalogCast.js')).syncCheckinImageToCatalog(projectId, key),
  previewPrompt: async (opts) => (await import('../imageGen/promptPreview.js')).previewQuickImageEdit(opts),
  resolveReviewer: async (opts) => (await import('./plateReview.js')).resolvePlateReviewer(opts),
  reviewImage: async (opts) => (await import('./castAndSetsInspection.js')).reviewCastSetsImage(opts),
  resolveProvider: async (opts) => resolveMusicVideoLlm(opts),
  runPrompt: async (opts) => (await import('../promptRunner.js')).runPromptThroughProvider(opts),
  getSettings: async () => getSettings(),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  queueSnapshot: async (jobId, { projectId, key, revision, createdAt } = {}) => {
    const queue = await import('../mediaJobQueue/index.js');
    const matches = jobId ? [] : queue.listJobs({ kind: 'image', owner: `music-video-cast-sets:${projectId}` }).filter((job) => {
      const tag = job.params?.musicVideo;
      return tag?.projectId === projectId && tag?.castAndSets?.key === key && tag?.castAndSets?.revision === revision
        && (tag.castAndSets.createdAt == null || tag.castAndSets.createdAt === createdAt) && !tag.castAndSets.editRequestId;
    });
    return { ...queue.getMediaRecoveryActivity(), job: jobId ? queue.getJob(jobId) : null, matches };
  },
  loadBoard: async (id) => (await import('../moodBoard/index.js')).getBoard(id),
  boardItemImage: async () => (await import('../moodBoard/logic.js')).boardItemLocalImage,
  loadTrack: async (id) => getTrack(id),
  sheetImage: (path) => sheetImage(path),
  imageParams: (settings, route, common) => imageJobParams(settings, route, common),
  resolveRoute: null,
  // getIngredient/listMediaForIngredient; null = the live catalog.
  catalog: null,
};

export let castAndSetsDeps = { ...defaults };

export function __setCastAndSetsDepsForTests(overrides) { castAndSetsDeps = { ...defaults, ...overrides }; }

/** Reconcile terminal queue jobs whose check-in hook has not settled them. */
async function reconcileOldCastSetsJobs(projectId) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  if (!stage || (stage.processId === PROCESS_ID && stage.status !== 'failed')) return;
  for (const [key, image] of Object.entries(stage.images || {})) {
    if (image.status !== 'queued' || (!image.jobId && stage.processId === PROCESS_ID)) continue;
    const snapshot = await castAndSetsDeps.queueSnapshot(image.jobId, { projectId, key, revision: stage.revision, createdAt: stage.createdAt });
    const matches = image.jobId ? [] : (snapshot.matches || []);
    if (!snapshot.trusted || (!snapshot.job && !matches.length && snapshot.pending)) throw new ServerError('The media queue is still recovering. Check queued images again when it is ready.', { status: 409, code: 'CAST_SETS_QUEUE_UNAVAILABLE' });
    if (matches.length > 1 && matches.some((job) => !['completed', 'failed', 'canceled'].includes(job.status) || mediaRecoveryPending(job))) {
      throw new ServerError('Several previous image jobs match this slot and at least one is still active. Wait for them to finish.', { status: 409, code: 'CAST_SETS_JOBS_IN_FLIGHT' });
    }
    const job = image.jobId ? snapshot.job : matches.length === 1 ? matches[0] : null;
    if (job && (!['completed', 'failed', 'canceled'].includes(job.status) || mediaRecoveryPending(job))) {
      if (!image.jobId) throw new ServerError('A previous image job for this slot is still active. Wait for it to finish.', { status: 409, code: 'CAST_SETS_JOBS_IN_FLIGHT' });
      continue;
    }
    const tag = job?.params?.musicVideo;
    const tagMatches = tag?.projectId === projectId && tag?.castAndSets?.key === key && tag?.castAndSets?.revision === stage.revision
      && (tag.castAndSets.createdAt == null || tag.castAndSets.createdAt === stage.createdAt);
    const filename = tagMatches && job.status === 'completed' && resolveGalleryImage(job.result?.filename) ? job.result.filename : null;
    const error = tagMatches ? (job.error || 'The previous image job ended without a recoverable image')
      : snapshot.matches?.length > 1 ? 'Several previous image jobs matched this slot; review them before retrying' : 'The previous image job is no longer in the queue history';
    const runKnown = tagMatches && (project.productionRuns || []).some((run) => run.id === tag.productionRunId);
    await onCastAndSetsImageSettled({ projectId, key, revision: stage.revision, createdAt: stage.createdAt, jobId: image.jobId || job?.id || null, filename, error,
      status: job?.status, ...(runKnown ? { productionRunId: tag.productionRunId, productionStepKey: tag.productionStepKey } : {}) });
  }
}

const skippedWrite = (project) => ({ project, skipPersist: true });

const ownsStage = (project, stage) => matchesCastAndSetsStage(project?.castAndSets, stage);

async function fail(projectId, stage, reason, error = null) {
  const out = await mutateProjectRecord(projectId, (current) => ownsStage(current, stage)
    ? setCastAndSetsStatus(refundUnusedCheckinSteps(current), 'failed', { reason, error, extra: { failedFromStatus: stage.status } })
    : skippedWrite(current));
  if (out.skipPersist) return;
  console.error(`❌ Music Video Cast & Sets ${short(projectId)} failed: ${reason}`);
  publish(projectId, out.project);
  return out;
}

/**
 * The image route: a production run's pool route when one is given; otherwise
 * Codex when the brief allows it (or names no image tool) and it is enabled,
 * then the brief's other queueable image tools in catalog order, then the
 * install's Music Video render default. Returns `{ mode, model }` or null.
 */
async function chooseCastAndSetsRoute(project, { preferred = null, settings } = {}) {
  if (castAndSetsDeps.resolveRoute) return castAndSetsDeps.resolveRoute(project, { preferred, settings });
  const { resolveRenderTargetConfig } = await import('../imageGen/cloudProviderConfig.js');
  // A mode is usable when it rides the queue and, for a cloud backend, its
  // opt-in toggle is on (the same resolver the dispatch itself goes through).
  const usable = (mode) => {
    if (!QUEUEABLE_IMAGE_MODES.includes(mode)) return false;
    const resolved = resolveRenderTargetConfig(settings, RENDER_TARGET.MUSIC_VIDEO, { mode });
    return resolved.mode === mode && (!resolved.cloud || resolved.cloud.enabled);
  };
  if (preferred?.mode) return usable(preferred.mode) ? { mode: preferred.mode, model: preferred.model || null } : null;
  const tools = (project?.automation?.tools || []).filter((t) => t.startsWith('image:')).map((t) => t.slice('image:'.length));
  const candidates = tools.length ? tools : ['codex'];
  if (candidates.includes('codex') && usable('codex')) return { mode: 'codex', model: null };
  const listed = candidates.find((mode) => mode !== 'codex' && usable(mode));
  if (listed) return { mode: listed, model: null };
  if (tools.length) return null;
  const resolved = resolveRenderTargetConfig(settings, RENDER_TARGET.MUSIC_VIDEO, {});
  return usable(resolved.mode) ? { mode: resolved.mode, model: null } : null;
}

async function loadContext(project) {
  assertMusicVideoMediaSelections(project);
  const boardId = project?.visualSpec?.moodBoardId;
  const board = boardId ? await castAndSetsDeps.loadBoard(boardId).catch(() => null) : null;
  const resolveItem = board ? await castAndSetsDeps.boardItemImage() : null;
  const moodImages = board ? moodBoardImageList(board, resolveItem) : [];
  const track = project?.trackId ? await castAndSetsDeps.loadTrack(project.trackId).catch(() => null) : null;
  return { board, moodImages, track };
}

/**
 * Run the direction call for the stage's current revision and write the image
 * plan. `notes` (a revision) are sent with the current direction; `forceKeys`
 * are image keys the director flagged directly.
 */
export async function runDirection(projectId, expected, { providerId, model, effort, notes = [], forceKeys = [] } = {}) {
  const project = await requireProject(projectId);
  if (!ownsStage(project, expected)) return;
  const stage = project.castAndSets;
  const { board, moodImages, track } = await loadContext(project);
  // Request pin > the brief's Cast & Sets pin > its direction LLM > an eligible TUI provider > the active one (llmRoute.js).
  const { provider, selectedModel, route } = await castAndSetsDeps.resolveProvider({ providerId, model, effort, automation: project.automation, stage: 'castAndSets' }).catch(() => ({ provider: null }));
  if (!provider) return fail(projectId, expected, 'No AI provider is available for the creative direction');
  if (provider.enabled === false) return fail(projectId, expected, `The ${provider.name || provider.id} provider is disabled`);
  const previous = stage?.direction || null;
  // A revision keeps the medium it was directed in; a fresh pass resolves it
  // from the project's policy and tools, so a saved direction is never
  // silently re-cast into the other medium.
  // A saved direction without a medium predates the procedural one: photographic.
  const medium = notes.length && previous ? (previous.medium || 'photographic') : castAndSetsMedium(project);
  // Standing sheet feedback rides on every direction call, a fresh rebuild included.
  const feedback = stage?.feedback || [];
  const standing = feedback.length > 0;
  const prompt = buildCastAndSetsPrompt(project, { moodImages, board, track, previous: notes.length ? previous : null, notes, medium, feedback, guides: directorArtGuides(project), midi: await loadProjectMidiDigest(project) }) + productionFeedbackContext(project);
  if (!ownsStage(await requireProject(projectId), expected)) return;
  let text;
  try {
    ({ text } = await castAndSetsDeps.runPrompt({ provider, model: selectedModel, ...effortArg(route), prompt, source: 'music-video-cast-sets' }));
  } catch (err) {
    return fail(projectId, expected, 'The creative direction call failed', err.message);
  }
  await recordLlmRoute(projectId, 'castAndSets', route, (current) => ownsStage(current, expected));
  const parsed = parseCastAndSetsResponse(text);
  if (!parsed) return fail(projectId, expected, 'The creative direction answer had no usable JSON');
  const sections = songSections(project);
  const merged = mergeCastAndSetsDirection(notes.length ? previous : null, parsed, { sections, medium, fixedCast: fixedSupportingCast(project), fixedProps: fixedProps(project) });
  if (merged.missing.length) return fail(projectId, expected, `The creative direction answer is missing: ${merged.missing.join(', ')}`);
  const direction = withCheckedFormSubjects(project, merged.direction, notes.length ? previous : null);
  // The scene look set plates and in-set frames carry. While the director's sheet feedback
  // stands, the look line rewritten to agree with it wins; otherwise the
  // director's palette/light/texture line, else the project's visual style.
  // Never the board's composed style verbatim: it can describe a whole person
  // and scene, which then lands in every empty set plate.
  direction.look = (standing && (parsed.look || previous?.look)) || direction.look || trimTo(project.concept?.style, 500) || '';
  // Mood board images inform the direction as text only, never as image references.
  return writePlan(projectId, expected, { direction, forceKeys, changes: previous ? describeDirectionChanges(previous, direction) : null, directedInputs: castAndSetsStoryInputs(project) });
}

/**
 * A direction saved before the look was written by the director copied the
 * mood board's composed style prompt verbatim (people and places included);
 * such a look falls back to the project's visual style.
 */
async function withoutBoardLook(project, direction) {
  const boardId = project?.visualSpec?.moodBoardId;
  if (!direction?.look || !boardId) return direction;
  const board = await castAndSetsDeps.loadBoard(boardId).catch(() => null);
  const boardLook = trimTo(board?.style?.prompt, 500);
  return boardLook && direction.look === boardLook ? { ...direction, look: trimTo(project.concept?.style, 500) || '' } : direction;
}

/**
 * The image plan `direction` gets from the project as it is now, with the
 * linked Casting records' current images. A procedural project whose brief
 * names no image tool is code-only: nothing is rendered, so no image backend
 * is needed (or consulted).
 */
export async function currentImagePlan(project, direction) {
  const codeOnly = !musicVideoAllowsMedia(project, 'image') || direction.medium === 'procedural' && !castAndSetsAllowsImages(project);
  if (codeOnly) return { codeOnly, plan: {} };
  const { loadMusicVideoGreybox } = await import('./greyboxReferences.js');
  const greyboxes = Object.fromEntries(await Promise.all((direction.sets || []).filter((s) => s.setReference?.greyboxShotId).map(async (set) => [set.id, await loadMusicVideoGreybox(project, { sceneId: `set:${set.id}`, setReference: set.setReference })])));
  const catalogLikeness = await loadCastAndSetsCatalogLikeness(project, { catalog: castAndSetsDeps.catalog });
  const plan = buildCastAndSetsImagePlan(project, direction, { revisionNotes: keyNotesText(project.castAndSets?.keyNotes), greyboxes, catalogLikeness });
  // Planned cards are published before their dependent renders can start.
  if (Object.values(plan).some((item) => item.refTemplates?.includes(FACE_SHEET_ANGLE_TEMPLATE))) await ensureFaceSheetTemplate();
  return { codeOnly, plan };
}

/** (Re)build the plan from the stage's direction + accumulated per-image notes, then dispatch. */
export async function writePlan(projectId, expected, { direction = null, forceKeys = [], changes = null, directedInputs = null } = {}) {
  const project = await requireProject(projectId);
  if (!ownsStage(project, expected)) return;
  const stage = project.castAndSets;
  const nextDirection = await withoutBoardLook(project, direction || stage.direction);
  const { codeOnly, plan } = await currentImagePlan(project, nextDirection);
  // A later feedback edit must retain images still waiting from an earlier one.
  const renderKeys = affectedImageKeys(stage.plan || {}, plan, [...(stage.feedbackRenderPlan?.keys || []), ...forceKeys]);
  const settings = await castAndSetsDeps.getSettings();
  const run = stage.productionRunId ? (project.productionRuns || []).find((r) => r.id === stage.productionRunId) : null;
  const preferred = run?.pool?.find((r) => r.kind === 'image') || stage.route || null;
  const route = codeOnly ? (stage.route || null) : await chooseCastAndSetsRoute(project, { preferred, settings });
  if (!route && !codeOnly && !stage.feedbackRenderPlan) return fail(projectId, expected, 'No enabled image backend is allowed for the Cast & Sets images — enable Codex (or another image tool in the brief) and resume');
  const out = await mutateProjectRecord(projectId, (current) => {
    if (!ownsStage(current, expected)) return skippedWrite(current);
    const next = setCastAndSetsDirection(current, { direction: nextDirection, plan, route, renderKeys });
    const savedStage = { ...next.stage, greyboxPending: false, greyboxPendingSetIds: [], greyboxLegacyPendingSetIds: [],
      ...(directedInputs ? { directedInputs } : {}),
      ...(changes ? { changeSummary: { revision: next.stage.revision, changes, ...(next.stage.feedbackRenderPlan ? { planned: renderKeys.length } : { rerendered: renderKeys.length }), at: next.stage.updatedAt } } : {}),
      ...(next.stage.feedbackRenderPlan ? { status: 'review', route: codeOnly ? next.stage.route : route, feedbackRenderPlan: { ...next.stage.feedbackRenderPlan, phase: 'ready', keys: renderKeys } } : {}),
    };
    return { project: { ...next.project, castAndSets: savedStage }, stage: savedStage };
  });
  if (out.skipPersist) return;
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} r${out.stage.revision}: ${renderKeys.length} image(s) to render${route ? ` on ${route.mode}` : ' (code-only, no image backend)'}`);
  publish(projectId, out.project);
  if (out.stage.feedbackRenderPlan) return out;
  return advance(projectId, out.stage);
}

export const keyNotesText = (keyNotes = {}) => Object.fromEntries(Object.entries(keyNotes).map(([k, list]) => [k, list.join('; ')]));

async function ensureFaceSheetTemplate() {
  const path = resolveTemplateAsset(FACE_SHEET_ANGLE_TEMPLATE, { mustExist: false });
  if (!existsSync(path)) {
    await atomicWrite(path, await readFile(new URL(`../../../data.reference/templates/${FACE_SHEET_ANGLE_TEMPLATE}`, import.meta.url)));
  }
  return path;
}

async function referencePaths(stage, item) {
  const paths = [];
  // Only the shipped layout is admissible here; plan data never selects a host path.
  if (item.refTemplates?.includes(FACE_SHEET_ANGLE_TEMPLATE)) paths.push(await ensureFaceSheetTemplate());
  for (const key of item.refKeys || []) {
    const id = stage.images?.[key]?.imageId;
    const path = id ? resolveGalleryImage(id, { mustExist: false }) : null;
    if (path) paths.push(path);
  }
  // Casting images can live in the gallery or in image-refs uploads; one
  // whose file is gone is skipped so the next reference takes its slot.
  for (const id of item.refImages || []) {
    const path = resolveGalleryImage(id) || resolveImageRef(id);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Job params for one image on the stage's route (cloud provider bag or the local model). */
export async function imageJobParams(settings, route, common) {
  const [{ resolveRenderTargetConfig }, { resolveImageCleaners }, { resolveLocalImageModel }] = await Promise.all([
    import('../imageGen/cloudProviderConfig.js'),
    import('../../lib/imageCleanDefaults.js'),
    import('../imageGen/prepareParams.js'),
  ]);
  const resolved = resolveRenderTargetConfig(settings, RENDER_TARGET.MUSIC_VIDEO, { mode: route.mode, model: route.model });
  // Never substitute another backend for the one the stage chose.
  if (resolved.mode !== route.mode) throw new ServerError(`The ${route.mode} image backend is not available`, { status: 409, code: 'CAST_SETS_ROUTE_UNAVAILABLE' });
  if (resolved.cloud && !resolved.cloud.enabled) throw resolved.cloud.disabledError;
  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, route.mode);
  const local = resolved.cloud ? null : resolveLocalImageModel(settings, { modelId: route.model || undefined });
  const capacity = musicVideoReferenceCapacity(route.mode, { modelId: resolved.cloud?.modelId || route.model, localModel: local?.selectedModel });
  if (common.referenceImagePaths?.length && !capacity) throw new ServerError('The selected image renderer cannot use the Cast & Sets reference images', { status: 409, code: 'CAST_SETS_ROUTE_INELIGIBLE' });
  const referenceImagePaths = common.referenceImagePaths?.slice(0, capacity);
  const referenceImageStrengths = common.referenceImageStrengths?.slice(0, capacity);
  const params = { ...common, ...(referenceImagePaths ? { referenceImagePaths } : {}), ...(referenceImageStrengths ? { referenceImageStrengths } : {}), cleanC2PA, denoise };
  if (resolved.cloud) return { ...resolved.cloud.jobParams, ...params };
  return { ...params, pythonPath: local.pythonPath, ...(local.selectedModel?.id ? { modelId: local.selectedModel.id } : {}) };
}

async function prepareImage(project, stage, key) {
  const item = stage.plan[key];
  const referenceImagePaths = await referencePaths(stage, item);
  if (item.setReference?.greyboxShotId) {
    const { loadMusicVideoGreybox } = await import('./greyboxReferences.js');
    const greybox = await loadMusicVideoGreybox(project, { sceneId: key, setReference: item.setReference });
    if (greybox.reference.imageId !== item.refImages?.[0]) throw new ServerError('The greybox capture changed. Regenerate the set plan.', { status: 409, code: 'CAST_SETS_GREYBOX_CHANGED' });
    referenceImagePaths[0] = greybox.path;
  }
  const common = {
    prompt: item.prompt,
    width: CAST_SETS_IMAGE_SIZE.width,
    height: CAST_SETS_IMAGE_SIZE.height,
    ...(referenceImagePaths.length ? { referenceImagePaths, referenceImageStrengths: referenceImagePaths.map(() => 1) } : {}),
    // The completion hook files the result by this tag. No `sceneId`, so the
    // scene-frame hook ignores the job.
    musicVideo: {
      projectId: project.id, castAndSets: { key, revision: stage.revision, createdAt: stage.createdAt },
      ...(stage.productionRunId ? {
        productionRunId: stage.productionRunId,
        productionStepKey: checkinStep(project, stage, key)?.key,
      } : {}),
    },
  };
  const settings = await castAndSetsDeps.getSettings();
  const baseParams = await castAndSetsDeps.imageParams(settings, stage.route, common);
  if (item.refTemplates?.includes(FACE_SHEET_ANGLE_TEMPLATE)) {
    const identityId = stage.images?.[item.refKeys?.[0]]?.imageId;
    const identityPath = identityId ? resolveGalleryImage(identityId, { mustExist: false }) : null;
    const sent = baseParams.referenceImagePaths || [];
    if (!identityPath || !sent.includes(identityPath) || !sent.includes(referenceImagePaths[0])) {
      throw new ServerError('Face sheets require a renderer that can send both the angle guide and the character reference',
        { status: 409, code: 'CAST_SETS_ROUTE_INELIGIBLE' });
    }
  }
  const params = await withMusicVideoStyle(project, baseParams, stage.route.mode, stage.route.model, settings);
  // Persist the actual styled queue input, with only served local references.
  // Never expose the absolute host paths used by the provider transport.
  const submittedReferences = (params.referenceImagePaths || []).flatMap((path) => {
    if (typeof path !== 'string') return [];
    const filename = basename(path);
    if (resolveGalleryImage(filename, { mustExist: false }) === path) return [{ kind: 'image', filename }];
    if (resolveImageRef(filename, { mustExist: false }) === path) return [{ kind: 'image-ref', filename }];
    if (resolveTemplateAsset(filename, { mustExist: false }) === path) return [{ kind: 'template', filename }];
    return [];
  });
  const prompt = String(params.prompt || '');
  const submission = {
    submittedPrompt: prompt.slice(0, MAX_SUBMITTED_PROMPT),
    submittedPromptTruncated: prompt.length > MAX_SUBMITTED_PROMPT,
    submittedReferences: submittedReferences.slice(0, MAX_SUBMITTED_REFERENCES),
    submittedReferencesTruncated: submittedReferences.length > MAX_SUBMITTED_REFERENCES,
    submittedRevision: stage.revision,
  };
  return { job: { kind: 'image', params, owner: `music-video-cast-sets:${project.id}` }, submission };
}

// Check-in slots use the existing production ledger; the revision separates
// regenerated images and a terminal attempt permits a charged retry.
function checkinStep(project, stage, key) {
  const run = findProductionRun(project, stage.productionRunId);
  return run.steps.findLast((step) => step.kind === 'checkin'
    && step.sceneId === key && step.revisionId === String(stage.revision));
}

// Images never submitted must not remain charged after the check-in ends.
export function refundUnusedCheckinSteps(project) {
  const stage = project.castAndSets;
  const runId = stage?.productionRunId;
  if (!runId) return project;
  const run = (project.productionRuns || []).find((item) => item.id === runId);
  if (!run) return project;
  let next = project;
  for (const step of run.steps) {
    if (step.kind === 'checkin' && step.revisionId === String(stage.revision) && step.status === 'reserved'
      && stage.images?.[step.sceneId]?.status !== 'queued') {
      next = settleProductionStep(next, runId, step.key, {
        status: 'refused', error: 'The check-in stopped before this image was submitted',
      }).project;
    }
  }
  return next;
}

/** Reserve the WHOLE pending plan in one write before any job can be queued. */
async function reserveCheckinPlan(projectId, expected) {
  return mutateProjectRecord(projectId, (current) => {
    if (!ownsStage(current, expected)) return skippedWrite(current);
    const stage = current.castAndSets;
    const run = findProductionRun(current, stage.productionRunId);
    if (run.status !== 'running') return skippedWrite(current);
    let next = current;
    for (const [key, image] of Object.entries(stage.images)) {
      if (image.status !== 'pending') continue;
      const step = checkinStep(next, stage, key);
      if (step?.status === 'reserved') continue;
      next = reserveProductionStep(next, run.id, {
        kind: 'checkin', sceneId: key, revisionId: String(stage.revision),
        route: { kind: 'image', ...stage.route }, processId: run.processId,
      }).project;
    }
    return { project: next };
  });
}

async function dispatchKey(project, stage, key) {
  const projectId = project.id;
  const prepared = await prepareImage(project, stage, key).catch((error) => ({ error }));
  const reserved = await mutateProjectRecord(projectId, (current) => {
    const live = current.castAndSets;
    if (!ownsStage(current, stage) || live.images[key]?.status !== 'pending'
      || !live.plan[key]?.deps.every((dep) => live.images[dep]?.status === 'done')) return skippedWrite(current);
    if (live.productionRunId) {
      const run = findProductionRun(current, live.productionRunId);
      if (run.status !== 'running' || checkinStep(current, live, key)?.status !== 'reserved') return skippedWrite(current);
    }
    return reserveCastAndSetsImage(current, key, { processId: PROCESS_ID });
  });
  if (reserved.skipPersist) return;
  const productionStep = reserved.stage.productionRunId ? checkinStep(reserved.project, reserved.stage, key) : null;
  const runId = reserved.stage.productionRunId;
  // The slot is durable before submission. Start admission under the same
  // record lock as skip/rebuild, then release it while the queue persists.
  const sent = prepared.error ? prepared : await mutateProjectRecord(projectId, (current) => {
    const live = current.castAndSets;
    if (!ownsStage(current, stage) || live.images[key]?.status !== 'queued'
      || (runId && findProductionRun(current, runId).status !== 'running')) return skippedWrite(current);
    return { ...skippedWrite(current), admission: castAndSetsDeps.enqueue(prepared.job).catch((error) => ({ error })) };
  }).then((out) => out.admission);
  if (sent?.error || !sent?.jobId) {
    const reason = sent?.error?.message || 'The image job was not queued';
    const out = await mutateProjectRecord(projectId, (current) => {
      const next = productionStep ? settleProductionStep(current, runId, productionStep.key, { status: 'refused', error: reason }).project : current;
      if (!ownsStage(current, stage)) return next === current ? skippedWrite(current) : { project: next };
      // This route cannot carry the required inputs, so retrying it cannot
      // succeed and may otherwise leave the final pending key without a wakeup.
      const retryable = sent?.error?.code !== 'CAST_SETS_ROUTE_INELIGIBLE';
      const settled = settleCastAndSetsImage(next, key, { error: reason, revision: reserved.stage.revision, retryable });
      if (settled.stage?.status === 'failed') settled.project = refundUnusedCheckinSteps(settled.project);
      return settled;
    });
    if (out.skipPersist) return;
    if (out.changed) console.warn(`⚠️ Music Video Cast & Sets ${short(projectId)} ${key} refused: ${reason}`);
    publish(projectId, out.project);
    // No completion event follows a refusal. Wake another pass for this stage.
    return out.changed && ownsStage(out.project, stage) && out.stage.images?.[key]?.status === 'pending';
  }
  const linked = await mutateProjectRecord(projectId, (current) => {
    const next = productionStep ? settleProductionStep(current, runId, productionStep.key, { status: 'queued', jobId: sent.jobId }).project : current;
    const image = current.castAndSets?.images?.[key];
    if (!ownsStage(current, stage) || (image?.status !== 'queued' && image?.jobId !== sent.jobId)) {
      return next === current ? skippedWrite(current) : { project: next };
    }
    return linkCastAndSetsJob(next, key, sent.jobId, prepared.submission);
  });
  if (linked.skipPersist) return;
  publish(projectId, linked.project);
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} ${key} → ${reserved.stage.route.mode} job ${String(sent.jobId).slice(0, 8)}`);
}

const advancing = new Map();

const backgroundWork = new Set();

/** Drain owned work before a test replaces its queue/provider/store fixtures. */
export async function __settleCastAndSetsForTests() {
  while (backgroundWork.size || advancing.size) {
    await Promise.allSettled([...backgroundWork, ...[...advancing.values()].map(entry => entry.promise)]);
  }
}

/**
 * Dispatch every image whose inputs are ready; assemble the sheet once every
 * image is done. Concurrent calls for one project coalesce.
 */
export function advance(projectId, stage) {
  const live = advancing.get(projectId);
  if (live) {
    if (!live.pending.some((queued) => matchesCastAndSetsStage(queued, stage))) live.pending.push(stage);
    return live.promise;
  }
  const entry = { pending: [stage], promise: null };
  entry.promise = (async () => {
    try {
      while (entry.pending.length) {
        const expected = entry.pending.shift();
        const retry = await withFailure('The image advance', projectId, expected, () => advanceOnce(projectId, expected));
        if (retry && !entry.pending.some((queued) => matchesCastAndSetsStage(queued, expected))) entry.pending.push(expected);
      }
    } finally {
      advancing.delete(projectId);
    }
  })();
  advancing.set(projectId, entry);
  return entry.promise;
}

// What the check-in asks the budget for, so a refusal names the cast it would cover.
function checkinPlanSize(stage) {
  const pending = Object.entries(stage.images || {}).filter(([, image]) => image.status === 'pending').map(([key]) => key);
  const cast = pending.filter((key) => key.startsWith('cast:')).length;
  return `The Cast & Sets check-in needs ${pending.length} image${pending.length === 1 ? '' : 's'}${cast ? `, ${cast} of them supporting cast sheets` : ''}`;
}

// Retakes keep the revision and only replace the flagged key, not its dependents.
async function retryInspectedImage(projectId, expected, { key, inputs, inspectionId, note }) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  const eligible = (current) => ownsStage(current, expected)
    && !current.castAndSets.manualImageEditReview
    && current.castAndSets.productionRunId === stage.productionRunId && stage.productionRunId
    && current.castAndSets.images[key]?.renderQualityRetry?.revision !== stage.revision
    && currentCastSetsInspection(current.castAndSets, key)?.id === inspectionId
    && sameCastSetsInspectionInputs(inputs, castSetsInspectionInputs(current.castAndSets, key));
  if (!eligible(project)) return;
  const keyNotes = { ...stage.keyNotes, [key]: [...(stage.keyNotes?.[key] || []), note].slice(-CAST_SETS_MAX_KEY_NOTES) };
  const { plan } = await currentImagePlan({ ...project, castAndSets: { ...stage, keyNotes } }, stage.direction);
  const out = await mutateProjectRecord(projectId, (current) => {
    if (!eligible(current)) return skippedWrite(current);
    const run = findProductionRun(current, stage.productionRunId);
    if (run.status !== 'running') return { project: current, changed: false };
    const live = current.castAndSets;
    return { project: { ...current, castAndSets: { ...live,
      keyNotes: { ...live.keyNotes, [key]: keyNotes[key] },
      plan: { ...live.plan, [key]: plan[key] },
      images: { ...live.images, [key]: { ...live.images[key], status: 'pending', jobId: null,
        renderQualityRetry: { revision: stage.revision, jobId: inputs.jobId },
        inspectionAcknowledgement: null, failures: 0, error: null } },
    } }, changed: true };
  });
  if (out.changed) publish(projectId, out.project);
}

async function advanceOnce(projectId, expected) {
  let project = await requireProject(projectId);
  let stage = project.castAndSets;
  if (!ownsStage(project, expected) || stage.feedbackRenderPlan || stage.processId !== PROCESS_ID || stage.status !== 'imaging') return;
  if (allCastAndSetsImagesDone(stage)) {
    const { inspectCastAndSetsImages } = await import('./castAndSetsInspection.js');
    await inspectCastAndSetsImages(projectId, { stage: expected, resolveReviewer: castAndSetsDeps.resolveReviewer, reviewImage: castAndSetsDeps.reviewImage, publish, retryImage: (opts) => retryInspectedImage(projectId, expected, opts) });
    const fresh = await requireProject(projectId);
    if (!ownsStage(fresh, expected)) return;
    if (allCastAndSetsImagesDone(fresh.castAndSets)) {
      await assemble(projectId, expected);
      return;
    }
    project = fresh;
    stage = fresh.castAndSets;
  }
  if (stage.productionRunId) {
    const run = findProductionRun(project, stage.productionRunId);
    if (run.status !== 'running') return;
    const reserved = await reserveCheckinPlan(projectId, expected).catch((error) => ({ error }));
    if (reserved.skipPersist) return;
    if (reserved.error) {
      const limit = ['PRODUCTION_SPEND_LIMIT', 'PRODUCTION_BUDGET_EXHAUSTED'].includes(reserved.error.code);
      const reason = limit ? `${checkinPlanSize(stage)}: ${reserved.error.message}. Raise the run's limit and resume.` : reserved.error.message;
      const out = await mutateProjectRecord(projectId, (current) => {
        if (!ownsStage(current, expected) || findProductionRun(current, stage.productionRunId).status !== 'running') return skippedWrite(current);
        const failed = setCastAndSetsStatus(refundUnusedCheckinSteps(current), 'failed', { reason });
        return haltProduction(failed.project, stage.productionRunId, {
          status: limit ? 'limit-reached' : 'blocked', reason,
        });
      });
      if (out.skipPersist) return;
      musicVideoEvents.emit('production', { projectId, runId: out.run.id, run: out.run, action: { type: 'idle' }, project: out.project });
      publish(projectId, out.project);
      return;
    }
    project = reserved.project;
    stage = project.castAndSets;
  }
  const keys = dispatchableImageKeys(stage);
  let retry = false;
  for (const key of keys) {
    if (await dispatchKey(project, stage, key)) retry = true;
  }
  return retry;
}

// An unexpected error (not a ServerError the stage raised on purpose) logs its
// top frames, so a failure like a stack overflow names where it happened.
const where = (err) => (err instanceof ServerError || !err?.stack ? '' : ` at ${err.stack.split('\n').slice(1, 4).map((l) => l.trim()).join(' < ')}`);

function withFailure(label, projectId, expected, fn) {
  return Promise.resolve().then(fn).catch(async (err) => {
    console.error(`❌ Music Video Cast & Sets ${short(projectId)} ${label} failed: ${err.message}${where(err)}`);
    await fail(projectId, expected, `${label} failed: ${err.message}`).catch((recordErr) => console.error(`❌ Music Video Cast & Sets ${projectId} ${label} failed and its failure could not be recorded: ${recordErr.message}`));
  });
}

export function inBackground(label, projectId, expected, fn) {
  const work = withFailure(label, projectId, expected, fn).finally(() => backgroundWork.delete(work));
  backgroundWork.add(work);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// The sheet carries a viewing copy of each image, not the full render: fifteen
// full PNGs made a 54 MB page that phones choke on. The gallery keeps the original.
const SHEET_IMAGE_WIDTH = 1280;

async function sheetImage(path) {
  const sharp = (await import('sharp')).default;
  const bytes = await sharp(path).resize({ width: SHEET_IMAGE_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { mime: 'image/jpeg', bytes };
}

async function embedSheetImage(path) {
  if (!path || !MIME[extname(path).toLowerCase()]) return null;
  const copy = await castAndSetsDeps.sheetImage(path).catch(async (err) => {
    console.log(`⏭️ Music Video Cast & Sets sheet keeps ${basename(path)} at full size: ${err.message}`);
    const bytes = await readFile(path).catch(() => null);
    return bytes ? { mime: MIME[extname(path).toLowerCase()], bytes } : null;
  });
  return copy ? `data:${copy.mime};base64,${Buffer.from(copy.bytes).toString('base64')}` : null;
}

async function embeddedImages(stage) {
  const out = {};
  for (const [key, img] of Object.entries(stage.images || {})) {
    const uri = await embedSheetImage(img.imageId ? resolveGalleryImage(img.imageId, { mustExist: false }) : null);
    if (uri) out[key] = uri;
  }
  return out;
}

const renderStageSheet = async (project, stage, status) => renderCastAndSetsSheet({
  title: project.name,
  project,
  direction: stage.direction,
  images: await embeddedImages(stage),
  sections: songSections(project),
  durationSec: project.audioAnalysis?.durationSec ?? null,
  bpm: project.audioAnalysis?.bpm ?? null,
  revision: stage.revision,
  notesApplied: stage.notesApplied || [],
  checkinMode: castAndSetsCheckinMode(project),
  status,
});

/** Build the sheet, save it as the stage's development artifact, then check in. */
// Every save of a project's sheet takes the next artifact version, and storeVersion
// refuses a version another save already took. An approval's background re-save and
// an immediate edit's re-assembly would otherwise race, failing the edited stage.
const queueSheetSave = createKeyCachedQueue();

async function assemble(projectId, expected) {
  const marked = await mutateProjectRecord(projectId, (current) => ownsStage(current, expected) && allCastAndSetsImagesDone(current.castAndSets)
    ? setCastAndSetsStatus(current, 'assembling') : skippedWrite(current));
  if (marked.skipPersist) return;
  publish(projectId, marked.project);
  return withFailure('The sheet assembly', projectId, marked.stage, async () => {
    const { project, stage } = marked;
    const autoApprove = castAndSetsCheckinMode(project) === 'auto' && !stage.manualImageEditReview && !castSetsInspectionBlockers(stage).length;
    const html = await renderStageSheet(project, stage, autoApprove ? 'approved' : 'review');
    const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
    const existing = stage.artifactId && (project.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted) ? stage.artifactId : null;
    const out = await queueSheetSave(projectId, () => saveGeneratedDevArtifact(projectId, {
      artifactId: existing,
      kind: 'cast-sets',
      title: `Cast & Sets — ${stage.direction?.protagonist?.name || project.name}`,
      html,
      source: 'cast-and-sets',
      isCurrent: (current) => ownsStage(current, stage),
      attach: (current, artifact) => setCastAndSetsStatus(current, 'review', {
        extra: { artifactId: artifact.id, artifactVersion: artifact.version },
      }).project,
    }));
    if (!out) return;
    console.log(`🎭 Music Video Cast & Sets ${short(projectId)} sheet v${out.artifact.version} ready (${autoApprove ? 'auto-approve' : 'waiting for check-in'})`);
    if (autoApprove) {
      const review = out.project.castAndSets;
      return withFailure('The automatic check-in', projectId, review,
        () => approveCastAndSetsCheckin(projectId, { sheetRendered: true }, { catalog: castAndSetsDeps.catalog, expected: review }));
    }
    publish(projectId, out.project);
    return out;
  });
}

// A sheet rendered for review still asks its check-in questions; once approved,
// save it again as an approved version that drops them.
async function saveApprovedSheet(projectId, expected) {
  const project = await requireProject(projectId);
  if (!ownsStage(project, expected)) return;
  const stage = project.castAndSets;
  if (!stage.artifactId) return;
  if (!(project.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted)) return;
  const html = await renderStageSheet(project, stage, 'approved');
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const out = await saveGeneratedDevArtifact(projectId, {
    artifactId: stage.artifactId, kind: 'cast-sets', title: null, html, status: 'approved', source: 'cast-and-sets',
    isCurrent: (current) => ownsStage(current, expected) && current.castAndSets.artifactId === stage.artifactId,
    attach: (current, artifact) => ({ ...current, castAndSets: { ...current.castAndSets, artifactVersion: artifact.version } }),
  });
  if (out) publish(projectId, out.project);
}

// Not inBackground: a failed re-save must not mark the approved stage failed.
export function queueApprovedSheetRefresh(projectId, stage) {
  const work = queueSheetSave(projectId, () => saveApprovedSheet(projectId, stage))
    .catch((err) => console.error(`❌ Music Video Cast & Sets ${short(projectId)}: saving the approved sheet failed: ${err.message}`))
    .finally(() => backgroundWork.delete(work));
  backgroundWork.add(work);
}

/** Start the check-in (explicit request). The work continues in the background. */
export async function startCastAndSets(projectId, { providerId, model, effort, productionRunId = null } = {}) {
  const project = await requireProject(projectId);
  assertLegacyCheckin(project);
  if (!Array.isArray(project.audioAnalysis?.sections) || !project.audioAnalysis.sections.length) {
    throw new ServerError('Analyze the song before the Cast & Sets check-in', { status: 409, code: 'NOT_ANALYZED' });
  }
  const out = await mutateProjectRecord(projectId, (current) => startCastAndSetsOnProject(current, { processId: PROCESS_ID, productionRunId }));
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} started (r${out.stage.revision})`);
  publish(projectId, out.project);
  inBackground('The creative direction', projectId, out.stage, () => runDirection(projectId, out.stage, { providerId, model, effort }));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Resume an interrupted (restart) or failed stage in this process. */
export async function resumeCastAndSets(projectId, { providerId, model, effort } = {}) {
  assertLegacyCheckin(await requireProject(projectId));
  await reconcileOldCastSetsJobs(projectId);
  const out = await mutateProjectRecord(projectId, (current) => resumeCastAndSetsOnProject(current, { processId: PROCESS_ID, resolveNoteKeys: noteImageKeys }));
  console.log(`▶️ Music Video Cast & Sets ${short(projectId)} resumed (${out.stage.status})`);
  publish(projectId, out.project);
  if (out.stage.feedbackRenderPlan?.phase === 'ready') return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
  inBackground('The resume', projectId, out.stage, () => {
    if (out.stage.feedbackRenderPlan?.kind === 'image') return writePlan(projectId, out.stage, { forceKeys: out.stage.feedbackRenderPlan.forceKeys || [] });
    if (out.stage.feedbackRenderPlan?.kind === 'direction' && out.stage.direction && !(out.stage.notesApplied || []).length) return writePlan(projectId, out.stage);
    if (out.stage.status === 'directing') return runDirection(projectId, out.stage, { providerId, model, effort, notes: out.stage.notesApplied || [] });
    if (out.stage.status === 'assembling') return assemble(projectId, out.stage);
    return advance(projectId, out.stage);
  });
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/**
 * A tagged image job ended. `filename` = it rendered; otherwise `error`.
 * Settles its key (idempotent) and, when the stage is dispatching in this
 * process, continues. Returns true when the record changed.
 */
export async function onCastAndSetsImageSettled({ projectId, key, editRequestId = null, jobId = null, filename = null, error = null, revision = null, createdAt = null, productionRunId = null, productionStepKey = null, status = null }) {
  const project = await getProject(projectId);
  if (!project) return false;
  if (editRequestId) {
    if (isCatalogCheckin(project)) return false;
    return settleCastSetsImageEdit({ projectId, key, editRequestId, jobId, filename, error, status, productionRunId, productionStepKey }, publish);
  }
  const out = await mutateProjectRecord(projectId, (current) => {
    const stage = current.castAndSets;
    // Submitted work can settle its original ledger entry after a rebuild or
    // skip. Only the stage that queued it may take the image or its failure.
    const run = (current.productionRuns || []).find((item) => item.id === productionRunId);
    const step = run?.steps.find((item) => item.key === productionStepKey);
    const next = step?.kind === 'checkin' && step.sceneId === key && (revision == null || step.revisionId === String(revision))
      && (!step.jobId || step.jobId === jobId)
      ? settleProductionStep(current, productionRunId, productionStepKey, {
        status: filename ? 'completed' : status === 'canceled' ? 'canceled' : 'failed', jobId, error,
      }).project : current;
    const sameStage = stage && !isCatalogCheckin(current) && (createdAt == null || stage.createdAt === createdAt)
      && (revision == null || revision === stage.revision);
    const image = stage?.images?.[key];
    // Skips saved by older builds can still have a queued slot. Release only
    // that slot so the finished job no longer blocks a switch to the catalog.
    if (sameStage && stage.status === 'skipped' && image?.status === 'queued' && (!image.jobId || image.jobId === jobId)) {
      return { project: { ...next, castAndSets: { ...stage, images: { ...stage.images, [key]: releaseCastAndSetsImage(image) } } } };
    }
    const canSettle = sameStage && (['imaging', 'failed'].includes(stage.status) || (stage.status === 'review' && stage.feedbackRenderPlan?.phase === 'ready'));
    if (!canSettle) return next === current ? skippedWrite(current) : { project: next };
    const settled = settleCastAndSetsImage(next, key, { jobId, filename, error, revision });
    if (!settled.changed && next === current) return skippedWrite(current);
    if (settled.stage?.status === 'failed') settled.project = refundUnusedCheckinSteps(settled.project);
    // A job queued before a resume hold may finish, but its failure must join
    // the reviewed plan instead of scheduling a retry behind the director's back.
    const plan = settled.stage?.feedbackRenderPlan;
    if (settled.changed && !filename && plan?.phase === 'ready') {
      const settledImage = settled.stage.images[key];
      const held = { ...settled.stage, status: 'review', stopReason: null,
        images: { ...settled.stage.images, [key]: { ...settledImage, status: 'pending', jobId: null, failures: 0 } },
        feedbackRenderPlan: { ...plan, keys: [...new Set([...plan.keys, key])] } };
      settled.stage = held;
      settled.project = { ...settled.project, castAndSets: held };
    }
    return settled;
  });
  if (!out.skipPersist) publish(projectId, out.project);
  if (!out.changed) return false;
  if (out.stage?.processId === PROCESS_ID && out.stage.status === 'imaging') {
    void advance(projectId, out.stage);
  }
  return true;
}

/**
 * Rebuild a catalog stage's guide from the current catalog and shots, as a new
 * version of the guide Art opens. Refuses an unresolved check-in, so an
 * unreadable catalog can never publish a guide with its cast missing. The
 * check-in's own approval is untouched: it binds to the catalog, not this file.
 */
export async function rebuildCatalogGuide(projectId) {
  const started = await requireProject(projectId);
  if (!isCatalogCheckin(started)) throw new ServerError('The check-in changed. Reload it before rebuilding the guide.', { status: 409, code: 'CAST_SETS_PLAN_STALE' });
  const checkin = await resolveCatalogCheckin(started, { catalog: castAndSetsDeps.catalog });
  assertCatalogCheckinReady(checkin);
  const images = {};
  for (const filename of catalogSheetImageFiles(checkin.items)) {
    const uri = await embedSheetImage(resolveGalleryImage(filename) || resolveImageRef(filename));
    if (uri) images[filename] = uri;
  }
  // Encoding takes seconds, so everything else is read after it: the shots and guide
  // selection stay current, and a catalog edited meanwhile would invalidate the images.
  const project = await requireProject(projectId);
  if (!isCatalogCheckin(project) || (await resolveCatalogCheckin(project, { catalog: castAndSetsDeps.catalog })).basis !== checkin.basis) {
    throw new ServerError('The catalog changed while the guide was being built. Rebuild it again.', { status: 409, code: 'CAST_SETS_CATALOG_STALE' });
  }
  const html = renderCatalogCastAndSetsSheet({
    title: project.name, project, checkin, images,
    durationSec: project.audioAnalysis?.durationSec ?? null, bpm: project.audioAnalysis?.bpm ?? null,
    revision: project.castAndSets.revision,
  });
  // The selected guide first: a guide the stage no longer names is still what Art opens.
  const existing = [project.productionReview?.draft?.guideArtifactId, project.castAndSets.artifactId]
    .find((id) => (project.devArtifacts || []).some((a) => a.id === id && !a.deleted && a.kind === 'cast-sets')) || null;
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const { artifact } = await saveGeneratedDevArtifact(projectId, {
    artifactId: existing, kind: 'cast-sets', title: existing ? null : `Cast & Sets — ${project.name}`, html, source: 'cast-and-sets',
    status: project.castAndSets.status === 'approved' ? 'approved' : null,
  });
  const out = await mutateProjectRecord(projectId, (current) => (isCatalogCheckin(current)
    ? { project: selectArtGuideIfNone({ ...current, castAndSets: { ...current.castAndSets, artifactId: artifact.id, artifactVersion: artifact.version, updatedAt: new Date().toISOString() } }, artifact.id) }
    : { project: current }));
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} catalog guide v${artifact.version} saved`);
  publish(projectId, out.project);
  return { project: out.project, stage: out.project.castAndSets, artifact, catalogCheckin: checkin };
}
