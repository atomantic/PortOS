import { Router } from 'express';
import os from 'os';
import { statfs } from 'fs/promises';
import { listProcesses } from '../services/pm2.js';
import { getAppStatusSummary, annotateExpectedExit } from '../services/appProcessStatus.js';
import * as cos from '../services/cos.js';
import { getSelf } from '../services/instanceIdentity.js';
import { checkHealth } from '../lib/db.js';
import { getCurrentVersion } from '../services/updateChecker.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { formatBytes, formatDuration } from '../lib/fileUtils.js';
import { parseFilesystemStats } from '../lib/fileCore.js';
import { validateRequest, systemHealthWarningParamsSchema, systemHealthWarningDismissSchema } from '../lib/validation.js';
import { getSettingsWithStatus, updateSettingsWith } from '../services/settings.js';
import { checkGhHealth } from '../services/github.js';
import { isAuthEnabled } from '../services/auth.js';
import { getHttpsEnabledAtBoot } from '../lib/httpsState.js';
import { getActiveProcessing } from '../services/activeProcessing.js';
import { getMediaCapacity } from '../services/mediaCapacity.js';
import { runningAgentsByTaskId, unclaimedTaskIds } from '../lib/cosSpawnWindow.js';
import { getBuildIdentity } from '../lib/buildIdentity.js';
import { PORTOS_SCHEMA_VERSIONS } from '../lib/schemaVersions.js';

// Disk capacity remains actionable. Memory thresholds are retained on the wire
// for older clients, but no longer generate warnings or degrade health.
const DEFAULT_THRESHOLDS = {
  memoryWarn: 85,
  memoryCritical: 95,
  diskWarn: 90,
  diskCritical: 98
};

