/**
 * Fully-autonomous Music Video — the run orchestrator.
 *
 * One prompt drives a whole video: creative brief → lyrics → mood board & style
 * → Suno song (PortOS Browser) → beat analysis → the existing production run
 * (image/video tools) or a code-rendered video. The vocabulary, brief shape and
 * Suno field limits live in `lib/musicVideo/musicVideoAutonomous.js`.
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
 * the run parks `awaiting-approval` and continues on approve; at the song
 * checkpoint the director may instead retake the song (`retakeSong`), which
 * discards it and generates a new one before parking there again. A signed-out
 * Suno parks `needs-human`; any other failure parks `failed`. Both resume at the
 * stage that stopped, reusing Suno songs already submitted. A brief may instead
 * (or as a fallback, `localFallback`) make the song with the on-device Music
 * Designer engines (`autonomousLocalSong.js`), so a run finishes with Suno
 * unavailable.
 *
 * Production is delegated: `produce` starts the server-owned production run (or
 * the code render) and finishes when that reports back over the `production`
 * event. A code-first production run renders the film itself; when that render
 * is still the project's current final video the run adopts it instead of
 * rendering the same document again (#10563). Either way `produce` stays
 * running ("Rendering final video") until the final render job settles over
 * the `render` event: success completes the run, failure parks it `failed` and
 * Retry re-renders only. A run interrupted while rendering re-checks
 * `renderHistoryId` on resume (reattach, finish, or render again). Only
 * explicit start/resume requests begin work.
 *
 * Production review (art → storyboard → proof) parks `produce` until approved.
 * An authenticated start/resume can grant `brief.autoApprove` for planning;
 * the route binds the grant to a session and each automatic decision to this run.
 * Proof always requires recorded playback or machine review evidence. Older
 * briefs granting proof auto-approval still wait for rendering, then park for review.
 *
 * An ORCHESTRATED run (`brief.orchestrator`) replaces the director at every
 * review point instead: the orchestrator model judges the lyrics, the sound and
 * look, the song, the art direction, the lyric timing, the storyboard and the
 * final video, and either approves each or revises it and judges again
 * (bounded by `limits.maxReviewAttempts`, then the last version is accepted).
 * It also repairs a failed production pilot and approves the passing pilot as
 * the proof from that review's machine evidence (settleBlockedProduction).
 * Every decision lands in `run.orchestration.reviews`. It is approval
 * authority, so like `autoApprove` it is granted only to a signed-in session.
 */

import { musicVideoMediaMode } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { productionAlignmentBasis, productionReadiness } from './productionReview.js';
import { normalizeMusicVideoProductionPolicy } from '../../lib/musicVideo/musicVideoMediumPlan.js';
import { MUSIC_VIDEO_AUTOMATION_TOOL_IDS } from '../../lib/musicVideo/musicVideoAutomation.js';
import { randomUUID } from 'crypto';
import { trimTo } from '../../lib/textUtils.js';
import { assertFootageVideoModelsCapable, loadPoolEnv } from './productionPool.js';
import { PRODUCTION_RESUMABLE_STATUSES } from './production.js';
import {
  AUTONOMOUS_LIVE_STATUSES,
  AUTONOMOUS_STAGE_IDS,
  autonomousPool,
  canAdoptSunoSong,
  nextAutonomousStage,
  normalizeAutoApprove,
  normalizeAutonomousBrief,
  normalizeLocalMusicOptions,
  normalizeSunoOptions,
  SUNO_LIMITS,
} from '../../lib/musicVideo/musicVideoAutonomous.js';
import { getProject } from './projects.js';
import { isPerformanceScene, performanceCapability } from '../../lib/musicVideo/musicVideoShotTiming.js';
import { applyProjectPatch } from './projectsLogic.js';
import { openAttemptRevisionId } from './autoReview.js';
import {
  mutateProjectRecord,
  PROCESS_ID,
  short,
  deps,
  runError,
  projectAutonomousRun,
  ownsRunningRun,
  requireRun,
  patchRun,
  stagePatch,
  RENDER_STEP,
  CAST_STEP,
  publish,
  logParkedRun,
  park,
  settleChildStop,
  presentAutonomousRun,
  presentProjectAutonomousRun,
} from './autonomous/autonomousRunStore.js';
import {
  cueText,
  briefDirective,
  rendersFromCode,
  FINAL_REVISION_STEP,
  settleStills,
  ensureFootageComposition,
} from './autonomous/autonomousOrchestration.js';
import {
  STAGES,
  SONG_OUTPUT_KEYS,
  briefProductionPool,
  abortSunoSong,
  SONG_PICK_STEP,
} from './autonomous/autonomousStages.js';
import {
  produceContinuation,
  finishFromProduction,
  reconcileCastAndSets,
  reconcileFinalRender,
  startFinalRender,
  onProductionEvent,
  onAutoReviewEvent,
  onRenderEvent,
  registerReconciliation,
} from './autonomous/autonomousReconcile.js';

