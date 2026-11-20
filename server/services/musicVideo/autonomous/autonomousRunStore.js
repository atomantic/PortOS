/** The autonomous run record, process ownership and lazy execution dependencies. */

import {
  approveProductionReview,
  reverifyProductionAlignment,
  addProductionFeedback,
  closeProductionFeedback,
  reviseProductionFromFeedback,
} from '../productionReviewService.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS } from '../../../lib/fileUtils.js';
import { probeVideoDuration } from '../../../lib/ffmpeg.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { getProject, mutateProjectRecord as mutateRecord, createProject, updateProject } from '../projects.js';
import { requireProject } from '../requireProject.js';
import { musicVideoEvents } from '../events.js';
import { getTrack } from '../../tracks/index.js';
import { resolveGalleryImage } from '../../../lib/pathSafety.js';
import { supportsSourceAudioWindow } from '../../federatedMedia/sourceAudio.js';

export const mutateProjectRecord = (id, transform) => mutateRecord(id, transform, { source: 'orchestrator' });

export const PROCESS_ID = `proc-${randomUUID()}`;

export const short = (id) => String(id).slice(0, 8);

// Lazy imports keep this module's static closure small: it is reached by the
// route table and the scheduled handler, and each dependency below pulls a
// whole subtree (LLM runner, mood board store, browser driver, production).
const defaults = {
  createProject: async (input) => createProject(input),
  updateProject: async (id, patch) => updateProject(id, patch),
  resolveLlm: async (pin) => (await import('../llmRoute.js')).resolveMusicVideoLlm(pin),
  recordRoute: async (projectId, stage, route) => (await import('../llmRoute.js')).recordLlmRoute(projectId, stage, route),
  draftCreativeBrief: async (args) => (await import('../autonomousBrief.js')).draftCreativeBrief(args),
  writeLyrics: async (args) => (await import('../../musicDesigner.js')).writeLyrics(args),
  reviewLyrics: async (args) => (await import('../../musicDesigner.js')).reviewLyrics(args),
  createMoodBoard: async (spec, opts) => (await import('../autonomousBoard.js')).createAutonomousMoodBoard(spec, opts),
  generateSunoSong: async (fields, opts) => (await import('../autonomousSuno.js')).generateSunoSong(fields, opts),
  submitSunoSong: async (fields, opts) => (await import('../autonomousSuno.js')).submitSunoSongOnly(fields, opts),
  generateLocalSong: async (args) => (await import('../autonomousLocalSong.js')).generateLocalSong(args),
  cancelLocalSong: async (jobId) => (await import('../../mediaJobQueue/index.js')).cancelJob(jobId),
  getTrack: async (id) => getTrack(id).catch(() => null),
  createTrack: async (input) => (await import('../../trackAlbumMembership.js')).createTrackWithAlbum(input).then((r) => r.track),
  attachAudio: async (trackId, filename, take) => (await import('../../trackAudioAttach.js')).attachAudioAsRender(trackId, filename, take),
  probeDuration: (filename) => probeVideoDuration(join(PATHS.music, filename)).catch(() => null),
  analyzeSong: async (projectId) => (await import('../projectAudio.js')).analyzeProjectSong(projectId),
  transcribeMidi: async (project) => (await import('../projectMidi.js')).transcribeProjectMidi(project),
  designCoverArt: async (projectId, input) => (await import('../coverArt.js')).designCoverArt(projectId, input),
  startProduction: async (...args) => (await import('../productionService.js')).startProduction(...args),
  resumeProduction: async (...args) => (await import('../productionService.js')).resumeProduction(...args),
  stopProduction: async (...args) => (await import('../productionService.js')).stopProduction(...args),
  cancelProduction: async (...args) => (await import('../productionService.js')).cancelProduction(...args),
  generateDocument: async (...args) => (await import('../documentGeneration.js')).generateMixedMediaDocument(...args),
  acceptDocument: async (...args) => (await import('../documentGeneration.js')).acceptMixedMediaDocument(...args),
  generateCode: async (...args) => (await import('../codeGeneration.js')).generateMusicVideoCode(...args),
  renderVideo: async (...args) => (await import('../render.js')).renderMusicVideo(...args),
  activeRenderJobId: async (projectId) => (await import('../render.js')).getActiveRenderJobId(projectId),
  cancelRender: async (jobId) => (await import('../render.js')).cancelRender(jobId),
  // An interrupted (previous process) Cast & Sets stage re-pins to this one; true when it did.
  resumeInterruptedCastAndSets: async (project) => {
    const { presentProjectCastAndSets, resumeCastAndSets } = await import('../castAndSetsService.js');
    if (!presentProjectCastAndSets(project).castAndSets?.interrupted) return false;
    await resumeCastAndSets(project.id);
    return true;
  },
  // The review persistence path; session authority was checked on start/resume.
  approveProductionReview: async (...args) => approveProductionReview(...args),
  // Orchestrated mode: the reviewer call, and the edits a reviewer makes by hand.
  orchestrate: async (args) => (await import('../orchestratorReview.js')).askOrchestrator(args),
  alignLyrics: async (projectId) => (await import('../lyricAlign.js')).alignProjectLyrics(projectId),
  verifyAlignment: async (...args) => reverifyProductionAlignment(...args),
  addFeedback: async (...args) => addProductionFeedback(...args),
  closeFeedback: async (...args) => closeProductionFeedback(...args),
  reviseFromFeedback: async (...args) => reviseProductionFromFeedback(...args),
  guideImagePath: async (artifact) => (await import('../devArtifactStore.js')).resolveDevArtifactFile(artifact.file),
  // Can this local video model take a shot's song window (an LTX a2v model)?
  localVideoTakesSongAudio: async (modelId) => {
    const { resolveVideoModelSelection } = await import('../../videoGen/modelSelection.js');
    return supportsSourceAudioWindow((await resolveVideoModelSelection(modelId || undefined)).model);
  },
  // A gallery image (a Cast & Sets plate, a production still) the orchestrator looks at.
  galleryImagePath: async (filename) => resolveGalleryImage(filename),
  finalReviewFrames: async (jobId) => (await import('../orchestratorReview.js')).captureFinalReviewFrames(jobId),
  // The overlay text pass before a final render: resolves the finished check.
  checkOverlayText: async (projectId) => (await import('../overlayTextService.js')).startOverlayTextCheck(projectId).then((started) => started.done),
  // The final-video revision of footage: a board-owned auto-review over the flagged window.
  startAutoReview: async (...args) => (await import('../autoReviewService.js')).startAutoReview(...args),
  cancelAutoReview: async (...args) => (await import('../autoReviewService.js')).cancelAutoReview(...args),
  stopAutoReview: async (...args) => (await import('../autoReviewService.js')).stopAutoReview(...args),
  resumeAutoReview: async (...args) => (await import('../autoReviewService.js')).resumeAutoReview(...args),
  wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};
