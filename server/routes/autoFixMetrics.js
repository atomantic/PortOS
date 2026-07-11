/**
 * Auto-Fix Metrics Routes (issue #2328)
 *
 * GET /api/autofix/metrics — aggregated auto-fix telemetry derived from the
 * structured `metadata.diagnostics` persisted on task records: outcomes broken
 * out by fallback tier, failure category, and task status, a time-to-recovery
 * summary, and a daily success-rate trend for the dashboard widget.
 *
 * Read-only, no inputs — so no Zod schema. Errors bubble to the centralized
 * middleware via asyncHandler.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getAutoFixMetrics } from '../services/autoFixMetrics.js';

const router = Router();

router.get('/metrics', asyncHandler(async (req, res) => {
  const metrics = await getAutoFixMetrics();
  res.json(metrics);
}));

export default router;
