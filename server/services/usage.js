import { join } from 'path';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { resolveModelRates, isFreeProvider, estimateCostUsd, PRICING_AS_OF } from '../lib/modelPricing.js';

const DATA_DIR = PATHS.data;
const USAGE_FILE = join(DATA_DIR, 'usage.json');

// Day buckets older than this are rolled up into monthly buckets at load time so
// dailyActivity (and therefore the whole-file rewrite on every AI run) stops growing
// linearly forever. 400 days keeps a full year-plus of per-day granularity — beyond
// any useful streak/report window — while collapsing everything older to per-month.
const ROLLUP_RETENTION_DAYS = 400;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

let usageData = null;

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

/**
 * Load usage data from disk
 */
export async function loadUsage() {
  await ensureDir(DATA_DIR);

  usageData = await readJSONFile(USAGE_FILE, null);
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
  const rolledUp = rollupOldDailyActivity(usageData.dailyActivity, usageData.monthlyActivity);
  if (rolledUp) {
    console.log(`📊 Rolled up old daily usage into ${Object.keys(usageData.monthlyActivity).length} monthly buckets`);
    await saveUsage();
  }

  console.log(`📊 Loaded usage: ${usageData.totalSessions} sessions, ${usageData.totalMessages} messages`);
  return usageData;
}

/**
 * Save usage data to disk
 */