export { __setAutonomousDepsForTests, presentAutonomousRun, presentProjectAutonomousRun, __autonomousProcessId } from './autonomous/autonomousRunStore.js';
export { SONG_PICK_STEP } from './autonomous/autonomousStages.js';

const inflight = new Map();

/**
 * The brief fields for an auto-approve request: none when it lists no stage,
 * else the stages plus when the operator granted them. A non-empty list the
 * route did not authorize (authenticated session) is refused.
 */
function autoApproveGrant(list, authorized) {
  const autoApprove = normalizeAutoApprove(list);
  if (!autoApprove.length) return { autoApprove: [], autoApproveAuthorizedAt: null, autoApproveAuthorizedBy: null };
  if (!authorized) throw runError(403, 'AUTH_REQUIRED', 'Sign in to grant automatic planning approvals.');
  return { autoApprove, autoApproveAuthorizedAt: new Date().toISOString(),
    ...(typeof authorized === 'object' ? { autoApproveAuthorizedBy: structuredClone(authorized) } : {}) };
}

/**
 * The orchestrator approves Production review stages and verifies lyric timing
 * on the operator's behalf, so — like an auto-approve grant — only an
 * authenticated session may start an orchestrated run, and the grant records who.
 */
function orchestratorGrant(authorized) {
  if (!authorized) throw runError(403, 'AUTH_REQUIRED', 'Sign in to start an orchestrated run: the orchestrator approves stages for you.');
  return { orchestratorAuthorizedAt: new Date().toISOString(),
    orchestratorAuthorizedBy: typeof authorized === 'object' ? structuredClone(authorized) : null };
}

// ---- the advance loop ------------------------------------------------------------

const isLoginRequired = (err) => err?.code === 'PUBLISH_LOGIN_REQUIRED';

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
      await patchRun(projectId, (r) => stagePatch(r, stage, { status: 'running', startedAt: new Date().toISOString(), error: null, step: null }));
      let result;
      try {
        result = await executor({ project, run, save: (patch) => patchRun(projectId, () => patch) });
      } catch (err) {
        // Recheck ownership inside the failure write, so an already queued stop/cancel wins.
        let failed = false;
        const out = await patchRun(projectId, (r) => {
          failed = ownsRunningRun(r, run);
          return failed ? {
            ...stagePatch(r, stage, { status: 'failed', error: trimTo(err.message, 500), step: null }),
            status: isLoginRequired(err) || err.code === 'MUSIC_VIDEO_APPROVAL_REQUIRED' ? 'needs-human' : 'failed',
            error: trimTo(err.message, 500), errorCode: err.code || null,
          } : {};
        });
        if (failed) logParkedRun(out.run, out.run.status, out.run.error);
        return;
      }
      const finishedAt = new Date().toISOString();
      // Preserve useful late output, but only the still-owned run may continue the pipeline.
      let owned = false;
      if (result.goto) {
        // The orchestrator sent the run back (a song retake): both stages run again.
        const pending = { status: 'pending', startedAt: null, finishedAt: null, error: null, step: null };
        await patchRun(projectId, (r) => {
          owned = ownsRunningRun(r, run);
          return { output: result.output, ...(owned ? { stage: result.goto } : {}),
            stages: { [stage]: { ...r.stages[stage], ...pending }, [result.goto]: { ...r.stages[result.goto], ...pending } } };
        });
        if (!owned) return;
        if (result.unlinkTrack) await unlinkRunTrack(projectId, run.id, result.unlinkTrack);
        console.log(`🎬 Autonomous music video ${short(run.id)} going back to ${result.goto}`);
        continue;
      }
      if (result.hold) {
        // Parked inside the stage (the song checkpoint before its download): approving
        // re-runs this stage, which then finishes it.
        await patchRun(projectId, (r) => {
          owned = ownsRunningRun(r, run);
          return { output: result.output, ...stagePatch(r, stage, { status: 'pending', step: result.hold }),
            ...(owned ? { status: 'awaiting-approval', awaiting: stage } : {}) };
        });
        if (owned) console.log(`🎬 Autonomous music video ${short(run.id)} made its ${stage} — waiting for approval before the download`);
        return;
      }
      if (result.wait) {
        await patchRun(projectId, (r) => {
          owned = ownsRunningRun(r, run);
          return { output: result.output, ...stagePatch(r, stage, { status: 'running', step: result.step || null }) };
        });
        if (!owned) {
          // Cancellation can win the serialized write after the executor's final ownership read.
          const { productionRunId, renderJobId } = result.output || {};
          if (productionRunId) await settleChildStop([], projectId, run, 'cancel production', productionRunId, () => deps.cancelProduction(projectId, productionRunId));
          if (renderJobId) await settleChildStop([], projectId, run, 'cancel render', renderJobId, () => deps.cancelRender(renderJobId));
          return;
        }
        console.log(`🎬 Autonomous music video ${short(run.id)} handed ${stage} to ${result.step === RENDER_STEP ? 'the final render' : result.step === CAST_STEP ? 'Cast & Sets' : 'production'}`);
        // The render may have settled before its job id was stored on the run.
        if (result.step === RENDER_STEP) await reconcileFinalRender(projectId);
        // Cast & Sets may likewise have settled while the wait was being stored.
        // It runs once this loop releases the project, so the re-entry it triggers is not dropped as "already running".
        else if (result.step === CAST_STEP) {
          settlement.promise.then(() => reconcileCastAndSets(projectId, advanceInBackground))
            .catch((err) => console.error(`❌ Autonomous music video could not settle on Cast & Sets: ${err.message}`));
        }
        return;
      }
      const next = nextAutonomousStage(stage);
      // A song the director already approved before its download does not stop again once imported.
      const checkpoint = run.brief.checkpoints.includes(stage) && !(stage === 'song' && run.output.songTakeApproved);
      await patchRun(projectId, (r) => {
        owned = ownsRunningRun(r, run);
        return {
          output: result.output,
          ...stagePatch(r, stage, { status: 'done', finishedAt, step: null }),
          ...(owned && (checkpoint ? { status: 'awaiting-approval', awaiting: stage, stage: next } : next ? { stage: next } : { status: 'completed', stage })),
        };
      });
      if (!owned) return;
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

