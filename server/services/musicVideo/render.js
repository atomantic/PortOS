import { maintenance } from '../../lib/maintenanceAdmission.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { assertProductionApproval, nameShots, productionReviewBasis } from './productionReview.js';
/**
 * Music Video — render pipeline (#1760, Phase 2).
 *
 * Assembles a project's per-scene i2v clips (each a `videoHistoryId` entry the
 * scene-video hook filed) into a single MP4 laid under the project's source
 * track as the **master audio bed** — the music video's defining shape: one
 * music track under all clips, the per-clip generated audio dropped. Mirrors
 * videoTimeline's SSE render runner (job map, ffmpeg `-progress` parsing, the
 * shared sseUtils broadcast), but its ffmpeg graph concats video-only and maps
 * one external audio input as the sole output audio, ended on `-shortest` so the
 * render runs only as long as the shorter of (video, track).
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
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { safeUnder, generateThumbnail } from '../../lib/ffmpeg.js';
import { filterGraphViaFile } from '../../lib/ffmpegFilterGraph.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { cancelMusicVideoRenderJob, isMusicVideoRenderCancelPending, isMusicVideoRenderCanceled } from './renderCancellation.js';
import { attachFfmpegRenderGuard } from '../../lib/ffmpegRenderGuard.js';
import { loadHistory, mutateVideoHistory } from '../videoGen/history.js';
import { getProject, listProjects, updateProject, mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { applyProjectPatch } from './projectsLogic.js';
import { isLocalRenderMark, settledRender, settleMusicVideoRender } from './renderSettlement.js';
import { assertSongAudioCurrent, audioRevisionOf } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { writeCodeProofSheet } from './codeRender.js';
import { sweepDocumentScratch } from './documentRender.js';
import { resolveSeekedInputs, seekedRendererFor } from './seekedRenderers.js';
import { sweepCompositionScratch } from './compositionRender.js';
import { applyFilmLookFinish, filmLookFinishNeeded, sweepFilmLookScratch } from './filmLookFinish.js';
import { appendStatsOutro, sweepStatsOutroScratch } from './statsOutro.js';
import { endingSeconds } from '../../lib/musicVideo/musicVideoEnding.js';
import { coldOpenScenes } from '../../lib/musicVideo/musicVideoColdOpen.js';
import { captureMusicVideoEvidence, } from '../../lib/musicVideo/musicVideoDependencies.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { musicVideoEvents } from './events.js';
import { applyFrameHold, projectFrameHold } from './frameHold.js';
import { isProjectRenderActive, projectRenders, releaseProjectRender } from './renderActivityState.js';
import { resolveMasterAudioPath } from './masterAudioPath.js';
import { planMusicVideoRender } from './renderPlan.js';
import { buildMusicVideoFfmpegArgs } from './renderFfmpegArgs.js';
import { normalizeBlenderRecord } from '../../lib/musicVideo/musicVideoBlender.js';

// Render jobs by id. The per-project mutex is projectRenders
// (renderActivityState.js): keyed by projectId so two projects can render in
// parallel; same-project re-entry returns 409 with the live jobId for re-attach.
const jobs = new Map();
// Reserved synchronously the instant a render is accepted, BEFORE the async
// prep (ffmpeg/audio/clip resolution) — so a double-click or second client
// can't pass the 409 check during that await window and spawn a duplicate.
const PENDING = Symbol('mv-render-pending');

// Append a finalized render to the shared video-history file. The per-project
// mutex above deliberately lets two DIFFERENT projects render (and finalize) in
// parallel, and this renderer bypasses the mediaJobQueue GPU lane that serializes
// the normal video-gen pipeline — so its append MUST share the ONE per-file
// serialization tail (`mutateVideoHistory` in videoGen/history.js) with every
// other writer of data/video-history.json (the video-gen finalizer, full-video
// downloads, stitch/upscale, timeline saves). A private second tail here would
// re-open the race against those other writers and drop an entry, leaving a
// "View rendered music video" deep link pointing at a 404. mutateVideoHistory
// keeps the lane alive if one append throws.
// File a finished render into the project's media collection. Lazy: only a
// completed render needs the collection rules, and boot loads this module.
const fileFinalInCollection = async (project, jobId) => {
  const { fileOwnedMediaBestEffort, videoItem } = await import('../mediaCollectionRules.js');
  await fileOwnedMediaBestEffort('musicVideo', project, [videoItem(jobId)]);
};

const appendToVideoHistory = (meta) =>
  mutateVideoHistory((history) => { history.unshift(meta); return history; });

export { buildMusicVideoFfmpegArgs, isLocalRenderMark, isProjectRenderActive, resolveMasterAudioPath };
export { beatSnapClips, excerptBoundaryTimes, planMusicVideoRender, resolveColdOpenClips, resolveSceneClips, resolveSoundBedPath } from './renderPlan.js';

// The terminal project write of a final render job, decided on the freshest
// row inside the project mutation (renderSettlement.js). When the song changed
// during the render, the job's status is not applied; a file it already wrote
// stays in the history marked abandoned, since the project never names it, and
// the superseded-finals cleanup that follows keeps the project's finals.
// Resolves to whether the status was applied, so a success path can tell its
// listeners the render was abandoned (#15158).
async function settleRenderProject(projectId, job, status, extra) {
  const instanceId = await ensureInstanceId();
  const { settled } = await mutateProjectRecord(projectId, (current) => settleMusicVideoRender(current, { jobRevision: job.audioRevision, status, extra, instanceId }));
  if (settled) return true;
  console.log(`⏭️ Music-video render [${job.id.slice(0, 8)}] project ${projectId.slice(0, 8)}: the song changed during the render, status→${status} not applied`);
  if (status === 'complete') {
    await mutateVideoHistory((history) => history.map((entry) => (entry.id === job.id ? { ...entry, abandonedReason: 'audio-changed' } : entry)));
  }
  return false;
}

// A change of the song cancels this instance's render of the old one. A
// render another instance owns is left to that instance (#15154).
musicVideoEvents.on('audio-changed', ({ projectId, project }) => {
  const jobId = getActiveRenderJobId(projectId);
  const job = jobId ? jobs.get(jobId) : null;
  if (!job || job.audioRevision === audioRevisionOf(project)) return;
  ensureInstanceId().then((instanceId) => {
    if (isLocalRenderMark(project.renderingOn, instanceId) && cancelRender(jobId)) {
      console.log(`🛑 Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)}: the song changed, canceling the render`);
    }
  }).catch((err) => console.error(`❌ Music-video render [${jobId.slice(0, 8)}] cancel after a song change failed: ${err.message}`));
});

// Tell listeners (the autonomous run waiting on its final render) that a render
// job reached a terminal state. Emitted after the project record's terminal
// write, with the outcome read off the job the caller already settled. A job
// that finished while the song changed under it stays `completed` (its file
// exists) but carries `abandoned: true`: the project never names that render,
// so a listener must not treat it as delivered (#15158). Only a success path
// passes `settled`; `undefined` (no write, or one that threw) is not abandoned.
const emitRenderSettled = (projectId, job, settled) => musicVideoEvents.emit('render', {
  projectId, jobId: job.id,
  status: job.status === 'complete' ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed',
  error: job.lastError || null,
  ...(settled === false ? { abandoned: true } : {}),
});

// What a success path tells the client when the file was published but the project row was not settled.
const SETTLE_FAILED_MESSAGE = "The video rendered, but saving the project record failed — check Media History and reload the project";

export const attachRenderSseClient = (jobId, res) => attachSse(jobs, jobId, res);


/**
 * The project's live final-render job on THIS instance, or null — a render
 * still preparing (no job id yet) or running on another machine reports null.
 * Read-only: lets a reloaded page re-attach to the render's progress stream
 * without POSTing /render, which would START one when none is live (#9940).
 */
