import os from 'os';
import { stat, statfs } from 'fs/promises';
import { listProcessesStrict } from './pm2.js';
import { getAppStatusSummary, annotateExpectedExit } from './appProcessStatus.js';
import { getAgents } from './cosAgentLifecycle.js';
import { getPendingTaskIds } from './cosTaskStore.js';
import { getStatus } from './cos.js';
import { getSelf } from './instanceIdentity.js';
import { checkHealth } from '../lib/db.js';
import { getCurrentVersion } from './updateChecker.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { formatBytes, formatDuration, PATHS } from '../lib/fileUtils.js';
import { parseFilesystemStats } from '../lib/fileCore.js';
import { getSettingsWithStatus, updateSettingsWith } from './settings.js';
import { checkGhHealth } from './github.js';
import { getMediaCapacity } from './mediaCapacity.js';
import { runningAgentsByTaskId, unclaimedTaskIds } from '../lib/cosSpawnWindow.js';
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

// Last observed availability per CoS read ('cos-status' / 'cos-queue' / 'cos-agents'), so a
// persistent failure logs once on entry and once on recovery, not on every read.
const cosProbeAvailability = new Map();

const probeErrorCode = (error) => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code) ? error.code : 'unknown');

function noteCosProbe(source, available, error) {
  if (cosProbeAvailability.get(source) === available) return;
  cosProbeAvailability.set(source, available);
  if (available) console.log(`✅ CoS health probe recovered (source=${source})`);
  else console.error(`❌ CoS health probe unavailable (source=${source}, code=${probeErrorCode(error)})`);
}


const patchHealth = (current, patch) => ({ ...current, health: { ...(current.health || {}), ...patch } });

const FAILED_PROBE = Symbol('failed health probe');

const probeFailureWarning = (source, message) => ({
  type: 'probe-unavailable', source, status: 'unavailable', severity: 'warning', message, dismissible: false
});

// Gather every probe in parallel. Per-probe error policy lives here: most
// degrade to null or a fallback value, probes whose absence must be reported
// resolve to FAILED_PROBE.
function probeHealthInputs() {
  const cosProbe = (source, read) => read().then(
    (value) => { noteCosProbe(source, true); return value; },
    (error) => { noteCosProbe(source, false, error); return FAILED_PROBE; }
  );
  return Promise.all([
    listProcessesStrict().catch(() => null),
    getAppStatusSummary().catch((error) => {
      console.error(`❌ App health probe failed (operation=getAppStatusSummary, code=${probeErrorCode(error)})`);
      return FAILED_PROBE;
    }),
    cosProbe('cos-status', () => getStatus()),
    // Queue depth is read here rather than taken off `getStatus()`, which has no
    // such field — `cosStatus.queueLength` never existed, so the widget's
    // "N queued" was dead and always rendered 0. Both reads ride the same
    // `loadState()`/parse caches `getStatus()` above already warmed.
    cosProbe('cos-queue', () => getPendingTaskIds()),
    cosProbe('cos-agents', () => getAgents()),
    getSelf().catch(() => null),
    checkHealth().catch(() => ({ connected: false, hasSchema: false, error: 'Health check failed' })),
    getCurrentVersion().catch(() => null),
    statfs('/').catch((error) => {
      console.error(`❌ Root filesystem health probe failed: ${error.message}`);
      return FAILED_PROBE;
    }),
    statfs(PATHS.data).catch(() => null),
    Promise.all(['/', PATHS.data].map(path => stat(path).then(result => result.dev).catch(() => null))),
    getMemoryStats(),
    loadHealthSettings(),
    checkGhHealth().catch(() => ({ status: 'error', ok: false, detail: 'Health check failed', remedy: null, checkedAt: null })),
    // Media-lane capacity never fails the health report: an unreadable GPU probe
    // degrades to `null`, which the UI renders as unknown rather than as idle.
    getMediaCapacity().catch(() => null),
    import('../services/codeReview.js')
      .then(({ getReviewerConfigHealth }) => getReviewerConfigHealth())
      .catch(() => ({ status: 'unknown', configFaults: {} }))
  ]).then(([pm2Processes, appStatusSummary, cosStatus, cosPendingTaskIds, cosAgents, self, dbHealth, version, diskStats, dataDiskStats, filesystemDevices, memStats, healthSettings, forgeHealth, mediaCapacity, reviewerConfigHealth]) => ({
    pm2Processes, appStatusSummary, cosStatus, cosPendingTaskIds, cosAgents, self, dbHealth, version, diskStats, dataDiskStats, filesystemDevices, memStats, healthSettings, forgeHealth, mediaCapacity, reviewerConfigHealth
  }));
}

