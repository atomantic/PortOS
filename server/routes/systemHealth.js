import { Router } from 'express';
import os from 'os';
import { statfs } from 'fs/promises';
import { listProcesses } from '../services/pm2.js';
import * as apps from '../services/apps.js';
import * as cos from '../services/cos.js';
import { getSelf } from '../services/instances.js';
import { checkHealth } from '../lib/db.js';
import { getCurrentVersion } from '../services/updateChecker.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { getSettings, updateSettings } from '../services/settings.js';

// Defaults are tuned for a real dev machine: memory routinely sits in the
// 75-85% band on a host with a couple of LLMs loaded, and big SSDs commonly
// run >85% before being a real problem. Earlier thresholds (75/90 mem,
// 85/95 disk) fired warnings on every healthy laptop. Users can override
// these from /system-health (persisted to settings.json under `health`).
const DEFAULT_THRESHOLDS = {
  memoryWarn: 85,
  memoryCritical: 95,
  diskWarn: 90,
  diskCritical: 98
};

async function loadThresholds() {
  const settings = await getSettings().catch(() => ({}));
  const h = settings.health || {};
  return {
    memoryWarn: Number(h.memoryWarn) || DEFAULT_THRESHOLDS.memoryWarn,
    memoryCritical: Number(h.memoryCritical) || DEFAULT_THRESHOLDS.memoryCritical,
    diskWarn: Number(h.diskWarn) || DEFAULT_THRESHOLDS.diskWarn,
    diskCritical: Number(h.diskCritical) || DEFAULT_THRESHOLDS.diskCritical
  };
}

const router = Router();

router.get('/health', asyncHandler(async (req, res) => {
  const [self, version] = await Promise.all([
    getSelf().catch(() => null),
    getCurrentVersion()
  ]);
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version,
    hostname: os.hostname(),
    instanceId: self?.instanceId ?? null
  });
}));

/**
 * GET /api/system/health/details - Comprehensive system health summary
 * Returns system metrics, app status, and CoS status for dashboard display
 */
