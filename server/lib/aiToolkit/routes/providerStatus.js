import { Router } from 'express';

export function createProviderStatusRoutes(providerStatusService, options = {}) {
  const router = Router();
  const { asyncHandler = (fn) => fn } = options;

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
