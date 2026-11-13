import { isCatalogCheckin, resolveCatalogCheckin, withCatalogCheckin, assertCatalogCheckinReady, assertLegacyCheckin, remapCatalogShotReferences } from './catalogCheckin.js';
import { previewCastSetsImageEdit, requestCastSetsImageEdit, settleCastSetsImageEdit, acceptCastSetsImageEdit, discardCastSetsImageEdit } from './castAndSetsImageEdit.js';
import { musicVideoAllowsMedia, assertMusicVideoMediaSelections } from '../../lib/musicVideoMediaPolicy.js';
import { castAndSetsApprovalInputs, castAndSetsApprovalValues, castAndSetsStoryInputs, directorArtGuides, productionFeedbackContext, seedArtDraft, selectArtGuideIfNone } from './productionReview.js';
import { withMusicVideoStyle } from './styleReferences.js';
/**
 * Music Video — Cast & Sets check-in orchestrator.
 *
 * Runs the stage whose record transforms live in castAndSets.js:
 *
 *   1. direction  — one provider call (castAndSetsDirection.js) through the
 *                   shared runner, outside the write lock, against a snapshot;
 *   2. images     — the reference images of castAndSetsPlan.js, enqueued on
 *                   the normal image queue with a `musicVideo.castAndSets` tag
 *                   so the completion hook (musicVideoCastSetsImageHook.js)
 *                   files each result back here; a key is dispatched only once
 *                   every image it is conditioned on has landed;
 *   3. sheet      — castAndSetsSheet.js, saved as a `cast-sets` development
 *                   artifact (a new version on every regeneration);
 *   4. check-in   — `review` (default) waits for the director; `auto` approves.
 *
 * Approval writes the result into the project: the character sheet and set
 * plates become visual-spec references (conditioning frame generation), the
 * protagonist and sets become concept subjects. A production run waiting on the
 * stage re-bases its creative-setup checksum in the same write and continues.
 *
 * Everything is started by the director (Start / Regenerate / Resume, or a
 * production run they started). Nothing here runs at boot: the image hook only
 * files completions of jobs that were already queued, and a stage pinned to a
 * previous process dispatches nothing until it is resumed.
 */

import { randomUUID } from 'crypto';
import { castSetsInspectionInputs, currentCastSetsInspection, castSetsInspectionBlockers, sameCastSetsInspectionInputs } from '../../lib/musicVideoCastSetsInspection.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import { FACE_SHEET_ANGLE_TEMPLATE } from '../../lib/faceSheetAngleTemplate.js';
import { atomicWrite } from '../../lib/fileCore.js';
import { basename, extname } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { QUEUEABLE_IMAGE_MODES } from '../../lib/generationModes.js';
import { resolveGalleryImage, resolveImageRef, resolveTemplateAsset } from '../../lib/pathSafety.js';
import { musicVideoReferenceCapacity } from '../../lib/musicVideoConditioning.js';
import { mediaRecoveryPending } from '../../lib/mediaRecoveryActivity.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { trimTo } from '../../lib/textUtils.js';
import { castAndSetsPendingGreyboxSetIds } from '../../lib/musicVideoGreybox.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { requireProject } from './requireProject.js';
import { musicVideoEvents } from './events.js';
import { effortArg, recordLlmRoute, resolveMusicVideoLlm } from './llmRoute.js';
import {
  CAST_SETS_WORKING,
  CAST_SETS_MAX_KEY_NOTES,
  CAST_SETS_MAX_IMAGE_HISTORY,
  allCastAndSetsImagesDone,
  assertCastAndSetsApprovable,
  castAndSetsCheckinMode,
  dispatchableImageKeys,
  linkCastAndSetsJob,
  presentCastAndSets,
  addCastAndSetsFeedback,
  reconfirmCastAndSetsOnProject,
  removeCastAndSetsFeedback,
  removeCastAndSetsImageNote,
  reserveCastAndSetsImage,
  resumeCastAndSetsOnProject,
  reviseCastAndSetsOnProject,
  setCastAndSetsDirection,
  setCastAndSetsStatus,
  settleCastAndSetsImage,
  startCastAndSetsOnProject,
} from './castAndSets.js';
import {
  applyCastAndSetsDirectionEdits,
  applyCastAndSetsDirectionTextEdits,
  buildCastAndSetsPrompt,
  castAndSetsAllowsImages,
  castAndSetsMedium,
  describeDirectionChanges,
  fixedSupportingCast,
  fixedProps,
  formSubjects,
  mergeCastAndSetsDirection,
  moodBoardImageList,
  parseCastAndSetsResponse,
  songSections,
} from './castAndSetsDirection.js';
import {
  CAST_SETS_IMAGE_SIZE,
  CAST_SETS_REF_PREFIX,
  affectedImageKeys,
  buildCastAndSetsImagePlan,
  castAndSetsOverflowFaceReferences,
  castAndSetsReferences,
  castAndSetsSubjects,
  fixedCastSheetsWithoutReference,
  noteImageKeys,
  plannedTests,
} from './castAndSetsPlan.js';
import { renderCastAndSetsSheet } from './castAndSetsSheet.js';
import { catalogSheetImageFiles, renderCatalogCastAndSetsSheet } from './castAndSetsCatalogSheet.js';
import { loadCastAndSetsCatalogLikeness } from './castAndSetsCatalogLikeness.js';
import { findDevArtifact, reviewDevArtifact, resolveDevArtifactNotes } from './devArtifacts.js';
import { PRODUCTION_RESUMABLE_STATUSES, findProductionRun, haltProduction, rebaseProductionAfterCheckin, reserveProductionStep, settleProductionStep } from './production.js';

