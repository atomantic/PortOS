import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, providerFallbackChainBodySchema } from '../lib/validation.js';
import { getFallbackChain, saveFallbackChain } from '../services/providerFallbackChain.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json({ entries: await getFallbackChain() });
}));

router.put('/', asyncHandler(async (req, res) => {
  const body = validateRequest(providerFallbackChainBodySchema, req.body ?? {});
  res.json({ entries: await saveFallbackChain(body) });
}));

export default router;
