import { Router } from 'express';
import * as usage from '../services/usage.js';
import { getClaudeCodeUsage } from '../services/claudeCodeUsage.js';
import { refreshLocalTranscriptUsage } from '../services/claudeCodeTranscriptUsage.js';
import { getProviderQuotas } from '../services/providerUsage.js';
import { getAllProviders } from '../services/providers.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, nativeUsageAccountsQuerySchema, nativeUsageAccountsUpdateSchema, nativeUsageCoverageQuerySchema, nativeUsageMatrixQuerySchema, nativeUsagePeerReportQuerySchema, nativeUsageRebuildSchema, usageCutoverAcquireSchema, usageCutoverEpochSchema, usageCutoverRollbackSchema, usageQuerySchema, usageMessagesSchema, usageTokensSchema, usageSessionSchema, providerUsageQuerySchema, subscriptionsUpdateSchema, subscriptionEnabledSchema, usageFleetBillingSchema, usageRollingCostQuerySchema, usagePreviewSchema, usagePreviewCancelSchema } from '../lib/validation.js';
import { saveSubscriptionCosts, getSubscriptionSavings } from '../services/subscriptionCosts.js';
import { getSubscriptionOverview, savePlanTiers, setSubscriptionEnabled } from '../services/subscriptions.js';
import { getFleetUsage, getFleetClaudeCodeModels, getFleetRollingCost } from '../services/peerUsage.js';
import { getApiBilledInstanceIds, setInstanceUsesSubscriptions } from '../services/usageFleetBilling.js';
import { resolveUsageRange } from '../lib/usageRange.js';
import { acquireUsageCutover, activateUsageCutover, getUsageCutoverStatus, releaseUsageCutover, rollbackUsageCutover, verifyUsageCutover } from '../services/usageCutoverBarrier.js';
import { WAIT } from '../lib/staleWhileRevalidate.js';
import {
  getHistoricalUsageBackfillStatus,
  startHistoricalUsageBackfill,
  startCodexUsagePreview,
  cancelCodexUsagePreview
} from '../services/usageBackfill.js';

const router = Router();

router.get('/native-report/v2', asyncHandler(async (req, res) => {
  const { challenge } = validateRequest(nativeUsagePeerReportQuerySchema, req.query);
  const { getNativeUsagePeerReport } = await import('../services/nativeUsagePeer.js');
  res.set('Cache-Control', 'no-store').json(await getNativeUsagePeerReport(req, challenge, 2));
}));

// Keeps answering v4 record lists for peers that have not upgraded yet.
router.get('/native-report/v1', asyncHandler(async (req, res) => {
  const { challenge } = validateRequest(nativeUsagePeerReportQuerySchema, req.query);
  const { getNativeUsagePeerReport } = await import('../services/nativeUsagePeer.js');
  res.set('Cache-Control', 'no-store').json(await getNativeUsagePeerReport(req, challenge, 1));
}));

// Machine-local configuration only: no provider reads, captures or peer requests.
router.get('/native-accounts', asyncHandler(async (req, res) => {
  validateRequest(nativeUsageAccountsQuerySchema, req.query);
  const { getNativeUsageAccounts } = await import('../services/nativeUsageAccounts.js');
  res.set('Cache-Control', 'no-store').json(await getNativeUsageAccounts());
}));

router.put('/native-accounts', asyncHandler(async (req, res) => {
  const input = validateRequest(nativeUsageAccountsUpdateSchema, req.body ?? {});
  const { saveNativeUsageAccounts } = await import('../services/nativeUsageAccounts.js');
  res.set('Cache-Control', 'no-store').json(await saveNativeUsageAccounts(input, { actor: 'user' }));
}));

router.get('/native-matrix', asyncHandler(async (req, res) => {
  const query = validateRequest(nativeUsageMatrixQuerySchema, req.query);
  const { getNativeUsageMatrix } = await import('../services/nativeUsageMatrix.js');
  res.set('Cache-Control', 'no-store').json(await getNativeUsageMatrix(query));
}));

// Re-read every native source still on disk, for an in-place rewrite that kept size and
// mtime. Nothing collected is removed. Answers with the read so the view updates from it.
router.post('/native-sources/rebuild', asyncHandler(async (req, res) => {
  const input = validateRequest(nativeUsageRebuildSchema, req.body ?? {});
  const { requestNativeUsageRebuild } = await import('../services/nativeUsageCollection.js');
  await requestNativeUsageRebuild();
  const { getNativeUsageMatrix } = await import('../services/nativeUsageMatrix.js');
  res.set('Cache-Control', 'no-store').json(await getNativeUsageMatrix(input));
}));

// Explicit, uncached diagnostic read. Never consumed by fleet aggregation.
router.get('/native-coverage', asyncHandler(async (req, res) => {
  const query = validateRequest(nativeUsageCoverageQuerySchema, req.query);
  const { getNativeUsageCoverage } = await import('../services/nativeUsageCoverage.js');
  res.set('Cache-Control', 'no-store').json(await getNativeUsageCoverage(query));
}));

// GET /api/usage/hourly - Fixed-size local counters, without building cost reports.
router.get('/hourly', (req, res) => {
  const { hourlyActivity } = usage.getUsage();
  res.json({ hourlyActivity: Array.from({ length: 24 }, (_, hour) => hourlyActivity?.[hour] || 0) });
});

