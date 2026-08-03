/**
 * Quota-burn config + run-log storage (machine-local).
 *
 * Two files under `data/cos/`:
 *   - `quota-burn.json`      — the install's burn plan (see lib/quotaBurnConfig.js)
 *   - `quota-burn-runs.json` — a capped log of what the runner did, for the page
 *
 * Deliberately NOT federated, for the same reason the dispatch ledger isn't:
 * quota belongs to a particular machine and provider account. Two peers sharing
 * a burn plan would each think they owned the other's window budget, and the
 * "which managed app" targets differ per machine anyway.
 *
 * Every read normalizes, so a config file written by an older PortOS (or by
 * hand) loads without a migration step — `normalizeQuotaBurnConfig` fills the
 * family set and drops what it can't interpret.
 */

import { join } from 'path';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { normalizeQuotaBurnConfig } from '../lib/quotaBurnConfig.js';

const configFile = () => join(PATHS.cos, 'quota-burn.json');
const runLogFile = () => join(PATHS.cos, 'quota-burn-runs.json');

/** Keep the run log skimmable and bounded — it is a UI feed, not an audit trail. */
export const QUOTA_BURN_RUN_LOG_LIMIT = 50;

// One tail per file. The config's read-modify-write races with itself when the
// page saves twice quickly; the run log's races between the scheduler tick and
// an on-demand "Run now". Same "serialize two write paths that mutate the same
// record" case the dispatch ledger documents — not a multi-user defense.
const configWriteQueue = createFileWriteQueue();
const runLogWriteQueue = createFileWriteQueue();

export async function getQuotaBurnConfig() {
  return normalizeQuotaBurnConfig(await readJSONFile(configFile(), null));
}

/**
 * Merge `patch` over the stored config and persist the normalized result.
 * Shallow at the top level and per family, so the page can PUT a single family
 * (or just `{ enabled }`) without restating the whole plan. A family's `jobs`
 * array is REPLACED wholesale when present — it is an ordered list, and
 * element-wise merging would make reordering and deletion inexpressible.
 */
export async function saveQuotaBurnConfig(patch) {
  return configWriteQueue(async () => {
    const current = normalizeQuotaBurnConfig(await readJSONFile(configFile(), null));
    const patchFamilies = patch?.families && typeof patch.families === 'object' ? patch.families : {};
    const merged = {
      ...current,
      ...patch,
      families: Object.fromEntries(
        Object.entries(current.families).map(([id, family]) => [
          id,
          Object.prototype.hasOwnProperty.call(patchFamilies, id)
            ? { ...family, ...patchFamilies[id] }
            : family,
        ]),
      ),
    };
    const next = normalizeQuotaBurnConfig(merged);
    await atomicWrite(configFile(), next);
    return next;
  });
}

export async function getQuotaBurnRuns() {
  const loaded = await readJSONFile(runLogFile(), null);
  return Array.isArray(loaded?.runs) ? loaded.runs : [];
}

/**
 * Append one run-log entry (newest first). Records SKIPS as well as dispatches:
 * "why did nothing burn last night" is the question the page exists to answer,
 * and a log that only shows successful dispatches cannot answer it.
 */
export async function recordQuotaBurnRun(entry) {
  return runLogWriteQueue(async () => {
    const loaded = await readJSONFile(runLogFile(), null);
    const runs = Array.isArray(loaded?.runs) ? loaded.runs : [];
    const next = [{ at: new Date().toISOString(), ...entry }, ...runs].slice(0, QUOTA_BURN_RUN_LOG_LIMIT);
    await atomicWrite(runLogFile(), { runs: next });
    return next;
  });
}
