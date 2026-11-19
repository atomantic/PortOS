/**
 * Job lifecycle shared by the hosted image adapters (fal.ai, Runway, Higgsfield, Google).
 *
 * Adds the image half of the contract to `lib/hostedJobRunner.js`: the gallery
 * record, job start, publication and the run's failure tail. Adapters keep
 * request building, polling and result mapping (#16098).
 */

import { basename, join } from 'path';
import sharp from 'sharp';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { atomicWrite, PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { createHostedJobRunner } from '../../lib/hostedJobRunner.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import { broadcastSse, closeJobAfterDelay, dispatchTerminalEvent } from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { rejectDegenerateFrame } from './frameGuard.js';

/**
 * `provider` names the backend in user-facing text ("fal.ai returned…"),
 * `logName` in logs. `cancelRemote(entry)` stops a billed remote request on
 * cancel and on an unanticipated failure.
 */
export function createHostedImageJobRunner({ mode, provider, logName = provider, cancelRemote = null }) {
  const runner = createHostedJobRunner({
    name: `imageGen/${mode}`,
    label: `${logName} image generation`,
    events: imageGenEvents,
    cancelRemote,
    failedPayload: (jobId, reason) => ({ mode, generationId: jobId, error: reason }),
  });
  const { jobs, activeJobs, activeRequests, finalizeJobFailure, finalizeCanceled } = runner;

  /** The gallery record every hosted render writes; `modelFields` (model, ratio, …) follow `mode`. */
  const jobMeta = ({ jobId, prompt, negativePrompt, width, height, inputImages, visualConditioning, sentRecord, modelFields }) => ({
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename: `${jobId}.png`, mode,
    ...modelFields,
    inputProvenance: 'provider-inputs',
    initImageFilename: inputImages.initPath ? basename(inputImages.initPath) : null,
    referenceImageFilenames: inputImages.referencePaths.map(path => basename(path)),
    ...(inputImages.paths.length ? { inputImageCount: inputImages.paths.length } : {}),
    ...(visualConditioning ? { visualConditioning } : {}),
    ...sentRecord,
    createdAt: new Date().toISOString(),
  });

  /** Register the job and launch the paid `run(job)` out-of-band; returns the descriptor clients attach SSE to. */
  const start = ({ meta, renderStartedAtMs, model, status, run }) => {
    const { id: jobId, filename } = meta;
    const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
    jobs.set(jobId, job);
    console.log(`🎨 Generating image [${jobId.slice(0, 8)}] ${logName} (${model})`);
    imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
    activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
    broadcastSse(job, { type: 'status', message: status });
    run(job).catch((err) => console.error(`❌ ${logName} image run failed [${jobId.slice(0, 8)}]: ${err?.message}`));
    return { jobId, filename, path: `/data/images/${filename}`, generationId: jobId, mode, status: 'running' };
  };

  /**
   * Land a finished render in the gallery. Signature-sniffs first (an error page
   * is never an image), transcodes to PNG (the gallery serves by extension),
   * rejects a blank/moderated frame (#4173), cleans before `completed` so
   * subscribers see the cleaned bytes, and honors a cancel at every await. A
   * throw removes whatever this call wrote.
   */
  const publish = ({ job, entry, meta, bytes, sidecarFields, cleanC2PA = false, denoise = false, doneNote }) => withBackupAssetPublication(async () => {
    const { id: jobId, filename } = meta;
    if (entry.aborted) return finalizeCanceled(job, jobId);
    const outputPath = join(PATHS.images, filename);
    const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
    let wroteOutput = false;
    try {
      const format = detectImageFormat(bytes)?.format;
      if (!format) return finalizeJobFailure(job, jobId, null, `${provider} returned a file that is not an image`);
      await atomicWrite(outputPath, format === 'png' ? bytes : await sharp(bytes).png().toBuffer());
      wroteOutput = true;
      if (entry.aborted) {
        await unlinkGuarded(outputPath).catch(() => {});
        return finalizeCanceled(job, jobId);
      }
      const emptyFrame = await rejectDegenerateFrame(outputPath);
      if (emptyFrame) {
        await unlinkGuarded(outputPath).catch(() => {});
        return finalizeJobFailure(job, jobId, null, emptyFrame);
      }
      await atomicWrite(sidecar, { ...meta, ...sidecarFields, ...renderTimingFields(job.renderStartedAtMs) });
      await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode });
      if (entry.aborted) {
        await Promise.all([outputPath, sidecar].map(path => unlinkGuarded(path)));
        return finalizeCanceled(job, jobId);
      }
      job.status = 'complete';
      if (activeRequests.get(jobId) === entry) activeRequests.delete(jobId);
      activeJobs.delete(jobId);
      console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (${doneNote})`);
      const done = { filename, path: `/data/images/${filename}` };
      dispatchTerminalEvent(
        jobId,
        () => broadcastSse(job, { type: 'complete', result: done }),
        () => imageGenEvents.emit('completed', { mode, generationId: jobId, inputProcessSettled: true, path: done.path, filename }),
      );
      closeJobAfterDelay(jobs, jobId);
    } catch (err) {
      if (wroteOutput && job.status !== 'complete') {
        await Promise.all([outputPath, sidecar].map(path => unlinkGuarded(path).catch(() => {})));
      }
      throw err;
    }
  });

  /**
   * The run's catch tail. The remote request may still be queued or running, so
   * cancel it (the transports no-op once it is terminal or before a submit).
   * `force` because the success tail stamps 'complete' before its last awaits.
   */
  const failRun = async (job, entry, reason) => {
    if (cancelRemote) await cancelRemote(entry);
    if (entry.aborted) return finalizeCanceled(job, job.id);
    return finalizeJobFailure(job, job.id, null, reason, { force: true });
  };

  return { ...runner, jobMeta, start, publish, failRun };
}
