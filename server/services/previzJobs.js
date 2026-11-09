/**
 * Server-side status for Previz work in flight (greybox drafts, AI previz
 * proposals), so any open Previz page shows it, whoever started it: another
 * tab or an agent calling the API. In memory on purpose: a job is a provider
 * call that dies with the process, and the page treats an absent job as idle.
 * A build or sync runs in the browser, so the page reports it through
 * startPrevizJob/finishPrevizJob; a job whose tab died stops showing after
 * RUNNING_STALE_MS. Every change is broadcast as `catalog:previz-jobs` with the whole snapshot.
 */
import { randomUUID } from 'crypto';
import { catalogEvents } from './catalogEvents.js';

const RECENT_MAX = 20;
const RECENT_TTL_MS = 30 * 60 * 1000;
// Longest a job may run before it is treated as orphaned (a closed tab or a crashed agent).
const RUNNING_STALE_MS = 10 * 60 * 1000;

const running = new Map();
let recent = [];

const publicJob = ({ id, kind, ingredientId, projectId, label, state, startedAt, endedAt, summary }) => ({
  id, kind, ingredientId: ingredientId || null, projectId: projectId || null, label, state, startedAt, endedAt: endedAt || null, summary: summary || null,
});

/** Running jobs plus recently finished ones (with their summary or error). */
export function listPrevizJobs(now = Date.now()) {
  for (const job of [...running.values()]) {
    if (job.kind === 'build' && now - job.startedAt > RUNNING_STALE_MS) settle(job, 'failed', 'Stopped reporting', now);
  }
  recent = recent.filter((job) => now - job.endedAt < RECENT_TTL_MS);
  return { jobs: [...running.values(), ...recent].map(publicJob) };
}

const broadcast = () => catalogEvents.emit('previz-jobs', listPrevizJobs());

function settle(job, state, summary, now = Date.now()) {
  running.delete(job.id);
  recent = [{ ...job, state, endedAt: now, summary }, ...recent].slice(0, RECENT_MAX);
}

/** Register a running job; returns its id for finishPrevizJob. */
export function startPrevizJob({ kind, ingredientId, projectId, label }) {
  const job = { id: randomUUID(), kind, ingredientId, projectId, label, state: 'running', startedAt: Date.now() };
  running.set(job.id, job);
  broadcast();
  return job.id;
}

/** Settle a running job; false when it is unknown or already settled. */
export function finishPrevizJob(id, { ok = true, summary = null } = {}) {
  const job = running.get(id);
  if (!job) return false;
  settle(job, ok ? 'done' : 'failed', summary || (ok ? null : 'Failed'));
  broadcast();
  return true;
}

/**
 * Run `work` as a tracked job. `describe(result)` gives the finished summary.
 * The job's outcome never changes what `work` returns or throws.
 */
export async function runPrevizJob(meta, work, describe = () => null) {
  const id = startPrevizJob(meta);
  const result = await work().catch((err) => {
    finishPrevizJob(id, { ok: false, summary: err?.message || 'Failed' });
    throw err;
  });
  finishPrevizJob(id, { summary: describe(result) });
  return result;
}

export const __resetPrevizJobsForTests = () => { running.clear(); recent = []; };
