import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { visitorCancellationSchema, visitorAdmissionSchema, visitorScopeSchema, visitorActionSchema, visitorIdSchema } from '../lib/managedVisitorValidation.js';
import { getManagedVisitorBroker } from '../services/managedVisitors.js';

// Keep the large shared validation barrel off the broker's import-only path.
export const validateRequest = async (schema, value) => (await import('../lib/validation.js')).validateRequest(schema, value);

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
