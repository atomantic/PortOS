import { musicVideoAllowsMedia } from '../../lib/musicVideoMediaPolicy.js';
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
import { readFile } from 'fs/promises';
import { basename, extname } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { QUEUEABLE_IMAGE_MODES } from '../../lib/generationModes.js';
import { resolveGalleryImage, resolveImageRef } from '../../lib/pathSafety.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { trimTo } from '../../lib/textUtils.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';
import { effortArg, recordLlmRoute, resolveMusicVideoLlm } from './llmRoute.js';
import {
  allCastAndSetsImagesDone,
  assertCastAndSetsApprovable,
  castAndSetsCheckinMode,
  dispatchableImageKeys,
  linkCastAndSetsJob,
  presentCastAndSets,
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
  buildCastAndSetsPrompt,
  castAndSetsAllowsImages,
  castAndSetsMedium,
  mergeCastAndSetsDirection,
  moodBoardImageList,
  parseCastAndSetsResponse,
  songSections,
} from './castAndSetsDirection.js';
import {
  CAST_SETS_IMAGE_SIZE,
  affectedImageKeys,
  buildCastAndSetsImagePlan,
  castAndSetsReferences,
  castAndSetsSubjects,
  noteImageKeys,
} from './castAndSetsPlan.js';
import { renderCastAndSetsSheet } from './castAndSetsSheet.js';
import { findDevArtifact, reviewDevArtifact, resolveDevArtifactNotes } from './devArtifacts.js';
import { findProductionRun, haltProduction, rebaseProductionAfterCheckin, reserveProductionStep, settleProductionStep } from './production.js';

const PROCESS_ID = `proc-${randomUUID()}`;
const short = (id) => String(id || '').slice(3, 11);
const MAX_KEY_NOTES = 8;
const MAX_SUBMITTED_PROMPT = 20_000;
const MAX_SUBMITTED_REFERENCES = 16;

// Test seam: provider, queue, settings and mood-board access are swappable.
const defaults = {
  resolveProvider: async (opts) => resolveMusicVideoLlm(opts),
  runPrompt: async (opts) => (await import('../promptRunner.js')).runPromptThroughProvider(opts),
  getSettings: async () => (await import('../settings.js')).getSettings(),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  loadBoard: async (id) => (await import('../moodBoard/index.js')).getBoard(id),
  boardItemImage: async () => (await import('../moodBoard/logic.js')).boardItemLocalImage,
  loadTrack: async (id) => (await import('../tracks/index.js')).getTrack(id),
  readImage: (path) => readFile(path),
  imageParams: (settings, route, common) => imageJobParams(settings, route, common),
  resolveRoute: null,
};
let deps = { ...defaults };
export function __setCastAndSetsDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }
export const __castAndSetsProcessId = () => PROCESS_ID;

async function requireProject(id) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

function publish(projectId, project) {
  musicVideoEvents.emit('cast-and-sets', {
    projectId,
    stage: presentCastAndSets(project?.castAndSets, PROCESS_ID),
    project,
  });
}

