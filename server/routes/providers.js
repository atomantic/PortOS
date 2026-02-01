import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { testVision, runVisionTestSuite, checkVisionHealth } from '../services/visionTest.js';
import { getAllProviderStatuses, getProviderStatus, markProviderAvailable, getTimeUntilRecovery } from '../services/providerStatus.js';

/**
 * Create PortOS-specific provider routes
 * Extends AI Toolkit routes with vision testing endpoints
 */
export function createPortOSProviderRoutes(aiToolkit) {
  const router = Router();

  // Mount all base toolkit routes
  router.use('/', aiToolkit.routes.providers);

  // PortOS-specific extension: Vision health check
  router.get('/:id/vision-health', asyncHandler(async (req, res) => {
    const result = await checkVisionHealth(req.params.id);
    res.json(result);
  }));

  // PortOS-specific extension: Test vision with specific image
  router.post('/:id/test-vision', asyncHandler(async (req, res) => {
    const { imagePath, prompt, expectedContent, model } = req.body;

    if (!imagePath) {
      throw new ServerError('imagePath is required', { status: 400, code: 'VALIDATION_ERROR' });
    }

    const result = await testVision({
      imagePath,
      prompt: prompt || 'Describe what you see in this image.',
      expectedContent: expectedContent || [],
      providerId: req.params.id,
      model
    });

    res.json(result);
  }));

  // PortOS-specific extension: Run full vision test suite
  router.post('/:id/vision-suite', asyncHandler(async (req, res) => {
    const { model } = req.body;
    const result = await runVisionTestSuite(req.params.id, model);
    res.json(result);
  }));

  // Provider status: Get all provider statuses (usage limits, availability)
  router.get('/status', asyncHandler(async (req, res) => {
    const statuses = getAllProviderStatuses();
    // Enrich with time until recovery
    const enriched = { ...statuses };
    for (const [providerId, status] of Object.entries(enriched.providers)) {
      enriched.providers[providerId] = {
        ...status,
        timeUntilRecovery: getTimeUntilRecovery(providerId)
      };
    }
    res.json(enriched);
  }));

  // Provider status: Get single provider status
  router.get('/:id/status', asyncHandler(async (req, res) => {
    const status = getProviderStatus(req.params.id);
    res.json({
      ...status,
      timeUntilRecovery: getTimeUntilRecovery(req.params.id)
    });
  }));

  // Provider status: Manually mark provider as available (recovery)
  router.post('/:id/status/recover', asyncHandler(async (req, res) => {
    const status = await markProviderAvailable(req.params.id);
    res.json({ success: true, status });
  }));

  return router;
}
