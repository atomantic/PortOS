import { Router } from 'express';
import * as usage from '../services/usage.js';
import { getClaudeCodeUsage } from '../services/claudeCodeUsage.js';
import { getProviderQuotas } from '../services/providerUsage.js';
import { getAllProviders } from '../services/providers.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, usageQuerySchema } from '../lib/validation.js';

const router = Router();

const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * Resolve validated query params to an inclusive { from, to } date range
 * (YYYY-MM-DD, null = unbounded). Explicit from/to win; otherwise a preset
 * period counting back from today (default 7d, matching the page's charts).
 */
export function resolveUsageRange({ period, from, to } = {}) {
  if (from || to) return { from: from || null, to: to || null };
  if (period === 'all') return { from: null, to: null };
  const days = PERIOD_DAYS[period] || PERIOD_DAYS['7d'];
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return { from: start.toISOString().split('T')[0], to: null };
}

// GET /api/usage - Usage summary + cost report. Accepts ?period=7d|30d|90d|all
// or an explicit ?from/?to (YYYY-MM-DD, inclusive) for the report window.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(usageQuerySchema, req.query);
  const { from, to } = resolveUsageRange(query);
  const providers = await getAllProviders();
  const summary = usage.getUsageSummary({ from, to, providers });
  res.json(summary);
}));

// GET /api/usage/providers - Subscription-quota status for every enabled
// provider family (claude, codex, agy, grok). Providers without a queryable
// usage surface report `supported: false`. `?refresh=1` bypasses the cache.
router.get('/providers', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const providers = await getProviderQuotas({ refresh });
  res.json({ providers });
}));

// GET /api/usage/claude-code - Claude Code SUBSCRIPTION rate-limit usage,
// parsed from the CLI's `/usage` output. Kept for back-compat — the usage page
// now reads the generalized /providers endpoint. `?refresh=1` bypasses cache.
router.get('/claude-code', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const data = await getClaudeCodeUsage({ refresh });
  res.json(data);
}));

// GET /api/usage/raw - Get raw usage data
router.get('/raw', asyncHandler(async (req, res) => {
  const data = usage.getUsage();
  res.json(data);
}));

// POST /api/usage/session - Record a session
router.post('/session', asyncHandler(async (req, res) => {
  const { providerId, providerName, model } = req.body;
  const sessionNumber = await usage.recordSession(providerId, providerName, model);
  res.json({ sessionNumber });
}));

// POST /api/usage/messages - Record messages
router.post('/messages', asyncHandler(async (req, res) => {
  const { providerId, model, messageCount, tokenCount, inputTokenCount } = req.body;
  await usage.recordMessages(providerId, model, messageCount, tokenCount, inputTokenCount || 0);
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
