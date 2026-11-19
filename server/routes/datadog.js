/**
 * DataDog API Routes
 */

import express from 'express';
import * as datadogService from '../services/datadog.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { datadogInstanceRequestSchema, datadogSearchErrorsRequestSchema } from '../lib/appValidation.js';

const router = express.Router();

function sanitizeInstance(instance) {
  return {
    id: instance.id,
    name: instance.name,
    site: instance.site,
    hasApiKey: !!instance.apiKey,
    hasAppKey: !!instance.appKey,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt
  };
}

/**
 * GET /api/datadog/instances
 * Get all DataDog instances
 */
router.get('/instances', asyncHandler(async (req, res) => {
  const config = await datadogService.getInstances();

  const sanitized = {
    instances: Object.fromEntries(
      Object.entries(config.instances ?? {}).map(([id, instance]) => [id, sanitizeInstance(instance)])
    )
  };

  res.json(sanitized);
}));

/**
 * POST /api/datadog/instances
 * Create or update DataDog instance
 */
router.post('/instances', asyncHandler(async (req, res) => {
  const { id, name, site, apiKey, appKey } = validateRequest(datadogInstanceRequestSchema, req.body);

  // For new instances, both keys are required
  const config = await datadogService.getInstances();
  const isNew = !config.instances[id];
  if (isNew && (!apiKey || !appKey)) {
    throw new ServerError('API Key and Application Key are required for new instances', {
      status: 400,
      code: 'INVALID_INPUT'
    });
  }

  const instance = await datadogService.upsertInstance(id, {
    name,
    site,
    ...(apiKey && { apiKey }),
    ...(appKey && { appKey })
  });

  res.json(sanitizeInstance(instance));
}));

/**
 * DELETE /api/datadog/instances/:id
 * Delete DataDog instance
 */
router.delete('/instances/:id', asyncHandler(async (req, res) => {
  await datadogService.deleteInstance(req.params.id);
  res.json({ success: true });
}));

/**
 * POST /api/datadog/instances/:id/test
 * Test DataDog instance connection
 */
router.post('/instances/:id/test', asyncHandler(async (req, res) => {
  const result = await datadogService.testConnection(req.params.id);
  res.json(result);
}));

/**
 * POST /api/datadog/instances/:id/search-errors
 * Search for errors in DataDog logs
 */
router.post('/instances/:id/search-errors', asyncHandler(async (req, res) => {
  const { serviceName, environment, fromTime } = validateRequest(datadogSearchErrorsRequestSchema, req.body);

  const result = await datadogService.searchErrors(
    req.params.id,
    serviceName,
    environment,
    fromTime
  );
  res.json(result);
}));

export default router;