const PROCESS_ID = `proc-${randomUUID()}`;
const short = (id) => String(id || '').slice(3, 11);
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
  getSettings: async () => (await import('../settings.js')).getSettings(),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  queueSnapshot: async (jobId, { projectId, key, revision } = {}) => {
    const queue = await import('../mediaJobQueue/index.js');
    const matches = jobId ? [] : queue.listJobs({ kind: 'image', owner: `music-video-cast-sets:${projectId}` }).filter((job) => {
      const tag = job.params?.musicVideo;
      return tag?.projectId === projectId && tag?.castAndSets?.key === key && tag?.castAndSets?.revision === revision && !tag.castAndSets.editRequestId;
    });
    return { ...queue.getMediaRecoveryActivity(), job: jobId ? queue.getJob(jobId) : null, matches };
  },
  loadBoard: async (id) => (await import('../moodBoard/index.js')).getBoard(id),
  boardItemImage: async () => (await import('../moodBoard/logic.js')).boardItemLocalImage,
  loadTrack: async (id) => (await import('../tracks/index.js')).getTrack(id),
  sheetImage: (path) => sheetImage(path),
  imageParams: (settings, route, common) => imageJobParams(settings, route, common),
  resolveRoute: null,
  // getIngredient/listMediaForIngredient; null = the live catalog.
  catalog: null,
};
let deps = { ...defaults };
export function __setCastAndSetsDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }
export const __castAndSetsProcessId = () => PROCESS_ID;

// Reconcile the old single pending flag against the actual capture sent to the plate.
async function pendingGreyboxState(project) {
  const stage = project.castAndSets;
  if (!stage?.greyboxPending) return { direct: [], legacy: [], unavailable: [] };
  const direct = Array.isArray(stage.greyboxPendingSetIds) ? stage.greyboxPendingSetIds : [];
  const legacyIds = Array.isArray(stage.greyboxLegacyPendingSetIds) ? stage.greyboxLegacyPendingSetIds
    : Array.isArray(stage.greyboxPendingSetIds) ? [] : (stage.direction?.sets || []).map((set) => set.id);
  const candidates = new Set(legacyIds);
  const selected = (stage.direction?.sets || []).filter((set) => candidates.has(set.id) && set.setReference?.greyboxShotId);
  const legacyStage = { ...stage, greyboxPendingSetIds: [], greyboxLegacyPendingSetIds: legacyIds };
  if (!selected.length) return { direct, legacy: castAndSetsPendingGreyboxSetIds(legacyStage), unavailable: [] };
  const { loadMusicVideoGreybox } = await import('./greyboxReferences.js');
  const captures = await Promise.all(selected.map(async (set) => {
    const greybox = await loadMusicVideoGreybox(project, { sceneId: `set:${set.id}`, setReference: set.setReference }, { catalog: deps.catalog }).catch(() => null);
    return [set.id, greybox?.reference?.imageId || null];
  }));
  return { direct, legacy: castAndSetsPendingGreyboxSetIds(legacyStage, Object.fromEntries(captures)), unavailable: captures.filter(([, imageId]) => !imageId).map(([id]) => id) };
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

/**
 * The project as a CLIENT reads it. Only this process knows its own id, so only
 * the server can tell a working stage a restart unpinned (`interrupted`) from
 * one still running here; a raw record read would show every such stage as
 * live forever (#9940). Not for write paths — never persist the result.
 */
export const presentProjectCastAndSets = (project) => (project?.castAndSets
  ? { ...project, castAndSets: presentCastAndSets(project.castAndSets, PROCESS_ID) }
  : project);

function publish(projectId, project) {
  const presented = presentProjectCastAndSets(project);
  musicVideoEvents.emit('cast-and-sets', {
    projectId,
    stage: presented?.castAndSets || null,
    project: presented,
  });
}

/** Reconcile terminal queue jobs whose check-in hook has not settled them. */
async function reconcileOldCastSetsJobs(projectId) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  if (!stage || (stage.processId === PROCESS_ID && stage.status !== 'failed')) return;
  for (const [key, image] of Object.entries(stage.images || {})) {
    if (image.status !== 'queued' || (!image.jobId && stage.processId === PROCESS_ID)) continue;
    const snapshot = await deps.queueSnapshot(image.jobId, { projectId, key, revision: stage.revision });
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
    const tagMatches = tag?.projectId === projectId && tag?.castAndSets?.key === key && tag?.castAndSets?.revision === stage.revision;
    const filename = tagMatches && job.status === 'completed' && resolveGalleryImage(job.result?.filename) ? job.result.filename : null;
    const error = tagMatches ? (job.error || 'The previous image job ended without a recoverable image')
      : snapshot.matches?.length > 1 ? 'Several previous image jobs matched this slot; review them before retrying' : 'The previous image job is no longer in the queue history';
    const runKnown = tagMatches && (project.productionRuns || []).some((run) => run.id === tag.productionRunId);
    await onCastAndSetsImageSettled({ projectId, key, revision: stage.revision, jobId: image.jobId || job?.id || null, filename, error,
      status: job?.status, ...(runKnown ? { productionRunId: tag.productionRunId, productionStepKey: tag.productionStepKey } : {}) });
  }
}

async function fail(projectId, reason, error = null) {
  const out = await mutateProjectRecord(projectId, (current) => setCastAndSetsStatus(refundUnusedCheckinSteps(current), 'failed', { reason, error, extra: { failedFromStatus: current.castAndSets?.status } }));
  console.error(`❌ Music Video Cast & Sets ${short(projectId)} failed: ${reason}`);
  publish(projectId, out.project);
  return out;
}

// ---- route choice -------------------------------------------------------------

/**
 * The image route: a production run's pool route when one is given; otherwise
 * Codex when the brief allows it (or names no image tool) and it is enabled,
 * then the brief's other queueable image tools in catalog order, then the
 * install's Music Video render default. Returns `{ mode, model }` or null.
 */