export let deps = { ...defaults };
export function __setAutonomousDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }

export const runError = (status, code, message, context) =>
  new ServerError(message, { status, code, ...(context ? { context } : {}) });

export const projectAutonomousRun = (project) => project?.autonomousRun || null;
export const ownsRunningRun = (current, run) => current?.id === run.id && current.status === 'running' && current.processId === PROCESS_ID;

export async function requireRun(projectId) {
  const project = await requireProject(projectId);
  const run = projectAutonomousRun(project);
  if (!run) throw runError(404, 'NO_AUTONOMOUS_RUN', 'This project has no autonomous run');
  return { project, run };
}

/** The run as the client sees it: `interrupted` when it was pinned to a previous server process. */
export const presentAutonomousRun = (run) => (run
  ? { ...run, interrupted: run.status === 'running' && run.processId !== PROCESS_ID }
  : null);

/** `presentAutonomousRun` for a project read; reader-only — never persist the result. */
export const presentProjectAutonomousRun = (project) => (project?.autonomousRun
  ? { ...project, autonomousRun: presentAutonomousRun(project.autonomousRun) }
  : project);

/** Test seam: this process's pin id. */
export const __autonomousProcessId = () => PROCESS_ID;

export function publish(project, run) {
  musicVideoEvents.emit('autonomous', { projectId: project.id, runId: run.id, run: presentAutonomousRun(run), project: { ...project, autonomousRun: presentAutonomousRun(run) } });
}

