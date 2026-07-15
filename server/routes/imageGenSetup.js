/**
 * Image Gen — local-mode setup routes (`/api/image-gen/setup/*`).
 *
 * Split out of `routes/imageGen.js` so the large generate/gallery/regen router
 * stays focused on rendering. Covers the python-interpreter probe + venv
 * bootstrap, the FLUX.2 venv install/status, the HuggingFace token store, and
 * the pip package installer. Mounted at `/setup` by the parent router.
 *
 * Handlers validate + wire SSE/HTTP; the setup-check cache and the pip
 * allowlist live in `services/imageGen/setup.js`.
 */

import { Router } from 'express';
import { z } from 'zod';
import { join } from 'node:path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import { getHfToken, getHfTokenInfo, HF_TOKEN_REGEX } from '../lib/hfToken.js';
import { getImageModels, isFlux2 } from '../lib/mediaModels.js';
import { createInstallLogger } from '../lib/installLogger.js';
import {
  detectPython, installPackages, createVenv, isAllowedPython,
  resolveFlux2Python, FLUX2_VENV_DEFAULT, installFlux2Venv, isFlux2VenvHealthy,
} from '../lib/pythonSetup.js';
import { PATHS } from '../lib/fileUtils.js';
import { openSseStream } from '../lib/sseDownload.js';
import { getSetupCheck, invalidateSetupCheck, REQUIRED_PIP_NAMES } from '../services/imageGen/setup.js';

const router = Router();

router.get('/python', asyncHandler(async (_req, res) => {
  const path = await detectPython();
  res.json({ path });
}));

// SSE-driven FLUX.2 venv bootstrap. Replaces the "drop to a shell and run
// INSTALL_FLUX2=1 bash scripts/setup-image-video.sh" friction with an in-app
// install: the client opens an EventSource, gets staged progress events
// (detect → venv → upgrade-pip → install → verify), and either finishes or
// surfaces a clear error. Runs the install logic in-process via
// installFlux2Venv() so we get structured `stage` events the UI can animate
// against, instead of having to parse bash output.
//
// In-flight singleton: a rapid double-click would otherwise race two pip
// processes against the same venv directory. resolveFlux2Python() can't
// gate the second click — the first install hasn't created the python yet.
let flux2InstallInFlight = null;

router.get('/flux2-install', asyncHandler(async (req, res) => {
  const { send, safeEnd } = openSseStream(res);

  // Skip only when the venv binary AND the import work — a half-broken venv
  // (binary present, packages missing from a killed mid-install) needs to
  // re-run the install, not be reported as ready.
  if (await isFlux2VenvHealthy()) {
    send({ type: 'stage', stage: 'verify', message: 'FLUX.2 venv already installed.' });
    send({ type: 'complete', message: 'Already installed — nothing to do.' });
    return safeEnd();
  }
  if (flux2InstallInFlight) {
    send({ type: 'error', message: 'Another FLUX.2 install is already running. Wait for it to finish or restart PortOS.' });
    return safeEnd();
  }

  // Server-console visibility for the multi-GB torch install (start / stage
  // milestones / outcome) — installFlux2Venv streams progress only to `send`.
  const installLog = createInstallLogger({ installer: 'FLUX.2 venv', target: FLUX2_VENV_DEFAULT });
  const emit = (ev) => { installLog.onEvent(ev); send(ev); };
  installLog.start();

  const { promise, kill } = installFlux2Venv(emit);
  flux2InstallInFlight = promise;
  promise
    // installFlux2Venv resolves { ok:false } on some pip failures without
    // emitting a terminal SSE event, so reconcile the outcome from the result
    // (a no-op if `onEvent` already logged a complete/error frame).
    .then((result) => {
      if (result?.ok) installLog.success(result?.pythonPath ? `ready: ${result.pythonPath}` : undefined);
      else installLog.failure(`failed at stage ${result?.stage || 'unknown'}`);
    })
    .catch((err) => emit({ type: 'error', message: err?.message || 'Unknown installer failure' }))
    .finally(() => {
      flux2InstallInFlight = null;
      safeEnd();
    });

  // Cancel the install if the client navigates away mid-bootstrap. A torch
  // install is a multi-GB download and would otherwise keep running invisibly.
  req.on('close', () => { installLog.cancel(); kill(); safeEnd(); });
}));

// Used by the FLUX.2 model picker: surface a banner when the gated repo's
// license hasn't been accepted (HF_TOKEN missing) and the runner is set up.
// `venvInstalled` reflects functional health (binary AND packages import) —
// a half-broken venv would otherwise hide the install banner forever.
router.get('/flux2-status', asyncHandler(async (req, res) => {
  const [token, healthy] = await Promise.all([getHfToken(), isFlux2VenvHealthy()]);
  const venvPython = resolveFlux2Python();
  // The 9B (bf16) and 4B variants ship as separately-gated repos with
  // distinct HF license URLs. Use the active model's `licenseUrl` when the
  // client supplies a `modelId`; fall back to the 4B URL for callers that
  // pre-date the multi-variant registry.
  const FLUX2_DEFAULT_LICENSE = 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B';
  let licenseUrl = FLUX2_DEFAULT_LICENSE;
  if (typeof req.query?.modelId === 'string' && req.query.modelId.length > 0) {
    const model = getImageModels().find((m) => m.id === req.query.modelId);
    if (isFlux2(model) && typeof model?.licenseUrl === 'string' && model.licenseUrl.length > 0) {
      licenseUrl = model.licenseUrl;
    }
  }
  res.json({
    hfTokenPresent: !!token,
    venvInstalled: healthy,
    venvPath: venvPython,
    expectedVenvPath: FLUX2_VENV_DEFAULT,
    licenseUrl,
  });
}));

