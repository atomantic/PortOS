import { Router, raw } from 'express';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { streamAttachment } from '../lib/streamAttachment.js';
import { validateRequest } from '../lib/validation.js';
import { getTarget, listTargets, detectHostCapabilities, unavailableReason, unavailableReasonLabel, IMAGE_TO_3D_TARGET_IDS, renderOptionSupportFor } from '../services/imageTo3d/targets.js';
import { getTargetAdapter } from '../services/imageTo3d/adapters.js';
import {
  listModels,
  getModel,
  createModel,
  startGeneration,
  deleteModel,
  getModelAsset,
  getModelFullMesh,
  getModelUsdz,
  saveModelUsdz,
  USDZ_MAX_BYTES,
} from '../services/imageTo3d/models.js';
import {
  RENDER_STEPS_MIN, RENDER_STEPS_MAX, RENDER_SEED_MAX, DETAIL_TIERS, ALPHA_MODES,
  SUBJECT_SCALE_MIN_EXCLUSIVE, SUBJECT_SCALE_MAX,
} from '../services/imageTo3d/renderOptions.js';
import { createInstallLogger } from '../lib/installLogger.js';
import { openSseStream } from '../lib/sseDownload.js';

const router = Router();

const galleryFilenameSchema = z.string().trim().min(1).max(256)
  .regex(/^[^/\\]+\.(png|jpe?g|webp)$/i, 'filename must be a gallery image basename');

// PER-RUN sampler knobs, shared by create and re-generate. Nothing persists
// between runs: absent steps → the pipeline default, absent seed → a fresh
// random roll for that run, absent keyBackground → no keying (the pipeline's own
// learned matte runs instead), absent subjectScale → the source's own framing.
const renderOptionsSchema = z.object({
  steps: z.number().int().min(RENDER_STEPS_MIN).max(RENDER_STEPS_MAX).optional(),
  seed: z.number().int().min(0).max(RENDER_SEED_MAX).optional(),
  keyBackground: z.boolean().optional(),
  // Abstract tier, not a lane's raw pipeline value — the target maps it (see
  // renderOptions.js). Enums come from there so the route can't accept a tier the
  // normalizer would silently discard.
  detail: z.enum([...DETAIL_TIERS]).optional(),
  alphaMode: z.enum([...ALPHA_MODES]).optional(),
  normalMap: z.boolean().optional(),
  // Open at zero, closed at one — `1` is the identity (no reframing) and the
  // default; bounds come from renderOptions.js so the route can't accept a value
  // the normalizer would silently discard.
  subjectScale: z.number()
    .gt(SUBJECT_SCALE_MIN_EXCLUSIVE)
    .max(SUBJECT_SCALE_MAX)
    .optional(),
});

const createModelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  filename: galleryFilenameSchema,
  target: z.enum([...IMAGE_TO_3D_TARGET_IDS]).optional(),
}).extend(renderOptionsSchema.shape);

// Target ids with an install currently running — a rapid double-click would
// otherwise race two clone/setup processes against the same install dir.
// isInstalled() can't gate the second click (the first install hasn't produced
// the venv yet). Mirrors imageGenSetup.js's flux2InstallInFlight, generalized
// per-target.
const installsInFlight = new Set();

/**
 * The selectable image→3D targets, each annotated with whether it can run on
 * this host (Apple Silicon / memory gating) and whether its local model is
 * installed — so the client can render a target selector with disabled /
 * needs-install / ready states. Read-only, no LLM/GPU work — safe to call on
 * load. Availability/installed-state/extra diagnostics resolve through each
 * target's adapter (`services/imageTo3d/adapters.js`) — adding a target needs no
 * new branch here.
 */
router.get('/targets', asyncHandler(async (_req, res) => {
  const capabilities = await detectHostCapabilities();
  const targets = await Promise.all(listTargets(capabilities).map(async (target) => {
    const adapter = getTargetAdapter(target.id);
    const installed = adapter ? adapter.isInstalled() : null;
    // An installed target can still be silently degraded (e.g. TRELLIS.2's Metal
    // texture bake — #2952); a target's adapter opts into reporting that via
    // `describeInstallState()`. Only probed once installed — there is nothing to
    // report before then.
    const state = installed && adapter?.describeInstallState ? await adapter.describeInstallState() : null;
    return { ...target, installed, ...state?.fields };
  }));
  res.json({ capabilities, targets });
}));

