/**
 * Pure usage-report builder: folds per-day / per-month provider+model buckets into a priced cost report, plus the counter primitives and row-cost helpers the ledger shares with it.
 */
import { resolveModelRates, isFreeProvider, isFreeModelId, estimateCostUsd, estimateGrokImagineCost, estimateAgyImageCost, serviceTierExtra, PRICING_AS_OF } from './modelPricing.js';
import { TOKEN_TIER_FIELDS, USAGE_COUNT_FIELDS } from './usageFields.js';
import { familyForProvider, familyForProviderId } from './provider/providerFamilies.js';
import { roundCents } from './subscriptionSavings.js';
import { POLLUTING_KEYS } from './objects.js';

export const UNKNOWN_PROVIDER_ID = 'unknown';
export const UNKNOWN_PROVIDER_NAME = 'Unknown provider';
export const LEGACY_PROVIDER_ID = 'legacy';
export const LEGACY_PROVIDER_NAME = 'Pre-breakdown (legacy)';

// Provider ids and model names index plain-object maps (`byProvider`,
// `byModel`) and reach here from POST /api/usage/*. A name like `__proto__`
// would resolve to Object.prototype and the counter bump would write onto
// every object in the process, so such a name is never used as a key.
export const isUsageKey = (value) => typeof value === 'string' && value.trim() !== '' && !POLLUTING_KEYS.has(value.trim());
export const usageModelKey = (model) => (isUsageKey(model) ? model : null);

export const normalizeProvider = (providerId, providerName = null) => {
  const id = isUsageKey(providerId) && providerId.trim() !== 'undefined'
    ? providerId.trim()
    : UNKNOWN_PROVIDER_ID;
  return {
    id,
    name: id === UNKNOWN_PROVIDER_ID
      ? UNKNOWN_PROVIDER_NAME
      : (providerName || id)
  };
};

// `long*` and speed tiers are subsets of the base token fields (already included
// there), priced a second time by the report. `images` / `videoSeconds` /
// `inputImages` are Imagine units, priced by estimateGrokImagineCost rather than as tokens.
export const countFields = USAGE_COUNT_FIELDS;

// Every counter the usage report carries per provider, model and total; the
// single list the report builder zero-inits, accumulates and projects from.
const USAGE_COUNTER_FIELDS = ['sessions', ...countFields];
const emptyUsageCounters = () => Object.fromEntries(USAGE_COUNTER_FIELDS.map((field) => [field, 0]));
const addUsageCounters = (target, source) => {
  for (const field of USAGE_COUNTER_FIELDS) target[field] += source[field] || 0;
};
const pickUsageCounters = (source) => Object.fromEntries(USAGE_COUNTER_FIELDS.map((field) => [field, source[field]]));

export const hasUsageCounts = (bucket) => countFields.some((field) => (bucket?.[field] || 0) > 0);

/**
 * Merge a new measurement source into a bucket's existing one. A bucket that has
 * only ever seen one kind keeps that kind; mixing measured and estimated counts
 * downgrades it to `mixed` so the UI can't present a partly-estimated row as
 * ground truth. Absent (legacy buckets) is treated as `estimate` — that is what
 * every pre-#3124 bucket actually holds.
 */
export function mergeSource(existing, incoming) {
  if (!incoming) return existing ?? null;
  // `null` = a bucket we just created that holds no counts yet, so the incoming
  // source becomes its source outright. `undefined` = a bucket written before
  // this field existed, whose counts are estimates by definition.
  const current = existing === null ? null : (existing ?? 'estimate');
  if (!current) return incoming;
  return current === incoming ? current : 'mixed';
}

/** Cost of one already-included subset. `factor` is the increment (1 = one extra base charge). */
function subsetCost(counts, rates, prefix, factor) {
  if (!rates || !factor) return 0;
  return factor * estimateCostUsd(counts?.[`${prefix}TokensIn`], counts?.[`${prefix}TokensOut`], rates, {
    cacheReadTokens: counts?.[`${prefix}CacheReadTokens`],
    cacheWriteTokens: counts?.[`${prefix}CacheWriteTokens`],
  });
}

/** Fast/Ultrafast extras apply only when the rate model is a published id, not a family fallback. */
function publishedTierFactor(rates, tier) {
  if (rates?.pricedBy !== 'published') return 0;
  return serviceTierExtra(rates.rateModel, tier);
}

/**
 * Base token cost, plus one extra base-rate charge for the long-context
 * subset, plus the published Fast/Ultrafast increment on those subsets, plus
 * Imagine unit cost. Every subset is already inside the base counts.
 */
