/**
 * Fully-autonomous Music Video — the run orchestrator.
 *
 * One prompt drives a whole video: creative brief → lyrics → mood board & style
 * → Suno song (PortOS Browser) → beat analysis → the existing production run
 * (image/video tools) or a code-rendered video. The vocabulary, brief shape and
 * Suno field limits live in `lib/musicVideoAutonomous.js`.
 *
 * The run is an install-local checkpoint on the project (`project.autonomousRun`,
 * wire-local like `productionRuns`: it names this install's providers and the
 * peer must never execute it). Each stage settles in one serialized project
 * write, so a crash resumes at the stage that did not settle; a stage's output
 * is stored before the next one reads it. `processId` pins a running run to the
 * server process that started it — after a restart nothing advances until the
 * operator (or the scheduled task) explicitly resumes (AI Provider Usage
 * Policy: no cold-bootstrap work).
 *
 * Checkpoints are optional approval gates after `lyrics` / `style` / `song`:
 * the run parks `awaiting-approval` and continues on approve. A signed-out
 * Suno parks `needs-human`; any other failure parks `failed`. Both resume at the
 * stage that stopped, reusing Suno songs already submitted. A brief may instead
 * (or as a fallback, `localFallback`) make the song with the on-device Music
 * Designer engines (`autonomousLocalSong.js`), so a run finishes with Suno
 * unavailable.
 *
 * Production is delegated: `produce` starts the server-owned production run (or
 * the code render) and finishes when that reports back over the `production`
 * event. Only explicit start/resume requests begin work.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';
import { trimTo } from '../../lib/textUtils.js';
import {
  AUTONOMOUS_LIVE_STATUSES,
  AUTONOMOUS_STAGE_IDS,
  autonomousMedium,
  autonomousPool,
  nextAutonomousStage,
  normalizeAutonomousBrief,
  sunoSongFields,
} from '../../lib/musicVideoAutonomous.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';

const PROCESS_ID = `proc-${randomUUID()}`;
const inflight = new Map();
const sunoControllers = new Map();
const short = (id) => String(id).slice(0, 8);

// Lazy imports keep this module's static closure small: it is reached by the
// route table and the scheduled handler, and each dependency below pulls a
// whole subtree (LLM runner, mood board store, browser driver, production).
const defaults = {
  createProject: async (input) => (await import('./projects.js')).createProject(input),
  updateProject: async (id, patch) => (await import('./projects.js')).updateProject(id, patch),
  resolveLlm: async (pin) => (await import('./llmRoute.js')).resolveMusicVideoLlm(pin),
  draftCreativeBrief: async (args) => (await import('./autonomousBrief.js')).draftCreativeBrief(args),
  writeLyrics: async (args) => (await import('../musicDesigner.js')).writeLyrics(args),
  createMoodBoard: async (spec) => (await import('./autonomousBoard.js')).createAutonomousMoodBoard(spec),
  generateSunoSong: async (fields, opts) => (await import('./autonomousSuno.js')).generateSunoSong(fields, opts),
  generateLocalSong: async (args) => (await import('./autonomousLocalSong.js')).generateLocalSong(args),
  cancelLocalSong: async (jobId) => (await import('../mediaJobQueue/index.js')).cancelJob(jobId),
  createTrack: async (input) => (await import('../trackAlbumMembership.js')).createTrackWithAlbum(input).then((r) => r.track),
  attachAudio: async (trackId, filename, take) => (await import('../trackAudioAttach.js')).attachAudioAsRender(trackId, filename, take),
  probeDuration: (filename) => probeVideoDuration(join(PATHS.music, filename)).catch(() => null),
  analyzeSong: async (projectId) => (await import('./projectAudio.js')).analyzeProjectSong(projectId),
  startProduction: async (...args) => (await import('./productionService.js')).startProduction(...args),
  generateCode: async (...args) => (await import('./codeGeneration.js')).generateMusicVideoCode(...args),
  renderVideo: async (...args) => (await import('./render.js')).renderMusicVideo(...args),
};
let deps = { ...defaults };
export function __setAutonomousDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }

const runError = (status, code, message, context) =>
  new ServerError(message, { status, code, ...(context ? { context } : {}) });

const projectAutonomousRun = (project) => project?.autonomousRun || null;

async function requireRun(projectId) {
  const project = await getProject(projectId);
  if (!project) throw runError(404, 'NOT_FOUND', 'Project not found');
  const run = projectAutonomousRun(project);
  if (!run) throw runError(404, 'NO_AUTONOMOUS_RUN', 'This project has no autonomous run');
  return { project, run };
}

/** The run as the client sees it: `interrupted` when it was pinned to a previous server process. */
export const presentAutonomousRun = (run) => (run
  ? { ...run, interrupted: run.status === 'running' && run.processId !== PROCESS_ID }
  : null);

