/**
 * Docker containment (#12844) — the opt-in profile that runs untrusted
 * install/test steps in a throwaway Linux container.
 *
 *   GET  /api/docker-containment/status → engine verdict + pulled images (no Docker call while the feature is off)
 *   POST /api/docker-containment/pull   → pull one pinned Node image (explicit operator action; host control)
 *   POST /api/docker-containment/run    → run install|validate over a worktree (host control; a
 *                                          PORTOS_API_TOKEN agent session qualifies)
 *
 * A run is refused (409 CONTAINMENT_UNAVAILABLE) when the feature is off or no
 * local engine/image is ready — it never executes on the host instead.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { DOCKER_CONTAINMENT_FEATURE_ID, DOCKER_CONTAINMENT_SETTINGS_KEY } from '../lib/dockerContainment.js';
import { dockerContainmentPullSchema, dockerContainmentRunSchema } from '../lib/dockerContainmentValidation.js';
import { PATHS } from '../lib/paths.js';
import { CONTAINMENT_UNAVAILABLE, getDockerContainmentStatus, pullDockerContainmentImage, runContained } from '../services/dockerContainment.js';
import { isInstanceFeatureEnabled } from '../services/instanceFeatures.js';
import { getSettings } from '../services/settings.js';

const router = Router();

async function readGate() {
  const [enabled, settings] = await Promise.all([isInstanceFeatureEnabled(DOCKER_CONTAINMENT_FEATURE_ID), getSettings()]);
  return { enabled, settings: settings?.[DOCKER_CONTAINMENT_SETTINGS_KEY] ?? {} };
}

const featureOff = (res) => res.status(409).json({
  status: 'refused',
  code: CONTAINMENT_UNAVAILABLE,
  state: 'disabled',
  reason: 'Docker containment is off. Turn it on in Settings > Features first.',
  contained: false,
});

router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getDockerContainmentStatus(await readGate()));
}));

router.post('/pull', asyncHandler(async (req, res) => {
  const { major } = validateRequest(dockerContainmentPullSchema, req.body ?? {});
  const gate = await readGate();
  if (!gate.enabled) return featureOff(res);
  const result = await pullDockerContainmentImage({ major, settings: gate.settings });
  res.status(result.ok ? 200 : 409).json(result);
}));

router.post('/run', asyncHandler(async (req, res) => {
  const { worktree, phase, command, timeoutMinutes } = validateRequest(dockerContainmentRunSchema, req.body ?? {});
  const gate = await readGate();
  if (!gate.enabled) return featureOff(res);
  // A caller that hangs up cancels the run; the container is force-removed.
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const result = await runContained({
    worktree, phase, command, settings: gate.settings, dataDir: PATHS.data,
    timeoutMs: timeoutMinutes ? timeoutMinutes * 60_000 : undefined, signal: controller.signal,
  });
  res.status(result.status === 'refused' ? 409 : 200).json(result);
}));

export default router;