export function usageRowCost(modelId, counts, rates, free) {
  if (free) return 0;
  const tokens = rates ? estimateCostUsd(counts?.tokensIn, counts?.tokensOut, rates, counts) : 0;
  const premium = subsetCost(counts, rates, 'long', 1);
  const fast = subsetCost(counts, rates, 'fast', publishedTierFactor(rates, 'fast'));
  const ultrafast = subsetCost(counts, rates, 'ultrafast', publishedTierFactor(rates, 'ultrafast'));
  return tokens + premium + fast + ultrafast + estimateGrokImagineCost(modelId, counts) + estimateAgyImageCost(modelId, counts);
}

// ---- report aggregation ----------------------------------------------------
// `ctx` carries the mutable fold state: { configById, agg, includeObservations, breakdownSince }.

function classifyProvider(ctx, pid, classes) {
  if (classes === undefined) {
    const config = ctx.configById.get(pid);
    return { known: true, free: isFreeProvider(config || pid), family: config ? familyForProvider(config) : familyForProviderId(pid) };
  }
  const value = classes?.[pid];
  return value ? { known: true, free: value.free, family: value.family } : { known: false, free: false, family: null };
}

function ensureAggregate(ctx, pid, name, classes) {
  const billing = classifyProvider(ctx, pid, classes);
  const key = JSON.stringify([pid, billing.known, billing.free, billing.family]);
  if (!ctx.agg.has(key)) {
    ctx.agg.set(key, {
      id: pid,
      name,
      billing,
      ...emptyUsageCounters(),
      source: null,
      byModel: new Map(),
      observations: { from: null, to: null, resolutions: new Set(), hasUndatedUsage: false },
    });
  }
  return ctx.agg.get(key);
}

function observeUsage(ctx, provider, period) {
  if (!ctx.includeObservations) return;
  const observed = provider.observations;
  if (!period) { observed.hasUndatedUsage = true; return; }
  const monthly = period.length === 7;
  const first = monthly ? `${period}-01` : period;
  const last = monthly ? new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10) : period;
  if (!observed.from || first < observed.from) observed.from = first;
  if (!observed.to || last > observed.to) observed.to = last;
  observed.resolutions.add(monthly ? 'month' : 'day');
}

function foldModels(p, pDay) {
  for (const [model, mDay] of Object.entries(pDay.byModel || {})) {
    if (!p.byModel.has(model)) {
      p.byModel.set(model, { ...emptyUsageCounters(), source: null });
    }
    const m = p.byModel.get(model);
    addUsageCounters(m, mDay);
    m.source = mergeSource(m.source, mDay.source || (hasUsageCounts(mDay) ? 'estimate' : null));
  }
}

// Fold a bucket's provider/model splits and any residual flat legacy counts.
// Monthly rollups can contain both shapes when their source month straddled
// the provider-breakdown rollout.
function foldUsageBucket(ctx, bucket, classes, period) {
  const represented = { sessions: 0, messages: 0, tokensIn: 0, tokensOut: 0 };
  for (const [pid, pDay] of Object.entries(bucket.byProvider || {})) {
    const normalized = normalizeProvider(pid, pDay.name);
    const p = ensureAggregate(ctx, normalized.id, normalized.name, classes);
    addUsageCounters(p, pDay);
    if (hasUsageCounts(pDay)) observeUsage(ctx, p, period);
    // A bucket with counts but no `source` predates the field — those counts
    // are estimates, so fold it in as such rather than leaving the row
    // unlabeled and letting the UI imply it was measured.
    p.source = mergeSource(p.source, hasUsageCounts(pDay) && !pDay.source ? 'estimate' : pDay.source);
    for (const field of Object.keys(represented)) represented[field] += pDay[field] || 0;
    foldModels(p, pDay);
  }
  const residualSessions = Math.max(0, (bucket.sessions || 0) - represented.sessions);
  const residualMessages = Math.max(0, (bucket.messages || 0) - represented.messages);
  const residualTokensIn = Math.max(0, (bucket.tokensIn || 0) - represented.tokensIn);
  const bucketTokensOut = typeof bucket.tokensOut === 'number' ? bucket.tokensOut : (bucket.tokens || 0);
  const residualTokensOut = Math.max(0, bucketTokensOut - represented.tokensOut);
  if (residualSessions || residualMessages || residualTokensIn || residualTokensOut) {
    const legacy = ensureAggregate(ctx, LEGACY_PROVIDER_ID, LEGACY_PROVIDER_NAME, classes);
    observeUsage(ctx, legacy, period);
    legacy.sessions += residualSessions;
    legacy.messages += residualMessages;
    legacy.tokensIn += residualTokensIn;
    legacy.tokensOut += residualTokensOut;
    // Flat legacy counts predate cache capture by definition.
    legacy.source = mergeSource(legacy.source, 'estimate');
  }
}