export function getActiveRenderJobId(projectId) {
  const existing = projectRenders.get(projectId);
  return existing && existing !== PENDING && jobs.has(existing) ? existing : null;
}

export function getRenderJobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return { status: job.status, error: job.lastError };
}

export function cancelRender(jobId) {
  return cancelMusicVideoRenderJob(jobs.get(jobId), { label: 'music-video render' });
}


// Code-rendered mode (#9076) and the composition-document mode seek a composition instead of
// concatenating footage; their renderers live in seekedRenderers.js, shared with the draft excerpts.
// They share this module's job map so the existing SSE and cancel routes apply.
export { seekedRendererFor };

async function renderSeekedMode(projectId, project, handOff, renderer, options = {}) {
  // Resolve the master before any rendering mark. A missing track throws here
  // and the caller releases the pending slot without leaving a job running.
  const { audioPath, soundBed } = await resolveSeekedInputs(renderer, project, {
    checkAudio: (path) => assertSongAudioCurrent(project, basename(path)),
  });
  const prepared = await renderer.prepare(project);
  const { plan } = prepared;
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);
  const renderingOn = await ensureInstanceId();
  await assertCurrentRenderApproval(projectId, project, options);
  const jobId = randomUUID();
  const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const sheetName = filename.replace(/\.mp4$/, '-proof.png');
  const job = {
    id: jobId, projectId, status: 'running', clients: [], process: null,
    totalDuration: plan.durationSec, overlayAbort: new AbortController(), audioRevision: audioRevisionOf(project),
  };
  jobs.set(jobId, job);
  projectRenders.set(projectId, jobId);
  handOff();
  const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
  await updateProject(projectId, { status: 'rendering', renderingOn, renderAudioRevision: job.audioRevision, renderPartialFilename: filename, renderError: null }).catch((err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video ${renderer.label} render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→rendering write failed: ${err.message}`);
  });
  console.log(`🎬 Rendering ${renderer.label} music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} frames=${Math.round(plan.durationSec * plan.fps)} footage=off`);
  const { signal } = job.overlayAbort;
  const writeSettled = (patch) => settleRenderProject(projectId, job, patch.status, { renderError: patch.status === 'failed' ? job.lastError?.slice(0, 2000) || 'Render failed' : null, ...patch.extra }).then((settled) => ({ ok: true, settled }), (err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video ${renderer.label} render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${patch.status} write failed: ${err.message}`);
    return { ok: false, error: err };
  });
  // `written`: the success path already committed the row inside its backup lease.
  // `settled`: the success path's own write outcome (see settleRenderProject).
  const finish = async (patch, { written = false, settled, frame } = {}) => {
    releaseProjectRender(projectId);
    if (!written) settled = (await writeSettled(patch)).settled;
    emitRenderSettled(projectId, job, settled);
    // Terminal frame goes out only after the row is persisted and the lock released: a client that
    // refetches on it must not read a stale `rendering` status or hit 409 RENDER_IN_PROGRESS.
    if (frame) broadcastSse(job, frame);
    if (options.productionRunId) musicVideoEvents.emit('document-render', { projectId, runId: options.productionRunId, attemptId: options.productionRenderAttemptId, jobId, status: patch.status === 'complete' ? 'completed' : 'failed', error: job.lastError || null, ...(settled === false ? { abandoned: true } : {}) });
    closeJobAfterDelay(jobs, jobId);
    options.maintenancePermit?.finish();
  };
  // A renderer that cannot draw the film look in its page gets the footage renders' finishing
  // pass (filmLookFinish.js), which takes the second half of the progress bar.
  const finishing = Boolean(renderer.filmLookFinish) && filmLookFinishNeeded(project, { shotLooks: true });
  const encodeTop = finishing ? 0.5 : 1;
  // Once the history entry names the file, a later failure must not delete it.
  let historyCommitted = false;
  Promise.resolve().then(async () => {
    await assertCurrentRenderApproval(projectId, project, options);
    if (signal.aborted) throw Object.assign(new Error('Render cancelled'), { code: 'CANCELED' });
    const encoded = await renderer.encode({
      prepared, project, projectId, jobId, audioPath, soundBed, outputPath, signal, lookPass: finishing,
      onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: encodeTop * fraction }),
    });
    // The ending (cutting room floor, credits; when on) joins after the song.
    const outroSec = await appendStatsOutro({ project, path: outputPath, jobId, signal, withFilmLook: !!renderer.filmLookInPage });
    // After the ending, so the look grades it with the rest of the film. `lookPassInputs` is
    // what the encode left for the pass to draw over the look (a Blender film's steady title card).
    if (finishing) {
      await applyFilmLookFinish({ project, shotLooks: true, path: outputPath, jobId, signal, ...encoded.lookPassInputs,
        onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: encodeTop + (1 - encodeTop) * fraction }) });
    }
    return outroSec > 0 ? { ...encoded, durationSec: encoded.durationSec + outroSec } : encoded;
  }).then(async (encoded) => {
    job.overlayAbort = null;
    job.status = 'complete';
    let proof = null;
    let result;
    try {
      await writeCodeProofSheet(outputPath, join(PATHS.videoThumbnails, sheetName), encoded.boundaryTimes, {
        width: encoded.width, height: encoded.height, fps: encoded.fps,
      });
      proof = sheetName;
    } catch (err) {
      console.warn(`⚠️ Music-video ${renderer.label} proof sheet failed [${jobId.slice(0, 8)}]: ${err.message}`);
    }
    const atSec = typeof project.composition?.posterSec === 'number'
      ? project.composition.posterSec + (encoded.leadSec || 0)
      : (encoded.boundaryTimes[0] || 0);
    const completed = { status: 'complete', extra: { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project, { clipFrames: false }) } };
    // The encoder wrote the MP4 in place; the poster, the history entry naming
    // it and the project row naming that entry publish under one lease (#9982).
    const thumb = await withBackupAssetPublication(async () => {
      const poster = await generateThumbnail(outputPath, jobId, { atSec });
      await appendToVideoHistory({
        id: jobId,
        prompt: `Music Video: ${project.name}`,
        modelId: renderer.modelId,
        seed: 0,
        width: encoded.width,
        height: encoded.height,
        numFrames: Math.round(encoded.durationSec * encoded.fps),
        fps: encoded.fps,
        filename,
        thumbnail: poster,
        createdAt: new Date().toISOString(),
        musicVideoProjectId: projectId,
      });
      historyCommitted = true;
      result = await writeSettled(completed);
      if (result.ok) await fileFinalInCollection(project, jobId);
      return poster;
    });
    if (!result.ok) {
      job.status = 'error';
      job.lastError = SETTLE_FAILED_MESSAGE;
      await finish({ status: 'failed' }, { written: true, frame: { type: 'error', error: SETTLE_FAILED_MESSAGE } });
      return;
    }
    const { settled } = result;
    await retireOldFinals(projectId, jobId);
    // What a renderer keeps about the final it made, once it is the project's final. The video
    // is delivered either way, so a failure here is reported and never fails the render.
    if (settled) {
      await Promise.resolve().then(() => renderer.recordFinal?.({ projectId, jobId, encoded }))
        .catch((err) => console.error(`❌ Music-video ${renderer.label} final record failed [${jobId.slice(0, 8)}]: ${err.message}`));
    }
    await finish(completed, { written: true, settled });
    console.log(`✅ ${renderer.label[0].toUpperCase()}${renderer.label.slice(1)} music video rendered [${jobId.slice(0, 8)}]: ${filename}`);
    broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}`, proof: proof ? `/data/video-thumbnails/${proof}` : null } });
  }).catch(async (err) => {
    const canceled = signal.aborted || err?.code === 'CANCELED';
    job.status = canceled ? 'canceled' : 'error';
    const reason = canceled ? 'Render cancelled' : `${renderer.label[0].toUpperCase()}${renderer.label.slice(1)} render failed: ${err.message}`;
    job.lastError = reason;
    const log = canceled ? console.log : console.error;
    log(`${canceled ? '🛑' : '❌'} Music-video ${renderer.label} render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
    if (!historyCommitted) await unlink(outputPath).catch(() => {});
    await finish({ status: canceled ? priorStatus : 'failed' }, { frame: { type: canceled ? 'canceled' : 'error', error: reason } });
  });
  return { jobId };
}

