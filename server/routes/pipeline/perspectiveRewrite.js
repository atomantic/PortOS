/**
 * Pipeline perspective-rewrite routes (#1290) — rewrite one issue's drafted
 * passage from another cast character's POV and analyze what the exercise
 * reveals. Non-destructive: rewrites are stored as alternate artifacts; the
 * canonical draft is never touched.
 *
 *   GET    /issues/:id/pov-rewrites              → { cast[], rewrites[], hasContent }
 *   POST   /issues/:id/pov-rewrites              → { status, rewrite }
 *   DELETE /issues/:id/pov-rewrites/:rewriteId   → { removed }
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { povRewriteSchema } from '../../lib/pipelineManuscriptValidation.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as perspectiveRewrite from '../../services/pipeline/perspectiveRewrite.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Stored rewrites + cast (for the picker) + per-rewrite stale flags.
router.get('/issues/:id/pov-rewrites', asyncHandler(async (req, res) => {
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await perspectiveRewrite.getPerspectiveRewrites(req.params.id));
}));

// Generate a new alternate-POV rewrite + analysis (synchronous — returns the
// finished artifact).
router.post('/issues/:id/pov-rewrites', asyncHandler(async (req, res) => {
  const body = validateRequest(povRewriteSchema, req.body ?? {});
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = await perspectiveRewrite.generatePerspectiveRewrite(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  if (result.status === 'no-content') {
    throw new ServerError('This issue has no drafted prose, comic script, or teleplay to rewrite yet', { status: 409 });
  }
  if (result.status === 'unknown-character') {
    throw new ServerError(`Unknown POV character: ${result.povCharacterId}`, { status: 400 });
  }
  if (result.status === 'empty-rewrite') {
    throw new ServerError('The rewrite produced no text — try again or pick a different POV', { status: 502 });
  }
  res.json(result);
}));

// Remove one stored rewrite artifact.
router.delete('/issues/:id/pov-rewrites/:rewriteId', asyncHandler(async (req, res) => {
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await perspectiveRewrite.deletePerspectiveRewrite(req.params.id, req.params.rewriteId));
}));

export default router;