function publish(project, run) {
  musicVideoEvents.emit('autonomous', { projectId: project.id, runId: run.id, run: presentAutonomousRun(run), project: { ...project, autonomousRun: presentAutonomousRun(run) } });
}

/** One serialized write of the run record; `fn` returns the patch to merge. */
async function patchRun(projectId, fn) {
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

const stagePatch = (run, stage, patch) => ({ stages: { [stage]: { ...run.stages[stage], ...patch } } });

// ---- stage executors -------------------------------------------------------------
// Each returns `{ output }` (merged into run.output) or `{ output, wait: true }`
// when the stage's completion arrives later (production).

/**
 * The direction LLM for a run's text stages, resolved once per stage: the run's
 * pin, else an eligible TUI provider, else the active one (llmRoute.js). The
 * resolved route rides along (`route`) so the stage can record it on the run;
 * a failed registry read degrades to the plain pin rather than failing the stage.
 */
async function llmOf(run) {
  const pin = { providerId: run.brief.llm?.providerId, model: run.brief.llm?.model || undefined, effort: run.brief.llm?.effort || undefined };
  const resolved = await deps.resolveLlm(pin).catch((err) => {
    console.warn(`⚠️ Autonomous music video: LLM route resolution failed: ${err.message}`);
    return null;
  });
  const route = resolved?.route;
  if (!route) return { ...pin, route: null };
  return { providerId: route.providerId, model: route.model || undefined, effort: route.effort || undefined, route };
}

/**
 * The local song source: the track is created first (its id is stored at once),
 * the render is queued onto it, and the stage settles once the audio has landed.
 * A retry rejoins the stored render instead of queuing a second one.
 */
async function localSong({ project, run, save }) {
  const title = trimTo(run.output.title, 200) || 'Untitled';
  const lyrics = run.brief.instrumental ? '' : run.output.lyrics || '';
  // The style line is editable at the style checkpoint, so it conditions the render alongside the description.
  const prompt = [run.output.musicalDescription, run.output.sunoStyle].filter(Boolean).join('\n\n') || run.brief.prompt;
  let trackId = run.output.localTrackId;
  if (!trackId) {
    const track = await deps.createTrack({ title, concept: run.brief.prompt, lyrics, prompt });
    trackId = track.id;
    await save({ output: { localTrackId: trackId } });
  }
  await deps.generateLocalSong({
    trackId, title, prompt, lyrics, instrumental: run.brief.instrumental, jobId: run.output.localSongJobId,
    onSubmitted: async (jobId) => {
      await save({ output: { localSongJobId: jobId } });
      // Stop/cancel cancel the job they find on the record; one that landed
      // before this id was stored never saw it, so settle that race here.
      const latest = projectAutonomousRun(await getProject(project.id));
      if (latest?.status === 'running' && latest.processId === PROCESS_ID) return;
      await deps.cancelLocalSong(jobId).catch(() => {});
      throw runError(409, 'NOT_RUNNING', 'The run was stopped before its song render started');
    },
  });
  // Linking the track seeds the project's timed lyric cues from the track lyrics.
  await deps.updateProject(project.id, { trackId });
  return { output: { trackId, songSource: 'local' } };
}

const STAGES = {
  async brief({ project, run }) {
    const { route, ...llm } = await llmOf(run);
    const { brief } = await deps.draftCreativeBrief({
      prompt: run.brief.prompt, guidance: run.brief.guidance, instrumental: run.brief.instrumental, ...llm,
    });
    // A blank project name from the prompt gives way to the song title.
    if (!run.brief.name) await deps.updateProject(project.id, { name: trimTo(brief.title, 200) });
    return { output: { ...brief, ...(route ? { briefRoute: route } : {}) } };
  },

  async lyrics({ run }) {
    if (run.brief.instrumental) return { output: { lyrics: '' } };
    const { route, ...llm } = await llmOf(run);
    const { lyrics } = await deps.writeLyrics({
      description: run.output.musicalDescription, guidance: run.brief.guidance || undefined, ...llm,
    });
    return { output: { lyrics, ...(route ? { lyricsRoute: route } : {}) } };
  },

  async style({ project, run }) {
    const board = run.output.moodBoard;
    const moodBoardId = run.brief.moodBoardId || run.output.moodBoardId || (await deps.createMoodBoard(board)).id;
    // The board is also the project's linked mood board; the server derives the
    // authored style snapshot from it (styleSnapshots.js).
    await deps.updateProject(project.id, {
      concept: { prompt: run.output.concept.prompt, ...(run.output.concept.style ? { style: run.output.concept.style } : {}) },
      visualSpec: { moodBoardId },
    });
    return { output: { moodBoardId } };
  },

  async song({ project, run, save }) {
    if (run.output.trackId) return { output: {} };
    // `output.songSource` records a fallback already taken, so a resume stays local.
    if ((run.output.songSource || run.brief.songSource) === 'local') return localSong({ project, run, save });
    const fields = sunoSongFields({
      title: run.output.title, style: run.output.sunoStyle, lyrics: run.output.lyrics, instrumental: run.brief.instrumental,
    });
    let submitted = run.output.sunoSongIds?.length > 0;
    let song;
    const controller = new AbortController();
    sunoControllers.set(run.id, controller);
    try {
      const latest = projectAutonomousRun(await getProject(project.id));
      if (latest?.id !== run.id || latest.status !== 'running') controller.abort();
      controller.signal.throwIfAborted();
      song = await deps.generateSunoSong(fields, {
        songIds: run.output.sunoSongIds,
        signal: controller.signal,
        // Stored the moment Suno accepts the request, so a failed download retries
        // the same songs instead of spending credits on another generation.
        onSubmitted: (ids) => { submitted = true; return save({ output: { sunoSongIds: ids } }); },
      });
    } catch (err) {
      // Only before Suno accepted a request: after that, credits are spent and a
      // retry reuses those songs rather than paying for a second render.
      if (controller.signal.aborted || !run.brief.localFallback || submitted) throw err;
      console.warn(`⚠️ Autonomous music video ${short(run.id)} could not use Suno (${trimTo(err.message, 200)}) — rendering the song locally`);
      await save({ output: { songSource: 'local', songFallbackReason: trimTo(err.message, 500) } });
      return localSong({ project, run, save });
    } finally {
      sunoControllers.delete(run.id);
    }
    controller.signal.throwIfAborted();
    const track = await deps.createTrack({
      title: fields.title, concept: run.brief.prompt, lyrics: fields.lyrics, prompt: fields.style,
    });
    const durationSec = await deps.probeDuration(song.filename);
    await deps.attachAudio(track.id, song.filename, { source: 'suno', prompt: fields.style, lyrics: fields.lyrics, durationSec });
    // Linking the track seeds the project's timed lyric cues from the track lyrics.
    await deps.updateProject(project.id, { trackId: track.id });
    return { output: { trackId: track.id, sunoSongIds: song.songIds } };
  },

  async analyze({ project }) {
    await deps.analyzeSong(project.id);
    return { output: {} };
  },

  async produce({ project, run }) {
    const medium = autonomousMedium(run.brief.tools);
    if (medium === 'code') {
      await deps.updateProject(project.id, { composition: { mode: 'code' } });
      const authoring = run.brief.authoring || (run.brief.llm ? { providerId: run.brief.llm.providerId, model: run.brief.llm.model, effort: run.brief.llm.effort } : {});
      await deps.generateCode(project.id, {
        providerId: authoring.providerId, model: authoring.model || undefined, ...(authoring.effort ? { effort: authoring.effort } : {}),
      });
      const render = await deps.renderVideo(project.id);
      return { output: { renderJobId: render?.jobId || null } };
    }
    const started = await deps.startProduction(project.id, {
      directive: trimTo([run.brief.prompt, run.brief.guidance].filter(Boolean).join('\n\n'), 4000),
      pool: autonomousPool(run.brief.tools, run.brief.models),
      limits: { ...run.brief.limits, ...(run.brief.budgetUsd != null ? { spendCapUsd: run.brief.budgetUsd } : {}) },
      reviewer: { providerId: run.brief.llm?.providerId || null, model: run.brief.llm?.model || null },
    });
    return { output: { productionRunId: started.run.id }, wait: true };
  },
};

// ---- the advance loop ------------------------------------------------------------

const isLoginRequired = (err) => err?.code === 'PUBLISH_LOGIN_REQUIRED';

async function park(projectId, status, patch) {
  const out = await patchRun(projectId, () => ({ status, ...patch }));
  const log = status === 'failed' ? console.error : status === 'completed' ? console.log : console.warn;
  log(`${status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏸️'} Autonomous music video ${short(out.run.id)} ${status}${patch.error ? `: ${patch.error}` : ''}`);
  return out;
}

async function advance(projectId) {
  if (inflight.has(projectId)) return;
  const settlement = Promise.withResolvers();
  inflight.set(projectId, settlement.promise);
  try {
    for (;;) {
      const project = await getProject(projectId);
      const run = projectAutonomousRun(project);
      if (!run || run.status !== 'running' || run.processId !== PROCESS_ID) return;
      const stage = run.stage;
      const executor = STAGES[stage];
      if (!executor) {
        await park(projectId, 'failed', { error: `Unknown stage "${stage}"`, errorCode: 'UNKNOWN_STAGE' });
        return;
      }
      await patchRun(projectId, (r) => stagePatch(r, stage, { status: 'running', startedAt: new Date().toISOString(), error: null }));
      let result;
      try {
        result = await executor({ project, run, save: (patch) => patchRun(projectId, () => patch) });
      } catch (err) {
        // A stop/cancel mid-stage (it cancels the song operation) must not become a failure.
        const latest = projectAutonomousRun(await getProject(projectId));
        if (latest?.status !== 'running' || latest.processId !== PROCESS_ID) return;
        await patchRun(projectId, (r) => stagePatch(r, stage, { status: 'failed', error: trimTo(err.message, 500) }));
        await park(projectId, isLoginRequired(err) ? 'needs-human' : 'failed', { error: trimTo(err.message, 500), errorCode: err.code || null });
        return;
      }
      const finishedAt = new Date().toISOString();
      if (result.wait) {
        await patchRun(projectId, (r) => ({ output: result.output, ...stagePatch(r, stage, { status: 'running' }) }));
        console.log(`🎬 Autonomous music video ${short(run.id)} handed ${stage} to production`);
        return;
      }
      const next = nextAutonomousStage(stage);
      const checkpoint = run.brief.checkpoints.includes(stage);
      await patchRun(projectId, (r) => ({
        output: result.output,
        ...stagePatch(r, stage, { status: 'done', finishedAt }),
        ...(checkpoint ? { status: 'awaiting-approval', awaiting: stage, stage: next } : next ? { stage: next } : { status: 'completed', stage }),
      }));
      console.log(`🎬 Autonomous music video ${short(run.id)} finished ${stage}${checkpoint ? ' — waiting for approval' : ''}`);
      if (checkpoint || !next) return;
    }
  } catch (err) {
    console.error(`❌ Autonomous music video advance failed for ${short(projectId)}: ${err.message}`);
  } finally {
    inflight.delete(projectId);
    settlement.resolve();
  }
}

function advanceInBackground(projectId) {
  advance(projectId).catch((err) => console.error(`❌ Autonomous music video advance failed for ${short(projectId)}: ${err.message}`));
}

// ---- director actions ------------------------------------------------------------

const emptyStages = () => Object.fromEntries(AUTONOMOUS_STAGE_IDS.map((id) => [id, { status: 'pending', startedAt: null, finishedAt: null, error: null }]));

/**
 * Start a run from one prompt: creates the project (autonomous mode, no track
 * yet) and begins the pipeline in the background. Returns `{ project, run }`.
 */
export async function startAutonomousVideo(input) {
  const brief = normalizeAutonomousBrief(input);
  if (!brief.prompt) throw runError(400, 'VALIDATION_ERROR', 'A prompt is required');
  const now = new Date().toISOString();
  const created = await deps.createProject({
    name: brief.name || trimTo(brief.prompt.replace(/\s+/g, ' '), 60) || 'Autonomous music video',
    mode: 'autonomous',
    concept: { prompt: trimTo(brief.prompt, 8000) },
    automation: {
      tools: brief.tools,
      guidance: brief.guidance,
      budgetUsd: brief.budgetUsd,
      checkins: { castAndSets: brief.checkpoints.includes('cast') ? 'review' : 'auto' },
      // The run's LLM pin also steers the stages production starts later (Cast & Sets, shot planning).
      ...(brief.llm ? { llm: brief.llm } : {}),
    },
  });
  const run = {
    id: `mvar-${randomUUID()}`,
    status: 'running',
    stage: AUTONOMOUS_STAGE_IDS[0],
    awaiting: null,
    brief,
    stages: emptyStages(),
    output: {},
    error: null,
    errorCode: null,
    processId: PROCESS_ID,
    createdAt: now,
    updatedAt: now,
  };
  const out = await mutateProjectRecord(created.id, (current) => ({ project: { ...current, autonomousRun: run }, run }));
  console.log(`🎬 Autonomous music video ${short(run.id)} started (${brief.tools.length} tool(s), ${brief.checkpoints.length} checkpoint(s)${brief.origin.kind === 'schedule' ? ', scheduled' : ''})`);
  publish(out.project, out.run);
  advanceInBackground(created.id);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

export async function getAutonomousRun(projectId) {
  const { run } = await requireRun(projectId);
  return { run: presentAutonomousRun(run) };
}

/**
 * Resume a parked, failed or interrupted run at the stage that stopped — or
 * approve the checkpoint it is waiting on (optionally replacing the stage
 * output the director edited). Returns `{ project, run }`.
 */
const assertResumable = (run) => {
  const resumable = AUTONOMOUS_LIVE_STATUSES.includes(run.status) || run.status === 'failed';
  if (!resumable) throw runError(409, 'NOT_RESUMABLE', `A ${run.status} run cannot be resumed`);
  if (run.status === 'running' && run.processId === PROCESS_ID) throw runError(409, 'ALREADY_RUNNING', 'This run is already running');
};

export async function resumeAutonomousVideo(projectId, edits = {}) {
  const { run } = await requireRun(projectId);
  assertResumable(run);
  // Stop changes the record immediately, but its stage may still be settling.
  // Let that attempt release ownership before marking a new attempt running.
  await inflight.get(projectId);
  const out = await patchRun(projectId, (r) => {
    // Cancel or another Resume may have won while the old attempt settled.
    assertResumable(r);
    // A run waiting on production resumes by resuming that run, not by redoing
    // the stage — the stage re-runs only when production never started.
    const stage = r.stage;
    return {
      status: 'running', awaiting: null, error: null, errorCode: null, processId: PROCESS_ID,
      output: {
        ...(typeof edits.lyrics === 'string' ? { lyrics: edits.lyrics } : {}),
        ...(typeof edits.style === 'string' && edits.style.trim() ? { sunoStyle: edits.style.trim() } : {}),
      },
      ...stagePatch(r, stage, { error: null }),
    };
  });
  if (out.run.stage === 'produce' && out.run.output.productionRunId) {
    const { resumeProduction } = await import('./productionService.js');
    const failure = await resumeProduction(projectId, out.run.output.productionRunId, { acceptBasis: true }).then(() => null, (err) => err);
    if (failure) {
      // A failed or canceled production run cannot be resumed; say so rather than leave the run looking live.
      const parked = await park(projectId, 'needs-human', { error: trimTo(`Production could not resume: ${failure.message}`, 500), errorCode: failure.code || null });
      return { project: parked.project, run: presentAutonomousRun(parked.run) };
    }
    return { project: out.project, run: presentAutonomousRun(out.run) };
  }
  advanceInBackground(projectId);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

// Read from the freshly patched record, so a job id stored a moment before the status flipped is seen.
const cancelLocalSongJob = (run) => (run.stage === 'song' && run.output.localSongJobId
  ? deps.cancelLocalSong(run.output.localSongJobId).catch(() => {})
  : null);

export async function stopAutonomousVideo(projectId) {
  const { run } = await requireRun(projectId);
  if (!['running', 'awaiting-approval', 'needs-human'].includes(run.status)) throw runError(409, 'NOT_RUNNING', `A ${run.status} run cannot be stopped`);
  const out = await patchRun(projectId, () => ({ status: 'stopped' }));
  if (run.output.productionRunId) {
    const { stopProduction } = await import('./productionService.js');
    await stopProduction(projectId, run.output.productionRunId).catch(() => {});
  }
  sunoControllers.get(run.id)?.abort();
  await cancelLocalSongJob(out.run);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

export async function cancelAutonomousVideo(projectId) {
  const { run } = await requireRun(projectId);
  if (!(AUTONOMOUS_LIVE_STATUSES.includes(run.status) || run.status === 'failed')) throw runError(409, 'NOT_CANCELABLE', `A ${run.status} run cannot be canceled`);
  const out = await patchRun(projectId, () => ({ status: 'canceled', awaiting: null }));
  if (run.output.productionRunId) {
    const { cancelProduction } = await import('./productionService.js');
    await cancelProduction(projectId, run.output.productionRunId).catch(() => {});
  }
  sunoControllers.get(run.id)?.abort();
  await cancelLocalSongJob(out.run);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

// ---- production completion -------------------------------------------------------

const PRODUCTION_PARKED = new Set(['limit-reached', 'blocked', 'needs-replan', 'needs-human', 'stopped']);

/**
 * A production run this autonomous run delegated to advanced. Mirrors its
 * terminal state onto the run: completed → kick off the final render and
 * finish; failed → failed; any parked state → needs-human (resume continues it).
 */
async function onProductionEvent({ projectId, runId, run: production }) {
  // Production emits on every step; only a terminal or parked state concerns us, and
  // the project is read only once one arrives.
  if (!projectId || !(['completed', 'failed', 'canceled'].includes(production?.status) || PRODUCTION_PARKED.has(production?.status))) return;
  const project = await getProject(projectId).catch(() => null);
  const run = projectAutonomousRun(project);
  if (!run || run.stage !== 'produce' || run.output.productionRunId !== runId) return;
  if (!['running', 'needs-human'].includes(run.status)) return;
  const reason = trimTo(production.stopReason || production.error || '', 500);
  if (production.status === 'completed') {
    const render = await deps.renderVideo(projectId).catch((err) => ({ error: err }));
    await patchRun(projectId, (r) => ({
      status: 'completed',
      ...stagePatch(r, 'produce', { status: render.error ? 'failed' : 'done', finishedAt: new Date().toISOString(), error: render.error ? trimTo(render.error.message, 500) : null }),
      ...(render.error ? { error: `The draft is ready, but the final render did not start: ${trimTo(render.error.message, 400)}` } : { output: { renderJobId: render.jobId || null } }),
    }));
    console.log(`✅ Autonomous music video ${short(run.id)} finished${render.error ? ' (final render did not start)' : ' — final render started'}`);
  } else if (production.status === 'failed') {
    await park(projectId, 'failed', { error: reason || 'Production failed', errorCode: 'PRODUCTION_FAILED' });
  } else if (production.status === 'canceled') {
    await park(projectId, 'canceled', { error: reason || null });
  } else if (PRODUCTION_PARKED.has(production.status) && run.status === 'running') {
    await park(projectId, 'needs-human', { error: reason || `Production is ${production.status}`, errorCode: 'PRODUCTION_PARKED' });
  }
}

musicVideoEvents.on('production', (event) => {
  onProductionEvent(event).catch((err) => console.error(`❌ Autonomous music video could not settle on production: ${err.message}`));
});

/**
 * Resolves once no background advance loop is in flight, including one a
 * resume started while the previous settled. Bounded, so a stage that never
 * returns fails the caller's teardown loudly instead of hanging it.
 */
async function settleBackground(timeoutMs = 10_000) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Autonomous advance did not settle within ${timeoutMs}ms`)), timeoutMs); });
  try {
    await Promise.race([(async () => { while (inflight.size) await Promise.allSettled([...inflight.values()]); })(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export const __testing = { onProductionEvent, advance, settleBackground };
