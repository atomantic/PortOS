/**
 * POST Drill Cache — Pre-generates wordplay drills so users don't wait.
 *
 * On startup, fills cache to MIN_PER_TYPE. When a drill is consumed,
 * background replenishment kicks in. Cache persists to disk.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { generateLlmDrill } from './meatspacePostLlm.js';

const CACHE_FILE = join(PATHS.data, 'meatspace', 'post-drill-cache.json');
const MIN_PER_TYPE = 3;
const MAX_PER_TYPE = 10;

// Only cache LLM-generated drill types used in wordplay training
const CACHEABLE_TYPES = [
  'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist',
];

const delay = ms => new Promise(r => setTimeout(r, ms));

let cache = {}; // { type: [drill, drill, ...] }
let replenishing = new Map(); // type -> Promise (in-flight replenishment)
let saveQueued = false;

async function loadCache() {
  const raw = await readFile(CACHE_FILE, 'utf-8').catch(() => '{}');
  cache = safeJSONParse(raw, {});
  for (const type of CACHEABLE_TYPES) {
    if (!Array.isArray(cache[type])) cache[type] = [];
  }
}

async function saveCache() {
  await ensureDir(PATHS.meatspace);
  await atomicWrite(CACHE_FILE, cache);
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

/**
 * Trigger background replenishment after consuming a drill.
 */
export function triggerReplenish(type, providerId, model) {
  if (!CACHEABLE_TYPES.includes(type)) return;
  replenishType(type, providerId, model);
  debouncedSave();
}

/**
 * Get cache stats for debugging/status.
 */
export function getCacheStats() {
  const stats = {};
  for (const type of CACHEABLE_TYPES) {
    stats[type] = cache[type]?.length || 0;
  }
  return stats;
}

/**
 * Initialize cache: load from disk, start sequential background fill for low types.
 */
export async function initDrillCache(providerId, model) {
  await loadCache();
  const stats = CACHEABLE_TYPES.map(t => `${t}:${cache[t]?.length || 0}`).join(' ');
  console.log(`📦 POST drill cache loaded: ${stats}`);

  // Fill types sequentially (not in parallel) to avoid LLM API spam on startup
  const lowTypes = CACHEABLE_TYPES.filter(t => (cache[t]?.length || 0) < MIN_PER_TYPE);
  if (lowTypes.length > 0) {
    console.log(`📦 POST cache: queuing startup fill for ${lowTypes.length} types`);
    (async () => {
      for (const type of lowTypes) {
        await replenishType(type, providerId, model);
      }
    })().catch(err => console.error(`❌ POST drill cache startup fill failed: ${err.message}`));
  }
}