/**
 * SSE-driven target install/repair, shared by every registered target. The
 * client opens an EventSource and gets staged progress (`stage` → `log` →
 * `complete` / `error`) while the target's adapter installs. Gated on hardware
 * support and single-flighted per target; killed if the client navigates away.
 * Only fires the real install on this explicit user request — never from boot
 * (AGENTS.md no-cold-bootstrap policy). Mirrors imageGenSetup.js's `/flux2-install`.
 */
async function handleTargetInstall(targetId, req, res) {
  const { send, safeEnd } = openSseStream(res);

  const target = getTarget(targetId);
  const adapter = getTargetAdapter(targetId);
  if (!target || !adapter?.install) {
    send({ type: 'error', message: `Unknown or non-installable image-to-3D target: ${targetId}` });
    return safeEnd();
  }

  // `repair=1` re-runs setup over an existing install. That is the documented fix
  // for a degraded install (e.g. TRELLIS.2's Metal texture bake — #2952): without
  // it, "Repair install" would hit the already-installed short-circuit below and
  // do nothing.
  const repair = req.query.repair === '1';

  if (adapter.isInstalled() && !repair) {
    send({ type: 'stage', stage: 'verify', message: `${target.label} already installed.` });
    // "Installed" is not the same as "installed well" — surface any adapter
    // warning (e.g. a degraded TRELLIS.2 texture bake) instead of a bare
    // "nothing to do".
    const state = adapter.describeInstallState ? await adapter.describeInstallState() : null;
    (state?.warnings || []).forEach((message) => send({ type: 'log', stage: 'verify', message: `⚠️ ${message}` }));
    send({ type: 'complete', message: 'Already installed — nothing to do.' });
    return safeEnd();
  }

  // Refuse on unsupported hardware rather than clone a multi-GB install that can
  // never run.
  const capabilities = await detectHostCapabilities();
  // `unavailableReason` is what `isTargetAvailable` asks anyway — take the reason
  // directly so the refusal doesn't re-run the gate to name what blocked it.
  const blockedReason = unavailableReason(targetId, capabilities);
  if (blockedReason !== null) {
    send({
      type: 'error',
      // The label, not the raw kebab-case code — this string is read by a human
      // in the install log, and `requires-linux-host` doesn't tell them to use WSL2.
      message: `This host cannot run ${target.label} (${unavailableReasonLabel(blockedReason)}). Install skipped.`,
    });
    return safeEnd();
  }

  if (installsInFlight.has(targetId)) {
    send({ type: 'error', message: `A ${target.label} install is already running. Wait for it to finish or restart PortOS.` });
    return safeEnd();
  }
  // Claim the in-flight slot synchronously, before any await, so two
  // near-simultaneous requests for the same target can't both pass the check above.
  installsInFlight.add(targetId);

  // Server-console visibility for the multi-GB install (start / stages / outcome).
  const installLog = createInstallLogger({ installer: target.label, target: targetId });
  const emit = (event) => { installLog.onEvent(event); send(event); };
  installLog.start();

  // Disconnect bookkeeping wired BEFORE the env-resolution await below (the same
  // hazard `lib/sseDownload.js` documents): that await can do a settings read plus
  // a token-file read (e.g. TRELLIS.2's `resolveEnv`), and a client closing during
  // it would otherwise land with no listener — the handler would go on to spawn a
  // multi-GB clone with no kill path, leaving the in-flight slot pinned until it
  // finished on its own and blocking every later Install click.
  let currentKill = null;
  let aborted = false;
  // `adapter.install()` itself can run an async preflight (e.g. a toolchain
  // probe) BEFORE returning { promise, kill } — during that window `currentKill`
  // is still null, so a naive close handler would release the slot even though
  // the adapter may already be spawning its first child. Track that window
  // explicitly so the slot is held through it, and release exactly once via a
  // single guarded function — never eagerly in the close handler for a window
  // where nothing is killable yet AND an install may already be starting.
  let installStarting = false;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    installsInFlight.delete(targetId);
  };
  req.on('close', () => {
    aborted = true;
    installLog.cancel();
    // `close` also fires on normal completion; only a live handle means an
    // install was actually mid-flight.
    if (currentKill) {
      // A real install is tracked in installsInFlight. Ask the child to
      // terminate, but let the install promise's own `.finally()` (below)
      // release the slot once the kill actually lands — releasing it here,
      // before the child has exited, would let a second install for the same
      // target start while the first is still shutting down.
      currentKill();
    } else if (!installStarting) {
      // Nothing has spawned yet (still resolving env) — the code below will
      // see `aborted` and bail without ever registering a `.finally()`, so
      // release the slot here or it would leak forever.
      releaseSlot();
    }
    // Else: `adapter.install()`'s own preflight is in flight and `kill` isn't
    // available yet — do NOT release here. The code right after that await
    // (below) sees `aborted` and calls `kill()` + `releaseSlot()` itself once
    // it actually has something to kill.
    safeEnd();
  });

  // Each target declares its own credential/env needs via `resolveEnv` — omit it
  // for a target with nothing to resolve. Guarded because the SSE headers are
  // already flushed by this point — a throw here (e.g. an unparseable
  // settings.json) can't reach the error middleware as JSON, so it has to surface
  // as a terminal `error` frame or the client hangs on a half-open stream.
  let installEnv;
  try {
    installEnv = adapter.resolveEnv ? await adapter.resolveEnv() : undefined;
  } catch (err) {
    console.error(`❌ ${target.label} install could not resolve its environment: ${err.message}`);
    emit({ type: 'error', message: `Could not prepare the ${target.label} install environment: ${err.message}` });
    releaseSlot();
    return safeEnd();
  }
  // The client hung up during the await — don't start a multi-GB install nobody
  // is listening to.
  if (aborted) return safeEnd();

  installStarting = true;
  const { promise, kill } = await adapter.install({ onEvent: emit, env: installEnv });
  // The client may have hung up while the adapter ran its own async preflight
  // (e.g. a toolchain probe) — terminate whatever it just spawned rather than
  // let an orphaned install run unattended, and release the slot now that we
  // finally have something to kill (the close handler deliberately did not).
  if (aborted) {
    kill();
    releaseSlot();
    return;
  }
  currentKill = kill;
  promise
    .then(() => installLog.success())
    .catch((err) => {
      // A transient network drop that survived the in-install retries: partial
      // clones on disk are typically idempotent (resumable), so re-running Install
      // resumes rather than restarts.
      const hint = err?.transient
        ? ' This looks like a network hiccup — click Install again to resume (already-downloaded pieces are kept).'
        : '';
      emit({ type: 'error', message: `${err?.message || 'Install failed'}${hint}`, stage: err?.stage });
    })
    .finally(() => {
      currentKill = null;
      releaseSlot();
      safeEnd();
    });
}

