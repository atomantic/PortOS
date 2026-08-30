/**
 * PortOS-owned Eidoverse world controls.
 *
 * The hosted Eidoverse client remains the renderer. These routes own the
 * install-local identity, projection recipe, deterministic projection, and
 * the narrow set of world operations that PortOS is allowed to submit.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  eidoverseWorldAugmentSchema,
  eidoverseWorldConfigPatchSchema,
  eidoverseWorldSaySchema,
  validateRequest,
} from '../lib/validation.js';
import {
  augmentEidoverseWorld,
  ensureEidoverseWorldPresence,
  getEidoverseWorldStatus,
  projectEidoverseWorld,
  sayInEidoverseWorld,
  updateEidoverseWorldConfig,
} from '../services/eidoverseWorld.js';

const router = Router();

// GET /api/eidoverse/world/status — install-local identity, recipe, and
// runtime/presence state for the hosted world page.
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getEidoverseWorldStatus());
}));

// PUT /api/eidoverse/world/config — persist the human/CoS identity and
// deterministic PortOS projection recipe for this install.
router.put('/config', asyncHandler(async (req, res) => {
  const patch = validateRequest(eidoverseWorldConfigPatchSchema, req.body || {});
  res.json({ success: true, ...(await updateEidoverseWorldConfig(patch)) });
}));

// POST /api/eidoverse/world/presence — establish the persistent CoS agent
// presence without requiring a browser tab to remain open.
router.post('/presence', asyncHandler(async (_req, res) => {
  res.json(await ensureEidoverseWorldPresence());
}));

// POST /api/eidoverse/world/project — refresh the world from live PortOS
// resources using the saved recipe. This is deterministic and makes no AI
// provider call.
router.post('/project', asyncHandler(async (_req, res) => {
  res.json(await projectEidoverseWorld());
}));

// POST /api/eidoverse/world/augment — apply bounded, allowlisted world verbs
// for manual or CoS-authored augmentation.
router.post('/augment', asyncHandler(async (req, res) => {
  const { operations } = validateRequest(eidoverseWorldAugmentSchema, req.body || {});
  res.json(await augmentEidoverseWorld(operations));
}));

// POST /api/eidoverse/world/say — persist a PortOS/CoS message in the world
// chat through the same authoritative world protocol.
router.post('/say', asyncHandler(async (req, res) => {
  const { text } = validateRequest(eidoverseWorldSaySchema, req.body || {});
  res.json(await sayInEidoverseWorld(text));
}));

export default router;
