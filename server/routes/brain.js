/**
 * Brain API Routes (barrel)
 *
 * Thin assembler over the per-domain sub-routers. Each sub-router owns one
 * brain concern; this file just mounts them under /api/brain. See routes/cos.js
 * for the same pattern.
 */

import { Router } from 'express';
import captureRoutes from './brainCapture.js';
import crudRoutes from './brainCrud.js';
import digestRoutes from './brainDigest.js';
import settingsRoutes from './brainSettings.js';
import linkRoutes from './brainLinks.js';
import graphRoutes from './brainGraph.js';
import syncRoutes from './brainSync.js';
import dailyLogRoutes from './brainDailyLog.js';
import songbookRoutes from './brainSongbook.js';
import youtubeRoutes from './brainYoutube.js';
import ideaLoomRoutes from './brainIdeaLoom.js';

const router = Router();

router.use(captureRoutes);
// Static IdeaLoom routes must mount before brainCrud's `/ideas/:id` route.
router.use(ideaLoomRoutes);
router.use(crudRoutes);
router.use(digestRoutes);
router.use(settingsRoutes);
router.use(linkRoutes);
router.use(graphRoutes);
router.use(syncRoutes);
router.use(dailyLogRoutes);
router.use('/songbook', songbookRoutes);
router.use('/youtube', youtubeRoutes);

export default router;