/**
 * Drop the project's link to a retaken song. The rejected track stays in the
 * music library (the director may still want it); only the link goes, and
 * only while it still names that track (never one the director picked since).
 * Unlinking keeps the lyric cues' text and clears their timings (applyProjectPatch
 * → invalidateTimedText), and the new song's link re-seeds them from its own
 * lyrics. A failed unlink is not fatal: that same link replaces the old one.
 */
async function unlinkRunTrack(projectId, runId, trackId) {
  // The track and run ownership must be checked in the same write as the unlink.
  await mutateProjectRecord(projectId, (project) => ({ project: project.trackId === trackId && ownsRunningRun(projectAutonomousRun(project), { id: runId })
    ? applyProjectPatch(project, { trackId: null }) : project }))
    .catch((err) => console.warn(`⚠️ Autonomous music video ${short(runId)} could not unlink the retaken track: ${err.message}`));
}

// ---- director actions ------------------------------------------------------------

const emptyStages = () => Object.fromEntries(AUTONOMOUS_STAGE_IDS.map((id) => [id, { status: 'pending', startedAt: null, finishedAt: null, error: null }]));

/**
 * The project video settings the run's own video tool implies, so the plan and
 * production agree on what can render: its backend and local model, and Supplied
 * song audio when that local model takes a shot's song window. With no video tool
 * it is local video, whose lip-sync shots render as LTX audio-to-video.
 */
async function briefVideoSettings(tools, models) {
  const route = autonomousPool(tools, models).find((entry) => entry.kind === 'video');
  if (!route || route.mode !== 'local') return { backend: route?.mode || 'local', generationMode: 'image' };
  const songAudio = await deps.localVideoTakesSongAudio(route.model).catch(() => false);
  return { backend: 'local', modelId: route.model || null, generationMode: songAudio ? 'suppliedAudio' : 'image' };
}

/** Refuse a pinned video model that cannot animate a frame (#10457) before the run records it. */
async function assertBriefVideoModelsCapable(tools, models) {
  const pool = autonomousPool(tools, models);
  if (pool.some((route) => route.kind === 'video' && route.model)) await assertFootageVideoModelsCapable(pool, await loadPoolEnv());
}

// The song fields a reused song brings along: the audio, its analysis and the
// timed lyrics. Never the source's look, cast, scenes, storyboard or treatment.
const REUSED_SONG_FIELDS = ['audioAnalysis', 'midiTranscription', 'lyricCues', 'lyricMarkers', 'phrases',
  'lyricTimingMasterFilename',
  'vocalStemFilename', 'vocalStemMasterFilename', 'vocalStemDerived', 'performanceConditioningSource', 'lyricAlignSource', 'lyricAlignSilentWords'];

/** The song an autonomous run reuses from another project, or a 4xx naming why it cannot. */
async function loadSongSource(projectId) {
  const source = await getProject(projectId);
  if (!source || source.deleted) throw runError(404, 'NOT_FOUND', 'The project to take the song from was not found');
  if (!source.trackId && !source.uploadedAudioFilename) throw runError(409, 'NO_SONG', `"${source.name}" has no song to reuse`);
  const track = source.trackId ? await deps.getTrack(source.trackId) : null;
  const cueLines = (source.lyricCues || []).map(cueText).filter(Boolean);
  return {
    source,
    title: trimTo(track?.title || source.name, SUNO_LIMITS.title) || 'Untitled',
    style: trimTo(source.concept?.songStyle || track?.prompt || '', 2000),
    lyrics: cueLines.length ? cueLines.join('\n') : (typeof track?.lyrics === 'string' ? track.lyrics.trim() : ''),
    // Verified timing carries over only while it is still verified on the source.
    verified: productionReadiness(source).alignment.status === 'verified',
  };
}

