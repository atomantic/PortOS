import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getGpuTelemetry, getSystemActivity } from '../services/activeProcessing.js';

const router = Router();

// Bounded activity snapshot: agents, media, 3D, LLM runs, mind, app operations,
// backup, and update state. No GPU shell-out. Clients read it once on subscribe
// and again when `system:activity` invalidates, including after a reconnect.
router.get('/activity', asyncHandler(async (_req, res) => {
  res.json(await getSystemActivity());
}));

// nvidia-smi samples. No event source — the live-activity inspector polls this
// only while it is visible. Do not call it from the global shell.
router.get('/gpu-telemetry', asyncHandler(async (_req, res) => {
  res.json(await getGpuTelemetry());
}));

export default router;
