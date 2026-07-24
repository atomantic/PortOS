/**
 * App → sprite reverse lookup (issue #2991).
 *
 *   GET /:id/sprite-bindings → { bindings: [{ recordId, name, kind,
 *                                             atlasDestPath, codeBindingPath }] }
 *
 * Lists the sprite records whose `publishBinding.appId` targets this app — the
 * app-side view of "PortOS publishes assets into this repo." Empty for an app
 * nothing is bound to. Display-only: it never gates a publish (publishing
 * resolves purely from the app's repoPath).
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { loadApp } from './shared.js';
import { listPublishBindingsForApp } from '../../services/sprites/publish.js';

const router = Router();

// GET /api/apps/:id/sprite-bindings - sprite records publishing into this app
router.get('/:id/sprite-bindings', loadApp, asyncHandler(async (req, res) => {
  const bindings = await listPublishBindingsForApp(req.params.id);
  res.json({ bindings });
}));

export default router;
