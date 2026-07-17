import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { testVision, runVisionTestSuite, checkVisionHealth } from '../services/visionTest.js';
import { getAllProviderStatuses, getProviderStatus, markProviderAvailable, getTimeUntilRecovery } from '../services/providerStatus.js';
import { providerSchema, providerActiveSchema, validate } from '../lib/aiToolkit/validation.js';

/**
 * Sanitize a provider object for client responses.
 * Strips apiKey (replaces with hasApiKey boolean) and redacts secretEnvVars values.
 */
const sanitizeProvider = (provider) => {
  if (!provider) return provider;
  const { apiKey, envVars, secretEnvVars, ...rest } = provider;
  const sanitized = {
    ...rest,
    hasApiKey: Boolean(apiKey),
    envVars: envVars ? { ...envVars } : {},
    secretEnvVars: secretEnvVars || []
  };
  // Redact values of secret env vars
  if (Array.isArray(secretEnvVars)) {
    for (const key of secretEnvVars) {
      if (key in sanitized.envVars) {
        sanitized.envVars[key] = '***';
      }
    }
  }
  return sanitized;
};

/**
 * Create PortOS-specific provider routes
 * Extends AI Toolkit routes with vision testing endpoints
 */
export function createPortOSProviderRoutes(aiToolkit) {
  const router = Router();
  const providerService = aiToolkit.services.providers;

  // Sanitized GET routes — intercept toolkit GET endpoints to strip secrets
  router.get('/', asyncHandler(async (req, res) => {
    const data = await providerService.getAllProviders();
    res.json({
      activeProvider: data.activeProvider,
      providers: data.providers.map(sanitizeProvider)
    });
  }));

  router.get('/active', asyncHandler(async (req, res) => {
    const provider = await providerService.getActiveProvider();
    res.json(sanitizeProvider(provider));
  }));

  // PUT /active must be defined before PUT /:id to avoid the wildcard
  // catching "active" as a provider ID (which causes 404 "Provider not found")
  router.put('/active', asyncHandler(async (req, res) => {
    const validation = validate(providerActiveSchema, req.body);
    if (!validation.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: validation.errors } });
    }
    const { id } = validation.data;
    const provider = await providerService.setActiveProvider(id);
    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }
    res.json(sanitizeProvider(provider));
  }));

  router.get('/samples', asyncHandler(async (req, res) => {
    const providers = await providerService.getSampleProviders();
    res.json({ providers: providers.map(sanitizeProvider) });
  }));

  // Provider status routes MUST be defined before toolkit routes,
  // because the toolkit has a GET /:id route that would catch /status
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

  router.get('/:id/status', asyncHandler(async (req, res) => {
    const status = getProviderStatus(req.params.id);
    res.json({
      ...status,
      timeUntilRecovery: getTimeUntilRecovery(req.params.id)
    });
  }));

  router.post('/:id/status/recover', asyncHandler(async (req, res) => {
    const status = await markProviderAvailable(req.params.id);
    res.json({ success: true, status });
  }));

  // PortOS-specific extensions (parameterized routes before toolkit mount)
  router.get('/:id/vision-health', asyncHandler(async (req, res) => {
    const result = await checkVisionHealth(req.params.id);
    res.json(result);
  }));

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

  router.post('/:id/vision-suite', asyncHandler(async (req, res) => {
    const { model } = req.body;
    const result = await runVisionTestSuite(req.params.id, model);
    res.json(result);
  }));

  // Sanitized GET /:id — must be after specific /:id/* routes above
  router.get('/:id', asyncHandler(async (req, res) => {
    const provider = await providerService.getProviderById(req.params.id);
    if (!provider) throw new ServerError('Provider not found', { status: 404 });
    res.json(sanitizeProvider(provider));
  }));

  // PUT /:id — intercept to (a) validate the body via a partial provider
  // schema (PUT can be a partial update; only the fields the client sent are
  // re-validated), and (b) preserve redacted secrets before passing to the
  // toolkit. Without partial validation, an `updateProvider` call could
  // still persist invalid types (timeout: "abc", non-object envVars) the
  // POST path now blocks.
  router.put('/:id', asyncHandler(async (req, res) => {
    const existing = await providerService.getProviderById(req.params.id);
    if (!existing) throw new ServerError('Provider not found', { status: 404 });

    const validation = validate(providerSchema.partial(), req.body);
    if (!validation.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: validation.errors } });
    }

    const updates = { ...validation.data };

    // Preserve existing apiKey if client didn't send a new one
    if (!('apiKey' in updates)) {
      updates.apiKey = existing.apiKey;
    }

    // Preserve existing secret env var values when client sends redacted '***' placeholders
    if (updates.envVars && Array.isArray(existing.secretEnvVars)) {
      for (const key of existing.secretEnvVars) {
        if (updates.envVars[key] === '***' && existing.envVars?.[key]) {
          updates.envVars[key] = existing.envVars[key];
        }
      }
    }

    const provider = await providerService.updateProvider(req.params.id, updates);
    res.json(sanitizeProvider(provider));
  }));

  // POST / — intercept to (a) validate the body against providerSchema so
  // invalid fields like `timeout: "abc"` or non-object `envVars` don't
  // persist and later break runner behavior, and (b) sanitize the created
  // provider before responding so apiKey/secret envVar values don't echo
  // back to the client (the toolkit's POST returns the raw provider).
  router.post('/', asyncHandler(async (req, res) => {
    const validation = validate(providerSchema, req.body);
    if (!validation.success) {
      throw new ServerError('Invalid provider data', { status: 400, code: 'VALIDATION_ERROR', context: { details: validation.errors } });
    }
    const provider = await providerService.createProvider(validation.data);
    res.status(201).json(sanitizeProvider(provider));
  }));

  // Mount base toolkit routes last (GET/PUT /:id and POST / are now shadowed
  // by sanitized versions above)
  router.use('/', aiToolkit.routes.providers);

  return router;
}
