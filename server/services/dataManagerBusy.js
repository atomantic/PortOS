/**
 * Live-work probes for Data Manager category purges (issue #3342).
 *
 * A category-wide purge empties the whole directory in one action. Three
 * categories are correctly classified as reproducible scratch — the bytes do
 * come back — but only once nothing is USING them:
 *
 *   image-clean-tmp — the init/mask/original inputs a queued or running Image
 *     Cleaner render is about to read.
 *   training-runs   — the checkpoints, caches, and sample previews a LoRA
 *     trainer is writing right now (hours of GPU time).
 *   update-detached — the control files the detached self-update script is
 *     being polled through.
 *
 * Each probe resolves `{ busy, reason }`. `reason` is user-facing copy: it is
 * both the 409 `CATEGORY_BUSY` body and the text the Data Manager row shows in
 * place of the Purge button, so it must name what is running and imply when to
 * retry. Every probe takes its state as an optional argument so it is testable
 * without standing up the real queue, a real detached process, or the real
 * `data/` tree.
 *
 * Directories are joined off `PATHS.data` inside each probe (the category key
 * IS the directory name) rather than read from the `PATHS.imageCleanTmp` /
 * `PATHS.trainingRuns` aliases — those are captured at module load, so a test
 * that redirects the data root would not be honored by them.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { isDetachedRunning } from '../lib/detachedSpawn.js';
import { listJobs } from './mediaJobQueue/index.js';
import { collectActiveCleanBasenames } from './imageCleanTmpGc.js';

const IDLE = { busy: false, reason: null };

// Jobs the media queue still owes work to. A terminal job (completed / failed /
// canceled) has no claim on anything under `data/`.
const IN_FLIGHT_STATUSES = new Set(['queued', 'running']);

const listDirNames = (dir) => readdir(dir, { withFileTypes: true }).catch(() => []);

/**
 * `data/image-clean-tmp` — the pinned set comes from the SAME predicate the
 * hourly GC sweep uses to spare an active job's files
 * (`collectActiveCleanBasenames`), so a one-click purge can never be more
 * permissive than the automatic sweep that deliberately leaves them alone.
 *
 * That predicate is intentionally broad: it pins `<jobId>-{mask,original}.png`
 * and friends for EVERY in-flight image job, because a job's clean side files
 * are keyed by job id. Left at that, an unrelated gallery render would report
 * the scratch dir busy. So the pinned names are intersected with what is
 * actually in the directory — the purge is only refused when a live job's file
 * is really sitting there to be destroyed.
 *
 * @param {{ jobs?: Array, entries?: string[] }} [state] - injected job list / directory listing
 * @returns {Promise<{ busy: boolean, reason: string|null }>}
 */
export async function imageCleanTmpBusy({ jobs = null, entries = null } = {}) {
  const pinned = collectActiveCleanBasenames(jobs || listJobs({ kind: 'image' }));
  if (pinned.size === 0) return IDLE;
  const present = entries
    || (await listDirNames(join(PATHS.data, 'image-clean-tmp'))).filter(e => e.isFile()).map(e => e.name);
  const atRisk = present.filter(name => pinned.has(name));
  if (atRisk.length === 0) return IDLE;
  return {
    busy: true,
    reason: `An image job is queued or running and ${atRisk.length} working file(s) here belong to it — purge once it finishes.`
  };
}

/**
 * `data/training-runs`. Two sources, because neither alone covers a restart:
 *
 *   1. The media queue's GPU lane, where training runs as `kind: 'training'` —
 *      the live registry the cancel path and the boot reconcile both key on,
 *      and cheaper than a Postgres round-trip on every `GET /api/data`.
 *   2. Each run's `.detached` control dir. A trainer is a detached child that
 *      SURVIVES a pm2 restart, so between accepting requests and
 *      `initLoraTraining()` finishing its reconcile there is a window where a
 *      live trainer has no queue job. Asking the control dir answers "is a
 *      process writing here right now" independent of any in-memory state.
 *
 * @param {{ jobs?: Array, runsDir?: string }} [state] - injected job list / runs root
 * @returns {Promise<{ busy: boolean, reason: string|null }>}
 */
export async function trainingRunsBusy({ jobs = null, runsDir = null } = {}) {
  const all = jobs || listJobs({ kind: 'training' });
  const active = (Array.isArray(all) ? all : []).filter((job) => IN_FLIGHT_STATUSES.has(job?.status));
  if (active.length > 0) {
    return {
      busy: true,
      reason: `${active.length} LoRA training run(s) queued or running — purging now would delete checkpoints out from under a live trainer. Purge once training finishes.`
    };
  }

  const dir = runsDir || join(PATHS.data, 'training-runs');
  const runs = (await listDirNames(dir)).filter(e => e.isDirectory()).map(e => e.name);
  const surviving = await Promise.all(
    runs.map(name => isDetachedRunning(join(dir, name, '.detached')).catch(() => false))
  );
  if (!surviving.some(Boolean)) return IDLE;
  return {
    busy: true,
    reason: 'A LoRA trainer that outlived a restart is still writing here — purge once it finishes or is cancelled.'
  };
}

/**
 * `data/update-detached` — the same `isDetachedRunning` probe `updateExecutor.js`
 * uses to refuse a second concurrent update. The directory name is duplicated
 * from that module's `controlDir`; keep the two in step.
 *
 * @param {{ controlDir?: string }} [state] - injected control dir; defaults to the real one
 * @returns {Promise<{ busy: boolean, reason: string|null }>}
 */
export async function updateDetachedBusy({ controlDir = null } = {}) {
  const dir = controlDir || join(PATHS.data, 'update-detached');
  const running = await isDetachedRunning(dir);
  if (!running) return IDLE;
  return {
    busy: true,
    reason: 'A self-update is running and PortOS polls its control files here — purging now loses the handle on it. Purge once the update finishes.'
  };
}
