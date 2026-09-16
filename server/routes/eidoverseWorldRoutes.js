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
  eidoverseControllerArmSchema,
  eidoverseControllerIdParamSchema,
  eidoverseControllerInstallSchema,
} from '../lib/eidoverseControllers.js';
import {
  getEidoverseFoundation,
  listEidoverseFoundations,
  packageEidoverseFoundationCandidate,
  promoteEidoverseFoundation,
  recordEidoverseFoundation,
} from '../services/eidoverseFoundationLedger.js';
import { listRegisteredContributionIds } from '../services/eidoverseResilienceContributions.js';
import { describeControllerDefinitions } from '../services/eidoverseControllerRegistry.js';
import {
  installEidoverseController,
  listEidoverseControllers,
  retireEidoverseController,
  setEidoverseControllerArmed,
  summarizeControllerInstall,
} from '../services/eidoverseControllerRuntime.js';
import { ensureInstanceId } from '../services/instanceIdentity.js';
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
// These bodies validate against schemas in `lib/eidoverseFoundations.js`
// rather than `lib/eidoverseValidation.js` (the rest of this router's home),
// because the module that owns the ownership contract owns its shapes — the
// same split `brainValidation.js` / `persistentMindCapabilities.js` already use.

// GET /api/eidoverse/world/foundations — every foundation this install has
// authored, with its ownership layer and last packaged promote candidate.
router.get('/foundations', asyncHandler(async (_req, res) => {
  res.json(await listEidoverseFoundations());
}));

// GET /api/eidoverse/world/contributions — the resilience-assay contributions
// a foundation may bind itself to. Its own path rather than a
// `/foundations/<something>` one, so no foundation id can ever shadow it.
router.get('/contributions', asyncHandler(async (_req, res) => {
  res.json({ contributions: await listRegisteredContributionIds() });
}));

// POST /api/eidoverse/world/foundations — record (or re-author) a local
// vernacular foundation. The ownership layer is not accepted from the caller:
// anything authored here is this install's own until it is promoted.
router.post('/foundations', asyncHandler(async (req, res) => {
  const input = validateRequest(eidoverseFoundationInputSchema, req.body || {});
  // `ensureInstanceId`, not `getInstanceId`: the id is stamped into durable
  // provenance and hashed into the promote fingerprint, so the `unknown`
  // sentinel a not-yet-initialized install returns must never be recorded.
  res.json({ success: true, foundation: await recordEidoverseFoundation(input, { originInstanceId: await ensureInstanceId() }) });
}));

// POST /api/eidoverse/world/foundations/:id/candidate — run the agent-free
// resilience assay and, on a pass, package the promote candidate. A refusal is
// a 200 carrying its reasons: "not ready to leave this install" is an expected
// verdict, not a request error.
router.post('/foundations/:id/candidate', asyncHandler(async (req, res) => {
  const { id } = validateRequest(eidoverseFoundationIdParamSchema, req.params || {});
  const result = await packageEidoverseFoundationCandidate(id);
  if (result.outcome === 'unknown-foundation') throw new ServerError('Foundation not found', { status: 404 });
  res.json(result);
}));

// POST /api/eidoverse/world/foundations/:id/promote — publish the foundation
// into this install's shared baseline population. Packages first and promotes
// the candidate it just produced, so promotion never rests on a stored verdict.
// Like the candidate endpoint, a refusal is a 200 carrying its reasons.
router.post('/foundations/:id/promote', asyncHandler(async (req, res) => {
  const { id } = validateRequest(eidoverseFoundationIdParamSchema, req.params || {});
  const result = await promoteEidoverseFoundation(id);
  if (result.outcome === 'unknown-foundation') throw new ServerError('Foundation not found', { status: 404 });
  res.json(result);
}));

// GET /api/eidoverse/world/foundations/:id — one foundation record, looked
// up by its plain (locally-authored) id. An inherited local copy of a peer's
// foundation lives under a separate `peer:<originInstanceId>:<foundationId>`
// ledger key (#7461) and is reachable only through the LIST endpoint above —
// deliberately: two records can legitimately share the same human-readable
// `id` (a local vernacular one and an inherited one), and this route has no
// way to disambiguate which one a bare id means.
router.get('/foundations/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(eidoverseFoundationIdParamSchema, req.params || {});
  const foundation = await getEidoverseFoundation(id);
  if (!foundation) throw new ServerError('Foundation not found', { status: 404 });
  res.json(foundation);
}));

// --- Controllers: the executable world-controller install surface (#7456,
// #7488) --------------------------------------------------------------------
// Everything here is the same projection the `eidoverse.controllers` mind-tool
// group in `services/cosToolRegistry.js` already exposes, reached this time
// from the UI rather than a mind: `describeControllerDefinitions()` and
// `summarizeControllerInstall()` stay the ONE projection either caller reads,
// so a UI/tool drift is impossible by construction rather than by discipline.

// GET /api/eidoverse/world/controllers — the shipped registry plus every
// installed controller on this install.
router.get('/controllers', asyncHandler(async (_req, res) => {
  const [available, listed] = await Promise.all([describeControllerDefinitions(), listEidoverseControllers()]);
  res.json({
    available,
    counts: listed.counts,
    installs: listed.installs.map((install) => summarizeControllerInstall(install)),
  });
}));

// POST /api/eidoverse/world/controllers — install (or re-install) a
// controller. `installedBy: 'user'` — this route is the human's own surface,
// never a mind's, which stays gated on `installEidoverseControllers`
// separately in the tool catalog. A refusal (unknown `controllerId`, a config
// its schema rejects) is a 200 carrying its reasons, the same shape the
// foundations promote gate already uses: it is the useful output, not a
// request error.
router.post('/controllers', asyncHandler(async (req, res) => {
  const input = validateRequest(eidoverseControllerInstallSchema, req.body || {});
  const result = await installEidoverseController(input, { installedBy: 'user' });
  res.json({ ...result, install: result.install ? summarizeControllerInstall(result.install, { includeState: true }) : null });
}));

// PATCH /api/eidoverse/world/controllers/:id — arm or disarm an installed
// controller without losing its accumulated state. The id travels in the URL;
// merging it with the body's `armed` lets this route validate against the
// exact same `eidoverseControllerArmSchema` the mind tool uses, rather than a
// second param/body split of the same two fields.
router.patch('/controllers/:id', asyncHandler(async (req, res) => {
  const { id, armed } = validateRequest(eidoverseControllerArmSchema, { ...(req.body || {}), id: req.params.id });
  const result = await setEidoverseControllerArmed(id, armed);
  if (result.outcome === 'unknown-install') throw new ServerError('Controller install not found', { status: 404 });
  res.json({ ...result, install: result.install ? summarizeControllerInstall(result.install) : null });
}));

// DELETE /api/eidoverse/world/controllers/:id — retire an installed
// controller, deleting it and its accumulated state.
router.delete('/controllers/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(eidoverseControllerIdParamSchema, req.params || {});
  const result = await retireEidoverseController(id);
  if (result.outcome === 'unknown-install') throw new ServerError('Controller install not found', { status: 404 });
  res.json({ ...result, install: result.install ? summarizeControllerInstall(result.install) : null });
}));

export default router;
