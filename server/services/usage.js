/**
 * AI usage ledger: per-provider/model counters, cost estimates and native-usage overlays.
 * 
 * Storage: `db-primary` — machine-local; federates only as an aggregate digest via
 * the `usage` snapshot category, never merged back. A legacy `interactiveScan` object from the retired
 * scanner may remain. The legacy JSON is imported, or used directly in file-only tests.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'path';
import { clearTimeout as cancelBatchTimer, setTimeout as scheduleBatchTimer } from 'node:timers';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { isFreeProvider, SPEED_LEDGER_FIELDS } from '../lib/modelPricing.js';
import { familyForProvider } from '../lib/provider/providerFamilies.js';
import { POLLUTING_KEYS } from '../lib/objects.js';
import { UNKNOWN_PROVIDER_ID, UNKNOWN_PROVIDER_NAME, isUsageKey, usageModelKey, normalizeProvider, countFields, hasUsageCounts, mergeSource, buildUsageReport } from '../lib/usageReport.js';
import { nativeUsageSignature, withNativeUsage } from './nativeUsageHistory.js';
import { getLocalParts, todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import { bumpChangeToken } from './changeToken.js';

const DATA_DIR = PATHS.data;
export const USAGE_FILE = join(DATA_DIR, 'usage.json');

// Day buckets older than this are rolled up into monthly buckets at load time so
// dailyActivity (and therefore the in-memory report) stops growing
// linearly forever. 400 days keeps a full year-plus of per-day granularity — beyond
// any useful streak/report window — while collapsing everything older to per-month.
const ROLLUP_RETENTION_DAYS = 400;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const SUMMARY_CACHE_LIMIT = 20;
const RUN_WRITE_BATCH_MS = 50;

let usageData = null;
let committedUsage = null;
let grokRepairIndex = new Set();
let addedRepairIds;
let ownedRunDraftObjects;
let draftMarkerBase;
let pendingRunBatch = null;
const activeRunBatches = new Set();
const queueUsageWrite = createFileWriteQueue();
const usesUsageDatabase = () => isTestRunner()
  ? process.env.MEMORY_BACKEND === 'postgres'
  : process.env.MEMORY_BACKEND !== 'file';
const usageDatabase = () => import('./usageLedgerDb.js');

// Readers continue seeing committed state while a private draft is being
// persisted, including when a historical correction yields to the event loop.
async function transactUsage(fn, { copyOnWrite = false } = {}) {
  const previous = usageData;
  const previousCommitted = committedUsage;
  const previousRepairIndex = grokRepairIndex;
  addedRepairIds = [];
  draftMarkerBase = {};
  ownedRunDraftObjects = copyOnWrite ? new WeakSet() : null;
  if (usesUsageDatabase()) grokRepairIndex = new Set(previous?.grokRepairIds);
  try {
    usageData = previous && (copyOnWrite ? { ...previous } : structuredClone(previous));
    return await fn();
  } catch (error) {
    if (committedUsage !== previousCommitted) {
      // A reload can publish a new base before a subsequent correction fails.
      usageData = committedUsage;
      grokRepairIndex = new Set(committedUsage.grokRepairIds);
    } else {
      usageData = previous;
      if (grokRepairIndex === previousRepairIndex) {
        for (const id of addedRepairIds) grokRepairIndex.delete(id);
      }
      grokRepairIndex = previousRepairIndex;
    }
    throw error;
  } finally {
    if (usesUsageDatabase() && usageData) {
      delete usageData.reconciledRuns;
      delete usageData.siblingReconciledRuns;
      grokRepairIndex = new Set();
    }
    addedRepairIds = undefined;
    ownedRunDraftObjects = undefined;
    draftMarkerBase = undefined;
  }
}

// Shallow-copy only containers on paths that a live write touches. Historical
// edits still own a whole private draft, so they reuse the same bucket writers.
function mutableUsageChild(parent, key, makeEmpty = () => ({})) {
  const existing = Object.hasOwn(parent, key) ? parent[key] : undefined;
  if (existing && (!ownedRunDraftObjects || ownedRunDraftObjects.has(existing))) return existing;
  const copy = !existing ? makeEmpty() : Array.isArray(existing) ? [...existing] : { ...existing };
  parent[key] = copy;
  ownedRunDraftObjects?.add(copy);
  return copy;
}

function closeRunBatch() {
  if (!pendingRunBatch) return;
  const { timer, ready } = pendingRunBatch;
  pendingRunBatch = null;
  cancelBatchTimer(timer);
  ready();
}

function queueRunWrite(apply, args) {
  if (!pendingRunBatch) {
    const actions = [];
    const gate = Promise.withResolvers();
    // Reserve the queue position on the first call, so an intervening reset
    // or historical edit can't overtake these writes.
    const saved = queueUsageWrite(async () => {
      await gate.promise;
      if (!usageData) await transactUsage(() => loadUsageDraft({ mutableDraft: false }));
      await refreshDayKeyTimezone();
      return transactUsage(async () => {
        const results = [];
        let changed = false;
        for (const run of actions) {
          const result = run();
          results.push(result);
          changed ||= result !== undefined;
        }
        if (changed) await saveUsage();
        return results;
      }, { copyOnWrite: true });
    });
    activeRunBatches.add(saved);
    const settled = () => activeRunBatches.delete(saved);
    saved.then(settled, settled);
    pendingRunBatch = { actions, saved, ready: gate.resolve, timer: scheduleBatchTimer(closeRunBatch, RUN_WRITE_BATCH_MS) };
  }
  const { actions, saved } = pendingRunBatch;
  const index = actions.push(() => apply(...args)) - 1;
  return saved.then(results => results[index]);
}

// Wait for all admitted run writes before taking a backup cut or exiting.
// An awaited run write always settles only after the shared durable save.
export async function flushPendingUsageWrites() {
  closeRunBatch();
  // Queue a barrier as well as checking the live batches' outcomes. A backup
  // or shutdown must also wait for a maintenance edit already in the queue.
  const outcomes = await Promise.allSettled([...activeRunBatches, queueUsageWrite(() => undefined)]);
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) throw failure.reason;
}

// All ledger writers share one queue and roll back the in-memory copy on failure.
function mutateUsage(draft, args) {
  closeRunBatch();
  return queueUsageWrite(() => transactUsage(() => draft(...args)));
}
const summaryCache = new Map();
const normalizeUndefinedProviderBucket = (byProvider) => {
  if (!byProvider || typeof byProvider !== 'object' || !Object.hasOwn(byProvider, 'undefined')) {
    return false;
  }
  const stale = byProvider.undefined || {};
  const current = byProvider[UNKNOWN_PROVIDER_ID] || {};
  const merged = {};
  deepSumInto(merged, stale);
  deepSumInto(merged, current);
  byProvider[UNKNOWN_PROVIDER_ID] = { ...merged, name: UNKNOWN_PROVIDER_NAME };
  delete byProvider.undefined;
  return true;
};

/**
 * Initialize usage data structure
 */
function getEmptyUsage() {
  return {
    totalSessions: 0,
    totalMessages: 0,
    totalToolCalls: 0,
    totalTokens: {
      input: 0,
      output: 0
    },
    byProvider: {},
    byModel: {},
    dailyActivity: {},
    monthlyActivity: {},
    earliestActivityDay: null,
    hourlyActivity: Array(24).fill(0),
    // Observed provider limit blocks (`recordLimitBlock`): timestamped
    // `{ providerId, model, category, message, resetHint, at }` facts the
    // Usage page's free-tier section reads as an estimated-quota signal.
    // Additive: absent on installs that predate it, seeded on load.
    blockEvents: [],
    // Ids of Grok repairs and live media/long-context records already added.
    // Local bookkeeping, like reconciledRuns: not part of the peer digest.
    grokRepairIds: [],
    lastUpdated: null
  };
}

/**
 * Deep-sum a source bucket into a target bucket, in place. Numbers add; nested
 * objects recurse. Shape-tolerant on purpose: a day bucket may be the flat
 * `{ sessions, messages, tokens }` shape, or carry nested per-provider/per-model
 * token splits — either way its per-provider/per-model detail is preserved when
 * rolled up to monthly granularity.
 */
function deepSumInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (typeof value === 'number') {
      target[key] = (typeof target[key] === 'number' ? target[key] : 0) + value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepSumInto(target[key], value);
    }
    // Non-numeric scalars (strings like provider `name`) are intentionally dropped:
    // a monthly rollup aggregates counts, not labels.
  }
  return target;
}

/**
 * Pure, idempotent load-time transform: move day buckets older than `retentionDays`
 * out of `dailyActivity` and into `monthlyActivity['YYYY-MM']`, deep-summing their
 * (possibly nested) numeric fields so long-range totals stay accurate at monthly
 * granularity. Mutates the passed maps in place and returns whether anything moved.
 * Only well-formed YYYY-MM-DD keys are considered, so an already-rolled monthly key
 * is never re-processed (guaranteeing idempotency).
 */
export function rollupOldDailyActivity(dailyActivity, monthlyActivity, { retentionDays = ROLLUP_RETENTION_DAYS, now = new Date() } = {}) {
  if (!dailyActivity || !monthlyActivity) return false;

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffKey = cutoff.toISOString().split('T')[0];

  let changed = false;
  for (const dayKey of Object.keys(dailyActivity)) {
    if (!DAY_KEY_RE.test(dayKey)) continue;
    if (dayKey >= cutoffKey) continue; // lexical compare is date-correct for YYYY-MM-DD

    const monthKey = dayKey.slice(0, 7); // 'YYYY-MM'
    if (!monthlyActivity[monthKey]) monthlyActivity[monthKey] = {};
    deepSumInto(monthlyActivity[monthKey], dailyActivity[dayKey]);
    delete dailyActivity[dayKey];
    changed = true;
  }
  return changed;
}

const findEarliestActivityDay = (dailyActivity, monthlyActivity) => {
  let earliest = null;
  const consider = (day) => {
    if (!earliest || day < earliest) earliest = day;
  };
  for (const key of Object.keys(dailyActivity || {})) {
    if (DAY_KEY_RE.test(key)) consider(key);
  }
  for (const key of Object.keys(monthlyActivity || {})) {
    if (MONTH_KEY_RE.test(key)) consider(`${key}-01`);
  }
  return earliest;
};

const cacheActivityDay = (day) => {
  if (!DAY_KEY_RE.test(day)) return;
  if (!usageData.earliestActivityDay || day < usageData.earliestActivityDay) {
    usageData.earliestActivityDay = day;
  }
};