async function fail(projectId, reason, error = null) {
  const out = await mutateProjectRecord(projectId, (current) => setCastAndSetsStatus(refundUnusedCheckinSteps(current), 'failed', { reason, error }));
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
  // Request pin > the brief's saved LLM > an eligible TUI provider > the active one (llmRoute.js).
  const { provider, selectedModel, route } = await deps.resolveProvider({ providerId, model, effort, automation: project.automation }).catch(() => ({ provider: null }));
  if (!provider) return fail(projectId, 'No AI provider is available for the creative direction');
  if (provider.enabled === false) return fail(projectId, `The ${provider.name || provider.id} provider is disabled`);
  const previous = stage?.direction || null;
  // A revision keeps the medium it was directed in; a fresh pass resolves it
  // from the project's policy and tools, so a saved direction is never
  // silently re-cast into the other medium.
  // A saved direction without a medium predates the procedural one: photographic.
  const medium = notes.length && previous ? (previous.medium || 'photographic') : castAndSetsMedium(project);
  const prompt = buildCastAndSetsPrompt(project, { moodImages, board, track, previous: notes.length ? previous : null, notes, medium });
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
  const { direction, missing } = mergeCastAndSetsDirection(notes.length ? previous : null, parsed, { sections, moodImageCount: moodImages.length, medium });
  if (missing.length) return fail(projectId, `The creative direction answer is missing: ${missing.join(', ')}`);
  // The photographic look every image prompt carries: the mood board's composed
  // style, else the project's visual style (never the board's literal places).
  direction.look = trimTo(board?.style?.prompt, 500) || trimTo(project.concept?.style, 500) || previous?.look || '';
  // The model picks the mood-board references; with none picked, the first
  // images of the board stand in so the character sheet still has a look.
  const picked = direction.moodRefs.length ? direction.moodRefs : moodImages.map((_, i) => i).slice(0, 3);
  const chosen = picked.map((i) => moodImages[i]).filter(Boolean).map(({ kind, filename }) => ({ kind, filename }));
  return writePlan(projectId, { direction, moodImages: chosen, forceKeys });
}

