import { isRemoteMediaJob } from './remoteMediaJob.js';

// Public status remains running while the terminal sink drains progress.
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
