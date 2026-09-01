/**
 * Managed repository topology and upstream actions for every registered app.
 *
 *   GET  /:id/repository-sources           → versions and origin/upstream state
 *   POST /:id/repository-sources/sync-fork → fast-forward the primary fork
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import {
  getManagedAppRepositorySources,
  syncManagedAppFork,
} from '../../services/managedAppRepositories.js';
import { loadApp } from './shared.js';

const router = Router();

router.get('/:id/repository-sources', loadApp, asyncHandler(async (req, res) => {
  res.json(await getManagedAppRepositorySources(req.loadedApp));
}));

router.post('/:id/repository-sources/sync-fork', loadApp, asyncHandler(async (req, res) => {
  res.json(await syncManagedAppFork(req.loadedApp));
}));

export default router;