// Generic HF-token presence check for legacy mflux runners that don't need
// the FLUX.2 venv. Any model entry with `requiresHfToken: true` in
// data/media-models.json drives the banner through this endpoint.
router.get('/hf-token-status', asyncHandler(async (_req, res) => {
  const { token, source } = await getHfTokenInfo();
  res.json({ hfTokenPresent: !!token, source });
}));

// Save the HF token from the inline form on the Image Gen page. settings.json
// is the canonical location (single-user app behind Tailscale — see CLAUDE.md).
// Same endpoint serves FLUX.2 and legacy mflux gated models — the token is
// global (HF_TOKEN env in spawn).
const hfTokenSchema = z.object({
  token: z.string().regex(HF_TOKEN_REGEX, 'Token must look like `hf_…`').max(200),
});
router.post('/hf-token', asyncHandler(async (req, res) => {
  const { token } = validateRequest(hfTokenSchema, req.body || {});
  await updateSettingsWith((settings) => ({
    ...settings,
    imageGen: { ...(settings.imageGen || {}), hfToken: token.trim() },
  }));
  res.json({ ok: true, hfTokenPresent: true, source: 'stored' });
}));

// Clear the stored HF token. Falls back to env / CLI tokens if present —
// callers should re-fetch /setup/hf-token-status to see the post-clear state.
router.delete('/hf-token', asyncHandler(async (_req, res) => {
  await updateSettingsWith((settings) => {
    const { hfToken: _drop, ...restImageGen } = settings.imageGen || {};
    return { ...settings, imageGen: restImageGen };
  });
  const { token, source } = await getHfTokenInfo();
  res.json({ ok: true, hfTokenPresent: !!token, source });
}));

const checkSchema = z.object({ pythonPath: z.string().min(1) });

router.get('/check', asyncHandler(async (req, res) => {
  const { pythonPath } = validateRequest(checkSchema, req.query);
  if (!isAllowedPython(pythonPath)) {
    throw new ServerError('pythonPath must be a python interpreter (basename python/python3/python3.NN)', { status: 400 });
  }
  res.json(await getSetupCheck(pythonPath));
}));

const venvSchema = z.object({
  basePython: z.string().min(1).optional(),
});

router.post('/create-venv', asyncHandler(async (req, res) => {
  const { basePython } = validateRequest(venvSchema, req.body || {});
  if (basePython && !isAllowedPython(basePython)) {
    throw new ServerError('basePython must be a python interpreter (basename python/python3/python3.NN)', { status: 400 });
  }
  const base = basePython || (await detectPython());
  if (!base) {
    throw new ServerError('No base Python 3 found to bootstrap a venv. Install Python 3.10+ first.', { status: 400 });
  }
  const target = join(PATHS.data, 'python', 'venv');
  const venvPython = await createVenv(base, target);
  // Bust the setup-check cache for both the base interpreter and the new
  // venv python — the venv inherits the base's mtime-key but its packages
  // differ, and a subsequent /setup/check would otherwise return the base's
  // pre-venv snapshot.
  invalidateSetupCheck(base);
  invalidateSetupCheck(venvPython);
  res.json({ pythonPath: venvPython, target });
}));

const installSchema = z.object({
  pythonPath: z.string().min(1),
  packages: z.array(z.string().min(1)).min(1).max(40),
});

// EventSource consumers re-run /setup/check on `complete` to refresh status.
router.get('/install', (req, res) => {
  const pythonPath = req.query.pythonPath;
  const packages = String(req.query.packages || '').split(',').filter(Boolean);
  const parsed = installSchema.safeParse({ pythonPath, packages });
  if (!parsed.success) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: parsed.error.message }));
  }
  if (!isAllowedPython(parsed.data.pythonPath)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'pythonPath must be a python interpreter' }));
  }
  const disallowed = parsed.data.packages.filter((p) => !REQUIRED_PIP_NAMES.has(p));
  if (disallowed.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Packages not in allowlist: ${disallowed.join(', ')}` }));
  }

  // `send` and `safeEnd` from openSseStream no-op once the response has ended
  // so a late pip-output line (or the promise.then below) doesn't trigger
  // ERR_STREAM_WRITE_AFTER_END or double-end the response.
  const { send, safeEnd } = openSseStream(res);
  // Server-console visibility for the (multi-GB) local pip install — the SSE
  // stream otherwise surfaces progress only in the browser.
  const installLog = createInstallLogger({ installer: 'Image Gen packages', target: parsed.data.pythonPath });
  const emit = (ev) => { installLog.onEvent(ev); send(ev); };
  installLog.start();
  const { promise, kill } = installPackages(parsed.data.pythonPath, parsed.data.packages, emit);
  promise.then(() => {
    // Drop the now-stale setup-check snapshot before the client re-runs the
    // probe on `complete` — without this it would read the pre-install
    // missing-packages list back from cache.
    invalidateSetupCheck(parsed.data.pythonPath);
    safeEnd();
  });

  // Client navigation away should kill pip — a torch upgrade can run for
  // 10+ minutes and would otherwise keep going invisibly.
  req.on('close', () => { installLog.cancel(); kill(); safeEnd(); });
});

export default router;
