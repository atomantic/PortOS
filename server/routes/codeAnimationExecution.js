/**
 * Code Animation production execution capability (#9388).
 *
 *   GET  /api/code-animation/execution         platform mechanism, tools, lane readiness, last check
 *   PUT  /api/code-animation/execution/tools   operator-owned installed-tool paths (host control)
 *   POST /api/code-animation/execution/probe   run the adversarial containment check (host control)
 *
 * Packages never reach these routes' choices: they cannot name an executable,
 * install command or mount. Nothing here calls a provider.
 */
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { codeAnimationExecutionToolsSchema } from '../lib/codeAnimationContainment.js';
import {
  getCodeAnimationExecution, probeCodeAnimationExecution, setCodeAnimationExecutionTools,
} from '../services/codeAnimation/execution.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await getCodeAnimationExecution());
}));

router.put('/tools', asyncHandler(async (req, res) => {
  res.json(await setCodeAnimationExecutionTools(validateRequest(codeAnimationExecutionToolsSchema, req.body ?? {})));
}));

router.post('/probe', asyncHandler(async (_req, res) => {
  res.json(await probeCodeAnimationExecution());
}));

export default router;
