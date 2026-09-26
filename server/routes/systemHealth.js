import { getSystemHealthSnapshot } from '../services/systemHealthSnapshot.js';
import { Router } from 'express';
import os from 'os';

import { getSelf } from '../services/instanceIdentity.js';

import { getCurrentVersion } from '../services/updateChecker.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

import { validateRequest, systemHealthWarningParamsSchema, systemHealthWarningDismissSchema } from '../lib/validation.js';
import { getSettingsWithStatus, updateSettingsWith } from '../services/settings.js';

import { isAuthEnabled } from '../services/auth.js';
import { getHttpsEnabledAtBoot } from '../lib/httpsState.js';
import { getActiveProcessing } from '../services/activeProcessing.js';

import { getBuildIdentity } from '../lib/buildIdentity.js';

async function assertHealthSettingsWritable() {
  const status = await getSettingsWithStatus().catch(() => ({ corrupt: true }));
  if (status?.corrupt !== false || !status.settings || typeof status.settings !== 'object' || Array.isArray(status.settings)) {
    throw new ServerError('System health settings are unavailable; repair settings before changing thresholds or warning dismissals.', { status: 503 });
  }
}

const assertDismissibleWarningType = (type) => {
  if (type === 'health-settings' || type === 'probe-unavailable') {
    throw new ServerError('This system health warning cannot be dismissed.', { status: 400 });
  }
};

// Every write below only ever touches settings.health — shallow-merging a
// patch into whatever the write queue's freshest snapshot already holds there.
const patchHealth = (current, patch) => ({ ...current, health: { ...(current.health || {}), ...patch } });

const router = Router();

router.get('/processing', asyncHandler(async (req, res) => {
  res.json(await getActiveProcessing());
}));

/**
 * GET /api/system/build — which git commit THIS server process is running (#4694).
 *
 * Deliberately its OWN route rather than a field on /health/details, which
 * looks auth-gated but is not private: `probePeer` in services/instances.js
 * fetches /health/details from every configured peer and persists the whole
 * JSON verbatim as `peer.lastHealth`. Anything added there therefore leaves
 * the machine and is written to disk on someone else's install — and a branch
 * name can carry an issue title. Nothing PortOS does automatically fetches this
 * path — `probePeer` reads /health/details, /api/apps and /api/instances/
 * sync-status only — so the stamp never leaves the machine on its own.
 *
 * That is the guarantee being made, and the limit of it: a peer holding the
 * legacy Basic password can still deliberately GET this path (a paired peer's
 * scoped token cannot — it is outside PEER_API_SURFACE, #8387). The point here
 * is that the stamp is not PUSHED into a payload that federates unprompted.
 * See the root AGENTS.md privacy rules and #4694 ("local-only diagnostic data
 * — must not join a sync payload"). `health.test.js` pins both halves.
 */
router.get('/build', asyncHandler(async (req, res) => {
  res.json(await getBuildIdentity());
}));

router.get('/health', asyncHandler(async (req, res) => {
  const [self, version, authRequired] = await Promise.all([
    getSelf().catch(() => null),
    getCurrentVersion(),
    // Whether the optional password gate is on, so a companion client knows to
    // prompt for a password without a second round-trip to /api/auth/status.
    // This endpoint stays public (PUBLIC_API_PATHS) so the client can read
    // identity before it holds any credential.
    isAuthEnabled()
  ]);
  const hostname = os.hostname();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version,
    hostname,
    instanceId: self?.instanceId ?? null,
    // Companion-app (PortDeck) instance-identity fields — pre-auth so a native
    // client can identify/label a PortOS instance across the tailnet and decide
    // whether to prompt for a password before it has credentials. Additive and
    // non-sensitive (name/hostname/instanceId are within the tailnet trust model).
    // See docs/COMPANION_APP_API.md.
    name: self?.name ?? hostname,
    authRequired,
    scheme: getHttpsEnabledAtBoot().value ? 'https' : 'http'
  });
}));

/**
 * GET /api/system/health/details - Comprehensive system health summary
 * Returns system metrics, app status, and CoS status for dashboard display
 */
router.get('/health/details', asyncHandler(async (req, res) => {
  const snapshot = await getSystemHealthSnapshot();
  snapshot.peerAuth.accepted = req.portosAuthContext?.method === 'peer';
  res.json(snapshot);
}));

/**
 * POST /api/system/health/warnings/:type/dismiss — mark the CURRENT instance
 * of a dashboard warning as resolved. Warnings are computed fresh on every
 * /health/details read rather than stored, so this records `{ message,
 * dismissedAt }` per warning type in settings.health.dismissedWarnings; the
 * next read hides it as long as the same (type, message) pair recurs, and
 * automatically un-dismisses (and prunes the record) once the condition
 * clears or changes. See the comment above loadHealthSettings.
 */
router.post('/health/warnings/:type/dismiss', asyncHandler(async (req, res) => {
  const { type } = validateRequest(systemHealthWarningParamsSchema, req.params);
  assertDismissibleWarningType(type);
  const { message } = validateRequest(systemHealthWarningDismissSchema, req.body || {});
  await assertHealthSettingsWritable();
  const next = await updateSettingsWith((current) => patchHealth(current, {
    dismissedWarnings: {
      ...(current.health?.dismissedWarnings || {}),
      [type]: { message, dismissedAt: new Date().toISOString() }
    }
  }));
  res.json(next.health.dismissedWarnings[type]);
}));

/**
 * DELETE /api/system/health/warnings/:type/dismiss — undo a dismissal so the
 * warning (if its underlying condition is still true) reappears immediately.
 */
router.delete('/health/warnings/:type/dismiss', asyncHandler(async (req, res) => {
  const { type } = validateRequest(systemHealthWarningParamsSchema, req.params);
  assertDismissibleWarningType(type);
  await assertHealthSettingsWritable();
  await updateSettingsWith((current) => {
    const dismissedWarnings = { ...(current.health?.dismissedWarnings || {}) };
    delete dismissedWarnings[type];
    return patchHealth(current, { dismissedWarnings });
  });
  res.json({ success: true });
}));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

router.put('/health/thresholds', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const incoming = {
    memoryWarn: Number(body.memoryWarn),
    memoryCritical: Number(body.memoryCritical),
    diskWarn: Number(body.diskWarn),
    diskCritical: Number(body.diskCritical)
  };
  for (const [k, v] of Object.entries(incoming)) {
    if (!Number.isFinite(v)) {
      throw new ServerError(`Invalid threshold value for ${k}`, { status: 400 });
    }
  }
  const next = {
    memoryWarn: clamp(Math.round(incoming.memoryWarn), 50, 99),
    memoryCritical: clamp(Math.round(incoming.memoryCritical), 50, 99),
    diskWarn: clamp(Math.round(incoming.diskWarn), 50, 99),
    diskCritical: clamp(Math.round(incoming.diskCritical), 50, 99)
  };
  if (next.memoryWarn >= next.memoryCritical) {
    throw new ServerError('memoryWarn must be less than memoryCritical', { status: 400 });
  }
  if (next.diskWarn >= next.diskCritical) {
    throw new ServerError('diskWarn must be less than diskCritical', { status: 400 });
  }

  // Merge the health thresholds against the freshest snapshot inside the write
  // queue so a concurrent settings write isn't clobbered by a stale base.
  await assertHealthSettingsWritable();
  await updateSettingsWith((current) => patchHealth(current, next));
  res.json(next);
}));

export default router;