// Process status summary from PM2. Processes whose exit is expected (a desktop
// app the user closed) are excluded from the FAILURE-bearing counts: a quit game
// window would otherwise force overallHealth to 'critical' and light up the
// dashboard widget and the OpenWorld HUD until the PM2 entry is manually
// cleared. `expectedExit` describes a process's exit *semantics*, not its
// liveness — so `online` counts every process, exempt or not, or a *running*
// desktop app would sit in `total` and in no status bucket at all. Resource
// totals likewise cover every process. See issue #2991.
// A failed PM2 read yields processStats null (unavailable), not zeros.
async function deriveProcessStats(pm2Processes) {
  if (pm2Processes === null) return { processStats: null, supervised: [] };
  const annotated = await annotateExpectedExit(pm2Processes);
  const supervised = annotated.filter(p => !p.expectedExit);
  const sum = (list, key) => list.reduce((total, p) => total + (p[key] || 0), 0);
  return {
    supervised,
    processStats: {
      total: pm2Processes.length,
      online: annotated.filter(p => p.status === 'online').length,
      stopped: supervised.filter(p => p.status === 'stopped').length,
      errored: supervised.filter(p => p.status === 'errored').length,
      // A desktop app that exited (cleanly as `stopped`, or `errored` on a
      // force-quit) — reported on its own rather than as a failure.
      desktopExited: annotated.filter(
        p => p.expectedExit && ['errored', 'stopped'].includes(p.status)
      ).length,
      totalMemory: sum(pm2Processes, 'memory'),
      totalCpu: sum(pm2Processes, 'cpu'),
      totalRestarts: sum(pm2Processes, 'restarts'),
      unstableRestarts: sum(supervised, 'unstableRestarts')
    }
  };
}

function diskThresholdWarning(type, labelPrefix, usagePercent, thresholds) {
  if (usagePercent >= thresholds.diskCritical) {
    return { type, severity: 'critical', message: `${labelPrefix} usage at or above ${thresholds.diskCritical}%` };
  }
  if (usagePercent >= thresholds.diskWarn) {
    return { type, severity: 'warning', message: `${labelPrefix} usage at or above ${thresholds.diskWarn}%` };
  }
  return null;
}

function cosProbeWarnings({ cosStatus, cosPendingTaskIds, cosAgents }) {
  if (cosStatus === FAILED_PROBE) return [probeFailureWarning('cos', 'Chief of Staff status unavailable')];
  // Queue and agent reads fail independently of getStatus(); only meaningful
  // while the daemon status itself was readable (otherwise 'cos' already warns).
  const warnings = [];
  if (cosPendingTaskIds === FAILED_PROBE) warnings.push(probeFailureWarning('cos-queue', 'Chief of Staff queue unavailable'));
  if (cosAgents === FAILED_PROBE) warnings.push(probeFailureWarning('cos-agents', 'Chief of Staff agent census unavailable'));
  return warnings;
}

