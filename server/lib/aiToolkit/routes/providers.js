import { Router } from 'express';
import { ToolkitHttpError, defaultAsyncHandler } from '../internal/httpError.js';
import { providerSchema, providerActiveSchema, validate } from '../validation.js';
import { withRefreshCapability, withRefreshCapabilityList } from '../internal/modelFetchers.js';

// `canRefreshModels` is DERIVED ON READ and decorated HERE, at the route —
// never inside `getAllProviders()`. Computing it in the service would put it on
// the object `saveProviders` writes back, so it would land in providers.json and
// go stale against the fetcher table the first time a user repoints a command.
// Decorating on the way out keeps the persisted record clean while every
// provider-shaped response still carries the flag, so the client can read it
// instead of re-deriving refreshability from command/name string sniffing.
// Safe against a round-trip: `providerSchema.partial()` on PUT strips unknown
// keys, so even a client that echoes the whole object back cannot persist it.

export function createProvidersRoutes(providerService, options = {}) {
  const router = Router();
  // `asyncHandler`/`ServerError` are injected by the host (PortOS passes its
  // real ServerError + asyncHandler so thrown errors normalize into
  // `{ error, code, timestamp, context? }` and route to errorMiddleware).
  // Standalone, the toolkit's own defaults serialize the same envelope.
  const { asyncHandler = defaultAsyncHandler, ServerError = ToolkitHttpError } = options;

  router.get('/', asyncHandler(async (req, res) => {
    const data = await providerService.getAllProviders();
    res.json({ ...data, providers: withRefreshCapabilityList(data.providers) });
  }));

  router.get('/active', asyncHandler(async (req, res) => {
    const provider = await providerService.getActiveProvider();
    res.json(withRefreshCapability(provider));
  }));

  router.put('/active', asyncHandler(async (req, res) => {
    const result = validate(providerActiveSchema, req.body);
    if (!result.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: result.errors } });
    }
    const { id } = result.data;

    const provider = await providerService.setActiveProvider(id);

    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.json(withRefreshCapability(provider));
  }));

  router.get('/samples', asyncHandler(async (req, res) => {
    const providers = await providerService.getSampleProviders();
    // Samples are provider-shaped and the flag is derived purely from that
    // shape, so decorate them too — a sample's answer is what the provider it
    // becomes will report. PortOS's shadowing `/samples` handler does the same.
    res.json({ providers: withRefreshCapabilityList(providers) });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const provider = await providerService.getProviderById(req.params.id);

    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.json(withRefreshCapability(provider));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const result = validate(providerSchema, req.body);
    if (!result.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: result.errors } });
    }

    const provider = await providerService.createProvider(result.data);
    res.status(201).json(withRefreshCapability(provider));
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
    // Partial: a PUT may touch a single field; unknown keys are stripped so only
    // the canonical provider shape reaches updateProvider's spread.
    const result = validate(providerSchema.partial(), req.body);
    if (!result.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: result.errors } });
    }

    const provider = await providerService.updateProvider(req.params.id, result.data);

    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.json(withRefreshCapability(provider));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const deleted = await providerService.deleteProvider(req.params.id);

    if (!deleted) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.status(204).send();
  }));

  router.post('/:id/test', asyncHandler(async (req, res) => {
    const result = await providerService.testProvider(req.params.id);
    res.json(result);
  }));

  router.post('/:id/refresh-models', asyncHandler(async (req, res) => {
    const provider = await providerService.refreshProviderModels(req.params.id);

    // `null` now means exactly one thing — no such provider. Every other failure
    // (probe failed, no fetcher for this type/CLI, missing key, blocked
    // endpoint) throws from the service with its own status and real message,
    // which asyncHandler routes straight to the error middleware. The old
    // "or not an API type" suffix was a guess that covered for those cases and
    // was wrong for all of them.
    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.json(withRefreshCapability(provider));
  }));

  return router;
}
