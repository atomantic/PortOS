import { Router } from 'express';
import { observeModelMutations } from '../services/modelObservation.js';
import { runtimeUpdateEvents } from '../services/runtimeUpdateEvents.js';
import { emitToOperatorsOn } from '../services/socketIo.js';
import { createCodexAccountRoutes } from './providers/codexAccount.js';
import { createFleetHostRoutes } from './providers/fleetHost.js';
import { createHarnessAndPresetRoutes } from './providers/harnessesAndPresets.js';
import { createProviderManagementRoutes } from './providers/management.js';
import { createReadinessSetupRoutes } from './providers/readinessSetup.js';
import { createProviderServiceRoutes } from './providers/services.js';
import { createVisionAndPinRoutes } from './providers/visionAndPins.js';

// Fleet host and local daemon setup share a process-wide lock, so neither
// can start an install while the other is still using the same host resources.
const runtimeSetup = { holder: null };

/**
 * Mount the PortOS provider routes ahead of the AI Toolkit fallback.
 *
 * The injected sync may update local daemon catalogs before a list or catalog
 * response. It resolves true when the provider list needs to be read again.
 */
export function createPortOSProviderRoutes(aiToolkit, { syncProviderCatalogs } = {}) {
  const router = Router();
  router.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      res.once('finish', () => {
        if (res.statusCode < 400) {
          emitToOperatorsOn(req.app.get('io'), 'providers:changed');
          if (typeof req.body?.enabled === 'boolean' || req.method === 'DELETE'
            || (req.method === 'POST' && ['/', '/presets', '/:id/derive', '/:id/modes/tui'].includes(req.route?.path))) {
            runtimeUpdateEvents.emit('changed');
          }
        }
      });
    }
    next();
  });

  const fleetHost = createFleetHostRoutes(runtimeSetup);
  router.use(fleetHost);
  // Fleet routes invalidate their own readiness cache. Keep observation of
  // provider mutations behind the fleet router, as it was before the split.
  router.use(observeModelMutations('provider-readiness', 'provider-status', 'codex-account'));

  const { providers: providerService, providerStatus } = aiToolkit.services;
  const readProviders = async () => {
    const data = await providerService.getAllProviders();
    return (await syncProviderCatalogs?.(data.providers)) ? providerService.getAllProviders() : data;
  };

  const services = createProviderServiceRoutes();
  const readinessSetup = createReadinessSetupRoutes(providerService, runtimeSetup);
  const harnessesAndPresets = createHarnessAndPresetRoutes(providerService, readProviders);
  const codexAccount = createCodexAccountRoutes();
  const visionAndPins = createVisionAndPinRoutes(providerStatus);
  const management = createProviderManagementRoutes(providerService, readProviders);

  router.use(services);
  router.use(readinessSetup);
  router.use(harnessesAndPresets);
  router.use(codexAccount);
  router.use(visionAndPins);
  // Management has GET and PUT /:id. Keep literal paths in front of them.
  router.use(management);

  // The toolkit still owns DELETE /:id and POST /:id/test.
  router.use('/', aiToolkit.routes.providers);
  return router;
}
