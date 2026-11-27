import { Router } from 'express';
import { removeConnection } from '../../services/provider/providerGraph.js';
import {
  createService,
  getService,
  listServices,
  refreshServiceCatalog,
  updateService,
} from '../../services/provider/providerServices.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { SERVICE_DEFINITIONS } from '../../lib/serviceDefinitions.js';
import { presentServiceDefinition } from '../../lib/provider/providerServiceInstances.js';
import {
  providerServiceCreateSchema,
  providerServiceUpdateSchema,
  credentialPoolKeyCreateSchema,
  credentialPoolKeyUpdateSchema,
  credentialPoolResetSchema,
  credentialPoolSettingsSchema,
} from '../../lib/providerValidation.js';

export function createProviderServiceRoutes() {
  const router = Router();

  /**
   * Service INSTANCES (#7563) — the same `ai_connections` rows read as one
   * instance each of a `SERVICE_DEFINITIONS` entry: slug, definition, plan,
   * enabled, how it authenticates, and the catalog it last listed. Sanitized
   * like the graph: credential PRESENCE and SOURCE only, never a value.
   *
   * `:slug` also accepts the row's UUID.
   */
  router.get('/services', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await listServices());
  }));

  /**
   * Every `SERVICE_DEFINITIONS` row an "Add service" flow may instantiate
   * (#7567): family, plans, transports with default base URLs, and where a key
   * is obtained. Code-only data — no instance, no credential — so it is
   * cacheable for the process lifetime.
   */
  router.get('/service-definitions', asyncHandler(async (_req, res) => {
    res.json({ definitions: SERVICE_DEFINITIONS.map(presentServiceDefinition) });
  }));

  // Create an instance from a definition. Nothing is probed and no route is
  // minted; the catalog starts `unknown` until the explicit refresh below.
  router.post('/services', asyncHandler(async (req, res) => {
    const input = validateRequest(providerServiceCreateSchema, req.body ?? {});
    res.status(201).json(await createService(input));
  }));

  router.get('/services/:slug', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await getService(req.params.slug));
  }));

  // The shared-backend edit plus plan / enabled / credential mode. Same
  // required `expectedRevision`, same three-valued credential rule, same
  // projection into every route on the row.
  router.patch('/services/:slug', asyncHandler(async (req, res) => {
    const input = validateRequest(providerServiceUpdateSchema, req.body ?? {});
    res.json(await updateService(req.params.slug, input));
  }));

  // Refused with a 409 while a binding still names the connection row.
  router.delete('/services/:slug', asyncHandler(async (req, res) => {
    res.json(await removeConnection(req.params.slug));
  }));

  /**
   * List the instance's models through its DEFINITION's strategy — a probe of
   * its own endpoint with its own key, the local daemon, the program that signs
   * in, or the declared list — filtered to its plan. Needs no executable route.
   * An explicit discovery request: it lists, never generates, and a failure
   * keeps the catalog the instance already had.
   */
  router.post('/services/:slug/refresh-catalog', asyncHandler(async (req, res) => {
    res.json(await refreshServiceCatalog(req.params.slug));
  }));

  /**
   * The instance's credential pool (#17384): extra keys for the same backend,
   * tried before the cross-provider fallback chain. Every response is the
   * display-safe pool — masked fingerprints, cooldowns, origin bindings — and
   * the GET is a pure peek: it never rotates, benches or expires a key.
   * Machine-local like the row itself; nothing here federates. Deferred: the
   * pool service and its ledger load on first use, not with every boot
   * (server/AGENTS.md "Import scoping").
   */
  const credentialPools = () => import('../../services/provider/providerCredentialPools.js');
  router.get('/services/:slug/credential-pool', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await (await credentialPools()).getCredentialPool(req.params.slug));
  }));

  router.patch('/services/:slug/credential-pool', asyncHandler(async (req, res) => {
    const input = validateRequest(credentialPoolSettingsSchema, req.body ?? {});
    res.json(await (await credentialPools()).updatePoolSettings(req.params.slug, input));
  }));

  router.post('/services/:slug/credential-pool/keys', asyncHandler(async (req, res) => {
    const input = validateRequest(credentialPoolKeyCreateSchema, req.body ?? {});
    res.status(201).json(await (await credentialPools()).addPoolCredential(req.params.slug, input));
  }));

  router.patch('/services/:slug/credential-pool/keys/:credentialId', asyncHandler(async (req, res) => {
    const input = validateRequest(credentialPoolKeyUpdateSchema, req.body ?? {});
    res.json(await (await credentialPools()).updatePoolCredential(req.params.slug, req.params.credentialId, input));
  }));

  router.delete('/services/:slug/credential-pool/keys/:credentialId', asyncHandler(async (req, res) => {
    res.json(await (await credentialPools()).removePoolCredential(req.params.slug, req.params.credentialId));
  }));

  router.post('/services/:slug/credential-pool/reset', asyncHandler(async (req, res) => {
    const input = validateRequest(credentialPoolResetSchema, req.body ?? {});
    res.json(await (await credentialPools()).resetPoolCredentialCooldowns(req.params.slug, input));
  }));

  return router;
}
