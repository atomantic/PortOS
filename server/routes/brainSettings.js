/**
 * Brain Settings & Summary Routes
 *
 * Brain configuration (default provider/model) and the dashboard data summary.
 */

import { Router } from 'express';
import * as brainStorage from '../services/brainStorage.js';
import { getProviderById } from '../services/provider/providers.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { settingsUpdateInputSchema } from '../lib/brainValidation.js';
import { modelPinIsOffered } from '../lib/localProviderRuntime.js';

const router = Router();

/**
 * GET /api/brain/settings
 * Get brain settings
 */
router.get('/settings', asyncHandler(async (req, res) => {
  const settings = await brainStorage.loadMeta();
  res.json(settings);
}));

/**
 * PUT /api/brain/settings
 * Update brain settings
 */
router.put('/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(settingsUpdateInputSchema, req.body);
  const currentSettings = await brainStorage.loadMeta();

  // Validate provider and model if provided
  if (data.defaultProvider || data.defaultModel) {
    const providerId = data.defaultProvider;
    const modelId = data.defaultModel;

    // Use the existing provider if only the model is being updated
    const effectiveProviderId = providerId || currentSettings.defaultProvider;

    // Validate provider exists
    const provider = await getProviderById(effectiveProviderId);
    if (!provider) {
      throw new ServerError(`Provider "${effectiveProviderId}" not found`, {
        status: 400,
        code: 'INVALID_PROVIDER'
      });
    }

    // Validate the model against the provider's catalog — but only where that
    // catalog is authoritative. `modelPinIsOffered` subsumes the old
    // "no models configured" branch (an empty catalog validates nothing) and
    // additionally passes a locally-backed provider through: its `models` array
    // is a cached snapshot while the daemon on this machine is the authority,
    // so rejecting here 400s a model the user just pulled and can serve.
    if (modelId && !modelPinIsOffered(provider, modelId)) {
      throw new ServerError(`Model "${modelId}" not found in provider "${effectiveProviderId}"`, {
        status: 400,
        code: 'INVALID_MODEL',
        context: { availableModels: provider.models }
      });
    }
  }

  const settings = await brainStorage.updateMeta(data);
  res.json(settings);
}));

/**
 * GET /api/brain/summary
 * Get brain data summary for dashboard
 */
router.get('/summary', asyncHandler(async (req, res) => {
  const summary = await brainStorage.getSummary();
  res.json(summary);
}));

export default router;
