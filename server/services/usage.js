import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { resolveModelRates, isFreeProvider, isFreeModelId, estimateCostUsd, PRICING_AS_OF } from '../lib/modelPricing.js';
import { familyForProvider } from '../lib/providerFamilies.js';
import { roundCents } from '../lib/subscriptionSavings.js';

const DATA_DIR = PATHS.data;
export const USAGE_FILE = join(DATA_DIR, 'usage.json');

// Day buckets older than this are rolled up into monthly buckets at load time so
// dailyActivity (and therefore the whole-file rewrite on every AI run) stops growing
// linearly forever. 400 days keeps a full year-plus of per-day granularity — beyond
// any useful streak/report window — while collapsing everything older to per-month.
const ROLLUP_RETENTION_DAYS = 400;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const SUMMARY_CACHE_LIMIT = 20;

let usageData = null;
const summaryCache = new Map();
const UNKNOWN_PROVIDER_ID = 'unknown';
const UNKNOWN_PROVIDER_NAME = 'Unknown provider';
const LEGACY_PROVIDER_ID = 'legacy';
const LEGACY_PROVIDER_NAME = 'Pre-breakdown (legacy)';

const normalizeProvider = (providerId, providerName = null) => {
  const id = typeof providerId === 'string' && providerId.trim() && providerId.trim() !== 'undefined'
    ? providerId.trim()
    : UNKNOWN_PROVIDER_ID;
  return {
    id,
    name: id === UNKNOWN_PROVIDER_ID
      ? UNKNOWN_PROVIDER_NAME
      : (providerName || id)
  };
};

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

/**
 * Load usage data from disk
 */
export async function loadUsage() {
  await ensureDir(DATA_DIR);
  summaryCache.clear();

  // STRICT (#4115): the `!usageData` branch below does not just report an empty
  // total — it atomically OVERWRITES usage.json with zeros on the same tick. A
  // swallowed EACCES/EIO would therefore erase every historical session, cost,
  // and rollup bucket permanently. Only a genuinely ABSENT file is a real fresh
  // install; a present-but-unreadable one now throws before reaching the write
  // (the module-load bootstrap at the bottom of this file already logs it).
  usageData = await readJSONFile(USAGE_FILE, null, { strict: true });
  if (!usageData) {
    usageData = getEmptyUsage();
    await saveUsage();
  }

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
  if (rolledUp || normalizedProviders || earliestChanged) {
    if (normalizedProviders) console.log('📊 Normalized undefined usage providers to unknown');
    if (rolledUp) console.log(`📊 Rolled up old daily usage into ${Object.keys(usageData.monthlyActivity).length} monthly buckets`);
    await saveUsage();
  }

  console.log(`📊 Loaded usage: ${usageData.totalSessions} sessions, ${usageData.totalMessages} messages`);
  return usageData;
}

/**
 * Save usage data to disk
 */
async function saveUsage() {
  summaryCache.clear();
  usageData.lastUpdated = new Date().toISOString();
  await atomicWrite(USAGE_FILE, usageData);
}

/**
 * Get current usage stats
 */
export function getUsage() {
  return usageData || getEmptyUsage();
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
  if (!day.byProvider) day.byProvider = {};
  if (!day.byProvider[provider.id]) {
    day.byProvider[provider.id] = {
      name: provider.name,
      sessions: 0,
      messages: 0,
      tokensIn: 0,
      tokensOut: 0,
      // Prompt-cache tiers, captured only for providers whose CLI writes a
      // transcript we can read (see services/usageReconciler.js). Additive:
      // absent on every bucket written before #3124 and read as 0.
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // How this bucket's counts were obtained. `measured` = summed from the
      // provider's own transcript; `estimate` = derived from prompt length and
      // captured stdout. A bucket that accumulated both is `mixed`, so the
      // report never claims a partially-estimated row is measured.
      source: null,
      byModel: {}
    };
  }
  return day.byProvider[provider.id];
}

