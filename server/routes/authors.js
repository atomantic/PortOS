/**
 * Author persona routes.
 *
 *   GET    /api/authors        → Author[]   (live, sorted by name)
 *   POST   /api/authors        → Author
 *   GET    /api/authors/:id     → Author
 *   PATCH  /api/authors/:id     → Author
 *   DELETE /api/authors/:id     → { id }     (soft delete)
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';
import * as authors from '../services/authors/index.js';

const router = Router();

const nameField = z.string().trim().min(1).max(authors.NAME_MAX);
const writingStyleField = z.string().trim().max(authors.WRITING_STYLE_MAX);
const bioField = z.string().trim().max(authors.BIO_MAX);
const physicalDescriptionField = z.string().trim().max(authors.PHYSICAL_DESCRIPTION_MAX);
const headshotStyleField = z.string().trim().max(authors.HEADSHOT_STYLE_MAX);
const headshotImageUrlField = z.string().trim().max(authors.HEADSHOT_IMAGE_URL_MAX);

const createSchema = z.object({
  name: nameField,
  writingStyle: writingStyleField.optional().default(''),
  bio: bioField.optional().default(''),
  physicalDescription: physicalDescriptionField.optional().default(''),
  headshotStyle: headshotStyleField.optional().default(''),
  headshotImageUrl: headshotImageUrlField.optional().default(''),
});

const patchSchema = z.object({
  name: nameField.optional(),
  writingStyle: writingStyleField.optional(),
  bio: bioField.optional(),
  physicalDescription: physicalDescriptionField.optional(),
  headshotStyle: headshotStyleField.optional(),
  headshotImageUrl: headshotImageUrlField.optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

router.get('/', asyncHandler(async (req, res) => {
  const list = await authors.listAuthors();
  if (!isPaginationRequested(req.query)) return res.json(list);
  res.json(paginateArray(list, req.query, { defaultLimit: 50, maxLimit: 500 }));
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