export async function startAutonomousVideo(input, { autoApproveAuthorized = false } = {}) {
  const brief = { ...normalizeAutonomousBrief(input), ...autoApproveGrant(input?.autoApprove, autoApproveAuthorized) };
  if (!brief.prompt) throw runError(400, 'VALIDATION_ERROR', 'A prompt is required');
  if (brief.orchestrator) Object.assign(brief, orchestratorGrant(autoApproveAuthorized));
  await assertBriefVideoModelsCapable(brief.tools, brief.models);
  const song = input?.fromProjectId ? await loadSongSource(input.fromProjectId) : null;
  if (song) {
    // No lyrics are written and no song is made, so those checkpoints have nothing to stop on.
    Object.assign(brief, {
      name: brief.name || trimTo(`${song.title} (Auto)`, 200),
      // The source's effective media mode carries over unless the request names its own.
      ...(input.mediaMode === undefined ? { mediaMode: musicVideoMediaMode(song.source) } : {}),
      instrumental: !song.lyrics,
      checkpoints: brief.checkpoints.filter((id) => id !== 'lyrics' && id !== 'song'),
      songFrom: { projectId: song.source.id, title: song.title, style: song.style, verifiedAlignmentBasis: null },
    });
  }
  const now = new Date().toISOString();
  const created = await deps.createProject({
    name: brief.name || trimTo(brief.prompt.replace(/\s+/g, ' '), 60) || 'Autonomous music video',
    mode: 'autonomous',
    mediaMode: brief.mediaMode,
    videoSettings: await briefVideoSettings(brief.tools, brief.models),
    ...(brief.mediaMode !== 'code-images-video' ? { productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } } : {}),
    // ...as does its production policy (a project with none is legacy), so a footage project stays one,
    // also when the request names a mode that allows footage; a code-only or stills mode keeps no footage.
    ...(song && (input.mediaMode === undefined || brief.mediaMode === 'code-images-video') ? { productionPolicy: normalizeMusicVideoProductionPolicy(song.source.productionPolicy) } : {}),
    ...(song ? { trackId: song.source.trackId || null, uploadedAudioFilename: song.source.uploadedAudioFilename || null } : {}),
    // The style id makes createProject cast its character and attach the sheet (styleSnapshots.js).
    concept: { prompt: trimTo(brief.prompt, 8000), ...(brief.characterStyleId ? { characterStyleId: brief.characterStyleId } : {}),
      ...(song?.style ? { songStyle: song.style } : {}) },
    automation: {
      tools: brief.tools,
      guidance: brief.guidance,
      budgetUsd: brief.budgetUsd,
      checkins: { castAndSets: brief.checkpoints.includes('cast') ? 'review' : 'auto' },
      // The run's LLM pins also steer the stages production starts later (Cast & Sets, shot planning, authoring).
      ...(brief.llm ? { llm: brief.llm } : {}),
      ...(brief.llmStages ? { llmStages: brief.llmStages } : {}),
    },
  });
  const run = {
    id: `mvar-${randomUUID()}`,
    status: 'running',
    stage: AUTONOMOUS_STAGE_IDS[0],
    awaiting: null,
    brief,
    stages: emptyStages(),
    output: song ? { trackId: song.source.trackId || null, lyrics: song.lyrics, songSource: 'reused' } : {},
    error: null,
    errorCode: null,
    processId: PROCESS_ID,
    createdAt: now,
    updatedAt: now,
  };
  const out = await mutateProjectRecord(created.id, (current) => {
    if (!song) return { project: { ...current, autonomousRun: run }, run };
    const copied = Object.fromEntries(REUSED_SONG_FIELDS.filter((key) => song.source[key] !== undefined)
      .map((key) => [key, structuredClone(song.source[key])]));
    const project = { ...current, ...copied, ...(copied.audioAnalysis ? { status: 'analyzed' } : {}) };
    // Bound to the copy as written: any later change to the audio or timings unbinds it.
    const reused = { ...run, brief: { ...run.brief, songFrom: { ...run.brief.songFrom,
      verifiedAlignmentBasis: song.verified ? productionAlignmentBasis(project) : null } } };
    return { project: { ...project, autonomousRun: reused }, run: reused };
  });
  console.log(`🎬 Autonomous music video ${short(run.id)} started${song ? ` on the song from ${short(song.source.id)}` : ''} (${brief.tools.length} tool(s), ${brief.orchestrator ? `orchestrated by ${brief.orchestrator.providerId}` : `${brief.checkpoints.length} checkpoint(s)`}${brief.autoApprove.length ? `, auto-approve ${brief.autoApprove.join('/')}` : ''}${brief.origin.kind === 'schedule' ? ', scheduled' : ''})`);
  publish(out.project, out.run);
  advanceInBackground(created.id);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