async function chooseCastAndSetsRoute(project, { preferred = null, settings } = {}) {
  if (deps.resolveRoute) return deps.resolveRoute(project, { preferred, settings });
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

// ---- direction ------------------------------------------------------------------

async function loadContext(project) {
  assertMusicVideoMediaSelections(project);
  const boardId = project?.visualSpec?.moodBoardId;
  const board = boardId ? await deps.loadBoard(boardId).catch(() => null) : null;
  const resolveItem = board ? await deps.boardItemImage() : null;
  const moodImages = board ? moodBoardImageList(board, resolveItem) : [];
  const track = project?.trackId ? await deps.loadTrack(project.trackId).catch(() => null) : null;
  return { board, moodImages, track };
}

/**
 * Run the direction call for the stage's current revision and write the image
 * plan. `notes` (a revision) are sent with the current direction; `forceKeys`
 * are image keys the director flagged directly.
 */
async function runDirection(projectId, { providerId, model, effort, notes = [], forceKeys = [] } = {}) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  const { board, moodImages, track } = await loadContext(project);
  // Request pin > the brief's Cast & Sets pin > its direction LLM > an eligible TUI provider > the active one (llmRoute.js).
  const { provider, selectedModel, route } = await deps.resolveProvider({ providerId, model, effort, automation: project.automation, stage: 'castAndSets' }).catch(() => ({ provider: null }));
  if (!provider) return fail(projectId, 'No AI provider is available for the creative direction');
  if (provider.enabled === false) return fail(projectId, `The ${provider.name || provider.id} provider is disabled`);
  const previous = stage?.direction || null;
  // A revision keeps the medium it was directed in; a fresh pass resolves it
  // from the project's policy and tools, so a saved direction is never
  // silently re-cast into the other medium.
  // A saved direction without a medium predates the procedural one: photographic.
  const medium = notes.length && previous ? (previous.medium || 'photographic') : castAndSetsMedium(project);
  // Standing sheet feedback rides on every direction call, a fresh rebuild included.
  const feedback = stage?.feedback || [];
  const standing = feedback.length > 0;
  const prompt = buildCastAndSetsPrompt(project, { moodImages, board, track, previous: notes.length ? previous : null, notes, medium, feedback, guides: directorArtGuides(project) }) + productionFeedbackContext(project);
  let text;
  try {
    ({ text } = await deps.runPrompt({ provider, model: selectedModel, ...effortArg(route), prompt, source: 'music-video-cast-sets' }));
  } catch (err) {
    return fail(projectId, 'The creative direction call failed', err.message);
  }
  await recordLlmRoute(projectId, 'castAndSets', route);
  const parsed = parseCastAndSetsResponse(text);
  if (!parsed) return fail(projectId, 'The creative direction answer had no usable JSON');
  const sections = songSections(project);
  const merged = mergeCastAndSetsDirection(notes.length ? previous : null, parsed, { sections, medium, fixedCast: fixedSupportingCast(project), fixedProps: fixedProps(project) });
  if (merged.missing.length) return fail(projectId, `The creative direction answer is missing: ${merged.missing.join(', ')}`);
  const direction = withCheckedFormSubjects(project, merged.direction, notes.length ? previous : null);
  // The scene look set plates and in-set frames carry. While the director's sheet feedback
  // stands, the look line rewritten to agree with it wins; otherwise the
  // director's palette/light/texture line, else the project's visual style.
  // Never the board's composed style verbatim: it can describe a whole person
  // and scene, which then lands in every empty set plate.
  direction.look = (standing && (parsed.look || previous?.look)) || direction.look || trimTo(project.concept?.style, 500) || '';
  // Mood board images inform the direction as text only, never as image references.
  return writePlan(projectId, { direction, forceKeys, changes: previous ? describeDirectionChanges(previous, direction) : null, directedInputs: castAndSetsStoryInputs(project) });
}

/**
 * A direction saved before the look was written by the director copied the
 * mood board's composed style prompt verbatim (people and places included);
 * such a look falls back to the project's visual style.
 */
async function withoutBoardLook(project, direction) {
  const boardId = project?.visualSpec?.moodBoardId;
  if (!direction?.look || !boardId) return direction;
  const board = await deps.loadBoard(boardId).catch(() => null);
  const boardLook = trimTo(board?.style?.prompt, 500);
  return boardLook && direction.look === boardLook ? { ...direction, look: trimTo(project.concept?.style, 500) || '' } : direction;
}

/**
 * The image plan `direction` gets from the project as it is now, with the
 * linked Casting records' current images. A procedural project whose brief
 * names no image tool is code-only: nothing is rendered, so no image backend
 * is needed (or consulted).
 */
async function currentImagePlan(project, direction) {
  const codeOnly = !musicVideoAllowsMedia(project, 'image') || direction.medium === 'procedural' && !castAndSetsAllowsImages(project);
  if (codeOnly) return { codeOnly, plan: {} };
  const { loadMusicVideoGreybox } = await import('./greyboxReferences.js');
  const greyboxes = Object.fromEntries(await Promise.all((direction.sets || []).filter((s) => s.setReference?.greyboxShotId).map(async (set) => [set.id, await loadMusicVideoGreybox(project, { sceneId: `set:${set.id}`, setReference: set.setReference })])));
  const catalogLikeness = await loadCastAndSetsCatalogLikeness(project, { catalog: deps.catalog });
  const plan = buildCastAndSetsImagePlan(project, direction, { revisionNotes: keyNotesText(project.castAndSets?.keyNotes), greyboxes, catalogLikeness });
  // Planned cards are published before their dependent renders can start.
  if (Object.values(plan).some((item) => item.refTemplates?.includes(FACE_SHEET_ANGLE_TEMPLATE))) await ensureFaceSheetTemplate();
  return { codeOnly, plan };
}

