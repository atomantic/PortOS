/**
 * PortOS-owned Eidoverse world controls.
 *
 * The hosted Eidoverse client remains the renderer. These routes own the
 * install-local identity, projection recipe, deterministic projection, and
 * the narrow set of world operations that PortOS is allowed to submit.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  eidoverseWorldAugmentSchema,
  eidoverseWorldConfigPatchSchema,
  eidoverseWorldSaySchema,
  validateRequest,
} from '../lib/validation.js';
import { eidoverseFoundationIdParamSchema, eidoverseFoundationInputSchema } from '../lib/eidoverseFoundations.js';
import {
  getEidoverseFoundation,
  listEidoverseFoundations,
  packageEidoverseFoundationCandidate,
  recordEidoverseFoundation,
} from '../services/eidoverseFoundationLedger.js';
import { getInstanceId } from '../services/instanceIdentity.js';
import {
  augmentEidoverseWorld,
  ensureEidoverseWorldPresence,
  getEidoverseWorldProjectionStatus,
  getEidoverseWorldStatus,
  projectEidoverseWorld,
  sayInEidoverseWorld,
  updateEidoverseWorldConfig,
} from '../services/eidoverseWorld.js';

const router = Router();

// GET /api/eidoverse/world/status — install-local identity, recipe, and
// runtime/presence state for the hosted world page.
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getEidoverseWorldStatus());
}));

// GET /api/eidoverse/world/projection/status — lightweight persisted
// reconciliation progress for the in-flight projection poller. This avoids
// runtime, app-registry, filesystem, and PM2 probes on every progress tick.
router.get('/projection/status', asyncHandler(async (_req, res) => {
  res.json(await getEidoverseWorldProjectionStatus());
}));

// PUT /api/eidoverse/world/config — persist the human/CoS identity and
// deterministic PortOS projection recipe for this install.
router.put('/config', asyncHandler(async (req, res) => {
  const patch = validateRequest(eidoverseWorldConfigPatchSchema, req.body || {});
  res.json({ success: true, ...(await updateEidoverseWorldConfig(patch)) });
}));

// POST /api/eidoverse/world/presence — establish the persistent CoS agent
// presence without requiring a browser tab to remain open.
router.post('/presence', asyncHandler(async (_req, res) => {
  res.json(await ensureEidoverseWorldPresence());
}));

// POST /api/eidoverse/world/project — refresh the world from live PortOS
// resources using the saved recipe. This is deterministic and makes no AI
// provider call.
router.post('/project', asyncHandler(async (_req, res) => {
  res.json(await projectEidoverseWorld());
}));

// POST /api/eidoverse/world/augment — apply bounded, allowlisted world verbs
// for manual or CoS-authored augmentation.
router.post('/augment', asyncHandler(async (req, res) => {
  const { operations } = validateRequest(eidoverseWorldAugmentSchema, req.body || {});
  res.json(await augmentEidoverseWorld(operations));
}));

// POST /api/eidoverse/world/say — persist a PortOS/CoS message in the world
// chat through the same authoritative world protocol.
router.post('/say', asyncHandler(async (req, res) => {
  const { text } = validateRequest(eidoverseWorldSaySchema, req.body || {});
  res.json(await sayInEidoverseWorld(text));
}));

// --- Foundations: the local-vs-baseline ownership ledger (#7455) ---------

// GET /api/eidoverse/world/foundations — every foundation this install has
// authored, with its ownership layer and last packaged promote candidate.
router.get('/foundations', asyncHandler(async (_req, res) => {
  res.json(await listEidoverseFoundations());
}));

// POST /api/eidoverse/world/foundations — record (or re-author) a local
// vernacular foundation. The ownership layer is not accepted from the caller:
// anything authored here is this install's own until it is promoted.
router.post('/foundations', asyncHandler(async (req, res) => {
  const input = validateRequest(eidoverseFoundationInputSchema, req.body || {});
  res.json({ success: true, foundation: await recordEidoverseFoundation(input, { originInstanceId: await getInstanceId() }) });
}));

// POST /api/eidoverse/world/foundations/:id/candidate — run the agent-free
// resilience assay and, on a pass, package the promote candidate. A refusal is
// a 200 carrying its reasons: "not ready to leave this install" is an expected
// verdict, not a request error.
router.post('/foundations/:id/candidate', asyncHandler(async (req, res) => {
  const { id } = validateRequest(eidoverseFoundationIdParamSchema, req.params || {});
  const result = await packageEidoverseFoundationCandidate(id);
  if (result.outcome === 'unknown-foundation') throw new ServerError('Foundation not found', { status: 404 });
  res.json({ success: result.outcome === 'packaged', ...result });
}));

// GET /api/eidoverse/world/foundations/:id — one foundation record.
router.get('/foundations/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(eidoverseFoundationIdParamSchema, req.params || {});
  const foundation = await getEidoverseFoundation(id);
  if (!foundation) throw new ServerError('Foundation not found', { status: 404 });
  res.json(foundation);
}));

export default router;
