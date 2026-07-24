import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { asyncHandler, ServerError, sendErrorResponse } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  listTargets,
  detectHostCapabilities,
  isTargetAvailable,
  unavailableReason,
  IMAGE_TO_3D_TARGET_IDS,
} from '../services/imageTo3d/targets.js';
import { isTrellis2Installed, installTrellis2, trellis2Root } from '../services/imageTo3d/trellis2.js';
import {
  listModels,
  getModel,
  createModel,
  startGeneration,
  deleteModel,
  getModelAsset,
} from '../services/imageTo3d/models.js';
import { createInstallLogger } from '../lib/installLogger.js';
import { openSseStream } from '../lib/sseDownload.js';

const router = Router();

const galleryFilenameSchema = z.string().trim().min(1).max(256)
  .regex(/^[^/\\]+\.(png|jpe?g|webp)$/i, 'filename must be a gallery image basename');

const createModelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  filename: galleryFilenameSchema,
  target: z.enum([...IMAGE_TO_3D_TARGET_IDS]).optional(),
});

// In-flight singleton — a rapid double-click would otherwise race two clone/setup
// processes against the same install dir. isTrellis2Installed() can't gate the
// second click (the first install hasn't produced the venv yet). Mirrors
// imageGenSetup.js's flux2InstallInFlight.
let trellis2InstallInFlight = null;

// Per-target local-install probe. Targets with no local install concept (hosted
// APIs) report null. Single dispatch point so the route stays thin as targets grow.
const targetInstalled = (targetId) => {
  if (targetId === 'trellis2') return isTrellis2Installed();
  return null;
};

/**
 * The selectable image→3D targets, each annotated with whether it can run on
 * this host (Apple Silicon / memory gating) and whether its local model is
 * installed — so the client can render a target selector with disabled /
 * needs-install / ready states. Read-only, no LLM/GPU work — safe to call on
 * load. Later phases add the create/generate/asset endpoints.
 */
router.get('/targets', asyncHandler(async (_req, res) => {
  const capabilities = detectHostCapabilities();
  const targets = listTargets(capabilities).map((target) => ({
    ...target,
    installed: targetInstalled(target.id),
  }));
  res.json({ capabilities, targets });
}));

/**
 * SSE-driven TRELLIS.2 local install. The client opens an EventSource and gets
 * staged progress (`stage` → `log` → `complete` / `error`) while the ~15 GB clone
 * + `setup.sh` runs. Gated on hardware support (Apple Silicon + memory) and
 * single-flighted; killed if the client navigates away. Only fires the real
 * install on this explicit user request — never from boot (CLAUDE.md no-cold-
 * bootstrap policy). Mirrors imageGenSetup.js's `/flux2-install`.
 */
router.get('/trellis2/install', asyncHandler(async (req, res) => {
  const { send, safeEnd } = openSseStream(res);

  if (isTrellis2Installed()) {
    send({ type: 'stage', stage: 'verify', message: 'TRELLIS.2 already installed.' });
    send({ type: 'complete', message: 'Already installed — nothing to do.' });
    return safeEnd();
  }

  // Refuse on unsupported hardware rather than clone 15 GB that can never run.
  const capabilities = detectHostCapabilities();
  if (!isTargetAvailable('trellis2', capabilities)) {
    send({
      type: 'error',
      message: `This host cannot run TRELLIS.2 (${unavailableReason('trellis2', capabilities)}). Install skipped.`,
    });
    return safeEnd();
  }

  if (trellis2InstallInFlight) {
    send({ type: 'error', message: 'A TRELLIS.2 install is already running. Wait for it to finish or restart PortOS.' });
    return safeEnd();
  }

  // Server-console visibility for the multi-GB install (start / stages / outcome).
  const installLog = createInstallLogger({ installer: 'TRELLIS.2', target: trellis2Root() });
  const emit = (event) => { installLog.onEvent(event); send(event); };
  installLog.start();

  const { promise, kill } = installTrellis2({ onEvent: emit });
  trellis2InstallInFlight = promise;
  promise
    .then(() => installLog.success())
    .catch((err) => {
      // A transient network drop that survived the in-install retries: the partial
      // clones on disk are idempotent (setup.sh's `if [ ! -d ]` guards + git's
      // failed-clone cleanup), so re-running Install resumes rather than restarts.
      const hint = err?.transient
        ? ' This looks like a network hiccup — click Install again to resume (already-downloaded pieces are kept).'
        : '';
      emit({ type: 'error', message: `${err?.message || 'Install failed'}${hint}`, stage: err?.stage });
    })
    .finally(() => {
      trellis2InstallInFlight = null;
      safeEnd();
    });

  // Cancel the (multi-GB) install if the client navigates away mid-bootstrap.
  req.on('close', () => { installLog.cancel(); kill(); safeEnd(); });
}));

// ── Image-to-3D model records ─────────────────────────────────────────────
// Namespaced under /models so `/:id` never shadows the `/targets` and
// `/trellis2/install` routes above. These drive the /media/3d page: create a
// record from a gallery image (which kicks off the local render), poll the
// record for status, re-generate, delete, and download the exported GLB.

router.get('/models', asyncHandler(async (_req, res) => {
  res.json(await listModels());
}));

router.post('/models', asyncHandler(async (req, res) => {
  const input = validateRequest(createModelSchema, req.body);
  const model = await createModel(input);
  res.status(202).json(model);
}));

router.get('/models/:id/asset', asyncHandler(async (req, res) => {
  const { path, filename } = await getModelAsset(req.params.id);
  res.set('Content-Type', 'model/gltf-binary');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  // The 'error' event fires outside the asyncHandler promise chain, so a throw
  // here would crash the process — route it through sendErrorResponse (the shared
  // envelope + headers-sent guard) instead. A file removed between the readiness
  // check and the stream just 404s the download.
  const stream = createReadStream(path);
  stream.on('error', (err) => {
    console.warn(`⚠️ Image-to-3D asset stream error: ${err.code || err.message}`);
    // Pre-stream (common: file removed after the readiness check) → shared 404
    // envelope. Mid-stream (headers already flushed) → tear the socket down, since
    // sendErrorResponse no-ops once headers are sent.
    if (res.headersSent) res.destroy(err);
    else sendErrorResponse(res, new ServerError('Mesh file not found', { status: 404, code: 'ASSET_MISSING' }));
  });
  stream.pipe(res);
}));

router.get('/models/:id', asyncHandler(async (req, res) => {
  const model = await getModel(req.params.id);
  if (!model) throw new ServerError('Image-to-3D model not found', { status: 404, code: 'NOT_FOUND' });
  res.json(model);
}));

router.post('/models/:id/generate', asyncHandler(async (req, res) => {
  const model = await startGeneration(req.params.id);
  res.status(202).json(model);
}));

router.delete('/models/:id', asyncHandler(async (req, res) => {
  res.json(await deleteModel(req.params.id));
}));

export default router;
