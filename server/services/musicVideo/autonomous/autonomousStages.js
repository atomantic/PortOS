/** Executors for each autonomous stage and the dependencies each stage calls. */

import { musicVideoMediaMode } from '../../../lib/musicVideo/musicVideoMediaPolicy.js';
import { prepareProductionReview } from '../productionReviewService.js';
import { assertProductionApproval, productionReadiness } from '../productionReview.js';
import { CAST_SETS_WORKING } from '../castAndSets.js';
import { codeFirstProductionAssets, musicVideoGenerationAllowance } from '../../../lib/musicVideo/musicVideoMediumPlan.js';
import { trimTo } from '../../../lib/textUtils.js';
import { getMusicVideoCharacterStyle } from '../../../lib/musicVideo/musicVideoCharacterStyles.js';
import { RENDER_TARGET } from '../../../lib/renderTargets.js';
import { IMAGE_GEN_MODE } from '../../../lib/generationModes.js';
import {
  autonomousLyricsReviewEnabled,
  autonomousMedium,
  autonomousPool,
  isOrchestratedRun,
  SUNO_LIMITS,
  sunoSongFields,
} from '../../../lib/musicVideo/musicVideoAutonomous.js';
import { withBackupAssetPublication } from '../../../lib/backupSnapshotBoundary.js';
import { getProject } from '../projects.js';
import {
  PROCESS_ID,
  short,
  deps,
  runError,
  projectAutonomousRun,
  ownsRunningRun,
  patchRun,
  stagePatch,
  RENDER_STEP,
  CAST_STEP,
  settleChildStop,
  llmOf,
} from './autonomousRunStore.js';
import {
  autoApproves,
  alignRunLyrics,
  cueText,
  orchestrateLyrics,
  orchestrateStyle,
  orchestrateSong,
  settleLyricTiming,
  anchorStoryboardLyrics,
  briefDirective,
  rendersFromCode,
  stageBlockers,
  settleProductionStage,
  settleOverlayText,
  ensureFootageComposition,
} from './autonomousOrchestration.js';

// The song stage's step while it waits for the director to pick a Suno render to download.
export const SONG_PICK_STEP = 'pick-take';

// Every key the song stage (and `localSong`) writes; a retake nulls them all so
// the stage runs from scratch — a new Suno request (the director's explicit,
// credit-spending choice) or a new local render on a new track.
export const SONG_OUTPUT_KEYS = ['trackId', 'sunoSongIds', 'sunoSongPick', 'songTakeApproved', 'songSource', 'songFallbackReason', 'localTrackId', 'localSongJobId'];

const sunoControllers = new Map();
export const abortSunoSong = (runId) => sunoControllers.get(runId)?.abort();

/** Keep the route a text stage ran on in the project's brief too (best-effort, never fails the stage). */
const recordRoute = (project, stage, route) => (route ? deps.recordRoute(project.id, stage, route).catch(() => null) : null);

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
    localMusic: run.brief.localMusic,
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

// Draft, then — when the brief asks for it — review & revise on the
// `lyricsReview` stage's LLM. The review is a step inside the lyrics stage (the
// stage list is wire/UI contract), reported through `stages.lyrics.step`. The
// draft is stored before the review runs, so a failed review retries only the review.
async function writeRunLyrics({ project, run, save }) {
  if (run.brief.instrumental) return { output: { lyrics: '' } };
  const review = autonomousLyricsReviewEnabled(run.brief);
  const description = run.output.musicalDescription;
  const guidance = run.brief.guidance || undefined;
  // The prompt carries the lyrical intent (hook, subject, imagery); the musical description only the sound.
  const request = run.brief.prompt || undefined;
  const step = (name) => patchRun(project.id, (r) => stagePatch(r, 'lyrics', { step: name }));
  let draft = review ? run.output.lyricsDraft : null;
  let draftRoute = review ? run.output.lyricsRoute : null;
  if (!draft) {
    if (review) await step('draft');
    const { route, ...llm } = await llmOf(run, 'lyrics');
    ({ lyrics: draft } = await deps.writeLyrics({ description, guidance, request, ...llm }));
    draftRoute = route;
    await recordRoute(project, 'lyrics', route);
    if (!review) return { output: { lyrics: draft, ...(route ? { lyricsRoute: route } : {}) } };
    await save({ output: { lyricsDraft: draft, ...(route ? { lyricsRoute: route } : {}) } });
  }
  await step('review');
  const { route, ...llm } = await llmOf(run, 'lyricsReview');
  const revised = await deps.reviewLyrics({ lyrics: draft, description, guidance, request, ...llm });
  await recordRoute(project, 'lyricsReview', route);
  return { output: {
    lyricsDraft: draft,
    lyrics: revised.lyrics,
    lyricsReviewNotes: revised.notes || '',
    ...(draftRoute ? { lyricsRoute: draftRoute } : {}),
    ...(route ? { lyricsReviewRoute: route } : {}),
  } };
}

