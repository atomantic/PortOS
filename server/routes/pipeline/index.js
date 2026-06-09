/**
 * Pipeline Routes
 *
 * Two resource scopes:
 *   /api/pipeline/series       — Series CRUD (the long-lived narrative bible)
 *   /api/pipeline/issues       — Issue/Episode CRUD + stage operations
 *
 *   GET    /series                              → Series[]
 *   POST   /series                              → Series
 *   GET    /series/:id                          → Series
 *   PATCH  /series/:id                          → Series
 *   DELETE /series/:id                          → { id }
 *   GET    /series/:id/issues                   → Issue[]
 *   POST   /series/:id/issues                   → Issue
 *   GET    /issues/:id                          → Issue
 *   PATCH  /issues/:id                          → Issue
 *   DELETE /issues/:id                          → { id }
 *   POST   /issues/:id/stages/:stageId/generate → { issue, stage, runId }
 *   POST   /issues/:id/stages/:stageId/visual   → { jobId, mode, prompt }
 *   POST   /issues/:id/auto-run-text            → { runId, alreadyRunning, sseUrl }
 *   GET    /issues/:id/auto-run-text/progress   → SSE (text/event-stream)
 *   POST   /issues/:id/auto-run-text/cancel     → { canceled }
 *
 * Assembled from domain sub-routers (mirrors the cos.js pattern). Mount
 * order preserves the original single-file registration order; the only
 * order-sensitive pairs live INSIDE one sub-router each (`/series/duplicates`
 * + `/series/merge*` before `/series/:id` in series.js, `/issues/recent`
 * before `/issues/:id` in issues.js).
 */

import { Router } from 'express';
import audioRoutes from './audio.js';
import seriesRoutes from './series.js';
import arcRoutes from './arcs.js';
import manuscriptRoutes from './manuscript.js';
import coverRoutes from './covers.js';
import issueRoutes from './issues.js';
import editorialRoutes from './editorial.js';

const router = Router();

router.use(audioRoutes);
router.use(seriesRoutes);
router.use(arcRoutes);
router.use(manuscriptRoutes);
router.use(coverRoutes);
router.use(issueRoutes);
router.use(editorialRoutes);

export default router;