// A composed footage render (shotSegments.js): each shot section, its film
// look and the outro come from the segment cache, rendering only what is
// missing, then join by stream copy with the song laid under them once.
async function renderFromShotSegments(projectId, project, handOff, options) {
  const { planShotSegments, renderMissingSegments, stitchSegments, pruneSegments } = await import('./shotSegments.js');
  const startedAtMs = Date.now();
  const plan = await planShotSegments(project);
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);
  const renderingOn = await ensureInstanceId();
  await assertCurrentRenderApproval(projectId, project, options);
  const jobId = randomUUID();
  const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const job = { id: jobId, projectId, status: 'running', clients: [], process: null, totalDuration: plan.songSec, overlayAbort: new AbortController(), audioRevision: audioRevisionOf(project) };
  jobs.set(jobId, job);
  projectRenders.set(projectId, jobId);
  handOff();
  const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
  const logWriteFailure = (status) => (err) => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${status} write failed: ${err.message}`);
  };
  const writeSettled = (status, extra) => settleRenderProject(projectId, job, status, extra).then((settled) => ({ ok: true, settled }), (err) => {
    logWriteFailure(status)(err);
    return { ok: false, error: err };
  });
  // The mark boot recovery reads to start this render again after a restart:
  // the shots it finished are cached, so the rerun picks up where it stopped.
  const renderResume = options.resumable ? { attempt: options.resumeAttempt || 0 } : null;
  await updateProject(projectId, { status: 'rendering', renderingOn, renderAudioRevision: job.audioRevision, renderPartialFilename: filename, renderError: null, renderResume }).catch(logWriteFailure('rendering'));
  const all = [...plan.segments, ...(plan.outro ? [plan.outro] : [])];
  const cached = all.filter((segment) => existsSync(segment.path)).length;
  console.log(`🎬 Rendering music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} segments=${all.length} cached=${cached} duration=${plan.songSec.toFixed(2)}s`);
  const { signal } = job.overlayAbort;
  const finish = (status, settled, frame) => {
    releaseProjectRender(projectId);
    emitRenderSettled(projectId, job, settled);
    if (frame) broadcastSse(job, frame);
    closeJobAfterDelay(jobs, jobId);
    options.maintenancePermit?.finish();
    return status;
  };
  let historyCommitted = false;
  Promise.resolve().then(async () => {
    // Shots take 95% of the bar; joining and laying the song under them the rest.
    await renderMissingSegments(plan, { signal, onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: 0.95 * fraction }) });
    await assertCurrentRenderApproval(projectId, project, options);
    const { durationSec, leadSec } = await stitchSegments(plan, outputPath, { signal });
    // The stepped medium (#14244) holds the stitched cut; shot looks are already in it.
    const hold = projectFrameHold(project);
    if (hold) await applyFrameHold({ path: outputPath, sections: plan.sections, leadSec, signal, ffmpeg: plan.ffmpeg, ...hold });
    if (plan.deferredTitleCard) await (await import('./titleCardFinish.js')).applyTitleCardFinish({ project, path: outputPath, jobId, leadSec, songSec: plan.songSec,
      width: plan.width, height: plan.height, fps: plan.fps, signal, ffmpeg: plan.ffmpeg });
    broadcastSse(job, { type: 'progress', progress: 1 });
    return durationSec;
  }).then(async (durationSec) => {
    job.overlayAbort = null;
    job.status = 'complete';
    const section = (project.audioAnalysis?.sections || [])
      .filter((entry) => Number.isFinite(entry.energy) && entry.startSec >= 0 && entry.endSec > entry.startSec && entry.startSec < plan.songSec)
      .sort((a, b) => b.energy - a.energy || a.startSec - b.startSec)[0];
    const posterSec = project.composition?.posterSec;
    const songAtSec = typeof posterSec === 'number' && posterSec < plan.songSec ? posterSec
      : section ? (section.startSec + Math.min(section.endSec, plan.songSec)) / 2 : undefined;
    // Song time sits after the cold open in the file.
    const atSec = songAtSec != null ? songAtSec + (plan.coldOpen?.durationSec || 0) : undefined;
    let result;
    const thumb = await withBackupAssetPublication(async () => {
      const poster = await generateThumbnail(outputPath, jobId, { atSec });
      await appendToVideoHistory({
        id: jobId, prompt: `Music Video: ${project.name}`, modelId: 'music-video', seed: 0,
        width: plan.width, height: plan.height, numFrames: Math.round(durationSec * plan.fps), fps: plan.fps,
        filename, thumbnail: poster, createdAt: new Date().toISOString(), musicVideoProjectId: projectId,
      });
      historyCommitted = true;
      result = await writeSettled('complete', { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project, { clipFrames: false }) });
      if (result.ok) await fileFinalInCollection(project, jobId);
      return poster;
    });
    if (!result.ok) {
      job.status = 'error';
      job.lastError = SETTLE_FAILED_MESSAGE;
      finish('failed', undefined, { type: 'error', error: SETTLE_FAILED_MESSAGE });
      return;
    }
    const { settled } = result;
    await retireOldFinals(projectId, jobId);
    // Older takes of each shot are dropped once the new cut is published.
    const pruned = await pruneSegments(plan, { startedAtMs, current: true }).catch(err => { console.warn(`⚠️ Music-video segment cleanup failed: ${err.message}`); return 0; });
    finish('complete', settled);
    console.log(`✅ Music video rendered [${jobId.slice(0, 8)}]: ${filename} (${all.length - cached} of ${all.length} segments rendered${pruned ? `, ${pruned} old dropped` : ''})`);
    broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
  }).catch(async (err) => {
    const canceled = signal.aborted || err?.code === 'CANCELED';
    job.status = canceled ? 'canceled' : 'error';
    const reason = canceled ? 'Render cancelled' : err.message;
    job.lastError = reason;
    const log = canceled ? console.log : console.error;
    log(`${canceled ? '🛑' : '❌'} Music-video render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
    if (!historyCommitted) await unlink(outputPath).catch(() => {});
    const status = canceled ? priorStatus : 'failed';
    await writeSettled(status, { renderError: canceled ? null : reason.slice(0, 2000) });
    finish(status, undefined, { type: canceled ? 'canceled' : 'error', error: reason });
  });
  return { jobId };
}