function diskWarnings({ disk, dataDisk, sameFilesystem, thresholds }) {
  // Concurrent probes may sample a shared volume on either side of a threshold.
  // Keep one legacy warning identity and use the more severe available reading.
  const warningDisk = sameFilesystem === true && disk && dataDisk
    ? (disk.usagePercent >= dataDisk.usagePercent ? disk : dataDisk) : disk;
  const warnings = [];
  if (warningDisk) warnings.push(diskThresholdWarning('disk', 'Disk', warningDisk.usagePercent, thresholds));
  // Preserve the root warning identity and its saved dismissals on a shared volume.
  if (dataDisk && !(sameFilesystem === true && disk)) {
    warnings.push(diskThresholdWarning('data-disk', 'Runtime data disk', dataDisk.usagePercent, thresholds));
  }
  return warnings.filter(Boolean);
}

function processWarnings(processStats, supervised) {
  if (!processStats) return [];
  const warnings = [];
  if (processStats.errored > 0) {
    warnings.push({ type: 'process', severity: 'critical', message: `${processStats.errored} process(es) errored` });
  }
  if (processStats.unstableRestarts > 0) {
    const crashing = supervised.filter(p => (p.unstableRestarts || 0) > 0).map(p => p.name);
    const plural = processStats.unstableRestarts === 1 ? '' : 's';
    warnings.push({
      type: 'restarts',
      severity: 'warning',
      message: `${processStats.unstableRestarts} crash-loop restart${plural} (${crashing.join(', ')})`
    });
  }
  return warnings;
}

function databaseWarning(dbHealth) {
  if (!dbHealth.connected) {
    return { type: 'database', severity: 'warning', message: `PostgreSQL disconnected${dbHealth.error ? `: ${dbHealth.error}` : ''}` };
  }
  if (!dbHealth.hasSchema) {
    return { type: 'database', severity: 'warning', message: 'PostgreSQL connected but schema missing' };
  }
  if (dbHealth.hasCatalogSchema === false) {
    return { type: 'database', severity: 'warning', message: 'PostgreSQL connected and schema available but Catalog tables missing — open Settings → Database to troubleshoot' };
  }
  return null;
}

// A degraded app summary means PM2 couldn't be read for one or more homes, so
// those apps' online/stopped status is unknown — surface it rather than letting
// the counts silently read as "everything not started."
function appsWarning(appStatusSummary, appStats) {
  if (appStatusSummary === FAILED_PROBE) return probeFailureWarning('apps', 'Apps unavailable');
  if (!appStats.degraded) return null;
  return { type: 'apps', severity: 'warning', message: `App status unavailable for ${appStats.unknown || 0} app(s) — PM2 read failed` };
}

// A `gh` that cannot reach the forge does not fail loudly anywhere else: the
// call sites that read pull requests and issues swallow the error into an
// empty list, so a blocked or unauthenticated CLI looks exactly like a repo
// with nothing open — and an agent asked to file a PR reports success having
// filed none. Warn only when gh is present but unusable; an install that
// never had gh has opted out of those features rather than broken them.
function forgeWarning(forgeHealth) {
  if (forgeHealth.ok || forgeHealth.status === 'not-installed') return null;
  return {
    type: 'forge',
    severity: 'warning',
    message: `GitHub CLI unusable (${forgeHealth.status})${forgeHealth.remedy ? ` — ${forgeHealth.remedy}` : ''}`
  };
}

function reviewerConfigWarning(reviewerConfigHealth) {
  const faulty = Object.keys(reviewerConfigHealth.configFaults || {});
  if (!faulty.length) return null;
  return {
    type: 'code-review',
    severity: 'warning',
    message: `Code review configuration needs attention for ${faulty.join(', ')} — open Settings → Code Reviewers`
  };
}