export async function getAutonomousRun(projectId) {
  const { run } = await requireRun(projectId);
  return { run: presentAutonomousRun(run) };
}

const assertResumable = (run) => {
  // A run canceled while it waited on production can pick up again: resume adopts the
  // director's own production run, or starts a new one from the brief.
  const resumable = AUTONOMOUS_LIVE_STATUSES.includes(run.status) || run.status === 'failed'
    || (run.status === 'canceled' && run.stage === 'produce');
  if (!resumable) throw runError(409, 'NOT_RESUMABLE', `A ${run.status} run cannot be resumed`);
  if (run.status === 'running' && run.processId === PROCESS_ID) throw runError(409, 'ALREADY_RUNNING', 'This run is already running');
};

// A retake is only meaningful while the run sits on the song it would replace: parked for
// approval of it, or stopped / failed inside the song stage (a Suno request whose rows
// vanished leaves ids no export can find — the retake discards them and submits afresh).
const assertAtSongCheckpoint = (run) => {
  const parkedOnSong = run.status === 'awaiting-approval' && run.awaiting === 'song';
  const stuckInSong = run.stage === 'song' && ['stopped', 'failed', 'needs-human'].includes(run.status);
  if (!parkedOnSong && !stuckInSong) {
    throw runError(409, 'NOT_AT_SONG_CHECKPOINT', 'A song can only be retaken while the run is waiting for approval of its song, or is stopped or failed in the song stage');
  }
};

// Parked on fresh Suno renders before any download: approve one of them or a
// version the director made or revised in Suno meanwhile.
const pickingSong = (run) => run.status === 'awaiting-approval' && run.awaiting === 'song' && run.stage === 'song';

function assertCanUseSunoSong(run, songId, { retake, adoptSong }) {
  if (songId && (retake || !(adoptSong ? canAdoptSunoSong(run) : pickingSong(run)))) {
    throw runError(409, 'NOT_AT_SONG_CHECKPOINT', 'A Suno song can only be supplied at download approval or when a failed or stopped Suno stage has no takes');
  }
}

async function buildResumePlan(run, edits, autoApproveAuthorized) {
  // Tools are only ever added (a video tool once the stills are approved, say); the pool follows.
  const added = (edits.addTools || []).filter((id) => !run.brief.tools.includes(id));
  const toolsPatch = added.length ? MUSIC_VIDEO_AUTOMATION_TOOL_IDS.filter((id) => run.brief.tools.includes(id) || added.includes(id)) : null;
  const tools = toolsPatch || run.brief.tools;
  // A model swap is validated like Start, then replaces the parked production run's pool (#10473).
  const modelsPatch = briefModelsPatch({ ...run.brief, tools }, edits.models);
  assertResumable(run);
  if (modelsPatch || toolsPatch) await assertBriefVideoModelsCapable(tools, modelsPatch || run.brief.models || {});
  // "Auto-approve the rest": replaces the brief's grant (an empty list clears it).
  const grant = edits.autoApprove !== undefined ? autoApproveGrant(edits.autoApprove, autoApproveAuthorized) : null;
  const retake = edits.retakeSong === true;
  if (retake && run.brief.songFrom) throw runError(409, 'SONG_REUSED', 'This run reuses an existing song, so it has no song to retake');
  if (retake) assertAtSongCheckpoint(run);
  const adoptSong = Boolean(edits.sunoSongId && canAdoptSunoSong(run));
  // Retrying the adoption request must not spend a download. To approve the
  // adopted take, resume without an id, which selects the only saved take.
  if (!retake && edits.sunoSongId && pickingSong(run) && run.output.songTakeApproved === false
      && edits.sunoSongId === run.output.sunoSongIds?.[0]) {
    return null;
  }
  assertCanUseSunoSong(run, edits.sunoSongId, { retake, adoptSong });
  // A changed prompt or guidance reaches production's shot planner on this resume.
  const directionPatch = Object.fromEntries(['prompt', 'guidance'].filter((key) => typeof edits[key] === 'string' && edits[key] !== (run.brief[key] ?? '')).map((key) => [key, edits[key]]));
  const directionChanged = Object.keys(directionPatch).length > 0;
  const modelsChanged = toolsPatch !== null || (modelsPatch !== null && JSON.stringify(modelsPatch) !== JSON.stringify(run.brief.models || {}));
  // Approving the stills goes on to the clips, including in any new production run.
  const stillsApproved = run.status === 'awaiting-approval' && run.awaiting === 'stills';
  const limitsPatch = edits.limits ? { ...run.brief.limits, ...edits.limits } : null;
  // A production run only takes raised limits; refuse a lower one before anything changes.
  if (edits.limits && run.stage === 'produce' && Object.entries(edits.limits).some(([key, value]) => value != null && value < (run.brief.limits?.[key] ?? 0))) {
    throw runError(400, 'VALIDATION_ERROR', 'Resuming production can only raise a limit');
  }
  return {
    added, tools, toolsPatch, modelsPatch, grant, retake, adoptSong, directionPatch, limitsPatch,
    continuation: { swapModels: modelsChanged, limits: edits.limits, stillsApproved, directionChanged },
  };
}