// Both live attribution and historical speed repair merge Codex counters by
// per-identity maxima. Visit later markers first so discarding a covered claim
// preserves the same boundary for every live `since` query and for all-time
// repair. Keep exact identities (including legacy paths), undated evidence, and
// the run marker itself: a claim can be redundant while its run is still billed.
function compactCodexHighWater(reconciledRuns) {
  const markers = Object.entries(reconciledRuns || {})
    .filter(([, marker]) => Array.isArray(marker?.codexHighWater) && marker.codexHighWater.length)
    .map(([runId, marker]) => ({ runId, marker, at: Date.parse(marker.at) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => b.at - a.at);

  const laterCounters = new Map();
  let changed = false;
  for (const { runId, marker } of markers) {
    const retained = marker.codexHighWater.filter((entry) => {
      if (!Array.isArray(entry)) return true;
      const [key, counters] = entry;
      if (typeof key !== 'string' || !counters || typeof counters !== 'object' || Array.isArray(counters)) return true;
      const fields = Object.entries(counters);
      if (!fields.length || fields.some(([, count]) => !Number.isFinite(count) || count < 0)) return true;
      const later = laterCounters.get(key);
      if (later && fields.every(([field, count]) => (later.get(field) ?? 0) >= count)) return false;

      const boundary = later ?? new Map();
      for (const [field, count] of fields) boundary.set(field, Math.max(boundary.get(field) ?? 0, count));
      laterCounters.set(key, boundary);
      return true;
    });
    if (retained.length === marker.codexHighWater.length) continue;
    const { at, codexHighWater, ...extra } = marker;
    reconciledRuns[runId] = retained.length || Object.keys(extra).length
      ? { ...marker, codexHighWater: retained }
      : at;
    changed = true;
  }
  return changed;
}

/**
 * Load usage data from disk
 */
async function loadUsageDraft({ mutableDraft = true } = {}) {
  await ensureDir(DATA_DIR);
  summaryCache.clear();

  // STRICT (#4115): the `!usageData` branch below does not just report an empty
  // total — it atomically OVERWRITES usage.json with zeros on the same tick. A
  // swallowed EACCES/EIO would therefore erase every historical session, cost,
  // and rollup bucket permanently. Only a genuinely ABSENT file is a real fresh
  // install; a present-but-unreadable one now throws before reaching the write
  // (the module-load bootstrap at the bottom of this file already logs it).
  const database = usesUsageDatabase() ? await usageDatabase() : null;
  if (database) {
    const { ensureSchema, withTransaction } = await import('../lib/db.js');
    await ensureSchema();
    usageData = await database.readUsageLedger();
    if (!usageData) {
      await withTransaction((client) => database.importLegacyUsageLedger(client, USAGE_FILE));
      usageData = await database.readUsageLedger();
    }
  } else {
    usageData = await readJSONFile(USAGE_FILE, null, { strict: true });
  }
  const stored = database && usageData ? structuredClone(usageData) : null;
  const missing = !usageData;
  if (missing) usageData = getEmptyUsage();

  // Backfill maps for installs whose usage.json predates the rollup, then collapse
  // old day buckets so the hot-path file stops growing per-day.
  if (!usageData.dailyActivity || typeof usageData.dailyActivity !== 'object') {
    usageData.dailyActivity = {};
  }
  if (!usageData.monthlyActivity || typeof usageData.monthlyActivity !== 'object') {
    usageData.monthlyActivity = {};
  }
  let normalizedProviders = normalizeUndefinedProviderBucket(usageData.byProvider);
  for (const bucket of Object.values(usageData.dailyActivity)) {
    normalizedProviders = normalizeUndefinedProviderBucket(bucket?.byProvider) || normalizedProviders;
  }
  for (const bucket of Object.values(usageData.monthlyActivity)) {
    normalizedProviders = normalizeUndefinedProviderBucket(bucket?.byProvider) || normalizedProviders;
  }
  const rolledUp = rollupOldDailyActivity(usageData.dailyActivity, usageData.monthlyActivity);
  const earliestActivityDay = findEarliestActivityDay(usageData.dailyActivity, usageData.monthlyActivity);
  const earliestChanged = usageData.earliestActivityDay !== earliestActivityDay;
  usageData.earliestActivityDay = earliestActivityDay;
  // Additive: installs that predate limit-block tracking read as "no blocks
  // observed" without a migration pass.
  let normalizedBlocks = false;
  if (!Array.isArray(usageData.blockEvents)) {
    usageData.blockEvents = [];
    normalizedBlocks = true;
  }
  // In memory only until the next real save. Forcing a write here would
  // rewrite every install's usage.json just to add an empty id list.
  if (!Array.isArray(usageData.grokRepairIds)) usageData.grokRepairIds = [];
  grokRepairIndex = new Set(usageData.grokRepairIds);
  const compacted = !database && compactCodexHighWater(usageData.reconciledRuns);
  const activityChanged = missing || rolledUp || normalizedProviders || earliestChanged || normalizedBlocks;
  if (activityChanged || compacted) {
    if (normalizedProviders) console.log('📊 Normalized undefined usage providers to unknown');
    if (rolledUp) console.log(`📊 Rolled up old daily usage into ${Object.keys(usageData.monthlyActivity).length} monthly buckets`);
    await saveUsage({ advanceRevision: activityChanged, previous: stored });
  }

  console.log(`📊 Loaded usage: ${usageData.totalSessions} sessions, ${usageData.totalMessages} messages`);
  if (database) delete usageData.grokRepairIds;
  committedUsage = usageData;
  if (mutableDraft) usageData = structuredClone(committedUsage);
  return committedUsage;
}

/**
 * Save usage data to disk
 */
async function saveUsage({ advanceRevision = true, previous = committedUsage, reset = false } = {}) {
  if (advanceRevision) {
    const previous = Date.parse(usageData.lastUpdated);
    usageData.lastUpdated = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
  }
  if (usesUsageDatabase()) {
    const database = await usageDatabase();
    await database.writeUsageLedger(previous, usageData, { markers: draftMarkerBase, reset, copyOnWrite: Boolean(ownedRunDraftObjects) });
    delete usageData.reconciledRuns;
    delete usageData.siblingReconciledRuns;
    delete usageData.grokRepairIds;
    grokRepairIndex.clear();
  } else {
    await atomicWrite(USAGE_FILE, JSON.stringify(usageData));
  }
  committedUsage = usageData;
  if (addedRepairIds) addedRepairIds.length = 0;
  summaryCache.clear();
  if (advanceRevision) bumpChangeToken('usage');
}

/**
 * Get current usage stats
 */
export function getUsage() {
  return committedUsage || getEmptyUsage();
}

/** Read repair evidence for the active install or a portable file-only backup. */
export async function readUsageRepairLedger(dataDir) {
  if (usesUsageDatabase() && resolve(dataDir) === resolve(DATA_DIR)) {
    const ledger = await (await usageDatabase()).readUsageLedgerExport();
    if (ledger) return ledger;
  }
  return readJSONFile(join(dataDir, 'usage.json'), {}, { strict: true });
}

/** Save a portable pre-repair copy of counters and their matching markers. */
export async function backupUsageRepairLedger(dataDir, label, { includeWatermark = false } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(dataDir, 'backups', `${label}-${stamp}`);
  await mkdir(dest, { recursive: true });
  const ledger = await readUsageRepairLedger(dataDir);
  await atomicWrite(join(dest, 'usage.json'), JSON.stringify(ledger));
  if (includeWatermark) {
    await copyFile(join(dataDir, 'usage-interactive-scan.json'), join(dest, 'usage-interactive-scan.json')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return dest;
}

async function loadDraftRunMarkers(ids) {
  if (!usesUsageDatabase() || ids.length === 0) return;
  const database = await usageDatabase();
  for (const kind of ['reconciledRuns', 'siblingReconciledRuns']) {
    const rows = await database.readUsageMarkers(kind, { ids });
    const markers = Object.fromEntries(rows.map(({ id, value }) => [id, value]));
    draftMarkerBase[kind] = markers;
    usageData[kind] = { ...markers };
  }
}

async function loadDraftRepairIds(ids) {
  if (!usesUsageDatabase() || ids.length === 0) return;
  const rows = await (await usageDatabase()).readUsageMarkers('grokRepairIds', { ids });
  grokRepairIndex = new Set([...(usageData.grokRepairIds ?? []), ...rows.map(({ id }) => id)]);
}

/**
 * The earliest day usage was recorded (`YYYY-MM-DD`), or null on an install
 * with no history yet. Rolled-up months only know their month, so they
 * contribute their first day — a whole-month bucket's activity cannot have
 * started earlier than that.
 *
 * Consumers: the subscription-savings window, which prorates a monthly plan
 * price over an "All time" report and needs a real start day rather than an
 * unbounded one (see lib/subscriptionSavings.js).
 */
export function getFirstActivityDay() {
  return getUsage().earliestActivityDay ?? null;
}

/**
 * Per-day per-provider per-model bucket inside dailyActivity — the additive
 * shape that makes arbitrary-period cost breakdowns possible. Missing provider
 * ids are attributed to a named `unknown` bucket rather than becoming the
 * JavaScript property string "undefined".
 */
function providerDayBucket(day, providerId, providerName) {
  const provider = normalizeProvider(providerId, providerName);
  const byProvider = mutableUsageChild(day, 'byProvider');
  return mutableUsageChild(byProvider, provider.id, () => ({
    name: provider.name,
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    // Additive prompt-cache tiers are absent on buckets written before #3124.
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    // Mixing transcript measurements and estimates yields `mixed`.
    source: null,
    byModel: {}
  }));
}

function modelDayBucket(providerDay, model) {
  const byModel = mutableUsageChild(providerDay, 'byModel');
  return mutableUsageChild(byModel, model, () => ({
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: null
  }));
}

const zeroCounts = () => Object.fromEntries(countFields.map((field) => [field, 0]));

const recordTotals = (records) => (Array.isArray(records) ? records : [records]).reduce((total, record) => {
  for (const field of countFields) total[field] += Math.max(0, record?.[field] || 0);
  return total;
}, zeroCounts());

const adjustCounts = (bucket, counts, direction) => {
  if (!bucket) return;
  for (const field of countFields) {
    const delta = direction * Math.max(0, counts?.[field] || 0);
    // A zero delta must not stamp a new key onto a pre-existing bucket.
    if (!delta && bucket[field] == null) continue;
    bucket[field] = Math.max(0, (bucket[field] || 0) + delta);
  }
};

/**
 * The estimated share of a bucket's counts, kept beside them as `estimated`.
 * The native usage overlay (lib/nativeUsageOverlay.js) replaces a provider
 * app's measured counts with the app's own history, but an estimate is usage
 * the app recorded nowhere (a `--no-session-persistence` / `--ephemeral`
 * one-shot, a session PortOS could not find), so the report keeps it.
 */
const adjustEstimated = (bucket, counts, direction) => {
  if (!bucket) return;
  adjustCounts(mutableUsageChild(bucket, 'estimated'), counts, direction);
};

function rememberRepairIds(ids) {
  if (!Array.isArray(ids) || !usageData) return;
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 400 || grokRepairIndex.has(id)) continue;
    mutableUsageChild(usageData, 'grokRepairIds', () => []).push(id);
    grokRepairIndex.add(id);
    addedRepairIds.push(id);
  }
}

const BACKFILL_YIELD_INTERVAL = 25;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const rebuildDayTotals = (day) => {
  const providers = Object.values(day.byProvider || {});
  day.sessions = providers.reduce((sum, provider) => sum + (provider.sessions || 0), 0);
  day.messages = providers.reduce((sum, provider) => sum + (provider.messages || 0), 0);
  day.tokensIn = providers.reduce((sum, provider) => sum + (provider.tokensIn || 0), 0);
  day.tokensOut = providers.reduce((sum, provider) => sum + (provider.tokensOut || 0), 0);
  day.tokens = day.tokensOut;
};

/**
 * Run ids whose completion accounting has already landed. Kept with usage.json
 * so a historical pass remains idempotent even when a run's metadata marker
 * could not be written.
 */
export function getReconciledUsageRunIds(ids) {
  if (usesUsageDatabase()) return usageDatabase().then((db) => db.readUsageMarkers('reconciledRuns', { ids })).then((rows) => rows.map(({ id }) => id));
  return Object.keys(committedUsage?.reconciledRuns || {});
}

/** Exact observed Codex boundaries from nearby durable completions; legacy markers carry none. */
export async function getRecentCodexUsageClaims(since) {
  if (!committedUsage) await loadUsage();
  if (usesUsageDatabase()) {
    if (!Number.isFinite(since)) return [];
    const rows = await (await usageDatabase()).readUsageMarkers('reconciledRuns', { since: Math.ceil(since), claimsOnly: true });
    return rows.flatMap(({ value }) => value.codexHighWater);
  }
  return Object.values(committedUsage.reconciledRuns || {})
    .filter((marker) => Array.isArray(marker?.codexHighWater) && Date.parse(marker.at) >= since)
    .flatMap((marker) => structuredClone(marker.codexHighWater));
}

/**
 * Drop sibling markers that only guarded a single apply — the interactive scan's
 * synthetic ids, which its own watermark makes redundant once the batch lands.
 * Left in place they would grow `usage.json` by a key per family per day per scan.
 */
async function forgetSiblingReconciledUsageRunsDraft(runIds = []) {
  if (usageData) await loadDraftRunMarkers(runIds);
  if (!usageData?.siblingReconciledRuns) return;
  let dropped = 0;
  for (const runId of runIds) {
    if (delete usageData.siblingReconciledRuns[runId]) dropped++;
  }
  if (dropped > 0) await saveUsage();
}

/**
 * Run ids whose NESTED-session (sibling-family) attribution has already landed.
 * A separate marker from `reconciledRuns` on purpose: the sibling pass has to be
 * able to run on a run whose own transcript was reconciled long ago (#5831).
 */
export function getSiblingReconciledUsageRunIds(ids) {
  if (usesUsageDatabase()) return usageDatabase().then((db) => db.readUsageMarkers('siblingReconciledRuns', { ids })).then((rows) => rows.map(({ id }) => id));
  return Object.keys(committedUsage?.siblingReconciledRuns || {});
}

/**
 * Record that a completed run's accounting landed. `siblings` also marks its
 * nested-session pass, which the live path runs whenever it has a provider list —
 * without that marker a later backfill would bill those nested sessions again.
 */
async function markUsageRunReconciledDraft(runId, { siblings = false } = {}) {
  if (!runId) return;
  if (!usageData) await loadUsageDraft();
  await loadDraftRunMarkers([runId]);
  if (setReconciledMarkers(runId, siblings)) await saveUsage();
}

/** In-memory half of {@link markUsageRunReconciled}; true when a marker was added. */
function setReconciledMarkers(runId, siblings) {
  usageData.reconciledRuns ??= {};
  usageData.siblingReconciledRuns ??= {};
  const now = new Date().toISOString();
  let changed = false;
  if (!usageData.reconciledRuns[runId]) {
    mutableUsageChild(usageData, 'reconciledRuns')[runId] = now;
    changed = true;
  }
  if (siblings && !usageData.siblingReconciledRuns[runId]) {
    mutableUsageChild(usageData, 'siblingReconciledRuns')[runId] = now;
    changed = true;
  }
  return changed;
}

/**
 * Add one usage record to its own provider's day bucket and the all-time
 * rollups. `long*` and Imagine units ride the same count fields as tokens.
 * Long-context tokens are NOT added to totalTokens: they are a subset of
 * tokens that were, or will be, counted in the base fields.
 */
function addUsageRecord(day, record) {
  if (!record?.providerId || !isUsageKey(record.providerId)) return;
  const bucket = providerDayBucket(day, record.providerId, record.providerName);
  const hadProviderCounts = hasUsageCounts(bucket);
  adjustCounts(bucket, record, 1);
  if (record.source === 'estimate') adjustEstimated(bucket, record, 1);
  else if (record.nativeUsageUnpersisted) {
    bucket.unpersisted ??= {};
    adjustCounts(bucket.unpersisted, record, 1);
  }
  bucket.source = hadProviderCounts
    ? mergeSource(bucket.source, record.source || 'measured')
    : (record.source || 'measured');
  if (record.model && usageModelKey(record.model)) {
    const target = modelDayBucket(bucket, record.model);
    const hadCounts = hasUsageCounts(target);
    adjustCounts(target, record, 1);
    if (record.source === 'estimate') adjustEstimated(target, record, 1);
    else if (record.nativeUsageUnpersisted) {
      target.unpersisted ??= {};
      adjustCounts(target.unpersisted, record, 1);
    }
    target.source = hadCounts
      ? mergeSource(target.source, record.source || 'measured')
      : (record.source || 'measured');
  }
  usageData.totalMessages = Math.max(0, (usageData.totalMessages || 0) + (record.messages || 0));
  usageData.totalTokens.input = Math.max(0, (usageData.totalTokens.input || 0)
    + (record.tokensIn || 0) + (record.cacheReadTokens || 0) + (record.cacheWriteTokens || 0));
  usageData.totalTokens.output = Math.max(0, (usageData.totalTokens.output || 0) + (record.tokensOut || 0));
  usageData.byProvider[record.providerId] ??= { name: bucket.name, sessions: 0, messages: 0, tokens: 0 };
  usageData.byProvider[record.providerId].messages += record.messages || 0;
  usageData.byProvider[record.providerId].tokens += record.tokensOut || 0;
  if (record.model && usageModelKey(record.model)) {
    usageData.byModel[record.model] ??= { sessions: 0, messages: 0, tokens: 0 };
    usageData.byModel[record.model].messages += record.messages || 0;
    usageData.byModel[record.model].tokens += record.tokensOut || 0;
  }
}

const isParentCorrectionPending = (correction) => Boolean(correction?.measured)
  && !usageData.reconciledRuns[correction.runId]
  && (correction.unrecorded === true || Boolean(usageData.dailyActivity?.[correction.day]?.byProvider?.[correction.providerId]));

const isSiblingCorrectionPending = (correction) => (correction?.siblings?.length > 0)
  && !usageData.siblingReconciledRuns[correction.runId];

// Transcript-derived provider ids and model names index the same plain-object
// maps as live recording, so a correction naming a prototype key is skipped.
const isUsableCorrectionRecord = (record) => !record
  || ((!record.providerId || isUsageKey(record.providerId)) && (!record.model || usageModelKey(record.model) !== null));

function isEligibleCorrection(correction) {
  const { runId, day: dayKey, providerId } = correction || {};
  if (!runId || !dayKey || !providerId) return false;
  if (POLLUTING_KEYS.has(runId) || POLLUTING_KEYS.has(dayKey) || !isUsageKey(providerId)) return false;
  const records = [correction, ...[correction.measured].flat(), ...(correction.siblings || [])];
  if (!records.every(isUsableCorrectionRecord)) return false;
  return isParentCorrectionPending(correction) || isSiblingCorrectionPending(correction);
}

// Snapshots each bucket before the batch touches it and sums the estimates the
// batch removes from it, so `settleCorrectedSources` can tell a bucket whose
// every estimate was replaced (`measured`) from one still holding other runs'
// estimates (`mixed`). Keyed by bucket object: one day/provider/model, one bucket.
function trackEstimateRemoval(scopes, bucket, estimate) {
  if (!scopes.has(bucket)) scopes.set(bucket, { original: recordTotals([bucket]), removed: recordTotals([]) });
  adjustCounts(scopes.get(bucket).removed, estimate, 1);
}

async function collectEstimateScopes(eligible) {
  const scopes = new Map();
  for (const [index, correction] of eligible.entries()) {
    if (index > 0 && index % BACKFILL_YIELD_INTERVAL === 0) await yieldToEventLoop();
    if (!isParentCorrectionPending(correction) || correction.unrecorded) continue;
    const providerDay = usageData.dailyActivity[correction.day].byProvider[correction.providerId];
    trackEstimateRemoval(scopes, providerDay, correction.estimate);
    const modelDay = correction.model ? providerDay.byModel?.[correction.model] : null;
    if (modelDay) trackEstimateRemoval(scopes, modelDay, correction.estimate);
  }
  return scopes;
}

function settleCorrectedSources(scopes) {
  for (const [bucket, { original, removed }] of scopes) {
    const hasResidual = countFields.some((field) => (original[field] || 0) > (removed[field] || 0));
    bucket.source = hasUsageCounts(bucket) ? (hasResidual ? 'mixed' : 'measured') : null;
  }
}

// A sibling-only correction can target a day that has no bucket for the
// PARENT provider (the run may predate provider/model breakdowns entirely),
// so the day itself is created on demand rather than required.
function correctionDay(dayKey) {
  if (!usageData.dailyActivity[dayKey]) {
    usageData.dailyActivity[dayKey] = { sessions: 0, messages: 0, tokens: 0, byProvider: {} };
    cacheActivityDay(dayKey);
  }
  return usageData.dailyActivity[dayKey];
}

function replaceEstimateWithMeasured(providerDay, { model, estimate, measured }) {
  const measuredRecords = [measured].flat();
  adjustCounts(providerDay, estimate, -1);
  adjustCounts(model ? providerDay.byModel?.[model] : null, estimate, -1);
  if (providerDay?.estimated) adjustCounts(providerDay.estimated, estimate, -1);
  const estimatedModel = model ? providerDay?.byModel?.[model] : null;
  if (estimatedModel?.estimated) adjustCounts(estimatedModel.estimated, estimate, -1);
  for (const record of measuredRecords) {
    adjustCounts(providerDay, record, 1);
    if (!record?.model) continue;
    const target = modelDayBucket(providerDay, record.model);
    const hadCounts = hasUsageCounts(target);
    adjustCounts(target, record, 1);
    target.source = hadCounts ? mergeSource(target.source, 'measured') : 'measured';
  }
  return measuredRecords;
}

// All-time rollups only hold messages and tokens, so the parent swap moves them
// by the measured-minus-estimate delta. Input carries the measured cache tiers.
function applyAllTimeCorrection({ providerId, model, estimate }, measuredRecords) {
  const measuredTotals = recordTotals(measuredRecords);
  const delta = {
    messages: measuredTotals.messages - (estimate?.messages || 0),
    tokensIn: measuredTotals.tokensIn + measuredTotals.cacheReadTokens + measuredTotals.cacheWriteTokens
      - (estimate?.tokensIn || 0),
    tokensOut: measuredTotals.tokensOut - (estimate?.tokensOut || 0)
  };
  usageData.totalMessages = Math.max(0, (usageData.totalMessages || 0) + delta.messages);
  usageData.totalTokens.input = Math.max(0, (usageData.totalTokens.input || 0) + delta.tokensIn);
  usageData.totalTokens.output = Math.max(0, (usageData.totalTokens.output || 0) + delta.tokensOut);

  const allProvider = usageData.byProvider?.[providerId];
  if (allProvider) {
    allProvider.messages = Math.max(0, (allProvider.messages || 0) + delta.messages);
    allProvider.tokens = Math.max(0, (allProvider.tokens || 0) + delta.tokensOut);
  }
  const estimatedModel = model ? usageData.byModel?.[model] : null;
  if (estimatedModel) {
    estimatedModel.messages = Math.max(0, (estimatedModel.messages || 0) - (estimate?.messages || 0));
    estimatedModel.tokens = Math.max(0, (estimatedModel.tokens || 0) - (estimate?.tokensOut || 0));
  }
  for (const record of measuredRecords) {
    if (!record?.model) continue;
    usageData.byModel[record.model] ??= { sessions: 0, messages: 0, tokens: 0 };
    usageData.byModel[record.model].messages += record.messages || 0;
    usageData.byModel[record.model].tokens += record.tokensOut || 0;
  }
}

// Routed by `record.providerId`, never the run's provider: a nested grok
// review inside a Claude run is grok's spend. There is no estimate to
// remove — nothing ever recorded these tokens at all.
function addSiblingRecords(day, siblings) {
  for (const record of siblings) {
    if (!record?.providerId) continue;
    addUsageRecord(day, record);
    rememberRepairIds(record.repairIds);
  }
}

/**
 * Replace historical per-run estimates with transcript measurements, and add
 * the nested-CLI sessions a run's own provider never accounted for.
 *
 * Two independent halves, each with its own idempotency marker:
 *
 *   PARENT (`estimate` + `measured`, keyed by `reconciledRuns`) — the original
 *     estimate is subtracted from the exact configured provider/model bucket
 *     that received it, then the measured records are added.
 *   SIBLING (`siblings`, keyed by `siblingReconciledRuns`) — a nested reviewer
 *     CLI's session is a pure ADDITION to ITS OWN provider's bucket. It has no
 *     estimate to remove (nothing ever recorded it), and it must never land in
 *     the parent's bucket — that is exactly the mis-attribution #5831 fixes.
 *     A sibling-only correction therefore does not require a pre-existing day
 *     bucket for the parent provider; the target bucket is created on demand.
 *
 * Flat day totals are rebuilt from the provider split so report residual
 * reconciliation cannot resurrect the removed estimate as a synthetic legacy row.
 */

async function applyHistoricalUsageCorrectionsDraft(corrections = [], { interactiveScan = null, expectedRevision } = {}) {
  if (!usageData) await loadUsageDraft();
  if (expectedRevision !== undefined && expectedRevision !== usageData.lastUpdated) {
    throw Object.assign(new Error('Usage changed since preview; prepare a new preview before applying corrections'), {
      code: 'USAGE_REVISION_CONFLICT', status: 409
    });
  }
  await loadDraftRunMarkers(corrections.map((correction) => correction?.runId).filter((id) => typeof id === 'string' && id));
  usageData.reconciledRuns ??= {};
  // Additive: absent on every install that predates the sibling scan, which
  // reads as "no run has had its nested sessions attributed yet".
  usageData.siblingReconciledRuns ??= {};
  const eligible = corrections.filter(isEligibleCorrection);
  if (eligible.some((correction) => correction.unrecorded)) await refreshDayKeyTimezone();
  const scopes = await collectEstimateScopes(eligible);
  const correctedRunIds = [];

  for (const [index, correction] of eligible.entries()) {
    if (index > 0 && index % BACKFILL_YIELD_INTERVAL === 0) await yieldToEventLoop();
    const { runId } = correction;
    const applyParent = isParentCorrectionPending(correction);
    const applySiblings = isSiblingCorrectionPending(correction);
    const day = correctionDay(correction.unrecorded
      ? todayInTimezone(dayKeyTimezone, new Date(correction.endTime)) : correction.day);

    if (applyParent) {
      if (correction.unrecorded) {
        for (const record of correction.measured) addUsageRecord(day, record);
        if (correction.deferredSession) {
          const at = new Date(correction.startTime);
          applySessionCounts(correction.providerId, correction.providerName, correction.model,
            correctionDay(todayInTimezone(dayKeyTimezone, at)), at);
        }
      } else {
        const measuredRecords = replaceEstimateWithMeasured(day.byProvider[correction.providerId], correction);
        applyAllTimeCorrection(correction, measuredRecords);
      }
      usageData.reconciledRuns[runId] = new Date().toISOString();
    }
    if (applySiblings) addSiblingRecords(day, correction.siblings);
    // Same save as the counts. A later Grok repair skips any id recorded here,
    // so a turn billed with its long-context subset is not billed again.
    rememberRepairIds(correction.repairIds);
    // Marked whenever this run's sibling pass actually ran — including a run
    // whose only correction was the parent swap — so a second backfill can't
    // add the same nested session twice.
    if (correction.siblingScanned) usageData.siblingReconciledRuns[runId] = new Date().toISOString();

    rebuildDayTotals(day);
    correctedRunIds.push(runId);
  }

  settleCorrectedSources(scopes);
  // The scan watermark rides the same write as the counts it covers, so a crash
  // cannot leave billed counts without the watermark that stops a re-bill.
  if (interactiveScan) usageData.interactiveScan = structuredClone(interactiveScan);
  if (correctedRunIds.length > 0 || interactiveScan) await saveUsage();
  return { corrected: correctedRunIds.length, correctedRunIds };
}

// The writers below resolve the configured timezone (async) before they touch a
// day bucket, so the synchronous bucket lookup keys the day and the hourly bins
// by one timezone. Days written before this change keep their UTC keys.
let dayKeyTimezone = 'UTC';

async function refreshDayKeyTimezone() {
  dayKeyTimezone = await getUserTimezone();
}

function todayBucket(at) {
  const today = todayInTimezone(dayKeyTimezone, at);
  const dailyActivity = mutableUsageChild(usageData, 'dailyActivity');
  if (!dailyActivity[today]) cacheActivityDay(today);
  return mutableUsageChild(dailyActivity, today, () => ({ sessions: 0, messages: 0, tokens: 0 }));
}

/**
 * Record a new session
 */
function recordSessionDraft(providerId, providerName, rawModel, at) {
  applySessionCounts(providerId, providerName, rawModel, todayBucket(at), at);
  return usageData.totalSessions;
}

function applySessionCounts(providerId, providerName, rawModel, day, at) {
  const provider = normalizeProvider(providerId, providerName);
  const model = usageModelKey(rawModel);

  usageData.totalSessions++;

  const byProvider = mutableUsageChild(usageData, 'byProvider');
  mutableUsageChild(byProvider, provider.id, () => ({ name: provider.name, sessions: 0, messages: 0, tokens: 0 })).sessions++;
  if (model) {
    const byModel = mutableUsageChild(usageData, 'byModel');
    mutableUsageChild(byModel, model, () => ({ sessions: 0, messages: 0, tokens: 0 })).sessions++;
  }

  // Track daily activity (with the per-provider/per-model split)
  day.sessions++;
  const providerDay = providerDayBucket(day, provider.id, provider.name);
  providerDay.sessions++;
  if (model) modelDayBucket(providerDay, model).sessions++;

  // Track hourly activity in the user's configured timezone. The server runs with TZ=UTC,
  // so the host clock would bucket every session by UTC hour.
  const hour = getLocalParts(at, dayKeyTimezone).hour;
  mutableUsageChild(usageData, 'hourlyActivity')[hour]++;
  // Keep the day as well as the lifetime histogram so a selected reporting
  // window can be answered without inventing timestamps for older sessions.
  if (!Array.isArray(day.hourlyActivity)) day.hourlyActivity = Array(24).fill(0);
  mutableUsageChild(day, 'hourlyActivity')[hour]++;
}

/**
 * Record messages in a session. `outputTokens`/`inputTokens` are estimates
 * (or real counts when the runner reports them) attributed to the provider,
 * model, and current day.
 *
 * `extra` carries the prompt-cache tiers and provenance a transcript-reconciled
 * run supplies (`recordRunUsage`). It is optional and defaults to "no cache
 * tokens, estimated" so every existing caller — and the
 * `POST /api/usage/messages` route — keeps its current behavior.
 */
function applyMessageUsage(providerId, rawModel, messageCount, outputTokens = 0, inputTokens = 0, extra = {}, at) {
  const provider = normalizeProvider(providerId);
  const model = usageModelKey(rawModel);
  const cacheReadTokens = Math.max(0, extra?.cacheReadTokens || 0);
  const cacheWriteTokens = Math.max(0, extra?.cacheWriteTokens || 0);
  const longTokensIn = Math.max(0, extra?.longTokensIn || 0);
  const longTokensOut = Math.max(0, extra?.longTokensOut || 0);
  const longCacheReadTokens = Math.max(0, extra?.longCacheReadTokens || 0);
  const longCacheWriteTokens = Math.max(0, extra?.longCacheWriteTokens || 0);
  const speed = Object.fromEntries(SPEED_LEDGER_FIELDS.map((field) => [field, Math.max(0, extra?.[field] || 0)]));
  const source = extra?.source === 'measured' ? 'measured' : 'estimate';

  usageData.totalMessages += messageCount;

  const totalTokens = mutableUsageChild(usageData, 'totalTokens');
  if (outputTokens > 0) totalTokens.output += outputTokens;

  // Include every billable input tier in the headline token count.
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalInputTokens > 0) totalTokens.input += totalInputTokens;

  // Legacy all-time entries keep their output-only `tokens` field for old readers.
  const byProvider = mutableUsageChild(usageData, 'byProvider');
  const providerTotal = mutableUsageChild(byProvider, provider.id, () => ({
    name: provider.name, sessions: 0, messages: 0, tokens: 0
  }));
  providerTotal.messages += messageCount;
  providerTotal.tokens = (providerTotal.tokens || 0) + outputTokens;
  if (model && Object.hasOwn(usageData.byModel, model)) {
    const byModel = mutableUsageChild(usageData, 'byModel');
    const modelTotal = mutableUsageChild(byModel, model);
    modelTotal.messages += messageCount;
    modelTotal.tokens = (modelTotal.tokens || 0) + outputTokens;
  }

  // Track daily (a run can finish on a different day than it started — create
  // the day/provider buckets if missing rather than gating on existence)
  const bumpDayBucket = (bucket) => {
    bucket.messages += messageCount;
    bucket.tokensIn += inputTokens;
    bucket.tokensOut += outputTokens;
    // `??= 0` seeds the field on buckets created before it existed, so a
    // pre-#3124 install starts accumulating cache counts without a migration
    // pass over its whole history.
    bucket.cacheReadTokens = (bucket.cacheReadTokens ?? 0) + cacheReadTokens;
    bucket.cacheWriteTokens = (bucket.cacheWriteTokens ?? 0) + cacheWriteTokens;
    // Long-context counts are a subset. Write them only when this call has
    // some, so a short turn does not stamp zeros onto an older bucket.
    if (longTokensIn || bucket.longTokensIn != null) bucket.longTokensIn = (bucket.longTokensIn ?? 0) + longTokensIn;
    if (longTokensOut || bucket.longTokensOut != null) bucket.longTokensOut = (bucket.longTokensOut ?? 0) + longTokensOut;
    if (longCacheReadTokens || bucket.longCacheReadTokens != null) bucket.longCacheReadTokens = (bucket.longCacheReadTokens ?? 0) + longCacheReadTokens;
    if (longCacheWriteTokens || bucket.longCacheWriteTokens != null) bucket.longCacheWriteTokens = (bucket.longCacheWriteTokens ?? 0) + longCacheWriteTokens;
    for (const field of SPEED_LEDGER_FIELDS) {
      if (speed[field] || bucket[field] != null) bucket[field] = (bucket[field] ?? 0) + speed[field];
    }
    if (source === 'estimate' || extra.nativeUsageUnpersisted) {
      const counts = {
        messages: messageCount, tokensIn: inputTokens, tokensOut: outputTokens, cacheReadTokens, cacheWriteTokens,
        longTokensIn, longTokensOut, longCacheReadTokens, longCacheWriteTokens,
        ...speed,
      };
      if (source === 'estimate') adjustEstimated(bucket, counts, 1);
      else {
        adjustCounts(mutableUsageChild(bucket, 'unpersisted'), counts, 1);
      }
    }
    bucket.source = mergeSource(bucket.source, source);
  };
  const day = todayBucket(at);
  day.messages = (day.messages || 0) + messageCount;
  day.tokens = (day.tokens || 0) + outputTokens;
  const providerDay = providerDayBucket(day, provider.id, providerTotal.name);
  bumpDayBucket(providerDay);
  if (model) bumpDayBucket(modelDayBucket(providerDay, model));
}

async function recordMessagesDraft(providerId, model, messageCount, outputTokens = 0, inputTokens = 0, extra = {}) {
  if (!usageData) await loadUsageDraft();
  await refreshDayKeyTimezone();
  applyMessageUsage(providerId, model, messageCount, outputTokens, inputTokens, extra);
  await saveUsage();
}

/**
 * Record one completed AI run from a reconciled usage record — the shape
 * `services/usageReconciler.reconcileRunUsage` returns, carrying either the
 * provider's own measured counts or the caller's estimate, tagged with which.
 *
 * This is the preferred entry point for run-completion hooks: it keeps the
 * cache tiers and the `measured`/`estimate` provenance together, so a row in
 * the cost report can say whether it was measured. `recordMessages` remains the
 * primitive (and the API route's path) for callers with nothing but a token
 * count.
 *
 * Accepts a single record OR an array of them — a run whose session switched
 * models mid-flight yields one record per model, so each is priced at its own
 * rate rather than the whole aggregate at the launch-time model.
 *
 * @param {{ providerId: string|null, model: string|null, messages?: number,
 *   tokensIn?: number, tokensOut?: number, cacheReadTokens?: number,
 *   cacheWriteTokens?: number, source?: 'measured'|'estimate' }
 *   | Array<object>} record
 */
function recordRunUsageDraft(record, { reconciledRunId = null, siblings = false, codexHighWater = null } = {}, at) {
  // A single run can produce several records when its session switched models
  // mid-flight (see usageReconciler.reconcileRunUsage). Apply the full batch
  // in memory before saving so every model is priced independently without
  // rewriting the complete usage file once per entry.
  const records = Array.isArray(record) ? record.flat(Infinity) : [record];
  if (records.length === 0 && !reconciledRunId) return;

  for (const entry of records) {
    const {
      providerId = null,
      model = null,
      messages = 1,
      tokensIn = 0,
      tokensOut = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
      longTokensIn = 0,
      longTokensOut = 0,
      longCacheReadTokens = 0,
      longCacheWriteTokens = 0,
      source = 'estimate',
      nativeUsageUnpersisted = false,
      repairIds = null,
    } = entry || {};
    if (Array.isArray(repairIds)) rememberRepairIds(repairIds);
    const speedCounts = Object.fromEntries(SPEED_LEDGER_FIELDS.map((field) => [field, entry?.[field] || 0]));
    applyMessageUsage(providerId, model, messages, tokensOut, tokensIn, {
      cacheReadTokens,
      cacheWriteTokens,
      longTokensIn,
      longTokensOut,
      longCacheReadTokens,
      longCacheWriteTokens,
      ...speedCounts,
      source, nativeUsageUnpersisted,
    }, at);
  }

  // Marker and counts share one write: a crash between two saves would leave
  // counts that a later backfill treats as unrecorded and adds again.
  if (reconciledRunId) {
    const existed = Boolean(usageData.reconciledRuns?.[reconciledRunId]);
    setReconciledMarkers(reconciledRunId, siblings);
    // The exact observed boundary commits with its counts, never in a second
    // metadata write. Legacy timestamps remain valid idempotency markers.
    if (!existed && codexHighWater?.length) {
      usageData.reconciledRuns[reconciledRunId] = {
        at: usageData.reconciledRuns[reconciledRunId], codexHighWater: structuredClone(codexHighWater)
      };
    }
  }
  return true;
}

/**
 * Add counts on a specific UTC day, optionally guarded by a repair id so the
 * same image, video, or long-context turn cannot be added twice. `flush: false`
 * leaves the write to {@link flushUsageLedger} so a backfill is one save.
 * @returns {Promise<boolean>} false when the id was already recorded or the day is unusable.
 */
async function addDatedUsageDraft(dayKey, record, { repairId = null, flush = true } = {}) {
  if (!DAY_KEY_RE.test(dayKey || '') || !record) return false;
  if (!usageData) await loadUsageDraft();
  if (repairId && grokRepairIndex.has(repairId)) return false;
  if (!usageData.dailyActivity[dayKey]) {
    usageData.dailyActivity[dayKey] = { sessions: 0, messages: 0, tokens: 0, byProvider: {} };
    cacheActivityDay(dayKey);
  }
  addUsageRecord(usageData.dailyActivity[dayKey], record);
  rebuildDayTotals(usageData.dailyActivity[dayKey]);
  if (repairId) rememberRepairIds([repairId]);
  if (flush) await saveUsage();
  return true;
}

/** Apply a repair batch in one draft and one commit, without cloning per row. */
async function addDatedUsageBatchDraft(additions = []) {
  if (!usageData) await loadUsageDraft();
  await loadDraftRepairIds(additions.map(({ repairId }) => repairId).filter(Boolean));
  const written = [];
  for (const item of additions) {
    if (await addDatedUsageDraft(item.day, item.record, { repairId: item.repairId, flush: false })) {
      written.push(item);
    }
  }
  if (written.length) await saveUsage();
  return written;
}

/** Persist the in-memory ledger. One call after a batch of `addDatedUsage(..., { flush: false })`. */
async function flushUsageLedgerDraft() {
  if (!usageData) return;
  await saveUsage();
}

/**
 * Record token usage
 */
async function recordTokensDraft(inputTokens, outputTokens) {
  if (!usageData) await loadUsageDraft();
  await refreshDayKeyTimezone();
  usageData.totalTokens.input += inputTokens;
  usageData.totalTokens.output += outputTokens;
  const day = todayBucket();
  day.tokens = (day.tokens || 0) + outputTokens;
  const providerDay = providerDayBucket(day, UNKNOWN_PROVIDER_ID, UNKNOWN_PROVIDER_NAME);
  providerDay.tokensIn += inputTokens;
  providerDay.tokensOut += outputTokens;
  await saveUsage();
}

/**
 * Two reports of one incident, one minute apart, are the same block. The
 * runner benches a failed provider AND the agent finalizer benches it again
 * for the same failure, so without this every limit event would stack twice.
 */
export const LIMIT_BLOCK_DEDUPE_MS = 60_000;
/** Oldest block events are dropped past this — the Usage page reads the tail. */
export const LIMIT_BLOCK_CAP = 200;

/**
 * Record an observed provider limit block: a `usage-limit` bench the runner or
 * the agent finalizer actually applied (provider-origin, structured marker —
 * never a loose keyword sweep, never a transient 429 retry, which per
 * docs/QUOTA-BURN.md is a retry rather than a spent window).
 *
 * Fire-and-forget safe: callers invoke it beside a bench mark from completion
 * paths, so it owns its persistence and never rejects into them — chain a
 * `.catch` like the mark itself, or await it inside an existing guarded block.
 *
 * @param {{ providerId: string, model?: string|null, category?: string,
 *   message?: string|null, resetHint?: string|null, at?: number }} event
 * @returns {Promise<object|null>} the stored entry, or null without a provider
 */
async function recordLimitBlockDraft({
  providerId,
  model = null,
  category = 'usage-limit',
  message = null,
  resetHint = null,
  at = new Date().getTime()
} = {}) {
  if (!providerId) return null;
  if (!usageData) await loadUsageDraft();
  if (!Array.isArray(usageData.blockEvents)) usageData.blockEvents = [];
  const entry = {
    providerId,
    model: typeof model === 'string' && model.trim() ? model.trim() : null,
    category,
    message: typeof message === 'string' && message ? message.slice(0, 500) : null,
    resetHint: typeof resetHint === 'string' && resetHint ? resetHint.slice(0, 120) : null,
    at: Number.isFinite(at) ? at : Date.now()
  };
  const last = usageData.blockEvents[usageData.blockEvents.length - 1];
  if (last && last.providerId === entry.providerId && last.category === entry.category
    && (entry.at - last.at) < LIMIT_BLOCK_DEDUPE_MS) {
    usageData.blockEvents[usageData.blockEvents.length - 1] = entry;
  } else {
    usageData.blockEvents.push(entry);
  }
  if (usageData.blockEvents.length > LIMIT_BLOCK_CAP) {
    usageData.blockEvents.splice(0, usageData.blockEvents.length - LIMIT_BLOCK_CAP);
  }
  await saveUsage();
  return entry;
}

/** Every recorded limit block, oldest-first. Pure read over the live ledger. */
export function getLimitBlocks() {
  const events = getUsage().blockEvents;
  return Array.isArray(events) ? [...events] : [];
}

const blockDayOf = (at) => {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
};

/**
 * Ledger volume for one provider since a block's day (inclusive): the
 * heuristic half of the free-tier "estimated remaining" signal — how much has
 * run since the provider last refused. Null when the block carries no usable
 * timestamp (unknown, never zero-collapsed). Pure.
 */
export function providerVolumeSinceBlock(dailyActivity, monthlyActivity, providerId, day) {
  if (!day || !providerId) return null;
  const totals = { sessions: 0, messages: 0, tokensIn: 0, tokensOut: 0 };
  const add = (bucket) => {
    const p = bucket?.byProvider?.[providerId];
    if (!p) return;
    totals.sessions += p.sessions || 0;
    totals.messages += p.messages || 0;
    totals.tokensIn += p.tokensIn || 0;
    totals.tokensOut += p.tokensOut || 0;
  };
  for (const [key, bucket] of Object.entries(monthlyActivity || {})) {
    if (key > day.slice(0, 7)) add(bucket);
  }
  for (const [key, bucket] of Object.entries(dailyActivity || {})) {
    if (DAY_KEY_RE.test(key) && key >= day) add(bucket);
  }
  return totals;
}

export { buildUsageReport };

/** The trailing seven calendar days, oldest first, each filled from `dailyActivity` (zeros when absent). */
function buildLast7Days(dailyActivity) {
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const { sessions = 0, messages = 0, tokens = 0 } = dailyActivity?.[dateStr] || {};
    last7Days.push({ date: dateStr, label: date.toLocaleDateString('en-US', { weekday: 'short' }), sessions, messages, tokens });
  }
  return last7Days;
}

