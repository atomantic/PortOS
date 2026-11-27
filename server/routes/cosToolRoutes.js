/** Authenticated HTTP transport for the provider-neutral CoS tool registry. */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import { cosToolCatalogQuerySchema } from '../lib/cos/cosToolContracts.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { canonicalStringify } from '../lib/objects.js';
import { validateRequest } from '../lib/validateRequest.js';
import { loadState } from '../services/cos/cosState.js';
import { getSettings } from '../services/settings.js';
import {
  formatCosToolCatalog,
  getCosToolCatalog,
  readCosToolRecipeCatalog,
} from '../services/cos/cosToolRegistry.js';

const router = Router();

const etagFor = (value) => `"${createHash('sha256').update(canonicalStringify(value)).digest('base64url')}"`;

router.get('/tools', asyncHandler(async (req, res) => {
  const query = validateRequest(cosToolCatalogQuerySchema, req.query);
  const [state, settings] = await Promise.all([loadState(), getSettings()]);
  const capabilities = query.scope === 'agent'
    ? settings.agentContext?.actions
    : state.config?.persistentMindCapabilities;
  const recipes = await readCosToolRecipeCatalog({ scope: query.scope });
  const reportAccess = query.scope === 'mind'
    ? await import('../services/persistent/persistentMindProcessAudit.js').then(({ readProcessAuditAccess }) => readProcessAuditAccess({ root: state })) : undefined;
  const catalog = getCosToolCatalog({
    scope: query.scope,
    intent: query.intent,
    capabilities,
    recipes,
    reportAccess,
  });
  const response = formatCosToolCatalog(catalog, query.format);
  const etag = etagFor(response);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.json(response);
}));

export default router;
