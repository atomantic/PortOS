/** Expose video generation, runtime setup and gallery operations under a shared API prefix. */

import { checkHiggsfieldNewModels } from '../services/higgsfieldCatalogCheck.js';
import { Router } from 'express';
import os from 'os';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { VIDEO_BACKEND_DISCLOSURES } from '../lib/videoDisclosure.js';
import { getSettings } from '../services/settings.js';
import { isAllowedPython } from '../lib/pythonSetup.js';
import { getSetupCheck, invalidateSetupCheck } from '../services/imageGen/setup.js';
import { listVideoModels, defaultVideoModelId, BYOV_RUNTIME_INFO, warmByovLoraCapabilities, resolveRuntimeFingerprint, resolveFflfLtx2PixelBudget } from '../services/videoGen/local.js';
import { isVideoModeUsable } from '../services/videoGen/modes.js';
import { HOSTED_MEDIA_BACKENDS } from '../lib/generationModes.js';
import { detectSystemCapabilities, withHardwareCompatibility } from '../lib/systemCapabilities.js';
import { isDisplaySleepEnabled } from '../services/videoGen/displayPower.js';
import { statusQuerySchema } from '../lib/videoGenValidation.js';
import downloads from './videoGenDownloads.js';
import history from './videoGenHistory.js';
import upscale from './videoGenUpscale.js';
import render from './videoGenRender.js';

const router = Router();

const hardwareAwareVideoModels = async () => {
  // Warm BEFORE decorating: listVideoModels() stamps each entry's
  // `runtimeLoraCapable` from a sync accessor that reads an unprobed runtime as
  // "not capable", and shipping that default is a bug the client cannot recover
  // from — see warmByovLoraCapabilities in services/videoGen/runtimes.js.
  // Joined to the hardware probe this function already awaits for the same
  // reason; both cache for the process, so only the first call pays.
  const [capabilities] = await Promise.all([detectSystemCapabilities(), warmByovLoraCapabilities()]);
  return {
    capabilities,
    models: listVideoModels().map((model) => withHardwareCompatibility(
      model,
      capabilities,
      model.hardwareRequirements,
    )),
  };
};

// The model list plus the three numbers that decide which entry the picker
// auto-selects. Deliberately free of any python probe: /status answers from the
// 30s interpreter-health memo (a cold probe is ~2-4s) and the form used to wait
// on it, so `/model-context` serves the same fields off the registry, the cached
// hardware probe and the once-per-process LoRA-capability warm above (a bare
// MLX import, no model load, cached both ways). /status keeps returning them
// for its other readers — this is the single builder both routes share, so the
// two can't drift.
const videoStatusBackends = HOSTED_MEDIA_BACKENDS.filter(({ video, credentialId, alwaysUsable }) => video && (credentialId || alwaysUsable));

const videoModelContext = async (loadedSettings = null) => {
  const { capabilities, models } = await hardwareAwareVideoModels();
  const settings = loadedSettings || await getSettings();
  return {
    // Each entry carries its optional `disclosure` block (provenance, weights/
    // runtime licenses, pinned-snapshot download size) straight off the
    // registry — absent for custom models, which the UI renders as Unknown.
    models,
    defaultModel: defaultVideoModelId(capabilities, settings?.videoGen?.defaultModelId),
    // Total system memory in GB — the client uses this to auto-select the
    // highest-memory mode-compatible model that fits on this machine.
    // Rounded to nearest GB; sub-GB precision isn't useful for the
    // model-size comparison and reads more cleanly in the UI.
    systemMemoryGb: Math.round(os.totalmem() / 1024 ** 3),
    // Effective FFLF/ltx2 stage-2 pixel-frame budget (honors
    // FFLF_LTX2_PIXEL_BUDGET). The multi-keyframe picker mirrors the
    // back-solve so it can reject out-of-budget keyframe indices before
    // submit instead of letting the worker 400 mid-render.
    fflfLtx2PixelBudget: resolveFflfLtx2PixelBudget(),
    // The client needs the renderer's usability decision even for env-only keys.
    // Grok's shared settings toggle is already visible to it.
    ...Object.fromEntries(videoStatusBackends.map(({ id }) => [`${id}Enabled`, isVideoModeUsable(settings, id)])),
    // Server-owned execution + policy scope per render backend (#3674). The
    // client renders these strings verbatim so the wording can't drift between
    // the two surfaces.
    backendDisclosures: VIDEO_BACKEND_DISCLOSURES,
    // Authoritative list of bring-your-own-venv runtimes — lets the client
    // gate the install-banner probe without hardcoding the same Set.
    byovRuntimes: Object.keys(BYOV_RUNTIME_INFO),
    // Will a render on this install actually sleep the display? macOS-only, and
    // OFF unless the user opted in (settings.videoGen.displaySleep). Paired with each
    // model's `sleepsDisplayDuringRender`, this is what lets the UI warn BEFORE
    // the screen goes dark — a user who is not warned reads it as a crash and
    // wakes the display, re-introducing the exact GPU-watchdog contention the
    // sleep is there to avoid.
    displaySleepOnRender: isDisplaySleepEnabled(settings?.videoGen),
  };
};

