import { Router } from 'express';
import * as usage from '../services/usage.js';
import { readLocalTranscriptUsage, refreshLocalTranscriptUsage } from '../services/claudeCodeTranscriptUsage.js';
import { nativeUsageEvents } from '../services/nativeUsageEvents.js';
import { describeNativeUsageSources, refreshNativeUsageHistory } from '../services/nativeUsageHistory.js';
import { dismissUsageRetentionTip, getUsageRetentionTips } from '../services/usageRetentionTips.js';
import { assertHostControl, requestHasHostControl } from '../services/authGate.js';
import { getProviderQuotas } from '../services/provider/providerUsage.js';
import { getAllProviders } from '../services/provider/providers.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { saveSubscriptionCosts, getSubscriptionSavings } from '../services/subscriptionCosts.js';
import { getSubscriptionOverview, savePlanTiers, setSubscriptionEnabled } from '../services/subscriptions.js';
import { getFleetUsage, getFleetClaudeCodeModels, getFleetRollingCost } from '../services/peerUsage.js';
import { getApiBilledInstanceIds, setInstanceUsesSubscriptions } from '../services/usageFleetBilling.js';
import { resolveUsageRange } from '../lib/usageRange.js';
import { WAIT } from '../lib/staleWhileRevalidate.js';
import {
  getHistoricalUsageBackfillStatus,
  startHistoricalUsageBackfill
} from '../services/usageBackfill.js';
import {
  usageQuerySchema, providerUsageQuerySchema, subscriptionsUpdateSchema,
  subscriptionEnabledSchema, usageFleetBillingSchema, usageRollingCostQuerySchema, usageTipParamsSchema
} from '../lib/usageValidation.js';

const router = Router();

// GET /api/usage - Usage summary + cost report. Accepts ?period=7d|30d|90d|all
// or an explicit ?from/?to (YYYY-MM-DD, inclusive) for the report window.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(usageQuerySchema, req.query);
  // Answers from the stored native history at once; a stale store refreshes in
  // the background and `usage:native-history-updated` tells the page to refetch.
  refreshNativeUsageHistory().catch((err) => console.error(`❌ Native usage refresh failed: ${err.message}`));
  const { from, to } = resolveUsageRange(query);
  const result = await getAllProviders();
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  const summary = usage.getUsageSummary({ from, to, providers });
  const apiBilledInstanceIds = await getApiBilledInstanceIds();
  const fleetResult = await getFleetUsage({ from, to, providers, apiBilledInstanceIds });
  const { report, subscriptionReport, subscriptionFirstActivityDay, activity, last7Days, hourlyActivity, totalToolCalls, coverage, monthly, transcriptUpdatedAt, imageRenders, blocks, firstActivityDay: _firstActivityDay, ...fleet } = fleetResult;
  const subscriptionSavings = await getSubscriptionSavings({
    report: subscriptionReport, providers, from, to, firstActivityDay: from ? null : subscriptionFirstActivityDay,
  });
  subscriptionSavings.costIncomplete ||= Boolean(coverage.subscriptionIncomplete);
  res.json({
    ...summary,
    report,
    totalSessions: report.totals.sessions,
    totalMessages: report.totals.messages,
    totalToolCalls,
    totalTokens: {
      input: report.totals.tokensIn + report.totals.cacheReadTokens + report.totals.cacheWriteTokens,
      output: report.totals.tokensOut,
    },
    estimatedCost: report.totals.estimatedCost,
    last7Days,
    topProviders: report.providers.map((row) => ({ ...row, tokens: row.tokensIn + row.tokensOut })),
    topModels: report.providers.flatMap((row) => row.models.map((model) => ({ ...model, tokens: model.tokensIn + model.tokensOut }))),
    subscriptionSavings,
    fleet,
    coverage,
    activity,
    hourlyActivity,
    transcriptUpdatedAt,
    freeTier: {
      ...summary.freeTier,
      providers: report.providers.filter((row) => row.free),
      blocks,
      blocksIncomplete: coverage.blockEventsUnreported?.length > 0 || coverage.missingInstances.length > 0,
    },
    imageRenders,
    nativeSources: describeNativeUsageSources(),
    monthlyHistory: monthly.history,
    monthlySeries: monthly.series,
    monthlyInstanceCount: monthly.instanceCount,
    monthlyRangeTooWide: monthly.rangeTooWide || false,
  });
}));

// GET /api/usage/rolling-cost - Trailing-30-day estimated API cost summed across
// every instance, one point per day over ?range=1m|3m|6m|1y|all (default 3m).
router.get('/rolling-cost', asyncHandler(async (req, res) => {
  const { range } = validateRequest(usageRollingCostQuerySchema, req.query);
  const result = await getAllProviders();
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  res.json(await getFleetRollingCost({ providers, range }));
}));

// GET /api/usage/tips - Retention settings this machine's CLIs still need so
// their session history stays readable. Reads the CLI config; never writes it.
router.get('/tips', asyncHandler(async (req, res) => {
  res.json({ tips: await getUsageRetentionTips() });
}));

// POST /api/usage/tips/:id/dismiss - The user says it's handled; hide it here.
router.post('/tips/:id/dismiss', asyncHandler(async (req, res) => {
  const { id } = validateRequest(usageTipParamsSchema, req.params);
  res.json({ tips: await dismissUsageRetentionTip(id) });
}));

// GET /api/usage/subscriptions - The Subscriptions page's own model: one row
// per manageable plan (enabled state, plan tier, monthly price, the provider
// records the toggle fans out to). The savings/spend figures for those rows
// come from GET /api/usage; the quota meters from GET /api/usage/providers.
router.get('/subscriptions', asyncHandler(async (req, res) => {
  res.json(await getSubscriptionOverview());
}));

