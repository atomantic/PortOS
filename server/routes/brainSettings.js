/**
 * Brain Settings & Summary Routes
 *
 * Brain configuration (default provider/model) and the dashboard data summary.
 */

import { Router } from 'express';
import * as brainService from '../services/brain.js';
import { getProviderById } from '../services/providers.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { settingsUpdateInputSchema } from '../lib/brainValidation.js';

const router = Router();

/**
 * GET /api/brain/settings
 * Get brain settings
 */
router.get('/settings', asyncHandler(async (req, res) => {
  const settings = await brainService.loadMeta();
  res.json(settings);
}));

/**
 * PUT /api/brain/settings
 * Update brain settings
 */
router.put('/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(settingsUpdateInputSchema, req.body);

  // Validate provider and model if provided
  if (data.defaultProvider || data.defaultModel) {
    const providerId = data.defaultProvider;
    const modelId = data.defaultModel;

    // Get current settings to use existing provider if only model is being updated
    const currentSettings = await brainService.loadMeta();
    const effectiveProviderId = providerId || currentSettings.defaultProvider;

    // Validate provider exists
    const provider = await getProviderById(effectiveProviderId);
    if (!provider) {
      throw new ServerError(`Provider "${effectiveProviderId}" not found`, {
        status: 400,
        code: 'INVALID_PROVIDER'
      });
    }

    // Validate model exists in provider's models
    if (modelId) {
      if (!provider.models || provider.models.length === 0) {
        throw new ServerError(`Provider "${effectiveProviderId}" has no models configured`, {
          status: 400,
          code: 'NO_MODELS'
        });
      }
      if (!provider.models.includes(modelId)) {
        throw new ServerError(`Model "${modelId}" not found in provider "${effectiveProviderId}"`, {
          status: 400,
          code: 'INVALID_MODEL',
          context: { availableModels: provider.models }
        });
      }
    }
  }

  const settings = await brainService.updateMeta(data);
  res.json(settings);
}));

/**
 * GET /api/brain/summary
 * Get brain data summary for dashboard
 */
router.get('/summary', asyncHandler(async (req, res) => {
  const summary = await brainService.getSummary();
  res.json(summary);
}));

export default router;
