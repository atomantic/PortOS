import { Router } from 'express';
import { observeModelResource } from '../../services/modelObservation.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { auditModelPins, clearModelPin } from '../../services/modelPinAudit.js';
import { validateRequest } from '../../lib/validateRequest.js';
import {
  modelPinClearSchema,
  providerVisionTestSchema,
  providerVisionSuiteSchema,
} from '../../lib/providerValidation.js';

const presentProviderStatus = (status) => {
  // Keep a second allowlist at the HTTP boundary even though the toolkit
  // service already presents sanitized status. The route is the final guard
  // if a host injects a different provider-status implementation.
  const { rateLimitWindow, ...publicStatus } = status || {};
  if (!rateLimitWindow || typeof rateLimitWindow !== 'object') return publicStatus;
  const allowedWindow = Object.fromEntries(
    ['observedAt', 'retryAfterMs', 'resetAt', 'remaining', 'limit']
      .filter(key => rateLimitWindow[key] != null)
      .map(key => [key, rateLimitWindow[key]])
  );
  return Object.keys(allowedWindow).length
    ? { ...publicStatus, rateLimitWindow: allowedWindow }
    : publicStatus;
};

export function createVisionAndPinRoutes(providerStatusService) {
  const router = Router();

  // GET /model-pins — stored model pins naming a model their provider no longer
  // lists (#7315). Registered BEFORE '/:id' so the literal path is not read as a
  // provider id. Derived on read, never persisted: see services/modelPinAudit.js.
  router.get('/model-pins', asyncHandler(async (_req, res) => {
    res.json(await auditModelPins());
  }));

  // POST /model-pins/clear — clear ONE pin back to "inherit". A pin is the
  // user's own choice, so PortOS surfaces a retirement and never rewrites it;
  // this is that one-click clear. Clearing a pin that is already gone is a
  // success with `cleared: false`, not a 404 — the outcome the caller wanted.
  router.post('/model-pins/clear', asyncHandler(async (req, res) => {
    const { pinId } = validateRequest(modelPinClearSchema, req.body ?? {});
    res.json(await clearModelPin(pinId));
  }));

  const statusObservation = observeModelResource('provider-status', async () => {
    const statuses = providerStatusService.getAllStatuses();
    // Enrich with time until recovery
    const enriched = { ...statuses, providers: { ...statuses.providers } };
    for (const [providerId, status] of Object.entries(enriched.providers)) {
      enriched.providers[providerId] = {
        ...presentProviderStatus(status),
        timeUntilRecovery: providerStatusService.getTimeUntilRecovery(providerId)
      };
    }
    return enriched;
  });
  router.get('/status', asyncHandler(async (_req, res) => {
    res.json(await statusObservation.read());
  }));

  router.post('/:id/status/recover', asyncHandler(async (req, res) => {
    const status = await providerStatusService.markAvailable(req.params.id);
    res.json({ success: true, status });
  }));

  router.get('/:id/vision-health', asyncHandler(async (req, res) => {
    const { checkVisionHealth } = await import('../../services/visionTest.js');
    const result = await checkVisionHealth(req.params.id);
    res.json(result);
  }));

  router.post('/:id/test-vision', asyncHandler(async (req, res) => {
    const { imagePath, prompt, expectedContent, model } = validateRequest(providerVisionTestSchema, req.body);

    const { testVision } = await import('../../services/visionTest.js');
    const result = await testVision({
      imagePath,
      prompt: prompt || 'Describe what you see in this image.',
      expectedContent: expectedContent || [],
      providerId: req.params.id,
      model
    });

    res.json(result);
  }));

  router.post('/:id/vision-suite', asyncHandler(async (req, res) => {
    const { model } = validateRequest(providerVisionSuiteSchema, req.body);
    const { runVisionTestSuite } = await import('../../services/visionTest.js');
    const result = await runVisionTestSuite(req.params.id, model);
    res.json(result);
  }));

  return router;
}
