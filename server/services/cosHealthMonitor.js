/**
 * CoS Health Monitor Module
 *
 * Daemon health checks extracted from cos.js. Inspects PM2 process state and
 * memory usage, auto-restarts errored processes, records the latest health
 * snapshot to CoS state, and emits health events for downstream consumers.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { execPm2 } from './pm2.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { loadState, saveState, withStateLock, isDaemonRunning } from './cosState.js';
import { cosEvents, emitLog } from './cosEvents.js';

const _execFileAsync = promisify(execFile);
const execFileAsync = (cmd, args, opts) => _execFileAsync(cmd, args, { ...opts, windowsHide: true });

/**
 * Run a daemon health check: inspect PM2 processes and memory, auto-restart
 * errored processes, store the result, and emit health events.
 */
export async function runHealthCheck() {
  if (!isDaemonRunning()) return;

  const state = await loadState();
  const issues = [];
  const metrics = {
    timestamp: new Date().toISOString(),
    pm2: null,
    memory: null,
    ports: null
  };

  // Check PM2 processes
  const pm2Result = await execPm2(['jlist']).catch(() => ({ stdout: '[]' }));
  // pm2 jlist may output ANSI codes and warnings before JSON, extract the JSON array
  // Look for '[{' (array with objects) or '[]' (empty array) to avoid matching ANSI codes like [31m
  const pm2Output = pm2Result.stdout || '[]';
  let jsonStart = pm2Output.indexOf('[{');
  if (jsonStart < 0) {
    // Check for empty array - find '[]' that's not part of ANSI codes
    const emptyMatch = pm2Output.match(/\[\](?![0-9])/);
    jsonStart = emptyMatch ? pm2Output.indexOf(emptyMatch[0]) : -1;
  }
  const pm2Json = jsonStart >= 0 ? pm2Output.slice(jsonStart) : '[]';
  const pm2Processes = safeJSONParse(pm2Json, [], { logError: true, context: 'pm2 process list' });

  const erroredProcesses = pm2Processes.filter(p => p.pm2_env?.status === 'errored');
  metrics.pm2 = {
    total: pm2Processes.length,
    online: pm2Processes.filter(p => p.pm2_env?.status === 'online').length,
    errored: erroredProcesses.length,
    stopped: pm2Processes.filter(p => p.pm2_env?.status === 'stopped').length
  };

  // Check for runaway processes (too many)
  if (pm2Processes.length > state.config.maxTotalProcesses) {
    issues.push({
      type: 'warning',
      category: 'processes',
      message: `High process count: ${pm2Processes.length} PM2 processes (limit: ${state.config.maxTotalProcesses})`
    });
  }

  // Check for errored processes and auto-restart them
  if (erroredProcesses.length > 0) {
    const names = erroredProcesses.map(p => p.name);
    emitLog('warn', `🔄 ${names.length} errored PM2 process(es) detected: ${names.join(', ')} — attempting restart`);

    const restartResults = await Promise.all(names.map(async (name) => {
      const result = await execFileAsync('pm2', ['restart', name], { shell: process.platform === 'win32' }).catch(e => ({ stdout: '', stderr: e.message }));
      const failed = result.stderr && !result.stdout;
      if (failed) {
        emitLog('error', `❌ Failed to restart ${name}: ${result.stderr}`);
      } else {
        emitLog('success', `✅ Auto-restarted errored process: ${name}`);
      }
      return { name, success: !failed };
    }));

    const failedRestarts = restartResults.filter(r => !r.success);
    if (failedRestarts.length > 0) {
      issues.push({
        type: 'error',
        category: 'processes',
        message: `${failedRestarts.length} errored PM2 process(es) failed to auto-restart: ${failedRestarts.map(r => r.name).join(', ')}`
      });
    }

    const succeededRestarts = restartResults.filter(r => r.success);
    if (succeededRestarts.length > 0) {
      issues.push({
        type: 'warning',
        category: 'processes',
        message: `Auto-restarted ${succeededRestarts.length} errored PM2 process(es): ${succeededRestarts.map(r => r.name).join(', ')}`
      });
    }
  }

  // Check memory usage per process
  const highMemoryProcesses = pm2Processes.filter(p => {
    const memMb = (p.monit?.memory || 0) / (1024 * 1024);
    return memMb > state.config.maxProcessMemoryMb;
  });

  if (highMemoryProcesses.length > 0) {
    issues.push({
      type: 'warning',
      category: 'memory',
      message: `High memory usage in: ${highMemoryProcesses.map(p => `${p.name} (${Math.round((p.monit?.memory || 0) / (1024 * 1024))}MB)`).join(', ')}`
    });
  }

  metrics.memory = await getMemoryStats();

  // Store health check result with lock to prevent race conditions
  await withStateLock(async () => {
    const freshState = await loadState();
    freshState.stats.lastHealthCheck = metrics.timestamp;
    freshState.stats.healthIssues = issues;
    await saveState(freshState);
  });

  cosEvents.emit('health:check', { metrics, issues });

  // If there are critical issues, emit for potential automated response
  if (issues.filter(i => i.type === 'error').length > 0) {
    cosEvents.emit('health:critical', issues.filter(i => i.type === 'error'));
  }

  return { metrics, issues };
}

/**
 * Get latest health status
 */
export async function getHealthStatus() {
  const state = await loadState();
  return {
    lastCheck: state.stats.lastHealthCheck,
    issues: state.stats.healthIssues || []
  };
}
