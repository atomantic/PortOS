/**
 * Quota-burn job registry.
 *
 * A burn job is one unit of work a provider family's plan can run when its
 * window is about to reset. Each module exports:
 *
 *   countPending({ params, job, family })  → { count, detail }
 *   run({ params, job, family, candidate }) → { dispatched, summary?, reason?, detail? }
 *
 * `countPending` must be CHEAP and side-effect free — the config page calls it
 * for every configured job on every load, and the runner calls it to pick which
 * job in the ordered plan actually has work. `run` is the only thing that may
 * spend quota, and reports `dispatched: false` with a `reason` when it declines
 * (nothing to do, misconfigured target) so the caller does NOT charge the
 * window's dispatch cap for a burn that never happened.
 *
 * Modules are lazy-imported: `universeBibleImages` pulls the whole universe
 * store + media job queue, and `agentPrompt` the CoS task store, so a status
 * read for an install with no jobs configured should not load either.
 *
 * Adding a job type is three edits: a `QUOTA_BURN_JOB_TYPE` entry + catalog row
 * in `lib/quotaBurnConfig.js` (that's what the config page renders), a module
 * here, and one line in `JOB_MODULES`. The client needs no change unless the
 * job introduces a param kind the form doesn't render yet.
 */

import { QUOTA_BURN_JOB_TYPE } from '../../lib/quotaBurnConfig.js';

const JOB_MODULES = {
  [QUOTA_BURN_JOB_TYPE.AGENT_PROMPT]: () => import('./agentPrompt.js'),
  [QUOTA_BURN_JOB_TYPE.UNIVERSE_BIBLE_IMAGES]: () => import('./universeBibleImages.js'),
};

export const isKnownBurnJobType = (jobType) =>
  typeof jobType === 'string' && Object.hasOwn(JOB_MODULES, jobType);

export async function loadBurnJob(jobType) {
  return isKnownBurnJobType(jobType) ? JOB_MODULES[jobType]() : null;
}

/**
 * Pending-work probe for one configured job. Never throws: a job whose backing
 * store is unavailable reports zero pending with the error as its detail, so
 * one broken job can't wedge the family's whole plan or blank the status page.
 */
export async function countJobPending({ job, family }) {
  const mod = await loadBurnJob(job?.jobType);
  if (!mod) return { count: 0, detail: `unknown job type: ${job?.jobType}` };
  return mod.countPending({ params: job.params, job, family })
    .catch((err) => ({ count: 0, detail: `probe failed: ${err.message}` }));
}

/**
 * Run one configured job. Throws are converted to a non-dispatch: the runner
 * treats it as "this job declined", moves on, and logs the reason — a burn that
 * failed to start must not charge the window's cap.
 */
export async function runBurnJob({ job, family, candidate }) {
  const mod = await loadBurnJob(job?.jobType);
  if (!mod) return { dispatched: false, reason: `unknown job type: ${job?.jobType}` };
  return mod.run({ params: job.params, job, family, candidate })
    .catch((err) => ({ dispatched: false, reason: `job failed: ${err.message}` }));
}
