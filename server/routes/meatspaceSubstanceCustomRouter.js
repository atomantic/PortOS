import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { parseIndexParam } from '../lib/queryValidation.js';

export function createSubstanceCustomRouter({ schemas, service, itemLabel }) {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const items = await service.list();
    res.json(items);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const data = validateRequest(schemas.create, req.body);
    const item = await service.add(data);
    res.status(201).json(item);
  }));

  router.put('/:index', asyncHandler(async (req, res) => {
    const index = parseIndexParam(req.params.index);
    const data = validateRequest(schemas.update, req.body);
    const item = await service.update(index, data);
    if (!item) {
      throw new ServerError(`${itemLabel} not found`, { status: 404, code: 'NOT_FOUND' });
    }
    res.json(item);
  }));

  router.delete('/:index', asyncHandler(async (req, res) => {
    const index = parseIndexParam(req.params.index);
    const removed = await service.remove(index);
    if (!removed) {
      throw new ServerError(`${itemLabel} not found`, { status: 404, code: 'NOT_FOUND' });
    }
    res.json(removed);
  }));

  return router;
}
