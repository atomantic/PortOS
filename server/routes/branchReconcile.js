import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { runBranchReconcile, getLastRun } from '../services/branchReconcileScheduler.js';

const router = Router();

// GET /api/branch-reconcile/status — last run summary (null until first run).
router.get('/status', asyncHandler(async (req, res) => {
  res.json({ lastRun: getLastRun() });
}));

// POST /api/branch-reconcile/run — run one reconcile pass on demand. An explicit
// user click is its own consent, so it bypasses the enabled gate (force:true).
router.post('/run', asyncHandler(async (req, res) => {
  const summary = await runBranchReconcile({ force: true });
  res.json(summary);
}));

export default router;
