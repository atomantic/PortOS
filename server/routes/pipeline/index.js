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
 *   POST   /series/:id/autopilot/start          → { runId, alreadyRunning, mode, sseUrl }
 *   GET    /series/:id/autopilot/progress       → SSE (text/event-stream)
 *   POST   /series/:id/autopilot/cancel         → { canceled }
 *   GET    /series/:id/autopilot/status         → { autopilot, active }
 *   GET    /issues/:id/canon-readiness          → { referenced, none, thin, ready }
 *   GET    /series/:id/canon-readiness          → { ready, issues, blockingIssues, undescribed }
 *   GET    /series/:id/reverse-outline               → { plotlines, scenes, stale, status }
 *   POST   /series/:id/reverse-outline/generate      → { runId, alreadyRunning, sseUrl }
 *   GET    /series/:id/reverse-outline/generate/progress → SSE (text/event-stream)
 *   POST   /series/:id/reverse-outline/generate/cancel   → { canceled }
 *   GET    /series/:id/continuity-bible              → { facts, stale, status }
 *   POST   /series/:id/continuity-bible/generate     → { runId, alreadyRunning, sseUrl }
 *   GET    /series/:id/continuity-bible/generate/progress → SSE (text/event-stream)
 *   POST   /series/:id/continuity-bible/generate/cancel   → { canceled }
 *   GET    /issues/:id/pov-rewrites                   → { cast, rewrites, hasContent }
 *   POST   /issues/:id/pov-rewrites                   → { status, rewrite }
 *   DELETE /issues/:id/pov-rewrites/:rewriteId        → { removed }
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
import reverseOutlineRoutes from './reverseOutline.js';
import continuityBibleRoutes from './continuityBible.js';
import perspectiveRewriteRoutes from './perspectiveRewrite.js';
import autopilotRoutes from './autopilot.js';
import canonRoutes from './canon.js';
import proseExportRoutes from './proseExport.js';

const router = Router();

router.use(audioRoutes);
router.use(seriesRoutes);
router.use(arcRoutes);
router.use(manuscriptRoutes);
router.use(coverRoutes);
router.use(issueRoutes);
router.use(editorialRoutes);
router.use(reverseOutlineRoutes);
router.use(continuityBibleRoutes);
router.use(perspectiveRewriteRoutes);
router.use(autopilotRoutes);
router.use(canonRoutes);
router.use(proseExportRoutes);

export default router;
