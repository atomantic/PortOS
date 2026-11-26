/**
 * Job lifecycle shared by the hosted video adapters (fal.ai, Runway, Higgsfield, Google).
 *
 * Adds the video half of the contract to `lib/hostedJobRunner.js`: job start,
 * and per run the staged-input cleanup, failure and publication paths.
 * Adapters keep request building, polling and result mapping (#16098).
 */

import { unlink, writeFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { probeVideoGeometry } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createHostedJobRunner } from '../../lib/hostedJobRunner.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { closeJobAfterDelay } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { CLOUD_RENDER_PHASE, discardUnpublishedVideo, emitCloudRenderStatus, finalizeGeneratedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';

// Only the queue's own staged copies are removed; a gallery pick is never touched.
const isStagedUpload = (path) => {
  const rel = relative(PATHS.uploads, resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

const markUnsettled = (jobId) => {
  maintenance.markCurrentUnsettled();
  maintenance.markResourceUnsettled('media', jobId);
};

/**
 * `provider` names the backend in user-facing text ("Submitting to fal.ai…"),
 * `logName` in logs. `cancelRemote(entry)` stops a billed remote request on
 * cancel; `abandonRemote(entry)` (default: the same) runs on an unanticipated
 * failure — Google cannot cancel a Veo operation, so it only marks the spend unsettled.
 */
export function createHostedVideoJobRunner({ mode, provider, logName = provider, cancelRemote = null, abandonRemote = cancelRemote }) {
  const runner = createHostedJobRunner({ name: `videoGen/${mode}`, label: `${logName} video generation`, events: videoGenEvents, cancelRemote });
  const { jobs, activeJobs, activeRequests, finalizeJobFailure, finalizeCanceled } = runner;

  /** Register the job and launch the paid `run(job)` out-of-band; returns the descriptor clients attach SSE to. */
  const start = ({ meta, renderStartedAtMs, logDetail, run }) => {
    const { id: jobId, filename } = meta;
    const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
    jobs.set(jobId, job);
    console.log(`🎬 Generating video [${jobId.slice(0, 8)}] ${logName} (${logDetail})`);
    videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
    activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, `Submitting to ${provider}…`);
    run(job).catch((err) => console.error(`❌ ${logName} video run failed [${jobId.slice(0, 8)}]: ${err?.message}`));
    return { jobId, filename, path: `/data/videos/${filename}`, generationId: jobId, mode, status: 'running' };
  };

  /**
   * Install the render handle (synchronously, at the submit handoff) and return
   * the run's terminal paths. `inputs` are the queue-owned staged files the job
   * removes on every terminal path.
   */
  const begin = (job, entry, { inputs = [] } = {}) => {
    const jobId = job.id;
    const outputPath = join(PATHS.videos, job.filename);
    runner.track(jobId, entry);
    const publication = {};
    // One cleanup attempt for every terminal path: a publication error can
    // reach the catch after the success path already settled the inputs.
    let inputCleanup;
    const settleInputs = () => (inputCleanup ??= (async () => {
      for (const path of new Set(inputs)) {
        if (!path || !isStagedUpload(path)) continue;
        await unlink(path).catch((error) => {
          if (error.code === 'ENOENT') return;
          markUnsettled(jobId);
          console.error(`❌ ${logName} staged-input cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
        });
      }
    })());

    const finishFailure = async (reason, code) => {
      await settleInputs();
      if (entry.aborted) return finalizeCanceled(job, jobId);
      return finalizeJobFailure(job, jobId, null, reason, { force: true, code });
    };

    /**
     * Write the delivered MP4, record its measured geometry (the Music Video
     * renderer trims every clip by its measured length) and publish it. A cancel
     * at any await keeps the take out of history. Resolves `true` once published.
     */
    const publish = async ({ buffer, meta, actualSeed = null, onMeasured }) => {
      const discardIfCanceled = async () => {
        if (!entry.aborted) return false;
        await unlink(outputPath);
        await finishFailure('Canceled');
        return true;
      };
      await writeFile(outputPath, buffer);
      if (await discardIfCanceled()) return false;
      const measured = (await probeVideoGeometry(outputPath)) || {};
      onMeasured?.(measured);
      await settleInputs();
      if (await discardIfCanceled()) return false;
      activeRequests.delete(jobId);
      activeJobs.delete(jobId);
      await finalizeGeneratedVideo({ job, jobId, outputPath, filename: meta.filename, meta: { ...meta, ...measured }, actualSeed, mutateHistory: mutateVideoHistory, publication });
      closeJobAfterDelay(jobs, jobId);
      return true;
    };

    /**
     * The run's catch tail. A failure after the durable commit never removes the
     * committed bytes; before it, only this fresh output is cleaned. The remote
     * request may still be queued or running, so it is canceled (the transports
     * no-op once it is terminal or before a submit, #8340).
     */
    const fail = async (err) => {
      if (!publication.committed) {
        await discardUnpublishedVideo({ jobId, outputPath }).catch((error) => {
          markUnsettled(jobId);
          console.error(`❌ ${logName} video publication cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
        });
      }
      if (abandonRemote) await abandonRemote(entry);
      return finishFailure(`${provider} video generation failed: ${err?.message || err}`, err instanceof ServerError ? err.code : undefined);
    };

    return { entry, finishFailure, publish, fail };
  };

  return { ...runner, start, begin };
}
