import { Router } from 'express';
import os from 'os';
import { listProcesses } from '../services/pm2.js';
import * as apps from '../services/apps.js';
import * as cos from '../services/cos.js';
import { getSelf } from '../services/instances.js';

const router = Router();

router.get('/health', async (req, res) => {
  const self = await getSelf().catch(() => null);
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '0.1.0',
    hostname: os.hostname(),
    instanceId: self?.instanceId ?? null
  });
});

/**
 * GET /api/system/health/details - Comprehensive system health summary
 * Returns system metrics, app status, and CoS status for dashboard display
 */
router.get('/health/details', async (req, res) => {
  const startTime = Date.now();

  // Gather data in parallel
  const [pm2Processes, allApps, cosStatus, self] = await Promise.all([
    listProcesses().catch(() => []),
    apps.getAllApps({ includeArchived: false }).catch(() => []),
    cos.getStatus().catch(() => null),
    getSelf().catch(() => null)
  ]);

  // System metrics
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePercent = Math.round((usedMem / totalMem) * 100);
  const cpuLoad = os.loadavg()[0]; // 1-minute load average
  const cpuCount = os.cpus().length;
  const cpuUsagePercent = Math.round((cpuLoad / cpuCount) * 100);

  // Process status summary from PM2
  const processStats = {
    total: pm2Processes.length,
    online: pm2Processes.filter(p => p.status === 'online').length,
    stopped: pm2Processes.filter(p => p.status === 'stopped').length,
    errored: pm2Processes.filter(p => p.status === 'errored').length,
    totalMemory: pm2Processes.reduce((sum, p) => sum + (p.memory || 0), 0),
    totalCpu: pm2Processes.reduce((sum, p) => sum + (p.cpu || 0), 0),
    totalRestarts: pm2Processes.reduce((sum, p) => sum + (p.restarts || 0), 0)
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

  if (memUsagePercent > 90) {
    overallHealth = 'critical';
    warnings.push({ type: 'memory', message: 'Memory usage above 90%' });
  } else if (memUsagePercent > 75) {
    if (overallHealth !== 'critical') overallHealth = 'warning';
    warnings.push({ type: 'memory', message: 'Memory usage above 75%' });
  }

  if (cpuUsagePercent > 100) {
    if (overallHealth !== 'critical') overallHealth = 'warning';
    warnings.push({ type: 'cpu', message: 'CPU load high' });
  }

  if (processStats.errored > 0) {
    overallHealth = 'critical';
    warnings.push({ type: 'process', message: `${processStats.errored} process(es) errored` });
  }

  if (processStats.totalRestarts > 10) {
    if (overallHealth !== 'critical') overallHealth = 'warning';
    warnings.push({ type: 'restarts', message: `${processStats.totalRestarts} total restarts` });
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
    overallHealth,
    warnings,
    system: {
      uptime,
      uptimeFormatted,
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usagePercent: memUsagePercent,
        totalFormatted: formatBytes(totalMem),
        usedFormatted: formatBytes(usedMem),
        freeFormatted: formatBytes(freeMem)
      },
      cpu: {
        cores: cpuCount,
        loadAvg1m: cpuLoad,
        usagePercent: cpuUsagePercent
      }
    },
    processes: processStats,
    apps: appStats,
    cos: cosInfo
  });
});

export default router;
