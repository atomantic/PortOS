import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { visitorCredentialSchema, visitorIdSchema } from '../lib/managedVisitorValidation.js';
import { getManagedVisitorBroker } from '../services/managedVisitors.js';
import { isCrossOrigin } from '../../lib/portosAuthCore.js';
import { validateRequest } from './managedVisitors.js';

// Owner provisioning lives in its own module so the route-graph scan, which
// keys a module by its router, credits these routes to this mount alone.
export function createManagedVisitorAdminRoutes(getBroker = getManagedVisitorBroker) {
  const router = Router();
  router.use((req, _res, next) => {
    // No app/peer credential acquires owner provisioning authority. Auth-off retains
    // PortOS's documented private-install owner API posture, with explicit CSRF protection.
    if (isCrossOrigin(req) || /^Bearer mv1_/i.test(req.headers.authorization ?? '')
      || req.portosAuthContext?.enabled && req.portosAuthContext.method !== 'session') {
      return next(new ServerError('Visitor credential management requires the owner interface.', { status: 403 }));
    }
    next();
  });
  router.get('/', asyncHandler(async (_req, res) => res.json({ credentials: await getBroker().listCredentials() })));
  router.post('/:appId/credential', asyncHandler(async (req, res) => {
    const id = await validateRequest(visitorIdSchema, req.params.appId), body = await validateRequest(visitorCredentialSchema, req.body);
    res.set('Cache-Control', 'no-store'); res.json(await getBroker().provision(id, body));
  }));
  router.delete('/:appId/credential', asyncHandler(async (req, res) => {
    res.json(await getBroker().revoke(await validateRequest(visitorIdSchema, req.params.appId)));
  }));
  return router;
}
