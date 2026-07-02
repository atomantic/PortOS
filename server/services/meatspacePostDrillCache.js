/**
 * POST Drill Cache — Pre-generates wordplay drills so users don't wait.
 *
 * On startup, only the on-disk cache is loaded — no LLM calls. A cold cache
 * (0 cached) only fills via requestCacheFill(), which requires explicit user
 * consent (see meatspacePostRoutes.js). Once a type has been warmed at least
 * once, consuming a drill silently tops it back up in the background. Cache
 * persists to disk. See "AI Provider Usage Policy" in CLAUDE.md.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { generateLlmDrill } from './meatspacePostLlm.js';

const CACHE_FILE = join(PATHS.data, 'meatspace', 'post-drill-cache.json');
const MIN_PER_TYPE = 3;
const MAX_PER_TYPE = 10;

// Only cache LLM-generated drill types used in wordplay training
export const CACHEABLE_TYPES = [
  'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist',
];

const delay = ms => new Promise(r => setTimeout(r, ms));

let cache = {}; // { type: [drill, drill, ...] }
let replenishing = new Map(); // type -> Promise (in-flight replenishment)
let saveQueued = false;
// Tracks which types have ever been successfully filled. "Cold" must be
// derived from this, NOT from the live cache count — a type that drains to
// 0 between consumption and replenishment (e.g. the user consumes faster
// than the background top-up produces new items) would otherwise look
// "never primed" again and permanently stop replenishing (see
// meatspacePostDrillCache.test.js "stays warm after draining to zero").
const primedTypes = new Set();

// Pre-existing on-disk cache files (before primedTypes existed) store the
// per-type drill arrays directly at the top level: { [type]: [...] }. Newer
// files nest them under `drills` alongside a persisted `primedTypes` list, so
// "primed" survives a restart that happens to land while a type is fully
// drained (debouncedSave fires on every consumption, so 0-length is a
// legitimate on-disk snapshot mid-drain — without persisting the flag, that
// restart would re-classify an already-warmed type as cold, reproducing the
// same permanent-replenish-stall bug this file's primedTypes fix targets,
// just gated behind a restart instead of an in-process drain).
function isNestedCacheShape(parsed) {
  return !!(parsed && typeof parsed === 'object' && parsed.drills && typeof parsed.drills === 'object' && !Array.isArray(parsed.drills));
}

async function loadCache() {
  const raw = await readFile(CACHE_FILE, 'utf-8').catch(() => '{}');
  const parsed = safeJSONParse(raw, {});
  const nested = isNestedCacheShape(parsed);
  cache = nested ? parsed.drills : parsed;
  if (nested && Array.isArray(parsed.primedTypes)) {
    for (const type of parsed.primedTypes) {
      if (CACHEABLE_TYPES.includes(type)) primedTypes.add(type);
    }
  }
  for (const type of CACHEABLE_TYPES) {
    if (!Array.isArray(cache[type])) cache[type] = [];
    // Also infer from non-empty arrays — covers pre-migration flat-shape
    // files (no primedTypes key) and defensively covers any type a stale
    // persisted primedTypes list somehow missed.
    if (cache[type].length > 0) primedTypes.add(type);
  }
}

async function saveCache() {
  await ensureDir(PATHS.meatspace);
  await atomicWrite(CACHE_FILE, { drills: cache, primedTypes: [...primedTypes] });
}

function debouncedSave() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    await saveCache().catch(() => {});
  }, 500);
}

function replenishType(type, providerId, model) {
  if (replenishing.has(type)) return replenishing.get(type);
  if ((cache[type]?.length || 0) >= MIN_PER_TYPE) return Promise.resolve();

  const needed = MAX_PER_TYPE - (cache[type]?.length || 0);

  const promise = (async () => {
    let generated = 0;
    let consecutiveFailures = 0;
    try {
      for (let i = 0; i < needed; i++) {
        if (i > 0) await delay(2000); // avoid LLM rate limits
        const drill = await generateLlmDrill(type, { count: 5 }, providerId, model).catch(err => {
          console.log(`⚠️ POST cache: failed to generate ${type}: ${err.message}`);
          return null;
        });
        if (drill) {
          cache[type].push(drill);
          primedTypes.add(type);
          generated++;
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          if (consecutiveFailures >= 2) {
            console.log(`⚠️ POST cache: bailing on ${type} after ${consecutiveFailures} consecutive failures`);
            break;
          }
        }
      }
      if (generated > 0) {
        await saveCache();
        console.log(`📦 POST cache: added ${generated} ${type} drills (total: ${cache[type].length})`);
      }
    } finally {
      replenishing.delete(type);
    }
  })();

  replenishing.set(type, promise);
  return promise;
}

/**
 * Pull a cached drill for the given type. Returns null if cache is empty.
 */