// Required-package health of the legacy interpreter, read from the 30s memo
// Image Gen shares (services/imageGen/setup.js) so a half-installed Python
// can't masquerade as connected without every page open paying a ~2-4s
// import probe. Package installs and venv creation bust the memo; `?fresh=true`
// (the manual Refresh button) busts it too. Nothing the form needs to render
// lives behind this route: the probe-free fields come from /model-context.
router.get('/status', asyncHandler(async (req, res) => {
  const { fresh } = validateRequest(statusQuerySchema, req.query);
  const s = await getSettings();
  const py = s.imageGen?.local?.pythonPath || null;
  if (fresh === 'true' && py) invalidateSetupCheck(py);
  const { connected, reason, missing, pythonVersion } = await resolveLocalPythonHealth(py);
  res.json({
    connected,
    pythonPath: py,
    pythonVersion: pythonVersion || null,
    reason,
    missingPackages: missing,
    // `models` / `defaultModel` / `systemMemoryGb` / `fflfLtx2PixelBudget` —
    // kept here for the callers that already read them off /status. The Video
    // Gen page takes them from GET /model-context instead, so its Model picker
    // never waits on the python probe above.
    ...(await videoModelContext(s)),
    // Runtime fingerprint — host chip/os + resolved ltx/mlx/torch versions per
    // installed BYOV runtime — so the UI can show the exact numerical stack and
    // bug reports for garbled/"mosaic" output carry the version info that makes
    // them actionable (#1325). Best-effort: a venv that fails to probe reports
    // `{ error }` and never blocks the rest of the status payload. The resolver
    // is already non-throwing (each probe resolves to `{ error }`), but guard
    // with a catch as defense-in-depth so a runtime-block failure can never
    // reject the whole /status response.
    runtime: await resolveRuntimeFingerprint().catch(() => null),
  });
}));

async function resolveLocalPythonHealth(py) {
  if (!py) return { connected: false, reason: 'Local Python not configured', missing: [], pythonVersion: null };
  if (!isAllowedPython(py)) return { connected: false, reason: 'Saved pythonPath is not a python interpreter', missing: [], pythonVersion: null };
  try {
    const { missing, pythonVersion } = await getSetupCheck(py);
    if (missing.length === 0) return { connected: true, reason: null, missing, pythonVersion };
    return {
      connected: false,
      reason: `${missing.length} python package${missing.length === 1 ? '' : 's'} missing: ${missing.join(', ')}`,
      missing,
      pythonVersion,
    };
  } catch (err) {
    return { connected: false, reason: `Python probe failed: ${err.message || err}`, missing: [], pythonVersion: null };
  }
}

// Higgsfield video families the curated picker lacks, read from their public catalog.
router.get('/higgsfield-models/unsupported', asyncHandler(async (_req, res) => {
  res.json(await checkHiggsfieldNewModels());
}));

router.get('/models', asyncHandler(async (_req, res) => {
  const { models } = await hardwareAwareVideoModels();
  res.json(models);
}));

// Everything the Model picker needs to render AND auto-select, with no
// per-request python probe in the way. A sibling route rather than a wrapper
// around /models so the bare-array shape that route has always returned stays
// intact for its existing callers (and for an older client talking to a newer
// server).
router.get('/model-context', asyncHandler(async (_req, res) => {
  res.json(await videoModelContext());
}));

router.use(downloads);
router.use(render);
router.use(history);
router.use(upscale);

export { isAudioMime } from './videoGenRender.js';
export default router;
