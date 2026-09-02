/**
 * Orphaned resumable-download `.partial` GC (issue #5855).
 *
 * `streamResumableDownload` keeps `${dest}.partial` (+ a `.partial.etag`
 * sidecar) after a transport failure so a retry can Range-resume. If the user
 * never retries, those files sit invisible in LoRA / spec-decode / local-LLM
 * model dirs and eat the disk the preflight exists to protect.
 *
 * This is the same shape as imageCleanTmpGc / imageRefsGc: a delayed boot pass
 * plus a daily tick through eventScheduler. The age-gate lives in
 * `sweepOrphanedPartials`; this module only names the destinations and the
 * in-flight dests that must not be touched.
 */

import { dirname } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { sweepOrphanedPartials, ORPHANED_PARTIAL_MAX_AGE_MS } from '../lib/downloadPreflight.js';
import { SPEC_DECODE_PRESETS, SPEC_MODEL_ROLES } from '../lib/specDecodePresets.js';
import {
  resolveSpecModelPath,
  isSpecDecodeDownloadInFlight,
} from './specDecodeModels.js';
import { getModelsDir as getOllamaModelsDir } from './ollamaManager.js';
import { getModelsDir as getLmStudioModelsDir } from './lmStudioManager.js';
import { createSweepScheduler } from './sweepScheduler.js';

export { ORPHANED_PARTIAL_MAX_AGE_MS };

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Directories the four #5817 download entry points can leave a `.partial` in.
 * Spec-decode dests are per-file; we sweep each file's parent so a custom
 * `~/models/...` path is covered without walking the whole home directory.
 */
export async function collectPartialSweepDirs() {
  const dirs = new Set();
  dirs.add(PATHS.loras);
  for (const preset of SPEC_DECODE_PRESETS) {
    for (const role of SPEC_MODEL_ROLES) {
      const path = preset[role]?.path;
      if (path) dirs.add(dirname(resolveSpecModelPath(path)));
    }
  }
  dirs.add(getOllamaModelsDir());
  dirs.add(await getLmStudioModelsDir());
  return [...dirs];
}

/**
 * One GC pass. `dirs` is injectable so tests can point at a temp tree without
 * touching the live install's model directories.
 */
export async function sweepOrphanedDownloadPartials({
  now = Date.now(),
  maxAgeMs = ORPHANED_PARTIAL_MAX_AGE_MS,
  dirs = null,
} = {}) {
  const targets = dirs || await collectPartialSweepDirs();
  return sweepOrphanedPartials(targets, {
    now,
    maxAgeMs,
    isProtected: (path) => isSpecDecodeDownloadInFlight(path),
  });
}

const runSweep = async () => {
  const { deleted } = await sweepOrphanedDownloadPartials();
  if (deleted > 0) console.log(`🧹 Orphaned download partial GC: removed ${deleted} stale file(s)`);
};

export const {
  start: startOrphanedPartialGc,
  stop: stopOrphanedPartialGc,
} = createSweepScheduler({
  id: 'orphaned-partial-gc',
  intervalMs: SWEEP_INTERVAL_MS,
  initialDelayMs: 5 * 60 * 1000,
  handler: runSweep,
  source: 'orphanedPartialGc',
});
