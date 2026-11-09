/**
 * Server-side status for Previz work in flight (greybox drafts, AI previz
 * proposals), so any open Previz page shows it, whoever started it: another
 * tab or an agent calling the API. In memory on purpose: a job is a provider
 * call that dies with the process, and the page treats an absent job as idle.
 * Every change is broadcast as `catalog:previz-jobs` with the whole snapshot.
 */
import { randomUUID } from 'crypto';
import { catalogEvents } from './catalogEvents.js';

const RECENT_MAX = 20;
const RECENT_TTL_MS = 30 * 60 * 1000;

const running = new Map();
let recent = [];

const publicJob = ({ id, kind, ingredientId, projectId, label, state, startedAt, endedAt, summary }) => ({
  id, kind, ingredientId: ingredientId || null, projectId: projectId || null, label, state, startedAt, endedAt: endedAt || null, summary: summary || null,
});

/** Running jobs plus recently finished ones (with their summary or error). */
export function listPrevizJobs(now = Date.now()) {
  recent = recent.filter((job) => now - job.endedAt < RECENT_TTL_MS);
  return { jobs: [...running.values(), ...recent].map(publicJob) };
}

const broadcast = () => catalogEvents.emit('previz-jobs', listPrevizJobs());

/**
 * Run `work` as a tracked job. `describe(result)` gives the finished summary.
 * The job's outcome never changes what `work` returns or throws.
 */
export async function runPrevizJob({ kind, ingredientId, projectId, label }, work, describe = () => null) {
  const job = { id: randomUUID(), kind, ingredientId, projectId, label, state: 'running', startedAt: Date.now() };
  running.set(job.id, job);
  broadcast();
  const finish = (state, summary) => {
    running.delete(job.id);
    recent = [{ ...job, state, endedAt: Date.now(), summary }, ...recent].slice(0, RECENT_MAX);
    broadcast();
  };
  const result = await work().catch((err) => {
    finish('failed', err?.message || 'Failed');
    throw err;
  });
  finish('done', describe(result));
  return result;
}

export const __resetPrevizJobsForTests = () => { running.clear(); recent = []; };