/** (Re)build the plan from the stage's direction + accumulated per-image notes, then dispatch. */
async function writePlan(projectId, { direction = null, forceKeys = [], changes = null, directedInputs = null } = {}) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  const nextDirection = await withoutBoardLook(project, direction || stage.direction);
  const { codeOnly, plan } = await currentImagePlan(project, nextDirection);
  // A later feedback edit must retain images still waiting from an earlier one.
  const renderKeys = affectedImageKeys(stage.plan || {}, plan, [...(stage.feedbackRenderPlan?.keys || []), ...forceKeys]);
  const settings = await deps.getSettings();
  const run = stage.productionRunId ? (project.productionRuns || []).find((r) => r.id === stage.productionRunId) : null;
  const preferred = run?.pool?.find((r) => r.kind === 'image') || stage.route || null;
  const route = codeOnly ? (stage.route || null) : await chooseCastAndSetsRoute(project, { preferred, settings });
  if (!route && !codeOnly && !stage.feedbackRenderPlan) return fail(projectId, 'No enabled image backend is allowed for the Cast & Sets images — enable Codex (or another image tool in the brief) and resume');
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    if (current.castAndSets?.revision !== stage.revision) throw new ServerError('The check-in changed while its image plan was being prepared', { status: 409, code: 'CAST_SETS_PLAN_STALE' });
    const next = setCastAndSetsDirection(current, { direction: nextDirection, plan, route, renderKeys });
    const savedStage = { ...next.stage, greyboxPending: false, greyboxPendingSetIds: [], greyboxLegacyPendingSetIds: [],
      ...(directedInputs ? { directedInputs } : {}),
      ...(changes ? { changeSummary: { revision: next.stage.revision, changes, ...(next.stage.feedbackRenderPlan ? { planned: renderKeys.length } : { rerendered: renderKeys.length }), at: next.stage.updatedAt } } : {}),
      ...(next.stage.feedbackRenderPlan ? { status: 'review', route: codeOnly ? next.stage.route : route, feedbackRenderPlan: { ...next.stage.feedbackRenderPlan, phase: 'ready', keys: renderKeys } } : {}),
    };
    return { project: { ...next.project, castAndSets: savedStage }, stage: savedStage };
  });
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} r${out.stage.revision}: ${renderKeys.length} image(s) to render${route ? ` on ${route.mode}` : ' (code-only, no image backend)'}`);
  publish(projectId, out.project);
  if (out.stage.feedbackRenderPlan) return out;
  return advance(projectId);
}

/**
 * A form's subject binding a caller just set (it differs from the one `previous`
 * held for that form id) that names no fixed-casting character of `project`.
 * An unchanged binding whose subject was since unlinked is left for the plan
 * to report as missing, so it never blocks an unrelated edit.
 */
function newUnknownFormSubjects(project, direction, previous) {
  const known = new Set(formSubjects(project).map((s) => s.id));
  const before = new Map((previous?.protagonist?.forms || []).map((f) => [f.id, f.subjectId]));
  return (direction?.protagonist?.forms || []).filter((f) => f.subjectId && f.subjectId !== before.get(f.id) && !known.has(f.subjectId));
}

/**
 * Bind forms only to subjects the director cast: a provider's new binding to
 * any other id is dropped (a director edit is refused before this runs), and
 * each binding to a known subject records that subject's name, so its
 * reference can still be kept off the present-day sheet if the subject is
 * later removed from the video.
 */
function withCheckedFormSubjects(project, direction, previous) {
  const forms = direction?.protagonist?.forms;
  if (!forms?.length) return direction;
  const unknown = new Set(newUnknownFormSubjects(project, direction, previous).map((f) => f.id));
  const names = new Map(formSubjects(project).map((s) => [s.id, s.name]));
  const checked = forms.map((f) => {
    if (!f.subjectId) return f;
    const { subjectId, subjectName, ...rest } = f;
    if (unknown.has(f.id)) return rest;
    const name = names.get(subjectId) || subjectName;
    return { ...rest, subjectId, ...(name ? { subjectName: name } : {}) };
  });
  return { ...direction, protagonist: { ...direction.protagonist, forms: checked } };
}

const keyNotesText = (keyNotes = {}) => Object.fromEntries(Object.entries(keyNotes).map(([k, list]) => [k, list.join('; ')]));

// ---- images -----------------------------------------------------------------------

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

async function enqueueImage(project, stage, key) {
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
      projectId: project.id, castAndSets: { key, revision: stage.revision },
      ...(stage.productionRunId ? {
        productionRunId: stage.productionRunId,
        productionStepKey: checkinStep(project, stage, key)?.key,
      } : {}),
    },
  };
  const settings = await deps.getSettings();
  const baseParams = await deps.imageParams(settings, stage.route, common);
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
  const sent = await deps.enqueue({ kind: 'image', params, owner: `music-video-cast-sets:${project.id}` });
  return { ...sent, submission };
}

// Check-in slots use the existing production ledger; the revision separates
// regenerated images and a terminal attempt permits a charged retry.
function checkinStep(project, stage, key) {
  const run = findProductionRun(project, stage.productionRunId);
  return run.steps.findLast((step) => step.kind === 'checkin'
    && step.sceneId === key && step.revisionId === String(stage.revision));
}

// Images never submitted must not remain charged after the check-in ends.
function refundUnusedCheckinSteps(project) {
  const runId = project.castAndSets?.productionRunId;
  if (!runId) return project;
  const run = (project.productionRuns || []).find((item) => item.id === runId);
  if (!run) return project;
  let next = project;
  for (const step of run.steps) {
    if (step.kind === 'checkin' && step.status === 'reserved'
      && project.castAndSets.images?.[step.sceneId]?.status !== 'queued') {
      next = settleProductionStep(next, runId, step.key, {
        status: 'refused', error: 'The check-in stopped before this image was submitted',
      }).project;
    }
  }
  return next;
}

/** Reserve the WHOLE pending plan in one write before any job can be queued. */
async function reserveCheckinPlan(projectId) {
  return mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const stage = current.castAndSets;
    if (!stage?.productionRunId) return { project: current };
    const run = findProductionRun(current, stage.productionRunId);
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

async function dispatchKey(projectId, key) {
  const reserved = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    if (current.castAndSets?.productionRunId) {
      const run = findProductionRun(current, current.castAndSets.productionRunId);
      if (run.status !== 'running' || checkinStep(current, current.castAndSets, key)?.status !== 'reserved') {
        throw new ServerError('The production run is not dispatching this image', { status: 409, code: 'CAST_SETS_NOT_RUNNING' });
      }
    }
    return reserveCastAndSetsImage(current, key, { processId: PROCESS_ID });
  })
    .catch((err) => ({ error: err }));
  if (reserved.error) {
    if (['CAST_SETS_IMAGE_BUSY', 'CAST_SETS_NOT_RUNNING', 'CAST_SETS_FEEDBACK_PENDING'].includes(reserved.error.code)) return;
    throw reserved.error;
  }
  const productionStep = reserved.stage.productionRunId ? checkinStep(reserved.project, reserved.stage, key) : null;
  const runId = reserved.stage.productionRunId;
  const sent = await enqueueImage(reserved.project, reserved.stage, key).catch((err) => ({ error: err }));
  if (sent?.error || !sent?.jobId) {
    const reason = sent?.error?.message || 'The image job was not queued';
    const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
      const next = productionStep ? settleProductionStep(current, runId, productionStep.key, { status: 'refused', error: reason }).project : current;
      // This route cannot carry the required inputs, so retrying it cannot
      // succeed and may otherwise leave the final pending key without a wakeup.
      const retryable = sent?.error?.code !== 'CAST_SETS_ROUTE_INELIGIBLE';
      const settled = settleCastAndSetsImage(next, key, { error: reason, revision: reserved.stage.revision, retryable });
      if (settled.stage?.status === 'failed') settled.project = refundUnusedCheckinSteps(settled.project);
      return settled;
    });
    console.warn(`⚠️ Music Video Cast & Sets ${short(projectId)} ${key} refused: ${reason}`);
    // A refusal has no later job-completion event to wake the retry. Request
    // another pass only for the same pending revision, without awaiting the
    // current coalesced advance (which would wait on itself).
    if (out.changed && out.stage?.status === 'imaging' && out.stage.revision === reserved.stage.revision
      && out.stage.processId === PROCESS_ID && out.stage.images?.[key]?.status === 'pending') {
      const live = advancing.get(projectId);
      if (live) live.again = true;
    }
    publish(projectId, out.project);
    return;
  }
  const linked = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    const next = productionStep ? settleProductionStep(current, runId, productionStep.key, { status: 'queued', jobId: sent.jobId }).project : current;
    return linkCastAndSetsJob(next, key, sent.jobId, sent.submission);
  });
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
function advance(projectId) {
  const live = advancing.get(projectId);
  if (live) { live.again = true; return live.promise; }
  const entry = { again: false, promise: null };
  entry.promise = (async () => {
    try {
      do {
        entry.again = false;
        await advanceOnce(projectId);
      } while (entry.again);
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
async function retryInspectedImage(projectId, { key, inputs, inspectionId, note }) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  const eligible = (current) => current.castAndSets?.status === 'imaging'
    && !current.castAndSets.manualImageEditReview
    && current.castAndSets.processId === PROCESS_ID && current.castAndSets.revision === stage.revision
    && current.castAndSets.productionRunId === stage.productionRunId && stage.productionRunId
    && current.castAndSets.images[key]?.renderQualityRetry?.revision !== stage.revision
    && currentCastSetsInspection(current.castAndSets, key)?.id === inspectionId
    && sameCastSetsInspectionInputs(inputs, castSetsInspectionInputs(current.castAndSets, key));
  if (!eligible(project)) return;
  const keyNotes = { ...stage.keyNotes, [key]: [...(stage.keyNotes?.[key] || []), note].slice(-CAST_SETS_MAX_KEY_NOTES) };
  const { plan } = await currentImagePlan({ ...project, castAndSets: { ...stage, keyNotes } }, stage.direction);
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    if (!eligible(current)) return { project: current, changed: false };
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

async function advanceOnce(projectId) {
  let project = await requireProject(projectId);
  let stage = project.castAndSets;
  if (!stage || stage.feedbackRenderPlan || stage.processId !== PROCESS_ID || stage.status !== 'imaging') return;
  if (allCastAndSetsImagesDone(stage)) {
    const { inspectCastAndSetsImages } = await import('./castAndSetsInspection.js');
    await inspectCastAndSetsImages(projectId, { processId: PROCESS_ID, resolveReviewer: deps.resolveReviewer, reviewImage: deps.reviewImage, publish, retryImage: (opts) => retryInspectedImage(projectId, opts) });
    const fresh = await requireProject(projectId);
    if (fresh.castAndSets?.revision !== stage.revision || fresh.castAndSets.status !== 'imaging' || fresh.castAndSets.processId !== PROCESS_ID) return;
    if (allCastAndSetsImagesDone(fresh.castAndSets)) {
      await assemble(projectId);
      return;
    }
    project = fresh;
    stage = fresh.castAndSets;
  }
  if (stage.productionRunId) {
    const run = findProductionRun(project, stage.productionRunId);
    if (run.status !== 'running') return;
    const reserved = await reserveCheckinPlan(projectId).catch((error) => ({ error }));
    if (reserved.error) {
      const limit = ['PRODUCTION_SPEND_LIMIT', 'PRODUCTION_BUDGET_EXHAUSTED'].includes(reserved.error.code);
      const reason = limit ? `${checkinPlanSize(stage)}: ${reserved.error.message}. Raise the run's limit and resume.` : reserved.error.message;
      const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
        const failed = setCastAndSetsStatus(refundUnusedCheckinSteps(current), 'failed', { reason });
        return haltProduction(failed.project, stage.productionRunId, {
          status: limit ? 'limit-reached' : 'blocked', reason,
        });
      });
      musicVideoEvents.emit('production', { projectId, runId: out.run.id, run: out.run, action: { type: 'idle' }, project: out.project });
      publish(projectId, out.project);
      return;
    }
  }
  const keys = dispatchableImageKeys(stage);
  for (const key of keys) await dispatchKey(projectId, key);
  if (keys.length) publish(projectId, await requireProject(projectId));
}