router.get('/health/details', asyncHandler(async (req, res) => {
  const startTime = Date.now();

  // Gather data in parallel
  const [pm2Processes, allApps, cosStatus, self, dbHealth, version, diskStats, memStats, thresholds] = await Promise.all([
    listProcesses().catch(() => []),
    apps.getAllApps({ includeArchived: false }).catch(() => []),
    cos.getStatus().catch(() => null),
    getSelf().catch(() => null),
    checkHealth().catch(() => ({ connected: false, hasSchema: false, error: 'Health check failed' })),
    getCurrentVersion().catch(() => null),
    statfs('/').catch(() => null),
    getMemoryStats(),
    loadThresholds()
  ]);

  const memUsagePercent = Math.round((memStats.used / memStats.total) * 100);
  const cpuLoad = os.loadavg()[0]; // 1-minute load average
  const cpuCount = os.cpus().length;
  const cpuUsagePercent = Math.round((cpuLoad / cpuCount) * 100);

  // Disk usage (root filesystem).
  // bavail = blocks available to unprivileged users (what the user can actually fill).
  // Derive used/usagePercent from the same figure so `used + free === total` and
  // the UI's percent corresponds to the displayed `free`.
  let disk = null;
  if (diskStats) {
    const totalDisk = diskStats.blocks * diskStats.bsize;
    if (totalDisk > 0) {
      const freeDisk = diskStats.bavail * diskStats.bsize;
      const usedDisk = totalDisk - freeDisk;
      const diskUsagePercent = Math.round((usedDisk / totalDisk) * 100);
      disk = {
        total: totalDisk,
        used: usedDisk,
        free: freeDisk,
        usagePercent: diskUsagePercent
      };
    }
  }

  // Process status summary from PM2
  const processStats = {
    total: pm2Processes.length,
    online: pm2Processes.filter(p => p.status === 'online').length,
    stopped: pm2Processes.filter(p => p.status === 'stopped').length,
    errored: pm2Processes.filter(p => p.status === 'errored').length,
    totalMemory: pm2Processes.reduce((sum, p) => sum + (p.memory || 0), 0),
    totalCpu: pm2Processes.reduce((sum, p) => sum + (p.cpu || 0), 0),
    totalRestarts: pm2Processes.reduce((sum, p) => sum + (p.restarts || 0), 0),
    unstableRestarts: pm2Processes.reduce((sum, p) => sum + (p.unstableRestarts || 0), 0)
  };

  // App status summary
  const appStats = {
    total: allApps.length,
    online: allApps.filter(a => a.overallStatus === 'online').length,
    stopped: allApps.filter(a => a.overallStatus === 'stopped').length,
    notStarted: allApps.filter(a => a.overallStatus === 'not_started' || a.overallStatus === 'not_found').length
  };

  // Determine overall health status
  let overallHealth = 'healthy';
  const warnings = [];

  if (memUsagePercent >= thresholds.memoryCritical) {
    overallHealth = 'critical';
    warnings.push({ type: 'memory', message: `Memory usage at or above ${thresholds.memoryCritical}%` });
  } else if (memUsagePercent >= thresholds.memoryWarn) {
    if (overallHealth !== 'critical') overallHealth = 'warning';
    warnings.push({ type: 'memory', message: `Memory usage at or above ${thresholds.memoryWarn}%` });
  }

  if (cpuUsagePercent > 100) {
    if (overallHealth !== 'critical') overallHealth = 'warning';
    warnings.push({ type: 'cpu', message: 'CPU load high' });
  }

  if (disk) {
    if (disk.usagePercent >= thresholds.diskCritical) {
      overallHealth = 'critical';
      warnings.push({ type: 'disk', message: `Disk usage at or above ${thresholds.diskCritical}%` });
    } else if (disk.usagePercent >= thresholds.diskWarn) {
      if (overallHealth !== 'critical') overallHealth = 'warning';
      warnings.push({ type: 'disk', message: `Disk usage at or above ${thresholds.diskWarn}%` });
    }
  }

  if (processStats.errored > 0) {
    overallHealth = 'critical';
    warnings.push({ type: 'process', message: `${processStats.errored} process(es) errored` });
  }

  if (processStats.unstableRestarts > 0) {
    if (overallHealth !== 'critical') overallHealth = 'warning';
    const crashing = pm2Processes.filter(p => (p.unstableRestarts || 0) > 0).map(p => p.name);
    const plural = processStats.unstableRestarts === 1 ? '' : 's';
    warnings.push({
      type: 'restarts',
      message: `${processStats.unstableRestarts} crash-loop restart${plural} (${crashing.join(', ')})`
    });
  }

  if (!dbHealth.connected) {
    if (overallHealth !== 'critical') overallHealth = 'warning';
    warnings.push({ type: 'database', message: `PostgreSQL disconnected${dbHealth.error ? `: ${dbHealth.error}` : ''}` });
  } else if (!dbHealth.hasSchema) {
    if (overallHealth !== 'critical') overallHealth = 'warning';
    warnings.push({ type: 'database', message: 'PostgreSQL connected but schema missing' });
  }

  // CoS status
  const cosInfo = cosStatus ? {
    running: cosStatus.running,
    paused: cosStatus.paused,
    activeAgents: cosStatus.activeAgents || 0,
    queuedTasks: cosStatus.queueLength || 0
  } : null;

  // Format memory for display
  const formatBytes = (bytes) => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)}GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)}MB`;
  };

  // Format uptime for display
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  let uptimeFormatted;
  if (days > 0) {
    uptimeFormatted = `${days}d ${hours}h`;
  } else if (hours > 0) {
    uptimeFormatted = `${hours}h ${minutes}m`;
  } else {
    uptimeFormatted = `${minutes}m`;
  }

  const responseTime = Date.now() - startTime;

  res.json({
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    instanceId: self?.instanceId ?? null,
    version,
    overallHealth,
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
    database: dbHealth,
    thresholds,
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
      return res.status(400).json({ error: `Invalid threshold value for ${k}` });
    }
  }
  const next = {
    memoryWarn: clamp(Math.round(incoming.memoryWarn), 50, 99),
    memoryCritical: clamp(Math.round(incoming.memoryCritical), 50, 99),
    diskWarn: clamp(Math.round(incoming.diskWarn), 50, 99),
    diskCritical: clamp(Math.round(incoming.diskCritical), 50, 99)
  };
  if (next.memoryWarn >= next.memoryCritical) {
    return res.status(400).json({ error: 'memoryWarn must be less than memoryCritical' });
  }
  if (next.diskWarn >= next.diskCritical) {
    return res.status(400).json({ error: 'diskWarn must be less than diskCritical' });
  }

  const current = await getSettings().catch(() => ({}));
  await updateSettings({ ...current, health: { ...(current.health || {}), ...next } });
  res.json(next);
}));

export default router;
