/**
 * Pipeline Routes (/api/pipeline): series and issue/episode resources plus stage operations,
 * assembled from domain sub-routers (each documents its own endpoints). Order-sensitive pairs
 * live INSIDE one sub-router each (`/series/duplicates` + `/series/merge*` before
 * `/series/:id` in series.js).
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