// The board's notes render on the run's first image tool with its pinned model.
// Null keeps the board text-only: the brief names no image tool (its tool list
// is what autopilot may use), or the run has a dollar cap and the tool is not
// the free local backend — these pre-production renders are not counted
// against production's spend cap, so a capped run never spends on them.
// Only reached in a mode that allows images (code-only builds no board).
function boardRenderRoute(run) {
  const tool = (run.brief.tools || []).find((id) => id.startsWith('image:'));
  if (!tool) return null;
  const mode = tool.slice('image:'.length);
  if (run.brief.budgetUsd != null && mode !== IMAGE_GEN_MODE.LOCAL) return null;
  return { target: RENDER_TARGET.MUSIC_VIDEO, mode, model: run.brief.models?.[tool] || undefined };
}

async function createRunStyle({ project, run }) {
  if (musicVideoMediaMode(project) === 'code-only') {
    await deps.updateProject(project.id, { concept: { prompt: run.output.concept.prompt, style: run.output.concept.style || run.output.moodBoard?.stylePrompt || '' } });
    return { output: { moodBoardId: null } };
  }
  const board = run.output.moodBoard;
  const moodBoardId = run.brief.moodBoardId || run.output.moodBoardId
    || (await deps.createMoodBoard(board, { renderRoute: boardRenderRoute(run) })).id;
  // The board is also the project's linked mood board; the server derives the
  // authored style snapshot from it (styleSnapshots.js).
  await deps.updateProject(project.id, {
    concept: { prompt: run.output.concept.prompt, ...(run.output.concept.style ? { style: run.output.concept.style } : {}) },
    visualSpec: { moodBoardId },
  });
  return { output: { moodBoardId } };
}

// The brief is written knowing who stars in the video, so its concept and look
// fit the fixed character instead of inventing a different lead.
function briefGuidance(brief) {
  const style = getMusicVideoCharacterStyle(brief.characterStyleId);
  if (!style) return brief.guidance;
  const lead = `The video stars ${style.character.name} (${style.label} character style), a fixed-identity performer: ${style.summary}`;
  return [brief.guidance, lead].filter(Boolean).join('\n\n');
}


// The brief's optional audio→MIDI step: the transcription's parts, hits and
// chords then reach the Cast & Sets direction and the shot plan
// (songMidiDigest.js). Best-effort: a missing MuScriptor runtime or a failed
// transcription leaves the run planning from the beat analysis alone.
async function transcribeRunMidi(projectId, run) {
  const project = await getProject(projectId);
  if (!project || project.midiTranscription?.filename) return;
  console.log(`🎹 Autonomous music video ${short(run.id)}: transcribing the song to MIDI for planning`);
  const frame = await deps.transcribeMidi(project).catch((err) => ({ type: 'error', error: err.message }));
  if (frame?.type === 'complete' && frame.midiTranscription) return;
  console.warn(`⚠️ Autonomous music video ${short(run.id)}: MIDI transcription skipped (${trimTo(frame?.error || (frame?.discarded ? 'the song changed' : frame?.type) || 'no result', 200)}); planning from the beat analysis`);
}


/** The production pool a brief allows on this project: each route's kind must be generable under the project's allowance. */
export const briefProductionPool = (brief, project) => {
  const allowance = musicVideoGenerationAllowance(project);
  return autonomousPool(brief.tools, brief.models).filter((route) => allowance[route.kind]);
};

/** Production stops before its clips: the plan needs clips, and the run asked to stop or has no video route. */
function stopsBeforeClips(project, run, pool) {
  const needsClips = codeFirstProductionAssets(project)?.requiredRoutes.video ?? true;
  return needsClips && (run.brief.stopBeforeVideo === true || !pool.some((route) => route.kind === 'video'));
}