// GET /api/usage - Usage summary + cost report. Accepts ?period=7d|30d|90d|all
// or an explicit ?from/?to (YYYY-MM-DD, inclusive) for the report window.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(usageQuerySchema, req.query);
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
// ONE policy for every status read: it never blocks on a slow reading. A cached
// one is served immediately (and revalidated behind the response); a cold one
// comes back as a `pending: true` card the UI renders as "reading…" and polls.
// Holding an HTTP response open for a 10-20s PTY spawn is what made this page —
// and Quota Burn — look broken, and it is the shape that trips proxy timeouts.
// `?refresh=1` is the explicit "get me a live reading" and does wait.
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
  const providers = await getProviderQuotas({
    wait: refresh ? WAIT.FRESH : WAIT.NEVER,
    family: family ?? null,
    ...(period ? { period } : {}),
    ...(scope ? { scope } : {}),
  });
  res.json(Array.isArray(providers) ? { providers } : providers);
}));

// GET /api/usage/claude-code - Claude Code SUBSCRIPTION rate-limit usage,
// parsed from the CLI's `/usage` output. Kept for back-compat — the usage page
// now reads the generalized /providers endpoint. `?refresh=1` bypasses cache.
//
// This one still BLOCKS on a cold cache: its response is the reading itself,
// with no card shape to carry a `pending` flag, so a caller has nothing to
// render or poll on. The wait is bounded by the CLI's own spawn timeout.
router.get('/claude-code', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const data = await getClaudeCodeUsage({ wait: refresh ? WAIT.FRESH : WAIT.CACHED });
  res.json(data);
}));

// GET /api/usage/claude-code/models - Claude Code tokens per model, priced at
// API rates, across the fleet: every instance's per-day transcript history
// (this machine's is refreshed first if stale) plus a combined per-model list.
// Same ?period=7d|30d|90d|all or ?from/?to window as GET /api/usage.
router.get('/claude-code/models', asyncHandler(async (req, res) => {
  const { from, to } = resolveUsageRange(validateRequest(usageQuerySchema, req.query));
  const { refreshed, updatedAt } = await refreshLocalTranscriptUsage();
  const apiBilledInstanceIds = await getApiBilledInstanceIds();
  res.json({ from, to, transcriptRefreshed: refreshed, transcriptUpdatedAt: updatedAt, ...(await getFleetClaudeCodeModels({ from, to, apiBilledInstanceIds })) });
}));

// GET /api/usage/raw - Get raw usage data
router.get('/raw', asyncHandler(async (req, res) => {
  const data = usage.getUsage();
  res.json(data);
}));

// Historical transcript correction is deliberately user-triggered. Starting it
// returns immediately; the worker-thread job reports progress through GET.
router.get('/backfill', asyncHandler(async (req, res) => {
  res.json(getHistoricalUsageBackfillStatus());
}));

router.post('/backfill/preview', asyncHandler(async (req, res) => {
  const range = validateRequest(usagePreviewSchema, req.body ?? {});
  res.status(202).json(startCodexUsagePreview(range));
}));

router.post('/backfill/preview/cancel', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(usagePreviewCancelSchema, req.body ?? {});
  res.json(await cancelCodexUsagePreview(jobId));
}));

// Read-only: participants, acknowledgments, outstanding work and why cutover is held.
router.get('/cutover', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await getUsageCutoverStatus());
}));

router.post('/cutover/acquire', asyncHandler(async (req, res) => {
  res.json(await acquireUsageCutover(validateRequest(usageCutoverAcquireSchema, req.body ?? {})));
}));

router.post('/cutover/verify', asyncHandler(async (req, res) => {
  res.json(await verifyUsageCutover(validateRequest(usageCutoverEpochSchema, req.body ?? {})));
}));

router.post('/cutover/activate', asyncHandler(async (req, res) => {
  res.json(await activateUsageCutover(validateRequest(usageCutoverEpochSchema, req.body ?? {})));
}));

router.post('/cutover/rollback', asyncHandler(async (req, res) => {
  res.json(await rollbackUsageCutover(validateRequest(usageCutoverRollbackSchema, req.body ?? {})));
}));

router.post('/cutover/release', asyncHandler(async (req, res) => {
  res.json(await releaseUsageCutover(validateRequest(usageCutoverEpochSchema, req.body ?? {})));
}));

router.post('/backfill', asyncHandler(async (req, res) => {
  res.status(202).json(await startHistoricalUsageBackfill());
}));

// POST /api/usage/session - Record a session
router.post('/session', asyncHandler(async (req, res) => {
  const { providerId, providerName, model } = validateRequest(usageSessionSchema, req.body);
  const recorded = await usage.recordSession(providerId, providerName, model);
  res.json(recorded?.deferred ? { sessionNumber: null, deferred: true } : { sessionNumber: recorded });
}));

// POST /api/usage/messages - Record messages
router.post('/messages', asyncHandler(async (req, res) => {
  const { providerId, model, messageCount, tokenCount, inputTokenCount } = validateRequest(usageMessagesSchema, req.body);
  await usage.recordMessages(providerId, model, messageCount, tokenCount, inputTokenCount);
  res.json({ success: true });
}));

// POST /api/usage/tokens - Record token usage
router.post('/tokens', asyncHandler(async (req, res) => {
  const { inputTokens, outputTokens } = validateRequest(usageTokensSchema, req.body);
  await usage.recordTokens(inputTokens, outputTokens);
  res.json({ success: true });
}));

// DELETE /api/usage - Reset usage data
router.delete('/', asyncHandler(async (req, res) => {
  await usage.resetUsage();
  res.json({ success: true });
}));

export default router;
