/**
 * Meatspace API Routes (barrel)
 *
 * Thin assembler over the per-domain sub-routers. Each sub-router owns one
 * meatspace concern and imports only the services it needs; this file just
 * mounts them under /api/meatspace. See routes/cos.js for the same pattern.
 */

import { Router } from 'express';
import coreRoutes from './meatspaceCoreRoutes.js';
import alcoholRoutes from './meatspaceAlcoholRoutes.js';
import nicotineRoutes from './meatspaceNicotineRoutes.js';
import healthRoutes from './meatspaceHealthRoutes.js';
import postRoutes from './meatspacePostRoutes.js';
import calendarRoutes from './meatspaceCalendarRoutes.js';
import exportRoutes from './meatspaceExportRoutes.js';

const router = Router();

router.use(coreRoutes);
// Literal mounts keep both factory-backed route families visible to the API catalog.
router.use('/alcohol', alcoholRoutes);
router.use('/nicotine', nicotineRoutes);
router.use(healthRoutes);
router.use(postRoutes);
router.use(calendarRoutes);
router.use(exportRoutes);

export default router;
