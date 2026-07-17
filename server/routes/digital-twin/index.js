/**
 * Digital Twin API Routes — assembled from domain-focused sub-routers, all
 * mounted at the same `/api/digital-twin` base (mirrors the apps/pipeline
 * sub-router pattern). Splitting the former ~990-line single file into these
 * domains preserves the exact `/api/digital-twin` contract, the shared
 * `assertPersonaExists` guard, and the centralized error behavior (every handler
 * still throws `ServerError` to the middleware).
 *
 *   status     — GET / (status summary)
 *   documents  — document CRUD
 *   tests      — behavioral / values-alignment / adversarial / multi-turn suites + generate
 *   enrichment — enrichment questionnaire (categories, progress, question/answer, lists)
 *   export     — export formats + export
 *   avatarBio  — live-avatar bio (deterministic build + optional LLM polish)
 *   settings   — GET/PUT settings
 *   personas   — persona CRUD + active pointer (M34 P7)
 *   analysis   — validate, writing/style analysis, identity image, traits, confidence, gaps, assessment
 *   importData — external data import (sources, analyze, save)
 *   feedback   — behavioral feedback loop (M34 P3)
 *   taste      — taste questionnaire
 *   snapshots  — time capsule snapshots
 *   evidence   — observed taste/chronotype evidence (Phase 7, #2156)
 *
 * Route ordering is safe across sub-routers: each domain owns a unique path
 * prefix (`/documents`, `/tests`, `/personas`, `/taste`, `/snapshots`, …), so no
 * sub-router can shadow another's routes. The only order-sensitive pairs
 * (`/personas/active` before `/personas/:id`; `/taste/sections` before
 * `/taste/:section/...`) live entirely inside their own single files.
 */

import { Router } from 'express';
import statusRoutes from './status.js';
import documentRoutes from './documents.js';
import testRoutes from './tests.js';
import enrichmentRoutes from './enrichment.js';
import exportRoutes from './export.js';
import avatarBioRoutes from './avatar-bio.js';
import settingsRoutes from './settings.js';
import personaRoutes from './personas.js';
import analysisRoutes from './analysis.js';
import importRoutes from './import.js';
import feedbackRoutes from './feedback.js';
import tasteRoutes from './taste.js';
import snapshotRoutes from './snapshots.js';
import evidenceRoutes from './evidence.js';

const router = Router();

router.use(statusRoutes);
router.use(documentRoutes);
router.use(testRoutes);
router.use(enrichmentRoutes);
router.use(exportRoutes);
router.use(avatarBioRoutes);
router.use(settingsRoutes);
router.use(personaRoutes);
router.use(analysisRoutes);
router.use(importRoutes);
router.use(feedbackRoutes);
router.use(tasteRoutes);
router.use(snapshotRoutes);
router.use(evidenceRoutes);

export default router;
