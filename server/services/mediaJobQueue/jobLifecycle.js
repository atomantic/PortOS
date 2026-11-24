import { broadcastSse } from '../../lib/sseUtils.js';
import { isRemoteMediaJob } from './remoteMediaJob.js';
import { recordQuotaCooldown, recordRateLimitCooldown } from './limits.js';
import { persist } from './persistence.js';
import { mediaJobEvents, isTopazUpscale, trackTerminalOperation, videoHolds } from './state.js';
import { loadMediaRuntimeModule } from '../bootHookRegistry.js';

// Public status remains running until the terminal outcome is durable.
// The synchronous claim is transient: neither persistence nor public job
// projections include it. Cancellation intent alone does not claim an outcome.
const hasUnclaimedRunningOutcome = (job) => job.status === 'running' && !job.terminating;

export const canReceiveProgress = (job) => hasUnclaimedRunningOutcome(job);
export const canRequestCancellation = (job) => hasUnclaimedRunningOutcome(job);

export function claimTerminalOutcome(job) {
  if (!hasUnclaimedRunningOutcome(job)) return false;
  job.terminating = true;
  return true;
}

// Keep both intent fields together: provider refusal must restore the original
// values, including an absent/legacy remote marker, without changing status.
export function snapshotCancellationIntent(job) {
  return { cancelRequested: job.cancelRequested, remoteMedia: job.params?.remoteMedia };
}

export function applyCancellationIntent(job) {
  job.cancelRequested = true;
  if (isRemoteMediaJob(job)) {
    job.params.remoteMedia = {
      ...(job.params.remoteMedia && typeof job.params.remoteMedia === 'object'
        ? job.params.remoteMedia : {}),
      cancelRequested: true,
    };
  }
}

export function restoreCancellationIntent(job, previous) {
  job.cancelRequested = previous.cancelRequested;
  if (isRemoteMediaJob(job)) job.params.remoteMedia = previous.remoteMedia;
}

// Browser startup and each CDP command have their own deadlines, but a
// multi-step finish needs an overall bound as well. Abort cooperatively and
// retain the lane until the owned browser and any publication work settle.
export const VISUAL_PROFILE_FINISH_TIMEOUT_MS = 3 * 60 * 1000;

