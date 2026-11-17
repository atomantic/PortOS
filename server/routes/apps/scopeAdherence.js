/**
 * Advisory scope-adherence scoring for a managed app's Issues / Pull Requests tabs.
 *
 *   POST /:id/scope-adherence → { ok, verdict, clauseId, clause, margin, advisory }
 *
 * ADVISORY, NEVER A GATE: writes nothing and nothing downstream may branch on the answer.
 * POST because bodies exceed query-string size and starting the scorer is an explicit operator
 * action (AI Provider Usage Policy). The repo path comes from the loaded app record, never the
 * request, or this would be an arbitrary-file reader.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { scopeAdherenceRequestSchema } from '../../lib/scopeAdherence.js';
import { loadApp } from './shared.js';

const router = Router();

router.post('/:id/scope-adherence', loadApp, asyncHandler(async (req, res) => {
  const { kind, title, body, diffSummary } = validateRequest(scopeAdherenceRequestSchema, req.body);
  // Deferred: the scorer carries the sidecar lifecycle and a pinned 9 GB model; this route is
  // the only thing in the apps graph that reaches it (`server/lib/importScoping.test.js`).
  const { scoreAdherence } = await import('../../services/scopeAdherence.js');
  res.json(await scoreAdherence({
    kind,
    title,
    body,
    diffSummary,
    repoPath: req.loadedApp.repoPath,
  }));
}));

export default router;
