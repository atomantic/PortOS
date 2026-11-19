import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { getFallbackChain, saveFallbackChain } from '../services/provider/providerFallbackChain.js';
import { providerFallbackChainBodySchema } from '../lib/providerValidation.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json({ entries: await getFallbackChain() });
}));

router.put('/', asyncHandler(async (req, res) => {
  const body = validateRequest(providerFallbackChainBodySchema, req.body ?? {});
  res.json({ entries: await saveFallbackChain(body) });
}));

export default router;