// Pure rule list: every condition records its severity on the warning itself
// rather than mutating overallHealth, because a dismissed warning must not
// count toward the badge — overallHealth derives from what remains visible.
// Memory occupancy and CPU load describe work, not a health failure.
function buildHealthWarnings(inputs) {
  const { thresholdsAvailable, diskStats, dataDisk, pm2Processes, processStats, supervised, appStatusSummary, appStats, dbHealth, forgeHealth, reviewerConfigHealth } = inputs;
  const warnings = [
    !thresholdsAvailable && {
      type: 'health-settings',
      severity: 'warning',
      message: 'System health settings are unavailable; default thresholds are being used and saved warning dismissals were ignored.',
      dismissible: false
    },
    diskStats === FAILED_PROBE && probeFailureWarning('disk', 'Disk status unavailable'),
    !dataDisk && probeFailureWarning('data-disk', 'Runtime data disk status unavailable'),
    ...cosProbeWarnings(inputs),
    pm2Processes === null && probeFailureWarning('pm2', 'Process manager (PM2) status unavailable'),
    ...diskWarnings(inputs),
    ...processWarnings(processStats, supervised),
    appsWarning(appStatusSummary, appStats),
    databaseWarning(dbHealth),
    forgeWarning(forgeHealth),
    reviewerConfigWarning(reviewerConfigHealth)
  ].filter(Boolean);
  if (!thresholdsAvailable) warnings.forEach((warning) => { warning.dismissible = false; });
  return warnings;
}

// A dismissal only stays applied while the warning it was recorded against
// is still current (same type AND same message) — see loadHealthSettings.
// Anything else (the condition cleared, or recurred with a different message)
// is returned in `staleDismissals` so a genuinely new occurrence is never
// silently hidden by a stale record. `pendingPrunes` defaults to the module map.
function reconcileDismissals(rawWarnings, dismissedWarnings, thresholdsAvailable, pendingPrunes = pendingDismissalPrunes) {
  const kept = new Set();
  const warnings = [];
  for (const warning of rawWarnings) {
    const dismissal = dismissedWarnings[warning.type];
    if (warning.dismissible !== false && dismissal?.message === warning.message
      && !sameDismissal(pendingPrunes.get(warning.type), dismissal)) {
      kept.add(warning.type);
      continue;
    }
    warnings.push(warning);
  }
  const staleDismissals = thresholdsAvailable
    ? Object.entries(dismissedWarnings).filter(([type]) => !kept.has(type))
    : [];
  return { warnings, staleDismissals };
}

// Owns the pendingDismissalPrunes bookkeeping and the settings write; a failed
// write keeps the entry pending so a matching recurrence stays visible.
async function pruneStaleDismissals(staleDismissals, dismissedWarnings) {
  for (const [type, pending] of pendingDismissalPrunes) {
    if (!Object.hasOwn(dismissedWarnings, type) || !sameDismissal(dismissedWarnings[type], pending)) {
      pendingDismissalPrunes.delete(type);
    }
  }
  if (!staleDismissals.length) return;
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

// CoS status. Active and queued BOTH come off the one agent read when it is
// readable — mixing `getStatus()`'s tally with a separately-read queue lets the
// two skew, which is the defect one layer down (services/activeProcessing.js).
// A task a live agent already holds is active, not queued (lib/cosSpawnWindow.js).
// An unreadable list degrades to null — unknown, which the widget hides —
// rather than to a manufactured zero.
function buildCosInfo({ cosStatus, cosPendingTaskIds, cosAgents }) {
  if (!cosStatus || cosStatus === FAILED_PROBE) return null;
  const agentsReadable = cosAgents !== FAILED_PROBE;
  const queueReadable = cosPendingTaskIds !== FAILED_PROBE;
  return {
    running: cosStatus.running,
    paused: cosStatus.paused,
    activeAgents: agentsReadable
      ? cosAgents.filter((agent) => agent?.status === 'running').length
      : (cosStatus.activeAgents || 0),
    // Without the agent census the spawn-window subtraction is impossible, so
    // the count is unknown rather than an over-reported "reconciled" figure.
    queuedTasks: queueReadable && agentsReadable
      ? unclaimedTaskIds(cosPendingTaskIds, runningAgentsByTaskId(cosAgents)).length
      : null
  };
}

const withFormattedBytes = (fs) => fs && {
  total: fs.total,
  used: fs.used,
  free: fs.free,
  usagePercent: fs.usagePercent,
  totalFormatted: formatBytes(fs.total),
  usedFormatted: formatBytes(fs.used),
  freeFormatted: formatBytes(fs.free)
};

function topProcesses(pm2Processes) {
  if (pm2Processes === null) return null;
  return [...pm2Processes]
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
    }));
}

