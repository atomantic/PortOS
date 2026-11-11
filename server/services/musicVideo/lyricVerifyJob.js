import { randomUUID } from 'crypto';
import { broadcastSse, attachSseClient, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { requireProject } from './requireProject.js';
import { activeLyricVerify as active, getActiveLyricVerifyJobId, getReservedLyricAlignJobId } from './lyricJobRegistry.js';
import { verifyLyricSheet, verifyPrerequisites } from './lyricVerify.js';

const fingerprint = project => JSON.stringify([project.trackId, project.uploadedAudioFilename, project.vocalStemFilename, project.vocalStemMasterFilename, project.lyricCues]);
const jobs = new Map();
export const attachLyricVerifySseClient = (jobId, res) => attachSseClient(jobs, jobId, res);
export function cancelLyricVerify(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.settled) return false;
  job.controller.abort();
  return true;
}
export async function startLyricVerify(projectId) {
  const running = getActiveLyricVerifyJobId(projectId);
  if (running) return { jobId: running, reused: true };
  if (getReservedLyricAlignJobId(projectId)) throw new ServerError('Lyric alignment is running.', { status: 409, code: 'LYRIC_ALIGN_BUSY' });
  const project = await requireProject(projectId);
  const stem = await verifyPrerequisites(project);
  const raced = getActiveLyricVerifyJobId(projectId);
  if (raced) return { jobId: raced, reused: true };
  if (getReservedLyricAlignJobId(projectId)) throw new ServerError('Lyric alignment is running.', { status: 409, code: 'LYRIC_ALIGN_BUSY' });
  const jobId = randomUUID();
  const job = { id: jobId, clients: [], settled: false, controller: new AbortController() };
  jobs.set(jobId, job);
  active.set(projectId, jobId);
  (async () => {
    try {
      broadcastSse(job, { type: 'progress', stage: 'preparing' });
      const result = await verifyLyricSheet(project, stem, { signal: job.controller.signal, isCancelled: () => job.controller.signal.aborted, onProgress: frame => broadcastSse(job, { type: 'progress', ...frame }) });
      if (job.controller.signal.aborted) broadcastSse(job, { type: 'canceled' });
      else {
        const fresh = await requireProject(projectId);
        if (fingerprint(fresh) !== fingerprint(project) || await verifyPrerequisites(fresh) !== stem) {
          throw new ServerError('The song or lyrics changed during the check. Run it again.', { status: 409, code: 'LYRIC_VERIFY_CHANGED' });
        }
        if (job.controller.signal.aborted) broadcastSse(job, { type: 'canceled' });
        else broadcastSse(job, { type: 'complete', result });
      }
    } catch (err) {
      if (job.controller.signal.aborted || err?.canceled) broadcastSse(job, { type: 'canceled' });
      else broadcastSse(job, { type: 'error', error: err?.message || String(err), ...(err?.code ? { code: err.code } : {}) });
    } finally {
      job.settled = true;
      if (active.get(projectId) === jobId) active.delete(projectId);
      closeJobAfterDelay(jobs, jobId);
    }
  })();
  return { jobId };
}
