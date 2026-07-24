import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  listTargets,
  detectHostCapabilities,
  isTargetAvailable,
  unavailableReason,
} from '../services/imageTo3d/targets.js';
import { isTrellis2Installed, installTrellis2, trellis2Root } from '../services/imageTo3d/trellis2.js';
import { createInstallLogger } from '../lib/installLogger.js';
import { openSseStream } from '../lib/sseDownload.js';

const router = Router();

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
    .catch((err) => emit({ type: 'error', message: err?.message || 'Install failed', stage: err?.stage }))
    .finally(() => {
      trellis2InstallInFlight = null;
      safeEnd();
    });

  // Cancel the (multi-GB) install if the client navigates away mid-bootstrap.
  req.on('close', () => { installLog.cancel(); kill(); safeEnd(); });
}));

export default router;
