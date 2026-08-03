/**
 * Universe Builder Routes — /api/universe-builder
 *
 * Universe CRUD plus the AI-assisted workflows that operate on a universe:
 * expand/refine, image-based description + canon correction, reference-sheet
 * and canon-entry rendering, run history, style references, and canon
 * entry management. Each endpoint carries its own doc comment in its
 * sub-router — this header intentionally doesn't enumerate them (it drifted
 * stale when it did).
 *
 * Assembled from domain sub-routers (mirrors the routes/pipeline pattern).
 * Mount order is load-bearing: every sub-router that owns a single-segment
 * STATIC path (`/expand`, `/describe-from-images`, `/analyze-style-reference`,
 * `/refine-prompts`, `/reference-sheet-variants`, `/duplicates`, `/merge*`)
 * must be mounted BEFORE crud.js, whose `GET /:id` would otherwise swallow
 * it. `/styles` is the one static path that lives inside crud.js, declared
 * ahead of `/:id` there. Routers mounted after crud.js own only `/:id/...`
 * multi-segment paths, which no single-segment route can shadow.
 */

import { Router } from 'express';
import expandRoutes from './expand.js';
import visionRoutes from './vision.js';
import styleReferenceRoutes from './styleReferences.js';
import referenceSheetRoutes from './referenceSheets.js';
import mergeRoutes from './merge.js';
import crudRoutes from './crud.js';
import renderRoutes from './render.js';
import canonRoutes from './canon.js';

const router = Router();

router.use(expandRoutes);
router.use(visionRoutes);
router.use(styleReferenceRoutes);
router.use(referenceSheetRoutes);
router.use(mergeRoutes);
router.use(crudRoutes);
router.use(renderRoutes);
router.use(canonRoutes);

export default router;