export function createJobHandlers(job, { sseEntry, permit, terminate, enqueueJob, stopWatchdog }) {
  const handlers = {
    progress: (payload) => {
      if (!canReceiveProgress(job)) return;
      const { progress, statusMsg, etaMs } = job;
      if (payload.type === 'progress' && Number.isFinite(payload.progress)) {
        job.progress = Math.max(0, Math.min(1, payload.progress));
      }
      if (typeof payload.message === 'string' && payload.message.length > 0) {
        job.statusMsg = payload.message;
      }
      // Reloaded browsers hydrate these values from the in-memory queue.
      if (Number.isFinite(payload.etaMs)) job.etaMs = payload.etaMs;
      broadcastSse(sseEntry, payload);
      if (job.progress !== progress || job.statusMsg !== statusMsg || job.etaMs !== etaMs) {
        mediaJobEvents.emit('progress', {
          id: job.id, startedAt: job.startedAt, progress: job.progress, statusMsg: job.statusMsg, etaMs: job.etaMs,
        });
      }
    },
    completed: (payload) => {
      const { remoteInputsDisposable, remoteRecoverySettlement, initImageFilename: _initImageFilename, referenceImageFilenames, ...result } = payload;
      const recordRefs = (j) => {
        if (Array.isArray(referenceImageFilenames)) j.referenceImageFilenames = referenceImageFilenames;
      };
      if (job.kind === 'image' && job.params?.visualProfile) {
        if (job.visualProfileFinishing || !canRequestCancellation(job)) return;
        const applyFilmFinish = !job.params.catalogAttach && !job.params.characterSheet;
        const phase = applyFilmFinish ? 'Film finishing' : 'Image metadata save';
        const controller = new AbortController();
        job.visualProfileFinishing = controller;
        const finishWatchdog = setTimeout(() => {
          controller.abort(new Error(`${phase} exceeded its 3-minute deadline`));
        }, VISUAL_PROFILE_FINISH_TIMEOUT_MS);
        finishWatchdog.unref?.();
        if (job.cancelRequested) controller.abort(new Error(`Canceled during ${phase.toLowerCase()}`));
        stopWatchdog();
        handlers.progress({ type: 'progress', progress: 0.95, message: applyFilmFinish
          ? 'Saving universe visual profile and film finish' : 'Saving image visual profile' });
        // The provider publication settles after this synchronous event.
        // Keep asynchronous post-processing under our longer-lived media owner.
        trackTerminalOperation(permit.run(async () => {
          try {
            // Retry resumes only the local finish. Persist the completed source
            // before opening a browser so a failed finish cannot buy another image.
            job.params = { ...job.params, visualProfileSource: result };
            await persist();
            controller.signal.throwIfAborted();
            const { finishVisualProfileImage } = await loadMediaRuntimeModule('finishVisualProfile');
            const finished = await finishVisualProfileImage({ result, profile: job.params.visualProfile,
              revision: job.params.visualProfileRevision, applyFilmFinish, signal: controller.signal, onCleanupFailure: () => permit.markUnsettled() });
            controller.signal.throwIfAborted();
            await terminate('completed', j => { recordRefs(j); j.result = finished; }, remoteInputsDisposable === true);
          } catch (error) {
            await terminate(job.cancelRequested ? 'canceled' : 'failed', j => {
              recordRefs(j);
              j.result = result;
              j.statusMsg = job.cancelRequested ? `Canceled during ${phase.toLowerCase()}; original image retained` : `${phase} failed; original image retained`;
              j.error = job.cancelRequested ? `Canceled during ${phase.toLowerCase()}; original image retained` : `${phase} failed; original image retained: ${error.message}`;
            }, remoteInputsDisposable === true);
          } finally { clearTimeout(finishWatchdog); delete job.visualProfileFinishing; }
        }).catch(e => console.error(`❌ media-job [${job.id.slice(0, 8)}] film finishing handler failed: ${e.message}`)));
        return;
      }
      if (job.kind === 'image' && result?.filename) {
        trackTerminalOperation(permit.run(async () => {
          try {
            const { getVerifierSettings, verifyImage } = await loadMediaRuntimeModule('imageVerifier');
            const vs = await getVerifierSettings().catch(() => null);
            if (vs?.enabledForGeneration || job.params?.verifyImage === true) {
              const verification = await verifyImage({
                filename: result.filename,
                prompt: job.params?.prompt || '',
                profileId: job.params?.verificationProfileId || vs?.defaultProfileId,
              }).catch(() => null);
              if (verification) {
                result.verification = verification;
                const maxRerolls = Number.isFinite(job.params?.maxRerolls) ? job.params.maxRerolls : (vs?.maxRerolls ?? 2);
                const rerollsDone = job.params?.verificationRerollCount || 0;
                if (verification.verdict === 'fail' && rerollsDone < maxRerolls) {
                  console.log(`⚠️ media-job [${job.id.slice(0, 8)}] verification failed: ${verification.summary}. Auto-rerolling (attempt ${rerollsDone + 1} of ${maxRerolls})...`);
                  await enqueueJob({
                    kind: 'image',
                    owner: job.owner,
                    params: {
                      ...job.params,
                      seed: (Number.isFinite(job.params?.seed) ? job.params.seed : Date.now()) + 1,
                      verificationRerollCount: rerollsDone + 1,
                      parentJobId: job.id,
                    },
                  }).catch((e) => console.error(`❌ Auto-reroll enqueue failed: ${e.message}`));
                }
              }
            }
          } catch (err) {
            console.warn(`🔍 Verification check failed on completed image job [${job.id.slice(0, 8)}]:`, err.message);
          }
          await terminate('completed', (j) => { recordRefs(j); j.result = result; }, remoteInputsDisposable === true);
        }).catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`)));
        return;
      }
      trackTerminalOperation(
        terminate('completed', (j) => { recordRefs(j); j.result = result; }, remoteInputsDisposable === true)
          .catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`)),
      );
    },
    failed: (payload) => {
      if (job.visualProfileFinishing) {
        job.visualProfileFinishing.abort(new Error(payload.error || 'Image finishing interrupted'));
        return;
      }
      // If cancelJob() flagged this job before the underlying gen reported
      // failure, treat the SIGTERM-induced failure as a clean cancel rather
      // than an error so /api/media-jobs?status=canceled works.
      if (job.cancelRequested && !(isTopazUpscale(job) && payload.remoteCancellationConfirmed !== true)) {
        trackTerminalOperation(
          terminate('canceled', (j) => {
            if (Array.isArray(payload.referenceImageFilenames)) j.referenceImageFilenames = payload.referenceImageFilenames;
            // Persist the reason so a late SSE reconnect after the live entry
            // is cleaned up still gets a meaningful terminal frame from the
            // archived state, rather than the generic "Canceled" fallback.
            if (j.kind === 'image' && j.params?.visualProfileSource) {
              j.result = j.params.visualProfileSource;
              j.error = 'Canceled during film finishing; original image retained';
            } else j.error = 'Canceled while running';
          }, payload.remoteInputsDisposable === true).catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`)),
        );
        return;
      }
      trackTerminalOperation(
        terminate('failed', (j) => {
          if (Array.isArray(payload.referenceImageFilenames)) j.referenceImageFilenames = payload.referenceImageFilenames;
          j.error = payload.error || 'unknown error';
          // Evidence only — this job still fails through the normal terminal
          // path. What it buys is every job queued BEHIND it: they hold for the
          // provider's stated reset instead of dispatching into the same 429.
          recordQuotaCooldown(j, j.error);
          recordRateLimitCooldown(j, j.error, payload);
          videoHolds.captureFailure(j, j.error, payload);
        }, payload.remoteInputsDisposable === true)
          .catch((e) => console.error(`❌ media-job [${job.id.slice(0, 8)}] terminal handler failed: ${e.message}`)),
      );
    },
  };
  return handlers;
}
