/**
 * Author persona routes.
 *
 *   GET    /api/authors        → Author[]   (live, sorted by name; `?limit`/`?offset`
 *                                            switches to the bounded envelope)
 *   POST   /api/authors        → Author
 *   GET    /api/authors/:id     → Author
 *   PATCH  /api/authors/:id     → Author
 *   DELETE /api/authors/:id     → { id }     (soft delete)
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { paginationQuerySchema, isPaginationRequested, paginateArray } from '../lib/queryValidation.js';
import * as authors from '../services/authors/index.js';
import { createSchema, patchSchema } from '../lib/authorValidation.js';

const router = Router();

// Backward-compatible by default: returns the full authors array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const list = await authors.listAuthors();
  const query = validateRequest(paginationQuerySchema, req.query);
  if (!isPaginationRequested(query)) return res.json(list);
  res.json(paginateArray(list, query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await authors.createAuthor(body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const author = await authors.getAuthor(req.params.id);
  if (!author) throw new ServerError('Author not found', { status: 404, code: 'NOT_FOUND' });
  res.json(author);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  res.json(await authors.updateAuthor(req.params.id, body));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await authors.deleteAuthor(req.params.id));
}));

export default router;
