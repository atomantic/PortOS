/** A queued or terminal-looking job can still own an interrupted provider. */
export const isEmptyLegacyMediaJob = job => Boolean(job) && typeof job === 'object'
  && !Array.isArray(job) && Object.keys(job).length === 0;

export function remoteMediaRecoveryPending(job) {
  return (job.status === 'queued' && (job.params?.remoteMedia?.reconcile === true
      || job.params?.reattach === true || job.params?.topazRecovery === true))
    || job.params?.remotePeerReservation === true
    || job.result?.topazUncertain === true;
}

export function mediaRecoveryPending(job) {
  if (isEmptyLegacyMediaJob(job)) return false;
  if (!job || typeof job !== 'object' || !['queued', 'running', 'completed', 'failed', 'canceled'].includes(job.status)) return true;
  return job.status === 'running' || remoteMediaRecoveryPending(job) || Boolean(job.durabilityPending);
}

// Chained local renders persist their child identity even if the outer job is
// already failed. A physically surviving segment still owns its output files.
export const recordedMediaChildIds = jobs => jobs.flatMap(job => Array.isArray(job?.videoExecutions)
  ? job.videoExecutions.map(execution => execution?.childJobId) : [])
  .filter(id => typeof id === 'string' && /^[a-z0-9-]{8,}$/i.test(id));

export const isCompletedLocalClaim = (claim, completed) => typeof claim?.token === 'string'
  && completed?.token === claim.token && completed.pid === claim.pid && completed.ownerPid === claim.pid
  && Number.isFinite(Date.parse(completed.finishedAt));
