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
 * without standing up the real queue or a real detached process.
 */

import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { isDetachedRunning } from '../lib/detachedSpawn.js';
import { listJobs } from './mediaJobQueue/index.js';
import { collectActiveCleanBasenames } from './imageCleanTmpGc.js';

const IDLE = { busy: false, reason: null };

// Jobs the media queue still owes work to. A terminal job (completed / failed /
// canceled) has no claim on anything under `data/`.
const IN_FLIGHT_STATUSES = new Set(['queued', 'running']);

/**
 * `data/image-clean-tmp` — delegates to the SAME predicate the hourly GC sweep
 * uses to spare an active job's files (`collectActiveCleanBasenames`), so a
 * one-click purge can never be more permissive than the automatic sweep that
 * deliberately leaves those files alone.
 *
 * @param {{ jobs?: Array }} [state] - injected job list; defaults to the live queue
 * @returns {Promise<{ busy: boolean, reason: string|null }>}
 */
export async function imageCleanTmpBusy({ jobs = null } = {}) {
  const pinned = collectActiveCleanBasenames(jobs || listJobs({ kind: 'image' }));
  if (pinned.size === 0) return IDLE;
  return {
    busy: true,
    reason: `An image job is queued or running and ${pinned.size} working file(s) here belong to it — purge once it finishes.`
  };
}

/**
 * `data/training-runs` — LoRA training is routed through the media queue's GPU
 * lane as `kind: 'training'`, which is the live registry of in-flight runs: the
 * boot reconcile in `loraTraining/index.js` and the cancel path both key on it,
 * and unlike the Postgres run record it costs no DB round-trip on the
 * `GET /api/data` overview.
 *
 * @param {{ jobs?: Array }} [state] - injected job list; defaults to the live queue
 * @returns {Promise<{ busy: boolean, reason: string|null }>}
 */
export async function trainingRunsBusy({ jobs = null } = {}) {
  const all = jobs || listJobs({ kind: 'training' });
  const active = (Array.isArray(all) ? all : []).filter((job) => IN_FLIGHT_STATUSES.has(job?.status));
  if (active.length === 0) return IDLE;
  return {
    busy: true,
    reason: `${active.length} LoRA training run(s) queued or running — purging now would delete checkpoints out from under a live trainer. Purge once training finishes.`
  };
}

/**
 * `data/update-detached` — the same `isDetachedRunning` probe `updateExecutor.js`
 * uses to refuse a second concurrent update. The directory name is duplicated
 * from that module's `controlDir`; keep the two in step. It is joined off
 * `PATHS.data` inside the function (not hoisted to a module constant) so a test
 * that redirects the data root is honored.
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