/** (Re)build the plan from the stage's direction + accumulated per-image notes, then dispatch. */
async function writePlan(projectId, { direction = null, moodImages = null, forceKeys = [] } = {}) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  const nextDirection = direction || stage.direction;
  // A procedural project whose brief names no image tool is code-only: nothing
  // is rendered, so no image backend is needed (or consulted).
  const codeOnly = !musicVideoAllowsMedia(project, 'image') || nextDirection.medium === 'procedural' && !castAndSetsAllowsImages(project);
  const plan = codeOnly ? {} : buildCastAndSetsImagePlan(project, nextDirection, { revisionNotes: keyNotesText(stage.keyNotes) });
  const renderKeys = affectedImageKeys(stage.plan || {}, plan, forceKeys);
  const settings = await deps.getSettings();
  const run = stage.productionRunId ? (project.productionRuns || []).find((r) => r.id === stage.productionRunId) : null;
  const preferred = run?.pool?.find((r) => r.kind === 'image') || stage.route || null;
  const route = codeOnly ? (stage.route || null) : await chooseCastAndSetsRoute(project, { preferred, settings });
  if (!route && !codeOnly) return fail(projectId, 'No enabled image backend is allowed for the Cast & Sets images — enable Codex (or another image tool in the brief) and resume');
  const out = await mutateProjectRecord(projectId, (current) => setCastAndSetsDirection(current, {
    direction: nextDirection, plan, moodImages, route, renderKeys,
  }));
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} r${out.stage.revision}: ${renderKeys.length} image(s) to render${route ? ` on ${route.mode}` : ' (code-only, no image backend)'}`);
  publish(projectId, out.project);
  return advance(projectId);
}

const keyNotesText = (keyNotes = {}) => Object.fromEntries(Object.entries(keyNotes).map(([k, list]) => [k, list.join('; ')]));

// ---- images -----------------------------------------------------------------------

function referencePaths(stage, item) {
  const paths = [];
  for (const key of item.refKeys || []) {
    const id = stage.images?.[key]?.imageId;
    const path = id ? resolveGalleryImage(id, { mustExist: false }) : null;
    if (path) paths.push(path);
  }
  if (item.moodRefs) {
    for (const ref of stage.moodImages || []) {
      if (paths.length >= 4) break;
      const path = ref.kind === 'image-ref' ? resolveImageRef(ref.filename, { mustExist: false }) : resolveGalleryImage(ref.filename, { mustExist: false });
      if (path) paths.push(path);
    }
  }
  return paths.slice(0, 4);
}

/** Job params for one image on the stage's route (cloud provider bag or the local model). */
async function imageJobParams(settings, route, common) {
  const [{ resolveRenderTargetConfig }, { resolveImageCleaners }, { resolveLocalImageModel }] = await Promise.all([
    import('../imageGen/cloudProviderConfig.js'),
    import('../imageGen/index.js'),
    import('../imageGen/prepareParams.js'),
  ]);
  const resolved = resolveRenderTargetConfig(settings, RENDER_TARGET.MUSIC_VIDEO, { mode: route.mode, model: route.model });
  // Never substitute another backend for the one the stage chose.
  if (resolved.mode !== route.mode) throw new ServerError(`The ${route.mode} image backend is not available`, { status: 409, code: 'CAST_SETS_ROUTE_UNAVAILABLE' });
  if (resolved.cloud && !resolved.cloud.enabled) throw resolved.cloud.disabledError;
  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, route.mode);
  if (resolved.cloud) return { ...resolved.cloud.jobParams, ...common, cleanC2PA, denoise };
  const { pythonPath, selectedModel } = resolveLocalImageModel(settings, { modelId: route.model || undefined });
  return { ...common, cleanC2PA, denoise, pythonPath, ...(selectedModel?.id ? { modelId: selectedModel.id } : {}) };
}

async function enqueueImage(project, stage, key) {
  const item = stage.plan[key];
  const referenceImagePaths = referencePaths(stage, item);
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
  const params = await withMusicVideoStyle(project, baseParams, stage.route.mode, stage.route.model, settings);
  // Persist the actual styled queue input, with only served local references.
  // Never expose the absolute host paths used by the provider transport.
  const submittedReferences = (params.referenceImagePaths || []).flatMap((path) => {
    if (typeof path !== 'string') return [];
    const filename = basename(path);
    if (resolveGalleryImage(filename, { mustExist: false }) === path) return [{ kind: 'image', filename }];
    if (resolveImageRef(filename, { mustExist: false }) === path) return [{ kind: 'image-ref', filename }];
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
  let next = project;
  for (const step of findProductionRun(project, runId).steps) {
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
    if (['CAST_SETS_IMAGE_BUSY', 'CAST_SETS_NOT_RUNNING'].includes(reserved.error.code)) return;
    throw reserved.error;
  }
  const productionStep = reserved.stage.productionRunId ? checkinStep(reserved.project, reserved.stage, key) : null;
  const runId = reserved.stage.productionRunId;
  const sent = await enqueueImage(reserved.project, reserved.stage, key).catch((err) => ({ error: err }));
  if (sent?.error || !sent?.jobId) {
    const reason = sent?.error?.message || 'The image job was not queued';
    const out = await mutateProjectRecord(projectId, (current) => {
      const next = productionStep ? settleProductionStep(current, runId, productionStep.key, { status: 'refused', error: reason }).project : current;
      const settled = settleCastAndSetsImage(next, key, { error: reason, revision: reserved.stage.revision });
      if (settled.stage?.status === 'failed') settled.project = refundUnusedCheckinSteps(settled.project);
      return settled;
    });
    console.warn(`⚠️ Music Video Cast & Sets ${short(projectId)} ${key} refused: ${reason}`);
    publish(projectId, out.project);
    return;
  }
  const linked = await mutateProjectRecord(projectId, (current) => {
    const next = productionStep ? settleProductionStep(current, runId, productionStep.key, { status: 'queued', jobId: sent.jobId }).project : current;
    return linkCastAndSetsJob(next, key, sent.jobId, sent.submission);
  });
  publish(projectId, linked.project);
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} ${key} → ${reserved.stage.route.mode} job ${String(sent.jobId).slice(0, 8)}`);
}

const advancing = new Map();

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