router.get('/targets/:targetId/install', asyncHandler((req, res) => handleTargetInstall(req.params.targetId, req, res)));

// Compatibility alias for the pre-#3080 TRELLIS.2-specific install URL — existing
// client bookmarks/links keep working.
router.get('/trellis2/install', asyncHandler((req, res) => handleTargetInstall('trellis2', req, res)));

// ── Image-to-3D model records ─────────────────────────────────────────────
// Namespaced under /models so `/:id` never shadows the `/targets` and
// `/trellis2/install` routes above. These drive the /3d page: create a
// record from a gallery image (which kicks off the local render), poll the
// record for status, re-generate, delete, and download the exported GLB.

router.get('/models', asyncHandler(async (_req, res) => {
  res.json(await listModels());
}));

/**
 * Attach the target's render-option support to a model response.
 *
 * Projected at the response boundary, never stored: the detail view loads a RECORD
 * rather than the target list, and still has to know which per-run knobs this record's
 * target honors. Derived from the descriptor on every read, so it cannot go stale.
 *
 * Applied to EVERY response that returns a model, not just the GET. The client does
 * `setRecord(next)` with the POST body, so a create/re-render response that omitted the
 * field would blank it — flipping the disabled Quality control and its hint back on
 * until the next poll restored them.
 */
