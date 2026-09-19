/**
 * Advisory scope-adherence scoring for a managed app's Issues / Pull Requests
 * tabs.
 *
 *   POST /:id/scope-adherence → { ok, verdict, clauseId, clause, margin, advisory }
 *
 * ADVISORY, NEVER A GATE. The handler writes nothing: no label, no close, no
 * task, no persisted record. It reads `PRD.md` / `GOALS.md` out of the app's
 * own checkout and asks the local entailment scorer whether the change in the
 * request advances what those files say the product is for. The answer is
 * rendered next to the row; nothing downstream may branch on it.
 *
 * POST rather than GET because an issue or PR body is too large for a query
 * string, and because starting the scorer is an explicit operator action in
 * the same request (AI Provider Usage Policy) — this never runs on its own.
 *
 * The repository path comes from the LOADED APP RECORD, never from the
 * request. A client-supplied checkout path would turn an advisory endpoint
 * into an arbitrary-file reader.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { scopeAdherenceRequestSchema } from '../../lib/scopeAdherence.js';
import { loadApp } from './shared.js';

const router = Router();

router.post('/:id/scope-adherence', loadApp, asyncHandler(async (req, res) => {
  const { kind, title, body, diffSummary } = validateRequest(scopeAdherenceRequestSchema, req.body);
  // Deferred: the scorer carries the sidecar lifecycle and the pinned 9 GB
  // model contract, and this route is the only thing in the apps graph that
  // reaches it (`server/lib/importScoping.test.js`).
  const { scoreAdherence } = await import('../../services/scopeAdherence.js');
  res.json(await scoreAdherence({
    kind,
    title,
    body,
    diffSummary,
    // `?? ''` rather than letting it fall through as `undefined`: the service
    // defaults an ABSENT path to this install's own checkout, and an app
    // record with no repository would then be graded against PortOS's PRD.
    repoPath: req.loadedApp.repoPath ?? '',
  }));
}));

export default router;