async function advanceOnce(projectId) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  if (!stage || stage.processId !== PROCESS_ID || stage.status !== 'imaging') return;
  if (allCastAndSetsImagesDone(stage)) {
    await assemble(projectId);
    return;
  }
  if (stage.productionRunId) {
    const run = findProductionRun(project, stage.productionRunId);
    if (run.status !== 'running') return;
    const reserved = await reserveCheckinPlan(projectId).catch((error) => ({ error }));
    if (reserved.error) {
      const limit = ['PRODUCTION_SPEND_LIMIT', 'PRODUCTION_BUDGET_EXHAUSTED'].includes(reserved.error.code);
      const out = await mutateProjectRecord(projectId, (current) => {
        const failed = setCastAndSetsStatus(refundUnusedCheckinSteps(current), 'failed', { reason: reserved.error.message });
        return haltProduction(failed.project, stage.productionRunId, {
          status: limit ? 'limit-reached' : 'blocked', reason: reserved.error.message,
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

function inBackground(label, projectId, fn) {
  Promise.resolve().then(fn).catch(async (err) => {
    console.error(`❌ Music Video Cast & Sets ${short(projectId)} ${label} failed: ${err.message}`);
    await fail(projectId, `${label} failed: ${err.message}`).catch(() => {});
  });
}

// ---- sheet ----------------------------------------------------------------------------

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function embeddedImages(stage) {
  const out = {};
  for (const [key, img] of Object.entries(stage.images || {})) {
    const path = img.imageId ? resolveGalleryImage(img.imageId, { mustExist: false }) : null;
    const mime = path ? MIME[extname(path).toLowerCase()] : null;
    if (!path || !mime) continue;
    const bytes = await deps.readImage(path).catch(() => null);
    if (bytes) out[key] = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  return out;
}

/** Build the sheet, save it as the stage's development artifact, then check in. */
async function assemble(projectId) {
  const marked = await mutateProjectRecord(projectId, (current) => setCastAndSetsStatus(current, 'assembling'));
  publish(projectId, marked.project);
  const project = marked.project;
  const stage = marked.stage;
  const mode = castAndSetsCheckinMode(project);
  const html = renderCastAndSetsSheet({
    title: project.name,
    project,
    direction: stage.direction,
    images: await embeddedImages(stage),
    sections: songSections(project),
    durationSec: project.audioAnalysis?.durationSec ?? null,
    bpm: project.audioAnalysis?.bpm ?? null,
    revision: stage.revision,
    notesApplied: stage.notesApplied || [],
    checkinMode: mode,
    status: mode === 'auto' ? 'approved' : 'review',
  });
  const { saveGeneratedDevArtifact } = await import('./devArtifactService.js');
  const existing = stage.artifactId && (project.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted) ? stage.artifactId : null;
  const { artifact } = await saveGeneratedDevArtifact(projectId, {
    artifactId: existing,
    kind: 'cast-sets',
    title: `Cast & Sets — ${stage.direction?.protagonist?.name || project.name}`,
    html,
    source: 'cast-and-sets',
  });
  const out = await mutateProjectRecord(projectId, (current) => setCastAndSetsStatus(current, 'review', {
    extra: { artifactId: artifact.id, artifactVersion: artifact.version },
  }));
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} sheet v${artifact.version} ready (${mode === 'auto' ? 'auto-approve' : 'waiting for check-in'})`);
  if (mode === 'auto') return approveCastAndSets(projectId);
  publish(projectId, out.project);
  return out;
}

// ---- approval ------------------------------------------------------------------------

/**
 * Apply an approved check-in to the project (references, subjects), approve
 * its artifact, and re-base a production run that was waiting on it.
 */
function applyApproval(project, now) {
  const stage = project.castAndSets;
  let next = {
    ...project,
    visualSpec: {
      references: [], palette: [], typography: '', cameraRules: '', moodBoardId: null,
      ...(project.visualSpec || {}),
      references: castAndSetsReferences(project, stage),
    },
    concept: { ...(project.concept || {}), subjects: castAndSetsSubjects(project, stage) },
  };
  if (stage.artifactId && (next.devArtifacts || []).some((a) => a.id === stage.artifactId && !a.deleted)) {
    next = reviewDevArtifact(next, stage.artifactId, { status: 'approved' }, now).project;
  }
  return setCastAndSetsStatus(next, 'approved', {}, now);
}

// Settle the stage and re-base a production run waiting on it, in ONE write,
// so the run never observes the new references without its new basis.
const settleAndRebase = (next, now) => {
  const { project } = rebaseProductionAfterCheckin(next.project, now);
  return { project, stage: project.castAndSets };
};

/** Approve & continue. Returns `{ project, stage }`. */
export async function approveCastAndSets(projectId) {
  const now = new Date().toISOString();
  const out = await mutateProjectRecord(projectId, (current) => {
    assertCastAndSetsApprovable(current);
    return settleAndRebase(applyApproval(current, now), now);
  });
  console.log(`✅ Music Video Cast & Sets ${short(projectId)} approved (r${out.stage.revision})`);
  publish(projectId, out.project);
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Skip the check-in (e.g. no image backend): the autopilot continues without it. */
export async function skipCastAndSets(projectId) {
  await requireProject(projectId);
  const now = new Date().toISOString();
  const out = await mutateProjectRecord(projectId, (current) => {
    const base = current.castAndSets ? current : { ...current, castAndSets: { revision: 0, images: {}, plan: {}, createdAt: now } };
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
  if (!Array.isArray(project.audioAnalysis?.sections) || !project.audioAnalysis.sections.length) {
    throw new ServerError('Analyze the song before the Cast & Sets check-in', { status: 409, code: 'NOT_ANALYZED' });
  }
  const out = await mutateProjectRecord(projectId, (current) => startCastAndSetsOnProject(current, { processId: PROCESS_ID, productionRunId }));
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} started (r${out.stage.revision})`);
  publish(projectId, out.project);
  inBackground('The creative direction', projectId, () => runDirection(projectId, { providerId, model, effort }));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/**
 * Regenerate with notes. `notes` default to the open notes on the stage's
 * sheet. A note aimed at an image (`character`, `looks`, `set:<id>`,
 * `test:<n>`, …) re-renders that image and what depends on it; any other
 * note revises the direction, and only images whose prompt changed re-render.
 * The consumed notes are resolved on the sheet. Returns `{ project, stage }`.
 */
export async function regenerateCastAndSets(projectId, { notes = null, providerId, model, effort } = {}) {
  const project = await requireProject(projectId);
  const stage = project.castAndSets;
  if (!stage?.direction) throw new ServerError('There is no Cast & Sets sheet to regenerate yet', { status: 409, code: 'CAST_SETS_NO_DIRECTION' });
  const artifact = stage.artifactId ? (() => { try { return findDevArtifact(project, stage.artifactId); } catch { return null; } })() : null;
  const source = Array.isArray(notes) ? notes : (artifact?.notes || []).filter((n) => !n.resolvedAt);
  if (!source.length) throw new ServerError('Add a note first — nothing says what to change', { status: 422, code: 'CAST_SETS_NO_NOTES' });
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
    const revised = reviseCastAndSetsOnProject(current, { processId: PROCESS_ID, notesApplied: source, redirect });
    const keyNotes = { ...(revised.stage.keyNotes || {}) };
    for (const [k, list] of Object.entries(imageNotes)) keyNotes[k] = [...(keyNotes[k] || []), ...list].slice(-MAX_KEY_NOTES);
    let next = { ...revised.project, castAndSets: { ...revised.stage, keyNotes } };
    if (artifact && consumed.size) next = resolveDevArtifactNotes(next, artifact.id, (n) => consumed.has(n.id)).project;
    return { project: next, stage: next.castAndSets };
  });
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} regenerating r${out.stage.revision} (${source.length} note(s)${redirect ? ', new direction' : ''})`);
  publish(projectId, out.project);
  const forceKeys = Object.keys(imageNotes);
  inBackground('The regeneration', projectId, () => (redirect
    ? runDirection(projectId, { providerId, model, effort, notes: directionNotes, forceKeys })
    : writePlan(projectId, { forceKeys })));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/**
 * Save the director's direct edits to a procedural direction (construction,
 * palette, expressions, movement, world rules, per-set image role) through the
 * revision path: the stage re-opens as a new revision, the edited direction is
 * persisted in the same write, and only images whose prompt changed re-render
 * before the sheet is re-assembled. No direction (text) provider call is made;
 * a changed image prompt is the director's save acting on the image queue.
 * Returns `{ project, stage }`.
 */
export async function editCastAndSetsDirection(projectId, edits) {
  const project = await requireProject(projectId);
  const sections = songSections(project);
  let changed = [];
  const out = await mutateProjectRecord(projectId, (current) => {
    const stage = current.castAndSets;
    if (!stage?.direction) throw new ServerError('There is no Cast & Sets direction to edit yet', { status: 409, code: 'CAST_SETS_NO_DIRECTION' });
    assertCastAndSetsApprovable(current);
    const edited = applyCastAndSetsDirectionEdits(stage.direction, edits, { sections });
    if (!edited.changed.length) throw new ServerError('Nothing changed — edit a field first', { status: 422, code: 'CAST_SETS_NO_EDITS' });
    changed = edited.changed;
    const notesApplied = [{ id: null, target: 'direction', text: `Edited by the director: ${changed.join(', ')}` }];
    const revised = reviseCastAndSetsOnProject(current, { processId: PROCESS_ID, notesApplied, redirect: false });
    const next = { ...revised.project, castAndSets: { ...revised.stage, direction: edited.direction } };
    return { project: next, stage: next.castAndSets };
  });
  console.log(`🎭 Music Video Cast & Sets ${short(projectId)} direction edited r${out.stage.revision} (${changed.length} field(s))`);
  publish(projectId, out.project);
  inBackground('The direction edit', projectId, () => writePlan(projectId));
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** Resume an interrupted (restart) or failed stage in this process. */
export async function resumeCastAndSets(projectId, { providerId, model, effort } = {}) {
  const out = await mutateProjectRecord(projectId, (current) => resumeCastAndSetsOnProject(current, { processId: PROCESS_ID }));
  console.log(`▶️ Music Video Cast & Sets ${short(projectId)} resumed (${out.stage.status})`);
  publish(projectId, out.project);
  inBackground('The resume', projectId, () => {
    if (out.stage.status === 'directing') return runDirection(projectId, { providerId, model, effort, notes: out.stage.notesApplied || [] });
    if (out.stage.status === 'assembling') return assemble(projectId);
    return advance(projectId);
  });
  return { project: out.project, stage: presentCastAndSets(out.stage, PROCESS_ID) };
}

/** The stage as the director sees it. */
export async function getCastAndSets(projectId) {
  const project = await requireProject(projectId);
  return { stage: presentCastAndSets(project.castAndSets, PROCESS_ID) };
}

// ---- completion hook entry points ----------------------------------------------------------

/**
 * A tagged image job ended. `filename` = it rendered; otherwise `error`.
 * Settles its key (idempotent) and, when the stage is dispatching in this
 * process, continues. Returns true when the record changed.
 */
export async function onCastAndSetsImageSettled({ projectId, key, jobId = null, filename = null, error = null, revision = null, productionRunId = null, productionStepKey = null, status = null }) {
  const project = await getProject(projectId);
  if (!project?.castAndSets?.images?.[key]) return false;
  const out = await mutateProjectRecord(projectId, (current) => {
    if (revision != null && revision !== current.castAndSets?.revision) return { project: current, changed: false };
    const next = productionRunId && productionStepKey
      ? settleProductionStep(current, productionRunId, productionStepKey, {
        status: filename ? 'completed' : status === 'canceled' ? 'canceled' : 'failed', jobId, error,
      }).project : current;
    const settled = settleCastAndSetsImage(next, key, { jobId, filename, error, revision });
    if (settled.stage?.status === 'failed') settled.project = refundUnusedCheckinSteps(settled.project);
    return settled;
  });
  if (!out.changed) return false;
  publish(projectId, out.project);
  if (out.stage?.processId === PROCESS_ID && out.stage.status === 'imaging') {
    advance(projectId).catch((err) => console.error(`❌ Music Video Cast & Sets ${short(projectId)} could not continue: ${err.message}`));
  }
  return true;
}
