import { Router } from 'express';
import { ToolkitHttpError, defaultAsyncHandler } from '../internal/httpError.js';
import { providerUsageLimitBodySchema, validate } from '../validation.js';

export function createProviderStatusRoutes(providerStatusService, options = {}) {
  const router = Router();
  // Standalone default serializes thrown errors into the canonical envelope;
  // PortOS injects its own asyncHandler + ServerError, so a body-validation 400
  // normalizes into the canonical envelope; standalone, the toolkit defaults
  // serialize the same shape.
  const { asyncHandler = defaultAsyncHandler, ServerError = ToolkitHttpError } = options;

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
    const result = validate(providerUsageLimitBodySchema, req.body ?? {});
    if (!result.success) {
      throw new ServerError('Invalid usage-limit data', { status: 400, code: 'VALIDATION_ERROR', context: { details: result.errors } });
    }
    const { message, waitTime } = result.data;
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
