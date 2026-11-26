/**
 * Music Video final render job: the one lifecycle every final render pipeline runs in.
 *
 * `runFinalRenderJob` owns everything around a pipeline's encode: the project's
 * render slot, the job and its SSE stream, the `rendering` mark, cancellation,
 * publication (poster, history entry, project row and collection filing under
 * one backup lease), the terminal project write and the order a job ends in.
 * A pipeline (render.js: a seeked composition, the composed shot-by-shot cut,
 * the footage concat) supplies only what it plans and how it encodes.
 *
 * How a job ends, on every path:
 *   1. the project row is settled (`settleMusicVideoRender`, inside the project mutation);
 *   2. the project's render slot is released;
 *   3. the `render` event (and a production run's `document-render`) is emitted;
 *   4. the terminal SSE frame is broadcast;
 *   5. the job is scheduled to close and the maintenance permit finishes.
 * The slot outlives the write so a render started on the same project can never
 * have its `rendering` mark overwritten by this job's settle, and both precede
 * the event and the frame so a listener that refetches or renders again reads
 * the settled row and is not refused with RENDER_IN_PROGRESS.
 */

import { unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { captureMusicVideoEvidence } from '../../lib/musicVideo/musicVideoDependencies.js';
import { audioRevisionOf } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { mutateVideoHistory } from '../videoGen/history.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { musicVideoEvents } from './events.js';
import { getProject, updateProject, mutateProjectRecord } from './projects.js';
import { assertProductionApproval, productionReviewBasis } from './productionReview.js';
import { cancelMusicVideoRenderJob, isMusicVideoRenderCancelPending } from './renderCancellation.js';
import { projectRenders, releaseProjectRender } from './renderActivityState.js';
import { isLocalRenderMark, settleMusicVideoRender } from './renderSettlement.js';

// Render jobs by id. The per-project mutex is projectRenders
// (renderActivityState.js): keyed by projectId so two projects can render in
// parallel; same-project re-entry returns 409 with the live jobId for re-attach.
const jobs = new Map();
// Holds the slot from the instant a render is accepted until its job exists,
// across the pipeline's asynchronous preparation, so a double-click or second
// client cannot pass the 409 check during that window and start a duplicate.
const PENDING = Symbol('mv-render-pending');

// What a success path tells the client when the file was published but the project row was not settled.
const SETTLE_FAILED_MESSAGE = "The video rendered, but saving the project record failed — check Media History and reload the project";

// A finished render waits out a whole backup cut before it publishes, as a finished media job does
// (mediaJobQueue/persistence.js). On the boundary's default two-minute wait a film that took hours
// would fail behind an ordinary backup and, with no history entry naming it yet, lose its file.
const PUBLICATION_ADMISSION_MS = 60 * 60 * 1000;

/** The error an encode rejects with when its render was cancelled. */
export const renderCanceled = () => Object.assign(new Error('Render cancelled'), { code: 'CANCELED' });

// File a finished render into the project's media collection. Lazy: only a
// completed render needs the collection rules, and boot loads this module.
const fileFinalInCollection = async (project, jobId) => {
  const { fileOwnedMediaBestEffort, videoItem } = await import('../mediaCollectionRules.js');
  await fileOwnedMediaBestEffort('musicVideo', project, [videoItem(jobId)]);
};

// Append a finalized render to the shared video-history file. The per-project
// mutex deliberately lets two DIFFERENT projects render (and finalize) in
// parallel, and this renderer bypasses the mediaJobQueue GPU lane that serializes
// the normal video-gen pipeline, so its append MUST share the ONE per-file
// serialization tail (`mutateVideoHistory` in videoGen/history.js) with every
// other writer of data/video-history.json (the video-gen finalizer, full-video
// downloads, stitch/upscale, timeline saves). A private second tail here would
// re-open the race against those other writers and drop an entry, leaving a
// "View rendered music video" deep link pointing at a 404. mutateVideoHistory
// keeps the lane alive if one append throws.
const appendToVideoHistory = (meta) =>
  mutateVideoHistory((history) => { history.unshift(meta); return history; });

// The terminal project write of a final render job, decided on the freshest
// row inside the project mutation (renderSettlement.js). When the song changed
// during the render, the job's status is not applied; a file it already wrote
// stays in the history marked abandoned, since the project never names it, and
// the superseded-finals cleanup that follows keeps the project's finals.
// Resolves to whether the status was applied, so listeners can be told the
// render was abandoned (#15158).
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
    if (isLocalRenderMark(project.renderingOn, instanceId) && cancelRender(jobId) === true) {
      console.log(`🛑 Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)}: the song changed, canceling the render`);
    }
  }).catch((err) => console.error(`❌ Music-video render [${jobId.slice(0, 8)}] cancel after a song change failed: ${err.message}`));
});

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