/**
 * Get usage summary. Optional `range` selects the cost-report window:
 * `{ from, to }` as inclusive YYYY-MM-DD strings (null = unbounded), plus the
 * live `providers` config list for free-classification.
 */
export function getUsageSummary({ from = null, to = null, providers = [] } = {}) {
  const usageData = withNativeUsage(committedUsage, providers);
  if (!usageData) {
    const empty = getEmptyUsage();
    const last7Days = buildLast7Days({});
    return {
      ...empty,
      last7Days,
      estimatedCost: 0,
      topProviders: [],
      topModels: [],
      report: buildUsageReport({}, { from, to, providers, monthlyActivity: {} }),
      freeTier: { providers: [], blocks: [], basis: 'ledger' }
    };
  }

  const cacheKey = JSON.stringify({
    day: new Date().toISOString().split('T')[0],
    from,
    to,
    native: nativeUsageSignature(),
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      free: isFreeProvider(provider),
      family: familyForProvider(provider)
    }))
  });
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  const last7Days = buildLast7Days(usageData.dailyActivity);

  const report = buildUsageReport(usageData.dailyActivity, {
    from,
    to,
    providers,
    monthlyActivity: usageData.monthlyActivity,
    totalTokens: from || to ? null : usageData.totalTokens
  });
  const allTimeReport = from || to
    ? buildUsageReport(usageData.dailyActivity, {
        providers,
        monthlyActivity: usageData.monthlyActivity,
        totalTokens: usageData.totalTokens
      })
    : report;

  const summary = {
    totalSessions: usageData.totalSessions,
    totalMessages: usageData.totalMessages,
    totalToolCalls: usageData.totalToolCalls,
    totalTokens: usageData.totalTokens,
    // Backward-compatible field, now sourced from the same complete,
    // per-model/fallback-priced report as the headline instead of a second
    // contradictory blended-rate calculation.
    estimatedCost: allTimeReport.totals.estimatedCost,
    last7Days,
    hourlyActivity: usageData.hourlyActivity,
    topProviders: Object.entries(usageData.byProvider)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 5),
    topModels: Object.entries(usageData.byModel)
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 5),
    report,
    // Free-tier counterpart of the paid cost report: the report rows already
    // free-classified (local inference, Zen quota), plus the observed limit
    // blocks with ledger volume since each — the estimated-quota signal for
    // providers that expose no usage API. `basis: 'ledger'` is the card's
    // stated provenance (see UsagePage's free-tier section).
    freeTier: {
      providers: report.providers.filter((row) => row.free),
      blocks: getLimitBlocks().slice(-20).map((event) => ({
        ...event,
        volumeSince: providerVolumeSinceBlock(
          usageData.dailyActivity,
          usageData.monthlyActivity,
          event.providerId,
          blockDayOf(event.at)
        )
      })),
      basis: 'ledger'
    },
    lastUpdated: usageData.lastUpdated
  };
  if (summaryCache.size >= SUMMARY_CACHE_LIMIT) {
    summaryCache.delete(summaryCache.keys().next().value);
  }
  summaryCache.set(cacheKey, summary);
  return summary;
}

