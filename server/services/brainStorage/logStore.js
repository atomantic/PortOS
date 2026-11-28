/** Brain settings and append-only digest and review logs. */
import { readFile, open } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, safeJSONParse, PATHS } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { assertNotRealDataWrite } from '../../lib/testDataIsolation.js';
import { brainEvents, generateId, now } from './recordStore.js';

const DATA_DIR = PATHS.brain;

// Non-collection files: the single settings doc and the append-only JSONL logs.
const FILES = {
  meta: join(DATA_DIR, 'meta.json'),
  digests: join(DATA_DIR, 'digests.jsonl'),
  reviews: join(DATA_DIR, 'reviews.jsonl'),
};

// In-memory caches — only for the non-collection files. Entity stores read
// through to disk (per issue #725: no whole-store cache to go stale when a
// per-record write bypasses it).
const caches = {
  meta: { data: null, timestamp: 0 },
  digests: { data: null, timestamp: 0 },
  reviews: { data: null, timestamp: 0 },
};

const CACHE_TTL_MS = 2000;
// meta.json is one shared settings document, so serialize the complete
// read/merge/write cycle rather than only its final atomic write.
const queueLogWrite = createFileWriteQueue();
export const withLiveLogRestore = queueLogWrite;

// Default settings
const DEFAULT_META = {
  version: 1,
  confidenceThreshold: 0.6,
  dailyDigestTime: '00:00',
  weeklyReviewTime: '00:00',
  weeklyReviewDay: 'sunday',
  defaultProvider: 'lmstudio',
  defaultModel: 'gptoss-20b',
  // Opt-in: digests/reviews call an AI provider, so nothing runs until enabled.
  scheduledReviewsEnabled: false,
  lastDailyDigest: null,
  lastWeeklyReview: null
};

/**
 * Ensure brain data directory exists
 */
export async function ensureBrainDir() {
  await ensureDir(DATA_DIR, { mode: 0o700 });
}

// =============================================================================
// META / SETTINGS
// =============================================================================

/**
 * Load brain settings
 */
export async function loadMeta() {
  const cache = caches.meta;
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  await ensureBrainDir();

  // Strict (#4115): `updateMeta` is `loadMeta → spread updates → saveMeta`, so a
  // swallowed unreadable meta.json writes DEFAULT_META over every brain setting
  // on the next update — and the result is cached for CACHE_TTL_MS, so the fake
  // default outlives the read that produced it.
  const loaded = await readJSONFile(FILES.meta, null, { strict: true });
  cache.data = loaded ? { ...DEFAULT_META, ...loaded } : { ...DEFAULT_META };
  cache.timestamp = Date.now();
  return cache.data;
}

/**
 * Save brain settings
 */
export const saveMeta = meta => queueLogWrite(() => persistMeta(meta));

async function persistMeta(meta) {
  await ensureBrainDir();
  await atomicWrite(FILES.meta, meta, { mode: 0o600, dirMode: 0o700 });
  caches.meta = { data: meta, timestamp: Date.now() };
  brainEvents.emit('meta:changed', meta);
}

/**
 * Update brain settings (partial update)
 */
export const updateMeta = updates => queueLogWrite(() => patchMeta(updates));

async function patchMeta(updates) {
  caches.meta = { data: null, timestamp: 0 };
  const updated = { ...(await loadMeta()), ...updates };
  await persistMeta(updated);
  return updated;
}

// =============================================================================
// JSONL APPEND LOGS (digests, reviews)
// =============================================================================

/**
 * Load all records from a JSONL file
 */
async function loadJsonlStore(type) {
  const cache = caches[type];
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  await ensureBrainDir();
  const filePath = FILES[type];

  if (!existsSync(filePath)) {
    cache.data = [];
    cache.timestamp = Date.now();
    return cache.data;
  }

  const content = await readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  cache.data = lines.map(line => safeJSONParse(line, null)).filter(item => item !== null);
  cache.timestamp = Date.now();
  return cache.data;
}

/**
 * Append a record to a JSONL file
 */
async function appendJsonl(type, record) {
  await ensureBrainDir();
  const line = JSON.stringify(record) + '\n';
  assertNotRealDataWrite(FILES[type], 'append Brain log');
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0);
  const file = await open(FILES[type], flags, 0o600);
  try {
    // Restrict legacy logs on the same descriptor before appending new data.
    if (process.platform !== 'win32') await file.chmod(0o600);
    await file.appendFile(line);
  } finally {
    await file.close();
  }

  // Invalidate cache so next read gets fresh data
  caches[type] = { data: null, timestamp: 0 };

  brainEvents.emit(`${type}:added`, record);
}

// =============================================================================
// DIGEST OPERATIONS
// =============================================================================

/**
 * Get all digests
 */
export async function getDigests(limit = 10) {
  let records = await loadJsonlStore('digests');
  records = records.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  return limit === Infinity ? records : records.slice(0, limit);
}

/**
 * Get latest digest
 */
export async function getLatestDigest() {
  const digests = await getDigests(1);
  return digests[0] || null;
}

/**
 * Create digest entry
 */
export async function createDigest(digest) {
  const record = {
    id: generateId(),
    ...digest,
    generatedAt: now()
  };

  await queueLogWrite(async () => {
    await appendJsonl('digests', record);
    await patchMeta({ lastDailyDigest: record.generatedAt });
  });

  console.log(`🧠 Created daily digest: ${record.id}`);
  return record;
}

// =============================================================================
// REVIEW OPERATIONS
// =============================================================================

/**
 * Get all reviews
 */
export async function getReviews(limit = 10) {
  let records = await loadJsonlStore('reviews');
  records = records.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  return limit === Infinity ? records : records.slice(0, limit);
}

/**
 * Get latest review
 */
export async function getLatestReview() {
  const reviews = await getReviews(1);
  return reviews[0] || null;
}

/**
 * Create review entry
 */
export async function createReview(review) {
  const record = {
    id: generateId(),
    ...review,
    generatedAt: now()
  };

  await queueLogWrite(async () => {
    await appendJsonl('reviews', record);
    await patchMeta({ lastWeeklyReview: record.generatedAt });
  });

  console.log(`🧠 Created weekly review: ${record.id}`);
  return record;
}

export function clearLogCaches() {
  for (const key of Object.keys(caches)) {
    caches[key] = { data: null, timestamp: 0 };
  }
}