function buildResumePatch(run, edits, plan) {
  const { retake, adoptSong, directionPatch, toolsPatch, modelsPatch, limitsPatch, grant, continuation } = plan;
  const { stillsApproved, directionChanged } = continuation;
  // Recheck the checkpoint inside the serialized write after waiting for an old attempt.
  assertResumable(run);
  assertCanUseSunoSong(run, edits.sunoSongId, plan);
  if (retake) assertAtSongCheckpoint(run);
  const stage = retake ? 'song' : run.stage;
  const briefChanged = edits.suno || edits.localMusic !== undefined || grant || modelsPatch || toolsPatch || limitsPatch || stillsApproved || directionChanged;
  return {
    status: adoptSong ? 'awaiting-approval' : 'running', awaiting: adoptSong ? 'song' : null,
    error: null, errorCode: null, processId: PROCESS_ID,
    ...(briefChanged ? { brief: {
      ...run.brief,
      ...directionPatch,
      ...(toolsPatch ? { tools: toolsPatch } : {}),
      ...(stillsApproved ? { stopBeforeVideo: false } : {}),
      ...(modelsPatch ? { models: modelsPatch } : {}),
      ...(limitsPatch ? { limits: limitsPatch } : {}),
      // A generation limit the director sets replaces the sized default.
      ...(edits.limits?.maxGenerations != null ? { sizedGenerations: false } : {}),
      ...(edits.suno ? { suno: normalizeSunoOptions({ ...run.brief.suno, ...edits.suno }) } : {}),
      ...(edits.localMusic !== undefined ? { localMusic: normalizeLocalMusicOptions(edits.localMusic ? { ...run.brief.localMusic, ...edits.localMusic } : null) } : {}),
      ...(grant || {}),
    } } : {}),
    output: {
      ...(retake ? Object.fromEntries(SONG_OUTPUT_KEYS.map((key) => [key, null])) : {}),
      ...(adoptSong ? { sunoSongIds: [edits.sunoSongId], sunoSongPick: null, songTakeApproved: false } : {}),
      ...(!retake && pickingSong(run) ? { songTakeApproved: true, ...(edits.sunoSongId ? { sunoSongPick: edits.sunoSongId } : {}) } : {}),
      ...(typeof edits.lyrics === 'string' ? { lyrics: edits.lyrics } : {}),
      ...(typeof edits.style === 'string' && edits.style.trim() ? { sunoStyle: edits.style.trim() } : {}),
    },
    ...(retake || adoptSong
      ? { stage, ...stagePatch(run, stage, { status: 'pending', startedAt: null, finishedAt: null, error: null, step: adoptSong ? SONG_PICK_STEP : null }) }
      : stagePatch(run, stage, { error: null })),
  };
}

async function syncResumeProjectSettings(projectId, run, { added, tools, toolsPatch, modelsPatch }) {
  // The project's brief tools gate what production may submit (a video tool for clips), so they follow
  // too, as do its video settings. Performance shots no route can lip-sync play as cutaways.
  const video = await briefVideoSettings(tools, modelsPatch || run.brief.models || {});
  const lipSync = !!performanceCapability(video.backend);
  await mutateProjectRecord(projectId, (current) => ({ project: { ...current,
    ...(toolsPatch ? { automation: { ...current.automation, tools: [...new Set([...(current.automation?.tools || []), ...added])] } } : {}),
    videoSettings: { ...current.videoSettings, ...video },
    ...(lipSync ? {} : { scenes: (current.scenes || []).map((scene) => (isPerformanceScene(scene) ? { ...scene, shotMode: 'cutaway' } : scene)) }) } }));
}

async function resumeFinalRevision(projectId, reviewId) {
  // A revision that already ended leaves a revised film to render and review again.
  const failure = await deps.resumeAutoReview(projectId, reviewId).then(() => null, (err) => err);
  if (!failure) {
    const { project, run } = await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'running', step: FINAL_REVISION_STEP }));
    return { project: presentProjectAutonomousRun(project), run: presentAutonomousRun(run) };
  }
  if (!['AUTO_REVIEW_CLOSED', 'NOT_FOUND'].includes(failure.code)) {
    const parked = await park(projectId, 'needs-human', { error: trimTo(`The final revision could not resume: ${failure.message}`, 500), errorCode: failure.code || null });
    return { project: parked.project, run: presentAutonomousRun(parked.run) };
  }
  // A hand-off the director has not finished yet still holds its revision open.
  if (openAttemptRevisionId(await getProject(projectId), reviewId)) {
    const parked = await park(projectId, 'needs-human', { error: 'Finish or cancel the open revision of the final video first, then Resume.', errorCode: 'FINAL_REVISION_NEEDS_HUMAN' });
    return { project: parked.project, run: presentAutonomousRun(parked.run) };
  }
  const { run } = await patchRun(projectId, () => ({ output: { finalAutoReviewId: null } }));
  await startFinalRender(projectId, run);
  const latest = await getProject(projectId);
  return { project: presentProjectAutonomousRun(latest), run: presentAutonomousRun(projectAutonomousRun(latest)) };
}

