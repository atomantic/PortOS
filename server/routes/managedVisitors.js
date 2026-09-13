import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { visitorCancellationSchema, visitorCredentialSchema, visitorAdmissionSchema, visitorScopeSchema, visitorActionSchema, visitorIdSchema } from '../lib/managedVisitorValidation.js';
import { getManagedVisitorBroker } from '../services/managedVisitors.js';
import { isCrossOrigin } from '../../lib/portosAuthCore.js';

// Keep the large shared validation barrel off the broker's import-only path.
const validateRequest = async (schema, value) => (await import('../lib/validation.js')).validateRequest(schema, value);

export function createManagedVisitorRoutes(getBroker = getManagedVisitorBroker) {
  const router = Router();
  router.use((req, _res, next) => {
    if (!req.managedVisitorAuth) return next(new ServerError('Managed app credential required.', { status: 401 }));
    next();
  });
  router.get('/capabilities', asyncHandler(async (req, res) => res.json(await getBroker().capabilities(req.managedVisitorAuth))));
  router.post('/admissions/cancel', asyncHandler(async (req, res) => {
    res.json(await getBroker().cancelAdmission(req.managedVisitorAuth, await validateRequest(visitorCancellationSchema, req.body)));
  }));
  router.post('/sessions/:id/leave', asyncHandler(async (req, res) => {
    res.json(await getBroker().leave(req.managedVisitorAuth, await validateRequest(visitorIdSchema, req.params.id), await validateRequest(visitorScopeSchema, req.body)));
  }));
  router.post('/admissions', asyncHandler(async (req, res) => {
    const body = await validateRequest(visitorAdmissionSchema, req.body); res.json(await getBroker().admit(req.managedVisitorAuth, body));
  }));
  router.post('/sessions/:id/observations', asyncHandler(async (req, res) => {
    const id = await validateRequest(visitorIdSchema, req.params.id), body = await validateRequest(visitorScopeSchema, req.body);
    res.json(await getBroker().observe(req.managedVisitorAuth, id, body));
  }));
  router.post('/sessions/:id/actions', asyncHandler(async (req, res) => {
    const id = await validateRequest(visitorIdSchema, req.params.id), body = await validateRequest(visitorActionSchema, req.body);
    res.json(await getBroker().action(req.managedVisitorAuth, id, body));
  }));
  return router;
}

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