function modelDayBucket(providerDay, model) {
  if (!providerDay.byModel[model]) {
    providerDay.byModel[model] = {
      sessions: 0,
      messages: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: null
    };
  }
  return providerDay.byModel[model];
}

const countFields = ['messages', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens'];

const recordTotals = (records) => (Array.isArray(records) ? records : [records]).reduce((total, record) => {
  for (const field of countFields) total[field] += Math.max(0, record?.[field] || 0);
  return total;
}, { messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

const adjustCounts = (bucket, counts, direction) => {
  if (!bucket) return;
  for (const field of countFields) {
    const next = (bucket[field] || 0) + direction * Math.max(0, counts?.[field] || 0);
    bucket[field] = Math.max(0, next);
  }
};

const hasUsageCounts = (bucket) => countFields.some((field) => (bucket?.[field] || 0) > 0);
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
export function getReconciledUsageRunIds() {
  return Object.keys(usageData?.reconciledRuns || {});
}

/**
 * Run ids whose NESTED-session (sibling-family) attribution has already landed.
 * A separate marker from `reconciledRuns` on purpose: the sibling pass has to be
 * able to run on a run whose own transcript was reconciled long ago (#5831).
 */
export function getSiblingReconciledUsageRunIds() {
  return Object.keys(usageData?.siblingReconciledRuns || {});
}

export async function markUsageRunReconciled(runId) {
  if (!runId) return;
  if (!usageData) await loadUsage();
  usageData.reconciledRuns ??= {};
  if (usageData.reconciledRuns[runId]) return;
  usageData.reconciledRuns[runId] = new Date().toISOString();
  await saveUsage();
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
export async function applyHistoricalUsageCorrections(corrections = []) {
  if (!usageData) await loadUsage();
  usageData.reconciledRuns ??= {};
  // Additive: absent on every install that predates the sibling scan, which
  // reads as "no run has had its nested sessions attributed yet".
  usageData.siblingReconciledRuns ??= {};
  let corrected = 0;
  const correctedRunIds = [];
  const pendingParent = (correction) => Boolean(correction?.measured)
    && !usageData.reconciledRuns[correction.runId]
    && Boolean(usageData.dailyActivity?.[correction.day]?.byProvider?.[correction.providerId]);
  const pendingSiblings = (correction) => (correction?.siblings?.length > 0)
    && !usageData.siblingReconciledRuns[correction.runId];
  const eligible = corrections.filter((correction) => {
    const { runId, day: dayKey, providerId } = correction || {};
    if (!runId || !dayKey || !providerId) return false;
    return pendingParent(correction) || pendingSiblings(correction);
  });
  const providerScopes = new Map();
  const modelScopes = new Map();
  for (const [index, correction] of eligible.entries()) {
    if (index > 0 && index % BACKFILL_YIELD_INTERVAL === 0) await yieldToEventLoop();
    if (!pendingParent(correction)) continue;
    const providerKey = `${correction.day}\u0000${correction.providerId}`;
    const providerDay = usageData.dailyActivity[correction.day].byProvider[correction.providerId];
    if (!providerScopes.has(providerKey)) {
      providerScopes.set(providerKey, { bucket: providerDay, original: recordTotals([providerDay]), removed: recordTotals([]) });
    }
    adjustCounts(providerScopes.get(providerKey).removed, correction.estimate, 1);
    if (correction.model && providerDay.byModel?.[correction.model]) {
      const modelKey = `${providerKey}\u0000${correction.model}`;
      const modelDay = providerDay.byModel[correction.model];
      if (!modelScopes.has(modelKey)) {
        modelScopes.set(modelKey, { bucket: modelDay, original: recordTotals([modelDay]), removed: recordTotals([]) });
      }
      adjustCounts(modelScopes.get(modelKey).removed, correction.estimate, 1);
    }
  }

  // Add one usage record to its OWN provider's day bucket and to the flat
  // all-time rollups. Shared by the parent swap and the sibling add — the only
  // difference between them is which bucket `record.providerId` names.
  const addRecord = (day, record) => {
    const bucket = providerDayBucket(day, record.providerId);
    const hadProviderCounts = hasUsageCounts(bucket);
    adjustCounts(bucket, record, 1);
    bucket.source = hadProviderCounts
      ? mergeSource(bucket.source, record.source || 'measured')
      : (record.source || 'measured');
    if (record?.model) {
      const target = modelDayBucket(bucket, record.model);
      const hadCounts = hasUsageCounts(target);
      adjustCounts(target, record, 1);
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
    if (record?.model) {
      usageData.byModel[record.model] ??= { sessions: 0, messages: 0, tokens: 0 };
      usageData.byModel[record.model].messages += record.messages || 0;
      usageData.byModel[record.model].tokens += record.tokensOut || 0;
    }
  };

  for (const [index, correction] of eligible.entries()) {
    if (index > 0 && index % BACKFILL_YIELD_INTERVAL === 0) await yieldToEventLoop();
    const { runId, day: dayKey, providerId, model, estimate, measured } = correction || {};
    const applyParent = pendingParent(correction);
    const applySiblings = pendingSiblings(correction);
    // A sibling-only correction can target a day that has no bucket for the
    // PARENT provider (the run may predate provider/model breakdowns entirely),
    // so the day itself is created on demand rather than required.
    if (!usageData.dailyActivity[dayKey]) {
      usageData.dailyActivity[dayKey] = { sessions: 0, messages: 0, tokens: 0, byProvider: {} };
      cacheActivityDay(dayKey);
    }
    const day = usageData.dailyActivity[dayKey];

    if (applyParent) {
      const providerDay = day.byProvider[providerId];
      const measuredRecords = Array.isArray(measured) ? measured : [measured];
      const measuredTotals = recordTotals(measuredRecords);
      const oldModelDay = model ? providerDay.byModel?.[model] : null;

      adjustCounts(providerDay, estimate, -1);
      if (oldModelDay) {
        adjustCounts(oldModelDay, estimate, -1);
      }

      for (const record of measuredRecords) {
        adjustCounts(providerDay, record, 1);
        if (record?.model) {
          const target = modelDayBucket(providerDay, record.model);
          const hadCounts = hasUsageCounts(target);
          adjustCounts(target, record, 1);
          target.source = hadCounts ? mergeSource(target.source, 'measured') : 'measured';
        }
      }

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
      if (model && usageData.byModel?.[model]) {
        usageData.byModel[model].messages = Math.max(0, (usageData.byModel[model].messages || 0) - (estimate?.messages || 0));
        usageData.byModel[model].tokens = Math.max(0, (usageData.byModel[model].tokens || 0) - (estimate?.tokensOut || 0));
      }
      for (const record of measuredRecords) {
        if (!record?.model) continue;
        usageData.byModel[record.model] ??= { sessions: 0, messages: 0, tokens: 0 };
        usageData.byModel[record.model].messages += record.messages || 0;
        usageData.byModel[record.model].tokens += record.tokensOut || 0;
      }
      usageData.reconciledRuns[runId] = new Date().toISOString();
    }

    if (applySiblings) {
      // Routed by `record.providerId`, never the run's provider: a nested grok
      // review inside a Claude run is grok's spend. There is no estimate to
      // remove — nothing ever recorded these tokens at all.
      for (const record of correction.siblings) {
        if (!record?.providerId) continue;
        addRecord(day, record);
      }
    }
    // Marked whenever this run's sibling pass actually ran — including a run
    // whose only correction was the parent swap — so a second backfill can't
    // add the same nested session twice.
    if (correction.siblingScanned) usageData.siblingReconciledRuns[runId] = new Date().toISOString();

    rebuildDayTotals(day);
    corrected++;
    correctedRunIds.push(runId);
  }

  const hasResidual = ({ original, removed }) => countFields
    .some((field) => (original[field] || 0) > (removed[field] || 0));
  for (const scope of providerScopes.values()) {
    scope.bucket.source = hasUsageCounts(scope.bucket)
      ? (hasResidual(scope) ? 'mixed' : 'measured')
      : null;
  }
  for (const scope of modelScopes.values()) {
    scope.bucket.source = hasUsageCounts(scope.bucket)
      ? (hasResidual(scope) ? 'mixed' : 'measured')
      : null;
  }

  if (corrected > 0) await saveUsage();
  return { corrected, correctedRunIds };
}

/**
 * Merge a new measurement source into a bucket's existing one. A bucket that has
 * only ever seen one kind keeps that kind; mixing measured and estimated counts
 * downgrades it to `mixed` so the UI can't present a partly-estimated row as
 * ground truth. Absent (legacy buckets) is treated as `estimate` — that is what
 * every pre-#3124 bucket actually holds.
 */
function mergeSource(existing, incoming) {
  if (!incoming) return existing ?? null;
  // `null` = a bucket we just created that holds no counts yet, so the incoming
  // source becomes its source outright. `undefined` = a bucket written before
  // this field existed, whose counts are estimates by definition.
  const current = existing === null ? null : (existing ?? 'estimate');
  if (!current) return incoming;
  return current === incoming ? current : 'mixed';
}

function todayBucket() {
  const today = new Date().toISOString().split('T')[0];
  if (!usageData.dailyActivity[today]) {
    usageData.dailyActivity[today] = { sessions: 0, messages: 0, tokens: 0 };
    cacheActivityDay(today);
  }
  return usageData.dailyActivity[today];
}

/**
 * Record a new session
 */
export async function recordSession(providerId, providerName, model) {
  if (!usageData) await loadUsage();
  const provider = normalizeProvider(providerId, providerName);

  usageData.totalSessions++;

  // Track by provider
  if (!usageData.byProvider[provider.id]) {
    usageData.byProvider[provider.id] = { name: provider.name, sessions: 0, messages: 0, tokens: 0 };
  }
  usageData.byProvider[provider.id].sessions++;

  // Track by model
  if (model) {
    if (!usageData.byModel[model]) {
      usageData.byModel[model] = { sessions: 0, messages: 0, tokens: 0 };
    }
    usageData.byModel[model].sessions++;
  }

  // Track daily activity (with the per-provider/per-model split)
  const day = todayBucket();
  day.sessions++;
  const providerDay = providerDayBucket(day, provider.id, provider.name);
  providerDay.sessions++;
  if (model) modelDayBucket(providerDay, model).sessions++;

  // Track hourly activity
  const hour = new Date().getHours();
  usageData.hourlyActivity[hour]++;

  await saveUsage();
  return usageData.totalSessions;
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
function applyMessageUsage(providerId, model, messageCount, outputTokens = 0, inputTokens = 0, extra = {}) {
  const provider = normalizeProvider(providerId);
  const cacheReadTokens = Math.max(0, extra?.cacheReadTokens || 0);
  const cacheWriteTokens = Math.max(0, extra?.cacheWriteTokens || 0);
  const source = extra?.source === 'measured' ? 'measured' : 'estimate';

  usageData.totalMessages += messageCount;

  if (outputTokens > 0) {
    usageData.totalTokens.output += outputTokens;
  }
  // All-time input counts every billable input tier — a cache read is an input
  // token the user was charged for, so omitting it from the headline "Tokens"
  // figure would reproduce the #3124 understatement one level up.
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalInputTokens > 0) {
    usageData.totalTokens.input += totalInputTokens;
  }

  // Track by provider / by model (the legacy all-time entries keep their
  // output-only `tokens` field for old readers — the in/out split lives only
  // in the day buckets, which is what the cost report aggregates)
  if (!usageData.byProvider[provider.id]) {
    usageData.byProvider[provider.id] = { name: provider.name, sessions: 0, messages: 0, tokens: 0 };
  }
  usageData.byProvider[provider.id].messages += messageCount;
  usageData.byProvider[provider.id].tokens = (usageData.byProvider[provider.id].tokens || 0) + outputTokens;
  if (model && usageData.byModel[model]) {
    usageData.byModel[model].messages += messageCount;
    usageData.byModel[model].tokens = (usageData.byModel[model].tokens || 0) + outputTokens;
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
    bucket.source = mergeSource(bucket.source, source);
  };
  const day = todayBucket();
  day.messages = (day.messages || 0) + messageCount;
  day.tokens = (day.tokens || 0) + outputTokens;
  const providerName = usageData.byProvider[provider.id]?.name;
  const providerDay = providerDayBucket(day, provider.id, providerName);
  bumpDayBucket(providerDay);
  if (model) bumpDayBucket(modelDayBucket(providerDay, model));
}

export async function recordMessages(providerId, model, messageCount, outputTokens = 0, inputTokens = 0, extra = {}) {
  if (!usageData) await loadUsage();
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
export async function recordRunUsage(record) {
  // A single run can produce several records when its session switched models
  // mid-flight (see usageReconciler.reconcileRunUsage). Apply the full batch
  // in memory before saving so every model is priced independently without
  // rewriting the complete usage file once per entry.
  const records = Array.isArray(record) ? record.flat(Infinity) : [record];
  if (records.length === 0) return;
  if (!usageData) await loadUsage();

  for (const entry of records) {
    const {
      providerId = null,
      model = null,
      messages = 1,
      tokensIn = 0,
      tokensOut = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
      source = 'estimate'
    } = entry || {};
    applyMessageUsage(providerId, model, messages, tokensOut, tokensIn, {
      cacheReadTokens,
      cacheWriteTokens,
      source
    });
  }

  await saveUsage();
}

/**
 * Record tool calls
 */
export async function recordToolCalls(count) {
  if (!usageData) await loadUsage();
  usageData.totalToolCalls += count;
  await saveUsage();
}

/**
 * Record token usage
 */
export async function recordTokens(inputTokens, outputTokens) {
  if (!usageData) await loadUsage();
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
 * Aggregate the per-day per-provider per-model buckets over a date range into
 * a cost report. `from`/`to` are inclusive `YYYY-MM-DD` strings (null = open
 * end). `providers` is the live provider config list (from
 * `services/providers.getAllProviders()`), used for free-classification and
 * display names — records whose provider config no longer exists fall back to
 * an id-based heuristic.
 *
 * `monthlyActivity` (optional) is the rollup of day buckets older than the daily
 * retention window (see `rollupOldDailyActivity`). Its buckets carry the same
 * nested `byProvider`/`byModel` shape at month granularity, so folding them in
 * keeps long-range totals accurate across the rollup boundary. A month bucket
 * is whole-month-granular: it is included whenever its month overlaps
 * `[from, to]` (rolled-up months are far older than any day-precise range).
 *
 * Every row carries `cacheReadTokens`/`cacheWriteTokens` (priced at their own
 * per-1M tiers) and a `source` of `measured` | `estimate` | `mixed` — buckets
 * written before #3124 report `estimate`, since that is what their counts are.
 */
export function buildUsageReport(dailyActivity, { from = null, to = null, providers = [], monthlyActivity = null, totalTokens = null } = {}) {
  const configById = new Map((providers || []).map((p) => [p.id, p]));
  const agg = new Map(); // providerId -> { name, sessions, messages, tokensIn, tokensOut, byModel: Map }
  let breakdownSince = null;

  const ensureAggregate = (pid, name) => {
    if (!agg.has(pid)) {
      agg.set(pid, {
        name,
        sessions: 0,
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        source: null,
        byModel: new Map()
      });
    }
    return agg.get(pid);
  };

  // Fold a bucket's provider/model splits and any residual flat legacy counts.
  // Monthly rollups can contain both shapes when their source month straddled
  // the provider-breakdown rollout.
  const foldBucket = (bucket) => {
    let representedSessions = 0;
    let representedMessages = 0;
    let representedTokensIn = 0;
    let representedTokensOut = 0;
    for (const [pid, pDay] of Object.entries(bucket.byProvider || {})) {
      const normalized = normalizeProvider(pid, pDay.name);
      const p = ensureAggregate(normalized.id, normalized.name);
      p.sessions += pDay.sessions || 0;
      p.messages += pDay.messages || 0;
      p.tokensIn += pDay.tokensIn || 0;
      p.tokensOut += pDay.tokensOut || 0;
      p.cacheReadTokens += pDay.cacheReadTokens || 0;
      p.cacheWriteTokens += pDay.cacheWriteTokens || 0;
      // A bucket with counts but no `source` predates the field — those counts
      // are estimates, so fold it in as such rather than leaving the row
      // unlabeled and letting the UI imply it was measured.
      if ((pDay.tokensIn || pDay.tokensOut || pDay.cacheReadTokens || pDay.cacheWriteTokens || pDay.messages) && !pDay.source) {
        p.source = mergeSource(p.source, 'estimate');
      } else {
        p.source = mergeSource(p.source, pDay.source);
      }
      representedSessions += pDay.sessions || 0;
      representedMessages += pDay.messages || 0;
      representedTokensIn += pDay.tokensIn || 0;
      representedTokensOut += pDay.tokensOut || 0;
      for (const [model, mDay] of Object.entries(pDay.byModel || {})) {
        if (!p.byModel.has(model)) {
          p.byModel.set(model, {
            sessions: 0,
            messages: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            source: null
          });
        }
        const m = p.byModel.get(model);
        m.sessions += mDay.sessions || 0;
        m.messages += mDay.messages || 0;
        m.tokensIn += mDay.tokensIn || 0;
        m.tokensOut += mDay.tokensOut || 0;
        m.cacheReadTokens += mDay.cacheReadTokens || 0;
        m.cacheWriteTokens += mDay.cacheWriteTokens || 0;
        m.source = mergeSource(m.source, mDay.source || (mDay.tokensIn || mDay.tokensOut || mDay.messages ? 'estimate' : null));
      }
    }
    const residualSessions = Math.max(0, (bucket.sessions || 0) - representedSessions);
    const residualMessages = Math.max(0, (bucket.messages || 0) - representedMessages);
    const residualTokensIn = Math.max(0, (bucket.tokensIn || 0) - representedTokensIn);
    const bucketTokensOut = typeof bucket.tokensOut === 'number' ? bucket.tokensOut : (bucket.tokens || 0);
    const residualTokensOut = Math.max(0, bucketTokensOut - representedTokensOut);
    if (residualSessions || residualMessages || residualTokensIn || residualTokensOut) {
      const legacy = ensureAggregate(LEGACY_PROVIDER_ID, LEGACY_PROVIDER_NAME);
      legacy.sessions += residualSessions;
      legacy.messages += residualMessages;
      legacy.tokensIn += residualTokensIn;
      legacy.tokensOut += residualTokensOut;
      // Flat legacy counts predate cache capture by definition.
      legacy.source = mergeSource(legacy.source, 'estimate');
    }
  };

  // Rolled-up monthly buckets first, so `breakdownSince` reflects the earliest
  // month once old days have been collapsed. A `YYYY-MM` key overlaps the range
  // whenever its month is within the from/to months (compared at month prefix).
  const fromMonth = from ? from.slice(0, 7) : null;
  const toMonth = to ? to.slice(0, 7) : null;
  for (const [month, bucket] of Object.entries(monthlyActivity || {})) {
    if (bucket?.byProvider) {
      const monthStart = `${month}-01`;
      if (!breakdownSince || monthStart < breakdownSince) breakdownSince = monthStart;
    }
    if (fromMonth && month < fromMonth) continue;
    if (toMonth && month > toMonth) continue;
    if (bucket) foldBucket(bucket);
  }

  for (const [date, day] of Object.entries(dailyActivity || {})) {
    if (day?.byProvider && (!breakdownSince || date < breakdownSince)) breakdownSince = date;
    if (from && date < from) continue;
    if (to && date > to) continue;
    if (day) foldBucket(day);
  }

  // The legacy POST /usage/tokens path historically updated only all-time
  // totals. On an unbounded report, retain any portion not already represented
  // by day/month buckets without double-counting normal recorded messages.
  if (totalTokens) {
    const represented = [...agg.values()].reduce((sum, provider) => ({
      // `totalTokens.input` counts every billable input tier (see
      // recordMessages), so the represented side must include the cache tiers
      // too — otherwise a measured run's cache reads look unaccounted-for and
      // get re-added as a legacy residual, double-billing them.
      input: sum.input + provider.tokensIn + provider.cacheReadTokens + provider.cacheWriteTokens,
      output: sum.output + provider.tokensOut
    }), { input: 0, output: 0 });
    const residualIn = Math.max(0, (totalTokens.input || 0) - represented.input);
    const residualOut = Math.max(0, (totalTokens.output || 0) - represented.output);
    if (residualIn > 0 || residualOut > 0) {
      const legacy = ensureAggregate(LEGACY_PROVIDER_ID, LEGACY_PROVIDER_NAME);
      legacy.tokensIn += residualIn;
      legacy.tokensOut += residualOut;
      legacy.source = mergeSource(legacy.source, 'estimate');
    }
  }

  const totals = {
    sessions: 0,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0
  };
  const providerRows = [];

  for (const [pid, p] of agg.entries()) {
    const config = configById.get(pid);
    const free = isFreeProvider(config || pid);
    const providerRates = free ? null : resolveModelRates(pid === LEGACY_PROVIDER_ID ? null : pid, null);
    const models = [];
    let providerCost = 0;

    for (const [model, m] of p.byModel.entries()) {
      // The MODEL can be free even when the provider isn't: a Claude-Code-flavored
      // CLI pointed at a local Ollama/LM Studio backend keeps its `claude-*`
      // provider id (which `isFreeProvider` correctly reads as paid) while running
      // `qwen3.6:35b`. Without this per-model check the row resolves through the
      // `claude` provider default and invents cost for free local inference —
      // measured at $131 for one day of it.
      const freeModel = free || isFreeModelId(model);
      const rates = freeModel ? null : resolveModelRates(pid, model);
      const cost = freeModel ? 0 : estimateCostUsd(m.tokensIn, m.tokensOut, rates, m);
      providerCost += cost;
      models.push({
        model,
        sessions: m.sessions,
        messages: m.messages,
        tokensIn: m.tokensIn,
        tokensOut: m.tokensOut,
        cacheReadTokens: m.cacheReadTokens,
        cacheWriteTokens: m.cacheWriteTokens,
        source: m.source || 'estimate',
        estimatedCost: roundCents(cost),
        rateModel: rates?.rateModel ?? null,
        rateMatch: freeModel ? 'free' : rates.matched,
        inputPer1M: rates?.inputPer1M ?? 0,
        outputPer1M: rates?.outputPer1M ?? 0,
        cacheReadPer1M: rates?.cacheReadPer1M ?? 0,
        cacheWritePer1M: rates?.cacheWritePer1M ?? 0
      });
    }
    models.sort((a, b) => b.estimatedCost - a.estimatedCost || b.tokensOut - a.tokensOut);

    // Tokens recorded without a model id (older capture paths) still count
    // toward the provider row; price them at the provider-default rate.
    const modelTokensIn = models.reduce((s, m) => s + m.tokensIn, 0);
    const modelTokensOut = models.reduce((s, m) => s + m.tokensOut, 0);
    const modelCacheRead = models.reduce((s, m) => s + m.cacheReadTokens, 0);
    const modelCacheWrite = models.reduce((s, m) => s + m.cacheWriteTokens, 0);
    const unattributedIn = Math.max(0, p.tokensIn - modelTokensIn);
    const unattributedOut = Math.max(0, p.tokensOut - modelTokensOut);
    const unattributedCacheRead = Math.max(0, p.cacheReadTokens - modelCacheRead);
    const unattributedCacheWrite = Math.max(0, p.cacheWriteTokens - modelCacheWrite);
    if (!free && (unattributedIn > 0 || unattributedOut > 0 || unattributedCacheRead > 0 || unattributedCacheWrite > 0)) {
      providerCost += estimateCostUsd(unattributedIn, unattributedOut, providerRates, {
        cacheReadTokens: unattributedCacheRead,
        cacheWriteTokens: unattributedCacheWrite
      });
    }

    totals.sessions += p.sessions;
    totals.messages += p.messages;
    totals.tokensIn += p.tokensIn;
    totals.tokensOut += p.tokensOut;
    totals.cacheReadTokens += p.cacheReadTokens;
    totals.cacheWriteTokens += p.cacheWriteTokens;
    totals.estimatedCost += providerCost;

    providerRows.push({
      id: pid,
      name: p.name,
      free,
      // The subscription family this row's spend belongs to, stamped from the
      // config already in hand — so a consumer comparing plan cost against API
      // cost (lib/subscriptionSavings.js) groups rows without rebuilding this
      // provider-id → config map. Null for a row no plan covers.
      family: familyForProvider(config),
      sessions: p.sessions,
      messages: p.messages,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      cacheReadTokens: p.cacheReadTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      source: p.source || 'estimate',
      estimatedCost: roundCents(providerCost),
      rateMatch: pid === LEGACY_PROVIDER_ID
        ? 'fallback'
        : (models.some((model) => model.rateMatch !== 'exact' && model.rateMatch !== 'free') || unattributedIn > 0 || unattributedOut > 0
            ? (providerRates?.matched || 'fallback')
            : (free ? 'free' : 'exact')),
      models
    });
  }

  providerRows.sort((a, b) => b.estimatedCost - a.estimatedCost || b.tokensOut - a.tokensOut);
  totals.estimatedCost = roundCents(totals.estimatedCost);
  // Report-level provenance: `measured` only when every row that carries counts
  // was read from a provider transcript, so the UI can state plainly whether the
  // headline figure rests on measurements or estimates.
  totals.source = providerRows.reduce((acc, row) => mergeSource(acc, row.source), null) || 'estimate';

  return {
    range: { from, to },
    breakdownSince,
    pricingAsOf: PRICING_AS_OF,
    providers: providerRows,
    totals
  };
}

/**
 * Get usage summary. Optional `range` selects the cost-report window:
 * `{ from, to }` as inclusive YYYY-MM-DD strings (null = unbounded), plus the
 * live `providers` config list for free-classification.
 */
export function getUsageSummary({ from = null, to = null, providers = [] } = {}) {
  if (!usageData) {
    const empty = getEmptyUsage();
    // Generate empty last7Days
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      last7Days.push({
        date: date.toISOString().split('T')[0],
        label: date.toLocaleDateString('en-US', { weekday: 'short' }),
        sessions: 0,
        messages: 0,
        tokens: 0
      });
    }
    return {
      ...empty,
      last7Days,
      estimatedCost: 0,
      topProviders: [],
      topModels: [],
      report: buildUsageReport({}, { from, to, providers, monthlyActivity: {} })
    };
  }

  const cacheKey = JSON.stringify({
    day: new Date().toISOString().split('T')[0],
    from,
    to,
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      free: isFreeProvider(provider),
      family: familyForProvider(provider)
    }))
  });
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  // Get last 7 days activity
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const { sessions = 0, messages = 0, tokens = 0 } = usageData.dailyActivity[dateStr] || {};
    last7Days.push({ date: dateStr, label: date.toLocaleDateString('en-US', { weekday: 'short' }), sessions, messages, tokens });
  }

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
export async function resetUsage() {
  usageData = getEmptyUsage();
  await saveUsage();
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
    // LWW stamp on the wire — it moves on every `saveUsage`, and NOT on a mere
    // re-read, so a peer's checksum stays stable while nothing has happened.
    lastUpdated: source?.lastUpdated ?? null
  };
}