const withRenderSupport = (model) => {
  const supportsRenderOptions = renderOptionSupportFor(model.target);
  return supportsRenderOptions ? { ...model, supportsRenderOptions } : model;
};

router.post('/models', asyncHandler(async (req, res) => {
  const input = validateRequest(createModelSchema, req.body);
  const model = await createModel(input);
  res.status(202).json(withRenderSupport(model));
}));

router.get('/models/:id/asset', asyncHandler(async (req, res) => {
  const { path, filename } = await getModelAsset(req.params.id);
  streamAttachment(res, createReadStream(path), {
    filename,
    contentType: 'model/gltf-binary',
    failure: new ServerError('Mesh file not found', { status: 404, code: 'ASSET_MISSING' }),
    label: 'Image-to-3D asset',
  });
}));

// The decoder's pre-decimation mesh. Registered before `/models/:id` so the more
// specific path wins, and kept off `/asset` because it is a different artifact
// with a different failure mode (see getModelFullMesh) rather than a variant of
// the served GLB.
router.get('/models/:id/full-mesh', asyncHandler(async (req, res) => {
  const { path, filename } = await getModelFullMesh(req.params.id);
  streamAttachment(res, createReadStream(path), {
    filename,
    contentType: 'model/obj',
    failure: new ServerError('Mesh file not found', { status: 404, code: 'ASSET_MISSING' }),
    label: 'Image-to-3D asset',
  });
}));

// ── AR Quick Look (USDZ) ──────────────────────────────────────────────────
// The conversion runs in the VIEWER (three's USDZExporter over the scene it has
// already parsed and decoded), not on the server — PortOS ships no USD toolchain
// and would otherwise have to re-decode the GLB and its textures in Node to
// produce a file the browser already holds in memory. The server's job is to
// persist the result: a blob URL is not reliably openable by AR Quick Look and
// does not survive a reload, so the bytes are stored as a sibling artifact and
// re-served on every later visit instead of being re-exported.

/**
 * A raw USDZ body. `express.json()` is mounted app-wide but only claims
 * `application/json`, so these content types reach the route unparsed. The limit
 * is enforced here (a 413 from the parser) AND in `saveModelUsdz` — the parser
 * guards memory before the body is buffered, the service guards the invariant for
 * any other caller.
 */
const usdzBody = raw({
  type: ['model/vnd.usdz+zip', 'application/octet-stream'],
  limit: USDZ_MAX_BYTES,
});

router.post('/models/:id/usdz', usdzBody, asyncHandler(async (req, res) => {
  // Body-shape validation is byte-level (non-empty, under cap, zip magic), not a
  // Zod object schema — there is no JSON here to describe.
  const model = await saveModelUsdz(req.params.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  res.status(201).json(withRenderSupport(model));
}));

// Served `inline`, unlike the GLB/OBJ downloads: AR Quick Look will not engage on
// an attachment response, and it needs the exact `model/vnd.usdz+zip` type.
router.get('/models/:id/usdz', asyncHandler(async (req, res) => {
  const { path, filename } = await getModelUsdz(req.params.id);
  streamAttachment(res, createReadStream(path), {
    filename,
    contentType: 'model/vnd.usdz+zip',
    disposition: 'inline',
    failure: new ServerError('USDZ file not found', { status: 404, code: 'ASSET_MISSING' }),
    label: 'Image-to-3D AR export',
  });
}));

router.get('/models/:id', asyncHandler(async (req, res) => {
  const model = await getModel(req.params.id);
  if (!model) throw new ServerError('Image-to-3D model not found', { status: 404, code: 'NOT_FOUND' });
  res.json(withRenderSupport(model));
}));

router.post('/models/:id/generate', asyncHandler(async (req, res) => {
  // Re-render accepts the same per-run knobs as create; they apply to this run
  // only and are recorded on its run entry.
  const options = validateRequest(renderOptionsSchema, req.body ?? {});
  const model = await startGeneration(req.params.id, { options });
  res.status(202).json(withRenderSupport(model));
}));

router.delete('/models/:id', asyncHandler(async (req, res) => {
  res.json(await deleteModel(req.params.id));
}));

export default router;
