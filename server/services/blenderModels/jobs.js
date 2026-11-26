/**
 * The in-memory jobs of Blender models: builds and review renders share one
 * list per model, one tracked map (so the unattended updater waits for them) and
 * one set of running promises a delete can wait on.
 */
import { CANCEL_ALREADY_TERMINAL } from '../../lib/cancelResponse.js';
import { trackedRenderMap } from '../renderActivity.js';
import { createBlenderJobRegistry } from '../blenderWorkspace/jobRegistry.js';
import * as store from './store.js';

export const registry = createBlenderJobRegistry({ keyOf: (owner) => owner.id, label: 'Blender model', keptPerOwner: 10 });
const inFlight = trackedRenderMap('blender-model', { noun: 'Blender model build' });
// model id → Set of the promises of its running jobs.
const settling = new Map();

export const ownerOf = (id) => ({ id, emit: () => store.announceBlenderModel(id) });

export const listBlenderModelJobs = (id) => registry.list(ownerOf(id));

/** The unfinished job entries of one kind (`build` or `review`). */
export const activeJobs = (id, kind) => registry.active(ownerOf(id)).filter(({ job }) => job.kind === kind);

/** Cancel the matching build, review, or set bake. */
export function cancelJob(id, kind, buildId, setId) {
  const matches = (job) => job.kind === kind && job.buildId === buildId && job.setId === setId;
  const owner = ownerOf(id);
  const entry = registry.active(owner).find(({ job }) => matches(job));
  if (!entry) return registry.list(owner).some(matches) ? CANCEL_ALREADY_TERMINAL : false;
  entry.abort.abort();
  return true;
}

/** Track `work` (which must not reject) as running for `id` until it settles. */
export function trackJob(id, key, work) {
  inFlight.set(key, id);
  const running = settling.get(id) ?? new Set();
  settling.set(id, running);
  const done = work.finally(() => {
    running.delete(done);
    if (!running.size && settling.get(id) === running) settling.delete(id);
    inFlight.delete(key);
  });
  running.add(done);
  return done;
}

/** Cancel everything `id` runs and wait for it to settle (a delete calls this first). */
export async function settleBlenderModelJobs(id) {
  // A build may hand over to its review while the cancel is in flight.
  while (settling.get(id)?.size) {
    for (const entry of registry.active(ownerOf(id))) entry.abort.abort();
    await Promise.all(settling.get(id));
  }
}

/** Test seam: forget every job. */
export function __resetBlenderModelJobsForTests() {
  registry.reset();
  settling.clear();
  for (const key of [...inFlight.keys()]) inFlight.delete(key);
}
