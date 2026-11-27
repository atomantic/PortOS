import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { dailyRangeQuerySchema, substanceEventQuerySchema } from '../lib/meatspaceValidation.js';
import { parseIndexParam } from '../lib/queryValidation.js';

export function  createSubstanceRouter({ schemas, service, entryLabel }) {
  const router = Router();
  router.get('/', asyncHandler(async (req, res) => {
    const summary = await service.summary();
    res.json(summary);
  }));

  router.get('/daily', asyncHandler(async (req, res) => {
    const { from, to } = validateRequest(dailyRangeQuerySchema, req.query);
    const entries = await service.daily(from, to);
    res.json(entries);
  }));

  router.post('/log', asyncHandler(async (req, res) => {
    const data = validateRequest(schemas.log, req.body);
    const result = await service.log(data);
    res.status(201).json(result);
  }));

  router.put('/log/:date/:index', asyncHandler(async (req, res) => {
    const { date, index } = req.params;
    const data = validateRequest(schemas.update, req.body);
    const parsedIndex = parseIndexParam(index);
    const result = await service.update(date, parsedIndex, data);
    if (!result) {
      throw new ServerError(`${entryLabel} not found`, { status: 404, code: 'NOT_FOUND' });
    }
    res.json(result);
  }));

  router.delete('/log/:date/:index', asyncHandler(async (req, res) => {
    const { date, index } = req.params;
    const parsedIndex = parseIndexParam(index);
    const { id } = validateRequest(substanceEventQuerySchema, req.query);
    const removed = await service.remove(date, parsedIndex, id);
    if (!removed) {
      throw new ServerError(`${entryLabel} not found`, { status: 404, code: 'NOT_FOUND' });
    }
    res.json(removed);
  }));

  return router;
}
