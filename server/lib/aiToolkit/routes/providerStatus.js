import { Router } from 'express';
import { defaultAsyncHandler } from '../internal/httpError.js';

export function createProviderStatusRoutes(providerStatusService, options = {}) {
  const router = Router();
  // Standalone default serializes thrown errors into the canonical envelope;
  // PortOS injects its own asyncHandler. This router has no 4xx throws of its
  // own, but a rejected service call still lands in the same JSON shape.
  const { asyncHandler = defaultAsyncHandler } = options;

  router.get('/', asyncHandler(async (req, res) => {
    const statuses = providerStatusService.getAllStatuses();
    res.json(statuses);
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const status = providerStatusService.getStatus(req.params.id);
    const timeUntilRecovery = providerStatusService.getTimeUntilRecovery(req.params.id);

    res.json({
      ...status,
      timeUntilRecovery
    });
  }));

  router.post('/:id/recover', asyncHandler(async (req, res) => {
    const status = await providerStatusService.markAvailable(req.params.id);
    res.json(status);
  }));

  router.post('/:id/usage-limit', asyncHandler(async (req, res) => {
    const { message, waitTime } = req.body;
    const status = await providerStatusService.markUsageLimit(req.params.id, {
      message,
      waitTime
    });
    res.json(status);
  }));

  router.post('/:id/rate-limit', asyncHandler(async (req, res) => {
    const status = await providerStatusService.markRateLimited(req.params.id);
    res.json(status);
  }));

  return router;
}