async function saveUsage() {
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
 * Per-day per-provider per-model bucket inside dailyActivity — the additive
 * shape that makes arbitrary-period cost breakdowns possible. Legacy day
 * buckets (pre-upgrade) lack `byProvider`; breakdown reports are forward-only
 * from the first day that has it (see `breakdownSince`).
 */
function providerDayBucket(day, providerId, providerName) {
  if (!day.byProvider) day.byProvider = {};
  if (!day.byProvider[providerId]) {
    day.byProvider[providerId] = {
      name: providerName || providerId,
      sessions: 0,
      messages: 0,
      tokensIn: 0,
      tokensOut: 0,
      byModel: {}
    };
  }
  return day.byProvider[providerId];
}

function modelDayBucket(providerDay, model) {
  if (!providerDay.byModel[model]) {
    providerDay.byModel[model] = { sessions: 0, messages: 0, tokensIn: 0, tokensOut: 0 };
  }
  return providerDay.byModel[model];
}

function todayBucket() {
  const today = new Date().toISOString().split('T')[0];
  if (!usageData.dailyActivity[today]) {
    usageData.dailyActivity[today] = { sessions: 0, messages: 0, tokens: 0 };
  }
  return usageData.dailyActivity[today];
}

/**
 * Record a new session
 */
export async function recordSession(providerId, providerName, model) {
  if (!usageData) await loadUsage();

  usageData.totalSessions++;

  // Track by provider
  if (!usageData.byProvider[providerId]) {
    usageData.byProvider[providerId] = { name: providerName, sessions: 0, messages: 0, tokens: 0 };
  }
  usageData.byProvider[providerId].sessions++;

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
  const providerDay = providerDayBucket(day, providerId, providerName);
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
 */
export async function recordMessages(providerId, model, messageCount, outputTokens = 0, inputTokens = 0) {
  if (!usageData) await loadUsage();

  usageData.totalMessages += messageCount;

  if (outputTokens > 0) {
    usageData.totalTokens.output += outputTokens;
  }
  if (inputTokens > 0) {
    usageData.totalTokens.input += inputTokens;
  }

  // Track by provider / by model (the legacy all-time entries keep their
  // output-only `tokens` field for old readers — the in/out split lives only
  // in the day buckets, which is what the cost report aggregates)
  if (usageData.byProvider[providerId]) {
    usageData.byProvider[providerId].messages += messageCount;
    usageData.byProvider[providerId].tokens = (usageData.byProvider[providerId].tokens || 0) + outputTokens;
  }
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
  };
  const day = todayBucket();
  day.messages = (day.messages || 0) + messageCount;
  day.tokens = (day.tokens || 0) + outputTokens;
  const providerName = usageData.byProvider[providerId]?.name;
  const providerDay = providerDayBucket(day, providerId, providerName);
  bumpDayBucket(providerDay);
  if (model) bumpDayBucket(modelDayBucket(providerDay, model));

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
  await saveUsage();
}

/**
 * Calculate current activity streak (consecutive days with sessions)
 */
function calculateStreak(dailyActivity) {
  const today = new Date();
  let streak = 0;
  let checkDate = new Date(today);

  // Start from today and work backwards
  while (true) {
    const dateStr = checkDate.toISOString().split('T')[0];
    const dayData = dailyActivity[dateStr];

    if (dayData && dayData.sessions > 0) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (streak === 0) {
      // If today has no activity, check if yesterday started a streak
      checkDate.setDate(checkDate.getDate() - 1);
      const yesterdayStr = checkDate.toISOString().split('T')[0];
      const yesterdayData = dailyActivity[yesterdayStr];
      if (!yesterdayData || yesterdayData.sessions === 0) {
        break; // No streak
      }
      // Continue checking from yesterday
    } else {
      break; // Streak broken
    }
  }

  return streak;
}

/**
 * Find the longest streak in history
 */
function findLongestStreak(dailyActivity) {
  const dates = Object.keys(dailyActivity).sort();
  if (dates.length === 0) return 0;

  let maxStreak = 0;
  let currentStreak = 0;
  let prevDate = null;

  for (const dateStr of dates) {
    const dayData = dailyActivity[dateStr];
    if (!dayData || dayData.sessions === 0) continue;

    if (prevDate) {
      const prev = new Date(prevDate);
      const curr = new Date(dateStr);
      const diffDays = Math.round((curr - prev) / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        currentStreak++;
      } else {
        currentStreak = 1;
      }
    } else {
      currentStreak = 1;
    }

    maxStreak = Math.max(maxStreak, currentStreak);
    prevDate = dateStr;
  }

  return maxStreak;
}

const roundCents = (n) => Math.round(n * 100) / 100;

// The historical flat blended rate the all-time `estimatedCost` field has
// always used — kept so that field's meaning doesn't silently change for
// existing consumers. The accurate per-model number is `report.totals`.
const LEGACY_BLENDED_RATES = { inputPer1M: 3.0, outputPer1M: 15.0 };

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
 */
export function buildUsageReport(dailyActivity, { from = null, to = null, providers = [], monthlyActivity = null } = {}) {
  const configById = new Map((providers || []).map((p) => [p.id, p]));
  const agg = new Map(); // providerId -> { name, sessions, messages, tokensIn, tokensOut, byModel: Map }
  let breakdownSince = null;

  // Fold one bucket's per-provider/per-model splits into the running aggregate.
  const foldBucket = (bucket) => {
    for (const [pid, pDay] of Object.entries(bucket.byProvider)) {
      if (!agg.has(pid)) {
        agg.set(pid, { name: pDay.name || pid, sessions: 0, messages: 0, tokensIn: 0, tokensOut: 0, byModel: new Map() });
      }
      const p = agg.get(pid);
      p.sessions += pDay.sessions || 0;
      p.messages += pDay.messages || 0;
      p.tokensIn += pDay.tokensIn || 0;
      p.tokensOut += pDay.tokensOut || 0;
      for (const [model, mDay] of Object.entries(pDay.byModel || {})) {
        if (!p.byModel.has(model)) {
          p.byModel.set(model, { sessions: 0, messages: 0, tokensIn: 0, tokensOut: 0 });
        }
        const m = p.byModel.get(model);
        m.sessions += mDay.sessions || 0;
        m.messages += mDay.messages || 0;
        m.tokensIn += mDay.tokensIn || 0;
        m.tokensOut += mDay.tokensOut || 0;
      }
    }
  };

  // Rolled-up monthly buckets first, so `breakdownSince` reflects the earliest
  // month once old days have been collapsed. A `YYYY-MM` key overlaps the range
  // whenever its month is within the from/to months (compared at month prefix).
  const fromMonth = from ? from.slice(0, 7) : null;
  const toMonth = to ? to.slice(0, 7) : null;
  for (const [month, bucket] of Object.entries(monthlyActivity || {})) {
    if (!bucket?.byProvider) continue;
    const monthStart = `${month}-01`;
    if (!breakdownSince || monthStart < breakdownSince) breakdownSince = monthStart;
    if (fromMonth && month < fromMonth) continue;
    if (toMonth && month > toMonth) continue;
    foldBucket(bucket);
  }

  for (const [date, day] of Object.entries(dailyActivity || {})) {
    if (!day?.byProvider) continue;
    if (!breakdownSince || date < breakdownSince) breakdownSince = date;
    if (from && date < from) continue;
    if (to && date > to) continue;
    foldBucket(day);
  }

  const totals = { sessions: 0, messages: 0, tokensIn: 0, tokensOut: 0, estimatedCost: 0 };
  const providerRows = [];

  for (const [pid, p] of agg.entries()) {
    const config = configById.get(pid);
    const free = isFreeProvider(config || pid);
    const models = [];
    let providerCost = 0;

    for (const [model, m] of p.byModel.entries()) {
      const rates = free ? null : resolveModelRates(pid, model);
      const cost = free ? 0 : estimateCostUsd(m.tokensIn, m.tokensOut, rates);
      providerCost += cost;
      models.push({
        model,
        sessions: m.sessions,
        messages: m.messages,
        tokensIn: m.tokensIn,
        tokensOut: m.tokensOut,
        estimatedCost: roundCents(cost),
        rateModel: rates?.rateModel ?? null,
        rateMatch: free ? 'free' : rates.matched,
        inputPer1M: rates?.inputPer1M ?? 0,
        outputPer1M: rates?.outputPer1M ?? 0
      });
    }
    models.sort((a, b) => b.estimatedCost - a.estimatedCost || b.tokensOut - a.tokensOut);

    // Tokens recorded without a model id (older capture paths) still count
    // toward the provider row; price them at the provider-default rate.
    const modelTokensIn = models.reduce((s, m) => s + m.tokensIn, 0);
    const modelTokensOut = models.reduce((s, m) => s + m.tokensOut, 0);
    const unattributedIn = Math.max(0, p.tokensIn - modelTokensIn);
    const unattributedOut = Math.max(0, p.tokensOut - modelTokensOut);
    if (!free && (unattributedIn > 0 || unattributedOut > 0)) {
      providerCost += estimateCostUsd(unattributedIn, unattributedOut, resolveModelRates(pid, null));
    }

    totals.sessions += p.sessions;
    totals.messages += p.messages;
    totals.tokensIn += p.tokensIn;
    totals.tokensOut += p.tokensOut;
    totals.estimatedCost += providerCost;

    providerRows.push({
      id: pid,
      name: p.name,
      free,
      sessions: p.sessions,
      messages: p.messages,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      estimatedCost: roundCents(providerCost),
      models
    });
  }

  providerRows.sort((a, b) => b.estimatedCost - a.estimatedCost || b.tokensOut - a.tokensOut);
  totals.estimatedCost = roundCents(totals.estimatedCost);

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
      currentStreak: 0,
      longestStreak: 0,
      last7Days,
      estimatedCost: 0,
      topProviders: [],
      topModels: [],
      report: buildUsageReport({}, { from, to, providers, monthlyActivity: {} })
    };
  }

  // Get last 7 days activity
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const { sessions = 0, messages = 0, tokens = 0 } = usageData.dailyActivity[dateStr] || {};
    last7Days.push({ date: dateStr, label: date.toLocaleDateString('en-US', { weekday: 'short' }), sessions, messages, tokens });
  }

  // Calculate streaks
  const currentStreak = calculateStreak(usageData.dailyActivity);
  const longestStreak = findLongestStreak(usageData.dailyActivity);

  const report = buildUsageReport(usageData.dailyActivity, { from, to, providers, monthlyActivity: usageData.monthlyActivity });

  return {
    totalSessions: usageData.totalSessions,
    totalMessages: usageData.totalMessages,
    totalToolCalls: usageData.totalToolCalls,
    totalTokens: usageData.totalTokens,
    estimatedCost: roundCents(estimateCostUsd(usageData.totalTokens.input, usageData.totalTokens.output, LEGACY_BLENDED_RATES)),
    currentStreak,
    longestStreak,
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
}

/**
 * Reset usage data
 */
export async function resetUsage() {
  usageData = getEmptyUsage();
  await saveUsage();
  return true;
}

// Load on startup
loadUsage().catch(err => console.error(`❌ Failed to load usage: ${err.message}`));