// An unexpected error (not a ServerError the stage raised on purpose) logs its
// top frames, so a failure like a stack overflow names where it happened.
const where = (err) => (err instanceof ServerError || !err?.stack ? '' : ` at ${err.stack.split('\n').slice(1, 4).map((l) => l.trim()).join(' < ')}`);

function inBackground(label, projectId, fn) {
  const work = Promise.resolve().then(fn).catch(async (err) => {
    console.error(`❌ Music Video Cast & Sets ${short(projectId)} ${label} failed: ${err.message}${where(err)}`);
    await fail(projectId, `${label} failed: ${err.message}`).catch((recordErr) => console.error(`❌ Music Video Cast & Sets ${projectId} ${label} failed and its failure could not be recorded: ${recordErr.message}`));
  }).finally(() => backgroundWork.delete(work));
  backgroundWork.add(work);
}

// ---- sheet ----------------------------------------------------------------------------

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
  const copy = await deps.sheetImage(path).catch(async (err) => {
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

async function assemble(projectId) {
  const marked = await mutateProjectRecord(projectId, (current) => setCastAndSetsStatus(current, 'assembling'));
  publish(projectId, marked.project);
  const project = marked.project;
  const stage = marked.stage;
  const mode = castAndSetsCheckinMode(project);
  const autoApprove = mode === 'auto' && !stage.manualImageEditReview && !castSetsInspectionBlockers(stage).length;
  const html = await renderStageSheet(project, stage, autoApprove ? 'approved' : 'review');
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const existing = stage.artifactId && (project.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted) ? stage.artifactId : null;
  const { artifact } = await queueSheetSave(projectId, () => saveGeneratedDevArtifact(projectId, {
    artifactId: existing,
    kind: 'cast-sets',
    title: `Cast & Sets — ${stage.direction?.protagonist?.name || project.name}`,
    html,
    source: 'cast-and-sets',
  }));
  const out = await mutateProjectRecord(projectId, (current) => setCastAndSetsStatus(current, 'review', {
    extra: { artifactId: artifact.id, artifactVersion: artifact.version },
  }));
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} sheet v${artifact.version} ready (${autoApprove ? 'auto-approve' : 'waiting for check-in'})`);
  if (autoApprove) return approveCastAndSets(projectId, { sheetRendered: true });
  publish(projectId, out.project);
  return out;
}

// ---- approval ------------------------------------------------------------------------

// A sheet rendered for review still asks its check-in questions; once approved,
// save it again as an approved version that drops them.
function refreshApprovedSheet(projectId) {
  return queueSheetSave(projectId, () => saveApprovedSheet(projectId));
}

async function saveApprovedSheet(projectId) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  if (isCatalogCheckin(project) || stage?.status !== 'approved' || !stage.artifactId) return;
  if (!(project.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted)) return;
  const html = await renderStageSheet(project, stage, 'approved');
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const { artifact } = await saveGeneratedDevArtifact(projectId, {
    artifactId: stage.artifactId, kind: 'cast-sets', title: null, html, status: 'approved', source: 'cast-and-sets',
  });
  const out = await mutateProjectRecord(projectId, (current) => (current.castAndSets?.status === 'approved' && current.castAndSets.artifactId === artifact.id
    ? { project: { ...current, castAndSets: { ...current.castAndSets, artifactVersion: artifact.version } } }
    : { project: current }));
  publish(projectId, out.project);
}

// Not inBackground: a failed re-save must not mark the approved stage failed.
function queueApprovedSheetRefresh(projectId) {
  const work = refreshApprovedSheet(projectId)
    .catch((err) => console.error(`❌ Music Video Cast & Sets ${short(projectId)}: saving the approved sheet failed: ${err.message}`))
    .finally(() => backgroundWork.delete(work));
  backgroundWork.add(work);
}

// Save the approved check-in's new cast and sets to the catalog (Casting /
// Environments), then show the stamped subjects. The approval already landed.
function queueCheckinCastToCatalog(projectId) {
  import('./catalogCast.js')
    .then(({ saveCheckinCastToCatalog }) => saveCheckinCastToCatalog(projectId))
    .then((result) => { if (result?.project) publish(projectId, result.project); })
    .catch((err) => console.error(`❌ Music Video Cast & Sets ${short(projectId)}: saving cast to the catalog failed: ${err.message}`));
}

/**
 * Apply an approved check-in to the project (references, subjects), approve
 * its artifact, and re-base a production run that was waiting on it.
 */
function applyApproval(project, now) {
  const stage = project.castAndSets;
  const references = castAndSetsReferences(project, stage);
  const unseated = fixedCastSheetsWithoutReference(project, stage, references);
  if (unseated.length) {
    const characterLost = stage.images?.character?.imageId && !references.some((r) => r.id === `${CAST_SETS_REF_PREFIX}character`);
    throw new ServerError(`The project's reference list is full, so the cast sheet${unseated.length > 1 ? 's' : ''} for ${unseated.join(', ')} cannot be added. Remove ${unseated.length + (characterLost ? 1 : 0)} of the project's own visual references and approve again.`, { status: 409, code: 'CAST_SETS_REFERENCE_LIMIT' });
  }
  let next = {
    ...project,
    visualSpec: {
      references: [], palette: [], typography: '', cameraRules: '', moodBoardId: null,
      ...(project.visualSpec || {}),
      references,
    },
    concept: { ...(project.concept || {}), subjects: castAndSetsSubjects(project, stage) },
  };
  assertMusicVideoMediaSelections(next);
  // Approving the sheet seeds the art-direction draft and guide so the next
  // approval is one click, not a re-typing of what the sheet already says.
  next = seedArtDraft(next, stage);
  if (stage.artifactId && (next.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted)) {
    next = reviewDevArtifact(next, stage.artifactId, { status: 'approved' }, now).project;
  }
  // Record what the approval rests on, so a later concept/style/subject/song
  // edit can be named as "changed since" (#10141).
  return setCastAndSetsStatus(next, 'approved', { extra: {
    approvedInputs: castAndSetsApprovalInputs(next), approvedValues: castAndSetsApprovalValues(next),
    overflowFaceReferences: castAndSetsOverflowFaceReferences(stage, references),
  } }, now);
}

// Settle the stage and re-base a production run waiting on it, in ONE write,
// so the run never observes the new references without its new basis.
const settleAndRebase = (next, now) => {
  const { project } = rebaseProductionAfterCheckin(next.project, now);
  return { project, stage: project.castAndSets };
};

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
  return run(projectId, { keys, resolveReviewer: deps.resolveReviewer, reviewImage: deps.reviewImage, publish });
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
    const image = { ...old, imageId, status: 'done', jobId: null, error: null, edit: null,
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
    await deps.syncCatalogImage(projectId, key).catch((err) => console.error(`❌ Music Video Cast & Sets ${short(projectId)}: saving chosen image to the catalog failed; approval will retry: ${err.message}`));
    await advance(projectId);
  });
  return { project: out.project };
}

/** Approve & continue. Returns `{ project, stage }`. */
export async function approveCastAndSets(projectId, input = {}) {
  if (isCatalogCheckin(await requireProject(projectId))) return approveCatalogCheckin(projectId, input);
  const now = new Date().toISOString();
  const out = await mutateProjectRecord(projectId, async (current) => {
    assertLegacyCheckin(current);
    assertCastAndSetsApprovable(current);
    const pending = await pendingGreyboxState(current);
    if (pending.unavailable.length) throw new ServerError('The selected greybox capture could not be checked. Restore it or clear the selection, then try again.', { status: 409, code: 'CAST_SETS_GREYBOX_PENDING' });
    if (pending.direct.length || pending.legacy.length) throw new ServerError('Regenerate the set plates with the selected greybox references before approving.', { status: 409, code: 'CAST_SETS_GREYBOX_PENDING' });
    const ready = { ...current, castAndSets: { ...current.castAndSets, greyboxPending: false, greyboxPendingSetIds: [], greyboxLegacyPendingSetIds: [] } };
    return settleAndRebase(applyApproval(ready, now), now);
  });
  console.log(`✅ Music Video Cast & Sets ${short(projectId)} approved (r${out.stage.revision})`);
  publish(projectId, out.project);
  queueCheckinCastToCatalog(projectId);
  if (!input.sheetRendered) queueApprovedSheetRefresh(projectId);
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/**
 * Keep an approved check-in approved on the project's current concept, style,
 * subjects and song (#10141): clears the "changed since" note without
 * rebuilding the sheet or re-applying its references. Returns `{ project, stage }`.
 */
export async function reconfirmCastAndSets(projectId, input = {}) {
  if (isCatalogCheckin(await requireProject(projectId))) return approveCatalogCheckin(projectId, input);
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

// ---- director actions ------------------------------------------------------------------

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
  inBackground('The creative direction', projectId, () => runDirection(projectId, { providerId, model, effort }));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Render an isolated candidate; the approved stage remains unchanged until acceptance. */
export const previewCastAndSetsImageEdit = async (projectId, input) => {
  assertLegacyCheckin(await requireProject(projectId));
  return previewCastSetsImageEdit(projectId, input, deps);
};
export const editCastAndSetsImage = async (projectId, input) => {
  assertLegacyCheckin(await requireProject(projectId));
  return requestCastSetsImageEdit(projectId, input, { ...deps, processId: PROCESS_ID, publish });
};
export const discardCastAndSetsImageEdit = (projectId, input) => discardCastSetsImageEdit(projectId, input, publish);
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
      const pending = await pendingGreyboxState(current);
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

/** Resume an interrupted (restart) or failed stage in this process. */
export async function resumeCastAndSets(projectId, { providerId, model, effort } = {}) {
  assertLegacyCheckin(await requireProject(projectId));
  await reconcileOldCastSetsJobs(projectId);
  const out = await mutateProjectRecord(projectId, (current) => resumeCastAndSetsOnProject(current, { processId: PROCESS_ID, resolveNoteKeys: noteImageKeys }));
  console.log(`▶️ Music Video Cast & Sets ${short(projectId)} resumed (${out.stage.status})`);
  publish(projectId, out.project);
  if (out.stage.feedbackRenderPlan?.phase === 'ready') return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
  inBackground('The resume', projectId, () => {
    if (out.stage.feedbackRenderPlan?.kind === 'image') return writePlan(projectId, { forceKeys: out.stage.feedbackRenderPlan.forceKeys || [] });
    if (out.stage.feedbackRenderPlan?.kind === 'direction' && out.stage.direction && !(out.stage.notesApplied || []).length) return writePlan(projectId);
    if (out.stage.status === 'directing') return runDirection(projectId, { providerId, model, effort, notes: out.stage.notesApplied || [] });
    if (out.stage.status === 'assembling') return assemble(projectId);
    return advance(projectId);
  });
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
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
  const project = await requireProject(projectId);
  return { stage: presentStage(project), catalogCheckin: await resolveCatalogCheckin(project, { catalog: deps.catalog }) };
}

/** Recompute the offered repair under the project's serialized write. */
export async function repairShotReference(projectId, problemId) {
  const { project, sceneId, patch } = await mutateProjectRecord(projectId, async (current, { client } = {}) => {
    const checkin = await resolveCatalogCheckin(current, { catalog: deps.catalog, client, includeRepairPatches: true });
    const problem = checkin.shotReferenceProblems.find(row => row.id === problemId && row.patch);
    if (!problem) throw new ServerError('This shot reference suggestion changed. Review the current check-in and try again.', {
      status: 409, code: 'MUSIC_VIDEO_SHOT_REFERENCE_STALE',
    });
    const { sceneId, patch } = problem;
    const scenes = current.scenes.map(scene => scene.sceneId === sceneId ? { ...scene, ...patch } : scene);
    return { project: { ...current, scenes, updatedAt: new Date().toISOString() }, sceneId, patch };
  }, { sceneOnly: true });
  return { sceneId, patch, updatedAt: project.updatedAt };
}

// ---- completion hook entry points ----------------------------------------------------------

/**
 * A tagged image job ended. `filename` = it rendered; otherwise `error`.
 * Settles its key (idempotent) and, when the stage is dispatching in this
 * process, continues. Returns true when the record changed.
 */
export async function onCastAndSetsImageSettled({ projectId, key, editRequestId = null, jobId = null, filename = null, error = null, revision = null, productionRunId = null, productionStepKey = null, status = null }) {
  const project = await getProject(projectId);
  if (isCatalogCheckin(project)) return false;
  if (editRequestId) {
    if (!project) return false;
    return settleCastSetsImageEdit({ projectId, key, editRequestId, jobId, filename, error, status, productionRunId, productionStepKey }, publish);
  }
  if (!project?.castAndSets?.images?.[key]) return false;
  const out = await mutateProjectRecord(projectId, (current) => {
    assertLegacyCheckin(current);
    if (revision != null && revision !== current.castAndSets?.revision) return { project: current, changed: false };
    const next = productionRunId && productionStepKey
      ? settleProductionStep(current, productionRunId, productionStepKey, {
        status: filename ? 'completed' : status === 'canceled' ? 'canceled' : 'failed', jobId, error,
      }).project : current;
    const settled = settleCastAndSetsImage(next, key, { jobId, filename, error, revision });
    if (settled.stage?.status === 'failed') settled.project = refundUnusedCheckinSteps(settled.project);
    // A job queued before a resume hold may finish, but its failure must join
    // the reviewed plan instead of scheduling a retry behind the director's back.
    const plan = settled.stage?.feedbackRenderPlan;
    if (settled.changed && !filename && plan?.phase === 'ready') {
      const image = settled.stage.images[key];
      const held = { ...settled.stage, status: 'review', stopReason: null,
        images: { ...settled.stage.images, [key]: { ...image, status: 'pending', jobId: null, failures: 0 } },
        feedbackRenderPlan: { ...plan, keys: [...new Set([...plan.keys, key])] } };
      settled.stage = held;
      settled.project = { ...settled.project, castAndSets: held };
    }
    return settled;
  });
  if (!out.changed) return false;
  publish(projectId, out.project);
  if (out.stage?.processId === PROCESS_ID && out.stage.status === 'imaging') {
    advance(projectId).catch((err) => console.error(`❌ Music Video Cast & Sets ${short(projectId)} could not continue: ${err.message}${where(err)}`));
  }
  return true;
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
    return remap(await withCatalogCheckin(switched, { catalog: deps.catalog, client }));
  });
  if (moved) console.log(`🔁 Music Video Cast & Sets ${short(projectId)} moved ${moved} shot references to catalog images`);
  publish(projectId, out.project);
  return { project: out.project, stage: out.project.castAndSets, catalogCheckin: await resolveCatalogCheckin(out.project, { catalog: deps.catalog }) };
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
  const checkin = await resolveCatalogCheckin(started, { catalog: deps.catalog });
  assertCatalogCheckinReady(checkin);
  const images = {};
  for (const filename of catalogSheetImageFiles(checkin.items)) {
    const uri = await embedSheetImage(resolveGalleryImage(filename) || resolveImageRef(filename));
    if (uri) images[filename] = uri;
  }
  // Encoding takes seconds, so everything else is read after it: the shots and guide
  // selection stay current, and a catalog edited meanwhile would invalidate the images.
  const project = await requireProject(projectId);
  if (!isCatalogCheckin(project) || (await resolveCatalogCheckin(project, { catalog: deps.catalog })).basis !== checkin.basis) {
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

async function approveCatalogCheckin(projectId, { catalogBasis } = {}) {
  const out = await mutateProjectRecord(projectId, async (current, { client } = {}) => {
    if (!isCatalogCheckin(current)) throw new ServerError('The check-in changed. Reload it before approving.', { status: 409, code: 'CAST_SETS_PLAN_STALE' });
    const checkin = await resolveCatalogCheckin(current, { catalog: deps.catalog, client });
    assertCatalogCheckinReady(checkin);
    if (!catalogBasis || catalogBasis !== checkin.basis) throw new ServerError('The catalog check-in changed. Review the current links and images before approving.', { status: 409, code: 'CAST_SETS_CATALOG_STALE' });
    const now = new Date().toISOString();
    const stage = { ...current.castAndSets, status: 'approved', catalogApprovedBasis: checkin.basis, approvedAt: now, updatedAt: now };
    let next = { ...current, castAndSets: stage };
    if (stage.artifactId && (next.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted)) {
      next = reviewDevArtifact(next, stage.artifactId, { status: 'approved' }, now).project;
    }
    return settleAndRebase({ project: next }, now);
  });
  publish(projectId, out.project);
  return { project: out.project, stage: out.project.castAndSets, catalogCheckin: await resolveCatalogCheckin(out.project, { catalog: deps.catalog }) };
}
