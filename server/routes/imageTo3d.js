import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  listTargets,
  detectHostCapabilities,
} from '../services/imageTo3d/targets.js';
import { isTrellis2Installed } from '../services/imageTo3d/trellis2.js';

const router = Router();

// Per-target local-install probe. Targets with no local install concept (hosted
// APIs) report null. Single dispatch point so the route stays thin as targets grow.
const targetInstalled = (targetId) => {
  if (targetId === 'trellis2') return isTrellis2Installed();
  return null;
};

/**
 * The selectable image→3D targets, each annotated with whether it can run on
 * this host (Apple Silicon / memory gating) and whether its local model is
 * installed — so the client can render a target selector with disabled /
 * needs-install / ready states. Read-only, no LLM/GPU work — safe to call on
 * load. Later phases add the create/generate/asset endpoints.
 */
router.get('/targets', asyncHandler(async (_req, res) => {
  const capabilities = detectHostCapabilities();
  const targets = listTargets(capabilities).map((target) => ({
    ...target,
    installed: targetInstalled(target.id),
  }));
  res.json({ capabilities, targets });
}));

export default router;
