/**
 * Digital Twin — Live Avatar Bio.
 *
 * A concise, copy-ready "Who I am / How I speak / What I know" persona for live
 * avatar platforms. GET builds it deterministically (no LLM); POST /polish is an
 * explicit, user-triggered provider call that rewrites it into first-person prose.
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { avatarBioQuerySchema, avatarBioPolishInputSchema } from '../../lib/digitalTwinValidation.js';

const router = Router();

/**
 * GET /api/digital-twin/avatar-bio?length=persona
 * Deterministic three-part avatar bio. Safe to call on tab load (no LLM).
 */
router.get('/avatar-bio', asyncHandler(async (req, res) => {
  const { length } = validateRequest(avatarBioQuerySchema, req.query);
  const bio = await digitalTwinService.buildAvatarBio({ length });
  res.json(bio);
}));

/**
 * POST /api/digital-twin/avatar-bio/polish
 * Rewrite the deterministic draft into first-person avatar-ready prose via an
 * AI provider (explicit user action).
 */
router.post('/avatar-bio/polish', asyncHandler(async (req, res) => {
  const { providerId, model, length } = validateRequest(avatarBioPolishInputSchema, req.body);
  const result = await digitalTwinService.polishAvatarBio({ providerId, model, length });
  res.json(result);
}));

export default router;
