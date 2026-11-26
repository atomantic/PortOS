/**
 * Music Video — final render pipelines (#1760, Phase 2).
 *
 * A final render is one of three pipelines, each run as a job by the shared
 * lifecycle in finalRenderJob.js (slot, `rendering` mark, cancellation,
 * publication, terminal order). This module holds only what differs: how each
 * pipeline plans and how it encodes.
 *
 * - Footage concat: assembles a project's per-scene i2v clips (each a
 *   `videoHistoryId` entry the scene-video hook filed) into a single MP4 laid
 *   under the project's source track as the **master audio bed** — the music
 *   video's defining shape: one music track under all clips, the per-clip
 *   generated audio dropped. Its ffmpeg graph concats video-only and maps one
 *   external audio input as the sole output audio, ended on `-shortest` so the
 *   render runs only as long as the shorter of (video, track).
 * - Composed: renders shot by shot into the segment cache and stitches.
 * - Seeked (code, composition document, Eidoverse, Blender): seeks a
 *   composition instead of concatenating footage (seekedRenderers.js).
 *
 * Beat-snap: when the project carries a cached beat analysis, each cut is
 * trimmed back to the nearest beat (never extended — a clip can't grow), so
 * cuts land on the music. With no analysis the clips render at their natural
 * length. A scene the director has explicitly arranged on the beat-quantized
 * timeline (#1854 — `startSec`/`endSec`/`beatAligned` saved via drag-snap in
 * the client) skips this live re-derivation entirely: its saved boundaries
 * are honored exactly, so the render matches what was shown on the timeline
 * rather than whatever the current beat grid would produce.
 */