// ---- stage executors -------------------------------------------------------------
// Each returns `{ output }` (merged into run.output) or `{ output, wait: true }`
// when the stage's completion arrives later (production).
export const STAGES = {
  async brief({ project, run }) {
    const { route, ...llm } = await llmOf(run, 'brief');
    const reused = run.brief.songFrom;
    const { brief: drafted } = await deps.draftCreativeBrief({
      prompt: run.brief.prompt, guidance: briefGuidance(run.brief), instrumental: run.brief.instrumental, ...llm,
      ...(reused ? { song: { title: reused.title, style: reused.style, lyrics: run.output.lyrics } } : {}),
    });
    // A reused song keeps its own title and style; the brief only designs the video around it.
    const brief = reused ? { ...drafted, title: reused.title, ...(reused.style ? { sunoStyle: trimTo(reused.style, SUNO_LIMITS.style) } : {}) } : drafted;
    // A blank project name from the prompt gives way to the song title.
    if (!run.brief.name) await deps.updateProject(project.id, { name: trimTo(brief.title, 200) });
    await recordRoute(project, 'brief', route);
    return { output: { ...brief, ...(route ? { briefRoute: route } : {}) } };
  },

  // The orchestrator judges the written lyrics and may rewrite them (orchestrateLyrics).
  async lyrics(ctx) {
    const { project, run, save } = ctx;
    // A reused song's lyrics were copied with it at start.
    if (run.brief.songFrom) return { output: {} };
    if (run.brief.instrumental || !isOrchestratedRun(run)) return writeRunLyrics(ctx);
    // The draft (or reviewed draft) is stored before the orchestrator judges it,
    // so a failed review retries only the review.
    let written = run.output.lyricsForReview ? { output: { lyrics: run.output.lyricsForReview } } : null;
    if (!written) {
      written = await writeRunLyrics(ctx);
      await save({ output: { ...written.output, lyricsForReview: written.output.lyrics } });
    }
    const lyrics = await orchestrateLyrics(project.id, run, written.output.lyrics);
    return { output: { ...written.output, lyrics, lyricsForReview: null } };
  },

  async style({ project, run, save }) {
    // The orchestrator judges the sound & look before the mood board is made from it.
    if (isOrchestratedRun(run) && !run.output.styleReviewed) {
      const reviewed = await orchestrateStyle(project.id, run);
      ({ run } = await save({ output: { ...reviewed, styleDraft: null, styleReviewed: true } }));
    }
    return createRunStyle({ project, run });
  },

  async song({ project, run, save }) {
    if (run.output.trackId) return { output: {} };
    // `output.songSource` records a fallback already taken, so a resume stays local.
    if ((run.output.songSource || run.brief.songSource) === 'local') return localSong({ project, run, save });
    const fields = sunoSongFields({
      title: run.output.title, style: run.output.sunoStyle, lyrics: run.output.lyrics, instrumental: run.brief.instrumental, suno: run.brief.suno,
    });
    let submitted = run.output.sunoSongIds?.length > 0;
    // With a song checkpoint, park on the fresh renders before any export: a
    // Suno download spends one of the director's monthly downloads, so only the
    // render they approve is ever downloaded. The orchestrator reviews the
    // imported audio itself, so an orchestrated run exports as before.
    const pickFirst = run.brief.checkpoints.includes('song') && !isOrchestratedRun(run) && !run.output.songTakeApproved;
    if (pickFirst && submitted) return { output: {}, hold: SONG_PICK_STEP };
    let song;
    const controller = new AbortController();
    sunoControllers.set(run.id, controller);
    try {
      const latest = projectAutonomousRun(await getProject(project.id));
      if (latest?.id !== run.id || latest.status !== 'running') controller.abort();
      controller.signal.throwIfAborted();
      if (pickFirst) {
        await deps.submitSunoSong(fields, {
          signal: controller.signal,
          onSubmitted: (ids) => { submitted = true; return save({ output: { sunoSongIds: ids } }); },
        });
        return { output: {}, hold: SONG_PICK_STEP };
      }
      song = await deps.generateSunoSong(fields, {
        songIds: run.output.sunoSongIds,
        exportSongId: run.output.sunoSongPick || null,
        signal: controller.signal,
        // The long stage's sub-step rides the run record (and its socket event) so the page can show it.
        onProgress: (step) => { patchRun(project.id, (r) => stagePatch(r, 'song', { step })).catch(() => {}); },
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
    // The imported M4A is already durable; the track row that first names it
    // commits under a backup lease (#9982).
    await withBackupAssetPublication(() => deps.attachAudio(track.id, song.filename, {
      source: 'suno', prompt: fields.style, lyrics: fields.lyrics, durationSec, sunoSongId: song.songId,
    }));
    // Linking the track seeds the project's timed lyric cues from the track lyrics.
    await deps.updateProject(project.id, { trackId: track.id });
    return { output: { trackId: track.id, sunoSongIds: song.songIds } };
  },

  async analyze({ project, run }) {
    if (run.brief.songFrom) {
      // A reused song arrives analyzed and word-timed from its source project and is
      // kept as is (no song review, so no retake); only what the source lacks is made.
      if (!project.audioAnalysis) await deps.analyzeSong(project.id);
      const untimed = (project.lyricCues || []).some((c) => cueText(c) && !c.words?.length);
      if (untimed && (isOrchestratedRun(run) || autoApproves(run, 'storyboard'))) await alignRunLyrics(project.id, run);
    } else {
      await deps.analyzeSong(project.id);
      // A storyboard grant needs the lyric timings production verifies, so the autopilot aligns too.
      if (!isOrchestratedRun(run) && autoApproves(run, 'storyboard')) await alignRunLyrics(project.id, run);
      if (isOrchestratedRun(run) && (await orchestrateSong(project.id, run)).retake) {
        // A local fallback stays local: the retake must not send the run back to Suno.
        const reset = Object.fromEntries(SONG_OUTPUT_KEYS.filter((key) => key !== 'songSource' && key !== 'songFallbackReason').map((key) => [key, null]));
        return { output: reset, goto: 'song', unlinkTrack: run.output.trackId || null };
      }
    }
    if (run.brief.transcribeMidi) await transcribeRunMidi(project.id, run);
    // The single's own cover design, drafted from the song just made, ready
    // for the publishing kit. Best-effort: a failed draft never stops the video.
    if (!project.publishKit?.coverArt?.design) {
      const { providerId, model } = await llmOf(run, 'brief');
      await deps.designCoverArt(project.id, { providerId: providerId || null, model: model || null })
        .catch((err) => console.warn(`⚠️ Autonomous music video ${short(run.id)} cover design skipped: ${trimTo(err.message, 200)}`));
    }
    return { output: {} };
  },

  async produce({ project, run }) {
    const medium = rendersFromCode(project, run) ? 'code' : autonomousMedium(run.brief.tools);
    if (medium === 'code' && !['code', 'document'].includes(project.composition?.mode)) {
      await deps.updateProject(project.id, { composition: { mode: 'document', authoringRenderer: 'three' } });
    } else if (medium !== 'code') await ensureFootageComposition(project.id);
    await prepareProductionReview(project.id);
    project = await getProject(project.id);
    // The guide is generated in the background; the art gate is only meaningful once it exists.
    const castStage = project.castAndSets;
    if (castStage?.status === 'failed') {
      throw runError(500, 'CAST_SETS_FAILED', `Cast & Sets failed: ${castStage.stopReason || castStage.error || 'unknown error'}`);
    }
    if (CAST_SETS_WORKING.includes(castStage?.status) && productionReadiness(project).art.problems.length) {
      await deps.resumeInterruptedCastAndSets(project);
      return { output: {}, wait: true, step: CAST_STEP };
    }
    const artWasApproved = productionReadiness(project).art.approved;
    project = await settleProductionStage(project, run, 'art');
    if (!artWasApproved && productionReadiness(project).art.approved) {
      // Preparing stops at the art gate; with art approved it drafts the storyboard.
      await prepareProductionReview(project.id);
      project = await getProject(project.id);
    }
    let timingHeld = null;
    if (isOrchestratedRun(run) || autoApproves(run, 'storyboard')) {
      timingHeld = await settleLyricTiming(project.id, run);
      // The orchestrator anchors inside its storyboard review; the autopilot does it here.
      if (!isOrchestratedRun(run)) await anchorStoryboardLyrics(project.id);
      project = await getProject(project.id);
    }
    project = await settleProductionStage(project, run, 'storyboard');
    // Name why the timing was left unverified rather than only that it is provisional,
    // with the storyboard's other open problems so one resume can clear them all.
    const storyboard = productionReadiness(project).storyboard;
    if (timingHeld && !storyboard.approved) {
      const others = storyboard.problemItems.filter((p) => p.code !== 'alignment-unverified').map((p) => p.message);
      throw runError(409, 'MUSIC_VIDEO_APPROVAL_REQUIRED', trimTo([timingHeld, ...others].join(' '), 500));
    }
    // A medium conflict the run could not revise is named, so the director knows what to change.
    const blockers = storyboard.approved ? [] : stageBlockers(project, run, 'storyboard');
    if (blockers.length) throw runError(409, 'MUSIC_VIDEO_APPROVAL_REQUIRED', trimTo(blockers.join(' '), 500));
    assertProductionApproval(project, 'storyboard');
    // The authoring stage's pin, else the run's code-authoring pin taken as
    // given (production checks it exactly), else the direction LLM.
    const authoring = !run.brief.llmStages?.authoring && run.brief.authoring ? run.brief.authoring : await llmOf(run, 'authoring');
    const input = { providerId: authoring.providerId, model: authoring.model || undefined, ...(authoring.effort ? { effort: authoring.effort } : {}) };
    if (medium === 'code') {
      if (project.composition?.mode === 'code') {
        if (!project.composition?.codeVideo?.sections?.length) await deps.generateCode(project.id, input);
      } else if (!project.composition?.document) {
        const candidate = project.composition?.documentDraft ? { document: project.composition.documentDraft }
          : await deps.generateDocument(project.id, input);
        await deps.acceptDocument(project.id, candidate.document.directory);
      }
      // Stopped during the check: the advance loop sees the run is no longer running and lets it be.
      if (!await settleOverlayText(project.id, run)) throw runError(409, 'RUN_STOPPED', 'The run stopped during the overlay text check');
      // The animated proof is optional review evidence, so the run renders the film once the
      // storyboard is approved; the director can still render and approve a proof by hand.
      const render = await deps.renderVideo(project.id);
      // A cancel/stop during the render's preparation left no job id to cancel; the fresh job is stopped here.
      if (render?.jobId && projectAutonomousRun(await getProject(project.id))?.status !== 'running') {
        await deps.cancelRender(render.jobId).catch((err) => console.warn(`⚠️ Autonomous music video ${short(run.id)} could not cancel render ${render.jobId}: ${err.message}`));
        throw runError(409, 'RUN_STOPPED', 'The run stopped while the final render was preparing');
      }
      // The run is not finished until the MP4 exists: stay on produce and let the render's own event settle it.
      return { output: { renderJobId: render?.jobId || null }, wait: true, step: RENDER_STEP };
    }
    const pool = briefProductionPool(run.brief, project);
    if (!ownsRunningRun(projectAutonomousRun(await getProject(project.id)), run)) {
      throw runError(409, 'RUN_STOPPED', 'The run stopped before production could start');
    }
    const started = await deps.startProduction(project.id, {
      directive: briefDirective(run.brief),
      pool,
      ...(stopsBeforeClips(project, run, pool) ? { stopBefore: 'clips' } : {}),
      limits: { ...run.brief.limits, ...(run.brief.budgetUsd != null ? { spendCapUsd: run.brief.budgetUsd } : {}) },
      // The orchestrator also judges production's plates and drafts when the run has one.
      reviewer: isOrchestratedRun(run)
        ? { providerId: run.brief.orchestrator.providerId, model: run.brief.orchestrator.model || null }
        : { providerId: run.brief.llm?.providerId || null, model: run.brief.llm?.model || null },
      authoring: input,
    });
    // A stop during preparation had no child id to stop; cancel the fresh child before handing it off.
    if (!ownsRunningRun(projectAutonomousRun(await getProject(project.id)), run)) {
      // Persist the child before cancellation: a failed stop must leave it discoverable for recovery.
      await patchRun(project.id, (current) => current.id === run.id && current.output.productionRunId === run.output.productionRunId
        ? { output: { productionRunId: started.run.id } } : {})
        .catch((err) => console.error(`❌ Autonomous music video ${short(run.id)} could not retain late production ${started.run.id}: ${err.message}`));
      await settleChildStop([], project.id, run, 'cancel production', started.run.id, () => deps.cancelProduction(project.id, started.run.id));
      throw runError(409, 'RUN_STOPPED', 'The run stopped while production was preparing');
    }
    return { output: { productionRunId: started.run.id }, wait: true };
  },
};
