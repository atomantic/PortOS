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
import { isPlainObject } from '../lib/objects.js';
import { normalizeQuotaBurnConfig } from '../lib/quotaBurnConfig.js';

const configFile = () => join(PATHS.cos, 'quota-burn.json');
const runLogFile = () => join(PATHS.cos, 'quota-burn-runs.json');

/** Keep the run log skimmable and bounded — it is a UI feed, not an audit trail. */
const RUN_LOG_LIMIT = 50;

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
    // Written to match `client/src/lib/quotaBurnPatch.js#mergeQuotaBurnPatch`
    // line for line — the client applies the same merge optimistically while the
    // PUT is debounced, and the two only stay honest if the claim is checkable
    // at a glance. `normalizeQuotaBurnConfig` below drops any unknown family id.
    const families = { ...current.families };
    for (const [id, familyPatch] of Object.entries(isPlainObject(patch?.families) ? patch.families : {})) {
      families[id] = { ...(families[id] || {}), ...familyPatch };
    }
    const next = normalizeQuotaBurnConfig({ ...current, ...patch, families });
    await atomicWrite(configFile(), next);
    return next;
  });
}

const inFlightFile = () => join(PATHS.cos, 'quota-burn-inflight.json');
const inFlightWriteQueue = createFileWriteQueue();

/**
 * How long an enqueued render keeps its entry out of the next cycle's pick.
 *
 * A cloud image render commonly takes minutes and `imageRefs` only fills in
 * when it COMPLETES, so without a cooldown every tick re-selects the same
 * entries. Long enough to outlast a queued render, short enough that a render
 * which silently failed is retried the same day rather than being stranded.
 */
const IN_FLIGHT_TTL_MS = 6 * 60 * 60 * 1000;

/** Keys enqueued within the TTL, as a Set. Expired keys are simply not returned. */
export async function getQuotaBurnInFlight({ now = Date.now() } = {}) {
  const loaded = await readJSONFile(inFlightFile(), null);
  const entries = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
  return new Set(Object.entries(entries)
    .filter(([, at]) => Number.isFinite(Number(at)) && now - Number(at) < IN_FLIGHT_TTL_MS)
    .map(([key]) => key));
}

/** Stamp keys as just-enqueued, dropping any that have aged out of the TTL. */
export async function recordQuotaBurnInFlight(keys, { now = Date.now() } = {}) {
  if (!keys?.length) return;
  return inFlightWriteQueue(async () => {
    const loaded = await readJSONFile(inFlightFile(), null);
    const entries = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
    const next = Object.fromEntries(Object.entries(entries)
      .filter(([, at]) => Number.isFinite(Number(at)) && now - Number(at) < IN_FLIGHT_TTL_MS));
    for (const key of keys) next[key] = now;
    await atomicWrite(inFlightFile(), next);
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
    const next = [{ at: new Date().toISOString(), ...entry }, ...runs].slice(0, RUN_LOG_LIMIT);
    await atomicWrite(runLogFile(), { runs: next });
    return next;
  });
}
