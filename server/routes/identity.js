import { Router } from 'express';
import * as identityService from '../services/identity.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { chronotypeBehavioralInputSchema } from '../lib/identityValidation.js';

const router = Router();

// GET /api/digital-twin/identity — Unified section status
router.get('/', asyncHandler(async (req, res) => {
  const status = await identityService.getIdentityStatus();
  res.json(status);
}));

// GET /api/digital-twin/identity/chronotype — Full chronotype profile
router.get('/chronotype', asyncHandler(async (req, res) => {
  const chronotype = await identityService.getChronotype();
  res.json(chronotype);
}));

// POST /api/digital-twin/identity/chronotype/derive — Force re-derivation
router.post('/chronotype/derive', asyncHandler(async (req, res) => {
  const chronotype = await identityService.deriveChronotype();
  res.json(chronotype);
}));

// PUT /api/digital-twin/identity/chronotype — Behavioral overrides
router.put('/chronotype', asyncHandler(async (req, res) => {
  const data = validateRequest(chronotypeBehavioralInputSchema, req.body);
  const chronotype = await identityService.updateChronotypeBehavioral(data);
  res.json(chronotype);
}));

export default router;
