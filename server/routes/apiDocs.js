/**
 * API Docs routes.
 *
 * Serves a native OpenAPI 3.1 spec describing PortOS's public API surface
 * (built from server/lib/apiRegistry.js + openapiSpec.js). The client renders
 * it on the /api-access page — no swagger-ui dependency.
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
import { buildOpenApiSpec } from '../lib/openapiSpec.js';

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

export default router;