async function dispatchResumeContinuation(projectId, out, productionOptions) {
  const { resume } = produceContinuation(out.run);
  if (resume.kind === 'final-revision') return resumeFinalRevision(projectId, resume.id);
  if (resume.kind === 'final-render') {
    // Production (or the code render) already finished; only the final render and its review are left.
    await reconcileFinalRender(projectId, { restart: true });
    const latest = await getProject(projectId);
    return { project: presentProjectAutonomousRun(latest), run: presentAutonomousRun(projectAutonomousRun(latest)) };
  }
  if (resume.kind === 'production') {
    return resumeDelegatedProduction(projectId, out.run, productionOptions);
  }
  advanceInBackground(projectId);
  return { project: out.project, run: presentAutonomousRun(out.run) };
}

/**
 * Resume a parked, failed or interrupted run at the stage that stopped — or
 * approve the checkpoint it is waiting on, applying any edits.
 */
export async function resumeAutonomousVideo(projectId, edits = {}, { autoApproveAuthorized = false } = {}) {
  const { project, run } = await requireRun(projectId);
  const plan = await buildResumePlan(run, edits, autoApproveAuthorized);
  if (!plan) return { project, run: presentAutonomousRun(run) };

  // A stopped stage may still be settling. Wait for it to release ownership before resuming.
  await inflight.get(projectId);
  let retakenTrackId = null;
  const out = await patchRun(projectId, (latest, current) => {
    const patch = buildResumePatch(latest, edits, plan);
    // Unlink only the track this run linked, never one the director picked since.
    if (plan.retake && latest.output.trackId && latest.output.trackId === current.trackId) retakenTrackId = latest.output.trackId;
    return patch;
  });
  if (retakenTrackId) await unlinkRunTrack(projectId, out.run.id, retakenTrackId);
  if (plan.toolsPatch || plan.modelsPatch) await syncResumeProjectSettings(projectId, run, plan);
  // Adopting a take asks for download approval even on a brief without checkpoints.
  if (plan.adoptSong) return { project: out.project, run: presentAutonomousRun(out.run) };
  return dispatchResumeContinuation(projectId, out, plan.continuation);
}

/**
 * The brief's models with a resume's per-tool swaps applied (null clears a pin), or null
 * when the resume names none. Only tools the brief already allows can be pinned.
 */
function briefModelsPatch(brief, models) {
  if (!models || !Object.keys(models).length) return null;
  const next = { ...(brief.models || {}) };
  for (const [tool, model] of Object.entries(models)) {
    if (!brief.tools.includes(tool)) throw runError(400, 'VALIDATION_ERROR', `The run does not use ${tool}`);
    if (model) next[tool] = model;
    else delete next[tool];
  }
  return next;
}

// Production runs that can still deliver the footage: live, parked or finished.
const ADOPTABLE_PRODUCTION = new Set(['running', 'completed', 'limit-reached', 'blocked', 'needs-replan', 'needs-human', 'stopped', 'awaiting-video']);
const PRODUCTION_LIVE = new Set(['running', 'limit-reached', 'blocked', 'needs-replan', 'needs-human', 'stopped', 'awaiting-video']);

/**
 * Hand a resumed run back to production. It follows the newest production run started
 * since the run began (the director may have replaced its own by hand) and resumes it
 * with any raised limits and swapped models, or finishes straight to the final render
 * when that run is already complete. No production run left to follow — or a model
 * swap on one that cannot resume — starts a new one from the brief by re-entering `produce`.
 */