/**
 * Reset usage data
 */
async function resetUsageDraft() {
  if (usesUsageDatabase() && !usageData) await loadUsageDraft();
  usageData = getEmptyUsage();
  grokRepairIndex = new Set();
  if (committedUsage) usageData.lastUpdated = committedUsage.lastUpdated;
  await saveUsage({ previous: null, reset: true });
  return true;
}

/**
 * How many days of PER-DAY granularity ride the federated usage digest. Older
 * days are folded into their month bucket for the WIRE ONLY — the local file
 * keeps its own (much longer) `ROLLUP_RETENTION_DAYS` window untouched, and a
 * local report always reads the live maps.
 *
 * The cap exists because the digest is re-fetched by every peer whenever local
 * usage moves (which is every AI run). All-time totals stay exact either way —
 * folding a day into its month preserves every count, just at coarser
 * granularity, which is all a fleet-level report needs for old periods.
 */
const DIGEST_DAILY_RETENTION_DAYS = 120;

/**
 * Build the federated wire shape for this instance's usage: aggregate counters
 * only — provider ids, model ids, token counts, timestamps. No prompts, no
 * transcripts, no record contents, no PII.
 *
 * Two fields of `usageData` are deliberately absent. `reconciledRuns` is
 * idempotency bookkeeping keyed by LOCAL run ids — meaningless on a peer and
 * the largest field in the file. All-time `byProvider`/`byModel` are a coarser
 * restatement of what the day buckets already carry, which is what a fleet
 * report actually aggregates.
 *
 * Pure: only the buckets that survive the wire rollup are copied, so the
 * caller's `usageData` is untouched and old days aren't cloned to be discarded.
 */