function representedCounters(ctx) {
  return [...ctx.agg.values()].reduce((sum, provider) => ({
    // `totalTokens.input` counts every billable input tier (see
    // applyMessageUsage in usage.js), so the represented side must include the cache tiers
    // too — otherwise a measured run's cache reads look unaccounted-for and
    // get re-added as a legacy residual, double-billing them.
    input: sum.input + provider.tokensIn + provider.cacheReadTokens + provider.cacheWriteTokens,
    output: sum.output + provider.tokensOut,
    sessions: sum.sessions + provider.sessions,
    messages: sum.messages + provider.messages,
  }), { input: 0, output: 0, sessions: 0, messages: 0 });
}

// Keep each origin's legacy residual separate: an overrepresented bucket on
// one machine must not conceal unbucketed tokens on another.
function foldSourceResiduals(ctx, source, before) {
  const after = representedCounters(ctx);
  const residualIn = Math.max(0, (source.totalTokens?.input || 0) - (after.input - before.input));
  const residualOut = Math.max(0, (source.totalTokens?.output || 0) - (after.output - before.output));
  const residualSessions = Math.max(0, (source.totalSessions || 0) - (after.sessions - before.sessions));
  const residualMessages = Math.max(0, (source.totalMessages || 0) - (after.messages - before.messages));
  if (!(residualIn || residualOut || residualSessions || residualMessages)) return;
  const legacy = ensureAggregate(ctx, LEGACY_PROVIDER_ID, LEGACY_PROVIDER_NAME, source.providerClasses);
  observeUsage(ctx, legacy, null);
  legacy.tokensIn += residualIn;
  legacy.tokensOut += residualOut;
  legacy.sessions += residualSessions;
  legacy.messages += residualMessages;
  legacy.source = mergeSource(legacy.source, 'estimate');
}

function foldSource(ctx, source, from, to) {
  const before = representedCounters(ctx);
  const fromMonth = from ? from.slice(0, 7) : null;
  const toMonth = to ? to.slice(0, 7) : null;
  for (const [month, bucket] of Object.entries(source.monthlyActivity || {})) {
    if (bucket?.byProvider) {
      const monthStart = `${month}-01`;
      if (!ctx.breakdownSince || monthStart < ctx.breakdownSince) ctx.breakdownSince = monthStart;
    }
    if (fromMonth && month < fromMonth) continue;
    if (toMonth && month > toMonth) continue;
    if (bucket) foldUsageBucket(ctx, bucket, source.providerClasses, month);
  }
  for (const [date, day] of Object.entries(source.dailyActivity || {})) {
    if (day?.byProvider && (!ctx.breakdownSince || date < ctx.breakdownSince)) ctx.breakdownSince = date;
    if (from && date < from) continue;
    if (to && date > to) continue;
    if (day) foldUsageBucket(ctx, day, source.providerClasses, date);
  }
  if (source.totalTokens || source.totalSessions != null || source.totalMessages != null) {
    foldSourceResiduals(ctx, source, before);
  }
}

// Every counter whose model-attributed total can fall short of the provider's:
// the four base fields plus the long/fast/ultrafast subsets of each.
const GAP_FIELDS = TOKEN_TIER_FIELDS;

/**
 * Tokens recorded without a model id (older capture paths) still count toward
 * the provider row. One pass over the model rows sums every tracked counter;
 * `gap` is what the provider carries beyond them, `pending` whether any is > 0.
 */
export function computeUnattributedGaps(provider, models) {
  const modelSums = Object.fromEntries(GAP_FIELDS.map((field) => [field, 0]));
  for (const row of models) {
    for (const field of GAP_FIELDS) modelSums[field] += row[field] || 0;
  }
  const gap = {};
  let pending = false;
  for (const field of GAP_FIELDS) {
    gap[field] = Math.max(0, (provider[field] || 0) - modelSums[field]);
    if (gap[field] > 0) pending = true;
  }
  return { gap, pending };
}

function buildModelRow(model, m, { pid, known, free, includeCost }) {
  // The MODEL can be free even when the provider isn't: a Claude-Code-flavored
  // CLI pointed at a local Ollama/LM Studio backend keeps its `claude-*`
  // provider id (which `isFreeProvider` correctly reads as paid) while running
  // `qwen3.6:35b`. Without this per-model check the row resolves through the
  // `claude` provider default and invents cost for free local inference —
  // measured at $131 for one day of it.
  const freeModel = free || isFreeModelId(model);
  const rates = freeModel ? null : resolveModelRates(pid, model);
  // The long-context subset is already inside the base counts. One extra
  // pass at the same short rates is the missing half of xAI's 2× bill.
  // Imagine units are not tokens; they price off the model id.
  const cost = includeCost ? usageRowCost(model, m, rates, freeModel) : 0;
  return {
    cost,
    row: {
      model,
      ...pickUsageCounters(m),
      source: m.source || 'estimate',
      estimatedCost: known ? roundCents(cost) : null,
      rawEstimatedCost: known ? cost : null,
      rateModel: rates?.rateModel ?? null,
      rateMatch: freeModel ? 'free' : rates.matched,
      inputPer1M: rates?.inputPer1M ?? 0,
      outputPer1M: rates?.outputPer1M ?? 0,
      cacheReadPer1M: rates?.cacheReadPer1M ?? 0,
      cacheWritePer1M: rates?.cacheWritePer1M ?? 0
    },
  };
}