// When a stale dismissal cannot be removed, remember the exact record that
// needs pruning. A matching recurrence remains visible until a later health
// read successfully removes that same persisted value.
const pendingDismissalPrunes = new Map();
const sameDismissal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Dashboard warnings are recomputed fresh on every read (nothing about them is
// persisted), so "dismiss" can't delete a row — it has to remember, per warning
// TYPE, the exact message that was dismissed. A later read matching that same
// (type, message) pair stays suppressed; a DIFFERENT message for the same type
// (severity escalated, a different process started crash-looping) is a new
// occurrence and is shown again automatically. Keyed by type rather than a
// generated id because each health check emits at most one warning per type.
//
// Thresholds and dismissals both live under settings.health, so one read
// covers both — GET /health/details used to call getSettings() twice (once
// per concern), paying for two deep-clones of the settings cache on every
// dashboard poll.
async function loadHealthSettings() {
  const status = await getSettingsWithStatus().catch(() => {
    console.error('❌ Failed to read system health settings; default thresholds will be used');
    return { corrupt: true, settings: {} };
  });
  const settingsAvailable = status?.corrupt === false
    && status.settings
    && typeof status.settings === 'object'
    && !Array.isArray(status.settings);
  const h = settingsAvailable ? (status.settings.health || {}) : {};
  const dismissedWarnings = h.dismissedWarnings;
  return {
    thresholdsAvailable: Boolean(settingsAvailable),
    thresholds: {
      memoryWarn: Number(h.memoryWarn) || DEFAULT_THRESHOLDS.memoryWarn,
      memoryCritical: Number(h.memoryCritical) || DEFAULT_THRESHOLDS.memoryCritical,
      diskWarn: Number(h.diskWarn) || DEFAULT_THRESHOLDS.diskWarn,
      diskCritical: Number(h.diskCritical) || DEFAULT_THRESHOLDS.diskCritical
    },
    dismissedWarnings: dismissedWarnings && typeof dismissedWarnings === 'object' && !Array.isArray(dismissedWarnings)
      ? dismissedWarnings
      : {}
  };
}

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
 * That is the guarantee being made, and the limit of it: the generic
 * `queryPeer` proxy (routes/instances.js, predates this) lets an authenticated
 * peer deliberately GET any /api/* path, as it can for every other endpoint on
 * this server. The point here is that the stamp is not PUSHED into a payload
 * that federates unprompted.
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
  const startTime = Date.now();
  const failedProbe = Symbol('failed health probe');

  // Gather data in parallel
  const [pm2Processes, appStatusSummary, cosStatus, cosPendingTaskIds, cosAgents, self, dbHealth, version, diskStats, memStats, healthSettings, forgeHealth, mediaCapacity, reviewerConfigHealth] = await Promise.all([
    listProcesses().catch(() => []),
    getAppStatusSummary().catch(() => ({ total: 0, online: 0, stopped: 0, notStarted: 0, unknown: 0, degraded: false, unmanaged: 0 })),
    cos.getStatus().catch((error) => {
      console.error('Chief of Staff health probe failed', error);
      return failedProbe;
    }),
    // Queue depth is read here rather than taken off `getStatus()`, which has no
    // such field — `cosStatus.queueLength` never existed, so the widget's
    // "N queued" was dead and always rendered 0. Both reads ride the same
    // `loadState()`/parse caches `getStatus()` above already warmed.
    cos.getPendingTaskIds().catch(() => null),
    cos.getAgents().catch(() => null),
    getSelf().catch(() => null),
    checkHealth().catch(() => ({ connected: false, hasSchema: false, error: 'Health check failed' })),
    getCurrentVersion().catch(() => null),
    statfs('/').catch((error) => {
      console.error('Root filesystem health probe failed', error);
      return failedProbe;
    }),
    getMemoryStats(),
    loadHealthSettings(),
    checkGhHealth().catch(() => ({ status: 'error', ok: false, detail: 'Health check failed', remedy: null, checkedAt: null })),
    // Media-lane capacity never fails the health report: an unreadable GPU probe
    // degrades to `null`, which the UI renders as unknown rather than as idle.
    getMediaCapacity().catch(() => null),
    import('../services/codeReview.js')
      .then(({ getReviewerConfigHealth }) => getReviewerConfigHealth())
      .catch(() => ({ status: 'unknown', configFaults: {} }))
  ]);
  const { thresholds, dismissedWarnings, thresholdsAvailable } = healthSettings;

  const memUsagePercent = Math.round((memStats.used / memStats.total) * 100);
  const cpuLoad = os.loadavg()[0]; // 1-minute load average
  const cpuCount = os.cpus().length;
  const cpuUsagePercent = Math.round((cpuLoad / cpuCount) * 100);

  // Disk usage (root filesystem).
  // bavail = blocks available to unprivileged users (what the user can actually fill).
  // Derive used/usagePercent from the same figure so `used + free === total` and
  // the UI's percent corresponds to the displayed `free`.
  const parsedDisk = diskStats === failedProbe ? null : parseFilesystemStats(diskStats);
  const disk = parsedDisk && {
    total: parsedDisk.total,
    used: parsedDisk.used,
    free: parsedDisk.free,
    usagePercent: parsedDisk.usagePercent,
  };

  // Process status summary from PM2. Processes whose exit is expected (a desktop
  // app the user closed) are excluded from the FAILURE-bearing counts: a quit game
  // window would otherwise force overallHealth to 'critical' below and light up
  // the dashboard widget and the OpenWorld HUD until the PM2 entry is manually
  // cleared. `expectedExit` describes a process's exit *semantics*, not its
  // liveness — so `online` counts every process, exempt or not, or a *running*
  // desktop app would sit in `total` and in no status bucket at all and the
  // dashboard would read "5/6 · all running" with all six up. Resource totals
  // likewise cover every process. See issue #2991.
  const annotated = await annotateExpectedExit(pm2Processes);
  const supervised = annotated.filter(p => !p.expectedExit);
  const processStats = {
    total: pm2Processes.length,
    online: annotated.filter(p => p.status === 'online').length,
    stopped: supervised.filter(p => p.status === 'stopped').length,
    errored: supervised.filter(p => p.status === 'errored').length,
    // A desktop app that exited (cleanly as `stopped`, or `errored` on a
    // force-quit) — reported on its own rather than as a failure.
    desktopExited: annotated.filter(
      p => p.expectedExit && ['errored', 'stopped'].includes(p.status)
    ).length,
    totalMemory: pm2Processes.reduce((sum, p) => sum + (p.memory || 0), 0),
    totalCpu: pm2Processes.reduce((sum, p) => sum + (p.cpu || 0), 0),
    totalRestarts: pm2Processes.reduce((sum, p) => sum + (p.restarts || 0), 0),
    unstableRestarts: supervised.reduce((sum, p) => sum + (p.unstableRestarts || 0), 0)
  };

  // App status summary — PM2-managed apps only (Xcode/iOS-native projects
  // have no detectable runtime state, so they're tracked under `unmanaged`
  // and excluded from the running denominator)
  const appStats = appStatusSummary;

  // Determine overall health status. Each condition below records its
  // severity on the warning itself rather than mutating `overallHealth`
  // inline, because a dismissed warning (see loadDismissedWarnings above)
  // must not count toward the badge — overallHealth is derived once, after
  // dismissals are filtered out, from whatever warnings remain visible.
  const rawWarnings = [];

  // Memory occupancy and CPU load describe work, not a health failure.

  if (!thresholdsAvailable) {
    rawWarnings.push({
      type: 'health-settings',
      severity: 'warning',
      message: 'System health settings are unavailable; default thresholds are being used and saved warning dismissals were ignored.',
      dismissible: false
    });
  }

  if (diskStats === failedProbe) {
    rawWarnings.push({ type: 'probe-unavailable', source: 'disk', status: 'unavailable', severity: 'warning', message: 'Disk status unavailable', dismissible: false });
  }
  if (cosStatus === failedProbe) {
    rawWarnings.push({ type: 'probe-unavailable', source: 'cos', status: 'unavailable', severity: 'warning', message: 'Chief of Staff status unavailable', dismissible: false });
  }

  if (disk) {
    if (disk.usagePercent >= thresholds.diskCritical) {
      rawWarnings.push({ type: 'disk', severity: 'critical', message: `Disk usage at or above ${thresholds.diskCritical}%` });
    } else if (disk.usagePercent >= thresholds.diskWarn) {
      rawWarnings.push({ type: 'disk', severity: 'warning', message: `Disk usage at or above ${thresholds.diskWarn}%` });
    }
  }

  if (processStats.errored > 0) {
    rawWarnings.push({ type: 'process', severity: 'critical', message: `${processStats.errored} process(es) errored` });
  }

  if (processStats.unstableRestarts > 0) {
    const crashing = supervised.filter(p => (p.unstableRestarts || 0) > 0).map(p => p.name);
    const plural = processStats.unstableRestarts === 1 ? '' : 's';
    rawWarnings.push({
      type: 'restarts',
      severity: 'warning',
      message: `${processStats.unstableRestarts} crash-loop restart${plural} (${crashing.join(', ')})`
    });
  }

  // A degraded app summary means PM2 couldn't be read for one or more homes, so
  // those apps' online/stopped status is unknown — surface it rather than letting
  // the counts silently read as "everything not started."
  if (appStats.degraded) {
    const unknown = appStats.unknown || 0;
    rawWarnings.push({ type: 'apps', severity: 'warning', message: `App status unavailable for ${unknown} app(s) — PM2 read failed` });
  }

  if (!dbHealth.connected) {
    rawWarnings.push({ type: 'database', severity: 'warning', message: `PostgreSQL disconnected${dbHealth.error ? `: ${dbHealth.error}` : ''}` });
  } else if (!dbHealth.hasSchema) {
    rawWarnings.push({ type: 'database', severity: 'warning', message: 'PostgreSQL connected but schema missing' });
  }

  // A `gh` that cannot reach the forge does not fail loudly anywhere else: the
  // call sites that read pull requests and issues swallow the error into an
  // empty list, so a blocked or unauthenticated CLI looks exactly like a repo
  // with nothing open — and an agent asked to file a PR reports success having
  // filed none. Warn only when gh is present but unusable; an install that
  // never had gh has opted out of those features rather than broken them.
  if (!forgeHealth.ok && forgeHealth.status !== 'not-installed') {
    rawWarnings.push({
      type: 'forge',
      severity: 'warning',
      message: `GitHub CLI unusable (${forgeHealth.status})${forgeHealth.remedy ? ` — ${forgeHealth.remedy}` : ''}`
    });
  }

  const reviewerConfigFaults = reviewerConfigHealth.configFaults || {};
  if (Object.keys(reviewerConfigFaults).length) {
    rawWarnings.push({
      type: 'code-review',
      severity: 'warning',
      message: `Code review configuration needs attention for ${Object.keys(reviewerConfigFaults).join(', ')} — open Settings → Code Reviewers`
    });
  }

  if (!thresholdsAvailable) rawWarnings.forEach((warning) => { warning.dismissible = false; });

  // A dismissal only stays applied while the warning it was recorded against
  // is still current (same type AND same message) — see loadHealthSettings.
  // Anything else (the condition cleared, or recurred with a different
  // message) drops out of `dismissedWarnings` here so a genuinely new
  // occurrence is never silently hidden by a stale record.
  const nextDismissedWarnings = {};
  const warnings = [];
  for (const warning of rawWarnings) {
    const dismissal = dismissedWarnings[warning.type];
    const pendingPrune = pendingDismissalPrunes.get(warning.type);
    if (warning.dismissible !== false && dismissal?.message === warning.message && !sameDismissal(pendingPrune, dismissal)) {
      nextDismissedWarnings[warning.type] = dismissal;
      continue;
    }
    warnings.push(warning);
  }

  if (thresholdsAvailable) {
    for (const [type, pending] of pendingDismissalPrunes) {
      if (!Object.hasOwn(dismissedWarnings, type) || !sameDismissal(dismissedWarnings[type], pending)) {
        pendingDismissalPrunes.delete(type);
      }
    }

    const staleDismissals = Object.entries(dismissedWarnings)
      .filter(([type]) => !Object.hasOwn(nextDismissedWarnings, type));
    if (staleDismissals.length) {
      for (const [type, dismissal] of staleDismissals) pendingDismissalPrunes.set(type, dismissal);
      try {
        const saved = await updateSettingsWith((current) => {
          const next = { ...(current.health?.dismissedWarnings || {}) };
          for (const [type, dismissal] of staleDismissals) {
            if (sameDismissal(next[type], dismissal)) delete next[type];
          }
          return patchHealth(current, { dismissedWarnings: next });
        });
        for (const [type, dismissal] of staleDismissals) {
          if (sameDismissal(pendingDismissalPrunes.get(type), dismissal)
            && !sameDismissal(saved?.health?.dismissedWarnings?.[type], dismissal)) {
            pendingDismissalPrunes.delete(type);
          }
        }
      } catch (error) {
        for (const [type] of staleDismissals) {
          console.error(`❌ Failed to prune stale system health warning dismissal (type=${type}, error=${error?.code || 'write-failed'})`);
        }
      }
    }
  }

  const overallHealth = warnings.some(w => w.severity === 'critical')
    ? 'critical'
    : warnings.length > 0 ? 'warning' : 'healthy';

  // CoS status. Active and queued BOTH come off the one agent read when it is
  // readable — mixing `getStatus()`'s tally with a separately-read queue lets the
  // two skew, which is the defect one layer down (services/activeProcessing.js).
  // A task a live agent already holds is active, not queued (lib/cosSpawnWindow.js).
  // An unreadable list degrades to null — unknown, which the widget hides —
  // rather than to a manufactured zero.
  const heldByRunningAgent = runningAgentsByTaskId(cosAgents);
  const cosInfo = cosStatus && cosStatus !== failedProbe ? {
    running: cosStatus.running,
    paused: cosStatus.paused,
    activeAgents: cosAgents
      ? cosAgents.filter((agent) => agent?.status === 'running').length
      : (cosStatus.activeAgents || 0),
    queuedTasks: cosPendingTaskIds ? unclaimedTaskIds(cosPendingTaskIds, heldByRunningAgent).length : null
  } : null;

  const uptime = process.uptime();
  const uptimeFormatted = formatDuration(uptime * 1000);

  const responseTime = Date.now() - startTime;

  res.json({
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    instanceId: self?.instanceId ?? null,
    version,
    overallHealth,
    // Peer credential handshake (#8356): `accepted` tells the probing peer that
    // THIS request authenticated with its pair token, so it can stop sending
    // the instance password. Older receivers omit the field; senders keep Basic.
    peerAuth: {
      version: PORTOS_SCHEMA_VERSIONS.peerAuth,
      accepted: req.portosAuthContext?.method === 'peer',
    },
    warnings,
    system: {
      uptime,
      uptimeFormatted,
      memory: {
        total: memStats.total,
        used: memStats.used,
        free: memStats.free,
        usagePercent: memUsagePercent,
        totalFormatted: formatBytes(memStats.total),
        usedFormatted: formatBytes(memStats.used),
        freeFormatted: formatBytes(memStats.free)
      },
      cpu: {
        cores: cpuCount,
        loadAvg1m: cpuLoad,
        usagePercent: cpuUsagePercent
      },
      disk: disk ? {
        total: disk.total,
        used: disk.used,
        free: disk.free,
        usagePercent: disk.usagePercent,
        totalFormatted: formatBytes(disk.total),
        usedFormatted: formatBytes(disk.used),
        freeFormatted: formatBytes(disk.free)
      } : null
    },
    processes: processStats,
    apps: appStats,
    cos: cosInfo,
    media: mediaCapacity,
    database: dbHealth,
    forge: forgeHealth,
    codeReview: reviewerConfigHealth,
    thresholds: thresholdsAvailable ? thresholds : undefined,
    thresholdsAvailable,
    topProcesses: [...pm2Processes]
      .sort((a, b) => (b.memory || 0) - (a.memory || 0))
      .slice(0, 10)
      .map(p => ({
        name: p.name,
        status: p.status,
        memory: p.memory || 0,
        memoryFormatted: formatBytes(p.memory || 0),
        cpu: p.cpu || 0,
        restarts: p.restarts || 0,
        unstableRestarts: p.unstableRestarts || 0
      }))
  });
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
