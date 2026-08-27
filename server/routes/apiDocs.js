/**
 * API Docs routes.
 *
 * Serves generated OpenAPI 3.1, AsyncAPI 3, and searchable catalog documents.
 * The client renders the OpenAPI documents with the lazy-loaded Scalar viewer
 * and uses the compact catalogs for the native HTTP/event explorer tabs.
 *
 * Mounted at /api/api-docs. Stays GATED when the PortOS password is on (it's a
 * normal /api/* route, not in the registry's public prefixes): the spec
 * describes config and is read from the authenticated UI; external callers
 * don't need it to call the documented endpoints.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getSettings } from '../services/settings.js';
import { getCurrentVersion } from '../services/updateChecker.js';
import { buildApiCatalog } from '../lib/apiCatalog.js';
import { buildAsyncApiSpec } from '../lib/asyncApiSpec.js';
import { buildInternalOpenApiSpec, buildOpenApiSpec } from '../lib/openapiSpec.js';
import { buildSocketEventCatalog } from '../lib/socketEventCatalog.js';

const router = Router();

// Derive the base URL the client is reaching us on so the spec's `servers`
// entry (and the example curls the UI renders) are copy-pasteable. Honors a
// reverse proxy's X-Forwarded-* headers when present.
const baseUrlFromReq = (req) => {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
};

// GET /api/api-docs/openapi.json — the OpenAPI 3.1 document for exposed APIs.
router.get('/openapi.json', asyncHandler(async (req, res) => {
  const [settings, version] = await Promise.all([getSettings(), getCurrentVersion()]);
  res.json(buildOpenApiSpec(settings, { baseUrl: baseUrlFromReq(req), version }));
}));

// GET /api/api-docs/internal/openapi.json — every mounted HTTP operation.
router.get('/internal/openapi.json', asyncHandler(async (req, res) => {
  const [settings, version] = await Promise.all([getSettings(), getCurrentVersion()]);
  res.json(buildInternalOpenApiSpec(settings, { baseUrl: baseUrlFromReq(req), version }));
}));

// GET /api/api-docs/catalog.json — compact searchable metadata for the UI.
router.get('/catalog.json', asyncHandler(async (_req, res) => {
  res.json(buildApiCatalog(await getSettings()));
}));

// GET /api/api-docs/events.json — searchable Socket.IO event metadata.
router.get('/events.json', (_req, res) => {
  res.json(buildSocketEventCatalog());
});

// GET /api/api-docs/asyncapi.json — AsyncAPI 3 for the Socket.IO transport.
router.get('/asyncapi.json', asyncHandler(async (req, res) => {
  const version = await getCurrentVersion();
  res.json(buildAsyncApiSpec({ baseUrl: baseUrlFromReq(req), version }));
}));

export default router;