function buildSystemSection({ memStats, disk, dataDisk, sameFilesystem }) {
  const cpuLoad = os.loadavg()[0]; // 1-minute load average
  const cpuCount = os.cpus().length;
  const uptime = process.uptime();
  return {
    uptime,
    uptimeFormatted: formatDuration(uptime * 1000),
    memory: {
      total: memStats.total,
      used: memStats.used,
      free: memStats.free,
      usagePercent: Math.round((memStats.used / memStats.total) * 100),
      totalFormatted: formatBytes(memStats.total),
      usedFormatted: formatBytes(memStats.used),
      freeFormatted: formatBytes(memStats.free)
    },
    cpu: {
      cores: cpuCount,
      loadAvg1m: cpuLoad,
      usagePercent: Math.round((cpuLoad / cpuCount) * 100)
    },
    disk: withFormattedBytes(disk),
    dataDisk: withFormattedBytes(dataDisk),
    sameFilesystem
  };
}

export async function getSystemHealthSnapshot() {
  const probes = await probeHealthInputs();
  const { pm2Processes, appStatusSummary, self, dbHealth, version, diskStats, dataDiskStats, filesystemDevices, memStats, healthSettings, forgeHealth, mediaCapacity, reviewerConfigHealth } = probes;
  const { thresholds, dismissedWarnings, thresholdsAvailable } = healthSettings;

  // bavail = blocks available to unprivileged users (what the user can actually fill).
  // Derive used/usagePercent from the same figure so `used + free === total` and
  // the UI's percent corresponds to the displayed `free`.
  const disk = diskStats === FAILED_PROBE ? null : parseFilesystemStats(diskStats);
  const dataDisk = parseFilesystemStats(dataDiskStats);
  const sameFilesystem = filesystemDevices.every(device => device != null)
    ? filesystemDevices[0] === filesystemDevices[1] : null;

  const { processStats, supervised } = await deriveProcessStats(pm2Processes);
  // PM2-managed apps only (Xcode/iOS-native projects have no detectable runtime
  // state, so they're `unmanaged`). Numeric placeholders preserve older
  // clients' shape, not measurements.
  const appStats = appStatusSummary === FAILED_PROBE
    ? { total: 0, online: 0, stopped: 0, notStarted: 0, unknown: 0, unmanaged: 0, degraded: true, status: 'unavailable' }
    : appStatusSummary;

  const rawWarnings = buildHealthWarnings({ ...probes, ...healthSettings, disk, dataDisk, sameFilesystem, processStats, supervised, appStats });
  const { warnings, staleDismissals } = reconcileDismissals(rawWarnings, dismissedWarnings, thresholdsAvailable);
  if (thresholdsAvailable) await pruneStaleDismissals(staleDismissals, dismissedWarnings);

  const overallHealth = warnings.some(w => w.severity === 'critical')
    ? 'critical'
    : warnings.length > 0 ? 'warning' : 'healthy';

  return {
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
      accepted: false,
    },
    // Senders add image `createdAt` to push manifests only once this is advertised (#14067).
    assetStamps: { version: PORTOS_SCHEMA_VERSIONS.peerAssetStamps },
    warnings,
    system: buildSystemSection({ memStats, disk, dataDisk, sameFilesystem }),
    processes: processStats,
    apps: appStats,
    cos: buildCosInfo(probes),
    media: mediaCapacity,
    database: dbHealth,
    forge: forgeHealth,
    codeReview: reviewerConfigHealth,
    thresholds: thresholdsAvailable ? thresholds : undefined,
    thresholdsAvailable,
    topProcesses: topProcesses(pm2Processes)
  };
}

// Test hooks for the pure rule and dismissal steps.
export {
  buildHealthWarnings as _buildHealthWarnings,
  reconcileDismissals as _reconcileDismissals,
  pruneStaleDismissals as _pruneStaleDismissals
};
