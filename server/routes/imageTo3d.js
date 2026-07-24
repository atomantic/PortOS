import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  listTargets,
  detectHostCapabilities,
} from '../services/imageTo3d/targets.js';

const router = Router();

/**
 * The selectable image→3D targets, each annotated with whether it can run on
 * this host (Apple Silicon / memory gating) so the client can render a target
 * selector with disabled / needs-install states. Read-only, no LLM/GPU work —
 * safe to call on load. Later phases add the create/generate/asset endpoints.
 */
router.get('/targets', asyncHandler(async (_req, res) => {
  const capabilities = detectHostCapabilities();
  res.json({ capabilities, targets: listTargets(capabilities) });
}));

export default router;
