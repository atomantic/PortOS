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
import { SPEED_LEDGER_FIELDS } from '../lib/modelPricing.js';
import { UNKNOWN_PROVIDER_ID, UNKNOWN_PROVIDER_NAME, isUsageKey, usageModelKey, normalizeProvider, hasUsageCounts, mergeSource } from '../lib/usageReport.js';
import { getLocalParts, todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import { bumpChangeToken } from './changeToken.js';

import { adjustCounts, cacheActivityDay, datedUsageDay, DAY_KEY_RE, deepSumInto, findEarliestActivityDay, getEmptyUsage, rebuildDayTotals, rollupOldDailyActivity } from '../lib/usageBuckets.js';
import { correctUsageDraft } from './usageCorrections.js';
import { buildUsageSummary, buildUsageDigest as digestUsage } from './usageSummary.js';

export { providerVolumeSinceBlock } from './usageSummary.js';
export { rollupOldDailyActivity } from '../lib/usageBuckets.js';
export { buildUsageReport } from '../lib/usageReport.js';

const DATA_DIR = PATHS.data;
export const USAGE_FILE = join(DATA_DIR, 'usage.json');

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

async function applyHistoricalUsageCorrectionsDraft(corrections = [], { interactiveScan = null, expectedRevision } = {}) {
  if (!usageData) await loadUsageDraft();
  if (expectedRevision !== undefined && expectedRevision !== usageData.lastUpdated) {
    throw Object.assign(new Error('Usage changed since preview; prepare a new preview before applying corrections'), {
      code: 'USAGE_REVISION_CONFLICT', status: 409
    });
  }
  await loadDraftRunMarkers(corrections.map((correction) => correction?.runId).filter((id) => typeof id === 'string' && id));
  const correctedRunIds = await correctUsageDraft(usageData, corrections, {
    refreshDayKeyTimezone, modelDayBucket, addUsageRecord, applySessionCounts, rememberRepairIds,
  });
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
  return dayKeyTimezone;
}

function todayBucket(at) {
  const today = todayInTimezone(dayKeyTimezone, at);
  const dailyActivity = mutableUsageChild(usageData, 'dailyActivity');
  if (!dailyActivity[today]) cacheActivityDay(usageData, today);
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
 * run supplies (`recordRunUsage`).
 */
function applyMessageUsage(providerId, rawModel, messageCount, outputTokens, inputTokens, extra, at) {
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
  if (model) {
    const byModel = mutableUsageChild(usageData, 'byModel');
    const modelTotal = mutableUsageChild(byModel, model, () => ({ sessions: 0, messages: 0, tokens: 0 }));
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

/**
 * Record one completed AI run from a reconciled usage record — the shape
 * `services/usageReconciler.reconcileRunUsage` returns, carrying either the
 * provider's own measured counts or the caller's estimate, tagged with which.
 *
 * This is the preferred entry point for run-completion hooks: it keeps the
 * cache tiers and the `measured`/`estimate` provenance together, so a row in
 * the cost report can say whether it was measured.
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
 * leaves the write to the batch caller so a backfill is one save.
 * @returns {Promise<boolean>} false when the id was already recorded or the day is unusable.
 */
async function addDatedUsageDraft(dayKey, record, { repairId = null, flush = true } = {}) {
  if (!DAY_KEY_RE.test(dayKey || '') || !record) return false;
  if (!usageData) await loadUsageDraft();
  if (repairId && grokRepairIndex.has(repairId)) return false;
  const day = datedUsageDay(usageData, dayKey);
  addUsageRecord(day, record);
  rebuildDayTotals(day);
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

export function getUsageSummary(options) {
  return buildUsageSummary(committedUsage, todayInTimezone(dayKeyTimezone), summaryCache, options);
}

export function buildUsageDigest(source = getUsage(), options) {
  return digestUsage(source, options);
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

export async function loadUsage({ includeRepairEvidence = false } = {}) {
  closeRunBatch();
  return queueUsageWrite(async () => {
    await refreshDayKeyTimezone();
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

export async function markUsageRunReconciled(...args) {
  return mutateUsage(markUsageRunReconciledDraft, args);
}

export async function applyHistoricalUsageCorrections(...args) {
  return mutateUsage(applyHistoricalUsageCorrectionsDraft, args);
}

export async function recordSession(providerId, providerName, rawModel) {
  return queueRunWrite(recordSessionDraft, [providerId, providerName, rawModel, new Date()]);
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

export async function recordLimitBlock(...args) {
  return mutateUsage(recordLimitBlockDraft, args);
}

export async function resetUsage(...args) {
  return mutateUsage(resetUsageDraft, args);
}

export async function addDatedUsageBatch(...args) {
  return mutateUsage(addDatedUsageBatchDraft, args);
}