function observationsRow(observations) {
  const { resolutions, hasUndatedUsage } = observations;
  return {
    from: observations.from,
    to: observations.to,
    hasUndatedUsage,
    resolution: resolutions.size === 0 ? 'undated'
      : resolutions.size > 1 || hasUndatedUsage ? 'mixed' : [...resolutions][0],
  };
}

function providerRateMatch({ pid, free, models, gap, providerRates }) {
  if (pid === LEGACY_PROVIDER_ID) return 'fallback';
  const approximate = models.some((model) => model.rateMatch !== 'exact' && model.rateMatch !== 'free')
    || gap.tokensIn > 0 || gap.tokensOut > 0;
  if (approximate) return providerRates?.matched || 'fallback';
  return free ? 'free' : 'exact';
}

/** Price one aggregate into its provider row and cost; `cost` feeds the report totals. */
export function buildProviderRow(rowKey, p, includeObservations) {
  const pid = p.id;
  const { known, free, family } = p.billing;
  const providerRates = free ? null : resolveModelRates(pid === LEGACY_PROVIDER_ID ? null : pid, null);
  const models = [];
  let providerCost = 0;

  for (const [model, m] of p.byModel.entries()) {
    const { cost, row } = buildModelRow(model, m, { pid, known, free, includeCost: known });
    providerCost += cost;
    models.push(row);
  }
  models.sort((a, b) => b.estimatedCost - a.estimatedCost || b.tokensOut - a.tokensOut);

  // Unattributed tokens are priced at the provider-default rate.
  const { gap, pending } = computeUnattributedGaps(p, models);
  if (known && !free && pending) {
    providerCost += usageRowCost(null, gap, providerRates, false);
  }

  const row = {
    id: pid,
    rowKey,
    name: p.name,
    free: known ? free : null,
    // The subscription family this row's spend belongs to, stamped from the
    // config already in hand — so a consumer comparing plan cost against API
    // cost (lib/subscriptionSavings.js) groups rows without rebuilding this
    // provider-id → config map. Null for a row no plan covers.
    family,
    classificationKnown: known,
    ...(includeObservations ? { observations: observationsRow(p.observations) } : {}),
    ...pickUsageCounters(p),
    source: p.source || 'estimate',
    estimatedCost: known ? roundCents(providerCost) : null,
    rawEstimatedCost: known ? providerCost : null,
    rateMatch: providerRateMatch({ pid, free, models, gap, providerRates }),
    models
  };
  return { row, cost: providerCost };
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
export function buildUsageReport(dailyActivity, { from = null, to = null, providers = [], monthlyActivity = null, totalTokens = null, totalSessions = null, totalMessages = null, providerClasses = undefined, additionalSources = [], includeObservations = false } = {}) {
  const ctx = {
    configById: new Map((providers || []).map((p) => [p.id, p])),
    agg: new Map(), // row key -> { id, name, counters, byModel: Map, ... }
    includeObservations,
    breakdownSince: null,
  };

  for (const source of [{ dailyActivity, monthlyActivity, totalTokens, totalSessions, totalMessages, providerClasses }, ...additionalSources]) {
    foldSource(ctx, source, from, to);
  }

  const totals = { ...emptyUsageCounters(), estimatedCost: 0 };
  const providerRows = [];
  for (const [rowKey, p] of ctx.agg.entries()) {
    const { row, cost } = buildProviderRow(rowKey, p, includeObservations);
    addUsageCounters(totals, p);
    totals.estimatedCost += cost;
    if (!p.billing.known && hasUsageCounts(p)) totals.costIncomplete = true;
    providerRows.push(row);
  }

  providerRows.sort((a, b) => b.estimatedCost - a.estimatedCost || b.tokensOut - a.tokensOut);
  totals.rawEstimatedCost = totals.estimatedCost;
  totals.estimatedCost = roundCents(totals.estimatedCost);
  // Report-level provenance: `measured` only when every row that carries counts
  // was read from a provider transcript, so the UI can state plainly whether the
  // headline figure rests on measurements or estimates.
  totals.source = providerRows.reduce((acc, row) => mergeSource(acc, row.source), null) || 'estimate';

  return {
    range: { from, to },
    breakdownSince: ctx.breakdownSince,
    pricingAsOf: PRICING_AS_OF,
    providers: providerRows,
    totals
  };
}
