/**
 * Digital Twin document CRUD.
 *
 *   GET    /documents         → list
 *   GET    /documents/:id     → single (404 when unknown)
 *   POST   /documents         → create (201)
 *   PUT    /documents/:id     → update (404 when unknown)
 *   DELETE /documents/:id     → delete (204 / 404)
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  createDocumentInputSchema,
  updateDocumentInputSchema,
} from '../../lib/digitalTwinValidation.js';

const router = Router();

/**
 * GET /api/digital-twin/documents
 * List all digital twin documents
 */
router.get('/documents', asyncHandler(async (req, res) => {
  const documents = await digitalTwinService.getDocuments();
  res.json(documents);
}));

/**
 * GET /api/digital-twin/documents/:id
 * Get a single document with content
 */
router.get('/documents/:id', asyncHandler(async (req, res) => {
  const document = await digitalTwinService.getDocumentById(req.params.id);
  if (!document) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(document);
}));

/**
 * POST /api/digital-twin/documents
 * Create a new document
 */
router.post('/documents', asyncHandler(async (req, res) => {
  const data = validateRequest(createDocumentInputSchema, req.body);
  const document = await digitalTwinService.createDocument(data);
  res.status(201).json(document);
}));

/**
 * PUT /api/digital-twin/documents/:id
 * Update a document
 */
router.put('/documents/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(updateDocumentInputSchema, req.body);
  const document = await digitalTwinService.updateDocument(req.params.id, data);
  if (!document) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(document);
}));

/**
 * DELETE /api/digital-twin/documents/:id
 * Delete a document
 */
router.delete('/documents/:id', asyncHandler(async (req, res) => {
  const deleted = await digitalTwinService.deleteDocument(req.params.id);
  if (!deleted) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

export default router;