async function resumeDelegatedProduction(projectId, run, { swapModels = false, limits, stillsApproved = false, directionChanged = false } = {}) {
  const project = await getProject(projectId);
  const runs = Array.isArray(project.productionRuns) ? project.productionRuns : [];
  const current = runs.find((r) => r.id === run.output.productionRunId) || null;
  const newest = runs
    .filter((r) => ADOPTABLE_PRODUCTION.has(r.status) && String(r.createdAt || '') >= String(run.createdAt || ''))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  const adopt = swapModels && newest && !PRODUCTION_RESUMABLE_STATUSES.has(newest.status) ? null : newest;
  if (!adopt) {
    // Unlink first: the old run's own "canceled" event must no longer match this run.
    const out = await patchRun(projectId, (r) => ({ output: { productionRunId: null }, ...stagePatch(r, 'produce', { status: 'pending', error: null, step: null }) }));
    if (current && PRODUCTION_LIVE.has(current.status)) await settleChildStop([], projectId, run, 'cancel production', current.id, () => deps.cancelProduction(projectId, current.id));
    console.log(`🎬 Autonomous music video ${short(run.id)} starting a new production run${swapModels ? ' with the new models' : ''}`);
    advanceInBackground(projectId);
    return { project: out.project, run: presentAutonomousRun(out.run) };
  }
  if (adopt.id !== run.output.productionRunId) {
    await patchRun(projectId, () => ({ output: { productionRunId: adopt.id } }));
    console.log(`🎬 Autonomous music video ${short(run.id)} adopted production run ${short(adopt.id)}`);
  }
  if (adopt.status === 'completed') {
    await finishFromProduction(projectId, adopt.id);
  } else if (adopt.status === 'awaiting-video' && !stillsApproved) {
    // Only approving the stills goes on to the clips; any other resume reviews them (again).
    settleStills(projectId, run, adopt.id).catch((err) => console.error(`❌ Autonomous music video ${short(run.id)} stills review: ${err.message}`));
  } else {
    // A footage run started before shots were composed by default renders its drafts from them.
    if (!rendersFromCode(project, run)) await ensureFootageComposition(projectId);
    // Resuming a "running" run is safe and re-pins one left by a previous server process.
    const productionLimits = limits ? Object.fromEntries(Object.entries(limits).filter(([, v]) => v != null)) : undefined;
    const failure = await deps.resumeProduction(projectId, adopt.id, {
      acceptBasis: true,
      ...(productionLimits ? { limits: productionLimits } : {}),
      ...(swapModels ? { pool: briefProductionPool(run.brief, project) } : {}),
      ...(directionChanged ? { directive: briefDirective(run.brief) } : {}),
    })
      .then(() => null, (err) => err);
    if (failure) {
      const parked = await park(projectId, 'needs-human', { error: trimTo(`Production could not resume: ${failure.message}`, 500), errorCode: failure.code || null });
      return { project: parked.project, run: presentAutonomousRun(parked.run) };
    }
  }
  const latest = await getProject(projectId);
  return { project: presentProjectAutonomousRun(latest), run: presentAutonomousRun(projectAutonomousRun(latest)) };
}

// Read from the freshly patched record, so a job id stored a moment before the status flipped is seen.
const cancelLocalSongJob = (projectId, run, failures) => (run.stage === 'song' && run.output.localSongJobId
  ? settleChildStop(failures, projectId, run, 'cancel song job', run.output.localSongJobId, () => deps.cancelLocalSong(run.output.localSongJobId))
  : null);

export async function stopAutonomousVideo(projectId) {
  const { run } = await requireRun(projectId);
  if (!['running', 'awaiting-approval', 'needs-human'].includes(run.status)) throw runError(409, 'NOT_RUNNING', `A ${run.status} run cannot be stopped`);
  const out = await patchRun(projectId, () => ({ status: 'stopped' }));
  const { productionRunId, finalAutoReviewId } = out.run.output;
  const childStopFailures = [];
  if (productionRunId) {
    await settleChildStop(childStopFailures, projectId, run, 'stop production', productionRunId, () => deps.stopProduction(projectId, productionRunId));
  }
  if (finalAutoReviewId) await settleChildStop(childStopFailures, projectId, run, 'stop auto-review', finalAutoReviewId, () => deps.stopAutoReview(projectId, finalAutoReviewId));
  abortSunoSong(run.id);
  await cancelLocalSongJob(projectId, out.run, childStopFailures);
  return { project: out.project, run: presentAutonomousRun(out.run), childStopFailures };
}

export async function cancelAutonomousVideo(projectId) {
  const { run } = await requireRun(projectId);
  if (!(AUTONOMOUS_LIVE_STATUSES.includes(run.status) || run.status === 'failed')) throw runError(409, 'NOT_CANCELABLE', `A ${run.status} run cannot be canceled`);
  const out = await patchRun(projectId, () => ({ status: 'canceled', awaiting: null }));
  // Child ids come from the patched record: one stored just before the flip is missed by the earlier read.
  const { renderJobId, finalAutoReviewId, productionRunId } = out.run.output;
  const childStopFailures = [];
  if (renderJobId) await settleChildStop(childStopFailures, projectId, run, 'cancel render', renderJobId, () => deps.cancelRender(renderJobId));
  if (finalAutoReviewId) await settleChildStop(childStopFailures, projectId, run, 'cancel auto-review', finalAutoReviewId, () => deps.cancelAutoReview(projectId, finalAutoReviewId));
  if (productionRunId) {
    await settleChildStop(childStopFailures, projectId, run, 'cancel production', productionRunId, () => deps.cancelProduction(projectId, productionRunId));
  }
  abortSunoSong(run.id);
  await cancelLocalSongJob(projectId, out.run, childStopFailures);
  return { project: out.project, run: presentAutonomousRun(out.run), childStopFailures };
}

registerReconciliation(advanceInBackground);

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

export const __testing = { onProductionEvent, onRenderEvent, onAutoReviewEvent, advance, settleBackground };
