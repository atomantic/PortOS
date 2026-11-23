/**
 * An in-memory registry of Blender jobs (film syncs, shot renders and cuts;
 * model builds). A job is a disposable process; what it leaves in the
 * workspace is the durable result, and job identities are not persisted.
 *
 * Each registry is keyed by `keyOf(owner)`. Owner events carry
 * `{ kind: 'job', job }` through `owner.emit`, at most four messages a second;
 * terminal state is always sent. The adapter selects the socket channel.
 */
import { randomUUID } from 'node:crypto';

const PUBLISH_GAP_MS = 250;
const TERMINAL = new Set(['done', 'error', 'canceled']);

/**
 * `label` names the jobs in logs ("Blender film"); `keptPerOwner` finished jobs
 * are remembered per owner, oldest dropped first.
 */
export function createBlenderJobRegistry({ keyOf, label, keptPerOwner = 20 }) {
  // job id → { owner, job, abort, lastSent, timer }
  const entries = new Map();

  const send = (entry) => {
    entry.lastSent = Date.now();
    // A socket bridge throwing must not fail the job that reported progress.
    try {
      entry.owner.emit({ kind: 'job', job: { ...entry.job } });
    } catch (error) {
      console.error(`❌ ${label} job ${entry.job.id} could not be announced: ${error.message}`);
    }
  };

  function publish(entry, { now = false } = {}) {
    const wait = PUBLISH_GAP_MS - (Date.now() - entry.lastSent);
    if (now || wait <= 0) {
      clearTimeout(entry.timer);
      entry.timer = null;
      send(entry);
      return;
    }
    // Progress inside the gap is sent once, at its end, with the latest values.
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      send(entry);
    }, wait);
    entry.timer.unref?.();
  }

  const ownedBy = (owner) => [...entries.values()].filter((entry) => keyOf(entry.owner) === keyOf(owner));

  function prune(owner) {
    const finished = ownedBy(owner).filter((entry) => TERMINAL.has(entry.job.status));
    for (const entry of finished.slice(0, Math.max(0, finished.length - keptPerOwner))) entries.delete(entry.job.id);
  }

  const isActive = (entry) => !TERMINAL.has(entry.job.status);

  return {
    /** Register a queued job (`{ kind, ...details }`) and announce it. Returns its entry (`job`, `abort`). */
    create(owner, { kind, ...details }) {
      const now = new Date().toISOString();
      const job = { id: `bj-${randomUUID()}`, kind, status: 'queued', ...details, queuedAt: now, startedAt: now };
      const entry = { owner, job, abort: new AbortController(), lastSent: 0, timer: null };
      entries.set(job.id, entry);
      publish(entry, { now: true });
      return entry;
    },
    /** Apply `change` to a job. A status change is sent at once; progress is throttled. */
    update(entry, change) {
      const statusChanged = change.status && change.status !== entry.job.status;
      Object.assign(entry.job, change);
      if (statusChanged && change.status === 'running') entry.job.startedAt = new Date().toISOString();
      if (TERMINAL.has(entry.job.status)) {
        entry.job.finishedAt ??= new Date().toISOString();
        publish(entry, { now: true });
        prune(entry.owner);
        return;
      }
      publish(entry, { now: Boolean(statusChanged) });
    },
    isActive,
    entry(owner, jobId) {
      const entry = entries.get(jobId);
      return entry && keyOf(entry.owner) === keyOf(owner) ? entry : null;
    },
    /** Every job entry of an owner that has not finished, oldest first. */
    active: (owner) => ownedBy(owner).filter(isActive),
    /** Active jobs and the last finished ones, oldest first. */
    list: (owner) => ownedBy(owner).map((entry) => ({ ...entry.job })),
    /** Test seam: forget every job. */
    reset() {
      for (const entry of entries.values()) clearTimeout(entry.timer);
      entries.clear();
    },
  };
}
