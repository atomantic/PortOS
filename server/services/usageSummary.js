/** Build dashboard summaries and aggregate-only peer digests from committed usage. */
import { isFreeProvider } from '../lib/modelPricing.js';
import { familyForProvider } from '../lib/provider/providerFamilies.js';
import { nativeUsageSignature, withNativeUsage } from './nativeUsageHistory.js';
import { DAY_KEY_RE, findEarliestActivityDay, getEmptyUsage, rollupOldDailyActivity } from '../lib/usageBuckets.js';
import { buildUsageReport } from '../lib/usageReport.js';

const SUMMARY_CACHE_LIMIT = 20;

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

/** The trailing seven calendar days, oldest first, each filled from `dailyActivity` (zeros when absent). */
function buildLast7Days(dailyActivity, today) {
  const last7Days = [];
  // Encode the local calendar date in UTC for day arithmetic across DST.
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 6);
  for (let i = 0; i < 7; i++) {
    const dateStr = date.toISOString().slice(0, 10);
    const { sessions = 0, messages = 0, tokens = 0 } = dailyActivity?.[dateStr] || {};
    last7Days.push({ date: dateStr, label: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }), sessions, messages, tokens });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return last7Days;
}

/**
 * Get usage summary. Optional `range` selects the cost-report window:
 * `{ from, to }` as inclusive YYYY-MM-DD strings (null = unbounded), plus the
 * live `providers` config list for free-classification.
 */
export function buildUsageSummary(committedUsage, today, summaryCache, { from = null, to = null, providers = [] } = {}) {
  const usageData = withNativeUsage(committedUsage, providers);
  if (!usageData) {
    const empty = getEmptyUsage();
    const last7Days = buildLast7Days({}, today);
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
    day: today,
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

  const last7Days = buildLast7Days(usageData.dailyActivity, today);

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
      blocks: (Array.isArray(committedUsage?.blockEvents) ? committedUsage.blockEvents : []).slice(-20).map((event) => ({
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
export function buildUsageDigest(source, { retentionDays = DIGEST_DAILY_RETENTION_DAYS, now = new Date() } = {}) {
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