async function assertCurrentRenderApproval(projectId, preparedProject, options) {
  const current = await getProject(projectId);
  // The final render needs the approved storyboard; the animated proof is optional.
  assertProductionApproval(current, 'storyboard', { startedBy: options.startedBy });
  if (productionReviewBasis(current).proof !== productionReviewBasis(preparedProject).proof) {
    throw new ServerError('The reviewed film changed during render preparation.', { status: 409, code: 'MUSIC_VIDEO_REVIEW_STALE' });
  }
  await options.verifyCurrent?.(current);
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
  const existingJob = projectRenders.get(projectId);
  if (existingJob && (existingJob === PENDING || jobs.has(existingJob))) {
    throw new ServerError('Render already in progress for this project', {
      status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId: existingJob === PENDING ? null : existingJob },
    });
  }
  // Reserve the slot SYNCHRONOUSLY (no await between the check above and here)
  // so a concurrent same-project start can't slip through during prep. Released
  // in the `finally` below if prep throws or we never reach the spawn handoff.
  projectRenders.set(projectId, PENDING);

  let handedOff = false;
  try {
    const seeked = seekedRendererFor(project);
    const cold = coldOpenScenes(project);
    if (seeked && cold.length) {
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
    if (seeked) {
      return await renderSeekedMode(projectId, project, () => { handedOff = true; }, seeked, { ...options, maintenancePermit: permit });
    }
    // A composed cut renders shot by shot into the segment cache and stitches.
    if (project.composition?.mode === 'composed') {
      return await renderFromShotSegments(projectId, project, () => { handedOff = true; }, { ...options, maintenancePermit: permit });
    }
    const { ffmpeg, audioPath, composed, clips, coldOpen, audioDurationSec, soundBed, aspect } = await planMusicVideoRender(project);
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);

    // Resolved before the job hand-off so a failure here releases the slot.
    const renderingOn = await ensureInstanceId();
    const jobId = randomUUID();
    const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
    const outputPath = join(PATHS.videos, filename);
    const { args, totalDuration, canonW, canonH, fps, sections } = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, frameGrid: composed, soundBed, grade: composed ? project.composition?.grade : null, beats: project.audioAnalysis?.beats, aspect });

    await assertCurrentRenderApproval(projectId, project, options);
    // A long filter graph goes to ffmpeg in this file, removed once ffmpeg exits.
    const graphPath = join(tmpdir(), `portos-music-video-${jobId}.filtergraph`);
    const plainEncode = await filterGraphViaFile(ffmpeg, args, graphPath);
    const job = { id: jobId, projectId, status: 'running', clients: [], process: null, totalDuration, overlayAbort: new AbortController(), audioRevision: audioRevisionOf(project) };
    jobs.set(jobId, job);
    projectRenders.set(projectId, jobId);
    handedOff = true; // the job lifecycle now owns the projectRenders entry

    // Capture the pre-render status so a cancel restores it rather than blindly
    // downgrading a previously-'complete' project to 'ready'. Fall back to 'ready'
    // if it was somehow already 'rendering'.
    const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
    // Mark the project rendering so the board reflects an in-flight render even
    // on a client that didn't initiate it (federates via emitRecordUpdated).
    // #9010: stamp this instance on the mark so a peer's boot recovery leaves
    // it alone, and record the output file so OUR boot recovery can delete the
    // partial a restart mid-encode leaves behind.
    await updateProject(projectId, { status: 'rendering', renderingOn, renderAudioRevision: job.audioRevision, renderPartialFilename: filename, renderError: null }).catch((err) => {
      maintenance.markCurrentUnsettled();
      console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→rendering write failed: ${err.message}`);
    });
    const writeSettled = (status, extra) => settleRenderProject(projectId, job, status, extra).then((settled) => ({ ok: true, settled }), (updateErr) => {
      maintenance.markCurrentUnsettled();
      console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${status} write failed: ${updateErr.message}`);
      return { ok: false, error: updateErr };
    });

    console.log(`🎬 Rendering music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} clips=${clips.length} duration=${totalDuration.toFixed(2)}s`);

    // Terminal failure or cancel across the encode and post-encode passes. A
    // cancel is a user action (stdout); a failure is an error (#7945).
    const settleFailure = async (canceled, reason, { unlinkOutput = true } = {}) => {
      job.status = canceled ? 'canceled' : 'error';
      job.lastError = reason;
      const log = canceled ? console.log : console.error;
      log(`${canceled ? '🛑' : '❌'} Music-video render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
      if (unlinkOutput) await unlink(outputPath).catch(() => {});
      // A cancel restores the pre-render status (so a cancelled re-render of a
      // 'complete' project stays 'complete'); a real failure marks it 'failed'.
      const targetStatus = canceled ? priorStatus : 'failed';
      await writeSettled(targetStatus, { renderError: canceled ? null : reason.slice(0, 2000) });
      releaseProjectRender(projectId);
      emitRenderSettled(projectId, job);
      broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
      closeJobAfterDelay(jobs, jobId);
      permit.finish();
    };

    // The job-lifetime abort signal covers every post-encode pass; a cancel that
    // lands between passes is caught here before the next one starts.
    const runPostEncodePass = async (label, run) => {
      const { signal } = job.overlayAbort;
      if (isMusicVideoRenderCancelPending(job)) {
        await settleFailure(true, 'Render cancelled');
        return false;
      }
      try {
        await run(signal);
        return true;
      } catch (err) {
        await settleFailure(signal.aborted, signal.aborted ? 'Render cancelled' : `${label} failed: ${err.message}`);
        return false;
      }
    };

    // A footage render with a film look re-encodes its finished cut through the
    // look after ffmpeg (filmLookFinish.js); the pass takes the second half of
    // whatever the encode's share of the bar is.
    const finishing = filmLookFinishNeeded(project);
    // Seconds the ending (cutting room floor, credits) adds after the song (0 when both are off).
    const outroSec = endingSeconds(project);
    // Seconds the cold open adds before the song, once it is cut in front.
    let leadSec = 0;
    const startEncode = (encode) => {
      // A cancel can land in the window between job creation and the spawn.
      if (isMusicVideoRenderCancelPending(job)) {
        if (encode.file) unlink(encode.file).catch(() => {});
        settleFailure(true, 'Render cancelled').catch((err) => console.error(`❌ Music-video render [${jobId.slice(0, 8)}] cancel settle failed: ${err.message}`));
        return;
      }
      const encodeTop = finishing ? 0.5 : 1;
      const encodeProgress = (fraction) => encodeTop * fraction;
      const dropGraphFile = () => (encode.file ? unlink(encode.file).catch(() => {}) : null);
      const proc = spawn(ffmpeg, encode.args, safeChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
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
            if (Number.isFinite(us) && totalDuration > 0) {
              broadcastSse(job, { type: 'progress', progress: encodeProgress(Math.min(1, (us / 1_000_000) / totalDuration)) });
            }
          } else if (key === 'progress' && val === 'end') {
            broadcastSse(job, { type: 'progress', progress: encodeTop });
          }
        }
      });

      // Spawn-state tracking + exactly-once terminal guard + pre-vs-post-spawn
      // dispatch live in the shared helper; only the finalize bodies below are
      // service-specific (music-video mutates the project's render status).
      attachFfmpegRenderGuard(proc, {
        label: `Music-video render [${jobId.slice(0, 8)}]`,
        onProcessError: (err) => {
          // Post-spawn error (e.g. a failed kill during cancel). The ffmpeg is
          // still live — do NOT release the project mutex or null job.process
          // here, or a replacement render could spawn and overlap it. Record
          // the reason; the pending 'close' runs the sole terminal finalization.
          job.lastError = `ffmpeg process error: ${err.message}`;
          console.log(`⚠️ Music-video render post-spawn error [${jobId.slice(0, 8)}]: ${err.message}`);
        },
        onSpawnError: async (err) => {
          // Pre-spawn failure: the child never started, so 'close' won't follow.
          await dropGraphFile();
          job.process = null;
          await settleFailure(false, `Failed to spawn ffmpeg: ${err.message}`, { unlinkOutput: false });
        },
        onClose: async (code, signal) => {
          job.process = null;
          await dropGraphFile();
          if (code !== 0) {
            const canceled = isMusicVideoRenderCanceled(job, signal);
            await settleFailure(canceled, canceled ? 'Render cancelled' : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`);
            return;
          }
          // A cancel that raced a clean exit still wins over the post-encode passes.
          if (isMusicVideoRenderCancelPending(job)) {
            await settleFailure(true, 'Render cancelled');
            return;
          }
          // Grade the cold open and outro with the rest of the film.
          if (coldOpen && !await runPostEncodePass('Cold open', async (signal) => {
            const { prependColdOpen } = await import('./coldOpen.js');
            leadSec = await prependColdOpen({ project, coldOpen, path: outputPath, ffmpeg, jobId, signal });
          })) return;
          if (outroSec > 0 && !await runPostEncodePass('Outro scene', (signal) =>
            appendStatsOutro({ project, path: outputPath, jobId, signal }))) return;

          // Step the cut before adding grain and weave, which move every frame.
          const hold = projectFrameHold(project);
          if (hold && !await runPostEncodePass('Frame hold', (signal) =>
            applyFrameHold({ path: outputPath, sections, leadSec, signal, ffmpeg, ...hold }))) return;

          if (finishing && !await runPostEncodePass('Film look pass', (signal) =>
            applyFilmLookFinish({ project, path: outputPath, jobId, signal,
              onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: encodeTop + (1 - encodeTop) * fraction }) }))) return;

          // Success finalization runs in an event callback (no request to bubble
          // to) — a throw in thumbnailing/history I/O would otherwise leave the
          // project stuck 'rendering' and projectRenders un-cleared (every later
          // render 409s). Wrap it so any failure still emits a terminal frame and
          // releases the slot.
          if (isMusicVideoRenderCancelPending(job)) {
            await settleFailure(true, 'Render cancelled');
            return;
          }
          let result;
          try {
            // Checked and set synchronously: past here a cancel is refused.
            job.committing = true;
            job.status = 'complete';
            const section = (project.audioAnalysis?.sections || [])
              .filter(section => Number.isFinite(section.energy) && section.startSec >= 0 && section.endSec > section.startSec && section.startSec < totalDuration)
              .sort((a, b) => b.energy - a.energy || a.startSec - b.startSec)[0];
            // An explicitly chosen poster frame (#8984) wins over the loudest-section guess.
            const posterSec = project.composition?.posterSec;
            const songAtSec = typeof posterSec === 'number' && posterSec < totalDuration ? posterSec
              : section ? (section.startSec + Math.min(section.endSec, totalDuration)) / 2 : undefined;
            // Song time sits after the cold open in the file.
            const atSec = songAtSec != null ? songAtSec + leadSec : undefined;
            // ffmpeg wrote the MP4 in place; the poster, the history entry naming
            // it and the project row naming that entry publish under one lease (#9982).
            const thumb = await withBackupAssetPublication(async () => {
              const poster = await generateThumbnail(outputPath, jobId, { atSec });
              await appendToVideoHistory({
                id: jobId,
                prompt: `Music Video: ${project.name}`,
                modelId: 'music-video',
                seed: 0,
                width: canonW,
                height: canonH,
                numFrames: Math.round((leadSec + totalDuration + outroSec) * (fps || 24)),
                fps: fps || 24,
                filename,
                thumbnail: poster,
                createdAt: new Date().toISOString(),
                musicVideoProjectId: projectId,
              });
              result = await writeSettled('complete', { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project, { clipFrames: false }) });
              if (result.ok) await fileFinalInCollection(project, jobId);
              return poster;
            });
            if (!result.ok) {
              // The history entry names the file, so it stays; only the project row is unsettled.
              permit.markUnsettled();
              job.status = 'error';
              job.lastError = SETTLE_FAILED_MESSAGE;
              releaseProjectRender(projectId);
              emitRenderSettled(projectId, job);
              broadcastSse(job, { type: 'error', error: SETTLE_FAILED_MESSAGE });
              return;
            }
            const { settled } = result;
            await retireOldFinals(projectId, jobId);
            emitRenderSettled(projectId, job, settled);
            console.log(`✅ Music video rendered [${jobId.slice(0, 8)}]: ${filename}`);
            broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
          } catch (err) {
            permit.markUnsettled();
            job.status = 'error';
            job.lastError = `Finalize failed: ${err.message}`;
            console.error(`❌ Music-video render finalize failed [${jobId.slice(0, 8)}]: ${err.message}`);
            await writeSettled('failed', { renderError: job.lastError.slice(0, 2000) });
            releaseProjectRender(projectId);
            emitRenderSettled(projectId, job);
            broadcastSse(job, { type: 'error', error: 'Render finalize failed' });
          } finally {
            releaseProjectRender(projectId);
            closeJobAfterDelay(jobs, jobId);
            permit.finish();
          }
        },
      });
    };

    startEncode(plainEncode);
    return { jobId };
  } finally {
    // Prep threw (or we never handed off to the job lifecycle) — release the
    // reserved slot so a stale PENDING can't 409 every future render.
    if (!handedOff) { releaseProjectRender(projectId); permit.finish(); }
  }
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

async function retireOldFinals(projectId, replacementId) {
  await import('./renderCleanup.js').then(({ cleanupSupersededFinals }) => cleanupSupersededFinals(projectId, { replacementId }))
    .catch(err => console.warn(`⚠️ Music-video superseded render cleanup failed: ${err.message}`));
}