/** One serialized write of the run record; `fn` returns the patch to merge. */
export async function patchRun(projectId, fn) {
  const now = new Date().toISOString();
  const out = await mutateProjectRecord(projectId, (current) => {
    const run = projectAutonomousRun(current);
    if (!run) throw runError(404, 'NO_AUTONOMOUS_RUN', 'This project has no autonomous run');
    const patch = fn(run, current) || {};
    const next = {
      ...run,
      ...patch,
      stages: { ...run.stages, ...(patch.stages || {}) },
      output: { ...run.output, ...(patch.output || {}) },
      updatedAt: now,
    };
    return { project: { ...current, autonomousRun: next }, run: next };
  });
  publish(out.project, out.run);
  return out;
}

export const stagePatch = (run, stage, patch) => ({ stages: { [stage]: { ...run.stages[stage], ...patch } } });

export const latestRun = async (projectId) => projectAutonomousRun(await getProject(projectId));

/** The run still waits on this production run (a stop or cancel during a settle releases it). */
export async function ownsProduction(projectId, productionRunId) {
  const latest = projectAutonomousRun(await getProject(projectId));
  return latest?.status === 'running' && latest.processId === PROCESS_ID && latest.output?.productionRunId === productionRunId;
}

export const RENDER_STEP = 'rendering';
export const CAST_STEP = 'cast-and-sets';

export function logParkedRun(run, status, error) {
  const log = status === 'failed' ? console.error : status === 'completed' ? console.log : console.warn;
  log(`${status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏸️'} Autonomous music video ${short(run.id)} ${status}${error ? `: ${error}` : ''}`);
}

export async function park(projectId, status, patch) {
  const out = await patchRun(projectId, () => ({ status, ...patch }));
  logParkedRun(out.run, status, patch.error);
  return out;
}

/**
 * Stop one delegated child after the run is already marked stopped/canceled. A 404/409 means
 * the child is gone or already terminal (benign); anything else is logged and recorded in
 * `failures` so the response can say work may still be running. Never throws.
 */
export async function settleChildStop(failures, projectId, run, action, childId, call) {
  try {
    await call();
  } catch (err) {
    if (err?.status === 404 || err?.status === 409) return;
    const message = err?.message || String(err);
    console.error(`❌ Autonomous music video ${short(run.id)} (project ${projectId}) could not ${action} ${childId}: ${message}`);
    failures.push({ kind: action, id: childId, error: message });
  }
}

/**
 * The LLM for one of a run's stages, resolved each time the stage runs: the
 * run's pin for that stage (`brief.llmStages[stage]`), else — for `authoring` —
 * its code-authoring pin, else its direction pin (`brief.llm`), else an
 * eligible TUI provider, else the active one (llmRoute.js). The resolved route
 * rides along (`route`) so the stage can record it on the run; a failed
 * registry read degrades to the plain pin rather than failing the stage.
 */
export async function llmOf(run, stage) {
  const { llm, llmStages, authoring } = run.brief;
  const own = llmStages?.[stage] || (stage === 'authoring' && authoring) || llm;
  const pin = { providerId: own?.providerId, model: own?.model || undefined, effort: own?.effort || undefined };
  const resolved = await deps.resolveLlm({
    stage,
    automation: { llm: llm || null, llmStages: llmStages || null },
    ...(stage === 'authoring' && authoring ? { authoring } : {}),
  }).catch((err) => {
    console.warn(`⚠️ Autonomous music video: LLM route resolution failed: ${err.message}`);
    return null;
  });
  const route = resolved?.route;
  if (!route) return { ...pin, route: null };
  return { providerId: route.providerId, model: route.model || undefined, effort: route.effort || undefined, route };
}
