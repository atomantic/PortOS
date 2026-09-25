/**
 * Retention sweep for `data/screenshots` (issue #8461).
 *
 * The bucket is the hand-off point for images an AI reads from disk: shell
 * image drops (`shell-<id>-<name>`, pasted into a PTY once and never read
 * again), CoS task screenshots (`POST /api/screenshots`, referenced from a
 * task's `metadata.screenshots[]`), and vision-test / universe-describe inputs.
 * Nothing else ever deletes them, so a photo handed to an agent once stayed on
 * disk, in every backup, indefinitely.
 *
 * Rules:
 * - `shell-*` files older than 7 days are removed — single-use PTY hand-offs.
 * - Every other file older than 30 days is removed unless a CoS task that is
 *   neither completed nor failed still lists it in `metadata.screenshots[]`.
 *
 * Fail closed: if the task store can't be read, the sweep deletes nothing —
 * "couldn't read the references" must never collapse into "no references".
 *
 * Runs outside the request lifecycle, so the handler owns its rejections.
 */

import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { PATHS, unlinkGuarded } from '../lib/fileUtils.js';
import { createSweepScheduler } from './sweepScheduler.js';
import { getAllTasks } from './cosTaskStore.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHELL_DROP_MAX_AGE_MS = 7 * DAY_MS;
const SCREENSHOT_MAX_AGE_MS = 30 * DAY_MS;
const SHELL_DROP_PREFIX = 'shell-';
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed']);

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000;

// A task reference is either the API URL (`/api/screenshots/<encoded name>`)
// the upload route hands back, or a filesystem path from an older client.
const referenceBasename = (ref) => {
  const name = basename(ref);
  try { return decodeURIComponent(name); } catch { return name; }
};

/**
 * Basenames of screenshots still listed by a live (not completed/failed) task.
 * Throws when the task store is unreadable — callers must treat that as
 * "unknown", not "empty".
 */
async function collectReferencedScreenshots(readTasks = getAllTasks) {
  const { user, cos } = await readTasks();
  const referenced = new Set();
  for (const task of [...(user?.tasks ?? []), ...(cos?.tasks ?? [])]) {
    if (TERMINAL_TASK_STATUSES.has(task?.status)) continue;
    const refs = task?.metadata?.screenshots;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref === 'string' && ref) referenced.add(referenceBasename(ref));
    }
  }
  return referenced;
}

/**
 * One GC pass (underscore: exported as a test hook). Returns counts, or `{ skipped: true }` when the task store was
 * unreadable and nothing was touched.
 */
export async function _sweepScreenshots({
  now = Date.now(),
  dir = PATHS.screenshots,
  readTasks = getAllTasks,
} = {}) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const result = { deleted: 0, keptReferenced: 0, keptYoung: 0 };
  if (files.length === 0) return result;

  let referenced;
  try {
    referenced = await collectReferencedScreenshots(readTasks);
  } catch (err) {
    console.error(`❌ Screenshots GC skipped: task store unreadable: ${err.message}`);
    return { ...result, skipped: true };
  }

  for (const name of files) {
    const isShellDrop = name.startsWith(SHELL_DROP_PREFIX);
    const maxAgeMs = isShellDrop ? SHELL_DROP_MAX_AGE_MS : SCREENSHOT_MAX_AGE_MS;
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs < maxAgeMs) {
      result.keptYoung += 1;
      continue;
    }
    if (!isShellDrop && referenced.has(name)) {
      result.keptReferenced += 1;
      continue;
    }
    const removed = await unlinkGuarded(join(dir, name)).then(() => true).catch(() => false);
    if (removed) result.deleted += 1;
  }
  return result;
}

const runSweep = async () => {
  const result = await _sweepScreenshots().catch((err) => {
    console.error(`❌ Screenshots GC failed: ${err.message}`);
    return null;
  });
  if (result?.deleted > 0) {
    console.log(`🧹 Screenshots GC: removed ${result.deleted}, kept ${result.keptReferenced} referenced, ${result.keptYoung} recent`);
  }
};

export const {
  start: startScreenshotsGc,
  stop: stopScreenshotsGc,
} = createSweepScheduler({
  id: 'screenshots-gc',
  intervalMs: SWEEP_INTERVAL_MS,
  initialDelayMs: INITIAL_DELAY_MS,
  handler: runSweep,
  source: 'screenshotsGc',
});
