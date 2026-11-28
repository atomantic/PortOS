/** Shared usage bucket shapes, count adjustments and daily-to-monthly rollup transforms. */
import { POLLUTING_KEYS } from './objects.js';
import { countFields } from './usageReport.js';

// Day buckets older than this are rolled up into monthly buckets at load time so
// dailyActivity (and therefore the in-memory report) stops growing
// linearly forever. 400 days keeps a full year-plus of per-day granularity — beyond
// any useful streak/report window — while collapsing everything older to per-month.
const ROLLUP_RETENTION_DAYS = 400;
export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

/**
 * Initialize usage data structure
 */
export function getEmptyUsage() {
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
export function deepSumInto(target, source) {
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

export const findEarliestActivityDay = (dailyActivity, monthlyActivity) => {
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

export const adjustCounts = (bucket, counts, direction) => {
  if (!bucket) return;
  for (const field of countFields) {
    const delta = direction * Math.max(0, counts?.[field] || 0);
    // A zero delta must not stamp a new key onto a pre-existing bucket.
    if (!delta && bucket[field] == null) continue;
    bucket[field] = Math.max(0, (bucket[field] || 0) + delta);
  }
};

export { rebuildDayTotals } from './usageFields.js';

export const cacheActivityDay = (usageData, day) => {
  if (!DAY_KEY_RE.test(day)) return;
  if (!usageData.earliestActivityDay || day < usageData.earliestActivityDay) {
    usageData.earliestActivityDay = day;
  }
};

// A sibling-only correction can target a day that has no bucket for the
// PARENT provider (the run may predate provider/model breakdowns entirely),
// so the day itself is created on demand rather than required.
export function datedUsageDay(usageData, dayKey) {
  if (!usageData.dailyActivity[dayKey]) {
    usageData.dailyActivity[dayKey] = { sessions: 0, messages: 0, tokens: 0, byProvider: {} };
    cacheActivityDay(usageData, dayKey);
  }
  return usageData.dailyActivity[dayKey];
}
