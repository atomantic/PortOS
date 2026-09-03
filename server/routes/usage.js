import { Router } from 'express';
import * as usage from '../services/usage.js';
import { getClaudeCodeUsage } from '../services/claudeCodeUsage.js';
import { getProviderQuotas } from '../services/providerUsage.js';
import { getAllProviders } from '../services/providers.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, usageQuerySchema, usageMessagesSchema, providerUsageQuerySchema, subscriptionCostsSchema, usageFleetBillingSchema } from '../lib/validation.js';
import { saveSubscriptionCosts, getSubscriptionSavings } from '../services/subscriptionCosts.js';
import { getFleetUsage } from '../services/peerUsage.js';
import { getApiBilledInstanceIds, setInstanceUsesSubscriptions } from '../services/usageFleetBilling.js';
import { resolveUsageRange } from '../lib/usageRange.js';
import { WAIT } from '../lib/staleWhileRevalidate.js';
import {
  getHistoricalUsageBackfillStatus,
  startHistoricalUsageBackfill
} from '../services/usageBackfill.js';

const router = Router();

// GET /api/usage - Usage summary + cost report. Accepts ?period=7d|30d|90d|all
// or an explicit ?from/?to (YYYY-MM-DD, inclusive) for the report window.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(usageQuerySchema, req.query);
  const { from, to } = resolveUsageRange(query);
  const result = await getAllProviders();
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  const summary = usage.getUsageSummary({ from, to, providers });
  // Two independent reads over the same resolved window, so they overlap:
  // - savings: what the user's flat-rate plans cost over the SAME window, so
  //   the headline API-rate figure has something to be compared against.
  // - fleet: the per-instance breakdown across the federation, priced over the
  //   same window by the same report builder. Empty on a single-machine install
  //   (or before a peer's first usage sync) — the UI hides that section rather
  //   than showing a one-row "fleet".
  const [subscriptionSavings, fleet] = await Promise.all([
    getSubscriptionSavings({
      report: summary.report,
      providers,
      from,
      to,
      // Only an unbounded ("All time") window needs a start day inferred from
      // history; every other range already has one, so don't pay the scan.
      firstActivityDay: from ? null : usage.getFirstActivityDay()
    }),
    getApiBilledInstanceIds().then((apiBilledInstanceIds) =>
      getFleetUsage({ from, to, providers, apiBilledInstanceIds })),
  ]);
  res.json({ ...summary, subscriptionSavings, fleet });
}));

// PUT /api/usage/subscriptions - Merge plan prices. An omitted family keeps its
// stored price; one sent as null (or 0) is cleared.
router.put('/subscriptions', asyncHandler(async (req, res) => {
  const { costs } = validateRequest(subscriptionCostsSchema, req.body);
  res.json({ costs: await saveSubscriptionCosts(costs, { actor: 'user' }) });
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
router.get('/providers', asyncHandler(async (req, res) => {
  const { refresh: refreshParam, family } = validateRequest(providerUsageQuerySchema, req.query);
  const refresh = refreshParam === '1' || refreshParam === 'true';
  const providers = await getProviderQuotas({ wait: refresh ? WAIT.FRESH : WAIT.NEVER, family: family ?? null });
  res.json({ providers });
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

router.post('/backfill', asyncHandler(async (req, res) => {
  res.status(202).json(await startHistoricalUsageBackfill());
}));

// POST /api/usage/session - Record a session
router.post('/session', asyncHandler(async (req, res) => {
  const { providerId, providerName, model } = req.body;
  const sessionNumber = await usage.recordSession(providerId, providerName, model);
  res.json({ sessionNumber });
}));

// POST /api/usage/messages - Record messages
router.post('/messages', asyncHandler(async (req, res) => {
  const { providerId, model, messageCount, tokenCount, inputTokenCount } = validateRequest(usageMessagesSchema, req.body);
  await usage.recordMessages(providerId, model, messageCount, tokenCount, inputTokenCount);
  res.json({ success: true });
}));

// POST /api/usage/tokens - Record token usage
router.post('/tokens', asyncHandler(async (req, res) => {
  const { inputTokens, outputTokens } = req.body;
  await usage.recordTokens(inputTokens || 0, outputTokens || 0);
  res.json({ success: true });
}));

// DELETE /api/usage - Reset usage data
router.delete('/', asyncHandler(async (req, res) => {
  await usage.resetUsage();
  res.json({ success: true });
}));

export default router;