export function buildUsageDigest(source = getUsage(), { retentionDays = DIGEST_DAILY_RETENTION_DAYS, now = new Date() } = {}) {
  // Shallow copy first: the rollup DELETES the days it folds away, so it runs
  // over our own map of references while only READING the buckets themselves.
  // Deep-cloning afterwards therefore copies just the days that survived,
  // instead of copying the whole history to throw most of it away.
  const surviving = { ...(source?.dailyActivity || {}) };
  const monthlyActivity = structuredClone(source?.monthlyActivity || {});
  rollupOldDailyActivity(surviving, monthlyActivity, { retentionDays, now });
  const dailyActivity = structuredClone(surviving);

  const hourly = Array.isArray(source?.hourlyActivity) ? source.hourlyActivity : [];
  return {
    totalSessions: source?.totalSessions || 0,
    totalMessages: source?.totalMessages || 0,
    totalToolCalls: source?.totalToolCalls || 0,
    totalTokens: {
      input: source?.totalTokens?.input || 0,
      output: source?.totalTokens?.output || 0
    },
    dailyActivity,
    monthlyActivity,
    hourlyActivity: Array.from({ length: 24 }, (_, i) => hourly[i] || 0),
    earliestActivityDay: findEarliestActivityDay(dailyActivity, monthlyActivity),
    // The instant this instance last recorded usage. Doubles as the digest's
    // LWW stamp on the wire. Local-only claim compaction leaves the stamp
    // untouched, so peers keep the same digest while the counters are unchanged.
    lastUpdated: source?.lastUpdated ?? null
  };
}

