/**
 * Live-work probes for Data Manager category purges (issue #3342).
 *
 * Protect scratch inputs and control files that are still in use. Retired LoRA
 * data also needs a read-only check for detached writers from old installs.
 *
 * Each probe resolves `{ busy, reason }`; `reason` is user-facing (the 409
 * `CATEGORY_BUSY` body and the row text in place of Purge), so it names what is
 * running and when to retry. State is an optional argument for testability.
 * Directories join off `PATHS.data` per probe, since the `PATHS.imageCleanTmp` /
 * `PATHS.trainingRuns` aliases are captured at load and ignore a test's redirected root.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { isDetachedRunning } from '../lib/detachedSpawn.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { findSurvivingTrainer } from '../lib/heavyJobClaim.js';
import { listJobs } from './mediaJobQueue/index.js';
import { collectActiveCleanBasenames } from './imageCleanTmpGc.js';
import { collectActiveFederatedAssetBasenames } from './federatedMedia/assetStore.js';
import { isUpdateControlTracked } from './updateControlActivity.js';

const IDLE = { busy: false, reason: null };

// A missing directory has nothing to lose (ENOENT reads as empty); any OTHER failure
// rethrows so `resolveCategoryBusy` fails closed.
const listDirEntries = (dir) => readdir(dir, { withFileTypes: true }).catch((err) => {
  if (err?.code === 'ENOENT') return [];
  throw err;
});

/**
 * `data/image-clean-tmp` — the pinned set comes from the SAME predicate the hourly GC
 * (`collectActiveCleanBasenames`) uses, so a purge is never more permissive than the
 * sweep. That predicate pins files for EVERY in-flight image job, so the names are
 * intersected with what is in the directory; only a live job's file actually present refuses it.
 *
 * @param {{ jobs?: Array, entries?: string[] }} [state] - injected job list / directory listing
 * @returns {Promise<{ busy: boolean, reason: string|null }>}
 */
export async function imageCleanTmpBusy({ jobs = null, entries = null } = {}) {
  const pinned = collectActiveCleanBasenames(jobs || listJobs({ kind: 'image' }));
  if (pinned.size === 0) return IDLE;
  const present = entries
    || (await listDirEntries(join(PATHS.data, 'image-clean-tmp'))).filter(e => e.isFile()).map(e => e.name);
  const atRisk = present.filter(name => pinned.has(name));
  if (atRisk.length === 0) return IDLE;
  return {
    busy: true,
    reason: `An image job is queued or running and ${atRisk.length} working file(s) here belong to it — purge once it finishes.`
  };
}

/**
 * `data/federated-media-inbox` — conditioning images a peer uploaded for a federated
 * render (#4348), the same case as `image-clean-tmp` but worse to destroy: the consumer
 * is waiting and nothing re-uploads. Pinned set comes from the TTL sweep's predicate
 * (`collectActiveFederatedAssetBasenames`) so a purge is never more permissive. Not
 * scoped to one kind: image and video jobs both stage conditioning here.
 *
 * @param {{ jobs?: Array, entries?: string[] }} [state] - injected job list / directory listing
 * @returns {Promise<{ busy: boolean, reason: string|null }>}
 */
export async function federatedMediaInboxBusy({ jobs = null, entries = null } = {}) {
  const pinned = collectActiveFederatedAssetBasenames(jobs || listJobs());
  if (pinned.size === 0) return IDLE;
  const present = entries
    || (await listDirEntries(join(PATHS.data, 'federated-media-inbox'))).filter(e => e.isFile()).map(e => e.name);
  const atRisk = present.filter(name => pinned.has(name));
  if (atRisk.length === 0) return IDLE;
  return {
    busy: true,
    reason: `A federated render is queued or running and ${atRisk.length} source image(s) here belong to it — purge once it finishes.`
  };
}

// Older installs may still have a detached trainer writing to these directories.
export async function trainingRunsBusy({ runsDir = null } = {}) {
  const dir = runsDir || join(PATHS.data, 'training-runs');
  const runs = (await listDirEntries(dir)).filter(e => e.isDirectory()).map(e => e.name);
  // Not caught: a probe that cannot answer must fail closed in `resolveCategoryBusy`.
  const surviving = await Promise.all(
    runs.map(name => isDetachedRunning(join(dir, name, '.detached')))
  );
  // The supervisor may have left a stale exit marker or no PID file.
  if (!surviving.some(Boolean) && !await findSurvivingTrainer({ root: dir })) return IDLE;
  return {
    busy: true,
    reason: 'A LoRA trainer that outlived a restart is still writing here — wait for it to finish before removing the data.'
  };
}

/**
 * `data/update-detached` — the same `isDetachedRunning` probe `updateExecutor.js`
 * uses; the directory name is duplicated from its `controlDir`, keep them in step.
 *
 * @param {{ controlDir?: string }} [state] - injected control dir; defaults to the real one
 * @returns {Promise<{ busy: boolean, reason: string|null }>}
 */
export async function updateDetachedBusy({ controlDir = null, admission = maintenance,
  snapshot = async () => (await import('./maintenanceProcessInventory.js')).snapshotMaintenanceProcesses() } = {}) {
  const dir = controlDir || join(PATHS.data, 'update-detached');
  let running = isUpdateControlTracked(dir) || admission.status().state === 'unavailable' || admission.deferredUpdate.launch()
    || admission.deferredUpdate.operation() || await isDetachedRunning(dir);
  if (!running) {
    const attempts = (await listDirEntries(dir)).filter(entry => entry.isDirectory()
      && /^[a-f0-9-]{36}$/i.test(entry.name)).map(entry => join(dir, entry.name));
    const pending = [];
    for (const attempt of attempts) {
      if (isUpdateControlTracked(attempt)) { running = true; break; }
      const exit = await readFile(join(attempt, 'exit'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (!exit.trim()) pending.push(attempt);
    }
    if (!running) running = (await Promise.all(pending.map(path => isDetachedRunning(path)))).some(Boolean);
    if (!running && pending.length) {
      const normalize = value => value.replaceAll('\\', '/').toLowerCase();
      const paths = pending.map(normalize);
      running = (await snapshot()).some(proc => proc.pid !== process.pid && !String(proc.state ?? '').startsWith('Z')
        && paths.some(path => normalize(String(proc.command ?? '')).includes(path)));
    }
  }
  if (!running) return IDLE;
  return {
    busy: true,
    reason: 'A self-update is running and PortOS polls its control files here — purging now loses the handle on it. Purge once the update finishes.'
  };
}
