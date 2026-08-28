/** Authenticated HTTP transport for the provider-neutral CoS tool registry. */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import {
  cosToolCallParamsSchema,
  cosToolCallSchema,
  cosToolCatalogQuerySchema,
} from '../lib/cosToolContracts.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { canonicalStringify } from '../lib/objects.js';
import { validateRequest } from '../lib/validation.js';
import { loadState } from '../services/cosState.js';
import { getSettings } from '../services/settings.js';
import {
  executeCosToolCall,
  formatCosToolCatalog,
  getCosToolCall,
  getCosToolCatalog,
} from '../services/cosToolRegistry.js';

const router = Router();

const etagFor = (value) => `"${createHash('sha256').update(canonicalStringify(value)).digest('base64url')}"`;

router.get('/tools', asyncHandler(async (req, res) => {
  const query = validateRequest(cosToolCatalogQuerySchema, req.query);
  const [state, settings] = await Promise.all([loadState(), getSettings()]);
  const catalog = getCosToolCatalog({
    scope: query.scope,
    intent: query.intent,
    capabilities: query.scope === 'agent'
      ? settings.agentContext?.actions
      : state.config?.persistentMindCapabilities,
  });
  const response = formatCosToolCatalog(catalog, query.format);
  const etag = etagFor(response);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.json(response);
}));

router.post('/tools/call', asyncHandler(async (req, res) => {
  const call = validateRequest(cosToolCallSchema, req.body || {});
  const headerId = req.headers['idempotency-key'];
  if (headerId && headerId !== call.requestId) {
    throw new ServerError('Idempotency-Key must match requestId', { status: 400, code: 'TOOL_IDEMPOTENCY_MISMATCH' });
  }
  const result = await executeCosToolCall({
    call,
    authority: {
      scope: 'ui',
      authenticated: req.portosAuthContext?.authenticated === true,
    },
  });
  res.status(result.state === 'failed' ? 422 : 200).json(result);
}));

router.get('/tools/calls/:requestId', asyncHandler(async (req, res) => {
  const { requestId } = validateRequest(cosToolCallParamsSchema, req.params);
  const result = await getCosToolCall(requestId);
  if (!result) throw new ServerError('Tool call not found', { status: 404, code: 'TOOL_CALL_NOT_FOUND' });
  res.json(result);
}));

export default router;