export function getCachedDrill(type) {
  if (!CACHEABLE_TYPES.includes(type)) return null;
  const drills = cache[type];
  if (!drills?.length) return null;
  const result = drills.shift();
  debouncedSave();
  return result;
}

// A type is "cold" until it has been successfully filled at least once —
// tracked via primedTypes, not the live cache count (see the primedTypes
// comment above for why). This is the one place that defines cold vs. warm —
// triggerReplenish and getCacheStats both read it, so a future change can't
// drift between the background-replenish guard and what the client is told.
function isCacheCold(type) {
  return !primedTypes.has(type);
}

/**
 * Trigger background replenishment after consuming a drill. Only tops up a
 * type that already has at least one cached drill — it does NOT perform the
 * initial cold fill. Cold fill only happens via requestCacheFill(), which
 * requires explicit user consent (see meatspacePostRoutes.js). Without this
 * guard, the very first cache-miss after a fresh install would silently
 * kick off a MAX_PER_TYPE-sized batch of LLM calls with no user awareness.
 */
export function triggerReplenish(type, providerId, model) {
  if (!CACHEABLE_TYPES.includes(type)) return;
  if (isCacheCold(type)) return;
  // Fire-and-forget, but guard the returned promise like requestCacheFill does —
  // replenishType's inner saveCache() can reject on a disk-write failure, which
  // would otherwise surface as an unhandled rejection.
  replenishType(type, providerId, model).catch(err => console.error(`❌ POST cache: triggerReplenish failed: ${err.message}`));
  debouncedSave();
}

/**
 * Get cache stats for the drill-cache/status route: per-type count plus the
 * same cold/warm classification triggerReplenish uses, so the client doesn't
 * have to re-derive "cold" from a raw count.
 */
export function getCacheStats() {
  const stats = {};
  for (const type of CACHEABLE_TYPES) {
    stats[type] = { count: cache[type]?.length || 0, cold: isCacheCold(type) };
  }
  return stats;
}

/**
 * Explicitly requested cache fill — the only path allowed to perform a cold
 * fill (0 -> MAX_PER_TYPE). Called from the drill-cache/fill route after the
 * user has been prompted and picked a provider/model. See PortOS's
 * no-cold-bootstrap-LLM-calls rule in CLAUDE.md.
 *
 * Types are filled sequentially, not in parallel — a single consented "fill
 * all" request must not turn into several concurrent LLM batches hammering
 * the provider at once (the old startup fill had this same rule; consent
 * gating the request doesn't excuse spamming a slow/TUI provider once it's
 * granted). Fire-and-forget from the caller's perspective: the requested
 * type list is returned immediately, the fills run in the background.
 */
export function requestCacheFill(types, providerId, model) {
  const requested = (types?.length ? types : CACHEABLE_TYPES).filter(t => CACHEABLE_TYPES.includes(t));
  (async () => {
    for (const type of requested) {
      await replenishType(type, providerId, model);
    }
  })().catch(err => console.error(`❌ POST cache: requestCacheFill failed: ${err.message}`));
  return requested;
}

/**
 * Load the on-disk cache into memory at boot. Does NOT perform any LLM
 * calls or start background fills — a fresh install boots with an empty
 * cache and stays that way until the user opts in via requestCacheFill().
 */
export async function initDrillCache() {
  await loadCache();
  const stats = CACHEABLE_TYPES.map(t => `${t}:${cache[t]?.length || 0}`).join(' ');
  console.log(`📦 POST drill cache loaded: ${stats}`);
}
