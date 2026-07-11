/**
 * Apps Routes — assembled from domain-focused sub-routers, all mounted at the
 * same `/api/apps` base (mirrors the pipeline sub-router pattern). Splitting the
 * former ~1,380-line single file into these domains preserves the exact
 * `/api/apps` contract, the shared `loadApp` middleware, and the centralized
 * error behavior (every handler still throws `ServerError` to the middleware).
 *
 *   crud       — GET/POST/PUT/DELETE /, /:id, archive/unarchive, status enrichment
 *   lifecycle  — PM2 start/stop/restart, update, build, status, logs, refresh-config
 *   viteTls    — upgrade-tls, vite-host-check, fix-vite-hosts (config repair)
 *   xcode      — xcode-scripts/install
 *   icons      — icon serving + detection
 *   taskTypes  — per-app task-type overrides, work-tracker, layered-intelligence
 *   launch     — open-editor, open-claude, open-folder
 *   documents  — planning-doc read/list/commit
 *   agents     — recent CoS agent history
 *
 * Route ordering is safe across sub-routers: every param route is either the
 * single-segment `/:id` or a deeper `/:id/...`, and the static routes
 * (`/detect-icons`, `/bulk-task-type/:taskType`) differ from `/:id` by method or
 * segment count, so no sub-router can shadow another's routes. The only
 * order-sensitive pair (`/:id/task-types/all` before `/:id/task-types/:taskType`)
 * lives entirely inside `taskTypes.js`.
 */

import { Router } from 'express';
import crudRoutes from './crud.js';
import lifecycleRoutes from './lifecycle.js';
import viteTlsRoutes from './viteTls.js';
import xcodeRoutes from './xcode.js';
import iconRoutes from './icons.js';
import taskTypeRoutes from './taskTypes.js';
import launchRoutes from './launch.js';
import documentRoutes from './documents.js';
import agentRoutes from './agents.js';

const router = Router();

router.use(crudRoutes);
router.use(lifecycleRoutes);
router.use(viteTlsRoutes);
router.use(xcodeRoutes);
router.use(iconRoutes);
router.use(taskTypeRoutes);
router.use(launchRoutes);
router.use(documentRoutes);
router.use(agentRoutes);

export default router;