import { spawn } from '../../lib/childProcess.js';
import { existsSync } from 'fs';
import { readdir, unlink } from 'fs/promises';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { filterGraphViaFile } from '../../lib/ffmpegFilterGraph.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { attachFfmpegRenderGuard } from '../../lib/ffmpegRenderGuard.js';
import { assertSongAudioCurrent } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { endingSeconds } from '../../lib/musicVideo/musicVideoEnding.js';
import { coldOpenScenes } from '../../lib/musicVideo/musicVideoColdOpen.js';
import { normalizeBlenderRecord } from '../../lib/musicVideo/musicVideoBlender.js';
import { loadHistory } from '../videoGen/history.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { assertProductionApproval, nameShots } from './productionReview.js';
import { isMusicVideoRenderCancelPending, isMusicVideoRenderCanceled } from './renderCancellation.js';
import { listProjects, updateProject, mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { applyProjectPatch } from './projectsLogic.js';
import { isLocalRenderMark, settledRender } from './renderSettlement.js';
import { writeCodeProofSheet } from './codeRender.js';
import { sweepDocumentScratch } from './documentRender.js';
import { resolveSeekedInputs, seekedRendererFor } from './seekedRenderers.js';
import { sweepCompositionScratch } from './compositionRender.js';
import { applyFilmLookFinish, filmLookFinishNeeded, sweepFilmLookScratch } from './filmLookFinish.js';
import { appendStatsOutro, sweepStatsOutroScratch } from './statsOutro.js';
import { applyFrameHold, projectFrameHold } from './frameHold.js';
import { isProjectRenderActive, projectRenders } from './renderActivityState.js';
import { resolveMasterAudioPath } from './masterAudioPath.js';
import { planMusicVideoRender } from './renderPlan.js';
import { buildMusicVideoFfmpegArgs } from './renderFfmpegArgs.js';
import { posterTimeFor, renderCanceled, runFinalRenderJob } from './finalRenderJob.js';

export { buildMusicVideoFfmpegArgs, isLocalRenderMark, isProjectRenderActive, resolveMasterAudioPath };
export { beatSnapClips, excerptBoundaryTimes, planMusicVideoRender, resolveColdOpenClips, resolveSceneClips, resolveSoundBedPath } from './renderPlan.js';
// The job map lives with the lifecycle; the SSE, status and cancel routes reach it through here.
export { attachRenderSseClient, cancelRender, getActiveRenderJobId, getRenderJobStatus } from './finalRenderJob.js';
// Code-rendered mode (#9076) and the composition-document mode seek a composition instead of
// concatenating footage; their renderers live in seekedRenderers.js, shared with the draft excerpts.
export { seekedRendererFor };

// A seeked composition: the mode's encode, then the ending and the film look pass.
async function seekedPipeline(projectId, project, renderer, { jobId, outputPath }) {
  // Resolve the master before any rendering mark. A missing track throws here
  // and the lifecycle releases the pending slot without leaving a job running.
  const { audioPath, soundBed } = await resolveSeekedInputs(renderer, project, {
    checkAudio: (path) => assertSongAudioCurrent(project, basename(path)),
  });
  const prepared = await renderer.prepare(project);
  const { plan } = prepared;
  // A renderer that cannot draw the film look in its page gets the footage renders' finishing
  // pass (filmLookFinish.js), which takes the second half of the progress bar.
  const finishing = Boolean(renderer.filmLookFinish) && filmLookFinishNeeded(project, { shotLooks: true });
  const encodeTop = finishing ? 0.5 : 1;
  return {
    label: renderer.label,
    modelId: renderer.modelId,
    totalDuration: plan.durationSec,
    summary: `frames=${Math.round(plan.durationSec * plan.fps)} footage=off`,
    encode: async ({ signal, onProgress, checkApproval }) => {
      await checkApproval();
      if (signal.aborted) throw renderCanceled();
      const encoded = await renderer.encode({
        prepared, project, projectId, jobId, audioPath, soundBed, outputPath, signal, lookPass: finishing,
        onProgress: (fraction) => onProgress(encodeTop * fraction),
      });
      // The ending (cutting room floor, credits; when on) joins after the song.
      const outroSec = await appendStatsOutro({ project, path: outputPath, jobId, signal, withFilmLook: !!renderer.filmLookInPage });
      // After the ending, so the look grades it with the rest of the film. `lookPassInputs` is
      // what the encode left for the pass to draw over the look (a Blender film's steady title card).
      if (finishing) {
        await applyFilmLookFinish({ project, shotLooks: true, path: outputPath, jobId, signal, ...encoded.lookPassInputs,
          onProgress: (fraction) => onProgress(encodeTop + (1 - encodeTop) * fraction) });
      }
      const leadSec = encoded.leadSec ?? 0;
      return {
        ...encoded,
        leadSec,
        songSec: encoded.durationSec - leadSec,
        durationSec: encoded.durationSec + outroSec,
        posterAtSec: typeof project.composition?.posterSec === 'number'
          ? project.composition.posterSec + leadSec
          : (encoded.boundaryTimes[0] || 0),
        proofSheet: (sheetPath) => writeCodeProofSheet(outputPath, sheetPath, encoded.boundaryTimes, {
          width: encoded.width, height: encoded.height, fps: encoded.fps,
        }),
      };
    },
    // What a renderer keeps about the final it made, once it is the project's final.
    onPublished: async ({ settled, encoded }) => { if (settled) await renderer.recordFinal?.({ projectId, jobId, encoded }); },
  };
}

// A composed footage render (shotSegments.js): each shot section, its film
// look and the outro come from the segment cache, rendering only what is
// missing, then join by stream copy with the song laid under them once.
async function composedPipeline(project, options, { jobId, outputPath }) {
  const { planShotSegments, renderMissingSegments, stitchSegments, pruneSegments } = await import('./shotSegments.js');
  const startedAtMs = Date.now();
  const plan = await planShotSegments(project);
  const all = [...plan.segments, ...(plan.outro ? [plan.outro] : [])];
  const cached = all.filter((segment) => existsSync(segment.path)).length;
  return {
    totalDuration: plan.songSec,
    summary: `segments=${all.length} cached=${cached} duration=${plan.songSec.toFixed(2)}s`,
    // The mark boot recovery reads to start this render again after a restart:
    // the shots it finished are cached, so the rerun picks up where it stopped.
    mark: { renderResume: options.resumable ? { attempt: options.resumeAttempt || 0 } : null },
    encode: async ({ signal, onProgress, checkApproval }) => {
      // Shots take 95% of the bar; joining and laying the song under them the rest.
      await renderMissingSegments(plan, { signal, onProgress: (fraction) => onProgress(0.95 * fraction) });
      await checkApproval();
      const { durationSec, songSec, leadSec } = await stitchSegments(plan, outputPath, { signal });
      // The stepped medium (#14244) holds the stitched cut; shot looks are already in it.
      const hold = projectFrameHold(project);
      if (hold) await applyFrameHold({ path: outputPath, sections: plan.sections, leadSec, signal, ffmpeg: plan.ffmpeg, ...hold });
      if (plan.deferredTitleCard) await (await import('./titleCardFinish.js')).applyTitleCardFinish({ project, path: outputPath, jobId, leadSec, songSec: plan.songSec,
        width: plan.width, height: plan.height, fps: plan.fps, signal, ffmpeg: plan.ffmpeg });
      onProgress(1);
      return {
        width: plan.width, height: plan.height, fps: plan.fps, durationSec, songSec, leadSec,
        posterAtSec: posterTimeFor(project, { songSec, leadSec }),
      };
    },
    // Older takes of each shot are dropped once the new cut is published.
    onPublished: async () => {
      const pruned = await pruneSegments(plan, { startedAtMs, current: true }).catch(err => { console.warn(`⚠️ Music-video segment cleanup failed: ${err.message}`); return 0; });
      return `${all.length - cached} of ${all.length} segments rendered${pruned ? `, ${pruned} old dropped` : ''}`;
    },
  };
}

// One ffmpeg child encoding the whole footage cut. Resolves on a zero exit and
// rejects with the failure, or with `renderCanceled()` when the exit was a cancel.
const runFootageEncode = ({ job, ffmpeg, graph, totalDuration, onProgress }) => new Promise((resolve, reject) => {
  const short = job.id.slice(0, 8);
  const dropGraphFile = () => (graph.file ? unlink(graph.file).catch(() => {}) : null);
  // A cancel can land in the window between job creation and the spawn.
  if (isMusicVideoRenderCancelPending(job)) {
    dropGraphFile();
    reject(renderCanceled());
    return;
  }
  const proc = spawn(ffmpeg, graph.args, safeChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
  job.process = proc;

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1);
      if (key === 'out_time_us') {
        const us = parseInt(val, 10);
        if (Number.isFinite(us) && totalDuration > 0) onProgress(Math.min(1, (us / 1_000_000) / totalDuration));
      } else if (key === 'progress' && val === 'end') {
        onProgress(1);
      }
    }
  });

  // Spawn-state tracking + exactly-once terminal guard + pre-vs-post-spawn
  // dispatch live in the shared helper; the bodies below only settle this promise.
  attachFfmpegRenderGuard(proc, {
    label: `Music-video render [${short}]`,
    onProcessError: (err) => {
      // Post-spawn error (e.g. a failed kill during cancel). The ffmpeg is
      // still live — do NOT settle or null job.process here, or the lifecycle
      // would release the project's slot and a replacement render could spawn
      // and overlap it. Record the reason; the pending 'close' settles.
      job.lastError = `ffmpeg process error: ${err.message}`;
      console.log(`⚠️ Music-video render post-spawn error [${short}]: ${err.message}`);
    },
    onSpawnError: async (err) => {
      // Pre-spawn failure: the child never started, so 'close' won't follow.
      await dropGraphFile();
      job.process = null;
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    },
    onClose: async (code, signal) => {
      job.process = null;
      await dropGraphFile();
      if (code === 0) return resolve();
      reject(isMusicVideoRenderCanceled(job, signal) ? renderCanceled()
        : new Error(signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`));
    },
  });
});

// The footage concat: one ffmpeg encode, then the passes that work on its finished cut.
async function footagePipeline(project, { jobId, outputPath }) {
  const { ffmpeg, audioPath, composed, clips, coldOpen, audioDurationSec, soundBed, aspect } = await planMusicVideoRender(project);
  const { args, totalDuration, canonW, canonH, fps, sections } = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, frameGrid: composed, soundBed, grade: composed ? project.composition?.grade : null, beats: project.audioAnalysis?.beats, aspect });
  // A footage render with a film look re-encodes its finished cut through the look after ffmpeg.
  const finishing = filmLookFinishNeeded(project);
  const encodeTop = finishing ? 0.5 : 1;
  // Seconds the ending (cutting room floor, credits) adds after the song (0 when both are off).
  const outroSec = endingSeconds(project);
  return {
    totalDuration,
    summary: `clips=${clips.length} duration=${totalDuration.toFixed(2)}s`,
    // A long filter graph goes to ffmpeg in this file, removed once ffmpeg exits.
    stage: () => filterGraphViaFile(ffmpeg, args, join(tmpdir(), `portos-music-video-${jobId}.filtergraph`)),
    encode: async ({ job, signal, onProgress, staged: graph }) => {
      await runFootageEncode({ job, ffmpeg, graph, totalDuration, onProgress: (fraction) => onProgress(encodeTop * fraction) });
      // The job-lifetime abort signal covers every post-encode pass; a cancel that
      // lands between passes (or raced a clean exit) is caught before the next one starts.
      const pass = async (label, work) => {
        if (isMusicVideoRenderCancelPending(job)) throw renderCanceled();
        await work().catch((err) => { throw signal.aborted ? renderCanceled() : new Error(`${label} failed: ${err.message}`); });
      };
      // Seconds the cold open adds before the song, once it is cut in front.
      let leadSec = 0;
      // Grade the cold open and outro with the rest of the film.
      if (coldOpen) await pass('Cold open', async () => {
        const { prependColdOpen } = await import('./coldOpen.js');
        leadSec = await prependColdOpen({ project, coldOpen, path: outputPath, ffmpeg, jobId, signal });
      });
      if (outroSec > 0) await pass('Outro scene', () => appendStatsOutro({ project, path: outputPath, jobId, signal }));
      // Step the cut before adding grain and weave, which move every frame.
      const hold = projectFrameHold(project);
      if (hold) await pass('Frame hold', () => applyFrameHold({ path: outputPath, sections, leadSec, signal, ffmpeg, ...hold }));
      if (finishing) await pass('Film look pass', () => applyFilmLookFinish({ project, path: outputPath, jobId, signal,
        onProgress: (fraction) => onProgress(encodeTop + (1 - encodeTop) * fraction) }));
      return {
        width: canonW, height: canonH, fps: fps || 24, durationSec: leadSec + totalDuration + outroSec,
        songSec: totalDuration, leadSec,
        posterAtSec: posterTimeFor(project, { songSec: totalDuration, leadSec }),
      };
    },
  };
}

// A seeked mode has no footage timeline to cut a cold open into; only a Blender
// film's own lead-in shots may play before the song.
async function assertColdOpenRenderable(project, seeked) {
  const cold = coldOpenScenes(project);
  if (!seeked || !cold.length) return;
  let allowed = new Set();
  if (project.composition?.mode === 'blender') {
    const { readBlenderManifest } = await import('./blender/manifest.js');
    const manifest = await readBlenderManifest(project.id);
    const sceneMap = normalizeBlenderRecord(project.blender).sceneMap || {};
    allowed = new Set((manifest?.shots || []).filter((shot) => shot.start < 0).map((shot) => sceneMap[shot.id]).filter(Boolean));
  }
  const stray = cold.filter((scene) => !allowed.has(scene.sceneId));
  if (stray.length) {
    throw new ServerError(`${nameShots(project, stray.map((scene) => scene.sceneId))}: a cold open before the song plays in a footage render. Switch the render style to composed or footage, or move ${stray.length === 1 ? 'the shot' : 'the shots'} back onto the song`,
      { status: 422, code: 'PRE_MUSIC_NEEDS_FOOTAGE' });
  }
}

export async function renderMusicVideo(projectId, options = {}) {
  const permit = maintenance.admit('music-video', projectId, { continuation: true, parentKinds: ['media'] });
  try { return await permit.run(() => renderAdmittedMusicVideo(projectId, options, permit)); }
  catch (err) { permit.finish(); throw err; }
}

async function renderAdmittedMusicVideo(projectId, options, permit) {
  const project = await requireProject(projectId);
  assertProductionApproval(project, 'storyboard', { startedBy: options?.startedBy });
  if (typeof options?.codeDirectory === 'string' && options.codeDirectory) {
    throw new ServerError('Import and select the composition document before rendering.', { status: 409, code: 'MUSIC_VIDEO_UNREVIEWED_DIRECTORY' });
  }
  const { assertRenderCleanupIdle } = await import('./renderCleanupActivity.js');
  assertRenderCleanupIdle(projectId);
  // runFinalRenderJob reserves the project's slot before its first await, so no
  // concurrent start of the same project can pass between the check above and it.
  return runFinalRenderJob({
    projectId, project, options, permit,
    prepare: async (output) => {
      const seeked = seekedRendererFor(project);
      await assertColdOpenRenderable(project, seeked);
      if (seeked) return seekedPipeline(projectId, project, seeked, output);
      // A composed cut renders shot by shot into the segment cache and stitches.
      if (project.composition?.mode === 'composed') return composedPipeline(project, options, output);
      return footagePipeline(project, output);
    },
  });
}

// Boot recovery: a render job cannot survive a restart, so a persisted
// 'rendering' status with no live job is stale. Demote it to 'complete' when a
// finished render is already recorded, otherwise to 'ready', then delete the
// partial output the interrupted encode was writing (#9010). A mark another
// instance stamped is left alone — that render may still be running on the
// peer this record synced from. A list failure propagates to the bootstrap
// caller's logBootstrapFailure rather than reporting zero recovered.
// Post-encode passes write `<partial>.look.mp4`, `.outro*.mp4`, `.hold.mp4`,
// `.segments.txt`, ... beside the partial; an interrupted pass leaves them behind.
async function sweepPartialSiblings(partial) {
  const names = await readdir(PATHS.videos).catch(() => []);
  await Promise.all(names.filter((name) => name.startsWith(`${partial}.`))
    .map((name) => unlink(join(PATHS.videos, name)).catch(() => {})));
}

export async function recoverStuckMusicVideoRenders() {
  // No overlay capture survives a restart either; drop any scratch it left.
  await sweepCompositionScratch().catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove stale overlay scratch: ${err.message}`);
  });
  // Nor a composition-document render's staged copy (document + scene media).
  await sweepDocumentScratch().catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove stale composition-document scratch: ${err.message}`);
  });
  // Nor the outro scene's staged page.
  await sweepStatsOutroScratch().catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove stale outro scratch: ${err.message}`);
  });
  // Nor a film-look finishing pass's staged source copy.
  await sweepFilmLookScratch().catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove stale film-look scratch: ${err.message}`);
  });
  // Nor a cinema package build that never reached publication.
  await import('./dcp.js').then(({ sweepAbandonedDcpBuilds }) => sweepAbandonedDcpBuilds()).catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove abandoned cinema package builds: ${err.message}`);
  });
  // Nor a shot segment an interrupted render was writing (finished ones stay cached).
  await import('./shotSegmentPaths.js').then(({ sweepPartialSegments }) => sweepPartialSegments()).catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove partial shot segments: ${err.message}`);
  });
  const instanceId = await ensureInstanceId();
  const projects = await listProjects();
  const stuck = projects.filter((p) => p?.status === 'rendering'
    && !projectRenders.has(p.id) && isLocalRenderMark(p.renderingOn, instanceId));
  // Filenames the video history references, loaded on first need: a render
  // whose history append landed but whose 'complete' write failed still names
  // its (finished) file — that file is the gallery's, not a partial.
  let finished = null;
  let recovered = 0;
  const resumes = [];
  for (const project of stuck) {
    // Re-checked against the FRESHEST record under the write lock: a peer sync
    // landing between the list and this write may have handed the mark to
    // another instance (or finished it), and that render is not ours to demote.
    const outcome = await mutateProjectRecord(project.id, (current) => {
      const stillStuck = current?.status === 'rendering' && !projectRenders.has(current.id)
        && isLocalRenderMark(current.renderingOn, instanceId);
      if (!stillStuck) return { project: current, demoted: false };
      const targetStatus = current.renderHistoryId ? 'complete' : 'ready';
      return { project: applyProjectPatch(current, settledRender(targetStatus)), demoted: true, partial: current.renderPartialFilename, resume: current.renderResume };
    }).catch((err) => {
      console.error(`❌ Music Video recovery: project ${project.id.slice(0, 8)} demotion write failed: ${err.message}`);
      return null;
    });
    if (!outcome?.demoted) continue;
    recovered++;
    if (outcome.resume && (Number(outcome.resume.attempt) || 0) < MAX_RENDER_RESUMES) resumes.push({ projectId: project.id, attempt: (Number(outcome.resume.attempt) || 0) + 1 });
    // Only once the record no longer points at it. The filename came off a
    // (possibly peer-synced) record, so it is only resolved inside videos/.
    const { partial } = outcome;
    if (typeof partial !== 'string' || !partial) continue;
    // An unreadable history keeps every file — a stray partial beats deleting a finished render.
    finished ??= await loadHistory().then((history) => new Set(history.map((entry) => entry?.filename)), (err) => {
      console.warn(`⚠️ Music Video recovery: video history unreadable, keeping partial render output: ${err.message}`);
      return false;
    });
    const partialPath = !finished || finished.has(partial) ? null : safeUnder(PATHS.videos, partial);
    if (partialPath) {
      await unlink(partialPath).catch(() => {});
      await sweepPartialSiblings(partial);
    }
  }
  if (stuck.length > 0) console.log(`🎬 Music Video boot recovery: demoted ${recovered}/${stuck.length} stuck render(s)`);
  const blenderProjectIds = projects.filter((project) => project.composition?.mode === 'blender').map((project) => project.id);
  if (resumes.length || blenderProjectIds.length) scheduleRenderResumes(resumes, blenderProjectIds);
}

// A shot-by-shot final render the user started is started again after a
// restart: every shot it finished is cached, so the rerun only renders the
// shots left and stitches. Bounded, so a render that itself takes the server
// down is not restarted forever.
const MAX_RENDER_RESUMES = 2;
const RENDER_RESUME_DELAY_MS = 15_000;

function scheduleRenderResumes(resumes, projectIds) {
  // After boot settles (maintenance admission, the media lane): the render
  // admits like any other.
  setTimeout(async () => {
    if (projectIds.length) await import('./blender/queue.js').then(({ resumePendingBlenderRenders }) => resumePendingBlenderRenders(projectIds, MAX_RENDER_RESUMES))
      .catch((err) => console.error(`❌ Blender boot recovery could not start: ${err.message}`));
    for (const { projectId, attempt } of resumes) {
      try {
        const { jobId } = await renderMusicVideo(projectId, { resumable: true, resumeAttempt: attempt });
        console.log(`🎬 Music Video boot recovery: resumed the final render of ${projectId.slice(0, 8)} [${jobId.slice(0, 8)}] from its cached shots`);
      } catch (err) {
        // Someone started it again in the meantime: that render resumes from the same cache.
        if (err?.code === 'RENDER_IN_PROGRESS') {
          console.log(`🎬 Music Video boot recovery: the final render of ${projectId.slice(0, 8)} was already started again`);
          continue;
        }
        console.error(`❌ Music Video boot recovery: could not resume the final render of ${projectId.slice(0, 8)}: ${err.message}`);
        await updateProject(projectId, { renderError: `Interrupted by a server restart and could not restart: ${err.message}`.slice(0, 2000) }).catch(() => {});
      }
    }
  }, RENDER_RESUME_DELAY_MS).unref?.();
}