export async function loadUsage({ includeRepairEvidence = false } = {}) {
  closeRunBatch();
  return queueUsageWrite(async () => {
    return transactUsage(async () => {
      await loadUsageDraft();
      // Only the server loads this ledger. Import bridge-written request
      // records locally; no transcript scan or provider call runs at boot.
      const { listUsageRunIds, scanHistoricalUsage } = await import('./usageBackfillWorker.js');
      const runsDir = PATHS.runs ?? join(DATA_DIR, 'runs');
      const runIds = await listUsageRunIds(runsDir);
      const { corrections } = await scanHistoricalUsage({
        runsDir, runIds, reportedOnly: true,
        reconciledRunIds: await getReconciledUsageRunIds(runIds),
      });
      const { correctedRunIds } = await applyHistoricalUsageCorrectionsDraft(corrections);
      const corrected = new Set(correctedRunIds);
      for (const correction of corrections) {
        if (!corrected.has(correction.runId)) continue;
        // Counts and their ledger marker committed first. If this secondary
        // marker fails, the ledger still prevents a duplicate on the next load.
        try {
          const metadata = await readJSONFile(correction.metadataPath, null, { strict: true });
          if (!metadata) continue;
          await atomicWrite(correction.metadataPath, {
            ...metadata, usageReconciled: true, usageReconciledAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`❌ Failed to mark usage for run ${correction.runId}: ${err.message}`);
        }
      }
      if (usesUsageDatabase()) {
        usageData = committedUsage;
        if (includeRepairEvidence) return (await usageDatabase()).readUsageLedgerExport();
      }
      return committedUsage;
    });
  });
}

/** Refresh just the committed ledger while restore still fences DB writers. */
export async function reloadRestoredUsageLedger() {
  if (!usesUsageDatabase()) return;
  await mutateUsage(async () => {
    await loadUsageDraft({ mutableDraft: false });
    bumpChangeToken('usage');
  }, []);
}

export async function forgetSiblingReconciledUsageRuns(...args) {
  return mutateUsage(forgetSiblingReconciledUsageRunsDraft, args);
}

export async function markUsageRunReconciled(...args) {
  return mutateUsage(markUsageRunReconciledDraft, args);
}

export async function applyHistoricalUsageCorrections(...args) {
  return mutateUsage(applyHistoricalUsageCorrectionsDraft, args);
}

export async function recordSession(providerId, providerName, rawModel) {
  return queueRunWrite(recordSessionDraft, [providerId, providerName, rawModel, new Date()]);
}

export async function recordMessages(...args) {
  return mutateUsage(recordMessagesDraft, args);
}

export async function recordRunUsage(record, options) {
  await queueRunWrite(recordRunUsageDraft, [record, options, new Date()]);
}

export async function addDatedUsage(...args) {
  return mutateUsage(async (day, record, options) => {
    if (!usageData) await loadUsageDraft();
    if (options?.repairId) await loadDraftRepairIds([options.repairId]);
    return addDatedUsageDraft(day, record, options);
  }, args);
}

export async function flushUsageLedger(...args) {
  return mutateUsage(flushUsageLedgerDraft, args);
}

export async function recordTokens(...args) {
  return mutateUsage(recordTokensDraft, args);
}

export async function recordLimitBlock(...args) {
  return mutateUsage(recordLimitBlockDraft, args);
}

export async function resetUsage(...args) {
  return mutateUsage(resetUsageDraft, args);
}

export async function addDatedUsageBatch(...args) {
  return mutateUsage(addDatedUsageBatchDraft, args);
}