// PUT /api/usage/subscriptions - Merge plan prices and/or plan tiers. Within
// each map an omitted family keeps its stored value; one sent as null (or 0 /
// "") is cleared. The two maps are independent, so a tier save never rewrites
// a price and vice versa.
//
// Both slices land in ONE request, and the response is the refreshed row set —
// so the editor applies a save without a follow-up GET, and a row where the
// user changed both the price and the tier costs one round trip, not two.
router.put('/subscriptions', asyncHandler(async (req, res) => {
  const { costs, tiers } = validateRequest(subscriptionsUpdateSchema, req.body);
  if (costs !== undefined) await saveSubscriptionCosts(costs, { actor: 'user' });
  if (tiers !== undefined) await savePlanTiers(tiers, { actor: 'user' });
  res.json(await getSubscriptionOverview());
}));

// PUT /api/usage/subscriptions/enabled - Switch one subscription on or off by
// flipping `enabled` across every provider record in that family — PortOS-side
// enablement only. It never reaches the vendor's billing system: nothing here
// purchases, cancels or changes a plan at Anthropic, OpenAI, Google or xAI.
//
// A priced family with no providers configured answers `applied: false` rather
// than 404: the row legitimately exists so its price stays visible, there is
// just nothing local to toggle. The refreshed rows ride along for the same
// reason as above.
router.put('/subscriptions/enabled', asyncHandler(async (req, res) => {
  const { family, enabled } = validateRequest(subscriptionEnabledSchema, req.body);
  const outcome = await setSubscriptionEnabled(family, enabled);
  res.json({ ...outcome, ...(await getSubscriptionOverview()) });
}));

// PUT /api/usage/fleet-billing - Mark one federated instance as paying API
// rates (`usesSubscriptions: false`) or riding the viewer's subscriptions
// (`true`). The Across Instances combined total skips API-billed rows.
router.put('/fleet-billing', asyncHandler(async (req, res) => {
  const { instanceId, usesSubscriptions } = validateRequest(usageFleetBillingSchema, req.body);
  const apiBilledInstanceIds = await setInstanceUsesSubscriptions(instanceId, usesSubscriptions, { actor: 'user' });
  res.json({ instanceId, usesSubscriptions, apiBilledInstanceIds });
}));

// GET /api/usage/providers - Subscription-quota status for every enabled
// provider family (claude, codex, agy, grok). Providers without a queryable
// usage surface report `supported: false`.
//
// A regular operator read never blocks on a slow reading. A cached
// one is served immediately (and revalidated behind the response); a cold one
// comes back as a `pending: true` card the UI renders as "reading…" and polls.
// Holding an HTTP response open for a 10-20s PTY spawn is what made this page —
// and Quota Burn — look broken, and it is the shape that trips proxy timeouts.
// `?refresh=1` requires host control and waits for a live reading. Other
// callers only read saved observations.
//
// `?family=<id>` narrows the read to a single card, so the page's per-card
// Refresh re-reads only the provider the user clicked instead of respawning
// every provider's TUI scrape. An id that no longer resolves to an enabled
// family answers with an empty list — the card is gone, not broken.
// `?scope=peers` returns only eligible saved peer readings, without starting a
// local provider read; the billing toggle uses it to update the quota cards.
router.get('/providers', asyncHandler(async (req, res) => {
  const { refresh: refreshParam, family, period, scope } = validateRequest(providerUsageQuerySchema, req.query);
  const refresh = refreshParam === '1' || refreshParam === 'true';
  if (refresh) assertHostControl(req);
  const cacheOnly = !refresh && !requestHasHostControl(req);
  const providers = await getProviderQuotas({
    wait: refresh ? WAIT.FRESH : WAIT.NEVER,
    ...(cacheOnly ? { cacheOnly } : {}),
    family: family ?? null,
    ...(period ? { period } : {}),
    ...(scope ? { scope } : {}),
  });
  const payload = Array.isArray(providers) ? { providers } : providers;
  res.json(cacheOnly && scope !== 'peers' ? { ...payload, cacheOnly } : payload);
}));

// GET /api/usage/claude-code/models - Claude Code tokens per model, priced at
// API rates, across the fleet: every instance's per-day transcript history
// (this machine's is refreshed in the background if stale) plus a combined per-model list.
// Same ?period=7d|30d|90d|all or ?from/?to window as GET /api/usage.
router.get('/claude-code/models', asyncHandler(async (req, res) => {
  const { from, to } = resolveUsageRange(validateRequest(usageQuerySchema, req.query));
  // Answer from the stored transcript history at once; a stale scan runs in the
  // background and `usage:native-history-updated` tells the page to refetch.
  const stored = await readLocalTranscriptUsage().catch(() => null);
  refreshLocalTranscriptUsage()
    .then((result) => { if (result.refreshed) nativeUsageEvents.emit('updated'); })
    .catch((err) => console.error(`❌ Claude Code transcript refresh failed: ${err.message}`));
  const apiBilledInstanceIds = await getApiBilledInstanceIds();
  res.json({ from, to, transcriptRefreshed: false, transcriptUpdatedAt: stored?.updatedAt ?? null, ...(await getFleetClaudeCodeModels({ from, to, apiBilledInstanceIds })) });
}));

// Historical transcript correction is deliberately user-triggered. Starting it
// returns immediately; the worker-thread job reports progress through GET.
router.get('/backfill', asyncHandler(async (req, res) => {
  res.json(getHistoricalUsageBackfillStatus());
}));

router.post('/backfill', asyncHandler(async (req, res) => {
  res.status(202).json(await startHistoricalUsageBackfill());
}));

// DELETE /api/usage - Reset usage data
router.delete('/', asyncHandler(async (req, res) => {
  await usage.resetUsage();
  res.json({ success: true });
}));

export default router;
