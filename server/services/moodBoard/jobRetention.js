// Keep every active job and at most the 100 most recently finished jobs.
// Check expiry on access and settlement so idle boards need no timers.
const MAX_FINISHED_JOBS = 100;
const FINISHED_JOB_TTL_MS = 30 * 60 * 1000;

export function pruneFinishedJobs(jobs) {
  const cutoff = Date.now() - FINISHED_JOB_TTL_MS;
  const finished = [];
  for (const [boardId, job] of jobs) {
    if (job.status === 'running') continue;
    if (Date.parse(job.finishedAt) <= cutoff) jobs.delete(boardId);
    else finished.push(boardId);
  }
  for (const boardId of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    jobs.delete(boardId);
  }
}

export function retainFinishedJob(jobs, job) {
  // Map order tracks settlement order, even when jobs finish out of order.
  jobs.delete(job.boardId);
  jobs.set(job.boardId, job);
  pruneFinishedJobs(jobs);
}
