/**
 * CoS Status, Config, and Lifecycle Routes
 */

import { Router } from 'express';
import { getConfig } from '../services/cos/cosState.js';
import { getStatus, pause, resume, start, stop, updateConfig } from '../services/cos/cos.js';
import { getAllDomainUsageToday } from '../services/domainUsage.js';
import { reinitialize as reinitializeEmbeddings } from '../services/memoryEmbeddings.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { getProviderById } from '../services/provider/providers.js';
import { validateRequest } from '../lib/validateRequest.js';
import { cosPauseSchema, cosConfigSchema } from '../lib/cos/cosConfigValidation.js';
import { persistentMindToolFreeRefusal } from '../lib/persistent/persistentMindProfile.js';

const router = Router();

// GET /api/cos - Get CoS status
router.get('/', asyncHandler(async (req, res) => {
  const status = await getStatus();
  res.json(status);
}));

// POST /api/cos/start - Start CoS daemon
router.post('/start', asyncHandler(async (req, res) => {
  const result = await start();
  res.json(result);
}));

// POST /api/cos/stop - Stop CoS daemon
router.post('/stop', asyncHandler(async (req, res) => {
  const result = await stop();
  res.json(result);
}));

// POST /api/cos/pause - Pause CoS daemon (stays running but skips evaluations)
router.post('/pause', asyncHandler(async (req, res) => {
  const { reason } = validateRequest(cosPauseSchema, req.body);
  const result = await pause(reason);
  res.json(result);
}));

// POST /api/cos/resume - Resume CoS daemon from pause
router.post('/resume', asyncHandler(async (req, res) => {
  const result = await resume();
  res.json(result);
}));

// GET /api/cos/config - Get configuration
router.get('/config', asyncHandler(async (req, res) => {
  const config = await getConfig();
  res.json(config);
}));

// GET /api/cos/budget-usage - Today's per-domain autonomy usage (for the
// Domain Budgets panel). Reflects the rolling daily ledger that budgets gate on.
router.get('/budget-usage', asyncHandler(async (req, res) => {
  const usage = await getAllDomainUsageToday();
  res.json(usage);
}));

// The mind wakes unattended over third-party text, so a home or thinking-preset
// provider that cannot run tool-free is refused at save time. A stored route
// that predates this check is refused when it resolves (services/persistent/persistentMindProfile.js).
async function assertMindRoutesToolFree(config) {
  const providerIds = new Set([
    config.persistentMindProfile?.providerId,
    ...(config.persistentMindThinkingPresets?.presets ?? []).map((preset) => preset.providerId),
  ].filter(Boolean));
  for (const providerId of providerIds) {
    const provider = await getProviderById(providerId);
    const refusal = provider ? persistentMindToolFreeRefusal(provider) : null;
    if (refusal) throw new ServerError(refusal, { status: 400, code: 'PROVIDER_NOT_TOOL_FREE' });
  }
}

// PUT /api/cos/config - Update configuration
router.put('/config', asyncHandler(async (req, res) => {
  const validated = validateRequest(cosConfigSchema, req.body);
  await assertMindRoutesToolFree(validated);
  const config = await updateConfig(validated);
  if (validated.embeddingProviderId !== undefined || validated.embeddingModel !== undefined) {
    reinitializeEmbeddings();
  }
  res.json(config);
}));

export default router;
