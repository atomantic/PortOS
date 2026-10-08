/**
 * Lyric word alignment as a job (#10155).
 *
 * `alignProjectLyrics` can take minutes (audio decode, first-use model downloads
 * and a CTC pass over the known lyric text), so the route starts it
 * here and returns a job id; stages stream over SSE with cancel. One job per
 * project at a time — a second request returns the running job, so a double
 * click or a reloaded page never starts a duplicate run.
 *
 * Terminal frames: `{ type: 'complete', project }`, `{ type: 'error', error,
 * code? }` or `{ type: 'canceled' }`. Runs only on an explicit request.
 */

import { randomUUID } from 'crypto';
import { shortId } from '../../lib/fileUtils.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { alignProjectLyrics } from './lyricAlign.js';
import { getProject } from './projects.js';

const reviewableRevision = (project) => project.songRevision?.status === 'selected' && Boolean(project.songRevision.baseline);
const retimeRevisedSongLazy = async (...args) => (await import('./songRevision.js')).retimeRevisedSong(...args);

// jobId -> job; projectId -> running jobId
const alignJobs = new Map();
const activeByProject = new Map();

export const attachLyricAlignSseClient = (jobId, res) => attachSse(alignJobs, jobId, res);

/** The project's running alignment job id, or null. */
export function getActiveLyricAlignJobId(projectId) {
  const jobId = activeByProject.get(projectId);
  const job = jobId ? alignJobs.get(jobId) : null;
  return job && !job.settled ? jobId : null;
}

export function cancelLyricAlign(jobId) {
  const job = alignJobs.get(jobId);
  if (!job || job.settled) return false;
  job.cancelRequested = true;
  return true;
}

/**
 * Start aligning a project's lyrics. Resolves `{ jobId }` (plus `reused: true`
 * when one is already running for the project). A request for a different
 * line while one runs also reuses it: the client reattaches rather than
 * queueing a second whisper run over the same song.
 */
export async function startLyricAlign(projectId, { cueId = null, separateVocals = false, retimeSong = false, align = alignProjectLyrics, retime = null } = {}) {
  const running = getActiveLyricAlignJobId(projectId);
  if (running) return { jobId: running, reused: true };
  // Fail with a real status before a job exists, as the blocking route did.
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const cues = Array.isArray(project.lyricCues) ? project.lyricCues : [];
  // A revised song re-times as a whole: analysis, alignment and the board (songRevision.js).
  if (retimeSong && !reviewableRevision(project)) {
    throw new ServerError('This version has no revised song to re-time.', { status: 409, code: 'SONG_REVISION_CONFLICT' });
  }
  if (cues.length === 0 && !retimeSong) throw new ServerError('Add lyric lines before aligning words.', { status: 400, code: 'NO_LYRICS' });
  if (cueId && !cues.some((cue) => cue.id === cueId)) {
    throw new ServerError('That lyric line is no longer on the project.', { status: 404, code: 'NOT_FOUND' });
  }
  // Another request may have started a job while the project was read.
  const raced = getActiveLyricAlignJobId(projectId);
  if (raced) return { jobId: raced, reused: true };
  const jobId = randomUUID();
  const job = { id: jobId, clients: [], settled: false, cancelRequested: false };
  alignJobs.set(jobId, job);
  activeByProject.set(projectId, jobId);
  console.log(`🎤 Lyric alignment ${shortId(jobId)} started for ${projectId}${cueId ? ` (line ${cueId})` : ''}`);

  (async () => {
    try {
      broadcastSse(job, { type: 'progress', stage: 'preparing' });
      const run = retimeSong
        ? (id, options) => (retime || retimeRevisedSongLazy)(id, { ...options, align })
        : align;
      const project = await run(projectId, {
        cueId,
        separateVocals,
        isCancelled: () => job.cancelRequested,
        onProgress: (frame) => broadcastSse(job, { type: 'progress', ...frame }),
      });
      console.log(`✅ Lyric alignment ${shortId(jobId)} complete`);
      broadcastSse(job, { type: 'complete', project });
    } catch (err) {
      if (err?.canceled || job.cancelRequested) {
        console.log(`🛑 Lyric alignment ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
      } else {
        console.error(`❌ Lyric alignment ${shortId(jobId)} failed: ${err?.message || err}`);
        broadcastSse(job, { type: 'error', error: err?.message || String(err), ...(err?.code ? { code: err.code } : {}) });
      }
    } finally {
      job.settled = true;
      if (activeByProject.get(projectId) === jobId) activeByProject.delete(projectId);
      closeJobAfterDelay(alignJobs, jobId);
    }
  })();

  return { jobId };
}
