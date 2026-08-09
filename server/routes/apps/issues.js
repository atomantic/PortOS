/**
 * Forge issue listing for a managed app's Issues tab.
 *
 *   GET /:id/issues → { appId, appName, forge, fullName, issues, reason, transient, remedy }
 *
 * Read-only: it shells out to `gh`/`glab` to LIST open issues and nothing more —
 * no claim markers, no labels written, no LLM call. Claiming one goes through the
 * existing `POST /api/cos/tasks/slashdo` (`command: 'next'`, `target: <number>`),
 * which is what keeps the button honest about the app's Work Tracker config.
 */

import { Router } from 'express';
import { listAppIssues } from '../../services/appIssues.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { loadApp } from './shared.js';

const router = Router();

// GET /api/apps/:id/issues - Every OPEN issue on the forge this app's git origin
// points at (github.* → gh, gitlab.* → glab). Unlike /work-items — which answers
// "what could /do:next claim?" and filters accordingly — this is the unfiltered
// tracker view the user reads before claiming.
router.get('/:id/issues', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const result = await listAppIssues(app);
  res.json({ appId: app.id, appName: app.name, ...result });
}));

export default router;