/**
 * Where a footage render's poster frame sits in the file: the poster the
 * director chose (#8984), else the middle of the loudest analysed section that
 * starts inside the rendered song, else undefined (the thumbnailer's default).
 * `leadSec` is what plays before the song (a cold open), which song time sits after.
 */
export function posterTimeFor(project, { songSec, leadSec = 0 }) {
  const section = (project.audioAnalysis?.sections || [])
    .filter((entry) => Number.isFinite(entry.energy) && entry.startSec >= 0 && entry.endSec > entry.startSec && entry.startSec < songSec)
    .sort((a, b) => b.energy - a.energy || a.startSec - b.startSec)[0];
  const posterSec = project.composition?.posterSec;
  const songAtSec = typeof posterSec === 'number' && posterSec < songSec ? posterSec
    : section ? (section.startSec + Math.min(section.endSec, songSec)) / 2 : undefined;
  return songAtSec != null ? songAtSec + leadSec : undefined;
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

async function retireOldFinals(projectId, replacementId) {
  await import('./renderCleanup.js').then(({ cleanupSupersededFinals }) => cleanupSupersededFinals(projectId, { replacementId }))
    .catch(err => console.warn(`⚠️ Music-video superseded render cleanup failed: ${err.message}`));
}

/**
 * Run one final render of `project` as a job and resolve to `{ jobId }` once the
 * job owns the project's render slot and `permit` (the caller's maintenance
 * permit). A throw before that point (a refused or failed preparation, or a
 * render already in progress) leaves no job and no slot behind; the permit is
 * then still the caller's to finish.
 *
 * The slot is reserved before the first await, so nothing may be awaited
 * between the caller's own admission checks and this call.
 *
 * `prepare({ jobId, outputPath })` plans the pipeline and resolves to:
 * - `label`: names a seeked mode in logs and failure reasons; absent for footage.
 * - `modelId`: the history entry's model (default `music-video`).
 * - `totalDuration`: seconds, for the job record.
 * - `summary`: what the start log line says about the plan.
 * - `mark`: extra fields for the `rendering` mark (a resumable render's `renderResume`).
 * - `stage()`: optional; writes what the encode reads from disk and resolves to what
 *   it staged. Runs after the last approval check, immediately before the job exists;
 *   `encode` receives the result as `staged` and owns its removal.
 * - `encode({ job, signal, onProgress, checkApproval, staged })`: always called, and entered
 *   before this function resolves. Writes the film to `outputPath` and resolves to
 *   `{ width, height, fps, durationSec, leadSec, songSec, posterAtSec, proofSheet? }`.
 *   The lead and song lengths describe the encoded file, excluding any outro.
 *   A cancelled encode rejects with `renderCanceled()`. `onProgress` takes the whole job's
 *   fraction. `proofSheet(path)` writes a contact sheet the complete frame links.
 * - `onPublished({ settled, encoded })`: optional; runs once the render is published,
 *   while the slot is still held. `settled` is false when the song changed under it, so
 *   the project does not name it. May resolve to a note for the success log line. Never
 *   fails the render.
 */
export async function runFinalRenderJob({ projectId, project, options = {}, permit, prepare }) {
  const existing = projectRenders.get(projectId);
  if (existing && (existing === PENDING || jobs.has(existing))) {
    throw new ServerError('Render already in progress for this project', {
      status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId: existing === PENDING ? null : existing },
    });
  }
  projectRenders.set(projectId, PENDING);

  const jobId = randomUUID();
  const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  let pipeline;
  let renderingOn;
  let staged;
  let job;
  try {
    pipeline = await prepare({ jobId, outputPath });
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);
    renderingOn = await ensureInstanceId();
    await assertCurrentRenderApproval(projectId, project, options);
    staged = await pipeline.stage?.();
    job = {
      id: jobId, projectId, status: 'running', clients: [], process: null,
      totalDuration: pipeline.totalDuration, overlayAbort: new AbortController(), audioRevision: audioRevisionOf(project),
    };
    jobs.set(jobId, job);
    projectRenders.set(projectId, jobId);
  } catch (err) {
    // No job took the slot: a stale reservation would 409 every later render.
    releaseProjectRender(projectId);
    throw err;
  }

  const { label, modelId = 'music-video' } = pipeline;
  const named = label ? `${label[0].toUpperCase()}${label.slice(1)}` : '';
  const tag = label ? ` ${label}` : '';
  const short = jobId.slice(0, 8);
  // A project write that failed leaves the row behind the job, so the permit stays for recovery.
  const noteWriteFailure = (status, err) => {
    permit.markUnsettled();
    console.error(`❌ Music-video${tag} render [${short}] project ${projectId.slice(0, 8)} status→${status} write failed: ${err.message}`);
  };
  const writeSettled = (status, extra) => settleRenderProject(projectId, job, status, extra).then((settled) => ({ ok: true, settled }), (err) => {
    noteWriteFailure(status, err);
    return { ok: false };
  });

  // Capture the pre-render status so a cancel restores it rather than blindly
  // downgrading a previously-'complete' project to 'ready'. Fall back to 'ready'
  // if it was somehow already 'rendering'.
  const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
  // Mark the project rendering so the board reflects an in-flight render even
  // on a client that didn't initiate it (federates via emitRecordUpdated).
  // #9010: stamp this instance on the mark so a peer's boot recovery leaves
  // it alone, and record the output file so OUR boot recovery can delete the
  // partial a restart mid-encode leaves behind.
  await updateProject(projectId, {
    status: 'rendering', renderingOn, renderAudioRevision: job.audioRevision, renderPartialFilename: filename, renderError: null, ...pipeline.mark,
  }).catch((err) => noteWriteFailure('rendering', err));
  console.log(`🎬 Rendering${tag} music video [${short}]: project=${projectId.slice(0, 8)} ${pipeline.summary}`);

  // A listener or a dead SSE client that throws must not strand the job's close or the permit.
  const announce = (what, send) => {
    try { send(); } catch (err) { console.error(`❌ Music-video${tag} render [${short}] ${what} failed: ${err.message}`); }
  };
  // Steps 2-5 of the terminal order in this file's header; the caller has already settled the row.
  // `abandoned`: that write found the song changed, so the project does not name this render and
  // listeners must not treat it as delivered (#15158). A write that threw is not an abandoned render.
  const finish = (frame, abandoned = false) => {
    releaseProjectRender(projectId);
    const completed = job.status === 'complete';
    const outcome = { error: job.lastError || null, ...(abandoned ? { abandoned: true } : {}) };
    announce('render event', () => musicVideoEvents.emit('render', {
      projectId, jobId, status: completed ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed', ...outcome,
    }));
    if (options.productionRunId) {
      announce('production event', () => musicVideoEvents.emit('document-render', {
        projectId, runId: options.productionRunId, attemptId: options.productionRenderAttemptId, jobId,
        status: completed ? 'completed' : 'failed', ...outcome,
      }));
    }
    announce('terminal frame', () => broadcastSse(job, frame));
    closeJobAfterDelay(jobs, jobId);
    permit.finish();
  };

  // A cancel is a user action (stdout); a failure is an error (#7945). A cancel
  // restores the pre-render status (so a cancelled re-render of a 'complete'
  // project stays 'complete'); a real failure marks it 'failed'.
  const unpublishedPaths = [outputPath];
  const fail = async ({ canceled, reason, keepOutput = false }) => {
    job.status = canceled ? 'canceled' : 'error';
    job.lastError = reason;
    const log = canceled ? console.log : console.error;
    log(`${canceled ? '🛑' : '❌'} Music-video${tag} render ${canceled ? 'cancelled' : 'failed'} [${short}]: ${reason}`);
    if (!keepOutput) {
      await Promise.all(unpublishedPaths.map((path) => unlink(path).catch((err) => {
        if (err.code !== 'ENOENT') console.error(`❌ Music-video${tag} render [${short}] could not remove an unpublished artifact: ${err.message}`);
      })));
    }
    const { settled } = await writeSettled(canceled ? priorStatus : 'failed', { renderError: canceled ? null : reason.slice(0, 2000) });
    finish({ type: canceled ? 'canceled' : 'error', error: reason }, settled === false);
  };

  // Once the history entry names the file, a later failure must not delete it.
  let historyCommitted = false;
  // The encoder wrote the MP4 in place; the poster, the history entry naming
  // it and the project row naming that entry publish under one lease (#9982).
  const publish = async (encoded) => {
    let proof = null;
    if (encoded.proofSheet) {
      const sheetName = filename.replace(/\.mp4$/, '-proof.png');
      const sheetPath = join(PATHS.videoThumbnails, sheetName);
      unpublishedPaths.push(sheetPath);
      try {
        await encoded.proofSheet(sheetPath);
        proof = sheetName;
      } catch (err) {
        console.warn(`⚠️ Music-video${tag} proof sheet failed [${short}]: ${err.message}`);
      }
    }
    const extra = { renderHistoryId: jobId, renderDependencies: captureMusicVideoEvidence(project, { clipFrames: false }) };
    const { thumbnail, result } = await withBackupAssetPublication(async () => {
      // Register the destination before FFmpeg runs so a partial write is cleaned up too.
      unpublishedPaths.push(join(PATHS.videoThumbnails, `${jobId}.jpg`));
      const thumbnail = await generateThumbnail(outputPath, jobId, { atSec: encoded.posterAtSec });
      await appendToVideoHistory({
        id: jobId,
        prompt: `Music Video: ${project.name}`,
        modelId,
        seed: 0,
        width: encoded.width,
        height: encoded.height,
        numFrames: Math.round(encoded.durationSec * encoded.fps),
        fps: encoded.fps,
        songStartSec: encoded.leadSec,
        songDurationSec: encoded.songSec,
        filename,
        thumbnail,
        createdAt: new Date().toISOString(),
        musicVideoProjectId: projectId,
      });
      historyCommitted = true;
      const result = await writeSettled('complete', extra);
      if (result.ok) await fileFinalInCollection(project, jobId);
      return { thumbnail, result };
    }, {
      timeoutMs: PUBLICATION_ADMISSION_MS,
      onWait: () => console.log(`⏸️ Music-video${tag} render [${short}] is encoded and waiting for the backup to finish before it publishes`),
    });
    return { ...result, thumbnail, proof };
  };

  const run = async () => {
    const { signal } = job.overlayAbort;
    let encoded;
    try {
      encoded = await pipeline.encode({
        job, signal,
        onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: fraction }),
        checkApproval: () => assertCurrentRenderApproval(projectId, project, options),
        staged,
      });
      // A cancel that was accepted while the encode finished still wins: nothing is published after it.
      if (isMusicVideoRenderCancelPending(job)) throw renderCanceled();
    } catch (err) {
      const canceled = isMusicVideoRenderCancelPending(job) || err?.code === 'CANCELED';
      const message = err?.message || String(err);
      await fail({ canceled, reason: canceled ? 'Render cancelled' : named ? `${named} render failed: ${message}` : message });
      return;
    }
    // Set in the same tick as the check above: from here a cancel is refused (renderCancellation.js).
    job.status = 'complete';
    job.overlayAbort = null;

    let published;
    try {
      published = await publish(encoded);
    } catch (err) {
      // The publication boundary keeps its own unsettled row for a lease whose work started and threw;
      // one that never started (a backup cut that outlasted even this wait) leaves no unsettled row.
      await fail({ canceled: false, reason: `Finalize failed: ${err?.message || String(err)}`, keepOutput: historyCommitted });
      return;
    }
    if (!published.ok) {
      // The history entry names the file, so it stays; only the project row is unsettled.
      job.status = 'error';
      job.lastError = SETTLE_FAILED_MESSAGE;
      finish({ type: 'error', error: SETTLE_FAILED_MESSAGE });
      return;
    }
    const { settled, thumbnail, proof } = published;
    await retireOldFinals(projectId, jobId);
    // The video is delivered either way, so a failure here is reported and never fails the render.
    const note = await Promise.resolve().then(() => pipeline.onPublished?.({ settled, encoded }))
      .catch((err) => console.error(`❌ Music-video${tag} render [${short}] post-publish step failed: ${err.message}`));
    finish({ type: 'complete', result: {
      id: jobId, filename, thumbnail, path: `/data/videos/${filename}`,
      ...(encoded.proofSheet ? { proof: proof ? `/data/video-thumbnails/${proof}` : null } : {}),
    } }, !settled);
    console.log(`✅ ${named ? `${named} music` : 'Music'} video rendered [${short}]: ${filename}${note ? ` (${note})` : ''}`);
  };
  // Started synchronously: a pipeline that spawns its encoder does so before this resolves.
  run().catch((err) => {
    // Every expected failure settles above; this is a defect in a step. The row may still
    // read `rendering`, so the permit stays for recovery, but the slot must not 409 every later render.
    console.error(`❌ Music-video${tag} render [${short}] lifecycle failed: ${err.message}`);
    permit.markUnsettled();
    if (projectRenders.get(projectId) === jobId) releaseProjectRender(projectId);
    closeJobAfterDelay(jobs, jobId);
    permit.finish();
  });
  return { jobId };
}
