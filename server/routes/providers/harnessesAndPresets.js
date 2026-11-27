import { Router } from 'express';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { detectSystemCapabilities } from '../../lib/systemCapabilities.js';
import {
  executionOptionSelectionSchema,
  providerExecutionOptionsQuerySchema,
  providerPresetCreateSchema,
  credentialBootstrapsSettingsSchema,
  harnessEnablementUpdateSchema,
  harnessIdParamSchema,
} from '../../lib/providerValidation.js';
import { executionOptionKeysForHarness, presentProvider } from './presenter.js';

export function createHarnessAndPresetRoutes(providerService, readProviders) {
  const router = Router();

  /**
   * The composition catalog (#7564): every axis a `{ providerId, model, effort }`
   * picker composes over — harnesses with their enablement, service instances,
   * bootstrap apps, which harness reaches which service, the effort ladder per
   * harness (and per model where a model narrows it), and the stored presets.
   * Derived from cache and settings only: harness detection is the runtime
   * probe's cache, nothing is spawned, and no provider is asked to generate
   * (`syncProviderCatalogs` may list a local daemon's installed models first).
   *
   * `GET /api/providers` stays presets-only — every existing `useProviderModels`
   * consumer keeps its shape; this is the additive surface for composing.
   */
  router.get('/catalog', asyncHandler(async (_req, res) => {
    const { buildProviderCatalog } = await import('../../services/compositeProviders.js');
    // Sync first: the composed catalog derives from the providers it may rewrite.
    const data = await readProviders();
    const [catalog, capabilities] = await Promise.all([buildProviderCatalog(), detectSystemCapabilities()]);
    res.json({ ...catalog, harnesses: (catalog.harnesses || []).map(harness => ({ ...harness, executionOptionKeys: executionOptionKeysForHarness(harness.id) })), presets: data.providers.map((provider) => presentProvider(provider, capabilities)) });
  }));

  router.put('/harnesses/:id', asyncHandler(async (req, res) => {
    const harnessId = validateRequest(harnessIdParamSchema, req.params.id);
    const { enabled } = validateRequest(harnessEnablementUpdateSchema, req.body || {});
    const { setHarnessEnabled } = await import('../../services/harnessEnablement.js');
    res.json({ harness: { id: harnessId, ...(await setHarnessEnabled(harnessId, enabled)) } });
  }));

  /**
   * Credential-bootstrap apps (#7564): the wrapper CLIs a composite's
   * `+<slug>` suffix names. Saving never spawns anything — `setupCommand` is
   * advisory text, and the wrapper runs only when a composite is executed.
   */
  router.get('/bootstraps', asyncHandler(async (_req, res) => {
    const { listCredentialBootstraps } = await import('../../services/credentialBootstrapApps.js');
    res.json({ bootstraps: await listCredentialBootstraps() });
  }));

  router.put('/bootstraps', asyncHandler(async (req, res) => {
    const bootstraps = validateRequest(credentialBootstrapsSettingsSchema, req.body?.bootstraps ?? req.body ?? {});
    const { saveCredentialBootstraps } = await import('../../services/credentialBootstrapApps.js');
    res.json({ bootstraps: await saveCredentialBootstraps(bootstraps) });
  }));

  router.post('/:id/execution-options/selection', asyncHandler(async (req, res) => {
    const { model, executionOptions } = validateRequest(executionOptionSelectionSchema, req.body ?? {});
    const { createExecutionOptionSelection } = await import('../../services/provider/providerExecutionOptions.js');
    const selection = await createExecutionOptionSelection(req.params.id, model, executionOptions);
    res.json(presentProvider(await providerService.getProviderById(selection.id), await detectSystemCapabilities()));
  }));

  router.get('/:id/execution-options', asyncHandler(async (req, res) => {
    const { model, refresh } = validateRequest(providerExecutionOptionsQuerySchema, req.query);
    const provider = await providerService.getProviderById(req.params.id);
    if (!provider) throw new ServerError('Provider not found', { status: 404 });
    const { getExecutionOptionCapabilities } = await import('../../services/provider/providerExecutionOptions.js');
    res.json(await getExecutionOptionCapabilities(provider, model, { fresh: refresh === 'true' }));
  }));

  // Save an eligible composite as a derived preset with the selected defaults.
  router.post('/presets', asyncHandler(async (req, res) => {
    const input = validateRequest(providerPresetCreateSchema, req.body ?? {});
    const { createPresetFromComposite } = await import('../../services/provider/providerPresets.js');
    const created = await createPresetFromComposite(input);
    res.status(201).json(presentProvider(created, await detectSystemCapabilities()));
  }));

  /**
   * "Convert to derived preset" (#7565): stamp one legacy record with the
   * harness, method and service instance it already runs on — only when
   * re-deriving it from that service reproduces every connection-owned value
   * it carries (the same fixpoint the boot backfill applies). Refused with the
   * reason otherwise; nothing about how the record runs is changed either way.
   */
  router.post('/:id/derive', asyncHandler(async (req, res) => {
    const { derivePreset } = await import('../../services/provider/providerPresets.js');
    const provider = await derivePreset(req.params.id);
    res.json(presentProvider(provider, await detectSystemCapabilities()));
  }));

  return router;
}
