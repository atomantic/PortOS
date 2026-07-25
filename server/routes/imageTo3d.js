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
import {
  isTrellis2Installed,
  installTrellis2,
  trellis2Root,
  probeTrellis2TextureBake,
  probeMetalToolchain,
} from '../services/imageTo3d/trellis2.js';
import {
  listModels,
  getModel,
  createModel,
  startGeneration,
  deleteModel,
  getModelAsset,
} from '../services/imageTo3d/models.js';
import { createInstallLogger } from '../lib/installLogger.js';
import { hfChildEnv } from '../lib/hfToken.js';
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
  // An installed TRELLIS.2 can still be silently degraded: `setup.sh` swallows a
  // failed Metal-backend build and exits 0, after which every render bakes a
  // scrambled surface. Surface that here so the target card can warn instead of
  // reporting a flat "Ready" (#2952). Skipped when it isn't installed — there is
  // nothing to probe, and the venv Python doesn't exist yet.
  const trellis2 = targets.find((t) => t.id === 'trellis2');
  if (trellis2?.installed) {
    const bake = await probeTrellis2TextureBake();
    // A degraded bake has two very different remedies, and the card must not offer
    // the wrong one: when the Metal Toolchain is merely missing, Repair install
    // fetches it and rebuilds (#3041); when only the Command Line Tools are active
    // there is nothing PortOS can run, and the user has to install Xcode first.
    // Only probe the toolchain when degraded — a healthy install needs no remedy.
    const toolchain = bake.quality === 'fallback' ? await probeMetalToolchain() : null;
    trellis2.textureBake = toolchain?.blocker
      ? { ...bake, repairable: false, blocker: toolchain.blocker, help: toolchain.hint }
      : { ...bake, ...(bake.quality === 'fallback' ? { repairable: true } : {}) };
  }
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

  // `repair=1` re-runs `setup.sh` over an existing install. That is the documented
  // fix for a degraded Metal texture bake: the clone step self-skips (the repo is
  // present) and setup.sh's pip installs re-attempt the Metal packages that failed
  // to compile the first time, while its `if [ ! -d ]` guards keep the ~15 GB of
  // already-downloaded weights. Without this the "Repair install" button would hit
  // the already-installed short-circuit below and do nothing (#2952).
  const repair = req.query.repair === '1';

  if (isTrellis2Installed() && !repair) {
    send({ type: 'stage', stage: 'verify', message: 'TRELLIS.2 already installed.' });
    // "Installed" is not the same as "installed well" — tell the user when this one
    // needs repairing rather than a bare "nothing to do".
    const bake = await probeTrellis2TextureBake();
    if (bake.quality === 'fallback') {
      send({ type: 'log', stage: 'verify', message: `⚠️ ${bake.help}` });
    }
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

  // Resolve the Metal Toolchain situation before spawning anything. `setup.sh`
  // compiles its texture-baking backends from `.metal` sources but swallows each
  // failure and still exits 0, so a host missing the toolchain would otherwise
  // finish "successfully" and render scrambled surfaces forever (#2952). When it's
  // missing but fetchable, the install downloads it as a leading optional step
  // (#3041); when only the Command Line Tools are active nothing we can run fixes
  // it, so warn and install anyway — geometry is unaffected and the `verify` step
  // reports the degraded bake.
  const toolchain = await probeMetalToolchain();
  if (toolchain.blocker) emit({ type: 'log', stage: 'preflight', message: `⚠️ ${toolchain.hint}` });
  const installMetalToolchain = toolchain.available === false && toolchain.installable === true;
  if (installMetalToolchain) {
    emit({ type: 'log', stage: 'preflight', message: `ℹ️ ${toolchain.hint}` });
  }

  // Disconnect bookkeeping wired BEFORE the token-resolution await below (the
  // same hazard `lib/sseDownload.js` documents): that await does a settings read
  // plus a token-file read, and a client closing during it would otherwise land
  // with no listener — the handler would go on to spawn a ~15 GB clone with no
  // kill path, leaving `trellis2InstallInFlight` pinned until it finished on its
  // own and blocking every later Install click.
  let currentKill = null;
  let aborted = false;
  req.on('close', () => {
    aborted = true;
    installLog.cancel();
    // `close` also fires on normal completion; only a live handle means an
    // install was actually mid-flight.
    if (currentKill) currentKill();
    safeEnd();
  });

  // Carry the stored HF token into the install too: setup.sh doesn't pull gated
  // weights today, but a future prefetch step would, and one env source beats two.
  // Guarded because the SSE headers are already flushed by this point — a throw
  // here (e.g. an unparseable settings.json) can't reach the error middleware as
  // JSON, so it has to surface as a terminal `error` frame or the client hangs on
  // a half-open stream.
  let installEnv;
  try {
    installEnv = await hfChildEnv();
  } catch (err) {
    console.error(`❌ TRELLIS.2 install could not resolve the Hugging Face token env: ${err.message}`);
    emit({ type: 'error', message: `Could not read settings to resolve the Hugging Face token: ${err.message}` });
    return safeEnd();
  }
  // The client hung up during the await — don't start a multi-GB install nobody
  // is listening to.
  if (aborted) return safeEnd();

  const { promise, kill } = installTrellis2({
    onEvent: emit,
    env: installEnv,
    installMetalToolchain,
  });
  currentKill = kill;
  trellis2InstallInFlight = promise;
  promise
    // `installTrellis2` emits its own post-install `verify` frame (Metal bake
    // present or degraded) before the terminal `complete` — see #2952.
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
      currentKill = null;
      trellis2InstallInFlight = null;
      safeEnd();
    });
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
    if (res.headersSent) {
      res.destroy(err);
    } else {
      // Drop the GLB download headers set above so the JSON error body isn't
      // offered to the browser as a "<name>.glb" attachment.
      res.removeHeader('Content-Disposition');
      sendErrorResponse(res, new ServerError('Mesh file not found', { status: 404, code: 'ASSET_MISSING' }));
    }
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
