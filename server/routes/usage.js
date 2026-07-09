import { Router } from 'express';
import * as usage from '../services/usage.js';
import { getClaudeCodeUsage } from '../services/claudeCodeUsage.js';
import { asyncHandler } from '../lib/errorHandler.js';

const router = Router();

// GET /api/usage - Get usage summary
router.get('/', asyncHandler(async (req, res) => {
  const summary = usage.getUsageSummary();
  res.json(summary);
}));

// GET /api/usage/claude-code - Claude Code SUBSCRIPTION rate-limit usage,
// parsed from the CLI's `/usage` output. Distinct from the PortOS-internal
// token accounting above. `?refresh=1` bypasses the 60s cache.
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
  const { providerId, model, messageCount, tokenCount } = req.body;
  await usage.recordMessages(providerId, model, messageCount, tokenCount);
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
